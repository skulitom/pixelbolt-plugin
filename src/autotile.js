// Browser-compatible autotile rules and tilemap legends, shared by scene tilemaps, the recipe `tilemap` operation and
// the autotile compiler. No I/O.
import { hash, random } from './craft.js';
// A tile is split into four quadrants. Each quadrant looks at two orthogonal neighbours and the diagonal between
// them, and becomes one of five pieces: o (outer corner), h (horizontal edge), v (vertical edge), i (inner corner)
// or f (fill). Masks use N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128 for "blob" (47 reduced masks) and
// N=1, E=2, S=4, W=8 for "cardinal" (16 masks, no inner corners).
// A "corner" tile (a dual grid) sits where four map cells meet instead, half a tile up and left of the cell below
// and right of that point, and its mask says which of those four cells are terrain: NW=1, NE=2, SW=4, SE=8 (16
// masks; 0 draws nothing). Each of its quarters is the inner quarter of one of the four cells, cut from the same
// template, so a corner map draws exactly what a blob map of the same cells draws, from 16 tiles instead of 47.
export const BLOB_BITS = { n: 1, ne: 2, e: 4, se: 8, s: 16, sw: 32, w: 64, nw: 128 };
export const CARDINAL_BITS = { n: 1, e: 2, s: 4, w: 8 };
export const CORNER_BITS = { nw: 1, ne: 2, sw: 4, se: 8 };
export const AUTOTILE_MODES = Object.freeze(['blob', 'cardinal', 'corner']);
export const QUADRANTS = { tl: ['n', 'w', 'nw'], tr: ['n', 'e', 'ne'], bl: ['s', 'w', 'sw'], br: ['s', 'e', 'se'] };
const OFFSETS = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };

// A diagonal only counts when both adjacent orthogonals match, so 256 raw masks reduce to 47.
export function reduceBlobMask(mask) {
  let out = mask & (BLOB_BITS.n | BLOB_BITS.e | BLOB_BITS.s | BLOB_BITS.w);
  for (const [d, a, b] of [['ne', 'n', 'e'], ['se', 's', 'e'], ['sw', 's', 'w'], ['nw', 'n', 'w']]) {
    if ((mask & BLOB_BITS[d]) && (mask & BLOB_BITS[a]) && (mask & BLOB_BITS[b])) out |= BLOB_BITS[d];
  }
  return out;
}
export const BLOB_MASKS = Object.freeze([...new Set(Array.from({ length: 256 }, (_, m) => reduceBlobMask(m)))].sort((a, b) => a - b));
export const CARDINAL_MASKS = Object.freeze(Array.from({ length: 16 }, (_, m) => m));
export const CORNER_MASKS = CARDINAL_MASKS;
export const MODE_MASKS = Object.freeze({ blob: BLOB_MASKS, cardinal: CARDINAL_MASKS, corner: CORNER_MASKS });
export const MODE_BITS = Object.freeze({ blob: BLOB_BITS, cardinal: CARDINAL_BITS, corner: CORNER_BITS });
// The four cells around a corner tile, from the cell whose top-left corner it sits on.
const CORNER_OFFSETS = { nw: [-1, -1], ne: [0, -1], sw: [-1, 0], se: [0, 0] };

// `matches(dx, dy)` answers whether the neighbour at that offset belongs to the same terrain. For a corner tile the
// offsets are from the cell whose top-left corner the tile sits on, and that cell is one of the four.
export function neighbourMask(mode, matches) {
  if (mode === 'cardinal') return Object.entries(CARDINAL_BITS).reduce((mask, [key, bit]) => mask | (matches(...OFFSETS[key]) ? bit : 0), 0);
  if (mode === 'corner') return Object.entries(CORNER_BITS).reduce((mask, [key, bit]) => mask | (matches(...CORNER_OFFSETS[key]) ? bit : 0), 0);
  return reduceBlobMask(Object.entries(BLOB_BITS).reduce((mask, [key, bit]) => mask | (matches(...OFFSETS[key]) ? bit : 0), 0));
}
// A tile's mask as drawn: blob masks reduced, cardinal and corner ones as given.
export const drawnMask = (mode, mask) => (mode === 'blob' ? reduceBlobMask(mask) : mask);
// The frames of a validated recipe that are tiles of an autotile set, for engine tile sets: each frame whose own
// operations draw `autotile` at the frame's corner, all with one mask and mode, as every compiled frame does. Masks
// come back as drawn: blob masks reduced, cardinal ones 0–15. A frame whose tile names a terrain says which set it
// belongs to. A tile of a layered set, whose tile names its corners' terrains, is not one: it belongs to those terrains.
export function autotileFrames(recipe) {
  const tiles = [];
  for (const frame of recipe.frames) {
    if (frame.tile?.corners !== undefined) continue;
    const ops = (frame.ops ?? []).filter(op => op.op === 'autotile');
    if (!ops.length || ops.some(op => (op.x ?? 0) !== 0 || (op.y ?? 0) !== 0)) continue;
    const mode = ops[0].mode ?? 'blob', mask = drawnMask(mode, ops[0].mask);
    if (ops.every(op => (op.mode ?? 'blob') === mode && drawnMask(mode, op.mask) === mask)) tiles.push({ frame: frame.name, mask, mode, ...(frame.tile?.terrain !== undefined && { terrain: frame.tile.terrain }) });
  }
  return tiles;
}
export function quadrantPieces(mode, mask) {
  const has = key => mode === 'cardinal' ? (mask & (CARDINAL_BITS[key] ?? 0)) !== 0 : (mask & BLOB_BITS[key]) !== 0;
  return Object.fromEntries(Object.entries(QUADRANTS).map(([position, [a, b, diagonal]]) => {
    if (!has(a) && !has(b)) return [position, 'o'];
    if (!has(a)) return [position, 'h'];
    if (!has(b)) return [position, 'v'];
    return [position, mode !== 'cardinal' && !has(diagonal) ? 'i' : 'f'];
  }));
}
// Where each quarter of a tile comes from: { tl, tr, bl, br }, each { from, piece } (the template quarter position and
// piece, for templatePiece) or null for a quarter that draws nothing. A blob or cardinal tile's quarters are its own
// cell's; a corner tile's top-left quarter is the bottom-right quarter of its NW cell, and so on, each shaped by the
// other three cells as that cell's neighbours.
const CORNER_QUARTERS = { tl: ['nw', 'br'], tr: ['ne', 'bl'], bl: ['sw', 'tr'], br: ['se', 'tl'] };
const CORNER_AT = { nw: [0, 0], ne: [1, 0], sw: [0, 1], se: [1, 1] };
const DIRECTION = Object.fromEntries(Object.entries(OFFSETS).map(([key, [dx, dy]]) => [`${dx},${dy}`, key]));
export function tilePieces(mode, mask) {
  if (mode !== 'corner') return Object.fromEntries(Object.entries(quadrantPieces(mode, drawnMask(mode, mask))).map(([position, piece]) => [position, { from: position, piece }]));
  return Object.fromEntries(Object.entries(CORNER_QUARTERS).map(([position, [cell, from]]) => {
    if (!(mask & CORNER_BITS[cell])) return [position, null];
    const [cx, cy] = CORNER_AT[cell];
    const around = Object.entries(CORNER_AT).reduce((bits, [other, [ox, oy]]) => (other !== cell && (mask & CORNER_BITS[other]) ? bits | BLOB_BITS[DIRECTION[`${ox - cx},${oy - cy}`]] : bits), 0);
    return [position, { from, piece: quadrantPieces('blob', reduceBlobMask(around))[from] }];
  }));
}
// Template layout (tile T, quarter Q = T/2), two tiles wide and three tall:
//   row 0: [unused preview][inner corners: each quadrant is that quadrant's inner-corner piece]
//   rows 1-2: a 2x2-tile island whose quadrants supply outer corners, edges and fill.
// Returns the template's top-left pixel for a quadrant position and piece type.
const ISLAND = { tl: { o: [0, 0], h: [1, 0], v: [0, 1], f: [1, 1] }, tr: { o: [1, 0], h: [0, 0], v: [1, 1], f: [0, 1] }, bl: { o: [0, 1], h: [1, 1], v: [0, 0], f: [1, 0] }, br: { o: [1, 1], h: [0, 1], v: [1, 0], f: [0, 0] } };
const QUARTER = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] };
export function templatePiece(tile, position, piece) {
  const q = tile / 2, [qx, qy] = QUARTER[position];
  if (piece === 'i') return [tile + qx * q, qy * q];
  const [tx, ty] = ISLAND[position][piece];
  return [tx * tile + qx * q, tile + ty * tile + qy * q];
}

// ---- Tilemaps ----------------------------------------------------------------------------------------------------
// A character map drawn through a legend, shared by scene tilemaps (frames and animations of one asset) and the
// recipe `tilemap` operation (symbols and autotile templates). A legend entry names what a cell draws: one name, or
// variants picked by position (optionally weighted), with `{mask}` replaced by the cell's neighbour mask. An entry
// with `rules` instead decides by the characters around the cell: every rule whose 3×3 `where` pattern matches (and
// whose seeded `chance` passes) draws, in order, optionally `offset` into another cell, until a matching rule says
// `stop`. Outputs are drawn in map order of the cell they land in; offset outputs draw over that cell's own tiles.
// The caller supplies what names mean: `kinds` (each also has a plural for variants), the kind a bare string names,
// `exists(kind, name)`, `masked(kind)` (true when the mask goes into the name, false when it travels with the output,
// as for an autotile template) and `fail(path, message)` for errors. Returns cells in drawing order.
export function expandTilemap(tilemap, { path, fail, kinds, text, exists, masked }) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const known = (value, keys, where) => {
    if (!isObject(value)) fail(where, 'expected an object');
    for (const key of Object.keys(value)) if (!keys.includes(key) || value[key] === null) fail(`${where}.${key}`, 'unknown or null field');
  };
  const single = char => typeof char === 'string' && char.length === 1 && char !== '.' && char !== ' ';
  const rows = tilemap.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 256 || typeof rows[0] !== 'string' || !rows[0].length || rows[0].length > 256) fail(`${path}.rows`, 'expected 1–256 rows of 1–256 characters');
  rows.forEach((row, y) => { if (typeof row !== 'string' || row.length !== rows[0].length) fail(`${path}.rows[${y}]`, `all rows must be ${rows[0].length} characters wide`); });
  const outside = tilemap.outside ?? 'empty';
  if (!['empty', 'match'].includes(outside)) fail(`${path}.outside`, 'expected empty or match');
  const plural = kind => `${kind}s`, names = kinds.flatMap(kind => [kind, plural(kind)]);
  const listed = names.length === 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
  if (!isObject(tilemap.legend)) fail(`${path}.legend`, `expected a map of characters to ${listed}`);
  const seed = tilemap.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) fail(`${path}.seed`, 'expected an integer from 0 to 2147483647');
  const empty = tilemap.empty;
  if (empty !== undefined && (!single(empty) || Object.hasOwn(tilemap.legend, empty))) fail(`${path}.empty`, 'choose one character, not a dot, space or legend key, to stand for empty cells in rules');
  const classes = new Map();
  if (tilemap.classes !== undefined) {
    if (!isObject(tilemap.classes)) fail(`${path}.classes`, 'expected a map of characters to the map characters each stands for in rules');
    for (const [char, members] of Object.entries(tilemap.classes)) {
      const cp = `${path}.classes[${JSON.stringify(char)}]`;
      if (!single(char) || char === empty || Object.hasOwn(tilemap.legend, char)) fail(cp, 'class keys are single characters other than a dot, space, the empty character or a legend key');
      if (typeof members !== 'string' || !members.length || members.length > 64) fail(cp, 'expected 1–64 map characters (the empty character stands for empty cells)');
      classes.set(char, members);
    }
  }
  // What a legend entry or rule draws: one name or weighted variants, optionally by neighbour mask.
  const drawable = (spec, where) => {
    const present = names.filter(key => spec[key] !== undefined);
    if (present.length !== 1) fail(where, `use exactly one of ${listed}`);
    const key = present[0], kind = kinds.find(k => key === k || key === plural(k)), many = key !== kind;
    const list = many ? spec[key] : [spec[key]];
    if (!Array.isArray(list) || !list.length || list.length > 64 || list.some(n => typeof n !== 'string' || !n)) fail(`${where}.${key}`, many ? 'expected 1–64 names' : 'expected a name');
    let weights = null;
    if (spec.weights !== undefined) {
      if (!Array.isArray(spec.weights) || spec.weights.length !== list.length || spec.weights.some(w => !Number.isInteger(w) || w < 1 || w > 1000)) fail(`${where}.weights`, `expected ${list.length} whole-number weight${list.length === 1 ? '' : 's'} from 1 to 1000, one per name`);
      weights = spec.weights;
    }
    if (spec.autotile !== undefined && !AUTOTILE_MODES.includes(spec.autotile)) fail(`${where}.autotile`, 'expected blob, cardinal or corner');
    if (list.some(n => n.includes('{corners}')) && (spec.autotile !== 'corner' || !masked(kind))) fail(`${where}.${key}`, `{corners} names a layered set's tile by the characters of the four cells around it; it goes with autotile corner${masked(kind) ? '' : `, in a ${kinds.filter(masked).join(' or ')} name`}`);
    if (spec.autotile && masked(kind) && list.some(n => !n.includes('{mask}') && !(spec.autotile === 'corner' && n.includes('{corners}')))) fail(`${where}.${key}`, spec.autotile === 'corner' ? 'corner names must contain {mask} or, for a layered set, {corners}' : 'autotile names must contain {mask}');
    if (!spec.autotile && !masked(kind)) fail(`${where}.autotile`, `a ${kind} draws the tile its neighbour mask selects; set autotile to blob, cardinal or corner`);
    if (spec.match !== undefined && (typeof spec.match !== 'string' || !spec.match.length)) fail(`${where}.match`, 'expected a string of matching characters');
    return { kind, names: list, weights, autotile: spec.autotile ?? null, match: spec.match ?? null, path: `${where}.${key}`, all: list.map((_, i) => i), layered: list.some(n => n.includes('{corners}')) };
  };
  const ruleFields = ['where', 'chance', 'offset', 'stop'], drawFields = [...names, 'weights', 'autotile', 'match'];
  const legend = new Map();
  for (const [char, value] of Object.entries(tilemap.legend)) {
    const lp = `${path}.legend[${JSON.stringify(char)}]`;
    if (!single(char)) fail(lp, 'legend keys are single characters other than dot or space');
    // null marks a context cell: never drawn, but it can satisfy another entry's `match` or a rule.
    if (value === null) { legend.set(char, null); continue; }
    const entry = typeof value === 'string' ? { [text]: value } : value;
    if (isObject(entry) && entry.rules !== undefined) {
      known(entry, ['rules'], lp);
      if (!Array.isArray(entry.rules) || !entry.rules.length || entry.rules.length > 32) fail(`${lp}.rules`, 'expected 1–32 rules');
      legend.set(char, entry.rules.map((spec, i) => {
        const rp = `${lp}.rules[${i}]`;
        known(spec, [...drawFields, ...ruleFields], rp);
        const rule = { ...drawable(spec, rp), salt: i + 1, pattern: null, chance: 1, offset: [0, 0], stop: false };
        if (spec.where !== undefined) {
          if (!Array.isArray(spec.where) || spec.where.length !== 3 || spec.where.some(row => typeof row !== 'string' || row.length !== 3)) fail(`${rp}.where`, 'expected three rows of three characters centred on the cell; a dot matches anything');
          rule.pattern = spec.where.join('');
        }
        if (spec.chance !== undefined && (typeof spec.chance !== 'number' || !Number.isFinite(spec.chance) || spec.chance < 0 || spec.chance > 1)) fail(`${rp}.chance`, 'expected a number from 0 to 1');
        if (spec.offset !== undefined && (!Array.isArray(spec.offset) || spec.offset.length !== 2 || spec.offset.some(v => !Number.isInteger(v) || Math.abs(v) > 8))) fail(`${rp}.offset`, 'expected [columns, rows], each a whole number from -8 to 8');
        if (spec.stop !== undefined && typeof spec.stop !== 'boolean') fail(`${rp}.stop`, 'expected a boolean');
        return { ...rule, chance: spec.chance ?? 1, offset: spec.offset ?? [0, 0], stop: spec.stop ?? false };
      }));
    } else {
      known(entry, drawFields, lp);
      legend.set(char, [{ ...drawable(entry, lp), salt: 0, pattern: null, chance: 1, offset: [0, 0], stop: false }]);
    }
  }
  // A layered entry's variants are tiles the set has for some corners only (a layer's variants of its plain tile), so
  // each must be a tile for some four of the map's layered keys; one that is a tile for none is a mistake.
  const layeredKeys = [...legend].filter(([, rules]) => rules?.some(rule => rule.layered)).map(([char]) => char), k = layeredKeys.length;
  if (k <= 8) for (const rules of legend.values()) for (const rule of rules ?? []) {
    if (!rule.layered || rule.names.length < 2) continue;
    rule.names.forEach((name, i) => {
      if (!name.includes('{corners}') || name.includes('{mask}')) return;
      for (let code = 0; code < k * k * k * k; code++) if (exists(rule.kind, name.replaceAll('{corners}', [1, k, k * k, k * k * k].map(place => layeredKeys[Math.floor(code / place) % k]).join('')))) return;
      fail(`${rule.path}[${i}]`, `${JSON.stringify(name)} is no ${rule.kind} for any four of the map's layered keys (${layeredKeys.join(' ')}); a layered set names a layer's variants after its plain tile, such as ${rule.names[0].replaceAll('{corners}', layeredKeys[0].repeat(4))}-<variant>`);
    });
  }
  const width = rows[0].length;
  const charAt = (x, y) => (y >= 0 && y < rows.length && x >= 0 && x < width ? rows[y][x] : undefined);
  // In a `where` pattern a dot matches anything, the empty character matches empty cells, a class matches its
  // members and any other character matches itself. Cells outside the map are empty, or match anything with
  // outside: "match".
  const fits = (want, char) => {
    if (want === '.' || (char === undefined && outside === 'match')) return true;
    const blank = char === undefined || char === '.' || char === ' ';
    if (want === empty) return blank;
    const members = classes.get(want);
    if (members !== undefined) return blank ? empty !== undefined && members.includes(empty) : members.includes(char);
    return !blank && char === want;
  };
  // Variants picked by a seeded hash of the cell's position, so repeated terrain does not tile visibly. (A product of
  // x and y with two odd numbers, used without a seed before, kept only their low bits: two variants made a checkerboard.)
  // Returns the index of the name picked from `among`, indices into the rule's names, by their weights.
  const pick = (rule, x, y, among) => {
    if (among.length === 1) return among[0];
    const value = hash(seed, x, y, rule.salt);
    if (!rule.weights) return among[value % among.length];
    let left = value % among.reduce((sum, i) => sum + rule.weights[i], 0);
    for (const i of among) { left -= rule.weights[i]; if (left < 0) return i; }
    return among.at(-1);
  };
  const outputs = [], drawnCorners = new Set();
  // The characters of the four cells around a corner tile (NW, NE, SW, SE), for {corners}: past the map's edge, the
  // nearest cell in it, since a layered map's terrain goes on.
  const cornerCells = (x, y) => [[-1, -1], [0, -1], [-1, 0], [0, 0]].map(([dx, dy]) => [Math.min(Math.max(x + dx, 0), width - 1), Math.min(Math.max(y + dy, 0), rows.length - 1)]);
  // What a rule draws at one place: x, y name the cell, or for a corner tile the cell whose top-left corner it sits on.
  // A corner tile is drawn once at its point for each thing drawn there, however many of its cells ask for it.
  const emit = (rule, char, x, y, cp) => {
    const match = rule.match ?? char, corner = rule.autotile === 'corner';
    const mask = rule.autotile ? neighbourMask(rule.autotile, (dx, dy) => { const c = charAt(x + dx, y + dy); return c === undefined ? outside === 'match' : match.includes(c); }) : null;
    const named = name => (mask !== null && masked(rule.kind) ? name.replaceAll('{mask}', String(mask)) : name);
    let name, corners = null;
    if (!rule.layered) name = named(rule.names[pick(rule, x, y, rule.all)]);
    else {
      const cells = cornerCells(x, y), blank = cells.find(([cx, cy]) => rows[cy][cx] === '.' || rows[cy][cx] === ' ');
      if (blank) fail(`${path}.rows[${blank[1]}][${blank[0]}]`, 'is empty, but {corners} names a layered tile by the characters of the four cells around it; give every cell of a layered map one of its terrains\' keys');
      corners = cells.map(([cx, cy]) => rows[cy][cx]);
      // Names the set has no tile for at these corners (other terrains' variants) are left out of the pick.
      const names = rule.names.map(n => named(n).replaceAll('{corners}', corners.join(''))), have = rule.all.filter(i => exists(rule.kind, names[i]));
      name = names[have.length ? pick(rule, x, y, have) : 0];
    }
    if (!exists(rule.kind, name)) fail(cp, `${rule.kind} ${JSON.stringify(name)} does not exist${corners ? ` (corners ${corners.join(' ')}: every cell around a layered tile is one of the set's keys)` : mask === null ? '' : ` (${corner ? 'corner ' : ''}mask ${mask})`}`);
    const [dx, dy] = rule.offset, moved = dx !== 0 || dy !== 0, half = corner ? 0.5 : 0;
    // A layered tile's name says all it draws, so another terrain's entry that finds it (with a mask of its own) draws
    // nothing more.
    if (corner) {
      const key = `${x + dx},${y + dy}|${rule.kind}|${name}|${corners ? '' : mask}`;
      if (drawnCorners.has(key)) return;
      drawnCorners.add(key);
    }
    outputs.push({ x: x + dx - half, y: y + dy - half, kind: rule.kind, name, ...(mask !== null && !masked(rule.kind) && { mask, mode: rule.autotile }), ...(corner && masked(rule.kind) && { corner: true }), order: outputs.length, moved });
  };
  rows.forEach((row, y) => [...row].forEach((char, x) => {
    if (char === '.' || char === ' ') return;
    const rules = legend.get(char), cp = `${path}.rows[${y}][${x}]`;
    if (rules === undefined) fail(cp, `character ${JSON.stringify(char)} is not in the legend`);
    if (rules === null) return;
    for (const rule of rules) {
      if (rule.pattern && ![...rule.pattern].every((want, k) => fits(want, charAt(x + (k % 3) - 1, y + Math.floor(k / 3) - 1)))) continue;
      if (rule.chance < 1 && random(seed, x, y, rule.salt, 0x63) >= rule.chance) continue;
      // A corner tile belongs to the point where four cells meet, so a cell draws the tiles at its four corners, with
      // variants picked by the point.
      if (rule.autotile !== 'corner') emit(rule, char, x, y, cp);
      else for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) emit(rule, char, cx, cy, cp);
      if (rule.stop) break;
    }
  }));
  outputs.sort((a, b) => a.y - b.y || a.x - b.x || a.moved - b.moved || a.order - b.order);
  // A corner tile's x and y end in .5: it sits half a cell up and left of the cell it was found from.
  return { cells: outputs.map(({ order, moved, ...cell }) => cell), columns: width, rows: rows.length };
}

// An iso map lays its cells on a 2:1 diamond grid: cell [x, y] (the character's column and row) has its diamond's
// top-left at [(x - y + rows - 1) * w / 2, (x + y) * h / 2] for a tile [w, h], so the map's top-left is [0, 0] and it
// is (columns + rows) * w / 2 wide. Cells draw back to front: by column plus row, then column, then as listed. Each
// returned cell keeps its fields and adds `left` and `top`.
export function isoLayout(cells, rows, [w, h]) {
  return cells.map((cell, order) => ({ cell, order }))
    .sort((a, b) => a.cell.x + a.cell.y - (b.cell.x + b.cell.y) || a.cell.x - b.cell.x || a.order - b.order)
    .map(({ cell }) => ({ ...cell, left: (cell.x - cell.y + rows - 1) * w / 2, top: (cell.x + cell.y) * h / 2 }));
}
