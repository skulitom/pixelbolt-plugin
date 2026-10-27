// Deterministic pose geometry. Every endpoint comes from the same snapped whole-degree rule as the rasterizer.
import { boneEnd } from './craft.js';

export const turn = angle => ((angle % 360) + 360) % 360;
export const angleDelta = (from, to) => ((to - from + 540) % 360 + 360) % 360 - 180;

// Length is bounded to 1–64; these tables contain at most 256 small entries (length × snap × flip).
// Grouping degrees that draw the same joint avoids searching an identical pixel pair repeatedly.
const endpoints = new Map();
function choices(bone, flip, rest) {
  const key = `${bone.length}/${bone.snap !== false}/${flip}`;
  if (!endpoints.has(key)) {
    const points = new Map();
    for (let angle = 0; angle < 360; angle++) {
      const [x, y] = boneEnd(bone.length, angle, bone.snap !== false, flip), id = `${x},${y}`;
      if (!points.has(id)) points.set(id, { x, y, angles: [] });
      points.get(id).angles.push(angle);
    }
    endpoints.set(key, [...points.values()]);
  }
  return endpoints.get(key).map(point => {
    let angle = 0, change = Infinity;
    for (const candidate of point.angles) {
      const distance = Math.abs(angleDelta(rest, candidate));
      if (distance < change || (distance === change && candidate < angle)) { change = distance; angle = candidate; }
    }
    return { x: point.x, y: point.y, angle, change };
  });
}

// Target is relative to the first start joint, not the canvas or pose origin.
// Pixel error wins, then bend direction, rest-angle change, and finally ascending world angles.
export function solveReach(first, second, target, { rest = [0, 0], flip = [false, false], bend = 'forward' } = {}) {
  const a = choices(first, flip[0], rest[0]), b = choices(second, flip[1], rest[1]);
  const [tx, ty] = target, reach = first.length + second.length, distance2 = tx * tx + ty * ty;
  const outside = distance2 > reach * reach, minimum = Math.abs(first.length - second.length);
  let straightened = false;
  let best = null, error = Infinity, wrongBend = Infinity, change = Infinity;
  const consider = (p, q) => {
    const dx = p.x + q.x - tx, dy = p.y + q.y - ty, miss = dx * dx + dy * dy;
    const cross = p.x * q.y - p.y * q.x, wrong = bend === 'back' ? Number(cross > 0) : Number(cross < 0);
    const movement = p.change + q.change;
    if (miss < error || (miss === error && (wrong < wrongBend || (wrong === wrongBend && (movement < change
      || (movement === change && (p.angle < best[0].angle || (p.angle === best[0].angle && q.angle < best[1].angle)))))))) {
      best = [p, q]; error = miss; wrongBend = wrong; change = movement;
    }
  };
  // Rounding can put a valid end beyond the analytic radius, especially with one-pixel bones.
  // Search that small fringe before declaring a miss. Further targets cannot land on a rounded endpoint.
  if (distance2 <= (reach + 2) * (reach + 2)) for (const p of a) for (const q of b) consider(p, q);
  const unreachable = error > 0 && (outside || distance2 < minimum * minimum);
  if (unreachable && outside) {
    // Straighten rather than choosing a bent chain merely because its rounded pixels are slightly longer.
    best = null; error = wrongBend = change = Infinity; straightened = true;
    for (let angle = 0; angle < 360; angle++) {
      const secondAngle = turn(angle + (flip[0] !== flip[1] ? 180 : 0));
      const [x, y] = boneEnd(first.length, angle, first.snap !== false, flip[0]);
      const [qx, qy] = boneEnd(second.length, secondAngle, second.snap !== false, flip[1]);
      consider({ x, y, angle, change: Math.abs(angleDelta(rest[0], angle)) },
        { x: qx, y: qy, angle: secondAngle, change: Math.abs(angleDelta(rest[1], secondAngle)) });
    }
  }
  return { angles: best.map(p => p.angle), error: Math.sqrt(error), unreachable, straightened };
}
