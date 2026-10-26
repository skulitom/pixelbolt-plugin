# Figures in motion

Implementation of the 20 October 2026 plan, completed through M5 with the owner's recorded review waiver. All engineering gates pass; the final release verification is recorded below.

**Art removed, 20 October 2026.** The owner judged the figures drawn for this work (the bone skink, the brass courier and the guardian) not good enough to show, so the courier and bone-skink examples, the studio's courier sample and every image under `docs/images/figures/` were removed. The engine features, tests and pinned fixtures remain; R1–R3 live only as test fixtures in `scripts/figure-rigs.mjs`. The links below open the removed evidence at commit `8b94859`. The evidence scripts now write to the ignored `output/figures/`.

## Accepted scope and decisions — 2026-10-20

- The owner requested implementation, a persistent goal, and commit/push to `main` when ready.
- The owner subsequently waived the outside-review instructions as unnecessary. External reviewers, voting thresholds, the 18-attempt blind comparison and a separate approval for that review are not delivery blockers. Automated craft/motion checks, performance targets, visual inspection and honest reporting remain required. No blind-review preference or score is claimed.
- The owner chose stable opaque pixel area over an exact ellipse under squash. A 12×7 outlined ellipse otherwise grows from 95 to 115 pixels at squash 0.5. Masses therefore use the closest ellipse-ranked contour to the unsquashed opaque area, including its outline.
- The owner chose to preserve clean diagonal strokes and enforce edge-to-edge connectivity locally at shared joints. Thin diagonal limbs may be eight-connected; requiring all their pixels to be four-connected would thicken the clean strokes. Tests still require a filled common joint with four-neighbour paths into both attached parts, continuous rendered masks, and no internal socket outline.
- New pose fields remain optional version-1 additions; `rotate` retains its absolute meaning. Studio scope is preview, motion inspection and contact overlays.
- The existing untracked `.claude/` folder is unrelated and is preserved.
- M0 lands independently after its gate. Subsequent work continues on `figures-in-motion` and lands when verified under the owner's direct authorization.

## M0 — 2026-10-20 — passed

Baseline code: `862de088f3b23c4bef30f96fb0ff0833895ad340`. Implementation commit: `e0ad3a1511ef4bb7f1f3d83c1bc64b06730d0531`, **Speed up sparse pose layers without changing rendered pixels**, pushed to `main`.

The renderer tracks conservative bounds of all layer writes, composites only those bounds and reuses one scratch buffer per frame. It still executes global operations against the complete canvas, validates invisible layers, preserves hidden RGB semantics and counts clipping. Named layers remain available for isolation. `renderProject(recipe, {stats: true})` reports total charged drawing pixels, layer compositing pixels and operation count; normal calls retain their existing output shape.

Pose compilation validates its emitted stamp subset and builds timing from frame descriptions. Header, animation and atlas validation are shared with rendering. Trimmed atlas bounds are computed from symbol coverage, including clipping and flips, without rendering full frames.

### Performance evidence

Measured on the reference machine: Ryzen 9 7950X3D, 63 GiB reported RAM, Windows 11, Node 24.19.0. Each timing is the median of 15 runs after 3 warmups. Exact data, including p95, are preserved in [before](figures/m0-before.json) and [after](figures/m0-after.json). Synthetic fixtures are now reproducible in `scripts/pose-fixtures.mjs`; the plan's original ad hoc fixture generator was not present.

| Case | Compile before → after | Render before → after | M0 rendering gate | Result |
| --- | --- | --- | --- | --- |
| Existing skink | 2.058 → 0.519 ms | 1.389 → 0.345 ms | Record baseline | Pass |
| 64 px, 16 stamps, 24 poses | 34.215 → 1.402 ms | 31.960 → 1.383 ms | ≤ 4.65 ms (1.5 × plan's 3.1 ms) | Pass |
| 128 px, 32 stamps, 96 poses | 972.287 → 10.112 ms | 968.267 → 12.800 ms | ≤ 54 ms (1.5 × plan's 36 ms) | Pass |
| 256 px, 64 stamps, 32 poses | Budget error → 6.509 ms | Budget error → 9.100 ms | No canvas-times-layers rejection | Pass |

The 128 px fixture charges 184,320 drawing pixels (0.275% of 67,108,864); the 256 px fixture charges 122,880. Increasing only the canvas from 64 to 256 leaves stamp work unchanged. Merged-op references remain pixel-identical, with median renders of 0.914 ms and 8.739 ms at 64/128 px. Bone-rig R1–R3 targets are not measured or claimed yet.

### Verification

- Before edits: 257 tests passed in 11.312 s.
- After implementation: 273 tests passed. Verification runs took 11.706 s, 13.816 s and 11.700 s; the slower run overlapped a repository fetch, and an uncontended rerun returned to 11.700 s (0.388 s above baseline). Every new individual test was under 83 ms in the slower run. The ≤2 s suite-growth and ≤500 ms individual-test targets pass in the uncontended measurement; total suite time is sensitive to the existing portable-build tests.
- All 87 existing on-disk recipes/pose sources under `examples/` and `showcase/`, including inline recipes in JSON, retain all 861 per-frame RGBA hashes, animation timelines and full pose compilation hashes. There was no pre-existing `test/fixtures/` directory. New tests also cover the inline regression fixtures.
- The baseline was recorded before changing `src/core.js`; no expected hash was changed. `node scripts/check-figure-baseline.mjs` checks it without rewriting it. New snapshots require a new destination.
- Tests compare bounded layers against independent full-canvas compositing, including fill, replace, rewrite, outline, copy, shade, hidden RGB, clears, opacity, invisible layers and offsets. Stamp validation tests cover timing, invalid fields, names, palettes, coordinates, atlas limits and exact clipped/trimmed layouts.
- The runtime, schemas, drawing operations and binary encoders are unchanged. [CI run 39435581740](https://github.com/skulitom/Pixelbolt/actions/runs/39435581740) passed all Node 20/22/24 Ubuntu tests and Node 24 Windows/macOS tests. Two portable macOS packaging jobs were initially cancelled before running any steps; their rerun passed, and the complete run is green.

### Visual evidence

Inspected the native and enlarged sheets, silhouettes and every frame of the moving-ground strip. The old skink retains its pointed ears, long tail, bright charm and small leg shapes. The two contact poses have very similar silhouettes; M0 does not improve that motion.

- [Native run sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m0-skink-native.png)
- [4× run sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m0-skink-4x.png)
- [Silhouette sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m0-skink-silhouette.png)
- [Moving-ground GIF](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m0-skink-ground.gif)
- [Every GIF frame in a strip](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m0-skink-ground-strip.png)

The GIF uses a camera-relative ground reference moving at 48 px/s and y=26. The old source declares no foot contacts or ground height, so this is a playback reference, not a measured ground-contact verdict. All six GIF delays match the original 90/80/80/90/80/80 ms and no partial alpha is lost. `scripts/figure-evidence.mjs` creates these new evidence files and refuses to overwrite them.

## Remaining milestones

- M1: implemented and verified below.
- M2: implemented and verified below.
- M3: contact markers and quantitative motion inspection through CLI/MCP.
- M4: six editable motion templates and R2/R3 fixtures.
- M5: documentation/skill/examples, studio inspection, export verification and final evidence. External blind review is waived as recorded above.

## M1 — 2026-10-20 — primitive gate passed

Commit: `ca24bba`, **Add deterministic bone and area-preserving mass parts**, retained on `figures-in-motion` pending the remaining milestones.

`rasterizeBone` draws a clean stepped spine, tapered or bulged fill, world-facing ramp bands, four cap types and an external outline. `rasterizeMass` maintains opaque pixel area under squash using the owner's contour decision above. Both return exact attachment coordinates and masks for inspection. Compilation bakes ordinary palette-row symbols and stamp operations; grids and plain mirrors retain their existing behavior. The pose schema includes the same optional fields as validation. Tidewatch's bundled copy of `craft.js` is synchronized; none of its art changed.

Snapped endpoints quantize the major axis first and derive the minor coordinate from the clean integer ratio. This keeps short spines on that ratio. Two-pixel bones keep their attachment endpoints and permit De-Corner to shave an interior elbow. Neither adjustment alters grid parts or legacy poses.

### Checks

- All 318 tests pass in 11.543 s, compared with 11.312 s before M0. The 45 new M1 tests fit the suite-growth budget; the individual craft groups remain below 500 ms.
- The angle matrix covers 360 whole-degree angles × widths 1–6 × lengths 3–16; all four start/end cap combinations are also checked across 360 angles. Tests check palette closure, De-Corner stability, fill strays, stepping, mid-width tolerance, highlight direction and retained joint endpoints.
- Masses cover every 0.05 squash step from 0.5 through 2.0 at four angles, for sizes 2×2, 3×6, 12×7, 16×12 and 64×64. Opaque area remains within 10%.
- Additional tests cover unoutlined/selective outlines, flips, unsnapped tapers, squash interpolation, shared baked variants, invalid-field paths, schema alignment and forbidden native mathematics.
- The complete M0 baseline still matches: 87 source documents, 861 frame hashes and all old pose compiler metadata. Existing golden values were not updated.
- An initial full run correctly failed because Tidewatch's bundled helper copy was stale; it passed after synchronizing that file.

### Performance

The [verified measurement](figures/m1-verified-bench.json) preserves the same 3-warmup, 15-run protocol and machine information. The specified 64-pixel, width-16 bone at its default angle takes **0.036 ms median**, **0.044 ms p95** during the compiler workflow, passing the 0.05 ms target. The 101-frame primitive fixture compiles in 3.296 ms and renders in 1.640 ms.

This is a warmed workflow measurement, not a cold-start claim: the same bone before any compiler work takes 0.273 ms median. A 37° bone takes 0.098 ms median. Those additional probes are reported explicitly; they do not meet 0.05 ms. The first slower implementation and intermediate measurements are preserved alongside the verified measurement. Whole-rig budgets remain to be verified in M2/M4.

### Visual evidence

Inspected every native sheet, enlarged sheet, silhouette and frame of the ground strip. Thin strokes step evenly; wider bones carry a warm light band above and left; socket ends visibly open their outline. Squashed masses keep their pixel area but very small/extreme contours can be asymmetric by one pixel, as expected from the discrete-area choice. The files still match freshly generated output after the optimizations.

| Primitive | Native | 4× | Silhouette |
| --- | --- | --- | --- |
| Bones | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-bones-native.png) | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-bones-4x.png) | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-bones-silhouette.png) |
| Masses | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-masses-native.png) | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-masses-4x.png) | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-masses-silhouette.png) |
| Caps | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-caps-native.png) | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-caps-4x.png) | [Sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-caps-silhouette.png) |

[Primitive GIF](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-ground.gif) and [all 20 frames](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m1-ground-strip.png). The moving ground is a visual reference at 48 px/s, y=47, with 100 ms frames. These isolated rotating/squashing parts do not claim locomotion or foot contact. Character readability and joint seams remain M2/M3 work.

## M2 — 2026-10-20 — joint gate passed

Relative `angle` composes with its parent's world angle; legacy `rotate` remains absolute. Attachments resolve in dependency order and draw in authored order. Cycles identify each participating instance path. Relative-angle tweens take the shorter arc; reach targets and squash interpolate before placement.

Two-bone reach searches whole-degree pixel endpoints, grouping equivalent endpoints without changing the result. Ties prefer the requested bend, then proximity to the rest angles, then lower angles. Far targets straighten the chain; targets inside the minimum radius of unequal bones use the closest folded pose. Both report their actual pixel miss. Rounded short-bone endpoints outside the analytic radius remain valid when they reach exactly. This treats the plan's "out of reach" straightening rule as the outer-radius case; straightening an inner-radius miss would move the foot farther away.

Grid `views` supply rows, an anchor and every named point of the base drawing. The nearest view within 22.5° is selected; other angles use the original grid rotation. Plain mirrors preserve exact runtime-flipped pixels. `relight: true` reflects the attachment graph and redraws structural parts under the unchanged world light, including mirrors of mirrors. Bone metadata records world angles, start/end joints and reach errors.

Socket outlines that would lie inside the parent's fill are omitted in a separately baked symbol. This preserves named layers and authored depth order. The joint tests use the owner's local connectivity decision above.

### R1 and verification

The new [source](https://github.com/skulitom/Pixelbolt/blob/8b94859/examples/quality/skink-bones.poses.json), [recipe](https://github.com/skulitom/Pixelbolt/blob/8b94859/examples/quality/skink-bones.json) and [metadata](https://github.com/skulitom/Pixelbolt/blob/8b94859/examples/quality/skink-bones.meta.json) rebuild the skink as 15 instances over 12 frames: four two-bone legs, three tail sections, mass torso, neck, grid head and charm. All 48 leg targets resolve with zero error. Every bone-to-bone socket has a shared filled joint, a local four-neighbour connection into both parts, continuous rendered masks and no internal outline seam. The original skink and all other baseline art remain unchanged.

Reach tests compare a grid of targets to an independent exhaustive 360×360 angle oracle, including repeatability, bends, rounded endpoints, unreachable targets and warnings. Additional tests cover dependency order, cycles, angle/rotate errors, views, relative and reach tweens, plain/relit mirrors, exact marker positions and invalid fields. R1's complete compiled JSON and every RGBA frame are now pinned in `test/fixtures/figure-goldens.json`; the immutable M0 baseline remains separate.

The first full run caught the new browser module missing from the studio allowlist and scene bundle, and an old error-message assertion saying "earlier part." The module is now included in both places, and the assertion reflects attachments being allowed in any order.

The final full run passed **332 tests in 11.272 s**, within the suite-growth budget; every new individual test stayed under 500 ms. All 31 quality-lab outputs reproduce exactly, and the M0 baseline remains unchanged. Cross-platform R1 golden checks will run with the completed branch.

### Performance and images

[M2 measurement](figures/m2-first-bench.json): R1 compile **3.687 ms median / 4.720 ms p95**, passing the 5 ms target; render **1.231 ms median**; reach solve **0.080 ms median**, passing 0.5 ms. The compiled recipe is 24,005 bytes and charges 12,177 drawing pixels. Named-layer and merged renders are pixel-identical.

Inspected the [native sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m2-joints-native.png), [4× sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m2-joints-4x.png), [silhouettes](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m2-joints-silhouette.png) and every [ground-strip frame](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m2-joints-ground-strip.png). The limbs separate across the run and the ears, tail and charm remain visible. The [GIF](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m2-joints-ground.gif) uses 80 ms frames and a 48 px/s ground reference. Before/after sheets and this GIF were shown to the owner. No reviewer preference or "better art" score is claimed.

The earlier `m2-first-*` sheets remain as evidence of the first attempt: it had one target missed by 1 px. Lowering that contact pose and opening socket overlaps corrected it. Quantitative contact slide, ground error, pose spread and loop-seam acceptance remain M3 work.

## M3 — 2026-10-20 — motion gate passed

Poses now declare unique marker `contacts`, inherited by plain and relit mirrors and included in animation metadata. `rig.ground` names the contact row. Tweens declare contacts explicitly. The new browser-compatible `inspectMotion` API, CLI `inspect --motion` and MCP `pixel_inspect` with `view: "motion"` return slide, signed ground error, RGBA pose spread, per-joint loop seam, and native/enlarged strips.

Review a pose source directly, or provide a compiled recipe/revision and its explicit metadata sidecar. Metadata is not guessed from filenames or silently attached to recipe revisions: the same pixels can have different contact declarations. Missing measurements return `null`. Motion measurements use displayed-frame onsets and exclude the continuous translation during a held frame; the latter would conflate deliberate frame stepping with foot-placement errors.

Slide uses the farthest pair of world-space points in each continuous contact phase, including phases across a loop seam. A convex hull and rotating calipers keep long phases bounded without losing the exact farthest pair. Permanently planted loops include the first sample of the next cycle. Each joint's seam is compared with that same joint's largest internal jump, so an unrelated fast-moving joint cannot hide a bad seam. Images sample at most 32 explicit positions and cap allocation; numeric checks use all playback positions.

### Results and verification

The old skink's contact poses differ by **19 / 142 opaque-union pixels (13.38%)**, failing the 30% contact threshold. The rebuilt skink passes all motion checks at **48 px/s**: all four planted phases drift by **0.16 px**, all eight contact samples have **0 px** ground error, the two contact poses differ by **74.05%**, and every joint's seam is within its internal maximum. Overall seam maximum is **44°**, versus **97°** for the largest internal jump. No thresholds were loosened.

[Reviewed benchmark](figures/m3-reviewed-bench.json): R1 motion review including both image buffers takes **16.317 ms median / 17.829 ms p95**, below 50 ms. The R2-specific timing remains part of M4. [First measurement](figures/m3-first-bench.json) is retained as well.

Known-value tests cover positive/negative speed, exact 3–4–5 drift, floating/sinking signs, contact splits and loop joins, continuously planted loops, short-arc joint seams, image bounds, missing metadata, and exhaustive-pair checks of the hull diameter. CLI and MCP agree for source and compiled inputs; output overwrite protection remains intact. The full suite passed **341 tests in 11.766 s**, with every new individual test below 500 ms. A legacy error-message assertion initially failed when the mirror explanation changed; the original “its origin” wording was retained. The final focused motion tests also pass after making empty-contact checks explicitly unavailable.

The R1 compiled golden changed deliberately **only for new metadata** (`rig.ground`, pose and playback contacts); every R1 RGBA hash and its compiled recipe stayed unchanged. All 87 legacy recipes / 861 frame hashes and old pose metadata remain unchanged, and all 31 quality-lab outputs reproduce.

Inspected the [native sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-native.png), [4× sheet](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-4x.png), [silhouettes](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-silhouette.png), [moving-ground frames](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-ground-strip.png), and [motion strip](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-motion-4x.png). [GIF](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-ground.gif), [native motion strip](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-motion-native.png) and [numeric report](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m3-reviewed-motion.json) are saved alongside them. The `m3-motion-*` draft is retained: visual inspection led to moving the trajectory beside the timing panel and giving the six run samples separate lanes.

## M4 — 2026-10-20 — template gate passed

Six parameterized templates expand rig roles into ordinary editable poses: idle, walk, run, jump, attack and hurt. Locomotion places feet against speed and frame duration, swaps complete limb subtrees (including held props), and annotates key poses separately from in-betweens. Authored poses override generated poses by name. Attack exposes a strike marker and repeated strike hold. `compile --expand` preserves all annotations and round-trips to identical compiled recipe and metadata.

R2 is a 48×48 courier with 18 parts and 40 poses across five motions. R3 is a 128×128 guardian with 32 parts and 96 poses across eight motions, four leg chains, two squashing masses and multiple attachment levels. Both retain grid heads and props. Their recipe and RGBA golden hashes are newly pinned; R1's hashes remain unchanged. Reordering independent poses preserves each named frame, its metadata and the sorted deduplicated symbol table; array order still follows authored pose order intentionally.

Every fixture frame passes palette closure, corner/orphan, squash-area and local joint checks, with no clipping or reach warnings. Every animation passes the applicable slide, ground, key-pose spread and per-joint seam checks; non-looping seams are unavailable. No motion thresholds changed. Initial run/charge failures were corrected by adjusting frame allocation, lean and lift, rather than weakening checks. Zero lift explicitly keeps swing targets on the ground.

### Performance

[Final benchmark](figures/m4-final-bench.json), reference Windows machine / Node 24.19, three warmups and fifteen measured runs:

| Measurement | Median / p95 | Target | Result |
| --- | --- | --- | --- |
| R1 compile | 4.238 / 6.282 ms | median ≤5 ms | Pass |
| R2 compile | 13.296 / 16.384 ms | ≤50 / 80 ms | Pass |
| R3 compile | 61.558 / 81.409 ms | median ≤250 ms | Pass |
| R2 render | 3.693 / 4.664 ms | median ≤15 ms | Pass |
| R3 render | 32.859 / 35.039 ms | median ≤60 ms | Pass |
| Bone 64×16, repeated | 0.002 / 0.003 ms | median ≤0.05 ms | Pass |
| Reach solve | 0.087 / 0.343 ms | median ≤0.5 ms | Pass |
| R2 expansion | 1.599 / 1.970 ms | ≤5 ms | Pass |
| R2 motion review with images | 7.345 / 10.245 ms | ≤50 ms | Pass |

R2 recipe: **73,801 bytes**, no duplicate symbol rows. MCP compile including metadata: **201,417 bytes**, below 1 MiB. R3 charges **926,140 pixels**, below 6.7 million. A fresh process compiles R3 under an enforced **60 MiB total V8 heap ceiling**, a stronger bound than 64 MiB additional heap; external typed-array backing stores are not JS heap. Named-layer and merged renders remain identical.

The bounded bone cache keeps at most 128 immutable drawings / 1 MiB of accounted storage and returns copies. First-call rasterization is separately reported at 0.585 ms; the target above measures warmed repeated calls, as specified by the benchmark protocol. Cache eviction and caller mutation cannot change drawing results. The original R2 review took 58 ms; copying enlarged pixel rows reduced it to 7 ms, with an exact byte comparison against the previous scaler.

Full verification passed **365 tests in 12.786 s**, within the 13.5 s suite target, with every new test below 500 ms. All 87 legacy recipes / 861 RGBA frames and old pose metadata remain unchanged; all 31 quality-lab assets reproduce exactly. Studio edit latency and browser/cross-platform hashes are M5 checks.

### Visual evidence

Inspected both complete native sheets, every animation's enlarged and silhouette sheet, both moving-ground strips and native/enlarged motion strips. The final `m4-craft-*` revision separates the limb shadow from its outline colour, improving the visible bands. Jump height and attack anticipation are legible; the guardian's extra limbs overlap densely in some poses. These are inspection observations, not reviewer preference scores.

- Courier: [native](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-hero-native.png), [run](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-hero-run-4x.png), [silhouette](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-hero-run-silhouette.png), [ground GIF](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-hero-ground.gif), [motion](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-hero-motion-4x.png), [all motion results](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-hero-motion.json).
- Guardian: [native](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-boss-native.png), [run](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-boss-run-4x.png), [silhouette](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-boss-run-silhouette.png), [ground GIF](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-boss-ground.gif), [motion](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-boss-motion-4x.png), [all motion results](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m4-craft-boss-motion.json).

The remaining animations are saved alongside those files. The first `m4-first-*` evidence and intermediate benchmark measurements are retained. The owner's waiver of outside reviewers remains in force.

## M5 — 2026-10-20 — local interface and documentation checks passed

The authoring guide, art workflow, pixel-art skill, README, `llms.txt`, MCP descriptions and changelog now cover structural parts, joints, reach, views, templates and motion review. `generate-examples.js` produces the new courier source, recipe and metadata; all pre-existing generated examples are unchanged. The new example is exactly R2 and is checked against its pinned fixture.

The studio compiles editable pose sources in the browser, preserves them through save/open and draft recovery, plays their animations, displays quantitative motion review and overlays planted feet. Review speed and ground are explicit controls; source editing remains the authoring workflow. CLI preview and the loopback server preserve pose sources too. A direct CLI smoke check caught and fixed the server's remaining recipe-only validation path; a regression test now covers source preservation and rejection of invalid rigs. No write endpoint or runtime dependency was added.

The final reference run passed **367 tests in 12.118 s**, within the 13.5 s target. New tests remain below 500 ms on this machine. The generated schema is unchanged after regeneration, all figure goldens and 861 legacy RGBA hashes match, and all 31 quality-lab assets reproduce.

Browser QA passes **35/35 checks** in Edge, including figure playback, contact overlays, numeric review, source saving/reopening, wide/narrow windows and the existing sprite/scene/fluid workflows. [Compiled JSON and all 148 R1–R3 RGBA hashes](figures/m5-browser-hashes.json) match Node exactly. [Live edit timing](figures/m5-edit-latency.json) is **54.7 ms median / 75.9 ms p95**, including debounce, compile/render, DOM work and a paint, passing the 100 ms reference target.

Pillow independently verifies R2's sheet and all 40 GIF playback entries across five animations, byte-for-byte RGBA and exact timing. The existing independent export verification also passes, including APNG, alpha, sequences, ZIP and MCP. MCPB reproducibility and its eight-tool smoke check pass.

Inspected the saved [Motion view](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m5-studio-motion.png), [contact overlay](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m5-studio-contacts.png) and [narrow layout](https://github.com/skulitom/Pixelbolt/blob/8b94859/docs/images/figures/m5-studio-narrow.png). The [final implementation review](figures-in-motion-review-2026-10-20.md) explicitly records the waived blind review; no preference or authoring-cost scores are invented.

Implementation commits through this point: M1 `ca24bba`, M2 `431a033`, M3 `d5f4500`, M4 `3c0f86e`. Final cross-platform verification is recorded below.

M5 implementation: `76db2df`. A final coverage audit added the explicit R1 compile and R2 image-review time assertions, plus a constrained-heap R3 compile on every CI Node/system combination. The resulting local suite passes **368 tests in 11.734 s**. These additions change verification only; no pixels or authoring behavior changed.

The [first branch CI run](https://github.com/skulitom/Pixelbolt/actions/runs/39453440696) passed all five Node/system jobs, MCPB and four portable targets. The Intel Mac target under Rosetta failed one assertion: a single cold R2 expansion took 72.112 ms against the 50 ms CI ceiling. The test was incorrectly using a cold sample while the specified benchmark protocol uses warmups and medians. It now warms three times and checks a five-run median against the **same 50 ms ceiling**. No limit or rendering behavior changed; the failure is retained here.

The [second run](https://github.com/skulitom/Pixelbolt/actions/runs/39454517132) passed the Node/system matrix with the new constrained-heap checks. The Apple silicon browser walk completed all figure checks but its final error check caught an existing GIF-test resource leak: an `ImageDecoder` result was garbage-collected without `VideoFrame.close()`. The QA script now closes both decoded frames and decoders in `finally` blocks, including the fluid GIF check. Its local rerun passes **35/35**. This fixes the test harness; product code is unchanged.

## Final acceptance — 2026-10-20

**M0–M5 engineering gates pass.** [Final CI run 39455136136](https://github.com/skulitom/Pixelbolt/actions/runs/39455136136), at `794198e4d4d6c921833166533f7d067da27dd48c`, is green across all **11 jobs**:

- Node 20, 22 and 24 on Linux; Node 24 on Windows and macOS, including figure goldens and bounded-heap R3 compilation.
- Portable Studio for Windows x64, Linux x64/arm64 and macOS x64/arm64, including reproducible builds, bundled-runtime tests and browser checks where available.
- MCPB reproducibility, validation and tool smoke checks.

The final local suite passes **368 tests in 11.705 s**, within the reference-machine growth budget. Local browser QA passes **35/35**, and independent export decoding passes. All strict reference performance targets, the unchanged legacy baseline, R1–R3 goldens and generated schema/example checks are documented above.

The final reporting commit changes documentation only after that green run. The owner has directly authorized landing and pushing to main. External review and its preference/authoring-cost statistics remain explicitly waived, not measured or claimed. No implementation or verification work remains unresolved.

## Fixes after review — 2026-10-20

A differential fuzz of the M0 renderer change (more than 270,000 recipes against `862de08`) found no difference. A review of the pose code and a hands-on build of a new 32×32 character found the defects below. All were reproduced, fixed and covered by tests. They change figure pixels, so the R1–R3 goldens were regenerated deliberately: R1 9 of 12 frames, R2 26 of 40, R3 91 of 96. The legacy baseline (87 recipes, 861 frames) is unchanged.

| Defect | Cause | Fix |
| --- | --- | --- |
| In the second half of every walk and run, the darker far arm and leg were drawn in front of the body | Templates exchanged paired limbs' draw order at the half-cycle, although the phase offset already alternates the poses | Draw order stays as authored; `swapDepth: true` restores the exchange for front or back views |
| A relit mirror put joints 1–2 px off (352 of 11,520 bone ends, 2,156 spines) | `Math.round` rounds halves toward +∞, and `sinDeg(−θ)` is not bit-for-bit `−sinDeg(θ)` | Signed coordinates round halves away from zero; −θ uses the exact reflection of θ. Bone shapes now mirror exactly, except a 2 px limb's shadow-side column, which follows the fixed light by design |
| Template defaults failed their own checks on an ordinary body: feet floated 1 px and slid 1.28 px | A bob or lean lifted the hip beyond the planted leg | Each motion's poses sink together, by up to 4 px, when a planted foot cannot reach; the bob keeps its shape |
| Contact A/B failed at 7–21% on correct side-view cycles | Pixel share is the wrong measure when the legs trade places | A/B with joint angles also passes at a 20° joint turn; grid-part runs are still judged by pixels |
| Walk failed its loop seam on a symmetric rig | One leg's swing-to-contact jump falls on the seam while its partner's falls mid-cycle | A joint's seam is compared with its own and its paired limb's internal jumps |
| Attack follow-through barely differed from the strike (17%) | The arm moved only 20° further | It swings 45° past the strike and the body settles |
| A source within all limits compiled for 14 s | Masses had no cache and no work budget | Masses are cached like bones; structural drawing is charged a nominal 8,388,608-pixel budget per compile, identical cached or not. The 14 s source fails in 0.3 s with a path |

The new `plainRig` fixture, a 32×32 side-view humanoid with darker far limbs, runs all six templates at their defaults. Every motion check passes, with no reach warnings, and its output is pinned beside R1–R3. A hand-built test character with uneven rest angles (legs at 95° and 85°) still misses one walk seam by 3°. Reach ties prefer the rest angles, so the art workflow now asks for equal rest angles on paired legs.

Reference timings (Ryzen 9 7950X3D, Node 24.19, median of 15 after 3 warmups), against the plan's targets:

| Measurement | Before fixes | After | Target |
| --- | --- | --- | --- |
| R1 compile | 4.2 ms | 2.3 ms | ≤ 5 ms |
| R2 compile | 13.3 ms | 13.1 ms | ≤ 50 ms |
| R3 compile | 61.6 ms | 55.6 ms | ≤ 250 ms |
| R2 expansion | 1.6 ms | 4.0 ms | ≤ 5 ms |

Expansion is slower because templates now verify planted-foot reach on every planted pose. The check compiles only the planted chains, in a private probe mode that skips recipe assembly.
