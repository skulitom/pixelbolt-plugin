// Stage exactly one neutral handoff. Run outside the participant's workspace.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const [family, variant, job, program, receipt] = process.argv.slice(2);
if (!receipt || !['clean', 'damaged'].includes(variant)) throw Error('Usage: node stage.mjs FAMILY clean|damaged NEW_JOB CLI_PATH PRIVATE_RECEIPT');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(join(family, 'FREEZE.json'));
const manifest = JSON.parse(manifestBytes).files;
const files = new Map([['actor.poses.json', variant + '.poses.json'], ['brief.txt', manifest['brief.txt'] ? 'brief.txt' : 'brief.md']]);
for (const file of Object.keys(manifest).filter(name => /^stand-[\w-]+\.png$/.test(name)).sort()) files.set(file, file);
if (files.size < 4) throw Error('At least two standing references are required.');
const receiptRel = relative(resolve(job), resolve(receipt));
if (!receiptRel || (!receiptRel.startsWith('..') && !isAbsolute(receiptRel))) throw Error('Keep the private receipt outside the staged job.');
await access(program);
try { await access(receipt); throw Error('Receipt already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const hashes = {}, bytes = new Map();
for (const [to, from] of files) {
  const data = await readFile(join(family, from));
  hashes[to] = sha(data);
  if (hashes[to] !== manifest[from]) throw Error('Frozen input hash mismatch: ' + from);
  bytes.set(to, data);
}
const prompt = [
  'Review the supplied character walk for production. Read brief.txt and the native standing references. Make any repairs the walk needs, preserving the standing drawings, ground anchor, direction, stride, frame sequence and timing.',
  'Keep the supplied actor.poses.json intact. Save its initial native render under first/. Deliver the editable result as final/source.poses.json, a compiled native bundle with its atlas and frame PNGs under final/export/, and a looping native-size GIF for each walk at final/<animation-name>.gif. Write review.md with your decisions and the Pixelbolt commands or views you used.',
  'Work only inside ' + resolve(job) + '. Use the installed Pixelbolt CLI at ' + resolve(program) + ', its public help, and your own scripts. Keep all temporary files here. Work independently without inspecting other workspaces, the repository, or answer keys.'
].join('\n\n');
await mkdir(job, {recursive:false});
for (const [name, data] of bytes) await writeFile(join(job, name), data, {flag:'wx'});
await writeFile(join(job, 'task.txt'), prompt + '\n', {flag:'wx'});
await writeFile(receipt, JSON.stringify({job:basename(job), variant, hashes, prompt, fixtureManifest:sha(manifestBytes)},null,2) + '\n', {flag:'wx'});
