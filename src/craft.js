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
export function rewriteIds(ids, width, height, rules, { x = 0, y = 0, w = width, h = height, steps = 1, chance = 1, limit = Infinity, seed = 0, spend = () => {} } = {}) {
  const changed = new Set(), snapshot = new Uint32Array(ids.length), written = new Uint8Array(width * height);
  for (let step = 0; step < steps; step++) {
    let effective = 0;
    rules.forEach((variants, rule) => {
      const candidates = [];
      snapshot.set(ids); written.fill(0);
      variants.forEach((v, variant) => {
        spend(Math.max(0, w - v.w + 1) * Math.max(0, h - v.h + 1) * v.w * v.h);
        for (let top = y; top + v.h <= y + h; top++) for (let left = x; left + v.w <= x + w; left++) {
          let ok = true;
          for (let j = 0; j < v.h && ok; j++) for (let i = 0; i < v.w; i++) {
            const want = v.match[j * v.w + i];
            if (want >= 0 && snapshot[(top + j) * width + left + i] !== want) { ok = false; break; }
          }
          if (ok) candidates.push({ left, top, variant, v, key: hash(seed, step, rule, variant, left, top) });
        }
      });
      candidates.sort((a, b) => a.key - b.key || a.top - b.top || a.left - b.left || a.variant - b.variant);
      let count = 0;
      for (const c of candidates) {
        if (count >= limit) break;
        if (chance < 1 && random(seed, step, rule, c.variant, c.left, c.top, 1) >= chance) continue;
        const { v } = c;
        let clash = false, alters = false;
        for (let j = 0; j < v.h && !clash; j++) for (let i = 0; i < v.w; i++) {
          const k = j * v.w + i, at = (c.top + j) * width + c.left + i;
          if ((v.match[k] >= 0 || v.replace[k] >= 0) && written[at]) { clash = true; break; }
          if (v.replace[k] >= 0 && ids[at] !== v.replace[k]) alters = true;
        }
        if (clash || !alters) continue;
        for (let j = 0; j < v.h; j++) for (let i = 0; i < v.w; i++) {
          const k = j * v.w + i, at = (c.top + j) * width + c.left + i;
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
