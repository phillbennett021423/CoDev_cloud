// Makes new maps with Azgaar's Fantasy Map Generator (free, MIT,
// azgaar.github.io/Fantasy-Map-Generator) for the agents' map_generate tool:
// the generator runs in a headless Chromium on this computer, the map is made from
// a seed (the same seed always gives the same map), and its full JSON export (the
// file Menu > Export > Export to JSON > Full saves) comes back to the page, which
// saves it in the project folder. Used by server.js (POST /azgaar) and the Windows
// app (IPC codev:azgaar). CODEV_AZGAAR_URL points it at another copy of the
// generator, such as one you run yourself.
const fs = require('fs');

const DEFAULT_URL = 'https://azgaar.github.io/Fantasy-Map-Generator/';
const GENERATE_TIMEOUT_MS = 180000;

// Each way to get a Chromium, tried in the same order as the agents' browsers.
async function defaultLaunch() {
    const { chromium } = require('playwright-core');
    const candidates = [];
    if (process.env.CODEV_BROWSER_PATH) candidates.push({ executablePath: process.env.CODEV_BROWSER_PATH });
    try { if (fs.existsSync(chromium.executablePath())) candidates.push({}); } catch { /* not installed */ }
    candidates.push({ channel: 'msedge' }, { channel: 'chrome' });
    let first = null;
    for (const options of candidates) {
        try { return await chromium.launch({ headless: true, ...options }); } catch (err) { first = first || err; }
    }
    throw new Error(`No Chromium to run the map generator in (${first ? first.message.split('\n')[0] : 'none found'}). Run npm run setup, or install Chrome or Edge.`);
}

// A seed Azgaar accepts: digits, as its own "New map" makes.
function seedFrom(value) {
    const text = String(value ?? '').trim();
    if (/^\d{1,12}$/.test(text)) return text;
    if (!text) return String(Math.floor(Math.random() * 1e9));
    let hash = 0;
    for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return String(hash % 1e9); // a word ("Continuum") always gives the same map
}

function createAzgaarMaps({ launch = defaultLaunch, url = process.env.CODEV_AZGAAR_URL || DEFAULT_URL, timeoutMs = GENERATE_TIMEOUT_MS, log = () => {} } = {}) {
    let running = null;

    async function generate({ seed, width, height }) {
        if (running) return { error: 'A map is already being made. Wait for it to finish.' };
        const useSeed = seedFrom(seed);
        const w = Math.min(4096, Math.max(640, Math.round(Number(width) || 1920)));
        const h = Math.min(4096, Math.max(480, Math.round(Number(height) || 1080)));
        const target = new URL(url);
        target.searchParams.set('seed', useSeed);
        target.searchParams.set('width', String(w));
        target.searchParams.set('height', String(h));
        target.searchParams.set('options', 'default');
        let browser = null;
        running = (async () => {
            browser = await launch();
            const context = await browser.newContext({ acceptDownloads: true, viewport: { width: Math.min(w, 1920), height: Math.min(h, 1080) } });
            const page = await context.newPage();
            log(`[Azgaar] Making a map from seed ${useSeed}.`);
            await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
            // The generator adds each finished map to FMG.mapHistory (what its own tests wait on).
            await page.waitForFunction(() => (window.FMG?.mapHistory?.length ?? 0) > 0, null, { timeout: timeoutMs });
            // Its own Export to JSON > Full, which saves the file as a download.
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 60000 }),
                page.evaluate(() => { window.FMG.Services.ExportJson.exportToJson('Full'); })
            ]);
            const stream = await download.createReadStream();
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const json = Buffer.concat(chunks).toString('utf8');
            let parsed;
            try { parsed = JSON.parse(json); } catch { throw new Error("The generator's export wasn't JSON."); }
            if (!parsed?.pack?.states) throw new Error("The generator's export has no states. It may have changed; export the map by hand (Menu > Export > Export to JSON > Full).");
            return { json, seed: useSeed, name: parsed.info?.mapName || parsed.settings?.mapName || 'Azgaar map', link: target.href };
        })();
        try {
            return await running;
        } catch (err) {
            const message = String(err && err.message || err);
            if (/Timeout/i.test(message)) return { error: `The map generator didn't finish in ${Math.round(timeoutMs / 1000)} seconds. Check the internet connection, or make the map at ${DEFAULT_URL} and export it by hand.` };
            if (/net::|ERR_/i.test(message)) return { error: `Couldn't open the map generator (${message.split('\n')[0]}). Check the internet connection.` };
            return { error: message.split('\n')[0] };
        } finally {
            running = null;
            if (browser) await browser.close().catch(() => {});
        }
    }

    async function handle(req = {}) {
        if (req.op === 'status') return { available: true };
        if (req.op === 'generate') return generate(req);
        return { error: 'Unknown map request.' };
    }

    return { handle };
}

module.exports = { createAzgaarMaps, seedFrom, DEFAULT_URL };
