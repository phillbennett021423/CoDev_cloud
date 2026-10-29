// Synced chats: each chat, the saved memory and the agents follow the CoDev
// account to every device. Everything is locked here, on the device, before it is
// uploaded: AES-GCM with a key made from a passphrase only the person knows
// (PBKDF2, 600,000 rounds). CoDev's server stores scrambled text it can't open,
// and so can't the app's owner. Forget the passphrase and the synced copies are
// gone for good; the chats on each device stay.
//
// The page hands over three functions with CodevSync.attach():
//   collect()            → { key: value } of what to sync now (chat:<id>, memories, workspace)
//   apply(key, value)    → put a value from another device in place (null = deleted there)
//   applied()            → redraw after a pull changed something
// and calls CodevSync.changed() whenever it saves.
(function (root) {
    "use strict";

    const ROUNDS = 600000;
    const CHECK_TEXT = "codev-vault-check-v1";
    const MAX_ITEM_CHARS = 1400000;   // locked and base64'd, this stays under the server's 1.9 MB
    const BATCH_CHARS = 4000000;
    const PUSH_DELAY_MS = 4000;
    const PULL_EVERY_MS = 120000;

    let page = null;
    let key = null;
    let busy = null;
    let pushTimer = null;
    let lastError = "";
    let lastSync = 0;
    const listeners = [];

    const read = name => { try { return localStorage.getItem(name) || ""; } catch (err) { return ""; } };
    const write = (name, value) => { try { value ? localStorage.setItem(name, value) : localStorage.removeItem(name); } catch (err) { /* storage off */ } };
    const email = () => root.CodevCloud?.account?.email || "";
    const keyName = () => `codev_sync_key_${email()}`;
    const stateName = () => `codev_sync_state_${email()}`;

    function loadState() {
        try { const s = JSON.parse(read(stateName()) || "null"); if (s && s.items) return s; } catch (err) { /* start over */ }
        return { cursor: 0, items: {} };
    }
    const saveState = state => write(stateName(), JSON.stringify(state));

    function notify() { listeners.forEach(fn => { try { fn(status()); } catch (err) { console.error(err); } }); }

    // ---- Locking ----------------------------------------------------------------

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    function b64(bytes) {
        let s = "";
        const view = new Uint8Array(bytes);
        for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function unb64(text) {
        const s = atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }

    async function deriveKey(passphrase, salt) {
        const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ROUNDS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    }

    async function lock(text) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
        return { iv: b64(iv), data: b64(data) };
    }

    async function unlockText(iv, data, withKey = key) {
        return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, withKey, unb64(data)));
    }

    async function hash(text) {
        return b64(await crypto.subtle.digest("SHA-256", enc.encode(text)));
    }

    // The key stays on this device (the chats it locks are here in the clear anyway),
    // so the passphrase is asked for once per device.
    async function rememberKey(k) {
        key = k;
        write(keyName(), b64(await crypto.subtle.exportKey("raw", k)));
    }

    async function loadKey() {
        if (key || !email()) return key;
        const raw = read(keyName());
        if (!raw) return null;
        try { key = await crypto.subtle.importKey("raw", unb64(raw), "AES-GCM", true, ["encrypt", "decrypt"]); } catch (err) { key = null; }
        return key;
    }

    // ---- Passphrase -------------------------------------------------------------

    function checkPassphrase(passphrase) {
        if (String(passphrase || "").length < 8) throw new Error("Use at least 8 characters for the passphrase.");
    }

    async function setPassphrase(passphrase, { reset = false } = {}) {
        checkPassphrase(passphrase);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const k = await deriveKey(passphrase, salt);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const check = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(CHECK_TEXT));
        await root.CodevCloud.request("PUT", "/sync/vault", { salt: b64(salt), check_iv: b64(iv), check_data: b64(check), ...(reset ? { reset: true } : {}) });
        await rememberKey(k);
        saveState({ cursor: 0, items: {} });
        notify();
        return syncNow();
    }

    async function unlock(passphrase) {
        const { vault } = await root.CodevCloud.request("GET", "/sync/vault");
        if (!vault) throw new Error("No passphrase is set for this account yet.");
        const k = await deriveKey(passphrase, unb64(vault.salt));
        let text = "";
        try { text = await unlockText(vault.check_iv, vault.check_data, k); } catch (err) { /* wrong passphrase */ }
        if (text !== CHECK_TEXT) throw new Error("That passphrase isn't right.");
        await rememberKey(k);
        notify();
        return syncNow();
    }

    function forget() {
        key = null;
        if (email()) { write(keyName(), ""); write(stateName(), ""); }
        notify();
    }

    // "none" (signed out), "unknown" (not checked yet), "setup" (no passphrase yet),
    // "locked" (passphrase set, not on this device), "ready".
    let vaultKnown = null;
    function status() {
        if (!root.CodevCloud?.signedIn()) return "none";
        if (key) return "ready";
        if (vaultKnown === null) return "unknown";
        return vaultKnown ? "locked" : "setup";
    }

    async function refreshStatus() {
        if (!root.CodevCloud?.signedIn()) { key = null; vaultKnown = null; notify(); return status(); }
        if (await loadKey()) { notify(); return status(); }
        try { vaultKnown = Boolean((await root.CodevCloud.request("GET", "/sync/vault")).vault); } catch (err) { lastError = err.message; }
        notify();
        return status();
    }

    // ---- Syncing ----------------------------------------------------------------

    // A chat too big for one item loses its picture thumbnails and tool logs first,
    // then its oldest messages, on the synced copy only.
    function fit(value) {
        let text = JSON.stringify(value);
        if (text.length <= MAX_ITEM_CHARS || !value || !Array.isArray(value.messages)) return text;
        let messages = value.messages.map(m => {
            const lean = { ...m };
            delete lean.toolLog;
            if (lean.attachments) lean.attachments = lean.attachments.map(a => ({ ...a, thumb: "" }));
            return lean;
        });
        text = JSON.stringify({ ...value, messages });
        while (text.length > MAX_ITEM_CHARS && messages.length > 1) {
            messages = messages.slice(Math.ceil(messages.length / 4));
            text = JSON.stringify({ ...value, messages });
        }
        return text;
    }

    async function pull(state) {
        let changed = false;
        for (let page_ = 0; page_ < 50; page_++) {
            const reply = await root.CodevCloud.request("GET", `/sync/items?since=${state.cursor || 0}`);
            for (const item of reply.items) {
                const known = state.items[item.key];
                if (known && known.updatedAt >= item.updated_at) continue;
                if (item.deleted) {
                    page.apply(item.key, null);
                    state.items[item.key] = { hash: "", updatedAt: item.updated_at, deleted: true };
                } else {
                    let text;
                    try { text = await unlockText(item.iv, item.data); } catch (err) { console.warn(`[Sync] Couldn't unlock ${item.key}`); continue; }
                    page.apply(item.key, JSON.parse(text));
                    state.items[item.key] = { hash: await hash(text), updatedAt: item.updated_at };
                }
                changed = true;
            }
            state.cursor = reply.cursor;
            if (!reply.more) break;
        }
        return changed;
    }

    async function push(state) {
        const now = page.collect();
        const outgoing = [];
        for (const [itemKey, value] of Object.entries(now)) {
            const text = fit(value);
            const h = await hash(text);
            const known = state.items[itemKey];
            if (known && !known.deleted && known.hash === h) continue;
            const locked = await lock(text);
            outgoing.push({ key: itemKey, ...locked, updated_at: Date.now(), hash: h });
        }
        for (const [itemKey, known] of Object.entries(state.items)) {
            if (!known.deleted && !(itemKey in now)) outgoing.push({ key: itemKey, deleted: true, updated_at: Date.now(), hash: "" });
        }
        while (outgoing.length) {
            const batch = [];
            let size = 0;
            while (outgoing.length && batch.length < 50 && (!batch.length || size + (outgoing[0].data || "").length < BATCH_CHARS)) {
                const item = outgoing.shift();
                size += (item.data || "").length;
                batch.push(item);
            }
            await root.CodevCloud.request("PUT", "/sync/items", { items: batch.map(({ hash: _h, ...item }) => item) });
            for (const item of batch) state.items[item.key] = { hash: item.hash, updatedAt: item.updated_at, ...(item.deleted ? { deleted: true } : {}) };
            saveState(state);
        }
    }

    // Pulls what other devices changed, then sends what changed here.
    function syncNow() {
        if (busy) return busy;
        busy = (async () => {
            if (!page || !(await loadKey()) || !root.CodevCloud?.signedIn()) return false;
            const state = loadState();
            try {
                const changed = await pull(state);
                saveState(state);
                if (changed) page.applied();
                await push(state);
                saveState(state);
                lastError = "";
                lastSync = Date.now();
                return true;
            } catch (err) {
                lastError = err.message;
                console.warn(`[Sync] ${err.message}`);
                return false;
            } finally {
                notify();
            }
        })().finally(() => { busy = null; });
        return busy;
    }

    function changed() {
        if (!key) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(syncNow, PUSH_DELAY_MS);
    }

    function attach(adapter) {
        page = adapter;
        refreshStatus().then(s => { if (s === "ready") syncNow(); });
        // Signing out forgets this device's copy of the key, so the next person here can't sync as them.
        let lastEmail = email();
        root.CodevCloud?.onChange(() => {
            if (lastEmail && lastEmail !== email()) { write(`codev_sync_key_${lastEmail}`, ""); write(`codev_sync_state_${lastEmail}`, ""); }
            lastEmail = email();
            key = null; vaultKnown = null;
            refreshStatus().then(s => { if (s === "ready") syncNow(); });
        });
        setInterval(() => { if (key && !document.hidden) syncNow(); }, PULL_EVERY_MS);
        document.addEventListener("visibilitychange", () => { if (!document.hidden && key) syncNow(); });
    }

    // ---- The synced-chats box in the account panel ---------------------------------

    function renderInto(box) {
        if (!box) return;
        const el = (tag, attrs = {}, ...children) => {
            const node = document.createElement(tag);
            for (const [k, v] of Object.entries(attrs)) {
                if (k === "style") node.style.cssText = v;
                else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
                else node.setAttribute(k, v);
            }
            for (const c of children) if (c != null) node.append(c.nodeType ? c : String(c));
            return node;
        };
        const MUTED = "color: var(--text-muted); font-size: 0.8rem;";
        const wrap = el("div", { style: "display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-color); padding-top: 8px;" });
        box.append(wrap);
        const draw = () => {
            wrap.replaceChildren(el("div", { style: "font-weight: bold;" }, "Synced chats"));
            const error = el("div", { role: "alert", style: `display: ${lastError ? "block" : "none"}; color: var(--danger); font-size: 0.8rem;` }, lastError);
            const pass = el("input", { type: "password", autocomplete: "new-password", placeholder: "Passphrase (8 or more characters)", style: "width: 100%;" });
            const run = (button, work) => async () => {
                button.disabled = true; error.style.display = "none";
                try { await work(); } catch (err) { lastError = err.message; } finally { button.disabled = false; draw(); }
            };
            const s = status();
            if (s === "ready") {
                wrap.append(el("div", { style: MUTED }, lastSync ? `On. Last synced ${new Date(lastSync).toLocaleTimeString()}. Your chats, memory and agents follow your account, locked with your passphrase.` : "On. Syncing…"));
                const now = el("button", { type: "button", class: "btn-secondary" }, "Sync now");
                now.addEventListener("click", run(now, syncNow));
                wrap.append(el("div", { style: "display: flex; gap: 8px;" }, now));
            } else if (s === "setup") {
                wrap.append(el("div", { style: MUTED }, "Pick a passphrase to lock your chats before they leave this device. Nobody else can read them, not even CoDev. Write it down: if you forget it, the synced copies can't be opened."), pass);
                const go = el("button", { type: "button", class: "btn-primary" }, "Turn on synced chats");
                go.addEventListener("click", run(go, () => setPassphrase(pass.value)));
                wrap.append(go);
            } else if (s === "locked") {
                wrap.append(el("div", { style: MUTED }, "Enter your passphrase once on this device to bring your chats here."), pass);
                const go = el("button", { type: "button", class: "btn-primary" }, "Unlock synced chats");
                go.addEventListener("click", run(go, () => unlock(pass.value)));
                const reset = el("button", { type: "button", class: "btn-secondary" }, "Forgot it? Start over");
                reset.addEventListener("click", run(reset, async () => {
                    if (!confirm("Start over with a new passphrase?\n\nEvery synced copy is deleted from CoDev's server. The chats on this device stay and sync again under the new passphrase.")) return;
                    await setPassphrase(pass.value, { reset: true });
                }));
                wrap.append(el("div", { style: "display: flex; gap: 8px; flex-wrap: wrap;" }, go, reset));
            } else {
                wrap.append(el("div", { style: MUTED }, "Checking…"));
            }
            wrap.append(error);
        };
        draw();
        const redraw = () => { if (wrap.isConnected) draw(); else listeners.splice(listeners.indexOf(redraw), 1); };
        listeners.push(redraw);
        if (status() === "unknown") refreshStatus();
    }

    root.CodevSync = { attach, changed, syncNow, setPassphrase, unlock, forget, status, refreshStatus, renderInto };
})(typeof self !== "undefined" ? self : this);
