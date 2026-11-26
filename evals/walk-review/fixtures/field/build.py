"""Build both salt-marsh surveyor pose sources and check their public CLI exports."""
import argparse
import copy
import json
import subprocess
import tempfile
from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent
SIZE = (38, 38)
ORIGIN = (19, 35)
PALETTE = {
    "k": "#262337", "d": "#393649", "b": "#404768", "s": "#48677e",
    "m": "#6392a2", "l": "#a1c7bc", "v": "#385052", "e": "#58766c",
    "g": "#8ba98a", "u": "#986445", "o": "#c38c46", "y": "#e7b865",
    "p": "#f6daa0", "r": "#a24d48", "a": "#e78362", "f": "#cb8969",
    "h": "#f2bf8c",
}


def grid(text):
    rows = text.strip().split()
    width = max(map(len, rows))
    return [row.ljust(width, ".") for row in rows]


def pole_grid(hoop_x, hoop_y, hoop, trail):
    points = {}
    for y, row in enumerate(grid(hoop)):
        for x, color in enumerate(row):
            if color != ".":
                points[hoop_x + x, hoop_y + y] = color
    for x, y in trail:
        points[x, y] = "y"
        points[x, y + 1] = "k"
    x0, y0 = min(x for x,y in points), min(y for x,y in points)
    x1, y1 = max(x for x,y in points), max(y for x,y in points)
    return ["".join(points.get((x,y), ".") for x in range(x0,x1+1))
            for y in range(y0,y1+1)], (x0,y0)


def make_source():
    parts, poses = {}, []

    def draw(view, title, x, y, art):
        name = f"{view}-{title}"
        parts[name] = {"rows": grid(art) if isinstance(art, str) else art}
        pose["parts"].append({"name": title, "part": name,
                              "at": [x-ORIGIN[0], y-ORIGIN[1]], "cleanup": False})

    def begin(view):
        pose = {"name": f"stand-{view}", "origin": list(ORIGIN), "parts": []}
        poses.append(pose)
        return pose

    pose = begin("right")
    def right(title, x, y, art):
        draw("right", title, x, y, art)

    right("sleeve-far", 19, 17, """
        ..kk.
        .kbsk
        .kssk
        ..ksk
        ..ksk
        ..ksk
        ..kdk
        ..kfk
        ..kffk
        ...kk.
    """)
    right("wader-far", 17, 24, """
        ..d.
        .kdk
        .kdk
        .kbk
        .kbk
        .kvk
        kvvek
        kveek
        kveekk
        kveeeek
        .kkkkkk
    """)
    right("wader-near", 13, 24, """
        ....d...
        ...ddk..
        ...dsk..
        ...dsk..
        ...kbsk.
        ...kvvk.
        ..keegk.
        ..kveek.
        ..kveekk
        ..kvegggk
        ...kkkkkk
    """)
    right("coat", 11, 14, """
        ....kkkkk....
        ...kssmmmk...
        ..kssmmllmk..
        ..ksmmllmsk..
        .kbsmmlmmmsk.
        .kbssmmmmmsk.
        .kbssmmmsssk.
        .kbssmmkkssk.
        .kbssmmplssk.
        .kbssmmsmssk.
        .kbssmmmmmsk.
        .kbssmmmmmssk
        .kbsssmmmmssk
        ..kbbsssssssk
        ...kkkbbsskk.
        ......kkkk...
    """)
    hoop_right, pos = pole_grid(2, 9, """
        ...kkkkk..
        .kkpylsuk.
        kpl....suk
        kl......uk
        ks......sk
        ks.....lsk
        .ks...lsk.
        .kss.lsk..
        ..kbssuk..
        ...kkkuuk.
        ......kuu.
    """, [(10,18),(11,19),(12,19),(13,20),(14,20),(15,21),(16,21),
          (17,22),(18,22),(19,23),(20,23),(21,24),(22,24),(23,25),(24,25)])
    right("net", *pos, hoop_right)
    right("sleeve-near", 14, 17, """
        ...kkk..
        ..ksmmk.
        .kssmlmk
        .kbsmmsk
        .kbsmmsk
        .kbsmsk.
        ..ksssk.
        ..kllsk.
        ...kddk.
        ...khfk.
        ...khffk
        ....kkk.
    """)
    right("scarf", 14, 14, """
        ...kkk...
        ..kraark.
        .kraaarrk
        ..krrrrk.
        ..karkk..
        .krrk....
        .kkk.....
    """)
    right("face", 13, 9, """
        ...kkkkkk...
        ..kruufhhk..
        .kruufhhhk..
        .kruuffhkhk.
        .kruhhhfhfkk
        .krufhfhhhfk
        ..kkufhfufk.
        ....kffhfk..
        .....kffk...
        ......kk....
    """)
    right("hat", 10, 2, """
        ......kkkkkk....
        ....kkyyyyook...
        ...kyyppyyook...
        ...kyppyyyyoouk.
        ..kyyyyyooooouk.
        ..kourrrrrrruuk.
        .koooyyyyyyyyook
        kkuuuuoooyyyppyyk
        .kkkkkkkkkkkuuuuk
        ............kkkk.
    """)

    pose = begin("down")
    def down(title, x, y, art):
        draw("down", title, x, y, art)
    down("sleeve-far", 20, 17, """
        ...kkk
        ..ksmmk
        ..kssmk
        ...kssk
        ...ksssk
        ...ksssk
        ....kslk
        ....kdfk
        ....kffk
        .....kk.
    """)
    down("wader-far", 20, 24, """
        .kddk.
        .kbsk.
        .kbsk.
        .kbsk.
        .kbsk.
        .kvvk.
        .keek.
        .kvek.
        .kveek
        kveggk
        kkkkkk
    """)
    down("wader-near", 13, 24, """
        ..kddk.
        ..kbsk.
        ..kbsk.
        ..kbsk.
        ..kbsk.
        ..kvvk.
        ..kegk.
        ..kvek.
        .kveek.
        kveggk.
        kkkkkk.
    """)
    down("coat", 12, 14, """
        .....kkkkk....
        ...kkssmmkk...
        ..kssmmmmmmk..
        .kssmmllmlmsk.
        .kbsmmlmmmlsk.
        .kbsmmsmmmssk.
        .kbsmmsmmmssk.
        .kbsmmsmskkbk.
        .kbsmmsmsllsk.
        .kbsmmsmsmssk.
        .kbsmmsmmmmmk.
        kbssmmsmmmmmsk
        kbsssmbsmmmmsk
        kbbssmbsmmsssk
        .kkkkkbssskkk.
        ......kkkk....
    """)
    hoop_down, pos = pole_grid(26, 6, """
        ...kkkk...
        .kkpllyk..
        kpl....yk.
        kl.....luk
        ks......uk
        ks.....lsk
        kbs...lsk.
        .kss.lsk..
        .kusskk...
        .kuukk....
        .kuu......
    """, [(27,16),(27,17),(26,17),(26,18),(25,18),(25,19),(24,19),
          (24,20),(23,20),(23,21),(22,21),(22,22),(21,22),(21,23),
          (20,23),(20,24),(19,24),(19,25),(18,25),(18,26),(17,26),
          (17,27),(16,27),(16,28)])
    down("net", *pos, hoop_down)
    down("sleeve-near", 10, 17, """
        ...kkk.
        ..ksmmk
        .ksmmlk
        .ksmmsk
        .ksmmsk
        .kssmsk
        .ksssk.
        .kllsk.
        ..kddk.
        ..kfhk.
        ..kffk.
        ...kk..
    """)
    down("scarf", 13, 14, """
        ...kkkkkkk..
        ..krrraaark.
        .krraaarrark
        ..krraarrkk.
        ...krrark...
        ....kark....
        ....krk.....
        ....kk......
    """)
    down("face", 12, 9, """
        ...kkkkkkkk..
        ..krufhhhhuk.
        .krufffhhhuk.
        .krukhfhkhuk.
        .kruhhffhhuk.
        ..kufhhfhfk..
        ...kufhhuk...
        ....kfffk....
        .....kkk.....
    """)
    down("hat", 9, 2, """
        ......kkkkkk.....
        .....kpyyyyok....
        ....kyppyyyook...
        ....kypyyyyyok...
        ...kyyyyyyooook..
        ...kurrrrrrruuk..
        ..kuooyyyyyyyook.
        .kyyyypppppyyyook
        kkuuuuuooyyuuuukk
        .kkkkkkkkkkkkkk..
    """)
    return {
        "format": "pixelforge-poses", "version": 1, "name": "saltmarsh-surveyor",
        "width": SIZE[0], "height": SIZE[1], "palette": PALETTE, "parts": parts,
        "poses": poses, "animations": {p["name"]: {"frames":[p["name"]]} for p in poses},
        "walkCycles": {
            f"walk-{view}": {
                "rest": f"stand-{view}", "direction": view,
                "feet": ["wader-far", "wader-near"], "arms": ["sleeve-far", "sleeve-near"],
                "stride": stride, "lift": lift, "bob": 1, "duration": 120
            } for view, stride, lift in (("right",4,2), ("down",2,1))
        },
        "sheet": {"columns": 8},
    }


def alter(source, part, edits):
    rows = source["parts"][part]["rows"]
    for x,y,color in edits:
        rows[y] = rows[y][:x] + color + rows[y][x+1:]


def worn_source(pristine):
    worn = copy.deepcopy(pristine)
    alter(worn, "right-wader-near", [
        (x, y, "s") for y in range(3) for x in range(4) if x < 3 or y == 0])
    sleeve = pristine["parts"]["right-sleeve-near"]["rows"]
    alter(worn, "right-coat", [(14+x-11,17+y-14,".")
          for y,row in enumerate(sleeve) for x,color in enumerate(row)
          if 2 <= y <= 7 and color != "."])
    return worn


def write_json(path, doc):
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pixelbolt", type=Path, help="Pixelbolt checkout")
    parser.add_argument("--out", type=Path, default=ROOT)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    clean = make_source()
    for name, source in [("clean", clean), ("damaged", worn_source(clean))]:
        write_json(args.out/f"{name}.poses.json", source)
    build_proofs(args.pixelbolt.resolve() / "bin" / "pixelbolt.js", args.out.resolve())


def build_proofs(cli, out):
    proofs = out / "proofs"
    proofs.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        frames, expanded, gait = {}, {}, {}
        for version in ["clean", "damaged"]:
            recipe = tmp/f"{version}.json"
            dest = tmp/version
            def run(*argv):
                result = subprocess.run(["node", str(cli), *map(str,argv)],
                                        capture_output=True,encoding="utf8")
                if result.returncode:
                    raise RuntimeError(result.stdout + result.stderr)
                return json.loads(result.stdout)
            run("compile", out/f"{version}.poses.json", "--out", recipe)
            run("validate",recipe)
            r = run("render",recipe,"--out",dest,"--look","--expect",json.dumps({
                "width": 38, "height": 38,
                "frames": {"stand-right": 1,"stand-down": 1,"walk-right":8,"walk-down":8}}))
            assert r["ok"] and r["check"]["ok"]
            expanded_file = tmp/f"{version}.expanded.json"
            run("compile", out/f"{version}.poses.json", "--expand", "--out",expanded_file)
            expanded[version] = json.loads(expanded_file.read_text("utf8"))
            frames[version] = {
                file.stem: Image.open(file).convert("RGBA") for file in (dest/"frames").glob("*.png")
            }
            gait[version] = {}
            for clip in ("walk-right","walk-down"):
                strip = tmp/f"{version}-{clip}-strip.png"
                r = run("inspect", out/f"{version}.poses.json", "--motion",clip,"--out",strip)
                gait[version][clip] = r["motion"]["cutout"]
                assert r["motion"]["duration"] == 960
            draw_preview(frames[version], proofs/f"{version}-walks.png")
        for name,image in frames["clean"].items():
            if name.startswith("stand-"):
                image.save(out/f"{name}.png")
        audit(frames, expanded, gait, out)


def draw_preview(frames, path):
    # Two facing strips retain playback order; the stand leads each one.
    w,h = SIZE
    sheet = Image.new("RGB",((w+1)*9+1,(h+1)*2+1),"#353548")
    for row,view in enumerate(("right","down")):
        for col,name in enumerate([f"stand-{view}"]+[f"walk-{view}-{i}" for i in range(1,9)]):
            frame = frames[name]
            tile = Image.new("RGBA",SIZE, "#ddd8c8")
            tile.alpha_composite(frame)
            sheet.paste(tile.convert("RGB"),(1+col*(w+1),1+row*(h+1)))
    sheet.resize((sheet.width*3,sheet.height*3), Image.Resampling.NEAREST).save(path)


def layers_for(doc,pose):
    layers, owners, composite = {}, {}, {}
    for part in pose["parts"]:
        placed = {}
        px,py = [a+b for a,b in zip(pose["origin"],part["at"])]
        for y,row in enumerate(doc["parts"][part["part"]]["rows"]):
            for x,k in enumerate(row):
                if k != ".":
                    at = (px+x, py+y)
                    assert 0 <= at[0] < SIZE[0] and 0 <= at[1] < SIZE[1]
                    placed[at] = k
                    owners[at] = part["name"]
                    composite[at] = k
        layers[part["name"]] = placed
    return layers,owners,composite


def empty_component(start,composite):
    assert start not in composite
    cells, queue = {start}, deque([start])
    while queue:
        x,y = queue.popleft()
        assert 0 < x < SIZE[0]-1 and 0 < y < SIZE[1]-1
        for at in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if at not in cells and at not in composite:
                cells.add(at)
                queue.append(at)
    return cells


def pixels(positions):
    return [list(at) for at in sorted(positions, key=lambda p:(p[1],p[0]))]


def audit(frames,expanded,gait,out):
    docs = {k:json.loads((out/f"{k}.poses.json").read_text("utf8")) for k in frames}
    for key in docs["clean"]:
        if key != "parts":
            assert docs["clean"][key] == docs["damaged"][key]
    assert docs["clean"]["parts"].keys() == docs["damaged"]["parts"].keys()
    assert len(set(PALETTE.values())) == len(PALETTE)
    rgba = {key: tuple(bytes.fromhex(value[1:])) + (255,) for key,value in PALETTE.items()}
    tab, seam, opening, crossing, equal_crossings = {}, {}, {}, {}, {}
    poses = expanded["clean"]["poses"]
    assert poses == expanded["damaged"]["poses"]
    for pose in poses:
        name = pose["name"]
        layers, owners, colors = {}, {}, {}
        for version in frames:
            layers[version],owners[version],colors[version] = layers_for(expanded[version],pose)
            image = frames[version][name]
            assert image.size == SIZE
            for y in range(SIZE[1]):
                for x in range(SIZE[0]):
                    wanted = rgba.get(colors[version].get((x,y)), (0,0,0,0))
                    assert image.getpixel((x,y)) == wanted
        clean, worn = colors.values()
        diff = {at for at in set(clean)|set(worn) if clean.get(at) != worn.get(at)}
        if "down" in name or name.startswith("stand-"):
            assert not diff and frames["clean"][name].tobytes() == frames["damaged"][name].tobytes()
        if name.startswith("stand-"):
            continue
        tab_pixels = {at for at in diff if owners["damaged"].get(at) == "wader-near"
                      and layers["clean"]["wader-near"].get(at) != layers["damaged"]["wader-near"][at]}
        seam_pixels = {at for at in diff if owners["clean"].get(at) == "coat"
                       and at not in layers["damaged"]["coat"]}
        assert tab_pixels.isdisjoint(seam_pixels) and diff == tab_pixels | seam_pixels
        if tab_pixels:
            tab[name] = pixels(tab_pixels)
        if seam_pixels:
            seam[name] = pixels(seam_pixels)
        # The four-connected alpha island enclosed inside the wire loop is a deliberate opening.
        is_right = "right" in name
        netpart = next(p for p in pose["parts"] if p["name"] == "net")
        net_origin = tuple(a+b for a,b in zip(pose["origin"],netpart["at"]))
        centre = (net_origin[0]+(5 if is_right else 15), net_origin[1]+4)
        hole = empty_component(centre,clean)
        assert len(hole) >= 12 and hole == empty_component(centre,worn)
        opening[name] = pixels(hole)
        if is_right:
            # A foreground sleeve travels over the handle. Keep equal-colour ownership witnesses.
            arm, pole = layers["clean"]["sleeve-near"],layers["clean"]["net"]
            crossed = {at for at in arm.keys() & pole.keys() if owners["clean"][at]=="sleeve-near"}
            assert crossed and all(owners["damaged"][at]=="sleeve-near" for at in crossed)
            assert not crossed & diff
            crossing[name] = pixels(crossed)
            twins = {at for at in crossed if arm[at] == pole[at]}
            if twins:
                equal_crossings[name] = pixels(twins)
    assert len(tab)>=2 and len(seam)>=2 and len(crossing)==8 and equal_crossings, (
        list(tab), list(seam), len(crossing), len(equal_crossings))
    assert max(map(len,tab.values())) >= 4 and max(map(len,seam.values())) >= 3
    for v in ("clean","damaged"):
        for clip,checks in gait[v].items():
            assert not checks["clipped"] and all(f["pixels"] == 0 for f in checks["slide"])
            if v=="clean":
                assert not checks["fixes"] and not checks["separated"]
    write_json(out/"witnesses.json", {
        "defects": [{"id":"F1","kind":"shaft","frames":tab},
                    {"id":"F2","kind":"joint","frames":seam}],
        "controls": [{"kind":"opening","frames":opening},{"kind":"crossing","frames":crossing}],
    })
    write_json(out/"proofs"/"validation.json", {
        "standingFrames": ["stand-right","stand-down"],
        "identicalWalkingFrames": [p["name"] for p in poses if p["name"].startswith("walk-")
                                    and p["name"] not in set(tab)|set(seam)],
        "rgbaFramesVerifiedAgainstIndependentComposite": 2*len(poses),
        "affectedPixelsPerFrame": {"shaft":{n:len(v) for n,v in tab.items()},
                                   "joint":{n:len(v) for n,v in seam.items()}},
        "equalColorSleeveOverHandle": equal_crossings,
        "motion": gait,
    })


if __name__ == "__main__":
    main()
