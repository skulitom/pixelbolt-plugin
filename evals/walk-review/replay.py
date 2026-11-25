"""Audit frozen artist inputs or collect completed sessions using the locked scorer."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from score import grade, native, read, require, score, verify_export, write


HERE = Path(__file__).resolve().parent
PINS = {"field": "3cfe878ea2afcffb694c26283af2cee698a45dc11b5a5b811e5f3cb2cf605ce9",
        "marsh": "7b652801e099e50f6eb1ca86c4ffc57602d4399aec4d2b6d0a82931d65fa77c1",
        "loft": "dc95457bcb2723d479ae3cb0921b1e17ee0c808b360ee33395ae574fc4c941b9"}
SCORER_LOCK = "c48db17ab86333e8f62ed7e35c67a2edba73934df5f312eafa70d3706e108676"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def frozen(fixtures):
    lock = HERE/"SCORER-LOCK.json"
    require(sha(lock) == SCORER_LOCK, "scorer criteria receipt changed")
    for name, digest in read(lock)["files"].items():
        require(sha(HERE/name) == digest, "locked scorer changed: "+name)
    for name, digest in PINS.items():
        family = fixtures/name
        require(sha(family/"FREEZE.json") == digest, "fixture manifest changed: "+name)
        for entry, value in read(family/"FREEZE.json")["files"].items():
            require(sha(family/entry) == value, "frozen fixture changed: "+entry)


def run_cli(package, *args):
    run = subprocess.run(["node",package/"bin/pixelbolt.js",*args], capture_output=True, text=True)
    require(run.returncode == 0, "public CLI failed: "+run.stderr[:1000]+run.stdout[:1000])


def priors(package, fixtures, scratch):
    report = {}
    for name in PINS:
        family = fixtures/name
        clean = native(package,family/"clean.poses.json")
        damaged = native(package,family/"damaged.poses.json")
        witnesses = read(family/"witnesses.json")
        clean_grade = grade(clean,clean,witnesses,family,True,clean)
        damaged_grade = grade(clean,damaged,witnesses,family,False,damaged)
        require(clean_grade["passed"] and not damaged_grade["passed"], "artist pair failed its self-test")
        for item in damaged_grade["witnesses"]:
            require(bool(item["failed"]) == (item["category"] == "defects"), "unexpected negative control result")
        with TemporaryDirectory(dir=scratch) as temporary:
            work = Path(temporary)
            source, recipe, expanded = family/"clean.poses.json", work/"clean.pixel.json", work/"expanded.poses.json"
            run_cli(package,"compile",source,"--out",recipe)
            run_cli(package,"render",recipe,"--out",work/"export")
            for clip, seq in clean["clips"].items():
                if seq.get("rest"):
                    run_cli(package,"gif",recipe,"--animation",clip,"--out",work/(clip+".gif"))
            delivery = verify_export(work,clean)
            run_cli(package,"compile",source,"--expand","--out",expanded)
            static = read(expanded)
            poses = {pose["name"]:pose for pose in static["poses"]}
            for seq in clean["clips"].values():
                if seq.get("rest"):
                    for frame in seq["frames"]:
                        poses[frame]["parts"] = poses[seq["rest"]]["parts"]
            write(expanded, static)
            stopped = grade(clean,native(package,expanded),witnesses,family,False,damaged)
            require(not stopped["passed"] and not stopped["checks"]["gait"] and stopped["checks"]["standingRGBA"],
                    "motion-disabled mutation was not rejected on gait")
        report[name] = {"manifest":PINS[name], "clean":clean_grade, "damaged":damaged_grade,
                        "disabledMotion":stopped, "cleanExport":delivery}
    return report


def collect(package, fixtures, root, roster):
    result = []
    for run in roster:
        job, variant, family = root/"jobs"/run["job"], run["variant"], fixtures/run["family"]
        receipt = read(root/"receipts"/(run["job"]+".json"))
        require(receipt["job"] == run["job"] and receipt["variant"] == variant, "roster/staging mismatch")
        for path, digest in receipt["hashes"].items():
            require(sha(job/path) == digest, "participant handoff changed: "+path)
        require(receipt["hashes"]["actor.poses.json"] == sha(family/(variant+".poses.json")), "wrong artist input")
        require((job/"task.txt").read_text(encoding="utf-8").rstrip("\r\n") == receipt["prompt"], "task handoff changed")
        art = score(package,family,job,variant)
        before = {(g["category"],g["kind"],g["id"]):g for g in art["first"].get("witnesses", [])}
        changes = []
        for g in art["final"].get("witnesses", []):
            key = (g["category"],g["kind"],g["id"])
            if key in before:
                changes.append({"category":key[0], "kind":key[1], "id":key[2],
                                "initialFailed":before[key]["failed"], "finalFailed":g["failed"],
                                "resolved":before[key]["failed"] > 0 and g["failed"] == 0})
        result.append({**run, "receiptSha256":sha(root/"receipts"/(run["job"]+".json")),
                       "finalSourceSha256":sha(job/"final/source.poses.json") if (job/"final/source.poses.json").is_file() else None,
                       "reviewSha256":sha(job/"review.md") if (job/"review.md").is_file() else None,
                       **art,"resolutions":changes})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["verify","collect"])
    parser.add_argument("--package",type=Path,required=True,help="Installed pinned baseline package")
    parser.add_argument("--fixtures",type=Path,default=HERE/"fixtures")
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--runs",type=Path,help="Contains jobs/ and receipts/")
    parser.add_argument("--roster",type=Path,help="Private JSON array. Each row has job, arm, family, variant and optional timing metadata")
    args = parser.parse_args()
    frozen(args.fixtures)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    if args.action == "verify":
        rows = priors(args.package.resolve(),args.fixtures,args.out.parent)
    else:
        if not args.roster or not args.runs:
            parser.error("collect needs --roster and --runs")
        rows = collect(args.package.resolve(),args.fixtures,args.runs,read(args.roster))
    write(args.out, {"scorerLock":SCORER_LOCK, "fixtureLocks":PINS, args.action:rows})


if __name__ == "__main__":
    main()
