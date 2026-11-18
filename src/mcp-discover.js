// The 2026-07-28 MCP envelope, discovery and result fields. No session state: each request supplies its capabilities;
// legacy requests keep their original replies. Keep the wire rules here and the queue, workers and limits in mcp.js.
import { isObject } from './core.js';

const PROTOCOL = 'io.modelcontextprotocol/protocolVersion', CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT = 'io.modelcontextprotocol/clientInfo', SERVER = 'io.modelcontextprotocol/serverInfo', LOG = 'io.modelcontextprotocol/logLevel';
const VERSION = '2026-07-28';
const supported = versions => [...versions, VERSION];
const cacheable = new Set(['server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read']);


const string = value => typeof value === 'string', boolean = value => typeof value === 'boolean';
const optional = (value, check) => value === undefined || check(value);
const optionalFields = (value, checks) => isObject(value) && Object.entries(checks).every(([key, check]) => optional(value[key], check));
const objects = value => isObject(value) && Object.values(value).every(isObject);
// RequestMetaEnvelopeSchema uses ClientCapabilities2026Schema: unknown extension keys are allowed, but the known
// capability shapes must be objects. UI mimeTypes remains extension data, judged exactly as initialize judges it.
const capabilitiesValid = value => optionalFields(value, {
  experimental: objects, extensions: objects,
  roots: value => optionalFields(value, { listChanged: boolean }),
  sampling: value => optionalFields(value, { context: isObject, tools: isObject }),
  elicitation: value => optionalFields(value, { form: value => optionalFields(value, { applyDefaults: boolean }), url: isObject })
});
const iconValid = value => optionalFields(value, { mimeType: string, sizes: value => Array.isArray(value) && value.every(string), theme: value => ['light', 'dark'].includes(value) }) && string(value.src);
const clientValid = value => optionalFields(value, { title: string, websiteUrl: string, description: string, icons: value => Array.isArray(value) && value.every(iconValid) }) && string(value.name) && string(value.version);

export function discoverRequest({ method, params }, versions, mime) {
  const meta = params?._meta;
  // A progress token alone, or a _meta that is not an object, is still a 2025 request. Discovery itself identifies the
  // modern protocol even when the envelope is absent; ordinary requests without an envelope keep the initialization gate.
  if (method === 'initialize' || (method !== 'server/discover' && !(isObject(meta) && (Object.hasOwn(meta, PROTOCOL) || Object.hasOwn(meta, CAPABILITIES))))) return null;
  const protocol = isObject(meta) ? meta[PROTOCOL] : undefined, capabilities = isObject(meta) ? meta[CAPABILITIES] : undefined;
  if (string(protocol) && !supported(versions).includes(protocol)) return { error: { code: -32022, message: `Unsupported protocol version: ${protocol}`, data: { supported: supported(versions), requested: protocol } } };
  if (versions.includes(protocol) && method !== 'server/discover') return null;
  const invalid = [];
  if (!string(protocol)) invalid.push(PROTOCOL);
  if (!capabilitiesValid(capabilities)) invalid.push(CAPABILITIES);
  if (isObject(meta)) {
    if (!optional(meta[CLIENT], clientValid)) invalid.push(CLIENT);
    if (!optional(meta[LOG], value => ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(value))) invalid.push(LOG);
    if (!optional(meta.progressToken, value => string(value) || (typeof value === 'number' && Number.isFinite(value)))) invalid.push('progressToken');
  }
  if (invalid.length) return { error: { code: -32602, message: `request _meta is missing or has malformed required fields: ${invalid.join(', ')}` } };
  const mimeTypes = capabilities.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes;
  return { ui: Array.isArray(mimeTypes) && mimeTypes.includes(mime) };
}

export function discoverResult(versions, ui, instructions) {
  return { supportedVersions: supported(versions), capabilities: { tools: {}, ...(ui && { resources: {} }) }, instructions };
}

export function completeResult(method, value, version) {
  // The 2026 wire ResultSchema requires resultType; its cacheable results require ttlMs and cacheScope. Do not
  // cache capability-dependent replies across clients. ResultMetaSchema puts identity in _meta, not serverInfo.
  return { resultType: 'complete', ...(cacheable.has(method) && { ttlMs: 0, cacheScope: 'private' }), ...value, _meta: { ...value._meta, [SERVER]: { name: 'pixelbolt', version } } };
}
