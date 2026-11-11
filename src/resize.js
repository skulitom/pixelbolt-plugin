// A recipe on a canvas of another size: the same drawing, cut to a window or given margins, never scaled. The window
// is chosen from what the frames draw (the one holding the most drawn pixels), every operation moves by one whole
// offset (a layer's by its own x and y as well), and the result renders exactly as that window of the original does:
// a margin shows the background, or nothing. With fewer frames (`keepFrames`): evenly spaced frames of each
// animation, playing as long as before. Browser-compatible.
import { CANVAS_SIDE, FRAME_AREA, parseColor, renderProject, fail } from './core.js';


// "32x32", "32×32" or [32, 32].
export function readSize(value, path = 'size') {
  const parts = typeof value === 'string' ? /^(\d{1,4})[x×](\d{1,4})$/i.exec(value.trim())?.slice(1).map(Number) : value;
  if (!Array.isArray(parts) || parts.length !== 2 || parts.some(side => !Number.isInteger(side) || side < 1 || side > CANVAS_SIDE)) {
    fail(path, `expected a canvas size such as "32x32", each side from 1 to ${CANVAS_SIDE}`);
  }
  return parts;
}

// Where the new canvas starts along one axis, in the old canvas's pixels (negative when it grows). `drawn` counts the
// drawn pixels of every frame per column or row. A smaller canvas takes the window with the most of them; a tie, and
// a larger canvas, keep an edge the drawing touches as an edge (a floor stays the floor) and centre otherwise.
function start(drawn, size) {
  const old = drawn.length, low = drawn[0] > 0, high = drawn[old - 1] > 0;
  const preferred = high && !low ? old - size : low && !high ? 0 : Math.floor((old - size) / 2);
  if (size >= old) return preferred;
  let sum = 0;
  for (let i = 0; i < size; i++) sum += drawn[i];
  let best = 0, most = sum;
  for (let at = 1; at + size <= old; at++) {
    sum += drawn[at + size - 1] - drawn[at - 1];
    if (sum > most || (sum === most && Math.abs(at - preferred) <= Math.abs(best - preferred))) { best = at; most = sum; }
  }
  return best;
}

// Operations that only place something: they move with the canvas. The rest read the whole canvas (an outline, a
// flood fill, a dither's pattern), so the same operation on another canvas would draw something else.
const PLACED = new Set(['pixel', 'rect', 'ellipse', 'line', 'clear', 'grid', 'stamp', 'text', 'copy', 'autotile', 'box', 'tilemap', 'replace']);

// What a move puts partly off the canvas keeps only its part on it, and what it puts wholly off is left out: a
// plain grid keeps those rows and columns, a plain stamp becomes a copy of that rectangle of its symbol, a pixel
// goes. None of it was ever drawn, and left in the recipe every later validate, render and export would report it as
// clipped, a warning nobody can act on after asking for the cut. Anything scaled, flipped or turned is left as it is.
function onCanvas(op, { width, height, symbols }) {
  if (op.op === 'pixel') return op.x >= 0 && op.y >= 0 && op.x < width && op.y < height ? op : null;
  const source = op.op === 'grid' ? op.rows : op.op === 'stamp' ? symbols?.[op.symbol] : null;
  if ((op.scale ?? 1) !== 1 || op.flipX || op.flipY || op.rotate || !Array.isArray(source) || source.some(row => typeof row !== 'string')) return op;
  const rows = source.map(row => [...row]), wide = Math.max(0, ...rows.map(row => row.length));
  const top = Math.max(0, -op.y), bottom = Math.min(rows.length, height - op.y), left = Math.max(0, -op.x), right = Math.min(wide, width - op.x);
  if (bottom <= top || right <= left) return null;
  if (!top && !left && bottom === rows.length && right === wide) return op;
  const at = { x: op.x + left, y: op.y + top };
  return op.op === 'grid' ? { ...op, ...at, rows: rows.slice(top, bottom).map(row => row.slice(left, right).join('')) }
    : { ...op, op: 'copy', ...at, sx: left, sy: top, w: right - left, h: bottom - top };
}

// `canvas`, { width, height, symbols }, also cuts what the move puts off the new canvas (not for a layer sorted by
// ground, where a grid stands on its lowest row).
function moveOps(ops, dx, dy, path, option, canvas = null) {
  return ops.map((op, index) => {
    const p = `${path}[${index}]`;
    if (!PLACED.has(op.op) || (op.op === 'copy' && op.symbol === undefined)) {
      fail(option, `${p} is ${op.op === 'copy' ? 'a copy from another frame' : `"${op.op}"`}, which reads the whole canvas, so this recipe cannot move to another canvas size; change the size in its source instead`);
    }
    if (op.op === 'replace') return op;
    const moved = { ...op, x: (op.x ?? 0) + dx, y: (op.y ?? 0) + dy };
    if (op.op === 'line') { moved.x2 = (op.x2 ?? op.x ?? 0) + dx; moved.y2 = (op.y2 ?? op.y ?? 0) + dy; }
    if (op.ground !== undefined) moved.ground = op.ground + dy;
    return canvas ? onCanvas(moved, canvas) : moved;
  }).filter(Boolean);
}

// { recipe, resized: { from, offset, cut } }: `offset` is where the new canvas starts in the old one, `cut` the share
// of the drawn pixels (over every frame) that the new canvas leaves out.
export function resizeRecipe(recipe, size, path = 'size') {
  const [width, height] = readSize(size, path), project = renderProject(recipe), { width: oldWidth, height: oldHeight } = project;
  if (width * height * project.frames.length > FRAME_AREA) fail(path, `${project.frames.length} frames of ${width}×${height} pixels exceed the ${FRAME_AREA.toLocaleString('en-US')}-pixel limit on a recipe's frames`);
  const columns = new Array(oldWidth).fill(0), rows = new Array(oldHeight).fill(0);
  for (const frame of project.frames) {
    for (let y = 0; y < oldHeight; y++) for (let x = 0; x < oldWidth; x++) if (frame.data[(y * oldWidth + x) * 4 + 3]) { columns[x]++; rows[y]++; }
  }
  const ox = start(columns, width), oy = start(rows, height), dx = -ox, dy = -oy;
  let total = 0, kept = 0;
  for (const frame of project.frames) {
    for (let y = 0; y < oldHeight; y++) for (let x = 0; x < oldWidth; x++) if (frame.data[(y * oldWidth + x) * 4 + 3]) {
      total++;
      if (x >= ox && x < ox + width && y >= oy && y < oy + height) kept++;
    }
  }
  // What the old canvas cut off (an operation hanging over an edge, a layer moved past one) would show in a new
  // margin, so the list that drew it ends by clearing everything outside the part of the new canvas it could reach.
  // Frame operations draw before the layers and each layer draws on a canvas of its own, so each list clears for
  // itself, and only a list that was cut. A render names up to sixteen places that were cut, so a recipe with more is
  // asked frame by frame (what a frame continues changes nothing that is cut), and in a frame with more than that any
  // list may have been. A replace is never cut, since it reaches every pixel of its canvas: the margins too.
  const { animations, sheet, ...single } = recipe;
  // The places cut in one frame, as paths within it (ops[2], layers[0], layers[1].ops[0]), or null for any.
  const cutIn = ({ from, ...frame }, index) => {
    const whole = !project.clippingOmitted || recipe.frames.length === 1, made = whole ? project : renderProject({ ...single, frames: [frame] });
    const under = `project.frames[${whole ? index : 0}].`;
    return made.clippingOmitted ? null : (made.clipping ?? []).filter(entry => entry.path.startsWith(under)).map(entry => entry.path.slice(under.length));
  };
  const overhangs = (cut, list, ops) => ops.some(op => op.op === 'replace')
    || (ops.length > 0 && (!cut || cut.some(at => at.startsWith(list) && (at.length === list.length || '.['.includes(at[list.length])))));
  // Clears for the new canvas outside columns x0 to x1 and rows y0 to y1 (ends excluded), none over another.
  const between = (value, low, high) => Math.max(low, Math.min(high, value));
  const outside = (x0, x1, y0, y1) => {
    x0 = between(x0, 0, width); x1 = between(x1, x0, width); y0 = between(y0, 0, height); y1 = between(y1, y0, height);
    return [
      x1 > x0 && y0 > 0 && { op: 'clear', x: x0, y: 0, w: x1 - x0, h: y0 },
      x1 > x0 && y1 < height && { op: 'clear', x: x0, y: y1, w: x1 - x0, h: height - y1 },
      x0 > 0 && { op: 'clear', x: 0, y: 0, w: x0, h: height },
      x1 < width && { op: 'clear', x: x1, y: 0, w: width - x1, h: height }
    ].filter(Boolean);
  };
  // Frame operations clear the background with the rest, so a visible one is painted back: once a pixel (it may be
  // partly clear), and in its own colour whatever the frame's palette says.
  const background = parseColor(recipe.background ?? 'transparent', project.palette), margins = outside(dx, dx + oldWidth, dy, dy + oldHeight);
  if (background[3]) margins.push(...margins.map(clear => ({ ...clear, op: 'rect', color: `#${background.map(value => value.toString(16).padStart(2, '0')).join('')}` })));
  const point = ([x, y]) => [x + dx, y + dy], canvas = { width, height, symbols: recipe.symbols };
  const frames = recipe.frames.map((frame, index) => {
    const p = `frames[${index}]`;
    // A frame moved after it is drawn brings in what lay beside the window, which the new canvas never drew.
    for (const key of ['flipX', 'flipY', 'wrap', 'tile', 'translate']) {
      if (key === 'translate' ? frame.translate?.some(Boolean) : frame[key]) fail(path, `${p}.${key} is tied to the canvas size, so this recipe cannot move to another one; change the size in its source instead`);
    }
    const ops = moveOps(frame.ops ?? [], dx, dy, `${p}.ops`, path, canvas);
    // A layer is drawn on a canvas of its own, cut by it, then moved by the layer's x and y and cut by the frame.
    // Here its operations take that move as well, so its canvas is the new one, and what either cut took is cleared.
    const moved = (frame.layers ?? []).map(({ x = 0, y = 0, sort, ops: list = [] }, li) => moveOps(list, dx + x, dy + y, `${p}.layers[${li}].ops`, path, sort ? null : canvas));
    const beyond = (frame.layers ?? []).map(({ x = 0, y = 0 }) => outside(dx + Math.max(0, x), dx + oldWidth + Math.min(0, x), dy + Math.max(0, y), dy + oldHeight + Math.min(0, y)));
    const cut = margins.length || beyond.some(clears => clears.length) ? cutIn(frame, index) : [];
    if (margins.length && overhangs(cut, 'ops', frame.ops ?? [])) ops.push(...margins);
    const layers = frame.layers?.map(({ x, y, ...layer }, li) => {
      if (beyond[li].length && overhangs(cut, `layers[${li}]`, layer.ops ?? [])) {
        // A sorted layer takes only what stands on the ground, and nothing that stands there erases.
        if (layer.sort) fail(path, `${p}.layers[${li}] is sorted by ground and draws past the canvas where the new one has a margin, which a sorted layer cannot clear, so this recipe cannot move to that canvas size; change the size in its source instead`);
        moved[li].push(...beyond[li]);
      }
      return { ...layer, ...((layer.ops || moved[li].length > 0) && { ops: moved[li] }) };
    });
    return {
      ...frame,
      ...(frame.anchor && { anchor: point(frame.anchor) }),
      ...(frame.points && { points: Object.fromEntries(Object.entries(frame.points).map(([name, at]) => [name, point(at)])) }),
      ...((frame.ops || ops.length > 0) && { ops }),
      ...(layers && { layers }),
      // Corrections are single canvas pixels, and one outside the canvas is an error, so those cut off are left out.
      ...(frame.pixels && { pixels: frame.pixels.map(pixel => ({ ...pixel, x: pixel.x + dx, y: pixel.y + dy })).filter(pixel => pixel.x >= 0 && pixel.y >= 0 && pixel.x < width && pixel.y < height) })
    };
  });
  return {
    recipe: { ...recipe, width, height, ...(recipe.anchor && { anchor: point(recipe.anchor) }), frames },
    resized: { from: [oldWidth, oldHeight], offset: [ox, oy], cut: total === kept ? 0 : Math.max(0.001, Math.round((total - kept) / total * 1000) / 1000) }
  };
}

// What a reply says about a resize: nothing when the whole drawing is kept.
export function resizeWarning({ from, cut }, [width, height]) {
  if (!cut) return null;
  const share = cut < 0.01 ? 'under 1%' : `${Math.round(cut * 100)}%`;
  return `The ${width}×${height} canvas leaves out ${share} of what the ${from[0]}×${from[1]} drawing draws (cut, not scaled): look at it before delivering, and say so if it shows.`;
}

// The empty margins a larger canvas puts round the drawing's own canvas, by side, or null when there are none: what a
// reply says of a 16×32 flame asked for at 32×32, which fills half of what was asked.
export function resizeMargins({ from, offset }, [width, height]) {
  const sides = { left: -offset[0], right: offset[0] + width - from[0], top: -offset[1], bottom: offset[1] + height - from[1] };
  const margins = Object.fromEntries(Object.entries(sides).filter(([, pixels]) => pixels > 0));
  return Object.keys(margins).length ? margins : null;
}

// A recipe whose animations play at most `count` frames: of an animation that lists more, evenly spaced ones are kept
// and the rest removed. A loop keeps frame floor(i × F / count), so the step across its seam is as even as the others;
// a one-shot or a pingpong keeps its first and last, where a one-shot's last is the last that draws anything, so an
// effect that fades to nothing keeps a picture in every frame. A kept frame lasts as long as the frames it stands
// for, so the animation plays as long as before. Returns { recipe, kept: { <animation>: "8 of 19" }, notes }.
export function keepFrames(recipe, count, path = 'frames') {
  if (!Number.isInteger(count) || count < 1 || count > 256) fail(path, 'expected how many frames each animation keeps, a whole number from 1 to 256');
  const project = renderProject(recipe), names = recipe.frames.map(frame => frame.name), index = new Map(names.map((name, i) => [name, i]));
  const animations = recipe.animations ?? { default: { frames: names } }, kept = {}, next = {}, wanted = new Map(), dropped = new Set();
  const draws = frame => { const { data } = project.frames[frame]; for (let i = 3; i < data.length; i += 4) if (data[i]) return true; return false; };
  for (const [key, animation] of Object.entries(animations)) {
    const listed = animation.frames.map(name => index.get(name)), F = listed.length, pingpong = animation.direction === 'pingpong';
    // A pingpong plays its inner frames twice: 2 × listed − 2 frames.
    const N = pingpong ? Math.max(2, Math.floor((count + 2) / 2)) : count, ends = pingpong || animation.loop === false;
    let last = F - 1;
    if (!pingpong) while (last >= N && !draws(listed[last])) last--;
    const picks = F <= N ? listed.map((_, i) => i) : Array.from({ length: N }, (_, i) => ends ? (N === 1 ? 0 : Math.round(i * last / (N - 1))) : Math.floor(i * F / N));
    picks.forEach((at, i) => {
      const frame = listed[at], lasts = listed.slice(at, picks[i + 1] ?? F).reduce((sum, each) => sum + project.frames[each].duration, 0);
      wanted.set(frame, (wanted.get(frame) ?? new Set()).add(lasts));
    });
    next[key] = { ...animation, frames: picks.map(at => names[listed[at]]) };
    if (F > N) { kept[key] = `${N} of ${F}`; for (const frame of listed) dropped.add(frame); }
  }
  if (!Object.keys(kept).length) return { recipe, kept, notes: [`Every animation already plays ${count} frame${count === 1 ? '' : 's'} or fewer, so none was removed.`] };
  // A frame still played, or one a remaining frame is drawn from (`from`, a copy), stays.
  const stays = new Set(wanted.keys()), sources = frame => [frame.from, ...[...(frame.ops ?? []), ...(frame.layers ?? []).flatMap(layer => layer.ops ?? [])].filter(op => op.op === 'copy').map(op => op.from)].filter(name => index.has(name)).map(name => index.get(name));
  for (let i = recipe.frames.length - 1; i >= 0; i--) if (stays.has(i) || !dropped.has(i)) for (const source of sources(recipe.frames[i])) stays.add(source);
  const remains = (_, i) => stays.has(i) || !dropped.has(i), notes = [];
  // A duration is the frame's own: one played at two lengths keeps the length it had.
  const frames = recipe.frames.map((frame, i) => {
    const lasts = wanted.get(i);
    if (!lasts || (lasts.size === 1 && lasts.has(project.frames[i].duration))) return frame;
    if (lasts.size > 1) { notes.push(`Frame "${frame.name}" is played more than once, so it keeps its ${project.frames[i].duration} ms and its animations no longer play exactly as long as before.`); return frame; }
    return { ...frame, duration: [...lasts][0] };
  }).filter(remains);
  // Frames kept only to draw others from are no longer played, so the animation that played every frame is spelled out.
  const explicit = recipe.animations !== undefined || frames.length > next.default.frames.length;
  return { recipe: { ...recipe, frames, ...(explicit && { animations: next }) }, kept, notes };
}

// A recipe that keeps only the animations named, and the frames they play or are drawn from: one spell out of a
// preset that holds thirteen. Returns { recipe, dropped } (the animations left out).
export function keepAnimations(recipe, names, path = 'animation') {
  const wanted = (Array.isArray(names) ? names : [names]).filter(name => typeof name === 'string' && name);
  const has = Object.keys(recipe.animations ?? {});
  if (!wanted.length) fail(path, 'expected the name of an animation to keep');
  for (const name of wanted) if (!has.includes(name)) fail(path, `no animation ${JSON.stringify(name)}; this one has ${has.length ? has.join(', ') : 'only its frames in order, with no named animation'}`);
  const index = new Map(recipe.frames.map((frame, i) => [frame.name, i])), stays = new Set(wanted.flatMap(name => recipe.animations[name].frames.map(frame => index.get(frame))));
  const sources = frame => [frame.from, ...[...(frame.ops ?? []), ...(frame.layers ?? []).flatMap(layer => layer.ops ?? [])].filter(op => op.op === 'copy').map(op => op.from)].filter(name => index.has(name)).map(name => index.get(name));
  for (let i = recipe.frames.length - 1; i >= 0; i--) if (stays.has(i)) for (const source of sources(recipe.frames[i])) stays.add(source);
  return { recipe: { ...recipe, frames: recipe.frames.filter((_, i) => stays.has(i)), animations: Object.fromEntries(wanted.map(name => [name, recipe.animations[name]])) }, dropped: has.filter(name => !wanted.includes(name)) };
}
