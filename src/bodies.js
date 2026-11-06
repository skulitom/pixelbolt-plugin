// Rigid bodies compiled to ordinary, editable recipes. A pixelforge-bodies source names effects; each drops balls,
// boxes and convex polygons into a canvas with gravity, walls, pixel obstacles and fixed (or spinning) containers, runs
// a small rigid-body simulation and bakes every frame into palette `grid` operations on the source's own palette.
// Bodies bounce, slide, roll, stack, knock each other about and come to rest; a body can start asleep, holding still
// until something hits it, and change colour at each hit.
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
import { PixelError, renderProject } from './core.js';
import { fields } from './authoring.js';
import { sinDeg, cosDeg, traceLine, turnRows } from './craft.js';
import { atan2Deg } from './shapes.js';
import { readTerritory, readPickups, readEvents, readHud, createTerritory } from './territory.js';

export const BODY_SHAPES = ['circle', 'box', 'polygon', 'hoop'];
export const BODY_WALLS = ['left', 'right', 'top', 'bottom'];
const LIMITS = { effects: 16, entries: 64, bodies: 256, obstacles: 32, frames: 256, work: 400000000 };
// A match written as numbered video frames (bodiesFrames) may run this long, and do this much work.
export const MATCH_FRAMES = 18000;
const MATCH_WORK = 4000000000;
const PI = 3.141592653589793, RADIANS = PI / 180;
// Overlap (pixels) the solver leaves alone, the share of the rest it removes each substep, and the fastest it pushes.
const SLOP = 0.02, BIAS = 0.2, MAX_PUSH = 1;
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

const fail = (path, message) => { throw new PixelError(path, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
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

// A convex polygon's local outline, centred on its centroid and wound so (edge.y, −edge.x) points out.
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
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length], [qx, qy] = pts[(i + 2) % pts.length];
    if ((bx - ax) * (qy - by) - (by - ay) * (qx - bx) <= 1e-9) fail(path, 'expected a convex outline, every corner turning the same way (no dents and no three points in a line)');
  }
  return pts;
}

function polygonPart(points, radius = 0) {
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

const BODY_FIELDS = ['temperature', 'team', 'speed', 'name', 'shape', 'radius', 'size', 'points', 'sides', 'gap', 'thickness', 'at', 'angle', 'velocity', 'spin', 'fixed', 'weightless', 'asleep', 'tireless', 'density', 'bounce', 'friction', 'drag', 'spinDrag', 'fill', 'outline', 'symbol', 'trail', 'ring', 'grid'];

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
  let parts, area, inertia, size;
  if (shape === 'circle') {
    const r = number(entry.radius, `${path}.radius`, 0.5, 32);
    parts = [{ kind: 'circle', r }]; area = PI * r * r; inertia = r * r / 2; size = [Math.max(1, Math.round(2 * r)), Math.max(1, Math.round(2 * r))];
  } else if (shape === 'box' || shape === 'polygon') {
    let points;
    if (shape === 'box') {
      const [w, h] = pair(entry.size, `${path}.size`, 1, 64);
      points = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    } else points = convex(entry.points, `${path}.points`);
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
  let fills = null, outline = null, symbol = null;
  if (entry.symbol !== undefined) {
    if (typeof entry.symbol !== 'string' || !Object.hasOwn(symbols, entry.symbol)) fail(`${path}.symbol`, `unknown symbol ${JSON.stringify(entry.symbol)}`);
    if (shape === 'hoop') fail(`${path}.symbol`, 'a hoop is drawn as its outline; give it fill');
    symbol = entry.symbol;
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
    weightless: material.weightless, asleep: material.asleep, tireless: material.tireless, temperature, team, speed, fills, outline, symbol, trail
  }));
}

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

function readEffect(effect, path, context) {
  if (!isObject(effect)) fail(path, 'expected an effect');
  fields(effect, ['frames', 'duration', 'substeps', 'iterations', 'gravity', 'background', 'walls', 'obstacles', 'territory', 'bodies', 'pickups', 'events', 'hud'], path);
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
  const bodies = readBodies(effect.bodies, `${path}.bodies`, { ...context, teams: territory ? territory.teams : null });
  const pickups = readPickups(effect.pickups, `${path}.pickups`, context), events = readEvents(effect.events, `${path}.events`, context, bodies);
  const hud = readHud(effect.hud, `${path}.hud`, context, territory ? territory.teams : null);
  return { frames, duration, substeps, iterations, gravity, background, walls: Object.fromEntries(BODY_WALLS.map(edge => [edge, walls.includes(edge)])), obstacles, territory, bodies, pickups, events, hud };
}

// ---- Pixel obstacles --------------------------------------------------------------------------------------------------
// The solid pixels (and closed edges beyond the canvas) traced into one-sided segments: every exposed pixel edge, joined
// along straight runs, with its outward normal. An end is convex where the solid stops (the run turns a corner away from
// the body); only convex ends round off, so a concave corner is two faces meeting and a flat floor has no seams.
function traceObstacles(effect, width, height) {
  const N = width * height, solid = new Uint8Array(N), owner = new Int16Array(N).fill(-1);
  effect.obstacles.forEach((o, index) => {
    if (!o.solid) return;
    o.rows.forEach((row, j) => {
      const y = o.y + j;
      if (y < 0 || y >= height) return;
      for (let k = 0; k < row.length; k++) {
        const x = o.x + k;
        if (x < 0 || x >= width || row[k] === '.' || row[k] === ' ') continue;
        solid[y * width + x] = 1; if (owner[y * width + x] < 0) owner[y * width + x] = index;
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
  return { ...traceGrid(at, material, width, height, 1, 0, 0, width, height), solid };
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
    segments.push({ ax, ay, bx, by, nx, ny, convexA, convexB, bounce: m.bounce, friction: m.friction, soft: !!m.soft,
      part: polygonPart([[ax, ay], [bx, by]]) });
  };
  // Horizontal faces at y = j, between cell (i, j − 1) above and (i, j) below.
  for (let j = 0; j <= height; j++) for (const up of [true, false]) {
    let start = -1;
    for (let i = 0; i <= width; i++) {
      const face = i < width && (up ? at(i, j) && !at(i, j - 1) : at(i, j - 1) && !at(i, j));
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
function circleCircle(a, b, margin) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy), sep = d - a.r - b.r;
  if (sep > margin) return null;
  const nx = d > 1e-9 ? dx / d : 0, ny = d > 1e-9 ? dy / d : 1;
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
  // A polygon's centre behind the segment is inside the solid; the faces around it push.
  let cx = 0, cy = 0;
  for (let i = 0; i < part.n; i++) { cx += part.vx[i]; cy += part.vy[i]; }
  if ((cx / part.n - s.ax) * s.nx + (cy / part.n - s.ay) * s.ny < 0) return null;
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
    ...b, index, c: cosDeg(b.angle), s: sinDeg(b.angle), w: b.spin * RADIANS, x0: b.x, y0: b.y, angle0: b.angle,
    gone: false, sleepy: 0, hit: false, struck: false, colour: 0, hits: 0, history: [], extent: Math.max(b.size[0], b.size[1]) / 2
  }));
  // A tireless body's energy (motion plus height against gravity), which every hit restores: the cheat that keeps a
  // toy ball bouncing at full height in a ring of loose blocks, whose every knock would otherwise cost it speed.
  const pull = b => b.weightless ? [0, 0] : gravity;
  const energy = b => (b.vx * b.vx + b.vy * b.vy) / 2 - pull(b)[0] * b.x - pull(b)[1] * b.y;
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
    if (bodies.length >= LIMITS.bodies) return null;
    const twin = { ...b, index: bodies.length, name: null, path: `${b.path} (split ${bodies.length})`, history: [], held: undefined, hits: 0, hit: false, struck: false, sleepy: 0, asleep: false };
    place(twin); bodies.push(twin);
    return twin;
  };
  // Territory and powers (territory.js): cells owned by teams, pickups and events.
  const turf = effect.territory || (effect.pickups && effect.pickups.length) || (effect.events && effect.events.length) ? createTerritory(effect, { trace: traceGrid, scale, copy, width, height }) : null;
  const dynamic = b => !b.fixed && !b.gone;
  const moving = b => b.fixed ? (b.vx !== 0 || b.vy !== 0 || b.spin !== 0) : !b.gone && !b.asleep;
  const awake = b => !b.fixed && !b.gone && !b.asleep;
  let warm = new Map();
  const stats = { hits: 0, escaped: [], rest: null, overlaps: [], paths: {} };
  const round = v => Math.round(v * 100) / 100;
  for (const b of bodies) if (b.name !== null && !b.fixed) stats.paths[b.name] = [];
  let time = 0;

  // Contacts between bodies (pairs in index order) and between each awake body and the segments near it.
  const collide = () => {
    const contacts = [];
    const speed = b => b.fixed ? Math.sqrt(b.vx * b.vx + b.vy * b.vy) + Math.abs(b.w) * b.extent : b.asleep ? 0 : Math.sqrt(b.vx * b.vx + b.vy * b.vy) + Math.abs(b.w) * b.extent;
    const order = bodies.filter(b => !b.gone).sort((a, b) => a.box[0] - b.box[0] || a.index - b.index);
    const reach = 2 * Math.max(0, ...order.map(speed)) * dt + 0.1, pairs = [];
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        if (b.box[0] > a.box[2] + reach) break;
        if (a.fixed && b.fixed) continue;
        // An awake body meets anything; a moving fixed body meets sleeping ones, to wake them.
        if (!awake(a) && !awake(b) && !(a.asleep && b.fixed && moving(b)) && !(b.asleep && a.fixed && moving(a))) continue;
        pairs.push(a.index < b.index ? [a, b] : [b, a]);
      }
    }
    pairs.sort((p, q) => p[0].index - q[0].index || p[1].index - q[1].index);
    for (const [a, b] of pairs) {
      const margin = (speed(a) + speed(b)) * dt + 0.1;
      if (!overlaps(a.box, b.box, margin)) continue;
      a.world.forEach((pa, ia) => b.world.forEach((pb, ib) => {
        if (!overlaps(partBox(pa), partBox(pb), margin)) return;
        let m;
        if (pa.kind === 'circle' && pb.kind === 'circle') m = circleCircle(pa, pb, margin);
        else if (pa.kind === 'circle') { m = polygonCircle(pb, pa, margin); if (m) { m.nx = -m.nx; m.ny = -m.ny; } }
        else if (pb.kind === 'circle') m = polygonCircle(pa, pb, margin);
        else m = polygonPolygon(pa, pb, margin);
        if (m) contacts.push({ a, b, key: `${a.index}:${b.index}:${ia}:${ib}`, ...m, bounce: Math.max(a.bounce, b.bounce), friction: Math.sqrt(a.friction * b.friction) });
      }));
    }
    for (const a of bodies) {
      if (!dynamic(a) || a.asleep) continue;
      const margin = speed(a) * dt + 0.1, [x0, y0, x1, y1] = a.box;
      for (const index of world.near(x0 - margin, y0 - margin, x1 + margin, y1 + margin)) {
        const s = world.segments[index];
        a.world.forEach((pa, ia) => {
          const m = partSegment(pa, s, margin);
          if (m) contacts.push({ a, b: null, key: `${a.index}:s${index}:${ia}`, ...m, bounce: Math.max(a.bounce, s.bounce), friction: Math.sqrt(a.friction * s.friction), soft: s.soft });
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
  const apply = (contact, point, px, py) => {
    const { a, b } = contact;
    if (!solid(a)) { a.vx -= a.invMass * px; a.vy -= a.invMass * py; a.w -= a.invInertia * (point.rax * py - point.ray * px); }
    if (!solid(b)) { b.vx += b.invMass * px; b.vy += b.invMass * py; b.w += b.invInertia * (point.rbx * py - point.rby * px); }
  };
  const relative = (contact, point) => {
    const [vax, vay] = velocityAt(contact.a, point.rax, point.ray), [vbx, vby] = velocityAt(contact.b, point.rbx, point.rby);
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

  const substep = () => {
    // Fixed bodies move exactly as their velocity and spin say.
    for (const b of bodies) if (b.fixed && moving(b)) {
      b.x = b.x0 + b.vx * time; b.y = b.y0 + b.vy * time;
      const a = b.angle0 + b.spin * time; b.c = cosDeg(a); b.s = sinDeg(a); place(b);
    }
    const contacts = collide();
    // A body moving into a sleeping one wakes it; so does anything moving that it rests on.
    const woken = new Set();
    for (const contact of contacts) {
      const { a, b } = contact;
      if (!b) continue;
      for (const [sleeper, other] of [[a, b], [b, a]]) {
        if (!sleeper.asleep || !moving(other)) continue;
        const point = contact.points[0], rax = point.x - a.x, ray = point.y - a.y, rbx = point.x - b.x, rby = point.y - b.y;
        const [vax, vay] = velocityAt(a, rax, ray), [vbx, vby] = velocityAt(b, rbx, rby), vn = (vbx - vax) * contact.nx + (vby - vay) * contact.ny;
        const otherSpeed = Math.sqrt(other.vx * other.vx + other.vy * other.vy) + Math.abs(other.w) * other.extent;
        if (vn < -WAKE_SPEED || (!sleeper.weightless && otherSpeed > 4 * SLEEP_SPEED)) { sleeper.asleep = false; sleeper.sleepy = 0; woken.add(sleeper); }
      }
    }
    // A woken body wakes the sleeping bodies it touches, and they theirs, as a stack is held up by its neighbours: a
    // knocked crate pushes the crates beside it instead of the still ones holding it as a wall. A weightless body leans
    // on nothing, so it wakes only when something moves into it.
    for (const queue = [...woken]; queue.length;) {
      const w = queue.shift();
      for (const o of bodies) if (o.asleep && !o.weightless && !o.gone && overlaps(w.box, o.box, 0.25)) { o.asleep = false; o.sleepy = 0; queue.push(o); }
    }
    // Velocities: gravity, drag, and the speed limits.
    for (const b of bodies) {
      if (!dynamic(b) || b.asleep) continue;
      if (!b.weightless) { b.vx += gravity[0] * dt; b.vy += gravity[1] * dt; }
      if (turf) turf.pull(b, dt);
      // A force from outside the solver (a fluid's buoyancy), steady through the frame as gravity is.
      if (b.push) { b.vx += b.push[0] * dt; b.vy += b.push[1] * dt; b.w += b.push[2] * dt; }
      if (b.drag) { const k = 1 / (1 + b.drag * dt); b.vx *= k; b.vy *= k; }
      if (b.spinDrag) b.w *= 1 / (1 + b.spinDrag * dt);
      const v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 > MAX_SPEED * MAX_SPEED) { const k = MAX_SPEED / Math.sqrt(v2); b.vx *= k; b.vy *= k; }
      const spinLimit = 2 * MAX_SPEED / Math.max(0.5, b.extent);
      if (b.w > spinLimit) b.w = spinLimit; else if (b.w < -spinLimit) b.w = -spinLimit;
    }
    // Prepare each point: its arms, masses, the approach speed it bounces from, and the impulses it starts with.
    const next = new Map();
    for (const contact of contacts) {
      const { a, b, nx, ny } = contact, tx = ny, ty = -nx;
      const ma = solid(a) ? 0 : a.invMass, ia = solid(a) ? 0 : a.invInertia, mb = solid(b) ? 0 : b.invMass, ib = solid(b) ? 0 : b.invInertia;
      for (const point of contact.points) {
        point.rax = point.x - a.x; point.ray = point.y - a.y; point.rbx = b ? point.x - b.x : 0; point.rby = b ? point.y - b.y : 0;
        const ran = point.rax * ny - point.ray * nx, rbn = point.rbx * ny - point.rby * nx, rat = point.rax * ty - point.ray * tx, rbt = point.rbx * ty - point.rby * tx;
        const kn = ma + mb + ia * ran * ran + ib * rbn * rbn, kt = ma + mb + ia * rat * rat + ib * rbt * rbt;
        point.normalMass = kn > 0 ? 1 / kn : 0; point.tangentMass = kt > 0 ? 1 / kt : 0;
        const [dvx, dvy] = relative(contact, point);
        point.approach = dvx * nx + dvy * ny;
        const kept = warm.get(`${contact.key}:${point.id}`);
        point.normal = kept ? kept[0] : 0; point.tangent = kept ? kept[1] : 0; point.most = 0;
      }
    }
    for (const contact of contacts) for (const point of contact.points) {
      const { nx, ny } = contact;
      apply(contact, point, nx * point.normal + ny * point.tangent, ny * point.normal - nx * point.tangent);
    }
    for (let k = 0; k < iterations; k++) solve(contacts, true);
    // Positions.
    for (const b of bodies) {
      if (!dynamic(b) || b.asleep) continue;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.w) {
        const turn = b.w * dt, c = b.c - b.s * turn, s = b.s + b.c * turn, m = Math.sqrt(c * c + s * s);
        b.c = c / m; b.s = s / m;
      }
      place(b);
    }
    // Relax: the push out of overlaps leaves no velocity behind.
    for (let k = 0; k < Math.max(1, iterations >> 1); k++) solve(contacts, false);
    // Restitution, from the approach speed before the solve, on points that pushed.
    for (const contact of contacts) {
      if (contact.bounce === 0) continue;
      const { nx, ny } = contact;
      for (const point of contact.points) {
        if (point.approach > -REST_SPEED || point.most === 0) continue;
        const [dvx, dvy] = relative(contact, point), vn = dvx * nx + dvy * ny;
        const old = point.normal, more = Math.max(old - point.normalMass * (vn + contact.bounce * point.approach), 0), impulse = more - old;
        point.normal = more;
        apply(contact, point, nx * impulse, ny * impulse);
      }
    }
    for (const contact of contacts) for (const point of contact.points) {
      next.set(`${contact.key}:${point.id}`, [point.normal, point.tangent]);
      if (point.approach < -REST_SPEED && point.most > 0) { contact.a.hit = contact.a.struck = true; if (contact.b) contact.b.hit = contact.b.struck = true; }
    }
    // The cells hit change hands; a body with a held speed goes on at it, along its own heading.
    if (turf) { for (const contact of contacts) if (contact.cell) turf.hit(contact, contact.cell); turf.settle(); }
    for (const b of bodies) {
      if (!b.speed || !dynamic(b) || b.asleep) continue;
      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (v > 1e-9) { b.vx *= b.speed / v; b.vy *= b.speed / v; }
    }
    for (const b of bodies) {
      if (!b.struck) continue;
      b.struck = false;
      if (!b.tireless || b.asleep || b.gone) continue;
      const [gx, gy] = pull(b), want = 2 * (b.energy + gx * b.x + gy * b.y), has = b.vx * b.vx + b.vy * b.vy;
      if (want > has && has > 1e-12) { const k = Math.sqrt(want / has); b.vx *= k; b.vy *= k; }
    }
    warm = next;
    time += dt;
  };

  // The first frame's overlaps, reported as warnings: bodies that start inside each other or an obstacle.
  for (const contact of collide()) {
    const pair = contact.b ? `${contact.a.path} starts inside ${contact.b.path}` : `${contact.a.path} starts inside an obstacle or wall`;
    if (contact.points.some(p => p.sep < -0.5) && !stats.overlaps.includes(pair)) stats.overlaps.push(pair);
  }
  const advance = f => {
    if (f > 0) for (let k = 0; k < substeps; k++) substep();
    // Powers run out and are taken, and the score is counted, between frames.
    if (turf) { turf.frame(f, bodies); for (const b of bodies) if (!b.gone) place(b); }
    // Hits change colour once a frame; slow bodies fall asleep; bodies far outside the canvas are gone.
    for (const b of bodies) {
      if (b.gone) continue;
      if (b.hit) { b.hits++; stats.hits++; if (b.fills && b.fills.length > 1) b.colour = (b.colour + 1) % b.fills.length; b.hit = false; }
      if (dynamic(b) && !b.asleep) {
        const fast = Math.max(Math.sqrt(b.vx * b.vx + b.vy * b.vy), Math.abs(b.w) * b.extent);
        b.sleepy = fast < SLEEP_SPEED ? b.sleepy + 1 : 0;
        if (b.sleepy >= SLEEP_FRAMES) { b.asleep = true; b.vx = 0; b.vy = 0; b.w = 0; }
      }
      const [x0, y0, x1, y1] = b.box;
      if (!b.fixed && (x1 < -GONE || y1 < -GONE || x0 > width + GONE || y0 > height + GONE)) { b.gone = true; stats.escaped.push({ body: b.name ?? b.path, frame: f }); }
      b.history.push([b.x, b.y]);
      if (b.name !== null && !b.fixed) stats.paths[b.name].push(b.gone ? null : [round(b.x), round(b.y), round(atan2Deg(b.s, b.c))]);
      if (b.history.length > 18) b.history.shift();
    }
    if (stats.rest === null && f > 0 && bodies.every(b => b.gone || b.fixed && !moving(b) || b.asleep)) stats.rest = f;
  };
  return { bodies, stats, gravity, advance, turf, retrace: obstacles => { world = traceObstacles({ obstacles, walls: effect.walls }, width, height); } };
}

function simulate(effect, context) {
  const world = createBodyWorld(effect, context), drawn = [];
  for (let f = 0; f < effect.frames; f++) { world.advance(f); drawn.push(drawFrame(world, context.width, context.height, context, f, effect.hud)); }
  return { drawn, stats: world.stats, turf: world.turf, steps: (effect.frames - 1) * effect.substeps };
}

// ---- Drawing ----------------------------------------------------------------------------------------------------------
// A shape whose size is odd centres on a pixel's middle and an even one on a pixel corner, so a body at rest draws the
// same pixels as its sprite at angle 0 and moves in whole pixels.
const snap = (value, size) => (size % 2 ? Math.floor(value) + 0.5 : Math.round(value));
// A body keeps the pixel it is drawn at until it has moved HOLD past the halfway mark to the next, and its drawn angle
// until it has turned TURN_HOLD of a step past halfway, so a body rocking about a boundary (a crate bobbing on water, a
// box settling) holds still instead of flickering between two pixels. A fluid's solid cells for it are where it really
// is (exactCells), and the fluid draws its liquid in those its drawing leaves uncovered.
const HOLD = 0.3, TURN_HOLD = 0.2;
function held(b, axis, size) {
  const value = axis ? b.y : b.x, next = snap(value, size), memory = b.held ??= {}, key = `${axis}:${size}`, was = memory[key];
  if (was === undefined || (next !== was && Math.abs(value - was) >= 0.5 + HOLD)) memory[key] = next;
  return memory[key];
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
// and each row's outer pixels on the side arcs, so it is 8-connected with no doubled steps; thicker, every pixel whose
// centre lies within half the thickness of the circle.
const rings = new Map();
// Cached about the centre's place within its pixel (a whole or half pixel) and moved to the centre, so a hoop that moves
// reuses one ring instead of making one for every pixel it passes.
function ring(x, y, r, thickness) {
  const ix = Math.floor(x), iy = Math.floor(y), at = cells => cells.map(([px, py]) => [px + ix, py + iy]);
  const cx = x - ix, cy = y - iy, key = `${cx},${cy},${r},${thickness}`;
  if (rings.has(key)) return at(rings.get(key));
  const seen = new Set(), cells = [], add = (px, py) => { if (!seen.has(py * 65536 + px)) { seen.add(py * 65536 + px); cells.push([px, py]); } };
  if (thickness <= 1) {
    const reach = r / Math.sqrt(2);
    for (let px = Math.floor(cx - reach); px <= Math.ceil(cx + reach); px++) {
      const dx = px + 0.5 - cx;
      if (Math.abs(dx) > reach) continue;
      const dy = Math.sqrt(r * r - dx * dx);
      add(px, Math.floor(cy - dy)); add(px, Math.floor(cy + dy));
    }
    for (let py = Math.floor(cy - reach); py <= Math.ceil(cy + reach); py++) {
      const dy = py + 0.5 - cy;
      if (Math.abs(dy) > reach) continue;
      const dx = Math.sqrt(r * r - dy * dy);
      add(Math.floor(cx - dx), py); add(Math.floor(cx + dx), py);
    }
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
    // with few sides (a hexagon) really changes shape as it turns, so it is drawn from its walls.
    if (r * (1 - cosDeg(180 / sides)) < 0.35) {
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
    const world = points.map(([px, py]) => [x + b.c * px - b.s * py, y + b.s * px + b.c * py]);
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
  const cx = x === b.x ? held(b, 0, b.size[0]) : snap(x, b.size[0]), cy = y === b.y ? held(b, 1, b.size[1]) : snap(y, b.size[1]), n = part.n, vx = [], vy = [], nx = [], ny = [], [c, s] = drawnTurn(b);
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
function drawnDegrees(b, size = b.size) {
  const step = turnStep(size), exact = atan2Deg(b.s, b.c);
  let degrees = Math.round(exact / step) * step;
  if (degrees >= 360) degrees -= 360;
  const memory = b.held ??= {}, key = `turn:${step}`, was = memory[key];
  if (was !== undefined && degrees !== was) {
    const apart = Math.abs(((exact - was) % 360 + 540) % 360 - 180);
    if (apart < step / 2 + step * TURN_HOLD) degrees = was;
  }
  memory[key] = degrees;
  return degrees;
}
function drawnTurn(b) { const degrees = drawnDegrees(b); return [cosDeg(degrees), sinDeg(degrees)]; }

// A box or polygon upright: its cells at angle 0 around its middle, the edge in its outline's key and the rest in its
// fill (the fill it has now, for a body that changes colour at each hit).
const uprights = new Map();
function uprightRows(b) {
  const [w, h] = b.size, fill = b.fills[b.colour], key = `${b.shape}:${b.size}:${b.parts[0].vx.join()}:${b.parts[0].vy.join()}:${fill}:${b.outline ?? ''}`;
  if (uprights.has(key)) return uprights.get(key);
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
  if (b.symbol) { const rows = symbols[b.symbol]; return { rows, cx: rows[0].length / 2, cy: rows.length / 2 }; }
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

// Drawn finer than the world's pixels, a body holds its drawn place to the fine pixel until it has moved HOLD past
// halfway to the next, as at whole pixels, and its drawn angle until it has turned more than half a step and TURN_HOLD
// of one (a step is a degree, or less for a body so long that a degree would move its ends more than a fine pixel), then
// takes its own: a crate bobbing on the water or a box rocking as it settles holds still instead of shimmering, one that
// slides moves a fine pixel at a time with its picture unchanged, and one that spins turns evenly. Its place is snapped
// so its picture's pixel edges, turned to the nearest quarter turn, fall between the fine pixels' centres: sampled on
// them, a box at rest a hundredth of a degree off square was drawn sheared, one half of each side a fine pixel off the
// other.
function heldTurn(b, reach, n) {
  let step = 1;
  while (step > 1 / 16 && reach * n * step * RADIANS > 1) step /= 2;
  const exact = atan2Deg(b.s, b.c), memory = b.held ??= {}, was = memory.fineTurn;
  if (was === undefined || Math.abs(((exact - was) % 360 + 540) % 360 - 180) >= step * (0.5 + TURN_HOLD)) memory.fineTurn = exact;
  return memory.fineTurn;
}
// `offset` is where the picture's edges lie from its centre, in this quarter turn: the drawn centre is that far off a
// fine pixel's edge. A new quarter turn (or picture) starts the hold afresh.
function heldFine(b, axis, offset, n, q) {
  const value = ((axis ? b.y : b.x) - offset) * n, next = Math.round(value), memory = b.held ??= {}, key = `fine:${axis}`, was = memory[key];
  if (!was || was.q !== q || was.offset !== offset || was.n !== n || (next !== was.at && Math.abs(value - was.at) >= 0.5 + HOLD)) memory[key] = { at: next, q, offset, n };
  return memory[key].at / n + offset;
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
    if (b.gone || !b.trail || b.history.length < 2) continue;
    const code = b.trail.color.charCodeAt(0), points = b.history.slice(-1 - b.trail.length), d = Math.max(1, Math.min(b.size[0], b.size[1]) - 1) * n, cells = disc(d);
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k], [bx, by] = points[k + 1], steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * n));
      for (let s = 0; s < steps; s++) {
        const left = Math.round((ax + (bx - ax) * s / steps) * n - d / 2), top = Math.round((ay + (by - ay) * s / steps) * n - d / 2);
        for (const [i, j] of cells) put(left + i, top + j, code);
      }
    }
  }
  for (const b of bodies) {
    if (b.gone) continue;
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
  const n = context.subpixels ?? 1, grid = new Uint16Array(width * n * height * n);
  if (world.turf) world.turf.draw(grid, width, height, f, context.symbols, n);
  if (n > 1) paintBodiesFine(world.bodies, grid, width, height, context.symbols, n);
  else paintBodies(world.bodies, grid, width, height, context.symbols);
  return { ...crop(grid, width * n, height * n), hud: world.turf && hud.length ? world.turf.hud(f, hud, n) : [] };
}

/** Draws the bodies into `grid` (character codes, width × height): trails first, then each body in order. */
export function paintBodies(bodies, grid, width, height, symbols) {
  const context = { symbols };
  const put = (x, y, code) => { if (x >= 0 && y >= 0 && x < width && y < height) grid[y * width + x] = code; };
  // Trails first, under every body: the body's own shape shrunk by a pixel, along where it was in recent frames.
  for (const b of bodies) {
    if (b.gone || !b.trail || b.history.length < 2) continue;
    const code = b.trail.color.charCodeAt(0), points = b.history.slice(-1 - b.trail.length), d = Math.max(1, Math.min(b.size[0], b.size[1]) - 1);
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k], [bx, by] = points[k + 1], steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
      for (let t = 0; t < steps; t++) {
        const x = ax + (bx - ax) * t / steps, y = ay + (by - ay) * t / steps, left = snap(x, d) - d / 2, top = snap(y, d) - d / 2;
        for (const [i, j] of disc(d)) put(left + i, top + j, code);
      }
    }
  }
  for (const b of bodies) {
    if (b.gone) continue;
    // A box or polygon is drawn as its upright picture, fill and outline, turned by turnRows (as a symbol is): its sides
    // turned to whole pixel steps, straight and even, and its outline kept a closed line, so it stays the same crisp shape
    // as it turns. (Drawn afresh from the pixels it covered it swelled into a blob; resampled as RotSprite does it rounded
    // off and grew spikes; resampled exactly it grew a nub at each corner.) Under 6 pixels across it is drawn square: no
    // picture that small shows a turn without a pinwheel.
    const upright = !b.symbol && (b.shape === 'box' || b.shape === 'polygon') && Math.max(b.size[0], b.size[1]) >= 6 ? uprightRows(b) : null;
    if (b.symbol || upright) {
      const rows = upright ?? context.symbols[b.symbol], degrees = b.shape === 'circle' ? 0 : Math.round(drawnDegrees(b, [rows[0].length, rows.length])) % 360;
      const { rows: turned, origin } = sprite(rows, b.shape === 'circle' ? 0 : degrees);
      // Turned about its centre, which sits on the body's drawn centre (the picture's top-left at angle 0 a whole pixel);
      // the turned picture lies there to the nearest pixel.
      const w = rows[0].length, h = rows.length, cx = held(b, 0, w), cy = held(b, 1, h);
      const left = Math.round(cx - w / 2 + origin[0]), top = Math.round(cy - h / 2 + origin[1]);
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

// About how many pair tests and contact updates a simulation needs, so a source can't ask for minutes of work.
const work = effect => {
  const n = effect.bodies.length;
  return effect.frames * effect.substeps * (n * n / 2 + n * (effect.iterations + 2) * 16 + n * 32);
};

// The pixels whose centres a body's exact shape covers, where it really is: a fluid's solid cells for it. Drawn at a
// held pixel, a body may sit most of a pixel from them; were its solid cells drawn ones, each step of its drawing down
// would cover a row of the sand it stands on, and it would sink for ever.
function exactCells(b) {
  const out = [];
  for (const part of b.world) {
    if (part.kind === 'circle') {
      for (let py = Math.floor(part.y - part.r); py <= Math.ceil(part.y + part.r); py++) for (let px = Math.floor(part.x - part.r); px <= Math.ceil(part.x + part.r); px++) {
        const dx = px + 0.5 - part.x, dy = py + 0.5 - part.y;
        if (dx * dx + dy * dy <= part.r * part.r) out.push([px, py]);
      }
      // A body smaller than a pixel still fills the one its centre is in.
      if (!out.length) out.push([Math.floor(part.x), Math.floor(part.y)]);
      continue;
    }
    const [x0, y0, x1, y1] = part.box;
    for (let py = Math.floor(y0); py <= Math.ceil(y1); py++) for (let px = Math.floor(x0); px <= Math.ceil(x1); px++) {
      let inside = true;
      for (let i = 0; i < part.n && inside; i++) {
        const d = part.nx[i] * (px + 0.5 - part.vx[i]) + part.ny[i] * (py + 0.5 - part.vy[i]);
        if (part.n === 2 ? false : d > 0) inside = false;
      }
      if (part.n === 2) {
        const ex = part.vx[1] - part.vx[0], ey = part.vy[1] - part.vy[0], t = Math.max(0, Math.min(1, ((px + 0.5 - part.vx[0]) * ex + (py + 0.5 - part.vy[0]) * ey) / (ex * ex + ey * ey)));
        const dx = px + 0.5 - part.vx[0] - t * ex, dy = py + 0.5 - part.vy[0] - t * ey;
        inside = dx * dx + dy * dy <= Math.max(0.5, part.r) * Math.max(0.5, part.r);
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
  const n = readSubpixels(source.subpixels, 'bodies', width, height, source.effects);
  const symbols = source.symbols ?? {};
  if (!isObject(symbols)) fail('bodies.symbols', 'expected named symbols for obstacles and sprites');
  for (const [name, rows] of Object.entries(symbols)) {
    identifier(name, `bodies.symbols.${name}`);
    if (!Array.isArray(rows) || !rows.length || rows.length > 256 || typeof rows[0] !== 'string' || !rows[0].length || rows.some(row => typeof row !== 'string' || row.length !== rows[0].length)) fail(`bodies.symbols.${name}`, 'expected 1–256 equal-width text rows');
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
  ...(turf && turf.stats.taken.length && { powers: turf.stats.taken })
});

/** A version-1 pixelforge-bodies source → { recipe, metadata, warnings? }. One-shot: bodies don't loop. */
export function compileBodies(source) {
  const { shell, width, height, n, symbols, effects } = readSource(source, LIMITS.frames);
  const frames = [], animations = {}, metadata = { format: 'pixelforge-bodies-metadata', version: 1, effects: {} }, warnings = [];
  let total = 0;
  for (const { name, path, effect } of effects) {
    if (frames.length + effect.frames > LIMITS.frames) fail('bodies.effects', `the effects make more than ${LIMITS.frames} frames; a recipe holds at most ${LIMITS.frames}`);
    framesFit(frames.length + effect.frames, width, height, n, 'bodies');
    total += work(effect);
    if (total > LIMITS.work) fail(path, `the simulations need about ${Math.round(total / 1e6)} million updates, more than ${LIMITS.work / 1e6} million; lower frames, substeps, iterations or the number of bodies`);
    const run = simulate(effect, { width, height, symbols, subpixels: n }), names = [];
    run.drawn.forEach((frame, i) => {
      const ops = frameOps(effect, frame, width, height, n);
      frames.push({ name: `${name}-${i}`, duration: effect.duration, ...(ops.length && { ops }) });
      names.push(`${name}-${i}`);
    });
    animations[name] = { frames: names, loop: false };
    const effectWarnings = run.stats.overlaps.map(pair => `${pair}; they push apart on the first frame. Move it clear`);
    if (!run.drawn.some(frame => frame.pixels)) effectWarnings.push(`${path}: no body is ever on the canvas; check at against width and height`);
    warnings.push(...effectWarnings);
    const played = territoryFigures(run.turf, effect.territory);
    metadata.effects[name] = {
      frames: effect.frames, substeps: effect.substeps, steps: run.steps, bodies: effect.bodies.length, hits: run.stats.hits,
      escaped: run.stats.escaped, rest: run.stats.rest, pixels: run.drawn.map(frame => frame.pixels), ...(Object.keys(run.stats.paths).length && { paths: run.stats.paths }), ...played, ...(effectWarnings.length && { warnings: effectWarnings })
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
  if (work(effect) > MATCH_WORK) fail(path, `the match needs about ${Math.round(work(effect) / 1e6)} million updates, more than ${MATCH_WORK / 1e6} million; lower frames, substeps, iterations or the number of bodies`);
  const world = createBodyWorld(effect, { width, height }), context = { width, height, symbols, subpixels: n };
  let at = -1, image = null;
  return {
    name: source.name, effect: name, width: width * n, height: height * n, palette, frames: effect.frames, duration: effect.duration,
    image: f => {
      if (!Number.isInteger(f) || f < at || f >= effect.frames) fail('sequence', `frame ${f} is not ahead of frame ${at} within the match's ${effect.frames}`);
      while (at < f) { at++; world.advance(at); if (at === f) { const ops = frameOps(effect, drawFrame(world, width, height, context, at, effect.hud), width, height, n); image = renderProject({ ...shell, frames: [{ name: `${name}-${at}`, ...(ops.length && { ops }) }] }).frames[0].data; } }
      return image;
    },
    figures: () => ({ frames: at + 1, hits: world.stats.hits, escaped: world.stats.escaped, ...territoryFigures(world.turf, effect.territory) })
  };
}
