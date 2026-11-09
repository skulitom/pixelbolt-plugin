import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareScene, renderScene, sceneHaze, scenePlanes } from './scene.js';
import { encodePNG } from './png.js';
import { buildAtlas } from './core.js';
import { spriteFrames, canvasTexture, normalsYUp, tileSets, parallaxScene } from './godot.js';
import { tileSource } from './export.js';
import { tiledTileset, tiledMap } from './tiled.js';

export async function createSceneBundle(source) {
  const scene = prepareScene(source), view = renderScene(scene), files = new Map();
  files.set('scene.json', Buffer.from(JSON.stringify(source, null, 2) + '\n'));
  files.set('scene.png', encodePNG(view.data, view.width, view.height));
  const unlit = renderScene(scene, { lit: false, draws: true });
  files.set('unlit.png', encodePNG(unlit.data, unlit.width, unlit.height));
  const tiles = [], tileWarnings = [], tiledSets = {}, hazed = sceneHaze(scene), alignment = { version: 1, coordinates: 'atlas pixels; normal RGB encodes XYZ in [0,255], +X right, +Y down, +Z toward viewer (normalYUp flips green to +Y up, as Godot and Unity read normal maps); never color-quantize normal passes', assets: Object.create(null) };
  for (const [id, asset] of Object.entries(scene.assets)) {
    // Asset keys may contain punctuation; use a stable numeric export directory.
    const directory = `assets/${Object.keys(alignment.assets).length}`;
    // Aligned passes share one uniform grid, even when a recipe trims its own export.
    const atlas = buildAtlas(asset.recipe, { trim: false });
    atlas.metadata.meta.image = 'color.png';
    const entry = alignment.assets[id] = { directory, metadata: `${directory}/atlas.json`, godot: `${directory}/sprite_frames.tres`, passes: {} };
    files.set(`${directory}/atlas.json`, Buffer.from(JSON.stringify(atlas.metadata, null, 2) + '\n'));
    for (const [pass, project] of Object.entries(asset)) {
      const rendered = pass === 'recipe' ? atlas : buildAtlas(project, { trim: false }), filename = `${directory}/${pass === 'recipe' ? 'color' : pass}.png`;
      files.set(filename, encodePNG(rendered.data, rendered.width, rendered.height));
      entry.passes[pass === 'recipe' ? 'color' : pass] = filename;
      if (pass !== 'normal') continue;
      // Godot reads a normal map +Y up: a flipped copy, and a CanvasTexture pairing it with the colour pass.
      files.set(`${directory}/normal_y_up.png`, encodePNG(normalsYUp(rendered.data), rendered.width, rendered.height));
      entry.passes.normalYUp = `${directory}/normal_y_up.png`;
      files.set(`${directory}/canvas_texture.tres`, Buffer.from(canvasTexture({ diffuse: 'color.png', normal: 'normal_y_up.png' })));
      entry.canvasTexture = `${directory}/canvas_texture.tres`;
    }
    // Godot 4 SpriteFrames over the colour pass beside it, drawn through the CanvasTexture when there is a normal pass,
    // so an AnimatedSprite2D with it is lit by Light2D nodes.
    files.set(`${directory}/sprite_frames.tres`, Buffer.from(spriteFrames(atlas.metadata, entry.canvasTexture ? { image: 'canvas_texture.tres' } : {}).text));
    // An asset that is a tile set joins the scene's TileSet as an atlas source, named by its id and drawn through its
    // CanvasTexture when it has one, so Light2D nodes light the tiles.
    const value = source.assets[id], spec = value?.recipe ?? value;
    const set = tileSource(spec, asset.recipe, atlas, { name: id, image: entry.canvasTexture ?? `${directory}/color.png` });
    if (set) tiles.push({ id, set });
    // And a Tiled tileset of its own beside its colour pass, since a Tiled tileset cuts one image: a tile set's with its
    // terrains, any other asset's with its frames as tiles (its looping animations animated), for scene.tmx.
    const { sheet } = asset.recipe, frames = { atlas: spec?.animations === undefined ? { ...atlas.metadata, animations: {} } : atlas.metadata, tiles: [], layered: [], plain: asset.recipe.frames.map(frame => frame.name), colors: {}, name: id, margin: sheet.padding * sheet.scale, separation: sheet.padding * 2 * sheet.scale };
    const tiled = tiledTileset({ ...(set ?? frames), image: 'color.png' }, { oneShots: Boolean(set) });
    tileWarnings.push(...tiled.warnings.map(warning => `${directory}/tileset.tsx: ${warning}`));
    files.set(`${directory}/tileset.tsx`, Buffer.from(tiled.text));
    entry.tiled = `${directory}/tileset.tsx`;
    tiledSets[id] = { source: entry.tiled, tiles: sheet.columns * Math.ceil(asset.recipe.frames.length / sheet.columns), haze: [] };
    // Each amount of haze a placement of the asset stands in: a copy of its colour pass with that haze baked in, each
    // colour faded as a whole as the scene fades it, unlit, with a Tiled tileset and a Godot SpriteFrames of its own on
    // the same grid, so a far plane is already paler in an engine.
    const amounts = [...new Set(scene.instances.filter(instance => instance.asset === id && instance.haze > 0).map(instance => instance.haze))].sort((a, b) => a - b);
    for (const amount of amounts) {
      const folder = `${directory}/haze-${amount}`, data = Uint8ClampedArray.from(atlas.data);
      for (let at = 0; at < data.length; at += 4) if (data[at + 3]) data.set(hazed(amount, data.subarray(at, at + 3)), at);
      files.set(`${folder}/color.png`, encodePNG(data, atlas.width, atlas.height));
      files.set(`${folder}/tileset.tsx`, Buffer.from(tiledTileset({ ...(set ?? frames), image: 'color.png', title: `${id} haze ${amount}` }, { oneShots: false }).text));
      files.set(`${folder}/sprite_frames.tres`, Buffer.from(spriteFrames(atlas.metadata).text));
      (entry.haze ??= []).push({ amount, color: `${folder}/color.png`, tiled: `${folder}/tileset.tsx`, godot: `${folder}/sprite_frames.tres` });
      tiledSets[id].haze.push({ amount, source: `${folder}/tileset.tsx` });
    }
  }
  // A Tiled map of the scene at its start, unlit, over those tilesets, each layer with its plane's parallax.
  const map = tiledMap(scene, unlit.draws, { tilesets: tiledSets });
  tileWarnings.push(...map.warnings.map(warning => `scene.tmx: ${warning}`));
  files.set('scene.tmx', Buffer.from(map.text));
  alignment.tiled = 'scene.tmx';
  // The same planes as images, hazed, for engines that scroll images, and a Godot scene scrolling them with Parallax2D
  // nodes. A plane is a run of draws on one plane, so it holds what one or more of the map's layers hold.
  const planes = scenePlanes(scene, unlit.draws), label = i => scene.instances[i].name ?? scene.instances[i].asset;
  if (planes.shaded.length) tileWarnings.push(`planes: ${planes.shaded.join(', ')}: left out: a shade placement darkens what is drawn under it, which a plane's own image can't`);
  if (planes.oversized.length) tileWarnings.push(`planes: ${planes.oversized.join('; ')}: left out: a plane's image is at most 16,777,216 pixels; keep a plane's placements closer together`);
  alignment.planes = planes.planes.map((plane, k) => {
    files.set(`planes/${k}.png`, encodePNG(plane.data, plane.width, plane.height));
    return { image: `planes/${k}.png`, parallax: plane.parallax, at: plane.at, size: [plane.width, plane.height], placements: plane.instances.map(label) };
  });
  files.set('scene.tscn', Buffer.from(parallaxScene({ name: source.name, width: scene.width, height: scene.height, background: scene.background, camera: unlit.camera ?? [0, 0],
    planes: alignment.planes.map((plane, k) => ({ name: planes.planes[k].instances.map(label)[0], image: plane.image, at: plane.at, parallax: plane.parallax })) })));
  alignment.godot = 'scene.tscn';
  // One Godot TileSet holds every tile set of the scene, each a terrain set of its own, so one TileMapLayer paints all
  // of them and each one's edges open onto the others, as the scene's tilemaps draw them.
  if (tiles.length) {
    const result = tileSets(tiles.map(item => item.set));
    tileWarnings.push(...result.warnings.map(warning => `tileset.tres: ${warning}`));
    if (result.text !== null) {
      files.set('tileset.tres', Buffer.from(result.text));
      alignment.tileset = { file: 'tileset.tres', assets: tiles.map(item => item.id) };
    }
  }
  files.set('alignment.json', Buffer.from(JSON.stringify(alignment, null, 2) + '\n'));
  files.set('review.json', Buffer.from(JSON.stringify({ placements: view.placements, warnings: [...view.warnings, ...tileWarnings] }, null, 2) + '\n'));
  for (const file of ['core.js', 'craft.js', 'font.js', 'authoring.js', 'pose-geometry.js', 'motions.js', 'autotile.js', 'terrain.js', 'slopes.js', 'scene.js']) files.set(file, await readFile(new URL(file, import.meta.url)));
  for (const [file, source] of [['preview.html', '../studio/scene.html'], ['scene-player.js', '../studio/scene-player.js'], ['scene.css', '../studio/scene.css']]) files.set(file, await readFile(new URL(source, import.meta.url)));
  // A forced export over an earlier export of a scene removes what that one wrote and this one doesn't: planes, hazed
  // copies, the files of an asset it no longer has (or of a pass it lost), tileset.tres. Only files the earlier
  // alignment.json lists go, and only in the folders they are in, so nothing else in the folder is touched.
  return { files, scene, warnings: [...view.warnings, ...tileWarnings], owns: { marker: 'alignment.json', listed: sceneFiles, folders: listed => [...new Set(listed.map(file => path.posix.dirname(file)))], match: SCENE_FILES } };
}

// The files a scene export writes only sometimes, by the names it gives them.
const SCENE_FILES = /^(?:tileset\.tres|planes\/\d+\.png|assets\/\d+\/(?:haze-[^/]+\/)?(?:[\w-]+\.png|atlas\.json|sprite_frames\.tres|canvas_texture\.tres|tileset\.tsx))$/;
// The files an earlier scene export's alignment.json says it wrote, of those it writes only sometimes.
function sceneFiles(alignment) {
  if (alignment?.version !== 1 || typeof alignment.coordinates !== 'string' || !alignment.coordinates.startsWith('atlas pixels')) return [];
  const files = [alignment.tileset?.file, ...(Array.isArray(alignment.planes) ? alignment.planes.map(plane => plane?.image) : [])];
  for (const entry of Object.values(alignment.assets ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    files.push(entry.metadata, entry.godot, entry.tiled, entry.canvasTexture, ...Object.values(entry.passes ?? {}));
    for (const copy of Array.isArray(entry.haze) ? entry.haze : []) files.push(copy?.color, copy?.tiled, copy?.godot);
  }
  return files.filter(file => typeof file === 'string' && SCENE_FILES.test(file));
}
