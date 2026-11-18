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
