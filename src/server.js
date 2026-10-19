import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createBundle, createZip } from './export.js';
import { renderProject, MAX_REQUEST_BYTES, PixelError } from './core.js';
import { createSequence } from './sequence.js';
import { prepareScene } from './scene.js';

const routes = new Map([
  ['/', ['../studio/index.html', 'text/html; charset=utf-8']],
  ['/studio.css', ['../studio/studio.css', 'text/css; charset=utf-8']],
  ['/studio.js', ['../studio/studio.js', 'text/javascript; charset=utf-8']],
  ['/core.js', ['./core.js', 'text/javascript; charset=utf-8']],
  ['/craft.js', ['./craft.js', 'text/javascript; charset=utf-8']],
  ['/font.js', ['./font.js', 'text/javascript; charset=utf-8']],
  ['/gif.js', ['./gif.js', 'text/javascript; charset=utf-8']],
  ['/draft.js', ['../studio/draft.js', 'text/javascript; charset=utf-8']],
  ['/authoring.js', ['./authoring.js', 'text/javascript; charset=utf-8']],
  ['/autotile.js', ['./autotile.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['./scene.js', 'text/javascript; charset=utf-8']],
  ['/scene-player.js', ['../studio/scene-player.js', 'text/javascript; charset=utf-8']],
  ['/scene.css', ['../studio/scene.css', 'text/css; charset=utf-8']],
  ['/scene.html', ['../studio/scene.html', 'text/html; charset=utf-8']],
  ['/fluid.html', ['../studio/fluid.html', 'text/html; charset=utf-8']],
  ['/fluid.css', ['../studio/fluid.css', 'text/css; charset=utf-8']],
  ['/fluid-lab.js', ['../studio/fluid-lab.js', 'text/javascript; charset=utf-8']],
  ['/fluid.js', ['./fluid.js', 'text/javascript; charset=utf-8']],
  ['/examples/quality/skink.json', ['../examples/quality/skink.json', 'application/json']],
  ['/schema.json', ['../schema.json', 'application/json']],
  ...['forest-spirit', 'ember', 'coin', 'shrine', 'caption', 'swing', 'effects'].map(name => [`/examples/${name}.json`, [`../examples/${name}.json`, 'application/json']]),
  // The fluid lab compiles these sources in the browser.
  ...['campfire', 'explosion', 'smoke-puff', 'steam-vent', 'magic-swirl', 'torch', 'splash', 'waterfall', 'drip', 'potion'].map(name => [`/examples/${name}.fluid.json`, [`../examples/${name}.fluid.json`, 'application/json']])
]);
// Every path the studio answers with GET, for checks that walk the whole allowlist.
export const STUDIO_PATHS = [...routes.keys(), '/scene.json', '/project.json'];
export const STUDIO_PORT = 4747;
// The most the studio sends back as one ZIP of frames; longer or larger clips belong on the command line.
const SEQUENCE_ZIP_BYTES = 512 * 1048576;
// The program and arguments that hand an address to the system's default browser, without a shell to quote for.
export function browserCommand(url, platform = process.platform, env = process.env) {
  if (platform === 'win32') return [path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]];
  return [platform === 'darwin' ? 'open' : 'xdg-open', [url]];
}
// Resolves to false when no opener could be started; the caller then asks the user to open the address.
export function openBrowser(url) {
  return new Promise(resolve => {
    const [command, args] = browserCommand(url), child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false)); child.once('spawn', () => { child.unref(); resolve(true); });
  });
}
// `fallback` takes any free port when `port` is in use, so a second studio still starts. The studio's unsaved-draft
// recovery lives in browser storage, which browsers keep per address: a draft is only found again on the same port.
export async function startStudio({ port = STUDIO_PORT, fallback = false, project, quiet = false } = {}) {
  const scene = project?.format === 'pixelforge-scene';
  if (project) { if (scene) prepareScene(project); else renderProject(project); }
  const server = http.createServer(async (req, res) => {
    const address = server.address(), hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    const reply = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" }); res.end(body); };
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`))) { reply(403, 'text/plain', 'Only same-origin local requests are accepted.'); return; }
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'POST' && (url.pathname === '/api/export' || url.pathname === '/api/sequence')) {
        if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, 'text/plain', 'Send application/json'); return; }
        let size = 0; const chunks = [];
        for await (const data of req) {
          size += data.length;
          if (size > MAX_REQUEST_BYTES) { reply(413, 'text/plain', `Project exceeds ${MAX_REQUEST_BYTES} bytes`); return; }
          chunks.push(data);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname === '/api/export') {
          const bundle = await createBundle(body);
          res.setHeader('Content-Disposition', `attachment; filename="${bundle.project.name}.zip"`);
          reply(200, 'application/zip', createZip(bundle.files)); return;
        }
        // Frames for a video editor, built exactly as `pixelbolt sequence` builds them, sent back as one ZIP.
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'project' && key !== 'sequence')) throw new PixelError('request', 'expected { "project": recipe, "sequence": options }');
        const { info, files } = createSequence(renderProject(body.project), body.sequence ?? {}), total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
        if (total > SEQUENCE_ZIP_BYTES) { reply(413, 'application/json', JSON.stringify({ error: `These frames come to ${Math.ceil(total / 1048576)} MB, more than the studio sends at once (${SEQUENCE_ZIP_BYTES / 1048576} MB). Use pixelbolt sequence, which writes them to a folder.` })); return; }
        res.setHeader('Content-Disposition', `attachment; filename="${info.name}-frames.zip"`);
        res.setHeader('X-PixelForge-Sequence', JSON.stringify({ frames: info.frames, width: info.width, height: info.height, fps: info.fps.label, notes: info.notes.length }));
        reply(200, 'application/zip', createZip(new Map([...files].map(([name, bytes]) => [`${info.name}/${name}`, bytes])))); return;
      }
      if (req.method !== 'GET') { reply(405, 'text/plain', 'Method not allowed'); return; }
      if (scene && url.pathname === '/') { reply(200, 'text/html; charset=utf-8', await readFile(new URL('../studio/scene.html', import.meta.url))); return; }
      if (scene && url.pathname === '/scene.json') { reply(200, 'application/json', JSON.stringify(project)); return; }
      if (url.pathname === '/scene.json') { reply(200, 'application/json', await readFile(new URL('../examples/quality/hollow.scene.json', import.meta.url))); return; }
      if (url.pathname === '/project.json') { reply(200, 'application/json', JSON.stringify(project ?? null)); return; }
      if (!routes.has(url.pathname)) { reply(404, 'text/plain', 'Not found'); return; }
      const [file, type] = routes.get(url.pathname);
      reply(200, type, await readFile(new URL(file, import.meta.url)));
    } catch (error) { reply(400, 'application/json', JSON.stringify({ error: error.message })); }
  });
  const listen = number => new Promise((resolve, reject) => { server.once('error', reject); server.listen(number, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  await listen(port).catch(error => { if (!fallback || error.code !== 'EADDRINUSE') throw error; return listen(0); });
  // One write, so anything reading the output sees the whole message at once.
  if (!quiet) console.log(`Pixelbolt studio: http://127.0.0.1:${server.address().port}\n${port && server.address().port !== port ? `Port ${port} is in use, so this studio has another address. A draft kept at the usual address is not shown here.\n` : ''}Press Ctrl+C to stop.`);
  return server;
}
