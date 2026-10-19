# Improving PixelForge's art quality

27 September 2026 · Reviewed baseline: `a3f5b58` · Historical recommendations with implementation update below.

## Implementation update

The [Listening Hollow study](../art-quality-lab.md) and [art workflow reference](../art-workflow.md) now provide a concrete, editable implementation across the roadmap's foundations. Version-1 sprite rendering is preserved; poses and scenes use separate compiler/preview formats. Core and runtime remain dependency-free. The three Emberfall reliability findings are resolved with regressions.

| Item | Implemented and demonstrated | Remaining acceptance work |
| --- | --- | --- |
| PF-AQ-01 | Revised skill and brief; original plant, shale, creature, material reaction and room; saved before/after recipes/images with candid review. | Independent randomized preference review, equal-budget repeated attempts and held-out briefs. No claim of Animal Well parity. |
| PF-AQ-02 | Native/silhouette/grayscale views; layer isolation; saved-reference comparisons; bounded diagnostics/timing; pink/cyan onion skins follow expanded playback positions; actual playback route. | Contact-aware foot-slide diagnostics and richer review annotations. Advisory exemptions are documented, not machine-enforced taste rules. |
| PF-AQ-03 | Regional grids/masks, move/recolor, explicit frame/inherited scope, named canvas selections and fingerprinted rebuild overlays. | Automatic conflict rebasing and part-following masks. Changed bases deliberately fail rather than guessing. |
| PF-AQ-04 | Authored part definitions/replacements, local anchors/points, per-pose placements, attachments and expanded marker metadata; stride scene with an integer-sampled trajectory. Added 28 September 2026: parts rotated by any angle into editable symbols, eased tween in-betweens and eased trajectories (see `examples/swing.poses.json`). | Broader motion review and transitions. Metadata exports cues; the game dispatches them. |
| PF-AQ-05 | Bounded scene manifest/viewer, native/value/density review, tile repeats/edge evidence, trajectories, state cues and persistent aftermath. | Shared style manifests, automatic palette-remap previews and larger environment studies. |
| PF-AQ-06 | Lossless 8-bit RGB/RGBA PNG import with CRC/filter checks, provenance and optional unscaled atlas timing metadata. | Native Aseprite, additional PNG encodings and editor metadata adapters; pose anchors remain a separate sidecar. |
| PF-AQ-07 | Aligned color/normal/emissive atlases, hand-authored lantern normals, movable banded lights, unlit fallback and separate CPU benchmark. | Material-mask pass, shadows, fluid/raymarching effects and broader environmental response. |

[Verification evidence](quality-implementation-evidence.json) records functional/browser/independent-decoder checks. These prove specific technical properties, not aesthetic quality. The recommendations and acceptance criteria below remain the target; the initial narrow implementation is not blanket closure of all seven proposals.

This report uses the local Emberfall demo to identify improvements to **PixelForge itself**. Animal Well is a quality reference for expressive pixel art, animation and environmental response. The objective is to help agents produce original work at a much higher standard, not reproduce another game's assets or build more Emberfall content.

## Recommendation

PixelForge should make **designing, evaluating and revising coherent artwork** substantially easier. Its current renderer can already express arbitrary pixel art. The missing support is mostly above the rasterizer: meaningful selections, pose structure, consistent art direction, motion inspection and scene context.

The demo exposed that gap. I authored much of it through shape-generating functions, repeated stamps and small positional changes. That was my authoring choice, not a restriction imposed by PixelForge. The tools successfully exported the result, and I accepted a visual standard that was too low. The current workflow did not make that weakness sufficiently visible or expensive to ignore.

The highest-return changes are:

1. A stronger authoring skill and a small, critically reviewed example collection that teaches silhouettes, connected color shapes and distinct action poses.
2. Inspection that helps an agent evaluate native-size readability, motion and scene integration.
3. Compact editing of named regions and body parts, with precise control over which frames receive a correction.
4. Pose authoring with attachment points, authored replacements and motion timing.
5. Scene and material support after those foundations work.

Additional ellipses, polygons, random texture, generated frames or glow would not by themselves establish a higher art standard. No proposed feature guarantees Animal Well quality; that claim would require convincing finished examples and independent visual review.

## What the benchmark actually asks of the toolkit

Animal Well's appearance includes work beyond ordinary sprite sheets. In his 2022 development article, Billy Basso describes manually drawn normal maps, layered lighting, raymarched background effects, a fluid simulation with colors constrained to fit the artwork, and a modified Aseprite workflow that reloads changes into the running game. This is a published development account, not an audit of every technique in the released game. [Developer's technical account](https://blog.playstation.com/2022/07/20/how-animal-well-taps-into-ps5-hardware-to-elevate-2d-pixel-art-platforming/).

For PixelForge, my inference is that the useful target has three parts: excellent individual images, convincing changes over time, and a coherent scene in which light and actions affect the environment. PixelForge can support all three without becoming a complete game engine. Static exports alone cannot demonstrate the whole result.

“Organic” also needs a more useful definition than “irregular.” A plant should have a believable growth structure; a creature should have connected anatomy and weight; stone should have intentional planes and wear. Uncontrolled noise can make all three less convincing. Simplicity is compatible with strong art. The target is deliberate shape, material and motion, not maximum detail.

## Findings from the current project

These are local source and image observations. The quality judgments are mine; the numerical audit is separately reproducible.

| Observed limitation | Local evidence | Implication for PixelForge |
| --- | --- | --- |
| Large forms still reveal their primitive construction. | The crawler uses nested ellipses; mushrooms use ellipse caps and straight stems; vegetation repeats regular leaf patterns in [the generator](../../scripts/build-emberfall.mjs). See [woodland](../../demo/assets/woodland/contact.png) and [wayfarer](../../demo/assets/wayfarer/contact.png). | Make silhouette and connected-color-shape editing easier than adding another primitive or sprinkling pixels. |
| Much animation moves existing pieces without redesigning the pose. | `knightPose` reuses armor and helmet grids; run legs follow a sine-derived offset. The Warden's idle has two distinct images across six frame entries. See [knight](../../demo/assets/knight/contact.png) and [Warden](../../demo/assets/warden/contact.png). | Support authored contact, compression, extension, anticipation and recovery poses; avoid making automatic translation the default answer to animation. |
| Different materials share a visual formula. | Ember, frost and storm projectiles/impacts are generated from the same geometry with different palettes. Impact particles occupy eight equally spaced directions. See [spellcraft](../../demo/assets/spellcraft/contact.png). | Examples and effect authoring need different shape and timing behavior for each material, not just color variants. |
| Export counts overstate what they say about motion. | All 220 frames render, but there are 181 distinct RGBA images when uniqueness is counted within each of the nine recipes. Sentinel: 6 entries / 2 images; rune: 8 / 2; fern: 4 / 2. [Audit data and method](emberfall-art-audit.json). | Report useful diagnostics alongside frame counts. Duplicates are not automatically defects: repeated poses and holds are legitimate. Pixel differences alone also do not prove different body poses. |
| The scene weakens otherwise crisp source pixels. | [The demo renderer](../../demo/game.js) uses sprite scales such as 0.82, 1.32 and 0.92, reuses translucent scenery, and places props in regular loops. [Current scene](../../demo/preview.png). | Add scene inspection and integration guidance. This is a demo renderer choice: PixelForge's own export scaling and bundled player already require integers. Nearest-neighbor filtering alone does not preserve uniform pixel sizes under fractional scaling. |
| The agent's visual feedback emphasizes spatial layout over time. | [MCP inspection](../../src/mcp.js) returns a static PNG sheet. APNG and browser playback already exist, but they are separate from that inline response. | Give motion review an explicit, low-friction route rather than equating playback-order contact sheets with watching animation. |
| Generator-driven authoring makes late corrections fragile. | `npm run art:emberfall` intentionally regenerates the saved recipes and assets. A correction made only to an exported recipe is lost on regeneration. [Demo workflow](../../demo/README.md). | Provide a supported authored-source/patch-overlay workflow with explicit rebuild provenance. This is integration friction, not a silent-overwrite bug in PixelForge's core. |

The [original stress report](../bugreports/emberfall-stress-test.md) remains useful evidence of export correctness and workload handling. Its passing tests and desktop frame-rate measurements do not establish artistic quality.

## Capabilities to preserve

PixelForge already has exact pixel grids, reusable symbols, layers, palette edits, frame inheritance, per-frame durations, reverse/pingpong sequences, regional readback, atomic targeted patches, exact canvas-coordinate corrections, visual diffs and persistent MCP revisions. The studio already offers playback, integer zoom, a grid and basic onion skinning. [Authoring reference](../agent-guide.md), [patch implementation](../../src/patch.js), [studio implementation](../../studio/studio.js).

Those are valuable foundations. Recommendations below extend them; they are not claims that PixelForge lacks pixel editing, animation or inspection. Keep the dependency-free core, text-editable source, deterministic output and small agent tool surface.

## Prioritized product changes

Priority means implementation order for this quality goal, not bug severity. Effort is relative: **small** is a focused addition, **medium** spans several interfaces, **large** needs a new authoring concept and export contract. These are scope estimates, not delivery promises.

### PF-AQ-01 — Teach and demonstrate a stronger authoring process

**Priority 1 · small documentation change; substantial art curation work.**

The current [skill](../../skills/pixel-art/SKILL.md) already says to inspect and fix silhouettes, color and timing. Its [guide](../agent-guide.md) mainly explains how to express operations. Add worked examples showing *what a good correction looks like*: a primitive blockout becoming a connected silhouette, noisy texture becoming deliberate clusters, and a sliding walk becoming distinct weighted poses.

Introduce a short, reusable art brief: intended display size, silhouette landmarks, palette roles, light direction, material rules, outline treatment and action intent. First keep this as an authoring sidecar; do not invent unsupported fields inside a version-1 recipe. A later style manifest could share those choices across assets without silently recoloring them.

The skill should lead agents through silhouette → large color groups → material accents → key poses → timing → scene review. Each stage should produce evidence and a recorded judgment before mass-generating variants. Repeated inspection is not enough if the criteria remain “it rendered” and “all frames exist.” These are quality checkpoints, not mandatory user permission prompts.

**Acceptance:** publish a small set of original, reviewed assets with annotated before/after recipes and specific correction instructions. Under an equal authoring budget, agents using the revised guide should produce work that reviewers prefer over the current workflow. Record failures as well as successful examples.

### PF-AQ-02 — Make inspection answer visual questions

**Priority 1 · medium.**

Extend `pixel_inspect` rather than introducing many separate tools:

- Native-size and enlarged views together, with optional silhouette-only and grayscale views. A silhouette-only view means one solid color for visible pixels, so interior detail cannot conceal a weak outline.
- Layer/part isolation and overlays, plus comparison against a saved reference revision at the same origin, scale and background.
- Animation review with labeled holds, loop-boundary comparison, adjacent-frame overlays and a clear link to actual playback. When a client cannot display animation inline, provide a timing strip and bounded sampled frames; do not describe those as a substitute for playback.
- Advisory findings for duplicate images, empty frames, isolated pixels, palette growth and possible loop discontinuities. Include affected coordinates and exemptions. Clipping warnings already exist.

Do not make a “beauty score” or automatically delete stray-looking pixels: eyes, sparks and stippled surfaces may rely on them. Bounds and pixel differences also cannot reliably detect foot sliding unless the author supplies foot/contact landmarks.

One specific studio issue deserves attention: onion skinning currently draws `frameImages[selected - 1]`. That is the previous frame in recipe order, not necessarily the previous pose in the selected animation. A sparse sequence, reverse playback or pingpong can therefore show the wrong comparison. This is established by source inspection; browser reproduction was not performed in this review. Resolve neighbors from the animation's playback position, including repeated entries, and offer separately tinted previous/next overlays.

**Acceptance:** an agent can identify and correct a deliberate silhouette break, palette inconsistency and loop jump using returned evidence. A reverse sequence and a sequence that skips a recipe frame show the correct onion neighbors. Legitimate repeated holds remain valid.

### PF-AQ-03 — Edit coherent regions and preserve them through revisions

**Priority 1 · medium to large.**

Exact painting currently accepts coordinate/color entries on the final flattened frame. This is precise, but reshaping a leaf cluster or an arm requires many coordinates, and a final-canvas correction has no semantic connection to a moving part.

Add compact rectangular grid patches, named selections and masks, plus operations to move, replace or recolor only that selection. Specify preservation and erasure separately: the existing grid's dot means “skip,” so a patch must not silently reinterpret it as “erase.” Keep named regions stable across revisions and distinguish canvas-local from part-local coordinates.

Provide explicit edit scope: this frame, a named set of frames, a shared symbol, or inherited dependents. Show the propagation before saving and report the changed pixels afterward. Support reusable authored correction overlays that can be reapplied after a generator run, with a base fingerprint and conflicts when the target moved or disappeared. Reapplying old coordinates blindly is not safe.

A polygon or bounded path operation would reduce the demo's scanline boilerplate, but it is secondary. It should rasterize deterministically, expose its resulting pixels, and permit local correction. More convenient curves cannot choose good contours for the author.

**Acceptance:** reshape a fern tip and keep the stem unchanged; move a forearm without losing a highlight correction; rebuild a generated base without dropping approved corrections. The agent should send a bounded regional edit, not a replacement full recipe, and retain a usable undo point.

### PF-AQ-04 — Add pose structure without forcing puppet animation

**Priority 2 · large; depends on regional editing and inspection.**

Symbols are grids and layers have positional offsets; neither currently defines anatomy, pivots, attachment points or relationships between poses. Introduce named parts, an origin/ground anchor, attachment points and per-pose placement. Allow a part to use a newly drawn shape in each pose. An elbow bend or foreshortened hand should not have to be approximated by rotating the same stamp.

Start with integer key poses and explicit timing. Secondary movement can use bounded, deterministic helpers, but generated in-betweens should bake to editable frames. Arbitrary rotation/interpolation needs a pixel cleanup stage; it must not silently introduce smoothing or assume every limb should move on a sine wave.

Add optional semantic markers such as foot contact, spell release and impact. Export their timing and attachment coordinates with a documented coordinate convention. PixelForge can preview and export these cues; the consuming game remains responsible for collisions, damage and physical simulation.

Show the character against a moving floor or author-provided trajectory so the author can compare movement speed with the stride. Inspect transitions as well as loops: run → stop, jump → fall and impact → recovery. Increasing the number of images cannot repair a missing anticipation pose.

Aseprite's documented timeline, cels, tags and per-frame timing provide a useful workflow reference; its slice metadata demonstrates an existing interchange concept for named regions and pivots. PixelForge already handles frame timing, so the new work is semantic structure and easier revision. [Animation documentation](https://www.aseprite.org/docs/animation/), [slice documentation](https://www.aseprite.org/docs/slices/).

**Acceptance:** create a readable run and cast sequence; adjust stride timing without redrawing every limb; keep a held object attached through pose changes; replace a hand pose and inspect every affected frame. Exported markers agree with the selected frames at loop boundaries and at different playback rates.

### PF-AQ-05 — Review assets as a set and in a small scene

**Priority 2 · medium to large.**

Introduce a bounded scene-preview manifest referencing existing recipes: placement, depth order, camera, background palette and chosen animation. Keep this distinct from sprite recipes and from a game engine. Larger rooms should compose small assets rather than require lifting all current resource limits.

Add repeated-tile previews, edge/corner and transition arrangements, and a way to distinguish tile variants from temporal animation. Provide a shared palette/style view with per-asset exceptions. Include a pixel-density overlay and warnings for fractional sprite scaling, while allowing intentional effects and responsive display policies.

Use scene fixtures to compare foreground readability, background value separation, terrain repetition, collision-surface visibility and overlapping silhouettes. Support authored distant variants rather than treating opacity reduction and arbitrary scaling as universal depth tools. A palette-remap preview can test this before committing edits.

Environmental state previews should assemble before → reaction → settled-result sequences. A burned plant, freezing flame or shattered crystal needs a coherent material response and aftermath. The toolkit should help author and align those assets; it does not need to own the world's state machine.

**Acceptance:** inspect a short room with a character, plant, ground and light source without writing a custom renderer first. Expose one seeded tile seam and one inconsistent pixel scale. Preview an impact at its attachment point followed by a persistent changed prop. Save the scene settings so comparisons are reproducible.

### PF-AQ-06 — Allow refinement outside PixelForge to return cleanly

**Priority 2 · medium to large; stage format support.**

Add optional image/editor interchange so a skilled person or another authoring tool can refine a difficult silhouette and return it to the same deterministic pipeline. Start with a clearly bounded PNG import format and documented sprite-sheet metadata, then an optional Aseprite adapter. Do not require an external editor, paid service or image model for the core workflow.

Default to lossless pixel preservation where the input fits supported limits. Quantization, resizing, frame slicing and alpha changes must be explicit and show a before/after result. A raster import cannot reconstruct the original drawing operations; represent it honestly as editable grids or raster layers and preserve its provenance. Define which source becomes authoritative so the next build does not overwrite the refinement.

**Acceptance:** a supported native-resolution RGBA image survives import/export with identical pixels, frame timing and anchors survive the supported metadata path, and unsupported formats fail clearly. A human correction can re-enter an agent revision workflow without requiring a redraw from prose.

### PF-AQ-07 — Add aligned material passes and optional lighting previews

**Priority 3 · large; after base art and scene review improve.**

Support optional color, normal, emissive and material-mask passes, all sharing frame names, duration, origin and atlas layout. These have distinct purposes: surface direction, self-emitted light and material selection. Export their alignment contract and keep an ordinary color-only fallback.

Provide authoring aids and a small optional lit preview with movable lights. Normal maps need intentional surface orientation; generating them from brightness alone will not reliably describe a leaf, face or beveled stone. Do not interpret the RGB values of a normal map as ordinary palette colors or run color quantization on them.

Treat water, smoke, foliage response and light propagation as optional runtime examples or integrations. Begin with bounded, stylized responses and measured browser performance. A custom fluid solver or raymarcher is not the first prerequisite for better PixelForge artwork.

**Acceptance:** a single original prop reads consistently under two light directions, its emission remains aligned throughout animation, and the unlit export remains useful. Benchmark the optional preview separately from the current atlas renderer.

## Suggested delivery sequence

| Stage | Concrete deliverable | Decision before expanding scope |
| --- | --- | --- |
| **1. Establish a visible quality baseline** | Revised skill; a small set of annotated original assets; silhouette/native-size inspection; timing review; corrected animation-aware onion behavior. | Does the new workflow produce better silhouettes and motion under the same agent/time budget? |
| **2. Make good corrections cheap** | Regional grid patches and masks; named parts/anchors; explicit propagation; rebuild-safe corrections; basic scene/tile preview. | Can an agent maintain identity and material consistency while revising a related asset set? |
| **3. Extend the production pipeline** | Editor interchange, aligned material passes and an optional lighting/reaction example. | Do these additions improve the already-good base artwork enough to justify their complexity? |

Fix the confirmed reliability bugs in the [stress report](../bugreports/emberfall-stress-test.md) alongside this work. They are separate from the cause of the primitive-looking art. Preserve current version-1 rendering behavior; introduce new authoring features through an explicit schema evolution or a compiler layer that lowers to existing recipes. Keep validation, schema, documentation, CLI, MCP and studio behavior aligned.

## How to test whether PixelForge actually improves

Use a small **art-quality benchmark**, separate from the throughput stress test. Create original fixed briefs for a plant/rock/ground set, a creature with idle/run/cast poses, and a material reaction with a persistent aftermath. Finish with one compact room combining them. Keep native dimensions, display size, palette constraints and allowed authoring time constant between workflows; do not reward raw frame count.

Compare the current toolkit and each candidate improvement using the same agent model and several independent attempts per brief. Record tools, model/settings, instructions, tokens, elapsed time, revision count, manual help and unrequested pixel changes. Use an ablation where practical: better instructions alone, then better editing/inspection tools. This distinguishes improved guidance from actual tooling value. Keep separate briefs out of the worked examples so memorizing a sample is not mistaken for general ability.

Review paired results in randomized order at native display size and enlarged view, both still and playing. Ask the user and, where available, experienced pixel artists to assess:

| Dimension | Evidence to look for |
| --- | --- |
| Shape | Readable silhouette, connected anatomy or growth, purposeful asymmetry and negative space. |
| Pixel craft | Deliberate connected color shapes, clean contour rhythm, useful accents rather than arbitrary noise. |
| Material and light | Distinct surface treatment, consistent light direction and restrained highlights. |
| Motion | Clear action poses, weight, timing, contact, secondary motion and intentional loop/transition behavior. |
| Set consistency | Stable character identity, coherent pixel scale, palette relationships and readable scene hierarchy. |
| Environmental response | Cause, contact, reaction and aftermath agree spatially and over time. |
| Revision cost | A requested correction is easy to express, preserves unrelated work and survives the next build. |

Store the actual assets and review reasons, not only averages. Automated checks can verify determinism, boundaries, alignment, timing and exact edit scope; they cannot certify taste or organic form. A persuasive next demonstration is one excellent, editable asset set made through the improved PixelForge workflow. Hundreds of exported frames are evidence of a different capability.

## Evidence and limits

Reviewed the saved demo scene and contact sheets, generator, core recipe format, patching, MCP responses, studio, player, authoring instructions and existing reports. Frame uniqueness was measured by hashing full rendered RGBA buffers; [the audit](emberfall-art-audit.json) records recipe hashes and per-animation counts. It does not measure perceived similarity, animation quality or translation-compensated motion.

Animal Well's technical account and Aseprite documentation are first-party references linked beside the relevant claims. Recommendations and effort assessments are design judgments, not measured improvements or promises of feature parity. No Animal Well assets were imported. This report and its evidence were added locally; no hosting or publication was performed, and no proposed toolkit feature was implemented during this review.
