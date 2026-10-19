// Browser-compatible GIF89a export for sharing an animation where APNG or CSS scaling is not an option. Colours are
// exact: nothing is quantized or dithered, so a frame that needs more than 256 colours is refused rather than
// approximated. GIF has no partial transparency and times frames in 10 ms steps; both conversions are reported.
import { PixelError, parseColor } from './core.js';

const MAX_PIXELS = 67108864;
// Integer arithmetic only, so table sizes never depend on an engine's logarithm.
const bitsFor = count => { let bits = 1; while (1 << bits < count) bits++; return bits; };

// Variable-width LZW as GIF defines it. `slots` maps (prefix code, next index) to a code; entries carry a generation
// so that a dictionary reset costs nothing.
function compress(indices, minimum, slots, state) {
  const clear = 1 << minimum, end = clear + 1;
  let bytes = new Uint8Array(Math.max(256, indices.length >> 1)), length = 0, size = minimum + 1, next = end + 1, buffer = 0, bits = 0;
  const emit = code => {
    buffer |= code << bits; bits += size;
    while (bits >= 8) {
      if (length === bytes.length) { const grown = new Uint8Array(bytes.length * 2); grown.set(bytes); bytes = grown; }
      bytes[length++] = buffer & 255; buffer >>>= 8; bits -= 8;
    }
  };
  state.generation++; emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const index = indices[i], key = prefix << 8 | index, slot = slots[key];
    if (slot >>> 12 === state.generation) { prefix = slot & 4095; continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); state.generation++; size = minimum + 1; next = end + 1; }
    else { if (next >= 1 << size) size++; slots[key] = state.generation << 12 | next++; }
    prefix = index;
  }
  emit(prefix);
  // A decoder adds one more entry on reading that last code, and widens its codes if the table just filled, before it
  // reads the end code. A decoder that doesn't widen still reads the same value from the wider code.
  if (next === 1 << size && size < 12) size++;
  emit(end);
  if (bits) { size = 8 - bits; emit(0); }
  return bytes.subarray(0, length);
}

// Reads one RGBA frame as indices into its own colours, numbered in the order they first appear. Pixels below 50%
// alpha become transparent and the rest opaque; with `background` ([r, g, b]) every pixel is blended onto that colour
// instead. A transparent frame keeps index 0 for transparency. `describe` names the frame in the error raised when it
// needs more than 256 entries.
function indexFrame(data, area, background, describe) {
  const colors = new Map(), wide = new Uint16Array(area);
  let transparent = false, partialAlpha = 0, last = -1, lastIndex = 0;
  for (let i = 0, at = 0; i < area; i++, at += 4) {
    const alpha = data[at + 3];
    let r = data[at], g = data[at + 1], b = data[at + 2];
    if (background) {
      // Integer source-over onto an opaque colour, rounded to nearest.
      r = (r * alpha + background[0] * (255 - alpha) + 127) / 255 | 0; g = (g * alpha + background[1] * (255 - alpha) + 127) / 255 | 0; b = (b * alpha + background[2] * (255 - alpha) + 127) / 255 | 0;
    } else {
      if (alpha !== 0 && alpha !== 255) partialAlpha++;
      if (alpha < 128) { transparent = true; continue; }
    }
    // Runs of one colour are common, so the last lookup is reused. Index 0 is left for transparency until the end.
    const color = r << 16 | g << 8 | b;
    if (color !== last) {
      last = color; lastIndex = colors.get(color);
      if (lastIndex === undefined) colors.set(color, lastIndex = colors.size + 1);
    }
    if (lastIndex <= 256) wide[i] = lastIndex;
  }
  if (colors.size + (transparent ? 1 : 0) > 256) throw new PixelError('gif', `${describe()} uses ${colors.size} colours${transparent ? ' beside transparency' : ''}; a GIF frame holds 256 and Pixelbolt does not quantize. Reduce the colours${background ? '' : ', or blend onto a background if partial alpha causes them'}.`);
  const indices = new Uint8Array(area), shift = transparent ? 0 : 1;
  for (let i = 0; i < area; i++) indices[i] = wide[i] - shift;
  return { colors: [...colors.keys()], indices, transparent, partialAlpha };
}

// Writes indexed frames ({ colors, indices, transparent, delay: centiseconds }) as GIF89a. One shared colour table
// when the whole animation fits in 256 entries, otherwise a table per frame, so frames may differ completely in
// colour. `loops` is how many times the animation plays: 0 for ever, 1 once (no loop extension), n written as n − 1
// repeats. An opaque animation needs one spare shared entry to keep pixels (see writeFrames); when that doubles the
// table, the file is written both ways and the smaller kept.
function writeGIF(indexed, width, height, options = {}) {
  const transparency = indexed.some(frame => frame.transparent), all = new Map();
  for (const frame of indexed) for (const color of frame.colors) if (!all.has(color)) all.set(color, all.size);
  const shared = all.size + (transparency ? 1 : 0) <= 256, write = spare => writeFrames(indexed, width, height, options, all, shared, transparency, spare);
  if (!shared || transparency || indexed.length < 2 || all.size === 256) return write(false);
  if (bitsFor(all.size + 1) === bitsFor(all.size)) return write(true);
  const plain = write(false), spare = write(true);
  return spare.data.length < plain.data.length ? spare : plain;
}

// The first frame covers the canvas. Each later frame stores only the rectangle where the picture changes (at least
// one pixel), and inside it either every pixel or only the changed ones over a transparent index that keeps what is
// underneath, whichever compresses smaller. A frame stays under the next one (disposal 1) unless the next frame, or
// the first again when the loop restarts, is transparent where this one is not: then its rectangle grows to cover
// those pixels and is cleared after it is shown (disposal 2). The keep index is the transparency index when the
// animation has one, else a spare entry: `spare` in the shared table, or one more entry in a frame's own table.
function writeFrames(indexed, width, height, { loops = 0, scale = 1 }, all, shared, transparency, spare) {
  const table = (colors, offset, extra) => {
    const bits = bitsFor(colors.length + offset + extra), bytes = new Uint8Array(3 << bits);
    for (const [index, color] of colors.entries()) bytes.set([color >> 16, color >> 8 & 255, color & 255], (index + offset) * 3);
    return { bits, bytes };
  };
  const chunks = [], push = (...values) => chunks.push(Uint8Array.from(values)), word = value => [value & 255, value >> 8];
  const globalTable = shared ? table([...all.keys()], transparency ? 1 : 0, spare ? 1 : 0) : null;
  chunks.push(Uint8Array.from('GIF89a', character => character.charCodeAt(0)));
  push(...word(width * scale), ...word(height * scale), globalTable ? 0xf0 | globalTable.bits - 1 : 0x70, 0, 0);
  if (globalTable) chunks.push(globalTable.bytes);
  if (loops !== 1) { push(0x21, 0xff, 11); chunks.push(Uint8Array.from('NETSCAPE2.0', character => character.charCodeAt(0))); push(3, 1, ...word(loops ? loops - 1 : 0), 0); }
  const slots = new Uint32Array(1 << 20), state = { generation: 0 }, lookup = new Uint8Array(256);
  // What a viewer shows at each pixel before the frame is drawn: a colour, or -1 where nothing is.
  const area = width * height, canvas = new Int32Array(area).fill(-1), changed = new Uint8Array(area);
  for (const [position, frame] of indexed.entries()) {
    const { colors, indices, transparent } = frame, offset = transparent ? 1 : 0, next = indexed[(position + 1) % indexed.length];
    // Frame indices become table indices: the shared table's, or the frame's own with transparency first.
    if (shared) { for (const [index, color] of colors.entries()) lookup[index + offset] = all.get(color) + (transparency ? 1 : 0); if (transparent) lookup[0] = 0; }
    else for (let index = 0; index < 256; index++) lookup[index] = index;
    let left = width, top = height, right = -1, bottom = -1, clears = false, count = 0;
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
      const value = indices[i], color = transparent ? (value ? colors[value - 1] : -1) : colors[value];
      const differs = color !== canvas[i], cleared = color !== -1 && next.transparent && next.indices[i] === 0;
      changed[i] = differs ? 1 : 0;
      if (!differs && !cleared) continue;
      // Transparency only keeps what is underneath, so a pixel can turn transparent only where the last frame cleared.
      if (color === -1) throw new Error('GIF encoder: a transparent pixel would show an earlier frame');
      if (differs) { canvas[i] = color; count++; }
      if (cleared) clears = true;
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; bottom = y;
    }
    if (!position) { left = top = 0; right = width - 1; bottom = height - 1; }
    else if (right < 0) left = top = right = bottom = 0;
    const keep = shared ? (transparency ? 0 : spare ? all.size : -1) : transparent ? 0 : colors.length < 256 ? colors.length : -1;
    const w = (right - left + 1) * scale, h = (bottom - top + 1) * scale;
    const encode = keeping => {
      const local = shared ? null : table(colors, offset, keeping && !transparent ? 1 : 0), minimum = Math.max(2, (local ?? globalTable).bits), out = new Uint8Array(w * h);
      for (let y = top; y <= bottom; y++) {
        const row = (y - top) * scale * w;
        for (let x = left, i = y * width + left; x <= right; x++, i++) out.fill(keeping && !changed[i] ? keep : lookup[indices[i]], row + (x - left) * scale, row + (x - left + 1) * scale);
        for (let copy = 1; copy < scale; copy++) out.copyWithin(row + copy * w, row, row + w);
      }
      const packed = compress(out, minimum, slots, state);
      return { local, minimum, packed, size: packed.length + (local ? local.bytes.length : 0), transparent: keeping || transparent, index: keeping ? keep : 0 };
    };
    let best = encode(false);
    if (position && keep >= 0 && count < (right - left + 1) * (bottom - top + 1)) { const kept = encode(true); if (kept.size < best.size) best = kept; }
    push(0x21, 0xf9, 4, (clears ? 2 : 1) << 2 | (best.transparent ? 1 : 0), ...word(frame.delay), best.index, 0);
    push(0x2c, ...word(left * scale), ...word(top * scale), ...word(w), ...word(h), best.local ? 0x80 | best.local.bits - 1 : 0);
    if (best.local) chunks.push(best.local.bytes);
    push(best.minimum);
    for (let at = 0; at < best.packed.length; at += 255) { const block = best.packed.subarray(at, at + 255); push(block.length); chunks.push(block); }
    push(0);
    if (clears) for (let y = top; y <= bottom; y++) canvas.fill(-1, y * width + left, y * width + right + 1);
  }
  push(0x3b);
  const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
  return { data, colors: all.size, shared, transparent: transparency };
}

// `frames` are { data: RGBA bytes, duration: ms } at width × height. Pixels below 50% alpha become transparent and
// the rest opaque; pass `background` ([r, g, b]) to blend every pixel over one colour instead. Returns the file with
// the delays actually written (ms) and how many partly transparent pixels lost their alpha.
export function encodeGIF(frames, width, height, { loop = true, scale = 1, background = null } = {}) {
  if (!Array.isArray(frames) || !frames.length) throw new PixelError('gif', 'at least one frame is required');
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) throw new PixelError('gif.scale', 'expected a whole number from 1 to 16');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * scale > 65535 || height * scale > 65535) throw new PixelError('gif', 'invalid dimensions');
  if (frames.length * width * height * scale * scale > MAX_PIXELS) throw new PixelError('gif', `${frames.length} frames at ${width * scale}×${height * scale} exceed 67,108,864 pixels; lower the scale or shorten the animation`);
  const area = width * height, indexed = [], delays = [];
  let partialAlpha = 0, carry = 0;
  for (const [position, frame] of frames.entries()) {
    if (frame.data.length !== area * 4) throw new PixelError('gif', 'RGBA buffer does not match the dimensions');
    if (!Number.isInteger(frame.duration) || frame.duration < 1 || frame.duration > 60000) throw new PixelError('gif', 'frame durations must be 1–60000ms');
    // Delays are centiseconds; the rounding remainder moves to the next frame so a sequence keeps its length.
    // Browsers play anything under 20 ms at 100 ms, so 20 ms is the floor.
    const exact = frame.duration + carry, delay = Math.max(2, Math.round(exact / 10));
    carry = exact < 20 ? 0 : exact - delay * 10; delays.push(delay * 10);
    const entry = indexFrame(frame.data, area, background, () => `frame ${position + 1} of the animation`);
    partialAlpha += entry.partialAlpha;
    indexed.push({ ...entry, delay });
  }
  const gif = writeGIF(indexed, width, height, { loops: loop ? 0 : 1, scale });
  return { data: gif.data, width: width * scale, height: height * scale, colors: gif.colors, transparent: gif.transparent, delays, partialAlpha };
}

const MAX_FRAMES_PIXELS = 134217728, MAX_FRAMES = 18000;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// A GIF of video frames at a constant frame rate: `frames` is an iterable of { data, width, height, name? } (RGBA),
// read one at a time, so only one byte per pixel is kept. `fps` is a fraction { numerator, denominator, label? }
// (see parseFrameRate in sequence.js). Frame k starts at k × 1000 × denominator / numerator ms, rounded to GIF's
// centiseconds, so the delays may alternate (30 fps is 30, 40, 30 ms) while the loop keeps its length. `loops` is
// the number of plays, 0 for ever. Colours are exact as in encodeGIF; frames that use different colours get tables
// of their own. `notes` say in words what GIF changed.
export function framesGIF(frames, { fps, loops = 0, background = null } = {}) {
  const { numerator, denominator } = fps ?? {};
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 1 || denominator < 1 || numerator > 240 * denominator) throw new PixelError('gif.fps', 'expected a frame rate above 0 and up to 240 frames per second');
  if (denominator > 60 * numerator) throw new PixelError('gif.fps', 'a frame may last at most 60 seconds; expected at least 1/60 frames per second');
  if (!Number.isInteger(loops) || loops < 0 || loops > 65536) throw new PixelError('gif.loops', 'expected 0 (play for ever) or the number of plays, 1 to 65536');
  if (background !== null && (!Array.isArray(background) || background.length < 3 || background.slice(0, 3).some(value => !Number.isInteger(value) || value < 0 || value > 255))) throw new PixelError('gif.background', 'expected [r, g, b]');
  if (typeof frames?.[Symbol.iterator] !== 'function') throw new PixelError('gif', 'expected frames as a list or other iterable of { data, width, height }');
  const indexed = [];
  let width = 0, height = 0, partialAlpha = 0, fewest = Infinity, most = 0;
  for (const frame of frames) {
    if (indexed.length === MAX_FRAMES) throw new PixelError('gif', `more than ${MAX_FRAMES} frames; shorten the loop`);
    const label = frame.name ?? `frame ${indexed.length + 1}`;
    if (!indexed.length) {
      ({ width, height } = frame);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) throw new PixelError('gif', `${label} has invalid dimensions`);
    } else if (frame.width !== width || frame.height !== height) throw new PixelError('gif', `${label} is ${frame.width}×${frame.height}, but the first frame is ${width}×${height}; every frame must be the same size`);
    if (frame.data?.length !== width * height * 4) throw new PixelError('gif', `${label}: RGBA buffer does not match its dimensions`);
    if ((indexed.length + 1) * width * height > MAX_FRAMES_PIXELS) throw new PixelError('gif', `more than ${Math.floor(MAX_FRAMES_PIXELS / (width * height))} frames at ${width}×${height} exceed 134,217,728 pixels; shorten the loop or use smaller frames`);
    const entry = indexFrame(frame.data, width * height, background, () => label);
    partialAlpha += entry.partialAlpha; fewest = Math.min(fewest, entry.colors.length); most = Math.max(most, entry.colors.length);
    indexed.push(entry);
  }
  if (!indexed.length) throw new PixelError('gif', 'at least one frame is required');
  // Exact start times in centiseconds, rounded half up; each delay is the step to the next start.
  const start = k => Math.floor((2 * k * 100 * denominator + numerator) / (2 * numerator)), count = indexed.length;
  let raised = 0;
  for (const [k, entry] of indexed.entries()) {
    const step = start(k + 1) - start(k);
    if (step < 2) raised++;
    entry.delay = Math.max(2, step);
  }
  const gif = writeGIF(indexed, width, height, { loops }), delays = indexed.map(entry => entry.delay * 10);
  const frameMs = 1000 * denominator / numerator, exact = count * frameMs, duration = delays.reduce((sum, delay) => sum + delay, 0), round = value => Math.round(value * 1000) / 1000;
  const used = new Map();
  for (const delay of delays) used.set(delay, (used.get(delay) ?? 0) + 1);
  const label = fps.label ?? (denominator === 1 ? String(numerator) : `${numerator}/${denominator}`), notes = [];
  if (partialAlpha) notes.push(`${plural(partialAlpha, 'partly transparent pixel')} across the frames became fully transparent (below 50% alpha) or fully opaque; GIF has no partial transparency. Pass a background colour to blend them instead.`);
  if (raised) notes.push(`At ${label} fps a frame lasts ${round(frameMs)} ms, faster than GIF plays: browsers show delays under 20 ms at 100 ms, so ${raised} of ${count} delays were raised to 20 ms and the loop lasts ${duration} ms instead of ${round(exact)} ms. Use 50 fps or less.`);
  else if (used.size > 1 || !Number.isInteger(frameMs / 10)) notes.push(`At ${label} fps a frame lasts ${round(frameMs)} ms, which GIF's 10 ms steps cannot hold: the delays are ${[...used].map(([delay, times]) => `${delay} ms × ${times}`).join(', ')}, keeping every frame within 5 ms of its time${duration === exact ? ` and the loop at exactly ${duration} ms` : `; the loop lasts ${duration} ms instead of ${round(exact)} ms`}.`);
  if (!gif.shared) notes.push(`The frames use ${gif.colors} colours in all (${fewest === most ? most : `${fewest}–${most}`} per frame), more than one 256-colour table holds, so each frame carries its own table; every colour is exact.`);
  return { data: gif.data, width, height, frames: count, fps: { label, numerator, denominator }, frameMs: round(frameMs), duration, delays: Object.fromEntries(used), loops, colors: gif.colors, colorsPerFrame: { fewest, most }, tables: gif.shared ? 'shared' : 'per frame', transparent: gif.transparent, partialAlpha, notes };
}

// One animation of a rendered project as a GIF. The default scale is the largest whole number that keeps the longer
// side within 256 pixels. `notes` says, in words, what GIF could not keep.
export function animationGIF(project, animation, options = {}) {
  const names = Object.keys(project.animations), name = animation ?? names[0];
  for (const key of Object.keys(options)) if (!['scale', 'background'].includes(key)) throw new PixelError(`gif.${key}`, 'unknown option; use scale or background');
  if (!Object.hasOwn(project.animations, name)) throw new PixelError('gif.animation', `no animation named "${name}"; choose one of: ${names.join(', ')}`);
  const sequence = project.animations[name], scale = options.scale ?? Math.max(1, Math.min(16, Math.floor(256 / Math.max(project.width, project.height))));
  let background = null;
  if (options.background !== undefined && options.background !== 'transparent') {
    background = parseColor(options.background, project.palette, 'gif.background');
    if (background[3] !== 255) throw new PixelError('gif.background', 'must be an opaque colour; omit it to keep 1-bit transparency');
  }
  const frames = sequence.frames.map(index => ({ data: project.frames[index].data, duration: project.frames[index].duration }));
  const gif = encodeGIF(frames, project.width, project.height, { loop: sequence.loop, scale, background }), notes = [];
  if (gif.partialAlpha) notes.push(`${gif.partialAlpha} partly transparent pixel${gif.partialAlpha === 1 ? '' : 's'} across the frames became fully transparent (below 50% alpha) or fully opaque; GIF has no partial transparency. Pass a background colour to blend them instead.`);
  const retimed = frames.map((frame, position) => [frame.duration, gif.delays[position]]).filter(([from, to]) => from !== to);
  if (retimed.length) notes.push(`${retimed.length} of ${frames.length} frame durations were rounded to GIF's 10 ms steps (20 ms minimum): ${[...new Set(retimed.map(([from, to]) => `${from}→${to}`))].slice(0, 8).join(', ')}${new Set(retimed.map(([from, to]) => `${from}→${to}`)).size > 8 ? ', …' : ''}.`);
  return { data: gif.data, animation: name, width: gif.width, height: gif.height, scale, frames: frames.length, duration: gif.delays.reduce((sum, delay) => sum + delay, 0), loop: sequence.loop, colors: gif.colors, transparent: gif.transparent, partialAlpha: gif.partialAlpha, notes };
}
