// Joints for pixelforge-bodies: distance, rope, spring, hinge and weld constraints between bodies, with optional break
// thresholds. Browser-compatible and deterministic: only + - * / and sqrt, craft.js trigonometry, fixed iteration counts
// and joints solved in the order they are declared. A world anchor is a joint end without a body.
import { fail, isObject } from './core.js';
import { fields, number, pair } from './authoring.js';
import { cosDeg, sinDeg, traceLine } from './craft.js';
import { atan2Deg } from './shapes.js';

const boolean = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected true or false'); return value; };
const normalize = degrees => ((degrees % 360) + 540) % 360 - 180;
const JOINTS = ['distance', 'rope', 'spring', 'hinge', 'weld'];
const DEG = Math.PI / 180;
const bodyAngle = body => body ? atan2Deg(body.s ?? sinDeg(body.angle ?? 0), body.c ?? cosDeg(body.angle ?? 0)) : 0;
const BETA = 0.35, MAX_CORRECTION = 0.5, MAX_IMPULSE = 200;

export const JOINT_TYPES = JOINTS;

// The world point a body's local point lies at, from the angle it was read with (before a world places it).
function readPoint(body, local) {
  if (!body) return local;
  const c = cosDeg(body.angle ?? 0), s = sinDeg(body.angle ?? 0);
  return [body.x + c * local[0] - s * local[1], body.y + s * local[0] + c * local[1]];
}

// Reads a bodies effect's `joints`: constraints between named bodies, or between a body and the world. Every joint keeps
// body indices, so a world can resolve them to its own body objects.
export function readJoints(list, path, { bodies, byName }) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 256) fail(path, 'expected a list of at most 256 joints');
  const names = new Set();
  return list.map((entry, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(entry)) fail(at, 'expected a joint');
    fields(entry, ['name', 'a', 'b', 'type', 'anchorA', 'anchorB', 'length', 'max', 'stiffness', 'damping', 'break', 'collide', 'limit'], at);
    if (!JOINTS.includes(entry.type)) fail(`${at}.type`, `expected ${JOINTS.join(', ')}`);
    const reference = (value, where) => {
      if (value === 'world') return { index: -1, body: null };
      if (typeof value !== 'string') fail(where, 'expected a body name or "world"');
      const body = byName.get(value.toLowerCase());
      if (!body) {
        const known = [...byName.values()].map(other => other.name).filter(Boolean);
        fail(where, `unknown body ${JSON.stringify(value)}; a joint names a body by its name${known.length ? ` (this effect names ${known.join(', ')})` : ', and no body of this effect has one'}`);
      }
      const index = bodies.indexOf(body);
      if (index < 0) fail(where, `body ${JSON.stringify(value)} is not part of this effect`);
      return { index, body };
    };
    const first = reference(entry.a, `${at}.a`), second = reference(entry.b, `${at}.b`);
    if (first.index < 0 && second.index < 0) fail(`${at}.b`, 'a joint needs at least one body; both ends are the world');
    if (first.index === second.index) fail(`${at}.b`, 'a joint joins two bodies, or a body and the world; both ends are the same body');
    const la = entry.anchorA === undefined ? [0, 0] : pair(entry.anchorA, `${at}.anchorA`, -4096, 4096);
    const lb = entry.anchorB === undefined ? [0, 0] : pair(entry.anchorB, `${at}.anchorB`, -4096, 4096);
    const pa = readPoint(first.body, la), pb = readPoint(second.body, lb);
    const current = Math.sqrt((pb[0] - pa[0]) ** 2 + (pb[1] - pa[1]) ** 2);
    const type = entry.type;
    let length = type === 'hinge' || type === 'weld' ? 0 : entry.length === undefined ? current : number(entry.length, `${at}.length`, 0, 4096);
    let max = length;
    if (type === 'rope') {
      max = entry.max === undefined ? entry.length === undefined ? current : length : number(entry.max, `${at}.max`, 0, 4096);
      length = max;
    } else if (entry.max !== undefined) fail(`${at}.max`, 'max goes with a rope; a distance joint keeps its length');
    if (type === 'hinge' || type === 'weld') {
      if (entry.length !== undefined) fail(`${at}.length`, 'a hinge or weld keeps its anchors together; length goes with a distance, rope or spring');
    }
    let limit = null;
    if (entry.limit !== undefined) {
      if (type !== 'hinge') fail(`${at}.limit`, type === 'weld' ? 'a weld holds the angle its bodies start at; an angle limit goes with a hinge' : 'an angle limit goes with a hinge');
      limit = pair(entry.limit, `${at}.limit`, -3600, 3600);
      if (limit[0] > limit[1]) fail(`${at}.limit`, 'expected [smallest, largest] angle in degrees');
    }
    const name = entry.name === undefined ? null : (() => {
      if (typeof entry.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(entry.name)) fail(`${at}.name`, 'expected a portable name: a letter, then letters, digits, _ or -, at most 60 characters');
      if (names.has(entry.name.toLowerCase())) fail(`${at}.name`, `two joints are named ${entry.name}`);
      names.add(entry.name.toLowerCase());
      return entry.name;
    })();
    if (entry.stiffness !== undefined && type === 'rope') fail(`${at}.stiffness`, 'a rope pulls only when it is taut and has no stiffness to set; a spring or a distance joint has');
    const stiffness = type === 'spring' && entry.stiffness === undefined ? 0.4 : number(entry.stiffness ?? 1, `${at}.stiffness`, 0.05, 1);
    const damping = number(entry.damping ?? 0, `${at}.damping`, 0, 1);
    const breaks = entry.break === undefined ? null : number(entry.break, `${at}.break`, 0.01, 1000000);
    const collide = entry.collide === undefined ? false : boolean(entry.collide, `${at}.collide`);
    const baseAngle = type === 'weld' ? normalize(bodyAngle(second.body) - bodyAngle(first.body)) : 0;
    return { name, path: at, type, aIndex: first.index, bIndex: second.index, la, lb, length, max, stiffness, damping, break: breaks, collide, limit, baseAngle, broken: false, accN: 0, accA: 0 };
  });
}

// A joint made by a rope (a chain of link bodies), in the shape a world resolves.
export function ropeJoint(aIndex, bIndex, la, lb, max, breakAt, path) {
  return { name: null, path, type: 'rope', aIndex, bIndex, la, lb, length: max, max, stiffness: 1, damping: 0, break: breakAt, collide: false, limit: null, baseAngle: 0, broken: false, accN: 0, accA: 0 };
}

// The pair key of two bodies whose contacts a joint leaves out.
export const pairKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

// The body pairs whose contacts are left out (a joint with collide: false).
export function jointPairs(joints) {
  const out = new Set();
  for (const joint of joints) {
    if (joint.collide || joint.aIndex < 0 || joint.bIndex < 0) continue;
    out.add(pairKey(joint.aIndex, joint.bIndex));
  }
  return out;
}

const solid = body => !body || body.fixed || body.asleep;
const moving = body => body && (Math.abs(body.vx) + Math.abs(body.vy) + Math.abs(body.w) > 1e-9);

// A joint's two anchor points in the world.
function anchors(joint) {
  const { a, b } = joint;
  const ax = a ? a.x + a.c * joint.la[0] - a.s * joint.la[1] : joint.la[0];
  const ay = a ? a.y + a.s * joint.la[0] + a.c * joint.la[1] : joint.la[1];
  const bx = b ? b.x + b.c * joint.lb[0] - b.s * joint.lb[1] : joint.lb[0];
  const by = b ? b.y + b.s * joint.lb[0] + b.c * joint.lb[1] : joint.lb[1];
  return [ax, ay, bx, by];
}

// Wakes a sleeping body joined to a moving one, one link per substep (a rope bridge settles as a whole).
export function wakeJoints(joints) {
  for (const joint of joints) {
    if (joint.broken || joint.a?.gone || joint.b?.gone) continue;
    const { a, b } = joint;
    if (a?.asleep && ((b && !b.asleep && !b.fixed) || (b && b.fixed && moving(b)))) { a.asleep = false; a.sleepy = 0; }
    if (b?.asleep && ((a && !a.asleep && !a.fixed) || (a && a.fixed && moving(a)))) { b.asleep = false; b.sleepy = 0; }
  }
}

const invMass = body => body && !solid(body) ? body.invMass : 0;
const invInertia = body => body && !solid(body) ? body.invInertia : 0;

function apply(body, rx, ry, ix, iy) {
  if (!body || solid(body)) return;
  body.vx += ix * body.invMass;
  body.vy += iy * body.invMass;
  body.w += (rx * iy - ry * ix) * body.invInertia;
}

function applyAngular(body, amount) {
  if (!body || solid(body)) return;
  body.w += amount * body.invInertia;
}

// Clears the impulses a joint has carried, at the start of each substep.
export function resetJoints(joints) {
  for (const joint of joints) { joint.accN = 0; joint.accA = 0; }
}

// Solves every joint's velocity constraint once; call it each iteration, interleaved with contact solving.
export function solveJoints(joints, dt, iterations) {
  for (let k = 0; k < iterations; k++) for (const joint of joints) {
    if (joint.broken || joint.a?.gone || joint.b?.gone) continue;
    const { a, b, type } = joint;
    if (solid(a) && solid(b)) continue;
    const [ax, ay, bx, by] = anchors(joint);
    let dx = bx - ax, dy = by - ay, distance = Math.sqrt(dx * dx + dy * dy);
    let nx = distance > 1e-9 ? dx / distance : 0, ny = distance > 1e-9 ? dy / distance : 1;
    let error = 0;
    if (type === 'rope') error = Math.max(0, distance - joint.max);
    else if (type === 'hinge' || type === 'weld') error = distance;
    else error = distance - joint.length;
    const rax = ax - (a ? a.x : ax), ray = ay - (a ? a.y : ay);
    const rbx = bx - (b ? b.x : bx), rby = by - (b ? b.y : by);
    const ma = invMass(a), mb = invMass(b), ia = invInertia(a), ib = invInertia(b);
    if ((ma || mb) && (type !== 'rope' || error > 0)) {
      const ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx;
      const kk = ma + mb + ia * ran * ran + ib * rbn * rbn;
      if (kk > 1e-12) {
        const vax = a ? a.vx - a.w * ray : 0, vay = a ? a.vy + a.w * rax : 0;
        const vbx = b ? b.vx - b.w * rby : 0, vby = b ? b.vy + b.w * rbx : 0;
        const vn = (vbx - vax) * nx + (vby - vay) * ny;
        const bias = BETA * error / dt;
        let lambda = (-vn * (1 + joint.damping * 4) - joint.stiffness * bias) / kk;
        if (type === 'rope') {
          const next = Math.min(0, joint.accN + lambda);
          lambda = next - joint.accN;
          joint.accN = next;
        } else {
          const next = Math.max(-MAX_IMPULSE, Math.min(MAX_IMPULSE, joint.accN + lambda));
          lambda = next - joint.accN;
          joint.accN = next;
        }
        if (lambda) {
          apply(a, rax, ray, -lambda * nx, -lambda * ny);
          apply(b, rbx, rby, lambda * nx, lambda * ny);
        }
      }
    }
    if ((type === 'hinge' && joint.limit) || type === 'weld') {
      const angleA = a ? atan2Deg(a.s, a.c) : 0, angleB = b ? atan2Deg(b.s, b.c) : 0;
      const relative = normalize(angleB - angleA - joint.baseAngle);
      let target = null;
      if (type === 'weld') target = 0;
      else if (relative < joint.limit[0]) target = joint.limit[0];
      else if (relative > joint.limit[1]) target = joint.limit[1];
      if (target !== null) {
        const kk = invInertia(a) + invInertia(b);
        if (kk > 1e-12) {
          const wRel = (b ? b.w : 0) - (a ? a.w : 0);
          const bias = BETA * (target - relative) * DEG / dt;
          const lambda = (-wRel - bias) / kk;
          const next = Math.max(-MAX_IMPULSE, Math.min(MAX_IMPULSE, joint.accA + lambda));
          const delta = next - joint.accA;
          joint.accA = next;
          applyAngular(a, -delta);
          applyAngular(b, delta);
        }
      }
    }
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const turn = (body, degrees) => {
  if (!body || solid(body) || !degrees) return;
  const angle = atan2Deg(body.s, body.c) + degrees;
  body.c = cosDeg(angle); body.s = sinDeg(angle);
};

// Corrects the positions a velocity solve leaves behind, so a hanging chain does not stretch over time.
export function correctJoints(joints) {
  for (const joint of joints) {
    if (joint.broken || joint.a?.gone || joint.b?.gone) continue;
    const { a, b, type } = joint;
    if (solid(a) && solid(b)) continue;
    const [ax, ay, bx, by] = anchors(joint);
    const dx = bx - ax, dy = by - ay, distance = Math.sqrt(dx * dx + dy * dy);
    const nx = distance > 1e-9 ? dx / distance : 0, ny = distance > 1e-9 ? dy / distance : 1;
    let error = 0;
    if (type === 'rope') error = Math.max(0, distance - joint.max);
    else if (type === 'hinge' || type === 'weld') error = distance;
    else error = distance - joint.length;
    if (error > 0) {
      const correction = clamp(error * 0.5, 0, MAX_CORRECTION);
      const ma = invMass(a), mb = invMass(b), total = ma + mb;
      if (total > 0) {
        const moveA = correction * ma / total, moveB = correction * mb / total;
        if (a && !solid(a)) { a.x += nx * moveA; a.y += ny * moveA; }
        if (b && !solid(b)) { b.x -= nx * moveB; b.y -= ny * moveB; }
      }
    } else if (error < 0 && type !== 'rope') {
      const correction = clamp(-error * 0.5, 0, MAX_CORRECTION);
      const ma = invMass(a), mb = invMass(b), total = ma + mb;
      if (total > 0) {
        const moveA = correction * ma / total, moveB = correction * mb / total;
        if (a && !solid(a)) { a.x -= nx * moveA; a.y -= ny * moveA; }
        if (b && !solid(b)) { b.x += nx * moveB; b.y += ny * moveB; }
      }
    }
    if ((type === 'hinge' && joint.limit) || type === 'weld') {
      const angleA = a ? atan2Deg(a.s, a.c) : 0, angleB = b ? atan2Deg(b.s, b.c) : 0;
      const relative = normalize(angleB - angleA - joint.baseAngle);
      let target = null;
      if (type === 'weld') target = 0;
      else if (relative < joint.limit[0]) target = joint.limit[0];
      else if (relative > joint.limit[1]) target = joint.limit[1];
      if (target !== null) {
        const correction = clamp((target - relative) * 0.5, -5, 5);
        const ia = invInertia(a), ib = invInertia(b), total = ia + ib;
        if (total > 0) {
          turn(a, -correction * ia / total);
          turn(b, correction * ib / total);
        }
      }
    }
  }
}

// Marks joints that carried more than their `break` impulse this substep, and reports them.
export function breakJoints(joints, frame, stats) {
  for (const joint of joints) {
    if (joint.broken || joint.break === null || joint.a?.gone || joint.b?.gone) continue;
    const impulse = Math.max(Math.abs(joint.accN), Math.abs(joint.accA));
    if (impulse < joint.break) continue;
    joint.broken = true;
    stats.push({ joint: joint.name ?? joint.path, frame, impulse: Math.round(impulse * 100) / 100 });
  }
}

// Draws ropes: a line along each intact link joint, or a chain of links.
export function paintRopes(ropes, put, n = 1) {
  const disc = (x, y, code, r) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r + r) put(x + i, y + j, code); };
  const worldDot = (x, y, code, r) => disc(Math.floor(x * n), Math.floor(y * n), code, r);
  const line = (ax, ay, bx, by, code, thickness) => {
    const radius = Math.max(0, Math.floor((thickness * n - 1) / 2));
    traceLine(Math.floor(ax * n), Math.floor(ay * n), Math.floor(bx * n), Math.floor(by * n), (x, y) => disc(x, y, code, radius));
  };
  for (const rope of ropes) {
    const code = rope.fill.charCodeAt(0), outline = rope.outline?.charCodeAt(0);
    for (const joint of rope.joints) {
      if (joint.broken || joint.a?.gone || joint.b?.gone) continue;
      const [ax, ay, bx, by] = anchors(joint);
      if (rope.look === 'chain') {
        worldDot(ax, ay, code, Math.max(0, Math.floor((rope.thickness * n - 1) / 2)));
        worldDot(bx, by, code, Math.max(0, Math.floor((rope.thickness * n - 1) / 2)));
      } else {
        if (outline !== undefined) line(ax, ay, bx, by, outline, rope.thickness + 2);
        line(ax, ay, bx, by, code, rope.thickness);
      }
    }
    if (rope.look === 'chain') for (const link of rope.links) if (!link.gone) worldDot(link.x, link.y, code, Math.max(0, Math.floor((rope.thickness * n - 1) / 2)));
  }
}
