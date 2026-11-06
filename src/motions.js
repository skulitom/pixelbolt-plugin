// Motion templates lower to editable poses. Kept separate from rasterization and file I/O.
import { PixelError } from './core.js';
import { sinDeg, cosDeg, rasterizeMass } from './craft.js';

const fail = (path, message) => { throw new PixelError(path, message); };
const id = (value, path) => { if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) fail(path, 'expected a name of at most 64 characters'); return value; };
const object = (value, keys, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
};
const number = (value, fallback, lo, hi, path, integer) => {
  if (value === undefined) value = fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi || integer && !Number.isInteger(value)) fail(path, `expected ${integer ? 'an integer' : 'a number'} from ${lo} to ${hi}`);
  return value;
};
const squash = n => Math.max(.5, Math.min(2, Math.round(n * 20) / 20));
const endPoint = (source, instance, path) => {
  const name = Object.entries(source.parts[instance.part]?.points ?? {}).find(([, p]) => p === 'end')?.[0];
  if (!name) fail(path, 'the last bone needs a named end point, for example points: {end: "end"}');
  return name;
};
export const MOTION_TEMPLATES = ['walk', 'run', 'idle', 'jump', 'attack', 'hurt'];

export function validateRig(rig, height) {
  object(rig, ['ground', 'body', 'head', 'legs', 'arms', 'tail', 'rest'], 'poses.rig');
  if (!Number.isInteger(rig.ground) || rig.ground < 0 || rig.ground >= height) fail('poses.rig.ground', 'expected a ground pixel row inside the canvas');
  for (const key of ['body', 'head', 'rest']) if (rig[key] !== undefined) id(rig[key], `poses.rig.${key}`);
  for (const key of ['legs', 'arms']) if (rig[key] !== undefined) {
    if (!Array.isArray(rig[key]) || rig[key].length > 8) fail(`poses.rig.${key}`, 'expected up to eight bone chains');
    rig[key].forEach((chain, i) => {
      if (!Array.isArray(chain) || chain.length < 2 || chain.length > 3) fail(`poses.rig.${key}[${i}]`, 'expected two or three bone instances');
      chain.forEach((name, j) => id(name, `poses.rig.${key}[${i}][${j}]`));
    });
  }
  if (rig.tail !== undefined) {
    if (!Array.isArray(rig.tail) || rig.tail.length > 16) fail('poses.rig.tail', 'expected up to sixteen instances');
    rig.tail.forEach((name, i) => id(name, `poses.rig.tail[${i}]`));
  }
}

// compileRest and probeJoints are supplied by authoring.js so this module has no circular compiler import. probeJoints
// resolves one pose's joints without assembling or validating a recipe.
export function expandMotions(input, compileRest, probeJoints) {
  if (!input || input.format !== 'pixelforge-poses' || input.version !== 1) fail('poses', 'expected version-1 pixelforge-poses');
  const source = structuredClone(input);
  if (source.motions === undefined) return source;
  if (source.motionInfo !== undefined) fail('poses.motionInfo', 'motions generate this annotation; omit it until after --expand');
  validateRig(source.rig, source.height);
  id(source.rig.body, 'poses.rig.body'); id(source.rig.rest, 'poses.rig.rest');
  if (!Array.isArray(source.poses)) fail('poses.poses', 'expected authored poses including rig.rest');
  source.poses.forEach((pose, i) => { if (!pose || typeof pose !== 'object' || Array.isArray(pose)) fail(`poses.poses[${i}]`, 'expected an object'); });
  const rest = source.poses.find(p => p.name === source.rig.rest);
  if (!rest?.parts || rest.mirror || rest.tween) fail('poses.rig.rest', 'must name an authored pose with parts and an origin');
  if (source.poses.filter(p => p.name === rest.name).length !== 1) fail('poses.rig.rest', 'rest pose must have a unique name');
  if (!source.motions || typeof source.motions !== 'object' || Array.isArray(source.motions) || Object.keys(source.motions).length > 16) fail('poses.motions', 'expected up to sixteen named motions');
  const restSource = { ...source, poses: [rest], animations: { rest: { frames: [rest.name], loop: false } } };
  delete restSource.motions;
  // Generated poses are checked one at a time for planted-foot reach; that needs joints, not the rig.
  const checkSource = { ...restSource }; delete checkSource.rig;
  const restData = compileRest(restSource).metadata.poses[rest.name], instances = new Map(rest.parts.map(p => [p.name, p])), rig = source.rig;
  const restAngle = name => (restData.parts[name].rotate ?? 0) - (restData.parts[instances.get(name).attach?.part]?.rotate ?? 0);
  const requireInstance = (name, path) => { if (!instances.has(name)) fail(path, `unknown rest-pose instance ${name}`); return instances.get(name); };
  const body = requireInstance(rig.body, 'poses.rig.body');
  if (!source.parts[body.part]?.mass) fail('poses.rig.body', 'motion templates need a mass body');
  if (body.attach) fail('poses.rig.body', 'the motion body must be a root instance');
  if (rig.head) requireInstance(rig.head, 'poses.rig.head');
  for (const name of rig.tail ?? []) requireInstance(name, 'poses.rig.tail');
  const used = new Set();
  for (const role of ['legs', 'arms']) for (const [i, chain] of (rig[role] ?? []).entries()) {
    for (const [j, name] of chain.entries()) {
      const path = `poses.rig.${role}[${i}][${j}]`, part = requireInstance(name, path);
      if (used.has(name)) fail(path, 'motion chains cannot share instances'); used.add(name);
      if (!source.parts[part.part]?.bone) fail(path, 'expected a bone instance');
      if (j && (part.attach?.part !== chain[j - 1] || source.parts[instances.get(chain[j - 1]).part].points?.[part.attach.point] !== 'end' || part.at?.some(v => v !== 0))) fail(path, 'chain bones must attach to the preceding end point with zero offset');
    }
    endPoint(source, instances.get(chain.at(-1)), `poses.rig.${role}[${i}]`);
  }
  const legs = (rig.legs ?? []).map((chain, i) => {
    const last = instances.get(chain.at(-1)), point = endPoint(source, last, `poses.rig.legs[${i}]`);
    const existing = rest.markers?.find(m => m.part === last.name && m.point === point);
    const marker = existing?.name ?? id(`${last.name}Foot`, `poses.rig.legs[${i}]`);
    if (!existing && rest.markers?.some(m => m.name === marker)) fail(`poses.rig.legs[${i}]`, `marker ${marker} is already used for another point`);
    return { last: last.name, point, marker, x: restData.parts[last.name].points[point][0] };
  });
  const generated = [], animations = { ...(source.animations ?? {}) }, motionInfo = {}, groundedPoses = new Map();
  for (const [name, motion] of Object.entries(source.motions)) {
    const path = `poses.motions.${name}`; id(name, path);
    const template = motion?.template;
    if (!MOTION_TEMPLATES.includes(template)) fail(`${path}.template`, `expected ${MOTION_TEMPLATES.join(', ')}`);
    const fields = { walk: ['speed', 'stride', 'lift', 'bob', 'lean', 'swapDepth'], run: ['speed', 'stride', 'lift', 'bob', 'lean', 'swapDepth'], idle: ['breath', 'squash'], jump: ['crouch', 'stretch', 'apex'], attack: ['arm', 'windup', 'strike', 'hold'], hurt: ['recoil', 'squash'] };
    object(motion, ['template', 'frames', 'duration', ...fields[template]], path);
    const p = (key, fallback, lo, hi, integer = false) => number(motion[key], fallback, lo, hi, `${path}.${key}`, integer);
    const duration = p('duration', template === 'idle' ? 200 : 80, 1, 60000, true);
    const locomotion = template === 'walk' || template === 'run';
    const fixed = { jump: 7, attack: 4, hurt: 2 }, count = p('frames', fixed[template] ?? (template === 'idle' ? 4 : template === 'walk' ? 8 : 10), template === 'idle' ? 2 : fixed[template] ?? (template === 'walk' ? 4 : 6), fixed[template] ?? (template === 'idle' ? 16 : 64), true);
    if (locomotion && count % 2) fail(`${path}.frames`, 'walk and run need an even frame count');
    if (locomotion && legs.length < 2) fail('poses.rig.legs', 'walk and run need at least two leg chains');
    const speed = locomotion ? p('speed', template === 'walk' ? 24 : 48, -1024, 1024) : 0;
    const stride = locomotion ? p('stride', 10, 1, 64) : 0, lift = locomotion ? p('lift', template === 'walk' ? 2 : 4, 0, 32) : 0;
    const bob = locomotion ? p('bob', 1, 0, 8) : 0, lean = locomotion ? p('lean', template === 'run' ? 8 : 0, -45, 45, true) : 0;
    if (motion.swapDepth !== undefined && typeof motion.swapDepth !== 'boolean') fail(`${path}.swapDepth`, 'expected a boolean');
    const swapDepth = motion.swapDepth === true;
    const breath = template === 'idle' ? p('breath', .05, 0, .5) : 0;
    // A grounded squash: the body stretches, then squashes, while its lowest drawn pixel stays on rig.ground. Below
    // 0.05 it would round to no change, since mass squash moves in 0.05 steps. Breath squashes about the body's
    // centre and a planted leg holds the body up, so neither can be combined with it.
    const grounded = template === 'idle' && motion.squash !== undefined, squashBy = grounded ? p('squash', 0, .05, .5) : 0;
    if (grounded && motion.breath !== undefined) fail(`${path}.squash`, 'choose breath or squash, not both: breath squashes the body about its centre, squash keeps its base on rig.ground');
    if (grounded && legs.length) fail(`${path}.squash`, 'squash sits the body on rig.ground, but this rig stands on its legs; use breath');
    // The head bob and tail sway move their instance after grounding, so the body can't also play either role.
    if (grounded && rig.head === rig.body) fail('poses.rig.head', `the grounded idle "${name}" keeps the body on rig.ground, so the body can't also be the head, whose bob would lift it; name another instance or leave head out`);
    if (grounded) (rig.tail ?? []).forEach((tail, i) => { if (tail === rig.body) fail(`poses.rig.tail[${i}]`, `the grounded idle "${name}" keeps the body on rig.ground, so the body can't also be part of the tail, whose sway would turn it off the ground`); });
    const crouch = template === 'jump' ? p('crouch', .8, .5, 1) : 1, stretch = template === 'jump' ? p('stretch', 1.15, 1, 2) : 1, apex = template === 'jump' ? p('apex', 4, 1, 32, true) : 0;
    const arm = template === 'attack' ? p('arm', 0, 0, (rig.arms?.length ?? 0) - 1, true) : 0;
    const windup = template === 'attack' ? p('windup', -130, -360, 360, true) : 0, strike = template === 'attack' ? p('strike', 50, -360, 360, true) : 0;
    const hold = template === 'attack' ? p('hold', 2, 1, 16, true) : 1;
    const recoil = template === 'hurt' ? p('recoil', -20, -90, 90, true) : 0, hurtSquash = template === 'hurt' ? p('squash', .85, .5, 2) : 1;
    const half = count / 2;
    // Short contact phases retain both a planted pair and a flight in compact six-frame runs.
    const stance = locomotion ? Math.max(1, Math.min(template === 'walk' ? Math.ceil(count * .625) : Math.max(2, Math.floor(count / 3)), Math.floor(stride / Math.max(.000001, Math.abs(speed) * duration / 1000)) + 1)) : 0;
    const downIndex = Math.max(1, Math.floor(half / 4));
    const phaseKeys = [...new Set([0, downIndex, Math.floor(half / 2), ...(template === 'run' && half >= 5 ? [Math.floor(half * .75)] : []), half - 1])].sort((a, b) => a - b);
    // Past four idle frames the rest are in-betweens: the key poses are the quarter phases (rest, full stretch or
    // inhale, rest, full squash or exhale), which the motion review's pose spread compares.
    const keyIndices = locomotion ? [...phaseKeys, ...phaseKeys.map(i => i + half)] : template === 'idle' && count > 4 ? [...new Set([0, 1, 2, 3].map(q => Math.round(q * count / 4)))] : Array.from({ length: count }, (_, i) => i);
    const labels = new Map();
    if (locomotion) for (const offset of [0, half]) {
      const suffix = offset ? 'b' : 'a', keys = keyIndices.filter(i => i >= offset && i < offset + half);
      const words = keys.length === 2 ? ['contact', template === 'run' ? 'flight' : 'up'] : keys.length === 3 ? ['contact', 'down', template === 'run' ? 'flight' : 'passing'] : keys.length === 5 ? ['contact', 'down', 'passing', 'up', 'flight'] : ['contact', 'down', 'passing', template === 'run' ? 'flight' : 'up'];
      keys.forEach((index, i) => labels.set(index, `${words[i]}-${suffix}`));
    }
    // Past four frames there are more phases than breathing words, so idle poses are numbered from 0.
    const fixedLabels = { idle: count === 2 ? ['inhale', 'exhale'] : count === 3 ? ['rest', 'inhale', 'exhale'] : count === 4 ? ['rest', 'inhale', 'settle', 'exhale'] : Array.from({ length: count }, (_, i) => `${i}`),
      jump: ['crouch', 'take-off', 'rise', 'apex', 'fall', 'land', 'recover'], attack: ['anticipation', 'strike', 'follow-through', 'recover'], hurt: ['recoil', 'recover'] };
    const names = [];
    for (let i = 0; i < count; i++) {
      const pose = structuredClone(rest), label = locomotion ? labels.get(i) ?? `between-${i}` : fixedLabels[template][i];
      pose.name = id(`${name}-${label}`, path); pose.duration = duration;
      pose.origin = [...(rest.origin ?? [0, 0])]; pose.contacts = []; pose.markers = [...(rest.markers ?? [])];
      const parts = new Map(pose.parts.map(p => [p.name, p])), torso = parts.get(rig.body), angle = Math.round(i * 360 / count) + (template === 'idle' && count === 2 ? 90 : 0);
      const setAngle = (part, value) => { delete part.rotate; delete part.reach; delete part.bend; part.angle = ((Math.round(value) + 180) % 360 + 360) % 360 - 180; };
      let dy = 0, bodySquash = 1;
      if (locomotion) { dy = Math.round(bob * cosDeg(angle * 2)); bodySquash = template === 'run' ? (i % half === downIndex ? .9 : i % half === half - 1 ? 1.05 : 1) : 1; setAngle(torso, restAngle(rig.body) + lean); }
      if (template === 'idle') bodySquash = 1 + (grounded ? squashBy : breath) * sinDeg(angle);
      if (template === 'jump') { dy = [2, 0, -apex, -apex * 2, -apex, 2, 0][i]; bodySquash = [crouch, stretch, 1.05, 1, 1, crouch, 1][i]; }
      // Follow-through carries the swing well past the strike and settles the body, so it reads as its own key pose.
      if (template === 'attack') { setAngle(parts.get(rig.arms[arm][0]), [windup, strike, strike + 45, restAngle(rig.arms[arm][0])][i]); bodySquash = [.9, 1.05, .95, 1][i]; setAngle(torso, restAngle(rig.body) + [-8, 8, 14, 0][i]); }
      if (template === 'hurt') { setAngle(torso, restAngle(rig.body) + (i ? 0 : recoil)); bodySquash = i ? 1 : hurtSquash; }
      pose.origin[1] += dy; torso.squash = squash((body.squash ?? 1) * bodySquash);
      if (grounded) {
        // Move the body (and what hangs from it) so its lowest drawn pixel, outline included, sits on rig.ground. The
        // drawing is the compiler's own: the same raster options shapeOf uses, at the rounded squash. The origin stays,
        // so every frame keeps one anchor on the ground.
        const shape = source.parts[body.part].mass, raster = rasterizeMass(shape, { angle: ((restData.parts[rig.body].rotate ?? 0) % 360 + 360) % 360, flipX: torso.flipX === true, squash: torso.squash, light: source.light ?? 225, ramp: source.ramps[shape.ramp] });
        torso.at = [...(torso.at ?? [0, 0])];
        torso.at[1] += rig.ground - (pose.origin[1] + torso.at[1] + raster.rows.findLastIndex(row => /[^.]/.test(row)) - raster.pivot[1]);
      }
      if (rig.head && template === 'idle') { const head = parts.get(rig.head); head.at = [...(head.at ?? [0, 0])]; head.at[1] -= Math.round(sinDeg(angle)); }
      for (const [j, tail] of (rig.tail ?? []).entries()) setAngle(parts.get(tail), restAngle(tail) + 10 * sinDeg(angle - j * 25));
      if (locomotion) for (const [j, chain] of (rig.arms ?? []).entries()) setAngle(parts.get(chain[0]), restAngle(chain[0]) + 35 * sinDeg(angle + j % 2 * 180));
      for (const [j, leg] of legs.entries()) {
        const last = parts.get(leg.last);
        delete last.angle; delete last.rotate;
        let x = leg.x, y = rig.ground, planted = true;
        if (locomotion) {
          const k = (i + (j % 2) * half) % count, direction = speed < 0 ? -1 : 1, front = leg.x + direction * stride / 2;
          planted = k < stance;
          if (planted) x = front - speed * k * duration / 1000;
          else {
            const back = front - speed * (stance - 1) * duration / 1000, t = (k - stance + 1) / (count - stance + 1);
            x = back + (front - back) * t; y -= lift === 0 ? 0 : Math.max(1, Math.round(lift * 4 * t * (1 - t)));
          }
        } else if (template === 'jump' && i > 0 && i < 5) { planted = false; y += Math.min(-1, dy); }
        last.reach = [Math.round(x), Math.round(y)]; last.bend ??= 'forward';
        if (!pose.markers.some(m => m.name === leg.marker)) pose.markers.push({ name: leg.marker, part: leg.last, point: leg.point });
        if (planted) pose.contacts.push(leg.marker);
      }
      if (template === 'attack' && i === 1) {
        const last = parts.get(rig.arms[arm].at(-1)), point = endPoint(source, last, path);
        if (pose.markers.some(m => m.name === 'strike')) fail(path, 'the attack strike marker is reserved; rename the rest marker');
        pose.markers.push({ name: 'strike', part: last.name, point });
      }
      if (locomotion && swapDepth && i >= half) {
        // Only on request (front or back views, where the stepping limb comes nearer the camera). In a side view the
        // near limbs stay in front: the half-cycle phase offset above already alternates the poses, and swapping depth
        // too would put a darker far arm or leg in front of the body for half of every cycle.
        // Swap whole limb subtrees in their original paint slots; the attachment graph is unchanged.
        for (const chains of [rig.legs ?? [], rig.arms ?? []]) for (let j = 0; j + 1 < chains.length; j += 2) {
          const subtree = root => {
            const found = new Set([root]); let changed = true;
            while (changed) { changed = false; for (const p of pose.parts) if (p.attach && found.has(p.attach.part) && !found.has(p.name)) { found.add(p.name); changed = true; } }
            return found;
          };
          const a = subtree(chains[j][0]), b = subtree(chains[j + 1][0]);
          const aParts = pose.parts.filter(p => a.has(p.name)), bParts = pose.parts.filter(p => b.has(p.name));
          pose.parts = pose.parts.flatMap(p => a.has(p.name) ? p === aParts[0] ? bParts : [] : b.has(p.name) ? p === bParts[0] ? aParts : [] : [p]);
        }
      }
      generated.push(pose); names.push(pose.name);
      if (grounded) groundedPoses.set(pose.name, name);
    }
    // A bob or lean must never lift a hip beyond its leg: a planted foot that misses its target floats and slides.
    // Find how far each pose must sink (at most four pixels, while that reduces its planted feet's miss) and lower
    // every pose of the motion by the deepest of those, so the bob keeps its shape and no frame dips on its own.
    const sink = pose => {
      const plantedLegs = legs.filter(leg => pose.contacts.includes(leg.marker));
      if (!plantedLegs.length) return 0;
      // Only the planted chains and what they hang from decide where a foot lands; compile just those.
      const byName = new Map(pose.parts.map(p => [p.name, p])), needed = new Set();
      for (const leg of plantedLegs) for (let name = leg.last; name && !needed.has(name); name = byName.get(name)?.attach?.part) needed.add(name);
      const probe = { name: pose.name, origin: pose.origin, parts: pose.parts.filter(p => needed.has(p.name)) };
      const probeParts = Object.fromEntries([...new Set(probe.parts.map(p => p.part))].map(name => [name, source.parts[name]]));
      const miss = () => {
        const placed = probeJoints({ ...checkSource, parts: probeParts, poses: [probe], animations: { check: { frames: [pose.name], loop: false } } }).metadata.poses[pose.name].parts;
        return plantedLegs.reduce((sum, leg) => {
          const end = placed[leg.last].joints.end, target = pose.parts.find(p => p.name === leg.last).reach;
          return sum + Math.abs(end[0] - target[0]) + Math.abs(end[1] - target[1]);
        }, 0);
      };
      const start = pose.origin[1];
      let depth = 0;
      for (let current = miss(); current && depth < 4;) {
        pose.origin[1] = start + depth + 1;
        const next = miss();
        if (next >= current) break;
        current = next; depth++;
      }
      pose.origin[1] = start;
      return depth;
    };
    const motionPoses = generated.slice(-count), depth = Math.max(...motionPoses.map(sink));
    if (depth) for (const pose of motionPoses) pose.origin[1] += depth;
    if (Object.hasOwn(animations, name)) fail(`${path}`, 'the generated animation name is already authored; choose another motion name');
    const playback = template === 'attack' ? [names[0], ...Array(hold).fill(names[1]), ...names.slice(2)] : names;
    animations[name] = { frames: playback, loop: locomotion || template === 'idle' };
    motionInfo[name] = { template, speed, keyPoses: keyIndices.map(i => names[i]) };
  }
  const authored = new Map();
  for (const pose of source.poses) { if (authored.has(pose.name)) fail('poses.poses', `duplicate authored pose ${pose.name}`); authored.set(pose.name, pose); }
  const generatedNames = new Set(generated.map(p => p.name)), inputIndex = new Map(source.poses.map((pose, i) => [pose.name, i]));
  source.poses = [...source.poses.filter(p => !generatedNames.has(p.name)), ...generated.map(p => authored.get(p.name) ?? p)];
  // An authored pose standing in for a pose of a grounded idle is the author's own, so it is never moved: it must
  // already stand on rig.ground. Its body is measured as the compiler draws it (the pose may turn, flip, squash or
  // attach the body, or mirror or tween other poses, so compile the poses rather than redraw one mass). A pose that
  // fails to compile here is left to the full compile, which reports it at its written path.
  const standIns = [...groundedPoses.keys()].filter(pose => authored.has(pose));
  if (standIns.length) {
    let drawn = null;
    try { drawn = compileRest({ ...checkSource, poses: source.poses, animations: { check: { frames: standIns, loop: false } } }); }
    catch (error) { if (!(error instanceof PixelError)) throw error; }
    for (const pose of drawn ? standIns : []) {
      const placed = drawn.metadata.poses[pose].parts[rig.body], rows = placed && drawn.recipe.symbols[placed.symbol ?? placed.definition];
      const lowest = placed ? placed.topLeft[1] + rows.findLastIndex(row => /[^. ]/.test(row)) : null, at = `poses.poses[${inputIndex.get(pose)}]`;
      const about = `"${pose}" stands in for a pose of the grounded idle "${groundedPoses.get(pose)}", so`;
      if (lowest === null) fail(at, `${about} it needs the body instance "${rig.body}" standing on rig.ground (row ${rig.ground})`);
      if (lowest !== rig.ground) fail(at, `${about} its body must stand on rig.ground (row ${rig.ground}); its lowest pixel is on row ${lowest}`);
    }
  }
  source.animations = animations; source.motionInfo = motionInfo; delete source.motions;
  if (source.poses.length > 256) fail('poses.motions', 'expanded source exceeds 256 poses');
  return source;
}
