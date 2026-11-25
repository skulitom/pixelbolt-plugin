import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareScene, renderScene, sceneImage, sceneHaze, scenePlanes, wholeDraws, parallaxOf, MAX_PLANE } from './scene.js';
import { framesGIF, gifBackground, asGIFShows, MAX_FRAMES_PIXELS } from './gif.js';
import { parseFrameRate } from './sequence.js';
import { encodePNG } from './png.js';
import { buildAtlas, inspectProject, namesAnimations, largestScale, fail } from './core.js';
import { spriteFrames, canvasTexture, normalsYUp, tileSets, parallaxScene } from './godot.js';
import { tileSource } from './export.js';
import { tiledTileset, tiledMap } from './tiled.js';

// A prepared scene as one looping GIF: the scene at each frame's start, through its duration once, `fps` frames a
// second (25 unless given, which GIF's 10 ms steps hold exactly), each enlarged `scale` times and, with `background`
// (a hex colour), blended onto that colour as a recipe's GIF is (a scene's own opaque background is left as it is).
// Returns framesGIF's result, with a note when the duration is not a whole number of frames, since the loop then ends
// early or late, and notes on the placements whose animations the duration cuts mid-loop or that play once: where the
// GIF repeats, those jump. `sheet: true` adds `sheet`, inspectProject's view of the frames as the GIF holds them (at
// their own size, at most 256 evenly spaced cells, as inspect samples): each sampled frame is drawn again, so the
// frames inspect skips are never kept. Without `fps`, a note names an even rate when 25 holds some placement's frames
// for uneven numbers of GIF frames (see evenRate). It names the rate rather than choosing it: choosing would change
// shipped scenes' GIFs.
export function sceneGIF(scene, { fps, scale = 1, background, sheet = false } = {}) {
  const rate = parseFrameRate(fps ?? 25, 'gif.fps'), frameMs = 1000 * rate.denominator / rate.numerator, count = Math.max(1, Math.round(scene.duration / frameMs));
  // The whole loop at this scale is held to what one GIF holds, and each frame to one image, before a frame is drawn,
  // so a refusal names the largest scale at which all of it fits rather than one that fails a frame later. A loop too
  // long even at scale 1 names the largest whole frame rate that fits, which keeps the scene's timing in fewer frames.
  const { width, height } = scene, plane = width * height * scale * scale, loop = count * plane;
  if (Number.isInteger(scale) && scale >= 1 && scale <= 16 && (loop > MAX_FRAMES_PIXELS || plane > MAX_PLANE)) {
    const fits = Math.min(largestScale(count * width * height, MAX_FRAMES_PIXELS, scale), largestScale(width * height, MAX_PLANE, scale));
    const past = plane > MAX_PLANE ? 'more pixels than one image holds' : `${loop.toLocaleString('en-US')} pixels in all, past the 134,217,728 a GIF holds`;
    const head = `at scale ${scale} the ${count} frame${count === 1 ? '' : 's'} of the ${width}×${height} scene ${count === 1 ? 'is' : 'are'} ${width * scale}×${height * scale}, ${past}`;
    if (fits) fail('scale', `${head}; scale ${fits} is the largest that fits${count === 1 ? '' : ', or shorten the scene'}`);
    let slower = Math.min(240, Math.floor(rate.numerator / rate.denominator));
    while (slower >= 1 && Math.max(1, Math.round(scene.duration * slower / 1000)) * width * height > MAX_FRAMES_PIXELS) slower--;
    fail('fps', `${head}; ${slower >= 1 ? `fps ${slower}${scale > 1 ? ' at scale 1' : ''} is the largest that fits, or shorten the scene` : 'shorten the scene'}`);
  }
  const blend = gifBackground(background), at = (k, enlarge) => sceneImage(renderScene(scene, { time: k * frameMs }), { scale: enlarge });
  function* frames() {
    for (let k = 0; k < count; k++) { const image = at(k, scale); yield { data: image.data, width: image.width, height: image.height, name: `frame ${k + 1}` }; }
  }
  const gif = framesGIF(frames(), { fps: rate, background: blend });
  if (sheet) {
    const shown = Array.from({ length: count }, (_, k) => ({ name: `frame ${k + 1}`, duration: Math.round(frameMs), get data() { return asGIFShows(at(k, 1).data, blend); } }));
    gif.sheet = inspectProject({ width: gif.width / scale, height: gif.height / scale, palette: {}, frames: shown, animations: {} }, { maxCells: 256 });
  }
  if (Math.abs(count * frameMs - scene.duration) > 0.5) gif.notes.push(`The scene lasts ${scene.duration} ms, ${Math.round(scene.duration / frameMs * 100) / 100} frames at ${rate.label} fps, and the GIF plays ${count}: give the scene a duration that is a whole number of frames (${Math.round(count * frameMs)} ms) and the loop closes exactly.`);
  // The placements that simply play one animation, each with its length: a loop the duration cuts, or a one-shot.
  const plays = scene.instances.flatMap((instance, i) => {
    if (typeof instance.animation !== 'string' || instance.sequence?.length || instance.hidden) return [];
    const project = scene.assets[instance.asset].recipe, animation = project.animations[instance.animation];
    return animation.frames.length > 1 || !animation.loop ? [{ name: instance.name ?? `${instance.asset}#${i}`, loop: animation.loop, length: animation.frames.reduce((sum, frame) => sum + project.frames[frame].duration, 0) }] : [];
  });
  const cut = plays.filter(play => play.loop && scene.duration % play.length), once = plays.filter(play => !play.loop).map(play => play.name);
  if (cut.length) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a), whole = plays.filter(play => play.loop).reduce((all, play) => (all > 60000 ? all : all / gcd(all, play.length) * play.length), 1);
    gif.notes.push(`The scene's ${scene.duration} ms cut ${cut.slice(0, 6).map(item => `${item.name} (a loop of ${item.length} ms)`).join(', ')}${cut.length > 6 ? ` and ${cut.length - 6} more` : ''} mid-loop, so the GIF jumps where it repeats. ${whole <= 60000 ? `A scene duration of ${whole} ms holds whole loops of every placement.` : 'No duration up to 60000 ms holds whole loops of them all: give them loops of one length (frame durations, or fewer frames).'}`);
  }
  const even = fps === undefined && evenRate(scene, rate);
  if (even) gif.notes.push(even);
  if (once.length) gif.notes.push(`${once.slice(0, 6).join(', ')}${once.length > 6 ? ` and ${once.length - 6} more` : ''} ${once.length === 1 ? 'plays' : 'play'} once and ${once.length === 1 ? 'holds its' : 'hold their'} last frame, then ${once.length === 1 ? 'starts' : 'start'} again where the GIF repeats: a one-shot animation in a loop. A patch of animations.<name> with "loop": true and "direction": "pingpong" makes a swing go there and back.`);
  return gif;
}

// What a note says when the frame rate splits the frames of the animations the placements play (those of more than one
// frame: placements, sequence cues and tilemap cells) unevenly, so a frame of 100 ms at 25 fps is held 120 ms, then
// 80: the largest rate up to this one whose GIF frame is a whole number of centiseconds and divides every such frame.
// null when the frames are even already, or when that rate is below 8 fps or there is none (frames of 90 and 80 ms
// share only 10 ms, which 25 fps cannot divide): a slower GIF loses more than its stutter, so the note stays out.
function evenRate(scene, rate) {
  const durations = new Set(), add = (project, name) => {
    const animation = typeof name === 'string' ? project.animations[name] : null;
    if (animation?.frames.length > 1) for (const index of animation.frames) durations.add(project.frames[index].duration);
  };
  for (const instance of scene.instances) {
    // A placement hidden at the start plays only what its cues show.
    const project = scene.assets[instance.asset].recipe;
    for (const name of [instance.hidden ? null : instance.animation, ...(instance.sequence ?? []).map(cue => cue.animation)]) add(project, name);
    for (const cell of instance.tilemap?.cells ?? []) add(project, cell.animation);
  }
  // A frame of d ms is a whole number of GIF frames when d × numerator is a multiple of 1000 × denominator.
  const uneven = [...durations].filter(d => (d * rate.numerator) % (1000 * rate.denominator)).sort((a, b) => a - b);
  if (!uneven.length) return null;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a), whole = [...durations].reduce(gcd, 0), own = 1000 * rate.denominator / rate.numerator;
  let step = Math.ceil(own / 10) * 10;
  while (step <= Math.min(whole, 125) && whole % step) step += 10;
  if (step > Math.min(whole, 125)) return null;
  const shared = gcd(1000, step), label = step === shared ? String(1000 / step) : `${1000 / shared}/${step / shared}`;
  const shown = uneven.slice(0, 6), more = uneven.length - shown.length;
  const listed = more ? `${shown.join(', ')} ms and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)} ms` : `${shown[0]} ms`;
  return `At ${rate.label} fps (${Math.round(own * 100) / 100} ms a GIF frame) frames of ${listed} are held for uneven numbers of GIF frames, so their animation stutters; fps ${label}${step === shared ? '' : ` (${step} ms a frame)`} holds each for a whole number.`;
}

export async function createSceneBundle(source) {
  const scene = prepareScene(source), view = renderScene(scene), files = new Map();
  files.set('scene.json', Buffer.from(JSON.stringify(source, null, 2) + '\n'));
  files.set('scene.png', encodePNG(view.data, view.width, view.height));
  const unlit = renderScene(scene, { lit: false, draws: true });
  files.set('unlit.png', encodePNG(unlit.data, unlit.width, unlit.height));
  const tiles = [], isoSheets = new Map(), tileWarnings = [], tiledSets = {}, hazed = sceneHaze(scene), alignment = { version: 1, coordinates: 'atlas pixels; normal RGB encodes XYZ in [0,255], +X right, +Y down, +Z toward viewer (normalYUp flips green to +Y up, as Godot and Unity read normal maps); never color-quantize normal passes', assets: Object.create(null) };
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
    const value = source.assets[id], authored = value?.recipe ?? value;
    const spec = authored.format === 'pixelforge-stack' ? asset.recipe : authored;
    const set = tileSource(spec, asset.recipe, atlas, { name: id, image: entry.canvasTexture ?? `${directory}/color.png` });
    if (set) tiles.push({ id, set });
    // And a Tiled tileset of its own beside its colour pass, since a Tiled tileset cuts one image: a tile set's with its
    // terrains, any other asset's with its frames as tiles (its looping animations animated), for scene.tmx.
    const { sheet } = asset.recipe, frames = { atlas: namesAnimations(spec) ? atlas.metadata : { ...atlas.metadata, animations: {} }, tiles: [], layered: [], plain: asset.recipe.frames.map(frame => frame.name), colors: {}, name: id, margin: sheet.padding * sheet.scale, separation: sheet.padding * 2 * sheet.scale };
    isoSheets.set(id, { ...(set ?? frames), name: id, image: entry.canvasTexture ?? `${directory}/color.png` });
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
  // A Tiled map of the scene at its start, unlit, over those tilesets, each layer with its plane's parallax. A Tiled
  // object is a whole frame, so a placement drawn in pieces is one object, where its last piece is.
  const pieced = names => `${names.join(', ')}: drawn in pieces among the cells it stands on, and whole here, after the last of them: what covers a part of it in scene.png is behind it here`;
  const objects = wholeDraws(scene, unlit.draws), map = tiledMap(scene, objects.draws, { tilesets: tiledSets });
  tileWarnings.push(...map.warnings.map(warning => `scene.tmx: ${warning}`), ...(objects.covered.length ? [`scene.tmx: ${pieced(objects.covered)}`] : []));
  files.set('scene.tmx', Buffer.from(map.text));
  alignment.tiled = 'scene.tmx';
  // The same planes as images, hazed, for engines that scroll images, and a Godot scene scrolling them with Parallax2D
  // nodes. A plane is a run of draws on one plane, so it holds what one or more of the map's layers hold. A placement
  // that stands still and plays one animation (a rain overlay, a flickering torch) is no part of any plane: scene.tscn
  // plays it on an AnimatedSprite2D over its asset's sprite_frames.tres, between the planes drawn before and after it.
  // A sprite is a whole frame too; a still placement's pieces are each in the plane they are drawn on.
  const label = i => scene.instances[i].name ?? scene.instances[i].asset, animated = animatedPlacements(scene, alignment.assets);
  const runs = [], nodes = wholeDraws(scene, unlit.draws, i => animated.has(i));
  if (nodes.covered.length) tileWarnings.push(`scene.tscn: ${pieced(nodes.covered)}`);
  for (const draw of nodes.draws) {
    const sprite = animated.has(draw.instance) ? draw.instance : undefined, last = runs.at(-1);
    if (last && last.sprite === sprite) last.draws.push(draw);
    else runs.push({ sprite, draws: [draw] });
  }
  const layers = [], shaded = [], oversized = [];
  for (const run of runs) {
    if (run.sprite !== undefined) { layers.push(run); continue; }
    const cut = scenePlanes(scene, run.draws);
    shaded.push(...cut.shaded.filter(name => !shaded.includes(name)));
    oversized.push(...cut.oversized);
    layers.push(...cut.planes.map(plane => ({ plane })));
  }
  if (shaded.length) tileWarnings.push(`planes: ${shaded.join(', ')}: left out: a shade placement darkens what is drawn under it, which a plane's own image can't`);
  if (oversized.length) tileWarnings.push(`planes: ${oversized.join('; ')}: left out: a plane's image is at most 16,777,216 pixels; keep a plane's placements closer together`);
  alignment.planes = layers.filter(layer => layer.plane).map((layer, k) => {
    const { plane } = layer;
    files.set(`planes/${k}.png`, encodePNG(plane.data, plane.width, plane.height));
    return layer.image = { image: `planes/${k}.png`, parallax: plane.parallax, at: plane.at, size: [plane.width, plane.height], placements: plane.instances.map(label) };
  });
  // Each animated placement, with every copy it draws (a repeat draws several), at scene positions.
  const sprites = layers.filter(layer => layer.sprite !== undefined).map(layer => {
    const i = layer.sprite, { frames, animation, scale } = animated.get(i);
    return layer.entry = { placement: label(i), frames, animation, parallax: [...parallaxOf(scene, i)], scale, at: layer.draws.map(draw => [draw.x + draw.shift[0], draw.y + draw.shift[1]]) };
  });
  if (sprites.length) alignment.sprites = sprites;
  files.set('scene.tscn', Buffer.from(parallaxScene({ name: source.name, width: scene.width, height: scene.height, background: scene.background, camera: unlit.camera ?? [0, 0],
    planes: layers.map(layer => (layer.plane ? { name: label(layer.plane.instances[0]), image: layer.image.image, at: layer.image.at, parallax: layer.image.parallax }
      : { name: layer.entry.placement, frames: layer.entry.frames, animation: layer.entry.animation, scale: layer.entry.scale, parallax: layer.entry.parallax, at: layer.entry.at })) })));
  alignment.godot = 'scene.tscn';
  // Placements that change but not as one animation in one place: scene.tscn shows them as they are at the start.
  const held = scene.instances.flatMap((instance, i) => (!animated.has(i) && !instance.tilemap && !instance.shade && (moves(instance) || plays(scene, instance)) ? [label(i)] : []));
  if (held.length) tileWarnings.push(`scene.tscn: ${held.slice(0, 6).join(', ')}${held.length > 6 ? ` and ${held.length - 6} more` : ''}: shown as at the scene's start, since ${held.length === 1 ? 'it moves, follows cues or changes anchor' : 'they move, follow cues or change anchor'} as the scene plays; animate ${held.length === 1 ? 'it' : 'them'} in Godot with ${held.length === 1 ? 'its' : 'their'} asset's sprite_frames.tres`);
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
  // An isometric TileSet for the scene's iso tilemaps: every asset one of them draws from, at 1×, on the diamonds of
  // the first, so a TileMapLayer with it paints the ground the scene draws.
  const diamonds = scene.instances.filter(instance => instance.tilemap?.iso && instance.scale === 1 && scene.assets[instance.asset].recipe.sheet.scale === 1 && !scene.assets[instance.asset].recipe.sheet.trim);
  if (diamonds.length) {
    const [tw, th] = diamonds[0].tilemap.tile, ids = [...new Set(diamonds.filter(instance => instance.tilemap.tile[0] === tw && instance.tilemap.tile[1] === th).map(instance => instance.asset))];
    const result = tileSets(ids.map(id => isoSheets.get(id)), { iso: [tw, th] });
    tileWarnings.push(...result.warnings.map(warning => `tileset_iso.tres: ${warning}`));
    if (result.text !== null) {
      files.set('tileset_iso.tres', Buffer.from(result.text));
      alignment.isoTileset = { file: 'tileset_iso.tres', tile: [tw, th], assets: ids };
    }
  }
  files.set('alignment.json', Buffer.from(JSON.stringify(alignment, null, 2) + '\n'));
  files.set('review.json', Buffer.from(JSON.stringify({ placements: view.placements, warnings: [...view.warnings, ...tileWarnings] }, null, 2) + '\n'));
  // The page that replays the scene, with what it runs on in player/: the folder's top level is what a game takes
  // (scene.tscn, scene.tmx, planes/, assets/), not a dozen engine modules among it.
  for (const file of ['core.js', 'craft.js', 'font.js', 'authoring.js', 'pose-geometry.js', 'motions.js', 'autotile.js', 'terrain.js', 'slopes.js', 'stack-facets.js', 'stack-paths.js', 'stack.js', 'scene.js']) files.set(`player/${file}`, await readFile(new URL(file, import.meta.url)));
  for (const file of ['scene-player.js', 'scene.css']) files.set(`player/${file}`, await readFile(new URL(`../studio/${file}`, import.meta.url)));
  const page = await readFile(new URL('../studio/scene.html', import.meta.url), 'utf8'), placed = page.replace('href="./scene.css"', 'href="./player/scene.css"').replace('src="./scene-player.js"', 'src="./player/scene-player.js"');
  if (placed === page || !placed.includes('./player/scene.css') || !placed.includes('./player/scene-player.js')) throw new Error('studio/scene.html no longer names scene.css and scene-player.js as the scene export expects');
  files.set('preview.html', Buffer.from(placed));
  // A forced export over an earlier export of a scene removes what that one wrote and this one doesn't: planes, hazed
  // copies, the files of an asset it no longer has (or of a pass it lost), tileset.tres. Only files the earlier
  // alignment.json lists go, and only in the folders they are in, so nothing else in the folder is touched.
  return { files, scene, warnings: [...view.warnings, ...tileWarnings], owns: { marker: 'alignment.json', listed: sceneFiles, folders: listed => [...new Set(listed.map(file => path.posix.dirname(file)))], match: SCENE_FILES } };
}

// Whether a placement plays an animation of more than one frame from the scene's start, and whether it moves or changes
// by cues: a trajectory, keyed lift, an attachment or a sequence.
const plays = (scene, instance) => !instance.hidden && typeof instance.animation === 'string' && scene.assets[instance.asset].recipe.animations[instance.animation].frames.length > 1;
const moves = instance => Boolean(instance.sequence?.length || instance.trajectory || instance.attach || Array.isArray(instance.lift));
// The placements scene.tscn plays on an AnimatedSprite2D, by index, each { frames (its asset's SpriteFrames, or the
// hazed copy's for a hazed placement), animation, scale (placement pixels per sheet pixel) }: those that play an
// animation of more than one frame from the start and stand still while they do (they don't move, have no cues and
// place every frame of it by one anchor). Tilemaps and shade placements never do.
function animatedPlacements(scene, assets) {
  const found = new Map();
  scene.instances.forEach((instance, i) => {
    if (instance.tilemap || instance.shade || moves(instance) || !plays(scene, instance)) return;
    const project = scene.assets[instance.asset].recipe, frames = project.animations[instance.animation].frames;
    if (instance.anchor === 'frame' && new Set(frames.map(index => String(project.frames[index].anchor ?? [0, 0]))).size > 1) return;
    const entry = assets[instance.asset], frameSet = instance.haze ? entry.haze.find(copy => copy.amount === instance.haze).godot : entry.godot;
    found.set(i, { frames: frameSet, animation: instance.animation, scale: instance.scale / project.sheet.scale });
  });
  return found;
}

// The files a scene export writes only sometimes, by the names it gives them.
const SCENE_FILES = /^(?:tileset(?:_iso)?\.tres|planes\/\d+\.png|assets\/\d+\/(?:haze-[^/]+\/)?(?:[\w-]+\.png|atlas\.json|sprite_frames\.tres|canvas_texture\.tres|tileset\.tsx))$/;
// The files an earlier scene export's alignment.json says it wrote, of those it writes only sometimes.
function sceneFiles(alignment) {
  if (alignment?.version !== 1 || typeof alignment.coordinates !== 'string' || !alignment.coordinates.startsWith('atlas pixels')) return [];
  const files = [alignment.tileset?.file, alignment.isoTileset?.file, ...(Array.isArray(alignment.planes) ? alignment.planes.map(plane => plane?.image) : [])];
  for (const entry of Object.values(alignment.assets ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    files.push(entry.metadata, entry.godot, entry.tiled, entry.canvasTexture, ...Object.values(entry.passes ?? {}));
    for (const copy of Array.isArray(entry.haze) ? entry.haze : []) files.push(copy?.color, copy?.tiled, copy?.godot);
  }
  return files.filter(file => typeof file === 'string' && SCENE_FILES.test(file));
}
