import { renderProject, buildAtlas, scalePixels, PixelError } from './core.js';
import { encodePNG, encodeAPNG, crc32 } from './png.js';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const json = value => JSON.stringify(value, null, 2) + '\n';
// Compact, deterministic JSON for generated recipes: any object or array that fits within `width` columns stays on one
// line and larger ones open one entry per line, so frames and operations read as single lines. Pixel grids (symbol
// rows, grid and rule rows, templates, masks) always keep one row per line, so the art stays visible as text. Parses
// back to the same value as JSON.stringify.
const GRID_KEYS = new Set(['rows', 'template', 'match', 'replace', 'mask', 'directions']);
export function formatJSON(value, width = 120) {
  const entries = object => Object.entries(object).filter(([, v]) => v !== undefined);
  const inline = v => Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
    : v !== null && typeof v === 'object' ? (entries(v).length ? `{ ${entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}')
    : JSON.stringify(v);
  // A grid is an array of several strings under a grid key, or any value of a `symbols` map. `key` is the value's own
  // key and `parent` its container's key.
  const hasGrid = (v, key, parent) => {
    if (v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return ((GRID_KEYS.has(key) || parent === 'symbols') && v.length > 1 && v.every(row => typeof row === 'string')) || v.some(x => hasGrid(x, null, key));
    return entries(v).some(([k, x]) => hasGrid(x, k, key));
  };
  const format = (v, indent, lead, key, parent) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const flat = inline(v);
    if (!hasGrid(v, key, parent) && indent.length + lead + flat.length <= width) return flat;
    const inner = `${indent}  `;
    if (Array.isArray(v)) return v.length ? `[\n${v.map(x => inner + format(x, inner, 0, null, key)).join(',\n')}\n${indent}]` : '[]';
    return `{\n${entries(v).map(([k, x]) => { const label = `${JSON.stringify(k)}: `; return inner + label + format(x, inner, label.length, k, key); }).join(',\n')}\n${indent}}`;
  };
  return format(value, '', 0, null, null) + '\n';
}
export function generateCSS(project, atlas) {
  // A trimmed atlas cannot back a fixed-size element without showing neighbouring frames, so trimmed recipes
  // switch between the full-canvas frame PNGs instead of sliding a background position.
  const trimmed = Boolean(project.sheet.trim), size = `width: ${project.width * project.sheet.scale}px; height: ${project.height * project.sheet.scale}px;`;
  const image = frame => `background-image: url("frames/${frame.name}.png");`;
  const place = frame => { const rect = atlas.metadata.frames[frame.name].frame; return `background-position: -${rect.x}px -${rect.y}px;`; };
  const show = trimmed ? image : place;
  const lines = [`/* Pixelbolt: ${trimmed ? 'frames switch between the full-canvas images in frames/.' : 'atlas coordinates are pixels at the exported scale.'} */`, `.pf-${project.name} {`, `  display: inline-block;`, `  ${size}`, trimmed ? `  ${image(project.frames[0])}` : `  background-image: url("${project.name}.png");`, `  background-repeat: no-repeat; image-rendering: pixelated;`, `}`];
  for (const [key, anim] of Object.entries(project.animations)) {
    const id = `pf-${project.name}-${key}`;
    lines.push(`.${id} { ${show(project.frames[anim.frames[0]])} animation: ${id} ${anim.duration}ms steps(1, end) ${anim.loop ? 'infinite' : '1 forwards'}; }`, `@keyframes ${id} {`);
    let elapsed = 0;
    for (const index of anim.frames) {
      const f = project.frames[index];
      lines.push(`  ${Number((elapsed / anim.duration * 100).toFixed(8))}% { ${show(f)} }`);
      elapsed += f.duration;
    }
    lines.push(`  100% { ${show(project.frames[anim.loop ? anim.frames[0] : anim.frames.at(-1)])} }`, `}`);
  }
  lines.push('@media (prefers-reduced-motion: reduce) {', ...Object.keys(project.animations).map(key => `  .pf-${project.name}-${key} { animation: none; }`), '}');
  return lines.join('\n') + '\n';
}
export async function createBundle(spec) {
  const project = renderProject(spec);
  const { width, height, sheet, frames, name } = project;
  const animationPixels = Object.values(project.animations).reduce((sum, a) => sum + a.frames.length * width * height * sheet.scale ** 2, 0);
  if (animationPixels > 67108864) throw new PixelError('project.animations', 'export exceeds 67,108,864 animation pixels; shorten sequences or reduce scale');
  const atlas = buildAtlas(project);
  const files = new Map();
  files.set(`${name}.png`, encodePNG(atlas.data, atlas.width, atlas.height));
  files.set(`${name}.atlas.json`, Buffer.from(json(atlas.metadata)));
  files.set(`${name}.pixel.json`, Buffer.from(json(spec)));
  files.set(`${name}.css`, Buffer.from(generateCSS(project, atlas)));
  const scaledFrames = frames.map(f => ({ ...f, data: scalePixels(f.data, width, height, sheet.scale) }));
  for (const frame of scaledFrames) files.set(`frames/${frame.name}.png`, encodePNG(frame.data, width * sheet.scale, height * sheet.scale));
  for (const [key, anim] of Object.entries(project.animations)) files.set(`animations/${key}.png`, encodeAPNG(anim.frames.map(i => scaledFrames[i]), width * sheet.scale, height * sheet.scale, anim.loop));
  files.set('player.js', await readFile(new URL('./runtime.js', import.meta.url)));
  files.set('preview.html', Buffer.from(previewHTML(project)));
  files.set('README.txt', Buffer.from(`${name} — Pixelbolt export\n\n${name}.png: transparent RGBA sprite sheet\n${name}.atlas.json: TexturePacker-style frames and named animation sequences\n${name}.css: CSS classes with per-frame timing\nframes/: individual PNGs\nanimations/: animated PNGs (APNG)\n${name}.pixel.json: editable source\nplayer.js: dependency-free Canvas player\npreview.html: open directly in a browser, or serve this folder\n\nCanvas: import { SpritePlayer } from './player.js';\nconst player = await SpritePlayer.load(canvas, './${name}.atlas.json');\nplayer.play('${Object.keys(project.animations)[0]}');\n\nCSS: <link rel="stylesheet" href="${name}.css">\n<span class="pf-${name} pf-${name}-${Object.keys(project.animations)[0]}"></span>\n`));
  return { project, atlas, files };
}
function previewHTML(project) {
  const { name, animations } = project;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${name} · Pixelbolt</title><link rel="stylesheet" href="${name}.css"><style>body{font:16px system-ui;background:#17191d;color:#e6e7eb;margin:48px}main{display:flex;gap:32px;flex-wrap:wrap}figure{margin:0;padding:24px;background:#252930;border-radius:12px}img{width:${project.width * Math.min(8, Math.max(1, Math.floor(256 / project.width)))}px;image-rendering:pixelated}figcaption{margin-top:20px}a{color:#c4b9f3}</style><h1>${name}</h1><p>Animated PNGs. Original frame timing and transparency are preserved.</p><main>${Object.keys(animations).map(key => `<figure><img src="animations/${key}.png" alt="${key} animation"><figcaption>${key}</figcaption></figure>`).join('')}</main><p><a href="${name}.png">Sprite sheet</a> · <a href="${name}.atlas.json">Atlas metadata</a> · <a href="${name}.pixel.json">Editable source</a></p></html>`;
}

// Store-mode ZIP keeps the already-compressed PNGs intact and needs no dependency.
export function createZip(files) {
  if (!(files instanceof Map)) throw new PixelError('zip', 'expected a Map of filenames to byte buffers');
  if (files.size > 65535) throw new PixelError('zip', 'ZIP32 supports at most 65,535 entries; split the bundle into smaller archives');
  // Reject before checksumming or allocating any archive buffers.
  let localSize = 0, directorySize = 0;
  for (const [filename, data] of files) {
    if (typeof filename !== 'string' || !(data instanceof Uint8Array)) throw new PixelError('zip', 'entries require string filenames and byte buffers');
    const length = Buffer.byteLength(filename);
    if (!length || length > 65535) throw new PixelError('zip', 'filenames must contain 1–65,535 UTF-8 bytes');
    localSize += 30 + length + data.length; directorySize += 46 + length;
    if (localSize + directorySize + 22 > 0xffffffff) throw new PixelError('zip', 'archive exceeds the ZIP32 byte budget; split the bundle');
  }
  const local = [], central = [];
  let offset = 0;
  for (const [filename, data] of files) {
    const name = Buffer.from(filename), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export async function writeBundle(bundle, directory, { force = false } = {}) {
  const root = path.resolve(directory);
  // Preflight all output collisions before writing any artifact.
  if (!force) for (const filename of bundle.files.keys()) {
    try { await access(path.join(root, filename)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Output already exists: ${path.join(root, filename)}. Choose a new folder or pass --force.`);
  }
  await mkdir(root, { recursive: true });
  for (const [filename, data] of bundle.files) {
    const target = path.join(root, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: force ? 'w' : 'wx' });
  }
  return [...bundle.files.keys()].map(filename => path.join(root, filename));
}
