// The Windows app's Outlier bridge (desktop/outlier-bridge.js): the agents' tool
// list gains Outlier's tools, Outlier calls go to the pipeline with the agent's id,
// everything else to the browser, and the Outlier tab's requests reach the same
// route handlers server.js serves. Also checks that copy-bundle.js gives the
// installer a copy of the pipeline that loads on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createOutlierBridge } = require('../desktop/outlier-bridge');
const { createService } = require('../agents/outlier');

const browserHandle = async msg => (msg.method === 'tools/list'
    ? { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'browser_navigate' }] } }
    : { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `browser ran ${msg.params.name}` }] } });

test('agent tools and Outlier tab requests go through the bridge', async () => {
    const calls = [];
    const pipeline = {
        state: () => ({ liveSession: '@outlier', result: null }),
        setConfig: body => { calls.push(['config', body]); return { saved: true }; },
        scrape: async opts => { calls.push(['scrape', opts]); return { ok: true, navigated: ['NBA', '8:00 PM BOS vs NYK'] }; },
        close() {}
    };
    const bridge = createOutlierBridge({ service: createService({}, { pipeline, log: () => {} }) });

    const list = await bridge.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, browserHandle);
    const names = list.result.tools.map(t => t.name);
    assert.ok(names.includes('browser_navigate') && names.includes('outlier_scan_board'), names.join(', '));

    const scan = await bridge.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'outlier_scan_board', arguments: { sport: 'NBA', game: '8pm' }, _meta: { 'codev/agentId': '7' } } }, browserHandle);
    assert.equal(scan.id, 2);
    assert.match(scan.result.content[0].text, /^Outlier > NBA > 8:00 PM BOS vs NYK\nNo Outlier analysis yet/);
    assert.deepEqual(calls.find(c => c[0] === 'scrape')[1].pages[0].nav, { sport: 'NBA', game: '8pm' });

    const other = await bridge.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_navigate', arguments: {} } }, browserHandle);
    assert.equal(other.result.content[0].text, 'browser ran browser_navigate');

    assert.deepEqual(await bridge.request({ method: 'GET', path: '/outlier/state' }), { status: 200, body: { liveSession: '@outlier', result: null } });
    assert.deepEqual(await bridge.request({ method: 'POST', path: '/outlier/config', body: { scrolls: 10 } }), { status: 200, body: { saved: true } });
    assert.deepEqual(calls.find(c => c[0] === 'config')[1], { scrolls: 10 });
    assert.equal((await bridge.request({ method: 'GET', path: '/outlier/nope' })).status, 404);
});

test('copy-bundle.js gives the installer a pipeline that loads and finds its scripts', t => {
    const bundle = path.join(__dirname, '..', 'desktop', 'bundle');
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'desktop', 'copy-bundle.js')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
    assert.ok(fs.existsSync(path.join(bundle, 'tools', 'outlier-analytics', 'analyze.py')));
    assert.ok(!fs.existsSync(path.join(bundle, 'tools', 'outlier-analytics', 'test_analyze.py')), 'tests stay out of the installer');
    // Loads from the bundle alone, with its own page checks, and starts with a stand-in browser.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-bundle-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const check = spawnSync(process.execPath, ['-e', `
        const { createOutlierBridge } = require(${JSON.stringify(path.join(__dirname, '..', 'desktop', 'outlier-bridge.js'))});
        const { createService } = require(${JSON.stringify(path.join(bundle, 'agents', 'outlier'))});
        const manager = { registerProfile() {}, close: async () => false, peek: () => null };
        const bridge = createOutlierBridge({ service: createService({}, { log: () => {}, services: { browser: { shared: { manager, live: {} } } } }) });
        console.log(bridge.tools.map(t => t.name).join(','));
        bridge.close();
    `], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: home, APPDATA: home } });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /outlier_scan_board/);
});
