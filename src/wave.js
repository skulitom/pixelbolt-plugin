// Coherent procedural waves baked into ordinary palette grids. These are art-directed
// fields, not a water/obstacle solver. Sum signed sources before colour thresholds so
// opposite phases cancel. Integer cycles close the loop without blending its ends.
// Browser-compatible: craft's polynomial trigonometry and fixed-order arithmetic only.
import { PixelError, renderProject, readRows, parseColor } from './core.js';
import { fields } from './authoring.js';
import { sinDeg, cosDeg } from './craft.js';

export const WAVE_KINDS = ['radial', 'directional'];
const fail = (path, message) => { throw new PixelError(path, message); };
const num = (v, path, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(path, `expected a number from ${min} to ${max}`);
  return v;
};
const int = (v, path, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) fail(path, `expected an integer from ${min} to ${max}`);
  return v;
};
const pair = (v, path, min, max) => {
  if (!Array.isArray(v) || v.length !== 2) fail(path, 'expected [x, y]');
  return v.map((n, i) => num(n, `${path}[${i}]`, min, max));
};
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

function readEffect(effect, path, source) {
  fields(effect, ['frames', 'duration', 'sources', 'mask', 'look', 'underlay', 'overlay'], path);
  const frames = int(effect.frames, `${path}.frames`, 4, 128);
  const duration = int(effect.duration ?? 80, `${path}.duration`, 20, 1000);
  if (!Array.isArray(effect.sources) || effect.sources.length < 1 || effect.sources.length > 4) fail(`${path}.sources`, 'expected 1–4 coherent wave sources');
  const sources = effect.sources.map((s, i) => {
    const p = `${path}.sources[${i}]`;
    fields(s, ['kind', 'at', 'stretch', 'angle', 'wavelength', 'amplitude', 'cycles', 'phase'], p);
    if (!WAVE_KINDS.includes(s.kind)) fail(`${p}.kind`, 'expected radial or directional');
    if (s.kind === 'radial' && s.angle !== undefined) fail(`${p}.angle`, 'angle applies to a directional source');
    if (s.kind === 'directional' && s.stretch !== undefined) fail(`${p}.stretch`, 'stretch applies to a radial source');
    const angle = num(s.angle ?? 0, `${p}.angle`, -3600, 3600);
    return { kind: s.kind, at: pair(s.at, `${p}.at`, -4096, 4096),
      stretch: pair(s.stretch ?? [1, 1], `${p}.stretch`, 0.125, 8),
      direction: [cosDeg(angle), sinDeg(angle)], wavelength: num(s.wavelength, `${p}.wavelength`, 2, 256),
      amplitude: num(s.amplitude ?? 1, `${p}.amplitude`, 0, 4),
      cycles: int(s.cycles ?? 1, `${p}.cycles`, -16, 16), phase: num(s.phase ?? 0, `${p}.phase`, -3600, 3600) };
  });
  let mask = null;
  if (effect.mask !== undefined) {
    fields(effect.mask, ['at', 'radius', 'feather'], `${path}.mask`);
    mask = { at: pair(effect.mask.at, `${path}.mask.at`, -4096, 4096),
      radius: pair(effect.mask.radius, `${path}.mask.radius`, 0.5, 256),
      feather: num(effect.mask.feather ?? 0.2, `${path}.mask.feather`, 0, 1) };
  }
  fields(effect.look, ['colors', 'thresholds', 'negative'], `${path}.look`);
  const look = effect.look;
  if (!Array.isArray(look.colors) || !look.colors.length || look.colors.length > 8) fail(`${path}.look.colors`, 'expected 1–8 palette keys');
  const colors = (keys, p) => {
    if (!Array.isArray(keys) || keys.length !== look.colors.length) fail(p, 'expected one palette key per threshold');
    return keys.map((key, i) => {
      if (typeof key !== 'string' || key.length !== 1 || key === '.' || key === ' ' || !Object.hasOwn(source.palette, key)) fail(`${p}[${i}]`, 'expected a single-character key in the palette');
      return key;
    });
  };
  const positive = colors(look.colors, `${path}.look.colors`);
  const negative = look.negative === undefined ? null : colors(look.negative, `${path}.look.negative`);
  if (!Array.isArray(look.thresholds) || look.thresholds.length !== positive.length) fail(`${path}.look.thresholds`, 'expected one positive threshold per colour');
  const thresholds = look.thresholds.map((t, i) => {
    num(t, `${path}.look.thresholds[${i}]`, 0.000001, 16);
    if (i && t <= look.thresholds[i - 1]) fail(`${path}.look.thresholds[${i}]`, 'thresholds must increase strictly');
    return t;
  });
  const decoration = key => {
    if (effect[key] === undefined) return null;
    const { rows } = readRows(effect[key], `${path}.${key}`, source.palette);
    if (rows.length !== source.height || rows[0].length !== source.width) fail(`${path}.${key}`, 'expected a full-canvas grid');
    return rows;
  };
  return { frames, duration, sources, mask, positive, negative, thresholds, underlay: decoration('underlay'), overlay: decoration('overlay') };
}

/** A version-1 pixelforge-wave source → { recipe, metadata, warnings }. Loops only. */
export function compileWaves(source) {
  fields(source, ['format', 'version', 'name', 'width', 'height', 'palette', 'anchor', 'sheet', 'effects'], 'wave');
  if (source.format !== 'pixelforge-wave' || source.version !== 1) fail('wave', 'expected version-1 pixelforge-wave');
  const width = int(source.width, 'wave.width', 1, 128), height = int(source.height, 'wave.height', 1, 128);
  if (!source.palette || typeof source.palette !== 'object' || Array.isArray(source.palette)) fail('wave.palette', 'expected a palette object');
  const shell = { version: 1, name: source.name, width, height, palette: source.palette,
    ...(source.anchor !== undefined && { anchor: source.anchor }), ...(source.sheet !== undefined && { sheet: source.sheet }) };
  // Reuse the renderer's palette, portable name, anchor and sheet validation.
  renderProject({ ...shell, frames: [{ name: 'check' }] });
  const visibleKeys = new Set(Object.entries(source.palette).filter(([, color]) => parseColor(color)[3] > 0).map(([key]) => key));
  if (!source.effects || typeof source.effects !== 'object' || Array.isArray(source.effects) || !Object.keys(source.effects).length || Object.keys(source.effects).length > 16) fail('wave.effects', 'expected 1–16 named effects');
  const effects = Object.entries(source.effects).map(([name, effect]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) fail(`wave.effects.${name}`, 'expected a portable effect name of at most 60 characters');
    return [name, readEffect(effect, `wave.effects.${name}`, source)];
  });
  if (new Set(effects.map(([name]) => name.toLowerCase())).size !== effects.length) fail('wave.effects', 'effect names must be unique ignoring case');
  const total = effects.reduce((n, [, e]) => n + e.frames, 0);
  if (total > 256 || total * width * height > 4194304) fail('wave.effects', 'the effects exceed 256 frames or 4,194,304 source pixels');
  const frames = [], animations = Object.create(null), summaries = Object.create(null), warnings = [];
  for (const [name, e] of effects) {
    const area = width * height, envelope = new Float64Array(area);
    const phases = e.sources.map(() => new Float64Array(area));
    for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at++) {
      const m = e.mask;
      if (m) {
        const dx = (x - m.at[0]) / m.radius[0], dy = (y - m.at[1]) / m.radius[1], r = Math.sqrt(dx * dx + dy * dy);
        envelope[at] = m.feather ? smooth((1 - r) / m.feather) : (r < 1 ? 1 : 0);
      } else envelope[at] = 1;
      e.sources.forEach((s, i) => {
        const dx = x - s.at[0], dy = y - s.at[1], sx = dx / s.stretch[0], sy = dy / s.stretch[1];
        const position = s.kind === 'radial' ? Math.sqrt(sx * sx + sy * sy) : dx * s.direction[0] + dy * s.direction[1];
        phases[i][at] = position / s.wavelength;
      });
    }
    if (e.sources.some(s => s.wavelength * Math.min(...s.stretch) < 6)) warnings.push(`wave.effects.${name}: narrow waves may shimmer at this pixel size; increase wavelength or stretch.`);
    if (e.sources.some(s => Math.abs(s.cycles) * 8 > e.frames)) warnings.push(`wave.effects.${name}: fast waves may strobe; lower cycles or add frames.`);
    const names = [], visiblePixels = [];
    for (let f = 0; f < e.frames; f++) {
      const rows = []; let visible = 0;
      for (let y = 0, at = 0; y < height; y++) {
        let row = '';
        for (let x = 0; x < width; x++, at++) {
          let value = 0;
          for (let i = 0; i < e.sources.length; i++) {
            const s = e.sources[i];
            value += s.amplitude * cosDeg(360 * (phases[i][at] - s.cycles * f / e.frames) + s.phase);
          }
          value *= envelope[at];
          const colors = value < 0 ? e.negative : e.positive, magnitude = Math.abs(value);
          let key = '.';
          if (colors) for (let i = 0; i < colors.length; i++) if (magnitude >= e.thresholds[i]) key = colors[i];
          row += key; if (visibleKeys.has(key)) visible++;
        }
        rows.push(row);
      }
      const layers = [], grid = (name, rows) => ({ name, ops: [{ op: 'grid', rows }] });
      if (e.underlay) layers.push(grid('underlay', e.underlay));
      layers.push(grid('wave', rows));
      if (e.overlay) layers.push(grid('overlay', e.overlay));
      const frameName = `${name}-${f}`; names.push(frameName); visiblePixels.push(visible);
      frames.push({ name: frameName, duration: e.duration, layers });
    }
    animations[name] = { frames: names, loop: true };
    summaries[name] = { frames: e.frames, duration: e.frames * e.duration, sources: e.sources.length, visiblePixels };
  }
  const recipe = { ...shell, frames, animations };
  renderProject(recipe);
  return JSON.parse(JSON.stringify({ recipe, metadata: { format: 'pixelforge-wave-metadata', version: 1, effects: summaries }, warnings }));
}
