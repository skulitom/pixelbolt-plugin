// Rigid bodies, joints, ropes and cloth compiled to ordinary, editable recipes. A pixelforge-bodies source names effects;
// each drops balls, boxes and convex polygons into a canvas with gravity, walls, pixel obstacles and fixed (or spinning)
// containers, runs a small rigid-body simulation and bakes every frame into palette `grid` operations on the source's
// own palette. Bodies bounce, slide, roll, stack, knock each other about and come to rest; a body can start asleep,
// holding still until something hits it, and change colour at each hit. Joints connect bodies into ragdolls and hinges,
// ropes hang and break, and cloth pins, drapes, ripples and tears.
//
// The solver is sequential impulses in substeps (after Box2D): contacts with speculative distance, so fast bodies never
// pass through thin walls; warm starting; a soft push out of overlaps whose velocity is relaxed away afterwards, so it
// adds no energy; and restitution applied after the positions move, from the approach speed before the solve, so a
// ball with bounce 1 keeps its height. Pixel obstacles are traced into one-sided runs of exposed pixel edges, merged
// along straight runs, so a body slides along a drawn floor without catching on the seams between pixels.
//
// Same units as pixelforge-fluid (docs/physics-model.md, section 2): pixels, frames, pixels per frame and per frame².
// Browser-compatible and deterministic: only + − × ÷ and sqrt, craft.js's polynomial trigonometry, fixed substeps
// and iteration counts, and bodies, contacts and pixels visited in a fixed order.
import { renderProject, fail, isObject, sameWidth } from './core.js';
import { fields, number, integer } from './authoring.js';
import { sinDeg, cosDeg, traceLine, turnRows, random } from './craft.js';
import { atan2Deg } from './shapes.js';
import { readTerritory, readPickups, readEvents, readStrikes, readHud, createTerritory } from './territory.js';
import { readJoints, ropeJoint, jointPairs, pairKey, resetJoints, wakeJoints, solveJoints, correctJoints, breakJoints, paintRopes } from './constraints.js';
import { readCloths, createCloth, stepCloth, paintCloth, clothWork } from './cloth.js';

export const BODY_SHAPES = ['circle', 'box', 'polygon', 'hoop'];
export const BODY_WALLS = ['left', 'right', 'top', 'bottom'];
const LIMITS = { effects: 16, entries: 64, bodies: 256, obstacles: 32, frames: 256, work: 400000000 };
// Split powers may make a crowd of up to this many bodies (an effect's `most`).
export const CROWD = 4096;
// A match written as numbered video frames (bodiesFrames) may run this long, and do this much work.
export const MATCH_FRAMES = 18000;
const MATCH_WORK = 4000000000;
const PI = 3.141592653589793, RADIANS = PI / 180;
// Overlap (pixels) the solver leaves alone, the share of the rest it removes each substep, and the fastest it pushes.
const SLOP = 0.02, BIAS = 0.2, MAX_PUSH = 1;
// The most times heavier than the other a body resting on (or under) another is solved as (see the substep).
const HEAVIER = 10;
// Impacts slower than this (pixels a frame) don't bounce, so a dropped ball settles; faster ones count as hits.
const REST_SPEED = 0.3;
// A body slower than SLEEP_SPEED (rim included) for SLEEP_FRAMES frames sleeps: it holds exactly still, as a solid,
// until a body moving into it wakes it.
const SLEEP_SPEED = 0.03, SLEEP_FRAMES = 12, WAKE_SPEED = 0.05;
const MAX_SPEED = 8, MAX_SPIN = 45;
// A body this far outside the canvas has left it for good.
const GONE = 16;
// Walls and obstacles without their own bounce and friction.
const SURFACE = { bounce: 0, friction: 0.5 };

const boolean = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected true or false'); return value; };
const pair = (value, path, min, max) => {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'expected [x, y]');
  return value.map((n, i) => number(n, `${path}[${i}]`, min, max));
};
const identifier = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail(path, 'expected a portable name: a letter, then letters, digits, _ or -, at most 60 characters');
  return value;
};

// ---- Reading a source -------------------------------------------------------------------------------------------------
function paletteKey(value, path, palette) {
  if (typeof value !== 'string' || value.length !== 1 || value === '.' || value === ' ' || !Object.hasOwn(palette, value)) fail(path, 'expected a single-character key in the palette');
  return value;
}

// A convex polygon's local outline, centred on its centroid and wound so (edge.y, −edge.x) points out, and where that
// centroid lies among the points as they were written (`centre`).
function convex(points, path) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 8) fail(path, 'expected 3–8 points [x, y] around the body\'s centre');
  let pts = points.map((p, i) => pair(p, `${path}[${i}]`, -64, 64));
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length], cross = ax * by - ay * bx;
    area += cross; cx += (ax + bx) * cross; cy += (ay + by) * cross;
  }
  if (Math.abs(area) < 1) fail(path, 'the points enclose less than a square pixel; spread them out');
  cx /= 3 * area; cy /= 3 * area;
  if (area < 0) pts = pts.reverse();
  pts = pts.map(([x, y]) => [x - cx, y - cy]);
  pts.centre = [cx, cy];
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length], [qx, qy] = pts[(i + 2) % pts.length];
    if ((bx - ax) * (qy - by) - (by - ay) * (qx - bx) <= 1e-9) fail(path, 'expected a convex outline, every corner turning the same way (no dents and no three points in a line)');
  }
  return pts;
}

/** A convex part from its outline ([x, y] points wound as a box's: top left, top right, bottom right), with its edges'
 * outward normals; `radius` rounds it (a two-point part is a capsule). */
export function polygonPart(points, radius = 0) {
  const n = points.length, vx = new Float64Array(n), vy = new Float64Array(n), nx = new Float64Array(n), ny = new Float64Array(n);
  points.forEach(([x, y], i) => { vx[i] = x; vy[i] = y; });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ex = vx[j] - vx[i], ey = vy[j] - vy[i], length = Math.sqrt(ex * ex + ey * ey);
    nx[i] = ey / length; ny[i] = -ex / length;
  }
  return { kind: 'polygon', n, vx, vy, nx, ny, r: radius };
}

function readMaterial(value, path, fixed) {
  const out = {
    bounce: number(value.bounce ?? 0.3, `${path}.bounce`, 0, 1),
    friction: number(value.friction ?? 0.4, `${path}.friction`, 0, 2)
  };
  for (const key of ['density', 'drag', 'spinDrag', 'weightless', 'asleep', 'tireless']) if (fixed && value[key] !== undefined) fail(`${path}.${key}`, `${key} applies to a body that moves freely; a fixed body never moves unless its velocity or spin moves it`);
  return {
    ...out,
    density: number(value.density ?? 1, `${path}.density`, 0.05, 100),
    drag: number(value.drag ?? 0, `${path}.drag`, 0, 1),
    spinDrag: number(value.spinDrag ?? 0.02, `${path}.spinDrag`, 0, 1),
    weightless: value.weightless === undefined ? false : boolean(value.weightless, `${path}.weightless`),
    asleep: value.asleep === undefined ? false : boolean(value.asleep, `${path}.asleep`),
    tireless: value.tireless === undefined ? false : boolean(value.tireless, `${path}.tireless`)
  };
}

const BODY_FIELDS = ['temperature', 'team', 'speed', 'name', 'shape', 'radius', 'size', 'points', 'sides', 'gap', 'thickness', 'at', 'pivot', 'angle', 'velocity', 'spin', 'fixed', 'weightless', 'asleep', 'tireless', 'density', 'bounce', 'friction', 'drag', 'spinDrag', 'fill', 'fillEvery', 'outline', 'symbol', 'trail', 'smear', 'breaks', 'ring', 'grid'];

// One entry of `bodies`: a body, or copies of it laid out on a ring or a grid. Returns the bodies it makes.
function readBody(entry, path, context) {
  fields(entry, BODY_FIELDS, path);
  const { palette, symbols } = context;
  if (!BODY_SHAPES.includes(entry.shape)) fail(`${path}.shape`, `expected ${BODY_SHAPES.join(', ')}`);
  const shape = entry.shape, fixed = entry.fixed === undefined ? false : boolean(entry.fixed, `${path}.fixed`);
  const only = (key, shapes) => { if (entry[key] !== undefined && !shapes.includes(shape)) fail(`${path}.${key}`, `${key} applies to ${shapes.join(' or ')} bodies`); };
  only('radius', ['circle', 'hoop']); only('size', ['box']); only('points', ['polygon']); only('sides', ['hoop']); only('gap', ['hoop']); only('thickness', ['hoop']);
  if (shape === 'hoop' && !fixed) fail(`${path}.fixed`, 'a hoop is a container: give it fixed: true (velocity and spin still move it)');
  const name = entry.name === undefined ? null : identifier(entry.name, `${path}.name`);
  const at = pair(entry.at, `${path}.at`, -4096, 4096);
  const angle = number(entry.angle ?? 0, `${path}.angle`, -3600, 3600);
  const velocity = entry.velocity === undefined ? [0, 0] : pair(entry.velocity, `${path}.velocity`, -MAX_SPEED, MAX_SPEED);
  const spin = number(entry.spin ?? 0, `${path}.spin`, -MAX_SPIN, MAX_SPIN);
  const material = readMaterial(entry, path, fixed);
  // A body keeps its temperature in a fluid with heat, as an obstacle does: a red-hot stone boils the water it lands in.
  if (entry.temperature !== undefined && !context.heat) fail(`${path}.temperature`, 'a body has a temperature in a pixelforge-fluid effect with heat, where it warms or chills what it touches');
  const temperature = entry.temperature === undefined ? null : number(entry.temperature, `${path}.temperature`, -16, 16);
  // A team's body passes through its own team's cells of a territory and paints the other teams' cells it hits
  // (docs/physics-model.md, section 13a); a held speed keeps it going (an open cheat, as tireless is).
  let team = -1;
  if (entry.team !== undefined) {
    if (!context.teams) fail(`${path}.team`, 'a team goes with a territory: give the effect a territory whose teams include it');
    team = context.teams.findIndex(other => other.name === entry.team);
    if (team < 0) fail(`${path}.team`, `no team is named ${JSON.stringify(entry.team)}; the territory's teams are ${context.teams.map(other => other.name).join(', ')}`);
  }
  if (entry.speed !== undefined && fixed) fail(`${path}.speed`, 'speed holds a free body\'s speed; a fixed body moves exactly by its velocity and spin');
  const speed = entry.speed === undefined ? null : number(entry.speed, `${path}.speed`, 0.05, MAX_SPEED);
  // Geometry in the body's own frame, centred on its centre of mass.
  let parts, area, inertia, size, centre = null;
  if (shape === 'circle') {
    const r = number(entry.radius, `${path}.radius`, 0.5, 32);
    parts = [{ kind: 'circle', r }]; area = PI * r * r; inertia = r * r / 2; size = [Math.max(1, Math.round(2 * r)), Math.max(1, Math.round(2 * r))];
  } else if (shape === 'box' || shape === 'polygon') {
    let points;
    if (shape === 'box') {
      const [w, h] = pair(entry.size, `${path}.size`, 1, 64);
      points = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    } else { points = convex(entry.points, `${path}.points`); centre = points.centre; }
    const part = polygonPart(points);
    parts = [part];
    area = 0; let second = 0;
    for (let i = 0; i < part.n; i++) {
      const j = (i + 1) % part.n, ax = part.vx[i], ay = part.vy[i], bx = part.vx[j], by = part.vy[j], cross = ax * by - ay * bx;
      area += cross / 2; second += cross * (ax * ax + ax * bx + bx * bx + ay * ay + ay * by + by * by) / 12;
    }
    inertia = second / area;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < part.n; i++) { x0 = Math.min(x0, part.vx[i]); x1 = Math.max(x1, part.vx[i]); y0 = Math.min(y0, part.vy[i]); y1 = Math.max(y1, part.vy[i]); }
    size = [Math.max(1, Math.round(x1 - x0)), Math.max(1, Math.round(y1 - y0))];
  } else {
    // A hoop: a ring of capsules around its centre, open by `gap` degrees centred on its angle (0 points right).
    const r = number(entry.radius, `${path}.radius`, 2, 128);
    const sides = integer(entry.sides ?? Math.max(8, Math.min(64, Math.round(r))), `${path}.sides`, 3, 96);
    const gap = number(entry.gap ?? 0, `${path}.gap`, 0, 330), thickness = number(entry.thickness ?? 1, `${path}.thickness`, 1, 8);
    const arc = 360 - gap, segments = sides, points = [];
    for (let k = 0; k <= segments; k++) { const a = gap / 2 + arc * k / segments; points.push([r * cosDeg(a), r * sinDeg(a)]); }
    parts = [];
    for (let k = 0; k < segments; k++) {
      const [ax, ay] = points[k], [bx, by] = points[k + 1];
      if ((bx - ax) * (bx - ax) + (by - ay) * (by - ay) < 1e-12) continue;
      parts.push(polygonPart([[ax, ay], [bx, by]], thickness / 2));
    }
    area = 0; inertia = 0; size = [Math.round(2 * r + thickness), Math.round(2 * r + thickness)];
    parts.hoop = { r, points, thickness, gap, sides };
  }
  // Looks: a fill (a list changes colour at each hit), an outline, or a symbol drawn turned with the body.
  if (entry.symbol !== undefined && (entry.fill !== undefined || entry.outline !== undefined)) fail(`${path}.symbol`, 'a body is drawn with a symbol or with fill and outline, not both');
  let fills = null, outline = null, symbol = null, rows = null;
  if (entry.symbol !== undefined) {
    if (typeof entry.symbol !== 'string' || !Object.hasOwn(symbols, entry.symbol)) fail(`${path}.symbol`, `unknown symbol ${JSON.stringify(entry.symbol)}`);
    if (shape === 'hoop') fail(`${path}.symbol`, 'a hoop is drawn as its outline; give it fill');
    symbol = entry.symbol;
    // A picture is drawn with its middle on the body's centre, and a polygon's centre is its centroid, which a lopsided
    // outline has off the middle its points were written around. The picture belongs where the points were written, so
    // it is padded with empty columns and rows until its middle is the centroid: a triangle's picture then stands on
    // the triangle that collides, instead of hanging a third of the way off it.
    if (centre) {
      const padX = Math.round(2 * centre[0]), padY = Math.round(2 * centre[1]);
      if (padX || padY) {
        const wide = symbols[symbol].map(row => (padX < 0 ? '.'.repeat(-padX) : '') + row + (padX > 0 ? '.'.repeat(padX) : '')), blank = '.'.repeat(wide[0].length);
        rows = [...Array(Math.max(0, -padY)).fill(blank), ...wide, ...Array(Math.max(0, padY)).fill(blank)];
      }
    }
  } else {
    if (entry.fill === undefined) fail(`${path}.fill`, 'expected a palette key, or a list of keys to change to at each hit');
    fills = Array.isArray(entry.fill) ? entry.fill : [entry.fill];
    if (!fills.length || fills.length > 16) fail(`${path}.fill`, 'expected 1–16 palette keys');
    fills.forEach((key, i) => paletteKey(key, Array.isArray(entry.fill) ? `${path}.fill[${i}]` : `${path}.fill`, palette));
    if (entry.outline !== undefined) {
      outline = paletteKey(entry.outline, `${path}.outline`, palette);
      if (shape === 'hoop') fail(`${path}.outline`, 'a hoop is drawn as its outline; give it fill');
    }
  }
  let trail = null;
  if (entry.trail !== undefined) {
    if (!isObject(entry.trail)) fail(`${path}.trail`, 'expected { color, length }');
    fields(entry.trail, ['color', 'length'], `${path}.trail`);
    if (fixed) fail(`${path}.trail`, 'a trail follows a body that moves freely');
    trail = { color: paletteKey(entry.trail.color, `${path}.trail.color`, palette), length: integer(entry.trail.length ?? 2, `${path}.trail.length`, 1, 16) };
  }
  // A fill list steps at each hit; with fillEvery it steps with time instead: a body keeps its fill through its knocks,
  // and the copies a split makes of it take the list's fill for the frame they are made in, the list stepping every
  // fillEvery frames, so a crowd that multiplies is washed in its newest colour (stepped at each split, it speckled).
  const fillEvery = entry.fillEvery === undefined ? null : integer(entry.fillEvery, `${path}.fillEvery`, 1, 18000);
  if (fillEvery !== null && !(fills && fills.length > 1)) fail(`${path}.fillEvery`, 'fillEvery steps a list of fills; give fill a list');
  // A smear: the shape swept over its last `frames` frames, drawn under it, the most recent part in the first colour, as
  // a pixel artist draws a fast swing (a blade's swish).
  let smear = null;
  if (entry.smear !== undefined) {
    if (!isObject(entry.smear)) fail(`${path}.smear`, 'expected { colors, frames }');
    fields(entry.smear, ['colors', 'frames'], `${path}.smear`);
    if (shape === 'hoop') fail(`${path}.smear`, 'a hoop is drawn as its outline; a smear goes with a body that swings');
    if (!Array.isArray(entry.smear.colors) || !entry.smear.colors.length || entry.smear.colors.length > 8) fail(`${path}.smear.colors`, 'expected 1–8 palette keys, the most recent part of the sweep first');
    smear = { colors: entry.smear.colors.map((key, i) => paletteKey(key, `${path}.smear.colors[${i}]`, palette)), frames: integer(entry.smear.frames ?? 1, `${path}.smear.frames`, 1, 8) };
  }
  // A fixed body may turn about a pivot of its own (a blade about its hilt): `pivot` is that point, measured from the
  // body's centre before it turns, and `at` places the pivot. A free body turns about its centre of mass.
  let pivot = null;
  if (entry.pivot !== undefined) {
    if (!fixed) fail(`${path}.pivot`, 'a pivot goes with a fixed body; a body that moves freely turns about its centre of mass');
    pivot = pair(entry.pivot, `${path}.pivot`, -128, 128);
    if (pivot[0] === 0 && pivot[1] === 0) pivot = null;
  }
  // A body that breaks: knocked hard enough (its speed changed by `at` pixels a frame or more in one substep, from
  // everything pushing on it, so a body crushed between two others counts both pushes), it breaks into `pieces` pieces cut
  // through its shape about where it was hit, each a body of its own carrying its part of the picture, flung apart at
  // `speed` on top of the body's own motion.
  let breaks = null;
  if (entry.breaks !== undefined) {
    if (!context.breakable) fail(`${path}.breaks`, 'bodies break in a pixelforge-bodies source; the bodies in a fluid do not break yet');
    if (!isObject(entry.breaks)) fail(`${path}.breaks`, 'expected { at, pieces, speed }');
    fields(entry.breaks, ['at', 'pieces', 'speed'], `${path}.breaks`);
    if (shape === 'hoop') fail(`${path}.breaks`, 'a hoop is a container and does not break; an event can make it vanish');
    if (fixed) fail(`${path}.breaks`, 'a fixed body takes no knocks; break it on cue with an event whose power is break');
    if (area < 4) fail(`${path}.breaks`, 'the body is under 4 square pixels, too small to show pieces; make it bigger');
    breaks = { at: number(entry.breaks.at ?? 3, `${path}.breaks.at`, 0.1, 16), pieces: integer(entry.breaks.pieces ?? 6, `${path}.breaks.pieces`, 2, 16), speed: number(entry.breaks.speed ?? 0.5, `${path}.breaks.speed`, 0, MAX_SPEED) };
  }
  // Copies on a ring (each turned to face out from its centre, `at`) or on a grid (from `at`).
  if (entry.ring !== undefined && entry.grid !== undefined) fail(`${path}.grid`, 'copies go on a ring or a grid, not both');
  let places = [[at[0], at[1], angle]];
  if (entry.ring !== undefined) {
    if (!isObject(entry.ring)) fail(`${path}.ring`, 'expected { radius, count, from, to }');
    fields(entry.ring, ['radius', 'count', 'from', 'to'], `${path}.ring`);
    const radius = number(entry.ring.radius, `${path}.ring.radius`, 1, 256), count = integer(entry.ring.count, `${path}.ring.count`, 2, LIMITS.bodies);
    const from = number(entry.ring.from ?? 0, `${path}.ring.from`, -3600, 3600), to = number(entry.ring.to ?? from + 360, `${path}.ring.to`, -3600, 3600);
    const closed = Math.abs(to - from) % 360 === 0;
    places = Array.from({ length: count }, (_, k) => {
      const a = from + (to - from) * k / (closed ? count : count - 1);
      return [at[0] + radius * cosDeg(a), at[1] + radius * sinDeg(a), angle + a];
    });
  } else if (entry.grid !== undefined) {
    if (!isObject(entry.grid)) fail(`${path}.grid`, 'expected { count: [columns, rows], step: [x, y], stagger }');
    fields(entry.grid, ['count', 'step', 'stagger'], `${path}.grid`);
    if (!Array.isArray(entry.grid.count) || entry.grid.count.length !== 2) fail(`${path}.grid.count`, 'expected [columns, rows]');
    const [columns, rows] = entry.grid.count.map((n, i) => integer(n, `${path}.grid.count[${i}]`, 1, LIMITS.bodies));
    const [dx, dy] = pair(entry.grid.step, `${path}.grid.step`, -256, 256), stagger = number(entry.grid.stagger ?? 0, `${path}.grid.stagger`, -256, 256);
    if (columns * rows > LIMITS.bodies) fail(`${path}.grid.count`, `at most ${LIMITS.bodies} copies`);
    places = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) places.push([at[0] + i * dx + (j % 2 ? stagger : 0), at[1] + j * dy, angle]);
  }
  const mass = fixed ? 0 : material.density * area;
  return places.map(([x, y, a], k) => ({
    name: name === null ? null : places.length > 1 ? `${name}-${k}` : name, path: places.length > 1 ? `${path} (copy ${k})` : path,
    shape, parts, size, fixed, x, y, angle: a, vx: velocity[0], vy: velocity[1], spin,
    invMass: fixed ? 0 : 1 / mass, invInertia: fixed || shape === 'hoop' ? 0 : 1 / (mass * inertia),
    bounce: material.bounce, friction: material.friction, drag: material.drag, spinDrag: material.spinDrag,
    weightless: material.weightless, asleep: material.asleep, tireless: material.tireless, temperature, team, speed, fills, fillEvery, outline, symbol, trail, smear, breaks,
    ...(rows && { rows }), ...(pivot && pivoted(x, y, a, pivot, velocity, spin))
  }));
}
// A fixed body turning about a pivot: `at` (x, y) is the pivot, its velocity the pivot's; the body's centre and its
// centre's velocity (the pivot's plus the turn about it) follow from its angle.
function pivoted(x, y, angle, pivot, velocity, spin) {
  const c = cosDeg(angle), s = sinDeg(angle), dx = -(c * pivot[0] - s * pivot[1]), dy = -(s * pivot[0] + c * pivot[1]), w = spin * RADIANS;
  return { pivot, anchor: [x, y], drift: velocity, x: x + dx, y: y + dy, vx: velocity[0] - w * dy, vy: velocity[1] + w * dx };
}

// ---- Breaking ---------------------------------------------------------------------------------------------------------
// A body's outline in its own frame, wound as a polygon part's: a polygon's corners, a circle's as a 16-sided polygon.
function outlineOf(b) {
  const part = b.parts[0];
  if (part.kind === 'circle') return Array.from({ length: 16 }, (_, k) => [part.r * cosDeg(k * 22.5), part.r * sinDeg(k * 22.5)]);
  return Array.from({ length: part.n }, (_, i) => [part.vx[i], part.vy[i]]);
}
// A convex polygon cut to the side of the line through (mx, my) where (p − m)·d ≤ 0 (one edge of Sutherland–Hodgman).
function clipHalf(points, mx, my, dx, dy) {
  const out = [], side = ([x, y]) => (x - mx) * dx + (y - my) * dy;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) { const t = sa / (sa - sb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
// A polygon's area, centroid and second moment of area about its centroid.
function polygonMass(points) {
  let area = 0, cx = 0, cy = 0, second = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length], cross = ax * by - ay * bx;
    area += cross; cx += (ax + bx) * cross; cy += (ay + by) * cross;
  }
  cx /= 3 * area; cy /= 3 * area;
  for (let i = 0; i < points.length; i++) {
    const ax = points[i][0] - cx, ay = points[i][1] - cy, bx = points[(i + 1) % points.length][0] - cx, by = points[(i + 1) % points.length][1] - cy, cross = ax * by - ay * bx;
    second += cross * (ax * ax + ax * bx + bx * bx + ay * ay + ay * by + by * by) / 12;
  }
  return { area: area / 2, cx, cy, second };
}
// A convex polygon from cutting, with its doubled and straight corners dropped: none if fewer than 3 corners are left or
// it covers under a twentieth of a square pixel.
function tidy(points) {
  let pts = points.filter((p, i) => { const q = points[(i + 1) % points.length], dx = p[0] - q[0], dy = p[1] - q[1]; return dx * dx + dy * dy > 1e-8; });
  pts = pts.filter((p, i) => {
    const a = pts[(i + pts.length - 1) % pts.length], c = pts[(i + 1) % pts.length];
    return (p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0]) > 1e-9;
  });
  return pts.length >= 3 && polygonMass(pts).area > 0.05 ? pts : [];
}
const BREAK_SALT = 7703;

/** A list of body entries (as a bodies source's or a fluid effect's `bodies`) → the bodies they make, copies included. */
export function readBodies(list, path, context) {
  if (!Array.isArray(list) || list.length > LIMITS.entries) fail(path, `expected a list of at most ${LIMITS.entries} entries`);
  if (!list.length) fail(path, 'expected at least one body');
  const bodies = list.flatMap((entry, i) => readBody(entry, `${path}[${i}]`, context));
  if (bodies.length > LIMITS.bodies) fail(path, `the bodies and their copies make ${bodies.length} bodies, more than ${LIMITS.bodies}`);
  const names = new Set();
  bodies.forEach(b => { if (b.name !== null) { if (names.has(b.name.toLowerCase())) fail(`${b.path}.name`, `two bodies are named ${b.name}`); names.add(b.name.toLowerCase()); } });
  return bodies;
}

// Ropes: a chain of small hidden bodies between two anchors, with a line or a chain of links drawn over them. A rope may
// hang from a body, from the world, or from both; its links collide with the world and other bodies, never with their
// neighbours, and a joint whose `break` impulse is passed splits the rope.
const ROPE_FIELDS = ['from', 'to', 'links', 'slack', 'thickness', 'look', 'fill', 'outline', 'density', 'break', 'draw'];
function readRopes(list, path, { bodies, byName, palette, joints }) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 16) fail(path, 'expected a list of at most 16 ropes');
  const end = (value, at) => {
    if (!isObject(value)) fail(at, 'expected { body, point } or { at }');
    fields(value, ['body', 'point', 'at'], at);
    if (value.body !== undefined && value.at !== undefined) fail(`${at}.at`, 'a rope end is a body or a world point, not both');
    if (value.body !== undefined) {
      if (typeof value.body !== 'string') fail(`${at}.body`, 'expected a body name');
      const body = byName.get(value.body.toLowerCase());
      if (!body) {
        const known = [...byName.values()].map(other => other.name).filter(Boolean);
        fail(`${at}.body`, `unknown body ${JSON.stringify(value.body)}${known.length ? `; the bodies are ${known.join(', ')}` : ''}`);
      }
      return { index: bodies.indexOf(body), body, point: value.point === undefined ? [0, 0] : pair(value.point, `${at}.point`, -4096, 4096) };
    }
    if (value.at === undefined) fail(at, 'expected { body, point } or { at }');
    return { index: -1, body: null, point: pair(value.at, `${at}.at`, -4096, 4096) };
  };
  const worldPoint = anchor => anchor.body
    ? [anchor.body.x + cosDeg(anchor.body.angle) * anchor.point[0] - sinDeg(anchor.body.angle) * anchor.point[1],
      anchor.body.y + sinDeg(anchor.body.angle) * anchor.point[0] + cosDeg(anchor.body.angle) * anchor.point[1]]
    : anchor.point;
  return list.map((entry, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(entry)) fail(at, 'expected a rope');
    fields(entry, ROPE_FIELDS, at);
    const from = end(entry.from, `${at}.from`), to = end(entry.to, `${at}.to`);
    if (from.body && from.body === to.body) fail(`${at}.to`, 'a rope hangs between two bodies, or a body and a point; both ends are the same body');
    const links = integer(entry.links ?? 12, `${at}.links`, 2, 64);
    if (bodies.length + links > LIMITS.bodies) fail(`${at}.links`, `the ropes and bodies make ${bodies.length + links} bodies, more than ${LIMITS.bodies}`);
    const slack = number(entry.slack ?? 0.15, `${at}.slack`, 0, 2);
    const thickness = number(entry.thickness ?? 1, `${at}.thickness`, 1, 4);
    const look = entry.look ?? 'rope';
    if (!['rope', 'chain'].includes(look)) fail(`${at}.look`, 'expected rope or chain');
    const fill = paletteKey(entry.fill, `${at}.fill`, palette);
    const outline = entry.outline === undefined ? null : paletteKey(entry.outline, `${at}.outline`, palette);
    const density = number(entry.density ?? 0.6, `${at}.density`, 0.05, 10);
    const breakAt = entry.break === undefined ? null : number(entry.break, `${at}.break`, 0.01, 1000000);
    const draw = entry.draw ?? 'under';
    if (!['under', 'over'].includes(draw)) fail(`${at}.draw`, 'expected under or over');
    const a = worldPoint(from), b = worldPoint(to), dx = b[0] - a[0], dy = b[1] - a[1], span = Math.sqrt(dx * dx + dy * dy);
    // A link far lighter than what hangs from it lets the rope stretch: the solve passes a pull along the chain a
    // joint an iteration, and a ball two thousand times a link's weight falls to the floor before the rope holds
    // it. Unless the source gives the rope's density, a link weighs at least 1/128 of the heavier free end, at
    // which a ball swings as it does on a rigid joint.
    const radius = Math.max(0.5, thickness / 2), area = PI * radius * radius;
    const heaviest = Math.max(0, ...[from.body, to.body].filter(body => body && !body.fixed && body.invMass > 0).map(body => 1 / body.invMass));
    const mass = entry.density === undefined ? Math.max(density * area, heaviest / 128) : density * area;
    const linkIndices = [];
    for (let k = 0; k < links; k++) {
      const t = (k + 1) / (links + 1), x = a[0] + dx * t, y = a[1] + dy * t;
      const body = {
        name: null, path: `${at} (link ${k})`, shape: 'circle', parts: [{ kind: 'circle', r: radius }], size: [Math.max(1, Math.round(2 * radius)), Math.max(1, Math.round(2 * radius))],
        fixed: false, x, y, angle: 0, vx: 0, vy: 0, spin: 0, invMass: 1 / mass, invInertia: 1 / (mass * radius * radius / 2),
        bounce: 0.1, friction: 0.5, drag: 0.02, spinDrag: 0.1, weightless: false, asleep: false, tireless: false, temperature: null,
        team: -1, speed: null, fills: [fill], fillEvery: null, outline: null, symbol: null, trail: null, smear: null, breaks: null,
        pivot: null, anchor: null, drift: null, hidden: true
      };
      linkIndices.push(bodies.length); bodies.push(body);
    }
    const max = span / (links + 1) * (1 + slack);
    const jointIndices = [];
    const add = (aIndex, bIndex, la, lb) => { const index = joints.length; joints.push(ropeJoint(aIndex, bIndex, la, lb, max, breakAt, `${at} (joint ${jointIndices.length})`)); jointIndices.push(index); };
    add(linkIndices[0], from.index, [0, 0], from.point);
    for (let k = 0; k + 1 < linkIndices.length; k++) add(linkIndices[k], linkIndices[k + 1], [0, 0], [0, 0]);
    add(linkIndices.at(-1), to.index, [0, 0], to.point);
    if (joints.length > 256) fail(`${at}.links`, `the joints and ropes make more than 256 joints; use fewer links or ropes`);
    return { look, thickness, fill, outline, draw, linkIndices, jointIndices };
  });
}

function readEffect(effect, path, context) {
  if (!isObject(effect)) fail(path, 'expected an effect');
  fields(effect, ['frames', 'duration', 'substeps', 'iterations', 'gravity', 'background', 'walls', 'obstacles', 'territory', 'bodies', 'joints', 'ropes', 'cloths', 'most', 'pickups', 'events', 'strikes', 'hud'], path);
  const { width, height, symbols, palette } = context, most = context.frames ?? LIMITS.frames;
  const background = effect.background === undefined ? null : paletteKey(effect.background, `${path}.background`, palette);
  if (Number.isInteger(effect.frames) && effect.frames > most && effect.frames <= MATCH_FRAMES) fail(`${path}.frames`, `a recipe holds at most ${most} frames; write a longer match as numbered video frames: pixelbolt sequence <source> --out <folder> --fps 30, or pixel_compile with sequence`);
  const frames = integer(effect.frames, `${path}.frames`, 1, most);
  const duration = integer(effect.duration ?? 40, `${path}.duration`, 10, 1000);
  const substeps = integer(effect.substeps ?? 8, `${path}.substeps`, 1, 16), iterations = integer(effect.iterations ?? 6, `${path}.iterations`, 1, 16);
  const gravity = effect.gravity === undefined ? [0, 0.15] : pair(effect.gravity, `${path}.gravity`, -2, 2);
  const listed = (value, key, max) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) fail(`${path}.${key}`, `expected a list of at most ${max} entries`);
    return value;
  };
  const walls = listed(effect.walls, 'walls', 4);
  walls.forEach((edge, i) => { if (!BODY_WALLS.includes(edge)) fail(`${path}.walls[${i}]`, `expected ${BODY_WALLS.join(', ')}`); });
  if (new Set(walls).size !== walls.length) fail(`${path}.walls`, 'each edge is listed once');
  const obstacles = listed(effect.obstacles, 'obstacles', LIMITS.obstacles).map((obstacle, i) => {
    const op = `${path}.obstacles[${i}]`;
    fields(obstacle, ['symbol', 'x', 'y', 'draw', 'solid', 'bounce', 'friction'], op);
    if (typeof obstacle.symbol !== 'string' || !Object.hasOwn(symbols, obstacle.symbol)) fail(`${op}.symbol`, `unknown symbol ${JSON.stringify(obstacle.symbol)}`);
    const rows = symbols[obstacle.symbol];
    const x = integer(obstacle.x ?? 0, `${op}.x`, -rows[0].length, width), y = integer(obstacle.y ?? 0, `${op}.y`, -rows.length, height);
    const draw = obstacle.draw ?? 'over';
    if (!['over', 'under', 'none'].includes(draw)) fail(`${op}.draw`, 'expected over (drawn in front of the bodies), under or none (an invisible wall)');
    const solid = obstacle.solid === undefined ? true : boolean(obstacle.solid, `${op}.solid`);
    if (!solid && draw === 'none') fail(`${op}.draw`, 'a decoration (solid: false) is only drawn; draw it over or under the bodies');
    if (!solid && (obstacle.bounce !== undefined || obstacle.friction !== undefined)) fail(`${op}.${obstacle.bounce !== undefined ? 'bounce' : 'friction'}`, 'a decoration (solid: false) never meets a body');
    return { symbol: obstacle.symbol, x, y, rows, draw, solid, bounce: number(obstacle.bounce ?? SURFACE.bounce, `${op}.bounce`, 0, 1), friction: number(obstacle.friction ?? SURFACE.friction, `${op}.friction`, 0, 2) };
  });
  // A territory of team-owned cells, then the bodies (whose teams it names), the powers and the heads-up display.
  const territory = effect.territory === undefined ? null : readTerritory(effect.territory, `${path}.territory`, { width, height, palette });
  // A cloth- or rope-only effect may leave `bodies` out; every other effect needs at least one body.
  const clothOnly = effect.cloths !== undefined || effect.ropes !== undefined;
  const listedBodies = effect.bodies === undefined || (Array.isArray(effect.bodies) && effect.bodies.length === 0)
    ? (clothOnly ? [] : readBodies(effect.bodies, `${path}.bodies`, { ...context, teams: territory ? territory.teams : null, breakable: true }))
    : readBodies(effect.bodies, `${path}.bodies`, { ...context, teams: territory ? territory.teams : null, breakable: true });
  const bodies = listedBodies;
  const byName = new Map(bodies.filter(body => body.name !== null).map(body => [body.name.toLowerCase(), body]));
  const joints = readJoints(effect.joints, `${path}.joints`, { bodies, byName });
  const ropes = readRopes(effect.ropes, `${path}.ropes`, { bodies, byName, palette, joints });
  const cloths = readCloths(effect.cloths, `${path}.cloths`, { bodies, byName, palette });
  const pickups = readPickups(effect.pickups, `${path}.pickups`, context), events = readEvents(effect.events, `${path}.events`, context, bodies);
  const strikes = readStrikes(effect.strikes, `${path}.strikes`, context, bodies);
  const hud = readHud(effect.hud, `${path}.hud`, context, territory ? territory.teams : null);
  // The most bodies there may be once split powers have made copies and broken bodies their pieces: by default 256, or
  // room for every body with breaks to break into all its pieces, up to CROWD.
  const pieces = bodies.reduce((sum, b) => sum + (b.breaks ? b.breaks.pieces : 0), 0);
  const crowd = integer(effect.most ?? Math.min(CROWD, Math.max(LIMITS.bodies, bodies.length + pieces)), `${path}.most`, bodies.length, CROWD);
  return { frames, duration, substeps, iterations, gravity, background, walls: Object.fromEntries(BODY_WALLS.map(edge => [edge, walls.includes(edge)])), obstacles, territory, bodies, joints, ropes, cloths, most: crowd, pickups, events, strikes, hud };
}

// ---- Pixel obstacles --------------------------------------------------------------------------------------------------
// The solid pixels (and closed edges beyond the canvas) traced into one-sided segments: every exposed pixel edge, joined
// along straight runs, with its outward normal. An end is convex where the solid stops (the run turns a corner away from
// the body); only convex ends round off, so a concave corner is two faces meeting and a flat floor has no seams.
// `hard` marks the pixels of obstacles that aren't soft (a fluid's resting sand is), for waking the bodies beside one
// that moves. An obstacle's `velocity` (a fluid's moving obstacle, pixels a frame) is its faces' too, so a box on a
// moving shelf rides it rather than being shoved out of it as it steps.
function traceObstacles(effect, width, height) {
  const N = width * height, solid = new Uint8Array(N), hard = new Uint8Array(N), owner = new Int16Array(N).fill(-1);
  effect.obstacles.forEach((o, index) => {
    if (!o.solid) return;
    o.rows.forEach((row, j) => {
      const y = o.y + j;
      if (y < 0 || y >= height) return;
      for (let k = 0; k < row.length; k++) {
        const x = o.x + k;
        if (x < 0 || x >= width || row[k] === '.' || row[k] === ' ') continue;
        solid[y * width + x] = 1; if (!o.soft) hard[y * width + x] = 1; if (owner[y * width + x] < 0) owner[y * width + x] = index;
      }
    });
  });
  const { walls } = effect;
  const at = (i, j) => {
    if (i >= 0 && i < width && j >= 0 && j < height) return solid[j * width + i] === 1;
    return (i < 0 && walls.left) || (i >= width && walls.right) || (j < 0 && walls.top) || (j >= height && walls.bottom);
  };
  const material = (i, j) => {
    const o = i >= 0 && i < width && j >= 0 && j < height ? owner[j * width + i] : -1;
    return o < 0 ? SURFACE : effect.obstacles[o];
  };
  return { ...traceGrid(at, material, width, height, 1, 0, 0, width, height), solid, hard };
}

// The faces of a grid of cells, `at(i, j)` solid (it may answer past the grid's edges), as one-sided segments in canvas
// pixels, cell (i, j) covering `scale` pixels from (ox + i·scale, oy + j·scale): joined along straight runs, each with
// its outward normal and its cell's `material`, and an index for finding the ones near an area of a width × height
// canvas. Pixel obstacles are a grid of 1-pixel cells; a territory's cells are larger.
function traceGrid(at, material, width, height, scale, ox, oy, canvasWidth, canvasHeight) {
  const segments = [];
  const add = (ai, aj, bi, bj, nx, ny, cell) => {
    // Wound so the first edge's normal (dy, −dx) is the outward normal.
    const ex = bi - ai, ey = bj - aj, len = Math.sqrt(ex * ex + ey * ey), dx = ex / len, dy = ey / len;
    // Convex ends: the solid cell just past the end, on the solid side, is empty.
    const convexA = !at(Math.floor(ai - dx * 0.5 - nx * 0.5), Math.floor(aj - dy * 0.5 - ny * 0.5));
    const convexB = !at(Math.floor(bi + dx * 0.5 - nx * 0.5), Math.floor(bj + dy * 0.5 - ny * 0.5));
    const m = material(cell[0], cell[1]), ax = ox + ai * scale, ay = oy + aj * scale, bx = ox + bi * scale, by = oy + bj * scale;
    segments.push({ ax, ay, bx, by, nx, ny, convexA, convexB, bounce: m.bounce, friction: m.friction, soft: !!m.soft, move: m.velocity ?? null,
      part: polygonPart([[ax, ay], [bx, by]]) });
  };
  // Horizontal faces at y = j, between cell (i, j − 1) above and (i, j) below. A run ends where the solid's material
  // changes, so a bouncy floor beside a dead one keeps its own bounce (one run took the material it started on).
  const same = (i, j, k, l) => {
    const m = material(i, j), o = material(k, l), mv = m.velocity ?? [0, 0], ov = o.velocity ?? [0, 0];
    return m === o || (m.bounce === o.bounce && m.friction === o.friction && !!m.soft === !!o.soft && mv[0] === ov[0] && mv[1] === ov[1]);
  };
  for (let j = 0; j <= height; j++) for (const up of [true, false]) {
    let start = -1;
    for (let i = 0; i <= width; i++) {
      const face = i < width && (up ? at(i, j) && !at(i, j - 1) : at(i, j - 1) && !at(i, j));
      if (face && start >= 0 && !same(i, up ? j : j - 1, start, up ? j : j - 1)) {
        if (up) add(start, j, i, j, 0, -1, [start, j]); else add(i, j, start, j, 0, 1, [start, j - 1]);
        start = -1;
      }
      if (face && start < 0) start = i;
      if (!face && start >= 0) {
        if (up) add(start, j, i, j, 0, -1, [start, j]); else add(i, j, start, j, 0, 1, [start, j - 1]);
        start = -1;
      }
    }
  }
  // Vertical faces at x = i, between cell (i − 1, j) on the left and (i, j) on the right.
  for (let i = 0; i <= width; i++) for (const left of [true, false]) {
    let start = -1;
    for (let j = 0; j <= height; j++) {
      const face = j < height && (left ? at(i, j) && !at(i - 1, j) : at(i - 1, j) && !at(i, j));
      if (face && start >= 0 && !same(left ? i : i - 1, j, left ? i : i - 1, start)) {
        if (left) add(i, j, i, start, -1, 0, [i, start]); else add(i, start, i, j, 1, 0, [i - 1, start]);
        start = -1;
      }
      if (face && start < 0) start = j;
      if (!face && start >= 0) {
        if (left) add(i, j, i, start, -1, 0, [i, start]); else add(i, start, i, j, 1, 0, [i - 1, start]);
        start = -1;
      }
    }
  }
  // A coarse grid of cells, each listing the segments that cross it, for queries by area.
  const CELL = 8, gx0 = -1, gy0 = -1, gw = Math.ceil(canvasWidth / CELL) + 3, gh = Math.ceil(canvasHeight / CELL) + 3, cells = Array.from({ length: gw * gh }, () => []);
  segments.forEach((s, index) => {
    const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL) - gx0, x1 = Math.floor(Math.max(s.ax, s.bx) / CELL) - gx0;
    const y0 = Math.floor(Math.min(s.ay, s.by) / CELL) - gy0, y1 = Math.floor(Math.max(s.ay, s.by) / CELL) - gy0;
    for (let y = Math.max(0, y0); y <= Math.min(gh - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(gw - 1, x1); x++) cells[y * gw + x].push(index);
  });
  const seen = new Int32Array(segments.length).fill(-1);
  let query = 0;
  const near = (x0, y0, x1, y1) => {
    query++;
    const out = [];
    const cx0 = Math.max(0, Math.floor(x0 / CELL) - gx0), cx1 = Math.min(gw - 1, Math.floor(x1 / CELL) - gx0);
    const cy0 = Math.max(0, Math.floor(y0 / CELL) - gy0), cy1 = Math.min(gh - 1, Math.floor(y1 / CELL) - gy0);
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) for (const index of cells[y * gw + x]) {
      if (seen[index] === query) continue;
      seen[index] = query;
      const s = segments[index];
      if (Math.max(s.ax, s.bx) < x0 || Math.min(s.ax, s.bx) > x1 || Math.max(s.ay, s.by) < y0 || Math.min(s.ay, s.by) > y1) continue;
      out.push(index);
    }
    return out.sort((a, b) => a - b);
  };
  return { segments, near };
}

// ---- Geometry in the world --------------------------------------------------------------------------------------------
// Each body's parts placed by its position and rotation (c, s), with its bounds.
function place(b) {
  const { x, y, c, s } = b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  b.world = b.parts.map(part => {
    if (part.kind === 'circle') {
      x0 = Math.min(x0, x - part.r); x1 = Math.max(x1, x + part.r); y0 = Math.min(y0, y - part.r); y1 = Math.max(y1, y + part.r);
      return { kind: 'circle', x, y, r: part.r };
    }
    const n = part.n, vx = new Float64Array(n), vy = new Float64Array(n), nx = new Float64Array(n), ny = new Float64Array(n);
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (let i = 0; i < n; i++) {
      vx[i] = x + c * part.vx[i] - s * part.vy[i]; vy[i] = y + s * part.vx[i] + c * part.vy[i];
      nx[i] = c * part.nx[i] - s * part.ny[i]; ny[i] = s * part.nx[i] + c * part.ny[i];
      px0 = Math.min(px0, vx[i]); px1 = Math.max(px1, vx[i]); py0 = Math.min(py0, vy[i]); py1 = Math.max(py1, vy[i]);
    }
    const box = [px0 - part.r, py0 - part.r, px1 + part.r, py1 + part.r];
    x0 = Math.min(x0, box[0]); y0 = Math.min(y0, box[1]); x1 = Math.max(x1, box[2]); y1 = Math.max(y1, box[3]);
    return { kind: 'polygon', n, vx, vy, nx, ny, r: part.r, box };
  });
  b.box = [x0, y0, x1, y1];
}

const overlaps = (a, b, margin) => a[0] - margin <= b[2] && b[0] - margin <= a[2] && a[1] - margin <= b[3] && b[1] - margin <= a[3];
const partBox = part => part.kind === 'circle' ? [part.x - part.r, part.y - part.r, part.x + part.r, part.y + part.r] : part.box;

// Contact manifolds: { nx, ny } from the first shape to the second and up to two points { x, y, sep, id }, with
// separation negative where they overlap and up to `margin` where they are about to touch.
// Circles on the same centre push apart along `apart` (the way they are moving apart, if they are): a split's copies
// start on their taker and fly off along their own headings, where pushed along y they lost them.
function circleCircle(a, b, margin, apart = [0, 1]) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy), sep = d - a.r - b.r;
  if (sep > margin) return null;
  const nx = d > 1e-9 ? dx / d : apart[0], ny = d > 1e-9 ? dy / d : apart[1];
  return { nx, ny, points: [{ x: a.x + nx * (a.r + sep / 2), y: a.y + ny * (a.r + sep / 2), sep, id: 0 }] };
}

// The normal points from the polygon to the circle.
function polygonCircle(p, c, margin) {
  const total = c.r + p.r;
  let s = -Infinity, e = 0;
  for (let i = 0; i < p.n; i++) { const d = p.nx[i] * (c.x - p.vx[i]) + p.ny[i] * (c.y - p.vy[i]); if (d > s) { s = d; e = i; } }
  if (s > total + margin) return null;
  const f = (e + 1) % p.n, ax = p.vx[e], ay = p.vy[e], bx = p.vx[f], by = p.vy[f];
  let nx = p.nx[e], ny = p.ny[e], dist = s, id = e;
  if (s > 0) {
    const u1 = (c.x - ax) * (bx - ax) + (c.y - ay) * (by - ay), u2 = (c.x - bx) * (ax - bx) + (c.y - by) * (ay - by);
    const corner = u1 <= 0 ? [ax, ay, e] : u2 <= 0 ? [bx, by, f] : null;
    if (corner) {
      const dx = c.x - corner[0], dy = c.y - corner[1], d = Math.sqrt(dx * dx + dy * dy);
      if (d - total > margin) return null;
      if (d > 1e-9) { nx = dx / d; ny = dy / d; }
      dist = d; id = 16 + corner[2];
    }
  }
  const sep = dist - total, gap = c.r + sep / 2;
  return { nx, ny, points: [{ x: c.x - nx * gap, y: c.y - ny * gap, sep, id }] };
}

function maxSeparation(a, b) {
  let best = -Infinity, index = 0;
  for (let i = 0; i < a.n; i++) {
    const nx = a.nx[i], ny = a.ny[i], ax = a.vx[i], ay = a.vy[i];
    let s = Infinity;
    for (let j = 0; j < b.n; j++) { const d = nx * (b.vx[j] - ax) + ny * (b.vy[j] - ay); if (d < s) s = d; }
    if (s > best) { best = s; index = i; }
  }
  return [best, index];
}

// Convex polygons (rounded by their radius r; a two-point polygon is a capsule), by separating axes and clipping the
// incident edge against the reference face. The normal points from a to b. `reference` reports which face was used.
function polygonPolygon(a, b, margin) {
  const total = a.r + b.r, [sa, ea] = maxSeparation(a, b);
  if (sa > total + margin) return null;
  const [sb, eb] = maxSeparation(b, a);
  if (sb > total + margin) return null;
  const flip = sb > sa + 0.1 * SLOP, ref = flip ? b : a, inc = flip ? a : b, edge = flip ? eb : ea;
  const nx = ref.nx[edge], ny = ref.ny[edge];
  let ie = 0, least = Infinity;
  for (let i = 0; i < inc.n; i++) { const d = nx * inc.nx[i] + ny * inc.ny[i]; if (d < least) { least = d; ie = i; } }
  const i2 = (ie + 1) % inc.n, r2 = (edge + 1) % ref.n;
  const ax = ref.vx[edge], ay = ref.vy[edge], bx = ref.vx[r2], by = ref.vy[r2];
  let tx = bx - ax, ty = by - ay;
  const length = Math.sqrt(tx * tx + ty * ty); tx /= length; ty /= length;
  let points = [[inc.vx[ie], inc.vy[ie], ie], [inc.vx[i2], inc.vy[i2], i2]];
  // Keep the incident edge between the reference face's side planes, widened by the radii.
  const clip = (list, px, py, offset, tag) => {
    const [p, q] = list, dp = px * p[0] + py * p[1] - offset, dq = px * q[0] + py * q[1] - offset, out = [];
    if (dp <= 0) out.push(p);
    if (dq <= 0) out.push(q);
    if (dp * dq < 0) { const t = dp / (dp - dq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), tag]); }
    return out;
  };
  points = clip(points, -tx, -ty, -(tx * ax + ty * ay) + total, 8);
  if (points.length < 2) return null;
  points = clip(points, tx, ty, tx * bx + ty * by + total, 9);
  if (points.length < 2) return null;
  const out = [];
  for (const [px, py, tag] of points) {
    const depth = nx * (px - ax) + ny * (py - ay), sep = depth - total;
    if (sep > margin) continue;
    // Halfway between the two surfaces.
    const refX = px - nx * (depth - ref.r), refY = py - ny * (depth - ref.r), incX = px - nx * inc.r, incY = py - ny * inc.r;
    out.push({ x: (refX + incX) / 2, y: (refY + incY) / 2, sep, id: (flip ? 4096 : 0) + edge * 64 + tag });
  }
  if (!out.length) return null;
  return { nx: flip ? -nx : nx, ny: flip ? -ny : ny, points: out, reference: flip ? 'b' : 'a', edge };
}

// A body's part against one pixel-obstacle segment: one-sided, so only the segment's open side pushes.
function partSegment(part, s, margin) {
  if (part.kind === 'circle') {
    const side = (part.x - s.ax) * s.nx + (part.y - s.ay) * s.ny;
    if (side > part.r + margin || side < -part.r) return null;
    const ex = s.bx - s.ax, ey = s.by - s.ay, t = ((part.x - s.ax) * ex + (part.y - s.ay) * ey) / (ex * ex + ey * ey);
    let nx = -s.nx, ny = -s.ny, sep = side - part.r, id = 0;
    if (t < 0 || t > 1) {
      const convex = t < 0 ? s.convexA : s.convexB;
      if (!convex || side < 0) return null;
      const qx = t < 0 ? s.ax : s.bx, qy = t < 0 ? s.ay : s.by, dx = qx - part.x, dy = qy - part.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d - part.r > margin) return null;
      if (d > 1e-9) { nx = dx / d; ny = dy / d; }
      sep = d - part.r; id = t < 0 ? 1 : 2;
    }
    const gap = part.r + sep / 2;
    return { nx, ny, points: [{ x: part.x + nx * gap, y: part.y + ny * gap, sep, id }] };
  }
  // A polygon's centre behind the segment, across from it, is inside the solid; the faces around it push. (Behind the
  // segment's line but past its end, it isn't: a long plank lying from the floor onto a low step has its centre below
  // the step's top, and dropping the step's faces let it sink into the step.)
  let cx = 0, cy = 0;
  for (let i = 0; i < part.n; i++) { cx += part.vx[i]; cy += part.vy[i]; }
  cx /= part.n; cy /= part.n;
  if ((cx - s.ax) * s.nx + (cy - s.ay) * s.ny < 0) {
    const ex = s.bx - s.ax, ey = s.by - s.ay, t = ((cx - s.ax) * ex + (cy - s.ay) * ey) / (ex * ex + ey * ey);
    if (t >= 0 && t <= 1) return null;
  }
  const m = polygonPolygon(part, s.part, margin);
  if (!m) return null;
  // Only the open face pushes: the segment's back face (its edge 1) never does, nor a normal leaning out of the solid.
  if (m.reference === 'b' && m.edge === 1) return null;
  if (m.nx * s.nx + m.ny * s.ny > -0.05) return null;
  return m;
}

// ---- Simulating -------------------------------------------------------------------------------------------------------
// A world of bodies, stepped a frame at a time: `advance(f)` runs frame f's substeps (none on frame 0) and its
// bookkeeping (hits, sleep, bodies that left, paths). `retrace(obstacles)` replaces the pixel obstacles, for a fluid
// whose obstacles move. `effect` holds { substeps, iterations, gravity, walls, obstacles, bodies } as readEffect reads
// them; a fluid changes a body's velocity between frames and wakes it (asleep = false, sleepy = 0).
export function createBodyWorld(effect, context) {
  const { width, height } = context, { substeps, iterations, gravity } = effect, dt = 1 / substeps, invDt = substeps;
  let world = traceObstacles(effect, width, height);
  const bodies = effect.bodies.map((b, index) => ({
    ...b, index, c: cosDeg(b.angle), s: sinDeg(b.angle), w: b.spin * RADIANS, x0: b.anchor ? b.anchor[0] : b.x, y0: b.anchor ? b.anchor[1] : b.y, angle0: b.angle,
    gone: false, sleepy: 0, hit: false, struck: false, colour: 0, hits: 0, history: [], poses: [], extent: Math.max(b.size[0], b.size[1]) / 2
  }));
  // Joints and ropes resolve their body indices to this world's bodies; cloths start at their authored places.
  const joints = (effect.joints ?? []).map(joint => {
    const a = joint.aIndex >= 0 ? bodies[joint.aIndex] : null, b = joint.bIndex >= 0 ? bodies[joint.bIndex] : null;
    return { ...joint, a, b, aIndex: a ? a.index : -1, bIndex: b ? b.index : -1, accN: 0, accA: 0, broken: false };
  });
  const ropes = (effect.ropes ?? []).map(rope => ({ ...rope, links: rope.linkIndices.map(index => bodies[index]), joints: rope.jointIndices.map(index => joints[index]) }));
  const chain = Math.max(0, ...ropes.map(rope => rope.links.length));
  const cloths = (effect.cloths ?? []).map(definition => createCloth(definition, { bodies }));
  // A cloth's solid test reads the live world grid, which a fluid may replace when its obstacles move.
  const solidAt = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return (ix < 0 && effect.walls.left) || (ix >= width && effect.walls.right) || (iy < 0 && effect.walls.top) || (iy >= height && effect.walls.bottom);
    return world.solid[iy * width + ix] === 1;
  };
  // The most bodies the world may hold once powers split them (the effect's `most`).
  const most = effect.most ?? LIMITS.bodies;
  // A tireless body's energy (motion and spin, plus height against gravity, per unit of mass), which every hit sets back:
  // the cheat that keeps a toy ball bouncing at full height in a ring of loose blocks, whose every knock would otherwise
  // cost it speed. (Without its spin, and only ever made up, a tireless box gained height at every bounce that set it
  // spinning, and flew out of the canvas.)
  const pull = b => b.weightless ? [0, 0] : gravity;
  const spinEnergy = b => (b.invInertia ? b.invMass / b.invInertia : 0) * b.w * b.w / 2;
  const energy = b => (b.vx * b.vx + b.vy * b.vy) / 2 + spinEnergy(b) - pull(b)[0] * b.x - pull(b)[1] * b.y;
  for (const b of bodies) if (b.tireless) b.energy = energy(b);
  bodies.forEach(place);
  // A body's shape scaled by k about its centre (the grow power): its mass follows its area, its inertia that squared.
  const scale = (b, k) => {
    b.parts = b.parts.map(part => (part.kind === 'circle' ? { kind: 'circle', r: part.r * k } : polygonPart(Array.from({ length: part.n }, (_, i) => [part.vx[i] * k, part.vy[i] * k]), part.r * k)));
    b.size = b.size.map(n => Math.max(1, Math.round(n * k))); b.extent *= k;
    if (b.invMass) b.invMass /= k * k;
    if (b.invInertia) b.invInertia /= k * k * k * k;
    place(b);
  };
  // A copy of a body (the split power), added after the others, while there is room.
  const copy = b => {
    if (bodies.length >= most) return null;
    const twin = { ...b, index: bodies.length, name: null, path: `${b.path} (split ${bodies.length})`, history: [], poses: [], held: undefined, hits: 0, hit: false, struck: false, sleepy: 0, asleep: false };
    place(twin); bodies.push(twin);
    return twin;
  };
  // A body broken into up to `count` pieces about the point `at` (in the world), while there is room for them: seeded
  // sites in its shape, drawn toward `at` so the pieces are smaller where it was hit. Each site's share of the shape (its
  // cell of the Voronoi diagram, cut to the outline) is a piece, a convex body of its own, and each pixel of the body's
  // picture goes with the piece of the nearest site, so the picture breaks with it and none of it is lost. A piece moves as
  // its part of the body moved (velocity and turning), flung `kick` pixels a frame away from `at`; a sliver that holds no
  // pixel of the picture is dust and is dropped. The body is gone and what rested on it wakes; pieces never break again.
  // Returns the number of pieces (none when it can't break into two).
  const shatter = (b, at, count, kick) => {
    if (b.gone || b.piece || b.shape === 'hoop') return 0;
    // A crowd at the effect's most breaks into fewer pieces, or none; the compile warns.
    if (most - bodies.length < count) stats.crowded.add(b);
    count = Math.min(count, most - bodies.length);
    if (count < 2) return 0;
    const outline = outlineOf(b), c = b.c, s = b.s;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of outline) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const inside = (x, y) => outline.every(([ax, ay], i) => { const [bx, by] = outline[(i + 1) % outline.length]; return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0; });
    // Where it was hit, in its own frame.
    const lx = at[0] - b.x, ly = at[1] - b.y, qx = c * lx + s * ly, qy = c * ly - s * lx;
    const sites = [];
    for (let k = 0; k < count; k++) {
      let px = 0, py = 0;
      for (let t = 0; t < 32; t++) {
        const x = x0 + (x1 - x0) * random(BREAK_SALT, b.index, current, k, t, 1), y = y0 + (y1 - y0) * random(BREAK_SALT, b.index, current, k, t, 2);
        if (inside(x, y)) { px = x; py = y; break; }
      }
      const pull = 0.3 + 0.7 * random(BREAK_SALT, b.index, current, k, 3);
      sites.push([qx + (px - qx) * pull, qy + (py - qy) * pull]);
    }
    const { rows, cx, cy } = pictureOf(b, context.symbols ?? {});
    let cells, pixels, drawn = 0;
    for (const row of rows) for (const ch of row) if (ch !== '.' && ch !== ' ') drawn++;
    // A piece too small to read (a sliver of a pixel or two, which would only flicker) gives its site up, and the cut is
    // made again without it, so its neighbours take its share and every piece stays one convex body.
    const least = Math.max(4, Math.round(drawn / (3 * count)));
    for (;;) {
      cells = sites.map(([sx, sy], i) => {
        let cell = outline;
        for (let j = 0; j < sites.length && cell.length; j++) {
          if (j === i) continue;
          const dx = sites[j][0] - sx, dy = sites[j][1] - sy;
          if (dx * dx + dy * dy < 1e-9) { if (j < i) cell = []; continue; }
          cell = clipHalf(cell, (sx + sites[j][0]) / 2, (sy + sites[j][1]) / 2, dx, dy);
        }
        return cell.length ? tidy(cell) : [];
      });
      pixels = cells.map(() => []);
      rows.forEach((row, v) => {
        for (let u = 0; u < row.length; u++) {
          if (row[u] === '.' || row[u] === ' ') continue;
          const x = u + 0.5 - cx, y = v + 0.5 - cy;
          let best = -1, near = Infinity;
          sites.forEach(([sx, sy], k) => { const d = (x - sx) * (x - sx) + (y - sy) * (y - sy); if (cells[k].length && d < near) { near = d; best = k; } });
          if (best >= 0) pixels[best].push([u, v, row[u]]);
        }
      });
      let weakest = -1;
      pixels.forEach((list, k) => { if (list.length < least && (weakest < 0 || list.length < pixels[weakest].length)) weakest = k; });
      if (weakest < 0 || sites.length <= 2) break;
      sites.splice(weakest, 1);
    }
    const part = b.parts[0], density = b.fixed ? 1 : 1 / (b.invMass * (part.kind === 'circle' ? PI * part.r * part.r : polygonMass(outline).area));
    const pieces = [];
    cells.forEach((cell, k) => {
      if (!cell.length || !pixels[k].length) return;
      const { area, cx: mx, cy: my, second } = polygonMass(cell);
      // The piece's place is the half pixel nearest its centroid, the middle of its picture: its pixels, padded evenly.
      const gx = Math.round(2 * (cx + mx)) / 2, gy = Math.round(2 * (cy + my)) / 2;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [u, v] of pixels[k]) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const L = Math.max(gx - u0, u1 + 1 - gx), M = Math.max(gy - v0, v1 + 1 - gy), picture = Array.from({ length: 2 * M }, () => Array(2 * L).fill('.'));
      for (const [u, v, ch] of pixels[k]) picture[v - (gy - M)][u - (gx - L)] = ch;
      const ox = gx - cx, oy = gy - cy, local = cell.map(([x, y]) => [x - ox, y - oy]), mass = density * area;
      const inertia = (second + area * ((mx - ox) * (mx - ox) + (my - oy) * (my - oy))) / area;
      let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
      for (const [x, y] of local) { px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x); py1 = Math.max(py1, y); }
      const size = [Math.max(1, Math.round(px1 - px0)), Math.max(1, Math.round(py1 - py0))];
      // Its offset from the body's centre in the world, and the way from where the body was hit to its centroid.
      const wx = c * ox - s * oy, wy = s * ox + c * oy, fx = c * (mx - qx) - s * (my - qy), fy = s * (mx - qx) + c * (my - qy), f = Math.sqrt(fx * fx + fy * fy);
      const x = b.x + wx, y = b.y + wy;
      pieces.push({
        ...b, name: null, shape: 'polygon', parts: [polygonPart(local)], size, extent: Math.max(size[0], size[1]) / 2, fixed: false, x, y, x0: x, y0: y,
        vx: b.vx - b.w * wy + (f > 1e-6 ? kick * fx / f : 0), vy: b.vy + b.w * wx + (f > 1e-6 ? kick * fy / f : 0), spin: 0,
        invMass: 1 / mass, invInertia: 1 / (mass * inertia), symbol: null, rows: picture.map(row => row.join('')), fills: null, fillEvery: null, outline: null, colour: 0,
        trail: null, smear: null, speed: null, tireless: false, energy: undefined, breaks: null, piece: true, pivot: null, anchor: null, drift: null, cuts: false,
        gone: false, asleep: false, sleepy: 0, hit: false, struck: false, hits: 0, history: [], poses: [], held: undefined, rested: b.rested ? { ...b.rested } : undefined
      });
    });
    if (pieces.length < 2) return 0;
    pieces.forEach((piece, k) => { piece.index = bodies.length; piece.path = `${b.path} (piece ${k})`; place(piece); bodies.push(piece); });
    b.gone = true;
    stats.broken.push({ body: b.name ?? b.path, frame: current, pieces: pieces.length });
    rouse([b]);
    return pieces.length;
  };
  // Territory and powers (territory.js): cells owned by teams, pickups, events and strikes.
  // A body a power is about to move or reshape wakes, and so does what leans on it where it is; what it touches where the
  // power leaves it wakes once it is placed there (see advance).
  const stirred = [];
  const stir = b => { rouse([b]); b.asleep = false; b.sleepy = 0; stirred.push(b); };
  const turf = effect.territory || [effect.pickups, effect.events, effect.strikes].some(list => list && list.length) ? createTerritory(effect, { trace: traceGrid, scale, copy, shatter: (b, at, count) => shatter(b, at, count, b.breaks ? b.breaks.speed : 0.5), stir, energy, width, height, fastest: MAX_SPEED }) : null;
  // A body that cuts passes through what it cuts, so it is drawn over it (paintBodies draws it last): in the frames its
  // strike works in, as it cuts. (Marked once for the whole run, a blade whose cut had not begun, or was over, was still
  // drawn over the balls it pushed.)
  const cutting = f => { const by = turf.cutters(f); for (const r of effect.strikes ?? []) if (r.cut) bodies[r.by].cuts = by.includes(r.by); };
  let current = 0;
  const dynamic = b => !b.fixed && !b.gone;
  const moving = b => b.fixed ? (b.vx !== 0 || b.vy !== 0 || b.spin !== 0) : !b.gone && !b.asleep;
  const awake = b => !b.fixed && !b.gone && !b.asleep;
  let warm = new Map();
  const stats = { hits: 0, escaped: [], rest: null, overlaps: [], paths: {}, broken: [], jointBreaks: [], crowded: new Set() };
  // Bodies that break when knocked (see shatter); their pieces don't.
  const breakable = bodies.some(b => b.breaks);
  const round = v => Math.round(v * 100) / 100;
  for (const b of bodies) if (b.name !== null && !b.fixed) stats.paths[b.name] = [];
  let time = 0;

  // Contacts between bodies (pairs in index order) and between each awake body and the segments near it. The pairs come
  // from a grid: each live body's bounds are binned into square cells (each cell's list in index order), and each body
  // is tried against the later bodies in the cells its bounds reach, widened by the most a pair can close in a substep.
  // (Swept along x alone, every ball in a pile was tried against every ball in its columns, and sorting those pairs
  // took as long again: two thirds of a frame at 800 balls.)
  const speed = b => b.fixed ? Math.sqrt(b.vx * b.vx + b.vy * b.vy) + Math.abs(b.w) * b.extent : b.asleep ? 0 : Math.sqrt(b.vx * b.vx + b.vy * b.vy) + Math.abs(b.w) * b.extent;
  let seen = new Int32Array(0), cellStart = new Int32Array(0), cellItems = new Int32Array(0);
  const near = [];
  // A pair's contacts, a before b in index order: an awake body meets anything; a moving fixed body meets sleeping ones,
  // to wake them; two fixed bodies never meet.
  const pairWith = (a, b, speeds, contacts) => {
    if (a.fixed && b.fixed) return;
    if (!awake(a) && !awake(b) && !(a.asleep && b.fixed && moving(b)) && !(b.asleep && a.fixed && moving(a))) return;
    const margin = (speeds[a.index] + speeds[b.index]) * dt + 0.1;
    if (!overlaps(a.box, b.box, margin)) return;
    a.world.forEach((pa, ia) => b.world.forEach((pb, ib) => {
      if (!overlaps(partBox(pa), partBox(pb), margin)) return;
      let m;
      if (pa.kind === 'circle' && pb.kind === 'circle') {
        const ux = b.vx - a.vx, uy = b.vy - a.vy, u = Math.sqrt(ux * ux + uy * uy);
        m = circleCircle(pa, pb, margin, u > 1e-9 ? [ux / u, uy / u] : undefined);
      }
      else if (pa.kind === 'circle') { m = polygonCircle(pb, pa, margin); if (m) { m.nx = -m.nx; m.ny = -m.ny; } }
      else if (pb.kind === 'circle') m = polygonCircle(pa, pb, margin);
      else m = polygonPolygon(pa, pb, margin);
      if (m) contacts.push({ a, b, key: `${a.index}:${b.index}:${ia}:${ib}`, ...m, bounce: Math.max(a.bounce, b.bounce), friction: Math.sqrt(a.friction * b.friction) });
    }));
  };
  const collide = () => {
    const contacts = [], count = bodies.length, speeds = new Float64Array(count);
    let fastest = 0, gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity, live = 0;
    for (const b of bodies) {
      if (b.gone) continue;
      const v = speed(b); speeds[b.index] = v; if (v > fastest) fastest = v; live++;
      gx0 = Math.min(gx0, b.box[0]); gy0 = Math.min(gy0, b.box[1]); gx1 = Math.max(gx1, b.box[2]); gy1 = Math.max(gy1, b.box[3]);
    }
    const reach = 2 * fastest * dt + 0.1;
    if (live > 1) {
      // Cells of at least 4 pixels, coarser where the bodies spread so far that the grid would pass 65,536 cells.
      const cell = Math.max(4, Math.sqrt((gx1 - gx0 + 1) * (gy1 - gy0 + 1) / 65536)), columns = Math.floor((gx1 - gx0) / cell) + 1, rows = Math.floor((gy1 - gy0) / cell) + 1;
      const column = x => Math.max(0, Math.min(columns - 1, Math.floor((x - gx0) / cell))), row = y => Math.max(0, Math.min(rows - 1, Math.floor((y - gy0) / cell)));
      if (cellStart.length < columns * rows + 1) cellStart = new Int32Array(columns * rows + 1); else cellStart.fill(0, 0, columns * rows + 1);
      let total = 0;
      for (const b of bodies) if (!b.gone) for (let j = row(b.box[1]); j <= row(b.box[3]); j++) for (let i = column(b.box[0]); i <= column(b.box[2]); i++) { cellStart[j * columns + i + 1]++; total++; }
      for (let c = 0; c < columns * rows; c++) cellStart[c + 1] += cellStart[c];
      if (cellItems.length < total) cellItems = new Int32Array(total);
      const fill = cellStart.slice(0, columns * rows);
      for (const b of bodies) if (!b.gone) for (let j = row(b.box[1]); j <= row(b.box[3]); j++) for (let i = column(b.box[0]); i <= column(b.box[2]); i++) cellItems[fill[j * columns + i]++] = b.index;
      if (seen.length < count) seen = new Int32Array(count);
      seen.fill(-1, 0, count);
      for (const a of bodies) {
        if (a.gone) continue;
        near.length = 0;
        for (let j = row(a.box[1] - reach); j <= row(a.box[3] + reach); j++) for (let i = column(a.box[0] - reach); i <= column(a.box[2] + reach); i++) {
          for (let k = cellStart[j * columns + i], end = cellStart[j * columns + i + 1]; k < end; k++) {
            const other = cellItems[k];
            if (other <= a.index || seen[other] === a.index) continue;
            seen[other] = a.index; near.push(other);
          }
        }
        near.sort((p, q) => p - q);
        for (const index of near) pairWith(a, bodies[index], speeds, contacts);
      }
    }
    for (const a of bodies) {
      if (!dynamic(a) || a.asleep) continue;
      const margin = speeds[a.index] * dt + 0.1, [x0, y0, x1, y1] = a.box;
      for (const index of world.near(x0 - margin, y0 - margin, x1 + margin, y1 + margin)) {
        const s = world.segments[index];
        a.world.forEach((pa, ia) => {
          const m = partSegment(pa, s, margin);
          if (m) contacts.push({ a, b: null, key: `${a.index}:s${index}:${ia}`, face: s, ...m, bounce: Math.max(a.bounce, s.bounce), friction: Math.sqrt(a.friction * s.friction), soft: s.soft, move: s.move });
        });
      }
      // Cells of the other teams' territory are walls to it.
      if (turf) for (const { s, key } of turf.near(a, x0 - margin, y0 - margin, x1 + margin, y1 + margin)) {
        a.world.forEach((pa, ia) => {
          const m = partSegment(pa, s, margin);
          if (m) contacts.push({ a, b: null, key: `${a.index}:${key}:${ia}`, ...m, bounce: Math.max(a.bounce, s.bounce), friction: Math.sqrt(a.friction * s.friction), cell: s });
        });
      }
    }
    return contacts;
  };

  const velocityAt = (b, rx, ry) => b ? [b.vx - b.w * ry, b.vy + b.w * rx] : [0, 0];
  const solid = b => !b || b.fixed || b.asleep;
  // An impulse on a contact moves each side by the inverse mass and inertia it is solved with (contact.ma … ib, set as
  // each substep prepares its contacts: none for a solid side).
  const apply = (contact, point, px, py) => {
    const { a, b, ma, ia, mb, ib } = contact;
    if (ma || ia) { a.vx -= ma * px; a.vy -= ma * py; a.w -= ia * (point.rax * py - point.ray * px); }
    if (mb || ib) { b.vx += mb * px; b.vy += mb * py; b.w += ib * (point.rbx * py - point.rby * px); }
  };
  // A moving obstacle's face moves at its velocity (contact.move).
  const relative = (contact, point) => {
    const [vax, vay] = velocityAt(contact.a, point.rax, point.ray), [vbx, vby] = contact.b || !contact.move ? velocityAt(contact.b, point.rbx, point.rby) : contact.move;
    return [vbx - vax, vby - vay];
  };
  const solve = (contacts, bias) => {
    for (const contact of contacts) {
      const { nx, ny } = contact, tx = ny, ty = -nx;
      for (const point of contact.points) {
        const [dvx, dvy] = relative(contact, point), vn = dvx * nx + dvy * ny;
        let target;
        if (point.sep > 0) target = point.sep * invDt;
        // Soft ground (a fluid's resting sand) stops a body sinking into it but never shoves one out of it, so sand that runs
        // in under a plank doesn't jack it up.
        else if (bias && !contact.soft) target = Math.max(BIAS * Math.min(0, point.sep + SLOP) * invDt, -MAX_PUSH);
        else target = 0;
        const old = point.normal, next = Math.max(old - point.normalMass * (vn + target), 0), impulse = next - old;
        point.normal = next; point.most = Math.max(point.most, next);
        apply(contact, point, nx * impulse, ny * impulse);
      }
      for (const point of contact.points) {
        const [dvx, dvy] = relative(contact, point), vt = dvx * tx + dvy * ty, limit = contact.friction * point.normal;
        const old = point.tangent, next = Math.max(-limit, Math.min(limit, old - point.tangentMass * vt)), impulse = next - old;
        point.tangent = next;
        apply(contact, point, tx * impulse, ty * impulse);
      }
    }
  };

  // Restitution on a contact's two points at once (a 2 × 2 block), so both leave at their bounce together; false where
  // the block's answer would pull rather than push.
  const bounceBoth = contact => {
    const [p, q] = contact.points, { nx, ny, ma, ia, mb, ib } = contact;
    const pa = p.rax * ny - p.ray * nx, pb = p.rbx * ny - p.rby * nx, qa = q.rax * ny - q.ray * nx, qb = q.rbx * ny - q.rby * nx;
    const k11 = ma + mb + ia * pa * pa + ib * pb * pb, k22 = ma + mb + ia * qa * qa + ib * qb * qb, k12 = ma + mb + ia * pa * qa + ib * pb * qb, det = k11 * k22 - k12 * k12;
    if (!(det > 1e-9 * k11 * k22)) return false;
    const along = point => { const [dvx, dvy] = relative(contact, point); return dvx * nx + dvy * ny; };
    const bp = -(along(p) + contact.bounce * p.approach), bq = -(along(q) + contact.bounce * q.approach);
    const xp = (k22 * bp - k12 * bq) / det, xq = (k11 * bq - k12 * bp) / det;
    if (p.normal + xp < 0 || q.normal + xq < 0) return false;
    p.normal += xp; q.normal += xq;
    apply(contact, p, nx * xp, ny * xp); apply(contact, q, nx * xq, ny * xq);
    return true;
  };
  // An approach faster than this is an impact, that bounces and counts as a hit: REST_SPEED, or more where a substep of
  // gravity alone adds more (with one substep and strong gravity, a resting body was hit at every substep, changed colour
  // every frame and never slept).
  const gravityLength = Math.sqrt(gravity[0] * gravity[0] + gravity[1] * gravity[1]), impact = Math.max(REST_SPEED, 1.5 * gravityLength * dt);
  // A woken body wakes the sleeping bodies it touches, and they theirs, as a stack is held up by its neighbours: a
  // knocked crate pushes the crates beside it instead of the still ones holding it as a wall. A weightless body leans
  // on nothing, so it wakes only when something moves into it.
  const rouse = woken => {
    for (const queue = [...woken]; queue.length;) {
      const w = queue.shift();
      for (const o of bodies) if (o.asleep && !o.weightless && !o.gone && overlaps(w.box, o.box, 0.25)) { o.asleep = false; o.sleepy = 0; queue.push(o); }
    }
  };
  // Fixed bodies move exactly as their velocity and spin say; one with a pivot turns about it, its centre and its centre's
  // velocity following.
  const placeMoving = () => {
    for (const b of bodies) if (b.fixed && moving(b)) {
      const a = b.angle0 + b.spin * time; b.c = cosDeg(a); b.s = sinDeg(a);
      if (b.pivot) {
        const dx = -(b.c * b.pivot[0] - b.s * b.pivot[1]), dy = -(b.s * b.pivot[0] + b.c * b.pivot[1]);
        b.x = b.x0 + b.drift[0] * time + dx; b.y = b.y0 + b.drift[1] * time + dy; b.vx = b.drift[0] - b.w * dy; b.vy = b.drift[1] + b.w * dx;
      } else { b.x = b.x0 + b.vx * time; b.y = b.y0 + b.vy * time; }
      place(b);
    }
  };
  // A cutter (a strike's body with a cut, in its frames) passes through the free bodies it meets, as a blade through
  // fruit: their contacts are left out of the solve, and one that touches, or closes to a touch within the substep,
  // strikes the body, with the way behind the cutter there (against its face's motion past the body). Pushed instead,
  // what it struck was swept along ahead of it, and so were the pieces it split it into.
  const cutters = turf ? turf.cutters : null;
  const cut = contacts => {
    const by = cutters(current);
    if (!by.length) return contacts;
    return contacts.filter(contact => {
      const { a, b } = contact, blade = !b ? null : by.includes(a.index) && !b.fixed ? a : by.includes(b.index) && !a.fixed ? b : null;
      if (!blade) return true;
      const other = blade === a ? b : a;
      for (const point of contact.points) {
        const [vax, vay] = velocityAt(a, point.x - a.x, point.y - a.y), [vbx, vby] = velocityAt(b, point.x - b.x, point.y - b.y);
        if (point.sep + Math.min(0, (vbx - vax) * contact.nx + (vby - vay) * contact.ny) * dt >= 0) continue;
        const [fx, fy] = velocityAt(blade, point.x - blade.x, point.y - blade.y), [ox, oy] = velocityAt(other, point.x - other.x, point.y - other.y);
        const ux = fx - ox, uy = fy - oy, u = Math.sqrt(ux * ux + uy * uy), side = blade === a ? 1 : -1;
        turf.strike(a, b, u > 1e-6 ? [-ux / u, -uy / u] : [contact.nx * side, contact.ny * side]);
        break;
      }
      return false;
    });
  };
  const substep = () => {
    placeMoving();
    wakeJoints(joints);
    let contacts = collide();
    // Bodies joined by a joint with collide: false pass through each other (the links of a rope, a ragdoll's neighbours).
    const skip = jointPairs(joints.filter(joint => !joint.broken));
    if (skip.size) contacts = contacts.filter(contact => !(contact.b && skip.has(pairKey(contact.a.index, contact.b.index))));
    if (cutters) contacts = cut(contacts);
    // A body moving into a sleeping one wakes it; so does anything moving that it rests on, and a fixed body that moves
    // at all (a platform sinking slowly from under a box, or one turning under it, would leave it asleep in the air).
    const woken = new Set();
    for (const contact of contacts) {
      const { a, b } = contact;
      if (!b) continue;
      for (const [sleeper, other] of [[a, b], [b, a]]) {
        if (!sleeper.asleep || !moving(other)) continue;
        const point = contact.points[0], rax = point.x - a.x, ray = point.y - a.y, rbx = point.x - b.x, rby = point.y - b.y;
        const [vax, vay] = velocityAt(a, rax, ray), [vbx, vby] = velocityAt(b, rbx, rby), vn = (vbx - vax) * contact.nx + (vby - vay) * contact.ny;
        const otherSpeed = Math.sqrt(other.vx * other.vx + other.vy * other.vy) + Math.abs(other.w) * other.extent;
        if (vn < -WAKE_SPEED || other.fixed || (!sleeper.weightless && otherSpeed > 4 * SLEEP_SPEED)) { sleeper.asleep = false; sleeper.sleepy = 0; woken.add(sleeper); }
      }
    }
    rouse(woken);
    // Woken bodies meet what they touch this substep too: gathered while they slept, a stack knocked from the side had
    // no contacts among its crates or with the floor, and its crates sank half a pixel into each other.
    if (woken.size) { contacts = collide(); if (cutters) contacts = cut(contacts); }
    // Velocities: gravity, drag, and the speed limits.
    for (const b of bodies) {
      if (!dynamic(b) || b.asleep) continue;
      if (!b.weightless) { b.vx += gravity[0] * dt; b.vy += gravity[1] * dt; }
      if (turf) turf.pull(b, dt);
      // A force from outside the solver (a fluid's load and grip, and its lift where the body has no level to float at),
      // steady through the frame as gravity is.
      if (b.push) { b.vx += b.push[0] * dt; b.vy += b.push[1] * dt; b.w += b.push[2] * dt; }
      // A liquid's lift, from the body's shape under the level it floats at as it is now (fluid.js holds the level for
      // the frame), so the lift follows the body as it bobs and rolls within a frame.
      if (b.float) {
        const f = b.float, [area, cx, cy] = areaBeyond(b, f.axis, f.level, f.sign);
        b.vx -= area * f.gx / f.mass * dt; b.vy -= area * f.gy / f.mass * dt;
        if (f.inertia) b.w += ((cx - b.x) * -area * f.gy - (cy - b.y) * -area * f.gx) / f.inertia * dt;
      }
      if (b.drag) { const k = 1 / (1 + b.drag * dt); b.vx *= k; b.vy *= k; }
      if (b.spinDrag) b.w *= 1 / (1 + b.spinDrag * dt);
      const v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 > MAX_SPEED * MAX_SPEED) { const k = MAX_SPEED / Math.sqrt(v2); b.vx *= k; b.vy *= k; }
      const spinLimit = 2 * MAX_SPEED / Math.max(0.5, b.extent);
      if (b.w > spinLimit) b.w = spinLimit; else if (b.w < -spinLimit) b.w = -spinLimit;
    }
    // Prepare each point: its arms, the approach speed it bounces from, the masses it is solved with and the impulses it
    // starts with.
    const next = new Map();
    for (const contact of contacts) {
      const { a, b, nx, ny } = contact, tx = ny, ty = -nx;
      let ma = solid(a) ? 0 : a.invMass, ia = solid(a) ? 0 : a.invInertia, mb = solid(b) ? 0 : b.invMass, ib = solid(b) ? 0 : b.invInertia;
      for (const point of contact.points) {
        point.rax = point.x - a.x; point.ray = point.y - a.y; point.rbx = b ? point.x - b.x : 0; point.rby = b ? point.y - b.y : 0;
        const [dvx, dvy] = relative(contact, point);
        point.approach = dvx * nx + dvy * ny;
      }
      // A free body resting on top of a much lighter one (the contact faces within 60 degrees of gravity, and no point is
      // an impact) is solved as if it weighed at most HEAVIER times the lighter. Sequential impulses settle a load as
      // slowly as the weights under it differ: a plank 50 times as dense as the balls under it sank into them, was pushed
      // out fast enough to bounce, and hopped for ever, and a heavy box on a light one slid off it. A heavy body that hits
      // or shoves light ones keeps its true weight, so it still ploughs through them.
      const down = contact.b && gravityLength > 0 ? (nx * gravity[0] + ny * gravity[1]) / gravityLength : 0;
      if (ma && mb && Math.abs(down) > 0.5 && contact.points.every(point => point.approach >= -impact)) {
        // The normal points from a to b: down along gravity, b is under a.
        if (down > 0.5 && ma * HEAVIER < mb) { const k = mb / (HEAVIER * ma); ma *= k; ia *= k; }
        else if (down < -0.5 && mb * HEAVIER < ma) { const k = ma / (HEAVIER * mb); mb *= k; ib *= k; }
      }
      contact.ma = ma; contact.ia = ia; contact.mb = mb; contact.ib = ib;
      for (const point of contact.points) {
        const ran = point.rax * ny - point.ray * nx, rbn = point.rbx * ny - point.rby * nx, rat = point.rax * ty - point.ray * tx, rbt = point.rbx * ty - point.rby * tx;
        const kn = ma + mb + ia * ran * ran + ib * rbn * rbn, kt = ma + mb + ia * rat * rat + ib * rbt * rbt;
        point.normalMass = kn > 0 ? 1 / kn : 0; point.tangentMass = kt > 0 ? 1 / kt : 0;
        // A face is known by its number, and a retrace numbers the faces afresh: a push kept from another way a face
        // looked is not this face's (a ball in a corner took the floor's push from the wall beside it, and was kicked
        // along the floor). One kept from a face looking the same way starts the solve as well as its own would.
        const saved = warm.get(`${contact.key}:${point.id}`), { face } = contact, kept = saved && (!face || (saved[2] === face.nx && saved[3] === face.ny)) ? saved : null;
        point.normal = kept ? kept[0] : 0; point.tangent = kept ? kept[1] : 0; point.most = 0;
      }
    }
    for (const contact of contacts) for (const point of contact.points) {
      const { nx, ny } = contact;
      apply(contact, point, nx * point.normal + ny * point.tangent, ny * point.normal - nx * point.tangent);
    }
    resetJoints(joints);
    for (let k = 0; k < iterations; k++) { solve(contacts, true); solveJoints(joints, dt, 1); }
    // A pull travels along a chain one joint a pass, so a rope of many links gets as many more passes as its longest
    // chain has links: without them each link stays a little stretched and a rope of 64 hangs half as long again.
    if (chain) solveJoints(joints, dt, chain);
    // Positions, at no more than the speed limit (bodies started on top of each other were thrown at twice it).
    for (const b of bodies) {
      if (!dynamic(b) || b.asleep) continue;
      const v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 > MAX_SPEED * MAX_SPEED) { const k = MAX_SPEED / Math.sqrt(v2); b.vx *= k; b.vy *= k; }
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.w) {
        const turn = b.w * dt, c = b.c - b.s * turn, s = b.s + b.c * turn, m = Math.sqrt(c * c + s * s);
        b.c = c / m; b.s = s / m;
      }
      place(b);
    }
    // Joints correct the drift a velocity solve leaves, then their bodies are placed again for contacts and drawing.
    if (joints.length) { correctJoints(joints); for (const b of bodies) if (!b.gone) place(b); }
    // Relax: the push out of overlaps leaves no velocity behind.
    for (let k = 0; k < Math.max(1, iterations >> 1); k++) solve(contacts, false);
    // Restitution, from the approach speed before the solve, on points that pushed. An approach slower than `impact`
    // doesn't bounce, so a dropped ball settles; a body with a held speed bounces at any approach (it slid along a wall
    // it met at a glance, kept there for hundreds of frames by its held speed). A contact's two points that both bounce
    // are solved together, so a box landing flat leaves flat: one at a time, the second was often already moving apart
    // and the first alone pushed back, setting the box spinning.
    for (const contact of contacts) {
      if (contact.bounce === 0) continue;
      const { nx, ny } = contact, least = contact.a.speed || (contact.b && contact.b.speed) ? 1e-9 : impact;
      if (contact.points.length === 2 && contact.points.every(point => point.approach < -least) && contact.points.some(point => point.most > 0) && bounceBoth(contact)) continue;
      for (const point of contact.points) {
        if (point.approach > -least || point.most === 0) continue;
        const [dvx, dvy] = relative(contact, point), vn = dvx * nx + dvy * ny;
        const old = point.normal, more = Math.max(old - point.normalMass * (vn + contact.bounce * point.approach), 0), impulse = more - old;
        point.normal = more;
        apply(contact, point, nx * impulse, ny * impulse);
      }
    }
    // How hard each body that breaks was knocked this substep, and where: at each point where something met it, the speed
    // the two met at (with its bounce), shared out as easily as each side gives there (its weight and its turning about
    // its centre both resist, so a box landing on a corner is knocked as hard as one landing flat, and a pebble barely
    // knocks a heavy vase). Measured from the speed they met at, not the pushes the solve passed on, so a knock breaks what
    // it hits and not every crate in the row behind it at once: those break, if they do, as the pieces hit them.
    const knocks = breakable ? new Map() : null;
    const give = (body, rx, ry, nx, ny) => { const arm = rx * ny - ry * nx; return body.invMass + body.invInertia * arm * arm; };
    for (const contact of contacts) for (const point of contact.points) {
      next.set(`${contact.key}:${point.id}`, contact.face ? [point.normal, point.tangent, contact.face.nx, contact.face.ny] : [point.normal, point.tangent]);
      if (point.approach < -impact && point.most > 0) { contact.a.hit = contact.a.struck = true; if (contact.b) contact.b.hit = contact.b.struck = true; }
      // A strike's body strikes what it pushes, a hit or not: a blade that sweeps a ball along a wall keeps striking it.
      if (turf && contact.b && point.most > 0) turf.strike(contact.a, contact.b);
      if (knocks && point.approach < 0 && (contact.a.breaks || (contact.b && contact.b.breaks))) {
        const { a, b, nx, ny } = contact, ka = solid(a) ? 0 : give(a, point.rax, point.ray, nx, ny), kb = solid(b) ? 0 : give(b, point.rbx, point.rby, nx, ny);
        for (const [body, k] of [[a, ka], [b, kb]]) {
          if (!body || !body.breaks || !k) continue;
          const speed = -point.approach * (1 + contact.bounce) * k / (ka + kb);
          if (speed > (knocks.get(body)?.speed ?? 0)) knocks.set(body, { speed, at: [point.x, point.y] });
        }
      }
    }
    // The cells hit change hands; a body with a held speed goes on at it, along its own heading.
    if (turf) { for (const contact of contacts) if (contact.cell) turf.hit(contact, contact.cell); turf.settle(bodies); }
    for (const b of bodies) {
      if (!b.speed || !dynamic(b) || b.asleep) continue;
      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (v > 1e-9) { b.vx *= b.speed / v; b.vy *= b.speed / v; }
    }
    for (const b of bodies) {
      if (!b.struck) continue;
      b.struck = false;
      if (!b.tireless || b.asleep || b.gone) continue;
      const [gx, gy] = pull(b), want = 2 * (b.energy + gx * b.x + gy * b.y - spinEnergy(b)), has = b.vx * b.vx + b.vy * b.vy;
      if (want > 0 && has > 1e-12) { const k = Math.sqrt(want / has); b.vx *= k; b.vy *= k; }
    }
    // Bodies knocked harder than they hold break, in body order, as they move after the knock.
    if (knocks) for (const [b, knock] of [...knocks].sort((p, q) => p[0].index - q[0].index)) if (knock.speed >= b.breaks.at) shatter(b, knock.at, b.breaks.pieces, b.breaks.speed);
    if (joints.length) breakJoints(joints, current, stats.jointBreaks);
    warm = next;
    time += dt;
  };

  // The first frame's overlaps, reported as warnings: bodies that start inside each other or an obstacle.
  for (const contact of collide()) {
    const pair = contact.b ? `${contact.a.path} starts inside ${contact.b.path}` : `${contact.a.path} starts inside an obstacle or wall`;
    if (contact.points.some(p => p.sep < -0.5) && !stats.overlaps.includes(pair)) stats.overlaps.push(pair);
  }
  const advance = f => {
    current = f;
    if (f > 0) for (let k = 0; k < substeps; k++) substep();
    // Moving fixed bodies are drawn (and met by a fluid) where they are at the frame's end, not where its last substep
    // started: a paddle drawn a substep behind showed a gap before the box it pushed.
    placeMoving();
    // Cloth steps with the frame, against the bodies where they now are. Its pins follow fixed bodies' end-of-frame places.
    if (f > 0) for (const cloth of cloths) stepCloth(cloth, f, { substeps, iterations, gravity, solidAt, bodies, width, height });
    // Powers run out and are taken, and the score is counted, between frames. What a body that vanished held up wakes.
    if (turf) {
      const was = bodies.map(b => b.gone);
      turf.frame(f, bodies);
      cutting(f);
      for (const b of bodies) if (!b.gone) place(b);
      rouse(bodies.filter((b, k) => k < was.length && b.gone && !was[k]));
      if (stirred.length) { rouse(stirred.filter(b => !b.gone)); stirred.length = 0; }
    }
    // Hits change colour once a frame (a fill list that steps with time doesn't); slow bodies fall
    // asleep; bodies far outside the canvas are gone. A named body's path has a place for every frame: null once it is gone.
    for (const b of bodies) {
      if (b.gone) { if (b.name !== null && !b.fixed) stats.paths[b.name].push(null); continue; }
      if (b.hit) { b.hits++; stats.hits++; if (b.fills && b.fills.length > 1 && !b.fillEvery) b.colour = (b.colour + 1) % b.fills.length; b.hit = false; }
      if (dynamic(b) && !b.asleep) {
        const fast = Math.max(Math.sqrt(b.vx * b.vx + b.vy * b.vy), Math.abs(b.w) * b.extent);
        b.sleepy = fast < SLEEP_SPEED ? b.sleepy + 1 : 0;
        if (b.sleepy >= SLEEP_FRAMES) { b.asleep = true; b.vx = 0; b.vy = 0; b.w = 0; }
      }
      const [x0, y0, x1, y1] = b.box;
      // Far past an open edge a body has left, unless gravity is bringing it back: a ball thrown over the top falls into
      // the picture again (it left for good at 16 pixels up, mid-flight). A weightless body never comes back.
      const back = b.weightless ? [0, 0] : gravity;
      if (!b.fixed && ((x1 < -GONE && !(back[0] > 0)) || (y1 < -GONE && !(back[1] > 0)) || (x0 > width + GONE && !(back[0] < 0)) || (y0 > height + GONE && !(back[1] < 0)))) { b.gone = true; stats.escaped.push({ body: b.name ?? b.path, frame: f }); }
      b.history.push([b.x, b.y]);
      if (b.name !== null && !b.fixed) stats.paths[b.name].push(b.gone ? null : [round(b.x), round(b.y), round(atan2Deg(b.s, b.c))]);
      if (b.history.length > 18) b.history.shift();
      if (b.smear) { b.poses.push([b.x, b.y, b.c, b.s]); if (b.poses.length > b.smear.frames + 1) b.poses.shift(); }
    }
    // The frame from which everything rests to the end: one that wakes later (a support taken away, a late hit) clears it.
    if (!(f > 0 && bodies.every(b => b.gone || b.fixed && !moving(b) || b.asleep) && cloths.every(cloth => cloth.rest !== null))) stats.rest = null;
    else if (stats.rest === null) stats.rest = f;
  };
  // New obstacles (a fluid's that move, or its resting sand) wake the sleeping bodies within a pixel of a hard pixel that
  // came or went, and those resting on them: a crate asleep on a shelf that slid away hung in the air, and one beside a
  // shelf rising into it was passed through.
  const retrace = obstacles => {
    const before = world.hard;
    world = traceObstacles({ obstacles, walls: effect.walls }, width, height);
    const woken = [];
    for (const b of bodies) {
      if (!b.asleep || b.gone || b.fixed) continue;
      const [x0, y0, x1, y1] = b.box;
      let moved = false;
      for (let y = Math.max(0, Math.floor(y0) - 1); y <= Math.min(height - 1, Math.floor(y1) + 1) && !moved; y++) {
        for (let x = Math.max(0, Math.floor(x0) - 1); x <= Math.min(width - 1, Math.floor(x1) + 1); x++) if (before[y * width + x] !== world.hard[y * width + x]) { moved = true; break; }
      }
      if (moved) { b.asleep = false; b.sleepy = 0; woken.push(b); }
    }
    rouse(woken);
  };
  // Obstacles from a grid kept elsewhere (a powder grid's solids), for the canvas pixels from (x, y), w × h of them:
  // `cell(px, py)` is 0 where a body may go, 1 for a hard pixel and 2 for a soft one (resting powder: it stops a body
  // sinking in but never shoves one out). Past those pixels the canvas is open, and past the canvas its walls are closed.
  // Sleeping bodies are not woken: the grid's keeper knows what moved under them.
  const HARD = { bounce: 0, friction: 0.6 }, SOFT = { bounce: 0, friction: 0.8, soft: true };
  const retraceCells = (x, y, w, h, cell) => {
    const { walls } = effect;
    const at = (i, j) => {
      const px = x + i, py = y + j;
      if (px < 0 || py < 0 || px >= width || py >= height) return (px < 0 && walls.left) || (px >= width && walls.right) || (py < 0 && walls.top) || (py >= height && walls.bottom);
      return i >= 0 && j >= 0 && i < w && j < h && cell(px, py) > 0;
    };
    const material = (i, j) => {
      const px = x + i, py = y + j;
      return px >= 0 && py >= 0 && px < width && py < height && i >= 0 && j >= 0 && i < w && j < h && cell(px, py) === 2 ? SOFT : HARD;
    };
    world = { ...traceGrid(at, material, w, h, 1, x, y, width, height), solid: world.solid, hard: world.hard };
  };
  // A body made elsewhere (a powder grid's loose piece) joins the world: `b` gives its parts (its own frame, about its
  // centre of mass), size, inverse mass and inertia, place, turn (c, s) and velocity; the rest starts as a new body's.
  const add = b => {
    const body = {
      name: null, path: 'piece', shape: 'polygon', fixed: false, angle: 0, spin: 0, vx: 0, vy: 0, w: 0, c: 1, s: 0, bounce: 0.1, friction: 0.6, drag: 0, spinDrag: 0,
      weightless: false, asleep: false, tireless: false, temperature: null, team: -1, speed: null, fills: null, fillEvery: null, outline: null, symbol: null,
      trail: null, smear: null, breaks: null, pivot: null, anchor: null, drift: null, ...b,
      index: bodies.length, gone: false, sleepy: 0, hit: false, struck: false, colour: 0, hits: 0, history: [], poses: []
    };
    body.x0 = body.x; body.y0 = body.y; body.angle0 = 0; body.extent ??= Math.max(body.size[0], body.size[1]) / 2;
    place(body); bodies.push(body);
    return body;
  };
  // Gone bodies are dropped and the rest numbered afresh, so a long live run doesn't carry every body it ever had.
  const compact = () => {
    const kept = bodies.filter(b => !b.gone);
    if (kept.length === bodies.length) return;
    bodies.length = 0;
    kept.forEach((b, index) => { b.index = index; bodies.push(b); });
    for (const joint of joints) { joint.aIndex = joint.a ? joint.a.index : -1; joint.bIndex = joint.b ? joint.b.index : -1; }
    warm = new Map();
  };
  return { bodies, stats, gravity, advance, turf, retrace, retraceCells, add, place, compact, joints, ropes, cloths };
}

// The bodies splits added to a world (the pieces of broken bodies are counted with them, under broken).
const copiesOf = (world, effect) => world.bodies.length - effect.bodies.length - world.stats.broken.reduce((sum, entry) => sum + entry.pieces, 0);
const clothFigures = cloths => cloths.length ? { cloths: cloths.map((cloth, index) => ({ name: cloth.definition.name ?? `cloth-${index}`, tears: cloth.tears, rest: cloth.rest })) } : {};
function simulate(effect, context) {
  const world = createBodyWorld(effect, context), drawn = [];
  for (let f = 0; f < effect.frames; f++) { world.advance(f); drawn.push(drawFrame(world, context.width, context.height, context, f, effect.hud)); }
  if (world.cloths.length) world.stats.cloths = clothFigures(world.cloths).cloths;
  return { drawn, stats: world.stats, turf: world.turf, steps: (effect.frames - 1) * effect.substeps, copies: copiesOf(world, effect) };
}

// ---- Drawing ----------------------------------------------------------------------------------------------------------
// A shape whose size is odd centres on a pixel's middle and an even one on a pixel corner, so a body at rest draws the
// same pixels as its sprite at angle 0 and moves in whole pixels.
const snap = (value, size) => (size % 2 ? Math.floor(value) + 0.5 : Math.round(value));
// A body steps to the next pixel it is drawn at as soon as it passes halfway there, the way it last stepped, but steps
// back only once it has moved HOLD past halfway, and its drawn angle likewise by TURN_HOLD of a step, so a body rocking
// about a boundary (a crate bobbing on water, a box settling) holds still instead of flickering between two pixels,
// while one sliding or turning steadily steps evenly. (Held both ways, a body moving about a pixel a frame was drawn
// 0, 2, 0, 2 pixels on.) A fluid's solid cells for it are where it really is (exactCells), and the fluid draws its
// liquid in those its drawing leaves uncovered.
const HOLD = 0.3, TURN_HOLD = 0.2, SIDES_BOW = 0.75;
// The drawn value `memory[key]` ({ at, way }) moves to `next`, the value `apart` from it now: at once the way it last
// moved, the other way only once `apart` is `back` or more. Its first step holds as a step back does.
function holdStep(memory, key, next, apart, back, extra = {}) {
  const was = memory[key];
  if (was === undefined) memory[key] = { at: next, way: 0, ...extra };
  else if (next !== was.at) {
    const way = Math.sign(next - was.at);
    if (way === was.way || apart >= back) memory[key] = { at: next, way, ...extra };
  }
  return memory[key].at;
}
function held(b, axis, size) {
  const value = axis ? b.y : b.x, memory = b.held ??= {}, key = `${axis}:${size}`;
  return holdStep(memory, key, snap(value, size), Math.abs(value - (memory[key]?.at ?? value)), 0.5 + HOLD);
}
// The drawing caches below live as long as the module (an MCP worker's whole life), so each is bounded: past CACHED
// entries it starts again. A moving hoop alone made a new ring for every pixel it moved, until memory ran out.
const CACHED = 512;
const bounded = map => { if (map.size >= CACHED) map.clear(); return map; };
const discs = new Map();
function disc(d) {
  if (!discs.has(d)) {
    const cells = [];
    for (let j = 0; j < d; j++) for (let i = 0; i < d; i++) { const u = (i + 0.5 - d / 2) / (d / 2), v = (j + 0.5 - d / 2) / (d / 2); if (u * u + v * v <= 1) cells.push([i, j]); }
    bounded(discs).set(d, cells);
  }
  return discs.get(d);
}

// A circle of pixels around a centre: one pixel thick, each column's top and bottom pixel on the top and bottom arcs
// where the arc runs flatter than the diagonal, and each row's outer pixels on the side arcs where it runs steeper, then
// any pixel with a neighbour across and one above or below dropped (the two meet corner to corner without it), so it is
// 8-connected with no doubled steps; thicker, every pixel whose centre lies within half the thickness of the circle.
// (Columns and rows stopped where the arc's middle crosses the diagonal, and a quarter of all rings, the spinning-hoop
// preset's among them, had a pixel missing at each diagonal.)
const rings = new Map();
// Cached about the centre's place within its pixel (a whole or half pixel) and moved to the centre, so a hoop that moves
// reuses one ring instead of making one for every pixel it passes.
function ring(x, y, r, thickness) {
  const ix = Math.floor(x), iy = Math.floor(y), at = cells => cells.map(([px, py]) => [px + ix, py + iy]);
  const cx = x - ix, cy = y - iy, key = `${cx},${cy},${r},${thickness}`;
  if (rings.has(key)) return at(rings.get(key));
  const seen = new Set(), cells = [], add = (px, py) => { if (!seen.has(py * 65536 + px)) { seen.add(py * 65536 + px); cells.push([px, py]); } };
  if (thickness <= 1) {
    for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
      const dx = px + 0.5 - cx;
      if (Math.abs(dx) > r) continue;
      const dy = Math.sqrt(r * r - dx * dx);
      for (const py of [Math.floor(cy - dy), Math.floor(cy + dy)]) if (Math.abs(py + 0.5 - cy) >= Math.abs(dx)) add(px, py);
    }
    for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
      const dy = py + 0.5 - cy;
      if (Math.abs(dy) > r) continue;
      const dx = Math.sqrt(r * r - dy * dy);
      for (const px of [Math.floor(cx - dx), Math.floor(cx + dx)]) if (Math.abs(px + 0.5 - cx) >= Math.abs(dy)) add(px, py);
    }
    const kept = [];
    for (const [px, py] of cells) {
      const across = seen.has(py * 65536 + px - 1) || seen.has(py * 65536 + px + 1), upDown = seen.has((py - 1) * 65536 + px) || seen.has((py + 1) * 65536 + px);
      if (across && upDown) seen.delete(py * 65536 + px); else kept.push([px, py]);
    }
    cells.length = 0; cells.push(...kept);
  } else {
    const half = thickness / 2;
    for (let py = Math.floor(cy - r - half); py <= Math.ceil(cy + r + half); py++) for (let px = Math.floor(cx - r - half); px <= Math.ceil(cx + r + half); px++) {
      const dx = px + 0.5 - cx, dy = py + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy);
      if (d >= r - half && d <= r + half) add(px, py);
    }
  }
  bounded(rings).set(key, cells);
  return at(cells);
}

// The pixels a body covers at its position: [x, y] pairs in canvas pixels.
function cover(b, x, y) {
  const out = [];
  const part = b.parts[0];
  if (b.shape === 'circle') {
    const d = b.size[0], left = (x === b.x ? held(b, 0, d) : snap(x, d)) - d / 2, top = (y === b.y ? held(b, 1, d) : snap(y, d)) - d / 2;
    for (const [i, j] of disc(d)) out.push([left + i, top + j]);
    return out;
  }
  if (b.shape === 'hoop') {
    const { r, points, thickness, gap, sides } = b.parts.hoop;
    // A round hoop looks the same at every angle, so it is drawn as one fixed ring of pixels and only its gap turns;
    // redrawn from its turning walls, half its pixels would change every frame and the ring would tremble. A hoop
    // with few sides (a hexagon) really changes shape as it turns, so it is drawn from its walls, at a held place and
    // angle as a box is. Round means its sides bow less than SIDES_BOW from the circle: a small hoop's few default sides
    // (a radius-10 hoop has 10) bow half a pixel, and drawn from its walls it changed 40% of its pixels a frame.
    if (r * (1 - cosDeg(180 / sides)) < SIDES_BOW) {
      const cx = held(b, 0, b.size[0]), cy = held(b, 1, b.size[1]), facing = atan2Deg(b.s, b.c);
      for (const [px, py] of ring(cx, cy, r, thickness)) {
        if (gap > 0) {
          const turn = ((atan2Deg(py + 0.5 - cy, px + 0.5 - cx) - facing) % 360 + 540) % 360 - 180;
          if (turn > -gap / 2 && turn < gap / 2) continue;
        }
        out.push([px, py]);
      }
      return out;
    }
    const hx = held(b, 0, b.size[0]), hy = held(b, 1, b.size[1]), degrees = drawnDegrees(b), c = cosDeg(degrees), s = sinDeg(degrees);
    const world = points.map(([px, py]) => [hx + c * px - s * py, hy + s * px + c * py]);
    if (thickness <= 1) {
      for (let k = 0; k + 1 < world.length; k++) traceLine(Math.floor(world[k][0]), Math.floor(world[k][1]), Math.floor(world[k + 1][0]), Math.floor(world[k + 1][1]), (px, py) => out.push([px, py]));
      return out;
    }
    const half = thickness / 2, seen = new Set();
    for (let k = 0; k + 1 < world.length; k++) {
      const [ax, ay] = world[k], [bx, by] = world[k + 1], ex = bx - ax, ey = by - ay, ll = ex * ex + ey * ey;
      for (let py = Math.floor(Math.min(ay, by) - half); py <= Math.ceil(Math.max(ay, by) + half); py++) for (let px = Math.floor(Math.min(ax, bx) - half); px <= Math.ceil(Math.max(ax, bx) + half); px++) {
        const t = Math.max(0, Math.min(1, ((px + 0.5 - ax) * ex + (py + 0.5 - ay) * ey) / ll)), dx = px + 0.5 - ax - t * ex, dy = py + 0.5 - ay - t * ey;
        if (dx * dx + dy * dy <= half * half && !seen.has(py * 65536 + px)) { seen.add(py * 65536 + px); out.push([px, py]); }
      }
    }
    return out;
  }
  // Turned a quarter, its width runs down and its height across, so its centre snaps by those sides' sizes: snapped by
  // its upright sizes, a 5 × 4 brick lying on its side sat on half pixels and was drawn a 5 × 6 blob.
  const degrees = drawnDegrees(b), c = cosDeg(degrees), s = sinDeg(degrees), [w, h] = Math.round(degrees / 90) % 2 ? [b.size[1], b.size[0]] : b.size;
  const cx = x === b.x ? held(b, 0, w) : snap(x, w), cy = y === b.y ? held(b, 1, h) : snap(y, h), n = part.n, vx = [], vy = [], nx = [], ny = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    vx.push(cx + c * part.vx[i] - s * part.vy[i]); vy.push(cy + s * part.vx[i] + c * part.vy[i]);
    nx.push(c * part.nx[i] - s * part.ny[i]); ny.push(s * part.nx[i] + c * part.ny[i]);
    x0 = Math.min(x0, vx[i]); x1 = Math.max(x1, vx[i]); y0 = Math.min(y0, vy[i]); y1 = Math.max(y1, vy[i]);
  }
  // A pixel the shape covers at least half of (4 × 4 samples), so a small box turned part way reads as a tilted
  // square rather than the pinwheel its pixel centres alone would make. At angle 0 every pixel is covered or not.
  for (let py = Math.floor(y0); py <= Math.ceil(y1); py++) for (let px = Math.floor(x0); px <= Math.ceil(x1); px++) {
    let covered = 0;
    for (let k = 0; k < 16; k++) {
      const sx = px + ((k & 3) + 0.5) / 4, sy = py + ((k >> 2) + 0.5) / 4;
      let inside = true;
      for (let i = 0; i < n && inside; i++) if (nx[i] * (sx - vx[i]) + ny[i] * (sy - vy[i]) > 1e-7) inside = false;
      if (inside) covered++;
    }
    if (covered >= 8) out.push([px, py]);
  }
  return out;
}

// The angle a body is drawn at: its own, to the whole degree, so a turning box turns smoothly (its picture turned, see
// paintBodies). A body under 6 pixels every way is always drawn square: a 4-pixel box turned 30 degrees is a pinwheel in
// pixels and at 45 a plus sign. The physics keeps the exact angle.
const turnStep = size => (Math.max(size[0], size[1]) < 6 ? 90 : 1);
// The shorter turn from angle a to angle b, in degrees (−180 to 180).
export const turnBetween = (a, b) => ((b - a) % 360 + 540) % 360 - 180;
function drawnDegrees(b, size = b.size) {
  const every = turnStep(size), exact = atan2Deg(b.s, b.c);
  let degrees = Math.round(exact / every) * every;
  if (degrees >= 360) degrees -= 360;
  const memory = b.held ??= {}, key = `turn:${every}`, was = memory[key];
  if (was === undefined) memory[key] = { at: degrees, way: 0 };
  else if (degrees !== was.at) {
    const way = Math.sign(turnBetween(was.at, degrees));
    if (way === was.way || Math.abs(turnBetween(was.at, exact)) >= every / 2 + every * TURN_HOLD) memory[key] = { at: degrees, way };
  }
  return memory[key].at;
}

// A box or polygon upright: its cells at angle 0 around its middle, the edge in its outline's key and the rest in its
// fill (the fill it has now, for a body that changes colour at each hit). The picture's middle is the body's centre, so
// it turns about it: a polygon whose centre isn't the middle of its bounds (a right triangle) gets room for its far
// side, the picture as many pixels wider (and taller) on each side. (Cut to its bounds about its centre, a right
// triangle lost its tips and showed its fill there.)
const uprights = new Map();
function uprightRows(b) {
  const part = b.parts[0], fill = b.fills[b.colour], key = `${b.shape}:${b.size}:${part.vx.join()}:${part.vy.join()}:${fill}:${b.outline ?? ''}`;
  if (uprights.has(key)) return uprights.get(key);
  const room = (size, values) => size + 2 * Math.max(0, Math.ceil(Math.max(...Array.from(values, Math.abs)) - size / 2 - 1e-9));
  const w = room(b.size[0], part.vx), h = room(b.size[1], part.vy);
  const flat = { ...b, c: 1, s: 0, held: undefined, x: w / 2, y: h / 2 }, cells = cover(flat, flat.x, flat.y), inside = new Set(cells.map(([x, y]) => y * 65536 + x));
  const rows = Array.from({ length: h }, () => Array(w).fill('.'));
  for (const [x, y] of cells) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const edge = !inside.has(y * 65536 + x - 1) || !inside.has(y * 65536 + x + 1) || !inside.has((y - 1) * 65536 + x) || !inside.has((y + 1) * 65536 + x);
    rows[y][x] = b.outline && edge ? b.outline : fill;
  }
  const out = rows.map(row => row.join(''));
  bounded(uprights).set(key, out);
  return out;
}

// A picture turned (craft.js turnRows: its sides turned to whole pixel steps, so it stays crisp and keeps its shape, and
// its outline and frame stay closed lines), cached by picture and angle.
const sprites = new Map();
function sprite(rows, degrees) {
  const key = `${rows.join('/')}@${degrees}`;
  if (!sprites.has(key)) bounded(sprites).set(key, turnRows(rows, degrees));
  return sprites.get(key);
}

// The bodies drawn into a frame of their own, cropped: a grid operation and its pixel count. A fluid draws its bodies
// so when they are finer than its pixels.
export const drawBodies = (bodies, width, height, symbols, subpixels) => draw(bodies, width, height, { symbols, subpixels });
function draw(bodies, width, height, context) {
  const n = context.subpixels ?? 1, grid = new Uint16Array(width * n * height * n);
  if (n > 1) paintBodiesFine(bodies, grid, width, height, context.symbols, n);
  else paintBodies(bodies, grid, width, height, context.symbols);
  return crop(grid, width * n, height * n);
}

// A body's own picture: its symbol, or its fill and outline drawn at angle 0 as the bodies are drawn at whole pixels,
// with where its centre lies in it ([x, y], in the picture's pixels). Cached by shape, size, fill and outline.
const pictures = new Map();
function pictureOf(b, symbols) {
  // A piece of a broken body carries its own picture (its part of the body's), centred on it as a symbol is.
  if (b.symbol || b.rows) { const rows = b.rows ?? symbols[b.symbol]; return { rows, cx: rows[0].length / 2, cy: rows.length / 2 }; }
  const part = b.parts[0], fill = b.fills[b.colour];
  const key = `${b.shape}:${b.size}:${part.r ?? ''}:${part.vx ? part.vx.join() : ''}:${part.vy ? part.vy.join() : ''}:${fill}:${b.outline ?? ''}`;
  if (pictures.has(key)) return pictures.get(key);
  // Drawn upright about a centre far from the picture's edges, then cropped to what it covers.
  const R = 2 + Math.ceil(Math.max(b.size[0], b.size[1], ...(part.vx ? part.vx.map(Math.abs).map(v => 2 * v) : []), ...(part.vy ? part.vy.map(Math.abs).map(v => 2 * v) : [])));
  const flat = { ...b, c: 1, s: 0, held: undefined, x: -1, y: -1 }, cells = cover(flat, R, R), inside = new Set(cells.map(([x, y]) => y * 65536 + x));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const rows = Array.from({ length: y1 - y0 + 1 }, () => Array(x1 - x0 + 1).fill('.'));
  for (const [x, y] of cells) {
    const edge = !inside.has(y * 65536 + x - 1) || !inside.has(y * 65536 + x + 1) || !inside.has((y - 1) * 65536 + x) || !inside.has((y + 1) * 65536 + x);
    rows[y - y0][x - x0] = b.outline && edge ? b.outline : fill;
  }
  const picture = { rows: rows.map(row => row.join('')), cx: snap(R, b.size[0]) - x0, cy: snap(R, b.size[1]) - y0 };
  bounded(pictures).set(key, picture);
  return picture;
}

// Drawn finer than the world's pixels, a body steps its drawn place to the next fine pixel as it passes halfway there
// the way it last stepped, and back only once HOLD past halfway, as at whole pixels; its drawn angle takes its own once
// it has turned half a step on the way it last turned, or half a step and TURN_HOLD of one back (a step is a degree, or
// less for a body so long that a degree would move its ends more than a fine pixel): a crate bobbing on the water or a
// box rocking as it settles holds still instead of shimmering, one that slides moves a fine pixel at a time with its
// picture unchanged, and one that spins turns evenly. Its place is snapped so its picture's pixel edges, turned to the
// nearest quarter turn, fall between the fine pixels' centres: sampled on them, a box at rest a hundredth of a degree
// off square was drawn sheared, one half of each side a fine pixel off the other.
function heldTurn(b, reach, n) {
  let every = 1;
  while (every > 1 / 16 && reach * n * every * RADIANS > 1) every /= 2;
  const exact = atan2Deg(b.s, b.c), memory = b.held ??= {}, was = memory.fineTurn;
  if (was === undefined) memory.fineTurn = { at: exact, way: 0 };
  else {
    const turn = turnBetween(was.at, exact), way = Math.sign(turn);
    if (Math.abs(turn) >= every * (way === was.way ? 0.5 : 0.5 + TURN_HOLD)) memory.fineTurn = { at: exact, way };
  }
  return memory.fineTurn.at;
}
// `offset` is where the picture's edges lie from its centre, in this quarter turn: the drawn centre is that far off a
// fine pixel's edge. A new quarter turn (or picture) starts the hold afresh.
function heldFine(b, axis, offset, n, q) {
  const value = ((axis ? b.y : b.x) - offset) * n, next = Math.round(value), memory = b.held ??= {}, key = `fine:${axis}`, was = memory[key];
  if (!was || was.q !== q || was.offset !== offset || was.n !== n) memory[key] = undefined;
  holdStep(memory, key, next, Math.abs(value - (memory[key]?.at ?? value)), 0.5 + HOLD, { q, offset, n });
  return memory[key].at / n + offset;
}

// The pixels (n times finer: fine pixels) whose centres a placed body's shape covers.
function insideCells(placed, n) {
  const out = [];
  for (const part of placed.world) {
    const [x0, y0, x1, y1] = partBox(part);
    for (let j = Math.floor(y0 * n); j <= Math.ceil(y1 * n); j++) for (let i = Math.floor(x0 * n); i <= Math.ceil(x1 * n); i++) {
      const px = (i + 0.5) / n, py = (j + 0.5) / n;
      let inside;
      if (part.kind === 'circle') inside = (px - part.x) * (px - part.x) + (py - part.y) * (py - part.y) <= part.r * part.r;
      else if (part.n === 2) {
        const ex = part.vx[1] - part.vx[0], ey = part.vy[1] - part.vy[0], t = Math.max(0, Math.min(1, ((px - part.vx[0]) * ex + (py - part.vy[0]) * ey) / (ex * ex + ey * ey)));
        const dx = px - part.vx[0] - t * ex, dy = py - part.vy[0] - t * ey;
        inside = dx * dx + dy * dy <= part.r * part.r;
      } else {
        inside = true;
        for (let k = 0; k < part.n && inside; k++) if (part.nx[k] * (px - part.vx[k]) + part.ny[k] * (py - part.vy[k]) > 0) inside = false;
      }
      if (inside) out.push([i, j]);
    }
  }
  return out;
}
// The bodies in the order they are drawn: in order, but those that cut last, over what they pass through.
const drawOrder = bodies => (bodies.some(b => b.cuts) ? [...bodies.filter(b => !b.cuts), ...bodies.filter(b => b.cuts)] : bodies);
// How far the point (x, y) lies inside a body's shape where it really is: the depth under its nearest edge, negative
// outside.
function depthIn(b, x, y) {
  let best = -Infinity;
  for (const part of b.world) {
    let d;
    if (part.kind === 'circle') d = part.r - Math.sqrt((x - part.x) * (x - part.x) + (y - part.y) * (y - part.y));
    else {
      let out = -Infinity;
      for (let i = 0; i < part.n; i++) out = Math.max(out, part.nx[i] * (x - part.vx[i]) + part.ny[i] * (y - part.vy[i]));
      d = part.r - out;
    }
    if (d > best) best = d;
  }
  return best;
}
// Puts the bodies' pixels into `grid` (W × H, n fine pixels to a world pixel). Where two bodies' pictures claim the same
// pixel, it goes to the body whose shape covers the pixel's middle more deeply, so bodies that touch are drawn side by
// side, each in its own pixels, as their shapes lie. (The later body was drawn over the earlier: a small ball's square
// picture reaches past its round shape, and a pile of them was drawn with every ball partly inside its neighbours.) A
// cutter, drawn last, covers what it passes through.
function bodyPainter(grid, W, H, n) {
  const owner = new Int32Array(W * H).fill(-1), drawn = [];
  let body = null, slot = -1;
  return {
    start: b => { body = b; slot = drawn.length; drawn.push(b); },
    put: (x, y, code) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const k = y * W + x, o = owner[k];
      if (o >= 0 && o !== slot && !body.cuts) {
        const px = (x + 0.5) / n, py = (y + 0.5) / n;
        if (!(depthIn(body, px, py) > depthIn(drawn[o], px, py))) return;
      }
      grid[k] = code; owner[k] = slot;
    }
  };
}
// Smears, under the bodies: each one's shape swept from where it was `smear.frames` frames ago to where it is, sampled
// so its far end moves under half a (fine) pixel a sample, the oldest part first, so the colours run from the first,
// just behind the body, to the last at the far end of the sweep, as a pixel artist draws a fast swing.
function paintSmears(bodies, n, put) {
  for (const b of bodies) {
    if (b.gone || b.hidden || !b.smear || b.poses.length < 2) continue;
    const { colors, frames } = b.smear, codes = colors.map(key => key.charCodeAt(0)), poses = b.poses, spans = poses.length - 1;
    for (let k = 0; k < spans; k++) {
      const [ax, ay, ac, as] = poses[k], [bx, by, bc, bs] = poses[k + 1], from = atan2Deg(as, ac), turn = turnBetween(from, atan2Deg(bs, bc));
      const reach = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) + Math.abs(turn) * RADIANS * b.extent, steps = Math.max(1, Math.ceil(reach * n * 2));
      for (let t = 0; t < steps; t++) {
        const u = t / steps, age = spans - k - u, a = from + turn * u, code = codes[Math.min(codes.length - 1, Math.floor(age / frames * codes.length))];
        const pose = { ...b, x: ax + (bx - ax) * u, y: ay + (by - ay) * u, c: cosDeg(a), s: sinDeg(a) };
        place(pose);
        for (const [i, j] of insideCells(pose, n)) put(i, j, code);
      }
    }
  }
}

/**
 * Draws the bodies `n` times finer than the world's pixels (a source's `subpixels`) into `grid` (character codes,
 * width × n by height × n): each body is its own picture, every pixel of it a square n fine pixels across, turned with
 * the body and placed where the body is to the fine pixel (held as heldFine and fineStep say), so it turns and moves
 * smoothly and never changes shape. A circle's picture doesn't turn, as at whole pixels; a hoop is drawn as at whole
 * pixels, enlarged.
 */
export function paintBodiesFine(bodies, grid, width, height, symbols, n) {
  const W = width * n, H = height * n;
  const put = (x, y, code) => { if (x >= 0 && y >= 0 && x < W && y < H) grid[y * W + x] = code; };
  // Trails first, under every body: a disc a pixel narrower than the body, along where it was in recent frames.
  for (const b of bodies) {
    if (b.gone || b.hidden || !b.trail || b.history.length < 2) continue;
    const code = b.trail.color.charCodeAt(0), points = b.history.slice(-1 - b.trail.length), d = Math.max(1, Math.min(b.size[0], b.size[1]) - 1) * n, cells = disc(d);
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k], [bx, by] = points[k + 1], steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * n));
      for (let s = 0; s < steps; s++) {
        const left = Math.round((ax + (bx - ax) * s / steps) * n - d / 2), top = Math.round((ay + (by - ay) * s / steps) * n - d / 2);
        for (const [i, j] of cells) put(left + i, top + j, code);
      }
    }
  }
  paintSmears(bodies, n, put);
  const painter = bodyPainter(grid, W, H, n);
  for (const b of drawOrder(bodies)) {
    if (b.gone || b.hidden) continue;
    painter.start(b);
    const put = painter.put;
    if (b.shape === 'hoop') {
      const code = b.fills[b.colour].charCodeAt(0);
      for (const [x, y] of cover(b, b.x, b.y)) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(x * n + i, y * n + j, code);
      continue;
    }
    const { rows, cx, cy } = pictureOf(b, symbols), w = rows[0].length, h = rows.length, turns = b.shape !== 'circle';
    const rx = Math.max(cx, w - cx), ry = Math.max(cy, h - cy), reach = turns ? Math.sqrt(rx * rx + ry * ry) : Math.max(rx, ry);
    const degrees = turns ? heldTurn(b, reach, n) : 0, c = cosDeg(degrees), s = sinDeg(degrees);
    const q = ((Math.round(degrees / 90) % 4) + 4) % 4, x = heldFine(b, 0, [cx, -cy, -cx, cy][q], n, q), y = heldFine(b, 1, [cy, cx, -cy, -cx][q], n, q);
    const i0 = Math.max(0, Math.floor((x - reach) * n)), i1 = Math.min(W - 1, Math.ceil((x + reach) * n)), j0 = Math.max(0, Math.floor((y - reach) * n)), j1 = Math.min(H - 1, Math.ceil((y + reach) * n));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // Where this fine pixel's centre lies in the picture, turned back by the body's drawn angle.
      const px = (i + 0.5) / n - x, py = (j + 0.5) / n - y, u = Math.floor(px * c + py * s + cx), v = Math.floor(py * c - px * s + cy);
      if (u < 0 || v < 0 || u >= w || v >= h) continue;
      const ch = rows[v][u];
      if (ch !== '.' && ch !== ' ') put(i, j, ch.charCodeAt(0));
    }
  }
}

// A frame of a bodies source: the territory's cells and waiting pickups, the bodies over them (n times finer with
// subpixels) and the heads-up display's operations.
function drawFrame(world, width, height, context, f, hud = []) {
  const n = context.subpixels ?? 1, W = width * n, H = height * n, grid = new Uint16Array(W * H);
  const put = (x, y, code) => { if (x >= 0 && y >= 0 && x < W && y < H) grid[y * W + x] = code; };
  if (world.turf) world.turf.draw(grid, width, height, f, context.symbols, n);
  const beneathCloth = world.cloths.filter(cloth => cloth.definition.draw === 'under'), aboveCloth = world.cloths.filter(cloth => cloth.definition.draw === 'over');
  const beneathRope = world.ropes.filter(rope => rope.draw === 'under'), aboveRope = world.ropes.filter(rope => rope.draw === 'over');
  if (beneathCloth.length) paintCloth(beneathCloth, put, n);
  if (beneathRope.length) paintRopes(beneathRope, put, n);
  if (n > 1) paintBodiesFine(world.bodies, grid, width, height, context.symbols, n);
  else paintBodies(world.bodies, grid, width, height, context.symbols);
  if (aboveRope.length) paintRopes(aboveRope, put, n);
  if (aboveCloth.length) paintCloth(aboveCloth, put, n);
  return { ...crop(grid, W, H), hud: world.turf && hud.length ? world.turf.hud(f, hud, n) : [] };
}

/** Draws the bodies into `grid` (character codes, width × height): trails first, then each body in order (a cutter last). */
export function paintBodies(bodies, grid, width, height, symbols) {
  const context = { symbols };
  const put = (x, y, code) => { if (x >= 0 && y >= 0 && x < width && y < height) grid[y * width + x] = code; };
  // Trails first, under every body: the body's own shape shrunk by a pixel, along where it was in recent frames, but not
  // under where it is now: a disc a pixel narrower snaps to the other kind of pixel place, and a body at rest showed a
  // pixel of trail beside it.
  for (const b of bodies) {
    if (b.gone || b.hidden || !b.trail || b.history.length < 2) continue;
    const code = b.trail.color.charCodeAt(0), points = b.history.slice(-1 - b.trail.length), d = Math.max(1, Math.min(b.size[0], b.size[1]) - 1);
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k], [bx, by] = points[k + 1], steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
      for (let t = 0; t < steps; t++) {
        const x = ax + (bx - ax) * t / steps, y = ay + (by - ay) * t / steps, left = snap(x, d) - d / 2, top = snap(y, d) - d / 2;
        if (Math.abs(x - b.x) < 0.5 && Math.abs(y - b.y) < 0.5) continue;
        for (const [i, j] of disc(d)) put(left + i, top + j, code);
      }
    }
  }
  paintSmears(bodies, 1, put);
  const painter = bodyPainter(grid, width, height, 1);
  for (const b of drawOrder(bodies)) {
    if (b.gone || b.hidden) continue;
    painter.start(b);
    const put = painter.put;
    // A box or polygon is drawn as its upright picture, fill and outline, turned by turnRows (as a symbol is): its sides
    // turned to whole pixel steps, straight and even, and its outline kept a closed line, so it stays the same crisp shape
    // as it turns. (Drawn afresh from the pixels it covered it swelled into a blob; resampled as RotSprite does it rounded
    // off and grew spikes; resampled exactly it grew a nub at each corner.) Under 6 pixels across it is drawn square: no
    // picture that small shows a turn without a pinwheel.
    const upright = !b.symbol && !b.rows && (b.shape === 'box' || b.shape === 'polygon') && Math.max(b.size[0], b.size[1]) >= 6 ? uprightRows(b) : null;
    if (b.symbol || b.rows || upright) {
      const rows = upright ?? b.rows ?? context.symbols[b.symbol], degrees = b.shape === 'circle' ? 0 : Math.round(drawnDegrees(b, [rows[0].length, rows.length])) % 360;
      const { rows: turned, origin } = sprite(rows, b.shape === 'circle' ? 0 : degrees);
      // Turned about its centre, which sits on the body's drawn centre: on a pixel's middle where the turned picture's
      // middle is one (mx a half), else on a pixel corner, so the turned picture lies on whole pixels with its middle
      // where the body is. (Snapped as the upright picture, then rounded, a turned picture sat a quarter pixel down and
      // right on average and hopped half a pixel diagonally as a degree's turn changed its middle.)
      const w = rows[0].length, h = rows.length, mx = w / 2 - origin[0], my = h / 2 - origin[1];
      const parity = m => (((Math.round(2 * m) % 2) + 2) % 2 ? 1 : 2), cx = held(b, 0, parity(mx)), cy = held(b, 1, parity(my));
      const left = Math.round(cx - mx), top = Math.round(cy - my);
      turned.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.' && row[i] !== ' ') put(left + i, top + j, row.charCodeAt(i)); });
      continue;
    }
    const cells = cover(b, b.x, b.y), fill = b.fills[b.colour].charCodeAt(0);
    if (!b.outline) { for (const [x, y] of cells) put(x, y, fill); continue; }
    const inside = new Set(cells.map(([x, y]) => y * 65536 + x)), line = b.outline.charCodeAt(0);
    for (const [x, y] of cells) {
      const edge = !inside.has(y * 65536 + x - 1) || !inside.has(y * 65536 + x + 1) || !inside.has((y - 1) * 65536 + x) || !inside.has((y + 1) * 65536 + x);
      put(x, y, edge ? line : fill);
    }
  }
}

function crop(grid, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1, pixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (grid[y * width + x]) { pixels++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return { op: null, pixels: 0 };
  const rows = [];
  for (let y = y0; y <= y1; y++) { let row = ''; for (let x = x0; x <= x1; x++) row += grid[y * width + x] ? String.fromCharCode(grid[y * width + x]) : '.'; rows.push(row); }
  return { op: { op: 'grid', x: x0, y: y0, rows }, pixels };
}

// ---- Compiling --------------------------------------------------------------------------------------------------------
// A source's `subpixels`: how many times finer than the world's pixels its bodies are drawn (1, the default, draws them
// at whole pixels). The recipe's canvas is that many times larger, at most 256 a side for an animation.
// `effects`, the source's effects as written, only make the hint name a value the frames' pixels allow too.
export function readSubpixels(value, path, width, height, effects) {
  if (value === undefined) return 1;
  const n = integer(value, `${path}.subpixels`, 1, 8);
  const frames = Object.values(isObject(effects) ? effects : {}).reduce((sum, effect) => sum + (Number.isInteger(effect?.frames) && effect.frames > 0 ? effect.frames : 0), 0);
  if (Math.max(width, height) * n > 256) fail(`${path}.subpixels`, `a ${width}×${height} canvas drawn ${n} times finer is ${width * n}×${height * n}; an animation is at most 256 a side, so use subpixels of at most ${finest(width, height, frames)}`);
  return n;
}
// The finest a canvas may be drawn: at most 256 a side and, with `frames`, 4,194,304 pixels over them.
const finest = (width, height, frames) => Math.max(1, Math.min(8, Math.floor(256 / Math.max(width, height)), frames ? Math.floor(Math.sqrt(4194304 / (frames * width * height))) : 8));
// The frames a recipe drawn n times finer holds: their pixels together at most 4,194,304, the exporter's limit.
export function framesFit(frames, width, height, n, path) {
  const pixels = frames * width * n * height * n;
  if (n === 1 && pixels > 4194304) fail(`${path}.effects`, `the effects make ${frames} frames of ${width}×${height}, ${pixels} pixels, more than the 4,194,304 a recipe's frames share; use fewer frames or a smaller canvas`);
  if (n > 1 && pixels > 4194304) fail(`${path}.subpixels`, `${frames} frames of ${width * n}×${height * n} are ${pixels} pixels, more than the 4,194,304 a recipe's frames share; lower subpixels to ${finest(width, height, frames)} or use fewer frames`);
}
export const scaleAnchor = (anchor, n) => (n > 1 && Array.isArray(anchor) && anchor.length === 2 && anchor.every(Number.isInteger) ? [anchor[0] * n, anchor[1] * n] : anchor);

// About how much a simulation does, so a source can't ask for minutes of work (or a match for hours): every substep the
// pair tests and each body's contacts and upkeep, and the obstacle faces each moving body is tested against, each a
// contact the solver may work through; every frame the pixels its drawing visits. A body is charged the faces in the
// densest patch its size (with the reach of a fast step) holds anywhere: a floor or a crate is a few faces, while a
// checkerboard has one on every pixel edge, so a box over one meets a face per pixel. A territory's cells may come to
// hold up to two a cell (another team's cells, every other one). Drawn finer (subpixels), each body's picture is visited
// a fine pixel at a time over its reach, its trail a disc a step, and the whole fine canvas once more. (Counting bodies
// alone, eight boxes kept moving over a checkerboard counted 2.7 million updates and ran for 10 seconds, and a match of
// 256 boxes drawn finer ran for an hour within the budget.) Pairs are found on a grid of 4-pixel cells, so a body is
// tested against the bodies in the cells its bounds reach, as many as fit there at the smallest free body's size: about
// 70 for balls of radius 1, where testing every pair counted 400 for 800 of them. Split powers may grow the crowd to
// the effect's `most`, every copy charged as the costliest free body, and a smear is visited a sample at a time over
// its sweep. Weighed against time, a unit is about what the presets' pair tests and contacts cost: these cases and the
// presets run at 18 to 85 ms a million.
const FACE_WORK = 1, PIXEL_WORK = 0.25;
function work(effect, { width, height, n = 1, symbols = {} }) {
  const count = effect.bodies.length, margin = MAX_SPEED / effect.substeps + 0.1;
  // A fixed body an event breaks falls as pieces, so it is priced as a free body would be.
  const broken = (effect.events ?? []).filter(e => e.power === 'break' && effect.bodies[e.body].fixed);
  const freed = new Set(broken.map(e => effect.bodies[e.body])), moving = effect.bodies.filter(b => !b.fixed || freed.has(b));
  // Splits and break powers may fill the crowd up to `most`; bodies that break when knocked or by an event add their pieces.
  const splits = [effect.pickups, effect.events, effect.strikes].some(list => (list ?? []).some(p => (p.power === 'split' || p.power === 'break') && !broken.includes(p)));
  const pieces = effect.bodies.reduce((sum, b) => sum + (b.breaks ? b.breaks.pieces : 0), 0) + broken.reduce((sum, e) => sum + e.count, 0);
  const room = Math.max(0, (effect.most ?? count) - count);
  const added = splits && moving.length ? room : Math.min(pieces, room), crowd = count + added;
  const smallest = moving.length ? Math.max(0.5, Math.min(...moving.map(shapeArea))) : 1;
  const span = b => Math.max(b.size[0], b.size[1]) * Math.SQRT2;
  const pairs = b => Math.min(crowd - 1, Math.ceil((span(b) + 4 * margin + 8) ** 2 / smallest)) / 2;
  let step = crowd * (effect.iterations + 2) * 16 + crowd * 32, frame = width * height * n * n, costliest = 0, drawn = 0;
  for (const b of effect.bodies) step += pairs(b);
  const segments = moving.length ? traceObstacles(effect, width, height).segments : [], densest = new Map();
  for (const b of moving) {
    // The area a substep's search covers: the body's bounds turned to 45 degrees, and a step at the speed limit each way.
    const side = Math.ceil(span(b) + 2 * margin) + 1;
    if (!densest.has(side)) densest.set(side, facesIn(segments, width, height, side));
    const t = effect.territory, cells = t ? Math.min(t.columns * t.rows, (Math.ceil(side / t.cell) + 2) ** 2) : 0, faces = (densest.get(side) + 2 * cells) * (effect.iterations + 3) * FACE_WORK;
    step += faces; costliest = Math.max(costliest, faces + pairs(b));
  }
  for (const b of effect.bodies) {
    // A body's picture (its symbol, or its shape) within its reach, turned (a circle doesn't turn), then its trail and its
    // smear: a sample each half (fine) pixel its far end sweeps, each over the bounds it is turned in.
    const picture = b.rows ?? (b.symbol ? symbols[b.symbol] : null), w = Math.max(b.size[0], picture ? picture[0].length : 0), h = Math.max(b.size[1], picture ? picture.length : 0);
    const reach = b.shape === 'circle' ? Math.max(w, h) / 2 : Math.sqrt(w * w + h * h) / 2, across = 2 * reach * n + 2;
    let cost = Math.min(width * height * n * n, across * across);
    if (b.trail) { const d = Math.max(1, Math.min(b.size[0], b.size[1]) - 1) * n; cost += b.trail.length * (MAX_SPEED * n + 1) * d * d; }
    if (b.smear) { const sweep = (b.fixed ? Math.sqrt(b.vx * b.vx + b.vy * b.vy) : MAX_SPEED) + Math.abs(b.spin) * RADIANS * 2 * reach; cost += b.smear.frames * Math.ceil(2 * n * sweep + 1) * across * across; }
    frame += cost;
    if (!b.fixed || freed.has(b)) drawn = Math.max(drawn, cost);
  }
  step += added * costliest; frame += added * drawn;
  // Joints cost an impulse per iteration and substep; cloth adds its particles, constraints and drawn cells.
  const joints = effect.joints ?? [], cloths = effect.cloths ?? [];
  step += joints.length * effect.iterations * 8;
  const clothCost = clothWork(cloths, { frames: effect.frames, substeps: effect.substeps, iterations: effect.iterations });
  return effect.frames * (effect.substeps * step + frame * PIXEL_WORK) + clothCost;
}
// The area of a body's shape: a circle's, or a polygon's (a box's) by its corners.
function shapeArea(b) {
  const part = b.parts[0];
  if (part.kind === 'circle') return PI * part.r * part.r;
  let area = 0;
  for (let i = 0; i < part.n; i++) { const j = (i + 1) % part.n; area += part.vx[i] * part.vy[j] - part.vx[j] * part.vy[i]; }
  return Math.abs(area) / 2;
}
// The most segments whose bounds meet one square patch `side` pixels across, anywhere on (or overlapping) the canvas.
function facesIn(segments, width, height, side) {
  if (!segments.length) return 0;
  // Patch corners from -side to width (and height), a count added over the corners whose patch meets each segment.
  const W = width + side + 2, H = height + side + 2, sums = new Int32Array((W + 1) * (H + 1));
  const at = (v, most) => Math.max(0, Math.min(most, v + side));
  for (const s of segments) {
    const x0 = at(Math.ceil(Math.min(s.ax, s.bx) - side), W), x1 = at(Math.floor(Math.max(s.ax, s.bx)), W - 1) + 1;
    const y0 = at(Math.ceil(Math.min(s.ay, s.by) - side), H), y1 = at(Math.floor(Math.max(s.ay, s.by)), H - 1) + 1;
    sums[y0 * (W + 1) + x0]++; sums[y0 * (W + 1) + x1]--; sums[y1 * (W + 1) + x0]--; sums[y1 * (W + 1) + x1]++;
  }
  let most = 0;
  for (let y = 0; y <= H; y++) for (let x = 0; x <= W; x++) {
    const c = y * (W + 1) + x;
    if (x) sums[c] += sums[c - 1];
    if (y) sums[c] += sums[c - W - 1];
    if (x && y) sums[c] -= sums[c - W - 2];
    if (sums[c] > most) most = sums[c];
  }
  return most;
}

// The pixels whose centres a body's exact shape covers, where it really is: a fluid's solid cells for it. Drawn at a
// held pixel, a body may sit most of a pixel from them; were its solid cells drawn ones, each step of its drawing down
// would cover a row of the sand it stands on, and it would sink for ever. With `grow`, the shape grown (or, below 0,
// shrunk) by that much on every side.
function exactCells(b, grow = 0) {
  const out = [];
  for (const part of b.world) {
    if (part.kind === 'circle') {
      const r = part.r + grow, reach = part.r + Math.max(0, grow);
      for (let py = Math.floor(part.y - reach); py <= Math.ceil(part.y + reach); py++) for (let px = Math.floor(part.x - reach); px <= Math.ceil(part.x + reach); px++) {
        const dx = px + 0.5 - part.x, dy = py + 0.5 - part.y;
        if (r > 0 && dx * dx + dy * dy <= r * r) out.push([px, py]);
      }
      // A body smaller than a pixel still fills the one its centre is in.
      if (!out.length && !grow) out.push([Math.floor(part.x), Math.floor(part.y)]);
      continue;
    }
    const [x0, y0, x1, y1] = part.box, out0 = Math.max(0, grow);
    for (let py = Math.floor(y0 - out0); py <= Math.ceil(y1 + out0); py++) for (let px = Math.floor(x0 - out0); px <= Math.ceil(x1 + out0); px++) {
      let inside = true;
      for (let i = 0; i < part.n && inside; i++) {
        const d = part.nx[i] * (px + 0.5 - part.vx[i]) + part.ny[i] * (py + 0.5 - part.vy[i]);
        if (part.n === 2 ? false : d > grow) inside = false;
      }
      if (part.n === 2) {
        const ex = part.vx[1] - part.vx[0], ey = part.vy[1] - part.vy[0], t = Math.max(0, Math.min(1, ((px + 0.5 - part.vx[0]) * ex + (py + 0.5 - part.vy[0]) * ey) / (ex * ex + ey * ey)));
        const dx = px + 0.5 - part.vx[0] - t * ex, dy = py + 0.5 - part.vy[0] - t * ey;
        const r = Math.max(0.5, part.r) + grow;
        inside = r > 0 && dx * dx + dy * dy <= r * r;
      }
      if (inside) out.push([px, py]);
    }
  }
  const seen = new Set();
  return out.filter(([x, y]) => { const key = y * 65536 + x; if (seen.has(key)) return false; seen.add(key); return true; });
}
/** The area of a body's exact shape past `level` along an axis (0: x, 1: y) in the direction `sign`, and its centre:
 * [area, x, y]. A fluid's buoyancy reads it, so the lift changes smoothly as a body sinks or rises past a pixel. */
export function areaBeyond(b, axis, level, sign) {
  let area = 0, sx = 0, sy = 0;
  const past = v => sign * (v - level);
  for (const part of b.world) {
    if (part.kind === 'circle') {
      // Thin slices across the axis, each as wide as the circle there.
      const centre = axis ? part.y : part.x, across = axis ? part.x : part.y, SLICES = 24, h = 2 * part.r / SLICES;
      for (let k = 0; k < SLICES; k++) {
        const along = centre - part.r + (k + 0.5) * h;
        if (past(along) < 0) continue;
        const t = along - centre, width = 2 * Math.sqrt(Math.max(0, part.r * part.r - t * t)), a = width * h;
        area += a; sx += a * (axis ? across : along); sy += a * (axis ? along : across);
      }
      continue;
    }
    if (part.n < 3) continue;
    // The polygon clipped to the side past the level, then its area and centroid.
    const kept = [];
    for (let i = 0; i < part.n; i++) {
      const j = (i + 1) % part.n, p = [part.vx[i], part.vy[i]], q = [part.vx[j], part.vy[j]], dp = past(p[axis]), dq = past(q[axis]);
      if (dp >= 0) kept.push(p);
      if (dp * dq < 0) { const t = dp / (dp - dq); kept.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
    }
    for (let i = 0; i + 2 < kept.length + 1 && kept.length >= 3; i++) {
      if (i + 2 >= kept.length) break;
      const [ax, ay] = kept[0], [bx, by] = kept[i + 1], [cx, cy] = kept[i + 2], a = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
      area += a; sx += a * (ax + bx + cx) / 3; sy += a * (ay + by + cy) / 3;
    }
  }
  return area > 1e-9 ? [area, sx / area, sy / area] : [0, b.x, b.y];
}
/** The cells a body fills now, where it really is: the fluid's solid cells for it. */
export const bodyCells = b => (b.gone ? [] : exactCells(b));
/** The cells a body fills now, held from `last` (the cells it held before, or null): a cell joins the body once its exact
 * shape covers the cell's centre by `margin`, and leaves once the centre is `margin` outside it. A liquid reads a free
 * body's cells so: taken and given back every frame as a light crate bobbed about a row, a row of water was shoved out
 * from under it and ran back each time, and the flow kept it bobbing. */
export function heldCells(b, last, margin) {
  if (b.gone) return [];
  if (!last) return exactCells(b);
  const key = ([x, y]) => `${x},${y}`, loose = new Set(exactCells(b, margin).map(key)), out = exactCells(b, -margin), seen = new Set(out.map(key));
  for (const cell of last) { const k = key(cell); if (loose.has(k) && !seen.has(k)) { seen.add(k); out.push(cell); } }
  return out.length ? out : exactCells(b);
}
/** The cells a body fills at its own pose (x, y, c, s), placed afresh: a loop's closing frames draw the fluid against the
 * bodies where they are drawn, blended toward the warm-up's poses. */
export const poseCells = b => { if (b.gone) return []; const placed = { ...b }; place(placed); return exactCells(placed); };
/** The cells a body as read (before any step) fills. */
export const startCells = b => { const placed = { ...b, c: cosDeg(b.angle), s: sinDeg(b.angle) }; place(placed); return exactCells(placed); };

// A source's shell (what every frame's recipe shares, its canvas n times finer with subpixels) and its effects, read
// and checked; an effect may run `frames` long.
function readSource(source, frames) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'subpixels', 'palette', 'symbols', 'anchor', 'sheet', 'effects'], 'bodies');
  if (source.format !== 'pixelforge-bodies' || source.version !== 1) fail('bodies', 'expected version-1 pixelforge-bodies');
  const palette = source.palette ?? {};
  if (!isObject(palette)) fail('bodies.palette', 'expected a palette object');
  const width = integer(source.width, 'bodies.width', 4, 256), height = integer(source.height, 'bodies.height', 4, 256);
  // A recipe's frames share the exporter's pixels, so its hint counts them; a match written as video frames (bodiesFrames)
  // keeps none of them, and is held only to 256 a side.
  const n = readSubpixels(source.subpixels, 'bodies', width, height, frames === LIMITS.frames ? source.effects : undefined);
  const symbols = source.symbols ?? {};
  if (!isObject(symbols)) fail('bodies.symbols', 'expected named symbols for obstacles and sprites');
  for (const [name, rows] of Object.entries(symbols)) {
    identifier(name, `bodies.symbols.${name}`);
    if (!Array.isArray(rows) || !rows.length || rows.length > 256 || typeof rows[0] !== 'string' || !rows[0].length || rows.some(row => typeof row !== 'string')) fail(`bodies.symbols.${name}`, 'expected 1–256 equal-width text rows');
    sameWidth(rows, `bodies.symbols.${name}`);
  }
  if (!isObject(source.effects) || !Object.keys(source.effects).length || Object.keys(source.effects).length > LIMITS.effects) fail('bodies.effects', `expected 1–${LIMITS.effects} named effects`);
  const shell = { version: 1, name: source.name, width: width * n, height: height * n, palette, ...(Object.keys(symbols).length && { symbols }), ...(source.anchor !== undefined && { anchor: scaleAnchor(source.anchor, n) }) };
  // The renderer's palette, symbol and name checks, before any simulating.
  renderProject({ ...shell, frames: [{ name: 'check' }] });
  const effects = [], seen = new Set();
  for (const [name, value] of Object.entries(source.effects)) {
    const path = `bodies.effects.${name}`;
    identifier(name, path);
    if (seen.has(name.toLowerCase())) fail(path, 'effect names must be unique ignoring case; they name animations and frames');
    seen.add(name.toLowerCase());
    effects.push({ name, path, effect: readEffect(value, path, { width, height, palette, symbols, frames, subpixels: n }) });
  }
  return { shell, width, height, n, palette, symbols, effects };
}

// One frame's operations: the background, obstacles under the bodies, the bodies' grid, obstacles over them and the
// heads-up display, on a canvas n times finer with subpixels (the world drawn in blocks that size).
function frameOps(effect, drawn, width, height, n) {
  const stamps = where => effect.obstacles.filter(o => o.draw === where).map(o => ({ op: 'stamp', symbol: o.symbol, x: o.x * n, y: o.y * n, ...(n > 1 && { scale: n }) }));
  return [...(effect.background ? [{ op: 'rect', x: 0, y: 0, w: width * n, h: height * n, color: effect.background }] : []), ...stamps('under'), ...(drawn.op ? [drawn.op] : []), ...stamps('over'), ...drawn.hud];
}
// The territory's figures for the metadata (the teams, each frame's cells per team, the cells that changed hands and the
// team ahead at the end) and the powers taken.
const territoryFigures = (turf, territory) => ({
  ...(turf && territory && { territory: { teams: turf.teams.map(team => team.name), counts: turf.stats.counts, flips: turf.stats.flips, leader: turf.teams[turf.stats.counts.at(-1).reduce((best, n, k, all) => (n > all[best] ? k : best), 0)].name } }),
  ...(turf && turf.stats.taken.length && { powers: turf.stats.taken }),
  ...(turf && turf.stats.strikes && { strikes: turf.stats.strikes })
});

/** A version-1 pixelforge-bodies source → { recipe, metadata, warnings? }. One-shot: bodies don't loop. */
export function compileBodies(source) {
  const { shell, width, height, n, symbols, effects } = readSource(source, LIMITS.frames);
  const frames = [], animations = {}, metadata = { format: 'pixelforge-bodies-metadata', version: 1, effects: {} }, warnings = [];
  let total = 0;
  for (const { name, path, effect } of effects) {
    if (frames.length + effect.frames > LIMITS.frames) fail('bodies.effects', `the effects make more than ${LIMITS.frames} frames; a recipe holds at most ${LIMITS.frames}`);
    framesFit(frames.length + effect.frames, width, height, n, 'bodies');
    total += work(effect, { width, height, n, symbols });
    if (total > LIMITS.work) fail(path, `the simulations need about ${Math.round(total / 1e6)} million updates, more than ${LIMITS.work / 1e6} million; lower frames, substeps, iterations, the number or size of the bodies, the obstacle faces near them (a checkerboard has one on every pixel edge) or subpixels`);
    const run = simulate(effect, { width, height, symbols, subpixels: n }), names = [];
    run.drawn.forEach((frame, i) => {
      const ops = frameOps(effect, frame, width, height, n);
      frames.push({ name: `${name}-${i}`, duration: effect.duration, ...(ops.length && { ops }) });
      names.push(`${name}-${i}`);
    });
    animations[name] = { frames: names, loop: false };
    const effectWarnings = run.stats.overlaps.map(pair => `${pair}; they push apart on the first frame. Move it clear`);
    if (!run.drawn.some(frame => frame.pixels)) effectWarnings.push(`${path}: nothing is ever on the canvas; check at against width and height`);
    const crowded = run.stats.crowded.size;
    if (crowded) effectWarnings.push(`${path}.most: ${crowded} ${crowded === 1 ? 'body' : 'bodies'} broke into fewer pieces than asked, or not at all, because the effect holds at most ${effect.most} bodies; raise most`);
    warnings.push(...effectWarnings);
    const played = territoryFigures(run.turf, effect.territory);
    metadata.effects[name] = {
      frames: effect.frames, substeps: effect.substeps, steps: run.steps, bodies: effect.bodies.length, ...(run.copies && { copies: run.copies }), hits: run.stats.hits,
      ...(effect.joints.length && { joints: effect.joints.length }), ...(effect.ropes.length && { ropes: effect.ropes.length }), ...(effect.cloths.length && { cloths: effect.cloths.length, clothFigures: run.stats.cloths }),
      ...(run.stats.jointBreaks.length && { brokenJoints: run.stats.jointBreaks }), ...(run.stats.cloths?.some(cloth => cloth.tears) && { clothTears: run.stats.cloths.filter(cloth => cloth.tears).reduce((sum, cloth) => sum + cloth.tears, 0) }),
      escaped: run.stats.escaped, ...(run.stats.broken.length && { broken: run.stats.broken }), rest: run.stats.rest, pixels: run.drawn.map(frame => frame.pixels), ...(Object.keys(run.stats.paths).length && { paths: run.stats.paths }), ...played, ...(effectWarnings.length && { warnings: effectWarnings })
    };
  }
  const recipe = { ...shell, frames, animations, ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject(recipe);
  return JSON.parse(JSON.stringify({ recipe, metadata, ...(warnings.length && { warnings }) }));
}

/** One effect of a pixelforge-bodies source stepped a frame at a time, for numbered video frames: a match may run up
 * to MATCH_FRAMES frames, past a recipe's 256, and none of it is kept as a recipe. Returns { name, effect, width,
 * height, palette, frames, duration, image(f), figures() }: image(f) is frame f's RGBA (f must never go back), and
 * figures() the metadata a compiled effect carries, so far. */
export function bodiesFrames(source, effectName) {
  const { shell, width, height, n, palette, symbols, effects } = readSource(source, MATCH_FRAMES);
  const chosen = effectName === undefined ? effects[0] : effects.find(entry => entry.name === effectName);
  if (!chosen) fail('sequence.animation', `no effect named "${effectName}"; choose one of: ${effects.map(entry => entry.name).join(', ')}`);
  const { name, path, effect } = chosen;
  const needs = work(effect, { width, height, n, symbols });
  if (needs > MATCH_WORK) fail(path, `the match needs about ${Math.round(needs / 1e6)} million updates, more than ${MATCH_WORK / 1e6} million; lower frames, substeps, iterations, the number or size of the bodies, the obstacle faces near them (a checkerboard has one on every pixel edge) or subpixels`);
  // The world gets the symbols too: a symbol body that breaks cuts its picture into the pieces.
  const context = { width, height, symbols, subpixels: n }, world = createBodyWorld(effect, context);
  let at = -1, image = null;
  return {
    name: source.name, effect: name, width: width * n, height: height * n, palette, frames: effect.frames, duration: effect.duration,
    image: f => {
      if (!Number.isInteger(f) || f < 0 || f < at || f >= effect.frames) fail('sequence', `frame ${f} is not ahead of frame ${at} within the match's ${effect.frames}`);
      // Every frame is drawn, shown or not, as compileBodies draws them: a body's drawn place and angle hold from frame
      // to frame, so a frame drawn after skipped ones must have seen each of them. Only the shown one is rendered, as a
      // one-frame recipe whose frame name is fixed (the effect's name and frame number passed the renderer's 64).
      while (at < f) {
        at++;
        world.advance(at);
        const drawn = drawFrame(world, width, height, context, at, at === f ? effect.hud : []);
        if (at === f) { const ops = frameOps(effect, drawn, width, height, n); image = renderProject({ ...shell, frames: [{ name: 'frame', ...(ops.length && { ops }) }] }).frames[0].data; }
      }
      return image;
    },
    figures: () => ({ frames: at + 1, ...(copiesOf(world, effect) && { copies: copiesOf(world, effect) }), hits: world.stats.hits, ...(effect.joints.length && { joints: effect.joints.length }), ...(effect.ropes.length && { ropes: effect.ropes.length }), ...clothFigures(world.cloths), ...(world.stats.jointBreaks.length && { brokenJoints: world.stats.jointBreaks }), escaped: world.stats.escaped, ...(world.stats.broken.length && { broken: world.stats.broken }), ...territoryFigures(world.turf, effect.territory) })
  };
}
