// Only loaded by a tool worker after MCP Apps negotiation. Existing PNG content stays untouched.
import { encodePNG } from './png.js';
import { PREVIEW_KEY, MAX_PREVIEW_BYTES, MAX_PREVIEW_FRAMES, MAX_PREVIEW_FILES, MAX_PREVIEW_PATH_LENGTH } from './mcp-app-model.js';

export function previewMeta(project, details = {}, { maxBytes = MAX_PREVIEW_BYTES, maxFrames = MAX_PREVIEW_FRAMES } = {}) {
  const { width, height } = project, frames = [];
  const { files: allFiles, ...rest } = details;
  // Paths have their own count and length bounds, separate from the base64 budget. Never shorten a path into a different one.
  const files = allFiles?.filter(file => file.length <= MAX_PREVIEW_PATH_LENGTH).slice(0, MAX_PREVIEW_FILES);
  const filesOmitted = allFiles ? allFiles.length - files.length : 0;
  let bytes = 0;
  // Keep a prefix, so animation indices stay meaningful. Stop encoding as soon as either cap is reached.
  for (const frame of project.frames) {
    if (frames.length >= maxFrames) break;
    const png = encodePNG(frame.data, width, height).toString('base64');
    if (bytes + png.length > maxBytes) break;
    frames.push({ name: frame.name, duration: frame.duration, png }); bytes += png.length;
  }
  const animations = Object.entries(project.animations).map(([name, animation]) => ({ name, frames: animation.frames.filter(i => i < frames.length), loop: animation.loop })).filter(a => a.frames.length);
  return { _meta: { [PREVIEW_KEY]: { preview: { version: 1, width, height, scale: Math.max(1, Math.min(8, Math.floor(320 / Math.max(width, height)))), frames, animations, truncated: project.frames.length - frames.length, ...rest,
    ...(files && { files }), ...(filesOmitted && { filesOmitted }) } } } };
}
