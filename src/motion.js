// Advisory motion measurements at displayed-frame onsets. Never changes the artwork.
import { PixelError, parseColor } from './core.js';
import { angleDelta } from './pose-geometry.js';

const fail = (where, message) => { throw new PixelError(`motion.${where}`, message); };
const rounded = n => Math.round(n * 1e6) / 1e6;
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const distance2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

// Copy complete RGBA words, then duplicate rows. Endianness is irrelevant: no packed-channel arithmetic.
function enlarge(data, width, height, scale) {
  if (scale === 1) return data.slice();
  const source = new Uint32Array(data.buffer, data.byteOffset, width * height), target = new Uint32Array(width * height * scale * scale), row = width * scale;
  for (let y = 0; y < height; y++) {
    const start = y * scale * row;
    for (let x = 0; x < width; x++) target.fill(source[y * width + x], start + x * scale, start + (x + 1) * scale);
    for (let dy = 1; dy < scale; dy++) target.set(target.subarray(start, start + row), start + dy * row);
  }
  return new Uint8ClampedArray(target.buffer);
}

// Convex hull + rotating calipers: exact farthest pair without quadratic contact-phase work.
function diameter(points) {
  if (points.length < 2) return 0;
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]), half = list => {
    const hull = [];
    for (const p of list) { while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), p) <= 0) hull.pop(); hull.push(p); }
    return hull;
  };
  const lo = half(sorted), hi = half(sorted.reverse()), hull = [...lo.slice(0, -1), ...hi.slice(0, -1)];
  if (hull.length < 3) return Math.sqrt(distance2(lo[0], lo.at(-1)));
  let best = 0, j = 1;
  for (let i = 0; i < hull.length; i++) {
    const next = (i + 1) % hull.length, area = k => Math.abs(cross(hull[i], hull[next], hull[k]));
    while (area((j + 1) % hull.length) > area(j)) j = (j + 1) % hull.length;
    best = Math.max(best, distance2(hull[i], hull[j]), distance2(hull[next], hull[j]));
  }
  return Math.sqrt(best);
}

function pixelDifference(a, b) {
  let changed = 0, opaque = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (!a[i + 3] && !b[i + 3]) continue;
    opaque++;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changed++;
  }
  return { changed, opaque, share: opaque ? rounded(changed / opaque) : 0 };
}

function poseData(metadata, frame) {
  const pose = metadata?.poses?.[frame.name];
  if (!pose) return { contacts: undefined, markers: [], parts: {} };
  const markers = pose.markers ?? [], contacts = pose.contacts;
  if (!Array.isArray(markers) || markers.length > 64 || markers.some(m => typeof m?.name !== 'string' || !Array.isArray(m.at) || m.at.length !== 2 || m.at.some(v => !Number.isInteger(v) || Math.abs(v) > 8192))) fail('metadata', `invalid markers for ${frame.name}`);
  if (new Set(markers.map(m => m.name)).size !== markers.length) fail('metadata', `duplicate markers for ${frame.name}`);
  if (contacts !== undefined && (!Array.isArray(contacts) || contacts.length > 64 || new Set(contacts).size !== contacts.length || contacts.some(name => !markers.some(m => m.name === name)))) fail('metadata', `invalid contacts for ${frame.name}`);
  const parts = pose.parts ?? {};
  if (!parts || Array.isArray(parts) || typeof parts !== 'object' || Object.keys(parts).length > 64) fail('metadata', `invalid parts for ${frame.name}`);
  for (const part of Object.values(parts)) if (!part || (part.worldAngle !== undefined && (!Number.isInteger(part.worldAngle) || part.worldAngle < 0 || part.worldAngle > 359))) fail('metadata', `invalid joint angle for ${frame.name}`);
  return { contacts, markers, parts };
}

function jointDifference(a, b) {
  const joints = Object.entries(a.parts).flatMap(([name, part]) => part.worldAngle === undefined || b.parts[name]?.worldAngle === undefined ? []
    : [{ name, degrees: Math.abs(angleDelta(part.worldAngle, b.parts[name].worldAngle)) }]);
  return { joints, maximum: joints.length ? Math.max(...joints.map(j => j.degrees)) : null };
}

export function inspectMotion(project, options = {}) {
  const allowed = ['animation', 'metadata', 'speed', 'ground', 'scale', 'background'];
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options', 'expected an object');
  for (const key of Object.keys(options)) if (!allowed.includes(key)) fail(key, 'unknown field for motion review');
  const animation = project.animations[options.animation];
  if (typeof options.animation !== 'string' || !animation) fail('animation', 'select a named animation');
  const metadata = options.metadata;
  if (metadata !== undefined && (metadata?.format !== 'pixelforge-pose-metadata' || metadata.version !== 1 || !metadata.poses || typeof metadata.poses !== 'object' || Array.isArray(metadata.poses))) fail('metadata', 'expected version-1 pose metadata from compilePoses');
  const speed = options.speed ?? metadata?.animations?.[options.animation]?.speed ?? null, ground = options.ground ?? metadata?.rig?.ground ?? null;
  if (speed !== null && (typeof speed !== 'number' || !Number.isFinite(speed) || Math.abs(speed) > 4096)) fail('speed', 'expected pixels per second within ±4096');
  if (ground !== null && (!Number.isInteger(ground) || ground < 0 || ground >= project.height)) fail('ground', 'expected a pixel row inside the canvas');
  const scale = options.scale ?? 4;
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) fail('scale', 'expected an integer from 1 to 16');
  let time = 0;
  const entries = animation.frames.map((index, position) => {
    const frame = project.frames[index], entry = { frame, position, start: time, ...poseData(metadata, frame) };
    time += frame.duration; return entry;
  });
  const contactsAvailable = entries.every(e => e.contacts !== undefined), phases = [], groundErrors = [];
  const names = new Set(entries.flatMap(e => e.contacts ?? []));
  for (const name of names) {
    const active = entries.map(e => Boolean(e.contacts?.includes(name)));
    // Begin at an unplanted sample so a phase crossing the loop seam stays one phase.
    const firstOff = active.indexOf(false), start = animation.loop && active[0] && active.at(-1) && firstOff >= 0 ? firstOff + 1 : 0;
    let phase = null;
    const count = entries.length + (animation.loop && firstOff < 0 ? 1 : 0);
    for (let step = 0; step < count; step++) {
      const absolute = start + step, i = absolute % entries.length, entry = entries[i];
      if (!active[i]) { phase = null; continue; }
      const at = entry.markers.find(m => m.name === name).at, t = entry.start + Math.floor(absolute / entries.length) * time;
      if (!phase) { phase = { marker: name, samples: [], points: [] }; phases.push(phase); }
      phase.samples.push({ position: i, frame: entry.frame.name, time: t, at });
      if (speed !== null) phase.points.push([at[0] + speed * t / 1000, at[1]]);
    }
    for (const entry of entries) if (entry.contacts?.includes(name) && ground !== null) {
      const at = entry.markers.find(m => m.name === name).at;
      groundErrors.push({ marker: name, position: entry.position, frame: entry.frame.name, pixels: ground - at[1] });
    }
  }
  const slide = phases.map(({ marker, samples, points }) => ({ marker, samples, pixels: speed === null ? null : rounded(diameter(points)) }));
  const keyNames = metadata?.animations?.[options.animation]?.keyPoses;
  if (keyNames !== undefined && (!Array.isArray(keyNames) || !keyNames.length || keyNames.length > 256 || new Set(keyNames).size !== keyNames.length || keyNames.some(name => !entries.some(e => e.frame.name === name)))) fail('metadata', 'keyPoses must name distinct frames in this animation');
  const keyEntries = keyNames === undefined ? entries : keyNames.map(name => entries.find(e => e.frame.name === name));
  const pairs = keyEntries.slice(1).map((entry, i) => [keyEntries[i], entry, .2]);
  if (animation.loop && keyEntries.length > 1) pairs.push([keyEntries.at(-1), keyEntries[0], .2]);
  // Contact A/B are a separate key-pose comparison, even when there are intervening down/passing poses.
  const a = entries.find(e => /(?:^|-)contact-a$/.test(e.frame.name)), b = entries.find(e => /(?:^|-)contact-b$/.test(e.frame.name));
  if (a && b) pairs.push([a, b, .3]);
  const poseSpread = pairs.map(([a, b, minimum]) => {
    const difference = pixelDifference(a.frame.data, b.frame.data);
    if (minimum !== .3) return { from: a.frame.name, to: b.frame.name, ...difference, minimum, pass: difference.share >= minimum };
    // In a side view, contact A and B can share most pixels although the legs have traded places: the poses differ
    // in which leg is forward, not in silhouette. Posed figures with joint angles therefore also pass when some
    // joint turns at least 20° between them; drawings without joints (a grid-part run) are judged by pixels alone.
    // When the rig names its legs, only leg joints count, so a swaying tail cannot pass identical legs.
    const legs = new Set(Array.isArray(metadata?.rig?.legs) ? metadata.rig.legs.flat() : []);
    const turns = jointDifference(a, b).joints.filter(j => !legs.size || legs.has(j.name)).map(j => j.degrees);
    const joints = turns.length ? Math.max(...turns) : null;
    return { from: a.frame.name, to: b.frame.name, ...difference, minimum, ...(joints !== null && { jointDegrees: joints, jointMinimum: 20 }),
      pass: difference.share >= minimum || (joints !== null && joints >= 20) };
  });
  const seam = jointDifference(entries.at(-1), entries[0]);
  const internal = entries.slice(1).map((e, i) => jointDifference(entries[i], e));
  const maxima = internal.map(d => d.maximum).filter(n => n !== null), largestInternal = maxima.length ? Math.max(...maxima) : null;
  // Paired rig limbs run half a cycle apart, so one leg's swing-to-contact jump falls on the loop seam while its
  // partner makes the same jump inside the cycle. Each joint is compared with itself and its partner in the pair.
  const partners = new Map();
  for (const role of ['legs', 'arms']) {
    const chains = Array.isArray(metadata?.rig?.[role]) ? metadata.rig[role] : [];
    for (let j = 0; j + 1 < chains.length; j += 2) for (let k = 0; k < Math.min(chains[j].length, chains[j + 1].length); k++) {
      partners.set(chains[j][k], chains[j + 1][k]); partners.set(chains[j + 1][k], chains[j][k]);
    }
  }
  for (const joint of seam.joints) {
    const names = partners.has(joint.name) ? [joint.name, partners.get(joint.name)] : [joint.name];
    const jumps = internal.flatMap(d => d.joints.filter(j => names.includes(j.name)).map(j => j.degrees));
    joint.largestInternal = jumps.length ? Math.max(...jumps) : null;
    if (names.length > 1) joint.partner = names[1];
    joint.pass = !animation.loop || joint.largestInternal === null ? null : joint.degrees <= joint.largestInternal;
  }
  const loopSeam = { ...pixelDifference(entries.at(-1).frame.data, entries[0].frame.data), ...seam, largestInternal,
    pass: !animation.loop || seam.maximum === null || largestInternal === null ? null : seam.joints.every(j => j.pass !== false) };
  const checks = {
    slide: !contactsAvailable || !names.size || speed === null ? null : slide.every(p => p.pixels <= 1),
    ground: !contactsAvailable || !names.size || ground === null ? null : groundErrors.every(e => e.pixels === 0),
    poseSpread: poseSpread.length ? poseSpread.every(p => p.pass) : null,
    loopSeam: loopSeam.pass
  };
  const motion = { animation: options.animation, speed, ground, duration: time, loop: animation.loop,
    sampling: 'Displayed-frame onsets; held-frame travel is excluded. Slide is the farthest pair of world-space contact samples; positive ground error floats, negative sinks.',
    contactsAvailable, slide, groundErrors, poseSpread, loopSeam, checks };
  return { mode: 'motion', motion, ...motionStrip(project, entries, motion, scale, options.background) };
}

function motionStrip(project, entries, motion, requestedScale, background) {
  // The image is bounded independently of the report: at most 32 samples, explicit positions and omissions.
  const count = Math.min(32, entries.length), positions = Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (entries.length - 1) / (count - 1)));
  const selected = positions.map(i => entries[i]), { width: w, height: h } = project;
  const travel = selected.map(e => Math.round((motion.speed ?? 0) * e.start / 1000)), left = Math.min(...travel), span = Math.max(...travel) - left;
  const columns = Math.min(4, count), lanes = Math.min(8, count), timingWidth = columns * (w + 4) + 4, timingHeight = Math.ceil(count / columns) * (h + 4) + 4;
  let trajectory = motion.speed !== null && span + w + 4 <= 4096;
  let panelWidth = trajectory ? span + w + 8 : 0, width = panelWidth + timingWidth, height = Math.max(timingHeight, trajectory ? lanes * (h + 4) + 4 : 0);
  if (width * height > 4194304) { trajectory = false; panelWidth = 0; width = timingWidth; height = timingHeight; }
  const actualScale = Math.max(1, Math.min(requestedScale, Math.floor(Math.sqrt(4194304 / (width * height)))));
  if (width * height > 4194304) fail('image', 'motion strip exceeds 4,194,304 pixels');
  const data = new Uint8ClampedArray(width * height * 4), bg = parseColor(background ?? '#18212b', project.palette, 'motion.background');
  for (let i = 0; i < data.length; i += 4) data.set(bg, i);
  const pixel = (x, y, color) => { if (x >= 0 && y >= 0 && x < width && y < height) data.set(color, (y * width + x) * 4); };
  const draw = (entry, x, y) => {
    if (motion.ground !== null) for (let gx = x; gx < x + w; gx++) pixel(gx, y + motion.ground + 1, [80, 100, 115, 255]);
    for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
      const from = (sy * w + sx) * 4, to = ((y + sy) * width + x + sx) * 4, alpha = entry.frame.data[from + 3] / 255, outAlpha = alpha + data[to + 3] / 255 * (1 - alpha);
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) data[to + c] = outAlpha ? Math.round((entry.frame.data[from + c] * alpha + data[to + c] * data[to + 3] / 255 * (1 - alpha)) / outAlpha) : 0;
      data[to + 3] = Math.round(outAlpha * 255);
    }
    for (const marker of entry.markers) if (entry.contacts?.includes(marker.name)) {
      const mx = x + marker.at[0], my = y + marker.at[1];
      for (let dx = -1; dx <= 1; dx++) pixel(mx + dx, my + 1, [255, 206, 83, 255]);
    }
  };
  const cells = selected.map((entry, i) => {
    const timing = [panelWidth + 2 + i % columns * (w + 4), 2 + Math.floor(i / columns) * (h + 4)];
    draw(entry, ...timing);
    const along = trajectory ? [2 + travel[i] - left, 2 + i % lanes * (h + 4)] : null;
    if (along) draw(entry, ...along);
    return { position: entry.position, frame: entry.frame.name, start: entry.start, duration: entry.frame.duration, timing, ...(along && { trajectory: along }) };
  });
  return { cells, omitted: entries.length - count, trajectory: { shown: trajectory, ...(trajectory ? { origin: -left, width: panelWidth, lanes } : { reason: motion.speed === null ? 'Specify speed to draw the trajectory.' : 'Travel exceeds the 4096-pixel width or 4,194,304-pixel image limit.' }) },
    nativeSheet: { width, height, scale: 1, data },
    sheet: { width: width * actualScale, height: height * actualScale, scale: actualScale, data: enlarge(data, width, height, actualScale) } };
}
