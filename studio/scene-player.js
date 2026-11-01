import { prepareScene, renderScene, sceneImage, withLightSettings, setLightRadius, keysSetRadius } from './scene.js';
import { reviewPixels } from './core.js';
const $ = id => document.getElementById(id);
let scene, time = 0, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches, last, manualScale = false;
// Light fields changed here ("0.height", "ambient"); saving writes only these into the scene as written.
const edited = new Set();
// The lights as the last frame drew them: where a following, flickering or keyed light is at this time.
let shown = [];
const paint = (canvas, data, width, height) => { if (canvas.width !== width) canvas.width = width; if (canvas.height !== height) canvas.height = height; canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0); };
const hex = color => '#' + color.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
const shape = (name, attributes) => { const node = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node; };
// A marker for every light and a dashed ring as far as it reaches, drawn over the enlarged scene.
function marks() {
  const lights = $('lit').checked ? scene.lighting?.lights ?? [] : [], scale = Number($('scale').value), chosen = Number($('light-pick').value);
  $('scene').parentElement.classList.toggle('lit', lights.length > 0);
  $('light-marks').replaceChildren(...lights.flatMap((light, i) => {
    // A sun is everywhere at once, so it has no marker.
    if (light.sun) return [];
    // A light that is off now (its keys at 0, or what it follows hidden) keeps a faint marker so it can still be picked.
    const now = shown[i] ?? light, [x, y] = now.at.map(v => (v + 0.5) * scale), color = hex(light.color), off = now.strength === 0;
    return [shape('circle', { cx: x, cy: y, r: now.radius * scale, fill: 'none', stroke: color, 'stroke-opacity': off ? 0.1 : i === chosen ? 0.7 : 0.3, 'stroke-dasharray': '4 4' }),
      shape('circle', { cx: x, cy: y, r: i === chosen ? 6 : 4, fill: color, 'fill-opacity': off ? 0.35 : 1, stroke: '#080c12', 'stroke-width': 2 })];
  }));
}
// The depth report in words: sorted placements (and rows of sorted tilemaps) far to near and who covers whom, as
// pixel_scene returns them.
function depthReport(depth, at) {
  const sorted = depth.sorted ? `Far to near: ${depth.sorted.map(s => (s.at ? `${s.name} (${s.at.join(', ')}${s.lift ? `, lifted ${s.lift}` : ''})` : `${s.name} row ${s.ground} (${s.tiles} ${s.tiles === 1 ? 'tile' : 'tiles'})`)).join(', ')}${depth.omitted?.sorted ? ` and ${depth.omitted.sorted} more` : ''}.` : 'No placement is sorted by ground.';
  const covers = depth.overlaps.length ? ` Covers: ${depth.overlaps.map(o => `${o.front} covers ${o.behind} (${o.pixels} px)`).join('; ')}${depth.omitted?.overlaps ? `; ${depth.omitted.overlaps} more` : ''}.` : ' Nothing covers a standing placement.';
  $('depth-text').textContent = sorted + covers + (depth.note ? ` ${depth.note}` : '');
  $('depth-mcp').textContent = `pixel_scene {"view": "depth", "time": ${at}}`;
  $('depth-cli').textContent = `pixelbolt scene <scene.json> --image depth.png --view depth --time ${at}`;
}
function draw() {
  const depth = $('depth').checked, scale = Number($('scale').value);
  const view = renderScene(scene, { time, lit: $('lit').checked, density: $('density').checked, depth });
  shown = view.lights ?? [];
  // The depth view is drawn enlarged, so its ground lines stay one screen pixel thin; it fills the same display size.
  if (depth) { const image = sceneImage(view, { mode: 'depth', scale }); paint($('scene'), image.data, image.width, image.height); }
  else paint($('scene'), view.data, view.width, view.height);
  $('depth-report').hidden = !depth;
  if (depth) depthReport(view.depth, Math.round(time));
  paint($('native'), view.data, view.width, view.height);
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
  $('light-pick').replaceChildren(...lights.map((light, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: light.sun ? `${i + 1} (sun)` : String(i + 1) })));
  const selected = () => lights[Number($('light-pick').value)];
  // Position sliders reach a scene's width or height beyond each side, and always hold every light that has a position.
  const placed = lights.filter(light => !light.sun);
  const ranges = [scene.width, scene.height].map((size, axis) => [Math.max(-4096, Math.min(-size, ...placed.map(light => light.at[axis]))), Math.min(4096, Math.max(size * 2, ...placed.map(light => light.at[axis])))]);
  const sync = () => {
    const light = selected(), sun = Boolean(light.sun), keyed = !sun && keysSetRadius(scene, Number($('light-pick').value));
    // A sun has no position, height or reach: its X and Y are how far a shadow falls per pixel of height.
    for (const [axis, id] of [[0, 'light-x'], [1, 'light-y']]) {
      Object.assign($(id), sun ? { min: '-8', max: '8', step: '0.05' } : { min: String(ranges[axis][0]), max: String(ranges[axis][1]), step: '1' });
      $(id).value = sun ? light.sun[axis] : light.at[axis];
      $(`${id}-name`).textContent = `${sun ? 'Shadow' : 'Light'} ${axis ? 'Y' : 'X'}`;
    }
    if (!sun) { $('light-height').value = light.height; $('light-radius').value = light.radius; }
    $('light-color').value = hex(light.color); $('ambient').value = scene.lighting.ambient;
    // When each of the light's keys sets its own radius, the light's radius changes nothing, so its slider is off.
    $('light-height').disabled = sun; $('light-height').title = sun ? 'A sun is too far away to have a height; its shadow X and Y set how high it stands' : '';
    $('light-radius').disabled = sun || keyed; $('light-radius').title = sun ? 'A sun reaches everywhere' : keyed ? "Each of this light's keys sets its radius" : '';
    $('light-height-value').value = sun ? 'sun' : `${light.height} px`; $('light-radius-value').value = sun ? 'everywhere' : keyed ? 'set by keys' : `${light.radius} px`; $('ambient-value').value = `${Math.round(scene.lighting.ambient * 100)}%`;
  };
  const change = (field, apply) => { apply(); edited.add(field === 'ambient' ? field : `${$('light-pick').value}.${field}`); sync(); draw(); };
  for (const [axis, id] of [[0, 'light-x'], [1, 'light-y']]) $(id).oninput = () => {
    const light = selected();
    change(light.sun ? 'sun' : 'at', () => { (light.sun ?? light.at)[axis] = Number($(id).value); });
  };
  $('light-height').oninput = () => change('height', () => { selected().height = Number($('light-height').value); });
  $('light-radius').oninput = () => change('radius', () => setLightRadius(scene, Number($('light-pick').value), Number($('light-radius').value)));
  $('light-color').oninput = () => change('color', () => { const value = $('light-color').value; selected().color = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).concat(255); });
  $('ambient').oninput = () => change('ambient', () => { scene.lighting.ambient = Number($('ambient').value); });
  $('light-pick').onchange = () => { sync(); marks(); };
  // Pressing on the scene moves the chosen light there, or picks up the light whose marker is under the pointer;
  // it follows the pointer until release.
  const toScene = event => {
    const box = canvas.getBoundingClientRect(), clamp = (value, axis) => Math.max(ranges[axis][0], Math.min(ranges[axis][1], value));
    return [clamp(Math.floor((event.clientX - box.left) / box.width * scene.width), 0), clamp(Math.floor((event.clientY - box.top) / box.height * scene.height), 1)];
  };
  canvas.addEventListener('pointerdown', event => {
    if (!$('lit').checked || event.button !== 0) return;
    const point = toScene(event), reach = 8 / Number($('scale').value);
    const near = lights.findIndex((light, i) => { const now = shown[i] ?? light; return !light.sun && Math.hypot(now.at[0] - point[0], now.at[1] - point[1]) <= reach; });
    if (near >= 0) { $('light-pick').value = String(near); sync(); }
    // A sun is moved with its sliders, not by dragging.
    if (selected().sun) return;
    canvas.setPointerCapture(event.pointerId);
    // A light is shown where the scene puts it on screen: a following light's `at` is an offset from what it follows,
    // and a camera moves every light, so dragging keeps that difference and moves `at` by as much as the pointer.
    const light = selected(), now = shown[Number($('light-pick').value)];
    const base = now ? [now.at[0] - light.at[0], now.at[1] - light.at[1]] : [0, 0];
    const move = moved => change('at', () => { const [x, y] = toScene(moved); selected().at = [x - base[0], y - base[1]]; });
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
  // The studio also serves the scene as written, before its asset and palette files were read in, and light settings are
  // saved into that, so the saved scene still names those files. An exported scene's folder has only the resolved one.
  const written = response.headers.has('X-Pixelbolt-Scene-Source') ? await (async () => {
    const kept = await fetch('./scene-source.json'); if (!kept.ok) throw new Error(`Scene source could not load (${kept.status})`);
    return kept.json();
  })() : source;
  const fit = () => { if (!manualScale) $('scale').value = String(Math.min(3, Math.max(1, Math.floor((document.querySelector('.stage').clientWidth - 40) / scene.width)))); };
  fit(); addEventListener('resize', () => { fit(); draw(); });
  $('name').textContent = source.name.replaceAll('-', ' '); $('time').max = scene.duration - 1;
  $('play').onclick = () => { playing = !playing; last = undefined; playState(); };
  $('time').oninput = () => { time = Number($('time').value); playing = false; playState(); draw(); };
  for (const id of ['lit', 'density', 'depth']) $(id).onchange = draw;
  $('scale').onchange = () => { manualScale = true; draw(); };
  if (scene.lighting?.lights.length) lightControls();
  $('save').onclick = () => {
    const saved = withLightSettings(written, scene, edited);
    const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${source.name}.scene.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.addEventListener('visibilitychange', () => { last = undefined; });
  playState(); draw();
  function tick(now) { if (playing && !document.hidden) { time = (time + (last === undefined ? 0 : now - last)) % scene.duration; draw(); } last = now; requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
} catch (error) { $('error').textContent = error.message; }
