# Pixelbolt craft notes

Short checklists by subject, for the pixel art skill: read the one section the job needs. From a shell, `pixelbolt help craft "<section>"` prints one; over MCP, `pixel_help` with `topic: "craft"` and `name`. Each `help workflow "<section>"` named below is read the same way, with `topic: "workflow"`.

## Rules

- The recipe is the source. Keep the JSON file. Don't paint PNGs with another library and don't hand-edit exported files.
- An existing asset is edited through its recipe with patches. Rebuild from scratch only when the user asks.
- Change one pixel with a patch, not by rewriting the recipe. A patch preview lists the frames it changes and, for small edits, each pixel; read that list.
- Save edits to a new recipe (`--out`) rather than over the old one, and render each attempt into a new folder. Use `--force` only to replace output you made, and only when the user wants it replaced. A write to a file that exists is refused and leaves the old file as it was, so number your drafts (`sheet-1.png`, `sheet-2.png`) and read `ok` in the reply before opening an image: a sheet opened after a refused write is the earlier one.
- Validation and the render `check` show that a file matches the format and what was asked, not that the art works. Look at the inspect image at native size and enlarged, and at the animation in playback, before you say it is done.
- Stay in the palette: no gradients, anti-aliasing or subpixel positions. Export at scale 1 for game assets unless the user asks for enlarged pixels baked into the files.
- If the request leaves size or use open, pick a sensible default (for example 16 to 64 px for a game sprite, 4 to 16 colours), state it in one line, and build. Ask only when the answer changes the build.
- Words on screen (titles, captions, counters) use the `text` operation, not hand-drawn letters.
- Errors name their path, such as `project.frames[1].ops[0].rows[2]`, and come back together. Fix them all, then validate again. Don't guess field names; check `help guide <word>` or `help schema` (a source format's fields: `help fluid`, `help bodies effects.bodies`).
- GIF keeps exact colours but drops partial transparency and rounds timing to 10 ms. Report the `notes` it returns.
- If asked to match a named game's quality, make original art and report what the visible evidence supports.

## Drawing by hand

- Before drawing, note the size, display scale, three silhouette landmarks, palette roles, light direction, outline treatment, the projection (side, 3/4 top-down, isometric 2:1 or top-down, one for the whole set) and the action. Keep the brief beside the recipe, not inside it.
- Work in this order: silhouette, then large connected colour shapes, then material accents, then key poses, then timing, then the scene. Don't make variants until the resting silhouette and one action read well.
- Noise and extra glow can't fix weak structure. Redraw the part.
- Shade along palette ramps (`ramps` with the `shade` operation) so light stays in the palette. Use dither for transitions and bands, not whole surfaces.
- Share a palette with `"palette": { "$ref": "palette.json" }`, cycle water or lights with frame or layer `palette` overrides, and use `remap` for colour variants and hit flashes.
- Water, fire and crystal need different behaviour, not the same shape recoloured.
- Inspect with `--native --diagnostics`, then `--view silhouette` and `--view grayscale`; use `--animation <name> --view onion` for the poses either side of each frame, and read exact pixels with `--grid --region x,y,w,h` before you change them. Diagnostics are advice: intentional eyes, sparks and holds are fine. Record what reads and what fails, so the next change is deliberate.
- To set one pixel, a patch file holds `[{"paint": "frames[blink]", "value": [{"x": 9, "y": 7, "color": "k"}]}]`; `"transparent"` erases. On paint, grid, move, recolor or cleanup changes, add `"scope": "frame"` when other frames must keep their pixels.
- A hold needs no second drawing: `{"name": "shut-2", "from": "shut", "duration": 900}` is the same frame held for its own time.
- A mirrored part keeps its light on one side with `flipX` and a `remap` that swaps its light and dark keys: `{"op": "stamp", "symbol": "leg", "x": 20, "y": 9, "flipX": true, "remap": {"L": "D", "D": "L"}}`.
- Read pacing with `inspect <recipe> --animation <name> --every 100`: one cell per 100 ms of playback, so holds and quick steps show as they play, and `timing.entries` count the pixels each step changes (0 is a hold).
- Judge motion in playback. A still sheet can't show weight. `pixelbolt preview <recipe> --open` plays it for the user in a local studio, on this machine only.

## Characters

- For figures in motion, use a `pixelforge-poses` source: bones for limbs, masses for bodies, grid parts for heads, hands and props. Start from the example nearest in build: `examples/hero.poses.json` (slim, in cloth, a scarf that trails) or `examples/knight.poses.json` (stocky, in plate, a shield held still and a sword). A part without `attach` stands at the pose `origin` plus its `at`, an offset rather than a canvas position.
- A prop or creature made of drawn parts that move, appear or swap (a chest whose lid lifts, a door, a turret) is a poses source too, and needs no bones or rig: each pose lists the parts it shows, back to front, each a `part` at an `at` offset from the pose `origin`. Leave a part out of a pose to hide it, and name another `part` to swap its drawing. A part with `flipX` mirrors its anchor as well, so its `at` names the mirrored corner: add the part's width less one to keep a top-left anchor's place. `examples/hermit-chest.poses.json` is one: a chest that lifts its lid, looks about, grows legs and walks.
- **A new character is a redesign, not a recolour.** A recoloured hero with a new head reads as a thin column. First choose three blocks that read apart in colour and value (the knight: steel helmet, gold-rimmed shield, steel legs, with red between them), then set the build: at 32 pixels a head 9 or 10 wide, a chest 6 to 8, legs about 8 long. Change bone `length` and `width`, redraw the head and props as grids, move `origin` and `rig.ground` so the soles stand a row or two above the canvas bottom, and look at the sheet after each change.
- **Angles.** 0 points right, 90 down, 180 left, 270 up. An attached part's `angle` is added to its parent's: a chest stands at 270, so an upper arm at −175 hangs straight down beside it and one at −200 reaches forward and down; a forearm's angle is added to its upper arm's.
- **Order.** A pose's `parts` are drawn in the order listed, far side first: far arm, far leg, body, near leg, head, near arm, then what covers them (a shield, a pauldron).
- **Something carried still** (a shield, a lantern, a banner) hangs from an arm left out of `rig.arms`. No template swings that arm, so it stays as posed while the arms in `rig.arms` swing and strike (`motions.attack.arm` counts within `rig.arms`).
- **Thick limbs** of one colour merge into a block. End a shin with a `flat` cap no wider than its boot, so it does not poke under the sole, and hang the two thighs a pixel or two apart (`at` beside `attach`), so two legs show at rest.
- A cape, plume, scarf or ponytail is `rig.tail`: bones the templates leave alone and springs carry after the body.
- Compile with `pixelbolt compile <source.poses.json> --out <recipe.json> --metadata <new.json>` so review tools keep the pose data.
- Assign rig roles and use the idle, walk, run, jump, attack and hurt templates as starting points. Set speed, stride, lift and frame timing for the body, and fix compile warnings (a pose off the canvas, a foot out of reach) before adding detail.
- A prop held in a hand needs a relative `angle`, such as `-45`, so it turns with the arm. `rotate` is absolute: with it, or with neither, the blade keeps one angle through the attack. `examples/hero-sword.poses.json` is the hero holding a sword. Check on the sheet which way a held prop faces: a bow's string is on the archer's side.
- In a side view, draw far limbs a ramp step darker (not the darkest step, which merges with the outline) and give paired legs the same rest angles. Near limbs stay in front for the whole cycle.
- For a four-legged animal, start from `examples/fox.poses.json`: `rig.fore` and `rig.hind` take the place of `legs`, and the templates `walk`, `trot` and `run` set the gait.
- Start any turned part (boots, hands, held weapons, a tilted head) from a draft, never from nothing: `pixelbolt compile <source.poses.json> --draft-views boot:15,345 --preview <drafts.png>` (MCP `pixel_compile` with `draftViews`) prints the turned rows to correct by eye and paste into `parts.<name>.views`.
- Review the silhouette, the difference between key poses, planted contacts, the loop join and the gait with `pixelbolt inspect <source> --motion run --speed 48`, and in a run of its own `inspect <recipe> --view parts` to name the part behind a stray pixel. Don't infer contact quality from a still sheet. More in `help workflow "Authored poses, attachments and cues"`.

## Colour variants

A team colour, a season, an enemy version, an arctic fox: the same sprite or character with some colours changed, every frame and animation kept.

- Work on the compiled recipe (`compile <source or --preset name> --out <recipe.json>`), not the source: a variant is a `patch` of it.
- `inspect <recipe> --palette` says which keys colour which parts, a ramp's keys together dark to light, and lists the `layers` by name.
- Everything drawn with a key: `[{"set": "palette.o", "value": "#d8e0ea"}, ...]`. Change a whole ramp together, keeping it dark to light.
- One part and not another that shares its key (the plume, not the shield's emblem in the same red): recolour that part's layer in every frame, `{"set": "frames[*].layers[plume].palette", "value": {"s": "#6a2c91", "t": "#9b59d0"}}`.
- `inspect <recipe> --beside <variant.json>,<other.json> --animation run --out <compare.png>` shows the versions in one image, each under its file name.
- Name the variant in the same patch, `{"set": "name", "value": "fox-arctic"}`, so its sheet and atlas carry the name, and render each into its own folder. The patch reply says how many frames and pixels changed and which colours.

## Effects

- **Presets.** A preset straight to a GIF is one call: `pixelbolt gif --preset campfire --size 32x32 --scale 8 --out <new.gif> --sheet <frames.png>` compiles it, puts it on the canvas asked for, writes the GIF and the frames as a contact sheet to look at; compile it to a recipe instead when you will edit it or need the sheet and atlas. For a bigger file, enlarge the GIF (`--scale`, MCP `gif.scale`); for another canvas size, compile with `--size 32x32` (MCP `size`): the drawing is cut to the window holding the most of it, or given margins, never scaled, and a warning says what share a cut left out, so look at it. For fewer frames, compile with `--frames 8` (MCP `frames`): each animation keeps that many evenly spaced frames and plays as long as before, where lowering `frames` in the source would stop the effect early. A preset that refuses (its operations read the whole canvas) or loses too much needs the size changed in its source, where obstacles and emitters use absolute coordinates. Deliver the preset as shipped first, then offer to tune it. Don't build a new recipe around it.
- **Fluids** (`examples/*.fluid.json`): tune `viscosity` and `yield`; the `look` decides the colours. Draw steam, fog and smoke in flat bands (`dither: 0`, two or three colours in one density layer, as `hot-stone` and `dry-ice` do): dithered, thin vapour turns into specks. Check one-shots at 1× and that they end empty, and keep the loop boundary quiet (`help workflow "Fluid effects"`).
- **Particle effects and spells** (`pixelforge-fx`): fix every edge warning the compile gives unless the effect lists that side in `edges`. Make gas and mist see-through, not outlined. For an effect round a character, give what belongs behind it a `depth`, so the game draws `<effect>-back`, the character, then `<effect>-front`. In a spell file, change only what was asked (`help workflow "Particle effects"`).
- **Rigid bodies** (`pixelforge-bodies`; `presets --find bodies`, `help workflow "Rigid bodies"`): balls, boxes and polygons that roll, stack, bounce and break, with `joints` (hinges, a ragdoll), `ropes` (a bridge, a wrecking ball) and `cloths` (a flag, a cape). Start from the preset nearest in kind and change it: `crate-topple` is a ball thrown into a pyramid of crates, which knocks the upper ones off. Plan a knock-down as a stack or a wall of blocks about as wide as they are tall. A row of thin pieces standing on the floor (bowling pins) does not fall cleanly when a ball rolls into it, whatever the ball's size, weight, speed or bounce, the grip, the gravity or the spacing: the pieces are shoved along upright, lean on each other and stand up again, and fall only where a wall stops them. With an edge in `walls` a body rebounds from it; left out, bodies leave the picture there. Standing pieces are `asleep` until struck. Tune by looking a few frames at a time, `inspect <recipe> --step 5`, changing one number between looks. `subpixels` draws the bodies finer on a canvas that many times larger.
- **Waves and crystals:** keep a portal's rims in an overlay and use particle rings for one-shot impacts; draw a crystal's rock as the source's underlay and its front lip as the overlay (`help workflow "Crystal growth"`).
- **Falling sand:** `base: "sandbox"` gives the starter materials, and `pieces: "tumble"` lets loose pieces topple (`help workflow "Falling sand"`). The table's background is dark and opaque: a sprite sets `"background": "transparent"`. A starter material named again replaces the table's whole, so one given new colours repeats its `state` and the rest.

## Tiles and scenes

- **Tiles:** review `--view tile` (a 3×3 repeat) and set `wrap` on frames whose drawing crosses the edges. An autotile `terrain` compiles into 47 blob, 16 cardinal or 16 corner (dual-grid) tiles with `pixelbolt autotile <template.json> --out <recipe.json>`; check its test map and seam warnings. A side-view set takes `slopes`, and tilemap legends take `rules`, `weights` and variants (`help workflow "Autotile templates"`). For a picture of a level of your own, give the template `"preview": {"background": "#8fd3ff", "rows": ["....", "./#\\", "####"]}` (`#` terrain, `.` nothing, the set's slope characters) and `--preview <new.png>` draws that map in place of the test map, as large as a still may be (Limits).
- **One material over another** (snow over rock, grass over dirt, sand beside water): a `layers` set, bottom layer first. It makes each material's plain tile and every tile where they meet, 16 in all for two layers, with a Godot TileSet and a Tiled tileset that have a terrain per layer. To start from: `{"format": "pixelforge-autotile", "version": 1, "name": "snow", "tile": 16, "palette": {"r": "#6b7280", "R": "#565d6b", "w": "#f4f8ff", "b": "#c5d8f0", "B": "#9db8dc"}, "frame": "snow-{corners}", "layers": [{"name": "rock", "key": "r", "terrain": {"seed": 3, "fill": {"color": "r", "speckle": [{"color": "R", "amount": 0.18, "size": 4}]}}}, {"name": "snow", "key": "s", "terrain": {"seed": 7, "fill": {"color": "w", "speckle": [{"color": "b", "amount": 0.06, "size": 3}]}, "edges": {"all": {"depth": 2, "jitter": 1, "size": 5, "bands": ["B", "b"]}}, "round": 3, "inner": 2}}]}`. An upper layer's `edges` are drawn where it ends over the layer below, `bands` from the rim inward. A single `terrain`, as in `examples/meadow.autotile.json`, is one material that is clear outside itself, for a map that draws something else on a layer beneath (`preview.background` stands in for it on the test map).
- **A scene from pieces:** a `pixelforge-scene` places recipes as `instances` and `pixelbolt scene <scene.json> --image <view.png> --scale 4` draws it (`--out <new folder>` exports it; MCP `pixel_scene`). To start from: `{"format": "pixelforge-scene", "version": 1, "name": "camp", "width": 96, "height": 64, "background": "#0b1020", "assets": {"grass": "meadow.json", "fire": "campfire.json", "spirit": {"recipe": "spirit.json", "normal": "spirit-normal.json"}}, "instances": [{"name": "floor", "asset": "grass", "at": [0, 32], "tilemap": {"tile": [16, 16], "rows": ["gggggg", "gggggg"], "outside": "match", "legend": {"g": {"frames": ["meadow-{mask}-a", "meadow-{mask}-b"], "autotile": "blob"}}}}, {"name": "fire", "asset": "fire", "at": [56, 14], "animation": "campfire", "lit": false}, {"name": "spirit", "asset": "spirit", "at": [34, 34], "animation": "idle"}], "lighting": {"ambient": 0.3, "scope": "all", "lights": [{"at": [68, 50], "height": 14, "radius": 60, "color": "#ffb05a"}]}}`. Assets are compiled recipes (files beside the scene, or `{recipe, normal}` with a normal pass); a tile set's compile reply gives the `tilemap` to paste, its cell size and `legend` with `#` for the terrain (a set with `slopes` adds a character per slope and sample `rows`), and `outside: "match"` runs the floor on past the map's edge instead of rounding it off there. `scope: "all"` lights assets that have no normal pass too, so a night darkens the ground, and `lit: false` leaves a fire or a lamp its own colours.
- **Scenes:** put things that stand on the ground in one layer or group with `sort: "ground"`, and give scene placements `anchor: "frame"`. Use `lift` for jumps, `shadow: true` with a light or a `sun`, `haze` for far planes, `box` and `layout: "iso"` for isometric art (`help craft "Isometric"`), and a `camera` with `parallax` to pan. Inspect a 2–4× `region` where different things meet, and check who covers whom with `pixel_scene` `view: "depth"` and `guides` (`help workflow "Depth and perspective"`, `help workflow "Scene and tile review"`).
- **Lit scenes:** derive normal passes with a `pixelforge-normals` source rather than painting them, light the result from both sides, and tell the user Godot and Unity read +Y up (`help workflow "Aligned material passes"`).

## Isometric

Start from `examples/iso-tiles.json` (the tile set) and `examples/iso-glade.scene.json` (the scene that lays it out), and change them.

- **Frames:** one canvas for the whole set, 32×64 on a `tile: [32, 16]` grid, each frame's cell in its last 16 rows. A ground tile is the cell's diamond 10 pixels up, over 10 pixels of earth. Draw one base tile and start the others `from` it, with every detail inside the diamond, so nothing crosses a seam or hangs off the map's edge.
- **Proportions first:** set heights against each other before any detail. In the example a wall block is 12 pixels high, a step 6, a sapling 29 and a pine 48, and stone is an accent on the grass, not the ground.
- **Drawing:** `box` operations of one footprint drawn over each other, each with a smaller `h`, leave exact 2:1 lines (a dark foot, a cap, mortar). Terrain that joins its neighbours has no outline; a prop that stands alone has one in a dark tone of its own material.
- **Layers:** the ground map, then a map of shadow ellipses with `shade: -1` (the recipe needs `ramps`), then a map of what stands on the ground, placed 10 pixels higher than the ground map, with `sort: "ground"`. Without the shadows, props float.
- **Placing:** something in cell [x, y] stands at `[(x - y + rows) * 16, (x + y + 1) * 8]` from that map's point. Anchor it at the middle of its drawn bottom row, measured in its canvas (a canvas has padding round the drawing), give it the same `sort`, and `lift` it to hover.
- **Layout:** a low block behind a tall one looks the same height, so put the low one in front. Cells on the x = y diagonal stack in a column on screen, so spread props off it. Make every loop's length divide the scene's `duration`, or the scene jumps where it repeats.
- **Legends:** variants, `weights`, `rules` and blob or cardinal masks work in iso; only `autotile: "corner"` is refused (`help workflow "Scene and tile review"`).

## Exports and delivery

- Put in `--expect` (MCP `expect`) what the user asked for, such as `{"width":24,"height":24,"frames":6}`, or frame counts per animation, `{"idle": 4, "walk": 8}`. Read the `check`, fix every mismatch it lists, and render again.
- To post or embed: `--gif` on the render (`--gif-scale 4` enlarges it; MCP `gif`), or on its own `pixelbolt gif <recipe> --out <new.gif>` (`--preset <name>` in place of the recipe for a shipped preset; `--sheet <frames.png>` also writes the frames to look at). Options include `--animation <name>`, `--scale <1-16>` (use it only to enlarge for posting) and `--background "#17191d"`, which blends transparent pixels onto a colour.
- For a video editor: `pixelbolt validate <recipe> --fps 30` checks the timing, then `pixelbolt sequence <recipe> --out <new folder> --fps 30 --size 1080p` writes numbered PNG frames. Pass on the ffmpeg command it prints; Pixelbolt does not encode video.
- From a folder of numbered PNG frames: `pixelbolt gif-frames <folder> --fps 25 --out <new.gif>`.
- An existing PNG becomes a recipe with `pixelbolt import <image.png> --out <recipe.json>` (any PNG colour type up to 8 bits per channel, indexed and greyscale included; not 16-bit, interlaced or animated).
- Give the user the paths to the source recipe, the sprite sheet, the atlas JSON, the preview and any GIF, plus a short note on how to use them: Godot 4 (the `.tres` beside the sheet is an `AnimatedSprite2D`'s SpriteFrames, and an autotile set's `.tileset.tres` is a `TileMapLayer`'s TileSet with a terrain to paint), Tiled (the `.tsx` has a terrain set for the Terrain Brush), Phaser (atlas JSON), CSS, or the bundled `player.js` (`docs/game-integration.md`). Mention any `notes` and limits that apply.

## MCP

| Task | CLI | MCP tool |
|---|---|---|
| Learn the format | `help quickstart`, `help guide`, `help schema` | `pixel_help` (topics such as `guide`, `workflow`, `craft`, `schema`, `example`, `presets`) |
| Check a recipe | `validate` | `pixel_validate` |
| See the frames | `inspect` | `pixel_inspect` |
| Edit | `patch` | `pixel_patch` |
| Export | `render`, `gif`, `sequence` | `pixel_render`, with the `gif` or `sequence` option |
| Compile a source or preset | `compile` | `pixel_compile` |
| Scenes | `scene` | `pixel_scene` |
| Import a PNG | `import` | `pixel_import` |

Send the recipe once as `project`. Each reply includes a `revision` id; send `revision` in later calls instead of the full recipe. Revisions are saved in the output directory the server was started with (`--out`), so keep using the same absolute path. When the user named files, add `saveAs` to `pixel_render`, such as `{ "sheet": "assets/hero.png", "gif": "assets/hero.gif" }`. Pass `listFiles: true` to see every exported file. Requests are capped at 16 MiB: send a large recipe once and reuse its revision.

## Limits

- Imports: PNG of any colour type up to 8 bits per channel (RGB, RGBA, greyscale, indexed); 16-bit, interlaced and animated PNGs are refused. GIF import, Aseprite files and automatic colour reduction are not supported.
- Animation frames are at most 256 × 256 pixels, a project has at most 256 frames, and its frames together hold at most 4,194,304 pixels. A backdrop or mural rendered on its own, outside a scene, may be a single-frame still up to 4096 pixels a side; draw it at one pixel per screen pixel, with no enlarged stamps or text. A scene is one view of up to 1024 pixels a side and 262,144 in all (1024×256, 640×360, 512×512), so a level sixty tiles long is one picture; its assets stay at 256 a side, so tile a backdrop with `repeat` or a `tilemap`.
- Pixelbolt does not encode video. `sequence` writes the PNG frames and the command.
- Not for vector or SVG logos, photographs, painted images or pictures from an image model. Say so and suggest a tool for that work.
- Advisory diagnostics and review notes are prompts to look, not commands to delete pixels. Keep the original assets and any failed comparisons.
