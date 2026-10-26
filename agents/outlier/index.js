// The Outlier pipeline as a server.js agent-tools service: read the signed-in
// Outlier pages, turn them into props (extract.js), score them and build 4- and
// 6-leg entries (tools/outlier-analytics/analyze.py), and tune the filters from
// the entries' results. The page drives it through the /outlier/ routes; agents
// only get a read-only tool for the latest entries.
//
// Unlike the agents' browsers, which start empty and are deleted, this pipeline
// keeps ONE browser profile of its own so the Outlier sign-in carries over. It
// lives in this user's app-data folder (never the repo) and no agent can drive it.
// When the browser service is running, that browser is its "@outlier" session:
// the user sees it in the live view and can browse or search in it for as long as
// they like. "Read this page" reads whatever the user has open without taking it
// over, and a scrape runs in a background tab while the user is browsing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { collectPage, parseCollected, parseText, propId } = require('./extract');
const { createCapture } = require('./capture');
const { navigate, onlyGame, openPlayer, readDetails, legSummary, keepLegs, statWords, onTools, normWords } = require('./navigate');
const { OUTLIER_PRIMER, OUTLIER_GUIDE } = require('./guide');
const { checkPage, advice, fixKnownAddress, resolveAddress } = require('../../desktop/browser/page-check');

// The signed-in browser's id in the shared browser service. Agents' ids never start with @.
const SESSION = '@outlier';

// Inside the Windows app's installer, Python reads the unpacked copy of the scripts
// (it can't read into app.asar).
const unpacked = file => file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const ANALYTICS = unpacked(path.join(__dirname, '..', '..', 'tools', 'outlier-analytics', 'analyze.py'));
const MARKET = unpacked(path.join(__dirname, '..', '..', 'tools', 'outlier-analytics', 'market_data.py'));
const DEFAULT_CONFIG = {
    signInUrl: 'https://app.outlier.bet/login',
    // kind: props (prop cards and boards), odds (odds boards), slips or history (settled entries).
    pages: [{ kind: 'props', url: 'https://app.outlier.bet/' }],
    // { row: 'css', fields: { player, market, line, odds, hitRates } } when the
    // generic parser misses something; see README.
    selectors: null,
    showBrowser: false,
    settleMs: 2500,
    // Most scroll steps per page; the scan stops sooner at the end of the board.
    scrolls: 40,
    // Free market odds (market_data.py) and public odds-comparison pages read
    // with a fresh, signed-out browser, cross-referenced into each scrape.
    market: true,
    publicBoards: [],
    // Every analysis writes the board (props, injuries, tickets, under legs) to this
    // file in the project folder ('' = off), and board JSON files saved in importDir
    // are read in and analyzed as they appear. Both are relative to the project folder.
    boardDump: 'downloads/new folder/outlier_live_board_dump.json',
    importDir: 'downloads/new folder',
    autoImport: true
};
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;

// outlierbet.com, outlier.com, outlier.ai and look-alikes are other companies or parked domains,
// not Outlier's betting app: saved addresses on them go back to the real ones.
const OUTLIER_HOST = /(^|\.)outlier\.bet$/i;
function isWrongOutlierHost(value) {
    try {
        const host = new URL(value).hostname;
        return (/outlier/i.test(host) && !OUTLIER_HOST.test(host)) || fixKnownAddress(value) !== value;
    } catch { return false; }
}
function fixOutlierUrls(cfg) {
    if (isWrongOutlierHost(cfg.signInUrl)) cfg.signInUrl = DEFAULT_CONFIG.signInUrl;
    if (Array.isArray(cfg.pages)) cfg.pages = cfg.pages.map(p => (isWrongOutlierHost(p.url) ? { ...p, url: DEFAULT_CONFIG.pages[0].url } : p));
    return cfg;
}

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
// env: extra environment for the script (keys go there, never on the command line).
function runPython(args, { python = process.env.CODEV_PYTHON, timeoutMs = 120000, script = ANALYTICS, env } = {}) {
    const candidates = python ? [python] : process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
    return new Promise((resolve, reject) => {
        const tryNext = i => {
            if (i >= candidates.length) return reject(new Error('Python was not found. Install Python 3 (python.org) or set CODEV_PYTHON to its path, then try again.'));
            const child = spawn(candidates[i], [script, ...args], { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
            let stderr = '';
            const timer = setTimeout(() => child.kill(), timeoutMs);
            child.stderr.on('data', d => { stderr += d; });
            child.on('error', err => { clearTimeout(timer); if (err.code === 'ENOENT') tryNext(i + 1); else reject(err); });
            child.on('close', code => {
                clearTimeout(timer);
                if (code === 0) resolve();
                // The Windows Store "python" stub exits 9009 when Python isn't really installed.
                else if (code === 9009) tryNext(i + 1);
                else reject(new Error(`${path.basename(script)} failed: ${stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`));
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

// getWorkspace: the project folder (board dump and import folder live there), or ''.
function createOutlierPipeline({ dataDir = path.join(serverDataDir(), 'outlier'), playwright = loadPlaywright(), python, oddsApiKey = process.env.ODDS_API_KEY,
    blockedPorts = [3000, Number(process.env.PORT) || 3000, 8787], shared = null, getWorkspace = () => '', log = console.log } = {}) {
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
        // Free feeds + public boards, every quote with its book and time (SQLite).
        marketDb: path.join(dataDir, 'market.db'),
        marketConfig: path.join(dataDir, 'market.json'),
        boards: path.join(dataDir, 'public-boards.json'),
        marketSummary: path.join(dataDir, 'market-summary.json'),
        marketFetch: path.join(dataDir, 'market-fetch.json'),
        snapshots: path.join(dataDir, 'snapshots')
    };
    // busy: what the one browser is doing ('signin' | 'scrape' | 'snapshot'); the
    // profile can't be open twice. signedIn: what the last visit found (null = unknown).
    // propsUrl: the props board's address once reached, where the next visit starts (Outlier
    // itself reopens on +EV). progress: what a long read is on, for the Outlier tab.
    const state = { busy: null, signedIn: null, lastError: null, lastRun: null, signInContext: null, propsUrl: null, progress: null };
    const rememberProps = url => { state.propsUrl = url; };
    const blocked = new Set(blockedPorts.map(String));
    // shared: { manager, live } from the browser service, when it's running.
    if (shared) shared.manager.registerProfile(SESSION, files.profile);
    const closeShared = () => (shared ? shared.manager.close(SESSION).catch(() => false) : Promise.resolve(false));

    const config = () => fixOutlierUrls({ ...DEFAULT_CONFIG, ...readJson(files.config, {}) });

    function setConfig(update = {}) {
        const next = config();
        if (typeof update.signInUrl === 'string') next.signInUrl = checkUrl(update.signInUrl);
        if (Array.isArray(update.pages)) {
            next.pages = update.pages.map(p => ({ kind: ['props', 'odds', 'slips', 'history'].includes(p.kind) ? p.kind : 'props', url: checkUrl(p.url) }));
        }
        if (update.selectors === null || (update.selectors && typeof update.selectors.row === 'string')) next.selectors = update.selectors;
        if (typeof update.showBrowser === 'boolean') next.showBrowser = update.showBrowser;
        if (typeof update.market === 'boolean') next.market = update.market;
        if (Array.isArray(update.publicBoards)) next.publicBoards = update.publicBoards.filter(Boolean).map(checkUrl);
        if (typeof update.boardDump === 'string') next.boardDump = update.boardDump.trim() && inWorkspace(update.boardDump, { relative: true });
        if (typeof update.importDir === 'string') next.importDir = update.importDir.trim() && inWorkspace(update.importDir, { relative: true });
        if (typeof update.autoImport === 'boolean') next.autoImport = update.autoImport;
        writeJson(files.config, next);
        watchImports();
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
            // The profile can only be open once: the live view's copy closes.
            await closeShared();
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
    // The shared "@outlier" browser when there is one (left open for the live view),
    // else a browser of its own that closes after. While the user is browsing it,
    // the scrape runs in a background tab and closes it after, so the user's tab and
    // control are never touched.
    async function openForVisit(cfg) {
        if (shared && !cfg.showBrowser) {
            const page = await shared.manager.workPage(SESSION);
            const session = shared.manager.peek(SESSION);
            const background = session && page === session.agentPage;
            return { page, shared: true, done: async () => {
                if (!background || page.__codevKeep) return;
                if (session.agentPage === page) session.agentPage = null;
                await page.close().catch(() => {});
            } };
        }
        await closeShared();
        const context = await launch({ headless: !cfg.showBrowser });
        return { page: context.pages()[0] || await context.newPage(), done: () => context.close().catch(() => {}) };
    }

    // pages: scan these instead of the configured ones (an agent's outlier_scan_board).
    async function visitPages({ snapshot = false, pages: only = null } = {}) {
        const cfg = only ? { ...config(), pages: only } : config();
        const browser = await openForVisit(cfg);
        const pages = [];
        const saved = [];
        try {
            const page = browser.page;
            for (const target of cfg.pages) {
                const api = [];
                const onResponse = async response => {
                    if (!snapshot || api.length >= 40) return;
                    if (!/json/.test(response.headers()['content-type'] || '')) return;
                    try { api.push({ url: response.url(), body: await response.json() }); } catch { /* not JSON after all */ }
                };
                page.on('response', onResponse);
                await gotoChecked(page, target.url, { pausable: browser.shared });
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(cfg.settleMs);
                // An agent asked for a sport, stat or game: click there first (tabs,
                // filters and game cards only, never a pick).
                let nav = null;
                if (target.nav) {
                    const signedOut = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
                    if (looksSignedOut(page, { passwordField: signedOut })) signInNeeded(page, browser);
                    nav = await navigate(page, target.nav, { settleMs: cfg.settleMs, onProps: rememberProps });
                }
                // Boards load more rows as they scroll, and long ones remove the rows that
                // scroll away, so the page is read after every step and the reads are
                // combined. It stops at the end of the board: no scroll moved, or two steps
                // in a row turned up nothing new.
                const collected = await page.evaluate(collectPage, cfg.selectors || null);
                collected.results = collected.results || [];
                collected.injuries = collected.injuries || [];
                const key = item => (typeof item === 'string' ? item : JSON.stringify(item));
                const seen = new Set(['cards', 'tables', 'configured', 'results', 'injuries'].flatMap(f => (collected[f] || []).map(key)));
                const addRead = read => {
                    let fresh = 0;
                    for (const field of ['cards', 'tables', 'configured', 'results', 'injuries']) {
                        for (const item of read[field] || []) {
                            if (seen.has(key(item))) continue;
                            seen.add(key(item));
                            collected[field].push(item);
                            if (field === 'cards' || field === 'tables' || field === 'configured') fresh++;
                        }
                    }
                    return fresh;
                };
                let quiet = 0;
                for (let i = 0; i < cfg.scrolls; i++) {
                    const moved = await page.evaluate(() => {
                        let any = false;
                        const before = window.scrollY;
                        window.scrollBy(0, window.innerHeight * 0.9);
                        if (window.scrollY !== before) any = true;
                        // Boards that scroll inside a panel instead of the window.
                        for (const el of document.querySelectorAll('*')) {
                            if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
                                const top = el.scrollTop;
                                el.scrollTop += el.clientHeight * 0.9;
                                if (el.scrollTop !== top) any = true;
                            }
                        }
                        return any;
                    });
                    await page.waitForTimeout(600);
                    const fresh = addRead(await page.evaluate(collectPage, cfg.selectors || null));
                    quiet = fresh ? 0 : quiet + 1;
                    if (!moved || quiet >= 2) break;
                }
                collected.passwordField = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
                page.off('response', onResponse);
                if (looksSignedOut(page, collected)) signInNeeded(page, browser);
                state.signedIn = true;
                pages.push({ kind: target.kind, url: target.url, collected, nav });
                if (snapshot) {
                    fs.mkdirSync(files.snapshots, { recursive: true });
                    const base = path.join(files.snapshots, `${new Date().toISOString().replace(/[:.]/g, '-')}-${target.kind}`);
                    fs.writeFileSync(`${base}.html`, await page.content());
                    writeJson(`${base}.json`, { collected, api });
                    saved.push(`${base}.html`, `${base}.json`);
                }
            }
        } finally {
            await browser.done();
        }
        return { pages, saved };
    }

    // Throws: Outlier sent the scan to its sign-in page.
    function signInNeeded(page, browser) {
        state.signedIn = false;
        // Redirected to sign in: leave that page open in the live view to sign in there.
        if (browser.shared && shared.manager.pause(SESSION, page, 'Outlier asked to sign in.')) {
            page.__codevKeep = true;
            throw new Error('Outlier asked to sign in. The Outlier browser is paused on the sign-in page in the live view (🖥️ Browse): sign in there, then run the scrape again.');
        }
        throw new Error('Outlier asked to sign in. Click "Sign in to Outlier", sign in once in the window that opens, then close it.');
    }

    // Opens url and fails with a plain reason when it's a dead link or a parked
    // "domain for sale" page instead of the site.
    // pausable: the page is in the shared "@outlier" browser, which then stays open on
    // the bad page, paused for the user in the live view, instead of closing.
    async function gotoChecked(page, url, { pausable = false } = {}) {
        let response;
        let problem = '';
        try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (err) {
            problem = `Couldn't open ${url}: ${advice(await checkPage(page, null, { error: err }), url)}`;
        }
        if (!problem) {
            const check = await checkPage(page, response);
            if (!check.ok) problem = `${url} isn't a working page. ${advice(check, url)}`;
        }
        if (!problem) return response;
        if (pausable && shared && shared.manager.pause(SESSION, page, problem)) {
            page.__codevKeep = true;
            throw new Error(`${problem} The Outlier browser is paused on that page in the live view (🖥️ Browse): fix it there or under Pages, then run the scrape again.`);
        }
        throw new Error(`${problem} Fix it under Pages in the Outlier view.`);
    }

    // Reads the page open in a browser right now (the user's own browsing in the
    // live view, or an agent's browser), adds its props to the latest read and
    // re-scores. agentId defaults to the signed-in Outlier browser.
    async function readOpenPage({ agentId = SESSION, kind = 'props', merge = true } = {}) {
        if (!shared) throw new Error('Reading an open page needs the browser service (playwright-core).');
        if (merge && state.busy && state.busy !== 'signin') throw new Error(`The Outlier browser is busy (${state.busy}). Try again in a moment.`);
        const session = shared.manager.peek(String(agentId));
        if (!session || !session.page || session.page.isClosed()) {
            throw new Error(agentId === SESSION ? 'The Outlier browser isn\'t open. Open it in the live view first, or run a scrape.' : `${agentId} has no browser open.`);
        }
        const page = session.page;
        const collected = await page.evaluate(collectPage, config().selectors || null);
        const pageKind = ['props', 'odds', 'slips', 'history'].includes(kind) ? kind : 'props';
        const parsed = parseCollected([{ kind: pageKind, url: page.url(), collected }]);
        if (!merge) return parsed;
        mergeIntoScrape(parsed);
        const settledNow = settleFromResults(parsed.results);
        if (settledNow) await learn();
        const result = await analyze();
        recordPrices(result);
        state.lastRun = new Date().toISOString();
        return { ...parsed, settled: settledNow };
    }

    // ---- free market odds ----

    const MARKET_KEYS = ['enabled', 'sports', 'regions', 'main_markets', 'prop_markets', 'max_prop_events', 'min_minutes_between', 'reserve_credits'];

    function setMarketConfig(update = {}) {
        const current = readJson(files.marketConfig, {});
        const next = { ...current, odds_api: { ...(current.odds_api || {}) }, espn: { ...(current.espn || {}) } };
        const list = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(x => String(x).trim()).filter(x => /^[a-z0-9_/\-]+$/i.test(x));
        for (const [key, value] of Object.entries(update.odds_api || {})) {
            if (!MARKET_KEYS.includes(key)) continue;
            if (key === 'enabled') next.odds_api.enabled = Boolean(value);
            else if (key === 'regions') next.odds_api.regions = list(value).join(',') || 'us';
            else if (['sports', 'main_markets', 'prop_markets'].includes(key)) next.odds_api[key] = list(value);
            else if (Number.isFinite(Number(value)) && Number(value) >= 0) next.odds_api[key] = Number(value);
        }
        if (update.espn) {
            if ('enabled' in update.espn) next.espn.enabled = Boolean(update.espn.enabled);
            if ('leagues' in update.espn) next.espn.leagues = list(update.espn.leagues);
        }
        if (update.sharp_books) next.sharp_books = list(update.sharp_books).map(b => b.toLowerCase());
        writeJson(files.marketConfig, next);
        return next;
    }

    // Public odds-comparison pages, read with a fresh signed-out browser (never
    // the Outlier profile), parsed the same way as Outlier's own pages.
    async function readPublicBoards(urls) {
        if (!urls.length) return [];
        if (!playwright) throw new Error('Reading public boards needs playwright-core (npm install).');
        let browser;
        for (const candidate of launchCandidates()) {
            try { browser = await playwright.chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ...candidate.options }); break; } catch { /* next */ }
        }
        if (!browser) throw new Error('No browser could start to read the public boards.');
        const boards = [];
        try {
            const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: false });
            await context.route(url => isLoopback(url.hostname) && blocked.has(url.port || '80'), route => route.abort('blockedbyclient'));
            const page = await context.newPage();
            for (const url of urls) {
                try {
                    await gotoChecked(page, url);
                    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                    await page.waitForTimeout(config().settleMs);
                    const collected = await page.evaluate(collectPage, null);
                    const { props } = parseCollected([{ kind: 'odds', collected }]);
                    boards.push({ source: new URL(url).hostname, url, props });
                } catch (err) {
                    boards.push({ source: new URL(url).hostname, url, props: [], error: String(err.message).split('\n')[0] });
                }
            }
        } finally {
            await browser.close().catch(() => {});
        }
        return boards;
    }

    const market = (args, extra = {}) => runPython([args[0], '--db', files.marketDb, '--config', files.marketConfig, ...args.slice(1)],
        { python, script: MARKET, ...extra });

    // Free feeds, then public boards, into market.db; then the summary for the view.
    async function refreshMarket() {
        const report = { at: new Date().toISOString(), feeds: [], boards: [] };
        try {
            await market(['fetch', '--out', files.marketFetch], { env: { ODDS_API_KEY: oddsApiKey || '' } });
            report.feeds = (readJson(files.marketFetch, {}).feeds) || [];
        } catch (err) {
            report.feeds.push({ error: err.message });
        }
        try {
            const boards = await readPublicBoards(config().publicBoards || []);
            if (boards.length) {
                writeJson(files.boards, boards);
                await market(['ingest', '--input', files.boards, '--out', files.marketFetch]);
            }
            report.boards = boards.map(b => ({ source: b.source, props: b.props.length, error: b.error }));
        } catch (err) {
            report.boards.push({ error: err.message });
        }
        await market(['summary', '--out', files.marketSummary]);
        state.market = report;
        return report;
    }

    async function marketRefreshRoute() {
        claim('market');
        try {
            await refreshMarket();
            if (fs.existsSync(files.scrape)) {
                await market(['enrich', '--input', files.scrape, '--out', files.scrape]);
                recordPrices(await analyze());
            }
            return snapshotState();
        } finally {
            state.busy = null;
        }
    }

    // A path inside the project folder (relative to it), or an error for one that leaves it.
    function inWorkspace(rel, { relative = false } = {}) {
        const text = String(rel || '').trim().replace(/\\/g, '/');
        if (!text || path.isAbsolute(text) || text.split('/').includes('..')) throw new Error(`Use a path inside the project folder: ${rel}`);
        if (relative) return text;
        const root = getWorkspace();
        if (!root) return null;
        return path.join(root, text);
    }

    async function analyze() {
        await runPython(['analyze', '--input', files.scrape, '--weights', files.weights, '--out', files.result,
            '--history', files.history, '--market-log', files.marketLog], { python });
        const result = readJson(files.result, null);
        dumpBoard(result);
        return result;
    }

    // The board as structured JSON in the project folder, for other tools and agents.
    let lastDump = null;
    function dumpBoard(result) {
        const target = config().boardDump ? inWorkspace(config().boardDump) : null;
        if (!target || !result) return null;
        const scrapeFile = readJson(files.scrape, {});
        try {
            writeJson(target, {
                exportedAt: new Date().toISOString(), source: 'outlier', scrapedAt: scrapeFile.scrapedAt || null,
                props: scrapeFile.props || [], injuries: scrapeFile.injuries || [],
                strategy: result.strategy, counts: result.counts,
                legs: result.legs.map(l => ({ id: l.id, player: l.player, market: l.market, line: l.line, side: l.side, team: l.team, game: l.game,
                    tier: l.tier, route: l.route, rejected: l.rejected, metrics: l.metrics })),
                tickets: result.tickets, underLegs: result.underLegs, slips: result.slips, notes: result.notes,
                note: 'Estimates from public prices and recent games, not guarantees.'
            });
            lastDump = { path: target, at: new Date().toISOString() };
        } catch (err) {
            log(`[Outlier] Couldn't write the board dump to ${target}: ${err.message}`);
        }
        return lastDump;
    }

    // Reads a board saved as JSON: CoDev's own dump or scrape ({ props }), a list of
    // props, or what the page collector returns ({ cards, tables } or [{ collected }]).
    // Its props join the latest read and everything is re-scored.
    async function importBoard(file) {
        const raw = readJson(file, undefined);
        if (raw === undefined) throw new Error(`Couldn't read ${path.basename(file)} as JSON.`);
        let parsed;
        if (Array.isArray(raw) && raw.every(p => p && p.collected)) parsed = parseCollected(raw);
        else if (raw && !Array.isArray(raw) && (raw.cards || raw.tables)) parsed = parseCollected([{ kind: 'props', url: raw.url, collected: raw }]);
        else {
            const list = Array.isArray(raw) ? raw : (raw && raw.props) || [];
            const props = list.filter(p => p && typeof p.player === 'string' && Number.isFinite(Number(p.line)))
                .map(p => ({ ...p, line: Number(p.line), side: p.side || 'over', odds: Array.isArray(p.odds) ? p.odds : [], id: p.id || propId(p) }));
            parsed = { props, injuries: Array.isArray(raw && raw.injuries) ? raw.injuries : [], results: [], pages: [] };
        }
        if (!parsed.props.length) throw new Error(`${path.basename(file)} has no props CoDev can read (each needs a player and a line).`);
        mergeIntoScrape(parsed);
        const result = await analyze();
        recordPrices(result);
        state.lastRun = new Date().toISOString();
        state.lastImport = { file: path.basename(file), props: parsed.props.length, at: state.lastRun };
        log(`[Outlier] Imported ${parsed.props.length} prop(s) from ${path.basename(file)}.`);
        return { props: parsed.props.length, result };
    }

    // Watches importDir: a board JSON saved there (not CoDev's own dump) is imported.
    let importWatch = null;
    const imported = new Map();   // file -> mtime already read
    function watchImports() {
        if (importWatch) { importWatch.close(); importWatch = null; }
        const cfg = config();
        const dir = cfg.autoImport && cfg.importDir ? inWorkspace(cfg.importDir) : null;
        if (!dir) return;
        try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
        const dumpPath = cfg.boardDump ? path.resolve(inWorkspace(cfg.boardDump)) : '';
        const timers = new Map();
        const consider = name => {
            if (!/\.json$/i.test(name)) return;
            const file = path.join(dir, name);
            if (path.resolve(file) === dumpPath) return;
            clearTimeout(timers.get(file));
            // Wait for the file to finish writing.
            timers.set(file, setTimeout(async () => {
                let mtime;
                try { mtime = fs.statSync(file).mtimeMs; } catch { return; }
                if (imported.get(file) === mtime) return;
                imported.set(file, mtime);
                if (state.busy) return;
                try { await importBoard(file); } catch (err) { state.lastError = err.message; log(`[Outlier] ${err.message}`); }
            }, 800));
        };
        try {
            importWatch = fs.watch(dir, (event, name) => { if (name) consider(String(name)); });
            importWatch.unref?.();
        } catch (err) { log(`[Outlier] Can't watch ${dir}: ${err.message}`); }
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
        // sharp: -130+ juice, L5 >= 70%, high floor. consistency: -119 standard juice,
        // 60-75% hit rate, verified rolling 3-5 game baseline, minutes floor.
        if (update.strategy !== undefined) {
            if (!['sharp', 'consistency'].includes(update.strategy)) throw new Error('Strategy is sharp or consistency.');
            weights.strategy = update.strategy;
        }
        if (update.consistency) {
            const c = { ...(weights.consistency || {}) };
            for (const [key, lo, hi] of [['target_juice', 100, 200], ['juice_band', 0, 50], ['hit_rate_min', 0, 1], ['hit_rate_max', 0, 1], ['min_minutes', 0, 60], ['min_edge', 0, 0.3]]) {
                if (update.consistency[key] === undefined) continue;
                const value = num(update.consistency[key], lo, hi);
                if (value === undefined) throw new Error(`${key} must be between ${lo} and ${hi}.`);
                c[key] = value;
            }
            if (c.hit_rate_min !== undefined && c.hit_rate_max !== undefined && c.hit_rate_min > c.hit_rate_max) throw new Error('The hit-rate band\'s low end is above its high end.');
            weights.consistency = c;
        }
        // Players ruled out that the pages didn't show: [{ player, team, usage }] (usage 0-1 or a percent).
        if (Array.isArray(update.ruledOut)) {
            const manual = update.ruledOut.slice(0, 40).map(o => ({
                player: String((o && o.player) || '').trim().slice(0, 60),
                team: String((o && o.team) || '').trim().toUpperCase().slice(0, 6) || null,
                usage: o && o.usage !== undefined && o.usage !== '' && Number.isFinite(Number(o.usage)) && Number(o.usage) > 0 && Number(o.usage) <= 100 ? Number(o.usage) : null
            })).filter(o => o.player);
            weights.vacuum = { ...(weights.vacuum || {}), manual_out: manual };
        }
        // The under value engine: { enabled, min_signals (1-4), min_edge (0-0.3) }.
        if (update.under) {
            const u = { ...(weights.under || {}) };
            if (update.under.enabled !== undefined) u.enabled = update.under.enabled === true;
            for (const [key, lo, hi] of [['min_signals', 1, 4], ['min_edge', 0, 0.3]]) {
                if (update.under[key] === undefined) continue;
                const value = num(update.under[key], lo, hi);
                if (value === undefined) throw new Error(`under ${key} must be between ${lo} and ${hi}.`);
                u[key] = key === 'min_signals' ? Math.round(value) : value;
            }
            weights.under = u;
        }
        if (Array.isArray(update.ticketSizes)) {
            const sizes = [...new Set(update.ticketSizes.map(Number).filter(n => n >= 4 && n <= 6))].sort();
            if (!sizes.length) throw new Error('Pick ticket sizes from 4 to 6 legs.');
            weights.tickets = { ...(weights.tickets || {}), sizes };
        }
        writeJson(files.weights, weights);
        if (fs.existsSync(files.scrape)) await analyze();
        return snapshotState();
    }

    // Adds props (and injuries, results, pages) to the latest read; a prop seen again replaces the old one.
    function mergeIntoScrape({ props = [], injuries = [], results = [], pages = [] }) {
        const previous = readJson(files.scrape, null);
        const byId = new Map(((previous && previous.props) || []).map(p => [p.id, p]));
        for (const prop of props) byId.set(prop.id, prop);
        const outs = new Map([...((previous && previous.injuries) || []), ...injuries].map(o => [o.player.toLowerCase(), o]));
        writeJson(files.scrape, { scrapedAt: new Date().toISOString(), source: 'outlier', props: [...byId.values()], injuries: [...outs.values()],
            results: [...((previous && previous.results) || []), ...results],
            pages: [...((previous && previous.pages) || []), ...pages] });
    }

    // Passive capture in the signed-in browser while the user scrolls it (capture.js).
    // New props go to a scratchpad and into the latest read, re-scored at most every
    // ANALYZE_EVERY_MS so a fast scroll doesn't start the analysis on every drain.
    const ANALYZE_EVERY_MS = 15000;
    let analyzeTimer = null;
    let lastCaptureAnalyze = 0;
    const capture = createCapture({
        getSession: () => (shared ? shared.manager.peek(SESSION) : null),
        parse: (text, url) => parseText(text, { url }),
        log,
        onProps: props => {
            mergeIntoScrape({ props });
            if (analyzeTimer) return;
            const wait = Math.max(0, lastCaptureAnalyze + ANALYZE_EVERY_MS - Date.now());
            analyzeTimer = setTimeout(async () => {
                analyzeTimer = null;
                lastCaptureAnalyze = Date.now();
                if (state.busy) return;
                try { recordPrices(await analyze()); } catch (err) { state.lastError = err.message; }
            }, wait);
            analyzeTimer.unref?.();
        }
    });

    async function importFile({ file } = {}) {
        const target = inWorkspace(file);
        if (!target) throw new Error('Connect a project folder first: board files are read from it.');
        await importBoard(target);
        return snapshotState();
    }

    async function setCapture({ on, clear = false } = {}) {
        if (!shared) throw new Error('Passive capture needs the browser service (playwright-core).');
        if (clear) capture.clear();
        if (on === true) await capture.start();
        else if (on === false) capture.stop();
        return snapshotState();
    }

    // keep: legs the user listed ({ player, stat }): only those props are audited.
    async function scrape({ pages: only = null, keep = null } = {}) {
        claim('scrape');
        try {
            const { pages } = await visitPages({ pages: only });
            const parsed = parseCollected(pages);
            // One game asked for: only its props go into the tickets.
            const nav = pages.find(p => p.nav);
            if (nav && nav.nav.teams) parsed.props = onlyGame(parsed.props, nav.nav.teams);
            if (keep) parsed.props = keepLegs(parsed.props, keep);
            writeJson(files.scrape, { scrapedAt: new Date().toISOString(), source: 'outlier', ...parsed });
            const settledNow = settleFromResults(parsed.results);
            if (settledNow) await learn();
            // Cross-reference with the free feeds and public boards; a feed
            // that's down never stops the scrape.
            if (config().market !== false) {
                try {
                    await refreshMarket();
                    await market(['enrich', '--input', files.scrape, '--out', files.scrape]);
                } catch (err) {
                    state.market = { ...(state.market || {}), error: err.message };
                }
            }
            const result = await analyze();
            recordPrices(result);
            state.lastRun = new Date().toISOString();
            log(`[Outlier] Read ${parsed.props.length} prop(s) from ${pages.length} page(s); ${result ? result.counts.slips : 0} entr(ies) recommended.`);
            return { ok: true, pages: parsed.pages, settled: settledNow, navigated: nav ? nav.nav.steps : null };
        } catch (err) {
            state.lastError = err.message;
            throw err;
        } finally {
            state.busy = null;
        }
    }

    // One player's Market Details / player card, or one game's page (Games tab),
    // read as text for an agent. Reaches it like the scan (tabs, game card, then
    // the player's name) and clicks nothing else.
    async function research({ url = null, section, sport, market, game, player } = {}) {
        claim('research');
        try {
            const cfg = config();
            const start = url || boardStart();
            const browser = await openForVisit(cfg);
            try {
                const page = browser.page;
                await gotoChecked(page, start, { pausable: browser.shared });
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(cfg.settleMs);
                const signedOut = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
                if (looksSignedOut(page, { passwordField: signedOut })) signInNeeded(page, browser);
                // Without a player it's the game's own page, on the Games tab.
                const nav = await navigate(page, { section: section || (player || !game ? undefined : 'Games'), sport, market, game, player },
                    { settleMs: cfg.settleMs, onProps: rememberProps });
                const steps = [...nav.steps];
                if (player) steps.push(await openPlayer(page, player, { settleMs: cfg.settleMs }));
                const text = await readDetails(page);
                state.signedIn = true;
                return { steps, url: page.url(), text };
            } finally {
                await browser.done();
            }
        } catch (err) {
            state.lastError = err.message;
            throw err;
        } finally {
            state.busy = null;
        }
    }

    // Where a visit that navigates starts: the props board reached last time (so
    // Outlier's own reopen on +EV is skipped), else the configured props page.
    function boardStart() {
        return state.propsUrl || ((config().pages || []).find(p => p.kind === 'props') || {}).url || 'https://app.outlier.bet/';
    }

    // Opens the page for a visit that navigates: the start address, waits for it,
    // stops at a sign-in page.
    async function openAt(page, browser, url, cfg) {
        await gotoChecked(page, url, { pausable: browser.shared });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(cfg.settleMs);
        const signedOut = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
        if (looksSignedOut(page, { passwordField: signedOut })) signInNeeded(page, browser);
    }

    // Every leg on a list ({ player, stat, line, side }) researched in one visit:
    // the game's board is reached once, then each player's card for that stat is
    // opened, read down to one line, and the board is come back to (back, or the
    // board's address, never Outlier's start page).
    async function researchList({ url = null, sport, game, day, legs = [] } = {}) {
        claim('research');
        try {
            const cfg = config();
            const browser = await openForVisit(cfg);
            const results = [];
            let steps = [];
            try {
                const page = browser.page;
                const where = { sport, game, day, player: legs[0] && legs[0].player };
                const reach = async from => {
                    await openAt(page, browser, from, cfg);
                    const nav = await navigate(page, where, { settleMs: cfg.settleMs, onProps: rememberProps });
                    return { steps: nav.steps, board: page.url() };
                };
                state.progress = 'Opening the board';
                let { steps: first, board } = await reach(url || boardStart());
                steps = first;
                for (const [i, leg] of legs.entries()) {
                    state.progress = `Leg ${i + 1} of ${legs.length}: ${leg.player}${leg.stat ? ` ${leg.stat}` : ''}`;
                    log(`[Outlier] ${state.progress}`);
                    try {
                        let opened;
                        try {
                            opened = await openPlayer(page, leg.player, { settleMs: cfg.settleMs, stat: leg.stat, line: leg.line });
                        } catch (err) {
                            // The last card replaced the board: the board again, from its address.
                            if (i === 0) throw err;
                            ({ board } = await reach(board && !onTools(page) ? board : boardStart()));
                            opened = await openPlayer(page, leg.player, { settleMs: cfg.settleMs, stat: leg.stat, line: leg.line });
                        }
                        const text = await readDetails(page, { scrolls: 6, maxChars: 8000 });
                        results.push({ leg, opened, summary: legSummary(text) });
                    } catch (err) {
                        results.push({ leg, error: err.message.split(' (http')[0].split(' on that Outlier board')[0] });
                    }
                    // Back to the board: close the card, or go back a page.
                    await page.keyboard.press('Escape').catch(() => {});
                    if (page.url() !== board) {
                        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                        await page.waitForTimeout(cfg.settleMs);
                    }
                    await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; }).catch(() => {});
                }
                state.signedIn = true;
            } finally {
                await browser.done();
            }
            return { steps, results };
        } catch (err) {
            state.lastError = err.message;
            throw err;
        } finally {
            state.busy = null;
            state.progress = null;
        }
    }

    // One of Outlier's sections (Insights, Trends, Popular, Games, Injuries...) for
    // a sport, read as text: the tab by its name, the sport, then the page to its end.
    async function readSection({ section, sport, day } = {}) {
        claim('research');
        try {
            const cfg = config();
            const browser = await openForVisit(cfg);
            try {
                const page = browser.page;
                await openAt(page, browser, boardStart(), cfg);
                const nav = await navigate(page, { section, sport, day }, { settleMs: cfg.settleMs });
                const text = await readDetails(page, { scrolls: 10, maxChars: 10000 });
                state.signedIn = true;
                return { steps: nav.steps, url: page.url(), text };
            } finally {
                await browser.done();
            }
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
        // A power/flex entry, or a parlay ticket (paid at the legs' combined odds).
        const ticket = result && (result.tickets || []).find(t => t.id === slipId);
        const slip = result && (result.slips.find(s => s.id === slipId) || (ticket && { ...ticket, type: 'parlay', allHitProb: ticket.modelProb }));
        if (!slip) throw new Error('That entry is no longer in the latest results. Run the analysis again.');
        const legsById = new Map(result.legs.map(l => [l.id, l]));
        const data = history();
        const entry = {
            id: `e${Date.now().toString(36)}`, slipId, recordedAt: new Date().toISOString(), type: slip.type, size: slip.size,
            ...(slip.type === 'parlay' && { decimal: slip.decimal, american: slip.american }),
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
        await closeShared();
        fs.rmSync(files.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        state.signedIn = null;
        return { ok: true };
    }

    function snapshotState() {
        const scrapeFile = readJson(files.scrape, null);
        return {
            busy: state.busy,
            progress: state.busy ? state.progress : null,
            signedIn: state.signedIn,
            // The live view's id for the signed-in browser (null without the browser service).
            liveSession: shared ? SESSION : null,
            profileSaved: fs.existsSync(files.profile) && fs.readdirSync(files.profile).length > 0,
            lastError: state.lastError,
            scrapedAt: scrapeFile && scrapeFile.scrapedAt,
            pages: scrapeFile && scrapeFile.pages,
            capture: capture.status(),
            board: { dump: lastDump, lastImport: state.lastImport || null, workspace: Boolean(getWorkspace()) },
            result: readJson(files.result, null),
            history: history(),
            weights: readJson(files.weights, null),
            learnReport: readJson(files.learn, null),
            config: config(),
            market: {
                summary: readJson(files.marketSummary, null),
                last: state.market || null,
                config: readJson(files.marketConfig, {}),
                hasOddsApiKey: Boolean(oddsApiKey)
            },
            dataDir
        };
    }

    async function close() {
        capture.stop();
        if (importWatch) { importWatch.close(); importWatch = null; }
        if (analyzeTimer) { clearTimeout(analyzeTimer); analyzeTimer = null; }
        await closeShared();
        if (state.signInContext) await state.signInContext.close().catch(() => {});
    }

    function status() {
        if (!playwright) return { available: false, detail: 'needs playwright-core (npm install)' };
        return { available: true, detail: state.busy ? `busy: ${state.busy}` : state.signedIn === false ? 'signed out of Outlier' : 'ready' };
    }

    watchImports();
    return { signIn, scrape, research, researchList, readSection, boardStart, readOpenPage, setCapture, capture, importBoard, importFile, dumpBoard, watchImports, session: SESSION, snapshot, analyze, recordPrices, setStrategy, refreshMarket, refreshMarketRoute: marketRefreshRoute, setMarketConfig, readPublicBoards, track, untrack, recordOutcomes, learn, resetWeights, forgetSignIn, setConfig,
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

// A listed leg against the board: Outlier's line and price for that player and
// stat, and whether the user's line is easier or harder than it.
function lineNote(leg, boardLegs) {
    const name = normWords(leg.player);
    const words = statWords(leg.stat);
    const his = boardLegs.filter(l => normWords(l.player) === name && (!words.length || words.some(w => ` ${normWords(l.market)} `.includes(` ${w} `))));
    if (!his.length) return null;
    const side = /^(u|under|less|lower)/i.test(String(leg.side || '')) ? 'under' : 'over';
    const board = his.find(l => /^(u|under|less|lower)/i.test(String(l.side || '')) === (side === 'under')) || his[0];
    const mine = Number(leg.line);
    const theirs = Number(board.line);
    let diff = '';
    if (Number.isFinite(mine) && Number.isFinite(theirs) && mine !== theirs) {
        const easier = side === 'over' ? mine < theirs : mine > theirs;
        diff = `, your ${mine} is ${Math.abs(theirs - mine)} ${easier ? 'easier' : 'harder'}`;
    }
    const m = board.metrics || {};
    const hit = m.l5 != null ? `, L5 ${Math.round(m.l5 * 100)}%` : '';
    return `Outlier ${board.side || ''} ${board.line} ${board.market || ''} ${m.consensus || ''}${hit}${diff}${board.rejected ? ' (failed the audit)' : ''}`.replace(/\s+/g, ' ');
}

// Problems a slip built from these legs could have: one player twice, opposite
// sides on stats that move together.
function legChecks(legs) {
    const out = [];
    const byPlayer = new Map();
    legs.forEach((leg, i) => {
        const key = normWords(leg.player);
        if (!byPlayer.has(key)) byPlayer.set(key, []);
        byPlayer.get(key).push(i + 1);
    });
    for (const [, at] of byPlayer) {
        if (at.length < 2) continue;
        const sides = new Set(at.map(n => (/^(u|under|less|lower)/i.test(String(legs[n - 1].side || '')) ? 'under' : 'over')));
        out.push(`${legs[at[0] - 1].player} is on legs ${at.join(', ')}${sides.size > 1 ? ': an Over and an Under on him work against each other' : ': one slip should hold only one of them (they rise and fall together)'}`);
    }
    return out;
}

// The audit as text for an agent: tickets with their odds, then under value legs.
function auditText(result) {
    if (!result) return 'No Outlier analysis yet.';
    const legs = new Map(result.legs.map(l => [l.id, l]));
    const leg = l => `  - ${l.player} ${l.side} ${l.line} ${l.market || ''} (${l.metrics.consensus}, p ${Math.round((l.metrics.p || 0) * 100)}%)`;
    const tickets = (result.tickets || []).map(t => `${t.size}-leg ticket ${t.american > 0 ? '+' : ''}${t.american} (${t.decimal}x): book ${(t.impliedProb * 100).toFixed(1)}% vs model ${(t.modelProb * 100).toFixed(1)}%, EV ${(t.ev * 100).toFixed(1)}%\n`
        + t.legs.map(id => leg(legs.get(id))).join('\n'));
    const unders = (result.underLegs || []).map(u => `${leg(u)}: ${(u.metrics.underSignals || []).join('; ')}`);
    return `${result.counts.props} props, ${result.counts.passed} passed (${result.strategy}).\n${tickets.join('\n') || 'No tickets.'}\nUnder value legs:\n${unders.join('\n') || '  none'}\n${result.notes.join('\n')}\nEstimates, not guarantees.`;
}

function createService(config = {}, { log = console.log, pipeline, services = {} } = {}) {
    const shared = (services.browser && services.browser.shared) || null;
    const workspace = config.workspace || {};
    const outlier = pipeline || createOutlierPipeline({ log, shared, oddsApiKey: (config.keys && config.keys.oddsApi) || undefined,
        getWorkspace: () => workspace.root || workspace.projectDir || '' });
    return {
        name: 'outlier',
        tools: [{
            name: 'outlier_slips',
            description: 'The latest Outlier entries CoDev recommends (4- and 6-leg power/flex), with each leg\'s odds, L5 hit rate and estimated hit chance. Read-only; the user runs the scrape from the Outlier view.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }, {
            name: 'outlier_import_board',
            description: 'Reads an Outlier board saved as JSON in the project folder (a list of props, { props: [...] }, CoDev\'s own board dump, or the page collector\'s { cards, tables }), adds it to the Outlier analysis and runs the full audit: the -119 consistency filter, sharp-book (Pinnacle) comparison, correlation and usage checks, the Under engine and 4-6 leg tickets. Returns the tickets and under legs.',
            inputSchema: { type: 'object', properties: {
                path: { type: 'string', description: 'The JSON file, relative to the project folder (e.g. "downloads/new folder/board.json").' }
            }, required: ['path'], additionalProperties: false }
        }, {
            name: 'outlier_scan_board',
            description: 'Opens Outlier in the user\'s signed-in Outlier browser, goes to the sport, stat and game you name (e.g. sport "NBA", game "8pm" or "Lakers 3pm") by clicking Outlier\'s tabs and game cards, scrolls the board to the end reading every line, and runs the full audit (-119 consistency filter, sharp-book comparison, correlation and usage checks, Under engine, 4-6 leg tickets) on that game\'s props. Without sport or game it scans the pages set in the Outlier tab, or one app.outlier.bet address you give. It only reads and navigates: nothing is entered on Outlier, Underdog or Dabble. Give the user the ticket legs in your reply. You never get the browser itself or its cookies. If a tab isn\'t found, the error lists the tabs on the page: call again with the matching one as section or sport. ' + OUTLIER_PRIMER,
            inputSchema: { type: 'object', properties: {
                section: { type: 'string', description: 'The Outlier tab to open first, by its name on the page (e.g. "Props"). Leave it out for the regular props board, never Positive EV.' },
                sport: { type: 'string', description: 'The sport tab to open, e.g. "NBA", "NFL", "MLB", "NHL", "WNBA", "CBB".' },
                game: { type: 'string', description: 'The game by start time and/or teams as the user said it, e.g. "3pm", "8:30 PM", "Wizards vs Hornets", "LAL vs BOS 8pm". Times are the user\'s local time. With both teams named, a board without game cards is read whole and kept to that game.' },
                market: { type: 'string', description: 'A stat filter to click, e.g. "Points", "Rebounds" (optional).' },
                day: { type: 'string', description: '"today", "tomorrow" or a weekday, when the game isn\'t today (optional).' },
                url: { type: 'string', description: 'An app.outlier.bet page to start from instead of the configured one (optional).' },
                kind: { type: 'string', enum: ['props', 'odds'], description: 'What that page shows (default props).' }
            }, additionalProperties: false }
        }, {
            name: 'outlier_research',
            annotations: { readOnlyHint: true },
            description: 'Opens one player\'s Market Details / player card on Outlier in the user\'s signed-in browser (the Props board, sport, game, then the player\'s name) and returns everything on it as text: the hit rate chart and splits, Supporting Stats (minutes, shots, targets, target share...), the opponent\'s rank against that position, injuries, Odds Movement and public bet/money splits. Without a player it opens the game\'s page on the Games tab: spread, total, moneyline, injuries, line movement and public splits. Use it to check the legs of a ticket after outlier_scan_board (see outlier_guide for what each number means). It only reads and clicks tabs, game cards and the player\'s name; nothing is added to My Picks or a slip.',
            inputSchema: { type: 'object', properties: {
                player: { type: 'string', description: 'The player, e.g. "LeBron James". Leave out for the game\'s page.' },
                sport: { type: 'string', description: 'The sport tab, e.g. "NBA", "NFL", "MLB", "NHL".' },
                game: { type: 'string', description: 'The game by teams and/or start time, e.g. "Wizards vs Hornets", "8pm".' },
                market: { type: 'string', description: 'A stat filter to click first so the player\'s prop shows, e.g. "Points" (optional).' },
                section: { type: 'string', description: 'The Outlier tab to start from by its name on the page (optional; default Props for a player, Games for a game).' },
                url: { type: 'string', description: 'An app.outlier.bet page to start from (optional).' }
            }, additionalProperties: false }
        }, {
            name: 'outlier_research_list',
            annotations: { readOnlyHint: true },
            description: 'Researches a whole list of props (e.g. 20-40 legs from Dabble, Underdog or PrizePicks for one game) on Outlier in ONE visit, in the user\'s signed-in browser. It goes to the Props board once (leaving +EV), the sport, the day ("tomorrow") and the game, then opens each player\'s card for that leg\'s stat and reads it down to one line: hit rates (L5, L10, L20, H2H, season), the opponent\'s rank against him, injuries, minutes/usage and line movement. Also for each leg: Outlier\'s line and price versus the user\'s line (easier or harder), and the audit (-119 consistency, sharp-book check, correlation, Under engine) run on only these legs, with 4-6 leg tickets. Use it whenever the user gives a list of props to research or build a slip from; don\'t call outlier_research once per leg. Only reads and clicks tabs, game cards and player names.',
            inputSchema: { type: 'object', properties: {
                legs: { type: 'array', description: 'Every leg the user listed, as written.', items: { type: 'object', properties: {
                    player: { type: 'string', description: 'e.g. "LeBron James".' },
                    stat: { type: 'string', description: 'e.g. "Points", "Rebounds", "Pts+Rebs+Asts", "3-Pointers Made".' },
                    line: { type: 'number', description: 'The user\'s line, e.g. 24.5.' },
                    side: { type: 'string', description: 'Over/Higher/More or Under/Lower/Less (optional).' }
                }, required: ['player'], additionalProperties: false } },
                sport: { type: 'string', description: 'The sport tab, e.g. "NBA".' },
                game: { type: 'string', description: 'The game by teams and/or start time, e.g. "Wizards vs Hornets", "7pm".' },
                day: { type: 'string', description: '"today", "tomorrow" or a weekday, when the game isn\'t today (optional).' },
                url: { type: 'string', description: 'An app.outlier.bet page to start from (optional).' }
            }, required: ['legs'], additionalProperties: false }
        }, {
            name: 'outlier_read_section',
            annotations: { readOnlyHint: true },
            description: 'Opens one of Outlier\'s sections by its name and reads it as text: "Insights" or "Trends" (trending props and lines with strong hit rates), "Popular" (what Outlier users research and add most), "Games" (each game\'s spread, total, moneyline), "Injuries", or another tab named on the page; optionally for one sport and day. Use it for ideas and context beside a list or a board scan. Never use it for +EV, Arbitrage, Middles or Boosts when building a prop ticket.',
            inputSchema: { type: 'object', properties: {
                section: { type: 'string', description: 'The section\'s name, e.g. "Insights", "Popular", "Games".' },
                sport: { type: 'string', description: 'The sport tab, e.g. "NBA" (optional).' },
                day: { type: 'string', description: '"today", "tomorrow" or a weekday (optional).' }
            }, required: ['section'], additionalProperties: false }
        }, {
            name: 'outlier_guide',
            annotations: { readOnlyHint: true },
            description: 'The full guide to Outlier: every section and tool (Insights, Props/Prop Finder with its filters and sorts, Games, Market Details, Popular, My Picks, +EV, Arbitrage, Middles, Boosts), what each number and color means (odds, implied probability, hit rates, opposition rank, line movement, public bet vs money), when to look at each one while building a ticket, and the research checklist by sport and stat. Read it before researching or building a ticket from Outlier.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }, {
            name: 'outlier_extract_page',
            description: 'Runs the Outlier DOM extraction on the page open in YOUR browser (open it first with browser_navigate) and returns the props it finds as JSON: player, market, line, side, odds by book, hit rates. With add_to_analysis true, they are added to the latest Outlier read and the entries are re-scored.',
            inputSchema: { type: 'object', properties: {
                kind: { type: 'string', enum: ['props', 'odds', 'slips', 'history'], description: 'What the page shows (default props).' },
                add_to_analysis: { type: 'boolean', description: 'Add the props to the Outlier analysis (default false).' }
            }, additionalProperties: false }
        }],
        async callTool(name, args = {}, ctx = {}) {
            if (name === 'outlier_extract_page') {
                // The agent's own browser only, never the signed-in one.
                const agentId = String(ctx.agentId || 'default').replace(/^@+/, '') || 'default';
                try {
                    const parsed = await outlier.readOpenPage({ agentId, kind: args.kind, merge: args.add_to_analysis === true });
                    const text = JSON.stringify({ props: parsed.props, results: parsed.results, pages: parsed.pages }, null, 1);
                    return { content: [{ type: 'text', text: text.length > 60000 ? `${text.slice(0, 60000)}\n… (cut)` : text }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: err.message }], isError: true };
                }
            }
            if (name === 'outlier_scan_board') {
                try {
                    let pages = null;
                    if (args.url) {
                        const url = new URL(resolveAddress(String(args.url)).url);
                        // Only Outlier's own pages: the signed-in browser isn't a general-purpose one.
                        if (!/(^|\.)outlier\.bet$/i.test(url.hostname)) throw new Error(`outlier_scan_board only opens Outlier (app.outlier.bet), not ${url.hostname}. Use your own browser tools for other sites.`);
                        pages = [{ kind: args.kind === 'odds' ? 'odds' : 'props', url: url.href }];
                    }
                    const nav = Object.fromEntries(['section', 'sport', 'market', 'game', 'day'].filter(k => args[k] && String(args[k]).trim()).map(k => [k, String(args[k]).trim()]));
                    if (Object.keys(nav).length) {
                        // Navigation starts on one board: the address given, else the first configured props page.
                        const start = pages ? pages[0] : { kind: 'props', url: outlier.boardStart ? outlier.boardStart() : 'https://app.outlier.bet/' };
                        pages = [{ ...start, nav }];
                    }
                    const run = await outlier.scrape({ pages });
                    const where = run && run.navigated && run.navigated.length ? `Outlier > ${run.navigated.join(' > ')}\n` : '';
                    return { content: [{ type: 'text', text: where + auditText(outlier.state().result) }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: err.message }], isError: true };
                }
            }
            if (name === 'outlier_guide') return { content: [{ type: 'text', text: OUTLIER_GUIDE }] };
            if (name === 'outlier_read_section') {
                try {
                    if (!args.section || !String(args.section).trim()) throw new Error('Name the section, e.g. "Insights".');
                    if (/(\+?ev|positive ev|arbitrage|middle|boost)/i.test(String(args.section))) throw new Error(`${args.section} is one of Outlier's Pro tools, not part of building a prop ticket. Use outlier_scan_board or outlier_research_list for props.`);
                    const read = await outlier.readSection({ section: String(args.section).trim(), sport: args.sport, day: args.day });
                    return { content: [{ type: 'text', text: `Outlier > ${read.steps.join(' > ')}\n${read.url}\n\n${read.text}` }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: err.message }], isError: true };
                }
            }
            if (name === 'outlier_research_list') {
                try {
                    const legs = (Array.isArray(args.legs) ? args.legs : []).filter(l => l && String(l.player || '').trim())
                        .map(l => ({ player: String(l.player).trim(), stat: l.stat ? String(l.stat).trim() : null, line: l.line == null || l.line === '' ? null : Number(l.line), side: l.side ? String(l.side).trim() : null }));
                    if (!legs.length) throw new Error('Give the legs: [{ player, stat, line, side }].');
                    let url = null;
                    if (args.url) {
                        const parsed = new URL(resolveAddress(String(args.url)).url);
                        if (!/(^|\.)outlier\.bet$/i.test(parsed.hostname)) throw new Error(`outlier_research_list only opens Outlier (app.outlier.bet), not ${parsed.hostname}.`);
                        url = parsed.href;
                    }
                    const day = args.day || (/\btomorrow\b/i.test(String(args.game || '')) ? 'tomorrow' : null);
                    const nav = Object.fromEntries(Object.entries({ sport: args.sport, game: args.game, day }).filter(([, v]) => v && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
                    // The audit on just these legs, from one read of the board.
                    let audit = '';
                    try {
                        await outlier.scrape({ pages: [{ kind: 'props', url: url || outlier.boardStart(), nav: { ...nav, player: legs[0].player } }], keep: legs });
                        audit = auditText(outlier.state().result);
                    } catch (err) {
                        audit = `The audit couldn't run: ${err.message}`;
                    }
                    const boardLegs = ((outlier.state().result || {}).legs) || [];
                    const read = await outlier.researchList({ url, ...nav, legs });
                    const lines = read.results.map((r, i) => {
                        const l = r.leg;
                        const head = `${i + 1}. ${l.player}${l.side ? ` ${l.side}` : ''}${l.line != null ? ` ${l.line}` : ''}${l.stat ? ` ${l.stat}` : ''}`;
                        const board = lineNote(l, boardLegs);
                        if (r.error) return `${head}: not found on Outlier (${r.error})${board ? `\n   ${board}` : ''}`;
                        return `${head}${/another stat/.test(r.opened) ? ' (no prop for this stat on Outlier: his card for another stat was read)' : ''}\n   ${board ? `${board}\n   ` : ''}${r.summary}`;
                    });
                    const found = read.results.filter(r => !r.error).length;
                    const checks = legChecks(legs);
                    const text = `Outlier > ${read.steps.join(' > ')}\nResearched ${found} of ${legs.length} legs.\n${lines.join('\n')}\n`
                        + (checks.length ? `Checks:\n${checks.map(c => `- ${c}`).join('\n')}\n` : '')
                        + `Audit of these legs:\n${audit}\n`
                        + 'Build the slip only from these legs: favor green hit rates across several windows on the user\'s own line, a weak opponent rank, steady minutes, no injury doubt and an easier line than Outlier\'s; give one reason per leg. Estimates, not guarantees.';
                    return { content: [{ type: 'text', text }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: err.message }], isError: true };
                }
            }
            if (name === 'outlier_research') {
                try {
                    let url = null;
                    if (args.url) {
                        const parsed = new URL(resolveAddress(String(args.url)).url);
                        if (!/(^|\.)outlier\.bet$/i.test(parsed.hostname)) throw new Error(`outlier_research only opens Outlier (app.outlier.bet), not ${parsed.hostname}.`);
                        url = parsed.href;
                    }
                    const pick = Object.fromEntries(['section', 'sport', 'market', 'game', 'player'].filter(k => args[k] && String(args[k]).trim()).map(k => [k, String(args[k]).trim()]));
                    if (!pick.player && !pick.game) throw new Error('Give a player (his Market Details) or a game (its page).');
                    const read = await outlier.research({ url, ...pick });
                    return { content: [{ type: 'text', text: `Outlier > ${read.steps.join(' > ')}\n${read.url}\n\n${read.text}` }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: err.message }], isError: true };
                }
            }
            if (name === 'outlier_import_board') {
                try {
                    await outlier.importFile({ file: args.path });
                    return { content: [{ type: 'text', text: auditText(outlier.state().result) }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: err.message }], isError: true };
                }
            }
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
            // The page open in the live view right now (default the signed-in Outlier browser).
            'POST /outlier/read-page': safe(async body => {
                const parsed = await outlier.readOpenPage({ agentId: body.agentId || outlier.session, kind: body.kind });
                return { ...outlier.state(), read: { props: parsed.props.length, pages: parsed.pages } };
            }),
            'POST /outlier/scrape': safe(async () => { await outlier.scrape(); return outlier.state(); }),
            // Passive capture while you scroll the Outlier browser: { on: true|false, clear }.
            'POST /outlier/capture': safe(body => outlier.setCapture(body)),
            // A board JSON in the project folder: { file }.
            'POST /outlier/import': safe(body => outlier.importFile(body)),
            'POST /outlier/analyze': safe(async () => { await outlier.analyze(); return outlier.state(); }),
            'POST /outlier/snapshot': safe(() => outlier.snapshot()),
            'POST /outlier/config': safe(body => outlier.setConfig(body)),
            'POST /outlier/track': safe(body => outlier.track(body.slipId, body.stake)),
            'POST /outlier/strategy': safe(body => outlier.setStrategy(body)),
            'POST /outlier/market/refresh': safe(() => outlier.refreshMarketRoute()),
            'POST /outlier/market/config': safe(body => { outlier.setMarketConfig(body); return outlier.state(); }),
            'POST /outlier/untrack': safe(body => outlier.untrack(body.entryId)),
            'POST /outlier/outcomes': safe(async body => { await outlier.recordOutcomes(body.entryId, body.results); return outlier.state(); }),
            'POST /outlier/reset-weights': safe(async () => { await outlier.resetWeights(); return outlier.state(); }),
            'POST /outlier/forget-signin': safe(() => outlier.forgetSignIn())
        },
        status: () => outlier.status(),
        close: () => outlier.close()
    };
}

module.exports = { createService, createOutlierPipeline, runPython, sameLeg, propId, OUTLIER_PRIMER, OUTLIER_GUIDE };
