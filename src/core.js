// Browser-compatible, deterministic rasterizer. No I/O and no dependencies.
import { patternProblem, ditherThreshold, traceLine, pixelId, colorOf, idsOf, cleanupIds, ruleVariants, rewriteIds, ease } from './craft.js';
import { AUTOTILE_MODES, tilePieces, templatePiece, expandTilemap, isoLayout, autotileFrames } from './autotile.js';
import { layoutText, FONT_HEIGHT, FONT_CHARACTERS } from './font.js';
export class PixelError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = 'PixelError'; this.path = path; }
}
// Largest JSON request accepted by the MCP server and the studio export endpoint. It exceeds the largest single
// animation frame the format allows (a 512x512 frame of explicit pixel corrections serializes to about 10 MB).
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const fail = (path, message) => { throw new PixelError(path, message); };
// Several errors as one: the first, naming the others in its message and listing every one in `errors`. `stopped`
// says checking stopped at the cap of ten. Recipes and compiled sources report broken parts this way.
export function joinErrors(all, stopped = false) {
  if (all.length === 1) return all[0];
  const [first, ...rest] = all;
  const combined = new PixelError(first.path, `${first.message.slice(first.path.length + 2)}; ${rest.length} more error${rest.length === 1 ? '' : 's'}${stopped ? ' (checking stopped at 10)' : ''}: ${rest.map(error => error.message).join('; ')}`);
  combined.errors = all.map(error => ({ path: error.path, error: error.message }));
  if (stopped) combined.stopped = true;
  return combined;
}
// An error as a reply carries it. One error has its message and path. Several are each said once, in `errors`, a
// message each (which starts with its path): the combined message would say them all a second time.
export const errorReply = error => error.errors
  ? { error: `${error.errors.length} errors${error.stopped ? ' (checking stopped at 10, so there may be more)' : ''}: fix every one in errors, then try again`, errors: error.errors.map(each => each.error) }
  : { error: error.message, ...(error.path && { path: error.path }) };

const own = (obj, key) => Object.hasOwn(obj, key);
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Names agents often write for a field or operation the format names differently, offered as "did you mean".
const FIELD_ALIASES = { width: 'w', height: 'h', x1: 'x', y1: 'y', x0: 'x', y0: 'y', colour: 'color', fill: 'filled', frame: 'from', name: 'symbol', hold: 'duration', delay: 'duration', time: 'duration', ms: 'duration', length: 'duration' };
const OP_ALIASES = { circle: 'ellipse', oval: 'ellipse', rectangle: 'rect', square: 'rect', point: 'pixel', dot: 'pixel', flood: 'fill', floodfill: 'fill', erase: 'clear', label: 'text', print: 'text', sprite: 'stamp', image: 'grid', recolor: 'replace', recolour: 'replace', border: 'outline' };
// What the operations those names mean take, said with the suggestion: a circle is written with a centre and a radius,
// an ellipse with its box, and the name alone left an agent to look the fields up.
const OP_FIELDS = {
  ellipse: 'x, y, w, h (the box it fills: a circle of radius r about cx, cy is x cx - r, y cy - r, w and h 2r + 1), color and optionally filled', rect: 'x, y, w, h, color and optionally filled', pixel: 'x, y, color',
  fill: 'x, y, color (a flood fill from that pixel)', clear: 'x, y, w, h', text: 'x, y, text, color and optionally align', stamp: 'symbol, x, y', grid: 'x, y, rows',
  replace: 'from, to (two colours)', outline: 'color and optionally position, width'
};
// One letter changed, added or removed: a typo of the other name.
const oneEdit = (a, b) => {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
};
// The name in `names` that `key` most likely meant: a known alias, the same name in other case, or a one-letter typo.
export function meant(key, names, aliases = {}) {
  if (own(aliases, key) && names.includes(aliases[key])) return aliases[key];
  const lower = key.toLowerCase();
  return names.find(n => n.toLowerCase() === lower) ?? (key.length > 3 ? names.find(n => n.length > 3 && oneEdit(lower, n.toLowerCase())) : undefined);
}
function unknownName(kind, key, names, aliases = FIELD_ALIASES) {
  const guess = meant(key, names, aliases);
  const listed = kind === 'operation' ? 'operations' : 'fields here';
  return `unknown ${kind}${kind === 'operation' ? ` ${JSON.stringify(key)}` : ''}${guess ? `; did you mean "${guess}"?${kind === 'operation' && own(OP_FIELDS, guess) ? ` It takes ${OP_FIELDS[guess]}.` : ''}` : ''}${names.length <= 24 ? (guess ? ` ${listed[0].toUpperCase()}${listed.slice(1)}` : `; ${listed}`) + `: ${names.join(', ')}` : ''}`;
}
function object(value, path, keys) {
  if (!isObject(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (value[key] === null) fail(`${path}.${key}`, 'null is not supported; omit optional fields to use defaults');
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, unknownName('field', key, keys));
  return value;
}
function integer(value, path, min = -4096, max = 4096) {
  if (value === undefined) fail(path, `missing; expected an integer from ${min} to ${max}`);
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value;
}
function boolean(value, path) { if (typeof value !== 'boolean') fail(path, 'expected a boolean'); return value; }
function number(value, path, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a number from ${min} to ${max}`);
  return value;
}
function list(value, path, max = 2048) {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected an array with at most ${max} items`);
  return value;
}
function name(value, path) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) fail(path, 'use 1–64 letters, digits, underscores or hyphens, starting with a letter');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail(path, 'reserved filename; choose a portable name');
  return value;
}
function point(value, path) {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'expected [x, y]');
  return [integer(value[0], `${path}[0]`), integer(value[1], `${path}[1]`)];
}
// Layers in a frame group take its translation on top of their own. The compositor, canvas
// resize and canvas-space patch advice all need the same effective offset.
export function layerOffset(layer, groups, path = 'layer') {
  const x = integer(layer.x ?? 0, `${path}.x`), y = integer(layer.y ?? 0, `${path}.y`);
  if (layer.group === undefined) return [x, y];
  const group = name(layer.group, `${path}.group`);
  if (!groups || !own(groups, group)) fail(`${path}.group`, `unknown layer group "${group}"; declare it in this frame's groups`);
  const [dx, dy] = groups[group];
  return [x + dx, y + dy];
}
// A frame's facts as a tile, for engine tile sets: the terrain an autotile frame belongs to (frames of one set share
// it), its weight against the other frames that could fill the same cell, and collision polygons around its solid
// parts in canvas pixels (pixel corners, from 0 to the width and height), one-way when oneWay: bodies pass up through
// them and land on top. Exports turn the polygons into the engine's own; the renderer draws nothing from them. One
// polygon, or a list of up to 8 for a tile with separate solid parts, is kept as a list.
function tileFacts(value, path, width, height) {
  object(value, path, ['terrain', 'corners', 'weight', 'collision', 'oneWay']);
  const tile = {};
  if (value.terrain !== undefined) tile.terrain = name(value.terrain, `${path}.terrain`);
  // A tile of a layered set names the terrains at its four corners (NW, NE, SW, SE) instead of one terrain.
  if (value.corners !== undefined) {
    if (!Array.isArray(value.corners) || value.corners.length !== 4) fail(`${path}.corners`, 'expected the terrains at the tile\'s four corners, [NW, NE, SW, SE], each a terrain name');
    if (value.terrain !== undefined) fail(`${path}.terrain`, 'a tile with corners belongs to the terrains they name; leave terrain out');
    tile.corners = value.corners.map((corner, i) => name(corner, `${path}.corners[${i}]`));
  }
  if (value.weight !== undefined) tile.weight = integer(value.weight, `${path}.weight`, 1, 1000);
  if (value.collision !== undefined) {
    const where = `${path}.collision`, several = Array.isArray(value.collision) && Array.isArray(value.collision[0]?.[0]);
    if (several && value.collision.length > 8) fail(where, 'expected up to 8 polygons');
    tile.collision = several ? value.collision.map((polygon, k) => collisionPolygon(polygon, `${where}[${k}]`, width, height)) : [collisionPolygon(value.collision, where, width, height)];
  }
  if (value.oneWay !== undefined) {
    boolean(value.oneWay, `${path}.oneWay`);
    if (tile.collision === undefined) fail(`${path}.oneWay`, 'oneWay makes the collision polygon one-way; give the tile a collision polygon');
    tile.oneWay = value.oneWay;
  }
  return tile;
}
function collisionPolygon(polygon, where, width, height) {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 32) fail(where, 'expected 3–32 points [x, y] around the solid part of the tile, in canvas pixels: [[0, 0], [16, 0], [16, 16], [0, 16]] is a whole 16-pixel tile; a tile with separate solid parts takes a list of polygons');
  const points = polygon.map((at, i) => {
    const [x, y] = point(at, `${where}[${i}]`);
    if (x < 0 || y < 0 || x > width || y > height) fail(`${where}[${i}]`, `[${x}, ${y}] is outside the ${width}×${height} canvas; points are pixel corners from [0, 0] to [${width}, ${height}]`);
    return [x, y];
  });
  const n = points.length, side = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  // Collinear c on segment ab.
  const on = (a, b, c) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
  const meet = (a, b, c, d) => { const s1 = side(a, b, c), s2 = side(a, b, d), s3 = side(c, d, a), s4 = side(c, d, b); return (s1 !== s2 && s3 !== s4 && s1 * s2 <= 0 && s3 * s4 <= 0) || (!s1 && on(a, b, c)) || (!s2 && on(a, b, d)) || (!s3 && on(c, d, a)) || (!s4 && on(c, d, b)); };
  for (let i = 0; i < n; i++) if (points[i][0] === points[(i + 1) % n][0] && points[i][1] === points[(i + 1) % n][1]) fail(`${where}[${(i + 1) % n}]`, 'repeats the point before it; list each corner once');
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (meet(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) fail(where, `the edge from point ${i} to ${(i + 1) % n} crosses or touches the edge from point ${j} to ${(j + 1) % n}; list the corners in order around the shape`);
  }
  if (!points.reduce((sum, [x, y], i) => sum + x * points[(i + 1) % n][1] - points[(i + 1) % n][0] * y, 0)) fail(where, 'the points enclose no area');
  return points;
}
// A palette override (a frame's, a layer's, a pose's): keys of `palette` to colours or palette names, read as exact
// hex colours. `rule` is said at a key the palette doesn't declare.
export function paletteOverride(value, palette, path, rule) {
  object(value, path);
  const overrides = {};
  for (const [key, colour] of Object.entries(value)) {
    if (!own(palette, key)) fail(`${path}.${key}`, rule);
    overrides[key] = toHex(parseColor(colour, palette, `${path}.${key}`));
  }
  return overrides;
}
export function parseColor(value, palette = {}, path = 'color') {
  if (typeof value !== 'string') fail(path, 'expected a palette name or hex color');
  if (own(palette, value)) value = palette[value];
  if (value === 'transparent') return [0, 0, 0, 0];
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) fail(path, `unknown color ${JSON.stringify(value)}; use a palette name or #RGB, #RGBA, #RRGGBB, #RRGGBBAA`);
  let hex = value.slice(1);
  if (hex.length < 5) hex = [...hex].map(c => c + c).join('');
  if (hex.length === 6) hex += 'ff';
  return [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16));
}

// Moves an exact colour (a pixel id) along the ramp that lists it, clamped at the ramp's ends: shift(id, -1) is one
// step darker. Ramps are lists of palette keys; a colour shared by keys in two ramps follows the first. Returns null
// for colours on no ramp.
export function rampShifter(palette, ramps) {
  const colours = ramps.map(keys => keys.map(key => parseColor(key, palette))), place = new Map();
  colours.forEach((ramp, r) => ramp.forEach((rgba, i) => { const id = pixelId(rgba, 0); if (id && !place.has(id)) place.set(id, [r, i]); }));
  return (id, steps) => {
    const at = place.get(id);
    if (!at) return null;
    const ramp = colours[at[0]];
    return ramp[Math.max(0, Math.min(ramp.length - 1, at[1] + steps))];
  };
}

export function blend(data, i, color, opacity = 1) {
  const a = color[3] / 255 * opacity;
  if (a === 0) return;
  if (a === 1) { data.set(color, i); return; }
  const old = data[i + 3] / 255, out = a + old * (1 - a);
  for (let c = 0; c < 3; c++) data[i + c] = Math.round((color[c] * a + data[i + c] * old * (1 - a)) / out);
  data[i + 3] = Math.round(out * 255);
}
// Final-pixel provenance for palette inspection. Allocate a byte per pixel only after the
// first mix. Exact writes clear it, even when they write the very same RGBA as a previous mix.
class BlendOrigins {
  constructor(size, mask) { this.size = size; this.mask = mask?.slice(); }
  set(at, mixed) {
    if (mixed) (this.mask ??= new Uint8Array(this.size))[at] = 1;
    else if (this.mask) this.mask[at] = 0;
  }
  paint(data, i, color, opacity = 1, inherited = false) {
    if (!color[3] || !opacity) return;
    this.set(i / 4, inherited || opacity < 1 || (color[3] < 255 && data[i + 3] > 0));
    blend(data, i, color, opacity);
  }
}
// Exact colours a rendered frame declares beyond the project palette, including copied pixels.
const frameColours = frame => [...Object.values(frame.palette ?? {}),
  ...(frame.layerPalettes ?? []).flatMap(entry => Object.values(entry.palette)), ...(frame.inherited ?? [])];
// Text rows are all as wide as the first: every miscounted row at once, with its own width, so a hand-typed grid is
// fixed in one pass. What a recipe's grid, a source format's symbol and a patch's rows are checked with.
export function sameWidth(rows, path) {
  const width = rows[0].length, uneven = rows.flatMap((row, y) => row.length === width ? [] : [y]);
  if (uneven.length) fail(`${path}[${uneven[0]}]`, `all rows must be ${width} characters wide, as row 0 is: ${uneven.slice(0, 8).map(y => `row ${y} has ${rows[y].length}`).join(', ')}${uneven.length > 8 ? ` and ${uneven.length - 8} more rows differ` : ''}`);
}
// A grid covers an animation frame: up to CANVAS_SIDE rows of CANVAS_SIDE characters and FRAME_PIXELS cells. A source
// that keeps a smaller canvas reads its rows with its own `side`.
export function readRows(rows, path, palette, side = CANVAS_SIDE) {
  list(rows, path, side);
  if (!rows.length) fail(path, 'grid must contain at least one row');
  if (typeof rows[0] !== 'string' || rows[0].length < 1 || rows[0].length > side) fail(`${path}[0]`, `row must contain 1–${side} characters`);
  const width = rows[0].length;
  rows.forEach((row, y) => { if (typeof row !== 'string') fail(`${path}[${y}]`, `all rows must be ${width} characters wide`); });
  sameWidth(rows, path);
  if (width * rows.length > ROW_CELLS) fail(path, `a ${width}×${rows.length} grid is ${grouped(width * rows.length)} cells; a grid holds at most ${grouped(ROW_CELLS)}, as an animation frame does, so split it into several grids`);
  const unknown = new Map();
  rows.forEach((row, y) => {
    for (const char of row) if (char !== '.' && char !== ' ') {
      // Rows are indexed by UTF-16 code unit, so an astral character (emoji) would split in two.
      if (char.length !== 1) fail(`${path}[${y}]`, `grid characters must be single UTF-16 code units, not ${JSON.stringify(char)}`);
      if (!own(palette, char) && !unknown.has(char)) unknown.set(char, y);
    }
  });
  if (unknown.size) {
    const [[first, y], ...others] = unknown;
    fail(`${path}[${y}]`, `unknown palette character ${JSON.stringify(first)}${others.length ? `; also ${others.slice(0, 8).map(([char, row]) => `${JSON.stringify(char)} in row ${row}`).join(', ')}` : ''}`);
  }
  return { rows, width, height: rows.length };
}
const round6 = value => Math.round(value * 1e6) / 1e6;

// Canvas sizes. A recipe with several frames (an animation) is at most CANVAS_SIDE pixels a side and FRAME_PIXELS a
// frame (320×180, 480×270, 640×360, 512×512 and 1024×256 fit), the same as a scene's view. A recipe with a single
// frame (a still: a backdrop, mural or wallpaper drawn at one pixel per screen pixel) may be up to 4096 a side. Every
// recipe's frames share FRAME_AREA pixels in all, which keeps a still and the studio, the playground, the MCP server
// and the atlas within bounds: 16 frames of 512×512, 72 of 320×180.
export const CANVAS_SIDE = 1024, FRAME_PIXELS = 262144, STILL_SIDE = 4096, FRAME_AREA = 4194304;
// Pose sources (describeStampRecipe, authoring.js) keep 256 a side: a rig's per-frame cost is not budgeted.
export const POSE_SIDE = 256;
// The most cells one grid or symbol holds: a whole animation frame.
const ROW_CELLS = FRAME_PIXELS;
const grouped = value => String(value).replace(/\B(?=(\d{3})+$)/g, ',');
// Whether width × height is an animation frame: at most CANVAS_SIDE a side and FRAME_PIXELS in all. A compiled effect,
// an imported frame, a resized canvas and a scene asset are held to it too, and say so with frameAreaProblem.
export const frameFits = (width, height) => width <= CANVAS_SIDE && height <= CANVAS_SIDE && width * height <= FRAME_PIXELS;
// The per-frame limit in words, without examples (check.js leads its size fixes with it).
export const FRAME_LIMIT = `an animation frame is at most ${CANVAS_SIDE} pixels a side and ${grouped(FRAME_PIXELS)} in all`;
// Screen sizes named as examples, those the limit holds.
const FRAME_EXAMPLES = [[320, 180], [480, 270], [640, 360], [512, 512]].filter(([w, h]) => frameFits(w, h)).map(([w, h]) => `${w}×${h}`);
// What the per-frame limit says of a width × height frame past it (its area, or else a side), with sizes that fit; null
// when it fits. One wording for every recipe, source and asset held to an animation frame.
export function frameAreaProblem(width, height) {
  if (frameFits(width, height)) return null;
  const past = width * height > FRAME_PIXELS ? `is ${grouped(width * height)} pixels` : `is past ${CANVAS_SIDE} pixels a side`;
  return `a ${width}×${height} frame ${past}; ${FRAME_LIMIT} (${FRAME_EXAMPLES.slice(0, -1).join(', ')} and ${FRAME_EXAMPLES.at(-1)} fit)`;
}
// What the total says when `count` frames of width × height pass FRAME_AREA, with how many of that size fit; null
// when they fit. One wording for every recipe and source that makes frames.
export function frameTotalProblem(count, width, height) {
  if (width * height * count <= FRAME_AREA) return null;
  const fit = Math.floor(FRAME_AREA / (width * height));
  return `${count} frames of ${width}×${height} are ${grouped(width * height * count)} pixels; a recipe's frames hold at most ${grouped(FRAME_AREA)} in all, so ${fit ? `${fit} frame${fit === 1 ? '' : 's'} of ${width}×${height} fit` : `not one frame of ${width}×${height} fits`}: use fewer frames or a smaller canvas`;
}
// The sheet's columns when the recipe gives none: up to 8, and as many frames as keep the sheet within 4096 pixels
// wide at scale 1 (one column at least).
export const sheetColumns = (frames, width) => Math.min(frames, 8, Math.max(1, Math.floor(4096 / width)));
// The largest image one PNG holds (png.js), so each scaled frame of an export fits it.
const PNG_PIXELS = 16777216;
// The largest whole scale below `scale` at which `pixels` (their count at scale 1) stay within `limit`, or 0 when not
// even scale 1 does: what a budget refusal names.
export function largestScale(pixels, limit, scale) {
  let k = scale - 1;
  while (k >= 1 && pixels * k * k > limit) k--;
  return k;
}
// What may stand in a layer with sort "ground", and what works on an area instead.
const STANDING = new Set(['pixel', 'rect', 'ellipse', 'line', 'polygon', 'grid', 'stamp', 'text', 'copy', 'autotile', 'box']);
const AREA = new Set(['clear', 'fill', 'replace', 'tilemap', 'outline', 'dither', 'shade', 'rewrite']);

// `stills: false` keeps a document to the animation limit even with one frame, and `side` gives a source that keeps a
// smaller canvas its own (pose sources compile to animations at most POSE_SIDE a side).
function readProject(spec, { stills = true, side: most = CANVAS_SIDE } = {}) {
  object(spec, 'project', ['$schema', 'version', 'name', 'width', 'height', 'palette', 'ramps', 'background', 'symbols', 'parts', 'scaleTracks', 'frames', 'animations', 'sheet', 'anchor']);
  if (spec.version !== 1) fail('project.version', 'expected 1');
  const projectName = name(spec.name, 'project.name');
  const frameCount = Array.isArray(spec.frames) ? spec.frames.length : 0, still = stills && frameCount === 1;
  const side = (value, path) => {
    if (stills && frameCount > 1 && Number.isInteger(value) && value > most && value <= STILL_SIDE) fail(path, `expected an integer from 1 to ${most}; only a single-frame still may be larger (up to ${STILL_SIDE}), and this recipe has ${frameCount} frames`);
    return integer(value, path, 1, still ? STILL_SIDE : most);
  };
  const width = side(spec.width, 'project.width'), height = side(spec.height, 'project.height');
  if (still && width * height > FRAME_AREA) fail('project', `a ${width}×${height} still is ${grouped(width * height)} pixels; a still holds at most 4,194,304 (1920×1080, 2560×1440 and 2048×2048 fit), so draw it smaller or enlarge a smaller canvas with sheet.scale`);
  if ((frameCount > 1 || !stills) && width * height > FRAME_PIXELS) fail('project', `${frameAreaProblem(width, height)}, so draw it smaller or enlarge a smaller canvas with sheet.scale${stills ? '; only a single-frame still may be larger' : ''}`);
  const palette = spec.palette ?? {};
  object(palette, 'project.palette');
  if (own(palette, '$ref')) fail('project.palette.$ref', 'palette files are resolved by the CLI, MCP or resolveRecipe(); inline the palette to render here');
  if (Object.keys(palette).length > 256) fail('project.palette', 'at most 256 colors are allowed');
  for (const [key, value] of Object.entries(palette)) {
    if (key === '.' || key === ' ') fail(`project.palette.${key}`, '"." and space are reserved: in grid rows they leave the pixel alone and need no palette entry (a transparent colour is "transparent" under another key)');
    if (!key || key.length > 64 || key === 'transparent') fail(`project.palette.${key}`, 'invalid or reserved palette name');
    parseColor(value, {}, `project.palette.${key}`);
  }
  // Ramps list palette keys from dark to light. `shade` and scene ramp lighting move a colour along its ramp instead of
  // inventing a darker one, so shading keeps the palette. A key belongs to one ramp.
  const ramps = spec.ramps === undefined ? [] : list(spec.ramps, 'project.ramps', 64), rampKeys = new Set();
  ramps.forEach((ramp, r) => {
    list(ramp, `project.ramps[${r}]`, 32);
    if (ramp.length < 2) fail(`project.ramps[${r}]`, 'a ramp lists 2–32 palette keys from dark to light');
    ramp.forEach((key, i) => {
      if (typeof key !== 'string' || !own(palette, key)) fail(`project.ramps[${r}][${i}]`, 'expected a key of the project palette');
      if (rampKeys.has(key)) fail(`project.ramps[${r}][${i}]`, `${JSON.stringify(key)} is already in a ramp; a key belongs to one ramp`);
      rampKeys.add(key);
    });
  });
  const background = parseColor(spec.background ?? 'transparent', palette, 'project.background');
  const projectAnchor = spec.anchor === undefined ? null : point(spec.anchor, 'project.anchor');
  const symbols = Object.create(null);
  object(spec.symbols ?? {}, 'project.symbols');
  for (const [key, rows] of Object.entries(spec.symbols ?? {})) {
    name(key, `project.symbols.${key}`);
    symbols[key] = readRows(rows, `project.symbols.${key}`, palette, most);
  }
  list(spec.frames, 'project.frames', 256);
  if (!spec.frames.length) fail('project.frames', 'at least one frame is required');
  const total = frameTotalProblem(spec.frames.length, width, height);
  if (total) fail('project.frames', total);
  object(spec.animations ?? {}, 'project.animations');
  const animationCount = spec.animations === undefined ? 1 : Object.keys(spec.animations).length;
  // Support files: sheet, atlas, SpriteFrames, recipe, CSS, player, preview and README, and a Godot TileSet and a Tiled
  // tileset for a tile set.
  if (10 + spec.frames.length + animationCount > 65535) fail('project.animations', `bundle exceeds the ZIP32 limit of 65,535 files; at most ${65535 - 10 - spec.frames.length} animations fit alongside these frames and 10 support files`);
  return { projectName, width, height, palette, ramps, background, projectAnchor, symbols };
}

/**
 * Puts a shared palette file's colours into a document whose palette links it (`"palette": { "$ref": "shared.json",
 * ...local entries }`). `shared` is the file as read, `{ palette, ramps }`: entries the document sets itself win, and a
 * recipe or pose source without ramps of its own takes the file's (autotile, effect, fluid, wave and normals sources
 * have no ramps). A document without a link comes back as it is. The renderer never reads files: the CLI and MCP read
 * the file (src/resolve.js), and the studio is sent the one its recipe links, so both draw a linked recipe alike.
 */
export function inlineSharedPalette(document, { palette, ramps = null }) {
  if (!isObject(document) || !isObject(document.palette) || !own(document.palette, '$ref')) return document;
  const { $ref, ...local } = document.palette;
  const inherit = ramps && (document.format === undefined || document.format === 'pixelforge-poses') && document.ramps === undefined;
  return { ...document, palette: { ...palette, ...local }, ...(inherit && { ramps }) };
}

// Emit disjoint inclusive spans, so translucent edges and shared vertices paint each pixel once.
// Interior spans pair crossings at pixel centres (even-odd). Trace each boundary from its upper
// endpoint so a Bresenham tie selects the same pixel when the vertex order is reversed.
function polygonSpans(points, filled, spend, visit) {
  const ys = points.map(([, y]) => y), top = Math.min(...ys), bottom = Math.max(...ys);
  const sides = points.map(([x, y], i) => {
    let [endX, endY] = points[(i + 1) % points.length];
    if (y > endY || (y === endY && x > endX)) { [x, endX] = [endX, x]; [y, endY] = [endY, y]; }
    return { x, y, endX, endY, dx: Math.abs(endX - x), dy: endY - y, step: Math.sign(endX - x) };
  });
  spend((bottom - top + 1) * sides.length);
  for (let row = top; row <= bottom; row++) {
    const edges = [], crossings = [];
    for (const { x, y, endX, endY, dx, dy, step } of sides) {
      if (row < y || row > endY) continue;
      if (!dy) { edges.push([x, endX]); continue; }
      const k = row - y;
      if (filled && row < endY) crossings.push(x + step * dx * (k + .5) / dy);
      // A steep line visits one column on this row. For a shallow line, collect all
      // major-axis steps whose rounded minor-axis coordinate is k (the line op's ties).
      if (dy >= dx) {
        const px = x + step * Math.round(k * dx / dy);
        edges.push([px, px]);
      } else {
        const a = x + step * Math.max(0, Math.ceil((k - .5) * dx / dy));
        const b = x + step * Math.min(dx, Math.ceil((k + .5) * dx / dy) - 1);
        edges.push([Math.min(a, b), Math.max(a, b)]);
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i < crossings.length; i += 2) {
      const left = Math.ceil(crossings[i] - .5), right = Math.ceil(crossings[i + 1] - .5) - 1;
      if (left <= right) edges.push([left, right]);
    }
    edges.sort((a, b) => a[0] - b[0]);
    let [left, right] = edges[0];
    for (let i = 1; i < edges.length; i++) {
      const [lo, hi] = edges[i];
      if (lo > right + 1) { visit(row, left, right); left = lo; }
      right = Math.max(right, hi);
    }
    visit(row, left, right);
  }
}

// A part keeps its original vertices, including negative coordinates. Its instance scales around
// the local pivot, rasterizes on an unbounded integer grid, then reflects spans into canvas space.
const partFields = { pixel: [], line: ['x2', 'y2'], polygon: ['points', 'filled'] };
const trackEases = ['linear', 'hold', 'in', 'out', 'inOut'];
const trackLimit = 256 * 60000;
function scalePair(value, path) {
  if (!Array.isArray(value)) { const s = number(value, path, 0, 16); return [s, s]; }
  if (value.length !== 2) fail(path, 'expected a scale or [scaleX, scaleY]');
  return value.map((s, i) => number(s, `${path}[${i}]`, 0, 16));
}
function readPart(part, path, palette) {
  object(part, path, ['pivot', 'ops']);
  const pivot = point(part.pivot ?? [0, 0], `${path}.pivot`);
  const shapes = list(part.ops, `${path}.ops`).map((op, i) => {
    const p = `${path}.ops[${i}]`;
    object(op, p);
    if (typeof op.op !== 'string' || !own(partFields, op.op)) fail(`${p}.op`, 'a polygon part takes polygon, line or pixel');
    object(op, p, ['op', 'x', 'y', 'color', ...partFields[op.op]]);
    parseColor(op.color, palette, `${p}.color`);
    const x = integer(op.x ?? 0, `${p}.x`), y = integer(op.y ?? 0, `${p}.y`);
    let points = [[x, y]], filled = true;
    if (op.op === 'line') points.push([integer(op.x2, `${p}.x2`), integer(op.y2, `${p}.y2`)]);
    if (op.op === 'polygon') {
      points = polygonPoints(op, p).map(([px, py]) => [px + x, py + y]);
      filled = boolean(op.filled ?? true, `${p}.filled`);
    }
    return { color: op.color, filled, points: points.map(([px, py]) => [px - pivot[0], py - pivot[1]]) };
  });
  return shapes;
}
function polygonPoints(op, path) {
  if (!Array.isArray(op.points) || op.points.length < 3 || op.points.length > 256) fail(`${path}.points`, 'expected 3–256 vertices as [x, y] pairs');
  return op.points.map((at, i) => point(at, `${path}.points[${i}]`));
}
function readTrack(track, path) {
  object(track, path, ['keys', 'loop', 'ease']);
  const loop = boolean(track.loop ?? false, `${path}.loop`), easing = track.ease ?? 'linear';
  if (!trackEases.includes(easing)) fail(`${path}.ease`, `expected ${trackEases.join(', ')}`);
  list(track.keys, `${path}.keys`, 256);
  if (!track.keys.length || (loop && track.keys.length < 2)) fail(`${path}.keys`, 'expected at least one scale key, or two for a loop');
  let previous = -1;
  const keys = track.keys.map((key, i) => {
    const p = `${path}.keys[${i}]`;
    object(key, p, ['at', 'scale']);
    const at = integer(key.at, `${p}.at`, 0, trackLimit);
    if (at <= previous || (loop && i === 0 && at !== 0)) fail(`${p}.at`, 'key times must increase; a loop starts at 0 ms');
    previous = at;
    return { at, scale: scalePair(key.scale, `${p}.scale`) };
  });
  return { keys, loop, easing };
}
function definitions(value, path, read) {
  const entries = Object.entries(object(value ?? {}, path));
  if (entries.length > 64) fail(path, 'at most 64 definitions');
  return new Map(entries.map(([key, definition]) => {
    const p = `${path}.${key}`;
    return [name(key, p), read(definition, p)];
  }));
}
function sampleTrack({ keys, loop, easing }, time) {
  const last = keys[keys.length - 1];
  if (loop) time = ((time % last.at) + last.at) % last.at;
  if (time <= keys[0].at) return keys[0].scale;
  if (time >= last.at) return last.scale;
  const i = keys.findIndex(key => key.at >= time), a = keys[i - 1], b = keys[i];
  if (time === b.at) return b.scale;
  const t = ease(easing, (time - a.at) / (b.at - a.at));
  return a.scale.map((start, axis) => start + t * (b.scale[axis] - start));
}

export function renderProject(spec, options = {}) {
  object(options, 'render', ['layers', 'stats', 'owners']);
  if (options.stats !== undefined) boolean(options.stats, 'render.stats');
  if (options.owners !== undefined) boolean(options.owners, 'render.owners');
  if (options.layers !== undefined) {
    renderProject(spec); // Validate the complete recipe before hiding any drawing.
    list(options.layers, 'render.layers', 64);
    if (!options.layers.length) fail('render.layers', 'select at least one named layer');
    const known = new Set(spec.frames.flatMap(f => (f.layers ?? []).map(l => l.name).filter(Boolean)));
    for (const ref of options.layers) if (typeof ref !== 'string' || !known.has(ref)) fail('render.layers', `unknown layer ${JSON.stringify(ref)}`);
    const isolated = structuredClone(spec); isolated.background = 'transparent';
    for (const frame of isolated.frames) { delete frame.ops; delete frame.pixels; frame.layers = (frame.layers ?? []).filter(layer => options.layers.includes(layer.name)); }
    return renderProject(isolated, { ...(options.stats && { stats: true }), ...(options.owners && { owners: true }) });
  }
  const { projectName, width, height, palette, ramps, background, projectAnchor, symbols } = readProject(spec);
  const parts = definitions(spec.parts, 'project.parts', (value, path) => readPart(value, path, palette));
  const tracks = definitions(spec.scaleTracks, 'project.scaleTracks', readTrack);
  // Rectangles, ellipses and dither or shade regions may overhang the canvas: up to 512 pixels, or twice the canvas's
  // side when that is over 256.
  const boxWidth = Math.max(512, 2 * width), boxHeight = Math.max(512, 2 * height);
  let activePalette = palette;
  const color = (value, path) => parseColor(value, activePalette, path);
  let work = 0, operationCount = 0, layerPixels = 0;
  // With owners, each frame also records what drew each pixel last: a number into ownerNames (a layer's name, or
  // layers[i] for an unnamed one, background, frame.ops or frame.pixels), 0 for nothing. Only the parts view asks.
  const ownerNames = options.owners ? [] : null, ownerIds = new Map();
  const ownerId = label => { if (!ownerIds.has(label)) { ownerNames.push(label); ownerIds.set(label, ownerNames.length); } return ownerIds.get(label); };
  const spend = amount => { work += amount; if (work > 67108864) fail('project', 'drawing work exceeds the 67-million-pixel budget; simplify repeated operations'); };
  // An invalid drawing operation is noted and skipped while the rest are checked, so one reply names every broken
  // operation (up to ten) instead of one per run. Operations don't depend on each other being valid, and a render that
  // noted one returns no pixels. Anything else (a frame field, animations, the sheet, a budget) still stops at once.
  const noted = [];
  const note = (error, p) => {
    const inside = error instanceof PixelError && !error.errors && (error.path === p || error.path.startsWith(`${p}.`) || error.path.startsWith(`${p}[`));
    if (!inside) throw error;
    noted.push(error);
    if (noted.length === 10) throw together();
  };
  // The first error, naming the others in its message and listing every one in `errors`.
  const together = (last = null) => joinErrors(last && !last.errors && !noted.includes(last) ? [...noted, last] : noted, noted.length === 10);
  const checked = run => { try { return run(); } catch (error) { throw noted.length && !error.errors ? together(error) : error; } };
  // Clipping is counted per source location so an agent can find the operation that overhangs.
  const clipped = new Map();
  const clip = (path, pixels = 1) => clipped.set(path, (clipped.get(path) ?? 0) + pixels);
  // Outlines that found nothing in their buffer to surround, by the operation's path.
  const hollow = [];
  // Frames that set a palette and draw nothing of their own, as [name, the frame continued or undefined]: a frame
  // palette recolours the frame's own drawing, so there it changes nothing.
  const idlePalettes = [];
  const rendered = new Map(), frameNames = new Set();
  // Colours a frame takes from an earlier frame as exact RGBA, which its own palettes need not name: what the frame it
  // continues (`from`) or copies from recoloured with a frame or layer palette, and what that frame took the same way.
  // Diagnostics count them as declared for the frame (`inherited`); drawing never reads them.
  let taken = null;
  const take = source => {
    for (const value of frameColours(source)) taken.add(value);
  };
  // The row an operation stands on, for a layer with sort "ground": its `ground`, or the lowest row it draws (a
  // stamp's or grid's bottom after scale and rotation, a line's lower end, a shape's bottom edge). Text needs `ground`,
  // since accents and alignment move it. Operations that work on an area rather than stand on the ground are refused.
  // Malformed values count as their own y here and are reported when the operation is drawn.
  const whole = (value, fallback) => (Number.isInteger(value) ? value : fallback);
  const standingRow = (op, p) => {
    if (!isObject(op) || typeof op.op !== 'string') return 0;
    if (!STANDING.has(op.op)) {
      if (AREA.has(op.op)) fail(`${p}.op`, `${op.op} works on an area rather than standing on the ground; draw it in a layer without sort`);
      return 0;
    }
    if (op.ground !== undefined) return integer(op.ground, `${p}.ground`);
    if (op.op === 'text') fail(`${p}.ground`, 'text in a layer with sort "ground" needs ground: the row it stands on');
    const y = whole(op.y, 0), turned = op.rotate === 90 || op.rotate === 270, scale = whole(op.scale, 1);
    const box = (w, h) => y + (turned ? w : h) * scale - 1;
    if (op.op === 'pixel') return y;
    if (op.op === 'line') return Math.max(y, whole(op.y2, y));
    if (op.op === 'polygon') return y + (Array.isArray(op.points) && op.points.length && op.points.length <= 256 ? Math.max(...op.points.map(pt => whole(pt?.[1], 0))) : 0);
    if (op.op === 'rect' || op.op === 'ellipse') return y + whole(op.h, 1) - 1;
    if (op.op === 'grid') return Array.isArray(op.rows) && typeof op.rows[0] === 'string' ? box(op.rows[0].length, op.rows.length) : y;
    const grid = typeof op.symbol === 'string' && own(symbols, op.symbol) ? symbols[op.symbol] : null;
    if (op.op === 'stamp') return grid ? box(grid.width, grid.height) : y;
    if (op.op === 'autotile') return grid ? y + grid.width / 2 - 1 : y;
    if (op.op === 'box') return y + Math.floor((whole(op.w, 2) + whole(op.d, 2)) / 2) + whole(op.h, 0) - 1;
    // copy: the copied rectangle, from a symbol or from an earlier frame (the canvas).
    const [sourceWidth, sourceHeight] = grid ? [grid.width, grid.height] : [width, height];
    return box(whole(op.w, sourceWidth - whole(op.sx, 0)), whole(op.h, sourceHeight - whole(op.sy, 0)));
  };
  // Charge the full span to the work budget, then paint only the pixels that reach the destination.
  function paintSpan(row, left, right, path, paint) {
    const length = right - left + 1;
    spend(length);
    if (row < 0 || row >= height) { clip(path, length); return; }
    const first = Math.max(0, left), last = Math.min(width - 1, right);
    const lost = length - Math.max(0, last - first + 1);
    if (lost) clip(path, lost);
    for (let px = first; px <= last; px++) paint(px, row);
  }
  // Operations draw in list order; ground-sorted layers draw far to near and ties keep list order.
  // A part layer paints its transformed geometry first, then any canvas-space operations.
  function drawOps(data, ops, path, origins, bounds = null, sorted = false, instance = null) {
    // Conservative dirty bounds, including writes later erased. Global operations still see the complete buffer.
    const touch = (x, y) => {
      if (!bounds) return;
      if (x < bounds[0]) bounds[0] = x;
      if (y < bounds[1]) bounds[1] = y;
      if (x > bounds[2]) bounds[2] = x;
      if (y > bounds[3]) bounds[3] = y;
    };
    if (instance) {
      const { shapes, scale, dx, dy, signX, signY } = instance;
      for (const shape of shapes) {
        if (++operationCount > 20000) fail(instance.path, 'project exceeds 20,000 drawing operations');
        const c = color(shape.color, instance.path);
        const points = shape.points.map(([x, y]) => [Math.round(x * scale[0]), Math.round(y * scale[1])]);
        const paint = (x, y) => {
          if (c[3]) touch(x, y);
          origins.paint(data, (y * width + x) * 4, c);
        };
        const span = (row, left, right) => paintSpan(dy + signY * row, dx + (signX > 0 ? left : -right), dx + (signX > 0 ? right : -left), instance.path, paint);
        if (points.length === 1) span(points[0][1], points[0][0], points[0][0]);
        else if (points.length === 2) traceLine(...points[0], ...points[1], (x, y) => span(y, x, x));
        else polygonSpans(points, shape.filled, spend, span);
      }
    }
    list(ops, path);
    const order = ops.map((_, index) => index), refused = new Set();
    if (sorted) {
      // An operation a sorted layer cannot take is noted like any other broken one, before the layer draws, and
      // skipped; the rest still sort and are still checked.
      const rows = ops.map((op, index) => {
        const p = `${path}[${index}]`;
        try { return standingRow(op, p); } catch (error) { note(error, p); refused.add(index); return 0; }
      });
      order.sort((a, b) => rows[a] - rows[b] || a - b);
    }
    for (const index of order) {
      // A budget, not a broken operation: it stops the check, joined to whatever was noted before it.
      if (++operationCount > 20000) fail(path, 'project exceeds 20,000 drawing operations');
      if (refused.has(index)) continue;
      const p = `${path}[${index}]`;
      try { drawOp(ops[index], p); } catch (error) { note(error, p); }
    }
    function drawOp(op, p) {
      object(op, p);
      const transform = ['scale', 'flipX', 'flipY', 'rotate'];
      const fields = {
        pixel: ['x', 'y', 'color', 'ground'], rect: ['x', 'y', 'w', 'h', 'color', 'filled', 'ground'],
        ellipse: ['x', 'y', 'w', 'h', 'color', 'filled', 'ground'], line: ['x', 'y', 'x2', 'y2', 'color', 'ground'],
        polygon: ['x', 'y', 'points', 'color', 'filled', 'ground'],
        clear: ['x', 'y', 'w', 'h'], fill: ['x', 'y', 'color'],
        grid: ['x', 'y', 'rows', ...transform, 'remap', 'ground'],
        stamp: ['x', 'y', 'symbol', ...transform, 'remap', 'ground'], replace: ['from', 'to'],
        text: ['x', 'y', 'text', 'color', 'align', 'spacing', 'lineHeight', ...transform, 'ground'],
        copy: ['x', 'y', 'from', 'symbol', 'sx', 'sy', 'w', 'h', ...transform, 'remap', 'ground'],
        autotile: ['x', 'y', 'symbol', 'mask', 'mode', 'remap', 'ground'],
        box: ['x', 'y', 'w', 'd', 'h', 'top', 'left', 'right', 'edge', 'ground'],
        tilemap: ['x', 'y', 'tile', 'rows', 'legend', 'outside', 'empty', 'classes', 'seed', 'layout'],
        outline: ['color', 'diagonal', 'position', 'width', 'directions'],
        dither: ['x', 'y', 'w', 'h', 'color', 'erase', 'density', 'direction', 'pattern', 'offset', 'seed', 'scale', 'over'],
        shade: ['x', 'y', 'w', 'h', 'steps', 'shape', 'density', 'direction', 'pattern', 'offset', 'seed', 'scale', 'over'],
        rewrite: ['x', 'y', 'w', 'h', 'rules', 'empty', 'steps', 'chance', 'limit', 'seed', 'rotate', 'mirror']
      };
      if (typeof op.op !== 'string' || !own(fields, op.op)) fail(`${p}.op`, typeof op.op === 'string' ? unknownName('operation', op.op, Object.keys(fields), OP_ALIASES) : `unknown operation ${JSON.stringify(op.op)}; operations: ${Object.keys(fields).join(', ')}`);
      object(op, p, ['op', ...fields[op.op]]);
      if (op.ground !== undefined && !sorted) fail(`${p}.ground`, 'ground orders a layer with sort "ground"; set sort on this layer, or remove ground');
      const x = integer(op.x ?? 0, `${p}.x`), y = integer(op.y ?? 0, `${p}.y`);
      const put = (px, py, c, erase = false, mixed = false) => {
        if (px < 0 || py < 0 || px >= width || py >= height) { clip(p); return; }
        const at = (py * width + px) * 4;
        if (!erase && c[3]) touch(px, py);
        if (erase) { data.fill(0, at, at + 4); origins.set(at / 4, false); }
        else origins.paint(data, at, c, 1, mixed);
      };
      // Palette characters, optionally remapped to other palette keys or colors for this operation only.
      const paletteSampler = () => {
        const remap = new Map(), cache = new Map();
        if (op.remap !== undefined) {
          object(op.remap, `${p}.remap`);
          for (const [char, value] of Object.entries(op.remap)) {
            if (char.length !== 1 || char === '.' || char === ' ') fail(`${p}.remap.${char}`, 'remap keys are single grid characters other than dot or space');
            remap.set(char, color(value, `${p}.remap.${char}`));
          }
        }
        return char => {
          if (char === '.' || char === ' ') return null;
          if (!cache.has(char)) cache.set(char, remap.get(char) ?? color(char, `${p}.rows`));
          return cache.get(char);
        };
      };
      // Draws a w x h source through flip, rotation and integer scale; flips happen before rotation. `shift` moves
      // the drawing by [dx, dy], given the scale, rotation and vertical flip (text alignment, and accents above the
      // first line).
      const drawCells = (w, h, sample, shift = () => [0, 0], mixedAt) => {
        const scale = integer(op.scale ?? 1, `${p}.scale`, 1, 16);
        const flipX = boolean(op.flipX ?? false, `${p}.flipX`), flipY = boolean(op.flipY ?? false, `${p}.flipY`);
        const rotate = integer(op.rotate ?? 0, `${p}.rotate`, 0, 270);
        if (rotate % 90) fail(`${p}.rotate`, 'expected 0, 90, 180 or 270 degrees clockwise');
        spend(w * h * scale * scale);
        const [dx, dy] = shift({ scale, rotate, flipY }), left = x + dx, top = y + dy;
        for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) {
          const c = sample(gx, gy);
          if (!c) continue;
          let px = flipX ? w - 1 - gx : gx, py = flipY ? h - 1 - gy : gy;
          if (rotate === 90) [px, py] = [h - 1 - py, px];
          else if (rotate === 180) [px, py] = [w - 1 - px, h - 1 - py];
          else if (rotate === 270) [px, py] = [py, w - 1 - px];
          const mixed = mixedAt?.(gx, gy);
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(left + px * scale + sx, top + py * scale + sy, c, false, mixed);
        }
      };
      // The canvas-anchored threshold field shared by dither and shade: a region from x/y (to the canvas edge unless w/h
      // say otherwise), a density or [from, to] ramp along a direction, and a pattern. The returned function visits
      // every pixel of the region, optionally limited by `inside(i, j, w, h)`, whose threshold is below the density.
      const densityField = (fallback, inside = null) => {
        const w = integer(op.w ?? Math.max(1, width - x), `${p}.w`, 1, boxWidth), h = integer(op.h ?? Math.max(1, height - y), `${p}.h`, 1, boxHeight);
        const ramp = Array.isArray(op.density);
        if (ramp && op.density.length !== 2) fail(`${p}.density`, 'expected a number from 0 to 1, or [from, to]');
        const [from, to] = ramp ? op.density : [op.density ?? fallback, op.density ?? fallback];
        number(from, `${p}.density${ramp ? '[0]' : ''}`, 0, 1); number(to, `${p}.density${ramp ? '[1]' : ''}`, 0, 1);
        if (op.direction !== undefined && !ramp) fail(`${p}.direction`, 'direction applies to a density ramp such as [0, 1]');
        const direction = op.direction ?? 'down';
        if (!['down', 'up', 'right', 'left', 'radial'].includes(direction)) fail(`${p}.direction`, 'expected down, up, right, left or radial');
        const pattern = op.pattern ?? 'bayer4', problem = patternProblem(pattern);
        if (problem) fail(`${p}.pattern${problem[0]}`, problem[1]);
        if (op.seed !== undefined && pattern !== 'noise' && pattern !== 'value') fail(`${p}.seed`, 'seed chooses the noise or value pattern; set pattern to noise or value');
        if (op.scale !== undefined && pattern !== 'value') fail(`${p}.scale`, 'scale sets the size of the value pattern\'s clumps; set pattern to value');
        const seed = integer(op.seed ?? 0, `${p}.seed`, 0, 2147483647), clumps = integer(op.scale ?? 4, `${p}.scale`, 1, 64);
        const threshold = ditherThreshold(pattern, op.offset === undefined ? [0, 0] : point(op.offset, `${p}.offset`), seed, clumps);
        return visit => {
          spend(w * h);
          for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            if (inside && !inside(i, j, w, h)) continue;
            let s = 0;
            if (direction === 'radial') { const u = (i + 0.5) / w * 2 - 1, v = (j + 0.5) / h * 2 - 1; s = Math.min(1, Math.sqrt(u * u + v * v)); }
            else s = direction === 'down' ? (j + 0.5) / h : direction === 'up' ? 1 - (j + 0.5) / h : direction === 'right' ? (i + 0.5) / w : 1 - (i + 0.5) / w;
            const px = x + i, py = y + j;
            if (!(threshold(px, py) < from + (to - from) * s)) continue;
            if (px < 0 || py < 0 || px >= width || py >= height) { clip(p); continue; }
            visit(px, py);
          }
        };
      };
      // `over`: only pixels whose exact current colour is listed.
      const overSet = () => op.over === undefined ? null : new Set((typeof op.over === 'string' ? [op.over] : list(op.over, `${p}.over`, 64)).map((value, i) => pixelId(color(value, typeof op.over === 'string' ? `${p}.over` : `${p}.over[${i}]`), 0)));
      // One autotile tile at left/top: the four quarters that a neighbour mask selects from a template symbol two tiles
      // wide and three tall (see autotile.js). Blob masks are reduced (a diagonal counts only with both of its sides); a
      // corner tile's quarters are the inner quarters of the four cells it sits between.
      const drawTemplate = (grid, mask, mode, left, top, sample, where) => {
        const tile = grid.width / 2;
        if (!Number.isInteger(tile) || tile % 2 || grid.height !== tile * 3) fail(where, 'an autotile template is two tiles wide and three tall, with an even tile size');
        const pieces = tilePieces(mode, mask), q = tile / 2;
        spend(tile * tile);
        for (const [position, [ox, oy]] of [['tl', [0, 0]], ['tr', [q, 0]], ['bl', [0, q]], ['br', [q, q]]]) {
          if (!pieces[position]) continue;
          const [sx, sy] = templatePiece(tile, pieces[position].from, pieces[position].piece);
          for (let gy = 0; gy < q; gy++) for (let gx = 0; gx < q; gx++) { const c = sample(grid.rows[sy + gy][sx + gx]); if (c) put(left + ox + gx, top + oy + gy, c); }
        }
      };
      if (op.op === 'pixel') { spend(1); put(x, y, color(op.color, `${p}.color`)); }
      else if (['rect', 'ellipse', 'clear'].includes(op.op)) {
        const w = integer(op.w, `${p}.w`, 1, boxWidth), h = integer(op.h, `${p}.h`, 1, boxHeight);
        const c = op.op === 'clear' ? [0, 0, 0, 0] : color(op.color, `${p}.color`);
        const filled = op.filled === undefined ? true : boolean(op.filled, `${p}.filled`);
        spend(w * h);
        const inside = (i, j) => ((i + .5 - w / 2) / (w / 2)) ** 2 + ((j + .5 - h / 2) / (h / 2)) ** 2 <= 1;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          const draw = op.op === 'ellipse'
            ? inside(i, j) && (filled || !inside(i - 1, j) || !inside(i + 1, j) || !inside(i, j - 1) || !inside(i, j + 1))
            : filled || i === 0 || j === 0 || i === w - 1 || j === h - 1;
          if (draw) put(x + i, y + j, c, op.op === 'clear');
        }
      } else if (op.op === 'line') {
        const x2 = integer(op.x2, `${p}.x2`), y2 = integer(op.y2, `${p}.y2`), c = color(op.color, `${p}.color`);
        spend(Math.max(Math.abs(x2 - x), Math.abs(y2 - y)) + 1);
        traceLine(x, y, x2, y2, (px, py) => put(px, py, c));
      } else if (op.op === 'polygon') {
        const points = polygonPoints(op, p);
        const c = color(op.color, `${p}.color`), filled = boolean(op.filled ?? true, `${p}.filled`);
        const paint = (px, py) => put(px, py, c);
        polygonSpans(points, filled, spend, (row, left, right) => paintSpan(row + y, left + x, right + x, p, paint));
      } else if (op.op === 'grid' || op.op === 'stamp') {
        if (op.op === 'stamp' && typeof op.symbol !== 'string') fail(`${p}.symbol`, 'expected a string naming a symbol');
        const grid = op.op === 'grid' ? readRows(op.rows, `${p}.rows`, palette) : symbols[op.symbol];
        if (!grid) fail(`${p}.symbol`, `unknown symbol ${JSON.stringify(op.symbol)}`);
        const sample = paletteSampler();
        drawCells(grid.width, grid.height, (gx, gy) => sample(grid.rows[gy][gx]));
      } else if (op.op === 'text') {
        // Text in the built-in font. x is the block's left edge, its centre or its right edge, by `align`; y is the
        // top of the first line's capitals, and the accents of capitals in that line reach two rows above it.
        if (typeof op.text !== 'string' || !op.text.length || op.text.length > 512) fail(`${p}.text`, 'expected 1–512 characters');
        if (op.text.split('\n').length > 64) fail(`${p}.text`, 'at most 64 lines');
        const align = op.align ?? 'left';
        if (!['left', 'center', 'right'].includes(align)) fail(`${p}.align`, 'expected left, center or right');
        const spacing = integer(op.spacing ?? 1, `${p}.spacing`, 0, 16), lineHeight = integer(op.lineHeight ?? 10, `${p}.lineHeight`, 1, 64);
        const block = layoutText(op.text, { spacing, lineHeight, align }, message => fail(`${p}.text`, message)), c = color(op.color, `${p}.color`);
        if (block.width > 4096) fail(`${p}.text`, `a line is ${block.width} pixels wide; break it into lines`);
        // The accent rows above the first line (-block.top of them) end up on one side of the drawn block, by the
        // rotation and vertical flip. Only where that side is the top or the left does the block move back by them,
        // and alignment measures the letters without them, so the letters stay put whether or not a line has accents.
        drawCells(block.width, block.height, (gx, gy) => block.rows[gy][gx] === '#' ? c : null, ({ scale, rotate, flipY }) => {
          const accents = -block.top, across = rotate % 180 !== 0, first = !flipY !== (rotate === 90 || rotate === 180);
          const drawn = (across ? block.height - accents : block.width) * scale, back = first ? -accents * scale : 0;
          const aligned = align === 'center' ? -Math.floor(drawn / 2) : align === 'right' ? -drawn : 0;
          return across ? [aligned + back, 0] : [aligned, back];
        });
      } else if (op.op === 'copy') {
        // Copies a rectangle of a symbol (palette characters) or of an earlier frame (exact RGBA).
        if ((op.from === undefined) === (op.symbol === undefined)) fail(p, 'copy needs exactly one of from (an earlier frame) or symbol');
        let sourceWidth, sourceHeight, read, mixedAt;
        if (op.symbol !== undefined) {
          if (typeof op.symbol !== 'string') fail(`${p}.symbol`, 'expected a string naming a symbol');
          const grid = symbols[op.symbol];
          if (!grid) fail(`${p}.symbol`, `unknown symbol ${JSON.stringify(op.symbol)}`);
          const sample = paletteSampler();
          [sourceWidth, sourceHeight, read] = [grid.width, grid.height, (sx, sy) => sample(grid.rows[sy][sx])];
        } else {
          if (typeof op.from !== 'string' || !rendered.has(op.from)) fail(`${p}.from`, 'must name an earlier frame');
          // A frame copy keeps exact RGBA; remap swaps exact colours, named by project palette key or hex, for others.
          const previous = rendered.get(op.from), source = previous.data, swaps = new Map();
          take(previous);
          if (op.remap !== undefined) {
            object(op.remap, `${p}.remap`);
            if (Object.keys(op.remap).length > 256) fail(`${p}.remap`, 'at most 256 colours');
            for (const [key, value] of Object.entries(op.remap)) {
              const from = parseColor(key, palette, `${p}.remap.${key}`), id = pixelId(from, 0);
              if (!from[3]) fail(`${p}.remap.${key}`, 'frame copies skip transparent pixels; remap visible colours');
              if (swaps.has(id)) fail(`${p}.remap.${key}`, `another key already names ${toHex(from)}`);
              swaps.set(id, color(value, `${p}.remap.${key}`));
            }
          }
          [sourceWidth, sourceHeight, read] = [width, height, (sx, sy) => { const at = (sy * width + sx) * 4; return source[at + 3] ? swaps.get(pixelId(source, at)) ?? source.subarray(at, at + 4) : null; }];
          if (previous.blendMask) mixedAt = (sx, sy) => {
            const at = sy * width + sx;
            return previous.blendMask[at] && !swaps.has(pixelId(source, at * 4));
          };
        }
        const sx = integer(op.sx ?? 0, `${p}.sx`, 0, sourceWidth - 1), sy = integer(op.sy ?? 0, `${p}.sy`, 0, sourceHeight - 1);
        const w = integer(op.w ?? sourceWidth - sx, `${p}.w`, 1, sourceWidth - sx), h = integer(op.h ?? sourceHeight - sy, `${p}.h`, 1, sourceHeight - sy);
        drawCells(w, h, (gx, gy) => read(sx + gx, sy + gy), undefined, mixedAt && ((gx, gy) => mixedAt(sx + gx, sy + gy)));
      } else if (op.op === 'autotile') {
        // One tile of an autotile set. The autotile compiler emits one per frame, so editing the template redraws every tile.
        if (typeof op.symbol !== 'string') fail(`${p}.symbol`, 'expected a string naming a template symbol');
        const grid = symbols[op.symbol];
        if (!grid) fail(`${p}.symbol`, `unknown symbol ${JSON.stringify(op.symbol)}`);
        const mode = op.mode ?? 'blob';
        if (!AUTOTILE_MODES.includes(mode)) fail(`${p}.mode`, 'expected blob, cardinal or corner');
        drawTemplate(grid, integer(op.mask, `${p}.mask`, 0, mode === 'blob' ? 255 : 15), mode, x, y, paletteSampler(), `${p}.symbol`);
      } else if (op.op === 'box') {
        // An isometric box from the top-left of its bounds: a 2:1 top face whose right edge runs `w` pixels across and
        // left edge `d`, over a left and a right face `h` pixels tall. Each pixel belongs to the face its centre lies in
        // (tested on doubled coordinates, so on whole numbers), so edges step two pixels across for each one down and
        // boxes laid on a 2:1 grid meet with no gap or overlap. `edge` marks the top's front edges and the corner
        // between the sides. A face without a colour is left out; h 0 and a top alone is a floor diamond.
        const w = integer(op.w, `${p}.w`, 2, 512), d = integer(op.d, `${p}.d`, 2, 512), h = integer(op.h ?? 0, `${p}.h`, 0, 512);
        for (const [key, value] of [['w', w], ['d', d]]) if (value % 2) fail(`${p}.${key}`, 'expected an even number: a 2:1 edge runs two pixels across for each one down');
        const faces = ['top', 'left', 'right'].map(key => (op[key] === undefined ? null : color(op[key], `${p}.${key}`)));
        if (!faces.some(Boolean)) fail(`${p}.top`, 'give at least one face a colour: top, left or right');
        const edge = op.edge === undefined ? null : color(op.edge, `${p}.edge`), across = w + d, down = across / 2 + h;
        spend(across * down);
        // 0 top, 1 left, 2 right, -1 outside the box.
        const face = (i, j) => {
          if (i < 0 || j < 0 || i >= across || j >= down) return -1;
          const s = 2 * i + 4 * j + 3 - 2 * d, t = 4 * j - 2 * i + 2 * d + 1;
          if (s > 0 && s < 4 * w && t > 0 && t < 4 * d) return 0;
          const below = i < w ? t - 4 * d : s - 4 * w;
          return below > 0 && below < 4 * h ? (i < w ? 1 : 2) : -1;
        };
        for (let j = 0; j < down; j++) for (let i = 0; i < across; i++) {
          const f = face(i, j);
          if (f < 0 || !faces[f]) continue;
          const marked = edge && ((f === 0 && face(i, j + 1) > 0) || (f === 1 && face(i + 1, j) === 2));
          put(x + i, y + j, marked ? edge : faces[f]);
        }
      } else if (op.op === 'tilemap') {
        // A character map drawn from this recipe's symbols and autotile templates, with the legend, variants and rules of
        // scene tilemaps (see expandTilemap in autotile.js). Later operations see the composed result: dither over its
        // floor colours, rewrite rules at its corners, an outline around it.
        if (op.tile === undefined) fail(`${p}.tile`, 'expected [width, height]: the distance between cells in pixels');
        const tile = point(op.tile, `${p}.tile`);
        if (tile.some(n => n < 1 || n > CANVAS_SIDE)) fail(`${p}.tile`, `cells are 1–${CANVAS_SIDE} pixels wide and tall, as a scene tilemap's are`);
        // An iso map lays cells on a 2:1 diamond grid, back to front; each symbol stands on its diamond, bottoms aligned
        // and centred across, so a block taller than the tile rises above its cell.
        if (op.layout !== undefined && op.layout !== 'square' && op.layout !== 'iso') fail(`${p}.layout`, 'expected square or iso');
        const iso = op.layout === 'iso';
        if (iso && tile.some(n => n % 2)) fail(`${p}.tile`, 'an iso tile has an even width and height');
        const expanded = expandTilemap(op, { path: p, fail, kinds: ['symbol', 'template'], text: 'symbol', masked: kind => kind !== 'template', exists: (kind, key) => own(symbols, key) });
        // Corner tiles sit half a cell up and left of the cell they were found from: a template's cells say so with
        // mode, a symbol's with corner.
        if (expanded.cells.some(cell => cell.mode === 'corner' || cell.corner)) {
          if (iso) fail(`${p}.legend`, 'corner tiles sit where four square cells meet; an iso map takes symbols without autotile corner');
          if (tile.some(n => n % 2)) fail(`${p}.tile`, 'corner tiles sit where four cells meet, half a cell up and left of one; use an even cell width and height');
        }
        const sample = paletteSampler();
        const cells = iso ? isoLayout(expanded.cells, expanded.rows, tile) : expanded.cells.map(cell => ({ ...cell, left: cell.x * tile[0], top: cell.y * tile[1] }));
        for (const cell of cells) {
          const grid = symbols[cell.name];
          if (cell.kind === 'template') {
            if (iso) fail(`${p}.legend`, `template ${JSON.stringify(cell.name)} draws square tiles; an iso map takes symbols`);
            drawTemplate(grid, cell.mask, cell.mode, x + cell.left, y + cell.top, sample, `${p}.legend: template ${JSON.stringify(cell.name)}`); continue;
          }
          const left = x + cell.left + (iso ? Math.floor((tile[0] - grid.width) / 2) : 0), top = y + cell.top + (iso ? tile[1] - grid.height : 0);
          spend(grid.width * grid.height);
          for (let gy = 0; gy < grid.height; gy++) for (let gx = 0; gx < grid.width; gx++) { const c = sample(grid.rows[gy][gx]); if (c) put(left + gx, top + gy, c); }
        }
      } else if (op.op === 'outline') {
        // Outside rings surround the visible pixels drawn so far in this buffer (frame or layer); inside rings recolor
        // its edge pixels. `directions` marks, on a 3×3 grid centred on a visible pixel, the sides that get the line:
        // an outside line appears there, an inside line recolors pixels whose neighbour there is transparent.
        const c = color(op.color, `${p}.color`);
        if (op.diagonal !== undefined && op.directions !== undefined) fail(`${p}.directions`, 'use directions or diagonal, not both');
        const diagonal = boolean(op.diagonal ?? false, `${p}.diagonal`), position = op.position ?? 'outside';
        if (!['outside', 'inside', 'middle'].includes(position)) fail(`${p}.position`, 'expected outside, inside or middle');
        const size = integer(op.width ?? 1, `${p}.width`, 1, 8);
        let around = diagonal ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[0, -1], [-1, 0], [1, 0], [0, 1]];
        if (op.directions !== undefined) {
          const rows = list(op.directions, `${p}.directions`, 3);
          if (rows.length !== 3 || rows.some(row => typeof row !== 'string' || !/^[x.]{3}$/.test(row)) || rows[1][1] !== '.' || !rows.join('').includes('x')) fail(`${p}.directions`, 'expected three rows of three x or . characters, with a . in the centre and at least one x');
          around = rows.flatMap((row, dy) => [...row].flatMap((mark, dx) => (mark === 'x' ? [[dx - 1, dy - 1]] : [])));
        }
        spend(width * height * size);
        const solid = new Uint8Array(width * height), paint = new Uint8Array(width * height);
        for (let i = 0; i < solid.length; i++) solid[i] = data[i * 4 + 3] ? 1 : 0;
        if (!solid.includes(1)) hollow.push(p);
        const within = (px, py) => px >= 0 && py >= 0 && px < width && py < height;
        const outer = position === 'inside' ? 0 : position === 'outside' ? size : Math.ceil(size / 2);
        const inner = position === 'outside' ? 0 : position === 'inside' ? size : Math.floor(size / 2);
        const grown = solid.slice(), open = solid.map(v => 1 - v);
        for (let ring = 0; ring < outer; ring++) {
          const next = [];
          for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
            if (!grown[py * width + px] && around.some(([dx, dy]) => within(px - dx, py - dy) && grown[(py - dy) * width + px - dx])) next.push(py * width + px);
          }
          for (const i of next) { grown[i] = 1; paint[i] = 1; }
        }
        // The canvas edge does not count as transparent, so a shape cut by the canvas gets no line there.
        for (let ring = 0; ring < inner; ring++) {
          const next = [];
          for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
            if (solid[py * width + px] && !open[py * width + px] && around.some(([dx, dy]) => within(px + dx, py + dy) && open[(py + dy) * width + px + dx])) next.push(py * width + px);
          }
          for (const i of next) { open[i] = 1; paint[i] = 1; }
        }
        for (let i = 0; i < paint.length; i++) if (paint[i]) {
          if (c[3]) touch(i % width, Math.floor(i / width));
          origins.paint(data, i * 4, c);
        }
      } else if (op.op === 'dither') {
        // Ordered dither: draws `color` (or erases) where the canvas-anchored pattern's threshold is below the density.
        const erase = boolean(op.erase ?? false, `${p}.erase`);
        if (erase === (op.color !== undefined)) fail(p, 'dither needs a color, or erase: true to clear pixels');
        const c = erase ? null : color(op.color, `${p}.color`), field = densityField(0.5), over = overSet();
        field((px, py) => { if (!over || over.has(pixelId(data, (py * width + px) * 4))) put(px, py, c, erase); });
      } else if (op.op === 'shade') {
        // Moves every pixel of the region `steps` along its colour's ramp (negative darkens), clamped at the ramp's ends,
        // so a shadow or a pool of light keeps the palette whatever it falls on. Colours on no ramp stay as they are. The
        // density field gives a dithered edge; shape "ellipse" keeps to the ellipse inside the region.
        if (!ramps.length) fail(p, 'shade moves colours along the recipe\'s ramps; declare ramps, lists of palette keys from dark to light');
        const steps = integer(op.steps ?? -1, `${p}.steps`, -8, 8);
        if (!steps) fail(`${p}.steps`, 'expected a nonzero number of steps: negative darkens, positive lightens');
        const shape = op.shape ?? 'rect';
        if (!['rect', 'ellipse'].includes(shape)) fail(`${p}.shape`, 'expected rect or ellipse');
        const ellipse = (i, j, w, h) => ((i + .5 - w / 2) / (w / 2)) ** 2 + ((j + .5 - h / 2) / (h / 2)) ** 2 <= 1;
        const shift = rampShifter(activePalette, ramps), field = densityField(1, shape === 'ellipse' ? ellipse : null), over = overSet();
        field((px, py) => {
          const at = (py * width + px) * 4, id = pixelId(data, at);
          if (!id || (over && !over.has(id))) return;
          const next = shift(id, steps);
          if (next) { data.set(next, at); origins.set(at / 4, false); }
        });
      } else if (op.op === 'rewrite') {
        // Markov-style rules: small palette grids matched against exact RGBA and replaced in place (see craft.js).
        const rx = integer(op.x ?? 0, `${p}.x`, 0, width - 1), ry = integer(op.y ?? 0, `${p}.y`, 0, height - 1);
        const rw = integer(op.w ?? width - rx, `${p}.w`, 1, width - rx), rh = integer(op.h ?? height - ry, `${p}.h`, 1, height - ry);
        if (op.empty !== undefined && (typeof op.empty !== 'string' || op.empty.length !== 1 || op.empty === '.' || op.empty === ' ' || own(palette, op.empty))) fail(`${p}.empty`, 'choose one character that is not a dot, space or palette key to stand for transparent pixels');
        list(op.rules, `${p}.rules`, 16);
        if (!op.rules.length) fail(`${p}.rules`, 'expected 1–16 rules');
        const turns = { rotate: boolean(op.rotate ?? false, `${p}.rotate`), mirror: boolean(op.mirror ?? false, `${p}.mirror`) };
        const rules = op.rules.map((rule, r) => {
          const rp = `${p}.rules[${r}]`;
          object(rule, rp, ['match', 'replace']);
          const cells = key => {
            const rows = list(rule[key], `${rp}.${key}`, 8), w = typeof rows[0] === 'string' ? rows[0].length : 0;
            if (!rows.length || w < 1 || w > 8) fail(`${rp}.${key}`, 'expected 1–8 rows of 1–8 characters');
            return { w, h: rows.length, cells: rows.flatMap((row, j) => {
              if (typeof row !== 'string' || row.length !== w) fail(`${rp}.${key}[${j}]`, `all rows must be ${w} characters wide`);
              return [...row].map(char => {
                if (char === '.' || char === ' ') return -1;
                if (char === op.empty) return 0;
                if (char.length !== 1 || !own(palette, char)) fail(`${rp}.${key}[${j}]`, `unknown palette character ${JSON.stringify(char)}${op.empty === undefined ? '; set empty to match or erase transparent pixels' : ''}`);
                return pixelId(color(char, `${rp}.${key}[${j}]`), 0);
              });
            }) };
          };
          const match = cells('match'), replace = cells('replace');
          if (match.w !== replace.w || match.h !== replace.h) fail(`${rp}.replace`, 'replace must be the same size as match');
          if (replace.cells.every(v => v < 0)) fail(`${rp}.replace`, 'replace keeps every pixel; use palette keys or the empty character');
          return ruleVariants({ w: match.w, h: match.h, match: match.cells, replace: replace.cells }, turns);
        });
        const steps = integer(op.steps ?? 1, `${p}.steps`, 1, 64), seed = integer(op.seed ?? 0, `${p}.seed`, 0, 2147483647);
        const chance = op.chance === undefined ? 1 : number(op.chance, `${p}.chance`, 0, 1), limit = op.limit === undefined ? Infinity : integer(op.limit, `${p}.limit`, 1, FRAME_PIXELS);
        const ids = idsOf(data);
        for (const index of rewriteIds(ids, width, height, rules, { x: rx, y: ry, w: rw, h: rh, steps, chance, limit, seed, spend })) {
          touch(index % width, Math.floor(index / width));
          data.set(colorOf(ids[index]), index * 4);
          origins.set(index, false);
        }
      } else if (op.op === 'replace') {
        const from = color(op.from, `${p}.from`), to = color(op.to, `${p}.to`);
        spend(width * height);
        for (let i = 0; i < data.length; i += 4) if (from.every((c, j) => data[i + j] === c)) {
          touch(i / 4 % width, Math.floor(i / 4 / width));
          data.set(to, i);
          origins.set(i / 4, false);
        }
      } else if (op.op === 'fill') {
        if (x < 0 || y < 0 || x >= width || y >= height) fail(p, 'fill seed must be inside the canvas');
        const c = color(op.color, `${p}.color`), target = data.slice((y * width + x) * 4, (y * width + x) * 4 + 4);
        const visited = new Uint8Array(width * height), stack = [y * width + x];
        spend(width * height);
        while (stack.length) {
          const at = stack.pop();
          if (visited[at]) continue;
          visited[at] = 1;
          if (!target.every((v, j) => data[at * 4 + j] === v)) continue;
          data.set(c, at * 4);
          origins.set(at, false);
          const px = at % width, py = Math.floor(at / width);
          touch(px, py);
          if (px > 0) stack.push(at - 1); if (px + 1 < width) stack.push(at + 1);
          if (py > 0) stack.push(at - width); if (py + 1 < height) stack.push(at + width);
        }
      }
    }
  }
  let elapsed = 0;
  const frames = checked(() => spec.frames.map((frame, index) => {
    const p = `project.frames[${index}]`;
    // A field a frame doesn't have is noted like a broken operation and the frame is read without it, so the same
    // reply still names what else is wrong: another frame's operations, an animation that lists a missing frame.
    try { object(frame, p, ['name', 'duration', 'time', 'from', 'translate', 'wrap', 'flipX', 'flipY', 'palette', 'anchor', 'points', 'groups', 'tile', 'ops', 'layers', 'pixels']); }
    catch (error) { if (!isObject(frame) || !error.message.includes('unknown field')) throw error; note(error, p); }
    const frameName = name(frame.name, `${p}.name`);
    if (frameNames.has(frameName.toLowerCase())) fail(`${p}.name`, `duplicate frame ${frameName}; names must also be unique ignoring case`);
    frameNames.add(frameName.toLowerCase());
    const duration = integer(frame.duration ?? 100, `${p}.duration`, 1, 60000);
    const time = integer(frame.time ?? elapsed, `${p}.time`, 0, trackLimit);
    elapsed += duration;
    if (frame.groups !== undefined) {
      object(frame.groups, `${p}.groups`);
      if (Object.keys(frame.groups).length > 64) fail(`${p}.groups`, 'at most 64 layer groups per frame');
      for (const [key, offset] of Object.entries(frame.groups)) {
        name(key, `${p}.groups.${key}`); point(offset, `${p}.groups.${key}`);
      }
    }
    let overrides = null;
    if (frame.palette !== undefined) {
      overrides = paletteOverride(frame.palette, palette, `${p}.palette`, 'frame palettes recolor keys declared in the project palette');
    }
    activePalette = overrides ? { ...palette, ...overrides } : palette;
    if (overrides && Object.keys(overrides).length && ![frame.ops, frame.layers, frame.pixels].some(list => Array.isArray(list) && list.length)) idlePalettes.push([frameName, typeof frame.from === 'string' ? frame.from : undefined]);
    const frameAnchor = frame.anchor === undefined ? projectAnchor : point(frame.anchor, `${p}.anchor`);
    let points = null;
    if (frame.points !== undefined) {
      object(frame.points, `${p}.points`);
      if (Object.keys(frame.points).length > 64) fail(`${p}.points`, 'at most 64 named points per frame');
      points = Object.fromEntries(Object.entries(frame.points).map(([key, value]) => [name(key, `${p}.points.${key}`), point(value, `${p}.points.${key}`)]));
    }
    const tile = frame.tile === undefined ? null : tileFacts(frame.tile, `${p}.tile`, width, height);
    let data = new Uint8ClampedArray(width * height * 4), owner = ownerNames && new Uint16Array(width * height);
    let origins = new BlendOrigins(width * height);
    taken = new Set();
    if (frame.from !== undefined) {
      if (typeof frame.from !== 'string' || !rendered.has(frame.from)) fail(`${p}.from`, 'must name an earlier frame');
      take(rendered.get(frame.from));
      data.set(rendered.get(frame.from).data);
      origins = new BlendOrigins(width * height, rendered.get(frame.from).blendMask);
      owner?.set(rendered.get(frame.from).owners);
    } else if (background.some(Boolean)) {
      for (let i = 0; i < data.length; i += 4) data.set(background, i);
      if (owner && background[3]) owner.fill(ownerId('background'));
    }
    const translate = frame.translate ?? [0, 0];
    list(translate, `${p}.translate`, 2);
    if (translate.length !== 2) fail(`${p}.translate`, 'expected [x, y]');
    const dx = integer(translate[0], `${p}.translate[0]`), dy = integer(translate[1], `${p}.translate[1]`);
    const flipX = boolean(frame.flipX ?? false, `${p}.flipX`), flipY = boolean(frame.flipY ?? false, `${p}.flipY`);
    const wrap = boolean(frame.wrap ?? false, `${p}.wrap`);
    if (dx || dy || flipX || flipY) {
      const transformed = new Uint8ClampedArray(data.length), moved = owner && new Uint16Array(owner.length);
      const movedOrigins = new BlendOrigins(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let px = (flipX ? width - 1 - x : x) + dx, py = (flipY ? height - 1 - y : y) + dy;
        if (wrap) { px = ((px % width) + width) % width; py = ((py % height) + height) % height; }
        if (px >= 0 && py >= 0 && px < width && py < height) {
          transformed.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (py * width + px) * 4);
          if (moved) moved[py * width + px] = owner[y * width + x];
          if (origins.mask?.[y * width + x]) movedOrigins.set(py * width + px, true);
        } else if (data[(y * width + x) * 4 + 3]) clip(`${p}.translate`);
      }
      data = transformed; owner = moved; origins = movedOrigins;
    }
    // Frame operations may draw anywhere and erase: what they changed is theirs.
    const unchanged = owner && frame.ops?.length ? data.slice() : null;
    drawOps(data, frame.ops ?? [], `${p}.ops`, origins);
    if (unchanged) {
      const id = ownerId('frame.ops');
      for (let at = 0; at < owner.length; at++) {
        const i = at * 4;
        if (data[i] !== unchanged[i] || data[i + 1] !== unchanged[i + 1] || data[i + 2] !== unchanged[i + 2] || data[i + 3] !== unchanged[i + 3]) owner[at] = data[i + 3] ? id : 0;
      }
    }
    list(frame.layers ?? [], `${p}.layers`, 64);
    const framePalette = activePalette, layerPalettes = [];
    // Reuse a layer scratch buffer; clear only dirty rows after compositing. Empty layers allocate nothing extra.
    const pixels = (frame.layers ?? []).length ? new Uint8ClampedArray(data.length) : null;
    const layerOrigins = new BlendOrigins(width * height);
    for (const [li, layer] of (frame.layers ?? []).entries()) {
      const lp = `${p}.layers[${li}]`;
      object(layer, lp, ['name', 'visible', 'opacity', 'x', 'y', 'group', 'palette', 'sort', 'ops', 'part', 'flipX', 'flipY', 'scale', 'delay']);
      if (layer.sort !== undefined && layer.sort !== 'ground') fail(`${lp}.sort`, 'expected "ground": draw this layer\'s operations far to near by the row each stands on');
      if (layer.name !== undefined) name(layer.name, `${lp}.name`);
      // A layer palette recolors keys for this layer's drawing only, on top of the frame's palette, so one layer can
      // flash or cycle while other drawing that shares the key keeps its colour.
      let layerOverrides = null;
      if (layer.palette !== undefined) {
        layerOverrides = paletteOverride(layer.palette, palette, `${lp}.palette`, 'layer palettes recolor keys declared in the project palette');
        layerPalettes.push({ layer: layer.name ?? li, palette: layerOverrides });
      }
      activePalette = layerOverrides ? { ...framePalette, ...layerOverrides } : framePalette;
      const visible = boolean(layer.visible ?? true, `${lp}.visible`), opacity = layer.opacity ?? 1;
      if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) fail(`${lp}.opacity`, 'expected a number from 0 to 1');
      let [lx, ly] = layerOffset(layer, frame.groups, lp), instance = null;
      if (layer.part !== undefined) {
        const shapes = parts.get(name(layer.part, `${lp}.part`));
        if (!shapes) fail(`${lp}.part`, `unknown polygon part "${layer.part}"`);
        if (layer.sort !== undefined) fail(`${lp}.sort`, 'a polygon part draws in definition order');
        const signX = boolean(layer.flipX ?? false, `${lp}.flipX`) ? -1 : 1;
        const signY = boolean(layer.flipY ?? false, `${lp}.flipY`) ? -1 : 1;
        let scale;
        if (typeof layer.scale === 'string') {
          const track = tracks.get(layer.scale);
          if (!track) fail(`${lp}.scale`, `unknown scale track "${layer.scale}"`);
          scale = sampleTrack(track, time - integer(layer.delay ?? 0, `${lp}.delay`, -trackLimit, trackLimit));
        } else {
          if (layer.delay !== undefined) fail(`${lp}.delay`, 'delay needs a named scale track');
          scale = scalePair(layer.scale ?? 1, `${lp}.scale`);
        }
        instance = { shapes, scale, dx: lx, dy: ly, signX, signY, path: `${lp}.part` };
        lx = 0; ly = 0;
      } else for (const key of ['flipX', 'flipY', 'scale', 'delay']) {
        if (layer[key] !== undefined) fail(`${lp}.${key}`, `${key} needs a polygon part on this layer`);
      }
      const bounds = [width, height, -1, -1];
      drawOps(pixels, layer.ops ?? [], `${lp}.ops`, layerOrigins, bounds, layer.sort === 'ground', instance);
      activePalette = framePalette;
      if (visible && opacity > 0 && bounds[2] >= 0) {
        const area = (bounds[2] - bounds[0] + 1) * (bounds[3] - bounds[1] + 1);
        layerPixels += area; spend(area);
        for (let y = bounds[1]; y <= bounds[3]; y++) for (let x = bounds[0]; x <= bounds[2]; x++) {
          const tx = x + lx, ty = y + ly, i = (y * width + x) * 4;
          if (!pixels[i + 3]) continue;
          if (tx >= 0 && tx < width && ty >= 0 && ty < height) {
            const to = (ty * width + tx) * 4;
            if (pixels[i + 3] === 255 && opacity === 1) {
              data[to] = pixels[i]; data[to + 1] = pixels[i + 1]; data[to + 2] = pixels[i + 2]; data[to + 3] = 255;
              origins.set(to / 4, layerOrigins.mask?.[i / 4]);
            } else origins.paint(data, to, pixels.subarray(i, i + 4), opacity, layerOrigins.mask?.[i / 4]);
          } else clip(lp);
        }
        if (owner) {
          const id = ownerId(layer.name ?? `layers[${li}]`);
          for (let y = bounds[1]; y <= bounds[3]; y++) for (let x = bounds[0]; x <= bounds[2]; x++) {
            const tx = x + lx, ty = y + ly;
            if (pixels[(y * width + x) * 4 + 3] && tx >= 0 && tx < width && ty >= 0 && ty < height) owner[ty * width + tx] = id;
          }
        }
      }
      for (let y = bounds[1]; y <= bounds[3]; y++) {
        const start = y * width + bounds[0], end = y * width + bounds[2] + 1;
        pixels.fill(0, start * 4, end * 4); layerOrigins.mask?.fill(0, start, end);
      }
    }
    // Final canvas-space corrections replace RGBA, including transparency, after all layers.
    list(frame.pixels ?? [], `${p}.pixels`, FRAME_PIXELS);
    spend((frame.pixels ?? []).length);
    for (const [i, pixel] of (frame.pixels ?? []).entries()) {
      const pp = `${p}.pixels[${i}]`;
      object(pixel, pp, ['x', 'y', 'color']);
      const x = integer(pixel.x, `${pp}.x`, 0, width - 1), y = integer(pixel.y, `${pp}.y`, 0, height - 1);
      data.set(color(pixel.color, `${pp}.color`), (y * width + x) * 4);
      origins.set(y * width + x, false);
      // A correction over drawn pixels recolours them (a pose's inner lines recolour its parts' outlines), so they
      // stay their owner's; one on empty canvas is its own.
      if (owner) owner[y * width + x] = !data[(y * width + x) * 4 + 3] ? 0 : owner[y * width + x] || ownerId('frame.pixels');
    }
    activePalette = palette;
    const result = { name: frameName, duration, data, ...(owner && { owners: owner }), ...(frameAnchor && { anchor: frameAnchor }), ...(points && { points }), ...(tile && { tile }), ...(overrides && { palette: overrides }), ...(layerPalettes.length && { layerPalettes }), ...(taken.size && { inherited: [...taken] }) };
    rendered.set(frameName, result);
    if (origins.mask?.includes(1)) result.blendMask = origins.mask;
    return result;
  }));
  const animations = checked(() => readAnimations(spec, frames));
  const sheet = checked(() => readSheet(spec, frames, width, height));
  if (noted.length) throw together();
  const warnings = [], clipping = [...clipped].map(([path, pixels]) => ({ path, pixels }));
  // An outline surrounds what its own buffer holds: a frame's ops and each of its layers are buffers apart, so an
  // outline among the ops of a frame drawn in layers has nothing to surround. In a frame that draws nothing at all
  // (an effect's empty frame) it is no mistake.
  const idle = hollow.filter(path => frames[Number(/frames\[(\d+)\]/.exec(path)?.[1])]?.data.some((value, i) => i % 4 === 3 && value));
  if (idle.length) warnings.push(`An outline drew nothing: ${idle[0]}${idle.length > 1 ? ` and ${idle.length - 1} more` : ''} surrounds what its own buffer holds, and a frame's ops and each of its layers are buffers apart. Put the outline at the end of the layer it should surround.`);
  // A frame continued with `from` keeps that frame's pixels as exact colours, and a frame palette recolours only what
  // the frame itself draws: with nothing drawn, the frame is the same picture again. (A lit fuse and a relic's glint
  // were written so and never showed.)
  if (idlePalettes.length) {
    const [frameName, from] = idlePalettes[0], more = idlePalettes.length > 1 ? ` (and ${idlePalettes.length - 1} more frame${idlePalettes.length > 2 ? 's' : ''})` : '';
    warnings.push(`Frame "${frameName}"${more} sets a palette but draws nothing of its own, so the palette changes nothing${from ? `: it continues "${from}" in that frame's exact colours` : ''}. A frame palette recolours the frame's own drawing: stamp the symbol again in this frame${from ? `, or copy from "${from}" with remap` : ''}.`);
  }
  if (clipping.length) warnings.push(`Some drawing falls outside the canvas and is clipped: ${clipping[0].path} (${clipping[0].pixels} px)${clipping.length > 1 ? ` and ${clipping.length - 1} more location${clipping.length > 2 ? 's' : ''}` : ''}.`);
  return {
    name: projectName, width, height, frames, animations, palette, ramps,
    ...(isStills(spec) && { stills: true }),
    ...(options.stats && { work: { pixels: work, layerPixels, operations: operationCount } }),
    ...(ownerNames && { ownerNames }),
    sheet,
    warnings, ...(clipping.length && { clipping: clipping.slice(0, 16), ...(clipping.length > 16 && { clippingOmitted: clipping.length - 16 }) })
  };
}

// Compiler-only validation/timing for the stamp subset emitted by compilePoses. It shares header, animation and
// atlas validation with the renderer, but never allocates or composites a canvas. A stamp cannot erase, so visible
// symbol bounds suffice to compute the trimmed atlas, including flips and canvas clipping. Frames drawn the same way,
// recolouring the same drawn keys, share a cell here; the renderer compares pixels, so it also shares frames that only
// come out the same: this sheet is an upper bound on the renderer's, not a copy of it.
export function describeStampRecipe(spec) {
  const { width, height, palette, symbols } = readProject(spec, { stills: false, side: POSE_SIDE });
  if (spec.background !== undefined) fail('project.background', 'compiler stamp recipes omit the background');
  const frameNames = new Set(), boundsBySymbol = new Map(), keysBySymbol = new Map(), boxes = [];
  let work = 0, operations = 0;
  const spend = amount => { work += amount; if (work > 67108864) fail('project', 'drawing work exceeds the 67-million-pixel budget; simplify repeated operations'); };
  const base = new Map(Object.keys(palette).map(key => [key, parseColor(key, palette)[3]]));
  // A frame palette (a posed figure's hit flash) may make a key transparent or opaque; bounds are cached for the
  // project palette's alphas only.
  const symbolBounds = (symbol, alpha) => {
    if (alpha !== base || !boundsBySymbol.has(symbol)) {
      const grid = symbols[symbol], bounds = [grid.width, grid.height, -1, -1];
      for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) if (alpha.get(grid.rows[y][x])) {
        bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
      }
      if (alpha !== base) return bounds;
      boundsBySymbol.set(symbol, bounds);
    }
    return boundsBySymbol.get(symbol);
  };
  // The palette keys a symbol's rows use: a frame palette changes a frame's picture only where it recolours one.
  const symbolKeys = symbol => {
    if (!keysBySymbol.has(symbol)) keysBySymbol.set(symbol, new Set(symbols[symbol].rows.join('')));
    return keysBySymbol.get(symbol);
  };
  const frames = spec.frames.map((frame, index) => {
    const p = `project.frames[${index}]`;
    object(frame, p, ['name', 'duration', 'palette', 'anchor', 'points', 'layers', 'pixels']);
    const frameName = name(frame.name, `${p}.name`);
    if (frameNames.has(frameName.toLowerCase())) fail(`${p}.name`, `duplicate frame ${frameName}; names must also be unique ignoring case`);
    frameNames.add(frameName.toLowerCase());
    const duration = integer(frame.duration ?? 100, `${p}.duration`, 1, 60000);
    if (frame.anchor !== undefined) point(frame.anchor, `${p}.anchor`);
    if (frame.points !== undefined) {
      object(frame.points, `${p}.points`);
      if (Object.keys(frame.points).length > 64) fail(`${p}.points`, 'at most 64 named points per frame');
      for (const [key, value] of Object.entries(frame.points)) { name(key, `${p}.points.${key}`); point(value, `${p}.points.${key}`); }
    }
    const overrides = frame.palette === undefined ? null : paletteOverride(frame.palette, palette, `${p}.palette`, 'frame palettes recolor keys declared in the project palette');
    const alpha = overrides && Object.entries(overrides).some(([key, hex]) => parseColor(hex)[3] !== base.get(key)) ? new Map([...base, ...Object.entries(overrides).map(([key, hex]) => [key, parseColor(hex)[3]])]) : base;
    let left = width, top = height, right = -1, bottom = -1;
    const drawn = new Set();
    list(frame.layers ?? [], `${p}.layers`, 64);
    for (const [li, layer] of (frame.layers ?? []).entries()) {
      const lp = `${p}.layers[${li}]`;
      object(layer, lp, ['name', 'ops']); name(layer.name, `${lp}.name`);
      list(layer.ops, `${lp}.ops`);
      if (layer.ops.length !== 1) fail(`${lp}.ops`, 'expected one compiler stamp');
      if (++operations > 20000) fail(`${lp}.ops`, 'project exceeds 20,000 drawing operations');
      const op = layer.ops[0], at = `${lp}.ops[0]`;
      object(op, at, ['op', 'symbol', 'x', 'y', 'flipX']);
      if (op.op !== 'stamp' || typeof op.symbol !== 'string' || !own(symbols, op.symbol)) fail(`${at}.symbol`, 'expected a known compiler stamp');
      const x = integer(op.x ?? 0, `${at}.x`), y = integer(op.y ?? 0, `${at}.y`);
      const flip = boolean(op.flipX ?? false, `${at}.flipX`), grid = symbols[op.symbol], box = symbolBounds(op.symbol, alpha);
      spend(grid.width * grid.height);
      for (const key of symbolKeys(op.symbol)) drawn.add(key);
      if (box[2] < 0) continue;
      let x0 = x + (flip ? grid.width - 1 - box[2] : box[0]), x1 = x + (flip ? grid.width - 1 - box[0] : box[2]);
      let y0 = y + box[1], y1 = y + box[3];
      if (x0 < 0 || y0 < 0 || x1 >= width || y1 >= height) {
        // A cropped symbol may have holes at its edge; intersecting rectangles alone would overestimate its bounds.
        x0 = width; y0 = height; x1 = -1; y1 = -1;
        for (let gy = Math.max(0, -y); gy < Math.min(grid.height, height - y); gy++) {
          for (let dx = Math.max(0, -x); dx < Math.min(grid.width, width - x); dx++) {
            if (!alpha.get(grid.rows[gy][flip ? grid.width - 1 - dx : dx])) continue;
            x0 = Math.min(x0, x + dx); x1 = Math.max(x1, x + dx);
            y0 = Math.min(y0, y + gy); y1 = Math.max(y1, y + gy);
          }
        }
      }
      if (x1 < 0) continue;
      spend((x1 - x0 + 1) * (y1 - y0 + 1));
      left = Math.min(left, x0); right = Math.max(right, x1);
      top = Math.min(top, y0); bottom = Math.max(bottom, y1);
    }
    // Final pixels in palette keys, such as a posed figure's inner lines.
    list(frame.pixels ?? [], `${p}.pixels`, FRAME_PIXELS);
    spend((frame.pixels ?? []).length);
    for (const [i, pixel] of (frame.pixels ?? []).entries()) {
      const pp = `${p}.pixels[${i}]`;
      object(pixel, pp, ['x', 'y', 'color']);
      const x = integer(pixel.x, `${pp}.x`, 0, width - 1), y = integer(pixel.y, `${pp}.y`, 0, height - 1);
      if (typeof pixel.color !== 'string' || !alpha.has(pixel.color)) fail(`${pp}.color`, 'expected a palette key');
      drawn.add(pixel.color);
      if (!alpha.get(pixel.color)) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    // Frames drawn by the same stamps and corrections, recolouring the same drawn keys the same way, are one picture
    // and share a cell, as the renderer's do. A palette entry that keeps its key's colour, or recolours a key the frame
    // never stamps, changes nothing drawn.
    const recoloured = overrides && Object.entries(overrides).filter(([key, hex]) => drawn.has(key) && toHex(parseColor(key, palette)) !== hex).sort(([a], [b]) => a < b ? -1 : 1);
    boxes.push(right < 0 ? { index, sx: 0, sy: 0, w: 1, h: 1, empty: true, key: 'empty' }
      : { index, sx: left, sy: top, w: right - left + 1, h: bottom - top + 1, key: JSON.stringify([frame.layers ?? [], frame.pixels ?? [], recoloured?.length ? recoloured : null]) });
    return { name: frameName, duration };
  });
  const animations = readAnimations(spec, frames);
  const sheet = readSheet(spec, frames, width, height, boxes);
  return { frames, animations, sheet };
}

// Whether a recipe's frames are stills (its "animations" is an empty map), and whether it names animations of its own
// (neither stills nor the field left out, which plays every frame in order).
export const isStills = spec => isObject(spec?.animations) && !Object.keys(spec.animations).length;
export const namesAnimations = spec => isObject(spec?.animations) && Object.keys(spec.animations).length > 0;
// What a GIF, video frames or a check say of stills: there is no animation to play, and how to make one.
export const stillsHaveNoAnimation = what => `the frames are stills ("animations": {} in the recipe), so there is no animation to ${what}: list the frames to play under "animations", such as { "loop": { "frames": ["a", "b"] } }, or remove the field to play every frame in order`;
// A tile set whose recipe names no animations (it leaves the field out, or its tiles are stills), as createBundle finds
// it (it gets a Godot TileSet: tiles, no sheet.trim and no terrain that mixes mask modes): its one animation, the
// implicit flipbook of every tile, is no animation, so it has no SpriteFrames, CSS or timing.
export function stillTileSet(spec, project) {
  if (namesAnimations(spec) || project.sheet.trim) return false;
  const tiles = autotileFrames(spec), modes = new Map();
  if (new Set(tiles.map(tile => tile.mask)).size < 2 && !project.frames.some(frame => frame.tile)) return false;
  for (const tile of tiles) {
    const terrain = tile.terrain ?? project.name;
    if ((modes.get(terrain) ?? tile.mode) !== tile.mode) return false;
    modes.set(terrain, tile.mode);
  }
  return true;
}
// Whether an export of the recipe plays nothing: stills, or a still tile set. Either has only the flipbook of every
// frame, which no export animates.
export const exportsStill = (spec, project) => project.stills === true || stillTileSet(spec, project);
// The atlas metadata an export writes: for one that plays nothing (exportsStill), the frames alone, with no
// `animations` or `meta.frameTags`. Every exported atlas goes through here (createBundle's, the playground's), so a
// still atlas is the same wherever it is downloaded.
export function exportAtlas(spec, project, metadata) {
  if (!exportsStill(spec, project)) return metadata;
  const { animations, meta: { frameTags, ...meta }, ...rest } = metadata;
  return { ...rest, meta };
}

function readAnimations(spec, frames) {
  const animations = Object.create(null), animationNames = new Set();
  object(spec.animations ?? {}, 'project.animations');
  // No animations field plays every frame in order. An empty map says the frames are stills (icons, UI states, tiles):
  // they keep that flipbook, so a viewer can still step through them, and renderProject marks the project `stills`,
  // which no export, reply or GIF animates.
  for (const [key, animation] of Object.entries(namesAnimations(spec) ? spec.animations : { default: { frames: frames.map(f => f.name) } })) {
    const p = `project.animations.${key}`;
    name(key, p);
    if (animationNames.has(key.toLowerCase())) fail(p, 'animation names must also be unique ignoring case');
    animationNames.add(key.toLowerCase());
    object(animation, p, ['frames', 'direction', 'loop']);
    list(animation.frames, `${p}.frames`, 1024);
    if (!animation.frames.length) fail(`${p}.frames`, 'at least one frame is required');
    const indices = animation.frames.map((ref, i) => { if (!frames.some(frame => frame.name === ref)) fail(`${p}.frames[${i}]`, `unknown frame ${JSON.stringify(ref)}`); return frames.findIndex(f => f.name === ref); });
    const direction = animation.direction ?? 'forward';
    if (!['forward', 'reverse', 'pingpong'].includes(direction)) fail(`${p}.direction`, 'expected forward, reverse or pingpong');
    if (direction === 'reverse') indices.reverse();
    if (direction === 'pingpong' && indices.length > 2) indices.push(...indices.slice(1, -1).reverse());
    const loop = boolean(animation.loop ?? true, `${p}.loop`);
    animations[key] = { frames: indices, loop, duration: indices.reduce((sum, i) => sum + frames[i].duration, 0) };
  }
  return animations;
}

function readSheet(spec, frames, width, height, boxes = null) {
  const sheet = object(spec.sheet ?? {}, 'project.sheet', ['columns', 'padding', 'scale', 'trim']);
  const columns = integer(sheet.columns ?? sheetColumns(frames.length, width), 'project.sheet.columns', 1, 256);
  const padding = integer(sheet.padding ?? 0, 'project.sheet.padding', 0, 16);
  const scale = integer(sheet.scale ?? 1, 'project.sheet.scale', 1, 16);
  const trim = boolean(sheet.trim ?? false, 'project.sheet.trim');
  const layout = trim ? (boxes ? packBoxes(boxes, padding, scale) : packTrimmed(frames, width, height, padding, scale)) : null;
  const sheetWidth = layout ? layout.width : columns * (width + padding * 2) * scale, sheetHeight = layout ? layout.height : Math.ceil(frames.length / columns) * (height + padding * 2) * scale;
  // A trimmed atlas is packed again at each smaller scale only when it does not fit, to name the largest that does.
  const trimmedAt = k => (boxes ? packBoxes(boxes, padding, k) : packTrimmed(frames, width, height, padding, k));
  sheetFits({ count: frames.length, width, height, columns, padding, scale, trim }, [sheetWidth, sheetHeight], trim ? trimmedAt : null);
  return { columns, padding, scale, width: sheetWidth, height: sheetHeight, ...(layout && { trim: true, layout: layout.cells }) };
}

// The atlas and each frame (every frame is also exported on its own) must each fit one PNG at the sheet's scale. When
// they do not, the refusal is at project.sheet.scale and names the largest scale at which both fit; fewer columns only
// where the last row leaves empty cells and a narrower grid fits, and what to change when even scale 1 does not fit.
// `size` is the atlas at the sheet's scale; `trimmedAt(k)` packs a trimmed atlas at scale k (a grid needs no packing).
function sheetFits({ count, width, height, columns, padding, scale, trim }, size, trimmedAt = null) {
  const frameFits = k => width * height * k * k <= PNG_PIXELS;
  const cells = c => c * Math.ceil(count / c) * (width + padding * 2) * (height + padding * 2);
  const atlasFits = (k, c = columns) => { const packed = trimmedAt?.(k); return (packed ? packed.width * packed.height : cells(c) * k * k) <= PNG_PIXELS; };
  const frameFirst = !frameFits(scale);
  if (!frameFirst && size[0] * size[1] <= PNG_PIXELS) return;
  let fits = scale - 1;
  while (fits >= 1 && !(frameFits(fits) && atlasFits(fits))) fits--;
  // The widest grid with fewer cells (and no more columns than frames) that fits at scale k, named at the largest scale
  // where one fits when that is above `fits`.
  const narrower = k => { if (trimmedAt || !frameFits(k)) return 0; for (let c = Math.min(columns - 1, count); c >= 1; c--) if (cells(c) < cells(columns) && atlasFits(k, c)) return c; return 0; };
  let at = scale, columnsFit = 0;
  while (at > fits && !(columnsFit = narrower(at))) at--;
  const what = frameFirst
    ? `a ${width}×${height} frame at scale ${scale} is ${width * scale}×${height * scale}`
    : `at scale ${scale} ${count === 1 ? 'one' : `the ${count}`}${trim ? ' trimmed' : ''} frame${count === 1 ? '' : 's'} of ${width}×${height} make${count === 1 ? 's' : ''} an atlas of ${size[0]}×${size[1]}`;
  const columnsAdvice = columnsFit ? `sheet.columns ${columnsFit} at scale ${at}` : '';
  const advice = fits
    ? `scale ${fits} is the largest that fits${columnsAdvice ? `, or ${columnsAdvice}` : ''}`
    : columnsAdvice ? `${columnsAdvice} fits`
      : `it does not fit even at scale 1: use fewer frames${padding ? ', less padding' : ''} or a smaller size`;
  fail('project.sheet.scale', `${what}, past the 16,777,216 pixels one PNG holds; ${advice}`);
}
// sheetFits' refusal for a render whose call set the columns (CLI --columns, MCP columns), which take the place of the
// recipe's sheet.columns: its columns advice names that option, since a patch of sheet.columns would change nothing.
export function columnsOfCall(error, option) {
  if (error?.path !== 'project.sheet.scale' || !error.message.includes(' sheet.columns ')) return error;
  return new PixelError(error.path, error.message.slice(error.path.length + 2).replace(' sheet.columns ', ` ${option} `));
}

// Deterministic shelf packing of each frame's visible bounds (tallest first, then recipe order).
// Cell coordinates are exported pixels; source bounds are unscaled canvas pixels.
function packTrimmed(frames, width, height, padding, scale) {
  const row = (box, y) => { const from = ((box.sy + y) * width + box.sx) * 4; return frames[box.index].data.subarray(from, from + box.w * 4); };
  const boxes = frames.map((frame, index) => {
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (frame.data[(y * width + x) * 4 + 3]) {
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
    }
    if (right < 0) return { index, sx: 0, sy: 0, w: 1, h: 1, empty: true, key: 'empty' };
    const box = { index, sx: left, sy: top, w: right - left + 1, h: bottom - top + 1 };
    // FNV-1a over the picture finds candidates; `same` then compares them byte for byte.
    let hash = 0x811c9dc5;
    for (let y = 0; y < box.h; y++) for (const byte of row(box, y)) hash = Math.imul(hash ^ byte, 0x01000193);
    return { ...box, key: hash >>> 0 };
  });
  const same = (a, b) => {
    if (a.empty) return true;
    for (let y = 0; y < a.h; y++) { const p = row(a, y), q = row(b, y); for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false; }
    return true;
  };
  return packBoxes(boxes, padding, scale, same);
}

// Frames whose trimmed pictures are the same share one cell: a hold, or a frame moved whole (each keeps its own
// sx, sy, so it is drawn where it stands). A box's `key` names its picture; `same` settles boxes of equal size and key.
function packBoxes(boxes, padding, scale, same = () => true) {
  const cellWidth = box => (box.w + padding * 2) * scale, cellHeight = box => (box.h + padding * 2) * scale;
  const first = new Map(), twins = new Map();
  const packed = boxes.filter(box => {
    const group = `${box.w}x${box.h}:${box.key}`, others = first.get(group) ?? [], twin = others.find(other => same(other, box));
    if (twin) { twins.set(box, twin); return false; }
    first.set(group, [...others, box]);
    return true;
  });
  const target = Math.max(...packed.map(cellWidth), Math.ceil(Math.sqrt(packed.reduce((sum, box) => sum + cellWidth(box) * cellHeight(box), 0))));
  const cells = new Array(boxes.length);
  let cursorX = 0, cursorY = 0, shelf = 0, used = 0;
  for (const box of [...packed].sort((a, b) => cellHeight(b) - cellHeight(a) || a.index - b.index)) {
    if (cursorX > 0 && cursorX + cellWidth(box) > target) { cursorY += shelf; cursorX = 0; shelf = 0; }
    cells[box.index] = { x: cursorX + padding * scale, y: cursorY + padding * scale, sx: box.sx, sy: box.sy, w: box.w, h: box.h, ...(box.empty && { empty: true }) };
    cursorX += cellWidth(box); shelf = Math.max(shelf, cellHeight(box)); used = Math.max(used, cursorX);
  }
  for (const [box, twin] of twins) cells[box.index] = { ...cells[twin.index], sx: box.sx, sy: box.sy };
  return { width: used, height: cursorY + shelf, cells };
}

export function scalePixels(data, width, height, scale = 1) {
  integer(scale, 'scale', 1, 16);
  const result = new Uint8ClampedArray(width * height * scale * scale * 4);
  if (scale === 1) { result.set(data.length > result.length ? data.subarray(0, result.length) : data); return result; }
  // Each source row is widened once, byte by byte, and that row copied into the rest of its `scale` rows.
  const rowBytes = width * scale * 4;
  for (let y = 0; y < height; y++) {
    const top = y * scale * rowBytes;
    for (let x = 0, from = y * width * 4, to = top; x < width; x++, from += 4) for (let r = 0; r < scale; r++, to += 4) {
      result[to] = data[from]; result[to + 1] = data[from + 1]; result[to + 2] = data[from + 2]; result[to + 3] = data[from + 3];
    }
    for (let r = 1; r < scale; r++) result.copyWithin(top + r * rowBytes, top, top + rowBytes);
  }
  return result;
}

// Perspective guides drawn over an enlarged review image, never into art: a horizon row, rays from up to three
// vanishing points and an isometric grid of tile diagonals. Coordinates are canvas pixel corners, like anchors.
export function readGuides(value, path = 'guides') {
  object(value, path, ['horizon', 'vanish', 'iso']);
  if (!Object.keys(value).length) fail(path, 'name a horizon, vanish points or an iso grid');
  const guides = {};
  if (value.horizon !== undefined) guides.horizon = integer(value.horizon, `${path}.horizon`, -4096, 8192);
  if (value.vanish !== undefined) {
    list(value.vanish, `${path}.vanish`, 3);
    if (!value.vanish.length) fail(`${path}.vanish`, 'expected 1–3 points [x, y]');
    guides.vanish = value.vanish.map((p, i) => { if (!Array.isArray(p) || p.length !== 2) fail(`${path}.vanish[${i}]`, 'expected [x, y]'); return [integer(p[0], `${path}.vanish[${i}][0]`, -16384, 16384), integer(p[1], `${path}.vanish[${i}][1]`, -16384, 16384)]; });
  }
  if (value.iso !== undefined) {
    const iso = object(value.iso, `${path}.iso`, ['tile', 'at']);
    if (!Array.isArray(iso.tile) || iso.tile.length !== 2) fail(`${path}.iso.tile`, 'expected [width, height] of one diamond tile, such as [32, 16]');
    guides.iso = { tile: [integer(iso.tile[0], `${path}.iso.tile[0]`, 2, 256), integer(iso.tile[1], `${path}.iso.tile[1]`, 1, 256)], at: iso.at === undefined ? [0, 0] : point(iso.at, `${path}.iso.at`) };
  }
  return guides;
}
const GUIDE_COLORS = { horizon: [255, 176, 32, 220], vanish: [40, 210, 255, 150], iso: [130, 255, 120, 120] };
// Draws `guides` into `target` (an RGBA image `targetWidth` wide) inside `box` ({left, top, w, h} in target pixels),
// where canvas pixel corner (region.x, region.y) sits at the box's corner and each canvas pixel is `scale` wide.
export function drawGuides(target, targetWidth, box, scale, region, guides) {
  const toX = x => box.left + (x - region.x) * scale, toY = y => box.top + (y - region.y) * scale;
  const right = box.left + box.w, bottom = box.top + box.h;
  // A segment in target pixels, clipped to the box (Liang–Barsky), then stepped one pixel at a time.
  const segment = (x0, y0, x1, y1, color) => {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    for (const [p, q] of [[-dx, x0 - box.left], [dx, right - 1 - x0], [-dy, y0 - box.top], [dy, bottom - 1 - y0]]) {
      if (p === 0) { if (q < 0) return; continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) return; if (t > t0) t0 = t; } else { if (t < t0) return; if (t < t1) t1 = t; }
    }
    const ax = x0 + t0 * dx, ay = y0 + t0 * dy, bx = x0 + t1 * dx, by = y0 + t1 * dy, steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    let last = -1;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(ax + (bx - ax) * i / steps), y = Math.round(ay + (by - ay) * i / steps);
      if (x < box.left || y < box.top || x >= right || y >= bottom) continue;
      const at = (y * targetWidth + x) * 4;
      if (at !== last) blend(target, at, color);
      last = at;
    }
  };
  // Canvas extent of the box, for lines that cross all of it.
  const cx0 = region.x, cy0 = region.y, cx1 = region.x + box.w / scale, cy1 = region.y + box.h / scale;
  if (guides.iso) {
    const [w, h] = guides.iso.tile, [x0, y0] = guides.iso.at, m = h / w;
    // Tile edges run through each diamond's top corner (x0 + w/2, y0) at slopes ±h/w, one line every h rows.
    for (const sign of [1, -1]) {
      const c0 = y0 - sign * m * (x0 + w / 2), at = x => sign * m * x;
      const low = Math.min(cy0 - at(cx0), cy0 - at(cx1)), high = Math.max(cy1 - at(cx0), cy1 - at(cx1));
      for (let k = Math.ceil((low - c0) / h); k <= Math.floor((high - c0) / h); k++) {
        const c = c0 + k * h;
        segment(toX(cx0), toY(at(cx0) + c), toX(cx1), toY(at(cx1) + c), GUIDE_COLORS.iso);
      }
    }
  }
  for (const [vx, vy] of guides.vanish ?? []) {
    // Rays through eight evenly spaced points on each side of the box, extended across it.
    const span = Math.max(cx1 - cx0, cy1 - cy0) * 2;
    for (let i = 0; i < 8; i++) {
      const f = (i + 0.5) / 8, x = cx0 + (cx1 - cx0) * f, y = cy0 + (cy1 - cy0) * f;
      for (const [px, py] of [[x, cy0], [x, cy1], [cx0, y], [cx1, y]]) {
        const reach = Math.max(Math.abs(px - vx), Math.abs(py - vy));
        if (!reach) continue;
        const k = 1 + span / reach;
        segment(toX(vx), toY(vy), toX(vx + (px - vx) * k), toY(vy + (py - vy) * k), GUIDE_COLORS.vanish);
      }
    }
  }
  if (guides.horizon !== undefined) segment(toX(cx0), toY(guides.horizon), toX(cx1), toY(guides.horizon), GUIDE_COLORS.horizon);
}

// Packs frames into one RGBA sheet. `trim: false` forces the uniform grid even for a trimmed recipe (aligned
// material passes need identical rectangles). Points and `anchorPx` are exported pixels; `pivot` and `anchor` are
// both the anchor as a share of the source size (0-1), TexturePacker's convention, which Phaser and PixiJS read as
// a sprite's origin.
export function buildAtlas(project, { trim } = {}) {
  const { width, height, frames, sheet } = project, s = sheet.scale;
  const trimmed = Boolean(sheet.trim) && trim !== false;
  const gridWidth = sheet.columns * (width + sheet.padding * 2) * s, gridHeight = Math.ceil(frames.length / sheet.columns) * (height + sheet.padding * 2) * s;
  const atlasWidth = trimmed ? sheet.width : gridWidth, atlasHeight = trimmed ? sheet.height : gridHeight;
  // Only a grid asked of a trimmed recipe (trim: false) can pass what readSheet allowed.
  if (atlasWidth * atlasHeight > PNG_PIXELS) sheetFits({ count: frames.length, width, height, columns: sheet.columns, padding: sheet.padding, scale: s, trim: false }, [atlasWidth, atlasHeight]);
  const data = new Uint8ClampedArray(atlasWidth * atlasHeight * 4);
  const entries = Object.create(null);
  const extras = frame => ({
    ...(frame.anchor && { pivot: { x: round6(frame.anchor[0] / width), y: round6(frame.anchor[1] / height) }, anchor: { x: round6(frame.anchor[0] / width), y: round6(frame.anchor[1] / height) }, anchorPx: { x: frame.anchor[0] * s, y: frame.anchor[1] * s } }),
    ...(frame.points && { points: Object.fromEntries(Object.entries(frame.points).map(([key, [x, y]]) => [key, { x: x * s, y: y * s }])) }),
    ...(frame.tile && { tile: { ...frame.tile, ...(frame.tile.collision && { collision: frame.tile.collision.map(polygon => polygon.map(([x, y]) => ({ x: x * s, y: y * s }))) }) } })
  });
  frames.forEach((frame, i) => {
    const pixels = scalePixels(frame.data, width, height, s), rowBytes = width * s * 4;
    if (trimmed) {
      const cell = sheet.layout[i], w = cell.w * s, h = cell.h * s;
      if (!cell.empty) for (let row = 0; row < h; row++) {
        const from = ((cell.sy * s + row) * width * s + cell.sx * s) * 4;
        data.set(pixels.subarray(from, from + w * 4), ((cell.y + row) * atlasWidth + cell.x) * 4);
      }
      entries[frame.name] = { frame: { x: cell.x, y: cell.y, w, h }, rotated: false, trimmed: true, spriteSourceSize: { x: cell.sx * s, y: cell.sy * s, w, h }, sourceSize: { w: width * s, h: height * s }, duration: frame.duration, ...extras(frame) };
      return;
    }
    const x = ((i % sheet.columns) * (width + sheet.padding * 2) + sheet.padding) * s;
    const y = (Math.floor(i / sheet.columns) * (height + sheet.padding * 2) + sheet.padding) * s;
    const w = width * s, h = height * s;
    for (let row = 0; row < h; row++) data.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), ((y + row) * atlasWidth + x) * 4);
    entries[frame.name] = { frame: { x, y, w, h }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w, h }, sourceSize: { w, h }, duration: frame.duration, ...extras(frame) };
  });
  const animations = Object.fromEntries(Object.entries(project.animations).map(([key, a]) => [key, { ...a, frames: a.frames.map(i => frames[i].name) }]));
  const frameTags = Object.entries(project.animations).map(([key, a]) => frameTag(key, a.frames)).filter(Boolean);
  const meta = { app: 'Pixelbolt', version: '1', image: `${project.name}.png`, format: 'RGBA8888', size: { w: atlasWidth, h: atlasHeight }, scale: String(s), frameTags };
  return { data, width: atlasWidth, height: atlasHeight, metadata: { frames: entries, animations, meta } };
}

// An Aseprite-style tag for an animation that plays one run of frames in recipe order: forward, backward, or forward
// and back without repeating either end (a ping-pong of a, b, c plays a, b, c, b). `from` and `to` are indices into
// the atlas's frames, lowest first. Any other sequence (holds, skips, frames from all over) has no from/to range, so
// it gets no tag: the atlas's `animations` lists every animation in full.
export function frameTag(name, sequence) {
  const first = sequence[0], last = sequence.at(-1), runs = (list, step) => list.every((index, i) => i === 0 || index - list[i - 1] === step);
  if (runs(sequence, 1)) return { name, from: first, to: last, direction: 'forward' };
  if (runs(sequence, -1)) return { name, from: last, to: first, direction: 'reverse' };
  if (sequence.length % 2 === 0) {
    const peak = sequence.length / 2, up = sequence.slice(0, peak + 1), down = sequence.slice(peak + 1);
    if (runs(up, 1) && down.every((index, i) => index === up[peak - 1 - i])) return { name, from: first, to: up[peak], direction: 'pingpong' };
  }
  return null;
}

// Inspection and comparison build in-memory contact sheets and palette-key text. Nothing is written.
const gutterColor = [23, 25, 29, 255], checkerColors = [[143, 145, 151, 255], [131, 133, 139, 255]];
const legendSymbols = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&*+-/:;<=>@^_~';
const toHex = color => '#' + [...color].slice(0, color[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('');
const colorId = (data, at) => ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;

// Names exact RGBA colors with single-character palette keys where possible. Other colors get legend symbols in a
// stable order (multi-character palette names, then first use by frame), so every readback of a revision agrees.
function colorNamer(project, others = []) {
  const keys = new Map(), names = new Map(), entries = new Map(), used = new Set(), unnamed = new Set();
  const symbols = [...legendSymbols].filter(symbol => !own(project.palette, symbol));
  for (const [key, value] of Object.entries(project.palette)) {
    const id = colorId(parseColor(value), 0);
    if (key.length === 1 && !keys.has(id)) keys.set(id, key);
    if (!names.has(id)) names.set(id, key);
  }
  const assign = (data, at) => {
    const id = colorId(data, at);
    if (!data[at + 3] || keys.has(id) || !symbols.length) return;
    const symbol = symbols.shift();
    keys.set(id, symbol);
    entries.set(symbol, { color: toHex(data.slice(at, at + 4)), ...(names.has(id) ? { palette: names.get(id) } : {}) });
  };
  for (const value of Object.values(project.palette)) assign(parseColor(value), 0);
  for (const source of [project, ...others]) for (const frame of source.frames) for (let at = 0; at < frame.data.length; at += 4) assign(frame.data, at);
  return {
    char(data, at) {
      if (!data[at + 3]) return '.';
      const id = colorId(data, at), char = keys.get(id);
      if (char === undefined) { unnamed.add(id); return '?'; }
      if (entries.has(char)) used.add(char);
      return char;
    },
    legend() {
      const legend = Object.fromEntries([...entries].filter(([symbol]) => used.has(symbol)));
      if (unnamed.size) legend['?'] = { colors: unnamed.size };
      return legend;
    }
  };
}
const readRegion = (data, width, region, namer) => Array.from({ length: region.h }, (_, y) =>
  Array.from({ length: region.w }, (_, x) => namer.char(data, ((region.y + y) * width + region.x + x) * 4)).join(''));

// Cells run left to right, top to bottom. The largest scale that keeps cells within 256px and the sheet within 1024px
// wins, then fewer rows, then less area. Checker squares span whole source pixels so transparency never reads as dithering.
// A sheet holds at most 4096 pixels of cells a side; their 2-pixel gutters may take it past that, so a still 4096
// pixels wide shows whole. Wider gutters (above scale 2) count against the limit. In all it is one PNG, at most
// 16,777,216 pixels (png.js), which 64 cells of 512x512 with their gutters would pass. `room` is what the image adds
// round the cells, which the same PNG must hold: a parts legend to the right (`legend`, its size beside a layout), a
// label band over each sheet stacked beside others (`height`), the pixels (`pixels`), the height (`maxHeight`, band
// included) and the width (`maxWidth`, legend included) one sheet may take, and for a sheet stacked with others
// (`sheets` of them) how tall the stack may be (`stack`, said in a refusal as `why`) and the least each other sheet
// takes (`others`), so stackViews can keep the image within STACK_SIDE.
const SHEET_SIDE = 4096, NO_ROOM = { pixels: PNG_PIXELS, height: 0, maxHeight: Infinity, maxWidth: Infinity, legend: null };
// The tallest image the views stacked beside one another make: about the longest side a model reads an image at
// (8,000 pixels), so the agent comparing them sees every one. The tallest label band stackViews writes over a sheet.
const STACK_SIDE = 8000, STACK_BAND = 2 * (FONT_HEIGHT + 4);
const withinSheet = (layout, room = NO_ROOM) => {
  if (layout.width > SHEET_SIDE + 2 * (layout.columns + 1) || layout.height > SHEET_SIDE + 2 * (layout.rows + 1)) return false;
  const legend = room.legend ? room.legend(layout) : { width: 0, height: 0 }, tall = Math.max(layout.height, legend.height) + room.height;
  return tall <= room.maxHeight && layout.width + legend.width <= room.maxWidth && (layout.width + legend.width) * tall <= room.pixels;
};
// The most of `count` cells of w×h one sheet holds at `scale` in some number of columns (fewer cells always fit).
function cellsThatFit(count, w, h, scale, room = NO_ROOM) {
  const gap = Math.max(2, scale), fits = n => {
    for (let c = 1; c <= n; c++) {
      const rows = Math.ceil(n / c);
      if (withinSheet({ columns: c, rows, scale, width: c * w * scale + (c + 1) * gap, height: rows * h * scale + (rows + 1) * gap }, room)) return true;
    }
    return false;
  };
  let low = 0, high = count;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
  return low;
}
// `layoutOnly`: the layout with no pixels (data null), for stackEvery's search.
function drawSheet(sources, width, region, { scale, background = null, columns, where = 'inspect', room = NO_ROOM, layoutOnly = false } = {}) {
  const measure = (c, s) => {
    const rows = Math.ceil(sources.length / c), gap = Math.max(2, s);
    return { columns: c, rows, scale: s, gap, width: c * region.w * s + (c + 1) * gap, height: rows * region.h * s + (rows + 1) * gap };
  };
  const choices = columns ? [columns] : Array.from(sources, (_, i) => i + 1);
  let layout = null;
  for (let s = scale ?? Math.min(16, Math.max(1, Math.floor(256 / Math.max(region.w, region.h)))); s >= (scale ?? 1) && !layout; s--) {
    for (const c of choices) {
      const m = measure(c, s);
      if (m.width <= 1024 && m.height <= 1024 && withinSheet(m, room) && (!layout || m.rows < layout.rows || (m.rows === layout.rows && m.width * m.height < layout.width * layout.height))) layout = m;
    }
  }
  // Otherwise the squarest layout within the limit, if any is.
  if (!layout) for (const c of choices) {
    const m = measure(c, scale ?? 1), better = !layout || (withinSheet(m, room) === withinSheet(layout, room) ? Math.max(m.width, m.height) < Math.max(layout.width, layout.height) : withinSheet(m, room));
    if (better) layout = m;
  }
  // A sheet that one PNG would hold alone but not as one of `sheets` stacked passes the height left to it in the
  // stack: said with how many recipes the one image holds. Cells are fitted first, so this is one row of one cell.
  // The others are counted by the least each can take (`room.others`, from stackViews), the shortest first, so a
  // taller neighbour is not counted as fitting; without them, as if each were as tall as this one.
  const alone = { ...room, pixels: PNG_PIXELS, maxHeight: Infinity, maxWidth: Infinity };
  if (room.sheets > 1 && !withinSheet(layout, room) && withinSheet(layout, alone)) {
    const legend = room.legend ? room.legend(layout) : { width: 0, height: 0 }, tall = Math.max(layout.height, legend.height) + room.height;
    let fit = Math.floor(room.stack / tall) - 1;
    if (room.others) {
      let left = room.stack - tall; fit = 0;
      for (const low of [...room.others].sort((a, b) => a - b)) { if (low > left) break; left -= low; fit++; }
    }
    const others = fit > 0 ? `at most ${fit} other recipe${fit === 1 ? '' : 's'}` : 'one recipe at a time';
    fail('beside', `one row of ${region.w}×${region.h} cells is ${tall} pixels tall with its gutters and label, past the ${room.maxHeight} left to it in an image of ${room.sheets} sheets stacked (${room.why}); compare ${others}, or show a smaller region`);
  }
  // Each side holds 4096 pixels of cells and 2 pixels a gutter; the gutters are as wide as the scale, so above scale 2
  // the rest of each counts against the 4096.
  if (!withinSheet(layout, room)) {
    const { width: w, height: h, columns, rows, gap } = layout, sides = w <= SHEET_SIDE + 2 * (columns + 1) && h <= SHEET_SIDE + 2 * (rows + 1);
    fail(where, `the contact sheet would be ${w}×${h} pixels, ${sides ? `past the ${grouped(PNG_PIXELS)} one PNG holds${room.legend ? ' with the parts legend' : ''}`
      : `above the 4096-pixel limit (4096 pixels of frames and 2-pixel gutters${gap > 2 ? `; the ${gap}-pixel gutters at scale ${layout.scale} count their other ${gap - 2} pixel${gap === 3 ? '' : 's'} against the 4096` : ''})`}; select fewer frames, a smaller region or a lower scale`);
  }
  if (layoutOnly) return { ...layout, data: null };
  const data = new Uint8ClampedArray(layout.width * layout.height * 4), square = Math.max(2, Math.ceil(8 / layout.scale)), composed = new Map();
  // The gutter colour is written once and doubled with copyWithin; each cell pixel's source colour is read into one
  // reused buffer for blend, rather than a new view of the frame a pixel.
  data.set(gutterColor, 0);
  for (let filled = 4; filled < data.length; filled *= 2) data.copyWithin(filled, 0, Math.min(filled, data.length - filled));
  const color = new Uint8ClampedArray(4);
  sources.forEach((source, n) => {
    if (!composed.has(source)) {
      const pixels = new Uint8ClampedArray(region.w * region.h * 4);
      for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) {
        const at = (y * region.w + x) * 4, from = ((region.y + y) * width + region.x + x) * 4, under = background ?? checkerColors[(Math.floor(x / square) + Math.floor(y / square)) % 2];
        pixels[at] = under[0]; pixels[at + 1] = under[1]; pixels[at + 2] = under[2]; pixels[at + 3] = under[3];
        if (source) { color[0] = source[from]; color[1] = source[from + 1]; color[2] = source[from + 2]; color[3] = source[from + 3]; blend(pixels, at, color); }
      }
      composed.set(source, scalePixels(pixels, region.w, region.h, layout.scale));
    }
    const pixels = composed.get(source), w = region.w * layout.scale, h = region.h * layout.scale;
    const left = layout.gap + (n % layout.columns) * (w + layout.gap), top = layout.gap + Math.floor(n / layout.columns) * (h + layout.gap);
    for (let row = 0; row < h; row++) data.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((top + row) * layout.width + left) * 4);
  });
  return { ...layout, data };
}

// A frame repeated 3x3, for judging how a tile reads when it tiles.
export function tileRepeat(data, width, height) {
  const out = new Uint8ClampedArray(width * height * 9 * 4), w = width * 3;
  for (let y = 0; y < height * 3; y++) for (let x = 0; x < w; x++) {
    const from = ((y % height) * width + x % width) * 4;
    out.set(data.subarray(from, from + 4), (y * w + x) * 4);
  }
  return out;
}
// Advisory seam evidence. Opposite edges do not need to match to tile well; what reads as a seam is (a) a line that
// doubles because both edges carry it, or (b) more large value steps across the wrap than across any interior
// boundary (a gradient or texture that does not continue). A stroke that merely touches one edge is not flagged.
export function tileReport(data, width, height) {
  const luma = at => (0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2]) * data[at + 3] / 255;
  const same = (a, b) => colorId(data, a) === colorId(data, b);
  const large = (a, b) => Math.abs(luma(a) - luma(b)) >= 24 || Math.abs(data[a + 3] - data[b + 3]) >= 128;
  const axis = (length, across, at) => {
    // `at(i, j)` addresses position i along the wrap axis and j across it.
    let wrapSteps = 0, interiorMax = 0;
    const doubled = [];
    for (let j = 0; j < across; j++) {
      if (large(at(length - 1, j), at(0, j))) wrapSteps++;
      if (length >= 3 && data[at(0, j) + 3] && same(at(0, j), at(length - 1, j)) && !same(at(0, j), at(1, j)) && !same(at(length - 1, j), at(length - 2, j))) doubled.push(j);
    }
    for (let i = 0; i < length - 1; i++) {
      let steps = 0;
      for (let j = 0; j < across; j++) if (large(at(i, j), at(i + 1, j))) steps++;
      interiorMax = Math.max(interiorMax, steps);
    }
    const threshold = Math.max(2, Math.ceil(across / 4));
    return { wrapSteps, interiorMaxSteps: interiorMax, doubled, suspicious: (wrapSteps > interiorMax && wrapSteps >= threshold) || doubled.length >= threshold };
  };
  const leftRight = axis(width, height, (i, j) => (j * width + i) * 4), topBottom = axis(height, width, (i, j) => (i * width + j) * 4);
  return {
    leftRight: { wrapSteps: leftRight.wrapSteps, interiorMaxSteps: leftRight.interiorMaxSteps, doubledRows: leftRight.doubled, suspicious: leftRight.suspicious },
    topBottom: { wrapSteps: topBottom.wrapSteps, interiorMaxSteps: topBottom.interiorMaxSteps, doubledColumns: topBottom.doubled, suspicious: topBottom.suspicious }
  };
}

// Frame-name patterns: `*` matches any run of characters and `?` exactly one. On a mismatch only the last `*` is
// retried, one character further on, so a match takes at most pattern × name steps; the regular expression this
// replaces backtracked through every `*` and a 14-character pattern could take seconds.
export function wildcard(pattern, text) {
  let p = 0, t = 0, star = -1, resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) { p++; t++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; resume = t; }
    else if (star !== -1) { p = star + 1; t = ++resume; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

// The parts view: every pixel in one flat colour for what drew it last, so a stray pixel or a tangle where limbs cross
// names its part. Colours go to the parts in the shown cells in drawing order, well apart in hue and lightness;
// past twenty they repeat darker. A background shows in one dark grey. The studio's Parts view colours the same way.
const PART_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#ffe119', '#911eb4', '#f58231', '#42d4f4', '#f032e6', '#bfef45', '#9a6324',
  '#469990', '#fabed4', '#000075', '#aaffc3', '#800000', '#dcbeff', '#808000', '#ffd8b1', '#ffffff', '#fffac8'].map(hex => parseColor(hex));
export function partColors(project, indices, region = { x: 0, y: 0, w: project.width, h: project.height }) {
  const { width, frames, ownerNames } = project, counts = new Map();
  for (const index of indices) {
    const owners = frames[index].owners;
    for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) {
      const id = owners[y * width + x];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let next = 0;
  const legend = [...counts.keys()].sort((a, b) => a - b).map(id => {
    const name = ownerNames[id - 1], round = Math.floor(next / PART_COLORS.length), base = PART_COLORS[next % PART_COLORS.length];
    const color = name === 'background' ? [43, 48, 54, 255] : base.map((v, c) => c === 3 ? 255 : v >> round);
    if (name !== 'background') next++;
    return { id, name, color, pixels: counts.get(id) };
  });
  const colors = new Map(legend.map(entry => [entry.id, entry.color])), pixels = new Map();
  for (const index of indices) {
    const owners = frames[index].owners, data = new Uint8ClampedArray(owners.length * 4);
    for (let at = 0; at < owners.length; at++) if (owners[at]) data.set(colors.get(owners[at]) ?? [128, 128, 128, 255], at * 4);
    pixels.set(index, data);
  }
  return { legend, pixels };
}
// A legend to the right of a contact sheet: a swatch and the part's name in the built-in font, in columns of at most
// as many rows as the sheet is tall (twelve at least). The cells keep their places. Its text is drawn at `t` times,
// twice on a sheet of scale 4 or more.
const legendScale = scale => Math.max(1, Math.min(2, Math.floor(scale / 2)));
const legendPerColumn = (count, height, t) => Math.max(1, Math.min(count, Math.max(12, Math.floor((height - 6 * t) / ((FONT_HEIGHT + 4) * t)))));
// The width each column takes and the legend's size, for names `widths` font pixels wide in columns of perColumn.
function legendSize(widths, t, perColumn) {
  const columns = [];
  for (let i = 0; i < widths.length; i += perColumn) columns.push(Math.max(...widths.slice(i, i + perColumn)) * t + 13 * t);
  return { columns, width: 3 * t + columns.reduce((sum, w) => sum + w, 0), height: perColumn * (FONT_HEIGHT + 4) * t + 6 * t };
}
// What a legend of any of these parts adds beside a layout (its height and scale), reserved when the cells are fitted:
// every name (a real legend has no more), in the columns drawPartLegend uses beside a sheet that tall.
function legendRoom(names) {
  const widths = names.map(name => layoutText(name).width);
  return layout => { const t = legendScale(layout.scale ?? 1); return legendSize(widths, t, legendPerColumn(widths.length, layout.height, t)); };
}
function drawPartLegend(sheet, legend) {
  const t = legendScale(sheet.scale), pad = 3 * t, row = (FONT_HEIGHT + 4) * t, swatch = 7 * t;
  const texts = legend.map(entry => layoutText(entry.name)), perColumn = legendPerColumn(legend.length, sheet.height, t);
  const { columns, width: added, height: tall } = legendSize(texts.map(text => text.width), t, perColumn);
  const width = sheet.width + added, height = Math.max(sheet.height, tall);
  if (width > SHEET_SIDE * 2 || height > SHEET_SIDE * 2 || width * height > PNG_PIXELS) fail('inspect.view', `the parts legend would make the sheet ${width}×${height} pixels, past the ${grouped(PNG_PIXELS)} one PNG holds; select fewer frames, a smaller region or a lower scale`);
  if (!sheet.data) return { ...sheet, width, height };
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(gutterColor, 0);
  for (let filled = 4; filled < data.length; filled *= 2) data.copyWithin(filled, 0, Math.min(filled, data.length - filled));
  for (let y = 0; y < sheet.height; y++) data.set(sheet.data.subarray(y * sheet.width * 4, (y + 1) * sheet.width * 4), y * width * 4);
  const fill = (x0, y0, w, h, color) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set(color, (y * width + x) * 4); };
  let left = sheet.width + pad;
  legend.forEach((entry, i) => {
    const column = Math.floor(i / perColumn), top = pad + (i % perColumn) * row;
    if (i % perColumn === 0 && column) left += columns[column - 1];
    fill(left, top, swatch, swatch, [0, 0, 0, 255]); fill(left + t, top + t, swatch - 2 * t, swatch - 2 * t, entry.color);
    const text = texts[i], x0 = left + swatch + 3 * t, y0 = top + text.top * t;
    text.rows.forEach((cells, y) => { for (let x = 0; x < cells.length; x++) if (cells[x] === '#') fill(x0 + x * t, y0 + y * t, t, t, [230, 234, 238, 255]); });
  });
  return { ...sheet, width, height, data };
}

// Small palette pictures side by side for review, such as a part drawn flat, turned today and drafted: a heading over
// each column and a label left of each row, in the built-in font. Every picture is enlarged `scale` times (at most 16;
// lowered so a cell stays within 256 pixels) and placed so its anchor pixel sits at one spot in its column and on one
// row across its row, so pictures compare pixel for pixel. The anchor pixel is outlined in magenta and named points in
// cyan, around the pixel, never over it; a cell is wide enough for every picture's pixels, anchor and points. A
// character of a label or heading that the font cannot draw is drawn as ?.
// `rows` are [{ label, cells: [{ rows, anchor, points } | null] }].
const ANCHOR_MARK = [255, 64, 224, 255], POINT_MARK = [64, 224, 255, 255], LABEL_INK = [230, 234, 238, 255];
const FONT_GLYPHS = new Set(FONT_CHARACTERS), inFont = text => [...String(text).normalize('NFC')].map(c => FONT_GLYPHS.has(c) ? c : '?').join('');
export function pictureSheet({ palette = {}, headings = [], rows: lines, scale = 6 }) {
  // How far a picture reaches from its anchor pixel, in its own pixels: left and up before it, right and down from it.
  const reach = c => {
    const marks = Object.values(c.points ?? {}), xs = [0, c.rows[0].length - 1, ...marks.map(p => p[0])], ys = [0, c.rows.length - 1, ...marks.map(p => p[1])];
    return { left: c.anchor[0] - Math.min(...xs), right: Math.max(...xs) + 1 - c.anchor[0], up: c.anchor[1] - Math.min(...ys), down: Math.max(...ys) + 1 - c.anchor[1] };
  };
  const cells = lines.flatMap(line => line.cells.filter(Boolean).map(reach));
  const left = Math.max(0, ...cells.map(c => c.left)), right = Math.max(1, ...cells.map(c => c.right));
  const across = left + right + 2, heights = lines.map(line => {
    const shown = line.cells.filter(Boolean).map(reach);
    return { up: Math.max(0, ...shown.map(c => c.up)) + 1, down: Math.max(1, ...shown.map(c => c.down)) + 1 };
  });
  const s = Math.max(1, Math.min(integer(scale, 'scale', 1, 16), Math.floor(256 / Math.max(across, ...heights.map(h => h.up + h.down))))), t = Math.max(1, Math.min(2, Math.floor(s / 3)));
  const pad = 3 * t, gap = Math.max(2, s), labels = lines.map(line => layoutText(inFont(line.label))), heads = headings.map(text => layoutText(inFont(text)));
  const labelWidth = Math.max(0, ...labels.map(text => text.width)) * t + 2 * pad, headHeight = heads.length ? (FONT_HEIGHT + 2) * t + 2 * pad : gap;
  const columns = Math.max(heads.length, ...lines.map(line => line.cells.length)), cellWidth = Math.max(across * s, Math.max(0, ...heads.map(text => text.width)) * t + 2 * pad);
  const width = labelWidth + columns * (cellWidth + gap) + gap, rowHeights = heights.map(h => Math.max((h.up + h.down) * s, (FONT_HEIGHT + 2) * t + 2 * pad));
  const height = headHeight + rowHeights.reduce((sum, h) => sum + h + gap, 0);
  if (width > SHEET_SIDE || height > SHEET_SIDE) fail('sheet', `the picture sheet would be ${width}×${height} pixels, above the 4096-pixel limit; show fewer or smaller pictures (every cell spans each picture's pixels, anchor and points, so an anchor or point far from its pixels widens them all)`);
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(gutterColor, 0);
  for (let filled = 4; filled < data.length; filled *= 2) data.copyWithin(filled, 0, Math.min(filled, data.length - filled));
  const fill = (x0, y0, w, h, color) => { for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) data.set(color, (y * width + x) * 4); };
  const write = (text, x0, y0) => text.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === '#') fill(x0 + x * t, y0 + (y + text.top) * t, t, t, LABEL_INK); });
  const ring = (x0, y0, color) => { fill(x0 - 1, y0 - 1, s + 2, 1, color); fill(x0 - 1, y0 + s, s + 2, 1, color); fill(x0 - 1, y0, 1, s, color); fill(x0 + s, y0, 1, s, color); };
  const colours = new Map(), colourOf = key => { if (!colours.has(key)) colours.set(key, parseColor(key, palette, `palette.${key}`)); return colours.get(key); };
  heads.forEach((text, c) => write(text, labelWidth + gap + c * (cellWidth + gap) + Math.floor((cellWidth - text.width * t) / 2), pad + 2 * t));
  let top = headHeight;
  lines.forEach((line, r) => {
    const rowHeight = rowHeights[r], { up } = heights[r], text = labels[r];
    write(text, pad, top + Math.floor((rowHeight - FONT_HEIGHT * t) / 2));
    line.cells.forEach((cell, c) => {
      const x0 = labelWidth + gap + c * (cellWidth + gap), square = Math.max(2, Math.ceil(8 / s)) * s;
      if (!cell) return;
      for (let y = 0; y < rowHeight; y++) for (let x = 0; x < cellWidth; x++) data.set(checkerColors[(Math.floor(x / square) + Math.floor(y / square)) % 2], ((top + y) * width + x0 + x) * 4);
      // The anchor's top-left corner in the cell, in sheet pixels.
      const ax = x0 + Math.floor((cellWidth - across * s) / 2) + (left + 1) * s, ay = top + Math.floor((rowHeight - (heights[r].up + heights[r].down) * s) / 2) + up * s;
      cell.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) {
        const key = row[x];
        if (key === '.' || key === ' ') continue;
        const color = colourOf(key), px = ax + (x - cell.anchor[0]) * s, py = ay + (y - cell.anchor[1]) * s;
        if (color[3]) for (let yy = py; yy < py + s; yy++) for (let xx = px; xx < px + s; xx++) if (xx >= 0 && yy >= 0 && xx < width && yy < height) blend(data, (yy * width + xx) * 4, color);
      } });
      for (const p of Object.values(cell.points ?? {})) ring(ax + (p[0] - cell.anchor[0]) * s, ay + (p[1] - cell.anchor[1]) * s, POINT_MARK);
      ring(ax, ay, ANCHOR_MARK);
    });
    top += rowHeight + gap;
  });
  return { width, height, scale: s, data };
}

// Which palette keys colour what, over every frame: a line a key with its colour, its pixels and the layers (a rig's
// parts) it colours most, so "the fur" or "the jacket" is a set of keys to change together. Keys of one ramp are
// listed together, dark to light, then the rest by pixels; `unused` names keys that draw nothing and `blended` counts
// pixels whose colour is no key's (two translucent colours over each other). Pixels are told apart by colour, so keys
// that share a colour are counted under the first of them, and `same` says which. `layers` names every layer that
// draws, in drawing order: what frames[*].layers[<name>].palette recolours alone. The project is rendered with owners.
export function paletteUse(project) {
  if (!project.ownerNames) fail('inspect.palette', 'palette needs the project rendered with { owners: true }, which records the layer that drew each pixel');
  const pack = (r, g, b, a) => ((r * 256 + g) * 256 + b) * 256 + a, keyOf = new Map(), use = new Map();
  const same = [], twins = new Set();
  for (const [key, value] of Object.entries(project.palette)) {
    const color = parseColor(value), id = pack(...color);
    if (!color[3]) continue;
    if (keyOf.has(id)) { twins.add(key); same.push(`${key} is the colour of ${keyOf.get(id)}, and counted there`); } else keyOf.set(id, key);
  }
  let blended = 0;
  for (const { data, owners } of project.frames) for (let i = 0; i < owners.length; i++) {
    if (!data[i * 4 + 3]) continue;
    const key = keyOf.get(pack(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]));
    if (key === undefined) { blended++; continue; }
    if (!use.has(key)) use.set(key, { pixels: 0, by: new Map() });
    const entry = use.get(key);
    entry.pixels++; entry.by.set(owners[i], (entry.by.get(owners[i]) ?? 0) + 1);
  }
  const line = key => {
    const { pixels, by } = use.get(key), parts = [...by].filter(([id]) => id).sort((a, b) => b[1] - a[1]).map(([id]) => project.ownerNames[id - 1]);
    return `${key} ${project.palette[key]}: ${pixels} px${parts.length ? ` on ${parts.slice(0, 4).join(', ')}${parts.length > 4 ? ` and ${parts.length - 4} more` : ''}` : ''}`;
  };
  const ramps = (project.ramps ?? []).map(ramp => ramp.filter(key => use.has(key))).filter(ramp => ramp.length), ramped = new Set(ramps.flat());
  const others = [...use.keys()].filter(key => !ramped.has(key)).sort((a, b) => use.get(b).pixels - use.get(a).pixels), unused = Object.keys(project.palette).filter(key => !use.has(key) && !twins.has(key));
  return { ...(ramps.length && { ramps: ramps.map(ramp => ramp.map(line)) }), ...(others.length && { [ramps.length ? 'others' : 'keys']: others.map(line) }), ...(same.length && { same }), ...(unused.length && { unused }), ...(blended && { blended }), layers: project.ownerNames.join(', '), counted: `every pixel of ${project.frames.length === 1 ? 'the one frame' : `all ${project.frames.length} frames`}, whatever the view shows` };
}

// The same view of several recipes as one image, each sheet under the one before and left-aligned, with its name
// written above it: a hero in three team colours, or a sprite before and after, compared with one look. `views` are
// inspectProject results with a `name` each. Returns the first view with the taller sheet and `stack`: where each
// recipe's sheet starts, under its label. Views inspected with `sheets` (the number stacked) and the automatic scale
// are measured as one stack: while it passes STACK_SIDE in height, or the one PNG, the tallest sheets are refitted
// to a common cap (a lower scale, then fewer cells), and a stack within both is left exactly as drawn. A refitted
// stack is kept to the width at which STACK_SIDE tall is one PNG, or to the narrowest its widest sheet can be (one
// cell). A scale asked for is drawn as asked, so only the one PNG bounds the stack.
const REFIT = Symbol('refit');
const measureStack = views => {
  const sheets = views.map(view => view.sheet), t = Math.max(1, Math.min(2, Math.floor(sheets[0].scale / 2))), pad = 3 * t, band = (FONT_HEIGHT + 4) * t;
  const labels = views.map(view => layoutText(String(view.name).replace(/[^\x20-\x7e]/g, '?'))), labelWidth = Math.max(...labels.map(text => text.width * t + 2 * pad));
  return { sheets, t, pad, band, labels, labelWidth, width: Math.max(labelWidth, ...sheets.map(sheet => sheet.width)), height: sheets.reduce((sum, sheet) => sum + band + sheet.height, 0) };
};
const stackFits = ({ width, height }) => height <= Math.min(STACK_SIDE, Math.floor(PNG_PIXELS / width));
// The views refitted within `wide` pixels: the tallest cut to a common cap until the stack fits (a refitted sheet may
// grow taller as it narrows, so it takes a few passes). Each refit is told the least the other sheets take (one cell at
// scale 1 and a label band). Every sheet that cannot hold the cells `every` makes is tried before the one refusal,
// which is the sheet needing the largest every.
const bySheet = (error, name) => {
  if (error instanceof PixelError && error.sheet !== name) Object.assign(error, { message: `${error.path}: ${name}: ${error.message.slice(error.path.length + 2)}`, sheet: name });
  return error;
};
function refitStack(views, wide) {
  const most = Math.min(STACK_SIDE, Math.floor(PNG_PIXELS / wide));
  const why = most < STACK_SIDE ? `${grouped(most)} pixels tall at most at ${wide} wide, ${grouped(PNG_PIXELS)} in all` : `${grouped(STACK_SIDE)} pixels tall at most`;
  for (let pass = 0; pass < 4 && !stackFits(measureStack(views)); pass++) {
    const { sheets, band } = measureStack(views), room = most - views.length * band, heights = sheets.map(sheet => sheet.height).sort((a, b) => b - a);
    const lows = views.map(view => view[REFIT].low + band);
    let cap = 1, short = null;
    for (let k = 1; k <= heights.length; k++) {
      const even = Math.floor((room - heights.slice(k).reduce((sum, h) => sum + h, 0)) / k);
      if (k === heights.length || even >= heights[k]) { cap = Math.max(1, even); break; }
    }
    // A sheet whose one cell is taller than the cap cannot be cut to it. It keeps the least it can take, and the cap
    // comes down until the others leave room for that, so a stack whose least heights fit is never refused: a
    // 100×4096 still beside four sheets of 16 cells was, told to "compare at most 4 other recipes". Where even the
    // least heights pass the image, the cap stands and the tall sheet's refusal says how many recipes it holds.
    const least = views.map(view => Math.min(view.sheet.height, view[REFIT].low));
    const taken = at => views.reduce((sum, view, i) => sum + Math.max(least[i], Math.min(view.sheet.height, at)), 0);
    const held = taken(1) <= room;
    if (held && taken(cap) > room) {
      let low = 1, high = cap;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (taken(mid) <= room) low = mid; else high = mid - 1; }
      cap = low;
    }
    views = views.map((view, i) => {
      const to = held ? Math.max(cap, least[i]) : cap;
      if (view.sheet.height <= to && view.sheet.width <= wide) return view;
      try { return { ...view[REFIT]({ maxHeight: to + STACK_BAND, maxWidth: wide, stack: most, why, others: lows.filter((_, j) => j !== i) }), name: view.name }; }
      catch (error) {
        if (error.every === undefined) throw bySheet(error, view.name);
        if (!short || error.every > short.every) short = bySheet(error, view.name);
        return view;
      }
    });
    if (short) throw short;
  }
  return views;
}
// A stack within STACK_SIDE and the one PNG is kept as drawn. Otherwise it is refitted at four widths, from its own
// (the height the PNG leaves at that width) to the width where STACK_SIDE tall is one PNG (narrower sheets, more
// height), and the one that shows the most cells wins, the wider on a tie. Where no width holds the cells `every`
// makes, the refusal is the width's needing the least every.
function refitted(views) {
  const measured = measureStack(views);
  if (stackFits(measured)) return views;
  const narrow = Math.max(Math.floor(PNG_PIXELS / STACK_SIDE), measured.labelWidth, ...views.map(view => view[REFIT].narrow));
  const widths = measured.width > narrow ? [...new Set([3, 2, 1, 0].map(k => narrow + Math.floor((measured.width - narrow) * k / 3)))] : [narrow];
  const tries = widths.map(wide => { try { return { views: refitStack(views, wide) }; } catch (error) { return { error }; } });
  const shown = ({ views }) => views.reduce((sum, view) => sum + view.cells.length, 0), fitted = tries.filter(entry => entry.views && stackFits(measureStack(entry.views)));
  if (!fitted.length) {
    if (tries.some(entry => entry.views)) return tries.find(entry => entry.views).views;
    const short = tries.filter(entry => entry.error.every !== undefined).sort((a, b) => a.error.every - b.error.every);
    throw (short[0] ?? tries.at(-1)).error;
  }
  return fitted.reduce((best, entry) => shown(entry) > shown(best) ? entry : best).views;
}
// The sheets alone that cannot hold the cells `every` makes (inspectProject leaves their refusal to the stack), as
// the one asking the largest every.
const shortest = views => views.filter(view => view[REFIT].short).map(view => bySheet(view[REFIT].short, view.name)).reduce((most, next) => (!most || next.every > most.every ? next : most), null);
// An `every` that a sheet, alone or refitted into the stack, cannot hold is refused once for the whole stack, naming
// the smallest every above it that holds every cell of every sheet. Each try inspects the views again (laid out, not
// drawn) at one every and refits the stack. Only a sheet's own bound (`alone`: 256 cells, or one 4096-pixel sheet)
// holds at every every past it, so only it is a lower bound: the stack is not monotone, since fewer cells can let a
// small sheet keep a larger scale and crowd the rest. So the search climbs from the every after the one asked (or the
// alone bound) by 1, 2, 4 … past it, and halves only the last gap. The refusal names the sheet refused at the every
// asked and what it holds there: in the stack, beside the other sheets' cells at that every; alone, its own bound,
// with the advice said as the stack's when it is past that bound. It says no "or more".
function stackEvery(views, first) {
  const asked = views[0].sampling.every;
  const check = every => {
    const again = views.map(view => ({ ...view[REFIT].every(every), name: view.name }));
    try {
      const short = shortest(again);
      if (short) throw short;
      return { every, views: refitted(again) };
    } catch (error) {
      if (error.every === undefined) throw error;
      return { every: error.alone ? Math.max(every, error.every - 1) : every, error };
    }
  };
  let low = { every: first.alone ? Math.max(asked, first.every - 1) : asked }, base = low.every + 1, rise = 0, high = null;
  while (!high) {
    const next = Math.min(60000, base + rise);
    if (next <= low.every) return first;
    const tried = check(next);
    if (tried.views) high = tried;
    // A sheet's own bound past the try starts the climb again from it.
    else if (tried.every > next) { low = tried; base = tried.every + 1; rise = 0; }
    else { low = tried; rise = Math.max(1, rise * 2); }
  }
  while (high.every - low.every > 1) {
    const tried = check(Math.floor((low.every + high.every) / 2));
    if (tried.views) high = tried; else low = tried;
  }
  // A sheet's own bound the stack does not move is said as it is; one past it is the stack's.
  const { sheet, duration, held, why, alone } = first, stacked = alone ? (high.every > first.every ? 'stacked with the others, ' : '') : null;
  return new PixelError('inspect.every', `${sheet}: ${duration} ms at one cell per ${asked} ms is ${Math.ceil(duration / asked)} cells, and ${why} ${held}${alone ? '' : " beside the other sheets' cells at that every"}; ${stacked ?? ''}choose every ${high.every}`);
}
function fitStack(views) {
  if (!views.every(view => view[REFIT])) {
    const short = views.find(view => view[REFIT]?.short);
    if (short) throw bySheet(short[REFIT].short, short.name);
    return views;
  }
  try {
    const short = shortest(views);
    if (short) throw short;
    return refitted(views);
  } catch (error) {
    throw error.every === undefined ? error : stackEvery(views, error);
  }
}
export function stackViews(views) {
  views = fitStack(views);
  const { sheets, t, pad, band, labels, width, height } = measureStack(views), stack = [];
  if (width * height > PNG_PIXELS) fail('beside', `the ${views.length} sheets stacked would be ${width}×${height} pixels, past the ${grouped(PNG_PIXELS)} one PNG holds; compare fewer recipes, or show fewer cells (maxCells), a smaller region or a lower scale`);
  const data = new Uint8ClampedArray(width * height * 4);
  // The gutter colour is written once and doubled with copyWithin, as drawSheet does, not set pixel by pixel.
  data.set(gutterColor, 0);
  for (let filled = 4; filled < data.length; filled *= 2) data.copyWithin(filled, 0, Math.min(filled, data.length - filled));
  let y = 0;
  sheets.forEach((sheet, index) => {
    const text = labels[index], top = y + 2 * t + text.top * t;
    text.rows.forEach((cells, row) => { for (let x = 0; x < cells.length; x++) if (cells[x] === '#') for (let dy = 0; dy < t; dy++) for (let dx = 0; dx < t; dx++) data.set([230, 234, 238, 255], ((top + row * t + dy) * width + pad + x * t + dx) * 4); });
    y += band;
    for (let row = 0; row < sheet.height; row++) data.set(sheet.data.subarray(row * sheet.width * 4, (row + 1) * sheet.width * 4), (y + row) * width * 4);
    stack.push({ name: views[index].name, y, height: sheet.height });
    y += sheet.height;
  });
  const { name, ...first } = views[0];
  return { ...first, sheet: { ...sheets[0], data, width, height }, stack };
}

// One picture laid over another, pixel for pixel (`top` over `bottom`, both RGBA of one size): what a game draws when
// it stacks frames.
function laidOver(bottom, top, origins, topMask) {
  const out = new Uint8ClampedArray(bottom);
  for (let i = 0; i < top.length; i += 4) {
    const a = top[i + 3];
    if (a && origins) origins.set(i / 4, topMask?.[i / 4] || (a < 255 && out[i + 3] > 0));
    if (a === 255 || !out[i + 3]) { if (a) out.set(top.subarray(i, i + 4), i); continue; }
    if (!a) continue;
    const under = out[i + 3] * (255 - a) / 255, all = a + under;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((top[i + c] * a + out[i + c] * under) / all);
    out[i + 3] = Math.round(all);
  }
  return out;
}
// `stack` and `under` are for art that is only judged laid over other art. stack: a list of cells, each a list of
// frame names drawn in order, the first at the bottom (a body, then the plate and the fin a game draws over it): the
// sheet has one cell a group, named "body+plate+fin", and everything else (region, scale, view, grid) reads those
// cells as frames. under: { width, height, data } (RGBA), a picture from elsewhere (a ground tile of another recipe)
// repeated from the top left under every cell, so a sprite is seen on what it will lie on.
// The third argument is never a caller's option (MCP and the CLI pass the user's options as the second): `sheets` is
// beside's, how many sheets it draws in one image (1 to 9; stackViews refits the tallest when they pass it). `share`
// is stackViews' own: the room a sheet stacked beside others is refitted to ({ maxHeight, maxWidth, stack, why }, and
// `others`, the least each other sheet takes). `measure` is stackEvery's: the sheet laid out with no pixels drawn.
export function inspectProject(project, options = {}, { sheets = 1, share, measure = false } = {}) {
  object(options, 'inspect', ['frames', 'animation', 'region', 'grid', 'scale', 'background', 'view', 'native', 'diagnostics', 'maxCells', 'step', 'offset', 'every', 'guides', 'stack', 'under']);
  // The project as given: stack and under replace `project` with their composites, and a refit starts again from this.
  const source = project, { width, height } = project;
  if (options.stack !== undefined) {
    if (options.frames !== undefined || options.animation !== undefined) fail('inspect.stack', 'stack names the frames of each cell itself; omit frames and animation');
    if (options.view === 'parts') fail('inspect.view', 'parts colours one frame by its layers; a stack is several frames, so omit view or stack');
    list(options.stack, 'inspect.stack', 256);
    if (!options.stack.length) fail('inspect.stack', 'list at least one cell: [["body", "plate"]]');
    const stacked = options.stack.map((group, g) => {
      const p = `inspect.stack[${g}]`;
      list(group, p, 16);
      if (!group.length) fail(p, 'a cell lists one to sixteen frame names, the bottom one first');
      const layers = group.map((ref, n) => project.frames.find(f => f.name === ref) ?? fail(`${p}[${n}]`, `unknown frame ${JSON.stringify(ref)}`));
      const origins = options.diagnostics && new BlendOrigins(width * height, layers[0].blendMask);
      const data = layers.slice(1).reduce((bottom, frame) => laidOver(bottom, frame.data, origins, frame.blendMask), layers[0].data);
      return { name: group.join('+'), duration: layers[0].duration, data, ...(origins && { blendMask: origins.mask, inherited: layers.flatMap(frameColours) }) };
    });
    project = { ...project, frames: stacked, animations: {}, ownerNames: undefined };
  }
  if (options.under !== undefined) {
    const under = object(options.under, 'inspect.under', ['width', 'height', 'data']), uw = integer(under.width, 'inspect.under.width', 1, 4096), uh = integer(under.height, 'inspect.under.height', 1, 4096);
    if (!(under.data instanceof Uint8ClampedArray || under.data instanceof Uint8Array) || under.data.length !== uw * uh * 4) fail('inspect.under.data', `expected the ${uw}×${uh} picture as RGBA bytes`);
    if (options.grid || options.diagnostics) fail('inspect.under', 'grid and diagnostics read the recipe\'s own pixels; omit under for them');
    if (options.view !== undefined && options.view !== 'color') fail('inspect.under', 'under shows a frame on another picture, in colour; omit view');
    const ground = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) ground.set(under.data.subarray(((y % uh) * uw + x % uw) * 4, ((y % uh) * uw + x % uw) * 4 + 4), (y * width + x) * 4);
    project = { ...project, frames: project.frames.map(frame => ({ ...frame, data: laidOver(ground, frame.data) })), ownerNames: undefined };
  }
  const { frames } = project;
  if (options.frames !== undefined && options.animation !== undefined) fail('inspect', 'choose frames or animation, not both: frames picks the named frames in the order named, animation one animation\'s frames in play order');
  let cells = frames.map((_, i) => i);
  if (options.animation !== undefined) {
    // Stills keep their flipbook to step through, but it is no animation to choose.
    if (project.stills) fail('inspect.animation', stillsHaveNoAnimation('choose'));
    if (typeof options.animation !== 'string' || !own(project.animations, options.animation)) fail('inspect.animation', `unknown animation ${JSON.stringify(options.animation)}`);
    cells = project.animations[options.animation].frames;
  } else if (options.frames !== undefined) {
    list(options.frames, 'inspect.frames', 1024);
    if (!options.frames.length) fail('inspect.frames', 'select at least one frame');
    // A name with * (any run of characters) or ? (one character) selects every matching frame in project order.
    cells = options.frames.flatMap((ref, i) => {
      if (typeof ref === 'string' && /^[a-zA-Z0-9_*?-]+$/.test(ref) && /[*?]/.test(ref)) {
        const matches = frames.flatMap((f, index) => (wildcard(ref, f.name) ? [index] : []));
        if (!matches.length) fail(`inspect.frames[${i}]`, `no frame matches ${JSON.stringify(ref)}`);
        return matches;
      }
      const index = frames.findIndex(f => f.name === ref);
      if (index < 0) fail(`inspect.frames[${i}]`, `unknown frame ${JSON.stringify(ref)}`);
      return [index];
    });
    if (cells.length > 1024) fail('inspect.frames', `the names and patterns select ${cells.length} frames; at most 1,024 cells`);
  }
  const mode = options.view ?? 'color';
  if (!['color', 'silhouette', 'grayscale', 'onion', 'tile', 'parts'].includes(mode)) fail('inspect.view', 'expected color, silhouette, grayscale, onion, tile or parts');
  if (mode === 'parts' && !project.ownerNames) fail('inspect.view', 'parts needs the project rendered with { owners: true }, which records the layer that drew each pixel');
  if (mode === 'onion' && options.animation === undefined) fail('inspect.view', 'onion requires an animation so neighbors have an unambiguous playback position');
  if (mode === 'tile' && options.region !== undefined) fail('inspect.region', 'tile view repeats whole frames; omit region');
  if (mode === 'tile' && options.guides !== undefined) fail('inspect.guides', 'guides draw over one canvas; tile view repeats it, so omit guides');
  // A frame whose 3×3 repeat no sheet holds even as one cell at scale 1 (a side over 1365) is past any sheet, whatever
  // the frames, scale or region: said as that, not with what to lower.
  if (mode === 'tile' && !withinSheet({ columns: 1, rows: 1, width: width * 3 + 4, height: height * 3 + 4 })) fail('inspect.view', `a ${width}×${height} frame repeated 3×3 makes a sheet of ${width * 3 + 4}×${height * 3 + 4} pixels with its gutters at scale 1, more than one holds (4096 pixels of frames a side, ${grouped(PNG_PIXELS)} pixels in all), so tile view cannot show it`);
  const guides = options.guides === undefined ? null : readGuides(options.guides, 'inspect.guides');
  let region = { x: 0, y: 0, w: width, h: height };
  if (options.region !== undefined) {
    const r = object(options.region, 'inspect.region', ['x', 'y', 'w', 'h']);
    const x = integer(r.x, 'inspect.region.x', 0, width - 1), y = integer(r.y, 'inspect.region.y', 0, height - 1);
    region = { x, y, w: integer(r.w, 'inspect.region.w', 1, width - x), h: integer(r.h, 'inspect.region.h', 1, height - y) };
  }
  const grid = boolean(options.grid ?? false, 'inspect.grid');
  const scale = options.scale === undefined ? undefined : integer(options.scale, 'inspect.scale', 1, 16);
  const background = (options.background ?? 'checker') === 'checker' ? null : parseColor(options.background, project.palette, 'inspect.background');
  const native = boolean(options.native ?? false, 'inspect.native'), diagnostics = boolean(options.diagnostics ?? false, 'inspect.diagnostics');
  const total = cells.length, methods = [];
  let positions = cells.map((_, i) => i);
  // A stride picks every step-th position from offset, so a strobe that alternates A and B frames can be read as all
  // A frames (offset 0, step 2) or all B frames (offset 1); evenly spaced samples would alias between them.
  const step = options.step === undefined ? 1 : integer(options.step, 'inspect.step', 1, 1024);
  const offset = options.offset === undefined ? 0 : integer(options.offset, 'inspect.offset', 0, 2047);
  if (offset >= total) fail('inspect.offset', `the selection has ${total} position${total === 1 ? '' : 's'}, numbered from 0; choose an offset below ${total}`);
  // A cell per `every` milliseconds of playback: a frame fills as many cells as it is held, so the sheet reads as
  // the animation plays, holds and fast steps included.
  const every = options.every === undefined ? undefined : integer(options.every, 'inspect.every', 10, 60000);
  // A sheet stacked beside others that cannot hold the cells `every` makes (past 256, or past what one sheet holds) is
  // refused by stackViews, which knows the whole stack: the every this sheet alone needs could be refused again by
  // another sheet or when the stack is refitted. Such a sheet is drawn with one cell, only to be measured.
  let short;
  const defer = error => { if (sheets === 1 || share || options.scale !== undefined) throw error; short = error; };
  if (every !== undefined) {
    if (options.animation === undefined) fail('inspect.every', 'every samples playback, so it needs an animation');
    if (options.step !== undefined || options.offset !== undefined) fail('inspect.every', 'every picks positions by time; omit step and offset');
    const a = project.animations[options.animation], count = Math.ceil(a.duration / every), most = Math.ceil(a.duration / 256);
    if (count > 256) defer(Object.assign(new PixelError('inspect.every', `${a.duration} ms at one cell per ${every} ms is ${count} cells; at most 256, so choose every ${most} or more`),
      { every: most, cells: count, held: 256, duration: a.duration, why: 'a sheet holds at most', alone: true }));
    positions = Array.from({ length: short ? 1 : count }, (_, n) => animationPosition(project, a, n * every));
    methods.push(`one cell per ${every} ms of playback`);
  }
  if (step > 1 || offset > 0) {
    positions = positions.filter(i => i >= offset && (i - offset) % step === 0);
    const suffix = step % 100 >= 11 && step % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][step % 10] ?? 'th';
    methods.push(step === 1 ? `every position from ${offset}` : `every ${step}${suffix} position from ${offset}`);
  }
  const spread = (chosen, count) => Array.from({ length: count }, (_, i) => chosen[count === 1 ? 0 : Math.floor(i * (chosen.length - 1) / (count - 1))]);
  // Cells by time read as playback only while every one is shown: where a sheet of big frames (over 256 a side) or a
  // share of a beside image cannot hold the cells `every` makes, it is refused with the `every` that fits, as more
  // than 256 is. A maxCells the caller gives thins them evenly instead, as it thins frames. The refusal carries what
  // stackEvery reads: the every needed, the cells the sheet holds, the bound it met and whether that bound is the
  // sheet's own (`alone`: no every below the one needed holds, whatever the stack does).
  const thinEvery = (count, why) => {
    const { duration } = project.animations[options.animation];
    throw Object.assign(new PixelError('inspect.every', `${duration} ms at one cell per ${every} ms is ${positions.length} cells, and ${why} ${count}; choose every ${Math.ceil(duration / count)} or more`),
      { every: Math.ceil(duration / count), cells: positions.length, held: count, duration, why, alone: !share });
  };
  const box = mode === 'tile' ? { w: width * 3, h: height * 3 } : region;
  if (options.maxCells !== undefined) {
    const requested = integer(options.maxCells, 'inspect.maxCells', 1, 256);
    // What one sheet holds is measured as the sheet itself measures it (a rougher bound here said 45 cells of 1024×256
    // where the same sheet without maxCells showed 60).
    const count = Math.min(positions.length, requested, Math.max(1, cellsThatFit(positions.length, box.w, box.h, 1)));
    if (count < positions.length && every !== undefined && count < requested && (width > 256 || height > 256)) thinEvery(count, `one 4096-pixel sheet of ${box.w}×${box.h} cells holds`);
    if (count < positions.length) { positions = spread(positions, count); methods.push('evenly spaced, including endpoints'); }
  }
  // Big frames (an animation's are up to 1024 a side) or a long play order may not fit one sheet at scale 1; with no
  // scale asked for, the sheet shows as many evenly spaced cells as it holds rather than refusing. A scale asked for
  // that does not fit is still refused, with what to lower. The room is what the image adds round the cells: the parts
  // legend, and for a sheet stacked beside others a label band and the stack's height: each sheet is first drawn as
  // it would be alone, and stackViews refits the tallest (`share`) only when the stack would pass STACK_SIDE.
  let room = NO_ROOM;
  if (options.scale === undefined && (mode === 'parts' || sheets > 1)) {
    room = { pixels: PNG_PIXELS, height: sheets > 1 ? STACK_BAND : 0, maxHeight: sheets > 1 ? STACK_SIDE : Infinity, maxWidth: Infinity, sheets, stack: STACK_SIDE, why: `${grouped(STACK_SIDE)} pixels tall at most`,
      legend: mode === 'parts' ? legendRoom(project.ownerNames) : null, ...(sheets > 1 && share) };
  }
  const inStack = `the height left to it in an image of ${sheets} sheets stacked (${room.why}) holds`;
  if (options.scale === undefined) {
    const count = Math.max(1, cellsThatFit(positions.length, box.w, box.h, 1, room));
    if (count < positions.length && every !== undefined) {
      try { thinEvery(count, share ? inStack : `one 4096-pixel sheet${sheets > 1 ? ` (one of ${sheets} in the image)` : ''} of ${box.w}×${box.h} cells holds`); } catch (error) { defer(error); }
    }
    // A sheet stackViews will refuse is only measured again, so it is drawn with one cell.
    if (short) positions = spread(positions, 1);
    else if (count < positions.length) { positions = spread(positions, count); methods.push(`evenly spaced to fit ${share ? 'the height left to it in the stacked image' : 'the 4096-pixel sheet'}, including endpoints`); }
  }
  cells = positions.map(i => cells[i]);
  const unique = [...new Set(cells)];
  if (grid && unique.length * region.w * region.h > 16384) fail('inspect.grid', `grids are limited to 16,384 pixels, not ${unique.length} × ${region.w}×${region.h}; select fewer frames or a smaller region`);
  let view;
  if (mode === 'tile') {
    const repeats = new Map(unique.map(i => [i, measure ? null : tileRepeat(frames[i].data, width, height)]));
    const tiled = { x: 0, y: 0, w: width * 3, h: height * 3 };
    view = { cells: cells.map(i => ({ frame: frames[i].name, duration: frames[i].duration })), region, sheet: drawSheet(cells.map(i => repeats.get(i)), width * 3, tiled, { scale, background, room, layoutOnly: measure }), mode };
    if (!measure) view.tiles = unique.map(i => ({ frame: frames[i].name, ...tileReport(frames[i].data, width, height) }));
    if (native && !measure && view.sheet.scale > 1) view.nativeSheet = drawSheet(cells.map(i => repeats.get(i)), width * 3, tiled, { scale: 1, background });
  } else {
    const parts = mode === 'parts' ? partColors(project, unique, region) : null;
    const sources = cells.map((i, n) => measure ? null : mode === 'onion' ? onionPixels(project, project.animations[options.animation], positions[n]) : parts ? parts.pixels.get(i) : reviewPixels(frames[i].data, mode));
    view = { cells: cells.map(i => ({ frame: frames[i].name, duration: frames[i].duration })), region, sheet: drawSheet(sources, width, region, { scale, background, room, layoutOnly: measure }) };
    if (guides && !measure) {
      // Over every cell of the enlarged sheet; the native sheet keeps its exact pixels.
      const { sheet } = view, w = region.w * sheet.scale, h = region.h * sheet.scale;
      cells.forEach((_, n) => drawGuides(sheet.data, sheet.width, { left: sheet.gap + (n % sheet.columns) * (w + sheet.gap), top: sheet.gap + Math.floor(n / sheet.columns) * (h + sheet.gap), w, h }, sheet.scale, region, guides));
      view.guides = guides;
    }
    if (mode !== 'color') view.mode = mode;
    if (native && !measure && (view.sheet.scale > 1 || guides)) view.nativeSheet = drawSheet(sources, width, region, { scale: 1, background });
    if (parts) {
      view.parts = parts.legend.map(({ name, color, pixels }) => ({ name, color: toHex(color), pixels }));
      view.sheet = drawPartLegend(view.sheet, parts.legend);
      if (view.nativeSheet) view.nativeSheet = drawPartLegend(view.nativeSheet, parts.legend);
    }
  }
  // A sheet already at scale 1 is the native sheet: said once rather than drawn and sent twice.
  if (native && !view.nativeSheet) view.native = 'same as sheet';
  // How narrow and how short stackViews can make this sheet: one cell at scale 1, with its legend.
  if (room.sheets > 1) {
    const one = { columns: 1, rows: 1, scale: 1, width: box.w + 4, height: box.h + 4 }, legend = room.legend ? room.legend(one) : { width: 0, height: 0 };
    // A refit redraws the sheet; what does not depend on it (diagnostics, timing) is kept rather than measured again.
    const redraw = { ...options, diagnostics: undefined };
    view[REFIT] = Object.assign(share => {
      const again = inspectProject(source, redraw, { sheets, share, measure });
      delete again.timing;
      return Object.assign(again, view.diagnostics && { diagnostics: view.diagnostics }, view.timing && { timing: view.timing });
    }, { narrow: one.width + legend.width, low: Math.max(one.height, legend.height), short,
      // The sheet inspected afresh at another every, for stackEvery.
      ...(every !== undefined && { every: next => inspectProject(source, { ...redraw, every: next }, { sheets, measure: true }) }) });
  }
  if (every !== undefined) view.sampling = { total, shown: cells.length, every, positions, method: `${methods.join(', then ')}; a frame fills a cell for each ${every} ms it is held` };
  else if (total !== cells.length) view.sampling = { total, shown: cells.length, omitted: total - cells.length, positions, ...((step > 1 || offset > 0) && { step, offset }), method: `${methods.join(', then ')}; durations are original, not playback timing` };
  if (diagnostics) view.diagnostics = analyzeProject(project);
  if (options.animation !== undefined && !measure && (diagnostics || mode === 'onion' || every !== undefined)) {
    const a = project.animations[options.animation], fps = animationFps(project, options.animation); let start = 0;
    view.timing = { animation: options.animation, duration: a.duration, loop: a.loop, ...(fps !== undefined && { fps }), entries: a.frames.map((index, position) => {
      const entry = { position, frame: frames[index].name, start, duration: frames[index].duration, ...animationNeighbors(a, position) };
      // How many pixels this step changes: 0 is a hold, and a step far above its neighbours is a jump.
      if (entry.previous !== null) entry.changed = changedPixels(frames[a.frames[entry.previous]].data, frames[index].data);
      start += entry.duration; return entry;
    }) };
  }
  if (!grid) return view;
  if (mode === 'parts') {
    // One character per part: its legend symbol, "." where nothing drew.
    const symbols = new Map(view.parts.map((part, i) => [part.name, legendSymbols[i] ?? '?']));
    const key = id => id ? symbols.get(project.ownerNames[id - 1]) : '.';
    view.grids = unique.map(index => ({ frame: frames[index].name, rows: Array.from({ length: region.h }, (_, y) =>
      Array.from({ length: region.w }, (_, x) => key(frames[index].owners[(region.y + y) * width + region.x + x])).join('')) }));
    view.legend = Object.fromEntries(view.parts.map((part, i) => [legendSymbols[i] ?? '?', { part: part.name, color: part.color }]));
    return view;
  }
  const namer = colorNamer(project);
  view.grids = unique.map(index => ({ frame: frames[index].name, rows: readRegion(frames[index].data, width, region, namer) }));
  view.legend = namer.legend();
  return view;
}

function changedPixels(a, b) {
  let count = 0;
  for (let at = 0; at < a.length; at += 4) if (a[at] !== b[at] || a[at + 1] !== b[at + 1] || a[at + 2] !== b[at + 2] || a[at + 3] !== b[at + 3]) count++;
  return count;
}
// Positions refer to the expanded sequence, never the recipe's frame order.
export function animationPosition(project, animation, time) {
  let cursor = animation.loop ? ((time % animation.duration) + animation.duration) % animation.duration : Math.max(0, Math.min(time, animation.duration));
  for (let position = 0; position < animation.frames.length; position++) {
    const duration = project.frames[animation.frames[position]].duration;
    if (cursor < duration) return position;
    cursor -= duration;
  }
  return animation.frames.length - 1;
}
// Frames per second of an animation of two or more frames that all last the same, for engines and editors that ask
// for a rate: to two decimals (70 ms a frame is 14.29), or three significant figures under 1 (60 s a frame is 0.0167);
// undefined when the durations differ or there is one frame.
export function animationFps(project, key) {
  const durations = project.animations[key].frames.map(i => project.frames[i].duration);
  if (durations.length < 2 || durations.some(ms => ms !== durations[0])) return undefined;
  const fps = 1000 / durations[0];
  return fps >= 1 ? Math.round(fps * 100) / 100 : Number(fps.toPrecision(3));
}
export function animationNeighbors(animation, position) {
  integer(position, 'animation.position', 0, animation.frames.length - 1);
  const count = animation.frames.length;
  return { previous: position > 0 ? position - 1 : animation.loop ? count - 1 : null, next: position + 1 < count ? position + 1 : animation.loop ? 0 : null };
}
export function reviewPixels(data, mode = 'color') {
  if (mode === 'color') return data;
  if (!['silhouette', 'grayscale'].includes(mode)) fail('view', 'expected color, silhouette or grayscale');
  const result = new Uint8ClampedArray(data.length);
  for (let at = 0; at < data.length; at += 4) {
    if (!data[at + 3]) continue;
    const value = mode === 'silhouette' ? 240 : Math.round(.2126 * data[at] + .7152 * data[at + 1] + .0722 * data[at + 2]);
    result.set([value, value, value, mode === 'silhouette' ? 255 : data[at + 3]], at);
  }
  return result;
}
export function onionPixels(project, animation, position) {
  const result = new Uint8ClampedArray(project.width * project.height * 4);
  const neighbors = animationNeighbors(animation, position);
  for (const [neighbor, color] of [[neighbors.previous, [240, 83, 120, 100]], [neighbors.next, [65, 201, 240, 100]]]) {
    if (neighbor === null) continue;
    const data = project.frames[animation.frames[neighbor]].data;
    for (let at = 0; at < data.length; at += 4) if (data[at + 3]) blend(result, at, color, data[at + 3] / 255);
  }
  const current = project.frames[animation.frames[position]].data;
  for (let at = 0; at < current.length; at += 4) blend(result, at, current.subarray(at, at + 4));
  return result;
}

// Advisory evidence, not an aesthetic score. Never changes artwork or invalidates holds/sparks.
export function analyzeProject(project) {
  const { width, height, frames } = project, findings = [], hashes = new Map(), cleanup = new Map();
  const known = new Set(Object.values(project.palette).map(color => colorId(parseColor(color), 0)));
  const stats = frames.map(frame => {
    const colors = new Set(), outside = new Set(), blended = new Set(), isolated = [], unlisted = [], mixes = [];
    // Colors a frame or layer palette introduces are declared for that frame, and for the frames that continue it or
    // copy from it (`inherited`), whose pixels carry them.
    const introduced = frameColours(frame);
    const declared = introduced.length ? new Set([...known, ...introduced.map(color => colorId(parseColor(color), 0))]) : known;
    let visible = 0, isolatedCount = 0, hash = 2166136261;
    for (let at = 0; at < frame.data.length; at += 4) {
      const id = frame.data[at + 3] ? colorId(frame.data, at) : 0;
      hash = Math.imul(hash ^ id, 16777619) >>> 0;
      if (!id) continue;
      visible++; colors.add(id);
      const x = at / 4 % width, y = Math.floor(at / 4 / width);
      if (!declared.has(id)) {
        const mixed = frame.blendMask?.[at / 4], seen = mixed ? blended : outside, samples = mixed ? mixes : unlisted;
        if (!seen.has(id)) {
          seen.add(id);
          if (samples.length < 32) samples.push({ x, y, color: toHex(frame.data.subarray(at, at + 4)) });
        }
      }
      let neighbor = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height && frame.data[((y + dy) * width + x + dx) * 4 + 3]) neighbor = true;
      }
      if (!neighbor) { isolatedCount++; if (isolated.length < 32) isolated.push({ x, y }); }
    }
    const peers = hashes.get(hash) ?? [];
    const same = peers.find(other => frame.data.every((value, i) => value === other.data[i] || (!frame.data[i - i % 4 + 3] && !other.data[i - i % 4 + 3])));
    if (same) findings.push({ code: 'duplicate', frame: frame.name, sameAs: same.name, note: 'Repeated poses and holds are valid; compare action intent.' });
    peers.push(frame); hashes.set(hash, peers);
    if (!visible) findings.push({ code: 'empty', frame: frame.name, note: 'An empty effect/transition frame may be intentional.' });
    if (isolatedCount) findings.push({ code: 'isolated', frame: frame.name, count: isolatedCount, coordinates: isolated, omitted: isolatedCount - isolated.length, note: 'No visible 8-connected neighbor. Exempt intentional sparks, stars and detached accents.' });
    if (outside.size) findings.push({ code: 'palette', frame: frame.name, count: outside.size, coordinates: unlisted, omitted: outside.size - unlisted.length, note: 'Directly drawn colors outside the declared palette.' });
    if (blended.size) findings.push({ code: 'alpha-blend', frame: frame.name, count: blended.size, coordinates: mixes, omitted: blended.size - mixes.length, note: 'Colors outside the declared palette produced by alpha blending or layer opacity.' });
    // How many pixels a `cleanup` patch change would alter with corners or strays alone. Counts, not findings: in
    // finished art most L-steps and specks are deliberate (highlight strokes, small rounded corners, texture).
    if (!cleanup.has(same?.name)) {
      const ids = visible ? idsOf(frame.data) : null;
      cleanup.set(frame.name, ids ? { corners: cleanupIds(ids, width, height, { corners: true }).length, strays: cleanupIds(ids, width, height, { strays: true }).length } : { corners: 0, strays: 0 });
    } else cleanup.set(frame.name, cleanup.get(same.name));
    return { frame: frame.name, visible, colors: colors.size, ...cleanup.get(frame.name) };
  });
  const difference = (a, b) => {
    let pixels = 0, left = width, top = height, right = -1, bottom = -1;
    for (let at = 0; at < a.length; at += 4) if (colorId(a, at) !== colorId(b, at) && (a[at + 3] || b[at + 3])) {
      pixels++; const x = at / 4 % width, y = Math.floor(at / 4 / width);
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return { pixels, ...(pixels && { box: { x: left, y: top, w: right - left + 1, h: bottom - top + 1 } }) };
  };
  // Stills are reviewed as frames: their flipbook is no animation, so it gets no row and no loop finding.
  const animations = Object.entries(project.stills ? {} : project.animations).map(([name, a]) => {
    const deltas = a.frames.slice(1).map((index, i) => difference(frames[a.frames[i]].data, frames[index].data).pixels);
    const nonzero = deltas.filter(n => n).sort((a, b) => a - b), median = nonzero[Math.floor(nonzero.length / 2)] ?? 0;
    const boundary = difference(frames[a.frames.at(-1)].data, frames[a.frames[0]].data);
    if (a.loop && boundary.pixels > Math.max(4, median * 3)) findings.push({ code: 'loop-jump', animation: name, from: frames[a.frames.at(-1)].name, to: frames[a.frames[0]].name, ...boundary, note: 'Loop boundary changes over three times the median nonzero adjacent change. Intentional cuts are exempt.' });
    // A one-shot never plays its last frame into its first, so it has no boundary to read as a seam.
    return { animation: name, duration: a.duration, entries: a.frames.length, repeatedAdjacent: deltas.filter(n => !n).length, ...(a.loop && { boundary }) };
  });
  return { advisory: true, frames: stats, ...(!project.stills && { animations }), findings };
}

// Diagnostics as a reply carries them. Up to DIAGNOSTIC_ROWS frames keep a row each; past that the rows are added up
// (`frameTotals`: ranges of visible pixels and colours, cleanup counts summed) and `frames` keeps only three rows,
// since thirty rows of near-equal counts tell a reader nothing a total does not: frames with findings first (then
// those whose only finding is off-palette colours), then the most corners and strays. Findings follow the rows: those
// of the frames kept are listed, those of the other frames added up by code (`findingTotals`: "isolated": "129 pixels
// in 16 frames"), since a particle overlay has strays in every frame and a block of coordinates each would be most of
// the reply; a code in eight frames or fewer names them ("8 pixels in resonate-5, resonate-25"). Off-palette colours
// are added up by colour ("#123456 in 7 frames"), as one colour in many frames is one colour to fix, followed by the
// frames when eight or fewer ("; in smoke-3 … smoke-5"). A finding with no coordinates (`empty`) costs a line,
// so it stays listed, once for every frame it names. Animations and their findings are kept whole. `duplicate` is
// left out: a pose a cycle passes twice, or a hold, is no finding to act on, and two cold runs read the list as noise
// (`--full` keeps everything). `analyzeProject` still measures every frame.
export const DIAGNOSTIC_ROWS = 8;
export function briefDiagnostics(diagnostics) {
  const { frames, ...rest } = diagnostics;
  rest.findings = rest.findings.filter(finding => finding.code !== 'duplicate');
  if (frames.length <= DIAGNOSTIC_ROWS) return { advisory: rest.advisory, frames, ...(rest.animations && { animations: rest.animations }), findings: rest.findings };
  const range = key => [Math.min(...frames.map(row => row[key])), Math.max(...frames.map(row => row[key]))], sum = key => frames.reduce((total, row) => total + row[key], 0);
  // Place drawing findings first, then direct off-palette colours, then expected blends.
  const flagged = new Map();
  for (const finding of rest.findings) if (finding.coordinates) flagged.set(finding.frame, Math.max(flagged.get(finding.frame) ?? 0, finding.code === 'alpha-blend' ? 1 : finding.code === 'palette' ? 2 : 3));
  const most = frames.map((row, index) => ({ row, index, flagged: flagged.get(row.frame) ?? 0, count: row.corners + row.strays })).filter(entry => entry.flagged || entry.count)
    .sort((a, b) => b.flagged - a.flagged || b.count - a.count || a.index - b.index).slice(0, 3).map(entry => entry.row);
  const kept = new Set(most.map(row => row.frame)), totals = new Map(), named = new Map(), paletteTotals = new Map(), plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const findings = rest.findings.filter(finding => {
    if (finding.frame === undefined) return true;
    if (!finding.coordinates) {
      const names = named.get(finding.code);
      if (names) { names.push(finding.frame); return false; }
      named.set(finding.code, [finding.frame]); return true;
    }
    if (kept.has(finding.frame)) return true;
    if (finding.code === 'palette' || finding.code === 'alpha-blend') {
      const total = paletteTotals.get(finding.code) ?? { colours: new Map(), frames: [], unlisted: false };
      for (const { color } of finding.coordinates) total.colours.set(color, (total.colours.get(color) ?? 0) + 1);
      total.unlisted ||= finding.omitted > 0; total.frames.push(finding.frame); paletteTotals.set(finding.code, total);
    } else {
      const total = totals.get(finding.code) ?? { count: 0, frames: [] };
      total.count += finding.count ?? 0; total.frames.push(finding.frame); totals.set(finding.code, total);
    }
    return false;
  }).map(finding => {
    const names = finding.coordinates ? null : named.get(finding.code);
    if (!names || names.length === 1) return finding;
    const { frame, ...same } = finding;
    return { code: same.code, frames: nameRuns(names).join(', '), ...same };
  });
  const findingTotals = Object.fromEntries([...totals].map(([code, { count, frames }]) => [code, `${count ? `${code === 'isolated' ? plural(count, 'pixel') : count} in ` : ''}${frames.length <= DIAGNOSTIC_ROWS ? nameRuns(frames).join(', ') : plural(frames.length, 'frame')}`]));
  for (const [code, { colours, frames: paletteFrames, unlisted }] of paletteTotals) {
    // The colours in the most frames first; past eight, how many more.
    const listed = [...colours].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)), shown = listed.slice(0, 8).map(([color, frames]) => `${color} in ${plural(frames, 'frame')}`), more = listed.length - shown.length;
    // A frame lists its first 32 colours, so one with more may hold colours no frame names.
    if (more || unlisted) shown.push(`${more ? `${more}${unlisted ? ' or more' : ''} ` : ''}other colour${more === 1 && !unlisted ? '' : 's'}`);
    findingTotals[code] = `${shown.join(', ')}${paletteFrames.length <= DIAGNOSTIC_ROWS ? `; in ${nameRuns(paletteFrames).join(', ')}` : ''}`;
  }
  return { advisory: rest.advisory, frameTotals: { frames: frames.length, visible: range('visible'), colors: range('colors'), corners: sum('corners'), strays: sum('strays') }, frames: most, omitted: frames.length - most.length, ...(rest.animations && { animations: rest.animations }), findings, ...(Object.keys(findingTotals).length && { findingTotals }) };
}

// Cells (or frames) as a reply carries them: in order, a line per run that lasts the same, and a run of three or more
// numbered names as its ends. Nineteen cells of a smoke puff read ["smoke-puff-0 … smoke-puff-18: 60 ms each"], where
// a `{frame, duration}` object each was most of a reply. Cells that carry more than a name and a duration (a motion
// review's) are returned as they are.
// Names in order, a run of three or more numbered ones (a-0, a-1, a-2) written as "a-0 … a-2".
function nameRuns(labels) {
  const numbered = label => /^(.*?)(\d+)$/.exec(label), names = [];
  for (let a = 0, b; a < labels.length; a = b) {
    const first = numbered(labels[a]);
    for (b = a + 1; first && b < labels.length; b++) { const next = numbered(labels[b]); if (!next || next[1] !== first[1] || Number(next[2]) !== Number(first[2]) + b - a) break; }
    if (b - a > 2) names.push(`${labels[a]} … ${labels[b - 1]}`);
    else { names.push(labels[a]); b = a + 1; }
  }
  return names;
}
export function briefCells(cells) {
  if (!cells.every(cell => Object.keys(cell).every(key => key === 'frame' || key === 'name' || key === 'duration'))) return cells;
  const lines = [];
  for (let start = 0, end; start < cells.length; start = end) {
    for (end = start + 1; end < cells.length && cells[end].duration === cells[start].duration; end++);
    lines.push(`${nameRuns(cells.slice(start, end).map(cell => cell.frame ?? cell.name)).join(', ')}: ${cells[start].duration} ms${end - start > 1 ? ' each' : ''}`);
  }
  return lines;
}

// A comparison as a reply carries it. Up to COMPARED changed frames are listed each with its own figures. Past that
// (a palette change touches every frame of a character) the same few lines would repeat for every frame, so the
// reply says how many changed and which, the pixels and the box over all of them, the commonest colour changes
// summed, and the three frames that changed most; a long list of unchanged frames is their names in runs.
const COMPARED = 8;
// Frames that became stills are said once, with how to get the flipbook back.
const NOW_STILLS = 'the frames are now stills ("animations": {}): an export plays no animation and writes no SpriteFrames, animated PNGs, GIFs, CSS or player; remove the animations field to play every frame in order again, or name animations under it';
export function briefComparison(full) {
  const report = full.stills ? { ...full, stills: NOW_STILLS } : full;
  const { changed, unchanged, ...rest } = report.frames;
  // Frames that all changed alike (a recoloured key in every frame) are said once, as many frames are.
  const alike = changed.length > 1 && changed.every(entry => entry.transitions && JSON.stringify(entry.transitions) === JSON.stringify(changed[0].transitions));
  if (changed.length <= COMPARED && unchanged.length <= COMPARED * 2 && !alike) return report;
  const brief = list => (list.length <= COMPARED * 2 ? list : { count: list.length, frames: nameRuns(list).join(', ') });
  if (changed.length <= COMPARED && !alike) return { ...report, frames: { changed, unchanged: brief(unchanged), ...rest } };
  const measured = changed.filter(entry => entry.box), sums = new Map();
  // A frame with few changed pixels lists each one; a frame with many, its colour changes. Both are counted.
  const add = (from, to, pixels) => { const key = `${from}\n${to}`; sums.set(key, (sums.get(key) ?? 0) + pixels); };
  for (const entry of changed) { for (const { from, to, pixels } of entry.transitions ?? []) add(from, to, pixels); for (const { from, to } of entry.changes ?? []) add(from, to, 1); }
  const box = measured.reduce((all, { box: b }) => (all ? { x: Math.min(all.x, b.x), y: Math.min(all.y, b.y), x2: Math.max(all.x2, b.x + b.w), y2: Math.max(all.y2, b.y + b.h) } : { x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h }), null);
  const transitions = [...sums].sort((a, b) => b[1] - a[1]).slice(0, COMPARED).map(([key, pixels]) => ({ from: key.split('\n')[0], to: key.split('\n')[1], pixels }));
  return { ...report, frames: {
    changed: { count: changed.length, frames: unchanged.length ? nameRuns(changed.map(entry => entry.frame)).join(', ') : 'every frame', pixels: changed.reduce((sum, entry) => sum + (entry.pixels ?? 0), 0),
      ...(box && { box: { x: box.x, y: box.y, w: box.x2 - box.x, h: box.y2 - box.y } }), ...(transitions.length && { transitions }),
      ...(!alike && { most: [...measured].sort((a, b) => b.pixels - a.pixels).slice(0, 3).map(({ frame, pixels, box: b }) => ({ frame, pixels, box: b })) }) },
    unchanged: brief(unchanged), ...rest } };
}

// Two names make one number: the first times NAME_PAIRS (2 to the 26th, more names than a frame has pixels) plus the second.
const NAME_PAIRS = 67108864;
// A namer's names as small numbers: `index` names a pixel's colour (once per colour, through `char`, which also notes
// the legend) and returns the name's place in `chars`, the same place for colours that share a name.
function nameIndex(namer) {
  const byColor = new Map(), byChar = new Map(), chars = [];
  return { chars, index(data, at) {
    const id = colorId(data, at);
    let place = byColor.get(id);
    if (place === undefined) {
      const char = namer.char(data, at);
      place = byChar.get(char);
      if (place === undefined) { place = chars.length; chars.push(char); byChar.set(char, place); }
      byColor.set(id, place);
    }
    return place;
  } };
}

// Compares two rendered revisions, matching frames by name, so a patch can report every visible effect.
export function compareProjects(before, after) {
  const { width, height } = after, resized = before.width !== width || before.height !== height;
  const namer = colorNamer(after, [before]), previous = new Map(before.frames.map(frame => [frame.name, frame]));
  const names = nameIndex(namer);
  const kept = new Set(after.frames.map(frame => frame.name)), changed = [], unchanged = [], added = [], durations = [], shown = [];
  for (const frame of after.frames) {
    const old = previous.get(frame.name);
    if (!old) { added.push(frame.name); shown.push({ frame: frame.name, status: 'added', before: null, after: frame.data }); continue; }
    if (old.duration !== frame.duration) durations.push({ frame: frame.name, from: old.duration, to: frame.duration });
    if (resized) { changed.push({ frame: frame.name }); continue; }
    let pixels = 0, left = width, top = height, right = -1, bottom = -1;
    // Each colour is named once and each pair of names counted under a number, in the order pairs first appear, so a
    // still whose every pixel changes costs a few array reads a pixel instead of two lookups, a string and a map entry.
    const changes = [], transitions = new Map(), { data } = frame, was = old.data;
    for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 4) {
      if ((data[at] === was[at] && data[at + 1] === was[at + 1] && data[at + 2] === was[at + 2] && data[at + 3] === was[at + 3]) || (!data[at + 3] && !was[at + 3])) continue;
      const from = names.index(was, at), to = names.index(data, at), pair = from * NAME_PAIRS + to;
      pixels++; if (x < left) left = x; if (y < top) top = y; if (x > right) right = x; bottom = y;
      if (changes.length < 16) changes.push({ x, y, from: names.chars[from], to: names.chars[to] });
      transitions.set(pair, (transitions.get(pair) ?? 0) + 1);
    }
    if (!pixels) { unchanged.push(frame.name); continue; }
    const box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    // A few pixels are listed one by one. More, or four or more where each colour became one colour and no two became
    // the same one (recoloured palette keys, a filled patch), are summed up by what became what.
    const pairs = [...transitions.keys()], recoloured = pixels >= 4 && new Set(pairs.map(pair => Math.floor(pair / NAME_PAIRS))).size === pairs.length && new Set(pairs.map(pair => pair % NAME_PAIRS)).size === pairs.length;
    const detail = pixels <= 16 && !recoloured ? { changes } : { transitions: [...transitions].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([pair, count]) => ({ from: names.chars[Math.floor(pair / NAME_PAIRS)], to: names.chars[pair % NAME_PAIRS], pixels: count })) };
    changed.push({ frame: frame.name, pixels, box, ...detail });
    shown.push({ frame: frame.name, status: 'changed', before: old.data, after: frame.data, box });
  }
  const removed = before.frames.filter(frame => !kept.has(frame.name)).map(frame => frame.name);
  for (const name of removed) shown.push({ frame: name, status: 'removed', before: previous.get(name).data, after: null });
  const sequence = (project, key) => project.animations[key].frames.map(i => project.frames[i].name);
  // Stills have no animations: the flipbook they keep for viewing is never reported added or removed.
  const played = project => (project.stills ? {} : project.animations), was = played(before), is = played(after);
  const animations = { changed: [], added: [], removed: Object.keys(was).filter(key => !own(is, key)) };
  for (const key of Object.keys(is)) {
    if (!own(was, key)) { animations.added.push(key); continue; }
    const from = sequence(before, key), to = sequence(after, key), loop = [before.animations[key].loop, after.animations[key].loop];
    if (from.join() !== to.join() || loop[0] !== loop[1]) animations.changed.push({ animation: key, ...(from.join() !== to.join() && { frames: { from, to } }), ...(loop[0] !== loop[1] && { loop: { from: loop[0], to: loop[1] } }) });
  }
  const filled = value => Object.fromEntries(Object.entries(value).filter(([, list]) => list.length));
  const report = {
    ...(resized && { canvas: { from: { w: before.width, h: before.height }, to: { w: width, h: height } } }),
    frames: { changed, unchanged, ...filled({ added, removed, durations }) },
    ...(Object.keys(filled(animations)).length && { animations: filled(animations) }),
    // The frames became stills (a patch removed the last named animation, or set "animations" to {}).
    ...(after.stills && !before.stills && { stills: true })
  };
  // Before and after share one row per frame, cropped to the changed area plus 2 pixels unless frames were added or removed.
  // When two frames side by side would pass the sheet limit (a still over 2048 wide), before goes above after; a
  // comparison too large either way (over 2048 a side, which no recipe is) keeps its report without the image.
  if (shown.length && !resized) {
    let region = { x: 0, y: 0, w: width, h: height };
    if (shown.every(row => row.box)) {
      const x = Math.max(0, Math.min(...shown.map(row => row.box.x)) - 2), y = Math.max(0, Math.min(...shown.map(row => row.box.y)) - 2);
      region = { x, y, w: Math.min(width, Math.max(...shown.map(row => row.box.x + row.box.w)) + 2) - x, h: Math.min(height, Math.max(...shown.map(row => row.box.y + row.box.h)) + 2) - y };
    }
    const stacked = 2 * region.w > SHEET_SIDE;
    if (stacked && 2 * region.h > SHEET_SIDE) report.imageNote = `no before/after image: two ${region.w}×${region.h} frames pass the 4096-pixel sheet limit side by side and stacked; inspect each revision with a region instead`;
    else {
      const rows = shown.slice(0, Math.max(1, Math.min(16, Math.floor(4094 / ((stacked ? 2 : 1) * (region.h + 2))))));
      report.image = { region, frames: rows.map(({ frame, status }) => ({ frame, status })), ...(rows.length < shown.length && { omitted: shown.length - rows.length }), sheet: drawSheet(rows.flatMap(row => [row.before, row.after]), width, region, { columns: stacked ? 1 : 2, where: 'image' }) };
      if (stacked) report.imageNote = `before above after: side by side, two ${region.w}-pixel frames would pass the 4096-pixel sheet limit`;
    }
  }
  // A colour with no one-letter palette key is written out where it is reported: its palette name, or its hex. Only
  // "?" (more colours than there are symbols) still needs a legend.
  // Beside a hex the other side is a hex too, with its key: a recoloured key reads "#d9a566" to "#8a5a2c (c)", not
  // a colour turning into a letter.
  const legend = namer.legend(), written = symbol => (symbol !== '?' && own(legend, symbol) ? legend[symbol].palette ?? legend[symbol].color : symbol);
  const hex = value => value.startsWith('#'), keyed = key => (own(after.palette, key) ? `${toHex(parseColor(after.palette[key]))} (${key})` : key);
  for (const frame of changed) for (const item of frame.changes ?? frame.transitions ?? []) {
    const from = written(item.from), to = written(item.to);
    item.from = hex(to) && !hex(from) ? keyed(from) : from; item.to = hex(from) && !hex(to) ? keyed(to) : to;
  }
  if (own(legend, '?')) report.legend = { '?': legend['?'] };
  return report;
}
