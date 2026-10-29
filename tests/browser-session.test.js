// The browser session layer: what an address bar turns typed text into, the
// check that flags dead links and parked "domain for sale" pages, and the two-way
// control of one browser: the user opens and drives it from the live view, an
// agent gets it back, and the Outlier pipeline reads whatever page is open in its
// signed-in browser. The parts that need Chromium or Python skip when missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveAddress, checkPage, SEARCH } = require('../desktop/browser/page-check');
const { createBrowserService } = require('../desktop/browser');
const { createOutlierPipeline, createService } = require('../agents/outlier');
const { launchBrowser } = require('./helpers/page-driver');

const BOARD = fs.readFileSync(path.join(__dirname, 'fixtures', 'outlier-board.html'), 'utf8');
const hasPython = ['python3', 'python'].some(cmd => spawnSync(cmd, ['--version']).status === 0);
const PARKED = '<html><head><title>example-odds.com</title></head><body><h1>example-odds.com</h1><p>This domain is for sale! Buy this domain today.</p></body></html>';

test('typed text becomes an address, a shortcut or a search', () => {
    assert.equal(resolveAddress('outlier.com').url, 'https://app.outlier.bet/login', 'outlier.com typed on its own means the betting app');
    assert.equal(resolveAddress('https://outlier.com/careers').url, 'https://outlier.com/careers', 'a full address still opens that site');
    assert.deepEqual(resolveAddress('outlier'), { url: 'https://app.outlier.bet/login', how: 'shortcut' });
    assert.deepEqual(resolveAddress('ESPN'), { url: 'https://www.espn.com/', how: 'shortcut' });
    assert.deepEqual(resolveAddress('espn.com/nba/scoreboard'), { url: 'https://espn.com/nba/scoreboard', how: 'address' });
    assert.deepEqual(resolveAddress('http://example.com/x?y=1'), { url: 'http://example.com/x?y=1', how: 'address' });
    assert.deepEqual(resolveAddress('localhost:8080/app'), { url: 'https://localhost:8080/app', how: 'address' });
    assert.deepEqual(resolveAddress('nba player props tonight'), { url: `${SEARCH}nba%20player%20props%20tonight`, how: 'search' });
    assert.equal(resolveAddress('rebounds').how, 'search', 'one word with no dot is a search');
    assert.throws(() => resolveAddress('file:///etc/passwd'), /Only http/);
    assert.throws(() => resolveAddress('  '), /Type an address/);
    // outlierbet.com isn't Outlier: typed or linked, it goes to the real sign-in portal.
    assert.equal(resolveAddress('outlierbet.com').url, 'https://app.outlier.bet/login');
    assert.equal(resolveAddress('https://www.outlierbet.com/props?x=1').url, 'https://app.outlier.bet/login');
    assert.equal(resolveAddress('www.outlierbet.com').url, 'https://app.outlier.bet/login');
});

// A stand-in web: a real page, a parked one, a redirect to a parking host's
// look-alike, a 404, and the Outlier board.
async function startSite(t) {
    const server = http.createServer((req, res) => {
        const html = body => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); };
        if (req.url === '/ok') return html('<title>Odds</title><h1>Tonight\'s odds</h1>');
        if (req.url === '/parked') return html(PARKED);
        if (req.url === '/board') return html(BOARD);
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>Not found</h1>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
}

test('dead links and parked domains are told apart from real pages', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const base = await startSite(t);
    const page = await launched.browser.newPage();
    assert.equal((await checkPage(page, await page.goto(`${base}/ok`))).ok, true);
    const parked = await checkPage(page, await page.goto(`${base}/parked`));
    assert.equal(parked.kind, 'parked');
    const missing = await checkPage(page, await page.goto(`${base}/gone`));
    assert.equal(missing.kind, 'dead');
    assert.match(missing.problem, /404/);
    const err = await page.goto('http://no-such-host.invalid/').then(() => null, e => e);
    assert.equal((await checkPage(page, null, { error: err })).kind, 'dead');
    // A long real page that happens to mention a domain sale isn't flagged.
    const article = await launched.browser.newPage();
    await article.setContent(`<p>${'Real article text. '.repeat(300)}</p><p>This domain is for sale</p>`);
    assert.equal((await checkPage(article, null)).ok, true);
});

test('the user opens and drives a browser while the agent works in a background tab', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const base = await startSite(t);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-session-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const service = createBrowserService({ dataDir, profileRoot: path.join(dataDir, 'profiles'), passphrase: 'test', log: () => {} });
    t.after(() => service.close());
    const ctx = service.context({ 'codev/agentId': 'agent-1' });
    const warnings = [];
    service.live.subscribe('agent-1', update => { if (update.type === 'warning') warnings.push(update.text); });

    // No browser yet: typing an address in the live view opens one and gives the user control.
    assert.equal(service.manager.peek('agent-1'), null);
    const opened = await service.live.control('agent-1', { op: 'navigate', url: `${base}/ok` });
    assert.equal(opened.url, `${base}/ok`);
    assert.equal(opened.warning, undefined);
    assert.equal(service.live.isUserControlled('agent-1'), true);

    // A parked page opens (the user sees it) but comes back with a warning.
    const parked = await service.live.control('agent-1', { op: 'navigate', url: `${base}/parked` });
    assert.match(parked.warning, /parked or for-sale/);
    assert.equal(warnings.length, 1);

    // While the user drives, the agent reads the user's page, and acts in a background
    // tab of the same browser: the user's tab and control are untouched.
    await service.live.control('agent-1', { op: 'navigate', url: `${base}/board` });
    const read = await service.callTool('browser_get_text', {}, ctx);
    assert.equal(read.isError, false, read.content[0].text);
    assert.match(read.content[0].text, /Nikola Jokic/);
    const userTab = service.manager.peek('agent-1').page;
    const acted = await service.callTool('browser_navigate', { url: `${base}/ok` }, ctx);
    assert.equal(acted.isError, false, acted.content[0].text);
    assert.equal(userTab.url(), `${base}/board`, "the user's tab stays where the user left it");
    assert.equal(service.manager.peek('agent-1').page, userTab, 'the live view still shows the user');
    assert.equal(service.live.isUserControlled('agent-1'), true, 'the user keeps control');
    assert.match((await service.callTool('browser_get_text', {}, ctx)).content[0].text, /Tonight's odds/, 'the agent reads its own tab');
    // Handing back shows what the agent was doing.
    await service.live.control('agent-1', { op: 'release' });
    assert.equal(service.manager.peek('agent-1').page.url(), `${base}/ok`);

    // The agent's own navigation gets the same dead/parked check.
    const nav = await service.callTool('browser_navigate', { url: `${base}/parked` }, ctx);
    assert.equal(nav.isError, true);
    assert.match(nav.content[0].text, /not a working site/);
    // ...and instead of failing closed, the browser stays open on that page, paused for the user.
    const paused = [];
    service.live.subscribe('', update => { if (update.type === 'paused') paused.push(update); });
    assert.match(nav.content[0].text, /paused and left open/);
    const session = service.manager.peek('agent-1');
    assert.ok(session && session.paused, 'still open, paused');
    assert.equal(session.page.url(), `${base}/parked`, 'the live view shows the parked page');
    assert.equal(service.live.isUserControlled('agent-1'), true, 'the user has it');
    const closing = await service.callTool('browser_close', {}, ctx);
    assert.equal(closing.isError, true);
    assert.ok(service.manager.peek('agent-1'), "the agent can't close it while it's paused");
    await service.live.control('agent-1', { op: 'navigate', url: `${base}/ok` });
    await service.live.control('agent-1', { op: 'release' });
    assert.equal(service.manager.peek('agent-1').paused, null, 'handing back ends the pause');
    // A second pause reaches someone watching only the list, so the page can open that browser.
    await service.callTool('browser_navigate', { url: `${base}/gone` }, ctx);
    assert.equal(paused.length, 1);
    assert.equal(paused[0].agentId, 'agent-1');

    // CoDev's own browsers (ids starting with @) are never an agent's.
    assert.equal(service.context({ 'codev/agentId': '@outlier' }).agentId, 'outlier');
});

test('a browser the user has used stays open until the user closes it', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const base = await startSite(t);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-owned-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const { createBrowserManager } = require('../desktop/browser/browser-manager');
    const { createLiveView } = require('../desktop/browser/live-view');
    const manager = createBrowserManager({ profileRoot: path.join(dataDir, 'profiles'), maxSessions: 1, idleMs: -1, log: () => {} });
    t.after(() => manager.closeAll());
    const live = createLiveView({ manager, isBlockedUrl: () => false, log: () => {} });
    const service = createBrowserService({ dataDir, profileRoot: path.join(dataDir, 'profiles2'), passphrase: 'test', log: () => {} });
    t.after(() => service.close());

    // An agent's browser nobody has used or watched still closes when idle.
    await manager.get('agent-1');
    manager.sweepIdle();
    assert.equal(manager.peek('agent-1'), null);

    // The user opens one in the live view, hands it back and walks away: it stays open.
    await live.control('agent-1', { op: 'navigate', url: `${base}/ok` });
    await live.control('agent-1', { op: 'release' });
    assert.equal(manager.list()[0].userOwned, true);
    manager.sweepIdle();
    assert.ok(manager.peek('agent-1'), 'no idle close');
    // Another agent needing a browser past the limit doesn't take it away either.
    await manager.get('agent-2');
    assert.ok(manager.peek('agent-1'), 'not closed to make room');
    assert.ok(manager.peek('agent-2'));
    // Watching alone keeps an idle browser open.
    const stop = live.subscribe('agent-2', () => {});
    manager.sweepIdle();
    assert.ok(manager.peek('agent-2'), 'watched, so kept');
    stop();
    manager.sweepIdle();
    assert.equal(manager.peek('agent-2'), null, 'closes once nobody watches or used it');

    // The agent saying it's done leaves the user's browser open.
    const ctx = service.context({ 'codev/agentId': 'agent-3' });
    await service.live.control('agent-3', { op: 'navigate', url: `${base}/ok` });
    const done = await service.callTool('browser_close', {}, ctx);
    assert.equal(done.isError, false);
    assert.match(done.content[0].text, /stays open for them/);
    assert.ok(service.manager.peek('agent-3'));
    // The user's own close button closes it.
    assert.deepEqual(await service.live.control('agent-3', { op: 'close' }), { ok: true });
    assert.equal(service.manager.peek('agent-3'), null);
});

test("agents' browsers keep their sign-ins between sessions until they are forgotten", async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const base = await startSite(t);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-keep-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const start = opts => createBrowserService({ dataDir, profileRoot: path.join(dataDir, 'profiles'), passphrase: 'test', log: () => {}, ...opts });
    const signedIn = async service => {
        const page = await service.manager.workPage('agent-1');
        await page.goto(`${base}/ok`);
        return page.evaluate(() => ({ cookie: document.cookie, token: localStorage.getItem('token') }));
    };

    let service = start();
    assert.equal(service.manager.keepsSignIns, true);
    const page = await service.manager.workPage('agent-1');
    await page.goto(`${base}/ok`);
    await page.evaluate(() => { document.cookie = 'session=abc; max-age=86400; path=/'; localStorage.setItem('token', 'xyz'); });
    await service.close();
    assert.ok(fs.existsSync(path.join(dataDir, 'browser-profiles', 'agent-1')), 'the profile is kept in the app-data folder');

    // A new CoDev run (a new service) opens the same agent's browser still signed in.
    service = start();
    assert.deepEqual(await signedIn(service), { cookie: 'session=abc', token: 'xyz' });
    // Another agent doesn't see it.
    const other = await service.manager.workPage('agent-2');
    await other.goto(`${base}/ok`);
    assert.equal(await other.evaluate(() => document.cookie), '');

    // Forgetting closes that browser and deletes its profile.
    assert.deepEqual(await service.manager.forgetSignIns('agent-1'), { forgotten: 1 });
    assert.equal(service.manager.peek('agent-1'), null);
    assert.deepEqual(await signedIn(service), { cookie: '', token: null });
    await service.close();

    // CODEV_BROWSER_KEEP_SIGNINS=0 (keepSignIns: false): temporary profiles, deleted on close.
    service = start({ keepSignIns: false });
    assert.equal(service.manager.keepsSignIns, false);
    const temp = await service.manager.get('agent-3');
    const dir = temp.dir;
    await service.close();
    assert.equal(fs.existsSync(dir), false);
});

test("Read this page parses whatever is open in the signed-in Outlier browser", async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const base = await startSite(t);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-session-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const browser = createBrowserService({ dataDir, profileRoot: path.join(dataDir, 'profiles'), passphrase: 'test', log: () => {} });
    t.after(() => browser.close());
    const pipeline = createOutlierPipeline({ dataDir: path.join(dataDir, 'outlier'), shared: { manager: browser.manager, live: browser.live }, log: () => {} });
    const service = createService({}, { pipeline });
    assert.equal(pipeline.state().liveSession, '@outlier');

    await assert.rejects(pipeline.readOpenPage(), /isn't open/);
    // The user browses to the board in the live view, in the kept Outlier profile.
    await browser.live.control('@outlier', { op: 'navigate', url: `${base}/board` });
    assert.equal(browser.manager.peek('@outlier').dir, pipeline.files.profile, 'the signed-in profile, not a throwaway one');
    const read = await pipeline.readOpenPage();
    assert.equal(read.props.length, 4);
    const state = pipeline.state();
    assert.equal(state.result.counts.props, 4);

    // An agent runs the same extraction on its own browser, never the signed-in one.
    const agentCtx = browser.context({ 'codev/agentId': 'agent-2' });
    await browser.callTool('browser_navigate', { url: `${base}/board` }, agentCtx);
    const reply = await service.callTool('outlier_extract_page', {}, { agentId: 'agent-2' });
    assert.equal(reply.isError, undefined, reply.content[0].text);
    assert.equal(JSON.parse(reply.content[0].text).props.length, 4);
    const sneaky = await service.callTool('outlier_extract_page', {}, { agentId: '@outlier' });
    assert.equal(sneaky.isError, true, "an agent can't read the signed-in browser");

    // Passive capture: props on the open page go to the scratchpad and the latest read
    // while the user scrolls; the user's page and control stay theirs.
    fs.rmSync(pipeline.files.scrape, { force: true });
    assert.equal(typeof service.routes['POST /outlier/capture'], 'function');
    const captured = await pipeline.setCapture({ on: true });
    assert.equal(captured.capture.on, true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    await pipeline.capture.drain();
    assert.equal(pipeline.state().capture.props, 4);
    assert.equal(JSON.parse(fs.readFileSync(pipeline.files.scrape, 'utf8')).props.length, 4);
    assert.equal(browser.manager.peek('@outlier').page.url(), `${base}/board`);
    assert.equal((await pipeline.setCapture({ on: false, clear: true })).capture.props, 0);
    await pipeline.close();
});

test("Outlier opens at its sign-in portal, and saved look-alike domains go back to it", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-url-'));
    try {
        const pipeline = createOutlierPipeline({ dataDir, log: () => {} });
        assert.equal(pipeline.state().config.signInUrl, 'https://app.outlier.bet/login');
        fs.writeFileSync(pipeline.files.config, JSON.stringify({ signInUrl: 'https://outlierbet.com/', pages: [{ kind: 'props', url: 'https://outlier.ai/props' }, { kind: 'odds', url: 'https://app.outlier.bet/odds' }] }));
        const { config } = pipeline.state();
        assert.equal(config.signInUrl, 'https://app.outlier.bet/login');
        assert.deepEqual(config.pages.map(p => p.url), ['https://app.outlier.bet/', 'https://app.outlier.bet/odds']);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('a scrape that hits a parked or dead page leaves the Outlier browser open for the user', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const base = await startSite(t);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-session-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const browser = createBrowserService({ dataDir, profileRoot: path.join(dataDir, 'profiles'), passphrase: 'test', log: () => {} });
    t.after(() => browser.close());
    const pipeline = createOutlierPipeline({ dataDir: path.join(dataDir, 'outlier'), shared: { manager: browser.manager, live: browser.live }, log: () => {} });
    fs.mkdirSync(path.join(dataDir, 'outlier'), { recursive: true });
    const write = url => fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, scrolls: 1, market: false }));

    write(`${base}/parked`);
    await assert.rejects(pipeline.scrape(), /paused on that page/);
    let session = browser.manager.peek('@outlier');
    assert.ok(session && session.paused, 'left open and paused');
    assert.equal(session.page.url(), `${base}/parked`);
    assert.equal(browser.live.isUserControlled('@outlier'), true);

    // Paused while the user had it: the scrape ran in a background tab, which now shows.
    await browser.live.control('@outlier', { op: 'navigate', url: `${base}/somewhere` });
    write(`${base}/gone`);
    await assert.rejects(pipeline.scrape(), /paused on that page/);
    session = browser.manager.peek('@outlier');
    assert.equal(session.page.url(), `${base}/gone`, 'the failing tab is shown, not closed');
});
