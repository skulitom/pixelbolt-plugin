// A folder of numbered PNG frames, as video tools and `pixelbolt sequence` write them, turned into a GIF. The
// folder is read in number order, one frame at a time; nothing in it is changed. Numbering, gaps and stray files are
// reported rather than guessed around.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PixelError, parseColor } from './core.js';
import { decodePNG } from './import.js';
import { framesGIF } from './gif.js';
import { parseFrameRate } from './sequence.js';

const fail = (where, message) => { throw new PixelError(where, message); };
const NUMBERED = /^(.*?)(\d{1,9})\.png$/i;

// Picks the numbered frames from a list of file names: name_0001.png, name_0002.png, ... in number order. Names
// that differ only by their number belong to one sequence; `prefix` chooses one when a folder holds several.
// Returns the frames, the numbers that are missing between the first and the last, and the PNGs left out.
export function numberedFrames(names, { prefix } = {}) {
  const groups = new Map(), unnumbered = [];
  for (const file of names) {
    const match = NUMBERED.exec(file);
    if (!match) { if (/\.png$/i.test(file)) unnumbered.push(file); continue; }
    const key = match[1];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file, number: Number(match[2]) });
  }
  const describe = key => `"${key}" (${groups.get(key).length})`;
  if (prefix !== undefined && !groups.has(prefix)) fail('frames.prefix', groups.size ? `no frames are named ${prefix}<number>.png; the numbered PNGs here use ${[...groups.keys()].map(describe).join(', ')}` : 'the folder has no numbered PNG frames');
  if (!groups.size) fail('frames', `no numbered PNG frames (such as frame_0001.png) in the folder${unnumbered.length ? `; found ${unnumbered.slice(0, 4).join(', ')}${unnumbered.length > 4 ? ', …' : ''}` : ''}`);
  if (prefix === undefined && groups.size > 1) fail('frames.prefix', `the folder holds ${groups.size} numbered sequences: ${[...groups.keys()].map(describe).join(', ')}; choose one with --prefix`);
  const chosen = prefix ?? [...groups.keys()][0], frames = groups.get(chosen).sort((a, b) => a.number - b.number || (a.file < b.file ? -1 : 1));
  for (let i = 1; i < frames.length; i++) if (frames[i].number === frames[i - 1].number) fail('frames', `${frames[i - 1].file} and ${frames[i].file} have the same number`);
  const gaps = [];
  for (let i = 1; i < frames.length; i++) if (frames[i].number > frames[i - 1].number + 1) gaps.push([frames[i - 1].number + 1, frames[i].number - 1]);
  const others = [...unnumbered, ...[...groups.keys()].filter(key => key !== chosen).flatMap(key => groups.get(key).map(entry => entry.file))].sort();
  return { prefix: chosen, frames, first: frames[0].number, last: frames.at(-1).number, gaps, others };
}

// Reads `directory` and returns framesGIF's result for its numbered frames at `fps`, plus what was read. Options:
// fps (required), loops (plays; 0 for ever, the default), background (a hex colour to blend onto) and prefix.
export function folderGIF(directory, { fps, loops = 0, background, prefix } = {}) {
  if (fps === undefined) fail('gif.fps', 'a frame rate is required, for example 12, 24, 25 or 30');
  const rate = parseFrameRate(fps, 'gif.fps');
  let names;
  try { names = readdirSync(directory); } catch (error) { fail('frames', error.code === 'ENOENT' ? `no folder at ${path.resolve(directory)}` : error.code === 'ENOTDIR' ? `${path.resolve(directory)} is a file; name the folder that holds the frames` : error.message); }
  const found = numberedFrames(names, { prefix });
  let blend = null;
  if (background !== undefined && background !== 'transparent') {
    blend = parseColor(background, {}, 'gif.background');
    if (blend[3] !== 255) fail('gif.background', 'must be an opaque colour; omit it to keep 1-bit transparency');
  }
  function* frames() {
    for (const { file } of found.frames) {
      let image;
      try { image = decodePNG(readFileSync(path.join(directory, file))); } catch (error) { fail(`frames.${file}`, error instanceof PixelError ? error.message.replace(/^import: /, '') : error.message); }
      yield { ...image, name: file };
    }
  }
  const gif = framesGIF(frames(), { fps: rate, loops, background: blend }), notes = [...gif.notes];
  if (found.gaps.length) notes.unshift(`The numbering skips ${found.gaps.slice(0, 8).map(([from, to]) => from === to ? String(from) : `${from}–${to}`).join(', ')}${found.gaps.length > 8 ? ', …' : ''}. The GIF holds only the frames that exist, so check that none is missing.`);
  if (found.others.length) notes.push(`${found.others.length} other PNG file${found.others.length === 1 ? ' was' : 's were'} left out: ${found.others.slice(0, 4).join(', ')}${found.others.length > 4 ? ', …' : ''}.`);
  return { ...gif, notes, source: { directory: path.resolve(directory), prefix: found.prefix, first: found.frames[0].file, last: found.frames.at(-1).file, numbers: [found.first, found.last], ...(found.gaps.length && { gaps: found.gaps }) } };
}
