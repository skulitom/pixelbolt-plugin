import { prepareScene, renderScene } from './scene.js';
import { reviewPixels } from './core.js';
const $ = id => document.getElementById(id);
let scene, time = 0, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches, last, manualScale = false;
// Light fields changed here ("0.height", "ambient"); saving writes them back into the scene source.
const edited = new Set();
const paint = (canvas, data, width, height) => { if (canvas.width !== width) canvas.width = width; if (canvas.height !== height) canvas.height = height; canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0); };
const hex = color => '#' + color.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
const shape = (name, attributes) => { const node = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node; };
// A marker for every light and a dashed ring as far as it reaches, drawn over the enlarged scene.
function marks() {
  const lights = $('lit').checked ? scene.lighting?.lights ?? [] : [], scale = Number($('scale').value), chosen = Number($('light-pick').value);
  $('scene').parentElement.classList.toggle('lit', lights.length > 0);
  $('light-marks').replaceChildren(...lights.flatMap((light, i) => {
    const [x, y] = light.at.map(v => (v + 0.5) * scale), color = hex(light.color);
    return [shape('circle', { cx: x, cy: y, r: light.radius * scale, fill: 'none', stroke: color, 'stroke-opacity': i === chosen ? 0.7 : 0.3, 'stroke-dasharray': '4 4' }),
      shape('circle', { cx: x, cy: y, r: i === chosen ? 6 : 4, fill: color, stroke: '#080c12', 'stroke-width': 2 })];
  }));
}
function draw() {
  const view = renderScene(scene, { time, lit: $('lit').checked, density: $('density').checked });
  paint($('scene'), view.data, view.width, view.height); paint($('native'), view.data, view.width, view.height);
  paint($('values'), reviewPixels(view.data, 'grayscale'), view.width, view.height);
  $('scene').style.width = `${view.width * Number($('scale').value)}px`; $('scene').style.height = `${view.height * Number($('scale').value)}px`;
  $('time').value = time; $('clock').value = `${Math.round(time)} ms`; $('warnings').textContent = view.warnings.join(' ');
  marks();
}
function playState() { $('play').textContent = playing ? 'Pause' : 'Play'; }
function lightControls() {
  // Every light is adjustable: pick one, then drag it on the scene or use the sliders.
  const lights = scene.lighting.lights, canvas = $('scene');
  $('lights').hidden = false;
  $('light-pick').replaceChildren(...lights.map((_, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: String(i + 1) })));
  const selected = () => lights[Number($('light-pick').value)];
  // Position sliders reach a scene's width or height beyond each side, and always hold every light.
  for (const [axis, id, size] of [[0, 'light-x', scene.width], [1, 'light-y', scene.height]]) {
    $(id).min = String(Math.max(-4096, Math.min(-size, ...lights.map(light => light.at[axis])))); $(id).max = String(Math.min(4096, Math.max(size * 2, ...lights.map(light => light.at[axis]))));
  }
  const sync = () => {
    const light = selected();
    $('light-x').value = light.at[0]; $('light-y').value = light.at[1]; $('light-height').value = light.height; $('light-radius').value = light.radius;
    $('light-color').value = hex(light.color); $('ambient').value = scene.lighting.ambient;
    $('light-height-value').value = `${light.height} px`; $('light-radius-value').value = `${light.radius} px`; $('ambient-value').value = `${Math.round(scene.lighting.ambient * 100)}%`;
  };
  const change = (field, apply) => { apply(); edited.add(field === 'ambient' ? field : `${$('light-pick').value}.${field}`); sync(); draw(); };
  $('light-x').oninput = () => change('at', () => { selected().at[0] = Number($('light-x').value); });
  $('light-y').oninput = () => change('at', () => { selected().at[1] = Number($('light-y').value); });
  $('light-height').oninput = () => change('height', () => { selected().height = Number($('light-height').value); });
  $('light-radius').oninput = () => change('radius', () => { selected().radius = Number($('light-radius').value); });
  $('light-color').oninput = () => change('color', () => { const value = $('light-color').value; selected().color = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).concat(255); });
  $('ambient').oninput = () => change('ambient', () => { scene.lighting.ambient = Number($('ambient').value); });
  $('light-pick').onchange = () => { sync(); marks(); };
  // Pressing on the scene moves the chosen light there, or picks up the light whose marker is under the pointer;
  // it follows the pointer until release.
  const toScene = event => {
    const box = canvas.getBoundingClientRect(), clamp = (value, id) => Math.max(Number($(id).min), Math.min(Number($(id).max), value));
    return [clamp(Math.floor((event.clientX - box.left) / box.width * scene.width), 'light-x'), clamp(Math.floor((event.clientY - box.top) / box.height * scene.height), 'light-y')];
  };
  canvas.addEventListener('pointerdown', event => {
    if (!$('lit').checked || event.button !== 0) return;
    const point = toScene(event), reach = 8 / Number($('scale').value);
    const near = lights.findIndex(light => Math.hypot(light.at[0] - point[0], light.at[1] - point[1]) <= reach);
    if (near >= 0) $('light-pick').value = String(near);
    canvas.setPointerCapture(event.pointerId);
    const move = moved => change('at', () => { selected().at = toScene(moved); });
    move(event);
    canvas.onpointermove = moved => { if (canvas.hasPointerCapture(moved.pointerId)) move(moved); };
    canvas.onpointerup = canvas.onpointercancel = () => { canvas.onpointermove = null; };
    event.preventDefault();
  });
  sync();
}
try {
  const response = await fetch('./scene.json'); if (!response.ok) throw new Error(`Scene could not load (${response.status})`);
  const source = await response.json(); scene = prepareScene(source);
  const fit = () => { if (!manualScale) $('scale').value = String(Math.min(3, Math.max(1, Math.floor((document.querySelector('.stage').clientWidth - 40) / scene.width)))); };
  fit(); addEventListener('resize', () => { fit(); draw(); });
  $('name').textContent = source.name.replaceAll('-', ' '); $('time').max = scene.duration - 1;
  $('play').onclick = () => { playing = !playing; last = undefined; playState(); };
  $('time').oninput = () => { time = Number($('time').value); playing = false; playState(); draw(); };
  for (const id of ['lit', 'density']) $(id).onchange = draw;
  $('scale').onchange = () => { manualScale = true; draw(); };
  if (scene.lighting?.lights.length) lightControls();
  $('save').onclick = () => {
    const saved = structuredClone(source);
    scene.lighting.lights.forEach((light, i) => {
      const target = saved.lighting.lights[i];
      target.at = [...light.at];
      if (edited.has(`${i}.height`)) target.height = light.height;
      if (edited.has(`${i}.radius`)) target.radius = light.radius;
      if (edited.has(`${i}.color`)) target.color = hex(light.color);
    });
    if (edited.has('ambient')) saved.lighting.ambient = scene.lighting.ambient;
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${source.name}.scene.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.addEventListener('visibilitychange', () => { last = undefined; });
  playState(); draw();
  function tick(now) { if (playing && !document.hidden) { time = (time + (last === undefined ? 0 : now - last)) % scene.duration; draw(); } last = now; requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
} catch (error) { $('error').textContent = error.message; }
