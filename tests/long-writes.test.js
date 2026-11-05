// Long file writes: a write_file call cut off at the reply's length limit isn't run
// (its content is missing), the agent gets more room and is told to send the file in
// parts with append, and a call that already failed isn't sent again unchanged.
// Anthropic is stubbed, so no key is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, sendPrompt, waitForChat } = require('./helpers/page-driver');

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

const usage = { input_tokens: 100, output_tokens: 100 };

// The page with Anthropic as the provider and the sandbox on. reply(body, n) answers the nth request.
async function openClaudePage(t, reply) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-long-'));
    fs.writeFileSync(path.join(workspace, 'bible.md'), '# Bible\n\n[TO FILL]\n');
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => {
        localStorage.setItem('codev_anthropic_key', 'sk-ant-test');
        localStorage.setItem('codev_backend', 'anthropic');
        localStorage.setItem('codev_auto_ground', '0');
        localStorage.setItem('codev_chime', '0');
        localStorage.setItem('codev_claude_web_search', '0');
        localStorage.setItem('codev_response_length', 'medium');
    });
    const bodies = [];
    await page.route('https://api.anthropic.com/**', route => {
        const body = JSON.parse(route.request().postData());
        bodies.push(body);
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply(body, bodies.length)) });
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => {
        const box = document.getElementById('isSandboxCheckbox');
        return box && !box.disabled;
    }, null, { timeout: 15000 });
    await page.evaluate(() => {
        document.getElementById('settingsModal').style.display = 'none';
        if (document.getElementById('chatControlsContainer').style.display === 'none') toggleChatControls();
        document.getElementById('isSandboxCheckbox').checked = true;
    });
    return { page, errors, bodies, backend };
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const lastResults = body => JSON.stringify(body.messages.at(-1).content);

test('a write cut off at the length limit is not run, gets more room, and goes in parts with append', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const PART1 = '# Bible\n\n## 1. Canon\nAstron fell.\n';
    const PART2 = '## 2. Cast\nCarolyn is the grandmother.\n';
    const { page, errors, bodies, backend } = await openClaudePage(t, (body, n) => {
        if (body.tool_choice?.type === 'none') return { content: [{ type: 'text', text: 'Wrapped up.' }], stop_reason: 'end_turn', usage };
        if (n === 1) return { content: [{ type: 'text', text: 'Writing the bible.' }, toolUse('tu_1', 'write_file', { path: 'bible.md' })], stop_reason: 'max_tokens', usage };
        if (n === 2) return { content: [toolUse('tu_2', 'write_file', { path: 'bible.md', content: PART1 })], stop_reason: 'tool_use', usage };
        if (n === 3) return { content: [toolUse('tu_3', 'write_file', { path: 'bible.md', content: PART2, append: true })], stop_reason: 'tool_use', usage };
        if (n === 4) return { content: [toolUse('tu_4', 'read_file', { path: 'bible.md' })], stop_reason: 'tool_use', usage };
        return { content: [{ type: 'text', text: 'The bible has sections 1 and 2.' }], stop_reason: 'end_turn', usage };
    });
    await sendPrompt(page, 'Fill sections 1 to 3 of bible.md from the canon.');
    await waitForChat(page, /The bible has sections 1 and 2\./, 60000);

    // The cut-off call never reached the sandbox; the two parts did.
    const writes = backend.log.filter(entry => entry.tool === 'write_file');
    assert.equal(writes.length, 2);
    assert.equal(writes[0].args.content, PART1);
    assert.equal(writes[1].args.append, true);
    // The agent was told why and how, and its next reply had twice the room.
    assert.equal(bodies[0].max_tokens, 6144);
    assert.match(lastResults(bodies[1]), /Not run: your reply reached its length limit \(6144 output tokens\)/);
    assert.match(lastResults(bodies[1]), /'content' missing/);
    assert.match(lastResults(bodies[1]), /append: true/);
    assert.equal(bodies[1].max_tokens, 12288);
    assert.equal(bodies[2].max_tokens, 12288);
    // write_file offers append, and the file holds both parts.
    assert.ok(bodies[0].tools.find(tool => tool.name === 'write_file').input_schema.properties.append);
    assert.match(lastResults(bodies[4]), /Astron fell\.[\s\S]*Carolyn is the grandmother\./);
    assert.deepEqual(errors, []);
});

test('a failed call is not sent again unchanged, and three failed rounds stop the tools', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors, bodies, backend } = await openClaudePage(t, (body, n) => body.tool_choice?.type === 'none'
        ? { content: [{ type: 'text', text: 'I could not save the file.' }], stop_reason: 'end_turn', usage }
        : { content: [toolUse(`tu_${n}`, 'write_file', { path: 'bible.md' })], stop_reason: 'tool_use', usage });
    await sendPrompt(page, 'Fill sections 1 to 3 of bible.md from the canon.');
    await waitForChat(page, /I could not save the file\./, 60000);

    // Only the first attempt ran; the repeats were refused with the earlier error.
    assert.equal(backend.log.filter(entry => entry.tool === 'write_file').length, 1);
    assert.match(lastResults(bodies[1]), /needs 'content' as a string/);
    assert.match(lastResults(bodies[2]), /Not run: this exact call already failed in this task/);
    // Three rounds where everything failed, then the answer without tools.
    assert.equal(bodies.length, 4);
    assert.equal(bodies[3].tool_choice.type, 'none');
    assert.match(JSON.stringify(bodies[3].messages.at(-1)), /Every tool call failed in the last three rounds/);
    assert.deepEqual(errors, []);
});
