# Tidewatch: stretching PixelForge on a top-down game

27 September 2026 · Baseline `1e47c22` (0.1.0) · Windows 11, Node v24.19.0 · Browser checks in the Chromium pane of the Claude desktop app.

## Update 4: one mirror convention

28 September 2026. The pose compiler's `mirror` now reflects around the origin corner (pixel column c becomes 2 × originX − 1 − c), the same reflection as `drawFrame`'s `flipX` and engines that flip around the atlas pivot. A new test places a compiled mirror by its anchor and flips the original with `drawFrame` through a rasterizing context: the pixels are identical for trimmed and untrimmed sheets, and the test fails under the old rule.

The keeper's front and back views are symmetric around that corner (columns 12–27 around x 20, centroid 20.0), and its right-facing side views sit just right of it (centroid 20.25). The old pixel-column rule put the left-facing views at 20.75, a pixel right of a true mirror. They are now at 19.75. Only the ten mirrored poses moved, by one pixel. The trimmed keeper atlas image is unchanged; its metadata records the new offsets. Left-facing blade tips now mirror the right-facing ones exactly around the anchor. Crabs and gulls already flipped at runtime and are unchanged.

## Update 3: compact compiled terrain and frame anchors in scenes

28 September 2026. Two of the open items below are fixed.

- **Compiled terrain.** A new `autotile` drawing operation draws one tile from the template symbol for a neighbour mask, and the autotile compiler emits one per frame instead of four `copy` operations. Every shore and grass frame renders pixel-identical, and all 91 game exports are unchanged. Separately, files the CLI generates (`compile`, `autotile`, `import`, `overlay`) now use compact formatting: records that fit in 120 columns stay on one line and grids keep one row per line. Together these took `shore.json` from 184 KB to 44 KB and `grass.json` from 40 KB to 6.6 KB. With the recompiled keeper, crab and effects recipes and their metadata, the compiled Tidewatch sources went from 399 KB to 151 KB, with identical contents apart from the terrain ops.
- **Frame anchors in scenes.** A scene instance may set `anchor: "frame"` to place every drawn frame by its own atlas anchor, so animated placements follow per-frame anchors. `make-scene.mjs` now uses it instead of rendering each recipe to copy its first frame's anchor. The headland manifest dropped from 10.8 KB to 9.8 KB and renders identically at all 48 sampled times, because Tidewatch's props keep one anchor per animation.

## Update 2: effects rebuilt with the particle compiler

28 September 2026. After PixelForge gained `pixelforge-fx` (seeded particle emitters compiled to ordinary recipes), Tidewatch's `fx` recipe was rebuilt from a source file, `art/effects/fx.fx.json`, instead of the hand-written particle code in `tools/make-fx.mjs`.

- **Leaves, shards, splash, poof and dust** are now emitters with sampled launch angles and speeds, gravity, drag, a floor with bounce, sway, trails and dithered dissolves. The poof keeps its placed six-puff cluster (one emitter per puff) and its diagonal dissolve, now a custom dither matrix. Seeds were chosen for balanced spreads.
- **Hit and sparkle** keep their hand-drawn frames, played by a single particle. A test proves every one of those frames is pixel-identical to the original placement.
- **Unchanged for the game:** the seven animation names, frame counts, durations, loop flags and the `[16, 20]` anchor are the same, so the game needed no code change. The effects were checked in the running game through `window.__tidewatch.advance`.
- **Size:** the particle code was 5.8 KB of JavaScript producing a 60 KB recipe of one full grid per frame. The source is 5.8 KB of data when minified (3 KB of emitters, 2.6 KB of symbols) and compiles to a 34 KB recipe of 209 stamp, grid and line operations on shared symbols, so editing a leaf symbol updates every leaf. `tools/make-effects.mjs` is the scaffold that first wrote the source.
- **Checks:** `test/tidewatch.test.js` now also fails if `recipes/fx.json` is stale relative to its source. Only the four effects exports changed (`fx.png`, `fx.json` and the gallery's `fx` sheet and APNGs); the other 84 exported files are byte-identical.

## Update: fixed, implemented and dogfooded

After the first pass I fixed every bug and implemented every missing feature below in PixelForge itself, then rebuilt Tidewatch on them. The original findings follow unchanged, as the record of what was found.

| ID | Status | What changed |
| --- | --- | --- |
| TW-B1 | Fixed | An oversized MCP line gets a JSON-RPC `-32600` error (with the request id when it can be read). The rest of the line is discarded and the server keeps serving. |
| TW-B2 | Fixed | Requests may be 16 MiB (`MAX_REQUEST_BYTES`, shared by MCP and the preview server). PNG import keeps up to 256 visible colours as compact palette grids. The 2.3 MB validate call and the rich 256×256 import now fit. |
| TW-B3 | Fixed | Seam evidence reports doubled edge lines (opposite edges equal to each other and unlike their inner neighbours) and wrap steps against the busiest interior boundary. Available as `inspect --view tile`, MCP `view: "tile"` and `inspectTile`. |
| TW-B4 | Fixed | Recipe validation lists clipping by frame, operation path and pixel count; scene warnings name the placements. |
| TW-B5 | Fixed | Runtime image loading resolves on `load`/`error` instead of `decode()`. |
| TW-M1 | Implemented | Scene `tilemap` placements: legend, position-picked variants, `autotile: "blob"`/`"cardinal"`, `match`, and context cells. `pixelforge autotile` compiles a 2×3-tile template into 47 or 16 tiles, with palette variants and per-mask animations. New `copy` op. |
| TW-M2 | Implemented | Recipe and frame `anchor`, frame `points`. Atlases export `anchor`, `pivot` and `points`; compiled poses export their origins and markers this way. |
| TW-M3 | Implemented | `sheet.trim` packs visible pixels and records `spriteSourceSize`. Untrimmed output is byte-identical to before. |
| TW-M4 | Implemented | Shared palette files (`"palette": { "$ref": … }`, resolved by the CLI and MCP; `patch --out` keeps the link), per-frame `palette` overrides for cycling, and `remap` on grids, stamps and copies. |
| TW-M5 | Implemented | `outline` op, optionally with diagonals. |
| TW-M6 | Implemented | `lighting.scope: "all"`, scene asset file and revision references, a viewer light picker that moves any light, named clipping. |
| TW-M7 | Implemented | `pixel_compile`, `pixel_scene` and `pixel_import`; `pixel_help` topics; overlays through `pixel_patch`. Render responses list key files and counts (`listFiles` returns every file). |
| TW-M8 | Implemented | Pose `mirror` and part `flipX`. Overlays fingerprint each frame they touch and rebase onto unrelated changes. |
| TW-M9 | Implemented | Runtime `loadSpriteSheet`, `frameAt` and `drawFrame` (anchors, trim offsets, flips, integer scale). |
| TW-M10 | Implemented | Frame `wrap` makes `translate` wrap around. |
| Friction | Partly fixed | `compilePoses` returns plain objects, and the authoring guide notes integer-like key order. Case-insensitive unique names stay, by design. |

**Tidewatch on the new features.** Every scaffold in `tools/` was switched over and rerun. Each scaffold was first shown to reproduce the committed sources exactly, so no hand edits were lost.

- **Keeper.** The 10 left-facing poses are `mirror`s and the raised right arm is the left one with `flipX`. 16 hand-mirrored parts are gone; the source shrank from 48.8 KB to 37.3 KB.
- **Crab.** The right claw is the left one with `flipX`. The origin is now the ground contact, with hops lifting the body, so the atlas anchor is the game's old hand-measured `[16, 19]`.
- **Terrain.** `shore` and `grass` compile from two 32×48 templates, 5 KB in total, replacing 186 KB of hand-assembled recipes. The surf is four palette variants instead of marker colours and 564 `replace` ops.
- **Oak and palettes.** One `outline` op replaces dilated copies of each leaf cluster. Every colour recipe links `art/palette.json`.
- **Game.** The hand-measured `ANCHORS` table, the pixel-measured glyph widths and the pose-metadata file are gone. The game loads with `loadSpriteSheet`, times with `frameAt`, draws with `drawFrame` and masks terrain with `neighbourMask`. It reads reach, the held item and glyph advances from atlas points. Trimming cut the sprite atlases from 170,496 to 55,874 pixels (the keeper from 64,000 to 17,664).
- **Scene review.** The manifest went from 544 KB of inlined recipes to 10.8 KB: file references, three tilemap placements and `lighting.scope: "all"`.

**Evidence that nothing changed on screen.**

- All 528 rendered frames hash-identical to the originals.
- The committed game and the rebuilt game produced identical 240×160 frames at all 34 checkpoints of one scripted session. The session used `advance()` only, with the wall clock frozen, and covered walks, four-way attacks, the crab fight, the jelly, 16 prop kinds, grass cutting, the held item, gulls and night lighting with the beam.
- The rewritten map-preview tool, now three tilemap placements, reproduces the old per-tile tool's output exactly.

**New findings from the second pass.**

- **TW-B6 — P3, fixed: banded scene lighting shifted hues.** Each colour channel was banded separately, so a warm light changed band at a different distance per channel, painting rainbow rings. This was barely visible while only lit buildings were shaded; `scope: "all"` exposed it across the terrain. Each light's brightness is now banded once and then tinted, and ambient light is no longer banded. The quality lab's lantern images were regenerated.
- **TW-M11 — added: context cells.** A tilemap cut from a larger map could not see neighbours beyond its edge, so edge tiles drew false coastlines. A `null` legend entry now marks cells that count for matching but are never drawn.
- **Fixed in Update 3: verbose compiled recipes.** `shore.json` grew from 157 KB to 184 KB, because each frame spells out four `copy` ops and a palette, while its template is 3 KB.
- **Fixed in Update 3: scene placements ignore frame anchors.** `make-scene.mjs` reads anchors from the recipes and passes them explicitly. An animated placement cannot follow per-frame anchors.
- **Fixed in Update 4: two mirror conventions.** The pose compiler's `mirror` reflects around the origin pixel column, which matched the hand-mirrored art. The runtime's `drawFrame` flips around the anchor corner. They differ by one pixel, so use one or the other for a given asset.

**Checks.** `npm test` passes 104/104. `check:quality`, `check:tidewatch`, the Emberfall stress run (0 findings) and the Pillow checks (`verify-exports.py`, `verify-quality.py`, `verify-trim.py`, `verify-emberfall.py`) all pass. I checked the scene viewer's light picker in the browser pane.

## Summary

I built [Tidewatch](../../showcase/tidewatch/README.md), a small top-down action-adventure, to find where PixelForge helps and where it runs out. Everything visual is PixelForge output:

- 29 recipes and 2 pose sources, giving 527 frames and 77 animations.
- A 47-tile blob autotile set for sand and one for grass.
- Palette-cycled surf.
- A pose-compiled keeper (40 poses, four facings) and a pose-compiled crab.
- Normal and emissive passes for the buildings.
- Effects and a 76-glyph font.

The browser game reads PixelForge atlases directly, including the pose markers that set the sword's reach, and composites the material passes into dusk and night lighting.

**Verdict.** PixelForge handled every pixel I asked it to. Its core was reliable: rendering, exports, PNG import, patch reports and error paths. I found no rendering or export bugs. The gaps are at the edges an agent hits when making a *game* rather than a sprite: tilemaps and autotiles, pivots and per-frame metadata, trimmed atlases, shared or animated palettes, outlines, scene lighting, and parts of the MCP surface. The workarounds are in the showcase's `tools/` and `game/src`, and each one is recorded below.

| | Count | Highest severity |
| --- | --- | --- |
| Bugs (reproduced) | 4 | P2: the MCP server exits on an oversized message |
| Suspected bug | 1 | P3: `SpritePlayer.load` can wait forever on `image.decode()` |
| Missing features | 10 | Tilemaps/autotiles, pivots, trimming |
| Friction points | 5 | — |

The five changes that would have saved the most work, in order:

1. Keep the MCP server alive on oversized input and align its limit with the format.
2. Add a tilemap layer to scenes, plus a region copy for autotile templates.
3. Add pivots and free-form per-frame points to plain recipes and the atlas.
4. Offer trimmed atlas export, since the format already has `trimmed`/`spriteSourceSize`.
5. Support a shared palette file plus palette cycling or remap.

## What held up well

- **Deterministic, fast export.** All 29 recipes export to atlases, aligned passes and APNG previews in about 0.8 s. The committed exports are verified against the recipes in CI (`npm run check:tidewatch`, in `test/tidewatch.test.js`).
- **Error messages an agent can act on.** Examples: `project.frames[1].ops[0].rows[9]: all rows must be 32 characters wide`, and `changes[0].value.rows[1]: unknown palette character "x"`. Each pointed at the exact row or patch.
- **Pose compiler.** Attachment points made the walk cycle cheap: legs expose a hip point and the torso a neck point, so passing poses lift the whole upper body. A sword-arm part attaches at a shoulder point. The compiled `hit` markers became the game's attack hitbox with no measuring by hand. A bad item-get pose was fixed in the pose source and recompiled in seconds.
- **MCP revisions and patches.**
  - Revision ids are content-derived and stable across server restarts.
  - A 5-pixel `grid` patch reported exactly those 5 pixels, with `scope: "frame"` protecting other frames.
  - Onion views and diagnostics caught two crab walk frames that duplicated idle frames.
- **Lossless PNG import.** The 40-frame keeper atlas and the lighthouse normal atlas round-trip with identical RGBA, durations and all 14 animations, in 64 ms.
- **Material passes.** Aligned normal and emissive recipes worked unchanged in a custom renderer. PixelForge's alignment check matches frame names, durations, animations and sizes, which caught mistakes early.

## Bugs

### TW-B1 — P2: an oversized MCP message terminates the server

**Area:** `src/mcp.js` read loop. **Status:** reproduced.

`startMCP` throws `MCP message exceeds 2 MiB` inside the `for await` loop. That rejects the whole server promise, so the CLI prints `{"ok":false,"error":"MCP message exceeds 2 MiB"}` to stderr and exits with code 1. The offending request never gets a JSON-RPC reply, and the client's next write fails with EOF.

```js
// Node, from the repo root. A single 2.3 MB pixel_validate call:
import { spawn } from 'node:child_process';
const s = spawn(process.execPath, ['bin/pixelforge.js', 'mcp', '--out', 'output/mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
s.on('exit', code => console.log('exit', code));            // → exit 1
const send = m => s.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
const pixels = Array.from({ length: 65536 }, (_, i) => ({ x: i % 256, y: i >> 8, color: '#123456' }));
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pixel_validate', arguments: { project: { version: 1, name: 'big', width: 256, height: 256, frames: [{ name: 'a', pixels }] } } } });
```

**Expected:** a JSON-RPC error for id 2, such as `-32600` with the size limit, after which the server keeps serving. **Suggested fix:** when a line exceeds the cap, discard it up to the next newline, reply with an error (using the id if it can be recovered cheaply, otherwise `null`), and continue the loop. Add a regression test: an oversized line, then a `ping` that still succeeds.

### TW-B2 — P3: the recipe format allows requests the MCP transport rejects

**Area:** limits in `src/core.js` and `src/import.js` versus `src/mcp.js`. **Status:** reproduced.

The format accepts 65,536 `pixels` corrections per frame. One such frame serializes to about 2.3 MB, which is over the 2 MiB MCP line limit. The same happens after PNG import: a 256×256 image with more than 80 colours imports as explicit pixels, and wrapping that recipe in a `pixel_validate` call makes a **2.43 MB** message. Imported editor art at the maximum canvas therefore cannot enter the MCP workflow, and given TW-B1, trying it kills the server.

**Suggested fix:** either raise the transport cap above what the format can express (a 256×256 frame of explicit pixels is roughly 2.5 MB; 16 MiB would cover realistic multi-frame imports), or document the cap next to the format limits and have `import` warn when its output exceeds it.

### TW-B3 — P3: `inspectTile` reports seams backwards

**Area:** `src/scene.js` `inspectTile`. **Status:** reproduced.

The helper flags rows and columns whose first and last pixels differ. Repeating tiles don't need identical opposite edges, and identical edges often cause the visible seam: two touching copies of the same edge column double up.

```js
import { renderProject, inspectTile } from './src/index.js';
const tile = ops => renderProject({ version: 1, name: 't', width: 8, height: 8, palette: { g: '#4a9a4a', k: '#1b1528' }, frames: [{ name: 't', ops: [{ op: 'rect', w: 8, h: 8, color: 'g' }, ...ops] }] });
// A dark line on both edges repeats as an obvious 2px seam, yet reports nothing:
inspectTile(tile([{ op: 'line', x: 0, y: 0, x2: 0, y2: 7, color: 'k' }, { op: 'line', x: 7, y: 0, x2: 7, y2: 7, color: 'k' }])).mismatches; // { horizontal: [], vertical: [] }
// A seamless tile with one short stroke touching the left edge is flagged:
inspectTile(tile([{ op: 'pixel', x: 0, y: 3, color: 'k' }, { op: 'pixel', x: 1, y: 3, color: 'k' }])).mismatches; // { horizontal: [3], vertical: [] }
```

The same false positive appeared on Tidewatch's water tiles. The helper is also unreachable from the CLI and MCP. **Suggested fix:** keep the 3×3 repeat image, which is the useful part, and replace `mismatches` with evidence that means something. For example, report *doubled edges* (identical opposite columns or rows that also differ from their inner neighbours) and *edge contrast* (large colour jumps across the wrap), clearly labelled as heuristics. Expose it as `inspect --tile` and `pixel_inspect { tile: true }`.

### TW-B4 — P3: clipping warnings carry no location

**Area:** `src/core.js` `put()` and `warnings`. **Status:** reproduced.

Every clip anywhere in a recipe collapses into one string, `Some drawing falls outside the canvas and is clipped.`, with no frame, operation path or pixel count. A single stray pixel in one of 12 water frames took manual arithmetic to find. The rest of PixelForge reports exact paths (`project.frames[2].ops[0]`), so this stands out.

**Suggested fix:** keep the deduplicated message for humans, and add a bounded `clipped` list to the render result and the `validate`/`inspect` output, e.g. `[{ path: 'project.frames[2].ops[0]', pixels: 1 }]`.

### TW-B5 — P3, suspected: `SpritePlayer.load` can wait forever on `image.decode()`

**Area:** `src/runtime.js` (the exported `player.js`). **Status:** observed in the game's own loader, which used the same pattern; not reproduced in a normal foreground tab.

In the desktop app's hidden browser pane, `await image.decode()` stayed pending until something forced a paint. The page never finished loading until a screenshot was taken. Switching the loader to `onload`/`onerror` fixed it immediately. Background tabs in some browsers may behave the same way. **Suggested fix:** resolve on `load`/`error` (optionally calling `decode()` afterwards without awaiting it for rendering).

## Missing features

Ranked by how much each cost while building a tile-based game. Each item names the demo need, the workaround used, and a suggested shape for the feature.

### TW-M1 — Tilemaps and autotile authoring

- **Need:** a 40×32 island with water, sand and grass layers.
- **Limits hit:**
  - Scenes allow **256 placement declarations**, but a single 240×160 screen with three tile layers needs about 310.
  - `repeat` only covers uniform rectangles.
  - There is no way to copy a sub-rectangle of a symbol or earlier frame. The standard autotile workflow (draw one small island and one lake, then slice them into 8×8 quarters) can't be expressed.
- **Workaround:** a script sliced hand-drawn masks into 20 quarter symbols, and the recipe composes the 47 blob tiles with stamps. Scene previews repeat a single water variant, and the game engine draws the map itself.
- **Suggestion:**
  - A scene `tilemap` instance: `{ asset, tile: [16,16], rows: ["..~~", ...], legend: { "~": "water-a0" } }`, counted as one placement.
  - A `copy` op that takes a rectangle from a symbol or earlier frame.
  - Optionally a small `autotile` compiler that turns a template into blob or Wang frames.

### TW-M2 — Pivots and free-form per-frame metadata

- **Need:** every prop's ground contact point for y-sorting, a font's glyph advances, and hitboxes.
- **Workaround:** a hand-measured anchor table in `game/src/world.js`; glyph widths measured from exported pixels at runtime.
- **Available today:** only compiled poses carry origins and points.
- **Suggestion:** an optional recipe-level `anchor` with a per-frame override, emitted as the TexturePacker `pivot`, plus a per-frame `points`/`tags` map in the atlas, the same shape the pose compiler already produces.

### TW-M3 — Trimmed atlases and per-frame bounds

All frames share one canvas, and atlases are always untrimmed. Trimming each frame to its visible bounds would shrink the atlas by:

- 75% for the keeper (64,000 → 16,226 px)
- 75% for the slash arcs
- 82% for the effects
- 46% for the crab

The atlas JSON already has `trimmed`, `spriteSourceSize` and `sourceSize`. **Suggestion:** `sheet.trim: true`, keeping the full-canvas origin in `spriteSourceSize`.

### TW-M4 — Shared palettes, palette animation and remaps

- **Shared palettes:** 29 recipes carry copies of one 57-colour palette. There is no include, so the scaffolds copy a subset into each file.
- **Palette cycling:** surf and water animate by per-frame `replace` ops with unique marker colours that never appear in the final art: 564 replace ops across the shore set.
- **Remaps:** colour variants (flowers, a white hurt flash) need duplicated grids.
- **Suggestion:**
  - `palette: { "$file": "palette.json" }`, or a CLI-resolved include.
  - A per-frame `palette` override for cycling.
  - `stamp`/`grid` `remap: { "1": "4" }`.

### TW-M5 — Outline operation

Foliage built from clusters needs one silhouette outline around their union. **Workaround:** 1px-dilated copies of every cluster symbol, stamped in a layer underneath. **Suggestion:** a `layer.outline` colour, or an `outline` op that works from alpha.

### TW-M6 — Scene lighting for whole scenes

`renderScene` only lights assets that ship a normal or emissive pass. In a night preview, terrain, props and characters stay at full daylight while the lighthouse goes dark. I verified this in the exported `scene.png` and in the viewer.

Other scene limits:

- Scene manifests must inline every recipe (the headland review is 544 KB), with no file references.
- The viewer's sliders move only `lights[0]`.
- The clipping warning (`5537 drawn pixels clipped at scene bounds`) does not name the placements.

**Suggestion:**

- Apply ambient light to all assets, treating a missing normal as flat `#8080ff`.
- Allow `{ "$file": "recipes/lighthouse.json" }` asset references, resolved by the CLI.
- Offer per-light controls.

### TW-M7 — MCP coverage and response size

- **Coverage:** MCP exposes the five sprite tools only. Pose compilation, scenes, overlays, `inspectTile` and import are CLI/JS-only, so an MCP-only agent could not have reviewed the Tidewatch scene or compiled the keeper.
- **Response size:** `pixel_render` lists every exported file as an absolute path. For the 188-frame shore recipe that is **40,419 characters** (about 10K tokens) on every render, almost all `frames/*.png`.
- **Suggestion:** add `pixel_compile`, `pixel_scene` and `pixel_import`, and return `{ directory, counts, atlas, sheet, playback }` with the full list available on request.

### TW-M8 — Pose authoring conveniences

Part instances cannot be mirrored, so the left-facing keeper parts are programmatic mirrors of the right-facing ones, with anchors and points flipped by the scaffold.

Overlays are all-or-nothing per base fingerprint. Changing one unrelated frame duration in the crab pose source (`idle-0`, 900 → 950 ms) invalidates a pixel correction on `snap-2`. I understand the design is deliberately conservative. For a pose source under active iteration, though, every edit means re-authoring corrections.

**Suggestion:** `flipX` on pose instances with mirrored anchor and point resolution, and per-frame fingerprints so overlays on untouched frames survive.

### TW-M9 — A game-oriented runtime helper

`SpritePlayer` owns and resizes one canvas per sprite. A game that draws hundreds of sprites into one canvas needs `frameAt(atlas, animation, time)` and `drawFrame(ctx, atlas, name, x, y, { flip })`. Tidewatch wrote its own (`game/src/assets.js`, `render.js`). Exporting the lookup the player already has would help every engine-less web game.

### TW-M10 — Wrap-around translate

`translate` clips. Scrolling tile animations (water, conveyors, clouds) must draw each stamp twice and accept clipping warnings. **Suggestion:** `translate: [dx, dy], wrap: true`.

## Friction and smaller notes

- **Names are unique ignoring case.** This is deliberate, for case-insensitive filesystems, but a font cannot name glyphs `A` and `a`. Tidewatch uses `uA`/`la`/`n0`/`period` plus a separate character map.
- **Null-prototype maps from `compilePoses`.** `symbols` and `metadata.poses` fail `assert.deepStrictEqual` against the same data parsed from a file until they are JSON-normalised.
- **Generator key order.** JavaScript orders integer-like object keys first, so a scaffold that builds frames from `{ A: …, 0: … }` silently reorders the atlas. This isn't a PixelForge bug; a short note in the authoring guide would help generator authors.
- **`inspect` layout.** The contact sheet ignores `sheet.columns`; that's fine, but surprising the first time.
- **Studio.** The studio worked for a 40-frame, 57-part pose recipe. Its onion titles correctly name playback neighbours, including once-only ends.

## Evidence and reproduction

| Check | Result |
| --- | --- |
| `npm test` | 74/74 (68 existing + 6 new Tidewatch tests: recipe validity, compiled pose freshness, export freshness, pass alignment, autotile coverage, headless quest completion) |
| Asset export | 29 recipes → 91 files in about 0.8 s; `--check` compares JSON exactly, PNGs by decoded RGBA and APNGs by frame-control chunks, so zlib differences between Node releases don't cause false failures |
| MCP | inspect 60–80 ms, patch 91 ms, 188-frame render 340 ms; oversized message kills the server (TW-B1) |
| Import | Keeper and normal atlases round-trip losslessly in 64 ms; a rich 256×256 import makes a 2.43 MB MCP message |
| Game | Title → quest → dusk → ignition → night → stats card completed with deterministic stepping; combat, drops, damage, fainting and respawn checked |
| Game cost per frame | Day about 0.7–1.0 ms; night with lighting and beam 5.5–8 ms (desktop Chromium, measured over 60 stepped frames) |

Reproduce:

```sh
npm test
npm run check:tidewatch
npm run play:tidewatch
node bin/pixelforge.js scene showcase/tidewatch/art/scenes/tidewatch-headland-night.scene.json --out output/tidewatch-scene
```

Raw notes, in the order I hit them, are in [findings-log.md](../../showcase/tidewatch/notes/findings-log.md). The self-assessment of the art is in [art-review.md](../../showcase/tidewatch/notes/art-review.md).

## Not covered

The browser pane was hidden for most of the session. `requestAnimationFrame` was throttled and screenshots could be stale, so gameplay checks used the game's deterministic `advance()` hook and canvas captures rather than real-time play. I did not test on a phone, in Safari or Firefox, or with a human playtester. No toolkit source was changed during the first pass; the fixes are summarised in the update at the top.
