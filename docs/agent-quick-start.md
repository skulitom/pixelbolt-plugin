# Pixelbolt quick start

Pixelbolt turns a small JSON recipe into exact pixels: sprites, sprite sheets, tiles, icons, effects and short animations, exported as PNG, atlas JSON, APNG, GIF or numbered frames for video. It is local and deterministic, and no image model is involved. You write the recipe, look at what it draws, fix it with small patches, then export. This page covers most tasks. Call `pixel_help` with a `topic` only when you need more (see the last section).

## A complete recipe

```json
{ "version": 1, "name": "slime", "width": 12, "height": 10,
  "palette": { "k": "#1d2b3a", "g": "#3fa34d", "l": "#8fd16a", "w": "#f4f4e8" },
  "symbols": { "eye": ["w", "k"] },
  "frames": [
    { "name": "rest", "duration": 300, "ops": [
      { "op": "grid", "x": 0, "y": 2, "rows": [
        "....kkkk....",
        "..kkllggkk..",
        ".kllggggggk.",
        "kggggggggggk",
        "kggggggggggk",
        "kggggggggggk",
        ".kkkkkkkkkk."
      ] },
      { "op": "stamp", "symbol": "eye", "x": 4, "y": 5 },
      { "op": "stamp", "symbol": "eye", "x": 7, "y": 5 }
    ] },
    { "name": "up", "duration": 200, "from": "rest", "translate": [0, -1] },
    { "name": "blink", "duration": 120, "from": "rest", "ops": [{ "op": "replace", "from": "w", "to": "g" }] }
  ],
  "animations": { "idle": { "frames": ["rest", "up"] }, "blink": { "frames": ["rest", "blink", "rest"], "loop": false } } }
```

- Required: `version: 1`, `name`, `width` and `height` (1–256), and `frames` (1–256). Names start with a letter, then letters, digits, `-` or `_`; frame and animation names are unique ignoring case.
- `palette` maps keys to `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` or `transparent`. Single-character keys draw in grid rows, where `.` and space leave pixels alone. A shared palette file is `{"$ref": "palette.json"}` (CLI, or MCP inside its root).
- `symbols` are reusable grids that `stamp` draws. A frame is `{name, duration?, from?, translate?, flipX?, palette?, anchor?, points?, ops?, layers?, pixels?}`: `duration` in ms (default 100), `from` copies an earlier frame, a frame `palette` recolours keys for palette cycling, `layers` are `{name?, opacity?, x?, y?, palette?, ops}`, and `pixels` are final `{x, y, color}` corrections.
- `animations` map names to `{frames, direction?: forward | reverse | pingpong, loop?}`. Without them, one animation plays every frame.
- `ramps` (optional) list palette keys from dark to light, one list per material, so `shade` and scene lighting move colours along them without leaving the palette.
- Unknown fields are errors, and every error names its path, such as `project.frames[1].ops[0].rows[2]`.

## Operations

Coordinates are whole pixels from the top-left, and y points down. Shapes are never anti-aliased.

`pixel` (x, y, color) · `rect` and `ellipse` (x, y, w, h, color, filled?) · `line` (x, y, x2, y2, color) · `clear` (x, y, w, h) · `fill` (flood fill at x, y) · `replace` (every `from` colour becomes `to`) · `grid` (x, y, rows, scale?, flipX?, flipY?, rotate?, remap?) · `stamp` (a symbol, same options) · `copy` (a rectangle of a symbol or an earlier frame) · `text` (built-in pixel font: x, y, text, color, align?) · `outline` (around everything drawn so far: color, position inside/outside/middle, width, directions for rim lights and drop shadows) · `dither` (ordered, noise or clumped `value` patterns with a density ramp; `over` limits it to listed colours) · `shade` (move pixels along their ramp: shadows and light that keep the palette) · `rewrite` (seeded match-and-replace rules: moss, cracks) · `autotile` and `tilemap` (terrain from templates and character maps).

## The tools

1. **`pixel_validate`** `{project}` checks a recipe without images and returns a `revision` id. Every tool that takes `project` also takes `revision`, so send the full recipe once and use the id afterwards. Revisions persist in the server's output folder.
2. **`pixel_inspect`** returns a PNG contact sheet of every frame. Options: `animation` (playback order), `frames`, `region: {x, y, w, h}` to zoom, `grid: true` for exact palette-key rows with rulers, `view: silhouette | grayscale | onion | tile`, `native: true` and `diagnostics: true`.
3. **`pixel_patch`** `{revision, changes}` edits in order and returns a before/after image listing every pixel that changed:
   - `{"paint": "frames[blink]", "value": [{"x": 4, "y": 5, "color": "k"}]}` sets exact pixels after all layers (`transparent` erases).
   - `{"grid": "frames[rest]", "value": {"x": 3, "y": 4, "rows": ["kk.", ".k."]}}` paints a small region; dots keep pixels.
   - `{"set": "frames[up].duration", "value": 250}`, `{"insert": "frames[-]", "value": {...}}` and `{"remove": "animations.blink"}` edit the source by path.
   - `recolor`, `move` and `cleanup` (proposed fixes for doubled corners and stray pixels) work on regions.
4. **`pixel_render`** `{revision}` exports a new folder: sprite sheet, atlas, frames, APNG animations, CSS and a preview page. Add `gif: {}` for GIFs at the frames' own size (`gif: {scale: 8}` only to enlarge one for posting), or `sequence: {fps: 30, size: "1080p"}` for PNG frames for a video editor. Pass `expect` with what the user asked for (`{width, height, frames, colors, transparent, loop, gifScale}`): the reply's `check` lists every file that misses it and the call that fixes it.
5. **`pixel_compile`** `{source}` builds an ordinary recipe from a source format: `pixelforge-fluid` (simulated fire, smoke, explosions, steam, magic, water, honey, slime), `pixelforge-fx` (particles: sparks, debris, shockwaves), `pixelforge-poses` (characters from parts and bones, with walk, run and attack templates), `pixelforge-autotile` (47- or 16-tile terrain sets) or `pixelforge-normals` (a lighting normal pass). The matching topic has the format.
6. **`pixel_scene`** composes assets into a room with tilemaps, cues and lighting; **`pixel_import`** turns a native PNG into an editable recipe.

From a shell, the same commands are `node bin/pixelbolt.js validate | inspect | patch | render | compile | scene | import`, with `--help` for options.

## Working well

- Start small: 16×16 to 32×32 and 4–8 colours, with a dark outline or a deliberate lack of one. Use one-character palette keys so the grids stay readable.
- Work silhouette first, then large connected colour shapes, then accents and highlights from one light direction, then poses, then timing. Primitive shapes are a blockout, not the finished art.
- Build one good resting frame, then make the others with `from` and small changes. Give holds and impacts their own durations; 80–200 ms per frame is a good start.
- Inspect every frame, including at native size (`native: true`), and read a `grid` of a region before changing exact pixels. Check that each patch changed only what you meant.
- A valid recipe can still look bad. Judge the image and the playback, not the absence of errors.
- Work in a loop: inspect, patch, render with `expect`, then read the reply's `check` and fix every problem it lists before you hand the files on.
- For a ready-made effect (campfire, torch, smoke, explosion, splash, waterfall, potion, honey, slime, dam break, dust wave), start from a fluid preset in Pixelbolt's `examples/*.fluid.json` and compile it rather than drawing fire by hand.

## More help

`pixel_help` with `topic`:

- `guide`: the full authoring reference (every field and operation, inspection, patch paths, exports).
- `workflow`: the art workflow for advanced formats: poses and motion review, scenes and tilemaps, particle effects, fluids, lighting and normal passes, PNG import.
- `schema`: the recipe's complete JSON Schema.
- `example`: a complete multi-frame recipe with layers.
- `poses`, `scenes`, `autotile`, `fx`, `fluid`, `normals`: the JSON Schema of each source format.
