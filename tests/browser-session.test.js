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
    assert.deepEqual(resolveAddress('outlier'), { url: 'https://app.outlier.bet/login', how: 'shortcut' });
    assert.deepEqual(resolveAddress('ESPN'), { url: 'https://www.espn.com/', how: 'shortcut' });
    assert.deepEqual(resolveAddress('espn.com/nba/scoreboard'), { url: 'https://espn.com/nba/scoreboard', how: 'address' });
    assert.deepEqual(resolveAddress('http://example.com/x?y=1'), { url: 'http://example.com/x?y=1', how: 'address' });
    assert.deepEqual(resolveAddress('localhost:8080/app'), { url: 'https://localhost:8080/app', how: 'address' });
    assert.deepEqual(resolveAddress('nba player props tonight'), { url: `${SEARCH}nba%20player%20props%20tonight`, how: 'search' });
    assert.equal(resolveAddress('rebounds').how, 'search', 'one word with no dot is a search');
    assert.throws(() => resolveAddress('file:///etc/passwd'), /Only http/);
    assert.throws(() => resolveAddress('  '), /Type an address/);
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

    // CoDev's own browsers (ids starting with @) are never an agent's.
    assert.equal(service.context({ 'codev/agentId': '@outlier' }).agentId, 'outlier');
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
});

test("Outlier opens at its sign-in portal, and saved look-alike domains go back to it", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-url-'));
    try {
        const pipeline = createOutlierPipeline({ dataDir, log: () => {} });
        assert.equal(pipeline.state().config.signInUrl, 'https://app.outlier.bet/login');
        fs.writeFileSync(pipeline.files.config, JSON.stringify({ signInUrl: 'https://www.outlier.com/login', pages: [{ kind: 'props', url: 'https://outlier.ai/props' }, { kind: 'odds', url: 'https://app.outlier.bet/odds' }] }));
        const { config } = pipeline.state();
        assert.equal(config.signInUrl, 'https://app.outlier.bet/login');
        assert.deepEqual(config.pages.map(p => p.url), ['https://app.outlier.bet/', 'https://app.outlier.bet/odds']);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
