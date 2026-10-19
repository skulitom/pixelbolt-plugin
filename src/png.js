import { deflateSync } from 'node:zlib';

const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4, 4, 'ascii'); bytes.set(data, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}
function header(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16777216) throw new Error('Invalid PNG dimensions');
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4); data[8] = 8; data[9] = 6;
  return chunk('IHDR', data);
}
function compress(data, width, height) {
  if (data.length !== width * height * 4) throw new Error('RGBA buffer does not match PNG dimensions');
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) scanlines.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return deflateSync(scanlines, { level: 9 });
}
export function encodePNG(data, width, height) {
  return Buffer.concat([signature, header(width, height), chunk('IDAT', compress(data, width, height)), chunk('IEND')]);
}
export function encodeAPNG(frames, width, height, loop = true) {
  if (!frames.length) throw new Error('APNG requires at least one frame');
  const control = Buffer.alloc(8);
  control.writeUInt32BE(frames.length, 0); control.writeUInt32BE(loop ? 0 : 1, 4);
  const chunks = [signature, header(width, height), chunk('acTL', control)];
  let sequence = 0;
  for (const [i, frame] of frames.entries()) {
    if (!Number.isInteger(frame.duration) || frame.duration < 1 || frame.duration > 60000) throw new Error('APNG duration must be 1–60000ms');
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(sequence++, 0); fctl.writeUInt32BE(width, 4); fctl.writeUInt32BE(height, 8);
    fctl.writeUInt16BE(frame.duration, 20); fctl.writeUInt16BE(1000, 22);
    // Full-frame source replacement prevents transparent pixels from leaving trails.
    fctl[24] = 0; fctl[25] = 0;
    chunks.push(chunk('fcTL', fctl));
    const compressed = compress(frame.data, width, height);
    if (i === 0) chunks.push(chunk('IDAT', compressed));
    else {
      const fdat = Buffer.alloc(compressed.length + 4);
      fdat.writeUInt32BE(sequence++, 0); fdat.set(compressed, 4); chunks.push(chunk('fdAT', fdat));
    }
  }
  chunks.push(chunk('IEND'));
  return Buffer.concat(chunks);
}
