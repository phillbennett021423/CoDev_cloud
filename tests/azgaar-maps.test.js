// Agents and Azgaar's Fantasy Map Generator: map_read over a full JSON export
// (agent-ui/azgaar-maps.js), map_generate through desktop/azgaar-map.js driving a
// stand-in for the generator's page in a real headless Chromium (the same seams the
// generator's own tests use: FMG.mapHistory and its Export to JSON > Full download),
// and one run in the real page where an agent makes a map and reads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Maps = require('../mobile/www/agent-ui/azgaar-maps.js');
const { createAzgaarMaps, seedFrom } = require('../desktop/azgaar-map');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat, answerApprovals } = require('./helpers/page-driver');

const AZGAAR = fs.readFileSync(path.join(__dirname, 'fixtures', 'azgaar-continuum.json'), 'utf8');

// A stand-in for the generator's page: it "makes" a map after a moment, then saves the
// fixture as a download when FMG.Services.ExportJson.exportToJson("Full") is called.
function fakeGenerator(t, { neverFinishes = false } = {}) {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.url);
        if (req.url.startsWith('/map.json')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(AZGAAR); }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><body><script>
            window.FMG = { mapHistory: [], Services: { ExportJson: { exportToJson(type) {
                if (type !== "Full") throw new Error("wrong type");
                fetch("/map.json").then(r => r.blob()).then(blob => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "Continuum Full.json"; document.body.appendChild(a); a.click(); });
            } } } };
            ${neverFinishes ? '' : 'setTimeout(() => window.FMG.mapHistory.push({ seed: new URLSearchParams(location.search).get("seed") }), 200);'}
        </script></body>`);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        t.after(() => server.close());
        resolve({ url: `http://127.0.0.1:${server.address().port}/Fantasy-Map-Generator/`, seen });
    }));
}

// azgaar-map.js closes the browser it launches, so each call starts a fresh one.
async function chromiumLaunch(t) {
    const probe = await launchBrowser();
    if (probe.skip) { t.skip(probe.skip); return null; }
    await probe.browser.close();
    return async () => (await launchBrowser()).browser;
}

test('map_read answers about states, cities, provinces, cultures, religions and routes', async () => {
    const { TOOLS } = Maps.createAzgaarTools({ readFile: async p => (p === 'maps/continuum.json' ? AZGAAR : null), listJson: async () => ['maps/continuum.json', 'package.json'] });
    const run = args => TOOLS.map_read.run({ map: 'maps/continuum.json', ...args });
    assert.match(await TOOLS.map_read.run({}), /^\[maps\/continuum\.json\] Map: Continuum \(seed 424242\), year 1142 of the Fractured Era\.\n2 states, 2 provinces, 3 cities/);
    assert.match(await run({}), /- Holy Aegis Dominion \(Theocracy\): capital Relay Spire, 0 people, 2 towns, 1 provinces/);
    const state = await run({ action: 'state', name: 'aegis' });
    assert.match(state, /Capital: Relay Spire/);
    assert.match(state, /Enemy: Null Expanse/);
    assert.match(state, /Wars: War of the Fracture \(1130-1138\)/);
    assert.match(state, /Largest towns: Relay Spire \(42,500\), Tessel \(6,100\)/);
    const city = await run({ action: 'city', name: 'Relay Spire' });
    assert.match(city, /State: Aegis Dominion · Province: Spirewatch · Culture: Aegian/);
    assert.match(city, /Has: capital, port, citadel, walls, market square/);
    assert.match(city, /Note: Where Relay first crossed the timelines\./);
    assert.match(await run({ action: 'cities', state: 'Aegis' }), /2 cities and towns in Aegis, largest first:\n- Relay Spire \(capital\) \(port\): 42,500/);
    assert.match(await run({ action: 'religion', name: 'Signal' }), /Deity: The First Signal/);
    assert.match(await run({ action: 'province' }), /2 provinces: /);
    assert.match(await run({ action: 'route', from: 'Relay Spire', to: 'Tessel' }), /By the routes: 447 mi \(447 mi by roads\)/);
    assert.match(await run({ action: 'route', from: 'Tessel', to: 'Hollow Gate' }), /By the routes: [\d,]+ mi \([\d,]+ mi by roads, [\d,]+ mi by searoutes\)\.\nThrough: Relay Spire/);
    assert.match(await run({ action: 'city', name: 'Atlantis' }), /No city or town named "Atlantis"/);
    assert.match(await TOOLS.map_read.run({ map: 'nope.json' }), /There's no nope\.json/);
    assert.match(Maps.loadMap('1.99|Continuum|...').error, /\.map save file/);
    // Only map-ish requests get the tools.
    assert.equal(Maps.isMapTask('how far is Tessel from Hollow Gate by road?'), true);
    assert.equal(Maps.isMapTask('make a fantasy map for my campaign'), true);
    assert.equal(Maps.isMapTask('fix the failing unit test'), false);
});

test('map_generate needs a computer and asks first', async () => {
    const phone = Maps.createAzgaarTools({ readFile: async () => null });
    assert.match(await phone.TOOLS.map_generate.run({}), /only be made by CoDev on a computer[\s\S]*Export to JSON > Full/);
    const declined = Maps.createAzgaarTools({ readFile: async () => null, generate: async () => assert.fail('not asked'), confirm: async () => false });
    assert.match(await declined.TOOLS.map_generate.run({ seed: '7' }), /said no/);
    assert.equal(seedFrom('42'), '42');
    assert.equal(seedFrom('Continuum'), seedFrom('Continuum'), 'a word always gives the same seed');
    assert.match(seedFrom('Continuum'), /^\d+$/);
});

test('the computer makes a map in a headless Chromium and gets its full JSON export', async t => {
    const launch = await chromiumLaunch(t);
    if (!launch) return;
    const gen = await fakeGenerator(t);
    const maps = createAzgaarMaps({ launch, url: gen.url, timeoutMs: 20000 });
    const made = await maps.handle({ op: 'generate', seed: 'Continuum', width: 1280, height: 720 });
    assert.ok(!made.error, made.error);
    assert.equal(made.name, 'Continuum');
    assert.equal(made.seed, seedFrom('Continuum'));
    assert.equal(made.json, AZGAAR);
    const asked = new URL(made.link);
    assert.deepEqual([asked.searchParams.get('seed'), asked.searchParams.get('width'), asked.searchParams.get('height'), asked.searchParams.get('options')], [made.seed, '1280', '720', 'default']);

    const stuck = await fakeGenerator(t, { neverFinishes: true });
    const slow = createAzgaarMaps({ launch, url: stuck.url, timeoutMs: 1500 });
    assert.match((await slow.handle({ op: 'generate', seed: '1' })).error, /didn't finish in 2 seconds/);
});

test('every map tool is documented', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const tools = Maps.createAzgaarTools({ readFile: async () => null });
    assert.deepEqual(Object.keys(tools.TOOLS), Maps.MAP_TOOL_NAMES);
    for (const name of Maps.MAP_TOOL_NAMES) {
        assert.ok(readme.includes(`\`${name}\``), `README.md documents ${name}`);
        assert.ok(tools.describe(name, {}), `${name} has a step label`);
    }
});

// The real page: server.js's /azgaar route (the real module, on the stand-in
// generator), the map saved into CoDev's workspace, then read back.
test('in CoDev, an agent makes a fantasy map and reads it', async t => {
    const launch = await chromiumLaunch(t);
    if (!launch) return;
    const gen = await fakeGenerator(t);
    const maps = createAzgaarMaps({ launch, url: gen.url, timeoutMs: 20000 });
    const launched = await launchBrowser();
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-azgaar-page-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const backend = createMockBackend({ workspace, azgaar: req => maps.handle(req) });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: [
        [{ name: 'map_generate', arguments: { seed: '424242' } }],
        [{ name: 'map_read', arguments: { action: 'route', from: 'Tessel', to: 'Hollow Gate' } }],
        'Done: made Continuum.'
    ] });
    await page.uncheck('#isSandboxCheckbox');
    const dialogs = await answerApprovals(page, () => true);
    await sendPrompt(page, 'Make me a fantasy map for my campaign and tell me how far Tessel is from Hollow Gate.');
    await waitForChat(page, /Done: made Continuum/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(calls[0].tools.includes('map_generate') && calls[0].tools.includes('map_read'));
    assert.match(calls[1].messages.at(-1).content, /Made the map "Continuum" from seed 424242[\s\S]*studio_import with source "azgaar" and path "maps\/continuum-424242\.json"/);
    assert.match(calls[2].messages.at(-1).content, /\[maps\/continuum-424242\.json\] Tessel → Hollow Gate[\s\S]*Through: Relay Spire/);
    // Autopilot is on by default: the user asked for the map, so making it doesn't ask.
    assert.equal(dialogs.length, 0);
    assert.deepEqual(errors, []);
});
