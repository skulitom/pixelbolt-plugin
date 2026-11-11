// Falling-sand material grid. Every pixel holds one material from a table an agent writes: powders, liquids, gases,
// solids and fire, the heavier sinking through the lighter, with temperature, phase changes, burning and a table of
// reactions between neighbours. Powders and liquids carry a velocity, so falls speed up, landings splash and a liquid
// that lands surges sideways; solids marked `falls` drop as rigid pieces once nothing fixed holds them up, straight down,
// or with pieces "tumble" as rigid bodies (bodies.js) that turn, topple and float.
// createLivePowder runs it a frame at a time for pages and games; inputs (paint, erase, walls, heat) are queued and
// applied in order at the start of the next step, so a recorded list of strokes replays exactly.
//
// Browser-compatible, no dependencies outside this package and deterministic in every engine: cell state is integers in
// typed arrays, every draw comes from an xorshift stream seeded by craft.js's hash (per frame, and per input) and read in
// a fixed scan order, and there is no Math.random and no trigonometry of its own (tumbling pieces turn by craft.js's
// polynomial sines and bodies.js's solver, + − × ÷ and sqrt). Temperatures are kept in sixteenths of a degree and
// velocities in 256ths of a pixel per frame.
import { parseColor, renderProject, CANVAS_SIDE, FRAME_AREA, fail, isObject } from './core.js';
import { hash, ditherThreshold, sinDeg, cosDeg } from './craft.js';
import { atan2Deg } from './shapes.js';
import { createBodyWorld, polygonPart, areaBeyond, turnBetween } from './bodies.js';
import { number } from './authoring.js';

const known = (object, keys, path) => {
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${path}.${key}`, `unknown field; expected one of ${keys.join(', ')}`);
};
const integer = (value, path, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `expected a whole number from ${min} to ${max}`);
  return value;
};

export const POWDER_STATES = ['powder', 'liquid', 'gas', 'solid', 'fire'];
const EMPTY = 0, POWDER = 1, LIQUID = 2, GAS = 3, SOLID = 4, FIRE = 5;
const STATE_CODE = { powder: POWDER, liquid: LIQUID, gas: GAS, solid: SOLID, fire: FIRE };
const DEFAULT_DENSITY = { powder: 16, liquid: 10, gas: 0.5, fire: 0.2, solid: 100 };
const BURNING = 1;
// Temperatures are whole sixteenths of a degree, between these (degrees).
const SIXTEENTHS = 16, T_LOW = -2000, T_HIGH = 9000;
const NEVER_ABOVE = 1073741824, NEVER_BELOW = -1073741824;
// Densities are kept in hundredths; air is 1.
const AIR = 100;
// Conductance and cooling are kept in 4096ths of the difference per frame. A cell has four edges, so an edge moves at
// most 3/16 of a difference per frame and the explicit heat step stays stable.
const SCALE = 4096, MOST_CONDUCT = 768;
const ONE = 4294967296; // a chance of 1, as a threshold on a 32-bit draw
// Velocities are 256ths of a pixel per frame. Nothing falls faster than TOP; a landing at SPLASH or faster splashes.
const SUB = 256, TOP = 6 * SUB, SPLASH = 2 * SUB;
// How far a resting liquid looks along its row for somewhere lower, or for more of its kind to join.
const FAR = 40;
const LIMITS = { side: 1024, materials: 200, reactions: 256, colors: 8, emits: 2, scene: 512, strokes: 65536, inputs: 512, clips: 16, frames: 256, steps: 20000, work: 200e6 };
// The work a compile may do (LIMITS.work) is counted in cell steps, a busy grid's step of one cell (about 60 ns). A
// scripted input costs, each time it runs, these many for each cell of the box round its stroke (or each face of the
// moving air): `plain` to erase, heat or paint speckled cells, `patterned` to paint blotch or grain (value noise per
// cell), `thrown` for a burst (each loose cell sorted and thrown); measured, and rounded up. With pieces "tumble" every
// cell step counts TUMBLE_WORK times, plus TUMBLE_SHARE times the share of the grid that solids that fall fill (at the
// start, and where scripted inputs paint them): reading pieces back, cutting them and moving their bodies costs from
// 2.5 to 10 times a grid's step, the more the more of it falls (posts or a lattice of wood burning down).
const INPUT_WORK = { plain: 0.5, patterned: 4, thrown: 10, face: 0.25 }, TUMBLE_WORK = 5, TUMBLE_SHARE = 12;
// What compilePowder reads of a live grid before it runs it: its scripted inputs and, tumbling, the share that falls.
const PLANS = new WeakMap();
// Tumbling pieces (pieces: "tumble"): at most MOST_PIECES bodies (further loose pieces drop straight), SEARCH cells
// searched for room for what a piece moves into, SIDE columns beside a piece searched for the liquid it is in, REACH
// pixels round the moving pieces whose obstacles they meet. In a liquid a piece is dragged LIQUID_DRAG a frame (times the
// liquid's drag and the share of it under), more the faster it goes (QUADRATIC per pixel a frame), so it plunges, bobs
// and settles; what it hits, it throws up at SPLASH_UP and out at SPLASH_OUT of its speed. A piece is drawn held as
// bodies.js draws a body: it steps back only HOLD of a pixel (or TURN_HOLD of a degree) past halfway, and if its cells
// would land in a solid it tries NUDGES of a pixel.
const MOST_PIECES = 128, SEARCH = 4096, SIDE = 4, REACH = 10, PARTED = 8, RESTED = 2, LIQUID_DRAG = 0.6, QUADRATIC = 1, SPLASH_UP = 0.9, SPLASH_OUT = 0.35, HOLD = 0.3, TURN_HOLD = 0.2;
const NUDGES = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]];
// Single-character palette keys. '.' marks an empty pixel.
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&*+-=?@^~!<>/|:;,_()[]{}';
// Salts that keep the random streams apart.
const SALT = { step: 1, input: 2, scene: 3, script: 5 };

const MATERIAL_FIELDS = ['state', 'density', 'spread', 'speed', 'expand', 'viscosity', 'drag', 'splash', 'falls', 'clings', 'colors', 'pattern', 'top', 'streak', 'haze', 'colorBy', 'shimmer', 'hot', 'temperature', 'conduct', 'cool', 'heat', 'life', 'above', 'below', 'burn', 'emit'];
const SOURCE_FIELDS = ['$schema', 'format', 'version', 'name', 'base', 'width', 'height', 'seed', 'ambient', 'background', 'gravity', 'air', 'wall', 'pieces', 'materials', 'reactions', 'scene', 'inputs', 'clips'];
// What a scripted input or a live call can do, and the fields each takes.
export const POWDER_INPUTS = { paint: ['material', 'x', 'y', 'x2', 'y2', 'radius', 'fill', 'replace'], erase: ['x', 'y', 'x2', 'y2', 'radius'], wall: ['x', 'y', 'x2', 'y2', 'radius'], heat: ['x', 'y', 'x2', 'y2', 'radius', 'amount'], push: ['x', 'y', 'x2', 'y2', 'radius', 'vx', 'vy'], burst: ['x', 'y', 'radius', 'strength'] };
const recipeName = (value, path) => {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail(path, 'expected a portable name: 1–60 letters, digits, underscores or hyphens, starting with a letter');
  return value;
};
const NAME = /^[a-z][a-z0-9-]{0,23}$/;

// ---- The source ---------------------------------------------------------------------------------------------------
function colourList(value, path) {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.colors) fail(path, `expected 1 to ${LIMITS.colors} colours`);
  return value.map((colour, n) => {
    const rgba = parseColor(colour, {}, `${path}[${n}]`);
    if (rgba[3] !== 255) fail(`${path}[${n}]`, 'materials are drawn opaque; use a solid colour');
    return rgba;
  });
}
const chanceOf = (value, path) => Math.min(ONE, Math.round(number(value, path, 0, 1) * ONE));
const degrees = (value, path) => Math.round(number(value, path, T_LOW, T_HIGH) * SIXTEENTHS);

// A source that names a `base` starts from that table: its ambient, background, gravity, air and wall unless the
// source sets them, its materials with the source's added (a material named again replaces the base's), and its
// reactions with the source's added (a reaction for a pair the base has replaces the base's).
function withBase(source) {
  if (source.base === undefined) return source;
  if (source.base !== 'sandbox') fail('powder.base', 'expected "sandbox" (the starter materials: sand, water, stone, wood, fire, smoke, steam, oil, lava, ice, ash, moss and wall)');
  const base = structuredClone(SANDBOX), merged = { ...base, ...source };
  if (source.materials !== undefined && !isObject(source.materials)) fail('powder.materials', 'expected an object of materials by name');
  if (source.reactions !== undefined && !Array.isArray(source.reactions)) fail('powder.reactions', 'expected a list of reactions');
  merged.materials = { ...base.materials, ...source.materials };
  const pair = r => (isObject(r) ? [r.a, r.b].map(String).sort().join(' ') : null), named = new Set((source.reactions ?? []).map(pair));
  // The source's own first, so a mistake in one is named by its own index.
  merged.reactions = [...(source.reactions ?? []), ...base.reactions.filter(r => !named.has(pair(r)))];
  if (isObject(source.air)) merged.air = { ...base.air, ...source.air, ...(isObject(source.air.flow) && { flow: { ...base.air.flow, ...source.air.flow } }) };
  delete merged.base;
  return merged;
}

// Reads a pixelforge-powder source into flat tables, one entry per material id (0 is empty air).
function readPowder(given) {
  if (!isObject(given)) fail('powder', 'expected a pixelforge-powder source object');
  known(given, SOURCE_FIELDS, 'powder');
  if (given.format !== 'pixelforge-powder') fail('powder.format', 'expected "pixelforge-powder"');
  if (given.version !== undefined && given.version !== 1) fail('powder.version', 'expected 1');
  if (given.name !== undefined) recipeName(given.name, 'powder.name');
  const source = withBase(given);
  const width = integer(source.width, 'powder.width', 8, LIMITS.side), height = integer(source.height, 'powder.height', 8, LIMITS.side);
  const seed = integer(source.seed ?? 1, 'powder.seed', 0, 2147483647);
  const ambient = degrees(source.ambient ?? 20, 'powder.ambient');
  // Pixels per frame gained each frame by whatever falls.
  const gravity = Math.round(number(source.gravity ?? 0.15, 'powder.gravity', 0.02, 1) * SUB);
  const background = source.background === undefined ? [0, 0, 0, 0] : parseColor(source.background, {}, 'powder.background');
  if (!isObject(source.materials)) fail('powder.materials', 'expected an object of materials by name');
  const names = Object.keys(source.materials);
  if (!names.length || names.length > LIMITS.materials) fail('powder.materials', `expected 1 to ${LIMITS.materials} materials`);
  for (const name of names) {
    if (!NAME.test(name)) fail(`powder.materials.${name}`, 'names are lower case letters, digits and hyphens, starting with a letter (at most 24)');
    if (name === 'empty') fail('powder.materials.empty', '"empty" is the name of empty air');
  }
  const M = names.length + 1, id = new Map(names.map((name, n) => [name, n + 1]));
  const ref = (value, path, empty = true) => {
    if (value === 'empty' && empty) return 0;
    if (typeof value !== 'string' || !id.has(value)) fail(path, `no material named ${JSON.stringify(value)}; the materials are ${names.join(', ')}${empty ? ', or "empty"' : ''}`);
    return id.get(value);
  };

  // Palette: every colour once, each with a key (at most KEY_CHARS.length of them, counted once all are read).
  const colours = [], keyOf = new Map();
  const colour = rgba => {
    const text = rgba.join(',');
    if (!keyOf.has(text)) { keyOf.set(text, colours.length); colours.push(rgba); }
    return keyOf.get(text);
  };

  const t = {
    names: ['empty', ...names], width, height, seed, ambient, background, gravity, M,
    state: new Uint8Array(M), density: new Int32Array(M), spread: new Uint8Array(M), still: new Float64Array(M), drag: new Float64Array(M),
    splash: new Float64Array(M), falls: new Uint8Array(M), clings: new Uint8Array(M), expand: new Uint8Array(M), streak: new Int16Array(M).fill(-1), dense: new Uint8Array(M),
    birth: new Int32Array(M), conduct: new Int32Array(M), cool: new Int32Array(M), hold: new Int32Array(M).fill(NEVER_BELOW),
    lifeMin: new Uint16Array(M), lifeMax: new Uint16Array(M), lifeInto: new Uint8Array(M), lifeChance: new Float64Array(M),
    aboveLatent: new Int32Array(M), belowLatent: new Int32Array(M),
    aboveAt: new Int32Array(M).fill(NEVER_ABOVE), aboveInto: new Uint8Array(M), aboveChance: new Float64Array(M),
    belowAt: new Int32Array(M).fill(NEVER_BELOW), belowInto: new Uint8Array(M), belowChance: new Float64Array(M),
    igniteAt: new Int32Array(M).fill(NEVER_ABOVE), burnMin: new Uint16Array(M), burnMax: new Uint16Array(M), burnInto: new Uint8Array(M), burnChance: new Float64Array(M), burnHeat: new Int32Array(M),
    emitMat: new Uint8Array(M * 2), emitChance: new Float64Array(M * 2), burnEmitMat: new Uint8Array(M * 2), burnEmitChance: new Float64Array(M * 2),
    reactive: new Uint8Array(M), pair: new Int16Array(M * M).fill(-1), reactions: [],
    // Drawing: a ramp chosen per cell (or by age, or cycled), a surface colour, a glow ramp by temperature and the
    // colours a burning cell flickers through. Indices into `colours`; ramps are stored as flat lists.
    ramps: [], top: new Int16Array(M).fill(-1), byAge: new Uint8Array(M), shimmer: new Uint16Array(M),
    hotFrom: new Int32Array(M).fill(NEVER_ABOVE), hotSpan: new Int32Array(M), hotRamp: [], burnRamp: [],
    pattern: new Uint8Array(M), haze: new Int16Array(M).fill(-1), speed: new Float64Array(M).fill(ONE),
    colours, keyOf
  };
  const air = source.air ?? {};
  if (!isObject(air)) fail('powder.air', 'expected { conduct, cool, flow }');
  known(air, ['conduct', 'cool', 'flow'], 'powder.air');
  // Moving air: a coarse velocity field (one cell per `cell` × `cell` pixels) that carries gases and flames, leans
  // them in the wind, lifts them over heat and curls them (`swirl`), and pushes what falls through it.
  if (air.flow !== undefined && air.flow !== false) {
    const flow = air.flow === true ? {} : air.flow, label = 'powder.air.flow';
    if (!isObject(flow)) fail(label, 'expected true or { cell, wind, rise, swirl, calm, carry }');
    known(flow, ['cell', 'wind', 'rise', 'swirl', 'calm', 'carry'], label);
    const wind = flow.wind ?? [0, 0];
    if (!Array.isArray(wind) || wind.length !== 2) fail(`${label}.wind`, 'expected [x, y] in pixels a frame');
    t.flow = {
      cell: integer(flow.cell ?? 4, `${label}.cell`, 2, 16),
      wind: wind.map((value, k) => number(value, `${label}.wind[${k}]`, -2, 2)),
      rise: number(flow.rise ?? 0.25, `${label}.rise`, 0, 4),
      swirl: number(flow.swirl ?? 0.3, `${label}.swirl`, 0, 2),
      calm: number(flow.calm ?? 0.02, `${label}.calm`, 0, 1),
      carry: number(flow.carry ?? 0.3, `${label}.carry`, 0, 1)
    };
  } else t.flow = null;
  t.state[0] = EMPTY; t.density[0] = AIR;
  t.conduct[0] = Math.round(number(air.conduct ?? 0.01, 'powder.air.conduct', 0, 1) * MOST_CONDUCT);
  t.cool[0] = Math.round(number(air.cool ?? 0.03, 'powder.air.cool', 0, 1) * SCALE);
  t.ramps[0] = [colour(background)]; t.hotRamp[0] = []; t.burnRamp[0] = [];

  const lateRefs = [];
  names.forEach((name, n) => {
    const m = n + 1, def = source.materials[name], path = `powder.materials.${name}`;
    if (!isObject(def)) fail(path, 'expected a material object');
    known(def, MATERIAL_FIELDS, path);
    // A starter material named again replaces the table's whole, so one given only new colours has lost its state.
    if (!Object.hasOwn(STATE_CODE, def.state)) fail(`${path}.state`, `expected one of ${POWDER_STATES.join(', ')}${def.state === undefined && given.base === 'sandbox' && Object.hasOwn(SANDBOX.materials, name) ? `; a material named as the starter table's replaces it whole, so repeat the fields it should keep: the table's ${name} is ${JSON.stringify(SANDBOX.materials[name])}` : ''}`);
    const state = STATE_CODE[def.state];
    t.state[m] = state;
    // A solid that falls drops as a rigid piece, with every solid that falls touching it, once no fixed solid (one
    // without `falls`) and no floor holds the piece up. Its density says what it sinks through and what it floats on.
    if (def.falls !== undefined && (state !== SOLID || typeof def.falls !== 'boolean')) fail(`${path}.falls`, state === SOLID ? 'expected true or false' : 'only solids fall as pieces; powders and liquids always fall');
    t.falls[m] = def.falls ? 1 : 0;
    // A solid that falls and clings (moss) holds on to any fixed solid it touches, under it as well, as a plant does:
    // with pieces "tumble", one that doesn't cling stands on what is under it and topples off it.
    if (def.clings !== undefined && (!t.falls[m] || typeof def.clings !== 'boolean')) fail(`${path}.clings`, t.falls[m] ? 'expected true or false' : 'only a solid that falls clings; give it falls: true');
    t.clings[m] = def.clings ? 1 : 0;
    const moves = state !== SOLID || t.falls[m];
    if (def.density !== undefined && !moves) fail(`${path}.density`, 'fixed solids do not move; density is for powders, liquids, gases, fire and solids that fall');
    t.density[m] = Math.round(number(def.density ?? (t.falls[m] ? 50 : DEFAULT_DENSITY[def.state]), `${path}.density`, 0.01, 1000) * 100);
    if (state === GAS || state === FIRE) {
      if (t.density[m] === AIR) fail(`${path}.density`, 'a gas of density 1 neither rises nor sinks in air; lighter rises, heavier sinks');
    } else if (moves && t.density[m] <= AIR) fail(`${path}.density`, `${state === SOLID ? 'solids that fall' : 'powders and liquids'} must be heavier than air (above 1)`);
    // The share of fast landings that bounce back up as spray.
    if (def.splash !== undefined && state !== POWDER && state !== LIQUID) fail(`${path}.splash`, 'splash is for powders and liquids');
    t.splash[m] = chanceOf(def.splash ?? (state === LIQUID ? 0.12 : 0), `${path}.splash`);
    if (def.spread !== undefined && !(state === LIQUID || state === GAS || state === FIRE)) fail(`${path}.spread`, 'only liquids, gases and fire spread sideways');
    t.spread[m] = integer(def.spread ?? { [LIQUID]: 4, [GAS]: 2, [FIRE]: 1 }[state] ?? 0, `${path}.spread`, 0, 16);
    if (def.viscosity !== undefined && state !== LIQUID) fail(`${path}.viscosity`, 'viscosity is for liquids');
    t.still[m] = chanceOf(def.viscosity ?? 0, `${path}.viscosity`);
    if (t.still[m] > 0.95 * ONE) fail(`${path}.viscosity`, 'at most 0.95, or the liquid would barely move');
    if (def.drag !== undefined && !(state === LIQUID || state === GAS)) fail(`${path}.drag`, 'drag slows what sinks through a liquid or gas');
    t.drag[m] = chanceOf(def.drag ?? (state === LIQUID ? 0.5 : 0), `${path}.drag`);
    if (t.drag[m] > 0.95 * ONE) fail(`${path}.drag`, 'at most 0.95');

    // Heat.
    t.birth[m] = def.temperature === undefined ? ambient : degrees(def.temperature, `${path}.temperature`);
    t.conduct[m] = Math.round(number(def.conduct ?? 0.2, `${path}.conduct`, 0, 1) * MOST_CONDUCT);
    t.cool[m] = Math.round(number(def.cool ?? 0, `${path}.cool`, 0, 1) * SCALE);
    if (def.heat !== undefined) t.hold[m] = degrees(def.heat, `${path}.heat`);
    // A phase change past `temperature`. With `latent`, the cell first takes in (or, going below, gives out) that
    // many more degrees, and the new material starts at `temperature`: boiling a cell of water costs its heater the
    // latent heat too, so a hot stone boils a few cells of a pool rather than all of it.
    const change = (value, at, into, chance, label) => {
      if (!isObject(value)) fail(`${path}.${label}`, 'expected { temperature, into, chance, latent }');
      known(value, ['temperature', 'into', 'chance', 'latent'], `${path}.${label}`);
      t[at][m] = degrees(value.temperature, `${path}.${label}.temperature`);
      t[label === 'above' ? 'aboveLatent' : 'belowLatent'][m] = degrees(value.latent ?? 0, `${path}.${label}.latent`);
      if (value.latent !== undefined && value.latent < 0) fail(`${path}.${label}.latent`, 'expected a number of degrees, 0 or more');
      lateRefs.push(() => { t[into][m] = ref(value.into, `${path}.${label}.into`); if (t[into][m] === m) fail(`${path}.${label}.into`, 'a material cannot change into itself'); });
      t[chance][m] = chanceOf(value.chance ?? 1, `${path}.${label}.chance`);
    };
    if (def.above !== undefined) change(def.above, 'aboveAt', 'aboveInto', 'aboveChance', 'above');
    if (def.below !== undefined) change(def.below, 'belowAt', 'belowInto', 'belowChance', 'below');
    if (def.above && def.below && t.belowAt[m] >= t.aboveAt[m]) fail(`${path}.below.temperature`, 'must be below above.temperature');

    // Life: a cell lives a number of frames, then becomes something else (or empty).
    const span = (value, label) => {
      if (!Array.isArray(value) || value.length !== 2) fail(label, 'expected [fewest, most] frames');
      const low = integer(value[0], `${label}[0]`, 1, 65535), high = integer(value[1], `${label}[1]`, low, 65535);
      return [low, high];
    };
    if (def.life !== undefined) {
      if (!isObject(def.life)) fail(`${path}.life`, 'expected { frames: [fewest, most], into, chance }');
      known(def.life, ['frames', 'into', 'chance'], `${path}.life`);
      [t.lifeMin[m], t.lifeMax[m]] = span(def.life.frames, `${path}.life.frames`);
      lateRefs.push(() => { t.lifeInto[m] = def.life.into === undefined ? 0 : ref(def.life.into, `${path}.life.into`); });
      t.lifeChance[m] = chanceOf(def.life.chance ?? 1, `${path}.life.chance`);
    }
    const emits = (value, matKey, chanceKey, label) => {
      if (!Array.isArray(value) || value.length > LIMITS.emits) fail(label, `expected up to ${LIMITS.emits} { material, chance }`);
      value.forEach((entry, k) => {
        if (!isObject(entry)) fail(`${label}[${k}]`, 'expected { material, chance }');
        known(entry, ['material', 'chance'], `${label}[${k}]`);
        lateRefs.push(() => { t[matKey][m * 2 + k] = ref(entry.material, `${label}[${k}].material`, false); });
        t[chanceKey][m * 2 + k] = chanceOf(entry.chance, `${label}[${k}].chance`);
      });
    };
    if (def.emit !== undefined) emits(def.emit, 'emitMat', 'emitChance', `${path}.emit`);
    // Burning: past `temperature` it lights, holds at least `heat` while it burns, gives off what `emit` lists, and
    // after its frames becomes `into` (or empty).
    if (def.burn !== undefined) {
      const burn = def.burn, label = `${path}.burn`;
      if (!isObject(burn)) fail(label, 'expected { temperature, frames, heat, emit, into, chance, colors }');
      known(burn, ['temperature', 'frames', 'heat', 'emit', 'into', 'chance', 'colors'], label);
      if (def.life !== undefined) fail(label, 'a material with a life cannot also burn');
      t.igniteAt[m] = degrees(burn.temperature, `${label}.temperature`);
      [t.burnMin[m], t.burnMax[m]] = span(burn.frames, `${label}.frames`);
      t.burnHeat[m] = degrees(burn.heat ?? 600, `${label}.heat`);
      lateRefs.push(() => { t.burnInto[m] = burn.into === undefined ? 0 : ref(burn.into, `${label}.into`); });
      t.burnChance[m] = chanceOf(burn.chance ?? 1, `${label}.chance`);
      if (burn.emit !== undefined) emits(burn.emit, 'burnEmitMat', 'burnEmitChance', `${label}.emit`);
      if (burn.colors !== undefined) t.burnRamp[m] = colourList(burn.colors, `${label}.colors`).map(colour);
    }

    // Drawing.
    t.ramps[m] = colourList(def.colors, `${path}.colors`).map(colour);
    if (def.top !== undefined) {
      if (state !== LIQUID) fail(`${path}.top`, 'a surface colour is for liquids');
      t.top[m] = colourList([def.top], `${path}.top`).map(colour)[0];
    }
    // A streak trails a fast fall: drawn into the empty pixels above a cell falling two pixels a frame or faster, so
    // rain reads as rain rather than as stars.
    if (def.streak !== undefined) {
      if (state !== POWDER && state !== LIQUID) fail(`${path}.streak`, 'a streak trails falling powders and liquids');
      t.streak[m] = colourList([def.streak], `${path}.streak`).map(colour)[0];
    }
    if (def.colorBy !== undefined && !['cell', 'age', 'density'].includes(def.colorBy)) fail(`${path}.colorBy`, 'expected "cell" (a seeded colour per cell), "age" (young to old, for a material with a life) or "density" (thin to thick, for a gas)');
    if (def.colorBy === 'age' && def.life === undefined) fail(`${path}.colorBy`, '"age" needs a life');
    if (def.colorBy === 'density' && state !== GAS && state !== FIRE) fail(`${path}.colorBy`, '"density" draws a gas or flame as a cloud, thin at its edges and thick where its cells crowd');
    if (def.colorBy === 'density' && def.haze !== undefined) fail(`${path}.haze`, 'a gas drawn by density makes its own haze from its thinnest colour');
    t.byAge[m] = def.colorBy === 'age' ? 1 : 0;
    t.dense[m] = def.colorBy === 'density' ? 1 : 0;
    t.shimmer[m] = def.shimmer === undefined ? 0 : integer(def.shimmer, `${path}.shimmer`, 2, 600);
    // How a cell's colour is chosen where it is made: a seeded draw per cell (speckle), or from where it is, as
    // soft blotches or as streaks along the rows (grain). Moving cells carry their colour with them.
    const patterns = ['speckle', 'blotch', 'grain'];
    if (def.pattern !== undefined && !patterns.includes(def.pattern)) fail(`${path}.pattern`, `expected one of ${patterns.join(', ')}`);
    t.pattern[m] = patterns.indexOf(def.pattern ?? 'speckle');
    if (def.haze !== undefined) {
      if (state !== GAS && state !== FIRE) fail(`${path}.haze`, 'a haze is drawn around gases and fire');
      t.haze[m] = colourList([def.haze], `${path}.haze`).map(colour)[0];
    }
    if (def.speed !== undefined && state !== GAS && state !== FIRE) fail(`${path}.speed`, 'speed is the chance a gas or flame moves in a frame');
    // A gas made by a phase change or a reaction, or given off, takes more room than what it came from: it also fills
    // up to `expand` free cells beside it (steam from water billows).
    if (def.expand !== undefined && state !== GAS) fail(`${path}.expand`, 'expand is for gases');
    t.expand[m] = integer(def.expand ?? 0, `${path}.expand`, 0, 4);
    t.speed[m] = chanceOf(def.speed ?? 1, `${path}.speed`);
    t.hotRamp[m] = [];
    if (def.hot !== undefined) {
      if (!isObject(def.hot)) fail(`${path}.hot`, 'expected { from, to, colors }');
      known(def.hot, ['from', 'to', 'colors'], `${path}.hot`);
      t.hotFrom[m] = degrees(def.hot.from, `${path}.hot.from`);
      const to = degrees(def.hot.to, `${path}.hot.to`);
      if (to <= t.hotFrom[m]) fail(`${path}.hot.to`, 'must be above hot.from');
      t.hotSpan[m] = to - t.hotFrom[m];
      t.hotRamp[m] = colourList(def.hot.colors, `${path}.hot.colors`).map(colour);
    }
    if (!t.burnRamp[m]) t.burnRamp[m] = [];
  });
  if (colours.length > KEY_CHARS.length) {
    // Say how many a base takes up: the colours of its materials the source keeps, and its background.
    let from = '';
    if (given.base !== undefined) {
      const kept = new Set(given.background === undefined ? t.ramps[0] : []);
      names.forEach((name, n) => {
        if (!Object.hasOwn(SANDBOX.materials, name) || (isObject(given.materials) && Object.hasOwn(given.materials, name))) return;
        const m = n + 1;
        for (const k of [...t.ramps[m], t.top[m], t.streak[m], ...t.hotRamp[m], ...t.burnRamp[m]]) if (k >= 0) kept.add(k);
      });
      from = `: the ${given.base} base uses ${kept.size} and this source adds ${colours.length - kept.size}`;
    }
    fail('powder.materials', `${colours.length} different colours in all${from}, and a grid draws at most ${KEY_CHARS.length}; share colours between materials${given.base !== undefined ? ', or replace base materials the source does not use with ones of fewer colours (a material named again replaces the base\'s)' : ''}`);
  }
  for (const resolve of lateRefs) resolve();
  // A burning material with no colours of its own flickers through the colours of the fire it gives off.
  for (let m = 1; m < M; m++) {
    if (t.igniteAt[m] === NEVER_ABOVE || t.burnRamp[m].length) continue;
    const flame = [0, 1].map(k => t.burnEmitMat[m * 2 + k]).find(e => e && t.state[e] === FIRE);
    t.burnRamp[m] = flame ? t.ramps[flame] : t.ramps[m];
  }

  // Reactions: a cell of `a` next to a cell of `b` becomes into[0] and b into[1] (null keeps it), with a chance per
  // frame; `heat` warms both (or cools, if negative); `ignite` and `douse` light or put out one side; `burning` makes
  // the reaction wait until that side burns.
  const reactions = source.reactions ?? [];
  if (!Array.isArray(reactions) || reactions.length > LIMITS.reactions) fail('powder.reactions', `expected a list of at most ${LIMITS.reactions} reactions`);
  reactions.forEach((r, n) => {
    const path = `powder.reactions[${n}]`;
    if (!isObject(r)) fail(path, 'expected { a, b, into, chance, heat, ignite, douse, burning }');
    known(r, ['a', 'b', 'into', 'chance', 'heat', 'ignite', 'douse', 'burning'], path);
    const a = ref(r.a, `${path}.a`, false), b = ref(r.b, `${path}.b`);
    const into = r.into ?? [null, null];
    if (!Array.isArray(into) || into.length !== 2) fail(`${path}.into`, 'expected [what a becomes, what b becomes]; null keeps it');
    const side = (value, label) => { if (value !== undefined && value !== 'a' && value !== 'b') fail(`${path}.${label}`, 'expected "a" or "b"'); return value === 'a' ? 1 : value === 'b' ? 2 : 0; };
    const entry = {
      a, b, into: into.map((v, k) => (v === null ? -1 : ref(v, `${path}.into[${k}]`))), chance: chanceOf(r.chance ?? 1, `${path}.chance`),
      heat: r.heat === undefined ? 0 : degrees(r.heat, `${path}.heat`), ignite: side(r.ignite, 'ignite'), douse: side(r.douse, 'douse'), burning: side(r.burning, 'burning')
    };
    for (const [key, which] of [['ignite', entry.ignite], ['douse', entry.douse], ['burning', entry.burning]]) {
      const target = which === 1 ? a : which === 2 ? b : -1;
      if (target >= 0 && t.igniteAt[target] === NEVER_ABOVE) fail(`${path}.${key}`, `${t.names[target]} does not burn; give it a burn`);
    }
    if (t.pair[a * M + b] !== -1 || t.pair[b * M + a] !== -1) fail(path, `${t.names[a]} and ${t.names[b]} already react; one reaction per pair`);
    const index = t.reactions.length;
    t.reactions.push(entry);
    t.pair[a * M + b] = index * 2;
    if (a !== b) t.pair[b * M + a] = index * 2 + 1;
    t.reactive[a] = 1; t.reactive[b] = 1;
  });
  t.reactive[0] = 0;

  t.wall = source.wall === undefined ? (id.get('wall') ?? 0) : ref(source.wall, 'powder.wall', false);
  if (t.wall && (t.state[t.wall] !== SOLID || t.falls[t.wall])) fail('powder.wall', 'the wall material must be a fixed solid (one that does not fall)');
  t.anyFalls = t.falls.some(f => f);
  // How a loose piece of solids that fall comes down: straight down as one block, or as a rigid body that turns.
  if (source.pieces !== undefined && source.pieces !== 'drop' && source.pieces !== 'tumble') fail('powder.pieces', 'expected "drop" (a loose piece falls straight down as one block) or "tumble" (it falls as a rigid body: it turns, tips off ledges and stubs, floats and comes to rest)');
  t.tumble = source.pieces === 'tumble';
  t.scene = source.scene ?? [];
  if (!Array.isArray(t.scene) || t.scene.length > LIMITS.scene) fail('powder.scene', `expected a list of at most ${LIMITS.scene} fills`);
  t.inputs = source.inputs ?? [];
  if (!Array.isArray(t.inputs) || t.inputs.length > LIMITS.inputs) fail('powder.inputs', `expected a list of at most ${LIMITS.inputs} scripted inputs`);
  t.ref = ref;
  return t;
}

// ---- The live grid ------------------------------------------------------------------------------------------------
// Little-endian systems (all common ones) store RGBA as ABGR in a 32-bit word.
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const pack = ([r, g, b, a]) => (LITTLE ? ((a << 24) | (b << 16) | (g << 8) | r) : ((r << 24) | (g << 16) | (b << 8) | a)) >>> 0;
const QUEUED = 4096;

// A live grid of a source: step(n), the inputs (paint, erase, wall, heat, push, burst, queued for the next step), at(x, y),
// measure(), render(). With { record: true }, `strokes` keeps every input as a stroke to replay (replayStrokes) or pack
// into a link (packStrokes), up to LIMITS.strokes (65,536) of them. `recordedUntil` is null while every stroke so far is
// recorded; once one is left out it is that stroke's frame, and nothing more is recorded: a replay is exact for that many
// frames (replayStrokes(fresh, strokes, recordedUntil)), so cut a replay link there. Without a recording it stays null.
export function createLivePowder(source, options = {}) {
  known(options, ['record'], 'live');
  const T = readPowder(source), { width: W, height: H, M, seed, ambient, gravity: G, clings } = T, N = W * H, TUMBLE = T.tumble && T.anyFalls;
  const { aboveLatent, belowLatent, state, density, spread, speed, expand, still, drag, splash, falls, birth, conduct, cool, hold, lifeMin, lifeMax, lifeInto, lifeChance, aboveAt, aboveInto, aboveChance, belowAt, belowInto, belowChance, igniteAt, burnMin, burnMax, burnInto, burnChance, burnHeat, emitMat, emitChance, burnEmitMat, burnEmitChance, reactive, pair, reactions } = T;
  // Cells: material, colour shade, flags, frames of life (or of burning) left, the frame last moved, temperature,
  // and a velocity with the fraction of a pixel moved so far along each axis.
  const mat = new Uint8Array(N), shade = new Uint8Array(N), flag = new Uint8Array(N), life = new Uint16Array(N), stamp = new Uint16Array(N);
  const vx = new Int16Array(N), vy = new Int16Array(N), fx = new Uint8Array(N), fy = new Uint8Array(N);
  let temp = new Int32Array(N).fill(ambient), spare = new Int32Array(N);
  let t = 0, tick = 0, r = 1;
  // Set when a solid appears or goes, so the pieces that fall are found again; and while any piece is loose.
  let supportChanged = T.anyFalls, loose = false;
  // Settled regions. The grid is cut into 16 × 16 chunks, and a chunk is stepped (its cells and its heat) only while
  // something in it moved, changed or still might. A cell that moves or changes wakes its chunk for the next frame,
  // and the chunks beside it when it lies on an edge; a cell that is busy without changing (burning, ageing, a gas, a
  // chance not yet taken, a neighbour it may react with) keeps its own chunk awake; heat that flows wakes both ends.
  // A big quiet scene costs little more than drawing it.
  const CW = (W + 15) >> 4, CH = (H + 15) >> 4;
  let awake = new Uint8Array(CW * CH).fill(1), next = new Uint8Array(CW * CH).fill(1);
  const chunkOf = new Uint16Array(N), edges = new Uint8Array(N);
  for (let y = 0, c = 0; y < H; y++) for (let x = 0; x < W; x++, c++) {
    chunkOf[c] = (y >> 4) * CW + (x >> 4);
    edges[c] = ((x & 15) === 0 && x > 0 ? 1 : 0) | ((x & 15) === 15 && x < W - 1 ? 2 : 0) | ((y & 15) === 0 && y > 0 ? 4 : 0) | ((y & 15) === 15 && y < H - 1 ? 8 : 0);
  }
  const keep = c => { next[chunkOf[c]] = 1; };
  // A resting liquid looks FAR along its row for a drop or for more of its kind, further than the chunks a change wakes.
  // So a chunk where such a liquid had room beside it when last stepped is `watching`, and a change anywhere in a chunk
  // (`ripple`: 1, and 2 when on its top row, whose changes the row above sees as drops) wakes the watching chunks within
  // FAR of it on its chunk row (and the one above) for the next frame: a hole dug 30 pixels from a sleeping puddle drains it.
  const SPAN = (FAR + 15) >> 4, ripple = new Uint8Array(CW * CH), watching = new Uint8Array(CW * CH);
  const widen = () => {
    for (let k = 0; k < ripple.length; k++) {
      const bits = ripple[k];
      if (!bits) continue;
      ripple[k] = 0;
      const j = (k / CW) | 0, i = k - j * CW, i0 = i > SPAN ? i - SPAN : 0, i1 = i + SPAN < CW ? i + SPAN : CW - 1;
      for (let row = bits & 2 && j > 0 ? j - 1 : j; row <= j; row++) for (let n = row * CW + i0, end = row * CW + i1; n <= end; n++) if (watching[n]) next[n] = 1;
    }
  };

  // ---- Air ----
  // Velocities on the faces of a coarse grid (u across vertical faces, v across horizontal ones, in pixels a frame),
  // stepped as stable fluids: heat lifts it, swirl curls it, it settles toward the wind at `calm` a frame, it is
  // carried along itself and made divergence-free with a fixed number of over-relaxed red-black Gauss-Seidel sweeps
  // (warm-started from the last frame's pressure). A coarse cell
  // more than half full of solids, powders or liquids is a wall; the grid's bottom edge is a wall and the others are
  // open, so wind blows through and gases that ride out are gone. Plain arithmetic and sqrt only, in a fixed order, so
  // it is the same in every engine.
  const F = T.flow, S = F ? F.cell : 1, GW = F ? Math.ceil(W / S) : 0, GH = F ? Math.ceil(H / S) : 0, G2 = GW * GH;
  const u = new Float64Array(F ? (GW + 1) * GH : 0), v = new Float64Array(F ? GW * (GH + 1) : 0), u2 = new Float64Array(u.length), v2 = new Float64Array(v.length);
  const q = new Float64Array(G2), div = new Float64Array(G2), wall = new Uint8Array(G2), warm = new Float64Array(G2), curl = new Float64Array(G2);
  // Each cell's coarse cell, and the air at the centre of each coarse cell (in 256ths of a pixel a frame), for what
  // falls through it.
  const coarseOf = new Int32Array(F ? N : 0), centreU = new Float64Array(G2), centreV = new Float64Array(G2);
  for (let c = 0; c < coarseOf.length; c++) { const x = c % W; coarseOf[c] = Math.floor((c - x) / W / S) * GW + Math.floor(x / S); }
  const [windU, windV] = F ? F.wind : [0, 0], SWEEPS = 14, RELAX = 1.6, FASTEST = 4;
  // The air starts out blowing with the wind.
  u.fill(windU); v.fill(windV);
  let stirred = !!F;
  const sampleU = (px, py) => {
    let gx = px / S, gy = py / S - 0.5;
    gx = gx < 0 ? 0 : gx > GW ? GW : gx; gy = gy < 0 ? 0 : gy > GH - 1 ? GH - 1 : gy;
    const i = Math.floor(gx), j = Math.floor(gy), i1 = i < GW ? i + 1 : GW, j1 = j < GH - 1 ? j + 1 : GH - 1, a = gx - i, b = gy - j, r0 = j * (GW + 1), r1 = j1 * (GW + 1);
    return (u[r0 + i] * (1 - a) + u[r0 + i1] * a) * (1 - b) + (u[r1 + i] * (1 - a) + u[r1 + i1] * a) * b;
  };
  const sampleV = (px, py) => {
    let gx = px / S - 0.5, gy = py / S;
    gx = gx < 0 ? 0 : gx > GW - 1 ? GW - 1 : gx; gy = gy < 0 ? 0 : gy > GH ? GH : gy;
    const i = Math.floor(gx), j = Math.floor(gy), i1 = i < GW - 1 ? i + 1 : GW - 1, j1 = j < GH ? j + 1 : GH, a = gx - i, b = gy - j;
    return (v[j * GW + i] * (1 - a) + v[j * GW + i1] * a) * (1 - b) + (v[j1 * GW + i] * (1 - a) + v[j1 * GW + i1] * a) * b;
  };
  const uWall = (i, j) => (i > 0 && wall[j * GW + i - 1]) || (i < GW && wall[j * GW + i]);
  const vWall = (i, j) => j === GH || (j > 0 && wall[(j - 1) * GW + i]) || wall[j * GW + i];
  // One frame of air, before the cells move.
  const airStep = () => {
    // Walls and warmth from the cells: the share of each coarse cell that blocks air, and its mean heat above ambient.
    let hot = false;
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const y0 = j * S, y1 = y0 + S < H ? y0 + S : H, x0 = i * S, x1 = x0 + S < W ? x0 + S : W;
      let full = 0, sum = 0;
      for (let y = y0; y < y1; y++) for (let c = y * W + x0, end = y * W + x1; c < end; c++) {
        const st = state[mat[c]];
        if (st !== EMPTY && st !== GAS && st !== FIRE) full++;
        sum += temp[c] - ambient;
      }
      const n = (y1 - y0) * (x1 - x0), k = j * GW + i;
      wall[k] = full * 2 > n ? 1 : 0;
      warm[k] = sum > 0 ? sum / (n * SIXTEENTHS) : 0;
      if (warm[k] > 1) hot = true;
    }
    if (!stirred && !hot && !windU && !windV) return;
    // Heat lifts the air: `rise` pixels a frame², a frame, for a coarse cell a thousand degrees above ambient.
    if (hot && F.rise) for (let j = 1; j < GH; j++) for (let i = 0; i < GW; i++) {
      const a = warm[(j - 1) * GW + i], b = warm[j * GW + i], e = (a + b) / 2;
      v[j * GW + i] -= F.rise * (e < 1000 ? e : 1000) / 1000;
    }
    // Swirl: vorticity confinement, pushing round the curls the flow already has.
    if (F.swirl) {
      // The curl at each cell centre, from the centre velocities (the mean of each cell's two faces) around it.
      const U1 = GW + 1;
      for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
        const il = i > 0 ? i - 1 : i, ir = i < GW - 1 ? i + 1 : i, ju = j > 0 ? j - 1 : j, jd = j < GH - 1 ? j + 1 : j;
        const right = v[j * GW + ir] + v[(j + 1) * GW + ir], left = v[j * GW + il] + v[(j + 1) * GW + il];
        const down = u[jd * U1 + i] + u[jd * U1 + i + 1], up = u[ju * U1 + i] + u[ju * U1 + i + 1];
        curl[j * GW + i] = (right - left - down + up) / 4;
      }
      const abs = k => (curl[k] < 0 ? -curl[k] : curl[k]);
      for (let j = 1; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) {
        const k = j * GW + i;
        if (wall[k]) continue;
        const nx = (abs(k + 1) - abs(k - 1)) / 2, ny = (abs(k + GW) - abs(k - GW)) / 2, length = Math.sqrt(nx * nx + ny * ny) + 1e-9;
        const fx = F.swirl * (ny / length) * curl[k], fy = -F.swirl * (nx / length) * curl[k];
        u[j * (GW + 1) + i] += fx / 2; u[j * (GW + 1) + i + 1] += fx / 2;
        v[j * GW + i] += fy / 2; v[(j + 1) * GW + i] += fy / 2;
      }
    }
    // Settling toward the wind.
    if (F.calm) {
      for (let k = 0; k < u.length; k++) u[k] += (windU - u[k]) * F.calm;
      for (let k = 0; k < v.length; k++) v[k] += (windV - v[k]) * F.calm;
    }
    // Carried along itself, from where each face's air was a frame ago.
    for (let j = 0; j < GH; j++) for (let i = 0; i <= GW; i++) {
      const k = j * (GW + 1) + i, px = i * S, py = (j + 0.5) * S;
      u2[k] = uWall(i, j) ? 0 : sampleU(px - u[k], py - sampleV(px, py));
    }
    for (let j = 0; j <= GH; j++) for (let i = 0; i < GW; i++) {
      const k = j * GW + i, px = (i + 0.5) * S, py = j * S;
      v2[k] = vWall(i, j) ? 0 : sampleV(px - sampleU(px, py), py - v[k]);
    }
    u.set(u2); v.set(v2);
    // Made divergence-free: q is the pressure (in pixels a frame), open above the top edge.
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      div[k] = wall[k] ? 0 : u[j * (GW + 1) + i + 1] - u[j * (GW + 1) + i] + v[(j + 1) * GW + i] - v[j * GW + i];
    }
    for (let sweep = 0; sweep < SWEEPS; sweep++) for (let colour = 0; colour < 2; colour++) for (let j = 0; j < GH; j++) for (let i = (j + colour) & 1; i < GW; i += 2) {
      const k = j * GW + i;
      if (wall[k]) continue;
      let sum = 0, n = 0;
      if (i === 0) n++; else if (!wall[k - 1]) { sum += q[k - 1]; n++; }
      if (i === GW - 1) n++; else if (!wall[k + 1]) { sum += q[k + 1]; n++; }
      if (j === 0) n++; else if (!wall[k - GW]) { sum += q[k - GW]; n++; }
      if (j < GH - 1 && !wall[k + GW]) { sum += q[k + GW]; n++; }
      q[k] = n ? q[k] + RELAX * ((sum - div[k]) / n - q[k]) : 0;
    }
    let fastest = 0;
    for (let j = 0; j < GH; j++) for (let i = 0; i <= GW; i++) {
      const k = j * (GW + 1) + i;
      if (uWall(i, j)) { u[k] = 0; continue; }
      u[k] -= (i < GW ? q[j * GW + i] : 0) - (i > 0 ? q[j * GW + i - 1] : 0);
      u[k] = u[k] > FASTEST ? FASTEST : u[k] < -FASTEST ? -FASTEST : u[k];
      if (u[k] > fastest) fastest = u[k]; else if (-u[k] > fastest) fastest = -u[k];
    }
    for (let j = 0; j <= GH; j++) for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      if (vWall(i, j)) { v[k] = 0; continue; }
      v[k] -= q[j * GW + i] - (j > 0 ? q[(j - 1) * GW + i] : 0);
      v[k] = v[k] > FASTEST ? FASTEST : v[k] < -FASTEST ? -FASTEST : v[k];
      if (v[k] > fastest) fastest = v[k]; else if (-v[k] > fastest) fastest = -v[k];
    }
    // Still air with nothing stirring it is left alone until something does.
    stirred = fastest > 0.001 || hot || !!windU || !!windV;
    if (!stirred) { u.fill(0); v.fill(0); }
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      centreU[k] = (u[j * (GW + 1) + i] + u[j * (GW + 1) + i + 1]) * SUB / 2;
      centreV[k] = (v[k] + v[k + GW]) * SUB / 2;
    }
  };
  // A gas or flame cell rides the air, plus its own rise (`speed`, up if lighter than air), plus a little wander so a
  // plume frays; it keeps the fraction of a pixel it has moved in fx and fy.
  const WANDER = [0, 0, 0, 0.35, 0, 0.2];
  const ride = (c, x, y, m, s) => {
    const up = density[m] < AIR, own = speed[m] / ONE, px = x + 0.5, py = y + 0.5;
    const tu = sampleU(px, py) + ((rand() & 255) - 128) * WANDER[s] / 128, tv = sampleV(px, py) + (up ? -own : own);
    const ax = fx[c] + Math.round(tu * SUB), ay = fy[c] + Math.round(tv * SUB);
    let nx = ax >> 8, ny = ay >> 8;
    fx[c] = ax & 255; fy[c] = ay & 255;
    const sx = nx < 0 ? -1 : 1, sy = ny < 0 ? -1 : 1;
    nx = nx < 0 ? -nx : nx; ny = ny < 0 ? -ny : ny;
    if (nx > 6) nx = 6;
    if (ny > 6) ny = 6;
    let at = c, xs = 0, ys = 0;
    while (xs < nx || ys < ny) {
      if (ys < ny && (xs >= nx || ys * nx <= xs * ny)) {
        ys++;
        const yy = y + sy;
        // Its own way up or down it bubbles through liquids and sorts among gases; against it, only into air. Off the
        // top edge (open), it is gone.
        if (yy < 0) { become(at, 0); return true; }
        if (yy < H && (sy === (up ? -1 : 1) ? drifts(m, at + sy * W, up) : mat[at + sy * W] === 0)) { swap(at, at + sy * W); at += sy * W; y = yy; continue; }
        ny = ys;
      } else {
        xs++;
        const xx = x + sx;
        if (xx < 0 || xx >= W) { become(at, 0); return true; }
        if (mat[at + sx] === 0) { swap(at, at + sx); at += sx; x = xx; continue; }
        nx = xs;
      }
    }
    return at !== c;
  };
  const touch = c => {
    const k = chunkOf[c], e = edges[c];
    next[k] = 1; ripple[k] |= e & 4 ? 2 : 1;
    if (!e) return;
    if (e & 1) next[k - 1] = 1;
    if (e & 2) next[k + 1] = 1;
    if (e & 4) { next[k - CW] = 1; if (e & 1) next[k - CW - 1] = 1; if (e & 2) next[k - CW + 1] = 1; }
    if (e & 8) { next[k + CW] = 1; if (e & 1) next[k + CW - 1] = 1; if (e & 2) next[k + CW + 1] = 1; }
  };
  // The random stream: xorshift32, reseeded from craft's hash at every frame and every input.
  const rand = () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return r >>> 0; };
  const reseed = (...values) => { r = hash(seed, ...values) | 0 || 1; };
  const lifeDraw = m => (lifeMax[m] ? lifeMin[m] + rand() % (lifeMax[m] - lifeMin[m] + 1) : 0);
  const clampT = v => (v < T_LOW * SIXTEENTHS ? T_LOW * SIXTEENTHS : v > T_HIGH * SIXTEENTHS ? T_HIGH * SIXTEENTHS : v);

  // A cell changes material in place and keeps its temperature (a phase change, burning out, a life ending).
  // Blotch and grain fields per material, from craft's seeded value noise.
  const fields = Array.from(T.pattern, (p, m) => (p === 1 ? ditherThreshold('value', [0, 0], hash(seed, m, 1), 6) : p === 2 ? ditherThreshold('value', [0, 0], hash(seed, m, 2), 12) : null));
  const shadeAt = (c, m) => {
    const p = T.pattern[m];
    if (!p) return rand() & 255;
    const x = c % W, y = (c - x) / W;
    if (p === 1) return (fields[m](x, y) * 256) | 0;
    // Grain: each row its own tone, drifting slowly along the row.
    return ((hash(seed, m, y) & 255) * 0.55 + fields[m](x, y * 6) * 115) | 0;
  };
  const become = (c, m) => {
    if (state[mat[c]] === SOLID || state[m] === SOLID) supportChanged = true;
    mat[c] = m; flag[c] = 0; shade[c] = m ? shadeAt(c, m) : 0; life[c] = lifeDraw(m);
    vx[c] = 0; vy[c] = 0; fx[c] = 0; fy[c] = 0;
    touch(c);
    return m;
  };
  // A new cell (given off, or made by a reaction): at least as warm as its material is made.
  const born = (c, m, warm) => {
    become(c, m);
    if (m) temp[c] = warm > birth[m] ? warm : birth[m];
    stamp[c] = tick;
    if (expand[m]) puff(c, m);
  };
  // A gas that expands fills up to `expand` free cells beside it, at its temperature.
  const puff = (c, m) => {
    const x = c % W, start = rand() & 3;
    for (let k = 0, made = 0; k < 4 && made < expand[m]; k++) {
      const side = (start + k) & 3, d = side === 0 ? (c >= W ? c - W : -1) : side === 1 ? (x < W - 1 ? c + 1 : -1) : side === 2 ? (c < N - W ? c + W : -1) : (x > 0 ? c - 1 : -1);
      if (d >= 0 && mat[d] === 0) { become(d, m); temp[d] = temp[c]; stamp[d] = tick; made++; }
    }
  };
  const swap = (a, b) => {
    let v = mat[a]; mat[a] = mat[b]; mat[b] = v;
    v = shade[a]; shade[a] = shade[b]; shade[b] = v;
    v = flag[a]; flag[a] = flag[b]; flag[b] = v;
    v = life[a]; life[a] = life[b]; life[b] = v;
    v = temp[a]; temp[a] = temp[b]; temp[b] = v;
    v = vx[a]; vx[a] = vx[b]; vx[b] = v;
    v = vy[a]; vy[a] = vy[b]; vy[b] = v;
    v = fx[a]; fx[a] = fx[b]; fx[b] = v;
    v = fy[a]; fy[a] = fy[b]; fy[b] = v;
    stamp[b] = tick;
    touch(a); touch(b);
  };
  // Can a falling cell of m move into d? Into air, or by sinking through anything lighter that moves.
  // `chancy` is set when it could have but the draw said not this frame, so the cell's chunk stays awake.
  let chancy = false;
  const sinks = (m, d) => {
    const n = mat[d];
    if (n === 0) return true;
    const s = state[n];
    if (s === SOLID || density[n] >= density[m]) return false;
    if (drag[n] === 0 || rand() >= drag[n]) return true;
    chancy = true;
    return false;
  };
  // Can a gas or flame move into d, the way it drifts (up if lighter than air)? A gas bubbles up through liquids
  // and heavier gases; fire only through gases.
  const drifts = (m, d, up) => {
    const n = mat[d];
    if (n === 0) return true;
    const s = state[n];
    if (s === GAS || (s === LIQUID && state[m] === GAS)) return up ? density[n] > density[m] && (drag[n] === 0 || rand() >= drag[n]) : density[n] < density[m];
    return false;
  };
  // A liquid's or gas's sideways run: the farthest of up to `reach` free cells in direction s, stopping early at a
  // cell it could fall (or rise) from, when `dropped` is set. `blocker` is the material that ended it (-1 for none).
  let dropped = false, blocker = -1;
  const run = (c, x, s, reach, ahead, intoGas) => {
    let best = -1;
    dropped = false; blocker = -1;
    for (let i = 1; i <= reach; i++) {
      const xx = x + s * i;
      if (xx < 0 || xx >= W) break;
      const d = c + s * i, n = mat[d];
      if (n !== 0 && !(intoGas && (state[n] === GAS || state[n] === FIRE))) { blocker = n; break; }
      best = d;
      const below = d + ahead;
      if (ahead && below >= 0 && below < N && mat[below] === 0) { dropped = true; break; }
    }
    return best;
  };
  // A powder or liquid cell in the air: gravity, then this frame's whole pixels one cell at a time, more vertically or
  // sideways as its velocity leans, sliding off what it falls onto as a resting cell would, and landing where it can
  // go no lower. `first` says the cell below is already known to be free (it was just checked, with its draw).
  // A cell that was moving keeps its chunk awake for a frame after it stops, even where it stopped without moving (on a
  // pool's surface, or held back by a liquid's drag), so it can still sink, slide or drift as a resting cell does.
  let landU = 0, landV = 0;
  const fly = (c, x, y, m, s, first) => {
    let v = vy[c] + G, u = vx[c];
    const moving = vy[c] !== 0 || u !== 0;
    chancy = false;
    // Through moving air it is carried toward the air's speed (at its coarse cell's centre), the more the lighter it
    // is (`carry` for a cell of density 1): ash drifts, sand barely leans.
    if (F && F.carry && stirred) {
      const k = F.carry * AIR / density[m], g = coarseOf[c];
      u += Math.round((centreU[g] - u) * k);
      v += Math.round((centreV[g] - v) * k);
    }
    if (v > TOP) v = TOP;
    // Falling, it moves at least a pixel a frame, as a cell that starts to fall always has; gravity adds the rest.
    if (v >= 0 && v < SUB) v = SUB;
    const ay = fy[c] + (v < 0 ? -v : v), ax = fx[c] + (u < 0 ? -u : u);
    let ny = ay >> 8, nx = ax >> 8;
    fy[c] = ay & 255; fx[c] = ax & 255;
    const up = v < 0, sx = u < 0 ? -1 : 1;
    let at = c, xs = 0, ys = 0;
    while (xs < nx || ys < ny) {
      if (ys < ny && (xs >= nx || ys * nx <= xs * ny)) {
        ys++;
        const yy = up ? y - 1 : y + 1;
        if (yy >= 0 && yy < H) {
          const d = up ? at - W : at + W;
          if ((first && at === c) || sinks(m, d)) {
            const into = mat[d];
            swap(at, d); at = d; y = yy;
            // Into a liquid: it sinks on slowly from here.
            if (into) { if (v > SUB) v = SUB; if (u) u = 0; break; }
            continue;
          }
        }
        // A ceiling: it stops rising and carries on sideways.
        if (up) { v = 0; ny = ys; continue; }
        // Onto something: off it diagonally, losing a quarter of its speed, as a resting cell slides off.
        if (yy < H) {
          const side = rand() >>> 31 ? 1 : -1;
          let d = 0;
          if (x + side >= 0 && x + side < W && sinks(m, at + W + side)) d = side;
          else if (x - side >= 0 && x - side < W && sinks(m, at + W - side)) d = -side;
          if (d) { swap(at, at + W + d); at += W + d; x += d; y = yy; v -= v >> 2; continue; }
        }
        land(at, x, y, m, s, v, u); v = landV; u = landU;
        break;
      } else {
        xs++;
        const xx = x + sx;
        if (xx >= 0 && xx < W && sinks(m, at + sx)) { swap(at, at + sx); at += sx; x = xx; continue; }
        // A wall: the sideways speed is lost.
        u = 0; nx = xs;
      }
    }
    vy[at] = v; vx[at] = u;
    if (v || u || moving || chancy) keep(at);
  };
  // Where a falling cell lands, its velocity becomes landV and landU. Onto a cell still falling, it keeps that cell's
  // speed, so a falling mass falls together. A fast landing (SPLASH or more) throws a share of cells back up as spray
  // (`splash`), and a liquid's others surge sideways, the way that is open, with three quarters of the speed.
  const land = (c, x, y, m, s, v, u) => {
    fy[c] = 0;
    const under = y < H - 1 ? c + W : -1, below = under >= 0 ? mat[under] : 0;
    if (below && vy[under] > 0 && (state[below] === POWDER || state[below] === LIQUID)) { landV = vy[under] < v ? vy[under] : v; landU = u; return; }
    landV = 0; landU = s === LIQUID ? u : 0;
    if (v < SPLASH) return;
    if (splash[m] && rand() < splash[m] && y > 0 && mat[c - W] === 0) {
      // Back up at a quarter to a half of the speed, and sideways at up to half.
      landV = -((v * (64 + (rand() & 63))) >> 8);
      landU = (rand() >>> 31 ? 1 : -1) * ((v * (rand() & 127)) >> 8);
      return;
    }
    if (s !== LIQUID) return;
    const left = x > 0 && mat[c - 1] === 0, right = x < W - 1 && mat[c + 1] === 0;
    const sign = left === right ? (rand() >>> 31 ? 1 : -1) : right ? 1 : -1;
    landU = sign * ((v * 3) >> 2);
  };

  // Gives off m into a free neighbour of c, upwards more often than sideways.
  const emitInto = (c, x, y, m) => {
    const roll = rand() & 3;
    const d = roll < 2 ? (y > 0 ? c - W : -1) : roll === 2 ? (x > 0 ? c - 1 : -1) : (x < W - 1 ? c + 1 : -1);
    if (d >= 0 && mat[d] === 0) born(d, m, temp[c]);
  };
  const light = c => { flag[c] = BURNING; life[c] = burnMin[mat[c]] + rand() % (burnMax[mat[c]] - burnMin[mat[c]] + 1); touch(c); };

  // A reaction between c (material m) and its neighbour d.
  const react = (c, d, index) => {
    const rx = reactions[index >> 1], forward = !(index & 1), a = forward ? c : d, b = forward ? d : c;
    if (rx.burning && !(flag[rx.burning === 1 ? a : b] & BURNING)) return;
    if (rx.chance < ONE && rand() >= rx.chance) return;
    const ta = temp[a], tb = temp[b];
    if (rx.into[0] >= 0 && rx.into[0] !== mat[a]) born(a, rx.into[0], ta);
    if (rx.into[1] >= 0 && rx.into[1] !== mat[b]) born(b, rx.into[1], tb);
    if (rx.heat) { if (mat[a]) temp[a] = clampT(temp[a] + rx.heat); if (mat[b]) temp[b] = clampT(temp[b] + rx.heat); }
    const lit = rx.ignite === 1 ? a : rx.ignite === 2 ? b : -1;
    if (lit >= 0 && mat[lit] && igniteAt[mat[lit]] !== NEVER_ABOVE && !(flag[lit] & BURNING)) light(lit);
    const out = rx.douse === 1 ? a : rx.douse === 2 ? b : -1;
    // Put out, it cools to the temperature its material is made at, so it must be heated through again to relight.
    if (out >= 0 && flag[out] & BURNING) { flag[out] = 0; life[out] = 0; temp[out] = birth[mat[out]]; }
    stamp[a] = tick; stamp[b] = tick;
    touch(a); touch(b);
  };
  // Whether c (material m) has a neighbour it could react with now: its chunk stays awake until it has.
  const ready = (c, d, index) => {
    if (index === -1) return false;
    const rx = reactions[index >> 1];
    if (!rx.burning) return true;
    const forward = !(index & 1);
    return !!(flag[rx.burning === 1 ? (forward ? c : d) : (forward ? d : c)] & BURNING);
  };
  const couldReact = (c, x, y, m) => {
    const row = m * M;
    return (y > 0 && ready(c, c - W, pair[row + mat[c - W]])) || (x < W - 1 && ready(c, c + 1, pair[row + mat[c + 1]])) ||
      (y < H - 1 && ready(c, c + W, pair[row + mat[c + W]])) || (x > 0 && ready(c, c - 1, pair[row + mat[c - 1]]));
  };

  // One frame: queued inputs, then every cell from the bottom row up (each row in alternating directions), then heat.
  const advance = () => {
    // The stamps are 16 bits, so they are wiped as the tick wraps: one left from 65535 frames ago would read as this frame's.
    if (tick === 65535) { stamp.fill(0); tick = 1; } else tick++;
    script.forEach((entry, n) => { if (t >= entry.from && t <= entry.to && (t - entry.from) % entry.every === 0) { reseed(SALT.script, t, n); entry.run(); } });
    queue.forEach((input, n) => { reseed(SALT.input, t, n); input(); });
    queue = [];
    widen();
    const was = awake;
    awake = next; next = was; next.fill(0);
    for (let k = 0; k < awake.length; k++) if (awake[k]) watching[k] = 0;
    if (F) airStep();
    reseed(SALT.step, t);
    for (let y = H - 1; y >= 0; y--) {
      const row = y * W, forward = ((y + t) & 1) === 0, band = (y >> 4) * CW;
      for (let q = 0; q < CW; q++) {
        const cx = forward ? q : CW - 1 - q;
        if (!awake[band + cx]) continue;
        const x0 = cx << 4, x1 = x0 + 16 < W ? x0 + 16 : W;
        for (let k = x0; k < x1; k++) {
          const x = forward ? k : x0 + x1 - 1 - k, c = row + x;
          let m = mat[c];
          if (m === 0 || stamp[c] === tick) continue;
          // Phase changes.
          const heat = temp[c];
          if (heat >= aboveAt[m] + aboveLatent[m]) { if (aboveChance[m] === ONE || rand() < aboveChance[m]) { temp[c] = heat - aboveLatent[m]; m = become(c, aboveInto[m]); if (!m) continue; if (expand[m]) puff(c, m); } else keep(c); }
          else if (heat <= belowAt[m] - belowLatent[m]) { if (belowChance[m] === ONE || rand() < belowChance[m]) { temp[c] = heat + belowLatent[m]; m = become(c, belowInto[m]); if (!m) continue; if (expand[m]) puff(c, m); } else keep(c); }
          // Burning, or a life running out.
          if (flag[c] & BURNING) {
            keep(c);
            if (temp[c] < burnHeat[m]) temp[c] = burnHeat[m];
            const e = m * 2;
            if (burnEmitMat[e] && rand() < burnEmitChance[e]) emitInto(c, x, y, burnEmitMat[e]);
            if (burnEmitMat[e + 1] && rand() < burnEmitChance[e + 1]) emitInto(c, x, y, burnEmitMat[e + 1]);
            if (--life[c] === 0) { m = become(c, burnChance[m] === ONE || rand() < burnChance[m] ? burnInto[m] : 0); if (!m) continue; }
          } else if (temp[c] >= igniteAt[m]) light(c);
          else if (lifeMax[m]) { keep(c); if (--life[c] === 0) { m = become(c, lifeChance[m] === ONE || rand() < lifeChance[m] ? lifeInto[m] : 0); if (!m) continue; } }
          if (hold[m] > temp[c]) { temp[c] = hold[m]; keep(c); }
          const e = m * 2;
          if (emitMat[e] || emitMat[e + 1]) keep(c);
          if (emitMat[e] && rand() < emitChance[e]) emitInto(c, x, y, emitMat[e]);
          if (emitMat[e + 1] && rand() < emitChance[e + 1]) emitInto(c, x, y, emitMat[e + 1]);
          // One neighbour, chosen at random, may react.
          if (reactive[m]) {
            const side = rand() & 3;
            const d = side === 0 ? (y > 0 ? c - W : -1) : side === 1 ? (x < W - 1 ? c + 1 : -1) : side === 2 ? (y < H - 1 ? c + W : -1) : (x > 0 ? c - 1 : -1);
            if (d >= 0) {
              const index = pair[m * M + mat[d]];
              if (index !== -1) { react(c, d, index); m = mat[c]; if (!m || stamp[c] === tick) continue; }
            }
            if (reactive[m] && !next[chunkOf[c]] && couldReact(c, x, y, m)) keep(c);
          }
          // Moving.
          const s = state[m];
          if (s === POWDER || s === LIQUID) {
            // In the air (moving, or with nothing under it): it flies.
            if (vy[c]) { fly(c, x, y, m, s, false); continue; }
            chancy = false;
            // A viscous liquid falls freely but is slow to slide and spread: once it has somewhere to go, it waits this
            // frame with the chance its viscosity gives. Rolled only then, so a pool with nowhere to go comes to rest.
            const thick = s === LIQUID ? still[m] : 0;
            if (y < H - 1) {
              const d = c + W;
              if (sinks(m, d)) { fly(c, x, y, m, s, true); continue; }
              const side = rand() >>> 31 ? 1 : -1;
              const to = x + side >= 0 && x + side < W && sinks(m, d + side) ? d + side : x - side >= 0 && x - side < W && sinks(m, d - side) ? d - side : -1;
              if (to >= 0) { if (thick && rand() < thick) keep(c); else swap(c, to); continue; }
            }
            if (chancy) keep(c);
            if (s === LIQUID) {
              const u = vx[c], ahead = y < H - 1 ? W : 0;
              if (u) {
                // A surge: the liquid runs on the way it landed, as far as its speed carries it, slowing by a quarter a
                // frame, until it meets a wall or a drop.
                const reach = u < 0 ? -u >> 8 : u >> 8, to = run(c, x, u < 0 ? -1 : 1, reach > spread[m] ? reach : spread[m], ahead, true);
                if (to < 0) vx[c] = 0;
                else if (!thick || rand() >= thick) { swap(c, to); const left = u - (u >> 2); vx[to] = left > -SUB && left < SUB ? 0 : left; }
                keep(c);
              } else if (spread[m]) {
                // Downhill first: the nearer place within FAR either way where it could fall, approached at most its
                // spread a frame, so a terrace's end steps down onto the next and a puddle drains into a hole. Otherwise
                // a liquid holds together, and moves only the row's way (left on even rows, right on odd, so nothing
                // goes back and forth): the end of a strip joins the next strip of its kind, and a lone cell on a pool
                // drifts on until it meets something. Puddles and pools come to rest, flat but for one strip.
                const reach = spread[m], way = y & 1 ? 1 : -1;
                const r = run(c, x, 1, FAR, ahead, true), rd = dropped, rb = blocker;
                const l = run(c, x, -1, FAR, ahead, true), ld = dropped, lb = blocker;
                let to = -1;
                if (rd || ld) {
                  const dr = rd ? r - c : FAR + 1, dl = ld ? c - l : FAR + 1, dir = dr < dl || (dr === dl && way > 0) ? 1 : -1, dist = dir > 0 ? dr : dl;
                  to = c + dir * (dist < reach ? dist : reach);
                } else {
                  const end = way > 0 ? r : l;
                  if (end >= 0) {
                    const dist = (end - c) * way, lone = (x === 0 || mat[c - 1] !== m) && (x === W - 1 || mat[c + 1] !== m);
                    if ((way > 0 ? rb : lb) === m || (lone && ahead && state[mat[c + W]] === LIQUID)) to = c + way * (dist < reach ? dist : reach);
                  }
                }
                // With room beside it, it watches its row FAR either way: a change there wakes its chunk (see ripple).
                if (r >= 0 || l >= 0) watching[chunkOf[c]] = 1;
                if (to >= 0) { if (thick && rand() < thick) keep(c); else swap(c, to); }
              }
            } else if (vx[c]) vx[c] = 0;
          } else if (s === GAS || s === FIRE) {
            keep(c);
            if (F) {
              if (ride(c, x, y, m, s) || !spread[m]) continue;
              const up = density[m] < AIR, ahead = up ? (y > 0 ? -W : 0) : (y < H - 1 ? W : 0), side = rand() >>> 31 ? 1 : -1;
              let to = run(c, x, side, spread[m], ahead, false);
              if (to < 0) to = run(c, x, -side, spread[m], ahead, false);
              if (to >= 0) swap(c, to);
              continue;
            }
            if (speed[m] < ONE && rand() >= speed[m]) continue;
            const up = density[m] < AIR, dy = up ? -1 : 1, yy = y + dy, roll = rand();
            // Mostly straight on; a gas wanders sideways one frame in four, fire one in eight.
            if (yy >= 0 && yy < H && (roll & (s === FIRE ? 7 : 3)) !== 0) {
              const d = c + dy * W;
              if (drifts(m, d, up)) { swap(c, d); continue; }
              const side = roll & 8 ? 1 : -1;
              if (x + side >= 0 && x + side < W && drifts(m, d + side, up)) { swap(c, d + side); continue; }
              if (x - side >= 0 && x - side < W && drifts(m, d - side, up)) { swap(c, d - side); continue; }
            }
            if (spread[m]) {
              const side = roll & 16 ? 1 : -1, ahead = yy >= 0 && yy < H ? dy * W : 0;
              let to = run(c, x, side, spread[m], ahead, false);
              if (to < 0) to = run(c, x, -side, spread[m], ahead, false);
              if (to >= 0) swap(c, to);
            }
          }
        }
      }
    }
    if (TUMBLE) { if (supportChanged || loose || rigid.length) tumbles(); }
    else if (T.anyFalls && (supportChanged || loose)) structures();
    conductHeat();
    t++;
  };

  // ---- Structures ----
  // Solids that fall are joined into pieces through every neighbour, corners too. A piece is held while any of its
  // cells touches a fixed solid or stands on the bottom row; a loose piece falls as one rigid block, gaining speed as
  // a falling cell does, through air, gases and fire and through liquids lighter than itself (they rise through it),
  // and rests on whatever stops it. A piece resting on something that can move away is looked at again every frame.
  const piece = new Int32Array(T.anyFalls ? N : 0), seen = new Int32Array(T.anyFalls ? N : 0), nb = new Int32Array(8);
  let tag = 0;
  // The neighbours of c on the grid, into nb; returns how many.
  const around = c => {
    const x = c % W, l = x > 0, r = x < W - 1;
    let n = 0;
    if (c >= W) { nb[n++] = c - W; if (l) nb[n++] = c - W - 1; if (r) nb[n++] = c - W + 1; }
    if (l) nb[n++] = c - 1;
    if (r) nb[n++] = c + 1;
    if (c < N - W) { nb[n++] = c + W; if (l) nb[n++] = c + W - 1; if (r) nb[n++] = c + W + 1; }
    return n;
  };
  // The falling cells joined to `start`, into piece and tagged `mark` in seen; returns how many.
  const flood = (start, mark) => {
    seen[start] = mark; piece[0] = start;
    let n = 1;
    for (let k = 0; k < n; k++) {
      const count = around(piece[k]);
      // Tumbling, a piece is the cells of no other piece, and a material that clings (moss) makes pieces of its own: moss
      // round a post's foot holds on to the stone, not the post.
      for (let i = 0; i < count; i++) { const d = nb[i]; if (falls[mat[d]] && seen[d] !== mark && !(TUMBLE && (owner[d] || clings[mat[d]] !== clings[mat[start]]))) { seen[d] = mark; piece[n++] = d; } }
    }
    return n;
  };
  const structures = () => {
    supportChanged = false; loose = false;
    if (tag > 2147480000) { seen.fill(0); tag = 0; }
    const held = ++tag;
    for (let c = 0; c < N; c++) {
      if (!falls[mat[c]] || seen[c] === held) continue;
      let anchored = c >= N - W;
      if (!anchored) { const count = around(c); for (let i = 0; i < count && !anchored; i++) { const n = mat[nb[i]]; anchored = state[n] === SOLID && !falls[n]; } }
      if (!anchored) continue;
      const n = flood(c, held);
      for (let k = 0; k < n; k++) if (vy[piece[k]]) { vy[piece[k]] = 0; fy[piece[k]] = 0; }
    }
    for (let c = 0; c < N; c++) {
      if (!falls[mat[c]] || seen[c] >= held) continue;
      const own = ++tag, n = flood(c, own);
      let weight = 0;
      for (let k = 0; k < n; k++) weight += density[mat[piece[k]]];
      drop(piece.subarray(0, n), own, (weight / n) | 0);
    }
  };
  // Moves a loose piece down by its speed this frame, a row at a time, its cells from the bottom up so that what it
  // displaces passes up through it. `weight` is its mean density.
  const drop = (cells, own, weight) => {
    cells.sort();
    loose = true;
    let v = vy[cells[0]] + G;
    if (v > TOP) v = TOP;
    if (v < SUB) v = SUB;
    const a = fy[cells[0]] + v;
    for (let rows = a >> 8; rows > 0; rows--) {
      let free = true;
      for (let k = cells.length - 1; k >= 0 && free; k--) {
        const d = cells[k] + W;
        if (d >= N) free = false;
        else if (seen[d] !== own) { const n = mat[d], s = state[n]; free = n === 0 || s === GAS || s === FIRE || (s === LIQUID && density[n] < weight); }
      }
      if (!free) {
        // Landing fast on a liquid it floats on, it throws that liquid out from under it, up and away from its middle.
        if (v >= SPLASH) {
          const middle = (cells[0] % W + cells[cells.length - 1] % W) / 2;
          for (let k = 0; k < cells.length; k++) {
            const d = cells[k] + W;
            if (d >= N || seen[d] === own || state[mat[d]] !== LIQUID) continue;
            vx[d] = (d % W < middle ? -1 : 1) * ((v * 3) >> 2); vy[d] = -(v >> 1); touch(d);
          }
        }
        v = 0; break;
      }
      for (let k = cells.length - 1; k >= 0; k--) swap(cells[k], cells[k] + W);
      for (let k = 0; k < cells.length; k++) seen[cells[k]] = 0;
      for (let k = 0; k < cells.length; k++) seen[cells[k] += W] = own;
    }
    for (let k = 0; k < cells.length; k++) { vy[cells[k]] = v; fy[cells[k]] = v ? a & 255 : 0; }
  };

  // ---- Tumbling pieces (pieces: "tumble") ----
  // A loose piece is handed to a rigid-body world (bodies.js) as one body made of boxes, one for each run of its cells,
  // weighing what its cells weigh, so it turns as it falls, tips off a ledge or a stub its weight is not over, floats in
  // a liquid denser than it and comes to rest. Its cells stay in the grid as solids, so fire still burns them, heat still
  // moves through them and what falls lands on them. Each frame the cells of every moving piece are read back (a cell
  // that burnt or was erased leaves its piece, which is cut again, and split where it fell apart), the world steps, and
  // each piece's cells are written where its body is now: its picture turned by three shears (Paeth), which takes each
  // cell to exactly one cell, so every cell keeps its material, colour, burning, life and heat and none is lost or
  // doubled, then moved by whole pixels. What it moves into (air, gas, fire, a liquid or loose powder) is pushed to the
  // nearest free cell, so a piece that lands in a pool raises it and throws it up. A piece is held where a fixed solid is
  // beside it or over it (nailed to a wall, hung from a ceiling); standing on one, it rests there as a body and topples
  // once its weight is no longer over what holds it up.
  const owner = new Int32Array(TUMBLE ? N : 0), claim = new Int32Array(TUMBLE ? N : 0), visited = new Int32Array(TUMBLE ? N : 0), onTop = new Uint8Array(TUMBLE ? N : 0);
  const rigid = [], queue2 = new Int32Array(TUMBLE ? SEARCH : 0);
  let world = null, worldFrame = 0, nextId = 1, claimTag = 0, visitTag = 0, toX = new Int32Array(64), toY = new Int32Array(64);
  const fixedAt = c => state[mat[c]] === SOLID && !falls[mat[c]];
  // Held where a fixed solid is beside a cell or over it, or under a cell of a material that clings.
  const glued = (list, n) => {
    for (let k = 0; k < n; k++) {
      const c = list[k], x = c % W;
      if ((x > 0 && fixedAt(c - 1)) || (x < W - 1 && fixedAt(c + 1)) || (c >= W && fixedAt(c - W)) || (T.clings[mat[c]] && c < N - W && fixedAt(c + W))) return true;
    }
    return false;
  };
  // A piece's body from its picture: boxes over its runs of cells (each row's runs, carried down while the rows below
  // repeat them), its weight from its cells' densities, its inertia from theirs, about its centre of mass (mx, my).
  const shapeOf = p => {
    const rows = new Map(), order = Array.from({ length: p.n }, (_, k) => k).sort((a, b) => p.J[a] - p.J[b] || p.I[a] - p.I[b]);
    let inertia = 0, i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity, far = 0;
    for (const k of order) {
      const I = p.I[k], J = p.J[k], runs = rows.get(J) ?? rows.set(J, []).get(J), last = runs[runs.length - 1];
      if (last && last[1] === I - 1) last[1] = I; else runs.push([I, I]);
      const u = I + p.pu - p.mx, v = J + p.pv - p.my, rho = density[p.mat[k]] / 100;
      inertia += rho * (u * u + v * v + 1 / 6);
      if (I < i0) i0 = I; if (I > i1) i1 = I; if (J < j0) j0 = J; if (J > j1) j1 = J;
    }
    const used = new Set(), parts = [];
    for (const [J, runs] of rows) for (const [a, b] of runs) {
      if (used.has(`${J}:${a}`)) continue;
      let last = J;
      while ((rows.get(last + 1) ?? []).some(r => r[0] === a && r[1] === b) && !used.has(`${last + 1}:${a}`)) { last++; used.add(`${last}:${a}`); }
      const x0 = a + p.pu - 0.5 - p.mx, x1 = b + p.pu + 0.5 - p.mx, y0 = J + p.pv - 0.5 - p.my, y1 = last + p.pv + 0.5 - p.my;
      parts.push(polygonPart([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]));
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) { const d = x * x + y * y; if (d > far) far = d; }
    }
    return { parts, invMass: 1 / p.mass, invInertia: 1 / inertia, size: [i1 - i0 + 1, j1 - j0 + 1], extent: Math.sqrt(far) };
  };
  // A new piece from loose cells: its picture is the cells as they lie, turned about their centre of mass.
  const makePiece = (list, n) => {
    if (!world) world = createBodyWorld({ substeps: 8, iterations: 6, gravity: [0, G / SUB], walls: { left: true, right: true, top: false, bottom: true }, obstacles: [], bodies: [] }, { width: W, height: H });
    let x0 = W, y0 = H, mass = 0, sx = 0, sy = 0;
    for (let k = 0; k < n; k++) {
      const c = list[k], x = c % W, y = (c - x) / W, rho = density[mat[c]] / 100;
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      mass += rho; sx += rho * (x + 0.5); sy += rho * (y + 0.5);
    }
    const cx = sx / mass, cy = sy / mass, id = nextId++;
    const p = { id, n, mass, pu: x0 + 0.5 - cx, pv: y0 + 0.5 - cy, mx: 0, my: 0, I: new Int32Array(n), J: new Int32Array(n), gx: new Int32Array(n), gy: new Int32Array(n),
      mat: new Uint8Array(n), shade: new Uint8Array(n), flag: new Uint8Array(n), life: new Uint16Array(n), temp: new Int32Array(n),
      hold: { q: 0, x: x0, wx: 0, y: y0, wy: 0, d: 0, wd: 0 }, slept: false, ring: '' };
    for (let k = 0; k < n; k++) {
      const c = list[k], x = c % W, y = (c - x) / W;
      p.I[k] = x - x0; p.J[k] = y - y0; p.gx[k] = x; p.gy[k] = y;
      p.mat[k] = mat[c]; p.shade[k] = shade[c]; p.flag[k] = flag[c]; p.life[k] = life[c]; p.temp[k] = temp[c];
      owner[c] = id; vx[c] = 0; vy[c] = 0; fx[c] = 0; fy[c] = 0;
    }
    p.body = world.add({ ...shapeOf(p), x: cx, y: cy, bounce: 0.05, friction: 0.6 });
    rigid.push(p);
    return p;
  };
  // The cells of a piece kept (`keep[k]`), cut again: each group of them joined through any neighbour in its picture is
  // a piece of its own, the largest keeping `p`. Each keeps the picture's pivot and its drawn place and angle, so its cells
  // stay where they are, and moves as its part of the body moved (velocity and turning).
  const recut = (p, keep) => {
    const b = p.body, at = new Map();
    for (let k = 0; k < p.n; k++) if (keep[k]) at.set(p.J[k] * 4096 + p.I[k], k);
    const group = new Int32Array(p.n).fill(-1), groups = [];
    for (let k = 0; k < p.n; k++) {
      if (!keep[k] || group[k] >= 0) continue;
      const list = [k];
      group[k] = groups.length;
      for (let q = 0; q < list.length; q++) {
        const e = list[q];
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const f = at.get((p.J[e] + dj) * 4096 + p.I[e] + di);
          if (f !== undefined && group[f] < 0) { group[f] = groups.length; list.push(f); }
        }
      }
      groups.push(list.sort((a, c) => a - c));
    }
    // The largest part keeps the piece (its id and its body); the rest are new, up to MOST_PIECES in all. Past that, a part
    // lying wholly in the grid is let go as plain cells, which drop straight as one block as loose pieces past the cap
    // do (and become a piece of their own once there is room); one with cells above the grid stays with the largest.
    groups.sort((a, c) => c.length - a.length || a[0] - c[0]);
    const room = 1 + Math.max(0, MOST_PIECES - rigid.length);
    for (const list of groups.splice(room)) {
      if (list.every(k => p.gx[k] >= 0 && p.gy[k] >= 0 && p.gx[k] < W && p.gy[k] < H)) { for (const k of list) owner[p.gy[k] * W + p.gx[k]] = 0; loose = true; }
      else groups[0] = groups[0].concat(list).sort((a, c) => a - c);
    }
    // The pivot's place in the world now, and the picture before it was cut.
    const px = b.x - (b.c * p.mx - b.s * p.my), py = b.y - (b.s * p.mx + b.c * p.my), was = { ...p, hold: { ...p.hold } };
    groups.forEach((list, g) => {
      const q = g === 0 ? p : { ...was, id: nextId++, hold: { ...was.hold }, slept: false, ring: '' };
      const n = list.length, take = (a, Type) => Type.from(list, k => a[k]);
      q.n = n; q.I = take(was.I, Int32Array); q.J = take(was.J, Int32Array); q.gx = take(was.gx, Int32Array); q.gy = take(was.gy, Int32Array);
      q.mat = take(was.mat, Uint8Array); q.shade = take(was.shade, Uint8Array); q.flag = take(was.flag, Uint8Array); q.life = take(was.life, Uint16Array); q.temp = take(was.temp, Int32Array);
      let mass = 0, sx = 0, sy = 0;
      for (let k = 0; k < n; k++) { const rho = density[q.mat[k]] / 100; mass += rho; sx += rho * (q.I[k] + q.pu); sy += rho * (q.J[k] + q.pv); }
      q.mass = mass; q.mx = sx / mass; q.my = sy / mass;
      const rx = b.c * q.mx - b.s * q.my, ry = b.s * q.mx + b.c * q.my, ox = px + rx - b.x, oy = py + ry - b.y, shape = shapeOf(q);
      if (g === 0) {
        Object.assign(b, shape, { x: px + rx, y: py + ry, vx: b.vx - b.w * oy, vy: b.vy + b.w * ox, asleep: false, sleepy: 0 });
        world.place(b); q.slept = false;
      } else {
        q.body = world.add({ ...shape, x: px + rx, y: py + ry, c: b.c, s: b.s, vx: b.vx - b.w * oy, vy: b.vy + b.w * ox, w: b.w, bounce: b.bounce, friction: b.friction });
        for (let k = 0; k < n; k++) { const x = q.gx[k], y = q.gy[k]; if (x >= 0 && y >= 0 && x < W && y < H) owner[y * W + x] = q.id; }
        rigid.push(q);
      }
    });
    if (!groups.length) { b.gone = true; p.n = 0; }
  };
  // Reads a piece's cells back from the grid: what they hold now (a cell burns, warms, ages), and which are gone.
  const read = p => {
    let lost = 0;
    const keep = new Uint8Array(p.n).fill(1);
    for (let k = 0; k < p.n; k++) {
      const x = p.gx[k], y = p.gy[k];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const c = y * W + x;
      if (owner[c] === p.id && falls[mat[c]]) { p.mat[k] = mat[c]; p.shade[k] = shade[c]; p.flag[k] = flag[c]; p.life[k] = life[c]; p.temp[k] = temp[c]; continue; }
      if (owner[c] === p.id) owner[c] = 0;
      keep[k] = 0; lost++;
    }
    if (lost) recut(p, keep);
  };
  // The level of the liquid a piece is in and its density: read in the columns just beside it, at its lowest row (up to
  // SIDE columns further out where those are dry), up to the top of the liquid there; null when there is none.
  const levelOf = p => {
    let x0 = W, x1 = -1, low = -1;
    for (let k = 0; k < p.n; k++) {
      const x = p.gx[k], y = p.gy[k];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y > low) low = y;
    }
    if (low < 0) return null;
    let sum = 0, count = 0, rho = 0, thick = 0;
    for (const [from, step] of [[x0 - 1, -1], [x1 + 1, 1]]) {
      let x = from;
      for (let n = 0; n < SIDE && x >= 0 && x < W && state[mat[low * W + x]] !== LIQUID && state[mat[low * W + x]] !== SOLID; n++) x += step;
      if (x < 0 || x >= W || state[mat[low * W + x]] !== LIQUID) continue;
      let y = low;
      while (y > 0 && state[mat[(y - 1) * W + x]] === LIQUID) y--;
      sum += y; count++; rho += density[mat[low * W + x]]; thick += drag[mat[low * W + x]];
    }
    return count ? { level: sum / count, rho: rho / count / 100, drag: thick / count / ONE } : null;
  };
  // The liquid's lift on a piece (bodies.js takes the area of its shape under the level at each substep), half the
  // liquid it is under joining its mass, and the liquid's drag, growing with its speed as real drag does.
  const buoy = p => {
    const b = p.body, at = levelOf(p);
    if (!at) { b.float = null; b.push = null; b.drag = 0; b.spinDrag = 0.02; return; }
    const [under] = areaBeyond(b, 1, at.level, 1), share = under / p.n, g = G / SUB, added = 0.5 * under * at.rho, inertia = 1 / b.invInertia;
    b.float = { axis: 1, level: at.level, sign: 1, gx: 0, gy: g * at.rho, mass: p.mass + added, inertia };
    b.push = [0, -added * g / (p.mass + added), 0];
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy) + Math.abs(b.w) * b.extent;
    b.drag = LIQUID_DRAG * at.drag * (1 + QUADRATIC * speed) * share;
    b.spinDrag = 0.02 + 2 * b.drag;
  };
  // What a piece's ring of neighbours holds: solids and resting powder beside it, and the level of a liquid it is in.
  // A sleeping piece whose ring changes wakes.
  const ringOf = p => {
    let hard = 0, soft = 0;
    for (let k = 0; k < p.n; k++) {
      const x = p.gx[k], y = p.gy[k];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const c = y * W + x;
      for (const d of [y > 0 ? c - W : -1, x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y < H - 1 ? c + W : -1]) {
        if (d < 0 || owner[d] === p.id) continue;
        const s = state[mat[d]];
        if (s === SOLID) hard++; else if (s === POWDER && !vy[d]) soft++;
      }
    }
    const at = levelOf(p);
    return `${hard},${soft},${at ? Math.round(at.level) : -1}`;
  };
  const wake = p => { p.body.asleep = false; p.body.sleepy = 0; p.slept = false; };
  // A piece comes to rest where it is: its cells stay as they are, held like any other.
  const letGo = p => {
    for (let k = 0; k < p.n; k++) { const x = p.gx[k], y = p.gy[k]; if (x >= 0 && y >= 0 && x < W && y < H && owner[y * W + x] === p.id) owner[y * W + x] = 0; }
    p.body.gone = true; p.n = 0;
  };
  // A cell's contents moved to `to` (`from` is emptied by whoever calls).
  const moveCell = (to, from) => {
    mat[to] = mat[from]; shade[to] = shade[from]; flag[to] = flag[from]; life[to] = life[from]; temp[to] = temp[from];
    vx[to] = vx[from]; vy[to] = vy[from]; fx[to] = 0; fy[to] = 0; stamp[to] = tick;
    touch(to);
  };
  const neighbour = (c, side) => { const x = c % W; return side === 0 ? (c >= W ? c - W : -1) : side === 1 ? (x > 0 ? c - 1 : -1) : side === 2 ? (x < W - 1 ? c + 1 : -1) : (c < N - W ? c + W : -1); };
  const newVisit = () => { if (visitTag > 2147480000) { visited.fill(0); visitTag = 0; } return ++visitTag; };
  // The nearest of the cells a piece just left that is still empty, for what finds no room nearer.
  const nearestSpare = (from, spare) => {
    const x = from % W, y = (from - x) / W;
    let best = Infinity, to = -1;
    for (const c of spare) {
      if (mat[c] !== 0 || claim[c] === claimTag) continue;
      const dx = c % W - x, dy = (c - c % W) / W - y, d = dx * dx + dy * dy;
      if (d < best) { best = d; to = c; }
    }
    return to;
  };
  // Hit by a piece moving fast enough, what it pushes aside is flung out at the speed it was hit with, up and away from
  // the piece's middle, so a liquid splashes (and a powder, less): the nearer the piece (`near`, 1 beside it to 0 at the
  // edge of the splash) the higher, each drop by a seeded share, so the spray breaks up rather than flying as a sheet.
  const fling = (to, from, b, near = 1) => {
    const s = state[mat[to]], fx0 = from % W + 0.5 - b.x, fy0 = (from - from % W) / W + 0.5 - b.y, ux = b.vx - b.w * fy0, uy = b.vy + b.w * fx0, speed = Math.sqrt(ux * ux + uy * uy);
    if (speed < 1 || (s !== LIQUID && s !== POWDER)) return;
    const away = to % W + 0.5 < b.x ? -1 : 1, k = s === LIQUID ? 1 : 0.5, up = (0.35 + 0.65 * near) * (0.5 + (rand() & 255) / 512), out = 0.5 + (rand() & 255) / 256;
    vy[to] = -Math.min(TOP, Math.round(speed * SUB * SPLASH_UP * k * up)) || -1; vx[to] = away * Math.min(TOP, Math.round(speed * SUB * SPLASH_OUT * k * out));
  };
  // Pushes what is in cell `from` (where a piece now goes: powder, gas or fire) to the nearest empty cell it reaches
  // through what is not solid, nearest first (up, left, right, down); past SEARCH cells, to the nearest cell the piece left.
  const shove = (from, spare, b) => {
    const tag = newVisit();
    let head = 0, tail = 1, to = -1;
    queue2[0] = from; visited[from] = tag;
    search: while (head < tail) {
      const c = queue2[head++];
      for (let side = 0; side < 4; side++) {
        const d = neighbour(c, side);
        if (d < 0 || visited[d] === tag) continue;
        visited[d] = tag;
        if (claim[d] === claimTag) continue;
        const m = mat[d];
        if (m === 0) { to = d; break search; }
        if (state[m] === SOLID || tail >= SEARCH) continue;
        queue2[tail++] = d;
      }
    }
    if (to < 0) to = nearestSpare(from, spare);
    if (to < 0) return;
    moveCell(to, from);
    fling(to, from, b);
  };
  // Liquid in a piece's way goes where the liquid it is in stands lowest: to the empty cells beside that liquid (its
  // surface, or a pocket of air in it), lowest first and nearest among those. Falling-sand liquids don't level through a
  // gap under a piece, so pushed to the nearest room, a pool a piece stood in heaped up on one side of it and stayed so.
  const pour = (list, spare, b) => {
    const tag = newVisit(), room = [];
    let head = 0, tail = 0;
    for (const c of list) { visited[c] = tag; if (tail < SEARCH) queue2[tail++] = c; }
    while (head < tail) {
      const c = queue2[head++];
      for (let side = 0; side < 4; side++) {
        const d = neighbour(c, side);
        if (d < 0 || visited[d] === tag) continue;
        visited[d] = tag;
        if (claim[d] === claimTag) continue;
        if (mat[d] === 0) { room.push(d); continue; }
        if (state[mat[d]] === LIQUID && tail < SEARCH) queue2[tail++] = d;
      }
    }
    // Room within a row of the lowest counts as level, nearest first, so a piece landing on a still pool throws the water
    // up beside itself; the rest, lowest first.
    const row = c => (c - c % W) / W, lowest = room.reduce((most, c) => Math.max(most, row(c)), -1), level = c => (row(c) >= lowest - 1 ? lowest : row(c));
    const order = room.map((c, i) => i).sort((a, z) => level(room[z]) - level(room[a]) || a - z);
    const reach = 3 + 4 * (Math.sqrt(b.vx * b.vx + b.vy * b.vy) + Math.abs(b.w) * b.extent);
    list.forEach((from, i) => {
      let to = i < order.length ? room[order[i]] : -1;
      if (to < 0 || mat[to] !== 0) to = nearestSpare(from, spare);
      if (to < 0) return;
      moveCell(to, from);
      // Only what comes up near the piece splashes (the faster it hit, the wider); liquid that goes further off rises
      // there quietly.
      const x = to % W, y = row(to), [x0, y0, x1, y1] = b.box;
      const off = Math.max(x0 - x, x - x1, y0 - y, y - y1, 0);
      if (off <= reach) fling(to, from, b, 1 - off / reach);
    });
  };
  // Fills the empty cells `holes` a piece left under a liquid's surface from the surface cells (air or gas over them)
  // they reach through the liquid, highest first, and never from below the hole: the level falls where it stands highest.
  const refill = holes => {
    const tag = newVisit(), surface = [], isHole = new Set(holes);
    let head = 0, tail = 0;
    for (const c of holes) { visited[c] = tag; if (tail < SEARCH) queue2[tail++] = c; }
    const open = e => e < 0 || (!isHole.has(e) && (state[mat[e]] === EMPTY || state[mat[e]] === GAS || state[mat[e]] === FIRE));
    while (head < tail) {
      const c = queue2[head++];
      for (let side = 0; side < 4; side++) {
        const d = neighbour(c, side);
        if (d < 0 || visited[d] === tag) continue;
        visited[d] = tag;
        if (state[mat[d]] !== LIQUID) continue;
        // On a surface, air or gas over it and more over that: a pocket of air in the liquid is not its surface.
        if (d >= W && open(d - W) && open(d - 2 * W)) surface.push(d);
        if (tail < SEARCH) queue2[tail++] = d;
      }
    }
    const row = c => (c - c % W) / W, order = surface.map((c, i) => i).sort((a, z) => row(surface[a]) - row(surface[z]) || a - z);
    let next = 0;
    for (const hole of holes) {
      if (next >= order.length) break;
      const from = surface[order[next]];
      if (row(from) > row(hole)) continue;
      next++;
      moveCell(hole, from);
      vx[hole] = 0; vy[hole] = 0;
      mat[from] = 0; shade[from] = 0; flag[from] = 0; life[from] = 0; temp[from] = ambient; vx[from] = 0; vy[from] = 0; fx[from] = 0; fy[from] = 0;
      touch(from);
    }
  };
  // Draws a piece where its body is: the angle held to the whole degree, the picture turned a quarter at a time and then
  // by three shears, the place held to the whole pixel, each stepping on at once the way it last moved and back only
  // past HOLD (TURN_HOLD of a degree), so a piece rocking about a boundary holds still. If its cells would land in a
  // solid (its picture turned in whole pixels is not quite its exact shape), it tries a pixel up, left, right and down;
  // if all of those are blocked it stays where it was drawn, and carry answers how many pixels its furthest cell is from
  // where it would have gone (0 when it is drawn where its body is).
  const carry = p => {
    const b = p.body, h = p.hold, n = p.n;
    if (toX.length < n) { toX = new Int32Array(n * 2); toY = new Int32Array(n * 2); }
    const exact = atan2Deg(b.s, b.c), d = Math.round(exact);
    if (d !== h.d) { const way = Math.sign(turnBetween(h.d, d)); if (way === h.wd || Math.abs(turnBetween(h.d, exact)) >= 0.5 + TURN_HOLD) { h.d = d; h.wd = way; } }
    const quarter = Math.round(h.d / 90), q = ((quarter % 4) + 4) % 4, rest = h.d - 90 * quarter, cr = cosDeg(rest), sr = sinDeg(rest), alpha = -sr / (1 + cr), beta = sr;
    const ou = q === 0 ? p.pu : q === 1 ? -p.pv : q === 2 ? -p.pu : p.pv, ov = q === 0 ? p.pv : q === 1 ? p.pu : q === 2 ? -p.pv : -p.pu;
    const px = b.x - (b.c * p.mx - b.s * p.my) + ou, py = b.y - (b.s * p.mx + b.c * p.my) + ov;
    if (q !== h.q) { h.q = q; h.x = Math.floor(px); h.y = Math.floor(py); h.wx = 0; h.wy = 0; }
    else {
      const nx = Math.floor(px), ny = Math.floor(py);
      if (nx !== h.x) { const way = Math.sign(nx - h.x); if (way === h.wx || Math.abs(px - h.x - 0.5) >= 0.5 + HOLD) { h.x = nx; h.wx = way; } }
      if (ny !== h.y) { const way = Math.sign(ny - h.y); if (way === h.wy || Math.abs(py - h.y - 0.5) >= 0.5 + HOLD) { h.y = ny; h.wy = way; } }
    }
    for (let k = 0; k < n; k++) {
      let I = p.I[k], J = p.J[k];
      if (q === 1) { const t = I; I = -J; J = t; } else if (q === 2) { I = -I; J = -J; } else if (q === 3) { const t = I; I = J; J = -t; }
      I += Math.round(alpha * (J + ov)); J += Math.round(beta * (I + ou)); I += Math.round(alpha * (J + ov));
      toX[k] = I + h.x; toY[k] = J + h.y;
    }
    let same = true;
    for (let k = 0; k < n && same; k++) same = toX[k] === p.gx[k] && toY[k] === p.gy[k];
    if (same) return 0;
    let shift = -1;
    for (let s = 0; s < NUDGES.length && shift < 0; s++) {
      const [dx, dy] = NUDGES[s];
      let clear = true;
      for (let k = 0; k < n && clear; k++) {
        const x = toX[k] + dx, y = toY[k] + dy;
        if (x < 0 || x >= W || y >= H) clear = false;
        else if (y >= 0) { const c = y * W + x; clear = !(state[mat[c]] === SOLID && owner[c] !== p.id); }
      }
      if (clear) shift = s;
    }
    if (shift < 0) {
      let far = 1;
      for (let k = 0; k < n; k++) { const ax = Math.abs(toX[k] - p.gx[k]), ay = Math.abs(toY[k] - p.gy[k]); if (ax > far) far = ax; if (ay > far) far = ay; }
      return far;
    }
    const [dx, dy] = NUDGES[shift];
    if (claimTag > 2147480000) { claim.fill(0); claimTag = 0; }
    claimTag++;
    for (let k = 0; k < n; k++) { toX[k] += dx; toY[k] += dy; if (toY[k] >= 0) claim[toY[k] * W + toX[k]] = claimTag; }
    // The cells it leaves, empty air at the ambient temperature; then what is in its way, pushed aside; then its cells.
    const spare = [];
    for (let k = 0; k < n; k++) {
      const x = p.gx[k], y = p.gy[k];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const c = y * W + x;
      if (claim[c] === claimTag) continue;
      mat[c] = 0; shade[c] = 0; flag[c] = 0; life[c] = 0; temp[c] = ambient; owner[c] = 0; vx[c] = 0; vy[c] = 0; fx[c] = 0; fy[c] = 0;
      touch(c); spare.push(c);
    }
    const wet = [];
    for (let k = 0; k < n; k++) {
      if (toY[k] < 0) continue;
      const c = toY[k] * W + toX[k];
      if (mat[c] === 0 || owner[c] === p.id) continue;
      if (state[mat[c]] === LIQUID) wet.push(c); else shove(c, spare, b);
    }
    if (wet.length) pour(wet, spare, b);
    for (let k = 0; k < n; k++) {
      p.gx[k] = toX[k]; p.gy[k] = toY[k];
      if (toY[k] < 0) continue;
      const c = toY[k] * W + toX[k];
      mat[c] = p.mat[k]; shade[c] = p.shade[k]; flag[c] = p.flag[k]; life[c] = p.life[k]; temp[c] = p.temp[k];
      vx[c] = 0; vy[c] = 0; fx[c] = 0; fy[c] = 0; stamp[c] = tick; owner[c] = p.id;
      touch(c);
    }
    // A cell it left under a liquid's surface (liquid beside it, or a pocket under it with liquid below) fills at once, so a
    // piece rising in a pool or moving through it leaves no hole of air behind it.
    const holes = spare.filter(c => {
      if (mat[c] !== 0) return false;
      const x = c % W;
      return (x > 0 && state[mat[c - 1]] === LIQUID) || (x < W - 1 && state[mat[c + 1]] === LIQUID) || (c < N - W && state[mat[c + W]] === LIQUID && (c < W || state[mat[c - W]] === SOLID));
    });
    if (holes.length) refill(holes);
    return 0;
  };
  // A piece whose cells cannot follow its body is made again from its cells as they lie: a body of exactly their shape,
  // where they are, moving as the old one moved. Two pieces turning against each other are each drawn a little into the
  // other, no nudge clears both sides, and each then waits for the other's cells to move: their bodies fell on, came to
  // rest and slept, and the cells were left hanging in the air where they had stopped. One whose cells lie partly above
  // the grid is left to come back down.
  const reseat = p => {
    const list = new Int32Array(p.n), b = p.body;
    for (let k = 0; k < p.n; k++) { const x = p.gx[k], y = p.gy[k]; if (x < 0 || y < 0 || x >= W || y >= H) return; list[k] = y * W + x; }
    const n = p.n, moves = b.asleep ? [0, 0, 0] : [b.vx, b.vy, b.w];
    letGo(p);
    if (glued(list, n)) return;
    const made = makePiece(list, n).body;
    made.vx = moves[0]; made.vy = moves[1]; made.w = moves[2];
  };
  // The obstacles the moving pieces meet, in the window round them: fixed solids and resting pieces (hard), and
  // resting powder (soft) unless it lies on a piece (sand poured on a piece rides it rather than holding it).
  const obstacle = (x, y) => {
    const c = y * W + x, s = state[mat[c]];
    return s === SOLID ? (owner[c] ? 0 : 1) : s === POWDER && !vy[c] && !onTop[c] ? 2 : 0;
  };
  // One frame of the pieces, after the cells' pass and before heat.
  const tumbles = () => {
    const changed = supportChanged || loose;
    supportChanged = false; loose = false;
    // Read back what the pieces' cells hold: every piece when a solid came or went, else the moving ones.
    for (const p of rigid.slice()) if (p.n && (changed || !p.body.asleep)) read(p);
    // New pieces: falling solids not part of one, loose (held by no fixed solid beside or over them).
    if (changed) {
      if (tag > 2147480000) { seen.fill(0); tag = 0; }
      const start = tag;
      for (let c = 0; c < N; c++) {
        if (!falls[mat[c]] || owner[c] || seen[c] > start) continue;
        const own = ++tag, n = flood(c, own);
        if (glued(piece, n)) continue;
        if (rigid.length >= MOST_PIECES) {
          let weight = 0;
          for (let k = 0; k < n; k++) weight += density[mat[piece[k]]];
          drop(piece.subarray(0, n), own, (weight / n) | 0);
          continue;
        }
        makePiece(piece, n);
      }
    }
    // Sleeping pieces wake when what lies round them changed (only where cells were stepped this frame).
    for (const p of rigid) {
      if (!p.n || !p.body.asleep || !p.slept) continue;
      const [x0, y0, x1, y1] = p.body.box, k0 = Math.max(0, Math.floor(x0 - 2) >> 4), k1 = Math.min(CW - 1, Math.floor(x1 + 2) >> 4);
      const j0 = Math.max(0, Math.floor(y0 - 2) >> 4), j1 = Math.min(CH - 1, Math.floor(y1 + 2) >> 4);
      let stirred = false;
      for (let j = j0; j <= j1 && !stirred; j++) for (let i = k0; i <= k1 && !stirred; i++) stirred = !!(awake[j * CW + i] || next[j * CW + i]);
      if (stirred && ringOf(p) !== p.ring) wake(p);
    }
    const moving = rigid.filter(p => p.n && !p.body.asleep);
    if (moving.length) {
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (const p of moving) {
        buoy(p);
        const [a, c, e, f] = p.body.box;
        x0 = Math.min(x0, Math.floor(a) - REACH); y0 = Math.min(y0, Math.floor(c) - REACH); x1 = Math.max(x1, Math.ceil(e) + REACH); y1 = Math.max(y1, Math.ceil(f) + REACH);
      }
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W - 1, x1); y1 = Math.min(H - 1, y1);
      if (x1 >= x0 && y1 >= y0) {
        for (let y = y1; y >= y0; y--) for (let x = x0, c = y * W + x0; x <= x1; x++, c++) {
          const below = y < H - 1 ? c + W : -1;
          onTop[c] = state[mat[c]] === POWDER && below >= 0 && (owner[below] > 0 || (y < y1 && onTop[below])) ? 1 : 0;
        }
        world.retraceCells(x0, y0, x1 - x0 + 1, y1 - y0 + 1, obstacle);
      } else world.retraceCells(0, 0, 0, 0, obstacle);
      world.advance(++worldFrame);
      // The top is open, and bodies.js counts a body far past an edge as escaped and gone: a piece thrown high keeps its
      // cells (above the grid, where they are not drawn) and comes back down. Only recut and letGo end a piece.
      if (world.stats.escaped.length) { for (const p of rigid) if (p.n) p.body.gone = false; world.stats.escaped.length = 0; }
      for (const p of moving) {
        // Left more than PARTED pixels behind its body, or more than RESTED behind a body that has come to rest (which
        // would never be tried again), it starts again from where its cells are. Less than that is a piece held up a
        // frame or two by a corner, which frees itself.
        const behind = carry(p);
        if (behind > (p.body.asleep ? RESTED : PARTED)) { reseat(p); continue; }
        // A piece still moving keeps the chunks it lies in awake, so a grid isn't settled while a piece drifts.
        if (!p.body.asleep) {
          const [a, c, e, f] = p.body.box;
          for (let j = Math.max(0, Math.floor(c) >> 4); j <= Math.min(CH - 1, Math.floor(f) >> 4); j++) for (let i = Math.max(0, Math.floor(a) >> 4); i <= Math.min(CW - 1, Math.floor(e) >> 4); i++) next[j * CW + i] = 1;
        }
      }
    }
    // A piece that has come to rest notes what lies round it; held by a fixed solid beside it or over it, it lets go of
    // its body and stays as plain cells.
    for (const p of rigid) {
      if (!p.n) continue;
      if (!p.body.asleep) { p.slept = false; continue; }
      if (p.slept) continue;
      p.slept = true;
      const list = [];
      for (let k = 0; k < p.n; k++) { const x = p.gx[k], y = p.gy[k]; if (x >= 0 && y >= 0 && x < W && y < H) list.push(y * W + x); }
      if (list.length === p.n && glued(list, list.length)) letGo(p);
      else p.ring = ringOf(p);
    }
    if (rigid.some(p => !p.n)) {
      for (let k = rigid.length - 1; k >= 0; k--) if (!rigid[k].n) rigid.splice(k, 1);
      if (world.bodies.length > 2 * rigid.length + 32) world.compact();
    }
  };

  // Heat moves across every edge between neighbours by the smaller conductance of the two, read from this frame's
  // temperatures and written to the next (so the order cells are visited in cannot matter), and exactly: what one cell
  // loses its neighbour gains. Then air and cooling materials drift toward the ambient temperature.
  const conductHeat = () => {
    const from = temp, to = spare;
    to.set(from);
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
      const k = cy * CW + cx;
      if (!awake[k]) continue;
      const x0 = cx << 4, x1 = x0 + 16 < W ? x0 + 16 : W, y0 = cy << 4, y1 = y0 + 16 < H ? y0 + 16 : H;
      // Its edges, those to the chunks right of and below it, and those to the chunks left of and above it when they
      // sleep (an awake one moves heat across them itself). Heat that moves wakes the chunks at both ends.
      const left = cx > 0 && !awake[k - 1], hx0 = left ? x0 - 1 : x0, hx1 = x1 < W ? x1 : W - 1;
      let moved = false, west = false, east = false, north = false, south = false;
      for (let y = y0; y < y1; y++) {
        let c = y * W + hx0, kc = conduct[mat[c]];
        for (let x = hx0; x < hx1; x++, c++) {
          const kn = conduct[mat[c + 1]], kk = kc < kn ? kc : kn;
          kc = kn;
          if (!kk) continue;
          const d = from[c] - from[c + 1];
          if (!d) continue;
          const f = d > 0 ? (d * kk) >> 12 : -((-d * kk) >> 12);
          if (!f) continue;
          to[c] -= f; to[c + 1] += f; moved = true;
          if (x < x0) west = true; else if (x === x1 - 1) east = true;
        }
      }
      const up = cy > 0 && !awake[k - CW], vy0 = up ? y0 - 1 : y0, vy1 = y1 < H ? y1 : H - 1;
      for (let y = vy0; y < vy1; y++) for (let x = x0, c = y * W + x0; x < x1; x++, c++) {
        const d = from[c] - from[c + W];
        if (!d) continue;
        const ka = conduct[mat[c]], kb = conduct[mat[c + W]], kk = ka < kb ? ka : kb;
        if (!kk) continue;
        const f = d > 0 ? (d * kk) >> 12 : -((-d * kk) >> 12);
        if (!f) continue;
        to[c] -= f; to[c + W] += f; moved = true;
        if (y < y0) north = true; else if (y === y1 - 1) south = true;
      }
      if (moved) next[k] = 1;
      if (west) next[k - 1] = 1;
      if (east) next[k + 1] = 1;
      if (north) next[k - CW] = 1;
      if (south) next[k + CW] = 1;
    }
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
      const k = cy * CW + cx;
      if (!awake[k]) continue;
      const x0 = cx << 4, x1 = x0 + 16 < W ? x0 + 16 : W, y0 = cy << 4, y1 = y0 + 16 < H ? y0 + 16 : H;
      for (let y = y0; y < y1; y++) for (let c = y * W + x0, end = y * W + x1; c < end; c++) {
        const kk = cool[mat[c]];
        if (!kk) continue;
        const d = ambient - to[c];
        if (d) { to[c] += d > 0 ? (d * kk + SCALE - 1) >> 12 : -((-d * kk + SCALE - 1) >> 12); next[k] = 1; }
      }
    }
    temp = to; spare = from;
  };

  // ---- Inputs ----
  let queue = [];
  // A recording keeps at most LIMITS.strokes strokes. The first one left out stops it for good, and its frame is
  // `recordedUntil`: a replay of the recording is exact for that many frames, not after.
  const strokes = options.record ? [] : null;
  let recordedUntil = null;
  const enqueue = (input, stroke) => {
    if (queue.length >= QUEUED) queue.shift();
    queue.push(input);
    if (strokes && recordedUntil === null) { if (strokes.length < LIMITS.strokes) strokes.push({ f: t, ...stroke }); else recordedUntil = t; }
  };
  // The cells whose centres lie within `radius` of the segment from (x, y) to (x2, y2).
  const capsule = (x, y, x2, y2, radius, visit) => {
    const i0 = Math.max(0, Math.floor(Math.min(x, x2) - radius)), i1 = Math.min(W - 1, Math.ceil(Math.max(x, x2) + radius));
    const j0 = Math.max(0, Math.floor(Math.min(y, y2) - radius)), j1 = Math.min(H - 1, Math.ceil(Math.max(y, y2) + radius));
    const dx = x2 - x, dy = y2 - y, length = dx * dx + dy * dy, r2 = radius * radius;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = i + 0.5 - x, py = j + 0.5 - y;
      let u = length ? (px * dx + py * dy) / length : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = px - u * dx, ey = py - u * dy;
      if (ex * ex + ey * ey <= r2) visit(j * W + i);
    }
  };
  const place = (c, m, temperature) => {
    if (state[mat[c]] === SOLID || state[m] === SOLID) supportChanged = true;
    mat[c] = m; flag[c] = 0; shade[c] = m ? shadeAt(c, m) : 0; life[c] = m ? lifeDraw(m) : 0; temp[c] = m ? temperature ?? birth[m] : ambient; stamp[c] = 0;
    vx[c] = 0; vy[c] = 0; fx[c] = 0; fy[c] = 0;
    touch(c);
  };
  // Pointer-driven inputs are rounded as a recording keeps them (quarter pixels, hundredths, whole degrees), so a
  // replay of the recording makes exactly the same calls.
  const quarter = (value, path) => Math.round(number(value, path, -4096, 4096) * 4) / 4;
  const spot = (input, path, keys) => {
    if (!isObject(input)) fail(path, `expected { ${keys.join(', ')} }`);
    known(input, keys, path);
    const x = quarter(input.x, `${path}.x`), y = quarter(input.y, `${path}.y`);
    return { x, y, x2: input.x2 === undefined ? x : quarter(input.x2, `${path}.x2`), y2: input.y2 === undefined ? y : quarter(input.y2, `${path}.y2`), radius: Math.round(number(input.radius ?? 3, `${path}.radius`, 0.5, 64) * 4) / 4 };
  };
  // A soft disc: 1 at its centre, falling to 0 at its rim.
  const soft = (dx, dy, radius) => { const k = (dx * dx + dy * dy) / (radius * radius); return k >= 1 ? 0 : (1 - k) * (1 - k); };
  // How far (0 to 1, from its start) along the segment from (x, y) to (x2, y2) the point nearest (px, py) lies.
  const along = (at, px, py) => { const dx = at.x2 - at.x, dy = at.y2 - at.y, l = dx * dx + dy * dy, k = l ? ((px - at.x) * dx + (py - at.y) * dy) / l : 0; return k < 0 ? 0 : k > 1 ? 1 : k; };
  const pushAir = (at, pvx, pvy) => {
    const reach = at.radius + S;
    for (let j = 0; j < GH; j++) for (let i = 0; i <= GW; i++) {
      const px = i * S, py = (j + 0.5) * S, k = along(at, px, py), w = soft(px - at.x - k * (at.x2 - at.x), py - at.y - k * (at.y2 - at.y), reach);
      if (w && !uWall(i, j)) u[j * (GW + 1) + i] += pvx * w;
    }
    for (let j = 0; j <= GH; j++) for (let i = 0; i < GW; i++) {
      const px = (i + 0.5) * S, py = j * S, k = along(at, px, py), w = soft(px - at.x - k * (at.x2 - at.x), py - at.y - k * (at.y2 - at.y), reach);
      if (w && !vWall(i, j)) v[j * GW + i] += pvy * w;
    }
    stirred = true;
  };
  const blast = (at, strength) => {
    if (F) {
      const reach = at.radius + S;
      for (let j = 0; j < GH; j++) for (let i = 0; i <= GW; i++) {
        const dx = i * S - at.x, dy = (j + 0.5) * S - at.y, d = Math.sqrt(dx * dx + dy * dy), w = soft(dx, dy, reach);
        if (w && d > 0 && !uWall(i, j)) u[j * (GW + 1) + i] += strength * w * dx / d;
      }
      for (let j = 0; j <= GH; j++) for (let i = 0; i < GW; i++) {
        const dx = (i + 0.5) * S - at.x, dy = j * S - at.y, d = Math.sqrt(dx * dx + dy * dy), w = soft(dx, dy, reach);
        if (w && d > 0 && !vWall(i, j)) v[j * GW + i] += strength * w * dy / d;
      }
      stirred = true;
    }
    // Tumbling pieces within it are thrown as their cells would be, the nearer cells the harder, and spun by the push's
    // lean about their middles.
    if (TUMBLE) for (const p of rigid) {
      const b = p.body;
      if (!p.n || b.gone) continue;
      let px = 0, py = 0, turn = 0;
      for (let k = 0; k < p.n; k++) {
        const x = p.gx[k] + 0.5, y = p.gy[k] + 0.5, dx = x - at.x, dy = y - at.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d > at.radius + 0.5 || d === 0) continue;
        const w = 1 - d / (at.radius + 0.5), speed = strength * (0.35 + 0.65 * w) * density[p.mat[k]] / 100;
        let ux = dx / d, uy = dy / d - 0.6;
        const length = Math.sqrt(ux * ux + uy * uy) || 1;
        ux *= speed / length; uy *= speed / length;
        px += ux; py += uy; turn += (x - b.x) * uy - (y - b.y) * ux;
      }
      if (!px && !py) continue;
      b.vx += px * b.invMass; b.vy += py * b.invMass; b.w += turn * b.invInertia;
      b.asleep = false; b.sleepy = 0; p.slept = false;
    }
    // Loose cells, nearest first, are each thrown out along their line from the blast (tipped upward) to the first free
    // cell on it, before a solid, with that speed: the blast opens a crater and its spray flies from the rim.
    const loose = [];
    capsule(at.x, at.y, at.x, at.y, at.radius, c => { const st = state[mat[c]]; if (st === POWDER || st === LIQUID) loose.push(c); });
    const distance = c => { const x = c % W, dx = x + 0.5 - at.x, dy = (c - x) / W + 0.5 - at.y; return dx * dx + dy * dy; };
    loose.sort((a, b) => distance(a) - distance(b) || a - b);
    for (const c of loose) {
      const x = c % W, y = (c - x) / W, dx = x + 0.5 - at.x, dy = y + 0.5 - at.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      let ux = dx / d, uy = dy / d - 0.6;
      const length = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= length; uy /= length;
      const w = 1 - d / (at.radius + 0.5), speed = strength * (0.35 + 0.65 * w);
      let to = c;
      for (let k = 1; k <= at.radius * 2 + 4; k++) {
        const tx = Math.floor(x + 0.5 + ux * k), ty = Math.floor(y + 0.5 + uy * k);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) break;
        const e = ty * W + tx, st = state[mat[e]];
        if (st === SOLID) break;
        if (mat[e] === 0) { to = e; break; }
      }
      if (to !== c) swap(c, to);
      let kx = Math.round(speed * ux * SUB), ky = Math.round(speed * uy * SUB);
      kx = kx > TOP ? TOP : kx < -TOP ? -TOP : kx; ky = ky > TOP ? TOP : ky < -TOP ? -TOP : ky;
      vx[to] = kx; vy[to] = ky === 0 ? -1 : ky; fx[to] = 0; fy[to] = 0;
      touch(to);
    }
  };
  const paintInput = (m, at, fill, replace, temperature) => () => capsule(at.x, at.y, at.x2, at.y2, at.radius, c => {
    if (fill < 1 && rand() >= fill * ONE) return;
    if (!replace && mat[c] !== 0) return;
    place(c, m, temperature);
  });
  // Each input as [what it does, the stroke a recording keeps], read from its fields at `path`.
  const make = {
    // Fills free cells within `radius` of (x, y), or of the segment to (x2, y2), with a material: `fill` is the share
    // of them filled (a spray), `replace` paints over what is there.
    paint(input, path) {
      const at = spot(input, path, POWDER_INPUTS.paint);
      if (input.material === 'empty') fail(`${path}.material`, '"empty" is not a material to paint; erase clears cells to empty air');
      const m = T.ref(input.material, `${path}.material`, false), fill = Math.round(number(input.fill ?? 1, `${path}.fill`, 0, 1) * 100) / 100, replace = !!input.replace;
      return [paintInput(m, at, fill, replace), { op: 0, m, ...at, fill, replace }];
    },
    erase(input, path) {
      const at = spot(input, path, POWDER_INPUTS.erase);
      return [() => capsule(at.x, at.y, at.x2, at.y2, at.radius, c => place(c, 0)), { op: 1, ...at }];
    },
    // Paints the source's wall material over anything: a fixed solid nothing reacts with unless the table says so.
    wall(input, path) {
      if (!T.wall) fail(path, 'the source names no wall material (add one called "wall", or set "wall")');
      const at = spot(input, path, POWDER_INPUTS.wall);
      return [paintInput(T.wall, at, 1, true), { op: 2, ...at }];
    },
    // Adds `amount` degrees (negative cools) to every cell in the disc, air included.
    heat(input, path) {
      const at = spot(input, path, POWDER_INPUTS.heat);
      const amount = Math.round(number(input.amount ?? 200, `${path}.amount`, -2000, 2000));
      return [() => capsule(at.x, at.y, at.x2, at.y2, at.radius, c => { temp[c] = clampT(temp[c] + amount * SIXTEENTHS); touch(c); }), { op: 3, ...at, amount }];
    },
    // Drags the air within `radius` of (x, y), or of the segment to (x2, y2), by (vx, vy) pixels a frame, softly to the
    // rim, as a pointer sweeping through smoke does. Needs moving air (`air.flow`).
    push(input, path) {
      if (!F) fail(path, 'the source has no moving air; set air.flow');
      const at = spot(input, path, POWDER_INPUTS.push);
      const pvx = Math.round(number(input.vx ?? 0, `${path}.vx`, -8, 8) * 16) / 16, pvy = Math.round(number(input.vy ?? 0, `${path}.vy`, -8, 8) * 16) / 16;
      return [() => pushAir(at, pvx, pvy), { op: 4, ...at, vx: pvx, vy: pvy }];
    },
    // A blast at (x, y): air pushed out from it, and loose powders and liquids within `radius` thrown outward at up to
    // `strength` pixels a frame (and a little up), the nearer the harder.
    burst(input, path) {
      const at = spot(input, path, POWDER_INPUTS.burst);
      const strength = Math.round(number(input.strength ?? 3, `${path}.strength`, 0, 8) * 16) / 16;
      return [() => blast(at, strength), { op: 5, x: at.x, y: at.y, radius: at.radius, strength }];
    }
  };
  // The source's scripted inputs: each on `frame`, or on every `every`th frame from frames[0] to frames[1], applied at
  // the start of the step before the live calls queued for it. The compiler and the live runner both play them.
  const script = T.inputs.map((entry, n) => {
    const path = `powder.inputs[${n}]`, actions = Object.keys(POWDER_INPUTS).filter(key => isObject(entry) && entry[key] !== undefined);
    if (!isObject(entry)) fail(path, 'expected { frame or frames, and one of paint, erase, wall, heat, push or burst }');
    known(entry, ['frame', 'frames', 'every', ...Object.keys(POWDER_INPUTS)], path);
    if (actions.length !== 1) fail(path, 'expected exactly one of paint, erase, wall, heat, push or burst');
    if ((entry.frame === undefined) === (entry.frames === undefined)) fail(path, 'expected frame (one frame) or frames ([first, last])');
    let from, to;
    if (entry.frame !== undefined) from = to = integer(entry.frame, `${path}.frame`, 0, LIMITS.steps);
    else {
      if (!Array.isArray(entry.frames) || entry.frames.length !== 2) fail(`${path}.frames`, 'expected [first, last] frames');
      from = integer(entry.frames[0], `${path}.frames[0]`, 0, LIMITS.steps); to = integer(entry.frames[1], `${path}.frames[1]`, from, LIMITS.steps);
    }
    const action = actions[0], every = integer(entry.every ?? 1, `${path}.every`, 1, LIMITS.steps), [run, stroke] = make[action](entry[action], `${path}.${action}`);
    // Its work each time it runs, in cell steps (see INPUT_WORK): the cells of the box round its stroke, and the air's faces.
    const r = stroke.radius, x2 = stroke.x2 ?? stroke.x, y2 = stroke.y2 ?? stroke.y;
    const i0 = Math.max(0, Math.floor(Math.min(stroke.x, x2) - r)), i1 = Math.min(W - 1, Math.ceil(Math.max(stroke.x, x2) + r));
    const j0 = Math.max(0, Math.floor(Math.min(stroke.y, y2) - r)), j1 = Math.min(H - 1, Math.ceil(Math.max(stroke.y, y2) + r));
    const area = i1 < i0 || j1 < j0 ? 0 : (i1 - i0 + 1) * (j1 - j0 + 1), faces = F ? (GW + 1) * GH + GW * (GH + 1) : 0, painted = action === 'paint' ? stroke.m : action === 'wall' ? T.wall : 0;
    const patterned = painted && T.pattern[painted], cells = area.toLocaleString('en');
    const cost = action === 'push' ? faces * INPUT_WORK.face : action === 'burst' ? area * INPUT_WORK.thrown + faces * INPUT_WORK.face : area * (patterned ? INPUT_WORK.patterned : INPUT_WORK.plain);
    // What its work is over, for the compiler's message.
    const over = action === 'push' ? `the moving air's ${faces.toLocaleString('en')} faces` : action === 'burst' ? `${cells} cells of what is loose${F ? ', and the moving air' : ''}` : `${cells} cells${patterned ? ` of ${T.pattern[painted] === 1 ? 'blotch' : 'grain'}` : ''}`;
    return { from, to, every, run, path, cost, area, over, push: action === 'push', falls: !!falls[painted] };
  });

  const live = {
    width: W, height: H, materials: T.names.slice(1), palette: {}, strokes,
    // The palette key of the background colour, which render() draws where nothing is (and keys mark '.'), and the
    // colour itself (null when transparent): a compiled recipe's background.
    backgroundKey: KEY_CHARS[0],
    backgroundColor: T.background[3] ? `#${T.background.slice(0, T.background[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('')}` : null,
    get frame() { return t; },
    get recordedUntil() { return recordedUntil; },
    step(n = 1) {
      integer(n, 'step', 0, 100000);
      for (let k = 0; k < n; k++) advance();
      return live;
    },
    // Inputs, queued for the next step: paint, erase, wall, heat, push and burst (see `make` for what each does).
    ...Object.fromEntries(Object.keys(POWDER_INPUTS).map(action => [action, input => { const [run, stroke] = make[action](input, action); enqueue(run, stroke); return live; }])),
    // What is at a pixel now.
    at(x, y) {
      const c = integer(y, 'at.y', 0, H - 1) * W + integer(x, 'at.x', 0, W - 1);
      // A tumbling piece's cell moves as its body does there (its velocity plus its turning).
      const p = TUMBLE && owner[c] ? rigid.find(q => q.id === owner[c]) : null, b = p ? p.body : null;
      const velocity = b ? [b.vx - b.w * (y + 0.5 - b.y), b.vy + b.w * (x + 0.5 - b.x)] : [vx[c] / SUB, vy[c] / SUB];
      return { material: T.names[mat[c]], temperature: temp[c] / SIXTEENTHS, life: life[c], burning: !!(flag[c] & BURNING), velocity, ...(p && { piece: { id: p.id, moving: !b.asleep, angle: Math.round(turnBetween(0, atan2Deg(b.s, b.c)) * 10) / 10 } }), ...(F && { air: [sampleU(x + 0.5, y + 0.5), sampleV(x + 0.5, y + 0.5)] }) };
    },
    // How many cells of each material there are, and how many burn.
    measure() {
      const counts = new Uint32Array(M);
      let burning = 0;
      for (let c = 0; c < N; c++) { counts[mat[c]]++; if (flag[c]) burning++; }
      let stepped = 0;
      for (let k = 0; k < awake.length; k++) stepped += awake[k];
      // `chunks`: how many of the grid's 16 × 16 chunks the last step visited, of how many; with tumbling pieces, how
      // many of them move and how many rest.
      const moving = TUMBLE ? rigid.filter(p => p.n && !p.body.asleep).length : 0;
      return { counts: Object.fromEntries(T.names.map((name, m) => [name, counts[m]]).filter(([, n]) => n)), burning, chunks: { stepped, of: awake.length }, ...(TUMBLE && { pieces: { moving, resting: rigid.filter(p => p.n).length - moving } }) };
    },
    render: target => render(target),
    // The cell arrays, for tests and for hooks that read the grid (temperatures in sixteenths of a degree, velocities in
    // 256ths of a pixel per frame).
    get cells() { return { mat, shade, flag, life, temp, vx, vy }; }
  };

  // ---- Drawing ----
  // Every colour as a packed RGBA word, and each material's ramps as flat lists of colour indices.
  const words = Uint32Array.from(T.colours, pack);
  for (const [text, index] of T.keyOf) {
    const rgba = text.split(',').map(Number);
    live.palette[KEY_CHARS[index]] = `#${rgba.slice(0, rgba[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }
  const flat = lists => { const start = new Uint16Array(M), length = new Uint8Array(M), all = []; lists.forEach((list, m) => { start[m] = all.length; length[m] = list.length; all.push(...list); }); return { start, length, all: Uint8Array.from(all) }; };
  const base = flat(T.ramps), hot = flat(T.hotRamp), burnt = flat(T.burnRamp);
  const { top, byAge, shimmer, hotFrom, hotSpan, haze, streak, dense } = T, hazy = haze.some(h => h >= 0);
  const streaky = streak.some(s => s >= 0), cloudy = dense.some(d => d);
  const gas = cloudy ? new Uint8Array(N) : null, rowSum = cloudy ? new Uint8Array(N) : null;
  // Clouds: a gas or flame drawn by density takes, at every empty pixel or cell of its own, the colour of its ramp
  // (thin to thick) for how many such cells crowd round: a 5 × 5 window weighted 1 2 3 2 1 each way (81 when full),
  // the thickest colour from about 60% full. An empty pixel needs at least 8 and a gas cell 12, so a lone gas cell is
  // not drawn and a cloud's edge is soft. A pixel near two kinds takes the nearer (or first in reading order) one's
  // ramp, and a flame's beside a flame.
  const FULL = 48, EDGE = 8, LONE = 12;
  const levels = Array.from({ length: 9 }, (_, n) => Uint8Array.from({ length: 82 }, (_, k) => Math.min(n - 1, Math.floor(k * n / FULL))));
  // The 24 cells round a pixel, nearest first.
  const ring = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) ring.push([dx, dy]);
  ring.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
  const clouds = (index, px) => {
    for (let c = 0; c < N; c++) gas[c] = dense[mat[c]];
    for (let y = 0, c = 0; y < H; y++) for (let x = 0; x < W; x++, c++) {
      let sum = 3 * gas[c];
      if (x > 0) sum += 2 * gas[c - 1];
      if (x > 1) sum += gas[c - 2];
      if (x < W - 1) sum += 2 * gas[c + 1];
      if (x < W - 2) sum += gas[c + 2];
      rowSum[c] = sum;
    }
    for (let y = 0, c = 0; y < H; y++) for (let x = 0; x < W; x++, c++) {
      let k = 3 * rowSum[c];
      if (y > 0) k += 2 * rowSum[c - W];
      if (y > 1) k += rowSum[c - 2 * W];
      if (y < H - 1) k += 2 * rowSum[c + W];
      if (y < H - 2) k += rowSum[c + 2 * W];
      if (!k) continue;
      let m = mat[c];
      if (m && !dense[m]) continue;
      if (m === 0 && k < EDGE) continue;
      // A lone gas cell is too thin to see (a lone flame is a spark, and shows).
      if (m && k < LONE && state[m] === GAS) { index[c] = 255; px[c] = words[base.all[0]]; continue; }
      // Flames show through the smoke they make: next to a flame, its ramp wins.
      if (state[m] !== FIRE) for (let n = 0; n < 8; n++) {
        const [dx, dy] = ring[n], xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) { const e = mat[yy * W + xx]; if (dense[e] && state[e] === FIRE) { m = e; break; } }
      }
      if (m === 0) for (const [dx, dy] of ring) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && dense[mat[yy * W + xx]]) { m = mat[yy * W + xx]; break; }
      }
      const n = base.length[m], i = base.all[base.start[m] + levels[n][k]];
      index[c] = i; px[c] = words[i];
    }
  };
  const render = target => {
    const index = new Uint8Array(N);
    const rgba = target ?? new Uint8ClampedArray(N * 4);
    if (rgba.length !== N * 4) fail('render', `expected a ${N * 4}-byte RGBA buffer`);
    const px = new Uint32Array(rgba.buffer, rgba.byteOffset, N), slow = t >> 1;
    for (let c = 0; c < N; c++) {
      const m = mat[c];
      let i;
      if (m === 0) i = base.all[0];
      else if (flag[c] & BURNING && burnt.length[m]) {
        // Burning cells flicker, changing colour every other frame.
        let h = Math.imul(c ^ Math.imul(slow, 0x9e3779b1), 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
        i = burnt.all[burnt.start[m] + (h >>> 0) % burnt.length[m]];
      } else if (temp[c] >= hotFrom[m]) {
        const n = hot.length[m], k = ((temp[c] - hotFrom[m]) * n / hotSpan[m]) | 0;
        i = hot.all[hot.start[m] + (k < n ? k : n - 1)];
      } else {
        const n = base.length[m];
        let k;
        if (byAge[m]) { const most = lifeMax[m]; k = ((most - life[c]) * n / (most + 1)) | 0; if (k >= n) k = n - 1; if (k < 0) k = 0; }
        else if (shimmer[m]) k = (((shade[c] + ((t * 256 / shimmer[m]) | 0)) & 255) * n) >> 8;
        else k = (shade[c] * n) >> 8;
        i = base.all[base.start[m] + k];
        if (top[m] >= 0 && c >= W) { const above = mat[c - W]; if (above === 0 || state[above] === GAS || state[above] === FIRE) i = top[m]; }
      }
      index[c] = m === 0 ? 255 : i; px[c] = words[i];
    }
    if (cloudy) clouds(index, px);
    // Haze: an empty pixel between gas cells (two or more of its four neighbours) takes the haze colour of the first
    // of them (up, left, right, down), so smoke and steam read as clouds; a lone gas pixel gets none.
    if (hazy) for (let c = 0; c < N; c++) {
      if (mat[c] !== 0) continue;
      const x = c % W;
      let h = -1, n = 0, k;
      if (c >= W && (k = haze[mat[c - W]]) >= 0) { h = k; n++; }
      if (x > 0 && (k = haze[mat[c - 1]]) >= 0) { if (h < 0) h = k; n++; }
      if (x < W - 1 && (k = haze[mat[c + 1]]) >= 0) { if (h < 0) h = k; n++; }
      if (c < N - W && (k = haze[mat[c + W]]) >= 0) { if (h < 0) h = k; n++; }
      if (n >= 2) { index[c] = h; px[c] = words[h]; }
    }
    // Streaks: up to three empty pixels above a cell falling two pixels a frame or faster, one fewer than its speed.
    if (streaky) for (let c = W; c < N; c++) {
      const s = streak[mat[c]];
      if (s < 0 || vy[c] < SPLASH) continue;
      const length = (vy[c] >> 8) - 1;
      for (let j = 1, p = c - W; j <= length && j <= 3 && p >= 0 && mat[p] === 0; j++, p -= W) { index[p] = s; px[p] = words[s]; }
    }
    let keys = null;
    return {
      rgba, width: W, height: H,
      // The palette key at each pixel, as rows; '.' where nothing is.
      get keys() {
        if (!keys) {
          keys = [];
          for (let j = 0; j < H; j++) { let row = ''; for (let x = 0; x < W; x++) { const i = index[j * W + x]; row += i === 255 ? '.' : KEY_CHARS[i]; } keys.push(row); }
        }
        return keys;
      }
    };
  };

  // ---- The source's starting scene ----
  const sceneSpot = (op, path) => {
    const shapes = ['rect', 'disc', 'rows'].filter(key => op[key] !== undefined);
    if (shapes.length !== 1) fail(path, 'expected exactly one of rect [x, y, w, h], disc [x, y, radius] or rows (with at and legend)');
    return shapes[0];
  };
  T.scene.forEach((op, n) => {
    const path = `powder.scene[${n}]`;
    if (!isObject(op)) fail(path, 'expected a fill');
    known(op, ['material', 'rect', 'disc', 'rows', 'at', 'legend', 'fill', 'replace', 'temperature', 'burning'], path);
    reseed(SALT.scene, n);
    const fill = number(op.fill ?? 1, `${path}.fill`, 0, 1) * ONE, shape = sceneSpot(op, path);
    const warm = op.temperature === undefined ? undefined : degrees(op.temperature, `${path}.temperature`);
    // Later fills paint over earlier ones, unless `replace: false` keeps what is there.
    const keep = op.replace === false;
    const put = (c, m) => {
      if (fill < ONE && rand() >= fill) return;
      if (keep && mat[c] !== 0) return;
      place(c, m, warm);
      if (op.burning && m && igniteAt[m] !== NEVER_ABOVE) light(c);
    };
    const ints = (value, count, label) => { if (!Array.isArray(value) || value.length !== count || value.some(v => !Number.isInteger(v) || Math.abs(v) > 4096)) fail(`${path}.${label}`, `expected ${count} whole numbers`); return value; };
    if (shape === 'rows') {
      if (!Array.isArray(op.rows) || op.rows.some(row => typeof row !== 'string')) fail(`${path}.rows`, 'expected rows of characters');
      if (!isObject(op.legend)) fail(`${path}.legend`, 'expected { character: material }');
      for (const key of Object.keys(op.legend)) if ([...key].length !== 1) fail(`${path}.legend.${key}`, 'legend keys are single characters, one per pixel of the rows');
      const legend = new Map(Object.entries(op.legend).map(([key, name]) => [key, T.ref(name, `${path}.legend.${key}`)]));
      const [ax, ay] = ints(op.at, 2, 'at');
      op.rows.forEach((row, j) => [...row].forEach((ch, i) => {
        if (!legend.has(ch)) return;
        const x = ax + i, y = ay + j;
        if (x >= 0 && y >= 0 && x < W && y < H) put(y * W + x, legend.get(ch));
      }));
      return;
    }
    if (op.material === undefined) fail(`${path}.material`, 'expected a material name');
    const m = T.ref(op.material, `${path}.material`);
    if (shape === 'rect') {
      const [x, y, w, h] = ints(op.rect, 4, 'rect');
      for (let j = Math.max(0, y); j < Math.min(H, y + h); j++) for (let i = Math.max(0, x); i < Math.min(W, x + w); i++) put(j * W + i, m);
    } else {
      const [x, y, radius] = ints(op.disc, 3, 'disc');
      capsule(x, y, x, y, radius, c => put(c, m));
    }
  });
  PLANS.set(live, {
    script, tumble: TUMBLE,
    falling: () => { let n = 0; for (let c = 0; c < N; c++) if (falls[mat[c]]) n++; for (const entry of script) if (entry.falls) n += entry.area; return n < N ? n / N : 1; }
  });
  return live;
}

// ---- Compiling ----------------------------------------------------------------------------------------------------
// Bakes a source into an ordinary recipe: the grid runs from its scene, playing its scripted inputs, and each clip
// samples it every `every` steps from `start` (60 steps a second), drawn exactly as render() draws it. Pixels that never
// change in any sampled frame are drawn once, as the symbol `still`, stamped under every frame; each frame draws the
// rest as one palette grid per 16-row band, cropped to where anything changes. Returns { recipe, metadata, warnings? }:
// warnings (only when there are any) name scripted inputs played after the last step a clip samples.
export function compilePowder(source) {
  if (!isObject(source)) fail('powder', 'expected a pixelforge-powder source object');
  if (source.version !== 1) fail('powder.version', 'expected 1');
  const name = recipeName(source.name, 'powder.name');
  const live = createLivePowder(source), { width: W, height: H } = live;
  if (W > CANVAS_SIDE || H > CANVAS_SIDE) fail(W > CANVAS_SIDE ? 'powder.width' : 'powder.height', `a compiled powder grid is an animation, at most ${CANVAS_SIDE} pixels a side; use a smaller grid, or run a larger one live in a page or game (createLivePowder)`);
  // Clips: each a one-shot animation.
  const given = source.clips ?? { [name]: {} };
  if (!isObject(given) || !Object.keys(given).length || Object.keys(given).length > LIMITS.clips) fail('powder.clips', `expected 1 to ${LIMITS.clips} named clips: { start, frames, every, duration }`);
  const clips = Object.entries(given).map(([clip, value]) => {
    const path = `powder.clips.${clip}`;
    recipeName(clip, path);
    if (!isObject(value)) fail(path, 'expected { start, frames, every, duration }');
    known(value, ['start', 'frames', 'every', 'duration'], path);
    const start = integer(value.start ?? 0, `${path}.start`, 0, LIMITS.steps), frames = integer(value.frames ?? 60, `${path}.frames`, 1, LIMITS.frames);
    const every = integer(value.every ?? 2, `${path}.every`, 1, 60), duration = integer(value.duration ?? Math.round(every * 1000 / 60), `${path}.duration`, 10, 10000);
    return { clip, start, frames, every, duration, last: start + (frames - 1) * every };
  });
  if (new Set(clips.map(c => c.clip.toLowerCase())).size !== clips.length) fail('powder.clips', 'clip names must be unique ignoring case');
  const total = clips.reduce((sum, c) => sum + c.frames, 0), steps = Math.max(...clips.map(c => c.last));
  if (total > LIMITS.frames) fail('powder.clips', `${total} frames in all; a recipe holds at most ${LIMITS.frames}`);
  if (W * H * total > FRAME_AREA) fail('powder.clips', `${total} frames of ${W}×${H} are ${(W * H * total).toLocaleString('en')} pixels; a recipe holds at most 4,194,304 (fewer frames, or a smaller grid)`);
  if (steps > LIMITS.steps) fail('powder.clips', `the clips need ${steps} steps; at most ${LIMITS.steps}`);
  // The work, in cell steps (see INPUT_WORK): the grid's, weighed for tumbling pieces, and each scripted input's on the
  // steps it runs before the last one sampled (the step from `steps` on is never run).
  const plan = PLANS.get(live), millions = n => (n < 1e7 ? (Math.round(n / 1e5) / 10).toString() : Math.round(n / 1e6).toLocaleString('en')), most = `${LIMITS.work / 1e6} million`;
  const share = plan.tumble ? plan.falling() : 0, weight = plan.tumble ? TUMBLE_WORK + TUMBLE_SHARE * share : 1, grid = W * H * steps * weight;
  if (grid > LIMITS.work) {
    fail('powder.clips', plan.tumble
      ? `the clips need ${millions(W * H * steps)} million cell steps, which with pieces "tumble" (solids that fall fill ${Math.round(share * 100)}% of the grid) weigh as about ${millions(grid)} million, more than ${most}; fewer steps, a smaller grid, fewer solids that fall, or pieces "drop"`
      : `the clips need about ${millions(grid)} million cell steps, more than ${most}; fewer steps or a smaller grid`);
  }
  const runs = entry => (entry.from < steps ? Math.floor(((entry.to < steps - 1 ? entry.to : steps - 1) - entry.from) / entry.every) + 1 : 0);
  const work = plan.script.map(entry => runs(entry) * entry.cost), inputs = work.reduce((sum, w) => sum + w, 0);
  if (grid + inputs > LIMITS.work) {
    const n = work.indexOf(Math.max(...work)), entry = plan.script[n];
    fail(entry.path, `the scripted inputs need about ${millions(inputs)} million cell steps of work (this one ${millions(work[n])} million: ${runs(entry).toLocaleString('en')} times, over ${entry.over} each), and with the grid's ${millions(grid)} million that is more than ${most}; play it on fewer steps (frames, every)${entry.push ? ', or make the air coarser (air.flow.cell)' : ' or over fewer cells (radius, x2, y2)'}`);
  }
  // A scripted input played only after the last step a clip samples changes no frame.
  const warnings = plan.script.filter(entry => entry.from >= steps).map(entry => `${entry.path} is played ${entry.from === entry.to ? 'on' : 'from'} step ${entry.from}, so it first shows on step ${entry.from + 1}, after the last step a clip samples (${steps}): no frame shows it; play it earlier, or sample later (a clip's start, frames and every)`);

  // Every sampled moment, in time order, then each clip's frames from them.
  const times = [...new Set(clips.flatMap(c => Array.from({ length: c.frames }, (_, k) => c.start + k * c.every)))].sort((a, b) => a - b);
  const keys = new Map(), summaries = {};
  for (const time of times) {
    live.step(time - live.frame);
    keys.set(time, live.render().keys.join(''));
    for (const c of clips) if (c.last === time) {
      const { counts, chunks } = live.measure();
      summaries[c.clip] = { start: c.start, frames: c.frames, every: c.every, duration: c.duration, steps: c.last, counts, settled: chunks.stepped === 0 };
    }
  }
  // The still layer: pixels the same in every sampled frame.
  const first = keys.get(times[0]), moving = new Uint8Array(W * H);
  for (const time of times) { const k = keys.get(time); for (let c = 0; c < W * H; c++) if (k[c] !== first[c]) moving[c] = 1; }
  const still = [];
  let anyStill = false;
  for (let y = 0; y < H; y++) { let row = ''; for (let x = 0; x < W; x++) { const c = y * W + x, key = moving[c] ? '.' : first[c]; if (key !== '.') anyStill = true; row += key; } still.push(row); }
  // Each band's box round its changing pixels.
  const boxes = [];
  for (let y0 = 0; y0 < H; y0 += 16) {
    let left = W, right = -1, top = H, bottom = -1;
    for (let y = y0; y < Math.min(H, y0 + 16); y++) for (let x = 0; x < W; x++) if (moving[y * W + x]) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
    if (right >= 0) boxes.push({ x: left, y: top, w: right - left + 1, h: bottom - top + 1 });
  }
  const used = new Set();
  const frameOps = time => {
    const k = keys.get(time), ops = anyStill ? [{ op: 'stamp', symbol: 'still', x: 0, y: 0 }] : [];
    for (const box of boxes) {
      const rows = [];
      for (let y = box.y; y < box.y + box.h; y++) { let row = ''; for (let x = box.x; x < box.x + box.w; x++) { const c = y * W + x, key = moving[c] ? k[c] : '.'; if (key !== '.') used.add(key); row += key; } rows.push(row); }
      ops.push({ op: 'grid', x: box.x, y: box.y, rows });
    }
    return ops;
  };
  const frames = [], animations = {};
  for (const c of clips) {
    const names = [];
    for (let n = 0; n < c.frames; n++) { const frameName = `${c.clip}-${n}`; names.push(frameName); frames.push({ name: frameName, duration: c.duration, ops: frameOps(c.start + n * c.every) }); }
    animations[c.clip] = { frames: names, loop: false };
  }
  for (const row of still) for (const key of row) if (key !== '.') used.add(key);
  const palette = Object.fromEntries(Object.entries(live.palette).filter(([key]) => used.has(key)));
  const background = live.backgroundColor;
  const recipe = { version: 1, name, width: W, height: H, ...(background && { background }), palette, ...(anyStill && { symbols: { still } }), frames, animations };
  renderProject(recipe);
  return JSON.parse(JSON.stringify({ recipe, metadata: { format: 'pixelforge-powder-metadata', version: 1, steps, clips: summaries }, ...(warnings.length && { warnings }) }));
}

// ---- Recorded strokes ---------------------------------------------------------------------------------------------
// Replays recorded strokes (in frame order, as recorded) on a fresh runner of the same source: each on its frame, then a
// step, for `frames` frames. A runner already part of the way there carries on: the strokes of frames it has run are its
// past, and are passed over.
export function replayStrokes(live, strokes, frames) {
  let at = 0;
  while (at < strokes.length && strokes[at].f < live.frame) at++;
  for (let f = live.frame; f < frames; f++) {
    while (at < strokes.length && strokes[at].f === f) applyStroke(live, strokes[at++]);
    live.step();
  }
  return live;
}
export function applyStroke(live, s) {
  const at = { x: s.x, y: s.y, x2: s.x2, y2: s.y2, radius: s.radius };
  if (s.op === 0) live.paint({ material: live.materials[s.m - 1], ...at, fill: s.fill, replace: s.replace });
  else if (s.op === 1) live.erase(at);
  else if (s.op === 2) live.wall(at);
  else if (s.op === 3) live.heat({ ...at, amount: s.amount });
  else if (s.op === 4) live.push({ ...at, vx: s.vx, vy: s.vy });
  else live.burst({ x: s.x, y: s.y, radius: s.radius, strength: s.strength });
  return live;
}
// The binary form, as the fluid toy's links pack pokes: a format byte, the frames, the stroke count, then per stroke
// the frames since the last, its op (and material), its start as a step from the last in quarter pixels, its end as a
// step from its start, its radius, and its amount, push or strength. Deflate it and base64url it for a link.
const FORMAT = 1;
const varint = (out, value) => { for (;;) { if (value < 128) { out.push(value); return; } out.push((value & 127) | 128); value = Math.floor(value / 128); } };
const zigzag = value => (value < 0 ? -2 * value - 1 : 2 * value);
export function packStrokes(strokes, frames) {
  const out = [FORMAT];
  varint(out, frames); varint(out, strokes.length);
  let f = 0, x = 0, y = 0;
  for (const s of strokes) {
    const qx = Math.round(s.x * 4), qy = Math.round(s.y * 4), qx2 = Math.round((s.x2 ?? s.x) * 4), qy2 = Math.round((s.y2 ?? s.y) * 4);
    varint(out, s.f - f); out.push(s.op | (s.op === 0 && s.replace ? 8 : 0)); if (s.op === 0) out.push(s.m);
    varint(out, zigzag(qx - x)); varint(out, zigzag(qy - y));
    varint(out, zigzag(qx2 - qx)); varint(out, zigzag(qy2 - qy)); varint(out, Math.round(s.radius * 4));
    if (s.op === 0) out.push(Math.round(s.fill * 100));
    else if (s.op === 3) varint(out, zigzag(s.amount));
    else if (s.op === 4) { varint(out, zigzag(Math.round(s.vx * 16))); varint(out, zigzag(Math.round(s.vy * 16))); }
    else if (s.op === 5) varint(out, Math.round(s.strength * 16));
    f = s.f; x = qx; y = qy;
  }
  return new Uint8Array(out);
}
export function unpackStrokes(bytes) {
  let at = 0;
  const byte = () => { if (at >= bytes.length) fail('strokes', 'damaged: ended early'); return bytes[at++]; };
  const read = () => { let value = 0, scale = 1; for (let n = 0; n < 5; n++) { const b = byte(); value += (b & 127) * scale; if (b < 128) return value; scale *= 128; } return fail('strokes', 'damaged varint'); };
  const signed = () => { const v = read(); return v % 2 ? -(v + 1) / 2 : v / 2; };
  if (byte() !== FORMAT) fail('strokes', 'made by a newer format');
  const frames = read(), count = read(), strokes = [];
  if (count > LIMITS.strokes) fail('strokes', `more than ${LIMITS.strokes} strokes`);
  let f = 0, x = 0, y = 0;
  for (let n = 0; n < count; n++) {
    f += read();
    const code = byte(), op = code & 7, s = { f, op };
    if (op > 5) fail('strokes', 'damaged: unknown stroke');
    if (op === 0) { s.m = byte(); s.replace = !!(code & 8); }
    x += signed(); y += signed();
    const x2 = x + signed(), y2 = y + signed();
    Object.assign(s, { x: x / 4, y: y / 4, x2: x2 / 4, y2: y2 / 4, radius: read() / 4 });
    if (op === 0) s.fill = byte() / 100;
    else if (op === 3) s.amount = signed();
    else if (op === 4) { s.vx = signed() / 16; s.vy = signed() / 16; }
    else if (op === 5) { s.strength = read() / 16; delete s.x2; delete s.y2; }
    strokes.push(s);
  }
  if (at !== bytes.length) fail('strokes', 'damaged: bytes after the strokes');
  return { frames, strokes };
}

// ---- A starter table ----------------------------------------------------------------------------------------------
// Generic materials for a sandbox, as an agent would write them. Densities are relative to air (1); temperatures are
// degrees; chances are per frame. `sandboxSource(width, height, scene)` wraps them into a source.
export const SANDBOX = {
  ambient: 20,
  background: '#17161f',
  air: { conduct: 0.01, cool: 0.03, flow: { cell: 4, rise: 0.25, swirl: 0.3, calm: 0.02, carry: 0.3 } },
  materials: {
    sand: { state: 'powder', density: 16, splash: 0.04, conduct: 0.15, colors: ['#d8b06a', '#cfa45e', '#e2bd7a', '#c69a55', '#d8b06a'] },
    water: {
      state: 'liquid', density: 10, spread: 6, drag: 0.5, splash: 0.15, conduct: 0.5, colors: ['#2e6db0', '#3173b8', '#2c67a7'], top: '#5d9ee0', streak: '#24476f',
      hot: { from: 70, to: 400, colors: ['#3a7cc0', '#4a8bcb', '#6aa3d8', '#8dbbe4'] },
      above: { temperature: 100, latent: 300, into: 'steam', chance: 0.2 }, below: { temperature: -1, latent: 40, into: 'ice', chance: 0.04 }
    },
    stone: {
      state: 'solid', conduct: 0.12, pattern: 'blotch', colors: ['#57545e', '#5f5c66', '#66636d', '#6d6a74'],
      hot: { from: 350, to: 1100, colors: ['#5e3c36', '#86392a', '#b84a22', '#e2702a'] },
      above: { temperature: 1150, into: 'lava', chance: 0.01 }
    },
    wood: {
      state: 'solid', falls: true, density: 6, conduct: 0.06, pattern: 'grain', colors: ['#6a3f23', '#74462a', '#7b4b2a', '#865430'],
      burn: { temperature: 280, frames: [140, 260], heat: 650, into: 'ash', chance: 0.35, emit: [{ material: 'fire', chance: 0.5 }, { material: 'smoke', chance: 0.04 }], colors: ['#ffcf4a', '#ff9a2e', '#e8551f', '#a8331b', '#ff9a2e'] }
    },
    fire: {
      state: 'fire', density: 0.2, spread: 0, speed: 0.75, conduct: 0.3, temperature: 900, heat: 900,
      life: { frames: [6, 14], into: 'smoke', chance: 0.3 }, colorBy: 'density', colors: ['#3a1d1c', '#7a2a18', '#c9391e', '#f4672a', '#ffa632', '#ffd84f', '#fff2b0']
    },
    smoke: {
      state: 'gas', density: 0.7, spread: 1, speed: 0.5, cool: 0.04, life: { frames: [80, 200] }, colorBy: 'density',
      colors: ['#22212b', '#2c2b35', '#373640', '#43424c', '#504f58', '#5e5d65']
    },
    steam: {
      state: 'gas', density: 0.4, spread: 2, speed: 0.7, expand: 3, cool: 0.015, conduct: 0.1, temperature: 110, life: { frames: [60, 150] }, colorBy: 'density',
      colors: ['#252935', '#313746', '#424a5c', '#5a6478', '#7c879b', '#a9b4c6'],
      below: { temperature: 65, into: 'water', chance: 0.001 }
    },
    oil: {
      state: 'liquid', density: 8, spread: 4, viscosity: 0.25, drag: 0.6, conduct: 0.15, colors: ['#2b2620', '#312b22', '#27221d'], top: '#a08850',
      burn: { temperature: 200, frames: [60, 120], heat: 700, emit: [{ material: 'fire', chance: 0.6 }, { material: 'smoke', chance: 0.1 }] }
    },
    lava: {
      state: 'liquid', density: 30, spread: 3, viscosity: 0.55, drag: 0.85, conduct: 0.2, temperature: 1200, shimmer: 120,
      colors: ['#ff7b1c', '#ff6418', '#ff9a30', '#f05514'], top: '#ffc85a',
      below: { temperature: 550, into: 'stone', chance: 0.02 }
    },
    ice: {
      state: 'solid', falls: true, density: 9.2, conduct: 0.5, temperature: -30, pattern: 'blotch', colors: ['#98cbe6', '#a8d6ee', '#bde2f4'],
      above: { temperature: 1, latent: 40, into: 'water', chance: 0.03 }
    },
    ash: { state: 'powder', density: 5, conduct: 0.1, colors: ['#8b8884', '#7d7a77', '#99968f'], hot: { from: 250, to: 650, colors: ['#5c2c22', '#9c3b1e', '#e0652c'] } },
    // The interesting one: moss is alive. It drinks water next to it and grows into the space, and burns fast.
    moss: {
      state: 'solid', falls: true, clings: true, density: 7, conduct: 0.08, colors: ['#4e8a39', '#5b9a41', '#427a31', '#69ab49'],
      burn: { temperature: 150, frames: [14, 30], heat: 500, emit: [{ material: 'fire', chance: 0.5 }, { material: 'smoke', chance: 0.03 }], colors: ['#ffe066', '#ffa632', '#d8521f'] }
    },
    wall: { state: 'solid', conduct: 0.05, pattern: 'blotch', colors: ['#363847', '#3b3d4c', '#414456'] }
  },
  reactions: [
    { a: 'water', b: 'lava', into: ['steam', 'stone'], chance: 0.35 },
    { a: 'fire', b: 'wood', ignite: 'b', chance: 0.04 },
    { a: 'fire', b: 'oil', ignite: 'b', chance: 0.25 },
    { a: 'fire', b: 'moss', ignite: 'b', chance: 0.3 },
    { a: 'water', b: 'fire', into: [null, 'empty'], heat: 15, chance: 0.6 },
    { a: 'water', b: 'wood', burning: 'b', douse: 'b', heat: 10, chance: 0.3 },
    { a: 'moss', b: 'water', into: [null, 'moss'], chance: 0.004 },
    { a: 'lava', b: 'ice', into: ['stone', 'water'], chance: 0.2 }
  ]
};
export const sandboxSource = (width, height, scene = [], seed = 1) => ({ format: 'pixelforge-powder', version: 1, name: 'sandbox', width, height, seed, ...structuredClone(SANDBOX), scene });
