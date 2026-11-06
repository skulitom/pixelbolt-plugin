// A pool worker receives only a resolved preset, and returns the same facts/error as the serial listing.
import { parentPort } from 'node:worker_threads';
import { measurePreset } from './presets.js';

parentPort.on('message', ({ entry, source, deadline }) => {
  if (Date.now() > deadline) { parentPort.postMessage(null); return; }
  try { parentPort.postMessage({ facts: measurePreset(entry, source) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
parentPort.postMessage('ready');
