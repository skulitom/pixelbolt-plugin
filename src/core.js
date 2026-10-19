// Browser-compatible, deterministic rasterizer. No I/O and no dependencies.
import { patternProblem, ditherThreshold, traceLine, pixelId, colorOf, idsOf, cleanupIds, ruleVariants, rewriteIds } from './craft.js';
import { reduceBlobMask, quadrantPieces, templatePiece, expandTilemap } from './autotile.js';
import { layoutText } from './font.js';
export class PixelError extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.name = 'PixelError'; this.path = path; }
}
// Largest JSON request accepted by the MCP server and the studio export endpoint. It exceeds the largest single
// frame the format allows (a 256x256 frame of explicit pixel corrections serializes to about 2.5 MB).
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const fail = (path, message) => { throw new PixelError(path, message); };
const own = (obj, key) => Object.hasOwn(obj, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function object(value, path, keys) {
  if (!isObject(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (value[key] === null) fail(`${path}.${key}`, 'null is not supported; omit optional fields to use defaults');
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  return value;
}
function integer(value, path, min = -4096, max = 4096) {
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

function blend(data, i, color, opacity = 1) {
  const a = color[3] / 255 * opacity;
  if (a === 0) return;
  if (a === 1) { data.set(color, i); return; }
  const old = data[i + 3] / 255, out = a + old * (1 - a);
  for (let c = 0; c < 3; c++) data[i + c] = Math.round((color[c] * a + data[i + c] * old * (1 - a)) / out);
  data[i + 3] = Math.round(out * 255);
}
function readRows(rows, path, palette) {
  list(rows, path, 256);
  if (!rows.length) fail(path, 'grid must contain at least one row');
  if (typeof rows[0] !== 'string' || rows[0].length < 1 || rows[0].length > 256) fail(`${path}[0]`, 'row must contain 1–256 characters');
  const width = rows[0].length;
  rows.forEach((row, y) => {
    if (typeof row !== 'string' || row.length !== width) fail(`${path}[${y}]`, `all rows must be ${width} characters wide`);
    for (const char of row) if (char !== '.' && char !== ' ') {
      // Rows are indexed by UTF-16 code unit, so an astral character (emoji) would split in two.
      if (char.length !== 1) fail(`${path}[${y}]`, `grid characters must be single UTF-16 code units, not ${JSON.stringify(char)}`);
      if (!own(palette, char)) fail(`${path}[${y}]`, `unknown palette character ${JSON.stringify(char)}`);
    }
  });
  return { rows, width, height: rows.length };
}
const round6 = value => Math.round(value * 1e6) / 1e6;

export function renderProject(spec, options = {}) {
  object(options, 'render', ['layers']);
  if (options.layers !== undefined) {
    renderProject(spec); // Validate the complete recipe before hiding any drawing.
    list(options.layers, 'render.layers', 64);
    if (!options.layers.length) fail('render.layers', 'select at least one named layer');
    const known = new Set(spec.frames.flatMap(f => (f.layers ?? []).map(l => l.name).filter(Boolean)));
    for (const ref of options.layers) if (typeof ref !== 'string' || !known.has(ref)) fail('render.layers', `unknown layer ${JSON.stringify(ref)}`);
    const isolated = structuredClone(spec); isolated.background = 'transparent';
    for (const frame of isolated.frames) { delete frame.ops; delete frame.pixels; frame.layers = (frame.layers ?? []).filter(layer => options.layers.includes(layer.name)); }
    return renderProject(isolated);
  }
  object(spec, 'project', ['$schema', 'version', 'name', 'width', 'height', 'palette', 'ramps', 'background', 'symbols', 'frames', 'animations', 'sheet', 'anchor']);
  if (spec.version !== 1) fail('project.version', 'expected 1');
  const projectName = name(spec.name, 'project.name');
  const width = integer(spec.width, 'project.width', 1, 256), height = integer(spec.height, 'project.height', 1, 256);
  const palette = spec.palette ?? {};
  object(palette, 'project.palette');
  if (own(palette, '$ref')) fail('project.palette.$ref', 'palette files are resolved by the CLI, MCP or resolveRecipe(); inline the palette to render here');
  if (Object.keys(palette).length > 256) fail('project.palette', 'at most 256 colors are allowed');
  for (const [key, value] of Object.entries(palette)) {
    if (!key || key.length > 64 || key === '.' || key === ' ' || key === 'transparent') fail(`project.palette.${key}`, 'invalid or reserved palette name');
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
  // Frames may recolor palette keys for their own drawing; everything else resolves against the project palette.
  let activePalette = palette;
  const color = (value, path) => parseColor(value, activePalette, path);
  const background = parseColor(spec.background ?? 'transparent', palette, 'project.background');
  const projectAnchor = spec.anchor === undefined ? null : point(spec.anchor, 'project.anchor');
  const symbols = Object.create(null);
  object(spec.symbols ?? {}, 'project.symbols');
  for (const [key, rows] of Object.entries(spec.symbols ?? {})) {
    name(key, `project.symbols.${key}`);
    symbols[key] = readRows(rows, `project.symbols.${key}`, palette);
  }
  list(spec.frames, 'project.frames', 256);
  if (!spec.frames.length) fail('project.frames', 'at least one frame is required');
  if (width * height * spec.frames.length > 4194304) fail('project.frames', 'total frame area exceeds 4,194,304 pixels');
  object(spec.animations ?? {}, 'project.animations');
  const animationCount = spec.animations === undefined ? 1 : Object.keys(spec.animations).length;
  if (7 + spec.frames.length + animationCount > 65535) fail('project.animations', `bundle exceeds the ZIP32 limit of 65,535 files; at most ${65535 - 7 - spec.frames.length} animations fit alongside these frames and 7 support files`);
  let work = 0, operationCount = 0;
  const spend = amount => { work += amount; if (work > 67108864) fail('project', 'drawing work exceeds the 67-million-pixel budget; simplify repeated operations'); };
  // Clipping is counted per source location so an agent can find the operation that overhangs.
  const clipped = new Map();
  const clip = (path, pixels = 1) => clipped.set(path, (clipped.get(path) ?? 0) + pixels);
  const rendered = new Map(), frameNames = new Set();
  function drawOps(data, ops, path) {
    list(ops, path);
    for (let index = 0; index < ops.length; index++) {
      if (++operationCount > 20000) fail(path, 'project exceeds 20,000 drawing operations');
      const op = ops[index], p = `${path}[${index}]`;
      object(op, p);
      const transform = ['scale', 'flipX', 'flipY', 'rotate'];
      const fields = {
        pixel: ['x', 'y', 'color'], rect: ['x', 'y', 'w', 'h', 'color', 'filled'],
        ellipse: ['x', 'y', 'w', 'h', 'color', 'filled'], line: ['x', 'y', 'x2', 'y2', 'color'],
        clear: ['x', 'y', 'w', 'h'], fill: ['x', 'y', 'color'],
        grid: ['x', 'y', 'rows', ...transform, 'remap'],
        stamp: ['x', 'y', 'symbol', ...transform, 'remap'], replace: ['from', 'to'],
        text: ['x', 'y', 'text', 'color', 'align', 'spacing', 'lineHeight', ...transform],
        copy: ['x', 'y', 'from', 'symbol', 'sx', 'sy', 'w', 'h', ...transform, 'remap'],
        autotile: ['x', 'y', 'symbol', 'mask', 'mode', 'remap'],
        tilemap: ['x', 'y', 'tile', 'rows', 'legend', 'outside', 'empty', 'classes', 'seed'],
        outline: ['color', 'diagonal', 'position', 'width', 'directions'],
        dither: ['x', 'y', 'w', 'h', 'color', 'erase', 'density', 'direction', 'pattern', 'offset', 'seed', 'scale', 'over'],
        shade: ['x', 'y', 'w', 'h', 'steps', 'shape', 'density', 'direction', 'pattern', 'offset', 'seed', 'scale', 'over'],
        rewrite: ['x', 'y', 'w', 'h', 'rules', 'empty', 'steps', 'chance', 'limit', 'seed', 'rotate', 'mirror']
      };
      if (typeof op.op !== 'string' || !own(fields, op.op)) fail(`${p}.op`, `unknown operation ${JSON.stringify(op.op)}`);
      object(op, p, ['op', ...fields[op.op]]);
      const x = integer(op.x ?? 0, `${p}.x`), y = integer(op.y ?? 0, `${p}.y`);
      const put = (px, py, c, erase = false) => {
        if (px < 0 || py < 0 || px >= width || py >= height) { clip(p); return; }
        const at = (py * width + px) * 4;
        if (erase) data.fill(0, at, at + 4); else blend(data, at, c);
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
      // the drawing by [dx, dy], given its drawn width and scale (text alignment, and accents above the first line).
      const drawCells = (w, h, sample, shift = () => [0, 0]) => {
        const scale = integer(op.scale ?? 1, `${p}.scale`, 1, 16);
        const flipX = boolean(op.flipX ?? false, `${p}.flipX`), flipY = boolean(op.flipY ?? false, `${p}.flipY`);
        const rotate = integer(op.rotate ?? 0, `${p}.rotate`, 0, 270);
        if (rotate % 90) fail(`${p}.rotate`, 'expected 0, 90, 180 or 270 degrees clockwise');
        spend(w * h * scale * scale);
        const [dx, dy] = shift((rotate % 180 ? h : w) * scale, scale), left = x + dx, top = y + dy;
        for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) {
          const c = sample(gx, gy);
          if (!c) continue;
          let px = flipX ? w - 1 - gx : gx, py = flipY ? h - 1 - gy : gy;
          if (rotate === 90) [px, py] = [h - 1 - py, px];
          else if (rotate === 180) [px, py] = [w - 1 - px, h - 1 - py];
          else if (rotate === 270) [px, py] = [py, w - 1 - px];
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(left + px * scale + sx, top + py * scale + sy, c);
        }
      };
      // The canvas-anchored threshold field shared by dither and shade: a region from x/y (to the canvas edge unless w/h
      // say otherwise), a density or [from, to] ramp along a direction, and a pattern. The returned function visits
      // every pixel of the region, optionally limited by `inside(i, j, w, h)`, whose threshold is below the density.
      const densityField = (fallback, inside = null) => {
        const w = integer(op.w ?? Math.max(1, width - x), `${p}.w`, 1, 512), h = integer(op.h ?? Math.max(1, height - y), `${p}.h`, 1, 512);
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
      // wide and three tall (see autotile.js). Blob masks are reduced (a diagonal counts only with both of its sides).
      const drawTemplate = (grid, mask, mode, left, top, sample, where) => {
        const tile = grid.width / 2;
        if (!Number.isInteger(tile) || tile % 2 || grid.height !== tile * 3) fail(where, 'an autotile template is two tiles wide and three tall, with an even tile size');
        const pieces = quadrantPieces(mode, mode === 'cardinal' ? mask : reduceBlobMask(mask)), q = tile / 2;
        spend(tile * tile);
        for (const [position, [ox, oy]] of [['tl', [0, 0]], ['tr', [q, 0]], ['bl', [0, q]], ['br', [q, q]]]) {
          const [sx, sy] = templatePiece(tile, position, pieces[position]);
          for (let gy = 0; gy < q; gy++) for (let gx = 0; gx < q; gx++) { const c = sample(grid.rows[sy + gy][sx + gx]); if (c) put(left + ox + gx, top + oy + gy, c); }
        }
      };
      if (op.op === 'pixel') { spend(1); put(x, y, color(op.color, `${p}.color`)); }
      else if (['rect', 'ellipse', 'clear'].includes(op.op)) {
        const w = integer(op.w, `${p}.w`, 1, 512), h = integer(op.h, `${p}.h`, 1, 512);
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
        drawCells(block.width, block.height, (gx, gy) => block.rows[gy][gx] === '#' ? c : null, (drawn, scale) => [align === 'center' ? -Math.floor(drawn / 2) : align === 'right' ? -drawn : 0, block.top * scale]);
      } else if (op.op === 'copy') {
        // Copies a rectangle of a symbol (palette characters) or of an earlier frame (exact RGBA).
        if ((op.from === undefined) === (op.symbol === undefined)) fail(p, 'copy needs exactly one of from (an earlier frame) or symbol');
        let sourceWidth, sourceHeight, read;
        if (op.symbol !== undefined) {
          if (typeof op.symbol !== 'string') fail(`${p}.symbol`, 'expected a string naming a symbol');
          const grid = symbols[op.symbol];
          if (!grid) fail(`${p}.symbol`, `unknown symbol ${JSON.stringify(op.symbol)}`);
          const sample = paletteSampler();
          [sourceWidth, sourceHeight, read] = [grid.width, grid.height, (sx, sy) => sample(grid.rows[sy][sx])];
        } else {
          if (typeof op.from !== 'string' || !rendered.has(op.from)) fail(`${p}.from`, 'must name an earlier frame');
          // A frame copy keeps exact RGBA; remap swaps exact colours, named by project palette key or hex, for others.
          const source = rendered.get(op.from).data, swaps = new Map();
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
        }
        const sx = integer(op.sx ?? 0, `${p}.sx`, 0, sourceWidth - 1), sy = integer(op.sy ?? 0, `${p}.sy`, 0, sourceHeight - 1);
        const w = integer(op.w ?? sourceWidth - sx, `${p}.w`, 1, sourceWidth - sx), h = integer(op.h ?? sourceHeight - sy, `${p}.h`, 1, sourceHeight - sy);
        drawCells(w, h, (gx, gy) => read(sx + gx, sy + gy));
      } else if (op.op === 'autotile') {
        // One tile of an autotile set. The autotile compiler emits one per frame, so editing the template redraws every tile.
        if (typeof op.symbol !== 'string') fail(`${p}.symbol`, 'expected a string naming a template symbol');
        const grid = symbols[op.symbol];
        if (!grid) fail(`${p}.symbol`, `unknown symbol ${JSON.stringify(op.symbol)}`);
        const mode = op.mode ?? 'blob';
        if (!['blob', 'cardinal'].includes(mode)) fail(`${p}.mode`, 'expected blob or cardinal');
        drawTemplate(grid, integer(op.mask, `${p}.mask`, 0, mode === 'cardinal' ? 15 : 255), mode, x, y, paletteSampler(), `${p}.symbol`);
      } else if (op.op === 'tilemap') {
        // A character map drawn from this recipe's symbols and autotile templates, with the legend, variants and rules of
        // scene tilemaps (see expandTilemap in autotile.js). Later operations see the composed result: dither over its
        // floor colours, rewrite rules at its corners, an outline around it.
        if (op.tile === undefined) fail(`${p}.tile`, 'expected [width, height]: the distance between cells in pixels');
        const tile = point(op.tile, `${p}.tile`);
        if (tile.some(n => n < 1 || n > 256)) fail(`${p}.tile`, 'cells are 1–256 pixels wide and tall');
        const expanded = expandTilemap(op, { path: p, fail, kinds: ['symbol', 'template'], text: 'symbol', masked: kind => kind !== 'template', exists: (kind, key) => own(symbols, key) });
        const sample = paletteSampler();
        for (const cell of expanded.cells) {
          const grid = symbols[cell.name], left = x + cell.x * tile[0], top = y + cell.y * tile[1];
          if (cell.kind === 'template') { drawTemplate(grid, cell.mask, cell.mode, left, top, sample, `${p}.legend: template ${JSON.stringify(cell.name)}`); continue; }
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
        for (let i = 0; i < paint.length; i++) if (paint[i]) blend(data, i * 4, c);
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
          if (next) data.set(next, at);
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
        const chance = op.chance === undefined ? 1 : number(op.chance, `${p}.chance`, 0, 1), limit = op.limit === undefined ? Infinity : integer(op.limit, `${p}.limit`, 1, 65536);
        const ids = idsOf(data);
        for (const index of rewriteIds(ids, width, height, rules, { x: rx, y: ry, w: rw, h: rh, steps, chance, limit, seed, spend })) data.set(colorOf(ids[index]), index * 4);
      } else if (op.op === 'replace') {
        const from = color(op.from, `${p}.from`), to = color(op.to, `${p}.to`);
        spend(width * height);
        for (let i = 0; i < data.length; i += 4) if (from.every((c, j) => data[i + j] === c)) data.set(to, i);
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
          const px = at % width, py = Math.floor(at / width);
          if (px > 0) stack.push(at - 1); if (px + 1 < width) stack.push(at + 1);
          if (py > 0) stack.push(at - width); if (py + 1 < height) stack.push(at + width);
        }
      }
    }
  }
  const frames = spec.frames.map((frame, index) => {
    const p = `project.frames[${index}]`;
    object(frame, p, ['name', 'duration', 'from', 'translate', 'wrap', 'flipX', 'flipY', 'palette', 'anchor', 'points', 'ops', 'layers', 'pixels']);
    const frameName = name(frame.name, `${p}.name`);
    if (frameNames.has(frameName.toLowerCase())) fail(`${p}.name`, `duplicate frame ${frameName}; names must also be unique ignoring case`);
    frameNames.add(frameName.toLowerCase());
    const duration = integer(frame.duration ?? 100, `${p}.duration`, 1, 60000);
    let overrides = null;
    if (frame.palette !== undefined) {
      object(frame.palette, `${p}.palette`);
      overrides = {};
      for (const [key, value] of Object.entries(frame.palette)) {
        if (!own(palette, key)) fail(`${p}.palette.${key}`, 'frame palettes recolor keys declared in the project palette');
        overrides[key] = toHex(parseColor(value, palette, `${p}.palette.${key}`));
      }
    }
    activePalette = overrides ? { ...palette, ...overrides } : palette;
    const frameAnchor = frame.anchor === undefined ? projectAnchor : point(frame.anchor, `${p}.anchor`);
    let points = null;
    if (frame.points !== undefined) {
      object(frame.points, `${p}.points`);
      if (Object.keys(frame.points).length > 64) fail(`${p}.points`, 'at most 64 named points per frame');
      points = Object.fromEntries(Object.entries(frame.points).map(([key, value]) => [name(key, `${p}.points.${key}`), point(value, `${p}.points.${key}`)]));
    }
    let data = new Uint8ClampedArray(width * height * 4);
    if (frame.from !== undefined) {
      if (typeof frame.from !== 'string' || !rendered.has(frame.from)) fail(`${p}.from`, 'must name an earlier frame');
      data.set(rendered.get(frame.from).data);
    } else for (let i = 0; i < data.length; i += 4) data.set(background, i);
    const translate = frame.translate ?? [0, 0];
    list(translate, `${p}.translate`, 2);
    if (translate.length !== 2) fail(`${p}.translate`, 'expected [x, y]');
    const dx = integer(translate[0], `${p}.translate[0]`), dy = integer(translate[1], `${p}.translate[1]`);
    const flipX = boolean(frame.flipX ?? false, `${p}.flipX`), flipY = boolean(frame.flipY ?? false, `${p}.flipY`);
    const wrap = boolean(frame.wrap ?? false, `${p}.wrap`);
    if (dx || dy || flipX || flipY) {
      const transformed = new Uint8ClampedArray(data.length);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let px = (flipX ? width - 1 - x : x) + dx, py = (flipY ? height - 1 - y : y) + dy;
        if (wrap) { px = ((px % width) + width) % width; py = ((py % height) + height) % height; }
        if (px >= 0 && py >= 0 && px < width && py < height) transformed.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (py * width + px) * 4);
        else if (data[(y * width + x) * 4 + 3]) clip(`${p}.translate`);
      }
      data = transformed;
    }
    drawOps(data, frame.ops ?? [], `${p}.ops`);
    list(frame.layers ?? [], `${p}.layers`, 64);
    const framePalette = activePalette, layerPalettes = [];
    for (const [li, layer] of (frame.layers ?? []).entries()) {
      const lp = `${p}.layers[${li}]`;
      object(layer, lp, ['name', 'visible', 'opacity', 'x', 'y', 'palette', 'ops']);
      if (layer.name !== undefined) name(layer.name, `${lp}.name`);
      // A layer palette recolors keys for this layer's drawing only, on top of the frame's palette, so one layer can
      // flash or cycle while other drawing that shares the key keeps its colour.
      let layerOverrides = null;
      if (layer.palette !== undefined) {
        object(layer.palette, `${lp}.palette`);
        layerOverrides = {};
        for (const [key, value] of Object.entries(layer.palette)) {
          if (!own(palette, key)) fail(`${lp}.palette.${key}`, 'layer palettes recolor keys declared in the project palette');
          layerOverrides[key] = toHex(parseColor(value, palette, `${lp}.palette.${key}`));
        }
        layerPalettes.push({ layer: layer.name ?? li, palette: layerOverrides });
      }
      activePalette = layerOverrides ? { ...framePalette, ...layerOverrides } : framePalette;
      const visible = boolean(layer.visible ?? true, `${lp}.visible`), opacity = layer.opacity ?? 1;
      if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) fail(`${lp}.opacity`, 'expected a number from 0 to 1');
      const lx = integer(layer.x ?? 0, `${lp}.x`), ly = integer(layer.y ?? 0, `${lp}.y`);
      const pixels = new Uint8ClampedArray(data.length);
      drawOps(pixels, layer.ops ?? [], `${lp}.ops`);
      activePalette = framePalette;
      if (visible && opacity > 0) {
        spend(width * height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const tx = x + lx, ty = y + ly, i = (y * width + x) * 4;
          if (tx >= 0 && tx < width && ty >= 0 && ty < height) blend(data, (ty * width + tx) * 4, pixels.subarray(i, i + 4), opacity);
          else if (pixels[i + 3]) clip(lp);
        }
      }
    }
    // Final canvas-space corrections replace RGBA, including transparency, after all layers.
    list(frame.pixels ?? [], `${p}.pixels`, 65536);
    spend((frame.pixels ?? []).length);
    for (const [i, pixel] of (frame.pixels ?? []).entries()) {
      const pp = `${p}.pixels[${i}]`;
      object(pixel, pp, ['x', 'y', 'color']);
      const x = integer(pixel.x, `${pp}.x`, 0, width - 1), y = integer(pixel.y, `${pp}.y`, 0, height - 1);
      data.set(color(pixel.color, `${pp}.color`), (y * width + x) * 4);
    }
    activePalette = palette;
    const result = { name: frameName, duration, data, ...(frameAnchor && { anchor: frameAnchor }), ...(points && { points }), ...(overrides && { palette: overrides }), ...(layerPalettes.length && { layerPalettes }) };
    rendered.set(frameName, result);
    return result;
  });
  const animations = Object.create(null), animationNames = new Set();
  object(spec.animations ?? {}, 'project.animations');
  for (const [key, animation] of Object.entries(spec.animations ?? { default: { frames: frames.map(f => f.name) } })) {
    const p = `project.animations.${key}`;
    name(key, p);
    if (animationNames.has(key.toLowerCase())) fail(p, 'animation names must also be unique ignoring case');
    animationNames.add(key.toLowerCase());
    object(animation, p, ['frames', 'direction', 'loop']);
    list(animation.frames, `${p}.frames`, 1024);
    if (!animation.frames.length) fail(`${p}.frames`, 'at least one frame is required');
    const indices = animation.frames.map((ref, i) => { if (!rendered.has(ref)) fail(`${p}.frames[${i}]`, `unknown frame ${JSON.stringify(ref)}`); return frames.findIndex(f => f.name === ref); });
    const direction = animation.direction ?? 'forward';
    if (!['forward', 'reverse', 'pingpong'].includes(direction)) fail(`${p}.direction`, 'expected forward, reverse or pingpong');
    if (direction === 'reverse') indices.reverse();
    if (direction === 'pingpong' && indices.length > 2) indices.push(...indices.slice(1, -1).reverse());
    const loop = boolean(animation.loop ?? true, `${p}.loop`);
    animations[key] = { frames: indices, loop, duration: indices.reduce((sum, i) => sum + frames[i].duration, 0) };
  }
  if (!Object.keys(animations).length) fail('project.animations', 'at least one animation is required; omit this field for a default animation');
  const sheet = object(spec.sheet ?? {}, 'project.sheet', ['columns', 'padding', 'scale', 'trim']);
  const columns = integer(sheet.columns ?? Math.min(frames.length, 8), 'project.sheet.columns', 1, 256);
  const padding = integer(sheet.padding ?? 0, 'project.sheet.padding', 0, 16);
  const scale = integer(sheet.scale ?? 1, 'project.sheet.scale', 1, 16);
  const trim = boolean(sheet.trim ?? false, 'project.sheet.trim');
  const layout = trim ? packTrimmed(frames, width, height, padding, scale) : null;
  const sheetWidth = layout ? layout.width : columns * (width + padding * 2) * scale, sheetHeight = layout ? layout.height : Math.ceil(frames.length / columns) * (height + padding * 2) * scale;
  if (sheetWidth * sheetHeight > 16777216) fail('project.sheet', 'atlas exceeds 16,777,216 pixels; reduce scale or columns');
  const warnings = [], clipping = [...clipped].map(([path, pixels]) => ({ path, pixels }));
  if (clipping.length) warnings.push(`Some drawing falls outside the canvas and is clipped: ${clipping[0].path} (${clipping[0].pixels} px)${clipping.length > 1 ? ` and ${clipping.length - 1} more location${clipping.length > 2 ? 's' : ''}` : ''}.`);
  return {
    name: projectName, width, height, frames, animations, palette, ramps,
    sheet: { columns, padding, scale, width: sheetWidth, height: sheetHeight, ...(layout && { trim: true, layout: layout.cells }) },
    warnings, ...(clipping.length && { clipping: clipping.slice(0, 64), ...(clipping.length > 64 && { clippingOmitted: clipping.length - 64 }) })
  };
}

// Deterministic shelf packing of each frame's visible bounds (tallest first, then recipe order).
// Cell coordinates are exported pixels; source bounds are unscaled canvas pixels.
function packTrimmed(frames, width, height, padding, scale) {
  const boxes = frames.map((frame, index) => {
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (frame.data[(y * width + x) * 4 + 3]) {
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
    }
    return right < 0 ? { index, sx: 0, sy: 0, w: 1, h: 1, empty: true } : { index, sx: left, sy: top, w: right - left + 1, h: bottom - top + 1 };
  });
  const cellWidth = box => (box.w + padding * 2) * scale, cellHeight = box => (box.h + padding * 2) * scale;
  const target = Math.max(...boxes.map(cellWidth), Math.ceil(Math.sqrt(boxes.reduce((sum, box) => sum + cellWidth(box) * cellHeight(box), 0))));
  const cells = new Array(boxes.length);
  let cursorX = 0, cursorY = 0, shelf = 0, used = 0;
  for (const box of [...boxes].sort((a, b) => cellHeight(b) - cellHeight(a) || a.index - b.index)) {
    if (cursorX > 0 && cursorX + cellWidth(box) > target) { cursorY += shelf; cursorX = 0; shelf = 0; }
    cells[box.index] = { x: cursorX + padding * scale, y: cursorY + padding * scale, sx: box.sx, sy: box.sy, w: box.w, h: box.h, ...(box.empty && { empty: true }) };
    cursorX += cellWidth(box); shelf = Math.max(shelf, cellHeight(box)); used = Math.max(used, cursorX);
  }
  return { width: used, height: cursorY + shelf, cells };
}

export function scalePixels(data, width, height, scale = 1) {
  integer(scale, 'scale', 1, 16);
  const result = new Uint8ClampedArray(width * height * scale * scale * 4);
  for (let y = 0; y < height * scale; y++) for (let x = 0; x < width * scale; x++) {
    const from = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
    result.set(data.subarray(from, from + 4), (y * width * scale + x) * 4);
  }
  return result;
}

// Packs frames into one RGBA sheet. `trim: false` forces the uniform grid even for a trimmed recipe (aligned
// material passes need identical rectangles). Anchors and points are exported pixels; pivot is anchor/source size.
export function buildAtlas(project, { trim } = {}) {
  const { width, height, frames, sheet } = project, s = sheet.scale;
  const trimmed = Boolean(sheet.trim) && trim !== false;
  const gridWidth = sheet.columns * (width + sheet.padding * 2) * s, gridHeight = Math.ceil(frames.length / sheet.columns) * (height + sheet.padding * 2) * s;
  const atlasWidth = trimmed ? sheet.width : gridWidth, atlasHeight = trimmed ? sheet.height : gridHeight;
  if (atlasWidth * atlasHeight > 16777216) fail('project.sheet', 'atlas exceeds 16,777,216 pixels; reduce scale or columns');
  const data = new Uint8ClampedArray(atlasWidth * atlasHeight * 4);
  const entries = Object.create(null);
  const extras = frame => ({
    ...(frame.anchor && { pivot: { x: round6(frame.anchor[0] / width), y: round6(frame.anchor[1] / height) }, anchor: { x: frame.anchor[0] * s, y: frame.anchor[1] * s } }),
    ...(frame.points && { points: Object.fromEntries(Object.entries(frame.points).map(([key, [x, y]]) => [key, { x: x * s, y: y * s }])) })
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
  const meta = { app: 'Pixelbolt', version: '1', image: `${project.name}.png`, format: 'RGBA8888', size: { w: atlasWidth, h: atlasHeight }, scale: String(s) };
  return { data, width: atlasWidth, height: atlasHeight, metadata: { frames: entries, animations, meta } };
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
function drawSheet(sources, width, region, { scale, background = null, columns, where = 'inspect' } = {}) {
  const measure = (c, s) => {
    const rows = Math.ceil(sources.length / c), gap = Math.max(2, s);
    return { columns: c, rows, scale: s, gap, width: c * region.w * s + (c + 1) * gap, height: rows * region.h * s + (rows + 1) * gap };
  };
  const choices = columns ? [columns] : Array.from(sources, (_, i) => i + 1);
  let layout = null;
  for (let s = scale ?? Math.min(16, Math.max(1, Math.floor(256 / Math.max(region.w, region.h)))); s >= (scale ?? 1) && !layout; s--) {
    for (const c of choices) {
      const m = measure(c, s);
      if (m.width <= 1024 && m.height <= 1024 && (!layout || m.rows < layout.rows || (m.rows === layout.rows && m.width * m.height < layout.width * layout.height))) layout = m;
    }
  }
  if (!layout) for (const c of choices) {
    const m = measure(c, scale ?? 1);
    if (!layout || Math.max(m.width, m.height) < Math.max(layout.width, layout.height)) layout = m;
  }
  if (layout.width > 4096 || layout.height > 4096) fail(where, `the contact sheet would be ${layout.width}×${layout.height} pixels, above the 4096-pixel limit; select fewer frames, a smaller region or a lower scale`);
  const data = new Uint8ClampedArray(layout.width * layout.height * 4), square = Math.max(2, Math.ceil(8 / layout.scale)), composed = new Map();
  for (let i = 0; i < data.length; i += 4) data.set(gutterColor, i);
  sources.forEach((source, n) => {
    if (!composed.has(source)) {
      const pixels = new Uint8ClampedArray(region.w * region.h * 4);
      for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) {
        const at = (y * region.w + x) * 4, from = ((region.y + y) * width + region.x + x) * 4;
        pixels.set(background ?? checkerColors[(Math.floor(x / square) + Math.floor(y / square)) % 2], at);
        if (source) blend(pixels, at, source.subarray(from, from + 4));
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

export function inspectProject(project, options = {}) {
  object(options, 'inspect', ['frames', 'animation', 'region', 'grid', 'scale', 'background', 'view', 'native', 'diagnostics', 'maxCells', 'step', 'offset']);
  const { width, height, frames } = project;
  if (options.frames !== undefined && options.animation !== undefined) fail('inspect', 'choose frames or animation, not both');
  let cells = frames.map((_, i) => i);
  if (options.animation !== undefined) {
    if (typeof options.animation !== 'string' || !own(project.animations, options.animation)) fail('inspect.animation', `unknown animation ${JSON.stringify(options.animation)}`);
    cells = project.animations[options.animation].frames;
  } else if (options.frames !== undefined) {
    list(options.frames, 'inspect.frames', 1024);
    if (!options.frames.length) fail('inspect.frames', 'select at least one frame');
    // A name with * (any run of characters) or ? (one character) selects every matching frame in project order.
    cells = options.frames.flatMap((ref, i) => {
      if (typeof ref === 'string' && /^[a-zA-Z0-9_*?-]+$/.test(ref) && /[*?]/.test(ref)) {
        const pattern = new RegExp(`^${ref.replaceAll('*', '.*').replaceAll('?', '.')}$`), matches = frames.flatMap((f, index) => (pattern.test(f.name) ? [index] : []));
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
  if (!['color', 'silhouette', 'grayscale', 'onion', 'tile'].includes(mode)) fail('inspect.view', 'expected color, silhouette, grayscale, onion or tile');
  if (mode === 'onion' && options.animation === undefined) fail('inspect.view', 'onion requires an animation so neighbors have an unambiguous playback position');
  if (mode === 'tile' && options.region !== undefined) fail('inspect.region', 'tile view repeats whole frames; omit region');
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
  if (step > 1 || offset > 0) {
    positions = positions.filter(i => i >= offset && (i - offset) % step === 0);
    const suffix = step % 100 >= 11 && step % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][step % 10] ?? 'th';
    methods.push(step === 1 ? `every position from ${offset}` : `every ${step}${suffix} position from ${offset}`);
  }
  if (options.maxCells !== undefined) {
    const requested = integer(options.maxCells, 'inspect.maxCells', 1, 256);
    const side = mode === 'tile' ? Math.max(width, height) * 3 : Math.max(region.w, region.h);
    const count = Math.min(positions.length, requested, Math.max(1, Math.floor(4094 / (side + 2)) ** 2));
    if (count < positions.length) { const chosen = positions; positions = Array.from({ length: count }, (_, i) => chosen[count === 1 ? 0 : Math.floor(i * (chosen.length - 1) / (count - 1))]); methods.push('evenly spaced, including endpoints'); }
  }
  cells = positions.map(i => cells[i]);
  const unique = [...new Set(cells)];
  if (grid && unique.length * region.w * region.h > 16384) fail('inspect.grid', `grids are limited to 16,384 pixels, not ${unique.length} × ${region.w}×${region.h}; select fewer frames or a smaller region`);
  let view;
  if (mode === 'tile') {
    const repeats = new Map(unique.map(i => [i, tileRepeat(frames[i].data, width, height)]));
    const tiled = { x: 0, y: 0, w: width * 3, h: height * 3 };
    view = { cells: cells.map(i => ({ frame: frames[i].name, duration: frames[i].duration })), region, sheet: drawSheet(cells.map(i => repeats.get(i)), width * 3, tiled, { scale, background }), mode };
    view.tiles = unique.map(i => ({ frame: frames[i].name, ...tileReport(frames[i].data, width, height) }));
    if (native) view.nativeSheet = drawSheet(cells.map(i => repeats.get(i)), width * 3, tiled, { scale: 1, background });
  } else {
    const sources = cells.map((i, n) => mode === 'onion' ? onionPixels(project, project.animations[options.animation], positions[n]) : reviewPixels(frames[i].data, mode));
    view = { cells: cells.map(i => ({ frame: frames[i].name, duration: frames[i].duration })), region, sheet: drawSheet(sources, width, region, { scale, background }) };
    if (mode !== 'color') view.mode = mode;
    if (native) view.nativeSheet = drawSheet(sources, width, region, { scale: 1, background });
  }
  if (total !== cells.length) view.sampling = { total, shown: cells.length, omitted: total - cells.length, positions, ...((step > 1 || offset > 0) && { step, offset }), method: `${methods.join(', then ')}; durations are original, not playback timing` };
  if (diagnostics) view.diagnostics = analyzeProject(project);
  if (options.animation !== undefined && (diagnostics || mode === 'onion')) {
    const a = project.animations[options.animation]; let start = 0;
    view.timing = { animation: options.animation, duration: a.duration, loop: a.loop, entries: a.frames.map((index, position) => {
      const entry = { position, frame: frames[index].name, start, duration: frames[index].duration, ...animationNeighbors(a, position) };
      start += entry.duration; return entry;
    }) };
  }
  if (!grid) return view;
  const namer = colorNamer(project);
  view.grids = unique.map(index => ({ frame: frames[index].name, rows: readRegion(frames[index].data, width, region, namer) }));
  view.legend = namer.legend();
  return view;
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
    const colors = new Set(), outside = new Set(), isolated = [], unlisted = [];
    // Colors a frame or layer palette introduces are declared for that frame.
    const introduced = [...Object.values(frame.palette ?? {}), ...(frame.layerPalettes ?? []).flatMap(entry => Object.values(entry.palette))];
    const declared = introduced.length ? new Set([...known, ...introduced.map(color => colorId(parseColor(color), 0))]) : known;
    let visible = 0, isolatedCount = 0, hash = 2166136261;
    for (let at = 0; at < frame.data.length; at += 4) {
      const id = frame.data[at + 3] ? colorId(frame.data, at) : 0;
      hash = Math.imul(hash ^ id, 16777619) >>> 0;
      if (!id) continue;
      visible++; colors.add(id);
      const x = at / 4 % width, y = Math.floor(at / 4 / width);
      if (!declared.has(id) && !outside.has(id)) { outside.add(id); if (unlisted.length < 32) unlisted.push({ x, y, color: toHex(frame.data.subarray(at, at + 4)) }); }
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
    if (outside.size) findings.push({ code: 'palette', frame: frame.name, count: outside.size, coordinates: unlisted, omitted: outside.size - unlisted.length, note: 'Colors outside the declared palette; literal colors and alpha blends may be intentional.' });
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
  const animations = Object.entries(project.animations).map(([name, a]) => {
    const deltas = a.frames.slice(1).map((index, i) => difference(frames[a.frames[i]].data, frames[index].data).pixels);
    const nonzero = deltas.filter(n => n).sort((a, b) => a - b), median = nonzero[Math.floor(nonzero.length / 2)] ?? 0;
    const boundary = difference(frames[a.frames.at(-1)].data, frames[a.frames[0]].data);
    if (a.loop && boundary.pixels > Math.max(4, median * 3)) findings.push({ code: 'loop-jump', animation: name, from: frames[a.frames.at(-1)].name, to: frames[a.frames[0]].name, ...boundary, note: 'Loop boundary changes over three times the median nonzero adjacent change. Intentional cuts are exempt.' });
    return { animation: name, duration: a.duration, entries: a.frames.length, repeatedAdjacent: deltas.filter(n => !n).length, boundary };
  });
  return { advisory: true, frames: stats, animations, findings };
}

// Compares two rendered revisions, matching frames by name, so a patch can report every visible effect.
export function compareProjects(before, after) {
  const { width, height } = after, resized = before.width !== width || before.height !== height;
  const namer = colorNamer(after, [before]), previous = new Map(before.frames.map(frame => [frame.name, frame]));
  const kept = new Set(after.frames.map(frame => frame.name)), changed = [], unchanged = [], added = [], durations = [], shown = [];
  for (const frame of after.frames) {
    const old = previous.get(frame.name);
    if (!old) { added.push(frame.name); shown.push({ frame: frame.name, status: 'added', before: null, after: frame.data }); continue; }
    if (old.duration !== frame.duration) durations.push({ frame: frame.name, from: old.duration, to: frame.duration });
    if (resized) { changed.push({ frame: frame.name }); continue; }
    let pixels = 0, left = width, top = height, right = -1, bottom = -1;
    const changes = [], transitions = new Map();
    for (let at = 0; at < frame.data.length; at += 4) {
      if (colorId(frame.data, at) === colorId(old.data, at) || (!frame.data[at + 3] && !old.data[at + 3])) continue;
      const x = at / 4 % width, y = Math.floor(at / 4 / width), from = namer.char(old.data, at), to = namer.char(frame.data, at);
      pixels++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      if (changes.length < 16) changes.push({ x, y, from, to });
      transitions.set(from + to, (transitions.get(from + to) ?? 0) + 1);
    }
    if (!pixels) { unchanged.push(frame.name); continue; }
    const box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    const detail = pixels <= 16 ? { changes } : { transitions: [...transitions].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([pair, count]) => ({ from: pair[0], to: pair[1], pixels: count })) };
    changed.push({ frame: frame.name, pixels, box, ...detail });
    shown.push({ frame: frame.name, status: 'changed', before: old.data, after: frame.data, box });
  }
  const removed = before.frames.filter(frame => !kept.has(frame.name)).map(frame => frame.name);
  for (const name of removed) shown.push({ frame: name, status: 'removed', before: previous.get(name).data, after: null });
  const sequence = (project, key) => project.animations[key].frames.map(i => project.frames[i].name);
  const animations = { changed: [], added: [], removed: Object.keys(before.animations).filter(key => !own(after.animations, key)) };
  for (const key of Object.keys(after.animations)) {
    if (!own(before.animations, key)) { animations.added.push(key); continue; }
    const from = sequence(before, key), to = sequence(after, key), loop = [before.animations[key].loop, after.animations[key].loop];
    if (from.join() !== to.join() || loop[0] !== loop[1]) animations.changed.push({ animation: key, ...(from.join() !== to.join() && { frames: { from, to } }), ...(loop[0] !== loop[1] && { loop: { from: loop[0], to: loop[1] } }) });
  }
  const filled = value => Object.fromEntries(Object.entries(value).filter(([, list]) => list.length));
  const report = {
    ...(resized && { canvas: { from: { w: before.width, h: before.height }, to: { w: width, h: height } } }),
    frames: { changed, unchanged, ...filled({ added, removed, durations }) },
    ...(Object.keys(filled(animations)).length && { animations: filled(animations) })
  };
  // Before and after share one row per frame, cropped to the changed area plus 2 pixels unless frames were added or removed.
  if (shown.length && !resized) {
    let region = { x: 0, y: 0, w: width, h: height };
    if (shown.every(row => row.box)) {
      const x = Math.max(0, Math.min(...shown.map(row => row.box.x)) - 2), y = Math.max(0, Math.min(...shown.map(row => row.box.y)) - 2);
      region = { x, y, w: Math.min(width, Math.max(...shown.map(row => row.box.x + row.box.w)) + 2) - x, h: Math.min(height, Math.max(...shown.map(row => row.box.y + row.box.h)) + 2) - y };
    }
    const rows = shown.slice(0, Math.max(1, Math.min(16, Math.floor(4094 / (region.h + 2)))));
    report.image = { region, frames: rows.map(({ frame, status }) => ({ frame, status })), ...(rows.length < shown.length && { omitted: shown.length - rows.length }), sheet: drawSheet(rows.flatMap(row => [row.before, row.after]), width, region, { columns: 2, where: 'image' }) };
  }
  const legend = namer.legend();
  if (Object.keys(legend).length) report.legend = legend;
  return report;
}
