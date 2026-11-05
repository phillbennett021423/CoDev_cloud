// CoDev's MEGA tools (they replaced Google Drive): the shared account logic
// (agent-ui/mega-cloud.js) through the computer's module (desktop/mega-connect.js),
// the tools' answers, what is offered when, the phone's own session, and one run in
// the real page where an agent searches MEGA and the user approves or declines a
// save. MEGA itself is a stand-in for megajs's Storage, so no account is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMegaConnect } = require('../desktop/mega-connect');
const Mega = require('../mobile/www/agent-ui/mega-cloud.js');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat, answerApprovals } = require('./helpers/page-driver');

const { fakeMega } = require('./fixtures/fake-mega');

function tempSessionFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-mega-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'mega-session.json');
}

// A signed-in account with a few files.
async function signedIn(t, { allowWrite = false } = {}) {
    const mega = fakeMega();
    const shots = mega.drive.add('Screenshots', mega.drive.rootId, { folder: true });
    mega.drive.add('slip-1.png', shots, { text: 'png', ts: 1761000000 });
    mega.drive.add('slip-2.png', shots, { text: 'png', ts: 1762000000 });
    const notes = mega.drive.add('Notes', mega.drive.rootId, { folder: true });
    mega.drive.add("Bennett's picks.md", notes, { text: '# Picks\nLeBron over 25.5', ts: 1761500000 });
    mega.drive.add('old picks.md', mega.drive.trashId, { text: 'deleted' });
    const sessionFile = tempSessionFile(t);
    const connect = createMegaConnect({ sessionFile, Storage: mega.Storage });
    const reply = await connect.handle({ op: 'signin', email: 'pb@example.com', password: 'right-pass', allowWrite });
    assert.deepEqual(reply, { ok: true, email: 'pb@example.com' });
    return { mega, connect, sessionFile };
}

const cloudOver = (connect, extra = {}) => Mega.createMegaCloud({ transport: Mega.backendTransport(req => connect.handle(req), 'computer'), confirmWrite: async () => true, ...extra });

test('sign-in keeps MEGA\'s session, never the password, and sign-out ends it', async t => {
    const mega = fakeMega({ twoFactor: '123456' });
    const sessionFile = tempSessionFile(t);
    const connect = createMegaConnect({ sessionFile, Storage: mega.Storage });
    assert.match((await connect.handle({ op: 'signin', email: 'pb@example.com', password: '' })).error, /email and password/);
    assert.match((await connect.handle({ op: 'signin', email: 'pb@example.com', password: 'wrong' })).error, /didn't accept that email and password/);
    assert.match((await connect.handle({ op: 'signin', email: 'pb@example.com', password: 'right-pass' })).error, /two-factor/);
    assert.equal((await connect.handle({ op: 'status' })).signedIn, false);

    assert.deepEqual(await connect.handle({ op: 'signin', email: 'pb@example.com', password: 'right-pass', code: '123 456' }), { ok: true, email: 'pb@example.com' });
    const saved = fs.readFileSync(sessionFile, 'utf8');
    assert.doesNotMatch(saved, /right-pass/, 'the password is never saved');
    assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['allowWrite', 'email', 'key', 'name', 'sid', 'user']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
    assert.deepEqual(await connect.handle({ op: 'status' }), { signedIn: true, email: 'pb@example.com', allowWrite: false });

    // A restart opens the saved session without the password.
    const again = createMegaConnect({ sessionFile, Storage: mega.Storage });
    assert.ok(Array.isArray((await again.handle({ op: 'list' })).files));

    await again.handle({ op: 'signout' });
    assert.equal(mega.drive.closed.length, 1, 'MEGA\'s log-out was sent');
    assert.equal(fs.existsSync(sessionFile), false);
    assert.equal((await again.handle({ op: 'status' })).signedIn, false);
    assert.match((await again.handle({ op: 'list' })).error, /isn't signed in to MEGA/);
});

test('an expired session is forgotten and the user is told to sign in again', async t => {
    const { mega, sessionFile } = await signedIn(t);
    mega.drive.sessionValid = false;
    const fresh = createMegaConnect({ sessionFile, Storage: mega.Storage });
    assert.match((await fresh.handle({ op: 'list' })).error, /sign-in expired/);
    assert.equal((await fresh.handle({ op: 'status' })).signedIn, false);
});

test('tools are offered only when they can work', async t => {
    const none = createMegaConnect({ sessionFile: tempSessionFile(t), Storage: fakeMega().Storage });
    assert.deepEqual((await cloudOver(none).buildTools()).map(tool => tool.name), ['mega_status']);
    assert.match(await cloudOver(none).TOOLS.mega_status.run(), /Not signed in to MEGA/);

    const { connect } = await signedIn(t);
    assert.deepEqual((await cloudOver(connect).buildTools()).map(tool => tool.name), ['mega_status', 'mega_search', 'mega_read_file']);
    await connect.handle({ op: 'settings', allowWrite: true });
    assert.deepEqual((await cloudOver(connect).buildTools()).map(tool => tool.name), ['mega_status', 'mega_search', 'mega_read_file', 'mega_save_file']);
    assert.match(await cloudOver(connect).TOOLS.mega_status.run(), /Signed in to MEGA as pb@example\.com\. Agents can read files and save new files \(asking first\)/);
});

test('every MEGA tool is documented', () => {
    const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'mega-cloud.md'), 'utf8');
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const cloud = Mega.createMegaCloud({ transport: { handle: async () => ({}) } });
    assert.deepEqual(Object.keys(cloud.TOOLS), Mega.MEGA_TOOL_NAMES);
    for (const name of Mega.MEGA_TOOL_NAMES) {
        assert.ok(docs.includes(`\`${name}\``), `docs/mega-cloud.md documents ${name}`);
        assert.ok(cloud.TOOLS[name].description.length > 40, `${name} has a description`);
        assert.ok(cloud.describe(name, {}), `${name} has a step label`);
    }
    assert.match(readme, /docs\/mega-cloud\.md/);
});

test('search, folders, reading and saving read well, and saves wait for the user', async t => {
    const { mega, connect } = await signedIn(t, { allowWrite: true });
    let approve = true;
    const asked = [];
    const { TOOLS } = cloudOver(connect, { confirmWrite: async message => { asked.push(message); return approve; } });

    const top = await TOOLS.mega_search.run({});
    assert.match(top, /\[n\d+\] \/Screenshots\/\nFolder/);
    assert.doesNotMatch(top, /Rubbish|old picks/);

    const shots = await TOOLS.mega_search.run({ folder: '/screenshots' });
    assert.ok(shots.indexOf('slip-2.png') < shots.indexOf('slip-1.png'), 'newest first');
    assert.match(await TOOLS.mega_search.run({ query: 'picks' }), /\/Notes\/Bennett's picks\.md\n\d+ KB · modified 2025-10-26/);
    assert.doesNotMatch(await TOOLS.mega_search.run({ query: 'picks' }), /old picks/, 'the Rubbish Bin is left out');
    const images = await TOOLS.mega_search.run({ type: 'image' });
    assert.match(images, /slip-2\.png[\s\S]*slip-1\.png/);
    assert.doesNotMatch(images, /\.md/);
    assert.match(await TOOLS.mega_search.run({ query: 'nothing-like-this' }), /No MEGA files match "nothing-like-this"/);
    await assert.rejects(TOOLS.mega_search.run({ folder: '/Nope' }), /No MEGA folder "\/Nope"/);

    assert.match(await TOOLS.mega_read_file.run({ file: "Notes/Bennett's picks.md" }), /LeBron over 25\.5/);
    assert.match(await TOOLS.mega_read_file.run({ file: '/Screenshots/slip-1.png' }), /This is an image[\s\S]*read_screenshots[\s\S]*MEGA/);
    assert.match(await TOOLS.mega_read_file.run({ file: '/Notes' }), /\/Notes\/Bennett's picks\.md/);
    assert.match(await TOOLS.mega_read_file.run({}), /needs the file's id or path/);

    approve = false;
    assert.match(await TOOLS.mega_save_file.run({ name: 'out.md', content: '# Picks ✅' }), /declined/);
    assert.equal(mega.drive.uploads.length, 0);
    approve = true;
    assert.match(await TOOLS.mega_save_file.run({ name: 'out.md', content: '# Picks ✅', folder: '/Notes' }), /Saved "out\.md" to MEGA at \/Notes\/out\.md: https:\/\/mega\.nz\/fm\/n\d+/);
    assert.deepEqual(mega.drive.uploads[0], { name: 'out.md', folder: mega.drive.nodes.find(n => n.name === 'Notes').id, text: '# Picks ✅' });
    assert.match(asked[1], /Save a new file to your MEGA cloud drive\?\n\nName: out\.md\nFolder: \/Notes/);
    // The new file is found right away.
    assert.match(await TOOLS.mega_search.run({ query: 'out' }), /\/Notes\/out\.md/);
    assert.match((await connect.handle({ op: 'save', name: 'a/b.md', content: 'x' })).error, /without slashes/);

    // With saving off, the computer refuses even if a page asks.
    await connect.handle({ op: 'settings', allowWrite: false });
    assert.match((await connect.handle({ op: 'save', name: 'x.md', content: 'x' })).error, /Saving to MEGA is off/);
});

test('the phone keeps its own MEGA session in the page', async () => {
    const store = new Map();
    const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const mega = fakeMega();
    mega.drive.add('notes.txt', mega.drive.rootId, { text: 'hello from MEGA' });
    let loads = 0;
    const phone = Mega.phoneTransport({ storage, loadStorage: async () => { loads++; return mega.Storage; } });
    assert.equal(phone.kind, 'phone');
    assert.equal((await phone.handle({ op: 'status' })).signedIn, false);
    assert.equal(loads, 0, 'the library loads only when it is needed');
    assert.deepEqual(await phone.handle({ op: 'signin', email: 'pb@example.com', password: 'right-pass' }), { ok: true, email: 'pb@example.com' });
    assert.doesNotMatch(store.get(Mega.STORE.phoneSession), /right-pass/);
    const cloud = Mega.createMegaCloud({ transport: phone });
    assert.match(await cloud.TOOLS.mega_read_file.run({ file: 'notes.txt' }), /hello from MEGA/);
    await phone.handle({ op: 'signout' });
    assert.equal(store.size, 0);
});

test('MEGA\'s browser library loads in the page', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const page = await launched.browser.newPage();
    await page.setContent('<!doctype html><html><head></head><body></body></html>');
    await page.addScriptTag({ path: path.join(__dirname, '..', 'mobile', 'www', 'vendor', 'megajs', 'megajs.browser.js') });
    assert.equal(await page.evaluate(() => typeof window.mega.Storage.fromJSON), 'function');
});

// The real page, with server.js's /mega route served by the real module.
test('in CoDev, an agent searches MEGA and the user approves one save and declines another', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const { mega, connect } = await signedIn(t, { allowWrite: true });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-mega-page-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const backend = createMockBackend({ workspace, mega: req => connect.handle(req) });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: [
        [{ name: 'mega_search', arguments: { query: 'picks' } }],
        [{ name: 'mega_save_file', arguments: { name: 'summary.md', content: 'LeBron over 25.5', folder: '/Notes' } }],
        [{ name: 'mega_save_file', arguments: { name: 'again.md', content: 'Second one.' } }],
        'Done: found your picks in MEGA and saved a summary.'
    ] });
    await page.uncheck('#isSandboxCheckbox');
    // Autopilot off: each save asks (with it on, saves go straight through).
    await page.evaluate(() => { codeAutopilot = false; });
    const dialogs = await answerApprovals(page, () => dialogs.length === 1);
    await sendPrompt(page, 'Find my picks in MEGA and save a summary next to them.');
    await waitForChat(page, /Done: found your picks in MEGA/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(['mega_search', 'mega_read_file', 'mega_save_file'].every(name => calls[0].tools.includes(name)));
    assert.ok(!calls[0].tools.some(name => name.startsWith('drive_')), 'no Google Drive tools');
    assert.match(calls[1].messages.at(-1).content, /\/Notes\/Bennett's picks\.md/);
    assert.equal(dialogs.length, 2);
    assert.match(dialogs[0], /Save a new file to your MEGA cloud drive\?\n\nName: summary\.md\nFolder: \/Notes/);
    assert.deepEqual(mega.drive.uploads.map(u => u.name), ['summary.md']);
    assert.match(calls[3].messages.at(-1).content, /declined/);
    const steps = await page.evaluate(() => [...document.querySelectorAll('.msg-steps li')].map(li => li.textContent));
    assert.ok(steps.some(s => /☁️ Searching MEGA: picks/.test(s)));
    // Settings shows the account.
    await page.evaluate(() => { document.getElementById('settingsModal').style.display = 'flex'; document.getElementById('megaSettings').open = true; });
    await page.waitForFunction(() => /Signed in as pb@example\.com/.test(document.querySelector('#megaSettings [data-m="status"]').textContent));
    assert.deepEqual(errors, []);
});
