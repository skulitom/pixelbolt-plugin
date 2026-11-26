"""Package neutral handoffs, submitted art, and locked evaluation evidence for offline review."""
import argparse
from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json


def add_tree(archive, source, label):
    for path in sorted(source.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            archive.write(path,(Path(label)/path.relative_to(source)).as_posix())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="Directory containing jobs, grading, receipts, and candidate/lock.json")
    parser.add_argument("output",type=Path)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    lock = json.loads((args.run/"candidate/lock.json").read_text())
    with ZipFile(args.output,"w",ZIP_DEFLATED,compresslevel=6) as archive:
        for file in ("README.md","results.md","results.json","localization.json"):
            archive.write(here/file,file)
        add_tree(archive,here/"fixtures","fixtures")
        add_tree(archive,here/"previews","previews")
        add_tree(archive,here/"submissions","submissions")
        for file in ("native.mjs","score.py","stage.mjs","compare.py","replay.py","localize.py","rebuild.py","SCORER-LOCK.json"):
            archive.write(here/file,file)
        archive.write(args.run/"candidate/lock.json","evidence/builds.json")
        archive.write(args.run/"grading/roster.json","evidence/roster.json")
        archive.write(args.run/"grading/submission-seals.json","evidence/submission-seals.json")
        archive.write(args.run/"grading/SCORER-LOCK.json","evidence/scorer.json")
        for tier in ("baseline","candidate"):
            tarball, = (args.run/tier).glob("*.tgz")
            if sha256(tarball.read_bytes()).hexdigest() != lock[tier]["tarballSha256"]:
                raise ValueError("Build hash differs for "+tier)
            archive.write(tarball,"tools/"+tier+"/"+tarball.name)
        for job, family, variant in lock["jobs"]:
            path = args.run/"jobs"/job
            label = f"jobs/{job}"
            for name in ("actor.poses.json","brief.txt","task.txt","review.md"):
                archive.write(path/name,label+"/"+name)
            for file in sorted(path.glob("stand-*.png")):
                archive.write(file,label+"/"+file.name)
            add_tree(archive,path/"first",label+"/first")
            add_tree(archive,path/"final",label+"/final")
            archive.write(args.run/"grading"/(job+".json"),label+"/score.json")
            archive.write(args.run/"receipts"/(job+".json"),"receipts/"+job+".json")
    with ZipFile(args.output) as check:
        bad = check.testzip()
        if bad:
            raise ValueError("Archive integrity failed for "+bad)
        print(f"{len(check.namelist())} files, {args.output.stat().st_size} bytes, SHA-256 {sha256(args.output.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
