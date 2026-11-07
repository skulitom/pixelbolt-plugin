// Browser-independent viewer logic. Inlined verbatim (via function.toString) into the UI resource, without a build.
export const PREVIEW_KEY = 'io.github.skulitom/pixelbolt';
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024, MAX_PREVIEW_FRAMES = 240;
export const MAX_PREVIEW_FILES = 64, MAX_PREVIEW_PATH_LENGTH = 1024;

export function createViewModel(key = PREVIEW_KEY, maxBytes = MAX_PREVIEW_BYTES, maxFrames = MAX_PREVIEW_FRAMES, maxFiles = MAX_PREVIEW_FILES, maxPathLength = MAX_PREVIEW_PATH_LENGTH) {
  const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  function decodeResult(result) {
    const text = (Array.isArray(result?.content) ? result.content : []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
    const p = result?._meta?.[key]?.preview, fallback = { preview: null, text: text || 'No preview available.' };
    // 16384 px a side: inspection sheets add gutters to a 4096 px frame, and browsers cap canvases near this size.
    if (result?.isError || !p || p.version !== 1 || !integer(p.width, 1, 16384) || !integer(p.height, 1, 16384) ||
        !integer(p.scale, 1, 16) || !integer(p.truncated, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(p.frames) || p.frames.length > maxFrames || !Array.isArray(p.animations)) return fallback;
    let bytes = 0;
    for (const f of p.frames) {
      if (!f || typeof f.name !== 'string' || !integer(f.duration, 1, 60000) || typeof f.png !== 'string') return fallback;
      bytes += f.png.length;
      if (bytes > maxBytes || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(f.png) || f.png.length % 4 !== 0) return fallback;
    }
    if (p.animations.some(a => !a || typeof a.name !== 'string' || typeof a.loop !== 'boolean' || !Array.isArray(a.frames) ||
      !a.frames.length || a.frames.some(i => !integer(i, 0, p.frames.length - 1)))) return fallback;
    if (p.files !== undefined && (!Array.isArray(p.files) || p.files.length > maxFiles ||
      p.files.some(f => typeof f !== 'string' || f.length > maxPathLength))) return fallback;
    if (p.filesOmitted !== undefined && !integer(p.filesOmitted, 0, Number.MAX_SAFE_INTEGER)) return fallback;
    // Only known fields reach the DOM; paths are text and links go through the host, never the iframe's navigation.
    const shareLink = typeof p.shareLink === 'string' && /^https:\/\/skulitom\.github\.io\/Pixelbolt\//.test(p.shareLink) ? p.shareLink : undefined;
    return { text, preview: { version: 1, width: p.width, height: p.height, scale: p.scale, frames: p.frames,
      animations: p.animations, animation: typeof p.animation === 'string' ? p.animation : undefined,
      truncated: p.truncated, files: p.files ?? [], filesOmitted: p.filesOmitted ?? 0,
      verdict: ['passed', 'failed', 'not-checked'].includes(p.verdict) ? p.verdict : undefined, shareLink } };
  }
  function timeline(preview, name) {
    const animation = preview.animations.find(a => a.name === name) ?? preview.animations[0];
    const order = animation?.frames ?? preview.frames.map((_, i) => i);
    let duration = 0;
    const entries = order.map(frame => { const start = duration; duration += preview.frames[frame].duration; return { frame, start, duration: preview.frames[frame].duration }; });
    return { entries, duration, loop: animation?.loop ?? false };
  }
  const speed = value => Math.max(0.25, Math.min(2, Number(value) || 1));
  const advance = (elapsed, delta, rate) => elapsed + Math.max(0, delta) * speed(rate);
  function frameAt(track, elapsed) {
    if (!track.entries.length) return { position: -1, frame: -1, ended: true };
    const ended = !track.loop && elapsed >= track.duration;
    const time = track.loop ? Math.max(0, elapsed) % track.duration : Math.min(Math.max(0, elapsed), track.duration);
    let position = track.entries.findIndex(e => time < e.start + e.duration);
    if (position < 0) position = track.entries.length - 1;
    return { position, frame: track.entries[position].frame, ended };
  }
  // If native pixels cannot fit, keep 1x and allow scrolling instead of resampling the art.
  const fitScale = (width, available, suggested) => Math.max(1, Math.min(Math.floor(suggested) || 1, Math.floor(available / width) || 1));
  const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  const notification = (method, params) => ({ jsonrpc: '2.0', method, params });
  return { decodeResult, timeline, speed, advance, frameAt, fitScale,
    initialize: (id, version) => request(id, 'ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Pixelbolt viewer', version }, appCapabilities: { availableDisplayModes: ['inline'] } }),
    initialized: () => notification('ui/notifications/initialized', {}),
    sizeChanged: (width, height) => notification('ui/notifications/size-changed', { width, height }),
    openLink: (id, url) => request(id, 'ui/open-link', { url }) };
}
