// The assistant features around the model: saved memory across chats, searching
// earlier chats, reading web pages, prompt caching, self-checks on repeated calls
// and the step list under each reply. The model is the page driver's stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');
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

test('the server reads only public web addresses', async () => {
    assert.equal(isPublicHost('example.com'), true);
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '[::1]', 'printer.local']) {
        assert.equal(isPublicHost(host), false, host);
    }
    assert.match((await handleWebFetch({ kind: 'page', url: 'http://127.0.0.1:3000/' })).error, /public websites/);
    assert.match((await handleWebFetch({ kind: 'page', url: 'file:///etc/passwd' })).error, /http and https/);
    assert.match((await handleWebFetch({ kind: 'search', query: '' })).error, /No search query/);
});
