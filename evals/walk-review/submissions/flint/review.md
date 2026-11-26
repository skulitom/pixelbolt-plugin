# Salt-marsh surveyor walk review

In right step 1, a blue rectangle swung out behind the coat as the near foot moved back. The isolated wader drawing showed ten blue pixels extending sideways from its upper shaft. I removed that tab. The boot, sole and leg positions retain their original drawings and motion.

The near sleeve covered a 37-pixel cutout in the standing profile coat. As the sleeve swung across the chest, the cutout exposed the background or the leg beneath, especially in steps 1 and 5. I filled the cutout using the coat's existing blue midtone, side shade and shoulder highlight. The brass net handle still passes behind the near sleeve. Its hoop retains the 25-pixel sky opening in profile and the 24-pixel opening facing front throughout both walks.

I kept the spaces between the passing boots and beside the swinging far sleeve in profile. The front view also has a space beside the face, below the brim and inside the diagonal handle. The swinging far sleeve changes its lower boundary. These openings follow the separate silhouettes in the standing references. All eight front-walk frames match the initial render pixel for pixel.

## Delivery checks

Both final standing PNGs match their supplied references pixel for pixel. The source has edits in two part drawings only. Both walks retain their (19, 35) origin, original contacts and strides, eight ordered frames and 120 ms per frame. Each exported GIF decodes to the corresponding 38 × 38 transparent PNG frames and loops indefinitely. The right-walk frame differences in order are 12, 5, 0, 4, 8, 4, 0 and 6 pixels. The supplied source SHA-256 is `55d5d906bee94e635f52616da3907b4668fc511a3813c8231e5c7342f36669e3`.

## Pixelbolt review and export

I used the installed Pixelbolt CLI from the job directory. These commands reproduce the initial render, layer inspections and final exports when run with fresh output paths.

```text
pixelbolt compile actor.poses.json --out initial.recipe.json --metadata initial.meta.json
pixelbolt render initial.recipe.json --out first --scale 1
pixelbolt inspect actor.poses.json --view walks --out walks-first.png
pixelbolt inspect actor.poses.json --frames stand-right,walk-right-1,walk-right-3,walk-right-5 --view parts --out profile-parts.png
pixelbolt inspect actor.poses.json --frames stand-right,walk-right-1,walk-right-3,walk-right-5 --layers coat,wader-near --out profile-joint.png
pixelbolt inspect final/source.poses.json --view walks --out walks-final.png
pixelbolt inspect final/source.poses.json --frames "walk-*" --scale 4 --out walks-final-all.png
pixelbolt compile final/source.poses.json --out repaired.recipe.json --metadata repaired.meta.json
pixelbolt render repaired.recipe.json --scale 1 --out final/export
pixelbolt gif repaired.recipe.json --animation walk-right --scale 1 --out final/walk-right.gif
pixelbolt gif repaired.recipe.json --animation walk-down --scale 1 --out final/walk-down.gif
```
