import { createViewModel, PREVIEW_KEY, MAX_PREVIEW_BYTES, MAX_PREVIEW_FRAMES, MAX_PREVIEW_FILES, MAX_PREVIEW_PATH_LENGTH } from './mcp-app-model.js';

// This function has no module dependencies: the same code is served inline under the host's no-network CSP.
function mountViewer(model, version) {
  const $ = id => document.getElementById(id), main = $('main'), status = $('status'), player = $('player');
  const canvas = $('canvas'), context = canvas.getContext('2d'), stage = $('stage'), play = $('play'), picker = $('animation');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)'), HOLD = 600, DECODED_BYTES = 64 * 1024 * 1024;
  let ready = false, disposed = false, nextId = 2, host = {}, capabilities = {}, preview = null, track = null;
  let elapsed = 0, last = 0, playing = false, raf = 0, resizeTimer = 0, lastSize = '', generation = 0, drawn = -1;
  let cacheLimit = 0, inView = true, frameLabel = '', prefetched = '';
  const images = new Map(), pending = new Map();
  const releaseImage = image => { image.onload = image.onerror = null; image.removeAttribute('src'); };
  const clearImages = () => { for (const entry of images.values()) releaseImage(entry.image); images.clear(); };
  const post = message => window.parent.postMessage(message, '*');
  const stopRAF = () => { cancelAnimationFrame(raf); raf = 0; };
  const pause = () => { playing = false; stopRAF(); play.textContent = 'Play'; play.setAttribute('aria-label', 'Play animation'); };
  const message = text => { status.textContent = text; status.hidden = !text; resize(); };
  function resize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!ready || disposed) return;
      if (preview) {
        const scale = model.fitScale(preview.width, stage.clientWidth, preview.scale);
        canvas.style.width = `${preview.width * scale}px`; canvas.style.height = `${preview.height * scale}px`;
      }
      const box = main.getBoundingClientRect(), width = Math.ceil(box.width), height = Math.ceil(box.height), size = `${width}:${height}`;
      if (size !== lastSize) { lastSize = size; post(model.sizeChanged(width, height)); }
    }, 40);
  }
  const observer = new ResizeObserver(resize); observer.observe(main); observer.observe(stage);
  const visible = () => inView && !document.hidden && !player.hidden;
  function resumeRAF() {
    if (playing && !disposed && visible() && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function visibilityChanged() { if (visible()) resumeRAF(); else stopRAF(); }
  const visibilityObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.target === stage) inView = entry.isIntersecting;
    visibilityChanged();
  }) : null;
  visibilityObserver?.observe(stage);
  document.addEventListener('visibilitychange', visibilityChanged);
  function hostContext(update = {}) {
    if (!update || typeof update !== 'object') return;
    host = { ...host, ...update, styles: { ...host.styles, ...update.styles, variables: { ...host.styles?.variables, ...update.styles?.variables } } };
    const root = document.documentElement;
    if (host.theme === 'light' || host.theme === 'dark') { root.style.colorScheme = host.theme; root.dataset.theme = host.theme; }
    // Host font CSS may load remote fonts; use only variables, with local system-font fallbacks.
    for (const key of ['--color-background-primary', '--color-background-secondary', '--color-text-primary', '--color-text-secondary', '--color-border-primary', '--color-ring-primary', '--font-sans', '--font-mono', '--font-text-sm-size', '--border-radius-md']) {
      const value = host.styles.variables[key];
      if (typeof value === 'string') root.style.setProperty(key, value);
      else root.style.removeProperty(key);
    }
    const dims = host.containerDimensions ?? {};
    root.style.width = 'width' in dims ? '100vw' : '';
    root.style.height = 'height' in dims ? '100vh' : '';
    main.style.height = 'height' in dims ? '100vh' : '';
    main.style.maxWidth = Number.isFinite(dims.maxWidth) ? `${dims.maxWidth}px` : '';
    main.style.maxHeight = Number.isFinite(dims.maxHeight) ? `${dims.maxHeight}px` : '';
    resize();
  }
  function prefetch(state) {
    const key = `${state.position}:${drawn === state.frame}`;
    if (prefetched === key) return;
    prefetched = key;
    // Decode the entire preview when it fits; otherwise keep the wanted frame and the next distinct frames.
    // With room for only one image, the canvas itself holds the current pixels while the next image loads.
    const keep = new Set(cacheLimit === 1 && drawn === state.frame ? [] : [state.frame]);
    if (preview.frames.length <= cacheLimit) preview.frames.forEach((_, i) => keep.add(i));
    else for (let offset = 1; offset <= track.entries.length && keep.size < cacheLimit; offset++) keep.add(track.entries[(state.position + offset) % track.entries.length].frame);
    for (const [index, entry] of images) if (!keep.has(index)) { releaseImage(entry.image); images.delete(index); }
    for (const index of keep) {
      if (images.has(index)) continue;
      const image = new Image(), entry = { image, ready: false };
      images.set(index, entry);
      const ownGeneration = generation;
      const current = () => !disposed && ownGeneration === generation && images.get(index) === entry;
      const failed = () => { if (current()) { pause(); message('This preview frame could not be decoded.'); } };
      const loaded = () => {
        if (!current()) return;
        entry.ready = true;
        // Read the current playhead, never the one that originally requested this image.
        if (model.frameAt(track, elapsed).frame === index) draw();
      };
      image.onload = () => {
        if (!current()) return;
        if (image.naturalWidth !== preview.width || image.naturalHeight !== preview.height) { pause(); message('This preview frame has an unexpected size.'); return; }
        if (typeof image.decode === 'function') image.decode().then(loaded, failed);
        else loaded();
      };
      image.onerror = failed;
      image.src = `data:image/png;base64,${preview.frames[index].png}`;
    }
  }
  function draw() {
    if (!track?.entries.length) return;
    const state = model.frameAt(track, elapsed), frame = preview.frames[state.frame], entry = images.get(state.frame);
    if (drawn !== state.frame) {
      if (!entry?.ready) { prefetch(state); return; }
      // Clearing and replacing are one synchronous step; a pending decode leaves the last frame untouched.
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(entry.image, 0, 0);
      drawn = state.frame;
    }
    const label = `${frame.name} · ${frame.duration} ms · ${state.position + 1}/${track.entries.length}`;
    if (label !== frameLabel) { $('frame').textContent = label; frameLabel = label; }
    if (player.hidden) {
      player.hidden = false;
      message(preview.truncated ? `${preview.truncated} frame${preview.truncated === 1 ? '' : 's'} omitted from this preview (size limit).` : '');
      resumeRAF();
    }
    prefetch(state);
  }
  function tick(now) {
    raf = 0;
    if (!playing || disposed || !visible()) return;
    elapsed = model.advance(elapsed, now - last, $('speed').value); last = now;
    // A one-shot holds its last frame, then plays again, as Pixelbolt Studio's effects lab does.
    if (!track.loop) elapsed %= track.duration + HOLD;
    draw(); raf = requestAnimationFrame(tick);
  }
  function start() {
    if (!track?.entries.length || track.entries.length < 2) return;
    if (model.frameAt(track, elapsed).ended) elapsed = 0;
    playing = true; last = performance.now(); play.textContent = 'Pause'; play.setAttribute('aria-label', 'Pause animation');
    resumeRAF();
  }
  function select() {
    pause(); elapsed = 0; prefetched = ''; track = model.timeline(preview, picker.value);
    play.disabled = $('previous').disabled = $('next').disabled = track.entries.length < 2;
    draw(); if (!reduced.matches) start();
  }
  function step(delta) {
    if (!track?.entries.length) return;
    pause();
    const length = track.entries.length, position = model.frameAt(track, elapsed).position + delta;
    elapsed = track.entries[track.loop ? (position + length) % length : Math.max(0, Math.min(length - 1, position))].start; draw();
  }
  function reset() {
    pause(); generation++; clearImages(); preview = track = null; drawn = -1; frameLabel = prefetched = '';
    player.hidden = true; $('delivery').hidden = true; $('share').hidden = true;
    $('files').replaceChildren(); $('verdict').textContent = '';
  }
  function result(value) {
    reset();
    const decoded = model.decodeResult(value); preview = decoded.preview;
    if (!preview) { message(decoded.text); return; }
    message(preview.frames.length ? 'Loading frames' : `${preview.truncated} frame${preview.truncated === 1 ? '' : 's'} omitted from this preview (size limit).`);
    cacheLimit = Math.max(1, Math.floor(DECODED_BYTES / (preview.width * preview.height * 4)));
    canvas.width = preview.width; canvas.height = preview.height; context.imageSmoothingEnabled = false;
    picker.replaceChildren();
    for (const animation of preview.animations) { const option = document.createElement('option'); option.value = animation.name; option.textContent = animation.name; picker.append(option); }
    if (preview.animations.some(a => a.name === preview.animation)) picker.value = preview.animation;
    $('animation-label').hidden = preview.animations.length <= 1;
    if (preview.verdict) $('verdict').textContent = `Delivery check: ${{ passed: 'passed', failed: 'failed', 'not-checked': 'no expectations supplied' }[preview.verdict]}.`;
    for (const file of preview.files) { const li = document.createElement('li'); li.textContent = file; $('files').append(li); }
    if (preview.filesOmitted) { const li = document.createElement('li'); li.textContent = `and ${preview.filesOmitted} more files`; $('files').append(li); }
    $('delivery').hidden = !preview.verdict && !preview.files.length && !preview.filesOmitted;
    $('file-details').hidden = !preview.files.length && !preview.filesOmitted;
    $('file-count').textContent = `Written files (${preview.files.length + preview.filesOmitted})`;
    $('share').hidden = !preview.shareLink;
    $('share').disabled = !capabilities.openLinks;
    $('share').title = capabilities.openLinks ? '' : 'This host does not support opening links';
    // An animation the preview's frame prefix cut off is named as such, never replaced by another one.
    if (preview.animation !== undefined && !preview.animations.some(a => a.name === preview.animation)) {
      message(`The "${preview.animation}" animation uses frames past this preview's first ${preview.frames.length}, so it can't be played here; the exported files are complete.`);
      return;
    }
    select(); resize();
  }
  function onMessage(event) {
    // Sandboxed hosts can have opaque origins; validate the sending window instead of assuming an origin.
    const data = event.data;
    if (event.source !== window.parent || !data || data.jsonrpc !== '2.0' || disposed) return;
    if (!data.method && data.id === 1 && !ready) {
      if (data.error) { message(`Could not initialize preview: ${data.error.message}`); return; }
      // The host answers with the version it negotiated (ours, or one it prefers); like the SDK's App, accept any.
      if (typeof data.result?.protocolVersion !== 'string') { message('The host sent an invalid preview handshake.'); return; }
      capabilities = data.result.hostCapabilities ?? {}; hostContext(data.result.hostContext);
      ready = true; post(model.initialized()); resize(); return;
    }
    if (data.method === 'ui/resource-teardown' && Object.hasOwn(data, 'id')) {
      pause(); disposed = true; generation++; clearImages(); observer.disconnect(); visibilityObserver?.disconnect(); clearTimeout(resizeTimer);
      for (const timer of pending.values()) clearTimeout(timer); pending.clear();
      reduced.removeEventListener('change', onMotion); window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', visibilityChanged);
      post({ jsonrpc: '2.0', id: data.id, result: {} }); return;
    }
    if (!ready) return;
    if (data.method === 'ping' && Object.hasOwn(data, 'id')) { post({ jsonrpc: '2.0', id: data.id, result: {} }); return; }
    if (!data.method && pending.has(data.id)) {
      clearTimeout(pending.get(data.id)); pending.delete(data.id); $('share').disabled = !capabilities.openLinks;
      if (data.error) message(`Could not open playground: ${data.error.message}`);
      return;
    }
    if (data.method === 'ui/notifications/tool-input') { reset(); message("Waiting for Pixelbolt's result"); }
    else if (data.method === 'ui/notifications/tool-result') result(data.params);
    else if (data.method === 'ui/notifications/tool-cancelled') { reset(); message(data.params?.reason || 'Pixelbolt call cancelled.'); }
    else if (data.method === 'ui/notifications/host-context-changed') hostContext(data.params);
    else if (Object.hasOwn(data, 'id') && data.method) post({ jsonrpc: '2.0', id: data.id, error: { code: -32601, message: `Unknown method: ${data.method}` } });
  }
  function onMotion() { if (reduced.matches) pause(); }
  play.onclick = () => playing ? pause() : start();
  $('previous').onclick = () => step(-1); $('next').onclick = () => step(1); picker.onchange = select;
  $('speed').onchange = () => { last = performance.now(); };
  $('background').onchange = () => { stage.dataset.background = $('background').value; };
  $('share').onclick = () => {
    if (!ready || disposed || !preview?.shareLink || !capabilities.openLinks) return;
    const id = nextId++; $('share').disabled = true;
    pending.set(id, setTimeout(() => { pending.delete(id); $('share').disabled = false; message('The host did not answer the playground request.'); }, 10000));
    post(model.openLink(id, preview.shareLink));
  };
  reduced.addEventListener('change', onMotion);
  window.addEventListener('message', onMessage);
  post(model.initialize(1, version));
}

export function viewerHTML(version) {
  const script = `const model = (${createViewModel.toString()})(${JSON.stringify(PREVIEW_KEY)}, ${MAX_PREVIEW_BYTES}, ${MAX_PREVIEW_FRAMES}, ${MAX_PREVIEW_FILES}, ${MAX_PREVIEW_PATH_LENGTH});\n(${mountViewer.toString()})(model, ${JSON.stringify(version)});`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pixelbolt preview</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#202020;--muted:#666;--panel:#f4f4f4;--border:#ccc}
@media(prefers-color-scheme:dark){:root{--bg:#202020;--fg:#eee;--muted:#bbb;--panel:#303030;--border:#555}}
:root[data-theme=light]{--bg:#fff;--fg:#202020;--muted:#666;--panel:#f4f4f4;--border:#ccc}
:root[data-theme=dark]{--bg:#202020;--fg:#eee;--muted:#bbb;--panel:#303030;--border:#555}
*{box-sizing:border-box}body{margin:0;background:var(--color-background-primary,var(--bg));color:var(--color-text-primary,var(--fg));font:var(--font-text-sm-size,14px)/1.5 var(--font-sans,system-ui,sans-serif)}
main{padding:12px;width:100%;overflow:auto}p{margin:0 0 8px}#status{color:var(--color-text-secondary,var(--muted));white-space:pre-wrap;overflow-wrap:anywhere}
[hidden]{display:none!important}.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}button,select{font:inherit;color:inherit;background:var(--color-background-secondary,var(--panel));border:1px solid var(--color-border-primary,var(--border));border-radius:var(--border-radius-md,6px);padding:5px 9px}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid var(--color-ring-primary,#678bff);outline-offset:2px}
#stage{overflow:auto;max-height:360px;background-color:#ddd;background-image:conic-gradient(#bbb 25%,transparent 0 50%,#bbb 0 75%,transparent 0);background-size:16px 16px;border-radius:var(--border-radius-md,6px)}
#stage[data-background=dark]{background:#181818}#stage[data-background=light]{background:#fff}canvas{display:block;margin:auto;image-rendering:pixelated;image-rendering:crisp-edges}#frame{margin-top:8px;overflow-wrap:anywhere;color:var(--color-text-secondary,var(--muted))}#delivery{margin-top:10px}#files{max-height:150px;overflow:auto;padding-left:20px;font-family:var(--font-mono,monospace);overflow-wrap:anywhere}summary{cursor:pointer}#share{margin-top:8px}
</style></head><body><main id="main">
<p id="status" role="status">Waiting for Pixelbolt's result</p>
<section id="player" hidden aria-label="Pixelbolt player"><div id="stage" data-background="checker"><canvas id="canvas" role="img" aria-label="Pixel art preview"></canvas></div>
<div class="controls"><button id="previous" aria-label="Previous frame">Previous</button><button id="play" aria-label="Play animation">Play</button><button id="next" aria-label="Next frame">Next</button>
<label id="animation-label" hidden>Animation <select id="animation"></select></label>
<label>Speed <select id="speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
<label>Background <select id="background"><option value="checker">Checkerboard</option><option value="dark">Dark</option><option value="light">Light</option></select></label></div><p id="frame"></p></section>
<section id="delivery" hidden><p id="verdict"></p><details id="file-details"><summary id="file-count">Written files</summary><ul id="files"></ul></details></section>
<button id="share" hidden>Open in playground</button>
</main><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
