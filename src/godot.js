// Godot 4 SpriteFrames and TileSet resources in Godot's text format (.tres), made from a Pixelbolt atlas.
// Browser-compatible: no imports, and the same atlas always gives the same bytes.
//
// One AtlasTexture per frame cuts the frame's rectangle out of the sheet. A trimmed frame also gets a margin that puts
// its visible pixels back where they sat on the canvas, so every frame keeps the canvas size and the same origin.
// The sheet is named by a path relative to the .tres, which Godot resolves from the .tres's own folder.

// The SpriteFrames editor shows speeds from 0 to 120 FPS (it would show a faster animation as 120).
export const GODOT_MAX_FPS = 120;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Godot plays a frame for duration ÷ speed seconds, with one speed per animation, and keeps each duration as a 32-bit
// float. The speed is 1000 ÷ the largest step that divides every frame's milliseconds, so every duration is a whole
// number of steps: 100, 100, 200 ms play at 10 FPS for 1, 1 and 2; 240, 140, 220 ms at 50 FPS for 12, 7 and 11. When
// that step is under 9 ms (more than 120 FPS), the shortest frame sets the speed instead, at most 120 FPS, and the
// others last a fraction of it: 33, 34 ms play at 30.3 FPS for 1 and 1.0303…. `exact` is false when such a fraction
// isn't a 32-bit float; Godot then plays the frame within a ten-millionth of its length.
export function godotTiming(durations) {
  const step = durations.reduce(gcd);
  if (1000 / step <= GODOT_MAX_FPS) return { speed: 1000 / step, durations: durations.map(ms => ms / step), exact: true };
  const shortest = Math.min(...durations), fits = 1000 / shortest <= GODOT_MAX_FPS;
  const relative = durations.map(ms => (fits ? ms / shortest : ms * GODOT_MAX_FPS / 1000));
  const exact = relative.every((value, i) => Math.fround(value) === value && (fits ? value * shortest : value * 1000 / GODOT_MAX_FPS) === durations[i]);
  return { speed: fits ? 1000 / shortest : GODOT_MAX_FPS, durations: relative, exact };
}

// Godot writes a float with a decimal point (1.0), and Rect2 components without one.
const real = value => (Number.isInteger(value) ? value.toFixed(1) : String(value));
const quote = text => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

// Sub-resource ids for names, `${prefix}_${name}`. Godot takes only ASCII letters, digits and underscores in an id
// (4.7 logs an error for every other one, though it still loads the resource), and frame names may have hyphens. A
// name Godot accepts keeps its id; the others have an underscore for each other character, numbered from 2 when that
// id is already taken (a-b beside a_b). Returns a Map from name to id.
export function resourceIds(names, prefix) {
  const ids = new Map(), taken = new Set();
  const valid = name => /^[A-Za-z0-9_]*$/.test(name);
  for (const name of names) if (valid(name)) { ids.set(name, `${prefix}_${name}`); taken.add(`${prefix}_${name}`); }
  for (const name of names) {
    if (ids.has(name)) continue;
    const base = `${prefix}_${name.replace(/[^A-Za-z0-9_]/gu, '_')}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    ids.set(name, id);
    taken.add(id);
  }
  return ids;
}

// `atlas` is Pixelbolt atlas metadata ({ frames, animations, meta }); `image` is the sheet's path relative to the
// .tres (default: meta.image, the sheet beside it). Animations keep the atlas's order, so the first one is the one an
// AnimatedSprite2D shows when the resource is assigned. Returns the text and the animations whose durations are not
// exact (see godotTiming).
export function spriteFrames(atlas, { image = atlas.meta.image } = {}) {
  const animations = Object.entries(atlas.animations), approximate = [];
  // Only frames an animation plays become textures, in recipe order.
  const used = new Set(animations.flatMap(([, animation]) => animation.frames));
  const names = Object.keys(atlas.frames).filter(name => used.has(name));
  const ids = resourceIds(names, 'AtlasTexture'), id = name => ids.get(name);
  // Laid out as Godot 4.5 and later save it (no load_steps; earlier 4.x versions read it the same).
  const lines = ['[gd_resource type="SpriteFrames" format=3]', '', `[ext_resource type="Texture2D" path=${quote(image)} id="1_sheet"]`, ''];
  for (const name of names) {
    const { frame, spriteSourceSize: offset, sourceSize } = atlas.frames[name];
    lines.push(`[sub_resource type="AtlasTexture" id=${quote(id(name))}]`, 'atlas = ExtResource("1_sheet")', `region = Rect2(${frame.x}, ${frame.y}, ${frame.w}, ${frame.h})`);
    // margin.position offsets the drawn rectangle and margin.size adds to the texture's size, so a trimmed frame
    // draws at its canvas position inside a texture the size of the whole canvas.
    const margin = [offset.x, offset.y, sourceSize.w - offset.w, sourceSize.h - offset.h];
    if (margin.some(Boolean)) lines.push(`margin = Rect2(${margin.join(', ')})`);
    // Keeps a filtered or scaled frame from sampling its neighbours in the sheet.
    lines.push('filter_clip = true', '');
  }
  const entries = animations.map(([key, animation]) => {
    const timing = godotTiming(animation.frames.map(name => atlas.frames[name].duration));
    if (!timing.exact) approximate.push(key);
    const frames = animation.frames.map((name, index) => `{\n"duration": ${real(timing.durations[index])},\n"texture": SubResource(${quote(id(name))})\n}`);
    return `{\n"frames": [${frames.join(', ')}],\n"loop": ${animation.loop ? 'true' : 'false'},\n"name": &${quote(key)},\n"speed": ${real(timing.speed)}\n}`;
  });
  lines.push('[resource]', `animations = [${entries.join(', ')}]`, '');
  return { text: lines.join('\n'), approximate };
}

// A resource written here, with its sheet named by another path relative to the .tres (for a copy saved elsewhere).
export const retexture = (text, image) => text.replace(/^(\[ext_resource type="Texture2D" path=)"(?:[^"\\]|\\.)*"( id="1_sheet"\])$/m, (_, start, end) => `${start}${quote(image)}${end}`);

// ---- Lit sprites -------------------------------------------------------------------------------------------------
// A Godot 4 CanvasTexture: a colour sheet with its normal map, both named relative to the .tres, drawn with nearest
// filtering (smoothing would blend neighbouring normals). A sprite, an AtlasTexture or a tile drawn from it takes
// normal-mapped light from Light2D nodes. Laid out as Godot 4.5+ saves one; a SpriteFrames names it as its sheet.
export function canvasTexture({ diffuse, normal }) {
  return ['[gd_resource type="CanvasTexture" format=3]', '', `[ext_resource type="Texture2D" path=${quote(diffuse)} id="1_diffuse"]`, `[ext_resource type="Texture2D" path=${quote(normal)} id="2_normal"]`, '',
    '[resource]', 'diffuse_texture = ExtResource("1_diffuse")', 'normal_texture = ExtResource("2_normal")', 'texture_filter = 1', ''].join('\n');
}
// Normal pixels as Godot and Unity read a normal map, +Y up, from Pixelbolt's +Y down: green flipped (Godot's 2D
// shader reads y as 1 − 2g). Fully transparent pixels stay as they are. Returns a new RGBA array.
export function normalsYUp(data) {
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3]) out[i + 1] = 255 - out[i + 1];
  return out;
}

// ---- Tile sets ---------------------------------------------------------------------------------------------------
// Godot's names for a tile's neighbours, in the order Godot writes them, with the Pixelbolt mask bit of each. A blob
// set matches corners and sides (Godot terrain mode 0), a cardinal set sides only (mode 2) and a corner set corners
// only (mode 1): a corner tile's corners are the four cells it sits between in Pixelbolt's tilemaps.
const PEERS = {
  blob: [['right_side', 4], ['bottom_right_corner', 8], ['bottom_side', 16], ['bottom_left_corner', 32], ['left_side', 64], ['top_left_corner', 128], ['top_side', 1], ['top_right_corner', 2]],
  cardinal: [['right_side', 2], ['bottom_side', 4], ['left_side', 8], ['top_side', 1]],
  corner: [['bottom_right_corner', 8], ['bottom_left_corner', 4], ['top_left_corner', 1], ['top_right_corner', 2]]
};
const TERRAIN_MODES = { blob: 0, cardinal: 2, corner: 1 };
// A corner bit's place in a layered tile's corners (NW, NE, SW, SE).
const CORNER_INDEX = { 1: 0, 2: 1, 4: 2, 8: 3 };
// How many distinct masks a complete set has. A corner set's count includes its empty tile: without one, Godot's
// painter erases a cell painted with no terrain point of its own, and the cell loses its terrain.
const TILE_MASKS = { blob: 47, cardinal: 16, corner: 16 };
// Godot writes colour components without a forced decimal point: Color(0.25, 0.5, 0.75, 1).
const channel = value => String(Number((value / 255).toFixed(6)));

// A Godot 4 TileSet with one atlas source per sheet, each on its sheet's grid. `sources` lists the sheets, each
// { atlas, tiles, plain, image, name, terrain, colors, margin, separation }:
// - atlas: Pixelbolt atlas metadata of an untrimmed sheet; image: the sheet's path relative to the .tres (default
//   meta.image, the sheet beside it); name: the source's name in Godot's editor.
// - tiles: its autotile frames ({ frame, mask, mode, terrain? }, blob masks reduced; see autotileFrames). Each joins
//   the terrain it names, or the source's `terrain` (default its name), with peering bits from its neighbour mask, so
//   Godot's terrain painter picks the tile Pixelbolt's tilemap would. Every terrain is a terrain set of its own, so its
//   edges open onto any other terrain, as they do in Pixelbolt's tilemaps. Frames of one terrain and mask are
//   alternatives Godot picks between at random.
// - layered: tiles of a layered set ({ frame, corners }, corners the terrain names at NW, NE, SW and SE), one terrain set
//   matching corners whose terrains come in order of first appearance, the first the ground under the others. Godot
//   paints a terrain where four cells painted with it meet, and keeps a point's terrain otherwise, so the ground is an
//   unset corner: a cell painted alone, or at the edge of the painted area, still finds its tile. Every tile is there
//   once per terrain as its centre (alternative tiles on one sheet cell), since the painter puts each painted cell's
//   terrain in its centre whatever its corners are.
// - plain: other frames that are tiles without a terrain (props, decorations).
// - colors: each terrain's colour in Godot's editor, { [terrain]: [r, g, b] } from 0 to 255 (default white).
// - margin and separation: the sheet's padding and twice it, in exported pixels.
// A frame's tile.weight (in the atlas) becomes its probability, relative to the heaviest frame of its terrain or of the
// plain tiles, and its tile.collision polygons on physics layer 0, one-way with tile.oneWay. An atlas animation that
// loops over frames of one terrain and mask, or plain frames, laid side by side in a row of the sheet becomes an
// animated tile. Returns { text, warnings }; text is null when a terrain mixes blob, cardinal or corner masks.
export function tileSets(sources) {
  const warnings = [], size = source => { const { w, h } = source.atlas.frames[source.tiles[0]?.frame ?? source.layered?.[0]?.frame ?? source.plain[0]].frame; return [w, h]; };
  const [w, h] = size(sources[0]);
  const kept = sources.filter(source => {
    const [sw, sh] = size(source);
    if (sw === w && sh === h) return true;
    warnings.push(`${source.name}: left out: its tiles are ${sw}×${sh} and the TileSet's are ${w}×${h}; export it on its own`);
    return false;
  });
  // Terrains in order of first appearance, one terrain set each.
  const terrains = new Map(), modes = new Map();
  for (const source of kept) for (const tile of source.tiles) {
    const name = tile.terrain ?? source.terrain ?? source.name;
    if (!terrains.has(name)) terrains.set(name, { index: terrains.size, mode: tile.mode, color: source.colors?.[name] ?? [255, 255, 255], masks: new Set() });
    terrains.get(name).masks.add(tile.mask);
    if (!modes.has(name)) modes.set(name, new Set());
    modes.get(name).add(tile.mode);
  }
  const mixed = [...modes].filter(([, set]) => set.size > 1).map(([name]) => name);
  if (mixed.length) {
    const kinds = [...new Set(mixed.flatMap(name => [...modes.get(name)]))].sort(), listed = kinds.length === 2 ? kinds.join(' and ') : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`;
    return { text: null, warnings: [`not written: ${mixed.length === 1 ? `terrain ${mixed[0]} mixes` : `terrains ${mixed.join(', ')} mix`} ${listed} masks, and a Godot terrain matches one way; give one set's frames another tile.terrain, or export each set from its own recipe`] };
  }
  // Layered sets come after the single terrains, one terrain set each.
  let next = terrains.size;
  const layeredSets = kept.map(source => {
    if (!source.layered?.length) return null;
    const names = [];
    for (const tile of source.layered) for (const corner of tile.corners) if (!names.includes(corner)) names.push(corner);
    const combinations = names.length * names.length * names.length * names.length, missing = combinations - new Set(source.layered.map(tile => tile.corners.join())).size;
    if (missing > 0) warnings.push(`${kept.length > 1 ? `${source.name}: ` : ''}${missing} of the ${combinations} combinations of ${names.join(', ')} at a tile's corners have no tile, so Godot draws its nearest match where one is needed`);
    return { index: next++, names, colors: names.map(name => source.colors?.[name] ?? [255, 255, 255]) };
  });
  const named = keys => `animation${keys.length === 1 ? '' : 's'} ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''} became still tiles of ${keys.length === 1 ? 'its' : 'their'} first frame`;
  const prepared = kept.map(source => {
    const { atlas, margin = 0, separation = 0 } = source, plain = new Set(source.plain ?? []);
    const byFrame = new Map(source.tiles.map(tile => [tile.frame, { ...tile, terrain: tile.terrain ?? source.terrain ?? source.name }]));
    const cornered = new Map((source.layered ?? []).map(tile => [tile.frame, tile.corners]));
    const coords = frame => { const { x, y } = atlas.frames[frame].frame; return [(x - margin) / (w + separation), (y - margin) / (h + separation)]; };
    // What a frame is as a tile: its terrain and mask, its corners' terrains, '' for a plain tile, or null for no tile.
    const kind = frame => (byFrame.has(frame) ? `${byFrame.get(frame).terrain} ${byFrame.get(frame).mask}` : cornered.has(frame) ? `corners ${cornered.get(frame).join()}` : plain.has(frame) ? '' : null);
    // Animated tiles: Godot plays a tile's frames from its own cell rightwards along the row, always looping.
    const animated = new Map(), covered = new Set(), starts = new Set(), wrapped = [], unplayable = [];
    for (const [key, animation] of Object.entries(atlas.animations)) {
      const frames = animation.frames, first = kind(frames[0]);
      // A frame that starts an earlier animation stays a tile, so an animation that would hide it is left out.
      if (frames.length < 2 || first === null || frames.some(frame => covered.has(frame) || kind(frame) !== first || (frame !== frames[0] && starts.has(frame)))) continue;
      // Its later frames are never tiles of their own, so a set whose animation can't play doesn't flicker between them.
      // Its first frame is its tile, even where the animation comes back to it (a hold, or a loop that ends on it).
      starts.add(frames[0]);
      for (const frame of frames.slice(1)) if (frame !== frames[0]) covered.add(frame);
      const cells = frames.map(coords), [col, row] = cells[0];
      if (animation.loop && cells.every(([c, r], i) => c === col + i && r === row)) animated.set(frames[0], frames.map(frame => atlas.frames[frame].duration));
      // In sheet order but running onto the next row: more columns fix it.
      else if (animation.loop && cells.every(([c, r], i) => i === 0 || (c === cells[i - 1][0] + 1 && r === cells[i - 1][1]) || (c === 0 && r === cells[i - 1][1] + 1))) wrapped.push(key);
      else unplayable.push(key);
    }
    const prefix = kept.length > 1 ? `${source.name}: ` : '';
    if (wrapped.length) {
      const counts = [...new Set(wrapped.map(key => atlas.animations[key].frames.length))];
      warnings.push(`${prefix}${named(wrapped)}: ${wrapped.length === 1 ? 'its frames run' : 'their frames run'} onto the next row of the sheet, and Godot animates a tile only through frames side by side in one row. Set sheet.columns to a multiple of ${counts.length === 1 ? counts[0] : 'each animation\'s frame count'}`);
    }
    if (unplayable.length) warnings.push(`${prefix}${named(unplayable)}: Godot animates a tile by playing the frames after it in the sheet once each, in order, looping`);
    const frames = Object.keys(atlas.frames).filter(frame => kind(frame) !== null && !covered.has(frame));
    return { source, byFrame, cornered, coords, animated, frames };
  });
  // Probabilities: each frame's weight against the heaviest of its terrain, of the layered tiles with its corners (a
  // plain tile and its variants), or of the plain tiles.
  const weight = (atlas, frame) => atlas.frames[frame].tile?.weight ?? 1, heaviest = new Map();
  const groupOf = (byFrame, cornered, frame, i) => byFrame.get(frame)?.terrain ?? (cornered.has(frame) ? `\u0000layers ${i} ${cornered.get(frame).join()}` : '');
  for (const [i, { source, byFrame, cornered, frames }] of prepared.entries()) for (const frame of frames) {
    const group = groupOf(byFrame, cornered, frame, i);
    heaviest.set(group, Math.max(heaviest.get(group) ?? 1, weight(source.atlas, frame)));
  }
  for (const [name, terrain] of terrains) {
    const missing = TILE_MASKS[terrain.mode] - terrain.masks.size;
    if (missing > 0) warnings.push(`${terrains.size > 1 ? `terrain ${name}: ` : ''}${missing} of the ${TILE_MASKS[terrain.mode]} ${terrain.mode} masks have no tile, so Godot draws its nearest match where one is needed`);
  }
  let solid = false;
  const lines = ['[gd_resource type="TileSet" format=3]', '', ...kept.map((source, i) => `[ext_resource type="Texture2D" path=${quote(source.image ?? source.atlas.meta.image)} id="${i + 1}_sheet"]`), ''];
  const ids = kept.map((_, i) => `TileSetAtlasSource_tiles${i ? i + 1 : ''}`);
  prepared.forEach(({ source, byFrame, cornered, coords, animated, frames }, i) => {
    const { atlas, margin = 0, separation = 0 } = source;
    lines.push(`[sub_resource type="TileSetAtlasSource" id="${ids[i]}"]`, `resource_name = ${quote(source.name)}`, `texture = ExtResource("${i + 1}_sheet")`);
    if (margin) lines.push(`margins = Vector2i(${margin}, ${margin})`);
    if (separation) lines.push(`separation = Vector2i(${separation}, ${separation})`);
    // Godot leaves out its default 16 × 16, here and in tile_size.
    if (w !== 16 || h !== 16) lines.push(`texture_region_size = Vector2i(${w}, ${h})`);
    const set = layeredSets[i];
    for (const frame of frames) {
      const tile = byFrame.get(frame), corners = cornered.get(frame), facts = atlas.frames[frame].tile ?? {}, cell = coords(frame).join(':');
      animated.get(frame)?.forEach((ms, k) => lines.push(`${cell}/animation_frame_${k}/duration = ${real(ms / 1000)}`));
      // A layered tile once for each terrain as its centre; any other tile once.
      const centres = corners ? set.names.length : 1;
      if (centres > 1) lines.push(`${cell}/next_alternative_id = ${centres}`);
      const probability = weight(atlas, frame) / heaviest.get(groupOf(byFrame, cornered, frame, i));
      for (let alt = 0; alt < centres; alt++) {
        const at = `${cell}/${alt}`;
        lines.push(`${at} = ${alt}`);
        if (tile) lines.push(`${at}/terrain_set = ${terrains.get(tile.terrain).index}`, `${at}/terrain = 0`);
        if (corners) lines.push(`${at}/terrain_set = ${set.index}`, `${at}/terrain = ${alt}`);
        if (probability !== 1) lines.push(`${at}/probability = ${Number(probability.toFixed(6))}`);
        // Godot places a tile's polygons around the tile's centre.
        (facts.collision ?? []).forEach((polygon, k) => {
          solid = true;
          lines.push(`${at}/physics_layer_0/polygon_${k}/points = PackedVector2Array(${polygon.flatMap(({ x, y }) => [x - w / 2, y - h / 2]).join(', ')})`);
          if (facts.oneWay) lines.push(`${at}/physics_layer_0/polygon_${k}/one_way = true`);
        });
        if (tile) for (const [peer, bit] of PEERS[tile.mode]) if (tile.mask & bit) lines.push(`${at}/terrains_peering_bit/${peer} = 0`);
        // The ground (the set's first terrain) is an unset corner.
        if (corners) for (const [peer, bit] of PEERS.corner) { const terrain = set.names.indexOf(corners[CORNER_INDEX[bit]]); if (terrain > 0) lines.push(`${at}/terrains_peering_bit/${peer} = ${terrain}`); }
      }
    }
    lines.push('');
  });
  lines.push('[resource]', ...(w !== 16 || h !== 16 ? [`tile_size = Vector2i(${w}, ${h})`] : []));
  if (solid) lines.push('physics_layer_0/collision_layer = 1');
  for (const [name, terrain] of terrains) {
    const set = `terrain_set_${terrain.index}`;
    lines.push(`${set}/mode = ${TERRAIN_MODES[terrain.mode]}`, `${set}/terrain_0/name = ${quote(name)}`, `${set}/terrain_0/color = Color(${terrain.color.map(channel).join(', ')}, 1)`);
  }
  for (const layered of layeredSets.filter(Boolean)) {
    const set = `terrain_set_${layered.index}`;
    lines.push(`${set}/mode = ${TERRAIN_MODES.corner}`);
    layered.names.forEach((name, t) => lines.push(`${set}/terrain_${t}/name = ${quote(name)}`, `${set}/terrain_${t}/color = Color(${layered.colors[t].map(channel).join(', ')}, 1)`));
  }
  lines.push(...ids.map((id, i) => `sources/${i} = SubResource("${id}")`), '');
  return { text: lines.join('\n'), warnings };
}
// One sheet's TileSet: tileSets([{ atlas, tiles, ...options }]); options.color is its terrain's editor colour.
export const tileSet = (atlas, tiles, { color, ...options } = {}) => tileSets([{ atlas, tiles, plain: [], ...options, ...(color && { colors: { [options.terrain ?? options.name]: color } }) }]);
