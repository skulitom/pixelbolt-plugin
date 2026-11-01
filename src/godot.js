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

// `atlas` is Pixelbolt atlas metadata ({ frames, animations, meta }); `image` is the sheet's path relative to the
// .tres (default: meta.image, the sheet beside it). Animations keep the atlas's order, so the first one is the one an
// AnimatedSprite2D shows when the resource is assigned. Returns the text and the animations whose durations are not
// exact (see godotTiming).
export function spriteFrames(atlas, { image = atlas.meta.image } = {}) {
  const animations = Object.entries(atlas.animations), approximate = [];
  // Only frames an animation plays become textures, in recipe order.
  const used = new Set(animations.flatMap(([, animation]) => animation.frames));
  const names = Object.keys(atlas.frames).filter(name => used.has(name));
  const id = name => `AtlasTexture_${name}`;
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
// set matches corners and sides (Godot terrain mode 0), a cardinal set sides only (mode 2).
const PEERS = {
  blob: [['right_side', 4], ['bottom_right_corner', 8], ['bottom_side', 16], ['bottom_left_corner', 32], ['left_side', 64], ['top_left_corner', 128], ['top_side', 1], ['top_right_corner', 2]],
  cardinal: [['right_side', 2], ['bottom_side', 4], ['left_side', 8], ['top_side', 1]]
};
const TERRAIN_MODES = { blob: 0, cardinal: 2 };
// How many distinct masks a complete set has.
const TILE_MASKS = { blob: 47, cardinal: 16 };
// Godot writes colour components without a forced decimal point: Color(0.25, 0.5, 0.75, 1).
const channel = value => String(Number((value / 255).toFixed(6)));

// A Godot 4 TileSet over an untrimmed atlas: one atlas source on the sheet's grid and one terrain whose peering bits
// come from each tile's neighbour mask, so Godot's terrain painter picks the tile Pixelbolt's tilemap would. `tiles`
// lists the atlas frames that are tiles ({ frame, mask, mode }, blob masks reduced; see autotileFrames). Frames of one
// mask are alternatives Godot picks between at random, except an atlas animation that loops over frames of one mask
// laid side by side in a row of the sheet, which becomes an animated tile. `margin` and `separation` are the sheet's
// padding and twice it, in exported pixels; `color` is the terrain's colour in Godot's editor, [r, g, b] from 0 to
// 255. Returns { text, warnings }; text is null when the frames can't make one terrain.
export function tileSet(atlas, tiles, { image = atlas.meta.image, name, color = [255, 255, 255], margin = 0, separation = 0 } = {}) {
  const warnings = [], byFrame = new Map(tiles.map(tile => [tile.frame, tile]));
  const modes = [...new Set(tiles.map(tile => tile.mode))];
  if (modes.length !== 1) return { text: null, warnings: [`not written: the tiles mix ${modes.join(' and ')} masks, and a Godot terrain matches one way; export each set from its own recipe`] };
  const mode = modes[0], { w, h } = atlas.frames[tiles[0].frame].frame;
  const coords = frame => { const { x, y } = atlas.frames[frame].frame; return [(x - margin) / (w + separation), (y - margin) / (h + separation)]; };
  // Animated tiles: Godot plays a tile's frames from its own cell rightwards along the row, always looping.
  const animated = new Map(), covered = new Set(), wrapped = [], unplayable = [];
  for (const [key, animation] of Object.entries(atlas.animations)) {
    const frames = animation.frames, first = byFrame.get(frames[0]);
    if (frames.length < 2 || !first || frames.some(frame => covered.has(frame))) continue;
    if (!frames.every(frame => byFrame.get(frame)?.mask === first.mask && byFrame.get(frame).mode === first.mode)) continue;
    // Its later frames are never tiles of their own, so a set whose animation can't play doesn't flicker between them.
    for (const frame of frames.slice(1)) covered.add(frame);
    const cells = frames.map(coords), [col, row] = cells[0];
    if (animation.loop && cells.every(([c, r], i) => c === col + i && r === row)) animated.set(frames[0], frames.map(frame => atlas.frames[frame].duration));
    // In sheet order but running onto the next row: more columns fix it.
    else if (animation.loop && cells.every(([c, r], i) => i === 0 || (c === cells[i - 1][0] + 1 && r === cells[i - 1][1]) || (c === 0 && r === cells[i - 1][1] + 1))) wrapped.push(key);
    else unplayable.push(key);
  }
  const named = keys => `animation${keys.length === 1 ? '' : 's'} ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''} became still tiles of ${keys.length === 1 ? 'its' : 'their'} first frame`;
  if (wrapped.length) {
    const counts = [...new Set(wrapped.map(key => atlas.animations[key].frames.length))];
    warnings.push(`${named(wrapped)}: ${wrapped.length === 1 ? 'its frames run' : 'their frames run'} onto the next row of the sheet, and Godot animates a tile only through frames side by side in one row. Set sheet.columns to a multiple of ${counts.length === 1 ? counts[0] : 'each animation\'s frame count'}`);
  }
  if (unplayable.length) warnings.push(`${named(unplayable)}: Godot animates a tile by playing the frames after it in the sheet once each, in order, looping`);
  const masks = new Set(tiles.map(tile => tile.mask));
  if (masks.size < TILE_MASKS[mode]) warnings.push(`${TILE_MASKS[mode] - masks.size} of the ${TILE_MASKS[mode]} ${mode} masks have no tile, so Godot draws its nearest match where one is needed`);
  const lines = ['[gd_resource type="TileSet" format=3]', '', `[ext_resource type="Texture2D" path=${quote(image)} id="1_sheet"]`, ''];
  lines.push('[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_tiles"]', `resource_name = ${quote(name)}`, 'texture = ExtResource("1_sheet")');
  if (margin) lines.push(`margins = Vector2i(${margin}, ${margin})`);
  if (separation) lines.push(`separation = Vector2i(${separation}, ${separation})`);
  lines.push(`texture_region_size = Vector2i(${w}, ${h})`);
  for (const frame of Object.keys(atlas.frames)) {
    const tile = byFrame.get(frame);
    if (!tile || covered.has(frame)) continue;
    const cell = coords(frame).join(':');
    animated.get(frame)?.forEach((ms, i) => lines.push(`${cell}/animation_frame_${i}/duration = ${real(ms / 1000)}`));
    lines.push(`${cell}/0 = 0`, `${cell}/0/terrain_set = 0`, `${cell}/0/terrain = 0`);
    for (const [peer, bit] of PEERS[mode]) if (tile.mask & bit) lines.push(`${cell}/0/terrains_peering_bit/${peer} = 0`);
  }
  lines.push('', '[resource]', `tile_size = Vector2i(${w}, ${h})`, `terrain_set_0/mode = ${TERRAIN_MODES[mode]}`, `terrain_set_0/terrain_0/name = ${quote(name)}`);
  lines.push(`terrain_set_0/terrain_0/color = Color(${color.map(channel).join(', ')}, 1)`, 'sources/0 = SubResource("TileSetAtlasSource_tiles")', '');
  return { text: lines.join('\n'), warnings };
}
