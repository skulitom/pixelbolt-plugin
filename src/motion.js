// Advisory motion measurements at displayed-frame onsets. Never changes the artwork.
import { PixelError, parseColor } from './core.js';
import { angleDelta } from './pose-geometry.js';
import { sinDeg, cosDeg, traceLine } from './craft.js';
import { layoutText, FONT_CHARACTERS } from './font.js';

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

// Gait thresholds in degrees: arms within this of swinging opposite the legs, knees bent at most this much more than at
// rest where both feet are down, a walk's lifted thigh at most this far from its rest angle.
const ARM_PHASE = 45, CONTACT_BEND = 30, WALK_LIFT = 45;
const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? value : null;
// How far apart two cycles are, in whole degrees from 0 (together) to 180 (opposite): the angle between their
// once-a-cycle components, so holds and easing within the cycle don't move it. Null when either hardly swings.
function phaseApart(a, b, phases) {
  const harmonic = values => values.reduce(([c, s], v, i) => [c + v * cosDeg(phases[i]), s + v * sinDeg(phases[i])], [0, 0]);
  const [ac, as] = harmonic(a), [bc, bs] = harmonic(b), size = Math.sqrt((ac * ac + as * as) * (bc * bc + bs * bs));
  if (size < 1e-9) return null;
  const cosine = (ac * bc + as * bs) / size;
  let best = 0;
  for (let degrees = 1; degrees <= 180; degrees++) if (Math.abs(cosDeg(degrees) - cosine) < Math.abs(cosDeg(best) - cosine)) best = degrees;
  return best;
}

// What makes a walk or run read, measured where the rig's first two legs trade places over the animation. Every
// measure is in canvas x, so it holds facing either way: the gap between the feet against the gap between the hands
// (each hand's reach ahead of its shoulder), each two-bone knee where both feet are down, and each lifted thigh's swing
// from its rest angle in a walk (a gait with both feet down at some point; a run may lift its knees higher).
function gaitReview(entries, metadata, duration) {
  const rig = metadata?.rig, chains = role => (Array.isArray(rig?.[role]) ? rig[role] : []).slice(0, 2).filter(c => Array.isArray(c) && c.length >= 2 && c.every(n => typeof n === 'string'));
  const legs = chains('legs'), arms = chains('arms'), unmeasured = { legsTrade: null, arms: { pass: null }, contact: { pass: null }, lift: { pass: null } };
  if (legs.length < 2) return unmeasured;
  const joints = (entry, name) => entry.parts[name]?.joints;
  const lead = entries.map(e => { const a = point(joints(e, legs[0].at(-1))?.end), b = point(joints(e, legs[1].at(-1))?.end); return a && b ? a[0] - b[0] : null; });
  if (lead.some(v => v === null)) return unmeasured;
  if (Math.max(...lead) < 1 || Math.min(...lead) > -1) return { ...unmeasured, legsTrade: false };
  const reach = (entry, chain) => { const s = point(joints(entry, chain[0])?.start), e = point(joints(entry, chain.at(-1))?.end); return s && e ? e[0] - s[0] : null; };
  const gap = arms.length < 2 ? [] : entries.map(e => { const a = reach(e, arms[0]), b = reach(e, arms[1]); return a === null || b === null ? null : a - b; });
  const apart = gap.length && !gap.includes(null) && duration > 0 ? phaseApart(lead, gap, entries.map(e => 360 * e.start / duration)) : null;
  const fromOpposite = apart === null ? null : 180 - apart;
  const rest = typeof rig.rest === 'string' ? metadata.poses?.[rig.rest]?.parts : undefined;
  const angle = (parts, name) => Number.isInteger(parts?.[name]?.worldAngle) ? parts[name].worldAngle : null;
  const bend = (parts, chain) => { const a = angle(parts, chain[0]), b = angle(parts, chain[1]); return a === null || b === null ? null : Math.abs(angleDelta(a, b)); };
  const marker = (entry, chain) => entry.markers.find(m => m.part === chain.at(-1))?.name;
  const down = entry => entry.contacts !== undefined && legs.every(chain => entry.contacts.includes(marker(entry, chain)));
  const bent = [], lifted = [];
  for (const entry of entries.filter(down)) for (const chain of legs.filter(c => c.length === 2)) {
    const degrees = bend(entry.parts, chain);
    if (degrees !== null) bent.push({ frame: entry.frame.name, leg: chain.at(-1), degrees: Math.max(0, degrees - (bend(rest, chain) ?? 0)) });
  }
  if (entries.some(down)) for (const entry of entries) for (const chain of legs) {
    if (entry.contacts === undefined || entry.contacts.includes(marker(entry, chain))) continue;
    const thigh = angle(entry.parts, chain[0]);
    if (thigh !== null) lifted.push({ frame: entry.frame.name, leg: chain[0], degrees: Math.abs(angleDelta(angle(rest, chain[0]) ?? 90, thigh)) });
  }
  const largest = list => list.reduce((best, item) => item.degrees > best.degrees ? item : best, list[0]);
  const worst = largest(bent), highest = largest(lifted);
  return { legsTrade: true,
    arms: { degreesFromOpposite: fromOpposite, maximum: ARM_PHASE, pass: fromOpposite === null ? null : fromOpposite <= ARM_PHASE },
    contact: { ...(worst && { largest: worst }), maximum: CONTACT_BEND, pass: worst ? worst.degrees <= CONTACT_BEND : null },
    lift: { ...(highest && { largest: highest }), maximum: WALK_LIFT, pass: highest ? highest.degrees <= WALK_LIFT : null } };
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
    const legs = new Set(['legs', 'hind', 'fore'].flatMap(role => Array.isArray(metadata?.rig?.[role]) ? metadata.rig[role].flat() : []));
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
  for (const role of ['legs', 'hind', 'fore', 'arms']) {
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
  const gait = gaitReview(entries, metadata, time);
  const checks = {
    slide: !contactsAvailable || !names.size || speed === null ? null : slide.every(p => p.pixels <= 1),
    ground: !contactsAvailable || !names.size || ground === null ? null : groundErrors.every(e => e.pixels === 0),
    poseSpread: poseSpread.length ? poseSpread.every(p => p.pass) : null,
    loopSeam: loopSeam.pass,
    armSwing: gait.arms.pass, contactLegs: gait.contact.pass, kneeLift: gait.lift.pass
  };
  const motion = { animation: options.animation, speed, ground, duration: time, loop: animation.loop,
    sampling: 'Displayed-frame onsets; held-frame travel is excluded. Slide is the farthest pair of world-space contact samples; positive ground error floats, negative sinks.',
    contactsAvailable, slide, groundErrors, poseSpread, loopSeam, gait, checks };
  return { mode: 'motion', motion, ...motionStrip(project, entries, motion, scale, options.background, metadata) };
}

// The arcs panel's colours: a near limb bright and solid, its far partner darker and dashed, the head on its own, and
// without a rig a colour per marker; rings mark where a foot plants, white for the near foot and a wider yellow one
// for the far foot.
const ARC_COLORS = { foot: [[86, 214, 255, 255], [38, 128, 160, 255]], hand: [[255, 168, 64, 255], [170, 98, 36, 255]], head: [[240, 120, 255, 255]] };
const MARKER_COLORS = [[150, 230, 120, 255], [86, 214, 255, 255], [255, 168, 64, 255], [240, 120, 255, 255], [255, 112, 112, 255], [255, 236, 96, 255],
  [160, 160, 255, 255], [120, 232, 216, 255]];
const LANDS = { near: [255, 255, 255, 255], far: [255, 206, 83, 255] }, ARC_GROUND = [80, 100, 115, 255], ARC_PANEL = [30, 41, 52, 255];
const ARC_TEXT = [200, 210, 220, 255], hex = color => '#' + color.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
// A traced point: whole pixels, near enough the canvas that a path stays a few thousand steps long.
const place = value => Array.isArray(value) && value.length === 2 && value.every(v => Number.isInteger(v) && Math.abs(v) <= 8192) ? value : null;

// What the arcs panel traces: the end of each of the rig's legs and arms (paired as the rig lists them, the one of a
// pair drawn later being the near one) and the top of the head above its anchor; with no rig, each marker.
function arcTracks(entries, metadata) {
  const rig = metadata?.rig, order = Object.keys((entries.find(e => Object.keys(e.parts).length) ?? entries[0]).parts), tracks = [];
  for (const [role, kind] of [['legs', 'foot'], ['hind', 'foot'], ['fore', 'foot'], ['arms', 'hand']]) {
    const chains = (Array.isArray(rig?.[role]) ? rig[role] : []).filter(c => Array.isArray(c) && c.length && c.every(n => typeof n === 'string')).slice(0, 8);
    chains.forEach((chain, i) => {
      // Neither drawn: the rig lists the near one of a pair first, as the templates do.
      const name = chain.at(-1), partner = chains[i ^ 1]?.at(-1), mine = order.indexOf(name), theirs = order.indexOf(partner);
      const side = partner === undefined || (mine === theirs ? i % 2 === 0 : mine > theirs) ? 'near' : 'far';
      tracks.push({ kind, part: name, side, color: ARC_COLORS[kind][side === 'near' ? 0 : 1], at: entry => place(entry.parts[name]?.joints?.end) ?? place(entry.parts[name]?.anchor) });
    });
  }
  if (typeof rig?.head === 'string') tracks.push({ kind: 'head', part: rig.head, side: 'near', color: ARC_COLORS.head[0], at: entry => {
    const part = entry.parts[rig.head], anchor = place(part?.anchor), top = place(part?.topLeft);
    return part?.joints ? place(part.joints.end) : anchor && top ? [anchor[0], top[1]] : null;
  } });
  if (!tracks.length) entries[0].markers.slice(0, 8).forEach((marker, i) => tracks.push({ kind: 'marker', part: marker.name, side: 'near', color: MARKER_COLORS[i],
    at: entry => place(entry.markers.find(m => m.name === marker.name)?.at) }));
  return tracks;
}

// The key under the arcs: a sample of each mark and its meaning in the built-in font, wrapped to the panel's width.
// Marker names come from metadata, so a character the font has no glyph for is drawn as ?.
const GLYPHS = new Set(FONT_CHARACTERS), inFont = text => [...text.normalize('NFC')].map(c => GLYPHS.has(c) ? c : '?').join('');
function arcKey(tracks, landings, width) {
  const names = { foot: 'feet', hand: 'hands', head: 'head' }, markers = tracks.filter(t => t.kind === 'marker');
  const items = markers.length ? markers.map(t => ({ mark: 'swatch', color: t.color, text: t.part }))
    : [...new Set(tracks.map(t => t.kind))].map(kind => ({ mark: 'swatch', color: ARC_COLORS[kind][0], text: names[kind] }));
  if (tracks.some(t => t.side === 'far')) items.push({ mark: 'solid', color: ARC_TEXT, text: 'near' }, { mark: 'dashed', color: ARC_TEXT, text: 'far' });
  if (markers.length) { if (landings.length) items.push({ mark: 'ring', color: LANDS.near, text: 'lands' }); }
  else for (const side of ['near', 'far']) if (landings.some(l => l.side === side)) items.push({ mark: 'ring', color: LANDS[side], text: side + ' foot lands' });
  const laid = [];
  let x = 0, y = 0;
  for (const item of items) {
    const text = layoutText(inFont(item.text)), size = 9 + text.width;
    if (x && x + size > width) { x = 0; y += 10; }
    laid.push({ ...item, text, x, y }); x += size + 6;
  }
  return { items: laid, width: Math.max(0, ...laid.map(item => item.x + 9 + item.text.width)), height: laid.length ? y + 10 : 0 };
}

// One cycle's path of each tracked point through every displayed frame, joined in play order (and back to the start
// in a loop), over the first pose, with rings where feet land. Returns how many samples it could not draw: those with
// no point, or too far off the canvas.
function drawArcs(put, [ox, oy], { entries, tracks, landings, key, magnification: m, loop, ground, w, h }) {
  const panelWidth = (w + 2) * m, panelHeight = (h + 2) * m;
  const dot = (x, y, color) => { if (x >= 0 && y >= 0 && x < panelWidth && y < panelHeight) put(ox + x, oy + y, color); };
  for (let y = 0; y < panelHeight; y++) for (let x = 0; x < panelWidth; x++) put(ox + x, oy + y, ARC_PANEL);
  const figure = entries[0].frame.data;
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const i = (sy * w + sx) * 4;
    if (!figure[i + 3]) continue;
    // Muted: a sixth of its brightness over the panel's slate.
    const lift = Math.floor(((54 * figure[i] + 183 * figure[i + 1] + 19 * figure[i + 2]) >> 8) * figure[i + 3] / (255 * 6)), color = [38 + lift, 48 + lift, 60 + lift, 255];
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) dot((sx + 1) * m + x, (sy + 1) * m + y, color);
  }
  if (ground !== null) for (let x = 0; x < panelWidth; x++) dot(x, (ground + 2) * m, ARC_GROUND);
  const at = p => [(p[0] + 1) * m + (m >> 1), (p[1] + 1) * m + (m >> 1)], drawable = p => p && p[0] >= -1 && p[1] >= -1 && p[0] <= w && p[1] <= h;
  const paths = tracks.map(track => ({ track, points: entries.map(entry => track.at(entry)), color: track.color }));
  // A walk's two feet (and two hands) share one loop half a cycle apart, so the far limb's dashes go over the near
  // limb's line: where they part, one shows solid and the other dashed. The head goes last, and near samples over far.
  const layer = path => path.track.kind === 'head' ? 2 : path.track.side === 'far' ? 1 : 0;
  const ordered = [...paths].sort((a, b) => layer(a) - layer(b));
  let skipped = 0;
  for (const { track, points, color } of ordered) {
    let step = 0;
    for (let i = 0; i < (loop ? points.length : points.length - 1) && points.length > 1; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (drawable(a) && drawable(b)) traceLine(...at(a), ...at(b), (x, y) => { if (track.side === 'near' || step++ % 4 < 2) dot(x, y, color); });
    }
  }
  for (const { points, color } of [...ordered].sort((a, b) => (a.track.side === 'far' ? 0 : 1) - (b.track.side === 'far' ? 0 : 1))) for (const p of points) {
    if (!drawable(p)) { skipped++; continue; }
    const [cx, cy] = at(p);
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) dot(cx + x, cy + y, color);
  }
  // Where a foot lands, that foot, the hand on its side and the head are ringed (without a rig, the marker that lands):
  // in a walk or run the ring on the hand's arc sits at the far end from the ring on the foot's loop. A four-legged
  // rig's other foot on that side is not ringed, since it is not the one landing.
  const ring = (cx, cy, r, color) => { for (let i = -r; i <= r; i++) { dot(cx + i, cy - r, color); dot(cx + i, cy + r, color); dot(cx - r, cy + i, color); dot(cx + r, cy + i, color); } };
  const ringed = (track, landing) => track.kind === 'marker' ? track.part === landing.marker : track.kind === 'head'
    || (track.kind === 'foot' ? landing.part === undefined ? track.side === landing.side : track.part === landing.part : track.side === landing.side);
  for (const landing of landings) for (const { track, points } of paths) {
    const p = points[landing.position];
    if (drawable(p) && ringed(track, landing)) ring(...at(p), m + (landing.side === 'far' ? 1 : 0), LANDS[landing.side]);
  }
  const top = oy + panelHeight + 3;
  for (const item of key.items) {
    const x = ox + item.x, y = top + item.y;
    if (item.mark === 'swatch') for (let dy = 1; dy <= 5; dy++) for (let dx = 1; dx <= 5; dx++) put(x + dx, y + dy, item.color);
    else if (item.mark === 'ring') for (let i = 0; i < 5; i++) { put(x + 1 + i, y + 1, item.color); put(x + 1 + i, y + 5, item.color); put(x + 1, y + 1 + i, item.color); put(x + 5, y + 1 + i, item.color); }
    else for (let dx = 0; dx < 7; dx++) if (item.mark === 'solid' || dx % 4 < 2) put(x + dx, y + 3, item.color);
    item.text.rows.forEach((row, ty) => { for (let tx = 0; tx < row.length; tx++) if (row[tx] === '#') put(x + 9 + tx, y + item.text.top + ty, ARC_TEXT); });
  }
  return skipped;
}

function motionStrip(project, entries, motion, requestedScale, background, metadata) {
  // The image is bounded independently of the report: at most 32 samples, explicit positions and omissions.
  const count = Math.min(32, entries.length), positions = Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (entries.length - 1) / (count - 1)));
  const selected = positions.map(i => entries[i]), { width: w, height: h } = project;
  const travel = selected.map(e => Math.round((motion.speed ?? 0) * e.start / 1000)), left = Math.min(...travel), span = Math.max(...travel) - left;
  const columns = Math.min(4, count), lanes = Math.min(8, count), timingWidth = columns * (w + 4) + 4, timingHeight = Math.ceil(count / columns) * (h + 4) + 4;
  // The arcs go under the timing cells, magnified to about their width, and trace every displayed frame.
  const tracks = metadata ? arcTracks(entries, metadata) : [], magnification = Math.max(3, Math.min(8, Math.floor((timingWidth - 4) / (w + 2))));
  const partOf = (marker, position) => entries[position].markers.find(m => m.name === marker)?.part;
  const sideOf = (marker, position) => tracks.find(t => t.kind === 'foot' && t.part === partOf(marker, position))?.side ?? 'near';
  const landings = motion.slide.map(({ marker, samples }) => ({ position: samples[0].position, frame: samples[0].frame, marker, side: sideOf(marker, samples[0].position), part: partOf(marker, samples[0].position) }));
  const arcsWidth = (w + 2) * magnification, key = arcKey(tracks, landings, Math.max(arcsWidth, timingWidth - 4));
  const arcsHeight = (h + 2) * magnification + 3 + key.height + 2;
  let trajectory = motion.speed !== null && span + w + 4 <= 4096, arcs = tracks.length > 0;
  const measure = () => {
    const panel = trajectory ? span + w + 8 : 0;
    return { panel, width: panel + Math.max(timingWidth, arcs ? Math.max(arcsWidth, key.width) + 4 : 0), height: Math.max(timingHeight + (arcs ? arcsHeight : 0), trajectory ? lanes * (h + 4) + 4 : 0) };
  };
  let layout = measure();
  if (layout.width * layout.height > 4194304 && trajectory) { trajectory = false; layout = measure(); }
  if (layout.width * layout.height > 4194304 && arcs) { arcs = false; layout = measure(); }
  const { panel: panelWidth, width, height } = layout;
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
  let arcsReport;
  if (arcs) {
    const origin = [panelWidth + 2, timingHeight], skipped = drawArcs(pixel, origin, { entries, tracks, landings, key, magnification, loop: motion.loop, ground: motion.ground, w, h });
    arcsReport = { shown: true, origin, width: arcsWidth, height: (h + 2) * magnification, magnification, figure: entries[0].frame.name,
      mapping: 'panel x = origin[0] + (x + 1) * magnification + floor(magnification / 2), and likewise y',
      tracks: tracks.map(t => ({ kind: t.kind, part: t.part, side: t.side, color: hex(t.color), ...(t.side === 'far' && { dashed: true }) })),
      landings: landings.map(({ part, ...l }) => ({ ...l, ring: hex(LANDS[l.side]) })), ...(skipped && { skipped }) };
  } else arcsReport = { shown: false, reason: tracks.length ? 'The arcs would take the image past 4,194,304 pixels.' : 'Arcs need pose metadata with a rig (legs, arms, head) or markers.' };
  return { cells, omitted: entries.length - count, trajectory: { shown: trajectory, ...(trajectory ? { origin: -left, width: panelWidth, lanes } : { reason: motion.speed === null ? 'Specify speed to draw the trajectory.' : 'Travel exceeds the 4096-pixel width or 4,194,304-pixel image limit.' }) },
    arcs: arcsReport,
    nativeSheet: { width, height, scale: 1, data },
    sheet: { width: width * actualScale, height: height * actualScale, scale: actualScale, data: enlarge(data, width, height, actualScale) } };
}
