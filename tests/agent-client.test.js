// Unit tests for mobile/www/agent-ui/agent-client.js: the diff parser, the review
// model, the transports and the per-task sandbox dispatch. No server needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const AgentClient = require('../mobile/www/agent-ui/agent-client.js');

const DIFF = [
    'diff --git a/src/app.js b/src/app.js',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -1,3 +1,4 @@ function main',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' module.exports = { a };',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    '\\ No newline at end of file',
    'diff --git a/gone.md b/gone.md',
    'deleted file mode 100644',
    '--- a/gone.md',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-# Gone',
    '--- not a header, a deleted line',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    ''
].join('\n');

test('parseUnifiedDiff reads files, statuses, hunks and line numbers', () => {
    const files = AgentClient.parseUnifiedDiff(DIFF);
    assert.deepEqual(files.map(f => [f.path, f.status, f.additions, f.deletions, f.binary]), [
        ['src/app.js', 'modified', 2, 1, false],
        ['new.txt', 'added', 1, 0, false],
        ['gone.md', 'deleted', 0, 2, false],
        ['logo.png', 'modified', 0, 0, true]
    ]);
    const lines = files[0].hunks[0].lines;
    assert.equal(files[0].hunks[0].context, 'function main');
    assert.deepEqual(lines.map(l => [l.type, l.oldNo, l.newNo]), [
        ['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['add', null, 3], ['ctx', 3, 4]
    ]);
    assert.equal(files[1].hunks[0].lines[1].type, 'meta');
    assert.equal(files[2].hunks[0].lines[1].text, '-- not a header, a deleted line');
});

test('buildReviewModel blocks files whose checks failed, not skipped ones', () => {
    const model = AgentClient.buildReviewModel({
        id: 'cs1', agentId: 'architect', submission: { agent: 'architect', summary: 'Did things' },
        diff: DIFF,
        files: [
            { path: 'src/app.js', status: 'modified', checks: [{ name: 'syntax', ok: true }] },
            { path: 'new.txt', status: 'added', checks: [{ name: 'syntax', ok: true, skipped: true }] },
            { path: 'gone.md', status: 'deleted', additions: 0, deletions: 2, checks: [{ name: 'syntax', ok: false, message: 'Unexpected token' }] }
        ]
    });
    assert.deepEqual(model.approvable, ['src/app.js', 'new.txt']);
    assert.equal(model.files[2].blocked, true);
    assert.match(model.files[2].blockedReason, /syntax: Unexpected token/);
    assert.equal(model.files[0].hunks.length, 1, 'per-file hunks found in the whole diff');
    assert.deepEqual(model.totals, { files: 3, additions: 3, deletions: 3, blocked: 1 });
    assert.equal(model.summary, 'Did things');
});

test('buildReviewModel falls back to the whole diff when files are missing', () => {
    const model = AgentClient.buildReviewModel({ id: 'x', diff: DIFF });
    assert.equal(model.files.length, 4);
    assert.equal(model.approvable.length, 4);
});

test('describeReviewOutcome covers every decision', () => {
    const d = AgentClient.describeReviewOutcome;
    assert.match(d({ decision: 'approved', result: { written: ['a.js'], skipped: [{ path: 'b.js', reason: 'checks failed' }] }, left: ['b.js'] }),
        /Saved 1 file to your project: a\.js\. Skipped: b\.js \(checks failed\)\. 1 file is still waiting/);
    assert.match(d({ decision: 'rejected' }), /Nothing was written/);
    assert.match(d({ decision: 'deferred' }), /kept for review later/);
});

function fakeFetch(routes) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
        const key = `${init.method} ${new URL(url).pathname}`;
        const [status, payload] = routes[key] || [404, { error: 'nope' }];
        return { status, text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) };
    };
    return { fetch, calls };
}

test('httpTransport sends JSON and turns error bodies into messages', async () => {
    const { fetch, calls } = fakeFetch({
        'GET /agent/status': [200, { workspace: '/p' }],
        'POST /agent/changes/c1/approve': [409, { error: 'This change set was already approved.' }],
        'POST /agent-tools': [200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read_file' }] } }]
    });
    const client = AgentClient.createAgentClient({ transport: AgentClient.httpTransport({ baseUrl: 'http://localhost:3000', fetch }) });
    assert.deepEqual(await client.status(), { workspace: '/p' });
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    await assert.rejects(client.approve('c1'), err => err.status === 409 && /already approved/.test(err.message));
    await assert.rejects(client.listChanges(), /nope/);
    assert.deepEqual((await client.listTools()).map(t => t.name), ['read_file']);
});

test('callTool puts the agent and sandbox in _meta under both names', async () => {
    const sent = [];
    const transport = { kind: 'test', request: async () => ({ status: 200, body: {} }), rpc: async msg => { sent.push(msg); return { jsonrpc: '2.0', id: msg.id, result: { content: [] } }; } };
    const client = AgentClient.createAgentClient({ transport });
    await client.callTool('write_file', { path: 'a' }, { agentId: 'arch', sandboxId: 'task-1' });
    assert.equal(sent[0].method, 'initialize');
    assert.deepEqual(sent[1].params, { name: 'write_file', arguments: { path: 'a' }, _meta: { 'codev/agent': 'arch', 'codev/agentId': 'arch', 'codev/workspace': 'task-1' } });
});

test('detectTransport picks the Windows bridge, then localhost, else nothing', () => {
    const bridge = { agentRequest() {}, sandboxMcp() {} };
    assert.equal(AgentClient.detectTransport({ codevDesktop: bridge }).kind, 'desktop');
    assert.equal(AgentClient.detectTransport({ location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:3000' }, fetch() {} }).kind, 'http');
    assert.equal(AgentClient.detectTransport({ location: { protocol: 'https:', hostname: 'example.com', origin: 'https://example.com' }, fetch() {} }), null);
    assert.equal(AgentClient.detectTransport({ Capacitor: { isNativePlatform: () => true }, location: { protocol: 'http:', hostname: 'localhost' }, fetch() {} }), null);
});

test('sandbox dispatch shares one workspace key, stages the last sandbox and disposes each id once', async () => {
    const made = [];
    const destroyed = [];
    const client = {
        createSandbox: async ({ agentId, workspace }) => { made.push({ agentId, workspace }); return { id: workspace, agentId }; },
        stage: async id => ({ id: 'cs', sandboxId: id, files: [] }),
        destroySandbox: async id => {
            destroyed.push(id);
            if (destroyed.length > 1) throw Object.assign(new Error('gone'), { status: 404 });
            return { ok: true };
        }
    };
    const dispatch = AgentClient.createSandboxDispatch(client, { task: 't', workspaceKey: 'task-abc' });
    await Promise.all([dispatch.sandboxFor({ id: 'a' }), dispatch.sandboxFor({ id: 'a' })]);
    await dispatch.sandboxFor({ id: 'b' });
    assert.deepEqual(made, [{ agentId: 'a', workspace: 'task-abc' }, { agentId: 'b', workspace: 'task-abc' }]);
    assert.equal((await dispatch.stage()).sandboxId, 'task-abc');
    assert.deepEqual(await dispatch.dispose(), []);
    assert.deepEqual(destroyed, ['task-abc']);
});

test('a sandbox that fails to start can be retried', async () => {
    let attempts = 0;
    const client = { createSandbox: async () => { if (++attempts === 1) throw new Error('docker busy'); return { id: 'ok' }; } };
    const dispatch = AgentClient.createSandboxDispatch(client);
    await assert.rejects(dispatch.sandboxFor({ id: 'a' }), /docker busy/);
    assert.equal((await dispatch.sandboxFor({ id: 'a' })).id, 'ok');
});
