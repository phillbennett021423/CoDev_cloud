// Headless Chromium for the agents. Every agent gets its own browser: its own
// user data folder (profile, cache, cookies, local storage), created in a
// temporary folder when the agent first opens a page and deleted when the session
// closes, so nothing one agent signs in to is visible to another. The one
// exception is a browser given a kept profile with registerProfile (the Outlier
// pipeline's), whose sign-ins carry over.
// The browser comes from playwright-core. It uses, in order: CODEV_BROWSER_PATH,
// Playwright's own Chromium (npx playwright install chromium), then the Edge or
// Chrome already installed on this computer.
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const VIEWPORT = { width: 1280, height: 800 };

class BrowserUnavailableError extends Error {}

function loadPlaywright() {
    try { return require('playwright-core'); } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') throw err;
        return null;
    }
}

// Chromium can still be writing to its profile for a moment after it closes.
function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* removed on the next start */ }
}

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// blockedOrigins: addresses agents' browsers must never load, like CoDev's own
// server and helper, so a page can't drive CoDev's local endpoints.
function createBrowserManager({ profileRoot = path.join(os.tmpdir(), 'codev-browser-profiles'), blockedOrigins = [],
    maxSessions = DEFAULT_MAX_SESSIONS, idleMs = DEFAULT_IDLE_MS, log = console.log, playwright = loadPlaywright() } = {}) {
    // This process's profiles live in their own folder; folders left by a CoDev
    // that crashed are removed when the next one starts.
    const ownRoot = path.join(profileRoot, String(process.pid));
    try {
        for (const entry of fs.readdirSync(profileRoot)) {
            if (/^\d+$/.test(entry) && !isProcessAlive(Number(entry))) removeDir(path.join(profileRoot, entry));
        }
    } catch { /* no profiles yet */ }

    const blocked = blockedOrigins.map(origin => new URL(origin)).map(u => ({ port: u.port || (u.protocol === 'https:' ? '443' : '80'), loopback: isLoopback(u.hostname), host: u.hostname }));
    const sessions = new Map();
    // agentId -> a profile folder of its own that is kept, not a temporary one
    // (the Outlier pipeline's signed-in profile). See registerProfile.
    const profiles = new Map();
    // 'open' (session), 'page' (session, when the agent's working page changes) and
    // 'close' (agentId), for the live view.
    const events = new EventEmitter();
    let launchChoice = null;
    let sweepTimer = null;

    function isLoopback(host) {
        return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
    }

    function isBlocked(url) {
        if (!/^(https?|wss?):$/.test(url.protocol)) return false;
        const port = url.port || (/^(https|wss):$/.test(url.protocol) ? '443' : '80');
        return blocked.some(b => b.port === port && (b.loopback ? isLoopback(url.hostname) : b.host === url.hostname));
    }

    // Each way to get a Chromium, tried until one starts.
    function launchCandidates() {
        const list = [];
        if (process.env.CODEV_BROWSER_PATH) list.push({ label: `CODEV_BROWSER_PATH (${process.env.CODEV_BROWSER_PATH})`, options: { executablePath: process.env.CODEV_BROWSER_PATH } });
        let bundled = '';
        try { bundled = playwright.chromium.executablePath(); } catch { bundled = ''; }
        if (bundled && fs.existsSync(bundled)) list.push({ label: "Playwright's Chromium", options: {} });
        list.push({ label: 'Microsoft Edge', options: { channel: 'msedge' } }, { label: 'Google Chrome', options: { channel: 'chrome' } });
        return list;
    }

    function status() {
        if (!playwright) return { available: false, detail: 'The browser tools need playwright-core: run "npm install" (or npm run setup), then restart CoDev.' };
        if (launchChoice) return { available: true, detail: `Headless ${launchChoice.label}, ${sessions.size} open session(s).` };
        const candidates = launchCandidates();
        const known = candidates.filter(c => c.options.executablePath || !c.options.channel);
        return { available: true, detail: known.length ? `Headless ${known[0].label}.` : 'Will use Edge or Chrome if installed; otherwise run "npx playwright install chromium" (npm run setup).' };
    }

    async function launch(userDataDir) {
        if (!playwright) throw new BrowserUnavailableError(status().detail);
        const base = {
            headless: true,
            viewport: VIEWPORT,
            acceptDownloads: false,
            serviceWorkers: 'block',
            // CoDev closes the browsers itself on Ctrl+C or quit, then deletes the profiles;
            // Playwright's own signal handlers would exit before that runs.
            handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
            args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync']
        };
        const candidates = launchChoice ? [launchChoice] : launchCandidates();
        const failures = [];
        for (const candidate of candidates) {
            try {
                const context = await playwright.chromium.launchPersistentContext(userDataDir, { ...base, ...candidate.options });
                if (!launchChoice) log(`[Browser] Using headless ${candidate.label}.`);
                launchChoice = candidate;
                return context;
            } catch (err) {
                failures.push(`${candidate.label}: ${String(err.message).split('\n')[0]}`);
            }
        }
        launchChoice = null;
        throw new BrowserUnavailableError(`No browser could start for the agent. Run "npx playwright install chromium" (or npm run setup), or set CODEV_BROWSER_PATH to a Chrome/Edge executable.\n${failures.join('\n')}`);
    }

    function sweepIdle() {
        const now = Date.now();
        for (const [agentId, session] of sessions) {
            // A browser paused for the user stays open until they deal with it.
            if (!session.paused && now - session.lastUsed > idleMs) {
                log(`[Browser] Closing ${agentId}'s browser after ${Math.round(idleMs / 60000)} idle minutes.`);
                close(agentId);
            }
        }
        if (!sessions.size && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    }

    async function open(agentId) {
        if (sessions.size >= maxSessions) {
            const byAge = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
            const oldest = byAge.find(([id]) => !profiles.has(id)) || byAge[0];
            log(`[Browser] ${maxSessions} browsers are open; closing ${oldest[0]}'s.`);
            await close(oldest[0]);
        }
        const kept = profiles.get(agentId);
        let dir;
        if (kept) {
            fs.mkdirSync(kept, { recursive: true });
            dir = kept;
        } else {
            fs.mkdirSync(ownRoot, { recursive: true });
            dir = fs.mkdtempSync(path.join(ownRoot, `${agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-`));
        }
        const drop = () => { if (!kept) removeDir(dir); };
        let context;
        try { context = await launch(dir); } catch (err) {
            drop();
            if (kept && /ProcessSingleton|profile.*in use|user data directory is already in use/i.test(err.message)) {
                throw new BrowserUnavailableError(`${agentId}'s browser profile is open in another window. Close that window first.`);
            }
            throw err;
        }
        await context.route(url => isBlocked(url), route => route.abort('blockedbyclient'));
        // page: the tab the live view shows. userControl: the user drives it in the
        // live view; the agent then works in agentPage, a background tab of the same
        // browser (same cookies and sign-ins), and never touches the user's tab.
        const session = { agentId, dir, kept: Boolean(kept), context, page: context.pages()[0] || await context.newPage(), agentPage: null,
            openingAgentPage: false, lastUsed: Date.now(), startedAt: Date.now(), userControl: false };
        // A link that opens a new tab becomes the page whoever clicked it is working on.
        context.on('page', page => {
            if (session.openingAgentPage) return;
            const show = () => {
                session.page = page;
                events.emit('page', session);
            };
            if (!session.agentPage) show();
            else page.opener().then(opener => { if (opener && opener === session.agentPage) session.agentPage = page; else show(); }, show);
            page.on('close', () => {
                if (session.agentPage === page) session.agentPage = null;
                if (session.page !== page) return;
                session.page = context.pages().filter(p => p !== session.agentPage).slice(-1)[0] || null;
                if (session.page) events.emit('page', session);
            });
        });
        // The browser can also exit by itself (crash, or the user ends it).
        context.on('close', () => {
            if (sessions.get(agentId) !== session) return;
            sessions.delete(agentId);
            drop();
            events.emit('close', agentId);
        });
        sessions.set(agentId, session);
        events.emit('open', session);
        if (!sweepTimer) {
            sweepTimer = setInterval(sweepIdle, 60 * 1000);
            sweepTimer.unref();
        }
        return session;
    }

    const opening = new Map();
    // The agent's session, started on first use. Two calls at once share one start.
    async function get(agentId) {
        let session = sessions.get(agentId);
        if (!session) {
            if (!opening.has(agentId)) opening.set(agentId, open(agentId).finally(() => opening.delete(agentId)));
            session = await opening.get(agentId);
        }
        if (!session.page || session.page.isClosed()) {
            session.page = await session.context.newPage();
            events.emit('page', session);
        }
        session.lastUsed = Date.now();
        return session;
    }

    // The tab the agent should act in: the shown one, or while the user drives it, a
    // background tab of its own (opened on the user's page) so it never types or
    // clicks over the user.
    async function workPage(agentId) {
        const session = await get(agentId);
        if (!session.userControl) return session.page;
        if (!session.agentPage || session.agentPage.isClosed()) {
            session.openingAgentPage = true;
            try { session.agentPage = await session.context.newPage(); } finally { session.openingAgentPage = false; }
            // It starts on the page the user has open, so "click Save" means the same page.
            const url = session.page && !session.page.isClosed() ? session.page.url() : '';
            if (/^https?:/.test(url)) await session.agentPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            log(`[Browser] ${agentId} works in a background tab while you drive its browser.`);
        }
        return session.agentPage;
    }

    // The tab the agent reads: its background tab while it has one, else the shown one
    // (reading never gets in the user's way, so it doesn't need a tab of its own).
    async function readPage(agentId) {
        const session = await get(agentId);
        return session.agentPage && !session.agentPage.isClosed() ? session.agentPage : session.page;
    }

    // When the user hands back: the agent's background tab, if any, becomes the shown
    // one (the user's tab stays open behind it).
    function handBack(session) {
        if (session.agentPage && !session.agentPage.isClosed()) {
            session.page = session.agentPage;
            events.emit('page', session);
        }
        session.agentPage = null;
        session.paused = null;
    }

    // A dead link, redirect or parked page: instead of failing and closing, the page
    // stays open and shown, the user gets control in the live view, and the browser
    // is kept (no idle close) until they hand it back. page: the tab that hit it.
    function pause(agentId, page, reason) {
        const session = sessions.get(agentId);
        if (!session) return false;
        if (page && !page.isClosed() && session.page !== page) {
            if (session.agentPage === page) session.agentPage = null;
            session.page = page;
            events.emit('page', session);
        }
        session.paused = { reason: String(reason || ''), at: new Date().toISOString(), url: session.page && !session.page.isClosed() ? session.page.url() : '' };
        session.userControl = true;
        log(`[Browser] Paused ${agentId}'s browser for you: ${session.paused.reason}`);
        events.emit('pause', session);
        return true;
    }

    async function close(agentId) {
        const session = sessions.get(agentId);
        if (!session) return false;
        sessions.delete(agentId);
        try { await session.context.close(); } catch { /* already gone */ }
        if (!session.kept) removeDir(session.dir);
        events.emit('close', agentId);
        return true;
    }

    async function closeAll() {
        await Promise.all([...sessions.keys()].map(close));
        removeDir(ownRoot);
    }

    function list() {
        return [...sessions.values()].map(s => ({ agentId: s.agentId, url: s.page && !s.page.isClosed() ? s.page.url() : null,
            startedAt: new Date(s.startedAt).toISOString(), idleSeconds: Math.round((Date.now() - s.lastUsed) / 1000), userControl: s.userControl }));
    }

    // An open session, without starting one or counting as the agent's use.
    const peek = agentId => sessions.get(agentId) || null;

    // agentId's browser keeps its profile in dir (cookies and sign-ins survive
    // closing it and restarting CoDev). Takes effect the next time it opens.
    function registerProfile(agentId, dir) {
        profiles.set(String(agentId), dir);
    }

    return { get, peek, workPage, readPage, handBack, pause, has: agentId => sessions.has(agentId), close, closeAll, list, status, isBlocked, events, registerProfile };
}

module.exports = { createBrowserManager, BrowserUnavailableError };
