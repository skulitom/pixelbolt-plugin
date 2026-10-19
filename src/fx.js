// Particle effects compiled to ordinary, editable recipes, after Pixel Composer's particle system. A pixelforge-fx
// source names effects; each simulates seeded emitters frame by frame and bakes every frame into stamp, grid and
// line operations on the source's own symbols. The result inspects, patches and exports like any other version-1
// recipe, and editing a symbol in it updates every particle drawn with it. Browser-compatible and deterministic:
// seeded hashing and polynomial trigonometry, no Math.random.
import { PixelError, parseColor, renderProject } from './core.js';
import { fields, point } from './authoring.js';
import { patternProblem, ditherThreshold, traceLine, random, sinDeg, cosDeg } from './craft.js';

const fail = (path, message) => { throw new PixelError(path, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) fail(path, 'expected a name of letters, digits, hyphens or underscores, starting with a letter');
  return value;
};
const number = (value, path, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a number from ${min} to ${max}`);
  return value;
};
const integer = (value, path, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value;
};
// A number, or [min, max] sampled per particle.
const range = (value, path, min, max, whole = false) => {
  const check = whole ? integer : number;
  if (Array.isArray(value)) {
    if (value.length !== 2) fail(path, 'expected a number or [min, max]');
    const [a, b] = [check(value[0], `${path}[0]`, min, max), check(value[1], `${path}[1]`, min, max)];
    if (a > b) fail(path, 'min must not exceed max');
    return [a, b];
  }
  const v = check(value, path, min, max);
  return [v, v];
};
const pair = (value, path, min, max) => {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'expected [x, y]');
  return [number(value[0], `${path}[0]`, min, max), number(value[1], `${path}[1]`, min, max)];
};
const pick = ([a, b], r) => a + (b - a) * r;
const pickWhole = ([a, b], r) => a + Math.min(b - a, Math.floor(r * (b - a + 1)));
// Salts keep each sampled property independent, so changing one range does not reshuffle the others.
const SALT = { x: 1, y: 2, angle: 3, speed: 4, life: 5, variant: 6, remap: 7, phase: 8, offset: 9 };
const LIMITS = { effects: 64, emitters: 16, spawned: 4096, alive: 1024, operations: 20000 };

function readEmitter(emitter, path, context) {
  fields(emitter, ['name', 'at', 'area', 'burst', 'rate', 'start', 'end', 'life', 'angle', 'speed', 'gravity', 'drag', 'attract', 'sway', 'floor', 'bounce', 'shapes', 'play', 'remaps', 'trail', 'dissolve', 'pattern'], path);
  const { frames, symbols, palette, loop, seed } = context;
  if (emitter.name !== undefined) identifier(emitter.name, `${path}.name`);
  if ((emitter.burst === undefined) === (emitter.rate === undefined)) fail(path, 'use exactly one of burst (particles at start) or rate (particles per frame)');
  const start = integer(emitter.start ?? 0, `${path}.start`, 0, frames - 1);
  if (emitter.end !== undefined && emitter.rate === undefined) fail(`${path}.end`, 'end applies to rate emitters');
  const end = integer(emitter.end ?? frames, `${path}.end`, start + 1, frames);
  if (!Array.isArray(emitter.shapes) || !emitter.shapes.length || emitter.shapes.length > 64) fail(`${path}.shapes`, 'expected 1–64 symbol names (one sequence) or lists of them (variants picked per particle)');
  const nested = Array.isArray(emitter.shapes[0]);
  const variants = (nested ? emitter.shapes : [emitter.shapes]).map((sequence, v) => {
    const sp = nested ? `${path}.shapes[${v}]` : `${path}.shapes`;
    if (!Array.isArray(sequence) || !sequence.length || sequence.length > 64) fail(sp, 'expected a list of 1–64 symbol names');
    return sequence.map((name, i) => {
      if (typeof name !== 'string' || !Object.hasOwn(symbols, name)) fail(`${sp}[${i}]`, `unknown symbol ${JSON.stringify(name)}`);
      return name;
    });
  });
  const play = emitter.play ?? 'life';
  if (!['life', 'loop', 'once'].includes(play)) fail(`${path}.play`, 'expected life (spread over the lifetime), loop (one per frame, cycling) or once (one per frame, holding the last)');
  const life = emitter.life === undefined ? null : range(emitter.life, `${path}.life`, 1, 256, true);
  if (loop && !life) fail(`${path}.life`, 'looping effects need a finite life so the loop can repeat seamlessly');
  if (emitter.dissolve !== undefined && !life) fail(`${path}.dissolve`, 'dissolve needs a finite life');
  const remaps = emitter.remaps === undefined ? [] : emitter.remaps;
  if (!Array.isArray(remaps) || remaps.length > 64) fail(`${path}.remaps`, 'expected at most 64 remaps, one picked per particle');
  remaps.forEach((remap, r) => {
    if (!isObject(remap)) fail(`${path}.remaps[${r}]`, 'expected a map of grid characters to colours');
    for (const [char, color] of Object.entries(remap)) {
      if (char.length !== 1 || char === '.' || char === ' ') fail(`${path}.remaps[${r}]`, 'remap keys are single grid characters other than dot or space');
      parseColor(color, palette, `${path}.remaps[${r}].${char}`);
    }
  });
  let trail = null;
  if (emitter.trail !== undefined) {
    fields(emitter.trail, ['color', 'length'], `${path}.trail`);
    parseColor(emitter.trail.color, palette, `${path}.trail.color`);
    trail = { color: emitter.trail.color, length: integer(emitter.trail.length ?? 2, `${path}.trail.length`, 1, 16) };
  }
  let attract = null;
  if (emitter.attract !== undefined) {
    fields(emitter.attract, ['at', 'strength'], `${path}.attract`);
    attract = { at: pair(emitter.attract.at, `${path}.attract.at`, -4096, 4096), strength: number(emitter.attract.strength ?? 0.5, `${path}.attract.strength`, -8, 8) };
  }
  let sway = null;
  if (emitter.sway !== undefined) {
    fields(emitter.sway, ['amplitude', 'period'], `${path}.sway`);
    sway = { amplitude: pair(emitter.sway.amplitude, `${path}.sway.amplitude`, 0, 32), period: number(emitter.sway.period ?? 8, `${path}.sway.period`, 1, 256) };
  }
  if (emitter.bounce !== undefined && emitter.floor === undefined) fail(`${path}.bounce`, 'bounce applies at a floor');
  // The dissolve pattern takes the same forms as the dither operation: a Bayer name, noise (ordered by the effect's
  // seed) or a matrix of ranks.
  const pattern = emitter.pattern ?? 'bayer4', problem = patternProblem(pattern);
  if (problem) fail(`${path}.pattern${problem[0]}`, problem[1]);
  if (emitter.pattern !== undefined && emitter.dissolve === undefined) fail(`${path}.pattern`, 'pattern shapes the dissolve; set dissolve too');
  const area = emitter.area === undefined ? [1, 1] : point(emitter.area, `${path}.area`);
  if (area.some(n => n < 1 || n > 256)) fail(`${path}.area`, 'expected a spawn box from 1 to 256 pixels per side');
  return {
    name: emitter.name, at: pair(emitter.at, `${path}.at`, -4096, 4096), area, start, end, variants, play, life, remaps, trail, attract, sway,
    burst: emitter.burst === undefined ? null : integer(emitter.burst, `${path}.burst`, 1, 1024),
    rate: emitter.rate === undefined ? null : number(emitter.rate, `${path}.rate`, 0.001, 64),
    angle: range(emitter.angle ?? [0, 360], `${path}.angle`, -3600, 3600),
    speed: range(emitter.speed ?? 0, `${path}.speed`, 0, 64),
    gravity: emitter.gravity === undefined ? [0, 0] : pair(emitter.gravity, `${path}.gravity`, -8, 8),
    drag: number(emitter.drag ?? 0, `${path}.drag`, 0, 1),
    floor: emitter.floor === undefined ? null : integer(emitter.floor, `${path}.floor`, -4096, 4096),
    bounce: number(emitter.bounce ?? 0, `${path}.bounce`, 0, 1),
    dissolve: emitter.dissolve === undefined ? 0 : number(emitter.dissolve, `${path}.dissolve`, 0, 1),
    threshold: ditherThreshold(pattern, [0, 0], seed)
  };
}

// Simulates one effect and returns its frames' operations plus counts for the metadata.
function simulate(effect, context) {
  const { frames, loop, seed, emitters } = effect, { width, height, symbols } = context;
  // A loop warms up for as many whole cycles as the longest life, with spawns keyed by their frame within the cycle,
  // so the particles in flight at frame 0 are exactly those still alive at the end.
  const warmup = loop ? Math.ceil(Math.max(...emitters.map(e => e.life[1])) / frames) : 0, total = (warmup + 1) * frames;
  const alive = [], output = Array.from({ length: frames }, () => []), stats = emitters.map(e => ({ ...(e.name && { name: e.name }), spawned: 0, maxAlive: 0 }));
  let operations = 0, culled = 0;
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  for (let t = 0; t < total; t++) {
    const cycle = t % frames, drawing = t >= warmup * frames;
    emitters.forEach((e, index) => {
      let count = 0;
      if (e.burst !== null) count = cycle === e.start ? e.burst : 0;
      else if (cycle >= e.start && cycle < e.end) { const c = cycle - e.start; count = Math.floor((c + 1) * e.rate + 1e-9) - Math.floor(c * e.rate + 1e-9); }
      const key = loop ? cycle : t;
      for (let k = 0; k < count; k++) {
        const r = salt => random(seed, index, key, k, salt), angle = pick(e.angle, r(SALT.angle)), speed = pick(e.speed, r(SALT.speed));
        const life = e.life ? pickWhole(e.life, r(SALT.life)) : Infinity, variant = e.variants[Math.min(e.variants.length - 1, Math.floor(r(SALT.variant) * e.variants.length))];
        alive.push({
          emitter: e, index, born: t, life, variant, age: 0,
          x: e.at[0] + (r(SALT.x) - 0.5) * (e.area[0] - 1), y: e.at[1] + (r(SALT.y) - 0.5) * (e.area[1] - 1),
          vx: cosDeg(angle) * speed, vy: sinDeg(angle) * speed,
          remap: e.remaps.length ? e.remaps[Math.min(e.remaps.length - 1, Math.floor(r(SALT.remap) * e.remaps.length))] : null,
          phase: r(SALT.phase) * 360, offset: Math.floor(r(SALT.offset) * 64), trail: []
        });
        if (drawing) stats[index].spawned++;
      }
    });
    if (alive.length > LIMITS.alive) fail(context.path, `more than ${LIMITS.alive} particles are alive at once; lower burst, rate or life`);
    if (drawing) emitters.forEach((e, index) => { stats[index].maxAlive = Math.max(stats[index].maxAlive, alive.filter(p => p.index === index).length); });
    // Draw every live particle, oldest first, at its rounded (and swayed) position. Particles partly off the canvas are
    // cropped into grid operations and trails keep only their on-canvas pixels, so nothing clips.
    for (const p of alive) {
      const e = p.emitter, sway = e.sway;
      const sx = sway ? sway.amplitude[0] * sinDeg(360 * p.age / sway.period + p.phase) : 0, sy = sway ? sway.amplitude[1] * cosDeg(360 * p.age / sway.period + p.phase) : 0;
      const X = Math.floor(p.x + sx + 0.5), Y = Math.floor(p.y + sy + 0.5);
      p.trail.push([X, Y]);
      if (p.trail.length > 17) p.trail.shift();
      if (!drawing) continue;
      const ops = output[t - warmup * frames], span = Number.isFinite(p.life) ? p.life : frames - (p.born - warmup * frames);
      const sequence = p.variant, step = e.play === 'loop' ? (p.age + p.offset) % sequence.length : e.play === 'once' ? Math.min(p.age, sequence.length - 1) : Math.min(sequence.length - 1, Math.floor(p.age / span * sequence.length));
      const symbol = sequence[step], rows = symbols[symbol], w = rows[0].length, h = rows.length, left = X - Math.floor(w / 2), top = Y - Math.floor(h / 2);
      if (e.trail) {
        const [fromX, fromY] = p.trail[Math.max(0, p.trail.length - 1 - e.trail.length)];
        const pixels = [];
        if (fromX !== X || fromY !== Y) traceLine(fromX, fromY, X, Y, (x, y) => pixels.push([x, y]));
        const visible = pixels.filter(([x, y]) => inside(x, y));
        if (visible.length === pixels.length && pixels.length) ops.push({ op: 'line', x: fromX, y: fromY, x2: X, y2: Y, color: e.trail.color });
        else ops.push(...visible.map(([x, y]) => ({ op: 'pixel', x, y, color: e.trail.color })));
        operations += visible.length === pixels.length ? Math.min(1, pixels.length) : visible.length;
      }
      if (left >= width || top >= height || left + w <= 0 || top + h <= 0) { culled++; continue; }
      const remap = p.remap && Object.keys(p.remap).length ? { remap: p.remap } : {};
      // The last `dissolve` share of a life thins out through an ordered-dither pattern anchored to the canvas.
      const fading = e.dissolve ? Math.ceil(e.dissolve * p.life) : 0, into = p.age - (p.life - fading);
      const progress = fading && into >= 0 ? (into + 1) / (fading + 1) : 0;
      const x0 = Math.max(0, -left), y0 = Math.max(0, -top), x1 = Math.min(w, width - left), y1 = Math.min(h, height - top);
      if (!progress && x0 === 0 && y0 === 0 && x1 === w && y1 === h) { ops.push({ op: 'stamp', symbol, x: left, y: top, ...remap }); operations++; continue; }
      const kept = rows.slice(y0, y1).map((row, j) => [...row.slice(x0, x1)].map((char, i) => (char === ' ' || e.threshold(left + x0 + i, top + y0 + j) < progress ? '.' : char)).join(''));
      if (kept.some(row => /[^.]/.test(row))) { ops.push({ op: 'grid', x: left + x0, y: top + y0, rows: kept, ...remap }); operations++; }
    }
    // Advance: velocity gains gravity and attraction, loses drag, moves the particle, then meets the floor.
    for (let i = alive.length - 1; i >= 0; i--) {
      const p = alive[i], e = p.emitter;
      p.age++;
      if (p.age >= p.life) { alive.splice(i, 1); continue; }
      p.vx += e.gravity[0]; p.vy += e.gravity[1];
      if (e.attract) {
        const dx = e.attract.at[0] - p.x, dy = e.attract.at[1] - p.y, distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 0.5) { p.vx += dx / distance * e.attract.strength; p.vy += dy / distance * e.attract.strength; }
      }
      p.vx *= 1 - e.drag; p.vy *= 1 - e.drag;
      p.x += p.vx; p.y += p.vy;
      if (e.floor !== null && p.y > e.floor) { p.y = e.floor; if (p.vy > 0) p.vy = -p.vy * e.bounce; }
    }
    if (operations > LIMITS.operations) fail(context.path, `the effect needs more than ${LIMITS.operations} drawing operations; lower counts or frames`);
  }
  return { output, operations, culled, stats };
}

export function compileEffects(source) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'symbols', 'anchor', 'effects', 'sheet'], 'fx');
  if (source.format !== 'pixelforge-fx' || source.version !== 1) fail('fx', 'expected version-1 pixelforge-fx');
  const palette = source.palette ?? {};
  if (!isObject(palette)) fail('fx.palette', 'expected a palette object');
  const width = integer(source.width, 'fx.width', 1, 256), height = integer(source.height, 'fx.height', 1, 256);
  if (!isObject(source.symbols) || !Object.keys(source.symbols).length) fail('fx.symbols', 'expected named symbols for the particles to draw');
  for (const [name, rows] of Object.entries(source.symbols)) {
    identifier(name, `fx.symbols.${name}`);
    if (!Array.isArray(rows) || !rows.length || rows.length > 256 || typeof rows[0] !== 'string' || !rows[0].length || rows.some(row => typeof row !== 'string' || row.length !== rows[0].length)) fail(`fx.symbols.${name}`, 'expected 1–256 equal-width text rows');
  }
  if (!isObject(source.effects) || !Object.keys(source.effects).length || Object.keys(source.effects).length > LIMITS.effects) fail('fx.effects', `expected 1–${LIMITS.effects} named effects`);
  const frames = [], animations = {}, metadata = { format: 'pixelforge-fx-metadata', version: 1, effects: {} }, seen = new Set();
  for (const [name, effect] of Object.entries(source.effects)) {
    const path = `fx.effects.${name}`;
    identifier(name, path);
    // Effect names become animation and frame names, which must be unique ignoring case for portable bundles.
    if (seen.has(name.toLowerCase())) fail(path, 'effect names must be unique ignoring case; they name animations and frames');
    seen.add(name.toLowerCase());
    fields(effect, ['frames', 'duration', 'loop', 'seed', 'emitters'], path);
    const count = integer(effect.frames, `${path}.frames`, 1, 256), loop = effect.loop ?? false;
    if (typeof loop !== 'boolean') fail(`${path}.loop`, 'expected a boolean');
    const durations = Array.isArray(effect.duration)
      ? (effect.duration.length === count ? effect.duration.map((d, i) => integer(d, `${path}.duration[${i}]`, 1, 60000)) : fail(`${path}.duration`, `expected one duration or ${count}`))
      : Array(count).fill(integer(effect.duration ?? 100, `${path}.duration`, 1, 60000));
    if (!Array.isArray(effect.emitters) || !effect.emitters.length || effect.emitters.length > LIMITS.emitters) fail(`${path}.emitters`, `expected 1–${LIMITS.emitters} emitters`);
    const seed = integer(effect.seed ?? 1, `${path}.seed`, 0, 2147483647), context = { frames: count, loop, seed, symbols: source.symbols, palette, width, height, path };
    const emitters = effect.emitters.map((emitter, i) => readEmitter(emitter, `${path}.emitters[${i}]`, context));
    const run = simulate({ frames: count, loop, seed, emitters }, context);
    const spawned = run.stats.reduce((sum, s) => sum + s.spawned, 0);
    if (spawned > LIMITS.spawned) fail(`${path}.emitters`, `more than ${LIMITS.spawned} particles; lower burst, rate or frames`);
    const names = run.output.map((ops, i) => {
      frames.push({ name: `${name}-${i}`, duration: durations[i], ...(ops.length && { ops }) });
      return `${name}-${i}`;
    });
    animations[name] = { frames: names, ...(!loop && { loop: false }) };
    metadata.effects[name] = { frames: count, loop, seed: effect.seed ?? 1, operations: run.operations, culled: run.culled, emitters: run.stats };
  }
  if (frames.length > 256) fail('fx.effects', `the effects make ${frames.length} frames; a recipe holds at most 256`);
  const recipe = { version: 1, name: source.name, width, height, palette, symbols: source.symbols, ...(source.anchor !== undefined && { anchor: source.anchor }), frames, animations, ...(source.sheet !== undefined && { sheet: source.sheet }) };
  renderProject(recipe);
  return JSON.parse(JSON.stringify({ recipe, metadata }));
}
