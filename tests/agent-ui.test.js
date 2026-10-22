// The page's sandbox dispatch and diff review, end to end in headless Chromium
// against tests/fixtures/mock-agent-backend.js (no Docker needed). Skips when
// Playwright or Chromium is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForReview, waitForChat } = require('./helpers/page-driver');

const CODING_STEPS = [
    [{ name: 'list_files' }, { name: 'read_file', arguments: { path: 'README.md' } }],
    [
        { name: 'write_file', arguments: { path: 'src/greet.js', content: 'function greet(name) {\n  return `Hello, ${name}!`;\n}\nmodule.exports = { greet };\n' } },
        { name: 'write_file', arguments: { path: 'src/broken.js', content: 'function broken( {\n  return 1;\n}\n' } },
        { name: 'edit_file', arguments: { path: 'README.md', old_text: '# Demo', new_text: '# Demo\n\nNow with greetings.' } }
    ],
    [{ name: 'submit_changes', arguments: { summary: 'Added greet() and documented it.' } }],
    'Added src/greet.js and updated the README.'
];

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-ui-'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
    return dir;
}

test('a prompt runs in the sandbox and only approved, passing files reach disk', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: CODING_STEPS });

    await sendPrompt(page, 'Add a greet(name) helper in src/greet.js and mention it in the README');
    const rows = await waitForReview(page);

    // The agent's tools came from the sandbox, with direct-disk tools hidden.
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(calls[0].tools.includes('write_file'), 'sandbox write_file offered');
    assert.ok(!calls[0].tools.includes('write_workspace_file'), 'direct-disk write tool hidden');
    assert.match(calls[0].system, /\[Sandbox\]/);
    // Every tool call carried the agent and its sandbox.
    assert.ok(backend.log.length >= 5);
    assert.ok(backend.log.every(entry => entry.agentId && entry.workspace), 'tool calls carry codev/agent and codev/workspace');

    // Nothing is on disk before approval.
    assert.equal(fs.existsSync(path.join(workspace, 'src', 'greet.js')), false);
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), '# Demo\n');

    const byPath = Object.fromEntries(rows.map(r => [r.path, r]));
    assert.deepEqual(Object.keys(byPath).sort(), ['README.md', 'src/broken.js', 'src/greet.js']);
    assert.equal(byPath['src/broken.js'].blocked, true, 'syntax error blocks the file');
    assert.equal(byPath['src/broken.js'].disabled, true);
    assert.equal(byPath['src/greet.js'].checked, true);
    assert.match(await page.textContent('#diffReviewOverlay'), /Added greet\(\) and documented it\./);
    assert.match(await page.textContent('#diffReviewOverlay .cdr-diff[data-path="src/greet.js"]'), /return `Hello, \$\{name\}!`;/);

    await page.click('#diffReviewOverlay [data-action="approve"]');
    await waitForChat(page, /Saved 2 files/);
    assert.equal(await page.$('#diffReviewOverlay'), null, 'review closed');

    assert.match(fs.readFileSync(path.join(workspace, 'src', 'greet.js'), 'utf8'), /function greet/);
    assert.match(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), /Now with greetings/);
    assert.equal(fs.existsSync(path.join(workspace, 'src', 'broken.js')), false, 'blocked file never written');
    assert.deepEqual(errors, []);
});

test('rejecting the review writes nothing', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, {
        steps: [[{ name: 'write_file', arguments: { path: 'notes.json', content: '{"ok": true}\n' } }], 'Wrote notes.json.']
    });
    await sendPrompt(page, 'Create notes.json');
    await waitForReview(page);
    await page.click('#diffReviewOverlay [data-action="reject"]');
    await waitForChat(page, /You rejected these changes/);
    assert.equal(fs.existsSync(path.join(workspace, 'notes.json')), false);
    assert.equal([...backend.changesets.values()][0].status, 'rejected');
});

test('a review kept for later is approvable from the header button', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, {
        steps: [[{ name: 'write_file', arguments: { path: 'later.js', content: 'module.exports = 42;\n' } }], 'Wrote later.js.']
    });
    await sendPrompt(page, 'Create later.js');
    await waitForReview(page);
    await page.click('#diffReviewOverlay [data-action="defer"]');
    await waitForChat(page, /kept for review later/);
    assert.equal(fs.existsSync(path.join(workspace, 'later.js')), false);

    await page.waitForSelector('#pendingChangesBtn', { state: 'visible' });
    assert.match(await page.textContent('#pendingChangesBtn'), /\(1\)/);
    await page.click('#pendingChangesBtn');
    await waitForReview(page);
    await page.click('#diffReviewOverlay [data-action="approve"]');
    await page.waitForSelector('#pendingChangesBtn', { state: 'hidden' });
    assert.equal(fs.readFileSync(path.join(workspace, 'later.js'), 'utf8'), 'module.exports = 42;\n');
});

test('with the sandbox off, the page keeps its direct tools', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, { steps: ['Nothing to change.'] });
    await page.uncheck('#isSandboxCheckbox');
    await sendPrompt(page, 'Say hello');
    await waitForChat(page, /Nothing to change\./);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(!calls[0].system.includes('[Sandbox]'));
    assert.equal(backend.log.length, 0, 'no sandbox tool calls');
    assert.equal(backend.sandboxes.size, 0, 'no sandbox created');
    // The page's own folder tools never take in or write files that can hold keys.
    const secret = await page.evaluate(async () => ({
        paths: ['.env', 'config/production.env', '.github/ci.yml', 'certs/server.key', 'secrets.json', 'credentials.yaml'].map(normalizeWorkspacePath),
        loaded: ['.env.js', 'secrets.json', 'app.js'].map(isProjectFileName),
        write: await writeWorkspaceFile('.env', 'KEY=x')
    }));
    assert.deepEqual(secret.paths, ['', '', '', '', '', '']);
    assert.deepEqual(secret.loaded, [false, false, true]);
    assert.match(secret.write, /Use a file path/);
});

test('in sandbox mode, MCP servers that write or run on this computer are kept out of the review bypass', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const helperTool = (name, readOnly) => ({ name, qualifiedName: `helper__${name}`, server: 'helper', description: `helper ${name}`,
        inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: readOnly } });
    const backend = createMockBackend({ workspace, hubTools: [helperTool('write_file', false), helperTool('run_command', false), helperTool('lookup', true), helperTool('deploy', false)] });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, {
        mcpServers: { helper: { url: 'http://127.0.0.1:8787/mcp', type: 'http' } },
        steps: [[{ name: 'helper__lookup' }], [{ name: 'helper__deploy' }], 'Done looking.']
    });
    // Turn "run without asking" on to show the sandbox asks anyway; decline the dialog.
    await page.evaluate(() => { toolsAutoRun = true; });
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    await sendPrompt(page, 'Look something up');
    await waitForChat(page, /Done looking\./);
    const offered = (await page.evaluate(() => window.__modelCalls))[0].tools;
    assert.ok(offered.includes('helper__lookup') && offered.includes('helper__deploy'), offered.join(', '));
    assert.ok(!offered.includes('helper__write_file') && !offered.includes('helper__run_command'), 'host write/run tools hidden');
    assert.deepEqual(backend.hubCalls.map(c => c.name), ['lookup'], 'read-only tool ran; declined tool did not');
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /helper__deploy[\s\S]*outside the sandbox/);
});
