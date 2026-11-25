// Export native facts for the independent scorer using the pinned baseline renderer.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const [pkg, source, output] = process.argv.slice(2);
if (!output) throw Error('Usage: node native.mjs INSTALLED_PACKAGE SOURCE.poses.json OUTPUT.json');
const {compilePoses, renderProject, buildAtlas} = await import(pathToFileURL(join(resolve(pkg), 'src/index.js')));
const input = JSON.parse(readFileSync(source));
const {recipe, metadata} = compilePoses(input);
const project = renderProject(recipe, {owners:true});
const atlas = buildAtlas(project);
const sheet = {width:atlas.width, height:atlas.height, rgbaSha256:createHash('sha256').update(atlas.data).digest('hex')};
const frames = Object.fromEntries(project.frames.map(frame => [frame.name, {
  rgba: Buffer.from(frame.data).toString('base64'),
  owners: Buffer.from(frame.owners).toString('base64'),
  anchor:frame.anchor, duration:frame.duration,
  parts:Object.fromEntries(Object.entries(metadata.poses[frame.name].parts).map(([name, part]) => [name, part.anchor])),
  coverage:{}
}]));
// Observe concealed surfaces with the renderer's public layer isolation. This
// detects a crossing flattened to one foreground colour even if the PNG agrees.
const names = new Set(recipe.frames.flatMap(frame => (frame.layers ?? []).map(layer => layer.name)));
for (const name of names) {
  const isolated = renderProject(recipe, {layers:[name]});
  for (const frame of isolated.frames) {
    const bits = Buffer.alloc(Math.ceil(project.width * project.height / 8));
    for (let pixel = 0; pixel < project.width * project.height; pixel++) {
      if (frame.data[pixel * 4 + 3]) bits[pixel >> 3] |= 1 << (pixel & 7);
    }
    frames[frame.name].coverage[name] = bits.toString('base64');
  }
}
const clips = Object.fromEntries(Object.entries(project.animations).map(([name, clip]) => {
  const cutout = metadata.animations[name].cutout;
  return [name, {frames: clip.frames.map(i => project.frames[i].name), loop: clip.loop,
    ...(cutout && {rest: cutout.rest, direction: cutout.direction})}];
}));
// A new patch grid can follow the original instance and use its own anchor.
// Retain its lineage so the oracle can recognise this editable repair.
const parents = Object.fromEntries(input.poses.filter(pose => pose.parts).map(pose =>
  [pose.name, Object.fromEntries(pose.parts.map(part => [part.name, part.attach?.part ?? null]))]));
if (project.ownerNames.length > 255) throw Error('Benchmark expects at most 255 layers.');
writeFileSync(output, JSON.stringify({width:project.width,height:project.height,names:project.ownerNames,frames,clips,parents,sheet}));
