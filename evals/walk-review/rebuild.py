"""Render archived editable submissions with a pinned CLI and repeat the pixel scores."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess

from score import score


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package",type=Path,help="Installed baseline Pixelbolt package")
    parser.add_argument("out",type=Path,help="Fresh replay directory")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    rows = json.loads((here/"results.json").read_text())["collect"]
    args.out.mkdir(exist_ok=False)
    cli = args.package.resolve()/"bin/pixelbolt.js"
    def run(*arguments):
        subprocess.run(["node",cli,*arguments],check=True,stdout=subprocess.DEVNULL)
    summaries = []
    for row in rows:
        name, variant, family = row["job"], row["variant"], here/"fixtures"/row["family"]
        job = args.out/name
        job.mkdir()
        first, final = job/"first", job/"final"
        first.mkdir()
        final.mkdir()
        before, after = family/(variant+".poses.json"), here/"submissions"/name/"source.poses.json"
        if sha256(after.read_bytes()).hexdigest() != row["finalSourceSha256"]:
            raise ValueError("archived editable source differs: "+name)
        shutil.copyfile(before,job/"actor.poses.json")
        shutil.copyfile(after,final/"source.poses.json")
        shutil.copyfile(here/"submissions"/name/"review.md",job/"review.md")
        for folder,source in [(first,before),(final,after)]:
            recipe = folder/"compiled.json"
            run("compile",source,"--out",recipe)
            run("render",recipe,"--out",folder/"export","--scale","1")
            if folder == final:
                spec = json.loads(recipe.read_text(encoding="utf-8-sig"))
                for clip,anim in spec["animations"].items():
                    if len(anim["frames"]) > 1:
                        run("gif",recipe,"--animation",clip,"--scale","1","--out",folder/(clip+".gif"))
        result = score(args.package,family,job,variant)
        for phase in ("first","final"):
            # The replay creates new exports; original delivery failures are preserved in results.json.
            if result[phase].get("differences") != row[phase].get("differences") or result[phase].get("witnesses") != row[phase].get("witnesses"):
                raise ValueError("reconstructed art scores differ for "+name+" "+phase)
        summaries.append({"job":name,"rebuiltFirst":result["first"],"rebuiltFinal":result["final"]})
    (args.out/"replay.json").write_text(json.dumps(summaries,indent=2)+"\n")
    print(f"Reproduced the submitted source scores for {len(rows)} jobs.")


if __name__ == "__main__":
    main()
