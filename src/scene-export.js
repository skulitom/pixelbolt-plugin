import { readFile } from 'node:fs/promises';
import { prepareScene, renderScene } from './scene.js';
import { encodePNG } from './png.js';
import { buildAtlas } from './core.js';

export async function createSceneBundle(source) {
  const scene = prepareScene(source), view = renderScene(scene), files = new Map();
  files.set('scene.json', Buffer.from(JSON.stringify(source, null, 2) + '\n'));
  files.set('scene.png', encodePNG(view.data, view.width, view.height));
  const unlit = renderScene(scene, { lit: false });
  files.set('unlit.png', encodePNG(unlit.data, unlit.width, unlit.height));
  const alignment = { version: 1, coordinates: 'atlas pixels; normal RGB encodes XYZ in [0,255], +X right, +Y down, +Z toward viewer; never color-quantize normal passes', assets: Object.create(null) };
  for (const [id, asset] of Object.entries(scene.assets)) {
    // Asset keys may contain punctuation; use a stable numeric export directory.
    const directory = `assets/${Object.keys(alignment.assets).length}`;
    // Aligned passes share one uniform grid, even when a recipe trims its own export.
    const atlas = buildAtlas(asset.recipe, { trim: false });
    atlas.metadata.meta.image = 'color.png';
    alignment.assets[id] = { directory, metadata: `${directory}/atlas.json`, passes: {} };
    files.set(`${directory}/atlas.json`, Buffer.from(JSON.stringify(atlas.metadata, null, 2) + '\n'));
    for (const [pass, project] of Object.entries(asset)) {
      const rendered = pass === 'recipe' ? atlas : buildAtlas(project, { trim: false }), filename = `${directory}/${pass === 'recipe' ? 'color' : pass}.png`;
      files.set(filename, encodePNG(rendered.data, rendered.width, rendered.height));
      alignment.assets[id].passes[pass === 'recipe' ? 'color' : pass] = filename;
    }
  }
  files.set('alignment.json', Buffer.from(JSON.stringify(alignment, null, 2) + '\n'));
  files.set('review.json', Buffer.from(JSON.stringify({ placements: view.placements, warnings: view.warnings }, null, 2) + '\n'));
  for (const file of ['core.js', 'craft.js', 'font.js', 'authoring.js', 'autotile.js', 'scene.js']) files.set(file, await readFile(new URL(file, import.meta.url)));
  for (const [file, source] of [['preview.html', '../studio/scene.html'], ['scene-player.js', '../studio/scene-player.js'], ['scene.css', '../studio/scene.css']]) files.set(file, await readFile(new URL(source, import.meta.url)));
  return { files, scene, warnings: view.warnings };
}
