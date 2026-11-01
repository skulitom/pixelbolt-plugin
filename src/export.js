import { renderProject, buildAtlas, scalePixels, PixelError } from './core.js';
import { encodePNG, encodeAPNG, crc32 } from './png.js';
import { readFile, readdir, mkdir, writeFile, access, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { embedRecipe, recipeKind } from './share.js';
import { spriteFrames, tileSet } from './godot.js';
import { autotileFrames } from './autotile.js';

const json = value => JSON.stringify(value, null, 2) + '\n';
// Compact, deterministic JSON for generated recipes: any object or array that fits within `width` columns stays on one
// line and larger ones open one entry per line, so frames and operations read as single lines. Pixel grids (symbol
// rows, grid and rule rows, templates, masks) always keep one row per line, so the art stays visible as text. Parses
// back to the same value as JSON.stringify.
const GRID_KEYS = new Set(['rows', 'template', 'match', 'replace', 'mask', 'directions']);
export function formatJSON(value, width = 120) {
  const entries = object => Object.entries(object).filter(([, v]) => v !== undefined);
  const inline = v => Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
    : v !== null && typeof v === 'object' ? (entries(v).length ? `{ ${entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}')
    : JSON.stringify(v);
  // A grid is an array of several strings under a grid key, or any value of a `symbols` map. `key` is the value's own
  // key and `parent` its container's key.
  const hasGrid = (v, key, parent) => {
    if (v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return ((GRID_KEYS.has(key) || parent === 'symbols') && v.length > 1 && v.every(row => typeof row === 'string')) || v.some(x => hasGrid(x, null, key));
    return entries(v).some(([k, x]) => hasGrid(x, k, key));
  };
  const format = (v, indent, lead, key, parent) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const flat = inline(v);
    if (!hasGrid(v, key, parent) && indent.length + lead + flat.length <= width) return flat;
    const inner = `${indent}  `;
    if (Array.isArray(v)) return v.length ? `[\n${v.map(x => inner + format(x, inner, 0, null, key)).join(',\n')}\n${indent}]` : '[]';
    return `{\n${entries(v).map(([k, x]) => { const label = `${JSON.stringify(k)}: `; return inner + label + format(x, inner, label.length, k, key); }).join(',\n')}\n${indent}}`;
  };
  return format(value, '', 0, null, null) + '\n';
}
export function generateCSS(project, atlas) {
  // A trimmed atlas cannot back a fixed-size element without showing neighbouring frames, so trimmed recipes
  // switch between the full-canvas frame PNGs instead of sliding a background position.
  const trimmed = Boolean(project.sheet.trim), size = `width: ${project.width * project.sheet.scale}px; height: ${project.height * project.sheet.scale}px;`;
  const image = frame => `background-image: url("frames/${frame.name}.png");`;
  const place = frame => { const rect = atlas.metadata.frames[frame.name].frame; return `background-position: -${rect.x}px -${rect.y}px;`; };
  const show = trimmed ? image : place;
  const lines = [`/* Pixelbolt: ${trimmed ? 'frames switch between the full-canvas images in frames/.' : 'atlas coordinates are pixels at the exported scale.'} */`, `.pf-${project.name} {`, `  display: inline-block;`, `  ${size}`, trimmed ? `  ${image(project.frames[0])}` : `  background-image: url("${project.name}.png");`, `  background-repeat: no-repeat; image-rendering: pixelated;`, `}`];
  for (const [key, anim] of Object.entries(project.animations)) {
    const id = `pf-${project.name}-${key}`;
    lines.push(`.${id} { ${show(project.frames[anim.frames[0]])} animation: ${id} ${anim.duration}ms steps(1, end) ${anim.loop ? 'infinite' : '1 forwards'}; }`, `@keyframes ${id} {`);
    let elapsed = 0;
    for (const index of anim.frames) {
      const f = project.frames[index];
      lines.push(`  ${Number((elapsed / anim.duration * 100).toFixed(8))}% { ${show(f)} }`);
      elapsed += f.duration;
    }
    lines.push(`  100% { ${show(project.frames[anim.loop ? anim.frames[0] : anim.frames.at(-1)])} }`, `}`);
  }
  lines.push('@media (prefers-reduced-motion: reduce) {', ...Object.keys(project.animations).map(key => `  .pf-${project.name}-${key} { animation: none; }`), '}');
  return lines.join('\n') + '\n';
}
export async function createBundle(spec) {
  const project = renderProject(spec);
  const { width, height, sheet, frames, name } = project;
  const animationPixels = Object.values(project.animations).reduce((sum, a) => sum + a.frames.length * width * height * sheet.scale ** 2, 0);
  if (animationPixels > 67108864) throw new PixelError('project.animations', 'export exceeds 67,108,864 animation pixels; shorten sequences or reduce scale');
  const atlas = buildAtlas(project);
  const files = new Map();
  files.set(`${name}.png`, encodePNG(atlas.data, atlas.width, atlas.height));
  files.set(`${name}.atlas.json`, Buffer.from(json(atlas.metadata)));
  const godot = spriteFrames(atlas.metadata);
  files.set(`${name}.tres`, Buffer.from(godot.text));
  if (godot.approximate.length) project.warnings.push(`${name}.tres: the frame times of ${godot.approximate.length === 1 ? 'animation' : 'animations'} ${godot.approximate.slice(0, 8).join(', ')}${godot.approximate.length > 8 ? ', …' : ''} share no step of 9 ms or more, so Godot gets fractional frame durations, kept as 32-bit floats: each frame plays within a ten-millionth of its length. Frame times in multiples of 10 ms are exact.`);
  const tiles = godotTiles(spec, project, atlas);
  if (tiles) files.set(`${name}.tileset.tres`, Buffer.from(tiles));
  files.set(`${name}.pixel.json`, Buffer.from(json(spec)));
  files.set(`${name}.css`, Buffer.from(generateCSS(project, atlas)));
  const scaledFrames = frames.map(f => ({ ...f, data: scalePixels(f.data, width, height, sheet.scale) }));
  for (const frame of scaledFrames) files.set(`frames/${frame.name}.png`, encodePNG(frame.data, width * sheet.scale, height * sheet.scale));
  // Browsers play an animation frame of 10 ms or less at 100 ms, ten times too slow, so the APNGs give such frames
  // 11 ms, the shortest that plays as written. The atlas, CSS and Canvas player keep the exact durations.
  const raised = new Set();
  for (const [key, anim] of Object.entries(project.animations)) files.set(`animations/${key}.png`, encodeAPNG(anim.frames.map(i => {
    const frame = scaledFrames[i];
    if (frame.duration > 10) return frame;
    raised.add(frame.name);
    return { ...frame, duration: 11 };
  }), width * sheet.scale, height * sheet.scale, anim.loop));
  if (raised.size) project.warnings.push(`${raised.size} frame${raised.size === 1 ? '' : 's'} of 10 ms or less (${[...raised].slice(0, 8).join(', ')}${raised.size > 8 ? ', …' : ''}) last 11 ms in the animated PNGs: browsers play such short frames at 100 ms. The atlas, CSS and player keep the exact durations.`);
  files.set('player.js', await readFile(new URL('./runtime.js', import.meta.url)));
  files.set('preview.html', Buffer.from(previewHTML(project)));
  files.set('README.txt', Buffer.from(`${name} — Pixelbolt export\n\n${name}.png: transparent RGBA sprite sheet\n${name}.atlas.json: TexturePacker-style frames, named animation sequences and Aseprite-style frame tags\n${name}.tres: Godot 4 SpriteFrames; it finds ${name}.png in its own folder, so keep the two together\n${tiles ? `${name}.tileset.tres: Godot 4 TileSet with a terrain for painting this autotile set; it also finds ${name}.png in its own folder\n` : ''}${name}.css: CSS classes with per-frame timing\nframes/: individual PNGs\nanimations/: animated PNGs (APNG)\n${name}.pixel.json: editable source\nplayer.js: dependency-free Canvas player\npreview.html: open directly in a browser, or serve this folder\n\nCanvas: import { SpritePlayer } from './player.js';\nconst player = await SpritePlayer.load(canvas, './${name}.atlas.json');\nplayer.play('${Object.keys(project.animations)[0]}');\n\nGodot 4: copy ${name}.png and ${name}.tres into one folder of your project, give an AnimatedSprite2D the Sprite Frames ${name}.tres and play("${Object.keys(project.animations)[0]}"). Set the node's Texture Filter to Nearest for crisp pixels.\n\nCSS: <link rel="stylesheet" href="${name}.css">\n<span class="pf-${name} pf-${name}-${Object.keys(project.animations)[0]}"></span>\n`));
  // A forced export over an earlier export of this recipe removes the frame and animation PNGs that export's atlas
  // lists and this one no longer has. Another recipe's export in the same folder keeps its PNGs, and so does a PNG
  // put in frames/ by hand.
  return { project, atlas, files, owns: { marker: `${name}.atlas.json`, folders: ['frames', 'animations'], match: /^(?:frames|animations)\/[^/]+\.png$/, listed: atlasFiles, peers: /\.atlas\.json$/ } };
}
// A Godot TileSet for a recipe whose frames are an autotile set (at least two masks), or null. Its warnings join the
// project's. The terrain's editor colour is the commonest opaque colour of the fullest tile.
function godotTiles(spec, project, atlas) {
  const tiles = autotileFrames(spec), { name, sheet } = project;
  if (new Set(tiles.map(tile => tile.mask)).size < 2) return null;
  if (sheet.trim) {
    project.warnings.push(`${name}.tileset.tres: not written: a Godot TileSet needs the sheet's grid, and sheet.trim packs frames without one. Remove sheet.trim to get it`);
    return null;
  }
  const fullest = tiles.reduce((best, tile) => (popcount(tile.mask) > popcount(best.mask) ? tile : best));
  const data = project.frames.find(frame => frame.name === fullest.frame).data, counts = new Map();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255) { const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]; counts.set(key, (counts.get(key) ?? 0) + 1); }
  const top = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best), [0xffffff, 0])[0];
  const result = tileSet(atlas.metadata, tiles, { name, color: [top >> 16, (top >> 8) & 255, top & 255], margin: sheet.padding * sheet.scale, separation: sheet.padding * 2 * sheet.scale });
  project.warnings.push(...result.warnings.map(warning => `${name}.tileset.tres: ${warning}`));
  return result.text;
}
const popcount = mask => { let bits = 0; for (let m = mask; m; m &= m - 1) bits++; return bits; };
// The frame and animation PNGs an export wrote, as its atlas metadata names them. Anything else lists nothing.
const keysOf = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);
const atlasFiles = metadata => [...keysOf(metadata?.frames).map(frame => `frames/${frame}.png`), ...keysOf(metadata?.animations).map(key => `animations/${key}.png`)];
function previewHTML(project) {
  const { name, animations } = project;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${name} · Pixelbolt</title><link rel="stylesheet" href="${name}.css"><style>body{font:16px system-ui;background:#17191d;color:#e6e7eb;margin:48px}main{display:flex;gap:32px;flex-wrap:wrap}figure{margin:0;padding:24px;background:#252930;border-radius:12px}img{width:${project.width * Math.min(8, Math.max(1, Math.floor(256 / project.width)))}px;image-rendering:pixelated}figcaption{margin-top:20px}a{color:#c4b9f3}</style><h1>${name}</h1><p>Animated PNGs. Original frame timing and transparency are preserved.</p><main>${Object.keys(animations).map(key => `<figure><img src="animations/${key}.png" alt="${key} animation"><figcaption>${key}</figcaption></figure>`).join('')}</main><p><a href="${name}.png">Sprite sheet</a> · <a href="${name}.atlas.json">Atlas metadata</a> · <a href="${name}.pixel.json">Editable source</a></p></html>`;
}

// Store-mode ZIP keeps the already-compressed PNGs intact and needs no dependency.
export function createZip(files) {
  if (!(files instanceof Map)) throw new PixelError('zip', 'expected a Map of filenames to byte buffers');
  if (files.size > 65535) throw new PixelError('zip', 'ZIP32 supports at most 65,535 entries; split the bundle into smaller archives');
  // Reject before checksumming or allocating any archive buffers.
  let localSize = 0, directorySize = 0;
  for (const [filename, data] of files) {
    if (typeof filename !== 'string' || !(data instanceof Uint8Array)) throw new PixelError('zip', 'entries require string filenames and byte buffers');
    const length = Buffer.byteLength(filename);
    if (!length || length > 65535) throw new PixelError('zip', 'filenames must contain 1–65,535 UTF-8 bytes');
    localSize += 30 + length + data.length; directorySize += 46 + length;
    if (localSize + directorySize + 22 > 0xffffffff) throw new PixelError('zip', 'archive exceeds the ZIP32 byte budget; split the bundle');
  }
  const local = [], central = [];
  let offset = 0;
  for (const [filename, data] of files) {
    const name = Buffer.from(filename), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
// Opt-in post-pass: keep all existing chunks, and leave a scene's asset passes alone. A video sequence shares one buffer
// between the frames a pose is held for, so each distinct buffer is embedded once and stays shared.
export async function embedBundleRecipe(bundle, recipe, version) {
  const scene = recipeKind(recipe) === 'scene', embedded = new Map();
  for (const [name, bytes] of bundle.files) {
    if (!(scene ? name === 'scene.png' || name === 'unlit.png' : name.endsWith('.png'))) continue;
    if (!embedded.has(bytes)) embedded.set(bytes, await embedRecipe(bytes, recipe, version));
    bundle.files.set(name, embedded.get(bytes));
  }
}
// Windows and macOS file systems ignore case by default, so `Hero.pixel.json` and `hero.pixel.json` are one file there.
const folded = process.platform === 'win32' || process.platform === 'darwin';
const fileKey = name => (folded ? name.toLowerCase() : name);
// The bundle files that would land on one of `inputs` (the recipe and the files it references). Even --force never
// writes over them: `render hero.json --out .` would otherwise replace hero.json with its own inlined copy.
function inputCollisions(bundle, root, inputs) {
  const names = new Map([...bundle.files.keys()].map(name => [fileKey(name), name]));
  return inputs.flatMap(input => {
    const relative = path.relative(root, path.resolve(input));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
    const name = names.get(fileKey(relative.split(path.sep).join('/')));
    return name === undefined ? [] : [name];
  });
}
// The `targets` (absolute paths) that are one of `inputs` on disk, however they are spelled: the same file under a
// short 8.3 name, through a symbolic link or junction, in other letter case, or as another hard link. A target that
// doesn't exist can't be an input. File identity decides where the file system reports one; real paths elsewhere.
export async function sameFiles(targets, inputs) {
  const identityOf = info => (info.ino ? `${info.dev}:${info.ino}` : null), realOf = async file => fileKey(await realpath(file).catch(() => path.resolve(file)));
  const sources = (await Promise.all(inputs.map(async file => {
    const info = await stat(file, { bigint: true }).catch(() => null);
    return info && { id: identityOf(info), real: await realOf(file) };
  }))).filter(Boolean);
  if (!sources.length) return [];
  const ids = new Set(sources.map(source => source.id)), reals = new Set(sources.map(source => source.real)), found = [];
  const same = async target => {
    const info = await stat(target, { bigint: true }).catch(() => null);
    if (!info) return false;
    const id = identityOf(info);
    return id !== null && !ids.has(null) ? ids.has(id) : reals.has(await realOf(target));
  };
  // A few hundred at a time: a long sequence has thousands of frames to check.
  for (let start = 0; start < targets.length; start += 256) {
    const batch = targets.slice(start, start + 256), results = await Promise.all(batch.map(same));
    found.push(...batch.filter((_, index) => results[index]));
  }
  return found;
}
// What an earlier export of the same thing left in this folder that this one does not write: a longer sequence's
// later frames, or a renamed frame's or animation's PNG. Only a bundle that declares `owns` has any, and only when the
// folder holds that bundle's own index file (`owns.marker`), which shows the earlier export was this kind. Nothing
// outside `owns.folders` that fails `owns.match` is ever listed. Where `owns.listed` reads the files an export wrote
// from its marker, only files the earlier marker lists are leftovers, and none that another export's marker in the
// folder (`owns.peers`) lists: a sprite's frames are not another sprite's to remove. When the marker or a peer can't
// be read, what it lists is unknown, so nothing goes.
async function leftovers(bundle, root) {
  const { owns } = bundle;
  if (!owns) return [];
  try { await access(path.join(root, owns.marker)); } catch { return []; }
  let earlier = null, others = [];
  if (owns.listed) {
    const listing = async file => { try { return owns.listed(JSON.parse(await readFile(path.join(root, file), 'utf8'))); } catch { return null; } };
    earlier = await listing(owns.marker);
    if (!earlier?.length) return [];
    // The marker under another spelling, where the folder ignores case, is the earlier export's own, not a peer's.
    const peers = [];
    for (const file of await readdir(root).catch(() => [])) if (owns.peers.test(file) && file !== owns.marker && !await oneFile(root, file, owns.marker)) peers.push(file);
    const listings = await Promise.all(peers.map(listing));
    if (listings.includes(null)) return [];
    others = listings.flat();
  }
  // Pixelbolt writes these extensions exactly, so a photo.PNG of someone else's beside them is never taken for one.
  const extensions = new Set([...bundle.files.keys()].map(name => path.posix.extname(name))), found = [];
  for (const folder of owns.folders) {
    let entries;
    try { entries = (await readdir(path.join(root, folder), { withFileTypes: true })).filter(entry => entry.isFile()); } catch { continue; }
    // Where this folder ignores letter case, an earlier export's frames/Run.png is this export's frames/run.png, not a
    // leftover, and an earlier Coin-Spin sequence's frames are this coin-spin's to remove.
    const sample = entries.find(entry => entry.name !== swapCase(entry.name));
    const caseless = folded && sample !== undefined && await oneFile(path.join(root, folder), sample.name, swapCase(sample.name));
    const key = caseless ? name => name.toLowerCase() : name => name, keys = new Set([...bundle.files.keys()].map(key));
    const match = caseless && !owns.match.flags.includes('i') ? new RegExp(owns.match.source, `${owns.match.flags}i`) : owns.match;
    const wrote = earlier && new Set(earlier.map(key)), kept = new Set(others.map(key));
    for (const entry of entries) {
      const name = folder === '.' ? entry.name : `${folder}/${entry.name}`;
      if (extensions.has(path.posix.extname(name)) && match.test(name) && !keys.has(key(name)) && (!wrote || wrote.has(key(name))) && !kept.has(key(name))) found.push(name);
    }
  }
  return found.sort();
}
const swapCase = name => [...name].map(char => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join('');
// Whether two names in `folder` are one file, as they are where the folder ignores letter case. Windows and macOS
// ignore it by default, but a folder can be case-sensitive (Windows' per-folder setting, a case-sensitive APFS
// volume), and there Run.png and run.png are two files. File identity decides; where a file system reports none,
// the name the real path ends in.
async function oneFile(folder, name, other) {
  const [a, b] = await Promise.all([name, other].map(entry => stat(path.join(folder, entry), { bigint: true }).catch(() => null)));
  if (!a || !b) return false;
  if (a.ino && b.ino) return a.dev === b.dev && a.ino === b.ino;
  return path.basename(await realpath(path.join(folder, other)).catch(() => other)) === name;
}
// Existing files that are this export's under another letter case. Writing to one would keep the old spelling, so a
// frame renamed from Run to run would stay frames/Run.png: these are removed first. Only where the two names are one
// file: in a case-sensitive folder Hero.png is someone else's.
async function respelled(bundle, root) {
  if (!folded) return [];
  const listings = new Map(), found = [];
  for (const name of bundle.files.keys()) {
    const folder = path.posix.dirname(name), base = path.posix.basename(name), directory = path.join(root, folder);
    if (!listings.has(folder)) listings.set(folder, new Map((await readdir(directory).catch(() => [])).map(entry => [entry.toLowerCase(), entry])));
    const existing = listings.get(folder).get(base.toLowerCase());
    if (existing !== undefined && existing !== base && await oneFile(directory, existing, base)) found.push(folder === '.' ? existing : `${folder}/${existing}`);
  }
  return found;
}
// Writes a bundle into `directory`. Without `force`, any existing file stops the export before anything is written.
// With `force`, existing files are replaced and the earlier export's leftovers are removed after the new files are in
// place; the returned list of written paths then carries `removed`, the paths it deleted. `inputs` are never written.
// What a written bundle holds, for a reply: its files relative to `out`, without each frame (and each animation when
// there are more than 16) unless `listFiles`, and how many of those there are. Paths an export removed are relative too.
export function outputSummary(out, files, listFiles) {
  const relative = files.map(file => path.relative(out, file).split(path.sep).join('/'));
  const count = prefix => relative.filter(file => file.startsWith(`${prefix}/`)).length;
  const animations = count('animations');
  return {
    files: listFiles ? relative : relative.filter(file => !file.startsWith('frames/') && !(file.startsWith('animations/') && animations > 16)),
    frames: { directory: 'frames', count: count('frames') }, animations: { directory: 'animations', count: animations },
    ...(files.removed && { removed: files.removed.map(file => path.relative(out, file).split(path.sep).join('/')) })
  };
}

export async function writeBundle(bundle, directory, { force = false, inputs = [] } = {}) {
  const root = path.resolve(directory);
  const collisions = inputCollisions(bundle, root, inputs);
  if (collisions.length) throw new Error(`The export would replace its own input ${path.join(root, collisions[0])}. Choose another folder.`);
  const same = await sameFiles([...bundle.files.keys()].map(filename => path.join(root, filename)), inputs);
  if (same.length) throw new Error(`The export would replace its own input ${same[0]}. Choose another folder.`);
  // Preflight all output collisions before writing any artifact.
  if (!force) for (const filename of bundle.files.keys()) {
    try { await access(path.join(root, filename)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Output already exists: ${path.join(root, filename)}. Choose a new folder or pass --force.`);
  }
  const stale = force ? await leftovers(bundle, root) : [];
  if (force) for (const filename of await respelled(bundle, root)) await rm(path.join(root, filename), { force: true });
  await mkdir(root, { recursive: true });
  for (const [filename, data] of bundle.files) {
    const target = path.join(root, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: force ? 'w' : 'wx' });
  }
  for (const filename of stale) await rm(path.join(root, filename), { force: true });
  const written = [...bundle.files.keys()].map(filename => path.join(root, filename));
  return stale.length ? Object.assign(written, { removed: stale.map(filename => path.join(root, filename)) }) : written;
}
