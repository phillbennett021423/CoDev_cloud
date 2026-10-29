// The CoDev account in the real page (agent-ui/cloud-account.js): sign in with an
// emailed code, chat with no key of your own through CoDev's server (cloud/,
// run here in-process on a fake database), and the owner-only Owner page.
// The AI providers and the email service are fakes, so no key or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser } = require('./helpers/page-driver');

const CLOUD = 'https://codev-cloud.test';
const OWNER = 'owner@example.com';

let launched;
let worker;
let fakeD1;
test.before(async () => {
    launched = await launchBrowser();
    worker = (await import('../cloud/src/worker.js')).default;
    ({ fakeD1 } = await import('../cloud/test/fake-d1.js'));
});
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

// The page, a fresh server and its database; page.route hands the page's requests to the Worker.
async function setup(t) {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-cloud-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());

    const env = { DB: fakeD1(), OWNER_EMAIL: OWNER, KEYS_SECRET: 'test-secret', RESEND_API_KEY: 're_test' };
    const emails = [];
    const upstream = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (address, init = {}) => {
        if (address === 'https://api.resend.com/emails') { emails.push(JSON.parse(init.body)); return Response.json({ id: 'e' }); }
        upstream.push({ url: address, headers: init.headers, body: JSON.parse(init.body) });
        return Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello from the shared key.' } }] });
    };
    t.after(() => { globalThis.fetch = realFetch; });

    const page = await launched.browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.route(`${CLOUD}/**`, async route => {
        const req = route.request();
        const headers = await req.allHeaders();
        const response = await worker.fetch(new Request(req.url(), {
            method: req.method(), headers, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData()
        }), env, { waitUntil() {} });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.addInitScript(cloud => {
        localStorage.setItem('codev_cloud_url', cloud);
        localStorage.setItem('codev_backend', 'groq');
        localStorage.setItem('codev_auto_ground', '0');
        localStorage.setItem('codev_chime', '0');
    }, CLOUD);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.CodevCloud);

    const signIn = async email => {
        await page.evaluate(() => openSettingsModal());
        await page.fill('#codevAccountPanel input[type=email]', email);
        await page.click('#codevAccountPanel button:has-text("Email me a code")');
        await page.waitForSelector('#codevAccountPanel input[inputmode=numeric]');
        const code = /code is (\d{6})/.exec(emails.filter(e => e.to[0] === email).at(-1).text)[1];
        await page.fill('#codevAccountPanel input[inputmode=numeric]', code);
        await page.click('#codevAccountPanel button:text-is("Sign in")');
        await page.waitForSelector('#codevAccountPanel button:has-text("Sign out")');
    };
    return { page, env, emails, upstream, errors, signIn };
}

test('a signed-in account chats with no API key, and the key never reaches the page', async t => {
    const s = await setup(t);
    if (!s) return;
    // The owner adds the Groq key on the server.
    const ownerToken = await (async () => {
        const call = (p, body, token) => worker.fetch(new Request(CLOUD + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), s.env, { waitUntil() {} });
        await call('/auth/start', { email: OWNER });
        const code = /code is (\d{6})/.exec(s.emails.at(-1).text)[1];
        const { token } = await (await call('/auth/verify', { email: OWNER, code })).json();
        await worker.fetch(new Request(`${CLOUD}/owner/keys/groq`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'gsk_owners_secret_key' }) }), s.env);
        return token;
    })();
    assert.ok(ownerToken);

    assert.equal(await s.page.evaluate(() => activeProviderKey()), '');
    await s.signIn('pat@example.com');
    assert.match(await s.page.textContent('#codevAccountPanel'), /Trial/);
    assert.equal(await s.page.evaluate(() => activeProviderKey()), 'cloud');
    // No key typed in: Launch saves instead of asking for a Groq key.
    await s.page.click('#modalLaunchBtn');
    assert.equal(await s.page.isVisible('#settingsError'), false);

    const reply = await s.page.evaluate(() => groqChatMessage({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(reply.content, 'Hello from the shared key.');
    assert.equal(s.upstream[0].headers.Authorization, 'Bearer gsk_owners_secret_key');
    const stored = await s.page.evaluate(() => JSON.stringify(localStorage));
    assert.ok(!stored.includes('gsk_owners_secret_key'));
    assert.equal(await s.page.evaluate(() => localStorage.getItem('codev_groq_key') || ''), '');
    // The Owner page is not offered to this account.
    await s.page.evaluate(() => openSettingsModal());
    assert.equal(await s.page.locator('#codevAccountPanel button:has-text("Owner page")').count(), 0);
    assert.deepEqual(s.errors, []);
});

test("a finished trial shows the server's message in the chat error", async t => {
    const s = await setup(t);
    if (!s) return;
    await s.signIn('lee@example.com');
    s.env.DB.raw.prepare('UPDATE users SET trial_used = 20 WHERE email = ?').run('lee@example.com');
    const message = await s.page.evaluate(() => groqChatMessage({ model: 'x', messages: [] }).then(() => '', err => err.message));
    assert.match(message, /20 trial messages/);
    assert.match(message, /Pro plan/);
});

test('the owner gets the Owner page: keys, sign-ups to approve, limits', async t => {
    const s = await setup(t);
    if (!s) return;
    // Someone signs up first, straight through the server.
    const post = (p, body) => worker.fetch(new Request(CLOUD + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), s.env, { waitUntil: p => p });
    await post('/auth/start', { email: 'new@example.com' });
    await post('/auth/verify', { email: 'new@example.com', code: /code is (\d{6})/.exec(s.emails.at(-1).text)[1] });

    await s.signIn(OWNER);
    assert.match(await s.page.textContent('#codevAccountPanel'), /Owner/);
    await s.page.click('#codevAccountPanel button:has-text("Owner page")');
    await s.page.waitForSelector('#ownerModal >> text=API keys');
    assert.match(await s.page.textContent('#ownerModal'), /1 new sign-up to review/);

    await s.page.fill('#ownerModal input[placeholder="Paste a new Groq key"]', 'gsk_from_owner_page_1234');
    await s.page.click('#ownerModal >> text=Save >> nth=0');
    await s.page.waitForSelector('#ownerModal >> text=gsk_fr••••1234');
    await s.page.click('#ownerModal >> text=Show');
    await s.page.waitForSelector('#ownerModal >> text=gsk_from_owner_page_1234');

    await s.page.click('#ownerModal >> text=Approve as tester');
    await s.page.waitForSelector('#ownerModal >> text=Remove tester');
    const plan = s.env.DB.raw.prepare('SELECT plan FROM users WHERE email = ?').get('new@example.com').plan;
    assert.equal(plan, 'tester');
    assert.deepEqual(s.errors, []);
});
