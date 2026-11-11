// Node-side help topics, shared by MCP pixel_help and `pixelbolt help <topic> [section]`: the quick start, the two
// guides, the recipe schema, a complete example, then the schema of each source format. The presets topics are built
// from examples/ when asked (presets.js), so they are listed here but served by the caller.
import { readFile } from 'node:fs/promises';
import { PixelError } from './core.js';
import { formatJSON } from './export.js';

export const QUICK_START = '../docs/agent-quick-start.md';
export const HELP_TOPICS = {
  guide: '../docs/agent-guide.md', workflow: '../docs/art-workflow.md', craft: '../docs/agent-craft.md', schema: '../schema.json', example: '../examples/forest-spirit.json',
  poses: '../poses.schema.json', scenes: '../scene.schema.json', autotile: '../autotile.schema.json', fx: '../fx.schema.json', fluid: '../fluid.schema.json', wave: '../wave.schema.json', crystal: '../crystal.schema.json', powder: '../powder.schema.json', bodies: '../bodies.schema.json', normals: '../normals.schema.json'
};
export const TOPICS = [...Object.keys(HELP_TOPICS), 'presets', 'preset'];
// Topics whose file is JSON (the schemas and the example), which MCP returns parsed.
export const jsonTopic = topic => HELP_TOPICS[topic]?.endsWith('.json') ?? false;
// The guide and the workflow are long (the workflow passes 200 KB, and its fluid section 60), so a reply is never a
// whole document unless it is asked for:
// - without a `name`, the document's opening and the list of its `## ` sections with their sizes;
// - a `name` that starts a section's heading, that section under the document's title, or, for a section over
//   PART_BYTES that has `### ` parts, its opening and the list of those parts;
// - a `name` that starts a part's heading, that part;
// - any other `name`, the paragraphs that mention it: what a reader would otherwise search the file for;
// - "all" the whole document, and "<section> all" a whole section.
// The craft notes are the pixel art skill's checklists, read a section at a time.
export const SECTIONED = new Set(['guide', 'workflow', 'craft']);

// How each interface asks for one section, for the line that lists them.
const ASK = {
  mcp: topic => `call pixel_help with topic "${topic}" and name set to its heading`,
  cli: topic => `run pixelbolt help ${topic} "<heading>" (the start of a heading is enough)`
};
// The size past which a section with parts lists them, what a search returns at most, and the length past which a
// line gives only its sentences that mention the word.
const PART_BYTES = 12288, FOUND_BYTES = 6144, LONG_LINE = 900;
const kilobytes = lines => `${Math.ceil(Buffer.byteLength(lines.join('\n')) / 1024)} KB`;

// The paragraphs of a document that mention a word, each cut to what mentions it: a table to its matching rows, a
// list to its matching items, a long line to its matching sentences. Those with the word as a name (`text`, "text")
// come first, then the rest, as far as FOUND_BYTES go; `more` counts what was left out, by section.
function mentions(lines, sections, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), has = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i'), named = new RegExp(`[\`"]${escaped}(?![A-Za-z0-9])|(?<![A-Za-z0-9])${escaped}[\`"]`, 'i');
  const cut = block => {
    if (block[0].startsWith('```')) return block.join('\n').length <= LONG_LINE * 2 ? block : block.filter((line, index) => index === 0 || index === block.length - 1 || has.test(line));
    const table = block.length > 2 && block.every(line => line.startsWith('|'));
    return block.filter((line, index) => (table && index < 2) || has.test(line)).map(line => (line.length <= LONG_LINE ? line : line.split(/(?<=[.)]) (?=[A-Z`])/).filter(sentence => has.test(sentence)).join(' … ')));
  };
  const found = [];
  [{ heading: '', index: 0, end: sections[0]?.index ?? lines.length }, ...sections].forEach(section => {
    let block = [], fenced = false;
    const flush = () => { if (block.length && has.test(block.join('\n'))) found.push({ heading: section.heading, text: cut(block).join('\n'), named: named.test(block.join('\n')) }); block = []; };
    for (const line of lines.slice(section.index + 1, section.end)) {
      if (line.startsWith('```')) { if (!fenced) flush(); fenced = !fenced; block.push(line); if (!fenced) flush(); }
      else if (!fenced && (line.trim() === '' || line.startsWith('#'))) flush();
      else block.push(line);
    }
    flush();
  });
  const order = [...found.filter(item => item.named), ...found.filter(item => !item.named)], kept = new Set();
  let bytes = 0;
  for (const item of order) { bytes += Buffer.byteLength(item.text); if (kept.size && bytes > FOUND_BYTES) break; kept.add(item); }
  const more = new Map();
  for (const item of found) if (!kept.has(item)) more.set(item.heading || 'the opening', (more.get(item.heading || 'the opening') ?? 0) + 1);
  return { found: found.filter(item => kept.has(item)), more };
}

export function helpDocument(topic, text, name, via = 'mcp') {
  // Sections (`## `) and, inside each, its parts (`### `), with the line each starts on and the line after its last.
  const lines = text.split('\n'), sections = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && line.startsWith('## ')) sections.push({ heading: line.slice(3).trim(), index, parts: [] });
    else if (!fenced && line.startsWith('### ') && sections.length) sections.at(-1).parts.push({ heading: line.slice(4).trim(), index });
  });
  sections.forEach((section, i) => {
    section.end = sections[i + 1]?.index ?? lines.length;
    section.parts.forEach((part, k) => { part.end = section.parts[k + 1]?.index ?? section.end; });
  });
  const start = sections[0]?.index ?? lines.length, sized = item => `${item.heading} (${kilobytes(lines.slice(item.index, item.end))})`;
  const page = body => [lines[0], '', ...body].join('\n').trimEnd() + '\n';
  if (name === undefined) return page([`> ${kilobytes(lines)} in all. To read one section, ${ASK[via](topic)}: ${sections.map(sized).join('; ')}. A word that starts no heading returns the paragraphs that mention it, and "all" the whole document.`, ...lines.slice(1, start)]);
  const asked = name.trim().toLowerCase(), whole = asked === 'all' || asked.endsWith(' all'), wanted = whole ? asked.slice(0, -3).trim() : asked;
  if (whole && !wanted) return text;
  // The heading that is the name, else the first that starts with it: a section's before a part's.
  const pick = items => items.find(item => item.heading.toLowerCase() === wanted) ?? items.find(item => item.heading.toLowerCase().startsWith(wanted));
  const section = wanted ? pick(sections) : undefined;
  if (section) {
    const first = section.parts[0]?.index;
    if (whole || first === undefined || Buffer.byteLength(lines.slice(section.index, section.end).join('\n')) <= PART_BYTES) return page(lines.slice(section.index, section.end));
    return page([lines[section.index], '', `> ${kilobytes(lines.slice(section.index, section.end))} in this section, so here is its opening. Its parts, each read by its heading as a section is: ${section.parts.map(sized).join('; ')}. "${section.heading} all" is the whole section.`, ...lines.slice(section.index + 1, first)]);
  }
  // A part by its heading, or by its section's heading and then its own ("Rigid bodies Shapes").
  for (const parent of wanted ? sections : []) {
    const own = parent.heading.toLowerCase(), within = wanted.startsWith(`${own} `) ? wanted.slice(own.length).trim() : null;
    const part = pick(parent.parts) ?? (within ? parent.parts.find(item => item.heading.toLowerCase().startsWith(within)) : undefined);
    if (part) return page([lines[parent.index], '', ...lines.slice(part.index, part.end)]);
  }
  const { found, more } = wanted ? mentions(lines, sections, name.trim()) : { found: [] };
  if (!found.length) throw new PixelError('name', `topic ${topic} has no section "${name}" and no paragraph that mentions it; its sections are ${sections.map(item => item.heading).join(', ')}`);
  const out = [`> No section of ${topic} starts with "${name.trim()}". ${found.length === 1 ? 'The one paragraph that mentions it' : `The ${found.length} paragraphs that mention it`}${more.size ? `, of ${found.length + [...more.values()].reduce((sum, count) => sum + count, 0)} (the rest: ${[...more].map(([heading, count]) => `${heading} ${count}`).join(', ')}; a section's heading or a longer phrase narrows it)` : ''}:`];
  found.forEach((item, index) => { if (item.heading && item.heading !== found[index - 1]?.heading) out.push('', `## ${item.heading}`); out.push('', item.text); });
  return page(out);
}

// The schemas run from 12 to 142 KB, so a schema topic is read as the guides are. Without a name it is an outline:
// each property with its type, what it holds, and for a large one its size and the properties inside it. `name` is a
// path of property names ("effects.bodies") and returns that part, as JSON when it is under PART_BYTES and as its own
// outline when it is not; "all" is the whole schema.
export const isSchema = topic => jsonTopic(topic) && topic !== 'example';
const SCHEMA_ASK = {
  mcp: (topic, path) => `call pixel_help with topic "${topic}" and name "${path}"`,
  cli: (topic, path) => `run pixelbolt help ${topic} ${path}`
};
export function helpSchema(topic, text, name, via = 'mcp', presets = []) {
  const schema = JSON.parse(text), asked = name?.trim();
  if (asked?.toLowerCase() === 'all') return text;
  const deref = node => { while (node && typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')) node = schema.$defs?.[node.$ref.slice(8)]; return node; };
  // The properties a reader may write under a node: its own, its items' or its named entries'.
  const inside = node => { const at = deref(node); return at?.properties ?? deref(at?.items)?.properties ?? deref(at?.additionalProperties)?.properties ?? null; };
  const bytes = node => Buffer.byteLength(JSON.stringify(node)), size = node => `${Math.ceil(bytes(node) / 1024)} KB`;
  const kind = node => { const at = deref(node) ?? {}; return at.const !== undefined ? JSON.stringify(at.const) : at.enum ? at.enum.map(value => JSON.stringify(value)).join(' | ') : at.type === 'array' ? `list of ${deref(at.items)?.type ?? 'values'}` : Array.isArray(at.type) ? at.type.join(' or ') : at.type ?? (at.oneOf || at.anyOf ? 'one of several forms' : 'value'); };
  let node = schema, path = '';
  for (const segment of asked ? asked.split('.').filter(Boolean) : []) {
    const properties = inside(node);
    if (!properties || !Object.hasOwn(properties, segment)) throw new PixelError('name', `the ${topic === 'schema' ? 'recipe' : topic} schema has no ${JSON.stringify(path ? `${path}.${segment}` : segment)}; ${path || 'it'} holds ${properties ? Object.keys(properties).join(', ') : 'no named properties'}`);
    node = properties[segment]; path = path ? `${path}.${segment}` : segment;
  }
  const properties = inside(node);
  if (path && (!properties || bytes(node) <= PART_BYTES)) return formatJSON(deref(node));
  const required = new Set(deref(node)?.required ?? deref(deref(node)?.items)?.required ?? []), under = key => (path ? `${path}.${key}` : key);
  const line = ([key, child]) => {
    const kids = inside(child), large = kids && bytes(child) > 2048, text = deref(child)?.description ?? '';
    return `- \`${key}\`${required.has(key) ? ' (required)' : ''}: ${kind(child)}${large ? `, ${size(child)}` : ''}${text ? `. ${text.length > 220 ? `${text.slice(0, 200).replace(/\s+\S*$/, '')} …` : text}` : '.'}${kids ? ` Holds ${Object.entries(kids).map(([name, each]) => (bytes(each) > 2048 ? `${name} (${size(each)})` : name)).join(', ')}.` : ''}`;
  };
  // The example path is the largest part: the one a reader most often needs.
  const first = Object.entries(properties).sort((a, b) => bytes(b[1]) - bytes(a[1]))[0][0];
  return [`# ${schema.title ?? topic}${path ? `: ${path}` : ''}`, '', `> A schema of ${size(node)}, outlined. To read one part as JSON, ${SCHEMA_ASK[via](topic, under(first))} (a path of property names); "all" is the whole schema.`,
    ...(deref(node)?.description ? ['', deref(node).description] : []),
    ...(!path && presets.length ? ['', `Shipped sources in this format, to start from (${via === 'mcp' ? 'pixel_help with topic "preset" and name' : 'pixelbolt presets <name>'}): ${presets.join(', ')}.`] : []),
    '', ...Object.entries(properties).map(line)].join('\n') + '\n';
}

// The quick start has sections for one interface or the other, and a reader gets its own: an MCP client the tools, a
// shell the commands. A shell reader came by the pixel art skill, whose table already says where each kind of job
// starts, so the starting points (written as tool calls) are left to the MCP reader. The file itself holds all of it.
const NOT_FOR = { mcp: ['The commands'], cli: ['The tools', 'Starting points'] };
export function quickStart(text, via = 'mcp') {
  let lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const heading of NOT_FOR[via]) {
    const from = lines.indexOf(`## ${heading}`), next = lines.findIndex((line, index) => index > from && line.startsWith('## '));
    if (from >= 0) lines = [...lines.slice(0, from), ...(next < 0 ? [] : lines.slice(next))];
  }
  return lines.join('\n');
}

// A document topic as text: the quick start without a topic, a guide (its opening and sections, one section, or what
// mentions a word), a schema (its outline, or one part by its path) or the example as written.
export async function helpText(topic, name, via = 'mcp') {
  const file = topic === undefined ? QUICK_START : HELP_TOPICS[topic], text = await readFile(new URL(file, import.meta.url), 'utf8');
  if (topic === undefined) return quickStart(text, via);
  if (SECTIONED.has(topic)) return helpDocument(topic, text.replace(/\r\n/g, '\n'), name, via);
  if (!isSchema(topic)) return text;
  // The presets written in this format are the examples of it, named without compiling any.
  const presets = name === undefined ? (await (await import('./presets.js')).presetEntries()).filter(entry => entry.kind === topic).map(entry => entry.name) : [];
  return helpSchema(topic, text, name, via, presets);
}
