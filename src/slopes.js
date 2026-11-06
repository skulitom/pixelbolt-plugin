// Slopes for side-view terrain: tiles whose ground rises 45° (a cell up over a cell across) or gently (a cell up over
// two), cut from a blob or cardinal set's own template so they meet its flat ground and its fill without a seam.
// Browser-compatible and deterministic: whole-pixel arithmetic only.
//
// A slope column is a column of the flat ground's top-edge tile (its margin, tufts and bands, down to its last pixel
// that differs from the fill tile's) moved down by the slope's height there, over the fill tile drawn in place, so the
// fill's texture lines up with the tiles round it. The ground of a flat tile starts a few pixels below its cell's top
// (its north edge's depth), so a slope's low end reaches into the cell under it: that cell takes the slope's foot, the
// part of the column that ran past the tile, over the fill. A slope's line runs from the ground beside its low end to
// the ground beside its high end, so it stands on terrain that goes on below it and toward its high side.
import { tilePieces, templatePiece } from './autotile.js';

// Each slope, read left to right: `up` rises 45° (its low side on the left), `down` falls 45°, and a gentle slope is a
// pair of tiles, low then high going up, high then low going down. `shift` is how far its column x is moved down from
// the flat ground on the slope's high side (0) for a tile `t` pixels wide; `line` the cell-edge heights where the
// slope's ground line crosses the tile's left and right sides, before the edge's depth. `char` is its character in the
// suggested map legend: / and \ for 45°, u U for a gentle rise (low, high) and D d for a gentle fall (high, low).
export const SLOPES = Object.freeze([
  { key: 'up', char: '/', shift: (x, t) => t - x, line: t => [t, 0] },
  { key: 'down', char: '\\', shift: x => x + 1, line: t => [0, t] },
  { key: 'gentle-up-low', char: 'u', shift: (x, t) => t - Math.floor((x + 1) / 2), line: t => [t, t / 2] },
  { key: 'gentle-up-high', char: 'U', shift: (x, t) => t / 2 - Math.floor((x + 1) / 2), line: t => [t / 2, 0] },
  { key: 'gentle-down-high', char: 'D', shift: x => Math.ceil(x / 2), line: t => [0, t / 2] },
  { key: 'gentle-down-low', char: 'd', shift: (x, t) => t / 2 + Math.ceil(x / 2), line: t => [t / 2, t] }
].map(Object.freeze));
// The masks of a flat top edge (terrain on every side but the top) and of the fill, per mode.
const FLAT = { blob: [124, 255], cardinal: [14, 15] };

// The tile a mask draws from template rows (two tiles wide, three tall), as rows of palette keys.
export function templateTile(rows, tile, mode, mask) {
  const q = tile / 2, pieces = tilePieces(mode, mask), out = Array.from({ length: tile }, () => '');
  for (const [position, qy] of [['tl', 0], ['tr', 0], ['bl', 1], ['br', 1]]) {
    const [sx, sy] = templatePiece(tile, pieces[position].from, pieces[position].piece);
    for (let y = 0; y < q; y++) out[qy * q + y] += rows[sy + y].slice(sx, sx + q);
  }
  return out;
}

// Every slope's tile and, where it differs from the fill tile, its foot, from a blob or cardinal template:
// [{ key, char, rows, foot? }], rows of palette keys.
export function slopeTiles(rows, { tile, mode }) {
  const [top, full] = FLAT[mode], north = templateTile(rows, tile, mode, top), fill = templateTile(rows, tile, mode, full);
  // How far down each column's top edge reaches: to its last pixel unlike the fill's.
  const edge = Array.from({ length: tile }, (_, x) => { let e = 0; for (let r = 0; r < tile; r++) if (north[r][x] !== fill[r][x]) e = r + 1; return e; });
  return SLOPES.map(slope => {
    const column = x => { const s = slope.shift(x, tile); return r => (r < s ? '.' : r < s + edge[x] ? north[r - s][x] : fill[r % tile][x]); };
    const strip = Array.from({ length: 2 * tile }, (_, r) => Array.from({ length: tile }, (_, x) => column(x)(r)).join(''));
    const foot = strip.slice(tile);
    return { key: slope.key, char: slope.char, rows: strip.slice(0, tile), ...(foot.some((row, r) => row !== fill[r]) && { foot }) };
  });
}

// The solid part of a slope's tile, or of its foot, for a body that stands `depth` pixels below the slope's line (the
// top edge's depth, so on the drawn ground rather than its tufts): the polygon under the line, in tile pixels, or null
// where there is none.
export function slopeCollision(key, tile, depth, foot = false) {
  const [left, right] = SLOPES.find(slope => slope.key === key).line(tile), drop = depth - (foot ? tile : 0);
  let polygon = [[0, left + drop], [tile, right + drop], [tile, tile], [0, tile]];
  // Clipped to the tile: nothing above its top, and the line no lower than its bottom.
  for (const [inside, cut] of [[([, y]) => y >= 0, 0], [([, y]) => y <= tile, tile]]) {
    const kept = [];
    polygon.forEach((point, i) => {
      const next = polygon[(i + 1) % polygon.length];
      if (inside(point)) kept.push(point);
      if (inside(point) !== inside(next)) kept.push([point[0] + (next[0] - point[0]) * (cut - point[1]) / (next[1] - point[1]), cut]);
    });
    polygon = kept;
  }
  // Without repeated points or points on a straight line between their neighbours.
  let points = polygon.filter((point, i) => { const before = polygon[(i + polygon.length - 1) % polygon.length]; return point[0] !== before[0] || point[1] !== before[1]; });
  for (let changed = true; changed && points.length >= 3;) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length], b = points[i], c = points[(i + 1) % points.length];
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) === 0) { points = points.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return points.length >= 3 ? points : null;
}

// A map with each slope, for a test map: a hill of 45° slopes and one of gentle slopes, 24 cells wide.
export const SLOPE_MAP = Object.freeze([
  '........................',
  '...../##\\.......uU##Dd..',
  '..../####\\....uU######Dd',
  '########################',
  '########################'
]);
// A legend for maps of the slope characters and `terrain` (#), whose cells draw the set's tiles (`base`, a legend
// entry), a foot under each slope that has one, and whose masks count the slopes as terrain. `names` turns a slope
// tile's key (and key-foot) into what the legend draws: { frame } for scenes, { symbol } for recipes.
export function slopeLegend(slopes, base, names, terrain = '#') {
  const chars = slopes.map(slope => slope.char).join('');
  return {
    [terrain]: { rules: [...slopes.filter(slope => slope.foot).map(slope => ({ where: [`.${slope.char}.`, `.${terrain}.`, '...'], ...names(`${slope.key}-foot`), stop: true })), { ...base, match: `${terrain}${chars}` }] },
    ...Object.fromEntries(slopes.map(slope => [slope.char, names(slope.key)]))
  };
}
