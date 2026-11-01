# Baked wave effects

`pixelforge-wave` creates looping interference and portal or shield interiors. Signed radial and directional waves combine **before** palette thresholds are applied, so opposite phases leave cancellation gaps. The result is an ordinary recipe of editable palette grids. The game only plays sprites; it runs no wave calculations.

Start from [`interference.wave.json`](../examples/interference.wave.json) or [`portal.wave.json`](../examples/portal.wave.json). The reviewed scene, comparison and art brief are in [the wave showcase](https://github.com/skulitom/Pixelbolt/blob/main/showcase/waves/README.md).

```sh
node bin/pixelbolt.js preview examples/portal.wave.json --open
node bin/pixelbolt.js compile examples/portal.wave.json --out output/portal.json
node bin/pixelbolt.js render output/portal.json --out output/portal-assets
node bin/pixelbolt.js gif output/portal.json --animation open --out output/portal.gif --scale 4
node bin/pixelbolt.js inspect examples/portal.wave.json
```

The studio opens the wave source, recompiles edits and saves the source as `.wave.json`. Asset exports contain compiled frames. Save the source separately to retain the controls; changes painted into compiled frames do not flow back into the source. Existing files require an explicit `--force` to replace. `share` bakes a wave source into ordinary grids so the current hosted playground can open the link.

MCP: `pixel_help` with `topic: "wave"` returns the schema; `pixel_compile` with `source` returns a revision. Use that revision with `pixel_inspect` and `pixel_render`. JavaScript: `compileWaves(source)` from `pixelbolt/wave` returns `{ recipe, metadata, warnings }`. Shared palette files resolve through the CLI or MCP; the browser-compatible compiler takes an inline palette.

## Small example

```json
{
  "format": "pixelforge-wave", "version": 1, "name": "twin-ripple",
  "width": 48, "height": 32,
  "palette": { "a": "#358f9c", "b": "#66c7bf", "c": "#c6f1d0" },
  "effects": {
    "resonate": {
      "frames": 40, "duration": 60,
      "sources": [
        { "kind": "radial", "at": [17, 15], "wavelength": 10, "amplitude": 0.7, "cycles": 2 },
        { "kind": "radial", "at": [30, 15], "wavelength": 10, "amplitude": 0.7, "cycles": 2 }
      ],
      "mask": { "at": [23.5, 15.5], "radius": [23, 15], "feather": 0.2 },
      "look": { "colors": ["a", "b", "c"], "thresholds": [0.32, 0.72, 1.06] }
    }
  }
}
```

## Controls

| Control | Effect |
| --- | --- |
| `at` | Source position in canvas pixels. Half pixels are allowed. |
| `wavelength` | Distance between bands; increase it for calmer, broader forms. |
| `amplitude` | Contribution to the combined field. More amplitude crosses more colour thresholds. |
| `cycles` | Whole cycles during the loop. Negative reverses motion; zero holds a static field. |
| `phase` | Phase offset in degrees. A 180° offset between otherwise identical sources cancels them. |
| radial `stretch` | Horizontal/vertical shape scale, default `[1,1]`. Use a flatter shape for ground ripples. |
| directional `angle` | Travel direction in degrees: 0 right, 90 down, with positive cycles. |
| `mask` | Elliptical amplitude envelope: centre `at`, x/y `radius`, and inward `feather` fraction. Zero feather clips hard. |
| `look.colors`, `thresholds` | Increasing positive thresholds mapped to palette keys. Values below the first threshold are transparent. |
| `look.negative` | Optional matching palette keys for the magnitude of negative troughs. Otherwise troughs remain transparent. |
| `underlay`, `overlay` | Optional full-canvas grids below and above the moving field. Keep the portal rim, runes and silhouette steady. |

`duration` is milliseconds per frame, default 80; a 40-frame loop at 60 ms lasts 2.4 seconds. The compiler samples the loop without duplicating its endpoint. Change duration for playback speed, or increase frames for smoother sampling. Integer cycles preserve the loop period without crossfading.

For each pixel and source, the compiler evaluates `amplitude × cos(360 × (distance / wavelength − cycles × frame / frames) + phase)`. Radial distance includes stretch; directional distance is the projection along its angle. Sum the signed results, multiply by the mask, then map to colours. Fixed-order arithmetic and Pixelbolt's polynomial trigonometry make the output repeatable. Node and Chromium are checked against the same recipes and RGBA frames.

## Scope and review

This is a compact procedural art tool: **loops only**, at most four sources per effect, up to 128×128 pixels, 4–128 frames per effect, 16 named effects, and 256 frames / 4,194,304 pixels overall. See [the generated schema](../wave.schema.json) for all bounds. Compiler errors identify the field to fix; advisory warnings flag narrow bands and undersampled fast motion. Metadata records each effect's duration and the moving layer's visible pixel count, excluding decorations and transparent palette entries.

The mask fades or clips a field; it does not reflect waves or act as a collision wall. The portal preset includes an opaque backing and stone rim. For a translucent shield, remove that backing, reshape the rim and review the character's silhouette behind it. No shield preset is claimed as separately reviewed.

Review at native size and in the target scene, in motion and across the loop boundary. Avoid bands that become crawling one-pixel noise; prefer broad gaps and a stable outline. Colours come directly from the supplied palette, with no blur or quantization.

There is no fluid/PDE solver, FFT, obstacle handling, one-shot impact, or dependency on a new mathematical proof. For one-shot shockwaves use particle `ring` effects; for flowing water and smoke use the fluid compiler. The useful addition here is inexpensive, controllable interference baked into existing asset exports.
