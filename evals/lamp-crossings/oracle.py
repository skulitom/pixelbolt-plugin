"""Score original-frame semantic paint against source ownership and delivered PNGs.

The offline path needs only Pillow and reference files. With --source, compile the
delivered source using the supplied public Pixelbolt executable.
"""
import argparse
import json
import math
import shutil
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent
DEPTH = ["body","footA","armA","footB","armB"]
TRACKED = ("lamp","nearBoot","farBoot")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def points(rectangles):
    return {(x,y) for left,top,w,h in rectangles for y in range(top,top+h)
            for x in range(left,left+w)}


def offsets(truth):
    # The signed horizontal landings, foot elevation and torso rise are animation
    # direction on the artist's exposure sheet, expressed at half resolution.
    travel = [2,1,0,-1,-2,-1,0,1]
    elevation = [0,0,0,0,0,1,2,1]
    bob = [0,0,2,1,0,0,2,1]
    sign = 1 if truth["direction"] == "right" else -1
    rounded = lambda value: math.floor(value+.5)
    result = {key:[] for key in DEPTH}
    for frame in range(8):
        rise = -rounded(bob[frame]*truth["bob"]/2)
        result["body"].append((0,rise))
        for pair, advance in [("A",0),("B",4)]:
            index = (frame+advance)%8
            phase = travel[index]
            reach = sign*((phase>0)-(phase<0))
            result["foot"+pair].append((reach*rounded(abs(phase)*truth["stride"]/2),
                         -rounded(elevation[index]*truth["lift"]/2)))
            result["arm"+pair].append((-reach*rounded(abs(phase)*truth["stride"]/4),rise))
    return result


def projected_surfaces(truth, masks, motion, step):
    screen = {}
    objects = {}
    margin = truth["margin"]
    for role in DEPTH:
        dx,dy = motion[role][step]
        for layer, assigned in truth["roles"].items():
            if assigned != role:
                continue
            drawn = {(x+margin+dx,y+margin+dy):(x,y) for x,y in masks[layer]}
            objects[layer] = drawn
            for point, source in drawn.items():
                screen[point] = (layer,source)
    return screen,objects


def get_topology(truth):
    masks = {k:points(v) for k,v in truth["sourceVisibleMasks"].items()}
    motion = offsets(truth)
    source_hidden = set()
    source_revealed = set()
    steps = []
    for step in range(8):
        screen, layers = projected_surfaces(truth,masks,motion,step)
        crossing = [p for p in layers["nearBoot"].keys() & layers["lamp"].keys()
                    if screen[p][0] == "nearBoot"]
        source_hidden.update(layers["lamp"][p] for p in crossing)
        source_revealed.update(src for layer,src in screen.values() if layer=="lamp")
        steps.append({"frame":step+1, "bootCoversLamp":len(crossing),
                      "visibleLamp":sum(layer=="lamp" for layer,_ in screen.values())})
    return {"sourceLampPixels":len(masks["lamp"]), "sourceNearBootPixels":len(masks["nearBoot"]),
            "sourceFarBootPixels":len(masks["farBoot"]),
            "lampPixelsCoveredAndRevealed":len(source_hidden & source_revealed),"steps":steps}


def inspect_layers(recipe, frame):
    # Public recipe representation produced by compile of a native cutout.
    # The last opaque stroke is the actually visible owner, even if its RGBA
    # matches an earlier layer. Underpaint therefore remains permitted.
    visible = {}
    rgba = {}
    for layer in frame["layers"]:
        if set(layer)-{"name","ops","palette"}:
            raise ValueError("Additional layer settings require public layer rendering with --cli.")
        for op in layer["ops"]:
            if op["op"] == "grid" and set(op) <= {"op","rows","x","y"}:
                rows = op["rows"]
            elif op["op"] == "stamp" and set(op) <= {"op","symbol","x","y"}:
                rows = recipe["symbols"][op["symbol"]]
            else:
                raise ValueError("Non-grid layer in candidate. Use --cli to isolate it with the public renderer.")
            if not isinstance(rows,list):
                raise ValueError("A transformed symbol requires public layer rendering with --cli.")
            palette = {**recipe["palette"], **layer.get("palette",{})}
            for j,row in enumerate(rows):
                for i,key in enumerate(row):
                    if key == ".":
                        continue
                    color = bytes.fromhex(palette[key].lstrip("#"))
                    color = tuple(color) if len(color)==4 else (*color,255)
                    if color[3] == 0:
                        continue
                    if color[3] != 255:
                        raise ValueError("The reference sprite has opaque or transparent material.")
                    p = op.get("x",0)+i,op.get("y",0)+j
                    visible[p] = layer["name"]
                    rgba[p] = color
    return visible,rgba


def call(cli,*args):
    executable = Path(shutil.which(cli) or cli).resolve()
    result = subprocess.run([executable,*map(str,args)],capture_output=True,text=True)
    if result.returncode:
        raise RuntimeError(result.stdout+result.stderr)


def isolated_layers(cli, recipe, temp):
    layers = []
    for frame in recipe["frames"]:
        for i,layer in enumerate(frame["layers"]):
            key = "f"+str(len(layers))
            layers.append((frame["name"],layer["name"],key,dict(frame,name=key,layers=[layer])))
    isolated = dict(recipe,frames=[entry[-1] for entry in layers],animations={})
    f = temp/"layers.json"
    f.write_text(json.dumps(isolated),encoding="utf-8")
    out = temp/"layer-images"
    call(cli,"render",f,"--out",out,"--scale","1")
    result = {}
    for frame,layer,key,_ in layers:
        visible,rgba = result.setdefault(frame, ({},{}))
        img = Image.open(out/"frames"/(key+".png")).convert("RGBA")
        for p in [(x,y) for y in range(img.height) for x in range(img.width)]:
            color = img.getpixel(p)
            if color[3] == 255:
                visible[p],rgba[p] = layer,color
            elif color[3] != 0:
                raise ValueError("Fixture scoring requires opaque or transparent material.")
    return result


def transparent_black(image):
    result = Image.new("RGBA", image.size)
    return Image.alpha_composite(result,image.convert("RGBA"))


def evaluate(case,recipe,meta,export,cli=None,temp=None,gif=None):
    truth = read(case/"private"/"truth.json")
    masks = {k:points(v) for k,v in truth["sourceVisibleMasks"].items()}
    original = Image.open(case/"participant"/"sprite.png").convert("RGBA")
    motion = offsets(truth)
    stand = "stand-"+truth["direction"]
    walk = "walk-"+truth["direction"]
    export = Path(export)
    atlas_file, = export.glob("*.atlas.json")
    atlas = read(atlas_file)
    sheet = Image.open(export/atlas["meta"]["image"]).convert("RGBA")
    frames = {f["name"]:f for f in recipe["frames"]}
    walk_order = recipe["animations"][walk]["frames"]
    if len(walk_order)!=8 or len(set(walk_order))!=8:
        raise ValueError("Expected eight distinct walking frames.")
    if len(recipe["animations"][stand]["frames"])!=1:
        raise ValueError("Expected a single standing frame.")
    rest, = recipe["animations"][stand]["frames"]
    checked = [rest,*walk_order]
    try:
        frame_data = {name:inspect_layers(recipe,frames[name]) for name in checked}
    except ValueError:
        if not cli:
            raise
        frame_data = isolated_layers(cli,recipe,temp)
    counters = Counter()
    examples = {}
    def fail(kind,info):
        counters[kind] += 1
        subset = examples.setdefault(kind,[])
        if len(subset) < 6:
            subset.append(info)

    # Classify each placed part by its eight realized displacements. Instance names
    # can differ from the starter names and multiple parts can ride one carrier.
    correspondence = {}
    pose_meta = meta["poses"]
    for layer,descriptor in pose_meta[rest]["parts"].items():
        root = descriptor["anchor"]
        observed = []
        for frame in walk_order:
            if layer not in pose_meta[frame]["parts"]:
                break
            here = pose_meta[frame]["parts"][layer]["anchor"]
            observed.append((here[0]-root[0],here[1]-root[1]))
        correspondence[layer] = next((r for r,offset in motion.items() if observed==offset),"unclassified")
    # Both boots must retain their authored eight displacements even on a step
    # when the front boot hides the other from the visible witness pixels.
    for foot in ("footA","footB"):
        if foot not in correspondence.values():
            fail("bootTrajectory",foot)
    role = lambda layer: correspondence.get(layer,"unclassified")
    margin = truth["margin"]
    expected_size = (original.width+2*margin, original.height+2*margin)
    pivot = [p+margin for p in truth["sourcePivot"]]
    if (recipe["width"],recipe["height"]) != expected_size:
        fail("sourceCanvas", [recipe["width"],recipe["height"]])
    if list(atlas["animations"][walk]["frames"]) != list(walk_order):
        fail("atlasFrameOrder",walk)
    if atlas["animations"][walk].get("loop",True) is not True:
        fail("walkLoop",walk)
    exported = {}
    for name in checked:
        item = atlas["frames"][name]
        if [item["anchorPx"]["x"],item["anchorPx"]["y"]]!=pivot or pose_meta[name]["origin"]!=pivot:
            fail("groundAnchor",name)
        if name!=rest and item["duration"]!=truth["duration"]:
            fail("timing",name)
        image = Image.open(export/"frames"/(name+".png")).convert("RGBA")
        if image.size!=expected_size:
            raise ValueError("Export must have native-size PNG frames.")
        data = frame_data[name][1]
        rect = item["frame"]
        crop = sheet.crop((rect["x"],rect["y"],rect["x"]+rect["w"],rect["y"]+rect["h"]))
        if crop.size!=image.size or crop.tobytes()!=image.tobytes():
            fail("sheetFrameAgreement",name)
        for x in range(image.width):
            for y in range(image.height):
                rgba = image.getpixel((x,y))
                if rgba!=data.get((x,y),(0,0,0,0)):
                    fail("sourceExportAgreement",[name,x,y])
                if name==rest:
                    ox,oy = x-margin,y-margin
                    expected = original.getpixel((ox,oy)) if 0<=ox<original.width and 0<=oy<original.height else (0,0,0,0)
                    if rgba!=expected:
                        fail("standingPixels",[x,y])
        exported[name] = image
    gif_path = Path(gif) if gif else export/"gifs"/(walk+".gif")
    if not gif_path.is_file():
        fail("walkGifMissing",gif_path.name)
    else:
        with Image.open(gif_path) as animation:
            if animation.n_frames!=8 or animation.info.get("loop")!=0:
                fail("walkGifLoop",[animation.n_frames,animation.info.get("loop")])
            native_w,native_h = expected_size
            scale = animation.width//native_w
            if scale<1 or animation.size!=(scale*native_w,scale*native_h):
                fail("walkGifCanvas",list(animation.size))
            else:
                for step,frame in enumerate(walk_order[:animation.n_frames]):
                    animation.seek(step)
                    if animation.info.get("duration")!=truth["duration"]:
                        fail("walkGifTiming",frame)
                    reference = exported[frame].resize(animation.size,Image.Resampling.NEAREST)
                    if transparent_black(animation).tobytes()!=transparent_black(reference).tobytes():
                        fail("walkGifFrameAgreement",frame)
    rest_visible = frame_data[rest][0]
    for layer in TRACKED:
        for x,y in sorted(masks[layer]):
            actual = role(rest_visible.get((x+margin,y+margin)))
            if actual!=truth["roles"][layer]:
                fail("standingMaterialOwner",[layer,x,y,actual])
    for step,frame in enumerate(walk_order):
        screen,layers = projected_surfaces(truth,masks,motion,step)
        rendered = exported[frame]
        visible = frame_data[frame][0]
        for dest,(layer,source) in screen.items():
            if layer not in TRACKED:
                continue
            if role(visible.get(dest))!=truth["roles"][layer]:
                fail("walkingMaterialOwner",[frame,layer,source,dest])
            if rendered.getpixel(dest)!=original.getpixel(source):
                fail("walkingMaterialRGBA",[frame,layer,source,dest])
            if dest in layers["lamp"] and dest in layers["nearBoot"] and layer=="nearBoot":
                if role(visible.get(dest))!=truth["roles"]["nearBoot"] or rendered.getpixel(dest)!=original.getpixel(source):
                    fail("foregroundCrossing",[frame,source,dest])
        # Would a foot carry any original lamp rim into exposed air? A hidden layer
        # beneath a correct visible owner never triggers this probe.
        dx,dy = motion["footB"][step]
        legitimate_foot = points(truth["sourcePaintedMasks"]["nearBoot"])
        for source in sorted(masks["lamp"]-legitimate_foot):
            x,y = source
            dest = (x+margin+dx,y+margin+dy)
            if dest not in screen and role(visible.get(dest))=="footB" and rendered.getpixel(dest)==original.getpixel(source):
                fail("visibleCarriedPropOutsideBoot",[frame,source,dest])
    def clear(*categories):
        return all(counters[key] == 0 for key in categories)
    checks = {
        "standing":clear("standingPixels","sourceCanvas"),
        "gait":clear("bootTrajectory","groundAnchor","timing","walkGifTiming","walkLoop","atlasFrameOrder"),
        "ownership":clear("standingMaterialOwner","walkingMaterialOwner","foregroundCrossing","visibleCarriedPropOutsideBoot"),
        "walkingColors":clear("walkingMaterialRGBA"),
    }
    return {"pass":not counters,"checks":checks,"failures":dict(counters),"examples":examples,
            "observedRoles":correspondence, "topology":get_topology(truth)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--case",choices=["station","quarry"],required=True)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--reference",choices=["starter","control"])
    group.add_argument("--source",type=Path)
    p.add_argument("--cli")
    p.add_argument("--export",type=Path)
    p.add_argument("--gif",type=Path,help="walk GIF, if delivered separately from the exported gifs directory")
    p.add_argument("--out",type=Path)
    args = p.parse_args()
    case = ROOT/args.case
    with tempfile.TemporaryDirectory(dir=ROOT) as folder:
        temp = Path(folder)
        if args.reference:
            root = case/"private"/args.reference
            export = args.export or root/"export"
        else:
            if not args.cli or not args.export:
                p.error("--source requires --cli and the delivered --export directory")
            root = temp
            call(args.cli,"compile",args.source,"--out",root/"compiled.json","--metadata",root/"metadata.json")
            export = args.export
        result = evaluate(case,read(root/"compiled.json"),read(root/"metadata.json"),export,args.cli,temp,args.gif)
    report = json.dumps(result,indent=2)
    if args.out:
        args.out.write_text(report+"\n",encoding="utf-8")
    print(report)
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
