// Whole-walk triage uses visible ownership, rigid stamp placement and four-connected openings.
// All reported pixels use the native canvas. Findings describe observable changes, not artist intent.
import { fail, inspectProject, parseColor } from './core.js';
import {prepareWalkEdges, inspectWalkEdges} from './walk-edges.js';

function adjacent(i, width, size) {
  const cells = [];
  if (i % width) cells.push(i - 1);
  if (i % width < width - 1) cells.push(i + 1);
  if (i >= width) cells.push(i - width);
  if (i + width < size) cells.push(i + width);
  return cells;
}

// Ignore the exterior. A transparent handle that translates with its owner should still match
// its standing opening even in a reflected profile.
function openings(frame, width, height) {
  const size = width * height, seen = new Uint8Array(size), labels = new Int32Array(size);
  const groups = [], stack = [];
  for (let i = 0; i < size; i++) {
    if (seen[i] || frame.data[4*i+3]) continue;
    const cells = [], border = new Set();
    let exterior = false;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      cells.push(j);
      if (j < width || j >= size - width || j % width === 0 || j % width === width - 1) exterior = true;
      for (const k of adjacent(j, width, size)) {
        if (frame.data[k*4+3]) border.add(frame.owners[k]);
        else if (!seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (exterior) continue;
    groups.push({cells,border});
    for (const j of cells) labels[j] = groups.length;
  }
  return {groups,labels};
}

function placements(raw, recipe, ids) {
  const placements = new Map();
  if (!raw || raw.from !== undefined || raw.translate || raw.ops?.length) return placements;
  // A palette edit can erase ink in one phase. Rigid coverage is only comparable across
  // frames with the same transparency. RGB-only animation keeps the same projection.
  const alphaChanges = Object.entries(raw.palette ?? {}).filter(([key,value]) =>
    parseColor(value)[3] !== parseColor(key,recipe.palette)[3]);
  const alpha = JSON.stringify(alphaChanges.map(([key,value])=>[key,parseColor(value)[3]]).sort());
  for (const layer of raw?.layers ?? []) {
    const stamp = layer.ops?.[0], rows = recipe.symbols?.[stamp?.symbol];
    if (layer.ops?.length !== 1 || stamp.op !== 'stamp' || !Array.isArray(rows) || layer.group !== undefined ||
        Object.keys(stamp).some(key=>!['op','symbol','x','y','flipX'].includes(key))) continue;
    placements.set(ids.get(layer.name), {rows, alpha, symbol:stamp.symbol, x:(stamp.x ?? 0)+(layer.x ?? 0),
      y:(stamp.y ?? 0)+(layer.y ?? 0), flipped:Boolean(stamp.flipX)});
  }
  return placements;
}

function projectPixel(i, from, to, width, height) {
  if (!from || !to || from.symbol !== to.symbol || from.alpha !== to.alpha) return -1;
  let localX = i % width - from.x;
  if (from.flipped !== to.flipped) localX = from.rows[0].length - 1 - localX;
  const x = to.x + localX, y = to.y + Math.floor(i / width) - from.y;
  return x >= 0 && x < width && y >= 0 && y < height ? y*width+x : -1;
}


// A closed cut within a single drawing can be invisible in the stand, then open as its
// cover swings away. Keep the source-local cells so an agent can underpaint that drawing.
function hiddenOpenings(stand, base, recipe, rawRest, width, height) {
  const hidden = [], palette = {...recipe.palette,...rawRest.palette};
  const order = new Map([...base.keys()].map((id,index)=>[id,index]));
  for (const [part, placement] of base) {
    const {rows,x,y,flipped} = placement, w = rows[0].length, h = rows.length;
    const data = new Uint8Array(4*w*h), owners = new Uint8Array(w*h);
    const colors = new Map();
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const key = rows[row][col];
      if (key === '.' || key === ' ') continue;
      if (!colors.has(key)) colors.set(key,parseColor(key,palette)[3]);
      data[4*(row*w+col)+3] = colors.get(key);
    }
    for (const hole of openings({data,owners},w,h).groups) {
      const samples = [], covers = new Map();
      for (const cell of hole.cells) {
        const col = cell % w, row = Math.floor(cell / w);
        const sx = x + (flipped ? w-1-col : col), sy = y + row;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const i = sy*width+sx, cover = stand.owners[i];
        if (!cover || order.get(cover) <= order.get(part)) continue;
        covers.set(cover,(covers.get(cover) ?? 0)+1);
        samples.push({i,local:[col,row]});
      }
      if (samples.length === hole.cells.length) {
        const [cover] = [...covers].sort((a,b)=>b[1]-a[1])[0];
        hidden.push({part,cover,samples});
      }
    }
  }
  return hidden;
}

function scanClip(project, recipe, raw, ids, name, info) {
  const {width,height,ownerNames} = project;
  const rest = project.frames.find(frame=>frame.name === info.rest), clip = project.animations[name];
  if (!rest?.owners || !Array.isArray(info.feet) || info.feet.length !== 2 || info.feet.some(foot => !ids.has(foot)) ||
      !['left','right','up','down'].includes(info.direction) || clip?.frames?.length !== 8)
    fail('inspect.walks','the review needs the matching cutout metadata, both named feet, the standing frame and all eight steps of each clip');
  const base = placements(raw.get(rest.name),recipe,ids), feet = new Set(info.feet.map(n=>ids.get(n)));
  const restHoles = openings(rest,width,height), contacts = prepareWalkEdges(rest,feet,width,base);
  const hidden = hiddenOpenings(rest,base,recipe,raw.get(rest.name),width,height);
  const groups = new Map();
  const phaseLayers = clip.frames.map(index => placements(raw.get(project.frames[index].name),recipe,ids));
  const limited = new Set();
  for (const layers of phaseLayers) for (const [id,stand] of base) {
    const step = layers.get(id);
    if (!step || step.symbol !== stand.symbol || step.alpha !== stand.alpha) limited.add(ownerNames[id-1]);
  }
  for (const id of feet) if (!base.has(id)) limited.add(ownerNames[id-1]);
  const isProfile = info.direction === 'left' || info.direction === 'right';
  // In a profile a fixed housing can bob, but its x coordinate is constant across the walk.
  // A sleeve swinging across a leg can reveal legitimate foot ink at its own lateral edge.
  const swinging = new Set([...base.keys()].filter(id => isProfile &&
    new Set(phaseLayers.map(map => map.get(id)?.x)).size > 1));
  const point = i=>[i%width,Math.floor(i/width)];
  function record(type, frame, part, other, i, standAt, count, extra = {}) {
    const key = JSON.stringify([type,part,other]);
    if (!groups.has(key)) groups.set(key,{kind:type,part:ownerNames[part-1],...(other && {otherPart:ownerNames[other-1]}),steps:[]});
    const steps = groups.get(key).steps;
    if (steps.at(-1)?.frame !== frame.name) steps.push({frame:frame.name,pixel:point(i),
      ...(standAt >= 0 && {standingPixel:point(standAt)}),count,...extra});
    else steps.at(-1).count += count;
  }
  for (const [phase,index] of clip.frames.entries()) {
    const frame = project.frames[index], poses = phaseLayers[phase];
    const toStand = (i,id)=>projectPixel(i,poses.get(id),base.get(id),width,height);
    const toStep = (i,id)=>projectPixel(i,base.get(id),poses.get(id),width,height);
    const cutPixels = new Set();
    for (const {part,cover,samples} of hidden) {
      const visible = [];
      for (const {i,local} of samples) {
        const at = toStep(i,part);
        if (at >= 0 && !frame.data[4*at+3]) { visible.push({at,i,local}); cutPixels.add(at); }
      }
      if (visible.length) {
        const first = visible[0];
        record('underpaint-gap',frame,part,cover,first.at,first.i,visible.length,{symbol:base.get(part).symbol,
          localPixel:first.local, drawingGapPixels:samples.length});
      }
    }
    for (const hole of openings(frame,width,height).groups) {
      if (hole.cells.some(i=>cutPixels.has(i))) continue;
      const border = [...hole.border].filter(Boolean);
      let matched, existingGap;
      for (const id of border) {
        const cells = hole.cells.map(i=>toStand(i,id));
        const label = restHoles.labels[cells[0]];
        if (label && restHoles.groups[label-1].border.has(id) && cells.every(i=>restHoles.labels[i] === label)) {
          matched = id;
          break;
        }
        if (cells.every(i=>i >= 0 && !rest.data[4*i+3]) &&
            cells.some(i=>adjacent(i,width,rest.owners.length).some(k=>rest.owners[k] === id))) existingGap = id;
      }
      const first = hole.cells[0], id = matched ?? existingGap ?? border[0];
      const kind = matched ? 'standing-opening' : existingGap ? 'standing-gap' : 'new-opening';
      if (id && !limited.has(ownerNames[id-1])) record(kind,frame,id,border.find(n=>n!==id),first,toStand(first,id),hole.cells.length);
    }
    // Follow every visible foot pixel back to the standing surface that covered it. Exclude
    // the opposite foot. Exposed ink is a shaft candidate only when the old cover still
    // extends below it and touches it at the side in the current frame.
    for (let i=0;i<frame.owners.length;i++) {
      const id = frame.owners[i];
      if (!feet.has(id)) continue;
      const j = toStand(i,id), cover = rest.owners[j];
      if (!cover || feet.has(cover) || swinging.has(cover)) continue;
      const x = i%width, sides = [];
      if (x > 0) sides.push(i-1);
      if (x+1 < width) sides.push(i+1);
      if (!sides.some(k=>frame.owners[k]===cover && (frame.owners[k+width]===cover || frame.owners[k+2*width]===cover))) continue;
      if (!adjacent(i,width,frame.owners.length).some(k=>!frame.owners[k])) continue;
      const drawing = base.get(id), col = j%width - drawing.x;
      record('exposed-shaft',frame,id,cover,i,j,1,{symbol:drawing.symbol,
        localPixel:[drawing.flipped ? drawing.rows[0].length-1-col : col, Math.floor(j/width)-drawing.y]});
    }
    inspectWalkEdges(contacts,frame,width,toStep,record);
  }
  const values = [...groups.values()];
  const order = ['underpaint-gap','carried-island','exposed-shaft','moving-edge','new-opening'];
  const findings = values.filter(row=>order.includes(row.kind)).sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind) || b.steps.length-a.steps.length);
  const controls = values.filter(row=>!order.includes(row.kind));
  return {clip:name,rest:rest.name,direction:info.direction,frames:clip.frames.length,
    ...(limited.size && {limitedParts:[...limited],limitation:'The stamp or its transparency changes. Inspect these parts visually across the affected steps.'}),
    findings:findings.slice(0,16), ...(findings.length > 16 && {omittedFindings:findings.length-16}),
    controls:controls.slice(0,8), ...(controls.length > 8 && {omittedControls:controls.length-8})};
}

export function inspectWalks(project, options, metadata, recipe) {
  const clips = Object.entries(metadata?.animations ?? {}).filter(([,info])=>info?.cutout);
  if (!clips.length) fail('inspect.walks','inspect the editable pose source with walkCycles or expanded walkReview annotations');
  const raw = new Map(recipe.frames.map(frame=>[frame.name,frame]));
  const ids = new Map(project.ownerNames?.map((name,i)=>[name,i+1]));
  for (const [name, info] of clips) {
    const frames = project.animations[name]?.frames;
    if (info.entries && (!Array.isArray(info.entries) || !frames || info.entries.length !== frames.length ||
        info.entries.some((entry, i) => entry?.frame !== project.frames[frames[i]]?.name)))
      fail('inspect.walks','the steps of ' + name + ' disagree with the supplied metadata; inspect the original pose source');
  }
  const reports = clips.map(([name,info])=>scanClip(project,recipe,raw,ids,name,info.cutout));
  // Show a rest and the first reported change per facing. Full per-phase evidence is in steps.
  const samples = [...new Set(reports.flatMap(row=>[row.rest,row.findings[0]?.steps[0]?.frame ?? project.frames[project.animations[row.clip].frames[0]].name]))];
  return {...inspectProject(project,{frames:samples,...options}),mode:'walks',walkReview:{
    advice:'Review the ranked findings in both the composite and isolated drawings. A moving edge or new opening is a clue, not proof that paint must change. Preserve clean silhouettes, standing ink and genuine crossings. For shared ink use the standing coordinate with the motion track view to test the intended carrier.',
    coordinates:'Native canvas [x,y] from the top left. pixel is in the named step. standingPixel is projected through the named part to its original stand.',
    meanings:{'underpaint-gap':'A closed cut inside this single drawing was completely covered in the stand and becomes see-through. Check its local pixels and adjacent ink. Underpaint the hidden joint if the surface should continue; keep the authored gait.',
      'new-opening':'Enclosed transparency absent in the corresponding standing area. Inspect the joint and the art behind it.',
      'exposed-shaft':'A foot pixel hidden in the stand now reaches the outer side of its covering part above its lower edge. Check the upper foot drawing at full stride.',
      'moving-edge':'Touching ink on two standing surfaces separates with the foot. Compare both isolated silhouettes before reassigning equipment or editing an outline.',
      'standing-gap':'These pixels were transparent beside the same part in the stand. Movement now encloses that space.',
      'standing-opening':'This opening projects into an existing standing opening. Preserve intended negative space.',
      'carried-island':'An isolated group on the foot stamp touches another drawing in the stand and separates in the walk. Check both silhouettes and the intended carrier.',
      'foreground-crossing':'Two rigid drawings overlap. foreground identifies which part is visible and coveredStandingPixel locates the hidden ink in the stand. Preserve intended stacking.'},
    clips:reports}};
}
