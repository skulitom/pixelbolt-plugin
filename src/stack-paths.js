// Pose tapered rings in a socket's local space. Ring seams are chosen in the rest
// shape and carried by joint rotations. An attached path inherits its parent's tip
// frame. Membranes and their markings follow the posed ribs. Surface reliefs sample
// the painted voxel hull and keep their model-space lighting as the camera turns.
import { fail, isObject, portableName } from './core.js';
import { fields, integer, number } from './authoring.js';
import { cosDeg, sinDeg, EASINGS } from './craft.js';
import { triple, between } from './stack-facets.js';

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const times = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
const cross = ([x, y, z], [a, b, c]) => [y * c - z * b, z * a - x * c, x * b - y * a];
const mix = (a, b, t) => add(a, times(sub(b, a), t));
const unit = a => times(a, 1 / Math.sqrt(dot(a, a)));
const basis = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];
const apply = (basis, v) => basis[0].map((_, i) => basis[0][i] * v[0] + basis[1][i] * v[1] + basis[2][i] * v[2]);
function bend(parent, axis, degrees) {
  if (!degrees) return parent;
  const c = cosDeg(degrees),
    s = sinDeg(degrees);
  return basis.map(v =>
    apply(parent, add(add(times(v, c), times(cross(axis, v), s)), times(axis, dot(axis, v) * (1 - c))))
  );
}
// A relief sweeps a triangular cross-section along a side of the stack. The rim and
// crest each sample the hull independently, including any depth paint. The two end
// triangles close wide ends. A zero-width, zero-rise station makes a pointed end.
export function appendStackReliefs(source, facets, sides, onSurface) {
  const reliefs = list(source.reliefs ?? [], 'stack.reliefs', 0, 128);
  for (const [index, ridge] of reliefs.entries()) {
    const path = 'stack.reliefs[' + index + ']';
    fields(ridge, ['face', 'points', 'ramp', 'light'], path);
    const face = sides.indexOf(ridge.face);
    if (face < 0) fail(path + '.face', 'expected ' + sides.join(', '));
    const ramp = ridge.ramp;
    if (typeof ramp !== 'string' || ramp.length < 1 || ramp.length > 32 ||
        [...ramp].some(key => !Object.hasOwn(source.palette, key))) fail(path + '.ramp', 'give 1–32 palette keys from dark to light');
    const direction = triple(ridge.light ?? [-1, -2, 3], path + '.light');
    const largest = Math.max(...direction.map(Math.abs));
    if (!largest) fail(path + '.light', 'light direction must be nonzero');
    const light = unit(direction.map(v => v / largest));
    const stations = list(ridge.points, path + '.points', 2, 32).map((station, i) => {
      const p = path + '.points[' + i + ']';
      if (!Array.isArray(station) || station.length !== 4) fail(p, 'expected [across, z, halfWidth, rise]');
      return station.map((v, j) => number(v, p + '[' + j + ']', 0, j < 2 ? 512 : 128));
    });
    const sections = stations.map(([u, z, halfWidth, rise], i) => {
      const p = path + '.points[' + i + ']';
      const prev = stations[Math.max(0, i - 1)], next = stations[Math.min(stations.length - 1, i + 1)];
      const du = next[0] - prev[0], dz = next[1] - prev[1], length = Math.sqrt(du * du + dz * dz);
      if (!length || (i && u === prev[0] && z === prev[1])) fail(p, 'ridge needs a distinct travel direction');
      const across = -dz / length * halfWidth, up = du / length * halfWidth;
      return [onSurface(face, u + across, z + up, 0, p), onSurface(face, u, z, rise, p),
        onSurface(face, u - across, z - up, 0, p)];
    });
    // In the (across, z) plane this winding faces south or west. Flip the
    // opposite sides before computing both visibility and the lighting normal.
    const reverseWinding = ridge.face === 'east' || ridge.face === 'north';
    function triangle(a, b, c) {
      if (reverseWinding) [b, c] = [c, b];
      const normal = cross(sub(b, a), sub(c, a));
      if (dot(normal, normal) === 0) return;
      if (facets.length >= 2048) fail(path, 'reliefs and facets together exceed 2,048 faces');
      const value = (1 + dot(unit(normal), light)) / 2;
      const band = Math.min(ramp.length - 1, Math.max(0, Math.floor(value * ramp.length)));
      facets.push({ ink: ramp.charCodeAt(band), twoSided: false, points: [a, b, c].map(xyz => ({ xyz })) });
    }
    triangle(...sections[0]);
    for (let i = 1; i < sections.length; i++) {
      const a = sections[i - 1], b = sections[i];
      for (let j = 0; j < 2; j++) {
        triangle(a[j], b[j], b[j + 1]);
        triangle(a[j], b[j + 1], a[j + 1]);
      }
    }
    const end = sections.at(-1);
    triangle(end[2], end[1], end[0]);
  }
}

function list(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(path, 'expected ' + min + '–' + max + ' items');
  return value;
}
function names(value, path, limit) {
  if (!isObject(value) || Object.keys(value).length > limit) fail(path, 'expected up to ' + limit + ' named entries');
  for (const key of Object.keys(value)) portableName(key, path + '.' + key);
  return Object.entries(value);
}

// Rest axes for a sweep and its tip attachment. The local z direction follows
// the centreline. Project the last seam onto each new cross-section to keep roll.
export function pathFrames(centres, path = 'path') {
  const directions = centres.slice(1).map((at, i) => {
    const d = sub(at, centres[i]);
    if (dot(d, d) < 1e-12) fail(path + '.nodes[' + (i + 1) + '].at', 'successive centres must differ');
    return unit(d);
  });
  let u;
  return centres.map((_, i) => {
    const incoming = directions[Math.max(0, i - 1)],
      outgoing = directions[Math.min(i, directions.length - 1)];
    const bisector = add(incoming, outgoing),
      tangent = dot(bisector, bisector) < 1e-10 ? incoming : unit(bisector);
    const project = v => sub(v, times(tangent, dot(v, tangent)));
    if (!u || dot(project(u), project(u)) < 1e-10)
      u = basis.reduce((a, b) => (Math.abs(dot(a, tangent)) <= Math.abs(dot(b, tangent)) ? a : b));
    u = unit(project(u));
    return [u, cross(tangent, u), tangent];
  });
}

export function stackPaths(source, sockets, fixedCount) {
  if (['paths', 'membranes', 'poses', 'poseKeys'].every(k => source[k] === undefined)) return null;
  const paths = new Map(),
    poses = new Map(),
    order = [];
  function colors(value, path) {
    if (
      typeof value !== 'string' ||
      !value.length ||
      value.length > 16 ||
      [...value].some(c => !Object.hasOwn(source.palette, c))
    )
      fail(path, 'expected 1–16 palette keys');
    return value;
  }
  for (const [name, def] of names(source.paths ?? {}, 'stack.paths', 64)) {
    const p = 'stack.paths.' + name;
    fields(def, ['nodes', 'colors', 'sides', 'roll', 'socket', 'attach'], p);
    if (def.socket !== undefined && !sockets.has(def.socket)) fail(p + '.socket', 'unknown socket');
    if (def.attach !== undefined && def.socket !== undefined) fail(p, 'an attached path inherits its socket');
    if (def.attach !== undefined) portableName(def.attach, p + '.attach');
    const sides = integer(def.sides ?? 6, p + '.sides', 3, 16),
      roll = number(def.roll ?? 0, p + '.roll', -360, 360);
    const joints = new Set();
    const nodes = list(def.nodes, p + '.nodes', 2, 32).map((n, i) => {
      const q = p + '.nodes[' + i + ']';
      fields(n, ['name', 'at', 'radius', 'axis'], q);
      portableName(n.name, q + '.name');
      if (joints.has(n.name)) fail(q + '.name', 'duplicate joint');
      joints.add(n.name);
      const axis = triple(n.axis ?? [1, 0, 0], q + '.axis');
      if (dot(axis, axis) < 1e-12) fail(q + '.axis', 'expected a nonzero hinge axis');
      return {
        name: n.name,
        at: triple(n.at, q + '.at'),
        radius: number(n.radius, q + '.radius', 0, 128),
        axis: unit(axis)
      };
    });
    const frames = pathFrames(
      nodes.map(n => n.at),
      p
    );
    nodes.forEach((node, i) => {
      const [u, v] = frames[i];
      node.ring = Array.from({ length: sides }, (_, k) => {
        const angle = roll + (360 * k) / sides;
        return times(add(times(u, cosDeg(angle)), times(v, sinDeg(angle))), node.radius);
      });
    });
    paths.set(name, {
      name,
      nodes,
      joints,
      tipFrame: frames.at(-1),
      socket: def.socket,
      attach: def.attach,
      colors: colors(def.colors, p + '.colors'),
      sides
    });
  }
  const visiting = new Set(),
    done = new Set();
  function visit(path) {
    if (done.has(path)) return;
    if (visiting.has(path)) fail('stack.paths.' + path.name + '.attach', 'path attachment cycle');
    visiting.add(path);
    if (path.attach !== undefined) {
      const parent = paths.get(path.attach);
      if (!parent) fail('stack.paths.' + path.name + '.attach', 'unknown parent path');
      visit(parent);
      path.socket = parent.socket;
    }
    visiting.delete(path);
    done.add(path);
    order.push(path);
  }
  for (const path of paths.values()) visit(path);
  for (const [name, def] of names(source.poses ?? {}, 'stack.poses', 64)) {
    const angles = new Map();
    for (const [ref, joints] of names(def, 'stack.poses.' + name, 64)) {
      const path = paths.get(ref),
        p = 'stack.poses.' + name + '.' + ref;
      if (!path) fail(p, 'unknown path');
      for (const [joint, v] of names(joints, p, 32)) {
        if (!path.joints.has(joint)) fail(p + '.' + joint, 'unknown joint');
        angles.set(ref + '.' + joint, number(v, p + '.' + joint, -360, 360));
      }
    }
    poses.set(name, angles);
  }
  // Named poses at headings in degrees, or at frames of an animation (which may ease the move to a key).
  function poseKeys(value, path, by, end) {
    let last = -1;
    return list(value, path, 0, 64).map((key, i) => {
      const p = path + '[' + i + ']';
      fields(key, by === 'frame' ? ['frame', 'pose', 'ease'] : ['heading', 'pose'], p);
      last = integer(key[by], p + '.' + by, last + 1, end);
      if (!poses.has(key.pose)) fail(p + '.pose', 'unknown pose');
      if (key.ease !== undefined && !EASINGS.includes(key.ease)) fail(p + '.ease', 'expected ' + EASINGS.join(', '));
      return { when: last, angles: poses.get(key.pose), ...(key.ease !== undefined && key.ease !== 'linear' && { ease: key.ease }) };
    });
  }
  const turning = poseKeys(source.poseKeys ?? [], 'stack.poseKeys', 'heading', 360);
  // The joint angles at a heading, or at a frame of an animation that keys poses (`timed`: its keys and the frame).
  function anglesAt(heading, timed = null) {
    const keys = timed?.poses ?? turning;
    if (!keys.length) return new Map();
    const [a, b, t] = between(keys, timed?.poses ? timed.frame : heading);
    if (a === b) return a.angles;
    const values = new Map();
    for (const key of new Set([...a.angles.keys(), ...b.angles.keys()])) {
      const start = a.angles.get(key) ?? 0;
      values.set(key, start + ((b.angles.get(key) ?? 0) - start) * t);
    }
    return values;
  }

  const membranes = list(source.membranes ?? [], 'stack.membranes', 0, 64).map((m, i) => {
    const p = 'stack.membranes[' + i + ']';
    fields(m, ['ribs', 'colors', 'sag', 'scallop', 'veins'], p);
    const [a, b] = list(m.ribs, p + '.ribs', 2, 2).map(n => paths.get(n));
    if (!a || !b || a === b || a.socket !== b.socket || a.nodes.length !== b.nodes.length)
      fail(p + '.ribs', 'choose two different paths on the same socket with matching node counts');
    const bands = colors(m.colors, p + '.colors');
    const veins = list(m.veins ?? [], p + '.veins', 0, 8).map((vein, j) => {
      const q = p + '.veins[' + j + ']';
      fields(vein, ['color', 'points'], q);
      if (typeof vein.color !== 'string' || vein.color.length !== 1 || !Object.hasOwn(source.palette, vein.color))
        fail(q + '.color', 'unknown palette key');
      const points = list(vein.points, q + '.points', 2, 16).map((v, k) => {
        const [along, across, half] = list(v, q + '.points[' + k + ']', 3, 3);
        number(along, q + '.along', 0, 1);
        number(across, q + '.across', 0, 1);
        number(half, q + '.halfWidth', 0, Math.min(across, 1 - across));
        return [along, across, half];
      });
      return points.slice(1).map((b, i) => {
        const a = points[i];
        if (a[0] >= b[0]) fail(q + '.points', 'vein points must progress along the rib');
        return {
          a,
          b,
          ink: vein.color.charCodeAt(0),
          min: Math.min(a[1] - a[2], b[1] - b[2]),
          max: Math.max(a[1] + a[2], b[1] + b[2])
        };
      });
    });
    // Even a single ink needs interior vertices for sag and the scalloped edge.
    // Surface coordinates and the vein segments crossing a cell are independent of pose.
    const strips = Math.max(4, bands.length),
      rows = a.nodes.length - 1,
      segments = veins.flat();
    const panels = Array.from({ length: rows }, (_, i) =>
      Array.from({ length: strips }, (_, j) => {
        const u = i / rows,
          v = j / strips,
          du = 1 / rows,
          dv = 1 / strips;
        const marks = segments.filter(({ a, b, min, max }) => a[0] <= u + du && b[0] >= u && min <= v + dv && max >= v);
        const color = bands[Math.floor((j * bands.length) / strips)];
        return {
          color,
          paint: marks.length
            ? {
                uv: [
                  [u, v],
                  [u, v + dv],
                  [u + du, v + dv],
                  [u + du, v]
                ],
                marks
              }
            : undefined
        };
      })
    );
    return {
      a,
      b,
      strips,
      panels,
      sag: number(m.sag ?? 0, p + '.sag', -64, 64),
      scallop: number(m.scallop ?? 0, p + '.scallop', -64, 64)
    };
  });
  const faces =
    order.reduce((n, p) => n + 2 + (p.nodes.length - 1) * p.sides, fixedCount) +
    membranes.reduce((n, m) => n + (m.a.nodes.length - 1) * m.strips, 0);
  if (faces > 2048) fail('stack.paths', 'paths, membranes and facets together exceed 2,048 faces');

  function mesh(angles) {
    const posed = new Map(),
      facets = [];
    function face(xyz, color, socket, twoSided = false) {
      facets.push({ ink: color.charCodeAt(0), twoSided, points: xyz.map(p => ({ xyz: p, socket })) });
    }
    for (const path of order) {
      const parent = posed.get(path.attach);
      let axes = parent?.tipAxes ?? basis,
        centre = parent?.centres.at(-1) ?? [0, 0, 0],
        previous = [0, 0, 0];
      const centres = [],
        rings = [];
      for (const node of path.nodes) {
        centre = add(centre, apply(axes, sub(node.at, previous)));
        const angle = angles.get(path.name + '.' + node.name) ?? 0;
        const ringAxes = bend(axes, node.axis, angle / 2);
        rings.push(node.ring.map(offset => add(centre, apply(ringAxes, offset))));
        centres.push(centre);
        previous = node.at;
        axes = bend(axes, node.axis, angle);
      }
      posed.set(path.name, { centres, tipAxes: path.tipFrame.map(v => apply(axes, v)), socket: path.socket });
      face([...rings[0]].reverse(), path.colors[0], path.socket);
      for (let i = 1; i < rings.length; i++)
        for (let side = 0; side < path.sides; side++) {
          const next = (side + 1) % path.sides;
          face(
            [rings[i - 1][side], rings[i - 1][next], rings[i][next], rings[i][side]],
            path.colors[side % path.colors.length],
            path.socket
          );
        }
      face(rings.at(-1), path.colors[0], path.socket);
    }
    for (const m of membranes) {
      const left = posed.get(m.a.name).centres,
        right = posed.get(m.b.name).centres;
      const rows = left.length - 1,
        bands = m.strips;
      function vertex(i, j) {
        if (j === 0) return left[i];
        if (j === bands) return right[i];
        const t = j / bands,
          along = i / rows,
          bow = 4 * t * (1 - t);
        const point = mix(left[i], right[i], t);
        point[1] += m.sag * bow * along * (2 - along);
        point[2] += m.scallop * bow * along * along;
        return point;
      }
      const grid = left.map((_, i) => Array.from({ length: bands + 1 }, (_, j) => vertex(i, j)));
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < bands; j++) {
          const panel = m.panels[i][j];
          face([grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]], panel.color, m.a.socket, true);
          if (panel.paint) facets.at(-1).paint = panel.paint;
        }
    }
    return { posed, facets };
  }
  return { paths, poses, poseKeys, anglesAt, mesh };
}
