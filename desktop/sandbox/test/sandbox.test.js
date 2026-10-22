// node --test desktop/sandbox/test
// The Docker tests run only when a Docker engine is reachable; the rest always run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { unifiedDiff } = require('../diff');
const { validateFile } = require('../validate');
const { createSandbox } = require('..');

const dockerUp = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

function tempProject(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-project-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

function setup(files, options = {}) {
    const project = tempProject(files);
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-staging-'));
    const sandbox = createSandbox({ getProjectDir: () => project, stagingRoot, ...options });
    const call = async (name, args, agent = 'a1', workspace = 'ws1') => {
        const reply = await sandbox.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name, arguments: args, _meta: { 'codev/agent': agent, 'codev/workspace': workspace } } });
        return reply.result;
    };
    const cleanup = async () => {
        await sandbox.close();
        fs.rmSync(project, { recursive: true, force: true });
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    };
    return { project, sandbox, call, cleanup };
}

test('unified diffs apply with git apply', { skip: !hasGit && 'git not installed' }, () => {
    const cases = [
        ['a\nb\nc\n', 'a\nB\nc\n'],
        ['one\ntwo\n', 'one\ntwo\nthree'],
        ['no newline', 'no newline\n'],
        ['x\n'.repeat(50), 'x\n'.repeat(20) + 'y\n' + 'x\n'.repeat(29) + 'z\n'],
        ['', 'fresh\n'],
        ['keep\n'.repeat(3) + 'drop\n' + 'keep\n'.repeat(10) + 'drop\n', 'keep\n'.repeat(3) + 'keep\n'.repeat(10)]
    ];
    for (const [before, after] of cases) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-diff-'));
        fs.writeFileSync(path.join(dir, 'f.txt'), before);
        const patch = unifiedDiff('f.txt', before, after);
        fs.writeFileSync(path.join(dir, 'p.diff'), patch);
        execFileSync('git', ['apply', '--unsafe-paths', 'p.diff'], { cwd: dir });
        assert.strictEqual(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), after, patch);
        fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.strictEqual(unifiedDiff('same.txt', 'a\n', 'a\n'), '');
    assert.match(unifiedDiff('new.js', null, 'x\n'), /new file mode[\s\S]*--- \/dev\/null[\s\S]*@@ -0,0 \+1 @@/);
});

test('syntax checks', async () => {
    assert.strictEqual((await validateFile('a.json', '{"ok": true}')).status, 'passed');
    assert.strictEqual((await validateFile('a.json', '{"ok": tru}')).status, 'failed');
    assert.strictEqual((await validateFile('a.js', 'const x = 1;\n')).status, 'passed');
    const bad = await validateFile('a.js', 'function (\n');
    assert.strictEqual(bad.status, 'failed');
    assert.strictEqual((await validateFile('esm.js', 'import fs from "fs";\nexport const a = fs;\n')).status, 'passed');
    assert.strictEqual((await validateFile('page.html', '<p>hi</p>\n<script>\nlet a = ;\n</script>')).status, 'failed');
    assert.strictEqual((await validateFile('page.html', '<script type="module">import x from "./x.js"; console.log(x);</script>')).status, 'passed');
    assert.strictEqual((await validateFile('notes.md', '# hi')).status, 'skipped');
    assert.strictEqual((await validateFile('a.txt', 'x\n<<<<<<< HEAD\ny\n')).status, 'failed');
    const py = await validateFile('a.py', 'def f(:\n  pass\n');
    assert.ok(py.status === 'failed' || py.status === 'skipped');
});

test('agent edits stay in the sandbox until approved', async () => {
    const { project, sandbox, call, cleanup } = setup({ 'src/app.js': 'console.log("v1");\n', 'data.json': '{"a":1}\n', 'README.md': 'hi\n' });
    try {
        const write = await call('write_file', { path: 'src/app.js', content: 'console.log("v2");\n' });
        assert.strictEqual(write.isError, false, write.content[0].text);
        await call('write_file', { path: 'data.json', content: '{"a":' });
        await call('write_file', { path: 'src/new.js', content: 'export const n = 1;\n' });
        await call('delete_file', { path: 'README.md' });
        assert.strictEqual(fs.readFileSync(path.join(project, 'src/app.js'), 'utf8'), 'console.log("v1");\n');
        assert.ok(fs.existsSync(path.join(project, 'README.md')));
        assert.strictEqual((await call('read_file', { path: 'src/app.js' })).content[0].text, 'console.log("v2");\n');

        const diff = await call('sandbox_diff', {});
        assert.match(diff.content[0].text, /data\.json[^\n]*FAILED/);

        const list = await sandbox.handleRequest('GET', '/agent/changes');
        assert.strictEqual(list.status, 200);
        const set = list.body[0];
        assert.deepStrictEqual(set.files.map(f => `${f.status}:${f.path}`), ['modified:data.json', 'deleted:README.md', 'modified:src/app.js', 'added:src/new.js']);
        assert.match(set.diff, /-console\.log\("v1"\);\n\+console\.log\("v2"\);/);

        // Approving everything still refuses the file that failed its check.
        const approved = await sandbox.handleRequest('POST', `/agent/changes/${set.id}/approve`, {}, { paths: set.files.map(f => f.path) });
        assert.deepStrictEqual(approved.body.written.sort(), ['README.md', 'src/app.js', 'src/new.js']);
        assert.deepStrictEqual(approved.body.skipped.map(s => s.path), ['data.json']);
        assert.strictEqual(fs.readFileSync(path.join(project, 'src/app.js'), 'utf8'), 'console.log("v2");\n');
        assert.ok(!fs.existsSync(path.join(project, 'README.md')));
        assert.strictEqual(fs.readFileSync(path.join(project, 'data.json'), 'utf8'), '{"a":1}\n');

        // The broken file is still pending; rejecting it puts the sandbox back.
        const again = (await sandbox.handleRequest('GET', '/agent/changes')).body;
        assert.deepStrictEqual(again[0].files.map(f => f.path), ['data.json']);
        const rejected = await sandbox.handleRequest('POST', `/agent/changes/${again[0].id}/reject`, {}, { reason: 'broken' });
        assert.deepStrictEqual(rejected.body, { ok: true });
        assert.strictEqual((await sandbox.handleRequest('GET', '/agent/changes')).body.length, 0);
        assert.strictEqual((await sandbox.handleRequest('GET', `/agent/changes/${again[0].id}`)).body.status, 'rejected');
    } finally {
        await cleanup();
    }
});

test('paths cannot leave the sandbox', async () => {
    const { project, call, cleanup } = setup({ 'a.txt': 'a\n' });
    try {
        for (const bad of ['../escape.txt', '/etc/passwd', 'C:/Windows/x', 'sub/../../x']) {
            const r = await call('write_file', { path: bad, content: 'x' });
            assert.strictEqual(r.isError, true, bad);
        }
        assert.ok(!fs.existsSync(path.join(path.dirname(project), 'escape.txt')));
    } finally {
        await cleanup();
    }
});

test('symlinks made in the sandbox are never followed or applied', async () => {
    const outside = tempProject({ 'secret.txt': 'secret\n' });
    const { sandbox, call, cleanup } = setup({ 'a.txt': 'a\n' });
    try {
        await call('list_files', {});
        const work = sandbox.staging.get('ws1').work;
        fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
        fs.symlinkSync(outside, path.join(work, 'linkdir'));
        assert.strictEqual((await call('read_file', { path: 'link.txt' })).isError, true);
        assert.strictEqual((await call('write_file', { path: 'linkdir/x.txt', content: 'x' })).isError, true);
        assert.ok(!fs.existsSync(path.join(outside, 'x.txt')));
        const set = (await sandbox.handleRequest('GET', '/agent/changes')).body[0];
        const link = set.files.find(f => f.path === 'link.txt');
        assert.strictEqual(link.status, 'symlink');
        const approved = await sandbox.handleRequest('POST', `/agent/changes/${set.id}/approve`, {}, { paths: ['link.txt'] });
        assert.deepStrictEqual(approved.body.written, []);
    } finally {
        await cleanup();
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('a file the user changed on disk meanwhile is not overwritten', async () => {
    const { project, sandbox, call, cleanup } = setup({ 'a.txt': 'one\n', 'b.txt': 'b\n' });
    try {
        await call('write_file', { path: 'a.txt', content: 'agent\n' });
        fs.writeFileSync(path.join(project, 'a.txt'), 'user\n');
        const set = (await sandbox.handleRequest('GET', '/agent/changes')).body[0];
        const r = await sandbox.handleRequest('POST', `/agent/changes/${set.id}/approve`, {}, {});
        assert.deepStrictEqual(r.body.written, []);
        assert.match(r.body.skipped[0].reason, /changed since the agent started/);
        assert.strictEqual(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'user\n');
    } finally {
        await cleanup();
    }
});

test('a file changed in the sandbox after review needs a new review', async () => {
    const { project, sandbox, call, cleanup } = setup({ 'a.txt': 'one\n' });
    try {
        await call('write_file', { path: 'a.txt', content: 'reviewed\n' });
        const set = (await sandbox.handleRequest('POST', '/agent/sandboxes/ws1/stage')).body;
        await call('write_file', { path: 'a.txt', content: 'sneaky\n' });
        const r = await sandbox.handleRequest('POST', `/agent/changes/${set.id}/approve`, {}, {});
        assert.deepStrictEqual(r.body.written, []);
        assert.strictEqual(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'one\n');
    } finally {
        await cleanup();
    }
});

test('without Docker, run_command is withheld and exec says why', async () => {
    const { sandbox, call, cleanup } = setup({ 'a.txt': 'a\n' }, { containerOptions: { dockerPath: 'docker-not-installed-here' } });
    try {
        const tools = (await sandbox.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map(t => t.name);
        assert.ok(!tools.includes('run_command'));
        assert.ok(tools.includes('write_file'));
        const status = (await sandbox.handleRequest('GET', '/agent/status')).body;
        assert.strictEqual(status.docker.available, false);
        assert.match(status.docker.error, /isn't installed/);
        const box = (await sandbox.handleRequest('POST', '/agent/sandboxes', {}, { agentId: 'a1' })).body;
        assert.strictEqual(box.container.running, false);
        const exec = await sandbox.handleRequest('POST', `/agent/sandboxes/${box.id}/exec`, {}, { command: 'echo hi' });
        assert.strictEqual(exec.status, 503);
        assert.match((await call('run_command', { command: 'echo hi' })).content[0].text, /Unknown tool|Nothing was run/);
    } finally {
        await cleanup();
    }
});

test('commands run in an isolated container on the staging copy', { skip: !dockerUp && 'Docker engine not reachable', timeout: 300000 }, async () => {
    const { project, sandbox, call, cleanup } = setup({ 'index.js': 'console.log(1 + 1);\n' });
    try {
        const run = async (command, agent = 'a1') => (await call('run_command', { command }, agent)).content[0].text;
        assert.match(await run('node index.js'), /Exit code: 0[\s\S]*2/);
        // Writes land in the staging copy, not the project.
        assert.match(await run('echo made > out.txt && pwd'), /\/workspace/);
        assert.ok(!fs.existsSync(path.join(project, 'out.txt')));
        assert.strictEqual((await call('read_file', { path: 'out.txt' })).content[0].text, 'made\n');
        // Locked down: no network, read-only root, nothing of the host.
        assert.match(await run('node -e "require(\'http\').get(\'http://example.com\',()=>process.exit(0)).on(\'error\',e=>{console.log(e.code);process.exit(3)})"'), /Exit code: 3/);
        assert.match(await run('touch /etc/x'), /Exit code: [1-9]/);
        assert.match(await run(`ls ${project}`), /Exit code: [1-9]/);
        assert.match(await run('cd .. && ls; cat /proc/1/cmdline | tr "\\0" " "'), /sleep infinity/);
        // A second agent on the same workspace gets its own container but sees the same files.
        assert.match(await run('cat out.txt', 'a2'), /made/);
        assert.strictEqual(sandbox.containers.list().length, 2);
        // Timeouts stop the command inside the container.
        const slow = await call('run_command', { command: 'sleep 30', timeout_seconds: 2 });
        assert.match(slow.content[0].text, /timed out/);
        const set = (await sandbox.handleRequest('GET', '/agent/changes')).body[0];
        assert.deepStrictEqual(set.files.map(f => f.path), ['out.txt']);
        await sandbox.handleRequest('POST', `/agent/changes/${set.id}/approve`, {}, {});
        assert.strictEqual(fs.readFileSync(path.join(project, 'out.txt'), 'utf8'), 'made\n');
        // Nothing left to review: the sandbox and its containers are gone.
        assert.strictEqual(sandbox.containers.list().length, 0);
    } finally {
        await cleanup();
    }
});

test('a pending review survives DELETE of its sandbox', async () => {
    const { project, sandbox, call, cleanup } = setup({ 'a.txt': 'one\n' });
    try {
        await call('write_file', { path: 'a.txt', content: 'two\n' });
        const set = (await sandbox.handleRequest('POST', '/agent/sandboxes/ws1/stage')).body;
        const del = await sandbox.handleRequest('DELETE', '/agent/sandboxes/ws1');
        assert.deepStrictEqual(del.body, { ok: true, keptForReview: true });
        assert.strictEqual(sandbox.containers.list().length, 0);
        assert.strictEqual((await sandbox.handleRequest('GET', '/agent/changes')).body[0].id, set.id);
        const r = await sandbox.handleRequest('POST', `/agent/changes/${set.id}/approve`, {}, {});
        assert.deepStrictEqual(r.body.written, ['a.txt']);
        assert.strictEqual(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'two\n');
        assert.strictEqual((await sandbox.handleRequest('GET', '/agent/sandboxes/ws1')).status, 404);
        // Nothing pending: DELETE discards straight away.
        await call('list_files', {}, 'a1', 'ws2');
        assert.strictEqual((await sandbox.handleRequest('DELETE', '/agent/sandboxes/ws2')).body.keptForReview, false);
    } finally {
        await cleanup();
    }
});
