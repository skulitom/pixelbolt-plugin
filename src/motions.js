// Motion templates lower to editable poses. Kept separate from rasterization and file I/O.
import { PixelError, fail } from './core.js';
import { sinDeg, cosDeg, rasterizeMass } from './craft.js';

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
const setAngleOf = (part, value) => { delete part.rotate; delete part.reach; delete part.bend; part.angle = ((Math.round(value) + 180) % 360 + 360) % 360 - 180; };
const endPoint = (source, instance, path) => {
  const name = Object.entries(source.parts[instance.part]?.points ?? {}).find(([, p]) => p === 'end')?.[0];
  if (!name) fail(path, 'the last bone needs a named end point, for example points: {end: "end"}');
  return name;
};
export const MOTION_TEMPLATES = ['walk', 'trot', 'run', 'idle', 'jump', 'attack', 'hurt'];

// A four-legged rig's gaits: when each foot lands, as a share of the cycle (near leg first, then far), and the share
// of the cycle each foot is down. The walk is a lateral sequence (near hind, near fore, far hind, far fore), so three
// feet are down most of the time; the trot moves diagonal pairs; the run is a rotary gallop (near hind, far hind, far
// fore, near fore) whose feet are down a quarter of the time, leaving two flights: extended after the hind feet push
// off, gathered after the fore feet do.
const QUAD_GAITS = {
  walk: { hind: [0, .5], fore: [.25, .75], duty: .75 },
  trot: { hind: [0, .5], fore: [.5, 0], duty: .5 },
  run: { hind: [0, .125], fore: [.625, .5], duty: .25 }
};
// In the air a jumping foot is aimed from its hip, [ahead, down] as shares of the leg's height at rest, at take-off,
// rise, apex and fall; near leg first. A biped's second leg trails the first. A four-legged body's fore legs reach
// forward off the ground and fold under the chest at the apex, while its hind legs push off long behind it and tuck
// forward; both pairs reach down again to land, the fore feet a little ahead.
const JUMP_FEET = {
  leg: [[[-.1, 1], [-.2, 1]], [[.05, .75], [-.1, .8]], [[.2, .6], [.05, .65]], [[.15, .85], [0, .9]]],
  fore: [[[.35, .7], [.25, .75]], [[.3, .65], [.2, .7]], [[.1, .55], [0, .6]], [[.3, .95], [.2, .95]]],
  hind: [[[-.3, 1], [-.4, 1]], [[-.35, .8], [-.45, .8]], [[.15, .6], [.05, .65]], [[0, .9], [-.1, .9]]]
};

export function validateRig(rig, height) {
  object(rig, ['ground', 'body', 'chest', 'neck', 'head', 'legs', 'fore', 'hind', 'arms', 'tail', 'rest'], 'poses.rig');
  if (!Number.isInteger(rig.ground) || rig.ground < 0 || rig.ground >= height) fail('poses.rig.ground', 'expected a ground pixel row inside the canvas');
  for (const key of ['body', 'chest', 'neck', 'head', 'rest']) if (rig[key] !== undefined) id(rig[key], `poses.rig.${key}`);
  for (const key of ['legs', 'fore', 'hind', 'arms']) if (rig[key] !== undefined) {
    const pair = key === 'fore' || key === 'hind';
    if (!Array.isArray(rig[key]) || (pair ? rig[key].length !== 2 : rig[key].length > 8)) fail(`poses.rig.${key}`, pair ? 'expected two bone chains: the near leg, then the far one' : 'expected up to eight bone chains');
    rig[key].forEach((chain, i) => {
      if (!Array.isArray(chain) || chain.length < 2 || chain.length > 3) fail(`poses.rig.${key}[${i}]`, 'expected two or three bone instances');
      chain.forEach((name, j) => id(name, `poses.rig.${key}[${i}][${j}]`));
    });
  }
  // A four-legged body names its front legs in fore and its back legs in hind, so the gaits can tell them apart.
  for (const [key, other] of [['fore', 'hind'], ['hind', 'fore']]) if (rig[key] !== undefined && rig[other] === undefined) fail(`poses.rig.${other}`, `a four-legged rig names both pairs: rig.${key} needs rig.${other}`);
  if (rig.fore !== undefined && rig.legs !== undefined) fail('poses.rig.legs', 'a four-legged rig names its legs in rig.fore and rig.hind; leave legs out');
  for (const key of ['chest', 'neck']) if (rig[key] !== undefined && rig.fore === undefined) fail(`poses.rig.${key}`, `${key} is for a four-legged rig, whose gaits turn it; name the legs in rig.fore and rig.hind`);
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
  if (source.animations !== undefined && (!source.animations || typeof source.animations !== 'object' || Array.isArray(source.animations))) fail('poses.animations', 'expected an object of named animations');
  const restSource = { ...source, poses: [rest], animations: { rest: { frames: [rest.name], loop: false } } };
  delete restSource.motions;
  // Generated poses are checked one at a time for planted-foot reach; that needs joints, not the rig.
  const checkSource = { ...restSource }; delete checkSource.rig;
  const restData = compileRest(restSource).metadata.poses[rest.name], instances = new Map(rest.parts.map(p => [p.name, p])), rig = source.rig;
  // What an instance hangs from, turned at rest; a root instance hangs from nothing (never looked up under "undefined").
  const parentAngle = name => instances.get(name).attach ? restData.parts[instances.get(name).attach.part]?.rotate ?? 0 : 0;
  const restAngle = name => (restData.parts[name].rotate ?? 0) - parentAngle(name);
  const requireInstance = (name, path) => { if (!instances.has(name)) fail(path, `unknown rest-pose instance ${name}`); return instances.get(name); };
  const body = requireInstance(rig.body, 'poses.rig.body');
  if (!source.parts[body.part]?.mass) fail('poses.rig.body', 'motion templates need a mass body');
  if (body.attach) fail('poses.rig.body', 'the motion body must be a root instance');
  if (rig.head) requireInstance(rig.head, 'poses.rig.head');
  for (const name of rig.tail ?? []) requireInstance(name, 'poses.rig.tail');
  // A four-legged body pitches: the templates turn the body, and bend the spine by turning the chest against it (a
  // bone standing on the body, which the fore legs hang from); the neck turns back against the chest, so the head
  // stays steadier than the body.
  const quad = rig.fore !== undefined;
  for (const key of ['chest', 'neck']) if (rig[key] !== undefined && !source.parts[requireInstance(rig[key], `poses.rig.${key}`).part]?.bone) fail(`poses.rig.${key}`, 'expected a bone instance');
  if (rig.chest !== undefined && instances.get(rig.chest).attach?.part !== rig.body) fail('poses.rig.chest', `the chest must attach to the body "${rig.body}"`);
  const used = new Set();
  for (const role of ['legs', 'hind', 'fore', 'arms']) for (const [i, chain] of (rig[role] ?? []).entries()) {
    for (const [j, name] of chain.entries()) {
      const path = `poses.rig.${role}[${i}][${j}]`, part = requireInstance(name, path);
      if (used.has(name)) fail(path, 'motion chains cannot share instances'); used.add(name);
      if (!source.parts[part.part]?.bone) fail(path, 'expected a bone instance');
      if (j && (part.attach?.part !== chain[j - 1] || source.parts[instances.get(chain[j - 1]).part].points?.[part.attach.point] !== 'end' || part.at?.some(v => v !== 0))) fail(path, 'chain bones must attach to the preceding end point with zero offset');
    }
    endPoint(source, instances.get(chain.at(-1)), `poses.rig.${role}[${i}]`);
  }
  for (const key of ['chest', 'neck']) if (used.has(rig[key])) fail(`poses.rig.${key}`, 'motion chains cannot share instances');
  // A tail swings on its own springs, so it can't also be a bone the templates turn: the chest, the neck or a limb's.
  // (A legless body may sway as part of its tail.)
  for (const [i, name] of (rig.tail ?? []).entries()) if (used.has(name) || [rig.chest, rig.neck].includes(name)) fail(`poses.rig.tail[${i}]`, `${name} is already a motion role (the chest, the neck or a leg or arm bone); a tail instance swings on its own`);
  // Every leg the templates plant, hind legs first on a four-legged rig: its role, side (0 near, 1 far) and rig path.
  const legChains = quad ? [...rig.hind.map((chain, side) => ({ chain, role: 'hind', side })), ...rig.fore.map((chain, side) => ({ chain, role: 'fore', side }))]
    : (rig.legs ?? []).map((chain, i) => ({ chain, role: 'leg', side: i % 2, index: i }));
  const legs = legChains.map(({ chain, role, side, index }) => {
    const at = `poses.rig.${role === 'leg' ? 'legs' : role}[${index ?? side}]`, last = instances.get(chain.at(-1)), point = endPoint(source, last, at);
    const existing = rest.markers?.find(m => m.part === last.name && m.point === point);
    const marker = existing?.name ?? id(`${last.name}Foot`, at);
    if (!existing && rest.markers?.some(m => m.name === marker)) fail(at, `marker ${marker} is already used for another point`);
    const [x, y] = restData.parts[last.name].points[point];
    // A fore leg's lifted foot folds back at the wrist, which comes forward; a hind leg folds at the hock, which goes back.
    return { last: last.name, point, marker, x, y, hip: restData.parts[chain[0]].joints.start, role, side, bend: role === 'hind' ? 'back' : 'forward' };
  });
  // A foot is a grid part on a leg's end point. One drawn with views, and holding its own angle at rest, rolls: the
  // templates turn it to the view that lifts its toe as it lands on its heel, and to the view that points its toe down
  // as it leaves the ground. A planted ankle stays on rig.ground, so a foot never rolls onto its toe while it is
  // planted: lifting the heel there would bare the end of the shin. A view is the pixel artist's own drawing, so feet
  // without views stay flat rather than turn a small grid into a smear.
  const feet = legs.map(leg => rest.parts.filter(p => p.attach?.part === leg.last && p.attach.point === leg.point && p.angle === undefined
    && !p.rotate && source.parts[p.part]?.rows && source.parts[p.part].views).map(p => p.name));
  // The view that lifts a foot's heel or toe as the figure moves toward forward (1 right, -1 left). A heel rises as a
  // right-pointing foot turns clockwise (views 1–89) and a toe as it turns back (271–359); a flipped foot points the
  // other way. The view nearest the flat foot is used.
  const rollView = (name, forward, side) => {
    const instance = instances.get(name), flip = instance.flipX === true;
    const clockwise = (forward * (flip ? -1 : 1) > 0) === (side === 'heel');
    const keys = Object.keys(source.parts[instance.part].views).map(Number).filter(k => clockwise ? k > 0 && k < 90 : k > 270);
    return keys.length ? clockwise ? Math.min(...keys) : Math.max(...keys) : null;
  };
  const lowest = (rows, anchor) => rows.findLastIndex(row => /[^. ]/.test(row)) - anchor[1];
  // Rolls leg j's feet and returns how much further below the ankle the rolled drawings reach than the flat ones, so a
  // lifted foot can be held up clear of the ground.
  const roll = (parts, j, forward, side) => {
    let deeper = 0;
    for (const name of side ? feet[j] : []) {
      const key = rollView(name, forward, side);
      if (key === null) continue;
      const instance = instances.get(name), definition = source.parts[instance.part], view = definition.views[key];
      parts.get(name).rotate = instance.flipX === true ? -key : key;
      deeper = Math.max(deeper, lowest(view.rows, view.anchor) - lowest(definition.rows, definition.anchor ?? [0, 0]));
    }
    return deeper;
  };
  // Each arm's hand: what hangs from the arm's last bone, with whatever that holds. The rest of the arm is its bones and
  // anything else on them.
  const subtree = roots => {
    const found = new Set(roots);
    for (let changed = true; changed;) { changed = false; for (const p of rest.parts) if (p.attach && found.has(p.attach.part) && !found.has(p.name)) { found.add(p.name); changed = true; } }
    return found;
  };
  const arms = (rig.arms ?? []).map(chain => {
    const hand = subtree(rest.parts.filter(p => p.attach?.part === chain.at(-1)).map(p => p.name));
    return { chain, hand, arm: new Set([...subtree([chain[0]])].filter(name => !hand.has(name))) };
  });
  // Every pixel each instance of a pose draws, in drawing order, as the compiler draws it.
  const drawing = (pose, visit) => {
    const { recipe } = compileRest({ ...checkSource, poses: [pose], animations: { check: { frames: [pose.name], loop: false } } });
    for (const layer of recipe.frames[0].layers) for (const op of layer.ops) recipe.symbols[op.symbol].forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] !== '.' && row[x] !== ' ') visit(`${op.flipX ? op.x + row.length - 1 - x : op.x + x},${op.y + y}`, layer.name);
    });
  };
  // Which instance draws each pixel of a pose: the last to draw it.
  const owners = pose => { const owner = new Map(); drawing(pose, (at, name) => owner.set(at, name)); return owner; };
  // A hand that shows while all of its arm is hidden behind the body floats beside it, as a far hand does when its arm
  // swings forward behind the chest. There the elbow bends further, 15° at a time up to 60°, which brings the hand up
  // with its forearm out in front, or tucks it away; failing that it straightens a little (a runner's bent arm near
  // rest), and then the arm swings back toward rest. The pose's own pixels decide, so every rig is judged as it is drawn.
  const attachHands = (pose, forward) => {
    const byName = new Map(pose.parts.map(p => [p.name, p])), turn = v => ((Math.round(v) + 180) % 360 + 360) % 360 - 180;
    for (const { chain, hand, arm } of arms) {
      const shoulder = byName.get(chain[0]), elbow = byName.get(chain[1]);
      if (!hand.size || shoulder.angle === undefined || elbow.angle === undefined) continue;
      const floats = () => {
        const shown = [], drawn = new Set();
        for (const [at, name] of owners(pose)) { if (hand.has(name)) shown.push(at); else if (arm.has(name)) drawn.add(at); }
        return shown.length > 0 && !shown.some(at => { const [x, y] = at.split(',').map(Number); return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => drawn.has(`${x + dx},${y + dy}`)); });
      };
      if (!floats()) continue;
      const bend = elbow.angle, swing = shoulder.angle, from = turn(restAngle(chain[0])), out = turn(swing - from);
      const tries = [...[15, 30, 45, 60, -15, -30].map(extra => [swing, turn(bend - forward * extra)]), ...[.75, .5, .25, 0].map(share => [turn(from + out * share), bend])];
      const fix = tries.find(([s, e]) => { shoulder.angle = s; elbow.angle = e; return !floats(); }) ?? [swing, bend];
      [shoulder.angle, elbow.angle] = fix;
    }
  };
  // A probe of the named instances of a pose and every part they hang from: where each is placed and turned.
  const probeParts = (pose, wanted) => {
    const byName = new Map(pose.parts.map(p => [p.name, p])), needed = new Set();
    for (const start of wanted) for (let name = start; name && !needed.has(name); name = byName.get(name)?.attach?.part) needed.add(name);
    const probe = { name: pose.name, origin: pose.origin, parts: pose.parts.filter(p => needed.has(p.name)) };
    const probeDefinitions = Object.fromEntries([...new Set(probe.parts.map(p => p.part))].map(name => [name, source.parts[name]]));
    return probeJoints({ ...checkSource, parts: probeDefinitions, poses: [probe], animations: { check: { frames: [pose.name], loop: false } } }).metadata.poses[pose.name].parts;
  };
  // How much of the tail's drawing lies on the rest of the figure, over or under it: a share of the tail's pixels.
  const tailSet = new Set(rig.tail ?? []);
  const tailCover = pose => {
    const tail = new Set(), figure = new Set();
    drawing(pose, (at, name) => (tailSet.has(name) ? tail : figure).add(at));
    let shared = 0;
    for (const at of tail) if (figure.has(at)) shared++;
    return tail.size ? shared / tail.size : 0;
  };
  const tails = tailRig(rig, { instances, restData, restAngle, source, owners, rest, tailCover });
  const generated = [], animations = { ...(source.animations ?? {}) }, motionInfo = {}, groundedPoses = new Map();
  for (const [name, motion] of Object.entries(source.motions)) {
    const path = `poses.motions.${name}`; id(name, path);
    const template = motion?.template;
    if (!MOTION_TEMPLATES.includes(template)) fail(`${path}.template`, `expected ${MOTION_TEMPLATES.join(', ')}`);
    const gait = ['speed', 'stride', 'lift', 'bob', 'lean', 'swapDepth'];
    const fields = { walk: gait, trot: gait, run: [...gait, ...(quad ? ['flex'] : [])], idle: ['breath', 'squash'], jump: ['crouch', 'stretch', 'apex'], attack: ['arm', 'windup', 'strike', 'hold'], hurt: ['recoil', 'squash'] };
    if (template === 'run' && !quad && motion.flex !== undefined) fail(`${path}.flex`, 'flex bends a four-legged spine in its gallop; this rig has no rig.fore and rig.hind');
    object(motion, ['template', 'frames', 'duration', 'follow', ...fields[template]], path);
    const p = (key, fallback, lo, hi, integer = false) => number(motion[key], fallback, lo, hi, `${path}.${key}`, integer);
    // How far the tail swings from its rest angles as it follows through: 0 holds it as drawn, 2 swings it twice as far.
    const follow = p('follow', 1, 0, 2);
    if (motion.follow !== undefined && !tails) fail(`${path}.follow`, 'follow swings the tail; name its instances in rig.tail');
    const duration = p('duration', template === 'idle' ? 200 : 80, 1, 60000, true);
    const locomotion = template === 'walk' || template === 'run' || template === 'trot';
    if (template === 'trot' && !quad) fail(`${path}.template`, 'trot is a four-legged gait: name the legs in rig.fore and rig.hind');
    if (template === 'attack' && !rig.arms?.length) fail(`${path}.template`, 'attack swings an arm from rig.arms, and this rig has none');
    const fixed = { jump: 7, attack: 4, hurt: 2 }, count = p('frames', fixed[template] ?? (template === 'idle' ? 4 : template === 'run' ? 10 : 8), template === 'idle' ? 2 : fixed[template] ?? (template === 'run' ? 6 : 4), fixed[template] ?? (template === 'idle' ? 16 : 64), true);
    if (locomotion && count % 2) fail(`${path}.frames`, `${template} needs an even frame count`);
    if (locomotion && legs.length < 2) fail('poses.rig.legs', 'walk and run need at least two leg chains');
    const speed = locomotion ? p('speed', { walk: 24, trot: 36, run: 48 }[template], -1024, 1024) : 0;
    const stride = locomotion ? p('stride', 10, 1, 64) : 0, lift = locomotion ? p('lift', { walk: 2, trot: 3, run: 4 }[template], 0, 32) : 0;
    // A biped leans into its run; a four-legged body stays level and bends its spine instead.
    const bob = locomotion ? p('bob', 1, 0, 8) : 0, lean = locomotion ? p('lean', template === 'run' && !quad ? 8 : 0, -45, 45, true) : 0;
    const flex = template === 'run' && quad ? p('flex', 10, 0, 30, true) : 0;
    if (motion.swapDepth !== undefined && typeof motion.swapDepth !== 'boolean') fail(`${path}.swapDepth`, 'expected a boolean');
    const swapDepth = motion.swapDepth === true;
    const breath = template === 'idle' ? p('breath', .05, 0, .5) : 0;
    // A grounded squash: the body stretches, then squashes, while its lowest drawn pixel stays on rig.ground. Below
    // 0.05 it would round to no change, since mass squash moves in 0.05 steps. Breath squashes about the body's
    // centre and a planted leg holds the body up, so neither can be combined with it.
    const grounded = template === 'idle' && motion.squash !== undefined, squashBy = grounded ? p('squash', 0, .05, .5) : 0;
    if (grounded && motion.breath !== undefined) fail(`${path}.squash`, 'choose breath or squash, not both: breath squashes the body about its centre, squash keeps its base on rig.ground');
    if (grounded && legs.length) fail(`${path}.squash`, 'squash sits the body on rig.ground, but this rig stands on its legs; use breath');
    // The head bob and the tail's swing move their instances after grounding, so the body can't also play either role.
    if (grounded && rig.head === rig.body) fail('poses.rig.head', `the grounded idle "${name}" keeps the body on rig.ground, so the body can't also be the head, whose bob would lift it; name another instance or leave head out`);
    if (grounded) (rig.tail ?? []).forEach((tail, i) => { if (tail === rig.body) fail(`poses.rig.tail[${i}]`, `the grounded idle "${name}" keeps the body on rig.ground, so the body can't also be part of the tail, whose swing would turn it off the ground`); });
    const crouch = template === 'jump' ? p('crouch', .8, .5, 1) : 1, stretch = template === 'jump' ? p('stretch', 1.15, 1, 2) : 1, apex = template === 'jump' ? p('apex', 4, 1, 32, true) : 0;
    const arm = template === 'attack' ? p('arm', 0, 0, rig.arms.length - 1, true) : 0;
    const windup = template === 'attack' ? p('windup', -130, -360, 360, true) : 0, strike = template === 'attack' ? p('strike', 50, -360, 360, true) : 0;
    const hold = template === 'attack' ? p('hold', 2, 1, 16, true) : 1;
    const recoil = template === 'hurt' ? p('recoil', -20, -90, 90, true) : 0, hurtSquash = template === 'hurt' ? p('squash', .85, .5, 2) : 1;
    const half = count / 2;
    // Short contact phases retain both a planted pair and a flight in compact six-frame runs. A four-legged gait's
    // feet are down for its duty share of the cycle.
    const share = quad && locomotion ? Math.max(1, Math.floor(count * QUAD_GAITS[template].duty)) : template === 'walk' ? Math.ceil(count * .625) : Math.max(2, Math.floor(count / 3));
    const stance = locomotion ? Math.max(1, Math.min(share, Math.floor(stride / Math.max(.000001, Math.abs(speed) * duration / 1000)) + 1)) : 0;
    // The frame each leg's foot lands on: a biped's legs alternate half a cycle apart, a four-legged body's follow its gait.
    const lands = legs.map((leg, j) => quad && locomotion ? Math.round(QUAD_GAITS[template][leg.role][leg.side] * count) % count : (j % 2) * half);
    const phase = (j, i) => (i - lands[j] + count) % count;
    // How far a planted foot travels back under the body in one contact, centred under the hip so the legs reach
    // equally far forward and back. The stance cap above keeps it inside the stride.
    const direction = speed < 0 ? -1 : 1, travel = locomotion ? Math.abs(speed) * (stance - 1) * duration / 1000 : 0;
    const downIndex = Math.max(1, Math.floor(half / 4)), passingIndex = Math.floor(half / 2);
    // A walk's up pose sits as far after passing as down sits before it. Up to twelve frames that is the frame before
    // the next contact, or one from it; in a longer walk the frame before contact is nearly the contact itself.
    const upIndex = template === 'walk' && half > 6 ? 2 * passingIndex - downIndex : half - 1;
    const phaseKeys = [...new Set([0, downIndex, passingIndex, ...(template === 'run' && half >= 5 ? [Math.floor(half * .75)] : []), upIndex])].sort((a, b) => a - b);
    const labels = new Map();
    if (locomotion && quad) {
      // A four-legged gait's key poses are its footfalls, named for the foot that lands (contact-a and contact-b the
      // near and far hind feet, fore-a and fore-b the fore feet; a trot's diagonal pair by its hind foot), and the
      // first frame of each flight: a trot's flight-a and flight-b, a gallop's extended flight after the hind feet push
      // off and its gathered flight after the fore feet do. A trot also keys the pose halfway between its contacts.
      const down = i => legs.filter((_, j) => phase(j, i) < stance);
      legs.forEach((leg, j) => { if (!labels.has(lands[j])) labels.set(lands[j], `${leg.role === 'hind' ? 'contact' : 'fore'}-${'ab'[leg.side]}`); });
      for (let i = 0; i < count; i++) {
        const before = down((i + count - 1) % count);
        if (labels.has(i) || down(i).length || !before.length) continue;
        // A cycle may leave the ground more than once after the same feet (a quick or many-framed gait): the first
        // such flight is its key, and the others stay in-betweens, since pose names are unique.
        const label = template === 'run' ? before.some(leg => leg.role === 'fore') ? 'gathered' : 'extended' : `flight-${before.some(leg => leg.role === 'hind' && leg.side === 0) ? 'a' : 'b'}`;
        if (![...labels.values()].includes(label)) labels.set(i, label);
      }
      if (template === 'trot') for (const [offset, suffix] of [[0, 'a'], [half, 'b']]) if (!labels.has(offset + passingIndex)) labels.set(offset + passingIndex, `passing-${suffix}`);
    }
    // Past four idle frames the rest are in-betweens: the key poses are the quarter phases (rest, full stretch or
    // inhale, rest, full squash or exhale), which the motion review's pose spread compares.
    const keyIndices = locomotion ? quad ? [...labels.keys()].sort((a, b) => a - b) : [...phaseKeys, ...phaseKeys.map(i => i + half)] : template === 'idle' && count > 4 ? [...new Set([0, 1, 2, 3].map(q => Math.round(q * count / 4)))] : Array.from({ length: count }, (_, i) => i);
    if (locomotion && !quad) for (const offset of [0, half]) {
      const suffix = offset ? 'b' : 'a', keys = keyIndices.filter(i => i >= offset && i < offset + half);
      const words = keys.length === 2 ? ['contact', template === 'run' ? 'flight' : 'up'] : keys.length === 3 ? ['contact', 'down', template === 'run' ? 'flight' : 'passing'] : keys.length === 5 ? ['contact', 'down', 'passing', 'up', 'flight'] : ['contact', 'down', 'passing', template === 'run' ? 'flight' : 'up'];
      keys.forEach((index, i) => labels.set(index, `${words[i]}-${suffix}`));
    }
    // Past four frames there are more phases than breathing words, so idle poses are numbered from 0.
    const fixedLabels = { idle: count === 2 ? ['inhale', 'exhale'] : count === 3 ? ['rest', 'inhale', 'exhale'] : count === 4 ? ['rest', 'inhale', 'settle', 'exhale'] : Array.from({ length: count }, (_, i) => `${i}`),
      jump: ['crouch', 'take-off', 'rise', 'apex', 'fall', 'land', 'recover'], attack: ['anticipation', 'strike', 'follow-through', 'recover'], hurt: ['recoil', 'recover'] };
    // Where a walking or running foot is aimed in frame i: planted, travelling back under the hip, or lifted.
    const step = (leg, j, i) => {
      const k = phase(j, i), front = leg.x + direction * travel / 2;
      if (k < stance) return { x: front - speed * k * duration / 1000, y: rig.ground, planted: true };
      // The lifted foot lags behind the hip, then reaches forward to land: it leaves the ground behind the body
      // (kicking further back, toward the stride's rear, when the contact covers less than the stride), passes under
      // the hip tucked up and lands from in front. Its height peaks a third of the way through, so the heel comes up
      // behind and the leg is long again as it reaches.
      const t = (k - stance + 1) / (count - stance + 1), share = Math.min(1, travel / stride);
      const reach = -share + 2 * share * t * t * (1.8 - .8 * t) + (1 - share) * 10 * t * (1 - t) * (2 * t - 1);
      return { x: leg.x + direction * stride / 2 * reach, y: rig.ground - (lift === 0 ? 0 : Math.max(1, Math.round(lift * 6.75 * t * (1 - t) * (1 - t)))), planted: false };
    };
    // The legs' swing as one cycle: the once-a-cycle part of how far the first foot is ahead of the second, as a cosine
    // and sine weight. The arms swing opposite it, so they are furthest out when the legs are furthest apart, even
    // where a run holds its legs apart through flight.
    let legCycle = [1, 0];
    // The front pair sets it: a biped's legs, a four-legged body's fore legs (under a centaur's arms).
    const [first, second] = quad ? [2, 3] : [0, 1];
    if (locomotion) {
      const turns = Array.from({ length: count }, (_, i) => Math.round(i * 360 / count));
      const ahead = turns.map((_, i) => direction * (step(legs[first], first, i).x - step(legs[second], second, i).x));
      const c = ahead.reduce((sum, v, i) => sum + v * cosDeg(turns[i]), 0), s = ahead.reduce((sum, v, i) => sum + v * sinDeg(turns[i]), 0), size = Math.sqrt(c * c + s * s);
      if (size > 1e-9) legCycle = [c / size, s / size];
    }
    // A four-legged body's spine through a gallop: it rocks, the front up as the hind feet land and down as the fore
    // feet do, by half of flex either way, and bends by flex either way, curled most in the gathered flight and
    // stretched out in the extended one. [pitch, bend] in degrees; the other gaits keep the back level.
    const spine = i => {
      if (!quad || template !== 'run') return [0, 0];
      const t = i * 360 / count, hindLands = (lands[0] + lands[1]) / 2 * 360 / count, stretched = (Math.max(lands[0], lands[1]) + stance + Math.min(lands[2], lands[3])) / 2 * 360 / count;
      return [-flex / 2 * cosDeg(t - hindLands), -flex * cosDeg(t - stretched)];
    };
    // Turns a four-legged body: the body pitches, the chest bends against it (half each way about the body's pitch, so
    // the spine curls about its middle) and the neck turns back by half of the chest's turn.
    const pitchBody = (parts, pitch, bend) => {
      const chest = rig.chest !== undefined;
      setAngleOf(parts.get(rig.body), restAngle(rig.body) + direction * (lean + pitch - (chest ? bend / 2 : 0)));
      if (chest) setAngleOf(parts.get(rig.chest), restAngle(rig.chest) + direction * bend);
      if (rig.neck !== undefined) setAngleOf(parts.get(rig.neck), restAngle(rig.neck) - direction * (pitch + (chest ? bend / 2 : 0)) / 2);
    };
    const names = [];
    for (let i = 0; i < count; i++) {
      const pose = structuredClone(rest), label = locomotion ? labels.get(i) ?? `between-${i}` : fixedLabels[template][i];
      pose.name = id(`${name}-${label}`, path); pose.duration = duration;
      pose.origin = [...(rest.origin ?? [0, 0])]; pose.contacts = []; pose.markers = [...(rest.markers ?? [])];
      const parts = new Map(pose.parts.map(p => [p.name, p])), torso = parts.get(rig.body), angle = Math.round(i * 360 / count) + (template === 'idle' && count === 2 ? 90 : 0);
      const setAngle = setAngleOf;
      let dy = 0, bodySquash = 1;
      // A walking or running body's height comes from its legs and the bob, once every pose is made (below).
      if (locomotion && quad) pitchBody(parts, ...spine(i));
      else if (locomotion) { bodySquash = template === 'run' ? (i % half === downIndex ? .9 : i % half === half - 1 ? 1.05 : 1) : 1; setAngle(torso, restAngle(rig.body) + direction * lean); }
      if (template === 'idle') bodySquash = 1 + (grounded ? squashBy : breath) * sinDeg(angle);
      if (template === 'jump' && quad) {
        // A four-legged body crouches with its back curled, rears up with it stretched as the hind legs push off,
        // curls again with the legs tucked at the apex, tips forward reaching for the ground and lands front-down.
        dy = [2, 0, -apex, -apex * 2, -apex, 2, 0][i]; bodySquash = [crouch, stretch, 1.05, 1, 1, crouch, 1][i];
        pitchBody(parts, [0, -12, -8, 0, 8, 4, 0][i], [6, -6, -4, 6, -4, 4, 0][i]);
      } else if (template === 'jump') {
        dy = [2, 0, -apex, -apex * 2, -apex, 2, 0][i]; bodySquash = [crouch, stretch, 1.05, 1, 1, crouch, 1][i];
        // The body leans into the crouch and the landing. The arms swing back as it crouches and forward through the
        // take-off, then ease down through the apex and fall with the forearms coming forward to meet the landing. They
        // stay below the shoulders, where a raised arm would cross the face of a big-headed figure. The far arm swings
        // a little less, so the two don't draw as one.
        setAngle(torso, restAngle(rig.body) + [8, 4, 0, 0, 0, 8, 0][i]);
        for (const [j, chain] of (rig.arms ?? []).entries()) {
          setAngle(parts.get(chain[0]), restAngle(chain[0]) + Math.round([35, -70, -55, -25, -10, -35, 0][i] * (j % 2 ? .85 : 1)));
          setAngle(parts.get(chain[1]), restAngle(chain[1]) - [10, 30, 35, 45, 50, 20, 0][i]);
        }
      }
      // Follow-through carries the swing well past the strike and settles the body, so it reads as its own key pose.
      // windup and strike are angles in the body's frame. An arm that hangs from another part (a chest standing up from
      // the hips) takes them less that part's turn from the body at rest, so the blow goes the same way on either rig.
      if (template === 'attack') {
        const shoulder = rig.arms[arm][0], frame = parentAngle(shoulder) - (restData.parts[rig.body].rotate ?? 0);
        setAngle(parts.get(shoulder), i < 3 ? [windup, strike, strike + 45][i] - frame : restAngle(shoulder)); bodySquash = [.9, 1.05, .95, 1][i]; setAngle(torso, restAngle(rig.body) + [-8, 8, 14, 0][i]);
      }
      // A four-legged body flinches back with its back curled and its head pulled up, rather than tipping over.
      if (template === 'hurt' && quad) { pitchBody(parts, i ? 0 : recoil * .4, i ? 0 : -recoil * .4); bodySquash = i ? 1 : hurtSquash; }
      else if (template === 'hurt') { setAngle(torso, restAngle(rig.body) + (i ? 0 : recoil)); bodySquash = i ? 1 : hurtSquash; }
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
      // Arms swing against the legs: the arm on the leading leg's side is furthest back when the legs are furthest
      // apart, and the arms pass the body when the legs do. An elbow bends as its arm comes forward; a runner's stays
      // bent.
      if (locomotion) for (const [j, chain] of (rig.arms ?? []).entries()) {
        const swing = legCycle[0] * cosDeg(angle + j % 2 * 180) + legCycle[1] * sinDeg(angle + j % 2 * 180);
        setAngle(parts.get(chain[0]), restAngle(chain[0]) + direction * (template === 'run' ? 35 : 25) * swing);
        setAngle(parts.get(chain[1]), restAngle(chain[1]) - direction * ((template === 'run' ? 40 : 0) + 20 * Math.max(0, -swing)));
      }
      for (const [j, leg] of legs.entries()) {
        const last = parts.get(leg.last);
        delete last.angle; delete last.rotate;
        let x = leg.x, y = rig.ground, planted = true;
        if (locomotion) {
          ({ x, y, planted } = step(leg, j, i));
          // The heel strikes with the toe up, and the toe trails down as the foot leaves the ground.
          const k = phase(j, i), deeper = roll(parts, j, direction, k === 0 ? 'toe' : k === stance ? 'heel' : null);
          if (!planted) y = Math.min(y, rig.ground - deeper);
        } else if (template === 'jump' && i > 0 && i < 5) {
          // In the air the feet are aimed from the hip, a share of the leg's length at rest: pushed off and long at
          // take-off, tucked up under the body (the knees forward) at the apex, and reaching down again to land
          // (JUMP_FEET). The toes point down as they leave the ground. A four-legged body's fore feet are already up as
          // its hind feet push off.
          planted = false;
          const span = leg.y - leg.hip[1], [ahead, down] = JUMP_FEET[leg.role][i - 1][leg.side];
          x = leg.x + direction * ahead * span;
          y = Math.min(i === 1 && leg.role !== 'fore' ? rig.ground - 1 : leg.hip[1] + dy + down * span, rig.ground - roll(parts, j, direction, i < 3 ? 'heel' : null));
        }
        // A planted fore leg gives at the elbow, which points back; a lifted one folds at the wrist, which comes forward.
        // A bend is a side of the canvas, so a figure facing left (negative speed) bends the other way.
        const bend = leg.role === 'fore' && planted ? 'back' : leg.bend;
        last.reach = [Math.round(x), Math.round(y)]; last.bend ??= direction < 0 ? bend === 'forward' ? 'back' : 'forward' : bend;
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
        for (const chains of [rig.legs ?? [], rig.hind ?? [], rig.fore ?? [], rig.arms ?? []]) for (let j = 0; j + 1 < chains.length; j += 2) {
          const a = subtree([chains[j][0]]), b = subtree([chains[j + 1][0]]);
          const aParts = pose.parts.filter(p => a.has(p.name)), bParts = pose.parts.filter(p => b.has(p.name));
          pose.parts = pose.parts.flatMap(p => a.has(p.name) ? p === aParts[0] ? bParts : [] : b.has(p.name) ? p === bParts[0] ? aParts : [] : [p]);
        }
      }
      generated.push(pose); names.push(pose.name);
      if (grounded) groundedPoses.set(pose.name, name);
    }
    // A bob or lean must never lift a hip beyond its leg: a planted foot that misses its target floats and slides.
    // sink finds how far a pose must sink: at most four pixels, while that reduces its planted feet's miss.
    // Only the chosen leg chains and what they hang from decide where their feet land; place compiles just those.
    const place = (pose, chosen) => probeParts(pose, chosen.map(leg => leg.last));
    const sink = pose => {
      const plantedLegs = legs.filter(leg => pose.contacts.includes(leg.marker));
      if (!plantedLegs.length) return 0;
      const miss = () => {
        const placed = place(pose, plantedLegs);
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
    // A lifted foot only says where the leg reaches. Where the body has risen a little past it, as in flight, the leg
    // straightens toward it, and that is where the foot is drawn: aim it there. A miss of more than two pixels is a
    // stride or lift the legs can't make, and stays a warning.
    const aimLifted = pose => {
      const lifted = legs.filter(leg => !pose.contacts.includes(leg.marker)), placed = lifted.length ? place(pose, lifted) : null;
      for (const leg of lifted) if (placed[leg.last].reach?.unreachable && placed[leg.last].reach.error <= 2) pose.parts.find(p => p.name === leg.last).reach = [...placed[leg.last].joints.end];
    };
    const motionPoses = generated.slice(-count);
    let lowered = 0;
    if (locomotion) {
      // A walking or running body rides its legs: each pose sinks only as far as its planted feet need, so a planted
      // leg is long under the body and at a contact both legs are nearly straight. The bob is then the dip just after
      // each contact, as the knees take the weight, and in a run the rise through flight.
      motionPoses.forEach((pose, i) => {
        pose.origin[1] += sink(pose) + (i % half === downIndex ? bob : pose.contacts.length ? 0 : -bob);
        aimLifted(pose);
      });
    } else {
      // The other templates lower every pose by the deepest sink, so the motion keeps its shape and no frame dips alone.
      // A foot in the air keeps its target, which never lies below rig.ground. A four-legged body pitches as it jumps,
      // carrying its hips and shoulders away from where its feet were aimed, so its lifted feet are aimed as in a run.
      lowered = Math.max(...motionPoses.map(sink));
      if (lowered) for (const pose of motionPoses) pose.origin[1] += lowered;
      if (quad && template === 'jump') motionPoses.forEach(aimLifted);
    }
    const playback = template === 'attack' ? [names[0], ...Array(hold).fill(names[1]), ...names.slice(2)] : names, loop = locomotion || template === 'idle';
    if (tails) followTails(tails, motionPoses, { playback, loop, duration, speed, template, follow, lowered, probeParts });
    if (locomotion || template === 'jump') for (const pose of motionPoses) attachHands(pose, direction);
    if (Object.hasOwn(animations, name)) fail(`${path}`, 'the generated animation name is already authored; choose another motion name');
    animations[name] = { frames: playback, loop };
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

// Tails follow through. Each rig.tail instance is a rod hung from its attach point on a damped spring that holds its
// rest angle, relative to what it hangs from, so a still figure's tail hangs exactly as drawn. The attach point's
// motion turns it: when the body sets off, stops or falls, the rod's inertia and the air acting on it turn it about the
// attach point, and the spring brings it back. A link on another tail link hangs from that link's moving end, so each
// link lags the one before it; its bend is stiffer and more damped than the hinge on the figure, so a tail curves as
// one piece rather than cracking like a whip. A walk or run carries the figure through still air at its speed, so the
// tail trails, further the faster it goes, and flutters with the bob; a body falling through the air lifts it and a
// landing drops it; a strike flings it back and it whips through past rest; an idle sways it from the root. When the
// body leans or turns, gravity keeps the tail hanging a little nearer to where it hung.
//
// Units are the figure's own: gravity is in body sizes a second² (a size is the longer side of the rest drawing, the
// tail left out) and a link's spring is set against gravity over its own length, so a rig drawn twice as large moves
// the same and a long cape swings slower than a short scarf. The poses are keys on one smooth path that never
// overshoots them (it holds still where the body holds or turns back), so the body's whole-pixel steps don't jolt the
// tail. Each drawing shows the tail as it is halfway through the time the drawing is shown. Angles are degrees,
// clockwise; the spring is stepped in fixed substeps with only + − × ÷, sqrt and craft trigonometry, and rounded to
// whole degrees once, at the end. A loop's cycle runs again until it repeats, so its first frame follows its last; a
// one-shot starts a frame before its first, from the rest pose, still.
const TAIL = Object.freeze({
  gravity: 12, // body sizes a second²
  drag: 18, // per second: how quickly still air would bring a link to rest
  inertia: .4, // the share of its attach point's starts and stops a link feels (a rigid rod feels them all)
  stiffness: 2.5, // the spring's pull, against the most turn gravity gives the link held level
  damping: .3, // of critical damping, against turning relative to what the link hangs from
  swing: 50, // degrees a link hung from the figure swings from rest before its spring stiffens
  spin: .3, // the air's drag on a link's own turning, as a share of drag
  bend: 25, // degrees a link bends from the link it hangs from before its spring stiffens
  bendStiffness: 6, // a bend's spring against a hinge's on the figure: a tail curves as one piece rather than whips
  bendDamping: .6, // of critical damping, against bending
  sway: 10, // degrees an idle swings a tail's rest angle at the figure, each way
  cover: .2, // the share of its pixels more than at rest that a tail may lay on the figure
  inward: 5, // degrees a link may turn toward the figure before its pixels are checked
  step: 4, // milliseconds per substep at most
  passes: 64 // a loop's cycles at most, while it settles
});
const RADIAN = 180 / Math.PI;
const wrapDegrees = v => ((v + 180) % 360 + 360) % 360 - 180;

// The tail links of a rig with their rest geometry, parents first, or null when the rig has none. tailCover measures
// how much of a pose's tail lies on the rest of its figure.
function tailRig(rig, { instances, restData, restAngle, source, owners, rest, tailCover }) {
  const names = [...new Set(rig.tail ?? [])];
  if (!names.length) return null;
  const set = new Set(names), order = [];
  while (order.length < names.length) for (const name of names) {
    const parent = instances.get(name).attach?.part;
    if (!order.includes(name) && (!set.has(parent) || order.includes(parent))) order.push(name);
  }
  // The figure's size: the longer side of the box round its rest drawing, the tail left out, so a long low animal is
  // as large as a tall one.
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [at, name] of owners(rest)) if (!set.has(name)) {
    const [x, y] = at.split(',').map(Number);
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  }
  const size = Math.max(8, box[2] - box[0] + 1, box[3] - box[1] + 1);
  // How far a part reaches from its anchor: a bone's length, a grid's farthest drawn pixel, half a mass's size.
  const reach = definition => {
    if (definition.bone) return definition.bone.length;
    if (definition.mass) return Math.max(...definition.mass.size) / 2;
    const [ax, ay] = definition.anchor ?? [0, 0];
    let far = 0;
    definition.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] !== '.' && row[x] !== ' ') far = Math.max(far, (x - ax) * (x - ax) + (y - ay) * (y - ay)); });
    return Math.sqrt(far);
  };
  const links = order.map(name => {
    const instance = instances.get(name), placed = restData.parts[name], host = instance.attach?.part ?? null, parent = set.has(host) ? host : null;
    return { name, host, parent: parent ? order.indexOf(parent) : -1, rel: restAngle(name), world: placed.rotate ?? 0, length: Math.max(1, reach(source.parts[instance.part])),
      offset: parent && [placed.anchor[0] - restData.parts[parent].anchor[0], placed.anchor[1] - restData.parts[parent].anchor[1]],
      restAnchor: placed.anchor, restHost: host === null ? 0 : restData.parts[host]?.rotate ?? 0 };
  });
  // Which way each link hung from the figure turns toward it: the way that lays more of the tail on it.
  for (const link of links.filter(l => l.parent < 0)) {
    const turned = by => {
      const pose = structuredClone(rest), part = pose.parts.find(p => p.name === link.name);
      delete part.rotate; part.angle = wrapDegrees(Math.round(link.rel + by));
      return tailCover(pose);
    };
    const out = turned(20), back = turned(-20);
    link.inward = out > back ? 1 : back > out ? -1 : 0;
  }
  return { links, gravity: TAIL.gravity * size, cover: tailCover, restCover: tailCover(rest) };
}

// Tangents of a smooth path through evenly spaced keys that never overshoots them (Steffen's monotone cubic): flat
// where the motion holds or turns back. `steps[k]` is the change from key k to the next; a loop's last step returns to
// the first key. A one-shot's path starts and ends still.
function tangents(steps, loop) {
  const count = loop ? steps.length : steps.length + 1, sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
  return Array.from({ length: count }, (_, k) => {
    if (!loop && (k === 0 || k === count - 1)) return 0;
    const a = steps[(k - 1 + steps.length) % steps.length], b = steps[k % steps.length];
    return (sign(a) + sign(b)) * Math.min(Math.abs(a), Math.abs(b), Math.abs(a + b) / 4);
  });
}

// Turns each tail link of a motion's poses, once they have sunk onto their legs, to where its spring has carried it.
// `playback` is the motion's displayed frames (a held strike repeats), each `duration` ms; `follow` scales every link's
// swing from its rest angle (0 holds the tail as drawn); `lowered` is how far a one-shot's poses sank.
function followTails({ links, gravity, cover, restCover }, poses, { playback, loop, duration, speed, template, follow, lowered, probeParts }) {
  const roots = links.filter(l => l.parent < 0), byPose = new Map(poses.map(pose => [pose.name, pose]));
  const setAngles = (pose, angles) => links.forEach((link, i) => setAngleOf(pose.parts.find(p => p.name === link.name), angles[i]));
  if (!follow) { for (const pose of poses) setAngles(pose, links.map(l => wrapDegrees(Math.round(l.rel)))); return; }
  const keyOf = new Map(poses.map(pose => {
    const placed = probeParts(pose, roots.map(l => l.name));
    return [pose.name, roots.map(l => ({ at: placed[l.name].anchor, host: l.host === null ? 0 : placed[l.host]?.rotate ?? 0 }))];
  }));
  const restKey = roots.map(l => ({ at: [l.restAnchor[0], l.restAnchor[1] + lowered], host: l.restHost }));
  // What a root link hangs from turns from key to key the short way, never round past 0°.
  const keys = (loop ? playback.map(name => keyOf.get(name)) : [restKey, ...playback.map(name => keyOf.get(name)), keyOf.get(playback.at(-1))]).map(key => key.map(at => ({ ...at })));
  for (let j = 1; j < keys.length; j++) keys[j].forEach((at, r) => { at.host = keys[j - 1][r].host + wrapDegrees(at.host - keys[j - 1][r].host); });
  const shown = loop ? playback : [null, ...playback, null], seconds = duration / 1000, steps = Math.max(1, Math.ceil(duration / TAIL.step)), h = seconds / steps;
  const travel = speed * seconds, period = playback.length * seconds;
  // Each root link's attach point, carried on by the walk's travel, and the angle of what it hangs from, along the path.
  const paths = roots.map((_, r) => {
    const d = [[], [], []];
    for (let j = 0; j < (loop ? keys.length : keys.length - 1); j++) {
      const a = keys[j][r], b = keys[(j + 1) % keys.length][r];
      d[0].push(b.at[0] - a.at[0] + (loop ? travel : 0)); d[1].push(b.at[1] - a.at[1]); d[2].push(wrapDegrees(b.host - a.host));
    }
    return { d, m: d.map(change => tangents(change, loop)) };
  });
  const along = (r, j, u) => {
    const { d, m } = paths[r], next = (j + 1) % m[0].length;
    const rate = c => ((3 * u * u - 4 * u + 1) * m[c][j] + (6 * u - 6 * u * u) * d[c][j] + (3 * u * u - 2 * u) * m[c][next]) / seconds;
    return { v: [rate(0), rate(1)], spin: rate(2), host: keys[j][r].host + (u * u * u - 2 * u * u + u) * m[2][j] + (3 * u * u - 2 * u * u * u) * d[2][j] + (u * u * u - u * u) * m[2][next] };
  };
  const omega = links.map(l => Math.sqrt((l.parent < 0 ? 1 : TAIL.bendStiffness) * TAIL.stiffness * 1.5 * gravity / l.length)), turnOf = links.map(l => RADIAN * 1.5 / l.length);
  const sway = template === 'idle' ? TAIL.sway : 0;
  // The substep halfway through each drawing's time on screen (a held strike's whole hold).
  const takeAt = new Map();
  for (let j = 0; j < keys.length; j++) if (shown[j] !== null && shown[j] !== shown[j - 1] && ![...takeAt.values()].includes(shown[j])) {
    let run = 1;
    while (shown[j + run] === shown[j]) run++;
    takeAt.set(j * steps + Math.round(run * steps / 2), shown[j]);
  }
  // The drawn angles of every link in each pose, an idle's sway timed `phase` degrees into its cycle.
  const simulate = phase => {
    const state = links.map(l => ({ angle: l.world, spin: 0, v: [0, 0] })), samples = new Map();
    if (loop) links.forEach((l, i) => {
      const r = roots.indexOf(l);
      state[i].angle = (r >= 0 ? keys[0][r].host : state[l.parent].angle) + l.rel;
      if (r >= 0) state[i].v = along(r, keys.length - 1, 1).v;
    });
    // One pass over the keys: segment j runs from key j to the next (in a loop, the last returns to the first).
    const pass = record => {
      for (let j = 0, substep = 0; j < keys.length - (loop ? 0 : 1); j++) for (let n = 0; n < steps; n++) {
        const u = (n + 1) / steps, swing = sway * sinDeg(phase + 360 * (j * steps + n + 1) * h / period);
        for (const [i, link] of links.entries()) {
          const s = state[i];
          let v, base, baseSpin;
          if (link.parent < 0) ({ v, host: base, spin: baseSpin } = along(roots.indexOf(link), j, u));
          else {
            // The parent link's end turns with it: its speed is the parent's attach point's plus that turn.
            const p = state[link.parent], turn = p.angle - links[link.parent].world, c = cosDeg(turn), sn = sinDeg(turn), w = p.spin / RADIAN;
            const ox = c * link.offset[0] - sn * link.offset[1], oy = sn * link.offset[0] + c * link.offset[1];
            v = [p.v[0] - w * oy, p.v[1] + w * ox]; base = p.angle; baseSpin = p.spin;
          }
          // What turns the rod over the substep, at its middle: the change in gravity's pull as what it hangs from turns,
          // the attach point's change of speed and the air's drag toward still air, all across the rod. The spring and
          // both dampings are taken at the substep's end, so any stiffness is stable. An idle swings the rest angle a
          // link holds on the figure, as an animal sways its tail, and the links beyond it follow.
          const target = base + link.rel + (link.parent < 0 ? swing : 0), w = omega[i], z = 2 * (link.parent < 0 ? TAIL.damping : TAIL.bendDamping) * w, off = s.angle - target;
          const stiff = w * w * (1 + off * off / (link.parent < 0 ? TAIL.swing * TAIL.swing : TAIL.bend * TAIL.bend));
          const fx = -TAIL.inertia * (v[0] - s.v[0]) - TAIL.drag * h * v[0], fy = -TAIL.inertia * (v[1] - s.v[1]) - TAIL.drag * h * v[1];
          const kick = turnOf[i] * (h * gravity * (cosDeg(target) - cosDeg(link.world)) + cosDeg(s.angle) * fy - sinDeg(s.angle) * fx);
          s.spin = (s.spin + kick - h * stiff * off + h * z * baseSpin) / (1 + h * (z + TAIL.spin * TAIL.drag) + h * h * stiff);
          s.angle += h * s.spin; s.v = v;
        }
        const name = takeAt.get(++substep);
        if (record && name !== undefined && !samples.has(name)) samples.set(name, state.map(s => s.angle));
      }
    };
    if (loop) for (let n = 0; n < TAIL.passes; n++) {
      const before = state.map(s => [s.angle, s.spin]);
      pass(false);
      if (state.every((s, i) => Math.abs(wrapDegrees(s.angle - before[i][0])) < .01 && Math.abs(s.spin - before[i][1]) < .5)) break;
    }
    pass(true);
    // Each link's swing from its rest angle on what it hangs from, scaled by follow.
    return new Map([...samples].map(([name, angles]) => [name, links.map((link, i) => {
      const from = link.parent < 0 ? keyOf.get(name)[roots.indexOf(link)].host : angles[link.parent];
      return wrapDegrees(Math.round(link.rel + follow * wrapDegrees(angles[i] - from - link.rel)));
    })]));
  };
  let drawn = simulate(0);
  if (sway) {
    // A sway has no time of its own. An idle's starts with the loop, unless a link's step across the seam would then
    // outdo its steps inside the loop (the motion review's loop check); then, of 24 timings, it takes the one that
    // moves the tail most at its stillest step with the seam passing, or failing that the smallest seam step.
    const judge = angles => {
      const world = links.map((_, i) => playback.map(name => { let angle = 0; for (let k = i; k >= 0; k = links[k].parent) { angle += angles.get(name)[k]; if (links[k].parent < 0) angle += keyOf.get(name)[roots.indexOf(links[k])].host; } return angle; }));
      const step = (i, k) => Math.abs(wrapDegrees(world[i][(k + 1) % playback.length] - world[i][k]));
      const room = Math.min(...links.map((_, i) => Math.max(...playback.slice(1).map((_, k) => step(i, k))) - step(i, playback.length - 1)));
      return { room, stillest: Math.min(...playback.map((_, k) => links.reduce((sum, link, i) => sum + step(i, k) * link.length, 0))) };
    };
    let best = judge(drawn);
    for (let phase = 15, search = best.room < 0; search && phase < 360; phase += 15) {
      const angles = simulate(phase), score = judge(angles);
      if (best.room < 0 ? score.room > best.room : score.room >= 0 && score.stillest > best.stillest) [best, drawn] = [score, angles];
    }
  }
  for (const [name, angles] of drawn) setAngles(byPose.get(name), angles);
  // A tail never swings into the figure: where a link hung from the figure turns toward it and more of the tail then
  // lies on the figure than at rest, every link is eased back toward its rest angle a quarter at a time. The pose's
  // own pixels decide.
  for (const name of drawn.keys()) {
    const pose = byPose.get(name), swung = links.map(l => pose.parts.find(p => p.name === l.name).angle);
    const inward = links.some((l, i) => { const by = wrapDegrees(swung[i] - l.rel); return l.parent < 0 && (l.inward ? by * l.inward > TAIL.inward : Math.abs(by) > TAIL.inward); });
    if (!inward || cover(pose) <= restCover + TAIL.cover) continue;
    for (const share of [.75, .5, .25, 0]) {
      setAngles(pose, links.map((l, i) => wrapDegrees(Math.round(l.rel + wrapDegrees(swung[i] - l.rel) * share))));
      if (cover(pose) <= restCover + TAIL.cover) break;
    }
  }
}
