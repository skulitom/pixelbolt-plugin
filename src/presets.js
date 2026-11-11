// Node-side: the shipped examples an agent can start from instead of drawing an effect or a character from scratch.
// They are read from examples/ whenever they are asked for, so the listing always matches the folder. A preset is a
// top-level examples/*.fluid.json, *.fx.json, *.wave.json, *.crystal.json, *.powder.json, *.bodies.json or *.poses.json source, or a
// plain recipe whose animations all loop (a coin spin, a flickering ember) and that no source there compiles to. Titles
// and notes come from the Fluid and Effects labs' lists where those have one; anything else is described from its own
// name and animations.
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { measurePresets } from './preset-pool.js';
import { PixelError, renderProject } from './core.js';
import { resolveReferences } from './resolve.js';
import { compilePoses, compileAutotile, compileNormals } from './authoring.js';
import { compileEffects } from './fx.js';
import { compileFluid } from './fluid.js';
import { compileWaves } from './wave.js';
import { compileCrystals } from './crystal.js';
import { compilePowder } from './powder.js';
import { compileBodies } from './bodies.js';
import { EFFECT_PRESETS } from '../studio/effects-controls.js';
import { FLUID_PRESETS } from '../studio/fluid-controls.js';
import { POWDER_PRESETS } from '../studio/powder-controls.js';

export const PRESET_FOLDER = fileURLToPath(new URL('../examples/', import.meta.url));
const SOURCE = /^(.+)\.(fluid|fx|wave|crystal|powder|bodies|poses)\.json$/;
// What compiles each source format: the one table, which the CLI and the MCP server use too.
export const COMPILERS = { 'pixelforge-poses': compilePoses, 'pixelforge-autotile': compileAutotile, 'pixelforge-fx': compileEffects, 'pixelforge-fluid': compileFluid, 'pixelforge-wave': compileWaves, 'pixelforge-crystal': compileCrystals, 'pixelforge-powder': compilePowder, 'pixelforge-bodies': compileBodies, 'pixelforge-normals': compileNormals };
const TITLES = new Map([...FLUID_PRESETS.map(entry => [`fluid:${entry.file}`, entry]), ...EFFECT_PRESETS.map(entry => [`fx:${entry.file}`, entry]), ...POWDER_PRESETS.map(entry => [`powder:${entry.file}`, entry])]);

// How to use the listing. Fewer frames come from compiling with `frames`: a source's own `frames` is its simulation
// or timeline length, so lowering it cuts the effect off before it ends instead of sampling it.
export const PRESET_GUIDE = 'Start fire, smoke, explosions, splashes, spells and other effects from one of these rather than drawing them: pixel_compile {"preset": "<name>"} compiles one as it ships (pixelbolt compile --preset <name> --out <new.json> from a shell), with "size": "32x32" and "frames": 8 (--size, --frames) for the canvas and frame count asked for, and pixel_help {"topic": "preset", "name": "<name>"} returns its source to edit and compile (a recipe preset is already a recipe: edit it and send it as project). Fluid presets are simulations: a liquid preset (honey, slime, water) is liquid falling, pouring or splashing, not a character; for a character that squashes, stretches or breathes, compile a pixelforge-poses source with one mass body and motions.idle (example: slime-idle).';

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
// A lab's title and note ("Campfire", "gas · loop"), without the loop or one-shot the listing already gives.
const titleLine = ({ title, note }) => {
  const kept = note.split('·').map(part => part.trim()).filter(part => part && !/^(loop|one-shot)$/i.test(part)).join(' · ');
  return kept ? `${title}: ${kept.toLowerCase()}.` : `${title}.`;
};
function about(entry, source, animations) {
  const titled = TITLES.get(`${entry.kind}:${entry.base}`), names = animations.map(([name]) => name);
  if (entry.kind === 'fluid') {
    const liquid = Object.values(source.effects ?? {}).some(effect => effect?.kind === 'liquid');
    const kind = liquid ? 'A simulated liquid, not a character.' : 'A simulated gas.';
    return titled ? `${titleLine(titled)}${liquid ? ' A liquid, not a character.' : ''}` : kind;
  }
  if (titled && entry.kind !== 'powder') return titleLine(titled);
  if (entry.kind === 'poses') {
    const templates = [...new Set(Object.values(source.motions ?? {}).map(motion => motion?.template).filter(Boolean))];
    // A grid part attached to the last bone of a rig arm in the rest pose is held: a figure with a sword lists as one.
    // A part named as a hand is the hand itself, not something in it.
    const hands = new Set((Array.isArray(source.rig?.arms) ? source.rig.arms : []).filter(Array.isArray).map(chain => chain.at(-1)).filter(name => typeof name === 'string'));
    const rest = Array.isArray(source.poses) ? source.poses.find(pose => pose?.name === source.rig?.rest) : undefined;
    const held = (Array.isArray(rest?.parts) ? rest.parts : []).filter(part => hands.has(part?.attach?.part) && source.parts?.[part.part]?.rows
      && !/hand/i.test(`${part.name} ${part.part}`)).map(part => part.name);
    return templates.length ? `A ${source.rig?.fore ? 'four-legged animal' : 'character'} rig whose motion templates make ${listNames(templates)}${held.length ? `, with ${listNames(held)} in hand` : ''}.` : `Posed parts: ${listNames(names)}.`;
  }
  if (entry.kind === 'fx') return `Particles and effect shapes: ${listNames(names)}.`;
  if (entry.kind === 'wave') return `A looping wave pattern: ${listNames(names)}.`;
  if (entry.kind === 'crystal') {
    // What grows: each habit counted with the crystals of its clusters.
    const counts = new Map();
    for (const effect of Object.values(source.effects ?? {})) for (const crystal of effect?.crystals ?? []) counts.set(crystal?.habit, (counts.get(crystal?.habit) ?? 0) + (Number.isInteger(crystal?.count) ? crystal.count : 1));
    const parts = [...counts].filter(([habit]) => typeof habit === 'string').map(([habit, n]) => `${n} ${habit === 'octahedron' ? (n === 1 ? 'octahedron' : 'octahedra') : `${habit}${n === 1 ? '' : 's'}`}`);
    return `Crystals that grow and come to rest: ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? 'none'}.`;
  }
  if (entry.kind === 'powder') {
    // What happens (the Powder lab's title and note), then what the sandbox holds, from its scene.
    const named = [...new Set((source.scene ?? []).flatMap(fill => (fill?.legend ? Object.values(fill.legend) : [fill?.material])).filter(name => typeof name === 'string' && name !== 'empty'))];
    const of = named.length ? ` of ${listNames(named)}` : '';
    return titled ? `${titleLine({ ...titled, note: titled.note.replace(/:\s*/g, ', ') })} Falling sand${of}.` : `A falling-sand sandbox${of}.`;
  }
  if (entry.kind === 'bodies') {
    // What falls, bounces and topples: each shape counted with its copies on a ring or a grid, then its joints, ropes and cloth.
    const counts = new Map(), effects = Object.values(source.effects ?? {});
    for (const effect of effects) for (const body of effect?.bodies ?? []) {
      const copies = body?.ring?.count ?? (Array.isArray(body?.grid?.count) ? body.grid.count[0] * body.grid.count[1] : 1);
      counts.set(body?.shape, (counts.get(body?.shape) ?? 0) + copies);
    }
    const parts = [...counts].filter(([shape]) => typeof shape === 'string').map(([shape, n]) => `${n} ${shape}${n === 1 ? '' : shape === 'box' ? 'es' : 's'}`);
    const joints = effects.reduce((n, effect) => n + (effect?.joints?.length ?? 0), 0);
    const ropes = effects.reduce((n, effect) => n + (effect?.ropes?.length ?? 0), 0);
    const cloths = effects.reduce((n, effect) => n + (effect?.cloths?.length ?? 0), 0);
    const extras = [joints && `${joints} joint${joints === 1 ? '' : 's'}`, ropes && `${ropes} rope${ropes === 1 ? '' : 's'}`, cloths && `${cloths} cloth${cloths === 1 ? '' : 's'}`].filter(Boolean);
    if (!parts.length && cloths) {
      const others = extras.filter(extra => !/ cloth/.test(extra));
      return `Cloth${cloths === 1 ? '' : ` (${cloths})`}${others.length ? ` with ${others.join(' and ')}` : ''}.`;
    }
    const bodies = `Simulated rigid bodies: ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? 'none'}.`;
    return extras.length ? `${bodies.slice(0, -1)}, with ${extras.join(' and ')}.` : bodies;
  }
  // Frames no animation plays are pictures of their own: the tiles of a set beside its one animated tile.
  const played = new Set(Object.values(source.animations ?? {}).flatMap(item => (Array.isArray(item?.frames) ? item.frames : []).map(frame => frame?.frame ?? frame)));
  const stills = (Array.isArray(source.frames) ? source.frames : []).map(frame => frame?.name).filter(name => typeof name === 'string' && !played.has(name));
  return `A hand-drawn recipe: ${listNames(names)}${stills.length ? `; stills ${listNames(stills)}` : ''}.`;
}

// One line of facts per preset, from compiling it: what an agent compares with the request before picking one.
// Everything but the name, kind and file depends only on the engine and the preset's resolved source, so a cache
// (`store`, from openCache) keeps those facts under a key of both, and `fresh` says they were measured this time.
// With `measuring` false (past the listing's budget) only cached facts are used; `summary` is null without them.
const FACTS = ['for', 'size', 'frames', 'plays', 'colors', 'animations', 'moreAnimations'];
const isFacts = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => FACTS.includes(key))
  && typeof value.for === 'string' && typeof value.size === 'string' && Number.isInteger(value.frames) && typeof value.plays === 'string'
  && Number.isInteger(value.colors) && value.animations !== null && typeof value.animations === 'object' && !Array.isArray(value.animations);
async function summarize(entry, store, measuring) {
  const { source, id, known } = await prepare(entry, store), hit = known !== undefined;
  if (!hit && !measuring) return { summary: null };
  const facts = hit ? known : measurePreset(entry, source);
  return { summary: { name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, ...facts }, id, facts, fresh: !hit };
}
async function prepare(entry, store) {
  const { source } = await loadPreset(entry), id = store?.key(entry, source), known = id === undefined ? undefined : store.cached[id];
  return { source, id, known: isFacts(known) ? known : undefined };
}
// Shared with the pool's worker entry point; it returns facts only, never rendered frames.
export function measurePreset(entry, source) {
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
const ENGINE_FILES = [new URL('../package.json', import.meta.url), new URL('../studio/effects-controls.js', import.meta.url), new URL('../studio/fluid-controls.js', import.meta.url), new URL('../studio/powder-controls.js', import.meta.url)];
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
    // gives, never creates the output folder in a user's project. It still writes there, so pixel_help isn't
    // annotated read-only.
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
// `concurrency: 1` uses the original in-thread path. Larger values are capped at eight and leave one available core
// free (at least one); cached facts and a lone miss never need a pool.
// `only`, a test of an entry, lists just those presets (a shell's `presets --find`, which has no cache to fill).
export async function listPresets({ budget = 20000, cache, only, concurrency = Math.max(1, Math.min(8, availableParallelism() - 1)) } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  concurrency = Math.min(concurrency, Math.max(1, Math.min(8, availableParallelism() - 1)));
  const presets = [], store = cache === undefined ? undefined : await openCache(cache).catch(() => undefined), kept = {};
  // Start the budget after setup (hashing the engine, reading the folder); source resolution and worker startup
  // count toward it, and only work already in flight can finish past it.
  const entries = only ? (await presetEntries()).filter(only) : await presetEntries(), start = Date.now();
  // Resolve and check the cache before making a pool: a warm listing, or a single miss, needs no workers. The
  // explicit serial path keeps its original load/measure order. A non-positive budget uses that path too: at zero,
  // its inclusive clock check can admit the first preset before loading it. Pool preparation would lose that turn.
  // Both paths gather facts and save in preset order.
  const parallel = concurrency > 1 && budget > 0 ? await parallelSummaries(entries, store, start + budget, concurrency) : null;
  let unmeasured = 0, added = 0;
  for (const [index, entry] of entries.entries()) {
    const measuring = Date.now() - start <= budget;
    try {
      const result = parallel ? parallel[index] : await summarize(entry, store, measuring);
      if (result.error !== undefined) { presets.push({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, error: result.error }); continue; }
      const { summary, id, facts, fresh } = result;
      if (!summary) { presets.push({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, unmeasured: true }); unmeasured++; continue; }
      presets.push(summary);
      if (store) { kept[id] = facts; if (fresh) added++; }
    } catch (error) {
      if (!measuring) { presets.push({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, unmeasured: true }); unmeasured++; continue; }
      presets.push({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, error: error.message });
    }
  }
  // Only presets in this listing are kept, so the file never grows past the folder.
  if (store && !only && (added || Object.keys(kept).length !== Object.keys(store.cached).length)) await store.save(kept).catch(() => {});
  return { guide: PRESET_GUIDE, presets, ...(unmeasured && { note: `${unmeasured} presets were listed without measuring them, to keep this call short; pixel_compile one by name to see it.` }) };
}

// What pixel_help topic presets and `pixelbolt presets` return unless asked for the full listing: one line per preset,
// keyed by its name, with the facts an agent compares with a request and what the preset is for. The full listing
// (the file and every animation's frames) was 21 KB for 72 presets, read on every effect request.
export const BRIEF_NOTE = 'Each preset reads: kind, size, frames (in how many animations, when more than one), loop or one-shot, colours, then what it is for. pixel_help {"topic": "presets", "full": true} (pixelbolt presets --full) adds each preset\'s file and every animation\'s frames.';
export function briefListing({ guide, presets, note }) {
  const line = entry => {
    if (entry.error !== undefined) return `${entry.kind}; fails to compile: ${entry.error}`;
    if (entry.unmeasured) return `${entry.kind}; not measured, to keep this call short`;
    const count = Object.keys(entry.animations).length + (entry.moreAnimations ?? 0);
    return `${entry.kind}, ${entry.size}, ${entry.frames} frames${count > 1 ? ` in ${count} animations` : ''}, ${entry.plays}, ${entry.colors} colours. ${entry.for}`;
  };
  return { guide: `${guide} ${BRIEF_NOTE}`, presets: Object.fromEntries(presets.map(entry => [entry.name, line(entry)])), ...(note && { note }) };
}

// The presets a few words mean, so an agent reads the lines it can use and not the whole listing (8 KB for 73 presets,
// read for one line): the presets whose names hold the most of the words, or, when no name holds any, those whose
// lines do. Words are matched as written, ignoring case.
export const FIND_NOTE = 'Matched by name, or by description when no name matches. Each reads: kind, size, frames, loop or one-shot, colours, what it is for. pixel_compile {"preset": "<name>"} (pixelbolt compile --preset <name> --out <new.json>) compiles one as it ships, with size and frames (--size, --frames) for the canvas and frame count asked for; pixel_help {"topic": "preset", "name": "<name>"} (pixelbolt presets <name>) returns its source to edit. A colour is changed after compiling, with a patch of the palette: pixel_inspect with palette: true (inspect --palette) says which keys colour what.';
export function presetWords(query, where = 'find') {
  const words = typeof query === 'string' ? query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : [];
  if (!words.length) throw new PixelError(where, 'expected words to look for, such as "fire" or "water splash"');
  return words;
}
const closest = (items, text, words) => {
  const scored = items.map(item => ({ item, score: words.filter(word => text(item).toLowerCase().includes(word)).length })), top = Math.max(0, ...scored.map(entry => entry.score));
  return top ? scored.filter(entry => entry.score === top).map(entry => entry.item) : [];
};
const NOT_A_CHARACTER = /,? not a character/g;
export const namedLike = (entries, words) => closest(entries, entry => entry.name, words);
// What each kind of preset is called, for a search word that names a kind rather than a preset.
const KIND_WORDS = { powder: 'sand powder sandbox grains falling', bodies: 'bodies body rigid physics ball balls box boxes crate crates', wave: 'wave waves ripple ripples portal', crystal: 'crystal crystals gem gems', fluid: 'fluid liquid gas smoke', fx: 'particles particle spell spells', poses: 'character rig' };
// `all` is every preset by name and kind, where the listing holds only those measured for this search.
export function findListing(listing, query, where = 'find', all = listing.presets) {
  const words = presetWords(query, where), lines = briefListing(listing).presets;
  // A liquid's line says it is not a character, which is no reason to list it for "character".
  const named = namedLike(listing.presets, words), found = named.length ? named : closest(listing.presets, entry => lines[entry.name].replace(NOT_A_CHARACTER, ''), words);
  if (!found.length) {
    // Nothing ships for most characters, and the way to one is a rig redrawn, so the reply names the rigs.
    const rigs = listing.presets.filter(entry => entry.kind === 'poses' && /rig whose/.test(entry.for ?? '')).map(entry => entry.name);
    return { guide: `No preset matches "${query}": try another word, or draw it (the quick start says how).${rigs.length ? ` For a character or creature, start from a rig and redraw it (${rigs.join(', ')}; pixel_help {"topic": "craft", "name": "Characters"}, pixelbolt help craft "Characters").` : ''} Every preset by name:`, names: listing.presets.map(entry => entry.name).join(', ') };
  }
  // Names come first, and a kind of preset the words also stand for is named with its presets: "sand" is three
  // liquids by name, and falling sand is a kind of its own with five.
  const kinds = new Set(found.map(entry => entry.kind));
  const also = Object.entries(KIND_WORDS).filter(([kind, text]) => !kinds.has(kind) && words.some(word => text.split(' ').includes(word)))
    .map(([kind]) => [kind, all.filter(entry => entry.kind === kind).map(entry => entry.name)]).filter(([, names]) => names.length).map(([kind, names]) => `${kind}: ${names.join(', ')}`).join('; ');
  return { guide: FIND_NOTE, presets: Object.fromEntries(found.map(entry => [entry.name, lines[entry.name]])), ...(also && { also: `Kinds of preset those words also name: ${also}.` }), ...(listing.note && { note: listing.note }) };
}

async function parallelSummaries(entries, store, deadline, concurrency) {
  const results = new Array(entries.length), jobs = [];
  const summary = (entry, facts) => ({ name: entry.name, kind: entry.kind, file: `examples/${entry.file}`, ...facts });
  for (const [index, entry] of entries.entries()) {
    results[index] = { summary: null };
    try {
      const { source, id, known } = await prepare(entry, store);
      if (known !== undefined) results[index] = { summary: summary(entry, known), id, facts: known, fresh: false };
      else jobs.push({ index, entry, source, id });
    } catch (error) {
      // Defer read/resolve errors to their turn too: past the budget they are unmeasured, as in the serial path.
      jobs.push({ index, entry, error: error.message });
    }
  }
  const measured = await measurePresets(jobs, { concurrency, deadline }, measurePreset);
  for (const [at, result] of measured.entries()) {
    const { index, entry, id } = jobs[at];
    if (result?.facts) results[index] = { summary: summary(entry, result.facts), id, facts: result.facts, fresh: true };
    else if (result?.error !== undefined) results[index] = result;
  }
  return results;
}
