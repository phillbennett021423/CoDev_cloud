// The agents' browsers look like the ordinary Chrome or Edge they are, so sites like
// Google don't refuse to sign in: no "HeadlessChrome" user agent (in the page or in
// requests), no navigator.webdriver. Skips when there is no Chromium to start.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createBrowserManager, ordinaryUserAgent } = require('../desktop/browser/browser-manager');

test('ordinaryUserAgent drops "Headless"', () => {
    assert.equal(ordinaryUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'),
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
});

test("an agent's browser presents itself as a normal browser", async t => {
    let headers = null;
    const site = http.createServer((req, res) => {
        headers = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Who am I</title>');
    });
    await new Promise(r => site.listen(0, '127.0.0.1', r));
    t.after(() => site.close());
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-identity-'));
    const manager = createBrowserManager({ profileRoot, log: () => {} });
    t.after(async () => { await manager.closeAll(); fs.rmSync(profileRoot, { recursive: true, force: true }); });
    let session;
    try { session = await manager.get('identity'); } catch (err) {
        return t.skip(`no browser could start: ${String(err.message).split('\n')[0]}`);
    }
    await session.page.goto(`http://127.0.0.1:${site.address().port}/`);
    const seen = await session.page.evaluate(() => ({ userAgent: navigator.userAgent, webdriver: navigator.webdriver }));
    assert.doesNotMatch(seen.userAgent, /Headless/);
    assert.match(seen.userAgent, /Chrome\/\d+/);
    assert.equal(seen.webdriver, false);
    assert.equal(headers['user-agent'], seen.userAgent);
});
