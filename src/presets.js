// Node-side: the shipped examples an agent can start from instead of drawing an effect or a character from scratch.
// They are read from examples/ whenever they are asked for, so the listing always matches the folder. A preset is a
// top-level examples/*.fluid.json, *.fx.json, *.wave.json or *.poses.json source, or a plain recipe whose animations
// all loop (a coin spin, a flickering ember) and that no source there compiles to. Titles and notes come from the
// Fluid and Effects labs' lists where those have one; anything else is described from its own name and animations.
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PixelError, renderProject } from './core.js';
import { resolveReferences } from './resolve.js';
import { compilePoses } from './authoring.js';
import { compileEffects } from './fx.js';
import { compileFluid } from './fluid.js';
import { compileWaves } from './wave.js';
import { EFFECT_PRESETS } from '../studio/effects-controls.js';
import { FLUID_PRESETS } from '../studio/fluid-controls.js';

export const PRESET_FOLDER = fileURLToPath(new URL('../examples/', import.meta.url));
const SOURCE = /^(.+)\.(fluid|fx|wave|poses)\.json$/;
const COMPILERS = { 'pixelforge-fluid': compileFluid, 'pixelforge-fx': compileEffects, 'pixelforge-wave': compileWaves, 'pixelforge-poses': compilePoses };
const TITLES = new Map([...FLUID_PRESETS.map(entry => [`fluid:${entry.file}`, entry]), ...EFFECT_PRESETS.map(entry => [`fx:${entry.file}`, entry])]);

// How to use the listing, and the one way to get fewer frames: a source's own `frames` is its simulation or timeline
// length, so lowering it cuts the effect off before it ends instead of sampling it.
export const PRESET_GUIDE = 'Start fire, smoke, explosions, splashes, spells and other effects from one of these rather than drawing them: pixel_compile {"preset": "<name>"} compiles one as it ships (pixelbolt compile --preset <name> --out <new.json> from a shell), and pixel_help {"topic": "preset", "name": "<name>"} returns its source to edit and compile (a recipe preset is already a recipe: edit it and send it as project). Fluid presets are simulations: a liquid preset (honey, slime, water) is liquid falling, pouring or splashing, not a character; for a character\'s squash, stretch or breathing idle, compile a pixelforge-poses source with one mass body and motions.idle (example: slime-idle). For fewer frames, never lower the source\'s frames (that stops the effect before it ends): compile the preset, then, per animation, keep N evenly spaced frames with one pixel_patch call that removes the others and lists the kept ones in the animation. Of an animation\'s F frames (its entry under animations), keep frame floor(i x F / N) for i = 0 to N - 1; for a one-shot that must end on its last frame, keep round(i x (F - 1) / (N - 1)) instead. The quick start has the call for 8 of smoke-puff\'s 19.';

// What to do with a preset's source: a source compiles; a plain recipe already is one.
export const presetNext = (entry, shell = false) => entry.kind === 'recipe'
  ? (shell ? `It is already a recipe: save source to a file, edit it, then validate, inspect or render that file (pixelbolt compile --preset ${entry.name} --out <new.json> saves it as it ships).` : `It is already a recipe: edit source and send it as project to pixel_validate, pixel_inspect or pixel_render, or use pixel_compile {"preset": "${entry.name}"} for a revision of it as it ships.`)
  : (shell ? `Compile it as it ships with pixelbolt compile --preset ${entry.name} --out <new.json>, or save source to a file, edit it and compile that.` : `Compile it as it ships with pixel_compile {"preset": "${entry.name}"}, or edit source and send it as pixel_compile's source.`);

// The plain recipes are only known once read; each file is read once per call.
async function readJSON(file) {
  try { return JSON.parse((await readFile(path.join(PRESET_FOLDER, file), 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}
const loops = recipe => {
  if (!recipe || typeof recipe !== 'object' || recipe.format !== undefined || !Array.isArray(recipe.frames) || recipe.frames.length < 2) return false;
  const animations = recipe.animations && typeof recipe.animations === 'object' ? Object.values(recipe.animations) : [];
  return animations.length > 0 && animations.every(item => item && item.loop !== false && Array.isArray(item.frames) && item.frames.length > 1);
};

// Every preset file with its name: the file name without .json and the format word, or `<name>.<kind>` when two
// presets would share a name.
export async function presetEntries() {
  const files = (await readdir(PRESET_FOLDER, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
  const sources = files.flatMap(file => { const match = SOURCE.exec(file); return match ? [{ file, base: match[1], kind: match[2] }] : []; });
  const compiledTo = new Set(sources.map(entry => entry.base)), recipes = [];
  for (const file of files) {
    if (SOURCE.test(file) || compiledTo.has(file.slice(0, -5))) continue;
    const document = await readJSON(file);
    if (loops(document)) recipes.push({ file, base: file.slice(0, -5), kind: 'recipe', document });
  }
  const entries = [...sources, ...recipes].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : a.kind < b.kind ? -1 : 1));
  // Names are matched ignoring case, so two bases that differ only in case share a name too.
  const count = new Map(), key = entry => entry.base.toLowerCase();
  for (const entry of entries) count.set(key(entry), (count.get(key(entry)) ?? 0) + 1);
  return entries.map(entry => ({ ...entry, name: count.get(key(entry)) > 1 ? `${entry.base}.${entry.kind}` : entry.base }));
}

// The preset a name means: its name, `<name>.<kind>` or its file name (as the listing gives it, examples/ and all),
// ignoring case. Names are matched against the folder's own listing, never used as a path.
export async function findPreset(name, where = 'preset') {
  if (typeof name !== 'string' || !name.trim()) throw new PixelError(where, 'expected a preset name such as "smoke-puff"; pixel_help {"topic": "presets"} lists them');
  const wanted = name.trim().toLowerCase().replace(/^examples\//, ''), entries = await presetEntries();
  const found = entries.filter(entry => [entry.name, `${entry.base}.${entry.kind}`, entry.file].some(alias => alias.toLowerCase() === wanted));
  if (found.length === 1) return found[0];
  const shared = entries.filter(entry => entry.base.toLowerCase() === wanted);
  if (shared.length > 1) throw new PixelError(where, `"${name}" names ${shared.length} presets: use ${shared.map(entry => `"${entry.name}"`).join(' or ')}`);
  const near = entries.filter(entry => entry.name.toLowerCase().includes(wanted) || wanted.includes(entry.base.toLowerCase())).slice(0, 6);
  throw new PixelError(where, `no preset named "${name}"${near.length ? `; did you mean ${near.map(entry => `"${entry.name}"`).join(', ')}?` : '.'} pixel_help {"topic": "presets"} (pixelbolt presets in a shell) lists them`);
}

// A preset's source with the files it names (an fx symbol drawn from a pose source, say) inlined, so it compiles
// anywhere: as shipped, or edited and sent back as pixel_compile's source.
export async function loadPreset(entry) {
  const document = entry.document ?? await readJSON(entry.file);
  if (document === null) throw new PixelError('preset', `examples/${entry.file} could not be read`);
  const { document: resolved, files } = await resolveReferences(document, { baseDir: PRESET_FOLDER, root: PRESET_FOLDER });
  return { source: resolved, inlined: files.map(file => `examples/${path.relative(PRESET_FOLDER, file).split(path.sep).join('/')}`) };
}

// A plain recipe compiles to itself.
export function compilePreset(source) {
  const compile = COMPILERS[source?.format];
  return compile ? compile(source) : { recipe: source, warnings: [] };
}

const plays = animations => {
  const loops = animations.filter(([, item]) => item.loop).length;
  return loops === animations.length ? 'loop' : loops ? 'loops and one-shots' : 'one-shot';
};
const listNames = names => names.length <= 6 ? names.join(', ') : `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`;
function about(entry, source, animations) {
  const titled = TITLES.get(`${entry.kind}:${entry.base}`), names = animations.map(([name]) => name);
  if (entry.kind === 'fluid') {
    const liquid = Object.values(source.effects ?? {}).some(effect => effect?.kind === 'liquid');
    const kind = liquid ? 'A simulated liquid, not a character.' : 'A simulated gas.';
    return titled ? `${titled.title}: ${titled.note.toLowerCase()}.${liquid ? ` ${kind}` : ''}` : kind;
  }
  if (titled) return `${titled.title}: ${titled.note.toLowerCase()}.`;
  if (entry.kind === 'poses') {
    const templates = [...new Set(Object.values(source.motions ?? {}).map(motion => motion?.template).filter(Boolean))];
    return templates.length ? `A rig whose motion templates make ${listNames(templates)}.` : `Posed parts: ${listNames(names)}.`;
  }
  if (entry.kind === 'fx') return `Particles and effect shapes: ${listNames(names)}.`;
  if (entry.kind === 'wave') return `A looping wave pattern: ${listNames(names)}.`;
  return `A hand-drawn recipe: ${listNames(names)}.`;
}

// One line of facts per preset, from compiling it: what an agent compares with the request before picking one.
// Everything but the name, kind and file depends only on the engine and the preset's resolved source, so a cache
// (`store`, from openCache) keeps those facts under a key of both, and `fresh` says they were measured this time.
// With `measuring` false (past the listing's budget) only cached facts are used; `summary` is null without them.
const FACTS = ['for', 'size', 'frames', 'plays', 'colors', 'animations', 'moreAnimations'];
const isFacts = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => FACTS.includes(key))
  && typeof value.for === 'string' && typeof value.size === 'string' && Number.isInteger(value.frames) && typeof value.plays === 'string'
  && Number.isInteger(value.colors) && value.animations !== null && typeof value.animations === 'object' && !Array.isArray(value.animations);
async function summarize(entry, store, measuring = true) {
  const { source } = await loadPreset(entry), id = store?.key(entry, source), known = id === undefined ? undefined : store.cached[id], hit = isFacts(known);
  if (!hit && !measuring) return { summary: null };
  const facts = hit ? known : measure(entry, source);
  return { summary: { name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, ...facts }, id, facts, fresh: !hit };
}
function measure(entry, source) {
  const recipe = compilePreset(source).recipe, project = renderProject(recipe), colors = new Set();
  for (const frame of project.frames) for (let i = 0; i < frame.data.length; i += 4) if (frame.data[i + 3]) colors.add(((frame.data[i] << 24) | (frame.data[i + 1] << 16) | (frame.data[i + 2] << 8) | frame.data[i + 3]) >>> 0);
  const animations = Object.entries(project.animations), shown = animations.slice(0, 12);
  return {
    for: about(entry, source, animations),
    size: `${project.width}x${project.height}`, frames: project.frames.length, plays: plays(animations), colors: colors.size,
    animations: Object.fromEntries(shown.map(([name, item]) => [name, `${item.frames.length} frames, ${item.loop ? 'loop' : 'one-shot'}`])),
    ...(animations.length > shown.length && { moreAnimations: animations.length - shown.length })
  };
}

// The engine a listing is measured with: the package version and every file that can change a preset's facts (the
// compilers and renderer in src/, and the labs' lists the titles come from), so a cache never outlives an engine
// change, released or not. It is hashed when this module loads, which is when the running code was read, and again for
// each listing: if the files changed since (an update under a running server), this process runs the old code, so it
// neither reads nor writes the cache. Null when the files can't be read, which turns the cache off.
const ENGINE_FILES = [new URL('../package.json', import.meta.url), new URL('../studio/effects-controls.js', import.meta.url), new URL('../studio/fluid-controls.js', import.meta.url)];
async function engineFingerprint() {
  try {
    const src = fileURLToPath(new URL('./', import.meta.url)), files = (await readdir(src)).filter(name => name.endsWith('.js')).sort().map(name => path.join(src, name));
    const hash = createHash('sha256');
    for (const file of [...ENGINE_FILES.map(url => fileURLToPath(url)), ...files]) hash.update(`${path.basename(file)}\0`).update(await readFile(file)).update('\0');
    return hash.digest('hex');
  } catch { return null; }
}
const LOADED_ENGINE = engineFingerprint();

// The cache a listing reads and writes in `directory` (the MCP server's export directory gives `.presets` in it): one
// JSON file per engine, mapping a hash of each preset's resolved source to its facts. A missing or damaged file is
// measured afresh. A new file is written beside the old one and renamed over it, so servers that share the directory
// never read half a file, and the folder keeps the newest few engines' files (two versions sharing a directory both
// stay warm). Undefined when the engine changed under this process or can't be read: the listing then measures.
const KEEP_ENGINES = 3, STALE_TEMP_MS = 3600000;
async function openCache(directory) {
  const fingerprint = await LOADED_ENGINE;
  if (fingerprint === null || fingerprint !== await engineFingerprint()) return undefined;
  const file = path.join(directory, `${fingerprint}.json`);
  let cached = {};
  try { const read = JSON.parse(await readFile(file, 'utf8')); if (read && typeof read === 'object' && !Array.isArray(read)) cached = read; } catch { /* measured afresh */ }
  const key = (entry, source) => createHash('sha256').update(JSON.stringify([entry.kind, entry.base, source])).digest('hex');
  async function save(entries) {
    // Only inside a folder that already exists (the server's export directory), so a listing alone, which pixel_help
    // gives as a read-only call, never creates the output folder in a user's project.
    await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const temp = path.join(directory, `${randomUUID()}.tmp`);
    try { await writeFile(temp, JSON.stringify(entries)); await rename(temp, file); } finally { await rm(temp, { force: true }); }
    const now = Date.now(), engines = [];
    for (const name of await readdir(directory)) {
      const full = path.join(directory, name);
      if (/^[0-9a-f]{64}\.json$/.test(name) && name !== path.basename(file)) engines.push({ full, time: (await stat(full)).mtimeMs });
      // A temp file a killed call left behind.
      else if (/^[0-9a-f-]{36}\.tmp$/.test(name) && now - (await stat(full)).mtimeMs > STALE_TEMP_MS) await rm(full, { force: true });
    }
    for (const { full } of engines.sort((a, b) => b.time - a.time).slice(KEEP_ENGINES - 1)) await rm(full, { force: true });
  }
  return { key, cached, save };
}

// The whole listing. A preset that fails to compile is listed with its error, so one broken file hides nothing else.
// Measuring compiles every preset; past `budget` milliseconds (a slow machine, a growing folder) the rest are listed by
// name, kind and file only, so the call stays well inside the MCP server's time limit. With `cache`, a folder, each
// preset is measured once per engine and source, and later listings read its facts from there, past the budget too.
// The cache only ever saves time: when it can't be read or written, the listing measures as it would without it.
export async function listPresets({ budget = 20000, cache } = {}) {
  const presets = [], store = cache === undefined ? undefined : await openCache(cache).catch(() => undefined), kept = {};
  // The budget times the measuring, not the setup (hashing the engine, reading the folder), so a listing on a busy
  // machine still measures its first preset.
  const entries = await presetEntries(), start = Date.now();
  let unmeasured = 0, added = 0;
  for (const entry of entries) {
    const measuring = Date.now() - start <= budget;
    try {
      const { summary, id, facts, fresh } = await summarize(entry, store, measuring);
      if (!summary) { presets.push({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, unmeasured: true }); unmeasured++; continue; }
      presets.push(summary);
      if (store) { kept[id] = facts; if (fresh) added++; }
    } catch (error) {
      if (!measuring) { presets.push({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, unmeasured: true }); unmeasured++; continue; }
      presets.push({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, error: error.message });
    }
  }
  // Only presets in this listing are kept, so the file never grows past the folder.
  if (store && (added || Object.keys(kept).length !== Object.keys(store.cached).length)) await store.save(kept).catch(() => {});
  return { guide: PRESET_GUIDE, presets, ...(unmeasured && { note: `${unmeasured} presets were listed without measuring them, to keep this call short; pixel_compile one by name to see it.` }) };
}
