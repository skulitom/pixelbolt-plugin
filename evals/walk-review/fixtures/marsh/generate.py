"""Build the frozen pair from independently drawn layers. Python 3, Pillow and Pixelbolt.

Run python generate.py path/to/bin/pixelbolt.js from any folder.
"""
import argparse
import copy
import hashlib
import json
import shutil
import subprocess
from collections import deque
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageColor

BASE = Path(__file__).resolve().parent
SIZE = 36
GROUND = (18, 31)
FACINGS = ('right', 'down')
PALETTE = {
    'k': '#302e3d', 'v': '#464358', 'x': '#757685',
    'q': '#685142', 'r': '#9b643e', 'o': '#c58a4b',
    'b': '#dfab64', 'y': '#f7d998', 's': '#aa6955',
    'p': '#db956e', 't': '#ffd3a0', 'd': '#2f5053',
    'g': '#42756b', 'm': '#6d9c7a', 'j': '#abc591',
    'a': '#af5147', 'e': '#ea8054', 'h': '#809296',
}
BRIEF = """Marn cuts reeds for the ferry landing. Draw the side and front walks at game scale, with the low straw hat, red neckerchief and tall mud boots of the standing views. A willow creel rides on a crossbelt just behind the right hip. Its curved handle has daylight inside it. The boot nearest us and the sleeve pass in front as Marn trudges along. Keep the weight in the planted foot and the easy bob of a worker who has walked this path all season. Check the full loops against the supplied standing drawings and make any local art corrections needed for the sprite to ship.
"""


def paint(*fragments):
    result = {}
    for x, y, rows in fragments:
        for dy, row in enumerate(rows.strip().split()):
            for dx, color in enumerate(row):
                if color != '.':
                    assert color in PALETTE, color
                    result[x + dx, y + dy] = color
    return result


def profile():
    # Resolve positions in native pixels while drawing. Sources use conventional local stamps.
    return {
        'sleeve-far': paint((20, 15, """
            .kkk
            kgmgk
            kggmk
            .kdgk
            .kggk
            ..kpk
            ..ktpk
            ...kkk
        """)),
        'boot-far': paint((19, 21, """
            .kkk
            kggdk
            kggdk
            kdddk
            kxxvk
            kxvvk
            .kvvk
            .kvvk
            .kvvkk
            .kvxxvk
            .kkkkkk
        """)),
        'creel': paint((4, 14, """
            ...kkk
            ..kbybk
            .kbk.kok
            .kok..krk
            kok...kqk
            kok....qk
            .kkk...qkk
            .kbyyybbbybbook
            .kobboobbooborqk
            ..krrrorrrorrrqk
            ..kyobboyobbobqk
            ...krobboorboorqk
            ...kqorrrorrrorqk
            ....kkkkkkkkkkkk
        """)),
        'boot-near': paint((15, 21, """
            .kkkk
            kgmgdk
            kggggk
            kgdgdk
            kvxxxk
            kxvvvk
            kxxvvk
            kxvvvk
            kvvxvkk
            kvvxxxvkk
            kkkkkkkkk
        """)),
        'coat': paint((11, 14, """
            ....kkkakk
            ...kggeetkk
            ..kgmmeaegk
            ..kmjjmrrmgk
            .kgmmmrqmmgk
            .kmgmrqggmgk
            kgmgroqgmggk
            kgmroqdgggdk
            kggoqdggggdk
            kddkqkggdgdk
            .kkkkkkkkkk
        """), (10, 7, """
            .....kkkkkkkk
            ....krrrppppsk
            ....krqrpttttk
            ....krrptttttk
            ....kqykptkpttk
            .....krrppptkk
            .....kqqpktsk
            ......kqqkssk
            .......kkakk
        """), (7, 2, """
            .......kkkkkk
            ......kbyyybok
            .....kbybbboook
            ....kbbbooorrrk
            ...kqrrrqrrrqqkk
            ..kbybbbbbbbbbbok
            .koyyyybbbbbooorrk
            .kkkqrrrrrqqkkkkk
        """), (8, 2, """
            rr
            qbq
            .rr
            ..qg
            ...g
        """)),
        'sleeve-near': paint((15, 15, """
            ..kkk
            .kmmmk
            kjjmmk
            kmmmgk
            kmgggk
            kdgddk
            .kggdk
            .kbbok
            .ktppk
            ..kpsk
            ...kk
        """)),
    }


def frontal():
    return {
        'sleeve-far': paint((22, 15, """
            .kk
            kmmk
            kmmgk
            .kmgk
            .kggk
            .kddk
            .kbok
            .ktpk
            ..ksk
            ...k
        """)),
        'boot-far': paint((19, 21, """
            .kkkk
            kgmmgk
            kgggdk
            kddgdk
            kxxxvk
            kxvvvk
            kvvvvk
            kvvvk
            kvxxvk
            kxhxxk
            kkkkk.
        """)),
        'creel': paint((3, 14, """
            ...kk
            ..kbok
            .kbkqk
            .kok.qk
            kok..qk
            kok..qk
            .kk..qkk
            .kbyyybbbok
            .kobrboobork
            ..korrorrrorqk
            ..kobrboobork
            ..korbbooorqk
            ...korrrrorqk
            ....kkkkkkkk
        """)),
        'boot-near': paint((12, 21, """
            .kkkk
            kgmmgk
            kgggdk
            kdgddk
            kvxxxk
            kxvvvk
            kvvvvk
            kvvxvk
            kvxxvk
            kxxxxk
            kkkkkk
        """)),
        'coat': paint((11, 14, """
            ....kkkakk
            ..kkgeeaagkk
            .kgmmjeaemmgk
            kgmmjeagrommgk
            kgmmgmroqmmmgk
            kgmgmrqggmmggk
            kgggroqggmgggk
            kggroqgdggggdk
            kdroqggdggdgdk
            kdqkkdddddgdkk
            .kkkkkkkkkkkk
        """), (11, 7, """
            ...kkkkkkkkk
            ..krrppppsrrk
            ..krppttttprk
            ..kpppttttppk
            ..kpsktttkpsk
            ...ksppttppk
            ...kqppsspsk
            ....kqpppsk
            .....kkaakk
        """), (7, 2, """
            ......kkkkkkk
            .....kbyyyybok
            ....kbyybboobok
            ...kobbboooorrrk
            ...kqrrqqrrrqqqk
            ..kbyyyyybbbbbbook
            .kbyyybbbbbbboooork
            .kkrrqrrrrrrqqrqqkk
        """), (22, 2, """
            ...rr
            ..qbq
            ..rr
            .gq
            .g
        """)),
        'sleeve-near': paint((8, 15, """
            ...kkk
            ..kmmmk
            .kjjmmk
            .kmmmgk
            .kmgmgk
            .kgdgk
            kggddk
            kbbok
            kttpk
            .kpsk
            ..kk
        """)),
    }


PARTS = {'right': profile(), 'down': frontal()}


def bounds(points):
    xs, ys = zip(*points)
    return min(xs), min(ys), max(xs), max(ys)


def dump(path, obj):
    path.write_text(json.dumps(obj, indent=2) + '\n', encoding='utf-8', newline='\n')


def sources():
    drawings = copy.deepcopy(PARTS)
    receiver = drawings['right']['boot-near']
    creel = drawings['right']['creel']
    for point in ((13, 26), (14, 26), (14, 27)):
        assert point in creel and point not in receiver
        receiver[point] = creel.pop(point)

    def serialize(layers):
        source = {
            'format': 'pixelforge-poses', 'version': 1, 'name': 'marn',
            'width': SIZE, 'height': SIZE, 'palette': PALETTE, 'parts': {},
            'poses': [], 'walkCycles': {}, 'animations': {}, 'sheet': {'columns': 8},
        }
        for direction, parts in layers.items():
            stand = 'stand-' + direction
            pose = {'name': stand, 'origin': list(GROUND), 'parts': []}
            source['poses'].append(pose)
            for name, points in parts.items():
                # Fixed envelopes let the two casts share their exact stamp positions.
                x, y, x1, y1 = bounds(set(PARTS[direction][name]) | set(drawings[direction][name]))
                symbol = direction + '-' + name
                rows = [''.join(points.get((i, j), '.') for i in range(x, x1 + 1))
                        for j in range(y, y1 + 1)]
                source['parts'][symbol] = {'rows': rows}
                pose['parts'].append({'name': name, 'part': symbol,
                                      'at': [x - GROUND[0], y - GROUND[1]], 'cleanup': False})
            source['animations'][stand] = {'frames': [stand]}
            source['walkCycles']['walk-' + direction] = {
                'rest': stand, 'direction': direction, 'feet': ['boot-far', 'boot-near'],
                'arms': ['sleeve-far', 'sleeve-near'],
                'stride': 3 if direction == 'right' else 1, 'lift': 1, 'bob': 1, 'duration': 110,
            }
        return source

    return serialize(PARTS), serialize(drawings)


def public(cli, *args):
    command = ['node', str(cli), *map(str, args)]
    proc = subprocess.run(command, capture_output=True, text=True, encoding='utf-8')
    if proc.returncode:
        raise RuntimeError(proc.stdout + proc.stderr)
    report = json.loads(proc.stdout)
    assert report['ok'] and not report.get('warnings'), report
    return report


def samples(recipe, frame, image):
    """Paint ownership from the public compiled stamps; compare native RGBA at every pixel."""
    covered = {}
    offsets = {}
    stack = {}
    swatches = {k: ImageColor.getcolor(v, 'RGBA') for k, v in recipe['palette'].items()}
    native = Image.new('RGBA', image.size)
    for layer in frame['layers']:
        name = layer['name']
        assert len(layer['ops']) == 1
        stamp, = layer['ops']
        assert 'flipX' not in stamp and stamp['op'] == 'stamp'
        ox, oy = stamp['x'], stamp['y']
        offsets[name] = (ox, oy)
        stack[name] = {}
        for y, row in enumerate(recipe['symbols'][stamp['symbol']]):
            for x, key in enumerate(row):
                if key == '.':
                    continue
                xy = (ox + x, oy + y)
                assert 0 <= xy[0] < SIZE and 0 <= xy[1] < SIZE
                stack[name][xy] = key
                covered[xy] = name
                native.putpixel(xy, swatches[key])
    assert native.tobytes() == image.tobytes()
    return {'image': image, 'owner': covered, 'offset': offsets, 'stack': stack}


def enclosed_air(ink):
    air = {(x, y) for y in range(SIZE) for x in range(SIZE)} - set(ink)
    fringe = deque([(0, 0)])
    air.remove((0, 0))
    while fringe:
        x, y = fringe.popleft()
        for p in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if p in air:
                air.remove(p)
                fringe.append(p)
    return air


def measure(clean, damaged):
    differences, windows, crossings = {}, {}, {}
    visible = equal_ink = 0
    # Local material coordinates sometimes visible while the boot sweeps by.
    revealed = {d: set() for d in FACINGS}
    for frame, state in clean.items():
        direction = frame.split('-')[1]
        ox, oy = state['offset']['creel']
        for (x, y), owner in state['owner'].items():
            if owner == 'creel':
                revealed[direction].add((x - ox, y - oy))
    for frame, state in clean.items():
        other = damaged[frame]
        if frame.startswith('stand-'):
            assert state['image'].tobytes() == other['image'].tobytes()
            continue
        direction = frame.split('-')[1]
        assert state['offset'] == other['offset']
        different = []
        for p in set(state['owner']) | set(other['owner']):
            color_a = state['image'].getpixel(p)
            color_b = other['image'].getpixel(p)
            same_owner = state['owner'].get(p) == other['owner'].get(p)
            if color_a != color_b or not same_owner:
                different.append(p)
                visible += color_a != color_b
                equal_ink += color_a == color_b and not same_owner
        if different:
            differences[frame] = sorted(different, key=lambda p: (p[1], p[0]))
        ox, oy = state['offset']['creel']
        # Editor-intended interior samples, checked against enclosed native transparency.
        local_window = ((4, 3), (4, 4)) if direction == 'right' else ((4, 4), (4, 5))
        window = [(x + ox, y + oy) for x, y in local_window]
        closed = enclosed_air(state['owner']) & enclosed_air(other['owner'])
        window = [p for p in window if p in closed]
        assert window, (frame, sorted(closed))
        windows[frame] = window
        # Capture intermittent foreground coverage. Each selected material sample is
        # uncovered elsewhere in this cycle or its standing pose.
        overlap = []
        for p in state['stack']['creel']:
            if (state['owner'].get(p) != 'boot-near' or other['owner'].get(p) != 'boot-near'
                    or p in different or (p[0] - ox, p[1] - oy) not in revealed[direction]):
                continue
            overlap.append(p)
        if overlap:
            overlap.sort(key=lambda p: (p[1], p[0]))
            crossings[frame] = [overlap[0]]
            if len(overlap) > 1:
                crossings[frame].append(overlap[-1])
    assert visible and equal_ink and differences and crossings
    return {'defects': [{'id': 'creel-rand', 'kind': 'equipment', 'frames': differences}],
            'controls': [{'kind': 'opening', 'frames': windows}, {'kind': 'crossing', 'frames': crossings}]}


def build(cli, preview):
    states = []
    flat = list(sources())
    assert flat[0]['walkCycles'] == flat[1]['walkCycles'] and flat[0]['poses'] == flat[1]['poses']
    original_inputs = []
    for direction, layer_set in PARTS.items():
        # Originals come from the independent artwork, before any split or CLI invocation.
        image = Image.new('RGBA', (SIZE, SIZE))
        for pts in layer_set.values():
            for xy, key in pts.items():
                image.putpixel(xy, ImageColor.getcolor(PALETTE[key], 'RGBA'))
        path = BASE / ('stand-' + direction + '.png')
        image.save(path, compress_level=9)
        original_inputs.append(path)
    with TemporaryDirectory(dir=BASE) as scratch:
        scratch = Path(scratch)
        for edition, source in zip(('clean', 'damaged'), flat):
            path = BASE / (edition + '.poses.json')
            dump(path, source)
            data = scratch / (edition + '.pixel.json')
            public(cli, 'compile', path, '--out', data)
            public(cli, 'validate', data)
            outdir = scratch / edition
            public(cli, 'render', data, '--out', outdir, '--look')
            recipe = json.loads(data.read_text(encoding='utf-8'))
            assert recipe['anchor'] == list(GROUND)
            states.append({})
            for frame in recipe['frames']:
                name = frame['name']
                image = Image.open(outdir / 'frames' / (name + '.png')).convert('RGBA')
                states[-1][name] = samples(recipe, frame, image)
                if name.startswith('stand-'):
                    assert image.tobytes() == Image.open(BASE / (name + '.png')).convert('RGBA').tobytes()
            assert len(states[-1]) == 18
            for d in FACINGS:
                animation = 'walk-' + d
                assert recipe['animations'][animation]['frames'] == [f'{animation}-{i}' for i in range(1, 9)]
                review = public(cli, 'inspect', path, '--motion', animation,
                                '--out', scratch / (edition + '-' + d + '.png'))
                gait = review['motion']['cutout']
                assert not gait['clipped'] and not gait['separated']
                assert all(not joint['weak'] for joint in gait['footJoints'])
            if preview:
                shutil.copyfile(outdir / 'look.png', BASE / (edition + '-preview.png'))
    witness = measure(*states)
    dump(BASE / 'witnesses.json', witness)
    (BASE / 'brief.txt').write_text(BRIEF, encoding='utf-8', newline='\n')
    keys = ['clean.poses.json', 'damaged.poses.json', 'brief.txt', 'witnesses.json', 'generate.py']
    keys.extend(path.name for path in original_inputs)
    manifest = {key: hashlib.sha256((BASE / key).read_bytes()).hexdigest() for key in sorted(keys)}
    dump(BASE / 'FREEZE.json', {'algorithm': 'sha256', 'files': manifest})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cli', type=Path, help='Path to the public Pixelbolt CLI')
    parser.add_argument('--preview', action='store_true', help='Keep the enlarged visual review sheets')
    args = parser.parse_args()
    build(args.cli.resolve(), args.preview)
