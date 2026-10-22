// Headless Chromium for the agents. Every agent gets its own browser: its own
// user data folder (profile, cache, cookies, local storage), created in a
// temporary folder when the agent first opens a page and deleted when the session
// closes, so nothing one agent signs in to is visible to another.
// The browser comes from playwright-core. It uses, in order: CODEV_BROWSER_PATH,
// Playwright's own Chromium (npx playwright install chromium), then the Edge or
// Chrome already installed on this computer.
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
            if (now - session.lastUsed > idleMs) {
                log(`[Browser] Closing ${agentId}'s browser after ${Math.round(idleMs / 60000)} idle minutes.`);
                close(agentId);
            }
        }
        if (!sessions.size && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    }

    async function open(agentId) {
        if (sessions.size >= maxSessions) {
            const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
            log(`[Browser] ${maxSessions} browsers are open; closing ${oldest[0]}'s.`);
            await close(oldest[0]);
        }
        fs.mkdirSync(ownRoot, { recursive: true });
        const dir = fs.mkdtempSync(path.join(ownRoot, `${agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-`));
        let context;
        try { context = await launch(dir); } catch (err) {
            removeDir(dir);
            throw err;
        }
        await context.route(url => isBlocked(url), route => route.abort('blockedbyclient'));
        const session = { agentId, dir, context, page: context.pages()[0] || await context.newPage(), lastUsed: Date.now(), startedAt: Date.now() };
        // A link that opens a new tab becomes the page the agent is working on.
        context.on('page', page => {
            session.page = page;
            page.on('close', () => { if (session.page === page) session.page = context.pages().slice(-1)[0] || null; });
        });
        // The browser can also exit by itself (crash, or the user ends it).
        context.on('close', () => {
            if (sessions.get(agentId) !== session) return;
            sessions.delete(agentId);
            removeDir(dir);
        });
        sessions.set(agentId, session);
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
        if (!session.page || session.page.isClosed()) session.page = await session.context.newPage();
        session.lastUsed = Date.now();
        return session;
    }

    async function close(agentId) {
        const session = sessions.get(agentId);
        if (!session) return false;
        sessions.delete(agentId);
        try { await session.context.close(); } catch { /* already gone */ }
        removeDir(session.dir);
        return true;
    }

    async function closeAll() {
        await Promise.all([...sessions.keys()].map(close));
        removeDir(ownRoot);
    }

    function list() {
        return [...sessions.values()].map(s => ({ agentId: s.agentId, url: s.page && !s.page.isClosed() ? s.page.url() : null,
            startedAt: new Date(s.startedAt).toISOString(), idleSeconds: Math.round((Date.now() - s.lastUsed) / 1000) }));
    }

    return { get, has: agentId => sessions.has(agentId), close, closeAll, list, status, isBlocked };
}

module.exports = { createBrowserManager, BrowserUnavailableError };
