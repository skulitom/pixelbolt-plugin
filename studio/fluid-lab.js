// The fluid lab: picks a preset fluid source, runs the same compiler the CLI and MCP use, right here in the browser,
// and plays the result. A few sliders change the preset's settings; downloads give the GIF, the sprite sheet, the
// compiled recipe and the edited source, and the panel shows the matching command line and MCP calls.
import { compileFluid } from '/fluid.js';
import { renderProject, buildAtlas } from '/core.js';
import { animationGIF } from '/gif.js';
import { FLUID_PRESETS, fluidEffect, fluidSliders, editedSource } from '/fluid-controls.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas'), context = canvas.getContext('2d');
const PRESETS = FLUID_PRESETS;
const HOLD = 600, reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const round = value => Math.round(value * 1000) / 1000;
let preset = null, effectName = '', values = {}, seed = 1, project = null, recipe = null, frames = [], position = 0, nextAt = 0, playing = !reducedMotion, timer, toastTimer, version = 0;

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
function download(data, filename, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const effectOf = fluidEffect;
const sliders = () => fluidSliders(preset.source);
// The preset with the sliders and seed applied (fluid-controls.js).
const edited = () => editedSource(preset.source, values, seed);

function draw() {
  if (!project) return;
  const scale = Number($('scale').value);
  canvas.width = project.width; canvas.height = project.height;
  canvas.style.width = `${project.width * scale}px`; canvas.style.height = `${project.height * scale}px`;
  context.imageSmoothingEnabled = false;
  context.fillStyle = $('backdrop').value; context.fillRect(0, 0, project.width, project.height);
  context.drawImage(frames[position], 0, 0);
  const count = project.animations[effectName].frames.length;
  $('frame').textContent = `${String(position + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`;
}
function tick(now) {
  if (playing && project && now >= nextAt) {
    const animation = project.animations[effectName], last = position === animation.frames.length - 1;
    position = last ? 0 : position + 1;
    // One-shot effects pause on their last frame before playing again, as the README GIFs do.
    nextAt = now + project.frames[animation.frames[position]].duration + (!animation.loop && position === animation.frames.length - 1 ? HOLD : 0);
    draw();
  }
  requestAnimationFrame(tick);
}
function playState() { $('play').textContent = playing ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation'); }

function commands() {
  const file = preset.file, background = $('backdrop').value, scale = $('scale').value;
  $('cli').textContent = [`pixelbolt compile ${file}.fluid.json --out ${file}.json`, `pixelbolt gif ${file}.json --scale ${scale} --background "${background}" --out ${file}.gif`, `pixelbolt render ${file}.json --out ${file}`].join('\n');
  $('mcp').textContent = [`pixel_compile { "source": <${file}.fluid.json>, "metadata": true }`, `pixel_render { "revision": <from pixel_compile>, "gif": { "scale": ${scale}, "background": "${background}" } }`].join('\n');
}
// Runs the simulation for the current settings. It runs on this page's thread; the presets take well under a second.
function compile() {
  clearTimeout(timer);
  const source = edited(), started = performance.now();
  try {
    const compiled = compileFluid(source), ms = Math.round(performance.now() - started);
    recipe = compiled.recipe; project = renderProject(recipe);
    frames = project.animations[effectName].frames.map(index => {
      const frame = project.frames[index], c = document.createElement('canvas'); c.width = project.width; c.height = project.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data), project.width, project.height), 0, 0); return c;
    });
    position = Math.min(position, frames.length - 1); nextAt = 0;
    const animation = project.animations[effectName], effect = compiled.metadata.effects[effectName], colors = new Set();
    for (const frame of project.frames) for (let i = 0; i < frame.data.length; i += 4) if (frame.data[i + 3]) colors.add(frame.data[i] << 16 | frame.data[i + 1] << 8 | frame.data[i + 2]);
    $('status').textContent = `${animation.frames.length} frames of ${project.frames[0].duration} ms · ${animation.loop ? 'loops seamlessly' : 'plays once'} · ${colors.size} palette colours · ${effect.particles ? `${effect.particles} particles · ` : ''}simulated in ${ms} ms in this browser`;
    $('error').hidden = true;
    for (const id of ['gif', 'sheet', 'recipe']) $(id).disabled = false;
    draw();
  } catch (error) {
    $('error').textContent = error.message; $('error').hidden = false;
    for (const id of ['gif', 'sheet', 'recipe']) $(id).disabled = true;
  }
}
const later = () => { clearTimeout(timer); $('status').textContent = 'Simulating…'; timer = setTimeout(compile, 150); };

function showSliders() {
  const effect = effectOf(preset.source);
  $('sliders').replaceChildren(...sliders().map(slider => {
    const label = document.createElement('label'), name = document.createElement('span'), output = document.createElement('output'), input = document.createElement('input');
    const show = slider.show ?? (v => String(round(v)));
    values[slider.key] = slider.initial(effect);
    Object.assign(input, { type: 'range', id: `slider-${slider.key}`, min: slider.min, max: slider.max, step: slider.step, value: values[slider.key] });
    name.textContent = slider.label; output.textContent = show(values[slider.key]); output.htmlFor = input.id;
    input.addEventListener('input', () => { values[slider.key] = Number(input.value); output.textContent = show(values[slider.key]); later(); });
    label.append(name, output, input);
    return label;
  }));
  seed = effect.seed ?? 1; $('seed').value = String(seed);
}
async function choose(entry) {
  const mine = ++version;
  try {
    const response = await fetch(`/examples/${entry.file}.fluid.json`);
    if (!response.ok) throw new Error(`Could not load ${entry.title}: HTTP ${response.status}`);
    const source = await response.json();
    if (mine !== version) return;
    preset = { ...entry, source }; effectName = Object.keys(source.effects)[0]; position = 0;
    const effect = effectOf(source);
    $('name').textContent = entry.title; $('kind').textContent = effect.kind === 'liquid' ? `Liquid · ${effect.apic ? 'APIC' : 'FLIP'} particles` : 'Gas · stable fluids';
    $('size').textContent = `${source.width} × ${source.height} px`;
    document.querySelectorAll('#presets .example').forEach(button => { const active = button.dataset.file === entry.file; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    history.replaceState(null, '', `#${entry.file}`);
    showSliders(); commands(); compile();
  } catch (error) { toast(error.message); }
}

for (const entry of PRESETS) {
  const button = document.createElement('button'), label = document.createElement('span'), strong = document.createElement('strong'), small = document.createElement('small');
  button.className = 'example'; button.dataset.file = entry.file; button.setAttribute('aria-pressed', 'false');
  strong.textContent = entry.title; small.textContent = entry.note; label.append(strong, small); button.append(label);
  button.addEventListener('click', () => choose(entry));
  $('presets').append(button);
}
$('preset-count').textContent = String(PRESETS.length).padStart(2, '0');
$('play').addEventListener('click', () => { playing = !playing; playState(); });
for (const id of ['scale', 'backdrop']) $(id).addEventListener('change', () => { draw(); commands(); });
$('seed').addEventListener('change', () => { const value = Number($('seed').value); if (Number.isInteger(value) && value >= 0 && value <= 2147483647) { seed = value; later(); } else $('seed').value = String(seed); });
$('reseed').addEventListener('click', () => { seed = (seed + 1) % 2147483648; $('seed').value = String(seed); later(); });
$('reset').addEventListener('click', () => { showSliders(); compile(); });
$('gif').addEventListener('click', () => {
  if (!project) return;
  try { const gif = animationGIF(project, effectName, { scale: Number($('scale').value), background: $('backdrop').value }); download(gif.data, `${preset.file}.gif`, 'image/gif'); toast(`Saved ${preset.file}.gif · ${gif.width} × ${gif.height}, ${gif.colors} colours`); }
  catch (error) { toast(error.message); }
});
$('sheet').addEventListener('click', () => {
  if (!project) return;
  const atlas = buildAtlas(project), c = document.createElement('canvas'); c.width = atlas.width; c.height = atlas.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(atlas.data), atlas.width, atlas.height), 0, 0);
  c.toBlob(blob => download(blob, `${preset.file}-sheet.png`), 'image/png');
});
$('recipe').addEventListener('click', () => { if (recipe) download(JSON.stringify(recipe, null, 2) + '\n', `${preset.file}.json`, 'application/json'); });
$('fluid-source').addEventListener('click', () => { if (preset) download(JSON.stringify(edited(), null, 2) + '\n', `${preset.file}.fluid.json`, 'application/json'); });
playState();
choose(PRESETS.find(entry => entry.file === location.hash.slice(1)) ?? PRESETS[0]);
requestAnimationFrame(tick);
