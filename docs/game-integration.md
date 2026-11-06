# Using Pixelbolt assets in games

The bundle deliberately keeps the interchange format simple: RGBA PNGs plus JSON frame rectangles, and a Godot 4 SpriteFrames made from them (with a Godot TileSet and a Tiled tileset for an autotile set). By default every frame retains the full canvas and common origin; opt into trimmed packing with `sheet.trim` (below). Frames are never rotated. Use nearest-neighbor filtering and whole-pixel placement for crisp rendering (the bundled `drawFrame` snaps fractional positions to whole pixels for you).

## Phaser

Load the exported sheet with Phaser's [atlas loader and texture manager](https://docs.phaser.io/phaser/concepts/textures):

```js
preload() {
  this.load.atlas('spirit', 'assets/forest-spirit.png', 'assets/forest-spirit.atlas.json');
}
create() {
  this.add.sprite(200, 200, 'spirit', 'rest').setScale(4);
}
```

Set `pixelArt: true` in the game configuration. The atlas's extra `animations` object is Pixelbolt metadata; import it explicitly when building your engine's animation definitions. Each entry contains an expanded list of frame names, the total duration, and a loop flag. Per-frame durations live in `frames[name].duration` in milliseconds. Do not assume a constant frame rate when a recipe uses unequal durations.

## Godot 4

Every export includes `name.tres`, a Godot 4 `SpriteFrames` resource for `AnimatedSprite2D` and `AnimatedSprite3D`. Copy `name.png` and `name.tres` into one folder of your project, give an `AnimatedSprite2D` the `.tres` as its **Sprite Frames**, and play an animation by its recipe name:

```gdscript
$Spirit.sprite_frames = preload("res://sprites/forest-spirit.tres")
$Spirit.play("idle")
```

Set **Project Settings → Rendering → Textures → Canvas Textures → Default Texture Filter** (or the node's **Texture → Filter**) to Nearest, or Godot smooths the pixels.

- **Where the sheet is.** The `.tres` names the sheet by a path relative to itself (`path="forest-spirit.png"`), and Godot reads it from the `.tres`'s own folder, so the pair works anywhere in the project as long as the two stay together. Godot writes the path as `res://…` the next time it saves the resource. Move them in Godot's FileSystem dock, which updates the path; to point a `.tres` at a sheet elsewhere, change the `path` in its `[ext_resource]` line to the sheet's `res://` path or its path relative to the `.tres`. Godot only loads textures from inside the project. MCP `pixel_render` writes both into a project with `"saveAs": { "sheet": "game/sprites/spirit.png", "godot": "game/sprites/spirit.tres" }` (and an autotile set's TileSet with `"tileset"`), naming the saved sheet in the saved `.tres`, and refuses a `.tres` inside a Godot project (a folder with `project.godot`) whose sheet would be outside it.
- **Frames.** Each frame is an `AtlasTexture` with the frame's atlas rectangle as its `region` and `filter_clip` on. Its id is `AtlasTexture_` and the frame name, with underscores for hyphens, which Godot doesn't allow in an id. With `sheet.trim`, its `margin` puts the visible pixels back where they were on the canvas, so every frame is the full canvas size and trimmed frames line up exactly as untrimmed ones do.
- **Timing.** Each recipe animation becomes one animation, in recipe order, with its frames in playback order (reverse and ping-pong expanded) and its `loop`. Godot gives an animation one speed (FPS) and each frame a relative duration, and shows a frame for duration ÷ speed seconds. The speed is 1000 ÷ the largest step that divides every frame's milliseconds, so durations are whole numbers: frames of 100, 100 and 200 ms play at 10 FPS for 1, 1 and 2; the forest spirit's 240, 140 and 220 ms at 50 FPS for 12, 7 and 11. When that step is under 9 ms (Godot's SpriteFrames editor shows at most 120 FPS), the shortest frame sets the speed, at most 120 FPS, and the others last a fraction of it; Godot keeps durations as 32-bit floats, so those frames play within a ten-millionth of their length, and the export's warnings name the animations. Frame times in multiples of 10 ms are always exact.
- **Godot's playback.** Godot 4.6 and 4.7 run the rest of a process step after a frame change at the previous frame's speed ([godotengine/godot#123572](https://github.com/godotengine/godot/issues/123572)). A frame right after a shorter one ends early, by up to (its length ÷ the shorter one's − 1) display frames, and one after a longer one ends late by less than a display frame: at 60 FPS, a 100 ms frame right after a 5 ms flash can be skipped entirely. The `.tres` holds the exact times; give such flashes at least a display frame (17 ms) until Godot fixes it.

### Tile sets

A recipe whose frames are an autotile set also exports `name.tileset.tres`, a Godot 4 `TileSet`. That means a recipe compiled from a `pixelforge-autotile` source, any recipe whose frames each draw one `autotile` operation at their corner for at least two masks, or any recipe with a frame that has `tile`. The TileSet has one atlas source on the sheet's grid and one terrain named after the recipe; every other frame that draws something is a plain tile without a terrain (a rock, a flower), and an empty frame is no tile. A tile set with no `animations` of its own exports no SpriteFrames, APNGs, CSS or player, and its README says how to paint it. A blob set matches corners and sides (Godot's terrain mode 0), a cardinal set sides only (mode 2) and a corner set corners only (mode 1), and each tile's peering bits are its neighbour mask. Copy `name.png` and `name.tileset.tres` into one folder of your project, give a `TileMapLayer` the TileSet, and paint with the terrain: the **Terrains** tab of the TileMap panel in the editor, or `set_cells_terrain_connect` in code. Godot then picks the tile Pixelbolt's own tilemap picks for the same map, with cells outside the map empty. A corner terrain lives on the points where cells meet: Godot puts it where four painted cells meet, so the ground ends half a cell inside what you paint (3 × 3 painted cells draw 2 × 2 cells of ground, centred), and every painted cell holds the tile whose corners are those points, the empty tile where it has none. That is Pixelbolt's corner tilemap of the map of those points, drawn on the painted cells.

```gdscript
$Ground.tile_set = preload("res://tiles/grass.tileset.tres")
$Ground.set_cells_terrain_connect(cells, 0, 0) # terrain set 0, terrain 0
```

- **Variants.** Frames of one mask are alternative tiles. Godot picks between them at random, each at its frame's `tile.weight` against the heaviest frame of the terrain (`variants[].weight` in an autotile source; a flowered variant at 1 beside fills at 4 gets probability 0.25), where Pixelbolt's tilemap picks by a seeded hash of the cell, so the variant can differ but the mask never does. Plain tiles are weighted against each other the same way.
- **Transitions.** A layered set (`layers`, water under sand under grass) is one terrain set matching corners, with a terrain per layer, so Godot paints the transitions itself. Godot puts a terrain where four cells painted with it meet and keeps a point's terrain otherwise, so paint bottom-up: the lowest terrain over the whole area, then each higher terrain over its own cells and those of every terrain above it (sand over the sand and the grass, then grass over the grass). A point is then the lowest terrain of the four cells around it, and each cell holds the tile whose corners are those points, which is Pixelbolt's tilemap of the map of points; painting a terrain only on its own cells leaves the bottom terrain where two higher ones meet. The bottom terrain is written as an unset corner, so cells at the edge of the painted area find their tiles, and every tile is there once for each terrain as its centre (alternative tiles on one sheet cell), since the painter puts each painted cell's own terrain in its centre. A layer's variants of its plain tile are more tiles with the same corners, which Godot picks between at random by `tile.weight` against the heaviest of them; a solid layer's polygons are on every alternative.
- **Slopes.** An autotile source's `slopes` are plain tiles with a polygon under each slope's line (and its foot's), so a `CharacterBody2D` with `floor_max_angle` above 45° walks them. Godot's terrain painter has no slopes: paint the terrain, then place each slope by hand and its foot in the cell under its low end, as `metadata.slopes.legend` draws them.
- **Collision.** A frame's `tile.collision` becomes polygons on physics layer 0 (collision layer 1), one-way with `tile.oneWay`, so a `CharacterBody2D` collides with the painted map with no editing. An autotile source's `collision` writes a box per tile, kept from each open side by that edge's depth, so a body stands on the drawn ground; a corner tile gets the boxes of its terrain quarters, two polygons where two cells touch only at its middle. Polygons are in exported pixels around the tile's centre, as Godot keeps them.
- **Several sets.** Each terrain is a terrain set of its own, so a set's edges open onto every other set, as Pixelbolt's tilemaps draw them. Two sets in one recipe need their own `tile.terrain` on each frame (blob, cardinal and corner frames can't share one). A scene export (`pixelbolt scene`) writes `tileset.tres` holding every asset that is a tile set, each an atlas source over `assets/<n>/color.png` (or its `canvas_texture.tres` when it has a normal pass, so lights reach the tiles) and a terrain named by the asset's id, so one `TileMapLayer` paints grass, water and cliffs; `alignment.json` names it under `tileset`. One TileSet has one tile size, so a set of another exported size is left out, with a warning.
- **Animated tiles.** An animation that loops over frames of one mask, such as those the autotile compiler's `animation` makes, becomes an animated tile with each frame's time, if its frames sit side by side in one row of the sheet. With the default 8 columns that holds for 1, 2, 4 or 8 variants. Otherwise set `sheet.columns` to a multiple of the variant count; without that, the export warns and the tile keeps its first frame.
- **Sheet.** Padding and scale become the atlas source's margins and separation. `sheet.trim` packs frames without a grid, so a trimmed recipe gets no TileSet, and the export says so. A set missing some masks gets a warning, since Godot draws the nearest match there.
- **Filter.** As for sprites, set the default texture filter, or the TileMapLayer's **Texture → Filter**, to Nearest.

`node scripts/verify-godot.mjs` (with Godot 4 on `PATH`, in `GODOT` or passed as `--godot <path>`) imports the forest spirit and a trimmed, scaled sheet with unequal durations into a headless Godot project, and checks every frame's region, margin, size, pixels and time, and each animation's playback step by step. It then loads a blob, a cardinal, an animated, a weighted one-way TileSet with plain tiles, a weighted corner TileSet with collision, a layered set of three terrains with variants of a plain tile and solid water (painted bottom-up, so every cell must hold a tile with the corners and centre terrain the map of points gives it), and a scene's TileSet holding three sets, checks every tile's terrain, peering bits, probability, collision polygons, region, pixels and frame times, and paints maps (islands, strips, inner corners, a ring, cells that touch only at a corner, a scatter; for the scene, all three sets on one layer) with Godot's terrain painter, which must choose Pixelbolt's tile in every cell. Last it loads a lit scene asset and checks that every frame draws through `canvas_texture.tres` and that its normal map is `normal.png` with green flipped. With `--render` it also lights the sprite in a Godot window (Godot can't render headless) from above, below, left and right: the half facing the light must be brighter, and a control drawn with the unflipped `normal.png` must come out upside down.

### Tiled

A tile set also exports `name.tsx`, a [Tiled](https://www.mapeditor.org) tileset over `name.png` beside it: in a map whose tiles are the exported frame size, **Map → Add External Tileset**. The sheet is Tiled's grid (padding becomes margin, twice the padding spacing), and a tile's id is its frame's index in the recipe. A trimmed sheet has no grid, so it gets no `.tsx`.

- **Terrains.** Each terrain is a Wang set (Tiled's terrain set) for the Terrain Brush: a blob set is mixed (sides and corners), a cardinal set an edge set and a corner set a corner set, one colour each, and each tile's Wang id is its neighbour mask, so the brush picks the tiles Pixelbolt's tilemaps draw. Tiled paints the sides and corners between cells, not cells, so the tile of a lone blob or cardinal cell (mask 0, its terrain on no side) is no Wang tile: place it by hand. A corner set's empty tile is none either; Tiled leaves the cell empty.
- **Transitions.** A layered set is one corner Wang set with a colour per terrain, bottom first. A corner set's corners are the points where four cells meet, which are Pixelbolt's map cells: paint each terrain on the points where a Pixelbolt map has its cells. Every mix of them has a tile, so there is no painting order.
- **Variants and weights.** Tiles with one Wang id are alternatives the brush picks between at random, at each tile's `probability`: its `tile.weight` against the heaviest tile of its kind (its terrain and mask, its corners, or the plain tiles).
- **Slopes.** A set's slopes and their feet are plain tiles with their collision objects, outside the Wang sets: paint the terrain, then place them by hand.
- **Collision.** `tile.collision` polygons are objects in each tile's collision group (the Tile Collision Editor), in exported pixels; `tile.oneWay` is a bool property `oneWay` on the tile, for the game to read.
- **Animated tiles.** An animation that loops over frames of one kind animates its first frame's tile, with each frame's time, wherever its frames are on the sheet; its later frames are left out of the Wang sets, so the brush never places a still frame of it.
- **Scenes.** A scene export (`pixelbolt scene`, MCP `pixel_scene`) writes `assets/<n>/tileset.tsx` beside every asset's `color.png` (a Tiled tileset has one image): a tile set's with its terrains, any other asset's with its frames as tiles and its looping animations animated. `alignment.json` names each under the asset's `tiled`, and the map under `tiled`.

#### The scene as a Tiled map

A scene export also writes `scene.tmx`, a Tiled map of the scene as it stands at its start, unlit, over those tilesets: what Pixelbolt draws then, in its drawing order and at its scene positions, so Tiled draws the unlit view (`unlit.png`). Placements in a sequence, on a trajectory, attached or lifted are where they are at that time, each showing the frame it shows then; a frame with a looping animation animates in Tiled.

- **Tile layers.** A tilemap becomes a tile layer, painted with its asset's tiles (and its Wang sets, so the Terrain Brush carries on with it), when Tiled's grid can hold it: square cells the size of the map's grid (the first such tilemap's cells), one frame per cell, at 1× from a sheet exported at 1× (`sheet.scale` 1), and not sorted among other placements. A corner map's layer is offset half a cell up and left, and a map whose frames are taller than its cells sits lower by the difference, since Tiled hangs a tile from the bottom of its cell where Pixelbolt hangs it from the top; whole cells of a map's position move its cells, the rest is the layer's offset.
- **Tile objects.** Everything else becomes tile objects in an object layer drawn in list order: placements and each copy of a repeat, sorted tilemaps (their cells draw among the placements they sort with), iso maps, maps at 2× or more and maps of sheets exported larger, which Tiled draws back at the scene's size.
- **What stays in the scene.** Shade placements, which darken what is under them, are left out, and hazed placements are drawn without their haze, each with a warning. Lights, shadows, the camera's movement and parallax have no place in the map: it is the scene with the camera at its start.

`node scripts/verify-tiled.mjs` also exports a scene holding every kind of placement (layered, corner and blob maps, frames taller than their cells, a 3× sheet, a sorted map among a sorted placement, a placement at 2× whose partly transparent glow falls on tiles, a repeat), reads `scene.tmx` with Tiled's reader, checks its tilesets and layers, and renders it with `tmxrasterizer`, which must draw the unlit scene: exactly, but for one step where a partly transparent pixel blends.

`node scripts/verify-tiled.mjs` (with Tiled 1.10.2 or later on `PATH`, in `TILED` or passed as `--tiled <path>`) runs a script in a headless Tiled that reads the Godot check's tile sets with Tiled's own reader and checks the grid, every tile's probability, collision polygons, `oneWay` and animation, and each Wang set's type, colours and Wang ids. It then paints the same maps with Tiled's terrain filler, every side and corner of every cell given its colour, and every tile Tiled chooses must be one Pixelbolt's tilemap draws there; last, `tmxrasterizer` draws a map of every tile, which must give each frame's exported pixels.

### Effects round a character

An effect with parts behind a character (a `depth` on its layers or emitters, see [effects round a character](art-workflow.md#particle-effects)) exports `<effect>-back` and `<effect>-front` beside `<effect>`, with the same frame count, timing and anchor. Give the character two `AnimatedSprite2D` siblings with the same Sprite Frames, one before it in the tree (or at a lower `z_index`) and one after, and start both together:

```gdscript
$BuffBack.play("buff-back")
$BuffFront.play("buff-front")
```

Any engine does the same: draw the back part, then the character, then the front part, at the same place and frame. The whole `<effect>` is for previews and sharing; when the source draws a stand-in figure (`depth: "between"`), only the whole effect shows it.

## Unity and other grid importers

Keep the default untrimmed layout and set `sheet.padding` to `0`. Cell dimensions are `project.width × sheet.scale` and `project.height × sheet.scale`. Set your importer to multiple sprites or a frame grid and use `sheet.columns` horizontal cells. A partially filled last row contains transparent unused cells; use only the number of frames in the JSON.

Alternatively, import the PNGs in `frames/`, which removes any need for atlas slicing. Transfer the duration in milliseconds for each frame into the engine's frame-delay or keyframe controls. The source canvas is not trimmed, so the same pivot/origin keeps frames aligned.

## Normal and emissive passes

`pixelbolt scene <scene.json> --out <dir>` exports each lit asset's `color.png`, `normal.png` and `emissive.png` on one shared atlas grid, with `alignment.json` naming the files, and a Godot `sprite_frames.tres`. An asset with a normal pass also gets `normal_y_up.png` and `canvas_texture.tres` (below), and its `sprite_frames.tres` draws through that CanvasTexture; without one, `sprite_frames.tres` plays the colour pass. A normal recipe on its own renders with `pixelbolt render` like any recipe; a generated pass (`pixelforge-normals`) has exactly the colour recipe's frame rectangles, trimmed or not, so one atlas JSON slices both.

Normal RGB encodes XYZ from −1 to +1 as `(v + 1) × 127.5`, with +X right, +Y down and +Z toward the viewer. That is the "Y−" or DirectX convention, which Unreal also uses. Godot and Unity expect +Y up, or lights above a sprite shade it as if they were below. `normal_y_up.png` is the same pass with the green channel flipped for them:

- **Godot 4**: copy the asset's folder into your project and give an `AnimatedSprite2D` its `sprite_frames.tres`. Light2D nodes such as `PointLight2D` then light it through the normal map, with no import settings to change. `canvas_texture.tres` pairs `color.png` with `normal_y_up.png` and draws with nearest filtering; for a single frame, use it as a `Sprite2D`'s texture with a region. To use `normal.png` yourself instead, enable **Normal Map Invert Y** in its Import dock and reimport.
- **Unity**: use `normal_y_up.png` with the texture type **Normal map**, compression off and point filtering, as the colour sprite's `_NormalMap` secondary texture for the 2D renderer's lights. (`normal.png` works with **Flip Green Channel** on, `TextureImporter.flipGreenChannel` in scripts.)

Keep normal and emissive textures uncompressed with nearest filtering: compression and smoothing blend neighbouring directions and colours, and pixel-art lighting depends on each pixel keeping its own.

## Canvas

The exported `player.js` provides a complete player, without an engine or runtime package dependency:

```js
import { SpritePlayer } from './player.js';
const player = await SpritePlayer.load(canvas, './forest-spirit.atlas.json', { scale: 4 });
player.play('idle');
player.pause();
player.resume();
player.play('blink'); // A once-only sequence holds its last frame.
// Release the animation loop when the component is removed:
player.destroy();
```

Use an HTTP server for module imports/fetch. The separate `preview.html` and APNGs work directly from disk. APNGs follow the [PNG specification](https://www.w3.org/TR/png-3/) and use full-frame source replacement, preserving transparency without motion trails.

## Atlas contract

The forest spirit's atlas, with the first of its six frames:

```json
{
  "frames": {
    "rest": {
      "frame": { "x": 1, "y": 1, "w": 24, "h": 24 },
      "rotated": false,
      "trimmed": false,
      "spriteSourceSize": { "x": 0, "y": 0, "w": 24, "h": 24 },
      "sourceSize": { "w": 24, "h": 24 },
      "duration": 240
    }
  },
  "animations": {
    "idle": { "frames": ["rest", "rise", "float", "blink", "float", "fall", "settle"], "loop": true, "duration": 1220 },
    "bob": { "frames": ["rest", "rise", "float", "rise"], "loop": true, "duration": 740 },
    "blink": { "frames": ["rest", "blink", "rest"], "loop": false, "duration": 580 }
  },
  "meta": {
    "image": "forest-spirit.png", "size": { "w": 156, "h": 26 }, "scale": "1",
    "frameTags": [{ "name": "bob", "from": 0, "to": 2, "direction": "pingpong" }]
  }
}
```

`frame` gives the exact source rectangle in the PNG, including export scale but excluding surrounding transparent padding. `meta.scale` records the scale already applied; do not multiply coordinates by it.

`meta.frameTags` lists Aseprite-style tags for tools that read Aseprite's JSON: `from` and `to` index the atlas's frames in order, and `direction` is `forward`, `reverse` or `pingpong` (forward and back without repeating either end). A tag can only name one run of frames, so an animation that holds, skips or reorders frames, such as the forest spirit's `idle`, has none; `animations` lists every animation in full, with its loop flag.

With `sheet.trim: true`, each `frame` rectangle holds only the visible pixels: `trimmed` is true, `spriteSourceSize` gives the rectangle's offset inside the unchanged `sourceSize`, and the frames/ PNGs stay full-canvas. Recipes with an `anchor` (compiled poses always have one) add `anchor` in exported pixels and `pivot` = anchor ÷ source size, which Phaser's JSON-hash loader reads as a custom pivot. Frames with named `points` (pose markers such as a blade tip or foot contact, or glyph advances) list them in exported pixels. The bundled `player.js` exports `loadSpriteSheet`, `frameAt` and `drawFrame`, which honor all of these. The TexturePacker-style frame layout is intended for existing atlas importers, but engine-specific integration should be checked in your target engine; this repository tests the bundled Canvas runtime and binary exports.
