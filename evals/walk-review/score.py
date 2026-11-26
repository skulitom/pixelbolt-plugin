"""Score a neutral submission using a pinned renderer and private artist witnesses."""
import argparse
import base64
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from PIL import Image


def read(path):
    return json.loads(path.read_bytes())


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(data, indent=2) + "\n").encode())


def native(package, source):
    with tempfile.TemporaryDirectory() as temp:
        out = Path(temp) / "native.json"
        run = subprocess.run(["node", Path(__file__).with_name("native.mjs"), package, source, out],
                             capture_output=True, text=True)
        if run.returncode:
            raise ValueError("native renderer failed: " + run.stderr[:1600])
        data = read(out)
    for frame in data["frames"].values():
        frame["rgba"] = base64.b64decode(frame["rgba"])
        frame["owners"] = [data["names"][v-1] if v else None for v in base64.b64decode(frame["owners"])]
        frame["coverage"] = {name:base64.b64decode(bits) for name,bits in frame["coverage"].items()}
    return data


def png(path):
    with Image.open(path) as file:
        return file.convert("RGBA")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_bundle(root, data):
    atlases = list(root.glob("*.atlas.json"))
    require(len(atlases) == 1, "expected one atlas under " + str(root))
    atlas = read(atlases[0])
    size = data["width"], data["height"]
    names = set(data["frames"])
    require(set(atlas["frames"]) == names and {p.stem for p in (root/"frames").glob("*.png")} == names,
            "frame PNG or atlas membership mismatch")
    sheet_name = atlas["meta"]["image"]
    require(Path(sheet_name).name == sheet_name and atlas["meta"]["scale"] == "1", "atlas must name a native sheet")
    sheet = png(root / sheet_name)
    require(atlas["meta"]["size"] == dict(zip(("w", "h"), sheet.size)), "atlas sheet dimensions mismatch")
    for name, frame in data["frames"].items():
        image = png(root / "frames" / (name+".png"))
        require(image.size == size and image.tobytes() == frame["rgba"], "native PNG mismatch in " + name)
        record = atlas["frames"][name]
        r, d = record["frame"], record["spriteSourceSize"]
        require(not record["rotated"] and record["sourceSize"] == dict(zip(("w","h"),size))
                and (r["w"],r["h"]) == (d["w"],d["h"]), "invalid frame rectangle in " + name)
        for rect, limit in [(r, sheet.size), (d, size)]:
            require(0 <= rect["x"] < rect["x"] + rect["w"] <= limit[0] and
                    0 <= rect["y"] < rect["y"] + rect["h"] <= limit[1], "frame out of bounds in " + name)
        crop = sheet.crop((r["x"], r["y"], r["x"]+r["w"], r["y"]+r["h"]))
        full = Image.new("RGBA", size)
        full.paste(crop, (d["x"], d["y"]))
        require(full.tobytes() == frame["rgba"] and record["duration"] == frame["duration"], "atlas mismatch in " + name)
        anchor = frame["anchor"]
        require(record.get("anchorPx") == dict(zip("xy",anchor)), "atlas anchor mismatch in " + name)
        xy = dict(zip("xy", (round(a / s, 6) for a, s in zip(anchor, size))))
        require(record.get("pivot") == xy and record.get("anchor") == xy, "normalized atlas pivot mismatch in " + name)
    require(set(atlas["animations"]) == set(data["clips"]), "atlas animation membership mismatch")
    for clip, sequence in data["clips"].items():
        entry = atlas["animations"][clip]
        require(entry["frames"] == sequence["frames"] and entry["loop"] == sequence["loop"] and
                entry["duration"] == sum(data["frames"][n]["duration"] for n in sequence["frames"]),
                "atlas playback mismatch in " + clip)


def verify_gif(path, data, clip):
    size = data["width"], data["height"]
    sequence = data["clips"][clip]
    actual, expected = [], []

    def append(target, picture, duration):
        # GIF transparency has no RGB. Preserve alpha itself while discarding
        # only RGB hidden behind zero alpha, including after frame disposal.
        rgba = picture.tobytes()
        visible = b"".join(rgba[i:i+4] if rgba[i+3] else b"\0\0\0\0" for i in range(0,len(rgba),4))
        if target and target[-1][0] == visible:
            target[-1][1] += duration
        else:
            target.append([visible, duration])

    with Image.open(path) as gif:
        require(gif.format == "GIF" and gif.size == size and
                (gif.info.get("loop") == 0) == sequence["loop"], "GIF loop or canvas mismatch in " + clip)
        for index in range(gif.n_frames):
            gif.seek(index)
            append(actual, gif.convert("RGBA"), gif.info.get("duration", 0))
    carry = 0
    for name in sequence["frames"]:
        frame = data["frames"][name]
        exact = frame["duration"] + carry
        duration = max(20, (exact+5)//10*10)
        carry = 0 if exact < 20 else exact - duration
        append(expected, Image.frombytes("RGBA",size,frame["rgba"]), duration)
    require(actual == expected, "GIF pixels or playback mismatch in " + clip)


def verify_export(folder, data):
    verify_bundle(folder/"export", data)
    gifs = [*folder.glob("*.gif"), *(folder/"export"/"gifs").glob("*.gif")]
    required = {name for name, seq in data["clips"].items() if seq.get("rest")}
    require(required <= {p.stem for p in folder.glob("*.gif")}, "missing requested walk GIF")
    for path in gifs:
        require(path.stem in data["clips"], "unrecognised delivered GIF " + path.name)
        verify_gif(path, data, path.stem)
    return {"frames": len(data["frames"]), "atlasAnimations": len(data["clips"]), "gifs": len(gifs)}


def verify_first(folder, data):
    atlases = list(folder.rglob("*.atlas.json"))
    if atlases:
        for path in atlases:
            verify_bundle(path.parent, data)
    else:
        images = list(folder.rglob("*.png"))
        names = {p.stem: p for p in images if p.stem in data["frames"]}
        if set(names) == set(data["frames"]):
            for name, path in names.items():
                im = png(path)
                require(im.size == (data["width"],data["height"]) and
                        im.tobytes() == data["frames"][name]["rgba"], "first native PNG mismatch in " + name)
        else:
            sheet = data["sheet"]
            def matches(path):
                im = png(path)
                return (im.size == (sheet["width"],sheet["height"]) and
                        hashlib.sha256(im.tobytes()).hexdigest() == sheet["rgbaSha256"])
            require(any(matches(path) for path in images), "missing matching initial native frame set or sheet under first/")
    for path in folder.rglob("*.gif"):
        require(path.stem in data["clips"], "unrecognised initial GIF " + path.name)
        verify_gif(path, data, path.stem)


def rgba(frame, index):
    return frame["rgba"][4*index:4*index+4]


def tracks(data, seq):
    """Eight displacements from this facing's stand. Ignore the grid's local pivot."""
    stand = data["frames"][seq["rest"]]["parts"]
    result = {}
    for name, start in stand.items():
        poses = [data["frames"][n]["parts"].get(name) for n in seq["frames"]]
        if all(p is not None for p in poses):
            result[name] = tuple((p[0]-start[0], p[1]-start[1]) for p in poses)
    return result


def lineage(data, stand, part):
    chain = set()
    parents = data.get("parents", {}).get(stand, {})
    while part and part not in chain:
        chain.add(part)
        part = parents.get(part)
    return chain


def owner_ok(want, got, track_w, track_g, truth, actual, stand, sensitive):
    if want is None or got is None:
        return want == got
    if want not in track_w or got not in track_g or track_w[want] != track_g[got]:
        return False
    if want == got or not sensitive:
        return True
    # A patch attached to the semantic part (or a replacement on its carrier)
    # may have a new name. Distinct pre-existing siblings keep their own contours.
    if want in lineage(actual, stand, got):
        return True
    return got not in track_w and bool(lineage(truth, stand, want) & lineage(actual, stand, got))


def local_underpaint(frame, x, y, width, height, owner, color):
    # A finger-width native neighbourhood includes the next band of the same
    # material even when the adjoining pixels are hidden by the crossing limb.
    # Only the original owner's colours inside this seven-pixel square qualify.
    for yy in range(max(0,y-3), min(height,y+4)):
        for xx in range(max(0,x-3), min(width,x+4)):
            i = yy*width+xx
            if frame["owners"][i] == owner and rgba(frame, i) == color:
                return True
    return False


def crossing_layers(frame, i):
    return [p for p,bits in frame["coverage"].items()
            if bits[i//8] & (1 << (i%8)) and p != frame["owners"][i]]


def grade(truth, actual, witnesses, family, strict, supplied=None):
    supplied = truth if supplied is None else supplied
    w, h = truth["width"], truth["height"]
    require((w,h) == (actual["width"],actual["height"]), "canvas changed")
    checks = {"clips": truth["clips"] == actual["clips"],
              "frames": set(truth["frames"]) == set(actual["frames"]),
              "anchorsTiming": True, "standingRGBA": True, "gait": True}
    require(set(truth["frames"]) <= set(actual["frames"]), "required frames missing")
    groups, masks = [], defaultdict(lambda: defaultdict(list))
    for category in ("defects","controls"):
        for witness in witnesses[category]:
            group = dict(category=category, kind=witness["kind"], id=witness.get("id"), tested=0, failed=0, examples=[])
            groups.append(group)
            for name, coords in witness["frames"].items():
                require(name in truth["frames"], "witness frame missing")
                for x,y in coords:
                    require(0 <= x < w and 0 <= y < h, "witness out of canvas")
                    masks[name][y*w+x].append(group)
                    group["tested"] += 1
            require(group["tested"], "empty witness")
    context = {}
    for clip, seq in truth["clips"].items():
        stand = seq.get("rest")
        if not stand:
            continue
        ref = png(family / ("stand-"+seq["direction"]+".png"))
        baseline = truth["frames"][stand]
        require(ref.size == (w,h) and ref.tobytes() == baseline["rgba"], "frozen stand PNG mismatch")
        checks["standingRGBA"] &= actual["frames"][stand]["rgba"] == baseline["rgba"]
        tw, ta, ti = (tracks(d, seq) for d in (truth,actual,supplied))
        # Existing named parts keep their phase. Replacements may use new
        # grids as long as every artist motion remains and the visible paint follows it.
        checks["gait"] &= set(tw.values()) <= set(ta.values()) and all(tw[p] == ta[p] for p in tw.keys() & ta.keys())
        context[stand] = (stand,tw,ta,ti,None)
        for step, name in enumerate(seq["frames"]):
            context[name] = (stand,tw,ta,ti,step)
    diffs = Counter(rgba=0, ownership=0, carrier=0, alternateUnderpaint=0, visibleCollateral=0,
                    carrierCollateral=0, outsideWitnessRGBA=0)
    examples = []
    for name, wanted in truth["frames"].items():
        got, given = actual["frames"][name], supplied["frames"][name]
        checks["anchorsTiming"] &= wanted["anchor"] == got["anchor"] and wanted["duration"] == got["duration"]
        require(name in context, "unmapped artist frame " + name)
        stand, tw, ta, ti, phase = context[name]
        for i, (wo, go, io) in enumerate(zip(wanted["owners"],got["owners"],given["owners"])):
            ww, gg, ii = rgba(wanted,i), rgba(got,i), rgba(given,i)
            marked = masks[name].get(i, ())
            sensitive = any(g["kind"] in ("crossing","equipment") for g in marked)
            ow = owner_ok(wo,go,tw,ta,truth,actual,stand,sensitive)
            prior_owner = owner_ok(wo,io,tw,ti,truth,supplied,stand,sensitive)
            diffs["rgba"] += ww != gg
            diffs["ownership"] += wo != go
            diffs["carrier"] += not ow
            x, y = i % w, i // w
            alternate = False
            if (not strict and phase is not None and marked and ow and wo and ww != gg and ii != ww
                    and gg != ii and gg[3] == ww[3] == 255
                    and all(g["category"] == "defects" and g["kind"] in ("joint","shaft") for g in marked)):
                dx, dy = tw[wo][phase]
                xx, yy = x-dx, y-dy
                was_hidden = (0 <= xx < w and 0 <= yy < h and
                              truth["frames"][stand]["owners"][yy*w+xx] != wo)
                alternate = was_hidden and local_underpaint(wanted,x,y,w,h,wo,gg)
                diffs["alternateUnderpaint"] += alternate
            color_ok = ww == gg or alternate
            for group in marked:
                depth_ok = True
                if group["kind"] == "crossing":
                    behind = crossing_layers(wanted,i)
                    require(behind and wo is not None, "invalid artist crossing witness")
                    mobile = [p for p in behind if tw[p] != tw[wo]]
                    depth_ok = any(owner_ok(a,b,tw,ta,truth,actual,stand,True)
                                   for a in (mobile or behind) for b in crossing_layers(got,i))
                if not (color_ok and ow and depth_ok):
                    group["failed"] += 1
                    if len(group["examples"]) < 5:
                        group["examples"].append([name,x,y])
            collateral = not color_ok and ww == ii
            diffs["visibleCollateral"] += collateral
            diffs["carrierCollateral"] += not ow and prior_owner
            diffs["outsideWitnessRGBA"] += not marked and ww != gg
            if collateral and len(examples) < 10:
                examples.append([name,x,y])
    checks["noVisibleCollateral"] = diffs["visibleCollateral"] == 0 and diffs["outsideWitnessRGBA"] == 0
    checks["noCarrierRegressions"] = diffs["carrierCollateral"] == 0
    if strict:
        checks["cleanPixelsAndCarriers"] = not (diffs["rgba"] or diffs["carrier"])
    return dict(passed=all(checks.values()) and not any(g["failed"] for g in groups),
                checks=checks, differences=dict(diffs), collateralExamples=examples, witnesses=groups)


def score(package, family, job, variant):
    truth = native(package, family/"clean.poses.json")
    supplied_file = family/(variant+".poses.json")
    supplied = truth if variant == "clean" else native(package, supplied_file)
    witnesses = read(family/"witnesses.json")
    provenance = (job/"actor.poses.json").read_bytes() == supplied_file.read_bytes()
    report = {}
    for phase, source in [("first",job/"actor.poses.json"),("final",job/"final/source.poses.json")]:
        try:
            data = supplied if phase == "first" and provenance else native(package, source)
            record = grade(truth,data,witnesses,family,variant == "clean",supplied)
            record["checks"]["suppliedSourceIntact"] = provenance
            record["passed"] &= provenance
            try:
                if phase == "final":
                    record["delivery"] = verify_export(job/"final",data)
                    require((job/"review.md").read_text(encoding="utf-8-sig").strip(), "review.md is empty")
                else:
                    verify_first(job/"first", data)
                record["exports"] = True
            except (ValueError, KeyError, OSError, TypeError) as error:
                record.update(exports=False,exportError=str(error),passed=False)
            report[phase] = record
        except (ValueError, KeyError, OSError, TypeError) as error:
            report[phase] = dict(passed=False,error=str(error))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("package","family","job","out"):
        parser.add_argument("--"+name, required=True, type=Path)
    parser.add_argument("--variant", required=True, choices=("clean","damaged"))
    args = parser.parse_args()
    write(args.out, score(args.package,args.family,args.job,args.variant))


if __name__ == "__main__":
    main()
