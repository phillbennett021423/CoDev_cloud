// The Windows app's sandbox, run on a worker thread (worker.js) so its file work never
// blocks the window. Same calls as createSandbox: handleMcp, handleRequest, closeSync.
// If the thread can't start, the sandbox runs in this process as before.
const path = require('path');
const { Worker } = require('worker_threads');
const { createSandbox } = require('./index');

// How long a quitting app waits for the containers and copies to be removed.
const CLOSE_WAIT_MS = 25000;

// Inside the installed app this folder is unpacked from app.asar (see asarUnpack in
// package.json), since a worker thread starts from a real file.
function workerFile() {
    return path.join(__dirname, 'worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function createSandboxWorker({ getProjectDir, log = () => {} } = {}) {
    let worker;
    try {
        worker = new Worker(workerFile(), { workerData: { projectDir: getProjectDir() || '' } });
    } catch (err) {
        log(`[Sandbox] Running on the main thread: ${err.message}`);
        return createSandbox({ getProjectDir, log });
    }
    const pending = new Map();
    let nextId = 0;
    let dead = null;
    worker.on('message', msg => {
        if (msg && msg.op === 'log') return log(msg.line);
        const call = msg && pending.get(msg.id);
        if (!call) return;
        pending.delete(msg.id);
        if ('error' in msg) call.reject(new Error(msg.error)); else call.resolve(msg.result);
    });
    const fail = err => {
        dead = err;
        for (const call of pending.values()) call.reject(err);
        pending.clear();
    };
    worker.on('error', err => { log(`[Sandbox] The sandbox thread stopped: ${err.message}`); fail(err); });
    worker.on('exit', code => fail(new Error(`The sandbox stopped (exit code ${code}). Restart CoDev to use it again.`)));

    function call(op, args) {
        if (dead) return Promise.reject(dead);
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            worker.postMessage({ id, op, args, projectDir: getProjectDir() || '' });
        });
    }

    return {
        handleMcp: message => call('mcp', [message]),
        handleRequest: (method, urlPath, query, body) => call('request', [method, urlPath, query, body]),
        // On quit: the thread removes the containers and copies while this one waits.
        closeSync() {
            if (dead) return;
            const flag = new Int32Array(new SharedArrayBuffer(4));
            worker.postMessage({ op: 'closeSync', flag });
            Atomics.wait(flag, 0, 0, CLOSE_WAIT_MS);
            worker.terminate().catch(() => {});
            dead = new Error('The sandbox is closed.');
        },
        worker
    };
}

module.exports = { createSandboxWorker };
