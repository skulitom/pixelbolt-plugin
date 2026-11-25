// Browser-compatible recipe patching: targeted edits addressed by readable paths. No I/O.
import { parseColor, renderProject, fail, isObject, sameWidth, layerOffset, CANVAS_SIDE, FRAME_PIXELS } from './core.js';
import { pixelId, colorOf, idsOf, cleanupIds } from './craft.js';

const define = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
const summarize = value => {
  const text = JSON.stringify(value);
  return text === undefined || text.length <= 160 ? value : `${Array.isArray(value) ? 'list' : typeof value} of ${text.length} JSON characters`;
};
const segmentPattern = /\.([^.[\]"]+)|\[(\d+|-|\*|[a-zA-Z][\w-]*)\]|\[("(?:[^"\\]|\\.)*")\]/y;
// Canvas verbs change final pixels in canvas coordinates; the rest edit the recipe structure.
const CANVAS = ['paint', 'grid', 'move', 'recolor', 'cleanup'], VERBS = ['set', 'insert', 'remove', ...CANVAS];

// A canvas change reaches across an animation frame: grid rows and moves up to its side, paint up to its area, and a
// move or recolour up to twice that (a clear and a write for every pixel).
// A frame's pixel corrections, merged, hold at most an animation frame's area too (core reads frame.pixels so).
const FRAME_LIST = FRAME_PIXELS.toLocaleString('en-US');
const PAINT = `paint needs 1–${FRAME_LIST} pixels with x, y and color`;
const hex = data => '#' + [...data].map(v => v.toString(16).padStart(2, '0')).join('');
function regionPixels(recipe, frameIndex, verb, value, where) {
  if (!isObject(value)) fail(where, 'expected a region object');
  const allowed = ['x', 'y', 'mask', ...(verb === 'grid' ? ['rows', 'erase'] : ['w', 'h', ...(verb === 'move' ? ['dx', 'dy'] : ['from', 'to'])])];
  for (const key of Object.keys(value)) if (!allowed.includes(key) || value[key] === null) fail(`${where}.${key}`, 'unknown or null region field');
  // Grid rows name the bound this canvas allows: its height, up to what core's readRows takes.
  const rows = value.rows, ROWS = `expected 1–${Number.isInteger(recipe.height) && recipe.height > 0 ? Math.min(recipe.height, CANVAS_SIDE) : CANVAS_SIDE} equal-width rows`;
  if (verb === 'grid' && (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'string' || !rows[0].length)) fail(`${where}.rows`, ROWS);
  // A grid is as wide and tall as core's readRows takes, even on a still larger than an animation frame; on a canvas no
  // larger than that, the canvas is the bound the region check names.
  if (verb === 'grid' && rows.length > CANVAS_SIDE && recipe.height > CANVAS_SIDE) fail(`${where}.rows`, ROWS);
  if (verb === 'grid' && rows[0].length > CANVAS_SIDE && recipe.width > CANVAS_SIDE) fail(`${where}.rows[0]`, `row must contain 1–${CANVAS_SIDE} characters`);
  const w = verb === 'grid' ? rows[0].length : value.w, h = verb === 'grid' ? rows.length : value.h;
  for (const [key, number, max] of [['x', value.x, recipe.width - 1], ['y', value.y, recipe.height - 1], ['w', w, recipe.width], ['h', h, recipe.height]]) {
    if (!Number.isInteger(number) || number < (key === 'w' || key === 'h' ? 1 : 0) || number > max) fail(`${where}.${key}`, 'expected an integer region inside the canvas');
  }
  if (value.x + w > recipe.width || value.y + h > recipe.height) fail(where, 'region must fit inside the canvas');
  if (rows && rows.some(row => typeof row !== 'string')) fail(`${where}.rows`, ROWS);
  if (rows) sameWidth(rows, `${where}.rows`);
  if (value.mask !== undefined && (!Array.isArray(value.mask) || value.mask.length !== h || value.mask.some(row => typeof row !== 'string' || row.length !== w || /[^x.]/.test(row)))) fail(`${where}.mask`, 'mask must match the region: x selects, dot preserves');
  if (value.erase !== undefined && (typeof value.erase !== 'string' || value.erase.length !== 1 || '. '.includes(value.erase) || Object.hasOwn(recipe.palette ?? {}, value.erase))) fail(`${where}.erase`, 'choose one non-palette character other than dot/space for erasure');
  let data, from, to;
  if (verb !== 'grid') data = renderProject(recipe).frames[frameIndex].data;
  if (verb === 'move') {
    for (const key of ['dx', 'dy']) if (!Number.isInteger(value[key]) || Math.abs(value[key]) > CANVAS_SIDE) fail(`${where}.${key}`, `expected an integer offset from -${CANVAS_SIDE} to ${CANVAS_SIDE}`);
  } else if (verb === 'recolor') {
    // A key means its colour as this frame draws it: a frame palette recolours the frame's own drawing.
    from = parseColor(value.from, { ...recipe.palette, ...recipe.frames[frameIndex].palette }, `${where}.from`); to = value.to; parseColor(to, recipe.palette, `${where}.to`);
  }
  const pixels = [], moved = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (value.mask && value.mask[y][x] !== 'x') continue;
    const px = value.x + x, py = value.y + y, at = (py * recipe.width + px) * 4;
    if (verb === 'grid') {
      const char = rows[y][x]; if (char === '.' || char === ' ') continue;
      if (char !== value.erase && !Object.hasOwn(recipe.palette ?? {}, char)) fail(`${where}.rows[${y}]`, `unknown palette character ${JSON.stringify(char)}`);
      pixels.push({ x: px, y: py, color: char === value.erase ? 'transparent' : char });
    } else if (verb === 'recolor') {
      if (from.every((c, i) => data[at + i] === c)) pixels.push({ x: px, y: py, color: to });
    } else {
      const tx = px + value.dx, ty = py + value.dy;
      if (tx < 0 || ty < 0 || tx >= recipe.width || ty >= recipe.height) fail(where, 'selected destination falls outside the canvas; clipping is not implicit');
      pixels.push({ x: px, y: py, color: 'transparent' });
      moved.push({ x: tx, y: ty, color: hex(data.subarray(at, at + 4)) });
    }
  }
  return [...pixels, ...moved]; // Capture before clearing so overlapping moves preserve every highlight.
}
// The refusal of a frame's corrections past FRAME_PIXELS names what does work: operations that draw over the frame.
// Those are its top shown layer's when that layer composites plainly (core draws frame.ops beneath layers); when the
// layer is offset, translucent, recoloured or sorted by ground, its operations would not land as drawn, so the reply
// names a new top layer instead. It also says which corrections still draw over any operations: the recipe's own
// (`kept`, removable) and those earlier changes of this call add (`added`, [change index, count]), which never reach
// the recipe since a refused patch changes nothing. Together they are the frame's list (patchRecipe keeps the ledger).
function tooManyCorrections(frame, verb, count, kept, added) {
  const layers = Array.isArray(frame.layers) ? frame.layers : [], f = `frames[${frame.name}]`, n = value => value.toLocaleString('en-US');
  const top = layers.findLastIndex(layer => isObject(layer) && layer.visible !== false && layer.opacity !== 0);
  let route = `the frame's operations (a set of ${f}.ops or an insert at ${f}.ops[-])`;
  if (top >= 0) {
    const layer = layers[top], plain = (layer.opacity ?? 1) === 1 && !layerOffset(layer, frame.groups).some(Boolean) && layer.palette === undefined && layer.sort === undefined;
    const named = layer.name, unique = typeof named === 'string' && /^[a-zA-Z][\w-]*$/.test(named) && layers.filter(item => isObject(item) && item.name === named).length === 1;
    const ops = `${f}.layers[${unique ? named : top}].ops`;
    route = plain ? `its top layer's operations (a set of ${ops} or an insert at ${ops}[-])` : `operations in a new top layer (an insert at ${f}.layers[-] of {"ops": [...]})`;
  }
  const total = kept + added.reduce((sum, [, k]) => sum + k, 0), them = k => (k === 1 ? 'it' : 'them');
  const clauses = [...(kept ? [`${added.length ? `the recipe has ${n(kept)} of them ` : ''}(remove ${f}.pixels to drop ${them(kept)})`] : []),
    ...added.map(([i, k], j) => `changes[${i}] adds ${total === 1 ? 'it' : `${n(k)}${kept || j ? '' : ' of them'}`}`)];
  const note = !total ? '' : `. The frame's ${n(total)} pixel correction${total === 1 ? ' still draws' : 's still draw'} over its operations${(added.length ? ': ' : ' ') + [clauses.slice(0, -1).join(', '), clauses.at(-1)].filter(Boolean).join(' and ')}` +
    (added.length ? `; drop or shrink ${them(added.length)}` : '');
  return `with this ${verb}, frame ${JSON.stringify(frame.name)} would have ${n(count)} pixel corrections, and a frame's corrections together hold at most ${FRAME_LIST}: recolour or redraw an area this large with ${route}, or change a smaller region${note}`;
}
// Names an exact colour as this frame draws it: a palette key (single characters first), transparent, or hex.
function frameColorNamer(recipe, frameIndex) {
  const palette = recipe.palette ?? {}, overrides = recipe.frames[frameIndex].palette ?? {}, names = new Map();
  for (const key of Object.keys(palette).sort((a, b) => (a.length === 1 ? 0 : 1) - (b.length === 1 ? 0 : 1))) {
    const id = pixelId(parseColor(overrides[key] ?? palette[key], palette), 0);
    if (id && !names.has(id)) names.set(id, key);
  }
  return id => (id === 0 ? 'transparent' : names.get(id) ?? hex(colorOf(id)));
}
// Proposed De-Corner/De-Stray fixes for one rendered frame, as ordinary canvas corrections (see craft.js cleanupIds).
function cleanupPixels(recipe, frameIndex, value, where) {
  if (!isObject(value)) fail(where, 'expected {corners?, strays?, x?, y?, w?, h?, mask?, colors?}');
  for (const key of Object.keys(value)) if (!['corners', 'strays', 'x', 'y', 'w', 'h', 'mask', 'colors'].includes(key) || value[key] === null) fail(`${where}.${key}`, 'unknown or null cleanup field');
  for (const key of ['corners', 'strays']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${where}.${key}`, 'expected a boolean');
  if (!value.corners && !value.strays) fail(where, 'cleanup needs corners: true, strays: true or both');
  const { width, height } = recipe, x = value.x ?? 0, y = value.y ?? 0;
  for (const [key, number, max] of [['x', x, width - 1], ['y', y, height - 1]]) if (!Number.isInteger(number) || number < 0 || number > max) fail(`${where}.${key}`, 'expected an integer region inside the canvas');
  const w = value.w ?? width - x, h = value.h ?? height - y;
  for (const [key, number, max] of [['w', w, width - x], ['h', h, height - y]]) if (!Number.isInteger(number) || number < 1 || number > max) fail(`${where}.${key}`, 'region must fit inside the canvas');
  if (value.mask !== undefined && (!Array.isArray(value.mask) || value.mask.length !== h || value.mask.some(row => typeof row !== 'string' || row.length !== w || /[^x.]/.test(row)))) fail(`${where}.mask`, 'mask must match the region: x selects, dot preserves');
  if (value.colors !== undefined && (!Array.isArray(value.colors) || !value.colors.length || value.colors.length > 64)) fail(`${where}.colors`, 'expected 1–64 colors whose pixels may change');
  const only = value.colors === undefined ? null : new Set(value.colors.map((color, i) => pixelId(parseColor(color, recipe.palette ?? {}, `${where}.colors[${i}]`), 0)));
  const ids = idsOf(renderProject(recipe).frames[frameIndex].data);
  const allowed = index => {
    const px = index % width, py = Math.floor(index / width);
    return px >= x && py >= y && px < x + w && py < y + h && (!value.mask || value.mask[py - y][px - x] === 'x') && (!only || only.has(ids[index]));
  };
  const fixes = cleanupIds(ids, width, height, { corners: value.corners === true, strays: value.strays === true, allowed }), name = frameColorNamer(recipe, frameIndex);
  return { entries: fixes.map(fix => ({ x: fix.x, y: fix.y, color: name(fix.id) })), summary: { corners: fixes.filter(fix => fix.kind === 'corner').length, strays: fixes.filter(fix => fix.kind === 'stray').length } };
}

// Paths use the same form as error messages, such as frames[3].ops[0].x; "project." is optional.
function parsePath(text, where) {
  if (typeof text !== 'string' || !text) fail(where, 'expected a path such as frames[idle].duration');
  const source = text.replace(/^project(?=[.[])/, ''), segments = [], first = /^[^.[\]"]+/.exec(source);
  let at = first ? first[0].length : 0;
  if (first) segments.push({ key: first[0] });
  while (at < source.length) {
    segmentPattern.lastIndex = at;
    const match = segmentPattern.exec(source);
    if (!match) fail(where, `cannot read ${JSON.stringify(source.slice(at))} in ${JSON.stringify(text)}; use .key, [index], [name] or [-]`);
    at = segmentPattern.lastIndex;
    if (match[1] !== undefined) segments.push({ key: match[1] });
    else if (match[3] !== undefined) segments.push({ name: JSON.parse(match[3]) });
    else if (match[2] === '-') segments.push({ end: true });
    else if (match[2] === '*') segments.push({ any: true });
    else segments.push(/^\d+$/.test(match[2]) ? { index: Number(match[2]) } : { name: match[2] });
  }
  return segments;
}

// The recipe's top-level fields that hold an object (the schema's sheet, palette, symbols and animations), which a set
// of one field inside them creates when missing. Only these, one level deep, and never a list: the schema is not at
// hand in the browser, and a deeper or wrong guess would build a shape the renderer then refuses far from the typo.
const OBJECT_FIELDS = ['sheet', 'palette', 'symbols', 'animations'];

// Walks to the final segment's container. Lists take [index], [name] (the item whose name, or string value, matches)
// or [-] for the end; an insert may create the list it inserts into, and a set a top-level object (OBJECT_FIELDS).
function locate(root, segments, where, verb) {
  let node = root, path = '';
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1, owner = path || 'the project';
    let slot;
    if (segment.any) fail(where, '[*] is every item of a list, for set, remove and insert: frames[*].layers[cape].palette');
    if (Array.isArray(node)) {
      if (segment.key !== undefined) fail(where, `${owner} is a list; select an item with [index] or [name]`);
      if (segment.end) {
        if (!last || verb !== 'insert') fail(where, END_ONLY);
        slot = node.length;
      } else if (segment.index !== undefined) slot = segment.index;
      else {
        const matches = node.flatMap((item, index) => ((isObject(item) ? item.name : item) === segment.name ? [index] : []));
        if (matches.length !== 1) fail(where, matches.length ? `${matches.length} items in ${owner} match ${JSON.stringify(segment.name)}; use an index` : `${owner} has no item named ${JSON.stringify(segment.name)}`);
        [slot] = matches;
      }
      if (slot > node.length - (last && verb === 'insert' ? 0 : 1)) fail(where, `${owner} has ${node.length} item${node.length === 1 ? '' : 's'}`);
      path += `[${slot}]`;
    } else if (isObject(node)) {
      if (segment.end) fail(where, `${owner} is not a list`);
      slot = segment.key ?? segment.name ?? String(segment.index);
      path += /^[^.[\]"]+$/.test(slot) ? `${path ? '.' : ''}${slot}` : `[${JSON.stringify(slot)}]`;
      if (!last && !Object.hasOwn(node, slot)) {
        const next = segments[i + 1];
        if (verb === 'insert' && i === segments.length - 2 && (next.end || next.index === 0)) define(node, slot, []);
        // A set one step into a missing top-level object starts it: sheet.columns on a recipe without a sheet.
        else if (verb === 'set' && i === 0 && segments.length === 2 && next.key !== undefined && OBJECT_FIELDS.includes(slot)) define(node, slot, {});
        else fail(where, `${owner} has no field ${JSON.stringify(slot)}`);
      }
    } else fail(where, `${owner} is ${JSON.stringify(node)}, not an object or list`);
    if (last) return { parent: node, slot, path };
    node = node[slot];
  }
}

const END_ONLY = '[-] is the end of a list and can only end an insert path';
// frames[*].layers[cape].palette: [*] stands for every item of a list, so one change reaches a layer in every frame.
// Returns the path of each match. An item that lacks what the rest of the path names (a frame without that layer, or
// for a remove without that field) is passed over; no match at all is an error. An insert's path ends at a place in a
// list, frames[*].ops[0], and matches every item that has the list, or that may start it ([0] or [-] of a list an
// insert creates): a prop drawn behind every frame of a compiled effect. A path that ends at a named item,
// frames[*].layers[cape], matches only the lists that hold one, whatever the verb (an insert goes before it).
function everyMatch(root, segments, where, verb) {
  if (segments.at(-1).any) fail(where, '[*] is followed by what to change in each item, such as frames[*].duration');
  if (segments.some((segment, i) => segment.end && (verb !== 'insert' || i !== segments.length - 1))) fail(where, END_ONLY);
  const text = taken => taken.map((segment, i) => (segment.key !== undefined ? `${i ? '.' : ''}${segment.key}` : segment.index !== undefined ? `[${segment.index}]` : `[${JSON.stringify(segment.name)}]`)).join('');
  const child = (node, segment) => (Array.isArray(node) ? (segment.index !== undefined ? node[segment.index] : node.find(item => (isObject(item) ? item.name : item) === segment.name))
    : isObject(node) ? node[segment.key ?? segment.name ?? String(segment.index)] : undefined);
  const matches = [];
  const walk = (node, i, taken) => {
    const segment = segments[i];
    if (segment.any) {
      if (!Array.isArray(node)) fail(where, `[*] needs a list, and ${text(taken) || 'the project'} is not one`);
      node.forEach((item, index) => walk(item, i + 1, [...taken, { index }]));
    } else if (i === segments.length - 1) {
      const named = Array.isArray(node) && segment.name !== undefined;
      if (named ? child(node, segment) !== undefined : verb === 'insert' ? Array.isArray(node) : verb === 'set' ? isObject(node) || Array.isArray(node) : child(node, segment) !== undefined) {
        matches.push(segment.end ? `${text(taken)}[-]` : text([...taken, segment]));
      }
    } else if (child(node, segment) !== undefined) walk(child(node, segment), i + 1, [...taken, segment]);
    else if (verb === 'insert' && i === segments.length - 2 && isObject(node) && (segments[i + 1].end || segments[i + 1].index === 0)) matches.push(`${text([...taken, segment])}${segments[i + 1].end ? '[-]' : '[0]'}`);
  };
  walk(root, 0, []);
  if (!matches.length) fail(where, 'no item has what this path names');
  if (matches.length > 4096) fail(where, `the path matches ${matches.length} places; at most 4,096`);
  return matches;
}

// Applies changes in order to a copy of the recipe. Each edit reports its resolved path and the value it replaced; a
// change with [*] reports how many places it matched.
export function patchRecipe(recipe, changes) {
  if (!isObject(recipe)) fail('project', 'expected an object');
  if (!Array.isArray(changes) || !changes.length || changes.length > 1024) fail('changes', 'expected a list of 1–1024 changes');
  const estimate = (source, change) => {
    if (!change || !CANVAS.some(verb => change[verb] !== undefined)) return 0;
    const renders = (change.scope === 'frame' ? 2 : 0) + (change.move !== undefined || change.recolor !== undefined || change.cleanup !== undefined ? 1 : 0);
    return (source.width * source.height || 0) * (2 + renders * (source.frames?.length ?? 0));
  };
  const budget = 67108864;
  if (changes.reduce((sum, change) => sum + estimate(recipe, change), 0) > budget) fail('changes', 'regional edit work exceeds 67,108,864 estimated pixels; split the batch or reduce frame scope');
  const next = structuredClone(recipe), edits = [];
  // For a refusal's note, a ledger of who owns each entry of each working frame's corrections, in list order: the input
  // recipe ('recipe') or a change of this call (its index). A canvas change owns the coordinates it adds (one already
  // corrected keeps its owner); an insert into the list owns its entry and a remove of one entry drops that entry's
  // owner; a change that replaces the list or the frame (a set or remove of frames[f].pixels or frames[f], an insert of
  // a frame) owns all of the new list.
  // `lists` finds the entry of a list a change inserts into or removes one entry of.
  const corrections = frame => (Array.isArray(frame?.pixels) ? frame.pixels.length : 0), ledger = new Map(), lists = new WeakMap();
  const record = (frame, owners) => {
    const entry = { list: frame.pixels, owners };
    ledger.set(frame, entry);
    if (Array.isArray(frame.pixels)) lists.set(frame.pixels, entry);
  };
  const own = (frame, source) => record(frame, Array(corrections(frame)).fill(source));
  const spot = pixel => `${pixel.x},${pixel.y}`;
  // `before` is the list a canvas change merged into and `loaded` the size of the coordinate Map it built from it: when
  // that list held one entry per coordinate, the Map kept it in order and appended the new coordinates, so their owners
  // follow without mapping the whole list again (a change on a frame of 65,536 corrections would otherwise cost twice).
  const merged = (frame, source, before, loaded) => {
    const entry = ledger.get(frame), first = new Map();
    if (entry && Array.isArray(before) && entry.list === before && entry.owners.length === before.length && loaded === before.length) {
      record(frame, entry.owners.concat(Array(corrections(frame) - before.length).fill(source)));
      return;
    }
    if (Array.isArray(entry?.list)) entry.list.forEach((pixel, k) => { if (!first.has(spot(pixel))) first.set(spot(pixel), entry.owners[k]); });
    record(frame, (Array.isArray(frame.pixels) ? frame.pixels : []).map(pixel => first.get(spot(pixel)) ?? source));
  };
  // After a set, insert or remove: a frame whose list, or which itself, is new is owned by that change.
  const settle = i => {
    if (Array.isArray(next.frames)) for (const frame of next.frames) {
      const entry = isObject(frame) && ledger.get(frame);
      if (isObject(frame) && (!entry || entry.list !== frame.pixels || entry.owners.length !== corrections(frame))) own(frame, i);
    }
  };
  if (Array.isArray(next.frames)) for (const frame of next.frames) if (isObject(frame)) own(frame, 'recipe');
  const refuse = (where, frame, verb, count) => {
    const parts = new Map();
    for (const source of ledger.get(frame)?.owners ?? []) parts.set(source, (parts.get(source) ?? 0) + 1);
    fail(where, tooManyCorrections(frame, verb, count, parts.get('recipe') ?? 0, [...parts].filter(([source]) => source !== 'recipe').sort((a, b) => a[0] - b[0])));
  };
  let work = 0;
  const apply = (change, i) => {
    const where = `changes[${i}]`;
    if (!isObject(change)) fail(where, 'expected an object such as {"set": "frames[idle].duration", "value": 120}');
    for (const key of Object.keys(change)) if (![...VERBS, 'scope', 'value'].includes(key)) fail(`${where}.${key}`, 'unknown field in patch: a change is {"set": "<path>", "value": …}, {"insert": "<path>", "value": …} or {"remove": "<path>"}, or paint, grid, move, recolor or cleanup with a frame path');
    const verbs = VERBS.filter(verb => change[verb] !== undefined);
    if (verbs.length !== 1) fail(where, 'use exactly one of set, insert, remove, paint, grid, move, recolor or cleanup');
    const [verb] = verbs, target = `${where}.${verb}`;
    const painting = CANVAS.includes(verb);
    work += estimate(next, change);
    if (work > budget) fail(where, 'regional edit work exceeds 67,108,864 estimated pixels; split the batch');
    if (change.scope !== undefined && (!painting || !['frame', 'inherited'].includes(change.scope))) fail(`${where}.scope`, 'paint/grid/move/recolor/cleanup scope must be frame or inherited (default)');
    if (verb === 'remove' && change.value !== undefined) fail(`${where}.value`, 'remove takes no value');
    if (verb !== 'remove' && change.value === undefined) fail(`${where}.value`, `${verb} needs a value`);
    if (change.value === null) fail(`${where}.value`, 'null is not supported; remove the field instead');
    const { parent, slot, path } = locate(next, parsePath(change[verb], target), target, verb);
    const edit = { [verb]: change[verb], ...(path !== change[verb].replace(/^project\.?/, '') && { at: path }) };
    if (painting) {
      if (parent !== next.frames || !isObject(parent[slot])) fail(target, `${verb} needs a frame path, such as frames[blink]`);
      const protectedFrames = change.scope === 'frame' ? renderProject(next).frames : null;
      const cleaned = verb === 'cleanup' ? cleanupPixels(next, slot, change.value, `${where}.value`) : null;
      const entries = verb === 'paint' ? change.value : cleaned ? cleaned.entries : regionPixels(next, slot, verb, change.value, `${where}.value`);
      if (!Array.isArray(entries) || (verb === 'paint' && (!entries.length || entries.length > FRAME_PIXELS))) fail(`${where}.value`, verb === 'paint' ? PAINT : 'expected a bounded pixel list');
      const frame = parent[slot];
      if (frame.pixels !== undefined && (!Array.isArray(frame.pixels) || frame.pixels.some(pixel => !isObject(pixel)))) fail(target, `${path}.pixels must be a list of pixel objects`);
      // A region change past twice a frame's corrections (a move clears and writes each pixel) is refused before its
      // pixels are merged, with the same advice; the count is of the distinct pixels it and the frame would correct.
      if (entries.length > 2 * FRAME_PIXELS) {
        const seen = new Uint8Array(next.width * next.height);
        let count = 0;
        for (const pixel of [...(frame.pixels ?? []), ...entries]) {
          const at = pixel.y * next.width + pixel.x;
          if (Number.isInteger(pixel.x) && Number.isInteger(pixel.y) && at >= 0 && at < seen.length && !seen[at]) { seen[at] = 1; count++; }
        }
        refuse(`${where}.value`, frame, verb, count);
      }
      // Keep one correction per coordinate. Later paint replaces an earlier correction, without touching layers.
      const before = frame.pixels, pixels = new Map((before ?? []).map(pixel => [`${pixel.x},${pixel.y}`, pixel])), loaded = pixels.size;
      entries.forEach((pixel, j) => {
        const pp = `${where}.value[${j}]`;
        if (!isObject(pixel)) fail(pp, 'expected a pixel with x, y and color');
        for (const key of Object.keys(pixel)) if (!['x', 'y', 'color'].includes(key)) fail(`${pp}.${key}`, 'unknown field');
        for (const [axis, limit] of [['x', next.width], ['y', next.height]]) {
          if (!Number.isInteger(pixel[axis]) || pixel[axis] < 0 || pixel[axis] >= limit) fail(`${pp}.${axis}`, `expected an integer from 0 to ${limit - 1} in canvas coordinates`);
        }
        parseColor(pixel.color, next.palette ?? {}, `${pp}.color`);
        pixels.set(`${pixel.x},${pixel.y}`, structuredClone(pixel));
      });
      // The limit is on the frame's corrections together, so splitting a change never gets past it: say what does.
      if (pixels.size > FRAME_PIXELS) refuse(`${where}.value`, frame, verb, pixels.size);
      if (pixels.size) frame.pixels = [...pixels.values()];
      merged(frame, i, before, loaded);
      edit.pixels = entries.length;
      if (cleaned) Object.assign(edit, cleaned.summary);
      if (change.scope !== undefined) edit.scope = change.scope;
      if (protectedFrames) {
        const current = renderProject(next); edit.protected = [];
        for (let index = slot + 1; index < next.frames.length; index++) {
          const original = protectedFrames[index].data, changed = current.frames[index].data;
          const before = next.frames[index].pixels, restore = new Map((before ?? []).map(pixel => [`${pixel.x},${pixel.y}`, pixel])), loaded = restore.size, named = frameColorNamer(next, index);
          let count = 0;
          for (let at = 0; at < original.length; at += 4) {
            if (original.subarray(at, at + 4).every((c, i) => c === changed[at + i])) continue;
            const x = at / 4 % next.width, y = Math.floor(at / 4 / next.width);
            // Named by the palette key that draws it where one does, so a later palette edit still reaches it.
            restore.set(`${x},${y}`, { x, y, color: named(pixelId(original, at)) }); count++;
          }
          if (count) { next.frames[index].pixels = [...restore.values()]; merged(next.frames[index], i, before, loaded); edit.protected.push({ frame: next.frames[index].name, pixels: count }); }
        }
      }
    } else if (verb === 'insert') {
      if (!Array.isArray(parent)) fail(target, `insert needs a list position, such as ${path}[-]`);
      parent.splice(slot, 0, structuredClone(change.value));
      lists.get(parent)?.owners.splice(slot, 0, i);
    } else if (Array.isArray(parent) || Object.hasOwn(parent, slot)) {
      edit.before = summarize(parent[slot]);
      if (verb === 'set') define(parent, slot, structuredClone(change.value));
      else if (Array.isArray(parent)) { parent.splice(slot, 1); lists.get(parent)?.owners.splice(slot, 1); }
      else delete parent[slot];
    } else if (verb === 'set') {
      edit.created = true;
      define(parent, slot, structuredClone(change.value));
    } else fail(target, `nothing to remove at ${path}`);
    return edit;
  };
  changes.forEach((change, i) => {
    const verb = isObject(change) ? ['set', 'remove', 'insert'].find(key => typeof change[key] === 'string' && change[key].includes('[*]')) : undefined;
    if (!verb) {
      edits.push(apply(change, i));
      if (!CANVAS.some(key => change[key] !== undefined)) settle(i);
      return;
    }
    const matches = everyMatch(next, parsePath(change[verb], `changes[${i}].${verb}`), `changes[${i}].${verb}`, verb);
    for (const path of matches) apply({ ...change, [verb]: path }, i);
    settle(i);
    edits.push({ [verb]: change[verb], matched: matches.length });
  });
  return { recipe: next, edits };
}
