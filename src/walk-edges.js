// Review rigid walk material at native resolution. A missing coloured edge, a separate
// stamp island and a real foreground crossing have different evidence. Never infer the
// intended owner from coincident colours or from the layer name.
function neighbors(i, width, size) {
  const cells = [];
  if (i % width) cells.push(i - 1);
  if (i % width + 1 < width) cells.push(i + 1);
  if (i >= width) cells.push(i - width);
  if (i + width < size) cells.push(i + width);
  return cells;
}

function pigment(frame, i) {
  const k = 4*i;
  return ((frame.data[k]*256 + frame.data[k+1])*256 + frame.data[k+2])*256 + frame.data[k+3];
}

function localPixel(stamp, i, width) {
  const x = i % width - stamp.x;
  return [stamp.flipped ? stamp.rows[0].length - 1 - x : x, Math.floor(i / width) - stamp.y];
}

function painted(stamp, i, width) {
  if (!stamp) return false;
  const [x,y] = localPixel(stamp,i,width), key = stamp.rows[y]?.[x];
  return key !== undefined && key !== '.' && key !== ' ';
}

// Use the complete foot drawing. A foreground hem can hide the middle of a perfectly
// connected foot. Diagonal joins in a pixel silhouette count as connected.
function footComponents(stamp, width, height) {
  const w = stamp.rows[0].length, h = stamp.rows.length, seen = new Uint8Array(w*h), groups = [];
  for (let j = 0; j < seen.length; j++) {
    const x = j % w, y = Math.floor(j/w);
    if (seen[j] || '. '.includes(stamp.rows[y][x])) continue;
    const stack = [j], cells = [];
    seen[j] = 1;
    while (stack.length) {
      const k = stack.pop(), col = k % w, row = Math.floor(k/w);
      const sx = stamp.x + (stamp.flipped ? w-1-col : col), sy = stamp.y + row;
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) cells.push(sy*width+sx);
      for (let yy=Math.max(row-1,0); yy<=Math.min(row+1,h-1); yy++) {
        for (let xx=Math.max(col-1,0); xx<=Math.min(col+1,w-1); xx++) {
          const next = yy*w+xx;
          if (seen[next] || '. '.includes(stamp.rows[yy][xx])) continue;
          seen[next] = 1; stack.push(next);
        }
      }
    }
    if (cells.length) groups.push(cells);
  }
  return groups;
}

export function prepareWalkEdges(rest, feet, width, base) {
  const size = rest.owners.length, visible = [], colors = new Map(), drawings = new Map(), candidates = [];
  for (let i=0; i<size; i++) {
    const id = rest.owners[i];
    if (!id) continue;
    visible.push(i);
    if (!colors.has(id)) colors.set(id,new Map());
    const counts = colors.get(id), color = pigment(rest,i);
    counts.set(color,(counts.get(color) ?? 0)+1);
  }
  for (const foot of feet) {
    const stamp = base.get(foot);
    if (!stamp) continue;
    const otherFoot = [...feet].find(id=>id!==foot), otherColors = colors.get(otherFoot) ?? new Map();
    const groups = footComponents(stamp,width,size/width), drawn = groups.flat();
    drawings.set(foot,drawn);
    // The isolated shoe is usually the larger component, ending at the sole. Its
    // partner's colours help when an oversized prop has been cut into this drawing.
    const bottom = cells=>cells.reduce((y,i)=>Math.max(y,Math.floor(i/width)),-1);
    const lowest = bottom(drawn);
    const soleScore = cells=>cells.reduce((n,i)=>n+1+(rest.owners[i]===foot && otherColors.has(pigment(rest,i)) ? 1 : 0),0) /
      (1+Math.max(0,lowest-bottom(cells)));
    const pieces = groups.map(cells=>({cells,score:soleScore(cells)})).sort((a,b)=>b.score-a.score);
    for (const [index,{cells}] of pieces.entries()) {
      const edges = new Map(), contacts = new Map();
      for (const i of cells) {
        if (rest.owners[i]!==foot) continue;
        const near = neighbors(i,width,size), color = pigment(rest,i);
        const footFill = near.some(k=>rest.owners[k]===foot && pigment(rest,k)!==color);
        for (const peer of new Set(near.map(k=>rest.owners[k]).filter(id=>id && !feet.has(id)))) {
          const sides = near.filter(k=>rest.owners[k]===peer);
          if (!contacts.has(peer)) contacts.set(peer,new Set());
          for (const k of sides) contacts.get(peer).add(k);
          // Underpaint on the peer already spans this source pixel. Moving a genuine
          // foreground outline across it cannot tear that drawing here.
          if (painted(base.get(peer),i,width)) continue;
          const peerColors = colors.get(peer);
          const side = sides.filter(k=>Math.floor(k/width)===Math.floor(i/width));
          // A vertical column can close a lantern rim while sitting against an already
          // complete boot outline. Look specifically for fill on the equipment side.
          const openRim = !footFill && side.some(k=>pigment(rest,k)!==color);
          // Colours present on the adjacent drawing and absent from the other shoe
          // can reveal an attached patch, including one with a genuinely coloured fill.
          const matchingFill = !otherColors.has(color) && peerColors.get(color)>=2 &&
            side.some(k=>pigment(rest,k)===color);
          if (!openRim && !matchingFill) continue;
          if (!edges.has(peer)) edges.set(peer,new Map());
          edges.get(peer).set(i,{i,score:openRim ? 3 : 2,basis:openRim ? 'one-sided outline' : 'shared fill absent from the other foot'});
        }
      }
      if (index && contacts.size) {
        const [peer,border] = [...contacts].sort((a,b)=>b[1].size-a[1].size)[0];
        // A separate boot decoration can touch a sleeve. Require colour agreement with
        // the surrounding part or substantial contact along the detached shape.
        const samples = cells.filter(i=>rest.owners[i]===foot && !painted(base.get(peer),i,width));
        if (samples.length && (border.size>=2 || samples.some(i=>colors.get(peer).has(pigment(rest,i))))) {
          const peerColors=colors.get(peer);
          candidates.push({kind:'carried-island',foot,peer,cells:samples.map(i=>({i,
            score:peerColors.has(pigment(rest,i)) && !otherColors.has(pigment(rest,i)) ? 4 : 1,
            basis:'separate island on the foot drawing'}))});
          continue;
        }
      }
      for (const [peer,seam] of edges) {
        // One ambiguous corner can legitimately complete a toe. Only adjacent
        // supporting samples establish a run on the shared standing contour.
        const supported = [...seam.values()].filter(c=>neighbors(c.i,width,size).some(k=>seam.has(k)));
        if (supported.length) candidates.push({kind:'moving-edge',foot,peer,cells:supported});
      }
      // A complete little bracket or pendant can have a horizontal cut at its top
      // and no side seam. Compare the whole connected component's materials with
      // the other foot, and require an actual contact with the matching drawing.
      if (index || !otherColors.size) continue;
      for (const [peer,border] of contacts) {
        if (edges.has(peer) && candidates.some(c=>c.foot===foot && c.peer===peer)) continue;
        const peerColors = colors.get(peer), distinct = new Set();
        const face = cells.filter(i=>rest.owners[i]===foot);
        const material = face.filter(i=>{
          const color = pigment(rest,i);
          if (otherColors.has(color) || !peerColors.has(color) || painted(base.get(peer),i,width)) return false;
          distinct.add(color);
          return true;
        });
        if (material.length<2 || material.length*2<=face.length) continue;
        const box = face.reduce((b,i)=>{
          const x=i%width, y=Math.floor(i/width);
          return [Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)];
        },[width,size/width,0,0]);
        const w=box[2]-box[0]+1, h=box[3]-box[1]+1;
        const simple = Math.min(w,h)<=3 && face.length*4>=3*w*h;
        if (distinct.size<2 && !simple) continue;
        if (![...border].some(k=>distinct.has(pigment(rest,k)))) continue;
        candidates.push({kind:'moving-edge',foot,peer,cells:material.map(i=>({i,score:2,
          basis:'most foot pixels match the adjoining drawing in colours absent from the other foot'}))});
      }
    }
  }
  return {rest,feet,base,visible,drawings,candidates};
}

export function inspectWalkEdges(evidence, frame, width, toStep, record) {
  const {rest,feet,base,visible,drawings,candidates} = evidence, size = rest.owners.length;
  const point = i=>[i%width,Math.floor(i/width)];
  for (const {kind,foot,peer,cells} of candidates) {
    let best, count = 0;
    for (const cell of cells) {
      const at = toStep(cell.i,foot), expected = toStep(cell.i,peer);
      if (at < 0 || expected < 0 || at === expected || frame.owners[at]!==foot) continue;
      const clear = !neighbors(at,width,size).some(k=>frame.owners[k]===peer);
      // A slide along a long prop can expose the missing outline even while another
      // part of the prop still touches the boot.
      if (!clear && frame.owners[expected]) continue;
      const score = cell.score + (frame.owners[expected] ? 0 : 5) + (clear ? 2 : 0);
      if (!best || score>best.score || (score===best.score && cell.i<best.i))
        best = {...cell,at,expected,score};
      count++;
    }
    if (best) record(kind,frame,foot,peer,best.at,best.i,count,{basis:best.basis,
      symbol:base.get(foot).symbol,localPixel:localPixel(base.get(foot),best.i,width),peerPixel:point(best.expected)});
  }

  // Project both layers. When a boot goes in front, its projected pixel stays the
  // visible owner, so watching foot pixels alone would miss the entire crossing.
  const footAt = new Int32Array(size).fill(-1), crossings = new Map();
  for (const [foot,drawn] of drawings) for (const i of drawn) {
    const at = toStep(i,foot);
    if (at>=0 && frame.owners[at]===foot) footAt[at]=i;
  }
  for (const i of visible) {
    const behind = rest.owners[i], at = toStep(i,behind);
    if (at<0) continue;
    const front = frame.owners[at];
    if (!front || feet.has(front)===feet.has(behind) || toStep(i,front)===at) continue;
    const footInFront = feet.has(front), foot = footInFront ? front : behind, peer = footInFront ? behind : front;
    const standing = footInFront ? footAt[at] : i;
    if (standing<0 || !base.has(foot)) continue;
    const key = foot+','+peer, sameInk = pigment(rest,i)===pigment(frame,at);
    const crossing = crossings.get(key) ?? {count:0};
    crossing.count++;
    // A same-colour crossing particularly benefits from the renderer's owner evidence.
    if (!crossing.sample || (sameInk && !crossing.sample.sameInk)) crossing.sample={at,i,standing,foot,peer,footInFront,sameInk};
    crossings.set(key,crossing);
  }
  for (const {count,sample} of crossings.values()) {
    const {at,i,standing,foot,peer,footInFront,sameInk} = sample;
    record('foreground-crossing',frame,foot,peer,at,standing,count,{foreground:footInFront?'part':'otherPart',
      coveredStandingPixel:point(i),sameInk,symbol:base.get(foot).symbol,localPixel:localPixel(base.get(foot),standing,width)});
  }
}

