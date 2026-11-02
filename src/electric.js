// Electricity and plasma for pixelforge-fluid gases. Obstacles may be electrodes (a `voltage`, fed by a supply with an
// optional internal `resistance` and a `charge` it stores) or `conductor`s (metal that arcs jump to); canvas edges may be
// grounded. Each step solves the electric potential φ over the gas, ∇·(σ∇φ) = 0, as a network of conductances between
// neighbouring cells (the four sides and the four corners), by conjugate gradients with a symmetric Gauss-Seidel
// preconditioner, `iterations` steps from the last step's φ. The conductivity σ is tiny in neutral gas and high in
// plasma, so a channel carries its electrode's potential to its tip, and the field gathers there.
//
// Channels grow by the dielectric breakdown model: each step, `growth` / substeps cells beside a conductor (an
// electrode, metal or a leader) ionize, drawn one at a time by seeded chance in proportion to (E / breakdown)^focus − 1
// among the cells whose field E across to it exceeds the local breakdown, which is lower in hot gas. A burning arc grows
// no branches. Plasma is a graph of markers that ride the gas, linked along each channel and drawn as lines, so a channel
// stays one pixel thin as the flow bends and lifts it; where the flow stretches it apart the field across the gap breaks
// it down again. A growing leader is kept ionized by the current that charges it; current through a cell keeps it
// ionized (fully from `sustain`, and not at all below half of it, so a starved arc goes out); otherwise plasma recombines
// at `recombine` a frame (slower when hot), fading as an afterglow, and leaves a trace for `memory` frames that a new
// strike runs down at once (a dart leader). Current heats the gas (`heating` × current²), so buoyancy lifts an arc. Gas
// hotter than `ionize` (2 on the shared heat scale, above every flame) is plasma too: an arc's hot air, a fireball's core.
//
// A supply with `resistance` sags as current flows, so a long arc starves and a shorter path takes over, and with
// `charge` it stores charge that a strike drains and the supply refills, so strikes come in bursts. The electrodes'
// potentials are solved together with the field: one solve per electrode with a resistance (its potential set to 1,
// the others to 0), one for the ideal electrodes when any is not at 0 V, combined by a small implicit circuit solve.
//
// Over a liquid (a liquid with heat and vapour) the gas is the air over the water, the vapour's gas, and the field is
// solved through the water and ice too: water conducts moderately and takes an arc that reaches it as a grounded edge
// does (its surface is where the arc's foot slides, and it grows no streamers of its own), ice hardly conducts, and the
// Joule heat of the water's and ice's cells goes to the liquid (fluid.js puts it into every particle there), so an arc
// that strikes a pool boils it where it lands.
//
// Browser-compatible and deterministic, as the rest of the fluid compiler: only + − × ÷ and sqrt, craft.js's seeded
// hash, fixed iteration counts (the solve may stop early once converged, at the same step on every engine), and cells,
// markers and links visited in a fixed order.
import { PixelError } from './core.js';
import { fields } from './authoring.js';
import { random, traceLine } from './craft.js';

export const EDGES = ['left', 'right', 'top', 'bottom'];
// The obstacle fields an electrode or metal reads (the fluid compiler lists them with the solid's other fields).
export const ELECTRODE_FIELDS = ['voltage', 'resistance', 'charge', 'conductor'];
const LIMITS = { electrodes: 8, markers: 16384, keys: 16 };
// A cell is a channel (it conducts, and grows the arc) from this much ionization; a marker goes once its ionization and
// trace fall below FADED; current under OUT × sustain keeps no plasma. Breakdown is lowered by up to MEMORY in partly
// ionized gas or along a trace, and by temperature as 1 / (1 + HOT × T).
const CHANNEL = 0.5, FADED = 0.02, OUT = 0.5, MEMORY = 0.75, HOT = 0.25;
// Conductivity of every state, as docs/physics-model.md section 10 sets them: neutral air hardly conducts until it breaks
// down; plasma conducts PLASMA times its ionization squared, so an arc carrying current I runs at about I / PLASMA volts a
// pixel, far below breakdown, and a fading afterglow stops carrying current well before it stops glowing; metal
// (electrodes and conductors) most of all; liquid water moderately and ice hardly at all. Every other solid insulates.
export const CONDUCTIVITY = { air: 0.00008, plasma: 8, water: 0.5, ice: 0.0008, metal: 64 };
const PLASMA = CONDUCTIVITY.plasma, CORNER = 0.5, DIAGONAL = 0.7071067811865476;
// What a cell that conducts holds besides gas: an electrode's or conductor's metal, or a liquid's water or ice. A liquid
// marks its cells with `MATTER.water` and `MATTER.ice` (see stepElectric).
const GAS = 0, METAL = 1, WATER = 2, FROZEN = 3;
export const MATTER = { water: WATER, ice: FROZEN };
const MATTER_SIGMA = [0, CONDUCTIVITY.metal, CONDUCTIVITY.water, CONDUCTIVITY.ice];
// Metal and water are what an arc lands on and slides along; ice is not.
const lands = m => m === METAL || m === WATER;
const SALT = { pick: 21 };

const fail = (path, message) => { throw new PixelError(path, message); };
const number = (value, path, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected a number from ${min} to ${max}`);
  return value;
};
const integer = (value, path, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value;
};

// ---- Reading -----------------------------------------------------------------------------------------------------------
// An electrode on an obstacle: `voltage` (a number, or keys [{ frame, voltage, over }] that change it on cue),
// `resistance` (the supply's own, so it sags as current flows) and `charge` (how much it stores, in current × frames
// per volt: a capacitor that the supply refills through its resistance).
export function readElectrode(obstacle, path, frames) {
  const out = { voltage: null, resistance: 0, charge: 0, conductor: false };
  if (obstacle.conductor !== undefined) {
    if (typeof obstacle.conductor !== 'boolean') fail(`${path}.conductor`, 'expected true or false');
    out.conductor = obstacle.conductor;
  }
  if (obstacle.voltage === undefined) {
    for (const key of ['resistance', 'charge']) if (obstacle[key] !== undefined) fail(`${path}.${key}`, `${key} belongs to an electrode's supply; give the obstacle a voltage`);
    return out.conductor ? out : null;
  }
  if (out.conductor) fail(`${path}.conductor`, 'an electrode already conducts; conductor is for metal at no set voltage, which arcs jump to');
  out.voltage = schedule(obstacle.voltage, `${path}.voltage`, frames);
  out.resistance = number(obstacle.resistance ?? 0, `${path}.resistance`, 0, 10000);
  out.charge = number(obstacle.charge ?? 0, `${path}.charge`, 0, 10000);
  if (out.charge && !out.resistance) fail(`${path}.charge`, 'a supply refills its charge through its resistance; set resistance too');
  return out;
}
// A voltage on every frame of the cycle: a number, or keys that move it in a straight line over `over` frames.
function schedule(value, path, frames) {
  if (typeof value === 'number') { number(value, path, -1000, 1000); return Array(frames).fill(value); }
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.keys) fail(path, `expected volts, or 1–${LIMITS.keys} keys { frame, voltage, over }`);
  const values = Array(frames).fill(0);
  let last = -1;
  value.forEach((key, i) => {
    const kp = `${path}[${i}]`;
    fields(key, ['frame', 'voltage', 'over'], kp);
    const frame = integer(key.frame, `${kp}.frame`, 0, frames - 1), to = number(key.voltage, `${kp}.voltage`, -1000, 1000), over = integer(key.over ?? 0, `${kp}.over`, 0, 256);
    if (frame < last) fail(`${kp}.frame`, 'keys go in frame order');
    last = frame;
    const from = values[frame];
    for (let f = frame; f < frames; f++) values[f] = over && f < frame + over ? from + (to - from) * (f - frame) / over : to;
  });
  return values;
}

// Over a liquid (`liquid`), the water's conductivity makes the field slower to solve, so it takes more steps by default.
export function readElectric(value, path, obstacles, liquid = false) {
  if (obstacles.filter(o => o.electric && o.electric.voltage).length > LIMITS.electrodes) fail(path, `at most ${LIMITS.electrodes} obstacles may have a voltage`);
  fields(value, ['breakdown', 'focus', 'growth', 'recombine', 'sustain', 'memory', 'heating', 'ionize', 'ground', 'iterations'], path);
  const ground = value.ground ?? [];
  if (!Array.isArray(ground) || ground.length > 4 || ground.some(edge => !EDGES.includes(edge)) || new Set(ground).size !== ground.length) fail(`${path}.ground`, `expected distinct edges from ${EDGES.join(', ')}`);
  return {
    breakdown: number(value.breakdown ?? 3, `${path}.breakdown`, 0.01, 1000), focus: number(value.focus ?? 2, `${path}.focus`, 0.5, 8),
    growth: integer(value.growth ?? 8, `${path}.growth`, 1, 256), recombine: number(value.recombine ?? 0.3, `${path}.recombine`, 0, 1),
    sustain: number(value.sustain ?? 0.5, `${path}.sustain`, 0.001, 1000), memory: number(value.memory ?? 8, `${path}.memory`, 0, 256),
    heating: number(value.heating ?? 0.2, `${path}.heating`, 0, 16), ionize: number(value.ionize ?? 2, `${path}.ionize`, 0, 64),
    ground: Object.fromEntries(EDGES.map(edge => [edge, ground.includes(edge)])), iterations: integer(value.iterations ?? (liquid ? 48 : 24), `${path}.iterations`, 1, 200)
  };
}

// Cell updates per cell per step, for the work budget: about four per conjugate-gradient step, for the ideal electrodes' solve and each supplied electrode's, plus the markers, and one for each
// breakdown pick (each draws its cell from all of them).
export const electricWork = effect => {
  if (!effect.electric) return 0;
  const supplied = effect.obstacles.filter(o => o.electric && o.electric.voltage && o.electric.resistance).length;
  return 4 * effect.electric.iterations * (1 + supplied) + 20 + Math.max(1, Math.floor(effect.electric.growth / effect.substeps + 0.5));
};

// ---- State -------------------------------------------------------------------------------------------------------------
// Cell kinds: an insulator (a plain obstacle), gas or metal (unknown potential), or an electrode's cell (held).
const INSULATOR = 0, OPEN = 1, HELD = 2;

export function createElectric(effect, width, height) {
  const N = width * height, config = effect.electric, electrodes = [];
  effect.obstacles.forEach((o, index) => { if (o.electric && o.electric.voltage) electrodes.push({ index, ...o.electric, phi: o.electric.voltage[0] }); });
  const E = {
    config, W: width, H: height, N, electrodes, cycle: 0, step: 0,
    kind: new Uint8Array(N), which: new Int8Array(N).fill(-1), metal: new Uint8Array(N), matter: null, free: new Uint8Array(N),
    sigma: new Float64Array(N), diag: new Float64Array(N), kE: new Float64Array(N), kS: new Float64Array(N), kSE: new Float64Array(N), kSW: new Float64Array(N), ground: new Float64Array(N),
    phi: new Float64Array(N), fixed: null, basis: electrodes.map(() => null),
    ion: new Float64Array(N), current: new Float64Array(N),
    markers: [], owner: new Int32Array(N), line: new Int32Array(N), trace: new Float64Array(N),
    cg: { b: new Float64Array(N), r: new Float64Array(N), z: new Float64Array(N), s: new Float64Array(N), q: new Float64Array(N) },
    layoutKey: null
  };
  E.matter = E.metal;
  return E;
}

// Which cells are electrodes, metal or insulators, for the obstacles' places now. Every solid of the shared solid layer
// (obstacles, ice, whatever comes next) insulates unless it is an electrode or metal; over a liquid, `solid` is the
// obstacles alone, and the water and ice join each step as matter that conducts (see stepElectric).
function buildMasks(E, effect, layout, solid) {
  const { W, H, N, kind, which, metal } = E;
  kind.fill(OPEN); which.fill(-1); metal.fill(GAS);
  for (let c = 0; c < N; c++) if (solid[c]) kind[c] = INSULATOR;
  const slot = new Map(E.electrodes.map((e, n) => [e.index, n]));
  effect.obstacles.forEach((o, i) => {
    if (!o.electric) return;
    const at = layout.places[i];
    if (!at.show) return;
    o.rows.forEach((row, j) => {
      const y = at.y + j;
      if (y < 0 || y >= H) return;
      for (let k = Math.max(0, -at.x); k < Math.min(row.length, W - at.x); k++) {
        if (row[k] === '.' || row[k] === ' ') continue;
        const c = y * W + at.x + k;
        if (slot.has(i)) { if (which[c] < 0) { kind[c] = HELD; which[c] = slot.get(i); } }
        else if (kind[c] !== HELD) { kind[c] = OPEN; metal[c] = METAL; }
      }
    });
  });
  E.layoutKey = layout.key;
}

// ---- The conduction solve ----------------------------------------------------------------------------------------------
// Conductances between neighbouring cells: series (harmonic) means of the two cells' conductivities, half as much across
// a corner, and none through an insulator or across a corner both of whose side cells are insulators.
function assemble(E) {
  const { W, H, N, kind, matter, sigma, ion, diag, kE, kS, kSE, kSW, ground, config } = E, { air, metal: conductor } = CONDUCTIVITY;
  for (let c = 0; c < N; c++) sigma[c] = kind[c] === INSULATOR ? 0 : kind[c] === HELD ? conductor : matter[c] ? MATTER_SIGMA[matter[c]] : air + PLASMA * ion[c] * ion[c];
  const link = (a, b, w) => { const sa = sigma[a], sb = sigma[b]; return sa && sb ? w * 2 * sa * sb / (sa + sb) : 0; };
  diag.fill(0); ground.fill(0);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i;
    kE[c] = i < W - 1 ? link(c, c + 1, 1) : 0;
    kS[c] = j < H - 1 ? link(c, c + W, 1) : 0;
    kSE[c] = i < W - 1 && j < H - 1 && (sigma[c + 1] || sigma[c + W]) ? link(c, c + W + 1, CORNER) : 0;
    kSW[c] = i > 0 && j < H - 1 && (sigma[c - 1] || sigma[c + W]) ? link(c, c + W - 1, CORNER) : 0;
    if (sigma[c]) {
      let g = 0;
      if (i === 0 && config.ground.left) g += sigma[c];
      if (i === W - 1 && config.ground.right) g += sigma[c];
      if (j === 0 && config.ground.top) g += sigma[c];
      if (j === H - 1 && config.ground.bottom) g += sigma[c];
      ground[c] = g;
    }
  }
  for (let c = 0; c < N; c++) {
    const i = c % W;
    let d = kE[c] + kS[c] + kSE[c] + kSW[c] + ground[c];
    if (i > 0) d += kE[c - 1];
    if (c >= W) { d += kS[c - W]; if (i > 0) d += kSE[c - W - 1]; if (i < W - 1) d += kSW[c - W + 1]; }
    diag[c] = d;
  }
}

// Solves for the potential in the open cells with the held cells at `held(n)` (by electrode), warm-started from `x`:
// conjugate gradients with a symmetric Gauss-Seidel preconditioner, `iterations` steps.
function solve(E, x, held) {
  const { W, N, kind, which, diag, kE, kS, kSE, kSW, free, config } = E, { b, r, z, s, q } = E.cg, iterations = config.iterations;
  let low = Infinity, high = -Infinity;
  for (let c = 0; c < N; c++) {
    free[c] = kind[c] === OPEN && diag[c] > 0 ? 1 : 0; b[c] = 0;
    if (kind[c] === HELD) { x[c] = held(which[c]); if (x[c] < low) low = x[c]; if (x[c] > high) high = x[c]; } else if (!free[c]) x[c] = 0;
  }
  // Every held cell at one potential, and no grounded edge pulling elsewhere (or all at 0 V): the potential is that
  // everywhere, with no field at all, however slowly a solve would get there.
  if (low === high && (!low || !EDGES.some(edge => config.ground[edge]))) { for (let c = 0; c < N; c++) if (free[c]) x[c] = low; return; }
  // Held cells put their potential into their open neighbours' right-hand side.
  const pair = (a, n, k) => { if (free[a] && kind[n] === HELD) b[a] += k * x[n]; else if (free[n] && kind[a] === HELD) b[n] += k * x[a]; };
  for (let c = 0; c < N; c++) {
    if (kE[c]) pair(c, c + 1, kE[c]);
    if (kS[c]) pair(c, c + W, kS[c]);
    if (kSE[c]) pair(c, c + W + 1, kSE[c]);
    if (kSW[c]) pair(c, c + W - 1, kSW[c]);
  }
  // A × v over the open cells (the others count as zero).
  const times = (v, out) => {
    for (let c = 0; c < N; c++) out[c] = free[c] ? diag[c] * v[c] : 0;
    for (let c = 0; c < N; c++) {
      if (!free[c]) continue;
      let k = kE[c], n = c + 1;
      if (k && free[n]) { out[c] -= k * v[n]; out[n] -= k * v[c]; }
      k = kS[c]; n = c + W;
      if (k && free[n]) { out[c] -= k * v[n]; out[n] -= k * v[c]; }
      k = kSE[c]; n = c + W + 1;
      if (k && free[n]) { out[c] -= k * v[n]; out[n] -= k * v[c]; }
      k = kSW[c]; n = c + W - 1;
      if (k && free[n]) { out[c] -= k * v[n]; out[n] -= k * v[c]; }
    }
  };
  // Symmetric Gauss-Seidel: a forward sweep, then a backward one. Cells that are not open hold zero, so links to them
  // add nothing.
  const precondition = (from, out) => {
    for (let c = 0; c < N; c++) {
      if (!free[c]) { out[c] = 0; continue; }
      let t = from[c];
      if (c > 0) t += kE[c - 1] * out[c - 1];
      if (c >= W) { t += kS[c - W] * out[c - W] + kSW[c - W + 1] * out[c - W + 1]; if (c > W) t += kSE[c - W - 1] * out[c - W - 1]; }
      out[c] = t / diag[c];
    }
    for (let c = N - 1; c >= 0; c--) {
      if (!free[c]) continue;
      let t = 0;
      if (kE[c]) t += kE[c] * out[c + 1];
      if (kS[c]) t += kS[c] * out[c + W];
      if (kSE[c]) t += kSE[c] * out[c + W + 1];
      if (kSW[c]) t += kSW[c] * out[c + W - 1];
      out[c] += t / diag[c];
    }
  };
  times(x, q);
  let rz = 0;
  for (let c = 0; c < N; c++) r[c] = free[c] ? b[c] - q[c] : 0;
  precondition(r, z);
  for (let c = 0; c < N; c++) { s[c] = z[c]; rz += r[c] * z[c]; }
  // Done early once the residual has fallen a millionfold (rz is its square, preconditioned): the same arithmetic in
  // the same order on every engine, so the same step it stops at.
  const enough = rz * 1e-12;
  for (let it = 0; it < iterations && rz > 1e-24 && rz > enough; it++) {
    times(s, q);
    let sq = 0;
    for (let c = 0; c < N; c++) sq += s[c] * q[c];
    if (!(sq > 0)) break;
    const alpha = rz / sq;
    for (let c = 0; c < N; c++) if (free[c]) { x[c] += alpha * s[c]; r[c] -= alpha * q[c]; }
    precondition(r, z);
    let next = 0;
    for (let c = 0; c < N; c++) next += r[c] * z[c];
    const beta = next / rz;
    rz = next;
    for (let c = 0; c < N; c++) s[c] = z[c] + beta * s[c];
  }
}
// Current out of each electrode for the field `x`, held cells included.
function electrodeCurrents(E, x) {
  const { W, N, kind, which, kE, kS, kSE, kSW, ground } = E, out = new Float64Array(E.electrodes.length);
  const flow = (a, b, k) => {
    const f = k * (x[a] - x[b]);
    if (kind[a] === HELD) out[which[a]] += f;
    if (kind[b] === HELD) out[which[b]] -= f;
  };
  for (let c = 0; c < N; c++) {
    const i = c % W;
    if (kE[c]) flow(c, c + 1, kE[c]);
    if (kS[c]) flow(c, c + W, kS[c]);
    if (kSE[c]) flow(c, c + W + 1, kSE[c]);
    if (kSW[c] && i > 0) flow(c, c + W - 1, kSW[c]);
    if (ground[c] && kind[c] === HELD) out[which[c]] += ground[c] * x[c];
  }
  return out;
}

// Gaussian elimination with partial pivoting on a small dense system; returns the solution.
function dense(A, b) {
  const n = b.length;
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i;
    [A[k], A[p]] = [A[p], A[k]]; [b[k], b[p]] = [b[p], b[k]];
    if (!A[k][k]) continue;
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / A[k][k];
      for (let j = k; j < n; j++) A[i][j] -= f * A[k][j];
      b[i] -= f * b[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let t = b[i];
    for (let j = i + 1; j < n; j++) t -= A[i][j] * x[j];
    x[i] = A[i][i] ? t / A[i][i] : 0;
  }
  return x;
}

// The field for this step: the ideal electrodes at their voltages, and each supplied electrode at the potential the
// circuit gives it (its supply through its resistance, its stored charge, and what the gas draws).
function field(E, dt) {
  const { N, electrodes, cycle } = E, supplied = [], idealAt = new Float64Array(electrodes.length);
  electrodes.forEach((e, n) => { if (e.resistance) supplied.push(n); else idealAt[n] = e.voltage[cycle]; });
  if (!E.fixed) E.fixed = new Float64Array(N);
  const anyIdeal = idealAt.some(v => v !== 0);
  if (anyIdeal) solve(E, E.fixed, n => idealAt[n]); else E.fixed.fill(0);
  const phi = E.phi;
  phi.set(E.fixed);
  if (!supplied.length) { electrodes.forEach((e, n) => { e.phi = idealAt[n]; }); return; }
  const I0 = anyIdeal ? electrodeCurrents(E, E.fixed) : new Float64Array(electrodes.length), G = [];
  for (const n of supplied) {
    if (!E.basis[n]) E.basis[n] = new Float64Array(N);
    solve(E, E.basis[n], m => (m === n ? 1 : 0));
    G.push(electrodeCurrents(E, E.basis[n]));
  }
  // (C/dt + 1/R) φ' + Σ G φ' = C φ / dt + V / R − I0, for each supplied electrode.
  const A = supplied.map((n, a) => supplied.map((m, b) => G[b][n] + (a === b ? electrodes[n].charge / dt + 1 / electrodes[n].resistance : 0)));
  const rhs = supplied.map(n => { const e = electrodes[n]; return e.charge * e.phi / dt + e.voltage[cycle] / e.resistance - I0[n]; });
  const at = dense(A, rhs);
  // A network of conductors driven by its supplies holds every potential between theirs (a stored charge drives too), so
  // a supplied electrode never goes past them. A field solve that has not converged (a long channel laid in one step, a
  // pool's water) can ask for more; it is held to that range.
  let lo = 0, hi = 0;
  electrodes.forEach((e, n) => { for (const v of e.resistance ? [e.voltage[cycle], ...(e.charge ? [e.phi] : [])] : [idealAt[n]]) { if (v < lo) lo = v; if (v > hi) hi = v; } });
  for (let a = 0; a < at.length; a++) at[a] = at[a] < lo ? lo : at[a] > hi ? hi : at[a];
  supplied.forEach((n, a) => { electrodes[n].phi = at[a]; const B = E.basis[n]; for (let c = 0; c < N; c++) phi[c] += at[a] * B[c]; });
  electrodes.forEach((e, n) => { if (!e.resistance) e.phi = idealAt[n]; });
}

// Current through each cell: half the magnitude of everything crossing its links, so a channel's cells carry its current.
function currents(E) {
  const { W, N, kE, kS, kSE, kSW, ground, phi, current } = E;
  current.fill(0);
  const flow = (a, b, k) => {
    const d = phi[a] - phi[b], f = k * (d < 0 ? -d : d);
    current[a] += 0.5 * f; current[b] += 0.5 * f;
  };
  for (let c = 0; c < N; c++) {
    const i = c % W;
    if (kE[c]) flow(c, c + 1, kE[c]);
    if (kS[c]) flow(c, c + W, kS[c]);
    if (kSE[c]) flow(c, c + W + 1, kSE[c]);
    if (kSW[c] && i > 0) flow(c, c + W - 1, kSW[c]);
    if (ground[c]) { const d = phi[c]; current[c] += 0.5 * ground[c] * (d < 0 ? -d : d); }
  }
}

// ---- Plasma markers ----------------------------------------------------------------------------------------------------
// Plasma is a graph of markers, about one per cell, each linked to the conductor it grew from (and to a second one it
// joined, which closes a circuit). Links are drawn as lines, so a channel stays unbroken as the flow stretches it; a link
// longer than SPLIT gets a marker in its middle, and two markers in one cell merge.
const SPLIT = 1.5, WOBBLE = 0.15, HOPS = 4;
const sample = (a, nx, ny, fx, fy) => {
  if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
  if (fy < 0) fy = 0; else if (fy > ny - 1) fy = ny - 1;
  let i = Math.floor(fx), j = Math.floor(fy);
  if (i > nx - 2) i = nx - 2;
  if (j > ny - 2) j = ny - 2;
  const s = fx - i, t = fy - j, k = j * nx + i;
  return (a[k] * (1 - s) + a[k + 1] * s) * (1 - t) + (a[k + nx] * (1 - s) + a[k + nx + 1] * s) * t;
};
const join = (a, b) => { if (a !== b && !a.links.includes(b)) { a.links.push(b); b.links.push(a); } };
const part = (a, b) => { a.links.splice(a.links.indexOf(b), 1); b.links.splice(b.links.indexOf(a), 1); };
const cellOf = (E, m) => Math.floor(m.y) * E.W + Math.floor(m.x);
const anchorAt = (E, c) => E.kind[c] === HELD || lands(E.matter[c]);
// Whether cell (i, j) has an electrode, metal or water cell among its eight neighbours.
function touches(E, i, j) {
  const { W, H } = E;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const x = i + di, y = j + dj;
    if ((di || dj) && x >= 0 && y >= 0 && x < W && y < H && anchorAt(E, y * W + x)) return true;
  }
  return false;
}

// Whether cell (i, j) has water among its eight neighbours (and no electrode or metal, which a foot slides along).
function onWater(E, i, j) {
  const { W, H, matter, kind } = E;
  let wet = false;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const x = i + di, y = j + dj;
    if (!(di || dj) || x < 0 || y < 0 || x >= W || y >= H) continue;
    const c = y * W + x;
    if (kind[c] === HELD || matter[c] === METAL) return false;
    if (matter[c] === WATER) wet = true;
  }
  return wet;
}

// Markers ride the flow. A channel moves as one string: each marker takes the mean of the flow at itself and at the
// markers it links to, twice over, so the ends of an arc, held still against an electrode, follow the column the hot
// gas lifts instead of pinning it; then each channel moves mostly as one body. A root (a marker beside an electrode or
// metal) slides along the metal instead of leaving it: it hops from cell to neighbouring cell beside the metal, up to
// HOPS a step, each hop the one that goes furthest along its move. Any other marker that would enter an obstacle keeps
// the part of its move that stays open.
function moveMarkers(E, g, dt) {
  const { W, H } = E, { u, v } = g, solid = g.pixels, list = E.markers, n = list.length;
  const U = (x, y) => sample(u, W + 1, H, x, y - 0.5), V = (x, y) => sample(v, W, H + 1, x - 0.5, y);
  list.forEach((m, k) => { m.k = k; });
  const vx = new Float64Array(n), vy = new Float64Array(n), wx = new Float64Array(n), wy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const m = list[k], mx = m.x + 0.5 * dt * U(m.x, m.y), my = m.y + 0.5 * dt * V(m.x, m.y);
    vx[k] = U(mx, my); vy[k] = V(mx, my);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      let sx = vx[k], sy = vy[k];
      for (const o of list[k].links) { sx += vx[o.k]; sy += vy[o.k]; }
      wx[k] = sx / (1 + list[k].links.length); wy[k] = sy / (1 + list[k].links.length);
    }
    vx.set(wx); vy.set(wy);
  }
  // Each connected channel moves mostly as one body: its mean velocity, plus WOBBLE of each marker's own difference.
  const group = new Int32Array(n).fill(-1), stack = [];
  for (let k = 0, groups = 0; k < n; k++) {
    if (group[k] >= 0) continue;
    const members = [];
    group[k] = groups; stack.push(k);
    while (stack.length) { const a = stack.pop(); members.push(a); for (const o of list[a].links) if (group[o.k] < 0) { group[o.k] = groups; stack.push(o.k); } }
    groups++;
    if (members.length < 2) continue;
    members.sort((a, b) => a - b);
    let mx = 0, my = 0;
    for (const a of members) { mx += vx[a]; my += vy[a]; }
    mx /= members.length; my /= members.length;
    for (const a of members) { vx[a] = mx + WOBBLE * (vx[a] - mx); vy[a] = my + WOBBLE * (vy[a] - my); }
  }
  const open = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !solid[j * W + i];
  const clampTo = (value, cell) => (value < cell + 0.01 ? cell + 0.01 : value > cell + 0.99 ? cell + 0.99 : value);
  let kept = 0;
  for (let k = 0; k < n; k++) {
    const m = list[k], x = m.x + dt * vx[k], y = m.y + dt * vy[k], i = Math.floor(x), j = Math.floor(y);
    // A marker carried out through an open edge leaves.
    if (x < 0 || y < 0 || x >= W || y >= H) { for (const o of [...m.links]) part(m, o); continue; }
    const oi = Math.floor(m.x), oj = Math.floor(m.y);
    // An arc's foot on water stays where it struck: dragged along the surface by the steam it raises, it drew long
    // channels over the water that the next stroke ran down.
    if (onWater(E, oi, oj)) { list[kept++] = m; continue; }
    if (touches(E, oi, oj)) {
      if (open(i, j) && touches(E, i, j)) { m.x = x; m.y = y; list[kept++] = m; continue; }
      // Hop while at least half a cell of the move is left, each time to the neighbouring cell beside the metal that goes
      // furthest along it (so a root climbs a leaning rod as the column above it rises).
      const mx = x - m.x, my = y - m.y, length = Math.sqrt(mx * mx + my * my);
      let bx = oi, by = oj;
      for (let hop = 0; hop < HOPS && length > 0; hop++) {
        if (((x - bx - 0.5) * mx + (y - by - 0.5) * my) / length <= 0.5) break;
        let ahead = 0, nx = bx, ny = by;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ci = bx + di, cj = by + dj;
          if ((!di && !dj) || !open(ci, cj) || !touches(E, ci, cj)) continue;
          const along = (di * mx + dj * my) * (di && dj ? DIAGONAL : 1);
          if (along > ahead) { ahead = along; nx = ci; ny = cj; }
        }
        if (nx === bx && ny === by) break;
        bx = nx; by = ny;
      }
      m.x = clampTo(x, bx); m.y = clampTo(y, by);
    } else if (open(i, j)) { m.x = x; m.y = y; } else if (open(i, Math.floor(m.y))) m.x = x; else if (open(Math.floor(m.x), j)) m.y = y;
    list[kept++] = m;
  }
  list.length = kept;
}

// Merges markers that share a cell (the earlier one stays, with the stronger ionization and both one's links) and puts
// a marker in the middle of every link longer than SPLIT. Over a liquid, a marker whose cell the water or ice has taken
// goes out: plasma burns in the air.
function tidy(E) {
  const { owner, matter } = E, list = E.markers;
  owner.fill(-1);
  let kept = 0;
  for (let k = 0; k < list.length; k++) {
    const m = list[k], c = cellOf(E, m);
    if (matter[c] >= WATER) { for (const n of [...m.links]) part(m, n); continue; }
    if (owner[c] < 0) { owner[c] = kept; list[kept++] = m; continue; }
    const o = list[owner[c]];
    if (m.ion > o.ion) o.ion = m.ion;
    if (m.trace > o.trace) o.trace = m.trace;
    for (const n of [...m.links]) { part(m, n); join(o, n); }
  }
  list.length = kept;
  list.forEach((m, k) => { m.k = k; });
  for (let k = 0; k < list.length && list.length < LIMITS.markers; k++) {
    const a = list[k];
    for (let l = 0; l < a.links.length; l++) {
      const b = a.links[l];
      if (b.k < a.k) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx * dx + dy * dy <= SPLIT * SPLIT) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ion: a.ion < b.ion ? a.ion : b.ion, trace: a.trace < b.trace ? a.trace : b.trace, links: [], k: list.length };
      // A midpoint in a cell another marker holds joins that marker instead.
      const c = cellOf(E, m), there = owner[c] >= 0 ? list[owner[c]] : null;
      part(a, b); l--;
      if (there && there !== a && there !== b) { join(a, there); join(there, b); continue; }
      if (there) { join(a, b); l++; continue; }
      owner[c] = list.length; list.push(m); join(a, m); join(m, b);
    }
  }
  E.markers.forEach((m, k) => { m.k = k; });
}

// Ionization from the markers and the lines between them (each cell takes the strongest), and, with `ionize`, from heat.
// `line` notes, for a cell a line crosses without a marker of its own, the marker at the line's nearer end.
function raster(E, T) {
  const { N, W, ion, owner, line, markers, config, kind, matter } = E;
  const { trace } = E;
  ion.fill(0); trace.fill(0); owner.fill(-1); line.fill(-1);
  markers.forEach((m, k) => { const c = cellOf(E, m); owner[c] = k; if (m.ion > ion[c]) ion[c] = m.ion; if (m.trace > trace[c]) trace[c] = m.trace; });
  for (const a of markers) for (const b of a.links) {
    if (b.k < a.k) continue;
    const level = a.ion < b.ion ? a.ion : b.ion, left = a.trace < b.trace ? a.trace : b.trace, ax = Math.floor(a.x), ay = Math.floor(a.y), bx = Math.floor(b.x), by = Math.floor(b.y);
    traceLine(ax, ay, bx, by, (x, y) => {
      const c = y * W + x;
      if (kind[c] !== OPEN || matter[c] || owner[c] >= 0) return;
      if (level > ion[c]) ion[c] = level;
      if (left > trace[c]) trace[c] = left;
      if (line[c] < 0) { const da = (x - ax) * (x - ax) + (y - ay) * (y - ay), db = (x - bx) * (x - bx) + (y - by) * (y - by); line[c] = da <= db ? a.k : b.k; }
    });
  }
  // Thermal plasma on the shared heat scale: none at `ionize` (by default 2, above every flame, so fire never ionizes by
  // accident; 0 turns it off), fully ionized half as hot again. Never inside an insulator: over a liquid the temperature
  // field holds each obstacle at its own temperature, and a hot plain obstacle read as plasma grew arcs as if it were
  // grounded metal. (An electrode the gas flows through, a decoration with a voltage, holds gas, which may ionize.)
  if (config.ionize) {
    const start = config.ionize, full = 1.5 * start;
    for (let c = 0; c < N; c++) if (T[c] > start && kind[c] !== INSULATOR && matter[c] < WATER) { const t = T[c] >= full ? 1 : (T[c] - start) / (full - start); if (t > ion[c]) ion[c] = t; }
  }
}

// x^p for p ≥ 0, exact at whole powers and blended linearly between them, so only + − × ÷ are used.
function power(x, p) {
  const n = Math.floor(p), f = p - n;
  let a = 1;
  for (let i = 0; i < n; i++) a *= x;
  return f ? a * (1 - f + f * x) : a;
}

// Breakdown: `growth` / substeps cells a step beside the conductors, drawn one at a time by chance in proportion to
// (E / breakdown)^focus − 1 among the cells whose field E exceeds their breakdown, as the dielectric breakdown model
// draws them. The field is solved once a step; after each draw the new cell takes the potential of the plasma it grew
// from and the potential is relaxed in a window around it (RELAX cells each way, a few Gauss-Seidel sweeps), so the next
// draw sees the field gathered at the new tip, as a fresh solve would show it. A new marker links to the plasma it grew
// from (the neighbour across which the field is strongest) and to the neighbouring plasma whose potential differs most
// from that one's, when the two differ by more than the breakdown field: the cell that bridges a gap joins both sides.
const RELAX = 4, SWEEPS = 3, DART = 16, MARK = 0.25;
function grow(E, T, seed, dt) {
  const { W, H, N, kind, matter, ion, phi, config, markers, owner, line, diag, kE, kS, kSE, kSW } = E, ground = config.ground;
  if (!E.weight) { E.weight = new Float64Array(N); E.source = new Int32Array(N); E.drop = new Float64Array(N); E.room = new Float64Array(N); }
  const { weight, source, drop, room } = E, charged = [];
  const conducts = c => kind[c] === HELD || (matter[c] ? lands(matter[c]) : ion[c] >= CHANNEL);
  const grounded = (i, j) => (i === 0 && ground.left) || (i === W - 1 && ground.right) || (j === 0 && ground.top) || (j === H - 1 && ground.bottom);
  // The chance weight of cell (i, j), noting the conductor it would grow from and the field across to it.
  // A burning arc (plasma carrying at least `sustain`) grows no branches: only electrodes, metal, leaders and broken
  // channels do. Water takes an arc that reaches it but, like a grounded edge, grows none of its own.
  const seeds = c => kind[c] === HELD || (matter[c] ? matter[c] === METAL : ion[c] >= CHANNEL && E.current[c] < config.sustain);
  // `drop` keeps each cell's field and `room` how far it is over the breakdown an old channel's trace leaves there, for
  // the dart cascade below.
  const rate = (i, j) => {
    const c = j * W + i;
    drop[c] = 0; room[c] = 0;
    if (kind[c] !== OPEN || matter[c] || ion[c] >= CHANNEL) return 0;
    let e = 0, from = -1;
    const here = phi[c];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const n = y * W + x;
      if (!seeds(n)) continue;
      // Not across a corner both of whose side cells are insulators.
      if (di && dj && kind[j * W + x] === INSULATOR && kind[y * W + i] === INSULATOR) continue;
      let d = phi[n] - here; if (d < 0) d = -d;
      if (di && dj) d *= DIAGONAL;
      if (d > e) { e = d; from = n; }
    }
    // A grounded edge takes an arc that reaches it, but grows none of its own (it stands for the world beyond the canvas).
    if (e && grounded(i, j)) { const d = here < 0 ? -here : here; if (d > e) e = d; }
    if (!e) return 0;
    source[c] = from; drop[c] = e;
    const t = T[c] > 0 ? T[c] : 0, limit = config.breakdown * (1 - MEMORY * ion[c] / CHANNEL) / (1 + HOT * t);
    const trace = E.trace[c] < CHANNEL ? E.trace[c] / CHANNEL : 1;
    if (config.memory && E.trace[c] >= MARK) room[c] = e / (limit * (1 - MEMORY * trace));
    return e <= limit ? 0 : power(e / limit, config.focus) - 1;
  };
  let total = 0;
  for (let j = 0, c = 0; j < H; j++) for (let i = 0; i < W; i++, c++) { weight[c] = rate(i, j); total += weight[c]; }
  const markerIn = c => (c < 0 ? null : owner[c] >= 0 ? markers[owner[c]] : line[c] >= 0 ? markers[line[c]] : null);
  const picks = Math.max(1, Math.floor(config.growth * dt + 0.5));
  // Ionizes cell c: a marker linked to the plasma it grows from, the potential relaxed around it, the chances redrawn.
  const strike = c => {
    const i = c % W, j = (c - i) / W, from = source[c];
    const m = { x: i + 0.5, y: j + 0.5, ion: 1, trace: 1, links: [], k: markers.length };
    const a = markerIn(from);
    if (a) join(m, a);
    // The other side of a gap: the neighbouring conductor whose potential differs most from the source's.
    const base = from >= 0 ? phi[from] : 0;
    let far = -1, gap = config.breakdown;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if ((!di && !dj) || x < 0 || y < 0 || x >= W || y >= H) continue;
      const n = y * W + x;
      if (!conducts(n)) continue;
      let d = phi[n] - base; if (d < 0) d = -d;
      if (d > gap) { gap = d; far = n; }
    }
    const b = markerIn(far);
    if (b) join(m, b);
    owner[c] = markers.length; markers.push(m); ion[c] = 1; phi[c] = base;
    if (a) charged.push(a, drop[c] / config.breakdown);
    // Relax the potential around the new cell, holding every conductor, then redraw the chances there.
    const x0 = i - RELAX < 0 ? 0 : i - RELAX, x1 = i + RELAX >= W ? W - 1 : i + RELAX, y0 = j - RELAX < 0 ? 0 : j - RELAX, y1 = j + RELAX >= H ? H - 1 : j + RELAX;
    for (let s = 0; s < SWEEPS; s++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const n = y * W + x;
      if (kind[n] !== OPEN || matter[n] || ion[n] >= CHANNEL || !diag[n]) continue;
      let sum = 0;
      if (kE[n]) sum += kE[n] * phi[n + 1];
      if (kS[n]) sum += kS[n] * phi[n + W];
      if (kSE[n]) sum += kSE[n] * phi[n + W + 1];
      if (kSW[n]) sum += kSW[n] * phi[n + W - 1];
      if (x > 0 && kE[n - 1]) sum += kE[n - 1] * phi[n - 1];
      if (y > 0) {
        if (kS[n - W]) sum += kS[n - W] * phi[n - W];
        if (x > 0 && kSE[n - W - 1]) sum += kSE[n - W - 1] * phi[n - W - 1];
        if (x < W - 1 && kSW[n - W + 1]) sum += kSW[n - W + 1] * phi[n - W + 1];
      }
      phi[n] = sum / diag[n];
    }
    for (let y = y0 - 1 < 0 ? 0 : y0 - 1; y <= (y1 + 1 >= H ? H - 1 : y1 + 1); y++) for (let x = x0 - 1 < 0 ? 0 : x0 - 1; x <= (x1 + 1 >= W ? W - 1 : x1 + 1); x++) {
      const n = y * W + x, w = rate(x, y);
      total += w - weight[n]; weight[n] = w;
    }
  };
  // The dart leader starts wherever an old channel's trace meets a conductor with field to spare.
  let frontier = [];
  for (let c = 0; c < N && markers.length < LIMITS.markers; c++) if (room[c] > 1) { strike(c); frontier.push(c); }
  for (let k = 0; k < picks && total > 0 && markers.length < LIMITS.markers; k++) {
    let r = random(seed, SALT.pick, E.cycle, E.step, k) * total, c = -1;
    for (let n = 0; n < N; n++) if (weight[n] > 0) { c = n; r -= weight[n]; if (r < 0) break; }
    if (c < 0) break;
    strike(c);
    frontier.push(c);
  }
  // A strike that reaches an old channel runs down it at once, as a dart leader does: from each cell struck, the trace
  // cell beside it whose field most exceeds its lowered breakdown ionizes in the same step, DART rounds a step, beyond
  // the growth budget, so the new stroke follows the old path one pixel wide.
  for (let round = 0; round < DART && frontier.length && markers.length < LIMITS.markers; round++) {
    const next = [];
    for (const c of frontier) {
      const i = c % W, j = (c - i) / W;
      let best = -1;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, y = j + dj, n = y * W + x;
        if ((!di && !dj) || x < 0 || y < 0 || x >= W || y >= H || !(room[n] > 1)) continue;
        if (best < 0 || room[n] > room[best]) best = n;
      }
      if (best >= 0 && markers.length < LIMITS.markers) { strike(best); next.push(best); }
    }
    frontier = next;
  }
  charge(E, charged);
}
// A growing channel carries the current that charges each new cell to its potential, from the electrode out to the tip,
// so a leader that keeps growing stays ionized and one that stops fades. Each new cell feeds the markers on the way from
// the one it grew from back to a root (a marker beside an electrode, metal or grounded edge) its field over breakdown.
function charge(E, charged) {
  if (!charged.length) return;
  const { W, H, markers, config } = E, ground = config.ground, n = markers.length, depth = new Int32Array(n).fill(-1), queue = [];
  markers.forEach((m, k) => {
    m.k = k;
    const i = Math.floor(m.x), j = Math.floor(m.y);
    if (touches(E, i, j) || (i === 0 && ground.left) || (i === W - 1 && ground.right) || (j === 0 && ground.top) || (j === H - 1 && ground.bottom)) { depth[k] = 0; queue.push(k); }
  });
  for (let q = 0; q < queue.length; q++) for (const o of markers[queue[q]].links) if (depth[o.k] < 0) { depth[o.k] = depth[queue[q]] + 1; queue.push(o.k); }
  for (let p = 0; p < charged.length; p += 2) {
    let m = charged[p];
    const amount = charged[p + 1];
    if (depth[m.k] < 0) continue;
    for (;;) {
      m.feed = (m.feed ?? 0) + amount;
      if (!depth[m.k]) break;
      let next = null;
      for (const o of m.links) if (depth[o.k] === depth[m.k] - 1) { next = o; break; }
      m = next;
    }
  }
}

// One step of electricity in a gas: move and draw the plasma, solve the field, heat the gas, keep or lose the plasma,
// then grow it where the field breaks the gas down. Over a liquid, `liquid` is { matter, warm }: `matter[c]` is
// MATTER.water or MATTER.ice where the liquid holds cell c this step (0 in its air), and `warm(c, heat)` takes the Joule
// heat of those cells, per frame; `state` is the air's gas and the obstacles of `E.layout` its insulators.
export function stepElectric(E, state, effect, dt, liquid = null) {
  const { g, T } = state, config = E.config, layout = E.layout ?? effect.layout, solids = state.solids ?? layout;
  if (E.layoutKey !== layout.key || E.solids !== solids) { buildMasks(E, effect, layout, solids.solid); E.solids = solids; }
  const { N, kind, metal } = E;
  if (liquid) {
    const matter = E.matter = E.wet ??= new Uint8Array(N);
    for (let c = 0; c < N; c++) matter[c] = kind[c] === OPEN && !metal[c] ? liquid.matter[c] : metal[c];
  }
  moveMarkers(E, g, dt);
  tidy(E);
  raster(E, T);
  if (E.electrodes.length) {
    assemble(E);
    field(E, dt);
    currents(E);
  }
  const { current, markers, matter } = E;
  // Current heats the gas, `heating` × current² a frame, and over a liquid its water and ice. Joule heat is current² ÷
  // conductivity, so water and ice, which conduct worse than a channel of full plasma, take that much more for the same
  // current (water 16 times): the current spreads out as soon as it enters a pool, and the water at the arc's foot boils.
  if (config.heating && E.electrodes.length) {
    for (let c = 0; c < N; c++) {
      if (kind[c] !== OPEN || !current[c]) continue;
      const heat = config.heating * current[c] * current[c];
      if (!matter[c]) T[c] += heat * dt; else if (matter[c] >= WATER) liquid.warm(c, heat * PLASMA / MATTER_SIGMA[matter[c]]);
    }
  }
  // Current keeps plasma ionized (fully from `sustain`); otherwise it recombines, more slowly the hotter it is.
  for (const m of markers) {
    const c = cellOf(E, m), t = T[c] > 0 ? T[c] : 0, lit = current[c] / config.sustain, drive = (lit >= OUT ? lit : 0) + (m.feed ?? 0), held = drive >= 1 ? 1 : drive;
    m.feed = 0;
    if (held >= m.ion) m.ion += (held - m.ion) * (dt < 1 ? dt : 1);
    else m.ion += (held - m.ion) * config.recombine * dt / (1 + HOT * t);
    // The trace: what is left of a channel after its glow, fading over `memory` frames, so a new strike takes the old path.
    if (m.ion > m.trace) m.trace = m.ion; else m.trace = config.memory ? m.trace - m.trace * dt / config.memory : 0;
  }
  let kept = 0;
  for (const m of markers) { if (m.ion >= FADED || m.trace >= FADED) markers[kept++] = m; else for (const o of [...m.links]) part(m, o); }
  markers.length = kept;
  markers.forEach((m, k) => { m.k = k; });
  raster(E, T);
  if (E.electrodes.length) grow(E, T, effect.seed, dt);
  E.step++;
}

// The ionization (0–1) and current (per cell) fields the look reads: current where it runs through the gas only.
export function electricFields(E, state, ionization, current) {
  const { N } = E;
  raster(E, state.T);
  ionization.set(E.ion);
  for (let c = 0; c < N; c++) current[c] = E.kind[c] === OPEN && !E.matter[c] ? E.current[c] : 0;
}
