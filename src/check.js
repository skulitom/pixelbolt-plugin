// What a render delivered, and how it differs from what the user asked for (`expect`). Each problem names the file
// and the call that fixes it, so an agent can correct an export before handing it on. Read-only: it never changes
// the bundle.
import { PixelError, renderProject, STILL_SIDE } from './core.js';
import { autotileFrames } from './autotile.js';

// The format's limits, as core.js enforces them, so no fix asks for a recipe the renderer refuses: canvas sides,
// sheet.scale, source frames, their total area, and the names one animation lists. A pingpong of n names (n > 2)
// plays 2n - 2 frames, so an animation plays at most 2,046.
const CANVAS = 256, SCALE = 16, SOURCE_FRAMES = 256, FRAME_AREA = 4194304, ATLAS = 16777216, NAMES = 1024, PLAYED = 2 * NAMES - 2;
// The pixels one export's APNG animations hold (export.js), and all of one render's GIFs (mcp.js, gif.js).
const EXPORT_PIXELS = 67108864, GIF_PIXELS = 67108864;
const LIMITS = { width: CANVAS * SCALE, height: CANVAS * SCALE, frames: PLAYED, colors: 65536, gifScale: SCALE };

export function readExpect(expect) {
  if (expect === undefined) return undefined;
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) throw new PixelError('expect', 'expected an object such as { "width": 32, "height": 32, "frames": 8 }');
  for (const [key, value] of Object.entries(expect)) {
    if (key === 'transparent' || key === 'loop') { if (typeof value !== 'boolean') throw new PixelError(`expect.${key}`, 'expected true or false'); continue; }
    if (!Object.hasOwn(LIMITS, key)) throw new PixelError(`expect.${key}`, 'unknown field; use width, height, frames, colors, transparent, loop or gifScale');
    if (!Number.isInteger(value) || value < 1 || value > LIMITS[key]) throw new PixelError(`expect.${key}`, `expected a whole number from 1 to ${LIMITS[key]}`);
  }
  return expect;
}

const gifFiles = gifs => gifs.map(gif => `gifs/${gif.animation}.gif`).slice(0, 8).join(', ');
const list = (names, limit = 8) => names.slice(0, limit).map(name => JSON.stringify(name)).join(', ') + (names.length > limit ? ` and ${names.length - limit} more` : '');
// The whole number k with canvas * k = asked on every given side, if there is one.
const wholeScale = (pairs, max) => {
  const scales = pairs.filter(([asked]) => asked !== undefined).map(([asked, canvas]) => asked / canvas);
  return scales.length && scales.every(k => k === scales[0] && Number.isInteger(k) && k >= 1 && k <= max) ? scales[0] : null;
};

// Why the exporter would refuse this project at canvas w x h and sheet.scale k, or null: the frames' total area, the
// animations' pixels and the atlas. A trimmed atlas packs each frame's visible bounds, so the change is rendered
// (with the current drawing) to measure it; an untrimmed one is a grid.
function exportBudget({ frames, animations, sheet }, w, h, k, recipe) {
  if (w * h * frames.length > FRAME_AREA) return `${frames.length} frames of ${w}x${h} pass the limit of 4,194,304 pixels of frames`;
  const played = Object.values(animations).reduce((sum, item) => sum + item.frames.length, 0);
  if (played * w * h * k * k > EXPORT_PIXELS) return `${played} played frames at ${w * k}x${h * k} pass the 67,108,864 animation pixels an export holds`;
  if (sheet.trim && recipe !== undefined) {
    try { renderProject({ ...recipe, width: w, height: h, sheet: { ...recipe.sheet, scale: k } }); }
    catch (error) { return error.path === 'project.sheet' ? `an atlas of ${frames.length} trimmed frames at sheet.scale ${k} passes 16,777,216 pixels` : `sheet.scale ${k} is refused (${error.message})`; }
  } else if (sheet.columns * (w + sheet.padding * 2) * k * Math.ceil(frames.length / sheet.columns) * (h + sheet.padding * 2) * k > ATLAS) return `an atlas of ${frames.length} frames at ${w * k}x${h * k} passes 16,777,216 pixels`;
  return null;
}
const tooBig = (reason, sheet) => `${reason}: ask for fewer frames or a smaller size${reason.includes('an atlas') && !sheet.trim ? ', or set sheet.trim if the frames have empty margins' : ''}`;

// A size with a side over 256 px is a smaller canvas exported at a whole sheet.scale. Offers the canvas nearest the
// current one (the least redrawing) and, when it differs, the one with the most detail. A still (one frame) may also
// be the asked size itself, drawn at one screen pixel per art pixel; that is offered after the enlargements, or alone
// when no whole scale makes the size.
function largeSizeFix(expect, project, recipe) {
  const { width, height, frames, sheet } = project;
  const asked = expect.width !== undefined && expect.height !== undefined ? `${expect.width}x${expect.height}` : expect.width !== undefined ? `a width of ${expect.width}` : `a height of ${expect.height}`;
  const still = (() => {
    if (frames.length !== 1) return null;
    const w = expect.width ?? width * sheet.scale, h = expect.height ?? height * sheet.scale;
    if (w > STILL_SIDE || h > STILL_SIDE || w * h > FRAME_AREA || exportBudget(project, w, h, 1, recipe)) return null;
    const changes = [...(w !== width ? [{ set: 'width', value: w }] : []), ...(h !== height ? [{ set: 'height', value: h }] : []), ...(sheet.scale !== 1 ? [{ set: 'sheet.scale', value: 1 }] : [])];
    return `a ${w}x${h} still at sheet.scale 1, one screen pixel per art pixel: pixel_patch ${JSON.stringify(changes)}`;
  })();
  const tooLarge = `${asked} is more than a still holds at one screen pixel per art pixel (${STILL_SIDE} px a side, 4,194,304 pixels)`;
  const stillOnly = `no whole sheet.scale makes ${asked} from this canvas, but a still may be up to ${STILL_SIDE} px a side, so make it ${still}, fit the drawing to the new canvas, pixel_inspect, then render again`;
  const candidates = [];
  for (let k = 2; k <= SCALE; k++) {
    const w = expect.width === undefined ? width : expect.width / k, h = expect.height === undefined ? height : expect.height / k;
    if (Number.isInteger(w) && Number.isInteger(h) && w <= CANVAS && h <= CANVAS) candidates.push({ k, w, h, distance: Math.abs(w - width) + Math.abs(h - height) });
  }
  // Budgets are checked only for the candidates offered (a trimmed sheet is rendered to measure), nearest first.
  let refused = null;
  const verdicts = new Map(), passes = fit => {
    if (!verdicts.has(fit)) { const over = exportBudget(project, fit.w, fit.h, fit.k, recipe); if (over && refused === null) refused = over; verdicts.set(fit, !over); }
    return verdicts.get(fit);
  };
  const nearest = [...candidates].sort((a, b) => a.distance - b.distance || a.k - b.k).find(passes), detailed = nearest && candidates.find(passes);
  if (!nearest && still) return stillOnly;
  if (!nearest && refused) return tooBig(`at every whole scale that makes ${asked}, ${refused}`, sheet);
  if (!nearest) {
    const k = Math.min(SCALE, Math.ceil(Math.max(expect.width ?? 0, expect.height ?? 0) / CANVAS)), side = (value, canvas) => value === undefined ? canvas : Math.min(CANVAS, Math.max(1, Math.round(value / k)));
    const w = side(expect.width, width), h = side(expect.height, height), over = exportBudget(project, w, h, k, recipe);
    const head = frames.length === 1 ? `${tooLarge}, sheet.scale stops at ${SCALE}, and no whole scale exports ${asked} exactly from this canvas` : `canvases stop at ${CANVAS} px a side and sheet.scale at ${SCALE}, and no whole scale exports ${asked} exactly from ${frames.length} frames`;
    return over ? `${head}, and the nearest size, ${w * k}x${h * k}, is refused too (${over}): tell the user, and ask for fewer frames or a smaller size`
      : `${head}: tell the user, and offer ${w * k}x${h * k} (a ${w}x${h} canvas at sheet.scale ${k}) instead`;
  }
  const changes = fit => JSON.stringify([...(expect.width !== undefined ? [{ set: 'width', value: fit.w }] : []), ...(expect.height !== undefined ? [{ set: 'height', value: fit.h }] : []), recipe !== undefined && recipe.sheet === undefined ? { set: 'sheet', value: { scale: fit.k } } : { set: 'sheet.scale', value: fit.k }]);
  const alternative = nearest === detailed ? '' : ` (or ${changes(detailed)}, a ${detailed.w}x${detailed.h} canvas at sheet.scale ${detailed.k}, for the most detail)`;
  if (still) return `${asked} is a ${nearest.w}x${nearest.h} canvas at sheet.scale ${nearest.k}, the nearest to the current ${width}x${height}: pixel_patch ${changes(nearest)}${alternative}; or, since this is a still, ${still}. Either way, fit the drawing to the new canvas, pixel_inspect, then render again`;
  return `${frames.length === 1 ? tooLarge : `canvases stop at ${CANVAS} px a side`}, so ${asked} is a ${nearest.w}x${nearest.h} canvas at sheet.scale ${nearest.k}, the nearest to the current ${width}x${height}: pixel_patch ${changes(nearest)}${alternative}, fit the drawing to the new canvas, pixel_inspect, then render again`;
}

// What leaves see-through pixels after the background is drawn, in the named frames or the earlier frames they copy
// (`from`): frame-level clear and erasing dither, translate without wrap, and pixel corrections in a colour that is
// not opaque (corrections replace the RGBA after everything else). Layer clears erase only their own layer, so they
// don't count. Returns frame name -> kinds.
function erasers(recipe, names) {
  const frames = Array.isArray(recipe?.frames) ? recipe.frames : [], byName = new Map(frames.map(frame => [frame?.name, frame])), found = new Map();
  for (const start of names) for (let frame = byName.get(start), hops = 0; frame && hops <= frames.length; frame = byName.get(frame.from), hops++) {
    const kinds = [];
    for (const op of Array.isArray(frame.ops) ? frame.ops : []) {
      if (op?.op === 'clear') kinds.push('clear');
      else if (op?.op === 'dither' && op.erase === true) kinds.push('dither with erase');
      else if ((op?.op === 'fill' && colorAlpha(recipe, op.color, frame) < 255) || (op?.op === 'replace' && colorAlpha(recipe, op.to, frame) < 255)) kinds.push(`${op.op} to a see-through colour`);
      else if (op?.op === 'rewrite' && op.empty !== undefined) kinds.push('rewrite with empty');
    }
    if (Array.isArray(frame.translate) && frame.translate.some(Boolean) && frame.wrap !== true) kinds.push('translate');
    const alphas = Array.isArray(frame.pixels) ? frame.pixels.map(pixel => colorAlpha(recipe, pixel?.color, frame)) : [];
    if (alphas.includes(0)) kinds.push('"transparent" pixels');
    if (alphas.some(alpha => alpha > 0 && alpha < 255)) kinds.push('partly transparent pixels');
    if (kinds.length) found.set(frame.name, [...new Set([...(found.get(frame.name) ?? []), ...kinds])]);
  }
  return found;
}

// A colour's alpha as the recipe gives it (a frame palette, then the project palette, then hex): 0 for transparent,
// 255 when it can't tell.
function colorAlpha(recipe, color, frame) {
  const fromPalette = value => typeof recipe?.palette?.[value] === 'string' ? recipe.palette[value] : value;
  const value = typeof frame?.palette?.[color] === 'string' ? fromPalette(frame.palette[color]) : fromPalette(color);
  if (value === 'transparent') return 0;
  const hex = typeof value === 'string' ? /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1] : undefined;
  return hex?.length === 4 ? parseInt(hex[3] + hex[3], 16) : hex?.length === 8 ? parseInt(hex.slice(6), 16) : 255;
}
const backgroundAlpha = recipe => colorAlpha(recipe, recipe?.background ?? 'transparent');

// Which of the frames stay see-through over an opaque background: the recipe is rendered with one, so every op that
// replaces alpha counts (clear, fill, replace, rewrite, dither, translate, pixel corrections). Null if it can't tell.
function stillSeeThrough(recipe, holes) {
  if (recipe === undefined || recipe === null || typeof recipe !== 'object') return null;
  try {
    const wanted = new Set(holes), seeThrough = data => { for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true; return false; };
    return renderProject({ ...recipe, background: '#000000' }).frames.filter(frame => wanted.has(frame.name) && seeThrough(frame.data)).map(frame => frame.name);
  } catch { return null; }
}

function opaqueFix(recipe, holes) {
  const opaque = backgroundAlpha(recipe) === 255, still = opaque ? holes : stillSeeThrough(recipe, holes) ?? holes;
  const found = erasers(recipe, still), culprits = [...found.keys()], kinds = [...new Set([...found.values()].flat())];
  // Name what the scan found; otherwise the frames, and the ops that can do it.
  const what = culprits.length ? `${kinds.join(', ')} in ${list(culprits)}` : `drawing in ${list(still)}: a clear, a fill, replace or rewrite to a see-through colour, a translate or a pixel correction; pixel_inspect with grid: true shows the cells as "."`;
  if (opaque) return `the background is already opaque, but frame drawing erases it (${what}): remove those or paint over what they clear, then render again`;
  return `pixel_patch { "set": "background", "value": "<palette key>" }${backgroundAlpha(recipe) > 0 ? ' (an opaque one: the current background is see-through)' : ''}${still.length ? `, and remove or paint over what erases it (${what})` : ''}, then render again`;
}

// How to make one animation play `want` frames within the limits: source frames, names per list, pingpong's 2n - 2,
// and the export's budgets (the animations' pixels; for new source frames, their area and the atlas too).
function framesFix(key, want, named, direction, project, recipe, total) {
  const { width, height, sheet, animations } = project, s = sheet.scale;
  const pingpong = want % 2 === 0 && want >= 4 ? want / 2 + 1 : null;
  if (want > NAMES && pingpong === null) return `no animation plays ${want} frames: one lists at most ${NAMES} names, and a pingpong of n names plays 2n-2, an even number up to ${PLAYED}; tell the user, or play ${want - 1} or ${want + 1}`;
  const played = total - animations[key].frames.length + want;
  if (played * width * height * s * s > EXPORT_PIXELS) return tooBig(`${want} frames in "${key}" make ${played} played frames at ${width * s}x${height * s}, past the 67,108,864 animation pixels an export holds`, { trim: true });
  if (!named) {
    const head = 'the recipe has no animations field, so every frame plays once in order';
    const cap = want > SOURCE_FRAMES ? `a recipe holds at most ${SOURCE_FRAMES} frames` : exportBudget({ ...project, frames: { length: want }, animations: {}, sheet: { ...sheet, trim: false, columns: recipe?.sheet?.columns ?? Math.min(want, 8) } }, width, height, s);
    if (!cap) return `${head}: add or remove frames (pixel_patch insert or remove under frames) until there are ${want}, or add an animation that lists ${want} frame names (a name may repeat)`;
    return want <= NAMES
      ? `${head}, and ${cap}: add an animation that lists ${want} frame names in play order (a name may repeat), pixel_patch set "animations" to { "${key}": { "frames": [${want} names] } }, then render again`
      : `${head}, and ${cap}: add a pingpong animation of ${pingpong} frame names, which plays ${want}: pixel_patch set "animations" to { "${key}": { "frames": [${pingpong} names], "direction": "pingpong" } }, then render again`;
  }
  if (direction === 'pingpong') {
    const options = [...(pingpong !== null ? [`list ${pingpong} names in animations.${key}.frames`] : []), ...(want <= NAMES ? [`set animations.${key}.direction to "forward" and list ${want} names`] : [])];
    return `"${key}" is pingpong, which plays 2n-2 frames for n names: ${options.join(', or ')}`;
  }
  return want <= NAMES
    ? `make "${key}" play ${want} frames: list ${want} names in animations.${key}.frames (a name may repeat; pixel_patch insert under frames only for new drawings), then render again`
    : `one animation lists at most ${NAMES} names: set animations.${key}.direction to "pingpong" and list ${pingpong} names, which play ${want}`;
}

// Motion: the silhouettes of loops that look wrong in play: a body that leaves its ground row, frames that hop
// unevenly or jump at the loop, and frames that hold on (nearly) the same picture. Advisory only, since a hop, a
// flicker or a puff may move that way on purpose: it adds notes and never a problem. One-shots (bursts that grow
// and fade, fluids that settle) and scattered particles change unevenly by design, so only loops are judged, and
// the ground and steps only where every frame is a body: its drawn pixels cover at least SOLID of its box. A recipe
// without animations (an icon or item sheet) plays its frames as one loop only by default, so it gets no notes.
// The outline of a spell, a flame or a splash wanders by a few pixels every frame while its compiler keeps the loop
// seamless, so a loop is judged by its whole silhouette and by its largest body, and a lift, uneven or join note
// needs both; an uneven step or a jump at the loop must also redraw REDRAW times the pixels of a usual step, and a
// tall body's lowest row may wobble a row for every WOBBLE rows of its height.
const MOTION_ENTRIES = 64, MOTION_NOTES = 8, MOTION_PAIRS = 6, SOLID = 0.4, REDRAW = 1.5, WOBBLE = 12;
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const largestStep = steps => steps.reduce((most, item) => Math.max(most, item.step), 0);
const series = (items, limit) => items.length > limit ? `${items.slice(0, limit).join(', ')} and ${items.length - limit} more` : items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];

// Whether two source frames hold the same pixels (fully transparent pixels are equal whatever their colour): each
// frame is hashed once, and compared in full only with earlier frames of the same hash.
function samePixels(frames) {
  const kinds = new Map(), buckets = new Map();
  const equal = (a, b) => { for (let i = 0; i < a.length; i += 4) if ((a[i + 3] || b[i + 3]) && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3])) return false; return true; };
  const kind = index => {
    if (kinds.has(index)) return kinds.get(index);
    const { data } = frames[index];
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) hash = Math.imul(hash ^ (data[i + 3] && (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24)), 16777619);
    const bucket = buckets.get(hash) ?? [], match = bucket.find(other => equal(frames[other].data, data)) ?? index;
    if (match === index) buckets.set(hash, [...bucket, index]);
    kinds.set(index, match); return match;
  };
  return (a, b) => kind(a) === kind(b);
}

// The box of a frame's largest body, its largest group of drawn pixels touching side or corner, with that group's
// pixel count: [x, y, w, h, count], or null for an empty frame.
function largestBody({ data }, width, height) {
  const size = width * height, seen = new Uint8Array(size), stack = new Int32Array(size);
  let best = null;
  for (let start = 0; start < size; start++) {
    if (seen[start] || !data[start * 4 + 3]) continue;
    let top = 0, count = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
    seen[start] = 1; stack[top++] = start;
    while (top) {
      const c = stack[--top], x = c % width, y = (c - x) / width;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, n = Y * width + X;
        if ((dx || dy) && X >= 0 && Y >= 0 && X < width && Y < height && !seen[n] && data[n * 4 + 3]) { seen[n] = 1; stack[top++] = n; }
      }
    }
    if (!best || count > best[4]) best = [x0, y0, x1 - x0 + 1, y1 - y0 + 1, count];
  }
  return best;
}

// What one loop's boxes say: its steps between neighbouring played frames (and the wrap from the last back to the
// first), whether every frame is a body (its pixels, count(i), cover at least SOLID of its box), and whether it leaves
// its ground row, steps unevenly or jumps at the wrap. A pair that shows one source frame twice is a hold on purpose
// (an attack hold, a pingpong turn), and an empty frame has no outline.
function judgeLoop(box, count, order) {
  const lowest = box.map(item => item && item[1] + item[3] - 1), steps = [];
  for (let i = 0; i < order.length; i++) {
    const j = (i + 1) % order.length, a = box[i], b = box[j];
    if (!a || !b || order[i] === order[j]) continue;
    const step = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[0] + a[2] - b[0] - b[2]), Math.abs(a[1] + a[3] - b[1] - b[3]));
    steps.push({ from: i, to: j, wrap: j === 0, step, sources: [order[i], order[j]].sort((x, y) => x - y).join() });
  }
  const inner = steps.filter(item => !item.wrap), wrap = steps.find(item => item.wrap), most = largestStep(inner);
  const solid = box.every((item, i) => !item || count(i) >= SOLID * item[2] * item[3]);
  // The ground is the lowest row at least half the frames stand on (on a tie, the one lower on screen). A body whose
  // frames leave it by 2 rows or more lifts or sinks; a wobble of one row, or no common row at all (a projectile, a
  // swirl), is left alone.
  const rows = lowest.filter(row => row !== null), counts = new Map();
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1);
  const [ground, standing] = [...counts].reduce((best, entry) => (entry[1] > best[1] || (entry[1] === best[1] && entry[0] > best[0]) ? entry : best), [null, 0]);
  const heights = box.filter(Boolean).map(item => item[3]), wobble = heights.length ? Math.max(1, Math.floor(median(heights) / WOBBLE)) : 1;
  const away = lowest.reduce((far, row, i) => (row !== null && Math.abs(row - ground) > (far === null ? wobble : Math.abs(lowest[far] - ground)) ? i : far), null);
  const lifts = solid && rows.length > 0 && standing * 2 >= rows.length && away !== null;
  const typical = inner.length ? median(steps.map(item => item.step)) : 0, uneven = solid && inner.length > 0 && most >= 3 && most >= 2 * typical;
  // A pingpong's wrap plays its first step backwards (the turn), which the uneven note already weighs.
  const turn = wrap !== undefined && inner.some(item => item.sources === wrap.sources);
  const within = inner.length ? median(inner.map(item => item.step)) : 0, joins = solid && wrap !== undefined && !turn && inner.length > 0 && wrap.step >= 3 && wrap.step >= 2 * within;
  return { lowest, steps, inner, wrap, most, rows, ground, standing, away, lifts, typical, uneven, within, joins };
}

// The pixels two frames differ in (fully transparent pixels are equal whatever their colour).
function redrawnPixels(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if ((a[i + 3] || b[i + 3]) && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3])) n++;
  return n;
}

// boxes: frame -> silhouette, and drawn: frame -> its count of pixels with alpha > 0, both from the scan in
// checkDelivery, so each source frame is measured once. recipe: whether it names its animations and sets loop.
// A single body judges the same by its silhouette and by its largest body, while sparks, embers or drops breaking off
// a spell, a flame or a splash move the silhouette without the body making that move (see REDRAW and WOBBLE).
function reviewMotion(project, names, boxes, drawn, recipe) {
  const motion = {}, notes = [], same = samePixels(project.frames), named = recipe?.animations !== undefined, bodies = new Map();
  const bodyOf = frame => { if (!bodies.has(frame)) bodies.set(frame, largestBody(frame, project.width, project.height)); return bodies.get(frame); };
  for (const key of names) {
    const { frames: order, loop } = project.animations[key];
    if (order.length < 2) continue;
    const box = order.map(index => boxes.get(project.frames[index])), lowest = box.map(item => item && item[1] + item[3] - 1);
    motion[key] = { box: box.slice(0, MOTION_ENTRIES), lowest: lowest.slice(0, MOTION_ENTRIES), ...(order.length > MOTION_ENTRIES && { omitted: order.length - MOTION_ENTRIES }) };
    if (!named || !loop) continue;
    const label = i => JSON.stringify(project.frames[order[i]].name), own = [];
    const whole = judgeLoop(box, i => drawn.get(project.frames[order[i]]), order), { steps, inner, wrap, most, rows, ground, standing, away, typical, within } = whole;
    const core = order.map(index => bodyOf(project.frames[index])), body = judgeLoop(core, i => core[i][4], order);
    // Pingpong plays a pair both ways; it is named once.
    const once = list => { const seen = new Set(); return list.filter(item => !seen.has(item.sources) && seen.add(item.sources)); };
    // A loop by default may be a one-shot whose recipe leaves out loop: false; a jump or a fast strike is then intended. It goes on the animation's first lift, uneven or join note.
    let hint = recipe.animations[key]?.loop === undefined ? ` If it should play once, set animations.${key}.loop to false.` : '';
    if (whole.lifts && body.lifts) own.push(`"${key}" loops, but its lowest visible row leaves row ${ground} (where ${standing} of its ${rows.length}${rows.length === order.length ? '' : ' drawn'} frames stand) for row ${lowest[away]}${lowest[away] > ground ? ' below it' : ''} (${label(away)}): a body that stands on the ground should keep its lowest row on one row in every frame (squash it onto that row rather than lifting or sinking it). A hop, a jump, a run's flight frames or something that floats may leave the ground on purpose.`);
    if (own.length) { own[0] += hint; hint = ''; }
    // How many pixels each step redraws, against the median step: a hand-drawn hop or a jump back to the start redraws
    // much more than its neighbours, a boiling projectile about as much in every frame.
    const redrawn = new Map(), redraw = item => { if (!redrawn.has(item)) redrawn.set(item, redrawnPixels(project.frames[order[item.from]].data, project.frames[order[item.to]].data)); return redrawn.get(item); };
    const stands = item => redraw(item) >= REDRAW * median(steps.map(redraw));
    const uneven = whole.uneven && body.uneven && inner.some(item => item.step === most && stands(item)), joins = whole.joins && body.joins && stands(wrap);
    if (uneven) {
      const top = once(inner.filter(item => item.step === most)).map(item => `from ${label(item.from)} to ${label(item.to)}`);
      own.push(`"${key}" moves unevenly: ${series(top, 3)} the silhouette moves ${most} px, while the median step is ${typical} px. Space the frames so each step changes the silhouette by a similar amount, or add in-between frames.${hint}`);
      hint = '';
    }
    if (joins) own.push(`"${key}" jumps when it loops: from ${label(wrap.from)} back to ${label(wrap.to)} the silhouette moves ${wrap.step} px, while the median step is ${within} px. Make the last frame lead into the first.${hint}`);
    // Pixel-identical frames share a silhouette, so only neighbours that don't move are compared. With another
    // duration, an identical frame changes the timing on purpose: a hold, like a repeated frame name.
    const identical = steps.filter(item => item.step === 0 && same(order[item.from], order[item.to]));
    const duration = i => project.frames[order[i]].duration, twins = once(identical.filter(item => duration(item.from) === duration(item.to)));
    if (twins.length) {
      // Runs of identical neighbours read as one hold: "a" = "b" = "c".
      const runs = [];
      for (const item of twins) {
        const last = runs.at(-1);
        if (last?.to === item.from) { last.names.push(label(item.to)); last.to = item.to; } else runs.push({ to: item.to, names: [label(item.from), label(item.to)] });
      }
      own.push(runs.length === 1 && runs[0].names.length === 2 ? `"${key}": ${runs[0].names.join(' and ')} are identical; drop one (and add its duration to the other) or change it.`
        : `"${key}" has identical neighbouring frames: ${series(runs.map(run => run.names.join(' = ')), MOTION_PAIRS)}; keep one of each (with their durations added up) or change the others.`);
    }
    // When the motion jumps somewhere, the steps that barely move are where it holds instead (identical frames are
    // named above or are holds).
    if (uneven || joins) {
      const biggest = largestStep(steps), small = Math.max(1, Math.floor(biggest / 4)), held = new Set(identical.map(item => item.sources));
      const still = once(steps.filter(item => item.step <= small && !held.has(item.sources)));
      if (still.length) {
        const moved = largestStep(still), pairs = still.map(item => `${label(item.from)} → ${label(item.to)}`);
        own.push(`In "${key}", ${series(pairs, MOTION_PAIRS)} ${still.length === 1 ? 'is' : 'are'} nearly the same (${moved ? `the silhouette moves at most ${moved} px` : 'the silhouette does not move'}) while another step moves ${biggest} px: the motion holds, then jumps.`);
      }
    }
    if (own.length && !notes.length) own[0] += ` pixel_inspect with view: "motion" and animation: "${key}" shows its frames in play order.`;
    notes.push(...own);
  }
  // Every animation is reviewed, so the cut is counted; the count is a note of its own, outside the cap.
  const cut = notes.length - MOTION_NOTES;
  return { motion: Object.keys(motion).length ? motion : undefined, notes: cut > 0 ? [...notes.slice(0, MOTION_NOTES), `${cut} more motion note${cut === 1 ? '' : 's'} not shown: pass animation to check one animation at a time.`] : notes };
}

// project: the rendered project; recipe: its source (for animation directions and whether it names animations);
// gifs: the animationGIF results written beside it, or undefined when the command writes no GIFs (the CLI's render);
// animation: check only that animation and its frames.
export function checkDelivery(project, { recipe, gifs, expect, animation } = {}) {
  const { name, width, height, sheet, animations } = project, scale = sheet.scale;
  if (animation !== undefined && !Object.hasOwn(animations, animation)) throw new PixelError('animation', `no animation named "${animation}"; choose one of: ${Object.keys(animations).join(', ')}`);
  const names = animation === undefined ? Object.keys(animations) : [animation];
  const frames = animation === undefined ? project.frames : [...new Set(animations[animation].frames)].sort((a, b) => a - b).map(index => project.frames[index]);
  // clear: frames with a fully transparent pixel; seeThrough: with a partly transparent one; solid: fully opaque.
  // boxes: each frame's silhouette [x, y, w, h] (alpha > 0), null when empty, and drawn: its pixels with alpha > 0,
  // for the motion review.
  const colors = new Set(), empty = [], clear = [], seeThrough = [], solid = [], boxes = new Map(), drawn = new Map();
  for (const frame of frames) {
    let transparent = 0, opaque = 0, left = width, right = -1, top = -1, bottom = -1;
    const { data } = frame, pixels = data.length >> 2;
    for (let y = 0, i = 0; y < height; y++) {
      let row = false;
      for (let x = 0; x < width; x++, i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) { transparent++; continue; }
        colors.add(((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | alpha) >>> 0); if (alpha === 255) opaque++;
        if (x < left) left = x;
        if (x > right) right = x;
        row = true;
      }
      if (row) { if (top < 0) top = y; bottom = y; }
    }
    if (transparent === pixels) empty.push(frame.name);
    if (transparent) clear.push(frame.name);
    if (transparent + opaque !== pixels) seeThrough.push(frame.name);
    if (opaque === pixels) solid.push(frame.name);
    boxes.set(frame, top < 0 ? null : [left, top, right - left + 1, bottom - top + 1]); drawn.set(frame, pixels - transparent);
  }
  // A tile set's inner tiles, with its terrain on all four sides, are solid by design: its background shows on the
  // tiles with an open side, so only those are judged for transparency. A corner set's empty tile draws nothing by
  // design.
  const tiles = Array.isArray(recipe?.frames) ? autotileFrames(recipe) : [], set = new Set(tiles.map(tile => tile.mask)).size > 1;
  const inner = new Set(set ? tiles.filter(tile => (tile.mode === 'blob' ? (tile.mask & 85) === 85 : tile.mask === 15)).map(tile => tile.frame) : []);
  const emptyTiles = new Set(set ? tiles.filter(tile => tile.mode === 'corner' && tile.mask === 0).map(tile => tile.frame) : []);
  const judged = frames.filter(frame => !inner.has(frame.name)), open = judged.length ? judged : frames, clearOpen = clear.filter(frameName => open.some(frame => frame.name === frameName));
  const played = Object.fromEntries(names.slice(0, 16).map(key => [key, { frames: animations[key].frames.length, loop: animations[key].loop }]));
  const delivered = {
    size: [width * scale, height * scale], ...(scale !== 1 && { canvas: [width, height], scale }),
    animations: played, ...(names.length > 16 && { animationsOmitted: names.length - 16 }),
    colors: colors.size, transparent: clearOpen.length === open.length ? true : clearOpen.length ? 'some frames' : false,
    ...(seeThrough.length && { partlyTransparent: seeThrough.length === frames.length ? true : 'some frames' }),
    ...(gifs?.length && { gifs: [gifs[0].width, gifs[0].height] })
  };
  const frameFiles = `${name}.png, frames/ and animations/`;
  // Nothing visible at all is never a delivery, whatever was asked: it is a problem even without expect. A few empty
  // frames (a blink-out, an effect that ends empty) are only a note.
  const blank = empty.length === frames.length ? { file: animation === undefined ? frameFiles : `animations/${animation}.png`, asked: 'something visible', got: `${frames.length === 1 ? 'one frame' : `all ${frames.length} frames`}, fully transparent`,
    fix: 'nothing is drawn inside the canvas. A recipe compiled from a source (poses, fx, fluid, wave) may place its drawing outside it: read the compile warnings, fix the source (a pose part without attach stands at the pose origin plus its at) and compile again. Otherwise pixel_inspect the frames and draw them (pixel_patch), then render again' } : null;
  // Empty frames that only end a one-shot (an effect that ends empty, as the effects guide asks) are intended.
  const ending = new Map(), elsewhere = new Set(), blankFrames = new Set(empty);
  for (const key of names) {
    const order = animations[key].frames.map(index => project.frames[index].name);
    let tail = order.length;
    if (animations[key].loop === false) while (tail > 0 && blankFrames.has(order[tail - 1])) tail--;
    order.forEach((frame, i) => { if (blankFrames.has(frame)) (i >= tail ? ending.set(frame, true) : elsewhere.add(frame)); });
  }
  const unexpected = empty.filter(frame => !emptyTiles.has(frame) && !(ending.has(frame) && !elsewhere.has(frame)));
  const notes = unexpected.length && !blank ? [`Frame${unexpected.length === 1 ? '' : 's'} ${list(unexpected)} ${unexpected.length === 1 ? 'is' : 'are'} fully transparent; if that is not intended, draw ${unexpected.length === 1 ? 'it' : 'them'} (pixel_patch) or take ${unexpected.length === 1 ? 'it' : 'them'} out of the animation.`] : [];
  // A tile set without animations of its own only flips through its tiles, which the export treats as no animation.
  const tileSet = recipe?.animations === undefined && (set || project.frames.some(frame => frame.tile));
  const { motion, notes: moves } = tileSet ? { notes: [] } : reviewMotion(project, names.slice(0, 16), boxes, drawn, recipe);
  notes.push(...moves);
  const fields = gifs === undefined ? 'width, height, frames, colors, transparent, loop' : 'width, height, frames, colors, transparent, loop, gifScale';
  if (!expect) return { ...(blank && { ok: false }), delivered, ...(motion && { motion }), ...(blank && { problems: [blank] }), ...(notes.length && { notes }), hint: `Pass expect with what the user asked for (${fields}) to check every file against it.` };

  const problems = [], named = recipe?.animations !== undefined;
  const asked = { ...(expect.width !== undefined && { width: expect.width }), ...(expect.height !== undefined && { height: expect.height }) };
  if ((expect.width !== undefined && expect.width !== width * scale) || (expect.height !== undefined && expect.height !== height * scale)) {
    const k = wholeScale([[expect.width, width], [expect.height, height]], 16);
    // Each fix is held to the exporter's budgets at the size it proposes.
    const over = k !== null ? exportBudget(project, width, height, k, recipe) : (expect.width ?? 0) > CANVAS || (expect.height ?? 0) > CANVAS ? null : exportBudget(project, expect.width ?? width, expect.height ?? height, 1, recipe);
    const fix = over ? tooBig(over, sheet)
      : k !== null
      ? `${k === 1 ? `sheet.scale ${scale} enlarges every export: ` : ''}pixel_patch ${recipe !== undefined && recipe.sheet === undefined ? `{ "set": "sheet", "value": { "scale": ${k} } }` : `{ "set": "sheet.scale", "value": ${k} }`}, then render again`
      : (expect.width ?? 0) > CANVAS || (expect.height ?? 0) > CANVAS ? largeSizeFix(expect, project, recipe)
      : `the canvas is ${width}x${height}${scale !== 1 ? ` at sheet.scale ${scale}` : ''}: change the recipe's ${Object.keys(asked).join(' and ')} (pixel_patch { "set": "${Object.keys(asked)[0]}", "value": ${Object.values(asked)[0]} }${scale !== 1 ? ' and sheet.scale 1' : ''}), fit the drawing to it, pixel_inspect, then render again`;
    problems.push({ file: frameFiles, asked, got: { width: width * scale, height: height * scale }, fix });
  }
  if (gifs !== undefined) {
    // Only the GIFs of the animations being checked.
    const checked = new Set(names), scoped = gifs.filter(gif => checked.has(gif.animation));
    // A GIF should be the asked frame size, times gifScale when one was asked for.
    const gifScale = expect.gifScale ?? 1, sized = expect.width !== undefined || expect.height !== undefined || expect.gifScale !== undefined;
    const wantW = (expect.width ?? width * scale) * gifScale, wantH = (expect.height ?? height * scale) * gifScale, k = wholeScale([[wantW, width], [wantH, height]], Infinity);
    // "gif" writes every animation, and one render's GIFs hold at most 67,108,864 pixels in all.
    const gifPixels = k === null ? 0 : Object.values(animations).reduce((sum, item) => sum + item.frames.length, 0) * width * height * k * k;
    const gifFix = k === null ? 'fix the frame size first (see the problem above), then render the GIFs again'
      : k > 16 ? `a GIF that size needs scale ${k}, above the limit of 16: ask for a smaller gifScale, or lower sheet.scale`
        : gifPixels > GIF_PIXELS ? `the GIFs of every animation at scale ${k} pass the 67,108,864 pixels a render's GIFs hold: ask for a smaller size or gifScale, or shorten the animations`
          : `render again with "gif": { "scale": ${k} }${k === 1 ? ' or "gif": {}' : ''}`;
    if (expect.gifScale !== undefined && !scoped.length) problems.push({ file: 'gifs/', asked: { width: wantW, height: wantH }, got: 'no GIF', fix: gifFix });
    const wrong = sized ? scoped.filter(gif => gif.width !== wantW || gif.height !== wantH) : [];
    if (wrong.length) problems.push({ file: gifFiles(wrong), asked: { width: wantW, height: wantH }, got: { width: wrong[0].width, height: wrong[0].height }, fix: gifFix });
    // A GIF background blends every pixel onto one colour, so GIFs can miss a request the frames meet. (Opaque frames
    // always make an opaque GIF, so only the transparent side needs a GIF check.)
    const opaque = expect.transparent === true && clearOpen.length === open.length ? scoped.filter(gif => !gif.transparent) : [];
    if (opaque.length) problems.push({ file: gifFiles(opaque), asked: 'a transparent background', got: 'an opaque GIF', fix: 'render again without a "background" in "gif" (GIFs keep 1-bit transparency by default)' });
    const many = expect.colors !== undefined && colors.size <= expect.colors ? scoped.filter(gif => gif.colors > expect.colors) : [];
    if (many.length) problems.push({ file: gifFiles(many), asked: `at most ${expect.colors} colours`, got: many[0].colors, fix: 'a GIF background adds its colour and blends soft edges into new ones: render again without it, or with a background from the palette' });
  }
  // Every animation's played frames, counted once: framesFix weighs a change to one of them against the export.
  const total = expect.frames === undefined ? 0 : Object.values(animations).reduce((sum, item) => sum + item.frames.length, 0);
  if (expect.frames !== undefined) for (const key of names) {
    const count = animations[key].frames.length;
    if (count === expect.frames) continue;
    problems.push({ file: `animations/${key}.png`, asked: expect.frames, got: count, fix: framesFix(key, expect.frames, named, recipe?.animations?.[key]?.direction, project, recipe, total) });
  }
  if (expect.colors !== undefined && colors.size > expect.colors) problems.push({ file: frameFiles, asked: `at most ${expect.colors} colours`, got: colors.size, fix: 'merge similar colours with pixel_patch recolor (or fewer palette entries), check with pixel_inspect diagnostics, then render again' });
  if (expect.transparent === true && clearOpen.length !== open.length) {
    const filled = open.map(frame => frame.name).filter(frameName => !clear.includes(frameName));
    problems.push({ file: frameFiles, asked: 'a transparent background', got: `no transparent pixel in ${list(filled)}`, fix: 'pixel_patch { "set": "background", "value": "transparent" } and remove any fill that covers the whole canvas, then render again' });
  }
  if (expect.transparent === false && solid.length !== frames.length) {
    const holes = frames.map(frame => frame.name).filter(frameName => !solid.includes(frameName));
    problems.push({ file: frameFiles, asked: 'an opaque background', got: `${holes.some(frameName => seeThrough.includes(frameName)) ? 'transparent or partly transparent' : 'transparent'} pixels in ${list(holes)}`, fix: opaqueFix(recipe, holes) });
  }
  if (expect.loop !== undefined) for (const key of names) {
    if (animations[key].loop === expect.loop) continue;
    const fix = named
      ? `pixel_patch { "set": "animations.${key}.loop", "value": ${expect.loop} }, then render again`
      : project.frames.length <= 16
        ? `the recipe has no animations field: pixel_patch { "set": "animations", "value": ${JSON.stringify({ [key]: { frames: project.frames.map(frame => frame.name), loop: expect.loop } })} }, then render again`
        : `the recipe has no animations field: pixel_patch set "animations" to { "${key}": { "frames": [every frame's name, in order], "loop": ${expect.loop} } }, then render again`;
    problems.push({ file: `animations/${key}.png`, asked: expect.loop ? 'a loop' : 'one play', got: animations[key].loop ? 'a loop' : 'one play', fix });
  }
  // The specific mismatches first, then nothing-visible, which the cap of 16 never cuts.
  const listed = blank ? [...problems.slice(0, 15), blank] : problems.slice(0, 16);
  return { ok: !listed.length, delivered, ...(motion && { motion }), ...(listed.length && { problems: listed }), ...(notes.length && { notes }) };
}
