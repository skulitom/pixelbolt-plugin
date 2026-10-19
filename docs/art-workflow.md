# Deliberate pixel art with Pixelbolt

Pixelbolt supplies exact pixels and inexpensive revisions. The author still has to design the silhouette, choose meaningful color shapes and judge the motion. The [quality lab](art-quality-lab.md) is an original worked example, with both an unsuccessful room blockout and its revised result. It is a self-reviewed study, not independent evidence of Animal Well parity.

## Write a brief outside the recipe

Keep an `asset.brief.md` beside the authoritative source. Record:

- Native dimensions and intended display scale. Review at 1× and the intended integer scale.
- Three silhouette landmarks and the negative spaces that distinguish the subject.
- Palette roles: outline, occlusion, shadow, local color, illuminated plane, accent. State light direction.
- Material rules: growth direction for plants, planes for stone, expansion/fragmentation for effects.
- Outline treatment and any deliberate isolated pixels or alpha blends.
- Action intent, contact/release/impact poses, timing, ground origin and attachments.
- Scene role: focal subject, navigable surface, background or foreground framing.
- Acceptance judgments, revisions, remaining weaknesses and source provenance.

Briefs and review notes are sidecars. Do not add these fields to a version-1 sprite recipe.

## Quality checkpoints

1. **Silhouette.** Author a connected contour with a few strong landmarks. Inspect `--view silhouette --native`; record whether identity survives without interior detail. Reshape an ambiguous outline before adding texture.
2. **Large color groups.** Use `--view grayscale` against the intended background. A connected shadow plane should describe a surface. Remove scattered texture that does not explain form.
3. **Materials.** Compare related assets. Leaves branch from stems; stone highlights follow planes; water flows and collects; crystal breaks along a fault and leaves debris. Palette swaps alone do not establish material behavior.
4. **Key poses.** Author contact, compression, passing and extension for locomotion; anticipation, release and recovery for an action. Replacing a drawn part is often more useful than translating the same stamp.
5. **Timing.** Inspect `--animation run --view onion --diagnostics`, then actually watch the studio or exported APNG. Sheets and timing strips cannot show perceived weight. Repeated poses/holds remain valid. The studio timeline uses expanded animation order, including repeated occurrences; pink is previous and cyan next. Once-only animations have no wrapped neighbor.
6. **Scene.** Use `preview room.scene.json` to check native size, value separation, density, overlap and reaction/aftermath. A good sprite can fail against its background. Keep a failed comparison when it teaches a specific correction.
7. **Revision.** Read the regional grid; make a bounded patch; inspect its changed-pixel report. Preserve unrelated poses deliberately. Keep an undo revision and recheck motion after the correction.

These are authoring decisions, not user permission gates. Passing validation, increasing frame count, or producing many variants does not pass an artistic checkpoint.

## Inspection options

The CLI and MCP `pixel_inspect` support `view: color|silhouette|grayscale|onion|tile`, `native`, `diagnostics`, `maxCells`, `step` and `offset` in addition to existing frame/animation/region/grid options. CLI spellings are `--view`, `--native`, `--diagnostics`, `--max-cells`, `--step`, `--offset`. `step`/`offset` keep every nth cell from position k before `maxCells` samples evenly; evenly spaced samples of a cycle with a repeating pattern (a strobe alternating A and B frames) can land on one phase or alternate between phases, so pick the phase with a stride. Frame names in `frames` accept `*` and `?` patterns. Silhouette uses one opaque light tone for every visible pixel, including translucent ones. Grayscale uses weighted RGB luma and retains alpha. Tile repeats each frame 3×3 and reports seam evidence (see [Scene and tile review](#scene-and-tile-review)); it repeats whole frames, so it takes no region. None modifies source pixels; grids always report original pixels.

With `--out review.png --native`, the CLI also writes `review.native.png`, checking both paths before writing. MCP returns an additional native-size PNG. Sampled sheets explicitly report total/shown/omitted and original sequence positions. Their cell durations are original holds, **not** a playable retiming of the sampled sequence. `pixel_render` automatically bounds large previews to at most 256 cells (fewer for large canvases), still exports every animation entry, and returns `playback` pointing to its HTML preview.

`--layers body,head` / `layers: ["body","head"]` isolates named layers through frame inheritance and transforms. It respects layer visibility/opacity and omits background, frame-level operations and final canvas corrections: those pixels have no layer identity. The original recipe is validated before isolating. `--reference earlier.json` / `reference: "revision-id"` adds a same-origin changed-pixel comparison; the CLI writes `review.reference.png` when a diff image exists and `--out` is supplied.

Diagnostics report duplicate images, empty frames, isolated visible pixels with no 8-connected neighbor, colors outside the declared palette, unusually large loop-boundary changes. Per-frame stats also count the pixels a `cleanup` patch change would alter: `corners` (doubled L-shaped steps in one-pixel lines) and `strays` (pixels whose eight neighbours share one other colour). These are counts, not findings: in finished, hand-drawn art most L-steps are deliberate highlight strokes or small rounded corners, and most specks are texture. Check them on rotated, rewritten, compiled or imported frames. Coordinates/bounds are provided, with bounded lists and omission counts. Loop warnings compare the boundary with the median nonzero adjacent change, using a minimum threshold of four pixels. These are advisory heuristics: exempt intentional holds, sparks, transparent effects, literal colors or cuts in the brief. They neither score beauty nor alter artwork. Animation timing includes expanded positions, original start times, durations and neighbor positions. Foot sliding needs authored contact points and scene movement; pixel differences alone cannot diagnose it.

## Regional corrections and scope

`pixel_patch`, CLI `patch`, and `patchRecipe` accept these canvas-coordinate changes:

```json
[
  {"grid":"frames[still]", "scope":"frame", "value":{"x":6,"y":3,"rows":["..hh", ".hgg", "~ggg"],"erase":"~"}},
  {"move":"frames[still]", "value":{"x":6,"y":3,"w":4,"h":3,"dx":1,"dy":0,"mask":["..xx",".xxx",".xxx"]}},
  {"recolor":"frames[still]", "value":{"x":7,"y":3,"w":4,"h":3,"from":"g","to":"h"}}
]
```

Another canvas change, `{"cleanup":"frames[still]", "value":{"corners":true, "strays":true}}`, proposes pixel-art cleanup as ordinary corrections, after Pixel Composer's De-Corner and De-Stray filters. It accepts the same optional region, `mask` and `scope`, plus `colors` to limit which original colours may change, and reports how many corners and strays it fixed. It is never applied on its own: preview it, read the changed pixels, and keep eyes, sparks and deliberate right angles.

Grid dots/spaces preserve pixels. Erasure needs an explicit non-palette character such as `~`; it may not be a dot or space. Masks match region size: `x` selects, `.` preserves. Move captures selected RGBA before clearing, so overlapping moves carry highlights and existing corrections. Selected transparent pixels also move and replace destination pixels. Every selected destination must fit; moves do not silently clip.

Regional batches have a 67,108,864 estimated-pixel work limit, including full-frame comparisons needed to preserve dependent poses. Split large batches or reduce scope when that budget is exceeded. Failures leave the source untouched.

The default scope is `inherited`, preserving existing propagation. `scope: "frame"` preserves other poses by recording compensating final-canvas corrections on affected dependents. The edit report lists those protected frames. These corrections intentionally pin those pixels, including their current color: later palette edits will not recolor literal compensations. Use earlier revisions to undo. To edit a named set of frames, submit one change per target with `scope: "frame"`; to alter all instances of a shared drawing, patch its symbol rows instead.

Named selections live in an overlay sidecar with `space: "canvas"`. They do not follow a moving body part. For part-local work, edit that part definition in a pose source and recompile.

## Rebuild-safe overlays

```sh
node bin/pixelbolt.js overlay base.json --changes edits.json --selections regions.json --out corrections.json
node bin/pixelbolt.js patch rebuilt-base.json --changes corrections.json --out approved.json --image difference.png
```

`regions.json` maps names to `{space:"canvas",x,y,w,h,mask?}`. A grid/move/recolor change can reference one with `selection:"fern-tip"`; its value supplies action-specific fields. `createOverlay` and `applyOverlay` offer the same JavaScript API.

An overlay carries a SHA-256 fingerprint of the whole base, canonicalized by object-key order but preserving array order. Rebuilding the same base reproduces the correction. Overlays made only of canvas changes (`paint`, `grid`, `move`, `recolor`) also record per-frame evidence: a fingerprint of every frame they target and of every frame inheriting from those, the frame each change addresses, and the palette colors the changes paint with. When the base changed elsewhere (another frame's duration, a new animation, a different pose), the overlay still applies and reports `rebased: true`. **Any change to a frame it touches, to the frame a path addresses, or to a palette color it uses is a conflict**, and nothing is applied. Overlays with structural `set`/`insert`/`remove` edits keep the whole-recipe rule. The tool never guesses that an old coordinate still identifies the same feature; after a conflict, inspect the new base and create a new overlay. Keep the generator, overlay and resulting recipe, and identify which file is authoritative. The quality lab demonstrates this with its fern correction.

## Authored poses, attachments and cues

Use a `pixelforge-poses` version-1 sidecar, described by [poses.schema.json](../poses.schema.json). It compiles into ordinary sprite recipes; it does not change their rendering semantics.

```json
{
  "format":"pixelforge-poses", "version":1, "name":"held-lamp", "width":16, "height":16,
  "palette":{"g":"#72967d","y":"#e7ce89"},
  "parts":{
    "arm":{"rows":["ggg","..g"],"anchor":[0,0],"points":{"grip":[2,1]}},
    "lamp":{"rows":["y","y"],"anchor":[0,0],"points":{"light":[0,1]}}
  },
  "poses":[{"name":"rest","duration":180,"origin":[4,5],"parts":[
    {"name":"forearm","part":"arm"},
    {"name":"held","part":"lamp","attach":{"part":"forearm","point":"grip"}}
  ],"markers":[{"name":"light","part":"held","point":"light"}]}]
}
```

`parts` define palette grids, local anchors and local named points. Each pose's `origin` is a source-canvas point (often the ground anchor). Instances draw in listed back-to-front order. Without `attach`, `at` offsets the instance's anchor from the pose origin. With `attach`, it offsets the anchor from a named point on an **earlier** instance. Definition points use the part grid's upper-left origin. A pose can use a different part definition under the same instance name, such as an open versus curled hand. An instance with `"flipX": true` mirrors its grid, anchor and points inside the part. A pose written as `{ "name": "walk-l-1", "mirror": "walk-r-1" }` reflects an earlier pose around its origin, including parts, points and markers, and inherits its duration; it takes no parts, markers or origin of its own. The origin becomes the frame anchor, which names the corner between pixel columns originX − 1 and originX, and the mirror reflects around that corner: pixel column c becomes 2 × originX − 1 − c. That is the same reflection as the runtime's `drawFrame` with `flipX` and engines that flip around the atlas pivot, so a compiled left-facing pose and a runtime-flipped right-facing one draw identical pixels. Centre a symmetric front view on the origin corner (for example columns 12–27 around origin x 20) and the side views mirror around the same line. No rotation, smoothing or automatic in-betweens are imposed unless you ask for them.

An instance with `"rotate": 30` turns its part clockwise by whole degrees (−360 to 360) around the centre of the part's anchor pixel, after any flip, and its points turn with it, so a held item stays in the hand. The rotated grid is baked into the compiled recipe as an ordinary, editable symbol named `<part>-r<degrees>` (`-fr` when flipped). Rotation never invents colours: three Scale2x passes enlarge the grid eight times, which rounds staircase edges, and each output pixel samples the enlarged grid where its rotated centre lands (the RotSprite approach). Right angles are exact. A cleanup pass then removes doubled corners the resampling leaves; set `"cleanup": false` to keep the raw result (`<part>-r<degrees>-raw`). Small parts lose detail at odd angles, so inspect the symbol and correct it by patching the compiled recipe or drawing a replacement part for key poses.

A pose written as `{ "name": "swing-1", "tween": { "from": "raise", "to": "strike", "t": 0.33, "ease": "in" } }` is an in-between of two earlier authored or tweened poses with the same part instances in the same order and the same attachments. Its origin, each instance's `at` offset and each `rotate` interpolate by the eased `t` and round to whole pixels and degrees; part definitions, flips and cleanup switch at the eased halfway point. Easing presets are `linear` (default), `hold`, `in`, `out`, `inOut`, `overshoot` and `bounce`. A tween takes no parts or origin, does not inherit markers (add its own if it needs cues) and cannot start from a mirrored pose; mirror the finished tween instead. [examples/swing.poses.json](../examples/swing.poses.json) rotates one sword through an eased swing. In-betweens are a starting point, not a substitute for authored contact, anticipation and recovery poses.

Compiled recipes carry each pose origin as the frame anchor (one recipe-level `anchor` when every pose shares it), and each marker's position as a named frame point, so the atlas alone tells a game where the feet, hand or blade tip are. Marker names are unique within a pose.

```sh
node bin/pixelbolt.js compile actor.poses.json --out actor.json --metadata actor.meta.json
node bin/pixelbolt.js preview actor.json
```

The metadata exports each pose origin, resolved part anchors/points, markers, and expanded animation timing. Coordinates are **unscaled source pixels**, positive y down. For a game using `sheet.scale`, scale attachment coordinates explicitly; atlas rectangles already use exported pixels. Cue times are original milliseconds; divide by a positive playback rate in the consumer. Markers occur on entry into a pose, including repeated entries, reverse/pingpong positions and the first entry of a new loop. Nonlooping final holds do not repeatedly fire markers. Pixelbolt exports cues; the game owns event dispatch, collision and damage. Keep the `.poses.json` authoritative and reapply approved overlays after compilation.

## Scene and tile review

Use a separate `pixelforge-scene` version-1 manifest ([scene.schema.json](../scene.schema.json)). `assets` maps ids to recipes (inline or file references) or `{recipe, normal?, emissive?}`. `instances` draws in array order. An instance has `asset`, `at:[x,y]`, optional local `anchor`, integer `scale`, and either `frame`, `animation` or a `tilemap`. The anchor is one `[x, y]` in asset pixels (default `[0, 0]`), or `"frame"` to place every drawn frame by its own atlas anchor (per-frame or recipe-level), so an animated placement follows anchors that change between poses, as `drawFrame` does in a game. Tilemaps take `[x, y]` only. `repeat:[columns,rows]` and `step:[dx,dy]` create tile arrangements. Optional `sequence:[{time,frame|animation}]` cues choose a new state and restart that animation; a nonlooping reaction holds its final pose. Times increase strictly and stay below scene duration. Optional `trajectory:[{time,at,ease?}]` starts at time 0, interpolates between authored positions and rounds to whole pixels; it holds the last position. Each key's `ease` shapes the segment that starts at it: `linear` (default), `hold` (stay, then jump at the next key), `in`, `out`, `inOut`, `overshoot` or `bounce`. This is an explicit preview path, not inferred movement or physics.

Placements can relate to each other:

- **Named cues.** A scene-level `cues` map names times, `{"strike": 1200}`, and any `sequence` or `trajectory` time may then say `"strike"`, `"strike+90"` or `"strike-20"`, so the moment a blow lands is written once and the smear, the breaking pot and the debris follow it.
- **Hiding.** `hidden: true` starts a placement hidden until its first frame or animation cue, and a cue `{"time": "strike+250", "hide": true}` hides it again, so a smear or a burst needs no empty frame.
- **Attachment.** `attach: {"instance": "hero", "point": "blade"}` places this placement at a named point of another placement's current frame (frame `points`, which compiled poses export from their markers), plus `at` as an offset. It is not drawn while that frame has no such point. The target is any uniquely named placement that is not a tilemap or attached itself, listed anywhere, so a shadow can be listed (and drawn) before the actor that casts it.
- **Ground sorting.** Placements with `sort: "ground"` are drawn together, where the first of them is listed, ordered by their ground line: the y of their placement point, which is the anchor's position. With ground anchors on props and actors, a hero walking above a barrel is drawn behind it and below it in front, as a game draws them.
- **Shade placements.** `shade: -1` draws no colours: wherever the placement's frame is opaque, the pixels already drawn beneath move one step down the ramps of the asset's recipe. One shadow frame then darkens stone, floor, moss or brick correctly, and an attached shadow follows an actor across them.

```sh
node bin/pixelbolt.js preview examples/quality/hollow.scene.json
node bin/pixelbolt.js scene examples/quality/hollow.scene.json --out output/room-review
```

The scene viewer offers playback, scrubbing, native size, grayscale, a pixel-density overlay, lighting controls and scene-settings download. Drag on the scene to move the chosen light (pressing on another light's marker picks that one); a dashed ring shows how far it reaches, and sliders set its position, height and radius, its colour and the scene's ambient light, all redrawn as you go. Changes are in memory until downloaded; the download writes back each light's position and every field you changed. The export includes `scene.json`, lit/unlit stills, a browser viewer, aligned color/material atlases, and `alignment.json`. Serve its folder over HTTP for module loading, or use `preview` with the original manifest. Large rooms should be composed in a game: this review format is bounded to 256×256, 64 assets, 256 placement declarations, 4,096 expanded draws, 4,194,304 combined source-pass pixels, and 4,194,304 drawn pixels per view. Clipping warnings name the placements that overhang. It does not run a world state machine.

A scene `palette` re-themes every asset: a map of palette keys to colours, or a palette file the CLI and MCP resolve, applied to the keys each recipe already has (others are ignored), so one set of recipes renders as grey or blue stone from two small scene files. An asset entry `{"recipe": "floor.json", "palette": {...}}` adds overrides for that asset alone, after the scene's. Ramps name keys, so they follow the theme.

Assets can be inlined, or referenced so the manifest stays small: `"assets": { "lamp": "../recipes/lamp.json", "tower": { "recipe": "tower.json", "normal": "tower-normal.json" } }`. The CLI (`scene`, `preview`) resolves those files relative to the manifest, and their own palette references relative to each recipe; the MCP `pixel_scene` tool resolves them inside its root and also accepts `{"revision": id}`. The exported `scene.json` is the resolved, self-contained manifest.

A **tilemap** placement draws a whole character map as one declaration:

```json
{ "name": "ground", "asset": "shore", "at": [0, 0], "tilemap": {
  "rows": ["~~..", "~...", "~~.."],
  "legend": {
    "~": { "frames": ["water-a0", "water-b0"] },
    ".": { "animation": "shore-{mask}", "autotile": "blob", "match": ".g" }
  }
} }
```

`tile` defaults to the asset size. A legend entry names one `frame` or `animation`, or lists `frames`/`animations` variants that are picked deterministically by cell position, so repeated terrain does not tile visibly. With `autotile: "blob"` or `"cardinal"`, `{mask}` in the names becomes the cell's neighbour mask, computed from neighbours whose characters are in `match` (default: the same character). Neighbours outside the map count as empty unless `outside: "match"`. A legend entry set to `null` marks context cells: they are never drawn but count for other entries' `match`, so a review window cut from a larger map can carry a one-tile ring of the surrounding terrain (placed at a negative `at`) and its edge tiles still see their real neighbours. Every referenced name is checked when the scene is prepared; errors name the cell, e.g. `tilemap.rows[2][5]`. Masks and quarter pieces are the same ones the autotile compiler uses. `weights` (one whole number per name) make some variants commoner than others, and a tilemap `seed` reshuffles every seeded pick.

A legend entry can instead give `rules`, which choose by the characters around a cell rather than a same-or-different mask: what a 3/4 room needs, where a wall casts a face onto the floor below it and an island hangs a cliff into the void. Each rule draws what a plain entry draws (`frame`, `frames`, `animation` or `animations`, with `weights`, `autotile` and `match`) and may add:

- `where`: three rows of three characters centred on the cell. A dot matches anything; the tilemap's `empty` character matches empty cells and cells beyond the map (or anything there, with `outside: "match"`); a character from the tilemap's `classes` (`{"#": "WV"}`) matches any of its members, and may include the empty character; any other character matches itself.
- `chance`: a seeded probability that a matching rule draws, for wear and clutter.
- `offset`: `[columns, rows]` to draw into another cell. An offset output draws over that cell's own tiles.
- `stop`: when this rule draws, the cell's later rules are skipped.

Every rule that matches draws, in order. Tiles are drawn in map order of the cell they land in. A wall's cap and the cliff below it are one entry:

```json
"W": { "rules": [
  { "frames": ["cap-{mask}", "capb-{mask}"], "weights": [2, 1], "autotile": "blob" },
  { "where": ["...", "...", ".~."], "frame": "cliff", "offset": [0, 1] }
] }
```

Recipes draw the same legends with the `tilemap` operation (symbols and autotile templates instead of frames), so a room can be composed inside one recipe and shaded, dithered and rewritten afterwards; see the [authoring guide](agent-guide.md#operations). The [diorama study](../showcase/diorama/README.md) builds a whole room both ways.

`inspectTile(renderProject(recipe), frameName)` and `inspect --view tile` return a 3×3 repeat plus advisory seam evidence per axis. `doubledRows` (left/right wrap) and `doubledColumns` (top/bottom wrap) list lines where both opposite edges carry the same color that differs from its inner neighbours, which doubles into a 2px seam. `wrapSteps` counts large value steps across the wrap, compared with `interiorMaxSteps`, the busiest interior boundary. `suspicious` is true when a quarter or more of the lines double, or the wrap has more large steps than any interior boundary (a gradient or texture that does not continue). A stroke that merely touches one edge is not flagged. This is evidence to inspect, not proof that a tile is defective. Distinguish spatial variants from animations by selecting explicit frames in scene placements. Fractional scales are rejected; larger integer source pixels are highlighted for review. There is no automated style/palette harmonization, ground-speed solver or general scene editor.

## Autotile templates

A `pixelforge-autotile` source ([autotile.schema.json](../autotile.schema.json)) turns one small drawing into a complete terrain set. The template is two tiles wide and three tall:

```text
[ unused preview ][ inner corners  ]   each quadrant of the inner-corner tile is that quadrant's inner-corner piece
[   2×2-tile island (outer corners, edges and fill)   ]
```

Draw it like a tiny island in the sea: the island's four corner quadrants are outer corners, the quadrants between them are edges, and its center is fill, all consistent at quadrant boundaries. `mode: "blob"` (default) builds the 47-tile set from eight neighbours (N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128; a diagonal counts only when both adjacent sides match). `mode: "cardinal"` builds 16 tiles from four neighbours (N=1, E=2, S=4, W=8) without inner corners. `frame` names each tile with `{mask}`. Optional `variants` (up to 16, each with a `name`, `duration` and frame `palette`) multiply the set for palette-cycled animation (surf, glowing lava), with `{variant}` in the frame name and an optional per-mask `animation`. A variant may also redraw the set from its own `template` of the same size, compiled as the symbol `template-<name>`: cracked or mossy stone that keeps the base set's edges. A tilemap legend then mixes the sets with `"frames": ["wall-{mask}-plain", "wall-{mask}-cracked"], "weights": [2, 1]`.

```sh
node bin/pixelbolt.js autotile shore.autotile.json --out shore.json
```

Every compiled frame is one `autotile` operation naming its neighbour mask, drawn from the `template` symbol, so a frame reads as `{"op": "autotile", "symbol": "template", "mask": 23}` and editing the template in the compiled recipe updates the whole set. Use the same masks in a scene `tilemap` legend (`"autotile": "blob"`) or in a game.

## Particle effects

A `pixelforge-fx` source ([fx.schema.json](../fx.schema.json)) describes seeded particle emitters, after Pixel Composer's particle system, and compiles them into an ordinary recipe: every frame becomes `stamp`, `grid` and `line` operations on the source's own symbols. Inspect, patch, overlay and export the result like any other recipe; editing a symbol in it redraws every particle that uses it.

```json
{ "format": "pixelforge-fx", "version": 1, "name": "fx", "width": 48, "height": 40,
  "palette": { "W": "#fff4d6", "y": "#ffd166", "o": "#f4843c", "r": "#c2413a" },
  "symbols": { "hot": ["W"], "warm": ["y"], "cool": ["o"], "ash": ["r"] },
  "effects": { "sparks": { "frames": 9, "duration": 55, "seed": 11, "emitters": [
    { "at": [24, 30], "burst": 12, "angle": [205, 335], "speed": [1.8, 3.4], "gravity": [0, 0.32], "life": [6, 9],
      "floor": 36, "bounce": 0.35, "shapes": ["hot", "warm", "cool", "ash"], "trail": { "color": "r", "length": 1 } } ] } } }
```

```sh
node bin/pixelbolt.js compile examples/effects.fx.json --out output/effects.json --metadata output/effects.meta.json
node bin/pixelbolt.js preview examples/effects.fx.json   # the studio shows the compiled recipe
```

Each effect becomes frames `<effect>-0`, `<effect>-1`… and an animation named after the effect. An emitter spawns a `burst` at frame `start` or a `rate` of particles per frame until `end`, inside an `area` box centred on `at`. Per-particle values are picked from `[min, max]` ranges: `angle` (degrees clockwise, 0 right, 90 down, 270 up), `speed` (pixels per frame) and `life` (frames). Each frame velocity gains `gravity` and an optional `attract` pull, loses `drag`, and moves the particle; a `floor` stops it, with optional `bounce`. `sway` adds a drawn wobble (x follows a sine, y a cosine). `shapes` is one symbol sequence, or several with one picked per particle; `play` spreads it over the life (`life`, default), steps one per frame from a random start (`loop`, for flutter) or steps and holds (`once`, for hand-drawn flashes). `remaps` gives colour variants, `trail` draws a one-pixel streak from an earlier position, and `dissolve` thins the last share of each life through an ordered-dither `pattern` (a Bayer name, `noise` ordered by the effect's `seed`, or a custom rank matrix, as for the `dither` operation; `[[0, 1, 2], [1, 2, 0], [2, 0, 1]]` dissolves along diagonals).

Randomness is a seeded hash keyed by effect seed, emitter, spawn frame and particle, with a separate salt per property, so changing one range does not reshuffle the others, and the same source always compiles to the same recipe. A looping effect (`loop: true`, which needs a finite `life`) warms up for whole cycles with spawns keyed by their frame in the cycle, so the particles in flight at frame 0 are exactly those alive at the end. Particles partly off the canvas are cropped into grids and trails keep only on-canvas pixels, so compiled effects never clip. Metadata reports spawned particles, the most alive at once, operations and culled particles per effect.

The compiler makes behaviour cheap to try; it does not supply it. Give each material its own motion and shapes (fire rises and fades, stone chips arc and settle, leaves flutter), keep particle counts low enough to read at native size, and review playback. [examples/effects.fx.json](../examples/effects.fx.json) holds sparks, looping embers, landing dust, falling leaves and stone shards. Tidewatch's [effects source](../showcase/tidewatch/art/effects/fx.fx.json) shows a production set: sampled bursts for leaves and shards, a placed cluster (one emitter per puff) with a custom dissolve pattern for smoke, and hand-drawn frame sequences played by single particles.

## Fluid effects

A `pixelforge-fluid` source ([fluid.schema.json](../fluid.schema.json)) runs a real fluid simulation and compiles it into an ordinary recipe: every frame becomes one palette `grid` operation (plus `stamp`s for obstacles), so inspect, patch, overlay and export work unchanged, and a colour outside the palette cannot appear. Use it where particles fall short: fire that rises and licks, smoke that curls and thins, steam, explosions, magic swirls, splashing and falling water, a bubbling potion. The grid has one cell per canvas pixel, up to 128 × 128.

```json
{ "format": "pixelforge-fluid", "version": 1, "name": "torch", "width": 16, "height": 32,
  "palette": { "r": "#c23b2e", "o": "#f57f2a", "y": "#ffd257", "W": "#fff7d6", "s": "#4a4150", "b": "#5c3a24", "k": "#221a1c" },
  "symbols": { "handle": [".kbbk.", ".kbbk.", ".kbbk.", "..kk.."] },
  "effects": { "torch": { "frames": 16, "duration": 70, "loop": true, "seed": 4, "buoyancy": 0.5, "cooling": 0.2,
    "obstacles": [{ "symbol": "handle", "x": 5, "y": 26 }],
    "emitters": [{ "at": [8, 25], "area": [5, 2], "rate": 1, "temperature": 1, "density": 0.25, "velocity": [0, -1],
      "noise": 0.8, "flicker": 0.5, "sparks": { "count": 0.15, "life": [6, 10], "colors": ["y", "o", "r"] } }],
    "look": [
      { "field": "density", "colors": ["s"], "thresholds": [0.2], "dither": 0.8 },
      { "field": "temperature", "colors": ["r", "o", "y", "W"], "thresholds": [0.2, 0.36, 0.6, 0.9] } ] } } }
```

```sh
node bin/pixelbolt.js compile examples/campfire.fluid.json --out output/campfire.json --metadata output/campfire.meta.json
node bin/pixelbolt.js gif output/campfire.json --scale 4 --background "#1b1d2a" --out output/campfire.gif
node bin/pixelbolt.js preview examples/campfire.fluid.json   # the studio shows the compiled recipe
```

MCP `pixel_compile` takes the same source (`pixel_help` with `topic: "fluid"` returns the schema). The studio's **Fluid lab** (`/fluid.html`, linked from the studio) runs the same compiler in the browser: pick a preset, move a few sliders and download the GIF, sprite sheet, recipe or edited source; it shows the matching command line and MCP calls.

**Gases** (`kind: "gas"`, the default) use stable fluids on a staggered grid: semi-Lagrangian advection, a pressure solve with a fixed number of sweeps (`iterations`), vorticity confinement (`vorticity`, which keeps the small swirls that make smoke curl), buoyancy from temperature (`buoyancy`; `weight` makes dense smoke sink), `dissipation` of density, `cooling` of temperature, `drag` and `wind`. `advection: "sharp"` swaps the plain back-trace, which blurs a little every step, for MacCormack advection with a limiter: puffs keep a dense core and crisp edges and small swirls survive longer, at up to twice the cost and with no new peaks. Because it blurs less smoke away, a one-shot gas needs more `dissipation` to end empty: the explosion preset with sharp advection still has a few pixels on its last frame. **Liquids** (`kind: "liquid"`) carry water as FLIP particles (four per full cell) on the same grid and pressure solve, with `gravity`, `flip` (lively and noisier toward 1, calmer toward 0), `tension` (cohesion that keeps drops and streams together), `adhesion` and `drag`; `fill` places water at frame 0 in discs, boxes or their overlap. `apic: true` makes the calm share of each particle's velocity affine (APIC): it also carries the turning and shearing of the flow around the particle, so a calm liquid keeps its swirls and folds instead of smearing them. `walls` closes canvas edges (open edges let gas and water out), and `obstacles` stamp symbols whose visible pixels block the flow. The fluid never enters them; `draw` sets whether the obstacle is stamped in front of the fluid's outline and sparks (`over`, the default), behind them (`under`), or not at all (`none`, an invisible wall).

**Thick fluids.** `viscosity` (square pixels per frame, 0–64) is an implicit viscosity solve in stress form: it slows shearing and stretching but never motion as a whole, so a drop of honey falls exactly as fast as a drop of water, a stream stays one unbroken rope instead of breaking into drops, and a heap spreads slowly instead of splashing. For liquids, about 0.5 is oil, 2–4 syrup, 8–16 honey and 32–64 tar; for gases, 0.1–1 gives slow, smooth flows (above 1 a swirl dies within a few frames). It is not `drag`: drag takes a share of all motion away, falling included, as if the fluid moved through something thick, so a high drag makes everything slow, a falling drop included, but no thicker: it still spreads thin and breaks up. Walls and obstacles hold a viscous fluid, so honey runs slowly down a jar's side; `slip: true` lets it slide along them instead (a greased pan). A viscous liquid also calms its own particle jitter, so its effective FLIP share falls as it thickens; give it `apic: true` so that calm share keeps its folds. `yield` (liquids, 0–16) is a yield stress, for mud, slime, dough and toothpaste: below it the liquid is elastic, so a blob squashes where it lands and springs back, and a heap keeps its shape; pushed past it, the liquid flows (and with `viscosity` as well, flows thickly). A heap *h* pixels high holds itself up when `yield` is more than about gravity × *h* / 2, so at the default gravity of 0.3 a yield of 2 holds a 12-pixel heap and 0.5 lets it slump. `adhesion` (liquids, 0–4) is how strongly liquid holds on to walls and obstacles: liquid touching a solid stays on it unless pulled away faster than about `adhesion` ÷ 2 pixels per frame, so a film clings under a ledge or to a spoon while the rest falls away. A viscous or yield-stress fluid costs about three times as much per step (a viscosity solve with as many conjugate-gradient steps as `iterations`, and for a liquid a second pressure solve); lower `iterations` to 20–30 if a thick preset is slow.

An emitter is a disc (`radius`, default 2) or a box (`area`) centred on `at`. A `burst` adds its amounts once, at `start`; a `rate` emitter works every frame until `end`, holding its cells at the amounts rather than piling them up, so a steady source keeps its level (a short window such as `end: 3` gives a blast that keeps growing for a few frames). Each is a strength multiplier. Gas emitters add or hold `density` (smoke) and `temperature` (heat, which rises); liquid emitters fill their cells with water (`density` is the share filled, default 1) or drain them (a negative share of the particles there each frame, which balances a source in a loop). `velocity` steers the flow (a jet; `[0, 0]` holds the covered cells still, as a drop gathering at a tip), `vortex` swirls it (clockwise for positive values), and `expand` pushes outward: a gas expands through the pressure solve, as hot gas does. `noise` adds coherent turbulence, `flicker` varies the strength from cell to cell and frame to frame so a flame's base breaks into tongues, `pulse` makes the strength rise and fall (puffs, heaves) and `orbit` moves the emitter in a circle, or an ellipse with `radius: [x, y]`. An orbiting rate emitter is laid along the path it covered since the last frame, so a fast orbit leaves a smooth trail. `falloff` (0–1) makes the amounts fall off from the centre toward the rim, so one emitter makes a round puff that is densest in the middle and shrinks as a ball when it thins. `sparks` are small particles carried by the flow and drawn over it, with their own `colors` over their life, `size` (1–3 pixels; 2 reads at 1×) and an optional `trail` that streaks back to where the spark was a frame earlier: embers, sparkles, debris (`follow: 0` ignores the flow; in a liquid such spray ends where it falls back into the water) and bubbles (`pop: true` bursts them where they leave the liquid: a ring for one frame, then two droplets). An emitter with no amounts of its own is a handy spark source, such as embers rising above a flame rather than inside the logs.

`look` turns fields into pixels, one layer after another. Each layer names a `field` and gives palette `colors` with rising `thresholds`: a colour is fully on from its threshold up, and `dither` (0–1, default 0.5) feathers it in below through an ordered `pattern` anchored to the canvas (bayer4 by default; the same patterns as the `dither` operation). Fields are `density`, `temperature` (gases), `speed` (pixels per frame: foam, fast water; a liquid has speed wherever there is at least a quarter of a cell of water, so a speed layer also draws thin, fast water such as a falling drop), `depth` (pixels down from a liquid's surface, 1 on its top row, for a highlight line and deeper bands; from the third row down it follows the shallowest surface within three pixels along the row, so the bands stay level under a landing drop or a rising crest), and `light` and `shadow` (0–1: how sharply density falls toward or away from the `light` direction, upper left by default), which only recolour pixels earlier layers drew and give smoke and fireballs a lit form. Colours are one-character palette keys, since grid rows name colours by character. `cleanup` runs De-Stray and De-Corner on the fluid, then `outline` draws a one-pixel outline around it and sparks are drawn over it.

`whitewater` (liquids, up to four layers) throws spray and foam off the water by its own motion, so a splash or a waterfall needs no spray emitters timed to the frame where the water lands. A layer picks particles at the surface by `impact` (its velocity changed by at least that many pixels per frame within one frame: a drop landing, water striking water) or by `speed` (it moves at least that fast: a stream shedding drops). Each throws a droplet with probability `chance` per frame, along that change or that motion tipped away from the water, at `throw` times the amount and turned by up to `spread` degrees. Droplets are sparks with their own `colors`, `life`, `size`, `trail`, `gravity` (by default the effect's) and `drag`. With `follow: 0` (the default) they are spray: drawn once they have left the water, and ending where they fall back in. With `follow` above 0 they are foam carried on the flow, ending once the flow carries them under. The splash and waterfall presets use it.

A looping effect (`loop: true`) repeats its forcing every cycle: emitter timing, pulses, orbits, noise and flicker are keyed by the frame within the cycle, so pulse and orbit periods must divide the frame count. The simulation warms up for `warmup` whole cycles (default 2; raise it when a flow takes long to settle, such as a pool filling), then blends the fields (not the pixels) of its closing `blend` frames toward the frames that preceded frame 0, so the last frame flows into the first; sparks that outlive the cycle are drawn from the start again, so they loop exactly. A one-shot effect should end empty (gas) or at rest (liquid): the metadata's `residue` is the number of pixels left in the last frame, and `pixels` counts the pixels of every frame. Limits keep compiles quick and bounded: at most 16 effects of up to 16 emitters and 32 obstacles, a 128 × 128 canvas, 32,768 liquid particles and 4,096 sparks alive at once, flows no faster than 32 pixels per frame, and about 400 million cell updates of simulation per source (the presets need at most 60 million); an error names the effect that goes over. Everything is deterministic: only `+ − × ÷` and square roots, the polynomial trigonometry and seeded hash in `craft.js`, a fixed timestep (`substeps` per frame) and fixed iteration counts, so the same source gives the same recipe on every machine and in the browser. Each example compiles in well under a second.

Tuning tips. Fire needs strong `buoyancy` (0.4–0.5) and `cooling` (0.13–0.2) so the flame stays short, `noise` and `flicker` for tongues, and a temperature ramp from dark red to near-white with the white threshold above the source level so the core only flashes white. Smoke wants a dark-to-light ramp with generous `dither` so it thins rather than ending in a hard edge. Explosions are a short `rate` window with strong `temperature` and `expand`, then cooling into smoke; check them at 1× with `inspect --scale 1`. Liquids need closed `walls` or a basin, a body colour at density 0.5 and `depth` bands; give a looping liquid a way out (an open edge past a lip, or a draining emitter) so its level settles during the warm-up; a drain laid along the surface you want (a `seep`) keeps the level there whatever flows in. Honey wants `viscosity` 8–16, `apic: true` and a low `tension` (0.3), since cohesion pulls a thin rope into beads; draw the rope by `speed` as well as density, as the waterfall is drawn. Slime wants `yield` 4–8 and `apic: true`, with `light` and `shadow` layers for a glossy dome. Inspect `--diagnostics` on looping results: the loop-boundary check stays quiet on every example.

Two things that catch people out. An emitter whose cells lie inside an obstacle makes no fluid, with no error: the fluid never enters obstacles, so `peak` in the metadata stays at zero (and `pixels` too, unless the emitter has sparks, which still appear). Move the source just outside the obstacle's visible pixels. And a liquid can't burst apart in mid-air: outward `velocity` given to fills that touch each other is largely cancelled by the pressure solve, so one connected blob stays together while separate drops fly off. For a splash, throw the water onto something: an obstacle (`draw: "none"` makes an invisible floor) or a pool of water.

[examples/](../examples/) holds twelve presets: [campfire](../examples/campfire.fluid.json), [smoke puff](../examples/smoke-puff.fluid.json), [explosion](../examples/explosion.fluid.json), [steam vent](../examples/steam-vent.fluid.json), [magic swirl](../examples/magic-swirl.fluid.json), [torch](../examples/torch.fluid.json), [splash](../examples/splash.fluid.json), [waterfall](../examples/waterfall.fluid.json), [drip](../examples/drip.fluid.json), [bubbling potion](../examples/potion.fluid.json), [honey](../examples/honey.fluid.json) (viscous) and [slime](../examples/slime.fluid.json) (yield stress).

### Live fluids

`createLiveFluid` (from `pixelbolt/fluid`, or `src/fluid.js` in a web page) runs one effect of a fluid source live, a frame at a time. A page can then answer the pointer on the next frame instead of compiling a whole loop again. It runs the same simulation as `compileFluid`: the same solver, emitters, sparks and whitewater, drawn with the effect's own look layers, cleanup and outline. The same source and the same calls give the same pixels in Node, Chromium, Firefox and WebKit.

```js
import { createLiveFluid } from 'pixelbolt/fluid';
const live = createLiveFluid(source, { effect: 'torch', warmup: 16 }); // checks the source as compileFluid does, then warms up
live.push({ x: 8, y: 20, vx: 2, vy: -1, radius: 5 });                  // stir: velocity in pixels per frame, soft disc
live.puff({ x: 8, y: 24, radius: 3, density: 1, temperature: 1 });     // more smoke and heat (in a liquid, water)
live.boost('flame', 3, 40);                                            // the emitter named flame, 3 × as strong for 40 frames
live.step();                                                           // the push and puff act in this frame
const { rgba, keys } = live.render();                                  // RGBA pixels, and each pixel's palette key
```

- **`createLiveFluid(source, { effect, warmup })`** makes every check `compileFluid` makes before simulating, with the same error paths and messages. The limits a compile meets while simulating (particles, sparks, the renderer's drawing budget) don't stop a live run. Its own options fail at `live.effect` and `live.warmup`. `effect` names the effect to run (default: the first). `warmup` is the number of frames simulated before it returns (default: one cycle, the effect's `frames`; at most 2,048). Inline the palette, since a page can't follow a palette `$ref`.
- **Properties:** `width`, `height`, `kind` (`gas` or `liquid`), `frames` (the cycle length) and `palette` (each key's colour as `#rrggbb`, or `#rrggbbaa` when translucent). Also, read-only: `frame` (frames simulated, warm-up included), `particles` and `sparks` (how many are alive).
- **`step(n = 1)`** simulates `n` frames (at most 2,048 a call), each in the effect's `substeps`. Emitter windows, pulses, orbits, noise and flicker follow the frame number modulo `frames`, as in a loop, so a looping effect keeps looping and a one-shot repeats every `frames` frames. There is no seam to blend, and sparks join on every frame.
- **`push({ x, y, vx, vy, radius })`** adds velocity in pixels per frame (−16 to 16) with a soft disc falloff (radius 4 by default). A gas gets it in its flow; a liquid gets it on the particles in range.
- **`puff({ x, y, radius, density, temperature })`** in a gas adds density and heat (−16 to 16; default 1 and 0) with the same soft falloff; negative amounts take them away. In a liquid it fills the disc's cells to `density`, the share filled (up to 1, default 1), with still water, as a liquid emitter's disc does; a negative share (down to −1) drains that share of the particles there.
- Pushes and puffs act at the next step, after the emitters and in the order they were made. A push's change of speed doesn't count as a whitewater impact, though the water it throws can land as one. At most 1,024 wait for a step; beyond that the oldest are dropped, so stop queueing while stepping is paused.
- **`boost(name, strength, frames)`** multiplies the strength (the `rate` or `burst`) of every emitter with that `name` by `strength` (0–16; 0 turns it off) for the next `frames` frames. A later boost of the same emitter replaces it. Strength scales noise and the number of sparks thrown. In a gas it also scales expansion, a burst's amounts and the kick of its `velocity`, and the density and temperature a rate emitter holds. A rate emitter steers its cells toward its `velocity` (a liquid one also toward its `expand`) more firmly but no faster. A liquid emitter fills its disc to its `density` share at most, so at a rate of 1 or more boosting it adds little water, and only water already in a liquid burst's disc gets the stronger kick. Push for a stronger jet, or puff for more water. Outside its `start`–`end` window, a boosted emitter stays idle.
- **`render()`** returns `{ rgba, keys }`. `rgba` is a `Uint8ClampedArray` of width × height × 4 values, ready for `new ImageData(rgba, width, height)`. `keys` has one string per row naming the topmost palette key drawn at each pixel (`.` where nothing is drawn), so a page can recolour or overlay by key. With an opaque palette, each pixel is exactly its key's colour; a translucent colour blends over whatever is drawn beneath it, so there the pixel is a mix and the key names only its top layer. It draws the look layers, cleanup and outline, then sparks and whitewater, then the obstacles stamped under or over, exactly as a compiled frame does. A one-shot effect run from `warmup: 0` reproduces `compileFluid`'s frames. A loop with no sparks or whitewater, warmed up for the compiler's cycles, matches its frames until the seam blend. Sparks and whitewater can differ: the compiler adds them during the recorded cycle only and wraps the late ones round to frame 0, while a live run adds them on every frame.
- `step`, `push`, `puff` and `boost` return the runner, so calls chain: `live.push(…).step().render()`. Once running, a live run never stops at a limit: beyond 32,768 particles or 4,096 sparks, more are not added (a liquid's starting `fill` is checked as `compileFluid` checks it). A push or puff never fails on a number out of range: `x` and `y` are clamped to −256 to 512, `radius` to 0.5 to 64, and `vx`, `vy`, `density` and `temperature` to the ranges above. A missing `x` or `y`, or a value that is not a number (`NaN` included), fails with a path such as `push.x`, so guard pointer maths such as a distance over a zero time. `boost` and `step` check their arguments strictly (`boost.name`, `step`).

One step costs about what one compiled frame does. On a desktop CPU, the portfolio hero's 128 × 60 steam (30 pressure sweeps, 2 substeps) steps in about 7–9 ms in Node, Chromium, Firefox and WebKit, and renders in about 1 ms; its 44 × 50 liquid flask steps in about 2 ms. Creating a runner simulates its warm-up, about 0.7 s for that steam's 96 frames. So create runners after the first paint, or in a Web Worker that sends `rgba` to the page (transfer its buffer). Stepping at the effect's own frame duration (70 ms is typical) keeps the look of the compiled loop.

## Lossless raster return path

```sh
node bin/pixelbolt.js import corrected.png --name refined --atlas optional.atlas.json --out refined.json --metadata import.provenance.json
```

Supported PNGs are non-interlaced 8-bit RGB/RGBA with standard filters and checked chunk CRCs, at most 32 MiB compressed, 4096 per side and 16,777,216 pixels. APNG, indexed/grayscale PNG, `tRNS`, interlace and unsupported critical chunks fail clearly. No quantization, resizing, alpha modification or color-profile conversion is performed. Channel values, including RGB under alpha zero, are preserved. A single image must fit the sprite limits. Optional Pixelbolt/TexturePacker-style metadata requires `meta.scale:1`, equal-size untrimmed/unrotated rectangles, and supported frame counts/source-area limits; durations and expanded named sequences/loop flags survive. Inputs with at most 256 visible colors (the palette limit) return as compact palette grids, using ASCII keys first and then single-code-unit Latin letters; richer inputs use exact final `pixels`. Hidden RGB under alpha zero is preserved with explicit corrections. Neither representation claims to reconstruct the original drawing operations. Keep pose anchors/cues in their separately saved metadata; this import does not reconstruct them. Native Aseprite interchange is still future work.

## Aligned material passes

Scene assets may provide normal and emissive recipes, drawn by hand or generated (below). They must share color dimensions, frame names/order, durations, animations and atlas layout. Each exported asset directory has `color.png`, optional `normal.png`/`emissive.png`, and one common atlas JSON. `alignment.json` maps asset ids to those files. Normal RGB encodes XYZ from −1 to +1: +X right, +Y down, +Z toward the viewer. Normals are renormalized for preview; their color channels are never palette-quantized.

`lighting:{ambient,bands,scope,lights:[{at,height,radius,color}]}` supplies at most eight bounded preview lights. Each light's diffuse brightness is banded deliberately into `bands` steps and then tinted by its color, so a colored light keeps one hue per ring; ambient light is not banded. Emission remains aligned to the current pose. With the default `scope: "passes"`, assets without passes keep their authored colors. `scope: "all"` lights them too, as flat surfaces facing the viewer, so a night scene darkens the terrain and props instead of only the assets with normal maps. Disabling lighting gives the ordinary color fallback. `mode: "ramp"` keeps the palette instead: each pixel's brightness (ambient plus banded lights; a light's colour then only sets its brightness) moves its colour along the ramps of its recipe, one step per `1 / steps` away from full brightness (`steps` 1–8, default 2), darker in shadow and up to `steps` lighter in a light's pool. Emissive pixels keep their colour, and colours on no ramp stay unlit. A torch-lit room then has exactly the colours of the unlit one. Aligned passes are exported on a uniform grid even when the color recipe trims its own atlas. This is a CPU material review, not a physically complete lighting model: no shadow propagation, fluid simulation, bloom, raymarching or material-mask pass is implemented. Measure preview cost separately from sprite-player performance before expanding it.

### Generated normal passes

A `pixelforge-normals` source ([normals.schema.json](../normals.schema.json)) derives a normal pass instead of drawing one: `{ "format": "pixelforge-normals", "version": 1, "recipe": "lamp.json" }` compiles with `pixelbolt compile lamp.normals.json --out lamp-normal.json`, or MCP `pixel_compile`, where the recipe may also be `{"revision": id}`. Each separate shape in a frame is rounded from its silhouette like a cushion: its rim leans outward and its thickest point faces the viewer, so props in one frame each get their own dome. `bevel` (1–64) rounds only that many pixels in from the edge and leaves a flat top. `detail` (0–1, default 0) raises lighter colours by up to 2 pixels to emboss brick, bark or rock; a colour on a ramp counts its step along that ramp, so two materials at the same step stay level, and any other colour counts its brightness. Transparent pixels are edges and the canvas border is not, so tiles and shapes cut by the frame stay open; frames with `wrap` read their slopes across the border and tile without seams.

The result is an ordinary recipe with the colour recipe's size, frame names and durations, animations and `sheet`. It covers exactly the colour silhouette, so its atlas has the same rectangles as the colour atlas, trimmed or not. Its palette names 17 directions: `5` faces the viewer, the digits around it lean 30° the way they sit around 5 on a numeric keypad (`8` up, `6` right, `1` down-left), and `q w e`, `a d`, `z x c` lean 60° the same way on a keyboard. A generated pass therefore reads as letters around the rims and digits across the faces, and a fix is written the same way: `a` on a left rim, `9` on a face turned up and right. [examples/forest-spirit.normals.json](../examples/forest-spirit.normals.json) compiles to [examples/forest-spirit-normal.json](../examples/forest-spirit-normal.json); `pixelbolt preview examples/forest-spirit-lit.scene.json` lights it, and you can move the light.

Inflating a silhouette cannot see forms its outline does not show. A tower or a box seen from the front comes out as a cushion, with ridges where its rims meet, and overlapping parts (an arm across the body) share one surface. Treat the pass as a start: light it from both sides in a scene, correct it with `patch`, and keep approved corrections in an overlay; they reapply to the frames a later compile leaves unchanged. Hand-drawn passes stay right for strong geometric forms (Tidewatch's lighthouse is one).

Mirrored frames get mirrored normals, because the pass is derived from the drawn pixels. A hand-drawn normal recipe that mirrors with `flipX` (a frame, an operation or a mirrored pose) only moves its pixels: each keeps its left or right lean, so the mirrored frame lights from the wrong side. Derive those frames, or repaint their left and right keys. For engines that read normals with +Y up (Godot, Unity), see [game integration](game-integration.md#normal-and-emissive-passes).
