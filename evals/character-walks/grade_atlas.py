"""Grade the exported character pixels and playback. Art decisions still need a viewer.

Usage: python grade_atlas.py CASE path/to/sprite.atlas.json
Requires Pillow. Exit 0 means the machine assertions passed, 1 means they failed.
"""

import argparse
from dataclasses import dataclass
from itertools import combinations
import json
from pathlib import Path

from PIL import Image


HERE = Path(__file__).resolve().parent
INPUTS = HERE / "inputs"
DIRECTIONS = ("down", "up", "right", "left")
LAMP = {(242, 172, 72), (255, 231, 161)}
RED_PLATE = {(223, 84, 95), (148, 64, 88)}
ART_REVIEW = {
    "profile": "Inspect the right-facing gait for alternating limbs and attached feet.",
    "porter": "Track the satchel, facing and foot attachment across both strides in every view.",
    "scout": "Check the knot on the back, readable profiles and consistent character design.",
    "transfer": "Track the physical lantern, hand and attachment through turns and strides, including its occlusion.",
    "watchmaker": "Inspect both pieces of equipment, the antenna and the front visor, then check the boots throughout each loop.",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(record, names):
    values = tuple(record[key] for key in names)
    require(all(type(v) is int for v in values), f"{names} must contain integer coordinates")
    return values


def visible(image, offset=(0, 0)):
    dx, dy = offset
    return {(x + dx, y + dy): rgba for y in range(image.height)
            for x in range(image.width) if (rgba := image.getpixel((x, y)))[3]}


def read_pivot(entry, size, scale):
    def pair(key):
        values = tuple(entry[key][axis] for axis in "xy")
        require(all(type(v) in (int, float) for v in values), f"{key} must be numerical")
        return values

    if "anchorPx" in entry:
        exported = pair("anchorPx")
    elif "pivot" in entry:
        exported = tuple(v * dim for v, dim in zip(pair("pivot"), size))
    elif "anchor" in entry:
        exported = pair("anchor")  # Legacy Pixelbolt stored its lone anchor in exported pixels.
    else:
        return None
    native = tuple(round(v / scale) for v in exported)
    expected = tuple(v * scale for v in native)
    for value, px, dim in zip(exported, expected, size):
        require(abs(value - px) <= dim * 0.00000051 + 1e-8, "ground pivot lies between native pixels")
    normalized = ["pivot"] if "pivot" in entry else []
    if "anchor" in entry:
        if "anchorPx" in entry or ("pivot" in entry and pair("anchor") != expected):
            normalized.append("anchor")
    for key in normalized:
        for v, dim, px in zip(pair(key), size, expected):
            require(abs(v * dim - px) <= dim * 0.00000051 + 1e-8, f"{key} disagrees with ground pivot")
    return native


@dataclass
class Frame:
    name: str
    pixels: dict
    pivot: tuple | None
    duration: int


def decode(name, entry, sheet, scale):
    x, y, w, h = fields(entry["frame"], "xywh")
    require(min(x, y) >= 0 and min(w, h) > 0 and x+w <= sheet.width and y+h <= sheet.height,
            "frame rectangle lies outside the PNG")
    crop = sheet.crop((x, y, x+w, y+h))
    if entry.get("rotated"):
        crop = crop.transpose(Image.Transpose.ROTATE_90)  # TexturePacker stores clockwise.
    size = fields(entry["sourceSize"], "wh")
    dx, dy, sw, sh = fields(entry["spriteSourceSize"], "xywh")
    require(crop.size == (sw, sh) and min(dx, dy) >= 0 and dx+sw <= size[0] and dy+sh <= size[1],
            "spriteSourceSize must fit sourceSize and match the unrotated frame")
    require(all(v % scale == 0 for v in (*size, dx, dy, sw, sh)),
            "frame does not fit the native grid; export at sheet.scale 1")
    if scale > 1:
        hidden = crop.getchannel("A").point(lambda alpha: 0 if alpha else 255)
        crop.paste((0, 0, 0, 0), mask=hidden)
        native = crop.resize((sw // scale, sh // scale), Image.Resampling.NEAREST)
        expanded = native.resize(crop.size, Image.Resampling.NEAREST)
        require(crop.tobytes() == expanded.tobytes(),
                "scale blocks contain different visible pixels; export at sheet.scale 1")
        crop = native
    pivot = read_pivot(entry, size, scale)
    return Frame(name, visible(crop, (dx // scale, dy // scale)), pivot, entry["duration"])


def read_atlas(path, source_png=None):
    atlas = json.loads(path.read_text(encoding="utf-8-sig"))
    meta = atlas["meta"]
    scale = int(meta.get("scale", 1))
    require(scale >= 1 and float(meta.get("scale", 1)) == scale, "use a positive integer sheet.scale")
    with Image.open(source_png or path.parent / meta["image"]) as image:
        require(image.format == "PNG", "atlas image must be a PNG")
        sheet = image.convert("RGBA")
    require(sheet.size == fields(meta["size"], "wh"), "meta.size differs from the PNG")
    frames = {}
    for name, entry in atlas["frames"].items():
        try:
            frames[name] = decode(name, entry, sheet, scale)
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"frame {name!r}: {error}") from error
    return frames, atlas["animations"]


def anchored(pixels, pivot):
    return {(x-pivot[0], y-pivot[1]): color for (x, y), color in pixels.items()}


def references(case):
    if case == "porter":
        frames, _ = read_atlas(INPUTS / "porter.atlas.json", INPUTS / "porter.png")
        return {d: anchored(frames[d].pixels, (8, 28)) for d in DIRECTIONS}
    path, direction, pivot = {
        "profile": (INPUTS / "imp.png", "right", (16, 36)),
        "scout": (HERE / "../../showcase/four-way-walk/sources/ranger.png", "down", (8, 16)),
        "transfer": (INPUTS / "lamplighter.png", "down", (13, 30)),
        "watchmaker": (INPUTS / "watchmaker.png", "down", (13, 30)),
    }[case]
    with Image.open(path) as image:
        return {direction: anchored(visible(image.convert("RGBA")), pivot)}


def picture(pixels, flip_x=False, flip_y=False):
    """Canonical visible RGBA including silhouette, independent of whole-frame translation."""
    transformed = {(-x if flip_x else x, -y if flip_y else y): c for (x, y), c in pixels.items()}
    if not transformed:
        return frozenset()
    origin = tuple(map(min, zip(*transformed)))
    return frozenset(anchored(transformed, origin).items())


def components(pixels):
    remaining = set(pixels)
    sizes = []
    while remaining:
        todo = [remaining.pop()]
        count = 0
        while todo:
            x, y = todo.pop()
            count += 1
            for point in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
                if point in remaining:
                    remaining.remove(point)
                    todo.append(point)
        sizes.append(count)
    return sorted(sizes, reverse=True)


def equipment_visible(frame, direction, colors, near):
    bright = [x for (x, _), rgba in frame.pixels.items() if rgba[:3] in colors]
    if direction in ("left", "right") and direction != near:
        return not bright
    if not bright:
        return False
    if direction == near:
        return True
    if frame.pivot is None:
        return False
    # Native pixels have centres at x + 0.5. Classify a lamp by its centre of light.
    centre = sum(x + 0.5 for x in bright) / len(bright) - frame.pivot[0]
    on_right = (direction == "down") == (near == "left")
    return centre > 0 if on_right else centre < 0


def grade(case, frames, animations, refs, report):
    def check(label, passed, **details):
        report["assertions"].append({"id": label, "pass": passed, **details})

    directions = ("right",) if case == "profile" else DIRECTIONS
    carries_lamp = case in ("transfer", "watchmaker")
    expected_ms = 120 if carries_lamp else 100
    flags = report["human_review"]["flags"]
    used = {}
    pictures = {}
    for direction in directions:
        stand = []
        for kind in ("stand", "walk"):
            name = f"{kind}-{direction}"
            animation = animations.get(name, {})
            names = animation.get("frames")
            valid = isinstance(names, list) and bool(names) and all(isinstance(n, str) and n in frames for n in names)
            check(f"{name}.sequence", valid)
            if not valid:
                continue
            sequence = [frames[n] for n in names]
            used.update((f.name, f) for f in sequence)
            unique = [frames[n] for n in dict.fromkeys(names)]
            blank = [f.name for f in unique if not f.pixels]
            check(f"{name}.visible", not blank, blank=blank)
            pictures[name] = {picture(f.pixels) for f in unique}
            if kind == "stand":
                stand = unique
                if direction in refs:
                    misses = {}
                    for f in stand:
                        if f.pivot is None:
                            misses[f.name] = "missing ground pivot"
                            continue
                        actual = anchored(f.pixels, f.pivot)
                        reference = refs[direction]
                        count = sum(actual.get(p) != reference.get(p) for p in actual.keys() | reference.keys())
                        if count:
                            misses[f.name] = count
                    check(f"{name}.source_rgba_at_ground", not misses, differing_pixels=misses)
            else:
                times = [f.duration for f in sequence]
                check(f"{name}.playback", animation.get("loop") is True and
                      all(t == expected_ms for t in times) and animation.get("duration") == len(times) * expected_ms,
                      loop=animation.get("loop"), step_ms=times, total_ms=animation.get("duration"))
                count = len(pictures[name])
                check(f"{name}.motion_beyond_translation", count >= 2, distinct_pictures=count)
                if stand:
                    baseline = components(stand[0].pixels)
                    for f in unique:
                        sizes = components(f.pixels)
                        if len(sizes) > len(baseline) or sum(sizes[1:]) > sum(baseline[1:]):
                            flags.append({"kind": "detachment_candidate", "animation": name, "frame": f.name,
                                          "stand_components": baseline, "frame_components": sizes})
            if carries_lamp:
                wrong = [f.name for f in unique if not equipment_visible(f, direction, LAMP, "left")]
                check(f"{name}.lamp_visibility", not wrong, incorrect_frames=wrong)
            if case == "watchmaker":
                wrong = [f.name for f in unique if not equipment_visible(f, direction, RED_PLATE, "right")]
                check(f"{name}.shoulder_plate", not wrong, incorrect_frames=wrong)
                if direction in ("up", "down"):
                    # The original uses cyan exclusively for the two visor lights.
                    expected_lights = 2 if direction == "down" else 0
                    wrong = []
                    for f in unique:
                        cyan = {point for point, color in f.pixels.items() if color[:3] == (131, 219, 204)}
                        if len(components(cyan)) != expected_lights:
                            wrong.append(f.name)
                    check(f"{name}.visor", not wrong, incorrect_frames=wrong)

    if carries_lamp:
        palette = set(refs["down"].values())
        extra = sorted({rgba for f in used.values() for rgba in f.pixels.values()} - palette)
        check("source_palette", not extra, added_colors=extra)
    pivots = {}
    for f in used.values():
        pivots.setdefault(f.pivot, []).append(f.name)
    stable = len(pivots) == 1 and None not in pivots
    check("stable_ground_pivot", stable, pivots=[{"px": p, "frames": ns} for p, ns in pivots.items()])
    if len(directions) > 1:
        for kind in ("stand", "walk"):
            copies = []
            for a, b in combinations(directions, 2):
                left, right = pictures.get(f"{kind}-{a}"), pictures.get(f"{kind}-{b}")
                if left and left == right:
                    copies.append([a, b])
            check(f"{kind}.distinct_directions", not copies, identical_picture_sets=copies)
    if case in ("scout", "transfer", "watchmaker") and "stand-up" in pictures:
        reflected = {picture(refs["down"], fx, fy) for fx, fy in ((True, False), (False, True), (True, True))}
        if reflected & pictures["stand-up"]:
            flags.append({"kind": "back_matches_reflected_front", "animation": "stand-up"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", choices=ART_REVIEW)
    parser.add_argument("atlas", type=Path)
    args = parser.parse_args()
    report = {"case": args.case, "atlas": str(args.atlas), "assertions": [], "human_review": {
        "criteria": [ART_REVIEW[args.case], "Watch each loop at native size for gait, ground contact and separation."],
        "flags": [],
    }}
    for stage in ("reference_inputs", "output_atlas"):
        try:
            if stage == "reference_inputs":
                refs = references(args.case)
            else:
                frames, animations = read_atlas(args.atlas)
                grade(args.case, frames, animations, refs, report)
        except (OSError, KeyError, TypeError, AttributeError, ValueError, OverflowError) as error:
            report["assertions"].append({"id": stage, "pass": False, "error": str(error)})
            break
    report["machine_pass"] = all(item["pass"] for item in report["assertions"])
    print(json.dumps(report, indent=2))
    return 0 if report["machine_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
