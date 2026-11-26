// Edit stack faces and shared decal grids. A pointer gesture commits once. A refresh of the
// same document preserves its active pointer, undo history and model-space review pin.
// Camera-locked socket inspection only draws into the review dialog.
import { prepareStack } from '/stack.js';
import { parseColor, renderProject } from '/core.js';
import { traceLine } from '/craft.js';
import { $, toast } from '/page.js';

export function stackEditor(seek, rest) {
  const panel = $('stack-tools'), canvas = $('stack-side'), editor = $('source');
  const face = $('stack-face'), ink = $('stack-ink'), depth = $('stack-depth'), slider = $('stack-heading');
  const tool = $('stack-tool'), target = $('stack-target'), decal = $('stack-decal');
  const undo = [], redo = [];
  let written, sourceText, prepared, colours, palette, rows, stroke, pin, comparisonKey, heading = 0;
  let cursor = [0, 0];
  const definition = () => ['brush', 'erase'].includes(tool.value) ? target.value : '';
  const blank = key => key === '.' || key === ' ';

  function drawRows(surface, grid) {
    surface.width = grid[0].length; surface.height = grid.length;
    const ctx = surface.getContext('2d'), image = ctx.createImageData(surface.width, surface.height);
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!blank(row[x])) image.data.set(colours[row[x]], (y * surface.width + x) * 4);
      }
    });
    ctx.putImageData(image, 0, 0);
  }
  function selectOptions(select, options) {
    const old = select.value;
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    if (options.some(([value]) => value === old)) select.value = old;
  }
  function controls() {
    const names = Object.keys(written.decals ?? {}).map(name => [name, name]);
    selectOptions(target, [['', 'Face'], ...names]); selectOptions(decal, names);
    tool.querySelector('[value="stamp"]').disabled = !names.length;
    if (!names.length && tool.value === 'stamp') tool.value = 'brush';
    const stamping = tool.value === 'stamp', painting = tool.value === 'brush';
    $('stack-stamp-tools').hidden = !stamping;
    $('stack-target-label').hidden = !names.length || !(painting || tool.value === 'erase');
    $('stack-ink-label').hidden = !painting;
    $('stack-depth-label').hidden = !!definition() || !(stamping || painting);
    face.disabled = !!definition();
    $('stack-undo').disabled = !undo.length; $('stack-redo').disabled = !redo.length;
    const last = written.paint?.at(-1);
    $('stack-make-decal').disabled = !last?.rows || last.face !== face.value || !!definition();
  }
  function draw() {
    rows = definition() ? written.decals[definition()] : prepared.side(face.value);
    drawRows(canvas, rows);
    $('stack-drawing').style.setProperty('--stack-width', `${240 * canvas.width / canvas.height}px`);
    cursor = cursor.map((v, i) => Math.min(v, (i ? canvas.height : canvas.width) - 1));
    $('stack-cell').textContent = cursor.join(', ');
    comparison();
  }
  function comparison() {
    const marker = $('stack-pin-marker');
    marker.hidden = !pin || pin.face !== face.value || !!definition();
    if (!marker.hidden) {
      marker.style.left = `${100 * (pin.at[0] + .5) / canvas.width}%`;
      marker.style.top = `${100 * (pin.at[1] + .5) / canvas.height}%`;
    }
    $('stack-comparison').hidden = !pin;
    if (!pin || comparisonKey === heading) return;
    const review = prepared.comparison(pin.face, pin.at, heading);
    if (!review) { pin = null; marker.hidden = true; $('stack-comparison').hidden = true; return; }
    const items = renderProject(review).frames.map(frame => {
      const figure = document.createElement('figure'), tile = document.createElement('canvas'), caption = document.createElement('figcaption');
      tile.width = review.width; tile.height = review.height;
      tile.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data),tile.width,tile.height),0,0);
      caption.textContent = `${frame.name.slice('heading-'.length)}°`;
      figure.append(tile, caption); return figure;
    });
    $('stack-pin-label').textContent = `${pin.face} (${pin.at.join(', ')})`;
    $('stack-detail-strip').replaceChildren(...items);
    comparisonKey = heading;
  }

  // Keep patches to the paint fields. Arrays and drawings are replaced immutably, so the
  // undo stack shares unmodified rows and never copies the volume or resolved palette.
  function snapshot(value) { return { paint: value.paint, decals: value.decals }; }
  function apply(change, history) {
    if (!written || editor.value !== sourceText) return false;
    const next = { ...written, ...change };
    for (const key of ['paint', 'decals']) if (next[key] === undefined) delete next[key];
    let model;
    try { model = prepareStack({ ...next, palette }); }
    catch (error) { toast(error.message); return false; }
    if (history) { undo.push(snapshot(written)); if (undo.length > 100) undo.shift(); redo.length = 0; }
    written = next; prepared = model; sourceText = editor.value = JSON.stringify(next, null, 2);
    comparisonKey = null; controls(); draw();
    editor.dispatchEvent(new CustomEvent('input', { detail: { stack: model } }));
    return true;
  }
  function travel(from, to) {
    if (stroke || !from.length || editor.value !== sourceText) return;
    const previous = snapshot(written), change = from.at(-1);
    if (apply(change, false)) { from.pop(); to.push(previous); controls(); }
  }
  $('stack-undo').onclick = () => travel(undo, redo);
  $('stack-redo').onclick = () => travel(redo, undo);
  panel.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.target.tagName === 'INPUT') return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    if (key === 'y' || event.shiftKey) travel(redo, undo); else travel(undo, redo);
  });
  $('stack-make-decal').onclick = () => {
    if (!written || editor.value !== sourceText) return;
    const last = written.paint?.at(-1);
    if (!last?.rows) return;
    const name = window.prompt('Name for this decal');
    if (!name) return;
    if (Object.hasOwn(written.decals ?? {}, name)) { toast('That decal name is already in use.'); return; }
    const { rows: drawing, ...place } = last;
    if (apply({ decals: { ...written.decals, [name]: drawing }, paint: [...written.paint.slice(0,-1), { ...place, decal: name }] }, true)) {
      target.value = name; tool.value = 'brush'; controls(); draw();
    }
  };

  function mark(x, y) {
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return;
    if (!stroke.definition && blank(rows[y][x])) return;
    const ctx = canvas.getContext('2d');
    stroke.points.add(y * canvas.width + x);
    if (stroke.erase) ctx.clearRect(x, y, 1, 1);
    else { ctx.fillStyle = palette[stroke.ink]; ctx.fillRect(x, y, 1, 1); }
  }
  function start(point, pointer) {
    if (!written || editor.value !== sourceText || stroke) return;
    cursor = point;
    $('stack-cell').textContent = cursor.join(', ');
    if (tool.value === 'pin') {
      if (blank(rows[point[1]][point[0]])) { toast('Pick a solid cell to follow.'); return; }
      pin = { face: face.value, at: point }; comparisonKey = null;
      seek(Number(slider.value)); comparison(); return;
    }
    if (!definition() && ['stamp','brush'].includes(tool.value) && !depth.reportValidity()) return;
    seek(Number(slider.value));
    if (tool.value === 'stamp') {
      const stamp = { face: face.value, at: point, decal: decal.value, depth: Number(depth.value) };
      if ($('stack-flip-x').checked) stamp.flipX = true;
      if ($('stack-flip-y').checked) stamp.flipY = true;
      apply({ paint: [...(written.paint ?? []), stamp] }, true);
      return;
    }
    stroke = { pointer, points: new Set(), definition: definition(), erase: tool.value === 'erase', face: face.value, ink: ink.value, depth: Number(depth.value) };
    if (pointer !== undefined) canvas.setPointerCapture(pointer);
    mark(...point);
  }
  function finish() {
    const edit = stroke; stroke = null;
    if (!edit) return;
    if (edit.points.size && written && editor.value === sourceText) {
      const points = [...edit.points].map(i => [i % canvas.width, Math.floor(i / canvas.width)]);
      if (edit.definition) {
        const grid = written.decals[edit.definition].map(row => [...row]);
        for (const [x, y] of points) grid[y][x] = edit.erase ? '.' : edit.ink;
        apply({ decals: { ...written.decals, [edit.definition]: grid.map(row => row.join('')) } }, true);
      } else {
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        const grid = Array.from({ length: Math.max(...ys) - y + 1 }, () => Array(Math.max(...xs) - x + 1).fill('.'));
        for (const [px, py] of points) grid[py-y][px-x] = edit.erase ? 'x' : edit.ink;
        const mask = grid.map(row => row.join(''));
        const place = edit.erase ? { erase: mask } : { rows: mask, depth: edit.depth };
        apply({ paint: [...(written.paint ?? []), { face: edit.face, at: [x,y], ...place }] }, true);
      }
    }
    if (prepared) draw();
    rest();
  }
  function cell(event) {
    const box = canvas.getBoundingClientRect();
    return [Math.floor((event.clientX - box.left) * canvas.width / box.width),
      Math.floor((event.clientY - box.top) * canvas.height / box.height)]
      .map((v,i) => Math.max(0, Math.min(v, (i ? canvas.height : canvas.width) - 1)));
  }
  canvas.onpointerdown = event => { if (event.button === 0) start(cell(event), event.pointerId); };
  canvas.onpointermove = event => {
    if (!stroke || stroke.pointer !== event.pointerId) return;
    const next = cell(event); traceLine(...cursor, ...next, mark); cursor = next;
  };
  canvas.onpointerup = event => {
    if (stroke?.pointer !== event.pointerId) return;
    const last = cell(event); traceLine(...cursor, ...last, mark); cursor = last;
    finish();
  };
  canvas.onlostpointercapture = canvas.onpointercancel = event => {
    if (stroke?.pointer === event.pointerId) { stroke = null; if (prepared) draw(); rest(); }
  };
  canvas.onkeydown = event => {
    const delta = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] }[event.key];
    if (!prepared || stroke || (!delta && event.key !== ' ')) return;
    event.preventDefault();
    if (delta) cursor = cursor.map((v,i) => Math.max(0, Math.min(v+delta[i], (i ? canvas.height : canvas.width)-1)));
    else { start(cursor); finish(); }
    $('stack-cell').textContent = cursor.join(', ');
  };
  for (const select of [tool, face, target]) select.onchange = () => {
    finish(); cursor = [0,0]; controls(); draw();
  };
  $('stack-unpin').onclick = () => { pin = null; comparison(); };
  $('stack-socket').onchange = () => seek(Number(slider.value));
  slider.oninput = () => seek(Number(slider.value));

  const dialog = $('rotation-dialog'), stage = $('rotation-stage'), preview = $('rotation-canvas');
  const socket = $('rotation-socket'), offset = $('rotation-offset'), message = $('rotation-error');
  let study, lockedHeading, redraw;
  function fitRotation() {
    if (!dialog.open || preview.hidden) return;
    const fit = Math.min(stage.clientWidth / preview.width, stage.clientHeight / preview.height);
    const scale = fit < 1 ? fit : Math.floor(fit);
    preview.style.width = preview.width * scale + 'px';
    preview.style.height = preview.height * scale + 'px';
  }
  new ResizeObserver(fitRotation).observe(stage);
  function drawRotation() {
    cancelAnimationFrame(redraw);
    if (!dialog.open) return;
    try {
      study ??= prepared.rotationStudy(lockedHeading, socket.value);
      const project = renderProject(study.recipe(Number(offset.value)));
      preview.width = project.width; preview.height = project.height;
      preview.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(project.frames[0].data), project.width, project.height), 0, 0);
      message.hidden = true; preview.hidden = false;
      fitRotation();
    } catch (error) {
      message.textContent = error.message; message.hidden = false; preview.hidden = true;
    }
  }
  function selectRotation() {
    study = null; offset.value = '0'; $('rotation-degrees').value = '0°';
    drawRotation();
  }
  socket.onchange = selectRotation;
  offset.oninput = () => {
    $('rotation-degrees').value = offset.value + '°';
    cancelAnimationFrame(redraw);
    redraw = requestAnimationFrame(drawRotation);
  };
  $('stack-lock').onclick = () => {
    if (!prepared || editor.value !== sourceText) return;
    seek(Number(slider.value));
    lockedHeading = heading;
    $('rotation-heading').textContent = lockedHeading + '°';
    const names = prepared.rotationSockets, marked = $('stack-socket').value;
    selectOptions(socket, names.map(name => [name, name]));
    socket.value = names.includes(marked) ? marked : names.find(name => written.sockets[name].keys?.some(key => key.angle)) ?? names[0];
    dialog.showModal(); selectRotation(); offset.focus();
  };
  $('rotation-close').onclick = () => dialog.close();
  dialog.onclose = () => { cancelAnimationFrame(redraw); study = null; };

  function reset() {
    if (dialog.open) dialog.close();
    stroke = null; pin = null; comparisonKey = null; written = null; prepared = null;
    sourceText = null; undo.length = redo.length = 0; cursor = [0,0];
    target.value = ''; tool.value = 'brush'; $('stack-socket').value = ''; panel.hidden = true;
  }
  return {
    reset,
    get busy() { return !!stroke; },
    update(value, model, resolvedPalette) {
      if (!value) { reset(); return; }
      if (editor.value !== sourceText) {
        stroke = null; undo.length = redo.length = 0;
        sourceText = editor.value; written = value;
      }
      const sockets = Object.keys(value.sockets ?? {});
      if (dialog.open && model !== prepared) dialog.close();
      $('stack-lock').hidden = !model.rotationSockets.length;
      selectOptions($('stack-socket'), [['','Off'],...sockets.map(name=>[name,name])]);
      $('stack-socket-label').hidden = !sockets.length;
      const same = prepared === model;
      prepared = model; palette = resolvedPalette; panel.hidden = false;
      colours = Object.fromEntries(Object.entries(palette).map(([key, hex]) => [key,parseColor(hex)]));
      slider.max = String(model.metadata.headings.length-1);
      heading = model.metadata.headings.includes(heading) ? heading : model.metadata.headings[0];
      selectOptions(ink, Object.entries(palette).map(([key, hex]) => [key, `${key} · ${hex}`]));
      if (!same) comparisonKey = null;
      controls(); if (!stroke) draw();
    },
    heading(index, context) {
      if (!prepared) return;
      // `index` is a frame of the recipe: a heading, or a frame of an animation at one.
      heading = prepared.headingOf(index);
      const name=$('stack-socket').value;
      if (name && context) {
        const [x,y]=prepared.frame(index).points[name];
        context.fillStyle='#17202a'; context.fillRect(x-4,y-1,9,3); context.fillRect(x-1,y-4,3,9);
        context.fillStyle='#ffffff'; context.fillRect(x-3,y,7,1); context.fillRect(x,y-3,1,7);
      }
      slider.value = String(prepared.metadata.headings.indexOf(heading)); $('stack-angle').textContent = `${heading}°`; comparison();
    }
  };
}
