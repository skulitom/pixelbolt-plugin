// Model-space sockets, flat faces and lofts between named contours for sprite stacks. Rasterize at pixel centres with a
// half-open edge rule, then depth-sort glass and solid hits together with the voxel traversal.
import { fail, isObject, portableName } from './core.js';
import { fields, number, integer, boolean } from './authoring.js';
import { cosDeg, sinDeg, ease, EASINGS } from './craft.js';

export function triple(value, path) {
  if (!Array.isArray(value) || value.length !== 3) fail(path, 'expected [x,y,z]');
  return value.map((n, i) => number(n, path + '[' + i + ']', -512, 512));
}

export function stackGeometry(source) {
  const sockets = new Map(),
    definitions = source.sockets ?? {};
  if (!isObject(definitions) || Object.keys(definitions).length > 64) fail('stack.sockets', 'expected at most 64 named attachments');
  for (const [name, socket] of Object.entries(definitions)) {
    const path = 'stack.sockets.' + name;
    portableName(name, path);
    fields(socket, ['at', 'axis', 'keys'], path);
    const axis = socket.axis ?? 'z';
    if (!['x', 'y', 'z'].includes(axis)) fail(path + '.axis', 'expected x, y or z');
    sockets.set(name, { at: triple(socket.at, path + '.at'), axis, keys: socketKeys(socket.keys ?? [], path + '.keys', 'heading', 360) });
  }
  const faces = source.facets ?? [];
  if (!Array.isArray(faces) || faces.length > 2048) fail('stack.facets', 'expected up to 2,048 faces');
  const readSocket = (name, path) => {
    if (name !== undefined && !sockets.has(name)) fail(path, 'unknown socket');
    return name;
  };
  const facets = faces.map((face, i) => {
    const path = 'stack.facets[' + i + ']';
    fields(face, ['points', 'color', 'socket', 'twoSided'], path);
    const socket = readSocket(face.socket, path + '.socket');
    if (!Array.isArray(face.points) || face.points.length < 3 || face.points.length > 16)
      fail(path + '.points', 'expected 3–16 vertices in boundary order');
    if (typeof face.color !== 'string' || !Object.hasOwn(source.palette, face.color)) fail(path + '.color', 'unknown palette key');
    return {
      ink: face.color.charCodeAt(0),
      twoSided: boolean(face.twoSided ?? false, path + '.twoSided'),
      points: face.points.map((point, i) => {
        const p = path + '.points[' + i + ']';
        if (Array.isArray(point)) return { xyz: triple(point, p), socket };
        fields(point, ['at', 'socket'], p);
        return { xyz: triple(point.at, p + '.at'), socket: readSocket(point.socket ?? socket, p + '.socket') };
      })
    };
  });
  appendLofts(source, facets, readSocket);
  return { sockets, facets };
}

// Each band joins corresponding vertices with the same diagonal. Reflection keeps
// that diagonal and reverses winding. Shared seam faces are emitted only once.
function appendLofts(source, facets, readSocket) {
  const definitions = source.contours ?? {};
  if (!isObject(definitions) || Object.keys(definitions).length > 128)
    fail('stack.contours', 'expected up to 128 named contours');
  const contours = new Map();
  for (const [name, points] of Object.entries(definitions)) {
    const path = 'stack.contours.' + name;
    portableName(name, path);
    if (!Array.isArray(points) || points.length < 2 || points.length > 32)
      fail(path, 'expected 2–32 points in matching order');
    contours.set(name, points.map((p, i) => triple(p, path + '[' + i + ']')));
  }
  const lofts = source.lofts ?? [];
  if (!Array.isArray(lofts) || lofts.length > 128) fail('stack.lofts', 'expected up to 128 lofts');
  for (const [index, loft] of lofts.entries()) {
    const path = 'stack.lofts[' + index + ']';
    fields(loft, ['contours', 'bands', 'closed', 'mirror', 'socket', 'twoSided'], path);
    const refs = loft.contours;
    if (!Array.isArray(refs) || refs.length < 2 || refs.length > 32)
      fail(path + '.contours', 'expected 2–32 named contours');
    const closed = boolean(loft.closed ?? false, path + '.closed');
    const rows = refs.map((name, i) => {
      const p = path + '.contours[' + i + ']';
      const row = contours.get(name);
      if (!row) fail(p, 'unknown contour');
      if (i && name === refs[i - 1]) fail(p, 'adjacent contours must differ');
      if (row.length !== contours.get(refs[0]).length) fail(p, 'contours must have matching point counts');
      if (closed && row.length < 3) fail(p, 'a closed contour needs at least three points');
      return row;
    });
    const socket = readSocket(loft.socket, path + '.socket');
    const twoSided = boolean(loft.twoSided ?? false, path + '.twoSided');
    const mirror = ['x', 'y', 'z'].indexOf(loft.mirror);
    if (loft.mirror !== undefined && mirror < 0) fail(path + '.mirror', 'expected x, y or z');
    const spans = rows[0].length - (closed ? 0 : 1);
    if (!Array.isArray(loft.bands) || loft.bands.length !== rows.length - 1)
      fail(path + '.bands', 'give one palette band per pair of contours');
    function emit(vertices, ink) {
      if (facets.length >= 2048) fail(path, 'lofts and facets together exceed 2,048 faces');
      facets.push({ ink, twoSided, points: vertices.map(xyz => ({ xyz, socket })) });
    }
    for (const [r, colors] of loft.bands.entries()) {
      if (typeof colors !== 'string' || (colors.length !== 1 && colors.length !== spans) ||
          [...colors].some(c => !Object.hasOwn(source.palette, c)))
        fail(path + '.bands[' + r + ']', 'give one palette key or one per span (' + spans + ')');
      for (let i = 0; i < spans; i++) {
        const j = (i + 1) % rows[r].length;
        const vertices = [rows[r][i], rows[r][j], rows[r + 1][j], rows[r + 1][i]];
        const ink = colors[colors.length === 1 ? 0 : i].charCodeAt(0);
        emit(vertices, ink);
        if (mirror >= 0 && vertices.some(p => p[mirror] !== 0)) {
          const reversed = [vertices[0], vertices[3], vertices[2], vertices[1]];
          emit(reversed.map(p => p.map((v, axis) => axis === mirror ? -v : v)), ink);
        }
      }
    }
  }
}

// A socket's keys: each at a heading in degrees, or at a frame of an animation, in increasing order. A key of an
// animation may say how the move to it from the key before is eased (craft's easings; linear when left out).
export function socketKeys(keys, path, by, last) {
  if (!Array.isArray(keys) || keys.length > 64) fail(path, 'expected up to 64 keys');
  let before = -1;
  return keys.map((key, i) => {
    const p = path + '[' + i + ']';
    fields(key, by === 'frame' ? ['frame', 'offset', 'angle', 'ease'] : ['heading', 'offset', 'angle'], p);
    before = integer(key[by], p + '.' + by, before + 1, last);
    if (key.ease !== undefined && !EASINGS.includes(key.ease)) fail(p + '.ease', 'expected ' + EASINGS.join(', '));
    return {
      when: before,
      offset: triple(key.offset ?? [0, 0, 0], p + '.offset'),
      angle: number(key.angle ?? 0, p + '.angle', -3600, 3600),
      ...(key.ease !== undefined && key.ease !== 'linear' && { ease: key.ease })
    };
  });
}

// Where a moment falls among keys in increasing order: the keys either side of it and how far it is from the first
// to the second, eased as the second asks. The first and last keys hold outside the keyed range.
export function between(keys, when) {
  const next = keys.findIndex(k => k.when >= when);
  const end = next < 0 ? keys.length - 1 : next;
  const start = next < 0 ? end : Math.max(0, end - 1);
  const a = keys[start],
    b = keys[end];
  const t = start === end ? 0 : (when - a.when) / (b.when - a.when);
  return [a, b, b.ease ? ease(b.ease, t) : t];
}

// Every socket's place and turn at a heading. In a frame of an animation (`timed`: its sockets' keys and the frame),
// a socket the animation keys follows those keys instead of its own keys by heading.
export function socketPose(sockets, heading, timed = null) {
  const posed = new Map();
  for (const [name, { at, axis, keys: turning }] of sockets) {
    const own = timed?.sockets.get(name),
      keys = own ?? turning;
    let origin = at,
      angle = 0;
    if (keys.length) {
      const [a, b, t] = between(keys, own ? timed.frame : heading);
      origin = at.map((v, i) => v + a.offset[i] + (b.offset[i] - a.offset[i]) * t);
      angle = a.angle + (b.angle - a.angle) * t;
    }
    posed.set(name, { origin, axis, angle, c: cosDeg(angle), s: sinDeg(angle) });
  }
  return posed;
}

// A direction or an offset turned about an axis by the angle whose cosine and sine are c and s.
export function spun(axis, c, s, [x, y, z]) {
  if (axis === 'x') return [x, y * c - z * s, y * s + z * c];
  if (axis === 'y') return [x * c + z * s, y, z * c - x * s];
  return [x * c - y * s, x * s + y * c, z];
}

export function placed({ xyz, socket }, pose) {
  if (!socket) return xyz;
  const { origin, axis, c, s } = pose.get(socket);
  return spun(axis, c, s, xyz).map((n, i) => n + origin[i]);
}

export function projectPoint([x, y, z], view, c, s) {
  x -= view.pivot[0] + 0.5;
  y -= view.pivot[1] + 0.5;
  return [view.anchor[0] + (x * c - y * s) * view.resolution, view.anchor[1] + ((x * s + y * c) * view.squash - z) * view.resolution, z];
}

// The ground axes on screen at a camera angle, as the [c, s] a projection takes. A view on a map's grid (`grid`, from
// a stack's `cell`) scales them by the square root of two, so a cell steps `resolution` pixels across and half that
// down; at the four headings of the grid they are whole numbers, and every cell corner lands on the pixel lattice.
export function groundAxes(view, angle) {
  if (!view.grid) return [cosDeg(angle), sinDeg(angle)];
  if (angle % 90 === 45) return [angle === 45 || angle === 315 ? 1 : -1, angle < 180 ? 1 : -1];
  return [cosDeg(angle) * Math.SQRT2, sinDeg(angle) * Math.SQRT2];
}

export function projectFacets(geometry, pose, view, angle) {
  const [c, s] = groundAxes(view, angle);
  return geometry.facets.map(face => ({ ...face, points: face.points.map(p => projectPoint(placed(p, pose), view, c, s)) }));
}

// A vertex turning about a socket traces a circle. Its two screen coordinates each
// trace a sinusoid. Bound both amplitudes once so scrubbing cannot crop a tip or pan the camera.
export function includeRotationBounds(facets, socket, { origin, axis }, view, angle, include) {
  const fixed = 'xyz'.indexOf(axis), a = (fixed + 1) % 3, b = (fixed + 2) % 3;
  const [c, s] = groundAxes(view, angle);
  const horizontal = [c, -s, 0], vertical = [s * view.squash, c * view.squash, -1];
  const radius = v => Math.sqrt(v[a] * v[a] + v[b] * v[b]);
  const dx = view.resolution * radius(horizontal), dy = view.resolution * radius(vertical);
  for (const face of facets) for (const point of face.points) {
    if (point.socket !== socket) continue;
    const center = [...origin];
    center[fixed] += point.xyz[fixed];
    const [x, y] = projectPoint(center, view, c, s), r = radius(point.xyz);
    include(x - r * dx, y - r * dy);
    include(x + r * dx, y + r * dy);
  }
}

// Convert the depth samples at each pixel to ordinary back-to-front recipe grids.
// z is the camera depth along a ray: higher world z is closer. Equal-depth overlays draw last.
export function stackFragments(width, height, alpha) {
  const hits = new Array(width * height);
  let count = 0;
  function add(index, z, ink) {
    if (!alpha[ink]) return;
    if (++count > 2000000) fail('stack.facets', 'over two million surface samples in one frame');
    const list = (hits[index] ??= []);
    if (list.length >= 128) fail('stack.facets', 'over 128 surfaces at one pixel');
    list.push({ z, ink });
  }
  function ops(budget) {
    const layers = [];
    for (let i = 0; i < hits.length; i++) {
      const list = hits[i];
      if (!list) continue;
      list.sort((a, b) => a.z - b.z);
      let base = list.length - 1;
      while (base > 0 && alpha[list[base].ink] !== 255) base--;
      const x = i % width,
        y = Math.floor(i / width);
      for (let j = base; j < list.length; j++) {
        const k = j - base;
        const layer = (layers[k] ??= { points: [], left: width, right: 0, top: height, bottom: 0 });
        layer.left = Math.min(layer.left, x);
        layer.right = Math.max(layer.right, x);
        layer.top = Math.min(layer.top, y);
        layer.bottom = y;
        layer.points.push([x, y, list[j].ink]);
      }
    }
    if (!layers.length) return [{ op: 'grid', rows: Array(height).fill('.'.repeat(width)) }];
    return layers.map((l, i) => {
      if (!i) {
        l.left = 0;
        l.top = 0;
        l.right = width - 1;
        l.bottom = height - 1;
      }
      const area = (l.right - l.left + 1) * (l.bottom - l.top + 1);
      budget.gridCells = (budget.gridCells ?? 0) + area;
      if (budget.gridCells > 16777216) fail('stack.facets', 'layered grids exceed 16 million cells; reduce resolution or heading count');
      const grid = Array.from({ length: l.bottom - l.top + 1 }, () => new Uint16Array(l.right - l.left + 1).fill(46));
      for (const [x, y, ink] of l.points) grid[y - l.top][x - l.left] = ink;
      return { op: 'grid', ...(l.left && { x: l.left }), ...(l.top && { y: l.top }), rows: grid.map(row => String.fromCharCode(...row)) };
    });
  }
  return { add, ops };
}

// Fixed-point pixel centres and the top-left rule assign each shared edge to one triangle.
const edge = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
const inclusive = (a, b) => a[1] > b[1] || (a[1] === b[1] && a[0] < b[0]);
export function drawFacets(faces, view, fragments, budget) {
  for (const face of faces) {
    const points = face.points.map(([x, y, z], i) => [Math.round(x * 256), Math.round(y * 256), z, ...(face.paint?.uv[i] ?? [])]);
    for (let i = 1; i < points.length - 1; i++) {
      let a = points[0],
        b = points[i],
        c = points[i + 1],
        area = edge(a, b, c[0], c[1]);
      if (area < 0 && face.twoSided) {
        [b, c] = [c, b];
        area = -area;
      }
      if (area <= 0) continue;
      const left = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - 128) / 256));
      const right = Math.min(view.width - 1, Math.floor((Math.max(a[0], b[0], c[0]) - 128) / 256));
      const top = Math.max(0, Math.ceil((Math.min(a[1], b[1], c[1]) - 128) / 256));
      const bottom = Math.min(view.height - 1, Math.floor((Math.max(a[1], b[1], c[1]) - 128) / 256));
      if (left > right || top > bottom) continue;
      budget.left -= (right - left + 1) * (bottom - top + 1) * (1 + (face.paint?.marks.length ?? 0));
      if (budget.left < 0) fail('stack.facets', 'stack exceeds the surface sampling budget');
      const ab = inclusive(a, b),
        bc = inclusive(b, c),
        ca = inclusive(c, a);
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++) {
          const px = x * 256 + 128,
            py = y * 256 + 128;
          const u = edge(b, c, px, py),
            v = edge(c, a, px, py),
            w = edge(a, b, px, py);
          if ((u > 0 || (u === 0 && bc)) && (v > 0 || (v === 0 && ca)) && (w > 0 || (w === 0 && ab))) {
            let ink = face.ink;
            // Paint the membrane's own hit. Interpolating in its triangle keeps a
            // thin vein visible on either side without a second, coplanar face.
            if (face.paint) {
              const along=(u*a[3]+v*b[3]+w*c[3])/area, across=(u*a[4]+v*b[4]+w*c[4])/area;
              for (const {a:start,b:end,ink:colour} of face.paint.marks) {
                if (along<start[0] || along>end[0]) continue;
                const t=(along-start[0])/(end[0]-start[0]);
                if (Math.abs(across-start[1]-(end[1]-start[1])*t)<=start[2]+(end[2]-start[2])*t) ink=colour;
              }
            }
            fragments.add(y * view.width + x, (u * a[2] + v * b[2] + w * c[2]) / area, ink);
          }
        }
    }
  }
}
