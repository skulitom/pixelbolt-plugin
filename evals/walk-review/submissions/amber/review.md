# Marn walk review

Both walks are ready to ship as drawn. The willow creel follows the hip through the one-pixel body bob. Its opening stays readable, the weave stays with the basket, and the near boot and sleeve pass in front at their crossings.

In the right walk, the four clear pixels near (20, 27) in step 2 and ten near (20, 26) in step 8 sit between the boots, below the edge of the creel. The isolated lower-body view shows the complete basket rim and boot outlines as the foreground boot moves away. In step 5, the three clear pixels near (22, 15) appear between the neck and the far shoulder as the sleeve swings forward. The coat and sleeve each retain a continuous edge. Painting those pockets would join parts that move separately.

In the down walk, the near sleeve briefly covers the right rim of the handle as it passes. The native reference and isolated part grids establish the shape of the opening. The boots alternate below the coat with continuous shafts and cuffs. Both motion reports recorded one pixel of slide per foot at the generated clip speed and found no weak foot joints, clipping or separated pieces. The supplied stride, timing and part drawings were retained.

## Pixelbolt evidence

The full color, part ownership and motion sheets are in `review-views/`. These commands produced the initial render and the views used to inspect both directions. Substitute `walk-right` or `walk-down` for CLIP.

```text
pixelbolt compile actor.poses.json --out first-recipe.json --metadata first-meta.json
pixelbolt render first-recipe.json --scale 1 --out first
pixelbolt inspect actor.poses.json --view walks --out first-walks.png
pixelbolt inspect actor.poses.json --animation CLIP --view color --scale 4 --out SHEET.png
pixelbolt inspect actor.poses.json --animation CLIP --view parts --scale 6 --out PARTS.png
pixelbolt inspect actor.poses.json --animation walk-right --layers creel,boot-near,boot-far --scale 4 --out right-lower.png
pixelbolt inspect actor.poses.json --frames stand-right,walk-right-5 --layers coat,sleeve-far --scale 8 --out shoulder.png
pixelbolt inspect actor.poses.json --motion walk-right --speed 13.636363636363637 --out motion-right.png
pixelbolt inspect actor.poses.json --motion walk-down --speed 4.545454545454546 --out motion-down.png
```

## Handoff checks

Both standing renders match their supplied PNGs pixel for pixel. All 18 atlas crops match the individual frame PNGs and the initial native render. Every frame has a 36 × 36 canvas and anchor (18, 31). Each GIF decodes to the eight PNGs in sequence, repeats indefinitely, and holds each step for 110 ms (880 ms per cycle). The editable source is byte-identical to the supplied actor.

```text
pixelbolt compile final/source.poses.json --out final/recipe.json --metadata final/metadata.json
pixelbolt render final/recipe.json --scale 1 --out final/export
pixelbolt gif final/recipe.json --animation walk-right --scale 1 --out final/walk-right.gif
pixelbolt gif final/recipe.json --animation walk-down --scale 1 --out final/walk-down.gif
```
