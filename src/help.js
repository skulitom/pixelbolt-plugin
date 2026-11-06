// Node-side help topics, shared by MCP pixel_help and `pixelbolt help <topic> [section]`: the quick start, the two
// guides, the recipe schema, a complete example, then the schema of each source format. The presets topics are built
// from examples/ when asked (presets.js), so they are listed here but served by the caller.
import { readFile } from 'node:fs/promises';
import { PixelError } from './core.js';

export const QUICK_START = '../docs/agent-quick-start.md';
export const HELP_TOPICS = {
  guide: '../docs/agent-guide.md', workflow: '../docs/art-workflow.md', schema: '../schema.json', example: '../examples/forest-spirit.json',
  poses: '../poses.schema.json', scenes: '../scene.schema.json', autotile: '../autotile.schema.json', fx: '../fx.schema.json', fluid: '../fluid.schema.json', wave: '../wave.schema.json', bodies: '../bodies.schema.json', normals: '../normals.schema.json'
};
export const TOPICS = [...Object.keys(HELP_TOPICS), 'presets', 'preset'];
// Topics whose file is JSON (the schemas and the example), which MCP returns parsed.
export const jsonTopic = topic => HELP_TOPICS[topic]?.endsWith('.json') ?? false;
// The guide and the workflow are long (the workflow passes 150 KB, more than many clients keep of one reply), so each
// opens with its sections and their sizes, and `name` returns one `## ` section under the document's title.
export const SECTIONED = new Set(['guide', 'workflow']);

// How each interface asks for one section, for the line that lists them.
const ASK = {
  mcp: topic => `call pixel_help with topic "${topic}" and name set to its heading`,
  cli: topic => `run pixelbolt help ${topic} "<heading>" (the start of a heading is enough)`
};

export function helpDocument(topic, text, name, via = 'mcp') {
  const lines = text.split('\n'), sections = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && line.startsWith('## ')) sections.push({ heading: line.slice(3).trim(), index });
  });
  const end = i => sections[i + 1]?.index ?? lines.length;
  if (name === undefined) {
    const listed = sections.map((section, i) => `${section.heading} (${Math.ceil(Buffer.byteLength(lines.slice(section.index, end(i)).join('\n')) / 1024)} KB)`);
    return [lines[0], '', `> ${Math.ceil(Buffer.byteLength(text) / 1024)} KB in all. To read one section, ${ASK[via](topic)}: ${listed.join('; ')}.`, ...lines.slice(1)].join('\n');
  }
  const wanted = name.trim().toLowerCase(), headings = sections.map(section => section.heading.toLowerCase());
  const i = wanted ? (headings.includes(wanted) ? headings.indexOf(wanted) : headings.findIndex(heading => heading.startsWith(wanted))) : -1;
  if (i < 0) throw new PixelError('name', `topic ${topic} has no section "${name}"; its sections are ${sections.map(section => section.heading).join(', ')}`);
  return [lines[0], '', ...lines.slice(sections[i].index, end(i))].join('\n').trimEnd() + '\n';
}

// A document topic as text: the quick start without a topic, a guide (whole with its sections listed, or one section),
// a schema or the example as written.
export async function helpText(topic, name, via = 'mcp') {
  const file = topic === undefined ? QUICK_START : HELP_TOPICS[topic], text = await readFile(new URL(file, import.meta.url), 'utf8');
  return SECTIONED.has(topic) ? helpDocument(topic, text.replace(/\r\n/g, '\n'), name, via) : text;
}
