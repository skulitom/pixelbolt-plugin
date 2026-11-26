// Follow selected visible pixels of a rigid cutout from its stand. Test ownership in
// the source and draw the tracked layer alone to distinguish an occluder from lost ink.
import { fail, renderProject } from './core.js';

// A disputed outline may also close the current owner's silhouette. Give the artist a
// concrete touching colour to inspect before transferring the edge to another layer.
function differentInkNeighbors(rest, index, width, current, expected) {
  const x = index % width, height = rest.owners.length / width;
  const candidates = [];
  if (x > 0) candidates.push(index - 1);
  if (x + 1 < width) candidates.push(index + 1);
  if (index >= width) candidates.push(index - width);
  if (index + width < width * height) candidates.push(index + width);
  const different = candidates.filter(pixel => rest.data[4*pixel+3] &&
    [0,1,2,3].some(channel => rest.data[4*index+channel] !== rest.data[4*pixel+channel]));
  return [current,expected].map(id => different.find(pixel => rest.owners[pixel] === id));
}

export function trackCutout(project, recipe, rest, frames, track) {
  const path = 'motion.track';
  if (!track || typeof track !== 'object' || Array.isArray(track) ||
      Object.keys(track).some(key => !['part','rects','pivot'].includes(key)))
    fail(path, 'expected {part, rects, pivot?} for a rigid cutout');
  const { part, rects, pivot } = track, { width, height, ownerNames } = project;
  if (!recipe || !ownerNames || !rest.owners) fail(path, 'inspect the pose source with pixel ownership enabled');
  if (typeof part !== 'string' || !part.length) fail(path + '.part', 'name the instance that should carry the selected pixels');
  if (!Array.isArray(rects) || !rects.length || rects.length > 64) fail(path + '.rects', 'give 1 to 64 standing-pixel rectangles [x,y,w,h]');
  if (pivot !== undefined && (!Array.isArray(pivot) || pivot.length !== 2 || !pivot.every(Number.isSafeInteger) || !rest.anchor))
    fail(path + '.pivot', 'give the ground point [x,y] of the source drawing; the stand must have a pixel anchor');
  const dx = pivot ? rest.anchor[0] - pivot[0] : 0, dy = pivot ? rest.anchor[1] - pivot[1] : 0;
  const selected = new Uint8Array(width * height);
  for (const [n, rect] of rects.entries()) {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isSafeInteger)) fail(path + '.rects[' + n + ']', 'expected [x,y,width,height] in standing pixels');
    const [x,y,w,h] = rect, left = x + dx, top = y + dy;
    if (w < 1 || h < 1 || left < 0 || top < 0 || left+w > width || top+h > height)
      fail(path + '.rects[' + n + ']', 'rectangle falls outside the standing canvas after pivot alignment');
    for (let row = top; row < top+h; row++) selected.fill(1, row*width+left, row*width+left+w);
  }
  const byName = new Map(recipe.frames.map(f => [f.name, f]));
  const layers = [rest, ...frames].map(frame => {
    const raw = byName.get(frame.name), layer = raw?.layers?.find(l => l.name === part);
    if (!layer || layer.ops?.length !== 1 || layer.ops[0].op !== 'stamp' || layer.group !== undefined || raw.from !== undefined ||
        raw.translate || raw.ops?.length || raw.pixels?.length)
      fail(path + '.part', 'tracking needs the same named stamp layer in the stand and every step; inspect the matching pose source and facing');
    const stamp = layer.ops[0];
    return { raw, layer, stamp, x: (layer.x ?? 0) + (stamp.x ?? 0), y: (layer.y ?? 0) + (stamp.y ?? 0) };
  });
  const base = layers[0];
  if (layers.some(({stamp}) => stamp.symbol !== base.stamp.symbol ||
      Object.keys(stamp).some(k => !['op','symbol','x','y','flipX','remap'].includes(k))))
    fail(path + '.part', 'the tracked drawing changes shape in this clip; use the parts view for hand-redrawn or rotating steps');
  const stampWidth = recipe.symbols[base.stamp.symbol][0].length;
  const id = ownerNames.indexOf(part) + 1;
  if (!id) fail(path + '.part', 'the selected layer has no visible source ink');
  const owned = [], wrongRuns = [], edgesToReview = [];
  let edgeCount = 0;
  let checked = 0, wrongPixels = 0;
  for (let i = 0; i < selected.length; i++) {
    if (!selected[i] || !rest.data[i*4+3]) continue;
    checked++;
    if (rest.owners[i] === id) { owned.push(i); continue; }
    const owner = ownerNames[rest.owners[i]-1], x = i % width - dx, y = Math.floor(i / width) - dy;
    const last = wrongRuns.at(-1);
    if (last && last.owner === owner && last.rect[1] === y && last.rect[0] + last.rect[2] === x) last.rect[2]++;
    else wrongRuns.push({owner, rect: [x,y,1,1]});
    const [current, expected] = differentInkNeighbors(rest,i,width,rest.owners[i],id);
    if (current !== undefined || expected === undefined) {
      edgeCount++;
      const point = pixel => pixel === undefined ? null : [pixel % width - dx, Math.floor(pixel / width) - dy];
      if (edgesToReview.length < 64) edgesToReview.push({owner, pixel:[x,y],
        ownerNeighbor:point(current), partNeighbor:point(expected)});
    }
    wrongPixels++;
  }
  if (!checked) fail(path + '.rects', 'the selection contains no visible standing pixels');
  // Palette overrides can make a stamp pixel transparent in an individual step.
  // Examine just the requested layer for the eight steps before classifying coverage.
  const isolated = renderProject({ version: 1, name: 'tracked-part', width, height, palette: recipe.palette,
    symbols: recipe.symbols, ...(recipe.ramps && {ramps: recipe.ramps}),
    frames: layers.slice(1).map(({raw,layer}) => ({name: raw.name, ...(raw.palette && {palette:raw.palette}), layers:[layer]})) });
  const steps = frames.map((f,n) => {
    const step = layers[n+1], coveredBy = Object.create(null);
    const mirror = Boolean(step.stamp.flipX) !== Boolean(base.stamp.flipX);
    let visible = 0, lost = 0;
    for (const i of owned) {
      const column = i % width - base.x;
      const x = step.x + (mirror ? stampWidth - 1 - column : column);
      const y = Math.floor(i / width) - base.y + step.y;
      const at = y * width + x;
      if (x < 0 || y < 0 || x >= width || y >= height || !isolated.frames[n].data[at*4+3]) lost++;
      else if (f.owners[at] === id) visible++;
      else {
        const cover = ownerNames[f.owners[at]-1];
        if (cover === undefined) lost++;
        else coveredBy[cover] = (coveredBy[cover] ?? 0) + 1;
      }
    }
    return {frame:f.name, visible, ...(Object.keys(coveredBy).length && {coveredBy}), ...(lost && {lost})};
  });
  return {part, rest:rest.name, checked, wrongPixels, wrong:wrongRuns.slice(0,64),
    ...(edgeCount > 0 && {edgesToReview, edgeCount,
      edgeHint:'These pixels touch a different colour on the current owner or lack one on the requested part. The neighbor fields give adjacent different-colour ink on each part, or null. Inspect both silhouettes before moving a shared contour. Preserve an uncertain foreground edge and underpaint the hidden part if needed.'}),
    ...(wrongRuns.length > 64 && {omittedRuns:wrongRuns.length-64}), steps,
    passed: !wrongPixels && steps.every(step => !step.lost)};
}
