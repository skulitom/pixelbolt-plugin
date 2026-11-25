"""Run private oracle regressions, including underpaint and a depth-only mutation."""
import argparse
import copy
import json
import tempfile
from pathlib import Path

from PIL import Image

from oracle import ROOT, call, evaluate, read


def integration(cli,case,source,work):
    work.mkdir()
    pose = work/"source.json"
    pose.write_text(json.dumps(source),encoding="utf-8")
    call(cli,"compile",pose,"--out",work/"compiled.json","--metadata",work/"metadata.json")
    call(cli,"render",work/"compiled.json","--out",work/"export","--gif")
    return evaluate(case,read(work/"compiled.json"),read(work/"metadata.json"),
                    work/"export",cli,work)


def sample_hidden_ink(source):
    # Continue the station lantern by two dark metal pixels under the foreground
    # leg. Both are hidden at rest and can become visible when that boot lifts.
    pose = source["poses"][0]
    body = next(p for p in pose["parts"] if p["name"]=="body")
    grid = source["parts"][body["part"]]["rows"]
    ox,oy = pose["origin"]
    bx,by = body["at"]
    for source_x,source_y in [(19,27),(19,28)]:
        x,y = source_x+4-ox-bx,source_y+4-oy-by
        key = grid[y][x+1]
        assert key!="." and grid[y][x]=="."
        grid[y] = grid[y][:x]+key+grid[y][x+1:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli",required=True)
    parser.add_argument("--out",type=Path)
    args = parser.parse_args()
    summary = {}
    for name,count in [("station",3),("quarry",4)]:
        case = ROOT/name
        refs = case/"private"
        for variant in ("starter","control"):
            root = refs/variant
            result = evaluate(case,read(root/"compiled.json"),read(root/"metadata.json"),root/"export")
            assert result["pass"]==(variant=="control")
            assert result["failures"].get("standingMaterialOwner",0)==(count if variant=="starter" else 0)
            assert not result["failures"].get("standingPixels")
            summary[name+"-"+variant] = result["failures"]
        with tempfile.TemporaryDirectory(dir=ROOT) as folder:
            temp = Path(folder)
            good = read(refs/"control"/"sprite.poses.json")
            if name=="station":
                alternative = copy.deepcopy(good)
                sample_hidden_ink(alternative)
                result = integration(args.cli,case,alternative,temp/"alternative")
                assert result["pass"],result["failures"]
                changed = 0
                for before in (refs/"control"/"export"/"frames").glob("walk*.png"):
                    after = temp/"alternative"/"export"/"frames"/before.name
                    left = Image.open(before).convert("RGBA")
                    right = Image.open(after).convert("RGBA")
                    changed += sum(a!=b for a,b in zip(left.getdata(),right.getdata()))
                assert changed>0, "Alternative underpaint must actually become visible in a walk."
                summary["station-underpaint"]={"pass":True,"changedWalkingPixels":changed}
            else:
                parts = good["poses"][0]["parts"]
                parts.sort(key=lambda p:["body","footA","footB","armA","armB"].index(p["name"]))
                result = integration(args.cli,case,good,temp/"other-depth")
                errors = result["failures"]
                assert errors.get("foregroundCrossing",0)>0 and not errors.get("standingMaterialOwner")
                summary["quarry-depth-only"] = errors
    results = json.dumps(summary,indent=2)
    if args.out:
        args.out.write_text(results+"\n",encoding="utf-8")
    print(results)


if __name__=="__main__":
    main()
