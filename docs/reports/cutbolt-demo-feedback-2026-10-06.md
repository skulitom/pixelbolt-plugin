# PixelForge feedback from three Cutbolt demos

Date: 2026-10-06. Toolkit: `a5473c6` (0.7.1), CLI only. Tested locally on Windows x64 with Node v24.19.0.

PixelForge supplied all the art for three pieces made with the Cutbolt editing engine:
- **A 172 s narrated effects reel.** It used 22 recipes: the explainer template's Pip and stage, plus a tree, a
  pinwheel, fireflies, a campfire, compiled particle effects, an autotiled pond with palette variants, title plates,
  labels, framed paintings, a night sky, a glow and a bolt icon.
- **Two endless 1080 px GIFs.** The first is a glyph grid from ten recipes: 48 generated sigil tiles of 12
  palette-cycled frames each, a maze background, icon panels, a noise panel and a portrait. The second is a
  vortex made of one chevron tile wrapped into ten rings, plus a core and a glow.

The full demo write-up, including the engine-side findings, lives with the demo outside this repository
(`C:\DEV\CutboltData\demo-vfx-20261006\FINDINGS.md`). This file collects only what concerns PixelForge, as
suggestions; none of it was a blocking bug.

## What worked well

- **Speed and determinism.** Validate, render and inspect of all 22 reel recipes took 5.9 s in total (one Node
  process per command), and every rerun gave the same files.
- **Frame `palette` overrides make a strobe trivial.** The loop flashes between two palettes on every frame. Odd frames
  just override two keys, with no marker colours or second set of drawings.
- **Autotile with `variants`.** A 47-tile pond with three palette-cycled ripple variants came from one 32 x 48
  template. It dropped straight into Cutbolt's tilemap, using the masks and frame names as exported.
- **`pixelforge-fx`.** Looping embers and a spark burst compiled into an ordinary recipe in one step.
- **Errors name their path,** for example `project.frames[4].layers[1].ops[0].rows[3]: all rows must be 10 characters
  wide`.
- **Exports hand over cleanly.** Individual frame PNGs named after their frames worked as a video-editor handoff
  without any conversion.

## Difficulties and suggestions

Ordered by how much time each cost.

1. **Canvases stop at 256 px.**
   - The demos work at 320 x 180 and 270 x 270 logical pixels: a 320 px night sky had to become two mirrored 160 px
     tiles, and the 270 px maze four 135 px frames.
   - A composed frame from the editor cannot come back through `import` either.
   - Since the source-pixel and drawing budgets already bound the work, consider a larger per-canvas limit, at least
     for single-frame backdrops.
   *Status: open.*
2. **GIF export only accepts recipes.**
   - The loop is composed in Cutbolt at 1080 x 1080 (a 270 px scene enlarged four times) and exported as a PNG
     sequence. Turning that into a looping GIF needed FFmpeg (`palettegen`/`paletteuse`, `-loop 0`).
   - PixelForge's GIF writer already has the right rules: exact colours, no dithering, honest timing notes. It could
     take a folder of numbered PNGs plus a frame rate (for example `pixelforge gif-frames <folder> --fps 25`) and apply
     the same refusals, such as over 256 colours or a delay that does not fit 10 ms steps.
   - That would make PixelForge the sharing step for any pixel-art video, not only for its own recipes.
   *Status: done in `0526b02` (`pixelforge gif-frames <folder> --fps N`). On the 48-frame 1080 x 1080 vortex loop (4,345 colours over the loop, 108-122 per frame) it decodes back with 0 differing pixels in 2.9 s, where FFmpeg's palette path was off by one level in places.*
3. **Palette overrides are per frame, so they recolour every use of a key.** The icon panels used key `b` for both
   their border and their art. Swapping `b` and `r` on the strobe frames turned the borders red as well, and the art
   needed its own key. A `palette` (or `remap`) on layers would let a frame recolour one layer.
   *Status: done in `0526b02` (`layers[].palette`).*
4. **Frame copies cannot remap.** `copy` with `from` keeps exact RGBA, so a 2x close-up of an existing pose cannot
   be re-coloured for another palette. The portrait was redrawn with primitives instead. A `remap` on frame copies,
   naming the source frame's palette keys, would allow it.
   *Status: done in `0526b02` (`remap` on frame copies).*
5. **No polygon or wedge operation.** The pinwheel's eight colour sectors were computed outside PixelForge and passed
   in as a 49 x 49 `grid`. A `polygon` (or `wedge`/`arc`) operation would keep such shapes editable in the recipe.
   *Status: open.*
6. **Ordered dither is periodic, which defeats patch trackers downstream.**
   - Cutbolt's stabilizer matches small patches; in the dithered sky every patch also matched itself shifted by one
     Bayer period, failing with a uniqueness margin of 0.01.
   - Usable patches had to be searched for by script.
   - A seeded non-periodic pattern (for example `pattern: {"noise": seed}` thresholded against density) would suit
     natural textures and keep footage trackable.
   *Status: done in `0526b02` (`pattern: "noise"` with a seed).*
7. **Durations in milliseconds against video frame grids.**
   - Cutbolt's strict scene timing needs holds in whole 25 fps frames (multiples of 40 ms).
   - The fx example's 55 and 70 ms durations do not fit, so the demo used 80 ms.
   - `sequence` already resamples correctly, but frame-by-frame handoff does not. An optional `--fps` on `validate`
     that lists off-grid durations, or a frame rate in fx sources that sets whole-frame durations, would catch this
     early.
   *Status: done in `0526b02` (`validate --fps N` reports `frameGrid`).*
8. **Sampled contact sheets alias alternating animations.**
   - `inspect --max-cells 48` on 192 frames picks evenly spaced positions including both endpoints (0, 4, …, 60, 65,
     69, …). For frames that alternate A/B, the sheet switched between showing A frames and B frames partway through.
   - `--frames` needs every name. A `--step n [--offset k]` option, or name patterns in `--frames` (`t*-00`), would
     show "frame 0 of every tile" directly.
   *Status: done in `0526b02` (`inspect --step n --offset k`, and `*`/`?` patterns in `--frames`).*
9. **No radial repeat.** A third piece, a vortex loop, wraps one 40 x 24 chevron tile around ten concentric rings
   (16 repeats per ring, a spiral twist, logarithmic radii). The polar wrap had to be a script that writes each ring
   back as a `grid`. A radial repeat would keep such pieces editable recipes: a symbol or frame copied around a centre
   N times, with a twist, possibly with the pose compiler's RotSprite rotation per instance. `--view tile` was the right
   check for the motif's seam.
   *Status: open.*
10. **The 256 px cap sets the resolution.** The vortex runs at 180 x 180 logical pixels (x6 for 1080), because the
   outermost ring must reach the frame corners at radius 127 and therefore fits exactly in 256 px. A larger cap would
   allow finer rings near the centre.
   *Status: open (see 1).*
11. **A dithered glow does not survive non-integer enlargement.** The radial `dither` glow, scaled 1.5x with
   nearest sampling in the editor, aliased into a checkerboard. A note in the dither docs (scale by whole numbers) would
   save the try.
   *Status: open.*
12. **Minor.**
   - Hand-typed `grid` rows must be exactly equal width; an opt-in pad with `.` would save a round trip.
   - Rendering many recipes means one Node process per command (66 for 22 recipes). A batch mode would help agents
     generating whole sets.
