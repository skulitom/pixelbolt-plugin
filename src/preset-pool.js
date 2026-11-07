// Node-side, one listing's bounded pool. Each lane has at most one job in flight; no worker-side queue can start
// work after the budget. A failure after ready costs only its assigned preset; failure to start retires the pool.
import { Worker, resourceLimits } from 'node:worker_threads';

function spawn() {
  // Nested MCP workers must inherit the calling tool thread's limits, not Node's unrestricted defaults.
  // --input-type describes a caller's eval/stdin script and is invalid for this file entry point. Keep other
  // inherited flags (including preloads), and handle both --input-type=module and --input-type module.
  const hasInputType = process.execArgv.some(arg => arg === '--input-type' || arg.startsWith('--input-type='));
  const execArgv = hasInputType ? process.execArgv.filter((arg, index, args) => arg !== '--input-type' && !arg.startsWith('--input-type=') && args[index - 1] !== '--input-type') : undefined;
  const thread = new Worker(new URL('./presets-worker.js', import.meta.url), { resourceLimits, execArgv });
  let pending, failure, resolveReady, started = false, closing;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const fail = error => { failure = error; resolveReady(); pending?.reject(error); pending = undefined; };
  thread.on('error', fail).on('exit', code => fail(failure ?? new Error(`the preset worker exited with code ${code}`)));
  thread.on('message', message => {
    if (message === 'ready') { started = true; resolveReady(); return; }
    pending?.resolve(message); pending = undefined;
  });
  return {
    close: () => closing ??= thread.terminate(),
    async ready() {
      await ready;
      if (!started) throw failure;
    },
    async measure(entry, source, deadline) {
      await ready;
      if (failure) throw failure;
      if (Date.now() > deadline) return null;
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        try { thread.postMessage({ entry, source, deadline }); } catch (error) { fail(error); }
      });
    }
  };
}

// The first preset handed out is measured even past the deadline, as the serial listing admits its first: workers that
// start slowly on a busy machine would otherwise measure nothing, cache nothing, and every listing would start over.
export async function measurePresets(jobs, { concurrency, deadline }, measure) {
  const results = new Array(jobs.length).fill(null), workers = new Set();
  const measurable = jobs.filter(job => job.error === undefined).length;
  let next = 0, serial = measurable < 2 || concurrency === 1, first = true;
  const open = () => first || Date.now() <= deadline;
  const create = () => { const worker = spawn(); workers.add(worker); return worker; };
  const retire = async worker => { await worker.close(); workers.delete(worker); };
  const close = () => Promise.all([...workers].map(retire));
  async function lane(worker) {
    while (!serial && next < jobs.length && open()) {
      const index = next++, { entry, source, error } = jobs[index];
      if (error !== undefined) { results[index] = { error }; continue; }
      const until = first ? Infinity : deadline;
      first = false;
      if (!worker) {
        try { worker = create(); await worker.ready(); }
        catch { serial = true; await close(); return; }
      }
      if (serial) return;
      try {
        results[index] = await worker.measure(entry, source, until);
      } catch (error) {
        // Pool retirement can interrupt other lanes. Leave those jobs for the in-thread retry.
        if (!serial) results[index] = { error: error.message };
        await retire(worker); worker = null;
      }
    }
  }
  try {
    if (!jobs.length || !open()) return results;
    const lanes = [];
    if (!serial) {
      try {
        for (let i = 0; i < Math.min(concurrency, measurable); i++) lanes.push(create());
        await Promise.all(lanes.map(worker => worker.ready()));
      } catch { serial = true; await close(); } // Missing modules and restricted runtimes both fall back.
    }
    if (!serial) await Promise.all(lanes.map(lane));
    if (serial) for (let index = 0; index < jobs.length && open(); index++) {
      if (results[index] !== null) continue;
      const { entry, source, error } = jobs[index];
      if (error === undefined) first = false;
      try { results[index] = error === undefined ? { facts: measure(entry, source) } : { error }; }
      catch (error) { results[index] = { error: error.message }; }
    }
    return results;
  } finally { await close(); }
}
