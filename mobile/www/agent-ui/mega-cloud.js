// CoDev's MEGA tools: search, read and (if the user turns it on) save files in the
// user's MEGA cloud drive, for agents, plus the Settings panel that connects it.
// MEGA replaced Google Drive here. It uses megajs (npm, MIT, free), MEGA's
// open-source JavaScript SDK, which signs in with the account's email and password
// and decrypts files on this device: MEGA itself never sees the files' contents.
//
// Where the MEGA session lives:
//  - Windows app: the main process (desktop/mega-connect.js) over window.codevDesktop.mega(req).
//  - A browser on the computer running server.js: the same module at POST /mega.
//  - Android (and a page with no server): here in the page, with megajs's browser
//    build (vendor/megajs), loaded the first time it's needed.
// The password is only used to sign in and is never saved. What's kept is MEGA's
// session (its id and the account key), like the "remember me" of MEGA's own apps.
//
// Every transport takes the same requests:
//   { op: "status" }                                  -> { signedIn, email, allowWrite }
//   { op: "signin", email, password, code?, allowWrite? } -> { ok, email } (code: the 2FA code)
//   { op: "settings", allowWrite }                    -> { ok }
//   { op: "signout" }                                 -> { ok }
//   { op: "list", query?, type?, folder?, max? }      -> { folder, files: [...] }
//   { op: "read", file }                              -> { file, text? | children? | kind }
//   { op: "save", name, content, folder? }            -> { file }
// and, for a notes vault kept in MEGA (notes-tables.js), with paths from its folder:
//   { op: "tree", folder } -> { files: [{ path, size, modified }] }
//   { op: "fetch", folder, path } -> { text }     { op: "put", folder, path, content } -> { ok, replaced }
// Saving needs "allowWrite", and the page asks the user before every save. The MEGA
// tools never change, move or delete files already in MEGA; a note or table edited
// in the vault is saved as a new file and its old version goes to the Rubbish Bin.
//
// The same file runs in the page and in Node (desktop/mega-connect.js and tests).
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevMegaCloud = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const GUIDE_URL = "https://github.com/phillbennett021423/codev_cloud/blob/main/docs/mega-cloud.md";
    const STORE = { email: "codev_mega_email", allowWrite: "codev_mega_allow_write", phoneSession: "codev_mega_phone_session" };
    const MEGA_TOOL_NAMES = ["mega_status", "mega_search", "mega_read_file", "mega_save_file"];
    const READ_CHUNK = 12000;
    const MAX_READ_BYTES = 5 * 1024 * 1024;
    const MAX_SAVE_BYTES = 5 * 1024 * 1024;
    // The file list is fetched again after this long, so files MEGAsync just
    // uploaded from the computer show up.
    const RELOAD_MS = 60 * 1000;
    const VENDOR_SCRIPT = "vendor/megajs/megajs.browser.js";

    const EXT = {
        image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "svg"],
        video: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "3gp"],
        audio: ["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"],
        pdf: ["pdf"],
        doc: ["doc", "docx", "odt", "rtf", "pages", "txt", "md"],
        sheet: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"],
        slides: ["ppt", "pptx", "odp", "key"],
        text: ["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx",
            "py", "gd", "cs", "java", "kt", "c", "h", "cpp", "hpp", "rs", "go", "rb", "php", "lua", "sh", "bat", "ps1", "yaml", "yml",
            "toml", "ini", "cfg", "conf", "log", "srt", "vtt", "sql", "tscn", "tres", "godot", "gitignore", "env.example"]
    };
    const ext = name => { const m = /\.([^.\/\\]+)$/.exec(String(name || "").toLowerCase()); return m ? m[1] : ""; };
    const isText = name => EXT.text.includes(ext(name));

    function clampInt(value, min, max, fallback) {
        const n = Math.floor(Number(value));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    function formatSize(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
        if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    // MEGA's errors, in words the user can act on.
    function explain(err) {
        const text = String((err && err.message) || err || "");
        if (/EMFAREQUIRED|-26\b/.test(text)) return "This MEGA account has two-factor sign-in. Type the 6-digit code from your authenticator app and sign in again.";
        if (/ENOENT|-9\b/.test(text)) return "MEGA didn't accept that email and password.";
        if (/ESID|-15\b/.test(text)) return "The MEGA sign-in expired or was ended. Sign in again in Settings > MEGA cloud.";
        if (/EBLOCKED|-16\b/.test(text)) return "MEGA has blocked this account. Open mega.nz in a browser to see why.";
        if (/EOVERQUOTA|-17\b|EGOINGOVERQUOTA|-24\b/.test(text)) return "The MEGA account is out of storage or transfer quota. Free some space or wait for the transfer quota to reset.";
        if (/ERATELIMIT|-4\b|EAGAIN|-3\b|ETEMPUNAVAIL|-18\b/.test(text)) return "MEGA is busy right now. Try again in a minute.";
        if (/EACCESS|-11\b/.test(text)) return "MEGA refused: that folder is read-only for this account.";
        return text || "MEGA didn't answer.";
    }

    // ---- The account: works on a megajs Storage class ------------------------

    // Storage: megajs's Storage class (require("megajs").Storage, or the page's
    // window.mega.Storage), or a function that loads it. load() -> the saved
    // session or null; save(session | null) keeps it.
    function createMegaAccount({ Storage, load, save, log = () => {}, now = () => Date.now() }) {
        let storage = null;     // the open megajs Storage
        let loadedAt = 0;
        let opening = null;

        const getStorageClass = async () => (typeof Storage === "function" && Storage.fromJSON ? Storage : await Storage());
        const session = () => { try { return load() || null; } catch (err) { return null; } };

        function forget() {
            storage = null;
            loadedAt = 0;
            save(null);
        }

        // The signed-in Storage with a fresh enough file list.
        async function open() {
            const saved = session();
            if (!saved || !saved.sid || !saved.key) throw new Error("CoDev isn't signed in to MEGA. Open Settings > MEGA cloud and sign in.");
            if (storage && now() - loadedAt < RELOAD_MS) return storage;
            if (opening) return opening;
            opening = (async () => {
                try {
                    const Cls = await getStorageClass();
                    // A fresh Storage each time: megajs's reload only adds files, so a
                    // reused one would keep files that were deleted or renamed since.
                    const next = Cls.fromJSON({ key: saved.key, sid: saved.sid, name: saved.name || "", user: saved.user || "", options: { keepalive: false } });
                    await next.reload(true);
                    storage = next;
                    loadedAt = now();
                    return storage;
                } catch (err) {
                    if (/ESID|-15\b/.test(String(err && err.message))) forget();
                    throw new Error(explain(err));
                } finally { opening = null; }
            })();
            return opening;
        }

        // The cloud drive's top folder, the Rubbish bin, and shared folders.
        function topOf(node) {
            let n = node;
            while (n && n.parent) n = n.parent;
            return n;
        }
        function inTrash(st, node) {
            const top = topOf(node);
            return Boolean(top && (top === st.trash || top === st.inbox));
        }
        function pathOf(st, node) {
            const names = [];
            for (let n = node; n && n !== st.root; n = n.parent) {
                if (!n.parent && n !== st.root) { names.unshift(`[shared] ${n.name || "?"}`); break; }
                names.unshift(n.name || "?");
            }
            return `/${names.join("/")}`;
        }
        function describeNode(st, node) {
            return {
                id: node.nodeId, name: node === st.root ? "Cloud Drive" : node.name, path: pathOf(st, node), folder: Boolean(node.directory),
                size: node.directory ? null : Number(node.size) || 0, modified: node.timestamp ? new Date(node.timestamp * 1000).toISOString() : null,
                link: `https://mega.nz/fm/${(node.directory ? node : node.parent || st.root).nodeId}`
            };
        }

        // A folder or file by its id, or by its path from the top of the cloud drive
        // ("/Screenshots/Nov", "Screenshots", "Cloud Drive/Screenshots"); names match
        // without minding case.
        function resolve(st, ref, wantFolder) {
            const text = String(ref == null ? "" : ref).trim();
            if (!text || text === "/" || /^cloud drive\/?$/i.test(text)) return st.root;
            if (st.files[text] && !inTrash(st, st.files[text])) return st.files[text];
            const parts = text.replace(/\\/g, "/").split("/").filter(Boolean);
            if (parts.length && /^cloud drive$/i.test(parts[0])) parts.shift();
            let node = st.root;
            for (let i = 0; i < parts.length; i++) {
                const want = parts[i].toLowerCase();
                const kids = (node.children || []);
                const next = kids.find(c => String(c.name || "").toLowerCase() === want && (i < parts.length - 1 || !wantFolder || c.directory));
                if (!next) return null;
                node = next;
            }
            return node;
        }

        function allNodes(st) {
            return Object.values(st.files || {}).filter(n => n && n !== st.root && n.nodeId && n.name && !inTrash(st, n) && n !== st.trash && n !== st.inbox);
        }

        function matchesType(node, type) {
            if (!type) return true;
            if (type === "folder") return Boolean(node.directory);
            if (node.directory) return false;
            return (EXT[type] || []).includes(ext(node.name));
        }

        function under(node, folder) {
            for (let n = node.parent; n; n = n.parent) if (n === folder) return true;
            return false;
        }

        async function list({ query, type, folder, max }) {
            const st = await open();
            let base = null;
            if (folder) {
                base = resolve(st, folder, true);
                if (!base) return { error: `No MEGA folder "${folder}". List the cloud drive with mega_search and no folder to see the folder names.` };
                if (!base.directory) return { error: `"${folder}" is a file, not a folder.` };
            }
            const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
            let found;
            if (!words.length && !type) found = (base || st.root).children ? [...(base || st.root).children] : [];
            else found = allNodes(st).filter(n => (!base || under(n, base)) && words.every(w => String(n.name).toLowerCase().includes(w)) && matchesType(n, type));
            const newest = (a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
            // A folder listing shows its folders first; a search is newest first.
            found.sort(words.length || type ? newest : (a, b) => Number(b.directory) - Number(a.directory) || newest(a, b));
            const total = found.length;
            return { folder: base ? describeNode(st, base) : null, total, files: found.slice(0, clampInt(max, 1, 50, 15)).map(n => describeNode(st, n)) };
        }

        async function read({ file }) {
            const st = await open();
            const node = resolve(st, file, false);
            if (!node) return { error: `No MEGA file "${file}". Find it with mega_search first and pass its id.` };
            const info = describeNode(st, node);
            if (node.directory) {
                const kids = [...(node.children || [])].sort((a, b) => Number(b.directory) - Number(a.directory) || (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
                return { file: info, total: kids.length, children: kids.slice(0, 50).map(n => describeNode(st, n)) };
            }
            const kind = EXT.image.includes(ext(node.name)) ? "image" : isText(node.name) ? "text" : "other";
            if (kind !== "text") return { file: info, kind };
            if (info.size > MAX_READ_BYTES) return { file: info, kind: "too-big" };
            let data;
            try { data = await node.downloadBuffer({}); } catch (err) { throw new Error(explain(err)); }
            return { file: info, kind, text: new TextDecoder("utf-8").decode(data) };
        }

        async function saveFile({ name, content, folder }) {
            const saved = session();
            if (!saved || !saved.allowWrite) return { error: "Saving to MEGA is off. The user can turn it on in Settings > MEGA cloud." };
            name = String(name || "").trim();
            if (!name || /[\/\\]/.test(name)) return { error: "Give a file name without slashes; put the folder in folder." };
            if (typeof content !== "string") return { error: "content must be text." };
            const bytes = new TextEncoder().encode(content);
            if (bytes.length > MAX_SAVE_BYTES) return { error: "That's more than 5 MB of text; save it in parts." };
            const st = await open();
            const target = folder ? resolve(st, folder, true) : st.root;
            if (!target || !target.directory) return { error: `No MEGA folder "${folder}".` };
            let made;
            try {
                made = await new Promise((resolve, reject) => {
                    const upload = target.upload({ name, size: bytes.length }, bytes, (err, file) => (err ? reject(err) : resolve(file)));
                    if (upload && upload.on) upload.on("error", reject);
                });
            } catch (err) { throw new Error(explain(err)); }
            loadedAt = 0; // the next list fetches the new file too
            return { file: made && made.nodeId ? describeNode(st, made) : { name, path: `${pathOf(st, target)}/${name}`.replace(/^\/\//, "/"), link: `https://mega.nz/fm/${target.nodeId}` } };
        }

        // ---- A folder used as a notes vault (notes-tables.js): every file under it by
        // its path from that folder, one file's text, and writing one file (new, or a
        // new version whose old copy goes to the Rubbish Bin, where MEGA keeps it).
        function vaultRoot(st, folder) {
            const base = resolve(st, folder, true);
            if (!base) return { error: `No MEGA folder "${folder}". Make it in MEGA (or let CoDev save the first note there), or pick another folder in Settings > Notes & tables.` };
            if (!base.directory) return { error: `"${folder}" is a file, not a folder.` };
            return { base };
        }

        function fileUnder(base, rel) {
            const parts = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
            let node = base;
            for (const part of parts) {
                node = (node.children || []).find(c => String(c.name || "").toLowerCase() === part.toLowerCase());
                if (!node) return null;
            }
            return node === base ? null : node;
        }

        async function tree({ folder }) {
            const st = await open();
            const { base, error } = vaultRoot(st, folder);
            if (error) return { error, missing: true };
            const files = [];
            (function walk(node, prefix) {
                for (const child of node.children || []) {
                    if (!child.name || child.name.startsWith(".")) continue; // .obsidian, .trash
                    const rel = prefix ? `${prefix}/${child.name}` : child.name;
                    if (child.directory) walk(child, rel);
                    else if (files.length < 5000) files.push({ path: rel, size: Number(child.size) || 0, modified: child.timestamp ? new Date(child.timestamp * 1000).toISOString() : null });
                }
            })(base, "");
            return { files };
        }

        async function fetchText({ folder, path: rel }) {
            const st = await open();
            const { base, error } = vaultRoot(st, folder);
            if (error) return { error };
            const node = fileUnder(base, rel);
            if (!node || node.directory) return { error: `No file ${rel} in ${folder}.`, missing: true };
            if (Number(node.size) > MAX_READ_BYTES) return { error: `${rel} is over 5 MB, too big to read here.` };
            let data;
            try { data = await node.downloadBuffer({}); } catch (err) { throw new Error(explain(err)); }
            return { text: new TextDecoder("utf-8").decode(data), modified: node.timestamp ? new Date(node.timestamp * 1000).toISOString() : null };
        }

        async function putText({ folder, path: rel, content }) {
            const saved = session();
            if (!saved || !saved.allowWrite) return { error: "Saving to MEGA is off. Turn it on in Settings > MEGA cloud so notes and tables in MEGA can be saved." };
            if (typeof content !== "string") return { error: "content must be text." };
            const bytes = new TextEncoder().encode(content);
            if (bytes.length > MAX_SAVE_BYTES) return { error: "That's more than 5 MB of text." };
            const parts = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
            if (!parts.length || parts.some(p => p === ".." || p.startsWith("."))) return { error: "Give a path inside the folder, like Projects/Ideas.md." };
            const st = await open();
            let { base, error } = vaultRoot(st, folder);
            if (error) {
                // The vault folder itself is made on the first save.
                try { base = await makeFolders(st.root, String(folder || "").replace(/\\/g, "/").split("/").filter(Boolean).filter((p, i) => i || !/^cloud drive$/i.test(p))); } catch (err) { throw new Error(explain(err)); }
            }
            const name = parts.pop();
            let parent;
            try { parent = await makeFolders(base, parts); } catch (err) { throw new Error(explain(err)); }
            const old = (parent.children || []).find(c => !c.directory && String(c.name || "").toLowerCase() === name.toLowerCase());
            try {
                await new Promise((resolve, reject) => {
                    const upload = parent.upload({ name: old ? old.name : name, size: bytes.length }, bytes, (err, file) => (err ? reject(err) : resolve(file)));
                    if (upload && upload.on) upload.on("error", reject);
                });
                // The old version goes to the Rubbish Bin (not deleted for good), so it can be restored.
                if (old) await old.delete(false);
            } catch (err) { throw new Error(explain(err)); }
            loadedAt = 0;
            return { ok: true, replaced: Boolean(old) };
        }

        async function makeFolders(from, names) {
            let node = from;
            for (const part of names) {
                let next = (node.children || []).find(c => c.directory && String(c.name || "").toLowerCase() === part.toLowerCase());
                if (!next) next = await node.mkdir(part);
                node = next;
            }
            return node;
        }

        async function signIn({ email, password, code, allowWrite }) {
            email = String(email || "").trim();
            if (!email || !password) return { error: "Type your MEGA email and password." };
            const Cls = await getStorageClass();
            const options = { email, password: String(password), keepalive: false, autoload: true };
            if (String(code || "").trim()) options.secondFactorCode = String(code).replace(/\s+/g, "");
            let next;
            try {
                next = new Cls(options);
                await next.ready;
            } catch (err) {
                return { error: explain(err) };
            }
            const json = next.toJSON();
            // Only the session is kept, never the password.
            save({ key: json.key, sid: json.sid, name: json.name || "", user: json.user || "", email, allowWrite: Boolean(allowWrite) });
            storage = next; // it already has the file list
            loadedAt = now();
            log(`Signed in to MEGA as ${email}.`);
            return { ok: true, email };
        }

        async function signOut() {
            const saved = session();
            const st = storage;
            forget();
            // Ends the session at MEGA too (megajs's close sends MEGA's log-out).
            try {
                if (st) await st.close();
                else if (saved && saved.sid) {
                    const Cls = await getStorageClass();
                    await Cls.fromJSON({ key: saved.key, sid: saved.sid, name: "", user: "", options: { keepalive: false } }).close();
                }
            } catch (err) { log(`Ending the MEGA session: ${err.message || err}`); }
            return { ok: true };
        }

        async function handle(req = {}) {
            try {
                switch (req.op) {
                    case "status": {
                        const saved = session();
                        return { signedIn: Boolean(saved && saved.sid), email: (saved && saved.email) || null, allowWrite: Boolean(saved && saved.allowWrite) };
                    }
                    case "signin": return await signIn(req);
                    case "signout": return await signOut();
                    case "settings": {
                        const saved = session();
                        if (saved) save({ ...saved, allowWrite: Boolean(req.allowWrite) });
                        return { ok: true };
                    }
                    case "list": return await list(req);
                    case "read": return await read(req);
                    case "save": return await saveFile(req);
                    case "tree": return await tree(req);
                    case "fetch": return await fetchText(req);
                    case "put": return await putText(req);
                    default: return { error: "Unknown MEGA request." };
                }
            } catch (err) {
                return { error: explain(err) };
            }
        }

        return { handle, close: () => { storage = null; } };
    }

    // ---- Transports ----------------------------------------------------------

    function backendTransport(send, kind) {
        return {
            kind,
            async handle(req) {
                try { return (await send(req)) || { error: "No answer from CoDev." }; } catch (err) { return { error: err.message || String(err) }; }
            }
        };
    }

    function serverTransport(fetchImpl) {
        return backendTransport(async req => {
            const response = await fetchImpl("/mega", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
            if (response.status === 404) return { error: "This copy of CoDev's server is too old for MEGA. Update CoDev and restart it." };
            return response.json();
        }, "computer");
    }

    // The phone (or a page with no server) keeps the session in its own storage and
    // talks to MEGA with megajs's browser build. loadStorage() -> megajs's Storage class.
    function phoneTransport({ storage, loadStorage }) {
        const account = createMegaAccount({
            Storage: loadStorage,
            load: () => JSON.parse(storage.getItem(STORE.phoneSession) || "null"),
            save: value => { if (value) storage.setItem(STORE.phoneSession, JSON.stringify(value)); else storage.removeItem(STORE.phoneSession); }
        });
        return { kind: "phone", handle: req => account.handle(req) };
    }

    // Loads vendor/megajs once, on first use, so the page doesn't parse it until MEGA is used.
    function scriptLoader(win, src = VENDOR_SCRIPT) {
        let loading = null;
        return () => {
            if (win.mega && win.mega.Storage) return Promise.resolve(win.mega.Storage);
            if (!loading) loading = new Promise((resolve, reject) => {
                const tag = win.document.createElement("script");
                tag.src = src;
                tag.onload = () => (win.mega && win.mega.Storage ? resolve(win.mega.Storage) : reject(new Error("MEGA's library didn't load.")));
                tag.onerror = () => { loading = null; reject(new Error("MEGA's library couldn't be loaded.")); };
                win.document.head.appendChild(tag);
            });
            return loading;
        };
    }

    function detectTransport(win) {
        if (win.codevDesktop && win.codevDesktop.mega) return backendTransport(req => win.codevDesktop.mega(req), "computer");
        const cap = win.Capacitor;
        const native = cap && cap.isNativePlatform && cap.isNativePlatform();
        if (!native && win.location && win.location.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(win.location.hostname)) return serverTransport(win.fetch.bind(win));
        return phoneTransport({ storage: win.localStorage, loadStorage: scriptLoader(win) });
    }

    // ---- The tools -----------------------------------------------------------

    function slice(text, start, label) {
        start = clampInt(start, 0, Number.MAX_SAFE_INTEGER, 0);
        const part = text.slice(start, start + READ_CHUNK);
        const end = start + part.length;
        return part + (end < text.length ? `\n\n[Characters ${start}-${end} of ${text.length}. Call ${label} again with start ${end} for more, only if you need it.]` : "");
    }

    const line = f => `[${f.id}] ${f.path}${f.folder ? "/" : ""}\n${f.folder ? "Folder" : formatSize(f.size)}${f.modified ? ` · modified ${f.modified.slice(0, 10)}` : ""}`;

    // transport: from detectTransport. confirmWrite(message) -> boolean: asked before every save.
    function createMegaCloud({ transport, confirmWrite = () => false }) {
        let statusCache = { at: 0, value: null };

        async function status(fresh) {
            if (!fresh && statusCache.value && Date.now() - statusCache.at < 20000) return statusCache.value;
            const reply = await transport.handle({ op: "status" });
            const value = reply.error ? { signedIn: false, allowWrite: false, error: reply.error } : reply;
            statusCache = { at: Date.now(), value };
            return value;
        }

        async function call(req) {
            const reply = await transport.handle(req);
            if (reply.error) throw new Error(reply.error);
            return reply;
        }

        async function megaSearch({ query, type, folder, max }) {
            const found = await call({ op: "list", query, type, folder, max });
            const where = found.folder ? ` in ${found.folder.path}` : "";
            if (!found.files.length) return query || type ? `No MEGA files match${query ? ` "${query}"` : ""}${type ? ` (type ${type})` : ""}${where}.` : `The MEGA folder${where || " /"} is empty.`;
            const more = found.total > found.files.length ? `\n\n(${found.total - found.files.length} more; narrow the search or raise max.)` : "";
            return found.files.map(line).join("\n\n") + more + "\n\n(Read one with mega_read_file and its id or path; list a folder with mega_search folder.)";
        }

        async function megaReadFile({ file, id, start }) {
            const ref = String(file || id || "").trim();
            if (!ref) return "mega_read_file needs the file's id or path from mega_search.";
            const got = await call({ op: "read", file: ref });
            const f = got.file;
            const intro = `${f.path}${f.folder ? "/" : ` (${formatSize(f.size)})`}${f.modified ? ` · modified ${f.modified.slice(0, 10)}` : ""}\n${f.link}\n\n`;
            if (f.folder) return intro + (got.children.length ? got.children.map(line).join("\n\n") + (got.total > got.children.length ? `\n\n(${got.total - got.children.length} more; use mega_search with this folder and a query.)` : "") : "(empty folder)");
            if (got.kind === "image") return intro + "This is an image. To look at images from MEGA, use read_screenshots with the MEGAsync folder's path on the user's computer (MEGAsync keeps a synced copy, usually in C:\\Users\\<name>\\MEGA), or ask the user to attach it with 📎.";
            if (got.kind === "too-big") return intro + "This file is over 5 MB, too big to read here. Ask the user to attach it with 📎 or read it from the MEGAsync folder on their computer.";
            if (got.kind !== "text") return intro + "CoDev can only read text files (like .txt, .md, .csv, .json or code) from MEGA. For PDFs, Office files and other types, ask the user to attach the file with 📎.";
            return intro + slice(got.text, start, "mega_read_file");
        }

        async function megaSaveFile({ name, content, folder }) {
            name = String(name || "").trim();
            if (!name) return "mega_save_file needs a file name.";
            if (typeof content !== "string") return "mega_save_file needs content as text.";
            const st = await status(true);
            if (!st.allowWrite) return "Saving to MEGA is off. The user can turn it on in Settings > MEGA cloud.";
            const preview = `Save a new file to your MEGA cloud drive?\n\nName: ${name}\nFolder: ${folder || "/ (Cloud Drive)"}\n\n${content.slice(0, 1200)}${content.length > 1200 ? "\n…" : ""}`;
            if (!(await confirmWrite(preview))) return "The user declined saving this file to MEGA.";
            const saved = await call({ op: "save", name, content, folder });
            return `Saved "${name}" to MEGA at ${saved.file.path}: ${saved.file.link}`;
        }

        async function statusReport() {
            const st = await status(true);
            const lines = [];
            if (st.error) lines.push(`MEGA connection: ${st.error}`);
            if (st.signedIn) lines.push(`Signed in to MEGA as ${st.email || "the user's account"}. Agents can read files${st.allowWrite ? " and save new files (asking first)" : " (saving is off)"}.`);
            else lines.push(`Not signed in to MEGA. The user signs in under Settings > MEGA cloud with a free MEGA account. Guide: ${GUIDE_URL}`);
            lines.push("Files MEGAsync keeps on the user's computer (usually C:\\Users\\<name>\\MEGA) can also be read by path, like any folder, with read_screenshots for images.");
            return lines.join("\n");
        }

        const TOOLS = {
            mega_status: {
                description: "Check whether CoDev is signed in to the user's MEGA cloud drive (MEGA / MEGAsync), and whether saving is on. Call it when the user asks about MEGA and the MEGA tool they need isn't listed.",
                inputSchema: { type: "object", properties: {} }, run: statusReport
            },
            mega_search: {
                description: "Search the user's MEGA cloud drive by file name, or list a folder (newest first). Returns ids, paths, sizes and dates. Read-only. MEGA encrypts files, so this matches names, not the text inside.",
                inputSchema: { type: "object", properties: {
                    query: { type: "string", description: "Words in the file or folder name. Leave empty to list a folder." },
                    type: { type: "string", enum: ["folder", "image", "video", "audio", "pdf", "doc", "sheet", "slides", "text"], description: "Optional: only this kind of file." },
                    folder: { type: "string", description: "Optional: a folder's path (like \"/Screenshots\") or id, to list or search inside it. Leave empty for the whole drive." },
                    max: { type: "integer", description: "How many results (1-50, default 15)." }
                } }, run: megaSearch
            },
            mega_read_file: {
                description: "Read a text file from the user's MEGA cloud drive (txt, md, csv, json, code and similar) by its id or path from mega_search. A folder lists what's in it. Read-only.",
                inputSchema: { type: "object", properties: {
                    file: { type: "string", description: "The file's id or path from mega_search, like \"/Notes/picks.md\"." },
                    start: { type: "integer", description: "Optional: the character to start from, for the next part of a long file." }
                }, required: ["file"] }, run: megaReadFile
            },
            mega_save_file: {
                description: "Save a new text file to the user's MEGA cloud drive. CoDev shows the user the file and saves only if they approve. It never changes or deletes existing files.",
                inputSchema: { type: "object", properties: {
                    name: { type: "string", description: "File name, like \"NBA props 10-28.md\"." },
                    content: { type: "string", description: "The full text." },
                    folder: { type: "string", description: "Optional: the folder's path (like \"/CoDev\") or id from mega_search. Default: the top of the cloud drive." }
                }, required: ["name", "content"] }, run: megaSaveFile
            }
        };

        // Only the tools that can work right now.
        async function buildTools() {
            const st = await status();
            const names = ["mega_status"];
            if (st.signedIn) names.push("mega_search", "mega_read_file");
            if (st.signedIn && st.allowWrite) names.push("mega_save_file");
            return names.map(name => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema, run: (args, ctx) => TOOLS[name].run(args || {}, ctx) }));
        }

        function describe(name, args) {
            args = args || {};
            switch (name) {
                case "mega_status": return "☁️ Checking MEGA";
                case "mega_search": return `☁️ Searching MEGA${args.query ? `: ${args.query}` : args.folder ? `: ${args.folder}` : ""}`;
                case "mega_read_file": return `📄 Reading ${args.file || "a file"} from MEGA`;
                case "mega_save_file": return `💾 Saving ${args.name} to MEGA (asks you first)`;
                default: return null;
            }
        }

        return { buildTools, describe, status, TOOLS, forgetStatus: () => { statusCache = { at: 0, value: null }; } };
    }

    // ---- Settings panel ------------------------------------------------------

    // Fills Settings > MEGA cloud and wires its buttons. cloud: from createMegaCloud;
    // el: the <details> element.
    function mountSettings(el, { transport, cloud, storage }) {
        el.innerHTML = `
            <summary>☁️ MEGA cloud (replaces Google Drive)</summary>
            <div data-m="status" style="font-size: 0.85rem; white-space: pre-line;"></div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">Sign in with your MEGA account (free at mega.io). CoDev keeps MEGA's sign-in, never your password. <a href="${GUIDE_URL}" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">How it works</a></div>
            <div class="form-group">
                <label>MEGA email</label>
                <input type="email" data-m="email" placeholder="you@example.com" autocomplete="username">
                <label>MEGA password</label>
                <input type="password" data-m="password" autocomplete="current-password">
                <label>Two-factor code (only if your account uses it)</label>
                <input type="text" data-m="code" inputmode="numeric" placeholder="123456" autocomplete="one-time-code" style="font-family: monospace;">
            </div>
            <label class="checkbox-group"><input type="checkbox" data-m="allowWrite"> Let agents save new files to MEGA (CoDev asks me every time)</label>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="btn-secondary" type="button" data-m="signin">🔐 Sign in to MEGA</button>
                <button class="btn-secondary" type="button" data-m="signout">Sign out</button>
            </div>
            <div data-m="note" style="font-size: 0.8rem; color: var(--text-muted); overflow-wrap: anywhere;"></div>`;
        const $ = name => el.querySelector(`[data-m="${name}"]`);
        const note = text => { $("note").textContent = text || ""; };

        $("email").value = storage.getItem(STORE.email) || "";
        $("email").addEventListener("input", () => storage.setItem(STORE.email, $("email").value.trim()));
        $("allowWrite").checked = storage.getItem(STORE.allowWrite) === "1";
        $("allowWrite").addEventListener("change", async () => {
            storage.setItem(STORE.allowWrite, $("allowWrite").checked ? "1" : "0");
            await transport.handle({ op: "settings", allowWrite: $("allowWrite").checked });
            refresh();
        });

        async function refresh() {
            cloud.forgetStatus();
            const report = await cloud.status(true);
            const lines = [];
            if (report.error) lines.push(`⚠️ ${report.error}`);
            else if (report.signedIn) {
                lines.push(`✅ Signed in${report.email ? ` as ${report.email}` : ""}`);
                lines.push(`Agents can: read MEGA files${report.allowWrite ? ", save new files (asks first)" : ""}`);
            } else lines.push("MEGA: not signed in");
            $("status").textContent = lines.join("\n");
            if (report.signedIn) $("allowWrite").checked = Boolean(report.allowWrite);
            return report;
        }

        $("signin").addEventListener("click", async () => {
            note("Signing in to MEGA…");
            $("signin").disabled = true;
            const reply = await transport.handle({ op: "signin", email: $("email").value, password: $("password").value, code: $("code").value, allowWrite: $("allowWrite").checked });
            $("signin").disabled = false;
            $("password").value = "";
            $("code").value = "";
            note(reply.error || `Connected${reply.email ? ` as ${reply.email}` : ""}. Agents can use your MEGA files now.`);
            refresh();
        });
        $("signout").addEventListener("click", async () => {
            const reply = await transport.handle({ op: "signout" });
            note(reply.error || "Signed out of MEGA.");
            refresh();
        });
        el.addEventListener("toggle", () => { if (el.open) refresh(); });
        return { refresh };
    }

    return {
        STORE, GUIDE_URL, MEGA_TOOL_NAMES, EXT,
        createMegaAccount, backendTransport, serverTransport, phoneTransport, scriptLoader, detectTransport,
        createMegaCloud, mountSettings, explain
    };
});
