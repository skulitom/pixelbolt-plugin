// Share links and recipes inside PNGs, for the browser playground, the CLI and the MCP server. Browser-compatible and
// without static imports: the playground serves a byte-identical copy as playground/share.js (test/share.test.js keeps
// the two equal), so it can read and write these formats whatever engine version it loads.
//
// A share link keeps the recipe in the URL fragment, which browsers never send to a server:
//   https://skulitom.github.io/Pixelbolt/playground/#v=<engine version>&r=<base64url of deflate-raw(JSON)>
// A PNG carries its recipe in a compressed iTXt chunk with the keyword `pixelbolt-recipe`, whose text is the JSON
// {"v": <engine version>, "kind": <recipe kind>, "recipe": <source document>}.
export const PLAYGROUND_URL = 'https://skulitom.github.io/Pixelbolt/playground/';
export const RECIPE_KEYWORD = 'pixelbolt-recipe';
// Longest share link, in characters. Links this long still open in every current browser and fit a chat message;
// a larger recipe is shared as a file (a .json recipe, or a PNG that carries it).
export const LINK_LIMIT = 16384;
// Largest recipe text a link or PNG may unpack to: the engine's own request limit (core.js MAX_REQUEST_BYTES).
export const RECIPE_LIMIT = 16 * 1024 * 1024;
// The first engine version the playground can load; links and PNGs name a version at least this new.
export const FIRST_VERSION = '0.9.0';

export class ShareError extends Error {
  constructor(message) { super(message); this.name = 'ShareError'; }
}
const fail = message => { throw new ShareError(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Source formats and the kind each one is; a recipe without `format` is a plain project.
const KINDS = { 'pixelforge-poses': 'poses', 'pixelforge-scene': 'scene', 'pixelforge-fx': 'fx', 'pixelforge-fluid': 'fluid', 'pixelforge-normals': 'normals', 'pixelforge-autotile': 'autotile' };
export const RECIPE_KINDS = Object.freeze(['project', ...Object.values(KINDS)]);
export function recipeKind(document) {
  if (!isObject(document)) fail('A recipe must be a JSON object.');
  if (document.format === undefined) return 'project';
  if (typeof document.format === 'string' && Object.hasOwn(KINDS, document.format)) return KINDS[document.format];
  return fail(`Recipes with format ${JSON.stringify(String(document.format)).slice(0, 80)} can't be shared or rendered on their own.`);
}

// A published engine version: plain major.minor.patch, no newer than anything sensible and no older than FIRST_VERSION.
export function checkVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(version)) fail('The engine version must look like 0.9.0.');
  const parts = version.split('.').map(Number), first = FIRST_VERSION.split('.').map(Number);
  const order = parts[0] - first[0] || parts[1] - first[1] || parts[2] - first[2];
  if (order < 0) fail(`Pixelbolt ${version} is older than the playground supports (${FIRST_VERSION} or newer).`);
  return version;
}

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
async function transform(bytes, stream, limit, damaged) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader(), parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel().catch(() => {}); fail(`The recipe unpacks to more than ${limit.toLocaleString('en')} bytes.`); }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof ShareError) throw error;
    fail(damaged);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
// Node.js 20.0 to 20.11 have no 'deflate-raw' compression stream; there links fall back to node:zlib, loaded only then.
// Every browser that runs the playground has the stream.
const stream = (Kind, format) => { try { return new Kind(format); } catch (error) { if (format === 'deflate-raw') return null; throw error; } };
async function zlib() {
  try { return await import('node:zlib'); } catch { return fail('This browser or runtime cannot pack share links (it has no deflate-raw).'); }
}
async function compress(bytes, format) {
  const compressor = stream(CompressionStream, format);
  return compressor ? transform(bytes, compressor, Infinity, 'Compression failed.') : new Uint8Array((await zlib()).deflateRawSync(bytes));
}
async function decompress(bytes, format, damaged) {
  const decompressor = stream(DecompressionStream, format);
  if (decompressor) return transform(bytes, decompressor, RECIPE_LIMIT, damaged);
  const { inflateRawSync } = await zlib();
  try { return new Uint8Array(inflateRawSync(bytes, { maxOutputLength: RECIPE_LIMIT })); } catch (error) {
    return fail(error?.code === 'ERR_BUFFER_TOO_LARGE' ? `The recipe unpacks to more than ${RECIPE_LIMIT.toLocaleString('en')} bytes.` : damaged);
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function toBase64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + (i + 1 < bytes.length ? ALPHABET[n >> 6 & 63] : '') + (i + 2 < bytes.length ? ALPHABET[n & 63] : '');
  }
  return out;
}
function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) fail('The link is damaged: its recipe part is not base64url.');
  const out = new Uint8Array(Math.floor(text.length * 3 / 4));
  let bits = 0, value = 0, offset = 0;
  for (const char of text) {
    value = value << 6 | ALPHABET.indexOf(char); bits += 6;
    if (bits >= 8) { bits -= 8; out[offset++] = value >> bits & 255; }
  }
  return out;
}
function parseRecipe(bytes, where) {
  let text, value;
  try { text = decoder.decode(bytes); } catch { fail(`${where} is not UTF-8 text.`); }
  try { value = JSON.parse(text); } catch { fail(`${where} is not valid JSON.`); }
  return value;
}

// The link for a recipe on an engine version. Refuses a link longer than `limit` characters.
export async function shareLink(recipe, version, { base = PLAYGROUND_URL, limit = LINK_LIMIT } = {}) {
  recipeKind(recipe); checkVersion(version);
  const text = encoder.encode(JSON.stringify(recipe));
  if (text.length > RECIPE_LIMIT) fail(`The recipe is larger than ${RECIPE_LIMIT.toLocaleString('en')} bytes.`);
  const link = `${base}#v=${version}&r=${toBase64url(await compress(text, 'deflate-raw'))}`;
  if (link.length > limit) fail(`This recipe makes a ${link.length.toLocaleString('en')}-character link, over the ${limit.toLocaleString('en')}-character limit. Download the recipe or a PNG and share the file instead.`);
  return link;
}

// Reads a share link: a whole URL, its fragment ("#v=…&r=…") or the fragment without "#". Returns the version, kind
// and recipe, or throws a ShareError that says what is wrong.
export async function readShareLink(link, { limit = LINK_LIMIT } = {}) {
  if (typeof link !== 'string') fail('A share link must be text.');
  if (link.length > limit) fail(`The link is ${link.length.toLocaleString('en')} characters long, over the ${limit.toLocaleString('en')}-character limit.`);
  const hash = link.indexOf('#'), params = new URLSearchParams(hash >= 0 ? link.slice(hash + 1) : link);
  const version = params.get('v'), packed = params.get('r');
  if (version === null || packed === null) fail('The link has no recipe in it (it needs both v= and r=).');
  checkVersion(version);
  const recipe = parseRecipe(await decompress(fromBase64url(packed), 'deflate-raw', 'The link is damaged: its recipe does not unpack.'), 'The link\'s recipe');
  return { version, kind: recipeKind(recipe), recipe };
}

// PNG chunks. Only the chunk this module reads is checked against its CRC; other chunks pass through untouched.
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const u32 = (bytes, at) => (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
function chunksOf(png) {
  if (!(png instanceof Uint8Array)) fail('Expected PNG bytes.');
  if (png.length < 8 || SIGNATURE.some((byte, i) => png[i] !== byte)) fail('This file is not a PNG.');
  const chunks = [];
  for (let at = 8; ;) {
    if (at + 12 > png.length) fail('This PNG is cut short.');
    const length = u32(png, at), type = String.fromCharCode(...png.subarray(at + 4, at + 8)), end = at + 12 + length;
    if (length > 0x7fffffff || end > png.length) fail('This PNG is cut short.');
    chunks.push({ type, start: at, end, data: png.subarray(at + 8, at + 8 + length), crc: u32(png, at + 8 + length), stored: png.subarray(at + 4, at + 8 + length) });
    if (type === 'IEND') return chunks;
    at = end;
  }
}
const isRecipeChunk = chunk => chunk.type === 'iTXt' && chunk.data.length > RECIPE_KEYWORD.length && chunk.data[RECIPE_KEYWORD.length] === 0
  && String.fromCharCode(...chunk.data.subarray(0, RECIPE_KEYWORD.length)) === RECIPE_KEYWORD;

// The PNG with its recipe embedded: any earlier recipe chunk is replaced, and the new one goes just before IEND.
export async function embedRecipe(png, recipe, version) {
  const kind = recipeKind(recipe); checkVersion(version);
  // The reader refuses more than RECIPE_LIMIT bytes, so never write a PNG it couldn't reopen.
  const envelope = encoder.encode(JSON.stringify({ v: version, kind, recipe }));
  if (envelope.length > RECIPE_LIMIT) fail(`The recipe is too large to carry in a PNG (over ${RECIPE_LIMIT.toLocaleString('en')} bytes).`);
  const text = await compress(envelope, 'deflate');
  const data = new Uint8Array(RECIPE_KEYWORD.length + 5 + text.length);
  data.set(encoder.encode(RECIPE_KEYWORD)); data.set([0, 1, 0, 0, 0], RECIPE_KEYWORD.length); data.set(text, RECIPE_KEYWORD.length + 5);
  const chunk = new Uint8Array(data.length + 12), type = encoder.encode('iTXt');
  chunk.set([data.length >>> 24 & 255, data.length >>> 16 & 255, data.length >>> 8 & 255, data.length & 255]); chunk.set(type, 4); chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, chunk.length - 4));
  chunk.set([crc >>> 24 & 255, crc >>> 16 & 255, crc >>> 8 & 255, crc & 255], chunk.length - 4);
  const kept = chunksOf(png).filter(entry => !isRecipeChunk(entry)), iend = kept.pop();
  const parts = [png.subarray(0, 8), ...kept.map(entry => png.subarray(entry.start, entry.end)), chunk, png.subarray(iend.start, iend.end)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// The recipe a PNG carries, as { version, kind, recipe }, or null when it carries none. A damaged recipe chunk throws
// a ShareError rather than returning null, so a broken file is never mistaken for a plain image.
export async function readEmbeddedRecipe(png) {
  const chunk = chunksOf(png).find(isRecipeChunk);
  if (!chunk) return null;
  if (crc32(chunk.stored) !== chunk.crc) fail('The PNG\'s embedded recipe is damaged (its checksum does not match).');
  const data = chunk.data, nul = (from, what) => { const at = data.indexOf(0, from); if (at < 0) fail(`The PNG's embedded recipe is damaged (no end to its ${what}).`); return at; };
  let at = RECIPE_KEYWORD.length + 1;
  const compressed = data[at], method = data[at + 1];
  if (compressed > 1 || method !== 0) fail('The PNG\'s embedded recipe uses an unknown compression.');
  at = nul(at + 2, 'language tag') + 1;
  at = nul(at, 'translated keyword') + 1;
  const text = compressed ? await decompress(data.subarray(at), 'deflate', 'The PNG\'s embedded recipe is damaged (it does not unpack).') : data.subarray(at);
  if (text.length > RECIPE_LIMIT) fail(`The PNG's embedded recipe is larger than ${RECIPE_LIMIT.toLocaleString('en')} bytes.`);
  const value = parseRecipe(text, 'The PNG\'s embedded recipe');
  if (!isObject(value) || typeof value.v !== 'string' || typeof value.kind !== 'string' || !isObject(value.recipe)) fail('The PNG\'s embedded recipe is damaged (it needs v, kind and recipe).');
  checkVersion(value.v);
  const kind = recipeKind(value.recipe);
  if (kind !== value.kind) fail(`The PNG's embedded recipe says it is a ${value.kind} but holds a ${kind}.`);
  return { version: value.v, kind, recipe: value.recipe };
}
