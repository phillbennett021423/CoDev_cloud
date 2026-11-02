// Passive capture: while you scroll Outlier in the live view, a MutationObserver
// inside the page notes every prop card that appears (virtualized boards remove
// cards as they scroll away, so a one-time read would miss them) and keeps its
// text in a buffer in the page. CoDev drains that buffer every few seconds into
// a scratchpad of parsed props. Nothing here scrolls, clicks, focuses or resizes
// anything: the observer only reads text, so the page and your scroll position
// are left alone.

// Runs inside the page (Playwright serializes it). Installs once per document; a
// document replaced in the same window (document.write) keeps the buffer.
function installCapture() {
    const existing = window.__codevCapture;
    if (existing && existing.doc === document) return;
    const ODDS = /(^|[\s(])[+\-−]\d{3,4}(?=$|[\s)])/;
    const LINE = /\b(o|u|over|under|more|less|higher|lower)\s?\d+(\.\d+)?\b|\b\d+\.5\b/i;
    const MAX_CARDS = 3000;
    const buffer = existing || { cards: new Map(), total: 0 };
    buffer.doc = document;
    if (!existing) Object.defineProperty(window, '__codevCapture', { value: buffer, enumerable: false });
    const text = el => (el.innerText || el.textContent || '').replace(/ /g, ' ').trim();
    const qualifies = el => {
        if (!el || el.nodeType !== 1 || !el.isConnected) return false;
        const t = text(el);
        return t.length > 0 && t.length <= 800 && ODDS.test(t) && LINE.test(t);
    };
    const keep = el => {
        const t = text(el);
        if (buffer.cards.has(t)) return;
        buffer.cards.set(t, { url: location.href, at: Date.now() });
        buffer.total++;
        if (buffer.cards.size > MAX_CARDS) buffer.cards.delete(buffer.cards.keys().next().value);
    };
    const SELECTOR = 'div, li, tr, article, section, a, [role="row"]';
    // The smallest card that holds el (a price changed inside a card), and the
    // smallest cards inside el (a block of new rows scrolled in).
    function scan(el) {
        let up = el;
        for (let i = 0; up && i < 8; i++, up = up.parentElement) {
            if (qualifies(up)) {
                if (![...up.querySelectorAll(SELECTOR)].some(qualifies)) keep(up);
                break;
            }
        }
        const inside = [...el.querySelectorAll(SELECTOR)].filter(qualifies);
        const set = new Set(inside);
        for (const card of inside) {
            if (![...card.querySelectorAll('*')].some(other => set.has(other))) keep(card);
        }
    }
    let pending = new Set();
    let scheduled = false;
    const idle = window.requestIdleCallback || (fn => setTimeout(fn, 200));
    const flush = () => {
        scheduled = false;
        const roots = [...pending];
        pending = new Set();
        // Drop roots inside other roots: their cards are scanned with the outer one.
        for (const el of roots) {
            if (el.isConnected && !roots.some(other => other !== el && other.contains(el))) scan(el);
        }
    };
    const queue = node => {
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (!el) return;
        pending.add(el);
        if (!scheduled) { scheduled = true; idle(flush, { timeout: 800 }); }
    };
    new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'characterData') queue(m.target);
            else m.addedNodes.forEach(queue);
        }
    }).observe(document, { childList: true, subtree: true, characterData: true });   // the document, not <html>: an init script runs before <html> exists
    if (document.body) queue(document.body);
    else document.addEventListener('DOMContentLoaded', () => queue(document.body), { once: true });
}

// Runs inside the page: hands over what was seen since the last drain.
function drainCapture() {
    const buffer = window.__codevCapture;
    if (!buffer) return null;
    const cards = [...buffer.cards.entries()].map(([text, seen]) => ({ text, ...seen }));
    buffer.cards.clear();
    return { cards, total: buffer.total, url: location.href };
}

// The controller on CoDev's side. getSession: the open browser session (or null);
// parse(text, url) -> prop or null; onProps(newProps) after each drain that found some.
function createCapture({ getSession, parse, onProps = () => {}, intervalMs = 3000, log = () => {} }) {
    const scratch = new Map();   // prop id -> prop, newest card wins
    const state = { on: false, cards: 0, lastAt: null, url: null, error: null };
    const installed = new WeakSet();
    let timer = null;

    async function install(session) {
        if (!installed.has(session.context)) {
            installed.add(session.context);
            // Every page the browser opens from now on, before its own scripts run.
            await session.context.addInitScript(installCapture);
        }
        for (const page of session.context.pages()) await page.evaluate(installCapture).catch(() => {});
    }

    async function drain() {
        const session = getSession();
        if (!session) { state.error = 'The Outlier browser closed.'; return []; }
        await install(session);
        const fresh = [];
        for (const page of session.context.pages()) {
            const got = await page.evaluate(drainCapture).catch(() => null);
            if (!got) continue;
            state.url = got.url;
            for (const card of got.cards) {
                state.cards++;
                const prop = parse(card.text, card.url);
                if (!prop) continue;
                const before = scratch.get(prop.id);
                scratch.set(prop.id, prop);
                if (!before || JSON.stringify(before.odds) !== JSON.stringify(prop.odds)) fresh.push(prop);
            }
        }
        state.lastAt = new Date().toISOString();
        state.error = null;
        if (fresh.length) await onProps(fresh);
        return fresh;
    }

    async function start() {
        const session = getSession();
        if (!session) throw new Error('Open the Outlier browser in the live view first (🖥️ Browse in the Outlier tab).');
        await install(session);
        state.on = true;
        if (!timer) {
            timer = setInterval(() => drain().catch(err => { state.error = err.message; }), intervalMs);
            timer.unref?.();
        }
        log('[Outlier] Passive capture on: scroll Outlier in the live view and props are collected as they appear.');
        return status();
    }

    function stop() {
        state.on = false;
        if (timer) { clearInterval(timer); timer = null; }
        return status();
    }

    function clear() {
        scratch.clear();
        state.cards = 0;
        return status();
    }

    const status = () => ({ ...state, props: scratch.size });
    return { start, stop, drain, clear, status, props: () => [...scratch.values()] };
}

module.exports = { installCapture, drainCapture, createCapture };
