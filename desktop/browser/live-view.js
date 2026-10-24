// Live view of the agents' browsers: the user watches an agent's page as it works,
// takes over with the mouse and keyboard, and sees its console, network requests
// and DOM changes in a side panel.
// The picture comes straight from Chromium over the DevTools protocol
// (Page.startScreencast sends a JPEG each time the page repaints), so it needs no
// VNC, X server or Docker: the browsers run on this computer, not in a container.
// While the user has control, the agent's browser tools work in a background tab of
// the same browser (browser-manager.js workPage), so the two never fight over a page;
// handing back shows the agent's tab.
const { resolveAddress, checkPage, advice } = require('./page-check');

const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 };
const MAX_BACKLOG = 300;
const MAX_TEXT = 500;
const DOM_BINDING = '__codevLiveDom';

class LiveError extends Error {}

const clip = (value, max = MAX_TEXT) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…` : text;
};

// Runs in every page of an agent's browser: sums up DOM mutations twice a second.
function domObserverScript(binding) {
    if (window.__codevLiveDomObserver || typeof window[binding] !== 'function') return;
    window.__codevLiveDomObserver = true;
    const describe = node => {
        if (!node || node.nodeType !== 1) return node && node.nodeType === 3 ? '#text' : '#node';
        const id = node.id ? `#${node.id}` : '';
        const cls = typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
        return `${node.tagName.toLowerCase()}${id}${cls}`;
    };
    let batch = null;
    const flush = () => {
        const sending = batch;
        batch = null;
        try { window[binding](sending); } catch (err) { /* page is unloading */ }
    };
    const start = () => new MutationObserver(records => {
        if (!batch) { batch = { added: 0, removed: 0, attributes: 0, text: 0, samples: [] }; setTimeout(flush, 500); }
        for (const r of records) {
            if (r.type === 'childList') {
                batch.added += r.addedNodes.length;
                batch.removed += r.removedNodes.length;
                if (batch.samples.length < 8 && r.addedNodes.length) batch.samples.push(`+ ${describe(r.addedNodes[0])} in ${describe(r.target)}`);
                if (batch.samples.length < 8 && r.removedNodes.length) batch.samples.push(`- ${describe(r.removedNodes[0])} from ${describe(r.target)}`);
            } else if (r.type === 'attributes') {
                batch.attributes++;
                if (batch.samples.length < 8) batch.samples.push(`~ ${describe(r.target)} [${r.attributeName}]`);
            } else batch.text++;
        }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
}

function createLiveView({ manager, isBlockedUrl, log = console.log }) {
    const watchers = new Map();   // agentId -> Set of listeners
    const backlogs = new Map();   // agentId -> recent inspector events
    const casts = new Map();      // agentId -> { page, cdp }
    const stateListeners = new Set();

    function send(agentId, event) {
        for (const listener of watchers.get(agentId) || []) {
            try { listener(event); } catch (err) { log(`[Live] ${err.message}`); }
        }
    }

    function record(agentId, event) {
        const entry = { at: Date.now(), ...event };
        const backlog = backlogs.get(agentId) || [];
        backlog.push(entry);
        if (backlog.length > MAX_BACKLOG) backlog.splice(0, backlog.length - MAX_BACKLOG);
        backlogs.set(agentId, backlog);
        send(agentId, entry);
    }

    function sessionsState() {
        return { type: 'sessions', sessions: manager.list() };
    }

    function broadcastSessions() {
        const state = sessionsState();
        for (const listeners of watchers.values()) for (const listener of listeners) { try { listener(state); } catch { /* gone */ } }
        for (const listener of stateListeners) { try { listener(state); } catch { /* gone */ } }
    }

    // Console, errors, network and navigation from one page. No headers or bodies:
    // they carry cookies and form data, like the password a login just typed.
    function wirePage(agentId, page) {
        if (page.__codevLiveWired) return;
        page.__codevLiveWired = true;
        page.on('console', msg => record(agentId, { type: 'console', level: msg.type(), text: clip(msg.text()) }));
        page.on('pageerror', err => record(agentId, { type: 'console', level: 'error', text: clip(err.message) }));
        page.on('request', req => record(agentId, { type: 'network', phase: 'request', method: req.method(), url: clip(req.url(), 300), resource: req.resourceType() }));
        page.on('response', res => record(agentId, { type: 'network', phase: 'response', status: res.status(), url: clip(res.url(), 300), method: res.request().method() }));
        page.on('requestfailed', req => record(agentId, { type: 'network', phase: 'failed', method: req.method(), url: clip(req.url(), 300), error: clip(req.failure() && req.failure().errorText, 120) }));
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) record(agentId, { type: 'nav', url: clip(frame.url(), 300) }); });
    }

    async function wireSession(session) {
        const { agentId, context } = session;
        context.pages().forEach(page => wirePage(agentId, page));
        context.on('page', page => wirePage(agentId, page));
        try {
            // A page could call this binding itself; it can only add lines to the DOM panel.
            await context.exposeBinding(DOM_BINDING, (_source, batch) => {
                if (!batch || typeof batch !== 'object') return;
                record(agentId, { type: 'dom', added: Number(batch.added) || 0, removed: Number(batch.removed) || 0,
                    attributes: Number(batch.attributes) || 0, text: Number(batch.text) || 0,
                    samples: (Array.isArray(batch.samples) ? batch.samples : []).slice(0, 8).map(s => clip(s, 120)) });
            });
            await context.addInitScript(domObserverScript, DOM_BINDING);
            await Promise.all(context.pages().map(page => page.evaluate(domObserverScript, DOM_BINDING).catch(() => {})));
        } catch (err) {
            log(`[Live] DOM changes unavailable for ${agentId}: ${err.message}`);
        }
    }

    async function stopCast(agentId) {
        const cast = casts.get(agentId);
        casts.delete(agentId);
        if (!cast) return;
        try { await cast.cdp.send('Page.stopScreencast'); } catch { /* page closed */ }
        try { await cast.cdp.detach(); } catch { /* page closed */ }
    }

    // Streams the agent's current page while anyone is watching it.
    async function startCast(agentId) {
        const session = manager.peek(agentId);
        if (!session || !session.page || !(watchers.get(agentId) || new Set()).size) return;
        const current = casts.get(agentId);
        if (current && current.page === session.page) return;
        await stopCast(agentId);
        const page = session.page;
        let cdp;
        try { cdp = await session.context.newCDPSession(page); } catch (err) { return log(`[Live] Can't stream ${agentId}: ${err.message}`); }
        casts.set(agentId, { page, cdp });
        cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
            cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
            send(agentId, { type: 'frame', data, width: metadata.deviceWidth, height: metadata.deviceHeight, url: page.isClosed() ? '' : page.url() });
        });
        try { await cdp.send('Page.startScreencast', SCREENCAST); } catch (err) { log(`[Live] ${err.message}`); }
    }

    // The screencast only sends a frame when the page repaints, so a viewer who opens
    // a page that has already loaded gets the current picture this way.
    async function sendSnapshot(agentId) {
        const cast = casts.get(agentId);
        if (!cast || cast.page.isClosed()) return;
        try {
            const { cssLayoutViewport: viewport } = await cast.cdp.send('Page.getLayoutMetrics');
            const { data } = await cast.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: SCREENCAST.quality });
            send(agentId, { type: 'frame', data, width: viewport.clientWidth, height: viewport.clientHeight, url: cast.page.isClosed() ? '' : cast.page.url() });
        } catch { /* page closed or navigating; the screencast sends the next frame */ }
    }

    manager.events.on('open', session => {
        wireSession(session);
        startCast(session.agentId);
        broadcastSessions();
    });
    manager.events.on('page', session => { startCast(session.agentId); broadcastSessions(); });
    // Everyone watching anything hears about a pause, so the page can open that browser.
    manager.events.on('pause', session => {
        const event = { type: 'paused', agentId: session.agentId, text: session.paused.reason, url: session.paused.url };
        send(session.agentId, { type: 'state', agentId: session.agentId, open: true, userControl: true });
        for (const [agentId, listeners] of watchers) if (agentId !== session.agentId) for (const l of listeners) { try { l(event); } catch { /* gone */ } }
        for (const l of watchers.get(session.agentId) || []) { try { l(event); } catch { /* gone */ } }
        for (const l of stateListeners) { try { l(event); } catch { /* gone */ } }
        broadcastSessions();
    });
    manager.events.on('close', agentId => {
        casts.delete(agentId);
        send(agentId, { type: 'closed', agentId });
        broadcastSessions();
    });

    // listener(event) gets: sessions, state, frame, console, network, dom, nav, closed.
    // agentId '' only gets the session list, for picking which browser to watch.
    function subscribe(agentId, listener) {
        if (!agentId) {
            stateListeners.add(listener);
            listener(sessionsState());
            return () => stateListeners.delete(listener);
        }
        const set = watchers.get(agentId) || new Set();
        set.add(listener);
        watchers.set(agentId, set);
        listener(sessionsState());
        const session = manager.peek(agentId);
        listener({ type: 'state', agentId, open: !!session, userControl: !!(session && session.userControl) });
        for (const event of backlogs.get(agentId) || []) listener({ ...event, backlog: true });
        startCast(agentId).then(() => sendSnapshot(agentId));
        return () => {
            set.delete(listener);
            if (!set.size) { watchers.delete(agentId); stopCast(agentId); }
        };
    }

    function setControl(session, userControl) {
        if (session.userControl === userControl) return;
        session.userControl = userControl;
        if (!userControl) manager.handBack(session);
        log(`[Live] ${userControl ? 'You took over' : 'You handed back'} ${session.agentId}'s browser.`);
        send(session.agentId, { type: 'state', agentId: session.agentId, open: true, userControl });
        broadcastSessions();
    }

    // The user's own input. Any input takes control from the agent until "release".
    // "open" and "navigate" also start the browser when it isn't open yet, so the
    // user can browse in an agent's browser (or the Outlier one) before the agent
    // does, and the agent picks up on that same page when it's handed back.
    async function control(agentId, req = {}) {
        const id = String(agentId || '');
        const { op } = req;
        let session = manager.peek(id);
        const fresh = !session;
        if (!session && (op === 'open' || op === 'navigate') && id) session = await manager.get(id);
        // "open" with a url: go there only if this just opened the browser (else keep the user's page).
        if (op === 'open' && req.url && fresh && session) return control(id, { op: 'navigate', url: req.url });
        if (!session) throw new LiveError(`${agentId || 'That agent'} has no browser open.`);
        if (op === 'release') { setControl(session, false); return { ok: true }; }
        setControl(session, true);
        session.lastUsed = Date.now();
        const page = session.page;
        if (!page || page.isClosed()) throw new LiveError('The page closed.');
        const x = Number(req.x) || 0;
        const y = Number(req.y) || 0;
        const button = ['left', 'right', 'middle'].includes(req.button) ? req.button : 'left';
        switch (op) {
            case 'takeover': case 'open': break;
            case 'move': await page.mouse.move(x, y); break;
            case 'down': await page.mouse.move(x, y); await page.mouse.down({ button }); break;
            case 'up': await page.mouse.move(x, y); await page.mouse.up({ button }); break;
            case 'wheel': await page.mouse.move(x, y); await page.mouse.wheel(Number(req.deltaX) || 0, Number(req.deltaY) || 0); break;
            case 'keydown': await page.keyboard.down(String(req.key)); break;
            case 'keyup': await page.keyboard.up(String(req.key)); break;
            case 'text': await page.keyboard.insertText(clip(req.text, 5000)); break;
            case 'navigate': {
                // An address, a bare domain or words to search for.
                let url;
                try { url = new URL(resolveAddress(req.url).url); } catch (err) { throw new LiveError(err.message); }
                if (url.href !== 'about:blank' && (!/^https?:$/.test(url.protocol) || isBlockedUrl(url))) throw new LiveError(`Agents' browsers can't open ${url.href}.`);
                let response = null;
                let check;
                try {
                    response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    check = url.href === 'about:blank' ? { ok: true } : await checkPage(page, response);
                } catch (err) {
                    check = await checkPage(page, null, { error: err });
                }
                if (!check.ok) {
                    const warning = advice(check, url.href);
                    send(id, { type: 'warning', agentId: id, text: warning, url: page.url() });
                    return { ok: true, url: page.url(), warning };
                }
                return { ok: true, url: page.url() };
            }
            case 'back': await page.goBack({ timeout: 10000 }).catch(() => {}); break;
            case 'forward': await page.goForward({ timeout: 10000 }).catch(() => {}); break;
            case 'reload': await page.reload({ timeout: 30000 }).catch(() => {}); break;
            default: throw new LiveError(`Unknown live control: ${op}`);
        }
        return { ok: true };
    }

    function isUserControlled(agentId) {
        const session = manager.peek(agentId);
        return !!(session && session.userControl);
    }

    return { subscribe, control, isUserControlled, LiveError };
}

module.exports = { createLiveView, LiveError };
