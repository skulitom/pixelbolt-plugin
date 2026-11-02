// The Effects lab: picks a preset pixelforge-fx source, runs the same compiler the CLI and MCP use, right here in the
// browser, and plays one of its effects. Strength, Speed and Seed change the chosen effect; downloads give the GIF, the
// sprite sheet, the compiled recipe and the edited source, and the panel shows the matching command line and MCP calls.
import { compileEffects } from '/fx.js';
import { renderProject, buildAtlas } from '/core.js';
import { animationGIF } from '/gif.js';
import { EFFECT_PRESETS, EFFECT_SLIDERS, effectOf, editedEffects } from '/effects-controls.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas'), context = canvas.getContext('2d');
const HOLD = 600, reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Settings belong to an effect of the chosen source: { strength, speed, seed } by effect name, kept while you switch.
let preset = null, animation = '', settings = {}, metadata = null, project = null, recipe = null, warnings = [], frames = [], position = 0, nextAt = 0, playing = !reducedMotion, timer, toastTimer, version = 0;

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
function download(data, filename, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
// The effect the controls edit: the one chosen, or the effect a turned copy or a back or front part was made from.
const base = () => (metadata ? effectOf(metadata, animation) : Object.keys(preset.source.effects)[0]);
const restOf = name => ({ strength: 1, speed: 1, seed: preset.source.effects[name].seed ?? 1 });
const settingsOf = name => (settings[name] ??= restOf(name));
// The preset with every effect's settings applied, in source order.
function edited() {
  let source = preset.source;
  for (const name of Object.keys(source.effects)) if (settings[name]) source = editedEffects(source, name, settings[name], settings[name].seed);
  return source;
}

function draw() {
  if (!project || !frames.length) return;
  const scale = Number($('scale').value);
  canvas.width = project.width; canvas.height = project.height;
  canvas.style.width = `${project.width * scale}px`; canvas.style.height = `${project.height * scale}px`;
  context.imageSmoothingEnabled = false;
  context.fillStyle = $('backdrop').value; context.fillRect(0, 0, project.width, project.height);
  context.drawImage(frames[position], 0, 0);
  $('frame').textContent = `${String(position + 1).padStart(2, '0')} / ${String(frames.length).padStart(2, '0')}`;
}
function tick(now) {
  if (playing && project && frames.length && now >= nextAt) {
    const playback = project.animations[animation], last = position === frames.length - 1;
    position = last ? 0 : position + 1;
    // One-shot effects pause on their last frame before playing again.
    nextAt = now + project.frames[playback.frames[position]].duration + (!playback.loop && position === frames.length - 1 ? HOLD : 0);
    draw();
  }
  requestAnimationFrame(tick);
}
function playState() { $('play').textContent = playing ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation'); }

function commands() {
  const file = preset.file, background = $('backdrop').value, scale = $('scale').value;
  $('cli').textContent = [`pixelbolt compile ${file}.fx.json --out ${file}.json`, `pixelbolt gif ${file}.json --animation ${animation} --scale ${scale} --background "${background}" --out ${animation}.gif`, `pixelbolt render ${file}.json --out ${file}`].join('\n');
  $('mcp').textContent = [`pixel_compile { "source": <${file}.fx.json>, "metadata": true }`, `pixel_render { "revision": <from pixel_compile>, "animation": "${animation}", "gif": { "scale": ${scale}, "background": "${background}" } }`].join('\n');
}
function showAnimations() {
  $('animation').replaceChildren(...Object.keys(project.animations).map(name => Object.assign(document.createElement('option'), { value: name, textContent: name, selected: name === animation })));
}
function showFrames() {
  frames = project.animations[animation].frames.map(index => {
    const frame = project.frames[index], c = document.createElement('canvas'); c.width = project.width; c.height = project.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data), project.width, project.height), 0, 0); return c;
  });
  position = Math.min(position, frames.length - 1); nextAt = 0;
  const playback = project.animations[animation], effect = metadata.effects[animation], colors = new Set(), spawned = (effect.emitters ?? []).reduce((sum, e) => sum + e.spawned, 0);
  for (const index of playback.frames) { const data = project.frames[index].data; for (let i = 0; i < data.length; i += 4) if (data[i + 3]) colors.add(data[i] << 16 | data[i + 1] << 8 | data[i + 2]); }
  $('status').dataset.effect = animation;
  $('status').textContent = `${frames.length} frames · ${playback.loop === false ? 'plays once' : 'loops'} · ${colors.size} palette colours · ${spawned ? `${spawned} particles · ` : ''}${effect.layers ? `${effect.layers.length} shape layers · ` : ''}compiled in ${$('status').dataset.ms} ms in this browser`;
  // The compiler's review of the chosen effect: a loop that jumps, or drawing cut off at a canvas edge (another seed can do it).
  const mine = warnings.filter(text => text.startsWith(`fx.effects.${base()}:`)).map(text => text.slice(text.indexOf(':') + 2));
  $('warnings').textContent = mine.join('\n'); $('warnings').hidden = !mine.length;
  commands(); draw();
}
// Compiles the source with the current settings. It runs on this page's thread; the presets take well under a second.
function compile() {
  clearTimeout(timer);
  const source = edited(), started = performance.now();
  try {
    const compiled = compileEffects(source);
    $('status').dataset.ms = String(Math.round(performance.now() - started));
    recipe = compiled.recipe; metadata = compiled.metadata; warnings = compiled.warnings ?? []; project = renderProject(recipe);
    if (!project.animations[animation]) animation = Object.keys(project.animations)[0];
    $('error').hidden = true;
    for (const id of ['gif', 'sheet', 'recipe']) $(id).disabled = false;
    showAnimations(); showFrames();
  } catch (error) {
    $('error').textContent = error.message; $('error').hidden = false; $('warnings').hidden = true;
    for (const id of ['gif', 'sheet', 'recipe']) $(id).disabled = true;
  }
}
const later = () => { clearTimeout(timer); $('status').textContent = 'Compiling…'; timer = setTimeout(compile, 150); };

function showSliders() {
  const values = settingsOf(base());
  $('sliders').replaceChildren(...EFFECT_SLIDERS.map(slider => {
    const label = document.createElement('label'), name = document.createElement('span'), output = document.createElement('output'), input = document.createElement('input');
    Object.assign(input, { type: 'range', id: `slider-${slider.key}`, min: slider.min, max: slider.max, step: slider.step, value: values[slider.key] });
    name.textContent = slider.label; output.textContent = slider.show(values[slider.key]); output.htmlFor = input.id;
    input.addEventListener('input', () => { settingsOf(base())[slider.key] = Number(input.value); output.textContent = slider.show(Number(input.value)); later(); });
    label.append(name, output, input);
    return label;
  }));
  $('seed').value = String(values.seed);
}
async function choose(entry) {
  const mine = ++version;
  try {
    const response = await fetch(`/examples/${entry.file}.fx.json`);
    if (!response.ok) throw new Error(`Could not load ${entry.title}: HTTP ${response.status}`);
    const source = await response.json();
    if (mine !== version) return;
    preset = { ...entry, source }; settings = {}; metadata = null; position = 0;
    animation = Object.keys(source.effects)[0];
    $('name').textContent = entry.title; $('kind').textContent = entry.note;
    $('size').textContent = `${source.width} × ${source.height} px`;
    document.querySelectorAll('#presets .example').forEach(button => { const active = button.dataset.file === entry.file; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    history.replaceState(null, '', `#${entry.file}`);
    showSliders(); compile();
  } catch (error) { toast(error.message); }
}

for (const entry of EFFECT_PRESETS) {
  const button = document.createElement('button'), label = document.createElement('span'), strong = document.createElement('strong'), small = document.createElement('small');
  button.className = 'example'; button.dataset.file = entry.file; button.setAttribute('aria-pressed', 'false');
  strong.textContent = entry.title; small.textContent = entry.note; label.append(strong, small); button.append(label);
  button.addEventListener('click', () => choose(entry));
  $('presets').append(button);
}
$('preset-count').textContent = String(EFFECT_PRESETS.length).padStart(2, '0');
$('play').addEventListener('click', () => { playing = !playing; playState(); });
$('animation').addEventListener('change', () => { animation = $('animation').value; position = 0; showSliders(); showFrames(); });
for (const id of ['scale', 'backdrop']) $(id).addEventListener('change', () => { draw(); commands(); });
$('seed').addEventListener('change', () => { const value = Number($('seed').value), values = settingsOf(base()); if (Number.isInteger(value) && value >= 0 && value <= 2147483647) { values.seed = value; later(); } else $('seed').value = String(values.seed); });
$('reseed').addEventListener('click', () => { const values = settingsOf(base()); values.seed = (values.seed + 1) % 2147483648; $('seed').value = String(values.seed); later(); });
$('reset').addEventListener('click', () => { settings[base()] = restOf(base()); showSliders(); compile(); });
$('gif').addEventListener('click', () => {
  if (!project) return;
  try { const gif = animationGIF(project, animation, { scale: Number($('scale').value), background: $('backdrop').value }); download(gif.data, `${animation}.gif`, 'image/gif'); toast(`Saved ${animation}.gif · ${gif.width} × ${gif.height}, ${gif.colors} colours`); }
  catch (error) { toast(error.message); }
});
$('sheet').addEventListener('click', () => {
  if (!project) return;
  const atlas = buildAtlas(project), c = document.createElement('canvas'); c.width = atlas.width; c.height = atlas.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(atlas.data), atlas.width, atlas.height), 0, 0);
  c.toBlob(blob => download(blob, `${preset.file}-sheet.png`), 'image/png');
});
$('recipe').addEventListener('click', () => { if (recipe) download(JSON.stringify(recipe, null, 2) + '\n', `${preset.file}.json`, 'application/json'); });
$('fx-source').addEventListener('click', () => { if (preset) download(JSON.stringify(edited(), null, 2) + '\n', `${preset.file}.fx.json`, 'application/json'); });
playState();
choose(EFFECT_PRESETS.find(entry => entry.file === location.hash.slice(1)) ?? EFFECT_PRESETS[0]);
requestAnimationFrame(tick);
