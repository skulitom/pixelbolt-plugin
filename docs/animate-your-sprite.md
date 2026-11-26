# Animate a sprite you already have

Start from a native-resolution PNG with transparency. This page uses a [32 × 32 side-view sprite](../examples/sprite-walk.png) drawn for it, its [pose recipe](../examples/sprite-walk.poses.json) and its [art brief](../examples/sprite-walk.brief.md). The recipe makes a side walk (8 frames) and an idle (4 frames) facing right, and both again facing left. Its `stand` pose is the PNG pixel for pixel (0 of 1,024 pixels differ).

Run the commands from the repository root (in the npm package, from its folder); each writes under `output/sprite-walk/`, and the CLI makes the folders. Use a new folder for another run: the CLI won't write over a file unless you pass `--force`.

## Cut moving parts straight from the PNG

The [cutout manifest](../showcase/four-way-walk/profile.cuts.json) marks the two legs of the bundled side-view sprite. Save this JSON as `cuts.json` and run:

```json
{"views":{"right":{"feet":[[12,23,5,8],[17,23,5,8]],"mirror":true}}}
```

```sh
node bin/pixelbolt.js import examples/sprite-walk.png --cutout cuts.json --out output/sprite-walk/cutout.poses.json
node bin/pixelbolt.js compile output/sprite-walk/cutout.poses.json --out output/sprite-walk/cutout.pixel.json
node bin/pixelbolt.js render output/sprite-walk/cutout.pixel.json --out output/sprite-walk/cutout
```

This produces `stand-right`, `walk-right`, `stand-left` and `walk-left`. Use [the agent guide](agent-guide.md#cutout-walks-from-a-png) for named sheet frames, independent profiles, explicit pivots and the equivalent MCP call. For boots that disappear beneath a coat, select their visible pixels and add `"extendFeet":2` to that facing to draw short shafts underneath. Keep the default transparent margin for room to step. The exported `anchorPx` includes the margin and locates the same point on the source drawing. The rigged example below adds painted overlap behind joints and bends at the knees.

## Import, cut and attach

```sh
node bin/pixelbolt.js import examples/sprite-walk.png --out output/sprite-walk/imported.pixel.json
node bin/pixelbolt.js inspect output/sprite-walk/imported.pixel.json --grid --out output/sprite-walk/imported.png
```

Read the imported palette and grid, then cut the drawing into parts: head, torso, near and far upper arms and forearms, thighs, shins and boots. The recipe's `parts` hold each cut as short rows of palette keys; the importer doesn't find body parts for you. Put each part's anchor at its joint, and rebuild the unchanged drawing as the `stand` pose before animating anything.

The motion templates need a **mass body and bone limbs**: a drawn grid can't be the rig's body or a limb. So the example hangs the drawn grids on invisible carriers: a 2 × 2 `hips` mass and two-bone limb chains drawn in the transparent `Y Z` ramp, with each grid attached to a carrier's named point. A limb grid's `angle: -90` cancels its carrier's standing 90°; the boots have no relative angle and stay upright. Carriers move rigid drawings; they don't bend or skin them.

Fill in what the flat drawing hid: tunic behind the arm, neck under the chin, and overlapping thigh and shin rows at each knee, all in the PNG's own colours, and check that `stand` still matches the PNG. Keep `cleanup: false` on the small limb grids so their outline pixels stay. The torso's extra bottom row closes the belt when the body rises.

The drawing stands with its legs apart, so `stand` keeps them there while `walk-rest`, the rig's rest, puts both hips at x = 16; the walk is made from `walk-rest` with the template's default stride 10, lift 2 and bob 1, and both contact poses put the ankles 8 px apart. The four idle poses are written out in the recipe (taken from the idle template on `stand`, with no mass breath and the torso carrying the head and shoulders): a 1 px inhale over 1.6 seconds that keeps the drawing's outline pixel at (12, 26) in every frame. Edit their offsets and durations to retune the breath. The [brief](../examples/sprite-walk.brief.md) says what still looks stiff.

## Compile and review

```sh
node bin/pixelbolt.js compile examples/sprite-walk.poses.json --out output/sprite-walk/sprite-walk.pixel.json --metadata output/sprite-walk/sprite-walk.meta.json
node bin/pixelbolt.js validate output/sprite-walk/sprite-walk.pixel.json
node bin/pixelbolt.js inspect output/sprite-walk/sprite-walk.pixel.json --native --out output/sprite-walk/contact.png
node bin/pixelbolt.js inspect output/sprite-walk/sprite-walk.pixel.json --animation walk --view onion --out output/sprite-walk/walk-onion.png
node bin/pixelbolt.js inspect output/sprite-walk/sprite-walk.pixel.json --animation idle --view onion --out output/sprite-walk/idle-onion.png
node bin/pixelbolt.js inspect examples/sprite-walk.poses.json --motion walk --out output/sprite-walk/walk-motion.png
```

Look for holes at the knees, a row of air between head and body, feet that slide and outlines that jump. The motion review measures the gait, not the drawing. This right walk passes all seven of its checks: slide 0.32 px a foot, ground error 0, pose spread, loop seam, arm swing, contact legs and knee lift.

`inspect --reference` pairs frames by **name**: the imported frame is called `idle` and the recipe's rest is `stand`, so comparing the two files as they are compares nothing. Save this as `output/sprite-walk/rest-copies.mjs`; it writes a copy of each with one frame named `stand`:

```js
import fs from 'node:fs';
const imported = JSON.parse(fs.readFileSync('output/sprite-walk/imported.pixel.json', 'utf8'));
imported.frames[0].name = 'stand';
imported.animations = { stand: { frames: ['stand'] } };
fs.writeFileSync('output/sprite-walk/reference.pixel.json', JSON.stringify(imported), { flag: 'wx' });
const rest = JSON.parse(fs.readFileSync('output/sprite-walk/sprite-walk.pixel.json', 'utf8'));
rest.frames = rest.frames.filter(frame => frame.name === 'stand');
rest.animations = { stand: { frames: ['stand'] } };
fs.writeFileSync('output/sprite-walk/rest.pixel.json', JSON.stringify(rest), { flag: 'wx' });
```

```sh
node output/sprite-walk/rest-copies.mjs
node bin/pixelbolt.js inspect output/sprite-walk/rest.pixel.json --reference output/sprite-walk/reference.pixel.json --out output/sprite-walk/rest-comparison.png
```

## The left walk

Each left pose is its right pose mirrored whole, for example `{"name": "walk-left-contact-a", "mirror": "walk-contact-a"}`; with the origin at x = 16, pixel x goes to 31 - x. The left motions declare the generated pose names, so these mirrors replace the poses the templates would make: the left frames are the right frames' exact mirrors, not a second solved gait.

The motion review measures a walk against `rig.rest`, and this rest faces right, so the left walk's review reports `kneeLift: false` (170° against a limit of 45°) though its frames are exact mirrors of a walk that passes. Until the review mirrors the rest itself, review a copy whose rest is mirrored. Save this as `output/sprite-walk/left-review.mjs`:

```js
import fs from 'node:fs';
const source = JSON.parse(fs.readFileSync('output/sprite-walk/expanded.poses.json', 'utf8'));
source.poses.push({ name: 'walk-rest-left', mirror: source.rig.rest });
source.rig.rest = 'walk-rest-left';
fs.writeFileSync('output/sprite-walk/review-left.poses.json', JSON.stringify(source), { flag: 'wx' });
```

```sh
node bin/pixelbolt.js inspect examples/sprite-walk.poses.json --motion walk-left --out output/sprite-walk/left-original-rest.png
node bin/pixelbolt.js compile examples/sprite-walk.poses.json --expand --out output/sprite-walk/expanded.poses.json
node output/sprite-walk/left-review.mjs
node bin/pixelbolt.js inspect output/sprite-walk/review-left.poses.json --motion walk-left --out output/sprite-walk/left-mirrored-rest.png
```

The copy's review reports a knee lift of 34° and passes all seven checks, and every frame it plays is unchanged. Use it only to review; edit and export the original recipe.

`--speed` on `inspect --motion` reviews **the same gait** at another travel speed; it doesn't make a new one. Without it the review uses the speed stored with the walk, here 24 px/s (-24 for the left walk). At 32 px/s this walk's feet slide 2.24 px and the slide check fails, as it should:

```sh
node bin/pixelbolt.js inspect examples/sprite-walk.poses.json --motion walk --speed 32 --out output/sprite-walk/walk-speed32.png
```

## Export

```sh
node bin/pixelbolt.js render output/sprite-walk/sprite-walk.pixel.json --out output/sprite-walk/bundle --look
node bin/pixelbolt.js gif output/sprite-walk/sprite-walk.pixel.json --animation walk --out output/sprite-walk/walk.gif --scale 4
node bin/pixelbolt.js gif output/sprite-walk/sprite-walk.pixel.json --animation idle --out output/sprite-walk/idle.gif --scale 4
node bin/pixelbolt.js gif output/sprite-walk/sprite-walk.pixel.json --animation walk-left --out output/sprite-walk/walk-left.gif --scale 4
node bin/pixelbolt.js gif output/sprite-walk/sprite-walk.pixel.json --animation idle-left --out output/sprite-walk/idle-left.gif --scale 4
```

`render` also notes that three of the idle's frames are the same drawing: that is the held rest the brief describes. The bundle holds the sheet `sprite-walk.png`, its `sprite-walk.atlas.json` and a Godot 4 `sprite-walk.tres`, with each frame and animation on its own. The sheet stays at native size; the review GIFs are 128 × 128.

## Four-direction walks from drawn parts

For a small top-down character, draw standing poses for the front, back and one side. Give each pose two feet and optionally two arms as separate root instances. Fill a few pixels behind joints so raising a foot or swinging an arm leaves the outline connected. Keep the same canvas and origin for every facing, with space around the artwork for a stride. The origin also sets the horizontal mirror line.

Start with the bundled knight: `pixelbolt presets four-way-knight --out knight.poses.json` saves all its drawn parts and three standing views to edit.

If your cuts use image coordinates, give the rest pose an origin at the character's feet and subtract it from each root part's position. For instance, on a 24-pixel-wide canvas, a boot at `[14, 17]` with origin `[12, 19]` goes at `[2, -2]`. The boot stays on the same pixel and the opposite profile reflects about x = 12. A drawn asymmetric profile can keep its own equipment on the correct side.

Add `walkCycles` to the pose source. Each entry generates eight editable poses and a looping animation. This example uses the same instance names in three different rest poses. Pair the first arm with the first foot on the same side of the character so they swing in opposition.

```json
{
  "walkCycles": {
    "walk-down": { "rest": "stand-down", "direction": "down", "feet": ["boot-a", "boot-b"], "arms": ["arm-a", "arm-b"] },
    "walk-up": { "rest": "stand-up", "direction": "up", "feet": ["boot-a", "boot-b"], "arms": ["arm-a", "arm-b"] },
    "walk-right": { "rest": "stand-right", "direction": "right", "feet": ["boot-a", "boot-b"], "mirrorAs": "walk-left" }
  }
}
```

`stride` sets how far each foot reaches from rest in pixels (default 1 for front/back, 2 for a side). `lift` raises the returning foot (default 1), and `bob` raises the body at the passing pose (default 1). `duration` sets milliseconds per frame (default 100). Children attached to a moving part follow it. For an asymmetric character, draw its other profile and declare its own cycle facing `left`.

Inspect the complete character with `pixelbolt inspect actor.poses.json --view walks --out walks.png`. Compare the named steps and coordinates against your standing drawings, including spaces that belong inside equipment and edges where one part passes in front of another.

Compile and render with the commands above. `compile --expand` also writes each step as an ordinary pose you can retouch. In Godot, assign the generated `.tres` to an `AnimatedSprite2D` and play the named animation. The [three complete examples, source sprites and animated preview](../showcase/four-way-walk/) show the input drawings and the gait.
