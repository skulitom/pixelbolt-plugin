// Fluid effects compiled to ordinary, editable recipes. A pixelforge-fluid source names effects; each runs a small
// fluid simulation on a grid with one cell per canvas pixel and bakes every frame into palette `grid` operations on
// the source's own palette, so inspect, patch, overlay and export work unchanged and no colour outside the palette
// can appear. Gases (smoke, fire, steam, explosions, magic) use Stam-style stable fluids on a staggered grid:
// semi-Lagrangian advection (or MacCormack, for sharp edges), a fixed-iteration pressure solve, vorticity confinement,
// buoyancy from temperature, dissipation and cooling. Liquids (water, splashes, drips, potions) use FLIP particles
// (optionally APIC) on the same grid and pressure solve, with cohesion and adhesion. Either may be viscous: an implicit
// viscosity solve in stress form, so a thick fluid falls as fast as water and only resists shearing; and a liquid may
// have a yield stress, elastic below it and flowing above it, for mud and slime. Fields become pixels through palette
// ramps and ordered dither. Browser-compatible and deterministic: only + − × ÷ and sqrt, craft.js's polynomial
// trigonometry and seeded hash, a fixed timestep and fixed iteration counts.
// createLiveFluid runs the same simulation a frame at a time for interactive pages, with pushes, puffs and boosts.
import { PixelError, renderProject, parseColor } from './core.js';
import { fields } from './authoring.js';
import { patternProblem, ditherThreshold, cleanupIds, traceLine, random, sinDeg, cosDeg } from './craft.js';

export const FLUID_KINDS = ['gas', 'liquid'];
export const FLUID_FIELDS = ['density', 'temperature', 'speed', 'depth', 'light', 'shadow'];
export const FLUID_WALLS = ['left', 'right', 'top', 'bottom'];
const LIMITS = { effects: 16, emitters: 16, obstacles: 32, fills: 16, looks: 8, whitewater: 4, colors: 16, particles: 32768, sparks: 4096, work: 400000000 };
// No flow moves faster than this many pixels per frame; it keeps extreme settings finite without touching normal ones.
const MAX_SPEED = 32;
// Liquid particles per full cell, and the density at which a cell counts as liquid for depth and bubbles.
const PER_CELL = 4, LEVEL = 0.5;
// How far along a row the depth bands look for a shallower surface (see renderFields).
const DEPTH_REACH = 3;
// Salts keep each random draw independent, so changing one setting does not reshuffle the others.
const SALT = { flicker: 1, noiseX: 2, noiseY: 3, spawn: 4, jitterX: 5, jitterY: 6, drain: 7, sparks: 8, sparkX: 9, sparkY: 10, angle: 11, speed: 12, life: 13 };
// Whitewater layers draw from their own streams, keyed apart from the emitters (which are numbered from 0).
const WHITEWATER = 1000;
// Gas advection schemes and the thickest viscosity a source may ask for, in square pixels per frame.
const ADVECTION = ['smooth', 'sharp'];
const MAX_VISCOSITY = 64;
// A yield-stress liquid's elastic stiffness (stress per unit of strain, in square pixels per frame squared): stiff enough
// that a heap holding itself up sags by only a few hundredths, and solved implicitly, so it is stable at any timestep.
// Where it has yielded and flows, the viscosity solve gives it PLASTIC instead, which keeps that flow steady.
const STIFFNESS = 16, PLASTIC = 1;

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
  fields(value, ['count', 'life', 'colors', 'size', 'trail', 'angle', 'speed', 'gravity', 'drag', 'follow', 'pop'], path);
  if (!Array.isArray(value.colors) || !value.colors.length || value.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 1–${LIMITS.colors} palette keys, spread over each spark's life`);
  if (value.pop !== undefined && !liquid) fail(`${path}.pop`, 'pop bursts bubbles that reach the surface; it applies to liquids');
  return {
    count: number(value.count, `${path}.count`, 0.01, burst ? 256 : 16), life: range(value.life ?? [8, 16], `${path}.life`, 1, 256, true),
    colors: value.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette)),
    size: integer(value.size ?? 1, `${path}.size`, 1, 3), trail: value.trail === undefined ? false : boolean(value.trail, `${path}.trail`),
    angle: range(value.angle ?? [0, 360], `${path}.angle`, -3600, 3600), speed: range(value.speed ?? 0, `${path}.speed`, 0, 16),
    gravity: value.gravity === undefined ? [0, 0] : pair(value.gravity, `${path}.gravity`, -2, 2), drag: number(value.drag ?? 0.05, `${path}.drag`, 0, 1),
    follow: number(value.follow ?? 1, `${path}.follow`, 0, 2), pop: value.pop === undefined ? false : boolean(value.pop, `${path}.pop`)
  };
}

// Whitewater: spray and foam thrown off a liquid by its own motion. A particle at the surface throws a droplet where its
// velocity changes sharply within a frame (`impact`: a drop landing, a fall hitting a pool) or where it moves fast
// (`speed`: a stream shedding drops). Droplets are sparks; with follow 0 they are spray, otherwise foam on the flow.
function readWhitewater(layer, path, context, gravity) {
  const { palette } = context;
  fields(layer, ['impact', 'speed', 'chance', 'throw', 'spread', 'life', 'colors', 'size', 'trail', 'gravity', 'drag', 'follow'], path);
  if ((layer.impact === undefined) === (layer.speed === undefined)) fail(path, 'use exactly one of impact (water whose speed changes sharply, such as where a drop lands) or speed (fast water, such as a stream shedding drops)');
  if (!Array.isArray(layer.colors) || !layer.colors.length || layer.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 1–${LIMITS.colors} palette keys, spread over each droplet's life`);
  return {
    impact: layer.impact === undefined ? null : number(layer.impact, `${path}.impact`, 0.05, 32), speed: layer.speed === undefined ? null : number(layer.speed, `${path}.speed`, 0.05, 32),
    chance: number(layer.chance ?? 0.1, `${path}.chance`, 0.001, 1), throw: number(layer.throw ?? 1, `${path}.throw`, 0, 4), spread: number(layer.spread ?? 20, `${path}.spread`, 0, 180),
    life: range(layer.life ?? [6, 12], `${path}.life`, 1, 256, true), colors: layer.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette)),
    size: integer(layer.size ?? 1, `${path}.size`, 1, 3), trail: layer.trail === undefined ? false : boolean(layer.trail, `${path}.trail`),
    gravity: layer.gravity === undefined ? gravity : pair(layer.gravity, `${path}.gravity`, -2, 2), drag: number(layer.drag ?? 0.02, `${path}.drag`, 0, 1),
    follow: number(layer.follow ?? 0, `${path}.follow`, 0, 2), pop: false
  };
}

function readEmitter(emitter, path, context) {
  const { frames, loop, liquid } = context;
  fields(emitter, ['name', 'at', 'radius', 'area', 'burst', 'rate', 'start', 'end', 'density', 'temperature', 'falloff', 'velocity', 'expand', 'vortex', 'noise', 'flicker', 'pulse', 'orbit', 'sparks'], path);
  if (emitter.name !== undefined) identifier(emitter.name, `${path}.name`);
  if ((emitter.burst === undefined) === (emitter.rate === undefined)) fail(path, 'use exactly one of burst (added once, at start) or rate (added every frame from start until end)');
  const start = integer(emitter.start ?? 0, `${path}.start`, 0, frames - 1);
  if (emitter.end !== undefined && emitter.rate === undefined) fail(`${path}.end`, 'end applies to rate emitters');
  const end = integer(emitter.end ?? frames, `${path}.end`, start + 1, frames);
  if (emitter.radius !== undefined && emitter.area !== undefined) fail(path, 'use radius (a disc) or area (a box), not both');
  if (emitter.temperature !== undefined && liquid) fail(`${path}.temperature`, 'temperature drives gases; liquids fall by gravity');
  const burst = emitter.burst !== undefined;
  return {
    name: emitter.name, at: pair(emitter.at, `${path}.at`, -256, 512), start, end, burst,
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
    sparks: emitter.sparks === undefined ? null : readSparks(emitter.sparks, `${path}.sparks`, context, burst)
  };
}

function readLook(layer, path, context) {
  const { palette, liquid, seed } = context;
  fields(layer, ['field', 'colors', 'thresholds', 'dither', 'pattern'], path);
  if (!FLUID_FIELDS.includes(layer.field)) fail(`${path}.field`, `expected ${FLUID_FIELDS.join(', ')}`);
  if (layer.field === 'temperature' && liquid) fail(`${path}.field`, 'liquids have no temperature; use density, speed or depth');
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
  return { field: FLUID_FIELDS.indexOf(layer.field), colors: colors.map(key => key.charCodeAt(0)), thresholds, gaps: thresholds.map((t, i) => t - (i ? thresholds[i - 1] : 0)), dither: number(layer.dither ?? 0.5, `${path}.dither`, 0, 1), threshold: ditherThreshold(pattern, [0, 0], seed) };
}

// A disc (at, radius), a box (x, y, w, h), or both: their overlap, such as the lower half of a round flask.
function readShape(value, path, width, height) {
  const disc = value.at !== undefined || value.radius !== undefined, box = ['x', 'y', 'w', 'h'].some(key => value[key] !== undefined);
  if (!disc && !box) fail(path, 'expected at and radius (a disc), x, y, w and h (a box), or both (their overlap)');
  let inDisc = () => true, inBox = () => true;
  if (disc) {
    const at = pair(value.at, `${path}.at`, -256, 512), radius = number(value.radius, `${path}.radius`, 0.5, 128);
    inDisc = (x, y) => { const dx = x - at[0], dy = y - at[1]; return dx * dx + dy * dy <= radius * radius; };
  }
  if (box) {
    const x = integer(value.x, `${path}.x`, 0, width - 1), y = integer(value.y, `${path}.y`, 0, height - 1);
    const w = integer(value.w, `${path}.w`, 1, width - x), h = integer(value.h, `${path}.h`, 1, height - y);
    inBox = (px, py) => px >= x && py >= y && px < x + w && py < y + h;
  }
  return (x, y) => inDisc(x, y) && inBox(x, y);
}

function readEffect(effect, path, source) {
  const { width, height, palette, symbols } = source;
  fields(effect, ['kind', 'frames', 'duration', 'loop', 'seed', 'warmup', 'blend', 'substeps', 'iterations', 'buoyancy', 'weight', 'vorticity', 'dissipation', 'cooling', 'drag', 'wind', 'advection', 'viscosity', 'yield', 'slip', 'gravity', 'flip', 'apic', 'tension', 'adhesion', 'fill', 'walls', 'obstacles', 'emitters', 'look', 'whitewater', 'light', 'outline', 'cleanup'], path);
  const kind = effect.kind ?? 'gas';
  if (!FLUID_KINDS.includes(kind)) fail(`${path}.kind`, 'expected gas (smoke, fire, steam, magic) or liquid (water, potions)');
  const liquid = kind === 'liquid';
  if (liquid && effect.advection !== undefined) fail(`${path}.advection`, 'advection applies to gases; a liquid\'s particles carry it');
  for (const key of liquid ? ['buoyancy', 'weight', 'vorticity', 'dissipation', 'cooling', 'wind'] : ['gravity', 'flip', 'apic', 'tension', 'adhesion', 'yield', 'fill']) {
    if (effect[key] !== undefined) fail(`${path}.${key}`, liquid ? `${key} applies to gases; liquids fall by gravity and keep their volume` : `${key} applies to liquids; gases rise by buoyancy`);
  }
  const advection = effect.advection ?? 'smooth';
  if (!ADVECTION.includes(advection)) fail(`${path}.advection`, 'expected smooth (plain semi-Lagrangian, the default) or sharp (MacCormack with a limiter: crisper edges and swirls)');
  const viscosity = number(effect.viscosity ?? 0, `${path}.viscosity`, 0, MAX_VISCOSITY), yieldStress = liquid ? number(effect.yield ?? 0, `${path}.yield`, 0, 16) : 0;
  if (effect.slip !== undefined && !viscosity && !yieldStress) fail(`${path}.slip`, `slip lets a thick fluid slide along walls and obstacles instead of being held by them; set viscosity${liquid ? ' or yield' : ''}`);
  if (!liquid && effect.whitewater !== undefined) fail(`${path}.whitewater`, 'whitewater is spray and foam thrown off a liquid; it applies to liquids');
  const frames = integer(effect.frames, `${path}.frames`, 1, 256), loop = effect.loop === undefined ? false : boolean(effect.loop, `${path}.loop`);
  const durations = Array.isArray(effect.duration)
    ? (effect.duration.length === frames ? effect.duration.map((d, i) => integer(d, `${path}.duration[${i}]`, 1, 60000)) : fail(`${path}.duration`, `expected one duration or ${frames}`))
    : Array(frames).fill(integer(effect.duration ?? 80, `${path}.duration`, 1, 60000));
  if (!loop) for (const key of ['warmup', 'blend']) if (effect[key] !== undefined) fail(`${path}.${key}`, `${key} shapes the seam of a looping effect; set loop: true`);
  if (loop && frames < 4) fail(`${path}.frames`, 'a looping effect needs at least 4 frames');
  const seed = integer(effect.seed ?? 1, `${path}.seed`, 0, 2147483647);
  const context = { frames, loop, liquid, palette, seed };
  const solid = new Uint8Array(width * height), front = new Uint8Array(width * height), obstacles = [];
  const listed = (value, key, max) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) fail(`${path}.${key}`, `expected a list of at most ${max} entries`);
    return value;
  };
  listed(effect.obstacles, 'obstacles', LIMITS.obstacles).forEach((obstacle, i) => {
    const op = `${path}.obstacles[${i}]`;
    fields(obstacle, ['symbol', 'x', 'y', 'draw'], op);
    if (typeof obstacle.symbol !== 'string' || !Object.hasOwn(symbols, obstacle.symbol)) fail(`${op}.symbol`, `unknown symbol ${JSON.stringify(obstacle.symbol)}`);
    const rows = symbols[obstacle.symbol], x = integer(obstacle.x ?? 0, `${op}.x`, 0, width - 1), y = integer(obstacle.y ?? 0, `${op}.y`, 0, height - 1);
    if (x + rows[0].length > width || y + rows.length > height) fail(op, `the ${rows[0].length} × ${rows.length} symbol must fit inside the ${width} × ${height} canvas`);
    const draw = obstacle.draw ?? 'over';
    if (!['over', 'under', 'none'].includes(draw)) fail(`${op}.draw`, 'expected over (drawn in front of the fluid), under or none (an invisible wall)');
    rows.forEach((row, j) => { for (let k = 0; k < row.length; k++) if (row[k] !== '.' && row[k] !== ' ') { solid[(y + j) * width + x + k] = 1; if (draw === 'over') front[(y + j) * width + x + k] = 1; } });
    obstacles.push({ symbol: obstacle.symbol, x, y, draw });
  });
  const walls = listed(effect.walls, 'walls', 4).map((edge, i) => {
    if (!FLUID_WALLS.includes(edge)) fail(`${path}.walls[${i}]`, `expected ${FLUID_WALLS.join(', ')}`);
    return edge;
  });
  if (new Set(walls).size !== walls.length) fail(`${path}.walls`, 'each edge is listed once');
  const fills = listed(effect.fill, 'fill', LIMITS.fills).map((entry, i) => {
    const fp = `${path}.fill[${i}]`;
    fields(entry, ['x', 'y', 'w', 'h', 'at', 'radius', 'velocity'], fp);
    return { inside: readShape(entry, fp, width, height), velocity: entry.velocity === undefined ? [0, 0] : pair(entry.velocity, `${fp}.velocity`, -16, 16) };
  });
  if (!Array.isArray(effect.emitters) || effect.emitters.length > LIMITS.emitters || (!effect.emitters.length && !fills.length)) fail(`${path}.emitters`, `expected 1–${LIMITS.emitters} emitters${liquid ? ' (or none, with a fill)' : ''}`);
  const emitters = effect.emitters.map((emitter, i) => readEmitter(emitter, `${path}.emitters[${i}]`, context));
  if (!Array.isArray(effect.look) || !effect.look.length || effect.look.length > LIMITS.looks) fail(`${path}.look`, `expected 1–${LIMITS.looks} layers that map a field to palette colours`);
  const look = effect.look.map((layer, i) => readLook(layer, `${path}.look[${i}]`, context));
  const gravity = effect.gravity === undefined ? [0, 0.3] : pair(effect.gravity, `${path}.gravity`, -2, 2);
  const whitewater = listed(effect.whitewater, 'whitewater', LIMITS.whitewater).map((layer, i) => readWhitewater(layer, `${path}.whitewater[${i}]`, context, gravity));
  let cleanup = { strays: false, corners: false };
  if (effect.cleanup !== undefined) {
    fields(effect.cleanup, ['strays', 'corners'], `${path}.cleanup`);
    cleanup = { strays: effect.cleanup.strays === undefined ? false : boolean(effect.cleanup.strays, `${path}.cleanup.strays`), corners: effect.cleanup.corners === undefined ? false : boolean(effect.cleanup.corners, `${path}.cleanup.corners`) };
  }
  const light = effect.light === undefined ? [-1, -1] : pair(effect.light, `${path}.light`, -1, 1), reachLight = Math.sqrt(light[0] * light[0] + light[1] * light[1]);
  if (!reachLight) fail(`${path}.light`, 'expected a direction toward the light, such as [-1, -1] for the upper left');
  return {
    kind, liquid, frames, durations, light: [light[0] / reachLight, light[1] / reachLight], loop, seed, emitters, look, whitewater, obstacles, solid, front, walls: Object.fromEntries(FLUID_WALLS.map(edge => [edge, walls.includes(edge)])), fills, cleanup,
    warmup: loop ? integer(effect.warmup ?? 2, `${path}.warmup`, 1, 8) : 0,
    blend: loop ? integer(effect.blend ?? Math.max(1, Math.min(8, Math.floor(frames / 3))), `${path}.blend`, 1, Math.floor(frames / 2)) : 0,
    substeps: integer(effect.substeps ?? 2, `${path}.substeps`, 1, 4), iterations: integer(effect.iterations ?? (liquid ? 40 : 30), `${path}.iterations`, 1, 200),
    buoyancy: number(effect.buoyancy ?? 0.15, `${path}.buoyancy`, -2, 2), weight: number(effect.weight ?? 0, `${path}.weight`, -2, 2),
    vorticity: number(effect.vorticity ?? 0.25, `${path}.vorticity`, 0, 2), dissipation: number(effect.dissipation ?? 0.03, `${path}.dissipation`, 0, 1),
    cooling: number(effect.cooling ?? 0.08, `${path}.cooling`, 0, 1), drag: number(effect.drag ?? (liquid ? 0 : 0.02), `${path}.drag`, 0, 1),
    wind: effect.wind === undefined ? [0, 0] : pair(effect.wind, `${path}.wind`, -2, 2), gravity, sharp: advection === 'sharp',
    viscosity, yield: yieldStress, slip: effect.slip === undefined ? false : boolean(effect.slip, `${path}.slip`),
    flip: number(effect.flip ?? 0.9, `${path}.flip`, 0, 1), apic: effect.apic === undefined ? false : boolean(effect.apic, `${path}.apic`),
    tension: number(effect.tension ?? 0.5, `${path}.tension`, 0, 4), adhesion: liquid ? number(effect.adhesion ?? 0, `${path}.adhesion`, 0, 4) : 0,
    outline: effect.outline === undefined ? 0 : paletteKey(effect.outline, `${path}.outline`, palette).charCodeAt(0)
  };
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

function createGrid(width, height, solid, walls) {
  const W = width, H = height, N = W * H, U = (W + 1) * H, V = W * (H + 1);
  // Faces against an obstacle or a closed edge carry no flow.
  const uFixed = new Uint8Array(U), vFixed = new Uint8Array(V);
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    uFixed[j * (W + 1) + i] = i === 0 ? (walls.left || solid[j * W] ? 1 : 0) : i === W ? (walls.right || solid[j * W + W - 1] ? 1 : 0) : (solid[j * W + i - 1] || solid[j * W + i] ? 1 : 0);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    vFixed[j * W + i] = j === 0 ? (walls.top || solid[i] ? 1 : 0) : j === H ? (walls.bottom || solid[(H - 1) * W + i] ? 1 : 0) : (solid[(j - 1) * W + i] || solid[j * W + i] ? 1 : 0);
  }
  return {
    W, H, N, solid, walls, uFixed, vFixed,
    u: new Float64Array(U), v: new Float64Array(V), u0: new Float64Array(U), v0: new Float64Array(V),
    p: new Float64Array(N), div: new Float64Array(N), count: new Uint8Array(N)
  };
}
const sampleU = (g, a, x, y) => bilinear(a, g.W + 1, g.H, x, y - 0.5);
const sampleV = (g, a, x, y) => bilinear(a, g.W, g.H + 1, x - 0.5, y);
function enforce(g) {
  const { u, v, uFixed, vFixed } = g;
  for (let k = 0; k < u.length; k++) if (uFixed[k]) u[k] = 0;
  for (let k = 0; k < v.length; k++) if (vFixed[k]) v[k] = 0;
}

// Makes the flow divergence-free over the active cells (every open cell for a gas, the cells holding particles for a
// liquid) with a fixed number of over-relaxed Gauss-Seidel sweeps. Obstacles and closed edges are walls; open edges
// and air cells hold zero pressure. `target` asks a cell to spread by that much (crowded liquid particles).
function project(g, active, iterations, target) {
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
  const { W, H } = g, { mu, node, uLive, vLive, sxx, syy, sxy } = g.visc, X = W + 1;
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
  cornerMean(g, mu, effect.slip, node);
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
    const k = j * X + i, l = i > 0 ? mu[j * W + i - 1] : 0, r = i < W ? mu[j * W + i] : 0;
    uLive[k] = !uFixed[k] && ((i > 0 && kind[j * W + i - 1] === FLUID) || (i < W && kind[j * W + i] === FLUID)) ? 1 : 0;
    if (uLive[k]) du[k] = 1 + dt * (2 * l + 2 * r + node[k] + node[k + X]);
  }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, t = j > 0 ? mu[k - W] : 0, b = j < H ? mu[k] : 0;
    vLive[k] = !vFixed[k] && ((j > 0 && kind[k - W] === FLUID) || (j < H && kind[k] === FLUID)) ? 1 : 0;
    if (vLive[k]) dv[k] = 1 + dt * (2 * t + 2 * b + node[j * X + i] + node[j * X + i + 1]);
  }
  // Conjugate gradients from the current velocities, so b = x and the first residual is x − A x.
  const { ru, rv, zu, zv, pu, pv, qu, qv } = w;
  applyViscosity(g, dt, u, v, qu, qv);
  let rz = 0;
  for (let k = 0; k < u.length; k++) { if (uLive[k]) { ru[k] = u[k] - qu[k]; zu[k] = ru[k] / du[k]; pu[k] = zu[k]; rz += ru[k] * zu[k]; } else pu[k] = 0; }
  for (let k = 0; k < v.length; k++) { if (vLive[k]) { rv[k] = v[k] - qv[k]; zv[k] = rv[k] / dv[k]; pv[k] = zv[k]; rz += rv[k] * zv[k]; } else pv[k] = 0; }
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
function strainRates(state) {
  const { g, fluid, strain } = state, { W, H, u, v } = g, { ra, rb, spin } = strain, X = W + 1;
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
  const { W, H, u, v, solid } = g, { d, T, source } = state, here = emitterState(e, index, cycle, seed, along, factor), { x, y, flicker } = here, r = reach(e);
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
  if (x0 > x1 || y0 > y1) return here;
  // A burst adds its amounts once; a rate emitter raises its cells toward them every frame (a negative amount drains),
  // so a steady source holds its level instead of piling up.
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

// ---- Gas --------------------------------------------------------------------------------------------------------------
function createGas(effect, width, height) {
  const g = createGrid(width, height, effect.solid, effect.walls), N = g.N;
  const state = { g, d: new Float64Array(N), T: new Float64Array(N), source: new Float64Array(N), d1: new Float64Array(N), T1: new Float64Array(N), curl: new Float64Array(N), magnitude: new Float64Array(N), open: new Uint8Array(N) };
  for (let c = 0; c < N; c++) state.open[c] = effect.solid[c] ? 0 : 1;
  return state;
}
function stepGas(state, effect, dt) {
  const { g, d, T, d1, T1 } = state, { W, H, u, v } = g;
  // Buoyancy lifts hot cells (y is down) and density weighs smoke down; wind pushes everything.
  if (effect.buoyancy || effect.weight || effect.wind[1]) for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, a = (j - 1) * W + i, b = j * W + i;
    v[k] += dt * (-effect.buoyancy * (T[a] + T[b]) * 0.5 + effect.weight * (d[a] + d[b]) * 0.5 + effect.wind[1]);
  }
  if (effect.wind[0]) for (let k = 0; k < u.length; k++) u[k] += dt * effect.wind[0];
  if (effect.vorticity) confine(g, effect.vorticity, dt, state.curl, state.magnitude);
  enforce(g);
  advectVelocity(g, dt);
  if (effect.sharp) sharpenVelocity(g, dt);
  if (effect.drag) { const keep = 1 - effect.drag * dt; for (let k = 0; k < u.length; k++) u[k] *= keep; for (let k = 0; k < v.length; k++) v[k] *= keep; }
  enforce(g);
  if (effect.viscosity) viscous(g, state.open, effect, dt);
  project(g, state.open, effect.iterations, state.source);
  for (const a of [u, v]) for (let k = 0; k < a.length; k++) { if (a[k] > MAX_SPEED) a[k] = MAX_SPEED; else if (a[k] < -MAX_SPEED) a[k] = -MAX_SPEED; }
  advectScalars(g, dt, [[d, d1], [T, T1]], effect.sharp);
  const fade = 1 - effect.dissipation * dt, cool = 1 - effect.cooling * dt;
  for (let c = 0; c < g.N; c++) { d[c] = d1[c] * fade; T[c] = T1[c] * cool; }
}
function gasFields(state, out) {
  const { g, d, T } = state, { W, H, u, v } = g, [density, temperature, speed] = out;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i, x = (u[j * (W + 1) + i] + u[j * (W + 1) + i + 1]) * 0.5, y = (v[j * W + i] + v[(j + 1) * W + i]) * 0.5;
    density[c] = d[c]; temperature[c] = T[c]; speed[c] = Math.sqrt(x * x + y * y);
  }
}

// ---- Liquid -----------------------------------------------------------------------------------------------------------
function createLiquid(effect, width, height) {
  const g = createGrid(width, height, effect.solid, effect.walls), N = g.N, U = g.u.length, V = g.v.length;
  const state = {
    g, n: 0, next: 0, x: new Float64Array(1024), y: new Float64Array(1024), vx: new Float64Array(1024), vy: new Float64Array(1024), id: new Float64Array(1024),
    pvx: new Float64Array(1024), pvy: new Float64Array(1024),
    uw: new Float64Array(U), vw: new Float64Array(V), uOld: new Float64Array(U), vOld: new Float64Array(V), uValid: new Uint8Array(U), vValid: new Uint8Array(V),
    fluid: new Uint8Array(N), cells: new Uint16Array(N), target: new Float64Array(N), splat: new Float64Array(N), blur: new Float64Array(N), speedSum: new Float64Array(N),
    cux: new Float64Array(1024), cuy: new Float64Array(1024), cvx: new Float64Array(1024), cvy: new Float64Array(1024), ea: new Float64Array(1024), eb: new Float64Array(1024), apic: effect.apic,
    cling: effect.adhesion ? clingField(g) : null, pressure: effect.viscosity || effect.yield ? new Float64Array(N) : null,
    strain: effect.yield ? { a: new Float64Array(N), b: new Float64Array(N), count: new Float64Array(N), stiff: new Float64Array(N), shear: new Float64Array((width + 1) * (height + 1)), ra: new Float64Array(N), rb: new Float64Array(N), spin: new Float64Array(N) } : null
  };
  return state;
}
// Adhesion makes the liquid hold on to walls and obstacles (and anything beyond a closed edge). A pull toward them would
// do nothing, since the pressure solve takes away any pull that is the slope of a field, so instead a particle within a
// cell of a solid holds on to it, as static friction holds: it does not move away from the solid unless it is pulled
// away faster than 2 × adhesion × closeness pixels per frame, and then only by the excess. Closeness is the solids
// blurred over a cell, ¼ in the middle of a cell beside a solid. Particles still slide along a solid freely, so a film
// stays under a ledge, on a spoon or down a jar's side while the rest of the liquid falls or drains away.
function clingField(g) {
  const { W, H, solid, walls } = g, field = new Float64Array(W * H);
  const solidAt = (x, y) => (x < 0 ? walls.left : x >= W ? walls.right : y < 0 ? walls.top : y >= H ? walls.bottom : solid[y * W + x]) ? 1 : 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += solidAt(i + di, j + dj) * (di ? 1 : 2) * (dj ? 1 : 2);
    field[j * W + i] = sum / 16;
  }
  return field;
}
// A particle's position, velocity, id, its velocity before this frame's steps (for whitewater impacts), for APIC the
// slopes of the flow around it (du/dx, du/dy, dv/dx, dv/dy), and for yield stress its strain (stretch, shear).
const PARTICLE_KEYS = ['x', 'y', 'vx', 'vy', 'id', 'pvx', 'pvy', 'cux', 'cuy', 'cvx', 'cvy', 'ea', 'eb'];
function addParticle(state, x, y, vx, vy) {
  if (state.n === state.x.length) {
    if (state.n >= LIMITS.particles) { state.full = true; return false; }
    for (const key of PARTICLE_KEYS) { const grown = new Float64Array(Math.min(LIMITS.particles, state.n * 2)); grown.set(state[key]); state[key] = grown; }
  }
  const k = state.n++;
  state.x[k] = x; state.y[k] = y; state.vx[k] = vx; state.vy[k] = vy; state.id[k] = state.next++; state.pvx[k] = vx; state.pvy[k] = vy;
  state.cux[k] = 0; state.cuy[k] = 0; state.cvx[k] = 0; state.cvy[k] = 0; state.ea[k] = 0; state.eb[k] = 0;
  return true;
}
function removeParticle(state, k) {
  const last = --state.n;
  for (const key of PARTICLE_KEYS) state[key][k] = state[key][last];
}
function countCells(state) {
  const { g, cells } = state, { W, H } = g;
  cells.fill(0);
  for (let k = 0; k < state.n; k++) {
    const i = Math.floor(state.x[k]), j = Math.floor(state.y[k]);
    if (i >= 0 && j >= 0 && i < W && j < H && cells[j * W + i] < 65535) cells[j * W + i]++;
  }
}
// Places up to `want` particles in a cell on a jittered 2 × 2 pattern, keyed so the same source fills the same way.
function seedCell(state, i, j, want, have, velocity, key) {
  for (let k = have; k < want; k++) {
    const sx = (k % 2) * 0.5, sy = (Math.floor(k / 2) % 2) * 0.5;
    if (!addParticle(state, i + sx + 0.05 + 0.4 * random(...key, k, SALT.jitterX), j + sy + 0.05 + 0.4 * random(...key, k, SALT.jitterY), velocity[0], velocity[1])) return false;
  }
  return true;
}
function fillLiquid(state, effect) {
  const { g } = state, { W, H, solid } = g;
  effect.fills.forEach((fill, f) => {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (!solid[j * W + i] && fill.inside(i + 0.5, j + 0.5)) seedCell(state, i, j, PER_CELL, 0, fill.velocity, [effect.seed, 1000 + f, i, j]);
  });
}
function emitLiquid(state, e, index, cycle, seed, along = cycle, factor = 1) {
  const { g } = state, { W, H, solid } = g, here = emitterState(e, index, cycle, seed, along, factor), { x, y, flicker } = here, r = reach(e);
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
  const velocityAt = (px, py) => [push(e, px - x, py - y, 0, e.expand), push(e, px - x, py - y, 1, e.expand)];
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
// Adds `value` to the four lattice points around (fx, fy) with bilinear weights, and the weights to `weights`.
function splat(a, weights, nx, ny, fx, fy, value) {
  const i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j;
  const add = (x, y, w) => { if (x >= 0 && y >= 0 && x < nx && y < ny && w) { a[y * nx + x] += w * value; weights[y * nx + x] += w; } };
  add(i, j, (1 - s) * (1 - t)); add(i + 1, j, s * (1 - t)); add(i, j + 1, (1 - s) * t); add(i + 1, j + 1, s * t);
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
  for (let k = 0; k < state.n; k++) {
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
  for (let k = 0; k < u.length; k++) { if (uw[k] > 0) u[k] /= uw[k]; uValid[k] = uw[k] > 0 || g.uFixed[k] ? 1 : 0; }
  for (let k = 0; k < v.length; k++) { if (vw[k] > 0) v[k] /= vw[k]; vValid[k] = vw[k] > 0 || g.vFixed[k] ? 1 : 0; }
  enforce(g);
  extrapolate(u, uValid, W + 1, H, 2); extrapolate(v, vValid, W, H + 1, 2);
}
function stepLiquid(state, effect, dt) {
  const { g, fluid, target, uOld, vOld } = state, { W, H, u, v, solid, walls } = g;
  transfer(state);
  uOld.set(u); vOld.set(v);
  for (let k = 0; k < u.length; k++) u[k] += dt * effect.gravity[0];
  for (let k = 0; k < v.length; k++) v[k] += dt * effect.gravity[1];
  if (effect.drag) { const keep = 1 - effect.drag * dt; for (let k = 0; k < u.length; k++) u[k] *= keep; for (let k = 0; k < v.length; k++) v[k] *= keep; }
  if (effect.yield) strainForce(state, effect, dt);
  enforce(g);
  // Crowded cells spread and sparse cells inside the liquid draw particles in, so splashes neither shrink the volume nor
  // thin it out into a larger, emptier one. Cells on the surface only spread.
  countCells(state);
  const wet = c => solid[c] || fluid[c];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i, error = state.cells[c] / PER_CELL - 1;
    const interior = fluid[c] && (i > 0 ? wet(c - 1) : walls.left) && (i < W - 1 ? wet(c + 1) : walls.right) && (j > 0 ? wet(c - W) : walls.top) && (j < H - 1 ? wet(c + W) : walls.bottom);
    target[c] = error > 0 || interior ? 0.5 * error : 0;
  }
  project(g, fluid, effect.iterations, target);
  // A thick liquid resists the flow the pressure solve has just made (a heap slumping under its own weight) before it
  // moves, then is made divergence-free again. That second solve starts from no pressure and leaves the first's in
  // place to start the next step from.
  const thick = effect.viscosity || effect.yield;
  if (thick) {
    viscous(g, fluid, effect, dt, effect.yield ? state.strain.stiff : null);
    state.pressure.set(g.p); g.p.fill(0);
    project(g, fluid, effect.iterations, target);
    g.p.set(state.pressure);
  }
  const uValid = new Uint8Array(state.uValid.length), vValid = new Uint8Array(state.vValid.length);
  for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) { const k = j * (W + 1) + i; uValid[k] = g.uFixed[k] || (i > 0 && fluid[j * W + i - 1]) || (i < W && fluid[j * W + i]) ? 1 : 0; }
  for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) { const k = j * W + i; vValid[k] = g.vFixed[k] || (j > 0 && fluid[(j - 1) * W + i]) || (j < H && fluid[j * W + i]) ? 1 : 0; }
  extrapolate(u, uValid, W + 1, H, 3); extrapolate(v, vValid, W, H + 1, 3);
  // Cohesion: particles are drawn up the smoothed density gradient, which only matters at the surface (inside, the
  // density is level). Drops hold together and thin sheets gather into strands instead of drifting apart as mist.
  const rho = state.blur;
  if (effect.tension) for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0, weights = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      // Obstacles take no part, so liquid neither clings to walls nor shies away from them.
      if (x < 0 || y < 0 || x >= W || y >= H || solid[y * W + x]) continue;
      const w = (di ? 1 : 2) * (dj ? 1 : 2);
      sum += state.cells[y * W + x] * w; weights += w;
    }
    rho[j * W + i] = weights ? sum / weights / PER_CELL : 0;
  }
  // FLIP: particles keep their own velocity plus the grid's change, blended with the grid velocity (PIC) to calm noise.
  // In a thick liquid a particle's own jitter, finer than the grid, fades as the grid's finest ripples do under its
  // viscosity, so the FLIP share shrinks where the liquid is thick. With APIC the grid share also hands each particle the
  // slopes of the flow around it, which it carries and hands back, so the calm share keeps swirls instead of smearing them.
  const flip = effect.flip, pull = effect.tension * dt * 0.5, mu = thick ? g.visc.mu : null, cling = state.cling, normal = cling ? new Float64Array(2) : null;
  const slopes = state.apic ? new Float64Array(2) : null, limit = effect.yield / (2 * STIFFNESS);
  if (limit) strainRates(state);
  for (let k = state.n - 1; k >= 0; k--) {
    let x = state.x[k], y = state.y[k];
    const pu = sampleU(g, u, x, y), pv = sampleV(g, v, x, y), share = mu ? flip / (1 + 8 * dt * mu[Math.floor(y) * W + Math.floor(x)]) : flip;
    state.vx[k] = share * (state.vx[k] + pu - sampleU(g, uOld, x, y)) + (1 - share) * pu;
    state.vy[k] = share * (state.vy[k] + pv - sampleV(g, vOld, x, y)) + (1 - share) * pv;
    if (slopes) {
      slope(u, W + 1, H, x, y - 0.5, slopes); state.cux[k] = slopes[0]; state.cuy[k] = slopes[1];
      slope(v, W, H + 1, x - 0.5, y, slopes); state.cvx[k] = slopes[0]; state.cvy[k] = slopes[1];
    }
    // Yield stress: the particle's strain grows by this step's rate of strain, turns with the flow, and is capped at the
    // yield strain; strain beyond the cap is plastic flow, which the liquid does not spring back from.
    if (limit) {
      const c = Math.floor(y) * W + Math.floor(x), { ra, rb, spin } = state.strain, ea = state.ea[k], eb = state.eb[k];
      let na = ea + dt * (ra[c] - spin[c] * eb), nb = eb + dt * (rb[c] + spin[c] * ea);
      const size = na * na + nb * nb;
      if (size > limit * limit) { const scale = limit / Math.sqrt(size); na *= scale; nb *= scale; }
      state.ea[k] = na; state.eb[k] = nb;
    }
    if (pull) {
      const fx = x - 0.5, fy = y - 0.5;
      state.vx[k] += pull * (bilinear(rho, W, H, fx + 1, fy) - bilinear(rho, W, H, fx - 1, fy));
      state.vy[k] += pull * (bilinear(rho, W, H, fx, fy + 1) - bilinear(rho, W, H, fx, fy - 1));
    }
    // The speed cap comes last, so cohesion cannot push a particle past it.
    if (state.vx[k] > MAX_SPEED) state.vx[k] = MAX_SPEED; else if (state.vx[k] < -MAX_SPEED) state.vx[k] = -MAX_SPEED;
    if (state.vy[k] > MAX_SPEED) state.vy[k] = MAX_SPEED; else if (state.vy[k] < -MAX_SPEED) state.vy[k] = -MAX_SPEED;
    const mx = x + 0.5 * dt * pu, my = y + 0.5 * dt * pv;
    let nx = x + dt * sampleU(g, u, mx, my), ny = y + dt * sampleV(g, v, mx, my);
    if (cling) {
      const close = bilinear(cling, W, H, x - 0.5, y - 0.5);
      slope(cling, W, H, x - 0.5, y - 0.5, normal);
      const length = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1]);
      if (close > 0 && length > 0) {
        const ux = normal[0] / length, uy = normal[1] / length, hold = 2 * effect.adhesion * close;
        const away = (nx - x) * ux + (ny - y) * uy, leaving = state.vx[k] * ux + state.vy[k] * uy;
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
    // speed into it.
    const blocked = (px, py) => crossesSolid(solid, W, H, x, y, px, py);
    if (blocked(nx, ny)) {
      if (!blocked(nx, y)) { ny = y; state.vy[k] = 0; }
      else if (!blocked(x, ny)) { nx = x; state.vx[k] = 0; }
      else { nx = x; ny = y; state.vx[k] = 0; state.vy[k] = 0; }
    }
    state.x[k] = nx; state.y[k] = ny;
  }
}
function liquidFields(state, out) {
  const { g, splat: count, blur, speedSum } = state, { W, H, solid } = g, [density, , speed] = out;
  count.fill(0); speedSum.fill(0);
  for (let k = 0; k < state.n; k++) splat(speedSum, count, W, H, state.x[k] - 0.5, state.y[k] - 0.5, Math.sqrt(state.vx[k] * state.vx[k] + state.vy[k] * state.vy[k]));
  // A light 3 × 3 blur turns particles into a continuous surface.
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let sum = 0, weights = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const w = (di ? 1 : 2) * (dj ? 1 : 2);
      sum += count[y * W + x] * w; weights += w;
    }
    blur[j * W + i] = sum / weights;
  }
  // Speed only counts where there is some water (a quarter of a full cell), so a thin, fast stream or a falling drop
  // can be drawn by its speed without a halo around every particle.
  for (let c = 0; c < g.N; c++) { density[c] = solid[c] ? 0 : blur[c] / PER_CELL; speed[c] = count[c] > 0 && density[c] >= 0.25 ? speedSum[c] / count[c] : 0; }
}

// ---- Sparks -----------------------------------------------------------------------------------------------------------
// Single pixels carried by the flow: embers, sparkles, debris, bubbles. A looping effect spawns them during the
// recorded cycle only and draws the part of a life that runs past the end at the start, so they loop exactly.
function spawnSparks(list, e, index, cycle, here, seed, total) {
  // The count follows the emitter's pulse and flicker, rounded up or down by a seeded draw.
  const s = e.sparks, n = Math.floor(s.count * here.flicker(here.x, here.y) / e.strength + random(seed, index, cycle, SALT.sparks));
  for (let k = 0; k < n; k++) {
    if (total.alive >= LIMITS.sparks) return false;
    const r = salt => random(seed, index, cycle, k, salt);
    let x = here.x, y = here.y;
    if (e.radius !== null) { const d = e.radius * Math.sqrt(r(SALT.sparkX)), a = 360 * r(SALT.sparkY); x += d * cosDeg(a); y += d * sinDeg(a); }
    else { x += (r(SALT.sparkX) - 0.5) * e.area[0]; y += (r(SALT.sparkY) - 0.5) * e.area[1]; }
    const angle = pick(s.angle, r(SALT.angle)), speed = pick(s.speed, r(SALT.speed));
    list.push({ s, x, y, vx: cosDeg(angle) * speed, vy: sinDeg(angle) * speed, age: 0, life: pickWhole(s.life, r(SALT.life)) });
    total.alive++; total.spawned++;
  }
  return true;
}
// In a liquid, spray (sparks that ignore the flow) that has left the water ends where it falls back in, and a bubble
// that leaves it pops: it is drawn as a ring for one frame and as two droplets the next.
const sparkColor = p => p.s.colors[Math.min(p.s.colors.length - 1, Math.floor(p.age * p.s.colors.length / p.life))].charCodeAt(0);
function moveSparks(list, g, density, total, liquid, pops) {
  const { W, H, u, v, solid } = g;
  for (let k = list.length - 1; k >= 0; k--) {
    const p = list[k], s = p.s;
    p.age++;
    const fx = s.follow ? sampleU(g, u, p.x, p.y) * s.follow : 0, fy = s.follow ? sampleV(g, v, p.x, p.y) * s.follow : 0;
    p.vx = (p.vx + s.gravity[0]) * (1 - s.drag); p.vy = (p.vy + s.gravity[1]) * (1 - s.drag);
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
    if (p.age >= p.life || !finite || hit || popped || (wet && p.out) || sunk || p.x < -16 || p.y < -16 || p.x > W + 16 || p.y > H + 16) { list.splice(k, 1); total.alive--; }
    else if (liquid && inside && !wet && !s.follow) p.out = true;
  }
}

// Whitewater: each particle at the surface (in the air, or in a cell with air beside it) whose velocity changed by at
// least `impact` this frame throws spray along that change, or one moving at `speed` throws it along its own motion. The
// direction is tipped away from the water (down the density gradient) and turned by up to `spread` degrees, so spray
// leaves a landing outward and up and a stream sideways. Each qualifying particle throws with the layer's chance, a
// seeded draw keyed by the particle, so the same source throws the same droplets. Spray is drawn once it is out.
function throwWhitewater(state, effect, density, list, cycle, total) {
  const { W, H, solid } = state.g, air = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !solid[j * W + i] && density[j * W + i] < LEVEL;
  const at = (i, j) => (i >= 0 && j >= 0 && i < W && j < H && !solid[j * W + i] ? density[j * W + i] : 0);
  for (let k = 0; k < state.n; k++) {
    const x = state.x[k], y = state.y[k], i = Math.floor(x), j = Math.floor(y);
    if (!air(i, j) && !air(i - 1, j) && !air(i + 1, j) && !air(i, j - 1) && !air(i, j + 1)) continue;
    const vx = state.vx[k], vy = state.vy[k], dx = vx - state.pvx[k], dy = vy - state.pvy[k];
    const nx = at(i - 1, j) - at(i + 1, j), ny = at(i, j - 1) - at(i, j + 1), out = Math.sqrt(nx * nx + ny * ny);
    for (let layer = 0; layer < effect.whitewater.length; layer++) {
      const w = effect.whitewater[layer], [ax, ay] = w.impact !== null ? [dx, dy] : [vx, vy], amount = Math.sqrt(ax * ax + ay * ay);
      if (amount < (w.impact ?? w.speed)) continue;
      const r = salt => random(effect.seed, WHITEWATER + layer, cycle, state.id[k], salt);
      if (r(SALT.spawn) >= w.chance) continue;
      if (total.alive >= LIMITS.sparks) return false;
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
// Each look layer maps one field to palette colours: a colour is fully on from its threshold up, and `dither` feathers
// it in below, through the pattern, over that share of the gap to the previous threshold. Later layers draw over
// earlier ones; obstacles never hold fluid. Then optional cleanup and a one-pixel outline.
function renderFields(effect, base, width, height) {
  // Colour codes are 16-bit: a palette key may be any single character, such as an accented letter.
  const N = width * height, { solid, front } = effect, runs = new Float64Array(N), depth = new Float64Array(N), chars = new Uint16Array(N);
  const [density] = base;
  for (let i = 0; i < width; i++) {
    let run = 0;
    for (let j = 0; j < height; j++) { const c = j * width + i; run = !solid[c] && density[c] >= LEVEL ? run + 1 : 0; runs[c] = run; }
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
  const lit = new Float64Array(N), shade = new Float64Array(N), [lx, ly] = effect.light;
  if (effect.look.some(layer => layer.field >= 4)) for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const c = j * width + i, here = density[c], x = i + 0.5, y = j + 0.5;
    if (here <= 0) continue;
    lit[c] = Math.max(0, 1 - bilinearZero(density, width, height, x + 2 * lx - 0.5, y + 2 * ly - 0.5) / here);
    shade[c] = Math.max(0, 1 - bilinearZero(density, width, height, x - 2 * lx - 0.5, y - 2 * ly - 0.5) / here);
  }
  const sources = [base[0], base[1], base[2], depth, lit, shade];
  // Light and shadow only recolour pixels that earlier layers drew.
  for (const layer of effect.look) {
    const field = sources[layer.field], { thresholds, gaps, colors, dither, threshold } = layer, shading = layer.field >= 4;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const c = j * width + i, value = field[c];
      if (solid[c] || (shading && !chars[c]) || value < thresholds[0] - dither * gaps[0]) continue;
      const feather = (1 - threshold(i, j)) * dither;
      let level = 0;
      while (level < thresholds.length && value >= thresholds[level] - feather * gaps[level]) level++;
      if (level) chars[c] = colors[level - 1];
    }
  }
  if (effect.cleanup.strays || effect.cleanup.corners) {
    for (const change of cleanupIds(chars, width, height, { ...effect.cleanup, allowed: c => !solid[c] })) chars[change.index] = change.id;
  }
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
// fluid's viscosity solve (and a liquid's second pressure solve) costs about two more per sweep, sharp advection about
// thirty.
const stepWork = effect => effect.iterations * (effect.viscosity || effect.yield ? 3 : 1) + 10 + (effect.sharp ? 30 : 0);
// A loop simulates its warm-up cycles, the recorded cycle, and as long again as its longest-lived spark.
const simulatedFrames = effect => effect.loop ? (effect.warmup + 1) * effect.frames + Math.max(0, ...effect.emitters.map(e => (e.sparks ? e.sparks.life[1] : 0)), ...effect.whitewater.map(w => w.life[1])) : effect.frames;
const crowded = path => fail(path, `more than ${LIMITS.particles} liquid particles; lower the emitters' density or rate, or the fill`);
const SPARKS_FULL = `more than ${LIMITS.sparks} sparks are alive at once; lower the sparks' count or life`;
const WHITEWATER_FULL = `more than ${LIMITS.sparks} sparks and whitewater droplets are alive at once; lower the whitewater chance or life`;

// One running simulation of an effect, shared by compileFluid and the live runner: the solver's state, the fields the
// look reads (density, temperature and speed) and the sparks in flight.
function createRun(effect, width, height, path) {
  const N = width * height, state = effect.liquid ? createLiquid(effect, width, height) : createGas(effect, width, height);
  if (effect.liquid) { fillLiquid(state, effect); if (state.full) crowded(path); }
  return { effect, state, base: [new Float64Array(N), new Float64Array(N), new Float64Array(N)], sparks: [], pops: [], totals: { alive: 0, spawned: 0, maxAlive: 0 }, maxParticles: effect.liquid ? state.n : 0 };
}
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
    if (!e.orbit || e.burst || !t || !active(e, loop ? (cycle + frames - 1) % frames : cycle - 1)) return emit(cycle, 1);
    const steps = Math.max(1, Math.ceil(2 * Math.PI * Math.max(e.orbit.radius[0], e.orbit.radius[1]) / Math.abs(e.orbit.period)));
    for (let k = 1; k < steps; k++) emit(cycle - 1 + k / steps, 1 / steps);
    return emit(cycle, 1 / steps);
  });
}
// The solver's substeps for one frame.
function solveFrame(run) {
  const { effect, state } = run, dt = 1 / effect.substeps;
  // Whitewater measures how much each particle's velocity changes over the frame's steps, not what emitters set.
  if (effect.liquid && effect.whitewater.length) { state.pvx.set(state.vx.subarray(0, state.n)); state.pvy.set(state.vy.subarray(0, state.n)); }
  for (let s = 0; s < effect.substeps; s++) effect.liquid ? stepLiquid(state, effect, dt) : stepGas(state, effect, dt);
  if (effect.liquid) run.maxParticles = Math.max(run.maxParticles, state.n);
}
const fieldsOf = run => (run.effect.liquid ? liquidFields(run.state, run.base) : gasFields(run.state, run.base));
// Sparks move with this frame's flow; then, while `spawning`, new ones join where their emitters were (`here`) and
// whitewater where the water throws it. Returns the message for the spark limit if it kept any out, or null.
function sparkFrame(run, here, cycle, spawning) {
  const { effect, state, base, sparks, totals } = run;
  moveSparks(sparks, state.g, base[0], totals, effect.liquid, run.pops);
  let full = null;
  if (spawning) {
    effect.emitters.forEach((e, index) => { if (!full && here[index] && e.sparks && !spawnSparks(sparks, e, index, cycle, here[index], effect.seed, totals)) full = SPARKS_FULL; });
    if (!full && effect.whitewater.length && !throwWhitewater(state, effect, base[0], sparks, cycle, totals)) full = WHITEWATER_FULL;
  }
  totals.maxAlive = Math.max(totals.maxAlive, totals.alive);
  return full;
}
// Draws the sparks through `put(x, y, code)`: a spark is a size × size block in the colour for its age, and a trail
// streaks back to where it was a frame ago in the next colour of its list. Popped bubbles follow and age a frame.
function drawSparks(run, put) {
  for (const p of run.sparks) {
    // Spray is drawn once it has left the water, and streaks back only from where it was already drawn.
    if (p.hide && !p.out) continue;
    const s = p.s, step = Math.min(s.colors.length - 1, Math.floor(p.age * s.colors.length / p.life)), seen = !p.hide || p.seen;
    p.seen = true;
    if (s.trail && p.px !== undefined && seen) { const tail = s.colors[Math.min(s.colors.length - 1, step + 1)].charCodeAt(0); traceLine(Math.floor(p.px), Math.floor(p.py), Math.floor(p.x), Math.floor(p.y), (x, y) => put(x, y, tail)); }
    const head = s.colors[step].charCodeAt(0), x0 = Math.floor(p.x - (s.size - 1) / 2), y0 = Math.floor(p.y - (s.size - 1) / 2);
    for (let j = 0; j < s.size; j++) for (let i = 0; i < s.size; i++) put(x0 + i, y0 + j, head);
  }
  // A popped bubble: the ring around its block, then a droplet off each upper corner.
  const { pops } = run;
  for (let k = pops.length - 1; k >= 0; k--) {
    const b = pops[k], x0 = Math.floor(b.x - (b.size - 1) / 2), y0 = Math.floor(b.y - (b.size - 1) / 2);
    if (b.age === 0) for (let i = 0; i < b.size; i++) { put(x0 + i, y0 - 1, b.code); put(x0 + i, y0 + b.size, b.code); put(x0 - 1, y0 + i, b.code); put(x0 + b.size, y0 + i, b.code); }
    else { put(x0 - 1, y0 - 1, b.code); put(x0 + b.size, y0 - 1, b.code); }
    if (++b.age > 1) pops.splice(k, 1);
  }
}
// Runs one effect and returns its frames' operations plus figures for the metadata.
function simulate(effect, context) {
  const { width, height, path } = context, { frames, loop, liquid } = effect, N = width * height;
  const run = createRun(effect, width, height, path), { state, base } = run;
  // A loop warms up for whole cycles under its periodic forcing, keeps the fields of the last cycle's closing frames,
  // and blends its own closing frames toward them: the last frame then flows into frame 0 as that cycle's did.
  const begin = effect.warmup * frames, total = simulatedFrames(effect), blend = effect.blend;
  const tail = loop ? Array.from({ length: blend }, () => base.map(() => new Float64Array(N))) : [];
  const chars = Array.from({ length: frames }, () => null), drawn = Array.from({ length: frames }, () => []);
  const peak = { density: 0, temperature: 0, speed: 0 };
  for (let t = 0; t < total; t++) {
    const cycle = loop ? t % frames : t, out = t - begin, recording = !loop || (out >= 0 && out < frames);
    const here = emitFrame(run, t, cycle);
    solveFrame(run);
    if (liquid && state.full) crowded(path);
    if (loop && out < -blend && !run.sparks.length) continue;
    fieldsOf(run);
    if (loop && out >= -blend && out < 0) { tail[out + blend].forEach((field, f) => field.set(base[f])); continue; }
    // A looping effect spawns sparks during the recorded cycle only; those still alive after it are drawn from frame 0.
    const full = sparkFrame(run, here, cycle, recording);
    if (full) fail(path, full);
    const list = drawn[(loop ? out : t) % frames];
    drawSparks(run, (x, y, code) => { if (x >= 0 && y >= 0 && x < width && y < height && !effect.front[y * width + x]) list.push(y * width + x, code); });
    if (!recording) continue;
    const frame = loop ? out : t;
    if (loop && frame >= frames - blend) {
      const k = frame - (frames - blend), w = smooth((k + 1) / blend);
      for (let f = 0; f < 3; f++) { const a = base[f], b = tail[k][f]; for (let c = 0; c < N; c++) a[c] = a[c] * (1 - w) + b[c] * w; }
    }
    for (let c = 0; c < N; c++) {
      if (base[0][c] > peak.density) peak.density = base[0][c];
      if (base[1][c] > peak.temperature) peak.temperature = base[1][c];
      if (base[2][c] > peak.speed) peak.speed = base[2][c];
    }
    chars[frame] = renderFields(effect, base, width, height);
  }
  // Sparks draw over the fluid; obstacles drawn over it sit in front of both.
  const output = chars.map((grid, i) => {
    const list = drawn[i];
    for (let k = 0; k < list.length; k += 2) grid[list[k]] = list[k + 1];
    let left = width, top = height, right = -1, bottom = -1;
    for (let c = 0; c < N; c++) if (grid[c]) { const x = c % width, y = Math.floor(c / width); if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
    const ops = effect.obstacles.filter(o => o.draw === 'under').map(o => ({ op: 'stamp', symbol: o.symbol, x: o.x, y: o.y }));
    let pixels = 0;
    if (right >= 0) {
      const rows = [];
      for (let y = top; y <= bottom; y++) { let row = ''; for (let x = left; x <= right; x++) { const ch = grid[y * width + x]; row += ch ? String.fromCharCode(ch) : '.'; if (ch) pixels++; } rows.push(row); }
      ops.push({ op: 'grid', x: left, y: top, rows });
    }
    ops.push(...effect.obstacles.filter(o => o.draw === 'over').map(o => ({ op: 'stamp', symbol: o.symbol, x: o.x, y: o.y })));
    return { ops, pixels };
  });
  const round = value => Math.floor(value * 1000 + 0.5) / 1000;
  const { totals } = run;
  return {
    output, steps: total * effect.substeps, peak: { density: round(peak.density), ...(!liquid && { temperature: round(peak.temperature) }), speed: round(peak.speed) },
    ...(liquid && { particles: run.maxParticles }), sparks: { spawned: totals.spawned, maxAlive: totals.maxAlive }
  };
}

// Reads a whole source and checks it as compileFluid does. Each effect is read in turn, checked against the frame and
// work limits, and passed to `each(name, effect, { width, height, path })`, which returns its frames' operations (or
// null to leave them empty, as a live runner does). The renderer then checks the recipe, so a live runner gets every
// check compileFluid makes before simulating, with the same paths and messages.
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
  let work = 0;
  for (const [name, value] of Object.entries(source.effects)) {
    const path = `fluid.effects.${name}`;
    identifier(name, path);
    // Effect names become animation and frame names, which must be unique ignoring case for portable bundles.
    if (seen.has(name.toLowerCase())) fail(path, 'effect names must be unique ignoring case; they name animations and frames');
    seen.add(name.toLowerCase());
    const effect = readEffect(value, path, { width, height, palette, symbols });
    if (frames.length + effect.frames > 256) fail('fluid.effects', `the effects make more than 256 frames; a recipe holds at most 256`);
    // Bounded work: about one update per cell per pressure sweep, per step. The presets need at most 60 million.
    work += width * height * simulatedFrames(effect) * effect.substeps * stepWork(effect);
    if (work > LIMITS.work) fail(path, `the simulations need about ${Math.round(work / 1e6)} million cell updates, more than ${LIMITS.work / 1e6} million; lower frames, warmup, substeps, iterations or the canvas size`);
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

export function compileFluid(source) {
  const metadata = { format: 'pixelforge-fluid-metadata', version: 1, effects: {} };
  const recipe = buildRecipe(source, (name, effect, context) => {
    const run = simulate(effect, context);
    metadata.effects[name] = {
      kind: effect.kind, frames: effect.frames, loop: effect.loop, seed: effect.seed, steps: run.steps, ...(effect.loop && { warmup: effect.warmup, blend: effect.blend }),
      peak: run.peak, ...(run.particles !== undefined && { particles: run.particles }), sparks: run.sparks,
      pixels: run.output.map(frame => frame.pixels), ...(!effect.loop && { residue: run.output.at(-1).pixels })
    };
    return run.output.map(frame => frame.ops);
  });
  return JSON.parse(JSON.stringify({ recipe, metadata }));
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
  if (N * warmup * effect.substeps * stepWork(effect) > LIMITS.work) fail('live.warmup', `warming up ${warmup} frames needs more than ${LIMITS.work / 1e6} million cell updates; warm up fewer frames`);

  // Colours by palette key, and the obstacles stamped under and over the fluid, composited in a compiled frame's order.
  const palette = {}, colours = new Map();
  for (const [key, value] of Object.entries(recipe.palette)) {
    const rgba = parseColor(value);
    palette[key] = `#${rgba.slice(0, rgba[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('')}`;
    if (key.length === 1) colours.set(key.charCodeAt(0), rgba);
  }
  const under = new Uint8ClampedArray(N * 4), underKeys = new Uint16Array(N), over = [];
  for (const o of effect.obstacles) if (o.draw !== 'none') recipe.symbols[o.symbol].forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] === '.' || row[i] === ' ') continue;
      const c = (o.y + j) * width + o.x + i, code = row.charCodeAt(i);
      if (o.draw === 'under') { composite(under, c * 4, colours.get(code)); underKeys[c] = code; } else over.push(c, code);
    }
  });

  const run = createRun(effect, width, height, path), { state } = run, boosts = emitters.map(() => ({ factor: 1, frames: 0 }));
  let t = 0, queue = [], overlay = [];
  const put = (x, y, code) => { if (x >= 0 && y >= 0 && x < width && y < height && !effect.front[y * width + x]) overlay.push(y * width + x, code); };
  // One frame: the emitters (boosted), then the queued pushes and puffs in the order they were made, the solver, the
  // fields and the sparks. Live runs never stop at a limit: particles, sparks and droplets beyond it are not added, and
  // the limits compileFluid meets while simulating (and the renderer's drawing budget) are not checked.
  const advance = () => {
    const cycle = t % effect.frames, here = emitFrame(run, t, cycle, boosts.map(b => (b.frames ? b.factor : 1)));
    queue.forEach((input, n) => input(n));
    queue = [];
    solveFrame(run);
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
    const { W, H, solid } = state.g, disc = { radius }, [i0, i1, j0, j1] = around(x, y, liquid ? radius + 1 : radius, W, H);
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
    width, height, kind: effect.kind, palette, frames: effect.frames,
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
    // The current frame: the look layers, cleanup and outline over the fields, sparks and whitewater over them, and the
    // obstacles stamped under or over, as a compiled frame draws them. `keys` names the topmost palette key drawn at each
    // pixel ('.' empty); where a translucent colour blends over another, the pixel is a mix and the key its top layer.
    render() {
      const chars = renderFields(effect, run.base, width, height);
      for (let k = 0; k < overlay.length; k += 2) chars[overlay[k]] = overlay[k + 1];
      const rgba = under.slice(), codes = underKeys.slice();
      for (let c = 0; c < N; c++) if (chars[c]) { composite(rgba, c * 4, colours.get(chars[c])); codes[c] = chars[c]; }
      for (let k = 0; k < over.length; k += 2) { composite(rgba, over[k] * 4, colours.get(over[k + 1])); codes[over[k]] = over[k + 1]; }
      const keys = [];
      for (let j = 0; j < height; j++) { let row = ''; for (let i = 0; i < width; i++) { const code = codes[j * width + i]; row += code ? String.fromCharCode(code) : '.'; } keys.push(row); }
      return { rgba, keys };
    }
  };
  if (warmup) live.step(warmup); else fieldsOf(run);
  return live;
}
