// Optional authoring compilers. All output is ordinary, editable version-1 recipe data.
import { PixelError, parseColor, renderProject } from './core.js';
import { BLOB_MASKS, CARDINAL_MASKS } from './autotile.js';
import { EASINGS, ease, rotateRows } from './craft.js';

const fail = (path, message) => { throw new PixelError(path, message); };
export function fields(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key) || value[key] === null) fail(`${path}.${key}`, 'unknown or null field');
}
export function point(value, path, bound = 4096) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(v => !Number.isInteger(v) || Math.abs(v) > bound)) fail(path, `expected two integer coordinates within ±${bound}`);
  return value;
}
const identifier = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) fail(path, 'expected a named part, pose or marker');
  return value;
};
// Compiled output is plain JSON data (null-prototype maps are only used while compiling).
const plain = value => JSON.parse(JSON.stringify(value));

export function compilePoses(source) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'parts', 'poses', 'animations', 'sheet'], 'poses');
  if (source.format !== 'pixelforge-poses' || source.version !== 1) fail('poses', 'expected version-1 pixelforge-poses');
  if (!source.parts || Array.isArray(source.parts) || typeof source.parts !== 'object' || Object.keys(source.parts).length > 256) fail('poses.parts', 'expected at most 256 part definitions');
  const symbols = Object.create(null);
  for (const [name, part] of Object.entries(source.parts)) {
    identifier(name, `poses.parts.${name}`);
    fields(part, ['rows', 'anchor', 'points'], `poses.parts.${name}`);
    point(part.anchor ?? [0, 0], `poses.parts.${name}.anchor`);
    if (part.points !== undefined && (!part.points || typeof part.points !== 'object' || Array.isArray(part.points))) fail(`poses.parts.${name}.points`, 'expected named attachment points');
    for (const [key, value] of Object.entries(part.points ?? {})) { identifier(key, `poses.parts.${name}.points`); point(value, `poses.parts.${name}.points.${key}`); }
    if (!Array.isArray(part.rows) || !part.rows.length || typeof part.rows[0] !== 'string') fail(`poses.parts.${name}.rows`, 'expected equal-width text rows');
    symbols[name] = part.rows;
  }
  if (!Array.isArray(source.poses) || !source.poses.length || source.poses.length > 256) fail('poses.poses', 'expected 1–256 authored key poses');
  const metadata = { format: 'pixelforge-pose-metadata', version: 1, coordinates: 'unscaled source pixels; top-left origin; positive y down; marker times are milliseconds before playback-rate adjustment', poses: Object.create(null), animations: Object.create(null) };
  const compiled = Object.create(null), shapes = new Map();
  // The drawn shape of a part instance. Flips alone stay a stamp flag; a rotation (after any flip) is baked into a new
  // editable symbol named <part>-r<degrees> (-fr when flipped, -raw without cleanup) around the part's anchor pixel.
  const shapeOf = (name, flipX, rotate, cleanup, where) => {
    const definition = source.parts[name], width = definition.rows[0].length, anchor = definition.anchor ?? [0, 0];
    const local = ([x, y]) => [flipX ? width - 1 - x : x, y];
    const angle = ((rotate % 360) + 360) % 360;
    if (!angle) return { symbol: name, width, flipX, anchor: local(anchor), point: local };
    const tidy = cleanup && angle % 90 !== 0, key = `${name}\n${flipX}\n${angle}\n${tidy}`;
    if (!shapes.has(key)) {
      const symbol = `${name}-${flipX ? 'f' : ''}r${angle}${tidy || angle % 90 === 0 ? '' : '-raw'}`;
      if (Object.hasOwn(source.parts, symbol) || symbol.length > 64) fail(where, `a rotated part needs the symbol name ${symbol}; rename that part definition or shorten ${name}`);
      const rows = flipX ? definition.rows.map(row => [...row].reverse().join('')) : definition.rows;
      const turned = rotateRows(rows, angle, local(anchor), { cleanup: tidy });
      if (turned.rows.length > 256 || turned.rows[0].length > 256) fail(where, `rotating ${name} by ${angle}° exceeds 256×256 pixels`);
      symbols[symbol] = turned.rows;
      shapes.set(key, { symbol, width: turned.rows[0].length, flipX: false, anchor: turned.pivot, point: p => turned.map(local(p)) });
    }
    return shapes.get(key);
  };
  const frames = source.poses.map((pose, index) => {
    const path = `poses.poses[${index}]`;
    fields(pose, ['name', 'duration', 'origin', 'parts', 'markers', 'mirror', 'tween'], path);
    identifier(pose.name, `${path}.name`);
    if (Object.hasOwn(compiled, pose.name)) fail(`${path}.name`, 'duplicate pose');
    let origin, placed, layers, markers, inputs = null, tween = null;
    if (pose.mirror !== undefined) {
      // A horizontal mirror of an earlier pose around its origin, the anchor corner between pixel columns originX - 1
      // and originX: pixel column c maps to 2 * originX - 1 - c. This is the same reflection as drawFrame's flipX and
      // engines that flip around the atlas pivot, so a compiled mirror and a runtime flip draw identical pixels.
      for (const key of ['parts', 'markers', 'origin', 'tween']) if (pose[key] !== undefined) fail(`${path}.${key}`, 'mirrored poses reuse the source pose, its markers and its origin');
      identifier(pose.mirror, `${path}.mirror`);
      const from = compiled[pose.mirror];
      if (!from) fail(`${path}.mirror`, 'must name an earlier pose');
      origin = from.origin;
      const reflect = x => 2 * origin[0] - 1 - x;
      placed = Object.create(null); layers = [];
      for (const layer of from.layers) {
        const instance = from.placed[layer.name], stamp = layer.ops[0], width = symbols[stamp.symbol][0].length;
        const x = reflect(stamp.x + width - 1), y = stamp.y, flipX = !instance.flipX;
        placed[layer.name] = { definition: instance.definition, ...(instance.symbol && { symbol: instance.symbol }), ...(flipX && { flipX }), ...(instance.rotate && { rotate: -instance.rotate }), topLeft: [x, y], anchor: [reflect(instance.anchor[0]), instance.anchor[1]], points: Object.fromEntries(Object.entries(instance.points).map(([key, p]) => [key, [reflect(p[0]), p[1]]])) };
        layers.push({ name: layer.name, ops: [{ op: 'stamp', symbol: stamp.symbol, x, y, ...(!stamp.flipX && { flipX: true }) }] });
      }
      markers = from.markers.map(marker => ({ ...marker, at: [reflect(marker.at[0]), marker.at[1]] }));
    } else {
      let spec = pose, partsPath = `${path}.parts`;
      if (pose.tween !== undefined) {
        // An in-between: origin, offsets and angles interpolate (then round to whole pixels and degrees); part
        // definitions and flips switch at the eased halfway point. Attachments must match, so held items follow.
        for (const key of ['parts', 'origin']) if (pose[key] !== undefined) fail(`${path}.${key}`, 'tween poses interpolate the parts and origin of two earlier poses');
        fields(pose.tween, ['from', 'to', 't', 'ease'], `${path}.tween`);
        const [a, b] = ['from', 'to'].map(key => {
          identifier(pose.tween[key], `${path}.tween.${key}`);
          const end = compiled[pose.tween[key]];
          if (!end) fail(`${path}.tween.${key}`, 'must name an earlier pose');
          if (!end.inputs) fail(`${path}.tween.${key}`, 'tween between authored or tweened poses; mirror the finished tween instead');
          return end.inputs;
        });
        const t = pose.tween.t, easing = pose.tween.ease ?? 'linear';
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) fail(`${path}.tween.t`, 'expected a number from 0 to 1');
        if (!EASINGS.includes(easing)) fail(`${path}.tween.ease`, `expected one of ${EASINGS.join(', ')}`);
        if (a.parts.length !== b.parts.length || a.parts.some((part, i) => part.name !== b.parts[i].name)) fail(`${path}.tween`, 'both poses must list the same part instances in the same order');
        const e = ease(easing, t), mix = (u, v) => Math.round(u + (v - u) * e);
        spec = { origin: a.origin.map((v, axis) => mix(v, b.origin[axis])), parts: a.parts.map((p, i) => {
          const q = b.parts[i], near = e < 0.5 ? p : q, rotate = mix(p.rotate, q.rotate);
          if ((p.attach?.part ?? null) !== (q.attach?.part ?? null) || (p.attach?.point ?? null) !== (q.attach?.point ?? null)) fail(`${path}.tween`, `part ${p.name} must attach the same way in both poses`);
          return { name: p.name, part: near.part, ...(p.attach && { attach: p.attach }), at: p.at.map((v, axis) => mix(v, q.at[axis])), ...(near.flipX && { flipX: true }), ...(rotate && { rotate }), ...(!near.cleanup && { cleanup: false }) };
        }) };
        partsPath = `${path}.tween`; tween = { from: pose.tween.from, to: pose.tween.to, t, ...(pose.tween.ease !== undefined && { ease: easing }) };
      }
      origin = point(spec.origin ?? [0, 0], `${path}.origin`); placed = Object.create(null);
      if (!Array.isArray(spec.parts) || spec.parts.length > 64) fail(partsPath, 'expected at most 64 parts in back-to-front order');
      inputs = { origin, parts: [] };
      layers = spec.parts.map((instance, i) => {
        const ip = spec === pose ? `${partsPath}[${i}]` : `${partsPath} (${instance.name})`;
        fields(instance, ['name', 'part', 'at', 'attach', 'flipX', 'rotate', 'cleanup'], ip);
        identifier(instance.name, `${ip}.name`);
        if (Object.hasOwn(placed, instance.name)) fail(`${ip}.name`, 'duplicate part instance');
        if (typeof instance.part !== 'string' || !Object.hasOwn(source.parts, instance.part)) fail(`${ip}.part`, 'unknown part definition');
        for (const key of ['flipX', 'cleanup']) if (instance[key] !== undefined && typeof instance[key] !== 'boolean') fail(`${ip}.${key}`, 'expected a boolean');
        if (instance.rotate !== undefined && (!Number.isInteger(instance.rotate) || Math.abs(instance.rotate) > 360)) fail(`${ip}.rotate`, 'expected whole degrees from -360 to 360, clockwise');
        const definition = source.parts[instance.part], flipX = instance.flipX === true, rotate = instance.rotate ?? 0, cleanup = instance.cleanup !== false;
        // A flipped part mirrors its own grid, anchor and points inside the part's width; a rotated one turns around
        // its anchor pixel, carrying its points along.
        const shape = shapeOf(instance.part, flipX, rotate, cleanup, ip);
        let parent = origin;
        if (instance.attach !== undefined) {
          fields(instance.attach, ['part', 'point'], `${ip}.attach`);
          identifier(instance.attach.part, `${ip}.attach.part`); identifier(instance.attach.point, `${ip}.attach.point`);
          const part = placed[instance.attach.part];
          if (!part || !Object.hasOwn(part.points, instance.attach.point)) fail(`${ip}.attach`, 'attachment must name a point on an earlier part in this pose');
          parent = part.points[instance.attach.point];
        }
        const at = point(instance.at ?? [0, 0], `${ip}.at`), x = parent[0] + at[0] - shape.anchor[0], y = parent[1] + at[1] - shape.anchor[1];
        inputs.parts.push({ name: instance.name, part: instance.part, ...(instance.attach && { attach: { part: instance.attach.part, point: instance.attach.point } }), at, flipX, rotate, cleanup });
        placed[instance.name] = { definition: instance.part, ...(shape.symbol !== instance.part && { symbol: shape.symbol }), ...(flipX && { flipX }), ...(rotate && { rotate }), topLeft: [x, y], anchor: [x + shape.anchor[0], y + shape.anchor[1]], points: Object.fromEntries(Object.entries(definition.points ?? {}).map(([key, p]) => { const [px, py] = shape.point(p); return [key, [x + px, y + py]]; })) };
        return { name: instance.name, ops: [{ op: 'stamp', symbol: shape.symbol, x, y, ...(shape.flipX && { flipX: true }) }] };
      });
      if (pose.markers !== undefined && (!Array.isArray(pose.markers) || pose.markers.length > 64)) fail(`${path}.markers`, 'expected at most 64 markers');
      const seen = new Set();
      markers = (pose.markers ?? []).map((marker, i) => {
        fields(marker, ['name', 'part', 'point'], `${path}.markers[${i}]`);
        identifier(marker.name, `${path}.markers[${i}].name`);
        if (seen.has(marker.name)) fail(`${path}.markers[${i}].name`, 'marker names are unique within a pose');
        seen.add(marker.name);
        identifier(marker.part, `${path}.markers[${i}].part`); identifier(marker.point, `${path}.markers[${i}].point`);
        const part = placed[marker.part];
        if (!part || !Object.hasOwn(part.points, marker.point)) fail(`${path}.markers[${i}]`, 'marker must name a placed attachment point');
        return { name: marker.name, part: marker.part, point: marker.point, at: part.points[marker.point] };
      });
    }
    const duration = pose.duration ?? (pose.mirror !== undefined ? compiled[pose.mirror].duration : undefined);
    compiled[pose.name] = { origin, placed, layers, markers, duration, inputs };
    metadata.poses[pose.name] = { origin, ...(pose.mirror !== undefined && { mirror: pose.mirror }), ...(tween && { tween }), parts: placed, markers };
    // The pose origin becomes the frame anchor; marker positions become named frame points in the atlas.
    return { name: pose.name, ...(duration !== undefined && { duration }), anchor: origin, ...(markers.length && { points: Object.fromEntries(markers.map(m => [m.name, m.at])) }), layers };
  });
  // When every pose shares one origin, it is declared once as the recipe anchor.
  const shared = frames.every(frame => frame.anchor[0] === frames[0].anchor[0] && frame.anchor[1] === frames[0].anchor[1]);
  if (shared) for (const frame of frames) delete frame.anchor;
  const recipe = { version: 1, name: source.name, width: source.width, height: source.height, palette: source.palette ?? {}, ...(shared && { anchor: compiled[source.poses[0].name].origin }), symbols, frames, ...(source.animations !== undefined && { animations: source.animations }), ...(source.sheet !== undefined && { sheet: source.sheet }) };
  const project = renderProject(recipe);
  for (const [name, animation] of Object.entries(project.animations)) {
    let start = 0;
    metadata.animations[name] = { duration: animation.duration, loop: animation.loop, entries: animation.frames.map((index, position) => {
      const frame = project.frames[index], entry = { position, frame: frame.name, start, duration: frame.duration, markers: metadata.poses[frame.name].markers };
      start += frame.duration; return entry;
    }) };
  }
  return plain({ recipe, metadata });
}

// Compiles a small template into an autotile set. The template is two tiles wide and three tall:
//   [ unused preview ][ inner corners ]
//   [ 2x2 island whose quadrants give outer corners, edges and fill ]
// Every output frame is one `autotile` operation naming its neighbour mask, so editing the template updates the set.
export function compileAutotile(source) {
  fields(source, ['format', 'version', 'name', 'tile', 'mode', 'palette', 'template', 'frame', 'variants', 'animation', 'sheet'], 'autotile');
  if (source.format !== 'pixelforge-autotile' || source.version !== 1) fail('autotile', 'expected version-1 pixelforge-autotile');
  const tile = source.tile;
  if (!Number.isInteger(tile) || tile < 2 || tile > 128 || tile % 2) fail('autotile.tile', 'expected an even tile size from 2 to 128');
  const mode = source.mode ?? 'blob';
  if (!['blob', 'cardinal'].includes(mode)) fail('autotile.mode', 'expected blob or cardinal');
  const template = source.template;
  if (!Array.isArray(template) || template.length !== tile * 3 || template.some(row => typeof row !== 'string' || row.length !== tile * 2)) fail('autotile.template', `expected ${tile * 3} rows of ${tile * 2} characters (two tiles wide, three tall)`);
  if (typeof source.frame !== 'string' || !source.frame.includes('{mask}')) fail('autotile.frame', 'expected a frame name template containing {mask}');
  const variants = source.variants ?? [{ name: '' }];
  if (!Array.isArray(variants) || !variants.length || variants.length > 16) fail('autotile.variants', 'expected 1–16 variants');
  if (source.variants !== undefined && !source.frame.includes('{variant}')) fail('autotile.frame', 'with variants, the frame template must contain {variant}');
  // A variant may recolour the set (palette), time it (duration) or redraw it from its own template of the same size:
  // cracked or mossy stone, say, that keeps the base set's edge geometry. Its template becomes the symbol
  // template-<variant>.
  const symbols = { template };
  variants.forEach((variant, i) => {
    fields(variant, ['name', 'duration', 'palette', 'template'], `autotile.variants[${i}]`);
    if (typeof variant.name !== 'string' || (source.variants !== undefined && !/^[A-Za-z0-9_-]{1,16}$/.test(variant.name))) fail(`autotile.variants[${i}].name`, 'expected 1–16 letters, digits, hyphens or underscores');
    if (variant.template === undefined) return;
    if (!Array.isArray(variant.template) || variant.template.length !== tile * 3 || variant.template.some(row => typeof row !== 'string' || row.length !== tile * 2)) fail(`autotile.variants[${i}].template`, `expected ${tile * 3} rows of ${tile * 2} characters, the size of the base template`);
    symbols[`template-${variant.name}`] = variant.template;
  });
  if (source.animation !== undefined && (typeof source.animation !== 'string' || !source.animation.includes('{mask}'))) fail('autotile.animation', 'expected an animation name template containing {mask}');
  const frames = [], animations = {};
  for (const mask of mode === 'cardinal' ? CARDINAL_MASKS : BLOB_MASKS) {
    const names = [];
    for (const variant of variants) {
      const name = source.frame.replaceAll('{mask}', String(mask)).replaceAll('{variant}', variant.name);
      names.push(name);
      frames.push({ name, ...(variant.duration !== undefined && { duration: variant.duration }), ...(variant.palette !== undefined && { palette: variant.palette }), ops: [{ op: 'autotile', symbol: variant.template === undefined ? 'template' : `template-${variant.name}`, mask, ...(mode === 'cardinal' && { mode }) }] });
    }
    if (source.animation !== undefined) animations[source.animation.replaceAll('{mask}', String(mask))] = { frames: names };
  }
  const recipe = { version: 1, name: source.name, width: tile, height: tile, palette: source.palette ?? {}, symbols, frames, ...(source.animation !== undefined && { animations }), ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject(recipe);
  return plain({ recipe, metadata: { format: 'pixelforge-autotile-metadata', version: 1, mode, masks: mode === 'cardinal' ? [...CARDINAL_MASKS] : [...BLOB_MASKS], bits: mode === 'cardinal' ? { n: 1, e: 2, s: 4, w: 8 } : { n: 1, ne: 2, e: 4, se: 8, s: 16, sw: 32, w: 64, nw: 128 } } });
}

// Normal directions as palette keys (+X right, +Y down, +Z toward the viewer). Digits are laid out like a numeric
// keypad and tilt 30° from facing (5 faces the viewer, 8 leans up, 3 down-right); the letters q w e / a d / z x c
// sit the same way on a keyboard and tilt 60°, so a generated pass reads as letters around its rims and digits
// across its faces. Built from exact constants, without trigonometry, so every engine encodes the same colours.
const KEYPAD = { 7: [-1, -1], 8: [0, -1], 9: [1, -1], 4: [-1, 0], 6: [1, 0], 1: [-1, 1], 2: [0, 1], 3: [1, 1] };
const STEEP = { q: '7', w: '8', e: '9', a: '4', d: '6', z: '1', x: '2', c: '3' };
const direction = ([x, y], lean) => { const across = x && y ? lean * Math.SQRT1_2 : lean; return Object.freeze([x * across, y * across, Math.sqrt(1 - lean * lean)]); };
export const NORMAL_DIRECTIONS = Object.freeze({ 5: Object.freeze([0, 0, 1]), ...Object.fromEntries(Object.entries(KEYPAD).map(([key, way]) => [key, direction(way, 0.5)])), ...Object.fromEntries(Object.entries(STEEP).map(([key, digit]) => [key, direction(KEYPAD[digit], Math.sqrt(0.75))])) });
const encodeNormal = vector => '#' + vector.map(v => Math.round((v + 1) * 127.5).toString(16).padStart(2, '0')).join('');

// Derives a normal pass from a colour recipe's rendered frames: each separate shape is inflated from its silhouette
// into a rounded surface (a quarter circle `bevel` pixels wide, or reaching the shape's thickest point), lighter
// colours are optionally raised by `detail` (a colour's step along its ramp, or its brightness on no ramp), and each
// pixel's slope is quantized to the nearest of NORMAL_DIRECTIONS. Transparent pixels are edges; the canvas border is
// not, so tiles and shapes cut by the frame stay open, and frames with `wrap` read their slopes across the border.
// The output is an ordinary recipe aligned with the colour recipe: same size, frame names and durations, animations
// and atlas layout. Mirrored frames get mirrored normals because they are derived from the drawn pixels.
export function compileNormals(source) {
  fields(source, ['format', 'version', 'name', 'recipe', 'bevel', 'detail'], 'normals');
  if (source.format !== 'pixelforge-normals' || source.version !== 1) fail('normals', 'expected version-1 pixelforge-normals');
  const spec = source.recipe;
  if (typeof spec === 'string' || (spec && typeof spec === 'object' && spec.revision !== undefined && spec.version === undefined)) fail('normals.recipe', 'file and revision references are resolved by the CLI and MCP; inline the recipe to compile here');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('normals.recipe', 'expected the colour recipe, inline or as a file reference');
  if (spec.format !== undefined) fail('normals.recipe', `expected a recipe, not a ${spec.format} source; compile it first and derive normals from the result`);
  if (source.bevel !== undefined && (!Number.isInteger(source.bevel) || source.bevel < 1 || source.bevel > 64)) fail('normals.bevel', 'expected 1–64 pixels from the edge to the flat top; omit it to round each shape up to its thickest point');
  const detail = source.detail ?? 0;
  if (typeof detail !== 'number' || !Number.isFinite(detail) || detail < 0 || detail > 1) fail('normals.detail', 'expected 0 (shape only) to 1');
  const project = renderProject(spec), { width: w, height: h } = project, size = w * h;
  if (source.name === undefined && project.name.length > 57) fail('normals.name', `${project.name}-normal would exceed 64 characters; name the normal recipe`);
  const name = source.name ?? `${project.name}-normal`;
  // Brightness from 0 to 1 per colour: its step along the first ramp that holds it, otherwise its luma.
  const value = new Map();
  for (const ramp of project.ramps) ramp.forEach((key, i) => { const [r, g, b] = parseColor(key, project.palette); const id = `${r},${g},${b}`; if (!value.has(id)) value.set(id, i / (ramp.length - 1)); });
  const brightness = (data, at) => value.get(`${data[at]},${data[at + 1]},${data[at + 2]}`) ?? (0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2]) / 255;
  const keys = Object.keys(NORMAL_DIRECTIONS), counts = Object.create(null);
  const frames = project.frames.map((frame, index) => {
    const data = frame.data, solid = i => data[i * 4 + 3] > 0, wrap = spec.frames?.[index]?.wrap === true;
    // Chamfer distance to the nearest transparent pixel (3 per step, 4 per diagonal step), in two passes.
    const distance = new Float64Array(size);
    for (let i = 0; i < size; i++) distance[i] = solid(i) ? Infinity : 0;
    const relax = (x, y, dx, dy, cost) => { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h) distance[y * w + x] = Math.min(distance[y * w + x], distance[ny * w + nx] + cost); };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (solid(y * w + x)) { relax(x, y, -1, 0, 3); relax(x, y, 0, -1, 3); relax(x, y, -1, -1, 4); relax(x, y, 1, -1, 4); }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) if (solid(y * w + x)) { relax(x, y, 1, 0, 3); relax(x, y, 0, 1, 3); relax(x, y, 1, 1, 4); relax(x, y, -1, 1, 4); }
    // Each 8-connected shape is rounded on its own, so separate props in one frame each get a full dome.
    const shape = new Int32Array(size).fill(-1), thickest = [];
    for (let start = 0; start < size; start++) if (solid(start) && shape[start] < 0) {
      const label = thickest.length, stack = [start];
      let deepest = 0;
      shape[start] = label;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i - x) / w;
        deepest = Math.max(deepest, distance[i]);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, j = ny * w + nx;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && solid(j) && shape[j] < 0) { shape[j] = label; stack.push(j); }
        }
      }
      thickest.push(deepest);
    }
    const height = new Float64Array(size);
    for (let i = 0; i < size; i++) if (solid(i)) {
      // A shape with no transparent pixel around it (a filled tile) has no rim and stays flat apart from detail.
      const reach = source.bevel ?? (Number.isFinite(thickest[shape[i]]) ? thickest[shape[i]] / 3 : 0);
      const t = reach ? Math.min(distance[i] / 3, reach) / reach : 1;
      height[i] = reach * Math.sqrt(1 - (1 - t) * (1 - t)) + detail * 2 * brightness(data, i * 4);
    }
    const at = (x, y) => {
      if (wrap) { x = ((x % w) + w) % w; y = ((y % h) + h) % h; } else { x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y)); }
      return height[y * w + x];
    };
    const rows = [];
    for (let y = 0; y < h; y++) {
      let row = '';
      for (let x = 0; x < w; x++) {
        if (!solid(y * w + x)) { row += '.'; continue; }
        // Sobel slopes in pixels of height per pixel; the surface normal leans downhill.
        const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
        const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
        let best = '5', score = -Infinity;
        for (const key of keys) { const [nx, ny, nz] = NORMAL_DIRECTIONS[key], s = -gx * nx - gy * ny + nz; if (s > score) { score = s; best = key; } }
        row += best; counts[best] = (counts[best] ?? 0) + 1;
      }
      rows.push(row);
    }
    return { name: frame.name, duration: frame.duration, ops: [{ op: 'grid', x: 0, y: 0, rows }] };
  });
  const used = keys.filter(key => counts[key]);
  const recipe = { version: 1, name, width: w, height: h, palette: Object.fromEntries(keys.map(key => [key, encodeNormal(NORMAL_DIRECTIONS[key])])), frames, ...(spec.animations !== undefined && { animations: spec.animations }), ...(spec.sheet !== undefined && { sheet: spec.sheet }) };
  renderProject(recipe);
  return plain({ recipe, metadata: { format: 'pixelforge-normals-metadata', version: 1, encoding: 'RGB = (XYZ + 1) × 127.5; +X right, +Y down, +Z toward the viewer', bevel: source.bevel ?? 'each shape to its thickest point', detail, directions: Object.fromEntries(keys.map(key => [key, NORMAL_DIRECTIONS[key].map(v => Math.round(v * 1e4) / 1e4)])), pixels: Object.fromEntries(used.map(key => [key, counts[key]])) } });
}
