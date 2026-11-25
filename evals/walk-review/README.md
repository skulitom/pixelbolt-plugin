# Blind whole-walk review

Can an agent decide whether a layered walking sprite needs a repair when it receives an editable pose source, the artist’s standing drawings and an ordinary production brief? Each of three artists made two facings, a clean source, a damaged source, and native-coordinate witnesses for defects and intentional details. The two variants of each character have identical standing RGBA. The salt-marsh surveyor was used during development. Two other authors froze their work independently before tuning. The dates, build pins, participant submissions and first/final results are in [the trial report](results.md).

## Run the review

Install the Pixelbolt revision identified in the report. The public CLI reads native coordinates with the origin at the top left. It can also draw a contact sheet.

```sh
pixelbolt inspect actor.poses.json --view walks --out walks.png
pixelbolt inspect actor.poses.json --frames walk-right-1 --view parts --grid
```

The equivalent MCP call is `pixel_inspect` with `{"source": <editable pose source>, "view": "walks"}`. A result includes every annotated clip, the affected steps, part names and pixel coordinates. The source drawing and its local pixel accompany a shaft, concealed gap or suspicious foot edge. Compare the proposed location against the standing image, isolated parts and walk. A foreground crossing, the gap between alternating feet and the opening of a tool can all be intentional. See [the cutout workflow](../../docs/agent-guide.md#when-a-boot-crosses-a-carried-prop).

## Reproduce a handoff

Use Node 20 or newer and Python 3 with Pillow. Install the trial revision of Pixelbolt in a directory separate from the fixture and participant. From this directory, stage a single version in a fresh workspace. Keep its private receipt and the artist’s files outside that workspace.

```sh
node stage.mjs fixtures/field damaged /work/jobs/reed /work/tools/node_modules/.bin/pixelbolt /work/receipts/reed.json
```

Give a fresh agent only the job path and ask it to read and complete `task.txt`. The same template is used throughout. Do not reveal the pair, variant, grader, private drawing or intended defect. Save the supplied native export in `first/`. The task specifies the final editable source, full native bundle and per-walk native GIFs.

## Replay a submission

The scorer uses the installed baseline renderer for both submitted and reference sources. It independently decodes PNG, atlas and GIF exports, verifies foreground/background order at crossings, and compares all walk phases for source ownership, visible changes, ground anchors, motion and timing. The character author supplies the witness locations. The strict clean score requires the original visible pixels and carrier motion. A damaged submission may restore previously concealed joint or shaft material using a nearby shade on the correct moving surface. Exact RGBA differences remain visible in the report.

```sh
python score.py --package /work/baseline/node_modules/pixelbolt --family fixtures/field --job /work/jobs/reed --variant damaged --out /work/reed-score.json
python compare.py /work/baseline/node_modules/pixelbolt fixtures/field /work/jobs/reed/final/source.poses.json /work/reed.gif
```

The recorded agent sources and review notes live under `submissions/`. Rebuild their native output and compare all first/final pixel scores with `python rebuild.py /work/baseline/node_modules/pixelbolt /work/fresh-replay`. The original exported-file and delivery checks are recorded separately in `results.json`. To check the grader itself, use `python replay.py verify --package /work/baseline/node_modules/pixelbolt --out /work/priors.json`. To measure which named coordinates the candidate actually localized, use `python localize.py /work/candidate/node_modules/pixelbolt fixtures /work/localization.json`.

The fixtures and their answers are public here for reproducibility. Anyone running another blind evaluation should expose only the staged job to the participant. Once an artist reference has been opened, reuse of that character measures regression on known art.
