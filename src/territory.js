// Territory for pixelforge-bodies (docs/physics-model.md, section 13a): a grid of square cells owned by teams, drawn in
// each team's colour. A body with a team passes through its own team's cells and meets the others' as walls; a cell a
// team's body really hits becomes that team's, and the walls are traced again. Pickups and scripted events give bodies
// powers (split, grow, speed, warp, magnet), and a heads-up display draws the score, a share bar and the latest power
// as ordinary recipe operations.
//
// src/bodies.js calls this from a few hooks: reading an effect, the contacts it gathers, the end of each substep and of
// each frame, and drawing. Browser-compatible and deterministic, as bodies.js is: only + − × ÷ and sqrt, craft.js's
// trigonometry, and cells, bodies and pickups visited in a fixed order.
import { PixelError } from './core.js';
import { fields } from './authoring.js';
import { cosDeg, sinDeg } from './craft.js';
import { layoutText, measureText, FONT_CAP_HEIGHT } from './font.js';

export const POWERS = ['split', 'grow', 'speed', 'warp', 'magnet', 'vanish', 'break'];
const LIMITS = { teams: 8, cells: 65536, pickups: 64, events: 64, strikes: 16, hud: 16 };
// Labels the news line shows for a power that names none.
const LABELS = { split: 'SPLIT', grow: 'GROW', speed: 'SPEED', warp: 'WARP', magnet: 'MAGNET', vanish: 'GONE', break: 'BREAK' };

const fail = (path, message) => { throw new PixelError(path, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, path, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a number from ${min} to ${max}`);
  return value;
};
const integer = (value, path, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value;
};
const pair = (value, path, min, max, whole = false) => {
  if (!Array.isArray(value) || value.length !== 2) fail(path, 'expected [x, y]');
  return value.map((n, i) => (whole ? integer : number)(n, `${path}[${i}]`, min, max));
};
const key = (value, path, palette) => {
  if (typeof value !== 'string' || value.length !== 1 || value === '.' || value === ' ' || !Object.hasOwn(palette, value)) fail(path, 'expected a single-character key in the palette');
  return value;
};
const name = (value, path) => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(value)) fail(path, 'expected a name: a letter, then letters, digits, _ or -, at most 60 characters');
  return value;
};
const label = (value, path) => {
  if (typeof value !== 'string' || !value.length || value.length > 40 || value.includes('\n')) fail(path, 'expected 1–40 characters on one line');
  layoutText(value, {}, message => fail(path, message));
  return value;
};

// ---- Reading ----------------------------------------------------------------------------------------------------------
/** `territory` of a bodies effect → { cell, x, y, columns, rows, teams: [{ name, color, label }], start, bounce, friction }.
 * `start` holds each cell's team (its index in `teams`) or -1 for a cell no one owns. */
export function readTerritory(value, path, { width, height, palette }) {
  if (!isObject(value)) fail(path, 'expected { cell, teams, rows or split }');
  fields(value, ['cell', 'at', 'size', 'teams', 'rows', 'split', 'bounce', 'friction'], path);
  const cell = integer(value.cell ?? 4, `${path}.cell`, 1, 64);
  const [x, y] = value.at === undefined ? [0, 0] : pair(value.at, `${path}.at`, 0, 4096, true);
  if (!Array.isArray(value.teams) || value.teams.length < 2 || value.teams.length > LIMITS.teams) fail(`${path}.teams`, `expected 2–${LIMITS.teams} teams, each { name, color }`);
  const teams = value.teams.map((team, i) => {
    const p = `${path}.teams[${i}]`;
    if (!isObject(team)) fail(p, 'expected { name, color, label }');
    fields(team, ['name', 'color', 'label'], p);
    return { name: name(team.name, `${p}.name`), color: key(team.color, `${p}.color`, palette), label: team.label === undefined ? team.name.toUpperCase() : label(team.label, `${p}.label`) };
  });
  teams.forEach((team, i) => {
    if (teams.findIndex(other => other.name.toLowerCase() === team.name.toLowerCase()) !== i) fail(`${path}.teams[${i}].name`, `two teams are named ${team.name}`);
    if (teams.findIndex(other => other.color === team.color) !== i) fail(`${path}.teams[${i}].color`, `two teams share the colour ${team.color}; each team's cells need their own`);
  });
  if ((value.rows === undefined) === (value.split === undefined)) fail(path, 'lay the cells out with rows (one character per cell: a team\'s colour, or . for none) or split (columns or rows, the board shared out among the teams in order)');
  let columns, rows, start;
  if (value.rows !== undefined) {
    if (value.size !== undefined) fail(`${path}.size`, 'rows already give the size; size goes with split');
    if (!Array.isArray(value.rows) || !value.rows.length || typeof value.rows[0] !== 'string' || !value.rows[0].length || value.rows.some(row => typeof row !== 'string' || row.length !== value.rows[0].length)) fail(`${path}.rows`, 'expected equal-width text rows, one character per cell');
    columns = value.rows[0].length; rows = value.rows.length;
    start = new Int8Array(columns * rows);
    value.rows.forEach((row, j) => { for (let i = 0; i < columns; i++) {
      const c = row[i], team = teams.findIndex(t => t.color === c);
      if (c !== '.' && c !== ' ' && team < 0) fail(`${path}.rows[${j}]`, `${JSON.stringify(c)} at column ${i} is no team's colour; use ${teams.map(t => t.color).join(', ')} or .`);
      start[j * columns + i] = c === '.' || c === ' ' ? -1 : team;
    } });
  } else {
    if (!['columns', 'rows'].includes(value.split)) fail(`${path}.split`, 'expected columns (the teams side by side) or rows (one above the next)');
    [columns, rows] = value.size === undefined ? [Math.floor((width - x) / cell), Math.floor((height - y) / cell)] : pair(value.size, `${path}.size`, 1, 4096, true);
    if (columns < 1 || rows < 1) fail(`${path}.cell`, `a ${cell}-pixel cell doesn't fit the canvas from [${x}, ${y}]`);
    start = new Int8Array(columns * rows);
    const across = value.split === 'columns' ? columns : rows;
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) start[j * columns + i] = Math.floor((value.split === 'columns' ? i : j) * teams.length / across);
  }
  if (columns * rows > LIMITS.cells) fail(path, `${columns * rows} cells, more than ${LIMITS.cells}`);
  if (x + columns * cell > width || y + rows * cell > height) fail(path, `the ${columns}×${rows} cells of ${cell} pixels from [${x}, ${y}] reach past the ${width}×${height} canvas`);
  return { cell, x, y, columns, rows, teams, start,
    bounce: number(value.bounce ?? 1, `${path}.bounce`, 0, 1), friction: number(value.friction ?? 0, `${path}.friction`, 0, 2) };
}

// One power's settings, shared by pickups, events and strikes.
function readPower(entry, path, context) {
  if (!POWERS.includes(entry.power)) fail(`${path}.power`, `expected ${POWERS.join(', ')}`);
  const power = entry.power, only = (field, powers) => { if (entry[field] !== undefined && !powers.includes(power)) fail(`${path}.${field}`, `${field} goes with ${powers.join(' or ')}`); };
  only('count', ['split', 'break']); only('spread', ['split']); only('scale', ['grow']); only('factor', ['speed']); only('to', ['warp', 'magnet']); only('strength', ['magnet']); only('frames', ['grow', 'speed', 'magnet']);
  if (power === 'warp' && entry.to === undefined) fail(`${path}.to`, 'a warp needs a place to move the body to');
  return {
    power, label: entry.label === undefined ? LABELS[power] : label(entry.label, `${path}.label`),
    count: integer(entry.count ?? (power === 'break' ? 6 : 3), `${path}.count`, 2, 8), spread: number(entry.spread ?? 30, `${path}.spread`, 1, 180),
    scale: number(entry.scale ?? 2, `${path}.scale`, 1.25, 4), factor: number(entry.factor ?? 1.5, `${path}.factor`, 0.25, 4),
    to: entry.to === undefined ? null : target(entry.to, `${path}.to`, context),
    strength: number(entry.strength ?? 0.05, `${path}.strength`, 0.001, 1), frames: integer(entry.frames ?? 120, `${path}.frames`, 1, 18000)
  };
}
const POWER_FIELDS = ['power', 'label', 'count', 'spread', 'scale', 'factor', 'to', 'strength', 'frames'];
// A place a power moves or pulls a body to: on the canvas or up to a canvas beyond it, each axis by its own side.
function target(value, path, { width, height }) {
  const [x, y] = pair(value, path, -2 * Math.max(width, height), 4 * Math.max(width, height));
  if (x < -width || x > 2 * width) fail(`${path}[0]`, `expected a number from ${-width} to ${2 * width}`);
  if (y < -height || y > 2 * height) fail(`${path}[1]`, `expected a number from ${-height} to ${2 * height}`);
  return [x, y];
}

/** `pickups` → [{ at, size, from, until, symbol, color, power… }]: squares a body takes by reaching them. */
export function readPickups(list, path, context) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > LIMITS.pickups) fail(path, `expected a list of at most ${LIMITS.pickups} pickups`);
  return list.map((entry, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(entry)) fail(p, 'expected { at, power, … }');
    fields(entry, ['at', 'size', 'from', 'until', 'symbol', 'color', ...POWER_FIELDS], p);
    if (entry.symbol !== undefined && entry.color !== undefined) fail(`${p}.symbol`, 'a pickup is drawn as a symbol or as a square of color, not both');
    if (entry.symbol !== undefined && (typeof entry.symbol !== 'string' || !Object.hasOwn(context.symbols, entry.symbol))) fail(`${p}.symbol`, `unknown symbol ${JSON.stringify(entry.symbol)}`);
    const symbol = entry.symbol ?? null, size = integer(entry.size ?? (symbol ? Math.max(context.symbols[symbol].length, context.symbols[symbol][0].length) : 5), `${p}.size`, 1, 64);
    const from = integer(entry.from ?? 0, `${p}.from`, 0, 18000), until = entry.until === undefined ? null : integer(entry.until, `${p}.until`, from + 1, 18001);
    return { at: pair(entry.at, `${p}.at`, 0, 4096), size, from, until, symbol, color: entry.color === undefined ? null : key(entry.color, `${p}.color`, context.palette), path: p, ...readPower(entry, p, context) };
  });
}

/** `events` → [{ frame, body, power… }]: a power given to a named body at the end of a frame. */
export function readEvents(list, path, context, bodies) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > LIMITS.events) fail(path, `expected a list of at most ${LIMITS.events} events`);
  return list.map((entry, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(entry)) fail(p, 'expected { frame, body, power, … }');
    fields(entry, ['frame', 'body', ...POWER_FIELDS], p);
    const index = bodies.findIndex(b => b.name !== null && b.name.toLowerCase() === String(entry.body).toLowerCase());
    if (index < 0) fail(`${p}.body`, `no body is named ${JSON.stringify(entry.body)}`);
    if (bodies[index].fixed && entry.power !== 'vanish' && entry.power !== 'break') fail(`${p}.body`, `${entry.body} is fixed; powers go to bodies that move freely (a fixed body can only vanish or break)`);
    if (bodies[index].shape === 'hoop' && entry.power === 'break') fail(`${p}.power`, `${entry.body} is a hoop, a container, and does not break; it can vanish`);
    return { frame: integer(entry.frame, `${p}.frame`, 1, 18000), body: index, path: p, ...readPower(entry, p, context) };
  });
}

/** `strikes` → [{ by, rest, from, until, power… }]: a power given at the end of a frame to each body that the body named
 * `by` pushed in it (a hit, or a push along), at most once every `rest` frames to a body. */
export function readStrikes(list, path, context, bodies) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > LIMITS.strikes) fail(path, `expected a list of at most ${LIMITS.strikes} strikes`);
  return list.map((entry, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(entry)) fail(p, 'expected { by, power, … }');
    fields(entry, ['by', 'rest', 'from', 'until', 'cut', ...POWER_FIELDS], p);
    const index = bodies.findIndex(b => b.name !== null && b.name.toLowerCase() === String(entry.by).toLowerCase());
    if (index < 0) fail(`${p}.by`, `no body is named ${JSON.stringify(entry.by)}; a strike names the body whose pushes give the power`);
    const from = integer(entry.from ?? 0, `${p}.from`, 0, 18000), until = entry.until === undefined ? null : integer(entry.until, `${p}.until`, from + 1, 18001);
    // A cut: the strike's body passes through what it strikes, which leaves behind it at this speed (pixels a frame).
    const cut = entry.cut === undefined ? null : number(entry.cut, `${p}.cut`, 0.1, 8);
    return { by: index, rest: integer(entry.rest ?? 10, `${p}.rest`, 1, 18000), from, until, cut, path: p, ...readPower(entry, p, context) };
  });
}

// The words a heads-up text may hold: a team's name (its cells), name% (its share), leader, news and frame.
const TOKEN = /\{([A-Za-z][A-Za-z0-9_-]*%?)\}/g;
/** `hud` → [{ text… } | { bar… }]: drawn over everything, every frame. */
export function readHud(list, path, context, teams) {
  if (list === undefined) return [];
  if (!teams) fail(path, 'a heads-up display shows a territory\'s score; give the effect a territory');
  if (!Array.isArray(list) || list.length > LIMITS.hud) fail(path, `expected a list of at most ${LIMITS.hud} entries`);
  const known = new Set(['leader', 'news', 'frame', ...teams.flatMap(team => [team.name, `${team.name}%`])]), fine = context.subpixels ?? 1;
  return list.map((entry, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(entry)) fail(p, 'expected { text, at, color } or { bar }');
    const from = integer(entry.from ?? 0, `${p}.from`, 0, 18000), until = entry.until === undefined ? null : integer(entry.until, `${p}.until`, from + 1, 18001);
    if (entry.bar !== undefined) {
      fields(entry, ['bar', 'empty', 'from', 'until'], p);
      if (!isObject(entry.bar)) fail(`${p}.bar`, 'expected { at, size }');
      fields(entry.bar, ['at', 'size'], `${p}.bar`);
      return { bar: { at: pair(entry.bar.at, `${p}.bar.at`, 0, Math.floor(4096 / fine), true), size: pair(entry.bar.size, `${p}.bar.size`, 1, Math.floor(512 / fine), true) }, empty: entry.empty === undefined ? null : key(entry.empty, `${p}.empty`, context.palette), from, until };
    }
    fields(entry, ['text', 'at', 'color', 'align', 'back', 'pad', 'scale', 'news', 'from', 'until'], p);
    if (typeof entry.text !== 'string' || !entry.text.length || entry.text.length > 80 || entry.text.includes('\n')) fail(`${p}.text`, 'expected 1–80 characters on one line');
    for (const [, word] of entry.text.matchAll(TOKEN)) if (!known.has(word)) fail(`${p}.text`, `{${word}} isn't a heads-up word; use a team's name ({${teams[0].name}} cells, {${teams[0].name}%} share), {leader}, {news} or {frame}`);
    layoutText(entry.text.replace(TOKEN, '0'), {}, message => fail(`${p}.text`, message));
    const align = entry.align ?? 'left';
    if (!['left', 'center', 'right'].includes(align)) fail(`${p}.align`, 'expected left, center or right');
    return { text: entry.text, at: pair(entry.at, `${p}.at`, -Math.floor(4000 / fine), Math.floor(4000 / fine), true), color: key(entry.color, `${p}.color`, context.palette), align,
      back: entry.back === undefined ? null : key(entry.back, `${p}.back`, context.palette), pad: integer(entry.pad ?? 1, `${p}.pad`, 0, 16),
      scale: integer(entry.scale ?? 1, `${p}.scale`, 1, Math.max(1, Math.min(8, Math.floor(16 / fine)))), news: integer(entry.news ?? 45, `${p}.news`, 1, 18000), from, until };
  });
}

// ---- The territory in a world -----------------------------------------------------------------------------------------
/** The territory's state while a world runs. `trace(at, material, columns, rows, scale, x, y)` is bodies.js's face tracer;
 * `scale(b, k)` grows a body's shape by k; `copy(b)` adds a copy of a body to the world and returns it; `fastest` is the
 * bodies' speed limit. */
export function createTerritory(effect, { trace, scale, copy, shatter, width, height, fastest = Infinity }) {
  // Powers work without a territory too: then there are no cells and no teams.
  const t = effect.territory ?? { cell: 1, x: 0, y: 0, columns: 0, rows: 0, teams: [], start: new Int8Array(0), bounce: 1, friction: 0 };
  const { columns, rows, cell, teams } = t, owner = Int8Array.from(t.start);
  const surface = { bounce: t.bounce, friction: t.friction, soft: false };
  // Walls for each viewer: viewer k < teams.length is team k (every other team's cells), the last a body with no team.
  let views = new Array(teams.length + 1).fill(null), generation = 0;
  const view = viewer => views[viewer] ??= trace((i, j) => i >= 0 && j >= 0 && i < columns && j < rows && owner[j * columns + i] >= 0 && owner[j * columns + i] !== viewer, () => surface, columns, rows, cell, t.x, t.y, width, height);
  const flips = [];
  const counts = () => { const out = new Array(teams.length).fill(0); for (const o of owner) if (o >= 0) out[o]++; return out; };
  const stats = { counts: [], flips: 0, taken: [], strikes: 0 };
  const pickups = effect.pickups.map(p => ({ ...p, taken: false })), events = effect.events, magnets = [], timers = [];
  let news = null;
  const viewerOf = b => (b.team >= 0 ? b.team : teams.length);
  // Whether body b covers some of cell c (a circle exactly, another shape by its bounds), touching not counted.
  const covers = (b, c) => {
    const i = c % columns, j = (c - i) / columns, x0 = t.x + i * cell, y0 = t.y + j * cell, x1 = x0 + cell, y1 = y0 + cell;
    if (b.shape === 'circle') {
      const r = b.parts[0].r, cx = Math.max(x0, Math.min(x1, b.x)), cy = Math.max(y0, Math.min(y1, b.y));
      return (cx - b.x) * (cx - b.x) + (cy - b.y) * (cy - b.y) < r * r;
    }
    const reach = b.extent * Math.SQRT2;
    return b.x - reach < x1 && b.x + reach > x0 && b.y - reach < y1 && b.y + reach > y0;
  };
  // A cell a body of its own team is in: it holds it.
  let all = [];
  const held = (c, bodies = all) => bodies.some(b => !b.gone && b.team === owner[c] && covers(b, c));
  const changed = () => { views = new Array(teams.length + 1).fill(null); generation++; };

  // A hit on a cell: the cell behind the face the contact touches, if it is another team's.
  const cellOf = (s, point) => {
    const horizontal = s.ny !== 0, lo = horizontal ? Math.min(s.ax, s.bx) : Math.min(s.ay, s.by), hi = horizontal ? Math.max(s.ax, s.bx) : Math.max(s.ay, s.by);
    const along = Math.max(lo + cell / 2, Math.min(hi - cell / 2, horizontal ? point.x : point.y));
    const px = horizontal ? along : s.ax - s.nx * cell / 2, py = horizontal ? s.ay - s.ny * cell / 2 : along;
    const i = Math.floor((px - t.x) / cell), j = Math.floor((py - t.y) / cell);
    return i >= 0 && j >= 0 && i < columns && j < rows ? j * columns + i : -1;
  };
  const take = (b, p, f, what) => {
    // A strike's power is counted rather than listed (a crowd that multiplies takes thousands), and makes no news.
    const entry = what.strike === undefined ? { frame: f, [what.pickup !== undefined ? 'pickup' : 'event']: what.pickup ?? what.event, body: b.name ?? b.path, power: p.power } : null;
    if (entry) { stats.taken.push(entry); news = { label: p.label, frame: f }; } else stats.strikes++;
    // What a cut struck leaves behind the cutter at the cut's speed (woken: a sleeper given a speed would hang still).
    const back = p.cut && what.back ? what.back : null;
    if (back) { b.asleep = false; b.sleepy = 0; }
    if (p.power === 'split') {
      // Copies turned evenly about the taker's heading (a cut's pieces about the way behind the cutter, each at the cut's
      // speed on top of the taker's own); the taker takes the first heading. A body whose fill list steps with time
      // (fillEvery) takes the list's fill for this frame, and so do its copies: every split a new generation, so a blade
      // that cuts paints what it cuts even once the crowd is too full to grow.
      const tint = b.fillEvery && b.fills && b.fills.length > 1 ? Math.floor(f / b.fillEvery) % b.fills.length : null;
      const vx = b.vx, vy = b.vy;
      if (entry) entry.copies = 0;
      for (let k = 0; k < p.count; k++) {
        const a = (k - (p.count - 1) / 2) * p.spread, c = cosDeg(a), s = sinDeg(a), target = k === 0 ? b : copy(b);
        if (!target) break;
        if (target !== b) { if (entry) entry.copies++; if (b.rested) target.rested = { ...b.rested }; }
        if (tint !== null) target.colour = tint;
        if (back) { target.vx = vx + p.cut * (back[0] * c - back[1] * s); target.vy = vy + p.cut * (back[0] * s + back[1] * c); }
        else { target.vx = vx * c - vy * s; target.vy = vx * s + vy * c; }
        // A copy of a grown or hurried body shrinks back or slows down when the taker does.
        if (target !== b) for (const timer of timers.filter(other => other.body === b)) timers.push({ ...timer, body: target, undo: timer.again(target) });
      }
    } else if (p.power === 'grow') {
      const running = timers.find(timer => timer.body === b && timer.power === 'grow');
      if (running) running.until = Math.max(running.until, f + p.frames);
      else { scale(b, p.scale); const again = body => () => scale(body, 1 / p.scale); timers.push({ body: b, power: 'grow', until: f + p.frames, undo: again(b), again }); }
    } else if (p.power === 'speed') {
      if (b.speed) {
        const base = b.speed, running = timers.find(timer => timer.body === b && timer.power === 'speed');
        if (running) running.until = Math.max(running.until, f + p.frames);
        else { b.speed = Math.min(fastest, base * p.factor); const again = body => () => { body.speed = base; }; timers.push({ body: b, power: 'speed', until: f + p.frames, undo: again(b), again }); }
      } else { b.vx *= p.factor; b.vy *= p.factor; }
    } else if (p.power === 'warp') {
      // A warped body leaves no trail across the board, and a team's body lands on its own ground: the cells it lands on
      // become its team's, the pocket it carves from. (Landed in another team's ground, it flew through it, a wall on
      // every side, until it met a face from behind and burst out.)
      b.x = p.to[0]; b.y = p.to[1]; b.history.length = 0;
      if (b.team >= 0) {
        let painted = false;
        for (let c = 0; c < owner.length; c++) if (owner[c] >= 0 && owner[c] !== b.team && covers(b, c) && !held(c)) { owner[c] = b.team; stats.flips++; painted = true; }
        if (painted) changed();
      }
    } else if (p.power === 'magnet') {
      const [x, y] = p.to ?? what.at;
      magnets.push({ x, y, strength: p.strength, until: f + p.frames, team: b.team, body: b });
    } else if (p.power === 'vanish') {
      // Gone, as a body that leaves the canvas is: what it held falls (bodies.js wakes what rested on it).
      b.gone = true;
    } else if (p.power === 'break') {
      // Broken into `count` pieces about where the power found it (a pickup's place, else its centre); a cut's pieces leave
      // behind the cutter. A body too small or a crowd too full to break is left whole.
      if (back) { b.vx += p.cut * back[0]; b.vy += p.cut * back[1]; }
      const made = shatter(b, what.pickup !== undefined ? what.at : [b.x, b.y], p.count);
      if (entry) entry.pieces = made;
    }
    if (back && p.power !== 'split' && p.power !== 'warp' && p.power !== 'vanish' && p.power !== 'break') { b.vx += p.cut * back[0]; b.vy += p.cut * back[1]; }
  };
  // The bodies each strike's body pushed (or cut) this frame, by index, given its power at the frame's end; a cut body
  // with the way behind the cutter where it was first touched.
  const strikes = effect.strikes ?? [], struck = strikes.map(() => new Map());

  return {
    teams,
    stats,
    near: (b, x0, y0, x1, y1) => { const v = view(viewerOf(b)); return v.near(x0, y0, x1, y1).map(index => ({ s: v.segments[index], key: `t${generation}:${viewerOf(b)}:${index}` })); },
    // Contacts on cells that pushed (the solver had to hold the body off them) paint those cells the body's team.
    hit: (contact, s) => {
      if (contact.a.team < 0 || !contact.points.some(point => point.most > 0)) return;
      const c = cellOf(s, contact.points[0]);
      if (c >= 0 && owner[c] >= 0 && owner[c] !== contact.a.team) flips.push([c, contact.a.team]);
    },
    // The end of a substep: the cells hit change hands (first hit first) and the walls are traced again. A body of the
    // cell's own team in it holds it: painted under it, that body would be inside another team's ground, walls all
    // round it, and fly on through it unmet.
    settle: bodies => {
      if (!flips.length) return;
      let any = false;
      for (const [c, team] of flips) {
        if (owner[c] === team || held(c, bodies)) continue;
        owner[c] = team; stats.flips++; any = true;
      }
      flips.length = 0;
      if (any) changed();
    },
    // A contact between two bodies that pushed (a hit or a push along): what a strike's body pushed is struck by it. A
    // cutter's touch (bodies.js doesn't solve it) gives `back`, the way behind the cutter there.
    strike: (a, b, back = null) => {
      strikes.forEach((r, k) => {
        const other = a.index === r.by ? b : b.index === r.by ? a : null;
        if (other && !other.fixed && !struck[k].has(other.index)) struck[k].set(other.index, back);
      });
    },
    // The bodies cutting in frame f (a strike's with a cut, in its frames): they pass through the free bodies they meet.
    cutters: f => strikes.filter(r => r.cut && f >= r.from && (r.until === null || f < r.until)).map(r => r.by),
    // A magnet's pull on a body this substep: toward its point, as steady as gravity, on bodies of other teams.
    pull: (b, dt) => {
      for (const m of magnets) {
        if (m.body === b || (m.team >= 0 && b.team === m.team)) continue;
        const dx = m.x - b.x, dy = m.y - b.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0.5) { b.vx += dx / d * m.strength * dt; b.vy += dy / d * m.strength * dt; }
      }
    },
    // The end of frame f: powers run out, pickups are taken (first pickup first, by the first body to reach it), events
    // fire, the bodies struck this frame take their strikes' powers (in body order, each at most once every `rest`
    // frames), and the score is counted.
    frame: (f, bodies) => {
      all = bodies;
      for (let k = timers.length - 1; k >= 0; k--) if (timers[k].until <= f) { timers[k].undo(); timers.splice(k, 1); }
      for (let k = magnets.length - 1; k >= 0; k--) if (magnets[k].until <= f) magnets.splice(k, 1);
      pickups.forEach((p, index) => {
        if (p.taken || f < p.from || (p.until !== null && f >= p.until)) return;
        const h = p.size / 2, x0 = p.at[0] - h, y0 = p.at[1] - h, x1 = p.at[0] + h, y1 = p.at[1] + h;
        const taker = bodies.find(b => {
          if (b.fixed || b.gone || b.box[2] < x0 || b.box[0] > x1 || b.box[3] < y0 || b.box[1] > y1) return false;
          if (b.shape !== 'circle') return true;
          const r = b.world[0].r, cx = Math.max(x0, Math.min(x1, b.x)), cy = Math.max(y0, Math.min(y1, b.y));
          return (cx - b.x) * (cx - b.x) + (cy - b.y) * (cy - b.y) <= r * r;
        });
        if (taker) { p.taken = true; take(taker, p, f, { pickup: index, at: p.at }); }
      });
      events.forEach((e, index) => { const b = bodies[e.body]; if (e.frame === f && !b.gone) take(b, e, f, { event: index, at: [b.x, b.y] }); });
      strikes.forEach((r, index) => {
        if (!struck[index].size) return;
        const hit = [...struck[index]].sort((p, q) => p[0] - q[0]);
        struck[index].clear();
        if (f < r.from || (r.until !== null && f >= r.until) || bodies[r.by].gone) return;
        for (const [i, back] of hit) {
          const b = bodies[i], rested = b.rested ??= {};
          if (b.gone || (rested[index] !== undefined && f - rested[index] < r.rest)) continue;
          rested[index] = f;
          take(b, r, f, { strike: index, at: [b.x, b.y], back });
        }
      });
      stats.counts.push(counts());
    },
    // Cells and waiting pickups, into a grid of character codes (width × n by height × n: the world's pixels n fine
    // pixels a side with subpixels), before the bodies.
    draw: (grid, width, height, f, symbols, n = 1) => {
      const W = width * n, H = height * n, put = (x, y, code) => { if (x >= 0 && y >= 0 && x < W && y < H) grid[y * W + x] = code; };
      const block = (x, y, code) => { for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(x * n + i, y * n + j, code); };
      const codes = teams.map(team => team.color.charCodeAt(0));
      for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
        const o = owner[j * columns + i];
        if (o < 0) continue;
        for (let y = 0; y < cell * n; y++) for (let x = 0; x < cell * n; x++) put((t.x + i * cell) * n + x, (t.y + j * cell) * n + y, codes[o]);
      }
      for (const p of pickups) {
        if (p.taken || f < p.from || (p.until !== null && f >= p.until)) continue;
        if (p.symbol) {
          const art = symbols[p.symbol], left = Math.round(p.at[0] - art[0].length / 2), top = Math.round(p.at[1] - art.length / 2);
          art.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] !== '.' && row[x] !== ' ') block(left + x, top + y, row.charCodeAt(x)); });
        } else if (p.color) {
          const left = Math.round(p.at[0] - p.size / 2), top = Math.round(p.at[1] - p.size / 2);
          for (let y = 0; y < p.size; y++) for (let x = 0; x < p.size; x++) block(left + x, top + y, p.color.charCodeAt(0));
        }
      }
    },
    // The heads-up display for frame f, as recipe operations: share bars, then texts with their backs, on a canvas n
    // times finer with subpixels.
    hud: (f, hud, n = 1) => {
      const score = stats.counts[f] ?? counts(), total = score.reduce((sum, n) => sum + n, 0), ops = [];
      const lead = score.reduce((best, n, k) => (n > score[best] ? k : best), 0);
      for (const entry of hud) {
        if (f < entry.from || (entry.until !== null && f >= entry.until)) continue;
        if (entry.bar) {
          // Shared out in the world's pixels, then drawn n times finer, so each team's part ends on a world pixel as the
          // texts do.
          const [x, y] = entry.bar.at, [w, h] = entry.bar.size;
          if (entry.empty) ops.push({ op: 'rect', x: x * n, y: y * n, w: w * n, h: h * n, color: entry.empty });
          let sum = 0, left = x;
          score.forEach((cells, k) => {
            sum += cells;
            const right = x + (total ? Math.floor(w * sum / total) : 0);
            if (right > left) ops.push({ op: 'rect', x: left * n, y: y * n, w: (right - left) * n, h: h * n, color: teams[k].color });
            left = right;
          });
          continue;
        }
        let blank = false;
        const text = entry.text.replace(TOKEN, (_, word) => {
          if (word === 'leader') return teams[lead].label;
          if (word === 'frame') return String(f);
          if (word === 'news') { if (!news || f - news.frame >= entry.news) { blank = true; return ''; } return news.label; }
          const share = word.endsWith('%'), k = teams.findIndex(team => team.name === (share ? word.slice(0, -1) : word));
          return share ? `${total ? Math.round(100 * score[k] / total) : 0}%` : String(score[k]);
        });
        if (blank || !text.trim()) continue;
        // Aligned in the world's pixels, then drawn n times finer, so the text sits on the world's pixel grid.
        const w = measureText(text, {}).width * entry.scale, h = FONT_CAP_HEIGHT * entry.scale;
        const left = entry.align === 'center' ? entry.at[0] - Math.floor(w / 2) : entry.align === 'right' ? entry.at[0] - w : entry.at[0];
        if (entry.back) ops.push({ op: 'rect', x: (left - entry.pad) * n, y: (entry.at[1] - entry.pad) * n, w: (w + 2 * entry.pad) * n, h: (h + 2 * entry.pad) * n, color: entry.back });
        ops.push({ op: 'text', x: left * n, y: entry.at[1] * n, text, color: entry.color, ...(entry.scale * n > 1 && { scale: entry.scale * n }) });
      }
      return ops;
    }
  };
}
