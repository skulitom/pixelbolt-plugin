// Tiled (mapeditor.org) tilesets in Tiled's XML format (.tsx), made from a Pixelbolt atlas. Browser-compatible: no
// imports, and the same atlas always gives the same bytes.
//
// A Tiled tileset cuts one image into a grid. Pixelbolt's untrimmed sheet is that grid: every cell is padded on all
// sides, so the margin is the padding and the spacing twice it, and a frame's tile id is its place in the grid, its
// index among the recipe's frames. Terrains become Wang sets, Tiled's terrain sets, which its Terrain Brush paints:
// - blob, cardinal and corner sets become mixed (sides and corners), edge and corner Wang sets, one per terrain with
//   one colour. A tile's Wang id marks the sides and corners where its terrain goes on, which is its neighbour mask:
//   Tiled lists them top, top-right, right, …, top-left, the order of a blob mask's bits. Tiled's brush paints sides
//   and corners, not cells, so a lone cell (a blob or cardinal mask 0) has none and is no Wang tile; place it by hand.
//   A corner set's empty tile is none either: Tiled leaves the cell empty.
// - a layered set becomes one corner Wang set whose colours are its terrains in order of first appearance, the bottom
//   first; a tile's corners are its corners' colours. A corner set's corners are Pixelbolt's map cells, so painting
//   them as a map's cells draws the tiles Pixelbolt's tilemap draws.
// A frame's tile.weight becomes its probability against the heaviest tile of its kind (one terrain and mask, one set of
// corners, or the plain tiles), which Tiled picks between; its tile.collision polygons objects in its collision group
// (in exported pixels) and tile.oneWay a bool property oneWay. An atlas animation over frames of one kind (one terrain and
// mask, one set of corners, or plain tiles) is one tile, its first frame (see tileAnimations): its other frames are no
// Wang tiles, so the brush never places a still frame of it, and when it loops the tile plays it.

// Which frames of a tile sheet are tiles and which are later frames of a tile's animation: the one rule for the Tiled
// tileset here and the Godot TileSet (godot.js imports it), so both editors are offered the same tiles from one atlas.
// `animations` is the atlas's, in order; `kind(frame)` says what a frame is as a tile (null for none), and frames of
// one kind are alternatives an editor picks between. An animation with two or more frames, all of one kind, claims its
// frames: the first is its tile and the others are `covered`, never tiles of their own, whether or not the animation
// can play in that editor (each writer decides that from `claims`, [{ key, animation }] in order), so a set whose
// animation can't play doesn't flicker between its frames. A frame is claimed once: an animation with a frame an
// earlier one covered, or with a later frame that starts an earlier one (which stays that animation's tile), claims
// nothing. An animation's first frame is its tile even where the animation comes back to it (a hold, or a loop that
// ends on it), and may start more than one animation.
export function tileAnimations(animations, kind) {
  const claims = [], covered = new Set(), starts = new Set();
  for (const [key, animation] of Object.entries(animations ?? {})) {
    const frames = animation.frames, first = kind(frames[0]);
    if (frames.length < 2 || first === null || frames.some(frame => covered.has(frame) || kind(frame) !== first || (frame !== frames[0] && starts.has(frame)))) continue;
    starts.add(frames[0]);
    for (const frame of frames.slice(1)) if (frame !== frames[0]) covered.add(frame);
    claims.push({ key, animation });
  }
  return { claims, covered };
}

// The positions in a Wang id of each mask bit: blob bits run in Tiled's order; a cardinal mask has sides only and a
// corner mask (NW, NE, SW, SE) corners only.
const WANG_INDEX = {
  blob: [[1, 0], [2, 1], [4, 2], [8, 3], [16, 4], [32, 5], [64, 6], [128, 7]],
  cardinal: [[1, 0], [2, 2], [4, 4], [8, 6]],
  corner: [[1, 7], [2, 1], [4, 5], [8, 3]]
};
// A layered tile's corners (NW, NE, SW, SE) in a Wang id.
const CORNER_PLACES = [7, 1, 5, 3];
const WANG_TYPES = { blob: 'mixed', cardinal: 'edge', corner: 'corner' };
// Wang tiles a complete set has: its masks less the one with no terrain around it.
const WANG_TILES = { blob: 46, cardinal: 15, corner: 15 };
// The Tiled map format this file is written in; every feature used has been read since Tiled 1.5.
export const TILED_FORMAT = '1.10';

// Names (a scene's instance names and asset ids are any text) go in attributes: a tab or line break is written as a
// character reference, which a parser keeps, and a character XML can't hold at all (other control characters, U+FFFE,
// U+FFFF, half a surrogate pair) becomes U+FFFD, or Tiled can't read the file.
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\t\n\r]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
const hex = ([r, g, b]) => `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
const number = value => String(Number(value.toFixed(6)));
const popcount = mask => { let bits = 0; for (let m = mask; m; m &= m - 1) bits++; return bits; };

// A Tiled tileset (.tsx) of one sheet. `source` is a tile source as export.js's tileSource makes it:
// { atlas, tiles, layered, plain, colors, name, terrain, margin, separation, image, title }, the atlas untrimmed, image
// the sheet's path relative to the .tsx (default the atlas's meta.image, beside it) and title the tileset's name in
// Tiled (default name, which also names its terrains: a hazed copy of a sheet keeps its terrains' names under its own
// title). Returns { text, warnings }; text is
// null when the sheet is not a grid. `oneShots: false` leaves out the warnings for animations that can't play in a tile
// (they don't loop, or start on a frame that already plays one), which a sprite's tileset expects (an attack plays once).
export function tiledTileset(source, { oneShots = true } = {}) {
  const { atlas, margin = 0, separation = 0 } = source, warnings = [], frames = atlas.frames, names = Object.keys(frames);
  const first = frames[names[0]].frame, [w, h] = [first.w, first.h], { w: width, h: height } = atlas.meta.size;
  // The grid Tiled cuts the image into, which every frame must sit on.
  const columns = (width - 2 * margin + separation) / (w + separation), rows = (height - 2 * margin + separation) / (h + separation);
  const place = name => { const { x, y, w: fw, h: fh } = frames[name].frame; return { col: (x - margin) / (w + separation), row: (y - margin) / (h + separation), fw, fh }; };
  const offGrid = names.find(name => { const { col, row, fw, fh } = place(name); return fw !== w || fh !== h || !Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= columns || row >= rows; });
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || offGrid !== undefined) return { text: null, warnings: ['not written: a Tiled tileset cuts its image into a grid, and this sheet has none (a trimmed sheet packs frames without one)'] };
  const id = name => { const { col, row } = place(name); return row * columns + col; };

  // What a frame is as a tile: its terrain and mask, its corners, '' for a plain tile, or null for none.
  const byFrame = new Map(source.tiles.map(tile => [tile.frame, { ...tile, terrain: tile.terrain ?? source.terrain ?? source.name }]));
  const cornered = new Map((source.layered ?? []).map(tile => [tile.frame, tile.corners])), plain = new Set(source.plain ?? []);
  const kind = frame => (byFrame.has(frame) ? `${byFrame.get(frame).terrain} ${byFrame.get(frame).mask}` : cornered.has(frame) ? `corners ${cornered.get(frame).join()}` : plain.has(frame) ? '' : null);

  // Animated tiles. In a sheet with terrain, which frames an animation takes is tileAnimations' rule, shared with the
  // Godot TileSet; which of them play is Tiled's own: a Tiled tile plays any list of frames, always looping, so every
  // looping animation plays (Godot plays only frames side by side in a row), the first one where two start on one frame.
  // A sheet with no terrain (a sprite's, in a scene) has no brush to keep an animation's frames from: there each looping
  // animation plays from its first frame, whatever other animations its frames are in (a walk that passes through the
  // frame an idle starts on still plays), as long as its first frame plays nothing yet.
  const brushed = byFrame.size > 0 || cornered.size > 0, animated = new Map(), stopping = [], second = [];
  let covered = new Set();
  if (brushed) {
    const taken = tileAnimations(atlas.animations, kind);
    covered = taken.covered;
    for (const { key, animation } of taken.claims) {
      if (!animation.loop) stopping.push(key);
      else if (animated.has(animation.frames[0])) second.push(key);
      else animated.set(animation.frames[0], animation.frames);
    }
  } else for (const [key, animation] of Object.entries(atlas.animations ?? {})) {
    const sequence = animation.frames, start = kind(sequence[0]);
    if (sequence.length < 2 || start === null || sequence.some(frame => kind(frame) !== start) || animated.has(sequence[0]) || sequence.some(frame => covered.has(frame))) continue;
    if (!animation.loop) { stopping.push(key); continue; }
    animated.set(sequence[0], sequence);
    for (const frame of sequence.slice(1)) if (frame !== sequence[0]) covered.add(frame);
  }
  const named = keys => `animation${keys.length === 1 ? '' : 's'} ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''} became still tiles of ${keys.length === 1 ? 'its' : 'their'} first frame`;
  if (stopping.length && oneShots) warnings.push(`${named(stopping)}: Tiled loops every tile animation`);
  if (second.length && oneShots) warnings.push(`${named(second)}: ${second.length === 1 ? 'its first frame already plays' : 'their first frames already play'} an earlier animation, and a Tiled tile plays one`);
  const tiled = names.filter(frame => kind(frame) !== null && !covered.has(frame));

  // Wang sets: one per single terrain, in order of first appearance, then the layered set.
  const sets = new Map();
  for (const frame of tiled) {
    const tile = byFrame.get(frame);
    if (!tile) continue;
    if (!sets.has(tile.terrain)) sets.set(tile.terrain, { name: tile.terrain, modes: new Set(), colors: [tile.terrain], tiles: [] });
    const set = sets.get(tile.terrain);
    set.modes.add(tile.mode);
    let wang = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const [bit, at] of WANG_INDEX[tile.mode]) if (tile.mask & bit) wang[at] = 1;
    if (tile.mask) set.tiles.push({ frame, wang, mask: tile.mask });
  }
  // A warning names its terrain when the tileset has more than one, whether or not each of them gets a Wang set.
  const terrains = sets.size;
  for (const set of sets.values()) {
    if (set.modes.size > 1) {
      warnings.push(`terrain ${set.name}: no Wang set: it mixes ${[...set.modes].sort().join(' and ')} masks, and a Tiled Wang set matches one way; give one set's frames another tile.terrain`);
      sets.delete(set.name);
      continue;
    }
    set.type = WANG_TYPES[[...set.modes][0]];
    const masks = new Set(set.tiles.map(tile => tile.mask)), missing = WANG_TILES[[...set.modes][0]] - masks.size;
    if (missing > 0) warnings.push(`${terrains > 1 ? `terrain ${set.name}: ` : ''}${missing} of the ${WANG_TILES[[...set.modes][0]]} ${[...set.modes][0]} Wang tiles are missing, so Tiled draws its nearest match where one is needed`);
    const fullest = set.tiles.reduce((best, tile) => (!best || popcount(tile.mask) > popcount(best.mask) ? tile : best), null);
    set.icon = fullest ? id(fullest.frame) : -1;
    set.colorIcons = [set.icon];
  }
  const layered = tiled.filter(frame => cornered.has(frame));
  if (layered.length) {
    const colors = [];
    for (const frame of layered) for (const corner of cornered.get(frame)) if (!colors.includes(corner)) colors.push(corner);
    const combinations = colors.length * colors.length * colors.length * colors.length, missing = combinations - new Set(layered.map(frame => cornered.get(frame).join())).size;
    if (missing > 0) warnings.push(`${missing} of the ${combinations} combinations of ${colors.join(', ')} at a tile's corners have no tile, so Tiled draws its nearest match where one is needed`);
    const tiles = layered.map(frame => { const wang = [0, 0, 0, 0, 0, 0, 0, 0]; cornered.get(frame).forEach((corner, k) => { wang[CORNER_PLACES[k]] = colors.indexOf(corner) + 1; }); return { frame, wang }; });
    // Each colour's icon is its plain tile, with it at every corner.
    const colorIcons = colors.map(color => { const tile = layered.find(frame => cornered.get(frame).every(corner => corner === color)); return tile === undefined ? -1 : id(tile); });
    sets.set(`\u0000layers`, { name: source.name, type: 'corner', colors, tiles, icon: -1, colorIcons });
  }

  // Probabilities: a tile's weight against the heaviest tile of its kind, which the Terrain Brush (and the stamp
  // brush's random mode) picks between.
  const weight = frame => frames[frame].tile?.weight ?? 1, heaviest = new Map();
  for (const frame of tiled) heaviest.set(kind(frame), Math.max(heaviest.get(kind(frame)) ?? 1, weight(frame)));

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<tileset version="${TILED_FORMAT}" name="${xml(source.title ?? source.name)}" tilewidth="${w}" tileheight="${h}"${separation ? ` spacing="${separation}"` : ''}${margin ? ` margin="${margin}"` : ''} tilecount="${columns * rows}" columns="${columns}">`,
    ` <image source="${xml(source.image ?? atlas.meta.image)}" width="${width}" height="${height}"/>`];
  const described = names.map(frame => [id(frame), frame]).sort((a, b) => a[0] - b[0]);
  for (const [tileId, frame] of described) {
    const facts = frames[frame].tile ?? {}, isTile = kind(frame) !== null, inner = [];
    const probability = isTile && !covered.has(frame) ? weight(frame) / heaviest.get(kind(frame)) : 1;
    if (facts.oneWay) inner.push('  <properties>', '   <property name="oneWay" type="bool" value="true"/>', '  </properties>');
    if (facts.collision?.length) {
      inner.push('  <objectgroup draworder="index" id="2">');
      facts.collision.forEach((polygon, k) => inner.push(`   <object id="${k + 1}" x="0" y="0">`, `    <polygon points="${polygon.map(({ x, y }) => `${x},${y}`).join(' ')}"/>`, '   </object>'));
      inner.push('  </objectgroup>');
    }
    if (animated.has(frame)) inner.push('  <animation>', ...animated.get(frame).map(step => `   <frame tileid="${id(step)}" duration="${Math.max(1, Math.round(frames[step].duration))}"/>`), '  </animation>');
    if (probability === 1 && !inner.length) continue;
    const open = ` <tile id="${tileId}"${probability !== 1 ? ` probability="${number(probability)}"` : ''}`;
    lines.push(...(inner.length ? [`${open}>`, ...inner, ' </tile>'] : [`${open}/>`]));
  }
  if (sets.size) {
    lines.push(' <wangsets>');
    for (const set of sets.values()) {
      lines.push(`  <wangset name="${xml(set.name)}" type="${set.type}" tile="${set.icon}">`);
      set.colors.forEach((color, k) => lines.push(`   <wangcolor name="${xml(color)}" color="${hex(source.colors?.[color] ?? [255, 255, 255])}" tile="${set.colorIcons[k] ?? -1}" probability="1"/>`));
      for (const tile of [...set.tiles].sort((a, b) => id(a.frame) - id(b.frame))) lines.push(`   <wangtile tileid="${id(tile.frame)}" wangid="${tile.wang.join(',')}"/>`);
      lines.push('  </wangset>');
    }
    lines.push(' </wangsets>');
  }
  lines.push('</tileset>', '');
  return { text: lines.join('\n'), warnings };
}

// ---- Maps ----------------------------------------------------------------------------------------------------------
// A Tiled map (.tmx) of a scene as it stands at one time, unlit: the frames renderScene drew then ({ draws: true }), in
// its drawing order, at their scene positions, so Tiled draws what Pixelbolt's unlit view draws with the camera at
// [0, 0]. Consecutive draws on one plane (the same parallax) become layers:
// - a tilemap becomes a tile layer, painted with its asset's tileset (and its Wang sets, so the Terrain Brush can go on
//   with it), when Tiled's grid can hold it: square cells the size of the map's grid (the first such tilemap's cells),
//   one frame per cell, drawn at 1× from a sheet exported at 1×, and not sorted among other placements. Its offset
//   places it: half a cell up and left for corner tiles, and down by however much its frames are taller than a cell,
//   since Tiled hangs a tile from the bottom of its cell where Pixelbolt hangs it from the top.
// - everything else becomes tile objects in an object layer drawn in list order: placements and each copy of a repeat,
//   each at its frame at that time, sorted tilemaps (whose cells draw among the placements), iso and scaled maps.
//   Objects are the drawn size, so Tiled scales a sheet exported larger back down.
// Each layer carries its plane's parallax as Tiled's parallaxx and parallaxy, which a game reads as Pixelbolt does:
// the layer is drawn at its position less parallax × the camera's top-left. The map keeps Tiled's parallax origin,
// (0, 0): Tiled 1.11 turned round how its editor reads one (from the view's centre plus the origin, where 1.8–1.10
// took the origin away), so no other origin means the same in both. With a camera, the map is wide and tall enough to
// hold every tile object right of and below its origin.
// A hazed placement or tilemap is drawn from a hazed copy of its asset's tileset, whose sheet has the scene's haze
// baked into its colours. Shade placements, which darken what is under them, have nothing in Tiled to become: they are
// left out, with a warning. Lights and the camera's movement stay in the scene. `tilesets` maps each asset id to
// { source, tiles, haze }: its .tsx relative to the map, its tile count, and its hazed copies, [{ amount, source }],
// which have the same tiles. Returns { text, warnings }.
export function tiledMap(scene, draws, { tilesets }) {
  const warnings = [], ids = Object.keys(scene.assets), first = {}, hazedFirst = {}, listed = [];
  let next = 1;
  for (const id of ids) { first[id] = next; listed.push([next, tilesets[id].source]); next += tilesets[id].tiles; }
  for (const id of ids) for (const { amount, source } of tilesets[id].haze ?? []) {
    (hazedFirst[id] ??= new Map()).set(amount, next);
    listed.push([next, source]);
    next += tilesets[id].tiles;
  }
  const project = id => scene.assets[id].recipe;
  const label = i => scene.instances[i].name ?? scene.instances[i].asset;
  // A placement's plane: its own parallax, or its target's when it is attached.
  const parallaxOf = i => scene.instances[scene.instances[i].attach?.index ?? i].parallax;
  // Tilemaps a tile layer can hold, on the grid of the first of them.
  const fits = i => {
    const instance = scene.instances[i], map = instance.tilemap;
    return map && !map.iso && instance.sort !== 'ground' && instance.scale === 1 && project(instance.asset).sheet.scale === 1;
  };
  const firstMap = draws.find(draw => draw.cell !== undefined && fits(draw.instance));
  const grid = firstMap ? scene.instances[firstMap.instance].tilemap.tile : [16, 16];
  const placed = new Map();
  for (const i of new Set(draws.filter(draw => draw.cell !== undefined).map(draw => draw.instance))) {
    const instance = scene.instances[i], map = instance.tilemap;
    if (!fits(i) || map.tile[0] !== grid[0] || map.tile[1] !== grid[1]) continue;
    const corner = map.cells.some(cell => cell.x % grid[0] !== 0 || cell.y % grid[1] !== 0), half = corner ? [grid[0] / 2, grid[1] / 2] : [0, 0];
    const at = map.cells.map(cell => [(cell.x + half[0]) / grid[0], (cell.y + half[1]) / grid[1]]);
    if (at.some(([c, r]) => !Number.isInteger(c) || !Number.isInteger(r)) || new Set(at.map(p => p.join())).size !== at.length) continue;
    // Where its first cell's tile is drawn from, as Tiled draws it: whole cells of that move its cells along the map, and
    // the rest is the layer's offset (all of it for a map reaching left of or above the scene, whose cells stay). A rule's
    // `offset` may draw a cell left of or above the map's own first cell; the cells move on until none is before the
    // map's first row or column, and the offset takes them back (a cell at row -1 threw, one at column -1 was lost).
    const origin = [instance.at[0] - instance.anchor[0] - half[0], instance.at[1] - instance.anchor[1] - half[1] + project(instance.asset).height - grid[1]];
    const move = origin.map((o, axis) => Math.max(0, Math.ceil(o / grid[axis]), -Math.min(...at.map(p => p[axis]))));
    placed.set(i, { at: at.map(([c, r]) => [c + move[0], r + move[1]]), offset: origin.map((o, axis) => o - move[axis] * grid[axis]) });
  }
  // A draw's tile, from its asset's hazed tileset when it is hazed.
  const unbaked = new Set();
  const gid = draw => {
    const hazed = draw.haze ? hazedFirst[draw.asset]?.get(draw.haze) : undefined;
    if (draw.haze && hazed === undefined) unbaked.add(label(draw.instance));
    return (hazed ?? first[draw.asset]) + draw.frame;
  };
  const layers = [], shaded = new Set();
  let current = null;
  for (const draw of draws) {
    if (draw.shade) { shaded.add(label(draw.instance)); continue; }
    const parallax = parallaxOf(draw.instance);
    if (draw.cell !== undefined && placed.has(draw.instance)) {
      if (current?.tiles !== draw.instance) layers.push(current = { tiles: draw.instance, cells: [], parallax });
      current.cells.push(draw);
    } else {
      if (!current?.objects || current.parallax[0] !== parallax[0] || current.parallax[1] !== parallax[1]) layers.push(current = { objects: [], parallax });
      current.objects.push(draw);
    }
  }
  if (shaded.size) warnings.push(`${[...shaded].join(', ')}: left out: a shade placement darkens what is drawn under it, which a Tiled map can't`);
  // With a camera the scene is larger than its view, and tile objects reach as far right and down as they are drawn;
  // without one, what is drawn past the scene's edge is clipped, and the map is the scene.
  const reach = !scene.camera ? [] : layers.flatMap(layer => layer.objects ?? []).map(draw => { const { width, height } = project(draw.asset); return [draw.x + draw.shift[0] + width * draw.scale, draw.y + draw.shift[1] + height * draw.scale]; });
  const size = [0, 1].map(axis => Math.max(1, Math.ceil([scene.width, scene.height][axis] / grid[axis]), ...[...placed.values()].flatMap(({ at }) => at.map(p => p[axis] + 1)), ...reach.map(r => Math.ceil(r[axis] / grid[axis]))));
  const [r, g, b, a] = scene.background, colour = `#${(a === 255 ? [r, g, b] : [a, r, g, b]).map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  // Tiled writes each factor that isn't 1.
  const parallax = ([x, y]) => `${x !== 1 ? ` parallaxx="${number(x)}"` : ''}${y !== 1 ? ` parallaxy="${number(y)}"` : ''}`;
  const body = [];
  let objects = 0;
  layers.forEach((layer, k) => {
    if (layer.tiles !== undefined) {
      const i = layer.tiles, { at, offset } = placed.get(i), cells = Array.from({ length: size[1] }, () => Array(size[0]).fill(0));
      for (const draw of layer.cells) { const [c, row] = at[draw.cell]; cells[row][c] = gid(draw); }
      body.push(` <layer id="${k + 1}" name="${xml(label(i))}" width="${size[0]}" height="${size[1]}"${offset[0] || offset[1] ? ` offsetx="${offset[0]}" offsety="${offset[1]}"` : ''}${parallax(layer.parallax)}>`,
        '  <data encoding="csv">', cells.map(row => row.join(',')).join(',\n'), '</data>', ' </layer>');
      return;
    }
    const names = [...new Set(layer.objects.map(draw => label(draw.instance)))];
    body.push(` <objectgroup draworder="index" id="${k + 1}" name="${xml(names.length > 4 ? `${names.slice(0, 4).join(', ')}, …` : names.join(', '))}"${parallax(layer.parallax)}>`);
    for (const draw of layer.objects) {
      const { width, height } = project(draw.asset), w = width * draw.scale, h = height * draw.scale, x = draw.x + draw.shift[0], y = draw.y + draw.shift[1];
      body.push(`  <object id="${++objects}" name="${xml(label(draw.instance))}" gid="${gid(draw)}" x="${x}" y="${y + h}" width="${w}" height="${h}"/>`);
    }
    body.push(' </objectgroup>');
  });
  if (unbaked.size) warnings.push(`${[...unbaked].join(', ')}: drawn without haze: no hazed tileset was given for it`);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<map version="${TILED_FORMAT}" orientation="orthogonal" renderorder="right-down" width="${size[0]}" height="${size[1]}" tilewidth="${grid[0]}" tileheight="${grid[1]}" infinite="0" backgroundcolor="${colour}" nextlayerid="${layers.length + 1}" nextobjectid="${objects + 1}">`,
    ...listed.map(([firstgid, source]) => ` <tileset firstgid="${firstgid}" source="${xml(source)}"/>`), ...body, '</map>', ''];
  return { text: lines.join('\n'), warnings };
}
