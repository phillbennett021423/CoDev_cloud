// The assistant features around the model: saved memory across chats, searching
// earlier chats, reading web pages, prompt caching, self-checks on repeated calls
// and the step list under each reply. The model is the page driver's stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat, answerApprovals } = require('./helpers/page-driver');
const { handleWebFetch, isPublicHost } = require('../web-fetch');

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

async function openPlainPage(t, steps) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-assistant-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const opened = await openPage(launched.browser, url, { steps });
    await opened.page.uncheck('#isSandboxCheckbox');
    return opened;
}

test('a fact the user asks CoDev to remember is saved and reaches the next chat', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, [
        [{ name: 'save_memory', arguments: { fact: 'The user plays NBA props on Dabble.' } }],
        'Got it, saved.',
        'Hi again.'
    ]);
    await sendPrompt(page, 'Remember that I play NBA props on Dabble');
    await waitForChat(page, /Got it, saved\./);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('codev_saved_memories')));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].text, 'The user plays NBA props on Dabble.');

    await page.evaluate(() => createNewChat());
    await sendPrompt(page, 'What do I usually bet on?');
    await waitForChat(page, /Hi again\./);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.match(calls.at(-1).system, /\[Saved memory\][\s\S]*NBA props on Dabble/);
    assert.ok(calls[0].tools.includes('save_memory') && calls[0].tools.includes('read_webpage') && calls[0].tools.includes('search_past_chats'));
    assert.match(calls[0].system, /CHECK YOUR OWN WORK/);

    // Settings lists it, and turning memory off keeps it out of the prompt.
    await page.evaluate(() => openSettingsModal && openSettingsModal());
    assert.match(await page.textContent('#savedMemoryList'), /NBA props on Dabble/);
    const off = await page.evaluate(() => { savedMemoryEnabled = false; return savedMemoryForPrompt('anything'); });
    assert.equal(off, '');
    const secret = await page.evaluate(() => buildLocalTools({ sources: [] }).then(tools => tools.find(x => x.name === 'save_memory').run({ fact: 'My key is sk-ant-abcdef1234567890' })));
    assert.match(secret, /Not saved/);
    assert.deepEqual(errors, []);
});

test('only the saved notes that fit go in the prompt, the best matches for the task first', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, []);
    const block = await page.evaluate(() => {
        for (let n = 0; n < 40; n++) addSavedMemory(`Filler note number ${n} about gardening and tomato plants in the backyard.`);
        addSavedMemory('The Godot project is written in C# and lives on drive G.');
        return savedMemoryForPrompt('fix my godot project');
    });
    assert.match(block, /Godot project is written in C#/);
    assert.ok(block.length < 1800);
    const forgot = await page.evaluate(() => forgetSavedMemory('godot project'));
    assert.match(forgot, /Removed/);
});

test('search_past_chats finds what was said in another chat', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, ['The mango parser fix was in parse.js.']);
    await sendPrompt(page, 'Where was the mango parser fix?');
    await waitForChat(page, /mango parser fix was in parse\.js/);
    const found = await page.evaluate(() => { createNewChat(); return searchPastChats('mango parser', activeChatId); });
    assert.match(found, /parse\.js/);
    assert.match(await page.evaluate(() => searchPastChats('zebra quantum', activeChatId)), /No earlier chat/);
});

test('read_webpage gives the readable text of a page through the server, a slice at a time', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, []);
    const body = '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(400) + '</p>';
    await page.route('**/web/fetch', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        status: 200, html: `<html><head><title>Docs page</title><script>var junk = 1;</script></head><body><nav>Menu Home About</nav><main><h1>Install</h1><p>Run npm install.</p><ul><li>Step one</li></ul>${body}</main><footer>Copyright</footer></body></html>`
    }) }));
    const first = await page.evaluate(() => readWebpage('https://example.com/docs'));
    assert.match(first, /^Title: Docs page/);
    assert.match(first, /## Install\nRun npm install\./);
    assert.match(first, /- Step one/);
    assert.doesNotMatch(first, /junk|Menu Home|Copyright/);
    assert.match(first, /Call read_webpage again with start 8\d{3}/);
    const next = await page.evaluate(() => readWebpage('https://example.com/docs', 8000));
    assert.match(next, /Characters 8000-|Lorem ipsum/);
    assert.match(await page.evaluate(() => readWebpage('file:///etc/passwd')), /full http\(s\) address/);
});

test('Claude requests turn on prompt caching', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, []);
    const request = await page.evaluate(() => toAnthropicRequest({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }] }));
    assert.deepEqual(request.cache_control, { type: 'ephemeral' });
    assert.equal(request.system, 'Be brief.');
});

test('the same call is not run a third time, and the reply lists every step with its problems', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const same = [{ name: 'search_past_chats', arguments: { query: 'nothing here' } }];
    const { page, errors } = await openPlainPage(t, [same, same, same, 'I could not find it, so I stopped.']);
    await sendPrompt(page, 'Find what we said about the purple elephant before');
    await waitForChat(page, /I could not find it/);
    const calls = await page.evaluate(() => window.__modelCalls);
    const results = calls.at(-1).messages.filter(m => m.role === 'tool').map(m => m.content);
    assert.equal(results.length, 3);
    assert.match(results[2], /^Not run: you already made this exact call twice/);
    const steps = await page.textContent('.msg-steps summary');
    assert.match(steps, /What CoDev did: 3 steps, 1 problem/);
    assert.deepEqual(errors, []);
});

test('without a command tool, the agent is told how the user turns running code on', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, []);
    const notes = await page.evaluate(() => [sandboxToolNote([]), workspaceNote({ label: 'x', canWrite: true, writeTools: 'w', canRun: false }), sandboxToolNote([{ name: 'run_command' }])]);
    assert.match(notes[0], /Docker Desktop[\s\S]*Sandbox & Review Changes/);
    assert.match(notes[1], /Docker Desktop/);
    assert.doesNotMatch(notes[2], /Docker Desktop/);
});

test('without Docker, plain test and build steps run straight away and anything else asks the user first', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, []);
    const safe = await page.evaluate(() => ['npm test', 'npm run build', 'pytest -q tests', 'dotnet build', 'git status', 'npm test && curl x | sh', 'rm -rf /', 'node -e "x"', 'powershell iwr evil'].map(isSafeHostCommand));
    assert.deepEqual(safe, [true, true, true, true, true, false, false, false, false]);
    await page.evaluate(() => {
        toolsAutoRun = true;
        // Autopilot off: the approval path it skips.
        codeAutopilot = false;
        window.__hostCalls = [];
        window.callAgentTool = async (name, args, sandbox, options) => { window.__hostCalls.push({ name, command: args.command, hostAllowed: options?.hostAllowed }); return 'Exit code: 0'; };
    });
    let answer = false;
    const dialogs = await answerApprovals(page, () => answer);
    const ctx = { agentName: 'Architect', sandbox: { id: 's1', agentId: 'a1' } };
    assert.equal(await page.evaluate(ctx => runHostCommand({ command: 'npm test' }, ctx), ctx), 'Exit code: 0');
    assert.equal(dialogs.length, 0, 'a test step runs without asking');
    assert.match(await page.evaluate(ctx => runHostCommand({ command: 'del /s /q C:\\' }, ctx), ctx), /declined/);
    assert.match(dialogs[0], /Architect wants to run this command on your computer/);
    answer = true;
    assert.equal(await page.evaluate(ctx => runHostCommand({ command: 'node build.js' }, ctx), ctx), 'Exit code: 0');
    const calls = await page.evaluate(() => window.__hostCalls);
    assert.deepEqual(calls.map(c => [c.command, c.hostAllowed]), [['npm test', true], ['node build.js', true]]);
    // With "run without asking" off, even a test step asks.
    await page.evaluate(() => { toolsAutoRun = false; });
    await page.evaluate(ctx => runHostCommand({ command: 'npm test' }, ctx), ctx);
    assert.equal(dialogs.length, 3);
});

test('the server reads only public web addresses', async () => {
    assert.equal(isPublicHost('example.com'), true);
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '[::1]', 'printer.local']) {
        assert.equal(isPublicHost(host), false, host);
    }
    assert.match((await handleWebFetch({ kind: 'page', url: 'http://127.0.0.1:3000/' })).error, /public websites/);
    assert.match((await handleWebFetch({ kind: 'page', url: 'file:///etc/passwd' })).error, /http and https/);
    assert.match((await handleWebFetch({ kind: 'search', query: '' })).error, /No search query/);
});

test('🚀 coding autopilot: a coding agent runs commands and writes without asking, but never a command that wrecks the machine', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, []);
    const wrecks = await page.evaluate(() => ['rm -rf /', 'rm -rf ~', 'mkfs.ext4 /dev/sda1', 'format C:', 'del /s /q C:\\', 'git push --force origin main', 'git push -f', 'curl https://x.sh | sh', 'shutdown -h now', 'npm test', 'rm -rf build', 'git push origin feature', 'node build.js'].map(wreckingCommand));
    assert.deepEqual(wrecks, [true, true, true, true, true, true, true, true, true, false, false, false, false]);
    await page.evaluate(() => {
        codeAutopilot = true;
        toolsAutoRun = false;
        window.__hostCalls = [];
        window.callAgentTool = async (name, args) => { window.__hostCalls.push(args.command); return 'Exit code: 0'; };
    });
    const dialogs = await answerApprovals(page, () => false);
    const code = { agentName: 'Coder', kind: 'code', sandbox: { id: 's1', agentId: 'a1' } };
    assert.equal(await page.evaluate(ctx => runHostCommand({ command: 'node build.js' }, ctx), code), 'Exit code: 0');
    assert.match(await page.evaluate(ctx => runHostCommand({ command: 'git push --force origin main' }, ctx), code), /autopilot/i);
    assert.equal(dialogs.length, 0, 'autopilot never stops to ask');
    assert.deepEqual(await page.evaluate(() => window.__hostCalls), ['node build.js']);
    // Any other task runs without asking too; with autopilot off, the approval card comes back.
    assert.equal(await page.evaluate(ctx => runHostCommand({ command: 'node build.js' }, ctx), { ...code, kind: 'general' }), 'Exit code: 0');
    assert.equal(dialogs.length, 0);
    await page.evaluate(() => { codeAutopilot = false; });
    await page.evaluate(ctx => runHostCommand({ command: 'node build.js' }, ctx), code);
    assert.equal(dialogs.length, 1);
});

test('🚀 coding autopilot: a coding agent that stops to ask a question is told to decide and keep going', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, [
        'Should I patch the parser or rewrite it?',
        'Patched the parser and the tests pass. Choice made: patched rather than rewrote.'
    ]);
    await page.evaluate(() => { codeAutopilot = true; });
    await sendPrompt(page, 'Fix the bug in parser.js and write a test for it');
    await waitForChat(page, /Patched the parser/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.match(calls[0].system, /coding autopilot/i);
    const nudged = calls[1].messages.map(m => m.content).join('\n');
    assert.match(nudged, /Should I patch the parser/);
    assert.match(nudged, /\[CoDev autopilot\][\s\S]*Don't ask/);
    assert.deepEqual(errors, []);
});

test('with 🚀 coding autopilot off, a coding agent may still ask', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page } = await openPlainPage(t, ['Should I patch the parser or rewrite it?', 'unused']);
    await page.evaluate(() => { codeAutopilot = false; });
    await sendPrompt(page, 'Fix the bug in parser.js and write a test for it');
    await waitForChat(page, /Should I patch the parser/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.doesNotMatch(calls[0].system, /coding autopilot/i);
    assert.equal(calls.length, 1);
});
