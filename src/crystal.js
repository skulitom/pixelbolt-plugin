// Crystal growth baked into ordinary palette grids (pixelforge-crystal). Faceted crystals (hexagonal prisms with a
// pointed or flat end, cubes, octahedra) grow out of their seeds into clusters and geodes: each is a small convex solid
// turned by its angle, tilt and turn, seen straight on, and each face it shows takes one band of its look by how much
// it faces the one light, so facets read as flat planes of light and shade. Snowflakes grow as six-armed dendrites:
// arms from a hexagonal seed, side branches sprouting behind each tip and growing toward the next arm, each stopping a
// pixel short of whatever it would touch, with mirror symmetry across both axes. Growth runs on a fixed timeline that
// eases into rest: the last frames hold a still, finished picture.
// Browser-compatible and deterministic: craft.js trigonometry, seeded hashing, + − × ÷ and sqrt only.
import { PixelError, renderProject, readRows, parseColor } from './core.js';
import { fields } from './authoring.js';
import { sinDeg, cosDeg, ease, EASINGS, random } from './craft.js';
import { atan2Deg } from './shapes.js';

export const CRYSTAL_HABITS = ['prism', 'cube', 'octahedron', 'snowflake'];
const LIMITS = { crystals: 32, total: 256, looks: 8, colors: 6 };
const MIN_LIGHT = 0.001; // the shortest light direction read: a shorter one has too little length to divide by
const fail = (path, message) => { throw new PixelError(path, message); };
const num = (v, path, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(path, `expected a number from ${min} to ${max}`);
  return v;
};
const int = (v, path, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) fail(path, `expected an integer from ${min} to ${max}`);
  return v;
};
const pair = (v, path, min, max) => {
  if (!Array.isArray(v) || v.length !== 2) fail(path, 'expected [x, y]');
  return v.map((n, i) => num(n, `${path}[${i}]`, min, max));
};
// A number, or [low, high] drawn per crystal from the effect's seed.
const span = (v, path, min, max, whole = false) => {
  const one = (n, p) => (whole ? int(n, p, min, max) : num(n, p, min, max));
  if (Array.isArray(v)) {
    if (v.length !== 2) fail(path, `expected a number or [low, high] from ${min} to ${max}`);
    const [lo, hi] = [one(v[0], `${path}[0]`), one(v[1], `${path}[1]`)];
    if (hi < lo) fail(`${path}[1]`, 'expected high at or above low');
    return [lo, hi];
  }
  const n = one(v, path);
  return [n, n];
};
const draw = ([lo, hi], u, whole = false) => (whole ? lo + Math.floor(u * (hi - lo + 1)) : lo + u * (hi - lo));
const paletteKey = (key, path, palette) => {
  if (typeof key !== 'string' || key.length !== 1 || key === '.' || key === ' ' || !Object.hasOwn(palette, key)) fail(path, 'expected a single-character key in the palette');
  return key;
};

function readLook(look, path, palette) {
  fields(look, ['colors', 'outline', 'glint'], path);
  if (!Array.isArray(look.colors) || look.colors.length < 2 || look.colors.length > LIMITS.colors) fail(`${path}.colors`, `expected 2–${LIMITS.colors} palette keys, from the darkest face to the brightest`);
  return { colors: look.colors.map((key, i) => paletteKey(key, `${path}.colors[${i}]`, palette)),
    outline: look.outline === undefined ? null : paletteKey(look.outline, `${path}.outline`, palette),
    glint: look.glint === undefined ? null : paletteKey(look.glint, `${path}.glint`, palette) };
}

const SOLID_FIELDS = ['habit', 'look', 'at', 'count', 'angle', 'toward', 'spread', 'tilt', 'turn', 'start', 'grow', 'ease'];
const SHAPE_FIELDS = { prism: ['length', 'width', 'tip', 'double'], cube: ['size'], octahedron: ['size'], snowflake: ['radius', 'spacing', 'branches', 'twigs', 'plate', 'arms'] };
// One entry of an effect's crystals: one crystal, or with `count` a seeded cluster whose bases spread along `at`.
function readEntry(entry, path, effect, looks, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(path, 'expected a crystal object');
  if (!CRYSTAL_HABITS.includes(entry.habit)) fail(`${path}.habit`, `expected ${CRYSTAL_HABITS.join(', ')}`);
  const habit = entry.habit;
  fields(entry, [...SOLID_FIELDS, ...SHAPE_FIELDS[habit]], path);
  const lookNames = Object.keys(looks);
  let look = entry.look;
  if (look === undefined) {
    if (lookNames.length !== 1) fail(`${path}.look`, `name the look that colours this crystal: ${lookNames.join(', ')}`);
    look = lookNames[0];
  } else if (typeof look !== 'string' || !Object.hasOwn(looks, look)) fail(`${path}.look`, `no look is named ${JSON.stringify(look)}; the looks are ${lookNames.join(', ')}`);
  const count = int(entry.count ?? 1, `${path}.count`, 1, 64);
  // The seeds: one point, or a line through 2–16 points (a floor, a wall, the inside of a geode) along which the
  // cluster's seeds spread evenly by length, each nudged by a seeded share of its spacing.
  let line;
  if (Array.isArray(entry.at) && Array.isArray(entry.at[0])) {
    if (entry.at.length < 2 || entry.at.length > 16) fail(`${path}.at`, 'expected [x, y], or 2–16 points [[x, y], …] for a line of seeds');
    line = entry.at.map((p, i) => pair(p, `${path}.at[${i}]`, -1024, 1024));
  } else line = [pair(entry.at, `${path}.at`, -1024, 1024)];
  const lengths = line.slice(1).map((p, i) => { const dx = p[0] - line[i][0], dy = p[1] - line[i][1]; return Math.sqrt(dx * dx + dy * dy); });
  const total = lengths.reduce((a, b) => a + b, 0);
  const along = t => {
    if (line.length === 1 || total === 0) return [line[0][0], line[0][1]];
    let d = Math.max(0, Math.min(1, t)) * total, k = 0;
    while (k < lengths.length - 1 && d > lengths[k]) { d -= lengths[k]; k++; }
    const q = lengths[k] ? d / lengths[k] : 0;
    return [line[k][0] + (line[k + 1][0] - line[k][0]) * q, line[k][1] + (line[k + 1][1] - line[k][1]) * q];
  };
  if (habit === 'snowflake') {
    for (const key of ['angle', 'toward', 'spread', 'tilt', 'turn']) if (entry[key] !== undefined) fail(`${path}.${key}`, `${key} turns a faceted crystal; a snowflake lies flat, and arms chooses its orientation`);
  }
  if (entry.angle !== undefined && entry.toward !== undefined) fail(`${path}.toward`, 'choose angle or toward, not both');
  const toward = entry.toward === undefined ? null : pair(entry.toward, `${path}.toward`, -1024, 1024);
  const spread = num(entry.spread ?? 0, `${path}.spread`, 0, 90);
  const angle = span(entry.angle ?? -90, `${path}.angle`, -360, 360);
  const tilt = span(entry.tilt ?? (habit === 'cube' ? 30 : 0), `${path}.tilt`, -80, 80);
  const turn = span(entry.turn ?? (habit === 'cube' || habit === 'octahedron' ? 45 : 0), `${path}.turn`, -360, 360);
  const start = span(entry.start ?? 0, `${path}.start`, 0, effect.frames - 1, true);
  const grow = span(entry.grow ?? Math.max(1, Math.round(effect.frames * 0.6)), `${path}.grow`, 1, 256, true);
  const easing = entry.ease ?? (habit === 'snowflake' ? 'out' : 'inOut');
  if (!EASINGS.includes(easing) || easing === 'hold') fail(`${path}.ease`, `expected ${EASINGS.filter(e => e !== 'hold').join(', ')}`);
  const shape = {};
  if (habit === 'prism') {
    shape.length = span(entry.length, `${path}.length`, 1, 256);
    shape.width = span(entry.width, `${path}.width`, 1, 64);
    shape.tip = span(entry.tip ?? 1, `${path}.tip`, 0, 3);
    if (entry.double !== undefined && typeof entry.double !== 'boolean') fail(`${path}.double`, 'expected true or false');
    shape.double = entry.double === true;
  } else if (habit === 'cube' || habit === 'octahedron') {
    shape.size = span(entry.size, `${path}.size`, 1, 128);
  } else {
    shape.radius = int(entry.radius, `${path}.radius`, 2, 64);
    shape.spacing = num(entry.spacing ?? 4, `${path}.spacing`, 2, 16);
    shape.branches = num(entry.branches ?? 0.7, `${path}.branches`, 0, 1);
    shape.twigs = num(entry.twigs ?? 0, `${path}.twigs`, 0, 1);
    shape.plate = num(entry.plate ?? 0, `${path}.plate`, 0, 32);
    if (entry.arms !== undefined && !['vertical', 'horizontal'].includes(entry.arms)) fail(`${path}.arms`, 'expected vertical (arms point up and down) or horizontal');
    shape.arms = entry.arms ?? 'vertical';
    if (count > 1) fail(`${path}.count`, 'a snowflake grows alone; give each snowflake its own entry');
  }
  // The crystals of the entry, each with its own draws. A cluster is drawn longest first, so short crystals stand in
  // front of tall ones.
  const crystals = [];
  for (let i = 0; i < count; i++) {
    const u = k => random(effect.seed, index, i, k);
    const at = along(count === 1 ? 0.5 : (i + 0.5 + (u(1) - 0.5) * 0.6) / count);
    const crystal = { habit, look, at, start: draw(start, u(2), true), grow: draw(grow, u(3), true), ease: easing,
      tilt: draw(tilt, u(4)), turn: draw(turn, u(5)), order: i };
    crystal.angle = (toward ? atan2Deg(toward[1] - at[1], toward[0] - at[0]) : draw(angle, u(6))) + spread * (u(10) - 0.5);
    if (habit === 'prism') Object.assign(crystal, { length: draw(shape.length, u(7)), width: draw(shape.width, u(8)), tip: draw(shape.tip, u(9)), double: shape.double });
    else if (habit === 'snowflake') Object.assign(crystal, shape);
    else crystal.size = draw(shape.size, u(7));
    crystals.push(crystal);
  }
  // A fan of angles follows the line: bases from the first end to the second take the angles from low to high.
  if (!toward && count > 1 && angle[1] > angle[0]) {
    const sorted = crystals.map(c => c.angle).sort((a, b) => a - b);
    crystals.forEach((c, i) => { c.angle = sorted[i]; });
  }
  if (count > 1) crystals.sort((a, b) => (b.length ?? b.size) - (a.length ?? a.size) || a.order - b.order);
  return crystals;
}

function readEffect(effect, path, source, looks) {
  fields(effect, ['frames', 'duration', 'seed', 'light', 'crystals', 'underlay', 'overlay'], path);
  const frames = int(effect.frames, `${path}.frames`, 2, 256);
  const duration = int(effect.duration ?? 80, `${path}.duration`, 20, 1000);
  const seed = int(effect.seed ?? 0, `${path}.seed`, 0, 2147483647);
  const light = effect.light === undefined ? [-1, -1] : pair(effect.light, `${path}.light`, -1, 1);
  // A direction, so it must have a length to divide by: [0, 0], or one so short its square rounds to nothing, points
  // nowhere.
  if (!(Math.sqrt(light[0] * light[0] + light[1] * light[1]) >= MIN_LIGHT)) fail(`${path}.light`, `expected a direction toward the light, such as [-1, -1] for the upper left, at least ${MIN_LIGHT} long`);
  if (!Array.isArray(effect.crystals) || !effect.crystals.length || effect.crystals.length > LIMITS.crystals) fail(`${path}.crystals`, `expected 1–${LIMITS.crystals} crystals`);
  const context = { frames, seed };
  const crystals = effect.crystals.flatMap((entry, i) => readEntry(entry, `${path}.crystals[${i}]`, context, looks, i));
  if (crystals.length > LIMITS.total) fail(`${path}.crystals`, `the counts make ${crystals.length} crystals; at most ${LIMITS.total}`);
  const decoration = key => {
    if (effect[key] === undefined) return null;
    const { rows } = readRows(effect[key], `${path}.${key}`, source.palette);
    if (rows.length !== source.height || rows[0].length !== source.width) fail(`${path}.${key}`, 'expected a full-canvas grid');
    return rows;
  };
  return { frames, duration, seed, light, crystals, underlay: decoration('underlay'), overlay: decoration('overlay') };
}

// ---- Faceted solids ----------------------------------------------------------------------------------------------
// Each habit is a convex solid in its own frame: a runs along the growth axis from the seed (a = 0), b and c across it.
const HEX = [30, 90, 150, 210, 270, 330].map(d => [sinDeg(d), cosDeg(d)]);
function solid(crystal, scale) {
  const points = [], faces = [];
  const add = (a, b, c) => points.push([a, b, c]) - 1;
  if (crystal.habit === 'prism') {
    const length = crystal.length * scale, r = Math.max(0.5, crystal.width * scale / 2);
    const tip = Math.min(crystal.tip * 2 * r, crystal.double ? length / 2 : length);
    const low = crystal.double ? tip : 0, high = Math.max(low, length - tip);
    const bottom = HEX.map(([b, c]) => add(low, b * r, c * r)), top = HEX.map(([b, c]) => add(high, b * r, c * r));
    for (let k = 0; k < 6; k++) faces.push([bottom[k], bottom[(k + 1) % 6], top[(k + 1) % 6], top[k]]);
    if (tip > 0) { const apex = add(length, 0, 0); for (let k = 0; k < 6; k++) faces.push([top[k], top[(k + 1) % 6], apex]); } else faces.push([...top]);
    if (crystal.double && tip > 0) { const apex = add(0, 0, 0); for (let k = 0; k < 6; k++) faces.push([bottom[k], bottom[(k + 1) % 6], apex]); } else faces.push([...bottom]);
  } else if (crystal.habit === 'cube') {
    const s = Math.max(1, crystal.size * scale), h = s / 2;
    for (const a of [0, s]) for (const b of [-h, h]) for (const c of [-h, h]) add(a, b, c);
    faces.push([0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]);
  } else {
    const s = Math.max(1, crystal.size * scale), h = s / 2;
    const low = add(0, 0, 0), high = add(s, 0, 0), ring = [[h, 0], [0, h], [-h, 0], [0, -h]].map(([b, c]) => add(h, b, c));
    for (let k = 0; k < 4; k++) faces.push([ring[k], ring[(k + 1) % 4], low], [ring[k], ring[(k + 1) % 4], high]);
  }
  return { points, faces };
}

// The growth axis in the picture, snapped to the nearest clean pixel slope (level, 3:1, 2:1, 1:1 and so on), so the
// long edges of a crystal run as even stairs.
const SLOPES = [[1, 0], [3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [0, 1]];
const CLEAN = [];
for (const [x, y] of SLOPES) for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
  const l = Math.sqrt(x * x + y * y), v = [sx * x / l, sy * y / l];
  if (!CLEAN.some(c => c[0] === v[0] && c[1] === v[1])) CLEAN.push(v);
}
function clean(angle) {
  const x = cosDeg(angle), y = sinDeg(angle);
  let best = -2, pick = null;
  for (const c of CLEAN) { const d = c[0] * x + c[1] * y; if (d > best + 1e-12) { best = d; pick = c; } }
  return pick;
}
// The solid turned into the picture: x right, y down, z toward the viewer. angle points the growth axis in the picture,
// tilt leans it toward the viewer, turn spins the solid about it. Returns the faces turned toward the viewer, each with
// its outline in the picture, its normal and its vertices' numbers, and the growth axis in the picture.
function place(crystal, scale) {
  const { points, faces } = solid(crystal, scale);
  const [ca, sa] = clean(crystal.angle), ct = cosDeg(crystal.tilt), st = sinDeg(crystal.tilt), cr = cosDeg(crystal.turn), sr = sinDeg(crystal.turn);
  const A = [ct * ca, ct * sa, st], B0 = [-sa, ca, 0], C0 = [-st * ca, -st * sa, ct];
  const B = B0.map((v, i) => cr * v + sr * C0[i]), C = B0.map((v, i) => -sr * v + cr * C0[i]);
  const [x0, y0] = crystal.at;
  const world = points.map(([a, b, c]) => [x0 + a * A[0] + b * B[0] + c * C[0], y0 + a * A[1] + b * B[1] + c * C[1], a * A[2] + b * B[2] + c * C[2]]);
  const centre = [0, 1, 2].map(i => world.reduce((s, p) => s + p[i], 0) / world.length);
  const shown = faces.map(face => {
    const p = face.map(i => world[i]);
    // Newell's normal, pointed away from the centre: robust for any convex face.
    let n = [0, 0, 0];
    for (let i = 0; i < p.length; i++) {
      const [ax, ay, az] = p[i], [bx, by, bz] = p[(i + 1) % p.length];
      n = [n[0] + (ay - by) * (az + bz), n[1] + (az - bz) * (ax + bx), n[2] + (ax - bx) * (ay + by)];
    }
    const length = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (length < 1e-12) return null;
    n = n.map(v => v / length);
    const mid = [0, 1, 2].map(i => p.reduce((s, q) => s + q[i], 0) / p.length);
    if ((mid[0] - centre[0]) * n[0] + (mid[1] - centre[1]) * n[1] + (mid[2] - centre[2]) * n[2] < 0) n = n.map(v => -v);
    return { points: p.map(q => [q[0], q[1]]), normal: n, vertices: face };
  }).filter(face => face && face.normal[2] > 1e-6);
  return { faces: shown, world, axis: [A[0], A[1]] };
}

// Signed distances of a point inside a convex polygon to each edge; the smallest is how far inside it is.
function inside(polygon, x, y) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) { const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length]; area += ax * by - bx * ay; }
  const sign = area < 0 ? -1 : 1;
  let least = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length], ex = bx - ax, ey = by - ay, l = Math.sqrt(ex * ex + ey * ey);
    if (l < 1e-12) continue;
    const d = sign * (ex * (y - ay) - ey * (x - ax)) / l;
    if (d < least) least = d;
  }
  return least;
}

// A crystal's pixels this frame, as their places on the canvas (y × width + x) each with the band of the face it shows
// (pixel x, y is sampled at its centre, x, y), and its lit ridge: the edge between the two faces that together catch
// the most light, from its end nearer the seed.
function paintSolid(crystal, scale, light, bands, width, height, work) {
  const { faces, world, axis } = place(crystal, scale), at = [], band = [];
  if (!faces.length) return { at, band, ridge: null };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const face of faces) for (const [x, y] of face.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  // A crystal wholly off one side of the canvas tests nothing (and must not count a negative box).
  work.spent += Math.max(0, Math.min(width, x1 + 2) - Math.max(0, x0 - 1)) * Math.max(0, Math.min(height, y1 + 2) - Math.max(0, y0 - 1)) * faces.length;
  const lit = faces.map(face => face.normal[0] * light[0] + face.normal[1] * light[1] + face.normal[2] * light[2]);
  const shade = lit.map(d => Math.max(0, Math.min(bands - 1, Math.floor((d - SHADE_LOW) / (SHADE_HIGH - SHADE_LOW) * bands))));
  for (let y = Math.max(0, Math.ceil(y0 - 1e-6)); y <= Math.min(height - 1, Math.floor(y1 + 1e-6)); y++) {
    for (let x = Math.max(0, Math.ceil(x0 - 1e-6)); x <= Math.min(width - 1, Math.floor(x1 + 1e-6)); x++) {
      // The face the pixel's centre lies in; on an edge between faces (to rounding), the brighter one takes it, so a
      // crystal lit from the other side is drawn as the exact mirror.
      const depth = faces.map(face => inside(face.points, x, y)), best = Math.max(...depth);
      if (best < -1e-6) continue;
      let brightest = -1;
      depth.forEach((d, i) => { if (d >= best - 1e-6 && shade[i] > brightest) brightest = shade[i]; });
      at.push(y * width + x); band.push(brightest);
    }
  }
  const edges = new Map();
  faces.forEach((face, i) => face.vertices.forEach((v, k) => {
    const w = face.vertices[(k + 1) % face.vertices.length], key = v < w ? `${v},${w}` : `${w},${v}`;
    edges.set(key, [...(edges.get(key) ?? []), i]);
  }));
  let ridge = null, most = -Infinity;
  const along = ([x, y]) => (x - crystal.at[0]) * axis[0] + (y - crystal.at[1]) * axis[1];
  for (const [key, pair] of edges) {
    if (pair.length !== 2 || lit[pair[0]] + lit[pair[1]] <= most + 1e-9) continue;
    most = lit[pair[0]] + lit[pair[1]];
    const ends = key.split(',').map(Number).map(v => [world[v][0], world[v][1]]);
    ridge = along(ends[0]) <= along(ends[1]) ? ends : [ends[1], ends[0]];
  }
  // The glint runs from the ridge's end nearer the seed to the crystal's tip: of the corners furthest along the growth
  // axis, the one nearest the ridge's other end.
  if (ridge) {
    const shown = new Set(faces.flatMap(face => face.vertices)), corners = [...shown].map(v => [world[v][0], world[v][1]]), far = Math.max(...corners.map(along));
    let tip = null, near = Infinity;
    for (const corner of corners) {
      if (along(corner) < far - 1e-6) continue;
      const dx = corner[0] - ridge[1][0], dy = corner[1] - ridge[1][1], d = dx * dx + dy * dy;
      if (d < near - 1e-9) { near = d; tip = corner; }
    }
    ridge = [ridge[0], tip];
  }
  return { at, band, ridge };
}
// SHADE_LOW to SHADE_HIGH: how squarely a face meets the light (its normal on the light's direction), spread evenly over
// the look's bands, so a prism lit from the side shows three. NUB: pixels a faceted crystal is long the frame after it
// seeds. GLINT.run: frames its glint takes up the ridge, before the star.
const SHADE_LOW = -0.3, SHADE_HIGH = 1, NUB = 2.5, GLINT = { run: 4 };
// Pixel-face tests a compile may spend painting faceted crystals (a cluster of 64 grown over 60 frames takes a few
// million), and drawing every crystal into every frame: a cell or outline pixel written counts DRAWN of a test, about
// what it costs beside a cube's pixel test. On a desktop the whole allowance takes about a dozen seconds.
export const CRYSTAL_WORK = 200_000_000;
const DRAWN = 1 / 32;

// ---- Snowflakes --------------------------------------------------------------------------------------------------
// Six directions 60° apart, the four slanted ones drawn as clean two-to-one pixel lines: in angle order from the
// upper right, clockwise (y points down).
const DIRECTIONS = [[1, -1], [1, 1], [0, 1], [-1, 1], [-1, -1], [0, -1]];
const SLANT = Math.sqrt(5) / 2; // the length of a step along a two-to-one line
const step = (dir, phase, j) => {
  const [sx, sy] = DIRECTIONS[dir];
  return sx === 0 ? [0, sy * j] : [sx * j, sy * Math.floor((j + phase) / 2)];
};
// Grows a snowflake frame by frame in one quadrant (x ≥ 0, y ≥ 0 from the centre), mirrored into the other three, so
// the arms match exactly. Returns, per frame, the pixels with their generation and the frame each grew in.
// Each arm keeps to its own wedge: the line halfway between the vertical arm and the slanted one splits the quadrant,
// so side branches of neighbouring arms meet on it in chevrons instead of one arm's branches combing across the other's.
const WEDGE = (() => { const x = 2 / Math.sqrt(5), y = 1 + 1 / Math.sqrt(5), l = Math.sqrt(x * x + y * y); return [x / l, y / l]; })();
const wedgeSide = (x, y) => x * WEDGE[1] - y * WEDGE[0]; // below 0: the vertical arm's side
function growSnowflake(crystal, frames, seed) {
  const R = crystal.radius, mid = R + 3, size = 2 * mid + 1, area = size * size;
  const owner = new Int32Array(area).fill(-1), gen = new Int8Array(area), born = new Int16Array(area);
  const tips = [];
  // Pixels drawn by mirroring carry their own mark, so a branch that reaches the mirror line meets its reflection.
  const id = (t, mirror) => t * 4 + mirror;
  const cell = (x, y) => (x + mid < 0 || y + mid < 0 || x + mid >= size || y + mid >= size ? -1 : (y + mid) * size + x + mid);
  const put = (x, y, t, g, f) => {
    for (const [mx, my, m] of [[x, y, 0], [-x, y, 1], [x, -y, 2], [-x, -y, 3]]) {
      const c = cell(mx, my);
      if (c < 0 || owner[c] >= 0) continue;
      owner[c] = id(t, m); gen[c] = g; born[c] = f;
    }
  };
  const free = (x, y) => { const c = cell(x, y); return c >= 0 && owner[c] < 0; };
  // A pixel a side branch may take: empty, inside its arm's wedge, and touching nothing but its own line and, at its
  // root, its parent; so it stops a pixel short of anything else.
  const clear = (tip, x, y) => {
    if (!free(x, y) || (tip.family === 0 ? wedgeSide(x, y) > -0.3 : wedgeSide(x, y) < 0.3)) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const c = cell(x + dx, y + dy);
      if (c < 0 || owner[c] < 0 || owner[c] === id(tip.index, 0)) continue;
      if (tip.n < 2 && owner[c] === id(tip.parent, 0)) continue;
      return false;
    }
    return true;
  };
  const unit = dir => (DIRECTIONS[dir][0] === 0 ? 1 : SLANT);
  // Where along a stem its side branches sprout: evenly spaced, each nudged by a seeded quarter of the spacing. Every
  // arm draws the same nudges, so the six stay alike; an arm sprouts none over its plate.
  const sprout = (g, k) => crystal.spacing * (k + 1 + (random(seed, 7, g, k) - 0.5) * 0.5) + (g === 1 ? 1 + crystal.plate : 0);
  const addTip = (parent, family, dir, ox, oy, phase, g, from) => {
    tips.push({ index: tips.length, parent, family, dir, ox, oy, phase, n: 0, g, from, alive: true, pixels: [], next: 0, last: [-99, -99] });
  };
  // The arms: down, and down and to the right; their mirrors make the other four.
  addTip(-1, 0, 2, 0, 0, 0, 0, 0); addTip(-1, 1, 1, 0, 0, 0, 0, 0);
  const rate = g => (g === 1 ? crystal.branches : crystal.twigs);
  // The first pixel of a side branch from pixel k of its stem on which it starts cleanly: touching the stem only at
  // its root, never doubling it into a square; the phase picks which way a slanted line takes its first step.
  const start = (tip, dir, k) => {
    const [px, py] = tip.pixels[k];
    for (const phase of [0, 1]) {
      const [sx, sy] = step(dir, phase, 1), qx = px + sx, qy = py + sy, [s2x, s2y] = step(dir, phase, 2);
      if (qx < 0 || qy < 0 || !free(qx, qy) || !free(px + s2x, py + s2y)) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ex, ey]) => { const c = cell(qx + ex, qy + ey); return c >= 0 && owner[c] >= 0 && !(qx + ex === px && qy + ey === py); })) continue;
      return phase;
    }
    return -1;
  };
  const out = [];
  for (let f = 0; f < frames; f++) {
    // The seed on the start frame, then the arms grow out to the radius over `grow` frames.
    const reach = f < crystal.start ? 0 : R * ease(crystal.ease, (f - crystal.start) / crystal.grow);
    if (f === crystal.start) put(0, 0, 0, 0, f);
    // Every growing tip takes at most one pixel a round, so tips racing toward each other meet halfway.
    for (let grew = true; grew;) {
      grew = false;
      for (const tip of tips) {
        if (!tip.alive) continue;
        const parent = tip.parent >= 0 ? tips[tip.parent] : null;
        // A side branch grows as far as its stem has grown past its root, times its rate: at 1 its tips touch the
        // hexagon through the arm tips.
        const target = parent ? rate(tip.g) * (parent.n * unit(parent.dir) - tip.from) : reach;
        if ((tip.n + 1) * unit(tip.dir) > target + 1e-9) continue;
        const [dx, dy] = step(tip.dir, tip.phase, tip.n + 1), x = tip.ox + dx, y = tip.oy + dy;
        if (x < 0 || y < 0 || !(parent ? clear(tip, x, y) : free(x, y))) { tip.alive = false; continue; }
        tip.n++; tip.pixels.push([x, y]); put(x, y, tip.index, tip.g, f); grew = true;
        if (tip.g >= 2 || tip.n < 2 || rate(tip.g + 1) <= 0) continue;
        const along = sprout(tip.g + 1, tip.next);
        if (tip.n * unit(tip.dir) < along + 2) continue;
        // Side branches sprout behind the tip, both ways 60° off it; on the vertical arm only to the right, since the
        // left one is its mirror.
        tip.next++;
        // Branches on one side of a stem stay at least three pixels apart, so parallel branches never close into a comb.
        const at = Math.max(0, Math.ceil(along / unit(tip.dir)) - 1), gap = Math.max(3, Math.round(crystal.spacing * 0.75 / unit(tip.dir)));
        [5, 1].forEach((turn, side) => {
          const dir = (tip.dir + turn) % 6;
          if (tip.ox === 0 && tip.dir === 2 && DIRECTIONS[dir][0] < 0) return;
          for (let k = Math.max(at, tip.last[side] + gap); k < tip.pixels.length && k < at + 3; k++) {
            const phase = start(tip, dir, k);
            if (phase < 0) continue;
            addTip(tip.index, tip.family, dir, tip.pixels[k][0], tip.pixels[k][1], phase, tip.g + 1, (k + 1) * unit(tip.dir));
            tip.last[side] = k;
            break;
          }
        });
      }
    }
    const pixels = [];
    // A side branch shows once it is two pixels long: a lone pixel on a stem would read as a speck.
    for (let c = 0; c < area; c++) if (owner[c] >= 0 && (gen[c] === 0 || tips[owner[c] >> 2].n >= 2)) pixels.push([c % size - mid, Math.floor(c / size) - mid, gen[c], born[c]]);
    out.push({ pixels, plate: Math.min(crystal.plate, reach) });
  }
  return out;
}
const inHex = (x, y, r) => { const ax = Math.abs(x), ay = Math.abs(y); return ax <= r * 0.8660254 + 1e-9 && ay <= r - ax * 0.5773503 + 1e-9; };

/** A version-1 pixelforge-crystal source → { recipe, metadata, warnings }. Each effect is a one-shot growth. */
export function compileCrystals(source) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'anchor', 'sheet', 'looks', 'effects'], 'crystal');
  if (source.format !== 'pixelforge-crystal' || source.version !== 1) fail('crystal', 'expected version-1 pixelforge-crystal');
  const width = int(source.width, 'crystal.width', 1, 256), height = int(source.height, 'crystal.height', 1, 256);
  if (!source.palette || typeof source.palette !== 'object' || Array.isArray(source.palette)) fail('crystal.palette', 'expected a palette object');
  const shell = { version: 1, name: source.name, width, height, palette: source.palette,
    ...(source.anchor !== undefined && { anchor: source.anchor }), ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject({ ...shell, frames: [{ name: 'check' }] });
  if (!source.looks || typeof source.looks !== 'object' || Array.isArray(source.looks) || !Object.keys(source.looks).length || Object.keys(source.looks).length > LIMITS.looks) fail('crystal.looks', `expected 1–${LIMITS.looks} named looks: { colors: [darkest … brightest], outline, glint }`);
  const looks = Object.create(null);
  for (const [name, look] of Object.entries(source.looks)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name)) fail(`crystal.looks.${name}`, 'expected a look name of letters, digits, - and _');
    looks[name] = readLook(look, `crystal.looks.${name}`, source.palette);
  }
  const visibleKeys = new Set(Object.entries(source.palette).filter(([, color]) => parseColor(color)[3] > 0).map(([key]) => key));
  if (!source.effects || typeof source.effects !== 'object' || Array.isArray(source.effects) || !Object.keys(source.effects).length || Object.keys(source.effects).length > 16) fail('crystal.effects', 'expected 1–16 named effects');
  const effects = Object.entries(source.effects).map(([name, effect]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) fail(`crystal.effects.${name}`, 'expected a portable effect name of at most 60 characters');
    return [name, readEffect(effect, `crystal.effects.${name}`, source, looks)];
  });
  if (new Set(effects.map(([name]) => name.toLowerCase())).size !== effects.length) fail('crystal.effects', 'effect names must be unique ignoring case');
  const total = effects.reduce((n, [, e]) => n + e.frames, 0);
  if (total > 256 || total * width * height > 4194304) fail('crystal.effects', 'the effects exceed 256 frames or 4,194,304 source pixels');
  const frames = [], animations = Object.create(null), summaries = Object.create(null), warnings = [];
  const work = { spent: 0 }, area = width * height, Places = area > 65536 ? Uint32Array : Uint16Array;
  // The outline round some cells (places on the canvas): the pixels beside them, left, right, above and below, that
  // none of them covers, each once. A pixel stamped `mark` is one of the cells, `mark + 1` already on the outline.
  const stamp = new Uint32Array(area);
  let mark = 0;
  const rim = cells => {
    mark += 2;
    for (let k = 0; k < cells.length; k++) stamp[cells[k]] = mark;
    const edge = [];
    const beside = p => { if (stamp[p] < mark) { stamp[p] = mark + 1; edge.push(p); } };
    for (let k = 0; k < cells.length; k++) {
      const p = cells[k], x = p % width;
      if (x + 1 < width) beside(p + 1);
      if (x > 0) beside(p - 1);
      if (p + width < area) beside(p + width);
      if (p >= width) beside(p - width);
    }
    return Places.from(edge);
  };
  // The canvas pixels a crystal can cover with its outline at its largest: what drawing it costs each frame.
  const reachable = c => {
    let x0, y0, x1, y1;
    if (c.habit === 'snowflake') { [x0, y0] = c.at.map(v => Math.round(v) - c.radius); [x1, y1] = c.at.map(v => Math.round(v) + c.radius); } else {
      const { world } = place(c, c.ease === 'overshoot' ? 1.1 : 1);
      [x0, y0, x1, y1] = [Math.min(...world.map(p => p[0])), Math.min(...world.map(p => p[1])), Math.max(...world.map(p => p[0])), Math.max(...world.map(p => p[1]))];
    }
    const cols = Math.min(width - 1, Math.ceil(x1) + 1) - Math.max(0, Math.floor(x0) - 1) + 1, rows = Math.min(height - 1, Math.ceil(y1) + 1) - Math.max(0, Math.floor(y0) - 1) + 1;
    return Math.max(0, cols) * Math.max(0, rows);
  };
  for (const [name, e] of effects) {
    const names = [], visiblePixels = [];
    const reach = Math.sqrt(e.light[0] * e.light[0] + e.light[1] * e.light[1]);
    // The light comes from `light` in the picture and from in front, a little more from the side than the front, so
    // a prism's three faces take three bands.
    const light = (() => { const v = [e.light[0] / reach * 0.8, e.light[1] / reach * 0.8, 0.6], l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); return v.map(c => c / l); })();
    e.crystals.forEach((c, i) => {
      if (c.at[0] < 0 || c.at[1] < 0 || c.at[0] > width - 1 || c.at[1] > height - 1) warnings.push(`crystal.effects.${name}: crystal ${i + 1} (${c.habit}) grows from [${c.at.map(v => Math.round(v * 100) / 100).join(', ')}], outside the canvas.`);
    });
    // What painting and drawing will cost at most, refused before any of it is spent: each growing frame of a faceted
    // crystal tests the pixels of its full-size box against the faces it shows (about half of them), and every frame
    // from its seed on, grown or not, writes the cells and outline of every crystal, each at most its box on the canvas.
    const estimate = e.crystals.reduce((sum, c) => {
      const drawing = (e.frames - c.start) * reachable(c) * DRAWN;
      if (c.habit === 'snowflake') return sum + drawing;
      const reach = c.habit === 'prism' ? c.length + c.width : c.size * 1.8, faces = c.habit === 'prism' ? (c.double ? 18 : 13) : c.habit === 'cube' ? 6 : 8;
      return sum + Math.min(c.grow, e.frames - c.start) * (reach + 3) * (reach + 3) * Math.ceil(faces / 2) + drawing;
    }, work.spent);
    if (estimate > CRYSTAL_WORK) fail(`crystal.effects.${name}.crystals`, `painting and drawing these crystals would take about ${Math.ceil(estimate / 1e6)} million pixel tests, more than ${CRYSTAL_WORK / 1e6} million; use fewer or smaller crystals, shorter grow times or fewer frames`);
    const flakes = e.crystals.map(c => (c.habit === 'snowflake' ? growSnowflake(c, e.frames, e.seed) : null));
    // A finished crystal draws the same pixels every frame, so each is painted and outlined again only while its size
    // changes: its cells' places and keys, and its outline's places.
    const painted = e.crystals.map(() => ({ scale: -1, fill: null, keys: null, edge: null, ridge: null }));
    let previous = null, settled = 0;
    for (let f = 0; f < e.frames; f++) {
      const codes = new Uint16Array(area), sparkles = [];
      const stroke = (edge, key) => { const code = key.charCodeAt(0); for (let k = 0; k < edge.length; k++) codes[edge[k]] = code; };
      const spend = cells => {
        work.spent += cells * DRAWN;
        if (work.spent > CRYSTAL_WORK) fail(`crystal.effects.${name}.crystals`, 'drawing the crystals takes too much work; use fewer, smaller crystals, shorter grow times or fewer frames');
      };
      e.crystals.forEach((c, i) => {
        const look = looks[c.look], n = look.colors.length;
        if (c.habit === 'snowflake') {
          const { pixels, plate } = flakes[i][f], cx = Math.round(c.at[0]), cy = Math.round(c.at[1]), swap = c.arms === 'horizontal', cells = [], keys = [];
          const add = (x, y, key) => { const px = cx + (swap ? y : x), py = cy + (swap ? x : y); if (px >= 0 && py >= 0 && px < width && py < height) { cells.push(py * width + px); keys.push(key.charCodeAt(0)); } };
          // The plate: a hexagon of the darkest band rimmed with the branches' band, under the arms, which are its ribs.
          if (plate >= 1) for (let y = -Math.ceil(plate); y <= Math.ceil(plate); y++) for (let x = -Math.ceil(plate); x <= Math.ceil(plate); x++) {
            if (!inHex(x, y, plate)) continue;
            const rimmed = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inHex(x + dx, y + dy, plate));
            add(x, y, look.colors[rimmed ? n - 2 : Math.max(0, n - 3)]);
          }
          // Arms in the brightest band, side branches one darker; what grew this frame catches the glint.
          for (const [x, y, g, b] of pixels) add(x, y, look.glint && f === b ? look.glint : look.colors[g ? n - 2 : n - 1]);
          const edge = look.outline ? rim(cells) : [];
          spend(cells.length + edge.length);
          if (look.outline) stroke(edge, look.outline);
          for (let k = 0; k < cells.length; k++) codes[cells[k]] = keys[k];
          return;
        }
        if (f < c.start) return;
        // On its first frame a crystal is its seed, one bright pixel; then it grows from a nub a few pixels long, never
        // a speck of outline, to its full size `grow` frames after it seeded.
        if (f === c.start) {
          const x = Math.round(c.at[0]), y = Math.round(c.at[1]);
          if (x >= 0 && y >= 0 && x < width && y < height) codes[y * width + x] = (look.glint ?? look.colors[n - 1]).charCodeAt(0);
          return;
        }
        const nub = Math.min(1, NUB / (c.length ?? c.size)), scale = nub + (1 - nub) * ease(c.ease, (f - c.start) / c.grow);
        const memo = painted[i];
        if (memo.scale !== scale) {
          const { at, band, ridge } = paintSolid(c, scale, light, n, width, height, work), fill = Places.from(at);
          if (work.spent > CRYSTAL_WORK) fail(`crystal.effects.${name}.crystals`, 'drawing the crystals takes too much work; use fewer, smaller crystals, shorter grow times or fewer frames');
          Object.assign(memo, { scale, fill, keys: Uint16Array.from(band, b => look.colors[b].charCodeAt(0)), edge: look.outline ? rim(fill) : new Places(0), ridge });
        }
        const { fill, keys, edge, ridge } = memo;
        spend(fill.length + edge.length);
        if (look.outline) stroke(edge, look.outline);
        for (let k = 0; k < fill.length; k++) codes[fill[k]] = keys[k];
        // Once grown, a glint runs up the lit ridge and twinkles at its end, a four-pointed star that shrinks and goes
        // out: the beat that says the crystal is done.
        const after = f - (c.start + c.grow);
        if (look.glint && ridge && after >= 1 && after <= GLINT.run + 2) {
          const [[ax, ay], [bx, by]] = ridge, q = Math.min(1, (after - 1) / (GLINT.run - 1));
          const x = Math.round(ax + (bx - ax) * q), y = Math.round(ay + (by - ay) * q), arm = after - GLINT.run === 1 ? 2 : after > GLINT.run ? 1 : 0;
          const star = [[x, y]];
          for (let k = 1; k <= arm; k++) star.push([x + k, y], [x - k, y], [x, y + k], [x, y - k]);
          sparkles.push(star, look.glint);
        }
      });
      for (let k = 0; k < sparkles.length; k += 2) for (const [x, y] of sparkles[k]) if (x >= 0 && y >= 0 && x < width && y < height) codes[y * width + x] = sparkles[k + 1].charCodeAt(0);
      const rows = [];
      let visible = 0;
      for (let y = 0, at = 0; y < height; y++) {
        let row = '';
        for (let x = 0; x < width; x++, at++) { const key = codes[at] ? String.fromCharCode(codes[at]) : '.'; row += key; if (visibleKeys.has(key)) visible++; }
        rows.push(row);
      }
      if (previous && previous.some((row, y) => row !== rows[y])) settled = f;
      previous = rows;
      const layers = [], grid = (layer, value) => ({ name: layer, ops: [{ op: 'grid', rows: value }] });
      if (e.underlay) layers.push(grid('underlay', e.underlay));
      layers.push(grid('crystals', rows));
      if (e.overlay) layers.push(grid('overlay', e.overlay));
      const frameName = `${name}-${f}`; names.push(frameName); visiblePixels.push(visible);
      frames.push({ name: frameName, duration: e.duration, layers });
    }
    if (settled === e.frames - 1) warnings.push(`crystal.effects.${name}: crystals are still growing on the last frame; add frames or shorten grow so the cluster comes to rest.`);
    animations[name] = { frames: names, loop: false };
    summaries[name] = { frames: e.frames, duration: e.frames * e.duration, crystals: e.crystals.length, settled, visiblePixels };
  }
  const recipe = { ...shell, frames, animations };
  renderProject(recipe);
  return JSON.parse(JSON.stringify({ recipe, metadata: { format: 'pixelforge-crystal-metadata', version: 1, effects: summaries }, warnings }));
}
