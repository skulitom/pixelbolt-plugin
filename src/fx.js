// Particle effects compiled to ordinary, editable recipes, after Pixel Composer's particle system. A pixelforge-fx
// source names effects; each simulates seeded emitters frame by frame and bakes every frame into stamp, grid and
// line operations on the source's own symbols. The result inspects, patches and exports like any other version-1
// recipe, and editing a symbol in it updates every particle drawn with it. Emitters spawn in a box, on a ring or arc,
// or along a line; a child emitter spawns where its parent's particles end, land or travel; particles can face their
// direction of travel and change colour over their life; cues mark frames for game code. Shape layers (src/shapes.js:
// shockwave rings, slashes, beams, lightning, magic circles, impact stars, fireballs) bake into one grid per frame
// between `behind` particles and the rest. An effect's `shine` is the light of what it draws in its brightest colours
// (the flood of src/light.js), laid last on its sprites, on what else it draws and on the empty pixels. Each compile
// reviews what it made and warns about what a game would show as a fault: a loop that jumps at its seam, a canvas side
// drawn on (unless the effect lists it in `edges`), a one-shot that still draws on its last frame, where it is cut
// off (unless the effect says `residue: true`), and compile --frames thinning a loop unevenly. The whole effect is
// reviewed even where a compile keeps only its back or front part (compile --animation): the parts are what a game
// draws. A refusal names a route checked against the limit it reports: a release's share and an effect's frames are
// confirmed by simulating them again (shareHolds, framesRoute), a count for compile --frames thins every loop evenly or
// names the loop frames that let it (evenFrames), and loop frames and counts past 256 frames are confirmed by
// compiling them (trialCompile), ROUTE_TRIALS times at most.
// Browser-compatible and deterministic: seeded hashing and polynomial trigonometry, no Math.random.
import { PixelError, parseColor, renderProject, CANVAS_SIDE, FRAME_AREA, frameFits, frameAreaProblem, frameTotalProblem, joinErrors, fail, isObject, sameWidth } from './core.js';
import { fields, point, compilePoses, number, integer, range, pair, pick, pickWhole } from './authoring.js';
import { patternProblem, ditherThreshold, traceLine, random, hash, sinDeg, cosDeg, ease, EASINGS, rotateRows } from './craft.js';
import { LAYER_DEPTHS, readShapes, renderShapes, holdBands, settleHolds, tween, sample, sequenceFrame, atan2Deg, pathWalker, paletteKey } from './shapes.js';
import { createLight, spreadLight, readLight, meanOfFive, lightCodes, codeGrid, DRAWN, SURFACE, SHINING } from './light.js';
import { compileFluid } from './fluid.js';
import { compileWaves } from './wave.js';

const identifier = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) fail(path, 'expected a name of letters, digits, hyphens or underscores, starting with a letter');
  return value;
};
// Salts keep each sampled property independent, so changing one range does not reshuffle the others.
const SALT = { x: 1, y: 2, angle: 3, speed: 4, life: 5, variant: 6, remap: 7, phase: 8, offset: 9, ring: 10, radius: 11, along: 12, pixel: 13, release: 14, share: 15, size: 16, turn: 17, spin: 18 };
// Which of a sprite's pixels its emitter spawns from: every visible pixel, the visible pixels on its edge, or the empty
// pixels just outside it (as a look's outline takes them).
export const SPRITE_PIXELS = ['all', 'edge', 'outline'];
const clear = char => char === '.' || char === ' ';
// operations: what the recipe a compile delivers draws, every effect's frames it keeps (each turned copy's and part's)
// together; simulated: what every effect may draw in all, kept or not, since every frame is simulated (simulate).
const LIMITS = { effects: 64, emitters: 16, spawned: 4096, alive: 1024, operations: 20000, simulated: 80000 };
// A particle's symbol stays at most 256 a side, whether written as rows or taken from a recipe: it is stamped for every
// particle drawn, and one partly off the canvas is cropped into a grid of its own, so it is not the canvas. A sprite
// taken from a recipe spans that recipe's canvas and follows the frame (frameFits), but as a `sprite` emitter or an
// aura, drawn once a frame; as a particle's shape it keeps SYMBOL_SIDE.
const SYMBOL_SIDE = 256;
// The most visible width plus height a spinning particle's symbol may have. RotSprite turns it for each 45° step at
// eight times its size, so this bounds that work; a symbol within it turns into at most 254 pixels a side.
const SPIN_SPAN = 360;
// When a child emitter spawns: where a parent particle ends, where it first lands on its floor, or every frame it lives.
export const FX_EVENTS = ['death', 'floor', 'life'];
// Where an emitter's particles draw relative to a character standing in the effect: in front, behind, split by where
// each is born (above its spawn centre behind, the rest in front), or `between`, a stand-in sprite drawn between the two.
export const EMITTER_DEPTHS = ['front', 'back', 'split', 'between'];
// The canvas sides, and the direction each faces in degrees clockwise (0 right, 90 down), for turning `edges`.
export const EDGE_SIDES = ['left', 'right', 'top', 'bottom'];
const SIDE_ANGLE = { right: 0, bottom: 90, left: 180, top: 270 };
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
  fields(emitter, ['name', 'at', 'area', 'ring', 'line', 'burst', 'rate', 'start', 'end', 'life', 'angle', 'speed', 'gravity', 'drag', 'attract', 'sway', 'floor', 'bounce', 'rest', 'shapes', 'face', 'play', 'remaps', 'tint', 'trail', 'dissolve', 'pattern', 'from', 'when', 'inherit', 'behind', 'cue', 'blob', 'sprite', 'release', 'turbulence', 'path', 'curve', 'ease', 'spin', 'sweep', 'throttle', 'ground', 'kick', 'depth'], path);
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
    fields(emitter.blob, ['look', 'radius', 'size', 'power'], `${path}.blob`);
    // looks is null while the effect's layers have errors of their own: the look is checked once they read.
    const look = emitter.blob.look ?? (looks?.length === 1 ? looks[0] : undefined);
    if (looks !== null && !looks.includes(look)) fail(`${path}.blob.look`, emitter.blob.look === undefined ? `name the look this blob is drawn into: ${looks.join(', ')}` : `no look is named ${JSON.stringify(emitter.blob.look)}`);
    // power scales each disc's field over the particle's life: a hot drop climbs no higher than the look's dimmer bands
    // as it cools, from white through yellow to red, while its radius keys shrink it.
    blob = { look, radius: tween(emitter.blob.radius ?? 3, `${path}.blob.radius`, 0, 64), size: range(emitter.blob.size ?? 1, `${path}.blob.size`, 0.1, 8), power: emitter.blob.power === undefined ? null : tween(emitter.blob.power, `${path}.blob.power`, 0, 4) };
    for (const key of ['shapes', 'face', 'play', 'remaps', 'tint', 'trail', 'dissolve', 'pattern', 'behind', 'spin']) if (emitter[key] !== undefined) fail(`${path}.${key}`, `${key} applies to particles drawn as symbols; a blob particle is drawn into its look`);
  }
  if (emitter.name !== undefined) identifier(emitter.name, `${path}.name`);
  const schedules = ['burst', 'rate', 'release'].filter(key => emitter[key] !== undefined);
  // A sprite emitter with draw: true and no schedule only draws the sprite (an animation frame for frame, say).
  const drawOnly = sprite !== null && sprite.draw === true && !schedules.length;
  if (schedules.length !== 1 && !drawOnly) fail(path, sprite ? 'use exactly one of burst (particles at start), rate (particles per frame) or release (each pixel leaves once)' : 'use exactly one of burst (particles at start) or rate (particles per frame)');
  // depth: null when unset, so a child takes its parent particle's side.
  const depth = emitter.depth === undefined ? null : EMITTER_DEPTHS.includes(emitter.depth) ? emitter.depth : fail(`${path}.depth`, 'expected front, back, split (particles born above the spawn centre go behind a character, the rest in front) or between (a stand-in sprite drawn between the two, to review the effect on a character)');
  if (depth === 'between' && !drawOnly) fail(`${path}.depth`, 'between is for a stand-in: a sprite emitter that only draws (sprite with draw: true, and no burst, rate or release); the game draws its own character there');
  if (depth === 'split' && sprite) fail(`${path}.depth`, 'split goes by where each particle is born, above or below its spawn centre; a sprite emitter\'s pixels go to one side, so use back or front');
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
    if (when === 'floor' && earlier[parent].floor === null && earlier[parent].ground === null) fail(`${path}.when`, `emitter ${JSON.stringify(emitter.from)} has no floor to land on`);
    for (const key of ['start', 'end']) if (emitter[key] !== undefined) fail(`${path}.${key}`, 'a child spawns when its parent particles do; start and end apply to emitters with their own schedule');
  } else {
    // A moving emitter (one with a path) may inherit its own motion along the path; otherwise inherit is a child's.
    for (const key of ['when', 'inherit']) if (emitter[key] !== undefined && !(key === 'inherit' && emitter.path !== undefined)) fail(`${path}.${key}`, `${key} applies to a child emitter or one moving along a path; set from to the emitter it spawns from`);
  }
  const start = integer(emitter.start ?? 0, `${path}.start`, 0, frames - 1);
  if (emitter.end !== undefined && emitter.rate === undefined && !release) fail(`${path}.end`, 'end applies to rate emitters and releases');
  const end = integer(emitter.end ?? frames, `${path}.end`, start + 1, frames);
  // A keyed rate, 2–8 values spread from start to end, ramps the emission (thick at first and tapering, say); what each
  // frame spawns is what the running total adds, so fractions carry over as with a steady rate.
  let rateTotals = null;
  if (Array.isArray(emitter.rate)) {
    if (parent !== null) fail(`${path}.rate`, 'a child\'s rate is per frame for each parent particle; keys apply to emitters with their own schedule');
    if (emitter.rate.length < 2 || emitter.rate.length > 8) fail(`${path}.rate`, 'expected particles per frame, or 2–8 of them as keys spread from start to end');
    const keys = emitter.rate.map((v, i) => number(v, `${path}.rate[${i}]`, 0, 64));
    if (!keys.some(v => v > 0)) fail(`${path}.rate`, 'every key is 0, so nothing would spawn');
    if (end - start < 2) fail(`${path}.rate`, 'keys ramp the rate from start to end; give the emitter a window of two or more frames');
    rateTotals = [0];
    for (let c = 0; c < end - start; c++) rateTotals.push(rateTotals[c] + sample(keys, end - start > 1 ? c / (end - start - 1) : 0));
  }
  // A child's at is an offset from its parent particle (default none); a sprite's cues sit at its middle; everyone
  // else's is the spawn centre.
  // path moves the spawn centre along 2–16 points spread over the emitter's window, start to end, as a layer's keys
  // are over its frames: a meteor shedding smoke as it falls, a spark tracing a circle.
  let route = null;
  if (emitter.path !== undefined) {
    if (sprite || parent !== null) fail(`${path}.path`, sprite ? 'a sprite emitter spawns on its sprite, which stays put; path moves other emitters' : 'a child spawns on its parent particles; path moves an emitter with its own schedule');
    if (emitter.at !== undefined) fail(`${path}.at`, 'a moving emitter starts at its path\'s first point; leave at out');
    if (!Array.isArray(emitter.path) || emitter.path.length < 2 || emitter.path.length > 16) fail(`${path}.path`, 'expected 2–16 points [x, y] for the spawn centre to move through');
    route = emitter.path.map((p, i) => pair(p, `${path}.path[${i}]`, -4096, 4096));
  }
  // curve: true runs the path through a smooth curve, so a three-point arc has no corner at its middle point.
  const curve = flag(emitter.curve, `${path}.curve`);
  if (curve && (!route || route.length < 3)) fail(`${path}.curve`, 'curve smooths a path; give path three or more points');
  // The spawn centre moves at a steady speed along the path's length (pathWalker).
  if (route) route = { walk: pathWalker(route, curve), points: route };
  const at = sprite ? [sprite.x + sprite.frames[0].w / 2, sprite.y + sprite.frames[0].h / 2] : route ? route.points[0] : parent !== null && emitter.at === undefined ? [0, 0] : pair(emitter.at, `${path}.at`, -4096, 4096);
  const spawnShapes = ['area', 'ring', 'line'].filter(key => emitter[key] !== undefined);
  if (spawnShapes.length > 1) fail(`${path}.${spawnShapes[1]}`, `use one of area (a box), ring (a circle or arc) or line (a segment); this emitter already has ${spawnShapes[0]}`);
  let ring = null, line = null;
  if (emitter.ring !== undefined) {
    fields(emitter.ring, ['radius', 'arc', 'even', 'outward', 'squash', 'grow', 'fill'], `${path}.ring`);
    const arc = emitter.ring.arc === undefined ? [0, 360] : pair(emitter.ring.arc, `${path}.ring.arc`, -3600, 3600);
    if (arc[1] < arc[0] || arc[1] - arc[0] > 360) fail(`${path}.ring.arc`, 'expected [from, to] in degrees clockwise (0 right, 90 down), from no more than to and at most 360 apart');
    ring = { radius: range(emitter.ring.radius, `${path}.ring.radius`, 0, CANVAS_SIDE), arc, even: flag(emitter.ring.even, `${path}.ring.even`), outward: flag(emitter.ring.outward, `${path}.ring.outward`),
      // squash lays the ring on the ground as a ring layer's squash does: sparks rise from a magic circle's ellipse.
      squash: emitter.ring.squash === undefined ? null : pair(emitter.ring.squash, `${path}.ring.squash`, 0.125, 8),
      // fill picks the distance in a radius range evenly by area, so a disc of motes isn't crowded at its middle.
      fill: flag(emitter.ring.fill, `${path}.ring.fill`),
      // grow scales the radius by 2–8 keys over the emitter's window, start to end, so sparks ride a shockwave's edge out.
      grow: emitter.ring.grow === undefined ? null : Array.isArray(emitter.ring.grow) && emitter.ring.grow.length >= 2 && emitter.ring.grow.length <= 8 ? emitter.ring.grow.map((v, i) => number(v, `${path}.ring.grow[${i}]`, 0, 16)) : fail(`${path}.ring.grow`, 'expected 2–8 keys scaling the radius from start to end, such as [0.2, 1]') };
  }
  if (emitter.line !== undefined) {
    fields(emitter.line, ['to', 'even'], `${path}.line`);
    const to = pair(emitter.line.to, `${path}.line.to`, -4096, 4096);
    line = { dx: to[0] - at[0], dy: to[1] - at[1], even: flag(emitter.line.even, `${path}.line.even`) };
  }
  // A sprite's particles without shapes are its own pixels, each drawn in its pixel's colour.
  const pixel = sprite !== null && !blob && emitter.shapes === undefined;
  if (pixel) for (const key of ['face', 'play', 'spin']) if (emitter[key] !== undefined) fail(`${path}.${key}`, `${key} picks among shapes; a sprite's particles without shapes are its own pixels`);
  if (!blob && !pixel && (!Array.isArray(emitter.shapes) || !emitter.shapes.length || emitter.shapes.length > 64)) fail(`${path}.shapes`, 'expected 1–64 symbol names (one sequence) or lists of them (variants picked per particle), or a blob drawn into a look');
  const nested = !blob && !pixel && Array.isArray(emitter.shapes[0]);
  const variants = blob || pixel ? [] : (nested ? emitter.shapes : [emitter.shapes]).map((sequence, v) => {
    const sp = nested ? `${path}.shapes[${v}]` : `${path}.shapes`;
    if (!Array.isArray(sequence) || !sequence.length || sequence.length > 64) fail(sp, 'expected a list of 1–64 symbol names');
    return sequence.map((name, i) => {
      if (typeof name !== 'string' || !Object.hasOwn(symbols, name)) fail(`${sp}[${i}]`, Object.hasOwn(sequences, name) ? `${name} is an animation: a sprite or an aura can follow it, but a particle draws one symbol` : `unknown symbol ${JSON.stringify(name)}`);
      const rows = symbols[name];
      if (rows.length > SYMBOL_SIDE || rows[0].length > SYMBOL_SIDE) fail(`${sp}[${i}]`, `${name} is ${rows[0].length}×${rows.length}; a particle's symbol is at most ${SYMBOL_SIDE} a side, since every particle stamps it, so a sprite as large as the canvas belongs to a sprite emitter or an aura`);
      return name;
    });
  });
  // With face, the sequences are directions of travel: the first faces right and the rest turn clockwise, evenly.
  const face = flag(emitter.face, `${path}.face`);
  if (face && (!nested || variants.length < 2 || variants.length > 16)) fail(`${path}.shapes`, 'face picks a sequence by direction of travel: give 2–16 sequences, the first facing right (0°) and the rest turning clockwise, evenly spaced');
  // spin turns each particle's symbol by that many degrees a frame, from a seeded start, in 45° RotSprite steps (debris
  // that tumbles); the turned symbols join the recipe as <symbol>_r<degrees>.
  const spinRange = emitter.spin === undefined ? null : range(emitter.spin, `${path}.spin`, -180, 180), spin = spinRange && (spinRange[0] || spinRange[1]) ? spinRange : null;
  if (spin && face) fail(`${path}.spin`, 'face already turns the particle to its direction of travel; use one or the other');
  if (spin) for (const name of new Set(variants.flat())) {
    if (name.length > 59) fail(`${path}.spin`, `turned symbols are named <symbol>_r<degrees>; shorten ${name} to 59 characters or fewer`);
    // Turned 45°, a symbol's visible pixels span (width + height) / √2 each way: SPIN_SPAN bounds the turning.
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    symbols[name].forEach((row, j) => { for (let i = 0; i < row.length; i++) if (!clear(row[i])) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; } });
    if (x1 >= 0 && x1 - x0 + y1 - y0 + 2 > SPIN_SPAN) fail(`${path}.spin`, `spin turns ${name} in 45° steps with RotSprite, at eight times its size; a spinning symbol's visible width plus height may be at most ${SPIN_SPAN} pixels, and its visible ${x1 - x0 + 1} × ${y1 - y0 + 1} pixels add up to ${x1 - x0 + y1 - y0 + 2}`);
  }
  // sweep: 2–8 keys in degrees added to the launch angle over the emitter's window, start to end, so a flamethrower
  // swings across or a fountain sways.
  const sweep = emitter.sweep === undefined ? null : Array.isArray(emitter.sweep) && emitter.sweep.length >= 2 && emitter.sweep.length <= 8 ? emitter.sweep.map((v, i) => number(v, `${path}.sweep[${i}]`, -3600, 3600)) : fail(`${path}.sweep`, 'expected 2–8 keys in degrees added to the launch angle from start to end, such as [-30, 30]');
  if (sweep && parent !== null) fail(`${path}.sweep`, 'a child launches from its parent particles; sweep turns an emitter with its own schedule');
  // throttle: 2–8 keys scaling the launch speed over the window, so a fountain weakens or a flamethrower dies out.
  const throttle = emitter.throttle === undefined ? null : Array.isArray(emitter.throttle) && emitter.throttle.length >= 2 && emitter.throttle.length <= 8 ? emitter.throttle.map((v, i) => number(v, `${path}.throttle[${i}]`, 0, 8)) : fail(`${path}.throttle`, 'expected 2–8 keys scaling the launch speed from start to end, such as [1, 0.3]');
  if (throttle && parent !== null) fail(`${path}.throttle`, 'a child launches from its parent particles; throttle scales an emitter with its own schedule');
  // A burst spawns at one moment, so it would only ever read the first key of these.
  if (emitter.burst !== undefined && emitter.rate === undefined && !release) for (const [key, value] of [['path', emitter.path], ['sweep', emitter.sweep], ['throttle', emitter.throttle], ['ring.grow', emitter.ring?.grow]]) if (value !== undefined) fail(`${path}.${key}`, `a burst spawns at one moment, so ${key} would only use its first key; give the emitter a rate from start to end`);
  if (emitter.ring?.grow !== undefined && parent !== null) fail(`${path}.ring.grow`, 'a child spawns on its parent particles; grow scales the ring of an emitter with its own schedule');
  // ease shapes the emitter's progress over its window for path, ring grow, sweep and throttle, as a layer's ease does
  // its keys (default linear), so a trail given its head's ease keeps pace with it.
  const easing = emitter.ease === undefined ? null : EASINGS.includes(emitter.ease) ? emitter.ease : fail(`${path}.ease`, `expected ${EASINGS.join(', ')}`);
  if (easing && emitter.path === undefined && emitter.ring?.grow === undefined && sweep === null && throttle === null) fail(`${path}.ease`, 'ease shapes path, ring grow, sweep and throttle over the window; this emitter has none of them');
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
    fields(emitter.attract, ['at', 'strength', 'swirl'], `${path}.attract`);
    // swirl pushes each particle across the line to the point (clockwise when positive), so it spirals in or circles.
    attract = { at: pair(emitter.attract.at, `${path}.attract.at`, -4096, 4096), strength: number(emitter.attract.strength ?? 0.5, `${path}.attract.strength`, -8, 8), swirl: number(emitter.attract.swirl ?? 0, `${path}.attract.swirl`, -8, 8) };
  }
  let sway = null;
  if (emitter.sway !== undefined) {
    fields(emitter.sway, ['amplitude', 'period'], `${path}.sway`);
    sway = { amplitude: pair(emitter.sway.amplitude, `${path}.sway.amplitude`, 0, 32), period: number(emitter.sway.period ?? 8, `${path}.sway.period`, 1, 256) };
  }
  if (emitter.bounce !== undefined && emitter.floor === undefined && emitter.ground === undefined) fail(`${path}.bounce`, 'bounce applies at a floor or ground');
  if (emitter.rest !== undefined && emitter.floor === undefined && emitter.ground === undefined) fail(`${path}.rest`, 'rest applies at a floor or ground');
  if (emitter.floor !== undefined && emitter.ground !== undefined) fail(`${path}.ground`, 'a particle lands on one floor: a canvas row (floor) or pixels below where it was born (ground), not both');
  // turbulence pushes each particle by a smooth seeded field that stays put, `scale` pixels to a swirl, so smoke and
  // embers wander organically instead of swinging in step. A still field keeps loops seamless.
  let turbulence = null;
  if (emitter.turbulence !== undefined) {
    if (!isObject(emitter.turbulence)) fail(`${path}.turbulence`, 'expected { strength, scale }');
    fields(emitter.turbulence, ['strength', 'scale'], `${path}.turbulence`);
    const strength = number(emitter.turbulence.strength ?? 0.3, `${path}.turbulence.strength`, 0, 4), scale = number(emitter.turbulence.scale ?? 8, `${path}.turbulence.scale`, 2, 64);
    const salt = hash(context.seed, earlier.length, 0x7475);
    if (strength) turbulence = { strength, x: ditherThreshold('value', [0, 0], hash(salt, 1), scale), y: ditherThreshold('value', [0, 0], hash(salt, 2), scale) };
  }
  // The dissolve pattern takes the same forms as the dither operation: a Bayer name, noise (ordered by the effect's
  // seed) or a matrix of ranks.
  const pattern = emitter.pattern ?? 'bayer4', problem = patternProblem(pattern);
  if (problem) fail(`${path}.pattern${problem[0]}`, problem[1]);
  if (emitter.pattern !== undefined && emitter.dissolve === undefined) fail(`${path}.pattern`, 'pattern shapes the dissolve; set dissolve too');
  const area = emitter.area === undefined ? [1, 1] : point(emitter.area, `${path}.area`);
  // Up to twice the canvas side, so a box may start above the screen and cover all of it (rain over a 1024-wide frame).
  if (area.some(n => n < 1 || n > 2 * CANVAS_SIDE)) fail(`${path}.area`, `expected a spawn box from 1 to ${2 * CANVAS_SIDE} pixels per side`);
  return {
    name: emitter.name, at, area, ring, line, start, end, variants, face, play, life, remaps, tint, trail, attract, sway, turbulence, route, spin, sweep, throttle, ease: easing, parent, when, cue, blob, sprite, release, pixel, drawOnly, depth,
    directions: face ? variants.map((_, k) => [cosDeg(360 * k / variants.length), sinDeg(360 * k / variants.length)]) : null,
    inherit: number(emitter.inherit ?? 0, `${path}.inherit`, 0, 2), behind: flag(emitter.behind, `${path}.behind`),
    burst: emitter.burst === undefined ? null : integer(emitter.burst, `${path}.burst`, 1, 1024),
    rate: emitter.rate === undefined ? null : rateTotals ? rateTotals.at(-1) / (end - start) : number(emitter.rate, `${path}.rate`, 0.001, 64), rateTotals,
    // Measured from each particle's outward direction on an outward ring, where it defaults to straight out.
    angle: range(emitter.angle ?? (ring?.outward ? 0 : [0, 360]), `${path}.angle`, -3600, 3600),
    speed: range(emitter.speed ?? 0, `${path}.speed`, 0, 64),
    gravity: emitter.gravity === undefined ? [0, 0] : pair(emitter.gravity, `${path}.gravity`, -8, 8),
    drag: number(emitter.drag ?? 0, `${path}.drag`, 0, 1),
    floor: emitter.floor === undefined ? null : integer(emitter.floor, `${path}.floor`, -4096, 4096),
    // ground: a floor that many pixels below where each particle was born, so particles thrown up from a ring laid on the
    // ground land back on their own patch of it.
    ground: emitter.ground === undefined ? null : number(emitter.ground, `${path}.ground`, -CANVAS_SIDE, CANVAS_SIDE),
    // kick: a velocity [x, y] added to every launch, whatever its angle: outward shards on a ring laid on the ground pop
    // up as they fly out. It turns with a turned copy, as launch angles do.
    kick: emitter.kick === undefined ? null : pair(emitter.kick, `${path}.kick`, -64, 64),
    bounce: number(emitter.bounce ?? 0, `${path}.bounce`, 0, 1),
    // rest: a particle that lands stays where it lands (no slide, sway, spin or loop); with bounce, once a rebound
    // can't lift it.
    rest: flag(emitter.rest, `${path}.rest`),
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
// A share of a squashed ring's perimeter as a parametric angle: random or even angles land evenly along the ellipse
// instead of crowding its narrow ends. Angles in degrees; the table is built once per squash.
const perimeters = new Map();
function perimeterAngle(theta, [sx, sy]) {
  const key = `${sx},${sy}`;
  if (!perimeters.has(key)) {
    const lengths = [0];
    for (let k = 1; k <= 360; k++) { const dx = sx * (cosDeg(k) - cosDeg(k - 1)), dy = sy * (sinDeg(k) - sinDeg(k - 1)); lengths.push(lengths[k - 1] + Math.sqrt(dx * dx + dy * dy)); }
    perimeters.set(key, lengths);
  }
  const lengths = perimeters.get(key), turns = Math.floor(theta / 360), d = (theta - turns * 360) / 360 * lengths[360];
  let low = 0, high = 359;
  while (low < high) { const mid = (low + high + 1) >> 1; if (lengths[mid] <= d) low = mid; else high = mid - 1; }
  const span = lengths[low + 1] - lengths[low];
  return turns * 360 + low + (span > 0 ? (d - lengths[low]) / span : 0);
}
const evenAngle = ([from, to], k, count) => (to - from >= 360 ? from + 360 * k / count : count === 1 ? (from + to) / 2 : from + (to - from) * k / (count - 1));

// What to lower when a release passes a particle limit: it has no burst or rate, its particles are a share of its
// sprite's pixels. `fits` says whether the release fits every limit with another share (what it would spawn with that
// share, frame by frame beside the other emitters); a larger share releases the same pixels and more, so the largest
// share that fits is found by halving, below the share written (or, when `fits` passes that one, below `guess`, the
// share that leaves the particles counted within the limit), and named rounded down to two figures. `fits` weighs the
// release's own particles only (its children, the emitters whose from chain leads to it, go with it, and are not among
// the others it is weighed beside), so a share is named only once `holds` has passed it: the effect simulated again
// with that share (simulate's shareHolds). Where it does not, smaller shares are simulated, halving and then
// bisecting; a smaller share releases a subset of the same pixels, and their children a subset of theirs. When even a
// share of 0 does not fit, the other emitters alone take the limit, and null leaves that for the caller to say.
function releaseAdvice(e, index, guess, fits, holds = fits) {
  if (!fits(0) || !holds(0)) return null;
  const cells = e.sprite.frames[0].cells.length, share = e.release.share;
  let low = 0, high = fits(share) ? Math.min(share, Math.max(0, guess)) : share;
  if (fits(high)) low = high;
  else for (let step = 0; step < 48; step++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; }
  const rounded = value => {
    if (value <= 0) return 0;
    let k = 0, scale = 1;
    while (value * scale < 10) { k++; scale *= 10; }
    return Number((Math.floor(value * scale) / scale).toFixed(k));
  };
  let fit = rounded(low);
  if (fit > 0 && !holds(fit)) {
    let good = 0, bad = fit;
    for (let s = fit / 2, step = 0; step < 14; step++, s /= 2) { if (holds(s)) { good = s; break; } bad = s; }
    if (good > 0) for (let step = 0; step < 6; step++) { const mid = (good + bad) / 2; if (holds(mid)) good = mid; else bad = mid; }
    fit = rounded(good);
    if (fit > 0 && !holds(fit)) fit = 0;
  }
  const lower = fit > 0 ? `lower its release.share (about ${fit} fits)` : 'set its release.share to 0 (no larger share fits beside the others, and 0 releases none of them)';
  return `emitters[${index}] releases ${share < 1 ? `a ${share} share of` : 'every one of'} its sprite's ${cells.toLocaleString('en-US')} pixels: ${lower} or use a smaller sprite`;
}
// The emitters whose particles come from emitter `index`'s: it and its children, theirs, and so on (a child's parent is
// read before it).
function family(emitters, index) {
  const set = new Set([index]);
  emitters.forEach((e, i) => { if (e.parent !== null && e.parent !== undefined && set.has(e.parent)) set.add(i); });
  return set;
}

const and = items => (items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
// What to lower for the emitters at `indexes` (named by `who`) when there are too many particles alive at once
// (`alive`) or spawned: burst, rate (and life) for an emitter that has them, and a release's share (and life).
function lowering(emitters, indexes, who, alive) {
  const releases = indexes.filter(i => emitters[i].release).map(who), plain = alive ? 'burst, rate or life' : 'burst or rate', share = alive ? 'release.share or life' : 'release.share';
  if (!releases.length) return `lower ${plain}`;
  return releases.length === indexes.length ? `lower ${share}` : `lower ${plain} (${share} for ${and(releases)})`;
}

// Simulates one effect and returns its frames' operations plus counts for the metadata.
function simulate(effect, context) {
  const { frames, loop, seed, emitters, view, solid } = effect, { width, height, symbols } = context;
  // A symbol turned k × 45°, made once per compile and added to the recipe's symbols after every effect is read, so no
  // effect can name one another effect happened to make.
  const spun = (name, k) => {
    const key = `${name}_r${k * 45}`;
    if (!context.spun.has(key)) {
      if (Object.hasOwn(symbols, key)) fail(`fx.symbols.${key}`, `a spinning particle names its turned ${name} ${key}; rename this symbol`);
      const rows = symbols[name], { rows: out, pivot } = rotateRows(rows, k * 45, [Math.floor(rows[0].length / 2), Math.floor(rows.length / 2)]);
      context.spun.set(key, { name: key, pivot, rows: out });
    }
    return context.spun.get(key);
  };
  // The direction this copy of the effect is turned to (null as drawn): spawn places, spawn offsets, launch angles and
  // attract points turn with it; gravity, drag, floors, sway and turbulence stay as they are, so particles still fall down
  // the canvas.
  const offset = view ? (dx, dy) => view.vec(dx, dy) : (dx, dy) => [dx, dy], heading = view ? theta => view.dir(theta) : theta => theta;
  // A moving emitter's centre in frame `cycle`: along its path, spread over its window from start to end as a layer's
  // keys are over its frames (progress (cycle − start) / (end − start)), so a trail keeps pace with a layer that has the
  // same window, and a loop's path closes on itself.
  const along = (route, cycle, e) => {
    // A path round the whole loop wraps, so spawns spread back from frame 0 come from the end of the path.
    const x = (cycle - e.start) / (e.end - e.start), whole = loop && e.start === 0 && e.end === frames;
    const share = whole ? x - Math.floor(x) : Math.min(1, Math.max(0, x)), t = e.ease ? ease(e.ease, share) : share;
    return route.walk(t);
  };
  // A moving emitter's velocity at spawn time `at`: its step over the frame before, read inside its window (before start
  // the first frame's step, after end the last's), so every spawn of a frame inherits the same speed and a pause inherits 0.
  const velocity = (e, at) => {
    const b = loop && e.start === 0 && e.end === frames ? at : Math.min(e.end, Math.max(at, e.start + 1)), [ax, ay] = centre(e, b - 1), [bx, by] = centre(e, b);
    return { vx: bx - ax, vy: by - ay };
  };
  const centre = (e, cycle) => { const at = e.route ? along(e.route, cycle, e) : e.at; return view ? view.point(at) : at; }, pulls = emitters.map(e => (e.attract && view ? view.point(e.attract.at) : e.attract?.at));
  // A loop warms up for as many whole cycles as the longest chain of lives (a child's particles can outlive their parent's
  // by their own life), with spawns keyed by their frame within the cycle and children by their parent, so the particles
  // in flight at frame 0 are exactly those still alive at the end.
  const chain = [];
  // A sprite emitter that only draws has no particles to wait for.
  emitters.forEach((e, i) => { chain[i] = e.drawOnly ? 0 : (e.life ? e.life[1] : Infinity) + (e.parent === null ? 0 : chain[e.parent]); });
  const warmup = loop ? Math.ceil(Math.max(...chain) / frames) : 0, total = (warmup + 1) * frames, first = warmup * frames;
  // The child emitters of each emitter, by the event they spawn at.
  const children = emitters.map((_, i) => Object.fromEntries(['death', 'floor'].map(when => [when, emitters.flatMap((e, j) => (e.parent === i && e.when === when ? [j] : []))])));
  // A loop draws one frame more, the next cycle's first, which the seam review compares with frame 0 (see `next`).
  const perFrame = () => Array.from({ length: frames + (loop ? 1 : 0) }, () => []);
  const alive = [], output = perFrame(), behind = perFrame(), blobs = perFrame(), cues = Array.from({ length: frames }, () => ({}));
  // Behind a character: the back particles' own two passes; between: stand-in sprites. Both stay empty unless an emitter
  // asks for them.
  const back = { output: perFrame(), behind: perFrame() }, between = perFrame();
  // For the effect's light (see lightFrames): the grids that draw sprites, and each frame's pixels of the sprites the
  // light can't pass (`solid`, the indexes of their emitters), or null.
  const props = new WeakSet(), solids = solid?.size ? perFrame().map(() => null) : null;
  const stats = emitters.map(e => ({ ...(e.name && { name: e.name }), spawned: 0, maxAlive: 0, ...(e.sprite && { pixels: e.sprite.frames[0].cells.length }) }));
  let operations = 0, culled = 0;
  // What every effect of a compile simulates holds LIMITS.simulated (context.simulated, shared), so the work is bounded
  // before the frames a recipe delivers are held to LIMITS.operations (compileEffects). thinned: compile --frames keeps
  // fewer of this effect's frames than it makes (context.keep), though every one is simulated.
  const thinned = context.keep < frames, before = context.simulated.spent;
  // What each of the effect's own frames draws and spawns, for the frames route its refusals name (framesRoute).
  const byFrame = { ops: new Array(frames).fill(0), spawned: new Array(frames).fill(0) };
  // A trial (compileEffects `rerun`) reads them even when the effect is refused, with how many frames were recorded.
  if (context.trial) { context.trial.byFrame = byFrame; context.trial.known = 0; }
  // How many particles of each emitter are alive in each of the effect's own frames.
  const aliveAt = Array.from({ length: frames }, () => new Array(emitters.length).fill(0));
  const who = i => emitters[i].name ?? `emitters[${i}]`;
  // Past the particles alive at once, the effect is simulated on, drawing nothing, to say how many it keeps alive at its
  // peak and whose they are (crowd), up to CROWD; or, when a release holds most of them (blamed), what share of it
  // fits beside what the other emitters keep alive and spawn in all.
  let crowded = false, crowd = null, blamed = null;
  const CROWD = 4 * LIMITS.alive;
  const census = () => {
    const by = emitters.map(() => 0);
    for (const p of alive) by[p.index]++;
    return { total: alive.length, by };
  };
  const overcrowded = () => {
    if (blamed) {
      // What the other emitters keep alive is judged frame by frame (aliveAt), with the release's own at that share
      // beside it; where it is called before the effect's last frame, what they keep alive now counts too. The
      // release's children (its family) are part of it: a smaller share spawns fewer of them, so they are not among
      // the others, and a share is named once the effect simulated with it holds (shareHolds).
      const { e, index, made, room } = blamed, own = family(emitters, index), others = counts => counts.reduce((sum, n, i) => sum + (own.has(i) ? 0 : n), 0);
      const now = census().by, frameOthers = aliveAt.map(others), spawnedOthers = stats.reduce((sum, s, i) => sum + (own.has(i) ? 0 : s.spawned), 0);
      const fits = share => {
        const r = released(index, share);
        if (r.spawned > LIMITS.spawned - spawnedOthers || others(now) > LIMITS.alive) return false;
        for (let t = 0; t < frames; t++) if (frameOthers[t] + r.at[t] > LIMITS.alive) return false;
        return true;
      };
      const advice = releaseAdvice(e, index, e.release.share * Math.max(0, room) / made, fits, share => shareHolds(index, share));
      if (advice) fail(context.path, `more than ${LIMITS.alive} particles are alive at once; ${advice}`);
      // No share fits: the other emitters alone take a limit, whatever the release does: alive at once in one frame
      // (the most crowded), or spawned in all. Where they do not, but the effect simulated with a share of 0 still
      // fails, the crowd is said as it is, below.
      if (!fits(0)) {
        let worst = -1;
        frameOthers.forEach((n, t) => { if (n > LIMITS.alive && (worst < 0 || n > frameOthers[worst])) worst = t; });
        const alone = worst >= 0 || others(now) > LIMITS.alive, by = worst >= 0 ? aliveAt[worst] : alone ? now : stats.map(s => s.spawned);
        const rest = [...by].map((n, i) => [n, i]).filter(([n, i]) => !own.has(i) && n).sort((a, b) => b[0] - a[0]);
        const where = worst >= 0 ? ` in frame ${worst}` : '';
        fail(context.path, `more than ${LIMITS.alive} particles are alive at once, and no share of ${who(index)}'s release fits: ${alone ? `the other emitters alone keep more than ${LIMITS.alive} alive${where}` : `the other emitters alone spawn more than ${LIMITS.spawned}`} (${rest.slice(0, 5).map(([n, i]) => `${who(i)} ${n.toLocaleString('en-US')}`).join(', ')}); ${lowering(emitters, rest.slice(0, 5).map(([, i]) => i), who, alone)}`);
      }
    }
    const shares = crowd.by.map((n, i) => [n, i]).filter(([n]) => n).sort((a, b) => b[0] - a[0]);
    const named = shares.slice(0, 5).map(([n, i]) => `${who(i)} ${n.toLocaleString('en-US')}`).concat(shares.length > 5 ? [`${shares.length - 5} more`] : []);
    const many = crowd.total > CROWD ? `more than ${CROWD.toLocaleString('en-US')}` : `about ${crowd.total.toLocaleString('en-US')}`;
    fail(context.path, `more than ${LIMITS.alive} particles are alive at once (${many}: ${named.join(', ')}); ${lowering(emitters, shares.slice(0, 5).map(([, i]) => i), who, true)}`);
  };
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
    // leaving: each pixel's frame; picked: the draw a share is compared with (what another share would release).
    const due = Array.from({ length: frames }, () => []), leaves = new Map(), leaving = new Int32Array(cells.length), picked = new Float64Array(cells.length);
    cells.forEach((c, i) => {
      const order = sweep === null || high - low < 1e-9 ? 0 : (along[i] - low) / (high - low);
      const frame = e.start + Math.min(span - 1, Math.floor(((1 - jitter) * order + jitter * random(seed, index, -1, i, SALT.release)) * span));
      if (c.key !== null) leaves.set(c.y * w + c.x, frame);
      leaving[i] = frame; picked[i] = random(seed, index, -1, i, SALT.share);
      if (share >= 1 || picked[i] < share) due[frame].push(i);
    });
    return { due, leaves, leaving, picked };
  });
  // What a release would spawn with another share: in all, and alive at once in each frame (`at`, each pixel living
  // its longest life), for the share its refusals name (releaseAdvice).
  const released = (index, share) => {
    const { leaving, picked } = releases[index], counts = new Array(frames).fill(0), at = new Array(frames).fill(0), e = emitters[index], span = e.life ? e.life[1] : frames;
    for (let i = 0; i < leaving.length; i++) if (share >= 1 || picked[i] < share) counts[leaving[i]]++;
    let spawned = 0;
    for (let t = 0, sum = 0; t < frames; t++) { spawned += counts[t]; sum += counts[t] - (t >= span ? counts[t - span] : 0); at[t] = sum; }
    return { spawned, at };
  };
  // Whether the effect holds every particle limit and the compile's simulation with release `index` at another share:
  // simulated again from where this one started, as a confirmation (context.confirm), which stops at the first limit
  // passed and names no route. Nothing of it is kept.
  const shareHolds = (index, share) => {
    const changed = emitters.map((e, i) => (i === index ? { ...e, release: { ...e.release, share } } : e));
    try {
      const run = simulate({ ...effect, emitters: changed }, { ...context, simulated: { spent: before }, trial: null, plan: null, earlier: null, confirm: true });
      return run.stats.reduce((sum, s) => sum + s.spawned, 0) <= LIMITS.spawned;
    } catch (error) {
      if (error instanceof PixelError) return false;
      throw error;
    }
  };
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
    const raw = Math.min(1, Math.max(0, (born % frames - e.start) / (e.end - e.start))), share = e.ease ? ease(e.ease, raw) : raw;
    if (e.sprite) {
      // On one of the sprite's pixels (of the frame showing): the released one, or a seeded pick.
      const { cells } = e.sprite.frame(born % frames), c = cell ?? cells[Math.min(cells.length - 1, Math.floor(r(SALT.pixel) * cells.length))];
      x = e.sprite.x + c.x; y = e.sprite.y + c.y; key = c.key;
    } else if (e.ring) {
      const { radius, arc, even, outward, squash, grow, fill } = e.ring;
      // A full even ring on a rate emitter turns to a fresh seeded angle each frame, so its spokes don't repeat.
      const turnBy = even && e.rate !== null && arc[1] - arc[0] >= 360 ? random(seed, index, loop ? born % frames : born, -SALT.ring) * 360 / count : 0, picked = even ? evenAngle(arc, k, count) + turnBy : pick(arc, r(SALT.ring));
      const theta = squash ? perimeterAngle(picked, squash) : picked;
      const spread = fill ? Math.sqrt(radius[0] * radius[0] + r(SALT.radius) * (radius[1] * radius[1] - radius[0] * radius[0])) : pick(radius, r(SALT.radius));
      const d = grow ? spread * sample(grow, share) : spread;
      const [ox, oy] = squash ? offset(cosDeg(theta) * d * squash[0], sinDeg(theta) * d * squash[1]) : offset(cosDeg(theta) * d, sinDeg(theta) * d);
      x = cx + ox; y = cy + oy;
      // Outward on a squashed ring points away from its middle, along the squashed offset.
      if (outward) out = squash ? atan2Deg(sinDeg(theta) * squash[1], cosDeg(theta) * squash[0]) : theta;
    } else if (e.line) {
      const s = e.line.even ? (count === 1 ? 0.5 : k / (count - 1)) : r(SALT.along);
      const [ox, oy] = offset(e.line.dx * s, e.line.dy * s);
      x = cx + ox; y = cy + oy;
    } else { const [ox, oy] = offset((r(SALT.x) - 0.5) * (e.area[0] - 1), (r(SALT.y) - 0.5) * (e.area[1] - 1)); x = cx + ox; y = cy + oy; }
    const turned = e.sweep ? sample(e.sweep, share) : 0;
    const angle = heading(out === null ? (e.sweep ? pick(e.angle, r(SALT.angle)) + turned : pick(e.angle, r(SALT.angle))) : e.sweep ? out + pick(e.angle, r(SALT.angle)) + turned : out + pick(e.angle, r(SALT.angle))), speed = e.throttle ? pick(e.speed, r(SALT.speed)) * sample(e.throttle, share) : pick(e.speed, r(SALT.speed));
    const life = e.life ? pickWhole(e.life, r(SALT.life)) : Infinity, variant = e.face ? null : e.variants[Math.min(e.variants.length - 1, Math.floor(r(SALT.variant) * e.variants.length))];
    let vx = cosDeg(angle) * speed, vy = sinDeg(angle) * speed;
    if (e.kick) { const [kx, ky] = offset(e.kick[0], e.kick[1]); vx += kx; vy += ky; }
    if (parent && e.inherit) { vx += parent.vx * e.inherit; vy += parent.vy * e.inherit; }
    // Behind a character: a back emitter's particles, a split one's born above its spawn centre, and a child with no
    // depth of its own whose parent particle is behind.
    const behindCharacter = e.depth === 'back' || (e.depth === 'split' && y < cy) || (e.depth === null && e.parent !== null && parent?.back === true);
    return {
      emitter: e, index, born, life, variant, age: 0, x, y, vx, vy, tag, key, back: behindCharacter,
      remap: e.remaps.length ? e.remaps[Math.min(e.remaps.length - 1, Math.floor(r(SALT.remap) * e.remaps.length))] : null,
      phase: r(SALT.phase) * 360, offset: Math.floor(r(SALT.offset) * 64), trail: [], landed: false, facing: 0, size: e.blob ? pick(e.blob.size, r(SALT.size)) : 1, floor: e.ground !== null ? y + e.ground : e.floor,
      ...(e.spin && { turn: r(SALT.turn) * 360, spin: pick(e.spin, r(SALT.spin)) })
    };
  };
  // Every new particle comes through here, so child emitters that multiply within one frame fail at the limit instead
  // of piling up millions of particles first.
  const add = particle => {
    // A release blamed for the crowd adds no more: the others are simulated on to measure what they keep alive and spawn.
    if (blamed && particle.index === blamed.index) return;
    alive.push(particle);
    if (alive.length <= LIMITS.alive) return;
    // A confirmation (shareHolds) only asks whether the effect holds.
    if (context.confirm) fail(context.path, `more than ${LIMITS.alive} particles are alive at once`);
    if (crowded) {
      if (alive.length > CROWD) { crowd = census(); overcrowded(); }
      return;
    }
    crowded = true; crowd = census();
    // A release is told what to lower only when it holds most of the particles alive, as with those spawned.
    let index = -1;
    emitters.forEach((e, i) => { if (e.release && (index < 0 || crowd.by[i] > crowd.by[index])) index = i; });
    const mine = index < 0 ? 0 : crowd.by[index];
    if (mine * 2 <= alive.length) return;
    // A release's particles alive at once peak where the most pixels leave within one life (its longest), which is
    // known before they are simulated; what is alive now is only the start of it.
    const e = emitters[index], due = releases[index].due, span = e.life ? e.life[1] : due.length;
    let peak = 0;
    for (let t = 0, sum = 0; t < due.length; t++) { sum += due[t].length - (t >= span ? due[t - span].length : 0); peak = Math.max(peak, sum); }
    blamed = { e, index, made: Math.max(mine, peak), room: LIMITS.alive - (alive.length - mine) };
  };
  // Children of particle q, born in frame `born`: keyed by the parent's tag and age, so a looping parent has the same
  // children every cycle.
  // While a parent lives (spread), the children a frame spawns spread along the stretch it moved since the last frame,
  // the last where it is now, so a fast parent leaves an even trail instead of one clump per frame.
  const spawnChildren = (index, q, count, born, spread = false) => {
    const e = emitters[index];
    const [ox, oy] = offset(e.at[0], e.at[1]);
    for (let k = 0; k < count; k++) {
      const r = salt => random(q.tag, index, q.age, k, salt), back = spread && q.px !== undefined && k < count - 1;
      const x = back ? q.px + (q.x - q.px) * (k + 1) / count : q.x, y = back ? q.py + (q.y - q.py) * (k + 1) / count : q.y;
      add(launch(e, index, x + ox, y + oy, k, count, r, hash(q.tag, index, q.age, k), born, q));
      // Counted as its parents' spawns are: born in one of the effect's own frames, not in the one after a loop's last.
      if (born >= first && born < total) { stats[index].spawned++; byFrame.spawned[born - first]++; }
    }
    if (count) mark(e, born, q.x + ox, q.y + oy);
  };
  const layered = emitters.some(e => e.behind);
  // kept: what a one-shot's last frame shows of the sprites it draws (a prop, a stand-in, an animation played frame for
  // frame), which is not something the effect left behind (the residue review). A release has taken its sprite apart
  // by then.
  let counted = null, kept = null;
  const end = total + (loop ? 1 : 0);
  for (let t = 0; t < end; t++) {
    // recording: one of the effect's own frames; the frame after a loop's last is drawn but not counted.
    const cycle = t % frames, drawing = t >= first && !crowded, recording = t >= first && t < total, opsBefore = operations;
    if (t === total) counted = { operations, culled };
    emitters.forEach((e, index) => {
      if (e.parent !== null) return;
      // A release spawns from the pixels leaving this frame, each keyed by its place in the sprite.
      if (e.release) {
        const due = releases[index].due[cycle];
        due.forEach((i, k) => {
          add(launch(e, index, 0, 0, k, due.length, salt => random(seed, index, -1, i, salt), hash(seed, index, -1, i), t, null, e.sprite.frames[0].cells[i]));
          if (recording) { stats[index].spawned++; byFrame.spawned[cycle]++; }
        });
        if (due.length) mark(e, t, e.at[0], e.at[1]);
        return;
      }
      // A sprite that only draws spawns nothing, nor does one whose frame showing has no pixels to spawn from.
      if ((e.burst === null && e.rate === null) || (e.sprite && !e.sprite.frame(cycle).cells.length)) return;
      let count = 0;
      if (e.burst !== null) count = cycle === e.start ? e.burst : 0;
      else if (cycle >= e.start && cycle < e.end) {
        const c = cycle - e.start, totals = e.rateTotals;
        count = totals ? Math.floor(totals[c + 1] + 1e-9) - Math.floor(totals[c] + 1e-9) : Math.floor((c + 1) * e.rate + 1e-9) - Math.floor(c * e.rate + 1e-9);
      }
      const key = loop ? cycle : t;
      for (let k = 0; k < count; k++) {
        // A moving emitter spreads a frame's spawns along the stretch it travelled since the last frame, the last at its
        // place now, so a fast trail stays even instead of leaving one clump per frame.
        const at = cycle - 1 + (k + 1) / count, [cx, cy] = e.route ? centre(e, at) : centre(e, cycle);
        // With inherit, a moving emitter hands its particles that share of its own velocity along the path.
        const moving = e.route && e.inherit ? velocity(e, at) : null;
        add(launch(e, index, cx, cy, k, count, salt => random(seed, index, key, k, salt), hash(seed, index, key, k), t, moving));
        if (recording) { stats[index].spawned++; byFrame.spawned[cycle]++; }
      }
      if (count) mark(e, t, centre(e, cycle)[0], centre(e, cycle)[1]);
    });
    // Children that spawn while their parents live: `rate` per frame for each parent particle, from where it is.
    emitters.forEach((e, index) => {
      if (e.when !== 'life') return;
      for (let i = 0, parents = alive.length; i < parents; i++) {
        const q = alive[i];
        if (q.index === e.parent) spawnChildren(index, q, Math.floor((q.age + 1) * e.rate + 1e-9) - Math.floor(q.age * e.rate + 1e-9), t, true);
      }
    });
    if (crowded && alive.length > crowd.total) crowd = census();
    if (recording) {
      const counts = aliveAt[cycle];
      for (const p of alive) counts[p.index]++;
      emitters.forEach((e, index) => { stats[index].maxAlive = Math.max(stats[index].maxAlive, counts[index]); });
      if (context.trial) context.trial.known = cycle + 1;
    }
    // Every live particle's rounded (and swayed) position. Sway never carries a particle below its floor. A facing
    // particle turns with its velocity in every frame, warm-up included, so a loop's frame 0 continues its last frame.
    const places = alive.map(p => {
      const e = p.emitter, sway = e.sway;
      // A particle at rest holds the sideways sway it had when it stopped, and lies on its floor.
      const age = p.still ?? p.age, sx = sway ? sway.amplitude[0] * sinDeg(360 * age / sway.period + p.phase) : 0, sy = sway && p.still === undefined ? sway.amplitude[1] * cosDeg(360 * age / sway.period + p.phase) : 0;
      const x = p.x + sx, y = p.floor !== null && p.y + sy > p.floor ? p.floor : p.y + sy, X = Math.floor(x + 0.5), Y = Math.floor(y + 0.5);
      p.trail.push([X, Y]);
      // Where it stands as its dissolve begins: the pattern it thins through is anchored there and moves with it.
      if (e.dissolve && p.faded === undefined && p.age >= p.life - Math.ceil(e.dissolve * p.life)) p.faded = [X, Y];
      if (p.trail.length > 17) p.trail.shift();
      if (e.face) p.facing = facing(e, p.vx, p.vy, p.facing);
      return [X, Y, x, y];
    });
    // Draw oldest first, with `behind` emitters' particles under everyone else's. Particles partly off the canvas are
    // cropped into grid operations and trails keep only their on-canvas pixels, so nothing clips.
    const sheets = drawing ? emitters.map((e, index) => (e.sprite && (e.sprite.draw || e.pixel) ? sheet(e, index, t) : null)) : null;
    if (drawing && !loop && t === total - 1) emitters.forEach((e, index) => {
      if (!e.sprite?.draw || !sheets[index]?.any) return;
      kept ??= new Uint8Array(width * height);
      const { chars } = sheets[index];
      for (let c = 0; c < chars.length; c++) if (chars[c]) kept[c] = 1;
    });
    // What is left of a solid sprite, before its own pixel particles are drawn into its sheet.
    if (drawing && solids) for (const index of solid) {
      if (!sheets[index]?.any) continue;
      const mask = (solids[t - first] ??= new Uint8Array(width * height)), { chars } = sheets[index];
      for (let c = 0; c < chars.length; c++) if (chars[c]) mask[c] = 1;
    }
    if (drawing) for (const pass of layered ? [true, false] : [null]) alive.forEach((p, i) => {
      const e = p.emitter;
      if (pass !== null && e.behind !== pass) return;
      const [X, Y] = places[i], side = p.back ? back : { output, behind }, ops = (pass === true ? side.behind : side.output)[t - first], span = Number.isFinite(p.life) ? p.life : frames - (p.born - first);
      if (e.blob) {
        // Its radius moves through the keys over its life; the shape layers' grid draws it.
        const age = Math.min(1, p.age / Math.max(1, span - 1)), radius = sample(e.blob.radius, age) * p.size, [, , x, y] = places[i], power = e.blob.power ? sample(e.blob.power, age) : 1;
        if (radius > 0 && power > 0 && x + radius > 0 && y + radius > 0 && x - radius < width && y - radius < height) blobs[t - first].push({ look: e.blob.look, x, y, radius, ...(power !== 1 && { power }), ...(p.back && { back: true }) });
        else culled++;
        return;
      }
      const share = stages => Math.min(stages - 1, Math.floor(p.age / span * stages));
      // The last `dissolve` share of a life thins out through an ordered-dither pattern, laid on the canvas where the
      // particle stood as it began to dissolve and moving with it from there: particles that stay put thin out in step
      // with each other, and one that travels loses its pixels in one fixed order instead of blinking as it crosses the
      // pattern. (x, y) is a pixel on the canvas.
      const fading = e.dissolve ? Math.ceil(e.dissolve * p.life) : 0, into = p.age - (p.life - fading);
      const progress = fading && into >= 0 ? (into + 1) / (fading + 1) : 0, gone = (x, y) => progress > 0 && e.threshold(x - X + p.faded[0], y - Y + p.faded[1]) < progress;
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
        if (progress && gone(X, Y)) return;
        const s = sheets[p.index];
        s.chars[Y * width + X] = (whole ? stage : colours?.[p.key] ?? p.key).charCodeAt(0); s.any = true;
        return;
      }
      const sequence = e.face ? e.variants[p.facing] : p.variant;
      const step = e.play === 'loop' ? ((p.still ?? p.age) + p.offset) % sequence.length : e.play === 'once' ? Math.min(p.age, sequence.length - 1) : share(sequence.length);
      // A spinning particle draws its symbol turned to the nearest 45° step (the other way in a mirrored copy), its middle
      // pixel kept on the particle.
      const k = e.spin ? (((Math.round((p.turn + p.spin * (p.still ?? p.age)) / 45) % 8) + 8) % 8) : 0, turned = k ? spun(sequence[step], view?.mirror ? 8 - k : k) : null;
      const symbol = turned ? turned.name : sequence[step], rows = turned ? turned.rows : symbols[symbol], w = rows[0].length, h = rows.length;
      // Its middle pixel is on the particle, but none of it goes below its floor: a symbol three pixels tall would hang a
      // row under the floor it lands on, and a spinning one came to rest a row lower upright than lying on its side.
      const left = X - (turned ? turned.pivot[0] : Math.floor(w / 2)), middle = Y - (turned ? turned.pivot[1] : Math.floor(h / 2)), top = p.floor === null ? middle : Math.min(middle, Math.floor(p.floor + 0.5) - h + 1);
      if (left >= width || top >= height || left + w <= 0 || top + h <= 0) { culled++; return; }
      const recolour = whole ? { ...p.remap, ...Object.fromEntries([...new Set(rows.join(''))].filter(char => !clear(char)).map(char => [char, stage])) } : colours;
      const remap = recolour && Object.keys(recolour).length ? { remap: recolour } : {};
      const x0 = Math.max(0, -left), y0 = Math.max(0, -top), x1 = Math.min(w, width - left), y1 = Math.min(h, height - top);
      if (!progress && x0 === 0 && y0 === 0 && x1 === w && y1 === h) { ops.push({ op: 'stamp', symbol, x: left, y: top, ...remap }); operations++; return; }
      const kept = rows.slice(y0, y1).map((row, j) => [...row.slice(x0, x1)].map((char, i) => (char === ' ' || gone(left + x0 + i, top + y0 + j) ? '.' : char)).join(''));
      if (kept.some(row => /[^.]/.test(row))) { ops.push({ op: 'grid', x: left + x0, y: top + y0, rows: kept, ...remap }); operations++; }
    });
    // Each sprite emitter's grid (what is left of its sprite, under its pixel particles, oldest first) is cropped to its
    // drawn pixels and goes first in its pass, in emitter order, under the particles drawn as symbols.
    // A stand-in (depth between) draws only between the back and the front, never in either.
    if (drawing) {
      const leading = { true: [], false: [] }, leadingBack = { true: [], false: [] };
      emitters.forEach((e, index) => {
        const s = sheets[index];
        if (!s?.any) return;
        let x0 = width, y0 = height, x1 = -1, y1 = -1;
        for (let c = 0; c < s.chars.length; c++) if (s.chars[c]) { const x = c % width, y = (c - x) / width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        const rows = [];
        for (let y = y0; y <= y1; y++) { let row = ''; for (let x = x0; x <= x1; x++) { const code = s.chars[y * width + x]; row += code ? String.fromCharCode(code) : '.'; } rows.push(row); }
        const grid = { op: 'grid', x: x0, y: y0, rows };
        props.add(grid);
        if (e.depth === 'between') between[t - first].push(grid);
        else (e.depth === 'back' ? leadingBack : leading)[e.behind].push(grid);
        operations++;
      });
      output[t - first].unshift(...leading.false);
      behind[t - first].unshift(...leading.true);
      back.output[t - first].unshift(...leadingBack.false);
      back.behind[t - first].unshift(...leadingBack.true);
    }
    // Advance: velocity gains gravity and attraction, loses drag, moves the particle, then meets the floor. A particle
    // that ends or first lands hands the event to its children, which appear there in the next frame.
    const events = [];
    for (let i = alive.length - 1; i >= 0; i--) {
      const p = alive[i], e = p.emitter;
      p.age++;
      if (p.age >= p.life) { if (children[p.index].death.length) events.push([p, 'death']); alive.splice(i, 1); continue; }
      // At rest on its floor (rest), nothing moves it again, and children it trails spawn where it lies.
      if (p.still !== undefined) { p.px = p.x; p.py = p.y; continue; }
      p.vx += e.gravity[0]; p.vy += e.gravity[1];
      if (e.turbulence) { const { strength, x, y } = e.turbulence; p.vx += (x(p.x, p.y) - 0.5) * 2 * strength; p.vy += (y(p.x, p.y) - 0.5) * 2 * strength; }
      if (e.attract) {
        const pull = pulls[p.index], dx = pull[0] - p.x, dy = pull[1] - p.y, distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 0.5) {
          // A mirrored copy swirls the other way, as its mirror image would.
          const swirl = view?.mirror ? -e.attract.swirl : e.attract.swirl;
          p.vx += dx / distance * e.attract.strength; p.vy += dy / distance * e.attract.strength;
          if (swirl) { p.vx += dy / distance * swirl; p.vy -= dx / distance * swirl; }
        }
      }
      p.vx *= 1 - e.drag; p.vy *= 1 - e.drag;
      p.px = p.x; p.py = p.y;
      p.x += p.vx; p.y += p.vy;
      if (p.floor !== null && p.y > p.floor) {
        p.y = p.floor;
        if (p.vy > 0) p.vy = -p.vy * e.bounce;
        if (!p.landed) { p.landed = true; if (children[p.index].floor.length) events.push([p, 'floor']); }
        // With rest, a landing whose rebound can't lift it (slower than its gravity or half a pixel a frame; every
        // landing, without bounce) stops it. Children it lands with (when: floor) still inherit the landing's velocity.
        if (e.rest && p.vy > -Math.max(0.5, e.gravity[1])) {
          if (events.at(-1)?.[0] === p) events[events.length - 1] = [{ ...p }, 'floor'];
          p.vx = 0; p.vy = 0; p.still = p.age;
        }
      }
    }
    // In the parents' drawing order. After the last frame there is no next one to appear in, so an effect that plays
    // once is not held to the limit on particles alive by children it never shows.
    if (t + 1 < end) for (let k = events.length - 1; k >= 0; k--) { const [q, when] = events[k]; for (const index of children[q.index][when]) spawnChildren(index, q, emitters[index].burst, t + 1); }
    if (recording) byFrame.ops[cycle] = operations - opsBefore;
    if (counted) ({ operations, culled } = counted);
    if (!crowded && before + operations > LIMITS.simulated) {
      // The frames to name are measured on those drawn so far (framesRoute): what fits the compile's simulation, the
      // particles spawned and what the recipe delivers, all at once.
      // A trial (compileEffects `rerun`) is told no route: it only asks whether the effect holds.
      const drawn = Math.min(frames, Math.max(1, t - first + 1)), need = Math.ceil(operations * frames / drawn);
      const plan = context.plan?.(), route = plan ? framesRoute(byFrame, drawn, loop, context.keep, plan) : null;
      // The effects before it are named with their shares; when not one of this effect's frames fits beside them, the
      // route is the largest one's frames (compileEffects `earlier`), leaving this one what it needs to simulate and,
      // n of each animation's frames kept, about what it delivers.
      const delivers = n => Math.ceil((operations / drawn + plan.extra) * Math.min(frames, n ?? frames) * plan.weight);
      const earlier = before && context.earlier ? context.earlier(need, !route, delivers) : null;
      fail(context.path, `the effect ${thinned ? `simulates all ${frames} of its frames, kept or not, and ` : ''}needs about ${need.toLocaleString('en-US')} drawing operations (${Math.round(operations / drawn)} a frame) of the ${LIMITS.simulated.toLocaleString('en-US')} a compile may simulate${before ? ` (${before.toLocaleString('en-US')} taken by the effects before it${earlier ? `: ${earlier.taken}` : ''})` : ''}: lower burst, rate or trail${route ? routeText(route, frames, context.keep) : earlier?.route ?? ''}`);
    }
  }
  if (crowded) overcrowded();
  // The next cycle's first frame, drawn as the recorded ones are, for the seam review only.
  const next = loop ? { output: output.pop(), behind: behind.pop(), back: { output: back.output.pop(), behind: back.behind.pop() }, between: between.pop(), blobs: blobs.pop(), solid: solids ? solids.pop() : null } : null;
  return { output, behind, back, between, blobs, next, operations, culled, stats, cues, props, solids, kept, released, shareHolds, byFrame };
}

// The frames compile --frames n keeps of an animation of F frames, as resize.js keepFrames thins it: all of them when
// it has no more, a loop's floor(i × F / n), a one-shot's first, its last that draws (drawn(i)) and evenly between.
function keptPicks(F, n, loop, drawn) {
  if (n === undefined || F <= n) return Array.from({ length: F }, (_, i) => i);
  if (loop) return Array.from({ length: n }, (_, i) => Math.floor(i * F / n));
  let last = F - 1;
  while (last >= n && !drawn(last)) last--;
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round(i * last / (n - 1))));
}

// A count of 3 or fewer thins a loop of LONG_LOOP frames or more to almost nothing, so it is never named as a route
// for one: a change to the loop's own frames is, or nothing.
const LONG_LOOP = 24;
const crude = (n, loops) => n <= 3 && loops.some(([, F]) => F > n && F >= LONG_LOOP);

// The loops (`loops`: [name, frames]) a count n would thin unevenly, each given a multiple of n ([name, frames, new
// frames]): the one below its own frames, so it simulates and delivers no more, unless that cuts it by more than a
// quarter and the one above keeps the frames the effects make (`within`, with that change) at most 256.
function evenLoops(n, loops, within = () => true) {
  const below = loops.filter(([, F]) => F > n && F % n).map(([name, F]) => [name, F, n * Math.floor(F / n)]);
  const near = below.map(([name, F, to]) => [name, F, to * 4 < F * 3 ? to + n : to]);
  return within(near) ? near : below;
}

// The count to name for compile --frames, of the `most` that fit: { n, change }. n is the largest at or below most that
// `fits` and thins every loop (`loops`: [name, frames]) evenly, dividing each longer one. Where that is under half of
// most, or a count of 3 or fewer of a long loop (crude), the most that `holds` with a change to those loops' own frames
// (evenLoops: change lists them) is named instead, so following it gives no stutter warning, trying at most
// ROUTE_TRIALS counts from most down to half of it; failing that, n when it is not crude, or null. A count the compile
// was given (`given`) is the caller's own, never crude. A count whose change `holds` turns down on a field ('field':
// a loop given fewer frames than an emitter's start or end, or a layer's frames, need) is not a trial: `holds` says
// so only where it compiled nothing to know it (trialCompile), and the counts below it may leave that loop alone (a
// loop of a prime count is changed only by counts that divide none of the others' frames). Every other answer is a
// trial, so one refusal compiles the source again at most ROUTE_TRIALS times.
function evenFrames(most, loops, fits = () => true, within = () => true, holds = m => fits(m), given) {
  if (most < 1) return null;
  const rough = m => m !== given && crude(m, loops);
  let n = most;
  while (n > 1 && !(loops.every(([, F]) => F <= n || F % n === 0) && fits(n))) n--;
  if (n * 2 >= most && !rough(n)) return { n, change: [] };
  for (let m = most, tries = 0; m * 2 >= most && m > n && !rough(m) && tries < ROUTE_TRIALS; m--) {
    const change = evenLoops(m, loops, within);
    if (!change.length || !fits(m)) continue;
    const held = holds(m, change);
    if (held === true) return { n: m, change };
    if (held !== 'field') tries++;
  }
  return rough(n) || !fits(n) ? null : { n, change: [] };
}

// ' once e1's loop has 140 frames': the loop changes a route names (evenLoops), `single` when the source has one effect.
function onceText(change, single) {
  if (!change?.length) return '';
  if (single && change.length === 1) return ` once the loop has ${change[0][2]} frames`;
  return ` once ${and(change.map(([name, , F], i) => (i ? `${name}'s ${F}` : `${name}'s loop has ${F} frames`)))}`;
}
// A count route's words (evenFrames): `fits` says that frames n fits, `kept` that it does with frames already given,
// and otherwise compile with it. When, with its loops changed, no animation has more than n frames (`thins` false),
// frames thins nothing, and only the loops' new frames are said.
function countText(route, single, thins, form) {
  const { n, change } = route;
  if (!thins && change.length) {
    const loops = single && change.length === 1 ? 'the loop' : change.length === 1 ? `${change[0][0]}'s loop` : `${and(change.map(([name]) => `${name}'s`))} loops`;
    return form === 'compile' ? `give ${loops} ${n} frames` : `giving ${loops} ${n} frames fits`;
  }
  const once = onceText(change, single);
  if (form === 'kept') return `frames ${n} fits${once}`;
  if (form === 'fits') return `frames ${n} fits (pixelbolt compile --frames ${n})${once}`;
  return `compile with frames ${n} (pixelbolt compile --frames ${n})${once}: it keeps that many of each animation's, evenly spaced, without cutting the effect short`;
}

// The frames an effect may make and, with compile --frames (`keep`), keep, for what it simulates, spawns and delivers
// to fit together. It is measured on the first `known` frames the effect made (`byFrame`: each one's operations and
// particles spawned), as an effect of fewer frames makes its first ones (a loop, those of its cycle). `plan` (compileEffects)
// holds the effect as a whole: its copies (turned copies, each simulated) within `simulated`, and the frames delivered,
// `weight` copies of each (a part counting half) with `extra` grid operations each, within `operations(n)` (what the
// effects before it leave with n kept). Each copy spawns at most LIMITS.spawned. With keep, the frames kept come first
// (keep, or the most below it that fit), then the most frames to make, for a loop a multiple of those kept so it thins
// evenly; without keep, the most frames that fit whole, or else kept with frames as with keep. A count named below keep
// also divides the other loops the compile thins (`plan.loops`), or names a change to their frames (evenFrames).
// `plan.rerun` simulates the effect again at the frames named: a loop of fewer frames spawns and draws a little
// differently from the first frames of a longer one, so a route is named only once it holds, stepping down (on what the
// trial measured) until one does, at most ROUTE_TRIALS times. Null when not one frame fits.
const ROUTE_TRIALS = 6;
function framesRoute(byFrame, known, loop, keep, plan) {
  let cap = 257;
  const tried = new Set();
  for (let tries = 0; tries < ROUTE_TRIALS; tries++) {
    const route = framesEstimate(byFrame, known, loop, keep, plan, cap);
    if (!route || !plan.rerun) return route;
    const key = `${route.made}/${route.keep}`;
    if (tried.has(key)) { cap = route.made; continue; }
    tried.add(key);
    const trial = plan.rerun(route.made, route.keep);
    if (trial.holds) return route;
    if (trial.byFrame && trial.known) ({ byFrame, known } = trial);
    if (!trial.delivered) cap = route.made;
  }
  return null;
}
// framesRoute's count from what is measured, with fewer than `cap` frames made.
function framesEstimate(byFrame, known, loop, keep, plan, cap) {
  let most = 0;
  for (let f = 0, ops = 0, spawned = 0; f < Math.min(known, cap - 1); f++) {
    ops += byFrame.ops[f]; spawned += byFrame.spawned[f];
    if (ops * plan.copies > plan.simulated || spawned > LIMITS.spawned) break;
    most = f + 1;
  }
  const room = n => (typeof plan.operations === 'function' ? plan.operations(n) : plan.operations);
  const fits = (made, n) => keptPicks(made, n, loop, f => byFrame.ops[f] > 0).reduce((sum, f) => sum + byFrame.ops[f] + plan.extra, 0) * plan.weight <= room(n);
  if (!keep) {
    for (let made = most; made > 0; made--) if (fits(made)) return { made, keep: made, change: [] };
  }
  const given = keep, loops = plan.loops ?? [], top = Math.min(keep ?? most, most);
  // A count below the one given is proposed, so it never thins this loop or the others to almost nothing (crude).
  const pick = even => {
    for (let n = top; n > 0; n--) {
      if (even && !loops.every(([, F]) => F <= n || F % n === 0)) continue;
      for (let made = most; made >= n; made--) {
        if (loop && (made % n || (n !== given && made > n && crude(n, [['', made]])))) continue;
        if (fits(made, n)) return { made, keep: n, change: [] };
      }
    }
    return null;
  };
  const free = pick(false);
  if (!free || free.keep === free.made || free.keep === given) return free;
  const even = pick(true);
  if (even && even.keep * 2 >= free.keep && !crude(even.keep, loops)) return even;
  if (crude(free.keep, loops)) return null;
  return { ...free, change: evenLoops(free.keep, loops, change => plan.within?.(change, free.made) ?? true) };
}

// A particle refusal's frames route (framesRoute) for an effect of `frames` compiled with `keep`: its frames (`name`'s,
// when the route is another effect's), and the frames kept when fewer than keep (or than it makes) fit; '' when none
// fits.
function routeText(route, frames, keep, name) {
  if (!route) return '';
  const { made, keep: n, change } = route, whose = name ? `${name}'s` : "the effect's";
  const kept = `frames ${n} (pixelbolt compile --frames ${n})${onceText(change, false)}`;
  if (n < made && (!keep || n < keep)) return made < frames ? `, or ${whose} frames: ${made} fit, compiled with ${kept}` : `, or compile with ${kept}`;
  return made < frames ? `, or ${whose} frames (${made} fit)` : '';
}

// What shines in an effect and how its light looks (`shine`). The pixels the effect draws in the colours of `keys`
// shine, each as strongly as its key says (1 is a full light where a body of it is five pixels across; a thin bolt
// wants more; 0 is for the dim colours of a fire, which give no light and take none), and their light spreads by the
// flood in light.js (see lightFrames). Its colours lie on the sprites the effect draws (`colors`, and `dark` where no
// light reaches: then a sprite is drawn as it looks fully lit, and the light is seen by what it leaves dark), on
// whatever else it draws that does not shine (`smoke`) and on the empty pixels (`wall`). `solid` names the sprite
// emitters whose sprite the light can't pass: it is lit on the side the light comes from and dark further in, and
// shadows what is behind it; any other sprite is a flat thing the light lies on by how far it is. `emitters` is the
// effect's emitters as read, or null while they have errors of their own.
function readShine(value, path, context, emitters) {
  if (!isObject(value)) fail(path, 'expected { keys, reach, thresholds } and colors, smoke or wall: the light of what the effect draws in the palette keys of keys');
  const { palette, seed } = context, light = readLight(value, path, { palette, seed, key: paletteKey }, ['keys', 'solid'], { colors: 'the sprites the effect draws', smoke: 'what else it draws' });
  if (!isObject(value.keys) || !Object.keys(value.keys).length || Object.keys(value.keys).length > 16) fail(`${path}.keys`, 'expected 1–16 palette keys that shine, each with how strongly it does (1 is a full light; 0 for a colour of the fire that gives none and takes none): { "W": 1, "y": 0.6, "r": 0 }');
  // Kept by colour, so a remap or a tint to one of these colours shines as its key does.
  const levels = new Map();
  for (const [key, power] of Object.entries(value.keys)) {
    paletteKey(key, `${path}.keys.${key}`, palette);
    levels.set(parseColor(key, palette).join(), number(power, `${path}.keys.${key}`, 0, 8));
  }
  if (![...levels.values()].some(power => power > 0)) fail(`${path}.keys`, 'every key is 0, so nothing would shine');
  const solid = new Set();
  if (value.solid !== undefined) {
    if (!Array.isArray(value.solid) || !value.solid.length || value.solid.length > LIMITS.emitters) fail(`${path}.solid`, 'expected the names of the sprite emitters whose sprite the light can\'t pass');
    value.solid.forEach((name, i) => {
      const at = `${path}.solid[${i}]`;
      identifier(name, at);
      if (value.solid.indexOf(name) !== i) fail(at, 'list each emitter once');
      if (!emitters) return;
      const matches = emitters.flatMap((e, k) => (e.name === name ? [k] : []));
      if (matches.length !== 1) fail(at, matches.length ? `${matches.length} emitters are named ${JSON.stringify(name)}; give the sprite's emitter a unique name` : `no emitter in this effect is named ${JSON.stringify(name)}`);
      if (!emitters[matches[0]].sprite?.draw) fail(at, `${name} draws no sprite; solid names sprite emitters that draw theirs (sprite: { symbol, draw: true })`);
      solid.add(matches[0]);
    });
  }
  return { ...light, levels, solid };
}

// Whether an effect draws anything behind a character, read from the depths written (its emitters' and layers'), so
// it is known before they are read: such an effect also makes <name>-back and <name>-front.
const drawsBehind = effect => (Array.isArray(effect.emitters) && effect.emitters.some(e => isObject(e) && e.depth !== 'front' && EMITTER_DEPTHS.includes(e.depth)))
  || (Array.isArray(effect.layers) && effect.layers.some(l => isObject(l) && l.depth !== 'front' && LAYER_DEPTHS.includes(l.depth)));

// The light of an effect's frames (readShine; the flood is light.js), as grid operations to draw last. Each frame is
// taken as it is drawn: its operations are laid down in order, and the last thing on a pixel says what the pixel is to
// the light: something that shines (a colour of `keys`), a sprite, anything else, or nothing. What shines becomes each
// pixel's power as in a fluid's shine: the mean over the five by five pixels about it, so a body of light lights and a
// lone spark barely does. The flood spreads that; the sprites listed in `solid` drink it. Then each pixel's light
// moves `ease` of the way from the frame before's to what reached it. A loop's first frame follows its last: its light
// is what the cycle played for ever comes to, so the loop runs on through its seam, and the frame after its last (the
// seam review's) is lit exactly as frame 0 is.
// `made` holds each frame's operations (opsAt), `after` those of the frame after a loop's last, and `run` what simulate
// noted. The result gives each frame's grid, and for an effect with parts the back's and the front's: the wall's
// light and the light on what the back draws go behind a character, the light on what the front draws before it, and
// the light on a stand-in is in the whole effect only, since a game lights its own character.
function lightFrames(shine, made, after, run, context) {
  const { width, height, palette, symbols, spun, loop } = context, N = width * height, memory = createLight(width, height);
  const level = new Float64Array(N), across = new Float64Array(N), power = new Float64Array(N), open = new Uint8Array(N);
  // What a colour is to the light: its key's power if it is one of those that shine, −1 if it only shows, −2 if it is
  // fully clear.
  const tones = new Map();
  const tone = color => {
    let known = tones.get(color);
    if (known === undefined) { const rgba = parseColor(color, palette); known = rgba[3] ? shine.levels.get(rgba.join()) ?? -1 : -2; tones.set(color, known); }
    return known;
  };
  let shining = false;
  // One frame as the light meets it: what each pixel is, the side that drew it (1 the back, 2 a stand-in, 3 the
  // front; 0 nothing) when the effect has parts, and the light that reaches each pixel, or null when nothing shines.
  const read = ({ ops, back, between, front }, solid) => {
    const lists = back ? [back, between, front] : [ops], kinds = new Uint8Array(N), sides = back ? new Uint8Array(N) : null;
    level.fill(0);
    lists.forEach((list, k) => {
      const put = (x, y, color, surface) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const strength = tone(color);
        if (strength === -2) return;
        const c = y * width + x;
        level[c] = strength > 0 ? strength : 0; kinds[c] = strength >= 0 ? SHINING : surface ? SURFACE : DRAWN;
        if (sides) sides[c] = k + 1;
      };
      for (const op of list) {
        if (op.op === 'pixel') put(op.x, op.y, op.color, false);
        else if (op.op === 'line') traceLine(op.x, op.y, op.x2, op.y2, (x, y) => put(x, y, op.color, false));
        else {
          const rows = op.op === 'grid' ? op.rows : symbols[op.symbol] ?? spun.get(op.symbol).rows, surface = run.props.has(op), { remap } = op;
          rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (!clear(row[i])) put(op.x + i, op.y + j, remap && Object.hasOwn(remap, row[i]) ? remap[row[i]] : row[i], surface); });
        }
      }
    });
    let any = false;
    for (let c = 0; c < N && !any; c++) any = level[c] > 0;
    if (!any) return { kinds, sides, light: null };
    shining = true;
    meanOfFive(level, across, power, width, height);
    for (let c = 0; c < N; c++) if (power[c] > 1) power[c] = 1;
    return { kinds, sides, light: Float32Array.from(spreadLight(memory, power, solid ?? open, shine.reach, shine.depth)) };
  };
  const reads = made.map((frame, i) => read(frame, run.solids ? run.solids[i] : null)), lit = new Float64Array(N), { ease: share } = shine;
  const step = light => { for (let c = 0; c < N; c++) lit[c] += ((light ? light[c] : 0) - lit[c]) * share; };
  if (loop) {
    // Once round the cycle from the dark, then scaled to what going round it for ever comes to: every turn leaves
    // (1 − ease) to the power of the frame count of the light it began with.
    let left = 1;
    for (const { light } of reads) { step(light); left *= 1 - share; }
    for (let c = 0; c < N; c++) lit[c] /= 1 - left;
  }
  const grids = ({ kinds, sides }, light) => {
    const codes = lightCodes(shine, light, kinds, width, height), whole = codeGrid(codes, width, height);
    return whole && sides ? { whole, back: codeGrid(codes, width, height, c => sides[c] < 2), front: codeGrid(codes, width, height, c => sides[c] === 3) } : { whole };
  };
  let first = null;
  const frames = reads.map((frame, i) => {
    step(frame.light);
    if (!i && after) first = Float64Array.from(lit);
    return grids(frame, lit);
  });
  // The frame after a loop's last is read for what its pixels are, and lit as frame 0 is.
  return { frames, next: after ? grids(read(after, run.next.solid), first) : null, shining };
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
// The sources a symbol, sprite or trail may take frames from: a recipe, or a pose, fluid or wave source compiled first
// (a fluid's or wave's effects are its animations, so a simulated explosion can sit inside an effect).
const SOURCES = { 'pixelforge-poses': compilePoses, 'pixelforge-fluid': compileFluid, 'pixelforge-wave': compileWaves };
// An inline recipe or source, compiled and rendered, with its poses' metadata when it has some.
function loadSource(spec, path) {
  if (typeof spec === 'string' || (isObject(spec) && spec.revision !== undefined && spec.version === undefined)) fail(path, 'file and revision references are resolved by the CLI and MCP; inline the recipe to compile here');
  if (!isObject(spec)) fail(path, 'expected a recipe or a pixelforge-poses, pixelforge-fluid or pixelforge-wave source, inline or as a file reference');
  if (spec.format !== undefined && !Object.hasOwn(SOURCES, spec.format)) fail(path, `expected a recipe or a pixelforge-poses, pixelforge-fluid or pixelforge-wave source, not ${spec.format}`);
  const compiled = spec.format === undefined ? null : SOURCES[spec.format](spec), recipe = compiled?.recipe ?? spec;
  return { recipe, project: renderProject(recipe), poses: spec.format === 'pixelforge-poses' ? compiled.metadata.poses : null };
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
  if (!isObject(entry)) fail(path, 'expected rows, or { recipe, frame } or { recipe, animation }: a frame or an animation of a recipe or a pose, fluid or wave source');
  fields(entry, ['recipe', 'frame', 'animation'], path);
  const source = loadSource(entry.recipe, `${path}.recipe`), { project } = source;
  if (!frameFits(project.width, project.height)) fail(`${path}.recipe`, `${frameAreaProblem(project.width, project.height)}, and a symbol or sprite taken from a recipe spans that recipe's canvas, so it is held to one`);
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

// Turned copies of an effect: `turn: { angles, about, mirror }` compiles one copy per angle (and a mirrored one of each),
// named <effect>-<angle> and <effect>-<angle>-mirror, with its geometry turned about `about` (default the canvas centre)
// instead of its pixels rotated, so every direction is drawn crisp. The copy at 0 unmirrored is the effect as drawn.
const QUARTERS = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };
function turnsOf(effect, base, path, width, height) {
  if (effect.turn === undefined) return [{ name: base }];
  const turn = effect.turn;
  if (!isObject(turn)) fail(`${path}.turn`, 'expected { angles, about, mirror }: the directions to compile copies of this effect in');
  fields(turn, ['angles', 'about', 'mirror'], `${path}.turn`);
  const angles = turn.angles ?? [0];
  if (!Array.isArray(angles) || !angles.length || angles.length > 16) fail(`${path}.turn.angles`, 'expected 1–16 whole degrees, clockwise from the direction the effect is drawn in (0) to 359: [0, 90, 180, 270] for four directions');
  angles.forEach((angle, i) => integer(angle, `${path}.turn.angles[${i}]`, 0, 359));
  if (new Set(angles).size !== angles.length) fail(`${path}.turn.angles`, 'list each angle once');
  const about = turn.about === undefined ? [width / 2, height / 2] : pair(turn.about, `${path}.turn.about`, -4096, 4096), mirror = flag(turn.mirror, `${path}.turn.mirror`);
  // A sprite's pixels are drawn as they are, so an effect built on one can't turn.
  if (Array.isArray(effect.emitters) && effect.emitters.some(e => isObject(e) && e.sprite !== undefined)) fail(`${path}.turn`, 'a sprite emitter can\'t turn: its sprite is drawn as it is; leave turn off this effect');
  if (Array.isArray(effect.layers) && effect.layers.some(l => isObject(l) && l.kind === 'aura')) fail(`${path}.turn`, 'an aura can\'t turn: its sprite is drawn as it is; leave turn off this effect');
  const copies = [];
  for (const angle of angles) for (const flip of mirror ? [false, true] : [false]) {
    const name = `${base}-${angle}${flip ? '-mirror' : ''}`;
    if (name.length > 64) fail(`${path}.turn`, `${name} would be longer than 64 characters; shorten the effect's name`);
    copies.push({ name, view: angle === 0 && !flip ? null : turnView(angle, flip, about) });
  }
  return copies;
}
// Mirroring flips across the upright line through `about`, then the turn goes clockwise; quarter turns are exact.
function turnView(turn, mirror, [ax, ay]) {
  const [c, s] = QUARTERS[turn] ?? [cosDeg(turn), sinDeg(turn)];
  const vec = (dx, dy) => { const x = mirror ? -dx : dx; return [x * c - dy * s, x * s + dy * c]; };
  // Back from the copy to the drawn effect: turned back, then flipped.
  const unvec = (dx, dy) => { const x = dx * c + dy * s; return [mirror ? -x : x, -dx * s + dy * c]; };
  return {
    turn, mirror, vec, point: ([x, y]) => { const [vx, vy] = vec(x - ax, y - ay); return [ax + vx, ay + vy]; }, dir: theta => (mirror ? 180 - theta : theta) + turn,
    unpoint: ([x, y]) => { const [ux, uy] = unvec(x - ax, y - ay); return [ax + ux, ay + uy]; }
  };
}
const isPair = value => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v));
const negated = value => (Array.isArray(value) ? value.map(v => (typeof v === 'number' ? -v : v)) : typeof value === 'number' ? -value : value);
// A shape layer in a turned copy: its places turn about the copy's pivot and the kinds drawn round a centre take the
// turn as tilt, so a slash keeps its crescent and a beam its caps; mirroring also reverses arcs and spins. Fields that
// are not well formed are left for the layer reader to report. Floors and the looks' light stay as they are.
function turnLayer(layer, view) {
  if (!view || !isObject(layer)) return layer;
  const out = { ...layer }, place = p => (isPair(p) ? view.point(p) : p), shift = p => (isPair(p) ? view.vec(p[0], p[1]) : p);
  out.at = place(layer.at);
  if (layer.kind === 'trail') {
    if (Array.isArray(layer.points)) out.points = layer.points.map(shift);
    if (layer.pivot !== undefined) out.pivot = isPair(layer.pivot) ? shift(layer.pivot) : Array.isArray(layer.pivot) ? layer.pivot.map(shift) : layer.pivot;
  }
  if (layer.to !== undefined) out.to = place(layer.to);
  if (Array.isArray(layer.through)) out.through = layer.through.map(place);
  if (Array.isArray(layer.path)) out.path = layer.path.map(place);
  if (layer.drift !== undefined) out.drift = isPair(layer.drift) ? shift(layer.drift) : Array.isArray(layer.drift) ? layer.drift.map(key => (isPair(key) ? shift(key) : key)) : layer.drift;
  if (['ring', 'slash', 'beam', 'glyph', 'star', 'burst'].includes(layer.kind)) { const tilt = typeof layer.tilt === 'number' ? layer.tilt : 0; out.tilt = view.turn + (view.mirror ? -tilt : tilt); }
  if (view.mirror) {
    if (layer.kind === 'slash' && isPair(layer.arc)) out.arc = [180 - layer.arc[0], 180 - layer.arc[1]];
    if (layer.kind === 'star') out.angle = 180 - (typeof layer.angle === 'number' ? layer.angle : 0);
    if ((layer.kind === 'star' || layer.kind === 'glyph') && layer.spin !== undefined) out.spin = negated(layer.spin);
  }
  return out;
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

// The 20,000 drawing operations one render takes (core.js renderProject), for frameParts, and the 2,048 one frame's
// list of them holds there, which a whole reviewed without being kept must be within (compileEffects `unkept`).
const RENDER_OPERATIONS = 20000, FRAME_OPERATIONS = 2048;
// `frames` (of `area` pixels each) in runs that one render takes, in order: at most FRAME_AREA pixels and
// RENDER_OPERATIONS drawing operations a run (a frame past them alone is a run of its own, refused by the render). An
// effect compiled for fewer frames (compileEffects' `frames`) may make more of both than a recipe holds, and is read a
// run at a time: here and in its own review.
export function frameParts(frames, area) {
  const parts = [], opsOf = frame => (Array.isArray(frame?.ops) ? frame.ops.length : 0) + (Array.isArray(frame?.layers) ? frame.layers.reduce((sum, layer) => sum + (Array.isArray(layer?.ops) ? layer.ops.length : 0), 0) : 0);
  let part = [], ops = 0;
  for (const frame of frames) {
    const n = opsOf(frame);
    if (part.length && ((part.length + 1) * area > FRAME_AREA || ops + n > RENDER_OPERATIONS)) { parts.push(part); part = []; ops = 0; }
    part.push(frame); ops += n;
  }
  if (part.length) parts.push(part);
  return parts;
}

// Whether `source` compiles with its effects' frames changed (`change`: [name, frames, new frames]) and `options`
// (compile --frames, the animations kept), thinning nothing unevenly: true or false, each the answer of one whole
// compile, or 'field' when the change leaves a field out of range that is read here, before anything is compiled (an
// emitter that starts or ends past the frames named, a layer whose frames do). Only 'field' costs nothing: a compile
// refused on a field has simulated and painted every effect before the one it names, so it is false like any other
// refusal, and one of evenFrames' trials. A confirmation of a route a refusal names.
function trialCompile(source, change, options) {
  const effects = { ...source.effects };
  // A window written [first, end) that `to` frames leave out of range.
  const past = (to, first, end) => (Number.isInteger(first) && first >= to) || (Number.isInteger(end) && end > to);
  for (const [name, , to] of change) {
    const effect = effects[name];
    if (!isObject(effect)) return false;
    if (Array.isArray(effect.emitters) && effect.emitters.some(e => isObject(e) && past(to, e.start, e.end))) return 'field';
    if (Array.isArray(effect.layers) && effect.layers.some(l => isObject(l) && Array.isArray(l.frames) && past(to, l.frames[0], l.frames[1]))) return 'field';
    effects[name] = { ...effect, frames: to, ...(Array.isArray(effect.duration) && { duration: Array.from({ length: to }, (_, i) => effect.duration[i % effect.duration.length]) }) };
  }
  try { return !(compileEffects({ ...source, effects }, { ...options, trial: true }).warnings ?? []).some(warning => warning.includes(' unevenly')); }
  catch { return false; }
}

// With `stats`, the result also has `work`: the pixels its shape layers' painting visited (`painted`), every frame and
// each loop's seam probe together, to hold the work instead of timing it.
// `frames`: how many frames of each animation the compile keeps (compile --frames, pixel_compile frames; resize.js
// keepFrames thins them after). The pixels a recipe's frames hold are counted against the frames kept, so an effect
// made at a screen size may simulate more frames than fit and deliver fewer; the recipe returned still has them all.
// `animation`: the animations a compile keeps (compile --animation, pixel_compile animation; resize.js keepAnimations
// keeps them after), named at `animationPath`. Only the effects that make them are simulated, and only they are
// charged, so one spell of a set authored at a screen size compiles on its own. A part kept without its whole is
// charged alone too, and the whole is still reviewed for its warnings (`unkept`).
// `trial` (inside) is a compile that only confirms a route a refusal names (the delivered operations' loop changes):
// its own refusals name routes without confirming them.
export function compileEffects(source, { stats = false, frames: keep, animation, animationPath = 'animation', trial = false } = {}) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 256) keep = undefined;
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'symbols', 'anchor', 'effects', 'sheet'], 'fx');
  if (source.format !== 'pixelforge-fx' || source.version !== 1) fail('fx', 'expected version-1 pixelforge-fx');
  if (source.palette !== undefined && !isObject(source.palette)) fail('fx.palette', 'expected a palette object');
  // Symbols taken from a recipe's frame add the colours they use, so the palette and symbols are the effect's own copies.
  const palette = { ...source.palette };
  // The canvas is an animation frame's: at most CANVAS_SIDE a side and FRAME_PIXELS in all, a full screen of 320×180 or
  // 640×360 included. The frames' total is checked before anything is simulated (budget, below).
  const width = integer(source.width, 'fx.width', 1, CANVAS_SIDE), height = integer(source.height, 'fx.height', 1, CANVAS_SIDE);
  if (!frameFits(width, height)) fail('fx', `${frameAreaProblem(width, height)}, and an effect's canvas is one: draw it smaller or enlarge a smaller canvas with sheet.scale`);
  if (source.symbols !== undefined && (!isObject(source.symbols) || !Object.keys(source.symbols).length)) fail('fx.symbols', 'expected named symbols for the particles to draw');
  // An animation's frames are a sequence for sprites and auras, never stamped, so they stay out of the recipe's symbols.
  const symbols = { ...source.symbols }, sequences = {}, spun = new Map();
  for (const [name, rows] of Object.entries(symbols)) {
    identifier(name, `fx.symbols.${name}`);
    if (isObject(rows)) {
      const sprite = recipeSprite(rows, palette, `fx.symbols.${name}`);
      if (sprite.frames) { sequences[name] = sprite.frames; delete symbols[name]; } else symbols[name] = sprite.rows;
      continue;
    }
    if (!Array.isArray(rows) || !rows.length || rows.length > SYMBOL_SIDE || typeof rows[0] !== 'string' || !rows[0].length || rows.some(row => typeof row !== 'string')) fail(`fx.symbols.${name}`, 'expected 1–256 equal-width text rows, or { recipe, frame } or { recipe, animation }: a frame or an animation of a recipe or pose source');
    sameWidth(rows, `fx.symbols.${name}`);
    if (rows[0].length > SYMBOL_SIDE) fail(`fx.symbols.${name}`, `its rows are ${rows[0].length} characters; a particle's symbol is at most 256 a side (a sprite taken from a recipe may span the canvas)`);
    // Every character is a palette key or a clear one ('.' or a space), checked here so the error names the fx source.
    rows.forEach((row, j) => { for (const char of row) if (char !== '.' && char !== ' ' && !Object.hasOwn(palette, char)) fail(`fx.symbols.${name}[${j}]`, `unknown palette character ${JSON.stringify(char)}; the palette has ${Object.keys(palette).join(' ')}, and . or a space is clear`); });
  }
  if (!isObject(source.effects) || !Object.keys(source.effects).length || Object.keys(source.effects).length > LIMITS.effects) fail('fx.effects', `expected 1–${LIMITS.effects} named effects`);
  // The animations an effect makes: one for each turned copy, and its -back and -front parts when it draws behind a
  // character (read from the depths written, as `split` is once its emitters are read).
  const madeBy = (effect, base) => {
    const behind = drawsBehind(effect);
    return turnsOf(effect, base, `fx.effects.${base}`, width, height).map(({ name }) => [name, ...(behind ? [`${name}-back`, `${name}-front`] : [])]);
  };
  // wanted: the animations kept, or null for all. A name the source doesn't make is refused as keepAnimations refuses
  // it; while an effect can't be read, everything is compiled and that effect's own refusal comes first.
  let wanted = null;
  const names = (Array.isArray(animation) ? animation : [animation]).filter(name => typeof name === 'string' && name);
  if (names.length) {
    let made = [];
    try { made = Object.entries(source.effects).flatMap(([base, effect]) => madeBy(effect, base).flat()); } catch { made = null; }
    if (made) {
      const unknown = names.find(name => !made.includes(name));
      if (unknown !== undefined) fail(animationPath, `no animation ${JSON.stringify(unknown)}; this one has ${made.join(', ')}`);
      wanted = new Set(names);
    }
  }
  // How many of `list` (animation names) a compile keeps.
  const keptOf = list => (wanted ? list.filter(name => wanted.has(name)).length : list.length);
  // nextFrames: for each loop, the frame that follows its last, rendered only to review the seam.
  // loopNotes: warnings found while reading, such as a stream spanning a loop whose head keys don't close.
  const frames = [], nextFrames = [], loopNotes = [], animations = {}, metadata = { format: 'pixelforge-fx-metadata', version: 1, effects: {} }, seen = new Map();
  // Shape painting, and measuring auras' distance fields, share one work budget across every effect and frame
  // (shapes.js SHAPE_WORK).
  // touching: the canvas sides each animation may draw on (its effect's edges, turned with a turned copy).
  // ending: for each one-shot, whether its last frame is meant to stay drawn, what it shows of the sprites it draws, and
  // what can reach it (reaching).
  // simulated: the drawing operations every effect simulates (simulate, LIMITS.simulated), and by each effect (`by`).
  // records: what each effect simulated, by name, for a route a later effect's refusal points at it (`earlier`).
  const shapeWork = { spent: 0 }, probed = { spent: 0 }, simulated = { spent: 0, by: new Map() }, pointed = new Set(), touching = new Map(), ending = new Map(), records = new Map();
  // totalFrames: the frames the effects counted so far make (at most 256); keptFrames: those delivered with `frames`
  // (the pixels' total is on them); counted: each effect's own frames, how many of the recipe's each makes and whether
  // it draws behind a character, for the replies, which count every effect, those after the one refused too.
  let totalFrames = 0, keptFrames = 0;
  const counted = [];
  // The drawing operations the first `from` animations made deliver: those of the frames the compile keeps (n of each).
  const deliveredBy = (from, n = keep) => {
    const ops = new Map(frames.map(frame => [frame.name, frame.ops?.length ?? 0]));
    return Object.values(animations).slice(0, from).reduce((total, { frames: names, loop }) => total + keptPicks(names.length, n, loop !== false, i => ops.get(names[i]) > 0).reduce((sum, i) => sum + ops.get(names[i]), 0), 0);
  };
  // The effects after `base`, as written: [own frames, how many of the recipe's each makes, whether it draws behind a
  // character, name, loop], as `counted` holds those read (one not read cleanly is left to its own refusal).
  const aheadOf = base => {
    const order = Object.keys(source.effects);
    return order.slice(order.indexOf(base) + 1).flatMap(name => {
      const later = source.effects[name];
      if (!isObject(later) || !Number.isInteger(later.frames) || later.frames < 1 || later.frames > 256) return [];
      try {
        const made = madeBy(later, name), k = made.reduce((total, list) => total + keptOf(list), 0);
        return k ? [[later.frames, k, made.some(([, ...parts]) => keptOf(parts)), name, later.loop === true]] : [];
      } catch { return []; }
    });
  };
  // A source of one effect says "the loop"; otherwise a route names whose loop it changes. loopsOf: the loops among
  // such entries, [name, frames] once each.
  const single = Object.keys(source.effects).length === 1;
  const loopsOf = list => [...new Map(list.filter(entry => entry[4]).map(([n, , , name]) => [name, n]))];
  // A broken layer or emitter is noted and the rest of the source is still read, so one reply names every one (up to
  // ten), as for recipes. An effect with a noted error is not simulated; anything else still stops at once.
  const noted = [];
  const note = (error, inside) => {
    if (!(error instanceof PixelError) || error.errors || !inside(error.path)) throw error;
    noted.push(error);
    if (noted.length === 10) throw joinErrors(noted, true);
  };
  try {
  effects: for (const [base, effect] of Object.entries(source.effects)) {
    const path = `fx.effects.${base}`;
    identifier(base, path);
    fields(effect, ['frames', 'duration', 'loop', 'seed', 'emitters', 'layers', 'looks', 'cleanup', 'turn', 'light', 'edges', 'shine', 'residue'], path);
    // light: true writes the light track into the frames as a point named light, which scene lights can follow.
    const lightPoint = flag(effect.light, `${path}.light`), edges = readEdges(effect.edges, `${path}.edges`);
    // residue: true says a one-shot is meant to end with its last frame still drawn (debris at rest, a mark on the
    // ground), so the review below doesn't warn about it.
    const stays = flag(effect.residue, `${path}.residue`);
    // The recipe's limits on frames, checked once an effect, before anything is simulated or painted rather than after.
    // Each frame of an effect is one of the recipe's for each turned copy, and three for each when the effect draws
    // anything behind a character (its -back and -front parts too), of those the compile keeps. That is read from the
    // depths written, the same test as `split` below once the emitters and layers are read, so the first refusal
    // already counts it; the reply then names the effect as written and says how many of its own frames fit beside the
    // others. shares: for each turned copy, how many of its whole and of its parts are kept.
    const turns = turnsOf(effect, base, path, width, height);
    const shares = madeBy(effect, base).map(([name, ...parts]) => [keptOf([name]), keptOf(parts)]);
    const per = shares.reduce((total, [whole, parts]) => total + whole + parts, 0), copies = shares.filter(([whole, parts]) => whole + parts).length, behindKept = shares.some(([, parts]) => parts);
    const budget = (own, times, parts = false) => {
      const fits = Math.floor(FRAME_AREA / (width * height));
      counted.push([own, times, behindKept || parts, base, effect.loop === true]);
      totalFrames += own * times; keptFrames += Math.min(own, keep ?? own) * times;
      if (totalFrames <= 256 && !frameTotalProblem(keptFrames, width, height)) return;
      // The reply counts every effect: those counted so far and those after this one (aheadOf).
      const ahead = aheadOf(base);
      // sum: the frames of a list of [own frames, how many of the recipe's each makes] with at most m of each animation's.
      const sum = (list, m = Infinity) => list.reduce((total, [n, k]) => total + Math.min(n, m) * k, 0);
      const all = [...counted, ...ahead], others = all.filter(entry => entry[3] !== base), mine = all.filter(entry => entry[3] === base).reduce((total, [, k]) => total + k, 0);
      const made = sum(all), kept = sum(all, keep);
      // How many of this effect's own frames fit beside the others': said when it makes more than one of the recipe's
      // frames, and past 256 (`whole`) also when it makes one, as no frames value helps there.
      const ownRoom = (room, taken, whole = false, most = Infinity) => {
        const left = Math.min(most, Math.max(0, Math.floor((room - taken) / mine)));
        if (mine === 1) return whole && others.length ? `; ${base}: ${left > 1 ? `${left} of its own frames fit` : left ? '1 of its own frames fits' : 'not one of its own frames fits'} beside the others` : '';
        const why = [...(copies > 1 ? [`makes ${copies} turned copies`] : []), ...(behindKept || parts ? ['draws behind a character'] : [])].join(' and ');
        return `; ${base} ${why}, so each frame of its own makes ${mine} of the recipe's, and ${left > 1 ? `${left} of its own fit` : left ? '1 of its own fits' : 'not one of its own fits'}`;
      };
      // Another effect that draws behind a character is said here; this one's own reply says it.
      const aside = others.some(entry => entry[2]) && !(behindKept || parts) ? ' (an effect drawn behind a character also makes its -back and -front parts)' : '';
      // The most frames of each animation a compile may keep, evenly spaced, for every effect to fit, and of those the
      // most that thin every loop evenly (evenFrames). Fewer frames that way leave an effect whole, where fewer in the
      // source cut it short.
      // A route's loop changes (evenFrames) give those effects other frames.
      const changed = (list, change) => list.map(entry => { const to = change.find(([name]) => name === entry[3]); return to ? [to[2], ...entry.slice(1)] : entry; });
      const most = (list, cap = 256) => {
        let m = 0;
        while (m < cap && sum(list, m + 1) <= fits) m++;
        return evenFrames(m, loopsOf(list), undefined, change => sum(changed(list, change)) <= 256, undefined, keep);
      };
      const thins = (list, route) => changed(list, route.change).some(([n]) => n > route.n);
      if (made > 256) {
        // The frames the effects make come first: frames thins them only after they are made. Once this one's own fit,
        // the frames value that fits the pixels too.
        // With frames given and fitting once this one's own do, that frames value is the route still.
        // This one's own frames are named, so it is no loop to change there: a loop's are a multiple of the frames kept.
        let own = Math.max(0, Math.floor((256 - sum(others)) / mine));
        const after = [...others, [own, mine, false, base, false]];
        if (!own) {
          // The others alone leave this one no room, so they are named, and every effect is shortened together, each in
          // proportion, but never below one frame past its latest emitter's start (or to before its end), which would
          // leave that field out of range; then the frames kept: keep, each loop a multiple of it so it thins evenly,
          // or, where the pixels need fewer, the count evenFrames names (never a 1- to 3-frame thinning of a long
          // loop). The route is named only once the source compiles at those counts (trialCompile): what the effects
          // simulate and keep alive at them is not known from their frames alone. Otherwise the reply names the
          // effects, their frames and how many must go.
          const least = (name, n) => {
            let m = 1;
            for (const e of Array.isArray(source.effects[name]?.emitters) ? source.effects[name].emitters : []) if (isObject(e)) {
              if (Number.isInteger(e.start)) m = Math.max(m, e.start + 1);
              if (Number.isInteger(e.end)) m = Math.max(m, e.end);
            }
            return Math.min(n, m);
          };
          const at = ratio => all.map(([n, ...rest]) => [Math.max(least(rest[2], n), Math.floor(n * ratio)), ...rest]);
          let low = 0, high = 256 / made;
          if (sum(at(high)) <= 256) low = high;
          else for (let step = 0; step < 40; step++) { const mid = (low + high) / 2; if (sum(at(mid)) <= 256) low = mid; else high = mid; }
          const scaled = at(low);
          // A loop thinned by t is a multiple of it, and never one below what its emitters need (lifted to the next).
          let t = 0, fitted = sum(scaled) <= 256 ? scaled : null;
          if (fitted && keep && !frameTotalProblem(sum(scaled, keep), width, height)) {
            t = keep;
            fitted = scaled.map(entry => (entry[4] && entry[0] > t ? [t * Math.floor(entry[0] / t), ...entry.slice(1)] : entry));
          } else if (fitted && (keep || frameTotalProblem(sum(scaled), width, height))) {
            const then = most(scaled, keep ?? 256);
            t = then?.n ?? 0;
            fitted = then ? changed(scaled, then.change) : null;
          }
          if (fitted && t) fitted = fitted.map(entry => { const need = least(entry[3], source.effects[entry[3]].frames); return entry[4] && entry[0] < need ? [t * Math.ceil(need / t), ...entry.slice(1)] : entry; });
          const counts = fitted ? [...new Map(fitted.map(([n, , , name]) => [name, n]))] : [];
          const holds = fitted && !trial && sum(fitted) <= 256 && trialCompile(source, counts.map(([name, n]) => [name, source.effects[name].frames, n]), { frames: t || undefined, animation, animationPath }) === true;
          const named = list => [...new Map(list.map(([n, , , name]) => [name, n]))].map(([name, n]) => { const k = list.filter(entry => entry[3] === name).reduce((total, [, times]) => total + times, 0); return `${name} ${n}${k > 1 ? ` × ${k}` : ''}`; });
          const route = holds ? `: ${and(counts.map(([name, n]) => `${name} ${n}`))} of their own frames fit together${t ? `; then ${countText({ n: t, change: [] }, single, true, 'fits')}` : ''}` : '';
          fail('fx.effects', `the effects make ${made} frames${aside}; a recipe holds at most 256, so ${made - 256} must go, and the others alone make ${sum(others)} (${named(others).join(', ')}), leaving ${base} none${route}`);
        }
        // With frames given, the count kept is at most that, and divides the loops it thins as any count named does.
        const then = keep || frameTotalProblem(sum(after, keep), width, height) ? most(after, keep) : null;
        if (then && effect.loop === true && own > then.n) own -= own % then.n;
        fail('fx.effects', `the effects make ${made} frames${aside}; a recipe holds at most 256${ownRoom(256, sum(others), true, own)}${then ? `; then ${countText(then, single, thins(after, then), 'fits')}` : ''}`);
      }
      const fit = most(all), route = !fit ? '' : keep ? `; ${countText(fit, single, thins(all, fit), 'kept')}` : `; or ${countText(fit, single, thins(all, fit), 'compile')}`;
      fail('fx.effects', `the effects make ${made} frames${keep ? `, ${kept} of them kept with frames ${keep}` : ''}${aside}: ${frameTotalProblem(kept, width, height)}${ownRoom(Math.min(256, fits), sum(others, keep))}${route}`);
    };
    let charged = false;
    // What the effect may simulate and deliver as a whole, for the frames route of its particle refusals (framesRoute):
    // the room the effects before it leave, its copies and parts, and the grids its shapes, front looks and light add
    // to each frame (each side of one drawn behind a character too). Read once a copy's shapes and shine are.
    // operations(n): what the effects before it leave of the drawing operations a recipe delivers, n of each animation's
    // frames kept. loops: the other effects' loops the compile thins, and within: whether the effects still make at most
    // 256 frames with this one making `made` and those loops changed (evenLoops). rerun: the trial a route is confirmed by.
    let shapes = null, shine = null, effectStart = 0, animationsBefore = 0;
    const extra = () => 2 * ((shapes ? 1 : 0) + (shapes?.looks.some(look => look.front) ? 1 : 0) + (shine ? 1 : 0));
    const plan = () => {
      const all = [...counted, ...aheadOf(base)];
      return {
        copies, weight: shares.reduce((total, [whole, parts]) => total + whole + parts / 2, 0), extra: extra(),
        simulated: LIMITS.simulated - effectStart, operations: n => LIMITS.operations - deliveredBy(animationsBefore, n),
        loops: loopsOf(all.filter(entry => entry[3] !== base)), rerun: trial ? null : rerun,
        within: (change, made) => all.reduce((total, [n, k, , name]) => total + (name === base ? made : change.find(([other]) => other === name)?.[2] ?? n) * k, 0) <= 256
      };
    };
    // The effect simulated again at `made` frames (`n` of them kept), every copy the compile keeps, after `reserve` more
    // drawing operations than the effects before it simulated and with `after` fewer to deliver (the room a later effect
    // needs, `earlier`): whether it holds every particle limit and what it would deliver, and what each frame drew and
    // spawned (`byFrame`, the first `known` frames) for the next guess when it does not. Nothing of it joins the recipe.
    const rerun = (made, n, reserve = 0, after = 0) => {
      const spent = { spent: effectStart + reserve }, loop = effect.loop ?? false, seed = effect.seed ?? 1;
      let delivered = 0, measured = null;
      try {
        for (const [copy, { view }] of turns.entries()) {
          const [whole, parts] = shares[copy];
          if (!whole && !parts) continue;
          const trial = {};
          measured ??= trial;
          const context = { frames: made, loop, seed, symbols, sequences, palette, width, height, path, view, spun, work: { spent: 0 }, simulated: spent, keep: n, plan: null, looks: shapes ? shapes.looks.map(look => look.name) : [], trial };
          const emitters = [];
          // Fewer frames cut the effect short: an emitter that starts past them (and its children) is left out, and an
          // end past them is brought within, so the trial weighs the particles, not those fields.
          const cut = new Set();
          effect.emitters.forEach((emitter, i) => {
            if (isObject(emitter) && ((Number.isInteger(emitter.start) && emitter.start >= made) || cut.has(emitter.from))) { if (typeof emitter.name === 'string') cut.add(emitter.name); return; }
            const end = isObject(emitter) && Number.isInteger(emitter.end) && emitter.end > made ? { end: made } : {};
            emitters.push(readEmitter({ ...emitter, ...end }, `${path}.emitters[${i}]`, context, emitters));
          });
          const run = simulate({ frames: made, loop, seed, emitters, view, solid: shine?.solid }, context);
          spent.spent += run.operations;
          if (run.stats.reduce((sum, s) => sum + s.spawned, 0) > LIMITS.spawned) return { holds: false, ...trial };
          delivered += keptPicks(made, n, loop, f => run.byFrame.ops[f] > 0).reduce((sum, f) => sum + run.byFrame.ops[f] + extra(), 0) * (whole + parts / 2);
        }
      } catch { return { holds: false, ...measured }; }
      const holds = delivered <= LIMITS.operations - deliveredBy(animationsBefore, n) - after;
      return { holds, delivered: !holds, ...measured, known: made };
    };
    // A refusal of this effect's simulation names what the effects before it took (`by`), and when not one of its own
    // frames fits beside them, the frames of the one that took the most (records): enough of them to leave this one
    // the `need` of each copy, confirmed by simulating that one again (its rerun, after this one's room).
    const earlier = (need, routed, delivers) => {
      const by = [...simulated.by].filter(([, ops]) => ops).sort((a, b) => b[1] - a[1]);
      const taken = by.slice(0, 4).map(([name, ops]) => `${name} ${ops.toLocaleString('en-US')}`).concat(by.length > 4 ? [`${by.length - 4} more`] : []).join(', ');
      const top = routed ? by.find(([name]) => name !== base && records.has(name)) : null;
      if (!top) return { taken };
      const [name, ops] = top, record = records.get(name), other = record.plan(), room = LIMITS.simulated - need * copies - (effectStart - ops);
      const route = room > 0 ? framesRoute(record.byFrame, record.frames, record.loop, keep, { ...other, simulated: room, operations: n => other.operations(n) - delivers(n), rerun: (made, n) => record.rerun(made, n, other.simulated - room, delivers(n)) }) : null;
      return { taken, route: ` (here or in ${name})${routeText(route, record.frames, keep, name)}` };
    };
    for (const [copy, { name, view }] of turns.entries()) {
    if (lightPoint) pointed.add(name);
      // Effect names become animation and frame names, which must be unique ignoring case for portable bundles.
      // seen maps each name taken to the effect whose back or front part it is, or to null.
      if (seen.has(name.toLowerCase())) fail(path, seen.get(name.toLowerCase()) ? `${seen.get(name.toLowerCase())} draws something behind a character, so it also makes the animation ${name}; rename one of the two effects` : `effect names must be unique ignoring case; they name animations and frames${name === base ? '' : ` (${name} is a turned copy of ${base})`}`);
      seen.set(name.toLowerCase(), null);
      touching.set(name, turnedEdges(edges, view));
      // A copy the compile keeps nothing of is not made.
      if (!shares[copy][0] && !shares[copy][1]) continue;
      const count = integer(effect.frames, `${path}.frames`, 1, 256), loop = effect.loop ?? false;
      // first: the first copy made, which says what is said once an effect.
      const first = !charged;
      if (!charged) { charged = true; budget(count, per); effectStart = simulated.spent; animationsBefore = Object.keys(animations).length; }
      if (typeof loop !== 'boolean') fail(`${path}.loop`, 'expected a boolean');
      if (loop && stays) fail(`${path}.residue`, 'residue accepts what a one-shot still draws on its last frame; a loop has no last frame to leave');
      const durations = Array.isArray(effect.duration)
        ? (effect.duration.length === count ? effect.duration.map((d, i) => integer(d, `${path}.duration[${i}]`, 1, 60000)) : fail(`${path}.duration`, `expected one duration or ${count}`))
        : isObject(effect.duration) ? curve(effect.duration, `${path}.duration`, count)
          : Array(count).fill(integer(effect.duration ?? 100, `${path}.duration`, 1, 60000));
      const seed = integer(effect.seed ?? 1, `${path}.seed`, 0, 2147483647), context = { frames: count, loop, seed, symbols, sequences, palette, width, height, path, view, spun, work: shapeWork, simulated, keep, plan, earlier: trial ? null : earlier };
      // Shape layers (rings, slashes, beams, bolts, glyphs, stars, bursts, auras, trails) draw between `behind` particles and
      // the rest. A trail that follows a point of an animation takes that point's place in each frame as its points.
      const before = noted.length;
      shapes = null; shine = null;
      try { shapes = readShapes(Array.isArray(effect.layers) ? { ...effect, layers: effect.layers.map((layer, i) => turnLayer(followed(layer, `${path}.layers[${i}]`, count), view)) } : effect, path, context); }
      catch (error) { note(error, at => at.startsWith(`${path}.`) && !at.startsWith(`${path}.emitters`)); }
      // Layers that failed to read leave the looks unknown (null), and an effect with layers needs no emitters.
      const layered = Boolean(shapes) || noted.length > before;
      context.looks = shapes ? shapes.looks.map(look => look.name) : noted.length > before ? null : [];
      // Once per effect, not per turned copy: what a layer spanning the loop reads at the end of each frame must close.
      if (shapes && first) shapes.layers.forEach((layer, i) => {
        if (!layer.seams?.length) return;
        const keys = layer.seams.filter(key => key !== 'reveal');
        loopNotes.push(`${path}.layers[${i}]: this ${layer.kind} spans the loop, so ${[...(keys.length ? [`its ${keys.join(' and ')} keys must end where they start`] : []), ...(layer.seams.includes('reveal') ? ['a reveal draws it on again every cycle (leave reveal out)'] : [])].join(', and ')}; otherwise the loop jumps`);
      });
      const list = effect.emitters ?? (layered ? [] : undefined);
      try { if (!Array.isArray(list) || (!list.length && (!layered || effect.emitters !== undefined)) || list.length > LIMITS.emitters) fail(`${path}.emitters`, `expected 1–${LIMITS.emitters} emitters; leave emitters out for an effect of shape layers only`); }
      catch (error) { note(error, at => at === `${path}.emitters`); continue effects; }
      const emitters = [];
      list.forEach((emitter, i) => {
        const at = `${path}.emitters[${i}]`;
        try { emitters.push(readEmitter(emitter, at, context, emitters)); }
        catch (error) {
          note(error, where => where === at || where.startsWith(`${at}.`) || where.startsWith(`${at}[`));
          // A stand-in keeps the failed emitter's name, so its children are read without a false "no parent" error.
          emitters.push({ name: isObject(emitter) && typeof emitter.name === 'string' ? emitter.name : undefined });
        }
      });
      // shine: the light of what the effect draws in its brightest colours (readShine). Emitters with errors of their own
      // leave the names in its `solid` unchecked.
      if (effect.shine !== undefined) {
        try { shine = readShine(effect.shine, `${path}.shine`, context, noted.length > before ? null : emitters); }
        catch (error) { note(error, at => at === `${path}.shine` || at.startsWith(`${path}.shine.`)); }
      }
      if (noted.length > before) continue effects;
      // An emitter spanning a loop goes round its keys every cycle, so a path, sweep, throttle, keyed rate or ring grow
      // must end where it starts; otherwise new particles jump at the loop point. Once per effect, not per turned copy.
      if (loop && first) emitters.forEach((e, i) => {
        if (e.parent !== null || e.start !== 0 || e.end !== count) return;
        const source = list[i], same = (a, b) => JSON.stringify(a) === JSON.stringify(b), open = [];
        if (Array.isArray(source.path) && !same(source.path[0], source.path.at(-1))) open.push('path');
        for (const key of ['sweep', 'throttle', 'rate']) if (Array.isArray(source[key]) && source[key][0] !== source[key].at(-1)) open.push(key);
        if (Array.isArray(source.ring?.grow) && source.ring.grow[0] !== source.ring.grow.at(-1)) open.push('ring grow');
        if (open.length) loopNotes.push(`${path}.emitters[${i}]: this emitter spans the loop, so its ${open.join(' and ')} must end where ${open.length === 1 ? 'it starts' : 'they start'}; otherwise its new particles jump at the loop point`);
      });
      // An effect with anything behind a character (or a stand-in between) also compiles <name>-back and <name>-front:
      // what a game draws under its character and over it. The whole effect draws the back, the stand-in, then the front.
      const split = emitters.some(e => e.depth !== null && e.depth !== 'front') || (shapes?.layers.some(l => l.depth !== 'front') ?? false);
      const parts = split ? { back: `${name}-back`, front: `${name}-front` } : null;
      if (parts) {
        for (const part of Object.values(parts)) {
          if (seen.has(part.toLowerCase())) fail(path, `${name} draws something behind a character, so it also makes the animation ${part}; another effect has that name, so rename one`);
          seen.set(part.toLowerCase(), name);
        }
        // Counted with the rest of the effect above; read from the depths written, `behindKept` agrees with `split`.
        if (!behindKept && keptOf(Object.values(parts))) budget(count, keptOf(Object.values(parts)), true);
      }
      const empty = () => Array.from({ length: count }, () => []);
      const run = emitters.length ? simulate({ frames: count, loop, seed, emitters, view, solid: shine?.solid }, context)
        : { output: empty(), behind: empty(), back: { output: empty(), behind: empty() }, between: empty(), blobs: empty(), operations: 0, culled: 0, stats: [], cues: Array.from({ length: count }, () => ({})), props: new WeakSet(), solids: null, kept: null,
          next: loop ? { output: [], behind: [], back: { output: [], behind: [] }, between: [], blobs: [], solid: null } : null };
      simulated.spent += run.operations;
      simulated.by.set(base, (simulated.by.get(base) ?? 0) + run.operations);
      if (shapes) for (const layer of shapes.layers) if (layer.cue && !Object.hasOwn(run.cues[layer.t0], layer.cue)) run.cues[layer.t0][layer.cue] = [Math.floor(layer.at[0] + 0.5), Math.floor(layer.at[1] + 0.5)];
      if (!loop) ending.set(name, { stays, kept: run.kept, reach: stays ? [] : reaching(emitters, shapes, count) });
      const spawned = run.stats.reduce((sum, s) => sum + s.spawned, 0);
      if (spawned > LIMITS.spawned) {
        // The release that spawned the most is the one to lower, when it spawned most of them.
        let most = -1;
        emitters.forEach((e, i) => { if (e.release && (most < 0 || run.stats[i].spawned > run.stats[most].spawned)) most = i; });
        // The release's children (its family) spawn with it, so they are not among the others its share is weighed
        // beside, and the share named is one the effect simulated with it holds (shareHolds).
        // What the family spawns is what the share scales: its children are counted with the release, in the
        // proportion they spawned beside it (`per`), and the share named is still confirmed by shareHolds.
        const own = most < 0 ? new Set() : family(emitters, most), who = i => emitters[i].name ?? `emitters[${i}]`;
        const self = most < 0 ? 0 : run.stats[most].spawned, made = run.stats.reduce((sum, s, i) => sum + (own.has(i) ? s.spawned : 0), 0), per = self ? made / self : 1;
        const room = LIMITS.spawned - (spawned - made);
        const share = made * 2 > spawned ? releaseAdvice(emitters[most], most, emitters[most].release.share * Math.max(0, room) / made, share => run.released(most, share).spawned * per <= room, share => run.shareHolds(most, share)) : undefined;
        if (share) fail(`${path}.emitters`, `more than ${LIMITS.spawned} particles; ${share}`);
        // Otherwise what the others spawn is to lower, or the effect's frames: every frame is simulated, kept or not, so
        // the frames named are the effect's own (framesRoute), with frames kept when fewer fit.
        const by = run.stats.map((s, i) => [s.spawned, i]).filter(([n, i]) => n && !(share === null && own.has(i))).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
        fail(`${path}.emitters`, `more than ${LIMITS.spawned} particles${share === null ? `, and no share of ${who(most)}'s release fits: the other emitters alone spawn more than ${LIMITS.spawned}` : ''}; ${lowering(emitters, by.slice(0, 5), who, false)}${routeText(framesRoute(run.byFrame, count, loop, keep, plan()), count, keep)}`);
      }
      if (first) records.set(base, { frames: count, loop, byFrame: run.byFrame, plan, rerun });
      // Cues become named frame points, which atlases export for game code (a shake or a pause on the impact frame).
      const cues = [], partFrames = { back: [], front: [] };
      const gridOp = grid => (grid ? [{ op: 'grid', x: grid.x, y: grid.y, rows: grid.rows }] : []);
      // Frame i's operations from what the particles drew in it (drawn: output, behind, back, between, blobs), split into
      // the sides behind and in front of a character when the effect has parts. Frame `count` of a loop is the one after
      // its last, which shapes draw through `wrap`.
      // Frames are drawn in order with one memory, so the looks' bands hold from frame to frame (shapes.js holdBands).
      const memory = shapes?.looks.some(look => look.margins) ? holdBands() : null;
      const opsAt = (i, drawn, work) => {
        const wrap = i === count ? count : 0;
        const grid = shapes && renderShapes(shapes, i, width, height, drawn.blobs, work, false, split, wrap, memory);
        // Looks with front: true draw a second grid over the particles.
        const over = shapes?.looks.some(look => look.front) ? renderShapes(shapes, i, width, height, drawn.blobs, work, true, split, wrap, memory) : null;
        if (!parts) return { ops: [...drawn.behind, ...gridOp(grid), ...drawn.output, ...gridOp(over)] };
        // Each side keeps the usual order (behind particles, shapes, particles, front looks), and the back side goes first.
        const back = [...drawn.back.behind, ...gridOp(grid?.parts.back), ...drawn.back.output, ...gridOp(over?.parts.back)];
        const front = [...drawn.behind, ...gridOp(grid?.parts.front), ...drawn.output, ...gridOp(over?.parts.front)];
        return { ops: [...back, ...drawn.between, ...front], back, between: drawn.between, front };
      };
      const drawnAt = i => ({ output: run.output[i], behind: run.behind[i], back: { output: run.back.output[i], behind: run.back.behind[i] }, between: run.between[i], blobs: run.blobs[i] });
      // A loop's bands go into its first frame holding what its last frame leaves them: the cycle is painted once (on the
      // drawing's budget, as any frames are), its readings taped, settled, and the frames drawn from the tape. (Painted
      // again to draw, a held loop took twice as long, and needed a budget of its own for the reading.)
      const tape = memory && loop ? Array.from({ length: count }, () => []) : null;
      if (tape) {
        const reads = shapes.looks.map(() => []);
        let at = 0;
        memory.trace = (look, codes) => reads[look].push(codes);
        memory.tape = (look, record) => { tape[at][look] = record; };
        for (; at < count; at++) opsAt(at, drawnAt(at), shapeWork);
        memory.tape = null;
        settleHolds(memory, reads, width * height);
      }
      const made = run.output.map((output, i) => {
        if (tape) { memory.replay = tape[i]; tape[i] = null; }
        const frame = opsAt(i, drawnAt(i), shapeWork);
        if (tape) memory.replay = null;
        return frame;
      });
      // The frame after a loop's last, for the seam review; it takes its own painting budget and joins no animation.
      let after = null;
      if (loop) { const own = { spent: 0 }; after = opsAt(count, run.next, own); probed.spent += own.spent; }
      // The effect's light is drawn last, over everything it falls on (lightFrames).
      const lights = shine ? lightFrames(shine, made, after, run, { ...context, loop }) : null, lit = (ops, grid) => (grid ? [...ops, grid] : ops);
      if (lights && !lights.shining && first) loopNotes.push(`${path}.shine.keys: nothing the effect draws is in ${Object.keys(effect.shine.keys).length === 1 ? 'this colour' : 'these colours'}, so nothing shines: name the palette keys of its brightest pixels`);
      const names = made.map(({ ops, back, front }, i) => {
        const points = Object.keys(run.cues[i]).length ? run.cues[i] : null, light = lights?.frames[i];
        if (points) for (const [cue, at] of Object.entries(points)) cues.push({ name: cue, frame: i, at });
        if (parts) for (const [side, sideOps] of [['back', lit(back, light?.back)], ['front', lit(front, light?.front)]]) partFrames[side].push({ name: `${parts[side]}-${i}`, duration: durations[i], ...(points && { points }), ...(sideOps.length && { ops: sideOps }) });
        const all = lit(ops, light?.whole);
        frames.push({ name: `${name}-${i}`, duration: durations[i], ...(points && { points }), ...(all.length && { ops: all }) });
        return `${name}-${i}`;
      });
      if (after) { const ops = lit(after.ops, lights?.next.whole); nextFrames.push({ name: `${name}-next`, duration: 100, ...(ops.length && { ops }) }); }
      animations[name] = { frames: names, ...(!loop && { loop: false }) };
      metadata.effects[name] = { frames: count, loop, seed: effect.seed ?? 1, ...(view !== undefined && name !== base && { turn: { of: base, angle: view?.turn ?? 0, mirror: view?.mirror ?? false } }), ...(parts && { parts }), operations: run.operations, culled: run.culled, emitters: run.stats, ...(shapes?.layers.length ? { layers: shapes.layers.map(l => ({ kind: l.kind, look: l.look, frames: [l.t0, l.t1] })) } : {}), ...(cues.length && { cues }) };
      if (parts) for (const side of ['back', 'front']) {
        frames.push(...partFrames[side]);
        animations[parts[side]] = { frames: partFrames[side].map(frame => frame.name), ...(!loop && { loop: false }) };
        metadata.effects[parts[side]] = { frames: count, loop, seed: effect.seed ?? 1, part: { of: name, side } };
      }
    }
  }
  } catch (error) { throw noted.length && error instanceof PixelError && !error.errors ? joinErrors([...noted, error]) : error; }
  if (noted.length) throw joinErrors(noted);
  // Only the animations a compile keeps go into the recipe, with their frames: an effect drawn behind a character makes
  // its whole and its parts together, and says which parts it delivers.
  // reviewed: what the review below reads, in the order made: [name, animation, what the metadata says of it] for each
  // animation kept and, where a part is kept without its whole, for that whole too (`unkept`). Its parts are what a
  // game draws of it, so the compile warns of the whole's edges, residue, seam and uneven thinning as it does when
  // everything is kept, each once. Nothing of an unkept whole is delivered: its frames (`aside`) and its seam probe are
  // only rendered for the review, and what the review notes of it is dropped, but for the light point it gives its
  // parts' frames (`light: true`), as it does whenever the effect is compiled. A whole's frame draws what both its
  // parts' do, so it can pass the drawing operations a frame holds (FRAME_OPERATIONS) where neither part's does: the
  // render refuses such a frame, so that whole is left unreviewed rather than its parts' compile refused over it.
  const made = Object.entries(animations).map(([name, animation]) => [name, animation, metadata.effects[name]]), unkept = new Set(), aside = [];
  if (wanted) {
    const drawing = new Map([...frames, ...nextFrames].map(frame => [frame.name, frame.ops?.length ?? 0]));
    for (const [name, animation, effect] of made) if (!wanted.has(name)) {
      if (Object.values(effect.parts ?? {}).some(part => wanted.has(part)) && [...animation.frames, `${name}-next`].every(frame => (drawing.get(frame) ?? 0) <= FRAME_OPERATIONS)) unkept.add(name);
      delete animations[name]; delete metadata.effects[name];
    }
    for (const effect of Object.values(metadata.effects)) if (effect.parts) {
      const parts = Object.fromEntries(Object.entries(effect.parts).filter(([, part]) => wanted.has(part)));
      if (Object.keys(parts).length) effect.parts = parts; else delete effect.parts;
    }
    const delivered = new Set(Object.values(animations).flatMap(animation => animation.frames)), read = new Set(made.flatMap(([name, animation]) => (unkept.has(name) ? animation.frames : [])));
    aside.push(...frames.filter(frame => read.has(frame.name)));
    frames.splice(0, frames.length, ...frames.filter(frame => delivered.has(frame.name)));
    nextFrames.splice(0, nextFrames.length, ...nextFrames.filter(frame => { const name = frame.name.slice(0, -'-next'.length); return Object.hasOwn(animations, name) || unkept.has(name); }));
  }
  const reviewed = made.filter(([name]) => Object.hasOwn(animations, name) || unkept.has(name));
  if (frames.length > 256) fail('fx.effects', `the effects make ${frames.length} frames; a recipe holds at most 256`);
  for (const { name, rows } of spun.values()) symbols[name] = rows;
  const recipe = { version: 1, name: source.name, width, height, palette, ...(Object.keys(symbols).length && { symbols }), ...(source.anchor !== undefined && { anchor: source.anchor }), frames, animations, ...(source.sheet !== undefined && { sheet: source.sheet }) };
  // A light track for game code: in each frame, where the effect's bright pixels are (weighted by brightness), how much
  // light they make (glow, in full-white pixels) and their mean colour, or null where nothing bright is drawn.
  // An entry is built by the JSON parser and not written as an object: twice in CI, under Node 24, every entry of one
  // compile's track came back holding the last frame's glow (its place and colour were right), which nothing written
  // here can do. The engine's compiled code shared one number between the objects of a loop; the parser's never do.
  const lightOf = data => {
    let sum = 0, sx = 0, sy = 0, r = 0, g = 0, bl = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const alpha = data[i + 3] / 255, lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      if (!alpha || lum < 0.5) continue;
      const w = lum * alpha;
      sum += w; sx += (p % width) * w; sy += Math.floor(p / width) * w; r += data[i] * w; g += data[i + 1] * w; bl += data[i + 2] * w;
    }
    if (!sum) return null;
    const hex = v => Math.round(v / sum).toString(16).padStart(2, '0');
    return JSON.parse(`{"at":[${Math.round(sx / sum)},${Math.round(sy / sum)}],"glow":${Math.round(sum * 100) / 100},"color":"#${hex(r)}${hex(g)}${hex(bl)}"}`);
  };
  // A review of what each animation delivers: a loop's seam (the pixels that change from its last frame to its first)
  // against its largest ordinary step, warned about when the loop jumps; a one-shot's residue, the pixels its last
  // frame still draws besides the sprites the effect draws (0 when it ends empty), warned about unless the effect
  // says its last frame stays (residue: true): whatever is there is cut off where a game ends the effect.
  // The frames are read in order, an animation at a time (eachFrame): rendered once, or, when the effects make more
  // frames or drawing operations than one render takes (compiled to be thinned, `frames`), a run at a time
  // (frameParts), so no more is held. An unkept whole's frames are not among the recipe's, so they are always read a
  // run at a time.
  const frameOf = new Map([...recipe.frames, ...aside].map(frame => [frame.name, frame])), warnings = [...loopNotes], area = width * height;
  const renderRuns = (list, visit) => {
    let i = 0;
    for (const part of frameParts(list, area)) renderProject({ ...recipe, frames: part, animations: { review: { frames: part.map(frame => frame.name) } } }).frames.forEach(frame => visit(frame.data, i++));
  };
  const at = new Map(), whole = frameParts(recipe.frames, area).length === 1;
  if (whole) renderRuns(recipe.frames, (data, i) => at.set(recipe.frames[i].name, data));
  const eachFrame = (names, visit) => {
    if (whole && at.has(names[0])) names.forEach((name, k) => visit(at.get(name), k));
    else renderRuns(names.map(name => frameOf.get(name)), visit);
  };
  // The frame each loop should go on to after its last, drawn with the same palette and symbols.
  renderRuns(nextFrames, (data, i) => at.set(nextFrames[i].name, data));
  // Whether each frame of a one-shot draws, for the frames a compile keeps of it (keepFrames).
  const draws = new Map();
  const differ = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++; return n; };
  // The pixels a frame draws on each side's outermost row or column.
  const onEdges = data => {
    const drawn = (x, y) => data[(y * width + x) * 4 + 3] !== 0, count = { left: 0, right: 0, top: 0, bottom: 0 };
    for (let x = 0; x < width; x++) { if (drawn(x, 0)) count.top++; if (drawn(x, height - 1)) count.bottom++; }
    for (let y = 0; y < height; y++) { if (drawn(0, y)) count.left++; if (drawn(width - 1, y)) count.right++; }
    return count;
  };
  const leftover = new Set();
  for (const [name, animation, effect] of reviewed) {
    const of = effect.turn?.of ?? name, length = animation.frames.length;
    const end = ending.get(effect.part?.of ?? name), kept = end?.kept;
    // What the review keeps of the frames as they go by: the first and the last, a loop's largest step from one frame
    // to the next, and for a whole effect (not a part) each frame's light and what it draws on the canvas's edges.
    let first = null, last = null, largest = 0;
    const light = [], edges = {};
    eachFrame(animation.frames, (frame, k) => {
      if (animation.loop === false) { let any = false; for (let i = 3; i < frame.length && !any; i += 4) any = frame[i] !== 0; draws.set(animation.frames[k], any); }
      if (last && animation.loop !== false) largest = Math.max(largest, differ(last, frame));
      if (!k) first = frame;
      last = frame;
      if (effect.part) return;
      light.push(lightOf(frame));
      const count = onEdges(frame);
      for (const side of EDGE_SIDES) if (count[side]) { const e = (edges[side] ??= { pixels: 0, frames: [k, k] }); e.pixels = Math.max(e.pixels, count[side]); e.frames[1] = k; }
    });
    const residue = () => { let n = 0; for (let i = 3, c = 0; i < last.length; i += 4, c++) if (last[i] && !(kept && kept[c])) n++; return n; };
    // A part (what goes behind a character, or in front) is reviewed with its whole effect; it gets its own residue or seam.
    if (effect.part) {
      if (animation.loop === false) effect.residue = residue();
      else effect.seam = { pixels: length > 1 ? differ(last, first) : 0, largestStep: largest };
      continue;
    }
    effect.light = light;
    // Frames are named per animation, so each frame takes its own light; a cue of the same name keeps its place. The
    // parts' frames take the whole effect's light, so game code drawing them finds it too, from an unkept whole as
    // well: a part compiled without its whole has the frames a compile of everything gives it. (A part the compile
    // leaves out has no frame here.)
    if (pointed.has(name)) animation.frames.forEach((frameName, k) => {
      if (!effect.light[k]) return;
      for (const target of [frameName, ...(effect.parts ? Object.values(effect.parts).map(part => `${part}-${k}`) : [])]) {
        const frame = frameOf.get(target);
        if (frame && !frame.points?.light) frame.points = { ...frame.points, light: effect.light[k].at };
      }
    });
    // What reaches a canvas edge is cut off there, unless the effect is meant to touch that side (its edges).
    if (Object.keys(edges).length) effect.edges = edges;
    const cut = EDGE_SIDES.filter(side => edges[side] && !touching.get(name).includes(side));
    if (cut.length) {
      const where = cut.map(side => `${side}: up to ${edges[side].pixels} pixel${edges[side].pixels === 1 ? '' : 's'} a frame, ${edges[side].frames[0] === edges[side].frames[1] ? `frame ${edges[side].frames[0]}` : `frames ${edges[side].frames[0]}–${edges[side].frames[1]}`}`).join('; ');
      warnings.push(`fx.effects.${of}: ${name} draws on the canvas's ${cut.length === 1 ? `${cut[0]} edge` : `${cut.slice(0, -1).join(', ')} and ${cut.at(-1)} edges`} (${where}), so whatever reaches past it is cut off: keep it further inside or grow the canvas, or, if the effect is meant to touch that side (a bolt from the sky, a figure standing on the bottom row), list it in edges`);
    }
    if (animation.loop === false) {
      effect.residue = residue();
      // Once per effect: its turned copies are written the same way.
      if (effect.residue && !end.stays && !leftover.has(of)) {
        leftover.add(of);
        const reach = end.reach.length > 4 ? [...end.reach.slice(0, 4), `${end.reach.length - 4} more`] : end.reach;
        warnings.push(`fx.effects.${of}: ${name} still draws ${effect.residue} pixel${effect.residue === 1 ? '' : 's'} on its last frame (frame ${effect.frames - 1}), so ${effect.residue === 1 ? 'it is' : 'they are'} cut off where the effect ends${reach.length ? `. What can be there: ${reach.join('; ')}` : ''}. End ${reach.length === 1 ? 'it' : 'them'} before the last frame (a shorter life, an earlier start or end, frames on a layer that end sooner) or give the effect more frames; if it is meant to stay on screen (debris at rest, a mark on the ground), set residue: true`);
      }
      continue;
    }
    // A seamless loop's first frame is exactly the frame that follows its last: jump counts the pixels where they differ.
    // How much the last frame changes into the first (pixels) against the largest ordinary step is shown too, but a
    // seamless loop can have its largest change there by chance, so only a jump is warned about.
    const seam = length > 1 ? differ(last, first) : 0, jump = differ(at.get(`${name}-next`), first);
    effect.seam = { pixels: seam, largestStep: largest, jump };
    if (jump) warnings.push(`fx.effects.${of}: ${name} jumps at its loop point: its first frame differs in ${jump} pixel${jump === 1 ? '' : 's'} from the frame that should follow its last, so end keys where they start, spin and sway by whole turns, close paths, and give flicker an even frame count`);
  }
  // The drawing operations a recipe makes (LIMITS.operations) hold the frames it delivers: every animation's (each
  // turned copy's, each -back and -front part's), and with `frames` those keepFrames keeps of each: a loop's
  // floor(i × F / n), a one-shot's first, its last that draws and evenly between. The most frames that fit are said as
  // a route that works.
  const lists = Object.entries(animations).map(([name, animation]) => {
    const effect = metadata.effects[name], whole = effect.part?.of ?? name;
    return { of: metadata.effects[whole]?.turn?.of ?? whole, loop: animation.loop !== false, ops: animation.frames.map(frame => frameOf.get(frame).ops?.length ?? 0), draws: animation.frames.map(frame => draws.get(frame)) };
  });
  // With `change` (evenLoops), a loop changed to F frames is guessed as the first F of its own, going round again
  // past its end.
  const deliveredAt = (n, change = []) => {
    const by = new Map();
    let total = 0, count = 0;
    for (const { of, loop, ops: own, draws: drawn } of lists) {
      const to = change.find(([name]) => name === of)?.[2], ops = to ? Array.from({ length: to }, (_, i) => own[i % own.length]) : own;
      const picks = keptPicks(ops.length, n, loop, i => drawn[i % own.length]), made = picks.reduce((sum, i) => sum + ops[i], 0);
      total += made; count += picks.length; by.set(of, (by.get(of) ?? 0) + made);
    }
    return { total, count, by };
  };
  const delivered = deliveredAt(keep);
  // frames thins a loop evenly only when it divides the loop's frames; otherwise some kept frames last longer than
  // others and the loop stutters. Once per effect, not per turned copy or part.
  if (keep) {
    const told = new Set();
    for (const [name, animation, effect] of reviewed) {
      const of = effect.turn?.of ?? name, F = animation.frames.length;
      if (effect.part || animation.loop === false || F <= keep || F % keep === 0 || told.has(of)) continue;
      told.add(of);
      // A count that would thin a long loop to almost nothing (crude) is not offered, as no route offers one.
      const even = [];
      for (let d = keep - 1; d > 1 && even.length < 3; d--) if (F % d === 0 && !crude(d, [[of, F]])) even.push(d);
      const named = even.length === 1 ? `${even[0]} keeps` : `${even.slice(0, -1).join(', ')} or ${even.at(-1)} keep`;
      warnings.push(`fx.effects.${of}: frames ${keep} thins its ${F}-frame loop unevenly, so some kept frames last longer than others and the loop stutters; ${even.length ? `frames ${named} an even step` : `give the loop a multiple of ${keep} frames`}`);
    }
  }
  if (delivered.total > LIMITS.operations) {
    const longest = Math.max(...lists.map(list => list.ops.length));
    let most = Math.min(keep ?? longest, longest) - 1;
    while (most > 0 && deliveredAt(most).total > LIMITS.operations) most--;
    // Of the counts that fit, the most that thins every loop evenly, or a change to the loops' frames (evenFrames),
    // which holds once the source with those loops compiles with that many frames kept and thins nothing unevenly.
    const confirm = (n, change) => (trial ? true : trialCompile(source, change, { frames: n, animation, animationPath }));
    const even = evenFrames(most, loopsOf(lists.map(list => [list.ops.length, 1, false, list.of, list.loop])), n => deliveredAt(n).total <= LIMITS.operations,
      change => lists.reduce((total, list) => total + (change.find(([name]) => name === list.of)?.[2] ?? list.ops.length), 0) <= 256,
      (n, change) => deliveredAt(n, change).total <= LIMITS.operations && confirm(n, change));
    const shares = [...delivered.by].filter(([, made]) => made).sort((a, b) => b[1] - a[1]), single = shares.length === 1;
    const by = single ? '' : ` (${shares.slice(0, 4).map(([of, made]) => `${of} ${made.toLocaleString('en-US')}`).concat(shares.length > 4 ? [`${shares.length - 4} more`] : []).join(', ')})`;
    const what = keep ? `the ${delivered.count} frames kept with frames ${keep}` : `the ${delivered.count} frames ${single ? 'the effect makes' : 'the effects make'}`;
    const thins = even && lists.some(list => (even.change.find(([name]) => name === list.of)?.[2] ?? list.ops.length) > even.n);
    const fits = even && `so ${countText(even, Object.keys(source.effects).length === 1, thins, 'fits')}`;
    const route = !even ? 'lower' : keep || !thins ? `${fits}, or lower` : `${fits}: it keeps that many of each animation's, evenly spaced, without cutting the effect short; or lower`;
    fail(single ? `fx.effects.${shares[0][0]}` : 'fx.effects', `${what} need about ${delivered.total.toLocaleString('en-US')} drawing operations (${Math.round(delivered.total / delivered.count)} a frame)${by} and a recipe makes at most ${LIMITS.operations.toLocaleString('en-US')}${even ? ', ' : ': '}${route} burst, rate or trail`);
  }
  return JSON.parse(JSON.stringify({ recipe, metadata, ...(warnings.length && { warnings }), ...(stats && { work: { painted: shapeWork.spent + probed.spent } }) }));
}

// What can still be drawn on a one-shot's last frame, by how the effect is written: an emitter whose last spawn and
// longest life reach it (a particle born in frame t with a life of L is drawn through frame t + L − 1), and a layer
// whose frames run to the end. A child spawning where its parent's particles end is born the frame after the last one
// they are drawn in, at the latest; one spawning where they land or while they live, no later than that last frame: a
// particle that ends in a step neither moves nor lands in it, and spawns nothing after it. Whether anything is drawn
// there is measured (the residue); this names where to look, and through which frame each emitter can draw.
function reaching(emitters, shapes, count) {
  const until = [], found = [];
  emitters.forEach((e, i) => {
    if (e.drawOnly) { until.push(-Infinity); return; }
    const born = e.parent !== null ? until[e.parent] + (e.when === 'death' ? 1 : 0) : e.burst !== null ? e.start : e.end - 1, last = e.life ? born + e.life[1] - 1 : Infinity;
    until.push(last);
    if (last < count - 1) return;
    const who = `emitters[${i}]${e.name ? ` (${e.name})` : ''}`;
    const lives = `living up to ${e.life?.[1]} frame${e.life?.[1] === 1 ? '' : 's'}`, through = Number.isFinite(last) ? `, so drawn through frame ${last}` : '';
    found.push(!e.life ? `${who}, whose particles have no life and never end`
      : e.parent !== null ? `${who}, born when its parent's particles ${e.when === 'life' ? 'live' : e.when === 'floor' ? 'land' : 'end'} and ${lives}${through}`
        : `${who}, born ${e.burst !== null ? 'in' : 'until'} frame ${born} and ${lives}${through}`);
  });
  shapes?.layers.forEach((layer, i) => { if (layer.t1 >= count) found.push(`layers[${i}], a ${layer.kind} whose frames run to the effect's end`); });
  return found;
}

// The canvas sides an effect is meant to touch: each once.
function readEdges(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4 || value.some(side => !EDGE_SIDES.includes(side)) || new Set(value).size !== value.length) fail(path, 'expected the canvas sides the effect is meant to touch, each once: left, right, top or bottom (top for a bolt from the sky, bottom for a figure standing on the bottom row)');
  return value;
}
// The sides a turned copy may touch: each listed side turned with the copy, and both sides of a corner it turns toward.
function turnedEdges(sides, view) {
  if (!view || !sides.length) return sides;
  return EDGE_SIDES.filter(side => sides.some(listed => { const apart = (((view.dir(SIDE_ANGLE[listed]) - SIDE_ANGLE[side]) % 360) + 360) % 360; return apart <= 45 || apart >= 315; }));
}
