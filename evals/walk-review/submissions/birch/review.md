# Tilda’s harbour walk

In the right walk, the near foot carried a fragment of the satchel’s green canvas, leather hem and dark outline. At full stride it left a notch behind and drew a square brown tab beside the ankle. I transferred eight existing pixels from the near foot to the satchel, using their identical standing coordinates. The near foot still crosses in front of the bag. It covers all eight tracked pixels on steps 5 and 6 and uncovers them again on step 8.

The right wing also exposed the checkerboard through Tilda’s cream breast on steps 1, 2 and 8. I filled the six missing pixels on the coat itself with the surrounding cream (`w`). They occupy x 12–13 and y 7–9 in the coat drawing. I kept the carry-loop opening in both facings. In the down walk, the variable space between the webbed feet follows their opposing steps under the coat. Each leg has a continuous drawn edge there.

## Native checks

Both standing renders match their supplied PNGs pixel for pixel. All eight down-walk frames match the original render. The pose metadata and part positions match throughout, including the ground point (18, 35), four-pixel right stride and two-pixel down stride. Both GIFs decode to the eight corresponding exported PNGs in order at 38 × 39. Each frame holds for 110 ms, giving an 880 ms loop. All 18 atlas rectangles match their frame PNGs.

## Pixelbolt views and build

Run from this job directory using the installed Pixelbolt executable. The diagnostic sheets and their JSON reports are in `evidence/`. The hem mask describes the four standing row runs at (11, 29), (10, 30), (10, 31) and (10, 32), with widths 2, 3, 2 and 1. Motion tracking reported eight pixels owned by the foot before the transfer and all eight owned by the satchel afterwards.

```text
pixelbolt compile actor.poses.json --out evidence/initial.recipe.json --metadata evidence/initial.meta.json
pixelbolt render evidence/initial.recipe.json --out first --scale 1
pixelbolt inspect actor.poses.json --view walks --out evidence/initial-walks.png
pixelbolt inspect actor.poses.json --animation walk-right --out evidence/initial-right.png
pixelbolt inspect actor.poses.json --animation walk-right --view parts --out evidence/initial-right-parts.png
pixelbolt inspect actor.poses.json --animation walk-down --out evidence/initial-down.png
pixelbolt inspect actor.poses.json --motion walk-right --track evidence/hem-track.json --out evidence/initial-track.png
pixelbolt inspect final/source.poses.json --motion walk-right --track evidence/hem-track.json --out evidence/final-track.png
pixelbolt inspect final/source.poses.json --view walks --out evidence/final-walks.png
pixelbolt inspect final/source.poses.json --animation walk-right --out evidence/final-right.png
pixelbolt compile final/source.poses.json --out final/recipe.json --metadata final/metadata.json
pixelbolt render final/recipe.json --out final/export --scale 1
pixelbolt gif final/recipe.json --animation walk-right --out final/walk-right.gif --scale 1
pixelbolt gif final/recipe.json --animation walk-down --out final/walk-down.gif --scale 1
python evidence/verify.py
```
