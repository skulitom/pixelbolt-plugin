#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderProject, animationGIF, createSequence, frameGrid, createSceneSequence, prepareScene, createBundle, writeBundle, inspectProject, compareProjects, patchRecipe, encodePNG, compilePoses, compileAutotile, compileEffects, compileFluid, compileNormals, formatJSON, createSceneBundle, createOverlay, applyOverlay, importPNG, resolveReferences, restorePaletteReference } from '../src/index.js';

const HELP = `Pixelbolt — text to pixels, without dependencies

  pixelbolt init [file.json]               Create an editable example
  pixelbolt validate <file.json|-> [--fps 30]
                                           Validate and describe a project; --fps lists durations off that video frame grid
  pixelbolt inspect <file.json|-> [--out sheet.png] [--grid]
                                           See every frame; writes only --out
  pixelbolt patch <file.json|-> --changes <changes.json|-> [--out new.json] [--image diff.png]
                                           Preview edits; writes only --out and --image
  pixelbolt render <file.json|-> --out dir Export a complete asset bundle
  pixelbolt gif <file.json|-> --out anim.gif [--animation name] [--scale 1-16] [--background color]
                                           Share one animation as a GIF; writes only --out
  pixelbolt gif-frames <folder> --fps 25 --out loop.gif [--loops 0] [--background color] [--prefix name_]
                                           A GIF from numbered PNG frames (name_0001.png ...); writes only --out
  pixelbolt sequence <recipe|source|scene.json> --out folder --fps 30 [--size 1080p|WxH] [--scale n]
                    [--fit contain|cover] [--align center] [--offset x,y] [--background color] [--animation name]
                    [--loops n | --seconds s] [--step n]
                                           Numbered PNG frames for a video editor, at a constant frame rate
  pixelbolt compile <source.json> --out recipe.json [--metadata meta.json]
                                           Build a recipe from authored poses, an autotile template, particle effects,
                                           a fluid source (simulated smoke, fire, explosions, magic and water) or a
                                           normals source (a lighting normal pass derived from a colour recipe)
  pixelbolt autotile <template.json> --out recipe.json [--metadata masks.json]
                                           Build a 47-tile blob or 16-tile cardinal set
  pixelbolt scene <scene.json> --out dir   Export a bounded scene review and aligned material passes
  pixelbolt overlay <recipe.json> --changes edits.json --out fixes.json [--selections regions.json]
  pixelbolt import <image.png> --out recipe.json [--atlas atlas.json] [--name imported]
  pixelbolt preview [file.json] [--port N] [--open]
                                           Studio for a recipe or scene; sources open as their compiled recipe.
                                           Port 4747, or a free one when it is in use; --open starts your browser
  pixelbolt mcp [--out directory] [--root directory]  Run the MCP server over stdio
  pixelbolt schema                         Print the JSON Schema

Options: --force allows overwriting exported files. '-' reads JSON from stdin.
Palette references ({"$ref": "palette.json"}), scene asset files and a normals source's recipe resolve from the
input file's folder.
Inspect: --frames a,b or --animation name picks cells (* and ? in a name match frames: --frames 'flash-*');
--step n [--offset k] keeps every nth cell from position k (0 is the first); --region x,y,w,h crops;
--grid adds palette-key rows; --scale 1-16 and --background color style the sheet.
--view color|silhouette|grayscale|onion|tile; --native adds a 1x PNG; --diagnostics adds advisory evidence.
--max-cells 1-256 samples long sequences with explicit omission metadata; evenly spaced samples can alias with a
repeating pattern (a strobe alternating A and B), so pick positions with --step and --offset.
Patch accepts correction overlays as --changes; a changed base fails with a fingerprint conflict.
A cleanup change ({"cleanup": "frames[run-2]", "value": {"corners": true, "strays": true}}) previews
proposed fixes for doubled corners and stray pixels; --diagnostics counts both per frame.
GIF keeps exact colours (at most 256 per frame, never quantized), 1-bit transparency unless --background blends
onto a colour, and 10 ms timing steps; the result's notes list what changed. Default scale: up to 256 pixels.
gif-frames reads the folder's numbered PNGs in number order, one GIF frame each, by the same rules; frames whose
colours differ get colour tables of their own. --loops is the number of plays (0, the default, loops for ever).
Sequence writes one PNG per video frame with alpha, plus sequence.json and a README with the ffmpeg command for a
.mov. --size is 720p, 1080p, 1440p, 4k, vertical, square or WIDTHxHEIGHT; the sprite is enlarged by a whole number
(the largest that fits, or --scale; --fit cover takes the smallest that covers the canvas and crops the rest) and
placed by --align (top-left ... bottom-right) and --offset. A scene's margins take its background colour. --step 2
animates on twos. Rates such as 23.976 and 29.97 are exact (24000/1001, 30000/1001).
Command results except help and the preview server are JSON. Errors exit with code 1.
Checkout: node bin/pixelbolt.js <command>. Portable build folder: .\\pixelbolt (Windows) or ./pixelbolt (macOS/Linux).
`;

function parseArgs(args) {
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    if (['--force', '--grid', '--native', '--diagnostics', '--open'].includes(args[i])) options[args[i].slice(2)] = true;
    else if (['--out', '--port', '--frames', '--animation', '--region', '--scale', '--background', '--changes', '--image', '--view', '--max-cells', '--metadata', '--selections', '--atlas', '--name', '--layers', '--reference', '--root', '--fps', '--size', '--align', '--offset', '--loops', '--seconds', '--step', '--fit', '--prefix'].includes(args[i])) {
      const key = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`--${key} requires a value`);
      options[key] = args[++i];
    } else if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
    else positional.push(args[i]);
  }
  return { positional, options };
}
async function readProject(file) {
  if (!file) throw new Error('Provide a project JSON filename or - for stdin');
  let source;
  if (file === '-') { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); source = Buffer.concat(chunks).toString('utf8'); }
  else source = await readFile(file, 'utf8');
  return JSON.parse(source.replace(/^﻿/, ''));
}
// Reads a document and inlines its references relative to its own folder (stdin: the working directory).
async function readResolved(file) {
  const original = await readProject(file), baseDir = file === '-' ? process.cwd() : path.dirname(path.resolve(file));
  const resolution = await resolveReferences(original, { baseDir });
  return { original, document: resolution.document, resolution, baseDir };
}
// Compiled output keeps a shared-palette link, rewritten relative to where the output is written.
function linkPalette(recipe, input, outFile) {
  const link = input.resolution.palettes.find(entry => ['poses', 'autotile', 'fx', 'fluid', 'project'].includes(entry.where));
  if (!link) return recipe;
  const shared = path.resolve(input.baseDir, link.reference), reference = path.relative(path.dirname(path.resolve(outFile)), shared).split(path.sep).join('/');
  return restorePaletteReference({ palette: { $ref: reference } }, recipe, { palettes: [{ ...link, where: 'project' }] });
}
function inspectOptions({ frames, animation, region, grid, scale, background, view, native, diagnostics, 'max-cells': maxCells, step, offset }) {
  for (const [key, value] of [['step', step], ['offset', offset]]) if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`--${key} expects a whole number`);
  if (region !== undefined && !/^\d+,\d+,\d+,\d+$/.test(region)) throw new Error('--region expects four whole numbers: x,y,w,h');
  const [x, y, w, h] = region?.split(',').map(Number) ?? [];
  return { ...(frames !== undefined && { frames: frames.split(',') }), ...(animation !== undefined && { animation }), ...(region !== undefined && { region: { x, y, w, h } }), ...(grid && { grid }), ...(scale !== undefined && { scale: Number(scale) }), ...(background !== undefined && { background }), ...(view !== undefined && { view }), ...(native && { native }), ...(diagnostics && { diagnostics }), ...(maxCells !== undefined && { maxCells: Number(maxCells) }), ...(step !== undefined && { step: Number(step) }), ...(offset !== undefined && { offset: Number(offset) }) };
}
// Checks every target before writing any, so a refused overwrite leaves nothing half-written.
async function writeOutputs(targets, force) {
  const entries = Object.entries(targets).map(([label, [file, data]]) => [label, path.resolve(file), data]);
  const unique = new Set(entries.map(([, target]) => process.platform === 'win32' ? target.toLowerCase() : target));
  if (unique.size !== entries.length) throw new Error('Output paths must be distinct; no files were written.');
  if (!force) for (const [, target] of entries) {
    try { await access(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Output already exists: ${target}. Choose a new file or pass --force.`);
  }
  for (const [, target, data] of entries) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: force ? 'w' : 'wx' });
  }
  return Object.fromEntries(entries.map(([label, target]) => [label, target]));
}
// Sidecar sources compile by their format; `autotile` remains a dedicated command for templates.
const COMPILERS = { 'pixelforge-poses': compilePoses, 'pixelforge-autotile': compileAutotile, 'pixelforge-fx': compileEffects, 'pixelforge-fluid': compileFluid, 'pixelforge-normals': compileNormals };
const summary = project => ({ name: project.name, width: project.width, height: project.height, frames: project.frames.length, animations: Object.keys(project.animations), warnings: project.warnings, ...(project.clipping && { clipping: project.clipping }) });
const referenced = input => input.resolution.files.length ? { resolved: input.resolution.files } : {};
try {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) process.stdout.write(HELP);
  else {
    const { positional, options } = parseArgs(rest);
    if (positional.length > 1) throw new Error('Too many positional arguments');
    const allowed = { init: ['force'], validate: ['fps'], inspect: ['frames', 'animation', 'region', 'grid', 'scale', 'background', 'out', 'force', 'view', 'native', 'diagnostics', 'max-cells', 'step', 'offset', 'layers', 'reference'], patch: ['changes', 'out', 'image', 'force'], render: ['out', 'force'], gif: ['out', 'animation', 'scale', 'background', 'force'], 'gif-frames': ['out', 'fps', 'loops', 'background', 'prefix', 'force'], sequence: ['out', 'fps', 'animation', 'size', 'scale', 'fit', 'align', 'offset', 'background', 'loops', 'seconds', 'step', 'force'], preview: ['port', 'open'], mcp: ['out', 'root'], schema: [], compile: ['out', 'metadata', 'force'], autotile: ['out', 'metadata', 'force'], scene: ['out', 'force'], overlay: ['changes', 'selections', 'out', 'force'], import: ['out', 'name', 'atlas', 'metadata', 'force'] };
    if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}. Run pixelbolt help.`);
    for (const key of Object.keys(options)) if (!allowed[command].includes(key)) throw new Error(`--${key} is not supported by ${command}`);
    if (['schema', 'mcp'].includes(command) && positional.length) throw new Error(`${command} does not accept a filename`);
    if (command === 'init') {
      const file = positional[0] ?? 'sprite.pixel.json';
      try {
        await writeFile(file, await readFile(new URL('../examples/forest-spirit.json', import.meta.url)), { flag: options.force ? 'w' : 'wx' });
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Output already exists: ${path.resolve(file)}. Choose a new file or pass --force.`);
        throw error;
      }
      console.log(JSON.stringify({ ok: true, file }));
    } else if (command === 'schema') process.stdout.write(await readFile(new URL('../schema.json', import.meta.url), 'utf8'));
    else if (command === 'mcp') {
      const { startMCP } = await import('../src/mcp.js'); await startMCP({ directory: options.out, ...(options.root !== undefined && { root: path.resolve(options.root) }) });
    } else if (command === 'preview') {
      const { startStudio, openBrowser, STUDIO_PORT } = await import('../src/server.js');
      const port = options.port === undefined ? STUDIO_PORT : Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
      let project = positional[0] ? (await readResolved(positional[0])).document : undefined;
      // Pose, autotile, effect, fluid and normals sources open as the recipe they compile to.
      if (project && Object.hasOwn(COMPILERS, project.format ?? '')) project = COMPILERS[project.format](project).recipe;
      // A port you name is used or refused; the usual one gives way to any free port when something else has it.
      const server = await startStudio({ port, project, fallback: options.port === undefined });
      if (options.open && !await openBrowser(`http://127.0.0.1:${server.address().port}/`)) console.log('No browser was opened. Copy the address above into your browser.');
    } else if (['compile', 'autotile', 'overlay', 'import'].includes(command)) {
      if (!options.out || !/\.json$/i.test(options.out)) throw new Error(`${command} requires --out <new.json>`);
      let value, metadata, input;
      if (command === 'compile' || command === 'autotile') {
        input = await readResolved(positional[0]);
        const compile = command === 'autotile' ? compileAutotile : COMPILERS[input.document?.format] ?? compilePoses;
        const compiled = compile(input.document);
        value = linkPalette(compiled.recipe, input, options.out); metadata = compiled.metadata;
      } else if (command === 'overlay') {
        if (!options.changes) throw new Error('overlay requires --changes <edits.json>');
        if (positional[0] === '-' && options.changes === '-') throw new Error('Only one input can use stdin');
        input = await readResolved(positional[0]);
        value = createOverlay(input.document, await readProject(options.changes), options.selections ? await readProject(options.selections) : {});
      } else {
        if (!positional[0] || positional[0] === '-') throw new Error('import requires a PNG filename');
        const imported = importPNG(await readFile(positional[0]), { name: options.name, atlas: options.atlas ? await readProject(options.atlas) : undefined });
        value = imported.recipe; metadata = imported.provenance;
      }
      if (options.metadata && !/\.json$/i.test(options.metadata)) throw new Error('--metadata must name a .json file');
      // Generated files use compact formatting: one line per frame, operation or short grid when it fits.
      const written = await writeOutputs({ recipe: [options.out, formatJSON(value)], ...(options.metadata && { metadata: [options.metadata, formatJSON(metadata)] }) }, options.force);
      console.log(JSON.stringify({ ok: true, ...written, ...(metadata && !options.metadata && { metadata }), ...(input && referenced(input)) }, null, 2));
    } else if (command === 'scene') {
      if (!options.out) throw new Error('scene requires --out <directory>');
      const input = await readResolved(positional[0]), bundle = await createSceneBundle(input.document);
      console.log(JSON.stringify({ ok: true, files: await writeBundle(bundle, options.out, options), warnings: bundle.warnings, ...referenced(input) }));
    } else if (command === 'inspect') {
      const layerOptions = options.layers === undefined ? {} : { layers: options.layers.split(',') };
      if (positional[0] === '-' && options.reference === '-') throw new Error('Only one inspection input can use stdin');
      const input = await readResolved(positional[0]), project = renderProject(input.document, layerOptions);
      const comparison = options.reference ? compareProjects(renderProject((await readResolved(options.reference)).document, layerOptions), project) : undefined;
      const { image: referenceImage, ...comparisonReport } = comparison ?? {};
      const view = inspectProject(project, inspectOptions(options)), { data, ...sheet } = view.sheet;
      if (options.out && !/\.png$/i.test(options.out)) throw new Error('inspect --out must name a .png file');
      const written = await writeOutputs(options.out ? { image: [options.out, encodePNG(data, sheet.width, sheet.height)], ...(view.nativeSheet && { nativeImage: [options.out.replace(/\.png$/i, '.native.png'), encodePNG(view.nativeSheet.data, view.nativeSheet.width, view.nativeSheet.height)] }), ...(referenceImage && { referenceImage: [options.out.replace(/\.png$/i, '.reference.png'), encodePNG(referenceImage.sheet.data, referenceImage.sheet.width, referenceImage.sheet.height)] }) } : {}, options.force);
      // Pretty-printed so grid rows line up for reading.
      console.log(JSON.stringify({ ok: true, ...summary(project), ...view, sheet, nativeSheet: view.nativeSheet ? { ...view.nativeSheet, data: undefined } : undefined, ...(comparison && { comparison: comparisonReport }), ...written, ...referenced(input) }, null, 2));
    } else if (command === 'patch') {
      if (!options.changes) throw new Error('patch requires --changes <file.json|->');
      if (positional[0] === '-' && options.changes === '-') throw new Error('Only one of the project and --changes can be read from stdin');
      if (options.out && !/\.json$/i.test(options.out)) throw new Error('patch --out must name a .json file');
      if (options.image && !/\.png$/i.test(options.image)) throw new Error('patch --image must name a .png file');
      const input = await readResolved(positional[0]), base = input.document, changes = await readProject(options.changes);
      const applied = changes?.format === 'pixelforge-overlay' ? applyOverlay(base, changes) : patchRecipe(base, Array.isArray(changes) ? changes : changes?.changes);
      const { recipe, edits } = applied;
      const after = renderProject(recipe), { image, ...report } = compareProjects(renderProject(base), after);
      // A recipe that referenced a shared palette keeps that reference; only new or changed entries stay local.
      const saved = restorePaletteReference(input.original, recipe, input.resolution);
      const written = await writeOutputs({
        ...(options.out && { recipe: [options.out, Buffer.from(JSON.stringify(saved, null, 2) + '\n')] }),
        ...(options.image && image && { image: [options.image, encodePNG(image.sheet.data, image.sheet.width, image.sheet.height)] })
      }, options.force);
      const { sheet, ...drawn } = image ?? {};
      console.log(JSON.stringify({ ok: true, name: after.name, edits, ...(applied.rebased && { rebased: true }), ...report, ...(written.image && { image: { ...drawn, scale: sheet.scale, file: written.image } }), ...(written.recipe && { recipe: written.recipe }), warnings: after.warnings, ...(after.clipping && { clipping: after.clipping }) }, null, 2));
    } else if (command === 'sequence') {
      if (!options.out) throw new Error('sequence requires --out <new folder>');
      if (options.fps === undefined) throw new Error('sequence requires --fps, for example 24, 25, 29.97, 30 or 60');
      const input = await readResolved(positional[0]);
      // Pose, autotile, effect and fluid sources become the recipe they compile to; a scene is rendered moment by moment.
      const document = Object.hasOwn(COMPILERS, input.document?.format ?? '') ? COMPILERS[input.document.format](input.document).recipe : input.document;
      const numeric = key => options[key] === undefined ? {} : { [key]: Number(options[key]) }, text = key => options[key] === undefined ? {} : { [key]: options[key] };
      const settings = { ...text('fps'), ...text('animation'), ...text('size'), ...numeric('scale'), ...text('fit'), ...text('align'), ...(options.offset !== undefined && { offset: options.offset.split(',').map(Number) }), ...text('background'), ...numeric('loops'), ...numeric('seconds'), ...numeric('step') };
      const sequence = document?.format === 'pixelforge-scene' ? createSceneSequence(prepareScene(document), document.name, settings) : createSequence(renderProject(document), settings);
      const files = await writeBundle(sequence, options.out, options), { timing, ...info } = sequence.info;
      console.log(JSON.stringify({ ok: true, ...info, directory: path.resolve(options.out), files: files.length, ...referenced(input) }, null, 2));
    } else if (command === 'gif') {
      if (!options.out || !/\.gif$/i.test(options.out)) throw new Error('gif requires --out <new.gif>');
      const input = await readResolved(positional[0]), project = renderProject(input.document);
      const { data, ...gif } = animationGIF(project, options.animation, { ...(options.scale !== undefined && { scale: Number(options.scale) }), ...(options.background !== undefined && { background: options.background }) });
      const written = await writeOutputs({ file: [options.out, data] }, options.force);
      console.log(JSON.stringify({ ok: true, name: project.name, ...gif, ...written, warnings: project.warnings, ...referenced(input) }, null, 2));
    } else if (command === 'gif-frames') {
      if (!positional[0] || positional[0] === '-') throw new Error('gif-frames requires a folder of numbered PNG frames');
      if (!options.out || !/\.gif$/i.test(options.out)) throw new Error('gif-frames requires --out <new.gif>');
      if (options.fps === undefined) throw new Error('gif-frames requires --fps, for example 12, 24, 25 or 30');
      const { folderGIF } = await import('../src/frame-folder.js');
      const { data, ...gif } = folderGIF(positional[0], { fps: options.fps, ...(options.loops !== undefined && { loops: Number(options.loops) }), ...(options.background !== undefined && { background: options.background }), ...(options.prefix !== undefined && { prefix: options.prefix }) });
      const written = await writeOutputs({ file: [options.out, data] }, options.force);
      console.log(JSON.stringify({ ok: true, ...gif, bytes: data.length, ...written }, null, 2));
    } else {
      const input = await readResolved(positional[0]);
      if (command === 'validate') { const project = renderProject(input.document); console.log(JSON.stringify({ ok: true, ...summary(project), ...(options.fps !== undefined && { frameGrid: frameGrid(project, options.fps) }), ...referenced(input) })); }
      else {
        if (!options.out) throw new Error('render requires --out <directory>');
        const bundle = await createBundle(input.document), files = await writeBundle(bundle, options.out, options);
        console.log(JSON.stringify({ ok: true, ...summary(bundle.project), files, ...referenced(input) }));
      }
    }
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, ...(error.path ? { path: error.path } : {}) })); process.exitCode = 1;
}
