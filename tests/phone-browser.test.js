// The agents' browser on the Android app (mobile/www/agent-ui/phone-browser.js).
// The app's native side (CodevBrowserPlugin.java) is stood in for by headless
// Chromium: each "tab" is a Playwright page, so the in-page code (selectors, typing,
// the saved-login script copied out of the Java file) runs in a real browser. Sites
// are answered by page.route, so no network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { launchBrowser } = require('./helpers/page-driver');
const PhoneBrowser = require('../mobile/www/agent-ui/phone-browser.js');

const JAVA = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'codev', 'studio', 'CodevBrowserPlugin.java'), 'utf8');
// The Java string constant LOGIN_SCRIPT, as the JavaScript it becomes.
const LOGIN_SCRIPT = (() => {
    const body = /LOGIN_SCRIPT =\s*([\s\S]*?);\n/.exec(JAVA)[1];
    return body.split('\n').map(line => /^\s*"(.*)"\s*\+?\s*$/.exec(line)).filter(Boolean).map(m => JSON.parse(`"${m[1]}"`)).join('');
})();

const SITES = {
    'https://shop.test/': `<!doctype html><title>Shop</title><body><h1>Welcome to the shop</h1>
        <button id="buy" onclick="this.textContent='Bought'">Buy now</button>
        <a href="/about">About us</a>
        <form action="/search"><input name="q" aria-label="Search the shop"><button type="submit">Go</button></form>
        <div id="later"></div><script>setTimeout(() => { document.getElementById('later').textContent = 'Loaded later'; }, 300);</script></body>`,
    'https://shop.test/about': '<!doctype html><title>About</title><body><p>We sell things.</p></body>',
    'https://parked.test/': '<!doctype html><title>parked.test</title><body>This domain is for sale! Buy this domain today.</body>',
    'https://shop.test/login': `<!doctype html><title>Sign in</title><body>
        <form id="f" onsubmit="event.preventDefault(); document.title = 'step2'; this.innerHTML = '<input type=password id=pw><button>Sign in</button>'; this.onsubmit = e => { e.preventDefault(); window.signedIn = { user: window.user, pw: document.getElementById('pw').value }; document.body.innerHTML = '<p>Hello!</p>'; };">
        <input type="email" id="email" oninput="window.user = this.value"><button>Next</button></form></body>`
};

// The CodevBrowser plugin, with Playwright pages for tabs.
function createFakeNative(browser) {
    const tabs = new Map();
    const listeners = {};
    const calls = [];
    const vault = [];
    const emit = (name, event) => (listeners[name] || []).forEach(f => f(event));
    async function page(tab) {
        const p = tabs.get(tab);
        if (!p) throw new Error("That browser isn't open.");
        return p;
    }
    const info = async tab => {
        const p = await page(tab);
        return { tab, url: p.url(), title: await p.title().catch(() => ''), loading: false, status: p.__status || 0, error: p.__error || null, width: 400, height: 700 };
    };
    return {
        calls, tabs, vault,
        addListener(name, f) { (listeners[name] = listeners[name] || []).push(f); return Promise.resolve({ remove() {} }); },
        emit,
        async open({ tab }) {
            calls.push(['open', tab]);
            if (!tabs.has(tab)) {
                const p = await browser.newPage({ viewport: { width: 400, height: 700 } });
                await p.route('**/*', route => {
                    const url = route.request().url().replace(/\?.*$/, '');
                    if (SITES[url]) return route.fulfill({ status: 200, contentType: 'text/html', body: SITES[url] });
                    if (url.startsWith('https://shop.test/search')) return route.fulfill({ status: 200, contentType: 'text/html', body: `<title>Results</title><p>Results for ${new URL(route.request().url()).searchParams.get('q')}</p>` });
                    return route.fulfill({ status: 404, contentType: 'text/html', body: '<title>Not found</title>nope' });
                });
                p.on('framenavigated', frame => { if (frame === p.mainFrame()) emit('page', { tab, url: frame.url(), loading: false }); });
                tabs.set(tab, p);
                return { tab, url: 'about:blank', fresh: true, separateProfile: true };
            }
            return { ...(await info(tab)), fresh: false, separateProfile: true };
        },
        async load({ tab, url }) {
            calls.push(['load', tab, url]);
            const p = await page(tab);
            p.__error = null;
            const response = await p.goto(url, { waitUntil: 'load' }).catch(err => { p.__error = err.message; return null; });
            p.__status = response ? response.status() : 0;
            return info(tab);
        },
        info: ({ tab }) => info(tab),
        async eval({ tab, script }) {
            const p = await page(tab);
            const value = await p.evaluate(source => JSON.stringify((0, eval)(source)), script);
            return { value };
        },
        async touch({ tab, action, x, y }) {
            calls.push(['touch', tab, action]);
            const p = await page(tab);
            if (action === 'tap') await p.mouse.click(x, y);
        },
        async capture({ tab }) {
            const p = await page(tab);
            const data = (await p.screenshot({ type: 'jpeg', quality: 50 })).toString('base64');
            return { data, width: 400, height: 700, url: p.url() };
        },
        async history({ tab, op }) { const p = await page(tab); if (op === 'back') await p.goBack(); return info(tab); },
        async show({ tab }) { calls.push(['show', tab]); return info(tab); },
        async hide() { calls.push(['hide']); },
        async watch({ tab }) { calls.push(['watch', tab]); },
        async close({ tab }) { calls.push(['close', tab]); const p = tabs.get(tab); tabs.delete(tab); if (p) await p.close(); return { closed: !!p }; },
        async forgetSignIns() { calls.push(['forget']); for (const tab of [...tabs.keys()]) await this.close({ tab }); return { forgotten: true, storage: true }; },
        async vaultList() { return { credentials: vault.map(({ password, ...shown }) => shown), protector: 'androidKeystore' }; },
        async vaultAdd({ credential }) {
            const origin = new URL(credential.loginUrl).origin;
            const saved = { id: `cred_${vault.length + 1}`, label: credential.label, origin, loginUrl: credential.loginUrl, username: credential.username, password: credential.password };
            vault.push(saved);
            return { id: saved.id, label: saved.label, origin, username: saved.username };
        },
        async vaultRemove({ id }) { vault.splice(vault.findIndex(c => c.id === id), 1); },
        async vaultLogin({ tab, id, step }) {
            const credential = vault.find(c => c.id === id);
            const p = await page(tab);
            if (new URL(p.url()).origin !== credential.origin) return { refused: new URL(p.url()).origin };
            const params = { step, username: credential.username, password: credential.password, usernameSelector: '', passwordSelector: '', submitSelector: '' };
            return p.evaluate(source => (0, eval)(source), `(${LOGIN_SCRIPT})(${JSON.stringify(params)})`);
        }
    };
}

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

function setup(t) {
    if (launched.skip) { t.skip(launched.skip); return null; }
    const native = createFakeNative(launched.browser);
    const intervals = [];
    const phone = PhoneBrowser.createPhoneBrowser({ native, timers: { setInterval: (f, ms) => { const id = setInterval(f, ms); intervals.push(id); return id; }, clearInterval: id => clearInterval(id) } });
    t.after(async () => { intervals.forEach(clearInterval); for (const p of native.tabs.values()) await p.close().catch(() => {}); });
    const call = async (name, args, agentId = 'ada') => {
        const reply = await phone.browserMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'codev/agentId': agentId, 'codev/agentName': 'Ada' } } });
        return reply.result;
    };
    const textOf = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return { native, phone, call, textOf };
}

test('the phone offers the same browser tools as the desktop, minus saved sessions', async t => {
    const s = setup(t);
    if (!s) return;
    const reply = await s.phone.browserMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = reply.result.tools.map(tool => tool.name);
    for (const name of ['browser_navigate', 'browser_click', 'browser_fill', 'browser_press_key', 'browser_get_text', 'browser_wait_for', 'browser_screenshot', 'browser_close', 'browser_list_credentials', 'browser_login']) {
        assert.ok(names.includes(name), name);
    }
    assert.ok(!names.includes('browser_save_session'));
    assert.ok(reply.result.tools.find(tool => tool.name === 'browser_login')._meta['codev/requiresUserApproval']);
});

test('an agent opens, reads, taps and types on a page in its own tab', async t => {
    const s = setup(t);
    if (!s) return;
    const opened = await s.call('browser_navigate', { url: 'shop.test' });
    assert.equal(opened.isError, false, s.textOf(opened));
    assert.match(s.textOf(opened), /Opened( \(HTTP 200\))?: "Shop" at https:\/\/shop\.test\//);
    assert.match(s.textOf(opened), /Welcome to the shop/);
    assert.ok(s.native.tabs.has('a:ada'));

    const tapped = await s.call('browser_click', { selector: 'text=Buy now' });
    assert.equal(tapped.isError, false, s.textOf(tapped));
    assert.ok(s.native.calls.some(c => c[0] === 'touch' && c[2] === 'tap'), 'a real tap, not a scripted click');
    assert.equal(await s.native.tabs.get('a:ada').textContent('#buy'), 'Bought');

    const aria = await s.call('browser_get_text', { mode: 'aria' });
    assert.match(s.textOf(aria), /- heading "Welcome to the shop" \[level=1\]/);
    assert.match(s.textOf(aria), /- link "About us" \(\/about\)/);
    assert.match(s.textOf(aria), /- textbox "Search the shop"/);

    const waited = await s.call('browser_wait_for', { text: 'Loaded later', timeout_seconds: 5 });
    assert.equal(waited.isError, false, s.textOf(waited));

    const searched = await s.call('browser_fill', { selector: 'role=textbox[name="Search the shop"]', value: 'red shoes', submit: true });
    assert.equal(searched.isError, false, s.textOf(searched));
    await s.native.tabs.get('a:ada').waitForURL(/search/);
    const results = await s.call('browser_get_text', {});
    assert.match(s.textOf(results), /Results for red shoes/);

    const missing = await s.call('browser_click', { selector: '#nothing-here' });
    assert.equal(missing.isError, true);
    assert.match(s.textOf(missing), /No element matches #nothing-here/);

    const shot = await s.call('browser_screenshot', {});
    assert.equal(shot.content[0].type, 'image');
    assert.equal(shot.content[0].mimeType, 'image/jpeg');
});

test("the phone's own addresses are off limits", async t => {
    const s = setup(t);
    if (!s) return;
    const reply = await s.call('browser_navigate', { url: 'http://localhost:3000/' });
    assert.equal(reply.isError, true);
    assert.match(s.textOf(reply), /on the phone itself/);
});

test('a parked domain pauses the browser for the user instead of failing', async t => {
    const s = setup(t);
    if (!s) return;
    const events = [];
    s.phone.onBrowserLive(event => events.push(event));
    const reply = await s.call('browser_navigate', { url: 'https://parked.test/' });
    assert.equal(reply.isError, true);
    assert.match(s.textOf(reply), /parked or for-sale domain/);
    assert.match(s.textOf(reply), /paused and left open/);
    assert.ok(events.some(e => e.type === 'paused' && e.agentId === 'ada'));
    const closing = await s.call('browser_close', {});
    assert.match(s.textOf(closing), /paused for the user/);
});

test('saved logins: the user approves, the app types the password on its own site only', async t => {
    const s = setup(t);
    if (!s) return;
    const added = await s.phone.browserMcp({ jsonrpc: '2.0', id: 1, method: 'codev/vault', params: { op: 'addCredential', credential: { label: 'Shop', loginUrl: 'https://shop.test/login', username: 'ada@example.com', password: 'hunter2-secret' } } });
    assert.equal(added.result.origin, 'https://shop.test');
    const listed = await s.call('browser_list_credentials', {});
    assert.match(s.textOf(listed), /cred_1: Shop on https:\/\/shop\.test as ada@example\.com/);
    assert.doesNotMatch(s.textOf(listed), /hunter2/);

    const asked = await s.call('browser_login', { credential_id: 'cred_1' });
    const approval = asked._meta['codev/approvalRequired'];
    assert.match(approval.prompt, /Ada wants to sign in to https:\/\/shop\.test as ada@example\.com/);
    const done = await s.phone.browserMcp({ jsonrpc: '2.0', id: 2, method: 'codev/approve', params: { id: approval.id, approved: true } });
    assert.equal(done.result.isError, false, s.textOf(done.result));
    assert.match(s.textOf(done.result), /Signed in to https:\/\/shop\.test as ada@example\.com/);
    assert.doesNotMatch(JSON.stringify(done), /hunter2/);
    const signedIn = await s.native.tabs.get('a:ada').evaluate(() => window.signedIn);
    assert.deepEqual(signedIn, { user: 'ada@example.com', pw: 'hunter2-secret' });

    const wrongSite = await s.call('browser_login', { credential_id: 'cred_1', url: 'https://other.test/login' });
    assert.equal(wrongSite.isError, true);
    assert.match(s.textOf(wrongSite), /only for https:\/\/shop\.test/);

    const declined = await s.call('browser_login', { credential_id: 'cred_1' });
    const no = await s.phone.browserMcp({ jsonrpc: '2.0', id: 3, method: 'codev/approve', params: { id: declined._meta['codev/approvalRequired'].id, approved: false } });
    assert.match(s.textOf(no.result), /declined/);
});

test('live view: frames, take over full screen, the agent in a background tab, hand back', async t => {
    const s = setup(t);
    if (!s) return;
    const events = [];
    s.phone.onBrowserLive(event => events.push(event));
    await s.phone.browserLive({ op: 'watch', agentId: 'ada' });
    await s.phone.browserLive({ op: 'control', agentId: 'ada', control: { op: 'open', url: 'shop.test' } });
    assert.ok(s.native.tabs.has('a:ada'));
    const frame = await (async () => {
        for (let i = 0; i < 50; i++) { const f = events.find(e => e.type === 'frame'); if (f) return f; await new Promise(r => setTimeout(r, 100)); }
        return null;
    })();
    assert.ok(frame, 'a picture of the page arrives');
    assert.equal(frame.width, 400);

    // The user's own typing and taps from the picture reach the page.
    await s.phone.browserLive({ op: 'control', agentId: 'ada', control: { op: 'down', x: 10, y: 10 } });
    const box = await s.native.tabs.get('a:ada').locator('input[name=q]').boundingBox();
    await s.native.tabs.get('a:ada').mouse.click(box.x + 5, box.y + 5);
    await s.phone.browserLive({ op: 'control', agentId: 'ada', control: { op: 'text', text: 'hats' } });
    assert.equal(await s.native.tabs.get('a:ada').inputValue('input[name=q]'), 'hats');

    await s.phone.browserLive({ op: 'control', agentId: 'ada', control: { op: 'takeover' } });
    assert.ok(s.native.calls.some(c => c[0] === 'show' && c[1] === 'a:ada'), 'Take over shows the real browser');
    assert.ok(events.some(e => e.type === 'state' && e.userControl === true));

    // While the user has it, the agent works in a background tab that starts on the user's page.
    const opened = await s.call('browser_navigate', { url: 'https://shop.test/about' });
    assert.equal(opened.isError, false, s.textOf(opened));
    assert.ok(s.native.tabs.has('w:ada'));
    assert.equal(s.native.tabs.get('a:ada').url(), 'https://shop.test/');

    // The app's own Hand back button: the agent's tab becomes the one shown.
    s.native.emit('handback', { tab: 'a:ada' });
    for (let i = 0; i < 20 && s.native.tabs.has('a:ada'); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(!s.native.tabs.has('a:ada'), "the user's tab closes");
    const read = await s.call('browser_get_text', {});
    assert.match(s.textOf(read), /We sell things/);
    assert.ok(events.some(e => e.type === 'state' && e.userControl === false));

    const closing = await s.call('browser_close', {});
    assert.match(s.textOf(closing), /stays open for them/);

    const forgot = await s.phone.browserLive({ op: 'forget-signins', agentId: 'ada' });
    assert.equal(forgot.forgotten, true);
    assert.equal(s.native.tabs.size, 0);
});

test('addresses typed in the live view resolve like the desktop address bar', () => {
    assert.equal(PhoneBrowser.resolveAddress('espn.com').url, 'https://espn.com/');
    assert.equal(PhoneBrowser.resolveAddress('outlierbet.com').url, 'https://app.outlier.bet/login');
    assert.match(PhoneBrowser.resolveAddress('best running shoes').url, /^https:\/\/duckduckgo\.com\/\?q=best%20running%20shoes$/);
    assert.equal(PhoneBrowser.checkLoaded({ url: 'https://x.test/', error: 'net::ERR_NAME_NOT_RESOLVED' }, '').ok, false);
    assert.equal(PhoneBrowser.checkLoaded({ url: 'https://x.test/', status: 0 }, 'Hello').ok, true);
});

// The real page, as the Android app loads it: with the CodevBrowser plugin present, the
// computer button and the saved-logins settings appear, as they do in the Windows app.
test('the CoDev page uses the phone browser when the app has it', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const www = path.join(__dirname, '..', 'mobile', 'www');
    const server = http.createServer((req, res) => {
        const file = path.join(www, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
        if (!file.startsWith(www) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const page = await launched.browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => {
        localStorage.setItem('codev_groq_key', 'gsk_test');
        localStorage.setItem('codev_backend', 'groq');
        const calls = [];
        window.__pluginCalls = calls;
        const plugin = new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : async args => {
            calls.push(name);
            if (name === 'vaultList') return { credentials: [], protector: 'androidKeystore' };
            if (name === 'addListener') return { remove() {} };
            return {};
        }) });
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { CodevBrowser: plugin } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('liveViewBtn').style.display === '', null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => isPhoneBrowser), true);
    await page.evaluate(() => refreshBrowserVault());
    await page.waitForFunction(() => document.getElementById('browserSettings').style.display === '', null, { timeout: 5000 });
    assert.match(await page.textContent('#browserVaultStatus'), /phone's secure key store/);
    assert.deepEqual(errors, []);
});
