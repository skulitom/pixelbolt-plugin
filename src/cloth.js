// Cloth for pixelforge-bodies: a grid of particles held by distance constraints, pinned to fixed points, keys or bodies,
// pushed by gravity and wind, colliding with pixel obstacles and bodies, tearing when stretched too far, and drawn as a
// palette-shaded surface. Browser-compatible and deterministic: only + - * / sqrt, craft.js trigonometry and seeded
// hashes, fixed substeps and iteration counts.
import { fail, isObject } from './core.js';
import { fields, number, integer, pair } from './authoring.js';
import { sinDeg, traceLine } from './craft.js';

const boolean = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected true or false'); return value; };
const identifier = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail(path, 'expected a portable name: a letter, then letters, digits, _ or -, at most 60 characters');
  return value;
};
const key = (value, path, palette) => {
  if (typeof value !== 'string' || value.length !== 1 || value === '.' || value === ' ' || !Object.hasOwn(palette, value)) fail(path, 'expected a single-character key in the palette');
  return value;
};

const LIMITS = { cloths: 16, particles: 4096, pins: 64 };

// Reads a bodies effect's `cloths`. A cloth is a grid of particles at `at`, spaced `cell` pixels apart; cells between four
// present particles are drawn. Pins hold particles to a fixed point, keys over time or a named body's local point.
export function readCloths(list, path, { bodies, byName, palette }) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > LIMITS.cloths) fail(path, `expected a list of at most ${LIMITS.cloths} cloths`);
  let total = 0;
  const names = new Set();
  return list.map((entry, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(entry)) fail(at, 'expected a cloth');
    fields(entry, ['name', 'at', 'size', 'cell', 'mask', 'fill', 'outline', 'back', 'light', 'wind', 'gust', 'stiffness', 'slack', 'shear', 'bend', 'damping', 'tear', 'seed', 'draw', 'collide', 'pins'], at);
    const name = entry.name === undefined ? null : identifier(entry.name, `${at}.name`);
    if (name !== null) { if (names.has(name.toLowerCase())) fail(`${at}.name`, `two cloths are named ${name}`); names.add(name.toLowerCase()); }
    const origin = entry.at === undefined ? [0, 0] : pair(entry.at, `${at}.at`, -4096, 4096);
    if (!Array.isArray(entry.size) || entry.size.length !== 2) fail(`${at}.size`, 'expected [columns, rows] of particles');
    const columns = integer(entry.size[0], `${at}.size[0]`, 2, 128), rows = integer(entry.size[1], `${at}.size[1]`, 2, 128);
    total += columns * rows;
    if (total > LIMITS.particles) fail(`${at}.size`, `the cloths make ${total} particles, more than ${LIMITS.particles}`);
    const cell = integer(entry.cell ?? 1, `${at}.cell`, 1, 8);
    let present = new Uint8Array(columns * rows).fill(1);
    if (entry.mask !== undefined) {
      if (!Array.isArray(entry.mask) || entry.mask.length !== rows || entry.mask.some(row => typeof row !== 'string' || row.length !== columns)) fail(`${at}.mask`, `expected ${rows} rows of ${columns} characters, # for cloth and . for a hole`);
      present = new Uint8Array(columns * rows);
      entry.mask.forEach((row, v) => { for (let u = 0; u < columns; u++) if (row[u] === '#') present[v * columns + u] = 1; else if (row[u] !== '.') fail(`${at}.mask[${v}]`, 'expected # for cloth or . for a hole'); });
    }
    const fills = entry.fill === undefined ? null : (Array.isArray(entry.fill) ? entry.fill : [entry.fill]);
    if (!fills || !fills.length || fills.length > 8) fail(`${at}.fill`, 'expected a palette key, or 1–8 keys from dark to light');
    fills.forEach((value, k) => key(value, `${at}.fill${Array.isArray(entry.fill) ? `[${k}]` : ''}`, palette));
    const outline = entry.outline === undefined ? null : key(entry.outline, `${at}.outline`, palette);
    const back = entry.back === undefined ? null : key(entry.back, `${at}.back`, palette);
    const light = entry.light === undefined ? [0, -1] : pair(entry.light, `${at}.light`, -1, 1);
    const wind = entry.wind === undefined ? [0, 0] : pair(entry.wind, `${at}.wind`, -4, 4);
    const gust = number(entry.gust ?? 0, `${at}.gust`, 0, 1);
    const stiffness = number(entry.stiffness ?? 0.6, `${at}.stiffness`, 0.05, 1);
    const slack = number(entry.slack ?? 0.05, `${at}.slack`, 0, 1);
    const shear = number(entry.shear ?? 0.4, `${at}.shear`, 0, 1);
    const bend = number(entry.bend ?? 0.2, `${at}.bend`, 0, 1);
    const damping = number(entry.damping ?? 0.02, `${at}.damping`, 0, 0.8);
    const tear = entry.tear === undefined ? null : number(entry.tear, `${at}.tear`, 1.01, 16);
    const seed = integer(entry.seed ?? 0, `${at}.seed`, 0, 2147483647);
    const draw = entry.draw ?? 'over';
    if (!['under', 'over'].includes(draw)) fail(`${at}.draw`, 'expected under or over');
    const collide = entry.collide === undefined ? true : boolean(entry.collide, `${at}.collide`);
    if (!present.some(Boolean)) fail(`${at}.mask`, 'the mask leaves no cloth');
    const nodes = [];
    for (let v = 0; v < rows; v++) for (let u = 0; u < columns; u++) {
      const on = present[v * columns + u] === 1;
      nodes.push({ u, v, present: on, x: origin[0] + u * cell, y: origin[1] + v * cell, pin: false });
    }
    const constraints = [];
    const add = (a, b, rest, kind) => {
      if (!nodes[a].present || !nodes[b].present) return;
      constraints.push({ a, b, rest, stiffness: Math.min(1, stiffness * (kind === 'structural' ? 1 : kind === 'shear' ? shear : bend)), broken: false });
    };
    for (let v = 0; v < rows; v++) for (let u = 0; u < columns; u++) {
      const i = v * columns + u;
      if (u + 1 < columns) add(i, i + 1, cell, 'structural');
      if (v + 1 < rows) add(i, i + columns, cell, 'structural');
      if (u + 1 < columns && v + 1 < rows) {
        add(i, i + columns + 1, cell * Math.SQRT2, 'shear');
        add(i + 1, i + columns, cell * Math.SQRT2, 'shear');
      }
      if (u + 2 < columns) add(i, i + 2, 2 * cell, 'bend');
      if (v + 2 < rows) add(i, i + 2 * columns, 2 * cell, 'bend');
    }
    for (const constraint of constraints) constraint.rest *= 1 + slack;
    const pins = [];
    if (entry.pins !== undefined) {
      if (!Array.isArray(entry.pins) || entry.pins.length > LIMITS.pins) fail(`${at}.pins`, `expected a list of at most ${LIMITS.pins} pins`);
      entry.pins.forEach((pin, k) => {
        const pp = `${at}.pins[${k}]`;
        if (!isObject(pin)) fail(pp, 'expected a pin');
        fields(pin, ['at', 'to', 'point', 'keys', 'x', 'y'], pp);
        if (!Array.isArray(pin.at) || pin.at.length !== 2) fail(`${pp}.at`, 'expected [column, row] of a particle');
        const u = integer(pin.at[0], `${pp}.at[0]`, 0, columns - 1), v = integer(pin.at[1], `${pp}.at[1]`, 0, rows - 1);
        const index = v * columns + u;
        if (!nodes[index].present) fail(`${pp}.at`, 'that particle is a hole in the mask');
        let bodyIndex = -1, keys = null, x = nodes[index].x, y = nodes[index].y;
        if (pin.to !== undefined && pin.keys !== undefined) fail(`${pp}.keys`, 'a pin follows a body or keys, not both');
        for (const key of ['x', 'y']) if (pin[key] !== undefined && (pin.to !== undefined || pin.keys !== undefined)) fail(`${pp}.${key}`, `a pin is held at x and y, follows a body (to) or follows keys: ${pin.to !== undefined ? 'to' : 'keys'} already places this one`);
        if (pins.some(other => other.index === index)) fail(`${pp}.at`, `particle [${u}, ${v}] already has a pin`);
        if (pin.point !== undefined && pin.to === undefined) fail(`${pp}.point`, 'point goes with a body');
        if (pin.to !== undefined) {
          if (typeof pin.to !== 'string') fail(`${pp}.to`, 'expected a body name');
          const body = byName.get(pin.to.toLowerCase());
          if (!body) {
            const known = [...byName.values()].map(other => other.name).filter(Boolean);
            fail(`${pp}.to`, `unknown body ${JSON.stringify(pin.to)}${known.length ? `; the bodies are ${known.join(', ')}` : ''}`);
          }
          bodyIndex = bodies.indexOf(body);
          if (bodyIndex < 0) fail(`${pp}.to`, `body ${JSON.stringify(pin.to)} is not part of this effect`);
          const point = pin.point === undefined ? [0, 0] : pair(pin.point, `${pp}.point`, -4096, 4096);
          pins.push({ index, bodyIndex, point, keys: null, x, y, last: null });
          return;
        }
        if (pin.keys !== undefined) {
          if (!Array.isArray(pin.keys) || !pin.keys.length || pin.keys.length > 64) fail(`${pp}.keys`, 'expected 1–64 keys [frame, x, y]');
          keys = pin.keys.map((value, j) => {
            if (!Array.isArray(value) || value.length !== 3) fail(`${pp}.keys[${j}]`, 'expected [frame, x, y]');
            const frame = integer(value[0], `${pp}.keys[${j}][0]`, 0, 18000);
            if (j && frame <= pin.keys[j - 1][0]) fail(`${pp}.keys[${j}][0]`, 'frames increase strictly');
            return [frame, number(value[1], `${pp}.keys[${j}][1]`, -4096, 4096), number(value[2], `${pp}.keys[${j}][2]`, -4096, 4096)];
          });
        }
        if (pin.x !== undefined || pin.y !== undefined) {
          x = number(pin.x ?? x, `${pp}.x`, -4096, 4096);
          y = number(pin.y ?? y, `${pp}.y`, -4096, 4096);
        }
        pins.push({ index, bodyIndex, point: null, keys, x, y, last: null });
      });
    }
    return { name, columns, rows, nodes, constraints, pins, fills, outline, back, light, wind, gust, damping, tear, seed, draw, collide };
  });
}

function keyTarget(pin, frame) {
  const keys = pin.keys;
  if (!keys.length) return [pin.x, pin.y];
  if (frame <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (frame > keys[i][0]) continue;
    const [f0, x0, y0] = keys[i - 1], [f1, x1, y1] = keys[i], t = (frame - f0) / (f1 - f0);
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  }
  return [keys.at(-1)[1], keys.at(-1)[2]];
}

function target(pin, frame) {
  if (pin.body) {
    const body = pin.body;
    if (body.gone) return pin.last ?? [pin.x, pin.y];
    const [lx, ly] = pin.point;
    return [body.x + body.c * lx - body.s * ly, body.y + body.s * lx + body.c * ly];
  }
  return pin.keys ? keyTarget(pin, frame) : [pin.x, pin.y];
}

// The live state of one cloth: particles, constraints and pins. The definition stays untouched.
export function createCloth(definition, { bodies }) {
  const particles = definition.nodes.map(node => ({ ...node, x: node.x, y: node.y, px: node.x, py: node.y, pin: node.pin }));
  const constraints = definition.constraints.map(item => ({ ...item }));
  const pins = definition.pins.map(item => ({ ...item, body: item.bodyIndex >= 0 ? bodies[item.bodyIndex] : null }));
  for (const pin of pins) {
    const targetPoint = target(pin, 0);
    const particle = particles[pin.index];
    particle.x = targetPoint[0]; particle.y = targetPoint[1]; particle.px = targetPoint[0]; particle.py = targetPoint[1]; particle.pin = true;
    pin.last = targetPoint;
  }
  return { definition, particles, constraints, pins, tears: 0, rest: null };
}

const present = (cloth, u, v) => u >= 0 && v >= 0 && u < cloth.definition.columns && v < cloth.definition.rows && cloth.definition.nodes[v * cloth.definition.columns + u].present;
const cell = (cloth, u, v) => present(cloth, u, v) && present(cloth, u + 1, v) && present(cloth, u, v + 1) && present(cloth, u + 1, v + 1);

// Pushes a particle out of a solid cell, to the nearest free cell centre.
function outOfSolid(x, y, solidAt, width, height) {
  const clampX = Math.max(0, Math.min(width - 1, Math.floor(x))), clampY = Math.max(0, Math.min(height - 1, Math.floor(y)));
  if (x >= 0 && y >= 0 && x < width && y < height && !solidAt(clampX, clampY)) return null;
  for (let radius = 1; radius <= 8; radius++) {
    let best = null, bestD = Infinity;
    for (let j = -radius; j <= radius; j++) for (let i = -radius; i <= radius; i++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== radius) continue;
      const cx = clampX + i, cy = clampY + j;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height || solidAt(cx, cy)) continue;
      const d = (cx + 0.5 - x) ** 2 + (cy + 0.5 - y) ** 2;
      if (d < bestD) { bestD = d; best = [cx + 0.5, cy + 0.5]; }
    }
    if (best) return best;
  }
  return [Math.max(0.5, Math.min(width - 0.5, x)), Math.max(0.5, Math.min(height - 0.5, y))];
}

// Pushes a point out of a body's exact shape. Returns the new point and the body, or null.
function outOfBody(x, y, bodies) {
  for (const body of bodies) {
    if (body.gone) continue;
    for (const part of body.world) {
      if (part.kind === 'circle') {
        const dx = x - part.x, dy = y - part.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d >= part.r) continue;
        if (d > 1e-9) return [part.x + dx / d * (part.r + 0.01), part.y + dy / d * (part.r + 0.01), body];
        return [part.x + part.r + 0.01, part.y, body];
      }
      let inside = true, nearest = null, best = -Infinity;
      for (let i = 0; i < part.n; i++) {
        const d = part.nx[i] * (x - part.vx[i]) + part.ny[i] * (y - part.vy[i]);
        if (d > 0) { inside = false; break; }
        if (d > best) { best = d; nearest = i; }
      }
      if (inside && nearest !== null) return [x + part.nx[nearest] * (-best + 0.01), y + part.ny[nearest] * (-best + 0.01), body];
    }
  }
  return null;
}

// Steps a cloth one frame: substeps of integration, pins, distance constraints, collisions and tearing.
export function stepCloth(cloth, frame, { substeps, iterations, gravity, solidAt, bodies, width, height }) {
  const def = cloth.definition, dt = 1 / substeps, damp = 1 - def.damping;
  for (let s = 0; s < substeps; s++) {
    for (const p of cloth.particles) {
      if (!p.present || p.pin) continue;
      const gust = def.gust ? def.gust * sinDeg(def.seed + frame * 7 + p.u * 37 + p.v * 91 + s * 13) : 0;
      // Gusts also flap across the wind: a flag pinned along one edge ripples instead of only stretching.
      const flap = def.gust ? def.gust * sinDeg(def.seed * 3 + frame * 11 + p.u * 53 + p.v * 29 + s * 17) : 0;
      const ax = gravity[0] + def.wind[0] * (1 + gust) - def.wind[1] * flap;
      const ay = gravity[1] + def.wind[1] * (1 + gust) + def.wind[0] * flap;
      const vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp;
      p.px = p.x; p.py = p.y;
      p.x += vx + ax * dt * dt;
      p.y += vy + ay * dt * dt;
    }
    for (const pin of cloth.pins) {
      const point = target(pin, frame), p = cloth.particles[pin.index], was = pin.last ?? point;
      p.px = was[0]; p.py = was[1];
      p.x = point[0]; p.y = point[1];
      pin.last = point;
    }
    for (let k = 0; k < iterations; k++) for (const item of cloth.constraints) {
      if (item.broken) continue;
      const a = cloth.particles[item.a], b = cloth.particles[item.b];
      if (!a.present || !b.present) continue;
      let dx = b.x - a.x, dy = b.y - a.y, distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < 1e-9) continue;
      const wa = a.pin ? 0 : 1, wb = b.pin ? 0 : 1, total = wa + wb;
      if (!total) continue;
      const diff = (distance - item.rest) / distance * item.stiffness;
      const ax = dx * diff * (wa / total), ay = dy * diff * (wa / total);
      const bx = dx * diff * (wb / total), by = dy * diff * (wb / total);
      if (wa) { a.x += ax; a.y += ay; }
      if (wb) { b.x -= bx; b.y -= by; }
    }
    if (def.collide) for (const p of cloth.particles) {
      if (!p.present || p.pin) continue;
      const solid = outOfSolid(p.x, p.y, solidAt, width, height);
      if (solid) { p.x = solid[0]; p.y = solid[1]; p.px = p.x; p.py = p.y; }
      const hit = outOfBody(p.x, p.y, bodies);
      if (hit) {
        p.x = hit[0]; p.y = hit[1];
        p.px = p.x - hit[2].vx * 0.5; p.py = p.y - hit[2].vy * 0.5;
      }
    }
    if (def.tear !== null) for (const item of cloth.constraints) {
      if (item.broken) continue;
      const a = cloth.particles[item.a], b = cloth.particles[item.b];
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > item.rest * def.tear) { item.broken = true; cloth.tears++; }
    }
  }
  let fast = 0;
  for (const p of cloth.particles) if (p.present) fast = Math.max(fast, Math.abs(p.x - p.px), Math.abs(p.y - p.py));
  if (def.wind[0] === 0 && def.wind[1] === 0 && fast < 0.01) cloth.rest ??= frame;
  else cloth.rest = null;
}

// A pixel inside a quad, by the winding of its four corners.
function inside(x, y, cx, cy) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = cx[i], ay = cy[i], bx = cx[(i + 1) % 4], by = cy[(i + 1) % 4];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) < 1e-9) continue;
    const way = Math.sign(cross);
    if (!sign) sign = way;
    else if (way !== sign) return false;
  }
  return true;
}

// Draws cloths into a character grid: each cell a shaded quad, with an optional outline round its edge.
export function paintCloth(cloths, put, n = 1) {
  for (const cloth of cloths) {
    const def = cloth.definition, particles = cloth.particles, light = def.light;
    for (let v = 0; v + 1 < def.rows; v++) for (let u = 0; u + 1 < def.columns; u++) {
      if (!cell(cloth, u, v)) continue;
      const p00 = particles[v * def.columns + u], p10 = particles[v * def.columns + u + 1];
      const p01 = particles[(v + 1) * def.columns + u], p11 = particles[(v + 1) * def.columns + u + 1];
      const cx = [p00.x * n, p10.x * n, p11.x * n, p01.x * n], cy = [p00.y * n, p10.y * n, p11.y * n, p01.y * n];
      const area = (cx[1] - cx[0]) * (cy[2] - cy[1]) - (cy[1] - cy[0]) * (cx[2] - cx[1]) + (cx[2] - cx[0]) * (cy[3] - cy[2]) - (cy[2] - cy[0]) * (cx[3] - cx[2]);
      let fill;
      if (def.back && area < 0) fill = def.back;
      else {
        const tx = p10.x - p00.x, ty = p10.y - p00.y, bx = p01.x - p00.x, by = p01.y - p00.y;
        const tl = Math.sqrt(tx * tx + ty * ty) || 1, bl = Math.sqrt(bx * bx + by * by) || 1;
        const shade = ((tx * light[0] + ty * light[1]) / tl + (bx * light[0] + by * light[1]) / bl) / 2;
        const index = Math.max(0, Math.min(def.fills.length - 1, Math.round((shade + 1) / 2 * (def.fills.length - 1))));
        fill = def.fills[index];
      }
      const color = fill.charCodeAt(0), x0 = Math.floor(Math.min(...cx)), x1 = Math.ceil(Math.max(...cx)), y0 = Math.floor(Math.min(...cy)), y1 = Math.ceil(Math.max(...cy));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x + 0.5, y + 0.5, cx, cy)) put(x, y, color);
      // The edges and the spokes to the centre keep neighbouring cells joined even when a cell is narrower than a pixel.
      const mx = (cx[0] + cx[1] + cx[2] + cx[3]) / 4, my = (cy[0] + cy[1] + cy[2] + cy[3]) / 4;
      for (let i = 0; i < 4; i++) {
        traceLine(Math.floor(cx[i]), Math.floor(cy[i]), Math.floor(cx[(i + 1) % 4]), Math.floor(cy[(i + 1) % 4]), (x, y) => put(x, y, color));
        traceLine(Math.floor(mx), Math.floor(my), Math.floor(cx[i]), Math.floor(cy[i]), (x, y) => put(x, y, color));
      }
      put(Math.floor(mx), Math.floor(my), color);
      if (def.outline) {
        const outline = def.outline.charCodeAt(0);
        const boundary = [[0, 1, u, v - 1], [1, 2, u + 1, v], [2, 3, u, v + 1], [3, 0, u - 1, v]];
        for (const [a, b, nu, nv] of boundary) if (!cell(cloth, nu, nv)) traceLine(Math.floor(cx[a]), Math.floor(cy[a]), Math.floor(cx[b]), Math.floor(cy[b]), (x, y) => put(x, y, outline));
      }
    }
  }
}

// Rough work a cloth asks for, for the source's budget: particles, constraints and cells drawn.
export function clothWork(cloths, { frames, substeps, iterations }) {
  let total = 0;
  for (const cloth of cloths) {
    const particles = cloth.nodes.filter(node => node.present).length;
    const constraints = cloth.constraints.length;
    total += frames * (substeps * (particles * 12 + constraints * iterations * 4) + cloth.columns * cloth.rows * 24);
  }
  return total;
}
