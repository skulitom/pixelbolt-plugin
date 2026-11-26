/** Dependency-free Canvas helpers and player for Pixelbolt atlases. Coordinates use exported pixels. */
// Resolves on the load event: HTMLImageElement.decode() can stay pending while a page is hidden or not painting.
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load atlas image: ${url}`));
    image.src = url;
  });
}
/** Loads an atlas JSON and its sheet image. Paths in the atlas resolve relative to the atlas URL. */
export async function loadSpriteSheet(atlasURL) {
  const url = new URL(atlasURL, document.baseURI);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load atlas: HTTP ${response.status}`);
  const atlas = await response.json();
  return { image: await loadImage(new URL(atlas.meta.image, url).href), atlas };
}
/** The frame shown `time` ms into an animation. Loops wrap; once-only sequences hold their last frame. */
export function frameAt(atlas, animation, time) {
  if (!Object.hasOwn(atlas.animations, animation)) throw new Error(`Unknown animation: ${animation}`);
  const sequence = atlas.animations[animation];
  let elapsed = sequence.loop ? ((time % sequence.duration) + sequence.duration) % sequence.duration : Math.max(0, Math.min(time, sequence.duration));
  for (const name of sequence.frames) {
    if (elapsed < atlas.frames[name].duration) return name;
    elapsed -= atlas.frames[name].duration;
  }
  return sequence.frames.at(-1);
}
// What an atlas lists by heading (meta.headings, from a recipe's `headings`): its frames, or one animation.
function byHeading(atlas, animation) {
  const lookup = atlas.meta?.headings, listed = animation === undefined ? lookup?.frames : lookup?.animations?.[animation];
  if (!listed) throw new Error(animation === undefined ? 'This atlas lists no frames by heading' : `This atlas lists no headings for the animation: ${animation}`);
  return listed;
}
/**
 * The heading the atlas holds nearest to `degrees`, which may be any number: headings go round at 360. Of its still
 * frames, or with `animation` (a name the atlas lists by heading, such as "walk") of that animation's headings.
 * Between two headings equally near, the lower.
 */
export function nearestHeading(atlas, degrees, animation) {
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) throw new Error('A heading is a number of degrees');
  const at = ((degrees % 360) + 360) % 360;
  let nearest = null, least = Infinity;
  for (const key of Object.keys(byHeading(atlas, animation))) {
    const apart = Math.abs(Number(key) - at), gap = Math.min(apart, 360 - apart);
    if (gap < least) { least = gap; nearest = Number(key); }
  }
  return nearest;
}
/** The frame that stands at the heading nearest `degrees`: a sprite stack's "heading-90". Draw it with drawFrame. */
export const headingFrame = (atlas, degrees) => byHeading(atlas)[nearestHeading(atlas, degrees)];
/** The animation that plays `animation` at the heading nearest `degrees`: "walk" at 270 is "walk-se". Give it to frameAt. */
export const headingAnimation = (atlas, animation, degrees) => byHeading(atlas, animation)[nearestHeading(atlas, degrees, animation)];
/**
 * The heading at which the subject faces most nearly along (dx, dy) on screen, y down: the way a character moves, or
 * from a turret to its target. Of the still frames' headings, or of `animation`'s. Needs the atlas to say which way
 * each heading faces (meta.headings.toward, which a sprite stack's atlas does: its front is its +y side).
 */
export function headingToward(atlas, dx, dy, animation) {
  const toward = atlas.meta?.headings?.toward;
  if (!toward) throw new Error('This atlas does not say which way its headings face');
  if (![dx, dy].every(Number.isFinite) || (!dx && !dy)) throw new Error('A direction is two numbers, not both zero');
  let nearest = null, most = -Infinity;
  for (const key of Object.keys(byHeading(atlas, animation))) {
    if (!Object.hasOwn(toward, key)) continue;
    const along = toward[key][0] * dx + toward[key][1] * dy;
    if (along > most) { most = along; nearest = Number(key); }
  }
  if (nearest === null) throw new Error('This atlas does not say which way these headings face');
  return nearest;
}
// The pixel a frame's anchor names, in the source canvas. Atlases write it as `anchorPx` beside the 0-1 `anchor`;
// one without `anchorPx` (written before it, or by hand) keeps its `anchor` in pixels, read as it always was.
const anchorPixels = entry => entry.anchorPx ?? entry.anchor ?? { x: 0, y: 0 };
/**
 * Draws one atlas frame into any 2D context, for games that draw many sprites into one canvas.
 * (x, y) is the frame's anchor when the atlas has one (pass anchor: false to ignore it), otherwise the top-left of
 * the full source canvas. Trimmed frames are offset back into place; flipX mirrors around the source canvas.
 * Positions snap to the nearest whole pixel of the context, so a sprite moving by fractions of a pixel stays crisp:
 * a canvas blends the edges of an image drawn between pixels, even with smoothing off.
 * rotate turns the frame about (x, y), in radians, clockwise. A turned sprite keeps clean square pixels only where
 * each of its pixels covers several of the canvas's: turned on a canvas of one canvas pixel to an art pixel, its
 * edges break into steps that change with every angle. So draw what turns (and what should glide, not step, from
 * place to place) on a canvas at the screen's own resolution with scale 3 or more, laid over the canvas the
 * grid-aligned world is drawn on, and keep smoothing off.
 */
export function drawFrame(context, sheet, name, x, y, { scale = 1, flipX = false, anchor = true, rotate = 0 } = {}) {
  if (typeof rotate !== 'number' || !Number.isFinite(rotate)) throw new Error('Draw rotate must be a number of radians');
  if (!Number.isInteger(scale) || scale < 1 || scale > 32) throw new Error('Draw scale must be an integer from 1 to 32');
  if (!Object.hasOwn(sheet.atlas.frames, name)) throw new Error(`Unknown frame: ${name}`);
  const entry = sheet.atlas.frames[name], { frame } = entry;
  const source = entry.sourceSize ?? { w: frame.w, h: frame.h }, offset = entry.spriteSourceSize ?? { x: 0, y: 0, w: frame.w, h: frame.h };
  const origin = anchor ? anchorPixels(entry) : { x: 0, y: 0 };
  const left = Math.round(x) - (flipX ? source.w - origin.x : origin.x) * scale, top = Math.round(y) - origin.y * scale;
  const dx = flipX ? source.w - offset.x - offset.w : offset.x;
  context.imageSmoothingEnabled = false;
  if (rotate) {
    // About (x, y): the frame is drawn with its anchor at the origin of a turned (and, flipped, mirrored) context.
    context.save();
    context.translate(Math.round(x), Math.round(y));
    context.rotate(rotate);
    if (flipX) context.scale(-1, 1);
    context.drawImage(sheet.image, frame.x, frame.y, frame.w, frame.h, (offset.x - origin.x) * scale, (offset.y - origin.y) * scale, frame.w * scale, frame.h * scale);
    context.restore();
    return;
  }
  if (!flipX) { context.drawImage(sheet.image, frame.x, frame.y, frame.w, frame.h, left + dx * scale, top + offset.y * scale, frame.w * scale, frame.h * scale); return; }
  context.save();
  context.translate(left + (dx + offset.w) * scale, top + offset.y * scale);
  context.scale(-1, 1);
  context.drawImage(sheet.image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w * scale, frame.h * scale);
  context.restore();
}

/**
 * How far drawStack moves a stack's slices from the pivot's pixel, { x, y } in parts of a canvas pixel. A canvas
 * pixel's centre can fall exactly on the line between two slice pixels (an odd scale with the pivot at a pixel's
 * centre, a flattened slice), and which of the two is drawn there varies from canvas to canvas. A baked frame settles
 * each one: across the canvas it takes the slice pixel further along the slice's own axis, and down the canvas the one
 * above, with nothing under a side's last line. So the slices are moved less than any centre is from a line it is not
 * on: back along the slice's axis, and down, except the copy that stands on the level below, which is moved up by
 * as much. Lines repeat every 1/d of a pixel, d the least count of slice pixels that is whole canvas pixels (2 for an
 * isometric squash at an odd scale). The Godot addon's sprite_stack.gd moves its slices the same way.
 */
export function stackNudge(heading, scale = 1, squash = 1) {
  const lines = size => { let d = 1; while (d < 8 && Math.abs(size * d - Math.round(size * d)) > 1e-9) d++; return d; };
  // At the quarter turns nearest 90 and 180 degrees the slice's axis across the canvas runs right to left.
  const along = [1, -1, -1, 1][((Math.round(heading / 90) % 4) + 4) % 4];
  return { x: -along / (4 * lines(scale)), y: 1 / (4 * lines(scale * squash)) };
}

/**
 * Draws a sprite stack from an atlas of its slices (pixelbolt compile --slices), ground first, as a game that stacks
 * at run time does: each slice turned to `heading` about the stack's pivot and drawn `rise` canvas pixels above the
 * one below, once for each of those pixels and once more at its top so the sides are solid. (x, y) is the pivot on the
 * ground, rounded to a whole pixel, which is where a baked frame's anchor has it: at headings 0, 90, 180 and 270 the
 * stack is that heading's baked frame when scale and squash are the stack's own. heading is in degrees and turns as
 * the baked frames do. squash flattens the ground as a camera looking
 * down at a slant does: 1 looks straight down, and a baked view is the stack's own squash (0.5 for an isometric one,
 * whose heading h is this heading h + 45). scale enlarges the slices and, unless rise says otherwise, the step
 * between them. Any heading draws, at the cost of a drawImage for each slice and pixel of rise.
 */
export function drawStack(context, sheet, x, y, { heading = 0, scale = 1, rise = scale, squash = 1, animation = 'slices' } = {}) {
  if (typeof heading !== 'number' || !Number.isFinite(heading)) throw new Error('Stack heading must be a number of degrees');
  if (!Number.isInteger(scale) || scale < 1 || scale > 32) throw new Error('Stack scale must be an integer from 1 to 32');
  if (!Number.isInteger(rise) || rise < 1 || rise > 64) throw new Error('Stack rise must be an integer from 1 to 64');
  if (typeof squash !== 'number' || !(squash > 0 && squash <= 1)) throw new Error('Stack squash must be a number above 0, up to 1');
  const slices = sheet.atlas.animations && Object.hasOwn(sheet.atlas.animations, animation) ? sheet.atlas.animations[animation].frames : null;
  if (!slices) throw new Error(`This atlas has no slices to stack: no animation ${animation}`);
  const turn = heading * Math.PI / 180, left = Math.round(x), ground = Math.round(y);
  const nudge = stackNudge(heading, scale, squash);
  context.imageSmoothingEnabled = false;
  slices.forEach((name, level) => {
    const entry = sheet.atlas.frames[name], { frame } = entry, offset = entry.spriteSourceSize ?? { x: 0, y: 0 };
    // The pivot exactly, where the sheet names it at twice its coordinates; else the anchor pixel's centre.
    const twice = entry.points?.['pivot-x2'], anchor = anchorPixels(entry), sheetScale = Number(sheet.atlas.meta?.scale) || 1;
    const origin = twice ? { x: twice.x / 2, y: twice.y / 2 } : { x: anchor.x + sheetScale / 2, y: anchor.y + sheetScale / 2 };
    // A slice is `rise` pixels thick, from its own level up to the next slice's: a copy at each, both ends counted,
    // as a baked frame draws its sides and then its top.
    for (let step = 0; step <= rise; step++) {
      context.save();
      context.translate(left + nudge.x, ground + (step ? nudge.y : -nudge.y) - level * rise - step);
      context.scale(1, squash);
      context.rotate(turn);
      context.drawImage(sheet.image, frame.x, frame.y, frame.w, frame.h, (offset.x - origin.x) * scale, (offset.y - origin.y) * scale, frame.w * scale, frame.h * scale);
      context.restore();
    }
  });
}
export class SpritePlayer {
  static async load(canvas, atlasURL, options = {}) {
    const { image, atlas } = await loadSpriteSheet(atlasURL);
    return new SpritePlayer(canvas, image, atlas, options);
  }
  constructor(canvas, image, atlas, { scale = 1 } = {}) {
    if (!Number.isInteger(scale) || scale < 1 || scale > 32) throw new Error('Player scale must be an integer from 1 to 32');
    this.canvas = canvas; this.context = canvas.getContext('2d'); this.image = image; this.atlas = atlas;
    this.scale = scale; this.elapsed = 0; this.playing = false; this.animation = null; this.request = null;
    this.canvas.style.imageRendering = 'pixelated';
    this.tick = time => {
      if (!this.playing) return;
      this.elapsed += time - this.lastTime; this.lastTime = time; this.drawAt(this.elapsed);
      if (this.playing) this.request = requestAnimationFrame(this.tick);
    };
  }
  play(name, { restart = true } = {}) {
    if (!Object.hasOwn(this.atlas.animations, name)) throw new Error(`Unknown animation: ${name}`);
    const animation = this.atlas.animations[name];
    if (restart || this.animation !== animation) this.elapsed = 0;
    this.animation = animation; this.animationName = name; this.pause(); this.playing = true;
    this.lastTime = performance.now(); this.drawAt(this.elapsed);
    if (this.playing) this.request = requestAnimationFrame(this.tick);
    return this;
  }
  pause() { this.playing = false; if (this.request !== null) cancelAnimationFrame(this.request); this.request = null; return this; }
  resume() {
    if (!this.animation || this.playing) return this;
    if (!this.animation.loop && this.elapsed >= this.animation.duration) this.elapsed = 0;
    this.lastTime = performance.now(); this.playing = true; this.request = requestAnimationFrame(this.tick); return this;
  }
  drawAt(time) {
    if (!this.animation) return;
    this.drawFrame(frameAt(this.atlas, this.animationName, time));
    if (!this.animation.loop && time >= this.animation.duration) this.pause();
  }
  // The canvas always shows the full source size; trimmed frames are drawn at their original offset. The scale is
  // lowered for a frame it would take past 8192 canvas pixels a side (32 times a 256-pixel frame, 8 times a 1024-pixel
  // one): browsers draw nothing on a larger canvas, and say nothing.
  drawFrame(name) {
    if (!Object.hasOwn(this.atlas.frames, name)) throw new Error(`Unknown frame: ${name}`);
    const entry = this.atlas.frames[name], { x, y, w, h } = entry.frame;
    const source = entry.sourceSize ?? { w, h }, offset = entry.spriteSourceSize ?? { x: 0, y: 0 };
    const scale = Math.max(1, Math.min(this.scale, Math.floor(8192 / Math.max(source.w, source.h))));
    if (this.canvas.width !== source.w * scale) this.canvas.width = source.w * scale;
    if (this.canvas.height !== source.h * scale) this.canvas.height = source.h * scale;
    this.context.imageSmoothingEnabled = false;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(this.image, x, y, w, h, offset.x * scale, offset.y * scale, w * scale, h * scale);
  }
  destroy() { this.pause(); this.animation = null; this.animationName = null; }
}
