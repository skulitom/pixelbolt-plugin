// Node-side provenance for authored corrections. Source recipes stay ordinary version-1 JSON.
import { createHash } from 'node:crypto';
import { PixelError, renderProject, compareProjects, parseColor } from './core.js';
import { patchRecipe } from './patch.js';

// Key ordering/formatting changes are harmless; drawing/list order remains significant.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const recipeFingerprint = recipe => createHash('sha256').update(JSON.stringify(canonical(recipe))).digest('hex');
const CANVAS = ['paint', 'grid', 'move', 'recolor', 'cleanup'];
const fail = message => { throw new PixelError('overlay', message); };
const frameFingerprint = (project, frame) => createHash('sha256').update(`${project.width}x${project.height}:`).update(frame.data).digest('hex');
const hex = rgba => '#' + rgba.map(v => v.toString(16).padStart(2, '0')).join('');

function expandSelections(overlay, recipe) {
  const selections = overlay.selections ?? {};
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) fail('selections must be a map of named canvas regions');
  for (const [name, selection] of Object.entries(selections)) {
    if (!selection || Array.isArray(selection) || selection.space !== 'canvas' || Object.keys(selection).some(key => !['space', 'x', 'y', 'w', 'h', 'mask'].includes(key))) fail(`selection ${name} must be a canvas region with space, x, y, w, h and optional mask`);
    if (!['x', 'y', 'w', 'h'].every(key => Number.isInteger(selection[key])) || selection.x < 0 || selection.y < 0 || selection.w < 1 || selection.h < 1 || selection.x + selection.w > recipe.width || selection.y + selection.h > recipe.height) fail(`selection ${name} must fit the canvas`);
    if (selection.mask !== undefined && (!Array.isArray(selection.mask) || selection.mask.length !== selection.h || selection.mask.some(row => typeof row !== 'string' || row.length !== selection.w || /[^x.]/.test(row)))) fail(`selection ${name} has an invalid mask`);
  }
  if (!Array.isArray(overlay.changes) || !overlay.changes.length || overlay.changes.length > 1024) fail('expected 1–1024 changes');
  return overlay.changes.map(change => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) fail('each change must be an object');
    if (change.selection === undefined) return change;
    if (typeof change.selection !== 'string' || !Object.hasOwn(selections, change.selection)) fail(`unknown selection ${JSON.stringify(change.selection)}`);
    if (!['grid', 'move', 'recolor', 'cleanup'].some(verb => Object.hasOwn(change, verb))) fail('named selections apply to grid, move, recolor or cleanup changes');
    const { selection, ...edit } = change, { space, w, h, ...region } = selections[selection];
    return { ...edit, value: { ...region, ...(!change.grid && { w, h }), ...change.value } };
  });
}
// Frame targeted by a canvas change, by name or index, as the recipe currently resolves it.
function targetFrame(recipe, change) {
  const verb = CANVAS.find(v => change[v] !== undefined), path = String(change[verb]).replace(/^project\.?/, '');
  const match = /^frames\[(?:(\d+)|"((?:[^"\\]|\\.)*)"|([a-zA-Z][\w-]*))\]$/.exec(path);
  if (!match) fail(`canvas change path ${JSON.stringify(change[verb])} must address a frame, such as frames[blink]`);
  const frame = match[1] !== undefined ? recipe.frames[Number(match[1])] : recipe.frames.find(f => f.name === (match[2] !== undefined ? JSON.parse(`"${match[2]}"`) : match[3]));
  return frame?.name ?? null;
}
// Palette keys a change paints with; recorded so a recolored palette counts as a changed base.
function paletteKeys(recipe, changes) {
  const keys = new Set(), palette = recipe.palette ?? {};
  const add = value => { if (typeof value === 'string' && Object.hasOwn(palette, value)) keys.add(value); };
  for (const change of changes) {
    const value = change.value;
    if (change.paint !== undefined && Array.isArray(value)) value.forEach(pixel => add(pixel?.color));
    if (change.grid !== undefined) for (const row of value?.rows ?? []) for (const char of String(row)) add(char);
    if (change.recolor !== undefined) { add(value?.from); add(value?.to); }
    if (change.cleanup !== undefined && Array.isArray(value?.colors)) value.colors.forEach(add);
  }
  return [...keys].sort();
}
function dependents(recipe, names) {
  const from = new Map(recipe.frames.map(frame => [frame.name, frame.from])), out = new Set(names);
  for (const frame of recipe.frames) {
    for (let parent = frame.from; parent !== undefined; parent = from.get(parent)) if (names.has(parent)) { out.add(frame.name); break; }
  }
  return out;
}
export function createOverlay(recipe, changes, selections = {}) {
  const overlay = { format: 'pixelforge-overlay', version: 1, base: recipeFingerprint(recipe), selections: structuredClone(selections), changes: structuredClone(changes) };
  applyOverlay(recipe, overlay);
  // Canvas-only corrections also record per-frame evidence, so they can reapply after unrelated edits to the base:
  // the frames they target (and frames inheriting from them), the targets' names and the palette colours they use.
  const expanded = expandSelections(overlay, recipe);
  if (expanded.every(change => CANVAS.some(verb => change[verb] !== undefined))) {
    const project = renderProject(recipe), targets = expanded.map(change => targetFrame(recipe, change));
    const touched = dependents(recipe, new Set(targets));
    overlay.frames = Object.fromEntries(project.frames.filter(frame => touched.has(frame.name)).map(frame => [frame.name, frameFingerprint(project, frame)]));
    overlay.targets = targets;
    overlay.colors = Object.fromEntries(paletteKeys(recipe, expanded).map(key => [key, hex(parseColor(key, recipe.palette))]));
  }
  return overlay;
}
export function applyOverlay(recipe, overlay) {
  if (!overlay || Array.isArray(overlay) || overlay.format !== 'pixelforge-overlay' || overlay.version !== 1) fail('expected a version-1 pixelforge-overlay');
  for (const key of Object.keys(overlay)) if (!['format', 'version', 'base', 'selections', 'changes', 'frames', 'targets', 'colors'].includes(key)) fail(`unknown field ${key}`);
  const changes = expandSelections(overlay, recipe);
  let rebased = false;
  if (overlay.base !== recipeFingerprint(recipe)) {
    if (!overlay.frames) fail('base fingerprint conflict; the generated recipe changed. Inspect the new base and author a new overlay; old coordinates were not applied.');
    // The base changed elsewhere. Reapply only if every frame this overlay depends on is pixel-identical.
    const project = renderProject(recipe), problems = [];
    for (const [name, fingerprint] of Object.entries(overlay.frames)) {
      const frame = project.frames.find(f => f.name === name);
      if (!frame) problems.push(`frame ${name} is missing`); else if (frameFingerprint(project, frame) !== fingerprint) problems.push(`frame ${name} changed`);
    }
    changes.forEach((change, i) => { if (overlay.targets?.[i] !== undefined && targetFrame(recipe, change) !== overlay.targets[i]) problems.push(`changes[${i}] now addresses ${targetFrame(recipe, change) ?? 'no frame'}, not ${overlay.targets[i]}`); });
    for (const [key, value] of Object.entries(overlay.colors ?? {})) {
      if (!Object.hasOwn(recipe.palette ?? {}, key) || hex(parseColor(key, recipe.palette)) !== value) problems.push(`palette ${key} changed`);
    }
    if (problems.length) fail(`base fingerprint conflict where this overlay applies (${problems.slice(0, 6).join('; ')}${problems.length > 6 ? `; ${problems.length - 6} more` : ''}). Inspect the new base and author a new overlay; old coordinates were not applied.`);
    rebased = true;
  }
  const before = renderProject(recipe), result = patchRecipe(recipe, changes), after = renderProject(result.recipe);
  return { ...result, base: overlay.base, fingerprint: recipeFingerprint(result.recipe), report: compareProjects(before, after), ...(rebased && { rebased: true }) };
}
