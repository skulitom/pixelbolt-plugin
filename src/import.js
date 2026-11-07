// Deliberately narrow, lossless PNG interchange: every colour type at up to 8 bits per channel (RGB, RGBA, greyscale,
// greyscale with alpha, indexed), with tRNS transparency, decoded to straight RGBA without rounding. 16-bit,
// interlaced and animated PNGs are refused.
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { crc32 } from './png.js';
import { PixelError, renderProject } from './core.js';

const fail = message => { throw new PixelError('import', message); };
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
      if (!width || !height || width > 4096 || height > 4096 || width * height > 16777216) fail('PNG dimensions exceed 4096 per side or 16,777,216 pixels');
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
export function importPNG(bytes, { name = 'imported', atlas } = {}) {
  const image = decodePNG(bytes), keyed = image.encoding.tRNS;
  if (atlas !== undefined && (!atlas || typeof atlas !== 'object' || Array.isArray(atlas) || String(atlas.meta?.scale ?? '1') !== '1')) fail('atlas must use unscaled source pixels (meta.scale 1)');
  const entries = atlas?.frames ? Object.entries(atlas.frames) : [['idle', { frame: { x: 0, y: 0, w: image.width, h: image.height }, duration: 100 }]];
  if (!entries.length || entries.length > 256) fail('expected 1–256 atlas frames');
  const first = entries[0][1].frame, width = first?.w, height = first?.h;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256 || width * height * entries.length > 4194304) fail('frames must fit the 256×256 canvas and total 4,194,304 source pixel limit');
  const frames = entries.map(([frameName, entry]) => {
    const rect = entry.frame;
    if (!rect || !Number.isInteger(rect.x) || !Number.isInteger(rect.y) || rect.x < 0 || rect.y < 0 || rect.w !== width || rect.h !== height || rect.x + width > image.width || rect.y + height > image.height || entry.rotated || entry.trimmed) fail('atlas needs equal-size, untrimmed, unrotated rectangles inside the PNG');
    const pixels = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = ((y + rect.y) * image.width + x + rect.x) * 4;
      // Under tRNS a fully transparent pixel shows its palette entry's or key's colour, not one of its own, so it
      // imports as plain transparency rather than a hidden-RGB correction on every empty pixel.
      const color = keyed && !image.data[at + 3] ? '#00000000' : '#' + [...image.data.subarray(at, at + 4)].map(v => v.toString(16).padStart(2, '0')).join('');
      pixels.push({ x, y, color });
    }
    return { name: frameName, duration: entry.duration ?? 100, pixels };
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
      else if (pixel.color !== '#00000000') hidden.push(pixel); // Preserve meaningful RGB even under alpha zero.
    }
    frame.ops = [{ op: 'grid', rows: rows.map(row => row.join('')) }];
    if (hidden.length) frame.pixels = hidden; else delete frame.pixels;
  }
  const recipe = { version: 1, name, width, height, ...(compact && { palette: Object.fromEntries([...colors].map(([color, key]) => [key, color])) }), frames, ...(atlas?.animations && { animations: Object.fromEntries(Object.entries(atlas.animations).map(([key, value]) => [key, { frames: value.frames, loop: value.loop ?? true }])) }) };
  renderProject(recipe);
  return { recipe, provenance: { format: 'pixelforge-raster-import', version: 1, sha256: createHash('sha256').update(bytes).digest('hex'), width: image.width, height: image.height, encoding: image.encoding, lossless: true, ...(keyed && { hiddenRGB: 'not kept: tRNS gives a fully transparent pixel its palette entry\'s or key\'s colour' }), representation: compact ? 'palette grids with hidden-RGB corrections' : 'exact RGBA pixels', authoritative: 'The imported recipe. Original drawing operations cannot be reconstructed; rebuild generators must explicitly incorporate it.' } };
}
