// CoDev's Google tools: YouTube, Google Maps, Gmail and Google Drive, for agents,
// plus the Settings panel that connects them. Read-only by default: sending email
// and saving to Drive need the user to turn them on, and CoDev asks every time.
//
// Where the Google account lives:
//  - Windows app: the main process (desktop/google-connect.js) over
//    window.codevDesktop.google(req).
//  - A browser on the computer running server.js: the same module at POST /google.
//  - Android (and a page with no server): here in the page. In the Android app the
//    user signs in on the phone itself: Google's sign-in opens in the phone's browser
//    and comes back to a one-time listener the app runs on 127.0.0.1 (the same flow
//    for installed apps as the computer's). Anywhere, the user can instead sign in on
//    the computer and copy a "phone link code" across. The page then refreshes tokens
//    on its own.
// Every transport takes the same requests: status, signin, signout, link, import
// (phone only) and request ({ method, url, headers, body, auth: "user" | "key", apiKey }).
// YouTube and Maps can use an API key alone; Gmail and Drive need the sign-in.
//
// The same file runs in the page and in Node (tests), like agent-client.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevGoogleApps = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const YT = "https://www.googleapis.com/youtube/v3";
    const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
    const DRIVE = "https://www.googleapis.com/drive/v3";
    const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
    const PLACES = "https://places.googleapis.com/v1/places:searchText";
    const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
    const TOKEN_URL = "https://oauth2.googleapis.com/token";
    const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
    const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
    const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
    const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
    const GUIDE_URL = "https://github.com/phillbennett021423/codev_cloud/blob/main/docs/google-apps.md";
    const API_HOSTS = ["www.googleapis.com", "gmail.googleapis.com", "youtube.googleapis.com", "places.googleapis.com", "routes.googleapis.com", "maps.googleapis.com"];
    const SCOPE = {
        youtube: "https://www.googleapis.com/auth/youtube.readonly",
        gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
        gmailSend: "https://www.googleapis.com/auth/gmail.send",
        driveRead: "https://www.googleapis.com/auth/drive.readonly",
        driveFile: "https://www.googleapis.com/auth/drive.file"
    };
    const STORE = { apiKey: "codev_google_api_key", clientId: "codev_google_client_id", clientSecret: "codev_google_client_secret", allowWrite: "codev_google_allow_write", phoneAccount: "codev_google_phone_account" };
    const READ_CHUNK = 12000;
    const GOOGLE_TOOL_NAMES = ["google_apps_status", "youtube_search", "youtube_video", "maps_search_places", "maps_directions",
        "gmail_search", "gmail_read", "gmail_send", "drive_search", "drive_read_file", "drive_save_file"];

    function isGoogleApiUrl(address) {
        let url;
        try { url = new URL(address); } catch (err) { return false; }
        return url.protocol === "https:" && API_HOSTS.includes(url.hostname) && !url.username && !url.password && !url.port;
    }

    // ---- Transports ----------------------------------------------------------

    // The Windows app or server.js: they hold the account and add the credentials.
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
            const response = await fetchImpl("/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
            if (response.status === 404) return { error: "This copy of CoDev's server is too old for Google apps. Update CoDev and restart it." };
            return response.json();
        }, "computer");
    }

    // On the phone the page keeps the account itself (signed in on the phone, or copied
    // from the computer) and calls Google directly: natively through CapacitorHttp when
    // there is one, since not every Google API allows a web page to call it.
    // loopback: the app's CodevBrowser plugin (loopbackStart, loopbackStop, openExternal,
    // and its "loopback" event), for signing in on the phone; without it, only the link code.
    function phoneTransport({ http, storage, fetchImpl, loopback = null, now = () => Date.now() }) {
        let accessToken = null;
        let pending = null;   // the sign-in in progress: { port, state, verifier, clientId, clientSecret, scopes, timer }
        const load = () => { try { return JSON.parse(storage.getItem(STORE.phoneAccount) || "null"); } catch (err) { return null; } };
        const save = account => {
            accessToken = null;
            if (account) storage.setItem(STORE.phoneAccount, JSON.stringify(account));
            else storage.removeItem(STORE.phoneAccount);
        };

        async function send({ method, url, headers = {}, body, form }) {
            if (http && (form || body === undefined || typeof body === "object")) {
                const reply = await http.request({
                    method, url, headers: form ? { ...headers, "Content-Type": "application/x-www-form-urlencoded" } : headers,
                    data: form || body, responseType: "text", connectTimeout: 20000, readTimeout: 30000
                });
                let data = reply.data;
                if (typeof data === "string") { try { data = JSON.parse(data); } catch (err) { /* plain text */ } }
                return { status: reply.status, body: data };
            }
            const response = await fetchImpl(url, {
                method, headers: form ? { ...headers, "Content-Type": "application/x-www-form-urlencoded" } : headers,
                body: form ? new URLSearchParams(form).toString() : (body === undefined || typeof body === "string" ? body : JSON.stringify(body))
            });
            const text = await response.text();
            let data = text;
            try { data = JSON.parse(text); } catch (err) { /* plain text */ }
            return { status: response.status, body: data };
        }

        async function token() {
            const account = load();
            if (!account || !account.refreshToken) throw new Error("Google isn't linked on this phone. Sign in on your computer, then use Settings > Google apps > Link this phone.");
            if (accessToken && accessToken.expiresAt > Date.now() + 60000) return accessToken.token;
            const reply = await send({ method: "POST", url: TOKEN_URL, form: { client_id: account.clientId, client_secret: account.clientSecret || "", refresh_token: account.refreshToken, grant_type: "refresh_token" } });
            if (reply.status !== 200 || !reply.body || !reply.body.access_token) {
                const why = (reply.body && (reply.body.error_description || reply.body.error)) || `HTTP ${reply.status}`;
                if (/invalid_grant|expired|revoked/i.test(why)) { save(null); throw new Error("The Google sign-in expired or was removed. Sign in on your computer again and re-link this phone."); }
                throw new Error(`Google said: ${why}`);
            }
            accessToken = { token: reply.body.access_token, expiresAt: Date.now() + (Number(reply.body.expires_in) || 3600) * 1000 };
            return accessToken.token;
        }

        const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const randomText = size => b64url(crypto.getRandomValues(new Uint8Array(size)));

        function stopPending() {
            if (!pending) return;
            clearTimeout(pending.timer);
            pending = null;
            loopback.loopbackStop().catch(() => {});
        }

        // Google sent the browser back to the app's listener: trade the code for the account.
        async function finishSignIn(event) {
            const sign = pending;
            if (!sign || Number(event && event.port) !== sign.port) return;
            const query = new URLSearchParams(String(event.query || ""));
            if (query.get("state") !== sign.state) return;
            stopPending();
            if (query.get("error")) { sign.result = { error: `Google sign-in was cancelled (${query.get("error")}).` }; return; }
            try {
                const reply = await send({ method: "POST", url: TOKEN_URL, form: { code: query.get("code") || "", client_id: sign.clientId, client_secret: sign.clientSecret,
                    redirect_uri: `http://127.0.0.1:${sign.port}`, grant_type: "authorization_code", code_verifier: sign.verifier } });
                const tokens = reply.body || {};
                if (reply.status !== 200 || !tokens.refresh_token) throw new Error(tokens.error_description || tokens.error || (reply.status === 200 ? "Google sent no refresh token. Remove CoDev at myaccount.google.com/permissions and sign in again." : `HTTP ${reply.status}`));
                let email = null;
                try {
                    const who = await send({ method: "GET", url: USERINFO_URL, headers: { Authorization: `Bearer ${tokens.access_token}` } });
                    email = (who.body && who.body.email) || null;
                } catch (err) { /* the account still works without the address */ }
                save({ clientId: sign.clientId, clientSecret: sign.clientSecret, refreshToken: tokens.refresh_token, scopes: String(tokens.scope || sign.scopes.join(" ")).split(" "), email, onPhone: true });
                accessToken = { token: tokens.access_token, expiresAt: now() + (Number(tokens.expires_in) || 3600) * 1000 };
                lastSignIn = { ok: true, email };
            } catch (err) {
                lastSignIn = { error: `Sign-in didn't finish: ${err.message || err}` };
            }
        }
        let lastSignIn = null;
        let listening = false;

        async function signIn({ clientId, clientSecret, allowWrite }) {
            clientId = String(clientId || "").trim();
            clientSecret = String(clientSecret || "").trim();
            if (!clientId) return { error: "Add your Google OAuth client ID first (the setup guide shows how to make one), or link this phone with a code from your computer." };
            if (!listening) { listening = true; await loopback.addListener("loopback", event => finishSignIn(event)); }
            stopPending();
            lastSignIn = null;
            const verifier = randomText(48);
            const state = randomText(24);
            const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
            const scopes = ["openid", "email", SCOPE.youtube, SCOPE.gmailRead, SCOPE.driveRead, ...(allowWrite ? [SCOPE.gmailSend, SCOPE.driveFile] : [])];
            const { port } = await loopback.loopbackStart();
            pending = { port: Number(port), state, verifier, clientId, clientSecret, scopes, timer: setTimeout(stopPending, SIGNIN_TIMEOUT_MS) };
            const url = `${AUTH_URL}?${new URLSearchParams({
                client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code", scope: scopes.join(" "),
                code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent"
            })}`;
            await loopback.openExternal({ url });
            return { url, opened: true };
        }

        return {
            kind: "phone",
            canSignIn: Boolean(loopback),
            async handle(req) {
                try {
                    const account = load();
                    switch (req.op) {
                        case "status": return { signedIn: Boolean(account && account.refreshToken), email: account && account.email || null, scopes: account && account.scopes || [], apiKey: false,
                            clientId: Boolean(account), phone: true, onPhone: Boolean(account && account.onPhone), signingIn: Boolean(pending), signInError: (lastSignIn && lastSignIn.error) || null };
                        case "signin":
                            if (!loopback) return { error: "Google's sign-in doesn't run on this page. Sign in on your computer, press \"Copy phone link code\" there, and paste it here." };
                            return await signIn(req);
                        case "import": {
                            let parsed;
                            try { parsed = JSON.parse(decodeURIComponent(escape(atob(String(req.code || "").trim())))); } catch (err) { return { error: "That isn't a CoDev phone link code. Copy it again from Settings > Google apps on your computer." }; }
                            if (!parsed || !parsed.clientId || !parsed.refreshToken) return { error: "That code is missing the sign-in. Copy it again from your computer." };
                            save({ clientId: parsed.clientId, clientSecret: parsed.clientSecret || "", refreshToken: parsed.refreshToken, scopes: parsed.scopes || [], email: parsed.email || null });
                            return { ok: true, email: parsed.email || null };
                        }
                        case "signout":
                            stopPending();
                            // A sign-in made on the phone is removed from the Google account too; one
                            // linked from the computer is shared with it, so the phone only forgets it.
                            if (account && account.onPhone && account.refreshToken) {
                                await send({ method: "POST", url: REVOKE_URL, form: { token: account.refreshToken } }).catch(() => {});
                            }
                            save(null);
                            return { ok: true };
                        case "link": return { error: "Copy the phone link code from the computer, not the phone." };
                        case "request": {
                            if (!isGoogleApiUrl(req.url)) return { error: "CoDev only sends Google requests to Google's API addresses." };
                            const target = new URL(req.url);
                            const headers = { ...(req.headers || {}) };
                            if (req.auth === "key") {
                                if (!req.apiKey) return { error: "No Google API key. Add one in Settings > Google apps." };
                                target.searchParams.set("key", req.apiKey);
                            } else {
                                headers.Authorization = `Bearer ${await token()}`;
                            }
                            if (req.body !== undefined && !Object.keys(headers).some(h => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
                            return await send({ method: req.method || "GET", url: target.href, headers, body: req.body });
                        }
                        default: return { error: "Unknown Google request." };
                    }
                } catch (err) { return { error: err.message || String(err) }; }
            }
        };
    }

    function detectTransport(win) {
        if (win.codevDesktop && win.codevDesktop.google) return backendTransport(req => win.codevDesktop.google(req), "computer");
        const cap = win.Capacitor;
        const native = cap && cap.isNativePlatform && cap.isNativePlatform();
        if (!native && win.location && win.location.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(win.location.hostname)) return serverTransport(win.fetch.bind(win));
        return phoneTransport({ http: native ? (cap.Plugins && cap.Plugins.CapacitorHttp) || null : null, storage: win.localStorage, fetchImpl: win.fetch.bind(win),
            loopback: native ? (cap.Plugins && cap.Plugins.CodevBrowser) || null : null });
    }

    // ---- Small helpers -------------------------------------------------------

    function base64UrlToText(data) {
        const bin = atob(String(data || "").replace(/-/g, "+").replace(/_/g, "/"));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder("utf-8").decode(bytes);
    }

    function textToBase64Url(text) {
        const bytes = new TextEncoder().encode(text);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    // A header value with non-ASCII characters, as email expects it (RFC 2047).
    function encodeHeader(value) {
        value = String(value || "").replace(/[\r\n]+/g, " ");
        if (/^[\x20-\x7e]*$/.test(value)) return value;
        return `=?UTF-8?B?${textToBase64Url(value).replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - textToBase64Url(value).length % 4) % 4)}?=`;
    }

    function htmlToText(html) {
        return String(html || "")
            .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
            .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
            .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    function formatDuration(iso) {
        const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ""));
        if (!m) return "";
        const hours = Number(m[1] || 0) * 24 + Number(m[2] || 0);
        const mins = Number(m[3] || 0), secs = Number(m[4] || 0);
        const pad = n => String(n).padStart(2, "0");
        return hours ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
    }

    function formatCount(n) {
        n = Number(n);
        if (!Number.isFinite(n)) return "";
        if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
        return String(n);
    }

    function youtubeId(input) {
        const text = String(input || "").trim();
        const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/.exec(text);
        if (m) return m[1];
        return /^[\w-]{11}$/.test(text) ? text : null;
    }

    function clampInt(value, min, max, fallback) {
        const n = Math.floor(Number(value));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    function slice(text, start, label) {
        start = clampInt(start, 0, Number.MAX_SAFE_INTEGER, 0);
        const part = text.slice(start, start + READ_CHUNK);
        const end = start + part.length;
        return part + (end < text.length ? `\n\n[Characters ${start}-${end} of ${text.length}. Call ${label} again with start ${end} for more, only if you need it.]` : "");
    }

    // Gmail's message parts: the plain text if there is one, else the HTML as text, and attachment names.
    function gmailBody(payload) {
        const plain = [], html = [], files = [];
        (function walk(part) {
            if (!part) return;
            if (part.filename) files.push(`${part.filename} (${part.mimeType}${part.body && part.body.size ? `, ${Math.round(part.body.size / 1024)} KB` : ""})`);
            else if (part.mimeType === "text/plain" && part.body && part.body.data) plain.push(base64UrlToText(part.body.data));
            else if (part.mimeType === "text/html" && part.body && part.body.data) html.push(base64UrlToText(part.body.data));
            (part.parts || []).forEach(walk);
        })(payload);
        return { text: plain.length ? plain.join("\n\n").trim() : htmlToText(html.join("\n")), files };
    }

    function header(headers, name) {
        const h = (headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : "";
    }

    const DRIVE_TYPES = {
        doc: "application/vnd.google-apps.document", sheet: "application/vnd.google-apps.spreadsheet",
        slides: "application/vnd.google-apps.presentation", folder: "application/vnd.google-apps.folder", pdf: "application/pdf"
    };
    const DRIVE_EXPORTS = {
        "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv",
        "application/vnd.google-apps.presentation": "text/plain"
    };
    const driveQuote = s => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

    // ---- The tools -----------------------------------------------------------

    // transport: from detectTransport. getApiKey: the key typed in Settings (or "").
    // confirmWrite(message) -> boolean: asked before every email and Drive save.
    // webSearch(query) -> { results: [{ title, href, body }] } and fetchText(url) -> { status, html }:
    // the page's own web search and page reader, for the free no-key fallbacks
    // (YouTube through web search and YouTube's oEmbed; Maps through OpenStreetMap).
    function createGoogleApps({ transport, getApiKey = () => "", confirmWrite = () => false, webSearch = null, fetchText = null }) {
        let statusCache = { at: 0, value: null };

        async function status(fresh) {
            if (!fresh && statusCache.value && Date.now() - statusCache.at < 20000) return statusCache.value;
            const reply = await transport.handle({ op: "status" });
            const value = reply.error ? { signedIn: false, scopes: [], apiKey: false, error: reply.error } : reply;
            statusCache = { at: Date.now(), value };
            return value;
        }

        const hasKey = st => Boolean(getApiKey() || st.apiKey);
        const hasScope = (st, scope) => st.signedIn && (st.scopes || []).includes(scope);

        async function api({ method = "GET", url, headers, body, auth = "user" }) {
            const reply = await transport.handle({ op: "request", method, url, headers, body, auth, apiKey: auth === "key" ? getApiKey() : undefined });
            if (reply.error) throw new Error(reply.error);
            if (reply.status >= 400) {
                const err = reply.body && reply.body.error;
                const message = (err && (err.message || err.status)) || (typeof reply.body === "string" ? reply.body.slice(0, 300) : "") || `HTTP ${reply.status}`;
                throw new Error(`Google answered ${reply.status}: ${message}`);
            }
            return reply.body;
        }

        // ---- YouTube
        async function youtubeAuth() {
            const st = await status();
            if (hasKey(st)) return "key";
            if (hasScope(st, SCOPE.youtube)) return "user";
            throw new Error("YouTube isn't connected. Add a Google API key or sign in under Settings > Google apps.");
        }

        async function youtubeConnected() {
            const st = await status();
            return hasKey(st) || hasScope(st, SCOPE.youtube);
        }

        // No key and no sign-in: YouTube results from the web search, without view counts.
        async function youtubeSearchFree(query, max, ctx) {
            if (!webSearch) throw new Error("YouTube isn't connected. Add a Google API key under Settings > Google apps.");
            const found = await webSearch(`site:youtube.com ${query}`);
            const videos = (found.results || []).filter(r => /youtube\.com\/(watch|shorts|@|channel|playlist)|youtu\.be\//.test(r.href)).slice(0, clampInt(max, 1, 15, 6));
            if (!videos.length) return "No YouTube results.";
            videos.forEach(r => { if (ctx && ctx.sources && !ctx.sources.some(x => x.href === r.href)) ctx.sources.push({ title: `YouTube: ${r.title}`, href: r.href }); });
            return videos.map((r, n) => `[${n + 1}] ${r.title}\n${r.href}\n${r.body || ""}`).join("\n\n")
                + "\n\n(Free search without a Google API key: no view counts or dates. Adding a key in Settings > Google apps gives full YouTube results.)";
        }

        async function youtubeVideoFree(id, ctx) {
            const link = `https://www.youtube.com/watch?v=${id}`;
            if (!fetchText) throw new Error("YouTube isn't connected. Add a Google API key under Settings > Google apps.");
            const reply = await fetchText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link)}`);
            if (reply.status >= 400) return `YouTube has no public video ${id} (HTTP ${reply.status}).`;
            let info = {};
            try { info = JSON.parse(reply.html); } catch (err) { return "YouTube's answer couldn't be read."; }
            if (ctx && ctx.sources && !ctx.sources.some(x => x.href === link)) ctx.sources.push({ title: `YouTube: ${info.title}`, href: link });
            return `Title: ${info.title}\nChannel: ${info.author_name}\n${link}\n\n(Without a Google API key CoDev only gets the title and channel. Add a key in Settings > Google apps for views, length, description and comments.)`;
        }

        async function youtubeSearch({ query, max, order, recent_days: recentDays, type }, ctx) {
            if (!String(query || "").trim()) return "youtube_search needs a query.";
            if (!(await youtubeConnected())) return youtubeSearchFree(query, max, ctx);
            const auth = await youtubeAuth();
            const kind = ["video", "channel", "playlist"].includes(type) ? type : "video";
            const params = new URLSearchParams({ part: "snippet", q: String(query), type: kind, maxResults: String(clampInt(max, 1, 15, 6)) });
            if (["relevance", "date", "viewCount", "rating"].includes(order)) params.set("order", order);
            if (recentDays) params.set("publishedAfter", new Date(Date.now() - clampInt(recentDays, 1, 3650, 7) * 86400000).toISOString());
            const found = await api({ url: `${YT}/search?${params}`, auth });
            const items = (found.items || []);
            if (!items.length) return "No YouTube results.";
            const ids = items.map(i => i.id && i.id.videoId).filter(Boolean);
            const details = {};
            if (ids.length) {
                const info = await api({ url: `${YT}/videos?part=statistics,contentDetails&id=${ids.join(",")}`, auth });
                (info.items || []).forEach(v => { details[v.id] = v; });
            }
            return items.map((item, n) => {
                const s = item.snippet || {};
                const id = item.id || {};
                const link = id.videoId ? `https://www.youtube.com/watch?v=${id.videoId}` : id.channelId ? `https://www.youtube.com/channel/${id.channelId}` : `https://www.youtube.com/playlist?list=${id.playlistId}`;
                if (ctx && ctx.sources && !ctx.sources.some(x => x.href === link)) ctx.sources.push({ title: `YouTube: ${s.title}`, href: link });
                const d = details[id.videoId];
                const extra = d ? ` · ${formatCount(d.statistics && d.statistics.viewCount)} views · ${formatDuration(d.contentDetails && d.contentDetails.duration)}` : "";
                return `[${n + 1}] ${s.title} (${s.channelTitle}, ${String(s.publishedAt || "").slice(0, 10)})${extra}\n${link}\n${s.description || ""}`;
            }).join("\n\n");
        }

        async function youtubeVideo({ video, comments }, ctx) {
            const id = youtubeId(video);
            if (!id) return "youtube_video needs a YouTube link or an 11-character video id.";
            if (!(await youtubeConnected())) return youtubeVideoFree(id, ctx);
            const auth = await youtubeAuth();
            const info = await api({ url: `${YT}/videos?part=snippet,statistics,contentDetails&id=${id}`, auth });
            const v = (info.items || [])[0];
            if (!v) return `No YouTube video with id ${id} (it may be private or removed).`;
            const s = v.snippet || {}, st = v.statistics || {};
            const link = `https://www.youtube.com/watch?v=${id}`;
            if (ctx && ctx.sources && !ctx.sources.some(x => x.href === link)) ctx.sources.push({ title: `YouTube: ${s.title}`, href: link });
            const lines = [
                `Title: ${s.title}`, `Channel: ${s.channelTitle}`, `Published: ${String(s.publishedAt || "").slice(0, 10)}`,
                `Length: ${formatDuration(v.contentDetails && v.contentDetails.duration)}`,
                `Views: ${formatCount(st.viewCount)} · Likes: ${formatCount(st.likeCount)} · Comments: ${formatCount(st.commentCount)}`,
                link, "", "Description:", String(s.description || "(none)").slice(0, 4000)
            ];
            if (comments) {
                try {
                    const thread = await api({ url: `${YT}/commentThreads?part=snippet&order=relevance&maxResults=${clampInt(comments === true ? 10 : comments, 1, 30, 10)}&videoId=${id}&textFormat=plainText`, auth });
                    const top = (thread.items || []).map(t => t.snippet.topLevelComment.snippet).map(c => `- ${c.authorDisplayName} (${formatCount(c.likeCount)} likes): ${String(c.textDisplay || "").replace(/\s+/g, " ").slice(0, 400)}`);
                    lines.push("", "Top comments:", top.length ? top.join("\n") : "(none)");
                } catch (err) { lines.push("", `Comments: ${err.message}`); }
            }
            return lines.join("\n");
        }

        // ---- Maps
        // Without a Google key, OpenStreetMap: Nominatim for places and the OSRM demo
        // router for directions. Both free and keyless; no ratings, hours or traffic.
        async function osmJson(url) {
            if (!fetchText) throw new Error("Maps needs a Google API key here. Add it under Settings > Google apps.");
            const reply = await fetchText(url);
            if (reply.status >= 400) throw new Error(`OpenStreetMap answered HTTP ${reply.status}.`);
            try { return JSON.parse(reply.html); } catch (err) { throw new Error("OpenStreetMap's answer couldn't be read."); }
        }

        async function osmGeocode(place, limit) {
            return osmJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&extratags=1&limit=${limit}&q=${encodeURIComponent(place)}`);
        }

        async function osmSearchPlaces({ query, near, max }) {
            const found = await osmGeocode(near ? `${query} near ${near}` : String(query), clampInt(max, 1, 10, 5));
            if (!found.length) return "No places found on OpenStreetMap. Try a more specific name or add a city.";
            return found.map((p, n) => {
                const tags = p.extratags || {};
                return [`[${n + 1}] ${p.name || String(p.display_name).split(",")[0]} (${String(p.type || p.category || "").replace(/_/g, " ")})`, p.display_name,
                    tags.opening_hours ? `Hours: ${tags.opening_hours}` : "", tags.phone || tags["contact:phone"] || "", tags.website || tags["contact:website"] || "",
                    `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`].filter(Boolean).join("\n");
            }).join("\n\n") + "\n\n(Free OpenStreetMap results: no ratings or open-now. A Google API key in Settings > Google apps gives Google Maps results.)";
        }

        async function osmDirections({ from, to, mode, units }) {
            const profile = { walk: "foot", bike: "bike" }[String(mode || "drive").toLowerCase()] || "driving";
            if (String(mode || "").toLowerCase() === "transit") return "Transit directions need a Google API key (Settings > Google apps). Without one CoDev can do driving, walking and biking.";
            const [a] = await osmGeocode(String(from), 1);
            const [b] = await osmGeocode(String(to), 1);
            if (!a || !b) return `OpenStreetMap couldn't find ${!a ? from : to}. Try a fuller address.`;
            const route = await osmJson(`https://router.project-osrm.org/route/v1/${profile}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false&steps=true`);
            const r = route.routes && route.routes[0];
            if (!r) return `No ${profile} route found from ${from} to ${to}.`;
            const metric = units === "metric";
            const dist = m => metric ? (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`) : (m >= 160 ? `${(m / 1609.34).toFixed(1)} mi` : `${Math.round(m * 3.281)} ft`);
            const mins = s => s >= 3600 ? `${Math.floor(s / 3600)} hr ${Math.round(s % 3600 / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`;
            const steps = [];
            for (const leg of r.legs || []) for (const s of leg.steps || []) {
                const m = s.maneuver || {};
                const what = m.type === "arrive" ? "Arrive" : m.type === "depart" ? "Head out" : `${m.type === "turn" || m.type === "end of road" ? "Turn" : m.type.replace(/^./, c => c.toUpperCase())}${m.modifier ? ` ${m.modifier}` : ""}`;
                steps.push(`${steps.length + 1}. ${what}${s.name ? ` onto ${s.name}` : ""}${s.distance ? ` (${dist(s.distance)})` : ""}`);
            }
            return [`${from} → ${to} by ${profile === "driving" ? "car" : profile}`, `Time: about ${mins(r.duration)} (no live traffic) · Distance: ${dist(r.distance)}`,
                `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}`, "",
                steps.slice(0, 40).join("\n"), "", "(Free OpenStreetMap route. A Google API key in Settings > Google apps adds live traffic and transit.)"].join("\n");
        }

        async function mapsSearchPlaces({ query, near, max, open_now: openNow }) {
            if (!String(query || "").trim()) return "maps_search_places needs a query.";
            if (!hasKey(await status())) return osmSearchPlaces({ query, near, max });
            const fields = ["displayName", "formattedAddress", "rating", "userRatingCount", "currentOpeningHours.openNow", "currentOpeningHours.weekdayDescriptions",
                "nationalPhoneNumber", "websiteUri", "googleMapsUri", "priceLevel", "primaryTypeDisplayName", "editorialSummary"].map(f => `places.${f}`).join(",");
            const body = { textQuery: near ? `${query} near ${near}` : String(query), maxResultCount: clampInt(max, 1, 10, 5), languageCode: "en" };
            if (openNow) body.openNow = true;
            const found = await api({ method: "POST", url: PLACES, headers: { "X-Goog-FieldMask": fields }, body, auth: "key" });
            const places = found.places || [];
            if (!places.length) return "No places found.";
            const today = (new Date().getDay() + 6) % 7; // Google lists hours Monday first
            return places.map((p, n) => {
                const hours = p.currentOpeningHours || {};
                const bits = [
                    p.primaryTypeDisplayName && p.primaryTypeDisplayName.text,
                    p.rating ? `${p.rating}★ (${formatCount(p.userRatingCount)} reviews)` : "",
                    p.priceLevel ? String(p.priceLevel).replace("PRICE_LEVEL_", "").toLowerCase().replace(/_/g, " ") : "",
                    hours.openNow === true ? "open now" : hours.openNow === false ? "closed now" : ""
                ].filter(Boolean).join(" · ");
                return [`[${n + 1}] ${p.displayName && p.displayName.text}${bits ? ` (${bits})` : ""}`, p.formattedAddress,
                    hours.weekdayDescriptions ? `Today: ${hours.weekdayDescriptions[today]}` : "",
                    p.editorialSummary ? p.editorialSummary.text : "", p.nationalPhoneNumber || "", p.websiteUri || "", p.googleMapsUri || ""].filter(Boolean).join("\n");
            }).join("\n\n");
        }

        async function mapsDirections({ from, to, mode, units }) {
            if (!String(from || "").trim() || !String(to || "").trim()) return "maps_directions needs from and to.";
            if (!hasKey(await status())) return osmDirections({ from, to, mode, units });
            const travelMode = { drive: "DRIVE", walk: "WALK", bike: "BICYCLE", transit: "TRANSIT", motorcycle: "TWO_WHEELER" }[String(mode || "drive").toLowerCase()] || "DRIVE";
            const body = { origin: { address: String(from) }, destination: { address: String(to) }, travelMode, units: units === "metric" ? "METRIC" : "IMPERIAL", languageCode: "en-US" };
            if (travelMode === "DRIVE" || travelMode === "TWO_WHEELER") body.routingPreference = "TRAFFIC_AWARE";
            const fields = "routes.description,routes.localizedValues,routes.warnings,routes.legs.steps.navigationInstruction,routes.legs.steps.localizedValues,routes.legs.steps.transitDetails.headsign,routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name,routes.legs.steps.transitDetails.stopDetails.departureStop.name,routes.legs.steps.transitDetails.localizedValues.departureTime";
            const found = await api({ method: "POST", url: ROUTES, headers: { "X-Goog-FieldMask": fields }, body, auth: "key" });
            const route = (found.routes || [])[0];
            if (!route) return `Google Maps found no ${travelMode.toLowerCase()} route from ${from} to ${to}.`;
            const lv = route.localizedValues || {};
            const link = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=${{ DRIVE: "driving", WALK: "walking", BICYCLE: "bicycling", TRANSIT: "transit", TWO_WHEELER: "driving" }[travelMode]}`;
            const steps = [];
            for (const leg of route.legs || []) {
                for (const step of leg.steps || []) {
                    const t = step.transitDetails;
                    const text = t ? `Take ${(t.transitLine && (t.transitLine.nameShort || t.transitLine.name)) || "transit"} toward ${t.headsign || "?"} from ${t.stopDetails && t.stopDetails.departureStop && t.stopDetails.departureStop.name || "the stop"}${t.localizedValues && t.localizedValues.departureTime ? ` at ${t.localizedValues.departureTime.time && t.localizedValues.departureTime.time.text}` : ""}`
                        : step.navigationInstruction && step.navigationInstruction.instructions;
                    if (text) steps.push(`${steps.length + 1}. ${text}${step.localizedValues && step.localizedValues.distance ? ` (${step.localizedValues.distance.text})` : ""}`);
                }
            }
            return [`${from} → ${to} by ${travelMode.toLowerCase().replace("_", " ")}`,
                `Time: ${lv.duration ? lv.duration.text : "?"}${lv.staticDuration && lv.duration && lv.staticDuration.text !== lv.duration.text ? ` (${lv.staticDuration.text} without traffic)` : ""} · Distance: ${lv.distance ? lv.distance.text : "?"}`,
                route.description ? `Via ${route.description}` : "", ...(route.warnings || []).map(w => `⚠️ ${w}`),
                link, "", steps.slice(0, 40).join("\n") + (steps.length > 40 ? `\n… ${steps.length - 40} more steps` : "")].filter(s => s !== "").join("\n");
        }

        // ---- Gmail
        async function gmailSearch({ query, max }) {
            const params = new URLSearchParams({ maxResults: String(clampInt(max, 1, 25, 10)) });
            if (String(query || "").trim()) params.set("q", String(query));
            const list = await api({ url: `${GMAIL}/messages?${params}` });
            const ids = (list.messages || []).map(m => m.id);
            if (!ids.length) return `No emails match${query ? ` "${query}"` : ""}.`;
            const metas = await Promise.all(ids.map(id => api({ url: `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date` }).catch(err => ({ id, error: err.message }))));
            return metas.map(m => {
                if (m.error) return `[${m.id}] (couldn't read: ${m.error})`;
                const h = (m.payload && m.payload.headers) || [];
                const unread = (m.labelIds || []).includes("UNREAD") ? " · unread" : "";
                return `[${m.id}] ${header(h, "Date")}${unread}\nFrom: ${header(h, "From")}\nSubject: ${header(h, "Subject")}\n${m.snippet || ""}`;
            }).join("\n\n") + "\n\n(Read one in full with gmail_read and its id.)";
        }

        async function gmailRead({ id, start }) {
            if (!String(id || "").trim()) return "gmail_read needs the email's id from gmail_search.";
            const m = await api({ url: `${GMAIL}/messages/${encodeURIComponent(String(id).trim())}?format=full` });
            const h = (m.payload && m.payload.headers) || [];
            const { text, files } = gmailBody(m.payload);
            const head = ["From", "To", "Cc", "Date", "Subject"].map(name => header(h, name) ? `${name}: ${header(h, name)}` : "").filter(Boolean).join("\n");
            return `${head}${files.length ? `\nAttachments: ${files.join(", ")}` : ""}\n\n${slice(text || m.snippet || "(no text)", start, "gmail_read")}`;
        }

        async function gmailSend({ to, subject, body, cc, reply_to_id: replyToId }) {
            const recipients = String(to || "").trim();
            if (!recipients || !/@/.test(recipients)) return "gmail_send needs to: an email address.";
            if (!String(body || "").trim()) return "gmail_send needs a body.";
            let threadId, inReplyTo = "", references = "";
            subject = String(subject || "");
            if (replyToId) {
                const orig = await api({ url: `${GMAIL}/messages/${encodeURIComponent(replyToId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject` });
                threadId = orig.threadId;
                inReplyTo = header(orig.payload && orig.payload.headers, "Message-ID");
                references = `${header(orig.payload && orig.payload.headers, "References")} ${inReplyTo}`.trim();
                if (!subject) subject = header(orig.payload && orig.payload.headers, "Subject");
                if (subject && !/^re:/i.test(subject)) subject = `Re: ${subject}`;
            }
            const preview = `Send this email from your Gmail?\n\nTo: ${recipients}${cc ? `\nCc: ${cc}` : ""}\nSubject: ${subject}\n\n${String(body).slice(0, 1500)}${String(body).length > 1500 ? "\n…" : ""}`;
            if (!(await confirmWrite(preview))) return "The user declined sending this email. Don't send it another way.";
            const lines = [`To: ${encodeHeader(recipients)}`];
            if (cc) lines.push(`Cc: ${encodeHeader(cc)}`);
            lines.push(`Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit");
            if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${references}`);
            const raw = textToBase64Url(`${lines.join("\r\n")}\r\n\r\n${String(body).replace(/\r?\n/g, "\r\n")}`);
            const sent = await api({ method: "POST", url: `${GMAIL}/messages/send`, body: threadId ? { raw, threadId } : { raw } });
            return `Sent to ${recipients} (message id ${sent.id}).`;
        }

        // ---- Drive
        async function driveSearch({ query, type, folder_id: folderId, max }) {
            const terms = ["trashed = false"];
            const text = String(query || "").trim();
            if (text) terms.push(`(name contains ${driveQuote(text)} or fullText contains ${driveQuote(text)})`);
            if (type === "image" || type === "video") terms.push(`mimeType contains '${type}/'`);
            else if (DRIVE_TYPES[type]) terms.push(`mimeType = '${DRIVE_TYPES[type]}'`);
            if (folderId) terms.push(`${driveQuote(folderId)} in parents`);
            const params = new URLSearchParams({
                q: terms.join(" and "), pageSize: String(clampInt(max, 1, 50, 15)), supportsAllDrives: "true", includeItemsFromAllDrives: "true",
                fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)"
            });
            // Drive can't sort a full-text search.
            if (!text) params.set("orderBy", "modifiedTime desc");
            const found = await api({ url: `${DRIVE}/files?${params}` });
            const files = found.files || [];
            if (!files.length) return "No Drive files match.";
            return files.map(f => `[${f.id}] ${f.name}\n${f.mimeType.replace("application/vnd.google-apps.", "Google ")} · modified ${String(f.modifiedTime || "").slice(0, 10)}${f.size ? ` · ${Math.round(f.size / 1024)} KB` : ""}\n${f.webViewLink || ""}`).join("\n\n")
                + "\n\n(Read one with drive_read_file and its id; list a folder with drive_search folder_id.)";
        }

        async function driveReadFile({ id, start }) {
            id = String(id || "").trim();
            if (!id) return "drive_read_file needs the file's id from drive_search.";
            const enc = encodeURIComponent(id);
            const meta = await api({ url: `${DRIVE}/files/${enc}?fields=id,name,mimeType,size,webViewLink,modifiedTime&supportsAllDrives=true` });
            const intro = `${meta.name} (${meta.mimeType}) · modified ${String(meta.modifiedTime || "").slice(0, 10)}\n${meta.webViewLink || ""}\n\n`;
            if (meta.mimeType === DRIVE_TYPES.folder) return intro + await driveSearch({ folder_id: id, max: 50 });
            let text;
            if (DRIVE_EXPORTS[meta.mimeType]) text = await api({ url: `${DRIVE}/files/${enc}/export?mimeType=${encodeURIComponent(DRIVE_EXPORTS[meta.mimeType])}` });
            else if (/^text\/|json|xml|csv|javascript|markdown|x-sh|x-python|yaml/.test(meta.mimeType)) text = await api({ url: `${DRIVE}/files/${enc}?alt=media&supportsAllDrives=true` });
            else if (/^image\//.test(meta.mimeType)) return intro + "This is an image. To look at Drive images, use read_screenshots with the Google Drive folder's path on the user's computer (Google Drive for desktop shows it as a drive, like G:\\My Drive\\Screenshots).";
            else return intro + `CoDev can't read ${meta.mimeType} files from Drive as text. Give the user the link above.`;
            if (typeof text !== "string") text = JSON.stringify(text, null, 2);
            return intro + slice(text, start, "drive_read_file");
        }

        async function driveSaveFile({ name, content, as_google_doc: asDoc, folder_id: folderId }) {
            name = String(name || "").trim();
            if (!name) return "drive_save_file needs a file name.";
            if (typeof content !== "string") return "drive_save_file needs content as text.";
            const preview = `Save a new file to your Google Drive?\n\nName: ${name}${asDoc ? " (as a Google Doc)" : ""}${folderId ? `\nFolder id: ${folderId}` : ""}\n\n${content.slice(0, 1200)}${content.length > 1200 ? "\n…" : ""}`;
            if (!(await confirmWrite(preview))) return "The user declined saving this file to Drive.";
            const metadata = { name };
            if (asDoc) metadata.mimeType = DRIVE_TYPES.doc;
            if (folderId) metadata.parents = [String(folderId)];
            const boundary = `codev${Math.random().toString(36).slice(2)}`;
            const mediaType = /\.json$/i.test(name) ? "application/json" : /\.csv$/i.test(name) ? "text/csv" : /\.html?$/i.test(name) ? "text/html" : /\.md$/i.test(name) ? "text/markdown" : "text/plain";
            const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mediaType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
            const saved = await api({ method: "POST", url: `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
            return `Saved "${saved.name}" to Google Drive: ${saved.webViewLink || saved.id}`;
        }

        async function statusReport() {
            const st = await status(true);
            const lines = [];
            if (st.error) lines.push(`Google connection: ${st.error}`);
            lines.push(st.signedIn ? `Signed in to Google${st.email ? ` as ${st.email}` : ""}.` : "Not signed in to Google (Gmail and Drive are off).");
            lines.push(hasKey(st) ? "A Google API key is set (YouTube and Maps)." : "No Google API key, so YouTube and Maps use the free basic versions.");
            const on = [];
            if (hasKey(st) || hasScope(st, SCOPE.youtube)) on.push("YouTube");
            else if (webSearch && fetchText) on.push("YouTube (free basic search, no key)");
            if (hasKey(st)) on.push("Google Maps");
            else if (fetchText) on.push("Maps (free OpenStreetMap, no key)");
            if (hasScope(st, SCOPE.gmailRead)) on.push(`Gmail (read${hasScope(st, SCOPE.gmailSend) ? " and send, asking first" : " only"})`);
            if (hasScope(st, SCOPE.driveRead)) on.push(`Drive (read${hasScope(st, SCOPE.driveFile) ? " and save new files, asking first" : " only"})`);
            lines.push(on.length ? `Working now: ${on.join(", ")}.` : "No Google apps are connected yet.");
            if (!hasKey(st) || !st.signedIn) lines.push(`To connect more, the user opens Settings > Google apps. One-time Google Cloud setup: ${GUIDE_URL}`);
            return lines.join("\n");
        }

        const TOOLS = {
            google_apps_status: {
                description: "Check which Google apps (YouTube, Google Maps, Gmail, Google Drive) CoDev can use right now, and how the user connects the rest. Call it when the user asks about their Google apps and the tool they need isn't listed.",
                inputSchema: { type: "object", properties: {} }, run: statusReport
            },
            youtube_search: {
                description: "Search YouTube for videos (or channels/playlists), with views, length and date. Use it for highlights, interviews, press conferences, tutorials, or what people are saying on video.",
                inputSchema: { type: "object", properties: {
                    query: { type: "string", description: "What to search for." },
                    max: { type: "integer", description: "How many results (1-15, default 6)." },
                    order: { type: "string", enum: ["relevance", "date", "viewCount", "rating"], description: "Sort order (default relevance). Use date for the newest." },
                    recent_days: { type: "integer", description: "Optional: only videos from the last N days." },
                    type: { type: "string", enum: ["video", "channel", "playlist"] }
                }, required: ["query"] }, run: youtubeSearch
            },
            youtube_video: {
                description: "Get one YouTube video's details: title, channel, date, length, views, likes and full description, plus its top comments when comments is true.",
                inputSchema: { type: "object", properties: {
                    video: { type: "string", description: "A YouTube link or the 11-character video id." },
                    comments: { type: "boolean", description: "Also get the top comments." }
                }, required: ["video"] }, run: youtubeVideo
            },
            maps_search_places: {
                description: "Find places on Google Maps (restaurants, stores, gyms, venues, addresses) with rating, open/closed now, today's hours, phone, website and a Maps link.",
                inputSchema: { type: "object", properties: {
                    query: { type: "string", description: "What to find, like \"tacos\" or \"Chase Center\"." },
                    near: { type: "string", description: "Optional: the area, like \"downtown Austin\" or a ZIP code." },
                    max: { type: "integer", description: "How many places (1-10, default 5)." },
                    open_now: { type: "boolean", description: "Only places open right now." }
                }, required: ["query"] }, run: mapsSearchPlaces
            },
            maps_directions: {
                description: "Get directions and travel time between two places from Google Maps (live traffic when driving), with the turn-by-turn steps and a Maps link.",
                inputSchema: { type: "object", properties: {
                    from: { type: "string", description: "Start address or place name." },
                    to: { type: "string", description: "Destination address or place name." },
                    mode: { type: "string", enum: ["drive", "walk", "bike", "transit", "motorcycle"], description: "Default drive." },
                    units: { type: "string", enum: ["imperial", "metric"], description: "Default imperial (miles)." }
                }, required: ["from", "to"] }, run: mapsDirections
            },
            gmail_search: {
                description: "Search the user's Gmail and list matching emails (id, date, sender, subject, snippet). Takes Gmail search syntax, like \"from:dabble newer_than:7d\" or \"is:unread\". Read-only.",
                inputSchema: { type: "object", properties: {
                    query: { type: "string", description: "Gmail search, like in the Gmail search box. Empty lists the newest emails." },
                    max: { type: "integer", description: "How many emails (1-25, default 10)." }
                } }, run: gmailSearch
            },
            gmail_read: {
                description: "Read one email in full (headers, text and attachment names) by its id from gmail_search. Read-only.",
                inputSchema: { type: "object", properties: {
                    id: { type: "string", description: "The email's id from gmail_search." },
                    start: { type: "integer", description: "Optional: the character to start from, for the rest of a long email." }
                }, required: ["id"] }, run: gmailRead
            },
            gmail_send: {
                description: "Send an email from the user's Gmail. CoDev shows the user the email and sends only if they approve. Only use it when the user asked you to send this email; draft it in the chat first if they haven't seen it.",
                inputSchema: { type: "object", properties: {
                    to: { type: "string", description: "Recipient address(es), comma-separated." },
                    subject: { type: "string" }, body: { type: "string", description: "The plain-text email body." },
                    cc: { type: "string" },
                    reply_to_id: { type: "string", description: "Optional: the id of the email this replies to (from gmail_search), to keep the thread." }
                }, required: ["to", "body"] }, run: gmailSend
            },
            drive_search: {
                description: "Search the user's Google Drive by name and content, or list a folder, newest first. Returns ids, names, types and links. Read-only.",
                inputSchema: { type: "object", properties: {
                    query: { type: "string", description: "Words in the file's name or text. Leave empty to list recent files or a folder." },
                    type: { type: "string", enum: ["doc", "sheet", "slides", "pdf", "image", "video", "folder"] },
                    folder_id: { type: "string", description: "Optional: list inside this folder (id from drive_search)." },
                    max: { type: "integer", description: "How many files (1-50, default 15)." }
                } }, run: driveSearch
            },
            drive_read_file: {
                description: "Read a Google Drive file as text by its id: Google Docs and Slides as text, Sheets as CSV, and text, CSV or JSON files. A folder id lists the folder. Read-only.",
                inputSchema: { type: "object", properties: {
                    id: { type: "string", description: "The file's id from drive_search." },
                    start: { type: "integer", description: "Optional: the character to start from, for the next part of a long file." }
                }, required: ["id"] }, run: driveReadFile
            },
            drive_save_file: {
                description: "Save a new text file (or Google Doc) to the user's Google Drive. CoDev shows the user the file and saves only if they approve. It never changes or deletes existing files.",
                inputSchema: { type: "object", properties: {
                    name: { type: "string", description: "File name, like \"NBA props 10-28.md\"." },
                    content: { type: "string", description: "The full text." },
                    as_google_doc: { type: "boolean", description: "Save it as a Google Doc instead of a plain file." },
                    folder_id: { type: "string", description: "Optional: the folder's id from drive_search." }
                }, required: ["name", "content"] }, run: driveSaveFile
            }
        };

        // Only the tools that can work right now, so agents don't reach for one that can't.
        async function buildTools() {
            const st = await status();
            const names = ["google_apps_status"];
            if (hasKey(st) || hasScope(st, SCOPE.youtube) || (webSearch && fetchText)) names.push("youtube_search", "youtube_video");
            if (hasKey(st) || fetchText) names.push("maps_search_places", "maps_directions");
            if (hasScope(st, SCOPE.gmailRead)) names.push("gmail_search", "gmail_read");
            if (hasScope(st, SCOPE.gmailSend)) names.push("gmail_send");
            if (hasScope(st, SCOPE.driveRead)) names.push("drive_search", "drive_read_file");
            if (hasScope(st, SCOPE.driveFile)) names.push("drive_save_file");
            return names.map(name => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema, run: (args, ctx) => TOOLS[name].run(args || {}, ctx) }));
        }

        function describe(name, args) {
            args = args || {};
            switch (name) {
                case "google_apps_status": return "🔗 Checking Google apps";
                case "youtube_search": return `▶️ Searching YouTube: ${args.query}`;
                case "youtube_video": return `▶️ Reading YouTube video ${args.video}`;
                case "maps_search_places": return `📍 Finding ${args.query}${args.near ? ` near ${args.near}` : ""} on Maps`;
                case "maps_directions": return `🗺️ Directions: ${args.from} → ${args.to}`;
                case "gmail_search": return `📧 Searching Gmail${args.query ? `: ${args.query}` : ""}`;
                case "gmail_read": return "📧 Reading an email";
                case "gmail_send": return `📨 Sending an email to ${args.to} (asks you first)`;
                case "drive_search": return `📂 Searching Drive${args.query ? `: ${args.query}` : ""}`;
                case "drive_read_file": return "📄 Reading a Drive file";
                case "drive_save_file": return `💾 Saving ${args.name} to Drive (asks you first)`;
                default: return null;
            }
        }

        return { buildTools, describe, status, TOOLS, forgetStatus: () => { statusCache = { at: 0, value: null }; } };
    }

    // ---- Settings panel ------------------------------------------------------

    // Fills the Settings > Google apps section and wires its buttons. Fields save as
    // they change. apps: from createGoogleApps; el: the <details> element.
    function mountSettings(el, { transport, apps, storage, openWindow }) {
        const phone = transport.kind === "phone";
        const phoneSignIn = phone && transport.canSignIn;
        const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
        el.innerHTML = `
            <summary>🔗 Google apps (YouTube, Maps, Gmail, Drive)</summary>
            <div data-g="status" style="font-size: 0.85rem; white-space: pre-line;"></div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">Needs a one-time setup in Google Cloud (about 10 minutes). <a href="${GUIDE_URL}" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">Open the setup guide</a></div>
            <div class="form-group">
                <label>Google API key, for YouTube and Maps (starts with AIza)</label>
                <input type="text" data-g="apiKey" placeholder="AIza..." autocomplete="off" style="font-family: monospace;">
            </div>
            ${phoneSignIn ? `
            <div class="form-group">
                <label>OAuth client ID, for Gmail and Drive ("Desktop app" type)</label>
                <input type="text" data-g="clientId" placeholder="1234-abc.apps.googleusercontent.com" autocomplete="off" style="font-family: monospace;">
                <label>OAuth client secret</label>
                <input type="text" data-g="clientSecret" placeholder="GOCSPX-..." autocomplete="off" style="font-family: monospace;">
            </div>
            <label class="checkbox-group"><input type="checkbox" data-g="allowWrite"> Let agents send email and save new files to Drive (CoDev asks me every time). Sign in again after changing this.</label>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="btn-secondary" type="button" data-g="signin">🔐 Sign in with Google</button>
                <button class="btn-secondary" type="button" data-g="signout">Sign out</button>
            </div>
            <details>
                <summary style="font-size: 0.8rem;">Or link it from your computer</summary>
                <label style="font-size: 0.8rem;">On the computer, press "Copy phone link code" and paste it here.</label>
                <textarea data-g="code" spellcheck="false" placeholder="Phone link code" style="font-family: monospace; min-height: 60px;"></textarea>
                <button class="btn-secondary" type="button" data-g="import">🔗 Link this phone</button>
            </details>` : phone ? `
            <div class="form-group">
                <label>Gmail and Drive: sign in on your computer, press "Copy phone link code" there, and paste it here.</label>
                <textarea data-g="code" spellcheck="false" placeholder="Phone link code" style="font-family: monospace; min-height: 60px;"></textarea>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button class="btn-secondary" type="button" data-g="import">🔗 Link this phone</button>
                    <button class="btn-secondary" type="button" data-g="signout">Unlink</button>
                </div>
            </div>` : `
            <div class="form-group">
                <label>OAuth client ID, for Gmail and Drive ("Desktop app" type)</label>
                <input type="text" data-g="clientId" placeholder="1234-abc.apps.googleusercontent.com" autocomplete="off" style="font-family: monospace;">
                <label>OAuth client secret</label>
                <input type="text" data-g="clientSecret" placeholder="GOCSPX-..." autocomplete="off" style="font-family: monospace;">
            </div>
            <label class="checkbox-group"><input type="checkbox" data-g="allowWrite"> Let agents send email and save new files to Drive (CoDev asks me every time). Sign in again after changing this.</label>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <button class="btn-secondary" type="button" data-g="signin">🔐 Sign in with Google</button>
                <button class="btn-secondary" type="button" data-g="signout">Sign out</button>
                <button class="btn-secondary" type="button" data-g="link">📱 Copy phone link code</button>
            </div>`}
            <div data-g="note" style="font-size: 0.8rem; color: var(--text-muted); overflow-wrap: anywhere;"></div>`;
        const $ = name => el.querySelector(`[data-g="${name}"]`);
        const note = text => { $("note").textContent = text || ""; };

        for (const field of ["apiKey", "clientId", "clientSecret"]) {
            const input = $(field);
            if (!input) continue;
            input.value = storage.getItem(STORE[field]) || "";
            input.addEventListener("input", () => {
                storage.setItem(STORE[field], input.value.replace(/[\s"'`]+/g, ""));
                apps.forgetStatus();
            });
            input.addEventListener("change", () => refresh());
        }
        if ($("allowWrite")) {
            $("allowWrite").checked = storage.getItem(STORE.allowWrite) === "1";
            $("allowWrite").addEventListener("change", () => storage.setItem(STORE.allowWrite, $("allowWrite").checked ? "1" : "0"));
        }

        async function refresh() {
            apps.forgetStatus();
            const report = await apps.status(true);
            const lines = [];
            if (report.error) lines.push(`⚠️ ${report.error}`);
            else lines.push(report.signedIn ? `✅ Signed in${report.email ? ` as ${report.email}` : ""}${phone && !report.onPhone ? " (linked from your computer)" : ""}` : report.signingIn ? "⏳ Waiting for you to finish signing in to Google in your browser…" : "Gmail and Drive: not signed in");
            if (report.signInError && !report.signedIn) lines.push(`⚠️ ${report.signInError}`);
            lines.push((storage.getItem(STORE.apiKey) || report.apiKey) ? "✅ API key set: YouTube and Maps are on" : "YouTube and Maps: add an API key");
            if (report.signedIn) {
                const s = report.scopes || [];
                lines.push(`Agents can: ${[s.includes(SCOPE.gmailRead) && "read Gmail", s.includes(SCOPE.gmailSend) && "send email (asks first)", s.includes(SCOPE.driveRead) && "read Drive", s.includes(SCOPE.driveFile) && "save to Drive (asks first)"].filter(Boolean).join(", ") || "nothing yet"}`);
            }
            $("status").textContent = lines.join("\n");
            return report;
        }

        let polling = null;
        if ($("signin")) $("signin").addEventListener("click", async () => {
            note("");
            // Opened now, while the click still counts, so a pop-up blocker allows it.
            const tab = openWindow ? openWindow() : null;
            const reply = await transport.handle({ op: "signin", clientId: storage.getItem(STORE.clientId) || "", clientSecret: storage.getItem(STORE.clientSecret) || "", allowWrite: storage.getItem(STORE.allowWrite) === "1" });
            if (reply.error) { if (tab) tab.close(); note(reply.error); return refresh(); }
            if (tab && !reply.opened) tab.location.href = reply.url;
            else if (tab) tab.close();
            note(reply.opened ? "Google's sign-in opened in your browser. Finish there, then come back." : tab ? "Finish signing in on the Google tab, then come back." : `Open this address to sign in: ${reply.url}`);
            clearInterval(polling);
            const started = Date.now();
            polling = setInterval(async () => {
                const st = await refresh();
                if (st.signedIn || !st.signingIn || Date.now() - started > 5 * 60 * 1000) {
                    clearInterval(polling);
                    if (st.signedIn) note("Connected. Agents can use your Google apps now.");
                }
            }, 2000);
            refresh();
        });
        $("signout").addEventListener("click", async () => {
            const reply = await transport.handle({ op: "signout" });
            note(reply.error || (phone && !phoneSignIn ? "This phone is unlinked." : "Signed out."));
            refresh();
        });
        if ($("link")) $("link").addEventListener("click", async () => {
            const reply = await transport.handle({ op: "link" });
            if (reply.error) return note(reply.error);
            try { await navigator.clipboard.writeText(reply.code); note("Copied. Paste it in CoDev on your phone under Settings > Google apps. It works like your sign-in, so only paste it into CoDev."); } catch (err) { note(`Copy this into CoDev on your phone (it works like your sign-in): ${reply.code}`); }
        });
        if ($("import")) $("import").addEventListener("click", async () => {
            const reply = await transport.handle({ op: "import", code: $("code").value });
            if (!reply.error) $("code").value = "";
            note(reply.error || `Linked${reply.email ? ` as ${reply.email}` : ""}.`);
            refresh();
        });
        el.addEventListener("toggle", () => { if (el.open) refresh(); });
        return { refresh };
    }

    return {
        STORE, SCOPE, GUIDE_URL, GOOGLE_TOOL_NAMES, isGoogleApiUrl,
        backendTransport, serverTransport, phoneTransport, detectTransport,
        createGoogleApps, mountSettings,
        base64UrlToText, textToBase64Url, encodeHeader, htmlToText, formatDuration, youtubeId, gmailBody
    };
});
