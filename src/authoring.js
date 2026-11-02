// Optional authoring compilers. All output is ordinary, editable version-1 recipe data.
import { PixelError, CANVAS_SIDE, parseColor, renderProject, describeStampRecipe, readRows } from './core.js';
import { AUTOTILE_MODES, MODE_MASKS, MODE_BITS, tilePieces, templatePiece } from './autotile.js';
import { terrainTemplate, mergeTerrain, normalTerrain, readTerrain, templateSeams, seamWarnings, testMapRecipe, layeredTestMapRecipe } from './terrain.js';
import { slopeTiles, slopeCollision, slopeLegend, SLOPE_MAP } from './slopes.js';
import { EASINGS, ease, rotateRows, rasterizeBone, rasterizeMass } from './craft.js';
import { turn, angleDelta, solveReach } from './pose-geometry.js';
import { expandMotions, validateRig, MOTION_TEMPLATES } from './motions.js';

const fail = (path, message) => { throw new PixelError(path, message); };
export function fields(value, keys, path, nullable = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key) || (value[key] === null && !nullable.includes(key))) fail(`${path}.${key}`, 'unknown or null field');
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

function structuralPart(part, source, path) {
  const kind = part.bone !== undefined ? 'bone' : 'mass', shape = part[kind], p = `${path}.${kind}`;
  fields(shape, kind === 'bone' ? ['length', 'width', 'ramp', 'base', 'outline', 'caps', 'snap'] : ['size', 'ramp', 'base', 'outline', 'flat'], p, ['outline']);
  const integer = (value, at, low, high) => {
    if (!Number.isInteger(value) || value < low || value > high) fail(at, `expected an integer from ${low} to ${high}`);
  };
  if (kind === 'bone') {
    integer(shape.length, `${p}.length`, 1, 64);
    if (!Array.isArray(shape.width) || ![2, 3].includes(shape.width.length)) fail(`${p}.width`, 'expected [start, end] or [start, middle, end]');
    shape.width.forEach((value, i) => integer(value, `${p}.width[${i}]`, 1, 16));
    if (shape.snap !== undefined && typeof shape.snap !== 'boolean') fail(`${p}.snap`, 'expected a boolean');
    if (shape.caps !== undefined && (!Array.isArray(shape.caps) || shape.caps.length !== 2 || shape.caps.some(cap => !['round', 'flat', 'point', 'socket'].includes(cap)))) fail(`${p}.caps`, 'expected two round, flat, point or socket caps');
  } else {
    if (!Array.isArray(shape.size) || shape.size.length !== 2) fail(`${p}.size`, 'expected [width, height]');
    shape.size.forEach((value, i) => integer(value, `${p}.size[${i}]`, 2, 64));
    if (shape.flat !== undefined && typeof shape.flat !== 'boolean') fail(`${p}.flat`, 'expected a boolean');
  }
  if (!source.ramps?.length) fail(`${p}.ramp`, 'this pose source has no ramps: add "ramps" (lists of palette keys from dark to light), or link a shared palette file that lists them');
  integer(shape.ramp, `${p}.ramp`, 0, source.ramps.length - 1);
  const ramp = source.ramps[shape.ramp];
  if (!Array.isArray(ramp) || ramp.length < 2 || ramp.length > 32) fail(`poses.ramps[${shape.ramp}]`, 'expected 2–32 palette keys from dark to light');
  for (const [i, key] of ramp.entries()) {
    if (typeof key !== 'string' || key.length !== 1 || !Object.hasOwn(source.palette ?? {}, key) || key === '.' || key === ' ') fail(`poses.ramps[${shape.ramp}][${i}]`, 'structural parts need one-character palette keys');
  }
  integer(shape.base, `${p}.base`, 0, ramp.length - 1);
  if (shape.outline !== undefined && shape.outline !== null && shape.outline !== 'selective'
    && (typeof shape.outline !== 'string' || shape.outline.length !== 1 || !Object.hasOwn(source.palette ?? {}, shape.outline) || ['.', ' '].includes(shape.outline))) fail(`${p}.outline`, 'expected a one-character palette key, selective, or null');
  if (part.anchor !== undefined) fail(`${path}.anchor`, 'bones anchor at the start joint; masses anchor at their centre, flat masses at the middle of their base row');
}

// Templates check planted-foot reach on many single poses; they need resolved joints, not a validated recipe. The
// probe mode is private to this module (a symbol nobody else holds), so compilePoses' public contract is unchanged.
const PROBE = Symbol('pose probe');
export function expandPoses(source) { return expandMotions(source, compilePoses, probe => compilePoses(probe, PROBE)); }
// Nominal pixels visited while drawing distinct bone and mass shapes in one compile (see rasterizeMass). Real rigs use
// a few percent of it; a source that would draw for seconds fails fast with a path instead of blocking the caller.
export const RASTER_BUDGET = 8388608;

// Where each pose of an expanded source was written: expansion appends generated poses and moves an authored pose that
// replaces a generated one to the end, so an authored pose keeps its index in the input and a generated pose is named
// by its motion. Paths in errors and warnings then point at something the author can edit.
function writtenPoses(input, expanded) {
  const found = new Map();
  input.poses.forEach((pose, i) => found.set(pose?.name, { path: `poses.poses[${i}]` }));
  for (const motion of Object.keys(expanded.motionInfo ?? {})) for (const name of expanded.animations[motion].frames)
    if (!found.has(name)) found.set(name, { path: `poses.motions.${motion} (${name})`, motion });
  return found;
}

// How many of each frame's stamped pixels fall outside the canvas, and the canvas box they cover. A symbol's opaque
// pixels and their bounds are counted once; only a stamp that crosses an edge is counted pixel by pixel.
function stampsOutside(frames, symbols, width, height) {
  const inks = new Map(), inkOf = name => {
    if (!inks.has(name)) {
      const rows = symbols[name], ink = { rows, width: rows[0].length, count: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] !== '.' && row[x] !== ' ') { ink.count++; ink.x0 = Math.min(ink.x0, x); ink.x1 = Math.max(ink.x1, x); ink.y0 = Math.min(ink.y0, y); ink.y1 = Math.max(ink.y1, y); } });
      inks.set(name, ink);
    }
    return inks.get(name);
  };
  return frames.map(frame => {
    let total = 0, outside = 0, box = null;
    for (const layer of frame.layers) for (const { symbol, x, y, flipX } of layer.ops) {
      const ink = inkOf(symbol);
      if (!ink.count) continue;
      const column = c => x + (flipX ? ink.width - 1 - c : c), x0 = Math.min(column(ink.x0), column(ink.x1)), x1 = Math.max(column(ink.x0), column(ink.x1)), y0 = y + ink.y0, y1 = y + ink.y1;
      total += ink.count;
      box = box ? [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)] : [x0, y0, x1, y1];
      if (x0 >= 0 && y0 >= 0 && x1 < width && y1 < height) continue;
      if (x1 < 0 || y1 < 0 || x0 >= width || y0 >= height) { outside += ink.count; continue; }
      ink.rows.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] !== '.' && row[c] !== ' ') { const px = column(c), py = y + r; if (px < 0 || py < 0 || px >= width || py >= height) outside++; } });
    }
    return { name: frame.name, total, outside, box };
  });
}
const nameList = (names, limit = 3) => names.slice(0, limit).join(', ') + (names.length > limit ? ` and ${names.length - limit} more` : '');
const span = (low, high) => low === high ? `${low}` : `${low} to ${high}`;

export function compilePoses(source, mode) {
  let written = null;
  if (source?.motions !== undefined) { const input = source; source = expandPoses(source); written = writtenPoses(input, source); }
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'ramps', 'light', 'rig', 'motionInfo', 'parts', 'poses', 'animations', 'sheet'], 'poses');
  if (source.format !== 'pixelforge-poses' || source.version !== 1) fail('poses', 'expected version-1 pixelforge-poses');
  if (source.light !== undefined && (!Number.isInteger(source.light) || source.light < 0 || source.light > 359)) fail('poses.light', 'expected whole degrees from 0 to 359');
  if (source.ramps !== undefined && (!Array.isArray(source.ramps) || source.ramps.length > 64)) fail('poses.ramps', 'expected at most 64 colour ramps');
  if (source.rig !== undefined) validateRig(source.rig, source.height);
  if (!source.parts || Array.isArray(source.parts) || typeof source.parts !== 'object' || Object.keys(source.parts).length > 256) fail('poses.parts', 'expected at most 256 part definitions');
  const symbols = Object.create(null);
  for (const [name, part] of Object.entries(source.parts)) {
    identifier(name, `poses.parts.${name}`);
    fields(part, ['rows', 'bone', 'mass', 'anchor', 'points', 'views'], `poses.parts.${name}`);
    if (['rows', 'bone', 'mass'].filter(key => part[key] !== undefined).length !== 1) fail(`poses.parts.${name}`, 'choose exactly one of rows, bone or mass');
    const structural = part.bone !== undefined || part.mass !== undefined;
    if (structural) structuralPart(part, source, `poses.parts.${name}`);
    point(part.anchor ?? [0, 0], `poses.parts.${name}.anchor`);
    if (part.points !== undefined && (!part.points || typeof part.points !== 'object' || Array.isArray(part.points))) fail(`poses.parts.${name}.points`, 'expected named attachment points');
    for (const [key, value] of Object.entries(part.points ?? {})) {
      identifier(key, `poses.parts.${name}.points`);
      if (value !== 'end' || !part.bone) point(value, `poses.parts.${name}.points.${key}`, structural ? 64 : 4096);
    }
    if (!structural) {
      if (!Array.isArray(part.rows) || !part.rows.length || typeof part.rows[0] !== 'string') fail(`poses.parts.${name}.rows`, 'expected equal-width text rows');
      symbols[name] = part.rows;
    }
    if (part.views !== undefined) {
      const vp = `poses.parts.${name}.views`;
      if (structural) fail(vp, 'authored views belong to grid parts');
      if (!part.views || typeof part.views !== 'object' || Array.isArray(part.views) || !Object.keys(part.views).length || Object.keys(part.views).length > 16) fail(vp, 'expected 1–16 drawings keyed by whole degrees from 0 to 359');
      for (const [angle, view] of Object.entries(part.views)) {
        if (!/^(0|[1-9][0-9]{0,2})$/.test(angle) || Number(angle) > 359) fail(`${vp}.${angle}`, 'expected whole degrees from 0 to 359');
        fields(view, ['rows', 'anchor', 'points'], `${vp}.${angle}`);
        readRows(view.rows, `${vp}.${angle}.rows`, source.palette ?? {});
        point(view.anchor, `${vp}.${angle}.anchor`);
        if (view.points !== undefined) fields(view.points, Object.keys(part.points ?? {}), `${vp}.${angle}.points`);
        for (const key of Object.keys(part.points ?? {})) point(view.points?.[key], `${vp}.${angle}.points.${key}`);
      }
    }
  }
  if (!Array.isArray(source.poses) || !source.poses.length || source.poses.length > 256) fail('poses.poses', 'expected 1–256 authored key poses');
  const metadata = { format: 'pixelforge-pose-metadata', version: 1, coordinates: 'unscaled source pixels; top-left origin; positive y down; marker times are milliseconds before playback-rate adjustment', poses: Object.create(null), animations: Object.create(null) };
  if (source.rig !== undefined) metadata.rig = { ...source.rig };
  // generated: what a warning on a generated pose is about, so the text warnings can say it once per motion.
  const compiled = Object.create(null), shapes = new Map(), warnings = [], generated = new WeakMap();
  let rasterWork = 0;
  // The drawn shape of a part instance. Flips alone stay a stamp flag; a rotation (after any flip) is baked into a new
  // editable symbol named <part>-r<degrees> (-fr when flipped, -raw without cleanup) around the part's anchor pixel.
  const shapeOf = (name, flipX, rotate, cleanup, where, squash = 1) => {
    const definition = source.parts[name];
    const angle = ((rotate % 360) + 360) % 360;
    if (definition.bone || definition.mass) {
      const key = `${name}\nbone\n${flipX}\n${angle}\n${squash}`;
      if (!shapes.has(key)) {
        const symbol = `${name}-${flipX ? 'f' : ''}b${angle}${definition.mass && squash !== 1 ? `s${Math.round(squash * 100)}` : ''}`;
        if (Object.hasOwn(source.parts, symbol) || symbol.length > 64) fail(where, `a structural part needs the symbol name ${symbol}; rename that part definition or shorten ${name}`);
        const shape = definition.bone ?? definition.mass;
        const options = { angle, flipX, squash, light: source.light ?? 225, ramp: source.ramps[shape.ramp] };
        const raster = definition.bone ? rasterizeBone(shape, options) : rasterizeMass(shape, options);
        // Each distinct drawing is charged once per compile, by its nominal cost, so the verdict never depends on caches.
        rasterWork += raster.work;
        if (rasterWork > RASTER_BUDGET) fail(where, `drawing bone and mass parts exceeds the 8,388,608-pixel budget; reuse angles and squash values, or use smaller masses`);
        symbols[symbol] = raster.rows;
        shapes.set(key, { symbol, width: raster.width, height: raster.height, fill: raster.fill, outline: raster.outlineMask,
          flipX: false, anchor: raster.pivot, end: raster.end, point: p => p === 'end' ? raster.end : raster.map(p) });
      }
      return shapes.get(key);
    }
    const width = definition.rows[0].length, anchor = definition.anchor ?? [0, 0];
    const local = ([x, y]) => [flipX ? width - 1 - x : x, y];
    if (definition.views) {
      const facing = flipX ? turn(-angle) : angle;
      const nearest = Object.keys(definition.views).map(Number).sort((a, b) => Math.abs(angleDelta(facing, a)) - Math.abs(angleDelta(facing, b)) || a - b)[0];
      if (Math.abs(angleDelta(facing, nearest)) <= 22.5) {
        const view = definition.views[nearest], symbol = `${name}-v${nearest}`, viewWidth = view.rows[0].length;
        if (Object.hasOwn(source.parts, symbol) || symbol.length > 64) fail(where, `an authored view needs symbol ${symbol}; rename or shorten its part`);
        symbols[symbol] = view.rows;
        const map = ([x, y]) => [flipX ? viewWidth - 1 - x : x, y];
        return { symbol, flipX, anchor: map(view.anchor), view: nearest, point: (p, key) => map(view.points[key]) };
      }
    }
    if (!angle) return { symbol: name, flipX, anchor: local(anchor), point: local };
    const tidy = cleanup && angle % 90 !== 0, key = `${name}\n${flipX}\n${angle}\n${tidy}`;
    if (!shapes.has(key)) {
      const symbol = `${name}-${flipX ? 'f' : ''}r${angle}${tidy || angle % 90 === 0 ? '' : '-raw'}`;
      if (Object.hasOwn(source.parts, symbol) || symbol.length > 64) fail(where, `a rotated part needs the symbol name ${symbol}; rename that part definition or shorten ${name}`);
      const rows = flipX ? definition.rows.map(row => [...row].reverse().join('')) : definition.rows;
      const turned = rotateRows(rows, angle, local(anchor), { cleanup: tidy });
      if (turned.rows.length > 256 || turned.rows[0].length > 256) fail(where, `rotating ${name} by ${angle}° exceeds 256×256 pixels`);
      symbols[symbol] = turned.rows;
      shapes.set(key, { symbol, flipX: false, anchor: turned.pivot, point: p => turned.map(local(p)) });
    }
    return shapes.get(key);
  };
  const reflectInputs = from => {
    const reflect = x => 2 * from.origin[0] - 1 - x, authored = (from.inputs ?? from.mirrorInputs).parts;
    return { origin: from.origin, parts: authored.map(p => ({
      name: p.name, part: p.part, at: [p.attach ? -p.at[0] : -p.at[0] - 1, p.at[1]],
      ...(p.attach && { attach: p.attach }), flipX: !p.flipX,
      ...(p.reach ? { reach: [reflect(p.reach[0]), p.reach[1]], bend: (p.bend ?? 'forward') === 'forward' ? 'back' : 'forward' }
        : p.angle !== undefined ? { angle: -p.angle } : { rotate: -(p.rotate ?? 0) }),
      ...(p.cleanup === false && { cleanup: false }), ...(p.squash !== undefined && { squash: p.squash })
    })) };
  };
  const frames = source.poses.map((pose, index) => {
    const writtenAs = written?.get(pose?.name), path = writtenAs?.path ?? `poses.poses[${index}]`, motion = writtenAs?.motion;
    fields(pose, ['name', 'duration', 'origin', 'parts', 'markers', 'contacts', 'mirror', 'relight', 'tween'], path);
    identifier(pose.name, `${path}.name`);
    if (Object.hasOwn(compiled, pose.name)) fail(`${path}.name`, 'duplicate pose');
    let origin, placed, layers, markers, inputs = null, mirrorInputs = null, tween = null;
    if (pose.relight !== undefined && (typeof pose.relight !== 'boolean' || pose.mirror === undefined)) fail(`${path}.relight`, 'expected a boolean on a mirror pose');
    let mirroredFrom;
    if (pose.mirror !== undefined) {
      for (const key of ['parts', 'markers', 'contacts', 'origin', 'tween']) if (pose[key] !== undefined) fail(`${path}.${key}`, 'mirrored poses reuse the source pose, its markers, contacts and its origin');
      identifier(pose.mirror, `${path}.mirror`);
      mirroredFrom = compiled[pose.mirror];
      if (!mirroredFrom) fail(`${path}.mirror`, 'must name an earlier pose');
    }
    if (pose.mirror !== undefined && !pose.relight) {
      // A horizontal mirror of an earlier pose around its origin, the anchor corner between pixel columns originX - 1
      // and originX: pixel column c maps to 2 * originX - 1 - c. This is the same reflection as drawFrame's flipX and
      // engines that flip around the atlas pivot, so a compiled mirror and a runtime flip draw identical pixels.
      const from = mirroredFrom;
      origin = from.origin;
      mirrorInputs = reflectInputs(from);
      const reflect = x => 2 * origin[0] - 1 - x;
      placed = Object.create(null); layers = [];
      for (const layer of from.layers) {
        const instance = from.placed[layer.name], stamp = layer.ops[0], width = symbols[stamp.symbol][0].length;
        const x = reflect(stamp.x + width - 1), y = stamp.y, flipX = !instance.flipX;
        placed[layer.name] = { definition: instance.definition, ...(instance.symbol && { symbol: instance.symbol }), ...(flipX && { flipX }), ...(instance.rotate && { rotate: -instance.rotate }),
          ...(instance.angle !== undefined && { angle: -instance.angle }), ...(instance.worldAngle !== undefined && { worldAngle: turn(-instance.worldAngle) }),
          ...(instance.joints && { joints: Object.fromEntries(Object.entries(instance.joints).map(([key, p]) => [key, [reflect(p[0]), p[1]]])) }),
          ...(instance.reach && { reach: { ...instance.reach, target: [reflect(instance.reach.target[0]), instance.reach.target[1]] } }),
          ...(instance.view !== undefined && { view: instance.view }),
          ...(instance.squash !== undefined && { squash: instance.squash }),
          topLeft: [x, y], anchor: [reflect(instance.anchor[0]), instance.anchor[1]], points: Object.fromEntries(Object.entries(instance.points).map(([key, p]) => [key, [reflect(p[0]), p[1]]])) };
        layers.push({ name: layer.name, ops: [{ op: 'stamp', symbol: stamp.symbol, x, y, ...(!stamp.flipX && { flipX: true }) }] });
      }
      markers = from.markers.map(marker => ({ ...marker, at: [reflect(marker.at[0]), marker.at[1]] }));
    } else {
      let spec = pose, partsPath = `${path}.parts`;
      if (pose.relight) {
        // Keep the original attachment graph when available, so rerasterized parent joints drive children.
        spec = reflectInputs(mirroredFrom);
        partsPath = `${path}.mirror`;
      }
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
          const squash = Math.max(.5, Math.min(2, Math.round(((p.squash ?? 1) + ((q.squash ?? 1) - (p.squash ?? 1)) * e) * 20) / 20));
          if ((p.angle !== undefined) !== (q.angle !== undefined) || Boolean(p.reach) !== Boolean(q.reach)) fail(`${path}.tween`, `part ${p.name} must use the same angle or reach mode in both poses`);
          const angle = p.angle !== undefined ? angleDelta(0, Math.round(p.angle + angleDelta(p.angle, q.angle) * e)) : undefined;
          return { name: p.name, part: near.part, ...(p.attach && { attach: p.attach }), at: p.at.map((v, axis) => mix(v, q.at[axis])),
            ...(near.flipX && { flipX: true }), ...(angle !== undefined ? { angle } : rotate ? { rotate } : {}),
            ...(p.reach && { reach: p.reach.map((v, axis) => mix(v, q.reach[axis])), ...(near.bend && { bend: near.bend }) }),
            ...(!near.cleanup && { cleanup: false }), ...(source.parts[near.part].mass && { squash }) };
        }) };
        partsPath = `${path}.tween`; tween = { from: pose.tween.from, to: pose.tween.to, t, ...(pose.tween.ease !== undefined && { ease: easing }) };
      }
      origin = point(spec.origin ?? [0, 0], `${path}.origin`); placed = Object.create(null);
      if (!Array.isArray(spec.parts) || spec.parts.length > 64) fail(partsPath, 'expected at most 64 parts in back-to-front order');
      inputs = { origin, parts: [] };
      const instances = new Map(), owners = new Map(), worldAngles = new Map(), solved = new Map(), resolvedShapes = new Map();
      const instancePath = (instance, i) => spec === pose && motion === undefined ? `${partsPath}[${i}]` : `${partsPath} (${instance.name})`;
      spec.parts.forEach((instance, i) => {
        const ip = instancePath(instance, i);
        fields(instance, ['name', 'part', 'at', 'attach', 'flipX', 'rotate', 'angle', 'reach', 'bend', 'cleanup', 'squash'], ip);
        identifier(instance.name, `${ip}.name`);
        if (instances.has(instance.name)) fail(`${ip}.name`, 'duplicate part instance');
        instances.set(instance.name, i);
      });
      // Resolve the whole attachment graph independently of paint order. A cycle reports every source path.
      const checkGraph = (i, done, stack = []) => {
        if (done.has(i)) return;
        const instance = spec.parts[i], ip = instancePath(instance, i), cycle = stack.indexOf(i);
        if (cycle >= 0) fail(`${ip}.attach`, `attachment cycle: ${[...stack.slice(cycle), i].map(j => instancePath(spec.parts[j], j)).join(' -> ')}`);
        if (instance.attach !== undefined) {
          fields(instance.attach, ['part', 'point'], `${ip}.attach`);
          identifier(instance.attach.part, `${ip}.attach.part`); identifier(instance.attach.point, `${ip}.attach.point`);
          if (!instances.has(instance.attach.part)) fail(`${ip}.attach`, 'attachment must name a point on a part in this pose');
          checkGraph(instances.get(instance.attach.part), done, [...stack, i]);
        }
        done.add(i);
      };
      const checked = new Set(); spec.parts.forEach((_, i) => checkGraph(i, checked));
      spec.parts.forEach((instance, i) => {
        const ip = instancePath(instance, i);
        if (instance.bend !== undefined && (!instance.reach || !['forward', 'back'].includes(instance.bend))) fail(`${ip}.bend`, 'expected forward or back on a reach chain');
        if (instance.reach === undefined) return;
        point(instance.reach, `${ip}.reach`);
        if (instance.rotate !== undefined || instance.angle !== undefined) fail(`${ip}.reach`, 'reach replaces the last bone angle');
        const parent = spec.parts[instances.get(instance.attach?.part)], first = source.parts[parent?.part], second = source.parts[instance.part];
        if (!first?.bone || !second?.bone || first.points?.[instance.attach?.point] !== 'end') fail(`${ip}.reach`, 'reach needs a bone attached to the end point of another bone');
        if (instance.at !== undefined && point(instance.at, `${ip}.at`).some(Boolean)) fail(`${ip}.at`, 'a reach chain must meet at its shared joint; omit at or use [0, 0]');
        if (owners.has(parent.name) || parent.reach !== undefined) fail(`${ip}.reach`, 'reach chains cannot overlap or share their first bone');
        owners.set(parent.name, instance);
      });
      const resolve = i => {
        const instance = spec.parts[i];
        if (Object.hasOwn(placed, instance.name)) return;
        const ip = spec === pose ? `${partsPath}[${i}]` : `${partsPath} (${instance.name})`;
        if (typeof instance.part !== 'string' || !Object.hasOwn(source.parts, instance.part)) fail(`${ip}.part`, 'unknown part definition');
        for (const key of ['flipX', 'cleanup']) if (instance[key] !== undefined && typeof instance[key] !== 'boolean') fail(`${ip}.${key}`, 'expected a boolean');
        for (const key of ['rotate', 'angle']) if (instance[key] !== undefined && (!Number.isInteger(instance[key]) || Math.abs(instance[key]) > 360)) fail(`${ip}.${key}`, 'expected whole degrees from -360 to 360, clockwise');
        if (instance.angle !== undefined && instance.rotate !== undefined) fail(`${ip}.angle`, 'choose relative angle or absolute rotate, not both');
        const definition = source.parts[instance.part], flipX = instance.flipX === true, cleanup = instance.cleanup !== false;
        const squash = instance.squash ?? 1;
        if (instance.squash !== undefined && (!definition.mass || typeof squash !== 'number' || !Number.isFinite(squash) || squash < .5 || squash > 2 || Math.abs(squash * 20 - Math.round(squash * 20)) > 1e-9)) fail(`${ip}.squash`, 'mass parts take squash from 0.5 to 2 in steps of 0.05');
        if (!cleanup && (definition.bone || definition.mass)) fail(`${ip}.cleanup`, 'structural parts always use pixel-craft cleanup');
        // A flipped part mirrors its own grid, anchor and points inside the part's width; a rotated one turns around
        // its anchor pixel, carrying its points along.
        let parent = origin, parentAngle = 0;
        if (instance.attach !== undefined) {
          resolve(instances.get(instance.attach.part));
          const part = placed[instance.attach.part];
          if (!part || !Object.hasOwn(part.points, instance.attach.point)) fail(`${ip}.attach`, 'attachment must name a point on a part in this pose');
          parent = part.points[instance.attach.point];
          parentAngle = worldAngles.get(instance.attach.part);
        }
        const at = point(instance.at ?? [0, 0], `${ip}.at`), anchor = [parent[0] + at[0], parent[1] + at[1]];
        let rotate = instance.angle !== undefined ? turn(parentAngle + instance.angle) : instance.rotate ?? 0;
        if (owners.has(instance.name)) {
          const child = owners.get(instance.name);
          const solution = solveReach(definition.bone, source.parts[child.part].bone, child.reach.map((v, axis) => v - anchor[axis]),
            { rest: [rotate, 0], flip: [flipX, child.flipX === true], bend: child.bend ?? 'forward' });
          rotate = solution.angles[0]; solved.set(child.name, solution);
          if (solution.unreachable) {
            const warning = { path: `${instancePath(child, instances.get(child.name))}.reach`, message: `Target is out of reach by ${Math.round(solution.error * 1000) / 1000} px; the chain uses its closest ${solution.straightened ? 'straight' : 'folded'} pose.`, error: solution.error };
            warnings.push(warning);
            if (motion !== undefined) generated.set(warning, { kind: 'reach', motion, pose: pose.name, part: child.name, error: solution.error, straightened: solution.straightened });
          }
        }
        if (solved.has(instance.name)) rotate = solved.get(instance.name).angles[1];
        worldAngles.set(instance.name, rotate);
        const shape = shapeOf(instance.part, flipX, rotate, cleanup, ip, squash), x = anchor[0] - shape.anchor[0], y = anchor[1] - shape.anchor[1];
        resolvedShapes.set(instance.name, shape);
        inputs.parts[i] = { name: instance.name, part: instance.part, ...(instance.attach && { attach: { part: instance.attach.part, point: instance.attach.point } }),
          at, flipX, rotate: instance.rotate ?? 0, ...(instance.angle !== undefined && { angle: instance.angle }), ...(instance.reach && { reach: instance.reach, ...(instance.bend && { bend: instance.bend }) }), cleanup, ...(definition.mass && { squash }) };
        placed[instance.name] = { definition: instance.part, ...(shape.symbol !== instance.part && { symbol: shape.symbol }), ...(flipX && { flipX }), ...(rotate && { rotate }),
          ...(instance.angle !== undefined && { angle: instance.angle }), ...(definition.bone && { worldAngle: turn(rotate), joints: { start: anchor, end: [x + shape.end[0], y + shape.end[1]] } }),
          ...(instance.reach && { reach: { target: instance.reach, error: solved.get(instance.name).error, unreachable: solved.get(instance.name).unreachable } }),
          ...(shape.view !== undefined && { view: shape.view }),
          ...(definition.mass && { squash }),
          topLeft: [x, y], anchor, points: Object.fromEntries(Object.entries(definition.points ?? {}).map(([key, p]) => { const [px, py] = shape.point(p, key); return [key, [x + px, y + py]]; })) };
      };
      spec.parts.forEach((_, i) => resolve(i));
      // Metadata and layers follow authored order even when resolution visited a later parent first.
      placed = Object.fromEntries(spec.parts.map(instance => [instance.name, placed[instance.name]]));
      layers = spec.parts.map((instance, index) => {
        const part = placed[instance.name], shape = resolvedShapes.get(instance.name);
        let symbol = shape.symbol;
        const parent = placed[instance.attach?.part], parentShape = resolvedShapes.get(instance.attach?.part);
        // A socket may overlap a bent parent's filled area beyond the small cap radius. The child's exterior
        // outline must not paint a seam through that union. Keep authored layer order and only open this socket.
        if (shape.outline && parentShape?.fill && instances.get(instance.attach.part) < index
          && source.parts[instance.part].bone && (source.parts[instance.part].bone.caps?.[0] ?? 'socket') === 'socket') {
          const rows = symbols[symbol].map(row => [...row]);
          let changed = false, fingerprint = 2166136261;
          for (let y = 0; y < shape.height; y++) for (let x = 0; x < shape.width; x++) {
            const at = y * shape.width + x;
            if (!shape.outline[at]) continue;
            const px = part.topLeft[0] + x - parent.topLeft[0], py = part.topLeft[1] + y - parent.topLeft[1];
            if (px >= 0 && py >= 0 && px < parentShape.width && py < parentShape.height && parentShape.fill[py * parentShape.width + px]) {
              rows[y][x] = '.'; changed = true; fingerprint = Math.imul(fingerprint ^ at, 16777619) >>> 0;
            }
          }
          if (changed) {
            symbol = `${shape.symbol}-j${fingerprint.toString(36)}`;
            const joined = rows.map(row => row.join(''));
            if (symbol.length > 64 || Object.hasOwn(source.parts, symbol) || (symbols[symbol] && JSON.stringify(symbols[symbol]) !== JSON.stringify(joined))) fail(partsPath, `socket symbol ${symbol} collides or is too long; shorten or rename the part`);
            symbols[symbol] = joined; part.symbol = symbol;
          }
        }
        return { name: instance.name, ops: [{ op: 'stamp', symbol, x: part.topLeft[0], y: part.topLeft[1], ...(shape.flipX && { flipX: true }) }] };
      });
      const markerSpecs = pose.relight ? mirroredFrom.markers.map(({ name, part, point }) => ({ name, part, point })) : pose.markers;
      if (markerSpecs !== undefined && (!Array.isArray(markerSpecs) || markerSpecs.length > 64)) fail(`${path}.markers`, 'expected at most 64 markers');
      const seen = new Set();
      markers = (markerSpecs ?? []).map((marker, i) => {
        fields(marker, ['name', 'part', 'point'], `${path}.markers[${i}]`);
        identifier(marker.name, `${path}.markers[${i}].name`);
        if (seen.has(marker.name)) fail(`${path}.markers[${i}].name`, 'marker names are unique within a pose');
        seen.add(marker.name);
        identifier(marker.part, `${path}.markers[${i}].part`); identifier(marker.point, `${path}.markers[${i}].point`);
        // `placed` is an ordinary object here, so look up own keys only: "toString" must not find Object.prototype.
        const part = Object.hasOwn(placed, marker.part) ? placed[marker.part] : undefined;
        if (!part || !Object.hasOwn(part.points, marker.point)) fail(`${path}.markers[${i}]`, 'marker must name a placed attachment point');
        return { name: marker.name, part: marker.part, point: marker.point, at: part.points[marker.point] };
      });
    }
    const duration = pose.duration ?? (pose.mirror !== undefined ? compiled[pose.mirror].duration : undefined);
    const contacts = pose.mirror !== undefined ? mirroredFrom.contacts : pose.contacts;
    if (contacts !== undefined && (!Array.isArray(contacts) || contacts.length > 64 || new Set(contacts).size !== contacts.length || contacts.some(name => !markers.some(marker => marker.name === name)))) fail(`${path}.contacts`, 'expected up to 64 unique marker names from this pose');
    compiled[pose.name] = { origin, placed, layers, markers, contacts, duration, inputs, mirrorInputs };
    metadata.poses[pose.name] = { origin, ...(pose.mirror !== undefined && { mirror: pose.mirror }), ...(pose.relight !== undefined && { relight: pose.relight }), ...(tween && { tween }), parts: placed, markers, ...(contacts !== undefined && { contacts }) };
    // The pose origin becomes the frame anchor; marker positions become named frame points in the atlas.
    return { name: pose.name, ...(duration !== undefined && { duration }), anchor: origin, ...(markers.length && { points: Object.fromEntries(markers.map(m => [m.name, m.at])) }), layers };
  });
  if (mode === PROBE) return { metadata: { poses: metadata.poses } };
  // When every pose shares one origin, it is declared once as the recipe anchor.
  const shared = frames.every(frame => frame.anchor[0] === frames[0].anchor[0] && frame.anchor[1] === frames[0].anchor[1]);
  if (shared) for (const frame of frames) delete frame.anchor;
  const recipe = { version: 1, name: source.name, width: source.width, height: source.height, palette: source.palette ?? {}, ...(source.ramps !== undefined && { ramps: source.ramps }), ...(shared && { anchor: compiled[source.poses[0].name].origin }), symbols, frames, ...(source.animations !== undefined && { animations: source.animations }), ...(source.sheet !== undefined && { sheet: source.sheet }) };
  if (source.rig?.rest !== undefined) {
    const rest = compiled[source.rig.rest];
    if (!rest) fail('poses.rig.rest', 'unknown rest pose');
    for (const name of [source.rig.body, source.rig.head, ...(source.rig.legs ?? []).flat(), ...(source.rig.arms ?? []).flat(), ...(source.rig.tail ?? [])].filter(n => n !== undefined)) if (!Object.hasOwn(rest.placed, name)) fail('poses.rig', `unknown rest-pose instance ${name}`);
    // Rig output keeps only used, distinct drawings. Lexical selection is independent of cache insertion order.
    const used = [...new Set(frames.flatMap(frame => frame.layers.map(layer => layer.ops[0].symbol)))].sort();
    const canonical = new Map(), aliases = new Map(), unique = {};
    for (const name of used) {
      const rows = symbols[name], key = JSON.stringify(rows);
      if (!canonical.has(key)) { canonical.set(key, name); unique[name] = rows; }
      aliases.set(name, canonical.get(key));
    }
    for (const frame of frames) for (const layer of frame.layers) {
      const stamp = layer.ops[0], before = stamp.symbol; stamp.symbol = aliases.get(before);
      const part = metadata.poses[frame.name].parts[layer.name];
      if (part.symbol || before !== stamp.symbol) part.symbol = stamp.symbol;
    }
    recipe.symbols = unique;
  }
  const project = describeStampRecipe(recipe);
  if (source.motionInfo !== undefined) {
    fields(source.motionInfo, Object.keys(project.animations), 'poses.motionInfo');
    for (const [name, info] of Object.entries(source.motionInfo)) {
      const path = `poses.motionInfo.${name}`; fields(info, ['template', 'speed', 'keyPoses'], path);
      if (!MOTION_TEMPLATES.includes(info.template)) fail(`${path}.template`, 'expected a motion template name');
      if (typeof info.speed !== 'number' || !Number.isFinite(info.speed) || Math.abs(info.speed) > 1024) fail(`${path}.speed`, 'expected pixels per second within ±1024');
      const names = new Set(project.animations[name].frames.map(index => project.frames[index].name));
      if (!Array.isArray(info.keyPoses) || !info.keyPoses.length || info.keyPoses.length > 256 || new Set(info.keyPoses).size !== info.keyPoses.length || info.keyPoses.some(pose => !names.has(pose))) fail(`${path}.keyPoses`, 'expected unique key-pose names from this animation');
    }
  }
  for (const [name, animation] of Object.entries(project.animations)) {
    let start = 0;
    metadata.animations[name] = { duration: animation.duration, loop: animation.loop, ...(source.motionInfo?.[name] && source.motionInfo[name]), entries: animation.frames.map((index, position) => {
      const frame = project.frames[index], pose = metadata.poses[frame.name], entry = { position, frame: frame.name, start, duration: frame.duration, markers: pose.markers, ...(pose.contacts !== undefined && { contacts: pose.contacts }) };
      start += frame.duration; return entry;
    }) };
  }
  // Drawing outside the canvas is clipped from every export, and a figure placed off the canvas compiles to empty
  // frames without an error; say so here, where the pose that does it can be named.
  const { width, height } = recipe, canvas = `${width}x${height} canvas`, cover = box => `x ${span(box[0], box[2])}, y ${span(box[1], box[3])}`;
  // Listed first: a pose off the canvas is usually also why its feet miss the ground. When the rest pose of a rig
  // draws nothing inside the canvas, the poses the templates make from it follow it there, and its warning says so.
  const rig = source.rig, rest = rig?.rest !== undefined ? compiled[rig.rest] : undefined, clipped = [];
  let restGone = false;
  stampsOutside(frames, recipe.symbols, width, height).forEach((clip, index) => {
    if (!clip.outside) return;
    const name = clip.name, writtenAs = written?.get(name), origin = compiled[name].origin, gone = clip.outside === clip.total;
    if (gone && written && name === rig?.rest) restGone = true;
    const message = `${gone ? `Pose "${name}" draws nothing inside the ${canvas}: all ${clip.total} of its pixels fall outside` : `Pose "${name}" draws ${clip.outside} of its ${clip.total} pixels outside the ${canvas}, where they are clipped`} (its parts cover ${cover(clip.box)}). A part without attach stands at the pose origin [${origin.join(', ')}] plus its at.${gone && written && name === rig?.rest ? ' The motion templates move this pose, so the poses they make fall outside too.' : ''}`;
    const warning = { path: writtenAs?.path ?? `poses.poses[${index}]`, message, outside: clip.outside, pixels: clip.total };
    clipped.push(warning);
    if (writtenAs?.motion !== undefined) generated.set(warning, { kind: 'canvas', motion: writtenAs.motion, pose: name, outside: clip.outside, total: clip.total, box: clip.box });
  });
  warnings.unshift(...clipped);
  if (warnings.length) metadata.warnings = warnings;
  // Also as text at the top level, where every other compiler puts its warnings, so the CLI, MCP and the studio show
  // a target out of reach without anyone asking for the metadata. Warnings on generated poses are said once per
  // motion and chain, naming the poses, instead of once per pose at a path the author never wrote. A leg that already
  // ends away from rig.ground in the rest pose misses in every motion for that one reason, so it is said once per leg.
  const restEnd = part => rig?.legs?.some(chain => chain.at(-1) === part) ? rest?.placed[part]?.joints?.end : undefined;
  const offGround = part => { const end = restEnd(part); return end !== undefined && Math.abs(end[1] - rig.ground) > 1; };
  const text = [], groups = new Map();
  for (const warning of warnings) {
    const about = generated.get(warning);
    if (!about) { text.push(`${warning.path}: ${warning.message}`); continue; }
    if (about.kind === 'canvas' && restGone) continue;
    const key = about.kind === 'reach' && offGround(about.part) ? `leg\n${about.part}` : `${about.kind}\n${about.motion}\n${about.part ?? ''}`;
    if (!groups.has(key)) { groups.set(key, []); text.push(groups.get(key)); }
    groups.get(key).push(about);
  }
  const round = value => Math.round(value * 1000) / 1000;
  const grouped = items => {
    const { kind, motion, part } = items[0], one = items.length === 1, names = nameList(items.map(item => item.pose));
    if (kind === 'reach') {
      const errors = items.map(item => round(item.error)), by = `by ${span(Math.min(...errors), Math.max(...errors))} px`;
      const shape = items.every(item => item.straightened) ? 'straight' : items.some(item => item.straightened) ? 'straight or folded' : 'folded';
      if (offGround(part)) {
        const motions = [...new Set(items.map(item => item.motion))], leg = rig.legs.findIndex(chain => chain.at(-1) === part);
        return `poses.rig.legs[${leg}] (${part}): Motion templates aim the feet at rig.ground (row ${rig.ground}), but in the rest pose "${rig.rest}" this leg ends at row ${restEnd(part)[1]}, so its target is out of reach in ${items.length} generated pose${one ? '' : 's'} (${nameList(motions, 6)}) ${by} and the chain uses its closest ${shape} pose. Move the body or the pose origin until the leg ends near row ${rig.ground}, or set rig.ground to match.`;
      }
      return `poses.motions.${motion} (${part}).reach: Target is out of reach in ${items.length} of ${new Set(source.animations[motion].frames).size} poses (${names}) ${by}; the chain uses its closest ${shape} pose.${restEnd(part) ? ` In the rest pose "${rig.rest}" this leg ends on rig.ground (row ${rig.ground}), so the motion asks for more than it reaches: lower its stride, lift or bob, or lengthen the leg.` : ''}`;
    }
    const box = items.reduce((all, { box: b }) => [Math.min(all[0], b[0]), Math.min(all[1], b[1]), Math.max(all[2], b[2]), Math.max(all[3], b[3])], items[0].box);
    const nothing = items.every(item => item.outside === item.total), poses = `${items.length} of ${new Set(source.animations[motion].frames).size} poses`;
    return `poses.motions.${motion}: ${poses} ${nothing ? `draw${one ? 's' : ''} nothing inside` : `draw${one ? 's' : ''} up to ${Math.max(...items.map(item => item.outside))} pixels outside`} the ${canvas} (${names}; ${one ? 'its' : 'their'} parts cover ${cover(box)}). Generated poses move the rest pose${rig?.rest !== undefined ? ` "${rig.rest}"` : ''}: ${nothing ? 'place it inside the canvas first' : 'give it more room in the canvas, or change the motion\'s settings'}.`;
  };
  return plain({ recipe, metadata, ...(warnings.length && { warnings: text.map(item => typeof item === 'string' ? item : grouped(item)) }) });
}

// Template rows of the right size, naming every row that is not.
function templateRows(rows, tile, path) {
  const size = `${tile * 3} rows of ${tile * 2} characters (two tiles wide, three tall)`;
  if (!Array.isArray(rows) || rows.some(row => typeof row !== 'string')) fail(path, `expected ${size}`);
  const wrong = rows.flatMap((row, y) => (row.length === tile * 2 ? [] : [y]));
  const problems = [...(rows.length === tile * 3 ? [] : [`it has ${rows.length} rows`]), ...(wrong.length ? [`${wrong.slice(0, 8).map(y => `row ${y} has ${rows[y].length}`).join(', ')}${wrong.length > 8 ? ` and ${wrong.length - 8} more rows differ` : ''}`] : [])];
  if (problems.length) fail(path, `expected ${size}: ${problems.join('; ')}`);
  return rows;
}
// Draws operations over template rows on a canvas two tiles wide and three tall (or over rows of another size) and
// reads the result back as rows of one-character palette keys. Errors name the source's own paths.
function drawOverTemplate(rows, ops, { tile, palette, ramps, symbols, path, rowsPath, width = tile * 2, height = tile * 3 }) {
  if (ops === undefined) return rows;
  if (!Array.isArray(ops)) fail(path, 'expected a list of drawing operations');
  if (!ops.length) return rows;
  let project;
  try {
    project = renderProject({ version: 1, name: 'template', width, height, palette, ...(ramps !== undefined && { ramps }), symbols: { ...symbols, template: rows }, frames: [{ name: 'template', ops: [{ op: 'stamp', symbol: 'template' }, ...ops] }] });
  } catch (error) {
    if (!(error instanceof PixelError)) throw error;
    const retarget = text => text.replace(/project\.frames\[0\]\.ops\[(\d+)\]/g, (_, i) => `${path}[${i - 1}]`).replace(/project\.symbols\.template/g, rowsPath).replace(/project\.(symbols|palette|ramps)/g, 'autotile.$1');
    const moved = new PixelError(retarget(error.path), error.message.slice(error.path.length + 2).replace(/project\.[\w.[\]]+/g, retarget));
    if (error.errors) moved.errors = error.errors.map(item => ({ path: retarget(item.path), error: retarget(item.error) }));
    throw moved;
  }
  // The first one-character key of each colour, as rows are written.
  const keys = new Map([[0, '.']]);
  for (const key of Object.keys(palette)) {
    if (key.length !== 1 || key === '.' || key === ' ') continue;
    const [r, g, b, a] = parseColor(key, palette, `autotile.palette.${key}`), id = a ? (((r << 24) | (g << 16) | (b << 8) | a) >>> 0) : 0;
    if (!keys.has(id)) keys.set(id, key);
  }
  const data = project.frames[0].data, out = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4, id = data[at + 3] ? (((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0) : 0;
      if (!keys.has(id)) fail(path, `drew ${'#' + [0, 1, 2, 3].map(k => data[at + k].toString(16).padStart(2, '0')).join('')} at [${x}, ${y}], a colour no one-character palette key names; template rows hold palette keys, so give that colour a key (or draw with whole palette colours: partly transparent colours blend into new ones)`);
      row += keys.get(id);
    }
    out.push(row);
  }
  return out;
}

// Compiles an autotile set from a template two tiles wide and three tall:
//   [ preview (unused) ][ inner corners ]
//   [ 2x2 island whose quadrants give outer corners, edges and fill ]
// as 47 blob tiles, 16 cardinal ones or 16 corner ones (tiles that sit where four cells meet; mask 0, which draws
// nothing, once: Godot's painter puts it on a painted cell with no terrain point, which would otherwise lose its
// terrain).
// The template is given as rows, or drawn from a `terrain` description (src/terrain.js), with optional `ops` drawn over
// it. Every output frame is one `autotile` operation naming its neighbour mask, so editing the template updates the
// set. The result also carries a seam report (as warnings and in the metadata) and `preview`, a one-frame recipe that
// draws the set over a test map holding every tile.
export function compileAutotile(source) {
  fields(source, ['format', 'version', 'name', 'tile', 'mode', 'palette', 'ramps', 'symbols', 'template', 'terrain', 'ops', 'collision', 'frame', 'variants', 'animation', 'slopes', 'layers', 'preview', 'sheet'], 'autotile');
  if (source.format !== 'pixelforge-autotile' || source.version !== 1) fail('autotile', 'expected version-1 pixelforge-autotile');
  const tile = source.tile;
  // A template is three tiles tall and a symbol at most 256 rows, so tiles are at most 84 pixels.
  if (!Number.isInteger(tile) || tile < 2 || tile > 84 || tile % 2) fail('autotile.tile', 'expected an even tile size from 2 to 84 (the template is three tiles tall, and a symbol holds at most 256 rows)');
  const mode = source.mode ?? (source.layers !== undefined ? 'corner' : 'blob');
  if (!AUTOTILE_MODES.includes(mode)) fail('autotile.mode', 'expected blob (47 tiles), cardinal (16, no inner corners) or corner (16 tiles that sit where four cells meet)');
  const palette = source.palette ?? {};
  if (source.symbols !== undefined) {
    fields(source.symbols, Object.keys(source.symbols), 'autotile.symbols');
    for (const name of Object.keys(source.symbols)) if (name === 'template' || name.startsWith('template-')) fail(`autotile.symbols.${name}`, 'template and template-<variant> name the compiled templates; choose another name');
  }
  if (source.layers !== undefined) return compileLayers(source, { tile, mode, palette });
  if (source.template !== undefined && source.terrain !== undefined) fail('autotile.terrain', 'give template rows or a terrain to draw them, not both');
  if (source.template === undefined && source.terrain === undefined && source.ops === undefined) fail('autotile.template', `give template rows (${tile * 3} rows of ${tile * 2} characters), a terrain to draw them, or ops`);
  const drawing = { tile, palette, ramps: source.ramps, symbols: source.symbols ?? {} };
  const terrain = source.terrain === undefined ? undefined : normalTerrain(source.terrain);
  const blank = Array.from({ length: tile * 3 }, () => '.'.repeat(tile * 2));
  const base = source.template !== undefined ? templateRows(source.template, tile, 'autotile.template') : terrain !== undefined ? terrainTemplate(terrain, { tile, palette, mode, path: 'autotile.terrain' }) : blank;
  const template = drawOverTemplate(base, source.ops, { ...drawing, path: 'autotile.ops', rowsPath: source.template !== undefined ? 'autotile.template' : 'autotile.terrain' });
  if (typeof source.frame !== 'string' || !source.frame.includes('{mask}')) fail('autotile.frame', 'expected a frame name template containing {mask}');
  const variants = source.variants ?? [{ name: '' }];
  if (!Array.isArray(variants) || !variants.length || variants.length > 16) fail('autotile.variants', 'expected 1–16 variants');
  if (source.variants !== undefined && !source.frame.includes('{variant}')) fail('autotile.frame', 'with variants, the frame template must contain {variant}');
  // A variant may recolour the set (palette), time it (duration) or redraw it: from its own template rows (with its
  // own ops over them), or from the set's terrain with the variant's `terrain` merged in, or from the set's template,
  // with the set's ops and then its own drawn over. Cracked or mossy stone, say, or another fill seed, keeps the set's
  // edges, so variants mix in a map. Its template becomes the symbol template-<variant>.
  // `drawn` keeps what a terrain drew for each template before ops, which the seam check trusts.
  const symbols = { template }, drawn = source.template === undefined && terrain !== undefined ? { template: base } : {};
  variants.forEach((variant, i) => {
    const vp = `autotile.variants[${i}]`;
    fields(variant, ['name', 'duration', 'weight', 'palette', 'template', 'terrain', 'ops'], vp);
    if (typeof variant.name !== 'string' || (source.variants !== undefined && !/^[A-Za-z0-9_-]{1,16}$/.test(variant.name))) fail(`${vp}.name`, 'expected 1–16 letters, digits, hyphens or underscores');
    if (variant.weight !== undefined && (!Number.isInteger(variant.weight) || variant.weight < 1 || variant.weight > 1000)) fail(`${vp}.weight`, 'expected a whole number from 1 to 1000; weights are relative, so give common variants 10 and a rare one 1');
    if (variant.template === undefined && variant.terrain === undefined && variant.ops === undefined) return;
    if (variant.template !== undefined && variant.terrain !== undefined) fail(`${vp}.terrain`, 'give template rows or a terrain, not both');
    let rows;
    if (variant.template !== undefined) rows = drawOverTemplate(templateRows(variant.template, tile, `${vp}.template`), variant.ops, { ...drawing, path: `${vp}.ops`, rowsPath: `${vp}.template` });
    else {
      if (variant.terrain !== undefined && terrain === undefined) fail(`${vp}.terrain`, 'a variant\'s terrain changes the set\'s terrain; give the set a terrain first');
      const start = variant.terrain === undefined ? base : terrainTemplate(mergeTerrain(terrain, normalTerrain(variant.terrain)), { tile, palette, mode, path: `${vp}.terrain` });
      rows = drawOverTemplate(drawOverTemplate(start, source.ops, { ...drawing, path: 'autotile.ops', rowsPath: `${vp}.terrain` }), variant.ops, { ...drawing, path: `${vp}.ops`, rowsPath: `${vp}.terrain` });
      if (terrain !== undefined && source.template === undefined) drawn[`template-${variant.name}`] = start;
    }
    symbols[`template-${variant.name}`] = rows;
  });
  if (source.animation !== undefined && (typeof source.animation !== 'string' || !source.animation.includes('{mask}'))) fail('autotile.animation', 'expected an animation name template containing {mask}');
  if (source.preview !== undefined) {
    fields(source.preview, ['background'], 'autotile.preview');
    if (source.preview.background !== undefined) parseColor(source.preview.background, palette, 'autotile.preview.background');
  }
  const shape = terrain === undefined ? undefined : readTerrain(terrain, { tile, palette, path: 'autotile.terrain' }), box = collisionBox(source.collision, { tile, mode, terrain: shape });
  const symbolOf = variant => (variant.name && Object.hasOwn(symbols, `template-${variant.name}`) ? `template-${variant.name}` : 'template');
  const frames = [], animations = {};
  for (const mask of MODE_MASKS[mode]) {
    const names = [];
    for (const variant of mode === 'corner' && mask === 0 ? variants.slice(0, 1) : variants) {
      const name = source.frame.replaceAll('{mask}', String(mask)).replaceAll('{variant}', variant.name);
      // Engine facts for the TileSet: how often this variant is picked, and the collision box for this mask.
      const facts = { ...(variant.weight !== undefined && variant.weight !== 1 && { weight: variant.weight }), ...(box && box(mask)) };
      names.push(name);
      frames.push({ name, ...(variant.duration !== undefined && { duration: variant.duration }), ...(variant.palette !== undefined && { palette: variant.palette }), ...(Object.keys(facts).length && { tile: facts }), ops: [{ op: 'autotile', symbol: symbolOf(variant), mask, ...(mode !== 'blob' && { mode }) }] });
    }
    if (source.animation !== undefined) animations[source.animation.replaceAll('{mask}', String(mask))] = { frames: names };
  }
  // Slopes, cut from the set's template, after its tiles: each a symbol slope-<slope> and a frame that stamps it, solid
  // under its line when the set has collision. Engines get them as plain tiles to place by hand.
  const templates = { ...symbols };
  let slopes = null;
  if (source.slopes !== undefined) {
    fields(source.slopes, ['frame'], 'autotile.slopes');
    if (mode === 'corner') fail('autotile.slopes', 'slopes are cut from the top-edge tile of a side-view blob or cardinal set; set mode to blob or cardinal');
    const { frame } = source.slopes;
    if (typeof frame !== 'string' || !frame.includes('{slope}') || /\{(?:mask|variant|corners)\}/.test(frame)) fail('autotile.slopes.frame', 'expected a frame name template containing {slope} (up, down, gentle-up-low, … and <slope>-foot for the tile under a slope\'s low end); a slope has no {mask} or {variant}');
    const options = collisionOptions(source.collision, { tile, terrain: shape, path: 'autotile.collision' });
    slopes = slopeTiles(symbols.template, { tile, mode });
    for (const slope of slopes) for (const [key, rows, foot] of [[slope.key, slope.rows, false], ...(slope.foot ? [[`${slope.key}-foot`, slope.foot, true]] : [])]) {
      const polygon = options && slopeCollision(slope.key, tile, options.inset.n, foot);
      symbols[`slope-${key}`] = rows;
      frames.push({ name: frame.replaceAll('{slope}', key), ...(polygon && { tile: { collision: polygon, ...(options.oneWay && { oneWay: true }) } }), ops: [{ op: 'stamp', symbol: `slope-${key}` }] });
    }
  }
  const recipe = { version: 1, name: source.name, width: tile, height: tile, palette, ...(source.ramps !== undefined && { ramps: source.ramps }), symbols, frames, ...(source.animation !== undefined && { animations }), ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject(recipe);
  const report = templateSeams(templates, tile, mode, drawn), warnings = seamWarnings(report, tile);
  const count = kind => report.seams.reduce((sum, seam) => sum + seam.pixels.filter(p => (kind === 'corner' ? seam.corner : !seam.corner && (kind === 'shape') === p.shape)).length, 0);
  // At 84 pixels a tile the test map is 1680 × 1176, inside the size of a still. It mixes the templates the frames draw,
  // each as often as the variants that draw it.
  const share = new Map();
  for (const variant of variants) share.set(symbolOf(variant), (share.get(symbolOf(variant)) ?? 0) + (variant.weight ?? 1));
  const most = Math.max(...share.values()), weighted = variants.some(variant => (variant.weight ?? 1) !== 1);
  const preview = testMapRecipe(recipe, { templates: [...share.keys()], ...(weighted && { weights: [...share.values()].map(sum => Math.max(1, Math.round(sum * Math.min(1, 1000 / most)))) }), mode, background: source.preview?.background, ...(slopes && { slopes }) });
  // For maps with slopes: a scene legend that draws the set (# its terrain, a foot under each slope that has one) and the
  // slopes by their characters, and a map holding every slope.
  const setEntry = source.variants === undefined ? { frame: source.frame } : { frames: variants.map(variant => source.frame.replaceAll('{variant}', variant.name)), ...(variants.some(variant => (variant.weight ?? 1) !== 1) && { weights: variants.map(variant => variant.weight ?? 1) }) };
  const slopeFacts = slopes && { tiles: Object.fromEntries(slopes.flatMap(slope => [[slope.key, source.slopes.frame.replaceAll('{slope}', slope.key)], ...(slope.foot ? [[`${slope.key}-foot`, source.slopes.frame.replaceAll('{slope}', `${slope.key}-foot`)]] : [])])),
    legend: slopeLegend(slopes, { ...setEntry, autotile: mode }, key => ({ frame: source.slopes.frame.replaceAll('{slope}', key) })), map: [...SLOPE_MAP] };
  return plain({ recipe, metadata: { format: 'pixelforge-autotile-metadata', version: 1, mode, masks: [...MODE_MASKS[mode]], bits: { ...MODE_BITS[mode] }, seams: { joins: report.checked, shape: count('shape'), texture: count('texture'), ...(mode === 'cardinal' && { corners: count('corner') }) }, ...(slopeFacts && { slopes: slopeFacts }) }, ...(warnings.length && { warnings }), preview });
}

// A layered corner set: 2–4 terrains stacked bottom first, each drawn from its own template (rows, or a terrain merged
// over the set's), and a tile for every combination of terrains at its four corners (NW, NE, SW, SE), named by the
// layers' keys there ({corners}). A tile is the lowest of its corners' terrains filling it and each higher one among
// them drawn over it as a corner tile counting its own cells and every higher terrain's, so a terrain runs on under the
// ones above it and a transition only shows between terrains that meet. Each frame's tile.corners names its corners'
// terrains for engine tile sets. N layers make N^4 tiles; after them come each layer's variants of its plain tile (the
// tile with it at all four corners), named after that tile with -<variant>. A layer with collision is solid where it
// shows.
function compileLayers(source, { tile, mode, palette }) {
  if (mode !== 'corner') fail('autotile.mode', 'layers are corner tiles: set mode to corner, or leave it out');
  const not = { template: 'with layers, each layer brings its own template rows or terrain', ops: 'with layers, each layer brings its own ops', variants: 'a layered set\'s variants belong to its layers: give a layer variants of its plain tile', collision: 'a layered set\'s collision belongs to its layers: give each solid layer collision', animation: 'a layered set does not animate', slopes: 'slopes are cut from a side-view blob or cardinal set, not a layered one' };
  for (const [key, message] of Object.entries(not)) if (source[key] !== undefined) fail(`autotile.${key}`, message);
  const layers = source.layers;
  if (!Array.isArray(layers) || layers.length < 2 || layers.length > 4) fail('autotile.layers', 'expected 2–4 layers, bottom first, each { name, key } with a terrain, template rows or ops');
  if (typeof source.frame !== 'string' || !source.frame.includes('{corners}') || /\{(?:mask|variant)\}/.test(source.frame)) fail('autotile.frame', 'expected a frame name template containing {corners}, which becomes the keys of the layers at the tile\'s four corners (NW, NE, SW, SE); a layered set has no {mask} or {variant}');
  const drawing = { tile, palette, ramps: source.ramps, symbols: source.symbols ?? {} };
  const base = source.terrain === undefined ? undefined : normalTerrain(source.terrain);
  const blank = Array.from({ length: tile * 3 }, () => '.'.repeat(tile * 2));
  const symbols = {}, drawn = {}, read = [], warnings = [];
  const claim = (symbol, path) => {
    if (Object.hasOwn(symbols, symbol)) fail(path, `${symbol} would name two templates (a layer's is template-<layer>, a variant's template-<layer>-<variant>); rename one`);
  };
  layers.forEach((layer, i) => {
    const lp = `autotile.layers[${i}]`;
    fields(layer, ['name', 'key', 'terrain', 'template', 'ops', 'weight', 'variants', 'collision'], lp);
    if (typeof layer.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(layer.name) || read.some(other => other.name === layer.name)) fail(`${lp}.name`, 'expected 1–32 letters, digits, underscores or hyphens, starting with a letter, unique among the layers: the terrain\'s name in engines');
    // Frame names must differ in more than letter case, and keys spell them.
    if (typeof layer.key !== 'string' || !/^[a-zA-Z0-9]$/.test(layer.key) || read.some(other => other.key.toLowerCase() === layer.key.toLowerCase())) fail(`${lp}.key`, 'expected one letter or digit, unique among the layers ignoring letter case (tile names are, and keys spell them): the terrain\'s character in maps and tile names');
    if (layer.template !== undefined && layer.terrain !== undefined) fail(`${lp}.terrain`, 'give template rows or a terrain, not both');
    const symbol = `template-${layer.name}`;
    claim(symbol, `${lp}.name`);
    let start = blank, rowsPath = `${lp}.ops`, terrain;
    if (layer.template !== undefined) { start = templateRows(layer.template, tile, `${lp}.template`); rowsPath = `${lp}.template`; }
    else if (layer.terrain !== undefined || base !== undefined) {
      terrain = layer.terrain === undefined ? base : base === undefined ? normalTerrain(layer.terrain) : mergeTerrain(base, normalTerrain(layer.terrain));
      rowsPath = layer.terrain === undefined ? 'autotile.terrain' : `${lp}.terrain`;
      start = terrainTemplate(terrain, { tile, palette, mode, path: rowsPath });
      drawn[symbol] = start;
    } else if (layer.ops === undefined) fail(lp, 'give the layer a terrain, template rows or ops');
    const rows = symbols[symbol] = drawOverTemplate(start, layer.ops, { ...drawing, path: `${lp}.ops`, rowsPath });
    const variants = layerVariants(layer, { lp, rows, terrain, tile, mode, palette, drawing, symbols, claim, warnings });
    const shape = terrain === undefined ? undefined : readTerrain(terrain, { tile, palette, path: rowsPath });
    const collision = collisionOptions(layer.collision, { tile, terrain: shape, path: `${lp}.collision` });
    // Where the layer stops covering lower terrains: its collision inset, or where its edge starts.
    const inset = (collision ?? collisionOptions(true, { tile, terrain: shape, path: `${lp}.collision` })).inset;
    read.push({ name: layer.name, key: layer.key, ...(variants && { weight: layer.weight ?? 1, variants }), collision, inset });
  });
  const solid = read.filter(layer => layer.collision), differs = solid.find(layer => layer.collision.oneWay !== solid[0].collision.oneWay);
  if (differs) fail(`autotile.layers[${read.indexOf(differs)}].collision.oneWay`, 'engines keep one oneWay per tile: give every solid layer the same oneWay');
  // A recipe holds at most 256 frames, and four layers make 256 tiles.
  const extra = read.reduce((sum, layer) => sum + (layer.variants?.length ?? 0), 0);
  const tiles = read.length * read.length * read.length * read.length;
  if (tiles + extra > 256) fail(`autotile.layers[${read.findIndex(layer => layer.variants)}].variants`, `${read.length} layers make ${tiles} tiles, as many frames as a recipe holds, so there is no room for ${extra} variant${extra === 1 ? '' : 's'}: use 3 layers (81 tiles), or leave the variants out`);
  // The frame template and the keys make every name; a key that is a digit can't start one.
  const frameName = (name, corners) => {
    if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return name;
    fail('autotile.frame', `makes ${JSON.stringify(name)} for corners ${corners}, which is no frame name: names are 1–64 letters, digits, underscores or hyphens, starting with a letter${/^[0-9]/.test(name) && source.frame.startsWith('{corners}') ? '; a layer key is a digit, so put a letter before {corners}, as in tiles-{corners}' : ''}`);
  };
  if (source.preview !== undefined) {
    fields(source.preview, ['background'], 'autotile.preview');
    if (source.preview.background !== undefined) parseColor(source.preview.background, palette, 'autotile.preview.background');
  }
  // Codes count in base n, NW the lowest digit.
  const n = read.length, places = [1, n, n * n, n * n * n], frames = [], variantFrames = [], weighed = weight => (weight !== 1 ? { weight } : {});
  for (let code = 0; code < n * places[3]; code++) {
    const corners = places.map(place => Math.floor(code / place) % n), ops = [];
    for (let layer = 0; layer < n; layer++) if (corners.includes(layer)) ops.push({ op: 'autotile', symbol: `template-${read[layer].name}`, mask: corners.reduce((bits, c, k) => (c >= layer ? bits | (1 << k) : bits), 0), mode: 'corner' });
    const keys = corners.map(c => read[c].key).join(''), name = frameName(source.frame.replaceAll('{corners}', keys), keys), names = corners.map(c => read[c].name);
    const box = layeredCollision(corners, read, tile), only = corners.every(c => c === corners[0]) ? read[corners[0]] : null;
    frames.push({ name, tile: { corners: names, ...(only?.variants && weighed(only.weight)), ...box }, ops });
    for (const variant of only?.variants ?? []) variantFrames.push({ name: frameName(`${name}-${variant.name}`, keys), tile: { corners: names, ...weighed(variant.weight), ...box }, ops: [{ op: 'autotile', symbol: variant.symbol, mask: 15, mode: 'corner' }] });
  }
  frames.push(...variantFrames);
  const recipe = { version: 1, name: source.name, width: tile, height: tile, palette, ...(source.ramps !== undefined && { ramps: source.ramps }), symbols, frames, ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject(recipe);
  // Each layer is a corner set of its own over the ones below, so each template is checked as one.
  const seams = { joins: 0, shape: 0, texture: 0 };
  for (const layer of read) {
    const symbol = `template-${layer.name}`, report = templateSeams({ [symbol]: symbols[symbol] }, tile, mode, drawn[symbol] ? { [symbol]: drawn[symbol] } : {});
    warnings.push(...seamWarnings(report, tile).map(warning => `Layer ${layer.name}: ${warning}`));
    seams.joins += report.checked;
    for (const seam of report.seams) for (const pixel of seam.pixels) seams[pixel.shape ? 'shape' : 'texture']++;
  }
  const preview = layeredTestMapRecipe(recipe, read, { background: source.preview?.background });
  const listed = read.map(({ name, key, weight, variants, collision }) => ({ name, key, ...(variants && { weight, variants: variants.map(variant => ({ name: variant.name, weight: variant.weight })) }), ...(collision && { solid: true }) }));
  return plain({ recipe, metadata: { format: 'pixelforge-autotile-metadata', version: 1, mode, layers: listed, corners: ['nw', 'ne', 'sw', 'se'], tiles: frames.length, seams }, ...(warnings.length && { warnings }), preview });
}

// A layer's variants of its plain tile, the tile with it at all four corners. Each redraws the layer's template from its
// terrain with the variant's merged in (and the layer's ops over it), or keeps the layer's, then draws its ops over the
// plain tile in tile pixels; the result is the symbol template-<layer>-<variant>, whose corner tile 15 is the variant.
// Ops that change the tile's border, which the tiles beside it do not continue, are warned about.
const SIDE_NAMES = { n: 'top', e: 'right', s: 'bottom', w: 'left' };
function layerVariants(layer, { lp, rows, terrain, tile, mode, palette, drawing, symbols, claim, warnings }) {
  const weight = (value, path) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 1000)) fail(path, 'expected a whole number from 1 to 1000; weights are relative, so give the plain tile 10 and a rare variant 1');
  };
  weight(layer.weight, `${lp}.weight`);
  if (layer.variants === undefined) {
    if (layer.weight !== undefined) fail(`${lp}.weight`, 'weighs the layer\'s plain tile against its variants; give the layer variants');
    return null;
  }
  if (!Array.isArray(layer.variants) || !layer.variants.length || layer.variants.length > 16) fail(`${lp}.variants`, 'expected 1–16 variants of the layer\'s plain tile, each { name, weight?, terrain?, ops? }');
  return layer.variants.map((variant, k) => {
    const vp = `${lp}.variants[${k}]`;
    fields(variant, ['name', 'weight', 'terrain', 'ops'], vp);
    if (typeof variant.name !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(variant.name) || layer.variants.slice(0, k).some(other => other.name === variant.name)) fail(`${vp}.name`, 'expected 1–16 letters, digits, hyphens or underscores, unique among the layer\'s variants');
    weight(variant.weight, `${vp}.weight`);
    if (variant.terrain === undefined && variant.ops === undefined) fail(vp, 'a variant redraws the layer\'s plain tile: give it a terrain (merged into the layer\'s) or ops drawn over the tile');
    let template = rows;
    if (variant.terrain !== undefined) {
      if (terrain === undefined) fail(`${vp}.terrain`, 'a variant\'s terrain changes the layer\'s terrain; give the layer (or the set) a terrain first');
      template = drawOverTemplate(terrainTemplate(mergeTerrain(terrain, normalTerrain(variant.terrain)), { tile, palette, mode, path: `${vp}.terrain` }), layer.ops, { ...drawing, path: `${lp}.ops`, rowsPath: `${vp}.terrain` });
    }
    const before = plainTile(template, tile), after = drawOverTemplate(before, variant.ops, { ...drawing, width: tile, height: tile, path: `${vp}.ops`, rowsPath: `${vp}.ops` });
    const border = { n: 0, e: 0, s: 0, w: 0 };
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      if (before[y][x] === after[y][x]) continue;
      if (y === 0) border.n++;
      if (x === tile - 1) border.e++;
      if (y === tile - 1) border.s++;
      if (x === 0) border.w++;
    }
    const touched = Object.entries(border).filter(([, count]) => count);
    if (touched.length) warnings.push(`Layer ${layer.name}, variant ${variant.name}: its ops change ${touched.map(([side, count]) => `${count} pixel${count === 1 ? '' : 's'} on the ${SIDE_NAMES[side]} border`).join(', ')}, which the tiles beside it do not continue; keep a variant's drawing a pixel inside the tile`);
    const symbol = `template-${layer.name}-${variant.name}`;
    claim(symbol, `${vp}.name`);
    symbols[symbol] = withPlainTile(template, after, tile);
    return { name: variant.name, weight: variant.weight ?? 1, symbol };
  });
}
// The plain corner tile (mask 15) of template rows as rows of its own, and template rows with it replaced: its quarters
// are four separate pieces of the template.
const QUARTERS = [['tl', 0, 0], ['tr', 1, 0], ['bl', 0, 1], ['br', 1, 1]];
function plainTile(rows, tile) {
  const q = tile / 2, pieces = tilePieces('corner', 15), out = Array.from({ length: tile }, () => '');
  for (const [position, qx, qy] of QUARTERS) {
    const [sx, sy] = templatePiece(tile, pieces[position].from, pieces[position].piece);
    for (let y = 0; y < q; y++) out[qy * q + y] += rows[sy + y].slice(sx, sx + q);
  }
  return out;
}
function withPlainTile(rows, plain, tile) {
  const q = tile / 2, pieces = tilePieces('corner', 15), out = [...rows];
  for (const [position, qx, qy] of QUARTERS) {
    const [sx, sy] = templatePiece(tile, pieces[position].from, pieces[position].piece);
    for (let y = 0; y < q; y++) out[sy + y] = out[sy + y].slice(0, sx) + plain[qy * q + y].slice(qx * q, qx * q + q) + out[sy + y].slice(sx + q);
  }
  return out;
}

// The collision box of each tile of a set, from the source's collision (true, or { inset, oneWay }): the whole tile,
// kept `inset` pixels from each open side, so a body stands on the drawn ground rather than on the tufts or margin
// above it. Insets default to each terrain edge's depth, or 0. A corner tile is solid in the quarters of its terrain
// cells, each kept from that cell's open sides, so its shapes are the blob boxes of the same map; two cells that
// touch only at a corner give two polygons. Returns mask => { collision, oneWay? } (none for an empty tile), or null.
function collisionBox(spec, { tile, mode, terrain }) {
  const options = collisionOptions(spec, { tile, terrain, path: 'autotile.collision' });
  if (!options) return null;
  const { inset } = options, way = options.oneWay ? { oneWay: true } : {};
  if (mode === 'corner') return mask => {
    const rects = cornerRects(mask, tile, inset);
    if (!rects.length) return {};
    const polygons = outlineRects(rects);
    return { collision: polygons.length === 1 ? polygons[0] : polygons, ...way };
  };
  const bits = mode === 'cardinal' ? { n: 1, e: 2, s: 4, w: 8 } : { n: 1, e: 4, s: 16, w: 64 };
  return mask => {
    const open = side => !(mask & bits[side]);
    const x0 = open('w') ? inset.w : 0, x1 = open('e') ? tile - inset.e : tile, y0 = open('n') ? inset.n : 0, y1 = open('s') ? tile - inset.s : tile;
    return { collision: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], ...way };
  };
}
// A collision spec at `path` (true, or { inset, oneWay }) read into { inset: { n, e, s, w }, oneWay }, or null for none.
// Insets default to the depth of each terrain edge (where the terrain starts), or 0.
function collisionOptions(spec, { tile, terrain, path }) {
  if (spec === undefined || spec === false) return null;
  if (spec !== true && (spec === null || typeof spec !== 'object' || Array.isArray(spec))) fail(path, 'expected true, or { inset, oneWay }');
  const options = spec === true ? {} : spec, q = tile / 2;
  fields(options, ['inset', 'oneWay'], path);
  if (options.oneWay !== undefined && typeof options.oneWay !== 'boolean') fail(`${path}.oneWay`, 'expected true or false');
  const depth = side => (terrain ? Math.min(...terrain.sides[side].profile) : 0), whole = (value, where) => {
    if (!Number.isInteger(value) || value < 0 || value >= q) fail(where, `expected a whole number of pixels from 0 to ${q - 1} (under half the ${tile}-pixel tile)`);
    return value;
  };
  let inset;
  if (options.inset === undefined || typeof options.inset === 'number') inset = Object.fromEntries(['n', 'e', 's', 'w'].map(side => [side, options.inset === undefined ? depth(side) : whole(options.inset, `${path}.inset`)]));
  else {
    fields(options.inset, ['n', 'e', 's', 'w'], `${path}.inset`);
    inset = Object.fromEntries(['n', 'e', 's', 'w'].map(side => [side, options.inset[side] === undefined ? depth(side) : whole(options.inset[side], `${path}.inset.${side}`)]));
  }
  return { inset, oneWay: options.oneWay === true };
}
// A corner tile's terrain quarters as rectangles [x0, y0, x1, y1], each kept `inset` pixels from its cell's open sides.
function cornerRects(mask, tile, inset) {
  const has = corner => (mask & MODE_BITS.corner[corner]) !== 0, q = tile / 2, rects = [];
  if (has('nw')) rects.push([0, 0, q - (has('ne') ? 0 : inset.e), q - (has('sw') ? 0 : inset.s)]);
  if (has('ne')) rects.push([q + (has('nw') ? 0 : inset.w), 0, tile, q - (has('se') ? 0 : inset.s)]);
  if (has('sw')) rects.push([0, q + (has('nw') ? 0 : inset.n), q - (has('se') ? 0 : inset.e), tile]);
  if (has('se')) rects.push([q + (has('sw') ? 0 : inset.w), q + (has('ne') ? 0 : inset.n), tile, tile]);
  return rects;
}
// Where a layered tile is solid. Each pixel belongs to the highest of its corners' terrains covering it, as a corner
// tile of the corners at or above that terrain, kept from the sides it shares with lower terrains by its collision
// inset or, for a terrain without collision, where its edge starts; the pixel is solid when that terrain has collision.
// `layers` are { collision, inset }, bottom first; corners are layer indices at NW, NE, SW and SE.
function layeredCollision(corners, layers, tile) {
  const present = [...new Set(corners)].sort((a, b) => a - b);
  if (!present.some(layer => layers[layer].collision)) return {};
  const regions = present.map(layer => ({ solid: Boolean(layers[layer].collision), rects: cornerRects(corners.reduce((bits, c, k) => (c >= layer ? bits | (1 << k) : bits), 0), tile, layers[layer].inset) }));
  const edges = (a, b) => [...new Set(regions.flatMap(region => region.rects.flatMap(rect => [rect[a], rect[b]])))].sort((p, q) => p - q);
  const xs = edges(0, 2), ys = edges(1, 3);
  const polygons = outlineGrid(xs, ys, (i, j) => {
    const x = (xs[i] + xs[i + 1]) / 2, y = (ys[j] + ys[j + 1]) / 2;
    for (let r = regions.length - 1; r >= 0; r--) if (regions[r].rects.some(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1)) return regions[r].solid;
    return false;
  });
  if (!polygons.length) return {};
  return { collision: polygons.length === 1 ? polygons[0] : polygons, ...(layers.some(layer => layer.collision?.oneWay) && { oneWay: true }) };
}

// The outline of a union of rectangles [x0, y0, x1, y1] on whole pixels, as polygons of corner points, one per
// separate part: where two parts touch only at a corner, the walk turns toward the part it is following.
function outlineRects(rects) {
  const xs = [...new Set(rects.flatMap(r => [r[0], r[2]]))].sort((a, b) => a - b), ys = [...new Set(rects.flatMap(r => [r[1], r[3]]))].sort((a, b) => a - b);
  return outlineGrid(xs, ys, (i, j) => rects.some(([x0, y0, x1, y1]) => xs[i] >= x0 && xs[i + 1] <= x1 && ys[j] >= y0 && ys[j + 1] <= y1));
}
// The outline of the cells of a grid (column i from xs[i] to xs[i + 1], row j from ys[j] to ys[j + 1]) for which
// solid(i, j) holds, as for outlineRects.
function outlineGrid(xs, ys, solid) {
  const inside = (i, j) => i >= 0 && j >= 0 && i < xs.length - 1 && j < ys.length - 1 && solid(i, j);
  // Boundary edges between grid points, clockwise on screen: the solid part is on each edge's right.
  const edges = new Map(), add = (a, b) => { const key = a.join(); if (!edges.has(key)) edges.set(key, []); edges.get(key).push(b); };
  for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
    if (!inside(i, j)) continue;
    if (!inside(i, j - 1)) add([i, j], [i + 1, j]);
    if (!inside(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
    if (!inside(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
    if (!inside(i - 1, j)) add([i, j + 1], [i, j]);
  }
  const polygons = [];
  while (edges.size) {
    const start = edges.keys().next().value, loop = [];
    let at = start.split(',').map(Number), heading = null;
    do {
      const key = at.join(), outs = edges.get(key);
      const ways = outs.map(([i, j]) => [Math.sign(i - at[0]), Math.sign(j - at[1])]);
      // A right turn on screen takes (dx, dy) to (-dy, dx); then straight on, then left.
      const rank = ([dx, dy]) => (!heading ? 0 : dx === -heading[1] && dy === heading[0] ? 0 : dx === heading[0] && dy === heading[1] ? 1 : 2);
      const k = ways.reduce((best, way, i) => (rank(way) < rank(ways[best]) ? i : best), 0), next = outs.splice(k, 1)[0];
      if (!outs.length) edges.delete(key);
      if (!heading || ways[k][0] !== heading[0] || ways[k][1] !== heading[1]) loop.push(at);
      heading = ways[k];
      at = next;
    } while (at.join() !== start);
    // The start point stays only where the walk turns there.
    const last = loop.at(-1), [first, second] = loop;
    if (loop.length > 2 && Math.sign(first[0] - last[0]) === Math.sign(second[0] - first[0]) && Math.sign(first[1] - last[1]) === Math.sign(second[1] - first[1])) loop.shift();
    polygons.push(loop.map(([i, j]) => [xs[i], ys[j]]));
  }
  return polygons;
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
// `faces` gives pixels drawn in chosen palette keys one direction each instead (the top, front and side of a box,
// a wall or a building, which a cushion cannot describe); every other pixel is rounded as before.
export function compileNormals(source) {
  fields(source, ['format', 'version', 'name', 'recipe', 'bevel', 'detail', 'faces'], 'normals');
  if (source.format !== 'pixelforge-normals' || source.version !== 1) fail('normals', 'expected version-1 pixelforge-normals');
  const spec = source.recipe;
  if (typeof spec === 'string' || (spec && typeof spec === 'object' && spec.revision !== undefined && spec.version === undefined)) fail('normals.recipe', 'file and revision references are resolved by the CLI and MCP; inline the recipe to compile here');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('normals.recipe', 'expected the colour recipe, inline or as a file reference');
  if (spec.format !== undefined) fail('normals.recipe', `expected a recipe, not a ${spec.format} source; compile it first and derive normals from the result`);
  // A normal pass lights scene assets, which are at most 256 a side, so a larger still is refused here rather than as
  // an error in a grid the user never wrote.
  if ([spec.width, spec.height].some(side => typeof side === 'number' && side > CANVAS_SIDE)) fail('normals.recipe', `the colour recipe is ${spec.width}×${spec.height}; a normal pass is at most ${CANVAS_SIDE}×${CANVAS_SIDE} (it lights scene assets, which keep that limit), so derive normals from a recipe of at most ${CANVAS_SIDE} a side`);
  if (source.bevel !== undefined && (!Number.isInteger(source.bevel) || source.bevel < 1 || source.bevel > 64)) fail('normals.bevel', 'expected 1–64 pixels from the edge to the flat top; omit it to round each shape up to its thickest point');
  const detail = source.detail ?? 0;
  if (typeof detail !== 'number' || !Number.isFinite(detail) || detail < 0 || detail > 1) fail('normals.detail', 'expected 0 (shape only) to 1');
  const project = renderProject(spec), { width: w, height: h } = project, size = w * h;
  if (source.name === undefined && project.name.length > 57) fail('normals.name', `${project.name}-normal would exceed 64 characters; name the normal recipe`);
  const name = source.name ?? `${project.name}-normal`;
  // Flat faces by colour: each named palette key's exact colour, as drawn, takes one direction.
  // `faced` maps a colour to its direction and pixel count; keys that share a colour share the face.
  const faced = new Map(), facedBy = Object.create(null);
  if (source.faces !== undefined) {
    if (!source.faces || typeof source.faces !== 'object' || Array.isArray(source.faces) || !Object.keys(source.faces).length) fail('normals.faces', 'expected a map of the colour recipe\'s palette keys to directions, such as {"t": "w", "f": "2"}');
    for (const [key, way] of Object.entries(source.faces)) {
      const path = `normals.faces${/^[A-Za-z0-9_-]+$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`}`;
      if (!Object.hasOwn(project.palette, key)) fail(path, `${JSON.stringify(key)} is not a palette key of ${project.name}`);
      if (typeof way !== 'string' || !Object.hasOwn(NORMAL_DIRECTIONS, way)) fail(path, 'expected a direction: 5 faces the viewer, the keypad digits 1–4 and 6–9 lean 30° and q w e a d z x c lean 60° the same ways');
      const rgba = parseColor(key, project.palette), id = rgba.join(',');
      if (!rgba[3]) fail(path, `${JSON.stringify(key)} is transparent and draws no pixels to face`);
      const other = faced.get(id);
      if (other && other.way !== way) fail(path, `${JSON.stringify(key)} is the same colour as ${JSON.stringify(other.key)}, which faces ${other.way}; a colour can face one way`);
      if (!other) faced.set(id, { key, way, pixels: 0 });
      facedBy[key] = faced.get(id);
    }
  }
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
        const at4 = (y * w + x) * 4, face = faced.size ? faced.get(`${data[at4]},${data[at4 + 1]},${data[at4 + 2]},${data[at4 + 3]}`) : undefined;
        if (face) { row += face.way; counts[face.way] = (counts[face.way] ?? 0) + 1; face.pixels++; continue; }
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
  // A faced key that no frame draws is usually a typo or a key recoloured by a frame palette.
  const unmatched = Object.keys(facedBy).filter(key => !facedBy[key].pixels);
  return plain({ recipe, metadata: { format: 'pixelforge-normals-metadata', version: 1, encoding: 'RGB = (XYZ + 1) × 127.5; +X right, +Y down, +Z toward the viewer', bevel: source.bevel ?? 'each shape to its thickest point', detail, ...(source.faces !== undefined && { faces: Object.fromEntries(Object.entries(facedBy).map(([key, face]) => [key, { direction: face.way, pixels: face.pixels }])) }), directions: Object.fromEntries(keys.map(key => [key, NORMAL_DIRECTIONS[key].map(v => Math.round(v * 1e4) / 1e4)])), pixels: Object.fromEntries(used.map(key => [key, counts[key]])) },
    ...(unmatched.length && { warnings: unmatched.map(key => `faces.${key}: no pixel is drawn in ${JSON.stringify(key)}'s colour, so it faces nothing; check the key, or a frame palette that recolours it.`) }) });
}
