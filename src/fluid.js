// Fluid effects compiled to ordinary, editable recipes. A pixelforge-fluid source names effects; each runs a small
// fluid simulation on a grid with one cell per canvas pixel and bakes every frame into palette `grid` operations on
// the source's own palette, so inspect, patch, overlay and export work unchanged and no colour outside the palette
// can appear. Gases (smoke, fire, steam, explosions, magic) use Stam-style stable fluids on a staggered grid:
// semi-Lagrangian advection (or MacCormack, for sharp edges), a fixed-iteration pressure solve, vorticity confinement,
// buoyancy from temperature, dissipation and cooling. Liquids (water, splashes, drips, potions) use FLIP particles
// (optionally APIC) on the same grid and pressure solve, with cohesion and adhesion. Either may be viscous: an implicit
// viscosity solve in stress form, so a thick fluid falls as fast as water and only resists shearing; and a liquid may
// have a yield stress, elastic below it and flowing above it, for mud and slime. Obstacles are pixels, or smooth outlines
// traced through their steps so a liquid slides down a drawn slope. A gas may carry electricity (electric.js):
// electrodes break it down into plasma that conducts, glows and heats it. Fields become pixels through palette
// ramps and ordered dither. Browser-compatible and deterministic: only + − × ÷ and sqrt, craft.js's polynomial
// trigonometry and seeded hash, a fixed timestep and fixed iteration counts.
// createLiveFluid runs the same simulation a frame at a time for interactive pages, with pushes, puffs and boosts.
import { PixelError, renderProject, parseColor } from './core.js';
import { fields } from './authoring.js';
import { patternProblem, ditherThreshold, cleanupIds, traceLine, random, sinDeg, cosDeg } from './craft.js';
import { readElectric, readElectrode, createElectric, stepElectric, electricFields, electricWork, ELECTRODE_FIELDS, MATTER } from './electric.js';

export const FLUID_KINDS = ['gas', 'liquid'];
export const FLUID_FIELDS = ['density', 'temperature', 'speed', 'depth', 'light', 'shadow', 'strand', 'ionization', 'current'];
const LIGHT = 4, SHADOW = 5, STRAND = 6;
export const FLUID_WALLS = ['left', 'right', 'top', 'bottom'];
export const OBSTACLE_SURFACES = ['pixels', 'smooth'];
const LIMITS = { effects: 16, emitters: 16, obstacles: 32, fills: 64, looks: 8, whitewater: 4, colors: 16, particles: 32768, sparks: 4096, carriers: 8192, work: 400000000 };
// No flow moves faster than this many pixels per frame; it keeps extreme settings finite without touching normal ones.
const MAX_SPEED = 32;
// Liquid particles per full cell, and the density at which a cell counts as liquid for depth and bubbles.
const PER_CELL = 4, LEVEL = 0.5;
// How far along a row the depth bands look for a shallower surface (see renderFields).
const DEPTH_REACH = 3;
// Salts keep each random draw independent, so changing one setting does not reshuffle the others.
const SALT = { flicker: 1, noiseX: 2, noiseY: 3, spawn: 4, jitterX: 5, jitterY: 6, drain: 7, sparks: 8, sparkX: 9, sparkY: 10, angle: 11, speed: 12, life: 13, wobble: 14 };
// Whitewater layers draw from their own streams, keyed apart from the emitters (which are numbered from 0).
const WHITEWATER = 1000;
// Gas advection schemes and the thickest viscosity a source may ask for, in square pixels per frame.
const ADVECTION = ['smooth', 'sharp'];
const MAX_VISCOSITY = 64;
// A yield-stress liquid's elastic stiffness (stress per unit of strain, in square pixels per frame squared): stiff enough
// that a heap holding itself up sags by only a few hundredths, and solved implicitly, so it is stable at any timestep.
// Where it has yielded and flows, the viscosity solve gives it PLASTIC instead, which keeps that flow steady.
const STIFFNESS = 16, PLASTIC = 1;
// How many frames the cells a moving obstacle leaves stay liquid while liquid closes them in (see transfer).
const WAKE = 24;

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
const boolean = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected true or false'); return value; };
const pair = (value, path, min, max) => {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'expected [x, y]');
  return [number(value[0], `${path}[0]`, min, max), number(value[1], `${path}[1]`, min, max)];
};
// A number, or [min, max] sampled per spark.
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
const pick = ([a, b], r) => a + (b - a) * r;
const pickWhole = ([a, b], r) => a + Math.min(b - a, Math.floor(r * (b - a + 1)));
// Grid rows name colours by character, so every colour a fluid draws is a one-character palette key.
const paletteKey = (value, path, palette) => {
  if (typeof value !== 'string' || value.length !== 1 || value === '.' || value === ' ' || !Object.hasOwn(palette, value)) fail(path, 'expected a one-character palette key; grid rows name colours by character');
  return value;
};
const smooth = t => t * t * (3 - 2 * t);

// ---- Reading a source -----------------------------------------------------------------------------------------------
// A pulse (strength rising and falling) or an orbit (the emitter circling its point), repeating every `period` frames.
function readCycle(value, path, frames, loop, orbit) {
  fields(value, orbit ? ['radius', 'period', 'phase'] : ['amplitude', 'period', 'phase'], path);
  const period = integer(value.period ?? frames, `${path}.period`, orbit ? -256 : 1, 256);
  if (period === 0) fail(`${path}.period`, 'expected a whole number of frames per turn; negative turns anticlockwise');
  if (loop && frames % period !== 0) fail(`${path}.period`, `a looping effect repeats every ${frames} frames, so the period must divide ${frames}`);
  const phase = number(value.phase ?? 0, `${path}.phase`, -3600, 3600);
  if (!orbit) return { period, phase, amplitude: number(value.amplitude ?? 0.5, `${path}.amplitude`, 0, 1) };
  // A radius [x, y] makes the orbit an ellipse, so what the emitter leaves behind stretches and squeezes as it turns.
  const radius = Array.isArray(value.radius) ? pair(value.radius, `${path}.radius`, 0, 128) : [number(value.radius, `${path}.radius`, 0, 128), value.radius];
  return { period, phase, radius };
}

function readSparks(value, path, context, burst) {
  const { palette, liquid } = context;
  fields(value, ['count', 'life', 'colors', 'size', 'trail', 'angle', 'speed', 'gravity', 'drag', 'follow', 'pop', 'rise', 'wobble', 'lift'], path);
  if (!Array.isArray(value.colors) || !value.colors.length || value.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 1–${LIMITS.colors} palette keys, spread over each spark's life`);
  if (value.pop !== undefined && !liquid) fail(`${path}.pop`, 'pop bursts bubbles that reach the surface; it applies to liquids');
  if (value.rise !== undefined && !liquid) fail(`${path}.rise`, 'rise makes the spark a bubble that rises through a liquid; it applies to liquids');
  if (value.wobble !== undefined && value.rise === undefined) fail(`${path}.wobble`, 'wobble sways a bubble from side to side as it rises; set rise to make the spark a bubble');
  if (value.lift !== undefined && value.rise === undefined) fail(`${path}.lift`, 'lift lets a bubble push the water up around it; set rise to make the spark a bubble');
  const bubble = readBubble(value, path);
  return {
    count: number(value.count, `${path}.count`, 0.01, burst ? 256 : 16), life: range(value.life ?? [8, 16], `${path}.life`, 1, 256, true),
    colors: value.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette)),
    size: integer(value.size ?? 1, `${path}.size`, 1, 3), trail: value.trail === undefined ? false : boolean(value.trail, `${path}.trail`),
    angle: range(value.angle ?? [0, 360], `${path}.angle`, -3600, 3600), speed: range(value.speed ?? 0, `${path}.speed`, 0, 16),
    gravity: value.gravity === undefined ? [0, 0] : pair(value.gravity, `${path}.gravity`, -2, 2), drag: number(value.drag ?? 0.05, `${path}.drag`, 0, 1),
    follow: number(value.follow ?? 1, `${path}.follow`, 0, 2), pop: value.pop === undefined ? false : boolean(value.pop, `${path}.pop`), ...bubble,
    // In a liquid, a spark that rides the flow out of the water flies on as a droplet (see moveSparks), falling with the
    // liquid's gravity unless it has its own. A bubble ends where it leaves the water instead.
    fling: liquid && bubble.rise === null, inherit: liquid && bubble.rise === null && value.gravity === undefined
  };
}
// A bubble is air in the water (see moveBubble): `rise` is how fast it rises through still water, against the liquid's
// gravity, `wobble` how far it sways from side to side as it goes, and `lift` the share of its buoyancy it hands to the
// water around it (see stepLiquid). Sparks and whitewater without `rise` are not bubbles.
function readBubble(value, path) {
  return {
    rise: value.rise === undefined ? null : number(value.rise, `${path}.rise`, 0, 4), wobble: value.wobble === undefined ? 0 : number(value.wobble, `${path}.wobble`, 0, 2),
    lift: value.lift === undefined ? 0 : number(value.lift, `${path}.lift`, 0, 1)
  };
}

// Whitewater: spray and foam thrown off a liquid by its own motion. A particle at the surface throws a droplet where its
// velocity changes sharply within a frame (`impact`: a drop landing, a fall hitting a pool) or where it moves fast
// (`speed`: a stream shedding drops). Droplets are sparks; with follow 0 they are spray, otherwise foam on the flow. With
// `rise` the layer makes bubbles instead, under the surface: air a plunging stream or a landing drop drives into a pool.
function readWhitewater(layer, path, context, gravity) {
  const { palette } = context;
  fields(layer, ['impact', 'speed', 'chance', 'throw', 'spread', 'life', 'colors', 'size', 'trail', 'gravity', 'drag', 'follow', 'rise', 'wobble', 'lift', 'pop'], path);
  if ((layer.impact === undefined) === (layer.speed === undefined)) fail(path, 'use exactly one of impact (water whose speed changes sharply, such as where a drop lands) or speed (fast water, such as a stream shedding drops)');
  if (!Array.isArray(layer.colors) || !layer.colors.length || layer.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 1–${LIMITS.colors} palette keys, spread over each droplet's life`);
  const bubbles = layer.rise !== undefined;
  for (const key of ['wobble', 'lift', 'pop']) if (layer[key] !== undefined && !bubbles) fail(`${path}.${key}`, `${key} applies to bubbles; set rise to make this layer bubbles under the surface`);
  // Bubbles start at rest in the water, which carries them; throw, spread and gravity shape spray thrown into the air.
  for (const key of ['throw', 'spread', 'gravity']) if (layer[key] !== undefined && bubbles) fail(`${path}.${key}`, `${key} shapes spray thrown off the surface; bubbles start at rest under it, ride the flow and rise by rise`);
  return {
    impact: layer.impact === undefined ? null : number(layer.impact, `${path}.impact`, 0.05, 32), speed: layer.speed === undefined ? null : number(layer.speed, `${path}.speed`, 0.05, 32),
    chance: number(layer.chance ?? 0.1, `${path}.chance`, 0.001, 1), throw: number(layer.throw ?? 1, `${path}.throw`, 0, 4), spread: number(layer.spread ?? 20, `${path}.spread`, 0, 180),
    life: range(layer.life ?? [6, 12], `${path}.life`, 1, 256, true), colors: layer.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette)),
    size: integer(layer.size ?? 1, `${path}.size`, 1, 3), trail: layer.trail === undefined ? false : boolean(layer.trail, `${path}.trail`),
    gravity: bubbles ? [0, 0] : layer.gravity === undefined ? gravity : pair(layer.gravity, `${path}.gravity`, -2, 2), inherit: !bubbles && layer.gravity === undefined, drag: number(layer.drag ?? 0.02, `${path}.drag`, 0, 1),
    follow: number(layer.follow ?? (bubbles ? 1 : 0), `${path}.follow`, 0, 2), pop: layer.pop === undefined ? false : boolean(layer.pop, `${path}.pop`), ...readBubble(layer, path)
  };
}

function readEmitter(emitter, path, context) {
  const { frames, loop, liquid } = context;
  fields(emitter, ['name', 'at', 'radius', 'area', 'burst', 'rate', 'start', 'end', 'density', 'temperature', 'falloff', 'velocity', 'expand', 'vortex', 'noise', 'flicker', 'pulse', 'orbit', 'sparks', 'carry'], path);
  if (emitter.name !== undefined) identifier(emitter.name, `${path}.name`);
  if ((emitter.burst === undefined) === (emitter.rate === undefined)) fail(path, 'use exactly one of burst (added once, at start) or rate (added every frame from start until end)');
  const start = integer(emitter.start ?? 0, `${path}.start`, 0, frames - 1);
  if (emitter.end !== undefined && emitter.rate === undefined) fail(`${path}.end`, 'end applies to rate emitters');
  const end = integer(emitter.end ?? frames, `${path}.end`, start + 1, frames);
  if (emitter.radius !== undefined && emitter.area !== undefined) fail(path, 'use radius (a disc) or area (a box), not both');
  if (emitter.temperature !== undefined && liquid && !context.heat) fail(`${path}.temperature`, 'temperature drives gases; a liquid has a temperature only with heat (phase changes)');
  const burst = emitter.burst !== undefined;
  // A gas emitter may throw its smoke on heavy carriers instead of putting it in the air (dust, a skid's smoke).
  let carry = null;
  if (emitter.carry !== undefined) {
    if (liquid) fail(`${path}.carry`, 'carry throws gas on heavy carriers; liquid particles already carry their own speed');
    fields(emitter.carry, ['drag', 'release', 'gravity'], `${path}.carry`);
    if ((emitter.density ?? 0) < 0 || (emitter.temperature ?? 0) < 0) fail(`${path}.carry`, 'carry throws smoke and heat; a draining emitter (a negative density or temperature) has nothing to throw');
    if (!((emitter.density ?? 0) > 0) && !((emitter.temperature ?? 0) > 0)) fail(`${path}.carry`, 'carry throws this emitter\'s density and temperature, and a carrying emitter does not push the air; give it a positive density or temperature');
    carry = { drag: number(emitter.carry.drag ?? 0.1, `${path}.carry.drag`, 0, 1), release: number(emitter.carry.release ?? 0.2, `${path}.carry.release`, 0.01, 1), gravity: emitter.carry.gravity === undefined ? [0, 0] : pair(emitter.carry.gravity, `${path}.carry.gravity`, -2, 2) };
  }
  return {
    name: emitter.name, at: pair(emitter.at, `${path}.at`, -256, 512), start, end, burst, carry,
    strength: burst ? number(emitter.burst, `${path}.burst`, 0.01, 64) : number(emitter.rate, `${path}.rate`, 0.01, 64),
    radius: emitter.area === undefined ? number(emitter.radius ?? 2, `${path}.radius`, 0.5, 64) : null,
    area: emitter.area === undefined ? null : pair(emitter.area, `${path}.area`, 1, 128),
    density: number(emitter.density ?? (liquid ? 1 : 0), `${path}.density`, liquid ? -1 : -16, liquid ? 1 : 16),
    temperature: number(emitter.temperature ?? 0, `${path}.temperature`, -16, 16), falloff: number(emitter.falloff ?? 0, `${path}.falloff`, 0, 1),
    velocity: emitter.velocity === undefined ? [0, 0] : pair(emitter.velocity, `${path}.velocity`, -16, 16), steer: emitter.velocity !== undefined || Boolean(emitter.vortex),
    expand: number(emitter.expand ?? 0, `${path}.expand`, -16, 16), vortex: number(emitter.vortex ?? 0, `${path}.vortex`, -16, 16),
    noise: number(emitter.noise ?? 0, `${path}.noise`, 0, 8), flicker: number(emitter.flicker ?? 0, `${path}.flicker`, 0, 1),
    pulse: emitter.pulse === undefined ? null : readCycle(emitter.pulse, `${path}.pulse`, frames, loop, false),
    orbit: emitter.orbit === undefined ? null : readCycle(emitter.orbit, `${path}.orbit`, frames, loop, true),
    sparks: emitter.sparks === undefined ? null : readSparks(emitter.sparks, `${path}.sparks`, context, burst),
    // A liquid emitter's water starts at its temperature (the air's when unset).
    ...(liquid && context.heat && { warmth: emitter.temperature ?? null })
  };
}

function readLook(layer, path, context) {
  const { palette, liquid, seed } = context;
  fields(layer, ['field', 'colors', 'thresholds', 'dither', 'pattern', 'halo'], path);
  if (!FLUID_FIELDS.includes(layer.field)) fail(`${path}.field`, `expected ${FLUID_FIELDS.join(', ')}`);
  if (layer.field === 'temperature' && liquid && !context.heat) fail(`${path}.field`, 'liquids have no temperature without heat; use density, speed or depth');
  if (layer.field === 'strand' && !liquid) fail(`${path}.field`, 'strands are thin strings of liquid particles; a gas has density, temperature and speed');
  if ((layer.field === 'ionization' || layer.field === 'current') && !context.electric) fail(`${path}.field`, `${layer.field} is drawn from plasma; give the effect electric settings and an electrode (an obstacle with a voltage)`);
  if ((layer.field === 'ionization' || layer.field === 'current') && liquid) fail(`${path}.field`, `a liquid's plasma burns in the air over it; draw ${layer.field} in the vapour's look`);
  if (!Array.isArray(layer.colors) || !layer.colors.length || layer.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 1–${LIMITS.colors} palette keys, from the lowest level to the highest`);
  const colors = layer.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette));
  if (!Array.isArray(layer.thresholds) || layer.thresholds.length !== colors.length) fail(`${path}.thresholds`, `expected ${colors.length} thresholds, one per colour`);
  const thresholds = layer.thresholds.map((t, i) => {
    number(t, `${path}.thresholds[${i}]`, 0.001, 256);
    if (i && t <= layer.thresholds[i - 1]) fail(`${path}.thresholds[${i}]`, 'thresholds must rise from one colour to the next');
    return t;
  });
  const pattern = layer.pattern ?? 'bayer4', problem = patternProblem(pattern);
  if (problem) fail(`${path}.pattern${problem[0]}`, problem[1]);
  // A halo: a glow of one colour on the empty pixels within `width` steps of what the layer drew.
  let halo = null;
  if (layer.halo !== undefined) {
    if (!isObject(layer.halo)) fail(`${path}.halo`, 'expected { color, width }');
    fields(layer.halo, ['color', 'width'], `${path}.halo`);
    halo = { color: paletteKey(layer.halo.color, `${path}.halo.color`, palette).charCodeAt(0), width: integer(layer.halo.width ?? 1, `${path}.halo.width`, 1, 4) };
  }
  return { field: FLUID_FIELDS.indexOf(layer.field), colors: colors.map(key => key.charCodeAt(0)), thresholds, gaps: thresholds.map((t, i) => t - (i ? thresholds[i - 1] : 0)), dither: number(layer.dither ?? 0.5, `${path}.dither`, 0, 1), threshold: ditherThreshold(pattern, [0, 0], seed), halo };
}

// A disc (at, radius), an ellipse (at, radius [x, y]), a box (x, y, w, h), or both: their overlap, such as the lower
// half of a round flask.
function readShape(value, path, width, height) {
  const disc = value.at !== undefined || value.radius !== undefined, box = ['x', 'y', 'w', 'h'].some(key => value[key] !== undefined);
  if (!disc && !box) fail(path, 'expected at and radius (a disc, or an ellipse with radius [x, y]), x, y, w and h (a box), or both (their overlap)');
  let inDisc = () => true, inBox = () => true;
  if (disc) {
    const at = pair(value.at, `${path}.at`, -256, 512);
    if (Array.isArray(value.radius)) {
      // An ellipse with radii [rx, ry]: (dx / rx)² + (dy / ry)² ≤ 1, multiplied out so it needs no division.
      const [rx, ry] = pair(value.radius, `${path}.radius`, 0.5, 128), rx2 = rx * rx, ry2 = ry * ry;
      inDisc = (x, y) => { const dx = x - at[0], dy = y - at[1]; return dx * dx * ry2 + dy * dy * rx2 <= rx2 * ry2; };
    } else {
      const radius = number(value.radius, `${path}.radius`, 0.5, 128);
      inDisc = (x, y) => { const dx = x - at[0], dy = y - at[1]; return dx * dx + dy * dy <= radius * radius; };
    }
  }
  if (box) {
    const x = integer(value.x, `${path}.x`, 0, width - 1), y = integer(value.y, `${path}.y`, 0, height - 1);
    const w = integer(value.w, `${path}.w`, 1, width - x), h = integer(value.h, `${path}.h`, 1, height - y);
    inBox = (px, py) => px >= x && py >= y && px < x + w && py < y + h;
  }
  return (x, y) => inDisc(x, y) && inBox(x, y);
}

// Obstacle keys move an obstacle or take it away on cue: from a key's frame on it goes to the key's x and y (in a
// straight line over `over` frames, in whole pixels) and shows or not as `show` says, starting from where it was. A key
// may take it partly or wholly off the canvas, as far as its own size past any edge: what hangs off is clipped, as the
// canvas edge clips the fluid, so a rod can reach in from outside and a gate or a conveyor's load can leave.
// Returns its place on every frame of the cycle: { x, y, show }.
function readTrack(value, path, frames, home, rows, width, height) {
  if (!Array.isArray(value) || !value.length || value.length > 16) fail(path, 'expected 1–16 keys, each { frame, over, and any of x, y, show }');
  let last = -1;
  const keys = value.map((key, i) => {
    const kp = `${path}[${i}]`;
    fields(key, ['frame', 'over', 'x', 'y', 'show'], kp);
    const frame = integer(key.frame, `${kp}.frame`, 0, frames - 1);
    if (frame < last) fail(`${kp}.frame`, 'keys go in frame order');
    last = frame;
    if (key.x === undefined && key.y === undefined && key.show === undefined) fail(kp, 'a key moves the obstacle (x, y) or shows or hides it (show)');
    return {
      frame, over: integer(key.over ?? 0, `${kp}.over`, 0, 256), ...(key.x !== undefined && { x: integer(key.x, `${kp}.x`, -rows[0].length, width) }),
      ...(key.y !== undefined && { y: integer(key.y, `${kp}.y`, -rows.length, height) }), ...(key.show !== undefined && { show: boolean(key.show, `${kp}.show`) })
    };
  });
  // Where the obstacle is along each axis, before rounding to whole pixels, and the frames it jumps on (a key with no
  // `over` that moves it).
  const along = name => {
    const raw = Array(frames).fill(home[name]), jumps = Array(frames).fill(false);
    for (const key of keys) {
      if (key[name] === undefined) continue;
      const from = raw[key.frame];
      if (!key.over && key[name] !== from) jumps[key.frame] = true;
      for (let f = key.frame; f < frames; f++) raw[f] = key.over && f < key.frame + key.over ? from + (key[name] - from) * (f - key.frame) / key.over : key[name];
    }
    return { raw, jumps };
  };
  const ax = along('x'), ay = along('y'), shows = Array(frames).fill(true);
  for (const key of keys) if (key.show !== undefined) for (let f = key.frame; f < frames; f++) shows[f] = key.show;
  return ax.raw.map((rx, f) => {
    const jump = ax.jumps[f] || ay.jumps[f] || (f > 0 && shows[f] !== shows[f - 1]), still = !f || jump;
    // `dx`, `dy`: how far the whole-pixel place is ahead of where the obstacle really is on this frame.
    const x = Math.floor(rx + 0.5), y = Math.floor(ay.raw[f] + 0.5);
    return { x, y, show: shows[f], jump, vx: still ? 0 : rx - ax.raw[f - 1], vy: still ? 0 : ay.raw[f] - ay.raw[f - 1], dx: x - rx, dy: y - ay.raw[f] };
  });
}
// The part of an obstacle's symbol at (x, y) that lies on the canvas, as a rectangle of the symbol (sx, sy, w, h), or
// null when none of it does.
function onCanvas(rows, x, y, width, height) {
  const sx = Math.max(0, -x), sy = Math.max(0, -y), w = Math.min(rows[0].length, width - x) - sx, h = Math.min(rows.length, height - y) - sy;
  return w > 0 && h > 0 ? { sx, sy, w, h } : null;
}
// Whether any visible pixel of the symbol at (x, y) lies on the canvas.
function showsOnCanvas(rows, x, y, width, height) {
  const part = onCanvas(rows, x, y, width, height);
  return !!part && rows.slice(part.sy, part.sy + part.h).some(row => /[^. ]/.test(row.slice(part.sx, part.sx + part.w)));
}
// Where every obstacle is on frame `cycle` of the effect's cycle.
const placementsAt = (obstacles, cycle) => obstacles.map(o => (o.track ? o.track[cycle] : { x: o.x, y: o.y, show: true }));
const layoutKey = places => places.map(p => (p.show ? `${p.x},${p.y}` : '-')).join(';');
// The obstacles at these places as cell masks: what is solid, what is drawn over the fluid, which solid cells are smooth,
// and which obstacle (the first listed) covers each cell. Decorations are only drawn. What hangs off the canvas is left out.
function buildLayout(obstacles, width, height, places) {
  const N = width * height, solid = new Uint8Array(N), front = new Uint8Array(N), rounded = new Uint8Array(N), stepped = new Uint8Array(N), owner = new Int16Array(N).fill(-1);
  obstacles.forEach((o, i) => {
    const at = places[i];
    if (!at.show) return;
    o.rows.forEach((row, j) => {
      if (at.y + j < 0 || at.y + j >= height) return;
      for (let k = Math.max(0, -at.x); k < Math.min(row.length, width - at.x); k++) if (row[k] !== '.' && row[k] !== ' ') {
        const c = (at.y + j) * width + at.x + k;
        if (o.blocks) { solid[c] = 1; (o.smooth ? rounded : stepped)[c] = 1; if (owner[c] < 0) owner[c] = i; }
        if (o.draw === 'over') front[c] = 1;
      }
    });
  });
  let smooth = null;
  for (let c = 0; c < N; c++) if (rounded[c] && !stepped[c]) { smooth ??= new Uint8Array(N); smooth[c] = 1; }
  return { key: layoutKey(places), places, solid, front, smooth, owner };
}

// ---- The solid layer -------------------------------------------------------------------------------------------------
// What every fluid feature asks of the solids, answered in one place (docs/physics-model.md, section 6): which cells are
// solid, who owns each one, how fast each solid cell moves, and what each solid does to the fluid touching it. An owner
// is an obstacle's index, ICE (frozen liquid; reserved, nothing makes it yet) or, beyond the canvas, EDGE (a closed edge);
// NONE is open. Features read solids through it, never through obstacles, so whatever they do at a solid they do at
// every kind of solid: liquid clings to ice and closed edges with the effect's adhesion, and they stand still.
const NONE = -1, ICE = -2, EDGE = -3;
// Surface properties: what a solid does to the fluid touching it, read for each obstacle here, into one object. One it
// leaves unset is null and takes the effect's value, as ice and closed edges always do. A new property (a hot plate's
// temperature, an electrode's voltage) is read here and looked up through the layer's `props`, leaving the features that
// read the others alone.
const SURFACE_FIELDS = ['adhesion', 'temperature'];
function readSurface(obstacle, op, { liquid, heat }, blocks) {
  // Its own adhesion, in place of the effect's, for liquid touching it: a sticky spoon beside a non-stick pan.
  if (obstacle.adhesion !== undefined && !liquid) fail(`${op}.adhesion`, 'adhesion holds a liquid to what it touches; it applies to liquids');
  // A hot plate or a cold window: it keeps its temperature and warms or chills what touches it (a gas's air, a liquid's
  // water and ice and the air over them).
  if (obstacle.temperature !== undefined && liquid && !heat) fail(`${op}.temperature`, 'a hot or cold obstacle warms or chills a liquid that has heat; give the liquid heat');
  for (const key of SURFACE_FIELDS) if (obstacle[key] !== undefined && !blocks) fail(`${op}.${key}`, 'the fluid never meets a decoration (solid: false), so it has no surface');
  return { adhesion: obstacle.adhesion === undefined ? null : number(obstacle.adhesion, `${op}.adhesion`, 0, 4), temperature: obstacle.temperature === undefined ? null : number(obstacle.temperature, `${op}.temperature`, -16, 16) };
}
// The solid layer of a W × H layout with the obstacles at `places` on one frame. `solid` and `owner` are per cell, and
// `ownerAt(x, y)` answers beyond the canvas too. `velocity(c)` is a solid cell's [vx, vy] in pixels per frame, or null
// where it stands still (a still obstacle, one that jumped this frame, resting ice); `speed` holds each obstacle's.
// `ahead(c)` is how far a moving cell's whole-pixel place is ahead of where it really is, [dx, dy]. `props(owner)` is an
// owner's surface properties, or null (the effect's, for ice and closed edges). Ice that settles or floats is a moving
// solid too: `ice`, when given, is { moving, velocity(c) } for the ICE cells, whole cells with nothing ahead.
function solidLayer(effect, layout, places, W, H, ice = null) {
  const { solid, owner } = layout, { walls, obstacles } = effect;
  const speed = obstacles.map((o, i) => { const at = places[i]; return o.blocks && at.show && (at.vx || at.vy) ? [at.vx, at.vy] : null; });
  const beyond = closed => (closed ? EDGE : NONE), still = [0, 0];
  return {
    W, H, N: W * H, solid, owner, speed, moving: speed.some(Boolean) || !!ice?.moving,
    ownerAt: (x, y) => (x < 0 ? beyond(walls.left) : x >= W ? beyond(walls.right) : y < 0 ? beyond(walls.top) : y >= H ? beyond(walls.bottom) : owner[y * W + x]),
    velocity: c => (owner[c] >= 0 ? speed[owner[c]] : owner[c] === ICE && ice ? ice.velocity(c) : null),
    ahead: c => { if (owner[c] < 0) return still; const at = places[owner[c]]; return [at.dx, at.dy]; },
    props: o => (o >= 0 ? obstacles[o].props : null)
  };
}

// Keys change a liquid over time: from a key's frame on it takes the key's yield, viscosity, adhesion, gravity or drag,
// moving there in a straight line over `over` frames (0: at once). Each setting starts from the effect's own value and
// follows the keys that name it, in order. Returns each frame's settings; a loop follows them every cycle.
const KEYED = ['yield', 'viscosity', 'adhesion', 'gravity', 'drag'];
function readKeys(value, path, frames, base) {
  if (!Array.isArray(value) || !value.length || value.length > 16) fail(path, 'expected 1–16 keys, each { frame, over, and any of yield, viscosity, adhesion, gravity, drag }');
  let last = -1;
  const keys = value.map((key, i) => {
    const kp = `${path}[${i}]`;
    fields(key, ['frame', 'over', ...KEYED], kp);
    const frame = integer(key.frame, `${kp}.frame`, 0, frames - 1);
    if (frame < last) fail(`${kp}.frame`, 'keys go in frame order');
    last = frame;
    if (!KEYED.some(name => key[name] !== undefined)) fail(kp, `a key changes at least one of ${KEYED.join(', ')}`);
    return {
      frame, over: integer(key.over ?? 0, `${kp}.over`, 0, 256),
      ...(key.yield !== undefined && { yield: number(key.yield, `${kp}.yield`, 0, 16) }), ...(key.viscosity !== undefined && { viscosity: number(key.viscosity, `${kp}.viscosity`, 0, MAX_VISCOSITY) }),
      ...(key.adhesion !== undefined && { adhesion: number(key.adhesion, `${kp}.adhesion`, 0, 4) }), ...(key.gravity !== undefined && { gravity: pair(key.gravity, `${kp}.gravity`, -2, 2) }),
      ...(key.drag !== undefined && { drag: number(key.drag, `${kp}.drag`, 0, 1) })
    };
  });
  const blend = (from, to, t) => (Array.isArray(from) ? [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] : from + (to - from) * t);
  const schedule = Array.from({ length: frames }, () => ({}));
  for (const name of KEYED) {
    // Each key rewrites its setting from its frame on, starting from the value it finds there, so a key that starts
    // during another's ramp carries on from where that ramp had got to.
    const values = Array(frames).fill(base[name]);
    for (const key of keys) {
      if (key[name] === undefined) continue;
      const from = values[key.frame];
      for (let f = key.frame; f < frames; f++) values[f] = key.over && f < key.frame + key.over ? blend(from, key[name], (f - key.frame) / key.over) : key[name];
    }
    values.forEach((value, f) => { schedule[f][name] = value; });
  }
  return schedule;
}

// Heat for a liquid's phase changes, on the gas temperature scale (docs/physics-model.md, section 3): 0 is the room's air,
// water freezes at −0.5 and boils at 0.5, and steam beads below 0.4. See the phase section below for each setting.
function readHeat(value, path, vapour) {
  fields(value, ['ambient', 'air', 'conduct', 'contact', 'freeze', 'boil', 'latent', 'vaporize', 'evaporation', 'sublimate', 'dew', 'condense', 'frost', 'deposit', 'branch', 'grain'], path);
  const freeze = number(value.freeze ?? -0.5, `${path}.freeze`, -8, 8), boil = number(value.boil ?? 0.5, `${path}.boil`, -8, 16);
  if (boil <= freeze) fail(`${path}.boil`, 'the boiling point must lie above the freezing point');
  for (const key of ['evaporation', 'sublimate', 'dew', 'frost', 'branch']) if (value[key] !== undefined && !vapour) fail(`${path}.${key}`, `${key} turns water or ice into vapour or back; give the effect a vapour`);
  if (value.condense !== undefined && !vapour) fail(`${path}.condense`, 'condense is how fast vapour beads up as dew on what is colder than dew; give the effect a vapour');
  for (const [key, what] of [['deposit', 'how fast vapour grows into frost'], ['branch', 'how often a frost finger forks']]) if (value[key] !== undefined && value.frost === undefined) fail(`${path}.${key}`, `${key} is ${what}; set frost (at or below freeze) for vapour to frost over what is colder`);
  const frost = value.frost === undefined ? null : number(value.frost, `${path}.frost`, -16, 16), dew = number(value.dew ?? boil - 0.1, `${path}.dew`, -16, 16);
  if (dew > boil) fail(`${path}.dew`, 'vapour condenses below the boiling point; keep dew at or under boil');
  if (frost !== null && frost > freeze) fail(`${path}.frost`, 'vapour turns straight to ice below the freezing point; keep frost at or under freeze');
  return {
    ambient: number(value.ambient ?? 0, `${path}.ambient`, -16, 16), air: number(value.air ?? 0.04, `${path}.air`, 0, 0.2),
    conduct: number(value.conduct ?? 0.12, `${path}.conduct`, 0, 0.2), contact: number(value.contact ?? 0.15, `${path}.contact`, 0, 0.2), freeze, boil,
    latent: number(value.latent ?? 0.5, `${path}.latent`, 0.02, 8), vaporize: number(value.vaporize ?? 1, `${path}.vaporize`, 0.02, 16),
    evaporation: number(value.evaporation ?? 0, `${path}.evaporation`, 0, 1), sublimate: value.sublimate === undefined ? false : boolean(value.sublimate, `${path}.sublimate`),
    dew: vapour ? dew : null, condense: number(value.condense ?? 0.2, `${path}.condense`, 0, 1),
    frost, deposit: number(value.deposit ?? 0.1, `${path}.deposit`, 0, 1), branch: number(value.branch ?? 0.5, `${path}.branch`, 0, 1), grain: number(value.grain ?? 0, `${path}.grain`, 0, 1)
  };
}
// Vapour: a gas on the same grid that moves through the cells holding neither liquid nor ice. `bubbles` are the bubbles a
// boil makes inside the water: bubble sparks (see readSparks) that carry their vapour up and let it out at the surface.
function readVapour(value, path, context) {
  fields(value, ['expansion', 'buoyancy', 'weight', 'vorticity', 'dissipation', 'cooling', 'drag', 'spread', 'iterations', 'bubbles', 'look'], path);
  const look = value.look === undefined ? [] : Array.isArray(value.look) && value.look.length <= LIMITS.looks ? value.look.map((layer, i) => readLook(layer, `${path}.look[${i}]`, { ...context, liquid: false })) : fail(`${path}.look`, `expected 0–${LIMITS.looks} layers`);
  let bubbles = null;
  if (value.bubbles !== undefined) {
    fields(value.bubbles, ['colors', 'size', 'life', 'rise', 'wobble', 'lift', 'pop', 'follow', 'drag'], `${path}.bubbles`);
    bubbles = readSparks({ count: 1, life: 256, rise: 0.8, ...value.bubbles }, `${path}.bubbles`, context, false);
  }
  return {
    expansion: number(value.expansion ?? 8, `${path}.expansion`, 1, 64), buoyancy: number(value.buoyancy ?? 0.2, `${path}.buoyancy`, -2, 2), weight: number(value.weight ?? 0, `${path}.weight`, -2, 2),
    vorticity: number(value.vorticity ?? 0.2, `${path}.vorticity`, 0, 2), dissipation: number(value.dissipation ?? 0, `${path}.dissipation`, 0, 1), cooling: number(value.cooling ?? 0.05, `${path}.cooling`, 0, 1),
    drag: number(value.drag ?? 0.02, `${path}.drag`, 0, 1), spread: number(value.spread ?? 0, `${path}.spread`, 0, 0.25), iterations: integer(value.iterations ?? 20, `${path}.iterations`, 1, 200),
    bubbles, look, viscosity: 0, sharp: false
  };
}

function readEffect(effect, path, source) {
  const { width, height, palette, symbols } = source;
  fields(effect, ['kind', 'frames', 'duration', 'loop', 'seed', 'warmup', 'blend', 'substeps', 'iterations', 'buoyancy', 'weight', 'vorticity', 'dissipation', 'cooling', 'drag', 'wind', 'advection', 'viscosity', 'yield', 'slip', 'gravity', 'flip', 'apic', 'tension', 'adhesion', 'fill', 'walls', 'obstacles', 'emitters', 'look', 'whitewater', 'air', 'light', 'outline', 'cleanup', 'keys', 'electric', 'heat', 'vapour', 'ice'], path);
  const kind = effect.kind ?? 'gas';
  if (!FLUID_KINDS.includes(kind)) fail(`${path}.kind`, 'expected gas (smoke, fire, steam, magic) or liquid (water, potions)');
  const liquid = kind === 'liquid';
  for (const key of ['heat', 'vapour', 'ice']) if (effect[key] !== undefined && !liquid) fail(`${path}.${key}`, `${key} gives a liquid phase changes; a gas already has a temperature`);
  if ((effect.vapour !== undefined || effect.ice !== undefined) && effect.heat === undefined) fail(`${path}.heat`, 'vapour and ice come from phase changes; give the liquid heat');
  const heat = effect.heat === undefined ? null : readHeat(effect.heat, `${path}.heat`, effect.vapour !== undefined);
  if (liquid && effect.advection !== undefined) fail(`${path}.advection`, 'advection applies to gases; a liquid\'s particles carry it');
  for (const key of liquid ? ['buoyancy', 'weight', 'vorticity', 'dissipation', 'cooling', 'wind'] : ['gravity', 'flip', 'apic', 'tension', 'adhesion', 'yield', 'fill', 'keys', 'air']) {
    if (effect[key] !== undefined) fail(`${path}.${key}`, liquid ? `${key} applies to gases; liquids fall by gravity and keep their volume` : `${key} applies to liquids; gases rise by buoyancy`);
  }
  const advection = effect.advection ?? 'smooth';
  if (!ADVECTION.includes(advection)) fail(`${path}.advection`, 'expected smooth (plain semi-Lagrangian, the default) or sharp (MacCormack with a limiter: crisper edges and swirls)');
  const viscosity = number(effect.viscosity ?? 0, `${path}.viscosity`, 0, MAX_VISCOSITY), yieldStress = liquid ? number(effect.yield ?? 0, `${path}.yield`, 0, 16) : 0;
  if (!liquid && effect.whitewater !== undefined) fail(`${path}.whitewater`, 'whitewater is spray and foam thrown off a liquid; it applies to liquids');
  // Over a liquid an arc runs through the air (the vapour's gas) and the water, and heats both, so it needs heat and vapour.
  const unwired = liquid && !(effect.heat !== undefined && effect.vapour !== undefined), WETS = 'an arc over a liquid runs through the air over it (the vapour gas) and boils the water it strikes; give the liquid heat and vapour';
  if (unwired && effect.electric !== undefined) fail(`${path}.electric`, WETS);
  const frames = integer(effect.frames, `${path}.frames`, 1, 256), loop = effect.loop === undefined ? false : boolean(effect.loop, `${path}.loop`);
  const durations = Array.isArray(effect.duration)
    ? (effect.duration.length === frames ? effect.duration.map((d, i) => integer(d, `${path}.duration[${i}]`, 1, 60000)) : fail(`${path}.duration`, `expected one duration or ${frames}`))
    : Array(frames).fill(integer(effect.duration ?? 80, `${path}.duration`, 1, 60000));
  if (!loop) for (const key of ['warmup', 'blend']) if (effect[key] !== undefined) fail(`${path}.${key}`, `${key} shapes the seam of a looping effect; set loop: true`);
  if (loop && frames < 4) fail(`${path}.frames`, 'a looping effect needs at least 4 frames');
  const seed = integer(effect.seed ?? 1, `${path}.seed`, 0, 2147483647);
  const context = { frames, loop, liquid, palette, seed, electric: false, heat };
  let iceLook = null;
  if (effect.ice !== undefined) {
    fields(effect.ice, ['look'], `${path}.ice`);
    if (!Array.isArray(effect.ice.look) || !effect.ice.look.length || effect.ice.look.length > LIMITS.looks) fail(`${path}.ice.look`, `expected 1–${LIMITS.looks} layers that map the ice's fields to palette colours`);
    // Plasma never enters ice: it burns in the air over the liquid.
    effect.ice.look.forEach((layer, i) => { if (isObject(layer) && (layer.field === 'ionization' || layer.field === 'current')) fail(`${path}.ice.look[${i}].field`, `plasma never enters ice; it burns in the air over the liquid, so draw ${layer.field} in the vapour's look`); });
    iceLook = effect.ice.look.map((layer, i) => readLook(layer, `${path}.ice.look[${i}]`, { ...context, liquid: false }));
  }
  const obstacles = [];
  const listed = (value, key, max) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) fail(`${path}.${key}`, `expected a list of at most ${max} entries`);
    return value;
  };
  listed(effect.obstacles, 'obstacles', LIMITS.obstacles).forEach((obstacle, i) => {
    const op = `${path}.obstacles[${i}]`;
    fields(obstacle, ['symbol', 'x', 'y', 'draw', 'surface', 'solid', 'keys', ...SURFACE_FIELDS, ...ELECTRODE_FIELDS], op);
    if (typeof obstacle.symbol !== 'string' || !Object.hasOwn(symbols, obstacle.symbol)) fail(`${op}.symbol`, `unknown symbol ${JSON.stringify(obstacle.symbol)}`);
    // It may hang off any edge by up to its own size; what hangs off is clipped.
    const rows = symbols[obstacle.symbol], x = integer(obstacle.x ?? 0, `${op}.x`, -rows[0].length, width), y = integer(obstacle.y ?? 0, `${op}.y`, -rows.length, height);
    const draw = obstacle.draw ?? 'over';
    if (!['over', 'under', 'none'].includes(draw)) fail(`${op}.draw`, 'expected over (drawn in front of the fluid), under or none (an invisible wall)');
    const surface = obstacle.surface ?? 'pixels';
    if (!OBSTACLE_SURFACES.includes(surface)) fail(`${op}.surface`, 'expected pixels (the default: the fluid meets every pixel step) or smooth (the fluid meets a smooth outline through the steps, so it slides down a drawn slope)');
    // A decoration (solid: false) is drawn like an obstacle, but the fluid never meets it: a net, a flame, a label.
    const blocks = obstacle.solid === undefined ? true : boolean(obstacle.solid, `${op}.solid`);
    if (!blocks && draw === 'none' && obstacle.voltage === undefined) fail(`${op}.draw`, 'a decoration (solid: false) is only drawn; draw it over or under the fluid, or give it a voltage (an unseen charge)');
    if (!blocks && surface === 'smooth') fail(`${op}.surface`, 'surface shapes how the fluid meets an obstacle; the fluid never meets a decoration (solid: false)');
    const track = obstacle.keys === undefined ? null : readTrack(obstacle.keys, `${op}.keys`, frames, { x, y }, rows, width, height);
    // An electrode or metal (electric.js): solid, or for an electrode a decoration the gas flows through.
    const electric = readElectrode(obstacle, op, frames);
    if (electric && unwired) fail(`${op}.${electric.conductor ? 'conductor' : 'voltage'}`, WETS);
    obstacles.push({ symbol: obstacle.symbol, x, y, draw, blocks, smooth: surface === 'smooth', rows, track, props: { ...readSurface(obstacle, op, context, blocks), voltage: electric ? electric.voltage : null, conductor: electric ? electric.conductor : null }, ...(electric && { electric }) });
  });
  // Electricity: settings of its own, defaults when only an obstacle has a voltage or conducts. Over a liquid its plasma
  // burns in the vapour's gas, which the vapour's look draws.
  const electric = effect.electric === undefined && !obstacles.some(o => o.electric) ? null : readElectric(effect.electric ?? {}, `${path}.electric`, obstacles, liquid);
  context.electric = !!electric;
  const vapour = effect.vapour === undefined ? null : readVapour(effect.vapour, `${path}.vapour`, context);
  const moving = obstacles.some(o => o.track), layout = buildLayout(obstacles, width, height, placementsAt(obstacles, 0));
  const { solid, front, smooth, owner } = layout;
  const walls = listed(effect.walls, 'walls', 4).map((edge, i) => {
    if (!FLUID_WALLS.includes(edge)) fail(`${path}.walls[${i}]`, `expected ${FLUID_WALLS.join(', ')}`);
    return edge;
  });
  if (new Set(walls).size !== walls.length) fail(`${path}.walls`, 'each edge is listed once');
  const fills = listed(effect.fill, 'fill', LIMITS.fills).map((entry, i) => {
    const fp = `${path}.fill[${i}]`;
    fields(entry, ['x', 'y', 'w', 'h', 'at', 'radius', 'velocity', 'burst', 'temperature', 'frozen', 'vapour'], fp);
    for (const key of ['temperature', 'frozen']) if (entry[key] !== undefined && !heat) fail(`${fp}.${key}`, `${key} applies to a liquid with heat (phase changes)`);
    if (entry.vapour !== undefined && !vapour) fail(`${fp}.vapour`, 'a vapour fill needs the effect\'s vapour');
    if (entry.vapour !== undefined && (entry.frozen !== undefined || entry.burst !== undefined || entry.velocity !== undefined)) fail(`${fp}.vapour`, 'a vapour fill holds still vapour; it is neither frozen nor thrown');
    const phase = heat ? { temperature: entry.temperature === undefined ? null : number(entry.temperature, `${fp}.temperature`, -16, 16), frozen: entry.frozen === undefined ? false : boolean(entry.frozen, `${fp}.frozen`), vapour: entry.vapour === undefined ? 0 : number(entry.vapour, `${fp}.vapour`, 0.01, 4) } : null;
    let burst = null;
    if (entry.burst !== undefined) {
      fields(entry.burst, ['speed', 'pieces'], `${fp}.burst`);
      if (entry.burst.speed === undefined) fail(`${fp}.burst.speed`, 'expected how fast the pieces fly apart, in pixels per frame: a number or [min, max]');
      burst = { speed: range(entry.burst.speed, `${fp}.burst.speed`, 0, 16), pieces: integer(entry.burst.pieces ?? 8, `${fp}.burst.pieces`, 2, 64) };
    }
    return { inside: readShape(entry, fp, width, height), velocity: entry.velocity === undefined ? [0, 0] : pair(entry.velocity, `${fp}.velocity`, -16, 16), burst, ...(phase && { phase }) };
  });
  // A gas with electrodes needs no emitter: its arcs are its source.
  const listedEmitters = effect.emitters ?? (electric ? [] : undefined);
  if (!Array.isArray(listedEmitters) || listedEmitters.length > LIMITS.emitters || (!listedEmitters.length && !fills.length && !electric)) fail(`${path}.emitters`, `expected 1–${LIMITS.emitters} emitters${liquid ? ' (or none, with a fill)' : ' (or none, with electrodes)'}`);
  const emitters = listedEmitters.map((emitter, i) => readEmitter(emitter, `${path}.emitters[${i}]`, context));
  if (!Array.isArray(effect.look) || !effect.look.length || effect.look.length > LIMITS.looks) fail(`${path}.look`, `expected 1–${LIMITS.looks} layers that map a field to palette colours`);
  const look = effect.look.map((layer, i) => readLook(layer, `${path}.look[${i}]`, context));
  const gravity = effect.gravity === undefined ? [0, 0.3] : pair(effect.gravity, `${path}.gravity`, -2, 2);
  const adhesion = liquid ? number(effect.adhesion ?? 0, `${path}.adhesion`, 0, 4) : 0;
  const drag = number(effect.drag ?? (liquid ? 0 : 0.02), `${path}.drag`, 0, 1);
  const schedule = effect.keys === undefined ? null : readKeys(effect.keys, `${path}.keys`, frames, { yield: yieldStress, viscosity, adhesion, gravity, drag });
  const most = { yield: yieldStress, viscosity, adhesion };
  if (schedule) for (const now of schedule) for (const key of Object.keys(most)) if (now[key] > most[key]) most[key] = now[key];
  for (const o of obstacles) if (o.props.adhesion > most.adhesion) most.adhesion = o.props.adhesion;
  if (effect.slip !== undefined && !most.viscosity && !most.yield) fail(`${path}.slip`, `slip lets a thick fluid slide along walls and obstacles instead of being held by them; set viscosity${liquid ? ' or yield' : ''}`);
  const whitewater = listed(effect.whitewater, 'whitewater', LIMITS.whitewater).map((layer, i) => readWhitewater(layer, `${path}.whitewater[${i}]`, context, gravity));
  let cleanup = { strays: false, corners: false };
  if (effect.cleanup !== undefined) {
    fields(effect.cleanup, ['strays', 'corners'], `${path}.cleanup`);
    cleanup = { strays: effect.cleanup.strays === undefined ? false : boolean(effect.cleanup.strays, `${path}.cleanup.strays`), corners: effect.cleanup.corners === undefined ? false : boolean(effect.cleanup.corners, `${path}.cleanup.corners`) };
  }
  const light = effect.light === undefined ? [-1, -1] : pair(effect.light, `${path}.light`, -1, 1), reachLight = Math.sqrt(light[0] * light[0] + light[1] * light[1]);
  if (!reachLight) fail(`${path}.light`, 'expected a direction toward the light, such as [-1, -1] for the upper left');
  const pull = schedule ? (schedule.find(now => now.gravity[0] || now.gravity[1])?.gravity ?? gravity) : gravity;
  const layouts = new Map(), layoutAt = moving ? cycle => { const places = placementsAt(obstacles, cycle), key = layoutKey(places); if (!layouts.has(key)) layouts.set(key, buildLayout(obstacles, width, height, places)); return layouts.get(key); } : null;
  const warnings = sourceWarnings({ path, width, height, frames, liquid, seed, emitters, fills, gravity: pull, solid, smooth, owner, walls: Object.fromEntries(FLUID_WALLS.map(edge => [edge, walls.includes(edge)])), layoutAt, adhesive: most.adhesion > 0 });
  // An obstacle that shows but has no visible pixel on the canvas whenever it does blocks and draws nothing.
  obstacles.forEach((o, i) => {
    const shown = (o.track ?? [{ x: o.x, y: o.y, show: true }]).filter(at => at.show);
    if (shown.length && !shown.some(at => showsOnCanvas(o.rows, at.x, at.y, width, height))) warnings.push(`${path}.obstacles[${i}] has no visible pixel on the canvas whenever it shows, so it ${!o.blocks ? 'draws' : o.draw === 'none' ? 'blocks' : 'blocks and draws'} nothing: move its x and y (or its keys) onto the ${width} × ${height} canvas`);
  });
  // Heat moves by temperature, which holds at the boil, so water that boils under the surface stays there: only bubbles
  // carry it up. Without them or evaporation, water heated from below by an obstacle hotter than the boil never steams.
  if (vapour && !vapour.bubbles && !heat.evaporation) obstacles.forEach((o, i) => {
    if (o.props.temperature !== null && o.props.temperature > heat.boil) warnings.push(`${path}.obstacles[${i}] is hotter than heat.boil, but water turns to vapour only at its surface: water it heats under the surface waits at the boil, so a pool heated from below never steams; give vapour.bubbles (bubbles carry the boil up and let it out) or heat.evaporation`);
  });
  return {
    warnings,
    kind, liquid, frames, durations, light: [light[0] / reachLight, light[1] / reachLight], loop, seed, emitters, look, whitewater, obstacles, moving, layout, solid, front, smooth, walls: Object.fromEntries(FLUID_WALLS.map(edge => [edge, walls.includes(edge)])), fills, cleanup,
    warmup: loop ? integer(effect.warmup ?? 2, `${path}.warmup`, 1, 8) : 0,
    blend: loop ? integer(effect.blend ?? Math.max(1, Math.min(8, Math.floor(frames / 3))), `${path}.blend`, 1, Math.floor(frames / 2)) : 0,
    substeps: integer(effect.substeps ?? 2, `${path}.substeps`, 1, 16), iterations: integer(effect.iterations ?? (liquid ? 40 : 30), `${path}.iterations`, 1, 200),
    buoyancy: number(effect.buoyancy ?? 0.15, `${path}.buoyancy`, -2, 2), weight: number(effect.weight ?? 0, `${path}.weight`, -2, 2),
    vorticity: number(effect.vorticity ?? 0.25, `${path}.vorticity`, 0, 2), dissipation: number(effect.dissipation ?? 0.03, `${path}.dissipation`, 0, 1),
    cooling: number(effect.cooling ?? 0.08, `${path}.cooling`, 0, 1), drag,
    wind: effect.wind === undefined ? [0, 0] : pair(effect.wind, `${path}.wind`, -2, 2), gravity, sharp: advection === 'sharp',
    viscosity, yield: yieldStress, slip: effect.slip === undefined ? false : boolean(effect.slip, `${path}.slip`),
    flip: number(effect.flip ?? 0.9, `${path}.flip`, 0, 1), apic: effect.apic === undefined ? false : boolean(effect.apic, `${path}.apic`),
    tension: number(effect.tension ?? 0.5, `${path}.tension`, 0, 4), adhesion, schedule, most, electric,
    outline: effect.outline === undefined ? 0 : paletteKey(effect.outline, `${path}.outline`, palette).charCodeAt(0),
    air: liquid && effect.air !== undefined ? readAir(effect.air, `${path}.air`, context) : null,
    heat, vapour, iceLook, warm: !liquid && obstacles.some(o => o.props.temperature !== null)
  };
}
// Air pockets (see sealAir): `stiffness` is the head, in pixels of liquid, that squeezes a pocket to half its size, and
// `bubbles` how the air of a pocket that shrinks too small to show is drawn as it escapes: bubbles, as a whitewater bubble
// layer draws them. Without `bubbles` that air leaves unseen.
function readAir(value, path, context) {
  if (!isObject(value)) fail(path, 'expected { stiffness, bubbles }: air pockets that keep their air, squeezed to half their size under stiffness pixels of liquid');
  fields(value, ['stiffness', 'bubbles'], path);
  let bubbles = null;
  if (value.bubbles !== undefined) {
    const bp = `${path}.bubbles`, b = value.bubbles;
    if (!isObject(b)) fail(bp, 'expected { colors, life, rise, wobble, lift, pop }: how the air of a pocket too small to show rises as bubbles');
    fields(b, ['colors', 'life', 'rise', 'wobble', 'lift', 'pop'], bp);
    if (!Array.isArray(b.colors) || !b.colors.length || b.colors.length > LIMITS.colors) fail(`${bp}.colors`, `expected 1–${LIMITS.colors} palette keys, spread over each bubble's life`);
    bubbles = {
      colors: b.colors.map((key, i) => paletteKey(key, `${bp}.colors[${i}]`, context.palette)), life: range(b.life ?? [30, 60], `${bp}.life`, 1, 256, true),
      size: 1, trail: false, gravity: [0, 0], inherit: false, drag: 0.02, follow: 1, pop: b.pop === undefined ? false : boolean(b.pop, `${bp}.pop`),
      ...readBubble({ ...b, rise: b.rise ?? 0.5 }, bp)
    };
  }
  return { stiffness: number(value.stiffness ?? 40, `${path}.stiffness`, 2, 1000), bubbles };
}

// Setups that compile but make nothing, or look stuck, said in words: an emitter whose disc or box lies inside
// obstacles (or off the canvas) on every frame it works, and a liquid fill that starts against the underside of a pixel
// obstacle (or a closed edge above it), where the pressure holds it on, with open space below it to fall into. A fill
// that rests on something (along a quarter or more of its lowest cells), as water in a flask does, or on other water,
// needs no warning, whatever it touches; nor does one thrown away from what is above it, or bursting apart, nor any in a
// liquid with adhesion, which clings on purpose. Gravity is the first the effect has, its keys included.
function sourceWarnings({ path, width, height, frames, liquid, seed, emitters, fills, gravity, solid, smooth, owner, walls, layoutAt, adhesive }) {
  const warnings = [], W = width, H = height;
  const solidBase = solid, ownerBase = owner;
  emitters.forEach((e, index) => {
    if (!(e.density > 0 || (!liquid && (e.temperature > 0 || e.expand > 0)))) return;
    let open = false, buried = -1, seen = false;
    // An orbiting rate emitter also works along the path between frames, as emitFrame lays it.
    const steps = e.orbit && !e.burst && !e.carry ? Math.max(1, Math.ceil(2 * Math.PI * Math.max(e.orbit.radius[0], e.orbit.radius[1]) / Math.abs(e.orbit.period))) : 1;
    for (let cycle = 0; cycle < frames && !open; cycle++) {
      if (!active(e, cycle)) continue;
      // Obstacles that move are where they are on that frame.
      const here = layoutAt ? layoutAt(cycle) : null, solid = here ? here.solid : solidBase, owner = here ? here.owner : ownerBase;
      for (let k = 1; k <= steps && !open; k++) {
        const { x, y } = emitterState(e, index, cycle, seed, cycle - 1 + k / steps), r = reach(e);
        for (let j = Math.max(0, Math.floor(y - r)); j <= Math.min(H - 1, Math.ceil(y + r)) && !open; j++) for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(W - 1, Math.ceil(x + r)); i++) {
          if (!coverage(e, i + 0.5 - x, j + 0.5 - y)) continue;
          seen = true;
          if (!solid[j * W + i]) { open = true; break; }
          if (buried < 0) buried = owner[j * W + i];
        }
      }
    }
    if (open) return;
    const what = liquid ? 'water' : 'gas', sparks = e.sparks ? ' (its sparks still show)' : '';
    if (seen) warnings.push(`${path}.emitters[${index}] lies inside obstacles[${buried}] whenever it emits, so it adds no ${what}${sparks}: move it just outside the obstacle's pixels`);
    else warnings.push(`${path}.emitters[${index}] lies outside the canvas whenever it emits, so it adds no ${what}${sparks}: move its at inside the ${W} × ${H} canvas`);
  });
  // A liquid with adhesion is meant to cling to what it starts against.
  if (!liquid || adhesive) return warnings;
  // "Above" is against gravity, along its stronger axis.
  const [gx, gy] = gravity, vertical = Math.abs(gy) >= Math.abs(gx), di = vertical ? 0 : gx > 0 ? -1 : 1, dj = vertical ? (gy > 0 ? -1 : 1) : 0;
  const edge = vertical ? (gy > 0 ? 'top' : 'bottom') : gx > 0 ? 'left' : 'right', pixel = c => solid[c] && !(smooth && smooth[c]);
  // Water from every fill, since a fill may rest on another's.
  const water = new Uint8Array(W * H);
  for (const fill of fills) for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (!solid[j * W + i] && fill.inside(i + 0.5, j + 0.5)) water[j * W + i] = 1;
  const wet = (i, j) => i >= 0 && j >= 0 && i < W && j < H && water[j * W + i];
  fills.forEach((fill, f) => {
    let under = 0, against = 0, which = -1, bottom = 0, resting = 0;
    if (!gx && !gy) return;
    // A fill thrown away from what is above it, or bursting apart, does not start stuck.
    if (fill.burst || -(fill.velocity[0] * di + fill.velocity[1] * dj) > 0.25) return;
    const filled = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !solid[j * W + i] && fill.inside(i + 0.5, j + 0.5);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (!filled(i, j)) continue;
      // Its lowest cells (along gravity, under no water), and how many of them rest on an obstacle or a closed edge.
      const bi = i - di, bj = j - dj;
      if (!wet(bi, bj)) { bottom++; if (bi < 0 || bj < 0 || bi >= W || bj >= H ? walls[{ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[edge]] : solid[bj * W + bi]) resting++; }
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) { if (walls[edge]) against++; continue; }
      if (pixel(nj * W + ni)) { under++; if (which < 0) which = owner[nj * W + ni]; }
    }
    if (4 * resting >= bottom) return;
    const fix = 'give that obstacle surface: "smooth" to let the liquid fall away (adhesion still holds it on), or move the fill a pixel away from it';
    if (under) warnings.push(`${path}.fill[${f}] starts against the underside of obstacles[${which}] along ${under} pixel${under === 1 ? '' : 's'}, where the pressure holds it on: ${fix}`);
    if (against) warnings.push(`${path}.fill[${f}] starts against the closed ${edge} edge along ${against} pixel${against === 1 ? '' : 's'}, where the pressure holds it on: move the fill a pixel away from the edge`);
  });
  return warnings;
}

// ---- The grid ---------------------------------------------------------------------------------------------------------
// Cell (i, j) spans [i, i + 1) × [j, j + 1) with y down. Horizontal velocity u lives on the (W + 1) × H vertical faces
// at (i, j + 0.5), vertical velocity v on the W × (H + 1) horizontal faces at (i + 0.5, j), scalars at cell centres.
function bilinear(a, nx, ny, fx, fy) {
  if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
  if (fy < 0) fy = 0; else if (fy > ny - 1) fy = ny - 1;
  let i = Math.floor(fx), j = Math.floor(fy);
  if (i > nx - 2) i = nx - 2;
  if (j > ny - 2) j = ny - 2;
  const s = fx - i, t = fy - j, k = j * nx + i;
  return (a[k] * (1 - s) + a[k + 1] * s) * (1 - t) + (a[k + nx] * (1 - s) + a[k + nx + 1] * s) * t;
}
// Scalars read zero beyond the grid, so air entering through an open edge is clean.
function bilinearZero(a, nx, ny, fx, fy) {
  if (fx <= -1 || fy <= -1 || fx >= nx || fy >= ny) return 0;
  const i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j, k = j * nx + i;
  if (i >= 0 && j >= 0 && i < nx - 1 && j < ny - 1) return (a[k] * (1 - s) + a[k + 1] * s) * (1 - t) + (a[k + nx] * (1 - s) + a[k + nx + 1] * s) * t;
  const left = i >= 0, right = i + 1 < nx, top = j >= 0, bottom = j + 1 < ny;
  const a00 = left && top ? a[k] : 0, a10 = right && top ? a[k + 1] : 0, a01 = left && bottom ? a[k + nx] : 0, a11 = right && bottom ? a[k + nx + 1] : 0;
  return (a00 * (1 - s) + a10 * s) * (1 - t) + (a01 * (1 - s) + a11 * s) * t;
}

// `solid` is what the solver treats as solid. With smooth obstacles, `geo` (see smoothGeometry) also gives each face the
// share of it that is open, and `pixels` stays the obstacles' own pixels, which emitters, sparks and drawing go by.
// Faces against a solid cell or a closed edge carry no flow.
function fixFaces(W, H, solid, walls, uFixed, vFixed) {
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    uFixed[j * (W + 1) + i] = i === 0 ? (walls.left || solid[j * W] ? 1 : 0) : i === W ? (walls.right || solid[j * W + W - 1] ? 1 : 0) : (solid[j * W + i - 1] || solid[j * W + i] ? 1 : 0);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    vFixed[j * W + i] = j === 0 ? (walls.top || solid[i] ? 1 : 0) : j === H ? (walls.bottom || solid[(H - 1) * W + i] ? 1 : 0) : (solid[(j - 1) * W + i] || solid[j * W + i] ? 1 : 0);
  }
}
function createGrid(width, height, solid, walls, geo = null) {
  const W = width, H = height, N = W * H, U = (W + 1) * H, V = W * (H + 1);
  const uFixed = new Uint8Array(U), vFixed = new Uint8Array(V);
  if (geo) {
    for (let k = 0; k < U; k++) uFixed[k] = geo.uOpen[k] ? 0 : 1;
    for (let k = 0; k < V; k++) vFixed[k] = geo.vOpen[k] ? 0 : 1;
  } else fixFaces(W, H, solid, walls, uFixed, vFixed);
  return {
    W, H, N, solid, walls, uFixed, vFixed, geo, pixels: geo ? geo.pixels : solid,
    u: new Float64Array(U), v: new Float64Array(V), u0: new Float64Array(U), v0: new Float64Array(V),
    p: new Float64Array(N), div: new Float64Array(N), count: new Uint8Array(N), ...(geo && { weights: new Float64Array(N) })
  };
}
const gridFor = (effect, width, height) => {
  if (!effect.smooth) return createGrid(width, height, effect.solid, effect.walls);
  const geo = smoothGeometry(effect.solid, effect.smooth, width, height, effect.walls);
  return createGrid(width, height, geo.solid, effect.walls, geo);
};

// ---- Smooth obstacles -------------------------------------------------------------------------------------------------
// A smooth obstacle meets the fluid along an outline traced through its pixel steps rather than along the steps
// themselves. Each corner that sticks out loses a triangle with legs of half a pixel, and each corner that turns in (or
// where two pixels touch only at their corners) gains one, so a 1:1 staircase becomes a straight 45° slope through the
// middle of its steps, a 1:2 staircase alternates 45° and upright runs, and straight edges stay where the pixels are. A
// pixel keeps all its corners when cutting them would split it (a line one pixel thick keeps its lower side stepped and
// smooths its upper side), and nothing is smoothed where it meets a pixel obstacle or the canvas edge.
// The solver sees the outline three ways (after Batty, Bertails and Bridson, "A fast variational framework for accurate
// solid-fluid coupling", 2007): each face carries the share of it that is open, so the faces along a slope are half open
// and a flow along the slope needs no pressure to turn at every step; each cell has the share of it that is open, which
// weighs its stresses; and a signed distance to the outline, sampled every half pixel, keeps particles out of it.
const OPEN = 0, ROUNDED = 1, STEPPED = 2;
// A cell's corners, as bits.
const TL = 1, TR = 2, BL = 4, BR = 8, CORNERS = [TL, TR, BL, BR];
// How far the distance to an outline is measured (pixels), and how far a particle is set off it.
const BAND = 3, CLEARANCE = 0.02;
// The corner's position in its cell, and the two points half a pixel along the cell's edges from it.
const cornerOf = bit => [bit === TR || bit === BR ? 1 : 0, bit === BL || bit === BR ? 1 : 0];
const legsOf = (bit, i, j) => { const [cx, cy] = cornerOf(bit); return [i + 0.5, j + cy, i + cx, j + 0.5]; };
// Whether (s, t), within a cell, lies in the half-pixel triangle at that corner.
const inCorner = (s, t, bit) => { const [cx, cy] = cornerOf(bit); return (cx ? 1 - s : s) + (cy ? 1 - t : t) < 0.5; };
function smoothGeometry(pixels, smooth, W, H, walls) {
  const N = W * H, kind = new Uint8Array(N), cut = new Uint8Array(N), fill = new Uint8Array(N), convex = new Uint8Array(N);
  for (let c = 0; c < N; c++) kind[c] = smooth[c] ? ROUNDED : pixels[c] ? STEPPED : OPEN;
  // Beyond the canvas counts as stepped, so nothing is smoothed against its edges.
  const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? STEPPED : kind[j * W + i]);
  for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) {
    const tl = at(i - 1, j - 1), tr = at(i, j - 1), bl = at(i - 1, j), br = at(i, j);
    if (tl === STEPPED || tr === STEPPED || bl === STEPPED || br === STEPPED) continue;
    const n = tl + tr + bl + br;
    if (n === 1) {
      if (tl) convex[(j - 1) * W + i - 1] |= BR; else if (tr) convex[(j - 1) * W + i] |= BL; else if (bl) convex[j * W + i - 1] |= TR; else convex[j * W + i] |= TL;
    } else if (n === 3 || (n === 2 && tl === br)) {
      if (!tl) fill[(j - 1) * W + i - 1] |= BR;
      if (!tr) fill[(j - 1) * W + i] |= BL;
      if (!bl) fill[j * W + i - 1] |= TR;
      if (!br) fill[j * W + i] |= TL;
    }
  }
  // A pixel loses its one corner that sticks out. Of two opposite ones (a line one pixel thick) it loses the upper, which
  // leaves it in one piece; with more, it keeps them all.
  for (let c = 0; c < N; c++) {
    const bits = convex[c];
    if (bits === TL || bits === TR || bits === BL || bits === BR) cut[c] = bits;
    else if (bits === (TL | BR)) cut[c] = TL;
    else if (bits === (TR | BL)) cut[c] = TR;
  }
  const count = bits => (bits & 1) + ((bits >> 1) & 1) + ((bits >> 2) & 1) + ((bits >> 3) & 1);
  const open = new Float64Array(N), solid = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    open[c] = kind[c] === OPEN ? 1 - count(fill[c]) / 8 : kind[c] === ROUNDED && cut[c] ? 1 / 8 : 0;
    solid[c] = open[c] ? 0 : 1;
  }
  // A face between a smooth pixel and an open cell is open along the half beside each corner the pixel lost; a filled
  // corner covers only faces that were closed already. Faces at the canvas edge are as they were.
  const X = W + 1, uOpen = new Float64Array(X * H), vOpen = new Float64Array(W * (H + 1));
  const face = (a, b, aEnds, bEnds) => {
    if (!a && !b) return 1;
    if (a && b) return 0;
    const [k, ends] = a ? [kind[a.c], cut[a.c] & aEnds] : [kind[b.c], cut[b.c] & bEnds];
    return k === ROUNDED && ends ? 0.5 : 0;
  };
  const cell = (i, j) => (kind[j * W + i] === OPEN ? null : { c: j * W + i });
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    uOpen[j * X + i] = i === 0 ? (walls.left || pixels[j * W] ? 0 : 1) : i === W ? (walls.right || pixels[j * W + W - 1] ? 0 : 1) : face(cell(i - 1, j), cell(i, j), TR | BR, TL | BL);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    vOpen[j * W + i] = j === 0 ? (walls.top || pixels[i] ? 0 : 1) : j === H ? (walls.bottom || pixels[(H - 1) * W + i] ? 0 : 1) : face(cell(i, j - 1), cell(i, j), BL | BR, TL | TR);
  }
  // The outline as segments: the corner triangles' long sides, and the halves of the edges between a smooth pixel and an
  // open cell that neither lost nor gained a corner. Edges against pixel obstacles are not part of it.
  const segments = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const bits = cut[j * W + i] | fill[j * W + i];
    for (const bit of CORNERS) if (bits & bit) segments.push(legsOf(bit, i, j));
  }
  // A shared edge from (x0, y0) to (x1, y1): `s` is the smooth pixel, `e` the open cell, each with its corner bits at the
  // edge's two ends.
  const halves = (s, e, x0, y0, x1, y1, s0, s1, e0, e1) => {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    if (!(cut[s] & s0) && !(fill[e] & e0)) segments.push([x0, y0, mx, my]);
    if (!(cut[s] & s1) && !(fill[e] & e1)) segments.push([mx, my, x1, y1]);
  };
  for (let j = 0; j < H; j++) for (let i = 1; i < W; i++) {
    const l = j * W + i - 1, r = l + 1;
    if (kind[l] === ROUNDED && kind[r] === OPEN) halves(l, r, i, j, i, j + 1, TR, BR, TL, BL);
    else if (kind[r] === ROUNDED && kind[l] === OPEN) halves(r, l, i, j, i, j + 1, TL, BL, TR, BR);
  }
  for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
    const t = (j - 1) * W + i, b = t + W;
    if (kind[t] === ROUNDED && kind[b] === OPEN) halves(t, b, i, j, i + 1, j, BL, BR, TL, TR);
    else if (kind[b] === ROUNDED && kind[t] === OPEN) halves(b, t, i, j, i + 1, j, TL, TR, BL, BR);
  }
  // Where a smooth pixel meets a pixel obstacle, the edge between them bounds the outline too, so the distance inside a
  // smooth obstacle is measured to its real edges; pixel obstacles themselves are outside the outline.
  for (let j = 0; j < H; j++) for (let i = 1; i < W; i++) {
    const l = kind[j * W + i - 1], r = kind[j * W + i];
    if ((l === ROUNDED && r === STEPPED) || (l === STEPPED && r === ROUNDED)) segments.push([i, j, i, j + 1]);
  }
  for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
    const t = kind[(j - 1) * W + i], b = kind[j * W + i];
    if ((t === ROUNDED && b === STEPPED) || (t === STEPPED && b === ROUNDED)) segments.push([i, j, i + 1, j]);
  }
  // Inside the outline.
  const inside = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i >= W || j >= H) return false;
    const c = j * W + i, s = x - i, t = y - j;
    if (kind[c] === STEPPED) return false;
    if (kind[c] === ROUNDED) return !(cut[c] && inCorner(s, t, cut[c]));
    for (const bit of CORNERS) if ((fill[c] & bit) && inCorner(s, t, bit)) return true;
    return false;
  };
  // The signed distance (negative inside) at the centre of every quarter of a pixel, within BAND of the outline.
  const PW = 2 * W, PH = 2 * H, phi = new Float64Array(PW * PH).fill(BAND);
  for (const [x0, y0, x1, y1] of segments) {
    const dx = x1 - x0, dy = y1 - y0, length = dx * dx + dy * dy;
    const a0 = Math.max(0, Math.floor(2 * (Math.min(x0, x1) - BAND) - 0.5)), a1 = Math.min(PW - 1, Math.ceil(2 * (Math.max(x0, x1) + BAND) - 0.5));
    const b0 = Math.max(0, Math.floor(2 * (Math.min(y0, y1) - BAND) - 0.5)), b1 = Math.min(PH - 1, Math.ceil(2 * (Math.max(y0, y1) + BAND) - 0.5));
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) {
      const px = (a + 0.5) / 2, py = (b + 0.5) / 2;
      let t = ((px - x0) * dx + (py - y0) * dy) / length;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x0 + t * dx - px, ey = y0 + t * dy - py, d = Math.sqrt(ex * ex + ey * ey);
      if (d < phi[b * PW + a]) phi[b * PW + a] = d;
    }
  }
  for (let b = 0; b < PH; b++) for (let a = 0; a < PW; a++) if (inside((a + 0.5) / 2, (b + 0.5) / 2)) phi[b * PW + a] = -phi[b * PW + a];
  // The diagonal neighbours a cell is cut off from, where the corner they share lies inside the outline (a line one
  // pixel thick running diagonally) or where two obstacle pixels touch only at that corner, so a blur does not carry
  // liquid across.
  const across = new Uint8Array(N), solidAt = (i, j) => i >= 0 && j >= 0 && i < W && j < H && kind[j * W + i] !== OPEN;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    for (const bit of CORNERS) {
      const [cx, cy] = cornerOf(bit), di = cx ? 1 : -1, dj = cy ? 1 : -1;
      const pinched = !solidAt(i + di, j + dj) && solidAt(i + di, j) && solidAt(i, j + dj);
      if (pinched || bilinear(phi, PW, PH, 2 * (i + cx) - 0.5, 2 * (j + cy) - 0.5) < 0) across[j * W + i] |= bit;
    }
  }
  // The cells particles meet pixel by pixel: pixel obstacles, and smooth pixels beside or diagonal to them, where
  // nothing is smoothed and a corner the two share must not let anything through. Then the open cells against a
  // smooth obstacle.
  const stepped = new Uint8Array(N), touching = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    const i = c % W, j = (c - i) / W, near = d => d === ROUNDED;
    let meets = kind[c] === STEPPED;
    if (kind[c] === ROUNDED) for (let dj = -1; dj <= 1 && !meets; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && i + di >= 0 && j + dj >= 0 && i + di < W && j + dj < H && kind[(j + dj) * W + i + di] === STEPPED) { meets = true; break; }
    stepped[c] = meets ? 1 : 0;
    touching[c] = !solid[c] && (kind[c] === ROUNDED || (i > 0 && near(kind[c - 1])) || (i < W - 1 && near(kind[c + 1])) || (j > 0 && near(kind[c - W])) || (j < H - 1 && near(kind[c + W]))) ? 1 : 0;
  }
  return { pixels, solid, stepped, touching, across, open, uOpen, vOpen, phi, PW, PH, normal: new Float64Array(2) };
}
const outlineAt = (geo, x, y) => bilinear(geo.phi, geo.PW, geo.PH, 2 * x - 0.5, 2 * y - 0.5);
// Moves a particle from (x, y) toward (nx, ny) without entering a smooth obstacle: the path is checked every fifth of a
// pixel, and where it first enters the outline the particle is set just outside it and keeps the part of the rest of the
// move along the outline, so it slides. `velocity` loses the part that heads into the outline. Returns the new position,
// or null when the path stays clear.
const STRIDE = 0.2;
function slideSmooth(geo, W, H, x, y, nx, ny, velocity, out) {
  const dx = nx - x, dy = ny - y, distance = Math.sqrt(dx * dx + dy * dy), start = outlineAt(geo, x, y);
  if (start >= distance + 0.25) return null;
  const steps = Math.max(1, Math.ceil(distance / STRIDE));
  let lx = x, ly = y, hx = 0, hy = 0, hit = false;
  for (let k = start < 0 ? 0 : 1; k <= steps; k++) {
    const px = x + dx * k / steps, py = y + dy * k / steps;
    if (outlineAt(geo, px, py) < 0) { hx = px; hy = py; hit = true; break; }
    lx = px; ly = py;
  }
  if (!hit) return null;
  const n = geo.normal;
  slope(geo.phi, geo.PW, geo.PH, 2 * hx - 0.5, 2 * hy - 0.5, n);
  const length = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
  out[0] = lx; out[1] = ly;
  if (!(length > 1e-9)) { velocity[0] = 0; velocity[1] = 0; return out; }
  const ux = n[0] / length, uy = n[1] / length, lift = CLEARANCE - outlineAt(geo, hx, hy), qx = hx + lift * ux, qy = hy + lift * uy;
  let rx = nx - hx, ry = ny - hy;
  const along = rx * ux + ry * uy;
  if (along < 0) { rx -= along * ux; ry -= along * uy; }
  const into = velocity[0] * ux + velocity[1] * uy;
  if (into < 0) { velocity[0] -= into * ux; velocity[1] -= into * uy; }
  // Each landing spot must lie outside, be reached without crossing the outline or a pixel obstacle, or it is the next.
  const clear = (fx, fy, tx, ty) => {
    if (crossesSolid(geo.stepped, W, H, x, y, tx, ty)) return false;
    const sx = tx - fx, sy = ty - fy, parts = Math.max(1, Math.ceil(Math.sqrt(sx * sx + sy * sy) / STRIDE));
    for (let k = 1; k <= parts; k++) if (outlineAt(geo, fx + sx * k / parts, fy + sy * k / parts) < 0) return false;
    return true;
  };
  if (outlineAt(geo, qx, qy) >= 0 && !crossesSolid(geo.stepped, W, H, x, y, qx, qy)) {
    if (clear(qx, qy, qx + rx, qy + ry)) { out[0] = qx + rx; out[1] = qy + ry; } else { out[0] = qx; out[1] = qy; }
  }
  return out;
}
const sampleU = (g, a, x, y) => bilinear(a, g.W + 1, g.H, x, y - 0.5);
const sampleV = (g, a, x, y) => bilinear(a, g.W, g.H + 1, x - 0.5, y);
// Faces against an obstacle carry none of the flow, or a moving obstacle's own velocity (`uWall`, `vWall`).
function enforce(g) {
  const { u, v, uFixed, vFixed, uWall, vWall } = g;
  for (let k = 0; k < u.length; k++) if (uFixed[k]) u[k] = uWall ? uWall[k] : 0;
  for (let k = 0; k < v.length; k++) if (vFixed[k]) v[k] = vWall ? vWall[k] : 0;
}

// Makes the flow divergence-free over the active cells (every open cell for a gas, the cells holding particles for a
// liquid) with a fixed number of over-relaxed Gauss-Seidel sweeps. Obstacles and closed edges are walls; open edges
// and air cells hold zero pressure. `target` asks a cell to spread by that much (crowded liquid particles). A liquid
// takes the conjugate-gradient solve below instead.
function project(g, active, iterations, target) {
  if (g.release) return projectLiquid(g, active, iterations, target);
  if (g.geo) return projectOpen(g, active, iterations, target);
  const { W, H, u, v, p, div, solid, walls, count } = g, omega = 1.6;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (!active[c]) { p[c] = 0; count[c] = 0; continue; }
    div[c] = u[j * (W + 1) + i + 1] - u[j * (W + 1) + i] + v[(j + 1) * W + i] - v[j * W + i] - target[c];
    count[c] = (i > 0 ? (solid[c - 1] ? 0 : 1) : (walls.left ? 0 : 1)) + (i < W - 1 ? (solid[c + 1] ? 0 : 1) : (walls.right ? 0 : 1))
      + (j > 0 ? (solid[c - W] ? 0 : 1) : (walls.top ? 0 : 1)) + (j < H - 1 ? (solid[c + W] ? 0 : 1) : (walls.bottom ? 0 : 1));
  }
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i, n = count[c];
      if (!n) continue;
      let sum = 0;
      if (i > 0 && active[c - 1]) sum += p[c - 1];
      if (i < W - 1 && active[c + 1]) sum += p[c + 1];
      if (j > 0 && active[c - W]) sum += p[c - W];
      if (j < H - 1 && active[c + W]) sum += p[c + W];
      p[c] += omega * ((sum - div[c]) / n - p[c]);
    }
  }
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * (W + 1) + i;
    if (g.uFixed[k]) continue;
    const l = i > 0 && active[j * W + i - 1], r = i < W && active[j * W + i];
    if (l || r) u[k] -= (r ? p[j * W + i] : 0) - (l ? p[j * W + i - 1] : 0);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (g.vFixed[k]) continue;
    const t = j > 0 && active[(j - 1) * W + i], b = j < H && active[j * W + i];
    if (t || b) v[k] -= (b ? p[j * W + i] : 0) - (t ? p[(j - 1) * W + i] : 0);
  }
}

// The same solve with each face weighted by the share of it that is open (smooth obstacles): flow through a face counts
// by that share, and so does the pressure difference across it. With every face open or closed it is the solve above.
function projectOpen(g, active, iterations, target) {
  const { W, H, u, v, p, div, weights: weight } = g, { uOpen, vOpen } = g.geo, X = W + 1, omega = 1.6;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (!active[c]) { p[c] = 0; weight[c] = 0; continue; }
    const l = uOpen[j * X + i], r = uOpen[j * X + i + 1], t = vOpen[j * W + i], b = vOpen[(j + 1) * W + i];
    div[c] = r * u[j * X + i + 1] - l * u[j * X + i] + b * v[(j + 1) * W + i] - t * v[j * W + i] - target[c];
    if (g.uWall) div[c] += (1 - r) * g.uWall[j * X + i + 1] - (1 - l) * g.uWall[j * X + i] + (1 - b) * g.vWall[(j + 1) * W + i] - (1 - t) * g.vWall[j * W + i];
    weight[c] = l + r + t + b;
  }
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i, n = weight[c];
      if (!n) continue;
      let sum = 0;
      if (i > 0 && active[c - 1]) sum += uOpen[j * X + i] * p[c - 1];
      if (i < W - 1 && active[c + 1]) sum += uOpen[j * X + i + 1] * p[c + 1];
      if (j > 0 && active[c - W]) sum += vOpen[j * W + i] * p[c - W];
      if (j < H - 1 && active[c + W]) sum += vOpen[(j + 1) * W + i] * p[c + W];
      p[c] += omega * ((sum - div[c]) / n - p[c]);
    }
  }
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * X + i;
    if (g.uFixed[k]) continue;
    const l = i > 0 && active[j * W + i - 1], r = i < W && active[j * W + i];
    if (l || r) u[k] -= (r ? p[j * W + i] : 0) - (l ? p[j * W + i - 1] : 0);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (g.vFixed[k]) continue;
    const t = j > 0 && active[(j - 1) * W + i], b = j < H && active[j * W + i];
    if (t || b) v[k] -= (b ? p[j * W + i] : 0) - (t ? p[(j - 1) * W + i] : 0);
  }
}

// A liquid's pressure solve: conjugate gradients with a modified incomplete Cholesky preconditioner, MIC(0) (Bridson,
// "Fluid Simulation for Computer Graphics", 2nd ed., 5.3), the same system as the sweeps above, with faces weighted by
// their open share beside smooth obstacles. Sweeps carry pressure only a few cells a step against their scan order, so
// in a pipe, a channel or a tall column the push that holds the liquid lagged the flow by several steps, and a lagging
// push pumps a slosh up (jelly left in a 4-wide pipe bobbed for good, and a long U-tube's slosh grew). MIC(0) solves a
// chain one cell wide exactly and a thin channel nearly so, and each step costs about three sweeps, so a liquid spends
// `iterations` / 3 steps, starting from the previous step's pressure. A smooth obstacle pushes on a liquid but never
// pulls it, so the liquid can leave it (adhesion holds it on): a cell beside one that the solve leaves pulling is held
// at zero pressure, as air is, and the solve runs again, up to twice.
// With air pockets (see sealAir) the air cells of a sealed pocket hold its pressure instead of zero. In the flow's solve
// each pocket (`g.pockets`) is one more unknown: its pressure P follows the gas law at the volume the solve leaves it,
// linearised, P = Pn + P'·dt·dV/dt, where dV/dt is the flow out through its faces. With C = −1 / (P'·dt) that is the row
// (C + Σ w)·P − Σ w·p_L = C·Pn − Σ w·u_out over its faces (open share w, liquid cell L, flow u_out away from it): the
// pressure Poisson row of one big cell, plus C on its diagonal, so the system stays symmetric and positive definite, and
// the pocket is as stable as the liquid at any stiffness. (As a pressure fixed from the volume at the start of the step,
// a stiff pocket overshot and rang.) Its preconditioner is its diagonal. Later solves in the step (a thick liquid's) take
// the pocket pressures as fixed (`g.airP`), as does a pocket squeezed past the gas law's range.
const NO_POCKETS = new Float64Array(0);
// A body of liquid sealed in on every side by solids (obstacles, ice) with no air beside it, no open edge and no pocket:
// nothing can take up a change in its volume, so its pressure is known only up to a constant and the solve has an
// answer only when what the body asks for (its crowded cells' spreading, a wall moving in) sums to zero. Asked for more,
// conjugate gradients ran off to huge pressures (water caught between ice and a smooth slope). Each sealed body gives
// up the sum, shared evenly over its cells. A cell of a body with a face to anything off the solve (air, a pocket, an
// open edge) holds the body's pressure, so its row has slack: its open faces outnumber its couplings.
function sealedBodies(g, solve, diag, ax, ay, div) {
  const { W, N } = g, body = g.cg.body ??= new Int32Array(N), order = g.cg.order ??= new Int32Array(N);
  body.fill(-1);
  for (let c0 = 0; c0 < N; c0++) {
    if (!solve[c0] || body[c0] >= 0) continue;
    let end = 0, sealed = true, sum = 0;
    order[end++] = c0; body[c0] = c0;
    for (let at = 0; at < end; at++) {
      const c = order[at], i = c % W, left = i > 0 ? ax[c - 1] : 0, up = c >= W ? ay[c - W] : 0;
      if (diag[c] - ax[c] - ay[c] - left - up > 1e-9) sealed = false;
      sum += div[c];
      if (ax[c] && body[c + 1] < 0) { body[c + 1] = c0; order[end++] = c + 1; }
      if (ay[c] && body[c + W] < 0) { body[c + W] = c0; order[end++] = c + W; }
      if (left && body[c - 1] < 0) { body[c - 1] = c0; order[end++] = c - 1; }
      if (up && body[c - W] < 0) { body[c - W] = c0; order[end++] = c - W; }
    }
    if (!sealed) continue;
    const mean = sum / end;
    for (let at = 0; at < end; at++) div[order[at]] -= mean;
  }
}
function projectLiquid(g, active, iterations, target) {
  const { W, H, N, u, v, p, div, geo, uFixed, vFixed, airP, pockets } = g, X = W + 1, steps = Math.ceil(iterations / 3), m = pockets ? pockets.Pn.length : 0;
  if (!g.cg) g.cg = { diag: new Float64Array(N), ax: new Float64Array(N), ay: new Float64Array(N), solve: new Uint8Array(N), prec: new Float64Array(N), r: new Float64Array(N), z: new Float64Array(N), s: new Float64Array(N), q: new Float64Array(N) };
  const { diag, ax, ay, solve, prec, r, z, s, q } = g.cg;
  // The open share of each face: pixel faces are open or shut, a smooth obstacle's may be half open.
  const openU = geo ? k => geo.uOpen[k] : k => (uFixed[k] ? 0 : 1), openV = geo ? k => geo.vOpen[k] : k => (vFixed[k] ? 0 : 1);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i, l = openU(j * X + i), rr = openU(j * X + i + 1), t = openV(c), b = openV(c + W);
    diag[c] = l + rr + t + b;
    solve[c] = active[c] && diag[c] > 0 ? 1 : 0;
    if (!solve[c]) { p[c] = airP ? airP[c] : 0; div[c] = 0; continue; }
    if (geo) {
      div[c] = rr * u[j * X + i + 1] - l * u[j * X + i] + b * v[c + W] - t * v[c] - target[c];
      if (g.uWall) div[c] += (1 - rr) * g.uWall[j * X + i + 1] - (1 - l) * g.uWall[j * X + i] + (1 - b) * g.vWall[c + W] - (1 - t) * g.vWall[c];
    } else div[c] = u[j * X + i + 1] - u[j * X + i] + v[c + W] - v[c] - target[c];
    // A pocket's pressure beside the cell is known, so it moves to the right side.
    if (airP) div[c] -= (i > 0 && !active[c - 1] ? l * airP[c - 1] : 0) + (i < W - 1 && !active[c + 1] ? rr * airP[c + 1] : 0) + (j > 0 && !active[c - W] ? t * airP[c - W] : 0) + (j < H - 1 && !active[c + W] ? b * airP[c + W] : 0);
  }
  // Each pocket's row: its faces to liquid cells (cell, pocket, open share), its diagonal and its right side.
  const vector = () => (m ? new Float64Array(m) : NO_POCKETS), faces = [], np = vector(), nd = vector(), nb = vector(), nr = vector(), nz = vector(), ns = vector(), nq = vector();
  if (m) {
    const { node, Pn, C } = pockets;
    for (let n = 0; n < m; n++) { np[n] = Pn[n]; nd[n] = C[n]; nb[n] = C[n] * Pn[n]; }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i, n = node[c];
      if (n < 0) continue;
      // Each face that leaves the pocket, with the flow out through it (sign) and the cell beyond.
      for (const [k, sign, d, inside, share, flow, walls] of [[j * X + i, -1, c - 1, i > 0, openU, u, g.uWall], [j * X + i + 1, 1, c + 1, i < W - 1, openU, u, g.uWall], [c, -1, c - W, j > 0, openV, v, g.vWall], [c + W, 1, c + W, j < H - 1, openV, v, g.vWall]]) {
        const w = share(k);
        if (walls) nb[n] -= sign * (1 - w) * walls[k];
        if (!w || !inside || node[d] === n) continue;
        nb[n] -= sign * w * flow[k];
        if (active[d]) { nd[n] += w; faces.push(d, n, w); }
      }
    }
  }
  const touching = geo ? geo.touching : null;
  for (let pass = 0; pass < (touching ? 3 : 1); pass++) {
    // The couplings to the cell on the right and the one below, between cells being solved.
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i;
      ax[c] = solve[c] && i < W - 1 && solve[c + 1] ? openU(j * X + i + 1) : 0;
      ay[c] = solve[c] && j < H - 1 && solve[c + W] ? openV(c + W) : 0;
    }
    sealedBodies(g, solve, diag, ax, ay, div);
    // MIC(0), tuning 0.97, with the plain diagonal wherever the factor would fall below a quarter of it.
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i;
      if (!solve[c]) { prec[c] = 0; continue; }
      let e = diag[c];
      if (i > 0) { const a = ax[c - 1] * prec[c - 1]; e -= a * a + 0.97 * ax[c - 1] * ay[c - 1] * prec[c - 1] * prec[c - 1]; }
      if (j > 0) { const a = ay[c - W] * prec[c - W]; e -= a * a + 0.97 * ay[c - W] * ax[c - W] * prec[c - W] * prec[c - W]; }
      if (e < 0.25 * diag[c]) e = diag[c];
      prec[c] = 1 / Math.sqrt(e);
    }
    const times = (x, out, xn, outn) => {
      for (let j = 0, c = 0; j < H; j++) for (let i = 0; i < W; i++, c++) {
        if (!solve[c]) { out[c] = 0; continue; }
        let t = diag[c] * x[c];
        if (ax[c]) t -= ax[c] * x[c + 1];
        if (ay[c]) t -= ay[c] * x[c + W];
        if (i > 0 && ax[c - 1]) t -= ax[c - 1] * x[c - 1];
        if (j > 0 && ay[c - W]) t -= ay[c - W] * x[c - W];
        out[c] = t;
      }
      if (!m) return;
      for (let n = 0; n < m; n++) outn[n] = nd[n] * xn[n];
      for (let f = 0; f < faces.length; f += 3) {
        const c = faces[f], n = faces[f + 1], w = faces[f + 2];
        if (!solve[c]) continue;
        out[c] -= w * xn[n]; outn[n] -= w * x[c];
      }
    };
    const precondition = (from, out) => {
      for (let j = 0, c = 0; j < H; j++) for (let i = 0; i < W; i++, c++) {
        if (!solve[c]) { out[c] = 0; continue; }
        let t = from[c];
        if (i > 0 && ax[c - 1]) t += ax[c - 1] * prec[c - 1] * out[c - 1];
        if (j > 0 && ay[c - W]) t += ay[c - W] * prec[c - W] * out[c - W];
        out[c] = t * prec[c];
      }
      for (let c = N - 1; c >= 0; c--) {
        if (!solve[c]) continue;
        let t = out[c];
        if (ax[c]) t += ax[c] * prec[c] * out[c + 1];
        if (ay[c]) t += ay[c] * prec[c] * out[c + W];
        out[c] = t * prec[c];
      }
    };
    // Solves diag·p − Σ coupling·p_neighbour = −div from the pressure already in p, and each pocket's row (none
    // without pockets, when every loop over them is empty and the solve is the plain one).
    times(p, q, np, nq);
    let rz = 0;
    for (let c = 0; c < N; c++) r[c] = solve[c] ? -div[c] - q[c] : 0;
    for (let n = 0; n < m; n++) nr[n] = nb[n] - nq[n];
    precondition(r, z);
    for (let n = 0; n < m; n++) nz[n] = nr[n] / nd[n];
    for (let c = 0; c < N; c++) { s[c] = z[c]; rz += r[c] * z[c]; }
    for (let n = 0; n < m; n++) { ns[n] = nz[n]; rz += nr[n] * nz[n]; }
    for (let it = 0; it < steps && rz > 0; it++) {
      times(s, q, ns, nq);
      let sq = 0;
      for (let c = 0; c < N; c++) sq += s[c] * q[c];
      for (let n = 0; n < m; n++) sq += ns[n] * nq[n];
      if (!(sq > 0)) break;
      const alpha = rz / sq;
      for (let c = 0; c < N; c++) if (solve[c]) { p[c] += alpha * s[c]; r[c] -= alpha * q[c]; }
      for (let n = 0; n < m; n++) { np[n] += alpha * ns[n]; nr[n] -= alpha * nq[n]; }
      precondition(r, z);
      for (let n = 0; n < m; n++) nz[n] = nr[n] / nd[n];
      let next = 0;
      for (let c = 0; c < N; c++) next += r[c] * z[c];
      for (let n = 0; n < m; n++) next += nr[n] * nz[n];
      const beta = next / rz;
      rz = next;
      for (let c = 0; c < N; c++) s[c] = z[c] + beta * s[c];
      for (let n = 0; n < m; n++) ns[n] = nz[n] + beta * ns[n];
    }
    if (!touching) break;
    let pulled = false;
    for (let c = 0; c < N; c++) if (solve[c] && touching[c] && p[c] < 0) { p[c] = 0; solve[c] = 0; pulled = true; }
    if (!pulled) break;
  }
  // The pockets' cells take the pressure solved for them, which later solves in the step keep.
  if (m) for (let c = 0; c < N; c++) if (pockets.node[c] >= 0) { p[c] = np[pockets.node[c]]; airP[c] = p[c]; }
  // Every cell off the solve holds its pressure in p (zero, or a pocket's), so with pockets a face reads both sides.
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * X + i;
    if (uFixed[k]) continue;
    const l = i > 0 && active[j * W + i - 1], rr = i < W && active[j * W + i];
    if (airP) { if (l || rr) u[k] -= (i < W ? p[j * W + i] : 0) - (i > 0 ? p[j * W + i - 1] : 0); } else if (l || rr) u[k] -= (rr ? p[j * W + i] : 0) - (l ? p[j * W + i - 1] : 0);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (vFixed[k]) continue;
    const t = j > 0 && active[(j - 1) * W + i], b = j < H && active[j * W + i];
    if (airP) { if (t || b) v[k] -= (j < H ? p[j * W + i] : 0) - (j > 0 ? p[(j - 1) * W + i] : 0); } else if (t || b) v[k] -= (b ? p[j * W + i] : 0) - (t ? p[(j - 1) * W + i] : 0);
  }
}

// Semi-Lagrangian self-advection with a midpoint back-trace.
function advectVelocity(g, dt) {
  const { W, H, u, v, u0, v0, uFixed, vFixed } = g;
  u0.set(u); v0.set(v);
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * (W + 1) + i;
    if (uFixed[k]) continue;
    const x = i, y = j + 0.5, ax = u0[k], ay = sampleV(g, v0, x, y), mx = x - 0.5 * dt * ax, my = y - 0.5 * dt * ay;
    u[k] = sampleU(g, u0, x - dt * sampleU(g, u0, mx, my), y - dt * sampleV(g, v0, mx, my));
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (vFixed[k]) continue;
    const x = i + 0.5, y = j, ax = sampleU(g, u0, x, y), ay = v0[k], mx = x - 0.5 * dt * ax, my = y - 0.5 * dt * ay;
    v[k] = sampleV(g, v0, x - dt * sampleU(g, u0, mx, my), y - dt * sampleV(g, v0, mx, my));
  }
}

// Scalars move with the flow; the back-trace (and for sharp advection the forward trace) is shared by every field.
function advectScalars(g, dt, pairs, sharp) {
  const { W, H, N, u, v, solid } = g, s = sharp ? sharpScratch(g) : null;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (solid[c]) { for (const [, next] of pairs) next[c] = 0; continue; }
    const x = i + 0.5, y = j + 0.5, ax = sampleU(g, u, x, y), ay = sampleV(g, v, x, y), mx = x - 0.5 * dt * ax, my = y - 0.5 * dt * ay;
    const bx = x - dt * sampleU(g, u, mx, my) - 0.5, by = y - dt * sampleV(g, v, mx, my) - 0.5;
    for (const [field, next] of pairs) next[c] = bilinearZero(field, W, H, bx, by);
    if (s) {
      const fx = x + 0.5 * dt * ax, fy = y + 0.5 * dt * ay;
      s.bx[c] = bx; s.by[c] = by; s.fx[c] = x + dt * sampleU(g, u, fx, fy) - 0.5; s.fy[c] = y + dt * sampleV(g, v, fx, fy) - 0.5;
    }
  }
  if (!s) return;
  for (const [field, next] of pairs) {
    for (let c = 0; c < N; c++) if (!solid[c]) s.next[c] = bilinearZero(next, W, H, s.fx[c], s.fy[c]);
    for (let c = 0; c < N; c++) {
      if (solid[c]) continue;
      cornersZero(field, W, H, s.bx[c], s.by[c], s.range);
      const value = next[c] + 0.5 * (field[c] - s.next[c]);
      next[c] = value < s.range[0] ? s.range[0] : value > s.range[1] ? s.range[1] : value;
    }
  }
}

// The lowest and highest of the four lattice values `bilinear` blends at (fx, fy), written to `out`.
function corners(a, nx, ny, fx, fy, out) {
  if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
  if (fy < 0) fy = 0; else if (fy > ny - 1) fy = ny - 1;
  let i = Math.floor(fx), j = Math.floor(fy);
  if (i > nx - 2) i = nx - 2;
  if (j > ny - 2) j = ny - 2;
  const k = j * nx + i, a0 = a[k], a1 = a[k + 1], a2 = a[k + nx], a3 = a[k + nx + 1];
  out[0] = Math.min(a0, a1, a2, a3); out[1] = Math.max(a0, a1, a2, a3);
}
// The same for `bilinearZero`, where lattice points beyond the grid read 0.
function cornersZero(a, nx, ny, fx, fy, out) {
  const i = Math.floor(fx), j = Math.floor(fy), k = j * nx + i, left = i >= 0 && i < nx, right = i + 1 >= 0 && i + 1 < nx, top = j >= 0 && j < ny, bottom = j + 1 >= 0 && j + 1 < ny;
  const a0 = left && top ? a[k] : 0, a1 = right && top ? a[k + 1] : 0, a2 = left && bottom ? a[k + nx] : 0, a3 = right && bottom ? a[k + nx + 1] : 0;
  out[0] = Math.min(a0, a1, a2, a3); out[1] = Math.max(a0, a1, a2, a3);
}
// The slope [d/dx, d/dy] of the interpolation `bilinear` makes at (fx, fy), written to `out`; 0 along an axis where
// the point lies beyond the lattice, since the interpolation is flat there.
function slope(a, nx, ny, fx, fy, out) {
  let flatX = false, flatY = false;
  if (fx < 0) { fx = 0; flatX = true; } else if (fx > nx - 1) { fx = nx - 1; flatX = true; }
  if (fy < 0) { fy = 0; flatY = true; } else if (fy > ny - 1) { fy = ny - 1; flatY = true; }
  let i = Math.floor(fx), j = Math.floor(fy);
  if (i > nx - 2) i = nx - 2;
  if (j > ny - 2) j = ny - 2;
  const s = fx - i, t = fy - j, k = j * nx + i;
  out[0] = flatX ? 0 : (a[k + 1] - a[k]) * (1 - t) + (a[k + nx + 1] - a[k + nx]) * t;
  out[1] = flatY ? 0 : (a[k + nx] - a[k]) * (1 - s) + (a[k + nx + 1] - a[k + 1]) * s;
}

// Sharp advection (MacCormack, with the limiter of Selle et al., "An unconditionally stable MacCormack method", 2008):
// after the plain back-trace, the result is traced forward again and half the round trip's error is taken off, then
// clamped to the values the back-trace blended, so edges and small swirls stay crisp without new peaks or ripples.
function sharpScratch(g) {
  if (!g.sharp) {
    const f = n => new Float64Array(n), U = g.u.length, V = g.v.length, N = g.N;
    g.sharp = { u1: f(U), v1: f(V), uLo: f(U), uHi: f(U), vLo: f(V), vHi: f(V), bx: f(N), by: f(N), fx: f(N), fy: f(N), next: f(N), range: f(2) };
  }
  return g.sharp;
}
function sharpenVelocity(g, dt) {
  const { W, H, u, v, u0, v0, uFixed, vFixed } = g, { u1, v1, uLo, uHi, vLo, vHi, range } = sharpScratch(g);
  // The limits come from the old velocities around each back-traced point.
  const trace = (x, y, ax, ay, direction) => { const mx = x + direction * 0.5 * dt * ax, my = y + direction * 0.5 * dt * ay; return [x + direction * dt * sampleU(g, u0, mx, my), y + direction * dt * sampleV(g, v0, mx, my)]; };
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * (W + 1) + i;
    if (uFixed[k]) continue;
    const x = i, y = j + 0.5, ax = u0[k], ay = sampleV(g, v0, x, y), [bx, by] = trace(x, y, ax, ay, -1), [fx, fy] = trace(x, y, ax, ay, 1);
    corners(u0, W + 1, H, bx, by - 0.5, range); uLo[k] = range[0]; uHi[k] = range[1];
    u1[k] = sampleU(g, u, fx, fy);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (vFixed[k]) continue;
    const x = i + 0.5, y = j, ax = sampleU(g, u0, x, y), ay = v0[k], [bx, by] = trace(x, y, ax, ay, -1), [fx, fy] = trace(x, y, ax, ay, 1);
    corners(v0, W, H + 1, bx - 0.5, by, range); vLo[k] = range[0]; vHi[k] = range[1];
    v1[k] = sampleV(g, v, fx, fy);
  }
  const correct = (a, a0, a1, lo, hi, fixed) => { for (let k = 0; k < a.length; k++) if (!fixed[k]) { const value = a[k] + 0.5 * (a0[k] - a1[k]); a[k] = value < lo[k] ? lo[k] : value > hi[k] ? hi[k] : value; } };
  correct(u, u0, u1, uLo, uHi, uFixed); correct(v, v0, v1, vLo, vHi, vFixed);
}

// ---- Viscosity --------------------------------------------------------------------------------------------------------
// Implicit viscosity in stress form, after Batty and Bridson ("Accurate viscous free surfaces for buckling, coiling and
// rotating liquids", 2008): the faces beside the fluid solve u − dt ∇·(μ (∇u + ∇uᵀ)) = u₀ with a fixed number of
// Jacobi-preconditioned conjugate-gradient steps. On the staggered grid, stretching stress lives at cell centres and
// shear at cell corners. μ is the fluid's viscosity in its cells and 0 in air, and a corner that touches air carries no
// shear, so the surface is free of stress: a thick drop falls as fast as water, and only shearing and stretching are
// slowed, never motion as a whole, sliding or turning. Walls and obstacles hold the fluid (faces in them, and anything
// beyond a closed edge, read 0); with `slip`, corners touching them carry no shear, so it slides along them instead.
const AIR = 0, FLUID = 1, SOLID = 2;
function viscosityScratch(g) {
  if (!g.visc) {
    const { N, W, H } = g, U = g.u.length, V = g.v.length, M = (W + 1) * (H + 1), f = n => new Float64Array(n);
    g.visc = { mu: f(N), node: f(M), kind: new Uint8Array(N), uLive: new Uint8Array(U), vLive: new Uint8Array(V), du: f(U), dv: f(V), ru: f(U), rv: f(V), zu: f(U), zv: f(V), pu: f(U), pv: f(V), qu: f(U), qv: f(V), sxx: f(N), syy: f(N), sxy: f(M) };
  }
  return g.visc;
}
// q = p − dt ∇·(μ (∇p + ∇pᵀ)) on the faces taking part; p must be 0 on the others, or on fixed faces at least.
function applyViscosity(g, dt, pu, pv, qu, qv) {
  const { W, H } = g, { mu, node, uLive, vLive, sxx, syy, sxy, uDrag, vDrag } = g.visc, X = W + 1;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i, m = mu[c];
    if (m) { sxx[c] = 2 * m * (pu[j * X + i + 1] - pu[j * X + i]); syy[c] = 2 * m * (pv[(j + 1) * W + i] - pv[j * W + i]); } else { sxx[c] = 0; syy[c] = 0; }
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) {
    const n = j * X + i, m = node[n];
    if (!m) { sxy[n] = 0; continue; }
    const above = j > 0 ? pu[(j - 1) * X + i] : 0, below = j < H ? pu[j * X + i] : 0, left = i > 0 ? pv[j * W + i - 1] : 0, right = i < W ? pv[j * W + i] : 0;
    sxy[n] = m * (below - above + right - left);
  }
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * X + i;
    qu[k] = uLive[k] ? pu[k] - dt * ((i < W ? sxx[j * W + i] : 0) - (i > 0 ? sxx[j * W + i - 1] : 0) + sxy[(j + 1) * X + i] - sxy[j * X + i]) : 0;
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    qv[k] = vLive[k] ? pv[k] - dt * ((j < H ? syy[k] : 0) - (j > 0 ? syy[k - W] : 0) + sxy[j * X + i + 1] - sxy[j * X + i]) : 0;
  }
  // A face partly inside a smooth obstacle is held by its closed part, unless the fluid slips.
  if (uDrag) {
    for (let k = 0; k < qu.length; k++) if (uDrag[k]) qu[k] += dt * uDrag[k] * pu[k];
    for (let k = 0; k < qv.length; k++) if (vDrag[k]) qv[k] += dt * vDrag[k] * pv[k];
  }
}
// Each cell as air, fluid (one of `active`) or solid, and what lies beyond each edge: a closed edge is a wall.
function classify(g, active) {
  const { N, solid } = g, { kind } = g.visc;
  for (let c = 0; c < N; c++) kind[c] = solid[c] ? SOLID : active[c] ? FLUID : AIR;
}
// A value at each cell corner: the mean of `values` over the fluid cells around it, or 0 where it touches air (the free
// surface carries no shear) or, with `slip`, a wall.
function cornerMean(g, values, slip, out) {
  const { W, H, walls } = g, { kind } = g.visc, X = W + 1;
  const at = (i, j) => (i < 0 ? (walls.left ? SOLID : AIR) : i >= W ? (walls.right ? SOLID : AIR) : j < 0 ? (walls.top ? SOLID : AIR) : j >= H ? (walls.bottom ? SOLID : AIR) : kind[j * W + i]);
  let sum = 0, count = 0, air = false, wall = false;
  const look = (i, j) => { const k = at(i, j); if (k === AIR) air = true; else if (k === SOLID) wall = true; else { sum += values[j * W + i]; count++; } };
  for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) {
    sum = 0; count = 0; air = false; wall = false;
    look(i - 1, j - 1); look(i, j - 1); look(i - 1, j); look(i, j);
    out[j * X + i] = air || !count || (slip && wall) ? 0 : sum / count;
  }
}
// One viscosity step over the cells in `active` (the open cells of a gas, the wet cells of a liquid), each with the
// effect's viscosity plus `extra` (a yield-stress liquid's stiffness where it has not yielded).
function viscous(g, active, effect, dt, extra = null) {
  const { W, H, N, u, v, uFixed, vFixed } = g, w = viscosityScratch(g), { mu, node, kind, uLive, vLive, du, dv } = w, X = W + 1;
  classify(g, active);
  for (let c = 0; c < N; c++) mu[c] = kind[c] === FLUID ? effect.viscosity + (extra ? extra[c] : 0) : 0;
  // Beside smooth obstacles, a cell's stresses count by the share of it that is open, so a pixel step that the outline
  // cuts through barely resists a flow sliding past it; a face partly closed is dragged toward rest by its closed part.
  const { geo } = g, held = geo && !effect.slip;
  if (held && !w.uDrag) { w.uDrag = new Float64Array(u.length); w.vDrag = new Float64Array(v.length); }
  if (!held) w.uDrag = w.vDrag = null;
  const thick = (a, b) => { const n = (a >= 0 && kind[a] === FLUID ? 1 : 0) + (b >= 0 && kind[b] === FLUID ? 1 : 0); return n ? ((a >= 0 && kind[a] === FLUID ? mu[a] : 0) + (b >= 0 && kind[b] === FLUID ? mu[b] : 0)) / n : 0; };
  if (held) {
    for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) { const k = j * X + i, open = geo.uOpen[k]; w.uDrag[k] = open > 0 && open < 1 ? 2 * (1 - open) * thick(i > 0 ? j * W + i - 1 : -1, i < W ? j * W + i : -1) : 0; }
    for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) { const k = j * W + i, open = geo.vOpen[k]; w.vDrag[k] = open > 0 && open < 1 ? 2 * (1 - open) * thick(j > 0 ? k - W : -1, j < H ? k : -1) : 0; }
  }
  if (geo) for (let c = 0; c < N; c++) mu[c] *= geo.open[c];
  cornerMean(g, mu, effect.slip, node);
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * X + i, l = i > 0 ? mu[j * W + i - 1] : 0, r = i < W ? mu[j * W + i] : 0;
    uLive[k] = !uFixed[k] && ((i > 0 && kind[j * W + i - 1] === FLUID) || (i < W && kind[j * W + i] === FLUID)) ? 1 : 0;
    if (uLive[k]) du[k] = 1 + dt * (2 * l + 2 * r + node[k] + node[k + X] + (held ? w.uDrag[k] : 0));
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, t = j > 0 ? mu[k - W] : 0, b = j < H ? mu[k] : 0;
    vLive[k] = !vFixed[k] && ((j > 0 && kind[k - W] === FLUID) || (j < H && kind[k] === FLUID)) ? 1 : 0;
    if (vLive[k]) dv[k] = 1 + dt * (2 * t + 2 * b + node[j * X + i] + node[j * X + i + 1] + (held ? w.vDrag[k] : 0));
  }
  // Conjugate gradients from the current velocities, so b = x and the first residual is x − A x.
  const { ru, rv, zu, zv, pu, pv, qu, qv } = w;
  applyViscosity(g, dt, u, v, qu, qv);
  let rz = 0;
  // A part-open face beside a moving smooth obstacle is dragged toward the obstacle's velocity, not toward rest.
  const towardU = held && g.uWall ? g.uWall : null, towardV = held && g.vWall ? g.vWall : null;
  for (let k = 0; k < u.length; k++) { if (uLive[k]) { ru[k] = u[k] - qu[k]; if (towardU && w.uDrag[k] && towardU[k]) ru[k] += dt * w.uDrag[k] * towardU[k]; zu[k] = ru[k] / du[k]; pu[k] = zu[k]; rz += ru[k] * zu[k]; } else pu[k] = 0; }
  for (let k = 0; k < v.length; k++) { if (vLive[k]) { rv[k] = v[k] - qv[k]; if (towardV && w.vDrag[k] && towardV[k]) rv[k] += dt * w.vDrag[k] * towardV[k]; zv[k] = rv[k] / dv[k]; pv[k] = zv[k]; rz += rv[k] * zv[k]; } else pv[k] = 0; }
  for (let it = 0; it < effect.iterations && rz > 0; it++) {
    applyViscosity(g, dt, pu, pv, qu, qv);
    let pq = 0;
    for (let k = 0; k < u.length; k++) if (uLive[k]) pq += pu[k] * qu[k];
    for (let k = 0; k < v.length; k++) if (vLive[k]) pq += pv[k] * qv[k];
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    let next = 0;
    for (let k = 0; k < u.length; k++) if (uLive[k]) { u[k] += alpha * pu[k]; ru[k] -= alpha * qu[k]; zu[k] = ru[k] / du[k]; next += ru[k] * zu[k]; }
    for (let k = 0; k < v.length; k++) if (vLive[k]) { v[k] += alpha * pv[k]; rv[k] -= alpha * qv[k]; zv[k] = rv[k] / dv[k]; next += rv[k] * zv[k]; }
    const beta = next / rz;
    rz = next;
    for (let k = 0; k < u.length; k++) if (uLive[k]) pu[k] = zu[k] + beta * pu[k];
    for (let k = 0; k < v.length; k++) if (vLive[k]) pv[k] = zv[k] + beta * pv[k];
  }
}

// ---- Yield stress -----------------------------------------------------------------------------------------------------
// A yield-stress liquid (mud, slime, toothpaste) is elastic until it is pushed past its yield, and then flows: after
// Goktekin, Bargteil and O'Brien, "A method for animating viscoelastic fluids" (2004). Each particle carries how far it
// has been strained out of shape (the deviatoric strain: a stretch a and a shear b), turned with the flow and capped at
// the yield strain, where any further strain is plastic flow. The elastic stress, 2 × STIFFNESS × strain, pushes the
// liquid back toward its shape. It is split as implicit elasticity is: the stress of the strain so far is a force here,
// and the strain this step adds acts as viscosity STIFFNESS × dt in the viscosity solve, in the cells below the yield.
// A heap of height h holds itself up when the yield is more than about gravity × h / 2.
function strainForce(state, effect, dt) {
  const { g, fluid, strain } = state, { W, H, N, u, v, uFixed, vFixed } = g, { a, b, count, stiff, shear } = strain, X = W + 1;
  const limit = effect.yield / (2 * STIFFNESS), k2 = 2 * STIFFNESS;
  a.fill(0); b.fill(0); count.fill(0);
  for (let k = 0; k < state.n; k++) { const c = Math.floor(state.y[k]) * W + Math.floor(state.x[k]); a[c] += state.ea[k]; b[c] += state.eb[k]; count[c]++; }
  for (let c = 0; c < N; c++) {
    if (count[c]) { a[c] /= count[c]; b[c] /= count[c]; }
    stiff[c] = !fluid[c] ? 0 : a[c] * a[c] + b[c] * b[c] < 0.98 * limit * limit ? STIFFNESS * dt : Math.min(STIFFNESS * dt, PLASTIC);
  }
  // Beside smooth obstacles the stress counts by the share of each cell that is open, as viscous stress does.
  if (g.geo) for (let c = 0; c < N; c++) { a[c] *= g.geo.open[c]; b[c] *= g.geo.open[c]; }
  viscosityScratch(g); classify(g, fluid);
  cornerMean(g, b, effect.slip, shear);
  // u gains dt (∂σxx/∂x + ∂σxy/∂y) and v gains dt (∂σxy/∂x + ∂σyy/∂y), with σxx = 2k a = −σyy and σxy = 2k b.
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * X + i, l = i > 0 && fluid[j * W + i - 1], r = i < W && fluid[j * W + i];
    if (uFixed[k] || (!l && !r)) continue;
    u[k] += dt * k2 * ((r ? a[j * W + i] : 0) - (l ? a[j * W + i - 1] : 0) + shear[(j + 1) * X + i] - shear[j * X + i]);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, t = j > 0 && fluid[k - W], d = j < H && fluid[k];
    if (vFixed[k] || (!t && !d)) continue;
    v[k] += dt * k2 * ((t ? a[k - W] : 0) - (d ? a[k] : 0) + shear[j * X + i + 1] - shear[j * X + i]);
  }
}

// The rate of strain (stretch, shear) and the spin of each wet cell, from the same differences the stress uses: stretch
// across the cell, shear and spin at its corners (walls, and anything beyond a closed edge, still), averaged.
function strainRates(state, u, v) {
  const { g, fluid, strain } = state, { W, H } = g, { ra, rb, spin } = strain, X = W + 1;
  const uAt = (i, j) => (j >= 0 && j < H ? u[j * X + i] : 0), vAt = (i, j) => (i >= 0 && i < W ? v[j * W + i] : 0);
  const dudy = (i, j) => uAt(i, j) - uAt(i, j - 1), dvdx = (i, j) => vAt(i, j) - vAt(i - 1, j);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (!fluid[c]) continue;
    const uy = 0.25 * (dudy(i, j) + dudy(i + 1, j) + dudy(i, j + 1) + dudy(i + 1, j + 1)), vx = 0.25 * (dvdx(i, j) + dvdx(i + 1, j) + dvdx(i, j + 1) + dvdx(i + 1, j + 1));
    ra[c] = 0.5 * (u[j * X + i + 1] - u[j * X + i] - v[(j + 1) * W + i] + v[j * W + i]); rb[c] = 0.5 * (uy + vx); spin[c] = vx - uy;
  }
}

// Vorticity confinement: puts back the small swirls that advection smooths away, so smoke curls instead of blurring.
function confine(g, strength, dt, curl, magnitude) {
  const { W, H, u, v, solid } = g;
  const uc = (i, j) => (u[j * (W + 1) + i] + u[j * (W + 1) + i + 1]) * 0.5, vc = (i, j) => (v[j * W + i] + v[(j + 1) * W + i]) * 0.5;
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const w = (vc(i + 1, j) - vc(i - 1, j)) * 0.5 - (uc(i, j + 1) - uc(i, j - 1)) * 0.5;
    curl[j * W + i] = w; magnitude[j * W + i] = w < 0 ? -w : w;
  }
  for (let j = 2; j < H - 2; j++) for (let i = 2; i < W - 2; i++) {
    const c = j * W + i;
    if (solid[c]) continue;
    const nx = (magnitude[c + 1] - magnitude[c - 1]) * 0.5, ny = (magnitude[c + W] - magnitude[c - W]) * 0.5, length = Math.sqrt(nx * nx + ny * ny) + 1e-6;
    const fx = strength * (ny / length) * curl[c] * dt, fy = -strength * (nx / length) * curl[c] * dt;
    u[j * (W + 1) + i] += fx * 0.5; u[j * (W + 1) + i + 1] += fx * 0.5;
    v[j * W + i] += fy * 0.5; v[(j + 1) * W + i] += fy * 0.5;
  }
}

// Whether the straight path from (x0, y0) to (x1, y1) enters a solid cell after the one it starts in. It visits every
// cell the path passes through, in order (Amanatides and Woo's grid walk), so nothing that moves several pixels in a step
// can skip over a wall one pixel thick, or slip between two pixels that touch only at their corners. Cells beyond the
// grid are open.
function crossesSolid(solid, W, H, x0, y0, x1, y1) {
  let i = Math.floor(x0), j = Math.floor(y0);
  const dx = x1 - x0, dy = y1 - y0, si = dx > 0 ? 1 : dx < 0 ? -1 : 0, sj = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  // How far along the path (0 to 1) the next vertical and horizontal cell edges are, and how far apart they lie.
  let tx = si ? ((si > 0 ? i + 1 : i) - x0) / dx : 2, ty = sj ? ((sj > 0 ? j + 1 : j) - y0) / dy : 2;
  const stepX = si ? si / dx : 0, stepY = sj ? sj / dy : 0;
  for (let n = Math.abs(Math.floor(x1) - i) + Math.abs(Math.floor(y1) - j); n > 0; n--) {
    if (tx < ty) { i += si; tx += stepX; } else { j += sj; ty += stepY; }
    if (i >= 0 && j >= 0 && i < W && j < H && solid[j * W + i]) return true;
  }
  return false;
}

// ---- Emitters ---------------------------------------------------------------------------------------------------------
// Seeded value noise on a lattice three cells apart, smoothstep-blended: coherent eddies instead of per-cell static.
function valueNoise(seed, emitter, frame, salt, x, y) {
  const fx = x / 3, fy = y / 3, ix = Math.floor(fx), iy = Math.floor(fy), sx = smooth(fx - ix), sy = smooth(fy - iy);
  const at = (i, j) => random(seed, emitter, frame, salt, ix + i, iy + j);
  return (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy;
}
// Where an emitter is this frame, and how strongly it emits: rate or burst, times its pulse. Flicker varies the
// strength from cell to cell and frame to frame (seeded value noise), so a flame's base breaks into tongues.
// `along` places an orbiting emitter between frames (it defaults to the frame itself); pulse and flicker keep the frame's.
// `factor` scales the strength, as a live runner's boost does.
function emitterState(e, index, cycle, seed, along = cycle, factor = 1) {
  let [x, y] = e.at;
  if (e.orbit) { const angle = 360 * along / e.orbit.period + e.orbit.phase; x += e.orbit.radius[0] * cosDeg(angle); y += e.orbit.radius[1] * sinDeg(angle); }
  let strength = e.strength * factor;
  if (e.pulse) strength *= 1 + e.pulse.amplitude * sinDeg(360 * cycle / e.pulse.period + e.pulse.phase);
  const flicker = (px, py) => (e.flicker ? strength * (1 + e.flicker * (2 * valueNoise(seed, index, cycle, SALT.flicker, px, py) - 1)) : strength);
  return { x, y, flicker };
}
const active = (e, cycle) => e.burst ? cycle === e.start : cycle >= e.start && cycle < e.end;
// Coverage of a point by the emitter's disc or box, with a soft one-cell rim.
function coverage(e, dx, dy) {
  if (e.radius !== null) { const d = Math.sqrt(dx * dx + dy * dy), w = e.radius + 0.5 - d; return w <= 0 ? 0 : w >= 1 ? 1 : w; }
  const wx = e.area[0] / 2 + 0.5 - (dx < 0 ? -dx : dx), wy = e.area[1] / 2 + 0.5 - (dy < 0 ? -dy : dy);
  return wx <= 0 || wy <= 0 ? 0 : (wx >= 1 ? 1 : wx) * (wy >= 1 ? 1 : wy);
}
const reach = e => (e.radius !== null ? e.radius : Math.max(e.area[0], e.area[1]) / 2) + 1;
// With `falloff`, an emitter's amounts fall off from its centre toward its rim: 1 at the centre, 1 - falloff at the
// edge of the disc (or the ellipse inside the box), so a puff is densest in the middle instead of a flat plateau.
function profile(e, dx, dy) {
  if (!e.falloff) return 1;
  const share = e.radius !== null ? (dx * dx + dy * dy) / (e.radius * e.radius) : (4 * dx * dx) / (e.area[0] * e.area[0]) + (4 * dy * dy) / (e.area[1] * e.area[1]);
  return share >= 1 ? 1 - e.falloff : 1 - e.falloff * share;
}
// The flow an emitter pushes toward at a point: its velocity plus clockwise swirl, and for liquids outward expansion.
// A gas cannot be pushed outward everywhere (the pressure solve would undo it), so it expands through `spread`.
function push(e, dx, dy, axis, expand) {
  let value = e.velocity[axis];
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 0.5 && (expand || e.vortex)) value += axis === 0 ? (expand * dx - e.vortex * dy) / d : (expand * dy + e.vortex * dx) / d;
  return value;
}
// Divergence per covered cell that sends `expand` pixels per frame out through the emitter's rim.
const spread = e => e.expand * (e.radius !== null ? 2 / e.radius : 2 * (e.area[0] + e.area[1]) / (e.area[0] * e.area[1]));
function emitGas(g, state, e, index, cycle, seed, along = cycle, share = 1, factor = 1) {
  const { W, H, u, v, pixels: solid } = g, { d, T, source } = state, here = emitterState(e, index, cycle, seed, along, factor), { x, y, flicker } = here, r = reach(e);
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
  if (x0 > x1 || y0 > y1) return here;
  // A burst adds its amounts once; a rate emitter raises its cells toward them every frame (a negative amount drains),
  // so a steady source holds its level instead of piling up.
  if (e.carry) return throwCarriers(g, state, e, index, cycle, seed, here);
  const feed = (a, c, amount, w, strength) => {
    if (e.burst) a[c] += amount * w * strength;
    else if (amount >= 0) { const target = amount * strength; if (a[c] < target) a[c] += (target - a[c]) * w; }
    else a[c] *= 1 - w * Math.min(1, -amount * strength);
    if (a[c] < 0) a[c] = 0;
  };
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const c = j * W + i, w = coverage(e, i + 0.5 - x, j + 0.5 - y);
    if (!w || solid[c]) continue;
    const strength = flicker(i + 0.5, j + 0.5), amounts = strength * profile(e, i + 0.5 - x, j + 0.5 - y);
    if (e.density) feed(d, c, e.density, w, amounts);
    if (e.temperature) feed(T, c, e.temperature, w, amounts);
    if (e.expand) source[c] += spread(e) * w * strength * share;
  }
  const moving = e.steer;
  const drive = (a, k, px, py, axis) => {
    const w = coverage(e, px - x, py - y), strength = flicker(px, py);
    if (!w) return;
    if (moving) { const target = push(e, px - x, py - y, axis, 0); a[k] += e.burst ? target * w * strength : (target - a[k]) * Math.min(1, w * strength); }
    if (e.noise) a[k] += e.noise * w * strength * (2 * valueNoise(seed, index, cycle, axis ? SALT.noiseY : SALT.noiseX, px, py) - 1);
  };
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1 + 1; i++) if (!g.uFixed[j * (W + 1) + i]) drive(u, j * (W + 1) + i, i, j + 0.5, 0);
  for (let j = y0; j <= y1 + 1; j++) for (let i = x0; i <= x1; i++) if (!g.vFixed[j * W + i]) drive(v, j * W + i, i + 0.5, j, 1);
  return here;
}

// Dust and thrown smoke: an emitter with `carry` puts its smoke and heat on carriers, one per covered cell (each frame,
// for a rate emitter), launched with the emitter's push (velocity, vortex, expand outward and noise). A puff of gas can't
// be thrown through still air (the air must get out of its way, so the pressure solve halves its speed at once and the
// rest blurs away within a few pixels), but dust is grains, and grains keep their momentum. Each carrier loses about
// `drag` of the difference between its velocity and the air's each frame, falls by its `gravity`, hands `release` of
// what it still carries to the air each frame, and drops the rest where it meets an obstacle. What it carries is drawn
// with the smoke, so the cloud travels with the carriers and the air keeps what they leave behind.
function throwCarriers(g, state, e, index, cycle, seed, here) {
  const { W, H, pixels: solid } = g, { x, y, flicker } = here, r = reach(e), list = state.carriers;
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const c = j * W + i, px = i + 0.5, py = j + 0.5, w = coverage(e, px - x, py - y);
    if (!w || solid[c]) continue;
    const amount = flicker(px, py) * profile(e, px - x, py - y) * w, d = e.density * amount, t = e.temperature * amount;
    if (!(d > 0) && !(t > 0)) continue;
    if (list.length >= LIMITS.carriers) { state.overflow = true; return here; }
    let vx = push(e, px - x, py - y, 0, e.expand), vy = push(e, px - x, py - y, 1, e.expand);
    if (e.noise) { vx += e.noise * (2 * valueNoise(seed, index, cycle, SALT.noiseX, px, py) - 1); vy += e.noise * (2 * valueNoise(seed, index, cycle, SALT.noiseY, px, py) - 1); }
    list.push({ x: px, y: py, vx, vy, d: d > 0 ? d : 0, T: t > 0 ? t : 0, carry: e.carry });
  }
  return here;
}
// Adds `value` to the cell centres around (x, y) with bilinear weights over the open ones, so nothing is lost where
// some of them are obstacles' pixels (or beyond the canvas).
function deposit(a, solid, W, H, x, y, value) {
  const fx = x - 0.5, fy = y - 0.5, i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j;
  const open = (ci, cj) => ci >= 0 && cj >= 0 && ci < W && cj < H && !solid[cj * W + ci];
  const w00 = open(i, j) ? (1 - s) * (1 - t) : 0, w10 = open(i + 1, j) ? s * (1 - t) : 0, w01 = open(i, j + 1) ? (1 - s) * t : 0, w11 = open(i + 1, j + 1) ? s * t : 0, sum = w00 + w10 + w01 + w11;
  if (!(sum > 0)) return;
  if (w00) a[j * W + i] += w00 / sum * value;
  if (w10) a[j * W + i + 1] += w10 / sum * value;
  if (w01) a[(j + 1) * W + i] += w01 / sum * value;
  if (w11) a[(j + 1) * W + i + 1] += w11 / sum * value;
}
// Moves carrier `p` along its path toward (x1, y1) as far as the open cells go: to just short of the first cell that
// is an obstacle or beyond the canvas (a closed edge), inside the last open cell, walking cell by cell as crossesSolid
// does. So a fast carrier drops its smoke against the wall it hits, not a whole step short of it.
function stopShort(solid, W, H, p, x1, y1) {
  const x0 = p.x, y0 = p.y, dx = x1 - x0, dy = y1 - y0, si = dx > 0 ? 1 : dx < 0 ? -1 : 0, sj = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  let i = Math.floor(x0), j = Math.floor(y0), li = i, lj = j, t = 1;
  let tx = si ? ((si > 0 ? i + 1 : i) - x0) / dx : 2, ty = sj ? ((sj > 0 ? j + 1 : j) - y0) / dy : 2;
  const stepX = si ? si / dx : 0, stepY = sj ? sj / dy : 0;
  for (let n = Math.abs(Math.floor(x1) - i) + Math.abs(Math.floor(y1) - j); n > 0; n--) {
    let enter;
    if (tx < ty) { enter = tx; i += si; tx += stepX; } else { enter = ty; j += sj; ty += stepY; }
    if (i < 0 || j < 0 || i >= W || j >= H || solid[j * W + i]) { t = enter; break; }
    li = i; lj = j;
  }
  const x = x0 + dx * t, y = y0 + dy * t;
  p.x = x < li + 0.01 ? li + 0.01 : x > li + 0.99 ? li + 0.99 : x;
  p.y = y < lj + 0.01 ? lj + 0.01 : y > lj + 0.99 ? lj + 0.99 : y;
}
function moveCarriers(state, dt) {
  const { g, d, T, carriers: list } = state, { W, H, u, v, pixels: solid } = g;
  let kept = 0;
  for (let k = 0; k < list.length; k++) {
    const p = list[k], { drag, release, gravity } = p.carry;
    p.vx += (sampleU(g, u, p.x, p.y) - p.vx) * drag * dt + gravity[0] * dt;
    p.vy += (sampleV(g, v, p.x, p.y) - p.vy) * drag * dt + gravity[1] * dt;
    if (p.vx > MAX_SPEED) p.vx = MAX_SPEED; else if (p.vx < -MAX_SPEED) p.vx = -MAX_SPEED;
    if (p.vy > MAX_SPEED) p.vy = MAX_SPEED; else if (p.vy < -MAX_SPEED) p.vy = -MAX_SPEED;
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, { walls } = g;
    // Carriers that leave through an open edge take their smoke with them; one that meets an obstacle or a closed edge
    // drops it all there.
    const closed = (nx < 0 && walls.left) || (nx >= W && walls.right) || (ny < 0 && walls.top) || (ny >= H && walls.bottom);
    if (!closed && (nx < 0 || ny < 0 || nx >= W || ny >= H)) continue;
    const hit = closed || crossesSolid(solid, W, H, p.x, p.y, nx, ny) || solid[Math.floor(ny) * W + Math.floor(nx)];
    if (!hit) { p.x = nx; p.y = ny; } else stopShort(solid, W, H, p, nx, ny);
    const part = hit ? 1 : release * dt, dd = p.d * part, tt = p.T * part;
    if (dd) deposit(d, solid, W, H, p.x, p.y, dd);
    if (tt) deposit(T, solid, W, H, p.x, p.y, tt);
    p.d -= dd; p.T -= tt;
    if (hit || (p.d < 0.002 && p.T < 0.002)) continue;
    list[kept++] = p;
  }
  list.length = kept;
}

// ---- Gas --------------------------------------------------------------------------------------------------------------
function createGas(effect, width, height) {
  const g = gridFor(effect, width, height), N = g.N;
  const state = { g, solids: solidLayer(effect, effect.layout, placementsAt(effect.obstacles, 0), width, height), d: new Float64Array(N), T: new Float64Array(N), source: new Float64Array(N), d1: new Float64Array(N), T1: new Float64Array(N), curl: new Float64Array(N), magnitude: new Float64Array(N), open: new Uint8Array(N) };
  if (effect.emitters.some(e => e.carry)) { state.carriers = []; state.carriedD = new Float64Array(N); state.carriedT = new Float64Array(N); }
  for (let c = 0; c < N; c++) state.open[c] = g.solid[c] ? 0 : 1;
  if (effect.electric) state.electric = createElectric(effect, width, height);
  return state;
}
// One step of a gas: a gas effect over its open cells, or, with `over` (see stepVapour), the vapour over a liquid's air
// cells, which brings its own forces, sources and carrying of the vapour; the rest is the same.
function stepGas(state, effect, dt, over = null) {
  const { g, d, T, d1, T1 } = state, { W, H, u, v } = g;
  if (state.electric) stepElectric(state.electric, state, effect, dt);
  if (over) over.forces();
  else {
    // Buoyancy lifts hot cells (y is down) and density weighs smoke down; wind pushes everything.
    if (effect.buoyancy || effect.weight || effect.wind[1]) for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i, a = (j - 1) * W + i, b = j * W + i;
      v[k] += dt * (-effect.buoyancy * (T[a] + T[b]) * 0.5 + effect.weight * (d[a] + d[b]) * 0.5 + effect.wind[1]);
    }
    if (effect.wind[0]) for (let k = 0; k < u.length; k++) u[k] += dt * effect.wind[0];
  }
  if (effect.vorticity) confine(g, effect.vorticity, dt, state.curl, state.magnitude);
  enforce(g);
  advectVelocity(g, dt);
  if (effect.sharp) sharpenVelocity(g, dt);
  if (effect.drag) { const keep = 1 - effect.drag * dt; for (let k = 0; k < u.length; k++) u[k] *= keep; for (let k = 0; k < v.length; k++) v[k] *= keep; }
  enforce(g);
  if (effect.viscosity) viscous(g, state.open, effect, dt);
  project(g, state.open, effect.iterations, over ? over.sources() : state.source);
  for (const a of [u, v]) for (let k = 0; k < a.length; k++) { if (a[k] > MAX_SPEED) a[k] = MAX_SPEED; else if (a[k] < -MAX_SPEED) a[k] = -MAX_SPEED; }
  if (over) { over.carry(); return; }
  advectScalars(g, dt, [[d, d1], [T, T1]], effect.sharp);
  const fade = 1 - effect.dissipation * dt, cool = 1 - effect.cooling * dt;
  for (let c = 0; c < g.N; c++) { d[c] = d1[c] * fade; T[c] = T1[c] * cool; }
  // Hot and cold obstacles warm or chill the air touching them.
  if (effect.warm) warmAir(T, state.open, surfaceTemperatures(state.solids, state.hot ??= new Float64Array(g.N)), W, H, SURFACE_HEAT * dt);
  if (state.carriers) moveCarriers(state, dt);
}
function gasFields(state, out) {
  const { g, d, T } = state, { W, H, u, v } = g, [density, temperature, speed] = out;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i, x = (u[j * (W + 1) + i] + u[j * (W + 1) + i + 1]) * 0.5, y = (v[j * W + i] + v[(j + 1) * W + i]) * 0.5;
    density[c] = d[c]; temperature[c] = T[c]; speed[c] = Math.sqrt(x * x + y * y);
  }
  // What carriers still hold shows with the smoke.
  if (state.carriers) {
    const { carriedD, carriedT, carriers: list } = state, solid = g.pixels;
    carriedD.fill(0); carriedT.fill(0);
    for (const p of list) { if (p.d) deposit(carriedD, solid, W, H, p.x, p.y, p.d); if (p.T) deposit(carriedT, solid, W, H, p.x, p.y, p.T); }
    for (let c = 0; c < g.N; c++) { density[c] += carriedD[c]; temperature[c] += carriedT[c]; }
  }
  if (state.electric) electricFields(state.electric, state, out[4], out[5]);
}

// ---- Liquid -----------------------------------------------------------------------------------------------------------
function createLiquid(effect, width, height) {
  // With heat, ice joins the obstacles in the solver's solid cells, so the grid keeps a mask of its own (beside smooth
  // obstacles, the mask its geometry is traced from: see heatMasks).
  const g = effect.heat && !effect.smooth ? createGrid(width, height, Uint8Array.from(effect.solid), effect.walls) : gridFor(effect, width, height), N = g.N, U = g.u.length, V = g.v.length, solids = solidLayer(effect, effect.layout, placementsAt(effect.obstacles, 0), width, height);
  g.release = true;
  const state = {
    g, solids, n: 0, next: 0, keys: effect.heat ? PHASE_KEYS : PARTICLE_KEYS, ...(effect.heat && { energy: new Float64Array(1024), frozen: new Float64Array(1024), fall: new Float64Array(1024) }),
    x: new Float64Array(1024), y: new Float64Array(1024), vx: new Float64Array(1024), vy: new Float64Array(1024), id: new Float64Array(1024),
    pvx: new Float64Array(1024), pvy: new Float64Array(1024),
    uw: new Float64Array(U), vw: new Float64Array(V), uOld: new Float64Array(U), vOld: new Float64Array(V), uValid: new Uint8Array(U), vValid: new Uint8Array(V),
    fluid: new Uint8Array(N), cells: new Uint16Array(N), target: new Float64Array(N), splat: new Float64Array(N), blur: new Float64Array(N), speedSum: new Float64Array(N),
    pullU: effect.tension ? new Float64Array(U) : null, pullV: effect.tension ? new Float64Array(V) : null,
    cux: new Float64Array(1024), cuy: new Float64Array(1024), cvx: new Float64Array(1024), cvy: new Float64Array(1024), ea: new Float64Array(1024), eb: new Float64Array(1024), apic: effect.apic,
    cling: effect.most.adhesion ? clingField(solids) : null, grip: effect.most.adhesion ? gripFields(solids, effect.obstacles) : null, carry: null,
    strands: effect.look.some(layer => layer.field === STRAND),
    pressure: effect.most.viscosity || effect.most.yield ? new Float64Array(N) : null,
    air: effect.air ? { label: new Int32Array(N).fill(-1), before: new Int32Array(N).fill(-1), stack: new Int32Array(N), pressure: new Float64Array(N), regions: [], release: [], made: [] } : null,
    strain: effect.most.yield ? { a: new Float64Array(N), b: new Float64Array(N), count: new Float64Array(N), stiff: new Float64Array(N), shear: new Float64Array((width + 1) * (height + 1)), ra: new Float64Array(N), rb: new Float64Array(N), spin: new Float64Array(N), flowU: new Float64Array(U), flowV: new Float64Array(V), flowPressure: new Float64Array(N), spread: new Float64Array(N), none: new Float64Array(N) } : null
  };
  if (effect.heat) state.heat = createHeat(effect, g);
  // An arc over the liquid runs through its air, the vapour's gas (see electricStep).
  if (effect.electric) state.electric = createElectric(effect, width, height);
  return state;
}
// Adhesion makes the liquid hold on to walls and obstacles (and anything beyond a closed edge). A pull toward them would
// do nothing, since the pressure solve takes away any pull that is the slope of a field, so instead a particle within a
// cell of a solid holds on to it, as static friction holds: it does not move away from the solid unless it is pulled
// away faster than 2 × adhesion × closeness pixels per frame, and then only by the excess. Closeness is the solids
// blurred over a cell, ¼ in the middle of a cell beside a solid. Particles still slide along a solid freely, so a film
// stays under a ledge, on a spoon or down a jar's side while the rest of the liquid falls or drains away. Away is
// measured from a moving solid as it moves, so what clings to a spoon is lifted with it (see carryFields). Every solid
// of the solid layer counts, closed edges included. `value(owner)` weighs each solid by its owner; the default counts
// every one as 1.
function clingField(solids, value = null) {
  const { W, H, solid, ownerAt } = solids, field = new Float64Array(W * H);
  const solidAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? ownerAt(x, y) === EDGE : solid[y * W + x]) ? (value ? value(ownerAt(x, y)) : 1) : 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += solidAt(i + di, j + dj) * (di ? 1 : 2) * (dj ? 1 : 2);
    field[j * W + i] = sum / 16;
  }
  return field;
}
// Solids with their own adhesion: closeness to the solids that take the effect's adhesion (`plain`: the rest, ice and
// closed edges) and to those with their own, weighed by it (`own`). Each step the hold is the effect's adhesion times
// `plain` plus `own`. Null when no solid has its own.
function gripFields(solids, obstacles) {
  if (!obstacles.some(o => o.props.adhesion !== null)) return null;
  const own = o => solids.props(o)?.adhesion ?? null;
  return { plain: clingField(solids, o => (own(o) === null ? 1 : 0)), own: clingField(solids, o => own(o) ?? 0), grip: new Float64Array(solids.N) };
}
// The moving solids near each cell, two pixels round, for what clings to them: how near (`near`), and summed with the
// same weights their velocity (`u`, `v`) and how far their whole-pixel place is ahead of where they really are (`du`,
// `dv`), so a particle reads the velocity as u / near. An obstacle moves in whole pixels, jumping a pixel at a time, but
// clinging is measured from where it really is along its move, so a film on it moves smoothly instead of being left a
// pixel behind at each jump. Null while nothing moves.
function carryFields(solids) {
  if (!solids.moving) return null;
  const { W, H, N } = solids, f = () => new Float64Array(N), near = f(), u = f(), v = f(), du = f(), dv = f();
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0, su = 0, sv = 0, sdu = 0, sdv = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const at = y * W + x, s = solids.velocity(at);
      if (!s) continue;
      const w = (3 - (di < 0 ? -di : di)) * (3 - (dj < 0 ? -dj : dj)), [ax, ay] = solids.ahead(at);
      sum += w; su += w * s[0]; sv += w * s[1]; sdu += w * ax; sdv += w * ay;
    }
    const c = j * W + i;
    near[c] = sum; u[c] = su; v[c] = sv; du[c] = sdu; dv[c] = sdv;
  }
  return { near, u, v, du, dv };
}
// A particle's position, velocity, id, its velocity before this frame's steps (for whitewater impacts), for APIC the
// slopes of the flow around it (du/dx, du/dy, dv/dx, dv/dy), and for yield stress its strain (stretch, shear).
// With heat, each particle also has its energy and whether it is ice (see the phase section).
const PARTICLE_KEYS = ['x', 'y', 'vx', 'vy', 'id', 'pvx', 'pvy', 'cux', 'cuy', 'cvx', 'cvy', 'ea', 'eb'], PHASE_KEYS = [...PARTICLE_KEYS, 'energy', 'frozen', 'fall'];
function addParticle(state, x, y, vx, vy) {
  if (state.n === state.x.length) {
    if (state.n >= LIMITS.particles) { state.full = true; return false; }
    for (const key of state.keys) { const grown = new Float64Array(Math.min(LIMITS.particles, state.n * 2)); grown.set(state[key]); state[key] = grown; }
  }
  const k = state.n++;
  state.x[k] = x; state.y[k] = y; state.vx[k] = vx; state.vy[k] = vy; state.id[k] = state.next++; state.pvx[k] = vx; state.pvy[k] = vy;
  state.cux[k] = 0; state.cuy[k] = 0; state.cvx[k] = 0; state.cvy[k] = 0; state.ea[k] = 0; state.eb[k] = 0;
  if (state.heat) { const P = state.heat; state.energy[k] = P.spawnEnergy; state.frozen[k] = P.spawnFrozen; state.fall[k] = 0; if (!P.converting) P.added++; }
  return true;
}
function removeParticle(state, k) {
  if (state.heat && !state.heat.converting) state.heat.removed++;
  const last = --state.n;
  for (const key of state.keys) state[key][k] = state[key][last];
}
function countCells(state) {
  const { g, cells } = state, { W, H } = g;
  cells.fill(0);
  for (let k = 0; k < state.n; k++) {
    const i = Math.floor(state.x[k]), j = Math.floor(state.y[k]);
    if (i >= 0 && j >= 0 && i < W && j < H && cells[j * W + i] < 65535) cells[j * W + i]++;
  }
}
// Places up to `want` particles in a cell on a jittered 2 × 2 pattern, keyed so the same source fills the same way. Spots
// inside a smooth obstacle's outline stay empty.
function seedCell(state, i, j, want, have, velocity, key) {
  const { geo } = state.g;
  for (let k = have; k < want; k++) {
    const sx = (k % 2) * 0.5, sy = (Math.floor(k / 2) % 2) * 0.5, x = i + sx + 0.05 + 0.4 * random(...key, k, SALT.jitterX), y = j + sy + 0.05 + 0.4 * random(...key, k, SALT.jitterY);
    if (geo && outlineAt(geo, x, y) < CLEARANCE) continue;
    if (!addParticle(state, x, y, velocity[0], velocity[1])) return false;
  }
  return true;
}
function fillLiquid(state, effect) {
  const { g } = state, { W, H, pixels: solid } = g;
  effect.fills.forEach((fill, f) => {
    if (state.heat) {
      const h = effect.heat, P = state.heat, t = fill.phase.temperature ?? h.ambient;
      // A vapour fill holds still vapour of that density in its open cells, at its temperature.
      if (fill.phase.vapour) {
        const V = P.vapour, mass = fill.phase.vapour * PER_CELL / effect.vapour.expansion;
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (!solid[j * W + i] && fill.inside(i + 0.5, j + 0.5)) { V.d[j * W + i] += mass; V.T[j * W + i] = t; }
        return;
      }
      P.spawnFrozen = fill.phase.frozen ? 1 : 0; P.spawnEnergy = energyOf(h, t, fill.phase.frozen);
    }
    if (fill.burst) { burstFill(state, effect, fill, f); return; }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (!solid[j * W + i] && fill.inside(i + 0.5, j + 0.5)) seedCell(state, i, j, PER_CELL, 0, fill.velocity, [effect.seed, 1000 + f, i, j]);
  });
}
// A fill that bursts: an outward velocity inside one connected blob is something an incompressible liquid can't have,
// so the pressure solve would cancel it. Instead the fill breaks into `pieces` seeded pieces (each cell joins the
// nearest of that many seeded cells) with a one-pixel gap of air between neighbours, and each piece flies straight out
// from the fill's middle at its own speed, plus the fill's velocity. A piece moving as one is divergence-free, so the
// pressure solve keeps it.
function burstFill(state, effect, fill, f) {
  const { W, H, pixels: solid } = state.g, cells = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (!solid[j * W + i] && fill.inside(i + 0.5, j + 0.5)) cells.push(j * W + i);
  if (!cells.length) return;
  const { pieces, speed } = fill.burst, seeds = [];
  for (let k = 0; seeds.length < Math.min(pieces, cells.length) && k < 8 * pieces; k++) {
    const c = cells[Math.min(cells.length - 1, Math.floor(random(effect.seed, 1000 + f, k, SALT.spawn) * cells.length))];
    if (!seeds.includes(c)) seeds.push(c);
  }
  const piece = new Int16Array(W * H).fill(-1);
  for (const c of cells) {
    const x = c % W, y = (c - x) / W;
    let best = 0, near = Infinity;
    seeds.forEach((s, n) => { const dx = s % W - x, dy = (s - (s % W)) / W - y, d = dx * dx + dy * dy; if (d < near) { near = d; best = n; } });
    piece[c] = best;
  }
  // A cell beside a piece numbered lower becomes the gap between them.
  let kept = cells.filter(c => { const x = c % W, y = (c - x) / W, n = piece[c]; return !((x > 0 && piece[c - 1] >= 0 && piece[c - 1] < n) || (x < W - 1 && piece[c + 1] >= 0 && piece[c + 1] < n) || (y > 0 && piece[c - W] >= 0 && piece[c - W] < n) || (y < H - 1 && piece[c + W] >= 0 && piece[c + W] < n)); });
  // Liquid breaks into blobs, not shards: twice over, a cell with four or fewer of its eight neighbours in its own piece
  // is trimmed off (its water goes back to the piece, as a gap's does), so the straight-cut pieces fly as rounded blobs,
  // where an elastic liquid would keep their corners all the way down. A piece of six cells or fewer stays whole.
  for (let pass = 0; pass < 2; pass++) {
    const left = new Int16Array(W * H).fill(-1), size = seeds.map(() => 0);
    for (const c of kept) { left[c] = piece[c]; size[piece[c]]++; }
    kept = kept.filter(c => {
      if (size[piece[c]] <= 6) return true;
      const x = c % W, y = (c - x) / W;
      let same = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && left[c + dy * W + dx] === piece[c]) same++;
      return same > 4;
    });
  }
  // The middle of the whole shape on the canvas, obstacles' pixels included.
  let cx = 0, cy = 0, area = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (fill.inside(i + 0.5, j + 0.5)) { cx += i + 0.5; cy += j + 0.5; area++; }
  cx /= area; cy /= area;
  const sums = seeds.map(() => [0, 0, 0]);
  for (const c of kept) { const s = sums[piece[c]]; s[0] += c % W + 0.5; s[1] += Math.floor(c / W) + 0.5; s[2]++; }
  const velocities = sums.map(([sx, sy, n], k) => {
    if (!n) return fill.velocity;
    const dx = sx / n - cx, dy = sy / n - cy, d = Math.sqrt(dx * dx + dy * dy), v = pick(speed, random(effect.seed, 1000 + f, k, SALT.speed));
    return d < 0.5 ? fill.velocity : [fill.velocity[0] + v * dx / d, fill.velocity[1] + v * dy / d];
  });
  for (const c of kept) { const i = c % W, j = (c - i) / W; seedCell(state, i, j, PER_CELL, 0, velocities[piece[c]], [effect.seed, 1000 + f, i, j]); }
  // The gaps' water goes to their own pieces, a cell's worth to each of its cells in turn, so a burst keeps its volume;
  // the crowded pieces swell a little as they fly. A piece that is all gap (a small fill in many pieces) hands its
  // water to the piece of the nearest kept cell.
  const own = seeds.map(() => []), extra = seeds.map(() => 0), keep = new Set(kept);
  for (const c of kept) own[piece[c]].push(c);
  for (const c of cells) {
    if (keep.has(c)) continue;
    let to = piece[c];
    if (!own[to].length) {
      const x = c % W, y = (c - x) / W;
      let near = Infinity;
      for (const k of kept) { const dx = k % W - x, dy = (k - (k % W)) / W - y, d = dx * dx + dy * dy; if (d < near) { near = d; to = piece[k]; } }
    }
    extra[to]++;
  }
  own.forEach((list, n) => {
    for (let k = 0; k < extra[n] && list.length; k++) {
      const c = list[k % list.length], i = c % W, j = (c - i) / W, have = PER_CELL * (1 + Math.floor(k / list.length));
      seedCell(state, i, j, have + PER_CELL, have, velocities[n], [effect.seed, 1000 + f, i, j]);
    }
  });
}
function emitLiquid(state, e, index, cycle, seed, along = cycle, factor = 1) {
  const { g } = state, { W, H, pixels: solid } = g, here = emitterState(e, index, cycle, seed, along, factor), { x, y, flicker } = here, r = reach(e);
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
  const velocityAt = (px, py) => [push(e, px - x, py - y, 0, e.expand), push(e, px - x, py - y, 1, e.expand)];
  if (state.heat) { state.heat.spawnFrozen = 0; state.heat.spawnEnergy = energyOf(state.heat.heat, e.warmth ?? state.heat.heat.ambient, false); }
  // Particles already inside follow the emitter's push (a jet), or drain away through it.
  for (let k = state.n - 1; k >= 0; k--) {
    const px = state.x[k], py = state.y[k], w = coverage(e, px - x, py - y);
    if (!w) continue;
    const strength = flicker(px, py);
    if (e.density < 0 && random(seed, index, cycle, SALT.drain, state.id[k]) < -e.density * Math.min(1, w * strength * profile(e, px - x, py - y))) { removeParticle(state, k); continue; }
    const [tx, ty] = velocityAt(px, py), f = Math.min(1, w * strength);
    if (e.steer || e.expand) {
      if (e.burst) { state.vx[k] += tx * w * strength; state.vy[k] += ty * w * strength; } else { state.vx[k] += (tx - state.vx[k]) * f; state.vy[k] += (ty - state.vy[k]) * f; }
    }
    if (e.noise) { state.vx[k] += e.noise * w * strength * (2 * valueNoise(seed, index, cycle, SALT.noiseX, px, py) - 1); state.vy[k] += e.noise * w * strength * (2 * valueNoise(seed, index, cycle, SALT.noiseY, px, py) - 1); }
  }
  if (e.density > 0 && x0 <= x1 && y0 <= y1) {
    countCells(state);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const c = j * W + i, w = coverage(e, i + 0.5 - x, j + 0.5 - y);
      if (!w || solid[c]) continue;
      const want = Math.floor(PER_CELL * e.density * Math.min(1, w * flicker(i + 0.5, j + 0.5) * profile(e, i + 0.5 - x, j + 0.5 - y)) + 0.5);
      if (want > state.cells[c] && !seedCell(state, i, j, want, state.cells[c], velocityAt(i + 0.5, j + 0.5), [seed, index, cycle, SALT.spawn, i, j])) return here;
    }
  }
  return here;
}
// Spreads valid face velocities into the faces around them, so particles near the surface read a sensible flow.
function extrapolate(a, valid, nx, ny, layers) {
  for (let layer = 0; layer < layers; layer++) {
    const known = Uint8Array.from(valid);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (known[k]) continue;
      let sum = 0, n = 0;
      if (i > 0 && known[k - 1]) { sum += a[k - 1]; n++; }
      if (i < nx - 1 && known[k + 1]) { sum += a[k + 1]; n++; }
      if (j > 0 && known[k - nx]) { sum += a[k - nx]; n++; }
      if (j < ny - 1 && known[k + nx]) { sum += a[k + nx]; n++; }
      if (n) { a[k] = sum / n; valid[k] = 1; }
    }
  }
}
// Adds `value` to the four lattice points around (fx, fy) with bilinear weights, and the weights to `weights` if given.
function splat(a, weights, nx, ny, fx, fy, value) {
  const i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j;
  const add = (x, y, w) => { if (x >= 0 && y >= 0 && x < nx && y < ny && w) { a[y * nx + x] += w * value; if (weights) weights[y * nx + x] += w; } };
  add(i, j, (1 - s) * (1 - t)); add(i + 1, j, s * (1 - t)); add(i, j + 1, (1 - s) * t); add(i + 1, j + 1, s * t);
}
// As splat, onto the cell centres of a W × H canvas, from a particle at (px, py), with its whole weight shared among the
// centres it could be in: none goes into an obstacle pixel, off the canvas or across a corner where two obstacle pixels
// touch (nor, beside a smooth obstacle, to a centre with the outline between it and the particle). So a wall soaks up
// none of the water beside it: a full cell walled in on three sides, or a crack one pixel wide, holds as much as open
// water does, and nothing shows on the far side of a thin wall.
function splatOpen(a, weights, W, H, px, py, value, solid, geo) {
  const fx = px - 0.5, fy = py - 0.5, i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j;
  // The particle's own cell, and beside smooth obstacles the corners it is cut off at.
  const ci = Math.floor(px), cj = Math.floor(py), cut = geo && ci >= 0 && cj >= 0 && ci < W && cj < H ? geo.across[cj * W + ci] : 0;
  let dropped = false;
  const reach = (x, y, w) => {
    if (!w) return 0;
    const shut = x < 0 || y < 0 || x >= W || y >= H || solid[y * W + x]
      // The centre diagonal to the particle's own cell, past the corner they share.
      || (x !== ci && y !== cj && (geo ? cut & (y < cj ? (x < ci ? TL : TR) : x < ci ? BL : BR) : solid[cj * W + x] && solid[y * W + ci]))
      || (geo && outlineAt(geo, (px + x + 0.5) / 2, (py + y + 0.5) / 2) < 0);
    if (shut) dropped = true;
    return shut ? 0 : w;
  };
  const w00 = reach(i, j, (1 - s) * (1 - t)), w10 = reach(i + 1, j, s * (1 - t)), w01 = reach(i, j + 1, (1 - s) * t), w11 = reach(i + 1, j + 1, s * t);
  // In open water the weights already sum to one, and stay exactly as they are.
  const scale = dropped ? 1 / (w00 + w10 + w01 + w11) : 1;
  if (!(scale < Infinity)) return;
  const add = (x, y, w) => { if (w) { a[y * W + x] += w * scale * value; weights[y * W + x] += w * scale; } };
  add(i, j, w00); add(i + 1, j, w10); add(i, j + 1, w01); add(i + 1, j + 1, w11);
}
// As splat, with the particle's local flow (APIC): each lattice point gets value + gx (x − fx) + gy (y − fy), so a turning
// or shearing patch of liquid hands the grid its turning and shearing, not only its mean velocity.
function splatAffine(a, weights, nx, ny, fx, fy, value, gx, gy) {
  const i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j;
  const add = (x, y, w) => { if (x >= 0 && y >= 0 && x < nx && y < ny && w) { a[y * nx + x] += w * (value + gx * (x - fx) + gy * (y - fy)); weights[y * nx + x] += w; } };
  add(i, j, (1 - s) * (1 - t)); add(i + 1, j, s * (1 - t)); add(i, j + 1, (1 - s) * t); add(i + 1, j + 1, s * t);
}
function transfer(state) {
  const { g, uw, vw, uValid, vValid, fluid } = state, { W, H, u, v, solid } = g;
  u.fill(0); v.fill(0); uw.fill(0); vw.fill(0); fluid.fill(0);
  // Ice holds still and takes no part in the flow (where enough of it gathers, its cells are solid).
  const frozen = state.heat ? state.frozen : null;
  for (let k = 0; k < state.n; k++) {
    if (frozen && frozen[k]) continue;
    const x = state.x[k], y = state.y[k];
    if (state.apic) {
      splatAffine(u, uw, W + 1, H, x, y - 0.5, state.vx[k], state.cux[k], state.cuy[k]);
      splatAffine(v, vw, W, H + 1, x - 0.5, y, state.vy[k], state.cvx[k], state.cvy[k]);
    } else {
      splat(u, uw, W + 1, H, x, y - 0.5, state.vx[k]);
      splat(v, vw, W, H + 1, x - 0.5, y, state.vy[k]);
    }
    const i = Math.floor(x), j = Math.floor(y);
    if (i >= 0 && j >= 0 && i < W && j < H && !solid[j * W + i]) fluid[j * W + i] = 1;
  }
  // A pixel step that a smooth outline cuts through holds liquid in its open corner whenever liquid lies beside that
  // corner, so the step bears the liquid's pressure instead of draining it like open air.
  if (g.geo) {
    const { open, uOpen, vOpen } = g.geo, X = W + 1;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i;
      if (fluid[c] || !(open[c] > 0 && open[c] < 0.5)) continue;
      if ((i > 0 && uOpen[j * X + i] && fluid[c - 1]) || (i < W - 1 && uOpen[j * X + i + 1] && fluid[c + 1]) || (j > 0 && vOpen[c] && fluid[c - W]) || (j < H - 1 && vOpen[c + W] && fluid[c + W])) fluid[c] = 1;
    }
  }
  // The wake of a moving obstacle: the cells it has left in the last WAKE frames, while liquid or solid closes them in,
  // are liquid even with no particles in them, so the liquid flows in behind the obstacle as it moves (or is drawn up
  // after it) instead of leaving a hole that a thick liquid would take many frames to close. Air reaching them, through
  // each other, ends that for good: the obstacle has left the liquid there.
  const { wake } = state;
  if (wake && wake.cells.length) {
    const { left: wl, right: wr, top: wt, bottom: wb } = g.walls, mark = wake.mark, aired = [];
    for (const c of wake.cells) if (!fluid[c] && !solid[c]) mark[c] = 1;
    const open = (c, inside, wall) => (inside ? !fluid[c] && !solid[c] && !mark[c] : !wall);
    for (const c of wake.cells) {
      const i = c % W, j = (c - i) / W;
      if (mark[c] === 1 && (open(c - 1, i > 0, wl) || open(c + 1, i < W - 1, wr) || open(c - W, j > 0, wt) || open(c + W, j < H - 1, wb))) { mark[c] = 2; aired.push(c); }
    }
    while (aired.length) {
      const c = aired.pop(), i = c % W, j = (c - i) / W;
      for (const d of [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, j > 0 ? c - W : -1, j < H - 1 ? c + W : -1]) if (d >= 0 && mark[d] === 1) { mark[d] = 2; aired.push(d); }
    }
    for (const c of wake.cells) { if (mark[c] === 1) fluid[c] = 1; else if (mark[c] === 2) wake.left[c] = 0; mark[c] = 0; }
    wake.cells = wake.cells.filter(c => wake.left[c]);
  }
  for (let k = 0; k < u.length; k++) { if (uw[k] > 0) u[k] /= uw[k]; uValid[k] = uw[k] > 0 || g.uFixed[k] ? 1 : 0; }
  for (let k = 0; k < v.length; k++) { if (vw[k] > 0) v[k] /= vw[k]; vValid[k] = vw[k] > 0 || g.vFixed[k] ? 1 : 0; }
  enforce(g);
  extrapolate(u, uValid, W + 1, H, 2); extrapolate(v, vValid, W, H + 1, 2);
}
// Cohesion: the liquid is drawn up its smoothed density, which only matters at the surface (inside, the density is
// level). Drops hold together and thin sheets gather into strands instead of drifting apart as mist. It is a force on
// the grid's faces before the pressure solve, as gravity is, so the pressure holds a resting surface against it. (Added
// to each particle's velocity after the solve, it stayed there, built up step after step and went round every transfer,
// so a resting liquid kept a speed it never moved by and a thin one, with APIC, trembled for ever.) Half of it is the
// difference in density across each face, which the pressure balances exactly at rest; half is sampled at the
// particles and spread onto the faces as their velocities are, which keeps a small falling drop round where a pixel-wide
// difference cannot tell its end from its sides.
function cohere(state, strength, room) {
  const { g, fluid, blur: rho, cells, uw, vw } = state, { W, H, u, v, solid, uFixed, vFixed } = g, X = W + 1;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0, weights = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      // Obstacles take no part, so liquid neither clings to walls nor shies away from them; beside a smooth one a cell
      // counts by its open share, and a cut step's open corner not at all.
      if (x < 0 || y < 0 || x >= W || y >= H || (room ? room[y * W + x] < 0.5 : solid[y * W + x])) continue;
      const w = (di ? 1 : 2) * (dj ? 1 : 2);
      sum += cells[y * W + x] * w; weights += room ? w * room[y * W + x] : w;
    }
    rho[j * W + i] = weights ? sum / weights / PER_CELL : 0;
  }
  // Each face between two cells, one of them liquid, is pushed toward the denser one.
  const half = 0.5 * strength;
  for (let j = 0; j < H; j++) for (let i = 1; i < W; i++) {
    const k = j * X + i, c = j * W + i;
    if (!uFixed[k] && (fluid[c - 1] || fluid[c])) u[k] += half * (rho[c] - rho[c - 1]);
  }
  for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (!vFixed[c] && (fluid[c - W] || fluid[c])) v[c] += half * (rho[c] - rho[c - W]);
  }
  // Each particle's pull, the density's difference across the two cells around it, is spread with the weights the
  // transfer gave its velocity (the particles have not moved since).
  const { pullU, pullV } = state, frozen = state.heat ? state.frozen : null;
  pullU.fill(0); pullV.fill(0);
  for (let k = 0; k < state.n; k++) {
    if (frozen && frozen[k]) continue;
    const x = state.x[k], y = state.y[k], fx = x - 0.5, fy = y - 0.5;
    splat(pullU, null, W + 1, H, x, y - 0.5, 0.5 * half * (bilinear(rho, W, H, fx + 1, fy) - bilinear(rho, W, H, fx - 1, fy)));
    splat(pullV, null, W, H + 1, x - 0.5, y, 0.5 * half * (bilinear(rho, W, H, fx, fy + 1) - bilinear(rho, W, H, fx, fy - 1)));
  }
  for (let k = 0; k < u.length; k++) if (uw[k] > 0 && !uFixed[k]) u[k] += pullU[k] / uw[k];
  for (let k = 0; k < v.length; k++) if (vw[k] > 0 && !vFixed[k]) v[k] += pullV[k] / vw[k];
}
function stepLiquid(state, effect, dt) {
  const { g, fluid, target, uOld, vOld } = state, { W, H, u, v, solid, walls } = g;
  transfer(state);
  uOld.set(u); vOld.set(v);
  for (let k = 0; k < u.length; k++) u[k] += dt * effect.gravity[0];
  for (let k = 0; k < v.length; k++) v[k] += dt * effect.gravity[1];
  // Bubbles with lift hand that share of their buoyancy to the water around them, as if that much of it weighed nothing:
  // a column of bubbles drives an upwelling.
  const lifts = state.lifts;
  if (lifts) for (let b = 0; b < lifts.length; b += 3) {
    const x = lifts[b], y = lifts[b + 1], a = lifts[b + 2] * dt;
    splat(u, null, W + 1, H, x, y - 0.5, -a * effect.gravity[0]); splat(v, null, W, H + 1, x - 0.5, y, -a * effect.gravity[1]);
  }
  if (effect.drag) { const keep = 1 - effect.drag * dt; for (let k = 0; k < u.length; k++) u[k] *= keep; for (let k = 0; k < v.length; k++) v[k] *= keep; }
  if (effect.yield) strainForce(state, effect, dt);
  countCells(state);
  const room = g.geo ? g.geo.open : null;
  if (effect.tension) cohere(state, effect.tension * dt, room);
  enforce(g);
  // An obstacle moving away from the liquid behind it draws the liquid after it only as far as the liquid can follow:
  // against a crowded cell its face holds still for the step, so the crowd spreads instead of being packed ever tighter
  // against the pixels it has not yet left (liquid running off a lifted spoon gathers below it as a drop).
  if (g.moved) {
    const { uWall, vWall, uFixed, vFixed } = g, X = W + 1, crowded = c => !solid[c] && state.cells[c] > PER_CELL;
    for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
      const k = j * X + i, w = uWall[k];
      if (uFixed[k] && w && (w > 0 ? i > 0 && crowded(j * W + i - 1) : i < W && crowded(j * W + i))) u[k] = 0;
    }
    for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i, w = vWall[k];
      if (vFixed[k] && w && (w > 0 ? j > 0 && crowded(k - W) : j < H && crowded(k))) v[k] = 0;
    }
  }
  // Crowded cells spread and sparse cells inside the liquid draw particles in, so splashes neither shrink the volume nor
  // thin it out into a larger, emptier one. Cells on the surface only spread.
  const wet = c => solid[c] || fluid[c];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    // Beside a smooth obstacle a cell holds particles for its open share; the open corners of cut steps take no part.
    if (room && room[c] < 0.5) { target[c] = 0; continue; }
    const error = room ? state.cells[c] / (PER_CELL * room[c]) - 1 : state.cells[c] / PER_CELL - 1;
    const interior = fluid[c] && (i > 0 ? wet(c - 1) : walls.left) && (i < W - 1 ? wet(c + 1) : walls.right) && (j > 0 ? wet(c - W) : walls.top) && (j < H - 1 ? wet(c + W) : walls.bottom);
    target[c] = error > 0 || interior ? 0.5 * error : 0;
  }
  // A yield-stress liquid is strained by its flow alone: the spreading has a solve of its own after the flow's, which
  // moves the particles without straining them. (Strained by it, the liquid stored springiness that only mended the
  // particles' spacing, and a resting slime rocked for ever.)
  const split = effect.yield > 0, spreading = split ? state.strain.none : target;
  g.airP = effect.air ? sealAir(state, effect, dt) : null;
  project(g, fluid, effect.iterations, spreading);
  g.pockets = null;
  // A thick liquid resists the flow the pressure solve has just made (a heap slumping under its own weight) before it
  // moves, then is made divergence-free again. That second solve starts from no pressure and leaves the first's in
  // place to start the next step from.
  const thick = effect.viscosity || effect.yield;
  if (thick) {
    viscous(g, fluid, effect, dt, effect.yield ? state.strain.stiff : null);
    state.pressure.set(g.p); g.p.fill(0);
    project(g, fluid, effect.iterations, spreading);
    g.p.set(state.pressure);
  }
  const uValid = new Uint8Array(state.uValid.length), vValid = new Uint8Array(state.vValid.length);
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) { const k = j * (W + 1) + i; uValid[k] = g.uFixed[k] || (i > 0 && fluid[j * W + i - 1]) || (i < W && fluid[j * W + i]) ? 1 : 0; }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) { const k = j * W + i; vValid[k] = g.vFixed[k] || (j > 0 && fluid[(j - 1) * W + i]) || (j < H && fluid[j * W + i]) ? 1 : 0; }
  if (split) {
    const { flowU, flowV, flowPressure } = state.strain;
    flowU.set(u); flowV.set(v);
    extrapolate(flowU, Uint8Array.from(uValid), W + 1, H, 3); extrapolate(flowV, Uint8Array.from(vValid), W, H + 1, 3);
    strainRates(state, flowU, flowV);
    // The spreading's solve starts from the last step's, as the flow's starts from the last step's pressure.
    flowPressure.set(g.p); g.p.set(state.strain.spread);
    // The pockets pushed in the flow's solve; this one only mends the spacing.
    const airP = g.airP;
    g.airP = null;
    project(g, fluid, effect.iterations, target);
    g.airP = airP;
    state.strain.spread.set(g.p); g.p.set(flowPressure);
  }
  extrapolate(u, uValid, W + 1, H, 3); extrapolate(v, vValid, W, H + 1, 3);
  // FLIP: particles keep their own velocity plus the grid's change, blended with the grid velocity (PIC) to calm noise.
  // In a thick liquid a particle's own jitter, finer than the grid, fades as the grid's finest ripples do under its
  // viscosity, so the FLIP share shrinks where the liquid is thick. With APIC the grid share also hands each particle the
  // slopes of the flow around it, which it carries and hands back, so the calm share keeps swirls instead of smearing them.
  const flip = effect.flip, mu = thick ? g.visc.mu : null, cling = state.cling, normal = cling ? new Float64Array(2) : null, carry = state.carry;
  // With obstacles of their own adhesion, the hold is weighed this step from the effect's adhesion and theirs.
  const grip = state.grip ? state.grip.grip : null;
  if (grip) { const { plain, own } = state.grip; for (let c = 0; c < g.N; c++) grip[c] = effect.adhesion * plain[c] + own[c]; }
  const slopes = state.apic ? new Float64Array(2) : null, limit = effect.yield / (2 * STIFFNESS);
  const { geo } = g, stepped = geo ? geo.stepped : solid, velocity = geo ? new Float64Array(2) : null, landing = geo ? new Float64Array(2) : null;
  const frozen = state.heat ? state.frozen : null;
  for (let k = state.n - 1; k >= 0; k--) {
    if (frozen && frozen[k]) { state.vx[k] = 0; state.vy[k] = 0; continue; }
    let x = state.x[k], y = state.y[k];
    const pu = sampleU(g, u, x, y), pv = sampleV(g, v, x, y), share = mu ? flip / (1 + 8 * dt * mu[Math.floor(y) * W + Math.floor(x)]) : flip;
    state.vx[k] = share * (state.vx[k] + pu - sampleU(g, uOld, x, y)) + (1 - share) * pu;
    state.vy[k] = share * (state.vy[k] + pv - sampleV(g, vOld, x, y)) + (1 - share) * pv;
    if (slopes) {
      slope(u, W + 1, H, x, y - 0.5, slopes); state.cux[k] = slopes[0]; state.cuy[k] = slopes[1];
      slope(v, W, H + 1, x - 0.5, y, slopes); state.cvx[k] = slopes[0]; state.cvy[k] = slopes[1];
    }
    // Yield stress: the particle's strain grows by this step's rate of strain, turns with the flow, and is capped at the
    // yield strain; strain beyond the cap is plastic flow, which the liquid does not spring back from. The turn keeps the
    // strain's size (a Cayley rotation): turned a step at a time along the tangent, it grew a little every step, and the
    // growth set a resting slime rocking for ever.
    if (limit) {
      const c = Math.floor(y) * W + Math.floor(x), { ra, rb, spin } = state.strain, ea = state.ea[k], eb = state.eb[k];
      const turn = dt * spin[c], q = turn * turn / 4;
      let na = ((1 - q) * ea - turn * eb) / (1 + q) + dt * ra[c], nb = ((1 - q) * eb + turn * ea) / (1 + q) + dt * rb[c];
      const size = na * na + nb * nb;
      if (size > limit * limit) { const scale = limit / Math.sqrt(size); na *= scale; nb *= scale; }
      state.ea[k] = na; state.eb[k] = nb;
    }
    if (state.vx[k] > MAX_SPEED) state.vx[k] = MAX_SPEED; else if (state.vx[k] < -MAX_SPEED) state.vx[k] = -MAX_SPEED;
    if (state.vy[k] > MAX_SPEED) state.vy[k] = MAX_SPEED; else if (state.vy[k] < -MAX_SPEED) state.vy[k] = -MAX_SPEED;
    const mx = x + 0.5 * dt * pu, my = y + 0.5 * dt * pv;
    let nx = x + dt * sampleU(g, u, mx, my), ny = y + dt * sampleV(g, v, mx, my);
    // Beside a moving obstacle: its velocity here (wx, wy), and how far its whole-pixel place is ahead of where it really
    // is at the end of this step (sx, sy), so the particle meets it where it really is.
    let wx = 0, wy = 0, sx = 0, sy = 0;
    if (carry) {
      const fx = x - 0.5, fy = y - 0.5, near = bilinear(carry.near, W, H, fx, fy);
      if (near > 0) {
        const ahead = 1 - state.phase;
        wx = bilinear(carry.u, W, H, fx, fy) / near; wy = bilinear(carry.v, W, H, fx, fy) / near;
        sx = bilinear(carry.du, W, H, fx, fy) / near + ahead * wx; sy = bilinear(carry.dv, W, H, fx, fy) / near + ahead * wy;
      }
    }
    if (cling) {
      // Closeness is measured from where a moving obstacle really is, and away is away from where it is going: what
      // clings to it moves with it.
      const fx = x - 0.5 + sx, fy = y - 0.5 + sy, close = bilinear(cling, W, H, fx, fy);
      let hold;
      if (grip) { hold = 2 * bilinear(grip, W, H, fx, fy); slope(grip, W, H, fx, fy, normal); } else { hold = 2 * effect.adhesion * close; slope(cling, W, H, fx, fy, normal); }
      const length = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1]);
      if (close > 0 && hold > 0 && length > 0) {
        const ux = normal[0] / length, uy = normal[1] / length;
        const away = (nx - x - dt * wx) * ux + (ny - y - dt * wy) * uy, leaving = (state.vx[k] - wx) * ux + (state.vy[k] - wy) * uy;
        if (away < 0) { const keep = Math.min(-away, hold * dt); nx += keep * ux; ny += keep * uy; }
        if (leaving < 0) { const keep = Math.min(-leaving, hold); state.vx[k] += keep * ux; state.vy[k] += keep * uy; }
      }
    }
    if (walls.left && nx < 0.01) { nx = 0.01; if (state.vx[k] < 0) state.vx[k] = 0; }
    if (walls.right && nx > W - 0.01) { nx = W - 0.01; if (state.vx[k] > 0) state.vx[k] = 0; }
    if (walls.top && ny < 0.01) { ny = 0.01; if (state.vy[k] < 0) state.vy[k] = 0; }
    if (walls.bottom && ny > H - 0.01) { ny = H - 0.01; if (state.vy[k] > 0) state.vy[k] = 0; }
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) { removeParticle(state, k); continue; }
    // Particles never enter an obstacle, however far they move in a step: they slide along it, or stay put and lose the
    // speed into it. A smooth obstacle's outline turns them along it, keeping their speed along the outline.
    const blocked = (px, py) => crossesSolid(stepped, W, H, x, y, px, py);
    if (blocked(nx, ny)) {
      if (!blocked(nx, y)) { ny = y; state.vy[k] = 0; }
      else if (!blocked(x, ny)) { nx = x; state.vx[k] = 0; }
      else { nx = x; ny = y; state.vx[k] = 0; state.vy[k] = 0; }
    }
    if (geo) {
      velocity[0] = state.vx[k]; velocity[1] = state.vy[k];
      if (slideSmooth(geo, W, H, x, y, nx, ny, velocity, landing)) { nx = landing[0]; ny = landing[1]; state.vx[k] = velocity[0]; state.vy[k] = velocity[1]; }
    }
    state.x[k] = nx; state.y[k] = ny;
  }
}
// ---- Air pockets -----------------------------------------------------------------------------------------------------
// Air is every cell that is neither solid nor holding liquid. Air joined to an open canvas edge is at zero pressure, as
// before. With `air` on, a sealed region of air is a pocket that keeps its air: it is tracked from step to step by the
// cells it shares with the last step's regions (pockets that merge add their air; one that splits shares its air by
// volume), and its pressure follows the gas law, in pixels of head: stiffness × (air / volume − 1), where its air is the
// volume it had at zero pressure and its volume counts its empty cells and the empty share of the liquid cells around it.
// A bubble is a pocket too small for the grid to show, so a sealed region becomes a pocket only once it holds
// POCKET_START cells' worth. A smaller one with no pocket before it, air a splash or a pour has trapped, lets its air go
// once, as bubbles (when `air.bubbles` says how to draw them) that start in the liquid at its edge, and closes as before;
// gaps under POCKET_END between jostling particles just close. A pocket squeezed below POCKET_END, which the 3 × 3 blur
// that draws the surface would fill in anyway, lets its air go the same way. Bubbles that rise into a pocket give it
// their air back (see absorber). Returns each cell's pocket pressure in the solver's units.
const POCKET_START = 12, POCKET_END = 3;
function sealAir(state, effect, dt) {
  const { g, fluid, cells, air } = state, { W, H, N, solid, uFixed, vFixed } = g, X = W + 1, room = g.geo ? g.geo.open : null;
  const label = air.before, before = air.label, { stack, pressure } = air, old = air.regions, regions = [];
  air.label = label; air.before = before;
  label.fill(-1);
  const open = c => !solid[c] && !fluid[c] && label[c] < 0;
  for (let c0 = 0; c0 < N; c0++) {
    if (!open(c0)) continue;
    const id = regions.length, region = { volume: 0, open: false, x: 0, y: 0, cells: 0, air: 0, tracked: false, spent: false, edge: -1 };
    regions.push(region);
    let top = 0;
    stack[top++] = c0; label[c0] = id;
    while (top) {
      const c = stack[--top], i = c % W, j = (c - i) / W;
      region.cells++; region.x += i + 0.5; region.y += j + 0.5;
      // Through every open face: to the next air cell, or out through an open canvas edge.
      const reach = (fixed, inside, d) => {
        if (fixed) return;
        if (!inside) region.open = true;
        else if (open(d)) { label[d] = id; stack[top++] = d; } else if (fluid[d] && (region.edge < 0 || cells[d] > cells[region.edge])) region.edge = d;
      };
      reach(uFixed[j * X + i], i > 0, c - 1); reach(uFixed[j * X + i + 1], i < W - 1, c + 1); reach(vFixed[c], j > 0, c - W); reach(vFixed[c + W], j < H - 1, c + W);
    }
    region.volume = region.cells;
  }
  // The empty share of each liquid cell goes to an air region beside it.
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (!fluid[c] || solid[c]) continue;
    const capacity = PER_CELL * (room ? room[c] : 1), empty = 1 - cells[c] / capacity;
    if (!(empty > 0) || capacity < PER_CELL / 2) continue;
    const r = i > 0 && !uFixed[j * X + i] && label[c - 1] >= 0 ? label[c - 1] : i < W - 1 && !uFixed[j * X + i + 1] && label[c + 1] >= 0 ? label[c + 1]
      : j > 0 && !vFixed[c] && label[c - W] >= 0 ? label[c - W] : j < H - 1 && !vFixed[c + W] && label[c + W] >= 0 ? label[c + W] : -1;
    if (r >= 0) regions[r].volume += empty;
  }
  // Which of the last step's pockets each region holds part of, and which regions hold part of one that has let its air go.
  const links = new Set(), from = regions.map(() => []), into = old.map(() => []);
  for (let c = 0; c < N; c++) {
    const r = label[c], q = before[c];
    if (r < 0 || q < 0 || !old[q]) continue;
    if (old[q].spent) regions[r].spent = true;
    if (!old[q].tracked || links.has(q * N + r)) continue;
    links.add(q * N + r); from[r].push(q); into[q].push(r);
  }
  // Its air rises as bubbles from the fullest liquid cell beside it, if that is at least half full; one with no liquid
  // around it (the last of a bottle draining) makes none.
  const release = (region, volume) => {
    region.spent = true;
    const e = region.edge;
    if (effect.air.bubbles && volume > 0.5 && e >= 0 && cells[e] >= PER_CELL / 2) air.release.push(e % W + 0.5, Math.floor(e / W) + 0.5, volume);
  };
  old.forEach((q, n) => { if (q.tracked && !into[n].length) release(q, q.volume); });
  // Bubbles that gathered under a ceiling into a pocket's worth (see carvePocket) bring their air to the region their cells
  // are in now: a new pocket starts with it, one they joined adds it, and in open air it is gone (vented).
  const made = new Float64Array(regions.length);
  for (let k = 0; k < air.made.length; k += 2) { const r = label[air.made[k]]; if (r >= 0) made[r] += air.made[k + 1]; }
  air.made.length = 0;
  regions.forEach((region, r) => {
    if (region.open) return;
    if (from[r].length) {
      for (const q of from[r]) { const shared = into[q].reduce((sum, n) => sum + regions[n].volume, 0); region.air += old[q].air * region.volume / shared; }
      region.air += made[r];
      region.tracked = true;
    } else if (made[r]) { region.air = made[r]; region.tracked = true; }
    else if (region.volume >= POCKET_START) { region.air = region.volume; region.tracked = true; }
    else if (region.volume >= POCKET_END && !region.spent) release(region, region.volume);
    if (region.tracked && region.volume < POCKET_END) { release(region, region.volume); region.tracked = false; }
  });
  // The gas law, in pixels of head, scaled to the solver's pressure (gravity × depth per step): Pn now and its slope P'.
  // A pocket inside the law's range is an unknown of the solve (see projectLiquid); one squeezed or stretched past four
  // times pushes no harder and holds that pressure, so a nearly closed pocket cannot fling the liquid.
  const [gx, gy] = effect.gravity, head = dt * Math.max(0.05, Math.sqrt(gx * gx + gy * gy)), stiffness = effect.air.stiffness;
  const index = regions.map(() => -1), Pn = [], C = [];
  pressure.fill(0);
  regions.forEach((region, r) => {
    if (!region.tracked) return;
    const ratio = region.air / region.volume;
    if (ratio > 0.25 && ratio < 4) { index[r] = Pn.length; Pn.push(stiffness * (ratio - 1) * head); C.push(region.volume / (stiffness * ratio * head * dt)); return; }
    const held = stiffness * (Math.min(4, Math.max(0.25, ratio)) - 1) * head;
    for (let c = 0; c < N; c++) if (label[c] === r) pressure[c] = held;
  });
  const node = air.node ??= new Int32Array(N);
  for (let c = 0; c < N; c++) node[c] = label[c] >= 0 ? index[label[c]] : -1;
  g.pockets = Pn.length ? { node, Pn: Float64Array.from(Pn), C: Float64Array.from(C) } : null;
  air.regions = regions;
  return pressure;
}
function liquidFields(state, out) {
  const { g, splat: count, blur, speedSum } = state, { W, H, pixels: solid, geo } = g, [density, , speed] = out, frozen = state.heat ? state.frozen : null;
  count.fill(0); speedSum.fill(0);
  for (let k = 0; k < state.n; k++) {
    // Ice is drawn by its own look (see heatFields).
    if (frozen && frozen[k]) continue;
    const x = state.x[k], y = state.y[k], value = Math.sqrt(state.vx[k] * state.vx[k] + state.vy[k] * state.vy[k]);
    splatOpen(speedSum, count, W, H, x, y, value, solid, geo);
  }
  // A light 3 × 3 blur over the open cells turns particles into a continuous surface. Obstacle pixels hold no water and
  // take no part, so a wall thins neither the water beside it nor a pocket walled in on three sides (past a smooth
  // obstacle, a dry cell also skips a corner inside its outline).
  const across = geo ? geo.across : null;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const wet = count[j * W + i] > 0;
    let sum = 0, weights = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= W || y >= H || solid[y * W + x]) continue;
      if (across && !wet && di && dj && (across[j * W + i] & (dj < 0 ? (di < 0 ? TL : TR) : di < 0 ? BL : BR))) continue;
      const w = (di ? 1 : 2) * (dj ? 1 : 2);
      sum += count[y * W + x] * w; weights += w;
    }
    blur[j * W + i] = weights ? sum / weights : 0;
  }
  // Speed only counts where there is some water (a quarter of a full cell), so a thin, fast stream or a falling drop
  // can be drawn by its speed without a halo around every particle.
  for (let c = 0; c < g.N; c++) { density[c] = solid[c] ? 0 : blur[c] / PER_CELL; speed[c] = count[c] > 0 && density[c] >= 0.25 ? speedSum[c] / count[c] : 0; }
  if (state.strands) strandField(state, density, out[3]);
}

// Strands: liquid stretched thinner than the density can draw. The blur spreads a string one particle wide over three
// pixels, so it falls below LEVEL and vanishes long before it breaks. The strand field is 1 along a one-pixel path
// through the cells that hold particles but not enough density: a path joining two separate pieces of drawn liquid (a
// string between a spoon and a pool), or one hanging at least STRAND_REACH pixels off one piece (what is left of a string
// that has snapped). Shorter nubs and fringes on a surface, and particles loose in the air, are not strands, so a
// surface is neither thickened nor dusted with stray pixels. 0 elsewhere. Paths step to all eight neighbours, straight
// steps first, and are as short as the particles allow, so a string is drawn without doubled corners.
const STRAND_REACH = 3;
const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
function strandField(state, density, out) {
  const { g } = state, { W, H, N, pixels: solid } = g;
  const s = state.strandScratch ??= { count: new Uint16Array(N), body: new Int32Array(N), part: new Int32Array(N), dist: new Int32Array(N), from: new Int32Array(N), queue: new Int32Array(N) };
  const { count, body, part, dist, from, queue } = s;
  out.fill(0); count.fill(0); body.fill(-1); part.fill(-1);
  for (let k = 0; k < state.n; k++) { const i = Math.floor(state.x[k]), j = Math.floor(state.y[k]); if (i >= 0 && j >= 0 && i < W && j < H) count[j * W + i]++; }
  const drawn = c => !solid[c] && density[c] >= LEVEL, loose = c => !solid[c] && density[c] < LEVEL && count[c] > 0;
  // Each cell's neighbours, with -1 off the canvas.
  const next = (c, d) => { const i = c % W + AROUND[d][0], j = (c - c % W) / W + AROUND[d][1]; return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i; };
  // Pieces of drawn liquid, then of loose cells, each labelled through its eight neighbours.
  const label = (is, into) => {
    let pieces = 0;
    for (let c = 0; c < N; c++) {
      if (into[c] >= 0 || !is(c)) continue;
      let head = 0, tail = 0;
      into[c] = pieces; queue[tail++] = c;
      while (head < tail) { const a = queue[head++]; for (let d = 0; d < 8; d++) { const b = next(a, d); if (b >= 0 && into[b] < 0 && is(b)) { into[b] = pieces; queue[tail++] = b; } } }
      pieces++;
    }
    return pieces;
  };
  label(drawn, body);
  const pieces = label(loose, part);
  // Gathers each loose piece's cells (in scan order) and the drawn pieces beside them.
  const cells = Array.from({ length: pieces }, () => []);
  for (let c = 0; c < N; c++) if (part[c] >= 0) cells[part[c]].push(c);
  const touching = (c, out) => { for (let d = 0; d < 8; d++) { const b = next(c, d); if (b >= 0 && body[b] >= 0 && !out.includes(body[b])) out.push(body[b]); } return out; };
  // Breadth-first distances through one loose piece from the cells `start` accepts; returns the cells in reach order.
  const spread = (list, start) => {
    let head = 0, tail = 0;
    for (const c of list) { dist[c] = -1; from[c] = -1; }
    for (const c of list) if (start(c)) { dist[c] = 0; queue[tail++] = c; }
    while (head < tail) { const a = queue[head++]; for (let d = 0; d < 8; d++) { const b = next(a, d); if (b >= 0 && part[b] === part[a] && dist[b] < 0) { dist[b] = dist[a] + 1; from[b] = a; queue[tail++] = b; } } }
    return queue.slice(0, tail);
  };
  const mark = c => { for (let a = c; a >= 0; a = from[a]) out[a] = 1; };
  for (const list of cells) {
    const near = new Map();
    for (const c of list) near.set(c, touching(c, []));
    const bodies = [];
    for (const c of list) for (const b of near.get(c)) if (!bodies.includes(b)) bodies.push(b);
    if (bodies.length >= 2) {
      // A bridge: the shortest path from the first piece to each of the others.
      spread(list, c => near.get(c).includes(bodies[0]));
      for (const other of bodies.slice(1)) {
        let end = -1;
        for (const c of list) if (dist[c] >= 0 && near.get(c).includes(other) && (end < 0 || dist[c] < dist[end])) end = c;
        if (end >= 0) mark(end);
      }
    } else if (bodies.length === 1) {
      // A hanging thread: the path to its far end, if it reaches far enough.
      const order = spread(list, c => near.get(c).length > 0), end = order.at(-1);
      if (dist[end] + 1 >= STRAND_REACH) mark(end);
    }
  }
}

// ---- Phase changes ----------------------------------------------------------------------------------------------------
// With `heat`, a liquid's particles carry heat and change phase (docs/physics-model.md, sections 3, 4 and 9), on the gas
// temperature scale: 0 is the room's air, water freezes at `freeze` (−0.5) and boils at `boil` (0.5). Each particle keeps
// its energy, which is its temperature plus its progress through a change: below `freeze` it is the temperature; at
// `freeze` the temperature holds while the energy climbs by `latent` (melting), then rises with it to `boil`, where it
// holds again while the energy climbs by `vaporize` (boiling). Ice melts only once it has taken up all of `latent` and
// water freezes only once it has given it up, so the plateau is the gap that keeps ice from flickering.
// Each step, before the liquid moves, heat flows between particles and their neighbours (`conduct`), from hot or cold
// obstacles (`contact`; an obstacle's `temperature` is a surface property of the solid layer) and between the surface
// and the air (`air`). Ice holds still or settles as a piece; a cell with ICE_CELL ice particles is ICE in the solid
// layer, so the pressure, viscosity and cling solves, air pockets and bubbles meet it as they meet an obstacle. With
// `vapour`, water that boils at the surface (or, with `evaporation`, a share of warm surface water) becomes vapour, which
// the gas step moves through the cells holding neither liquid nor ice, the liquid's cells walls moving with it; a boil
// inside the water makes bubbles (addBubble) that carry their vapour up. Vapour touching anything colder than `dew` beads
// up as dew and drips back; touching ice or an obstacle colder than `frost` it grows into ice; with `sublimate`, ice
// turns straight into vapour at its surface. Matter is kept exactly and counted each frame (see heatAmounts).
const PHASE = 3000, PHASE_SALT = { grain: 1, evaporate: 2, spawnX: 3, spawnY: 4, frost: 5, boil: 6, nucleus: 7, branch: 8, lean: 9, site: 10 }, ICE_CELL = Math.ceil(LEVEL * PER_CELL);
// Frost grows as fingers (see heatStep): the eight directions in turn round the compass, so two a step apart are 45
// degrees apart; the share of the cells beside a flat cold side a finger starts from, the chance a frame that one starts
// anywhere else beside it, and how far from other frost that may be; how readily a stem, a branch and a twig grow
// on (REACH, by generation), so branches stay shorter than their stem; how readily ice with no direction of its own (a
// cube, a frozen fill) and a frost cell that already holds frost take more.
const COMPASS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]], SITES = 0.04, NUCLEI = 0.003, SPACING = 5, REACH = [1, 0.35, 0.12], ROUND = 0.15, THICKEN = 0.04;
// A frost cell that has lost its ice (melted, sublimated, settled away, pushed off by an obstacle) forgets its finger, so
// the empty cell it leaves never goes on taking frost as a finger's tip would. A cell that has started taking frost and
// holds none yet keeps its direction until it does (`frostIce` notes the cells that have held frost).
function forgetFrost(P) {
  const dirs = P.frostDir;
  if (!dirs) return;
  const { ice, frostIce: had } = P;
  for (let c = 0; c < dirs.length; c++) {
    if (dirs[c] < 0) continue;
    if (ice[c]) had[c] = 1;
    else if (had[c]) { dirs[c] = -1; P.frostGen[c] = 0; P.frostLen[c] = 0; had[c] = 0; }
  }
}
// How far below freezing water freezes with no ice or cold solid to start it.
const SUPERCOOL = 0.5;
// How fast an obstacle's temperature warms or chills the air touching it, per frame (a gas effect's, or a liquid's air).
const SURFACE_HEAT = 0.15;
const tempOf = (h, e, ice) => (ice ? (e < h.freeze ? e : h.freeze) : e >= h.freeze + h.latent ? (e - h.latent < h.boil ? e - h.latent : h.boil) : e < h.freeze ? e : h.freeze);
// The energy of water (or ice) at temperature t.
const energyOf = (h, t, ice) => (ice ? (t < h.freeze ? t : h.freeze) : t < h.freeze ? t : (t < h.boil ? t : h.boil) + h.latent);
// Each cell's obstacle temperature from the solid layer's surface properties: NaN where there is none (an open cell, ice,
// or an obstacle with no temperature, which takes no part in the heat's flow).
function surfaceTemperatures(solids, out) {
  for (let c = 0; c < solids.N; c++) { const t = solids.solid[c] && solids.owner[c] >= 0 ? solids.props(solids.owner[c]).temperature : null; out[c] = t === null ? NaN : t; }
  return out;
}
// Air touching a hot or cold obstacle takes `rate` of the difference to its temperature (open cells only).
function warmAir(T, open, hot, W, H, rate) {
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    if (!open[c]) continue;
    let t = T[c];
    if (i > 0 && hot[c - 1] === hot[c - 1]) t += rate * (hot[c - 1] - t);
    if (i < W - 1 && hot[c + 1] === hot[c + 1]) t += rate * (hot[c + 1] - t);
    if (j > 0 && hot[c - W] === hot[c - W]) t += rate * (hot[c - W] - t);
    if (j < H - 1 && hot[c + W] === hot[c + W]) t += rate * (hot[c + W] - t);
    T[c] = t;
  }
}
// The heat of a liquid on grid `g`. `layout`, `base` (its obstacle pixels) and `places` follow the obstacles as they move
// (see moveObstacles); `mask` is the obstacles' pixels and the ice's, the solver's solid cells (or, beside smooth
// obstacles, the pixels its geometry is traced from).
function createHeat(effect, grid) {
  const { W, H, N } = grid, h = effect.heat;
  const P = {
    heat: h, layout: effect.layout, base: effect.solid, places: placementsAt(effect.obstacles, 0), mask: grid.geo ? Uint8Array.from(effect.solid) : grid.solid,
    water: new Uint16Array(N), ice: new Uint16Array(N), sumT: new Float64Array(N), Tc: new Float64Array(N), flux: new Float64Array(N),
    obstacleT: new Float64Array(N), owner: Int16Array.from(effect.layout.owner), iceSpeed: new Float64Array(N), iceMoving: false, input: new Float64Array(N),
    pending: new Float64Array(N), frost: new Float64Array(N), escaped: 0, added: 0, removed: 0, converting: false, step: 0,
    spawnEnergy: energyOf(h, h.ambient, false), spawnFrozen: 0, vapour: null
  };
  P.iceHook = { moving: false, velocity: c => (P.iceSpeed[c] ? [0, P.iceSpeed[c]] : null) };
  if (effect.vapour) {
    const g = createGrid(W, H, Uint8Array.from(effect.solid), effect.walls);
    g.uWall = new Float64Array(g.u.length); g.vWall = new Float64Array(g.v.length);
    const f = () => new Float64Array(N);
    P.vapour = { g, d: f(), T: f().fill(h.ambient), d1: f(), T1: f(), source: f(), step: f(), curl: f(), magnitude: f(), open: new Uint8Array(N).fill(1), liquid: new Uint8Array(N), region: new Int32Array(N), closed: [], sums: [] };
    for (let c = 0; c < N; c++) if (effect.solid[c]) P.vapour.open[c] = 0;
    labelRegions(P.vapour, W, H, effect.walls);
  }
  return P;
}
// Each cell's water and ice particles and their mean temperature.
function tally(state) {
  const P = state.heat, h = P.heat, { W, H, N } = state.g, { water, ice, sumT, Tc } = P;
  water.fill(0); ice.fill(0); sumT.fill(0);
  for (let k = 0; k < state.n; k++) {
    const i = Math.floor(state.x[k]), j = Math.floor(state.y[k]);
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    const c = j * W + i;
    if (state.frozen[k]) ice[c]++; else water[c]++;
    sumT[c] += tempOf(h, state.energy[k], state.frozen[k]);
  }
  for (let c = 0; c < N; c++) { const n = water[c] + ice[c]; Tc[c] = n ? sumT[c] / n : 0; }
}
// The vapour's connected regions, and for each the number of its cells if it is closed on every side (0 if it reaches an
// open edge).
function labelRegions(V, W, H, walls) {
  const { open, region } = V, N = W * H, stack = [];
  region.fill(-1); V.closed = [];
  for (let c = 0; c < N; c++) {
    if (!open[c] || region[c] >= 0) continue;
    const r = V.closed.length;
    let leaks = false, cells = 0;
    region[c] = r; stack.push(c);
    while (stack.length) {
      const d = stack.pop(), i = d % W, j = (d - i) / W;
      cells++;
      if ((i === 0 && !walls.left) || (i === W - 1 && !walls.right) || (j === 0 && !walls.top) || (j === H - 1 && !walls.bottom)) leaks = true;
      for (const e of [i > 0 ? d - 1 : -1, i < W - 1 ? d + 1 : -1, j > 0 ? d - W : -1, j < H - 1 ? d + W : -1]) if (e >= 0 && open[e] && region[e] < 0) { region[e] = r; stack.push(e); }
    }
    V.closed.push(leaks ? 0 : cells);
  }
  V.sums = new Float64Array(V.closed.length);
}
// The solid layer after a step's changes: ICE joins the obstacles in the liquid's solid mask and owners, moving at its
// piece's speed while it settles, and what clings to solids reads the new layer. Beside smooth obstacles the grid's
// geometry is traced again from the obstacles' pixels and the ice's (ice meets the liquid pixel by pixel, so nothing is
// smoothed where it touches a smooth obstacle). `moved` says the obstacles have moved this frame (moveObstacles), and
// 'layout' that they cover other cells: the layer takes their places and velocities, and what clings reads it anew.
// Then the vapour's walls: those and the cells the liquid fills. Vapour in a cell that liquid, ice or an obstacle has
// taken moves to the open cells beside it.
function heatMasks(state, effect, moved = false) {
  const P = state.heat, g = state.g, { W, H, N, walls } = g, { base, water, ice, owner, mask, layout } = P;
  let changed = false;
  for (let c = 0; c < N; c++) {
    const frozen = !base[c] && ice[c] >= ICE_CELL, s = base[c] || frozen ? 1 : 0;
    owner[c] = frozen ? ICE : layout.owner[c];
    if (s !== mask[c]) { mask[c] = s; changed = true; }
  }
  if (changed || moved === 'layout') {
    if (!layout.smooth) {
      // No smooth obstacle shows any more (one vanished on its keys, or left the canvas): the solver meets the pixels
      // again. (Left traced, the geometry of the smooth obstacle that had gone still held the water up, a ghost.)
      if (g.geo) { g.geo = null; g.solid = mask; g.pixels = mask; }
      fixFaces(W, H, mask, walls, g.uFixed, g.vFixed);
    } else {
      const geo = smoothGeometry(mask, layout.smooth, W, H, walls);
      for (let k = 0; k < g.uFixed.length; k++) g.uFixed[k] = geo.uOpen[k] ? 0 : 1;
      for (let k = 0; k < g.vFixed.length; k++) g.vFixed[k] = geo.vOpen[k] ? 0 : 1;
      g.geo = geo; g.solid = geo.solid; g.pixels = geo.pixels; g.weights ??= new Float64Array(N);
    }
  }
  const moving = P.iceMoving;
  if (changed || moved || moving || P.iceHook.moving) {
    P.iceHook.moving = moving;
    const solids = state.solids = solidLayer(effect, { solid: mask, owner }, P.places, W, H, P.iceHook);
    if (state.cling) { if (changed || moved === 'layout') { state.cling = clingField(solids); state.grip = gripFields(solids, effect.obstacles); } state.carry = carryFields(solids); }
    // Faces against moving obstacles and settling ice carry their speed.
    if (solids.moving || g.moved) {
      if (!g.uWall) { g.uWall = new Float64Array(g.u.length); g.vWall = new Float64Array(g.v.length); } else { g.uWall.fill(0); g.vWall.fill(0); }
      g.moved = false;
      const X = W + 1, of = c => (c >= 0 ? solids.velocity(c) : null);
      if (solids.moving) {
        for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) { const s = of(i > 0 ? j * W + i - 1 : -1) ?? of(i < W ? j * W + i : -1); if (s) { g.uWall[j * X + i] = s[0]; g.moved = true; } }
        for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) { const k = j * W + i, s = of(j > 0 ? k - W : -1) ?? of(j < H ? k : -1); if (s) { g.vWall[k] = s[1]; g.moved = true; } }
      }
      enforce(g);
    }
  }
  const V = P.vapour;
  if (!V) return;
  const vg = V.g, m = V.d;
  let walled = false;
  for (let c = 0; c < N; c++) {
    const taken = !base[c] && water[c] + ice[c] >= ICE_CELL;
    V.liquid[c] = taken && ice[c] < ICE_CELL ? 1 : 0;
    const s = base[c] || taken ? 1 : 0;
    if (s !== vg.solid[c]) { vg.solid[c] = s; V.open[c] = 1 - s; walled = true; }
  }
  if (!walled) return;
  fixFaces(W, H, vg.solid, walls, vg.uFixed, vg.vFixed);
  for (let c = 0; c < N; c++) {
    if (!vg.solid[c] || !(m[c] > 0)) continue;
    const i = c % W, j = (c - i) / W, near = [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, j > 0 ? c - W : -1, j < H - 1 ? c + W : -1].filter(e => e >= 0 && V.open[e]);
    if (near.length) for (const e of near) m[e] += m[c] / near.length;
    else (ice[c] >= ICE_CELL ? P.frost : P.pending)[c] += m[c];
    m[c] = 0;
  }
  labelRegions(V, W, H, walls);
}
// A closed region of vapour can't take in more than it lets out: its sources are evened out against the flow through
// its walls (the liquid's surface moving), so the pressure solve has an answer.
function balance(V, g) {
  if (!V.closed.some(Boolean)) return;
  const { W, N, u, v } = g, X = W + 1, { region, closed, sums, step } = V;
  sums.fill(0);
  for (let c = 0; c < N; c++) { const r = region[c]; if (r < 0 || !closed[r]) continue; const i = c % W, j = (c - i) / W; sums[r] += u[j * X + i + 1] - u[j * X + i] + v[c + W] - v[c] - step[c]; }
  for (let c = 0; c < N; c++) { const r = region[c]; if (r >= 0 && closed[r]) step[c] += sums[r] / closed[r]; }
}
// One step of the vapour over the air cells, by the gas step with what differs for a liquid's air (physics-model.md,
// section 7): the liquid's cells are walls moving with it, up is against the liquid's gravity, buoyancy is relative to
// the air's temperature and weight to the room vapour fills, sources are what boiled off or condensed (evened out in a
// sealed region), and the vapour is matter, so advection keeps it: semi-Lagrangian advection neither keeps nor loses
// mass exactly, so the vapour is scaled back to what it held less what left through open edges.
function stepVapour(state, effect, dt) {
  const P = state.heat, V = P.vapour, s = effect.vapour, h = effect.heat, g = V.g, L = state.g, { W, H, N, u, v, uFixed, vFixed, uWall, vWall } = g, X = W + 1, { d: m, T } = V;
  const scale = s.expansion / PER_CELL, { base, obstacleT, Tc } = P;
  // Faces against the liquid move with it, and those between a moving obstacle and the air with the obstacle.
  const lu = L.uWall, lv = L.vWall, edge = (a, b) => (base[a] && V.open[b]) || (base[b] && V.open[a]);
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) { const k = j * X + i, c = j * W + i; uWall[k] = !uFixed[k] ? 0 : (i > 0 && V.liquid[c - 1]) || (i < W && V.liquid[c]) ? L.u[k] : lu && i > 0 && i < W && edge(c - 1, c) ? lu[k] : 0; }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) { const k = j * W + i; vWall[k] = !vFixed[k] ? 0 : (j > 0 && V.liquid[k - W]) || (j < H && V.liquid[k]) ? L.v[k] : lv && j > 0 && j < H && edge(k - W, k) ? lv[k] : 0; }
  // Solid cells read as their own temperature (the liquid's, an obstacle's or the air's) and hold no vapour.
  for (let c = 0; c < N; c++) if (g.solid[c]) { m[c] = 0; T[c] = base[c] ? (obstacleT[c] === obstacleT[c] ? obstacleT[c] : h.ambient) : Tc[c]; }
  stepGas(V, s, dt, {
    forces() {
      const [gx, gy] = effect.gravity, pull = Math.sqrt(gx * gx + gy * gy), ux = pull ? -gx / pull : 0, uy = pull ? -gy / pull : 0;
      const lift = (a, b) => s.buoyancy * ((T[a] + T[b]) * 0.5 - h.ambient) - s.weight * (m[a] + m[b]) * 0.5 * scale;
      if ((s.buoyancy || s.weight) && uy) for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) { const k = j * W + i; v[k] += dt * uy * lift(k - W, k); }
      if ((s.buoyancy || s.weight) && ux) for (let j = 0; j < H; j++) for (let i = 1; i < W; i++) { const c = j * W + i; u[j * X + i] += dt * ux * lift(c - 1, c); }
    },
    sources() { V.step.set(V.source); balance(V, g); return V.step; },
    carry() {
      let before = 0, out = 0;
      for (let c = 0; c < N; c++) before += m[c];
      const { walls } = g;
      for (let j = 0; j < H; j++) { if (!walls.left && u[j * X] < 0) out -= m[j * W] * u[j * X] * dt; if (!walls.right && u[j * X + W] > 0) out += m[j * W + W - 1] * u[j * X + W] * dt; }
      for (let i = 0; i < W; i++) { if (!walls.top && v[i] < 0) out -= m[i] * v[i] * dt; if (!walls.bottom && v[H * W + i] > 0) out += m[(H - 1) * W + i] * v[H * W + i] * dt; }
      advectScalars(g, dt, [[m, V.d1], [T, V.T1]], false);
      let after = 0;
      for (let c = 0; c < N; c++) after += V.d1[c];
      const keep = before - out > 0 ? before - out : 0, ratio = after > 0 ? keep / after : 0;
      P.escaped += before - (after > 0 ? keep : 0);
      for (let c = 0; c < N; c++) { m[c] = V.d1[c] * ratio; T[c] = g.solid[c] ? T[c] : V.T1[c]; }
      // Spread: vapour diffuses between open neighbours (pairwise, so none is made or lost).
      if (s.spread) {
        const next = V.d1, rate = s.spread * dt;
        next.set(m);
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const c = j * W + i;
          if (!V.open[c]) continue;
          if (i < W - 1 && V.open[c + 1]) { const f = rate * (m[c] - m[c + 1]); next[c] -= f; next[c + 1] += f; }
          if (j < H - 1 && V.open[c + W]) { const f = rate * (m[c] - m[c + W]); next[c] -= f; next[c + W] += f; }
        }
        m.set(next);
      }
      // The air drifts back toward the room's temperature, and faded vapour leaves the books.
      const cool = 1 - s.cooling * dt, fade = 1 - s.dissipation * dt;
      for (let c = 0; c < N; c++) {
        if (!V.open[c]) continue;
        T[c] = h.ambient + (T[c] - h.ambient) * cool;
        if (s.dissipation) { P.escaped += m[c] * (1 - fade); m[c] *= fade; }
      }
    }
  });
}
// Vapour leaving water or ice: `amount` particles' worth into `cell` (or out through an open edge, -1), at temperature
// t. It fills `expansion` / PER_CELL cells per particle at its own temperature, which it shares with the air in its cell,
// and pushes the air out of its way over this step; boiled into a sealed air pocket, it adds to the pocket's air.
function ventVapour(state, effect, cell, amount, t, dt) {
  const P = state.heat;
  if (cell < 0) { P.escaped += amount; return; }
  const V = P.vapour, scale = effect.vapour.expansion / PER_CELL, W = V.g.W;
  V.T[cell] = (V.T[cell] + scale * amount * t) / (1 + scale * amount); V.d[cell] += amount; V.source[cell] += scale * amount / dt;
  if (state.air) addAir(state, cell % W, Math.floor(cell / W), scale * amount);
}
// A boil bubble that ends hands its vapour on: where it reached the air, to the vapour there (or in the open cell beside
// it); off the canvas, out of the books; anywhere else (its life over, or taken by a solid), back to the water there.
function ventBubble(run, p) {
  const { state, effect } = run, P = state.heat, V = P.vapour, { W, H } = V.g, i = Math.floor(p.x), j = Math.floor(p.y);
  if (p.end === 'edge' || i < 0 || j < 0 || i >= W || j >= H) { P.escaped += p.steam; return; }
  const c = j * W + i, near = p.end === 'air' ? [c, j > 0 ? c - W : -1, i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1].find(e => e >= 0 && V.open[e]) : undefined;
  if (near !== undefined) ventVapour(state, effect, near, p.steam, P.heat.boil, 1 / effect.substeps);
  else if (!P.base[c]) P.pending[c] += p.steam;
  else P.escaped += p.steam;
}
// What happens to a bubble that ends: a boil bubble lets its vapour out (ventBubble), and with air pockets any other one
// gives its air to the pocket it rises into. Null when nothing needs to know.
const endedOf = run => {
  const { state } = run, pockets = state.air ? bubbleEnded(state) : null, steam = state.heat && state.heat.vapour;
  if (!pockets && !steam) return null;
  return p => { if (p.steam && steam) ventBubble(run, p); else if (pockets) pockets(p); };
};
// Electricity over a liquid (stage 3 of physics-model.md section 11, before heat): the electric layer solves through the
// air, the vapour's gas, whose flow carries the plasma and whose temperature its current heats, and through the water and
// ice, cells holding ICE_CELL particles or more, as they stood after the last step. The Joule heat of the water's and ice's
// cells goes into every particle there through `input`, so an arc that strikes the water boils it where it lands.
function electricStep(state, effect, dt) {
  const P = state.heat, E = state.electric, { N } = state.g, { water, ice, input } = P, base = P.base, matter = P.matter ??= new Uint8Array(N);
  for (let c = 0; c < N; c++) matter[c] = base[c] || water[c] + ice[c] < ICE_CELL ? 0 : ice[c] >= ICE_CELL ? MATTER.ice : MATTER.water;
  input.fill(0);
  stepElectric(E, P.vapour, effect, dt, { matter, warm: (c, heat) => { input[c] += heat; } });
}
// Each step, before the liquid moves (physics-model.md, section 11): heat flows, particles change phase, vapour condenses
// or deposits, and the solid layer follows; on a frame's first step, unheld ice settles. Rates are per frame, scaled by
// the step. `effect` carries this frame's keyed settings (gravity).
function heatStep(run, effect, dt, first) {
  const { state } = run, P = state.heat, h = P.heat, g = state.g, { W, H, N, walls } = g, { base, water, ice, Tc, obstacleT, flux } = P, V = P.vapour;
  const { energy, frozen } = state, seed = effect.seed, step = P.step++;
  surfaceTemperatures(state.solids, obstacleT);
  tally(state);
  forgetFrost(P);
  // Heat flows (each coefficient at most 0.2 a frame, so no particle overshoots its neighbours).
  const closedAt = (x, y) => (x < 0 ? walls.left : x >= W ? walls.right : y < 0 ? walls.top : walls.bottom);
  flux.fill(0);
  for (let k = 0; k < state.n; k++) {
    const i = Math.floor(state.x[k]), j = Math.floor(state.y[k]), c = j * W + i, t = tempOf(h, energy[k], frozen[k]);
    // `input` is heat another stage puts into the water and ice of a cell, per frame (zero until one does: Joule heat
    // from an arc that reaches the water is the plan, physics-model.md section 10).
    let gain = h.conduct * (Tc[c] - t) + P.input[c];
    // A particle in the open corner of a smooth obstacle's pixel touches that obstacle.
    if (base[c] && obstacleT[c] === obstacleT[c]) gain += h.contact * (obstacleT[c] - t);
    for (const [di, dj] of SIDES) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= W || y >= H) { if (!closedAt(x, y)) gain += h.air * (h.ambient - t); continue; }
      const n = y * W + x;
      if (base[n]) { if (obstacleT[n] === obstacleT[n]) gain += h.contact * (obstacleT[n] - t); } else if (water[n] + ice[n]) gain += h.conduct * (Tc[n] - t);
      else { const q = h.air * ((V ? V.T[n] : h.ambient) - t); gain += q; flux[n] -= q; }
    }
    energy[k] += gain * dt;
  }
  // The air takes the heat the surface gave it, and hot or cold obstacles warm or chill the air beside them.
  if (V) { for (let c = 0; c < N; c++) if (V.open[c]) V.T[c] += flux[c] * dt; warmAir(V.T, V.open, obstacleT, W, H, h.contact * dt); }
  // Where vapour leaves a particle: the open cell above it (against gravity), beside it or below it, or its own.
  const [gx, gy] = effect.gravity, vertical = Math.abs(gy) >= Math.abs(gx), up = vertical ? [0, gy > 0 ? -1 : 1] : [gx > 0 ? -1 : 1, 0];
  const order = [up, [up[1], up[0]], [-up[1], -up[0]], [-up[0], -up[1]]];
  const airAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? !closedAt(x, y) : !base[y * W + x] && water[y * W + x] + ice[y * W + x] < ICE_CELL);
  const surface = (i, j) => water[j * W + i] + ice[j * W + i] < ICE_CELL || airAt(i - 1, j) || airAt(i + 1, j) || airAt(i, j - 1) || airAt(i, j + 1);
  const vent = (i, j) => {
    for (const [di, dj] of order) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= W || y >= H) { if (!closedAt(x, y)) return -1; continue; }
      if (V.open[y * W + x]) return y * W + x;
    }
    return V.open[j * W + i] ? j * W + i : -2;
  };
  if (V) V.source.fill(0);
  P.converting = true;
  const top = h.boil + h.latent + h.vaporize, dry = h.freeze + h.latent + h.vaporize, bubbles = V && effect.vapour.bubbles;
  for (let k = state.n - 1; k >= 0; k--) {
    const e = energy[k], i = Math.floor(state.x[k]), j = Math.floor(state.y[k]);
    if (frozen[k]) {
      if (!h.sublimate) { if (e >= h.freeze + h.latent) { frozen[k] = 0; state.fall[k] = 0; } continue; }
      // Sublimating ice waits at its freezing point for the heat of melting and boiling both, then leaves its surface.
      if (e < dry) continue;
      const to = surface(i, j) ? vent(i, j) : -2;
      if (to === -2) { energy[k] = dry; continue; }
      removeParticle(state, k); ventVapour(state, effect, to, 1, h.freeze, dt);
      continue;
    }
    // Water below its freezing point (less a seeded share of `grain` for this particle, so a front grows ragged) freezes
    // where it touches ice or an obstacle colder than freezing, or anywhere once it is SUPERCOOL below: ice needs a seed.
    // Water chilled from above stays liquid until the ice creeping from a cold shore reaches it, a cell a step.
    if (e < h.freeze - (h.grain ? 0.25 * h.grain * random(seed, PHASE, state.id[k], PHASE_SALT.grain) : 0)) {
      const c = j * W + i, seeded = (x, y) => x >= 0 && y >= 0 && x < W && y < H && (ice[y * W + x] > 0 || (base[y * W + x] && obstacleT[y * W + x] < h.freeze));
      if (ice[c] || e < h.freeze - SUPERCOOL || (base[c] && obstacleT[c] < h.freeze) || seeded(i - 1, j) || seeded(i + 1, j) || seeded(i, j - 1) || seeded(i, j + 1)) { frozen[k] = 1; state.vx[k] = 0; state.vy[k] = 0; continue; }
    }
    if (!V) { if (e > top) energy[k] = top; continue; }
    // Each particle boils after its own seeded share of `vaporize` (half to all of it, and half again), so a pot heated
    // evenly from below bubbles steadily instead of in bursts.
    const t = tempOf(h, e, 0), mine = h.boil + h.latent + h.vaporize * (0.5 + random(seed, PHASE, state.id[k], PHASE_SALT.boil));
    let boiled = e >= mine;
    if (!boiled && h.evaporation && t > h.freeze) { const share = (t - h.freeze) / (h.boil - h.freeze), chance = h.evaporation * dt * (share < 1 ? share * share : 1); boiled = random(seed, PHASE, step, state.id[k], PHASE_SALT.evaporate) < chance && surface(i, j); }
    if (!boiled) continue;
    if (surface(i, j)) { const to = vent(i, j); if (to !== -2) { removeParticle(state, k); ventVapour(state, effect, to, 1, t, dt); continue; } }
    // Boiled inside the water: a bubble that carries its vapour up and lets it out at the surface (see ventBubble). With
    // no bubbles set, or at the spark limit, the particle waits at the boil until it reaches the surface.
    if (!bubbles || !addBubble(run.sparks, run.totals, bubbles, state.x[k], state.y[k], salt => random(seed, PHASE, step, state.id[k], salt), { steam: 1, born: run.clock })) { if (e > mine) energy[k] = mine; continue; }
    removeParticle(state, k);
  }
  if (V) {
    // Vapour touching something colder than `dew` condenses, a share each frame. Onto water it joins the water a particle
    // at a time; on an obstacle or ice it gathers as dew, drawn as water, until the cell holds a full cell's worth and
    // drips off as a drop. Touching ice or an obstacle colder than `frost` it grows into ice instead, fastest where it
    // touches the ice at one point (the tip of a finger), with seeded grain; a particle's worth becomes an ice particle at
    // a seeded spot. Condensing in a sealed air pocket takes from the pocket's air.
    const spawn = (c, n, t, solid) => {
      const i = c % W, j = (c - i) / W;
      P.spawnFrozen = solid ? 1 : 0; P.spawnEnergy = energyOf(h, t, solid);
      addParticle(state, i + 0.1 + 0.8 * random(seed, PHASE, step, c, n, PHASE_SALT.spawnX), j + 0.1 + 0.8 * random(seed, PHASE, step, c, n, PHASE_SALT.spawnY), 0, 0);
    };
    const scale = effect.vapour.expansion / PER_CELL, m = V.d;
    for (let c = 0; c < N; c++) {
      const i = c % W, j = (c - i) / W;
      // Vapour the liquid closed over (see heatMasks), or a bubble's that ended in the water, joins it.
      if (!V.open[c]) { for (let n = 0; P.pending[c] >= 1 && !base[c]; n++) { P.pending[c] -= 1; spawn(c, n + 16, Tc[c], false); } continue; }
      if (!(m[c] > 0) && !(P.pending[c] >= 1)) continue;
      let coldest = Infinity, firm = Infinity;
      for (const [di, dj] of SIDES) {
        const x = i + di, y = j + dj;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const n = y * W + x;
        if (base[n]) { if (obstacleT[n] < firm) firm = obstacleT[n]; } else if (ice[n] >= ICE_CELL) { if (Tc[n] < firm) firm = Tc[n]; } else if (water[n] + ice[n] >= ICE_CELL && Tc[n] < coldest) coldest = Tc[n];
      }
      if (firm < coldest) coldest = firm;
      // Frost grows as fingers (physics-model.md section 9), off any of the eight neighbours that is frost or a solid
      // colder than `frost`, into air below freezing. Each frost cell keeps the direction it grew in (`frostDir`), its
      // generation (`frostGen`: a stem, a branch, a twig) and its length along its finger (`frostLen`). Vapour turns to
      // frost in the cell straight ahead of a finger's tip, as readily as its generation's REACH, or, by a seeded draw
      // (`branch`, a third as often off a branch, never off a twig, and only off every other cell), in one 45 degrees to
      // its side: a branch of the next generation that grows straight on its own way. Never beside or behind a tip, so a
      // finger stays a pixel wide and forks like a fern, its branches shorter than its stem and a pixel apart. A cell
      // touching frost of another finger takes none, so fingers stop short of each other; a frost cell thickens slowly
      // into solid ice; ice with no direction (a cube) frosts over slowly every way. The vapour diffusing to the tips feeds
      // them, so they reach out into the humid air.
      let weight = 0, rime = firm, gone = 0, from = -1, best = 0, frosty = 0, walls = 0, ox = 0, oy = 0, gen = 0, parent = -1, wall = -1, length = 0, near = false;
      if (h.frost !== null && V.T[c] < h.freeze) {
        const dirs = P.frostDir ??= new Int8Array(N).fill(-1), gens = P.frostGen ??= new Uint8Array(N), lens = P.frostLen ??= new Uint8Array(N), touched = P.touched ??= new Int32Array(8);
        P.frostIce ??= new Uint8Array(N);
        for (let k = 0; k < 8; k++) {
          const x = i + COMPASS[k][0], y = j + COMPASS[k][1];
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const n = y * W + x, cold = base[n] ? obstacleT[n] : ice[n] ? Tc[n] : Infinity;
          if (ice[n] || cold < h.frost) near = true;
          if (!(cold < h.frost)) continue;
          if (cold < rime) rime = cold;
          // The step from that neighbour to this cell, as a direction.
          const step = (k + 4) % 8;
          if (base[n]) { walls++; wall = n; ox += COMPASS[step][0]; oy += COMPASS[step][1]; continue; }
          touched[frosty++] = n;
          const d = dirs[n], turn = d < 0 ? -1 : Math.min((step - d + 8) % 8, (d - step + 8) % 8), at = gens[n];
          // A branch sprouts only off every other cell of a finger (its length from where it started is odd), so side
          // branches lie a pixel apart instead of merging into a band.
          const w = d < 0 ? ROUND : turn === 0 ? REACH[at < 2 ? at : 2] : turn === 1 && at < 2 && lens[n] % 2 === 1 && random(seed, PHASE, n, step, PHASE_SALT.branch) < h.branch * (at ? 0.3 : 1) ? REACH[at + 1] : 0;
          weight += w;
          if (w > best) { best = w; from = step; gen = turn === 1 ? at + 1 : at; parent = n; length = turn === 1 ? 0 : (lens[n] + 1) & 255; }
        }
        // A finger starts off a cold obstacle at seeded sites: SITES of the open cells beside a flat side (each touches three
        // of the obstacle's cells) and nine times as many in a corner, where the cold is on two sides (it touches five).
        // Elsewhere along a bare stretch of cold surface (no frost within SPACING pixels) one starts by a seeded draw each
        // step, NUCLEI a frame beside a flat side, so every cold surface frosts in time. A finger grows straight out from
        // the surface, or out of a corner along its diagonal, leaning a step either way by a seeded draw off a flat side:
        // corners first, fingers apart, instead of a rim.
        const bare = () => { for (let y = j - SPACING; y <= j + SPACING; y++) for (let x = i - SPACING; x <= i + SPACING; x++) if (x >= 0 && y >= 0 && x < W && y < H && ice[y * W + x]) return false; return true; };
        const site = (walls - 2) * (walls - 2);
        if (walls > 2 && !frosty && (random(seed, PHASE, c, PHASE_SALT.site) < SITES * site || (random(seed, PHASE, step, c, PHASE_SALT.nucleus) < NUCLEI * dt * site && bare()))) {
          let out = COMPASS.findIndex(([x, y]) => x === Math.sign(ox) && y === Math.sign(oy));
          if (out >= 0 && walls <= 3) out = (out + 8 + Math.floor(3 * random(seed, PHASE, c, PHASE_SALT.lean)) - 1) % 8;
          if (out >= 0) { weight += 1; best = 1; from = out; gen = 0; parent = wall; length = 0; }
        }
        // A cell that has started taking frost, and has not a particle of it yet, goes on as it started, while frost or a
        // cold solid is beside it (never in mid-air).
        if (!ice[c] && dirs[c] >= 0 && near && REACH[gens[c] < 2 ? gens[c] : 2] > best) { best = REACH[gens[c] < 2 ? gens[c] : 2]; weight = best; from = dirs[c]; gen = gens[c]; length = lens[c]; parent = -1; }
        // A cell touching frost of another finger (any not beside the one it grows from) takes none, so fingers stop short
        // of each other.
        const px = parent % W, py = (parent - px) / W, other = n => n !== parent && (base[parent] || Math.abs(n % W - px) > 1 || Math.abs((n - n % W) / W - py) > 1);
        if (ice[c]) weight = THICKEN;
        else if (parent >= 0) for (let k = 0; k < frosty; k++) if (other(touched[k])) { weight = 0; break; }
        if (weight > 1) weight = 1;
      }
      if (weight) {
        const grain = h.grain ? 1 - h.grain + 2 * h.grain * random(seed, PHASE, c, PHASE_SALT.frost) : 1;
        gone = Math.min(m[c], h.deposit * dt * m[c] * weight * grain);
        firm = rime;
        P.frost[c] += gone;
        if (!ice[c] && from >= 0) { P.frostDir[c] = from; P.frostGen[c] = gen; P.frostLen[c] = length; }
      } else if (!h.sublimate && coldest < h.dew && !(h.frost !== null && rime < h.frost)) {
        // (Vapour beside a surface cold enough to frost waits for a finger to reach it rather than beading as dew.)
        gone = h.condense * dt * m[c];
        P.pending[c] += gone;
      }
      if (gone) { m[c] -= gone; V.source[c] -= gone * scale / dt; if (state.air) addAir(state, i, j, -gone * scale); }
      for (let n = 0; P.frost[c] >= 1; n++) { P.frost[c] -= 1; spawn(c, n, firm < h.freeze ? firm : h.freeze, true); }
      const t = coldest < h.dew ? coldest : h.dew;
      if (firm < h.dew) { if (P.pending[c] >= PER_CELL) { P.pending[c] -= PER_CELL; P.spawnFrozen = 0; P.spawnEnergy = energyOf(h, t, false); seedCell(state, i, j, PER_CELL, 0, [0, 0], [seed, PHASE, step, c]); } } else for (let n = 0; P.pending[c] >= 1; n++) { P.pending[c] -= 1; spawn(c, n + 8, t, false); }
    }
  }
  P.converting = false;
  if (first) { tally(state); settleIce(state, effect); }
  tally(state);
  heatMasks(state, effect);
}
// Ice that touches no obstacle (nor a closed edge) and has nothing under it falls as one piece, a whole number of pixels a
// frame, speeding up with gravity; obstacles, other ice and water flanking most of it hold it up (ice floats), and water
// in the cells it falls into is pushed aside along the row. So an ice cube whose underside melts settles into its puddle
// instead of hanging over it. While it moves, its cells carry its speed in the solid layer, so what clings to it moves
// with it. Pieces are the 4-connected cells holding any ice, and frost joins them across corners too: a finger grows at 45
// degrees, its cells touching only at a corner, and it is one piece with the frost it grew from (taken four ways, its
// branches broke off and fell). Gravity along y only.
const DIAGONALS = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
function settleIce(state, effect) {
  const P = state.heat, g = state.g, { W, H, N, walls } = g, { base, water, ice, iceSpeed } = P, [gx, gy] = effect.gravity, dirs = P.frostDir;
  const was = P.iceMoving;
  P.iceMoving = false;
  if (was) iceSpeed.fill(0);
  if (!gy || Math.abs(gx) > Math.abs(gy)) return;
  const dir = gy > 0 ? 1 : -1, pull = Math.abs(gy);
  if (!P.piece) { P.piece = new Int32Array(N); P.cover = new Uint8Array(N); }
  const { piece, cover } = P, pieces = [], stack = [];
  piece.fill(-1);
  for (let c = 0; c < N; c++) {
    if (!ice[c] || piece[c] >= 0) continue;
    const id = pieces.length, cells = [];
    let held = false;
    piece[c] = id; stack.push(c);
    while (stack.length) {
      const d = stack.pop(), i = d % W, j = (d - i) / W;
      cells.push(d);
      for (const [di, dj] of SIDES) {
        const x = i + di, y = j + dj;
        if (x < 0 || y < 0 || x >= W || y >= H) { if (x < 0 ? walls.left : x >= W ? walls.right : y < 0 ? walls.top : walls.bottom) held = true; continue; }
        const e = y * W + x;
        if (base[e]) held = true; else if (ice[e] && piece[e] < 0) { piece[e] = id; stack.push(e); }
      }
      if (dirs) for (const [di, dj] of DIAGONALS) {
        const x = i + di, y = j + dj, e = y * W + x;
        if (x >= 0 && y >= 0 && x < W && y < H && ice[e] && piece[e] < 0 && (dirs[d] >= 0 || dirs[e] >= 0)) { piece[e] = id; stack.push(e); }
      }
    }
    pieces.push({ cells, held, speed: 0 });
  }
  if (pieces.every(p => p.held)) return;
  for (let k = 0; k < state.n; k++) if (state.frozen[k]) { const p = pieces[piece[Math.floor(state.y[k]) * W + Math.floor(state.x[k])]]; if (p && state.fall[k] > p.speed) p.speed = state.fall[k]; }
  pieces.forEach((p, id) => {
    if (p.held) return;
    const speed = p.speed + pull, want = Math.max(1, Math.floor(speed + 0.5));
    // It floats where water lies beside it along rows holding most of its cells: then water under it holds it up.
    let wet = 0;
    for (const c of p.cells) {
      const i = c % W, j = (c - i) / W, beside = x => x >= 0 && x < W && piece[j * W + x] !== id && water[j * W + x] >= ICE_CELL;
      let l = i, r = i;
      while (l > 0 && piece[j * W + l - 1] === id) l--;
      while (r < W - 1 && piece[j * W + r + 1] === id) r++;
      if (beside(l - 1) || beside(r + 1)) wet++;
    }
    const floats = wet >= 0.85 * p.cells.length;
    // How far it may fall: every cell's destination is in it already or open, empty of other ice (and of water, afloat).
    const free = d => p.cells.every(c => {
      const i = c % W, j = (c - i) / W + dir * d;
      if (j < 0 || j >= H) return false;
      const e = j * W + i;
      return piece[e] === id || (!base[e] && !ice[e] && (!floats || water[e] < ICE_CELL));
    });
    let d = 0;
    while (d < want && free(d + 1)) d++;
    p.move = d; p.speed = d ? speed : 0;
  });
  cover.fill(0);
  pieces.forEach(p => { if (p.move) for (const c of p.cells) { cover[c + dir * p.move * W] = 1; iceSpeed[c + dir * p.move * W] = dir * p.move; P.iceMoving = true; } });
  // Frost that settles keeps its fingers: each cell's direction, generation and length move with it.
  if (dirs) pieces.forEach(p => {
    if (!p.move) return;
    const shift = dir * p.move * W, kept = p.cells.map(c => [dirs[c], P.frostGen[c], P.frostLen[c], P.frostIce[c]]);
    for (const c of p.cells) { dirs[c] = -1; P.frostGen[c] = 0; P.frostLen[c] = 0; P.frostIce[c] = 0; }
    p.cells.forEach((c, k) => { const e = c + shift; [dirs[e], P.frostGen[e], P.frostLen[e], P.frostIce[e]] = kept[k]; });
  });
  for (let k = 0; k < state.n; k++) {
    if (!state.frozen[k]) continue;
    const p = pieces[piece[Math.floor(state.y[k]) * W + Math.floor(state.x[k])]];
    if (!p || p.held) { state.fall[k] = 0; continue; }
    state.fall[k] = p.speed;
    if (p.move) state.y[k] += dir * p.move;
  }
  // Water in a cell a piece now covers moves along its row to the nearest cell that no ice or obstacle holds.
  for (let k = 0; k < state.n; k++) {
    if (state.frozen[k]) continue;
    const i = Math.floor(state.x[k]), j = Math.floor(state.y[k]);
    if (!cover[j * W + i]) continue;
    for (let step = 1; step < W; step++) {
      const l = i - step, r = i + step, open = x => x >= 0 && x < W && !cover[j * W + x] && !base[j * W + x] && !ice[j * W + x];
      if (open(l)) { state.x[k] += l - i; break; }
      if (open(r)) { state.x[k] += r - i; break; }
    }
  }
}
// The ledger (physics-model.md, section 4), in cells' worth: water (dew included), ice (frost not yet a particle
// included), vapour (in the air and in boil bubbles), and since the first frame what emitters added and what drains, open
// edges and fading took. Water + ice + vapour + taken − added stays what the fills held.
function heatAmounts(run) {
  const { state } = run, P = state.heat, V = P.vapour;
  let water = 0, ice = 0, vapour = 0;
  for (const p of run.sparks) if (p.steam) vapour += p.steam;
  for (let k = 0; k < state.n; k++) if (state.frozen[k]) ice++; else water++;
  for (let c = 0; c < state.g.N; c++) { water += P.pending[c]; ice += P.frost[c]; vapour += V ? V.d[c] : 0; }
  return { water: hundredth(water / PER_CELL), ice: hundredth(ice / PER_CELL), vapour: hundredth(vapour / PER_CELL), added: hundredth(P.added / PER_CELL), taken: hundredth((P.removed + P.escaped) / PER_CELL) };
}
// The ice and vapour fields the looks read, after liquidFields: ice is drawn cell by cell (crisp), vapour as a gas.
function heatFields(run) {
  const { state } = run, P = state.heat, { N } = state.g, [density, temperature] = run.base, [iceD, iceT] = run.iceBase, V = P.vapour;
  for (let c = 0; c < N; c++) {
    iceD[c] = P.ice[c] / PER_CELL; iceT[c] = P.ice[c] ? P.Tc[c] : 0;
    temperature[c] = P.water[c] ? P.Tc[c] : 0;
    // Dew is drawn as water from a particle's worth in a cell, crisp, as a bead.
    if (P.pending[c]) density[c] += P.pending[c] / ICE_CELL;
  }
  if (!V) return;
  const [vd, vt, vs] = run.vapourBase, scale = run.effect.vapour.expansion / PER_CELL, { W, u, v } = V.g;
  for (let c = 0; c < N; c++) {
    const i = c % W, j = (c - i) / W, x = (u[j * (W + 1) + i] + u[j * (W + 1) + i + 1]) * 0.5, y = (v[c] + v[c + W]) * 0.5;
    vd[c] = V.open[c] ? V.d[c] * scale : 0; vt[c] = V.open[c] ? V.T[c] : 0; vs[c] = Math.sqrt(x * x + y * y);
  }
  // Plasma burns in the air, so the vapour's look draws it.
  if (state.electric) electricFields(state.electric, V, run.vapourBase[4], run.vapourBase[5]);
}
// A frame of a liquid with heat: vapour first, the water over it, then the ice, each through its own look, and the
// outline round the water and ice.
function renderHeat(run, width, height, drawn = null) {
  const { view, state } = run, P = state.heat, N = width * height, V = P.vapour, plain = { strays: false, corners: false };
  const iced = new Uint8Array(N);
  for (let c = 0; c < N; c++) iced[c] = view.solid[c] || P.ice[c] >= ICE_CELL ? 1 : 0;
  const chars = renderFields({ ...view, solid: iced, outline: 0 }, run.base, width, height);
  const frost = renderFields({ ...view, liquid: false, look: view.iceLook ?? view.look, outline: 0, cleanup: plain }, run.iceBase, width, height);
  for (let c = 0; c < N; c++) if (frost[c]) chars[c] = frost[c];
  const body = Uint16Array.from(chars);
  if (V && view.vapour.look.length) {
    const steam = renderFields({ ...view, liquid: false, look: view.vapour.look, solid: V.g.solid, outline: 0, cleanup: plain }, run.vapourBase, width, height);
    for (let c = 0; c < N; c++) if (!chars[c] && steam[c]) chars[c] = steam[c];
  }
  if (drawn) for (let c = 0; c < N; c++) drawn[c] = chars[c] ? 1 : 0;
  if (view.outline) for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const c = j * width + i;
    if (body[c] || view.front[c] || view.solid[c]) continue;
    if ((i > 0 && body[c - 1]) || (i < width - 1 && body[c + 1]) || (j > 0 && body[c - width]) || (j < height - 1 && body[c + width])) chars[c] = view.outline;
  }
  return chars;
}

// ---- Sparks -----------------------------------------------------------------------------------------------------------
// Single pixels carried by the flow: embers, sparkles, debris, bubbles. A looping effect spawns them during the
// recorded cycle only (bubbles that push the water from its warm-up on, see pushesWater) and draws the part of a life that
// runs past the end at the start, so they loop exactly. `born`, in a loop, is the frame such a bubble is born on.
function spawnSparks(list, e, index, cycle, here, seed, total, born) {
  // The count follows the emitter's pulse and flicker, rounded up or down by a seeded draw.
  const s = e.sparks, n = Math.floor(s.count * here.flicker(here.x, here.y) / e.strength + random(seed, index, cycle, SALT.sparks));
  for (let k = 0; k < n; k++) {
    if (total.alive >= LIMITS.sparks) return false;
    const r = salt => random(seed, index, cycle, k, salt);
    let x = here.x, y = here.y;
    if (e.radius !== null) { const d = e.radius * Math.sqrt(r(SALT.sparkX)), a = 360 * r(SALT.sparkY); x += d * cosDeg(a); y += d * sinDeg(a); }
    else { x += (r(SALT.sparkX) - 0.5) * e.area[0]; y += (r(SALT.sparkY) - 0.5) * e.area[1]; }
    const angle = pick(s.angle, r(SALT.angle)), speed = pick(s.speed, r(SALT.speed));
    list.push({ s, x, y, vx: cosDeg(angle) * speed, vy: sinDeg(angle) * speed, age: 0, life: pickWhole(s.life, r(SALT.life)), ...(s.rise !== null && bubbleOf(s, r)), ...(s.rise !== null && born !== undefined && { born }) });
    total.alive++; total.spawned++;
  }
  return true;
}
// In a liquid, spray (sparks that ignore the flow) that has left the water ends where it falls back in, and a bubble
// that leaves it pops: it is drawn as a ring for one frame and as two droplets the next.
const sparkColor = p => p.s.colors[Math.min(p.s.colors.length - 1, Math.floor(p.age * p.s.colors.length / p.life))].charCodeAt(0);
// `gravity` is a liquid's gravity this frame (keys change it), which whitewater and droplets without their own follow.
function moveSparks(list, g, density, total, liquid, pops, gravity, ended = null, gather = null) {
  const { W, H, u, v, pixels: solid } = g;
  let waiting = false;
  for (let k = list.length - 1; k >= 0; k--) {
    const p = list[k], s = p.s;
    p.age++;
    let fx = s.follow ? sampleU(g, u, p.x, p.y) * s.follow : 0, fy = s.follow ? sampleV(g, v, p.x, p.y) * s.follow : 0;
    if (s.rise !== null) {
      if (moveBubble(p, g, density, gravity, fx, fy, pops)) waiting ||= p.under; else { if (ended) ended(p); list.splice(k, 1); total.alive--; }
      continue;
    }
    // A liquid's grid holds no flow out in the air (no air is simulated), so a spark riding it would hang where it left
    // the water. Once out, an emitter's spark keeps the flow's velocity as its own and flies on as a droplet: it falls,
    // and ends where it falls back in, as spray does.
    if (s.fling && s.follow && !p.flung) {
      const ci = Math.floor(p.x), cj = Math.floor(p.y);
      // Out means no water at all here, not merely too little to draw: a thin, fast stream still carries its foam.
      if (ci >= 0 && cj >= 0 && ci < W && cj < H && !(density[cj * W + ci] > 0)) { p.vx += fx; p.vy += fy; p.flung = true; p.out = true; }
    }
    if (p.flung) { fx = 0; fy = 0; }
    const fall = gravity && s.inherit && (p.flung || !s.fling) ? gravity : s.gravity;
    p.vx = (p.vx + fall[0]) * (1 - s.drag); p.vy = (p.vy + fall[1]) * (1 - s.drag);
    p.px = p.x; p.py = p.y; p.x += fx + p.vx; p.y += fy + p.vy;
    const i = Math.floor(p.x), j = Math.floor(p.y), inside = i >= 0 && j >= 0 && i < W && j < H, wet = liquid && inside && density[j * W + i] >= LEVEL;
    // A spark that meets an obstacle anywhere along this frame's path ends there, not only one that lands inside it.
    const finite = Number.isFinite(p.x + p.y), hit = finite && crossesSolid(solid, W, H, p.px, p.py, p.x, p.y);
    const popped = s.pop && !wet && finite && !hit;
    // Whitewater foam rides the surface: it ends once the flow has carried it under, with water on every side, or once
    // it is lifted off into the air, with no water beside it.
    const dry = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !solid[y * W + x] && density[y * W + x] < LEVEL;
    const soaked = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !solid[y * W + x] && density[y * W + x] >= LEVEL;
    const sunk = p.foam && (wet ? !dry(i - 1, j) && !dry(i + 1, j) && !dry(i, j - 1) && !dry(i, j + 1) : !soaked(i - 1, j) && !soaked(i + 1, j) && !soaked(i, j - 1) && !soaked(i, j + 1));
    if (popped) pops.push({ x: p.x, y: p.y, size: s.size, code: sparkColor(p), age: 0 });
    // Spray still in the air when its life runs out flies on, for up to its life again, until it falls back in, hits
    // something or leaves the canvas, so a droplet never vanishes in mid-air.
    const spent = p.age >= (liquid && !s.follow && p.out && !wet ? 2 * p.life : p.life);
    if (spent || !finite || hit || popped || (wet && p.out) || sunk || p.x < -16 || p.y < -16 || p.x > W + 16 || p.y > H + 16) { list.splice(k, 1); total.alive--; }
    else if (liquid && inside && !wet && !s.follow) p.out = true;
  }
  if (waiting) mergeBubbles(list, g, total, gather);
}

// ---- Bubbles ----------------------------------------------------------------------------------------------------------
// A bubble's state: how much air it holds (in square pixels, so its size is the square root, 1 to 3 pixels across) and
// where its sway starts.
function bubbleOf(s, r) {
  return { vol: s.size * s.size, size: s.size, phase: s.wobble ? 360 * r(SALT.wobble) : 0, under: false };
}
// Makes a bubble at (x, y), at rest in the water, in `list` (a run's sparks, counted in `total`, its totals): `s` are its
// settings (as readSparks reads them, with rise), `r` a seeded draw for its life and sway, and `extra` fields of the
// caller's own, such as another amount of air (`vol` and `size`) or a boil's vapour. Every stage that makes bubbles goes
// through it. Returns false, adding nothing, at the spark limit. When a bubble ends, moveSparks hands it to its `ended`
// hook with `end` set: 'air' where it reached the air (above water, or in a pocket), 'life', 'solid' or 'edge'.
function addBubble(list, total, s, x, y, r, extra = null) {
  if (total.alive >= LIMITS.sparks) return false;
  list.push({ s, x, y, vx: 0, vy: 0, age: 0, life: pickWhole(s.life, r(SALT.life)), ...bubbleOf(s, r), ...extra });
  total.alive++; total.spawned++;
  return true;
}
// How far along a ceiling a bubble looks for a way up, in pixels, and how many degrees its sway turns each frame (a sway
// every eight frames).
const BUBBLE_REACH = 5, SWAY = 45;
const bubbleSize = vol => Math.min(3, Math.floor(Math.sqrt(vol) + 0.5));
// Whether a bubble of `size` centred at (x, y) lies in open cells: no obstacle pixel under it, and nothing past a closed edge.
function bubbleFits(g, x, y, size) {
  const { W, H, pixels: solid, walls } = g, half = (size - 1) / 2, x0 = Math.floor(x - half), y0 = Math.floor(y - half);
  for (let j = y0; j < y0 + size; j++) for (let i = x0; i < x0 + size; i++) {
    if (i < 0 ? walls.left : i >= W ? walls.right : j < 0 ? walls.top : j >= H ? walls.bottom : solid[j * W + i]) return false;
  }
  return true;
}
// Air in the water. A bubble rises against the liquid's gravity at `rise` pixels per frame relative to the water, so it
// rises steadily through still water and the currents carry it (`follow`); what is left of its launch speed fades by
// `drag`, and `wobble` sways it from side to side. It never enters an obstacle or a closed edge: it keeps the part of its
// move that is free, sliding along whatever stops it, and under a ceiling it slides toward the nearest way up within
// BUBBLE_REACH pixels (up a slope, out from under a ledge) or waits there, where bubbles that touch merge. It ends where it
// reaches the air (bursting, with `pop`), at the end of its life, or off the canvas. Returns whether it lives on.
function moveBubble(p, g, density, gravity, fx, fy, pops) {
  const s = p.s, { W, H, pixels: solid } = g, ci = Math.floor(p.x), cj = Math.floor(p.y);
  const gx = gravity ? gravity[0] : 0, gy = gravity ? gravity[1] : 0, pull = Math.sqrt(gx * gx + gy * gy), ux = pull ? -gx / pull : 0, uy = pull ? -gy / pull : 0;
  // A solid that has moved onto it (a ledge coming down, drifting ice) pushes it out to the nearest open spot below or
  // beside it, within two pixels; with none, or where it was born inside one, the solid takes it.
  if (ci >= 0 && cj >= 0 && ci < W && cj < H && solid[cj * W + ci]) {
    const vertical = Math.abs(uy) >= Math.abs(ux), [bx, by] = vertical ? [0, -Math.sign(uy)] : [-Math.sign(ux), 0], [sx, sy] = vertical ? [1, 0] : [0, 1];
    let out = null;
    for (let d = 1; d <= 2 && !out && p.age > 1; d++) for (const [ox, oy] of [[bx * d, by * d], [sx * d, sy * d], [-sx * d, -sy * d]]) {
      if (!bubbleFits(g, p.x + ox, p.y + oy, p.size)) continue;
      out = [ox, oy];
      break;
    }
    if (!out) { p.end = 'solid'; return false; }
    p.x += out[0]; p.y += out[1];
  }
  const x = p.x, y = p.y;
  p.vx = (p.vx + s.gravity[0]) * (1 - s.drag); p.vy = (p.vy + s.gravity[1]) * (1 - s.drag);
  const sway = s.wobble ? s.wobble * (sinDeg(p.phase + SWAY * p.age) - sinDeg(p.phase + SWAY * (p.age - 1))) : 0;
  const size = p.size, clear = (x0, y0, x1, y1) => bubbleFits(g, x1, y1, size) && !crossesSolid(solid, W, H, x0, y0, x1, y1);
  let nx = x + fx + p.vx + s.rise * ux - sway * uy, ny = y + fy + p.vy + s.rise * uy + sway * ux;
  p.px = x; p.py = y;
  if (!Number.isFinite(nx + ny)) { p.end = 'edge'; return false; }
  if (!clear(x, y, nx, ny)) {
    if (clear(x, y, nx, y)) { ny = y; p.vy = 0; } else if (clear(x, y, x, ny)) { nx = x; p.vx = 0; } else { nx = x; ny = y; p.vx = 0; p.vy = 0; }
  }
  // Up is the axis nearest against gravity; across is the other one.
  const vertical = Math.abs(uy) >= Math.abs(ux), ax = vertical ? 0 : Math.sign(ux), ay = vertical ? Math.sign(uy) : 0, bx = vertical ? 1 : 0, by = vertical ? 0 : 1;
  p.under = s.rise > 0 && pull > 0 && !bubbleFits(g, nx + ax, ny + ay, size);
  if (p.under) {
    // The nearest place along the ceiling, within reach along a free path, where the way up is open: the higher side of a
    // slope, or the edge of a ledge. Where both sides are as near, the side of its cell the bubble is on.
    let best = 0;
    for (let d = 1; d <= BUBBLE_REACH && !best; d++) {
      const open = side => clear(nx, ny, nx + side * d * bx, ny + side * d * by) && bubbleFits(g, nx + side * d * bx + ax, ny + side * d * by + ay, size);
      const left = open(-1), right = open(1);
      if (left && right) best = (vertical ? nx - Math.floor(nx) : ny - Math.floor(ny)) < 0.5 ? -d : d;
      else if (left) best = -d;
      else if (right) best = d;
    }
    if (best) {
      const step = Math.min(Math.abs(best), s.rise) * Math.sign(best), tx = nx + step * bx, ty = ny + step * by;
      if (clear(nx, ny, tx, ty)) { nx = tx; ny = ty; }
    }
  }
  p.x = nx; p.y = ny;
  const i = Math.floor(nx), j = Math.floor(ny), inside = i >= 0 && j >= 0 && i < W && j < H, wet = inside && density[j * W + i] >= LEVEL;
  if (p.fresh) p.fresh--;
  else if (!wet) {
    if (s.pop) pops.push({ x: nx, y: ny, size, code: sparkColor(p), age: 0, born: p.born });
    p.end = inside ? 'air' : 'edge';
    return false;
  }
  if (!inside) { p.end = 'edge'; return false; }
  if (p.age >= p.life) { p.end = 'life'; return false; }
  return true;
}
// Bubbles waiting under a ceiling that touch merge into one bubble holding the air of both, as large as that air, where
// their air was on average. A bubble holds at most twelve square pixels of air (it is drawn 3 pixels across from nine), so
// a merge past that waits, as does one that would not fit there. The merged bubble lives as long as the longer-lived of
// the two. With air pockets on, two that touch but cannot merge, holding GATHER square pixels of air or more between them,
// become a pocket instead (`gather`, see gatherOf), and both end: under a flat ceiling no bubble of three pixels fits, so
// bubbles there stop growing at six.
const GATHER = 8;
function mergeBubbles(list, g, total, gather = null) {
  const waiting = list.filter(p => p.under);
  for (let a = 0; a < waiting.length; a++) {
    const p = waiting[a];
    if (p.gone) continue;
    for (let b = a + 1; b < waiting.length; b++) {
      const q = waiting[b];
      if (q.gone) continue;
      const reach = (p.size + q.size) / 2, dx = q.x - p.x, dy = q.y - p.y;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      const vol = p.vol + q.vol, size = bubbleSize(vol), mx = (p.x * p.vol + q.x * q.vol) / vol, my = (p.y * p.vol + q.y * q.vol) / vol;
      const [x, y] = q.s !== p.s || vol > 12 ? [null, null] : bubbleFits(g, mx, my, size) ? [mx, my] : bubbleFits(g, p.x, p.y, size) ? [p.x, p.y] : bubbleFits(g, q.x, q.y, size) ? [q.x, q.y] : [null, null];
      if (x === null) { if (gather && vol >= GATHER && gather(p, q)) { p.gone = q.gone = true; break; } continue; }
      p.vx = (p.vx * p.vol + q.vx * q.vol) / vol; p.vy = (p.vy * p.vol + q.vy * q.vol) / vol;
      if (q.life - q.age > p.life - p.age) { p.age = q.age; p.life = q.life; }
      p.x = x; p.y = y; p.vol = vol; p.size = size; q.gone = true;
      if (q.steam) p.steam = (p.steam ?? 0) + q.steam;
      if (q.vol > p.vol - q.vol && q.born !== undefined) p.born = q.born;
    }
  }
  for (let k = list.length - 1; k >= 0; k--) if (list[k].gone) { list.splice(k, 1); total.alive--; }
}

// Whitewater: each particle at the surface (in the air, or in a cell with air beside it) whose velocity changed by at
// least `impact` this frame throws spray along that change, or one moving at `speed` throws it along its own motion. The
// direction is tipped away from the water (down the density gradient) and turned by up to `spread` degrees, so spray
// leaves a landing outward and up and a stream sideways. Each qualifying particle throws with the layer's chance, a
// seeded draw keyed by the particle, so the same source throws the same droplets. Spray is drawn once it is out. A bubble
// layer (`rise`) picks particles in the body of the water instead, two cells from air every way, and leaves a bubble at
// rest in the water there: air a plunging stream or a landing drop has driven in, which the flow carries and which rises.
// `throws(layer)` says whether a layer throws this frame (a loop's warm-up makes only bubbles that push the water, see
// pushesWater), and `born`, in a loop, tags those bubbles with their frame.
function throwWhitewater(state, effect, density, list, cycle, total, throws = () => true, born = undefined) {
  const { W, H, pixels: solid, geo } = state.g, air = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !solid[j * W + i] && density[j * W + i] < LEVEL;
  const at = (i, j) => (i >= 0 && j >= 0 && i < W && j < H && !solid[j * W + i] ? density[j * W + i] : 0);
  const spray = effect.whitewater.some(w => w.rise === null && throws(w)), bubbles = effect.whitewater.some(w => w.rise !== null && throws(w));
  if (!spray && !bubbles) return true;
  for (let k = 0; k < state.n; k++) {
    const x = state.x[k], y = state.y[k], i = Math.floor(x), j = Math.floor(y);
    // Beside a smooth obstacle a particle may sit in the open corner of a step's pixel; spray starts only from open cells.
    if (geo && solid[j * W + i]) continue;
    const surface = air(i, j) || air(i - 1, j) || air(i + 1, j) || air(i, j - 1) || air(i, j + 1);
    if (surface ? !spray : !bubbles) continue;
    // Bubbles start in a body of water, two cells from air every way, not in a stream a few pixels thick.
    if (!surface && (air(i - 2, j) || air(i + 2, j) || air(i, j - 2) || air(i, j + 2))) continue;
    const vx = state.vx[k], vy = state.vy[k], dx = vx - state.pvx[k], dy = vy - state.pvy[k];
    const nx = at(i - 1, j) - at(i + 1, j), ny = at(i, j - 1) - at(i, j + 1), out = Math.sqrt(nx * nx + ny * ny);
    for (let layer = 0; layer < effect.whitewater.length; layer++) {
      const w = effect.whitewater[layer], [ax, ay] = w.impact !== null ? [dx, dy] : [vx, vy], amount = Math.sqrt(ax * ax + ay * ay);
      if ((w.rise !== null) === surface || amount < (w.impact ?? w.speed) || !throws(w)) continue;
      const r = salt => random(effect.seed, WHITEWATER + layer, cycle, state.id[k], salt);
      if (r(SALT.spawn) >= w.chance) continue;
      if (total.alive >= LIMITS.sparks) return false;
      if (w.rise !== null) {
        addBubble(list, total, w, x, y, r, born !== undefined && pushesWater(effect, w) ? { born } : null);
        continue;
      }
      let ux = ax / amount + (out ? nx / out : 0), uy = ay / amount + (out ? ny / out : 0);
      const tipped = Math.sqrt(ux * ux + uy * uy);
      if (tipped > 1e-6) { ux /= tipped; uy /= tipped; } else { ux = ax / amount; uy = ay / amount; }
      const turn = (2 * r(SALT.angle) - 1) * w.spread, c = cosDeg(turn), sn = sinDeg(turn), speed = amount * w.throw;
      list.push({ s: w, x, y, vx: (ux * c - uy * sn) * speed, vy: (ux * sn + uy * c) * speed, age: 0, life: pickWhole(w.life, r(SALT.life)), hide: !w.follow, foam: w.follow > 0 });
      total.alive++; total.spawned++;
    }
  }
  return true;
}

// ---- Fields to pixels -------------------------------------------------------------------------------------------------
// A liquid's outline, read in one pass from the cells it covers: a gap one pixel wide with liquid on two sides and liquid
// or an obstacle on a third is filled, and a lone pixel standing on a straight edge (liquid on one side, open air on the
// other three, and liquid either side of its foot) is trimmed. Particles jostling at a resting surface otherwise draw
// it with dents and pimples that come and go every frame. A lone drop, a stream's tip and a two-pixel step stay. A
// walled canvas edge counts as an obstacle.
const SIDES = [[0, -1], [-1, 0], [1, 0], [0, 1]];
function liquidOutline(wet, solid, walls, width, height) {
  const out = Uint8Array.from(wet);
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  const liquid = (x, y) => inside(x, y) && wet[y * width + x] === 1;
  const wall = (x, y) => (inside(x, y) ? solid[y * width + x] === 1 : x < 0 ? walls.left : x >= width ? walls.right : y < 0 ? walls.top : walls.bottom);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const c = j * width + i;
    if (solid[c]) continue;
    let wets = 0, walled = 0, foot = null;
    for (const side of SIDES) {
      if (liquid(i + side[0], j + side[1])) { wets++; foot = side; } else if (wall(i + side[0], j + side[1])) walled++;
    }
    if (!wet[c]) { if (wets >= 2 && wets + walled >= 3) out[c] = 1; continue; }
    if (wets !== 1 || walled) continue;
    const [dx, dy] = foot, x = i + dx, y = j + dy;
    if (liquid(x - dy, y + dx) && liquid(x + dy, y - dx)) out[c] = 0;
  }
  return out;
}

// A bilinear sample over the open cells only: obstacle cells drop out and the rest are weighted up to make up for them
// (off the canvas counts as empty). With no open cell in reach it returns `fallback`.
function openSample(a, solid, nx, ny, fx, fy, fallback) {
  const i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j;
  let sum = 0, weight = 0;
  for (const [di, dj, w] of [[0, 0, (1 - s) * (1 - t)], [1, 0, s * (1 - t)], [0, 1, (1 - s) * t], [1, 1, s * t]]) {
    const x = i + di, y = j + dj;
    if (x < 0 || y < 0 || x >= nx || y >= ny) { weight += w; continue; }
    if (solid[y * nx + x]) continue;
    sum += a[y * nx + x] * w; weight += w;
  }
  return weight > 1e-9 ? sum / weight : fallback;
}

// Each look layer maps one field to palette colours: a colour is fully on from its threshold up, and `dither` feathers
// it in below, through the pattern, over that share of the gap to the previous threshold. Later layers draw over
// earlier ones; obstacles never hold fluid. Then optional cleanup and a one-pixel outline.
function renderFields(effect, base, width, height, drawn = null) {
  // Colour codes are 16-bit: a palette key may be any single character, such as an accented letter.
  const N = width * height, { solid, front, liquid } = effect, runs = new Float64Array(N), depth = new Float64Array(N), chars = new Uint16Array(N);
  let [density] = base, wet = new Uint8Array(N), filled = null;
  for (let c = 0; c < N; c++) wet[c] = !solid[c] && density[c] >= LEVEL ? 1 : 0;
  if (liquid) {
    // A liquid covers every cell a layer of its own draws (density, temperature or speed: a thin, fast stream is drawn
    // by its speed), so a stream's depth runs on through it instead of starting a new surface under each thin pixel.
    for (const layer of effect.look) {
      if (layer.field > 2) continue;
      const field = base[layer.field], { thresholds, gaps, dither, threshold } = layer;
      for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
        const c = j * width + i;
        if (!wet[c] && !solid[c] && field[c] >= thresholds[0] - (1 - threshold(i, j)) * dither * gaps[0]) wet[c] = 1;
      }
    }
    const outline = liquidOutline(wet, solid, effect.walls, width, height);
    // A filled gap is drawn as liquid at the surface level, so the layers colour it like the cells around it.
    for (let c = 0; c < N; c++) if (outline[c] && !wet[c]) {
      if (!filled) { filled = []; density = Float64Array.from(density); }
      filled.push(c);
      if (density[c] < LEVEL) density[c] = LEVEL;
    }
    wet = outline;
  }
  const covered = new Uint8Array(N);
  for (let i = 0; i < width; i++) {
    let run = 0, under = 0;
    for (let j = 0; j < height; j++) {
      const c = j * width + i;
      if (wet[c]) { if (!run) under = j > 0 && solid[c - width] ? 1 : 0; run++; } else run = 0;
      runs[c] = run; covered[c] = run ? under : 0;
    }
  }
  // Liquid whose column starts right under a wall or obstacle has no surface above it. It takes the depth of the nearest
  // liquid along the row whose column does reach a surface, so water under an overhang is as deep as the pool beside it
  // instead of showing a surface highlight in the deep; where there is none (a drop hanging under a rock), it keeps its own.
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const c = j * width + i;
    if (!covered[c]) continue;
    let left = i - 1, right = i + 1;
    for (;;) {
      const l = left >= 0 && runs[j * width + left], r = right < width && runs[j * width + right];
      if (!l && !r) break;
      if (l && !covered[j * width + left]) { runs[c] = runs[j * width + left]; break; }
      if (r && !covered[j * width + right]) { runs[c] = runs[j * width + right]; break; }
      left = l ? left - 1 : -1; right = r ? right + 1 : width;
    }
  }
  // Below its first two rows, depth follows the shallowest surface within DEPTH_REACH pixels along the row through the
  // liquid, so the deeper bands stay level under a drop that lands or a crest that rises instead of sinking beneath it.
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const c = j * width + i;
    let d = runs[c];
    if (d > 2) {
      for (const step of [-1, 1]) for (let k = 1, x = i + step; k <= DEPTH_REACH && x >= 0 && x < width && runs[j * width + x]; k++, x += step) if (runs[j * width + x] < d) d = runs[j * width + x];
      if (d < 3) d = 3;
    }
    depth[c] = d;
  }
  // Light and shadow are the share by which density falls two pixels toward the light and two pixels away from it:
  // 1 on a rim that faces the light (or faces away), 0 inside, whatever the density, so a thinning puff keeps its form.
  // A liquid against an obstacle is lit (or shaded) in full where it touches it on the side toward the light (or away
  // from it), and obstacles further off take no part in the sample: a pool in a stepped bowl gets an even rim along the
  // bowl instead of light and dark pixels by turns as the sample lands on the bowl or on liquid.
  const lit = new Float64Array(N), shade = new Float64Array(N), [lx, ly] = effect.light;
  const sx = lx >= 0.38 ? 1 : lx <= -0.38 ? -1 : 0, sy = ly >= 0.38 ? 1 : ly <= -0.38 ? -1 : 0;
  if (effect.look.some(layer => layer.field === LIGHT || layer.field === SHADOW)) for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const c = j * width + i, here = density[c], x = i + 0.5, y = j + 0.5;
    if (here <= 0) continue;
    if (liquid) {
      const touches = (dx, dy) => (dx && i + dx >= 0 && i + dx < width && solid[c + dx]) || (dy && j + dy >= 0 && j + dy < height && solid[c + dy * width]);
      lit[c] = touches(sx, sy) ? 1 : Math.max(0, 1 - openSample(density, solid, width, height, x + 2 * lx - 0.5, y + 2 * ly - 0.5, here) / here);
      shade[c] = touches(-sx, -sy) ? 1 : Math.max(0, 1 - openSample(density, solid, width, height, x - 2 * lx - 0.5, y - 2 * ly - 0.5, here) / here);
      continue;
    }
    lit[c] = Math.max(0, 1 - bilinearZero(density, width, height, x + 2 * lx - 0.5, y + 2 * ly - 0.5) / here);
    shade[c] = Math.max(0, 1 - bilinearZero(density, width, height, x - 2 * lx - 0.5, y - 2 * ly - 0.5) / here);
  }
  const sources = [density, base[1], base[2], depth, lit, shade, base[3], base[4], base[5]];
  // A filled gap that no layer coloured (a look whose first colour starts above the surface level) takes the colour of
  // a neighbour, along the edge first.
  const patch = () => {
    if (filled) for (const c of filled) if (!chars[c]) for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1], [0, -1]]) {
      const x = c % width + dx, y = Math.floor(c / width) + dy, n = y * width + x;
      if (x >= 0 && y >= 0 && x < width && y < height && wet[n] && chars[n]) { chars[c] = chars[n]; break; }
    }
    filled = null;
  };
  // Light and shadow only recolour pixels that earlier layers drew. A liquid draws only inside its outline, but for its
  // strands, which are thinner than any outline. `by` notes which layer drew each pixel last, for halos.
  const by = effect.look.some(layer => layer.halo) ? new Uint8Array(N) : null;
  for (const [index, layer] of effect.look.entries()) {
    const field = sources[layer.field], { thresholds, gaps, colors, dither, threshold } = layer, shading = layer.field === LIGHT || layer.field === SHADOW, strands = layer.field === STRAND;
    if (shading) patch();
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const c = j * width + i, value = field[c];
      if (solid[c] || (liquid && !wet[c] && !strands) || (shading && !chars[c]) || value < thresholds[0] - dither * gaps[0]) continue;
      const feather = (1 - threshold(i, j)) * dither;
      let level = 0;
      while (level < thresholds.length && value >= thresholds[level] - feather * gaps[level]) level++;
      if (level) { chars[c] = colors[level - 1]; if (by) by[c] = index + 1; }
    }
  }
  patch();
  if (effect.cleanup.strays || effect.cleanup.corners) {
    // An obstacle is neither fluid nor air: a corner pixel tucked against one is not a step in the fluid's edge, so
    // cleanup never opens a hole between the fluid and a wall.
    for (const change of cleanupIds(chars, width, height, { ...effect.cleanup, allowed: c => !solid[c], walls: c => solid[c] })) {
      // A liquid's lone pixel is a drop whose particles are there: De-Stray may recolour it but never erase it, so a
      // small drop doesn't vanish for a frame (a gas's lone speck is noise, and goes).
      if (effect.liquid && change.kind === 'stray' && !change.id && chars[change.index]) continue;
      chars[change.index] = change.id;
    }
  }
  // `drawn`, when given, marks the cells the look layers drew the fluid on (after cleanup, before the outline).
  if (drawn) for (let c = 0; c < N; c++) drawn[c] = chars[c] ? 1 : 0;
  // Halos, in look order: the empty pixels within a round reach of a layer's pixels (an offset (dx, dy) reaches when
  // dx² + dy² ≤ (width + 0.5)² − 1, so one pixel wide is the four neighbours) take its glow colour.
  if (by) effect.look.forEach((layer, index) => {
    if (!layer.halo) return;
    const { color, width: reach } = layer.halo, limit = (reach + 0.5) * (reach + 0.5) - 1, glow = [];
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const c = j * width + i;
      if (chars[c] || solid[c]) continue;
      search: for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const x = i + dx, y = j + dy, n = y * width + x;
        if (dx * dx + dy * dy > limit || x < 0 || y < 0 || x >= width || y >= height || by[n] !== index + 1 || !chars[n]) continue;
        glow.push(c);
        break search;
      }
    }
    for (const c of glow) chars[c] = color;
  });
  if (effect.outline) {
    // The outline may cover an obstacle drawn under the fluid, never one drawn over it.
    const filled = Uint16Array.from(chars);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const c = j * width + i;
      if (filled[c] || front[c]) continue;
      if ((i > 0 && filled[c - 1]) || (i < width - 1 && filled[c + 1]) || (j > 0 && filled[c - width]) || (j < height - 1 && filled[c + width])) chars[c] = effect.outline;
    }
  }
  return chars;
}

// ---- Simulation -------------------------------------------------------------------------------------------------------
// Cell updates per cell per step, for the work budget: one per pressure sweep plus the transfers and advection. A thick
// fluid's viscosity solve (and a liquid's second pressure solve) costs about two more per sweep, a yield-stress liquid's
// spreading solve one more, sharp advection about thirty.
const stepWork = effect => effect.iterations * (effect.most.yield ? 4 : effect.most.viscosity ? 3 : 1) + 10 + (effect.sharp ? 30 : 0) + electricWork(effect) + (effect.vapour ? effect.vapour.iterations + 20 : effect.heat ? 4 : 0);
// A loop simulates its warm-up cycles, the recorded cycle, and as long again as its longest-lived spark (a liquid's
// spray may fly on for its life again; a bubble never does), the bubbles of air pockets included.
const sparkSpan = (s, liquid) => (liquid && !s.follow && s.rise === null ? 2 : 1) * s.life[1];
const sparkTail = effect => Math.max(0, ...effect.emitters.map(e => (e.sparks ? sparkSpan(e.sparks, effect.liquid) : 0)), ...effect.whitewater.map(w => sparkSpan(w, effect.liquid)), effect.air && effect.air.bubbles ? effect.air.bubbles.life[1] : 0);
// Whether bubbles with these settings (an emitter's sparks or a whitewater layer) change the water: they lift it, or,
// with air pockets on, give their air to pockets and gather into them (as an air pocket's own bubbles do). A loop makes
// those through its warm-up and after its cycle as well, unseen, as a boil's bubbles, so the water they lift and the
// pockets they gather into are there at frame 0 as in the cycle. (Made in the recorded cycle only, the warm-up had none:
// an aerator's dome was missing at frame 0, and the seam's blend lowered the water under bubbles still rising through
// it, which hung in the air.) Other bubbles change nothing but themselves, and a loop makes them in its cycle only.
const pushesWater = (effect, s) => s.rise !== null && (s.lift > 0 || !!effect.air);
const makesBubbles = effect => effect.emitters.some(e => e.sparks && pushesWater(effect, e.sparks)) || effect.whitewater.some(w => pushesWater(effect, w)) || !!(effect.air && effect.air.bubbles);
// A boil's bubbles are made by the water, not by an emitter: a loop draws those born in its recorded cycle and simulates
// on for up to another cycle, until they have all ended, drawing them from frame 0 again (see simulate).
const boilTail = effect => (effect.loop && effect.vapour && effect.vapour.bubbles ? effect.frames : 0);
const simulatedFrames = effect => effect.loop ? (effect.warmup + 1) * effect.frames + Math.max(sparkTail(effect), boilTail(effect)) : effect.frames;
const crowded = path => fail(path, `more than ${LIMITS.particles} liquid particles; lower the emitters' density or rate, or the fill`);
const SPARKS_FULL = `more than ${LIMITS.sparks} sparks are alive at once; lower the sparks' count or life`;
const AIR_FULL = `more than ${LIMITS.sparks} sparks and bubbles are alive at once; lower the sparks' count or life, or the air bubbles' life`;
const WHITEWATER_FULL = `more than ${LIMITS.sparks} sparks and whitewater droplets are alive at once; lower the whitewater chance or life`;

// One running simulation of an effect, shared by compileFluid and the live runner: the solver's state, the fields the
// look reads (density, temperature and speed), the sparks in flight, and the obstacles' layout now (`view` is the effect
// with that layout's masks, for drawing).
function createRun(effect, width, height, path) {
  const N = width * height, state = effect.liquid ? createLiquid(effect, width, height) : createGas(effect, width, height);
  if (effect.liquid) { fillLiquid(state, effect); if (state.full) crowded(path); }
  // A gas's plasma has two fields more (ionization and current, after the strand's place); over a liquid the vapour's.
  const fieldSet = (electric = false) => Array.from({ length: electric ? 6 : 3 }, () => new Float64Array(N)), base = [...fieldSet(), ...Array.from({ length: effect.electric && !effect.liquid ? 3 : 1 }, () => new Float64Array(N))];
  const run = { effect, view: effect, layout: effect.layout, state, base, sparks: [], pops: [], totals: { alive: 0, spawned: 0, maxAlive: 0 }, maxParticles: effect.liquid ? state.n : 0, fields: base };
  // A liquid with heat also has the ice's fields and the vapour's, which a loop's seam blends with the rest. What the
  // fills made is where the ledger starts (it counts what emitters add from here on), and a frozen fill is solid at once.
  if (state.heat) {
    run.iceBase = fieldSet(); run.vapourBase = fieldSet(!!effect.electric); run.fields = [...base, ...run.iceBase, ...run.vapourBase];
    state.heat.added = 0; tally(state); heatMasks(state, effect);
  }
  return run;
}
// Obstacles that move on cue. When the layout for frame `cycle` differs from the last, the solver's masks are rebuilt
// for it. Through every frame of a key's `over`, the faces against the obstacle carry its speed along the ramp (in
// pixels per frame, before rounding to whole pixels), so the pressure solve pushes the fluid ahead of it steadily;
// beside smooth obstacles the closed share of a part-open face carries it. Fluid in the cells it now covers is shoved
// along its move to the first open cell, never through another solid (or lost, where there is none). A jump (a key
// with no `over`), an obstacle appearing or vanishing, and the place a loop comes round to are cuts, not moves: they
// push nothing, and fluid where an obstacle lands is lost. With heat the grid stays and heatMasks reshapes it, with the
// ice, and builds the solid layer; ice stops what is pushed as an obstacle does.
function moveObstacles(run, cycle) {
  const { effect, state } = run, places = placementsAt(effect.obstacles, cycle), key = layoutKey(places), before = run.layout, P = state.heat;
  let g = state.g;
  const { W, H } = g, X = W + 1, changed = key !== before.key;
  if (changed) {
    const layout = buildLayout(effect.obstacles, W, H, places);
    run.layout = layout;
    run.view = { ...effect, solid: layout.solid, front: layout.front, smooth: layout.smooth };
  }
  if (P) { P.places = places; if (changed) { P.layout = run.layout; P.base = run.layout.solid; } heatMasks(state, effect, changed ? 'layout' : 'moved'); }
  else if (changed) {
    const next = gridFor(run.view, W, H);
    next.u.set(g.u); next.v.set(g.v); next.p.set(g.p); next.release = g.release;
    if (g.visc) next.visc = g.visc;
    if (g.sharp) next.sharp = g.sharp;
    state.g = g = next;
    if (state.open) for (let c = 0; c < g.N; c++) state.open[c] = g.solid[c] ? 0 : 1;
  }
  // The solid layer for this frame; what clings to the solids reads it.
  const layout = run.layout, owner = layout.owner, solids = P ? state.solids : state.solids = solidLayer(effect, layout, places, W, H), { speed } = solids;
  if (state.cling && !P) {
    if (changed) { state.cling = clingField(solids); state.grip = gripFields(solids, effect.obstacles); }
    state.carry = carryFields(solids);
  }
  // A frame older, the wake lets go of the cells it has held for WAKE frames, and of those an obstacle now covers.
  const { wake } = state;
  if (wake && wake.cells.length) {
    for (const c of wake.cells) if (wake.left[c] && (g.solid[c] || !--wake.left[c])) wake.left[c] = 0;
    wake.cells = wake.cells.filter(c => wake.left[c]);
  }
  if (effect.liquid && solids.moving) state.wake ??= { cells: [], left: new Uint8Array(g.N), mark: new Uint8Array(g.N) };
  const of = c => (c >= 0 ? solids.velocity(c) : null);
  if (!P && (solids.moving || g.moved || changed)) {
    if (!g.uWall) { g.uWall = new Float64Array(g.u.length); g.vWall = new Float64Array(g.v.length); } else { g.uWall.fill(0); g.vWall.fill(0); }
    g.moved = false;
    for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) { const s = of(i > 0 ? j * W + i - 1 : -1) ?? of(i < W ? j * W + i : -1); if (s) { g.uWall[j * X + i] = s[0]; g.moved = true; } }
    for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) { const k = j * W + i, s = of(j > 0 ? k - W : -1) ?? of(j < H ? k : -1); if (s) { g.vWall[k] = s[1]; g.moved = true; } }
    enforce(g);
  }
  if (!changed) return;
  const shift = effect.obstacles.map((o, i) => { const at = places[i], was = before.places[i]; return o.blocks && at.show && was.show && !at.jump && cycle > 0 && (at.x !== was.x || at.y !== was.y) ? [at.x - was.x, at.y - was.y] : null; });
  const covered = c => layout.solid[c] && !before.solid[c];
  // The cells a moving obstacle has just left join its wake (see transfer); a cut leaves none.
  if (effect.liquid) {
    for (let c = 0; c < g.N; c++) if (before.solid[c] && !layout.solid[c] && before.owner[c] >= 0 && shift[before.owner[c]]) {
      if (!state.wake.left[c]) state.wake.cells.push(c);
      state.wake.left[c] = WAKE;
    }
  }
  // The cells each moving obstacle passed over on its way, from every cell it held to where that cell is now. An
  // obstacle that moves more pixels than it is thick leaves some of them open behind it: the fluid there was in its
  // path, so it goes ahead of it too, as from the cells it covers, instead of being passed through.
  const swept = new Int16Array(g.N).fill(-1);
  effect.obstacles.forEach((o, i) => {
    const s = shift[i];
    if (!s) return;
    const was = before.places[i], steps = Math.ceil(2 * Math.sqrt(s[0] * s[0] + s[1] * s[1]));
    o.rows.forEach((row, j) => {
      for (let k = 0; k < row.length; k++) if (row[k] !== '.' && row[k] !== ' ') {
        for (let step = 1; step < steps; step++) {
          // Off the canvas (an obstacle that hangs off an edge) there are no cells to sweep.
          const px = Math.floor(was.x + k + 0.5 + s[0] * step / steps), py = Math.floor(was.y + j + 0.5 + s[1] * step / steps);
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          const c = py * W + px;
          if (swept[c] < 0) swept[c] = i;
        }
      }
    });
  });
  const passed = c => swept[c] >= 0 && !layout.solid[c] && !before.solid[c], solid = P ? P.mask : layout.solid;
  // The first open cell along a move from (x, y), passing only through cells the same obstacle has just covered or
  // passed over; -1 where another solid or the canvas edge comes first.
  const landing = (x, y, o, s) => {
    const length = Math.sqrt(s[0] * s[0] + s[1] * s[1]), ux = s[0] / length, uy = s[1] / length;
    for (let step = 1; step <= 2 * length + 4; step++) {
      const px = x + 0.5 * step * ux, py = y + 0.5 * step * uy;
      if (px < 0 || py < 0 || px >= W || py >= H) return -1;
      const c = Math.floor(py) * W + Math.floor(px);
      if (!solid[c]) { if (passed(c) && swept[c] === o) continue; return c; }
      if (!covered(c) || owner[c] !== o) return -1;
    }
    return -1;
  };
  if (effect.liquid) {
    for (let k = state.n - 1; k >= 0; k--) {
      const x = state.x[k], y = state.y[k], c = Math.floor(y) * W + Math.floor(x);
      if (!covered(c) && !passed(c)) continue;
      const o = covered(c) ? owner[c] : swept[c], s = shift[o], to = s ? landing(x, y, o, s) : -1;
      if (to < 0) { removeParticle(state, k); continue; }
      // Into the open cell the walk reached, just past the obstacle, moving at least as fast as it does.
      const length = Math.sqrt(s[0] * s[0] + s[1] * s[1]), ux = s[0] / length, uy = s[1] / length, tx = to % W, ty = (to - tx) / W;
      let px = x, py = y;
      while (Math.floor(px) !== tx || Math.floor(py) !== ty) { px += 0.5 * ux; py += 0.5 * uy; }
      state.x[k] = px; state.y[k] = py;
      const pace = speed[o] ? Math.sqrt(speed[o][0] * speed[o][0] + speed[o][1] * speed[o][1]) : length, along = state.vx[k] * ux + state.vy[k] * uy;
      if (along < pace) { state.vx[k] += (pace - along) * ux; state.vy[k] += (pace - along) * uy; }
    }
  } else {
    const { d, T } = state;
    for (let c = 0; c < g.N; c++) {
      if ((!covered(c) && !passed(c)) || (!d[c] && !T[c])) continue;
      const o = covered(c) ? owner[c] : swept[c], s = shift[o], to = s ? landing(c % W + 0.5, Math.floor(c / W) + 0.5, o, s) : -1;
      if (to >= 0) { d[to] += d[c]; T[to] += T[c]; }
      d[c] = 0; T[c] = 0;
    }
  }
}
// The stamps of the obstacles drawn under or over the fluid, at their places in a layout. An obstacle that hangs off the
// canvas copies only the part of its symbol on it, so the frame draws nothing outside the canvas.
const stampsOf = (effect, layout, draw, width, height) => effect.obstacles.flatMap((o, i) => {
  const at = layout.places[i];
  if (o.draw !== draw || !at.show) return [];
  const part = onCanvas(o.rows, at.x, at.y, width, height);
  if (!part) return [];
  if (part.w === o.rows[0].length && part.h === o.rows.length) return [{ op: 'stamp', symbol: o.symbol, x: at.x, y: at.y }];
  return [{ op: 'copy', symbol: o.symbol, sx: part.sx, sy: part.sy, w: part.w, h: part.h, x: at.x + part.sx, y: at.y + part.sy }];
});
// Frame `t` of a run, `cycle` within the effect's cycle: every active emitter adds its share, its strength scaled by
// `factors[index]` when given. Returns where each emitter was, or null where it was idle, for its sparks.
function emitFrame(run, t, cycle, factors = null) {
  const { effect, state } = run, { frames, loop, seed, emitters, liquid } = effect;
  if (!liquid) state.source.fill(0);
  return emitters.map((e, index) => {
    if (!active(e, cycle)) return null;
    const factor = factors ? factors[index] : 1;
    const emit = (along, share) => (liquid ? emitLiquid(state, e, index, cycle, seed, along, factor) : emitGas(state.g, state, e, index, cycle, seed, along, share, factor));
    // An orbiting rate emitter is laid along the path it covered since the last frame, about a pixel apart, so a fast
    // orbit leaves a smooth trail instead of a string of beads; its expansion is shared out along the way.
    // A carrying emitter throws once a frame: carriers already fly, and laying it along its path would throw one per
    // covered cell at every point.
    if (!e.orbit || e.burst || e.carry || !t || !active(e, loop ? (cycle + frames - 1) % frames : cycle - 1)) return emit(cycle, 1);
    const steps = Math.max(1, Math.ceil(2 * Math.PI * Math.max(e.orbit.radius[0], e.orbit.radius[1]) / Math.abs(e.orbit.period)));
    for (let k = 1; k < steps; k++) emit(cycle - 1 + k / steps, 1 / steps);
    return emit(cycle, 1 / steps);
  });
}
// The solver's substeps for one frame, with the settings its keys give frame `cycle` of the effect's cycle.
function solveFrame(run, cycle) {
  const { state } = run, effect = run.effect.schedule ? { ...run.effect, ...run.effect.schedule[cycle] } : run.effect, dt = 1 / effect.substeps;
  if (state.electric) { state.electric.cycle = cycle; state.electric.layout = run.layout; }
  // Whitewater measures how much each particle's velocity changes over the frame's steps, not what emitters set.
  if (effect.liquid && effect.whitewater.length) { state.pvx.set(state.vx.subarray(0, state.n)); state.pvy.set(state.vy.subarray(0, state.n)); }
  if (effect.liquid) state.lifts = liftsOf(run.sparks);
  if (state.air) state.air.release.length = 0;
  const vapour = state.heat && state.heat.vapour;
  // `phase`: how much of the frame has passed at the end of each step, for what clings to moving obstacles.
  for (let s = 0; s < effect.substeps; s++) {
    state.phase = (s + 1) / effect.substeps;
    if (!effect.liquid) { stepGas(state, effect, dt); continue; }
    if (state.electric) electricStep(state, effect, dt);
    if (state.heat) heatStep(run, effect, dt, s === 0);
    stepLiquid(state, effect, dt);
    if (vapour) stepVapour(state, effect, dt);
  }
  if (effect.liquid) run.maxParticles = Math.max(run.maxParticles, state.n);
}
// Where the bubbles with lift are, and how much of their buoyancy each hands on (its share times its air), or null.
function liftsOf(sparks) {
  let lifts = null;
  for (const p of sparks) if (p.s.lift) (lifts ??= []).push(p.x, p.y, p.s.lift * p.vol);
  return lifts;
}
const fieldsOf = run => {
  if (!run.effect.liquid) return gasFields(run.state, run.base);
  liquidFields(run.state, run.base);
  if (run.state.heat) heatFields(run);
};
// A frame's pixels from the fields.
const drawFrame = (run, width, height, drawn = null) => (run.state.heat ? renderHeat(run, width, height, drawn) : renderFields(run.view, run.base, width, height, drawn));
// Sparks move with this frame's flow; then, while `spawning`, new ones join where their emitters were (`here`) and
// whitewater where the water throws it, and while `bubbling` the bubbles that push the water do (see pushesWater; a
// loop makes those from its warm-up on, tagged with the frame they are born on). Returns the message for the spark
// limit if it kept any out, or null.
function sparkFrame(run, here, cycle, spawning, bubbling = spawning) {
  const { effect, state, base, sparks, totals } = run;
  const gravity = effect.liquid ? (effect.schedule ? effect.schedule[cycle].gravity : effect.gravity) : null;
  run.gravity = gravity;
  moveSparks(sparks, state.g, base[0], totals, effect.liquid, run.pops, gravity, endedOf(run), gatherOf(run));
  let full = null;
  if (spawning || bubbling) {
    const born = effect.loop ? run.clock : undefined, throws = s => (pushesWater(effect, s) ? bubbling : spawning);
    effect.emitters.forEach((e, index) => { if (!full && here[index] && e.sparks && throws(e.sparks) && !spawnSparks(sparks, e, index, cycle, here[index], effect.seed, totals, pushesWater(effect, e.sparks) ? born : undefined)) full = SPARKS_FULL; });
    if (!full && effect.whitewater.length && !throwWhitewater(state, effect, base[0], sparks, cycle, totals, throws, born)) full = WHITEWATER_FULL;
    if (!full && bubbling && state.air && state.air.release.length && !releaseAir(state.air, effect, sparks, cycle, totals, born)) full = AIR_FULL;
  }
  totals.maxAlive = Math.max(totals.maxAlive, totals.alive);
  return full;
}
// Adds `amount` of air (square pixels at zero pressure) to the pocket at cell (i, j) or beside it, as the last step found
// them, and returns whether there was one: a bubble rising into a pocket, or vapour boiling into it, raises its pressure.
function addAir(state, i, j, amount) {
  const { air, g } = state, { W, H } = g;
  for (const [x, y] of [[i, j], [i, j - 1], [i, j + 1], [i - 1, j], [i + 1, j]]) {
    const r = x >= 0 && y >= 0 && x < W && y < H ? air.label[y * W + x] : -1, region = r >= 0 ? air.regions[r] : null;
    if (region && region.tracked) { region.air += amount; return true; }
  }
  return false;
}
// A bubble that rises into a pocket gives it its air.
const bubbleEnded = state => p => { if (p.end === 'air') addAir(state, Math.floor(p.x), Math.floor(p.y), p.vol); };
// With air pockets on, bubbles waiting under a ceiling that touch and hold more air together than a bubble can (see
// mergeBubbles) become a pocket there (physics-model.md section 7): carvePocket clears the cells under the ceiling for
// their air. A boil's bubbles, which carry vapour, stay bubbles. Null without pockets.
const gatherOf = run => {
  const { state } = run;
  if (!state.air) return null;
  return (p, q) => !p.steam && !q.steam && carvePocket(state, run.gravity, (p.x * p.vol + q.x * q.vol) / (p.vol + q.vol), (p.y * p.vol + q.y * q.vol) / (p.vol + q.vol), p.vol + q.vol);
};
// Clears a pocket for `vol` square pixels of air at (x, y), under a ceiling: as many whole cells as the air fills, the
// highest first (against `gravity`, the nearest axis, as a bubble rises) and then the nearest along the ceiling, each
// beside one already taken, down to six cells below the start. The liquid in them moves along gravity, in its own
// column, to the first cell below that stays liquid, where it crowds the cells until the pressure spreads it: the water
// under the pocket gives way and rises elsewhere (a particle with only solid below stays, and the pocket is a cell
// smaller). The pocket's air reaches sealAir through `air.made`. Returns false, changing nothing, where there is not
// room for POCKET_START cells.
function carvePocket(state, gravity, x, y, vol) {
  const { g, air } = state, { W, H, N } = g, solid = g.solid, [gx, gy] = gravity, vertical = Math.abs(gy) >= Math.abs(gx);
  // Down along gravity, as a cell step, and across.
  const down = vertical ? (gy >= 0 ? W : -W) : gx >= 0 ? 1 : -1, i0 = Math.floor(x), j0 = Math.floor(y);
  if (i0 < 0 || j0 < 0 || i0 >= W || j0 >= H || solid[j0 * W + i0]) return false;
  const want = Math.max(POCKET_START, Math.round(vol)), take = air.carve ??= new Uint8Array(N), cells = [];
  // How far down along gravity a cell lies from the start, and how far across.
  const depth = c => { const i = c % W, j = (c - i) / W; return vertical ? (gy >= 0 ? j - j0 : j0 - j) : gx >= 0 ? i - i0 : i0 - i; };
  const across = c => { const i = c % W, j = (c - i) / W; return vertical ? Math.abs(i - i0) : Math.abs(j - j0); };
  const near = c => { const i = c % W; return [i > 0 ? c - 1 : -1, i < W - 1 ? c + 1 : -1, c >= W ? c - W : -1, c + W < N ? c + W : -1]; };
  let frontier = [j0 * W + i0];
  take[frontier[0]] = 2;
  while (cells.length < want && frontier.length) {
    let best = 0;
    for (let k = 1; k < frontier.length; k++) {
      const a = frontier[k], b = frontier[best], da = depth(a), db = depth(b);
      if (da < db || (da === db && (across(a) < across(b) || (across(a) === across(b) && a < b)))) best = k;
    }
    const c = frontier[best];
    frontier.splice(best, 1);
    take[c] = 1; cells.push(c);
    for (const d of near(c)) if (d >= 0 && !take[d] && !solid[d] && depth(d) <= depth(cells[0]) + 6) { take[d] = 2; frontier.push(d); }
  }
  const room = cells.length >= POCKET_START;
  for (const c of frontier) take[c] = 0;
  if (!room) { for (const c of cells) take[c] = 0; return false; }
  // Each particle in a cleared cell goes down its column to the first cell that stays liquid (not cleared, not solid).
  for (let k = 0; k < state.n; k++) {
    const i = Math.floor(state.x[k]), j = Math.floor(state.y[k]);
    if (i < 0 || j < 0 || i >= W || j >= H || take[j * W + i] !== 1) continue;
    let c = j * W + i, steps = 0;
    while (c >= 0 && c < N && take[c] === 1 && steps++ < H) { const next = c + down; if (next < 0 || next >= N || (!vertical && Math.floor(next / W) !== Math.floor(c / W))) { c = -1; break; } c = next; }
    if (c < 0 || c >= N || solid[c] || take[c]) continue;
    const ci = c % W, cj = (c - ci) / W;
    state.x[k] += ci - i; state.y[k] += cj - j;
  }
  for (const c of cells) take[c] = 0;
  air.made.push(cells[0], vol);
  return true;
}
// The air of pockets that this frame's steps let go rises as bubbles from where each pocket was: up to nine square pixels
// of air (a bubble 3 pixels across) each, side by side along the row, drawing from their own random stream. For its first
// two frames a bubble lives on where the gap it came from has not closed yet. `born` tags a loop's bubbles with their frame.
const POCKETS = 3000;
function releaseAir(air, effect, list, cycle, total, born = undefined) {
  const s = effect.air.bubbles, out = air.release;
  for (let k = 0, n = 0; k < out.length; k += 3) {
    let volume = out[k + 2];
    for (let m = 0; volume > 0.5; m++, n++) {
      const vol = Math.min(9, volume), r = salt => random(effect.seed, POCKETS, cycle, n, salt);
      volume -= vol;
      if (!addBubble(list, total, s, out[k] + 3 * (m % 2 ? (m + 1) / 2 : -m / 2), out[k + 1], r, { vol, size: bubbleSize(vol), fresh: 2, ...(born !== undefined && { born }) })) return false;
    }
  }
  out.length = 0;
  return true;
}
// Draws the sparks through `put(x, y, code)`: a spark is a size × size block in the colour for its age, and a trail
// streaks back to where it was a frame ago in the next colour of its list. Popped bubbles follow and age a frame.
function drawSparks(run, put, shown = null) {
  for (const p of run.sparks) {
    // Spray is drawn once it has left the water, and streaks back only from where it was already drawn.
    if ((p.hide && !p.out) || (shown && !shown(p))) continue;
    const s = p.s, step = Math.min(s.colors.length - 1, Math.floor(p.age * s.colors.length / p.life)), seen = !p.hide || p.seen;
    p.seen = true;
    if (s.trail && p.px !== undefined && seen) { const tail = s.colors[Math.min(s.colors.length - 1, step + 1)].charCodeAt(0); traceLine(Math.floor(p.px), Math.floor(p.py), Math.floor(p.x), Math.floor(p.y), (x, y) => put(x, y, tail)); }
    // A bubble is as large as the air it holds.
    const size = p.size ?? s.size, head = s.colors[step].charCodeAt(0), x0 = Math.floor(p.x - (size - 1) / 2), y0 = Math.floor(p.y - (size - 1) / 2);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) put(x0 + i, y0 + j, head);
  }
  // A popped bubble: the ring around its block, then a droplet off each upper corner.
  const { pops } = run;
  for (let k = pops.length - 1; k >= 0; k--) {
    const b = pops[k], x0 = Math.floor(b.x - (b.size - 1) / 2), y0 = Math.floor(b.y - (b.size - 1) / 2);
    if (shown && !shown(b)) { if (++b.age > 1) pops.splice(k, 1); continue; }
    if (b.age === 0) for (let i = 0; i < b.size; i++) { put(x0 + i, y0 - 1, b.code); put(x0 + i, y0 + b.size, b.code); put(x0 - 1, y0 + i, b.code); put(x0 + b.size, y0 + i, b.code); }
    else { put(x0 - 1, y0 - 1, b.code); put(x0 + b.size, y0 - 1, b.code); }
    if (++b.age > 1) pops.splice(k, 1);
  }
}
// Figures for one frame, so an agent can tune by numbers: the box round the fluid's drawn pixels ([left, top, right,
// bottom], sparks left out), the middle of its density, its amount (smoke, or cells' worth of water), how many separate
// pieces it is drawn in (pixels touching side to side), its top speed where it is drawn (pixels per frame), and for a
// liquid its particles. An empty frame has no box or middle.
const tenth = value => Math.floor(value * 10 + 0.5) / 10, hundredth = value => Math.floor(value * 100 + 0.5) / 100;
function measureFrame(chars, base, solid, width, height, particles) {
  const [density, , speed] = base, N = width * height, seen = new Uint8Array(N), stack = [];
  let left = width, top = height, right = -1, bottom = -1, amount = 0, sx = 0, sy = 0, fastest = 0, pieces = 0;
  for (let c = 0; c < N; c++) {
    const x = c % width, y = (c - x) / width;
    if (!solid[c] && density[c] > 0) { amount += density[c]; sx += density[c] * (x + 0.5); sy += density[c] * (y + 0.5); }
    if (!chars[c]) continue;
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
    if (speed[c] > fastest) fastest = speed[c];
    if (seen[c]) continue;
    pieces++; seen[c] = 1; stack.push(c);
    while (stack.length) {
      const d = stack.pop(), dx = d % width;
      for (const e of [dx > 0 ? d - 1 : -1, dx < width - 1 ? d + 1 : -1, d - width, d + width]) if (e >= 0 && e < N && chars[e] && !seen[e]) { seen[e] = 1; stack.push(e); }
    }
  }
  return {
    box: right < 0 ? null : [left, top, right, bottom], middle: amount > 0 ? [tenth(sx / amount), tenth(sy / amount)] : null,
    amount: hundredth(amount), pieces, speed: hundredth(fastest), ...(particles !== null && { particles })
  };
}
// The per-frame figures as one list per figure, which keeps the metadata compact.
const columns = list => Object.fromEntries(Object.keys(list[0]).map(key => [key, list.map(figure => figure[key])]));

// Runs one effect and returns its frames' operations plus figures for the metadata.
function simulate(effect, context) {
  const { width, height, path } = context, { frames, loop, liquid } = effect, N = width * height;
  const run = createRun(effect, width, height, path), { state, base } = run, all = run.fields;
  // A loop warms up for whole cycles under its periodic forcing, keeps the fields of the last cycle's closing frames,
  // and blends its own closing frames toward them: the last frame then flows into frame 0 as that cycle's did.
  const begin = effect.warmup * frames, total = simulatedFrames(effect), blend = effect.blend;
  // A loop draws the bubbles born in its recorded cycle only (a boil's, and those of emitters, whitewater and air pockets
  // that push the water, see pushesWater), on every frame they live, wrapped round to frame 0 as sparks are; those born
  // in its warm-up still carry their vapour and lift the water, unseen. Once none of its own is left, and no spark's tail
  // is still to come, the run stops. (Drawn as they came, the warm-up's bubbles stood at frame 0 where the cycle's own
  // should have been, and bubbles popped in and out where the loop repeats.)
  const bubbling = loop && makesBubbles(effect);
  const shown = loop && (boilTail(effect) || bubbling) ? p => p.born === undefined || (p.born >= begin && p.born < begin + frames) : null, done = (effect.warmup + 1) * frames + sparkTail(effect);
  const tail = loop ? Array.from({ length: blend }, () => all.map(() => new Float64Array(N))) : [];
  const chars = Array.from({ length: frames }, () => null), drawn = Array.from({ length: frames }, () => []);
  const peak = { density: 0, temperature: 0, speed: 0, ...(effect.electric && { ionization: 0, current: 0 }) }, figures = Array.from({ length: frames }, () => null), layouts = Array.from({ length: frames }, () => effect.layout);
  let ran = 0;
  for (let t = 0; t < total; t++, ran++) {
    if (shown && t >= done && !run.sparks.some(p => p.born !== undefined && shown(p))) break;
    run.clock = t;
    const cycle = loop ? t % frames : t, out = t - begin, recording = !loop || (out >= 0 && out < frames);
    if (effect.moving) moveObstacles(run, cycle);
    const here = emitFrame(run, t, cycle);
    solveFrame(run, cycle);
    if (liquid && state.full) crowded(path);
    if (state.overflow) fail(path, `more than ${LIMITS.carriers} carriers are in the air at once; lower the carrying emitters' size or rate, or raise their release`);
    if (loop && out < -blend && !run.sparks.length && !bubbling) continue;
    fieldsOf(run);
    // The warm-up's closing frames keep their fields for the seam; its bubbles move on through them (held still there,
    // they waited `blend` frames under the water while it flowed on).
    if (loop && out >= -blend && out < 0) {
      tail[out + blend].forEach((field, f) => field.set(all[f]));
      if (run.sparks.length || bubbling) { const full = sparkFrame(run, here, cycle, false, bubbling); if (full) fail(path, full); }
      continue;
    }
    // A looping effect spawns sparks during the recorded cycle only (bubbles that push the water from the warm-up on, unseen
    // until the cycle); those still alive after it are drawn from frame 0.
    const full = sparkFrame(run, here, cycle, recording, recording || bubbling);
    if (full) fail(path, full);
    // Bubbles live through a loop's warm-up too (they carry vapour and lift the water); only the recorded cycle on draws them.
    const list = loop && out < 0 ? null : drawn[(loop ? out : t) % frames];
    if (list) drawSparks(run, (x, y, code) => { if (x >= 0 && y >= 0 && x < width && y < height && !run.view.front[y * width + x]) list.push(y * width + x, code); }, shown);
    if (!recording) continue;
    const frame = loop ? out : t;
    if (loop && frame >= frames - blend) {
      const k = frame - (frames - blend), w = smooth((k + 1) / blend);
      for (let f = 0; f < all.length; f++) { const a = all[f], b = tail[k][f]; for (let c = 0; c < N; c++) a[c] = a[c] * (1 - w) + b[c] * w; }
    }
    for (let c = 0; c < N; c++) {
      if (base[0][c] > peak.density) peak.density = base[0][c];
      if (base[1][c] > peak.temperature) peak.temperature = base[1][c];
      if (base[2][c] > peak.speed) peak.speed = base[2][c];
    }
    if (effect.electric) { const plasma = liquid ? run.vapourBase : base; for (let c = 0; c < N; c++) { if (plasma[4][c] > peak.ionization) peak.ionization = plasma[4][c]; if (plasma[5][c] > peak.current) peak.current = plasma[5][c]; } }
    chars[frame] = drawFrame(run, width, height);
    figures[frame] = measureFrame(chars[frame], base, run.view.solid, width, height, liquid ? state.n : null);
    if (state.heat) Object.assign(figures[frame], heatAmounts(run));
    layouts[frame] = run.layout;
  }
  // Sparks draw over the fluid; obstacles drawn over it sit in front of both.
  const output = chars.map((grid, i) => {
    const list = drawn[i];
    for (let k = 0; k < list.length; k += 2) grid[list[k]] = list[k + 1];
    let left = width, top = height, right = -1, bottom = -1;
    for (let c = 0; c < N; c++) if (grid[c]) { const x = c % width, y = Math.floor(c / width); if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
    const ops = stampsOf(effect, layouts[i], 'under', width, height);
    let pixels = 0;
    if (right >= 0) {
      const rows = [];
      for (let y = top; y <= bottom; y++) { let row = ''; for (let x = left; x <= right; x++) { const ch = grid[y * width + x]; row += ch ? String.fromCharCode(ch) : '.'; if (ch) pixels++; } rows.push(row); }
      ops.push({ op: 'grid', x: left, y: top, rows });
    }
    ops.push(...stampsOf(effect, layouts[i], 'over', width, height));
    return { ops, pixels };
  });
  const round = value => Math.floor(value * 1000 + 0.5) / 1000;
  const { totals } = run;
  return {
    output, steps: ran * effect.substeps, peak: { density: round(peak.density), ...(!liquid && { temperature: round(peak.temperature) }), speed: round(peak.speed), ...(effect.electric && { ionization: round(peak.ionization), current: round(peak.current) }) },
    ...(liquid && { particles: run.maxParticles }), sparks: { spawned: totals.spawned, maxAlive: totals.maxAlive }, figures: columns(figures)
  };
}

// Reads a whole source and checks it as compileFluid does. Each effect is read in turn, checked against the frame
// limit, and passed to `each(name, effect, { width, height, path })`, which returns its frames' operations (or null to
// leave them empty, as a live runner does). The renderer then checks the recipe, so a live runner gets every check
// compileFluid makes before simulating, with the same paths and messages, except the work budget: compileFluid counts
// every frame of every effect before simulating it, while a live runner steps one frame at a time and bounds its warm-up.
function buildRecipe(source, each) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'symbols', 'anchor', 'effects', 'sheet'], 'fluid');
  if (source.format !== 'pixelforge-fluid' || source.version !== 1) fail('fluid', 'expected version-1 pixelforge-fluid');
  const palette = source.palette ?? {};
  if (!isObject(palette)) fail('fluid.palette', 'expected a palette object');
  const width = integer(source.width, 'fluid.width', 4, 128), height = integer(source.height, 'fluid.height', 4, 128);
  const symbols = source.symbols ?? {};
  if (!isObject(symbols)) fail('fluid.symbols', 'expected named symbols for obstacles');
  for (const [name, rows] of Object.entries(symbols)) {
    identifier(name, `fluid.symbols.${name}`);
    if (!Array.isArray(rows) || !rows.length || rows.length > 128 || typeof rows[0] !== 'string' || !rows[0].length || rows.some(row => typeof row !== 'string' || row.length !== rows[0].length)) fail(`fluid.symbols.${name}`, 'expected 1–128 equal-width text rows');
  }
  if (!isObject(source.effects) || !Object.keys(source.effects).length || Object.keys(source.effects).length > LIMITS.effects) fail('fluid.effects', `expected 1–${LIMITS.effects} named effects`);
  const frames = [], animations = {}, seen = new Set();
  for (const [name, value] of Object.entries(source.effects)) {
    const path = `fluid.effects.${name}`;
    identifier(name, path);
    // Effect names become animation and frame names, which must be unique ignoring case for portable bundles.
    if (seen.has(name.toLowerCase())) fail(path, 'effect names must be unique ignoring case; they name animations and frames');
    seen.add(name.toLowerCase());
    const effect = readEffect(value, path, { width, height, palette, symbols });
    if (frames.length + effect.frames > 256) fail('fluid.effects', `the effects make more than 256 frames; a recipe holds at most 256`);
    const ops = each(name, effect, { width, height, path });
    const names = effect.durations.map((duration, i) => {
      frames.push({ name: `${name}-${i}`, duration, ...(ops?.[i].length && { ops: ops[i] }) });
      return `${name}-${i}`;
    });
    animations[name] = { frames: names, ...(!effect.loop && { loop: false }) };
  }
  const recipe = { version: 1, name: source.name, width, height, palette, ...(Object.keys(symbols).length && { symbols }), ...(source.anchor !== undefined && { anchor: source.anchor }), frames, animations, ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject(recipe);
  return recipe;
}

// The recipe, figures for each effect, and `warnings` (only when there are any): setups that compile but make nothing or
// look stuck, each naming the field to change.
export function compileFluid(source) {
  const metadata = { format: 'pixelforge-fluid-metadata', version: 1, effects: {} }, warnings = [];
  let work = 0;
  const recipe = buildRecipe(source, (name, effect, context) => {
    // Bounded work, checked before each effect is simulated: about one update per cell per pressure sweep, per step,
    // summed over the source's effects. The presets need at most 61 million.
    work += context.width * context.height * simulatedFrames(effect) * effect.substeps * stepWork(effect);
    if (work > LIMITS.work) fail(context.path, `the simulations need about ${Math.round(work / 1e6)} million cell updates, more than ${LIMITS.work / 1e6} million; lower frames, warmup, substeps, iterations or the canvas size`);
    const run = simulate(effect, context);
    warnings.push(...effect.warnings);
    metadata.effects[name] = {
      kind: effect.kind, frames: effect.frames, loop: effect.loop, seed: effect.seed, steps: run.steps, ...(effect.loop && { warmup: effect.warmup, blend: effect.blend }),
      peak: run.peak, ...(run.particles !== undefined && { particles: run.particles }), sparks: run.sparks,
      pixels: run.output.map(frame => frame.pixels), ...(!effect.loop && { residue: run.output.at(-1).pixels }), figures: run.figures, ...(effect.warnings.length && { warnings: effect.warnings })
    };
    return run.output.map(frame => frame.ops);
  });
  return JSON.parse(JSON.stringify({ recipe, metadata, ...(warnings.length && { warnings }) }));
}

// ---- Live runner ------------------------------------------------------------------------------------------------------
// Live pushes and puffs draw from their own random streams, keyed apart from the emitters and whitewater.
const LIVE = 2000;
// Inputs waiting for the next step; past this, the oldest are dropped.
const QUEUED = 1024;
// Pointer-driven inputs clamp to their range instead of failing, so a fast flick can't throw mid-interaction.
const clamp = (value, path, min, max) => {
  if (typeof value !== 'number' || Number.isNaN(value)) fail(path, `expected a number (values beyond ${min} to ${max} are clamped)`);
  return value < min ? min : value > max ? max : value;
};
// A soft disc: 1 at its centre, falling smoothly to 0 at its rim.
const soft = (dx, dy, radius) => { const s = (dx * dx + dy * dy) / (radius * radius); return s >= 1 ? 0 : (1 - s) * (1 - s); };
// The renderer's alpha compositing (core.js), so render() draws exactly what a compiled frame shows.
function composite(data, at, color) {
  const a = color[3] / 255;
  if (a === 0) return;
  if (a === 1) { data.set(color, at); return; }
  const old = data[at + 3] / 255, out = a + old * (1 - a);
  for (let c = 0; c < 3; c++) data[at + c] = Math.round((color[c] * a + data[at + c] * old * (1 - a)) / out);
  data[at + 3] = Math.round(out * 255);
}

// Runs one effect of a source live, a frame at a time, for interactive pages: step it, push its flow, puff smoke or
// water into it, boost an emitter, and render the current frame with the effect's own look. The same source and the same
// calls give the same pixels in every engine. Emitters, pulses and orbits cycle with the frame number modulo the
// effect's frames, as a loop's do (a one-shot repeats); there is no seam to blend, and sparks join on every frame.
export function createLiveFluid(source, options = {}) {
  fields(options, ['effect', 'warmup'], 'live');
  const names = [];
  let chosen = null;
  const recipe = buildRecipe(source, (name, effect, context) => {
    names.push(name);
    if (!chosen && (options.effect ?? name) === name) chosen = { effect, ...context };
    return null;
  });
  if (!chosen) fail('live.effect', `no effect named ${JSON.stringify(options.effect)}; the source has ${names.join(', ')}`);
  const { effect, width, height, path } = chosen, { emitters, liquid, seed } = effect, N = width * height;
  const warmup = options.warmup === undefined ? effect.frames : integer(options.warmup, 'live.warmup', 0, 2048);
  // The warm-up runs before the runner returns, so it keeps compileFluid's work budget; stepping afterwards has none.
  const frameWork = N * effect.substeps * stepWork(effect);
  if (warmup * frameWork > LIMITS.work) fail('live.warmup', `warming up ${warmup} frames${options.warmup === undefined ? ' (the default: one cycle)' : ''} needs about ${Math.round(warmup * frameWork / 1e6)} million cell updates, more than ${LIMITS.work / 1e6} million; warm up at most ${Math.floor(LIMITS.work / frameWork)} frames, or lower substeps or iterations`);

  // Colours by palette key, and the obstacles stamped under and over the fluid, composited in a compiled frame's order.
  const palette = {}, colours = new Map();
  for (const [key, value] of Object.entries(recipe.palette)) {
    const rgba = parseColor(value);
    palette[key] = `#${rgba.slice(0, rgba[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('')}`;
    if (key.length === 1) colours.set(key.charCodeAt(0), rgba);
  }
  let under, underKeys, over, stamped = null;
  // The obstacles drawn under and over the fluid, for the layout the run has now.
  const stampLayers = layout => {
    under = new Uint8ClampedArray(N * 4); underKeys = new Uint16Array(N); over = []; stamped = layout.key;
    effect.obstacles.forEach((o, n) => {
      const at = layout.places[n];
      if (o.draw === 'none' || !at.show) return;
      recipe.symbols[o.symbol].forEach((row, j) => {
        if (at.y + j < 0 || at.y + j >= height) return;
        for (let i = Math.max(0, -at.x); i < Math.min(row.length, width - at.x); i++) {
          if (row[i] === '.' || row[i] === ' ') continue;
          const c = (at.y + j) * width + at.x + i, code = row.charCodeAt(i);
          if (o.draw === 'under') { composite(under, c * 4, colours.get(code)); underKeys[c] = code; } else over.push(c, code);
        }
      });
    });
  };

  const run = createRun(effect, width, height, path), { state } = run, boosts = emitters.map(() => ({ factor: 1, frames: 0 }));
  let t = 0, queue = [], overlay = [];
  const put = (x, y, code) => { if (x >= 0 && y >= 0 && x < width && y < height && !run.view.front[y * width + x]) overlay.push(y * width + x, code); };
  // One frame: the emitters (boosted), then the queued pushes and puffs in the order they were made, the solver, the
  // fields and the sparks. Live runs never stop at a limit: particles, sparks and droplets beyond it are not added, and
  // the limits compileFluid meets while simulating (and the renderer's drawing budget) are not checked.
  const advance = () => {
    const cycle = t % effect.frames;
    if (effect.moving) moveObstacles(run, cycle);
    const here = emitFrame(run, t, cycle, boosts.map(b => (b.frames ? b.factor : 1)));
    queue.forEach((input, n) => input(n));
    queue = [];
    solveFrame(run, cycle);
    fieldsOf(run);
    sparkFrame(run, here, cycle, true);
    overlay = [];
    drawSparks(run, put);
    for (const b of boosts) if (b.frames) b.frames--;
    t++;
  };
  const enqueue = input => {
    if (queue.length >= QUEUED) queue.shift();
    queue.push(input);
  };
  const spot = (input, path, keys) => {
    fields(input, keys, path);
    return [clamp(input.x, `${path}.x`, -256, 512), clamp(input.y, `${path}.y`, -256, 512), clamp(input.radius ?? 4, `${path}.radius`, 0.5, 64)];
  };
  // The cells or faces within `radius` of (x, y): columns i0..i1 and rows j0..j1 of an nx × ny lattice.
  const around = (x, y, radius, nx, ny) => [Math.max(0, Math.floor(x - radius)), Math.min(nx - 1, Math.ceil(x + radius)), Math.max(0, Math.floor(y - radius)), Math.min(ny - 1, Math.ceil(y + radius))];

  // A push adds velocity to the gas's faces, or to the liquid's particles, with a soft disc falloff.
  const push = (x, y, radius, vx, vy) => {
    if (liquid) {
      for (let k = 0; k < state.n; k++) { const w = soft(state.x[k] - x, state.y[k] - y, radius); if (w) { state.vx[k] += vx * w; state.vy[k] += vy * w; } }
      return;
    }
    const { W, H, u, v, uFixed, vFixed } = state.g;
    let [i0, i1, j0, j1] = around(x, y, radius, W + 1, H);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * (W + 1) + i, w = soft(i - x, j + 0.5 - y, radius); if (w && !uFixed[k]) u[k] += vx * w; }
    [i0, i1, j0, j1] = around(x, y, radius, W, H + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * W + i, w = soft(i + 0.5 - x, j - y, radius); if (w && !vFixed[k]) v[k] += vy * w; }
  };
  // A gas puff adds density and heat with a soft disc falloff (negative amounts take them away). A liquid puff works as
  // a liquid emitter's disc does: it fills its cells to `density` (the share filled) with still water, or drains that
  // share of the particles there when negative, with a soft one-pixel rim.
  const puff = (x, y, radius, density, temperature, n) => {
    if (state.heat) { state.heat.spawnFrozen = 0; state.heat.spawnEnergy = energyOf(state.heat.heat, state.heat.heat.ambient, false); }
    const { W, H, pixels: solid } = state.g, disc = { radius }, [i0, i1, j0, j1] = around(x, y, liquid ? radius + 1 : radius, W, H);
    if (!liquid) {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * W + i, w = soft(i + 0.5 - x, j + 0.5 - y, radius);
        if (!w || solid[c]) continue;
        state.d[c] += density * w; state.T[c] += temperature * w;
        if (state.d[c] < 0) state.d[c] = 0;
        if (state.T[c] < 0) state.T[c] = 0;
      }
    } else if (density < 0) {
      for (let k = state.n - 1; k >= 0; k--) { const w = coverage(disc, state.x[k] - x, state.y[k] - y); if (w && random(seed, LIVE, t, n, SALT.drain, state.id[k]) < -density * w) removeParticle(state, k); }
    } else {
      countCells(state);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * W + i, want = Math.floor(PER_CELL * density * coverage(disc, i + 0.5 - x, j + 0.5 - y) + 0.5);
        if (!solid[c] && want > state.cells[c] && !seedCell(state, i, j, want, state.cells[c], [0, 0], [seed, LIVE, t, n, i, j])) return;
      }
    }
  };

  const live = {
    width, height, kind: effect.kind, palette, frames: effect.frames, warnings: [...effect.warnings],
    // Frames simulated so far, warm-up included; the emitters are at frame `frame % frames` of their cycle.
    get frame() { return t; },
    get particles() { return liquid ? state.n : 0; },
    get sparks() { return run.sparks.length; },
    step(n = 1) {
      integer(n, 'step', 0, 2048);
      for (let k = 0; k < n; k++) advance();
      return live;
    },
    push(input) {
      const [x, y, radius] = spot(input, 'push', ['x', 'y', 'vx', 'vy', 'radius']);
      const vx = clamp(input.vx ?? 0, 'push.vx', -16, 16), vy = clamp(input.vy ?? 0, 'push.vy', -16, 16);
      enqueue(() => push(x, y, radius, vx, vy));
      return live;
    },
    puff(input) {
      const [x, y, radius] = spot(input, 'puff', ['x', 'y', 'radius', 'density', 'temperature']);
      if (liquid && input.temperature !== undefined) fail('puff.temperature', 'temperature drives gases; a liquid puff adds water');
      const density = clamp(input.density ?? 1, 'puff.density', liquid ? -1 : -16, liquid ? 1 : 16), temperature = clamp(input.temperature ?? 0, 'puff.temperature', -16, 16);
      enqueue(n => puff(x, y, radius, density, temperature, n));
      return live;
    },
    boost(name, strength, frames) {
      const named = emitters.filter(e => e.name !== undefined).map(e => e.name);
      if (!named.includes(name)) fail('boost.name', `no emitter named ${JSON.stringify(name)}; ${named.length ? `this effect's emitters are named ${[...new Set(named)].join(', ')}` : 'give the emitter a name in the source'}`);
      const factor = number(strength, 'boost.strength', 0, 16), count = integer(frames, 'boost.frames', 0, 65536);
      emitters.forEach((e, index) => { if (e.name === name) boosts[index] = { factor, frames: count }; });
      return live;
    },
    // Figures for the current frame, as the metadata's per-frame figures give them for a compiled effect.
    measure() {
      return measureFrame(drawFrame(run, width, height), run.base, run.view.solid, width, height, liquid ? state.n : null);
    },
    // The current frame: the look layers, cleanup and outline over the fields, sparks and whitewater over them, and the
    // obstacles stamped under or over, as a compiled frame draws them. `keys` names the topmost palette key drawn at each
    // pixel ('.' empty); where a translucent colour blends over another, the pixel is a mix and the key its top layer.
    // `fluid` marks with '#' the pixels the look layers drew the fluid on (under any spark, whitewater or decoration drawn
    // over it), so a page can tell the fluid from an outline, a spark or an obstacle drawn with the same palette key.
    render() {
      if (stamped !== run.layout.key) stampLayers(run.layout);
      const drawn = new Uint8Array(N), chars = drawFrame(run, width, height, drawn);
      for (let k = 0; k < overlay.length; k += 2) chars[overlay[k]] = overlay[k + 1];
      const rgba = under.slice(), codes = underKeys.slice();
      for (let c = 0; c < N; c++) if (chars[c]) { composite(rgba, c * 4, colours.get(chars[c])); codes[c] = chars[c]; }
      for (let k = 0; k < over.length; k += 2) { composite(rgba, over[k] * 4, colours.get(over[k + 1])); codes[over[k]] = over[k + 1]; }
      const keys = [], fluid = [];
      for (let j = 0; j < height; j++) { let row = ''; for (let i = 0; i < width; i++) { const code = codes[j * width + i]; row += code ? String.fromCharCode(code) : '.'; } keys.push(row); }
      for (let j = 0; j < height; j++) { let row = ''; for (let i = 0; i < width; i++) row += drawn[j * width + i] ? '#' : '.'; fluid.push(row); }
      return { rgba, keys, fluid };
    }
  };
  if (warmup) live.step(warmup); else fieldsOf(run);
  return live;
}
