# Zero-shot character walks

Can a fresh agent turn supplied character art into a usable Godot walk from a short gameplay brief? Run each row in a new context with a clean installation, the indicated input files and an empty output folder. Agents may consult the installed public skill, help and guides, use ordinary tools and revise their work. Keep earlier runs, showcase solutions, repository internals and the graders outside the participant's instructions and working directory.

| Case | Supply these files | Gameplay brief |
| --- | --- | --- |
| profile | [imp.png](inputs/imp.png) | Give imp.png a looping right-facing walk and a matching stand for my Godot game. Keep the supplied standing pixels and ground point (16,36). Steps should last 100 ms and the feet should stay attached. |
| porter | [porter.png](inputs/porter.png), [porter.atlas.json](inputs/porter.atlas.json) | Animate my porter for a four-direction top-down Godot game from the supplied standing views. Keep the satchel on its original hip, the boots attached, the drawing faithful, and the ground point at (8,28). Use a 100 ms step and a standing pose when movement stops. |
| scout | [ranger.png](../../showcase/four-way-walk/sources/ranger.png), renamed to `scout.png` | Turn scout.png, my only front drawing, into a playable four-direction character for Godot 4. Draw convincing back and profile views in its style, keep the headband recognizable and show its knot at the back. Preserve the original standing front and ground point (8,16). The actor should walk with the arrow keys, stop facing the last direction and use 100 ms steps, with the feet attached. |
| transfer | [lamplighter.png](inputs/lamplighter.png) | Turn my lamplighter's only front drawing into a playable four-direction Godot 4 character. Keep the original standing pixels, the source ground point (13,30), and the lantern in the character's left hand. Its amber light should show on the viewer's right from the front, on the left from the back and in the left-facing view. Hide it behind the coat in the right-facing view. Use the original palette, 120 ms steps, attached boots and arrow-key movement that stops facing the last direction. |
| watchmaker | [watchmaker.png](inputs/watchmaker.png) | Turn my only front drawing of this clockwork character into a playable four-direction Godot 4 actor. Preserve the front, its ground point (13,30), palette, two visor lights and antenna. The left hand holds an amber lantern and the right shoulder has a red plate. Show the lamp on viewer-right from the front, viewer-left from the back, visible facing left and hidden facing right. The plate does the opposite. Draw a back without visor lights. Use 120 ms steps, attached boots, arrow-key movement and standing in the last direction when stopped. |

For every brief, request the editable Pixelbolt source, exported sheet, atlas, SpriteFrames and an animated preview. Ask the agent to keep its **first export**, including flawed frames, and a short command log with errors, repairs and manual decisions. Record both first export and final delivery. An autonomous correction after export counts as a retry. Record rejected commands before the first export separately. Use the same brief and inputs for a before/after comparison. Reserve a separate unseen character for transfer.

## Grading

Grade from the delivered files in a separate directory. Have the scorer see the brief and the supplied art. With Python 3.10 or newer and Pillow 9.1 or newer installed:

```sh
python evals/character-walks/grade_atlas.py porter path/to/porter.atlas.json
```

Check the native resource in Godot 4 as well. For a bare resource, copy the sheet and SpriteFrames together into an empty Godot project. For the gameplay cases use the submitted project. Import the project before running the grader. Pass an absolute path to the script and use a project-relative `res://` path for the resource.

```sh
godot --headless --editor --path path/to/project --import
godot --headless --fixed-fps 60 --path path/to/project --script /absolute/path/to/grade_playback.gd -- scout res://art/scout.tres /absolute/path/to/scout.atlas.json
```

Review the GIF at native size and enlarged. Inspect flagged frames against the standing drawing, including shoes hidden at crossings, gear attached to the intended side, newly visible rear details and whether the forward and backward phases read as steps. An island count can flag an earring or miss a boot touching a coat only at a corner. When available, inspect each authored pose source with `pixelbolt inspect <source> --motion walk-right` (substitute each facing). Check clipping, weak joints, and any slide at the speed actually used in the game. Recompile the editable source and compare its exports with the delivery.

The [November 2026 runs](results.md) include a same-input replay and an independent repeat. Record the package version and digest, the brief, first and final findings, evidence for each visual judgment, and any coaching. A single success is evidence for that run. To estimate reliability, repeat each case with fresh agents and rotate in new inputs.

## Art credits

The imp profile and porter turnaround use Pixelbolt's authored views of two CC0 characters by 0x72. The scout is Kenney's CC0 ranger from *Tiny Dungeon*. The lamplighter and watchmaker were drawn for this evaluation and are covered by the repository license. [0x72 source and view credits](../../showcase/cutout-walks/README.md#credit) · [Kenney source and license](../../showcase/four-way-walk/README.md#art-credit)
