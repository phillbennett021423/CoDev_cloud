// Spending limits and short replies: what each Claude request costs is added to
// today's total, a task over its limit stops using tools and answers, and the
// daily limit stops new requests. Anthropic is stubbed, so no key is needed.
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

// The page with Anthropic as the provider. reply(body, n) answers the nth request.
async function openClaudePage(t, reply, storage = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-spend-'));
    fs.writeFileSync(path.join(workspace, 'app.js'), 'console.log("hi");\n');
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(storage => {
        localStorage.setItem('codev_anthropic_key', 'sk-ant-test');
        localStorage.setItem('codev_backend', 'anthropic');
        localStorage.setItem('codev_auto_ground', '0');
        localStorage.setItem('codev_chime', '0');
        localStorage.setItem('codev_claude_web_search', '0');
        for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    }, storage);
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
        document.getElementById('isSandboxCheckbox').checked = false;
    });
    return { page, errors, bodies };
}

const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000, output_tokens: 400 };
// 1000 x $0.10/M + 9000 x $0.01/M + 400 x $0.50/M
const COST_PER_CALL = 0.0001 + 0.00009 + 0.0002;

test('each Claude request adds its cost to today, and replies are asked to be brief', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors, bodies } = await openClaudePage(t, () => ({ content: [{ type: 'text', text: 'It prints hi.' }], stop_reason: 'end_turn', usage }));
    await sendPrompt(page, 'What does app.js do?');
    await waitForChat(page, /It prints hi\./);
    assert.match(bodies[0].system, /BE BRIEF: Say what the user needs and stop\./);
    const spend = await page.evaluate(() => spendToday());
    assert.equal(spend.requests, 1);
    assert.ok(Math.abs(spend.usd - COST_PER_CALL) < 1e-9, `spent ${spend.usd}`);
    assert.equal(spend.inputTokens, 10000);
    assert.equal(spend.outputTokens, 400);

    // A prompt over 100K tokens is billed at the higher rates; web searches at a cent each.
    const costs = await page.evaluate(() => ({
        long: anthropicCost({ input_tokens: 120000, output_tokens: 1000 }),
        search: anthropicCost({ server_tool_use: { web_search_requests: 2 } })
    }));
    assert.ok(Math.abs(costs.long - (120000 * 0.5 + 1000 * 2.5) / 1e6) < 1e-9);
    assert.ok(Math.abs(costs.search - 0.02) < 1e-9);
    assert.deepEqual(errors, []);
});

test('a task over its spending limit stops using tools and answers with what it has', async t => {
    if (launched.skip) return t.skip(launched.skip);
    // Every request costs $0.10, and the model would call tools forever.
    const pricey = { input_tokens: 0, output_tokens: 200000 };
    const { page, errors, bodies } = await openClaudePage(t, (body, n) => body.tool_choice?.type === 'none'
        ? { content: [{ type: 'text', text: 'Here is what I found so far.' }], stop_reason: 'end_turn', usage: pricey }
        : { content: [{ type: 'tool_use', id: `tu_${n}`, name: body.tools.some(tool => tool.name === 'search_past_chats') ? 'search_past_chats' : body.tools[0].name, input: { query: `godot notes ${n}` } }], stop_reason: 'tool_use', usage: pricey },
    { codev_task_spend_limit: '0.25', codev_daily_spend_limit: '5' });
    await sendPrompt(page, 'Look through my old chats for anything about Godot.');
    await waitForChat(page, /Here is what I found so far\./);
    // $0.10 a call: three tool rounds reach $0.30, then the wrap-up call without tools.
    assert.equal(bodies.length, 4);
    const last = bodies[3];
    assert.equal(last.tool_choice.type, 'none');
    assert.match(JSON.stringify(last.messages.at(-1)), /this task reached its spending limit of \$0\.25/);
    assert.ok(Math.abs(await page.evaluate(() => spendToday().usd) - 0.4) < 1e-9);
    assert.deepEqual(errors, []);
});

test('at the daily limit no request is sent, and Settings shows what was spent', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const { page, errors, bodies } = await openClaudePage(t, () => ({ content: [{ type: 'text', text: 'should not be sent' }], stop_reason: 'end_turn', usage }),
        { codev_daily_spend_limit: '1', codev_spend: JSON.stringify({ day, usd: 1.02, requests: 40, inputTokens: 0, outputTokens: 0 }) });
    await sendPrompt(page, 'Hello there');
    await waitForChat(page, /today's spending limit \(\$1\.02 of \$1\.00\)/);
    assert.equal(bodies.length, 0);

    // Yesterday's total doesn't count today.
    const fresh = await page.evaluate(() => {
        localStorage.setItem('codev_spend', JSON.stringify({ day: '2000-01-01', usd: 50, requests: 3, inputTokens: 0, outputTokens: 0 }));
        return spendToday().usd;
    });
    assert.equal(fresh, 0);

    // Raising the limit in Settings lets requests through again.
    await page.evaluate(() => localStorage.setItem('codev_spend', JSON.stringify({ day: spendDay(), usd: 1.02, requests: 40, inputTokens: 0, outputTokens: 0 })));
    await page.evaluate(() => { openSettingsModal(); document.getElementById('spendSettings').open = true; });
    assert.match(await page.textContent('#spendStatus'), /about \$1\.02 of your \$1\.00 limit, over 40 request/);
    await page.fill('#modalDailySpendLimit', '2');
    await page.fill('#modalTaskSpendLimit', '0.5');
    await page.evaluate(async () => { await saveSettings(); });
    assert.deepEqual(await page.evaluate(() => [dailySpendLimit, taskSpendLimit, localStorage.getItem('codev_daily_spend_limit')]), [2, 0.5, '2']);
    assert.equal(await page.evaluate(() => dailySpendReached()), false);
    assert.deepEqual(errors, []);
});

test('quick asks go to Claude Haiku, big tasks to Claude Sonnet, and Sonnet is priced as Sonnet', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors, bodies } = await openClaudePage(t, () => ({ content: [{ type: 'text', text: 'All set.' }], stop_reason: 'end_turn', usage }));
    await sendPrompt(page, 'What does app.js do?');
    await waitForChat(page, /All set\./);
    assert.equal(bodies[0].model, 'claude-haiku-5-5');
    assert.equal(bodies[0].output_config, undefined);

    await sendPrompt(page, 'Build a settings page for app.js and add tests for it.');
    const asked = () => bodies.find(b => /Build a settings page/.test(JSON.stringify(b.messages)));
    for (let i = 0; i < 100 && !asked(); i++) await new Promise(r => setTimeout(r, 100));
    const big = asked();
    assert.ok(big, 'the big task reached Claude');
    assert.equal(big.model, 'claude-sonnet-5-5');
    assert.deepEqual(big.output_config, { effort: 'medium' });

    // Sonnet 5.5: $2 in / $10 out per million, one rate at any prompt size.
    const sonnet = await page.evaluate(() => anthropicCost({ input_tokens: 120000, output_tokens: 1000 }, 'claude-sonnet-5-5'));
    assert.ok(Math.abs(sonnet - (120000 * 2 + 1000 * 10) / 1e6) < 1e-9);
    assert.deepEqual(errors, []);
});

test('Claude is the default provider, and a saved Groq choice moves to Claude once when a Claude key is there', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openClaudePage(t, () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage }),
        { codev_backend: 'groq', codev_groq_key: 'gsk_test' });
    assert.equal(await page.evaluate(() => currentBackend), 'anthropic');
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_claude_default')), '1');
    assert.equal(await page.evaluate(() => document.getElementById('modalProvider').options[0].value), 'anthropic');
    assert.deepEqual(errors, []);
});

test('the QA reviewer runs on Claude Haiku even after a Sonnet task, and every agent is told the user is the author', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors, bodies } = await openClaudePage(t, body => /Audit the code in these replies/.test(JSON.stringify(body.messages))
        ? { content: [{ type: 'text', text: 'The code is clean.' }], stop_reason: 'end_turn', usage }
        : { content: [{ type: 'text', text: 'Fixed it:\n```js app.js\nconsole.log("hello");\n```' }], stop_reason: 'end_turn', usage });
    await page.evaluate(() => { document.getElementById('isSelfHealCheckbox').checked = true; });
    await sendPrompt(page, 'Fix the greeting bug in app.js');
    await waitForChat(page, /The code is clean\./);
    const writer = bodies.find(b => !/Audit the code/.test(JSON.stringify(b.messages)));
    const audit = bodies.find(b => /Audit the code/.test(JSON.stringify(b.messages)));
    assert.equal(writer.model, 'claude-sonnet-5-5');
    assert.equal(audit.model, 'claude-haiku-5-5');
    assert.match(writer.system, /THE USER IS THE AUTHOR[\s\S]*their direct instruction overrides them/);
    assert.deepEqual(errors, []);
});

test('a task a spending limit stops keeps its progress, and "continue" picks up from the last step instead of starting over', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const pricey = { input_tokens: 0, output_tokens: 200000 };
    const { page, errors, bodies } = await openClaudePage(t, (body, n) => {
        const text = JSON.stringify(body.messages);
        if (/A spending limit stopped you part way/.test(text)) return { content: [{ type: 'text', text: 'Finished the rest.' }], stop_reason: 'end_turn', usage };
        if (body.tool_choice?.type === 'none') return { content: [{ type: 'text', text: 'Stopped part way.' }], stop_reason: 'end_turn', usage: pricey };
        return { content: [{ type: 'tool_use', id: `tu_${n}`, name: 'search_past_chats', input: { query: `godot notes ${n}` } }], stop_reason: 'tool_use', usage: pricey };
    }, { codev_task_spend_limit: '0.25', codev_daily_spend_limit: '5' });
    await sendPrompt(page, 'Look through my old chats for anything about Godot.');
    await waitForChat(page, /Stopped part way\./);
    assert.equal(bodies.length, 4);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('.resume-btn'))), true, 'the cut-short reply offers ▶ Resume');

    await sendPrompt(page, 'continue');
    await waitForChat(page, /Finished the rest\./);
    const resumed = bodies[4];
    const sent = JSON.stringify(resumed.messages);
    // The earlier tool steps go back as they were: the task isn't started over.
    assert.equal(resumed.messages.filter(m => (m.content || []).some?.(b => b.type === 'tool_result')).length, 3);
    assert.match(sent, /Look through my old chats for anything about Godot/);
    assert.equal(bodies.length, 5);
    assert.deepEqual(errors, []);
});

test('with autopilot on, any task runs to the end: a reply that stops to ask is sent back, and only deleting asks first', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors, bodies } = await openClaudePage(t, (body, n) => n === 1
        ? { content: [{ type: 'text', text: 'Here is a first verse. Want me to write the rest?' }], stop_reason: 'end_turn', usage }
        : { content: [{ type: 'text', text: 'Here is the whole poem.' }], stop_reason: 'end_turn', usage });
    await sendPrompt(page, 'Write a four-verse poem about rain.');
    await waitForChat(page, /Here is the whole poem\./);
    assert.equal(bodies.length, 2);
    assert.match(bodies[0].system, /AUTOPILOT \(the user turned it on\)[\s\S]*Don't ask for permission/);
    assert.match(JSON.stringify(bodies[1].messages.at(-1)), /CoDev autopilot/);

    const asked = await page.evaluate(async () => {
        const questions = [];
        window.askPermission = async message => { questions.push(message); return false; };
        window.callMcpTool = async tool => `ran ${tool.name}`;
        const ctx = { kind: 'general', agentName: 'Writer' };
        const results = [];
        for (const name of ['write_file', 'media_remove_noise', 'delete_file', 'notes_delete']) results.push(await runMcpTool({ name, transport: 'desktop', annotations: {} }, { path: 'x' }, ctx));
        return { questions: questions.length, results };
    });
    assert.deepEqual(asked.results.slice(0, 2), ['ran write_file', 'ran media_remove_noise']);
    assert.match(asked.results[2], /declined this deletion/);
    assert.match(asked.results[3], /declined this deletion/);
    assert.equal(asked.questions, 2);
    assert.deepEqual(errors, []);
});
