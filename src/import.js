// Deliberately narrow, lossless PNG interchange: every colour type at up to 8 bits per channel (RGB, RGBA, greyscale,
// greyscale with alpha, indexed), with tRNS transparency, decoded to straight RGBA without rounding. 16-bit,
// interlaced and animated PNGs are refused.
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { crc32 } from './png.js';
import { PixelError, renderProject, isObject, FRAME_LIMIT, CANVAS_SIDE, FRAME_PIXELS, STILL_SIDE, FRAME_AREA, frameFits, frameAreaProblem, frameTotalProblem } from './core.js';

const fail = message => { throw new PixelError('import', message); };
// An imported frame is an animation frame (one grid op holds it whole): core's frameFits, said by frameAreaProblem. A
// PNG imported whole, with no frame or atlas, may instead be a still, up to a still's limits (STILL_SIDE a side and
// FRAME_AREA), as a recipe may: its grid is cut into tiles a grid op holds.
// Per PNG colour type: its name, samples per pixel and allowed bit depths.
const COLOR_TYPES = { 0: ['greyscale', 1, [1, 2, 4, 8, 16]], 2: ['RGB', 3, [8, 16]], 3: ['indexed', 1, [1, 2, 4, 8]], 4: ['greyscale with alpha', 2, [8, 16]], 6: ['RGBA', 4, [8, 16]] };

// Returns { data: straight RGBA, width, height, encoding: { colorType, bitDepth, tRNS } }. Palette and tRNS values are
// copied as stored, so a fully transparent pixel keeps the colour of its palette entry or key under alpha zero, and
// greyscale below 8 bits becomes the 8-bit value the PNG specification gives it (4-bit 0x7 is 0x77).
export function decodePNG(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length > 33554432 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('expected a PNG no larger than 32 MiB');
  let header, palette, trns, ended = false, idatEnded = false; const chunks = [];
  for (let at = 8; at < buffer.length;) {
    if (at + 12 > buffer.length) fail('truncated PNG chunk');
    const length = buffer.readUInt32BE(at), end = at + 12 + length;
    if (end > buffer.length) fail('truncated PNG chunk');
    const type = buffer.toString('ascii', at + 4, at + 8), data = buffer.subarray(at + 8, end - 4);
    if (crc32(buffer.subarray(at + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) fail(`CRC mismatch in ${type}`);
    if (!header && type !== 'IHDR') fail('IHDR must be first');
    if (type === 'IHDR') {
      if (header || length !== 13) fail('invalid IHDR');
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8], kind = COLOR_TYPES[data[9]];
      // As large as any PNG Pixelbolt writes (png.js holds each to 16,777,216 pixels): a 1024-pixel frame at scale 16
      // is 16384 a side, so an export's frames/ and sheet read back.
      if (!width || !height || width > 16384 || height > 16384 || width * height > 16777216) fail('PNG dimensions exceed 16384 per side or 16,777,216 pixels');
      if (!kind || !kind[2].includes(depth) || data[10] || data[11] || data[12] > 1) fail('invalid IHDR: unknown colour type, bit depth, compression, filter or interlace method');
      if (depth === 16) fail(`16-bit ${kind[0]} PNG is unsupported: Pixelbolt keeps 8 bits per channel and does not round colours; export 8 bits per channel`);
      if (data[12]) fail('interlaced PNG is unsupported; save it without interlacing');
      header = { width, height, type: data[9], depth, channels: kind[1] };
    } else if (type === 'IDAT') {
      if (idatEnded) fail('IDAT chunks must be consecutive'); chunks.push(data);
    } else {
      if (chunks.length) idatEnded = true;
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail(`${type} is unsupported; use RGBA frames with explicit atlas metadata`);
      if (type === 'IEND') { if (length || end !== buffer.length) fail('invalid IEND or trailing bytes'); ended = true; break; }
      if (type === 'PLTE') {
        if (palette || chunks.length) fail('PLTE must come once, before the image data');
        if (header.type === 0 || header.type === 4) fail('PLTE is not allowed in a greyscale PNG');
        if (!length || length % 3 || length / 3 > 256) fail('invalid PLTE: expected 1–256 RGB entries');
        palette = data;
      } else if (type === 'tRNS') {
        if (trns || chunks.length) fail('tRNS must come once, before the image data');
        if (header.type === 4 || header.type === 6) fail('tRNS is not allowed in a PNG with an alpha channel');
        if (header.type === 3) {
          if (!palette) fail('tRNS must follow PLTE');
          if (length > palette.length / 3) fail(`tRNS gives ${length} alpha values, but PLTE has ${palette.length / 3} entries`);
        } else if (length !== (header.type === 0 ? 2 : 6) || [...Array(length / 2).keys()].some(i => data.readUInt16BE(i * 2) >= 1 << header.depth)) fail('invalid tRNS: expected one key colour within the bit depth');
        trns = data;
      } else if (/^[A-Z]/.test(type)) fail(`unsupported critical chunk ${type}`);
    }
    at = end;
  }
  if (!header || !ended || !chunks.length) fail('incomplete PNG');
  if (header.type === 3 && !palette) fail('an indexed PNG needs a PLTE chunk');
  // Filters work on whole bytes: a pixel's own bytes, or the one byte holding several pixels below 8 bits.
  const { width, height, type, depth, channels } = header, bpp = Math.max(1, (channels * depth) >> 3), stride = Math.ceil(width * channels * depth / 8), expected = (stride + 1) * height;
  let raw;
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected }); } catch { fail('invalid or oversized compressed pixels'); }
  if (raw.length !== expected) fail('incorrect decompressed pixel length');
  // Unfiltered in place, one row and one filter at a time: a = left, b = above, c = above-left.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], from = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (filter > 4) fail('invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[row + x - bpp] : 0, b = y ? pixels[up + x] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const c = y && x >= bpp ? pixels[up + x - bpp] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[row + x] = (raw[from + x] + predictor) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  if (type === 6) data.set(pixels);
  else {
    // Below 8 bits, samples pack most significant bits first and each row starts on a whole byte.
    const mask = (1 << depth) - 1, scale = 255 / mask, entries = palette ? palette.length / 3 : 0;
    const key = trns && type !== 3 ? [...Array(trns.length / 2).keys()].map(i => trns.readUInt16BE(i * 2)) : null;
    for (let y = 0, i = 0; y < height; y++) {
      const row = y * stride;
      for (let x = 0; x < width; x++, i += 4) {
        if (type === 2) {
          const at = row + x * 3, r = pixels[at], g = pixels[at + 1], b = pixels[at + 2];
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
        } else if (type === 4) {
          const at = row + x * 2; data[i] = data[i + 1] = data[i + 2] = pixels[at]; data[i + 3] = pixels[at + 1];
        } else {
          const bit = x * depth, sample = depth === 8 ? pixels[row + x] : (pixels[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
          if (type === 3) {
            if (sample >= entries) fail(`pixel [${x}, ${y}] uses palette entry ${sample}, but PLTE has ${entries}`);
            data[i] = palette[sample * 3]; data[i + 1] = palette[sample * 3 + 1]; data[i + 2] = palette[sample * 3 + 2];
            data[i + 3] = trns && sample < trns.length ? trns[sample] : 255;
          } else {
            // The key compares with the stored sample, before scaling, as libpng does; Pillow and ffmpeg ignore a key below 8 bits.
            data[i] = data[i + 1] = data[i + 2] = sample * scale; data[i + 3] = key && sample === key[0] ? 0 : 255;
          }
        }
      }
    }
  }
  return { data, width, height, encoding: { colorType: COLOR_TYPES[type][0], bitDepth: depth, tRNS: Boolean(trns) } };
}
// A sheet of equal frames laid out in a grid, when no atlas came with it: the frames in reading order, as an atlas
// would list them, leaving out cells with nothing drawn unless a count keeps the first cells, empty ones included.
// `padding` is the empty border round each frame (Pixelbolt's own sheets have 1); left out, it is the smallest from
// 0 to 8 that makes the frames tile the image exactly.
function gridFrames(image, name, frame, padding, count) {
  const [w, h] = frame ?? [];
  if (!Array.isArray(frame) || frame.length !== 2 || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) fail(`frame: expected the size of one frame, [width, height]; ${FRAME_LIMIT}`);
  if (!frameFits(w, h)) fail(`frame: ${frameAreaProblem(w, h)}, and an imported frame is one`);
  if (padding !== undefined && (!Number.isInteger(padding) || padding < 0 || padding > 64)) fail('padding: expected the empty border round each frame, a whole number from 0 to 64');
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 256)) fail('frames: expected a whole number from 1 to 256');
  const fits = p => image.width % (w + 2 * p) === 0 && image.height % (h + 2 * p) === 0;
  const border = padding ?? [0, 1, 2, 3, 4, 5, 6, 7, 8].find(fits);
  if (border === undefined || !fits(border)) fail(`frame: frames of ${w}×${h}${padding === undefined ? ' with a border of 0 to 8 pixels' : ` with a border of ${padding}`} do not tile the ${image.width}×${image.height} image; give the padding its sheet has, or its atlas`);
  const frames = {}, columns = image.width / (w + 2 * border), rows = image.height / (h + 2 * border);
  const cells = columns * rows; let empty = 0, kept = 0;
  if (count > cells) fail(`frames: expected at most ${cells}; the sheet has ${cells} cells`);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x = column * (w + 2 * border) + border, y = row * (h + 2 * border) + border;
    let drawn = false;
    for (let py = 0; py < h && !drawn; py++) for (let px = 0; px < w; px++) if (image.data[((y + py) * image.width + x + px) * 4 + 3]) { drawn = true; break; }
    if (!drawn) empty++;
    if (count === undefined ? drawn : row * columns + column < count) frames[`${name}-${kept++}`] = { frame: { x, y, w, h }, duration: 100 };
  }
  return { frames, ...(kept < cells && { grid: { cells, kept, empty } }) };
}

// Names as a recipe takes them, for an atlas's frames or its tags: core's name() rules (private there: its spelling
// and the reserved file names), unique ignoring case. A name that is already valid keeps its spelling, and so its
// place: of several that differ only in letter case, the first. The others are repaired in order: a name loses one
// file extension (.aseprite, .png: 1 to 8 letters or digits with a letter among them, so "walk.1" keeps its number),
// every run of other characters becomes a hyphen, and a name that is taken gets -2, -3 and on.
function importNames(values) {
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i, valid = value => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) && !reserved.test(value), taken = new Set();
  const kept = values.map(value => valid(value) && !taken.has(value.toLowerCase()) && Boolean(taken.add(value.toLowerCase())));
  return values.map((value, i) => {
    if (kept[i]) return value;
    if (!valid(value)) {
      value = value.replace(/\.(?=[0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
      if (!/^[A-Za-z]/.test(value)) value = `frame-${value}`;
      value = value.slice(0, 64).replace(/-+$/, '');
      if (reserved.test(value)) value += '-frame';
    }
    let name = value;
    for (let n = 2; taken.has(name.toLowerCase()); n++) { const suffix = `-${n}`; name = value.slice(0, 64 - suffix.length) + suffix; }
    taken.add(name.toLowerCase());
    return name;
  });
}

// An atlas's animations: Pixelbolt's own table as it is (its frames following any whose name was repaired, the first
// of a repeated name), else Aseprite's frame tags, each a run of frames played forward, reversed or back and forth.
function atlasAnimations(atlas, frames, name, renamed) {
  if (atlas?.animations) {
    const entries = Object.entries(atlas.animations), keys = importNames(entries.map(([key]) => key));
    return Object.fromEntries(entries.map(([key, value], i) => {
      if (!isObject(value)) fail(`atlas.animations.${key}: expected { frames, loop }`);
      return [keys[i], { frames: Array.isArray(value.frames) ? value.frames.map(frame => renamed.get(frame) ?? frame) : value.frames, loop: value.loop ?? true }];
    }));
  }
  const tags = atlas?.meta?.frameTags, loop = atlas?.meta?.pixelfx?.loop !== false;
  if (tags !== undefined && !Array.isArray(tags)) fail('atlas.meta.frameTags: expected an array of frame tags');
  if (!tags?.length) return loop ? undefined : { [name]: { frames: frames.map(frame => frame.name), loop: false } };
  tags.forEach((tag, i) => { if (typeof tag?.name !== 'string') fail(`atlas.meta.frameTags[${i}].name: expected the animation's name`); });
  const names = importNames(tags.map(tag => tag.name));
  return Object.fromEntries(tags.map((tag, i) => {
    const p = `atlas.meta.frameTags[${i}]`;
    for (const key of ['from', 'to']) if (!Number.isInteger(tag[key]) || tag[key] < 0 || tag[key] >= frames.length) fail(`${p}.${key}: expected a whole number from 0 to ${frames.length - 1}`);
    if (tag.from > tag.to) fail(`${p}.from: expected a frame no later than to`);
    const direction = tag.direction === undefined ? 'forward' : tag.direction;
    if (!['forward', 'reverse', 'pingpong', 'pingpong_reverse'].includes(direction)) fail(`${p}.direction: ${JSON.stringify(direction)} is not supported; use forward, reverse, pingpong or pingpong_reverse`);
    const sequence = frames.slice(tag.from, tag.to + 1).map(frame => frame.name);
    // Back and forth from the far end is the reversed run played back and forth.
    if (direction === 'reverse' || direction === 'pingpong_reverse') sequence.reverse();
    return [names[i], { frames: sequence, ...(direction.startsWith('pingpong') && { direction: 'pingpong' }), loop }];
  }));
}

export function importPNG(bytes, { name = 'imported', atlas, frame, padding, frames: count } = {}) {
  const image = decodePNG(bytes), keyed = image.encoding.tRNS;
  if (count !== undefined && atlas !== undefined) fail('frames: an atlas already says which frames to keep; give frame instead');
  if (frame !== undefined && atlas !== undefined) fail('frame: an atlas already says where the frames are; give one or the other');
  if (frame === undefined && padding !== undefined) fail('padding: goes with frame, the size of one frame in a sheet');
  if (frame === undefined && count !== undefined) fail('frames: goes with frame, the size of one frame in a sheet');
  if (frame !== undefined) atlas = gridFrames(image, name, frame, padding, count);
  if (atlas !== undefined && (!atlas || typeof atlas !== 'object' || Array.isArray(atlas) || String(atlas.meta?.scale ?? '1') !== '1')) fail('atlas must use unscaled source pixels (meta.scale 1)');
  if (atlas?.frames && !isObject(atlas.frames) && !Array.isArray(atlas.frames)) fail('atlas.frames: expected an object or an array of named frames');
  const entries = Array.isArray(atlas?.frames) ? atlas.frames.map((entry, i) => {
    if (typeof entry?.filename !== 'string') fail(`atlas.frames[${i}].filename: expected the frame's name`);
    return [entry.filename, entry];
  }) : atlas?.frames ? Object.entries(atlas.frames) : [['idle', { frame: { x: 0, y: 0, w: image.width, h: image.height }, duration: 100 }]];
  if (!entries.length || entries.length > 256) fail('expected 1–256 atlas frames');
  const first = entries[0][1]?.frame, width = first?.w, height = first?.h, names = importNames(entries.map(([frameName]) => frameName)), renamed = new Map();
  entries.forEach(([frameName], i) => { if (!renamed.has(frameName)) renamed.set(frameName, names[i]); });
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) fail('atlas frames need a whole-number width and height');
  const still = atlas === undefined && !frameFits(width, height);
  if (still && (width > STILL_SIDE || height > STILL_SIDE || width * height > FRAME_AREA)) fail(`a ${width}×${height} image is past a still's ${STILL_SIDE} pixels a side and ${FRAME_AREA.toLocaleString('en-US')} in all; give frame, the size of one frame in a sheet, to split it into an animation`);
  if (!still && !frameFits(width, height)) fail(`${frameAreaProblem(width, height)}, and an imported frame is one`);
  const total = frameTotalProblem(entries.length, width, height);
  if (total) fail(total);
  const frames = entries.map(([, entry], i) => {
    const rect = entry?.frame;
    if (!rect || !Number.isInteger(rect.x) || !Number.isInteger(rect.y) || rect.x < 0 || rect.y < 0 || rect.w !== width || rect.h !== height || rect.x + width > image.width || rect.y + height > image.height || entry.rotated || entry.trimmed) fail('atlas needs equal-size, untrimmed, unrotated rectangles inside the PNG');
    const pixels = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = ((y + rect.y) * image.width + x + rect.x) * 4;
      // Under tRNS a fully transparent pixel shows its palette entry's or key's colour, not one of its own, so it
      // imports as plain transparency rather than a hidden-RGB correction on every empty pixel.
      const color = keyed && !image.data[at + 3] ? '#00000000' : '#' + [...image.data.subarray(at, at + 4)].map(v => v.toString(16).padStart(2, '0')).join('');
      if (color !== '#00000000') pixels.push({ x, y, color });
    }
    const p = entry.anchorPx;
    const anchor = p && [p.x, p.y].every((n, axis) => Number.isInteger(n) && n >= 0 && n <= [width, height][axis]) ? [p.x, p.y] : undefined;
    return { name: names[i], duration: entry.duration ?? 100, ...(anchor && { anchor }), pixels };
  });
  // Typical pixel art should return as compact, palette-editable grids, not thousands of literal overrides.
  // ASCII keys first, then single-code-unit Latin letters, up to the 256-colour palette limit.
  const symbols = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&*+-/:;<=>@^_~', ...Array.from({ length: 400 }, (_, i) => String.fromCharCode(0xc0 + i))].slice(0, 256);
  const colors = new Map(); let compact = true;
  for (const frame of frames) {
    for (const pixel of frame.pixels) if (!pixel.color.endsWith('00') && !colors.has(pixel.color)) {
      if (colors.size === symbols.length) { compact = false; break; }
      colors.set(pixel.color, symbols[colors.size]);
    }
    if (!compact) break;
  }
  if (compact) for (const frame of frames) {
    const rows = Array.from({ length: height }, () => Array(width).fill('.')), hidden = [];
    for (const pixel of frame.pixels) {
      if (!pixel.color.endsWith('00')) rows[pixel.y][pixel.x] = colors.get(pixel.color);
      else hidden.push(pixel); // Preserve meaningful RGB even under alpha zero.
    }
    // A still past what one grid holds is tiles of it, each at most CANVAS_SIDE rows of CANVAS_SIDE cells and
    // FRAME_PIXELS cells in all, the empty ones left out.
    const across = Math.min(width, CANVAS_SIDE), down = Math.min(height, CANVAS_SIDE, Math.floor(FRAME_PIXELS / across)), ops = [];
    if (!still) ops.push({ op: 'grid', rows: rows.map(row => row.join('')) });
    else for (let y = 0; y < height; y += down) for (let x = 0; x < width; x += across) {
      const tile = rows.slice(y, y + down).map(row => row.slice(x, x + across).join(''));
      if (tile.some(row => /[^.]/.test(row))) ops.push({ op: 'grid', x, y, rows: tile });
    }
    frame.ops = ops;
    if (hidden.length) frame.pixels = hidden; else delete frame.pixels;
  }
  // Pixels a grid cannot carry (past 256 colours, or a colour hidden under full transparency) are a list, which holds
  // an animation frame's worth.
  const listed = frames[0].pixels?.length ?? 0;
  if (still && listed > FRAME_PIXELS) fail(`a ${width}×${height} still has ${listed.toLocaleString('en-US')} pixels that ${compact ? 'keep a colour under full transparency' : 'need more than 256 colours'}, past the ${FRAME_PIXELS.toLocaleString('en-US')} a frame lists; give frame, the size of one frame in a sheet, to split it into an animation`);
  const animations = atlasAnimations(atlas, frames, name, renamed), pivot = atlas?.meta?.pixelfx?.pivot, grid = frame !== undefined && atlas.grid;
  const anchor = Array.isArray(pivot) && pivot.length === 2 && [pivot[0], pivot[1]].every((v, i) => Number.isInteger(v) && v >= 0 && v <= [width, height][i]) ? pivot : undefined;
  const recipe = { version: 1, name, width, height, ...(compact && { palette: Object.fromEntries([...colors].map(([color, key]) => [key, color])) }), frames, ...(animations && { animations }), ...(anchor && { anchor }) };
  renderProject(recipe);
  // How many cells `frames` can keep: a recipe's 256 frames, and fewer where frames this size pass the frame total.
  const most = Math.min(256, Math.floor(FRAME_AREA / (width * height)));
  return { recipe, provenance: { format: 'pixelforge-raster-import', version: 1, sha256: createHash('sha256').update(bytes).digest('hex'), width: image.width, height: image.height, encoding: image.encoding, lossless: true, ...(keyed && { hiddenRGB: 'not kept: tRNS gives a fully transparent pixel its palette entry\'s or key\'s colour' }), representation: compact ? 'palette grids with hidden-RGB corrections' : 'exact RGBA pixels', authoritative: 'The imported recipe. Original drawing operations cannot be reconstructed; rebuild generators must explicitly incorporate it.', ...(grid && { grid }) }, ...(grid && count === undefined && { notes: [`${grid.empty} of ${grid.cells} cells are empty and were left out; frames N (--frames N) keeps the first N cells, empty ones included${grid.cells <= most ? ` (${grid.cells} keeps them all)` : `, up to ${most}`}`] }) };
}
