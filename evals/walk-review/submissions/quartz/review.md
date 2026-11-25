# Salt-marsh surveyor walk review

The right walk exposed two areas hidden at rest. When the near sleeve swung back, the background showed through a gap in the middle of the coat. I filled the six affected rows in `right-coat` with the surrounding blue fabric and its existing shaded edge. On the opposite stride, a rectangle of blue travelled behind the near hip. I removed those pixels from the top of `right-wader-near`, following the narrow upper-leg shape visible in the adjacent rows.

The net handle crosses the coat behind the moving sleeve, and the background is visible inside the net rim in both directions. The down walk already read clearly at game size. Both exported standing drawings match the supplied references pixel for pixel. A native-frame comparison found changes in six right-walk frames and zero in the down walk.

## Delivery checks

- All 18 atlas cells match their 38 × 38 frame PNGs and carry the original (19, 35) anchor.
- Each walk plays eight frames in the original order at 120 ms per frame, for a 960 ms loop. The right and down stride settings remain 4 and 2 respectively.
- Pixelbolt’s motion view reported zero slide for both feet and no separated or clipped frames in either walk.
- I decoded both native GIFs and checked the pixels and duration of each frame against the PNG export, along with the infinite loop flag.

## Pixelbolt commands and views

The commands below ran in this job directory using the installed Pixelbolt CLI. `first/` contains the native render of the supplied source. The parts views show which moving cutout owns a pixel. The motion views show each direction’s foot contacts and pose spread.

```text
pixelbolt compile actor.poses.json --out initial.recipe.json --metadata initial.meta.json
pixelbolt render initial.recipe.json --out first --scale 1
pixelbolt compile actor.poses.json --expand --out initial.expanded.poses.json
pixelbolt inspect actor.poses.json --view parts --out initial-parts.png --scale 4 --native
pixelbolt inspect final/source.poses.json --view parts --out final-parts.png --scale 4
pixelbolt inspect final/source.poses.json --motion walk-right --speed 16.66666667 --out gait-right.png
pixelbolt inspect final/source.poses.json --motion walk-down --speed 8.33333333 --out gait-down.png
pixelbolt compile final/source.poses.json --out final/compiled.pixel.json --metadata final.meta.json
pixelbolt render final/compiled.pixel.json --out final/export --scale 1
pixelbolt gif final/compiled.pixel.json --out final/walk-right.gif --animation walk-right --scale 1
pixelbolt gif final/compiled.pixel.json --out final/walk-down.gif --animation walk-down --scale 1
```
