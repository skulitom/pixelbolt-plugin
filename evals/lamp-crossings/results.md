# Fresh-agent lamp-crossing review

Nine independent sessions reviewed two original opaque pixel sprites. The brief, standing PNG, cut manifest and installed public CLI were the only task inputs for the station. The quarry also supplied an editable pose with the intended draw order. Each session preserved its first export, reviewed the handoff and submitted its final art without grader feedback. The station brief left foreground depth implicit. The quarry brief explicitly put the boot in front of the swinging lamp. Each clean handoff had correct lamp ownership and could still benefit from fabric underpaint.

The hidden score projects the artist’s original boot and lamp masks using the authored eight-step displacement of each part. It checks visible ownership even where two layers have the same colour. A crossing error is one incorrect foreground witness in one walk frame. The source-ground anchor, standing RGBA, both boot trajectories, all eight hold durations and delivered native images were checked independently. All nine final submissions preserved the standing PNG and gait.

| Sprite | Handoff | Pixelbolt build | Wrong standing owners, first → final | Wrong foreground witnesses, final | Final |
| --- | --- | --- | ---: | ---: | --- |
| Station | damaged | baseline | 3 → 16 | 44 | Fail |
| Station | damaged | ownership probe | 3 → 0 | 0 | Pass |
| Station | clean | ownership probe | 0 → 0 | 0 | Pass |
| Quarry | damaged | ownership probe | 4 → 2 | 8 | Fail |
| Quarry | clean | ownership probe | 0 → 2 | 8 | Fail |
| Quarry | damaged | current-owner edge | 4 → 0 | 0 | Pass |
| Quarry | clean | current-owner edge | 0 → 1 | 3 | Fail |
| Quarry | damaged | both edges | 4 → 0 | 0 | Pass |
| Quarry | clean | both edges | 0 → 0 | 0 | Pass |

## What the agents changed

On the same station handoff, both agents found the three rim pixels. The baseline agent gave the entire lantern foreground priority and lost 44 valid boot crossings. The first candidate used a standing mask and one cut assignment, preserved the depth order, and passed. A separate agent left the clean station handoff intact.

On the quarry, the first candidate selected the complete visible-looking lamp outline, including two real toe pixels. Its probe passed with that mask. A second agent made the same two-pixel error on the clean handoff. The next build identified disputed pixels touching another colour on their current owner. Its repair agent retained both toe corners and underpainted the rim behind them. The clean-input agent still moved a different boot pixel. The final build also reports whether there is adjacent colour evidence on the proposed owner. The last clean review preserved the original material ownership.

A mask expresses the artist’s choice of which visible standing pixels to follow. At a same-colour contact, the measured trajectories alone cannot establish which drawing owns the seam. Underpainting can preserve a front contour and complete the hidden surface. The grader accepts alternate hidden paint and checks every foreground crossing.

## Interpreting the trial

An offline replay from the archived submissions reproduced all 18 first and final scores, including each failure count. Each table row used one fresh agent. The quarry informed the edge-report refinements after the first transfer. The later quarry reruns therefore measure repairs on a known difficult case. The clean quarry session on the first candidate used a work folder whose name contained `control`. The last two clean/corrupt pairs used neutral folder names. These runs do not estimate a general success rate across artists or unseen sprites.

The station has 44 visible lamp pixels, and the quarry has 46. Agents used their own selection shapes, some including handles or adjacent fixture pixels. Positive references genuinely lose 3 and 4 standing owners. All clean references pass. A clean underpaint variation changes six frame pixels and passes. A depth-only negative fails at 23 foreground witnesses, including 17 with matching visible colours.

[Machine-readable first/final scores and tool digests](results.json) · [Fixture generator, grader and replay commands](README.md)
