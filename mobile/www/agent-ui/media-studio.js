// CoDev's video and audio editing, the page's side (the tools run in Docker on
// this computer: desktop/media). It uploads the videos, audio and pictures the
// user attaches to the media folder, gives agents the media_* tools, and shows
// the files they make under the reply with a player and a download button.
//
// Where it reaches the media service:
//  - Windows app: window.codevDesktop.media({ op, ... }) over IPC.
//  - A browser on the computer running server.js: /agent/media/* and POST /agent-tools.
//  - Android and the web: neither exists yet, so editing is off there.
//
// The same file runs in the page and in Node (tests), like agent-client.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevMediaStudio = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const TOOL_NAMES = ["media_files", "media_info", "media_edit", "media_transcribe", "media_find", "media_separate", "media_find_on_computer", "media_import"];
    const UPLOAD_KINDS = ["video", "audio", "image"];
    const STATUS_CACHE_MS = 30000;

    function kindOf(name) {
        const ext = String(name || "").toLowerCase().split(".").pop();
        if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
        if (["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba"].includes(ext)) return "audio";
        if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
        if (["srt", "vtt", "txt"].includes(ext)) return "text";
        return null;
    }

    function formatBytes(n) {
        return n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    }

    // server.js on this computer.
    function httpTransport({ baseUrl = "", fetch: fetchImpl }) {
        let rpcId = 0;
        async function json(method, path, body) {
            const response = await fetchImpl(baseUrl + path, {
                method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            return data;
        }
        return {
            kind: "http",
            status: () => json("GET", "/agent/media/status"),
            prepare: () => json("POST", "/agent/media/prepare", {}),
            files: () => json("GET", "/agent/media/files"),
            remove: name => json("DELETE", `/agent/media/files?name=${encodeURIComponent(name)}`),
            async upload(file) {
                const response = await fetchImpl(`${baseUrl}/agent/media/upload?name=${encodeURIComponent(file.name)}`, {
                    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                return data;
            },
            url: async (name, download) => `${baseUrl}/agent/media/download?name=${encodeURIComponent(name)}${download ? "&download=1" : ""}`,
            async rpc(method, params) {
                const reply = await json("POST", "/agent-tools", { jsonrpc: "2.0", id: ++rpcId, method, params });
                if (reply.error) throw new Error(reply.error.message || "Media tool error");
                return reply.result;
            }
        };
    }

    // The Windows app's main process.
    function desktopTransport(bridge, { createUrl } = {}) {
        let rpcId = 0;
        const urls = new Map();
        const call = async req => {
            const reply = await bridge.media(req);
            if (reply && reply.error) throw new Error(reply.error);
            return reply;
        };
        return {
            kind: "desktop",
            status: () => call({ op: "status" }),
            prepare: () => call({ op: "prepare" }),
            files: () => call({ op: "files" }),
            remove: name => call({ op: "delete", name }),
            upload: async file => call({ op: "upload", name: file.name, data: await file.arrayBuffer() }),
            // A blob URL for the file's bytes, made once per file.
            async url(name) {
                if (urls.has(name)) return urls.get(name);
                const reply = await call({ op: "read", name });
                const url = createUrl ? createUrl(reply.data, reply.type) : null;
                urls.set(name, url);
                return url;
            },
            async rpc(method, params) {
                const reply = await call({ op: "mcp", message: { jsonrpc: "2.0", id: ++rpcId, method, params } });
                if (reply.error) throw new Error(reply.error.message || "Media tool error");
                return reply.result;
            }
        };
    }

    function detectTransport(win) {
        if (!win) return null;
        const bridge = win.codevDesktop;
        if (bridge && typeof bridge.media === "function") {
            return desktopTransport(bridge, { createUrl: (data, type) => win.URL.createObjectURL(new win.Blob([data], { type })) });
        }
        if (win.Capacitor && typeof win.Capacitor.isNativePlatform === "function" && win.Capacitor.isNativePlatform()) return null;
        const loc = win.location;
        if (loc && /^https?:$/.test(loc.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname) && typeof win.fetch === "function") {
            return httpTransport({ baseUrl: loc.origin, fetch: win.fetch.bind(win) });
        }
        return null;
    }

    function createMediaStudio({ transport, log = () => {} } = {}) {
        let cached = { at: 0, status: null };
        let toolCache = { at: 0, tools: [] };

        async function status(force) {
            if (!transport) return { available: false, reason: "Video editing runs on a computer: open CoDev with start-codev.bat or the Windows app." };
            if (!force && cached.status && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status;
            let s;
            try { s = await transport.status(); } catch (err) { s = { available: false, reason: `CoDev's media service isn't reachable (${err.message}). Update CoDev and restart it.` }; }
            if (!s.available && !s.reason) s.reason = (s.docker && s.docker.error) || "Docker isn't running.";
            cached = { at: Date.now(), status: s };
            return s;
        }

        async function available() {
            return Boolean((await status()).available);
        }

        // Copies an attached file to the media folder. Returns { name, kind, size } or null.
        async function upload(file) {
            if (!transport || !UPLOAD_KINDS.includes(kindOf(file.name))) return null;
            if (!(await available())) return null;
            const saved = await transport.upload(file);
            log(`[Media] ${file.name} is ready to edit as ${saved.name}.`);
            return saved;
        }

        async function fetchTools() {
            if (Date.now() - toolCache.at < 60000) return toolCache.tools;
            let tools = [];
            try { tools = ((await transport.rpc("tools/list", {})).tools || []).filter(t => TOOL_NAMES.includes(t.name)); } catch (err) { /* older CoDev */ }
            toolCache = { at: Date.now(), tools };
            return tools;
        }

        // The agents' media_* tools. New files go in ctx.mediaFiles for the reply.
        async function buildTools(ctx) {
            if (!transport || !(await available())) return [];
            return (await fetchTools()).map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema && tool.inputSchema.type === "object" ? tool.inputSchema : { type: "object", properties: {} },
                run: async (args, toolCtx) => {
                    const target = toolCtx || ctx || {};
                    if (target.onStep && tool.name !== "media_files") target.onStep(stepLabel(tool.name, args || {}));
                    const result = await transport.rpc("tools/call", { name: tool.name, arguments: args || {},
                        _meta: { "codev/agentId": target.agentId || "default", "codev/agentName": target.agentName || "An agent" } }) || {};
                    const made = (result._meta && result._meta["codev/mediaFiles"]) || [];
                    if (made.length) {
                        target.mediaFiles = target.mediaFiles || [];
                        for (const f of made) if (!target.mediaFiles.some(m => m.name === f.name)) target.mediaFiles.push(f);
                    }
                    const text = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
                    return (result.isError ? "Error: " : "") + (text || "(no output)");
                }
            }));
        }

        function stepLabel(name, args) {
            if (name === "media_edit") {
                const ops = (args.steps || []).map(s => s && s.op).filter(Boolean).join(", ");
                return `🎬 Editing ${args.input || "the video"}${ops ? `: ${ops}` : ""} (long clips take a few minutes)`;
            }
            if (name === "media_transcribe") return `📝 Transcribing ${args.file || "the clip"} with Whisper`;
            if (name === "media_find") return `🔎 Finding "${args.query || ""}" in ${args.file || "the clip"}`;
            if (name === "media_separate") return `🎚️ Separating the voice and music in ${args.file || "the clip"}`;
            return `🎬 ${name}`;
        }

        // Message attachments for the reply: kept small (names only) so chats stay light.
        function replyAttachments(ctx) {
            return ((ctx && ctx.mediaFiles) || []).map(f => ({ name: f.name.split("/").pop(), kind: f.kind || kindOf(f.name), mediaFile: f.name, size: f.size || 0 }));
        }

        // HTML for one made file. src is filled in by hydrate() (the Windows app needs a blob URL).
        function renderFile(att, escapeHtml) {
            const esc = escapeHtml || (s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])));
            const name = esc(att.mediaFile);
            const player = att.kind === "video" ? `<video controls preload="metadata" playsinline data-media-src="${name}"></video>`
                : att.kind === "audio" ? `<audio controls preload="metadata" data-media-src="${name}"></audio>`
                : att.kind === "image" ? `<img alt="${esc(att.name)}" data-media-src="${name}">`
                : "";
            return `<div class="media-result">${player}<div class="media-result-bar"><span>🎬 ${esc(att.name)}${att.size ? ` · ${formatBytes(att.size)}` : ""}</span>`
                + `<a class="btn-secondary" data-media-download="${name}" download="${esc(att.name)}">⬇ Download</a></div></div>`;
        }

        // Points the players and download links in a rendered chat at the files.
        async function hydrate(container) {
            if (!transport || !container || !container.querySelectorAll) return;
            for (const el of container.querySelectorAll("[data-media-src]:not([src])")) {
                const name = el.getAttribute("data-media-src");
                try { el.src = await transport.url(name, false); } catch (err) { el.replaceWith(Object.assign(el.ownerDocument.createElement("span"), { textContent: `(${name} is no longer in the media folder)` })); }
            }
            for (const el of container.querySelectorAll("[data-media-download]:not([href])")) {
                try { el.href = await transport.url(el.getAttribute("data-media-download"), true); } catch (err) { el.remove(); }
            }
        }

        return { status, available, upload, buildTools, replyAttachments, renderFile, hydrate, prepare: () => transport && transport.prepare(), files: () => transport && transport.files(), transport };
    }

    return { createMediaStudio, detectTransport, httpTransport, desktopTransport, kindOf, TOOL_NAMES };
});
