# The Listening Hollow — original art brief

- **Intent:** an alert lantern-carrying skink at a cold spring, with an abandoned listening shrine beyond it. Quiet curiosity, then one sharp material reaction. Original shapes; no game assets imported.
- **Canvas/display:** room 224×128; native assets at 1 source pixel per scene pixel; review at 1× and 3×. Character 32×26 with transparent margins; color output is not resampled fractionally.
- **Landmarks:** forked crest, long tapered tail, pendant lantern. The plant has an offset central stem, asymmetric fronds and visible gaps; shale has a broad upper plane and one diagonal fracture.
- **Palette:** navy occlusion (`k/v`), slate planes (`b/s`), teal/green growth (`t/g/h`), warm creature (`a/r/p`), restrained yellow/cream (`y/w`), cold water/crystal (`c/d`). The brightest warm pixels belong to the creature and lantern. Exceptions: normal-map values encode direction rather than color.
- **Light:** weak cool overhead light; lantern accent from the upper left. Highlights group on exposed upper planes. Normal/emissive passes are demonstrated on the lantern only; the rest is authored color.
- **Materials:** branching clustered leaves; layered shale; interrupted vertical water ribbons with a horizontal pool; crystal fault, flash, separated fragments, then persistent debris. No evenly spaced radial particle burst.
- **Motion:** authored run contact/compression/passing shapes, a short blink hold, anticipation/release/recoil/recovery. The charm attaches to a body grip. Source cue positions do not implement game events.
- **Exemptions:** eye and small luminous accents may be isolated. Idle/recover repeat a resting shape intentionally. The canopy extends four pixels beyond the left edge, intentionally clipping 11 drawn pixels in the scene. The room resets its state demonstration after four seconds; that reset is a scenario restart, not a seamless world-state loop.
- **Authority:** `scripts/build-quality-lab.mjs` generates these study sources intentionally; `fern-correction.json` is applied to the exact generated fern base. Rebuilding requires `--force`; `--check` compares without writing. For independent art, copy the source to a new location and make that copy authoritative.
- **Review:** see `docs/art-quality-lab.md`. This is one self-reviewed attempt, not a blind comparative trial or proof of Animal Well parity.
