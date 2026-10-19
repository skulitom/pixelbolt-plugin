// Bounded scene review, not a game engine. In-memory recipes only; no filesystem or network access.
import { PixelError, renderProject, parseColor, animationPosition, tileRepeat, tileReport, rampShifter } from './core.js';
import { EASINGS, ease, pixelId } from './craft.js';
import { fields, point } from './authoring.js';
import { expandTilemap } from './autotile.js';

const fail = (path, message) => { throw new PixelError(path, message); };
const int = (v, min, max, path) => { if (!Number.isInteger(v) || v < min || v > max) fail(path, `expected an integer from ${min} to ${max}`); return v; };
const alphaOver = (target, at, color) => {
  if (color[3] === 255) { target.set(color, at); return; }
  const alpha = color[3] / 255; if (!alpha) return;
  const old = target[at + 3] / 255, out = alpha + old * (1 - alpha);
  for (let c = 0; c < 3; c++) target[at + c] = Math.round((color[c] * alpha + target[at + c] * old * (1 - alpha)) / out);
  target[at + 3] = Math.round(out * 255);
};
// Material passes must agree on the recipe's sheet settings; trimmed layouts may differ and are rebuilt as grids.
const sheetSettings = sheet => JSON.stringify([sheet.columns, sheet.padding, sheet.scale, Boolean(sheet.trim)]);
const MAX_DRAWS = 4096, MAX_WORK = 4194304;

// Expands a tilemap placement into cells of one asset's frames and animations (see expandTilemap in autotile.js).
function sceneTilemap(tilemap, project, path) {
  fields(tilemap, ['tile', 'rows', 'legend', 'outside', 'empty', 'classes', 'seed'], path);
  const tile = point(tilemap.tile ?? [project.width, project.height], `${path}.tile`, 256);
  if (tile.some(n => n < 1)) fail(`${path}.tile`, 'tile size must be positive');
  const frames = new Set(project.frames.map(f => f.name));
  const expanded = expandTilemap(tilemap, { path, fail, kinds: ['frame', 'animation'], text: 'frame', masked: () => true,
    exists: (kind, name) => kind === 'frame' ? frames.has(name) : Object.hasOwn(project.animations, name) });
  return { tile, cells: expanded.cells.map(cell => ({ x: cell.x * tile[0], y: cell.y * tile[1], [cell.kind]: cell.name })), columns: expanded.columns, rows: expanded.rows };
}

// A theme: palette overrides for keys the recipe already has, from the scene and then from the asset entry.
function themed(spec, ...overrides) {
  if (!overrides.some(Boolean) || !spec || typeof spec !== 'object' || !spec.palette || typeof spec.palette !== 'object') return spec;
  const palette = { ...spec.palette };
  for (const map of overrides) for (const [key, value] of Object.entries(map ?? {})) if (Object.hasOwn(palette, key)) palette[key] = value;
  return { ...spec, palette };
}
// Theme colours are checked where they are written; file references are resolved by the CLI and MCP.
const paletteMap = (value, path) => {
  if (value === undefined) return null;
  if (typeof value === 'string') fail(path, 'palette files are resolved by the CLI and MCP; inline the palette to render here');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected a map of palette keys to colours');
  for (const [key, colour] of Object.entries(value)) parseColor(colour, {}, `${path}.${key}`);
  return value;
};

export function prepareScene(source) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'background', 'duration', 'palette', 'cues', 'assets', 'instances', 'lighting'], 'scene');
  if (source.format !== 'pixelforge-scene' || source.version !== 1) fail('scene', 'expected version-1 pixelforge-scene');
  const width = int(source.width, 1, 256, 'scene.width'), height = int(source.height, 1, 256, 'scene.height');
  const duration = int(source.duration ?? 2000, 1, 60000, 'scene.duration');
  // Reuse portable name validation.
  renderProject({ version: 1, name: source.name, width: 1, height: 1, frames: [{ name: 'check' }] });
  const background = parseColor(source.background ?? '#10121e');
  const scenePalette = paletteMap(source.palette, 'scene.palette');
  // Named times: a cue or trajectory key may say "strike" or "strike+90" instead of a number, so related events are
  // written as one time and offsets.
  const cues = Object.create(null);
  if (source.cues !== undefined) {
    if (!source.cues || typeof source.cues !== 'object' || Array.isArray(source.cues) || Object.keys(source.cues).length > 64) fail('scene.cues', 'expected at most 64 named times in milliseconds');
    for (const [key, value] of Object.entries(source.cues)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) fail(`scene.cues.${key}`, 'use 1–64 letters, digits, underscores or hyphens, starting with a letter');
      cues[key] = int(value, 0, duration, `scene.cues.${key}`);
    }
  }
  const when = (value, path, max) => {
    if (typeof value === 'string') {
      // A cue name may itself contain hyphens and digits, so an exact name wins over name-plus-offset.
      const parts = Object.hasOwn(cues, value) ? [value, value] : /^([a-zA-Z][a-zA-Z0-9_-]{0,63}?)([+-])(\d{1,5})$/.exec(value);
      if (!parts || !Object.hasOwn(cues, parts[1])) fail(path, `expected milliseconds or a named cue such as "strike" or "strike+90"; ${JSON.stringify(parts ? parts[1] : value)} is not in scene.cues`);
      const time = cues[parts[1]] + (parts[2] === '-' ? -1 : 1) * Number(parts[3] ?? 0);
      if (time < 0 || time > max) fail(path, `${JSON.stringify(value)} is ${time} ms, outside 0–${max}`);
      return time;
    }
    return int(value, 0, max, path);
  };
  if (!source.assets || Array.isArray(source.assets) || typeof source.assets !== 'object' || Object.keys(source.assets).length > 64) fail('scene.assets', 'expected at most 64 inlined assets');
  // Ramp shifters per asset (kept apart from the passes, which exports iterate as images).
  const assets = Object.create(null), shifts = Object.create(null), warnings = []; let sourceArea = 0;
  for (const [id, value] of Object.entries(source.assets)) {
    if (typeof value === 'string' || typeof value?.recipe === 'string' || typeof value?.normal === 'string' || typeof value?.emissive === 'string' || value?.revision !== undefined) fail(`scene.assets.${id}`, 'file and revision references are resolved by the CLI and MCP; inline the recipe to render here');
    const entry = value?.recipe ? value : { recipe: value };
    fields(entry, ['recipe', 'normal', 'emissive', 'palette'], `scene.assets.${id}`);
    const assetPalette = paletteMap(entry.palette, `scene.assets.${id}.palette`);
    const passes = {};
    for (const key of ['recipe', 'normal', 'emissive']) if (entry[key] !== undefined) {
      const spec = key === 'recipe' ? themed(entry[key], scenePalette, assetPalette) : entry[key];
      const area = spec?.width * spec?.height * spec?.frames?.length;
      if (!Number.isFinite(area) || (sourceArea += area) > 4194304) fail(`scene.assets.${id}`, 'combined scene source passes exceed 4,194,304 pixels or have invalid dimensions');
      passes[key] = renderProject(spec);
      warnings.push(...passes[key].warnings.map(message => `${id}.${key}: ${message}`));
    }
    const base = passes.recipe;
    for (const key of ['normal', 'emissive']) if (passes[key]) {
      const p = passes[key];
      if (p.width !== base.width || p.height !== base.height || sheetSettings(p.sheet) !== sheetSettings(base.sheet) || JSON.stringify(p.frames.map(f => [f.name, f.duration])) !== JSON.stringify(base.frames.map(f => [f.name, f.duration])) || JSON.stringify(p.animations) !== JSON.stringify(base.animations)) fail(`scene.assets.${id}.${key}`, 'material passes must share color frame order, names, durations, animations, dimensions and atlas layout');
    }
    // Moves a colour along the recipe's ramps, for shade placements and ramp lighting.
    if (base.ramps.length) shifts[id] = rampShifter(base.palette, base.ramps);
    assets[id] = passes;
  }
  if (!Array.isArray(source.instances) || source.instances.length > 256) fail('scene.instances', 'expected at most 256 placements');
  let work = 0, count = 0;
  // Unique names, for attachments.
  const named = new Map();
  source.instances.forEach((instance, i) => { if (typeof instance?.name === 'string') named.set(instance.name, named.has(instance.name) ? null : i); });
  const instances = source.instances.map((instance, i) => {
    const path = `scene.instances[${i}]`;
    fields(instance, ['name', 'asset', 'at', 'anchor', 'scale', 'frame', 'animation', 'hidden', 'repeat', 'step', 'sequence', 'trajectory', 'attach', 'sort', 'shade', 'tilemap'], path);
    if (instance.name !== undefined && typeof instance.name !== 'string') fail(`${path}.name`, 'expected a string label');
    if (typeof instance.asset !== 'string' || !Object.hasOwn(assets, instance.asset)) fail(`${path}.asset`, 'unknown asset');
    const project = assets[instance.asset].recipe;
    // `anchor: "frame"` places every drawn frame by its own atlas anchor (per-frame or recipe-level), so an animated
    // placement follows anchors that change between poses. Otherwise the anchor is one fixed [x, y] in asset pixels.
    const at = point(instance.at, `${path}.at`), anchor = instance.anchor === 'frame' ? 'frame' : point(instance.anchor ?? [0, 0], `${path}.anchor`);
    if (anchor === 'frame' && !project.frames.some(frame => frame.anchor)) warnings.push(`${instance.name ?? i}: anchor "frame" but ${instance.asset} declares no anchors; its frames are placed by their top-left corner.`);
    if (instance.scale !== undefined && !Number.isInteger(instance.scale)) fail(`${path}.scale`, 'fractional sprite scaling creates inconsistent pixel sizes; use an integer or author a smaller asset');
    const scale = int(instance.scale ?? 1, 1, 16, `${path}.scale`);
    // A shade placement draws no colours of its own: wherever its frame is opaque, the pixels already drawn move that
    // many steps along the asset's ramps (a shadow that is right on any floor).
    let shade = null;
    if (instance.shade !== undefined) {
      shade = int(instance.shade, -8, 8, `${path}.shade`);
      if (!shade) fail(`${path}.shade`, 'expected a nonzero number of steps: negative darkens, positive lightens');
      if (!shifts[instance.asset]) fail(`${path}.shade`, `shade moves colours along ramps; declare ramps in ${instance.asset}'s recipe`);
    }
    if (instance.tilemap !== undefined) {
      for (const key of ['frame', 'animation', 'hidden', 'repeat', 'step', 'sequence', 'trajectory', 'attach', 'sort']) if (instance[key] !== undefined) fail(`${path}.${key}`, 'tilemap placements choose frames through their legend');
      if (anchor === 'frame') fail(`${path}.anchor`, 'a tilemap is placed by one [x, y] anchor in map pixels, not per frame');
      const tilemap = sceneTilemap(instance.tilemap, project, `${path}.tilemap`);
      count += tilemap.cells.length; work += tilemap.cells.length * project.width * project.height * scale ** 2;
      if (count > MAX_DRAWS || work > MAX_WORK) fail(path, 'scene exceeds 4,096 draws or 4,194,304 drawing pixels');
      if (scale !== 1) warnings.push(`${instance.name ?? i}: ${scale}× pixels; compare density against neighboring 1× assets.`);
      return { ...instance, at, anchor, scale, shade, tilemap };
    }
    const repeat = point(instance.repeat ?? [1, 1], `${path}.repeat`, 32);
    if (repeat.some(n => n < 1)) fail(`${path}.repeat`, 'repeat counts must be positive');
    const step = point(instance.step ?? [project.width * scale, project.height * scale], `${path}.step`);
    count += repeat[0] * repeat[1]; work += repeat[0] * repeat[1] * project.width * project.height * scale ** 2;
    if (count > MAX_DRAWS || work > MAX_WORK) fail(path, 'scene exceeds 4,096 draws or 4,194,304 drawing pixels');
    const selection = (entry, ep) => {
      if (entry.frame !== undefined && entry.animation !== undefined) fail(ep, 'choose frame or animation');
      if (entry.frame !== undefined && (typeof entry.frame !== 'string' || !project.frames.some(f => f.name === entry.frame))) fail(ep, 'unknown frame');
      if (entry.animation !== undefined && (typeof entry.animation !== 'string' || !Object.hasOwn(project.animations, entry.animation))) fail(ep, 'unknown animation');
    };
    selection(instance, path);
    if (instance.hidden !== undefined && typeof instance.hidden !== 'boolean') fail(`${path}.hidden`, 'expected a boolean');
    if (instance.sequence !== undefined && (!Array.isArray(instance.sequence) || instance.sequence.length > 64)) fail(`${path}.sequence`, 'expected at most 64 state cues');
    let previous = -1;
    const sequence = (instance.sequence ?? []).map((cue, j) => {
      const cp = `${path}.sequence[${j}]`;
      fields(cue, ['time', 'frame', 'animation', 'hide'], cp);
      const time = when(cue.time, `${cp}.time`, duration - 1);
      if (time <= previous) fail(`${path}.sequence`, 'cue times must increase strictly');
      if (cue.hide !== undefined && cue.hide !== true) fail(`${cp}.hide`, 'expected true; a later frame or animation cue shows the placement again');
      if (cue.hide && (cue.frame !== undefined || cue.animation !== undefined)) fail(cp, 'a hide cue takes no frame or animation');
      if (!cue.hide && cue.frame === undefined && cue.animation === undefined) fail(`${path}.sequence`, 'a cue needs frame, animation or hide');
      previous = time; selection(cue, cp);
      return { ...cue, time };
    });
    let trajectory;
    if (instance.trajectory !== undefined) {
      if (!Array.isArray(instance.trajectory) || instance.trajectory.length < 2 || instance.trajectory.length > 256) fail(`${path}.trajectory`, 'expected 2–256 timed positions');
      let prior = -1;
      trajectory = instance.trajectory.map((key, j) => {
        fields(key, ['time', 'at', 'ease'], `${path}.trajectory[${j}]`);
        const time = when(key.time, `${path}.trajectory[${j}].time`, duration);
        point(key.at, `${path}.trajectory[${j}].at`);
        if (key.ease !== undefined && !EASINGS.includes(key.ease)) fail(`${path}.trajectory[${j}].ease`, `expected one of ${EASINGS.join(', ')}`);
        if (time <= prior || (j === 0 && time !== 0)) fail(`${path}.trajectory`, 'start at time 0, then strictly increase');
        prior = time;
        return { ...key, time };
      });
    }
    // An attached placement follows a named point of another placement's current frame; `at` is its offset from that
    // point. It is not drawn while the frame there has no such point. Its target may be listed anywhere, so a shadow
    // can be drawn before the actor that casts it.
    let attach = null;
    if (instance.attach !== undefined) {
      fields(instance.attach, ['instance', 'point'], `${path}.attach`);
      const index = named.get(instance.attach.instance), target = source.instances[index];
      if (typeof instance.attach.instance !== 'string' || index === undefined || index === null || index === i || target.tilemap !== undefined || target.attach !== undefined || !Object.hasOwn(assets, target.asset)) fail(`${path}.attach.instance`, 'expected the name of another, uniquely named placement that is neither a tilemap nor attached itself');
      if (typeof instance.attach.point !== 'string' || !assets[target.asset].recipe.frames.some(frame => frame.points && Object.hasOwn(frame.points, instance.attach.point))) fail(`${path}.attach.point`, `no frame of ${target.asset} has a point named ${JSON.stringify(instance.attach.point)}`);
      if (trajectory) fail(`${path}.trajectory`, 'an attached placement moves with its target; remove the trajectory');
      attach = { index, point: instance.attach.point };
    }
    if (instance.sort !== undefined && instance.sort !== 'ground') fail(`${path}.sort`, 'expected ground: draw this placement among the other sorted ones by its ground line');
    if (scale !== 1) warnings.push(`${instance.name ?? i}: ${scale}× pixels; compare density against neighboring 1× assets.`);
    return { ...instance, at, anchor, scale, repeat, step, shade, attach, ...(instance.sequence && { sequence }), ...(trajectory && { trajectory }) };
  });
  let lighting = null;
  if (source.lighting !== undefined) {
    fields(source.lighting, ['ambient', 'bands', 'lights', 'scope', 'mode', 'steps'], 'scene.lighting');
    const { ambient = .35, bands = 5, lights = [], scope = 'passes', mode = 'multiply' } = source.lighting;
    if (typeof ambient !== 'number' || !Number.isFinite(ambient) || ambient < 0 || ambient > 1) fail('scene.lighting.ambient', 'expected 0–1');
    int(bands, 2, 16, 'scene.lighting.bands');
    // "passes" lights only assets with normal/emissive passes; "all" also lights plain assets as flat, facing surfaces.
    if (!['passes', 'all'].includes(scope)) fail('scene.lighting.scope', 'expected passes or all');
    // "multiply" scales colours by the light; "ramp" moves each colour along its asset's ramps instead, so a lit scene
    // keeps exactly its palette (light colours then only change brightness).
    if (!['multiply', 'ramp'].includes(mode)) fail('scene.lighting.mode', 'expected multiply or ramp');
    if (source.lighting.steps !== undefined && mode !== 'ramp') fail('scene.lighting.steps', 'steps apply to ramp lighting; set mode to ramp');
    const steps = int(source.lighting.steps ?? 2, 1, 8, 'scene.lighting.steps');
    if (!Array.isArray(lights) || lights.length > 8) fail('scene.lighting.lights', 'expected at most 8 lights');
    lighting = { ambient, bands, scope, mode, steps, lights: lights.map((light, i) => {
      fields(light, ['at', 'height', 'radius', 'color'], `scene.lighting.lights[${i}]`);
      return { at: point(light.at, 'light.at'), height: int(light.height ?? 24, 1, 256, 'light.height'), radius: int(light.radius ?? 96, 1, 512, 'light.radius'), color: parseColor(light.color ?? '#fff') };
    }) };
    if (mode === 'ramp' && !Object.keys(shifts).length) warnings.push('Ramp lighting needs ramps in the recipes it lights; no asset declares any, so nothing is lit.');
  }
  return { source, width, height, duration, assets, shifts, instances, background, lighting, warnings: [...new Set(warnings)] };
}
export function renderScene(scene, { time = 0, lit = true, density = false } = {}) {
  if (!Number.isFinite(time) || time < 0) fail('scene.time', 'expected a nonnegative finite time in milliseconds');
  if (typeof lit !== 'boolean' || typeof density !== 'boolean') fail('scene.preview', 'lit and density must be booleans');
  const { width, height, background, assets, shifts, lighting } = scene, data = new Uint8ClampedArray(width * height * 4), placements = [];
  for (let at = 0; at < data.length; at += 4) data.set(background, at);
  const clipped = new Map();
  const frameIndex = (project, selection, start) => {
    const animation = selection.animation === undefined ? null : project.animations[selection.animation];
    return animation ? animation.frames[animationPosition(project, animation, time - start)] : selection.frame ? project.frames.findIndex(f => f.name === selection.frame) : 0;
  };
  const drawFrame = (id, index, left, top, s, label, shade = null) => {
    const asset = assets[id], shift = shifts[id], project = asset.recipe, frame = project.frames[index];
    const normal = asset.normal?.frames[index].data, emission = asset.emissive?.frames[index].data;
    const light = !shade && lit && lighting && (normal || emission || lighting.scope === 'all') && (lighting.mode === 'multiply' || shift);
    const rgba = new Uint8ClampedArray(4);
    for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
      const at = (y * project.width + x) * 4;
      for (let c = 0; c < 4; c++) rgba[c] = frame.data[at + c];
      if (!rgba[3]) continue;
      if (light) {
        let nx = 0, ny = 0, nz = 1;
        if (normal?.[at + 3]) { nx = normal[at] / 127.5 - 1; ny = normal[at + 1] / 127.5 - 1; nz = normal[at + 2] / 127.5 - 1; }
        const norm = Math.hypot(nx, ny, nz) || 1, intensity = [lighting.ambient, lighting.ambient, lighting.ambient];
        for (const source of lighting.lights) {
          const dx = source.at[0] - (left + x * s), dy = source.at[1] - (top + y * s), dz = source.height;
          const distance = Math.hypot(dx, dy, dz), diffuse = Math.max(0, (nx * dx + ny * dy + nz * dz) / norm / distance) * Math.max(0, 1 - Math.hypot(dx, dy) / source.radius);
          // Band the light's brightness once, then tint it: banding each channel separately made a coloured light
          // change band at different distances per channel, painting rainbow rings.
          const band = Math.round(Math.min(1, diffuse) * (lighting.bands - 1)) / (lighting.bands - 1);
          for (let c = 0; c < 3; c++) intensity[c] += band * source.color[c] / 255;
        }
        if (lighting.mode === 'ramp') {
          // Brightness 1 keeps the authored colour; each `steps`-th of darkness (or of light above 1, up to double) is one
          // step along the colour's ramp. Emissive pixels keep their colour.
          const brightness = 0.2126 * intensity[0] + 0.7152 * intensity[1] + 0.0722 * intensity[2];
          const steps = emission?.[at + 3] ? 0 : Math.round((Math.min(2, brightness) - 1) * lighting.steps);
          if (steps) { const next = shift(pixelId(rgba, 0), steps); if (next) rgba.set(next); }
        } else for (let c = 0; c < 3; c++) rgba[c] = Math.min(255, Math.round(rgba[c] * Math.min(1, intensity[c]) + (emission ? emission[at + c] * emission[at + 3] / 255 : 0)));
      }
      for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) {
        const tx = left + x * s + sx, ty = top + y * s + sy;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) { clipped.set(label, (clipped.get(label) ?? 0) + 1); continue; }
        const to = (ty * width + tx) * 4;
        if (shade) { const next = data[to + 3] ? shift(pixelId(data, to), shade) : null; if (next) data.set(next, to); }
        else alphaOver(data, to, rgba);
      }
    }
  };
  // Each placement's state at this time: hidden or the frame it shows, and where. Attached placements come second,
  // because they read their target's state.
  const states = scene.instances.map(() => null);
  for (const [i, instance] of [...scene.instances.entries()].sort((a, b) => Boolean(a[1].attach) - Boolean(b[1].attach) || a[0] - b[0])) {
    if (instance.tilemap) continue;
    const project = assets[instance.asset].recipe;
    let choice = instance, start = 0, hidden = instance.hidden === true;
    for (const cue of instance.sequence ?? []) if (cue.time <= time) { if (cue.hide) hidden = true; else { hidden = false; choice = cue; start = cue.time; } }
    const index = frameIndex(project, choice, start), frame = project.frames[index];
    let position = instance.at;
    if (instance.trajectory) {
      position = instance.trajectory.at(-1).at;
      for (let t = 1; t < instance.trajectory.length; t++) {
        const a = instance.trajectory[t - 1], b = instance.trajectory[t];
        // Each key's ease shapes the segment that starts at it; positions still round to whole pixels.
        if (time <= b.time) { const fraction = ease(a.ease ?? 'linear', (time - a.time) / (b.time - a.time)); position = a.at.map((v, axis) => Math.round(v + (b.at[axis] - v) * fraction)); break; }
      }
    }
    const anchor = instance.anchor === 'frame' ? frame.anchor ?? [0, 0] : instance.anchor;
    if (instance.attach) {
      const target = states[instance.attach.index], spot = target && !target.hidden ? target.frame.points?.[instance.attach.point] : undefined;
      if (!spot) hidden = true;
      else position = [target.left + spot[0] * target.scale + instance.at[0], target.top + spot[1] * target.scale + instance.at[1]];
    }
    states[i] = { hidden, index, frame, position, left: position[0] - anchor[0] * instance.scale, top: position[1] - anchor[1] * instance.scale, scale: instance.scale };
  }
  // Drawing order is list order, except that placements with sort "ground" are drawn together, where the first of
  // them is listed, ordered by their ground line (the y of their placement point), as a game draws actors and props.
  const order = [], sorted = scene.instances.flatMap((instance, i) => instance.sort === 'ground' ? [i] : []);
  for (const [i, instance] of scene.instances.entries()) {
    if (instance.sort !== 'ground') { order.push([i, 0, 0]); continue; }
    if (i !== sorted[0]) continue;
    const copies = sorted.flatMap(j => { const one = scene.instances[j]; return Array.from({ length: one.repeat[0] * one.repeat[1] }, (_, k) => [j, k % one.repeat[0], Math.floor(k / one.repeat[0])]); });
    order.push(...copies.map(([j, rx, ry], n) => ({ n, entry: [j, rx, ry], ground: states[j].position[1] + ry * scene.instances[j].step[1] })).sort((a, b) => a.ground - b.ground || a.n - b.n).map(item => item.entry));
  }
  for (const [i, rx, ry] of order) {
    const instance = scene.instances[i], asset = assets[instance.asset], project = asset.recipe, s = instance.scale, label = instance.name ?? `${instance.asset}#${i}`;
    if (instance.tilemap) {
      const { tilemap } = instance, left = instance.at[0] - instance.anchor[0] * s, top = instance.at[1] - instance.anchor[1] * s;
      for (const cell of tilemap.cells) drawFrame(instance.asset, frameIndex(project, cell, 0), left + cell.x * s, top + cell.y * s, s, label, instance.shade);
      placements.push({ name: label, tilemap: true, x: left, y: top, w: tilemap.columns * tilemap.tile[0] * s, h: tilemap.rows * tilemap.tile[1] * s, tiles: tilemap.cells.length, scale: s });
      continue;
    }
    const state = states[i];
    if (state.hidden) continue;
    const left = state.left + rx * instance.step[0], top = state.top + ry * instance.step[1];
    placements.push({ name: instance.name ?? instance.asset, frame: state.frame.name, x: left, y: top, w: project.width * s, h: project.height * s, scale: s, ...(instance.shade && { shade: instance.shade }) });
    drawFrame(instance.asset, state.index, left, top, s, label, instance.shade);
  }
  if (density) for (const box of placements) {
    const color = box.scale === 1 ? [65, 201, 240, 180] : [255, 70, 100, 255];
    for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.h); y++) for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.w); x++) {
      if (x === box.x || y === box.y || x === box.x + box.w - 1 || y === box.y + box.h - 1) alphaOver(data, (y * width + x) * 4, color);
    }
  }
  const total = [...clipped.values()].reduce((sum, n) => sum + n, 0), named = [...clipped].sort((a, b) => b[1] - a[1]);
  const clipWarning = total ? [`${total} drawn pixels clipped at scene bounds (${named.slice(0, 4).map(([name, n]) => `${name} ${n}`).join(', ')}${named.length > 4 ? `, ${named.length - 4} more` : ''}).`] : [];
  return { data, width, height, placements, warnings: [...scene.warnings, ...clipWarning], ...(total && { clipped: Object.fromEntries(named) }) };
}
// Kept for compatibility: the 3x3 repeat plus the same advisory seam evidence as `inspect --view tile`.
export function inspectTile(project, frameName = project.frames[0].name) {
  const index = project.frames.findIndex(f => f.name === frameName);
  if (index < 0) fail('tile.frame', 'unknown frame');
  const frame = project.frames[index];
  return { data: tileRepeat(frame.data, project.width, project.height), width: project.width * 3, height: project.height * 3, ...tileReport(frame.data, project.width, project.height), note: 'Advisory: doubled edge lines and wrap steps larger than any interior boundary suggest a visible seam. Review the 3×3 repeat.' };
}
