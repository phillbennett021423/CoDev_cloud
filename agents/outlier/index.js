// The Outlier pipeline as a server.js agent-tools service: read the signed-in
// Outlier pages, turn them into props (extract.js), score them and build 4- and
// 6-leg entries (tools/outlier-analytics/analyze.py), and tune the filters from
// the entries' results. The page drives it through the /outlier/ routes; agents
// only get a read-only tool for the latest entries.
//
// Unlike the agents' browsers, which start empty and are deleted, this pipeline
// keeps ONE browser profile of its own so the Outlier sign-in carries over. It
// lives in this user's app-data folder (never the repo), only ever opens the
// pages in config.json, and no agent can drive it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { collectPage, parseCollected, propId } = require('./extract');

const ANALYTICS = path.join(__dirname, '..', '..', 'tools', 'outlier-analytics', 'analyze.py');
const DEFAULT_CONFIG = {
    signInUrl: 'https://app.outlier.bet/',
    // kind: props (prop cards and boards), odds (odds boards), slips or history (settled entries).
    pages: [{ kind: 'props', url: 'https://app.outlier.bet/' }],
    // { row: 'css', fields: { player, market, line, odds, hitRates } } when the
    // generic parser misses something; see README.
    selectors: null,
    showBrowser: false,
    settleMs: 2500,
    scrolls: 6
};
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;

function serverDataDir() {
    if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'codev-server');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'codev-server');
}

function loadPlaywright() {
    try { return require('playwright-core'); } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') throw err;
        return null;
    }
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
}

function isLoopback(host) {
    return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
}

// Runs analyze.py. CODEV_PYTHON wins; otherwise python3/python (py on Windows).
function runPython(args, { python = process.env.CODEV_PYTHON, timeoutMs = 120000 } = {}) {
    const candidates = python ? [python] : process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
    return new Promise((resolve, reject) => {
        const tryNext = i => {
            if (i >= candidates.length) return reject(new Error('Python was not found. Install Python 3 (python.org) or set CODEV_PYTHON to its path, then try again.'));
            const child = spawn(candidates[i], [ANALYTICS, ...args], { windowsHide: true });
            let stderr = '';
            const timer = setTimeout(() => child.kill(), timeoutMs);
            child.stderr.on('data', d => { stderr += d; });
            child.on('error', err => { clearTimeout(timer); if (err.code === 'ENOENT') tryNext(i + 1); else reject(err); });
            child.on('close', code => {
                clearTimeout(timer);
                if (code === 0) resolve();
                // The Windows Store "python" stub exits 9009 when Python isn't really installed.
                else if (code === 9009) tryNext(i + 1);
                else reject(new Error(`The analytics script failed: ${stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`));
            });
        };
        tryNext(0);
    });
}

function sameLeg(a, b) {
    const norm = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9.]+/g, '');
    return norm(a.player) === norm(b.player) && Number(a.line) === Number(b.line) && (a.side || 'over') === (b.side || 'over')
        && (!a.market || !b.market || norm(a.market) === norm(b.market));
}

function createOutlierPipeline({ dataDir = path.join(serverDataDir(), 'outlier'), playwright = loadPlaywright(), python,
    blockedPorts = [3000, Number(process.env.PORT) || 3000, 8787], log = console.log } = {}) {
    const files = {
        profile: path.join(dataDir, 'profile'),
        config: path.join(dataDir, 'config.json'),
        scrape: path.join(dataDir, 'latest-scrape.json'),
        result: path.join(dataDir, 'latest-result.json'),
        history: path.join(dataDir, 'history.json'),
        weights: path.join(dataDir, 'weights.json'),
        learn: path.join(dataDir, 'learn-report.json'),
        // Every price seen for each prop, with times: line movement and closing line value.
        marketLog: path.join(dataDir, 'market-log.json'),
        snapshots: path.join(dataDir, 'snapshots')
    };
    // busy: what the one browser is doing ('signin' | 'scrape' | 'snapshot'); the
    // profile can't be open twice. signedIn: what the last visit found (null = unknown).
    const state = { busy: null, signedIn: null, lastError: null, lastRun: null, signInContext: null };
    const blocked = new Set(blockedPorts.map(String));

    const config = () => ({ ...DEFAULT_CONFIG, ...readJson(files.config, {}) });

    function setConfig(update = {}) {
        const next = config();
        if (typeof update.signInUrl === 'string') next.signInUrl = checkUrl(update.signInUrl);
        if (Array.isArray(update.pages)) {
            next.pages = update.pages.map(p => ({ kind: ['props', 'odds', 'slips', 'history'].includes(p.kind) ? p.kind : 'props', url: checkUrl(p.url) }));
        }
        if (update.selectors === null || (update.selectors && typeof update.selectors.row === 'string')) next.selectors = update.selectors;
        if (typeof update.showBrowser === 'boolean') next.showBrowser = update.showBrowser;
        writeJson(files.config, next);
        return next;
    }

    // Only real web pages: never a file:// path or CoDev's own server.
    function checkUrl(value) {
        let url;
        try { url = new URL(String(value).trim()); } catch { throw new Error(`Not a web address: ${value}`); }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Only http(s) pages: ${value}`);
        if (isLoopback(url.hostname)) throw new Error(`The Outlier browser can't open this computer's own addresses: ${value}`);
        return url.href;
    }

    function launchCandidates() {
        const list = [];
        if (process.env.CODEV_BROWSER_PATH) list.push({ label: 'CODEV_BROWSER_PATH', options: { executablePath: process.env.CODEV_BROWSER_PATH } });
        // A real Chrome or Edge first: the same browser for signing in and for reading.
        list.push({ label: 'Google Chrome', options: { channel: 'chrome' } }, { label: 'Microsoft Edge', options: { channel: 'msedge' } });
        let bundled = '';
        try { bundled = playwright.chromium.executablePath(); } catch { bundled = ''; }
        if (bundled && fs.existsSync(bundled)) list.push({ label: "Playwright's Chromium", options: {} });
        return list;
    }

    async function launch({ headless }) {
        if (!playwright) throw new Error('The Outlier pipeline needs playwright-core: run "npm install" (or npm run setup), then restart CoDev.');
        fs.mkdirSync(files.profile, { recursive: true });
        const failures = [];
        for (const candidate of launchCandidates()) {
            try {
                const context = await playwright.chromium.launchPersistentContext(files.profile, {
                    headless, viewport: headless ? { width: 1366, height: 900 } : null, acceptDownloads: false,
                    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
                    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
                    ...candidate.options
                });
                // A page can't send this browser to CoDev's own server.
                await context.route(url => isLoopback(url.hostname) && blocked.has(url.port || '80'), route => route.abort('blockedbyclient'));
                return context;
            } catch (err) {
                failures.push(`${candidate.label}: ${String(err.message).split('\n')[0]}`);
            }
        }
        throw new Error(`No browser could start for Outlier. Install Chrome or run "npx playwright install chromium".\n${failures.join('\n')}`);
    }

    function claim(what) {
        if (state.busy) throw new Error(state.busy === 'signin'
            ? 'The Outlier sign-in window is still open. Finish signing in and close it first.'
            : `The Outlier browser is busy (${state.busy}). Try again in a moment.`);
        state.busy = what;
        state.lastError = null;
    }

    // Opens a visible window on this computer with the pipeline's profile. The
    // user signs in to Outlier and closes it; the cookie stays in the profile.
    async function signIn() {
        claim('signin');
        let context;
        try {
            context = await launch({ headless: false });
        } catch (err) {
            state.busy = null;
            state.lastError = err.message;
            throw err;
        }
        state.signInContext = context;
        const page = context.pages()[0] || await context.newPage();
        page.goto(config().signInUrl).catch(() => { /* the user can type the address */ });
        const done = () => {
            if (state.signInContext !== context) return;
            state.signInContext = null;
            state.busy = null;
            state.signedIn = null; // checked on the next read
            log('[Outlier] Sign-in window closed.');
        };
        context.on('close', done);
        setTimeout(() => { if (state.signInContext === context) context.close().catch(done); }, SIGN_IN_WAIT_MS).unref();
        return { started: true, detail: 'A browser window opened. Sign in to Outlier there, then close the window.' };
    }

    function looksSignedOut(page, collected) {
        const url = page.url();
        return /\/(login|log-in|signin|sign-in|signup|sign-up|auth)(\/|\?|$)/i.test(new URL(url).pathname)
            || Boolean(collected && collected.passwordField);
    }

    // Visits each configured page with the saved profile and collects its text.
    async function visitPages({ snapshot = false } = {}) {
        const cfg = config();
        const context = await launch({ headless: !cfg.showBrowser });
        const pages = [];
        const saved = [];
        try {
            const page = context.pages()[0] || await context.newPage();
            for (const target of cfg.pages) {
                const api = [];
                const onResponse = async response => {
                    if (!snapshot || api.length >= 40) return;
                    if (!/json/.test(response.headers()['content-type'] || '')) return;
                    try { api.push({ url: response.url(), body: await response.json() }); } catch { /* not JSON after all */ }
                };
                page.on('response', onResponse);
                await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(cfg.settleMs);
                // Boards load more rows as they scroll.
                for (let i = 0; i < cfg.scrolls; i++) {
                    const moved = await page.evaluate(() => {
                        const before = window.scrollY;
                        window.scrollBy(0, window.innerHeight * 0.9);
                        for (const el of document.querySelectorAll('*')) {
                            if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop += el.clientHeight * 0.9;
                        }
                        return window.scrollY !== before;
                    });
                    await page.waitForTimeout(600);
                    if (!moved && i > 1) break;
                }
                const collected = await page.evaluate(collectPage, cfg.selectors || null);
                collected.passwordField = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
                page.off('response', onResponse);
                if (looksSignedOut(page, collected)) {
                    state.signedIn = false;
                    throw new Error('Outlier asked to sign in. Click "Sign in to Outlier", sign in once in the window that opens, then close it.');
                }
                state.signedIn = true;
                pages.push({ kind: target.kind, url: target.url, collected });
                if (snapshot) {
                    fs.mkdirSync(files.snapshots, { recursive: true });
                    const base = path.join(files.snapshots, `${new Date().toISOString().replace(/[:.]/g, '-')}-${target.kind}`);
                    fs.writeFileSync(`${base}.html`, await page.content());
                    writeJson(`${base}.json`, { collected, api });
                    saved.push(`${base}.html`, `${base}.json`);
                }
            }
        } finally {
            await context.close().catch(() => {});
        }
        return { pages, saved };
    }

    async function analyze() {
        await runPython(['analyze', '--input', files.scrape, '--weights', files.weights, '--out', files.result,
            '--history', files.history, '--market-log', files.marketLog], { python });
        return readJson(files.result, null);
    }

    // After each scrape: log every prop's price with the time, and move the
    // closing price of each open leg you played to the latest one. Props come
    // off the board at the start, so the last price seen is the close.
    function recordPrices(result, at = new Date().toISOString()) {
        if (!result) return;
        const market = readJson(files.marketLog, {});
        for (const leg of result.legs) {
            const m = leg.metrics || {};
            if (m.consensus == null) continue;
            const seen = market[leg.id] || (market[leg.id] = { firstSeen: at, openPrice: m.consensus, points: [] });
            seen.lastSeen = at;
            const last = seen.points[seen.points.length - 1];
            if (!last || last.price !== m.consensus) seen.points.push({ at, price: m.consensus, fair: m.fairProb });
            if (seen.points.length > 60) seen.points.splice(0, seen.points.length - 60);
        }
        // Forget props not seen for a week.
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        for (const [id, seen] of Object.entries(market)) if (Date.parse(seen.lastSeen) < cutoff) delete market[id];
        writeJson(files.marketLog, market);

        const byId = new Map(result.legs.map(l => [l.id, l]));
        const data = history();
        let changed = false;
        for (const entry of data.entries) {
            for (const leg of entry.legs) {
                const now = byId.get(leg.id);
                if (leg.result || !now || now.metrics.consensus == null) continue;
                leg.closePrice = now.metrics.consensus;
                leg.closeFair = now.metrics.fairProb;
                leg.closeAt = at;
                changed = true;
            }
        }
        if (changed) writeJson(files.history, data);
    }

    // Bankroll and entry sizes live in weights.json with the filters.
    async function setStrategy(update = {}) {
        const weights = readJson(files.weights, {});
        const b = update.bankroll || {};
        const bankroll = { ...(weights.bankroll || {}) };
        const num = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined);
        for (const [key, lo, hi] of [['units', 0.01, 1e9], ['kelly_fraction', 0, 1], ['max_stake_pct', 0, 1], ['drawdown_cut', 0.01, 1]]) {
            if (b[key] !== undefined) {
                const value = num(b[key], lo, hi);
                if (value === undefined) throw new Error(`${key} must be between ${lo} and ${hi}.`);
                bankroll[key] = value;
            }
        }
        weights.bankroll = bankroll;
        if (Array.isArray(update.sizes)) {
            const sizes = update.sizes.map(Number).filter(n => n === 4 || n === 6);
            if (!sizes.length) throw new Error('Pick 4-leg, 6-leg or both.');
            weights.slips = { ...(weights.slips || {}), sizes };
        }
        writeJson(files.weights, weights);
        if (fs.existsSync(files.scrape)) await analyze();
        return snapshotState();
    }

    async function scrape() {
        claim('scrape');
        try {
            const { pages } = await visitPages();
            const parsed = parseCollected(pages);
            writeJson(files.scrape, { scrapedAt: new Date().toISOString(), source: 'outlier', ...parsed });
            const settledNow = settleFromResults(parsed.results);
            if (settledNow) await learn();
            const result = await analyze();
            recordPrices(result);
            state.lastRun = new Date().toISOString();
            log(`[Outlier] Read ${parsed.props.length} prop(s) from ${pages.length} page(s); ${result ? result.counts.slips : 0} entr(ies) recommended.`);
            return { ok: true, pages: parsed.pages, settled: settledNow };
        } catch (err) {
            state.lastError = err.message;
            throw err;
        } finally {
            state.busy = null;
        }
    }

    async function snapshot() {
        claim('snapshot');
        try {
            const { saved } = await visitPages({ snapshot: true });
            return { ok: true, files: saved, detail: `Saved ${saved.length / 2} page(s) to ${files.snapshots}. They hold your Outlier pages, so keep them private.` };
        } catch (err) {
            state.lastError = err.message;
            throw err;
        } finally {
            state.busy = null;
        }
    }

    // ---- entries you played, and their results ----

    const history = () => readJson(files.history, { entries: [] });

    function track(slipId, stake) {
        const result = readJson(files.result, null);
        const slip = result && result.slips.find(s => s.id === slipId);
        if (!slip) throw new Error('That entry is no longer in the latest results. Run the analysis again.');
        const legsById = new Map(result.legs.map(l => [l.id, l]));
        const data = history();
        const entry = {
            id: `e${Date.now().toString(36)}`, slipId, recordedAt: new Date().toISOString(), type: slip.type, size: slip.size,
            ev: slip.ev, allHitProb: slip.allHitProb, weightsVersion: result.weightsVersion,
            // What you actually staked (defaults to the Kelly stake), for the bankroll.
            stake: Number.isFinite(Number(stake)) && Number(stake) >= 0 ? Number(stake) : slip.stakeUnits || 0,
            legs: slip.legs.map(id => {
                const l = legsById.get(id);
                return { id, player: l.player, market: l.market, line: l.line, side: l.side, game: l.game || null, metrics: l.metrics,
                    takenPrice: l.metrics.consensus, takenAt: new Date().toISOString(), result: null };
            })
        };
        data.entries.push(entry);
        writeJson(files.history, data);
        return entry;
    }

    async function recordOutcomes(entryId, results = {}) {
        const data = history();
        const entry = data.entries.find(e => e.id === entryId);
        if (!entry) throw new Error('Unknown entry.');
        for (const leg of entry.legs) {
            const r = results[leg.id];
            if (r === 'hit' || r === 'miss' || r === 'push' || r === null) leg.result = r;
        }
        writeJson(files.history, data);
        const report = await learn();
        // New filters apply to the props already on screen too.
        if (fs.existsSync(files.scrape)) await analyze();
        return report;
    }

    function untrack(entryId) {
        const data = history();
        data.entries = data.entries.filter(e => e.id !== entryId);
        writeJson(files.history, data);
        return { ok: true };
    }

    // Results read from Outlier's history/slip pages settle matching open legs.
    function settleFromResults(results = []) {
        if (!results.length) return 0;
        const data = history();
        let count = 0;
        for (const entry of data.entries) {
            for (const leg of entry.legs) {
                if (leg.result) continue;
                const match = results.find(r => sameLeg(r, leg));
                if (match) { leg.result = match.result; leg.settledBy = 'outlier'; count++; }
            }
        }
        if (count) writeJson(files.history, data);
        return count;
    }

    async function learn() {
        await runPython(['learn', '--history', files.history, '--weights', files.weights, '--out', files.weights, '--report', files.learn], { python });
        return readJson(files.learn, null);
    }

    // Filters back to defaults; your bankroll and entry sizes stay.
    async function resetWeights() {
        const { bankroll, slips } = readJson(files.weights, {});
        try { fs.rmSync(files.weights); } catch { /* already default */ }
        if (bankroll || slips) writeJson(files.weights, { ...(bankroll && { bankroll }), ...(slips && slips.sizes && { slips: { sizes: slips.sizes } }) });
        try { fs.rmSync(files.learn); } catch { /* none yet */ }
        if (fs.existsSync(files.scrape)) await analyze();
        return { ok: true };
    }

    async function forgetSignIn() {
        if (state.busy) throw new Error('Close the Outlier window first.');
        fs.rmSync(files.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        state.signedIn = null;
        return { ok: true };
    }

    function snapshotState() {
        const scrapeFile = readJson(files.scrape, null);
        return {
            busy: state.busy,
            signedIn: state.signedIn,
            profileSaved: fs.existsSync(files.profile) && fs.readdirSync(files.profile).length > 0,
            lastError: state.lastError,
            scrapedAt: scrapeFile && scrapeFile.scrapedAt,
            pages: scrapeFile && scrapeFile.pages,
            result: readJson(files.result, null),
            history: history(),
            weights: readJson(files.weights, null),
            learnReport: readJson(files.learn, null),
            config: config(),
            dataDir
        };
    }

    async function close() {
        if (state.signInContext) await state.signInContext.close().catch(() => {});
    }

    function status() {
        if (!playwright) return { available: false, detail: 'needs playwright-core (npm install)' };
        return { available: true, detail: state.busy ? `busy: ${state.busy}` : state.signedIn === false ? 'signed out of Outlier' : 'ready' };
    }

    return { signIn, scrape, snapshot, analyze, recordPrices, setStrategy, track, untrack, recordOutcomes, learn, resetWeights, forgetSignIn, setConfig,
        state: snapshotState, status, close, files, settleFromResults };
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

// A route that answers 400 with the message instead of failing the request.
const safe = fn => async (req, res, body) => {
    try { sendJson(res, 200, await fn(body || {})); } catch (err) { sendJson(res, 400, { error: err.message }); }
};

function createService(config = {}, { log = console.log, pipeline } = {}) {
    const outlier = pipeline || createOutlierPipeline({ log });
    return {
        name: 'outlier',
        tools: [{
            name: 'outlier_slips',
            description: 'The latest Outlier entries CoDev recommends (4- and 6-leg power/flex), with each leg\'s odds, L5 hit rate and estimated hit chance. Read-only; the user runs the scrape from the Outlier view.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }],
        async callTool(name) {
            if (name !== 'outlier_slips') return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
            const result = outlier.state().result;
            if (!result) return { content: [{ type: 'text', text: 'No Outlier analysis yet. Ask the user to run it from the Outlier view.' }] };
            const legs = new Map(result.legs.map(l => [l.id, l]));
            const lines = result.slips.map(s => `${s.size}-leg ${s.type}: EV ${(s.ev * 100).toFixed(1)}%, all legs ${(s.allHitProb * 100).toFixed(1)}%, stake ${s.stakeUnits} units\n`
                + s.legs.map(id => { const l = legs.get(id); return `  - ${l.player} ${l.side} ${l.line} ${l.market || ''} (${l.metrics.consensus}, L5 ${Math.round((l.metrics.l5 || 0) * 100)}%, p ${Math.round((l.metrics.p || 0) * 100)}%)`; }).join('\n'));
            return { content: [{ type: 'text', text: `Scraped ${result.scrapedAt}. ${result.counts.passed}/${result.counts.props} props passed.\n${lines.join('\n') || result.notes.join('\n')}\nEstimates, not guarantees.` }] };
        },
        routes: {
            'GET /outlier/state': (req, res) => sendJson(res, 200, outlier.state()),
            'POST /outlier/signin': safe(() => outlier.signIn()),
            'POST /outlier/scrape': safe(async () => { await outlier.scrape(); return outlier.state(); }),
            'POST /outlier/analyze': safe(async () => { await outlier.analyze(); return outlier.state(); }),
            'POST /outlier/snapshot': safe(() => outlier.snapshot()),
            'POST /outlier/config': safe(body => outlier.setConfig(body)),
            'POST /outlier/track': safe(body => outlier.track(body.slipId, body.stake)),
            'POST /outlier/strategy': safe(body => outlier.setStrategy(body)),
            'POST /outlier/untrack': safe(body => outlier.untrack(body.entryId)),
            'POST /outlier/outcomes': safe(async body => { await outlier.recordOutcomes(body.entryId, body.results); return outlier.state(); }),
            'POST /outlier/reset-weights': safe(async () => { await outlier.resetWeights(); return outlier.state(); }),
            'POST /outlier/forget-signin': safe(() => outlier.forgetSignIn())
        },
        status: () => outlier.status(),
        close: () => outlier.close()
    };
}

module.exports = { createService, createOutlierPipeline, runPython, sameLeg, propId };
