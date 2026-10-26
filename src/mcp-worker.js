// The MCP server's tool calls run here, in a worker thread, so the server can stop a call that takes too long or runs
// out of memory without stopping itself (see createToolHost in mcp.js). The first message says the worker is ready;
// after that, each message in is one call and each message out is its result.
import { parentPort, workerData } from 'node:worker_threads';
import { createToolRunner } from './mcp.js';

const runTool = createToolRunner(workerData);
parentPort.on('message', async ({ name, args }) => parentPort.postMessage(await runTool(name, args)));
parentPort.postMessage('ready');
