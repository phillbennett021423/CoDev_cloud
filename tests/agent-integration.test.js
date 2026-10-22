// End-to-end check of CoDev's agent infrastructure on this computer: starts the
// real server.js on a free port with a throwaway project folder, then
//  1. drives the sandbox and its diff gate over HTTP (/agent-tools, /agent/*):
//     staged edits stay off disk, a syntax error blocks its file, paths can't
//     escape the project, approve writes only passing files, reject writes none;
//  2. with Docker: runs commands in the agent's container and checks the
//     container is gone once the sandbox is closed;
//  3. with Chromium: fires a sample coding prompt through the real page (the
//     model is scripted, so no API key is needed) and approves it in the review;
//  4. with the browser service: a headless browser verification task opens the
//     page the agent saved, fills it in, reads the result and takes a screenshot.
// Each part skips, saying why, when Docker, Chromium or a service is missing.
// Run: npm run test:agents (or node --test tests/agent-integration.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { launchBrowser, openPage, sendPrompt, waitForReview, waitForChat } = require('./helpers/page-driver');

const ROOT = path.join(__dirname, '..');
const SERVER_TIMEOUT_MS = 60000;

function run(cmd, args, timeout = 20000) {
    return new Promise(resolve => execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout).trim(), stderr: String(stderr).trim() })));
}

async function dockerAvailable() {
    const r = await run('docker', ['version', '--format', '{{.Server.Version}}']);
    return r.ok && r.stdout ? null : `Docker isn't running (${(r.stderr || 'docker not found').split('\n')[0]})`;
}

// server.js without its agent services (before the setup PR) can't be tested here.
function missingServer() {
    if (!fs.existsSync(path.join(ROOT, 'agent-services.js'))) return 'this checkout has no agent-services.js (server wiring not merged yet)';
    if (!fs.existsSync(path.join(ROOT, 'desktop', 'sandbox'))) return 'this checkout has no desktop/sandbox (sandbox service not merged yet)';
    return null;
}

function startServer(workspace, scratch) {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env, PORT: '0', CODEV_WORKSPACE: workspace, CODEV_DATA_DIR: path.join(scratch, 'data'),
            // The browser service keeps its vault in the user's config folder: use a throwaway one.
            XDG_CONFIG_HOME: path.join(scratch, 'config'), APPDATA: path.join(scratch, 'config')
        };
        const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, windowsHide: true });
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server.js didn't start:\n${output}`)); }, SERVER_TIMEOUT_MS);
        const onData = chunk => {
            output += chunk;
            const m = /running at (http:\/\/localhost:\d+)/.exec(output);
            if (m) { clearTimeout(timer); resolve({ child, url: m[1], output: () => output }); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`server.js exited with ${code}:\n${output}`)); });
    });
}

function stopServer(server) {
    return new Promise(resolve => {
        if (!server || server.child.exitCode !== null) return resolve();
        server.child.removeAllListeners('exit');
        server.child.on('exit', () => resolve());
        server.child.kill('SIGINT');
        setTimeout(() => { server.child.kill('SIGKILL'); resolve(); }, 15000).unref();
    });
}

// Calls the server the way CoDev's own page does (same Origin), or the route refuses.
function makeApi(base) {
    let id = 0;
    async function api(method, route, body) {
        const res = await fetch(base + route, {
            method,
            headers: { 'Content-Type': 'application/json', Origin: base },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        return { status: res.status, body: data };
    }
    async function rpc(method, params) {
        const r = await api('POST', '/agent-tools', { jsonrpc: '2.0', id: ++id, method, params });
        assert.equal(r.status, 200, `/agent-tools ${method}: ${JSON.stringify(r.body)}`);
        assert.ok(!r.body.error, `/agent-tools ${method}: ${JSON.stringify(r.body.error)}`);
        return r.body.result;
    }
    async function tool(name, args, agentId, sandboxId) {
        const result = await rpc('tools/call', { name, arguments: args, _meta: { 'codev/agent': agentId, 'codev/agentId': agentId, 'codev/workspace': sandboxId } });
        const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        return { ...result, text };
    }
    return { api, rpc, tool };
}

// The suite's shared state, set up once.
const ctx = { skip: null };

test.before(async () => {
    ctx.skip = missingServer();
    if (ctx.skip) return;
    ctx.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-agents-'));
    ctx.workspace = path.join(ctx.scratch, 'project');
    fs.mkdirSync(ctx.workspace);
    fs.writeFileSync(path.join(ctx.workspace, 'README.md'), '# Demo project\n');
    fs.writeFileSync(path.join(ctx.workspace, 'package.json'), '{ "name": "demo", "version": "1.0.0" }\n');
    ctx.dockerSkip = await dockerAvailable();
    ctx.server = await startServer(ctx.workspace, ctx.scratch);
    Object.assign(ctx, makeApi(ctx.server.url));
    const status = await ctx.api('GET', '/agent/status');
    assert.equal(status.status, 200, `GET /agent/status: ${JSON.stringify(status.body)}`);
    ctx.status = status.body;
    const sandbox = status.body.services && status.body.services.sandbox;
    if (sandbox && sandbox.available === false) ctx.skip = `the sandbox service is off: ${sandbox.detail}`;
    ctx.tools = (await ctx.rpc('tools/list', {})).tools.map(t => t.name);
});

test.after(async () => {
    await stopServer(ctx.server);
    if (ctx.scratch) fs.rmSync(ctx.scratch, { recursive: true, force: true });
});

test('status reports the workspace, Docker and the browser', t => {
    if (ctx.skip) return t.skip(ctx.skip);
    assert.equal(path.resolve(ctx.status.workspace), path.resolve(ctx.workspace));
    assert.equal(typeof ctx.status.docker.available, 'boolean');
    assert.equal(typeof ctx.status.browser.available, 'boolean');
    for (const name of ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'sandbox_diff', 'submit_changes']) {
        assert.ok(ctx.tools.includes(name), `agent tool ${name} is listed`);
    }
    t.diagnostic(`Docker: ${ctx.status.docker.available ? ctx.status.docker.version : ctx.status.docker.error}`);
    t.diagnostic(`Browser: ${ctx.status.browser.available ? 'available' : ctx.status.browser.error}`);
});

test('the diff gate keeps staged edits off disk until approved, and blocks bad files', async t => {
    if (ctx.skip) return t.skip(ctx.skip);
    const { api, tool } = ctx;
    const agent = 'architect';
    const created = await api('POST', '/agent/sandboxes', { agentId: agent, task: 'gate test', workspace: 'gate-test' });
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created.body));
    const sandboxId = created.body.id;

    assert.match((await tool('read_file', { path: 'README.md' }, agent, sandboxId)).text, /Demo project/);
    assert.equal((await tool('write_file', { path: 'src/math.js', content: 'module.exports.add = (a, b) => a + b;\n' }, agent, sandboxId)).isError, false);
    assert.equal((await tool('write_file', { path: 'src/bad.js', content: 'function oops( {\n' }, agent, sandboxId)).isError, false);
    assert.equal((await tool('edit_file', { path: 'README.md', old_text: '# Demo project', new_text: '# Demo project\n\nAdds math.' }, agent, sandboxId)).isError, false);
    const escape = await tool('write_file', { path: '../escaped.txt', content: 'nope' }, agent, sandboxId);
    assert.equal(escape.isError, true, 'a path outside the project is refused');
    assert.equal(fs.existsSync(path.join(ctx.scratch, 'escaped.txt')), false);

    // Nothing has reached the real project yet.
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'src')), false);
    assert.equal(fs.readFileSync(path.join(ctx.workspace, 'README.md'), 'utf8'), '# Demo project\n');

    await tool('submit_changes', { summary: 'math helper' }, agent, sandboxId);
    const staged = await api('POST', `/agent/sandboxes/${sandboxId}/stage`, {});
    assert.equal(staged.status, 200);
    const set = staged.body;
    const byPath = Object.fromEntries(set.files.map(f => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ['README.md', 'src/bad.js', 'src/math.js']);
    assert.match(byPath['src/math.js'].diff, /^\+module\.exports\.add/m);
    assert.ok(byPath['src/bad.js'].checks.some(c => c.ok === false), 'syntax check fails for bad.js');
    assert.ok(byPath['src/math.js'].checks.every(c => c.ok), 'math.js passes');
    assert.equal(set.submission && set.submission.summary, 'math helper');

    // The pending list shows it; approving with no paths writes every passing file.
    const pending = await api('GET', '/agent/changes');
    assert.ok(pending.body.some(s => s.id === set.id));
    const approved = await api('POST', `/agent/changes/${set.id}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(approved.body.written.sort(), ['README.md', 'src/math.js']);
    assert.equal(fs.readFileSync(path.join(ctx.workspace, 'src', 'math.js'), 'utf8'), 'module.exports.add = (a, b) => a + b;\n');
    assert.match(fs.readFileSync(path.join(ctx.workspace, 'README.md'), 'utf8'), /Adds math\./);
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'src', 'bad.js')), false, 'blocked file never written');
    // Asking to approve the blocked file explicitly is refused too.
    const again = await api('GET', `/agent/changes/${set.id}`);
    assert.notEqual(again.body.status, 'pending');
    await api('DELETE', `/agent/sandboxes/${sandboxId}?discard=1`);
});

test('a rejected change set writes nothing', async t => {
    if (ctx.skip) return t.skip(ctx.skip);
    const { api, tool } = ctx;
    const created = await api('POST', '/agent/sandboxes', { agentId: 'swarm', workspace: 'reject-test' });
    const sandboxId = created.body.id;
    await tool('write_file', { path: 'rejected.txt', content: 'should never land' }, 'swarm', sandboxId);
    await tool('delete_file', { path: 'package.json' }, 'swarm', sandboxId);
    const set = (await api('POST', `/agent/sandboxes/${sandboxId}/stage`, {})).body;
    assert.equal(set.files.length, 2);
    const rejected = await api('POST', `/agent/changes/${set.id}/reject`, { reason: 'test' });
    assert.equal(rejected.status, 200);
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'rejected.txt')), false);
    assert.ok(fs.existsSync(path.join(ctx.workspace, 'package.json')), 'staged delete not applied');
    assert.equal((await api('POST', `/agent/changes/${set.id}/approve`, {})).status, 409, 'a decided change set cannot be approved');
    await api('DELETE', `/agent/sandboxes/${sandboxId}?discard=1`);
});

test('agents run code in their own ephemeral Docker container', async t => {
    if (ctx.skip) return t.skip(ctx.skip);
    if (ctx.dockerSkip) return t.skip(ctx.dockerSkip);
    const { api, tool } = ctx;
    const created = await api('POST', '/agent/sandboxes', { agentId: 'healer', workspace: 'docker-test' });
    assert.ok(created.body.container ? created.body.container.running !== false : true, `container: ${JSON.stringify(created.body.container)}`);
    const sandboxId = created.body.id;
    assert.ok(ctx.tools.includes('run_command'), 'run_command is offered when Docker is up');

    const host = await tool('run_command', { command: 'cat /etc/hostname && pwd && ls' }, 'healer', sandboxId);
    assert.equal(host.isError, false, host.text);
    const [containerId] = /^[0-9a-f]{12}/m.exec(host.text.split('--- stdout ---')[1] || '') || [];
    assert.ok(containerId, `container hostname in: ${host.text}`);
    assert.match(host.text, /\/workspace/);
    assert.match(host.text, /README\.md/, 'the container sees the staging copy');

    const inspect = await run('docker', ['inspect', '--format', '{{.State.Running}}', containerId]);
    assert.equal(inspect.stdout, 'true', 'the agent container is running');

    // A file made inside the container is a staged change like any other.
    await tool('run_command', { command: 'echo built-in-container > build.txt' }, 'healer', sandboxId);
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'build.txt')), false);
    const set = (await api('POST', `/agent/sandboxes/${sandboxId}/stage`, {})).body;
    assert.deepEqual(set.files.map(f => f.path), ['build.txt']);
    await api('POST', `/agent/changes/${set.id}/approve`, {});
    assert.equal(fs.readFileSync(path.join(ctx.workspace, 'build.txt'), 'utf8').trim(), 'built-in-container');

    await api('DELETE', `/agent/sandboxes/${sandboxId}`);
    // Containers go away with their sandbox (allow docker a moment).
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
        gone = !(await run('docker', ['inspect', containerId])).ok;
        if (!gone) await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(gone, `container ${containerId} was removed`);
});

test('a coding prompt through the page is staged, reviewed and saved', async t => {
    if (ctx.skip) return t.skip(ctx.skip);
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const canRun = ctx.tools.includes('run_command');
    const steps = [
        [{ name: 'list_files' }],
        [
            { name: 'write_file', arguments: { path: 'site/index.html', content: GREETER_HTML } },
            { name: 'write_file', arguments: { path: 'site/greet.js', content: GREETER_JS } },
            { name: 'write_file', arguments: { path: 'site/typo.js', content: 'const = 1;\n' } }
        ],
        ...(canRun ? [[{ name: 'run_command', arguments: { command: 'ls site' } }]] : []),
        [{ name: 'sandbox_diff' }, { name: 'submit_changes', arguments: { summary: 'Greeter page' } }],
        'Built the greeter page in site/.'
    ];
    const { page, errors } = await openPage(launched.browser, ctx.server.url, { steps });
    await sendPrompt(page, 'Build a small greeter page in site/ that says hello to the name typed in');
    const rows = await waitForReview(page, 120000);
    const byPath = Object.fromEntries(rows.map(r => [r.path, r]));
    assert.ok(byPath['site/index.html'] && byPath['site/greet.js'], JSON.stringify(rows));
    assert.equal(byPath['site/typo.js'].blocked, true, 'the syntax error is blocked in the review');
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'site')), false, 'nothing on disk before approval');

    await page.click('#diffReviewOverlay [data-action="approve"]');
    await waitForChat(page, /Saved 2 files/, 60000);
    assert.equal(fs.readFileSync(path.join(ctx.workspace, 'site', 'greet.js'), 'utf8'), GREETER_JS);
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'site', 'typo.js')), false);
    assert.deepEqual(errors, []);
    ctx.greeterSaved = true;
});

test('a headless browser verification task checks the saved page', async t => {
    if (ctx.skip) return t.skip(ctx.skip);
    if (!ctx.status.browser.available) return t.skip(`browser service unavailable: ${ctx.status.browser.error || 'not installed'}`);
    if (!ctx.tools.includes('browser_navigate')) return t.skip('no browser tools are listed');
    // Without the page test (no Chromium for Playwright), put the files there directly.
    if (!ctx.greeterSaved) {
        fs.mkdirSync(path.join(ctx.workspace, 'site'), { recursive: true });
        fs.writeFileSync(path.join(ctx.workspace, 'site', 'index.html'), GREETER_HTML);
        fs.writeFileSync(path.join(ctx.workspace, 'site', 'greet.js'), GREETER_JS);
    }
    // The browser refuses file://, so the project is served over HTTP.
    const site = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'site/index.html';
        const file = path.join(ctx.workspace, rel);
        if (!file.startsWith(ctx.workspace) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
        res.end(fs.readFileSync(file));
    });
    await new Promise(r => site.listen(0, '127.0.0.1', r));
    t.after(() => site.close());
    const url = `http://127.0.0.1:${site.address().port}/site/index.html`;

    const { tool } = ctx;
    const agent = 'verifier';
    try {
        const nav = await tool('browser_navigate', { url }, agent);
        assert.equal(nav.isError, false, nav.text);
        assert.equal((await tool('browser_fill', { selector: '#name', value: 'Ada' }, agent)).isError, false);
        assert.equal((await tool('browser_click', { selector: '#go' }, agent)).isError, false);
        await tool('browser_wait_for', { text: 'Hello, Ada!' }, agent);
        const text = await tool('browser_get_text', { selector: '#out', mode: 'text' }, agent);
        assert.match(text.text, /Hello, Ada!/);
        const shot = await tool('browser_screenshot', {}, agent);
        const image = (shot.content || []).find(c => c.type === 'image');
        assert.ok(image, `screenshot content: ${JSON.stringify(shot.content).slice(0, 200)}`);
        assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
    } finally {
        await tool('browser_close', {}, agent).catch(() => {});
    }
});

const GREETER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Greeter</title></head>
<body>
  <input id="name" placeholder="Your name">
  <button id="go">Greet</button>
  <p id="out"></p>
  <script src="greet.js"></script>
</body></html>
`;
const GREETER_JS = `document.getElementById('go').addEventListener('click', () => {
  const name = document.getElementById('name').value.trim() || 'world';
  document.getElementById('out').textContent = \`Hello, \${name}!\`;
});
`;
