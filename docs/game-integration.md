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

Set `pixelArt: true` in the game configuration. The atlas's extra `animations` object is Pixelbolt metadata (absent for stills and a still tile set, see [Atlas contract](#atlas-contract)); import it explicitly when building your engine's animation definitions. Each entry contains an expanded list of frame names, the total duration, and a loop flag. Per-frame durations live in `frames[name].duration` in milliseconds. Do not assume a constant frame rate when a recipe uses unequal durations.

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
- **Alpha.** The sheet, the frame PNGs and the animated PNGs store straight (unpremultiplied) alpha: a half-transparent glow keeps its full colour next to its alpha, which is what Godot's default Mix blend mode expects. Leave **Premult Alpha** off in the texture's Import dock: with it on, Mix multiplies the colour by its alpha a second time and glows and soft edges go dark. Turn it on only for a material whose blend mode is Premult Alpha.

### The editor addon: recipes as SpriteFrames

The Pixelbolt addon for Godot makes the recipe itself the asset. Keep `hero.pixel.json` in the project, and Godot imports it as a `SpriteFrames` resource that an `AnimatedSprite2D` can use straight away, with no export to run and no `.tres` that can go stale. Your own Pixelbolt renders it, and it renders again when the file changes. Each import is built from the `.png` and `.tres` the CLI writes, so it has the same frames, regions, trim margins, loops and frame times as an export.

```gdscript
$Hero.sprite_frames = preload("res://sprites/hero.pixel.json")
$Hero.play("walk")
```

- **Install.** Copy the `addons/pixelbolt/` folder into your project's `addons/` folder. You can take it from [the repository's `godot/addons/pixelbolt`](https://github.com/skulitom/Pixelbolt/tree/main/godot/addons/pixelbolt), or unzip a release's `pixelbolt-godot-<version>.zip` at the project's root. 0.20.0 is the first release to carry the zip. Then enable **Pixelbolt** under **Project → Project Settings → Plugins**.
- **Which files.** It imports `*.pixel.json` files on Godot 4.5 and later (the name `pixelbolt init` gives a new recipe; `hero.poses.pixel.json` works too) and `*.pixelbolt` files on every version from 4.3. Other `.json` files are left alone. A file can be a plain recipe or any source `pixelbolt compile` accepts, such as a `pixelforge-poses` character or a `pixelforge-fx` effect: the addon compiles it first, then renders it. Palette `$ref`s resolve from the recipe's own folder, as they do on the command line. A CLI export folder copied into the project holds `<name>.pixel.json`, a copy of its recipe, which the addon imports too: delete it, or keep exports outside the project.
- **What it needs.** Node.js 20 or newer, and Pixelbolt. The addon looks for the CLI in this order: the **Pixelbolt → Cli → Path** project setting (a `pixelbolt` executable, or the package's `pixelbolt.js` script, absolute or relative to the project folder), `node_modules/pixelbolt` beside `project.godot` (`npm install --save-dev pixelbolt` in that folder), then `pixelbolt` on `PATH` (`npm install -g pixelbolt`). It runs `npx pixelbolt@<version>` only if you turn on **Allow Npx**, because that downloads code. Its version is pinned in **Npx Version**. Turn on **Advanced Settings** to see these. **Node Path** names Node.js for the `pixelbolt.js` script (a project install, or **Path** set to the script) when `node` isn't on the editor's `PATH`. An editor started from the macOS Dock usually has neither on its `PATH`: set **Path** to the script and **Node Path** to `node`. **Timeout Seconds** (default 120) stops a render that runs too long.
- **Crisp pixels.** By default the sheet is drawn through a `CanvasTexture` with nearest filtering, so the sprite stays sharp whatever the project's default filter is. A `CanvasTexture` draws only in 2D. For an `AnimatedSprite3D`, set the recipe's **Texture Filter** import option to **Inherit**, which gives a plain texture, and set the node's filter to Nearest.
- **Tile sets.** To import an autotile recipe as its `TileSet`, select the file and pick **Import As → Pixelbolt TileSet** in the Import dock. Godot remembers the choice. Give a `TileMapLayer` the result, as with an exported `.tileset.tres` ([Tile sets](#tile-sets)).
- **What it writes.** Nothing beside your recipe but Godot's own `.import` file. The import lives in Godot's own `.godot/imported/` folder, with the sheet inside it, and each render runs in a fresh folder that is removed afterwards. The resource's `pixelbolt` metadata names the Pixelbolt version that rendered it.
- **When a render fails.** If Node.js or the CLI isn't found, the recipe is invalid, or a render passes the timeout, the Output panel shows one line starting `Pixelbolt:` with Pixelbolt's own message, and the previous import stays in use, so no scene loses its sprite. Fix the recipe and save. After installing Node.js or changing a setting, use **Project → Tools → Pixelbolt: Reimport all recipes**, since no file changed.
- **Tested** with Godot 4.3, 4.7.2 and 4.8-beta4 on Windows, and 4.3 and 4.7.2 on Linux in CI (not yet on macOS), where every frame, time and pixel is compared with the CLI's own `.tres` (`node scripts/verify-godot-addon.mjs --godot <path>`).
- **A demo.** Open the repository's `godot/` folder in Godot 4.5 or later. It renders `demo/hero.pixel.json`, the shipped hero, with the checkout's own CLI, and plays its animations in turn.

### Facing and headings

A sprite stack, or any recipe that declares `headings`, says in its atlas which frame stands at each heading and which animation plays a name there:

```json
"meta": { "headings": {
  "frames": { "0": "heading-0", "45": "heading-45" },
  "animations": { "walk": { "0": "walk-sw", "45": "walk-w" } },
  "toward": { "0": [-0.8944, 0.4472], "45": [-1, 0] }
} }
```

A heading is a whole number of degrees from 0 to 359. `toward` is the direction on screen the subject faces at that heading, y down; a stack's front is its +y, south side, and it turns clockwise on screen as the heading grows. `player.js` picks from these:

```js
import { loadSpriteSheet, drawFrame, frameAt, headingFrame, headingAnimation, headingToward } from './player.js';
const sheet = await loadSpriteSheet('./iso-villager.atlas.json'), { atlas } = sheet;
const facing = headingToward(atlas, velocity.x, velocity.y, 'walk');   // the heading that faces the way he moves
const walk = headingAnimation(atlas, 'walk', facing);                  // "walk-se"
drawFrame(context, sheet, moving ? frameAt(atlas, walk, time) : headingFrame(atlas, facing), x, y);
```

`nearestHeading(atlas, degrees)` gives the listed heading nearest any number of degrees (they go round at 360; of two equally near, the lower), and `headingFrame` and `headingAnimation` use it. With an animation's name, the lookup is among that animation's own headings, which may be fewer than the frames'.

In Godot the `SpriteFrames` carries the same lookup as its `headings` metadata, with each heading's frame given as the animation that plays it and its place there. The addon's `headings.gd` reads it (copy that one file if you use the exported `.tres` without the addon):

```gdscript
const Headings := preload("res://addons/pixelbolt/headings.gd")

func _process(_delta: float) -> void:
	var frames: SpriteFrames = $Villager.sprite_frames
	var facing := Headings.toward(frames, velocity, &"walk")
	if velocity != Vector2.ZERO:
		$Villager.play(Headings.animation(frames, &"walk", facing))
```

`Headings.frame(frames, degrees)` returns `[animation, index]` for a still: stop the sprite and set its `animation` and `frame`. `Headings.nearest` gives the heading alone. Each returns -1, `[]` or `&""` for a resource that lists none.

### Stacking at run time

A slice sheet (`pixelbolt compile car.stack.json --slices --out car-slices.pixel.json`, then render it) holds a stack's slices, ground first, for a game that turns the stack itself. `player.js` draws one:

```js
import { loadSpriteSheet, drawStack } from './player.js';
const car = await loadSpriteSheet('./car-slices.atlas.json');
drawStack(context, car, x, y, { heading: degrees, scale: 3, squash: 0.6 });
```

`(x, y)` is the stack's pivot on the ground. `heading` is in degrees and turns as the baked frames do. `squash` flattens the ground as a camera looking down at a slant does: 1 looks straight down, and the stack's own squash (in the compile's metadata) gives the baked view. For a baked isometric heading `h`, draw `heading: h + 45` at `squash: 0.5`. Each slice is drawn `rise` pixels above the one below (`scale` unless you set it), once for each of those pixels and once more at its top so the sides are solid, so a stack of 15 slices at scale 3 is 60 `drawImage` calls. `(x, y)` is rounded to a whole pixel, where a baked frame's anchor has the pivot, and at headings 0, 90, 180 and 270 the picture is that heading's baked frame pixel for pixel when `scale` is the stack's `resolution`, `rise` its `resolution` × `spacing` and `squash` its own (a stack with `spacing` above 1 has gaps between its baked slices that a solid rise fills, and a cell flattened thinner than a pixel can't match). At other angles a canvas softens the outer edge of a turned image even with smoothing off, so draw stacks that turn at scale 3 or more.

In Godot, attach the addon's `sprite_stack.gd` to a `Node2D` and give it the imported slice sheet:

```gdscript
$Car.sprite_frames = preload("res://car-slices.pixel.json")   # or the exported .tres
$Car.heading = rad_to_deg(velocity.angle())
$Car.squash = 0.6
```

The node's position is the pivot on the ground; `rise` and `pivot` are its other properties, and the pivot comes from the sheet's `stack_pivot` metadata unless you set one. Set its texture filter to Nearest. Other engines do the same from the atlas: draw each frame of `animations.slices` in order, turned about `points["pivot-x2"]` halved, each a step higher than the last.

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

### Isometric maps

A scene whose ground is an iso tilemap exports both editors' own isometric maps.

`scene.tmx` is an isometric Tiled map of the ground's diamonds. Each flat, unsorted iso tilemap is a tile layer whose cells keep the recipe's own columns and rows, so a level designer paints on it with the asset's tileset. A tilemap with raised cells (`heights`) or one sorted among the placements stays tile objects in the order drawn, because a Tiled tile layer has one level and is drawn whole. Every placement is a tile object standing on the middle of its bottom edge, as Tiled stands objects in an isometric map. Every layer is offset to where the ground stands, and Tiled draws its grid at the selected layer's offset, so the grid lies on the ground's diamonds and an object snapped to it stands on a cell.

`tileset_iso.tres` is an isometric Godot `TileSet` (Diamond Down layout) with an atlas source for each sheet an iso tilemap draws from. Its tile size is the diamond, each tile's region is the whole frame, and a texture origin stands the frame on its diamond, so a block taller than its diamond hangs below it as in the scene. Give it to a `TileMapLayer` and paint: cell `(column, row)` is the scene's cell, and a looping animation is an animated tile. Its tiles are plain; terrains are left out, since a terrain's peering bits are a square grid's. `alignment.json` names the file, the diamond and the assets under `isoTileset`. `scene.tscn` still draws the scene from its baked planes.

### Tiled

A tile set also exports `name.tsx`, a [Tiled](https://www.mapeditor.org) tileset over `name.png` beside it: in a map whose tiles are the exported frame size, **Map → Add External Tileset**. The sheet is Tiled's grid (padding becomes margin, twice the padding spacing), and a tile's id is its frame's index in the recipe. A trimmed sheet has no grid, so it gets no `.tsx`.

- **Terrains.** Each terrain is a Wang set (Tiled's terrain set) for the Terrain Brush: a blob set is mixed (sides and corners), a cardinal set an edge set and a corner set a corner set, one colour each, and each tile's Wang id is its neighbour mask, so the brush picks the tiles Pixelbolt's tilemaps draw. Tiled paints the sides and corners between cells, not cells, so the tile of a lone blob or cardinal cell (mask 0, its terrain on no side) is no Wang tile: place it by hand. A corner set's empty tile is none either; Tiled leaves the cell empty.
- **Transitions.** A layered set is one corner Wang set with a colour per terrain, bottom first. A corner set's corners are the points where four cells meet, which are Pixelbolt's map cells: paint each terrain on the points where a Pixelbolt map has its cells. Every mix of them has a tile, so there is no painting order.
- **Variants and weights.** Tiles with one Wang id are alternatives the brush picks between at random, at each tile's `probability`: its `tile.weight` against the heaviest tile of its kind (its terrain and mask, its corners, or the plain tiles).
- **Slopes.** A set's slopes and their feet are plain tiles with their collision objects, outside the Wang sets: paint the terrain, then place them by hand.
- **Collision.** `tile.collision` polygons are objects in each tile's collision group (the Tile Collision Editor), in exported pixels; `tile.oneWay` is a bool property `oneWay` on the tile, for the game to read.
- **Animated tiles.** An animation over frames of one kind is one tile, its first frame's: its later frames are left out of the Wang sets, so the brush never places a still frame of it, and when it loops the tile plays it, with each frame's time, wherever its frames are on the sheet. An animation that plays once stays a still tile of its first frame. The Godot TileSet takes the same frames as tiles from the same sheet.
- **Scenes.** A scene export (`pixelbolt scene`, MCP `pixel_scene`) writes `assets/<n>/tileset.tsx` beside every asset's `color.png` (a Tiled tileset has one image): a tile set's with its terrains, any other asset's with its frames as tiles and its looping animations animated. `alignment.json` names each under the asset's `tiled`, and the map under `tiled`.

#### The scene as a Tiled map

A scene export also writes `scene.tmx`, a Tiled map of the scene as it stands at its start, unlit, over those tilesets: what Pixelbolt draws then, in its drawing order and at its scene positions, so Tiled draws the unlit view (`unlit.png`). Placements in a sequence, on a trajectory, attached or lifted are where they are at that time, each showing the frame it shows then; a frame with a looping animation animates in Tiled. Scene positions are where things are with the camera at `[0, 0]`; with a camera, the map holds the whole scene and its layers scroll (below).

- **Tile layers.** A tilemap becomes a tile layer, painted with its asset's tiles (and its Wang sets, so the Terrain Brush carries on with it), when Tiled's grid can hold it: square cells the size of the map's grid (the first such tilemap's cells), one frame per cell, at 1× from a sheet exported at 1× (`sheet.scale` 1), and not sorted among other placements. A corner map's layer is offset half a cell up and left, and a map whose frames are taller than its cells sits lower by the difference, since Tiled hangs a tile from the bottom of its cell where Pixelbolt hangs it from the top; whole cells of a map's position move its cells, the rest is the layer's offset.
- **Tile objects.** Everything else becomes tile objects in an object layer drawn in list order: placements and each copy of a repeat, sorted tilemaps (their cells draw among the placements they sort with), iso maps, maps at 2× or more and maps of sheets exported larger, which Tiled draws back at the scene's size. With a camera, the map is wide and tall enough to hold every tile object; without one it is the scene, and what hangs past its edge is clipped, as Pixelbolt clips it.
- **Parallax.** Consecutive draws on one plane share a layer, so every layer is on one plane, and its `parallaxx` and `parallaxy` are that plane's `parallax` (an attached placement's is its target's; Tiled writes a factor of 1 by leaving it out). A game reads them as Pixelbolt does: a layer is drawn at its position less its factor times the camera's top-left, so 0 stays on screen and 0.5 moves half as far. Pixelbolt rounds that share of the camera to the nearest pixel, a half down (a share of 23.5 moves the layer 23), as Godot draws it with Snap 2D Transforms to Pixel on ([below](#a-scenes-planes-godots-parallax2d-and-other-engines)); a game that rounds it so draws every pixel where Pixelbolt does. With the camera at the scene's start, that draws `unlit.png`. Tiled's editor previews parallax from the middle of its window and the map's parallax origin, which the map leaves at Tiled's default, `(0, 0)`: Tiled 1.11 changed which way the origin counts (from the window's middle plus the origin, where Tiled 1.8–1.10 subtracted it), so no other value previews the same in both. For Tiled's preview to show what a game's `w` × `h` view centred in Tiled's window shows, set **Map → Map Properties → Parallax Origin** to `(−w/2, −h/2)` in Tiled 1.11 or later, or `(w/2, h/2)` in 1.8–1.10. Games read the layers' factors and not the origin.
- **Haze.** A hazed placement or tilemap is drawn from a hazed copy of its asset's tileset: `assets/<n>/haze-<amount>/tileset.tsx` over `color.png` beside it, the asset's colour pass with the haze baked in as the scene draws it, each colour moved that far toward the haze colour as a whole (and onto the haze `colors`, when the scene lists them). It has the same tiles, Wang sets and terrains as the asset's own, under the tileset name `<id> haze <amount>`, so the Terrain Brush paints the far plane already pale. The copy is unlit, as the map is. `alignment.json` lists each asset's copies under `haze`, with a Godot `sprite_frames.tres` for each.
- **What stays in the scene.** Shade placements, which darken what is under them, are left out, with a warning. Lights, shadows and the camera's keys have no place in the map: its layers say how far each plane scrolls, and the game moves the camera.

`node scripts/verify-tiled.mjs` also exports a scene holding every kind of placement (layered, corner and blob maps, frames taller than their cells, a 3× sheet, a sorted map among a sorted placement, a placement at 2× whose partly transparent glow falls on tiles, a repeat), reads `scene.tmx` with Tiled's reader, checks its tilesets and layers, and renders it with `tmxrasterizer`, which must draw the unlit scene: exactly, but for one step where a partly transparent pixel blends. Then it exports a scene of three planes (a sky at parallax 0, hills at 0.5 standing 0.6 into the haze, the ground at 1, under a camera that pans), checks that Tiled reads each layer's parallax and draws the hills from their hazed tileset, renders each layer with `tmxrasterizer` (which draws no parallax itself), and lays the layers on the background moved by the factors Tiled read, each share of the camera rounded as Pixelbolt rounds it: with the camera at its start, halfway, its end, and at `[47, 3]` and `[49, 0]`, where the hills' share is a whole number and a half, they must draw what Pixelbolt draws there.

`node scripts/verify-tiled.mjs` (with Tiled 1.10.2 or later on `PATH`, in `TILED` or passed as `--tiled <path>`) runs a script in a headless Tiled that reads the Godot check's tile sets with Tiled's own reader and checks the grid, every tile's probability, collision polygons, `oneWay` and animation, and each Wang set's type, colours and Wang ids. It then paints the same maps with Tiled's terrain filler, every side and corner of every cell given its colour, and every tile Tiled chooses must be one Pixelbolt's tilemap draws there; last, `tmxrasterizer` draws a map of every tile, which must give each frame's exported pixels.

### A scene's planes: Godot's Parallax2D and other engines

A scene export also writes each plane as an image, `planes/<k>.png`, and `scene.tscn`, a Godot 4.3+ scene that scrolls them. A plane is a run of draws, in drawing order, that follow the camera alike (the same `parallax`; an attached placement takes its target's), drawn at the scene's start, unlit, with its haze baked in and transparent elsewhere: a sky, the far hills, the ground with what stands on it. `alignment.json` lists them under `planes`, back to front, each with its `image`, `parallax`, `at` (its top-left in the scene, with the camera at `[0, 0]`), `size` and the `placements` it holds. A placement that stands still and plays an animation of more than one frame (a rain or snow overlay, a flickering torch) is in no plane: it is drawn where it comes between them, and `alignment.json` lists it under `sprites`, with its `placement`, `frames` (its asset's `sprite_frames.tres`, or the hazed copy's), `animation`, `parallax`, `scale` (screen pixels per sheet pixel) and `at` (each copy's top-left: a `repeat` draws several). Another engine plays it from the asset's sheet and `atlas.json` beside that file. Any engine draws the scene from them: lay them on the background colour in order, each at `at` less `parallax` × the camera's top-left, a share Pixelbolt rounds to the nearest pixel, a half down (23.5 moves a plane 23). In Phaser that is a scroll factor:

```js
// alignment is the scene's alignment.json; each plane's image was loaded under its path:
// this.load.image(plane.image, `scene/${plane.image}`)
for (const plane of alignment.planes) {
  this.add.image(plane.at[0], plane.at[1], plane.image).setOrigin(0).setScrollFactor(...plane.parallax);
}
```

`scene.tscn` does the same with Godot's nodes: a `Camera2D` at the camera's start, anchored at its top-left (**Anchor Mode** Fixed Top Left) as Pixelbolt's camera is; the background colour, the scene's size, on a `Parallax2D` that stays on screen; and a `Parallax2D` per plane, in drawing order, whose **Scroll Scale** is the plane's parallax, holding a `Sprite2D` of its image at its scene position. An animated placement gets a `Parallax2D` of its own in its place in that order, holding an `AnimatedSprite2D` for each copy on its `sprite_frames.tres`, which plays its animation from the scene's start (**Autoplay**), as `scene.tmx` animates its tile. Godot keeps a `Parallax2D` at (1 − scroll scale) × the camera's top-left, so moving the camera scrolls each plane as Pixelbolt does. The root draws with nearest filtering, which the planes take. Copy `scene.tscn`, `planes/` and `assets/` into one folder of your project, open the scene and move the camera (by script, an `AnimationPlayer`, or by making it follow the player). For pixels that stay whole, set the project's viewport to the scene's size (**Display → Window → Size**), **Stretch → Mode** to `viewport` with **Scale Mode** `integer`, and **Rendering → 2D → Snap 2D Transforms to Pixel** on.

- **Where Godot and Pixelbolt agree.** With **Snap 2D Transforms to Pixel** on and the camera on whole pixels, Godot draws every plane exactly where Pixelbolt does: snapping rounds a plane's place on screen to the nearest pixel, a half up, which is its share of the camera rounded a half down, as Pixelbolt rounds it. With the camera between pixels a plane can be a pixel off, since `Parallax2D` rounds the camera before it scales it by the plane's parallax, where Pixelbolt scales first and rounds the share: keep a snapped game's camera on whole pixels (round its position as it moves) and every plane lands where Pixelbolt draws it. Without snapping a plane lands where Pixelbolt draws it unless its share is a whole number and a half (a parallax of 0.5 with the camera on an odd pixel): its texels then fall on pixel edges, which the GPU may round either way, so the plane can be a pixel off on either axis.
- **Choosing it.** Images per plane are how a game usually draws its far planes, and the scene works as it is exported. The near plane is an image too: for a ground the player walks on, put a `TileMapLayer` with `tileset.tres` under that plane's `Parallax2D` instead, and paint it, or import `scene.tmx` with a Tiled importer. `tileset.tres` holds each tile set's own sheet, unhazed, so a `TileMapLayer` painted with it comes out unhazed: use it for a plane without haze, the ground at parallax 1 usually. For a hazed plane keep its image, which has the haze baked in, or import `scene.tmx`, whose hazed layers draw from the hazed copies' tilesets (`assets/<n>/haze-<amount>/tileset.tsx` over that copy's `color.png`). A placement that moves (a `trajectory`, a keyed `lift`, an attachment), follows `sequence` cues or changes anchor between frames is baked into its plane as it is at the scene's start, and the export warns about it; give it its own `AnimatedSprite2D` with its asset's `sprite_frames.tres` (a hazed one has `assets/<n>/haze-<amount>/sprite_frames.tres`) and move it yourself to animate it.
- **What a plane leaves out.** A plane is the unlit scene at its start: lights, shadows and shade placements, which darken what is under them, stay in the scene (the export warns about shade placements). A plane's image is at most 16,777,216 pixels; a larger one is left out, with a warning.
- **Repeats.** Pixelbolt draws what a scene places, so a plane is as wide as its placements. For a sky or far hills that repeat without end, make the plane's art repeat and set the `Parallax2D`'s **Repeat Size** to its width.

`node scripts/verify-godot.mjs` exports the Tiled check's three-plane scene, loads `scene.tscn` in a headless Godot and checks its camera, background and planes, each plane's image pixel for pixel; then it moves the camera to the start, halfway, the end, and to `[47, 3]` and `[49, 0]`, where the hills' share is a whole number and a half, and Godot must put every plane and the forest spirit's `AnimatedSprite2D` where Pixelbolt draws them: the planes and the spirit's frame laid there (a different frame at each position), each rounded to the pixel as snapping rounds it, must draw Pixelbolt's unlit view at that frame's time. Played at a fixed 1000 frames per second, the spirit must start by itself and change frame within one 1 ms step of the recipe's times. With `--render` Godot also draws the scene in a window the scene's size at each position with Snap 2D Transforms to Pixel on, and with it off where every plane's share is whole, which must be that view.

### Effects round a character

An effect with parts behind a character (a `depth` on its layers or emitters, see [effects round a character](art-workflow.md#particle-effects)) exports `<effect>-back` and `<effect>-front` beside `<effect>`, with the same frame count, timing and anchor. Give the character two `AnimatedSprite2D` siblings with the same Sprite Frames, one before it in the tree (or at a lower `z_index`) and one after, and start both together:

```gdscript
$BuffBack.play("buff-back")
$BuffFront.play("buff-front")
```

Any engine does the same: draw the back part, then the character, then the front part, at the same place and frame. The whole `<effect>` is for previews and sharing; when the source draws a stand-in figure (`depth: "between"`), only the whole effect shows it.

## Unreal Engine (Paper2D)

Paper2D's own sprite sheet importer reads the atlas JSON with every rectangle, trim and pivot. [Pixel art sprite sheets in Unreal Engine 5 Paper2D](https://skulitom.github.io/Pixelbolt/guides/unreal-paper2d-sprite-sheets/) walks through the import, tested in Unreal Engine 5.8.4 on seven sheets, with a free script that sets NoMipmaps and makes one Flipbook per animation with exact frame times.

## Unity and other grid importers

Keep the default untrimmed layout and set `sheet.padding` to `0`. Cell dimensions are `project.width × sheet.scale` and `project.height × sheet.scale`. Set your importer to multiple sprites or a frame grid and use `sheet.columns` horizontal cells. A partially filled last row contains transparent unused cells; use only the number of frames in the JSON.

Alternatively, import the PNGs in `frames/`, which removes any need for atlas slicing. Transfer the duration in milliseconds for each frame into the engine's frame-delay or keyframe controls. The source canvas is not trimmed, so the same pivot/origin keeps frames aligned.

The PNGs store straight (unpremultiplied) alpha, which Unity's sprite shaders expect, so a translucent glow keeps its colour with the default sprite material. Only a material that blends premultiplied colour needs the sheet's colours multiplied by their alpha first.

## Normal and emissive passes

`pixelbolt scene <scene.json> --out <dir>` exports each lit asset's `color.png`, `normal.png` and `emissive.png` on one shared atlas grid, with `alignment.json` naming the files, and a Godot `sprite_frames.tres`. An asset with a normal pass also gets `normal_y_up.png` and `canvas_texture.tres` (below), and its `sprite_frames.tres` draws through that CanvasTexture; without one, `sprite_frames.tres` plays the colour pass. One sprite needs no scene: `pixelbolt render <recipe> --normal <normal recipe or pixelforge-normals source> --out <dir>` writes `<name>.normal.png`, `<name>.normal_y_up.png` and `<name>.canvas.tres` beside `<name>.png`, and `<name>.tres` draws through the CanvasTexture. A normal recipe on its own renders with `pixelbolt render` like any recipe; a generated pass (`pixelforge-normals`) has exactly the colour recipe's frame rectangles, trimmed or not, so one atlas JSON slices both.

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

Stills (a recipe whose `"animations"` is `{}`: icons, UI states, a 9-slice panel) and a tile set whose recipe leaves `animations` out play nothing: their atlas has no `animations` and no `meta.frameTags`, only `frames` and the rest of `meta`, and their bundle has no `name.tres`, `animations/`, `name.css` or `player.js`. Check for `animations` before reading it; draw a still by its frame rectangle (`drawFrame` works, `frameAt` needs an animation).

`frame` gives the exact source rectangle in the PNG, including export scale but excluding surrounding transparent padding. `meta.scale` records the scale already applied; do not multiply coordinates by it.

`meta.frameTags` lists Aseprite-style tags for tools that read Aseprite's JSON: `from` and `to` index the atlas's frames in order, and `direction` is `forward`, `reverse` or `pingpong` (forward and back without repeating either end). A tag can only name one run of frames, so an animation that holds, skips or reorders frames, such as the forest spirit's `idle`, has none; `animations` lists every animation in full, with its loop flag.

With `sheet.trim: true`, each `frame` rectangle holds only the visible pixels: `trimmed` is true, `spriteSourceSize` gives the rectangle's offset inside the unchanged `sourceSize`, and the frames/ PNGs stay full-canvas. Two frames that show the same picture (a hold, or one frame moved whole) have the same `frame` rectangle and their own `spriteSourceSize`, as TexturePacker's aliases do, so read each frame's rectangle by name rather than expecting one cell per frame. Recipes with an `anchor` (compiled poses always have one) add `anchor` in exported pixels and `pivot` = anchor ÷ source size, which Phaser's JSON-hash loader reads as a custom pivot. Frames with named `points` (pose markers such as a blade tip or foot contact, or glyph advances) list them in exported pixels. The bundled `player.js` exports `loadSpriteSheet`, `frameAt` and `drawFrame`, which honor all of these, and `nearestHeading`, `headingFrame`, `headingAnimation` and `headingToward` for an atlas with `meta.headings` ([facing and headings](#facing-and-headings)), and `drawStack` for a slice sheet ([stacking at run time](#stacking-at-run-time)). The TexturePacker-style frame layout is intended for existing atlas importers, but engine-specific integration should be checked in your target engine; this repository tests the bundled Canvas runtime and binary exports.
