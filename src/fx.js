// Particle effects compiled to ordinary, editable recipes, after Pixel Composer's particle system. A pixelforge-fx
// source names effects; each simulates seeded emitters frame by frame and bakes every frame into stamp, grid and
// line operations on the source's own symbols. The result inspects, patches and exports like any other version-1
// recipe, and editing a symbol in it updates every particle drawn with it. Emitters spawn in a box, on a ring or arc,
// or along a line; a child emitter spawns where its parent's particles end, land or travel; particles can face their
// direction of travel and change colour over their life; cues mark frames for game code. Shape layers (src/shapes.js:
// shockwave rings, slashes, beams, lightning, magic circles, impact stars, fireballs) bake into one grid per frame
// between `behind` particles and the rest. Browser-compatible and deterministic: seeded hashing and polynomial
// trigonometry, no Math.random.
import { PixelError, parseColor, renderProject, FRAME_AREA } from './core.js';
import { fields, point, compilePoses } from './authoring.js';
import { patternProblem, ditherThreshold, traceLine, random, hash, sinDeg, cosDeg, ease, EASINGS } from './craft.js';
import { readShapes, renderShapes, tween, sample, sequenceFrame } from './shapes.js';

const fail = (path, message) => { throw new PixelError(path, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) fail(path, 'expected a name of letters, digits, hyphens or underscores, starting with a letter');
  return value;
};
const number = (value, path, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a number from ${min} to ${max}`);
  return value;
};
const integer = (value, path, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value;
};
// A number, or [min, max] sampled per particle.
const range = (value, path, min, max, whole = false) => {
  const check = whole ? integer : number;
  if (Array.isArray(value)) {
    if (value.length !== 2) fail(path, 'expected a number or [min, max]');
    const [a, b] = [check(value[0], `${path}[0]`, min, max), check(value[1], `${path}[1]`, min, max)];
    if (a > b) fail(path, 'min must not exceed max');
    return [a, b];
  }
  const v = check(value, path, min, max);
  return [v, v];
};
const pair = (value, path, min, max) => {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'expected [x, y]');
  return [number(value[0], `${path}[0]`, min, max), number(value[1], `${path}[1]`, min, max)];
};
const pick = ([a, b], r) => a + (b - a) * r;
const pickWhole = ([a, b], r) => a + Math.min(b - a, Math.floor(r * (b - a + 1)));
// Salts keep each sampled property independent, so changing one range does not reshuffle the others.
const SALT = { x: 1, y: 2, angle: 3, speed: 4, life: 5, variant: 6, remap: 7, phase: 8, offset: 9, ring: 10, radius: 11, along: 12, pixel: 13, release: 14, share: 15 };
// Which of a sprite's pixels its emitter spawns from: every visible pixel, the visible pixels on its edge, or the empty
// pixels just outside it (as a look's outline takes them).
export const SPRITE_PIXELS = ['all', 'edge', 'outline'];
const clear = char => char === '.' || char === ' ';
const LIMITS = { effects: 64, emitters: 16, spawned: 4096, alive: 1024, operations: 20000 };
// When a child emitter spawns: where a parent particle ends, where it first lands on its floor, or every frame it lives.
export const FX_EVENTS = ['death', 'floor', 'life'];
const flag = (value, path) => {
  if (value !== undefined && typeof value !== 'boolean') fail(path, 'expected true or false');
  return value === true;
};
const readRemap = (remap, path, palette) => {
  if (!isObject(remap)) fail(path, 'expected a map of grid characters to colours');
  for (const [char, color] of Object.entries(remap)) {
    if (char.length !== 1 || char === '.' || char === ' ') fail(path, 'remap keys are single grid characters other than dot or space');
    parseColor(color, palette, `${path}.${char}`);
  }
  return remap;
};

// A sprite emitter spawns on a symbol's pixels (for an animation, the pixels of the frame showing), its top-left corner at
// the emitter's `at`. Each of `frames` lists the pixels it spawns from (`cells`, each with its palette key, null outside
// the sprite) and the rows for drawing what is left; `frame(t)` is the one effect frame t shows.
function readSprite(sprite, path, symbols, sequences, [x, y], loop) {
  if (!isObject(sprite)) fail(path, 'expected { symbol, pixels, draw }: the symbol whose pixels the particles spawn from, its top-left corner at the emitter\'s at');
  fields(sprite, ['symbol', 'pixels', 'draw'], path);
  const name = sprite.symbol, animated = typeof name === 'string' && Object.hasOwn(sequences, name);
  if (typeof name !== 'string' || (!animated && !Object.hasOwn(symbols, name))) fail(`${path}.symbol`, `expected the name of one of the source's symbols${typeof name === 'string' ? `; there is none named ${JSON.stringify(name)}` : ''}`);
  const pixels = sprite.pixels ?? 'all';
  if (!SPRITE_PIXELS.includes(pixels)) fail(`${path}.pixels`, 'expected all (every visible pixel), edge (the visible pixels beside an empty one) or outline (the empty pixels just outside the sprite)');
  const frames = (animated ? sequences[name] : [symbols[name]]).map(rows => {
    const w = rows[0].length, h = rows.length, cells = [];
    const solid = (i, j) => i >= 0 && j >= 0 && i < w && j < h && !clear(rows[j][i]);
    const beside = (i, j) => [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
    if (pixels === 'outline') {
      for (let j = -1; j <= h; j++) for (let i = -1; i <= w; i++) if (!solid(i, j) && beside(i, j).some(([a, b]) => solid(a, b))) cells.push({ x: i, y: j, key: null });
    } else {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (solid(i, j) && (pixels === 'all' || beside(i, j).some(([a, b]) => !solid(a, b)))) cells.push({ x: i, y: j, key: rows[j][i] });
    }
    return { rows, w, h, cells };
  });
  if (frames.every(frame => !frame.cells.length)) fail(`${path}.symbol`, `${name} has no visible pixels to spawn from`);
  return { symbol: name, animated, frames, frame: t => sequenceFrame(frames, t, loop), x, y, pixels, draw: sprite.draw === undefined ? null : flag(sprite.draw, `${path}.draw`) };
}

// `earlier` holds the effect's emitters read so far: a child names one of them as its parent.
function readEmitter(emitter, path, context, earlier) {
  fields(emitter, ['name', 'at', 'area', 'ring', 'line', 'burst', 'rate', 'start', 'end', 'life', 'angle', 'speed', 'gravity', 'drag', 'attract', 'sway', 'floor', 'bounce', 'shapes', 'face', 'play', 'remaps', 'tint', 'trail', 'dissolve', 'pattern', 'from', 'when', 'inherit', 'behind', 'cue', 'blob', 'sprite', 'release'], path);
  const { frames, symbols, sequences, palette, loop, seed, looks } = context;
  // A sprite emitter spawns on a symbol's pixels, its top-left corner at `at` (whole pixels); with release, every one of
  // them leaves once while the rest stays drawn.
  let sprite = null;
  if (emitter.sprite !== undefined) {
    if (emitter.at === undefined) fail(`${path}.at`, 'a sprite emitter needs at: where the sprite\'s top-left corner sits');
    sprite = readSprite(emitter.sprite, `${path}.sprite`, symbols, sequences, pair(emitter.at, `${path}.at`, -4096, 4096).map((v, i) => integer(v, `${path}.at[${i}]`, -4096, 4096)), loop);
  }
  let release = null;
  if (emitter.release !== undefined) {
    if (!sprite) fail(`${path}.release`, 'release lets each pixel of a sprite leave once; add sprite: { symbol } and at, its top-left corner');
    if (!isObject(emitter.release)) fail(`${path}.release`, 'expected { sweep, jitter, share }: {} releases the pixels in a seeded random order');
    fields(emitter.release, ['sweep', 'jitter', 'share'], `${path}.release`);
    if (loop) fail(`${path}.release`, 'a sprite comes apart once, so a release can\'t loop; make the effect a one-shot (play it reversed to put the sprite together)');
    release = {
      sweep: emitter.release.sweep === undefined ? null : number(emitter.release.sweep, `${path}.release.sweep`, -3600, 3600),
      jitter: number(emitter.release.jitter ?? (emitter.release.sweep === undefined ? 1 : 0.3), `${path}.release.jitter`, 0, 1),
      share: number(emitter.release.share ?? 1, `${path}.release.share`, 0, 1)
    };
    if (emitter.release.jitter !== undefined && release.sweep === null) fail(`${path}.release.jitter`, 'jitter loosens a sweep; without sweep the order is already random');
    if (sprite.animated) fail(`${path}.sprite.symbol`, `${sprite.symbol} is an animation; a release takes apart one frame, so take that frame ({ recipe, frame })`);
  }
  if (sprite) {
    if (sprite.draw === null) sprite.draw = release !== null;
    for (const key of ['area', 'ring', 'line', 'from']) if (emitter[key] !== undefined) fail(`${path}.${key}`, `a sprite emitter spawns on the sprite's pixels; ${key} applies to other emitters`);
    // A pixel outside the sprite has no colour of its own, so particles from the outline need something to draw.
    if (sprite.pixels === 'outline' && emitter.shapes === undefined && emitter.blob === undefined) fail(`${path}.shapes`, 'particles from a sprite\'s outline start on empty pixels, which have no colour to draw: give shapes or a blob');
  }
  // A blob particle draws no symbol: it adds a soft disc to one of the effect's looks, so touching drops merge.
  let blob = null;
  if (emitter.blob !== undefined) {
    if (emitter.blob === null || typeof emitter.blob !== 'object' || Array.isArray(emitter.blob)) fail(`${path}.blob`, 'expected { look, radius }');
    fields(emitter.blob, ['look', 'radius'], `${path}.blob`);
    const look = emitter.blob.look ?? (looks.length === 1 ? looks[0] : undefined);
    if (!looks.includes(look)) fail(`${path}.blob.look`, emitter.blob.look === undefined ? `name the look this blob is drawn into: ${looks.join(', ')}` : `no look is named ${JSON.stringify(emitter.blob.look)}`);
    blob = { look, radius: tween(emitter.blob.radius ?? 3, `${path}.blob.radius`, 0, 64) };
    for (const key of ['shapes', 'face', 'play', 'remaps', 'tint', 'trail', 'dissolve', 'pattern', 'behind']) if (emitter[key] !== undefined) fail(`${path}.${key}`, `${key} applies to particles drawn as symbols; a blob particle is drawn into its look`);
  }
  if (emitter.name !== undefined) identifier(emitter.name, `${path}.name`);
  const schedules = ['burst', 'rate', 'release'].filter(key => emitter[key] !== undefined);
  // A sprite emitter with draw: true and no schedule only draws the sprite (an animation frame for frame, say).
  const drawOnly = sprite !== null && sprite.draw === true && !schedules.length;
  if (schedules.length !== 1 && !drawOnly) fail(path, sprite ? 'use exactly one of burst (particles at start), rate (particles per frame) or release (each pixel leaves once)' : 'use exactly one of burst (particles at start) or rate (particles per frame)');
  // A child spawns from the particles of an earlier emitter, at an event, instead of on a schedule of its own.
  let parent = null, when = null;
  if (emitter.from !== undefined) {
    identifier(emitter.from, `${path}.from`);
    const matches = earlier.flatMap((e, i) => (e.name === emitter.from ? [i] : []));
    if (!matches.length) fail(`${path}.from`, `no earlier emitter in this effect is named ${JSON.stringify(emitter.from)}; list the parent before its children`);
    if (matches.length > 1) fail(`${path}.from`, `${matches.length} earlier emitters are named ${JSON.stringify(emitter.from)}; give the parent a unique name`);
    parent = matches[0];
    when = emitter.when ?? 'death';
    if (!FX_EVENTS.includes(when)) fail(`${path}.when`, 'expected death (where a parent particle ends), floor (where it first lands) or life (every frame it lives)');
    if (when === 'life' && emitter.rate === undefined) fail(`${path}.burst`, 'a child spawning while its parent lives uses rate: particles per frame for each parent particle');
    if (when !== 'life' && emitter.burst === undefined) fail(`${path}.rate`, `a child spawning at its parent's ${when} uses burst: particles per event`);
    if (when === 'floor' && earlier[parent].floor === null) fail(`${path}.when`, `emitter ${JSON.stringify(emitter.from)} has no floor to land on`);
    for (const key of ['start', 'end']) if (emitter[key] !== undefined) fail(`${path}.${key}`, 'a child spawns when its parent particles do; start and end apply to emitters with their own schedule');
  } else {
    for (const key of ['when', 'inherit']) if (emitter[key] !== undefined) fail(`${path}.${key}`, `${key} applies to a child emitter; set from to the emitter it spawns from`);
  }
  const start = integer(emitter.start ?? 0, `${path}.start`, 0, frames - 1);
  if (emitter.end !== undefined && emitter.rate === undefined && !release) fail(`${path}.end`, 'end applies to rate emitters and releases');
  const end = integer(emitter.end ?? frames, `${path}.end`, start + 1, frames);
  // A child's at is an offset from its parent particle (default none); a sprite's cues sit at its middle; everyone
  // else's is the spawn centre.
  const at = sprite ? [sprite.x + sprite.frames[0].w / 2, sprite.y + sprite.frames[0].h / 2] : parent !== null && emitter.at === undefined ? [0, 0] : pair(emitter.at, `${path}.at`, -4096, 4096);
  const spawnShapes = ['area', 'ring', 'line'].filter(key => emitter[key] !== undefined);
  if (spawnShapes.length > 1) fail(`${path}.${spawnShapes[1]}`, `use one of area (a box), ring (a circle or arc) or line (a segment); this emitter already has ${spawnShapes[0]}`);
  let ring = null, line = null;
  if (emitter.ring !== undefined) {
    fields(emitter.ring, ['radius', 'arc', 'even', 'outward'], `${path}.ring`);
    const arc = emitter.ring.arc === undefined ? [0, 360] : pair(emitter.ring.arc, `${path}.ring.arc`, -3600, 3600);
    if (arc[1] < arc[0] || arc[1] - arc[0] > 360) fail(`${path}.ring.arc`, 'expected [from, to] in degrees clockwise (0 right, 90 down), from no more than to and at most 360 apart');
    ring = { radius: range(emitter.ring.radius, `${path}.ring.radius`, 0, 256), arc, even: flag(emitter.ring.even, `${path}.ring.even`), outward: flag(emitter.ring.outward, `${path}.ring.outward`) };
  }
  if (emitter.line !== undefined) {
    fields(emitter.line, ['to', 'even'], `${path}.line`);
    const to = pair(emitter.line.to, `${path}.line.to`, -4096, 4096);
    line = { dx: to[0] - at[0], dy: to[1] - at[1], even: flag(emitter.line.even, `${path}.line.even`) };
  }
  // A sprite's particles without shapes are its own pixels, each drawn in its pixel's colour.
  const pixel = sprite !== null && !blob && emitter.shapes === undefined;
  if (pixel) for (const key of ['face', 'play']) if (emitter[key] !== undefined) fail(`${path}.${key}`, `${key} picks among shapes; a sprite's particles without shapes are its own pixels`);
  if (!blob && !pixel && (!Array.isArray(emitter.shapes) || !emitter.shapes.length || emitter.shapes.length > 64)) fail(`${path}.shapes`, 'expected 1–64 symbol names (one sequence) or lists of them (variants picked per particle), or a blob drawn into a look');
  const nested = !blob && !pixel && Array.isArray(emitter.shapes[0]);
  const variants = blob || pixel ? [] : (nested ? emitter.shapes : [emitter.shapes]).map((sequence, v) => {
    const sp = nested ? `${path}.shapes[${v}]` : `${path}.shapes`;
    if (!Array.isArray(sequence) || !sequence.length || sequence.length > 64) fail(sp, 'expected a list of 1–64 symbol names');
    return sequence.map((name, i) => {
      if (typeof name !== 'string' || !Object.hasOwn(symbols, name)) fail(`${sp}[${i}]`, Object.hasOwn(sequences, name) ? `${name} is an animation: a sprite or an aura can follow it, but a particle draws one symbol` : `unknown symbol ${JSON.stringify(name)}`);
      return name;
    });
  });
  // With face, the sequences are directions of travel: the first faces right and the rest turn clockwise, evenly.
  const face = flag(emitter.face, `${path}.face`);
  if (face && (!nested || variants.length < 2 || variants.length > 16)) fail(`${path}.shapes`, 'face picks a sequence by direction of travel: give 2–16 sequences, the first facing right (0°) and the rest turning clockwise, evenly spaced');
  const play = emitter.play ?? 'life';
  if (!['life', 'loop', 'once'].includes(play)) fail(`${path}.play`, 'expected life (spread over the lifetime), loop (one per frame, cycling) or once (one per frame, holding the last)');
  const life = emitter.life === undefined ? null : range(emitter.life, `${path}.life`, 1, 256, true);
  if (loop && !life && !drawOnly) fail(`${path}.life`, 'looping effects need a finite life so the loop can repeat seamlessly');
  if (emitter.dissolve !== undefined && !life) fail(`${path}.dissolve`, 'dissolve needs a finite life');
  const remaps = emitter.remaps === undefined ? [] : emitter.remaps;
  if (!Array.isArray(remaps) || remaps.length > 64) fail(`${path}.remaps`, 'expected at most 64 remaps, one picked per particle');
  remaps.forEach((remap, r) => readRemap(remap, `${path}.remaps[${r}]`, palette));
  let tint = null;
  if (emitter.tint !== undefined) {
    if (!Array.isArray(emitter.tint) || !emitter.tint.length || emitter.tint.length > 64) fail(`${path}.tint`, 'expected 1–64 stages: remaps, or one colour for the whole particle, spread over each life, the first at birth');
    // A stage is a remap of some characters, or one colour the whole particle turns.
    tint = emitter.tint.map((stage, s) => (typeof stage === 'string' ? (parseColor(stage, palette, `${path}.tint[${s}]`), stage) : readRemap(stage, `${path}.tint[${s}]`, palette)));
  }
  // Pixel particles draw into one grid a frame, so the colours they change to must be palette keys a grid row can name.
  const gridKey = (color, where) => { if (typeof color !== 'string' || color.length !== 1 || !Object.hasOwn(palette, color)) fail(where, 'a sprite\'s pixel particles change to single-character palette keys, not colour values'); };
  if (pixel) for (const [label, list] of [['remaps', remaps], ['tint', tint ?? []]]) list.forEach((map, s) => {
    if (typeof map === 'string') gridKey(map, `${path}.${label}[${s}]`);
    else for (const [char, color] of Object.entries(map)) gridKey(color, `${path}.${label}[${s}].${char}`);
  });
  let cue = null;
  if (emitter.cue !== undefined) {
    cue = identifier(emitter.cue, `${path}.cue`);
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cue)) fail(`${path}.cue`, 'reserved filename; choose a portable name');
  }
  let trail = null;
  if (emitter.trail !== undefined) {
    fields(emitter.trail, ['color', 'length'], `${path}.trail`);
    parseColor(emitter.trail.color, palette, `${path}.trail.color`);
    trail = { color: emitter.trail.color, length: integer(emitter.trail.length ?? 2, `${path}.trail.length`, 1, 16) };
  }
  let attract = null;
  if (emitter.attract !== undefined) {
    fields(emitter.attract, ['at', 'strength'], `${path}.attract`);
    attract = { at: pair(emitter.attract.at, `${path}.attract.at`, -4096, 4096), strength: number(emitter.attract.strength ?? 0.5, `${path}.attract.strength`, -8, 8) };
  }
  let sway = null;
  if (emitter.sway !== undefined) {
    fields(emitter.sway, ['amplitude', 'period'], `${path}.sway`);
    sway = { amplitude: pair(emitter.sway.amplitude, `${path}.sway.amplitude`, 0, 32), period: number(emitter.sway.period ?? 8, `${path}.sway.period`, 1, 256) };
  }
  if (emitter.bounce !== undefined && emitter.floor === undefined) fail(`${path}.bounce`, 'bounce applies at a floor');
  // The dissolve pattern takes the same forms as the dither operation: a Bayer name, noise (ordered by the effect's
  // seed) or a matrix of ranks.
  const pattern = emitter.pattern ?? 'bayer4', problem = patternProblem(pattern);
  if (problem) fail(`${path}.pattern${problem[0]}`, problem[1]);
  if (emitter.pattern !== undefined && emitter.dissolve === undefined) fail(`${path}.pattern`, 'pattern shapes the dissolve; set dissolve too');
  const area = emitter.area === undefined ? [1, 1] : point(emitter.area, `${path}.area`);
  if (area.some(n => n < 1 || n > 256)) fail(`${path}.area`, 'expected a spawn box from 1 to 256 pixels per side');
  return {
    name: emitter.name, at, area, ring, line, start, end, variants, face, play, life, remaps, tint, trail, attract, sway, parent, when, cue, blob, sprite, release, pixel, drawOnly,
    directions: face ? variants.map((_, k) => [cosDeg(360 * k / variants.length), sinDeg(360 * k / variants.length)]) : null,
    inherit: number(emitter.inherit ?? 0, `${path}.inherit`, 0, 2), behind: flag(emitter.behind, `${path}.behind`),
    burst: emitter.burst === undefined ? null : integer(emitter.burst, `${path}.burst`, 1, 1024),
    rate: emitter.rate === undefined ? null : number(emitter.rate, `${path}.rate`, 0.001, 64),
    // Measured from each particle's outward direction on an outward ring, where it defaults to straight out.
    angle: range(emitter.angle ?? (ring?.outward ? 0 : [0, 360]), `${path}.angle`, -3600, 3600),
    speed: range(emitter.speed ?? 0, `${path}.speed`, 0, 64),
    gravity: emitter.gravity === undefined ? [0, 0] : pair(emitter.gravity, `${path}.gravity`, -8, 8),
    drag: number(emitter.drag ?? 0, `${path}.drag`, 0, 1),
    floor: emitter.floor === undefined ? null : integer(emitter.floor, `${path}.floor`, -4096, 4096),
    bounce: number(emitter.bounce ?? 0, `${path}.bounce`, 0, 1),
    dissolve: emitter.dissolve === undefined ? 0 : number(emitter.dissolve, `${path}.dissolve`, 0, 1),
    threshold: ditherThreshold(pattern, [0, 0], seed)
  };
}

// The direction a facing particle draws: the sequence whose direction is closest to its velocity (largest dot
// product, comparisons only, so the choice is the same in every engine); a particle at rest keeps its last one.
function facing(e, vx, vy, previous) {
  if (vx * vx + vy * vy < 1e-6) return previous;
  let best = 0, most = -Infinity;
  e.directions.forEach(([dx, dy], k) => { const dot = vx * dx + vy * dy; if (dot > most + 1e-9) { most = dot; best = k; } });
  return best;
}
// The k-th of `count` angles spread evenly over an arc: a full circle has no repeat at its end; a shorter arc reaches
// both ends (a single particle takes the middle).
const evenAngle = ([from, to], k, count) => (to - from >= 360 ? from + 360 * k / count : count === 1 ? (from + to) / 2 : from + (to - from) * k / (count - 1));

// Simulates one effect and returns its frames' operations plus counts for the metadata.
function simulate(effect, context) {
  const { frames, loop, seed, emitters } = effect, { width, height, symbols } = context;
  // A loop warms up for as many whole cycles as the longest chain of lives (a child's particles can outlive their parent's
  // by their own life), with spawns keyed by their frame within the cycle and children by their parent, so the particles
  // in flight at frame 0 are exactly those still alive at the end.
  const chain = [];
  // A sprite emitter that only draws has no particles to wait for.
  emitters.forEach((e, i) => { chain[i] = e.drawOnly ? 0 : (e.life ? e.life[1] : Infinity) + (e.parent === null ? 0 : chain[e.parent]); });
  const warmup = loop ? Math.ceil(Math.max(...chain) / frames) : 0, total = (warmup + 1) * frames, first = warmup * frames;
  // The child emitters of each emitter, by the event they spawn at.
  const children = emitters.map((_, i) => Object.fromEntries(['death', 'floor'].map(when => [when, emitters.flatMap((e, j) => (e.parent === i && e.when === when ? [j] : []))])));
  const alive = [], output = Array.from({ length: frames }, () => []), behind = Array.from({ length: frames }, () => []), blobs = Array.from({ length: frames }, () => []), cues = Array.from({ length: frames }, () => ({}));
  const stats = emitters.map(e => ({ ...(e.name && { name: e.name }), spawned: 0, maxAlive: 0, ...(e.sprite && { pixels: e.sprite.frames[0].cells.length }) }));
  let operations = 0, culled = 0;
  // A release gives each of the sprite's pixels the frame it leaves on: where the sweep's front reaches it between start
  // and end (loosened by jitter), or a seeded random frame without a sweep. `due` lists the pixels that spawn a particle
  // in each frame (a share of them, when share is below 1) and `leaves` every leaving pixel's frame by its place in the
  // symbol, so the rest of the sprite is drawn without it.
  const releases = emitters.map((e, index) => {
    if (!e.release) return null;
    const { cells, w } = e.sprite.frames[0], { sweep, jitter, share } = e.release, span = e.end - e.start;
    const dx = sweep === null ? 0 : cosDeg(sweep), dy = sweep === null ? 0 : sinDeg(sweep), along = cells.map(c => c.x * dx + c.y * dy);
    let low = Infinity, high = -Infinity;
    for (const a of along) { if (a < low) low = a; if (a > high) high = a; }
    const due = Array.from({ length: frames }, () => []), leaves = new Map();
    cells.forEach((c, i) => {
      const order = sweep === null || high - low < 1e-9 ? 0 : (along[i] - low) / (high - low);
      const frame = e.start + Math.min(span - 1, Math.floor(((1 - jitter) * order + jitter * random(seed, index, -1, i, SALT.release)) * span));
      if (c.key !== null) leaves.set(c.y * w + c.x, frame);
      if (share >= 1 || random(seed, index, -1, i, SALT.share) < share) due[frame].push(i);
    });
    return { due, leaves };
  });
  // What a sprite emitter draws of the sprite itself this frame (all of it, or what is left after a release), as
  // palette-key codes over the canvas; its pixel particles are added on top.
  const sheet = (e, index, t) => {
    const chars = new Uint16Array(width * height), { rows, w, h } = e.sprite.frame(t % frames), { x, y, draw } = e.sprite, leaves = releases[index]?.leaves;
    let any = false;
    if (draw) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const X = x + i, Y = y + j;
      if (clear(rows[j][i]) || !inside(X, Y) || (leaves && (leaves.get(j * w + i) ?? Infinity) <= t)) continue;
      chars[Y * width + X] = rows[j].charCodeAt(i); any = true;
    }
    return { chars, any };
  };
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  // A cue names the spawn centre in the first frame its emitter spawns at; one point per name and frame.
  const mark = (e, t, x, y) => {
    const f = t - first;
    if (e.cue && f >= 0 && f < frames && !Object.hasOwn(cues[f], e.cue)) cues[f][e.cue] = [Math.floor(x + 0.5), Math.floor(y + 0.5)];
  };
  // One new particle around (cx, cy), the k-th of `count` spawned together; `r` draws its seeded values and `tag`
  // identifies it to its own children. A child adds `inherit` times its parent's velocity.
  const launch = (e, index, cx, cy, k, count, r, tag, born, parent, cell = null) => {
    let x, y, out = null, key = null;
    if (e.sprite) {
      // On one of the sprite's pixels (of the frame showing): the released one, or a seeded pick.
      const { cells } = e.sprite.frame(born % frames), c = cell ?? cells[Math.min(cells.length - 1, Math.floor(r(SALT.pixel) * cells.length))];
      x = e.sprite.x + c.x; y = e.sprite.y + c.y; key = c.key;
    } else if (e.ring) {
      const { radius, arc, even, outward } = e.ring, theta = even ? evenAngle(arc, k, count) : pick(arc, r(SALT.ring)), d = pick(radius, r(SALT.radius));
      x = cx + cosDeg(theta) * d; y = cy + sinDeg(theta) * d;
      if (outward) out = theta;
    } else if (e.line) {
      const s = e.line.even ? (count === 1 ? 0.5 : k / (count - 1)) : r(SALT.along);
      x = cx + e.line.dx * s; y = cy + e.line.dy * s;
    } else { x = cx + (r(SALT.x) - 0.5) * (e.area[0] - 1); y = cy + (r(SALT.y) - 0.5) * (e.area[1] - 1); }
    const angle = out === null ? pick(e.angle, r(SALT.angle)) : out + pick(e.angle, r(SALT.angle)), speed = pick(e.speed, r(SALT.speed));
    const life = e.life ? pickWhole(e.life, r(SALT.life)) : Infinity, variant = e.face ? null : e.variants[Math.min(e.variants.length - 1, Math.floor(r(SALT.variant) * e.variants.length))];
    let vx = cosDeg(angle) * speed, vy = sinDeg(angle) * speed;
    if (parent && e.inherit) { vx += parent.vx * e.inherit; vy += parent.vy * e.inherit; }
    return {
      emitter: e, index, born, life, variant, age: 0, x, y, vx, vy, tag, key,
      remap: e.remaps.length ? e.remaps[Math.min(e.remaps.length - 1, Math.floor(r(SALT.remap) * e.remaps.length))] : null,
      phase: r(SALT.phase) * 360, offset: Math.floor(r(SALT.offset) * 64), trail: [], landed: false, facing: 0
    };
  };
  // Every new particle comes through here, so child emitters that multiply within one frame fail at the limit instead
  // of piling up millions of particles first.
  const add = particle => {
    alive.push(particle);
    if (alive.length > LIMITS.alive) fail(context.path, `more than ${LIMITS.alive} particles are alive at once; lower burst, rate or life`);
  };
  // Children of particle q, born in frame `born`: keyed by the parent's tag and age, so a looping parent has the same
  // children every cycle.
  const spawnChildren = (index, q, count, born) => {
    const e = emitters[index];
    for (let k = 0; k < count; k++) {
      const r = salt => random(q.tag, index, q.age, k, salt);
      add(launch(e, index, q.x + e.at[0], q.y + e.at[1], k, count, r, hash(q.tag, index, q.age, k), born, q));
      if (born >= first) stats[index].spawned++;
    }
    if (count) mark(e, born, q.x + e.at[0], q.y + e.at[1]);
  };
  const layered = emitters.some(e => e.behind);
  for (let t = 0; t < total; t++) {
    const cycle = t % frames, drawing = t >= first;
    emitters.forEach((e, index) => {
      if (e.parent !== null) return;
      // A release spawns from the pixels leaving this frame, each keyed by its place in the sprite.
      if (e.release) {
        const due = releases[index].due[cycle];
        due.forEach((i, k) => {
          add(launch(e, index, 0, 0, k, due.length, salt => random(seed, index, -1, i, salt), hash(seed, index, -1, i), t, null, e.sprite.frames[0].cells[i]));
          if (drawing) stats[index].spawned++;
        });
        if (due.length) mark(e, t, e.at[0], e.at[1]);
        return;
      }
      // A sprite that only draws spawns nothing, nor does one whose frame showing has no pixels to spawn from.
      if ((e.burst === null && e.rate === null) || (e.sprite && !e.sprite.frame(cycle).cells.length)) return;
      let count = 0;
      if (e.burst !== null) count = cycle === e.start ? e.burst : 0;
      else if (cycle >= e.start && cycle < e.end) { const c = cycle - e.start; count = Math.floor((c + 1) * e.rate + 1e-9) - Math.floor(c * e.rate + 1e-9); }
      const key = loop ? cycle : t;
      for (let k = 0; k < count; k++) {
        add(launch(e, index, e.at[0], e.at[1], k, count, salt => random(seed, index, key, k, salt), hash(seed, index, key, k), t, null));
        if (drawing) stats[index].spawned++;
      }
      if (count) mark(e, t, e.at[0], e.at[1]);
    });
    // Children that spawn while their parents live: `rate` per frame for each parent particle, from where it is.
    emitters.forEach((e, index) => {
      if (e.when !== 'life') return;
      for (let i = 0, parents = alive.length; i < parents; i++) {
        const q = alive[i];
        if (q.index === e.parent) spawnChildren(index, q, Math.floor((q.age + 1) * e.rate + 1e-9) - Math.floor(q.age * e.rate + 1e-9), t);
      }
    });
    if (drawing) emitters.forEach((e, index) => { stats[index].maxAlive = Math.max(stats[index].maxAlive, alive.filter(p => p.index === index).length); });
    // Every live particle's rounded (and swayed) position. Sway never carries a particle below its floor. A facing
    // particle turns with its velocity in every frame, warm-up included, so a loop's frame 0 continues its last frame.
    const places = alive.map(p => {
      const e = p.emitter, sway = e.sway;
      const sx = sway ? sway.amplitude[0] * sinDeg(360 * p.age / sway.period + p.phase) : 0, sy = sway ? sway.amplitude[1] * cosDeg(360 * p.age / sway.period + p.phase) : 0;
      const x = p.x + sx, y = e.floor !== null && p.y + sy > e.floor ? e.floor : p.y + sy, X = Math.floor(x + 0.5), Y = Math.floor(y + 0.5);
      p.trail.push([X, Y]);
      if (p.trail.length > 17) p.trail.shift();
      if (e.face) p.facing = facing(e, p.vx, p.vy, p.facing);
      return [X, Y, x, y];
    });
    // Draw oldest first, with `behind` emitters' particles under everyone else's. Particles partly off the canvas are
    // cropped into grid operations and trails keep only their on-canvas pixels, so nothing clips.
    const sheets = drawing ? emitters.map((e, index) => (e.sprite && (e.sprite.draw || e.pixel) ? sheet(e, index, t) : null)) : null;
    if (drawing) for (const pass of layered ? [true, false] : [null]) alive.forEach((p, i) => {
      const e = p.emitter;
      if (pass !== null && e.behind !== pass) return;
      const [X, Y] = places[i], ops = (pass === true ? behind : output)[t - first], span = Number.isFinite(p.life) ? p.life : frames - (p.born - first);
      if (e.blob) {
        // Its radius moves through the keys over its life; the shape layers' grid draws it.
        const radius = sample(e.blob.radius, Math.min(1, p.age / Math.max(1, span - 1))), [, , x, y] = places[i];
        if (radius > 0 && x + radius > 0 && y + radius > 0 && x - radius < width && y - radius < height) blobs[t - first].push({ look: e.blob.look, x, y, radius });
        else culled++;
        return;
      }
      const share = stages => Math.min(stages - 1, Math.floor(p.age / span * stages));
      // The last `dissolve` share of a life thins out through an ordered-dither pattern anchored to the canvas.
      const fading = e.dissolve ? Math.ceil(e.dissolve * p.life) : 0, into = p.age - (p.life - fading);
      const progress = fading && into >= 0 ? (into + 1) / (fading + 1) : 0;
      if (e.trail) {
        const [fromX, fromY] = p.trail[Math.max(0, p.trail.length - 1 - e.trail.length)];
        const pixels = [];
        if (fromX !== X || fromY !== Y) traceLine(fromX, fromY, X, Y, (x, y) => pixels.push([x, y]));
        const visible = pixels.filter(([x, y]) => inside(x, y));
        if (visible.length === pixels.length && pixels.length) ops.push({ op: 'line', x: fromX, y: fromY, x2: X, y2: Y, color: e.trail.color });
        else ops.push(...visible.map(([x, y]) => ({ op: 'pixel', x, y, color: e.trail.color })));
        operations += visible.length === pixels.length ? Math.min(1, pixels.length) : visible.length;
      }
      // Tint stages spread over the life like `play: life`, over the particle's own remap; a stage that is one colour
      // turns the whole particle that colour.
      const stage = e.tint ? e.tint[share(e.tint.length)] : null, whole = typeof stage === 'string';
      const colours = stage && !whole ? { ...p.remap, ...stage } : p.remap;
      // A sprite's own pixel, in its colour (or the one its tint or remap turns it to), goes into the emitter's grid.
      if (e.pixel) {
        if (!inside(X, Y)) { culled++; return; }
        if (progress && e.threshold(X, Y) < progress) return;
        const s = sheets[p.index];
        s.chars[Y * width + X] = (whole ? stage : colours?.[p.key] ?? p.key).charCodeAt(0); s.any = true;
        return;
      }
      const sequence = e.face ? e.variants[p.facing] : p.variant;
      const step = e.play === 'loop' ? (p.age + p.offset) % sequence.length : e.play === 'once' ? Math.min(p.age, sequence.length - 1) : share(sequence.length);
      const symbol = sequence[step], rows = symbols[symbol], w = rows[0].length, h = rows.length, left = X - Math.floor(w / 2), top = Y - Math.floor(h / 2);
      if (left >= width || top >= height || left + w <= 0 || top + h <= 0) { culled++; return; }
      const recolour = whole ? { ...p.remap, ...Object.fromEntries([...new Set(rows.join(''))].filter(char => !clear(char)).map(char => [char, stage])) } : colours;
      const remap = recolour && Object.keys(recolour).length ? { remap: recolour } : {};
      const x0 = Math.max(0, -left), y0 = Math.max(0, -top), x1 = Math.min(w, width - left), y1 = Math.min(h, height - top);
      if (!progress && x0 === 0 && y0 === 0 && x1 === w && y1 === h) { ops.push({ op: 'stamp', symbol, x: left, y: top, ...remap }); operations++; return; }
      const kept = rows.slice(y0, y1).map((row, j) => [...row.slice(x0, x1)].map((char, i) => (char === ' ' || e.threshold(left + x0 + i, top + y0 + j) < progress ? '.' : char)).join(''));
      if (kept.some(row => /[^.]/.test(row))) { ops.push({ op: 'grid', x: left + x0, y: top + y0, rows: kept, ...remap }); operations++; }
    });
    // Each sprite emitter's grid (what is left of its sprite, under its pixel particles, oldest first) is cropped to its
    // drawn pixels and goes first in its pass, in emitter order, under the particles drawn as symbols.
    if (drawing) {
      const leading = { true: [], false: [] };
      emitters.forEach((e, index) => {
        const s = sheets[index];
        if (!s?.any) return;
        let x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (let c = 0; c < s.chars.length; c++) if (s.chars[c]) { const x = c % width, y = (c - x) / width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        const rows = [];
        for (let y = y0; y <= y1; y++) { let row = ''; for (let x = x0; x <= x1; x++) { const code = s.chars[y * width + x]; row += code ? String.fromCharCode(code) : '.'; } rows.push(row); }
        leading[e.behind].push({ op: 'grid', x: x0, y: y0, rows });
        operations++;
      });
      output[t - first].unshift(...leading.false);
      behind[t - first].unshift(...leading.true);
    }
    // Advance: velocity gains gravity and attraction, loses drag, moves the particle, then meets the floor. A particle
    // that ends or first lands hands the event to its children, which appear there in the next frame.
    const events = [];
    for (let i = alive.length - 1; i >= 0; i--) {
      const p = alive[i], e = p.emitter;
      p.age++;
      if (p.age >= p.life) { if (children[p.index].death.length) events.push([p, 'death']); alive.splice(i, 1); continue; }
      p.vx += e.gravity[0]; p.vy += e.gravity[1];
      if (e.attract) {
        const dx = e.attract.at[0] - p.x, dy = e.attract.at[1] - p.y, distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 0.5) { p.vx += dx / distance * e.attract.strength; p.vy += dy / distance * e.attract.strength; }
      }
      p.vx *= 1 - e.drag; p.vy *= 1 - e.drag;
      p.x += p.vx; p.y += p.vy;
      if (e.floor !== null && p.y > e.floor) {
        p.y = e.floor;
        if (p.vy > 0) p.vy = -p.vy * e.bounce;
        if (!p.landed) { p.landed = true; if (children[p.index].floor.length) events.push([p, 'floor']); }
      }
    }
    // In the parents' drawing order.
    for (let k = events.length - 1; k >= 0; k--) { const [q, when] = events[k]; for (const index of children[q.index][when]) spawnChildren(index, q, emitters[index].burst, t + 1); }
    if (operations > LIMITS.operations) fail(context.path, `the effect needs more than ${LIMITS.operations} drawing operations; lower counts or frames`);
  }
  return { output, behind, blobs, operations, culled, stats, cues };
}

// Frame durations eased from `from` to `to` milliseconds across the effect: `in` stays quick and slows at the end,
// the usual shape of an impact (fast flash and burst, lingering settle).
function curve(value, path, count) {
  fields(value, ['from', 'to', 'ease'], path);
  const from = integer(value.from, `${path}.from`, 1, 60000), to = integer(value.to, `${path}.to`, 1, 60000), name = value.ease ?? 'linear';
  if (!EASINGS.includes(name)) fail(`${path}.ease`, `expected one of ${EASINGS.join(', ')}`);
  return Array.from({ length: count }, (_, i) => Math.min(60000, Math.max(1, Math.round(from + (to - from) * ease(name, count === 1 ? 0 : i / (count - 1))))));
}

// Keys a frame's colours can take when its recipe's own key is missing or means another colour in the effect's palette.
// Letters first: JavaScript lists digit keys before all others, which would reorder the palette.
const SPARE_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&*+-/:;<=>?@^_~0123456789';
const hexOf = rgba => '#' + [...rgba].slice(0, rgba[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('');
// An inline recipe or pose source (a pose source compiles first), rendered, with its poses' metadata when it has some.
function loadSource(spec, path) {
  if (typeof spec === 'string' || (isObject(spec) && spec.revision !== undefined && spec.version === undefined)) fail(path, 'file and revision references are resolved by the CLI and MCP; inline the recipe to compile here');
  if (!isObject(spec)) fail(path, 'expected a recipe or a pixelforge-poses source, inline or as a file reference');
  if (spec.format !== undefined && spec.format !== 'pixelforge-poses') fail(path, `expected a recipe or a pixelforge-poses source, not ${spec.format}`);
  const compiled = spec.format === 'pixelforge-poses' ? compilePoses(spec) : null, recipe = compiled?.recipe ?? spec;
  return { recipe, project: renderProject(recipe), poses: compiled?.metadata.poses ?? null };
}
// The frames `entry` names: one `frame` (default the first) or every frame of an `animation`, in playing order.
function framesOf(entry, source, path) {
  const { recipe, project } = source, list = (names, more) => `${names.slice(0, 12).join(', ')}${more > 12 ? ', …' : ''}`;
  if (entry.frame !== undefined && entry.animation !== undefined) fail(`${path}.animation`, 'name a frame or an animation, not both');
  if (entry.animation !== undefined) {
    const animation = typeof entry.animation === 'string' && Object.hasOwn(project.animations, entry.animation) ? project.animations[entry.animation] : null;
    if (!animation) fail(`${path}.animation`, `${recipe.name ?? 'the recipe'} has no animation named ${JSON.stringify(entry.animation)}; it has ${list(Object.keys(project.animations), Object.keys(project.animations).length)}`);
    return animation.frames.map(index => project.frames[index]);
  }
  const frame = entry.frame === undefined ? project.frames[0] : project.frames.find(f => f.name === entry.frame);
  if (!frame) fail(`${path}.frame`, `${recipe.name ?? 'the recipe'} has no frame named ${JSON.stringify(entry.frame)}; it has ${list(project.frames.map(f => f.name), project.frames.length)}`);
  return [frame];
}
/**
 * A frame of a recipe or pose source, or every frame of one of its animations, as symbol rows over its whole canvas, so
 * the sprite keeps the source's coordinates: { rows } or { frames: [rows, …] }. Each colour drawn takes the source's own
 * one-character key, unless `palette` (the effect's, extended in place) already gives that key another colour; then it
 * takes a spare key. Translucent overlaps become their own colour.
 */
export function recipeSprite(entry, palette, path) {
  if (!isObject(entry)) fail(path, 'expected rows, or { recipe, frame } or { recipe, animation }: a frame or an animation of a recipe or pose source');
  fields(entry, ['recipe', 'frame', 'animation'], path);
  const source = loadSource(entry.recipe, `${path}.recipe`), { project } = source;
  if (project.height > 256) fail(`${path}.recipe`, `its canvas is ${project.width}×${project.height}; a symbol has at most 256 rows`);
  const ownKey = new Map();
  for (const [key, value] of Object.entries(project.palette)) if (key.length === 1) { const id = parseColor(value, project.palette).join(); if (!ownKey.has(id)) ownKey.set(id, key); }
  const keyOf = new Map();
  const rowsOf = ({ data }) => {
    const rows = [];
    for (let y = 0; y < project.height; y++) {
      let row = '';
      for (let x = 0; x < project.width; x++) {
        const at = (y * project.width + x) * 4;
        if (!data[at + 3]) { row += '.'; continue; }
        const rgba = [data[at], data[at + 1], data[at + 2], data[at + 3]], id = rgba.join();
        if (!keyOf.has(id)) {
          const own = ownKey.get(id), same = key => Object.hasOwn(palette, key) && parseColor(palette[key], palette).join() === id;
          let key = own !== undefined && (!Object.hasOwn(palette, own) || same(own)) ? own : [...Object.keys(palette)].find(k => k.length === 1 && same(k));
          if (key === undefined) {
            key = [...SPARE_KEYS].find(k => !Object.hasOwn(palette, k));
            if (key === undefined) fail(path, 'the effect\'s palette has no free one-character key left for this frame\'s colours');
          }
          if (!Object.hasOwn(palette, key)) palette[key] = hexOf(rgba);
          keyOf.set(id, key);
        }
        row += keyOf.get(id);
      }
      rows.push(row);
    }
    return rows;
  };
  const frames = framesOf(entry, source, path).map(rowsOf);
  return entry.animation === undefined ? { rows: frames[0] } : { frames };
}
/**
 * Where a named point is in each frame of an animation of a recipe or pose source, or null where it has none: a
 * frame's named point (a pose source's markers), or `part.point` for a point of a part from the poses' metadata.
 */
export function recipePoints(entry, path, key = 'point') {
  if (!isObject(entry)) fail(path, 'expected { recipe, animation, point }: the point to follow through an animation of a recipe or pose source');
  fields(entry, ['recipe', 'animation', 'point', 'pivot'], path);
  if (entry.animation === undefined) fail(`${path}.animation`, 'name the animation whose frames the trail follows');
  const name = entry[key];
  if (typeof name !== 'string' || !name) fail(`${path}.${key}`, 'name the point to follow: a frame\'s named point (a marker), or part.point for a point of a pose part, such as blade.tip (part.anchor is where the part is fixed, such as a hilt)');
  const source = loadSource(entry.recipe, `${path}.recipe`), frames = framesOf(entry, source, path), dot = name.indexOf('.');
  const at = frame => {
    if (dot > 0) {
      const part = source.poses?.[frame.name]?.parts?.[name.slice(0, dot)], point = name.slice(dot + 1), where = part?.points?.[point] ?? (point === 'anchor' ? part?.anchor : undefined);
      return where ? [where[0], where[1]] : null;
    }
    const named = frame.points?.[name] ?? source.poses?.[frame.name]?.markers?.find(marker => marker.name === name)?.at;
    return named ? [named[0], named[1]] : null;
  };
  const points = frames.map(at);
  if (points.every(p => p === null)) {
    const names = new Set(frames.flatMap(frame => [...Object.keys(frame.points ?? {}), ...Object.entries(source.poses?.[frame.name]?.parts ?? {}).flatMap(([part, info]) => Object.keys(info.points ?? {}).map(point => `${part}.${point}`))]));
    fail(`${path}.${key}`, `no frame of ${entry.animation} has a point named ${JSON.stringify(name)}${names.size ? `; it has ${[...names].slice(0, 16).join(', ')}` : ''}`);
  }
  return points;
}

// A trail layer with follow: { recipe, animation, point } takes that point's place in each frame of the animation as its
// points, frame for frame (null where the point is missing; the frames after the animation have none).
function followed(layer, path, frames) {
  if (!isObject(layer) || layer.kind !== 'trail' || layer.follow === undefined) return layer;
  if (layer.points !== undefined) fail(`${path}.points`, 'a trail follows a point (follow) or takes its positions (points), not both');
  if (layer.pivot !== undefined && isObject(layer.follow) && layer.follow.pivot !== undefined) fail(`${path}.pivot`, 'the trail already follows a pivot (follow.pivot); give one or the other');
  const points = recipePoints(layer.follow, `${path}.follow`);
  if (points.length > frames) fail(`${path}.follow.animation`, `${layer.follow.animation} has ${points.length} frames and the effect ${frames}; give the effect at least one frame for each of the animation's`);
  const { follow, ...rest } = layer;
  return { ...rest, points, ...(follow.pivot !== undefined && { pivot: recipePoints(follow, `${path}.follow`, 'pivot') }) };
}

export function compileEffects(source) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'symbols', 'anchor', 'effects', 'sheet'], 'fx');
  if (source.format !== 'pixelforge-fx' || source.version !== 1) fail('fx', 'expected version-1 pixelforge-fx');
  if (source.palette !== undefined && !isObject(source.palette)) fail('fx.palette', 'expected a palette object');
  // Symbols taken from a recipe's frame add the colours they use, so the palette and symbols are the effect's own copies.
  const palette = { ...source.palette };
  const width = integer(source.width, 'fx.width', 1, 256), height = integer(source.height, 'fx.height', 1, 256);
  if (source.symbols !== undefined && (!isObject(source.symbols) || !Object.keys(source.symbols).length)) fail('fx.symbols', 'expected named symbols for the particles to draw');
  // An animation's frames are a sequence for sprites and auras, never stamped, so they stay out of the recipe's symbols.
  const symbols = { ...source.symbols }, sequences = {};
  for (const [name, rows] of Object.entries(symbols)) {
    identifier(name, `fx.symbols.${name}`);
    if (isObject(rows)) {
      const sprite = recipeSprite(rows, palette, `fx.symbols.${name}`);
      if (sprite.frames) { sequences[name] = sprite.frames; delete symbols[name]; } else symbols[name] = sprite.rows;
      continue;
    }
    if (!Array.isArray(rows) || !rows.length || rows.length > 256 || typeof rows[0] !== 'string' || !rows[0].length || rows.some(row => typeof row !== 'string' || row.length !== rows[0].length)) fail(`fx.symbols.${name}`, 'expected 1–256 equal-width text rows, or { recipe, frame } or { recipe, animation }: a frame or an animation of a recipe or pose source');
  }
  if (!isObject(source.effects) || !Object.keys(source.effects).length || Object.keys(source.effects).length > LIMITS.effects) fail('fx.effects', `expected 1–${LIMITS.effects} named effects`);
  const frames = [], animations = {}, metadata = { format: 'pixelforge-fx-metadata', version: 1, effects: {} }, seen = new Set();
  // Shape painting shares one work budget across every effect and frame (shapes.js SHAPE_WORK).
  const shapeWork = { spent: 0 };
  let totalFrames = 0;
  for (const [name, effect] of Object.entries(source.effects)) {
    const path = `fx.effects.${name}`;
    identifier(name, path);
    // Effect names become animation and frame names, which must be unique ignoring case for portable bundles.
    if (seen.has(name.toLowerCase())) fail(path, 'effect names must be unique ignoring case; they name animations and frames');
    seen.add(name.toLowerCase());
    fields(effect, ['frames', 'duration', 'loop', 'seed', 'emitters', 'layers', 'looks', 'cleanup'], path);
    const count = integer(effect.frames, `${path}.frames`, 1, 256), loop = effect.loop ?? false;
    // The recipe's limits on frames, checked before anything is simulated or painted rather than after.
    totalFrames += count;
    if (totalFrames > 256) fail('fx.effects', `the effects make ${totalFrames} frames; a recipe holds at most 256`);
    if (totalFrames * width * height > FRAME_AREA) fail('fx.effects', `the effects make ${totalFrames} frames of ${width}×${height}, more than the 4,194,304 pixels a recipe's frames share; use fewer frames or a smaller canvas`);
    if (typeof loop !== 'boolean') fail(`${path}.loop`, 'expected a boolean');
    const durations = Array.isArray(effect.duration)
      ? (effect.duration.length === count ? effect.duration.map((d, i) => integer(d, `${path}.duration[${i}]`, 1, 60000)) : fail(`${path}.duration`, `expected one duration or ${count}`))
      : isObject(effect.duration) ? curve(effect.duration, `${path}.duration`, count)
        : Array(count).fill(integer(effect.duration ?? 100, `${path}.duration`, 1, 60000));
    const seed = integer(effect.seed ?? 1, `${path}.seed`, 0, 2147483647), context = { frames: count, loop, seed, symbols, sequences, palette, width, height, path };
    // Shape layers (rings, slashes, beams, bolts, glyphs, stars, bursts, auras, trails) draw between `behind` particles and
    // the rest. A trail that follows a point of an animation takes that point's place in each frame as its points.
    const shapes = readShapes(Array.isArray(effect.layers) ? { ...effect, layers: effect.layers.map((layer, i) => followed(layer, `${path}.layers[${i}]`, count)) } : effect, path, context);
    context.looks = shapes ? shapes.looks.map(look => look.name) : [];
    const list = effect.emitters ?? (shapes ? [] : undefined);
    if (!Array.isArray(list) || (!list.length && (!shapes || effect.emitters !== undefined)) || list.length > LIMITS.emitters) fail(`${path}.emitters`, `expected 1–${LIMITS.emitters} emitters; leave emitters out for an effect of shape layers only`);
    const emitters = [];
    list.forEach((emitter, i) => emitters.push(readEmitter(emitter, `${path}.emitters[${i}]`, context, emitters)));
    const run = emitters.length ? simulate({ frames: count, loop, seed, emitters }, context)
      : { output: Array.from({ length: count }, () => []), behind: Array.from({ length: count }, () => []), blobs: Array.from({ length: count }, () => []), operations: 0, culled: 0, stats: [], cues: Array.from({ length: count }, () => ({})) };
    if (shapes) for (const layer of shapes.layers) if (layer.cue && !Object.hasOwn(run.cues[layer.t0], layer.cue)) run.cues[layer.t0][layer.cue] = [Math.floor(layer.at[0] + 0.5), Math.floor(layer.at[1] + 0.5)];
    const spawned = run.stats.reduce((sum, s) => sum + s.spawned, 0);
    if (spawned > LIMITS.spawned) fail(`${path}.emitters`, `more than ${LIMITS.spawned} particles; lower burst, rate or frames`);
    // Cues become named frame points, which atlases export for game code (a shake or a pause on the impact frame).
    const cues = [];
    const names = run.output.map((front, i) => {
      const grid = shapes && renderShapes(shapes, i, width, height, run.blobs[i], shapeWork);
      const ops = [...run.behind[i], ...(grid ? [{ op: 'grid', x: grid.x, y: grid.y, rows: grid.rows }] : []), ...front];
      const points = Object.keys(run.cues[i]).length ? run.cues[i] : null;
      if (points) for (const [cue, at] of Object.entries(points)) cues.push({ name: cue, frame: i, at });
      frames.push({ name: `${name}-${i}`, duration: durations[i], ...(points && { points }), ...(ops.length && { ops }) });
      return `${name}-${i}`;
    });
    animations[name] = { frames: names, ...(!loop && { loop: false }) };
    metadata.effects[name] = { frames: count, loop, seed: effect.seed ?? 1, operations: run.operations, culled: run.culled, emitters: run.stats, ...(shapes?.layers.length ? { layers: shapes.layers.map(l => ({ kind: l.kind, look: l.look, frames: [l.t0, l.t1] })) } : {}), ...(cues.length && { cues }) };
  }
  if (frames.length > 256) fail('fx.effects', `the effects make ${frames.length} frames; a recipe holds at most 256`);
  const recipe = { version: 1, name: source.name, width, height, palette, ...(Object.keys(symbols).length && { symbols }), ...(source.anchor !== undefined && { anchor: source.anchor }), frames, animations, ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject(recipe);
  return JSON.parse(JSON.stringify({ recipe, metadata }));
}
