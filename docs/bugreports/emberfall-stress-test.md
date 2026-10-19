# Emberfall: PixelForge stress test and bug report

Date: 2026-09-27. Toolkit baseline: `092b457` (0.1.0). Tested locally on Windows x64, Node v24.19.0, AMD Ryzen 9 7950X3D. Browser QA used headless Chromium 145.0.7632.6 with a 1440×1080 viewport and a separate 390×844 mobile viewport.

**Historical outcome at the baseline:** PixelForge successfully produced the complete playable Emberfall corpus: nine recipes, 220 frames and 44 named animations. Two toolkit bugs were reproduced, plus one preview/export workflow limitation. The reproductions below describe that original behavior. The demo is local only; deployment and publishing were deferred at the user's request. No remote issue was created.

**Resolution update, 27 September 2026:** PF-EF-001, PF-EF-002 and PF-EF-003 are fixed with regression tests. The updated stress harness requires all three corrections to pass and writes each run to a unique folder. It still validates nine recipes, 220 frames and 44 animations; its verification run reports 15 checks and zero findings. [Implementation evidence](../reports/quality-implementation-evidence.json) and the [art workflow](../art-workflow.md) distinguish reliability checks from artistic acceptance.

## Verified results

Visual quality is reviewed separately in the [PixelForge art-quality roadmap](../reports/pixelforge-art-quality-roadmap.md), with proposed improvements to the toolkit's authoring, inspection and animation workflows. Export correctness and frame counts do not establish artistic quality.

| Workload | Observed result |
| --- | --- |
| Baseline toolkit suite | 46/46 passing |
| Toolkit plus new gameplay checks | 50/50 passing |
| Demo exports | All nine recipes validate via CLI; every bundle file is byte-identical across two consecutive exports |
| Source/artifact consistency | Saved atlas metadata and PNG bytes match freshly rendered recipes |
| Independent decoder | Python/Pillow and ZIP reader verify all nine bundles, 220 individual frames, 44 APNGs, 220 animation frames, exact timing, loop flags and RGBA pixels |
| Maximum source-area workload | 256 frames at 128×128 = 4,194,304 source pixels; 4,194,304-pixel atlas; 2082×2082 contact sheet; export and inspection completed in 1,261.89 ms |
| Large revision comparison | All 256 changed frames reported; the image explicitly reports 240 omitted preview rows |
| Actual MCP transport | Validate → paint → process restart → regional palette-grid inspection → render succeeds using the persisted revision; all 33 knight frames returned in render preview |
| Canvas painting | One correction propagates through the base knight frame and three inherited hurt poses; original source stays unchanged |
| Invalid-input guards | Oversized canvas, frame count, source area, atlas size, unknown fields, nulls, reserved output names and case collisions rejected with diagnostics |
| Browser functional QA | 15 scenarios pass with zero page/console errors; includes full guided traversal and boss/portal victory, fullscreen, sound and actual mobile touch input |

The horizon intentionally draws mountain contours past its canvas edge and receives the documented clipping warning. The other eight recipes have no clipping warnings.

Per-recipe export measurements were 14.60–85.44 ms in this run. These are local measurements, not performance promises. Raw evidence is in [emberfall-evidence.json](emberfall-evidence.json).

Real-time browser measurements (manual `advanceTime` was **not** used):

| Extra animated sprites | Sample | Average FPS | 95th percentile frame interval | Atlas draws at sample end |
| --- | --- | --- | --- | --- |
| 0 | 3.513 s | 60.1 | 16.8 ms | 104 |
| 160 | 3.510 s | 60.1 | 16.7 ms | 263 |
| 400 | 3.508 s | 60.2 | 16.8 ms | 504 |

This measures the demo's custom Canvas atlas renderer on one desktop, not PixelForge's `SpritePlayer` at hundreds of instances. Mobile layout/input were checked, but mobile hardware performance, Safari and Firefox were not benchmarked. Runtime particles are bounded at 1,200 and effect animations at 140. Drawing-call counts include atlas sprites, not particle rectangles.

## PF-EF-001 — P2: valid recipe overflows the ZIP32 entry count

**Status:** fixed. **Area:** `src/export.js` (`createBundle`, `createZip`), studio ZIP export.

The renderer now preflights animation count + frame count + 7 support files against 65,535 before drawing. Schema and documentation describe the budget. `createZip` independently preflights count, filename byte lengths and total ZIP32 bytes before CRC/buffer work. Tests and Python's independent ZIP reader verify 65,535 entries; 65,536 fails with `PixelError`.

A 1×1 recipe with one frame and 65,528 animations passes validation and the animation-pixel budget. Its compact request is 1,692,748 bytes, below the studio's 2 MiB request cap. `createBundle` completes, producing 65,536 files. `createZip` then fails when writing the ZIP32 16-bit entry count:

```text
RangeError: The value of "value" is out of range. It must be >= 0 and <= 65535. Received 65536
```

The measured export-plus-failure time was 2,758.97 ms. This is an extreme boundary workload; ordinary demo exports are unaffected.

Reproduce from the repo root with Node's module mode:

```js
import { createBundle, createZip } from './src/export.js';
const recipe = {
  version: 1, name: 'zip-limit', width: 1, height: 1,
  frames: [{ name: 'p', ops: [{ op: 'pixel', color: '#fff' }] }],
  animations: Object.fromEntries(Array.from({ length: 65528 }, (_, i) =>
    [`a${i}`, { frames: ['p'] }]))
};
const bundle = await createBundle(recipe);
console.log(bundle.files.size); // 65536
createZip(bundle.files);       // RangeError
```

**Expected:** either support the resulting archive, or reject the resource limit early with a `PixelError` describing the animation/file-count budget. Avoid building all PNGs and ZIP buffers before rejecting.

**Cause:** `animations` has no count cap; the pixel budget permits many tiny animations. ZIP entry counts use `writeUInt16LE(files.size)` without a preflight limit.

**Suggested fix:** add an explicit archive-entry preflight to `createZip` and an early bundle/animation budget aligned with schema and documentation, or implement ZIP64. Regression checks should cover 65,535 versus 65,536 entries and early failure with an actionable message.

**Workaround:** split exceptionally large animation collections into multiple recipes/bundles.

## PF-EF-003 — P3: stamp symbol accepts an array instead of a string

**Status:** fixed. **Area:** `src/core.js`, `drawOps` stamp lookup; schema/runtime consistency.

Stamp lookup now requires a string before accessing the symbol map. Arrays, numbers, objects and booleans fail at the exact `.symbol` path; valid strings retain their existing behavior. Operation names also reject array coercion.

```js
import { renderProject } from './src/core.js';
const result = renderProject({
  version: 1, name: 'probe', width: 1, height: 1,
  palette: { x: '#fff' }, symbols: { dot: ['x'] },
  frames: [{ name: 'p', ops: [{ op: 'stamp', symbol: ['dot'] }] }]
});
console.log([...result.frames[0].data]); // [255, 255, 255, 255]
```

**Expected:** reject `symbol: ["dot"]` at `project.frames[0].ops[0].symbol`; the schema and authoring format require a string.

**Actual:** lookup `symbols[op.symbol]` coerces the array to the property key `dot`, and the malformed instruction renders successfully. A schema validator and the renderer disagree, allowing an agent's wrong field type to go unnoticed.

**Suggested fix:** check that `op.symbol` is a string before lookup, then retain the existing unknown-symbol diagnostic. Add tests for arrays, numbers, objects and booleans alongside a valid string reference.

**Workaround:** run schema validation in addition to rasterizer validation, or use explicit string references.

## PF-EF-002 — workflow limitation: an optional preview blocks a valid MCP export

**Status:** resolved. The original report was a resource-limit/UX observation, distinguished from the two bugs above.

`pixel_render` now bounds its preview with evenly spaced samples including endpoints, and reports original positions plus total/shown/omitted counts. The 1,024-entry reproduction exports completely while showing 256 cells and explicitly omitting 768 preview cells. A `playback` path points to the full animation preview. Core inspection still rejects unbounded oversized sheets; `maxCells` is an explicit sampling option for separate inspection.

Create a 128×128 project with one frame `p` and animation `hold` containing `Array(1024).fill('p')`. This meets the 1,024-reference limit and uses 16,777,216 animation pixels, below the 67,108,864 export budget. `createBundle(recipe)` succeeds.

Call MCP `pixel_render` with `{ project: recipe, animation: 'hold' }`. The request returns `isError: true`:

```text
inspect: the contact sheet would be 4162×4162 pixels, above the 4096-pixel limit;
select fewer frames, a smaller region or a lower scale
```

The 4096-pixel inspection guard works as documented. The workflow problem is that `pixel_render` couples export success to preview generation, and its arguments do not expose the suggested frame selection, region or scale options.

**Suggested improvement:** export the valid bundle and provide a sampled/paginated preview with explicit omitted-count metadata, or make the diagnostic recommend the available workaround.

**Historical workaround:** omit `animation` from `pixel_render`, then inspect a smaller selection separately. This is no longer necessary for successful export, though narrower inspections remain useful for detail omitted from samples.

## Reproduce the complete run

```sh
npm test
npm run stress:emberfall
python scripts/verify-emberfall.py
npm run play
```

With Playwright installed separately, run `scripts/qa-emberfall.mjs` and `scripts/benchmark-emberfall.mjs` as described in [the demo README](../../demo/README.md). The stress harness has bounded inputs and writes reports and MCP revisions under ignored `output/emberfall/stress/`. Reported bugs do not fail that exploratory harness; they are captured as findings.

## Demo-specific corrections during QA

- Replaced rounded tree clusters and repeated brick-like soil with connected foliage, roots, stones, ivy, carved masonry and foreground props.
- Corrected enemies facing away from the player.
- Made mobile controls visible at narrow widths as well as on coarse-pointer devices.
- Verified charged fire, frozen braziers, thawing, persistent destruction, checkpoint death/retry, boss gating and victory with deterministic simulation checks.

Remaining product scope: this is one short level, not a complete campaign. Guided mode intentionally prevents player damage; use ordinary play to assess combat difficulty. Browser compatibility and touch ergonomics still need real-device playtesting before a public release. Hosting remains deferred.
