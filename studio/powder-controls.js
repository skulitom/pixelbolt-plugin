// The Powder lab's scenes, brushes, replay links and matching commands, without the page. No DOM access and no imports,
// so Node tests and the studio walk run exactly what the page runs (test/powder-controls.test.js). The page passes in
// what it needs from src/powder.js.
//
// A replay link names the scene and, packed by src/powder.js's packStrokes, deflated and base64url'd as the fluid toy
// packs its pokes, every stroke made since the scene started and the frame it had reached:
//   http://127.0.0.1:4747/powder.html#s=<scene>&i=<base64url of deflate(strokes)>&h=<pixels when the link was made>
// The engine draws the same pixels for the same strokes on the same frames, so the replay redraws what the sender saw;
// `h` lets the page say so, or say that it differs (another Pixelbolt version).

// The lab's scenes: a sandbox to paint in, then the shipped presets (examples/<file>.powder.json), which the studio's
// asset allowlist reads from here.
export const POWDER_SCENES = [
  { id: 'sandbox', title: 'Sandbox', note: 'Paint anything · 256 × 144' },
  { id: 'hut-fire', file: 'hut-fire', title: 'Hut fire', note: 'Burning, collapse, floating' },
  { id: 'lava-falls', file: 'lava-falls', title: 'Lava falls', note: 'Lava, moss and steam' },
  { id: 'quarry-blast', file: 'quarry-blast', title: 'Quarry blast', note: 'A blast throws sand and water' },
  { id: 'rain-on-fire', file: 'rain-on-fire', title: 'Rain on fire', note: 'Wind, then rain on a campfire' },
  { id: 'stilt-hut', file: 'stilt-hut', title: 'Stilt hut', note: 'Tumbling pieces: a hut topples' }
];
export const POWDER_PRESETS = POWDER_SCENES.filter(scene => scene.file);
export const sceneById = id => POWDER_SCENES.find(scene => scene.id === id);

// The sandbox, as an agent would write it: the starter table, a stone floor, a ledge, a basin of water and a few planks.
// At most 256 pixels a side, so its source still compiles.
export const SANDBOX_SOURCE = {
  format: 'pixelforge-powder', version: 1, name: 'sandbox', base: 'sandbox', width: 256, height: 144, seed: 1,
  scene: [
    { material: 'stone', rect: [0, 136, 256, 8] },
    { material: 'stone', rect: [0, 84, 60, 6] },
    { material: 'stone', rect: [156, 108, 5, 28] },
    { material: 'stone', rect: [251, 100, 5, 36] },
    { material: 'water', rect: [161, 116, 90, 20] },
    { material: 'wood', rect: [84, 126, 30, 3] },
    { material: 'wood', rect: [86, 129, 3, 7] },
    { material: 'wood', rect: [109, 129, 3, 7] }
  ]
};

// The tools besides painting a material. `colour` marks the tool's button; erase takes the scene's background.
export const POWDER_TOOLS = [
  { id: 'erase', title: 'Erase', colour: null, hint: 'Clears what is under the brush' },
  { id: 'wall', title: 'Wall', colour: '#414456', hint: 'A fixed wall nothing passes' },
  { id: 'heat', title: 'Heat', colour: '#ff5a2a', hint: 'Warms what is under the brush' },
  { id: 'cool', title: 'Cool', colour: '#7fd0ff', hint: 'Chills what is under the brush' },
  { id: 'wind', title: 'Wind', colour: '#9aa8c0', hint: 'Drag to blow the air along' },
  { id: 'blast', title: 'Blast', colour: '#ffd23a', hint: 'Click to throw loose cells out' }
];
export const TOOL_IDS = POWDER_TOOLS.map(tool => tool.id);
// Degrees a held heat or cool brush adds each frame, and the blast a click sets off.
export const HEAT_STEP = 80, BLAST = { extra: 6, strength: 4 };

// What a brush does between two pointer positions (cell centres): the input to queue, as [action, input], or null.
// `from` is where the pointer was at the last step, `at` where it is now. Painted solids fill every cell; other
// materials take `spray` of them. Values are rounded as a recording keeps them, so the calls shown are the calls made.
export function brushInput(tool, at, from, { radius, spray, solid }) {
  const line = { x: from.x, y: from.y, ...((at.x !== from.x || at.y !== from.y) && { x2: at.x, y2: at.y }), radius };
  if (tool === 'erase') return ['erase', line];
  if (tool === 'wall') return ['wall', line];
  if (tool === 'heat' || tool === 'cool') return ['heat', { ...line, amount: tool === 'heat' ? HEAT_STEP : -HEAT_STEP }];
  if (tool === 'wind') {
    // The air is dragged at half the pointer's speed (cells a step), at most 8 pixels a frame.
    const speed = value => Math.max(-8, Math.min(8, Math.round(value * 8) / 16));
    const vx = speed(at.x - from.x), vy = speed(at.y - from.y);
    return vx || vy ? ['push', { ...line, radius: radius + 4, vx, vy }] : null;
  }
  if (tool === 'blast') return ['burst', { x: at.x, y: at.y, radius: radius + BLAST.extra, strength: BLAST.strength }];
  return ['paint', { material: tool, ...line, fill: solid ? 1 : Math.round(spray * 100) / 100 }];
}
// Held down, every tool but the blast works on every step; the blast goes off once a click.
export const heldTool = tool => tool !== 'blast';

// A stroke as the live call that makes it, and as a scripted input for a source (`inputs`). The page shows the input on
// frame 0 of a fresh run (its live frame means nothing to a fresh run, and a later one may fall past the clip).
const plain = value => (typeof value === 'string' ? `'${value}'` : String(value));
export const callText = (action, input) => `live.${action}({ ${Object.entries(input).map(([key, value]) => `${key}: ${plain(value)}`).join(', ')} })`;
export const inputText = (frame, action, input) => `{ "frame": ${frame}, "${action}": { ${Object.entries(input).map(([key, value]) => `"${key}": ${JSON.stringify(value)}`).join(', ')} } }`;
// The step a source's last clip frame is sampled at, as compilePowder counts it (its metadata's `steps`), with the
// compiler's default clip (60 frames, every 2nd step from 0) when the source has none. A scripted input shows in the bake
// only on an earlier frame: one on this frame or later lands after the last frame is drawn.
export function clipSteps(source) {
  const clips = Object.values(source.clips ?? { clip: {} });
  return Math.max(...clips.map(({ start = 0, frames = 60, every = 2 }) => start + (frames - 1) * every));
}

// What the downloads match from the command line and through MCP. A preset compiles by name; the sandbox from its file.
export function powderCommands(scene, scale) {
  const file = scene.file ?? scene.id;
  return {
    cli: [`pixelbolt compile ${file}.powder.json --out ${file}.json`, `pixelbolt gif ${file}.json --scale ${scale} --out ${file}.gif`],
    mcp: [scene.file ? `pixel_compile { "preset": "${scene.file}" }` : `pixel_compile { "source": <${file}.powder.json> }`, `pixel_render { "revision": <from pixel_compile>, "gif": { "scale": ${scale} } }`]
  };
}

// The pixels' fingerprint for a link: FNV-1a over the RGBA bytes, as 8 hex digits.
export function pixelDigest(rgba) {
  let h = 0x811c9dc5;
  for (let i = 0; i < rgba.length; i++) h = Math.imul(h ^ rgba[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---- Links --------------------------------------------------------------------------------------------------------
export class PowderLinkError extends Error {
  constructor(message) { super(message); this.name = 'PowderLinkError'; }
}
const fail = message => { throw new PowderLinkError(message); };
// Longest link the lab makes, as for the playground's links; a longer recording is cut at a stroke to fit.
export const LINK_LIMIT = 16384;
// Longest link it reads, and the most its strokes may unpack to (65,536 strokes of at most 40 bytes).
const READ_LIMIT = 1048576, UNPACKED_LIMIT = 16 + 65536 * 40;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function toBase64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + (i + 1 < bytes.length ? ALPHABET[n >> 6 & 63] : '') + (i + 2 < bytes.length ? ALPHABET[n & 63] : '');
  }
  return out;
}
export function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) fail('This link is damaged: its strokes are not base64url.');
  const out = new Uint8Array(Math.floor(text.length * 3 / 4));
  let bits = 0, value = 0, offset = 0;
  for (const char of text) {
    value = (value << 6 | ALPHABET.indexOf(char)) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; out[offset++] = value >> bits & 255; }
  }
  return out;
}
// Plain deflate (zlib) streams, which every browser with CompressionStream and Node 20 both support.
async function pipe(bytes, transform, limit) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform), chunks = [], read = stream.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await read.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await read.cancel().catch(() => {}); fail('This link is damaged: its strokes unpack too large.'); }
      chunks.push(value);
    }
  } catch (error) { if (error instanceof PowderLinkError) throw error; fail('This link is damaged: its strokes do not unpack.'); }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

// The link for a scene, its packed strokes (packStrokes(strokes, frames)) and, optionally, the digest of its pixels.
export async function replayLink(base, { scene, packed, digest = null }) {
  if (!sceneById(scene)) fail(`There is no scene called ${scene}.`);
  const params = [`s=${scene}`, `i=${toBase64url(await pipe(packed, new CompressionStream('deflate'), Infinity))}`];
  if (digest) params.push(`h=${digest}`);
  return `${base}#${params.join('&')}`;
}
// The most frames a link replays: two hours at 60 steps a second. A link asking for more is refused, and the lab makes
// none longer. The replay steps as fast as the browser can, which for a busy scene is a few minutes an hour.
export const REPLAY_FRAMES = 432000;
// The longest recording that still fits `limit`, as { link, frames, kept, cut }. It stops early (`cut`) at the first
// of: the frame of the first stroke the recording left out (`recordedUntil`, the live grid's; 'full'), the most frames
// a link replays ('long'), or a stroke, when every stroke is too long a link ('length'). It then replays up to that
// frame, strokes made on it left waiting, and the digest, which describes the end, is dropped. `pack` is packStrokes.
export async function fitReplayLink(base, { scene, strokes, frames, digest = null, recordedUntil = null }, pack, limit = LINK_LIMIT) {
  let end = frames, cut = false;
  if (recordedUntil !== null) { end = Math.min(end, recordedUntil); cut = 'full'; }
  if (end > REPLAY_FRAMES) { end = REPLAY_FRAMES; cut = 'long'; }
  const kept = cut ? strokes.filter(s => s.f <= end) : strokes;
  const link = await replayLink(base, { scene, packed: pack(kept, end), digest: cut ? null : digest });
  if (link.length <= limit || !kept.length) return { link, frames: end, kept: kept.length, cut };
  const cutAt = async count => replayLink(base, { scene, packed: pack(kept.slice(0, count), kept[count].f) });
  let low = 0, high = kept.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((await cutAt(middle)).length <= limit) low = middle; else high = middle - 1;
  }
  return { link: await cutAt(low), frames: kept[low].f, kept: low, cut: 'length' };
}
// A link's unpacked strokes ({ frames, strokes }, from unpackStrokes), refused before any step when the replay could
// not end where the link says or would run longer than a link may.
export function checkReplay(unpacked) {
  const { frames, strokes } = unpacked;
  if (frames > REPLAY_FRAMES) fail(`This link asks for ${frames.toLocaleString('en')} frames; the lab replays at most ${REPLAY_FRAMES.toLocaleString('en')} (two hours at 60 a second).`);
  if (strokes.length && strokes.at(-1).f > frames) fail('This link is damaged: a stroke comes after its last frame.');
  return unpacked;
}
// The share heading's count. `recordedUntil` is the live grid's: null while every stroke is recorded, else the frame
// of the first stroke the recording left out, where a link made now stops.
export const recordedText = (count, recordedUntil = null) => (recordedUntil === null
  ? `${count.toLocaleString('en')} ${count === 1 ? 'stroke' : 'strokes'} recorded`
  : `Recording full: ${count.toLocaleString('en')} strokes, up to frame ${recordedUntil.toLocaleString('en')}`);
// Roughly how long the rest of a replay takes, from how fast it has gone so far; null until it has run for a second.
export function replayLeft(done, left, ms) {
  if (ms < 1000 || done <= 0) return null;
  const seconds = Math.ceil(left * ms / done / 1000);
  return seconds < 90 ? `about ${seconds} s left` : seconds < 5400 ? `about ${Math.round(seconds / 60)} min left` : `about ${Math.round(seconds / 360) / 10} h left`;
}
// Reads a link or its fragment: { scene, packed (bytes for unpackStrokes, or null), digest }, or null when it names a
// scene only (#hut-fire) or nothing.
export async function readReplayLink(link) {
  if (typeof link !== 'string') fail('A link must be text.');
  const text = link.slice(link.indexOf('#') + 1);
  if (!text.includes('=')) return null;
  if (text.length > READ_LIMIT) fail(`The link is ${text.length.toLocaleString('en')} characters long, more than the lab reads.`);
  const params = new URLSearchParams(text), scene = params.get('s'), packed = params.get('i'), digest = params.get('h');
  if (!sceneById(scene)) fail(scene === null ? 'The link names no scene (it needs s=).' : `There is no scene called ${scene}.`);
  if (digest !== null && !/^[0-9a-f]{8}$/.test(digest)) fail('This link is damaged: its pixel digest is not 8 hex digits.');
  return { scene, packed: packed === null ? null : await pipe(fromBase64url(packed), new DecompressionStream('deflate'), UNPACKED_LIMIT), digest };
}
