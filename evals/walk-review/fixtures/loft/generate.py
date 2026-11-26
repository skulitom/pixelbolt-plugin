"""Rebuild the two sources, their original stand art and the private validation record.

Python 3.9+ and Pillow are required. Use --cli with a Pixelbolt checkout's
bin/pixelbolt.js; when omitted the installed pixelbolt command is used.
"""
import argparse
import copy
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image, ImageColor, ImageDraw


SIZE = (38, 39)
ORIGIN = (18, 35)
PALETTE = {
    'k': '#202537', 'd': '#30364d', 'n': '#394b61', 'b': '#506d7a',
    't': '#7398a0', 'i': '#adc9c5', 'v': '#d6dcd0', 'w': '#fff0d7',
    'p': '#61354d', 'm': '#965369', 'r': '#bf6174', 'f': '#e68a86',
    'u': '#683b42', 'c': '#a35446', 'o': '#eb7750', 'a': '#ffb560',
    'y': '#ffe197', 'g': '#265358', 'e': '#377576', 'j': '#62a596',
    'l': '#99c2a3',
}
BRIEF = """Tilda carries the tide post between the harbour steps and the ferry. She's a little puffin in a mulberry post cap, with a coral-and-butter bill, webbed feet and a sea-glass canvas satchel on a leather sling. The folded letter rides in its outer pocket. Keep the small carry loop readable and the soft bag close to the body as her feet and wings take short opposing steps.

Use the supplied standing art for the facing and palette. The down and right walks should feel like the same jaunty harbour waddle, at the existing beat and ground point.
"""


def sprite(x, y, drawing, parent=None):
    rows = [line.strip().replace(' ', '.') for line in drawing.strip().splitlines()]
    width = max(map(len, rows))
    return {'x': x, 'y': y, 'rows': [list(row.ljust(width, '.')) for row in rows],
            'parent': parent}


def artwork():
    # Placement coordinates are in each original native drawing. Dict insertion
    # order is the painter's order and is independent of the attachment graph.
    return {
        'right': {
            'far-wing': sprite(19, 17, """
                ..kk
                .kbtk
                kbnntk
                knnnnk
                .knnbk
                .kdnbk
                ..kdnbk
                ...kdk
                ....k
            """),
            'far-foot': sprite(13, 24, """
                ..knnk
                ..knnk
                ..knnk
                ..knnk
                ..kcck
                ..kock
                ..kock
                .kcoock
                .koocockk
                .kuccccuk
                ..kkkkkk
            """),
            'near-shin': sprite(10, 24, """
                ...kbbk
                ...kbbk
                ...kbnk
                ...kbnk
                ...kcuk
                ...kaok
            """, 'near-foot'),
            'coat': sprite(6, 14, """
                ........kkkkkk
                ......kknttttbkk
                .....kddnbttibbbk
                ....kdndbnnbbttivk
                ...kddnnnbbbtiwwvk
                ..kddnbbbttiwwwvvk
                ..kdnbbbbbtiwwwwvik
                .kdnnbbbbtiwwwwwvik
                .kdnnbbbtiwwwwwwvik
                kddnbbbiwwwwwwwwvik
                kddnnbbivwwwwwwwvik
                .kddnbbivvvwwwwwvik
                ..kdnbbiiivvvwwvik
                ...kdnbbttiiivvik
                ....kkdnbbttiik
                ......kkkkkkkk
            """),
            'sling': sprite(7, 16, """
                ..............uc
                .............uac
                ............uacu
                ..........uacuu
                ........uacuu
                ......uacuu
                ....uacuu
                ..uacuu
                uacuu
            """, 'coat'),
            'satchel': sprite(3, 17, """
                ..kuuuk
                .kcuuuck
                .ku..uck
                .ku...ck
                .ku...ck
                kggggggggkk
                kejlllljjegk
                kevwwwwwvejgk
                kewivvviweejk
                kevviwivvjeek
                kejjeijejgggk
                kejjeeeegggek
                kegjeeeeegeek
                kgcccuuccccuk
                .kcuuucuuuck
                ..kkkkkkkkk
            """, 'coat'),
            'near-foot': sprite(8, 29, """
                .....koak
                .....koak
                ....kcoock
                ...kcoaaook
                ...kooaocoakk
                ...kuuccccuck
                ....kkkkkkkk
            """),
            'near-wing': sprite(13, 17, """
                ...kkk
                ..kbttk
                .kbtibnk
                kbttbbnk
                kbtnbbnk
                kbnbbnk
                knbnbnk
                kdnnbk
                kdnnbk
                kdnbk
                kdnk
                .kk
            """),
            'head': sprite(9, 6, """
                ......kkkkkkkk
                ....kkdbbbbbbnkk
                ...kdnbbbbbbbnnnk
                ..kdnbbbbbbbnnnnnk
                .kdnbbbbnnnnivvvik
                .kdnbbbnnniwwwwwvik
                kdnbbbnnniwwwwwwwik
                kdnbbnniwwwdkwwwwik
                kdnbnniwwwwkkwwwvvk
                kddnnbivwwwwwwvvvik
                .kddnnbivwwwwwwvik
                ..kddnnbivvwwvvik
                ...kkddnbbiivvik
                .....kkdnbbttkk
                .......kkkkkk
            """, 'coat'),
            'bill': sprite(24, 11, """
                .kk
                kcykk
                koyyokk
                kcoayoaock
                kuuoooaaoock
                .kuccoaauuk
                ..kuuukkk
                ...kkk
            """, 'coat'),
            'cap': sprite(8, 2, """
                .......kkkkkk
                .....kkmrrrrmkk
                ...kkmrrffrrrrmk
                ..kmmrrrfffrrrmk
                .kmmrrrrrrrmmpppk
                .kpmrrrmmmppppppu
                ..kpmmippkkuuuuckkkk
                ...kpiyykpucccooooock
                ....kpuykpkkuuuuccuk
                .....kkkkk..kkkkkkk
            """, 'coat'),
        },
        'down': {
            'far-wing': sprite(22, 17, """
                ..kk
                .kbtk
                kbbtbk
                kbnbbk
                .knbbk
                .knbbbk
                .kdnbbk
                ..kdnbk
                ..kdnbk
                ...kdk
                ....k
            """),
            'far-foot': sprite(17, 24, """
                ...knnk
                ...knnk
                ...knnk
                ...knnk
                ...kuck
                ...kock
                ...kock
                ..kcoock
                .kcoooock
                kucococuck
                .kkukukkk
            """),
            'near-shin': sprite(9, 24, """
                ....kbbk
                ....kbbk
                ....kbnk
                ....kbnk
                ....kcuk
                ....kaok
                ....koak
                ...koaoak
            """, 'near-foot'),
            'coat': sprite(8, 14, """
                .......kkkkkkk
                .....kkbtttttbkk
                ....kdnbtiiittbnk
                ...kdnnbivvvviibnk
                ..kdnnbivwwwvvibnk
                ..kdnbivwwwwwwvibk
                .kdnnbivwwwwwwwvik
                .kdnbivwwwwwwwwwvik
                kddnbivwwwwwwwwwvik
                kddnbivwwwwwwwwwvik
                kddnbivwwwwwwwwwvik
                .kdnbivvwwwwwwwvik
                .kdnbbivvvwwwwvik
                ..kdnnbiiivvvvvik
                ...kkdnbbttiiibk
                .....kkkkkkkkkk
            """),
            'sling': sprite(8, 16, """
                ...............uc
                ..............uac
                .............uacu
                ...........uacuu
                .........uacuu
                .......uacuu
                .....uacuu
                ...uacuu
                .uacuu
                ucu
            """, 'coat'),
            'satchel': sprite(3, 18, """
                ..kuuuk
                .kcuuuck
                .ku..uck
                .ku...ck
                .ku...ck
                kgggggggkk
                kejlleejjgk
                kevwwwwwvejk
                kewivvviwegk
                kevviwivvejk
                kejjeijejggk
                kejjjeeegegk
                kgccucccccuk
                .kcuuccuuck
                ..kkkkkkkk
            """, 'coat'),
            'near-foot': sprite(9, 31, """
                ...koaoak
                ..kcoaoaok
                .koaoaocoak
                kucuoccocuck
                .kkukkukkkk
            """),
            'near-wing': sprite(8, 17, """
                ....kkk
                ...kbttk
                ..kbtibk
                ..kbttbk
                .kbtbbnk
                .kbtbbnk
                kbnbbnk
                kbnbbnk
                knbnbk
                kdnbbk
                .kdnk
                ..kk
            """),
            'head': sprite(8, 6, """
                .......kkkkkkk
                .....kkbbbbbbnkk
                ...kkbbbbbbbbnnnk
                ..kdbbbnnnnnnnnnnk
                .kdbbnivvvnnvvvinbk
                kdnbniwwwwvvwwwwvik
                kdnbivwwwwwwwwwwwvik
                kdnbivwwdkwwwwdkwwik
                kdnbivwwkkwwwwkkwwik
                .kdnbivwwwvvvvwwwvik
                .kdnbivwwvvwwvvwvik
                ..kdnnbivvwwwwvvik
                ...kkdnbbivvvviik
                .....kkdnbbttbkk
                .......kkkkkkk
            """, 'coat'),
            'bill': sprite(15, 15, """
                ..kkk
                .kayaak
                kcyyaaok
                kuoooock
                .kcoock
                ..kuck
                ...kk
            """, 'coat'),
            'cap': sprite(8, 2, """
                ........kkkkk
                .....kkkmrrrmkk
                ...kkmrrffrrrrmk
                ..kmmrrfffrrrrrmk
                .kmmrrrrrrrrrmmpk
                kpmmrrppiiyypmmppk
                .kpppuuyyyykpuccck
                ..kpuucccuuucccoock
                ...kpucccccoooocck
                ....kkkuuuuuukkk
            """, 'coat'),
        },
    }


def source(art):
    obj = dict(format='pixelforge-poses', version=1, name='tide-post',
               width=SIZE[0], height=SIZE[1], palette=PALETTE,
               parts={}, poses=[], walkCycles={}, animations={}, sheet={'columns': 8, 'padding': 0})
    for direction, parts in art.items():
        pose = {'name': 'stand-' + direction, 'origin': list(ORIGIN), 'parts': []}
        for key, item in parts.items():
            part_id = direction + '-' + key
            definition = {'rows': [''.join(row) for row in item['rows']], 'anchor': [0, 0]}
            if any(other['parent'] == key for other in parts.values()):
                definition['points'] = {'root': [0, 0]}
            obj['parts'][part_id] = definition
            instance = {'name': key, 'part': part_id, 'cleanup': False}
            part_origin = ORIGIN
            if item['parent']:
                parent = parts[item['parent']]
                part_origin = parent['x'], parent['y']
                instance['attach'] = {'part': item['parent'], 'point': 'root'}
            instance['at'] = [item['x'] - part_origin[0], item['y'] - part_origin[1]]
            pose['parts'].append(instance)
        obj['poses'].append(pose)
        obj['animations'][pose['name']] = {'frames': [pose['name']]}
        obj['walkCycles']['walk-' + direction] = {
            'rest': pose['name'], 'direction': direction,
            'feet': ['near-foot', 'far-foot'], 'arms': ['near-wing', 'far-wing'],
            'stride': 4 if direction == 'right' else 2, 'lift': 2, 'bob': 1, 'duration': 110,
        }
    return obj


def paint(art, direction):
    image = Image.new('RGBA', SIZE)
    for item in art[direction].values():
        for y, row in enumerate(item['rows'], item['y']):
            for x, ink in enumerate(row, item['x']):
                if ink != '.':
                    image.putpixel((x, y), ImageColor.getrgb(PALETTE[ink]) + (255,))
    return image


def write_json(path, obj):
    path.write_bytes((json.dumps(obj, indent=2, ensure_ascii=False) + '\n').encode())


def change(item, x, y, to):
    row = item['rows'][y - item['y']]
    old = row[x - item['x']]
    row[x - item['x']] = to
    return old


def apply_damage(art, kinds):
    damaged = copy.deepcopy(art)
    profile = damaged['right']
    if 'joint' in kinds:
        for y in (21, 22, 23):
            for x in (18, 19):
                assert change(profile['coat'], x, y, '.') != '.'
    if 'equipment' in kinds:
        for x, y in [(11,29), (12,29), (10,30), (11,30), (12,30), (10,31), (11,31), (10,32)]:
            leather = change(profile['satchel'], x, y, '.')
            assert leather != '.' and change(profile['near-foot'], x, y, leather) == '.'
    return damaged


def render(cli, project, name, work):
    src = work / (name + '.poses.json')
    recipe = work / (name + '.pixel.json')
    meta = work / (name + '.meta.json')
    bundle = work / name
    write_json(src, project)
    for cmd in [
        ['compile', str(src), '--out', str(recipe), '--metadata', str(meta)],
        ['validate', str(recipe)],
        ['render', str(recipe), '--out', str(bundle), '--look'],
    ]:
        run = subprocess.run(cli + cmd, capture_output=True, text=True)
        if run.returncode:
            raise RuntimeError(run.stdout + run.stderr)
    data = json.loads(recipe.read_bytes())
    metadata = json.loads(meta.read_bytes())
    frames = {}
    for frame in data['frames']:
        png = bundle / 'frames' / (frame['name'] + '.png')
        with Image.open(png) as file:
            frames[frame['name']] = file.convert('RGBA')
    return data, metadata, frames


def review_sheet(frames, output):
    scale = 3
    w, h = SIZE
    stage = Image.new('RGB', (8 * (w * scale + 2), 2 * (h * scale + 14)), '#d9d8c8')
    draw = ImageDraw.Draw(stage)
    for row, face in enumerate(('right', 'down')):
        for step in range(8):
            name = f'walk-{face}-{step + 1}'
            image = frames[name].resize((w*scale, h*scale), Image.Resampling.NEAREST)
            x, y = step*(w*scale + 2), row*(h*scale + 14)
            stage.paste(image, (x, y), image)
            draw.text((x+3, y+h*scale), name, fill='#30364d')
    stage.save(output)


def unpack(recipe, pngs):
    """Audit the public compiled stamps against the independently decoded PNGs."""
    result = {}
    for frame in recipe['frames']:
        assert 'from' not in frame and 'ops' not in frame
        stacks = {}
        image = Image.new('RGBA', SIZE)
        for layer in frame['layers']:
            op, = layer['ops']
            assert op['op'] == 'stamp' and set(op) == {'op', 'symbol', 'x', 'y'}
            for y, row in enumerate(recipe['symbols'][op['symbol']], op['y']):
                for x, ink in enumerate(row, op['x']):
                    if ink == '.':
                        continue
                    assert 0 <= x < SIZE[0] and 0 <= y < SIZE[1]
                    stacks.setdefault((x, y), []).append((layer['name'], ink))
                    image.putpixel((x, y), ImageColor.getrgb(PALETTE[ink]) + (255,))
        assert image.tobytes() == pngs[frame['name']].tobytes()
        result[frame['name']] = stacks
    return result


def top(stack):
    return stack[-1] if stack else (None, '.')


def collect_defect(kind, original, changed, clean_frames, worse_frames):
    frames = {}
    visible = semantic = clear = 0
    for name in clean_frames:
        if not name.startswith('walk-'):
            continue
        pixels = []
        for xy in sorted(original[name].keys() | changed[name].keys(), key=lambda p: (p[1], p[0])):
            a, b = clean_frames[name].getpixel(xy), worse_frames[name].getpixel(xy)
            if a != b:
                pixels.append(list(xy))
                visible += 1
                if kind == 'joint':
                    assert a[3] == 255
                    clear += b[3] == 0
            elif top(original[name].get(xy)) != top(changed[name].get(xy)):
                pixels.append(list(xy))
                semantic += 1
        if pixels:
            frames[name] = pixels
    assert visible >= 8
    assert kind != 'joint' or clear >= 6
    assert kind != 'equipment' or semantic > 0
    return {'id': 'feathers' if kind == 'joint' else 'binding', 'kind': kind, 'frames': frames}


def inside_air(png, seeds):
    """Confirm the named loop contains enclosed air using diagonal connectivity."""
    todo = list(seeds)
    seen = set()
    while todo:
        x, y = todo.pop()
        if (x, y) in seen or png.getpixel((x, y))[3] != 0:
            continue
        assert 0 < x < SIZE[0]-1 and 0 < y < SIZE[1]-1
        seen.add((x, y))
        todo.extend((x+dx, y+dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1))
    assert set(seeds) <= seen


def collect_controls(clean, damaged, original, changed, meta):
    openings, crossings = {}, {}
    for name, png in clean.items():
        if not name.startswith('walk-'):
            continue
        sx, sy = meta['poses'][name]['parts']['satchel']['topLeft']
        ring = [(sx + 3, sy + 2), (sx + 3, sy + 3)]
        for image in [png, damaged[name]]:
            inside_air(image, ring)
        openings[name] = [list(xy) for xy in ring]
        candidates = []
        for xy, stack in original[name].items():
            layers = dict(stack)
            if top(stack)[0] != 'near-foot' or 'satchel' not in layers:
                continue
            if stack != changed[name].get(xy):
                continue
            if top(stack)[1] == layers['satchel']:
                continue
            assert png.getpixel(xy) == damaged[name].getpixel(xy)
            candidates.append(xy)
        # A non-occluded frame has no crossing witness. Keep a few contour
        # neighbours per occlusion, including one on the inside of the shoe.
        if candidates:
            candidates.sort(key=lambda p: (p[1], p[0]))
            crossings[name] = [list(xy) for xy in sorted(
                {candidates[0], candidates[len(candidates)//2], candidates[-1]})]
    assert len(crossings) >= 6
    return [{'kind':'opening','frames': openings}, {'kind':'crossing','frames': crossings}]


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main(cli, out, review):
    art = artwork()
    types = ('joint', 'equipment')
    both = apply_damage(art, types)
    with TemporaryDirectory(dir=out) as temporary:
        work = Path(temporary)
        good_source, bad_source = source(art), source(both)
        good, meta, clean = render(cli, good_source, 'clean', work)
        bad, bad_meta, damaged = render(cli, bad_source, 'damaged', work)
        assert meta == bad_meta and good['animations'] == bad['animations']
        original = unpack(good, clean)
        changed = unpack(bad, damaged)
        for direction in art:
            stand = 'stand-' + direction
            reference = paint(art, direction)
            assert reference.tobytes() == clean[stand].tobytes() == damaged[stand].tobytes()
            reference.save(out / (stand + '.png'))
            clip = 'walk-' + direction
            expected = [clip + '-' + str(n) for n in range(1, 9)]
            assert good['animations'][clip] == {'frames': expected, 'loop': True}
            assert all(frame['duration'] == 110 for frame in good['frames'] if frame['name'] in expected)
            assert all(tuple(meta['poses'][n]['origin']) == ORIGIN for n in expected)
        defects = []
        for typ in types:
            proj, _, subset = render(cli, source(apply_damage(art, [typ])), typ, work)
            defects.append(collect_defect(typ, original, unpack(proj, subset), clean, subset))
        controls = collect_controls(clean, damaged, original, changed, meta)
        for name in clean:
            if not name.startswith('walk-'):
                continue
            keys = {tuple(p) for d in defects for p in d['frames'].get(name, [])}
            diffs = {xy for xy in original[name].keys() | changed[name].keys()
                     if clean[name].getpixel(xy) != damaged[name].getpixel(xy)
                     or top(original[name].get(xy)) != top(changed[name].get(xy))}
            assert keys == diffs
        write_json(out / 'clean.poses.json', good_source)
        write_json(out / 'damaged.poses.json', bad_source)
        (out / 'brief.txt').write_bytes(BRIEF.encode())
        write_json(out / 'witnesses.json', {'defects': defects, 'controls': controls})
        if review:
            review.mkdir(parents=True, exist_ok=True)
            for title, frames in [('clean', clean), ('damaged', damaged)]:
                review_sheet(frames, review / (title + '.png'))
                for direction in art:
                    call = subprocess.run(cli + ['inspect', str(work / (title + '.poses.json')),
                        '--motion', 'walk-' + direction, '--out', str(review / (title + '-' + direction + '.png')),
                        '--force'], capture_output=True, text=True, check=True)
                    (review / (title + '-' + direction + '.json')).write_text(call.stdout, encoding='utf-8')
        generator = Path(__file__).resolve()
        if out / generator.name != generator:
            shutil.copyfile(generator, out / generator.name)
        files = [generator.name, 'clean.poses.json', 'damaged.poses.json', 'brief.txt', 'witnesses.json',
                 *['stand-' + face + '.png' for face in art]]
        write_json(out / 'FREEZE.json', {'algorithm': 'SHA-256', 'files': {f: digest(out/f) for f in sorted(files)}})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', type=Path)
    parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--review-dir', type=Path, help='Optional private contact sheets and public motion reports')
    args = parser.parse_args()
    cli = ['node', str(args.cli.resolve())] if args.cli else [shutil.which('pixelbolt') or 'pixelbolt']
    args.out.mkdir(parents=True, exist_ok=True)
    main(cli, args.out.resolve(), args.review_dir.resolve() if args.review_dir else None)
