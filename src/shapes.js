// Stylized combat and spell shapes for pixelforge-fx effects: shockwave rings, slash crescents, beams, lightning
// bolts, magic circles, impact stars and fire bursts. Each layer writes an intensity field over the canvas inside its
// own window of frames; the layers of one look combine (the larger value, or the sum) and the look cuts the result
// into hard bands of palette colours, optionally feathered through an ordered dither. Cleanup and a one-pixel outline
// follow, and the fx compiler bakes each frame into one grid operation under its particles, so the result stays an
// ordinary recipe. Browser-compatible and deterministic: + − × ÷ and sqrt, craft's polynomial trigonometry and seeded
// hashing, so every engine draws the same pixels.
import { PixelError } from './core.js';
import { fields } from './authoring.js';
import { patternProblem, ditherThreshold, cleanupIds, traceLine, hash, random, sinDeg, cosDeg, ease, EASINGS } from './craft.js';

export const SHAPE_KINDS = ['ring', 'slash', 'beam', 'bolt', 'glyph', 'star', 'burst', 'stream', 'aura', 'trail'];
const LIMITS = { layers: 16, looks: 8, colors: 8 };
const PI = 3.141592653589793;
// Tilt and squash belong to the kinds drawn around a centre; bolts, streams and trails run between points and auras hug
// a sprite, so they take neither.
const SPECIFIC = {
  aura: ['symbol', 'around', 'disc', 'width', 'rise', 'noise', 'scale', 'boil'],
  trail: ['points', 'pivot', 'length', 'width', 'taper', 'fade', 'noise', 'flow', 'scale'],
  ring: ['radius', 'width', 'fill', 'noise', 'scale', 'boil', 'tilt', 'squash'],
  slash: ['radius', 'width', 'arc', 'reveal', 'noise', 'flow', 'scale', 'tilt', 'squash'],
  beam: ['to', 'width', 'reveal', 'wobble', 'wavelength', 'waves', 'fade', 'noise', 'flow', 'scale', 'tilt', 'squash'],
  bolt: ['to', 'width', 'glow', 'jag', 'branches', 'reroll', 'segment', 'reveal', 'noise', 'flow', 'scale'],
  glyph: ['radius', 'inner', 'points', 'step', 'runes', 'double', 'spin', 'reveal', 'glow', 'fill', 'noise', 'flow', 'scale', 'tilt', 'squash'],
  star: ['radius', 'points', 'ratio', 'width', 'core', 'angle', 'spin', 'jitter', 'noise', 'flow', 'scale', 'tilt', 'squash'],
  burst: ['radius', 'hole', 'noise', 'scale', 'boil', 'tilt', 'squash'],
  stream: ['through', 'width', 'taper', 'head', 'tail', 'sway', 'wavelength', 'waves', 'fade', 'noise', 'flow', 'scale']
};
const COMMON = ['kind', 'look', 'at', 'path', 'frames', 'ease', 'power', 'flicker', 'blend', 'drift', 'curve', 'floor', 'seed', 'cue', 'depth'];
// Where a layer draws relative to a character standing in the effect: in front (the default), behind it, or split at
// the layer's centre row, its far half (above) behind and its near half in front, as a ring lying round its feet.
export const LAYER_DEPTHS = ['front', 'back', 'split'];
// Painting work across one compile, in pixels visited: very wide streams or ink over many frames are refused instead
// of running for hours. Area shapes visit each canvas pixel once a frame, so the recipe's frame-area limit keeps them
// well under it. The shipped effects use under 0.1%; reaching it takes a few seconds.
export const SHAPE_WORK = 400_000_000;

const fail = (path, message) => { throw new PixelError(path, message); };
// Counts `n` pixels visited against the compile's shared budget (painting, and measuring an aura's distance field),
// refusing the layer at `path` that crosses it.
const spendWork = (work, n, path) => {
  work.spent += n;
  if (work.spent > SHAPE_WORK) fail(path, `the shape layers would visit more than ${SHAPE_WORK.toLocaleString('en-US')} pixels to draw; make them smaller (radius, width, the part on the canvas), fewer, or over fewer frames`);
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, path, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a number from ${min} to ${max}`);
  return value;
};
const integer = (value, path, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value;
};
const pair = (value, path, min, max) => {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'expected [x, y]');
  return [number(value[0], `${path}[0]`, min, max), number(value[1], `${path}[1]`, min, max)];
};
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
function squashOf(value, path) {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return { squash: pair(value ?? [1, 1], path, 0.125, 8), squashKeys: null };
  if (value.length < 2 || value.length > 8) fail(path, 'expected [x, y], or 2–8 of them as keys spread over the layer\'s frames');
  const keys = value.map((key, i) => pair(key, `${path}[${i}]`, 0.125, 8));
  return { squash: keys[0], squashKeys: [keys.map(key => key[0]), keys.map(key => key[1])] };
}
// drift: [x, y] moved over the window, or 2–8 offsets (a path's 2–16) as keys spread over it, so a layer can travel a curve (an orb
// that arcs, a flame that wanders) instead of a straight line.
function driftOf(value, path, most = 8) {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return { drift: pair(value ?? [0, 0], path, -4096, 4096), driftKeys: null };
  if (value.length < 2 || value.length > most) fail(path, `expected [x, y], or 2–${most} offsets [x, y] as keys spread over the layer's frames`);
  const keys = value.map((key, i) => pair(key, `${path}[${i}]`, -4096, 4096));
  return { drift: keys.at(-1), driftKeys: [keys.map(key => key[0]), keys.map(key => key[1])] };
}
// The frame of an animation (a list of frames) that effect frame t shows: frame for frame, holding the last after the
// animation ends, or round again in a loop.
export const sequenceFrame = (list, t, loop) => list[loop ? t % list.length : Math.min(t, list.length - 1)];
const round = x => Math.floor(x + 0.5);

// The angle of (x, y) in degrees clockwise from +x (y points down), in [0, 360). Two half-angle steps bring the
// tangent under 0.2, where the Taylor series to t^21 is exact to double precision: + − × ÷ and sqrt only.
export function atan2Deg(y, x) {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y), small = ay <= ax;
  let t = small ? ay / ax : ax / ay;
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));
  const t2 = t * t;
  const series = t * (1 + t2 * (-1 / 3 + t2 * (1 / 5 + t2 * (-1 / 7 + t2 * (1 / 9 + t2 * (-1 / 11 + t2 * (1 / 13 + t2 * (-1 / 15 + t2 * (1 / 17 + t2 * (-1 / 19 + t2 / 21))))))))));
  let a = 4 * series * 180 / PI;
  if (!small) a = 90 - a;
  if (x < 0) a = 180 - a;
  if (y < 0) a = 360 - a;
  return a >= 360 ? a - 360 : a;
}

// A number, or 2–8 keys spread evenly over the layer's frames (through its easing).
export function tween(value, path, min, max) {
  if (!Array.isArray(value)) return [number(value, path, min, max)];
  if (value.length < 2 || value.length > 8) fail(path, `expected a number from ${min} to ${max}, or 2–8 of them as keys spread over the layer's frames`);
  return value.map((v, i) => number(v, `${path}[${i}]`, min, max));
}
// Keys through a uniform Catmull-Rom curve instead of straight lines: it passes through every key with no corner at
// the inner ones (the end keys' neighbours are themselves). Polynomial, so every engine computes the same bits.
export function curveSample(keys, q) {
  if (keys.length < 3) return sample(keys, q);
  const n = keys.length - 1, s = q * n, i = Math.max(0, Math.min(n - 1, Math.floor(s))), u = s - i;
  const p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(n, i + 2)];
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u);
}
// A point moving at a steady speed along a path of points, straight between them or through a smooth curve: `t` is the
// share of the path's length travelled, so points far apart take longer to pass between than points close together.
// A curve is measured along 16 straight pieces per span. Only + − × ÷ and sqrt, so every engine gives the same bits.
export function pathWalker(points, curved = false) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]), steps = (points.length - 1) * (curved ? 16 : 1);
  const marks = Array.from({ length: steps + 1 }, (_, k) => (curved ? [curveSample(xs, k / steps), curveSample(ys, k / steps)] : points[k]));
  const lengths = [0];
  for (let k = 1; k <= steps; k++) { const dx = marks[k][0] - marks[k - 1][0], dy = marks[k][1] - marks[k - 1][1]; lengths.push(lengths[k - 1] + Math.sqrt(dx * dx + dy * dy)); }
  const total = lengths[steps];
  return t => {
    if (!(total > 0)) return [marks[0][0], marks[0][1]];
    const d = Math.min(1, Math.max(0, t)) * total;
    let low = 0, high = steps - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (lengths[mid] <= d) low = mid; else high = mid - 1; }
    const span = lengths[low + 1] - lengths[low], u = span > 0 ? (d - lengths[low]) / span : 0;
    return [marks[low][0] + (marks[low + 1][0] - marks[low][0]) * u, marks[low][1] + (marks[low + 1][1] - marks[low][1]) * u];
  };
}
export function sample(keys, q) {
  if (keys.length === 1) return keys[0];
  const s = q * (keys.length - 1), i = Math.max(0, Math.min(keys.length - 2, Math.floor(s)));
  return keys[i] + (keys[i + 1] - keys[i]) * (s - i);
}
const maxKey = keys => Math.max(...keys);

// Rune glyphs: 3×3 pixel marks stamped upright around a magic circle, so they stay crisp and readable when the
// circle is squashed onto the ground or turns (only their places move, never their pixels).
const RUNES = [
  ['.x.', 'xxx', '.x.'], ['x.x', '.x.', 'x.x'], ['xxx', '.x.', '.x.'], ['x..', 'xx.', 'x..'],
  ['.x.', 'x.x', '.x.'], ['x.x', 'xxx', 'x.x'], ['x.x', 'x.x', '.x.'], ['xxx', '..x', '..x']
];

function paletteKey(key, path, palette) {
  if (typeof key !== 'string' || key.length !== 1 || key === '.' || key === ' ' || !Object.hasOwn(palette, key)) fail(path, 'expected a single-character key in the palette');
  return key;
}

// Lit and shade bands: palette keys cut from the share by which the look's field falls two pixels toward the light
// (or away from it): 1 on a rim that faces that way, 0 inside.
function readShading(value, path, palette) {
  if (!isObject(value)) fail(path, 'expected { colors, thresholds }: palette keys and the rising shares (0–1) where each begins');
  fields(value, ['colors', 'thresholds'], path);
  if (!Array.isArray(value.colors) || !value.colors.length || value.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 1–${LIMITS.colors} palette keys`);
  const codes = value.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette).charCodeAt(0));
  if (!Array.isArray(value.thresholds) || value.thresholds.length !== codes.length) fail(`${path}.thresholds`, `expected ${codes.length} thresholds, one per colour`);
  const thresholds = value.thresholds.map((t, i) => {
    number(t, `${path}.thresholds[${i}]`, 0.001, 1);
    if (i && t <= value.thresholds[i - 1]) fail(`${path}.thresholds[${i}]`, 'thresholds must rise from one colour to the next');
    return t;
  });
  return { codes, thresholds };
}

function readLook(look, path, palette, seed) {
  fields(look, ['colors', 'thresholds', 'dither', 'pattern', 'outline', 'halo', 'light', 'reach', 'lit', 'shade', 'front'], path);
  // halo: a glow of one colour on the empty pixels within `width` steps of the look (beyond its outline), on every
  // other pixel when dithered (the default from width 2: a checkerboard on a one-pixel ring would leave whole diagonal
  // sides solid or empty), so a bright shape glows without a hard ring.
  let halo = null;
  if (look.halo !== undefined) {
    if (look.halo === null || typeof look.halo !== 'object' || Array.isArray(look.halo)) fail(`${path}.halo`, 'expected { color, width, dither }');
    fields(look.halo, ['color', 'width', 'dither'], `${path}.halo`);
    if (look.halo.color === undefined) fail(`${path}.halo.color`, 'name the palette key the glow is drawn in');
    halo = { color: paletteKey(look.halo.color, `${path}.halo.color`, palette).charCodeAt(0), width: integer(look.halo.width ?? 1, `${path}.halo.width`, 1, 4),
      dither: look.halo.dither === undefined ? (look.halo.width ?? 1) > 1 : (typeof look.halo.dither === 'boolean' ? look.halo.dither : fail(`${path}.halo.dither`, 'expected true or false')) };
  }
  const lit = look.lit === undefined ? null : readShading(look.lit, `${path}.lit`, palette), shade = look.shade === undefined ? null : readShading(look.shade, `${path}.shade`, palette);
  if (look.light !== undefined && !lit && !shade) fail(`${path}.light`, 'light points the lit and shade bands; add lit or shade too');
  const toward = look.light === undefined ? [-1, -1] : pair(look.light, `${path}.light`, -1, 1), reach = Math.sqrt(toward[0] * toward[0] + toward[1] * toward[1]);
  if (!reach) fail(`${path}.light`, 'expected a direction toward the light, such as [-1, -1] for the upper left');
  if (!Array.isArray(look.colors) || !look.colors.length || look.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 1–${LIMITS.colors} palette keys, from the faintest band to the brightest`);
  const colors = look.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette));
  if (!Array.isArray(look.thresholds) || look.thresholds.length !== colors.length) fail(`${path}.thresholds`, `expected ${colors.length} thresholds, one per colour`);
  const thresholds = look.thresholds.map((t, i) => {
    number(t, `${path}.thresholds[${i}]`, 0.001, 16);
    if (i && t <= look.thresholds[i - 1]) fail(`${path}.thresholds[${i}]`, 'thresholds must rise from one colour to the next');
    return t;
  });
  const pattern = look.pattern ?? 'bayer4', problem = patternProblem(pattern);
  if (problem) fail(`${path}.pattern${problem[0]}`, problem[1]);
  if (look.pattern !== undefined && look.dither === undefined) fail(`${path}.pattern`, 'pattern shapes the dither; set dither too');
  return {
    codes: colors.map(key => key.charCodeAt(0)), thresholds, gaps: thresholds.map((t, i) => t - (i ? thresholds[i - 1] : 0)),
    dither: number(look.dither ?? 0, `${path}.dither`, 0, 1), threshold: ditherThreshold(pattern, [0, 0], seed),
    outline: look.outline === undefined ? 0 : paletteKey(look.outline, `${path}.outline`, palette).charCodeAt(0), halo,
    lit, shade, light: [toward[0] / reach, toward[1] / reach],
    // front: drawn over the symbol particles (smoke over sparks) instead of under them.
    front: look.front === undefined ? false : (typeof look.front === 'boolean' ? look.front : fail(`${path}.front`, 'expected true or false')),
    // How many pixels toward (and away from) the light the field is compared over: 1 keeps a small drop's highlight to
    // a thin rim, 3–4 spreads light over a large body.
    reach: (look.reach !== undefined && !lit && !shade) ? fail(`${path}.reach`, 'reach sizes the lit and shade bands; add lit or shade too') : number(look.reach ?? 2, `${path}.reach`, 0.5, 8)
  };
}

function readLayer(layer, path, context, index) {
  const { frames, lookNames, seed, loop, symbols, sequences, view, work } = context;
  if (!isObject(layer)) fail(path, 'expected a layer object');
  if (!SHAPE_KINDS.includes(layer.kind)) fail(`${path}.kind`, `expected ${SHAPE_KINDS.join(', ')}`);
  const kind = layer.kind;
  fields(layer, [...COMMON, ...SPECIFIC[kind]], path);
  let look = layer.look;
  if (look === undefined) {
    if (lookNames.length !== 1) fail(`${path}.look`, `name the look that colours this layer: ${lookNames.join(', ')}`);
    look = lookNames[0];
  } else if (!lookNames.includes(look)) fail(`${path}.look`, `no look is named ${JSON.stringify(look)}`);
  const window = layer.frames === undefined ? [0, frames] : layer.frames;
  if (!Array.isArray(window) || window.length !== 2) fail(`${path}.frames`, 'expected [first, end]: the first frame drawn and the frame after the last');
  const t0 = integer(window[0], `${path}.frames[0]`, 0, frames - 1), t1 = integer(window[1], `${path}.frames[1]`, t0 + 1, frames);
  // A layer that spans a whole looping effect is a cycle: its frame after the last is its first again. It moves at a
  // steady pace by default and draws without a reveal, so nothing restarts at the loop point, and a burst's noise boils
  // on through it (see burst). A shorter window in a loop is an event that repeats each cycle, drawn as a one-shot.
  const cycle = loop === true && t0 === 0 && t1 === frames;
  const name = layer.ease ?? (cycle ? 'linear' : 'out');
  if (!EASINGS.includes(name)) fail(`${path}.ease`, `expected one of ${EASINGS.join(', ')}`);
  const blend = layer.blend ?? 'max';
  if (!['max', 'add'].includes(blend)) fail(`${path}.blend`, 'expected max (the brighter layer wins) or add (layers sum)');
  let cue = null;
  if (layer.cue !== undefined) {
    if (typeof layer.cue !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(layer.cue) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(layer.cue)) fail(`${path}.cue`, 'expected a portable name of letters, digits, hyphens or underscores');
    cue = layer.cue;
  }
  // path: absolute points the layer moves through over its window, as an emitter's path does, so a projectile's head
  // and the emitters trailing it share one list of points. It stands for at (its first point) and keyed drift.
  let route = null;
  if (layer.path !== undefined) {
    if (layer.at !== undefined || layer.drift !== undefined) fail(`${path}.path`, 'a layer with a path starts at its first point and moves through the rest; leave at and drift out');
    if (!Array.isArray(layer.path) || layer.path.length < 2 || layer.path.length > 16) fail(`${path}.path`, 'expected 2–16 points [x, y] for the layer to move through over its window');
    route = layer.path.map((point, i) => pair(point, `${path}.path[${i}]`, -4096, 4096));
  }
  const out = {
    kind, look, t0, t1, ease: name, blend, cue, path, cycle,
    at: route ? route[0] : pair(layer.at, `${path}.at`, -4096, 4096),
    power: tween(layer.power ?? 1, `${path}.power`, 0, 8),
    flicker: number(layer.flicker ?? 0, `${path}.flicker`, 0, 1),
    tilt: number(layer.tilt ?? 0, `${path}.tilt`, -3600, 3600),
    // A squash may be keyed, 2–8 [x, y] pairs over the window: `squash` is the first, `squashKeys` the x and y keys.
    ...squashOf(layer.squash, `${path}.squash`),
    // A path moves the layer at a steady speed along its length (pathWalker), offsets from its first point.
    ...(route ? { drift: [route.at(-1)[0] - route[0][0], route.at(-1)[1] - route[0][1]], driftKeys: null, walk: pathWalker(route.map(([x, y]) => [x - route[0][0], y - route[0][1]]), layer.curve === true) } : driftOf(layer.drift, `${path}.drift`)),
    // curve: true runs keyed drift through a smooth curve, so an arc has no corner at its middle key.
    curved: layer.curve === undefined ? false : (typeof layer.curve !== 'boolean' ? fail(`${path}.curve`, 'expected true or false') : layer.curve && (route ? route.length : Array.isArray(layer.drift?.[0]) ? layer.drift.length : 0) < 3 ? fail(`${path}.curve`, 'curve smooths a path or drift keys; give three or more points') : layer.curve),
    floor: layer.floor === undefined ? null : number(layer.floor, `${path}.floor`, -4096, 4096),
    depth: layer.depth === undefined ? 'front' : LAYER_DEPTHS.includes(layer.depth) ? layer.depth : fail(`${path}.depth`, 'expected front, back, or split (the rows above the layer\'s centre go behind a character, the rest in front: a ring lying round its feet)'),
    seed: hash(seed, integer(layer.seed ?? index, `${path}.seed`, 0, 2147483647))
  };
  const t = (key, fallback, min, max) => tween(layer[key] ?? fallback, `${path}.${key}`, min, max);
  const required = key => { if (layer[key] === undefined) fail(`${path}.${key}`, `a ${kind} layer needs ${key}`); return layer[key]; };
  const reveal = fallback => number(layer.reveal ?? (cycle ? 0 : fallback), `${path}.reveal`, 0, 0.95);
  // Noise may be keyed like any other field, so a shape can stand solid and then shatter: `noise` is its strongest key.
  const noisy = fallback => { const noiseKeys = tween(layer.noise ?? fallback, `${path}.noise`, 0, 1); return { noise: maxKey(noiseKeys), noiseKeys }; };
  if (kind === 'ring') {
    Object.assign(out, { radius: t('radius', required('radius'), 0, 512), width: t('width', 3, 0, 256), fill: t('fill', 0, 0, 2), ...noisy(0), scale: integer(layer.scale ?? 6, `${path}.scale`, 1, 64), boil: number(layer.boil ?? 0, `${path}.boil`, -512, 512) });
    if (layer.boil !== undefined && !out.noise) fail(`${path}.boil`, 'boil moves the noise; give the ring noise too');
  }
  if (kind === 'slash') {
    const arc = pair(required('arc'), `${path}.arc`, -3600, 3600);
    if (arc[0] === arc[1] || Math.abs(arc[1] - arc[0]) > 360) fail(`${path}.arc`, 'expected [from, to] in degrees clockwise (0 right, 90 down), at most 360 apart; the slash sweeps from the first to the second');
    Object.assign(out, { radius: t('radius', required('radius'), 1, 512), width: t('width', 6, 0, 256), arc, reveal: reveal(0.35) });
  }
  if (kind === 'beam') Object.assign(out, { to: pair(required('to'), `${path}.to`, -4096, 4096), width: t('width', 5, 0, 256), reveal: reveal(0.15), wobble: number(layer.wobble ?? 0.15, `${path}.wobble`, 0, 1), wavelength: number(layer.wavelength ?? 12, `${path}.wavelength`, 2, 512), waves: number(layer.waves ?? 3, `${path}.waves`, -64, 64), fade: number(layer.fade ?? 0, `${path}.fade`, 0, 1) });
  if (kind === 'bolt') Object.assign(out, { to: pair(required('to'), `${path}.to`, -4096, 4096), width: t('width', 1, 1, 9), glow: t('glow', 1, 0, 4), jag: number(layer.jag ?? 0.35, `${path}.jag`, 0, 1), branches: integer(layer.branches ?? 2, `${path}.branches`, 0, 8), reroll: integer(layer.reroll ?? 2, `${path}.reroll`, 0, 256), segment: number(layer.segment ?? 4, `${path}.segment`, 2, 64), reveal: reveal(0) });
  if (kind === 'glyph') {
    const points = integer(layer.points ?? 5, `${path}.points`, 0, 12);
    if (points && points < 3) fail(`${path}.points`, 'expected 0 (no star) or 3–12 star points');
    const step = integer(layer.step ?? Math.max(1, Math.floor((points - 1) / 2)), `${path}.step`, 1, 6);
    // A step of the corner count or more joins each corner to itself, drawing dots instead of lines.
    if (points && step >= points) fail(`${path}.step`, `expected fewer than the ${points} points: each line joins a corner to the one step corners on`);
    Object.assign(out, { radius: t('radius', required('radius'), 2, 512), inner: number(layer.inner ?? 0.72, `${path}.inner`, 0.2, 0.95), points, step, runes: integer(layer.runes ?? 12, `${path}.runes`, 0, 48), double: layer.double === undefined ? false : (typeof layer.double === 'boolean' ? layer.double : fail(`${path}.double`, 'expected true or false')), spin: t('spin', 0, -3600, 3600), reveal: reveal(0.3), glow: t('glow', 1, 0, 4), fill: t('fill', 0, 0, 2) });
  }
  if (kind === 'star') Object.assign(out, { radius: t('radius', required('radius'), 0, 512), points: integer(layer.points ?? 8, `${path}.points`, 2, 16), ratio: number(layer.ratio ?? 0.55, `${path}.ratio`, 0.05, 1), width: t('width', 2.5, 0, 64), core: t('core', layer.width === undefined ? 3 : maxKey(tween(layer.width, `${path}.width`, 0, 64)) * 1.2, 0, 128), angle: number(layer.angle ?? 0, `${path}.angle`, -3600, 3600), spin: t('spin', 0, -3600, 3600), jitter: number(layer.jitter ?? 0, `${path}.jitter`, 0, 1) });
  if (kind === 'burst') {
    const radius = t('radius', required('radius'), 0, 512);
    Object.assign(out, { radius, hole: t('hole', 0, 0, 1), ...noisy(0.4), scale: integer(layer.scale ?? 4, `${path}.scale`, 1, 64), boil: number(layer.boil ?? maxKey(radius) * 0.5, `${path}.boil`, -512, 512) });
  }
  if (kind === 'stream') {
    if (!Array.isArray(layer.through) || !layer.through.length || layer.through.length > 7) fail(`${path}.through`, 'expected 1–7 more [x, y] points: the stream runs from at through each of them on a smooth curve');
    if (layer.taper !== undefined && !Array.isArray(layer.taper)) fail(`${path}.taper`, 'expected 2–8 width shares spread along the stream, from its tail to its head');
    const points = [out.at, ...layer.through.map((point, i) => pair(point, `${path}.through[${i}]`, -4096, 4096))];
    Object.assign(out, {
      curve: spline(points), width: t('width', 6, 0, 256), taper: tween(layer.taper ?? [0, 1, 0], `${path}.taper`, 0, 2), head: t('head', 1, 0, 1), tail: t('tail', 0, 0, 1),
      sway: number(layer.sway ?? 0, `${path}.sway`, -64, 64), wavelength: number(layer.wavelength ?? 16, `${path}.wavelength`, 2, 512), waves: number(layer.waves ?? 1, `${path}.waves`, -64, 64),
      fade: number(layer.fade ?? 0, `${path}.fade`, 0, 1)
    });
  }
  if (kind === 'aura') {
    // An aura hugs a sprite (symbol, top-left at at) or an ellipse (around: [rx, ry], centred on at; its ring, or with
    // disc the whole disc): flames licking up from a ground ring need no sprite.
    let rings = null;
    if (layer.around !== undefined) {
      if (layer.symbol !== undefined) fail(`${path}.around`, 'an aura hugs a symbol or an ellipse (around), not both');
      const [rx, ry] = pair(layer.around, `${path}.around`, 1, 64), disc = layer.disc === undefined ? false : (typeof layer.disc === 'boolean' ? layer.disc : fail(`${path}.disc`, 'expected true or false'));
      rings = [ellipseRows(Math.round(rx), Math.round(ry), disc)];
      out.at = [out.at[0] - Math.round(rx), out.at[1] - Math.round(ry)];
    } else if (layer.disc !== undefined) fail(`${path}.disc`, 'disc fills the ellipse an aura hugs; give around too');
    const name = rings ? null : required('symbol'), animated = typeof name === 'string' && !!sequences && Object.hasOwn(sequences, name);
    if (!rings && (typeof name !== 'string' || (!animated && !(symbols && Object.hasOwn(symbols, name))))) fail(`${path}.symbol`, `expected the name of one of the source's symbols${typeof name === 'string' ? `; there is none named ${JSON.stringify(name)}` : ''}`);
    const width = t('width', 3, 0, 32), rise = number(layer.rise ?? 2, `${path}.rise`, 1, 4);
    const { noise, noiseKeys } = noisy(0.5);
    // Noise stretches the reach by up to half its share, so the field is measured that far out.
    Object.assign(out, { symbol: name, width, rise, noise, noiseKeys, scale: integer(layer.scale ?? 3, `${path}.scale`, 1, 64), boil: number(layer.boil ?? 2 * maxKey(width) * rise, `${path}.boil`, -512, 512), loop,
      fields: (rings ?? (animated ? sequences[name] : [symbols[name]])).map(rows => auraField(rows, maxKey(width) * (1 + noise / 2), rise, path, animated, work)) });
    if (out.fields.every(field => !field)) fail(`${path}.symbol`, 'the symbol has no visible pixels for an aura to hug');
  }
  if (kind === 'trail') {
    if (!Array.isArray(layer.points) || !layer.points.length || layer.points.length > frames) fail(`${path}.points`, `expected 1–${frames} positions [x, y] (or null), one for each frame of the effect from the first, or follow: { recipe, animation, point }`);
    const points = Array.from({ length: frames }, (_, i) => (layer.points[i] === null || layer.points[i] === undefined ? null : pair(layer.points[i], `${path}.points[${i}]`, -4096, 4096)));
    if (points.every(p => p === null)) fail(`${path}.points`, 'expected at least one position to follow');
    // A pivot (fixed, or one place per frame) bends the smear round it, as a blade sweeps round its hilt.
    let pivots = null;
    if (layer.pivot !== undefined) {
      const each = Array.isArray(layer.pivot) && (Array.isArray(layer.pivot[0]) || layer.pivot[0] === null);
      if (each && layer.pivot.length > frames) fail(`${path}.pivot`, `expected [x, y], or 1–${frames} of them (or null), one for each frame`);
      pivots = each ? Array.from({ length: frames }, (_, i) => (layer.pivot[i] === null || layer.pivot[i] === undefined ? null : pair(layer.pivot[i], `${path}.pivot[${i}]`, -4096, 4096))) : Array(frames).fill(pair(layer.pivot, `${path}.pivot`, -4096, 4096));
    }
    Object.assign(out, { points, pivots, length: integer(layer.length ?? 3, `${path}.length`, 1, 16), width: t('width', 4, 0, 64), taper: tween(layer.taper ?? [0, 1], `${path}.taper`, 0, 2), fade: number(layer.fade ?? 0.5, `${path}.fade`, 0, 1) });
  }
  if (kind === 'ring' || kind === 'burst' || kind === 'aura') out.noiseAt = ditherThreshold('value', [0, 0], out.seed, out.scale);
  else {
    // The other kinds take noise in screen space, moving with the layer, so a falling power breaks them up. Scales are
    // whole pixels, as the dither op's are: craft keeps one noise table per scale for the life of the process.
    Object.assign(out, { ...noisy(0), scale: integer(layer.scale ?? 4, `${path}.scale`, 1, 64) });
    if (out.noise) out.grain = ditherThreshold('value', [0, 0], out.seed, out.scale);
    // flow moves the grain that many pixels over the window (each cycle, through two fields that take turns, when the
    // layer spans a loop), so water runs along a stream and a beam's texture streams out.
    if (layer.flow !== undefined) {
      if (!out.noise) fail(`${path}.flow`, 'flow moves the noise; give the layer noise too');
      out.flow = pair(layer.flow, `${path}.flow`, -512, 512);
      if (cycle) out.grainLater = ditherThreshold('value', [0, 0], hash(out.seed, 2), out.scale);
    }
    // A turned copy reads the grain where the drawn effect had that pixel.
    if (out.noise && view) out.unturn = view.unpoint;
  }
  // A cycling burst, aura or boiling ring boils through a second, independent field half a cycle behind the first (see boilFields).
  if ((kind === 'burst' || kind === 'aura' || kind === 'ring') && cycle && out.noise && out.boil) out.noiseLater = ditherThreshold('value', [0, 0], hash(out.seed, 1), out.scale);
  // A layer spanning a loop wraps what it reads at the end of each frame round the cycle: a stream's head and tail keys must
  // end where they start, and a reveal would draw the shape on again every cycle. compileEffects warns about these.
  if (cycle) out.seams = [...(kind === 'stream' ? ['head', 'tail'].filter(key => sample(out[key], 0) !== sample(out[key], 1)) : []), ...(out.reveal > 0 ? ['reveal'] : [])];
  return out;
}

// An ellipse of radii rx, ry as symbol rows: its one-pixel ring (the filled ellipse's pixels beside an empty one), or the
// whole disc.
function ellipseRows(rx, ry, disc) {
  const inside = (x, y) => (x / (rx + 0.5)) ** 2 + (y / (ry + 0.5)) ** 2 <= 1, rows = [];
  for (let y = -ry; y <= ry; y++) {
    let row = '';
    for (let x = -rx; x <= rx; x++) row += inside(x, y) && (disc || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) ? 'x' : '.';
    rows.push(row);
  }
  return rows;
}
// An aura's distance field around a sprite, measured once: for each pixel of the sprite's box widened by the reach,
// the distance to the nearest visible pixel, with distances upward divided by `rise` so the glow reaches that much
// higher (flames above a head, a short glow below the feet). Further than the reach stays Infinity. The steps it takes
// count against the compile's shared shape work (`work`), as painting does: an aura on each frame of a long animation,
// or many auras, are refused instead of measuring for minutes.
function auraField(rows, reach, rise, path, emptyOk = false, work = null) {
  const w = rows[0].length, h = rows.length, side = Math.ceil(reach), up = Math.ceil(reach * rise), W = w + 2 * side, H = h + up + side;
  const solid = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (rows[j][i] !== '.' && rows[j][i] !== ' ') solid.push([i, j]);
  if (!solid.length) { if (emptyOk) return null; fail(`${path}.symbol`, 'the symbol has no visible pixels for an aura to hug'); }
  const steps = solid.length * (2 * side + 1) * (up + side + 1);
  if (steps > 64_000_000) fail(`${path}.width`, 'this sprite with this width and rise would take too long to measure; lower width or rise');
  if (work) spendWork(work, steps, path);
  const d = new Float64Array(W * H).fill(Infinity);
  for (const [i, j] of solid) for (let b = -up; b <= side; b++) {
    const dy = b < 0 ? b / rise : b, row = (j + b + up) * W + i + side;
    for (let a = -side; a <= side; a++) { const dist = Math.sqrt(a * a + dy * dy); if (dist < d[row + a]) d[row + a] = dist; }
  }
  return { left: -side, top: -up, W, H, d };
}

// The noise a burst or aura reads this frame: one field moved `boil` pixels over a one-shot's window, or, in a cycle,
// two independent fields half a cycle apart, each moving a steady `boil` pixels per cycle, fading out as its phase
// wraps and in again after; the blend is scaled to keep the noise's spread, so the loop's last frame runs into its
// first. `boiled` sums them for one pixel, given how to read a field moved by `by` pixels; the result centres on 0.
function boilFields(layer, s) {
  if (!layer.noiseLater) return { parts: [[layer.noiseAt, layer.boil * s.q, 1]], norm: 1 };
  const a = s.p, b = a < 0.5 ? a + 0.5 : a - 0.5, wa = 1 - Math.abs(2 * a - 1), wb = 1 - wa;
  return { parts: [[layer.noiseAt, layer.boil * a, wa], [layer.noiseLater, layer.boil * b, wb]].filter(part => part[2] > 0), norm: Math.sqrt(wa * wa + wb * wb) };
}
// The grain fields a flowing layer reads this frame: one moved by `flow` over a one-shot's window (through its easing),
// or in a cycle two independent fields half a cycle apart, each moving steadily and fading out as it wraps.
function flowFields(layer, p, q) {
  const [fx, fy] = layer.flow;
  if (!layer.grainLater) return { parts: [[layer.grain, fx * q, fy * q, 1]], norm: 1 };
  const a = p, b = a < 0.5 ? a + 0.5 : a - 0.5, wa = 1 - Math.abs(2 * a - 1), wb = 1 - wa;
  return { parts: [[layer.grain, fx * a, fy * a, wa], [layer.grainLater, fx * b, fy * b, wb]].filter(part => part[3] > 0), norm: Math.sqrt(wa * wa + wb * wb) };
}
function flowing({ parts, norm }, gx, gy) {
  let sum = 0;
  for (const [field, sx, sy, weight] of parts) sum += weight * (field(256 + gx - sx, 256 + gy - sy) - 0.5);
  return clamp01(0.5 + sum / norm);
}
function boiled({ parts, norm }, read) {
  let sum = 0;
  for (const [field, by, weight] of parts) sum += weight * (read(field, by) - 0.5);
  return sum / norm;
}

/** Reads an effect's looks, layers and cleanup; null when it has no layers. */
export function readShapes(effect, path, context) {
  const blobs = Array.isArray(effect.emitters) && effect.emitters.some(emitter => isObject(emitter) && emitter.blob !== undefined);
  if (effect.layers === undefined && !blobs) {
    for (const key of ['looks', 'cleanup']) if (effect[key] !== undefined) fail(`${path}.${key}`, `${key} colours shape layers and blob particles; add layers too`);
    return null;
  }
  const { palette, seed, frames, loop, symbols, sequences, view, work } = context;
  if (effect.looks === undefined && effect.layers === undefined) fail(`${path}.looks`, 'blob particles are drawn into the effect\'s looks; add looks: named colour ramps');
  if (!isObject(effect.looks) || !Object.keys(effect.looks).length || Object.keys(effect.looks).length > LIMITS.looks) fail(`${path}.looks`, `expected 1–${LIMITS.looks} named looks: colour ramps that cut the layers' fields into bands, drawn in order`);
  const looks = Object.entries(effect.looks).map(([name, look]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) fail(`${path}.looks.${name}`, 'expected a name of letters, digits, hyphens or underscores, starting with a letter');
    return { name, ...readLook(look, `${path}.looks.${name}`, palette, seed) };
  });
  if (effect.layers !== undefined && (!Array.isArray(effect.layers) || !effect.layers.length || effect.layers.length > LIMITS.layers)) fail(`${path}.layers`, `expected 1–${LIMITS.layers} shape layers`);
  const layers = (effect.layers ?? []).map((layer, i) => readLayer(layer, `${path}.layers[${i}]`, { frames, seed, loop, symbols, sequences, view, work, lookNames: looks.map(l => l.name) }, i));
  let cleanup = { strays: false, corners: false };
  if (effect.cleanup !== undefined) {
    fields(effect.cleanup, ['strays', 'corners'], `${path}.cleanup`);
    for (const key of ['strays', 'corners']) if (effect.cleanup[key] !== undefined && typeof effect.cleanup[key] !== 'boolean') fail(`${path}.cleanup.${key}`, 'expected true or false');
    cleanup = { strays: effect.cleanup.strays === true, corners: effect.cleanup.corners === true };
  }
  return { looks, layers, cleanup };
}

// ---- Painting ------------------------------------------------------------------------------------------------------
// The layer's own frame: local (u, v) undoes its tilt and squash around its centre, so a squashed ring lies on the
// ground and a tilted slash cuts on a diagonal.
function frameOf(layer, cx, cy) {
  const c = cosDeg(layer.tilt), s = sinDeg(layer.tilt), [sx, sy] = layer.squash;
  return {
    local: (x, y) => { const dx = x - cx, dy = y - cy; return [(dx * c + dy * s) / sx, (-dx * s + dy * c) / sy]; },
    screen: (u, v) => { const X = u * sx, Y = v * sy; return [cx + X * c - Y * s, cy + X * s + Y * c]; },
    reach: Math.max(sx, sy)
  };
}

// Area shapes: value(u, v) at every pixel within `bound` screen pixels of the centre.
function paintArea(put, width, height, cx, cy, bound, frame, value) {
  const y0 = Math.max(0, Math.floor(cy - bound)), y1 = Math.min(height - 1, Math.ceil(cy + bound));
  const x0 = Math.max(0, Math.floor(cx - bound)), x1 = Math.min(width - 1, Math.ceil(cx + bound));
  if (x0 > x1 || y0 > y1) return;
  put.spend((x1 - x0 + 1) * (y1 - y0 + 1));
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const [u, v] = frame.local(i, j), amount = value(u, v, i, j);
    if (amount > 0) put(i, j, amount);
  }
}

// One ink pixel: a core disc of `core` pixels radius at `value` and a glow `glow` pixels beyond it at a fraction of
// it. `keep(x, y)` may hide pixels (a reveal).
// Only the part on the canvas is visited: put drops the rest anyway.
function dab(put, x, y, value, core, glow, keep) {
  const reach = Math.ceil(core + glow);
  const x0 = Math.max(-reach, -x), x1 = Math.min(reach, put.width - 1 - x), y0 = Math.max(-reach, -y), y1 = Math.min(reach, put.bottom - y);
  if (x0 > x1 || y0 > y1 || !keep(x, y)) return;
  put.spend((x1 - x0 + 1) * (y1 - y0 + 1));
  for (let dy = y0; dy <= y1; dy++) for (let dx = x0; dx <= x1; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 <= core * core + 0.5) put(x + dx, y + dy, value);
    else if (glow > 0) {
      const d = Math.sqrt(d2) - core;
      if (d <= glow + 0.5) put(x + dx, y + dy, value * 0.45 * (1 - d / (glow + 1.5)));
    }
  }
}
// Ink: a polyline one pixel wide (Bresenham between rounded points), every pixel dabbed.
function ink(put, points, value, core, glow, keep = () => true) {
  const stamp = (x, y) => dab(put, x, y, value, core, glow, keep);
  for (let k = 0; k + 1 < points.length; k++) {
    const x0 = round(points[k][0]), y0 = round(points[k][1]), x1 = round(points[k + 1][0]), y1 = round(points[k + 1][1]);
    // The walk itself costs a step per pixel, on the canvas or off it.
    put.spend(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1);
    traceLine(x0, y0, x1, y1, stamp);
  }
  if (points.length === 1) stamp(round(points[0][0]), round(points[0][1]));
}

// A jagged path from a to b: midpoint displacement across the straight line, `jag` times each piece's length at most.
function zigzag(ax, ay, bx, by, segment, jag, salt) {
  const dx = bx - ax, dy = by - ay, length = Math.sqrt(dx * dx + dy * dy) || 1, px = -dy / length, py = dx / length;
  let n = 1;
  while (length / n > segment && n < 64) n *= 2;
  const offset = new Float64Array(n + 1);
  for (let step = n; step > 1; step /= 2) for (let i = step / 2; i < n; i += step) {
    offset[i] = (offset[i - step / 2] + offset[i + step / 2]) / 2 + (random(salt, step, i) - 0.5) * jag * length * step / n;
  }
  return Array.from({ length: n + 1 }, (_, i) => [ax + dx * i / n + px * offset[i], ay + dy * i / n + py * offset[i]]);
}

// A smooth curve through 2–8 points (uniform Catmull-Rom, its ends continued straight), as a polyline of about
// one-pixel steps with the distance along it at every point.
function spline(points) {
  const n = points.length - 1, out = [points[0]], beyond = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  for (let i = 0; i < n; i++) {
    const p0 = i ? points[i - 1] : beyond(points[0], points[1]), p1 = points[i], p2 = points[i + 1], p3 = i + 2 <= n ? points[i + 2] : beyond(points[n], points[n - 1]);
    const chord = Math.sqrt((p2[0] - p1[0]) * (p2[0] - p1[0]) + (p2[1] - p1[1]) * (p2[1] - p1[1])), steps = Math.max(2, Math.ceil(chord));
    const f = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
    for (let k = 1; k <= steps; k++) { const t = k / steps; out.push([f(p0[0], p1[0], p2[0], p3[0], t), f(p0[1], p1[1], p2[1], p3[1], t)]); }
  }
  const lengths = [0];
  for (let k = 1; k < out.length; k++) { const dx = out[k][0] - out[k - 1][0], dy = out[k][1] - out[k - 1][1]; lengths.push(lengths[k - 1] + Math.sqrt(dx * dx + dy * dy)); }
  return { points: out, lengths };
}

const PAINTERS = {
  // A shockwave: a crisp leading edge at `radius` that fades inward over `width`, an optional glow filling the inside,
  // and seeded angular noise that breaks the band up.
  ring(layer, s, put, W, H) {
    const R = sample(layer.radius, s.q), w = Math.max(0.5, sample(layer.width, s.q)), fill = sample(layer.fill, s.q), rn = maxKey(layer.radius);
    // boil reads the angular noise farther out over the window, so the breaks churn instead of standing still (in a
    // cycle through two fields that take turns, seamlessly).
    const boil = layer.boil ? boilFields(layer, s) : null;
    paintArea(put, W, H, s.cx, s.cy, R * s.frame.reach + 2, s.frame, (u, v) => {
      const d = Math.sqrt(u * u + v * v);
      let value = 0;
      if (d >= R) value = 1 - (d - R) / 0.75;
      else {
        const k = (R - d) / w;
        if (k <= 1) value = 1 - 0.85 * k;
        if (fill > 0 && R > w) value = Math.max(value, fill * (0.5 + 0.5 * d / (R - w)));
      }
      if (s.noise > 0 && value > 0 && d > 0) value *= 1 - s.noise * (boil ? clamp01(0.5 + boiled(boil, (field, by) => field(256 + u / d * (rn + by), 256 + v / d * (rn + by)))) : layer.noiseAt(256 + u / d * rn, 256 + v / d * rn));
      return value;
    });
  },
  // A crescent whose outer edge is a crisp arc at `radius`: the head sweeps `arc` over the first `reveal` share of the
  // frames and the tail chases it over the rest, the band thickest mid-arc and pointed at both ends, brightest at the
  // outer edge and dimming toward the tail. A cycling slash stays whole, since a sweep would vanish at the loop point and
  // pop back (one that asks for a reveal still draws on).
  slash(layer, s, put, W, H) {
    const R = sample(layer.radius, s.q), w = sample(layer.width, s.q), [from, to] = layer.arc, span = Math.abs(to - from), clockwise = to > from;
    const head = layer.reveal ? ease('out', clamp01(s.end / layer.reveal)) : 1, tail = layer.reveal < 1 && !(layer.cycle && !layer.reveal) ? clamp01((s.p - layer.reveal) / (1 - layer.reveal)) : 0;
    paintArea(put, W, H, s.cx, s.cy, R * s.frame.reach + 2, s.frame, (u, v) => {
      const d = Math.sqrt(u * u + v * v), inside = R - d;
      if (inside < -0.5 || inside > w + 0.5) return 0;
      const theta = atan2Deg(v, u);
      let a = (clockwise ? theta - from : from - theta) % 360;
      if (a < 0) a += 360;
      const along = a / span;
      if (along > head || along < tail || along > 1) return 0;
      const thickness = w * Math.sqrt(4 * along * (1 - along)) * clamp01((head - along) / 0.12) * clamp01((along - tail) / 0.25);
      // Brightest at the head, dimmer toward the tail; brightest on the outer edge, dimmer toward the inner one.
      const lead = head > tail ? 0.5 + 0.5 * (along - tail) / (head - tail) : 1;
      if (inside <= 0.5) return lead;
      return inside <= thickness ? lead * (1 - 0.6 * inside / Math.max(thickness, 1)) : 0;
    });
  },
  // A straight beam from `at` to `to`: the head shoots out over the first `reveal` share, the width ripples with
  // travelling waves, and the value falls from 1 on the axis to 0 at the edge, with round caps, and by `fade` from the
  // origin to the far end (a pillar of light that thins out upward). `squash` and `tilt` shape the caps alone, so a
  // pillar given its circle's squash stands on a foot that lies on the same ground.
  beam(layer, s, put, W, H) {
    // A beam whose far end is its start is just its round cap (a direction of [0, 0] filled its whole box).
    const ax = s.cx, ay = s.cy, bx = layer.to[0] + s.dx, by = layer.to[1] + s.dy, ex = bx - ax, ey = by - ay, length = Math.sqrt(ex * ex + ey * ey), L = length || 1;
    const ux = length ? ex / L : 1, uy = length ? ey / L : 0, w = sample(layer.width, s.q) / 2, head = (layer.reveal ? ease('out', clamp01(s.end / layer.reveal)) : 1) * L;
    if (w <= 0) return;
    const half = along => Math.max(0.6, w * (1 + layer.wobble * sinDeg(360 * (along / layer.wavelength - layer.waves * s.p))));
    const [sx, sy] = layer.squash, c = cosDeg(layer.tilt), sn = sinDeg(layer.tilt);
    const cap = (px, py) => { const u = (px * c + py * sn) / sx, v = (-px * sn + py * c) / sy; return Math.sqrt(u * u + v * v); };
    const margin = w * (1 + layer.wobble) * s.frame.reach + 2;
    const x0 = Math.max(0, Math.floor(Math.min(ax, ax + ux * head) - margin)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, ax + ux * head) + margin));
    const y0 = Math.max(0, Math.floor(Math.min(ay, ay + uy * head) - margin)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, ay + uy * head) + margin));
    if (x0 > x1 || y0 > y1) return;
    put.spend((x1 - x0 + 1) * (y1 - y0 + 1));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const dx = i - ax, dy = j - ay, along = dx * ux + dy * uy;
      let distance, hw;
      if (along < 0) { distance = cap(dx, dy); hw = half(0); }
      else if (along > head) { distance = cap(i - (ax + ux * head), j - (ay + uy * head)); hw = half(head); }
      else { distance = Math.abs(dx * uy - dy * ux); hw = half(along); }
      if (distance < hw) put(i, j, (1 - distance / hw) * (1 - layer.fade * clamp01(along / L)));
    }
  },
  // Lightning: a jagged one-pixel core from `at` to `to` with a glow, seeded branches that dim toward their ends, and
  // a new path every `reroll` frames.
  bolt(layer, s, put) {
    // A layer spanning a loop rerolls round its cycle, so the frame after the last draws frame 0's path again.
    const rolls = layer.cycle && layer.reroll ? Math.ceil((layer.t1 - layer.t0) / layer.reroll) : 0, roll = layer.reroll ? Math.floor(s.k / layer.reroll) % (rolls || Infinity) : 0, ax = s.cx, ay = s.cy, bx = layer.to[0] + s.dx, by = layer.to[1] + s.dy;
    const core = (Math.max(1, sample(layer.width, s.q)) - 1) / 2, glow = sample(layer.glow, s.q);
    const main = zigzag(ax, ay, bx, by, layer.segment, layer.jag, hash(layer.seed, roll, 1));
    const shown = layer.reveal ? Math.max(1, Math.ceil(ease('out', clamp01(s.end / layer.reveal)) * (main.length - 1))) : main.length - 1;
    ink(put, main.slice(0, shown + 1), 1, core, glow);
    const heading = atan2Deg(by - ay, bx - ax), length = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    // Branch roots spread evenly down the bolt with seeded jitter, turning to alternate sides, so they never bunch.
    const side = random(layer.seed, roll, 0) < 0.5 ? -1 : 1;
    for (let b = 0; b < layer.branches; b++) {
      const r = salt => random(layer.seed, roll, b, salt), root = Math.floor((main.length - 1) * (0.12 + 0.66 * (b + r(1)) / layer.branches));
      if (root > shown) continue;
      const turn = (32 + 33 * r(2)) * (b % 2 ? -side : side), reach = length * (0.18 + 0.22 * r(4)), [rx, ry] = main[root];
      const path = zigzag(rx, ry, rx + cosDeg(heading + turn) * reach, ry + sinDeg(heading + turn) * reach, layer.segment * 0.75, layer.jag * 1.2, hash(layer.seed, roll, b, 2));
      for (let k = 0; k + 1 < path.length; k++) ink(put, [path[k], path[k + 1]], 0.85 - 0.35 * k / path.length, Math.max(0, core - 0.5), glow * 0.75);
    }
  },
  // A magic circle drawn in one-pixel ink: an outer ring (doubled on request), an inner ring, seeded upright runes
  // between them that travel round with `spin`, and an optional star polygon inside that turns the other way. It draws
  // on clockwise from the top over the first `reveal` share of the frames.
  glyph(layer, s, put, W, H) {
    const R = sample(layer.radius, s.q), Ri = R * layer.inner, spin = sample(layer.spin, s.q), glow = sample(layer.glow, s.q), fill = sample(layer.fill, s.q);
    const sweep = layer.reveal ? 360 * clamp01(s.end / layer.reveal) : 360;
    const keep = sweep >= 360 ? () => true : (x, y) => { const [u, v] = s.frame.local(x, y); let a = atan2Deg(v, u) + 90; if (a >= 360) a -= 360; return a <= sweep; };
    const toScreen = ([u, v]) => s.frame.screen(u, v);
    // A circle of local radius r, drawn `inset` screen pixels inside itself along its screen normal, so a doubled ring
    // stays two pixels apart all round even when squashed.
    const [sx, sy] = layer.squash, c = cosDeg(layer.tilt), sn = sinDeg(layer.tilt);
    const circle = (r, inset = 0) => {
      const n = Math.max(16, Math.ceil(2 * PI * r * s.frame.reach / 2.5));
      return Array.from({ length: n + 1 }, (_, i) => {
        const cos = cosDeg(360 * i / n), sin = sinDeg(360 * i / n), [x, y] = toScreen([cos * r, sin * r]);
        if (!inset) return [x, y];
        const nx = cos / sx, ny = sin / sy, length = Math.sqrt(nx * nx + ny * ny);
        return [x - inset * (nx * c - ny * sn) / length, y - inset * (nx * sn + ny * c) / length];
      });
    };
    if (fill > 0) paintArea(put, W, H, s.cx, s.cy, R * s.frame.reach + 1, s.frame, (u, v, i, j) => (u * u + v * v < (R - 0.5) * (R - 0.5) && keep(i, j) ? fill : 0));
    ink(put, circle(R), 1, 0, glow, keep);
    if (layer.double) ink(put, circle(R, 2), 0.85, 0, glow, keep);
    ink(put, circle(Ri), 0.9, 0, glow, keep);
    // Runes sit halfway across the band between the rings, upright, each a seeded mark.
    const middle = (R + Ri) / 2;
    for (let k = 0; k < layer.runes; k++) {
      const theta = spin + 360 * k / layer.runes - 90, [x, y] = toScreen([cosDeg(theta) * middle, sinDeg(theta) * middle]), X = round(x), Y = round(y);
      RUNES[hash(layer.seed, k) % RUNES.length].forEach((row, j) => { for (let i = 0; i < 3; i++) if (row[i] === 'x') dab(put, X + i - 1, Y + j - 1, 0.8, 0, glow, keep); });
    }
    if (layer.points) {
      const corner = i => { const theta = -spin + 360 * i / layer.points - 90; return toScreen([cosDeg(theta) * Ri, sinDeg(theta) * Ri]); };
      for (let i = 0; i < layer.points; i++) ink(put, [corner(i), corner((i + layer.step) % layer.points)], 0.7, 0, glow, keep);
    }
  },

  // An impact star: `points` spikes, every other one `ratio` as long, tapering from `width` to a one-pixel point and
  // dimming toward their tips, around a bright core disc.
  star(layer, s, put, W, H) {
    const R = sample(layer.radius, s.q), w = sample(layer.width, s.q), C = sample(layer.core, s.q), turn = layer.angle + sample(layer.spin, s.q);
    const spikes = Array.from({ length: layer.points }, (_, k) => {
      const theta = turn + 360 * k / layer.points;
      return [cosDeg(theta), sinDeg(theta), R * (k % 2 ? layer.ratio : 1) * (1 - layer.jitter * random(layer.seed, k))];
    });
    paintArea(put, W, H, s.cx, s.cy, R * s.frame.reach + 2, s.frame, (u, v) => {
      const d = Math.sqrt(u * u + v * v);
      let value = C > 0 && d <= C ? 1 - 0.25 * d / C : 0;
      for (const [cx, cy, L] of spikes) {
        const along = u * cx + v * cy;
        if (along <= 0 || along >= L) continue;
        const across = Math.abs(u * cy - v * cx), half = Math.max(0.5, w * (1 - along / L));
        if (across <= half) value = Math.max(value, (1 - 0.7 * along / L) * (1 - 0.5 * across / half));
      }
      return value;
    });
  },
  // A fireball: a disc whose edge and inside are broken by seeded smooth noise that boils outward over the frames, hot
  // in the middle, with a hole that can open from the centre (`hole`, a share of the radius) as it burns out. In a
  // cycle the noise boils on steadily through the loop point (boilFields).
  burst(layer, s, put, W, H) {
    const R = sample(layer.radius, s.q), hole = sample(layer.hole, s.q) * R, n = s.noise, boil = boilFields(layer, s);
    if (R <= 0) return;
    paintArea(put, W, H, s.cx, s.cy, R * (1 + n / 2) * s.frame.reach + 2, s.frame, (u, v) => {
      const d = Math.sqrt(u * u + v * v);
      const noise = n <= 0 ? 0 : boiled(boil, (field, by) => { const pull = d > 0 ? Math.max(0, d - by) / d : 0; return field(256 + u * pull, 256 + v * pull); });
      let value = 1 - d / (R * (1 + n * noise)) + n * 0.35 * noise;
      if (hole > 0) value *= clamp01((d - hole * (1 + n * noise)) / Math.max(1, 0.35 * R));
      return value;
    });
  },
  // A glow hugging a sprite: brightest on it, falling to nothing about `width` pixels out (`rise` times as far upward), with
  // seeded noise stretched upright and rising `boil` pixels over the window, so its edge licks up in flames. In a cycle
  // the noise rises steadily through the loop point (boilFields). `at` is the sprite's top-left corner.
  aura(layer, s, put) {
    const reach = sample(layer.width, s.q), field = sequenceFrame(layer.fields, s.f, layer.loop), n = s.noise, boil = boilFields(layer, s);
    if (reach <= 0 || !field) return;
    const { left, top, W, H, d } = field;
    const ox = round(s.cx) + left, oy = round(s.cy) + top;
    const x0 = Math.max(0, ox), x1 = Math.min(put.width - 1, ox + W - 1), y0 = Math.max(0, oy), y1 = Math.min(put.bottom, oy + H - 1);
    if (x0 > x1 || y0 > y1) return;
    put.spend((x1 - x0 + 1) * (y1 - y0 + 1));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const dist = d[(j - oy) * W + i - ox];
      if (!(dist < reach * (1 + n / 2))) continue;
      // The noise is read in the layer's own frame, so a drifting sprite carries its flames along.
      const u = i - ox + 256, v = j - oy + 256;
      // As in a burst, the noise moves the edge in and out (tongues reach past the plain glow) and breaks up the bands.
      const noise = n <= 0 ? 0 : boiled(boil, (field, by) => field(u, (v + by) / layer.rise));
      put(i, j, 1 - dist / (reach * (1 + n * noise)) + 0.25 * n * noise);
    }
  },
  // A tapered body of water (or anything that flows): the part of a smooth curve between `tail` and `head` (shares of
  // its length), `width` across at most, narrowing by `taper` from tail to head, brightest on its centre line, and
  // swaying sideways in travelling waves that grow toward the far end. Head and tail count to the end of each frame,
  // as reveals do.
  stream(layer, s, put) {
    const { points, lengths } = layer.curve, L = lengths[lengths.length - 1], at = ease(layer.ease, s.end);
    const tail = clamp01(sample(layer.tail, at)) * L, head = clamp01(sample(layer.head, at)) * L, span = head - tail, w = sample(layer.width, s.q) / 2;
    if (span < 0.5 || w <= 0) return;
    put.spend(Math.floor((head + 1e-9 - tail) / 0.5) + 1);
    let k = 0;
    for (let d = tail; d <= head + 1e-9; d += 0.5) {
      while (k < lengths.length - 2 && lengths[k + 1] < d) k++;
      const a = points[k], b = points[k + 1], piece = lengths[k + 1] - lengths[k] || 1, f = (d - lengths[k]) / piece, tx = (b[0] - a[0]) / piece, ty = (b[1] - a[1]) / piece;
      let x = a[0] + (b[0] - a[0]) * f + s.dx, y = a[1] + (b[1] - a[1]) * f + s.dy;
      if (layer.sway) { const off = layer.sway * (d / L) * sinDeg(360 * (d / layer.wavelength - layer.waves * s.p)); x -= ty * off; y += tx * off; }
      // Each step stamps a cone a little wider than its half width, so even a one-pixel tip keeps its pixels.
      // fade dims it toward the far end of its curve, as a beam's does, so a tail cools and its tip is not a bright line.
      cone(put, x, y, Math.max(0.6, w * sample(layer.taper, (d - tail) / span)) + 0.5, layer.fade ? 1 - layer.fade * d / L : 1);
    }
  },
  // A smear behind a moving point (a sword tip): a stroke along a smooth curve through where the point was over the last
  // `length` frames, tapered by `taper` from its oldest end to its newest and dimming by `fade` toward the oldest.
  // `points` hold the point's place in each frame of the effect, relative to `at`; the frames before the layer's window
  // count too, so a smear drawn from the strike on still shows the wind-up behind it.
  // With pivots, each step between two frames is an arc round the pivot (angle and distance moving evenly), and the
  // stroke lies inside the point's path, so its outer edge is where the tip went: a blade's crescent smear.
  // A trail spanning a loop reads its places round the cycle (each at most once), so frame 0 still shows the smear of
  // the last frames and the frame after the last is frame 0 again.
  trail(layer, s, put) {
    const path = [], centres = [], n = layer.points.length;
    for (let f = layer.cycle ? s.f - Math.min(layer.length, n - 1) : Math.max(0, s.f - layer.length); f <= s.f; f++) {
      const at = layer.cycle ? ((f % n) + n) % n : f, p = layer.points[at];
      if (!p) continue;
      const x = p[0] + s.cx, y = p[1] + s.cy, last = path[path.length - 1], c = layer.pivots?.[at];
      if (!last || last[0] !== x || last[1] !== y) { path.push([x, y]); centres.push(c ? [c[0] + s.cx, c[1] + s.cy] : null); }
    }
    const w = sample(layer.width, s.q) / 2;
    if (path.length < 2 || w <= 0) return;
    const curve = layer.pivots ? arcs(path, centres) : spline(path), { points, lengths } = curve, L = lengths[lengths.length - 1];
    put.spend(Math.floor(L / 0.5) + 1);
    let k = 0;
    for (let d = 0; d <= L + 1e-9; d += 0.5) {
      while (k < lengths.length - 2 && lengths[k + 1] < d) k++;
      const a = points[k], b = points[k + 1], piece = lengths[k + 1] - lengths[k] || 1, f = (d - lengths[k]) / piece, share = d / L;
      const hw = Math.max(0.6, w * sample(layer.taper, share)) + 0.5;
      let x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
      // Inward toward the pivot by all but half a pixel of the half width, so the outer edge stays on the path.
      const c = curve.centres?.[k];
      if (c) { const ux = x - c[0], uy = y - c[1], r = Math.sqrt(ux * ux + uy * uy); if (r > 1e-9) { x -= ux / r * (hw - 0.5); y -= uy / r * (hw - 0.5); } }
      cone(put, x, y, hw, 1 - layer.fade * (1 - share));
    }
  }
};

// A trail's path through `points` with a pivot for each (or null): each step between two points runs round the average
// of their pivots, angle and distance moving evenly (the shorter way round), or straight where either has none. About a
// pixel per sample, with the distance along it and the pivot of the step each sample begins.
function arcs(points, centres) {
  const out = [points[0]], at = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[i + 1], ca = centres[i], cb = centres[i + 1];
    if (!ca || !cb) { out.push([bx, by]); at.push(null); continue; }
    const cx = (ca[0] + cb[0]) / 2, cy = (ca[1] + cb[1]) / 2, ra = Math.sqrt((ax - cx) ** 2 + (ay - cy) ** 2), rb = Math.sqrt((bx - cx) ** 2 + (by - cy) ** 2);
    const from = atan2Deg(ay - cy, ax - cx);
    let turn = atan2Deg(by - cy, bx - cx) - from;
    if (turn > 180) turn -= 360; else if (turn <= -180) turn += 360;
    const steps = Math.max(1, Math.ceil(Math.abs(turn) * PI / 180 * Math.max(ra, rb)));
    for (let k = 1; k <= steps; k++) { const u = k / steps, r = ra + (rb - ra) * u, theta = from + turn * u; out.push([cx + cosDeg(theta) * r, cy + sinDeg(theta) * r]); at.push([cx, cy]); }
  }
  const lengths = [0];
  for (let k = 1; k < out.length; k++) { const dx = out[k][0] - out[k - 1][0], dy = out[k][1] - out[k - 1][1]; lengths.push(lengths[k - 1] + Math.sqrt(dx * dx + dy * dy)); }
  return { points: out, lengths, centres: at };
}

// One step of a brush: a cone `hw` pixels in radius at (x, y), 1 in its middle falling to 0 at its rim, times `scale`.
// Only the part on the canvas is visited: put drops the rest anyway.
function cone(put, x, y, hw, scale) {
  const reach = Math.ceil(hw), X = round(x), Y = round(y), i0 = Math.max(0, X - reach), i1 = Math.min(put.width - 1, X + reach), j0 = Math.max(0, Y - reach), j1 = Math.min(put.bottom, Y + reach);
  if (i0 > i1 || j0 > j1) return;
  put.spend((i1 - i0 + 1) * (j1 - j0 + 1));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const dx = i - x, dy = j - y, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < hw) put(i, j, (1 - dist / hw) * scale);
  }
}

// The look's field at (x, y), between pixels, zero off the canvas.
function between(field, width, height, x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const v = (a, b) => (a >= 0 && b >= 0 && a < width && b < height ? field[b * width + a] : 0);
  return (v(i, j) * (1 - fx) + v(i + 1, j) * fx) * (1 - fy) + (v(i, j + 1) * (1 - fx) + v(i + 1, j + 1) * fx) * fy;
}
function band(value, thresholds) {
  let level = 0;
  while (level < thresholds.length && value >= thresholds[level]) level++;
  return level;
}

/**
 * The shape grid for frame `f`: { x, y, rows } cropped to its drawn pixels, or null. It holds the looks whose `front`
 * is `front`: the effect draws one grid under its particles and, when a look asks, one over them. `blobs` are this frame's blob
 * particles, { look, x, y, radius, power }: each adds a soft disc, (1 − d²/r²)² times its power (default 1), to its look's field, so drops that touch merge
 * into one body. `work` counts the pixels painting visits across one compile (pass the same object for every frame and
 * effect); past SHAPE_WORK the layer that crosses it is refused.
 */
// With `split`, each drawn pixel also gets a side, 1 behind a character and 2 in front: a look's pixel takes the side of
// the layer or blob that gave it the most, cleanup's fills and outlines the side of the pixel beside them, and halos
// that of the nearest pixel they glow from. The result then has `parts`, the back and front pixels as grids of their
// own, which together are exactly the whole.
// With `wrap`, a loop's frame count, frame `wrap` is the one after the loop's last, for reviewing its seam: a layer
// spanning the loop goes on to the end of its cycle (progress 1), and any other draws as it does in frame 0.
export function renderShapes(shapes, f, width, height, blobs = [], work = { spent: 0 }, front = false, split = false, wrap = 0) {
  const N = width * height, chars = new Uint16Array(N), owner = new Uint8Array(N), side = split ? new Uint8Array(N) : null;
  let drawn = false;
  shapes.looks.forEach((look, lookIndex) => {
    if (look.front !== front) return;
    const field = new Float64Array(N), scratch = new Float64Array(N), best = split ? new Float64Array(N) : null, from = split ? new Uint8Array(N) : null;
    let any = false;
    for (const layer of shapes.layers) {
      const g = wrap && f >= wrap && !layer.cycle ? f - wrap : f;
      if (layer.look !== look.name || g < layer.t0 || g > layer.t1 || (g === layer.t1 && !(wrap && layer.cycle))) continue;
      const k = g - layer.t0, p = k / (layer.t1 - layer.t0), q = ease(layer.ease, p);
      const power = sample(layer.power, q) * (layer.flicker && k % 2 ? 1 - layer.flicker : 1), noise = sample(layer.noiseKeys, q);
      if (power <= 0) continue;
      const along = layer.curved ? curveSample : sample;
      const walked = layer.walk ? layer.walk(q) : null;
      const dx = walked ? walked[0] : layer.driftKeys ? along(layer.driftKeys[0], q) : layer.drift[0] * q, dy = walked ? walked[1] : layer.driftKeys ? along(layer.driftKeys[1], q) : layer.drift[1] * q, cx = layer.at[0] + dx, cy = layer.at[1] + dy;
      scratch.fill(0);
      // A floor cuts the layer off below its row: a disc becomes a dome, a ring an arch.
      const bottom = layer.floor === null ? height - 1 : Math.min(height - 1, Math.floor(layer.floor));
      const put = (i, j, value) => { if (i >= 0 && j >= 0 && i < width && j <= bottom) { const c = j * width + i; if (value > scratch[c]) scratch[c] = value; } };
      // Painters visit only the canvas (width × rows down to bottom) and count what they visit.
      put.width = width; put.bottom = bottom;
      put.spend = n => spendWork(work, n, layer.path);
      // Reveals measure to the end of the frame, so the first frame of a window already shows the shape under way.
      // A keyed squash draws this frame's squash through a copy of the layer, so painters read it as they always have.
      const flow = layer.flow ? flowFields(layer, p, q) : null;
      const shaped = layer.squashKeys ? { ...layer, squash: [sample(layer.squashKeys[0], q), sample(layer.squashKeys[1], q)] } : layer;
      // What a painter reads at the end of the frame (a stream's head and tail, a reveal) wraps round a cycle as well.
      const end = (k + 1) / (layer.t1 - layer.t0);
      PAINTERS[layer.kind](shaped, { k, p, end: wrap && layer.cycle && end > 1 ? end - 1 : end, q, cx, cy, dx, dy, f: g, noise, frame: frameOf(shaped, cx, cy) }, put, width, height);
      for (let c = 0; c < N; c++) {
        let value = scratch[c] * power;
        if (value <= 0) continue;
        if (layer.grain) {
          // In a turned copy the grain turns too, so every direction breaks up as the drawn one does.
          const [gx, gy] = layer.unturn ? layer.unturn([c % width - dx, Math.floor(c / width) - dy]) : [c % width - round(dx), Math.floor(c / width) - round(dy)];
          value *= 1 - noise * (flow ? flowing(flow, gx, gy) : layer.grain(256 + gx, 256 + gy));
        }
        field[c] = layer.blend === 'add' ? field[c] + value : Math.max(field[c], value);
        if (split && value > best[c]) { best[c] = value; from[c] = layer.depth === 'back' || (layer.depth === 'split' && Math.floor(c / width) < cy) ? 1 : 2; }
        any = true;
      }
    }
    for (const blob of blobs) {
      if (blob.look !== look.name) continue;
      const r = blob.radius, r2 = r * r;
      const x0 = Math.max(0, Math.ceil(blob.x - r)), x1 = Math.min(width - 1, Math.floor(blob.x + r)), y0 = Math.max(0, Math.ceil(blob.y - r)), y1 = Math.min(height - 1, Math.floor(blob.y + r));
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const dx = i - blob.x, dy = j - blob.y, d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const k = 1 - d2 / r2, value = blob.power === undefined ? k * k : k * k * blob.power, c = j * width + i;
        field[c] += value;
        if (split && value > best[c]) { best[c] = value; from[c] = blob.back ? 1 : 2; }
        any = true;
      }
    }
    if (!any) return;
    const { thresholds, gaps, codes, dither, threshold, lit, shade, light: [lx, ly], reach } = look;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const c = j * width + i, value = field[c];
      if (value < thresholds[0] - dither * gaps[0]) continue;
      const feather = (1 - threshold(i, j)) * dither;
      let level = 0;
      while (level < thresholds.length && value >= thresholds[level] - feather * gaps[level]) level++;
      if (!level) continue;
      let code = codes[level - 1];
      // Lit and shade bands recolour the look's own pixels by how far its field falls two pixels toward the light
      // (and away from it): a highlight on the rim that faces the light, a shadow side opposite.
      if (shade) { const s = band(1 - between(field, width, height, i - reach * lx, j - reach * ly) / value, shade.thresholds); if (s) code = shade.codes[s - 1]; }
      if (lit) { const s = band(1 - between(field, width, height, i + reach * lx, j + reach * ly) / value, lit.thresholds); if (s) code = lit.codes[s - 1]; }
      chars[c] = code; owner[c] = lookIndex + 1; drawn = true;
      if (split) side[c] = from[c] || 2;
    }
  });
  if (!drawn) return null;
  if (shapes.cleanup.strays || shapes.cleanup.corners) for (const change of cleanupIds(chars, width, height, shapes.cleanup)) chars[change.index] = change.id;
  // A hole cleanup filled takes the side of a drawn pixel beside it.
  if (split) for (let c = 0; c < N; c++) {
    if (!chars[c] || side[c]) continue;
    const i = c % width, j = (c - i) / width;
    for (let dy = -1; dy <= 1 && !side[c]; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = i + dx, y = j + dy, n = y * width + x;
      if ((dx || dy) && x >= 0 && y >= 0 && x < width && y < height && chars[n] && side[n]) { side[c] = side[n]; break; }
    }
    if (!side[c]) side[c] = 2;
  }
  // Each look's outline takes the empty pixels beside its own, in look order: only those still drawn after cleanup, so a
  // stray it removed leaves no outline behind.
  const filled = owner.map((look, c) => (chars[c] ? look : 0)), haloed = shapes.looks.some(look => look.halo && look.front === front), rim = haloed ? new Uint8Array(N) : null;
  shapes.looks.forEach((look, lookIndex) => {
    if (!look.outline || look.front !== front) return;
    const mine = lookIndex + 1;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const c = j * width + i;
      if (chars[c]) continue;
      const beside = i > 0 && filled[c - 1] === mine ? c - 1 : i < width - 1 && filled[c + 1] === mine ? c + 1 : j > 0 && filled[c - width] === mine ? c - width : j < height - 1 && filled[c + width] === mine ? c + width : -1;
      if (beside >= 0) { chars[c] = look.outline; if (rim) rim[c] = mine; if (split) side[c] = side[beside]; }
    }
  });
  // Halos take the empty pixels within a round reach of each look's pixels and outline, in look order: an offset (dx, dy)
  // reaches when dx² + dy² ≤ (width + 0.5)² − 1, so one pixel wide is the four neighbours and wider halos are round.
  if (haloed) shapes.looks.forEach((look, lookIndex) => {
    if (!look.halo || look.front !== front) return;
    const mine = lookIndex + 1, { color, width: reach, dither } = look.halo, limit = (reach + 0.5) * (reach + 0.5) - 1, offsets = [];
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if ((dx || dy) && dx * dx + dy * dy <= limit) offsets.push([dx, dy]);
    // Split, a halo pixel takes the side of the nearest pixel it glows from, so the offsets are searched nearest first.
    const source = c => filled[c] === mine || rim[c] === mine, taken = [], near = split ? [...offsets].sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1]) : offsets;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const c = j * width + i;
      if (chars[c] || (dither && ((i + j) & 1))) continue;
      const hit = near.find(([dx, dy]) => { const x = i + dx, y = j + dy; return x >= 0 && y >= 0 && x < width && y < height && source(y * width + x); });
      if (hit) taken.push([c, split ? side[c + hit[1] * width + hit[0]] : 0]);
    }
    for (const [c, s] of taken) { chars[c] = color; if (split) side[c] = s; }
  });
  // The drawn pixels that pass `keep`, cropped to their bounds, or null.
  const grid = keep => {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) { const c = j * width + i; if (chars[c] && keep(c)) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; } }
    if (x1 < 0) return null;
    const rows = [];
    for (let j = y0; j <= y1; j++) {
      let row = '';
      for (let i = x0; i <= x1; i++) { const c = j * width + i, code = chars[c]; row += code && keep(c) ? String.fromCharCode(code) : '.'; }
      rows.push(row);
    }
    return { x: x0, y: y0, rows };
  };
  const whole = grid(() => true);
  if (!whole || !split) return whole;
  return { ...whole, parts: { back: grid(c => side[c] === 1), front: grid(c => side[c] !== 1) } };
}
