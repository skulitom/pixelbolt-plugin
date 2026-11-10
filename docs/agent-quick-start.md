# Pixelbolt quick start

Pixelbolt turns a small JSON recipe into exact pixels: sprites, sprite sheets, tiles, icons, effects and short animations, exported as PNG, atlas JSON, APNG, GIF or numbered frames for video. It is local and deterministic, and no image model is involved. You write the recipe, look at what it draws, fix it with small patches, then export. This page covers most tasks; the last section lists the longer references for when you need more.

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

- Required: `version: 1`, `name`, `width` and `height` (1–256; a single-frame still may be up to 4096 a side and 4,194,304 pixels), and `frames` (1–256). Names start with a letter, then letters, digits, `-` or `_`; frame and animation names are unique ignoring case.
- `palette` maps keys to `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` or `transparent`. Single-character keys draw in grid rows, where `.` and space leave pixels alone. A shared palette file is `{"$ref": "palette.json"}` (CLI, or MCP inside its root).
- `symbols` are reusable grids that `stamp` draws. A frame is `{name, duration?, from?, translate?, flipX?, palette?, anchor?, points?, ops?, layers?, pixels?}`: `duration` in ms (default 100), `from` copies an earlier frame as it was finally drawn (its `pixels` corrections too), a frame `palette` recolours keys for palette cycling, `layers` are `{name?, opacity?, x?, y?, palette?, sort?, ops}` (`sort: "ground"` draws them far to near by the row each operation stands on), and `pixels` are final `{x, y, color}` corrections.
- `animations` map names to `{frames, direction?: forward | reverse | pingpong, loop?}`. Without them, one animation plays every frame.
- `ramps` (optional) list palette keys from dark to light, one list per material, so `shade` and scene lighting move colours along them without leaving the palette.
- Unknown fields are errors, and every error names its path, such as `project.frames[1].ops[0].rows[2]`. Broken operations are reported together, up to ten, in the reply's `errors`, so fix them all before validating again.

## Operations

Coordinates are whole pixels from the top-left, and y points down. Shapes are never anti-aliased.

`pixel` (x, y, color) · `rect` and `ellipse` (x, y, w, h, color, filled?) · `line` (x, y, x2, y2, color) · `clear` (x, y, w, h) · `fill` (flood fill at x, y) · `replace` (every `from` colour becomes `to`) · `grid` (x, y, rows, scale?, flipX?, flipY?, rotate?, remap?) · `stamp` (a symbol, same options) · `copy` (a rectangle of a symbol or an earlier frame) · `text` (built-in pixel font: x, y, text, color, align?) · `outline` (around everything drawn so far: color, position inside/outside/middle, width, directions for rim lights and drop shadows) · `dither` (ordered, noise or clumped `value` patterns with a density ramp; `over` limits it to listed colours) · `shade` (move pixels along their ramp: shadows and light that keep the palette) · `rewrite` (seeded match-and-replace rules: moss, cracks) · `autotile` and `tilemap` (terrain from templates and character maps; `layout: "iso"` for a 2:1 diamond grid) · `box` (an isometric box: x, y, w, d, h, top/left/right colours).

## The tools

The tool list you loaded says what each tool takes. This is the order to use them in, and what the list leaves out.

1. **`pixel_validate`** `{project}` checks a recipe and returns a `revision` id. Send the full recipe once and the id afterwards: every tool that takes `project` takes `revision`, and revisions persist in the server's output folder.
2. **`pixel_inspect`** `{revision}` returns a contact sheet of every frame to look at; `grid: true` with a `region` reads exact palette-key rows before you change pixels.
3. **`pixel_patch`** `{revision, changes}` applies the changes below in order and returns a before/after image: check it changed only what you meant.
4. **`pixel_render`** `{revision, expect}` exports the files. `expect` holds what the user asked for (`{width, height, frames, colors, transparent, loop, gifScale}`; `frames` is what each animation plays, or per animation such as `{"idle": 4, "walk": 8}`), and the reply's `check` lists every file that misses it with the call that fixes it. `gif: {}` adds GIFs at the frames' own size (`gif: {scale: 8}` only to enlarge them for posting, with `gifScale: 8` in `expect`); `saveAs` writes files where the user named them.
5. **`pixel_compile`** `{source}` builds an ordinary recipe from one of the source formats below, and `{preset: "smoke-puff"}` compiles a shipped preset; `size` and `frames` fit either to the canvas and frame count asked for.
6. **`pixel_scene`** composes assets into a room with tilemaps, cues and lighting; **`pixel_import`** turns a native PNG into an editable recipe.

## The commands

Run each as `node bin/pixelbolt.js <command>`; `<command> --help` lists that command's options. Replies are JSON, a recipe is a file, and no command writes over an existing file without `--force`: save each edit and each export under a new name.

1. **`validate <recipe.json>`** checks a recipe without images: its size, frames and animations, or every error with its path.
2. **`inspect <recipe.json> --out <sheet.png>`** writes a PNG contact sheet of every frame to look at. Options: `--animation <name>` (playback order), `--frames a,b`, `--region x,y,w,h` to zoom, `--grid` for exact palette-key rows with rulers, `--view silhouette|grayscale|onion|tile|parts` (parts colours each pixel by the part that drew it), `--native` (a 1× sheet beside it), `--diagnostics` and `--guides` (a horizon, vanishing points or an isometric grid drawn over the image).
3. **`patch <recipe.json> --changes <changes.json> --out <new.json> --image <diff.png>`** applies the changes below in order, saves the new recipe and a before/after image, and lists every pixel that changed.
4. **`render <recipe.json> --out <new folder> --look`** exports a sprite sheet, atlas, Godot 4 SpriteFrames (`.tres`), frames, APNG animations, CSS and a preview page, and with `--look` writes `look.png` there: the frames enlarged, to look at (the sheet itself is at game size). Pass `--expect '{"width":32,"height":32,"frames":8}'` with what the user asked for (`width, height, frames, colors, transparent, loop, gifScale`; `frames` is what each animation plays, or per animation such as `{"idle": 4, "walk": 8}`): the reply's `check` lists every file that misses it and how to fix it. `--gif` also writes a GIF of each animation into `gifs/`, at the frames' own size (`--gif-scale 8` only to enlarge them for posting); `gif <recipe.json> --out <new.gif>` makes one on its own, and `sequence <recipe.json> --out <new folder> --fps 30 --size 1080p` PNG frames for a video editor.
5. **`compile <source.json> --out <recipe.json>`** builds an ordinary recipe from one of the source formats below; `compile --preset smoke-puff --out <recipe.json>` compiles a shipped preset instead. `--size 32x32` and `--frames 8` fit either to the canvas and frame count asked for. `autotile <source.json> --out <recipe.json> --preview <map.png>` also draws a tile set over a test map.
6. **`scene <scene.json> --image <view.png>`** composes assets into a room with tilemaps, cues and lighting (`--view depth` shows what is drawn in front of what; `--out <new folder>` exports it); **`import <image.png> --out <recipe.json>`** turns a native PNG into an editable recipe.

## Changes and sources

A patch's changes are a list, applied in order:

- `{"paint": "frames[blink]", "value": [{"x": 4, "y": 5, "color": "k"}]}` sets exact pixels after all layers (`transparent` erases).
- `{"grid": "frames[rest]", "value": {"x": 3, "y": 4, "rows": ["kk.", ".k."]}}` paints a small region; dots keep pixels.
- `{"set": "frames[up].duration", "value": 250}`, `{"insert": "frames[-]", "value": {...}}` and `{"remove": "animations.blink"}` edit the source by path. A frame added to a recipe that names its animations plays only once its name is in one: `{"insert": "animations.spin.frames[-]", "value": "sparkle"}`.
- `{"set": "palette.c", "value": "#8a5a2c"}` recolours everything drawn with that key, in every frame, without redrawing; `{"set": "frames[*].layers[plume].palette", "value": {"s": "#6a2c91"}}` recolours one layer alone (`[*]` is every item of a list).
- `recolor`, `move` and `cleanup` (proposed fixes for doubled corners and stray pixels) work on regions.

A source is a document whose `format` names what compiles it: `pixelforge-fluid` (simulated fire, smoke, explosions, steam, magic, water, honey, slime), `pixelforge-wave` (looping interference and portals), `pixelforge-bodies` (balls and blocks that bounce, stack, topple and rest, with joints, ropes and cloth), `pixelforge-crystal` (crystals, geodes and snowflakes that grow and rest), `pixelforge-powder` (falling-sand sandboxes: burning, collapse, lava meeting water, blasts), `pixelforge-fx` (particles such as sparks and debris, and spell shapes: slashes, shockwave rings, beams, lightning, magic circles, impact stars, fireballs, cel water streams and drops; reviewed sources in `examples/*.fx.json`), `pixelforge-poses` (characters from parts and bones, with walk, run and attack templates), `pixelforge-autotile` (47- or 16-tile terrain sets, drawn from a `terrain` description, shown over a test map) or `pixelforge-normals` (a lighting normal pass). The matching help topic has each format.

## Working well

- Start small: 16×16 to 32×32 and 4–8 colours, with a dark outline or a deliberate lack of one. Use one-character palette keys so the grids stay readable.
- Work silhouette first, then large connected colour shapes, then accents and highlights from one light direction, then poses, then timing. Primitive shapes are a blockout, not the finished art.
- Build one good resting frame, then make the others with `from` and small changes. Give holds and impacts their own durations; 80–200 ms per frame is a good start.
- Inspect every frame, including at native size (`native: true`), and read a `grid` of a region before changing exact pixels. Check that each patch changed only what you meant.
- A valid recipe can still look bad. Judge the image and the playback, not the absence of errors.
- Work in a loop: inspect, patch, render with `expect`, then read the reply's `check` and fix every problem it lists before you hand the files on; its `notes` also point out loops that lift off the ground, jump unevenly or repeat a frame.
## Starting points

- For a character that walks, runs, jumps or attacks, redraw the nearest rig, whose motion templates make the poses when compiled (`help craft "Characters"`): `examples/hero.poses.json` (slim), `examples/knight.poses.json` (stocky, shield), `examples/fox.poses.json` (four legs). A part without `attach` stands at the pose `origin` plus its `at`. For a sword or tool in hand, see `examples/hero-sword.poses.json`: the prop's relative `angle` turns it with the arm, where `rotate` keeps one angle.
- For fire, smoke, explosions, splashes, spells and other effects, start from a preset rather than drawing them: `pixel_help {"topic": "presets"}` lists every one with its size and frames, `pixel_compile {"preset": "smoke-puff"}` compiles one as it ships (`"size": "32x32"`, `--size` in a shell, cuts or pads it to the canvas asked for), and `pixel_help {"topic": "preset", "name": "smoke-puff"}` returns its source to edit. From a shell: `pixelbolt presets` and `pixelbolt compile --preset smoke-puff --out smoke.json`. Fluid presets are effects, not characters: `slime` is a drop of liquid.
- For squash, stretch, a bounce or a breathing idle (a slime, a blob), compile a poses source with one mass body and `motions.idle` (example: the `slime-idle` preset, a flat-based body whose `squash` keeps it on the ground); don't draw the frames.
- For fewer frames than a preset or source makes, compile it with `frames` (`"frames": 8`, `--frames 8` in a shell): each animation keeps that many evenly spaced frames and plays as long as before. Never lower `frames` in the source, which stops the effect before it ends.

## More help

`pixel_help` with `topic` (from a shell, `pixelbolt help <topic> [section]`):

- `presets`: the ready-made effects, characters and loops to compile instead of drawing (with `find`, such as `"fire"`, only the matching ones); `preset` with a `name` returns one preset's source.
- `craft`: short checklists (characters, effects, tiles and scenes, delivery, limits); `name` picks one.
- `guide`: the full authoring reference (every field and operation, inspection, patch paths, exports), read by `name` as the workflow is.
- `workflow`: the art workflow for advanced formats: poses and motion review, scenes and tilemaps, particle effects, fluids, lighting and normal passes, PNG import. With `name`, one section (`"Depth and perspective"`), a part of a long one (`"Whitewater"`), or the paragraphs that mention a word (`"apex"`).
- `schema`: the recipe's JSON Schema, as an outline of its properties; `name` is a path for one part as JSON (`frames`), and `all` the whole schema.
- `example`: a complete multi-frame recipe with layers.
- `poses`, `scenes`, `autotile`, `fx`, `fluid`, `wave`, `crystal`, `powder`, `bodies`, `normals`: the JSON Schema of each source format, read the same way (`bodies` with `name: "effects.bodies"` is every field a body takes).
