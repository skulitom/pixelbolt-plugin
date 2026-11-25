"""Measure named native-coordinate hits without changing the product report or grading any art."""
import argparse
import json
from collections import Counter
from pathlib import Path
import subprocess

FAMILIES = {"joint":{"underpaint-gap","new-opening"}, "equipment":{"moving-edge","carried-island"},
            "shaft":{"exposed-shaft"}}


def scan(package, source):
    cmd = ["node",package/"bin/pixelbolt.js","inspect",source,"--view","walks"]
    output = subprocess.run(cmd,capture_output=True,text=True,encoding="utf8",check=True)
    return json.loads(output.stdout)["walkReview"]["clips"]


def measure(clips, defects):
    findings = [(clip["clip"],finding) for clip in clips for finding in clip["findings"]]
    tally = Counter(finding["kind"] for _,finding in findings)
    rows = []
    for defect in defects:
        samples = {}
        for frame,coords in defect["frames"].items():
            wanted = {tuple(p) for p in coords}
            hits = []
            for clip, finding in findings:
                if finding["kind"] not in FAMILIES[defect["kind"]]:
                    continue
                for step in finding["steps"]:
                    if step["frame"] != frame:
                        continue
                    for label in ("pixel","peerPixel"):
                        if label in step and tuple(step[label]) in wanted:
                            hits.append(dict(clip=clip,kind=finding["kind"],part=finding["part"],
                                             coordinate=label,pixel=step[label]))
            samples[frame] = hits
        rows.append(dict(id=defect["id"],kind=defect["kind"],phases=len(samples),
                         localized=sum(bool(h) for h in samples.values()),samples=samples))
    return dict(findingGroups=dict(tally),defects=rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package",type=Path)
    parser.add_argument("fixtures",type=Path)
    parser.add_argument("out",type=Path)
    args = parser.parse_args()
    report = {}
    for family in sorted(args.fixtures.iterdir()):
        if not (family/"witnesses.json").is_file():
            continue
        defects = json.loads((family/"witnesses.json").read_text())["defects"]
        report[family.name] = {}
        for variant in ("clean","damaged"):
            clips = scan(args.package,family/(variant+".poses.json"))
            report[family.name][variant] = measure(clips,defects if variant=="damaged" else [])
    args.out.write_text(json.dumps(report,indent=2)+"\n")


if __name__ == "__main__":
    main()
