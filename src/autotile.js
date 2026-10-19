// Browser-compatible autotile rules and tilemap legends, shared by scene tilemaps, the recipe `tilemap` operation and
// the autotile compiler. No I/O.
import { hash, random } from './craft.js';
// A tile is split into four quadrants. Each quadrant looks at two orthogonal neighbours and the diagonal between
// them, and becomes one of five pieces: o (outer corner), h (horizontal edge), v (vertical edge), i (inner corner)
// or f (fill). Masks use N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128 for "blob" (47 reduced masks) and
// N=1, E=2, S=4, W=8 for "cardinal" (16 masks, no inner corners).
export const BLOB_BITS = { n: 1, ne: 2, e: 4, se: 8, s: 16, sw: 32, w: 64, nw: 128 };
export const CARDINAL_BITS = { n: 1, e: 2, s: 4, w: 8 };
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

// `matches(dx, dy)` answers whether the neighbour at that offset belongs to the same terrain.
export function neighbourMask(mode, matches) {
  if (mode === 'cardinal') return Object.entries(CARDINAL_BITS).reduce((mask, [key, bit]) => mask | (matches(...OFFSETS[key]) ? bit : 0), 0);
  return reduceBlobMask(Object.entries(BLOB_BITS).reduce((mask, [key, bit]) => mask | (matches(...OFFSETS[key]) ? bit : 0), 0));
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
    if (spec.autotile !== undefined && !['blob', 'cardinal'].includes(spec.autotile)) fail(`${where}.autotile`, 'expected blob or cardinal');
    if (spec.autotile && masked(kind) && list.some(n => !n.includes('{mask}'))) fail(`${where}.${key}`, 'autotile names must contain {mask}');
    if (!spec.autotile && !masked(kind)) fail(`${where}.autotile`, `a ${kind} draws the tile its neighbour mask selects; set autotile to blob or cardinal`);
    if (spec.match !== undefined && (typeof spec.match !== 'string' || !spec.match.length)) fail(`${where}.match`, 'expected a string of matching characters');
    return { kind, names: list, weights, autotile: spec.autotile ?? null, match: spec.match ?? null };
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
  // Position-based variants, so repeated terrain does not tile visibly; with a seed or inside rules a seeded hash.
  const pick = (rule, x, y) => {
    if (rule.names.length === 1) return rule.names[0];
    const value = rule.salt || seed ? hash(seed, x, y, rule.salt) : (((x * 73856093) ^ (y * 19349663)) >>> 0);
    if (!rule.weights) return rule.names[value % rule.names.length];
    let left = value % rule.weights.reduce((sum, w) => sum + w, 0);
    for (let i = 0; i < rule.names.length; i++) { left -= rule.weights[i]; if (left < 0) return rule.names[i]; }
    return rule.names.at(-1);
  };
  const outputs = [];
  rows.forEach((row, y) => [...row].forEach((char, x) => {
    if (char === '.' || char === ' ') return;
    const rules = legend.get(char), cp = `${path}.rows[${y}][${x}]`;
    if (rules === undefined) fail(cp, `character ${JSON.stringify(char)} is not in the legend`);
    if (rules === null) return;
    for (const rule of rules) {
      if (rule.pattern && ![...rule.pattern].every((want, k) => fits(want, charAt(x + (k % 3) - 1, y + Math.floor(k / 3) - 1)))) continue;
      if (rule.chance < 1 && random(seed, x, y, rule.salt, 0x63) >= rule.chance) continue;
      const match = rule.match ?? char;
      const mask = rule.autotile ? neighbourMask(rule.autotile, (dx, dy) => { const c = charAt(x + dx, y + dy); return c === undefined ? outside === 'match' : match.includes(c); }) : null;
      const chosen = pick(rule, x, y), name = mask !== null && masked(rule.kind) ? chosen.replaceAll('{mask}', String(mask)) : chosen;
      if (!exists(rule.kind, name)) fail(cp, `${rule.kind} ${JSON.stringify(name)} does not exist${mask === null ? '' : ` (mask ${mask})`}`);
      const [dx, dy] = rule.offset, moved = dx !== 0 || dy !== 0;
      outputs.push({ x: x + dx, y: y + dy, kind: rule.kind, name, ...(mask !== null && !masked(rule.kind) && { mask, mode: rule.autotile }), order: outputs.length, moved });
      if (rule.stop) break;
    }
  }));
  outputs.sort((a, b) => a.y - b.y || a.x - b.x || a.moved - b.moved || a.order - b.order);
  return { cells: outputs.map(({ order, moved, ...cell }) => cell), columns: width, rows: rows.length };
}
