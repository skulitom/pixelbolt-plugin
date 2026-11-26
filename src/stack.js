// Orthographic sprite stacks. Each nonblank cell occupies one solid unit cube. Trace one ray
// per output pixel. Composite glass and attached facets in depth order on one shared ground
// pivot and canvas. A rotation study holds one camera and pose outside the baked frame cache.
// Opaque voxel-only sources retain their original single-grid fast path. With `ramps`, each voxel face takes a tone
// from one light: a key moves along its ramp by the way the surface faces, never to a colour outside the palette.
// With `cell`, an iso stack lies on a tile map's grid: at the four quarter headings every cell corner is on a whole
// pixel, so a cube is the box operation's block and stacks on neighbouring cells meet without a gap or an overlap.
// A part is a grid of its own that rides a socket, moved and turned about that socket's axis: each pixel's ray is taken
// into the part's space and walked there, and the height of a hit is its depth, so parts, the stack and facets cover
// one another pixel by pixel. An animation keys sockets and poses by frame and is baked for every heading it is given:
// its frames follow the headings', which keep their indices, so a stack without animations compiles as it always has.
import { fail, frameFits, frameTotalProblem, isObject, pictureSheet, parseColor, portableName, readRows, renderProject, FRAME_AREA } from './core.js';
import { boolean, fields, integer, number, point } from './authoring.js';
import { cosDeg, sinDeg } from './craft.js';
import { stackGeometry, triple, placed, spun, socketKeys, projectPoint, projectFacets, groundAxes, socketPose, includeRotationBounds, stackFragments, drawFacets } from './stack-facets.js';

import { appendStackReliefs, stackPaths } from './stack-paths.js';

const faces = ['west', 'east', 'north', 'south'];
const blank = key => key === '.' || key === ' ';
const sourceFields = ['format', 'version', 'name', 'palette', 'slices', 'pivot', 'projection', 'squash', 'spacing', 'resolution', 'cell', 'headings', 'duration', 'decals', 'paint', 'facets', 'sockets', 'paths', 'membranes', 'poses', 'poseKeys', 'contours', 'lofts', 'reliefs', 'ramps', 'light', 'lightTurns', 'parts', 'animations', 'directions'];

// A side drawing reads across x (north/south) or y (west/east); its first row is the roof.
// Find the outermost solid cell on that line, including through an opening in the silhouette.
function surface(model, face, u, row) {
  const { width, height, levels, cells } = model;
  const acrossY = face < 2, depth = acrossY ? width : height;
  const step = (face % 2 ? -1 : 1) * (acrossY ? 1 : width);
  const start = (levels - 1 - row) * width * height + (acrossY ? u * width : u)
    + (face % 2 ? (depth - 1) * -step : 0);
  for (let i = 0, at = start; i < depth; i++, at += step) {
    if (cells[at]) return { at, step, remaining: depth - i };
  }
  return null;
}

// The tone of each face under the light, as one table per step along the ramps. A face square to the light is a step
// lighter, one turned from it a step darker, and the rest keep the key as drawn. The light stays with the camera, so
// things at different headings in one scene are lit from one side; `lightTurns` fixes it to the model instead.
// A face that goes on into a neighbour along both lines of its own plane is flat and faces where its cube does, so a
// box keeps its edges. One that ends both ways along a line is a step of a slope or a curve, where cube faces would
// stripe the surface: there it leans as the solid round it does (the way out of the 5×5×5 cells about it), and along a
// line where it goes on it does not lean at all, so a wall is upright to its top and a roof is one slope from end to
// end. The solid stands on ground, so its lowest slice goes on below it: the foot of a slope is a low wall, not an
// underside. The lean is fixed in the model and kept for every heading. A part hangs from its socket and may show its
// underside, so it has that sixth face and nothing goes on below it.
const normals = [[0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1]];
const planes = [[[1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]], [[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0]]];
function surfaceNormals({ width: w, height: h, levels, cells }, grounded) {
  const known = new Map();
  const solid = (x, y, z) => x >= 0 && x < w && y >= 0 && y < h && z < levels && (grounded || z >= 0) && cells[(Math.max(z, 0) * h + y) * w + x] !== 0;
  return (index, side) => {
    const key = index * 8 + side;
    if (known.has(key)) return known.get(key);
    const x = index % w, y = Math.floor(index / w) % h, z = Math.floor(index / (w * h)), [fx, fy, fz] = normals[side];
    const open = (dx, dy, dz) => solid(x + dx, y + dy, z + dz) && !solid(x + dx + fx, y + dy + fy, z + dz + fz);
    let normal = null;
    const ends = open(0, 0, 0) ? planes[side].filter(([ax, ay, az]) => !open(ax, ay, az) && !open(-ax, -ay, -az)) : [];
    if (ends.length) {
      const g = [0, 0, 0];
      for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (solid(x + dx, y + dy, z + dz)) { g[0] -= dx; g[1] -= dy; g[2] -= dz; }
      }
      const lean = planes[side].map(axis => ends.includes(axis) ? axis[0] * g[0] + axis[1] * g[1] + axis[2] * g[2] : 0);
      const out = fx * g[0] + fy * g[1] + fz * g[2], length = Math.sqrt(out * out + lean[0] * lean[0] + lean[1] * lean[1]);
      // A sliver the solid round it gives no way out of, or one that points back through its own face, keeps the cube's.
      if (out > 0) normal = [0, 1, 2].map(i => (normals[side][i] * out + planes[side][0][i] * lean[0] + planes[side][1][i] * lean[1]) / length);
    }
    known.set(key, normal);
    return normal;
  };
}

function readTones(source, alpha) {
  if (source.ramps === undefined) {
    for (const key of ['light', 'lightTurns']) if (source[key] !== undefined) fail(`stack.${key}`, 'a light shades faces along ramps; declare ramps, each a string of palette keys from dark to light');
    return null;
  }
  const ramps = source.ramps, place = new Map();
  if (!Array.isArray(ramps) || !ramps.length || ramps.length > 64) fail('stack.ramps', 'expected 1–64 ramps, each a string of palette keys from dark to light');
  let size = 0;
  ramps.forEach((ramp, r) => {
    const path = `stack.ramps[${r}]`;
    if (typeof ramp !== 'string' || ramp.length < 2 || ramp.length > 32) fail(path, 'a ramp is a string of 2–32 palette keys from dark to light');
    for (let i = 0; i < ramp.length; i++) {
      const code = ramp.charCodeAt(i);
      if (!Object.hasOwn(source.palette, ramp[i])) fail(path, `${JSON.stringify(ramp[i])} is not a key of the palette`);
      if (place.has(code)) fail(path, `${JSON.stringify(ramp[i])} is already in a ramp; a key belongs to one ramp`);
      if ((alpha[code] === 255) !== (alpha[ramp.charCodeAt(0)] === 255)) fail(path, 'a ramp is all solid colours or all see-through ones');
      place.set(code, [ramp, i]);
      size = Math.max(size, code + 1);
    }
  });
  for (const key of Object.keys(source.palette)) size = Math.max(size, key.charCodeAt(0) + 1);
  const [x, y, z] = triple(source.light ?? [-1, 1, 2], 'stack.light'), length = Math.sqrt(x * x + y * y + z * z);
  if (!length) fail('stack.light', 'light direction must be nonzero');
  const turns = boolean(source.lightTurns ?? false, 'stack.lightTurns'), tables = new Map();
  // How many keys along its ramp a face moves, by how far it leans to the light, and the table that moves them.
  const stepsOf = facing => Math.round((facing / length - .5) * 2);
  const tone = facing => moved(stepsOf(facing));
  function moved(steps) {
    if (!steps) return null;
    if (!tables.has(steps)) {
      const table = Uint16Array.from({ length: size }, (_, code) => code);
      for (const [code, [ramp, i]] of place) table[code] = ramp.charCodeAt(Math.max(0, Math.min(ramp.length - 1, i + steps)));
      tables.set(steps, table);
    }
    return tables.get(steps);
  }
  return (model, grounded = true) => {
    const round = surfaceNormals(model, grounded);
    // `turn` takes a direction in a part's own space to the stack's, as its socket has turned it.
    return Object.assign(shader, { fixed: ([nx, ny, nz], most) => moved(Math.max(-most, Math.min(most, stepsOf(nx * x + ny * y + nz * z)))) });
    function shader(angle, turn = null) {
      const c = turns ? 1 : cosDeg(angle), s = turns ? 0 : sinDeg(angle);
      const lit = n => { const [nx, ny, nz] = turn ? turn(n) : n; return tone((c * nx - s * ny) * x + (s * nx + c * ny) * y + nz * z); };
      // The roof, then west, east, north, south and the underside, each by how far it leans to the light as the camera sees it.
      const flat = normals.map(lit);
      return (index, face) => {
        const n = round(index, face + 1);
        return n ? lit(n) : flat[face + 1];
      };
    }
  };
}

function readModel(source) {
  fields(source, sourceFields, 'stack');
  if (source.format !== 'pixelforge-stack' || source.version !== 1) fail('stack', 'expected version-1 pixelforge-stack');
  if (!isObject(source.palette)) fail('stack.palette', 'expected a palette of colours');
  // Reuse the recipe's portable-name and palette limits before allocating the volume.
  renderProject({ version: 1, name: source.name, width: 1, height: 1, palette: source.palette, frames: [{ name: 'check' }] });
  const alpha = new Uint8Array(65536);
  let translucent = false;
  for (const [key, color] of Object.entries(source.palette)) {
    if (key.length !== 1 || blank(key) || key.charCodeAt(0) === 0) fail('stack.palette', 'use single nonblank grid characters');
    const a = parseColor(color, {}, `stack.palette.${key}`)[3];
    alpha[key.charCodeAt(0)] = a;
    translucent ||= a < 255;
  }
  // The grids of the stack or of one part, ground first, as one volume.
  function volume(slices, path) {
    if (!Array.isArray(slices) || !slices.length || slices.length > 64) fail(`${path}.slices`, 'expected 1–64 grids, ground first');
    let width, height, cells;
    const levels = slices.length;
    slices.forEach((rows, z) => {
      const at = `${path}.slices[${z}]`, grid = readRows(rows, at, source.palette, 128);
      if (!z) { width = grid.width; height = grid.height; cells = new Uint16Array(width * height * levels); }
      if (width !== grid.width || height !== grid.height) fail(at, 'all slices must have the same dimensions');
      let i = z * width * height;
      for (const row of rows) for (const key of row) cells[i++] = blank(key) || !alpha[key.charCodeAt(0)] ? 0 : key.charCodeAt(0);
    });
    return { width, height, levels, cells, decals: faces.map(() => new Map()) };
  }
  const model = { ...volume(source.slices, 'stack'), alpha, translucent, geometry:stackGeometry(source) };
  const { width, height, levels } = model;
  const library = source.decals ?? {};
  if (!isObject(library) || Object.keys(library).length > 256) fail('stack.decals', 'expected at most 256 named grids');
  const grids = new Map();
  let libraryCells = 0;
  for (const [name, rows] of Object.entries(library)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) fail('stack.decals', 'use 1–64 letters, digits, underscores or hyphens, starting with a letter');
    const grid = readRows(rows, `stack.decals.${name}`, source.palette, 128);
    libraryCells += grid.width * grid.height;
    if (libraryCells > 262144) fail('stack.decals', 'decal drawings exceed 262,144 cells');
    grids.set(name, grid);
  }
  let paintCells = 0;
  // Side paintings on one volume: the stack's own or a part's.
  function painted(solid, paint = [], at) {
    const { width, height, levels, cells } = solid;
    if (!Array.isArray(paint) || paint.length > 1024) fail(at, 'expected at most 1,024 side paintings');
    const strokes = paint.map((stroke, i) => {
      const path = `${at}[${i}]`;
      fields(stroke, ['face', 'at', 'rows', 'depth', 'decal', 'flipX', 'flipY', 'erase'], path);
      const face = faces.indexOf(stroke.face);
      if (face < 0) fail(`${path}.face`, `expected ${faces.join(', ')}`);
      const [u, v] = point(stroke.at ?? [0, 0], `${path}.at`);
      if (['rows', 'erase', 'decal'].filter(key => key in stroke).length !== 1) fail(path, 'choose one of rows, decal or erase');
      const erase = 'erase' in stroke;
      if (erase && 'depth' in stroke) fail(`${path}.depth`, 'an eraser removes the previous mark including its depth');
      if (!('decal' in stroke) && ('flipX' in stroke || 'flipY' in stroke)) fail(path, 'flips apply to a named decal');
      const grid = 'decal' in stroke ? grids.get(stroke.decal)
        : erase ? readRows(stroke.erase, `${path}.erase`, { x: '#fff' }, 128) : readRows(stroke.rows, `${path}.rows`, source.palette, 128);
      if (!grid) fail(`${path}.decal`, 'unknown decal');
      const depth = integer(stroke.depth ?? 0, `${path}.depth`, 0, 128);
      if (u < 0 || v < 0 || u + grid.width > (face < 2 ? height : width) || v + grid.height > levels) fail(path, 'painting must fit inside the side view');
      paintCells += grid.width * grid.height;
      if (paintCells > 262144) fail('stack.paint', 'side paintings exceed 262,144 cells');
      let rows = grid.rows;
      if (boolean(stroke.flipX ?? false, `${path}.flipX`)) rows = rows.map(row => [...row].reverse().join(''));
      if (boolean(stroke.flipY ?? false, `${path}.flipY`)) rows = [...rows].reverse();
      return { face, u, v, rows, depth, erase };
    });
    // Walk backwards to match each eraser cell to its preceding mark on this face.
    // Replay surviving marks forwards so intersecting depth strokes keep their original order.
    if (strokes.some(stroke => stroke.erase)) {
      const skips = faces.map(() => new Uint16Array(128 * levels));
      for (let i = strokes.length - 1; i >= 0; i--) {
        const stroke = strokes[i], skip = skips[stroke.face];
        stroke.rows = stroke.rows.map((row, y) => [...row].map((key, x) => {
          if (blank(key)) return key;
          const at = (stroke.v + y) * 128 + stroke.u + x;
          if (stroke.erase) skip[at]++;
          else if (skip[at]) { skip[at]--; return '.'; }
          return key;
        }).join(''));
      }
    }
    for (const { face, u, v, rows, depth, erase } of strokes) {
      if (erase) continue;
      rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (blank(row[x])) continue;
          const hit = surface(solid, face, u + x, v + y);
          if (!hit) continue;
          const color = row.charCodeAt(x);
          if (alpha[color]) solid.decals[face].set(hit.at, color);
          else solid.decals[face].delete(hit.at);
          const fill = alpha[color] ? color : 0;
          for (let j = 0, at = hit.at; j < Math.min(depth, hit.remaining) && cells[at]; j++, at += hit.step) cells[at] = fill;
        }
      });
    }
  }
  painted(model, source.paint, 'stack.paint');
  const tones = readTones(source, alpha);
  model.tones = tones?.(model);
  // Parts: grids of their own that ride a socket, painted on their sides like the stack and shaded by its ramps.
  const definitions = source.parts ?? {};
  if (!isObject(definitions) || Object.keys(definitions).length > 32) fail('stack.parts', 'expected at most 32 named parts');
  let partCells = 0;
  model.parts = Object.entries(definitions).map(([name, part]) => {
    const path = `stack.parts.${name}`;
    portableName(name, path);
    fields(part, ['slices', 'at', 'socket', 'paint'], path);
    if (part.socket !== undefined && !model.geometry.sockets.has(part.socket)) fail(`${path}.socket`, `unknown socket; the stack's sockets are ${[...model.geometry.sockets.keys()].join(', ') || 'none: declare one in sockets'}`);
    const solid = volume(part.slices, path);
    partCells += solid.width * solid.height * solid.levels;
    if (partCells > 262144) fail('stack.parts', 'parts together exceed 262,144 cells');
    painted(solid, part.paint, `${path}.paint`);
    return { ...solid, name, socket: part.socket, at: triple(part.at ?? [0, 0, 0], `${path}.at`), tones: tones?.(solid, false) };
  });
  if (source.reliefs !== undefined) {
    const spacing = integer(source.spacing ?? 1, 'stack.spacing', 1, 8);
    appendStackReliefs(source, model.geometry.facets, faces, (face, u, z, rise, path) => {
      const acrossY = face < 2, span = acrossY ? height : width, top = (levels - 1) * spacing + 1;
      if (u < 0 || u > span || z < 0 || z > top) fail(path, 'relief extends outside the side of the stack');
      const level = Math.min(levels - 1, Math.floor(z / spacing));
      const hit = surface(model, face, Math.min(span - 1, Math.floor(u)), levels - 1 - level);
      if (!hit || z - level * spacing > 1) fail(path, 'relief needs a voxel under its crest and both edges');
      const depth = acrossY ? hit.at % width : Math.floor(hit.at / width) % height;
      const out = face % 2 ? depth + 1 + rise : depth - rise;
      return acrossY ? [out, u, z] : [u, out, z];
    });
  }
  return model;
}

export function stackSide(source, side) {
  return sideRows(readModel(source), side);
}

function sideRows(model, side) {
  const face = faces.indexOf(side);
  if (face < 0) fail('stack.face', `expected ${faces.join(', ')}`);
  return Array.from({ length: model.levels }, (_, row) => {
    let line = '';
    for (let u = 0; u < (face < 2 ? model.height : model.width); u++) {
      const hit = surface(model, face, u, row);
      line += hit ? String.fromCharCode(model.decals[face].get(hit.at) ?? model.cells[hit.at]) : '.';
    }
    return line;
  });
}

// Grid traversal from the camera. Clip to the volume first, then advance directly to cell
// boundaries. At a corner cross all tied axes together; the top face wins a visibility tie.
function raster(model, view, angle, pose, budget) {
  const { width: w, height: h, levels, cells, decals } = model;
  const { resolution, squash, spacing, anchor, pivot, width, height } = view;
  // On a map's grid the ground axes are scaled (see groundAxes), so going back from the screen divides by their square.
  const [c, s] = groundAxes(view, angle), n = view.grid ? .5 : 1, top = (levels - 1) * spacing + 1;
  const vx = -s / squash * n, vy = -c / squash * n, dx = Math.sign(vx), dy = Math.sign(vy);
  const deltaX = dx ? 1 / Math.abs(vx) : Infinity, deltaY = dy ? 1 / Math.abs(vy) : Infinity;
  const faceX = dx > 0 ? 0 : 1, faceY = dy > 0 ? 2 : 3;
  let visits = 0;
  const layered = model.translucent || model.geometry.facets.length > 0 || model.parts.length > 0;
  const fragments = layered ? stackFragments(width, height, model.alpha) : null;
  const tones = model.tones?.(angle);
  const rows = [];
  for (let py = 0; py < height; py++) {
    const row = new Uint16Array(width).fill(46), sy = (py + .5 - anchor[1]) / resolution / squash;
    for (let px = 0; px < width; px++) {
      const sx = (px + .5 - anchor[0]) / resolution;
      const ox = pivot[0] + .5 + sx * c * n + sy * s * n - top * vx;
      const oy = pivot[1] + .5 - sx * s * n + sy * c * n - top * vy;
      if ((!dx && (ox < 0 || ox >= w)) || (!dy && (oy < 0 || oy >= h))) continue;
      const enterX = dx ? ((dx > 0 ? 0 : w) - ox) / vx : -Infinity;
      const enterY = dy ? ((dy > 0 ? 0 : h) - oy) / vy : -Infinity;
      const leaveX = dx ? ((dx > 0 ? w : 0) - ox) / vx : Infinity;
      const leaveY = dy ? ((dy > 0 ? h : 0) - oy) / vy : Infinity;
      const enter = Math.max(0, enterX, enterY), leave = Math.min(top, leaveX, leaveY);
      if (enter >= leave) continue;
      const probe = Math.min(enter + 1e-9, (enter + leave) / 2);
      let x = Math.floor(ox + vx * probe), y = Math.floor(oy + vy * probe), z = Math.floor(top - probe);
      let tx = dx ? (x + (dx > 0 ? 1 : 0) - ox) / vx : Infinity;
      let ty = dy ? (y + (dy > 0 ? 1 : 0) - oy) / vy : Infinity;
      let tz = top - z, face = enter === 0 ? -1 : enterX >= enterY ? faceX : faceY;
      let entry = enter, glass = false;
      while (x >= 0 && x < w && y >= 0 && y < h && z >= 0) {
        visits++;
        const index = (z / spacing * h + y) * w + x;
        const ink = z % spacing === 0 ? cells[index] : 0;
        if (ink) {
          const paint = face >= 0 ? decals[face].get(index) : 0, tone = tones?.(index, face);
          if (!layered) { row[px] = tone ? tone[paint || ink] : paint || ink; break; }
          const at = py*width+px, depth = top-entry;
          if (!glass || model.alpha[ink]===255) fragments.add(at,depth,tone ? tone[ink] : ink);
          if (paint && paint!==ink) fragments.add(at,depth,tone ? tone[paint] : paint);
          if (model.alpha[ink]===255 || model.alpha[paint]===255) break;
          glass = true;
        } else glass = false;
        const next = Math.min(tx, ty, tz);
        if (next >= leave) break;
        entry = next;
        if (tx <= next + 1e-10) { x += dx; tx += deltaX; face = faceX; }
        if (ty <= next + 1e-10) { y += dy; ty += deltaY; face = faceY; }
        if (tz <= next + 1e-10) { z--; tz++; face = -1; }
      }
    }
    if (visits > budget.left) fail('stack.headings', 'stack exceeds 96 million ray steps; use fewer headings or a lower resolution');
    if (!layered) rows.push(String.fromCharCode(...row));
  }
  budget.left -= visits;
  if (!layered) return [{op:'grid', rows}];
  for (const part of model.parts) rasterPart(part, view, angle, pose, fragments, model.alpha, budget);
  drawFacets(projectFacets(model.geometry,pose,view,angle),view,fragments,budget);
  return fragments.ops(budget);
}

// The corners of a part's box, in its socket's space.
const corners = ({ width, height, levels, at }, spacing) => [0, width].flatMap(x => [0, height].flatMap(y => [0, (levels - 1) * spacing + 1].map(z => [at[0] + x, at[1] + y, at[2] + z])));

// One part into the frame's samples. Its socket has moved and turned it, so each pixel's ray is taken into the part's
// own space, clipped to its box and walked from cell to cell there, as the stack's own rays are. `t` counts how far
// the ray has come down from the ground's level (it is negative above the ground), so a hit is at height -t in the
// stack's space, which is what the samples of the stack and of facets are ordered by.
function rasterPart(part, view, angle, pose, fragments, alpha, budget) {
  const { width: w, height: h, levels, cells, decals } = part;
  const { resolution, squash, spacing, anchor, pivot, width, height } = view;
  const [c, s] = groundAxes(view, angle), n = view.grid ? .5 : 1, tall = (levels - 1) * spacing + 1;
  const socket = part.socket ? pose.get(part.socket) : null, [ox, oy, oz] = socket?.origin ?? [0, 0, 0];
  const into = v => (socket ? spun(socket.axis, socket.c, -socket.s, v) : v);
  const out = v => (socket ? spun(socket.axis, socket.c, socket.s, v) : v);
  const vx = -s / squash * n, vy = -c / squash * n, [dx, dy, dz] = into([vx, vy, -1]);
  const tones = part.tones?.(angle, socket && out);
  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  // A ray that runs exactly along a line between two cells is given the cell the stack's own raster gives it: the one
  // further along the stack's axis, or the one the ray is coming to. A turned part's own axes may run the other way,
  // so the side is chosen in the stack's space and taken into the part's.
  const [nx, ny, nz] = into([vx < 0 ? -1e-7 : 1e-7, vy < 0 ? -1e-7 : 1e-7, 0]);
  const deltaX = dx ? 1 / Math.abs(dx) : Infinity, deltaY = dy ? 1 / Math.abs(dy) : Infinity, deltaZ = dz ? 1 / Math.abs(dz) : Infinity;
  // The face a ray comes in by when it steps along each axis; the underside (4) when it rises into a cell.
  const faceX = stepX > 0 ? 0 : 1, faceY = stepY > 0 ? 2 : 3, faceZ = stepZ > 0 ? 4 : -1, faces = [faceX, faceY, faceZ];
  // Where a ray meets two faces at once, an edge, the stack gives its roof, then on the way in the face across its x
  // and, from cell to cell, the one across its y. A turned part's faces are ranked by where they face in the stack.
  const ranks = [stepX, stepY, stepZ].map((step, axis) => { const [ux, uy, uz] = out([0, 1, 2].map(each => (each === axis ? -step : 0))); return [uz * 4 + Math.abs(ux) * 2 + Math.abs(uy), uz * 4 + Math.abs(uy) * 2 + Math.abs(ux)]; });
  const entering = ranks.map(rank => rank[0]), [low, mid, high] = [0, 1, 2].sort((a, b) => ranks[a][1] - ranks[b][1] || a - b);
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (const xyz of corners(part, spacing)) {
    const [u, v] = projectPoint(placed({ xyz, socket: part.socket }, pose), view, c, s);
    x0 = Math.min(x0, Math.floor(u) - 1); x1 = Math.max(x1, Math.ceil(u) + 1);
    y0 = Math.min(y0, Math.floor(v) - 1); y1 = Math.max(y1, Math.ceil(v) + 1);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(width - 1, x1); y1 = Math.min(height - 1, y1);
  let visits = 0;
  for (let py = y0; py <= y1; py++) {
    const sy = (py + .5 - anchor[1]) / resolution / squash;
    for (let px = x0; px <= x1; px++) {
      const sx = (px + .5 - anchor[0]) / resolution;
      // Where the ray meets the ground's level, in the part's space.
      const ground = into([pivot[0] + .5 + sx * c * n + sy * s * n - ox, pivot[1] + .5 - sx * s * n + sy * c * n - oy, -oz]);
      const lx = ground[0] - part.at[0], ly = ground[1] - part.at[1], lz = ground[2] - part.at[2];
      let enter = -Infinity, leave = Infinity, face = -1, rank = -Infinity;
      const span = (l, d, size, axis) => {
        const a = -l / d, b = (size - l) / d, near = Math.min(a, b);
        if (near > enter || (near === enter && entering[axis] >= rank)) { enter = near; face = faces[axis]; rank = entering[axis]; }
        leave = Math.min(leave, Math.max(a, b));
      };
      if (dx) span(lx, dx, w, 0);
      else if (lx + nx < 0 || lx + nx >= w) continue;
      if (dy) span(ly, dy, h, 1);
      else if (ly + ny < 0 || ly + ny >= h) continue;
      if (dz) span(lz, dz, tall, 2);
      else if (lz + nz < 0 || lz + nz >= tall) continue;
      if (!(enter < leave)) continue;
      const probe = Math.min(enter + 1e-9, (enter + leave) / 2);
      let x = Math.max(0, Math.min(w - 1, Math.floor(lx + (dx ? dx * probe : nx)))), y = Math.max(0, Math.min(h - 1, Math.floor(ly + (dy ? dy * probe : ny)))), z = Math.max(0, Math.min(tall - 1, Math.floor(lz + (dz ? dz * probe : nz))));
      let tx = dx ? (x + (stepX > 0 ? 1 : 0) - lx) / dx : Infinity, ty = dy ? (y + (stepY > 0 ? 1 : 0) - ly) / dy : Infinity, tz = dz ? (z + (stepZ > 0 ? 1 : 0) - lz) / dz : Infinity;
      let entry = enter, glass = false;
      while (x >= 0 && x < w && y >= 0 && y < h && z >= 0 && z < tall) {
        visits++;
        const index = (z / spacing * h + y) * w + x, ink = z % spacing === 0 ? cells[index] : 0;
        if (ink) {
          const paint = face >= 0 && face < 4 ? decals[face].get(index) : 0, tone = tones?.(index, face);
          const pixel = py * width + px, depth = -entry;
          if (!glass || alpha[ink] === 255) fragments.add(pixel, depth, tone ? tone[ink] : ink);
          if (paint && paint !== ink) fragments.add(pixel, depth, tone ? tone[paint] : paint);
          if (alpha[ink] === 255 || alpha[paint] === 255) break;
          glass = true;
        } else glass = false;
        const next = Math.min(tx, ty, tz);
        if (next >= leave) break;
        entry = next;
        const crossed = [tx <= next + 1e-10, ty <= next + 1e-10, tz <= next + 1e-10];
        if (crossed[0]) { x += stepX; tx += deltaX; }
        if (crossed[1]) { y += stepY; ty += deltaY; }
        if (crossed[2]) { z += stepZ; tz += deltaZ; }
        face = faces[crossed[high] ? high : crossed[mid] ? mid : low];
      }
    }
    if (visits > budget.left) fail('stack.parts', 'stack exceeds 96 million ray steps; use fewer headings or frames, or a lower resolution');
  }
  budget.left -= visits;
}

export function prepareStack(source, { maxPixels = FRAME_AREA } = {}) {
  const model = readModel(source), { width: w, height: h, levels } = model;
  const organic = stackPaths(source, model.geometry.sockets, model.geometry.facets.length);
  function posedModel(heading, angles, timed) {
    if (!organic) return model;
    const mesh = organic.mesh(angles ?? organic.anglesAt(heading, timed));
    return { ...model, paths:mesh.posed, geometry:{ ...model.geometry, facets:model.geometry.facets.concat(mesh.facets) } };
  }
  const projection = source.projection ?? 'oblique';
  if (!['oblique', 'iso'].includes(projection)) fail('stack.projection', 'expected oblique or iso');
  if (projection === 'iso' && source.squash !== undefined) fail('stack.squash', 'iso uses a 2:1 ground grid; set squash with oblique projection');
  const squash = number(source.squash ?? (projection === 'iso' ? .5 : .65), 'stack.squash', .25, 1);
  // `cell` puts an iso stack on a map's 2:1 grid: a slice cell steps that many pixels across and half as many down,
  // and a slice rises as many, so 16 cells at `cell: 1` cover a 32x16 tile and a cube is the standard block.
  const grid = source.cell !== undefined;
  if (grid && projection !== 'iso') fail('stack.cell', 'cell puts a stack on an isometric map\'s grid; set projection to iso');
  if (grid && source.resolution !== undefined) fail('stack.resolution', 'cell sets the size on the map\'s grid; give cell or resolution, not both');
  const resolution = grid ? integer(source.cell, 'stack.cell', 1, 8) : integer(source.resolution ?? 4, 'stack.resolution', 1, 8);
  const spacing = integer(source.spacing ?? 1, 'stack.spacing', 1, 8);
  // On the grid a stack turns about the middle of its footprint, on a cell corner when a side is even, so a quarter
  // turn lays cells on cells; a pivot written out is the centre of its cell either way.
  const middle = [w, h].map(side => Math.floor(side / 2) - (grid && (w % 2 === 0 || h % 2 === 0) ? .5 : 0));
  const pivot = source.pivot === undefined ? middle : point(source.pivot, 'stack.pivot');
  if (pivot[0] < 0 || pivot[0] >= w || pivot[1] < 0 || pivot[1] >= h) fail('stack.pivot', 'ground pivot must be inside the slice');
  const headings = source.headings ?? Array.from({ length: 16 }, (_, i) => Math.round(i * 360 / 16));
  if (!Array.isArray(headings) || !headings.length || headings.length > 256 || new Set(headings).size !== headings.length) fail('stack.headings', 'expected 1–256 distinct angles in degrees');
  const duration = integer(source.duration ?? 80, 'stack.duration', 1, 60000);
  const cameraAngle = heading => (heading + (projection === 'iso' ? 45 : 0)) % 360;
  const angles = headings.map((a, i) => cameraAngle(integer(a, `stack.headings[${i}]`, 0, 359)));
  // Names for headings, which an animation's frames and its animation at each heading take in place of the degrees.
  const directions = new Map();
  if (source.directions !== undefined) {
    if (!isObject(source.directions) || Object.keys(source.directions).length > 64) fail('stack.directions', 'expected up to 64 names, each with a heading in degrees');
    for (const [name, heading] of Object.entries(source.directions)) {
      portableName(name, `stack.directions.${name}`);
      integer(heading, `stack.directions.${name}`, 0, 359);
      if (directions.has(heading)) fail(`stack.directions.${name}`, `heading ${heading} is already named ${directions.get(heading)}`);
      directions.set(heading, name);
    }
  }
  const facing = heading => directions.get(heading) ?? String(heading);
  // Animations: sockets and poses keyed by frame. In a frame a keyed socket follows the animation's keys and every
  // other socket its own keys by heading; a key at the frame count is the pose a loop comes round to.
  const clipSources = source.animations ?? {};
  if (!isObject(clipSources) || Object.keys(clipSources).length > 32) fail('stack.animations', 'expected at most 32 named animations');
  const clips = Object.entries(clipSources).map(([name, clip]) => {
    const path = `stack.animations.${name}`;
    portableName(name, path);
    if (name === 'turn') fail(path, 'turn is the animation of the headings; choose another name');
    fields(clip, ['frames', 'duration', 'durations', 'loop', 'headings', 'sockets', 'poses'], path);
    const count = integer(clip.frames, `${path}.frames`, 1, 256);
    if (clip.duration !== undefined && clip.durations !== undefined) fail(`${path}.durations`, 'give duration, for every frame, or durations, one for each frame; not both');
    const durations = clip.durations ?? Array(count).fill(integer(clip.duration ?? duration, `${path}.duration`, 1, 60000));
    if (!Array.isArray(durations) || durations.length !== count) fail(`${path}.durations`, `expected ${count} durations, one for each frame`);
    durations.forEach((ms, i) => integer(ms, `${path}.durations[${i}]`, 1, 60000));
    const seen = clip.headings ?? headings;
    if (!Array.isArray(seen) || !seen.length || seen.length > 256 || new Set(seen).size !== seen.length) fail(`${path}.headings`, 'expected 1–256 distinct angles in degrees');
    seen.forEach((heading, i) => integer(heading, `${path}.headings[${i}]`, 0, 359));
    if (clip.sockets !== undefined && !isObject(clip.sockets)) fail(`${path}.sockets`, 'expected keys for named sockets');
    const sockets = new Map();
    for (const [socket, keys] of Object.entries(clip.sockets ?? {})) {
      if (!model.geometry.sockets.has(socket)) fail(`${path}.sockets.${socket}`, `unknown socket; the stack's sockets are ${[...model.geometry.sockets.keys()].join(', ') || 'none: declare one in sockets'}`);
      sockets.set(socket, socketKeys(keys, `${path}.sockets.${socket}`, 'frame', count));
    }
    if (clip.poses !== undefined && !organic) fail(`${path}.poses`, 'poses bend jointed paths, and this stack has none');
    const poses = clip.poses === undefined ? [] : organic.poseKeys(clip.poses, `${path}.poses`, 'frame', count);
    if (!sockets.size && !poses.length) fail(path, 'an animation keys a socket (sockets) or a pose (poses) by frame');
    return { name, count, durations, loop: boolean(clip.loop ?? true, `${path}.loop`), headings: seen, sockets, poses: poses.length ? poses : null };
  });
  // Every frame in order: the headings, then each animation at each of its headings.
  const plan = headings.map((heading, i) => ({ name: `heading-${heading}`, duration, heading, angle: angles[i] }));
  for (const clip of clips) for (const heading of clip.headings) for (let frame = 0; frame < clip.count; frame++) {
    if (`${clip.name}-${facing(heading)}-${frame}`.length > 64) fail(`stack.animations.${clip.name}`, `its frame ${clip.name}-${facing(heading)}-${frame} has a name longer than 64 characters; shorten the animation's name${directions.has(heading) ? ' or the direction\'s' : ''}`);
    plan.push({ name: `${clip.name}-${facing(heading)}-${frame}`, duration: clip.durations[frame], heading, angle: cameraAngle(heading), timed: { sockets: clip.sockets, poses: clip.poses, frame } });
  }
  if (plan.length > 256) fail('stack.animations', `${headings.length} headings and ${plan.length - headings.length} frames of animations are ${plan.length} frames; a recipe holds 256, so give an animation fewer headings (its own headings) or frames`);
  const playing = clips.flatMap(clip => clip.headings.map(heading => `${clip.name}-${facing(heading)}`));
  for (const names of [plan.map(frame => frame.name), playing]) {
    const twice = names.find((name, i) => names.indexOf(name) !== i);
    if (twice) fail('stack.animations', `two animations make the name ${twice}; rename one of them or a direction`);
  }
  let left = 0, right = 0, bottom = 0, roof = 0;
  const tall = (levels - 1) * spacing + 1;
  // The top and bottom of the four footprint corners bound every visible cell. Round outwards
  // once for all requested headings, so even an off-centre pivot stays still throughout a turn.
  const sidesX = [-pivot[0] - .5, w - pivot[0] - .5], sidesY = [-pivot[1] - .5, h - pivot[1] - .5];
  const bounds = {pivot,anchor:[0,0],resolution,squash,grid};
  function headingBounds(shape, pose, angle, include) {
    const [c, s] = groundAxes(bounds, angle);
    for (const {origin} of pose.values()) {
      const [u,v] = projectPoint(origin,bounds,c,s);
      include(u,v);
    }
    for (const part of shape.parts) for (const xyz of corners(part, spacing)) {
      const [u,v] = projectPoint(placed({ xyz, socket: part.socket }, pose),bounds,c,s);
      include(u,v);
    }
    for (const facet of projectFacets(shape.geometry,pose,bounds,angle)) for (const [u,v] of facet.points) include(u,v);
    for (const x of sidesX) for (const y of sidesY) {
      const u = (x * c - y * s) * resolution, v = (x * s + y * c) * squash * resolution;
      include(u,v - tall * resolution); include(u,v);
    }
  }
  for (const { heading, angle, timed } of plan) {
    headingBounds(posedModel(heading, undefined, timed), socketPose(model.geometry.sockets, heading, timed), angle, (x,y) => {
      left = Math.min(left, Math.floor(x)); right = Math.max(right, Math.ceil(x));
      roof = Math.min(roof, Math.floor(y)); bottom = Math.max(bottom, Math.ceil(y));
    });
  }
  if (model.geometry.facets.length || model.geometry.sockets.size || organic?.paths.size || model.parts.length) { left-=2; right+=2; roof-=2; bottom+=2; }
  const width = right - left, height = bottom - roof, anchor = [-left, -roof];
  if (!frameFits(width, height) || frameTotalProblem(plan.length, width, height)) fail('stack.resolution', `the ${width}×${height} canvas at ${resolution}× with ${clips.length ? `${plan.length} frames (${angles.length} headings and the animations)` : `${angles.length} headings`} exceeds the recipe budget; reduce resolution, spacing or heading count`);
  if (width * height * plan.length > maxPixels) fail('scene.assets', 'sprite stacks together exceed the scene asset pixel budget');
  const view = { resolution, squash, spacing, anchor, pivot, width, height, grid }, budget = { left: 96000000 };
  // At a heading of the grid the pivot is half a pixel down from the anchor when that is what puts the footprint's far
  // corner, and so the cell corners, on whole pixels: an odd `cell` with the pivot an odd count of cells from that corner.
  const px = pivot[0] + .5, py = pivot[1] + .5, far = { 45: px + py, 135: px + h - py, 225: w - px + h - py, 315: w - px + py };
  const half = angle => grid && angle % 90 === 45 && far[angle] * resolution % 2 ? .5 : 0;
  const seen = (angle, port = view) => (half(angle) ? { ...port, anchor: [port.anchor[0], port.anchor[1] + .5] } : port);
  // What a game looks a heading up in (the recipe's `headings`, which its atlas carries): the frame that stands at
  // each heading, the animation that plays each animation there, and the way the stack's +y, its front, points on
  // screen at that heading, so a game can pick a heading by the direction something moves.
  const toward = heading => {
    const [c, s] = groundAxes(view, cameraAngle(heading)), x = -s, y = c * squash, length = Math.sqrt(x * x + y * y);
    return [Math.round(x / length * 10000) / 10000 + 0, Math.round(y / length * 10000) / 10000 + 0];
  };
  const lookup = { frames: Object.fromEntries(headings.map(heading => [heading, `heading-${heading}`])),
    ...(clips.length && { animations: Object.fromEntries(clips.map(clip => [clip.name, Object.fromEntries(clip.headings.map(heading => [heading, `${clip.name}-${facing(heading)}`]))])) }),
    toward: Object.fromEntries([...new Set(plan.map(frame => frame.heading))].map(heading => [heading, toward(heading)])) };
  const frames = new Array(plan.length);
  // An animation is listed with its frame count and headings; it plays at a heading as `<name>-<heading>`, or
  // `<name>-<direction>` where that heading has a name, and its frames there are that name with -0, -1 and so on.
  const metadata = { format: 'pixelforge-stack-metadata', resolution, projection, ...(grid && { cell: resolution }), footprint: [w, h], levels, spacing, pivot, anchor, headings,
    ...(clips.length && { animations: Object.fromEntries(clips.map(clip => [clip.name, { frames: clip.count, loop: clip.loop, headings: clip.headings }])) }),
    ...(directions.size && { directions: source.directions }) };
  // Frames are drawn when first asked for: the headings by their index, then the animations' frames.
  function frame(index) {
    integer(index, 'stack.frame', 0, plan.length - 1);
    if (!frames[index]) {
      const { name, duration, heading, angle, timed } = plan[index];
      const pose = socketPose(model.geometry.sockets, heading, timed);
      frames[index] = {name, duration,
        ...(pose.size && {points:projectSockets(pose,seen(angle),angle)}),
        ops:raster(posedModel(heading, undefined, timed),seen(angle),angle,pose,budget)};
    }
    return frames[index];
  }
  function recipe(index) {
    const drawn = index === undefined ? plan.map((_, i) => frame(i)) : [frame(index)];
    const animations = { turn: { frames: (index === undefined ? drawn.slice(0, headings.length) : drawn).map(f => f.name), loop: true } };
    if (index === undefined) {
      let at = headings.length;
      for (const clip of clips) for (const heading of clip.headings) {
        animations[`${clip.name}-${facing(heading)}`] = { frames: drawn.slice(at, at + clip.count).map(f => f.name), loop: clip.loop };
        at += clip.count;
      }
    }
    return { version: 1, name: source.name, width, height, anchor, palette: source.palette,
      ...(source.ramps && { ramps: source.ramps.map(ramp => [...ramp]) }), frames: drawn, animations,
      ...(index === undefined && { headings: lookup }) };
  }
  // Follow the centre of the picked vertical face in model space. Keep the original sample
  // lattice and occlusion, even when the face turns away or the angle is between saved frames.
  function detail(side, at, heading, size = 32) {
    const face = faces.indexOf(side);
    if (face < 0) fail('stack.face', 'unknown side');
    const [u, v] = point(at, 'stack.detail.at');
    integer(size, 'stack.detail.size', 1, 128);
    const angle = cameraAngle(integer(heading, 'stack.detail.heading', 0, 359));
    if (u < 0 || u >= (face < 2 ? h : w) || v < 0 || v >= levels) return null;
    const hit = surface(model, face, u, v);
    if (!hit) return null;
    const x = hit.at % w - pivot[0] + (face === 0 ? -.5 : face === 1 ? .5 : 0);
    const y = Math.floor(hit.at / w) % h - pivot[1] + (face === 2 ? -.5 : face === 3 ? .5 : 0);
    const z = (levels - 1 - v) * spacing + .5, [c, s] = groundAxes(view, angle);
    const left = Math.floor(anchor[0] + (x*c - y*s)*resolution - size/2);
    const top = Math.floor(anchor[1] + ((x*s + y*c)*squash - z)*resolution - size/2);
    const crop = seen(angle, { ...view, width: size, height: size, anchor: [anchor[0]-left, anchor[1]-top] });
    const ops = raster(posedModel(heading), crop, angle, socketPose(model.geometry.sockets,heading), { left: 96000000 });
    return { left, top, rows:ops[0].rows, ops };
  }
  function comparison(side, at, heading) {
    integer(heading, 'stack.detail.heading', 0, 359);
    const size = 9 * resolution, frames = [];
    for (let offset = -2; offset <= 2; offset++) {
      const angle = (heading + offset + 360) % 360, crop = detail(side, at, angle, size);
      if (!crop) return null;
      frames.push({ name: `heading-${angle}`, duration, ops: crop.ops });
    }
    return { version: 1, name: source.name, width: size, height: size, palette: source.palette, frames, animations: {} };
  }
  function projectSockets(pose, viewport, angle) {
    const [c, s] = groundAxes(viewport, angle);
    return Object.fromEntries([...pose].map(([name, {origin}]) =>
      [name,projectPoint(origin,viewport,c,s).slice(0,2).map(Math.floor)]));
  }
  function attachments(heading) {
    const angle = cameraAngle(integer(heading,'stack.heading',0,359));
    return projectSockets(socketPose(model.geometry.sockets,heading),seen(angle),angle);
  }
  const mounted = new Set(model.geometry.facets.flatMap(face => face.points.map(p => p.socket)));
  for (const path of organic?.paths.values() ?? []) mounted.add(path.socket);
  for (const part of model.parts) mounted.add(part.socket);
  // A part's box as the vertices of a face, for the bounds of a rotation.
  const boxes = model.parts.map(part => ({ points: corners(part, spacing).map(xyz => ({ xyz, socket: part.socket })) }));
  const rotationSockets = [...model.geometry.sockets.keys()].filter(name => mounted.has(name));
  function rotationStudy(heading, socket) {
    const angle = cameraAngle(integer(heading, 'stack.heading', 0, 359));
    if (!rotationSockets.includes(socket)) fail('stack.rotation.socket', rotationSockets.length
      ? 'choose a socket with attached facet vertices or a part: ' + rotationSockets.join(', ') : 'this stack has no socket-mounted facets or parts');
    const pose = socketPose(model.geometry.sockets, heading), pivotPose = pose.get(socket);
    let x0 = left, x1 = right, y0 = roof, y1 = bottom;
    function include(x, y) {
      x0 = Math.min(x0, Math.floor(x) - 2); x1 = Math.max(x1, Math.ceil(x) + 2);
      y0 = Math.min(y0, Math.floor(y) - 2); y1 = Math.max(y1, Math.ceil(y) + 2);
    }
    const shape = posedModel(heading);
    if (!headings.includes(heading)) headingBounds(shape, pose, angle, include);
    includeRotationBounds(shape.geometry.facets.concat(boxes), socket, pivotPose, bounds, angle, include);
    const viewport = seen(angle, { ...view, width: x1 - x0, height: y1 - y0, anchor: [-x0, -y0] });
    if (!frameFits(viewport.width, viewport.height)) fail('stack.rotation', 'the full rotation exceeds the frame budget; reduce the stack resolution');
    const points = projectSockets(pose, viewport, angle);
    function rotationRecipe(degrees) {
      const offsets = Array.isArray(degrees) ? degrees : [degrees];
      if (!offsets.length || offsets.length > 256 || new Set(offsets).size !== offsets.length) fail('stack.rotation.offset', 'expected 1–256 distinct offsets');
      for (const offset of offsets) number(offset, 'stack.rotation.offset', 0, 360);
      const problem = frameTotalProblem(offsets.length, viewport.width, viewport.height);
      if (problem) fail('stack.rotation.offset', problem);
      const budget = { left: 96000000 };
      const frames = offsets.map(offset => {
        const spin = pivotPose.angle + offset % 360;
        pose.set(socket, { ...pivotPose, c: cosDeg(spin), s: sinDeg(spin) });
        const name = offsets.length === 1 ? `heading-${heading}` : 'rotation-' + String(offset).replace('.', 'p');
        return { name, duration, points, ops: raster(shape, viewport, angle, pose, budget) };
      });
      return { version: 1, name: source.name, width: viewport.width, height: viewport.height, anchor: viewport.anchor,
        palette: source.palette, frames, animations: {} };
    }
    return { recipe: rotationRecipe };
  }
  // A row changes only the joint angles. All columns share one socket phase. A
  // focused study follows the rest knuckle at each angle, holding each column still.
  function poseStudy(request) {
    fields(request,['poses','headings','focus','size','phase'],'poseSheet');
    const {poses,headings:cameras,focus}=request;
    if (!Array.isArray(poses) || !poses.length || poses.length>16 || new Set(poses).size!==poses.length)
      fail('poseSheet.poses','expected 1â€“16 distinct named poses');
    for (const name of poses) if (!organic?.poses.has(name)) fail('poseSheet.poses','unknown pose '+name);
    if (!Array.isArray(cameras) || !cameras.length || cameras.length>16 || new Set(cameras).size!==cameras.length)
      fail('poseSheet.headings','expected 1â€“16 distinct camera headings');
    const angles=cameras.map(h=>cameraAngle(integer(h,'poseSheet.headings',0,359)));
    const phase=integer(request.phase??0,'poseSheet.phase',0,359);
    const pose=socketPose(model.geometry.sockets,phase);
    if (focus!==undefined && !organic.paths.has(focus)) fail('poseSheet.focus','unknown path');
    if (request.size!==undefined && focus===undefined) fail('poseSheet.size','size requires a focus path');
    const shapes=poses.map(name=>posedModel(phase,organic.poses.get(name)));
    let ports;
    if (focus!==undefined) {
      const size=integer(request.size??64,'poseSheet.size',8,256);
      const path=posedModel(phase,new Map()).paths.get(focus);
      const centre=placed({xyz:path.centres[0],socket:path.socket},pose);
      ports=angles.map(angle=>{
        const [x,y]=projectPoint(centre,bounds,...groundAxes(bounds,angle));
        return {...view,width:size,height:size,anchor:[Math.floor(size/2)-Math.floor(x),Math.floor(size/2)-Math.floor(y)]};
      });
    } else {
      let x0=0,x1=0,y0=0,y1=0;
      for (const shape of shapes) for (const angle of angles) headingBounds(shape,pose,angle,(x,y)=>{
        x0=Math.min(x0,Math.floor(x)-2); x1=Math.max(x1,Math.ceil(x)+2);
        y0=Math.min(y0,Math.floor(y)-2); y1=Math.max(y1,Math.ceil(y)+2);
      });
      ports=angles.map(angle=>seen(angle,{...view,width:x1-x0,height:y1-y0,anchor:[-x0,-y0]}));
    }
    const {width,height}=ports[0], total=poses.length*cameras.length;
    if (!frameFits(width,height) || frameTotalProblem(total,width,height)) fail('poseSheet','matrix exceeds the frame budget; choose fewer poses, headings or a smaller focus');
    const budget={left:96000000};
    const frames=shapes.flatMap((shape,row)=>angles.map((angle,col)=>({
      name:'pose-'+(row+1)+'-heading-'+cameras[col],duration,
      ops:raster(shape,ports[col],angle,pose,budget)
    })));
    return {version:1,name:source.name,width,height,palette:source.palette,frames,animations:{}};
  }
  // The stack's own slices as a sheet, ground first, for a game that stacks them itself at run time (runtime.js's
  // drawStack, the Godot addon's sprite_stack.gd): one frame a slice, anchored at the pivot, and an animation, slices,
  // that lists them in order. The pivot may be a pixel's centre or its corner, which an anchor of whole pixels cannot
  // say, so each frame names it exactly as the point pivot-x2, at twice its coordinates. A slice has one colour a cell, so a mark painted on a side with depth 0 colours its
  // cell. With ramps, a cell takes a tone from a light fixed to the stack, since a turning sheet has no camera: a
  // key lighter where its top is open to the light, and by the sides it shows where it is not, a key either way at
  // most. Parts, animations, facets and paths are the baked frames' alone, and are named in a warning.
  function slices() {
    const { cells, decals, tones } = model, warnings = [], at = (x, y, z) => (z * h + y) * w + x;
    const solid = (x, y, z) => x >= 0 && x < w && y >= 0 && y < h && z >= 0 && z < levels && cells[at(x, y, z)] !== 0;
    if (!cells.some(Boolean)) fail('stack.slices', 'the stack\'s own slices are blank, so there is nothing to stack; a stack made of parts is baked, not sliced');
    const left = [model.parts.length && 'parts', clips.length && 'animations', model.geometry.facets.length && 'facets and lofts', organic && 'jointed paths and membranes'].filter(Boolean);
    if (left.length) warnings.push(`${left.join(', ')} are not in the slices: a slice sheet is the stack's own slices, and a game that wants the rest plays the baked frames`);
    const centre = [pivot[0] + .5, pivot[1] + .5];
    const frames = Array.from({ length: levels }, (_, z) => ({ name: `slice-${z}`, duration, points: { 'pivot-x2': centre.map(part => part * 2) }, ops: [{ op: 'grid', rows: Array.from({ length: h }, (_, y) => {
      const row = new Uint16Array(w).fill(46);
      for (let x = 0; x < w; x++) {
        const index = at(x, y, z);
        let ink = cells[index];
        if (!ink) continue;
        for (const side of decals) ink = side.get(index) ?? ink;
        if (tones) {
          // Open above, it is lit as a roof; else by the sides it shows, west, east, north and south.
          const open = [!solid(x - 1, y, z), !solid(x + 1, y, z), !solid(x, y - 1, z), !solid(x, y + 1, z)];
          const out = !solid(x, y, z + 1) ? [0, 0, 1] : [Number(open[1]) - Number(open[0]), Number(open[3]) - Number(open[2]), 0], size = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
          const table = size ? tones.fixed(out.map(part => part / size), 1) : null;
          if (table) ink = table[ink];
        }
        row[x] = ink;
      }
      return String.fromCharCode(...row);
    }) }] }));
    return { recipe: { version: 1, name: source.name, width: w, height: h, anchor: centre.map(Math.floor), palette: source.palette,
      ...(source.ramps && { ramps: source.ramps.map(ramp => [...ramp]) }), frames, animations: { slices: { frames: frames.map(frame => frame.name), loop: true } }, sheet: { columns: levels } },
      warnings, metadata: { format: 'pixelforge-stack-slices', slices: levels, footprint: [w, h], pivot: centre, spacing, squash, projection } };
  }
  return { metadata, count: plan.length, slices, headingOf: index => plan[integer(index, 'stack.frame', 0, plan.length - 1)].heading, frame, recipe, detail, comparison, attachments, rotationSockets, rotationStudy, poseStudy, side: name => sideRows(model, name) };
}

// Both agent interfaces render the same labelled matrix. Pixel colours (including
// partial alpha) come from the ordinary recipe rasterizer before the matte is applied.
export function inspectPoseSheet(project, request, options = {}) {
  fields(options,['scale','background'],'poseSheet.options');
  const {width,height,frames}=project;
  const rows=request.poses.map((label,r)=>({label,cells:request.headings.map((_,c)=>({
    width,height,anchor:[0,0],data:frames[r*request.headings.length+c].data
  }))}));
  const background=options.background===undefined || options.background==='checker' ? null
    : parseColor(options.background,project.palette,'poseSheet.background');
  const sheet=pictureSheet({rows,headings:request.headings.map(h=>h+' deg'),scale:options.scale??2,
    exactScale:options.scale!==undefined,background});
  return {cells:frames.map(({name,duration})=>({frame:name,duration})),poses:request.poses,headings:request.headings,
    sheet:{...sheet,columns:request.headings.length,rows:request.poses.length}};
}

// A stack's slices as a recipe of stills to stack at run time, in place of its baked headings.
export const compileStackSlices = source => prepareStack(source).slices();

export function compileStack(source, options) {
  const stack = prepareStack(source, options);
  return { recipe: stack.recipe(), warnings: [], metadata: stack.metadata };
}
