// Split imported palette grids into disjoint, editable drawings. Regions are in the unpadded
// source frame. Padding moves the pixels and the pivot together, keeping their relative positions.
import { fail, POSE_SIDE } from './core.js';
import { fields, integer, compilePoses } from './authoring.js';
import { importPNG } from './import.js';

const FACINGS = ['down', 'up', 'right', 'left'];

function visitRegion(rows, rect, path, visit) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isInteger)) fail(path, 'expected a source-pixel rectangle [x, y, width, height]');
  const [x, y, w, h] = rect, width = rows[0].length;
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > rows.length)
    fail(path, `rectangle must fit the ${width}×${rows.length} source frame before padding`);
  for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
    if (rows[row][col] === '.') continue;
    visit(row * width + col, col, row);
  }
}

function cutView(frame, view, width, height, pivot, palette, path) {
  const rows = frame.ops?.[0]?.rows;
  if (!rows?.length) fail(path, 'the selected frame has no visible palette grid');
  const owners = new Uint8Array(width * height), names = ['body','footA','footB'];
  if (view.arms !== undefined) names.push('armA','armB');
  // The small explicit mask takes precedence over broad limb boxes. Encode role + 1
  // so an explicit body pixel is distinguishable from an unreserved pixel.
  let reserved;
  if (view.keepWith !== undefined) {
    fields(view.keepWith, names, path + '.keepWith');
    reserved = new Uint8Array(owners.length);
    for (const [part, rects] of Object.entries(view.keepWith)) {
      const location = path + '.keepWith.' + part, role = names.indexOf(part) + 1;
      if (!Array.isArray(rects) || !rects.length || rects.length > 64) fail(location, 'expected 1 to 64 source-pixel rectangles');
      rects.forEach((rect, n) => visitRegion(rows, rect, location + '[' + n + ']', (index, x, y) => {
        if (reserved[index] && reserved[index] !== role) fail(location, `pixel [${x}, ${y}] is reserved for two different parts`);
        reserved[index] = role;
        owners[index] = role - 1;
      }));
    }
  }
  for (const [group, prefix] of [['feet', 'foot'], ['arms', 'arm']]) {
    if (group === 'arms' && view.arms === undefined) continue;
    const pair = view[group];
    if (!Array.isArray(pair) || pair.length !== 2) fail(`${path}.${group}`, 'give two limb regions in matching anatomical order; each is one rectangle or a list of rectangles');
    pair.forEach((region, i) => {
      const location = `${path}.${group}[${i}]`;
      const rects = Array.isArray(region?.[0]) ? region : [region];
      if (rects.length > 64) fail(location, 'expected up to 64 rectangles for one limb');
      const role = names.indexOf(prefix + (i ? 'B' : 'A'));
      rects.forEach((rect, j) => visitRegion(rows, rect, `${location}[${j}]`, (index, x, y) => {
        if (reserved?.[index]) return;
        if (owners[index] && owners[index] !== role) fail(location, `pixel [${x}, ${y}] belongs to two limbs; narrow a rectangle or split it into smaller rectangles`);
        owners[index] = role;
      }));
      if (!owners.includes(role)) fail(location, reserved ? 'no visible pixels remain on this limb; inspect its rectangles and keepWith mask' : 'this region selects only transparent pixels; inspect the source grid and move the rectangle onto the limb');
    });
  }
  // Reuse the original colour behind selected joints. Only opaque pixels can be doubled without
  // changing the composite of the standing pose.
  const joins = new Uint8Array(width * height);
  if (view.overlap !== undefined) {
    if (!Array.isArray(view.overlap) || view.overlap.length > 64) fail(path + '.overlap', 'expected up to 64 joint rectangles');
    view.overlap.forEach((rect, i) => visitRegion(rows, rect, `${path}.overlap[${i}]`, (index, x, y) => {
      if (!owners[index] || reserved?.[index]) return;
      if (!palette[rows[y][x]].endsWith('ff')) fail(path + '.overlap', `pixel [${x}, ${y}] is translucent; leave it out of the joint overlap to preserve the standing pose`);
      joins[index] = 1;
    }));
  }
  // Extend the boot's top colour under an opaque hem. The original hem covers the shaft
  // at rest. Copying the hem colour onto the boot would carry coat trim along with a step.
  const depth = integer(view.extendFeet === undefined ? 0 : view.extendFeet, path + '.extendFeet', 0, height);
  const shaftInk = depth ? new Map() : undefined;
  if (depth) {
    for (const foot of [1, 2]) for (let x = 0; x < width; x++) {
      let top = 0;
      while (top < height && owners[top * width + x] !== foot) top++;
      if (top === height) continue;
      for (let y = top - 1; y >= Math.max(0, top - depth); y--) {
        const i = y * width + x;
        if (owners[i] || reserved?.[i] || rows[y][x] === '.' || !palette[rows[y][x]].endsWith('ff')) break;
        owners[i] = foot;
        joins[i] = 1;
        shaftInk.set(i, rows[top][x]);
      }
    }
  }
  const bounds = names.map(() => [width, height, -1, -1]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rows[y][x] === '.') continue;
    const index = y * width + x;
    for (const role of joins[index] ? [0, owners[index]] : [owners[index]]) {
      const box = bounds[role];
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
  }
  const drawings = bounds.flatMap(([x0, y0, x1, y1], role) => {
    if (x1 < x0) return [];
    const cut = [];
    for (let y = y0; y <= y1; y++) {
      let row = '';
      for (let x = x0; x <= x1; x++) {
        const index = y * width + x;
        if (owners[index] === role) row += shaftInk?.get(index) ?? rows[y][x];
        else row += role === 0 && joins[index] ? rows[y][x] : '.';
      }
      cut.push(row);
    }
    return [{ name: names[role], rows: cut, at: [x0 - pivot[0], y0 - pivot[1]] }];
  });
  if (depth && drawings[0]?.name === 'body') {
    const body = drawings.shift();
    drawings.splice(2, 0, body);
  }
  return drawings;
}

export function importCutoutPNG(bytes, { cutout, ...options }) {
  const imported = importPNG(bytes, options), source = cutoutSource(imported.recipe, cutout);
  const compiled = compilePoses(source);
  return { source, recipe: compiled.recipe, warnings: compiled.warnings ?? [], provenance: {
    format: 'pixelforge-cutout-import', version: 1, sha256: imported.provenance.sha256,
    width: imported.recipe.width, height: imported.recipe.height, encoding: imported.provenance.encoding,
    views: Object.keys(cutout.views), representation: 'Editable pose parts cut from visible source pixels. RGB under fully transparent pixels is discarded.'
  } };
}

function cutoutSource(recipe, spec) {
  const { width, height } = recipe;
  fields(spec, ['pivot', 'margin', 'views'], 'cutout');
  if (!recipe.palette) fail('cutout', 'drawn pose parts need at most 256 visible colours; reduce the palette or import as an ordinary recipe');
  const available = Math.floor((POSE_SIDE - Math.max(width, height)) / 2);
  if (available < 0) fail('cutout', `a pose canvas has at most ${POSE_SIDE} pixels per side; crop to the character or slice its sheet`);
  const margin = integer(spec.margin ?? Math.min(4, available), 'cutout.margin', 0, available);
  fields(spec.views, FACINGS, 'cutout.views');
  if (!Object.keys(spec.views).length) fail('cutout.views', 'give at least one drawn facing: down, up, right or left');
  const source = { format: 'pixelforge-poses', version: 1, name: recipe.name, width: width + 2 * margin, height: height + 2 * margin, palette: recipe.palette, parts: {}, poses: [], animations: {}, walkCycles: {} };
  for (const [direction, view] of Object.entries(spec.views)) {
    const path = `cutout.views.${direction}`;
    fields(view, ['frame', 'feet', 'arms', 'overlap', 'extendFeet', 'keepWith', 'mirror', 'stride', 'lift', 'bob', 'duration'], path);
    const frame = view.frame === undefined && recipe.frames.length === 1 ? recipe.frames[0] : recipe.frames.find(f => f.name === view.frame);
    if (!frame) fail(`${path}.frame`, `choose an imported frame by name: ${recipe.frames.slice(0, 12).map(f => f.name).join(', ')}`);
    const pivot = spec.pivot ?? frame.anchor ?? recipe.anchor ?? [Math.floor(width / 2), height];
    if (!Array.isArray(pivot) || pivot.length !== 2) fail('cutout.pivot', 'expected a source-pixel pivot [x, y]');
    integer(pivot[0], 'cutout.pivot[0]', 0, width); integer(pivot[1], 'cutout.pivot[1]', 0, height);
    const origin = [pivot[0] + margin, pivot[1] + margin];
    if (view.mirror !== undefined && typeof view.mirror !== 'boolean') fail(`${path}.mirror`, 'expected true or false');
    const opposite = direction === 'left' ? 'right' : 'left';
    if (view.mirror && (!['right', 'left'].includes(direction) || Object.hasOwn(spec.views, opposite)))
      fail(`${path}.mirror`, 'mirror one side profile only when the opposite view has no drawing');
    const placements = [];
    for (const { name, rows, at } of cutView(frame, view, width, height, pivot, recipe.palette, path)) {
      const part = `${direction}-${name}`;
      source.parts[part] = { rows };
      placements.push({ name, part, at, cleanup: false });
    }
    const rest = `stand-${direction}`;
    source.poses.push({ name: rest, origin, parts: placements });
    source.animations[rest] = { frames: [rest] };
    const cycle = { rest, direction, feet: ['footA', 'footB'] };
    if (view.arms) cycle.arms = ['armA', 'armB'];
    for (const option of ['stride', 'lift', 'bob', 'duration']) if (view[option] !== undefined) cycle[option] = view[option];
    if (view.mirror) {
      cycle.mirrorAs = `walk-${opposite}`;
      const mirrored = `stand-${opposite}`;
      source.poses.push({ name: mirrored, mirror: rest });
      source.animations[mirrored] = { frames: [mirrored] };
    }
    source.walkCycles[`walk-${direction}`] = cycle;
  }
  return source;
}
