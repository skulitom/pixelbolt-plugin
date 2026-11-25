// Review the eight displayed cutout poses against their own rest and intended travel direction.
// Component counts flag newly separated pixels, including a whole boot. An intentional floating
// detail in the rest doesn't fail merely because it is present throughout the animation.
import { fail, inspectProject, renderProject } from './core.js';
import { trackCutout } from './cutout-track.js';

function islands(frame, width, height) {
  const pixels = width * height, seen = new Uint8Array(pixels), pending = new Int32Array(pixels);
  let groups = 0;
  for (let i = 0; i < pixels; i++) {
    if (seen[i] || !frame.data[i*4+3]) continue;
    groups++;
    seen[i] = 1;
    pending[0] = i;
    let count = 1;
    while (count) {
      const at = pending[--count], x = at % width, y = Math.floor(at / width);
      for (let row = Math.max(0, y-1); row <= Math.min(height-1, y+1); row++) {
        for (let col = Math.max(0, x-1); col <= Math.min(width-1, x+1); col++) {
          const next = row * width + col;
          if (seen[next] || !frame.data[next*4+3]) continue;
          seen[next] = 1;
          pending[count++] = next;
        }
      }
    }
  }
  return groups;
}

// A limb that touches the hem only at a corner is visually detached even if the full sprite
// still has one eight-connected component. Count distinct visible foot pixels with an edge
// against a non-foot part. Hidden feet have no visible joint to judge.
function footJoin(frame, id, feet, width) {
  let visible = 0, joined = 0;
  const owners = frame.owners;
  const torso = index => owners[index] > 0 && !feet.includes(owners[index]);
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] !== id) continue;
    visible++;
    const x = i % width;
    if ((x > 0 && torso(i-1)) || (x+1 < width && torso(i+1)) || torso(i-width) || torso(i+width)) joined++;
  }
  return { visible, joined };
}

// Recheck only the questionable poses, hiding the other foot. A boot drawn in front
// can conceal a sound joint. Pose compilers emit self-contained layers of stamps, so
// these frames can be drawn alone. For other recipes retain the visible-edge finding.
function coveredJoints(recipe, weak, feet, index, threshold) {
  if (!recipe || !weak.length) return [];
  const frames = recipe.frames.filter(frame => weak.includes(frame.name));
  if (frames.some(frame => frame.from !== undefined || frame.ops?.length || frame.pixels?.length || frame.translate || !frame.layers?.every(layer =>
    layer.ops?.every(op => op.op === 'stamp')))) return [];
  const { width, height, palette, symbols, ramps } = recipe;
  const probe = renderProject({ version: 1, name: 'joint-review', width, height, palette, symbols,
    ...(ramps && { ramps }), frames: frames.map(({ name, palette, layers }) => ({ name, ...(palette && { palette }),
      layers: layers.filter(layer => layer.name !== feet[1 - index]) })) }, { owners: true });
  const id = probe.ownerNames.indexOf(feet[index]) + 1;
  if (!id) return [];
  return probe.frames.filter(frame => footJoin(frame, id, [id], width).joined >= threshold).map(frame => frame.name);
}

function reflected(frames, others, width, height) {
  return frames.every((frame, n) => {
    const other = others[n], pivot = frame.anchor?.[0], otherPivot = other?.anchor?.[0];
    if (!Number.isInteger(pivot) || pivot !== otherPivot) return false;
    const pixels = frame.data, opposite = other.data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const target = 2*pivot-1-x, a = 4*(y*width+x), b = 4*(y*width+target);
      const alpha = target >= 0 && target < width ? opposite[b+3] : 0;
      if (pixels[a+3] !== alpha || (alpha && (pixels[a] !== opposite[b] || pixels[a+1] !== opposite[b+1] || pixels[a+2] !== opposite[b+2]))) return false;
    }
    return true;
  });
}

export function inspectCutoutWalk(project, options, metadata, info, recipe) {
  const { width, height } = project, clip = project.animations[options.animation];
  if (!info || !['up','down','left','right'].includes(info.direction) || !Array.isArray(info.feet) || info.feet.length !== 2 || info.feet.some(name => typeof name !== 'string') || !Number.isFinite(info.speed) || clip.frames.length !== 8)
    fail('motion.metadata', 'expected an eight-step cutout walk from the matching pose source; recompile the source and its metadata');
  const frames = clip.frames.map(i => project.frames[i]), rest = project.frames.find(f => f.name === info.rest);
  if (!rest) fail('motion.metadata', 'the cutout review needs the original standing frame; inspect the full pose source before trimming its animations');
  const speed = options.speed ?? info.speed, vertical = info.direction === 'down' || info.direction === 'up';
  const baseline = islands(rest, width, height), separated = [], clipped = [], fixes = [];
  for (const frame of frames) {
    const count = islands(frame, width, height);
    if (count > baseline) separated.push({ frame: frame.name, islands: count });
    const pixels = metadata.poses[frame.name]?.clippedPixels;
    if (pixels) clipped.push({ frame: frame.name, pixels });
  }
  const footJoints = [];
  if (project.ownerNames && rest.owners) {
    const ids = info.feet.map(name => project.ownerNames.indexOf(name) + 1);
    for (const [n, id] of ids.entries()) {
      if (!id) continue;
      const weak = [], restContact = footJoin(rest, id, ids, width);
      let minimum = null;
      for (const frame of frames) {
        const contact = footJoin(frame, id, ids, width);
        if (!contact.visible) continue;
        minimum = Math.min(minimum ?? contact.joined, contact.joined);
        if (contact.joined < Math.min(2, restContact.joined)) weak.push(frame.name);
      }
      const occluded = coveredJoints(recipe, weak, info.feet, n, Math.min(2, restContact.joined));
      footJoints.push({ foot: info.feet[n], standingEdgePixels: restContact.joined, minimumEdgePixels: minimum,
        weak: weak.filter(name => !occluded.includes(name)), ...(occluded.length && { occluded }) });
    }
    if (footJoints.some(joint => joint.weak.length)) fixes.push('A visible foot loses edge contact with the body or narrows to one pixel. For an imported boot under a hem, try extendFeet: 2 on that facing and reimport. Otherwise keep an opaque row behind its joint or reduce the stride.');
  }
  const slide = info.feet.map((foot, n) => {
    // Each rigid foot stays planted from its leading contact through the opposite contact.
    // Displacement of any point on the rigid drawing equals displacement of its anchor.
    const samples = [];
    let elapsed = 0;
    for (let step = 0; step <= 4; step++) {
      const frame = frames[(n*4 + step) % 8], at = metadata.poses[frame.name]?.parts?.[foot]?.anchor;
      if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) fail('motion.metadata', 'missing foot anchor for ' + frame.name + ' in ' + foot);
      const travel = speed * elapsed / 1000;
      samples.push([at[0] + (vertical ? 0 : travel), at[1] + (vertical ? travel : 0)]);
      elapsed += frame.duration;
    }
    let farthest = 0;
    for (const [x,y] of samples) for (const [a,b] of samples) farthest = Math.max(farthest, (x-a)**2 + (y-b)**2);
    return { foot, pixels: Math.round(Math.sqrt(farthest)*1000)/1000 };
  });
  const opposite = info.direction === 'right' ? 'left' : 'right';
  const match = !vertical && (info.mirroredFrom || Object.keys(project.animations).find(k => metadata.animations[k]?.cutout?.direction === opposite));
  let profile;
  if (match && project.animations[match]?.frames.length === frames.length) {
    const exact = reflected(frames, project.animations[match].frames.map(i => project.frames[i]), width, height);
    profile = { opposite: match, authored: !info.mirroredFrom, exactMirror: exact };
    if (exact && !info.mirroredFrom && !metadata.animations[match]?.cutout?.mirroredFrom) fixes.push('Both independently supplied profiles are exact reflections. Check the hand and facing of asymmetric equipment.');
    if (info.mirroredFrom) fixes.push('This profile uses mirrorAs. Supply a separately drawn profile when the equipment must stay on one anatomical side.');
  }
  if (separated.length) fixes.push('Inspect the named frames for newly detached pixels. Widen overlap at the joint, paint the surface behind it or reduce the stride or bob.');
  if (clipped.length) fixes.push('Add a transparent margin and move the pivot with the artwork, or reduce the stride or lift.');
  if (slide.some(s => s.pixels > 1)) fixes.push('Match game movement speed to stride and frame duration. Use signed pixels per second along the facing axis.');
  const motion = { animation: options.animation, direction: info.direction, speed, duration: clip.duration, cutout: {
    standingIslands: baseline, separated, clipped, slide, ...(footJoints.length && { footJoints }), ...(profile && { profile }), fixes
  } };
  if (options.track !== undefined) motion.cutout.track = trackCutout(project, recipe, rest, frames, options.track);
  if (options.ground !== undefined) fail('motion.ground', 'cutout review measures travel relative to the standing pose; omit ground to review this clip');
  return { ...inspectProject(project, { animation: options.animation, scale: options.scale, background: options.background, maxCells: 8 }), mode: 'motion', motion };
}
