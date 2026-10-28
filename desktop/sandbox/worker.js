// The sandbox on a thread of its own, for the Windows app. Staging copies the whole
// project (up to 200 MB, twice), the review reads every staged file, and each tool
// call checks the project for the user's own edits; all of that is synchronous file
// work. On the main process it froze the window while agents worked, since the
// window's clicks and keys go through the same thread. Here it can't.
//
// Messages from main.js (see remote.js): { id, op: 'mcp' | 'request', args, projectDir }
// answered with { id, result } or { id, error }; { op: 'closeSync', flag } removes the
// containers and copies, then sets flag[0] to 1 so the quitting app can go on.
const { parentPort, workerData } = require('worker_threads');
const { createSandbox } = require('./index');

let projectDir = (workerData && workerData.projectDir) || '';
const sandbox = createSandbox({
    getProjectDir: () => projectDir,
    log: line => parentPort.postMessage({ op: 'log', line: String(line) })
});

parentPort.on('message', async msg => {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.projectDir === 'string') projectDir = msg.projectDir;
    if (msg.op === 'closeSync') {
        try { sandbox.closeSync(); } catch { /* best effort on the way out */ }
        if (msg.flag) { Atomics.store(msg.flag, 0, 1); Atomics.notify(msg.flag, 0); }
        return;
    }
    try {
        const args = Array.isArray(msg.args) ? msg.args : [];
        const result = msg.op === 'mcp' ? await sandbox.handleMcp(...args)
            : msg.op === 'request' ? await sandbox.handleRequest(...args)
            : (() => { throw new Error(`Unknown sandbox op ${msg.op}`); })();
        parentPort.postMessage({ id: msg.id, result });
    } catch (err) {
        parentPort.postMessage({ id: msg.id, error: err && err.message ? err.message : String(err) });
    }
});
