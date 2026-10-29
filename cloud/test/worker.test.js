// Runs the Worker against an in-memory SQLite database shaped like D1, with the
// email service and the AI providers replaced by fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.js';

const OWNER = 'owner@example.com';

function setup() {
    const env = { DB: fakeD1(), OWNER_EMAIL: OWNER, KEYS_SECRET: 'test-secret', RESEND_API_KEY: 're_test' };
    const emails = [];
    const upstream = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        if (url === 'https://api.resend.com/emails') {
            emails.push(JSON.parse(init.body));
            return new Response('{"id":"e1"}', { status: 200 });
        }
        upstream.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        if (url.includes('anthropic')) return Response.json({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
        return Response.json({ choices: [{ message: { role: 'assistant', content: 'hi' } }] });
    };
    const call = async (method, path, { body, token, headers = {} } = {}) => {
        const init = { method, headers: { ...headers } };
        if (token) init.headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
        const waits = [];
        const response = await worker.fetch(new Request(`https://codev.test${path}`, init), env, { waitUntil: p => waits.push(p) });
        await Promise.all(waits);
        const text = await response.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        return { status: response.status, data, headers: response.headers };
    };
    const signIn = async email => {
        await call('POST', '/auth/start', { body: { email } });
        const code = /code is (\d{6})/.exec(emails.filter(e => e.to[0] === email.toLowerCase()).at(-1).text)[1];
        const result = await call('POST', '/auth/verify', { body: { email, code } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        return result.data.token;
    };
    const restore = () => { globalThis.fetch = realFetch; };
    return { env, emails, upstream, call, signIn, restore };
}

const chat = { model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hello' }] };

test('sign-in by emailed code; a wrong code is refused and the code works once', async t => {
    const s = setup(); t.after(s.restore);
    await s.call('POST', '/auth/start', { body: { email: 'Ann@Example.com' } });
    assert.equal(s.emails[0].to[0], 'ann@example.com');
    const code = /code is (\d{6})/.exec(s.emails[0].text)[1];
    const wrong = await s.call('POST', '/auth/verify', { body: { email: 'ann@example.com', code: code === '000000' ? '111111' : '000000' } });
    assert.equal(wrong.status, 400);
    const ok = await s.call('POST', '/auth/verify', { body: { email: 'ann@example.com', code } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.account.plan.name, 'Trial');
    const again = await s.call('POST', '/auth/verify', { body: { email: 'ann@example.com', code } });
    assert.equal(again.status, 400);
    const me = await s.call('GET', '/me', { token: ok.data.token });
    assert.equal(me.data.email, 'ann@example.com');
    assert.equal(me.data.owner, undefined);
});

test('a code stops working after five wrong tries', async t => {
    const s = setup(); t.after(s.restore);
    await s.call('POST', '/auth/start', { body: { email: 'bob@example.com' } });
    const code = /code is (\d{6})/.exec(s.emails[0].text)[1];
    const bad = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await s.call('POST', '/auth/verify', { body: { email: 'bob@example.com', code: bad } });
    const late = await s.call('POST', '/auth/verify', { body: { email: 'bob@example.com', code } });
    assert.equal(late.status, 400);
});

test('a new sign-up emails the owner; the owner signing up does not', async t => {
    const s = setup(); t.after(s.restore);
    await s.signIn(OWNER);
    assert.equal(s.emails.filter(e => e.subject.includes('new sign-up')).length, 0);
    await s.signIn('cat@example.com');
    const notice = s.emails.find(e => e.subject.includes('new sign-up'));
    assert.equal(notice.to[0], OWNER);
    assert.match(notice.subject, /^Sign-up agent: new sign-up, cat@example\.com/);
    assert.match(notice.text, /Approve as tester/);
});

test('requests need a sign-in, and the owner pages are hidden from everyone else', async t => {
    const s = setup(); t.after(s.restore);
    assert.equal((await s.call('POST', '/v1/groq/chat/completions', { body: chat })).status, 401);
    const token = await s.signIn('dee@example.com');
    assert.equal((await s.call('GET', '/owner/users', { token })).status, 404);
    assert.equal((await s.call('PUT', '/owner/keys/groq', { token, body: { value: 'gsk_x' } })).status, 404);
});

test("relayed chat uses the owner's key, which never reaches the user", async t => {
    const s = setup(); t.after(s.restore);
    const owner = await s.signIn(OWNER);
    assert.equal((await s.call('PUT', '/owner/keys/groq', { token: owner, body: { value: 'gsk_ownerkey123456' } })).status, 200);
    const stored = s.env.DB.raw.prepare('SELECT value FROM secrets WHERE name = ?').get('groq');
    assert.ok(!stored.value.includes('gsk_ownerkey'), 'keys are stored encrypted');

    const user = await s.signIn('eve@example.com');
    const result = await s.call('POST', '/v1/groq/chat/completions', { token: user, body: chat });
    assert.equal(result.status, 200);
    assert.equal(result.data.choices[0].message.content, 'hi');
    assert.equal(s.upstream[0].headers.Authorization, 'Bearer gsk_ownerkey123456');
    assert.ok(!JSON.stringify(result.data).includes('gsk_'));
    const me = await s.call('GET', '/me', { token: user });
    assert.ok(!JSON.stringify(me.data).includes('gsk_'));
    assert.equal(me.data.usage.trialUsed, 1);

    const masked = await s.call('GET', '/owner/keys', { token: owner });
    assert.equal(masked.data.keys.groq, 'gsk_ow••••3456');
    const revealed = await s.call('GET', '/owner/keys/groq/reveal', { token: owner });
    assert.equal(revealed.data.value, 'gsk_ownerkey123456');
});

test('the trial is 20 Groq messages, then it asks for the Pro plan', async t => {
    const s = setup(); t.after(s.restore);
    const owner = await s.signIn(OWNER);
    await s.call('PUT', '/owner/keys/groq', { token: owner, body: { value: 'gsk_ownerkey123456' } });
    await s.call('PUT', '/owner/keys/anthropic', { token: owner, body: { value: 'sk-ant-ownerkey' } });
    const user = await s.signIn('fay@example.com');
    const claude = await s.call('POST', '/v1/anthropic/messages', { token: user, body: { messages: [] } });
    assert.equal(claude.status, 403);
    for (let i = 0; i < 20; i++) assert.equal((await s.call('POST', '/v1/groq/chat/completions', { token: user, body: chat })).status, 200);
    const over = await s.call('POST', '/v1/groq/chat/completions', { token: user, body: chat });
    assert.equal(over.status, 402);
    assert.equal(over.data.error.code, 'trial_over');
    assert.match(over.data.error.message, /Pro plan/);
});

test('testers are approved by the owner and look exactly like the Pro plan', async t => {
    const s = setup(); t.after(s.restore);
    const owner = await s.signIn(OWNER);
    const user = await s.signIn('gus@example.com');
    const list = await s.call('GET', '/owner/users', { token: owner });
    assert.equal(list.data.pending, 1);
    const gus = list.data.users.find(u => u.email === 'gus@example.com');
    assert.equal((await s.call('POST', `/owner/users/${gus.id}`, { token: owner, body: { action: 'approve' } })).status, 200);

    const me = await s.call('GET', '/me', { token: user });
    assert.equal(me.data.plan.name, 'Pro plan');
    assert.ok(!/tester/i.test(JSON.stringify(me.data)), 'nothing a tester sees names the tester plan');
    assert.equal((await s.call('GET', '/owner/users', { token: owner })).data.pending, 0);

    await s.call('PUT', '/owner/keys/anthropic', { token: owner, body: { value: 'sk-ant-ownerkey' } });
    const claude = await s.call('POST', '/v1/anthropic/messages', { token: user, body: { model: 'claude-opus-5-5', max_tokens: 64000, messages: [] } });
    assert.equal(claude.status, 200);
    assert.equal(s.upstream.at(-1).body.model, 'claude-haiku-5-5', 'non-owners use the cheap model');
    assert.equal(s.upstream.at(-1).body.max_tokens, 16000);
    assert.equal(s.upstream.at(-1).headers['x-api-key'], 'sk-ant-ownerkey');

    assert.equal((await s.call('POST', `/owner/users/${gus.id}`, { token: owner, body: { action: 'remove' } })).status, 200);
    assert.equal((await s.call('GET', '/me', { token: user })).data.plan.name, 'Trial');
});

test('the tester limit and the daily cap for everyone are enforced', async t => {
    const s = setup(); t.after(s.restore);
    const owner = await s.signIn(OWNER);
    await s.call('PUT', '/owner/keys/groq', { token: owner, body: { value: 'gsk_ownerkey123456' } });
    await s.call('PUT', '/owner/settings', { token: owner, body: { tester_cap: 1, daily_cap: 2 } });
    await s.signIn('hal@example.com');
    const ivy = await s.signIn('ivy@example.com');
    const users = (await s.call('GET', '/owner/users', { token: owner })).data.users;
    const id = email => users.find(u => u.email === email).id;
    assert.equal((await s.call('POST', `/owner/users/${id('hal@example.com')}`, { token: owner, body: { action: 'approve' } })).status, 200);
    assert.equal((await s.call('POST', `/owner/users/${id('ivy@example.com')}`, { token: owner, body: { action: 'approve' } })).status, 409);

    assert.equal((await s.call('POST', '/v1/groq/chat/completions', { token: ivy, body: chat })).status, 200);
    assert.equal((await s.call('POST', '/v1/groq/chat/completions', { token: ivy, body: chat })).status, 200);
    const capped = await s.call('POST', '/v1/groq/chat/completions', { token: ivy, body: chat });
    assert.equal(capped.status, 503);
    assert.equal(capped.data.error.code, 'global_cap');
    // The owner is never capped, and the Max plan keeps priority.
    assert.equal((await s.call('POST', '/v1/groq/chat/completions', { token: owner, body: chat })).status, 200);
    s.env.DB.raw.prepare("UPDATE users SET plan = 'max' WHERE email = ?").run('ivy@example.com');
    assert.equal((await s.call('POST', '/v1/groq/chat/completions', { token: ivy, body: chat })).status, 200);
    assert.equal((await s.call('GET', '/me', { token: ivy })).data.plan.name, 'Max plan');
});

test("a refused owner key isn't passed on as the provider's error", async t => {
    const s = setup(); t.after(s.restore);
    const owner = await s.signIn(OWNER);
    await s.call('PUT', '/owner/keys/groq', { token: owner, body: { value: 'gsk_badkey123456' } });
    const user = await s.signIn('jo@example.com');
    globalThis.fetch = async () => Response.json({ error: { message: 'Invalid API Key gsk_badkey123456' } }, { status: 401 });
    const result = await s.call('POST', '/v1/groq/chat/completions', { token: user, body: chat });
    assert.equal(result.status, 502);
    assert.equal(result.data.error.code, 'bad_key');
    assert.ok(!JSON.stringify(result.data).includes('gsk_'));
});

test('sign-out ends the session, and CORS lets the apps call', async t => {
    const s = setup(); t.after(s.restore);
    const token = await s.signIn('kay@example.com');
    const pre = await s.call('OPTIONS', '/me');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
    await s.call('POST', '/auth/signout', { token });
    assert.equal((await s.call('GET', '/me', { token })).status, 401);
});

test("the owner's agents: names, instructions and memory the owner edits, hidden from everyone else", async t => {
    const s = setup(); t.after(s.restore);
    const owner = await s.signIn(OWNER);
    const user = await s.signIn('mo@example.com');
    assert.equal((await s.call('GET', '/owner/agents', { token: user })).status, 404);

    const { agents } = (await s.call('GET', '/owner/agents', { token: owner })).data;
    assert.deepEqual(agents.map(a => a.name), ['API agent', 'Sign-up agent']);
    assert.match(agents[1].memory, /mo@example\.com signed up/);

    const saved = await s.call('PUT', '/owner/agents/signups', { token: owner, body: { name: 'Gatekeeper', instructions: 'Only approve people I know.' } });
    assert.equal(saved.data.agent.name, 'Gatekeeper');
    await s.signIn('ned@example.com');
    const notice = s.emails.find(e => e.subject.startsWith('Gatekeeper: new sign-up, ned@example.com'));
    assert.ok(notice);
    // With no Groq key stored, the notice is the plain facts.
    assert.match(notice.text, /Testers now: 0 of 10/);

    // With the owner's Groq key, the agent writes the note with Groq, following the instructions.
    await s.call('PUT', '/owner/keys/groq', { token: owner, body: { value: 'gsk_ownerkey123456' } });
    await s.signIn('oz@example.com');
    const prompt = s.upstream.at(-1);
    assert.equal(prompt.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.match(prompt.body.messages[0].content, /You are Gatekeeper/);
    assert.match(prompt.body.messages[0].content, /Only approve people I know\./);
    assert.match(prompt.body.messages[0].content, /ned@example\.com signed up/, 'the agent reads its memory');
    assert.match(prompt.body.messages[1].content, /New sign-up: oz@example\.com/);
});

test('the API agent warns once at 80% of the daily total and sends a summary after midnight', async t => {
    const s = setup(); t.after(s.restore);
    const owner = await s.signIn(OWNER);
    await s.call('PUT', '/owner/keys/groq', { token: owner, body: { value: 'gsk_ownerkey123456' } });
    await s.call('PUT', '/owner/settings', { token: owner, body: { daily_cap: 5 } });
    const user = await s.signIn('pia@example.com');
    const id = (await s.call('GET', '/owner/users', { token: owner })).data.users.find(u => u.email === 'pia@example.com').id;
    await s.call('POST', `/owner/users/${id}`, { token: owner, body: { action: 'approve' } });
    for (let i = 0; i < 4; i++) await s.call('POST', '/v1/groq/chat/completions', { token: user, body: chat });

    const noon = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
    const tick = async now => { const waits = []; await worker.scheduled({ scheduledTime: now }, s.env, { waitUntil: p => waits.push(p) }); await Promise.all(waits); };
    const warnings = () => s.emails.filter(e => e.subject.startsWith("API agent: 80% of today's shared AI used"));
    await tick(noon);
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].text, /4 of the daily total of 5 \(80%\)/);
    assert.match(warnings()[0].text, /groq: 4 requests from 1 account\(s\), about \$0\.01/);
    await tick(noon + 60 * 60 * 1000);
    assert.equal(warnings().length, 1, 'one warning a day');

    // Just after midnight: yesterday's summary, once.
    await tick(noon + 12.5 * 60 * 60 * 1000);
    await tick(noon + 12.75 * 60 * 60 * 1000);
    const summaries = s.emails.filter(e => e.subject === "API agent: yesterday's API spending");
    assert.equal(summaries.length, 1);
    assert.match(summaries[0].text, /groq: 4 requests/);

    const run = await s.call('POST', '/owner/agents/api/run', { token: owner });
    assert.equal(run.status, 200);
    assert.match(run.data.agent.last_report, /Day \(UTC\)/);
    assert.match(run.data.agent.memory, /Warned: 4\/5/);
});

test('synced items: a passphrase check set once, newest write wins, and each account sees only its own', async t => {
    const s = setup(); t.after(s.restore);
    const ann = await s.signIn('ann2@example.com');
    const bob = await s.signIn('bob2@example.com');
    const vault = { salt: 'c2FsdA', check_iv: 'aXY', check_data: 'Y2hlY2s' };
    assert.equal((await s.call('GET', '/sync/vault', { token: ann })).data.vault, null);
    assert.equal((await s.call('PUT', '/sync/items', { token: ann, body: { items: [{ key: 'chat:1', iv: 'aXY', data: 'eA', updated_at: 1 }] } })).status, 409);
    assert.equal((await s.call('PUT', '/sync/vault', { token: ann, body: vault })).status, 200);
    assert.equal((await s.call('PUT', '/sync/vault', { token: ann, body: vault })).status, 409, 'set once unless reset');
    assert.deepEqual((await s.call('GET', '/sync/vault', { token: ann })).data.vault, vault);

    const put = (token, items) => s.call('PUT', '/sync/items', { token, body: { items } });
    assert.equal((await put(ann, [{ key: 'chat:a1', iv: 'aXY', data: 'bmV3ZXI', updated_at: 200 }, { key: 'memories', iv: 'aXY', data: 'bWVt', updated_at: 100 }])).status, 200);
    // An older write doesn't replace a newer one.
    await put(ann, [{ key: 'chat:a1', iv: 'aXY', data: 'b2xkZXI', updated_at: 150 }]);
    let pulled = (await s.call('GET', '/sync/items?since=0', { token: ann })).data;
    assert.deepEqual(pulled.items.map(i => [i.key, i.data]).sort(), [['chat:a1', 'bmV3ZXI'], ['memories', 'bWVt']]);
    const cursor = pulled.cursor;

    // Deleting sends a tombstone; only what changed after the cursor comes back.
    await new Promise(r => setTimeout(r, 5));
    await put(ann, [{ key: 'chat:a1', deleted: true, updated_at: 300 }]);
    pulled = (await s.call('GET', `/sync/items?since=${cursor}`, { token: ann })).data;
    assert.deepEqual(pulled.items.map(i => [i.key, i.deleted]), [['chat:a1', true]]);

    // Bob can't see Ann's items, and the server only ever holds what was sent: no plain text.
    assert.equal((await s.call('GET', '/sync/items?since=0', { token: bob })).status, 409);
    await s.call('PUT', '/sync/vault', { token: bob, body: vault });
    assert.deepEqual((await s.call('GET', '/sync/items?since=0', { token: bob })).data.items, []);

    // Bad input is refused.
    assert.equal((await put(ann, [{ key: '../x', iv: 'aXY', data: 'eA', updated_at: 1 }])).status, 400);
    assert.equal((await put(ann, [{ key: 'chat:z', iv: 'aXY', data: 'not base64!', updated_at: 1 }])).status, 400);

    // Starting over deletes everything synced.
    assert.equal((await s.call('PUT', '/sync/vault', { token: ann, body: { ...vault, salt: 'bmV3', reset: true } })).status, 200);
    assert.deepEqual((await s.call('GET', '/sync/items?since=0', { token: ann })).data.items, []);
});

test('synced items stay within the plan: 5 MB on the trial', async t => {
    const s = setup(); t.after(s.restore);
    const ann = await s.signIn('cy@example.com');
    await s.call('PUT', '/sync/vault', { token: ann, body: { salt: 'c2FsdA', check_iv: 'aXY', check_data: 'Y2hlY2s' } });
    const big = 'A'.repeat(1_800_000);
    for (let i = 0; i < 2; i++) assert.equal((await s.call('PUT', '/sync/items', { token: ann, body: { items: [{ key: `chat:${i}`, iv: 'aXY', data: big, updated_at: 1 }] } })).status, 200);
    const full = await s.call('PUT', '/sync/items', { token: ann, body: { items: [{ key: 'chat:9', iv: 'aXY', data: big, updated_at: 1 }] } });
    assert.equal(full.status, 413);
    assert.equal(full.data.error.code, 'sync_full');
    // Replacing an item already stored counts only its new size.
    assert.equal((await s.call('PUT', '/sync/items', { token: ann, body: { items: [{ key: 'chat:1', iv: 'aXY', data: big, updated_at: 2 }] } })).status, 200);
});
