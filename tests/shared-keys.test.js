// A private copy's built-in keys (mobile/www/shared-keys.js): with no key in Settings
// the app chats using the built-in Groq key, Settings shows the key boxes empty, and
// saving Settings doesn't copy the built-in key into storage. Groq is stubbed.
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

const BUILT_IN = 'gsk_builtin_test_key_1234567890';

test('a private copy chats with its built-in key and never shows it', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-shared-keys-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => {
        localStorage.setItem('codev_auto_ground', '0');
        localStorage.setItem('codev_chime', '0');
    });
    // What the private build writes into the file.
    await page.route('**/shared-keys.js', async route => {
        const response = await route.fetch();
        const source = (await response.text()).replace('window.CODEV_SHARED_KEYS = {};', `window.CODEV_SHARED_KEYS = ${JSON.stringify({ groq: BUILT_IN })};`);
        route.fulfill({ response, body: source });
    });
    const auth = [];
    await page.route('https://api.groq.com/**', route => {
        auth.push(route.request().headers()['authorization']);
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello from Groq.' } }] }) });
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => {
        const box = document.getElementById('isSandboxCheckbox');
        return box && !box.disabled;
    }, null, { timeout: 15000 });

    // No setup is asked for, and Settings doesn't show the key.
    assert.equal(await page.evaluate(() => activeProviderKey()), BUILT_IN);
    await page.evaluate(() => openSettingsModal());
    assert.equal(await page.inputValue('#modalGroqKey'), '');
    await page.evaluate(() => saveSettings());
    await page.waitForFunction(() => document.getElementById('settingsModal').style.display === 'none', null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_groq_key')), '');

    await page.evaluate(() => {
        if (document.getElementById('chatControlsContainer').style.display === 'none') toggleChatControls();
        document.getElementById('isSandboxCheckbox').checked = false;
    });
    await sendPrompt(page, 'Say hello.');
    await waitForChat(page, /Hello from Groq\./);
    assert.ok(auth.length > 0 && auth.every(h => h === `Bearer ${BUILT_IN}`));
    assert.deepEqual(errors, []);
});

test('the built-in key list is empty in git, so public downloads have no keys', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'www', 'shared-keys.js'), 'utf8');
    assert.match(source, /^window\.CODEV_SHARED_KEYS = \{\};$/m);
});
