# Rigged hero: art brief

The figure an agent starts from for a character that walks, runs, jumps or attacks. An original young courier in a teal jacket and a long red scarf. The design is our own; nothing is taken from a game.

- **Canvas and display:** 32×36, origin `[15, 35]` (the anchor under the feet), `rig.ground` 33 (the ankle row). The boots' soles sit on row 34. Review at 1× and 6×. A jump with `apex: 3` stays inside the canvas.
- **Landmarks:** a tuft of hair on the crown, a scarf whose end trails behind the neck, and chunky boots. The negative space between the scarf and the back keeps the scarf readable in every pose.
- **Construction:** a small `mass` at the hips is the rig body. The jacket is a bone that stands on it (`width [5, 6]`, a flat hem and round shoulders), so the chest is wider at the shoulders than at the waist. Two-bone arms and legs, grid hands and boots, a grid head, and a two-bone scarf as `rig.tail`, which follows through: it trails behind him in a walk or run, lifts as he falls from a jump, and whips after a strike.
- **Palette (20 colours):** `k` outline. Skin `x y z`, hair `d e f`, jacket `i j l m`, scarf `r s t`, trousers `p q o`, boots `b c w`. Light comes from the upper left (225°). The jacket is lighter than the trousers, so the two read apart in grayscale. The near arm and leg are one ramp step lighter than the far ones, and never use the darkest step, which merges with the outline.
- **Outline:** one outline around the silhouette. Inside the figure, where a bone crosses another part, the line is one ramp step darker (`innerLines` default). Grid parts carry their own outlines.
- **Motion:** the six templates at their defaults, apart from walk and run speeds, stride, lift, bob and lean as written in the source. Planted feet are measured by the motion review; arms swing against the legs.
- **Weaknesses:** the far arm is mostly hidden behind the legs when it swings forward, so its hand can look detached for a frame. The scarf answers only the body's own motion through still air, never a wind, and at seven pixels long its whip after a strike moves its end only a few pixels. The hands are 2×2 fists.
