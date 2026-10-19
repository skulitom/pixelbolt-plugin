import { renderProject, buildAtlas, parseColor, reviewPixels, onionPixels, animationPosition, animationNeighbors, MAX_REQUEST_BYTES } from '/core.js';
import { animationGIF } from '/gif.js';
import { createDraftStore } from '/draft.js';

const $ = id => document.getElementById(id);
const source = $('source'), canvas = $('canvas'), context = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let project, spec, atlas, frameImages = [], selected = 0, playing = !reducedMotion, mode = 'animation';
let position = 0;
let elapsed = 0, lastTime = 0, zoom = 12, dirty = false, valid = false, compileTimer, toastTimer, loadVersion = 0;
// An unsaved recipe is kept as a draft in this browser. `offer` is a draft found at start-up that the user has not
// yet restored or discarded; until then new edits do not replace it.
const drafts = createDraftStore((() => { try { return localStorage; } catch { return null; } })());
let offer = null, draftTimer, draftWarned = false;
const examples = [{ file: 'quality/skink', title: 'Lantern skink', type: 'Authored poses · 12 frames' }, { file: 'forest-spirit', title: 'Forest spirit', type: 'Character · 6 frames' }, { file: 'ember', title: 'Campfire', type: 'Effect · 4 frames' }, { file: 'coin', title: 'Golden coin', type: 'Collectible · 6 frames' }, { file: 'shrine', title: 'Moonlit shrine', type: 'Dither, rewrite, rim light · 2 frames' }, { file: 'caption', title: 'Caption', type: 'Text, for video · 8 frames' }, { file: 'swing', title: 'Sword swing', type: 'Rotated, tweened poses · 5 frames' }, { file: 'effects', title: 'Particle effects', type: 'Compiled fx · 57 frames' }];
const title = name => name.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
function imageCanvas(data, width, height) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0); return c;
}
function thumbnail(c, description) {
  const image = document.createElement('img'); image.src = c.toDataURL('image/png'); image.alt = description; return image;
}
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
function download(data, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function playState() { $('play').textContent = playing ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation'); }
function render() {
  if (!project) return;
  const isSheet = mode === 'sheet';
  const width = isSheet ? atlas.width : project.width, height = isSheet ? atlas.height : project.height;
  canvas.width = width; canvas.height = height;
  context.imageSmoothingEnabled = false;
  const animation = project.animations[$('animation').value];
  const pixels = isSheet ? atlas.data : $('onion').getAttribute('aria-pressed') === 'true' ? onionPixels(project, animation, position) : project.frames[selected].data;
  context.putImageData(new ImageData(new Uint8ClampedArray(reviewPixels(pixels, $('review-view').value)), width, height), 0, 0);
  const native = $('native-canvas'); native.width = project.width; native.height = project.height;
  native.getContext('2d').drawImage(frameImages[selected], 0, 0);
  const fit = Math.max(1, Math.floor(($('artboard').clientWidth - 48) / width));
  const displayScale = isSheet ? Math.min(zoom, fit) : zoom;
  canvas.style.width = `${width * displayScale}px`; canvas.style.height = `${height * displayScale}px`;
  $('canvas-wrap').style.setProperty('--pixel-size', `${displayScale}px`);
  $('canvas-wrap').classList.toggle('grid', $('grid').getAttribute('aria-pressed') === 'true');
  $('frame-counter').textContent = `${String(position + 1).padStart(2, '0')} / ${String(animation.frames.length).padStart(2, '0')}`;
  const neighbors = animationNeighbors(animation, position);
  $('onion').title = `Previous (pink): ${neighbors.previous === null ? 'none' : project.frames[animation.frames[neighbors.previous]].name}; next (cyan): ${neighbors.next === null ? 'none' : project.frames[animation.frames[neighbors.next]].name}`;
  $('canvas').setAttribute('aria-label', isSheet ? `${project.name} sprite sheet` : `${project.name}, frame ${project.frames[selected].name}`);
  document.querySelectorAll('.frame').forEach((button, i) => { button.classList.toggle('active', i === position); button.setAttribute('aria-pressed', String(i === position)); });
}
function animationChanged() {
  elapsed = 0;
  const animation = project.animations[$('animation').value];
  position = 0;
  selected = animation.frames[0];
  $('frame-count').textContent = `${animation.frames.length} playback entries · ${project.frames.length} source poses`;
  $('timeline').replaceChildren(...animation.frames.map((index, sequencePosition) => {
    const frame = project.frames[index];
    const button = document.createElement('button'); button.className = 'frame'; button.title = `${frame.name} · ${frame.duration}ms`; button.setAttribute('aria-label', `Select position ${sequencePosition + 1}: ${frame.name}`);
    const block = document.createElement('div'); block.className = 'frame-image';
    const number = document.createElement('span'); number.className = 'number'; number.textContent = String(sequencePosition + 1).padStart(2, '0');
    block.append(thumbnail(frameImages[index], ''), number);
    const caption = document.createElement('small');
    const label = document.createElement('span'); label.textContent = frame.name;
    const time = document.createElement('span'); time.textContent = `${frame.duration}ms`; caption.append(label, time);
    button.append(block, caption);
    button.addEventListener('click', () => {
      selected = index; position = sequencePosition; playing = false;
      elapsed = animation.frames.slice(0, position).reduce((sum, i) => sum + project.frames[i].duration, 0);
      playState(); setMode('animation'); render();
    });
    return button;
  }));
  $('timing').textContent = `${(animation.duration / 1000).toFixed(2)}s ${animation.loop ? 'loop' : 'once'}`;
  render();
}
function compile() {
  clearTimeout(compileTimer);
  try {
    const nextSpec = JSON.parse(source.value.replace(/^\uFEFF/, ''));
    const nextProject = renderProject(nextSpec), nextAtlas = buildAtlas(nextProject);
    spec = nextSpec; project = nextProject; atlas = nextAtlas;
    atlas.image = imageCanvas(atlas.data, atlas.width, atlas.height);
    frameImages = project.frames.map(f => imageCanvas(f.data, project.width, project.height));
    $('project-name').textContent = title(project.name);
    $('dimensions').textContent = `${project.width} × ${project.height} px`;
    $('source-filename').textContent = `${project.name}.json`;
    $('frame-count').textContent = `${project.frames.length} frames`;
    const oldAnimation = $('animation').value;
    $('animation').replaceChildren(...Object.keys(project.animations).map(key => { const option = document.createElement('option'); option.value = key; option.textContent = title(key); return option; }));
    if (project.animations[oldAnimation]) $('animation').value = oldAnimation;
    $('color-count').textContent = `${Object.keys(project.palette).length} colors`;
    $('palette').replaceChildren(...Object.entries(project.palette).map(([key, value]) => {
      const button = document.createElement('button'); button.className = 'swatch'; button.style.background = value;
      button.title = `${key}: ${value}`; button.setAttribute('aria-label', `Color ${key}: ${value}`);
      const [r, g, b] = parseColor(value); button.style.color = r * .299 + g * .587 + b * .114 > 150 ? '#263b42' : '#fff';
      button.textContent = key.length === 1 ? key : '';
      button.addEventListener('click', () => { $('color-info').textContent = `${key}  ${value}`; });
      return button;
    }));
    $('error').hidden = true;
    $('compile-status').textContent = project.warnings.length ? project.warnings.join(' ') : '● All pixels accounted for';
    $('export').disabled = false; valid = true; animationChanged();
  } catch (error) {
    valid = false; $('error').textContent = error.message; $('error').hidden = false;
    $('compile-status').textContent = 'Fix the recipe to update the preview'; $('export').disabled = true;
  }
}
function keepDraft() {
  clearTimeout(draftTimer);
  if (!dirty || offer) return;
  if (!drafts.save(source.value, $('source-filename').textContent) && !draftWarned) { draftWarned = true; toast('This browser is not keeping drafts (storage is off or full). Use Save JSON.'); }
}
// The recipe on screen is saved or was replaced on purpose, so its draft is no longer needed.
function settle() { dirty = false; clearTimeout(draftTimer); if (!offer) drafts.clear(); }
function setSource(value, exampleFile) {
  loadVersion++;
  source.value = JSON.stringify(value, null, 2); settle();
  document.querySelectorAll('.example').forEach(button => button.classList.toggle('active', button.dataset.file === exampleFile));
  compile(); playState();
}
async function loadExample(example) {
  if (dirty && !confirm('Replace your edited recipe? Save JSON first if you want to keep it.')) return;
  const version = ++loadVersion;
  try {
    const response = await fetch(`/examples/${example.file}.json`);
    if (!response.ok) throw new Error(`Could not load example: HTTP ${response.status}`);
    const value = await response.json();
    if (version === loadVersion) setSource(value, example.file);
  } catch (error) { toast(error.message); }
}
function setMode(next) {
  mode = next;
  for (const [id, value] of [['animation-view', 'animation'], ['sheet-view', 'sheet']]) { $(id).classList.toggle('active', value === mode); $(id).setAttribute('aria-pressed', String(value === mode)); }
  $('artboard-caption').textContent = mode === 'sheet' ? 'Export layout · transparent padding' : 'Transparent background';
  render();
}
source.addEventListener('input', () => { dirty = true; valid = false; $('export').disabled = true; clearTimeout(compileTimer); compileTimer = setTimeout(compile, 350); clearTimeout(draftTimer); draftTimer = setTimeout(keepDraft, 400); });
// Tab indents, as in any code editor, but must not trap the keyboard: Shift+Tab always moves back, and Escape lets
// the next Tab move on.
let leavingEditor = false;
source.addEventListener('keydown', event => {
  if (event.key === 'Escape') { leavingEditor = true; return; }
  if (event.key === 'Tab' && !event.shiftKey && !leavingEditor) { event.preventDefault(); const start = source.selectionStart; source.setRangeText('  ', start, source.selectionEnd, 'end'); source.dispatchEvent(new Event('input')); }
  if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) leavingEditor = false;
});
source.addEventListener('blur', () => { leavingEditor = false; });
$('play').addEventListener('click', () => { if (!project) return; playing = !playing; if (playing) { if (elapsed >= project.animations[$('animation').value].duration) elapsed = 0; setMode('animation'); } playState(); });
$('animation').addEventListener('change', animationChanged);
$('zoom').addEventListener('change', () => { zoom = Number($('zoom').value); render(); });
$('review-view').addEventListener('change', render);
for (const id of ['grid', 'onion']) $(id).addEventListener('click', () => { $(id).setAttribute('aria-pressed', String($(id).getAttribute('aria-pressed') !== 'true')); render(); });
$('animation-view').addEventListener('click', () => setMode('animation'));
$('sheet-view').addEventListener('click', () => setMode('sheet'));
$('guide-toggle').addEventListener('click', () => $('guide').showModal());
$('guide-close').addEventListener('click', () => $('guide').close());
$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; if (!file) return;
  try {
    if (file.size > MAX_REQUEST_BYTES) throw new Error(`Choose a project no larger than ${MAX_REQUEST_BYTES / (1024 * 1024)} MiB.`);
    const value = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); renderProject(value);
    if (dirty && !confirm('Replace your edited recipe? Save JSON first if you want to keep it.')) return;
    setSource(value); toast(`Opened ${file.name}`);
  } catch (error) { toast(error.message); } finally { $('file').value = ''; }
});
$('new').addEventListener('click', () => {
  if (dirty && !confirm('Replace your edited recipe? Save JSON first if you want to keep it.')) return;
  setSource({ version: 1, name: 'new-sprite', width: 16, height: 16, palette: { g: '#72b58d' }, frames: [{ name: 'idle', duration: 150, ops: [] }] });
  source.focus();
});
$('save').addEventListener('click', () => { download(source.value, `${project?.name ?? 'sprite'}.pixel.json`, 'application/json'); settle(); toast('Project JSON saved'); });
$('gif').addEventListener('click', () => {
  compile(); if (!valid) { toast('Fix the recipe to export a GIF.'); return; }
  try {
    const gif = animationGIF(project, $('animation').value, { scale: zoom });
    download(gif.data, `${project.name}-${gif.animation}.gif`, 'image/gif');
    toast(`GIF saved: ${gif.width} × ${gif.height} px.${gif.partialAlpha ? ` ${gif.partialAlpha} partly transparent pixels became fully transparent or opaque; the gif command can blend them onto a background.` : ''}`);
  } catch (error) { toast(error.message); }
});
// Frames for a video editor: the server builds them exactly as `pixelbolt sequence` does. The dialog also shows that
// call, and the MCP one, because agents are who usually make these.
const framesSettings = () => ({ fps: $('frames-fps').value, animation: $('animation').value, ...($('frames-size').value ? { size: $('frames-size').value } : { scale: zoom }) });
function showFramesCall() {
  const settings = framesSettings(), sizing = settings.size ? `--size ${settings.size}` : `--scale ${settings.scale}`;
  $('frames-call').textContent = `pixelbolt sequence ${project.name}.pixel.json --fps ${settings.fps} ${sizing} --animation ${settings.animation} --out frames\n\npixel_render { "revision": "…", "sequence": ${JSON.stringify(settings)} }`;
}
$('frames').addEventListener('click', () => { compile(); if (!valid) { toast('Fix the recipe to export frames.'); return; } showFramesCall(); $('frames-dialog').showModal(); });
for (const id of ['frames-fps', 'frames-size']) $(id).addEventListener('change', showFramesCall);
$('frames-close').addEventListener('click', () => $('frames-dialog').close());
$('frames-export').addEventListener('click', async () => {
  const button = $('frames-export'); button.disabled = true; button.textContent = 'Making frames…';
  try {
    const response = await fetch('/api/sequence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: spec, sequence: framesSettings() }) });
    if (!response.ok) { const body = await response.text(); try { throw new Error(JSON.parse(body).error); } catch (error) { if (error instanceof SyntaxError) throw new Error(body); throw error; } }
    const summary = JSON.parse(response.headers.get('X-PixelForge-Sequence') ?? '{}');
    download(await response.blob(), `${project.name}-${$('animation').value}-frames.zip`);
    $('frames-dialog').close();
    toast(`Frames saved: ${summary.frames} PNGs, ${summary.width} × ${summary.height}, ${summary.fps} fps.${summary.notes ? ' The README in the ZIP explains how the timing was fitted.' : ''}`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Export frames'; }
});
$('draft-restore').addEventListener('click', () => {
  if (dirty && !confirm('Replace your edited recipe with the draft? Save JSON first if you want to keep it.')) return;
  loadVersion++; source.value = offer.text; offer = null; $('draft').hidden = true; dirty = true;
  document.querySelectorAll('.example').forEach(button => button.classList.remove('active'));
  compile(); playState(); toast('Draft restored. Save JSON to keep it.');
});
$('draft-discard').addEventListener('click', () => { offer = null; $('draft').hidden = true; drafts.clear(); keepDraft(); });
$('export').addEventListener('click', async () => {
  compile(); if (!valid) return;
  const button = $('export'), original = button.textContent; button.disabled = true; button.textContent = 'Packing assets…';
  try {
    const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    if (!response.ok) { const body = await response.text(); try { throw new Error(JSON.parse(body).error); } catch (error) { if (error instanceof SyntaxError) throw new Error(body); throw error; } }
    download(await response.blob(), `${project.name}.zip`); toast('Your sprite bundle is ready');
  } catch (error) { toast(error.message); }
  finally { button.textContent = original; button.disabled = !valid; }
});
addEventListener('resize', render);
addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
addEventListener('pagehide', keepDraft);
document.addEventListener('visibilitychange', () => { lastTime = 0; if (document.hidden) keepDraft(); });
function tick(time) {
  const delta = lastTime ? time - lastTime : 0; lastTime = time;
  if (project && playing && mode === 'animation' && !document.hidden) {
    const a = project.animations[$('animation').value]; elapsed += delta * Number($('speed').value);
    const nextPosition = animationPosition(project, a, elapsed), next = a.frames[nextPosition];
    if (!a.loop && elapsed >= a.duration) { playing = false; playState(); }
    if (position !== nextPosition) { selected = next; position = nextPosition; render(); }
  }
  requestAnimationFrame(tick);
}
async function boot() {
  try {
    for (const example of examples) {
      const response = await fetch(`/examples/${example.file}.json`); const value = await response.json(), preview = renderProject(value);
      const button = document.createElement('button'); button.className = 'example'; button.dataset.file = example.file;
      const label = document.createElement('span'), strong = document.createElement('strong'), small = document.createElement('small');
      strong.textContent = example.title; small.textContent = example.type; label.append(strong, small);
      button.append(thumbnail(imageCanvas(preview.frames[0].data, preview.width, preview.height), ''), label);
      button.addEventListener('click', () => loadExample(example)); $('examples').append(button);
    }
    $('example-count').textContent = String($('examples').children.length).padStart(2, '0');
    offer = drafts.load();
    if (offer) {
      $('draft-text').textContent = `An unsaved draft of ${offer.name}, last edited ${new Date(offer.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, is kept in this browser. Until you choose, new edits are not kept as a draft.`;
      $('draft').hidden = false;
    }
    const initial = await (await fetch('/project.json')).json();
    if (initial) setSource(initial); else await loadExample(examples[0]);
    playState(); requestAnimationFrame(tick);
  } catch (error) { $('error').hidden = false; $('error').textContent = error.message; $('export').disabled = true; }
}
boot();
