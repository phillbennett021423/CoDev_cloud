// The Windows app runs the sandbox on a worker thread (desktop/sandbox/remote.js), so
// staging a big project and diffing it never block the thread the window's clicks
// and keys go through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSandboxWorker } = require('../desktop/sandbox/remote');

test('the sandbox stages and diffs a big project on its own thread while this one keeps ticking', async t => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-worker-project-'));
    // About 60 MB in 3000 files: copied twice (workspace and baseline) on the first call.
    const chunk = 'x'.repeat(20 * 1024) + '\n';
    for (let d = 0; d < 30; d++) {
        fs.mkdirSync(path.join(project, `dir${d}`));
        for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(project, `dir${d}`, `file${f}.txt`), chunk);
    }
    fs.writeFileSync(path.join(project, 'main.js'), 'console.log("hi");\n');
    const logs = [];
    const sandbox = createSandboxWorker({ getProjectDir: () => project, log: line => logs.push(line) });
    t.after(() => { sandbox.closeSync(); fs.rmSync(project, { recursive: true, force: true }); });
    assert.ok(sandbox.worker, 'runs on a worker thread');

    const call = async (name, args) => (await sandbox.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: args, _meta: { 'codev/agent': 'a1', 'codev/workspace': 'ws1' } } })).result;

    // The longest gap between ticks of this thread while the worker does the work
    // (the same calls on this thread pause it for over a second).
    let last = Date.now();
    let longest = 0;
    const ticker = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 5);
    try {
        const read = await call('read_file', { path: 'main.js' });
        assert.match(read.content[0].text, /console\.log/);
        await call('write_file', { path: 'main.js', content: 'console.log("changed");\n' });
        const diff = await call('sandbox_diff', {});
        assert.match(diff.content[0].text, /changed/);
    } finally {
        clearInterval(ticker);
        longest = Math.max(longest, Date.now() - last);
    }
    assert.equal(fs.readFileSync(path.join(project, 'main.js'), 'utf8'), 'console.log("hi");\n', 'the real project is untouched');
    assert.ok(longest < 250, `this thread kept answering (longest pause ${longest} ms)`);

    // The review routes go through the same thread.
    const status = await sandbox.handleRequest('GET', '/agent/status', {}, null);
    assert.equal(status.status, 200);
});

test('a quitting app waits for the sandbox thread to remove its copies', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-worker-project-'));
    fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
    const sandbox = createSandboxWorker({ getProjectDir: () => project });
    const reply = await sandbox.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_files', arguments: {}, _meta: { 'codev/agent': 'a1', 'codev/workspace': 'quit-test' } } });
    assert.match(reply.result.content[0].text, /a\.txt/);
    const copies = path.join(os.tmpdir(), 'codev-sandboxes');
    const before = fs.readdirSync(copies).filter(name => name.startsWith('quit-test-'));
    assert.equal(before.length, 1, 'a staging copy exists');
    sandbox.closeSync();
    assert.equal(fs.readdirSync(copies).filter(name => name.startsWith('quit-test-')).length, 0, 'removed before closeSync returns');
    await assert.rejects(sandbox.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), /closed/);
    fs.rmSync(project, { recursive: true, force: true });
});
