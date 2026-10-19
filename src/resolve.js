// Node-side reference resolution. The renderer only sees inline data; this module inlines shared palette files
// (`palette: { "$ref": "palette.json", ...local entries }`) and scene asset files or saved revisions. Relative
// paths resolve from `baseDir`; when `root` is set (the MCP server), every referenced file must stay inside it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PixelError } from './core.js';

const fail = (where, message) => { throw new PixelError(where, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function readJSON(file, where) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { fail(where, `could not read ${file} (${error.code ?? error.message})`); }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { fail(where, `${file} is not valid JSON`); }
}
function locate(reference, baseDir, root, where) {
  if (typeof reference !== 'string' || !reference.trim()) fail(where, 'expected a relative file path');
  const file = path.resolve(baseDir, reference);
  if (root !== undefined) {
    const relative = path.relative(path.resolve(root), file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(where, `references must stay inside ${path.resolve(root)}`);
  }
  return file;
}
// A shared palette file is either a flat map of names to colours or any JSON document with a `palette` map, which may
// also list `ramps` (palette keys from dark to light) for the recipes that link it.
async function sharedPalette(reference, baseDir, context, where) {
  const file = locate(reference, baseDir, context.root, where), loaded = await readJSON(file, where);
  const palette = isObject(loaded?.palette) ? loaded.palette : loaded;
  if (!isObject(palette) || Object.values(palette).some(value => typeof value !== 'string')) fail(where, `${reference} must contain a palette object of colour strings`);
  if (Object.hasOwn(palette, '$ref')) fail(where, 'nested palette references are not supported');
  context.files.add(file);
  return { palette, ramps: isObject(loaded?.palette) && loaded.ramps !== undefined ? loaded.ramps : null };
}
async function resolvePalette(document, baseDir, context, where) {
  if (!isObject(document) || !isObject(document.palette) || !Object.hasOwn(document.palette, '$ref')) return document;
  const { $ref, ...local } = document.palette;
  const { palette: shared, ramps } = await sharedPalette($ref, baseDir, context, `${where}.palette.$ref`);
  // A recipe without ramps of its own takes the shared file's; sidecar sources compile to recipes without them.
  const inherit = ramps && document.format === undefined && document.ramps === undefined;
  context.palettes.push({ where, reference: $ref, shared, ...(inherit && { ramps }) });
  return { ...document, palette: { ...shared, ...local }, ...(inherit && { ramps }) };
}
// A pixelforge-normals source names the colour recipe it derives from: a file, a saved revision or an inline recipe.
async function loadRecipe(entry, baseDir, context, where) {
  if (typeof entry === 'string') {
    const file = locate(entry, baseDir, context.root, where);
    context.files.add(file);
    return resolvePalette(await readJSON(file, where), path.dirname(file), context, where);
  }
  if (isObject(entry) && Object.keys(entry).length === 1 && typeof entry.revision === 'string') {
    if (!context.revisions) fail(where, 'revision references are only available through the MCP server');
    return resolvePalette(await context.revisions(entry.revision), baseDir, context, where);
  }
  return resolvePalette(entry, baseDir, context, where);
}
async function resolveScene(scene, baseDir, context) {
  if (!isObject(scene.assets)) return scene;
  // A theme: a palette file for the whole scene or for one asset overrides the keys the recipes share.
  const theme = async (value, where) => typeof value === 'string' ? (await sharedPalette(value, baseDir, context, where)).palette : value;
  if (scene.palette !== undefined) scene = { ...scene, palette: await theme(scene.palette, 'scene.palette') };
  const assets = {};
  for (const [id, value] of Object.entries(scene.assets)) {
    const where = `scene.assets.${id}`;
    const load = (entry, key) => loadRecipe(entry, baseDir, context, key ? `${where}.${key}` : where);
    if (isObject(value) && (value.recipe !== undefined || value.normal !== undefined || value.emissive !== undefined) && value.version === undefined) {
      assets[id] = {};
      for (const key of ['recipe', 'normal', 'emissive']) if (value[key] !== undefined) assets[id][key] = await load(value[key], key);
      for (const key of Object.keys(value)) if (!['recipe', 'normal', 'emissive'].includes(key)) assets[id][key] = key === 'palette' ? await theme(value.palette, `${where}.palette`) : value[key];
    } else assets[id] = await load(value);
  }
  return { ...scene, assets };
}
/**
 * Returns the document with references inlined, plus the files it read. Works for recipes, pose sources,
 * autotile templates, effect and fluid sources, normal sources and scenes. `revisions(id)` supplies saved recipes for
 * `{ "revision": id }` scene assets and normal sources.
 */
export async function resolveReferences(document, { baseDir = process.cwd(), root, revisions } = {}) {
  const context = { root, revisions, files: new Set(), palettes: [] };
  const sidecars = { 'pixelforge-poses': 'poses', 'pixelforge-autotile': 'autotile', 'pixelforge-fx': 'fx', 'pixelforge-fluid': 'fluid' };
  const resolved = document?.format === 'pixelforge-scene' ? await resolveScene(document, baseDir, context)
    : document?.format === 'pixelforge-normals' && document.recipe !== undefined ? { ...document, recipe: await loadRecipe(document.recipe, baseDir, context, 'normals.recipe') }
      : await resolvePalette(document, baseDir, context, sidecars[document?.format] ?? 'project');
  return { document: resolved, files: [...context.files], palettes: context.palettes };
}
/**
 * After editing a resolved recipe, restore its palette reference: entries identical to the shared file are dropped
 * again and anything added or changed stays local. Keeps edited recipes linked to their shared palette.
 */
export function restorePaletteReference(original, edited, resolution) {
  const link = resolution.palettes.find(entry => entry.where === 'project');
  if (!link || !isObject(original?.palette) || !Object.hasOwn(original.palette, '$ref') || !isObject(edited?.palette)) return edited;
  const local = Object.fromEntries(Object.entries(edited.palette).filter(([key, value]) => !(Object.hasOwn(link.shared, key) && link.shared[key] === value)));
  const removed = Object.keys(link.shared).filter(key => !Object.hasOwn(edited.palette, key));
  if (removed.length) fail('project.palette', `the edit removed shared palette entries (${removed.join(', ')}); edit ${link.reference} instead`);
  const restored = { ...edited, palette: { $ref: original.palette.$ref, ...local } };
  // Ramps taken from the shared file stay there unless the edit changed them.
  if (link.ramps && JSON.stringify(edited.ramps) === JSON.stringify(link.ramps)) delete restored.ramps;
  return restored;
}
