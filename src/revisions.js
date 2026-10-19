// Immutable recipe snapshots. Publish complete files atomically; never replace an existing revision.
import { readFile, open, mkdir, link, unlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { PixelError } from './core.js';

const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
const fail = message => { throw new PixelError('revision', message); };
const readText = async file => {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};

export function createRevisionStore(directory) {
  const root = path.resolve(directory), folder = path.join(root, '.revisions');
  async function remember(recipe) {
    const text = JSON.stringify(recipe), id = digest(text), file = path.join(folder, `${id}.json`);
    const existing = await readText(file);
    if (existing !== undefined) {
      if (existing !== text) fail(`stored revision ${id} differs from this recipe; refusing to overwrite it`);
      return id;
    }
    await mkdir(folder, { recursive: true });
    const temporary = path.join(folder, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx');
    try {
      try { await handle.writeFile(text); await handle.sync(); }
      finally { await handle.close(); }
      try { await link(temporary, file); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await readText(file) !== text) fail(`stored revision ${id} differs from this recipe; refusing to overwrite it`);
      }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return id;
  }
  async function read(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) fail('expected a 12-character revision id from a Pixelbolt response');
    const text = await readText(path.join(folder, `${id}.json`));
    if (text !== undefined) {
      if (digest(text) !== id) fail(`stored revision ${id} is damaged; send the original project again using a fresh output directory`);
      try { return JSON.parse(text); }
      catch { fail(`stored revision ${id} is not valid JSON`); }
    }
    // Older versions saved recipes only in render bundles. Recover their ids without rewriting the bundles.
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const bundle = path.join(root, entry.name);
      for (const file of await readdir(bundle, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.pixel.json')) continue;
        let recipe;
        try { recipe = JSON.parse(await readFile(path.join(bundle, file.name), 'utf8')); }
        catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') continue; throw error; }
        if (digest(JSON.stringify(recipe)) === id) { await remember(recipe); return recipe; }
      }
    }
    fail(`unknown revision ${id} in ${root}; use the same MCP --out directory or send the saved project`);
  }
  return { remember, read };
}
