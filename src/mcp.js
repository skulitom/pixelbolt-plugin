import { readFile, writeFile, appendFile, mkdir, mkdtemp, lstat, realpath, stat, rename, rm, copyFile, link, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import os from 'node:os';
import { PixelError, MAX_REQUEST_BYTES, errorReply, renderProject, inspectProject, stackViews, paletteUse, compareProjects, briefDiagnostics, briefCells, briefComparison } from './core.js';
import { patchRecipe } from './patch.js';
import { createRevisionStore } from './revisions.js';
import { inspectMotion } from './motion.js';
import { encodePNG } from './png.js';
import { createBundle, writeBundle, embedBundleRecipe, outputSummary, describeAnimations } from './export.js';
import { spriteFrames, retexture } from './godot.js';
import { shareLink } from './share.js';
import { animationGIF } from './gif.js';
import { readExpect, checkDelivery, briefCheck } from './check.js';
import { createSequence, createSceneSequence, createBodiesSequence, figuresSummary, frameGrid } from './sequence.js';
import { compilePoses, draftViews } from './authoring.js';
import { testMapScale } from './terrain.js';
import { prepareScene, renderScene, sceneImage } from './scene.js';
import { createSceneBundle } from './scene-export.js';
import { importPNG } from './import.js';
import { applyOverlay } from './overlays.js';
import { resolveReferences, assertInside } from './resolve.js';
import { readSize, resizeRecipe, resizeWarning, resizeMargins, keepFrames, keepAnimations } from './resize.js';
import { tilemapOf } from './autotile.js';
import { listPresets, briefListing, findListing, findPreset, loadPreset, compilePreset, presetNext, COMPILERS } from './presets.js';
import { TOPICS, SECTIONED, helpText, jsonTopic, isSchema } from './help.js';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const UI_URI = 'ui://pixelbolt/viewer', UI_MIME = 'text/html;profile=mcp-app';
const pictureTools = new Set(['pixel_inspect', 'pixel_patch', 'pixel_compile', 'pixel_render', 'pixel_scene', 'pixel_import']);
const textContent = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
const imageContent = ({ data, width, height }) => ({ type: 'image', mimeType: 'image/png', data: encodePNG(data, width, height).toString('base64') });
function viewSummary({ sheet: { data, ...sheet }, nativeSheet, grids, legend, cells, ...view }) {
  return { cells: briefCells(cells), ...view, sheet, ...(nativeSheet && { nativeSheet: { ...nativeSheet, data: undefined } }) };
}
// Rulers let an agent read grid coordinates without counting characters.
function gridText({ region, legend, grids }) {
  const label = String(region.y + region.h - 1).length, xs = Array.from({ length: region.w }, (_, i) => region.x + i);
  const rulers = [100, 10, 1].filter(p => p === 1 || xs.at(-1) >= p).map(p => ' '.repeat(label + 2) + xs.map(x => (x >= p || p === 1 ? Math.floor(x / p) % 10 : ' ')).join(''));
  const parts = Object.values(legend).some(entry => entry.part !== undefined);
  const lines = [`${parts ? 'Part' : 'Palette'}-key grids for x ${region.x}–${region.x + region.w - 1}, y ${region.y}–${region.y + region.h - 1}. "." is ${parts ? 'empty' : 'transparent'}.`];
  for (const [symbol, entry] of Object.entries(legend)) lines.push(entry.part !== undefined ? `${symbol} = ${entry.part} ${entry.color}` : symbol === '?' ? `? = ${entry.colors} more colors without a symbol` : `${symbol} = ${entry.palette ? `palette "${entry.palette}" ${entry.color}` : `${entry.color}, not in the palette`}`);
  for (const { frame, rows } of grids) lines.push('', frame, ...rulers, ...rows.map((row, y) => `${String(region.y + y).padStart(label)}  ${row}`));
  return lines.join('\n');
}
// JSON-RPC clients normally send "id" before "params", so an oversized request's id is usually in its first bytes.
function leadingId(prefix) {
  const head = prefix.split('"params"')[0], match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/.exec(head);
  try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
}
// Tool arguments nest a few levels deep (a scene holding recipes, a patch value holding a recipe). Handing a value to
// the worker copies it recursively, so a request of a few kilobytes nested thousands deep would overflow the stack.
export const MAX_ARGUMENT_DEPTH = 128;
function deeperThan(value, limit) {
  const stack = [[value, 1]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (depth > limit) return true;
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
  }
  return false;
}
// Some clients send an object or list argument as JSON text: agents that call a tool without loading its schema often
// pass the recipe as a string (P-041). Text that parses to the type the tool's schema declares is used as that value,
// and `parsed` names it so the reply can say so; other text in such an argument is an error that says what to send.
export function parseTextArguments(args, properties) {
  const parsed = [];
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type;
    if (typeof value !== 'string' || (type !== 'object' && type !== 'array')) continue;
    const kind = type === 'array' ? 'a list' : 'an object';
    let json;
    try { json = JSON.parse(value); } catch (cause) { throw new PixelError(key, `expected ${kind}, got text that is not JSON (${cause.message}). Send ${key} as ${kind} itself, not inside a string${key === 'project' && /^\s*[a-f0-9]{12}\s*$/.test(value) ? '; to reuse a saved recipe, send its id as revision' : ''}`); }
    if (type === 'array' ? !Array.isArray(json) : json === null || typeof json !== 'object' || Array.isArray(json)) throw new PixelError(key, `expected ${kind}, got text holding ${Array.isArray(json) ? 'a list' : json === null ? 'null' : typeof json === 'object' ? 'an object' : `a ${typeof json}`}. Send ${key} as ${kind} itself, not inside a string`);
    args = { ...args, [key]: json };
    parsed.push(`${key} arrived as JSON text and was read as ${kind}`);
  }
  return { args, parsed };
}

const sequenceSummary = info => ({ directory: 'sequence', pattern: info.pattern, first: info.first, frames: info.frames, fps: info.fps.label, seconds: info.seconds, width: info.width, height: info.height, alpha: info.alpha, placement: info.placement, loop: info.loop, notes: info.notes, ffmpeg: info.commands });
// An MCP call writes at most this much sequence: the studio's download cap. Longer or larger shots go through
// `pixelbolt sequence`, which a person runs on purpose.
const SEQUENCE_BYTES = 512 * 1048576;
// And at most this many pixels of different frames from a bodies match, which a call draws in about half its time
// limit (600 vertical frames took 21 s); a longer match is refused before it is simulated, naming the command line.
const SEQUENCE_PIXELS = 1.5e9;
function checkSequenceSize(frames) {
  const total = [...frames.files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  if (total > SEQUENCE_BYTES) throw new PixelError('sequence', `these ${frames.info.frames} frames come to ${Math.ceil(total / 1048576)} MB, more than one call writes (${SEQUENCE_BYTES / 1048576} MB); lower the size, fps or seconds, or use the pixelbolt sequence command for longer shots`);
  return frames;
}
const withResolved = (summary, resolved) => resolved.length ? { ...summary, resolved } : summary;

// Runs one tool call and returns its MCP result; every failure comes back as an isError result. startMCP runs it in a
// worker thread (mcp-worker.js), so a call that takes too long or runs out of memory can be stopped without stopping
// the server. Nothing is kept between calls except the revisions and output folders on disk.
export function createToolRunner({ directory, root, version }) {
  const { remember, read } = createRevisionStore(directory);
  // The files a revision's recipe references (palettes and assets) are kept beside it as absolute paths, so saveAs
  // never writes over them, even when the recipe comes back as a revision through a server with another root. One
  // JSON string per line, only ever appended to, so servers sharing an export directory never drop each other's
  // entries; a damaged line is skipped.
  const sourcesFile = id => path.join(path.resolve(directory), '.revisions', `${id}.sources`);
  const sourcesOf = async id => {
    let text;
    try { text = await readFile(sourcesFile(id), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return [...new Set(text.split('\n').flatMap(line => { try { const item = JSON.parse(line); return typeof item === 'string' ? [item] : []; } catch { return []; } }))];
  };
  const keep = async (recipe, sources = []) => {
    // Each file as named and as resolved, so a link that is later removed or moved still leaves the real file named.
    const named = sources.map(file => path.resolve(root, file)), resolved = await Promise.all(named.map(file => canonical(file).catch(() => file)));
    const id = await remember(recipe), known = new Set(await sourcesOf(id)), added = [...new Set([...named, ...resolved])].filter(item => !known.has(item));
    // Each append starts on a new line, so one cut short by a crash spoils only itself.
    if (added.length) await appendFile(sourcesFile(id), '\n' + added.map(item => JSON.stringify(item)).join('\n') + '\n');
    return id;
  };
  const relativeToRoot = files => files.map(file => path.relative(root, file).split(path.sep).join('/'));
  // Inline file references are resolved inside the root; revisions store the resolved recipe, so they stay immutable.
  const recipeFrom = async (project, revision) => {
    if ((project === undefined) === (revision === undefined)) throw new PixelError('arguments', 'send either project or revision');
    if (project === undefined) { const recipe = await read(revision); return { recipe, resolved: [], sources: await sourcesOf(revision) }; }
    const { document, files } = await resolveReferences(project, { baseDir: root, root }), resolved = relativeToRoot(files);
    return { recipe: document, resolved, sources: resolved };
  };
  const newFolder = async name => { await mkdir(path.resolve(directory), { recursive: true }); return mkdtemp(path.join(path.resolve(directory), `${name}-`)); };
  // saveAs: copies of chosen export files at the paths the user named, inside the server root. Everything is checked
  // before anything is written, on real paths (symbolic links and junctions resolved): a file this export lacks, a
  // changed file type, a path outside the root or inside the revision store, the palette and asset files the recipe
  // references (as the CLI's exports never write over them), one file named
  // twice, one path inside another, or an existing file without overwrite.
  // Windows and macOS file systems ignore case by default, so `hero.png` and `HERO.png` are one file there.
  const fold = name => (process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name);
  const inside = (parent, child) => { const relative = path.relative(fold(parent), fold(child)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
  // Only a missing file counts as missing: any other error (a null byte, no permission) stops the call.
  const entry = target => lstat(target).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
  const nearest = async target => {
    let folder = target;
    while (!(await entry(folder))) {
      if (path.dirname(folder) === folder) throw new PixelError('saveAs', `${folder} does not exist`);
      folder = path.dirname(folder);
    }
    return folder;
  };
  // Names Windows can't create (or would quietly change): reserved characters, device names, a trailing dot or space.
  const windowsName = part => /[<>:"|?*]/.test(part) || /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i.test(part) || /[. ]$/.test(part);
  const canonical = async target => { const folder = await nearest(target); return path.join(await realpath(folder), path.relative(folder, target)); };
  // The root can be a whole home folder (the desktop bundle's default), so saveAs writes only art: PNG, GIF and the JSON
  // and Godot SpriteFrames and TileSets that describe it, never to a hidden name (settings live in .config, .vscode,
  // .claude.json), and overwrite replaces a JSON file only if it is a recipe, atlas or sequence (an object with frames),
  // never a settings file, and a .tres only if it is the same kind of resource, never a project's other resources.
  const SAVED_TYPES = ['.png', '.gif', '.json', '.tres', '.tsx'];
  const hidden = relative => relative.split(path.sep).some(part => part.startsWith('.'));
  // Where a home folder keeps app settings without a leading dot.
  const SETTINGS = { win32: 'AppData', darwin: 'Library' }[process.platform];
  // Whether an existing file is the kind a save may replace: its text, judged by `is`. One too large to read, unreadable
  // or not that kind of text is not.
  const fileIs = async (file, size, is) => { if (size > MAX_REQUEST_BYTES) return false; try { return is(await readFile(file, 'utf8')); } catch { return false; } };
  const spriteJSON = (file, size) => fileIs(file, size, text => { const value = JSON.parse(text); return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'frames'); });
  const godotResource = (file, size, type) => fileIs(file, size, text => new RegExp(`^\\[gd_resource type="${type}"[ \\]]`).test(text));
  const tiledTileset = (file, size) => fileIs(file, size, text => /^﻿?(?:<\?xml[^>]*\?>\s*)?<tileset[\s>]/.test(text));
  // The Godot project a path is in: the nearest folder above it with a project.godot. Godot loads textures only from
  // inside its project, so a saved .tres there needs its sheet there too. The search may pass above the root, so a
  // folder it can't read counts as having none.
  const godotProject = async folder => {
    for (let at = folder; ; at = path.dirname(at)) {
      if ((await lstat(path.join(at, 'project.godot')).catch(() => null))?.isFile()) return at;
      if (path.dirname(at) === at) return null;
    }
  };
  // A saved atlas names its sheet in meta.image, which loadSpriteSheet() and browsers read as a URL relative to the
  // atlas. A name reads back as itself only if every part of it survives that: #, ? and % cut it short or decode it,
  // a backslash becomes a separator, and spaces at either end are dropped.
  const imagePath = (atlasPath, sheetPath) => path.relative(path.dirname(atlasPath), sheetPath).split(path.sep).join('/');
  const readsAsURL = image => image.split('/').every(part => {
    if (part === '..') return true;
    try { return part !== '' && part !== '.' && decodeURIComponent(new URL(part, 'http://host/').pathname.slice(1)) === part && !/[?#]/.test(part); }
    catch { return false; }
  });
  const planSaves = async (saveAs, overwrite, bundle, gifs, animation, sequence, inputs) => {
    if (saveAs === undefined) return [];
    if (saveAs === null || typeof saveAs !== 'object' || Array.isArray(saveAs) || !Object.keys(saveAs).length) throw new PixelError('saveAs', 'expected an object such as { "sheet": "assets/hero.png", "gif": "assets/hero.gif" }');
    if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new PixelError('overwrite', 'expected a boolean');
    const { project } = bundle, base = path.resolve(root), realBase = await realpath(base), store = await canonical(path.join(path.resolve(directory), '.revisions')), exportDirectory = await canonical(path.resolve(directory));
    // A source that can't be resolved any more (a disconnected drive, a dangling link) is compared as written.
    const own = await Promise.all(inputs.map(file => canonical(path.resolve(root, file)).catch(() => path.resolve(root, file))));
    const names = Object.keys(project.animations), only = animation ?? (names.length === 1 ? names[0] : undefined);
    const aliases = { sheet: `${project.name}.png`, atlas: `${project.name}.atlas.json`, godot: `${project.name}.tres`, tileset: `${project.name}.tileset.tres`, tiled: `${project.name}.tsx`, recipe: `${project.name}.pixel.json`, gif: `gifs/${only}.gif`, apng: `animations/${only}.png` };
    // The home folder's settings folder is off limits, unless the root itself is inside it.
    const settings = SETTINGS ? [path.join(os.homedir(), SETTINGS)] : [];
    if (settings.length) settings.push(await realpath(settings[0]).catch(() => settings[0]));
    const guarded = settings.filter(folder => !inside(folder, base) && !inside(folder, realBase));
    const plan = [], seen = new Set();
    for (const [key, target] of Object.entries(saveAs)) {
      const where = `saveAs.${key}`;
      if ((key === 'gif' || key === 'apng') && only === undefined) throw new PixelError(where, `the project has ${names.length} animations: pass animation, or name the file, such as ${key === 'gif' ? `gifs/${names[0]}.gif` : `animations/${names[0]}.png`}`);
      const file = Object.hasOwn(aliases, key) ? aliases[key] : key;
      const bytes = file.startsWith('gifs/') ? gifs.find(item => `gifs/${item.animation}.gif` === file)?.data : file.startsWith('sequence/') ? sequence?.files.get(file.slice(9)) : bundle.files.get(file);
      if (!bytes && (key === 'tileset' || key === 'tiled')) throw new PixelError(where, `this export has no ${key === 'tiled' ? 'Tiled tileset' : 'Godot TileSet'}: only a recipe whose frames are an autotile set (compiled from a pixelforge-autotile source) or whose frames have a tile field has one`);
      if (!bytes && (key === 'godot' || key === 'apng') && bundle.files.has(`${project.name}.tileset.tres`)) throw new PixelError(where, 'this export is a tile set with no animations of its own, so it has no SpriteFrames or animated PNGs: save tileset, the Godot TileSet, and sheet');
      if (!bytes) throw new PixelError(where, `this export has no ${file}; use sheet, atlas, godot, tileset, tiled, recipe, gif, apng or a file it lists, such as frames/${project.frames[0].name}.png`);
      if (/\.(css|html)$/i.test(file)) throw new PixelError(where, `${file} loads other export files by relative path, so a copy elsewhere would show nothing: save the files it uses (sheet, atlas, animations) instead, and keep ${file} in the export folder`);
      const type = path.extname(file).toLowerCase();
      if (!SAVED_TYPES.includes(type)) throw new PixelError(where, `saveAs copies PNG, GIF and JSON files and the Godot .tres and Tiled .tsx (sheet, atlas, godot, tileset, tiled, recipe, GIFs, animations, frames, sequence frames): keep ${file} in the export folder`);
      if (typeof target !== 'string' || !target.trim()) throw new PixelError(where, 'expected a path such as "assets/hero.png"');
      if (path.extname(target).toLowerCase() !== type) throw new PixelError(where, `${file} is a ${type} file: give a path ending in ${type}`);
      if (/[\u0000-\u001f]/.test(target)) throw new PixelError(where, 'contains a control character');
      const destination = path.resolve(base, target);
      if (!inside(base, destination) || destination === base) throw new PixelError(where, `must stay inside ${base}`);
      if (process.platform === 'win32' && path.relative(base, destination).split(path.sep).some(windowsName)) throw new PixelError(where, `${target} is not a name Windows can create: no < > : " | ? *, no device names such as con or nul, and no dot or space at the end of a name`);
      // The nearest folder that exists must be a folder, and the real path inside the root and outside the store.
      const folder = await nearest(path.dirname(destination)), real = await canonical(destination);
      if (!(await stat(await realpath(folder))).isDirectory()) throw new PixelError(where, `${folder} is a file, not a folder`);
      if (!inside(realBase, real) || fold(real) === fold(realBase)) throw new PixelError(where, `must stay inside ${base}`);
      if (inside(store, real)) throw new PixelError(where, 'must not be inside the revision store');
      if (inside(real, exportDirectory)) throw new PixelError(where, `must not be the export directory ${path.resolve(directory)} or a folder above it`);
      if (hidden(path.relative(base, destination)) || hidden(path.relative(realBase, real))) throw new PixelError(where, `${target} is or is inside a hidden file or folder (a name starting with "."): saveAs writes only visible files`);
      if (guarded.some(folder => inside(folder, destination) || inside(folder, real))) throw new PixelError(where, `${target} is inside ${guarded[0]}, where apps keep their settings: saveAs writes only art`);
      // Like the CLI's exports, never over the files this render was made from, even with overwrite.
      if (own.some(input => fold(input) === fold(real))) throw new PixelError(where, `${target} is a palette or asset file this recipe references; choose another name`);
      const existing = await entry(destination);
      if (existing && !existing.isFile()) throw new PixelError(where, `${destination} exists and is not a file`);
      if (existing && overwrite !== true) throw new PixelError(where, `${destination} already exists: choose a new name, or pass "overwrite": true to replace it`);
      if (existing && type === '.json' && !(await spriteJSON(destination, existing.size))) throw new PixelError(where, `${destination} is not a recipe, atlas or sequence (a JSON object with frames), so overwrite won't replace it: choose a new name`);
      const resource = file.endsWith('.tileset.tres') ? 'TileSet' : 'SpriteFrames';
      if (existing && type === '.tres' && !(await godotResource(destination, existing.size, resource))) throw new PixelError(where, `${destination} is not a Godot ${resource} resource, so overwrite won't replace it: choose a new name`);
      if (existing && type === '.tsx' && !(await tiledTileset(destination, existing.size))) throw new PixelError(where, `${destination} is not a Tiled tileset, so overwrite won't replace it: choose a new name`);
      const id = fold(real);
      if (seen.has(id)) throw new PixelError(where, `${target} is named twice`);
      const clash = [...seen].find(other => inside(other, id) || inside(id, other));
      if (clash !== undefined) throw new PixelError(where, `${target} and another saveAs path would need one to be a folder of the other`);
      seen.add(id);
      plan.push({ key, target, file, destination, bytes, replaced: Boolean(existing) });
    }
    // A saved atlas, .tres or .tsx names the sheet it describes relative to itself (Godot and Tiled read it from the
    // file's own folder): a saved sheet, the one in its own folder first, or else the export folder's, whose name is
    // only known once that folder exists (null here).
    const sheets = plan.filter(item => item.file === `${project.name}.png`);
    const named = [['atlas', ['.atlas.json']], ['.tres', ['.tres', '.tileset.tres']], ['.tsx', ['.tsx']]];
    for (const [kind, endings] of named) for (const item of plan.filter(each => endings.some(ending => each.file === project.name + ending))) {
      const sheet = sheets.find(each => fold(path.dirname(each.destination)) === fold(path.dirname(item.destination))) ?? sheets[0];
      item.rebase = sheet ? sheet.destination : null;
      // The export folder is <directory>/<name>-<6 letters or digits>, so its own name can't add these characters.
      const target = sheet ? sheet.destination : path.join(path.resolve(directory), `${project.name}-x`, `${project.name}.png`);
      if (path.isAbsolute(path.relative(path.dirname(item.destination), target))) throw new PixelError(`saveAs.${item.key}`, `the ${kind} is on another drive than the export folder, so it can't name the export's sheet: save the sheet too, such as saveAs.sheet`);
      if (kind === 'atlas') {
        const image = imagePath(item.destination, target);
        if (!readsAsURL(image)) throw new PixelError(`saveAs.${item.key}`, `the atlas would name its sheet as ${image}, which reads as another name when it is loaded as a URL: choose a sheet path${sheet ? '' : ' in saveAs, or an export directory,'} without #, ?, %, backslashes or spaces at either end of a name`);
      }
      if (kind === '.tres') {
        const godotFolder = await godotProject(path.dirname(item.destination));
        if (godotFolder && !inside(godotFolder, target)) throw new PixelError(`saveAs.${item.key}`, `${item.destination} is in the Godot project ${godotFolder}, but its sheet ${sheet ? `${sheet.destination} is` : 'would stay in the export folder,'} outside it, and Godot loads textures only from inside the project: save the sheet into the project too, such as saveAs.sheet`);
      }
    }
    return plan;
  };
  // The bytes a saved .tsx gets: its image named relative to it, with / separators.
  const rebasedTiled = (bytes, tsxPath, sheetPath) => {
    const image = imagePath(tsxPath, sheetPath).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return Buffer.from(Buffer.from(bytes).toString('utf8').replace(/(<image source=")[^"]*(")/, (_, open, close) => `${open}${image}${close}`));
  };
  // The bytes a saved .tres gets: its sheet named relative to it, with / separators.
  const rebasedSpriteFrames = (atlas, tresPath, sheetPath) => Buffer.from(spriteFrames(atlas.metadata, { image: imagePath(tresPath, sheetPath) }).text);
  const rebasedTileSet = (bytes, tresPath, sheetPath) => Buffer.from(retexture(Buffer.from(bytes).toString('utf8'), imagePath(tresPath, sheetPath)));
  // The bytes a saved atlas gets: its meta.image pointing at the given sheet, relative to the atlas, with / separators.
  const rebasedAtlas = (bytes, atlasPath, sheetPath) => {
    const atlas = JSON.parse(Buffer.from(bytes).toString('utf8'));
    atlas.meta = { ...atlas.meta, image: imagePath(atlasPath, sheetPath) };
    return Buffer.from(JSON.stringify(atlas, null, 2) + '\n');
  };
  // Every copy is first written to a temporary file beside its destination, so a write that fails leaves no copy and
  // replaces nothing. Then each goes in place under the staged file's own identity: a new file is linked in (copied
  // where links aren't supported) only if nothing is there yet; a file being replaced first gets a second name (a hard
  // link, or a copy) holding its old bytes, and the new file is renamed over it in one step, so the destination is
  // never missing, even if the call is stopped, and a hard link to the old file keeps the old bytes. If a step fails,
  // what this call put in place is undone (replaced files get their old bytes back, new copies are removed), but only
  // where the file is still the one it placed, so another server's later write is never undone; a backup that can't
  // be put back is kept, and the error names it. The error is the entry that could not be written, by the key and
  // path the caller gave, and why in a few words: the system's own message names the temporary files.
  const temporaryIn = folder => path.join(folder, `.pixelbolt-${randomUUID()}.tmp`);
  const identity = async file => { const info = await stat(file, { bigint: true }).catch(() => null); return info && `${info.dev}:${info.ino}`; };
  const REFUSALS = { EACCES: 'no permission to write there', EPERM: 'no permission to write there, or the file is open in another program', EBUSY: 'the file is open in another program', EROFS: 'the disk is read-only', ENOSPC: 'the disk is full', EDQUOT: 'the disk quota is used up', EEXIST: 'a file appeared there after the paths were checked', ENOENT: 'its folder went missing after the paths were checked', ENOTDIR: 'a folder in it became a file after the paths were checked' };
  const whyNot = (error, destination) => {
    // Windows reports a name it can't hold as a missing file. It counts UTF-16 units, other systems bytes.
    const long = part => (process.platform === 'win32' ? part.length : Buffer.byteLength(part)) > 255;
    if (error.code === 'ENAMETOOLONG' || destination.split(path.sep).some(long)) return 'a name in it is too long for the disk';
    return REFUSALS[error.code] ?? (error.code ? `${/^\w+: ([^,]+)/.exec(error.message)?.[1] ?? 'the system refused it'}, ${error.code}` : error.message);
  };
  const writeSaves = async (saves, replace, bytesOf) => {
    const staged = [], placed = [], backups = new Set(), kept = [];
    let writing;
    try {
      for (const item of saves) {
        writing = item;
        await mkdir(path.dirname(item.destination), { recursive: true });
        staged.push(temporaryIn(path.dirname(item.destination)));
        await writeFile(staged.at(-1), bytesOf(item), { flag: 'wx' });
      }
      for (const [index, item] of saves.entries()) {
        writing = item;
        // A rename or link keeps the file's identity, so it is known before anyone else can touch the destination.
        let mine = await identity(staged[index]), backup = null;
        if (!replace) {
          try { await link(staged[index], item.destination); }
          catch (error) {
            if (error.code === 'EEXIST') throw error;
            await copyFile(staged[index], item.destination, constants.COPYFILE_EXCL);
            mine = await identity(item.destination);
          }
        } else {
          if (await entry(item.destination)) {
            backup = temporaryIn(path.dirname(item.destination));
            await link(item.destination, backup).catch(() => copyFile(item.destination, backup, constants.COPYFILE_EXCL));
            backups.add(backup);
          }
          await rename(staged[index], item.destination);
        }
        placed.push({ destination: item.destination, backup, mine });
      }
    } catch (error) {
      for (const step of placed.reverse()) {
        if (step.mine === null || await identity(step.destination) !== step.mine) continue;
        try { if (step.backup) await rename(step.backup, step.destination); else await rm(step.destination, { force: true }); }
        catch { kept.push(step); }
      }
      const left = kept.map(step => (step.backup ? `${step.destination} could not be put back: its old bytes are kept at ${step.backup}` : `${step.destination} was written and could not be removed`));
      throw new PixelError(`saveAs.${writing.key}`, `${writing.target} could not be written (${whyNot(error, writing.destination)}), so ${left.length ? `the other saveAs files were undone, but ${left.join('; ')}` : 'no saveAs file was written or changed'}`);
    } finally {
      const keep = new Set(kept.map(step => step.backup));
      await Promise.all([...staged, ...[...backups].filter(file => !keep.has(file))].map(file => rm(file, { force: true })));
    }
  };
  return async function runTool(name, args, ui = false) {
    try {
      // Keep PNG encoding and the viewer modules out of ordinary calls, including clients without MCP Apps.
      const preview = ui && pictureTools.has(name) ? (await import('./mcp-preview.js')).previewMeta : null;
      const { project: spec, revision, changes, ...options } = args;
      if (name === 'pixel_help') {
        // Markdown topics come back as written (the guide and workflow with their sections listed first); JSON ones without the files' indentation.
        if (args.topic !== undefined && !TOPICS.includes(args.topic)) throw new PixelError('topic', `expected one of ${TOPICS.join(', ')}`);
        if (args.name !== undefined && args.topic !== 'preset' && !SECTIONED.has(args.topic) && !isSchema(args.topic)) throw new PixelError('name', 'name goes with topic "preset" (the preset whose source to return), "guide", "workflow" and "craft" (the section to return) or a schema topic (the part to return, such as "effects")');
        if (args.full !== undefined && typeof args.full !== 'boolean') throw new PixelError('full', 'expected a boolean');
        if (args.full !== undefined && args.topic !== 'presets') throw new PixelError('full', 'full goes with topic "presets" (every preset\'s file and animations)');
        if (args.find !== undefined && (args.topic !== 'presets' || args.full)) throw new PixelError('find', 'find goes with topic "presets", without full (the presets a few words match)');
        if (args.topic === 'presets') {
          const listing = await listPresets({ cache: path.join(path.resolve(directory), '.presets') });
          return { content: [textContent(args.find !== undefined ? findListing(listing, args.find) : args.full ? listing : briefListing(listing))] };
        }
        if (args.topic === 'preset') {
          const entry = await findPreset(args.name, 'name'), { source, inlined } = await loadPreset(entry);
          return { content: [textContent({ name: entry.name, file: `examples/${entry.file}`, ...(inlined.length && { inlined }), next: presetNext(entry), source })] };
        }
        const text = await helpText(args.topic, args.name);
        // A schema's outline is text; the schema, a part of it and the example are JSON, sent without indentation.
        return { content: [textContent(jsonTopic(args.topic) && /^\s*[{[]/.test(text) ? JSON.parse(text) : text)] };
      } else if (name === 'pixel_validate') {
        const { recipe, resolved, sources } = await recipeFrom(spec, revision), project = renderProject(recipe);
        return { content: [textContent(withResolved({ ok: true, revision: await keep(recipe, sources), width: project.width, height: project.height, frames: project.frames.length, ...describeAnimations(project, recipe), timing: briefCells(project.frames.map(({ name, duration }) => ({ name, duration }))), warnings: project.warnings, ...(project.clipping && { clipping: project.clipping }), ...(project.clippingOmitted && { clippingOmitted: project.clippingOmitted }), ...(options.fps !== undefined && { frameGrid: frameGrid(project, options.fps) }) }, resolved))] };
      } else if (name === 'pixel_inspect') {
        const { layers, reference, beside, palette, source: poseSource, metadata: suppliedMetadata, speed, ground, ...inspection } = options;
        let recipe, resolved, sources, metadata = suppliedMetadata, poseWarnings = [];
        if (poseSource !== undefined) {
          if (spec !== undefined || revision !== undefined || suppliedMetadata !== undefined) throw new PixelError('arguments', 'source replaces project, revision and metadata');
          const input = await resolveReferences(poseSource, { baseDir: root, root });
          ({ recipe, metadata, warnings: poseWarnings = [] } = compilePoses(input.document)); resolved = sources = relativeToRoot(input.files);
        } else ({ recipe, resolved, sources } = await recipeFrom(spec, revision));
        const project = renderProject(recipe, { ...(layers !== undefined && { layers }), ...((inspection.view === 'parts' || palette === true) && { owners: true }) });
        let view;
        if (inspection.view === 'motion') {
          if (layers !== undefined || reference !== undefined || beside !== undefined) throw new PixelError('arguments', 'motion review uses the complete animation; omit layers, reference and beside');
          const { view: mode, ...motionOptions } = inspection;
          view = inspectMotion(project, { ...motionOptions, metadata, ...(speed !== undefined && { speed }), ...(ground !== undefined && { ground }) });
        } else {
          if (speed !== undefined || ground !== undefined || suppliedMetadata !== undefined) throw new PixelError('arguments', 'speed, ground and metadata require view: motion');
          view = inspectProject(project, inspection);
          if (view.diagnostics) view.diagnostics = briefDiagnostics(view.diagnostics);
          // beside: the same view of more revisions under this one, in the one image.
          if (beside !== undefined) {
            if (inspection.native || inspection.grid) throw new PixelError('beside', 'beside draws several recipes in one sheet; native and grid read one recipe at a time');
            const others = [];
            for (const id of beside) {
              const other = renderProject(await read(id), layers === undefined ? {} : { layers });
              try { others.push({ ...inspectProject(other, inspection), name: `${other.name} ${id}` }); } catch (error) { throw new PixelError(error.path ?? 'beside', `revision ${id} (${other.name}): ${error.message}`); }
            }
            view = stackViews([{ ...view, name: project.name }, ...others]);
          }
        }
        const comparison = reference === undefined ? null : compareProjects(renderProject(await read(reference), layers === undefined ? {} : { layers }), project);
        const content = [textContent(withResolved({ ok: true, revision: await keep(recipe, sources), name: project.name, width: project.width, height: project.height, frames: project.frames.length, ...describeAnimations(project, recipe), ...viewSummary(view), ...(palette === true && { palette: paletteUse(project) }), warnings: [...poseWarnings, ...project.warnings] }, resolved)), imageContent(view.sheet)];
        if (view.nativeSheet) content.push(imageContent(view.nativeSheet));
        if (view.grids) content.push(textContent(gridText(view)));
        if (reference !== undefined) {
          const { image, ...report } = comparison;
          content.push(textContent({ reference, comparison: briefComparison(report), ...(image && { comparisonImage: { region: image.region, frames: image.frames, omitted: image.omitted ?? 0 } }) }));
          if (image) content.push(imageContent(image.sheet));
        }
        // The player plays the project only when the inspection shows it as it plays (all frames or one animation, any
        // zoom or backdrop); a selection, region, review mode, grid, guide or comparison shows the inspection's own image.
        const playable = reference === undefined && Object.entries(inspection).every(([key, value]) => ['animation', 'scale', 'background', 'maxCells', 'native'].includes(key) || (key === 'view' && value === 'color'));
        return { content, ...(preview && (playable ? preview(project, { animation: inspection.animation })
          : preview({ width: view.sheet.width, height: view.sheet.height, frames: [{ name: 'inspection', duration: 100, data: view.sheet.data }], animations: {} }))) };
      } else if (name === 'pixel_patch') {
        if ((changes === undefined) === (options.overlay === undefined)) throw new PixelError('arguments', 'send either changes or overlay');
        const { recipe: base, resolved, sources } = await recipeFrom(spec, revision), before = renderProject(base);
        const applied = options.overlay === undefined ? patchRecipe(base, changes) : applyOverlay(base, options.overlay);
        const { recipe, edits } = applied, after = renderProject(recipe);
        const { image, ...report } = compareProjects(before, after), baseId = await keep(base, sources);
        const summary = { ok: true, revision: await keep(recipe, sources), base: baseId, edits, ...(applied.rebased && { rebased: true }), ...briefComparison(report), ...(image && { image: { region: image.region, frames: image.frames, ...(image.omitted && { omitted: image.omitted }), scale: image.sheet.scale } }), warnings: after.warnings };
        return { content: [textContent(withResolved(summary, resolved)), ...(image ? [imageContent(image.sheet)] : [])], ...(preview && preview(after)) };
      } else if (name === 'pixel_render') {
        const { animation, listFiles, sequence, share, embedRecipe, saveAs, overwrite } = options, expect = readExpect(options.expect);
        for (const key of ['share', 'embedRecipe']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new PixelError(key, 'expected a boolean');
        // A GIF named in saveAs needs GIFs: the frames' own size unless gif says otherwise.
        const gif = options.gif === undefined && saveAs !== null && typeof saveAs === 'object' && Object.keys(saveAs).some(key => key === 'gif' || key.startsWith('gifs/')) ? {} : options.gif;
        const { recipe, resolved, sources } = await recipeFrom(spec, revision), bundle = await createBundle(recipe), view = inspectProject(bundle.project, { ...(animation !== undefined && { animation }), maxCells: 256 });
        // GIFs are encoded before anything is written, so a refused GIF leaves no folder behind.
        if (gif !== undefined && (gif === null || typeof gif !== 'object' || Array.isArray(gif))) throw new PixelError('gif', 'expected an object such as {} or { "scale": 8 }');
        const gifs = gif === undefined ? [] : Object.keys(bundle.project.animations).map(name => animationGIF(bundle.project, name, gif));
        if (gifs.reduce((sum, item) => sum + item.frames * item.width * item.height, 0) > 67108864) throw new PixelError('gif', 'all animations at this scale exceed 67,108,864 pixels; lower gif.scale');
        const frames = sequence === undefined ? null : checkSequenceSize(createSequence(bundle.project, { ...(animation !== undefined && { animation }), ...(sequence !== null && typeof sequence === 'object' ? sequence : { fps: undefined }) }));
        let shared;
        if (share === true) {
          try { const link = await shareLink(recipe, version); shared = { link, characters: link.length }; }
          catch (error) { shared = { error: error.message }; }
        }
        // Every PNG this call writes carries the recipe, video frames included.
        if (embedRecipe === true) for (const files of [bundle, frames]) if (files) await embedBundleRecipe(files, recipe, version);
        const saves = await planSaves(saveAs, overwrite, bundle, gifs, animation, frames, sources);
        const savedRevision = await keep(recipe, sources), out = await newFolder(bundle.project.name);
        const files = await writeBundle(bundle, out);
        if (frames) await writeBundle(frames, path.join(out, 'sequence'));
        if (gifs.length) await mkdir(path.join(out, 'gifs'));
        for (const item of gifs) await writeFile(path.join(out, 'gifs', `${item.animation}.gif`), item.data, { flag: 'wx' });
        // A copy that can't be written undoes the copies, not the export: the folder and the revision are whole, and
        // the error carries both under the names a finished render gives them.
        try {
          await writeSaves(saves, overwrite === true, item => {
            if (item.rebase === undefined) return item.bytes;
            const sheet = item.rebase ?? path.join(out, `${bundle.project.name}.png`);
            if (item.file.endsWith('.tileset.tres')) return rebasedTileSet(item.bytes, item.destination, sheet);
            if (item.file.endsWith('.tsx')) return rebasedTiled(item.bytes, item.destination, sheet);
            return item.file.endsWith('.tres') ? rebasedSpriteFrames(bundle.atlas, item.destination, sheet) : rebasedAtlas(item.bytes, item.destination, sheet);
          });
        } catch (error) {
          error.message += `. The export itself was written to ${out}: use its files, or send revision "${savedRevision}" with saveAs paths that can be written`;
          throw Object.assign(error, { made: { revision: savedRevision, directory: out } });
        }
        const check = checkDelivery(bundle.project, { recipe, gifs, expect, animation });
        return { content: [textContent(withResolved({ ok: true, revision: savedRevision, directory: out, ...outputSummary(out, files, listFiles === true), frames: bundle.project.frames.length, ...describeAnimations(bundle.project, recipe), playback: path.join(out, 'preview.html'), ...(gifs.length && { gifs: { directory: 'gifs', count: gifs.length, scale: gifs[0].scale, width: gifs[0].width, height: gifs[0].height, ...(gifs.length <= 16 && { files: gifs.map(item => `gifs/${item.animation}.gif`) }), notes: gifs.flatMap(item => item.notes.map(text => `${item.animation}: ${text}`)).slice(0, 16) } }), ...(frames && { sequence: sequenceSummary(frames.info) }), ...(saves.length && { saved: saves.map(item => ({ file: item.file, path: item.destination, ...(item.replaced && { replaced: true }) })) }), check: briefCheck(check), preview: viewSummary(view), warnings: bundle.project.warnings, ...(shared && { share: shared }) }, resolved)), imageContent(view.sheet)], ...(preview && preview(bundle.project, {
          animation, files: [...new Set([
            ...files.filter(file => path.dirname(file) === out && /\.(?:png|atlas\.json|pixel\.json|tres|tsx)$/.test(file)),
            ...saves.map(item => item.destination), ...gifs.map(item => path.join(out, 'gifs', item.animation + '.gif')),
            ...files, ...(frames ? [...frames.files.keys()].map(file => path.join(out, 'sequence', file)) : [])
          ])],
          verdict: check.ok === true ? 'passed' : check.ok === false ? 'failed' : 'not-checked', ...(shared?.link && { shareLink: shared.link })
        })) };
      } else if (name === 'pixel_compile') {
        if ((args.source === undefined) === (args.preset === undefined)) throw new PixelError('arguments', 'send either source or preset');
        // A preset compiles exactly as its file does; its files are the package's, so none is recorded as a source.
        const referenced = [], { document, files: sourceFiles } = args.preset !== undefined ? { document: (await loadPreset(await findPreset(args.preset))).source, files: [] }
          : await resolveReferences(args.source, { baseDir: root, root, revisions: id => { referenced.push(id); return read(id); } });
        const format = document?.format;
        if (args.preset === undefined && !Object.hasOwn(COMPILERS, format ?? '')) throw new PixelError('source.format', 'expected pixelforge-poses, pixelforge-autotile, pixelforge-fx, pixelforge-fluid, pixelforge-wave, pixelforge-crystal, pixelforge-powder, pixelforge-bodies or pixelforge-normals');
        for (const key of ['size', 'frames', 'animation']) if (args[key] !== undefined && (args.draftViews !== undefined || args.sequence !== undefined)) throw new PixelError(key, `${key} goes with a compile that returns a recipe; leave out draftViews and sequence (a sequence has its own size and length)`);
        // Drafts of turned grid parts to correct and paste into the source's views; nothing is compiled or kept.
        if (args.draftViews !== undefined) {
          if (format !== 'pixelforge-poses') throw new PixelError('draftViews', 'draft views turn grid parts of a pixelforge-poses source');
          if (args.metadata !== undefined || args.sequence !== undefined) throw new PixelError('draftViews', 'draftViews replaces compiling; leave out metadata and sequence');
          // A sheet too large to draw is left out, saying why; the drafts come back either way.
          const { drafts, sheet, noSheet } = draftViews(document, args.draftViews);
          return { content: [textContent({ ok: true, drafts, sheet: sheet ? 'one row per draft: the flat drawing, the turn the compiler draws today without a view, the draft, and any drawn view used at that angle; the anchor is outlined in magenta, named points in cyan' : `not drawn: ${noSheet}`, next: 'Drafts, not art: correct the rows of each by eye, then add the view to parts.<name>.views in your source. A view is drawn within 22.5° of its key. Nothing was written.' }), ...(sheet ? [imageContent(sheet)] : [])] };
        }
        // A bodies match written as numbered video frames, stepped frame after frame, so it may run past 256 frames.
        if (args.sequence !== undefined) {
          if (format !== 'pixelforge-bodies') throw new PixelError('sequence', 'pixel_compile writes video frames for a pixelforge-bodies match; for other sources compile, then pixel_render with sequence');
          const frames = checkSequenceSize(createBodiesSequence(document, args.sequence, { budget: SEQUENCE_PIXELS })), out = await newFolder(document.name);
          await writeBundle(frames, path.join(out, 'sequence'));
          return { content: [textContent({ ok: true, name: document.name, directory: out, sequence: sequenceSummary(frames.info), figures: figuresSummary(frames.info.figures) })] };
        }
        const made = args.preset !== undefined ? compilePreset(document) : COMPILERS[format](document), { warnings: compiled = [], preview: testMap } = made;
        // frames: each animation down to that many evenly spaced frames, playing as long as before. size: the drawing
        // on a canvas of another size (cut or given margins, never scaled).
        if (args.size !== undefined && format === 'pixelforge-autotile') throw new PixelError('size', 'a tile set\'s size is its tile, set in the source');
        if (args.frames !== undefined && format === 'pixelforge-autotile') throw new PixelError('frames', 'frames thins animations, and the frames of a tile set are its tiles');
        if (args.animation !== undefined && format === 'pixelforge-autotile') throw new PixelError('animation', 'animation keeps animations, and a tile set has none to choose from');
        if (args.animation !== undefined) made.recipe = keepAnimations(made.recipe, args.animation).recipe;
        const thinned = args.frames !== undefined ? keepFrames(made.recipe, args.frames) : null, kept = thinned?.kept;
        const moved = args.size !== undefined ? resizeRecipe((thinned ?? made).recipe, args.size) : null, recipe = (moved ?? thinned ?? made).recipe, resized = moved?.resized;
        const cut = resized && resizeWarning(resized, [recipe.width, recipe.height]), metadata = made.metadata && (kept || resized) ? { ...made.metadata, ...(kept && { kept }), ...(resized && { resized }) } : made.metadata;
        const project = renderProject(recipe), view = inspectProject(project, { maxCells: 256 });
        // An autotile set also shows every tile over a test map, where seams and repetition show.
        const map = testMap ? inspectProject(renderProject(testMap), { scale: testMapScale(testMap) }) : null;
        return { content: [textContent({ ok: true, revision: await keep(recipe, [...relativeToRoot(sourceFiles), ...(await Promise.all(referenced.map(sourcesOf))).flat()]), name: project.name, width: project.width, height: project.height, frames: project.frames.length, ...describeAnimations(project, recipe), preview: viewSummary(view), ...(map && { testMap: 'the second image: every tile of the set over a test map', ...(tilemapOf(recipe, metadata) && { tilemap: tilemapOf(recipe, metadata) }) }), ...(resized && resizeMargins(resized, [recipe.width, recipe.height]) && { margins: resizeMargins(resized, [recipe.width, recipe.height]) }), ...(kept && { kept }), warnings: [...compiled, ...(thinned?.notes ?? []), ...(cut ? [cut] : []), ...project.warnings.filter(text => !(cut && text.startsWith('Some drawing falls outside the canvas')))], ...(args.metadata === true && { metadata }) }), imageContent(view.sheet), ...(map ? [imageContent(map.sheet)] : [])], ...(preview && preview(project)) };
      } else if (name === 'pixel_scene') {
        const { document, files: sources } = await resolveReferences(args.scene, { baseDir: root, root, revisions: read });
        const scene = prepareScene(document), frame = renderScene(scene, { time: args.time ?? 0, lit: args.lit ?? true, density: args.density ?? false, depth: args.view === 'depth' });
        const scale = args.scale ?? Math.max(1, Math.min(8, Math.floor(768 / Math.max(frame.width, frame.height))));
        const image = sceneImage(frame, { mode: args.view ?? 'color', scale, guides: args.guides });
        const summary = { ok: true, name: document.name, width: frame.width, height: frame.height, duration: scene.duration, time: args.time ?? 0, scale, placements: frame.placements.length, tilemaps: frame.placements.filter(p => p.tilemap).map(p => ({ name: p.name, tiles: p.tiles })), ...(frame.depth && { depth: frame.depth }), ...(frame.lights && { lights: frame.lights }), ...(frame.shadows && { shadows: frame.shadows }), ...(frame.camera && { camera: frame.camera }), ...(frame.haze && { haze: frame.haze }), warnings: frame.warnings, ...(sources.length && { resolved: sources.map(file => path.relative(root, file).split(path.sep).join('/')) }) };
        // The sequence is built before anything is written, so a refused one leaves no folder behind.
        const frames = args.sequence === undefined ? null : checkSequenceSize(createSceneSequence(scene, document.name, args.sequence));
        // One new folder holds whatever the call writes: the scene bundle, the sequence, or both.
        const bundle = args.export === true ? await createSceneBundle(document) : null;
        if (bundle || frames) {
          const out = summary.directory = await newFolder(document.name);
          if (frames) { await writeBundle(frames, path.join(out, 'sequence')); summary.sequence = sequenceSummary(frames.info); }
          // The export's own warnings too (a shade placement left out of the planes, a tile set Godot or Tiled can't
          // take), each once.
          if (bundle) Object.assign(summary, { ...outputSummary(out, await writeBundle(bundle, out), false), playback: path.join(out, 'preview.html'), warnings: [...new Set([...frame.warnings, ...bundle.warnings])] });
        }
        return { content: [textContent(summary), imageContent(image)], ...(preview && preview({ width: frame.width, height: frame.height, frames: [{ name: document.name, duration: 100, data: sceneImage(frame, { mode: args.view ?? 'color', guides: args.guides }).data }], animations: {} })) };
      } else if (name === 'pixel_import') {
        if ((args.data === undefined) === (args.path === undefined)) throw new PixelError('arguments', 'send either data (base64 PNG) or path');
        let bytes, fileName;
        if (args.data !== undefined) bytes = Buffer.from(args.data, 'base64');
        else {
          const file = path.resolve(root, args.path);
          await assertInside(file, root, 'path');
          bytes = await readFile(file);
          // As the command line does: coin.png becomes "coin" where that is a name a recipe can have.
          fileName = path.basename(file).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z]+/, '').slice(0, 64) || undefined;
        }
        const imported = importPNG(bytes, { ...(args.name !== undefined ? { name: args.name } : fileName && { name: fileName }), ...(args.atlas !== undefined && { atlas: args.atlas }), ...(args.frame !== undefined && { frame: readSize(args.frame, 'frame') }), ...(args.padding !== undefined && { padding: args.padding }) });
        const project = renderProject(imported.recipe), view = inspectProject(project, { maxCells: 256 });
        return { content: [textContent({ ok: true, revision: await remember(imported.recipe), name: project.name, width: project.width, height: project.height, frames: project.frames.length, provenance: imported.provenance, preview: viewSummary(view) }), imageContent(view.sheet)], ...(preview && preview(project)) };
      }
    } catch (cause) { return { isError: true, content: [textContent({ ...errorReply(cause), ...cause.made })] }; }
  };
}

// Limits on one tool call, in milliseconds and megabytes. A call past either is stopped and answered with an isError
// result that names the limit; the server keeps serving. The memory limit bounds JavaScript objects (a runaway particle
// or tile expansion), not pixel buffers.
export const TOOL_TIME_LIMIT = 50_000, TOOL_MEMORY_LIMIT = 2048;
// Requests that may wait behind a running call before the server stops reading (see startMCP).
const MAX_WAITING = 256;
const stopped = (name, why, args) => ({ isError: true, content: [textContent({ error: `${name} ${why} and was stopped. ${name === 'pixel_compile' && args?.sequence !== undefined ? 'A long match runs on the command line, which has no time limit: npx -y pixelbolt sequence <source.json> --out <new folder> --fps 30; or use a smaller size or fewer frames.' : 'Make the work smaller (canvas or video size, frames, scale, particles, simulation steps) or split it across calls.'}` })] });

// One worker thread runs the tool calls, one at a time. Stopping a call (past a limit, or cancelled through `signal`)
// ends its worker, and the next call starts a fresh one, so a stopped call leaves nothing behind but any files it had
// already written.
function createToolHost({ directory, root, version, timeLimit, memoryLimit }) {
  let worker = null;
  const spawn = () => {
    const thread = new Worker(new URL('./mcp-worker.js', import.meta.url), { workerData: { directory, root, version }, resourceLimits: { maxOldGenerationSizeMb: memoryLimit }, stdout: true });
    // stdout is the protocol stream, so anything a tool prints goes to stderr instead.
    thread.stdout.pipe(process.stderr, { end: false });
    // Errors during a call are answered by run; one between calls only retires the worker.
    thread.on('error', () => {}).on('exit', () => { if (worker?.thread === thread) worker = null; });
    // The worker says when its modules are loaded, so the time limit counts a call's own work, not startup. `ready`
    // resolves with null then, or with the reason the worker could not start.
    const ready = new Promise(resolve => {
      thread.once('message', () => resolve(null)).once('error', resolve).once('exit', code => resolve(new Error(`the tool worker exited with code ${code}`)));
    });
    return { thread, ready };
  };
  async function run(name, args, signal, ui = false) {
    const current = worker ??= spawn(), { thread } = current, failure = await current.ready;
    if (failure) { if (worker === current) worker = null; return { isError: true, content: [textContent({ error: failure.message })] }; }
    const cancelled = { isError: true, content: [textContent({ error: `${name} was cancelled` })] };
    // Cancelled while the worker started: it never saw the call, so it stays for the next one.
    if (signal?.aborted) return cancelled;
    return new Promise(resolve => {
      let timer;
      const finish = value => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); thread.off('message', finish).off('error', failed).off('exit', ended); resolve(value); };
      const stop = value => { if (worker === current) worker = null; thread.terminate(); finish(value); };
      const failed = error => stop(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? stopped(name, `ran out of memory (${memoryLimit} MB)`, args) : { isError: true, content: [textContent({ error: error.message })] });
      const ended = () => stop(stopped(name, 'ended unexpectedly', args));
      const cancel = () => stop(cancelled);
      timer = setTimeout(() => stop(stopped(name, `took longer than ${timeLimit / 1000} s`, args)), timeLimit);
      thread.on('message', finish).on('error', failed).on('exit', ended);
      signal?.addEventListener('abort', cancel, { once: true });
      // A value the worker can't be sent is this call's error; the worker never saw it and keeps serving.
      try { thread.postMessage({ name, args, ...(ui && { ui }) }); } catch (cause) { finish({ isError: true, content: [textContent({ error: `${name} could not be started: ${cause.message}` })] }); }
    });
  }
  return { run, close: async () => { await worker?.thread.terminate(); } };
}

export async function startMCP({ directory = 'output', root = process.cwd(), input = process.stdin, output = process.stdout, timeLimit = TOOL_TIME_LIMIT, memoryLimit = TOOL_MEMORY_LIMIT } = {}) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // The recipe's full JSON Schema is about 30 KB; repeated in four tool listings it cost every client about 30,000
  // tokens before the first call. The server checks recipes itself and names the path of any mistake, so the tools
  // describe the recipe briefly and pixel_help's schema topic carries the full schema. Option descriptions stay short
  // for the same reason: pixel_help's guide topic explains every option, and the listing has a byte cap (see the test).
  const source = {
    project: { type: 'object', description: 'A version-1 Pixelbolt recipe: {"version": 1, "name", "width", "height", "palette", "symbols"?, "frames": [{"name", "duration"?, "from"?, "ops"?, "layers"?}], "animations"?}; see pixel_help.' },
    revision: { type: 'string', pattern: '^[a-f0-9]{12}$', description: 'Revision id from an earlier response, sent instead of project.' }
  };
  const projectInput = { type: 'object', properties: source, additionalProperties: false };
  const renderInput = { ...projectInput, properties: { ...source, animation: { type: 'string', description: 'Preview this animation in playback order; every animation is exported either way.' }, listFiles: { type: 'boolean', description: 'List every exported file, not only the key ones.' }, gif: { type: 'object', properties: { scale: { type: 'integer', minimum: 1, maximum: 16, description: 'Default 1, the frames\' own size; enlarge only for posting.' }, background: { type: 'string', description: 'Palette name or opaque hex to blend onto. Default: 1-bit transparency.' } }, additionalProperties: false, description: 'Also write each animation as a GIF in gifs/ ({} for defaults): exact colours, at most 256 per frame.' }, sequence: { type: 'object', required: ['fps'], additionalProperties: false, description: 'Also write numbered PNG frames with alpha for a video editor into sequence/, with the ffmpeg command for a .mov.', properties: {
    fps: { type: ['number', 'string'], description: '24, 25, 30, 60, "23.976", "29.97", "59.94" or a fraction such as "30000/1001".' },
    animation: { type: 'string', description: 'Default: the previewed animation, or the first.' }, step: { type: 'integer', minimum: 1, maximum: 60, description: 'Video frames per sampled frame; 2 animates on twos.' },
    size: { type: 'string', description: '720p, 1080p, 1440p, 4k, vertical, square or WIDTHxHEIGHT. Default: the sprite at scale.' },
    scale: { type: 'integer', minimum: 1, maximum: 256 }, fit: { enum: ['contain', 'cover'] },
    align: { enum: ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] },
    offset: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[x, y] added to the aligned position.' },
    background: { type: 'string', description: 'Palette name or opaque hex. Default: transparent.' },
    loops: { type: 'integer', minimum: 1, maximum: 1000 }, seconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600, description: 'Clip length instead of loops.' }
  } }, share: { type: 'boolean', description: 'Also return a playground link that reopens this recipe in a browser.' }, embedRecipe: { type: 'boolean', description: 'Embed the recipe in the exported PNGs so they reopen in the playground.' }, expect: { type: 'object', properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, frames: { type: ['integer', 'object'], minimum: 1, additionalProperties: { type: 'integer', minimum: 1 }, description: 'Frames each animation plays, or per animation: {"idle": 4, "walk": 8}.' }, colors: { type: 'integer', minimum: 1 }, transparent: { type: 'boolean' }, loop: { type: 'boolean' }, gifScale: { type: 'integer', minimum: 1, maximum: 16 } }, additionalProperties: false, description: 'What the user asked for: frame size, frames per animation, at most colors, a transparent background, loop, GIF scale. The reply\'s check lists each miss and the call that fixes it.' }, saveAs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Also write files where the user asked, relative to the server root: {"sheet"|"atlas"|"godot"|"tileset"|"tiled"|"recipe"|"gif"|"apng" or a listed file such as "gifs/walk.gif": "assets/hero.png"}. A GIF here implies gif: {}.' }, overwrite: { type: 'boolean', description: 'Let saveAs replace existing files. Default: refuse.' } } };
  const validateInput = { ...projectInput, properties: { ...source, fps: { type: ['number', 'string'], description: 'Also check timing against a video frame rate (24, 25, "29.97", 30, 60 or a fraction): frameGrid lists durations off the grid.' } } };
  const coordinate = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
  const guides = { type: 'object', description: 'Perspective guides: {horizon: row, vanish: [[x, y], …up to 3], iso: {tile: [32, 16], at: [x, y]}}.' };
  const inspectInput = { ...projectInput, properties: {
    guides,
    ...source,
    source: { type: 'object', description: 'A pixelforge-poses source instead of project/revision, for motion review with its contacts.' },
    metadata: { type: 'object', description: 'Pose metadata from pixel_compile (metadata: true), for motion review of a compiled revision.' },
    speed: { type: 'number', minimum: -4096, maximum: 4096, description: 'Motion view: pixels per second.' },
    ground: { type: 'integer', minimum: 0, maximum: 255, description: 'Motion view: ground row.' },
    layers: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64, description: 'Show only these named layers.' },
    reference: { type: 'string', description: 'Revision to compare against: adds a before/after image and the changed pixels.' }, beside: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: 'Revisions drawn under this one in the same view and image, to compare variants.' },
    frames: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1024, description: 'Frame names to show, in order; * and ? match, as in "flash-*". Default: every frame.' },
    animation: { type: 'string', description: 'Show one animation in playback order instead of frames.' },
    region: { type: 'object', properties: { x: coordinate(0, 4095), y: coordinate(0, 4095), w: coordinate(1, 4096), h: coordinate(1, 4096) }, required: ['x', 'y', 'w', 'h'], additionalProperties: false, description: 'Crop every frame to this canvas rectangle.' },
    grid: { type: 'boolean', description: 'Also return palette-key text grids with x/y rulers (at most 16,384 pixels).' },
    scale: { type: 'integer', minimum: 1, maximum: 16, description: 'Contact sheet scale. Default: the largest that fits about 1024 px.' },
    background: { type: 'string', description: 'checker (default), transparent, a palette name or a hex color.' },
    view: { enum: ['color', 'silhouette', 'grayscale', 'onion', 'tile', 'parts', 'motion'], description: 'onion and motion need animation; motion reports foot slide, ground error and loop joins and traces limb arcs (source or metadata adds contacts); parts colours each pixel by the layer or pose part that drew it; tile repeats each frame 3x3.' },
    native: { type: 'boolean', description: 'Also return a 1x contact sheet.' },
    palette: { type: 'boolean', description: 'Also list each palette key with its colour, pixels and the parts it colours.' },
    diagnostics: { type: 'boolean', description: 'Advisory evidence: duplicate and empty frames, stray pixels, palette, loop joins, timing, cleanup counts.' },
    maxCells: { type: 'integer', minimum: 1, maximum: 256, description: 'Show at most this many evenly spaced cells; step and offset pick positions instead.' },
    step: { type: 'integer', minimum: 1, maximum: 1024, description: 'Keep every step-th cell from offset; step 2 shows the A frames of an A/B strobe.' },
    offset: { type: 'integer', minimum: 0, maximum: 2047 },
    every: { type: 'integer', minimum: 10, maximum: 60000, description: 'With animation: a cell per this many ms of playback, so holds and pacing show.' }
  } };
  const patchInput = { ...projectInput, properties: {
    ...source,
    changes: { type: 'array', minItems: 1, maxItems: 1024, description: 'Edits applied in order. Paths match error paths, such as frames[3].duration; lists also accept [name] and [-] to append.', items: { type: 'object', properties: {
      set: { type: 'string', description: 'Path to replace, or an object field to add.' },
      insert: { type: 'string', description: 'List position to insert before; [-] appends.' },
      remove: { type: 'string', description: 'Object field or list item to delete.' },
      paint: { type: 'string', description: 'Frame path such as frames[blink]; value: [{x, y, color}] canvas pixels after all layers (transparent erases).' },
      grid: { type: 'string', description: 'Frame path; value: {x, y, rows, erase?, mask?}, dots keep pixels.' },
      move: { type: 'string', description: 'Frame path; value: {x, y, w, h, dx, dy, mask?}.' },
      recolor: { type: 'string', description: 'Frame path; value: {x, y, w, h, from, to, mask?}.' },
      cleanup: { type: 'string', description: 'Frame path; value: {corners?, strays?, x?, y?, w?, h?, mask?, colors?}. Proposes fixes for doubled corners and stray pixels; check the report.' },
      scope: { enum: ['frame', 'inherited'], description: 'Canvas edits: inherited (default), or frame to leave frames that inherit it unchanged.' },
      value: {}
    }, additionalProperties: false } },
    overlay: { type: 'object', description: 'A saved pixelforge-overlay to apply instead of changes.' }
  } };
  const tools = [
    { name: 'pixel_help', description: 'Start here before drawing pixel art, sprites, tiles, icons, effects or animations. Returns a short quick start: the recipe format, the operations, the tools and the workflow. Pass a topic only when you need more: presets (ready-made fire, smoke, explosions, spells, characters and more to compile instead of drawing, a line each, or with find: "fire" only the ones those words match; full: true adds their animations), preset with name (one preset\'s source), guide (the full authoring reference and every tool option), workflow (art workflow: poses, scenes, particles, fluids, lighting), craft (short checklists: characters, effects, tiles and scenes, delivery, limits; all three list their sections, and name returns one or what mentions a word), schema (the recipe JSON Schema), example (a complete recipe), or poses, scenes, autotile, fx, fluid, wave, crystal, bodies or normals for those source formats\' schemas.', inputSchema: { type: 'object', properties: { topic: { enum: TOPICS }, name: { type: 'string', description: 'With topic preset: which one; with guide, workflow or craft: a section heading, or a word to find; with a schema: a path such as effects.bodies, or all.' }, full: { type: 'boolean', description: 'With topic presets: each preset\'s file and animations too.' }, find: { type: 'string', description: 'With topic presets: only the presets these words match.' } }, additionalProperties: false }, annotations: { title: 'Pixelbolt guide and schema', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'pixel_validate', description: 'Check a pixel art recipe for mistakes before inspecting or exporting it. Returns its revision id, size, frame timing, animations and clipping, without images or files.', inputSchema: validateInput, annotations: { title: 'Validate a pixel art recipe', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'pixel_inspect', description: 'Look at pixel art, a sprite or an animation frame by frame to check how it looks, without exporting. Returns a PNG contact sheet of every frame (or the chosen frames, or one animation in playback order) with each cell\'s name and duration. grid: true adds palette-key text grids for exact pixels, region zooms in, and view picks a tile, onion or motion review. Use this while iterating; call pixel_render to export.', inputSchema: inspectInput, annotations: { title: 'Inspect pixel art frames', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'pixel_patch', description: 'Fix or tweak pixel art (one pixel, a colour, a frame or its timing) without redrawing it. Pass revision or project plus changes applied in order, such as {"set": "frames[blink].duration", "value": 120} or {"paint": "frames[blink]", "value": [{"x": 9, "y": 7, "color": "k"}]}; other paths look like palette.k or frames[blink].layers[body].ops[2].x2, and [*] is every item of a list (frames[*].layers[cape].palette recolours one layer in every frame). The patch is atomic and must validate. Returns the new revision, every frame whose pixels changed and a before/after PNG.', inputSchema: patchInput, annotations: { title: 'Patch pixel art', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'pixel_render', description: 'Export pixel art as game-ready files: sprite sheet, sprites, animations, GIFs or frames for a video. Writes a PNG sheet, atlas JSON, Godot 4 SpriteFrames (and, for an autotile set, a Godot TileSet and a Tiled tileset), frame PNGs, APNGs, CSS and a Canvas player to a new folder in the export directory, and returns the key files, a check of what was delivered and a contact sheet. Pass expect with what the user asked for, then fix every problem the check lists before handing the files on. Pass saveAs to also write files where the user asked.', inputSchema: renderInput, annotations: { title: 'Export pixel art files', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
    { name: 'pixel_compile', description: 'Build a character animation from parts (bipeds and four-legged animals, with idle, walk, trot, run, jump, attack and hurt templates, squash and tweens), a terrain tileset, particle effects (sparks, embers, dust, a sprite dissolving or teleporting away pixel by pixel) and spell shapes (slashes, shockwave rings, beams, lightning, magic circles, impact stars, fireballs, cel water streams and drops, auras hugging a sprite, smears trailing a sword tip), simulated smoke, fire, explosions, steam, magic swirls, water (splashes, waterfalls, drips, bubbling potions) and thick liquids (honey, slime, mud), rigid bodies (balls and blocks that bounce, stack, topple and rest, with joints, ropes and cloth), growing crystals (quartz clusters, geodes, cubes, snowflakes), falling-sand sandboxes (burning, collapse, lava meeting water, blasts), coherent interference and portal loops, or a lighting normal map. Compiles the source into an ordinary recipe revision and returns a contact sheet; metadata: true adds pose joints, contacts and timing, the autotile mask table, particle counts, fluid figures, wave counts, crystal counts, body paths, joint breaks, cloth tears or normal directions.', inputSchema: { type: 'object', properties: { source: { type: 'object', description: 'A pixelforge-poses, pixelforge-autotile, pixelforge-fx, pixelforge-fluid, pixelforge-wave, pixelforge-crystal, pixelforge-powder, pixelforge-bodies or pixelforge-normals document (see pixel_help topics). A normals source\'s recipe, or an fx symbol\'s {recipe, frame}, may be inline, a file under the server root or {"revision": id}.' }, preset: { type: 'string', description: 'Instead of source: a shipped preset by name, such as "smoke-puff" (pixel_help topic presets).' }, size: { type: 'string', description: 'A canvas size such as "32x32" for the compiled drawing: cut to the window holding the most of it, or given margins; never scaled.' }, frames: { type: 'integer', minimum: 1, maximum: 256, description: 'Keep this many evenly spaced frames of each animation that has more, playing as long as before. The way to fewer frames: lowering frames in a source cuts the effect short.' }, animation: { type: ['string', 'array'], items: { type: 'string' }, description: 'Keep only this animation (or these) of a source or preset that makes several.' }, metadata: { type: 'boolean' }, draftViews: { type: 'object', additionalProperties: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 359 }, maxItems: 16 }, description: 'Poses only, instead of compiling: draft grid parts turned to these angles, {"boot": [30, 330]}, as views to correct and paste into parts.<name>.views, with a comparison sheet.' }, sequence: { type: 'object', required: ['fps'], description: 'Bodies only: write numbered PNG video frames (pixel_render\'s sequence options, animation naming the effect) instead of a recipe; a match may run past 256 frames.' } }, additionalProperties: false }, annotations: { title: 'Compile poses, tilesets, effects or fluids', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    { name: 'pixel_scene', description: 'Compose a pixel art scene or room from sprites, tilemaps and lighting. Renders a pixelforge-scene manifest (placements, autotiled tilemaps, cues, motion, ground sorting, camera and parallax, haze, lights and shadows; pixel_help topic scenes) at a time in milliseconds and returns the image, placements, lights and warnings. Assets may be inline recipes, files under the server root or {"revision": id}. view: depth shows who covers whom; export: true writes a replayable scene bundle.', inputSchema: { type: 'object', properties: { scene: { type: 'object' }, time: { type: 'integer', minimum: 0, maximum: 60000 }, lit: { type: 'boolean' }, density: { type: 'boolean' }, view: { enum: ['color', 'grayscale', 'depth'] }, guides, scale: { type: 'integer', minimum: 1, maximum: 8 }, export: { type: 'boolean' }, sequence: { type: 'object', required: ['fps'], description: 'Also write numbered PNG frames for a video editor: pixel_render\'s sequence options, without animation and step.' } }, required: ['scene'], additionalProperties: false }, annotations: { title: 'Compose a pixel art scene', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    { name: 'pixel_import', description: 'Turn existing pixel art or a sprite sheet PNG into an editable recipe. Import a native-resolution PNG (RGB, RGBA, greyscale or indexed, up to 8 bits per channel; a sprite sheet sliced by its unscaled atlas, or by frame, the size of one frame) as an editable recipe without changing any pixel. Pass data (base64 PNG) or path (inside the server root). Saves the recipe as a revision.', inputSchema: { type: 'object', properties: { data: { type: 'string', description: 'Base64 PNG bytes.' }, path: { type: 'string', description: 'PNG file path relative to the server root.' }, name: { type: 'string' }, atlas: { type: 'object' }, frame: { type: 'string', description: 'A sheet with no atlas: the size of one frame, such as "24x24".' }, padding: { type: 'integer', minimum: 0, maximum: 64, description: 'With frame: the empty border round each frame; found when left out.' } }, additionalProperties: false }, annotations: { title: 'Import a PNG as a recipe', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
  ];
  const host = createToolHost({ directory: path.resolve(directory), root: path.resolve(root), version, timeLimit, memoryLimit });
  const send = value => output.write(JSON.stringify(value) + '\n');
  let initialized = false, ui = false, protocol = versions[0];
  // One request, already parsed and checked by receive(), answered in arrival order.
  async function handle(request, signal) {
    const { id, method, params } = request;
    const error = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
    const result = value => send({ jsonrpc: '2.0', id, result: value });
    if (method === 'initialize') {
      if (!params || typeof params.protocolVersion !== 'string') { error(-32602, 'protocolVersion is required'); return; }
      // The first initialize settles the session. A repeat is answered as the first was, so what the client has been
      // told since (its tool list, whether the viewer is there) still holds.
      if (!initialized) {
        initialized = true;
        const mimeTypes = params.capabilities?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes;
        ui = Array.isArray(mimeTypes) && mimeTypes.includes(UI_MIME);
        if (versions.includes(params.protocolVersion)) protocol = params.protocolVersion;
      }
      result({ protocolVersion: protocol, capabilities: { tools: {}, ...(ui && { resources: {} }) }, serverInfo: { name: 'pixelbolt', version }, instructions: 'Use Pixelbolt when the user wants pixel art: sprites and sprite sheets, tiles and tilesets, icons, pixel effects (fire, smoke, explosions, water, sparks) or short frame animations for a game or a video, saved as PNG, GIF, APNG or numbered frames. Do not use it for photos, vector logos or full-resolution illustrations. It runs locally, with no account and no API key. Call pixel_help for the JSON format. Use small grids and reusable symbols. Send a full recipe once; every response returns a revision id to use instead of project afterwards. Call pixel_inspect to see every frame (grid: true reads exact pixels), pixel_patch to make targeted edits and check what changed, and pixel_render to export game-ready files: pass it expect (what the user asked for) and fix what its check reports. pixel_compile builds recipes from pose sources, autotile templates, particle and spell-shape effect sources, fluid sources (smoke, fire, explosions, magic, water), rigid-body sources (bouncing, toppling, territory matches) and normals sources (lighting passes derived from a colour recipe); start fire, smoke, explosions, splashes and spells from a preset (pixel_help topic presets, then pixel_compile with preset, plus size and frames for the canvas and frame count asked for). pixel_scene reviews assets together.' }); return;
    }
    if (!initialized) { error(-32000, 'Initialize the server first'); return; }
    if (method === 'tools/list') { result({ tools: ui ? tools.map(tool => pictureTools.has(tool.name) ? { ...tool, _meta: { ui: { resourceUri: UI_URI }, 'ui/resourceUri': UI_URI } } : tool) : tools }); return; }
    if (ui && method === 'resources/list') { result({ resources: [{ uri: UI_URI, name: 'Pixelbolt viewer', description: 'Play and inspect pixel art frames and animations.', mimeType: UI_MIME }] }); return; }
    if (ui && method === 'resources/templates/list') { result({ resourceTemplates: [] }); return; }
    if (ui && method === 'resources/read') {
      if (params?.uri !== UI_URI) { error(-32002, 'Resource not found'); return; }
      const { viewerHTML } = await import('./mcp-app.js');
      // A host border separates the player controls from chat; omitted CSP means no network access is needed.
      result({ contents: [{ uri: UI_URI, mimeType: UI_MIME, text: viewerHTML(version), _meta: { ui: { prefersBorder: true } } }] }); return;
    }
    if (method !== 'tools/call') { error(-32601, `Unknown method: ${method}`); return; }
    const tool = tools.find(t => t.name === params?.name);
    if (!tool) { error(-32602, 'Unknown tool'); return; }
    let args = params.arguments ?? {}, parsed;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) { error(-32602, 'Invalid tool arguments: expected an object'); return; }
    // An option the tool lacks is named, with the ones it has: an agent that guessed one reads what to use instead.
    const unknown = Object.keys(args).filter(key => !Object.hasOwn(tool.inputSchema.properties, key));
    if (unknown.length) { error(-32602, `Invalid tool arguments: ${tool.name} has no option ${unknown.map(key => JSON.stringify(key)).join(', ')}; its options are ${Object.keys(tool.inputSchema.properties).join(', ')}`); return; }
    try { ({ args, parsed } = parseTextArguments(args, tool.inputSchema.properties)); } catch (cause) { result({ isError: true, content: [textContent({ error: cause.message, path: cause.path })] }); return; }
    if (deeperThan(args, MAX_ARGUMENT_DEPTH)) { error(-32602, `Invalid tool arguments: nested more than ${MAX_ARGUMENT_DEPTH} levels deep`); return; }
    let reply;
    try { reply = await host.run(params.name, args, signal, ui); } catch (cause) { error(-32603, `Internal error: ${cause.message}`); return; }
    // A cancelled call gets no response: the client has stopped waiting for it (MCP cancellation).
    if (signal.aborted) return;
    result(parsed.length ? { ...reply, content: [...reply.content, textContent({ note: `${parsed.join('; ')}. Send JSON values as they are, not inside strings.` })] } : reply);
  }
  // Requests are answered one at a time in arrival order, so initialization comes first and two calls never share
  // memory. Only ping and cancellations skip the queue, so a client can check the server and stop a call while one
  // runs. `waiting` holds the requests queued or running, oldest first.
  const waiting = [];
  let queuedBytes = 0, last = Promise.resolve();
  function enqueue(id, method, bytes, work) {
    const entry = { id, method, bytes, controller: new AbortController() }, { signal } = entry.controller;
    waiting.push(entry); queuedBytes += bytes;
    // No request may end the server: anything work() didn't answer is answered here, and the next one runs.
    entry.done = last = last.then(() => signal.aborted ? undefined : work(signal))
      .catch(cause => { if (!signal.aborted) send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: `Internal error: ${cause.message}` } }); })
      .finally(() => { waiting.splice(waiting.indexOf(entry), 1); queuedBytes -= bytes; });
  }
  const reply = (bytes, message) => enqueue(undefined, undefined, bytes, () => send(message));
  function receive(line, bytes) {
    let request;
    try { request = JSON.parse(line); } catch { reply(bytes, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || ('id' in request && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isFinite(request.id)))) {
      reply(bytes, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (!Object.hasOwn(request, 'id')) {
      // A cancelled request still waiting is skipped; a running one is stopped. initialize can't be cancelled.
      const target = request.method === 'notifications/cancelled' ? request.params?.requestId : undefined;
      if (typeof target === 'string' || typeof target === 'number') for (const entry of waiting) if (entry.id === target && entry.method !== 'initialize') entry.controller.abort();
      return;
    }
    if (request.method === 'ping') { send({ jsonrpc: '2.0', id: request.id, result: {} }); return; }
    enqueue(request.id, request.method, bytes, signal => handle(request, signal));
  }
  const tooLarge = prefix => reply(0, { jsonrpc: '2.0', id: leadingId(prefix), error: { code: -32600, message: `Request exceeds ${MAX_REQUEST_BYTES} bytes. Send a recipe once and reuse its revision id, or split the work.` } });
  input.setEncoding('utf8');
  let pending = '', discarding = null;
  // An oversized line is answered with an error and skipped up to its newline; the server keeps serving.
  for await (const chunk of input) {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, ''), bytes = Buffer.byteLength(line); pending = pending.slice(newline + 1);
      if (discarding !== null) { tooLarge(discarding); discarding = null; continue; }
      if (bytes > MAX_REQUEST_BYTES) { tooLarge(line.slice(0, 4096)); continue; }
      if (line.trim()) receive(line, bytes);
      // Reading pauses while more than one request's worth waits, so a client can't queue without bound. ping and
      // cancellations sent meanwhile are read once the queue is short again.
      while (queuedBytes > MAX_REQUEST_BYTES || waiting.length > MAX_WAITING) await waiting[0].done;
    }
    if (Buffer.byteLength(pending) > MAX_REQUEST_BYTES) { if (discarding === null) discarding = pending.slice(0, 4096); pending = ''; }
  }
  if (discarding !== null) tooLarge(discarding);
  else if (pending.trim()) receive(pending, Buffer.byteLength(pending));
  await last;
  await host.close();
}
