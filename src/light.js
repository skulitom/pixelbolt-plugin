// Light that spreads from what shines, for effects whose fire, lava or arcs light what is around them. `spreadLight`
// floods light from the cells that shine through a grid of open and solid cells: it loses 1 / reach with every pixel
// of open air and 1 / depth with every pixel into or out of a solid. So the light takes the shape of the space it is
// in: it lights the faces of solids and leaves their insides dark, and what lies behind a solid is lit only round its
// corners, by a longer way, and so less. A light made this way is never a disc laid over a scene: where it shows and
// how far it gets come from what it meets. (The model is the one the game Tetherbore lights its tunnels with.)
// What must stay true: browser-compatible and the same on every engine (only + − × ÷; cells start in index order and
// their neighbours are visited in the order of STEP), and light is never raised by less than CLEAR, which is what ends
// the flood.
// The formats that have such a light (a fluid effect's `shine`, a particle effect's) share the rest of this file too:
// `readLight` reads how the light looks, `meanOfFive` turns what shines into each cell's power, `lightCodes` cuts a
// frame's light into the colours of what it falls on and `codeGrid` makes those a grid operation. What shines, and
// what is solid, each format says for itself.
import { fail, parseColor } from './core.js';
import { fields, number } from './authoring.js';
import { patternProblem, ditherThreshold, feathersOf } from './craft.js';

const DIAGONAL = 1.41421356, KNIGHT = 2.23606798, CLEAR = 1 / 1024;
// The sixteen steps from a cell: [across, down, length, then the two cells the step passes between, as offsets]. With
// the knight's moves beside the straight and diagonal ones, light in the open falls off in a round, not an octagon.
const STEP = [
  [1, 0, 1, 0, 0, 0, 0], [-1, 0, 1, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0], [0, -1, 1, 0, 0, 0, 0],
  [1, 1, DIAGONAL, 1, 0, 0, 1], [-1, 1, DIAGONAL, -1, 0, 0, 1], [1, -1, DIAGONAL, 1, 0, 0, -1], [-1, -1, DIAGONAL, -1, 0, 0, -1],
  [1, 2, KNIGHT, 0, 1, 1, 1], [-1, 2, KNIGHT, 0, 1, -1, 1], [1, -2, KNIGHT, 0, -1, 1, -1], [-1, -2, KNIGHT, 0, -1, -1, -1],
  [2, 1, KNIGHT, 1, 0, 1, 1], [-2, 1, KNIGHT, -1, 0, -1, 1], [2, -1, KNIGHT, 1, 0, 1, -1], [-2, -1, KNIGHT, -1, 0, -1, -1]
];

// A flood's working memory for a width × height grid: made once and used for every frame of a run.
export function createLight(width, height) {
  const N = width * height;
  return { width, height, light: new Float64Array(N), queue: new Int32Array(N), queued: new Uint8Array(N) };
}

// The light that reaches every cell: `power` is how much each cell shines of itself (0 for one that doesn't; 1 is a
// full light), `solid` marks the cells that drink light, `reach` is how many pixels of open air a full light crosses
// before it is gone, and `depth` how many pixels into a solid it gets. Each cell takes the most light that reaches it
// by any way: its own, or a neighbour's less the step between them. A step that starts or ends in a solid costs the
// solid's rate. So does a diagonal step between two solid cells that touch at their corners, and a knight's move past
// a solid cell, so no light leaks through a wall one pixel thick. Returns `memory.light`, which the next call
// overwrites.
export function spreadLight(memory, power, solid, reach, depth) {
  const { width, height, light, queue, queued } = memory, N = width * height, air = 1 / reach, rock = 1 / depth;
  let head = 0, waiting = 0;
  light.fill(0);
  for (let c = 0; c < N; c++) if (power[c] > 0) { light[c] = power[c]; queue[waiting++] = c; queued[c] = 1; }
  while (waiting) {
    const c = queue[head];
    head = head + 1 === N ? 0 : head + 1; waiting--; queued[c] = 0;
    const here = light[c], x = c % width, y = (c - x) / width;
    for (let s = 0; s < 16; s++) {
      const step = STEP[s], nx = x + step[0], ny = y + step[1];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      let through = solid[c] || solid[j];
      if (!through && s > 3) {
        const a = solid[c + step[4] * width + step[3]], b = solid[c + step[6] * width + step[5]];
        through = s > 7 ? a || b : a && b;
      }
      const next = here - (through ? rock : air) * step[2];
      if (next <= light[j] + CLEAR) continue;
      light[j] = next;
      if (!queued[j]) { queue[head + waiting < N ? head + waiting : head + waiting - N] = j; waiting++; queued[j] = 1; }
    }
  }
  return light;
}

// ---- A format's `shine` --------------------------------------------------------------------------------------------
// What each pixel of a frame is to the light: nothing drawn (it takes `wall`), something drawn that is no surface (it
// takes `smoke`), a surface (`colors`, or `dark` where no light reaches), or what shines, which takes nothing: light
// is never laid over what gives it.
export const EMPTY = 0, DRAWN = 1, SURFACE = 2, SHINING = 3;
const LISTS = ['colors', 'smoke', 'wall'], MOST = 16;

/**
 * How a `shine` looks, read the same way for every format: `reach` (the pixels of open air a full light crosses),
 * `depth` (the pixels it gets into a solid; a solid drinks light about as much faster than air as rock does in the
 * game the model is from), `ease` (the share of the way each pixel's light moves in a frame to what reached it),
 * `thresholds` (rising shares of full light) and a palette key for each of them in `colors`, `smoke` and `wall`,
 * feathered in below its threshold through `dither` and `pattern` as a look's bands are, and `dark`. A colour that is
 * fully clear has code 0: at that level what is drawn shows as it is.
 * `own` names the fields the format reads itself (what shines), `on` says what its colors and smoke lie on, for the
 * messages, and `key(value, path, palette)` is the format's check of a one-character palette key.
 */
export function readLight(value, path, { palette, seed, key }, own, on) {
  fields(value, [...own, 'reach', 'depth', 'ease', 'thresholds', ...LISTS, 'dark', 'dither', 'pattern'], path);
  if (!Array.isArray(value.thresholds) || !value.thresholds.length || value.thresholds.length > MOST) fail(`${path}.thresholds`, `expected 1–${MOST} rising shares of full light, each above 0 and at most 1: one for each colour`);
  const thresholds = value.thresholds.map((share, i) => {
    number(share, `${path}.thresholds[${i}]`, 0.001, 1);
    if (i && share <= value.thresholds[i - 1]) fail(`${path}.thresholds[${i}]`, 'thresholds must rise from one colour to the next');
    return share;
  });
  const code = (name, where) => { const known = key(name, where, palette); return parseColor(palette[known], palette)[3] ? known.charCodeAt(0) : 0; };
  if (!LISTS.some(list => value[list] !== undefined)) fail(`${path}.colors`, `expected colors (the light on ${on.colors}), smoke (on ${on.smoke}) or wall (on the empty pixels): palette keys, one for each threshold`);
  const [colors, smoke, wall] = LISTS.map(list => {
    if (value[list] === undefined) return null;
    if (!Array.isArray(value[list]) || value[list].length !== thresholds.length) fail(`${path}.${list}`, `expected ${thresholds.length} palette keys, one for each threshold, from the least light to the most`);
    return value[list].map((name, i) => code(name, `${path}.${list}[${i}]`));
  });
  const pattern = value.pattern ?? 'bayer4', problem = patternProblem(pattern);
  if (problem) fail(`${path}.pattern${problem[0]}`, problem[1]);
  const reach = number(value.reach, `${path}.reach`, 2, 128);
  return {
    reach, colors, smoke, wall, thresholds, gaps: thresholds.map((share, i) => share - (i ? thresholds[i - 1] : 0)),
    dark: value.dark === undefined ? 0 : code(value.dark, `${path}.dark`), dither: number(value.dither ?? 0.5, `${path}.dither`, 0, 1), threshold: ditherThreshold(pattern, [0, 0], seed),
    depth: number(value.depth ?? reach / 2.6, `${path}.depth`, 0.5, 64), ease: number(value.ease ?? 0.5, `${path}.ease`, 0.05, 1)
  };
}

// The mean of `level` over the five by five cells about each one, into `power` (through `across`, the sums along each
// row): the body of a flame lights and a lone bright pixel barely does. Beyond the canvas nothing shines.
export function meanOfFive(level, across, power, width, height) {
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    let sum = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(width - 1, i + 2); k++) sum += level[j * width + k];
    across[j * width + i] = sum;
  }
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    let sum = 0;
    for (let k = Math.max(0, j - 2); k <= Math.min(height - 1, j + 2); k++) sum += across[k * width + i];
    power[j * width + i] = sum / 25;
  }
}

// A frame's light as palette codes (0 where none shows), or null if none shows anywhere: `lit` is each pixel's light
// and `kinds` what each pixel is (EMPTY, DRAWN, SURFACE or SHINING). `shine` is what readLight returned.
export function lightCodes(shine, lit, kinds, width, height) {
  const { colors, smoke, wall, thresholds, gaps, dark } = shine, N = width * height, n = thresholds.length, lists = [wall, smoke, colors], feathers = feathersOf(shine, width, height);
  let codes = null;
  for (let c = 0; c < N; c++) {
    const kind = kinds[c];
    if (kind === SHINING) continue;
    const keys = lists[kind];
    if (!keys && !(kind === SURFACE && dark)) continue;
    const value = lit[c];
    let band = 0;
    while (band < n && value >= thresholds[band] - feathers[c] * gaps[band]) band++;
    const code = band ? (keys ? keys[band - 1] : 0) : kind === SURFACE ? dark : 0;
    if (code) (codes ??= new Uint16Array(N))[c] = code;
  }
  return codes;
}

// Palette codes over a canvas as a grid operation cropped to what they draw, or null if they draw nothing; with `keep`,
// only the pixels it passes.
export function codeGrid(codes, width, height, keep = null) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  if (codes) for (let c = 0; c < codes.length; c++) if (codes[c] && (!keep || keep(c))) { const x = c % width, y = (c - x) / width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const rows = [];
  for (let y = y0; y <= y1; y++) { let row = ''; for (let x = x0; x <= x1; x++) { const c = y * width + x, code = codes[c]; row += code && (!keep || keep(c)) ? String.fromCharCode(code) : '.'; } rows.push(row); }
  return { op: 'grid', x: x0, y: y0, rows };
}
