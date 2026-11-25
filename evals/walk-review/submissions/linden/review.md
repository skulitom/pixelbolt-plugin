# Marn walk review

I moved three pixels from the profile near boot to the willow creel. The wicker weave and bottom outline now travel with the basket through the body's one-pixel bob. The boot passes cleanly in front. All eight front frames match the initial render.

| Standing canvas pixel | Ink | Near boot local pixel | Creel local pixel |
| --- | --- | --- | --- |
| (13, 26) | ochre `o` | (0, 5) | (9, 12) |
| (14, 26) | brown `r` | (1, 5) | (10, 12) |
| (14, 27) | outline `k` | (1, 6) | (10, 13) |

The isolated boot showed wicker sticking out of its straight shaft. The isolated basket had a matching notch. In the original walk the notch opened in frame 7 as the boot pulled away. With the repair, the three basket pixels show in frames 3–7 and the boot covers them in frames 8, 1 and 2. The sleeve retains its foreground crossing. Both handle openings follow the standing silhouettes. The small gaps in side frames 2 and 8 open between the legs beneath the basket edge. The gap in frame 5 opens between the moving far sleeve and the coat. I retained all three.

## Pixelbolt review

I compiled the supplied and corrected sources, rendered each at scale 1, and inspected all eight phases of each walk in color and with `--view parts`. I used `--view walks` on both sources, then isolated the `creel`, `boot-near` and `coat,sleeve-far` layers in the original profile. A standing-coordinate mask tested the disputed pixels with `inspect --motion walk-right --track`. The first track assigned all three to the boot. The corrected track passed and recorded the boot covering them at the expected phases.

The original native bundle is in `first/`, the final bundle is in `final/export/`, and the review images, track mask and reports are in `review-evidence/`. The following commands reproduce the main inspections with the installed `pixelbolt` command.

```powershell
pixelbolt inspect actor.poses.json --view walks
pixelbolt inspect first/marn.pixel.json --frames stand-right,walk-right-1,walk-right-5,walk-right-7 --layers boot-near
pixelbolt inspect first/marn.pixel.json --frames stand-right,walk-right-1,walk-right-5,walk-right-7 --layers creel
pixelbolt inspect actor.poses.json --motion walk-right --track review-evidence/track-creel.json
pixelbolt inspect final/source.poses.json --motion walk-right --track review-evidence/track-creel.json
pixelbolt inspect final/source.poses.json --motion walk-down
pixelbolt inspect final/marn.recipe.json --reference first/marn.pixel.json --animation walk-right
```

## Delivery checks

The corrected standing PNGs match the supplied references pixel for pixel. Both native GIFs match their eight 36 × 36 frame PNGs, loop indefinitely and hold each frame for 110 ms, for 880 ms per cycle. The initial and final atlas metadata and compiled motion metadata match exactly, including ground anchor (18, 31), direction, part motion, frame order and timing. The original source SHA-256 is `795dad3cf6a0bd694df41dc4d1499fdaed404e430924368389e61f8799ceb5e6`.
