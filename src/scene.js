// Bounded scene review, not a game engine. In-memory recipes only; no filesystem or network access.
import { PixelError, renderProject, parseColor, animationPosition, tileRepeat, tileReport, rampShifter, reviewPixels, scalePixels, readGuides, drawGuides, CANVAS_SIDE } from './core.js';
import { EASINGS, ease, pixelId, random, nearestColor } from './craft.js';
import { fields, point } from './authoring.js';
import { expandTilemap, isoLayout } from './autotile.js';

const fail = (path, message) => { throw new PixelError(path, message); };
const int = (v, min, max, path) => { if (!Number.isInteger(v) || v < min || v > max) fail(path, `expected an integer from ${min} to ${max}`); return v; };
const num = (v, min, max, path) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(path, `expected a number from ${min} to ${max}`); return v; };
const smooth = t => t * t * (3 - 2 * t);
// A light's flicker at `time`: seeded value noise from 0 to 1 over `steps` evenly spaced points per scene duration,
// eased between them, wrapping at the duration so a looping scene flickers without a seam.
function flickerAt({ steps, seed }, light, time, duration) {
  const u = (time % duration) / duration * steps, k = Math.floor(u), a = random(seed, light, k % steps), b = random(seed, light, (k + 1) % steps);
  return a + (b - a) * smooth(u - k);
}
// A light's strength and radius at `time` from its keys: held before the first and after the last, and eased between
// neighbours by the earlier key's ease, as trajectories are.
function keyedAt(keys, time) {
  if (time <= keys[0].time) return keys[0];
  for (let k = 1; k < keys.length; k++) {
    const a = keys[k - 1], b = keys[k];
    // An overshoot carries past the next key: strength stays at least 0 and the radius, which lighting divides by, at
    // least 1, the least a key may set.
    if (time < b.time) { const f = ease(a.ease, (time - a.time) / (b.time - a.time)); return { strength: Math.max(0, a.strength + (b.strength - a.strength) * f), radius: Math.max(1, a.radius + (b.radius - a.radius) * f) }; }
  }
  return keys.at(-1);
}
// A placement's lift at `time`: a fixed height, or keys held before the first and after the last and eased between
// neighbours by the earlier key's ease, rounded to whole pixels and kept from 0 to 256 as keys are, so an overshoot
// never sinks it below its ground line.
function liftAt(lift, time) {
  if (typeof lift === 'number') return lift;
  if (time <= lift[0].time) return lift[0].height;
  for (let k = 1; k < lift.length; k++) {
    const a = lift[k - 1], b = lift[k];
    if (time < b.time) return Math.min(256, Math.max(0, Math.round(a.height + (b.height - a.height) * ease(a.ease, (time - a.time) / (b.time - a.time)))));
  }
  return lift.at(-1).height;
}
// The camera at `time`: keys held before the first and after the last and eased between neighbours by the earlier
// key's ease. It is not rounded: each plane rounds its own share of it.
function cameraAt(keys, time) {
  if (time <= keys[0].time) return keys[0].at;
  for (let k = 1; k < keys.length; k++) {
    const a = keys[k - 1], b = keys[k];
    if (time < b.time) { const f = ease(a.ease, (time - a.time) / (b.time - a.time)); return a.at.map((v, axis) => v + (b.at[axis] - v) * f); }
  }
  return keys.at(-1).at;
}
const alphaOver = (target, at, color) => {
  if (color[3] === 255) { target.set(color, at); return; }
  const alpha = color[3] / 255; if (!alpha) return;
  const old = target[at + 3] / 255, out = alpha + old * (1 - alpha);
  for (let c = 0; c < 3; c++) target[at + c] = Math.round((color[c] * alpha + target[at + c] * old * (1 - alpha)) / out);
  target[at + 3] = Math.round(out * 255);
};
// Material passes must agree on the recipe's sheet settings; trimmed layouts may differ and are rebuilt as grids.
const sheetSettings = sheet => JSON.stringify([sheet.columns, sheet.padding, sheet.scale, Boolean(sheet.trim)]);
const MAX_DRAWS = 4096, MAX_WORK = 4194304, MAX_CASTS = 2048;

// Expands a tilemap placement into cells of one asset's frames and animations (see expandTilemap in autotile.js): each
// cell's frame top-left in map pixels, and `bottom`, the map row below the line it stands on when the map is sorted.
// A square cell's frame hangs from the cell's top-left and stands on its own bottom row. An iso map lays cells on a 2:1
// diamond grid, back to front (see isoLayout); each frame stands on its diamond, bottoms aligned and centred across, and
// stands just above the diamond's centre, so whatever stands at the centre of the same cell, on top of a block, is
// drawn after it.
function sceneTilemap(tilemap, project, path) {
  fields(tilemap, ['tile', 'rows', 'legend', 'outside', 'empty', 'classes', 'seed', 'layout'], path);
  const tile = point(tilemap.tile ?? [project.width, project.height], `${path}.tile`, 256);
  if (tile.some(n => n < 1)) fail(`${path}.tile`, 'tile size must be positive');
  if (tilemap.layout !== undefined && tilemap.layout !== 'square' && tilemap.layout !== 'iso') fail(`${path}.layout`, 'expected square or iso');
  const iso = tilemap.layout === 'iso';
  if (iso && tile.some(n => n % 2)) fail(`${path}.tile`, 'an iso tile has an even width and height');
  const frames = new Set(project.frames.map(f => f.name));
  const expanded = expandTilemap(tilemap, { path, fail, kinds: ['frame', 'animation'], text: 'frame', masked: () => true,
    exists: (kind, name) => kind === 'frame' ? frames.has(name) : Object.hasOwn(project.animations, name) });
  const { columns, rows } = expanded, [w, h] = tile;
  if (!iso) return { tile, width: columns * w, height: rows * h, cells: expanded.cells.map(cell => ({ x: cell.x * w, y: cell.y * h, bottom: cell.y * h + project.height, [cell.kind]: cell.name })), columns, rows };
  const cells = isoLayout(expanded.cells, rows, tile).map(cell => ({ x: cell.left + Math.floor((w - project.width) / 2), y: cell.top + h - project.height, bottom: cell.top + h / 2, [cell.kind]: cell.name }));
  return { tile, width: (columns + rows) * w / 2, height: (columns + rows) * h / 2, cells, columns, rows, iso };
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
  fields(source, ['format', 'version', 'name', 'width', 'height', 'background', 'duration', 'palette', 'cues', 'assets', 'instances', 'lighting', 'haze', 'camera'], 'scene');
  if (source.format !== 'pixelforge-scene' || source.version !== 1) fail('scene', 'expected version-1 pixelforge-scene');
  const width = int(source.width, 1, 256, 'scene.width'), height = int(source.height, 1, 256, 'scene.height');
  const duration = int(source.duration ?? 2000, 1, 60000, 'scene.duration');
  // Reuse portable name validation.
  renderProject({ version: 1, name: source.name, width: 1, height: 1, frames: [{ name: 'check' }] });
  const background = parseColor(source.background ?? '#10121e');
  const scenePalette = paletteMap(source.palette, 'scene.palette');
  // Haze: the colour far planes fade toward, and optionally the only colours hazed placements may end on (a fixed
  // game palette, or a short ramp toward the haze for far planes that read as silhouettes).
  let haze = null;
  if (source.haze !== undefined) {
    fields(source.haze, ['color', 'colors'], 'scene.haze');
    const opaque = (value, path) => { const rgba = parseColor(value, {}, path); if (rgba[3] !== 255) fail(path, 'haze colours are opaque'); return rgba.slice(0, 3); };
    if (source.haze.colors !== undefined && (!Array.isArray(source.haze.colors) || !source.haze.colors.length || source.haze.colors.length > 64)) fail('scene.haze.colors', 'expected 1–64 colours');
    haze = { color: opaque(source.haze.color, 'scene.haze.color'), colors: (source.haze.colors ?? []).map((value, j) => opaque(value, `scene.haze.colors[${j}]`)) };
  }
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
  // The camera: the scene point at the view's top-left corner, fixed or keyed over time. Without one the view is the
  // scene from [0, 0], as before.
  let camera = null;
  if (source.camera !== undefined) {
    if (Array.isArray(source.camera) && typeof source.camera[0] !== 'object') camera = [{ time: 0, at: point(source.camera, 'scene.camera'), ease: 'linear' }];
    else {
      if (!Array.isArray(source.camera) || !source.camera.length || source.camera.length > 256) fail('scene.camera', 'expected [x, y] or 1–256 timed positions');
      let prior = -1;
      camera = source.camera.map((key, j) => {
        const kp = `scene.camera[${j}]`;
        fields(key, ['time', 'at', 'ease'], kp);
        const time = when(key.time, `${kp}.time`, duration);
        if (time <= prior) fail('scene.camera', 'key times must increase strictly');
        if (key.ease !== undefined && !EASINGS.includes(key.ease)) fail(`${kp}.ease`, `expected one of ${EASINGS.join(', ')}`);
        prior = time;
        return { time, at: point(key.at, `${kp}.at`), ease: key.ease ?? 'linear' };
      });
    }
  }
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
      // A still larger than 256 pixels a side renders on its own; scenes keep their assets to the animation canvas.
      if (spec?.width > CANVAS_SIDE || spec?.height > CANVAS_SIDE) fail(`scene.assets.${id}`, `a scene asset is at most ${CANVAS_SIDE}×${CANVAS_SIDE} pixels; a larger still renders on its own, not in a scene`);
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
    fields(instance, ['name', 'asset', 'at', 'anchor', 'scale', 'frame', 'animation', 'hidden', 'repeat', 'step', 'sequence', 'trajectory', 'attach', 'sort', 'lift', 'shade', 'tilemap', 'lit', 'haze', 'parallax', 'shadow'], path);
    if (instance.name !== undefined && typeof instance.name !== 'string') fail(`${path}.name`, 'expected a string label');
    // `lit: false` keeps a placement's authored colours under scene lighting: a fire, a lamp or a glow is a light
    // source, not something the scene's lights fall on.
    if (instance.lit !== undefined && typeof instance.lit !== 'boolean') fail(`${path}.lit`, 'expected a boolean');
    if (instance.lit === false && instance.shade !== undefined) fail(`${path}.lit`, 'a shade placement draws no colours of its own to keep');
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
    if (instance.sort !== undefined && instance.sort !== 'ground') fail(`${path}.sort`, 'expected ground: draw this placement among the other sorted ones by its ground line');
    // How much of the camera's movement a placement follows: 1 is the scene (the default), less is a farther plane, 0
    // stays on screen (a sky), more than 1 is a plane nearer than the scene. A number, or [x, y] for each axis.
    let parallax = [1, 1];
    if (instance.parallax !== undefined) {
      if (!camera) fail(`${path}.parallax`, 'parallax moves a placement with scene.camera; set a camera first');
      if (instance.attach !== undefined) fail(`${path}.parallax`, 'an attached placement moves with its target');
      parallax = Array.isArray(instance.parallax) && instance.parallax.length === 2 ? instance.parallax.map((v, axis) => num(v, 0, 4, `${path}.parallax[${axis}]`)) : [num(instance.parallax, 0, 4, `${path}.parallax`), instance.parallax];
    }
    // How far into the haze a placement stands: 0 is none, 1 is the haze colour itself.
    if (instance.haze !== undefined) {
      if (!haze) fail(`${path}.haze`, 'set scene.haze first: the colour far planes fade toward');
      num(instance.haze, 0, 1, `${path}.haze`);
      if (instance.shade !== undefined) fail(`${path}.haze`, 'a shade placement draws no colours of its own to haze');
    }
    // A shadow is cast by the scene's lights, which are read after the placements.
    if (instance.shadow !== undefined) {
      if (typeof instance.shadow !== 'boolean') fail(`${path}.shadow`, 'expected a boolean');
      if (instance.shadow && instance.shade !== undefined) fail(`${path}.shadow`, 'a shade placement draws nothing to cast a shadow');
    }
    if (instance.tilemap !== undefined) {
      for (const key of ['frame', 'animation', 'hidden', 'repeat', 'step', 'sequence', 'trajectory', 'attach']) if (instance[key] !== undefined) fail(`${path}.${key}`, 'tilemap placements choose frames through their legend');
      if (anchor === 'frame') fail(`${path}.anchor`, 'a tilemap is placed by one [x, y] anchor in map pixels, not per frame');
      if (instance.lift !== undefined) fail(`${path}.lift`, 'a tilemap lies where it is placed; lift a placement instead');
      const tilemap = sceneTilemap(instance.tilemap, project, `${path}.tilemap`);
      count += tilemap.cells.length; work += tilemap.cells.length * project.width * project.height * scale ** 2;
      if (count > MAX_DRAWS || work > MAX_WORK) fail(path, 'scene exceeds 4,096 draws or 4,194,304 drawing pixels');
      if (scale !== 1) warnings.push(`${instance.name ?? i}: ${scale}× pixels; compare density against neighboring 1× assets.`);
      return { ...instance, at, anchor, scale, shade, tilemap, parallax };
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
    // Without a point it follows where the target stands, which stays on the ground while the target is lifted: a
    // contact shadow under a jump.
    let attach = null;
    if (instance.attach !== undefined) {
      fields(instance.attach, ['instance', 'point'], `${path}.attach`);
      const index = named.get(instance.attach.instance), target = source.instances[index];
      if (typeof instance.attach.instance !== 'string' || index === undefined || index === null || index === i || target.tilemap !== undefined || target.attach !== undefined || !Object.hasOwn(assets, target.asset)) fail(`${path}.attach.instance`, 'expected the name of another, uniquely named placement that is neither a tilemap nor attached itself');
      if (instance.attach.point !== undefined && (typeof instance.attach.point !== 'string' || !assets[target.asset].recipe.frames.some(frame => frame.points && Object.hasOwn(frame.points, instance.attach.point)))) fail(`${path}.attach.point`, `no frame of ${target.asset} has a point named ${JSON.stringify(instance.attach.point)}`);
      if (trajectory) fail(`${path}.trajectory`, 'an attached placement moves with its target; remove the trajectory');
      attach = { index, point: instance.attach.point ?? null };
    }
    // Lift draws a placement this many pixels above where it stands, and where it stands still orders it: a jump or a
    // flight keeps its ground line. A height, or keys of height over time; each key's ease shapes the change to the next.
    let lift = 0;
    if (Array.isArray(instance.lift)) {
      if (!instance.lift.length || instance.lift.length > 64) fail(`${path}.lift`, 'expected 1–64 timed heights');
      let prior = -1;
      lift = instance.lift.map((key, j) => {
        const kp = `${path}.lift[${j}]`;
        fields(key, ['time', 'height', 'ease'], kp);
        const time = when(key.time, `${kp}.time`, duration);
        if (time <= prior) fail(`${path}.lift`, 'key times must increase strictly');
        if (key.ease !== undefined && !EASINGS.includes(key.ease)) fail(`${kp}.ease`, `expected one of ${EASINGS.join(', ')}`);
        prior = time;
        return { time, height: int(key.height, 0, 256, `${kp}.height`), ease: key.ease ?? 'linear' };
      });
    } else if (instance.lift !== undefined) lift = int(instance.lift, 0, 256, `${path}.lift`);
    // A shadow is cast by the part of a frame above where it stands. Anchored on its top row (the default [0, 0]), none
    // is, unless it is always lifted or held at a frame point, which stands on its holder's ground.
    if (instance.shadow && !attach?.point && !(typeof lift === 'number' && lift > 0)) {
      const label = instance.name ?? i;
      if (anchor !== 'frame' && anchor[1] <= 0) warnings.push(`${label}: shadow, but its anchor is on its top row, so it casts nothing; anchor it at its feet (anchor: "frame" or [x, bottom]).`);
      if (anchor === 'frame' && project.frames.some(frame => !(frame.anchor?.[1] > 0))) warnings.push(`${label}: shadow, but its anchor is on its top row, so it casts nothing; anchor ${instance.asset}'s frames at their feet.`);
    }
    if (scale !== 1) warnings.push(`${instance.name ?? i}: ${scale}× pixels; compare density against neighboring 1× assets.`);
    return { ...instance, at, anchor, scale, repeat, step, shade, attach, lift, parallax, ...(instance.sequence && { sequence }), ...(trajectory && { trajectory }) };
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
      const lp = `scene.lighting.lights[${i}]`;
      fields(light, ['at', 'height', 'radius', 'color', 'strength', 'follow', 'flicker', 'keys', 'sun'], lp);
      // A sun is a light so far away that it falls the same way everywhere, with no position, height or reach. `sun` is
      // how far a shadow falls across the ground per pixel of height: [1, 0.5] is a low sun up and to the left, whose
      // shadows fall right and a little down, a little longer than their casters are tall; [0, 0] is straight overhead.
      let sun = null;
      if (light.sun !== undefined) {
        for (const key of ['at', 'height', 'radius', 'follow']) if (light[key] !== undefined) fail(`${lp}.${key}`, 'a sun has no position, height or reach: sun alone sets where its light comes from');
        if (!Array.isArray(light.sun) || light.sun.length !== 2) fail(`${lp}.sun`, 'expected [x, y]: how far a shadow falls across the ground per pixel of height');
        sun = light.sun.map((v, axis) => num(v, -8, 8, `${lp}.sun[${axis}]`));
      }
      // A following light rides a placement (where it stands) or one of its frame points; `at` is then an offset. It is
      // off while that placement is hidden or its current frame has no such point.
      let follow = null;
      if (light.follow !== undefined) {
        fields(light.follow, ['instance', 'point'], `${lp}.follow`);
        const index = named.get(light.follow.instance), target = source.instances[index];
        if (typeof light.follow.instance !== 'string' || index === undefined || index === null || target.tilemap !== undefined) fail(`${lp}.follow.instance`, 'expected the name of a uniquely named placement that is not a tilemap');
        if (light.follow.point !== undefined && (typeof light.follow.point !== 'string' || !assets[target.asset].recipe.frames.some(frame => frame.points && Object.hasOwn(frame.points, light.follow.point)))) fail(`${lp}.follow.point`, `no frame of ${target.asset} has a point named ${JSON.stringify(light.follow.point)}`);
        follow = { index, point: light.follow.point ?? null };
      }
      const at = sun ? null : follow && light.at === undefined ? [0, 0] : point(light.at, `${lp}.at`);
      const radius = sun ? null : int(light.radius ?? 96, 1, 512, `${lp}.radius`), strength = num(light.strength ?? 1, 0, 8, `${lp}.strength`);
      // Flicker raises or lowers a light's strength by up to `amount` of it and its reach by up to half that, along seeded
      // noise that changes about every `every` ms and repeats once per scene duration.
      let flicker = null;
      if (light.flicker !== undefined) {
        fields(light.flicker, ['amount', 'every', 'seed'], `${lp}.flicker`);
        const every = int(light.flicker.every ?? 80, 10, 10000, `${lp}.flicker.every`);
        flicker = { amount: num(light.flicker.amount, 0, 1, `${lp}.flicker.amount`), steps: Math.max(1, Math.round(duration / every)), seed: int(light.flicker.seed ?? 0, 0, 2147483647, `${lp}.flicker.seed`) };
      }
      // Keys set strength and radius over time, at milliseconds or cue times ("strike+70"): a flash, a lamp lit later.
      let keys = null;
      if (light.keys !== undefined) {
        if (!Array.isArray(light.keys) || !light.keys.length || light.keys.length > 64) fail(`${lp}.keys`, 'expected 1–64 timed keys');
        let prior = -1;
        keys = light.keys.map((key, j) => {
          const kp = `${lp}.keys[${j}]`;
          fields(key, ['time', 'strength', 'radius', 'ease'], kp);
          const time = when(key.time, `${kp}.time`, duration);
          if (time <= prior) fail(`${lp}.keys`, 'key times must increase strictly');
          prior = time;
          if (key.ease !== undefined && !EASINGS.includes(key.ease)) fail(`${kp}.ease`, `expected one of ${EASINGS.join(', ')}`);
          if (sun && key.radius !== undefined) fail(`${kp}.radius`, 'a sun reaches everywhere; its keys set strength');
          return { time, strength: key.strength === undefined ? strength : num(key.strength, 0, 8, `${kp}.strength`), radius: key.radius === undefined ? radius : int(key.radius, 1, 512, `${kp}.radius`), ease: key.ease ?? 'linear' };
        });
      }
      return { at, height: sun ? null : int(light.height ?? 24, 1, 256, `${lp}.height`), radius, color: parseColor(light.color ?? '#fff', {}, `${lp}.color`), strength, follow, flicker, keys, ...(sun && { sun }) };
    }) };
    if (mode === 'ramp' && !Object.keys(shifts).length) warnings.push('Ramp lighting needs ramps in the recipes it lights; no asset declares any, so nothing is lit.');
  }
  // Every drawn copy or tile of a placement with `shadow` is cast from every light, so their product is bounded.
  const casting = instances.reduce((n, instance) => n + (instance.shadow ? (instance.tilemap ? instance.tilemap.cells.length : instance.repeat[0] * instance.repeat[1]) : 0), 0);
  if (casting) {
    const first = `scene.instances[${instances.findIndex(instance => instance.shadow)}].shadow`;
    if (!lighting?.lights.length) fail(first, 'a shadow is cast by scene lights; add lighting with lights first');
    if (casting * lighting.lights.length > MAX_CASTS) fail(first, `${casting} casting draws under ${lighting.lights.length} lights exceed 2,048 shadow casts; cast from fewer placements or lights`);
    if (lighting.scope === 'passes' && !instances.some(instance => !instance.shadow && (assets[instance.asset].normal || assets[instance.asset].emissive))) warnings.push('Shadows fall only on lit placements, and lighting.scope "passes" lights only assets with normal or emissive passes; set lighting.scope to "all" to shadow plain floors and walls.');
  }
  return { source, width, height, duration, assets, shifts, instances, background, lighting, haze, camera, warnings: [...new Set(warnings)] };
}
// Sets a prepared light's radius as prepareScene reads it from a scene: keys that set no radius of their own take the
// light's. The studio's slider uses this, so its preview is what the saved scene shows.
export function setLightRadius(scene, index, radius) {
  const light = scene.lighting.lights[index], keys = scene.source.lighting.lights[index].keys;
  light.radius = radius;
  light.keys?.forEach((key, j) => { if (keys[j].radius === undefined) key.radius = radius; });
}
// True when every key of the light sets its own radius, so the light's own radius changes nothing.
export const keysSetRadius = (scene, index) => scene.source.lighting.lights[index].keys?.every(key => key.radius !== undefined) ?? false;
// The scene as written with the light settings named in `edited` ("0.at", "0.sun", "0.height", "0.radius", "0.color"
// or "ambient") taken from a prepared scene the studio changed. Everything else stays as written, file references included.
export function withLightSettings(written, scene, edited) {
  const saved = structuredClone(written);
  for (const setting of edited) {
    if (setting === 'ambient') { saved.lighting.ambient = scene.lighting.ambient; continue; }
    const [index, field] = setting.split('.'), light = scene.lighting.lights[index];
    saved.lighting.lights[index][field] = field === 'at' || field === 'sun' ? [...light[field]] : field === 'color' ? `#${light.color.slice(0, light.color[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('')}` : light[field];
  }
  return saved;
}
// `depth: true` also records which placement drew each pixel last and who covers whom, for `depth` in the result and
// for `sceneImage(view, { mode: 'depth' })`.
export function renderScene(scene, { time = 0, lit = true, density = false, depth = false } = {}) {
  if (!Number.isFinite(time) || time < 0) fail('scene.time', 'expected a nonnegative finite time in milliseconds');
  if (typeof lit !== 'boolean' || typeof density !== 'boolean' || typeof depth !== 'boolean') fail('scene.preview', 'lit, density and depth must be booleans');
  const { width, height, background, assets, shifts, lighting } = scene, data = new Uint8ClampedArray(width * height * 4), placements = [];
  // Where the camera is, and how far each placement moves on screen for it: its parallax share of the camera, rounded
  // to whole pixels per plane. An attached placement moves with its target; -1 is the scene itself.
  const camera = scene.camera ? cameraAt(scene.camera, time) : null;
  const shiftOf = i => {
    if (!camera) return [0, 0];
    const factor = i < 0 ? [1, 1] : scene.instances[scene.instances[i].attach?.index ?? i].parallax;
    return [Math.round(camera[0] * factor[0]), Math.round(camera[1] * factor[1])];
  };
  for (let at = 0; at < data.length; at += 4) data.set(background, at);
  const clipped = new Map();
  // Depth bookkeeping: one entry per drawn placement copy (shade placements darken and own nothing), the entry that
  // drew each pixel last, and pixel counts of placement `front` covering placement `behind`. An entry covers when it
  // draws over another; one that covers nothing lies straight on the background, as a floor or backdrop does.
  const owner = depth ? new Int32Array(width * height).fill(-1) : null, entries = [], pairs = new Map();
  // A copy drawn over another copy of the same placement (overlapping repeat copies) covers only what that copy covers,
  // so a strip of overlapping grass still lies on the background.
  const cover = (front, behind) => {
    const f = entries[front], b = entries[behind];
    if (b.instance === f.instance) { f.covers ||= b.covers; return; }
    f.covers = true;
    if (b.covers || b.sorted) { const key = `${f.instance} ${b.instance}`; pairs.set(key, (pairs.get(key) ?? 0) + 1); }
  };
  const frameIndex = (project, selection, start) => {
    const animation = selection.animation === undefined ? null : project.animations[selection.animation];
    return animation ? animation.frames[animationPosition(project, animation, time - start)] : selection.frame ? project.frames.findIndex(f => f.name === selection.frame) : 0;
  };
  // The lights as they are at this time (where they are, how strong, how far they reach), once the placements they
  // follow are known.
  let lights = [];
  // Haze, after lighting: each colour moves `amount` of the way to the haze colour, as a whole colour rather than per
  // pixel, so every colour of a placement becomes exactly one colour and keeps its place among the others, as a far
  // palette an artist mixes does. With haze colours listed, it then becomes the nearest of them and the haze colour.
  const hazeMaps = new Map();
  const hazed = (amount, rgba) => {
    let map = hazeMaps.get(amount);
    if (!map) hazeMaps.set(amount, map = new Map());
    const colour = (rgba[0] << 16) | (rgba[1] << 8) | rgba[2];
    let out = map.get(colour);
    if (!out) {
      const { color, colors } = scene.haze, faded = [0, 1, 2].map(c => Math.round(rgba[c] + (color[c] - rgba[c]) * amount));
      map.set(colour, out = colors.length ? nearestColor(faded, [color, ...colors]) : faded);
    }
    return out;
  };
  // Shadows (below): per light, the rank of the last-drawn caster shadowing each pixel, or nothing when none does.
  let shadowMasks = [];
  const drawFrame = (id, index, left, top, s, label, shade = null, unlit = false, entry = -1, fade = 0, rank = -1) => {
    const asset = assets[id], shift = shifts[id], project = asset.recipe, frame = project.frames[index];
    const normal = asset.normal?.frames[index].data, emission = asset.emissive?.frames[index].data;
    const light = !shade && !unlit && lit && lighting && (normal || emission || lighting.scope === 'all') && (lighting.mode === 'multiply' || shift);
    const rgba = new Uint8ClampedArray(4);
    for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
      const at = (y * project.width + x) * 4;
      for (let c = 0; c < 4; c++) rgba[c] = frame.data[at + c];
      if (!rgba[3]) continue;
      if (light) {
        let nx = 0, ny = 0, nz = 1;
        if (normal?.[at + 3]) { nx = normal[at] / 127.5 - 1; ny = normal[at + 1] / 127.5 - 1; nz = normal[at + 2] / 127.5 - 1; }
        // Lengths use sqrt of a sum of squares, not Math.hypot, which engines may round differently (see AGENTS.md).
        const norm = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1, intensity = [lighting.ambient, lighting.ambient, lighting.ambient];
        for (let li = 0; li < lights.length; li++) {
          const source = lights[li];
          if (!source.strength) continue;
          // Under a shadow cast by something drawn after this placement, the light does not reach the pixel.
          const mask = shadowMasks[li], px = left + x * s, py = top + y * s;
          if (mask && px >= 0 && py >= 0 && px < width && py < height && mask[py * width + px] > rank) continue;
          // A sun lights every pixel from the same way, with no falloff.
          let diffuse;
          if (source.toward) diffuse = Math.max(0, (nx * source.toward[0] + ny * source.toward[1] + nz * source.toward[2]) / norm);
          else {
            const dx = source.at[0] - px, dy = source.at[1] - py, dz = source.height;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            diffuse = Math.max(0, (nx * dx + ny * dy + nz * dz) / norm / distance) * Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / source.radius);
          }
          // Band the light's brightness once, then tint it: banding each channel separately made a coloured light
          // change band at different distances per channel, painting rainbow rings. Strength scales the banded light,
          // so above 1 a flash can lift ramp-lit colours past their authored shade.
          const band = Math.round(Math.min(1, diffuse) * (lighting.bands - 1)) / (lighting.bands - 1);
          for (let c = 0; c < 3; c++) intensity[c] += band * source.strength * source.color[c] / 255;
        }
        if (lighting.mode === 'ramp') {
          // Brightness 1 keeps the authored colour; each `steps`-th of darkness (or of light above 1, up to double) is one
          // step along the colour's ramp. Emissive pixels keep their colour.
          const brightness = 0.2126 * intensity[0] + 0.7152 * intensity[1] + 0.0722 * intensity[2];
          const steps = emission?.[at + 3] ? 0 : Math.round((Math.min(2, brightness) - 1) * lighting.steps);
          if (steps) { const next = shift(pixelId(rgba, 0), steps); if (next) rgba.set(next); }
        } else for (let c = 0; c < 3; c++) rgba[c] = Math.min(255, Math.round(rgba[c] * Math.min(1, intensity[c]) + (emission ? emission[at + c] * emission[at + 3] / 255 : 0)));
      }
      if (fade) rgba.set(hazed(fade, rgba));
      for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) {
        const tx = left + x * s + sx, ty = top + y * s + sy;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) { clipped.set(label, (clipped.get(label) ?? 0) + 1); continue; }
        const to = (ty * width + tx) * 4;
        if (shade) { const next = data[to + 3] ? shift(pixelId(data, to), shade) : null; if (next) data.set(next, to); }
        else {
          if (owner) { const o = ty * width + tx, below = owner[o]; if (below !== entry) { if (below >= 0) cover(entry, below); owner[o] = entry; } }
          alphaOver(data, to, rgba);
        }
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
    // `position` is where a placement stands, which orders it; it is drawn `lift` pixels higher. A placement attached to
    // a frame point (a held sword) stands on its target's ground line, straight below the point, and is lifted up to it,
    // so it sorts with its target and list order decides which is in front. One attached without a point follows where
    // its target stands, which stays on the ground while the target is lifted.
    let lift = liftAt(instance.lift, time);
    if (instance.attach) {
      const target = states[instance.attach.index], { point } = instance.attach;
      const spot = target && !target.hidden ? (point ? target.frame.points?.[point] : target.position) : undefined;
      if (!spot) hidden = true;
      else if (!point) position = [spot[0] + instance.at[0], spot[1] + instance.at[1]];
      else {
        position = [target.left + spot[0] * target.scale + instance.at[0], target.position[1]];
        lift += target.position[1] - (target.top + spot[1] * target.scale + instance.at[1]);
      }
    }
    states[i] = { hidden, index, frame, position, lift, left: position[0] - anchor[0] * instance.scale, top: position[1] - anchor[1] * instance.scale - lift, scale: instance.scale };
  }
  if (lighting && lit) lights = lighting.lights.map((light, i) => {
    let at = light.at, on = true, { strength, radius } = light.keys ? keyedAt(light.keys, time) : light;
    if (light.sun) {
      // Toward the sun: up from the ground, and back the way its shadows fall. Flicker changes only its strength.
      if (light.flicker) strength *= 1 + light.flicker.amount * (1 - 2 * flickerAt(light.flicker, i, time, scene.duration));
      const [sx, sy] = light.sun, length = Math.sqrt(sx * sx + sy * sy + 1);
      return { sun: light.sun, toward: [-sx / length, -sy / length, 1 / length], color: light.color, strength };
    }
    if (light.follow) {
      const target = states[light.follow.index], spot = target && !target.hidden ? (light.follow.point ? target.frame.points?.[light.follow.point] : null) : undefined;
      if (!target || target.hidden || spot === undefined) on = false;
      else if (spot) at = [target.left + spot[0] * target.scale + light.at[0], target.top + spot[1] * target.scale + light.at[1]];
      else at = [target.position[0] + light.at[0], target.position[1] + light.at[1]];
    }
    // On screen, a light moves with the scene, or with the plane of what it follows.
    const [sx, sy] = shiftOf(light.follow ? light.follow.index : -1);
    at = [at[0] - sx, at[1] - sy];
    // Flicker swings either way around the light's own strength, so a flickering light is as bright on average as a steady one.
    if (light.flicker) { const swing = light.flicker.amount * (1 - 2 * flickerAt(light.flicker, i, time, scene.duration)); strength *= 1 + swing; radius *= 1 + swing / 2; }
    return { at, height: light.height, radius, color: light.color, strength: on ? strength : 0 };
  });
  // Drawing order is list order, except that placements with sort "ground" are drawn together, where the first of
  // them is listed, ordered by their ground line (the y of their placement point), as a game draws actors and props.
  // Every placement draws each of its repeat copies, row by row. A tilemap draws once, or, with sort "ground", each of
  // its cells joins the group, standing on the bottom row of its frame, so a wall or a tree taller than its tile covers
  // whoever stands behind it. Equal lines keep list order, then map order.
  // Each item's rank is where its placement, or its sorted group, starts drawing.
  const order = [], sorted = scene.instances.flatMap((instance, i) => instance.sort === 'ground' ? [i] : []);
  const copies = i => {
    const instance = scene.instances[i], s = instance.scale;
    if (instance.tilemap) {
      if (instance.sort !== 'ground') return [{ i }];
      // A cell stands on the first screen row of the map row above `bottom`, as a placement stands on the first screen
      // row of its anchor row, so a tile and a placement on the same art row tie at any scale.
      const top = instance.at[1] - instance.anchor[1] * s;
      return instance.tilemap.cells.map((cell, k) => ({ i, cell: k, ground: top + (cell.bottom - 1) * s }));
    }
    const [columns, rows] = instance.repeat;
    return Array.from({ length: columns * rows }, (_, k) => ({ i, rx: k % columns, ry: Math.floor(k / columns), ground: states[i].position[1] + Math.floor(k / columns) * instance.step[1] }));
  };
  for (const [i, instance] of scene.instances.entries()) {
    const rank = order.length;
    if (instance.sort !== 'ground') { order.push(...copies(i).map(item => ({ ...item, rank }))); continue; }
    if (i !== sorted[0]) continue;
    // A sorted tilemap is listed among the placements where its group starts.
    order.push(...sorted.filter(j => scene.instances[j].tilemap).map(j => ({ i: j, record: true, rank })));
    order.push(...sorted.flatMap(copies).map((item, n) => ({ n, item })).sort((a, b) => a.item.ground - b.item.ground || a.n - b.n).map(({ item }) => ({ ...item, rank })));
  }
  // Shadows. A placement or tilemap with `shadow` stops each light that reaches it, over the shape its frame casts on
  // the ground: a cutout standing on its ground line and turned to face the light, falling away from the light, longer
  // the farther it stands from the light and the nearer its top comes to the light's height. Each pixel of the shadow
  // takes the cutout's column across it and the height whose shadow lands there. A shadow falls on what is drawn before
  // its caster (before the group, for a sorted caster), as a game draws shadows on the ground under everything that
  // stands, so standing things never shadow each other or themselves. A light riding a placement casts no shadow of it
  // or of what is attached to it: a held lantern. Only + - * / and sqrt, so shadows are the same in every engine.
  shadowMasks = lights.map(() => null);
  const casts = new Map();
  if (lights.length && scene.instances.some(instance => instance.shadow)) {
    const rootOf = i => scene.instances[i].attach?.index ?? i;
    const cast = (c, light, li, rank, s, project) => {
      const w = project.width * s, h = project.height * s, tall = c.ground - c.top, edge = tall + 0.5;
      if (tall <= 0) return null;
      // d is the way the shadow falls, `heightAt` the height whose shadow lands t pixels beyond the foot, and `reach`
      // how far the top row's upper edge casts.
      let dx, dy, reach, heightAt;
      if (light.sun) {
        // A sun's shadows are parallel: each pixel of height falls the length of `sun` along it. Overhead, none.
        const [sx, sy] = light.sun, L = Math.sqrt(sx * sx + sy * sy);
        if (!L) return null;
        dx = sx / L; dy = sy / L; reach = edge * L; heightAt = t => t / L;
      } else {
        const H = light.height, vx = c.pivot - light.at[0], vy = c.ground - light.at[1], D = Math.sqrt(vx * vx + vy * vy);
        // Straight under a light a cutout casts nothing to see, and beyond its reach the light lights nothing.
        if (D < 1 || D >= light.radius) return null;
        // A pixel of height k casts to t = D * k / (H - k); a top at or above the light's height casts to its reach.
        dx = vx / D; dy = vy / D; reach = Math.min(light.radius - D, edge < H ? D * edge / (H - edge) : Infinity); heightAt = t => t * H / (D + t);
      }
      // p runs across the shadow, turned so the cutout's left stays on the left when the light is behind it or in front.
      const side = dy < 0 ? -1 : 1, px = dy * side, py = -dx * side;
      const xs = [], ys = [];
      for (const u of [c.left - c.pivot - 1, c.left + w - c.pivot]) for (const t of [-1, reach + 1]) { xs.push(c.pivot + u * px + t * dx); ys.push(c.ground + u * py + t * dy); }
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
      const mask = shadowMasks[li] ??= new Int32Array(width * height).fill(-1);
      let pixels = 0, length = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const wx = x - c.pivot, wy = y - c.ground, t = wx * dx + wy * dy;
        if (t < -0.5 || t > reach) continue;
        const k = t > 0 ? heightAt(t) : 0, col = c.pivot + Math.round(wx * px + wy * py) - c.left, row = c.ground - Math.round(k) - c.top;
        if (col < 0 || row < 0 || col >= w || row >= h || !c.frame.data[(Math.floor(row / s) * project.width + Math.floor(col / s)) * 4 + 3]) continue;
        const at = y * width + x;
        if (mask[at] < rank) mask[at] = rank;
        pixels++;
        if (t > length) length = t;
      }
      return { pixels, length, toward: [dx, dy] };
    };
    for (const item of order) {
      const { i } = item, instance = scene.instances[i];
      if (!instance.shadow || item.record) continue;
      const project = assets[instance.asset].recipe, s = instance.scale, shift = shiftOf(i);
      let casters;
      if (instance.tilemap) {
        // Each tile casts from the middle of its frame, standing on the row it sorts by.
        const { tilemap } = instance, left = instance.at[0] - instance.anchor[0] * s - shift[0], top = instance.at[1] - instance.anchor[1] * s - shift[1];
        casters = (item.cell === undefined ? tilemap.cells : [tilemap.cells[item.cell]]).map(cell => ({ frame: project.frames[frameIndex(project, cell, 0)], left: left + cell.x * s, top: top + cell.y * s, ground: top + (cell.bottom - 1) * s, pivot: left + cell.x * s + Math.floor(project.width * s / 2) }));
      } else {
        // A placement casts from where it stands; lifted, its shadow leaves its feet.
        const state = states[i];
        if (state.hidden) continue;
        const ox = item.rx * instance.step[0] - shift[0], oy = item.ry * instance.step[1] - shift[1];
        casters = [{ frame: state.frame, left: state.left + ox, top: state.top + oy, ground: state.position[1] + oy, pivot: state.position[0] + ox }];
      }
      lights.forEach((light, li) => {
        const follow = scene.lighting.lights[li].follow;
        if (!light.strength || (follow && rootOf(follow.index) === rootOf(i))) return;
        for (const c of casters) {
          const shadow = cast(c, light, li, item.rank, s, project);
          if (!shadow) continue;
          const key = `${i} ${li}`, seen = casts.get(key);
          if (!seen) casts.set(key, { i, light: li, casts: 1, ...shadow });
          else { seen.casts++; seen.pixels += shadow.pixels; seen.length = Math.max(seen.length, shadow.length); }
        }
      });
    }
  }
  for (const item of order) {
    const { i } = item, instance = scene.instances[i], asset = assets[instance.asset], project = asset.recipe, s = instance.scale, label = instance.name ?? `${instance.asset}#${i}`;
    if (instance.tilemap) {
      const shift = shiftOf(i), { tilemap } = instance, left = instance.at[0] - instance.anchor[0] * s - shift[0], top = instance.at[1] - instance.anchor[1] * s - shift[1];
      const box = { x: left, y: top, w: tilemap.width * s, h: tilemap.height * s };
      if (item.cell !== undefined) {
        // The cells of a sorted tilemap that stand on one row are drawn one after another and share a depth entry.
        const cell = tilemap.cells[item.cell], x = left + cell.x * s, y = top + cell.y * s, w = project.width * s, h = project.height * s;
        let entry = -1;
        if (owner && !instance.shade) {
          const last = entries.at(-1);
          if (last?.spans && last.instance === i && last.ground === item.ground) {
            const right = Math.max(last.box.x + last.box.w, x + w);
            last.spans.push([x, w]); last.tiles++; last.box.x = Math.min(last.box.x, x); last.box.w = right - last.box.x;
          } else entries.push({ instance: i, label, sorted: true, ground: item.ground, tiles: 1, spans: [[x, w]], box: { x, y, w, h }, shift, covers: false });
          entry = entries.length - 1;
        }
        drawFrame(instance.asset, frameIndex(project, cell, 0), x, y, s, label, instance.shade, instance.lit === false, entry, instance.haze, item.rank);
        continue;
      }
      if (!item.record) {
        const entry = owner && !instance.shade ? entries.push({ instance: i, label, sorted: false, box, covers: false }) - 1 : -1;
        for (const cell of tilemap.cells) drawFrame(instance.asset, frameIndex(project, cell, 0), left + cell.x * s, top + cell.y * s, s, label, instance.shade, instance.lit === false, entry, instance.haze, item.rank);
      }
      placements.push({ name: label, tilemap: true, ...box, tiles: tilemap.cells.length, scale: s, ...(instance.haze && { haze: instance.haze }) });
      continue;
    }
    const state = states[i], { rx, ry } = item;
    if (state.hidden) continue;
    const shift = shiftOf(i), left = state.left + rx * instance.step[0] - shift[0], top = state.top + ry * instance.step[1] - shift[1];
    placements.push({ name: instance.name ?? instance.asset, frame: state.frame.name, x: left, y: top, w: project.width * s, h: project.height * s, scale: s, ...(state.lift && { lift: state.lift }), ...(instance.haze && { haze: instance.haze }), ...(instance.shade && { shade: instance.shade }) });
    // A sorted copy stands at its placement point; its y is the ground line it was sorted by.
    const sorted = instance.sort === 'ground', at = [state.position[0] + rx * instance.step[0], state.position[1] + ry * instance.step[1]];
    const entry = owner && !instance.shade ? entries.push({ instance: i, label, sorted, ...(sorted && { at }), ...(sorted && state.lift && { lift: state.lift }), box: { x: left, y: top, w: project.width * s, h: project.height * s }, shift, covers: false }) - 1 : -1;
    drawFrame(instance.asset, state.index, left, top, s, label, instance.shade, instance.lit === false, entry, instance.haze, item.rank);
  }
  if (density) for (const box of placements) {
    const color = box.scale === 1 ? [65, 201, 240, 180] : [255, 70, 100, 255];
    for (let y = Math.max(0, box.y); y < Math.min(height, box.y + box.h); y++) for (let x = Math.max(0, box.x); x < Math.min(width, box.x + box.w); x++) {
      if (x === box.x || y === box.y || x === box.x + box.w - 1 || y === box.y + box.h - 1) alphaOver(data, (y * width + x) * 4, color);
    }
  }
  const total = [...clipped.values()].reduce((sum, n) => sum + n, 0), named = [...clipped].sort((a, b) => b[1] - a[1]);
  // With a camera, much of the scene is off screen at any time, so clipping is no cause for a warning.
  const clipWarning = total && !camera ? [`${total} drawn pixels clipped at scene bounds (${named.slice(0, 4).map(([name, n]) => `${name} ${n}`).join(', ')}${named.length > 4 ? `, ${named.length - 4} more` : ''}).`] : [];
  // Where each light was and how strong, rounded for reading; viewers draw their markers from it.
  const round = v => Math.round(v * 100) / 100;
  const lightsNow = lights.map(light => (light.sun ? { sun: light.sun, strength: round(light.strength) } : { at: light.at.map(round), radius: round(light.radius), strength: round(light.strength) }));
  // Each hazed placement (the first 16) with the colours its palette keys became before lighting: an asset entry's
  // `palette` that draws the same far copy.
  const hazy = scene.instances.flatMap((instance, i) => (instance.haze ? [[instance, i]] : [])).slice(0, 16).map(([instance, i]) => {
    const project = assets[instance.asset].recipe, palette = {};
    for (const key of Object.keys(project.palette)) {
      const rgba = parseColor(key, project.palette);
      if (!rgba[3]) continue;
      const out = hazed(instance.haze, rgba);
      if (out.some((v, c) => v !== rgba[c])) palette[key] = `#${[...out, ...(rgba[3] === 255 ? [] : [rgba[3]])].map(v => v.toString(16).padStart(2, '0')).join('')}`;
    }
    return { name: instance.name ?? `${instance.asset}#${i}`, haze: instance.haze, palette };
  });
  // Each casting placement (the first 16) with each light it casts from: how many pixels its shadow covers, how far it
  // reaches from where the placement stands, and, for a single caster, the way it falls. A tilemap or repeated
  // placement counts its casts and sums its pixels. A name several placements share gets #index, as in the depth report.
  const shared = new Map();
  for (const instance of scene.instances) if (instance.name !== undefined) shared.set(instance.name, (shared.get(instance.name) ?? 0) + 1);
  const nameOf = i => { const { name, asset } = scene.instances[i]; return name !== undefined && shared.get(name) === 1 ? name : `${name ?? asset}#${i}`; };
  const shadows = [...casts.values()].slice(0, 16).map(({ i, light, casts: n, pixels, length, toward }) => ({ name: nameOf(i), light, pixels, length: Math.round(length), ...(n === 1 ? { toward: toward.map(round) } : { casts: n }) }));
  const result = { data, width, height, placements, warnings: [...scene.warnings, ...clipWarning], ...(total && { clipped: Object.fromEntries(named) }), ...(lightsNow.length && { lights: lightsNow }), ...(shadows.length && { shadows }), ...(hazy.length && { haze: hazy }), ...(camera && { camera: camera.map(round) }) };
  if (depth) {
    // Who covers whom, largest first. Placements that lie straight on the background (a floor, a backdrop, a tilemap
    // under everything) are the ground and are left out as the one behind; sorted placements always count.
    // A name several placements share gets #index, its position in `instances`, as unnamed placements do.
    const counts = new Map();
    for (const instance of scene.instances) if (instance.name !== undefined) counts.set(instance.name, (counts.get(instance.name) ?? 0) + 1);
    for (const e of entries) if (counts.get(e.label) > 1) e.label = `${e.label}#${e.instance}`;
    const labels = new Map(entries.map(e => [e.instance, e.label])), sorted = entries.filter(e => e.sorted);
    const overlaps = [...pairs].map(([key, pixels]) => { const [front, behind] = key.split(' ').map(Number); return { front: labels.get(front), behind: labels.get(behind), pixels }; }).sort((a, b) => b.pixels - a.pixels);
    const omitted = { ...(sorted.length > 64 && { sorted: sorted.length - 64 }), ...(overlaps.length > 32 && { overlaps: overlaps.length - 32 }) };
    // A row of a sorted tilemap is listed by the row it stands on and how many of its tiles stand there.
    result.depth = { ...(sorted.length && { sorted: sorted.slice(0, 64).map(e => (e.spans ? { name: e.label, ground: e.ground, tiles: e.tiles } : { name: e.label, at: e.at, ...(e.lift && { lift: e.lift }) })) }), overlaps: overlaps.slice(0, 32), ...(Object.keys(omitted).length && { omitted }),
      ...(!scene.instances.some(instance => instance.sort === 'ground') && overlaps.length && { note: 'No placement has sort: "ground", so placements draw in list order. Give everything that stands on the ground sort: "ground" to draw it by where it stands.' }) };
    Object.defineProperty(result, 'depthMap', { value: { owner, entries } });
  }
  return result;
}

// Far to near: cool to warm. Each tint is darkened by the pixel's own value, so forms still read.
const DEPTH_RAMP = [[70, 110, 255], [60, 205, 215], [245, 205, 60], [255, 90, 70]];
const depthTint = t => {
  const u = Math.min(0.999999, Math.max(0, t)) * (DEPTH_RAMP.length - 1), k = Math.floor(u), f = u - k;
  return DEPTH_RAMP[k].map((v, c) => v + (DEPTH_RAMP[k + 1][c] - v) * f);
};
// The scene image a reviewer sees, enlarged: `color`, `grayscale` or `depth`, with optional perspective guides. The
// depth view tints each placement by when it is drawn, cool for far and warm for near; the ground (placements that lie
// straight on the background) is grey. Each sorted placement shows its ground line, white across its width, with a
// mark at its placement point, so an anchor on the wrong row shows at once, and dashes up to a lifted placement; a
// sorted tilemap's line runs under each tile, on the bottom row of its frame.
export function sceneImage(view, { mode = 'color', scale = 1, guides } = {}) {
  if (!['color', 'grayscale', 'depth'].includes(mode)) fail('scene.view', 'expected color, grayscale or depth');
  const { width, height } = view, s = scale, w = width * s, h = height * s;
  const checked = guides === undefined || guides === null ? null : readGuides(guides, 'guides');
  let native = mode === 'grayscale' ? reviewPixels(view.data, 'grayscale') : view.data, out;
  if (mode === 'depth') {
    if (!view.depthMap) fail('scene.view', 'render the scene with depth: true for the depth view');
    const { owner, entries } = view.depthMap, coloured = entries.filter(e => e.sorted || e.covers), tints = new Map();
    coloured.forEach((e, rank) => tints.set(e, depthTint(coloured.length < 2 ? 1 : rank / (coloured.length - 1))));
    const tintOf = o => (o >= 0 ? tints.get(entries[o]) : undefined);
    native = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const at = i * 4, d = view.data, value = (0.2126 * d[at] + 0.7152 * d[at + 1] + 0.0722 * d[at + 2]) / 255 * d[at + 3] / 255, tint = tintOf(owner[i]);
      if (tint) native.set([...tint.map(v => Math.round(v * (0.35 + 0.65 * value))), 255], at);
      else { const grey = Math.round(owner[i] < 0 ? 20 + value * 40 : 40 + value * 110); native.set([grey, grey, grey, 255], at); }
    }
    out = scalePixels(native, width, height, s);
    const put = (x, y, color) => { if (x >= 0 && y >= 0 && x < w && y < h) out.set(color, (y * w + x) * 4); };
    // A dark edge where one placement's visible pixels meet another's.
    if (s >= 2) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = owner[y * width + x];
      if (x + 1 < width && o !== owner[y * width + x + 1] && (tintOf(o) || tintOf(owner[y * width + x + 1]))) for (let k = 0; k < s; k++) put(x * s + s - 1, y * s + k, [12, 12, 20, 255]);
      if (y + 1 < height && o !== owner[(y + 1) * width + x] && (tintOf(o) || tintOf(owner[(y + 1) * width + x]))) for (let k = 0; k < s; k++) put(x * s + k, y * s + s - 1, [12, 12, 20, 255]);
    }
    for (const e of entries) if (e.sorted) {
      // A tile row's line runs under each of its tiles; it has no placement point to mark. Ground lines and points are
      // in scene coordinates, so they move on screen as their placement does.
      const ay = ((e.spans ? e.ground : e.at[1]) - e.shift[1]) * s;
      for (const [x0, span] of e.spans ?? [[e.box.x, e.box.w]]) for (let x = x0 * s; x < (x0 + span) * s; x++) { put(x, ay, [255, 255, 255, 255]); put(x, ay + 1, [12, 12, 20, 255]); }
      if (e.spans) continue;
      const ax = (e.at[0] - e.shift[0]) * s;
      // A tick on the line at the placement point (a pixel corner, so two pixels wide), edged dark.
      for (let dy = -4; dy <= -1; dy++) for (let dx = -2; dx <= 1; dx++) put(ax + dx, ay + dy, dx === -2 || dx === 1 ? [12, 12, 20, 255] : [255, 255, 255, 255]);
      // A lifted placement: dashes from the tick up to the point it is drawn at, so a jump shows how high above its
      // ground line it is.
      if (e.lift > 0) for (let y = ay - 5; y >= ay - e.lift * s; y--) if ((ay - 5 - y) % 4 < 2) for (let dx = -2; dx <= 1; dx++) put(ax + dx, y, dx === -2 || dx === 1 ? [12, 12, 20, 255] : [255, 255, 255, 255]);
    }
  } else out = scalePixels(native, width, height, s);
  if (checked) drawGuides(out, w, { left: 0, top: 0, w, h }, s, { x: 0, y: 0 }, checked);
  return { data: out, width: w, height: h, ...(checked && { guides: checked }) };
}
// Kept for compatibility: the 3x3 repeat plus the same advisory seam evidence as `inspect --view tile`.
export function inspectTile(project, frameName = project.frames[0].name) {
  const index = project.frames.findIndex(f => f.name === frameName);
  if (index < 0) fail('tile.frame', 'unknown frame');
  const frame = project.frames[index];
  return { data: tileRepeat(frame.data, project.width, project.height), width: project.width * 3, height: project.height * 3, ...tileReport(frame.data, project.width, project.height), note: 'Advisory: doubled edge lines and wrap steps larger than any interior boundary suggest a visible seam. Review the 3×3 repeat.' };
}
