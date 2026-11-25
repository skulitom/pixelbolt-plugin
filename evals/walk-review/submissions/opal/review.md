# Tilda's harbour walk

**Production decision.** Keep the submitted drawings and gait. In both facings, the folded letter stays in the outer pocket and the carry loop keeps its opening through all eight steps. The coat, leather sling and satchel bob together. The near wing swings across the bag and the near web passes in front of its lower edge. Both crossings read in the intended depth order.

## Native-pixel review

- In the right walk, the one-pixel spaces near (16,30) on step 1, (15,30) and (16,29) on step 4, and (16,30) on step 6 fall between the moving feet or between a foot and the bag's lower edge. The foot and shin form a continuous silhouette in isolation. Filling those spaces would join independent contours.
- In the down walk, the spaces around (17,29) on steps 3, 4 and 8, and (18,29) on step 7, sit under the belly between the legs. The colored parts view shows the near shin connects to the near foot and the crotch opens as the far foot passes. The standing pose already has a small opening under the belly.
- At full stride, the near web's orange toes and dark rim travel together. The isolated coat, sling and satchel show a complete bag face, folded letter and carry loop in every phase. I retained the five-pixel standing loop opening on the right and the seven-pixel opening facing down.

## Commands and checks

I used Pixelbolt from this job directory. The main views and exports can be regenerated with the following commands.

```text
pixelbolt compile actor.poses.json --out initial.recipe.json --metadata initial.meta.json
pixelbolt render initial.recipe.json --out first --scale 1
pixelbolt inspect actor.poses.json --view walks --out walk-input.png
pixelbolt inspect actor.poses.json --animation walk-right --out right-sequence.png --scale 4
pixelbolt inspect actor.poses.json --animation walk-down --out down-sequence.png --scale 4
pixelbolt inspect actor.poses.json --frames stand-right,walk-right-1,walk-right-4,walk-right-6 --view parts --region 8,26,17,10 --scale 10 --out right-joints.png
pixelbolt inspect actor.poses.json --frames stand-down,walk-down-3,walk-down-4,walk-down-7,walk-down-8 --view parts --region 9,26,18,11 --scale 8 --out down-joints.png
pixelbolt inspect actor.poses.json --animation walk-right --layers near-shin,near-foot --out components.png --scale 3
pixelbolt inspect actor.poses.json --animation walk-down --layers coat,sling,satchel --scale 3 --out down-bag.png
pixelbolt inspect actor.poses.json --animation walk-right --layers coat,sling,satchel --scale 3 --out right-bag.png
pixelbolt compile final/source.poses.json --out final/compiled.pixel.json --metadata final/compiled.meta.json
pixelbolt render final/compiled.pixel.json --out final/export --scale 1
pixelbolt gif final/compiled.pixel.json --animation walk-right --out final/walk-right.gif --scale 1
pixelbolt gif final/compiled.pixel.json --animation walk-down --out final/walk-down.gif --scale 1
```

The editable source matches the input byte for byte. Both standing exports match their supplied PNGs in RGBA, and all 18 final frames match the initial native render. I decoded both 38 × 39 GIFs and compared each displayed frame to its PNG. Each GIF loops indefinitely through eight 110 ms frames in the original order. The ground origin is (18,35) in each facing.
