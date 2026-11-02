// Browser-compatible autotile template generation and review for the autotile compiler (src/authoring.js): a terrain
// description drawn into a template two tiles wide and three tall, the seam check that compares every quarter join a
// map can make with the way the template itself continues, and a test map that shows every tile of a set. Seeded
// hashing and + − × ÷ only, as in craft.js, so a description always draws the same pixels. No I/O.
import { PixelError } from './core.js';
import { hash, random } from './craft.js';
import { tilePieces, templatePiece, neighbourMask } from './autotile.js';
import { slopeLegend, SLOPE_MAP } from './slopes.js';

const fail = (path, message) => { throw new PixelError(path, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, keys, path) {
  if (!isObject(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key) || value[key] === null) fail(`${path}.${key}`, `unknown or null field; use ${keys.join(', ')}`);
}
const whole = (value, path, low, high) => {
  if (!Number.isInteger(value) || value < low || value > high) fail(path, `expected a whole number from ${low} to ${high}`);
  return value;
};
const share = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(path, 'expected a number from 0 to 1');
  return value;
};
// Template rows hold one character per pixel, so every colour a terrain draws is a one-character palette key.
const paletteKey = (value, path, palette) => {
  if (typeof value !== 'string' || value.length !== 1 || value === '.' || value === ' ') fail(path, 'expected a one-character palette key');
  if (!Object.hasOwn(palette, value)) fail(path, `${JSON.stringify(value)} is not in the palette`);
  return value;
};
const paletteKeys = (value, path, palette, low, high) => {
  if (!Array.isArray(value) || value.length < low || value.length > high) fail(path, `expected ${low}–${high} one-character palette keys`);
  return value.map((key, i) => paletteKey(key, `${path}[${i}]`, palette));
};

// Objects merge key by key and anything else replaces, so a variant's `terrain` names only what it changes.
export function mergeTerrain(base, change) {
  if (!isObject(base) || !isObject(change)) return change;
  const out = { ...base };
  for (const [key, value] of Object.entries(change)) out[key] = mergeTerrain(base[key], value);
  return out;
}
// A fill given as one key is a fill of that colour, so a variant can change only its seed or speckle.
export const normalTerrain = terrain => (isObject(terrain) && typeof terrain.fill === 'string' ? { ...terrain, fill: { color: terrain.fill } } : terrain);

// ---- Reading a terrain -------------------------------------------------------------------------------------------
// Sides: n (top), e (right), s (bottom), w (left). DIR points out of the terrain through that side.
const SIDES = ['n', 'e', 's', 'w'];
const DIR = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
// A pixel as near one side as another takes the top or bottom edge's colour first, then the left, then the right.
const ORDER = ['n', 's', 'w', 'e'];
const SIDE_FIELDS = ['depth', 'jitter', 'size', 'bands', 'outside', 'tufts'];

// Smooth seeded noise that repeats every `period` pixels: lattice values `period / cells` apart, blended with
// smoothstep weights, with lattice indices taken modulo the cell count.
function periodicNoise(seed, salt, period, cells, x, y = null) {
  const at = (i, j) => hash(seed, salt, ((i % cells) + cells) % cells, j === null ? 0 : ((j % cells) + cells) % cells) / 4294967296;
  const smooth = t => t * t * (3 - 2 * t);
  const fx = (x + 0.5) * cells / period, ix = Math.floor(fx), u = smooth(fx - ix);
  if (y === null) return at(ix, null) * (1 - u) + at(ix + 1, null) * u;
  const fy = (y + 0.5) * cells / period, iy = Math.floor(fy), v = smooth(fy - iy);
  return (at(ix, iy) * (1 - u) + at(ix + 1, iy) * u) * (1 - v) + (at(ix, iy + 1) * (1 - u) + at(ix + 1, iy + 1) * u) * v;
}
const cellsFor = (period, size) => Math.max(1, Math.round(period / size));

// The fill texture: tile × tile keys that repeat across the whole terrain, a colour with seeded clumps of others over
// it, or rows given outright. Each speckle layer colours exactly its `amount` of the tile: the pixels where its smooth
// noise is lowest, so clumps are about `size` pixels across.
function readFill(fill, { tile, palette, path, seed }) {
  if (typeof fill === 'string') fill = { color: fill };
  fields(fill, ['color', 'pattern', 'speckle', 'seed'], path);
  if ((fill.color === undefined) === (fill.pattern === undefined)) fail(path, 'give a color, or a pattern of rows that repeats every tile');
  const fillSeed = whole(fill.seed ?? seed, `${path}.seed`, 0, 2147483647);
  if (fill.pattern !== undefined) {
    const rows = fill.pattern, pp = `${path}.pattern`;
    if (!Array.isArray(rows) || rows.length !== tile || rows.some(row => typeof row !== 'string' || row.length !== tile)) fail(pp, `expected ${tile} rows of ${tile} characters: one tile, repeated across the terrain`);
    rows.forEach((row, y) => [...row].forEach((char, x) => { if (char !== '.' && !Object.hasOwn(palette, char)) fail(`${pp}[${y}]`, `${JSON.stringify(char)} at column ${x} is not in the palette`); }));
    if (fill.speckle !== undefined) fail(`${path}.speckle`, 'speckle goes with color; draw a pattern\'s detail into its rows');
    return rows.map(row => [...row]);
  }
  const base = paletteKey(fill.color, `${path}.color`, palette);
  const grid = Array.from({ length: tile }, () => Array(tile).fill(base));
  const layers = fill.speckle ?? [];
  if (!Array.isArray(layers) || layers.length > 8) fail(`${path}.speckle`, 'expected up to 8 speckle layers');
  layers.forEach((layer, i) => {
    const lp = `${path}.speckle[${i}]`;
    fields(layer, ['color', 'amount', 'size', 'seed'], lp);
    const color = paletteKey(layer.color, `${lp}.color`, palette), amount = share(layer.amount, `${lp}.amount`);
    const size = whole(layer.size ?? Math.min(4, tile), `${lp}.size`, 1, tile), salt = whole(layer.seed ?? i, `${lp}.seed`, 0, 2147483647);
    const big = cellsFor(tile, size), small = cellsFor(tile, Math.max(1, size / 2));
    const values = [];
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) values.push({ x, y, value: periodicNoise(fillSeed, 0x51ec + salt, tile, big, x, y) * 0.7 + periodicNoise(fillSeed, 0x7e11 + salt, tile, small, x, y) * 0.3 });
    values.sort((a, b) => a.value - b.value || a.y - b.y || a.x - b.x);
    const count = Math.round(amount * tile * tile);
    for (let k = 0; k < count; k++) grid[values[k].y][values[k].x] = color;
  });
  return grid;
}

// One side's edge. `depth` is how far in from the tile's border the terrain starts (its margin holds `outside`
// colours and tufts), `jitter` lets it wander up to that many pixels further in, `bands` colour the terrain from the
// edge inward (an outline, a rim light, a shadow), `outside` colours the margin from the edge outward (a cast shadow)
// and `tufts` grow seeded blades of 1 to colors.length pixels from it.
function readSide(spec, { tile, palette, path, seed, side, round }) {
  const q = tile / 2;
  const field = key => (Object.hasOwn(spec.own, key) ? `${path}.${side}.${key}` : `${path}.all.${key}`);
  const value = { ...spec.all, ...spec.own };
  const depth = whole(value.depth ?? 0, field('depth'), 0, q - 1), jitter = whole(value.jitter ?? 0, field('jitter'), 0, q - 1);
  const size = whole(value.size ?? Math.min(4, tile), field('size'), 1, tile);
  const bands = value.bands === undefined ? [] : paletteKeys(value.bands, field('bands'), palette, 0, q);
  const outside = value.outside === undefined ? [] : paletteKeys(value.outside, field('outside'), palette, 0, q);
  let tufts = null;
  if (value.tufts !== undefined) {
    const tp = field('tufts');
    fields(value.tufts, ['colors', 'amount', 'seed'], tp);
    tufts = { colors: paletteKeys(value.tufts.colors, `${tp}.colors`, palette, 1, q), amount: share(value.tufts.amount ?? 0.5, `${tp}.amount`), seed: whole(value.tufts.seed ?? 0, `${tp}.seed`, 0, 2147483647) };
  }
  // Everything an edge does to the terrain stays in the half of the tile beside it: that half is all a tile's quarter
  // knows, so a quarter drawn there fits every tile it is stitched into.
  const need = depth + jitter + bands.length + round;
  // Values a side takes from `all` say so, since the side's own entry may not mention them.
  const from = key => (!Object.hasOwn(spec.own, key) && Object.hasOwn(spec.all, key) && Object.hasOwn(spec.root, side) ? ' (from edges.all)' : '');
  if (need > q) fail(Object.hasOwn(spec.root, side) ? `${path}.${side}` : `${path}.all`, `depth ${depth}${from('depth')} + jitter ${jitter}${from('jitter')} + ${bands.length} band${bands.length === 1 ? '' : 's'}${from('bands')} + round ${round} is ${need} pixels, but an edge has to fit in half a tile (${q} pixels); use less, or a larger tile`);
  const index = SIDES.indexOf(side), cells = cellsFor(tile, size);
  const profile = Array.from({ length: tile }, (_, t) => depth + Math.min(jitter, Math.floor(periodicNoise(seed, 0xed6e + index, tile, cells, t) * (jitter + 1))));
  const blades = tufts && Array.from({ length: tile }, (_, t) => (random(seed, 0x7f75 + index, tufts.seed, t) < tufts.amount ? 1 + Math.floor(random(seed, 0x7f76 + index, tufts.seed, t) * tufts.colors.length) : 0));
  return { profile, bands, outside, tufts: tufts && tufts.colors, blades };
}

export function readTerrain(terrain, { tile, palette, path = 'terrain' }) {
  fields(terrain, ['seed', 'fill', 'edges', 'round', 'inner'], path);
  const q = tile / 2, seed = whole(terrain.seed ?? 0, `${path}.seed`, 0, 2147483647);
  if (terrain.fill === undefined) fail(`${path}.fill`, 'give the fill: a palette key, or { color, speckle } or { pattern }');
  const fill = readFill(terrain.fill, { tile, palette, path: `${path}.fill`, seed });
  const round = whole(terrain.round ?? 0, `${path}.round`, 0, q), inner = whole(terrain.inner ?? 0, `${path}.inner`, 0, q);
  const edges = terrain.edges ?? {};
  fields(edges, ['all', ...SIDES], `${path}.edges`);
  for (const [key, spec] of Object.entries(edges)) fields(spec, SIDE_FIELDS, `${path}.edges.${key}`);
  const sides = Object.fromEntries(SIDES.map(side => [side, readSide({ all: edges.all ?? {}, own: edges[side] ?? {}, root: edges }, { tile, palette, path: `${path}.edges`, seed, side, round })]));
  return { tile, fill, sides, round, inner };
}

// ---- Drawing a terrain -------------------------------------------------------------------------------------------
// A rounded corner drops the pixels outside a circle of radius r touching both edges, so r = 2 cuts an L of three.
const cut = (u, v, r) => u < r && v < r && (2 * r - 2 * u - 1) ** 2 + (2 * r - 2 * v - 1) ** 2 > (2 * r - 1) ** 2;

// The terrain over a small map of cells (rows of '#' and '.'), one key or '.' per pixel. A pixel's place depends only
// on its own cell, the three neighbours beside its quarter of the tile and its position within the tile, which is what
// lets the autotile compiler cut tiles into quarters and stitch them back together without a seam.
export function drawTerrain(spec, map, mode = 'blob') {
  const { tile, fill, sides, round, inner } = spec, q = tile / 2, columns = map[0].length, width = columns * tile, height = map.length * tile;
  const filled = (cx, cy) => cy >= 0 && cy < map.length && cx >= 0 && cx < columns && map[cy][cx] === '#';
  // A pixel's place in its quarter of the tile: the sides beside it (across: w or e, upDown: n or s), its distance
  // from each (ax, ay), whether they are open, whether it sits in an inner corner, and the edges' depths there.
  const place = (x, y) => {
    const cx = Math.floor(x / tile), cy = Math.floor(y / tile), lx = x - cx * tile, ly = y - cy * tile, west = lx < q, north = ly < q;
    const across = west ? 'w' : 'e', upDown = north ? 'n' : 's', hx = cx + (west ? -1 : 1), vy = cy + (north ? -1 : 1);
    const openH = !filled(hx, cy), openV = !filled(cx, vy), corner = mode === 'blob' && !openH && !openV && !filled(hx, vy);
    return { cx, cy, lx, ly, across, upDown, ax: west ? lx : tile - 1 - lx, ay: north ? ly : tile - 1 - ly, openH, openV, corner, dH: sides[across].profile[ly], dV: sides[upDown].profile[lx] };
  };
  const member = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!filled(Math.floor(x / tile), Math.floor(y / tile))) continue;
    const { ax, ay, openH, openV, corner, dH, dV } = place(x, y);
    let inside;
    if (openH && openV) inside = ax >= dH && ay >= dV && !cut(ax - dH, ay - dV, round);
    else if (openV) inside = ay >= dV;
    else if (openH) inside = ax >= dH;
    // An inner corner: the empty diagonal's notch, as far in as the neighbours' edges beside it. Rounding never fills
    // the notch's pixels on the tile border, where it meets the neighbours' margins.
    else if (corner) inside = !(ax < dH && ay < dV && !(ax > 0 && ay > 0 && cut(dH - 1 - ax, dV - 1 - ay, inner)));
    else inside = true;
    member[y * width + x] = inside ? 1 : 0;
  }
  const inAt = (x, y) => x >= 0 && y >= 0 && x < width && y < height && member[y * width + x] === 1;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(x / tile), cy = Math.floor(y / tile), lx = x - cx * tile, ly = y - cy * tile;
      let best = null;
      if (inAt(x, y)) {
        // Inside: the band of the nearest edge straight up, down or across, or the fill. A band looks no further than
        // its own cell into a neighbouring terrain cell: near the border that cell's shape depends on a diagonal its
        // quarter's tile does not record (a cell left of the one below an open side), so a band seen there would be
        // drawn in some maps and not in the template.
        for (const side of ORDER) {
          const { bands } = sides[side], [dx, dy] = DIR[side];
          for (let k = 1; k <= bands.length && (!best || k < best.k); k++) {
            const tx = x + dx * k, ty = y + dy * k, nx = Math.floor(tx / tile), ny = Math.floor(ty / tile);
            if ((nx !== cx || ny !== cy) && filled(nx, ny)) break;
            if (!inAt(tx, ty)) { best = { k, key: bands[k - 1] }; break; }
          }
        }
        row += best ? best.key : fill[ly][lx];
        continue;
      }
      if (!filled(cx, cy)) { row += '.'; continue; }
      // Outside, in a terrain cell's margin: the nearest edge's outside colours and tufts, looking back toward the
      // terrain without leaving the half of the tile that side owns.
      const at = place(x, y);
      for (const side of ORDER) {
        const { outside, tufts, blades } = sides[side];
        const blade = blades ? blades[side === 'n' || side === 's' ? lx : ly] : 0, reach = Math.max(outside.length, blade);
        if (!reach) continue;
        // A side decorates only its own margin, where its edge is open or turns an inner corner (so a wall's jitter
        // grows no grass), and stops short of the tile border, so in an inner corner it never touches a neighbour's
        // empty margin.
        // At an outer corner, only beside the terrain itself: no root hangs past the end of a wall.
        const upDown = side === at.upDown, margin = upDown ? at.ay < at.dV && at.ay > 0 : at.ax < at.dH && at.ax > 0;
        if ((!upDown && side !== at.across) || !margin || !((upDown ? at.openV : at.openH) || at.corner)) continue;
        if (at.openH && at.openV && (upDown ? at.ax < at.dH : at.ay < at.dV)) continue;
        const [dx, dy] = DIR[side];
        for (let k = 1; k <= reach && (!best || k < best.k); k++) {
          const tx = lx - dx * k, ty = ly - dy * k;
          if (tx < 0 || ty < 0 || tx >= tile || ty >= tile || { n: ty >= q, s: ty < q, w: tx >= q, e: tx < q }[side]) break;
          if (inAt(cx * tile + tx, cy * tile + ty)) {
            const key = k <= blade ? tufts[k - 1] : k <= outside.length ? outside[k - 1] : null;
            if (key) best = { k, key };
            break;
          }
        }
      }
      row += best ? best.key : '.';
    }
    rows.push(row);
  }
  return rows;
}

// The template two tiles wide and three tall: a lone tile as the preview, the inner-corner tile (a cell whose four
// sides are terrain and four diagonals empty) and the 2×2 island. Each comes from drawing that little map, so its
// quarters are exactly what those cells look like anywhere. A corner set turns inner corners as a blob set does.
export function terrainTemplate(terrain, { tile, palette, mode: setMode = 'blob', path = 'terrain' }) {
  const spec = readTerrain(terrain, { tile, palette, path }), mode = setMode === 'cardinal' ? 'cardinal' : 'blob';
  const crop = (rows, x, y) => rows.slice(y, y + tile).map(row => row.slice(x, x + tile));
  const lone = drawTerrain(spec, ['...', '.#.', '...'], mode), cross = drawTerrain(spec, ['.#.', '###', '.#.'], mode);
  const island = drawTerrain(spec, ['....', '.##.', '.##.', '....'], mode);
  const top = crop(lone, tile, tile).map((row, y) => row + crop(cross, tile, tile)[y]);
  return [...top, ...island.slice(tile, tile * 3).map(row => row.slice(tile, tile * 3))];
}

// ---- Seams -------------------------------------------------------------------------------------------------------
// A tile is stitched from template quarters that are not neighbours in the template: the top edge of a tile is the
// island's top-right quarter-tile followed by its top-left one, and the fill tile is the island's centre with its
// quarters swapped. A join looks drawn only where the template continues the same way, so a template must repeat
// every tile width. JOINS lists every pair of quarters that cells of some map put side by side (within a tile or
// across two), in the order they meet, with the masks of the tiles they appear in (the first cell's).
// Joins are found once on a 4-pixel template (2-pixel quarters) and scaled to the real tile.
const SMALL = 4;
function findJoins(mode) {
  const found = new Map();
  const add = (axis, first, second, across, mask) => {
    if (!first || !second) return;
    const key = `${axis}:${first.join(',')}|${second.join(',')}|${across}`;
    if (!found.has(key)) found.set(key, { axis, first, second, across, masks: new Set() });
    found.get(key).masks.add(mask);
  };
  // A window of 4×3 cells (3×4 for joins down the page) holds every neighbour the examined joins depend on: those
  // inside cell (1, 1), and those between it and the cell after it. A corner tile depends on the four cells around
  // it, so 3×2 cells hold the tile on the top-left corner of cell (1, 1) and the one after it.
  const corner = mode === 'corner', [across, down] = corner ? [3, 2] : [4, 3];
  for (const axis of ['x', 'y']) for (let bits = 0; bits < 1 << (across * down); bits++) {
    const filled = (cx, cy) => { const [i, j] = axis === 'x' ? [cx, cy] : [cy, cx]; return i >= 0 && i < across && j >= 0 && j < down && ((bits >> (j * across + i)) & 1) === 1; };
    if (!corner && !filled(1, 1)) continue;
    const maskOf = (cx, cy) => neighbourMask(mode, (dx, dy) => filled(cx + dx, cy + dy));
    // A quarter's template corner, or null for one that draws nothing.
    const source = (cx, cy, quarter) => { const piece = tilePieces(mode, maskOf(cx, cy))[quarter]; return piece && templatePiece(SMALL, piece.from, piece.piece); };
    const mask = maskOf(1, 1), next = axis === 'x' ? [2, 1] : [1, 2];
    const pairs = axis === 'x' ? { within: [['tl', 'tr'], ['bl', 'br']], between: [['tr', 'tl'], ['br', 'bl']] } : { within: [['tl', 'bl'], ['tr', 'br']], between: [['bl', 'tl'], ['br', 'tr']] };
    for (const [first, second] of pairs.within) add(axis, source(1, 1, first), source(1, 1, second), false, mask);
    if (corner || filled(...next)) for (const [first, second] of pairs.between) add(axis, source(1, 1, first), source(...next, second), true, mask);
  }
  return [...found.values()].map(join => ({ ...join, masks: [...join.masks].sort((a, b) => a - b) }));
}
const BLOB_JOINS = findJoins('blob'), joinKey = join => `${join.axis}:${join.first}|${join.second}|${join.across}`;
const blobKeys = new Set(BLOB_JOINS.map(joinKey));
// A cardinal set has no inner-corner tiles, so some of its joins put a fill quarter beside an edge quarter where a
// blob set would turn the corner. Those joins (`corner`) can only be seamless when the edges run to the tile border.
// A corner set's tiles are a blob set's quarters, moved: its joins are the blob joins, with corner masks.
export const JOINS = { blob: BLOB_JOINS, cardinal: findJoins('cardinal').map(join => ({ ...join, corner: !blobKeys.has(joinKey(join)) })), corner: findJoins('corner') };

// The quarter that naturally lies on one side of the quarter at [x, y] (its top-left), as the template continues. In
// the island the next quarter over, which repeats every tile (so past the island's right edge comes its middle). The
// inner-corner tile is a cell whose four sides are terrain and four corners are not, so beyond it lie its neighbours'
// edge quarters: right of its top-right quarter, the top edge of the cell to its right, and so on. Those neighbours
// are not next to it in the template, so they are `assumed`: a join is judged from the other side.
const CROSS = { right: { 0: ['tl', 'h'], 1: ['bl', 'h'] }, left: { 0: ['tr', 'h'], 1: ['br', 'h'] }, down: { 0: ['tl', 'v'], 1: ['tr', 'v'] }, up: { 0: ['bl', 'v'], 1: ['br', 'v'] } };
function beside([x, y], side, tile) {
  const q = tile / 2, [dx, dy] = { right: [q, 0], left: [-q, 0], down: [0, q], up: [0, -q] }[side];
  if (y < tile) {
    const across = (x - tile) / q, along = y / q, inside = { right: across === 0, left: across === 1, down: along === 0, up: along === 1 }[side];
    if (inside) return { at: [x + dx, y + dy], assumed: false };
    const [position, piece] = CROSS[side][side === 'right' || side === 'left' ? along : across];
    return { at: templatePiece(tile, position, piece), assumed: true };
  }
  const nx = x + dx, ny = y + dy;
  return { at: [nx < 0 ? nx + tile : nx >= tile * 2 ? nx - tile : nx, ny < tile ? ny + tile : ny >= tile * 3 ? ny - tile : ny], assumed: false };
}

// Compares every join a map can make with the template's own continuation. `templates` maps symbol names to rows (a
// set and its redrawn variants, whose tiles mix in a map; joins between tiles compare every pair). A pixel pair across
// a join is a seam when neither side continues the template: the pixel after the join is not the one the template
// has after the first quarter, and the pixel before it is not the one the template has before the second. A seam is
// `shape` when the pair also disagrees about which pixels are clear (a broken outline or edge), `texture` otherwise.
// `drawn` maps a template's name to the rows a terrain drew for it before any ops: a terrain cannot seam with itself, so
// its pixels are trusted and only joins that ops changed are judged (cardinal inner corners aside, which no drawing can
// mend). Two terrains (a variant's) can: where their tiles meet, an edge each draws in another place is a seam
// (`terrains`), and another fill or colour is not.
export function templateSeams(templates, tile, mode = 'blob', drawn = {}) {
  const q = tile / 2, scale = q / (SMALL / 2), names = Object.keys(templates), seams = [];
  const untouched = (name, points) => drawn[name] !== undefined && points.every(([x, y]) => drawn[name][y][x] === templates[name][y][x]);
  const clear = char => char === '.' || char === ' ';
  let checked = 0;
  for (const join of JOINS[mode]) {
    const [fx, fy] = join.first.map(v => v * scale), [sx, sy] = join.second.map(v => v * scale);
    for (const a of names) for (const b of join.across ? names : [a]) {
      const A = templates[a], B = templates[b], pixels = [];
      checked++;
      // The quarters that naturally follow the first one and precede the second.
      const across = join.axis === 'x', after = beside([fx, fy], across ? 'right' : 'down', tile), before = beside([sx, sy], across ? 'left' : 'up', tile);
      const [nx, ny] = after.at, [px, py] = before.at;
      for (let i = 0; i < q; i++) {
        // Template coordinates of the pixel on each side of the join, and of the template's continuation of each.
        const at = across
          ? { first: [fx + q - 1, fy + i], second: [sx, sy + i], next: [nx, ny + i], previous: [px + q - 1, py + i] }
          : { first: [fx + i, fy + q - 1], second: [sx + i, sy], next: [nx + i, ny], previous: [px + i, py + q - 1] };
        const [first, next] = [at.first, at.next].map(([x, y]) => A[y][x]), [second, previous] = [at.second, at.previous].map(([x, y]) => B[y][x]);
        // A side whose continuation is only assumed cannot vouch for the join.
        if ((!after.assumed && second === next) || (!before.assumed && first === previous)) continue;
        // Two templates drawn by terrains (a set and a variant whose terrain changes it) each meet themselves without a
        // seam, so their pair is one of theirs wherever it agrees with either on one side. Where both sides differ,
        // only an edge drawn in another place breaks the join: another fill or colour switches at it, as a variant
        // is meant to.
        if (!join.corner && a !== b && untouched(a, [at.first, at.second]) && untouched(b, [at.first, at.second])) {
          const ownSecond = A[at.second[1]][at.second[0]], ownFirst = B[at.first[1]][at.first[0]];
          if (second !== ownSecond && first !== ownFirst && clear(second) !== clear(ownSecond) && clear(first) !== clear(ownFirst)) pixels.push({ first: at.first, second: at.second, shape: true, terrains: true });
          continue;
        }
        if (!join.corner && a === b && untouched(a, [at.first, at.next]) && untouched(b, [at.second, at.previous])) continue;
        const shape = (after.assumed || clear(second) !== clear(next)) && (before.assumed || clear(first) !== clear(previous));
        pixels.push({ first: at.first, second: at.second, ...(!after.assumed && { next: at.next }), ...(!before.assumed && { previous: at.previous }), shape });
      }
      if (!pixels.length) continue;
      // The same pair of quarters can meet within a tile and across two; report it once, with every mask.
      const same = seams.find(seam => seam.axis === join.axis && seam.a === a && seam.b === b && seam.from.join() === [fx, fy].join() && seam.to.join() === [sx, sy].join());
      if (same) { same.masks = [...new Set([...same.masks, ...join.masks])].sort((x, y) => x - y); continue; }
      seams.push({ axis: join.axis, a, b, from: [fx, fy], to: [sx, sy], pixels, masks: join.masks, ...(join.corner && { corner: true }) });
    }
  }
  return { checked, templates: names.length, seams };
}

// A seam report as warnings: each place an outline or edge breaks, then one line for texture that does not repeat.
// `label` names a template symbol in the text.
const templateLabel = name => (name === 'template' ? 'the template' : `variant ${name.slice('template-'.length)}'s template`);
export function seamWarnings(report, tile, label = templateLabel) {
  const warnings = [], q = tile / 2;
  const masks = list => `mask${list.length === 1 ? '' : 's'} ${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
  const point = ([x, y]) => `[${x}, ${y}]`, whose = name => (report.templates > 1 ? ` of ${label(name)}` : '');
  const pixelCount = n => `${n} pixel${n === 1 ? '' : 's'}`;
  // Two terrains that draw an edge in different places: one warning for each pair of templates.
  const pairs = new Map();
  for (const seam of report.seams) for (const p of seam.pixels) if (p.terrains) {
    const key = [seam.a, seam.b].sort().join('\u0000'), pair = pairs.get(key) ?? { names: [seam.a, seam.b].sort(), pixels: 0, joins: new Set(), example: seam };
    pair.pixels++; pair.joins.add(seam); pairs.set(key, pair);
  }
  for (const { names, pixels, joins, example } of pairs.values()) {
    warnings.push(`Seam: ${label(names[0])} and ${label(names[1])} come from terrains that draw the edge in different places, so their tiles break it where they meet: ${pixelCount(pixels)} along ${joins.size} quarter join${joins.size === 1 ? '' : 's'} (for example the ${q}×${q} quarter at ${point(example.to)} of ${label(example.b)} stitched ${example.axis === 'x' ? 'right of' : 'below'} the one at ${point(example.from)} of ${label(example.a)}, in tiles with ${masks(example.masks)}). A variant's tiles mix with the set's, so its terrain should change only what lies inside the edges: the fill (fill.seed, speckle), not edges, round or the terrain's seed.`);
  }
  const shape = report.seams.filter(seam => !seam.corner && seam.pixels.some(p => p.shape && !p.terrains));
  for (const seam of shape.slice(0, 6)) {
    const broken = seam.pixels.filter(p => p.shape && !p.terrains), shown = broken.slice(0, 3), more = broken.length > 3 ? ` (and ${broken.length - 3} more along the join)` : '';
    // Each fix copies the pixel the template has on the other side of a quarter it does continue.
    const fixes = [shown.every(p => p.next) && shown.map(p => `${point(p.second)} match ${point(p.next)}`).join(' and '), shown.every(p => p.previous) && shown.map(p => `${point(p.first)} match ${point(p.previous)}`).join(' and ')].filter(Boolean);
    warnings.push(`Seam in tiles with ${masks(seam.masks)}: the ${q}×${q} quarter at ${point(seam.to)}${whose(seam.b)} is stitched ${seam.axis === 'x' ? 'right of' : 'below'} the one at ${point(seam.from)}${whose(seam.a)}, and ${pixelCount(broken.length)} break${broken.length === 1 ? 's' : ''} the edge there. Make ${fixes.join(', or ')}${more}: tiles are stitched from template quarters, so the template has to repeat every ${tile} pixels, and its inner-corner tile has to meet the island's edges.`);
  }
  if (shape.length > 6) warnings.push(`Seam: ${shape.length - 6} more quarter joins break an edge; fix the ones above and compile again.`);
  const corners = report.seams.filter(seam => seam.corner), cornerPixels = corners.reduce((sum, seam) => sum + seam.pixels.length, 0);
  if (cornerPixels) warnings.push(`Inner corners: a cardinal set has no inner-corner tiles, so where a tile's two sides are terrain and the corner between them is not, the neighbours' edges stop at the tile border (${pixelCount(cornerPixels)} along ${corners.length} joins, in tiles with ${masks([...new Set(corners.flatMap(seam => seam.masks))].sort((a, b) => a - b))}). Use mode blob to turn inner corners, or edges that run to the tile border (depth 0, no bands).`);
  const texture = report.seams.filter(seam => !seam.corner && seam.a === seam.b && seam.pixels.some(p => !p.shape));
  const count = texture.reduce((sum, seam) => sum + seam.pixels.filter(p => !p.shape).length, 0);
  if (count) {
    const example = texture[0].pixels.find(p => !p.shape), [line, other, follows] = example.next ? [example.second, example.first, `differs from ${point(example.next)}, which follows it in the template`] : [example.first, example.second, `differs from ${point(example.previous)}, which precedes it in the template`];
    warnings.push(`Texture: ${pixelCount(count)} along ${texture.length} quarter join${texture.length === 1 ? '' : 's'} do not continue the template (for example ${point(line)}, stitched beside ${point(other)} in tiles with ${masks(texture[0].masks)}, ${follows}). Fine speckle hides this; lines and clumps break at tile quarters. Check the test map, or use a terrain fill, which repeats every ${tile} pixels.`);
  }
  return warnings;
}

// ---- Test map ----------------------------------------------------------------------------------------------------
// Every one of the 47 blob tiles (and so the 16 cardinal and 16 corner ones): a block with holes in all 16 arrangements
// of empty diagonals, strips and their ends, a lone tile and tiles that touch only at a corner, L and T shapes and a
// 2×2 block.
export const TEST_MAP = Object.freeze([
  '....................',
  '.###########.#.###..',
  '.#.#.#####.#.#......',
  '.###########.#.#.#..',
  '.#####.#####....#...',
  '.###########.#.#.#..',
  '.#####.###.#.##.....',
  '.###########.....##.',
  '.#.#.#.#.###.##.##..',
  '.###########.##.....',
  '.###.#.#####.#...#..',
  '.###########.##.##..',
  '.............#...#..',
  '....................'
]);
// The test map of a layered set of n terrains (0 the bottom): the shapes of TEST_MAP in the top terrain over the bottom
// one, so every top-over-bottom tile shows, and with three or four terrains the holes in its big block and rings round
// the block in the terrains between, so each terrain also meets the ones beside it, and below it a patch of each
// terrain between, where its plain tile and variants show. Rows of layer indices.
export function layeredTestMap(n) {
  const pad = n - 2, [x0, y0, x1, y1] = [1 + pad, 1 + pad, 11 + pad, 11 + pad];
  // TEST_MAP's columns 0–11 (the block) move right and down by pad, room for its rings; the shapes right of it move
  // right by twice that, so the rings never reach them.
  const map = Array.from({ length: TEST_MAP.length + pad * 2 }, (_, y) => Array.from({ length: TEST_MAP[0].length + pad * 2 }, (_, x) => {
    const column = x <= x1 ? x - pad : x >= 12 + pad * 2 ? x - pad * 2 : -1;
    if (TEST_MAP[y - pad]?.[column] === '#') return n - 1;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return n - 2;
    const ring = Math.max(x0 - x, x - x1, y0 - y, y - y1);
    return ring <= n - 2 ? n - 1 - ring : 0;
  }));
  // The patches: four rows, side by side across the map, a column of the bottom terrain between them, and a row of it
  // under them.
  const width = map[0].length, span = Math.floor((width - 1) / Math.max(1, pad));
  for (let y = 0; y < (pad ? 5 : 0); y++) map.push(Array.from({ length: width }, (_, x) => {
    const patch = Math.floor((x - 1) / span);
    return y < 4 && x >= 1 && patch < pad && (x - 1) % span < span - 1 ? 1 + patch : 0;
  }));
  return map;
}
// A one-frame recipe that draws a layered set over its test map, as its tiles draw it: one map per terrain, bottom
// first, in which that terrain's cells draw its corner tiles counting every higher terrain's cells as its own. The
// terrain goes on past the map's edge. A layer with variants ({ weight, variants: [{ symbol, weight }] }) then has them
// drawn over its plain tiles, picked at each point as a scene legend { frames: [plain, ...variants], weights } with
// seed 0 picks them, so a scene with that legend draws the same pixels.
export function layeredTestMapRecipe(recipe, layers, { background } = {}) {
  const tile = recipe.width, map = layeredTestMap(layers.length), rows = map.map(row => row.map(i => layers[i].key).join(''));
  const width = rows[0].length * tile, height = rows.length * tile;
  const names = layers.flatMap(layer => [`template-${layer.name}`, ...(layer.variants ?? []).map(variant => variant.symbol)]);
  const symbols = Object.fromEntries(names.map(name => [name, recipe.symbols[name]]));
  const maps = layers.map((layer, i) => ({ op: 'tilemap', tile: [tile, tile], rows, outside: 'match',
    legend: Object.fromEntries(layers.map((other, j) => [other.key, j === i ? { template: `template-${layer.name}`, autotile: 'corner', match: layers.slice(i).map(above => above.key).join('') } : null])) }));
  // A point's four cells, NW NE SW SE; past the map's edge, the nearest cell in it.
  const variants = [], at = (x, y) => map[Math.min(Math.max(y, 0), map.length - 1)][Math.min(Math.max(x, 0), map[0].length - 1)];
  for (let y = 0; y <= map.length; y++) for (let x = 0; x <= map[0].length; x++) {
    const cells = [at(x - 1, y - 1), at(x, y - 1), at(x - 1, y), at(x, y)], layer = layers[cells[0]];
    if (!layer.variants || cells.some(cell => cell !== cells[0])) continue;
    const weights = [layer.weight ?? 1, ...layer.variants.map(variant => variant.weight ?? 1)];
    let left = hash(0, x, y, 0) % weights.reduce((sum, w) => sum + w, 0), k = 0;
    while (left >= weights[k]) left -= weights[k++];
    if (k) variants.push({ op: 'autotile', symbol: layer.variants[k - 1].symbol, mask: 15, mode: 'corner', x: x * tile - tile / 2, y: y * tile - tile / 2 });
  }
  return { version: 1, name: `${recipe.name}-test-map`, width, height, palette: recipe.palette, ...(recipe.ramps && { ramps: recipe.ramps }), symbols,
    frames: [{ name: 'test-map', ops: [...(background !== undefined ? [{ op: 'rect', x: 0, y: 0, w: width, h: height, color: background }] : []), ...maps, ...variants] }] };
}
// A one-frame recipe that draws a compiled set's templates over the test map (variants with templates of their own
// mixed in by position, as often as `weights` say), on `background` when given. With `slopes` (see slopeTiles), the
// slopes' map below it, in the slope-<slope> symbols, the ground going on past its sides and bottom.
export function testMapRecipe(recipe, { templates, weights, mode = 'blob', background, slopes }) {
  const tile = recipe.width, width = Math.max(TEST_MAP[0].length, slopes ? SLOPE_MAP[0].length : 0) * tile, height = (TEST_MAP.length + (slopes ? SLOPE_MAP.length : 0)) * tile;
  const names = [...templates, ...(slopes ?? []).flatMap(slope => [`slope-${slope.key}`, ...(slope.foot ? [`slope-${slope.key}-foot`] : [])])];
  const symbols = Object.fromEntries(names.map(name => [name, recipe.symbols[name]]));
  const set = templates.length === 1 ? { template: templates[0], autotile: mode } : { templates, ...(weights && { weights }), autotile: mode };
  const hills = slopes ? [{ op: 'tilemap', y: TEST_MAP.length * tile, tile: [tile, tile], rows: [...SLOPE_MAP], outside: 'match', legend: slopeLegend(slopes, set, key => ({ symbol: `slope-${key}` })) }] : [];
  return { version: 1, name: `${recipe.name}-test-map`, width, height, palette: recipe.palette, ...(recipe.ramps && { ramps: recipe.ramps }), symbols,
    frames: [{ name: 'test-map', ops: [...(background !== undefined ? [{ op: 'rect', x: 0, y: 0, w: width, h: height, color: background }] : []), { op: 'tilemap', tile: [tile, tile], rows: [...TEST_MAP], legend: { '#': set } }, ...hills] }] };
}
// The enlargement that shows a test map at about 768 pixels across, as scene views are.
export const testMapScale = recipe => Math.max(1, Math.min(8, Math.floor(768 / Math.max(recipe.width, recipe.height))));
