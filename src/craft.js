// Browser-compatible pixel-art helpers shared by the renderer, patches and authoring compilers: ordered dither,
// cleanup of doubled corners and stray pixels, pixel-art rotation of palette grids, rewrite rules, easing and seeded
// hashing. Several follow node designs from Pixel Composer (MIT). Everything is deterministic: integer hashing
// instead of Math.random, and polynomial trigonometry instead of Math.sin, whose last bit may differ between engines.
// Inputs are validated by the callers, which own the error paths. No I/O and no imports.

// ---- Ordered dither ----------------------------------------------------------------------------------------------
export const DITHER_PATTERNS = ['bayer2', 'bayer4', 'bayer8', 'noise', 'value'];
function bayer(size) {
  let matrix = [[0]];
  while (matrix.length < size) {
    const n = matrix.length, next = Array.from({ length: n * 2 }, () => new Array(n * 2));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = 4 * matrix[y][x];
      next[y][x] = v; next[y][x + n] = v + 2; next[y + n][x] = v + 3; next[y + n][x + n] = v + 1;
    }
    matrix = next;
  }
  return matrix;
}
// Checks a pattern: a Bayer name, or 1–16 rows of 1–16 integer ranks from 0 to cells − 1. Returns null, or
// [path suffix, message] so each caller reports its own error path.
export function patternProblem(pattern) {
  const names = DITHER_PATTERNS.join(', ');
  if (typeof pattern === 'string') return DITHER_PATTERNS.includes(pattern) ? null : ['', `expected ${names} or a matrix of ranks`];
  const columns = Array.isArray(pattern) && Array.isArray(pattern[0]) ? pattern[0].length : 0;
  if (!Array.isArray(pattern) || !pattern.length || pattern.length > 16 || columns < 1 || columns > 16) return ['', `expected ${names} or 1–16 rows of 1–16 ranks`];
  const cells = pattern.length * columns;
  for (const [r, row] of pattern.entries()) {
    if (!Array.isArray(row) || row.length !== columns) return [`[${r}]`, `all rows must have ${columns} ranks`];
    for (const [k, rank] of row.entries()) if (!Number.isInteger(rank) || rank < 0 || rank >= cells) return [`[${r}][${k}]`, `expected an integer from 0 to ${cells - 1}`];
  }
  return null;
}
// Returns threshold(x, y) in (0, 1) for a named Bayer pattern or a custom matrix of ranks. A matrix whose highest rank
// is n has n + 1 levels, so [[0, 1], [1, 0]] is a checkerboard at 0.5. A pixel is on when its threshold is below the
// density. Thresholds follow canvas coordinates, so neighbouring areas line up. `noise` is seeded white noise with no
// period, so a large area shows no repeating grid: each pixel keeps its threshold for a given seed, so a density
// that rises frame by frame dissolves pixels in one fixed order, and another seed gives another order. `value` is
// seeded smooth noise whose clumps are about `scale` pixels across (moss, rubble, grass patches): neighbouring
// thresholds are close, so a density draws connected blobs instead of speckle.
export function ditherThreshold(pattern, [ox, oy] = [0, 0], seed = 0, scale = 4) {
  if (pattern === 'noise') return (x, y) => ((hash(seed, x + ox, y + oy) >>> 8) + 0.5) / 16777216;
  if (pattern === 'value') return (x, y) => valueThreshold(seed, scale, x + ox, y + oy);
  const matrix = typeof pattern === 'string' ? bayer({ bayer2: 2, bayer4: 4, bayer8: 8 }[pattern]) : pattern;
  const h = matrix.length, w = matrix[0].length, levels = Math.max(...matrix.flat()) + 1;
  return (x, y) => (matrix[(((y + oy) % h) + h) % h][(((x + ox) % w) + w) % w] + 0.5) / levels;
}

// ---- Seeded hashing and engine-independent maths -----------------------------------------------------------------
// A 32-bit hash of integers (MurmurHash3-style mixing). The same inputs give the same value on every platform.
export function hash(...values) {
  let h = 0x811c9dc5;
  for (const value of values) {
    let k = Math.imul(value | 0, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= values.length; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
export const random = (...values) => hash(...values) / 4294967296;

// ---- Smooth value noise --------------------------------------------------------------------------------------------
// Two octaves of seeded lattice values, `scale` pixels apart and then half that, blended with smoothstep weights:
// polynomials only, so every engine computes the same bits. A smooth field crowds its values around the middle, so
// each scale's distribution is sampled once and the field is mapped through it. Thresholds are then uniform, and a
// density of 0.3 covers about 30% of a large area, as with the other patterns.
function lattice(seed, salt, size, x, y) {
  const fx = (x + 0.5) / size, fy = (y + 0.5) / size, ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy, u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
  const at = (i, j) => hash(seed, salt, ix + i, iy + j) / 4294967296;
  return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
}
const smoothField = (seed, scale, x, y) => lattice(seed, 1, scale, x, y) * 0.7 + lattice(seed, 2, scale / 2, x, y) * 0.3;
const fieldSamples = new Map();
function valueThreshold(seed, scale, x, y) {
  if (!fieldSamples.has(scale)) {
    const samples = new Float64Array(16384);
    for (let k = 0; k < samples.length; k++) samples[k] = smoothField(1, scale, hash(k, 1) % 1048576, hash(k, 2) % 1048576);
    fieldSamples.set(scale, samples.sort());
  }
  const samples = fieldSamples.get(scale), value = smoothField(seed, scale, x, y);
  let low = 0, high = samples.length; // the number of samples at or below this value
  while (low < high) { const mid = (low + high) >> 1; if (samples[mid] <= value) low = mid + 1; else high = mid; }
  return (low + 0.5) / (samples.length + 1);
}

const PI = 3.141592653589793;
// Taylor polynomials on [-45°, 45°]; +, * and / are correctly rounded everywhere, so the bits never vary.
function sinCore(x) {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000 + x2 / 355687428096000))))))));
}
function cosCore(x) {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 / 20922789888000)))))));
}
export function sinDeg(degrees) {
  let d = degrees % 360; if (d < 0) d += 360;
  const quadrant = Math.round(d / 90), x = (d - quadrant * 90) * PI / 180;
  switch (quadrant % 4) { case 0: return sinCore(x); case 1: return cosCore(x); case 2: return -sinCore(x); default: return -cosCore(x); }
}
export const cosDeg = degrees => sinDeg(degrees + 90);

// Easing presets for authored motion that is later rounded to whole pixels. Polynomials only, for the same reason.
export const EASINGS = ['linear', 'hold', 'in', 'out', 'inOut', 'overshoot', 'bounce'];
export function ease(name, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (name === 'hold') return 0;
  if (name === 'in') return t * t * t;
  if (name === 'out') { const u = 1 - t; return 1 - u * u * u; }
  if (name === 'inOut') { if (t < 0.5) return 4 * t * t * t; const u = 2 - 2 * t; return 1 - u * u * u / 2; }
  if (name === 'overshoot') { const u = t - 1; return 1 + 2.70158 * u * u * u + 1.70158 * u * u; }
  if (name === 'bounce') {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) { const u = t - 1.5 / 2.75; return 7.5625 * u * u + 0.75; }
    if (t < 2.5 / 2.75) { const u = t - 2.25 / 2.75; return 7.5625 * u * u + 0.9375; }
    const u = t - 2.625 / 2.75; return 7.5625 * u * u + 0.984375;
  }
  return t;
}

// ---- Lines ---------------------------------------------------------------------------------------------------------
// Visits the pixels of a one-pixel Bresenham line, both endpoints included: the renderer's `line` operation and
// effect trails share it, so a cropped trail keeps exactly the pixels a drawn one would have.
export function traceLine(x, y, x2, y2, visit) {
  const dx = Math.abs(x2 - x), sx = x < x2 ? 1 : -1, dy = -Math.abs(y2 - y), sy = y < y2 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    visit(x, y);
    if (x === x2 && y === y2) return;
    const e = 2 * error;
    if (e >= dy) { error += dy; x += sx; }
    if (e <= dx) { error += dx; y += sy; }
  }
}

// ---- Colour distance --------------------------------------------------------------------------------------------
// The one of `candidates` (RGB triples) nearest `rgb` by the red-mean weighted distance, which follows how far apart
// colours look much better than plain RGB and needs only + − ×; the first of equally near candidates wins.
export function nearestColor(rgb, candidates) {
  let best = 0, nearest = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i], mean = (rgb[0] + c[0]) / 2, dr = rgb[0] - c[0], dg = rgb[1] - c[1], db = rgb[2] - c[2];
    const distance = (512 + mean) * dr * dr + 1024 * dg * dg + (767 - mean) * db * db;
    if (distance < nearest) { nearest = distance; best = i; }
  }
  return candidates[best];
}

// ---- Colour ids --------------------------------------------------------------------------------------------------
// Exact RGBA packed into one number; every fully transparent pixel is 0, whatever its hidden RGB.
export const pixelId = (data, at) => data[at + 3] ? (((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0) : 0;
export const colorOf = id => [id >>> 24, (id >>> 16) & 255, (id >>> 8) & 255, id & 255];
export function idsOf(data) {
  const ids = new Uint32Array(data.length / 4);
  for (let i = 0; i < ids.length; i++) ids[i] = pixelId(data, i * 4);
  return ids;
}

// ---- Cleanup: doubled corners and stray pixels ---------------------------------------------------------------------
const FOUR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
// Proposes fixes on a working copy, in scan order, so the second pixel of a doubled pair is judged after the first.
// strays: a pixel whose in-canvas eight neighbours all share one other colour takes that colour (noise, pinholes,
//   isolated specks).
// corners: the corner pixel of an L-shaped step in a one-pixel line (a "double") takes the colour outside the step,
//   when those pixels agree. It needs exactly two perpendicular same-colour neighbours, a different colour on the
//   diagonal between them (so filled areas are untouched) and at least one arm one pixel long, so real right-angle
//   corners with longer arms survive. Repeats until stable (at most four passes).
// `allowed(index)` limits which pixels may change. Returns [{ index, x, y, id, kind }] in scan order.
export function cleanupIds(ids, width, height, { corners = false, strays = false, allowed = () => true } = {}) {
  const work = Uint32Array.from(ids), kinds = new Map();
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? -1 : work[y * width + x]);
  if (strays) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!allowed(i)) continue;
    let shared = -1, uniform = true;
    for (let dy = -1; dy <= 1 && uniform; dy++) for (let dx = -1; dx <= 1; dx++) {
      const n = dx || dy ? at(x + dx, y + dy) : -1;
      if (n < 0) continue;
      if (shared < 0) shared = n; else if (n !== shared) { uniform = false; break; }
    }
    if (uniform && shared >= 0 && shared !== work[i]) { work[i] = shared; kinds.set(i, 'stray'); }
  }
  if (corners) for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, color = work[i];
      if (!color || !allowed(i)) continue;
      const arms = FOUR.filter(([dx, dy]) => at(x + dx, y + dy) === color);
      if (arms.length !== 2) continue;
      const [[ax, ay], [bx, by]] = arms;
      if (ax === -bx && ay === -by) continue; // a straight run, not an L
      if (at(x + ax + bx, y + ay + by) === color) continue; // part of a 2×2 block: a filled area
      const run = (dx, dy) => { let n = 1; while (at(x + dx * (n + 1), y + dy * (n + 1)) === color) n++; return n; };
      if (Math.min(run(ax, ay), run(bx, by)) !== 1) continue;
      const outside = [at(x - ax, y - ay), at(x - bx, y - by), at(x - ax - bx, y - ay - by)].filter(n => n >= 0);
      if (!outside.length || outside.some(n => n !== outside[0])) continue;
      work[i] = outside[0]; kinds.set(i, 'corner'); changed = true;
    }
    if (!changed) break;
  }
  return [...kinds].filter(([i]) => work[i] !== ids[i]).sort((a, b) => a[0] - b[0])
    .map(([i, kind]) => ({ index: i, x: i % width, y: Math.floor(i / width), id: work[i], kind }));
}

// ---- Pixel-art rotation ------------------------------------------------------------------------------------------
// Grids are palette rows; '.' and ' ' are transparent (code 0 while working).
const codesOf = rows => { const codes = new Uint16Array(rows.length * rows[0].length); rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const c = row[x]; codes[y * row.length + x] = c === '.' || c === ' ' ? 0 : c.charCodeAt(0); } }); return codes; };
const rowsOf = (codes, w, h) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => { const c = codes[y * w + x]; return c ? String.fromCharCode(c) : '.'; }).join(''));
// Scale2x (EPX): each pixel becomes four, taking a neighbour's colour where two neighbours agree across a corner.
function scale2x(src, w, h) {
  const out = new Uint16Array(w * h * 4), W = w * 2;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = src[y * w + x], a = at(x, y - 1), b = at(x + 1, y), c = at(x - 1, y), d = at(x, y + 1);
    out[2 * y * W + 2 * x] = c === a && c !== d && a !== b ? a : p;
    out[2 * y * W + 2 * x + 1] = a === b && a !== c && b !== d ? b : p;
    out[(2 * y + 1) * W + 2 * x] = d === c && d !== b && c !== a ? c : p;
    out[(2 * y + 1) * W + 2 * x + 1] = b === d && b !== a && d !== c ? d : p;
  }
  return out;
}
// Rotates clockwise by whole degrees around the centre of the pivot pixel without inventing colours (RotSprite
// style): three Scale2x passes enlarge the grid 8×, which rounds staircase edges, then every output pixel samples the
// enlarged grid where its centre lands when rotated back. Right angles are exact. `cleanup` removes doubled corners
// the resampling leaves. Returns trimmed rows, the pivot's position in them and a mapper for other points.
export function rotateRows(rows, degrees, pivot = [0, 0], { cleanup = true } = {}) {
  const height = rows.length, width = rows[0].length, angle = ((degrees % 360) + 360) % 360;
  const cx = pivot[0] + 0.5, cy = pivot[1] + 0.5, cos = cosDeg(angle), sin = sinDeg(angle);
  const forward = (x, y) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
  const inverse = (x, y) => [cx + (x - cx) * cos + (y - cy) * sin, cy - (x - cx) * sin + (y - cy) * cos];
  const box = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => forward(x, y));
  const left = Math.floor(Math.min(...box.map(p => p[0])) + 1e-9), top = Math.floor(Math.min(...box.map(p => p[1])) + 1e-9);
  const right = Math.ceil(Math.max(...box.map(p => p[0])) - 1e-9), bottom = Math.ceil(Math.max(...box.map(p => p[1])) - 1e-9);
  const exact = angle % 90 === 0, scale = exact ? 1 : 8;
  let source = codesOf(rows), sw = width, sh = height;
  if (!exact) for (let i = 0; i < 3; i++) { source = scale2x(source, sw, sh); sw *= 2; sh *= 2; }
  const w = right - left, h = bottom - top, out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [sx, sy] = inverse(left + x + 0.5, top + y + 0.5);
    if (sx >= 0 && sy >= 0 && sx < width && sy < height) out[y * w + x] = source[Math.floor(sy * scale) * sw + Math.floor(sx * scale)];
  }
  if (cleanup && !exact) for (const change of cleanupIds(out, w, h, { corners: true })) out[change.index] = change.id;
  // Trim transparent borders, keeping at least one cell.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
  const tw = x1 - x0 + 1, th = y1 - y0 + 1, trimmed = new Uint16Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) trimmed[y * tw + x] = out[(y0 + y) * w + x0 + x];
  const originX = left + x0, originY = top + y0;
  const map = ([px, py]) => { const [x, y] = forward(px + 0.5, py + 0.5); return [Math.floor(x + 1e-9) - originX, Math.floor(y + 1e-9) - originY]; };
  return { rows: rowsOf(trimmed, tw, th), pivot: [pivot[0] - originX, pivot[1] - originY], map };
}

// ---- Structural parts --------------------------------------------------------------------------------------------
// A bone is drawn in its posed direction, never resampled from a drawing. The compiler validates inputs and supplies
// a ramp of one-character palette keys. Returned coordinates are symbol-local; pivot is the start joint.
const CLEAN_DIRECTIONS = (() => {
  const out = [];
  for (const [x, y] of [[1, 0], [4, 1], [3, 1], [2, 1], [1, 1]]) {
    const length = Math.sqrt(x * x + y * y);
    for (const [a, b, major, minor] of [[x / length, y / length, x, y], [y / length, x / length, y, x]]) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        if (!out.some(p => p[0] === a * sx && p[1] === b * sy)) out.push([a * sx, b * sy, major * sx, minor * sy]);
      }
    }
  }
  return out;
})();
const SNAP_COS = cosDeg(4);
// Mirrors must be exact. A relit mirror draws a flipped part at the negated angle, so the direction of −θ is the
// direction of θ reflected bit for bit (the polynomials alone differ in the last bit at some angles), and every
// signed coordinate rounds halves away from zero (Math.round(−2.5) is −2, the mirror of 3).
const unitAt = angle => {
  const turn = ((angle % 360) + 360) % 360, folded = turn > 180 ? 360 - turn : turn, y = sinDeg(folded);
  return [cosDeg(folded), turn > 180 ? -y : y];
};
export const roundHalfAway = value => (value < 0 ? -Math.round(-value) : Math.round(value)) + 0; // + 0 turns −0 into 0
export function boneDirection(angle, snap = true) {
  let [x, y] = unitAt(angle), snapped = false, stepX = x, stepY = y;
  if (snap) {
    let best = SNAP_COS, direction = null;
    for (const candidate of CLEAN_DIRECTIONS) {
      const dot = x * candidate[0] + y * candidate[1];
      if (dot > best || (!direction && dot === best)) { best = dot; direction = candidate; }
    }
    if (direction) { [x, y, stepX, stepY] = direction; snapped = true; }
  }
  return { x, y, stepX, stepY, snapped };
}
function endOfBone(length, direction, flipX) {
  const sign = flipX ? -1 : 1, ux = direction.x * sign, uy = direction.y * sign;
  let x = roundHalfAway(ux * length), y = roundHalfAway(uy * length);
  // At clean ratios, quantize the major-axis length first, then put the endpoint on that exact stepped slope.
  // Rounding both components independently would create a different slope (and uneven internal runs) on short bones.
  if (direction.snapped) {
    if (Math.abs(ux) >= Math.abs(uy)) y = roundHalfAway(x * direction.stepY / direction.stepX);
    else x = roundHalfAway(y * direction.stepX / direction.stepY);
  }
  return [x, y];
}
export const boneEnd = (length, angle, snap = true, flipX = false) => endOfBone(length, boneDirection(angle, snap), flipX);
const widthAt = (widths, t) => {
  if (widths.length === 2) return widths[0] + (widths[1] - widths[0]) * t;
  return t < .5 ? widths[0] + (widths[1] - widths[0]) * t * 2 : widths[1] + (widths[2] - widths[1]) * (t * 2 - 1);
};
// The same corner criterion as cleanupIds, applied in-place to a fresh part. No change objects or working copy are
// needed here; checking the second pixel of each arm is enough to know whether both arms are longer than one.
function cleanPartCorners(codes, mask, edge, spine, w, h, neutral, spans) {
  // All colour pixels sit inside an empty one-pixel border. Out-of-array reads two steps away are undefined,
  // which, just like cleanupIds' outside sentinel, cannot match a nonzero colour.
  const offsets = [-1, 1, -w, w];
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let y = 1; y < h - 1; y++) for (let i = y * w + spans[y * 2], end = y * w + spans[y * 2 + 1]; i <= end; i++) {
      const color = codes[i];
      if (!color || (!edge[i] && !(spine[i] && color === neutral))) continue;
      let count = 0, a = 0, b = 0;
      for (let side = 0; side < 4; side++) {
        const offset = offsets[side];
        if (codes[i + offset] !== color) continue;
        if (count++ === 0) a = offset; else b = offset;
      }
      if (count !== 2 || a === -b || codes[i + a + b] === color) continue;
      if (codes[i + a * 2] === color && codes[i + b * 2] === color) continue;
      const outside = codes[i - a];
      if (codes[i - b] !== outside || codes[i - a - b] !== outside) continue;
      codes[i] = outside;
      if (!outside) { mask[i] = 0; edge[i] = 0; }
      changed = true;
    }
    if (!changed) break;
  }
}
// Shade from the mask's exposed sides. Thin sections keep their base colour. Keeping the light in world coordinates
// makes highlights stay on the lit side as a part turns.
function finishPart(mask, w, h, left, top, { ramp, base, outline, light, thick, socket = () => false, spine = [], spans }) {
  const codes = new Uint32Array(mask.length), edge = new Uint8Array(mask.length);
  const lx = cosDeg(light), ly = sinDeg(light), neutral = ramp[base].charCodeAt(0);
  const line = outline === 'selective' ? ramp[0] : outline;
  const lineCode = line ? line.charCodeAt(0) : 0;
  const bright = ramp[Math.min(ramp.length - 1, base + 1)].charCodeAt(0), dark = ramp[Math.max(0, base - 1)].charCodeAt(0);
  if (!spans) {
    spans = new Int16Array(h * 2);
    for (let y = 0; y < h; y++) {
      let lo = w, hi = -1;
      for (let x = 0; x < w; x++) if (mask[y * w + x]) { lo = Math.min(lo, x); hi = x; }
      spans[y * 2] = lo; spans[y * 2 + 1] = hi;
    }
  }
  const painted = new Int16Array(h * 2);
  for (let y = 0; y < h; y++) {
    painted[y * 2] = Math.max(1, Math.min(spans[y * 2], spans[(y - 1) * 2] ?? w, spans[(y + 1) * 2] ?? w) - 1);
    painted[y * 2 + 1] = Math.min(w - 2, Math.max(spans[y * 2 + 1], spans[(y - 1) * 2 + 1] ?? -1, spans[(y + 1) * 2 + 1] ?? -1) + 1);
  }
  for (let y = 1; y < h - 1; y++) for (let x = painted[y * 2], end = painted[y * 2 + 1]; x <= end; x++) {
    const at = y * w + x;
    if (mask[at]) {
      codes[at] = neutral;
      if (thick === true || (thick && thick(left + x, top + y))) {
        // The analytic masks include a two-pixel empty border, so these neighbours cannot wrap into filled rows.
        const nx = (mask[at - 1] ? 1 : 0) - (mask[at + 1] ? 1 : 0);
        const ny = (mask[at - w] ? 1 : 0) - (mask[at + w] ? 1 : 0), facing = nx * lx + ny * ly;
        if (facing > 1e-9) codes[at] = bright; else if (facing < -1e-9) codes[at] = dark;
      }
    } else if (line && (mask[at - 1] || mask[at + 1] || mask[at - w] || mask[at + w])
      && !socket(left + x, top + y)) {
      codes[at] = lineCode; edge[at] = 1;
    }
  }
  const spineMask = new Uint8Array(mask.length);
  for (const [x, y] of spine) spineMask[(y - top) * w + x - left] = 1;
  // Keep the declared spine tips (including a one-pixel foot) during cleanup.
  cleanPartCorners(codes, mask, edge, spineMask, w, h, neutral, painted);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 1; y < h - 1; y++) for (let x = painted[y * 2], end = painted[y * 2 + 1]; x <= end; x++) if (codes[y * w + x]) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < 0) { x0 = y0 = x1 = y1 = 0; }
  // A clipped boundary band can leave a lone shade value surrounded by one other colour. Match De-Stray's
  // in-canvas rule on the final crop, preserving spine pixels and never touching the external outline.
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x;
    if (!mask[i] || spineMask[i]) continue;
    if ((x > x0 && codes[i - 1] === codes[i]) || (x < x1 && codes[i + 1] === codes[i])
      || (y > y0 && codes[i - w] === codes[i]) || (y < y1 && codes[i + w] === codes[i])) continue;
    let shared = -1, uniform = true;
    for (let ny = Math.max(y0, y - 1); ny <= Math.min(y1, y + 1) && uniform; ny++) {
      for (let nx = Math.max(x0, x - 1); nx <= Math.min(x1, x + 1); nx++) {
        if (nx === x && ny === y) continue;
        const color = codes[ny * w + nx];
        if (shared < 0) shared = color; else if (shared !== color) { uniform = false; break; }
      }
    }
    if (uniform && shared >= 0 && shared !== codes[i]) { codes[i] = shared; if (!shared) mask[i] = 0; }
  }
  const width = x1 - x0 + 1, height = y1 - y0 + 1, rows = [], fill = new Uint8Array(width * height), outlineMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const lo = Math.max(0, Math.min(width, painted[(y + y0) * 2] - x0));
    const hi = Math.min(width - 1, Math.max(lo - 1, painted[(y + y0) * 2 + 1] - x0));
    let row = '.'.repeat(lo);
    for (let x = lo; x <= hi; x++) {
      const from = (y + y0) * w + x + x0, to = y * width + x;
      row += codes[from] ? String.fromCharCode(codes[from]) : '.';
      fill[to] = mask[from]; outlineMask[to] = edge[from];
    }
    rows.push(row + '.'.repeat(width - hi - 1));
  }
  if (!line || outline === 'selective') {
    // Without a distinct outline the crop edge itself participates in cleanup; selective outlines can also
    // share a colour with the dark band. Use the public rule on that exact crop, including shaded spine pixels.
    const cropped = Uint32Array.from(rows.join(''), c => c === '.' ? 0 : c.charCodeAt(0));
    const keep = new Uint8Array(width * height);
    for (const [x, y] of spine) keep[(y - top - y0) * width + x - left - x0] = 1;
    for (let pass = 0; pass < 4; pass++) {
      const corners = cleanupIds(cropped, width, height, { corners: true, allowed: i => Boolean(outlineMask[i] || keep[i]) });
      for (const change of corners) { cropped[change.index] = change.id; if (!change.id) { fill[change.index] = 0; outlineMask[change.index] = 0; } }
      const strays = cleanupIds(cropped, width, height, { strays: true, allowed: i => Boolean(fill[i] && !keep[i]) });
      for (const change of strays) { cropped[change.index] = change.id; if (!change.id) fill[change.index] = 0; }
      if (!corners.length && !strays.length) break;
    }
    for (let y = 0; y < height; y++) rows[y] = Array.from(cropped.subarray(y * width, (y + 1) * width), c => c ? String.fromCharCode(c) : '.').join('');
  }
  return { rows, width, height, fill, outlineMask, pivot: [-left - x0, -top - y0] };
}

// Repeated compilations reuse immutable drawings; callers always own their arrays. Bound both entries and bytes
// so a long authoring session cannot accumulate every angle of every skeleton.
const boneDrawings = new Map();
let boneDrawingBytes = 0;
function copyBoneDrawing(part) {
  return { ...part, rows: part.rows.slice(), fill: part.fill.slice(), outlineMask: part.outlineMask.slice(),
    pivot: part.pivot.slice(), end: part.end.slice(), spine: part.spine.map(point => point.slice()) };
}
export function rasterizeBone(bone, options = {}) {
  const key = JSON.stringify([bone.length, bone.width, bone.base, bone.outline, bone.caps, bone.snap,
    options.angle ?? 0, options.flipX ?? false, options.light ?? 225, options.ramp]);
  let cached = boneDrawings.get(key);
  if (!cached) {
    const part = drawBone(bone, options), bytes = part.fill.byteLength + part.outlineMask.byteLength + part.width * part.height * 2 + part.spine.length * 16 + 512;
    while (boneDrawings.size && (boneDrawings.size >= 128 || boneDrawingBytes + bytes > 1048576)) {
      const first = boneDrawings.keys().next().value;
      boneDrawingBytes -= boneDrawings.get(first).bytes; boneDrawings.delete(first);
    }
    cached = { part, bytes }; boneDrawings.set(key, cached); boneDrawingBytes += bytes;
  }
  return copyBoneDrawing(cached.part);
}

function drawBone(bone, { angle = 0, flipX = false, light = 225, ramp } = {}) {
  const direction = boneDirection(angle, bone.snap !== false), sign = flipX ? -1 : 1;
  const ux = direction.x * sign, uy = direction.y * sign;
  const [endX, endY] = endOfBone(bone.length, direction, flipX);
  const distance = Math.sqrt(endX * endX + endY * endY), ax = endX / distance, ay = endY / distance;
  const widths = bone.width, radius = Math.max(...widths) / 2;
  const left = Math.floor(Math.min(0, endX) - radius) - 2, top = Math.floor(Math.min(0, endY) - radius) - 2;
  const right = Math.ceil(Math.max(0, endX) + radius) + 2, bottom = Math.ceil(Math.max(0, endY) + radius) + 2;
  const w = right - left + 1, h = bottom - top + 1, mask = new Uint8Array(w * h), spine = [];
  const spans = new Int16Array(h * 2);
  for (let y = 0; y < h; y++) { spans[y * 2] = w; spans[y * 2 + 1] = -1; }
  const put = (x, y) => {
    const row = (y - top) * 2, column = x - left;
    mask[(y - top) * w + column] = 1;
    if (column < spans[row]) spans[row] = column;
    if (column > spans[row + 1]) spans[row + 1] = column;
  };
  const caps = bone.caps ?? ['socket', 'round'], steps = Math.max(Math.abs(endX), Math.abs(endY));
  // Midpoint distribution yields runs differing by at most one, with no orthogonal elbow at a diagonal step.
  for (let i = 0; i <= steps; i++) {
    const majorX = Math.abs(endX) >= Math.abs(endY);
    const x = direction.snapped && !majorX ? roundHalfAway((endY < 0 ? -i : i) * direction.stepX / direction.stepY) : roundHalfAway(endX * i / steps);
    const y = direction.snapped && majorX ? roundHalfAway((endX < 0 ? -i : i) * direction.stepY / direction.stepX) : roundHalfAway(endY * i / steps);
    spine.push([x, y]); put(x, y);
  }
  const shadow = -uy * cosDeg(light) + ux * sinDeg(light) > 0 ? -1 : 1;
  const sx = Math.abs(uy) > Math.abs(ux) ? (uy > 0 ? -shadow : shadow) : 0;
  const sy = sx ? 0 : (ux > 0 ? shadow : -shadow);
  // Width two has a fixed shadow-side copy rather than alternating pixels on opposite sides.
  for (let i = 1; i + 1 < spine.length; i++) {
    const width = widthAt(widths, i / steps);
    if (width >= 1.5 && width < 3) put(spine[i][0] + sx, spine[i][1] + sy);
  }
  if (widths[0] >= 3 && widths.every(width => width === widths[0]) && caps.every(cap => cap === 'round' || cap === 'socket')) {
    // Constant-width round/socket capsules have one exact filled interval per row. Intersect the central
    // rectangle with the row, then union its two end discs; this avoids testing every interior pixel.
    const r = widths[0] / 2, r2 = r * r;
    for (let py = top; py <= bottom; py++) {
      let lo = -Infinity, hi = Infinity;
      for (const [coefficient, offset, minimum, maximum] of [[ax, py * ay, 0, distance], [-ay, py * ax, -r, r]]) {
        if (!coefficient) { if (offset < minimum || offset > maximum) { lo = Infinity; hi = -Infinity; } }
        else {
          const a = (minimum - offset) / coefficient, b = (maximum - offset) / coefficient;
          lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
        }
      }
      if (lo > hi) { lo = Infinity; hi = -Infinity; }
      for (const [cx, cy] of [[0, 0], [endX, endY]]) {
        const squared = r2 - (py - cy) * (py - cy);
        if (squared >= -1e-9) {
          const reach = Math.sqrt(Math.max(0, squared));
          lo = Math.min(lo, cx - reach); hi = Math.max(hi, cx + reach);
        }
      }
      const first = Math.ceil(lo - 1e-9) - left, last = Math.floor(hi + 1e-9) - left, row = py - top;
      if (first <= last) {
        mask.fill(1, row * w + first, row * w + last + 1);
        spans[row * 2] = Math.min(spans[row * 2], first); spans[row * 2 + 1] = Math.max(spans[row * 2 + 1], last);
      }
    }
  } else if (Math.max(...widths) >= 3) {
    for (let py = top; py <= bottom; py++) {
      // Every point in the capsule is within radius of the infinite axis. Clip the scanline to that strip.
      const cross = ay ? py * ax / ay : 0, reach = ay ? radius / Math.abs(ay) : 0;
      const first = ay ? Math.max(left, Math.ceil(cross - reach - 1e-9)) : left;
      const last = ay ? Math.min(right, Math.floor(cross + reach + 1e-9)) : right;
      for (let px = first; px <= last; px++) {
      const along = px * ax + py * ay, t = Math.max(0, Math.min(1, along / distance));
      const width = widthAt(widths, t);
      if (width < 3) continue;
      let r = width / 2;
      if (caps[0] === 'point') r *= Math.min(1, Math.max(0, along / (widths[0] / 2)));
      if (caps[1] === 'point') r *= Math.min(1, Math.max(0, (distance - along) / (widths[widths.length - 1] / 2)));
      if ((along < 0 && (caps[0] === 'flat' || caps[0] === 'point')) || (along > distance && (caps[1] === 'flat' || caps[1] === 'point'))) continue;
      const dx = px - endX * t, dy = py - endY * t;
      if (dx * dx + dy * dy <= r * r + 1e-9) put(px, py);
      }
    }
  }
  const socket = (x, y) => (caps[0] === 'socket' && x * x + y * y <= (widths[0] / 2 + 1) ** 2)
    || (caps[1] === 'socket' && (x - endX) ** 2 + (y - endY) ** 2 <= (widths[widths.length - 1] / 2 + 1) ** 2);
  const result = finishPart(mask, w, h, left, top, {
    ramp, base: bone.base, outline: bone.outline, light, socket, spine, spans,
    thick: Math.min(...widths) >= 3 ? true : Math.max(...widths) < 3 ? false
      : (x, y) => widthAt(widths, Math.max(0, Math.min(1, (x * ax + y * ay) / distance))) >= 3
  });
  const [ox, oy] = result.pivot, length = bone.length;
  return {
    ...result, snapped: direction.snapped, end: [ox + endX, oy + endY], work: w * h,
    spine: spine.map(([x, y]) => [x + ox, y + oy]),
    map: ([along, across]) => [ox + roundHalfAway(endX * along / length - ay * sign * across), oy + roundHalfAway(endY * along / length + ax * sign * across)]
  };
}

// Masses are cached like bones. `work` is the drawing's nominal cost in pixels visited, the same whether it was drawn
// now or served from the cache, so a compiler budget built on it accepts or rejects a source the same way every time.
const massDrawings = new Map();
let massDrawingBytes = 0;
const massMap = ({ pivot: [ox, oy], flipX, squash, cos, sin }) => ([x, y]) => {
  const along = (flipX ? -x : x) / squash, across = y * squash;
  return [ox + roundHalfAway(along * cos - across * sin), oy + roundHalfAway(along * sin + across * cos)];
};
export function rasterizeMass(mass, options = {}) {
  const key = JSON.stringify([mass.size, mass.base, mass.outline, options.angle ?? 0, options.flipX ?? false, options.squash ?? 1, options.light ?? 225, options.ramp]);
  let cached = massDrawings.get(key);
  if (!cached) {
    const part = drawMass(mass, options), bytes = part.fill.byteLength + part.outlineMask.byteLength + part.width * part.height * 2 + 512;
    while (massDrawings.size && (massDrawings.size >= 128 || massDrawingBytes + bytes > 1048576)) {
      const first = massDrawings.keys().next().value;
      massDrawingBytes -= massDrawings.get(first).bytes; massDrawings.delete(first);
    }
    cached = { part, bytes }; massDrawings.set(key, cached); massDrawingBytes += bytes;
  }
  const part = cached.part, copy = { ...part, rows: part.rows.slice(), fill: part.fill.slice(), outlineMask: part.outlineMask.slice(), pivot: part.pivot.slice() };
  return { ...copy, map: massMap(copy) };
}
function drawMass(mass, { angle = 0, flipX = false, squash = 1, light = 225, ramp } = {}) {
  const [cos, sin] = unitAt(angle), rx = mass.size[0] / squash / 2, ry = mass.size[1] * squash / 2;
  const reachX = Math.ceil(Math.sqrt(rx * rx * cos * cos + ry * ry * sin * sin)) + 2;
  const reachY = Math.ceil(Math.sqrt(rx * rx * sin * sin + ry * ry * cos * cos)) + 2;
  const left = -reachX, top = -reachY, w = reachX * 2 + 1, h = reachY * 2 + 1, candidates = [];
  for (let y = -reachY + 2; y <= reachY - 2; y++) for (let x = -reachX + 2; x <= reachX - 2; x++) {
    const u = (x * cos + y * sin) / rx, v = (-x * sin + y * cos) / ry;
    candidates.push({ at: (y - top) * w + x - left, score: u * u + v * v, u: flipX ? -u : u, v });
  }
  candidates.sort((a, b) => a.score - b.score || a.v - b.v || a.u - b.u);
  let work = candidates.length;
  const paint = (mask, width, height, x, y, thick) => { work += width * height; return finishPart(mask, width, height, x, y,
    { ramp, base: mass.base, outline: mass.outline, light, thick }); };
  const area = part => part.rows.reduce((sum, row) => sum + [...row].filter(c => c !== '.').length, 0);
  // Pixel area, including the outline, takes precedence over an exact ellipse under squash (owner decision).
  // Use the unturned, unsquashed ellipse as the area target. Pick the closest ellipse-ranked pixel contour rather
  // than rounding two diameters independently; this also keeps 2px masses stable at extreme squash.
  const bx = Math.ceil(mass.size[0] / 2) + 2, by = Math.ceil(mass.size[1] / 2) + 2, bw = bx * 2 + 1, bh = by * 2 + 1;
  const baseMask = new Uint8Array(bw * bh);
  for (let y = -by; y <= by; y++) for (let x = -bx; x <= bx; x++) {
    const u = x * 2 / mass.size[0], v = y * 2 / mass.size[1];
    if (u * u + v * v <= 1 + 1e-9) baseMask[(y + by) * bw + x + bx] = 1;
  }
  const target = area(paint(baseMask, bw, bh, -bx, -by, Math.min(...mass.size) >= 3));
  const draw = count => {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < count; i++) mask[candidates[i].at] = 1;
    return paint(mask, w, h, left, top, Math.min(rx, ry) >= 1.5);
  };
  let low = 1, high = Math.min(candidates.length, target), result = null, error = Infinity, closest = 1;
  const consider = count => {
    const part = draw(count), pixels = area(part), miss = Math.abs(pixels - target);
    if (miss < error) { result = part; error = miss; closest = count; }
    return pixels;
  };
  while (low <= high) {
    const count = (low + high) >> 1, pixels = consider(count);
    if (pixels === target) break;
    if (pixels < target) low = count + 1; else high = count - 1;
  }
  if (error) for (let count = Math.max(1, closest - 2), end = Math.min(candidates.length, closest + 2); count <= end; count++) consider(count);
  return { ...result, targetArea: target, work, flipX, squash, cos, sin };
}

// ---- Rewrite rules -----------------------------------------------------------------------------------------------
// A compiled rule is { w, h, match, replace } with colour ids; match -1 matches anything and replace -1 keeps the
// pixel. Variants add the 90° turns and/or the horizontal mirror, without duplicates.
export function ruleVariants(rule, { rotate = false, mirror = false } = {}) {
  const turn = g => {
    const next = { w: g.h, h: g.w, match: new Array(g.w * g.h), replace: new Array(g.w * g.h) };
    for (let y = 0; y < next.h; y++) for (let x = 0; x < next.w; x++) {
      const from = (g.h - 1 - x) * g.w + y; // clockwise: new (x, y) reads old (y, h - 1 - x)
      next.match[y * next.w + x] = g.match[from]; next.replace[y * next.w + x] = g.replace[from];
    }
    return next;
  };
  const flip = g => {
    const next = { w: g.w, h: g.h, match: new Array(g.w * g.h), replace: new Array(g.w * g.h) };
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) { next.match[y * g.w + x] = g.match[y * g.w + g.w - 1 - x]; next.replace[y * g.w + x] = g.replace[y * g.w + g.w - 1 - x]; }
    return next;
  };
  let variants = [rule];
  if (mirror) variants.push(flip(rule));
  if (rotate) variants = variants.flatMap(g => { const a = turn(g), b = turn(a); return [g, a, b, turn(b)]; });
  const seen = new Set();
  return variants.filter(g => { const key = JSON.stringify(g); if (seen.has(key)) return false; seen.add(key); return true; });
}
// Markov-style rewriting (after Pixel Composer's Markov node and MarkovJunior). Each step applies every rule in order.
// A rule's matches are found on the pixels as they were when the rule started, ordered by a seeded hash, and applied
// unless they read or write a cell this rule already rewrote in this step (so two overlapping fixes never both apply),
// fail their seeded chance, or exceed the limit. Matches whose replacement is already in place change nothing and
// count toward nothing. Stops early when a step changes nothing. Updates `ids` in place and returns the changed indices.
// Each match is one 64-bit number, its seeded key above its position and variant, so a plain numeric sort gives the
// order (key, then top, left and variant) at 8 bytes a match; an object per match took about 1.9 GB on a 2048×2048 still.
const KEY_WORD = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1 ? 1 : 0; // the high 32 bits, by the platform's byte order
export function rewriteIds(ids, width, height, rules, { x = 0, y = 0, w = width, h = height, steps = 1, chance = 1, limit = Infinity, seed = 0, spend = () => {} } = {}) {
  const changed = new Set(), snapshot = new Uint32Array(ids.length), written = new Uint8Array(width * height);
  let matches = new BigUint64Array(0), words = new Uint32Array(0);
  for (let step = 0; step < steps; step++) {
    let effective = 0;
    rules.forEach((variants, rule) => {
      const kinds = variants.length, most = variants.reduce((sum, v) => sum + Math.max(0, w - v.w + 1) * Math.max(0, h - v.h + 1), 0);
      // The position and variant share the low 32 bits (a recipe canvas holds at most 4,194,304 pixels, a rule 8 variants).
      if (width * height * kinds > 4294967296) throw new RangeError(`rewriteIds: ${width}×${height} pixels × ${kinds} variants do not fit 32 bits`);
      let found = 0;
      snapshot.set(ids); written.fill(0);
      variants.forEach((v, variant) => {
        spend(Math.max(0, w - v.w + 1) * Math.max(0, h - v.h + 1) * v.w * v.h);
        for (let top = y; top + v.h <= y + h; top++) for (let left = x; left + v.w <= x + w; left++) {
          let ok = true;
          for (let j = 0; j < v.h && ok; j++) for (let i = 0; i < v.w; i++) {
            const want = v.match[j * v.w + i];
            if (want >= 0 && snapshot[(top + j) * width + left + i] !== want) { ok = false; break; }
          }
          if (!ok) continue;
          if (found === matches.length) {
            const grown = new BigUint64Array(Math.min(most, Math.max(1024, found * 2)));
            grown.set(matches); matches = grown; words = new Uint32Array(grown.buffer);
          }
          words[2 * found + KEY_WORD] = hash(seed, step, rule, variant, left, top);
          words[2 * found + 1 - KEY_WORD] = (top * width + left) * kinds + variant;
          found++;
        }
      });
      matches.subarray(0, found).sort();
      let count = 0;
      for (let n = 0; n < found; n++) {
        if (count >= limit) break;
        const low = words[2 * n + 1 - KEY_WORD], variant = low % kinds, cell = (low - variant) / kinds, top = Math.floor(cell / width), left = cell - top * width;
        if (chance < 1 && random(seed, step, rule, variant, left, top, 1) >= chance) continue;
        const v = variants[variant];
        let clash = false, alters = false;
        for (let j = 0; j < v.h && !clash; j++) for (let i = 0; i < v.w; i++) {
          const k = j * v.w + i, at = (top + j) * width + left + i;
          if ((v.match[k] >= 0 || v.replace[k] >= 0) && written[at]) { clash = true; break; }
          if (v.replace[k] >= 0 && ids[at] !== v.replace[k]) alters = true;
        }
        if (clash || !alters) continue;
        for (let j = 0; j < v.h; j++) for (let i = 0; i < v.w; i++) {
          const k = j * v.w + i, at = (top + j) * width + left + i;
          if (v.replace[k] < 0) continue;
          written[at] = 1;
          if (ids[at] !== v.replace[k]) { ids[at] = v.replace[k]; changed.add(at); effective++; }
        }
        count++;
      }
    });
    if (!effective) break;
  }
  return changed;
}
