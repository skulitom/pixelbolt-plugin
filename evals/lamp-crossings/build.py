"""Recreate original sprite-scale drawings, artist masks, handoffs and reference renders."""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


class Drawing:
    def __init__(self, size, palette):
        self.size = size
        self.palette = palette
        self.layers = {}

    def stamp(self, name, x, y, pattern):
        layer = self.layers.setdefault(name, {})
        for dy, row in enumerate(pattern.strip("\n").splitlines()):
            for dx, ink in enumerate(row):
                if ink != ".":
                    assert ink in self.palette, ink
                    point = x + dx, y + dy
                    assert 0 <= point[0] < self.size[0] and 0 <= point[1] < self.size[1], point
                    layer[point] = ink

    def flattened(self, order):
        image = Image.new("RGBA", self.size)
        visible = {}
        for name in order:
            for (x, y), ink in self.layers[name].items():
                rgb = bytes.fromhex(self.palette[ink])
                image.putpixel((x, y), (*rgb, 255))
                visible[x, y] = name
        return image, visible


def porter():
    # Peaked cap, copper braid, long dark teal station coat and a storm lantern.
    a = Drawing((34, 36), dict(k="242631", d="2b3c48", j="365263",
        t="427176", g="67918a", h="96b3a0", s="78494a", f="ae6b55",
        p="df9d71", l="f2c38c", b="79584c", c="a47b5d", m="ad865b",
        y="e4b577", w="fae5a1", a="dd9556", o="8e543e"))
    a.stamp("body", 8, 2, """
......kkkkkk
....kkjjjtttk
...kdjjttggggk
...kddjjttttttkk
...kkmmmyyyyyyyyk
....kdkddkkkkkkkkk
....kssffpppk
....ksffsplfk
.....kfkfppppk
.....ksffppllk
......kssffkk
......kdsfpk
....kkttgkwk
...kdjttgkyyk
..kdjttgtjppkk
..kjjtttjjkfpk
..kdjtttjmkfpk
..kddjjjjjkkk
..kdjjtttmkk
..kjgghhgggk
.kddjjtttjjjk
.kddjjjttjjjk
.kddjjjjttjjk
..kkddddjjjkk
....kkkkkkkk
""")
    a.stamp("lamp", 19, 20, """
..kkk
.km.mk
.k...k
..k.k
.kkmkk
.kmyyk
.kowmk
.kawk k
.kowmk
.kkkkk
..kmk
""".replace(" ", ""))
    a.stamp("farBoot", 10, 25, """
.kddk
.kdjk
.kddk
.kbbk
.kbck
.kbbk
kdbbbk
kddddkk
.kkkkkk
""")
    a.stamp("nearBoot", 16, 25, """
kdtk
kjtk
kjjk
kbbk
kcbk
kbbkk
kbbcck
kddbbkk
.kkkkkk
""")
    roles = dict(body="body", lamp="body", farBoot="footA", nearBoot="footB")
    return dict(drawing=a, layers=list(roles), roles=roles, direction="right",
                pivot=[17,34], margin=4, stride=3, lift=2, bob=1, duration=90,
                stolen=[(20,26),(20,27),(20,28)],
                overlap=[[11,25,4,2],[16,25,4,2]], character="Night porter")


def surveyor():
    # Patched brick coveralls, helmet reflector, blanket roll and brass-framed carbide lamp.
    a = Drawing((39,39), dict(k="272832",d="373d4d",j="49596b",t="667e85",
        g="94ad9d",h="c7d1b9",s="77494d",f="a96859",p="d79673",l="f3be89",
        b="74504a",r="a75948",e="c87555",m="ad9260",y="ddbe79",w="dcf2cc",
        a="88bbab",o="597784"))
    a.stamp("body",13,2,"""
.......kkkkkk
.....kkmmyyyyk
....kmmmyyyyyyk
...kkkkmyyyhyyyk
...khgkmyyyyyymk
...kgjkdmmmmmmmk
.kkkkkkmmmmmmmmmkk
..kkkkkkkkkkkkkkk
.....kpplffdddk
....kppkpsssddk
...klppffppsdkk
....kkpffpfsdk
.....kbbffsskk
......kbbbrjk
......kssskerk
....kkjdkkreeek
...kdjjdrreeeeek
...kddjbrrreerrek
...kddymrrremrrejk
...kbmydrrrerrrrjk
...kddddjjjjjddjjk
..kdjjjjjjjjjjjjk
..kdjjjtjjjjjtjjk
..kdjjttjjjttjjjk
...kkkkkkkkkkkkk
""")
    a.stamp("body",27,13,"""
.kkkk
kmhhmk
kmtgdk
kddjdk
kkmmmk
.kmmdk
.kmmmk
..kkkk
""")
    a.stamp("farArm",12,17,"""
......kkk
.....krrrk
....krerek
...krrrkk
..krrrk
.kjjjk
.kfpk
.kppk
..kk
""")
    a.stamp("lamp",9,24,"""
...kkk
..km..k
..k...k
.kkmmkk
.kkthmk
.kjgwjk
.kjahjk
.kmaojk
.kkmmkk
..kkkk
""")
    a.stamp("farBoot",21,26,"""
..kdjjk
..kdjtjk
..kdjjjk
..kddjjk
..kdddk
..kbbbk
..kbcbk
.kbbbbk
kdddbbk
.kkkkkk
""".replace("c","m"))
    a.stamp("nearBoot",13,26,"""
....kjtjk
....kjjtk
....kjjjk
....kdddk
...kkbmbk
...kbbcbk
..kbbccbk
.kdbbbbbk
kdddbbbbk
.kkkkkkk
""".replace("c","m"))
    a.stamp("nearArm",19,16,"""
....kkk
...kreek
...kreerk
...krrerk
...krrerk
..krrrkk
..kmmmk
..kfppk
..ksppk
...kkk
""")
    roles = dict(farBoot="footA",body="body",farArm="armA",lamp="armA",
                 nearBoot="footB",nearArm="armB")
    return dict(drawing=a,layers=list(roles),roles=roles,direction="left",
                pivot=[20,36],margin=4,stride=4,lift=2,bob=1,duration=110,
                stolen=[(15,28),(15,29),(15,30),(15,31)],
                overlap=[[17,26,4,1],[23,26,4,1],[18,18,2,2],[22,17,3,2]],
                character="Mine surveyor")


def rectangles(pixels):
    # Horizontal runs with identical endpoints are merged vertically.
    rows = {}
    for x, y in pixels:
        rows.setdefault(y, set()).add(x)
    output = []
    active = {}
    for y, columns in sorted(rows.items()):
        spans = []
        for x in sorted(columns):
            if spans and spans[-1][1] == x:
                spans[-1][1] += 1
            else:
                spans.append([x, x+1])
        continuing = {}
        for left, right in spans:
            key = (left, right)
            previous = active.get(key)
            if previous and previous[1] + previous[3] == y:
                previous[3] += 1
                continuing[key] = previous
            else:
                rect = [left, y, right-left, 1]
                output.append(rect)
                continuing[key] = rect
        active = continuing
    return output


def make_cuts(cfg, visible, fault):
    role_pixels = {}
    for point, layer in visible.items():
        role = cfg["roles"][layer]
        if fault and point in cfg["stolen"]:
            assert layer == "lamp", (point, layer)
            role = "footB"
        role_pixels.setdefault(role, set()).add(point)
    view = {"feet":[rectangles(role_pixels[r]) for r in ("footA","footB")]}
    if "armA" in role_pixels:
        view["arms"] = [rectangles(role_pixels[r]) for r in ("armA","armB")]
    view.update({k:cfg[k] for k in ("stride","lift","bob","duration","overlap")})
    return {"pivot":cfg["pivot"], "margin":cfg["margin"], "views":{cfg["direction"]:view}}


def materialize(name, cfg):
    case = ROOT / name
    public = case / "participant"
    private = case / "private"
    public.mkdir(parents=True, exist_ok=True)
    private.mkdir(parents=True, exist_ok=True)
    art = cfg["drawing"]
    image, visible = art.flattened(cfg["layers"])
    image.save(public / "sprite.png")
    assert set(cfg["stolen"]) <= {p for p, layer in visible.items() if layer == "lamp"}
    flat = {layer:rectangles({p for p, owner in visible.items() if owner == layer})
            for layer in cfg["layers"]}
    painted = {layer:rectangles(art.layers[layer]) for layer in cfg["layers"]}
    save_json(private / "truth.json", {"size":art.size, "sourcePivot":cfg["pivot"],
        "margin":cfg["margin"], "direction":cfg["direction"], "stride":cfg["stride"],
        "lift":cfg["lift"], "bob":cfg["bob"], "duration":cfg["duration"],
        "sourceVisibleMasks":flat,"sourcePaintedMasks":painted,"roles":cfg["roles"],
        "introducedTransfers":cfg["stolen"]})
    for path, fault in [(public/"cuts.json",True),(private/"control.cuts.json",False)]:
        save_json(path, make_cuts(cfg, visible, fault))
    return case


def run(cli, *args):
    executable = Path(shutil.which(cli) or cli).resolve()
    result = subprocess.run([executable,*map(str,args)], cwd=ROOT, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return json.loads(result.stdout)


def build_references(cli, case, name):
    private = case / "private"
    public = case / "participant"
    for variant, cuts in [("starter",public/"cuts.json"),("control",private/"control.cuts.json")]:
        root = private / variant
        root.mkdir(parents=True, exist_ok=True)
        source = root / "sprite.poses.json"
        run(cli,"import",public/"sprite.png","--cutout",cuts,"--out",source,"--force")
        if name == "quarry":
            # Back hand swings behind the foreground boot. Both references start at the
            # same artist-authored depth; only their rest cut assignment differs.
            pose = json.loads(source.read_text(encoding="utf-8"))
            order = ["body","footA","armA","footB","armB"]
            pose["poses"][0]["parts"].sort(key=lambda part:order.index(part["name"]))
            save_json(source,pose)
            if variant == "starter":
                shutil.copyfile(source,public/"starter.poses.json")
        run(cli,"compile",source,"--out",root/"compiled.json","--metadata",root/"metadata.json","--force")
        run(cli,"render",root/"compiled.json","--out",root/"export","--gif","--force")


CASES = {"station": porter, "quarry": surveyor}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=["station", "quarry","all"], default="all")
    parser.add_argument("--cli", help="pixelbolt executable for public import, compile and render")
    args = parser.parse_args()
    for name, make in CASES.items():
        if args.case in (name,"all"):
            case = materialize(name, make())
            if args.cli:
                build_references(args.cli, case, name)
