// What a render delivered, and how it differs from what the user asked for (`expect`). Each problem names the file
// and the call that fixes it, so an agent can correct an export before handing it on. Read-only: it never changes
// the bundle.
import { PixelError, renderProject } from './core.js';

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
// current one (the least redrawing) and, when it differs, the one with the most detail.
function largeSizeFix(expect, project, recipe) {
  const { width, height, frames, sheet } = project;
  const asked = expect.width !== undefined && expect.height !== undefined ? `${expect.width}x${expect.height}` : expect.width !== undefined ? `a width of ${expect.width}` : `a height of ${expect.height}`;
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
  if (!nearest && refused) return tooBig(`at every whole scale that makes ${asked}, ${refused}`, sheet);
  if (!nearest) {
    const k = Math.min(SCALE, Math.ceil(Math.max(expect.width ?? 0, expect.height ?? 0) / CANVAS)), side = (value, canvas) => value === undefined ? canvas : Math.min(CANVAS, Math.max(1, Math.round(value / k)));
    const w = side(expect.width, width), h = side(expect.height, height), over = exportBudget(project, w, h, k, recipe);
    const head = `canvases stop at ${CANVAS} px a side and sheet.scale at ${SCALE}, and no whole scale exports ${asked} exactly from ${frames.length} frame${frames.length === 1 ? '' : 's'}`;
    return over ? `${head}, and the nearest size, ${w * k}x${h * k}, is refused too (${over}): tell the user, and ask for fewer frames or a smaller size`
      : `${head}: tell the user, and offer ${w * k}x${h * k} (a ${w}x${h} canvas at sheet.scale ${k}) instead`;
  }
  const changes = fit => JSON.stringify([...(expect.width !== undefined ? [{ set: 'width', value: fit.w }] : []), ...(expect.height !== undefined ? [{ set: 'height', value: fit.h }] : []), recipe !== undefined && recipe.sheet === undefined ? { set: 'sheet', value: { scale: fit.k } } : { set: 'sheet.scale', value: fit.k }]);
  return `canvases stop at ${CANVAS} px a side, so ${asked} is a ${nearest.w}x${nearest.h} canvas at sheet.scale ${nearest.k}, the nearest to the current ${width}x${height}: pixel_patch ${changes(nearest)}${nearest === detailed ? '' : ` (or ${changes(detailed)}, a ${detailed.w}x${detailed.h} canvas at sheet.scale ${detailed.k}, for the most detail)`}, fit the drawing to the new canvas, pixel_inspect, then render again`;
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

// project: the rendered project; recipe: its source (for animation directions and whether it names animations);
// gifs: the animationGIF results written beside it, or undefined when the command writes no GIFs (the CLI's render);
// animation: check only that animation and its frames.
export function checkDelivery(project, { recipe, gifs, expect, animation } = {}) {
  const { name, width, height, sheet, animations } = project, scale = sheet.scale;
  if (animation !== undefined && !Object.hasOwn(animations, animation)) throw new PixelError('animation', `no animation named "${animation}"; choose one of: ${Object.keys(animations).join(', ')}`);
  const names = animation === undefined ? Object.keys(animations) : [animation];
  const frames = animation === undefined ? project.frames : [...new Set(animations[animation].frames)].sort((a, b) => a - b).map(index => project.frames[index]);
  // clear: frames with a fully transparent pixel; seeThrough: with a partly transparent one; solid: fully opaque.
  const colors = new Set(), empty = [], clear = [], seeThrough = [], solid = [];
  for (const frame of frames) {
    let transparent = 0, opaque = 0;
    const { data } = frame, pixels = data.length >> 2;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) transparent++;
      else { colors.add(((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | alpha) >>> 0); if (alpha === 255) opaque++; }
    }
    if (transparent === pixels) empty.push(frame.name);
    if (transparent) clear.push(frame.name);
    if (transparent + opaque !== pixels) seeThrough.push(frame.name);
    if (opaque === pixels) solid.push(frame.name);
  }
  const played = Object.fromEntries(names.slice(0, 16).map(key => [key, { frames: animations[key].frames.length, loop: animations[key].loop }]));
  const delivered = {
    size: [width * scale, height * scale], ...(scale !== 1 && { canvas: [width, height], scale }),
    animations: played, ...(names.length > 16 && { animationsOmitted: names.length - 16 }),
    colors: colors.size, transparent: clear.length === frames.length ? true : clear.length ? 'some frames' : false,
    ...(seeThrough.length && { partlyTransparent: seeThrough.length === frames.length ? true : 'some frames' }),
    ...(gifs?.length && { gifs: [gifs[0].width, gifs[0].height] })
  };
  const notes = empty.length ? [`Frame${empty.length === 1 ? '' : 's'} ${list(empty)} ${empty.length === 1 ? 'is' : 'are'} fully transparent; if that is not intended, draw ${empty.length === 1 ? 'it' : 'them'} (pixel_patch) or take ${empty.length === 1 ? 'it' : 'them'} out of the animation.`] : [];
  const fields = gifs === undefined ? 'width, height, frames, colors, transparent, loop' : 'width, height, frames, colors, transparent, loop, gifScale';
  if (!expect) return { delivered, ...(notes.length && { notes }), hint: `Pass expect with what the user asked for (${fields}) to check every file against it.` };

  const problems = [], frameFiles = `${name}.png, frames/ and animations/`, named = recipe?.animations !== undefined;
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
    const opaque = expect.transparent === true && clear.length === frames.length ? scoped.filter(gif => !gif.transparent) : [];
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
  if (expect.transparent === true && clear.length !== frames.length) {
    const filled = frames.map(frame => frame.name).filter(frameName => !clear.includes(frameName));
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
  return { ok: !problems.length, delivered, ...(problems.length && { problems: problems.slice(0, 16) }), ...(notes.length && { notes }) };
}
