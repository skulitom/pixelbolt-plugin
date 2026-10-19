# Using Pixelbolt assets in games

The bundle deliberately keeps the interchange format simple: RGBA PNGs plus JSON frame rectangles. By default every frame retains the full canvas and common origin; opt into trimmed packing with `sheet.trim` (below). Frames are never rotated. Use nearest-neighbor filtering and whole-pixel placement for crisp rendering.

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

## Godot, Unity and other grid importers

Keep the default untrimmed layout and set `sheet.padding` to `0`. Cell dimensions are `project.width × sheet.scale` and `project.height × sheet.scale`. Set your importer to multiple sprites or a frame grid and use `sheet.columns` horizontal cells. A partially filled last row contains transparent unused cells; use only the number of frames in the JSON.

Alternatively, import the PNGs in `frames/`, which removes any need for atlas slicing. Transfer the duration in milliseconds for each frame into the engine's frame-delay or keyframe controls. The source canvas is not trimmed, so the same pivot/origin keeps frames aligned.

## Normal and emissive passes

`pixelbolt scene <scene.json> --out <dir>` exports each lit asset's `color.png`, `normal.png` and `emissive.png` on one shared atlas grid, with `alignment.json` naming the files. A normal recipe on its own renders with `pixelbolt render` like any recipe; a generated pass (`pixelforge-normals`) has exactly the colour recipe's frame rectangles, trimmed or not, so one atlas JSON slices both.

Normal RGB encodes XYZ from −1 to +1 as `(v + 1) × 127.5`, with +X right, +Y down and +Z toward the viewer. That is the "Y−" or DirectX convention, which Unreal also uses. Godot and Unity expect +Y up, so flip the green channel when importing, or lights above a sprite shade it as if they were below:

- **Godot 4**: select the normal PNG, enable **Normal Map Invert Y** in the Import dock, set the compression mode to Lossless and reimport. Use it as the `normal_texture` of a `CanvasTexture` whose `diffuse_texture` is the colour atlas, and light it with `PointLight2D` nodes.
- **Unity**: set the texture type to **Normal map**, enable **Flip Green Channel** (`TextureImporter.flipGreenChannel` in scripts), turn compression off and use point filtering. Add it to the colour sprite as the `_NormalMap` secondary texture for the 2D renderer's lights.

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
    "idle": { "frames": ["rest"], "loop": true, "duration": 240 }
  },
  "meta": { "image": "forest-spirit.png", "size": { "w": 26, "h": 26 }, "scale": "1" }
}
```

`frame` gives the exact source rectangle in the PNG, including export scale but excluding surrounding transparent padding. `meta.scale` records the scale already applied; do not multiply coordinates by it.

With `sheet.trim: true`, each `frame` rectangle holds only the visible pixels: `trimmed` is true, `spriteSourceSize` gives the rectangle's offset inside the unchanged `sourceSize`, and the frames/ PNGs stay full-canvas. Recipes with an `anchor` (compiled poses always have one) add `anchor` in exported pixels and `pivot` = anchor ÷ source size, which Phaser's JSON-hash loader reads as a custom pivot. Frames with named `points` (pose markers such as a blade tip or foot contact, or glyph advances) list them in exported pixels. The bundled `player.js` exports `loadSpriteSheet`, `frameAt` and `drawFrame`, which honor all of these. The TexturePacker-style frame layout is intended for existing atlas importers, but engine-specific integration should be checked in your target engine; this repository tests the bundled Canvas runtime and binary exports.
