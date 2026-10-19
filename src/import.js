// Deliberately narrow, lossless PNG interchange: 8-bit RGB/RGBA, non-interlaced, no APNG.
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { crc32 } from './png.js';
import { PixelError, renderProject } from './core.js';

const fail = message => { throw new PixelError('import', message); };
export function decodePNG(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length > 33554432 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('expected a PNG no larger than 32 MiB');
  let header, ended = false, idatEnded = false; const chunks = [];
  for (let at = 8; at < buffer.length;) {
    if (at + 12 > buffer.length) fail('truncated PNG chunk');
    const length = buffer.readUInt32BE(at), end = at + 12 + length;
    if (end > buffer.length) fail('truncated PNG chunk');
    const type = buffer.toString('ascii', at + 4, at + 8), data = buffer.subarray(at + 8, end - 4);
    if (crc32(buffer.subarray(at + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) fail(`CRC mismatch in ${type}`);
    if (!header && type !== 'IHDR') fail('IHDR must be first');
    if (type === 'IHDR') {
      if (header || length !== 13) fail('invalid IHDR');
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), channels = data[9] === 6 ? 4 : 3;
      if (!width || !height || width > 4096 || height > 4096 || width * height > 16777216) fail('PNG dimensions exceed 4096 per side or 16,777,216 pixels');
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) fail('only non-interlaced 8-bit RGB/RGBA PNG is supported; convert explicitly in your editor');
      header = { width, height, channels };
    } else if (type === 'IDAT') {
      if (idatEnded) fail('IDAT chunks must be consecutive'); chunks.push(data);
    } else {
      if (chunks.length) idatEnded = true;
      if (['acTL', 'fcTL', 'fdAT', 'tRNS'].includes(type)) fail(`${type} is unsupported; use RGBA frames with explicit atlas metadata`);
      if (type === 'IEND') { if (length || end !== buffer.length) fail('invalid IEND or trailing bytes'); ended = true; break; }
      if (type !== 'PLTE' && /^[A-Z]/.test(type)) fail(`unsupported critical chunk ${type}`);
    }
    at = end;
  }
  if (!header || !ended || !chunks.length) fail('incomplete PNG');
  const { width, height, channels } = header, stride = width * channels, expected = (stride + 1) * height;
  let raw;
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected }); } catch { fail('invalid or oversized compressed pixels'); }
  if (raw.length !== expected) fail('incorrect decompressed pixel length');
  // Unfiltered in place, one row and one filter at a time: a = left, b = above, c = above-left.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], from = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (filter > 4) fail('invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0, b = y ? pixels[up + x] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const c = y && x >= channels ? pixels[up + x - channels] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[row + x] = (raw[from + x] + predictor) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  if (channels === 4) data.set(pixels);
  else for (let i = 0, at = 0; i < width * height; i++, at += 3) { data[i * 4] = pixels[at]; data[i * 4 + 1] = pixels[at + 1]; data[i * 4 + 2] = pixels[at + 2]; data[i * 4 + 3] = 255; }
  return { data, width, height };
}
export function importPNG(bytes, { name = 'imported', atlas } = {}) {
  const image = decodePNG(bytes);
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
      const color = '#' + [...image.data.subarray(at, at + 4)].map(v => v.toString(16).padStart(2, '0')).join('');
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
  return { recipe, provenance: { format: 'pixelforge-raster-import', version: 1, sha256: createHash('sha256').update(bytes).digest('hex'), width: image.width, height: image.height, lossless: true, representation: compact ? 'palette grids with hidden-RGB corrections' : 'exact RGBA pixels', authoritative: 'The imported recipe. Original drawing operations cannot be reconstructed; rebuild generators must explicitly incorporate it.' } };
}
