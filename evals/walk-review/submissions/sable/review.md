# Salt-marsh surveyor walk review

Approved both walks as drawn. Each standing render matches its supplied 38 × 38 PNG pixel for pixel. The ochre hat, scarf and blue coat keep their silhouettes through the body bob. Both waders stay attached through the passing poses.

## Decisions at native size

- **Profile.** The openings at (18, 30) in step 2 and (18, 29) in step 8 lie between the waders below the coat. The boots overlap as they pass, then separate at contact. In step 5 the pixel at (22, 17) shows through between the face, coat and far sleeve as the arm swings forward. The edges of each isolated drawing are continuous at these locations.
- **Front.** The apparent opening near (24, 11) is part of the sky between the hat, cheek and equipment. It also appears in the standing drawing. The far sleeve changes its lower boundary in steps 4–6. Filling that space would widen the silhouette.
- **Dip net.** The rim encloses 25 transparent pixels in profile and 24 from the front throughout the walks. The profile handle stays on the coat and the near sleeve passes in front of it. At (18, 22) in profile step 1, for example, a blue sleeve pixel covers an ochre handle pixel.

The motion checks found zero slide at the authored walking speeds, with both waders connected in every step. The final source is byte-identical to the supplied source.

## Pixelbolt views and exports

I compiled the supplied pose source with metadata and rendered the recipe at scale 1 into `first/`. I used `inspect --view walks` to locate openings, `inspect --view parts` to identify the visible drawing, and `inspect --animation` with `--native` for all eight phases of each walk. I also isolated `--layers net,sleeve-near` in profile and checked `--motion walk-right --speed 16.666666666666668` and `--motion walk-down --speed 8.333333333333334` against the speeds from the compiled metadata.

```powershell
pixelbolt compile final/source.poses.json --out final/compiled.json --metadata final/metadata.json
pixelbolt render final/compiled.json --out final/export --scale 1
pixelbolt gif final/compiled.json --animation walk-right --out final/walk-right.gif --scale 1
pixelbolt gif final/compiled.json --animation walk-down --out final/walk-down.gif --scale 1
```

All 18 rectangles in the 304 × 114 atlas match the individual native PNGs and carry the (19, 35) anchor. Both GIFs decode to the eight corresponding PNGs in order at 38 × 38, with 120 ms per frame and continuous looping. Each cycle takes 960 ms.
