// Node-side install of the pixel art skill on its own: a folder an agent loads skills from (Claude Code's
// ~/.claude/skills, or a project's .claude/skills) gets SKILL.md with every command run through npx at this
// package's version, and the guides, schemas and examples it names copied beside it. No checkout, no MCP server.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL_SOURCE = 'skills/pixel-art/SKILL.md';
export const SKILL_NAME = 'pixelbolt-pixel-art';
export const SKILL_MANIFEST = '.pixelbolt-skill.json';
// The agent-facing guides the skill and the quick start cite; a test fails when the skill names one not listed here.
const DOCS = ['docs/agent-quick-start.md', 'docs/agent-guide.md', 'docs/art-workflow.md', 'docs/wave-effects.md', 'docs/game-integration.md'];
const REPOSITORY = 'https://github.com/skulitom/Pixelbolt';
const sha256 = data => createHash('sha256').update(data).digest('hex');

export const skillCommand = version => `npx -y pixelbolt@${version}`;

async function filesUnder(folder) {
  const found = [];
  for (const entry of await readdir(path.join(ROOT, folder), { withFileTypes: true })) {
    const file = `${folder}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await filesUnder(file)); else if (entry.isFile()) found.push(file);
  }
  return found;
}

// Relative Markdown links keep working when their target is copied; any other file in the repository becomes a link
// to it on GitHub at this version's tag.
function relink(text, from, to, copied, version) {
  return text.replace(/\]\(([^)\s]+)\)/g, (link, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return link;
    const [file, anchor = ''] = target.split(/(?=#)/);
    const source = path.posix.normalize(path.posix.join(path.posix.dirname(from), file));
    if (copied.has(source)) return `](${path.posix.relative(path.posix.dirname(to), copied.get(source)) || path.posix.basename(source)}${anchor})`;
    // A folder whose files are copied (examples/) stays a relative link; copied folders keep their place.
    const folder = source.replace(/\/$/, '');
    if ([...copied.values()].some(copy => copy.startsWith(`${folder}/`))) return `](${path.posix.relative(path.posix.dirname(to), folder) || '.'}/${anchor})`;
    return `](${REPOSITORY}/blob/v${version}/${source.replace(/^(?:\.\.\/)+/, '')}${anchor})`;
  });
}
// Checkout commands and bare `pixelbolt <command>` mentions both run through npx at this version; a contributor
// script (node scripts/...) is not in the copy, so it says where one is.
const runThrough = (text, command) => text.replace(/node bin\/pixel(?:bolt|forge)\.js/g, command).replace(/(`|^)pixelbolt (?=[a-z])/gm, `$1${command} `)
  .replace(/`node (scripts\/[^`]+)`(?! in a clone of)/g, `\`node $1\` in a clone of [Pixelbolt](${REPOSITORY})`);

// The skill as shipped assumes the package two directories above it. Its standalone copy says where things are.
function standaloneSkill(text, version) {
  const command = skillCommand(version);
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) + 4 : 0;
  const head = text.slice(0, end), paragraphs = text.slice(end).split(/\n{2,}/);
  const intro = `This copy of the skill was installed on its own by \`pixelbolt skill install\` from Pixelbolt ${version}, with no checkout and no MCP server. Run every command as written below, through \`${command}\` (Node.js 20 or newer; npm downloads the package on first use), or through \`pixelbolt\` when Pixelbolt ${version} is installed globally. The guides, schemas and examples it names are copied beside this file, so \`docs/\`, \`schema.json\`, the \`*.schema.json\` files and \`examples/\` mean this skill's directory (\`${command} schema\` also prints the recipe schema). Commands run in the user's project, where those paths don't exist: copy an example into the project before editing or compiling it, together with the files it names (a scene's assets, a normals source's recipe, a shared palette), or pass its absolute path. Where the text below names an MCP tool, the command line does the same: \`pixel_validate\` is \`validate\`, \`pixel_inspect\` is \`inspect\`, \`pixel_patch\` is \`patch\`, \`pixel_render\` is \`render\` (for GIFs, \`gif\`, whose \`--scale\` is \`gif.scale\`), \`pixel_compile\` is \`compile <source> --out <recipe.json>\` (\`compile --preset <name> --out <recipe.json>\` for a preset), \`pixel_scene\` is \`scene\` and \`pixel_import\` is \`import\`, each run as above. A revision is the recipe file you saved, and \`pixel_help\` and its topics are the copied \`docs/agent-quick-start.md\`, \`docs/agent-guide.md\` (guide), \`docs/art-workflow.md\` (workflow) and the schema files; its \`presets\` and \`preset\` topics are \`presets\` and \`presets <name>\`, run as above. If Pixelbolt's MCP tools are configured as well, you may use them as described below.`;
  const body = [];
  for (const paragraph of paragraphs) {
    // The plugin's server, the portable build and the SKILL.md-only copy (`npx skills add`) don't apply to this copy.
    if (/^In (?:the (?:Claude Code plugin|portable Pixelbolt Studio build)|a copy of this file alone),/.test(paragraph)) continue;
    body.push(paragraph.replace(/ ?Pixelbolt lives at the project root two directories above this skill's directory\./, '')
      .replace(/\(in the Pixelbolt folder two directories above this skill's directory\)/g, "(copied into this skill's `examples/` folder)"));
    if (/^# /.test(paragraph)) body.push(intro);
  }
  return head + body.join('\n\n');
}

// What the copy is checked for: anything still pointing into a checkout would send the agent to a missing file.
// Relative links in the copied guides point only at copied files (relink), so only SKILL.md, at the top, can escape.
export function standaloneProblems(text, { skill = true } = {}) {
  return [[/two directories above/, 'a path two directories above the skill'], [/bin\/pixel(?:bolt|forge)\.js/, 'a checkout command'], [/`node scripts\/[^`]*`(?! in a clone of)/, 'a checkout script'], ...(skill ? [[/\]\(\.\.\//, 'a relative link outside the skill']] : []), [/plugin's server/, "the plugin's server"]]
    .filter(([pattern]) => pattern.test(text)).map(([, problem]) => problem);
}

// Every installed file: its path inside the skill folder and its bytes.
export async function skillFiles(version) {
  const { files } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const schemas = files.filter(file => /(?:^|\.)schema\.json$/.test(file)).sort();
  const sources = [...DOCS, ...schemas, ...(await filesUnder('examples')).filter(file => file.endsWith('.json')).sort(), 'LICENSE'];
  const copied = new Map([[SKILL_SOURCE, 'SKILL.md'], ...sources.map(file => [file, file])]), command = skillCommand(version), out = new Map();
  for (const [source, target] of copied) {
    let data = await readFile(path.join(ROOT, source));
    if (source.endsWith('.md')) {
      // A package packed from a CRLF tree would otherwise hide the paragraphs standaloneSkill drops.
      let text = data.toString('utf8').replace(/\r\n/g, '\n');
      if (source === SKILL_SOURCE) text = standaloneSkill(text, version);
      text = runThrough(relink(text, source, target, copied, version), command);
      const problems = standaloneProblems(text, { skill: source === SKILL_SOURCE });
      if (problems.length) throw new Error(`The skill in Pixelbolt ${version} could not be made standalone: ${target} still has ${problems.join(', ')}. Please report this at ${REPOSITORY}/issues; nothing was written.`);
      data = Buffer.from(text, 'utf8');
    }
    out.set(target, data);
  }
  return out;
}

const lstatOrNull = async file => { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const hashOf = async file => { const stats = await lstatOrNull(file); return stats?.isFile() ? sha256(await readFile(file)) : stats ? 'not a file' : null; };
// A manifest name is a plain relative path of ordinary names: never .. or a hidden name, a drive, a backslash or a
// Windows device name, so a manifest someone else wrote can't point an update or a removal outside the skill.
const plainPath = file => typeof file === 'string' && file.length <= 200 && file.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(part) && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part));
async function readManifest(folder) {
  const file = path.join(folder, SKILL_MANIFEST), stats = await lstatOrNull(file);
  if (!stats?.isFile()) return null;
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8')), files = manifest?.files;
    const valid = files && typeof files === 'object' && !Array.isArray(files) && Object.entries(files).every(([name, hash]) => plainPath(name) && /^[0-9a-f]{64}$/.test(hash));
    return valid ? manifest : null;
  } catch { return null; }
}
// What changed since an earlier install wrote the folder: files it wrote that were edited or replaced, and files this
// version ships that it didn't write but that are already there with other bytes (the user's own). A file that already
// holds this version's bytes is unchanged, and a missing one holds nothing to lose, so an interrupted update finishes
// without --force. `missing` lists this version's files that aren't there; `kept`, the changed files this version no
// longer ships, which even --force leaves alone (and stops listing as its own).
async function changedSince(folder, manifest, hashes) {
  const changed = [], missing = [], shipped = new Set(Object.keys(hashes).map(file => file.toLowerCase()));
  for (const file of new Set([...Object.keys(manifest.files), ...Object.keys(hashes)])) {
    const now = await hashOf(path.join(folder, ...file.split('/')));
    if (now === null) { if (Object.hasOwn(hashes, file)) missing.push(file); continue; }
    if (now === hashes[file]) continue;
    if (!Object.hasOwn(manifest.files, file) || now !== manifest.files[file]) changed.push(file);
  }
  return { changed: changed.sort(), missing, kept: changed.filter(file => !shipped.has(file.toLowerCase())).sort() };
}
// Temporary files an interrupted write left beside one of the skill's files (see replaceFile).
const leftover = (file, ours) => { const match = /^(.+)\.[0-9a-f]{12}\.tmp$/.exec(file); return match !== null && ours.has(match[1]); };
// Every file under a folder, or null when it holds anything but folders and files (a link).
async function filesIn(folder, prefix = '') {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) { const inner = await filesIn(path.join(folder, entry.name), `${name}/`); if (!inner) return null; found.push(...inner); } else if (entry.isFile()) found.push(name); else return null;
  }
  return found;
}
// Each folder on the way to these files, inside the skill folder.
const foldersOf = files => [...new Set(files.flatMap(file => file.split('/').slice(0, -1).map((part, i, parts) => parts.slice(0, i + 1).join('/'))))].sort();
// Writes beside the target and renames it into place, so a link or a second name for the old file is never written
// through.
async function replaceFile(target, data) {
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, data, { flag: 'wx' });
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export function skillsFolder({ dir, project, cwd = process.cwd(), home = os.homedir() } = {}) {
  if (dir !== undefined && project) throw new Error('Choose one of --project and --dir');
  return dir !== undefined ? path.resolve(cwd, dir) : path.join(project ? cwd : home, '.claude', 'skills');
}

export async function installSkill({ version, force = false, ...where }) {
  const folder = path.join(skillsFolder(where), SKILL_NAME), files = await skillFiles(version), list = [...files.keys()].sort();
  const usage = 'Pass --force to replace it, or --dir to install somewhere else; nothing was written.';
  const stats = await lstatOrNull(folder);
  // lstat: a link is never a folder here, whatever it points at.
  if (stats && !stats.isDirectory()) throw new Error(`${folder} is ${stats.isSymbolicLink() ? 'a link' : 'not a folder'}, so the skill is not installed through it, even with --force. Remove it or pass --dir; nothing was written.`);
  const manifest = stats ? await readManifest(folder) : null, previous = manifest ? Object.keys(manifest.files) : [];
  const hashes = Object.fromEntries(list.map(file => [file, sha256(files.get(file))]));
  // Folders inside the skill must be real folders too, or a write or a removal would land wherever they point.
  for (const sub of foldersOf([...list, ...previous])) {
    const inner = await lstatOrNull(path.join(folder, ...sub.split('/')));
    if (inner && !inner.isDirectory()) throw new Error(`${path.join(folder, ...sub.split('/'))} is ${inner.isSymbolicLink() ? 'a link' : 'not a folder'}; remove it and install again. Nothing was written.`);
  }
  let changed = [], missing = [], kept = [], status = stats ? 'updated' : 'installed';
  const own = new Set([...list, ...previous, SKILL_MANIFEST]), present = stats ? await filesIn(folder) : [];
  const leftovers = (present ?? []).filter(file => leftover(file, own));
  if (stats && !manifest) {
    // A first install cut short before its manifest left only this version's files, byte for byte, and perhaps the
    // temporary file it was writing: it finishes.
    const differ = present && (await Promise.all(present.map(async file => Object.hasOwn(hashes, file) && await hashOf(path.join(folder, ...file.split('/'))) !== hashes[file] ? file : null))).filter(Boolean);
    const ours = present && present.every(file => leftovers.includes(file) || (Object.hasOwn(hashes, file) && !differ.includes(file)));
    if (ours) status = 'installed';
    else if (!force) throw new Error(`${folder} already holds files this command didn't write. ${usage}`);
    else { status = 'replaced'; changed = (differ ?? []).sort(); }
  } else if (manifest) {
    ({ changed, missing, kept } = await changedSince(folder, manifest, hashes));
    if (changed.length && !force) throw new Error(`${folder} has changes since Pixelbolt ${manifest.version ?? 'an earlier version'} installed it (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, and ${changed.length - 5} more` : ''}). ${usage}`);
    // --force replaces the changed files this version ships; the ones it no longer ships stay as they are.
    changed = changed.filter(file => !kept.includes(file));
    if (changed.length) status = 'replaced';
  }
  for (const file of list) {
    const target = path.join(folder, ...file.split('/')), existing = await lstatOrNull(target);
    if (existing?.isDirectory()) throw new Error(`${target} is a folder; remove it and install again. Nothing was written.`);
  }
  // Files the earlier version wrote and this one doesn't ship go, unless edited or, on a file system that ignores
  // case, the same file as one this version writes.
  const shipped = new Set(list.map(file => file.toLowerCase()));
  const stale = previous.filter(file => !shipped.has(file.toLowerCase()) && !kept.includes(file));
  const same = manifest && !changed.length && !missing.length && !stale.length && !leftovers.length && manifest.version === version && JSON.stringify(manifest.files) === JSON.stringify(hashes);
  const command = skillCommand(version), result = { skill: folder, version, command, files: list.length };
  // From a checkout, npx fetches the released version of the same number, which lacks the checkout's later changes.
  if (await lstatOrNull(path.join(ROOT, '.git'))) result.warning = `Installed from a Pixelbolt checkout: the copy runs ${command} from npm, which may lack this checkout's unreleased changes. For a released copy, run npx -y pixelbolt@latest skill install.`;
  if (same) return { status: 'unchanged', ...result };
  await mkdir(folder, { recursive: true });
  for (const file of list) {
    const target = path.join(folder, ...file.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await replaceFile(target, files.get(file));
  }
  const removed = [];
  for (const file of stale) {
    const target = path.join(folder, ...file.split('/'));
    if (await lstatOrNull(target)) { await rm(target, { force: true }); removed.push(file); }
  }
  await replaceFile(path.join(folder, SKILL_MANIFEST), JSON.stringify({ installedBy: 'pixelbolt skill install', version, command, files: hashes }, null, 2) + '\n');
  for (const file of leftovers) await rm(path.join(folder, ...file.split('/')), { force: true });
  return { status, ...result, ...(manifest?.version && manifest.version !== version && { from: manifest.version }), ...(changed.length && { overwrote: changed }), ...(removed.length && { removed }), ...(kept.length && { kept }) };
}
