// CoDev's MCP client hub: one Client from the official MCP SDK
// (@modelcontextprotocol/sdk) per configured server. It runs the initialize
// handshake, keeps what each server declared it can do, and maps every
// server's tools and resources into one list the page can hand to the model.
//
// The same file runs in three places, and each passes in the transports it can
// actually use:
//  - Windows app (Electron main process) and server.js on a computer: stdio
//    (servers started as a local process: npx, uvx, python, an .exe), plus
//    Streamable HTTP and the older HTTP+SSE.
//  - Android app and the web page: Streamable HTTP and HTTP+SSE only. A phone
//    or a browser tab can't start a process, so stdio servers report that.
//
// Server config uses the same "mcpServers" shape as Claude Desktop and most
// MCP server READMEs:
//   { "mcpServers": {
//       "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\code"] },
//       "docs":  { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } } } }
// A "url" server tries Streamable HTTP first and falls back to HTTP+SSE, unless
// "type" is "http" or "sse". "disabled": true skips a server.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevMcpHubCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const CLIENT_INFO = { name: "codev-studio", title: "CoDev Studio", version: "1.0.0" };
    const CONNECT_TIMEOUT_MS = { stdio: 90000, http: 15000 }; // npx may download the server on first start
    const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
    const LIST_TIMEOUT_MS = 20000;
    const RETRY_AFTER_MS = 30000; // a server that failed isn't retried on every message
    const MAX_PAGES = 50;
    const STDERR_LINES = 20;

    class HubError extends Error {}

    // Accepts {"mcpServers": {...}}, or the inner object, as JSON text or an object.
    function normalizeConfig(raw) {
        let config = raw;
        if (typeof raw === "string") {
            if (!raw.trim()) return {};
            try { config = JSON.parse(raw); } catch (err) { throw new HubError(`MCP servers config isn't valid JSON: ${err.message}`); }
        }
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new HubError("MCP servers config must be a JSON object.");
        const servers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : config;
        const out = {};
        for (const [name, entry] of Object.entries(servers)) {
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new HubError(`MCP server name "${name}" must be 1-32 letters, digits, _ or -.`);
            if (!entry || typeof entry !== "object") throw new HubError(`MCP server "${name}" must be an object.`);
            if (entry.disabled) continue;
            const type = String(entry.type || entry.transport || "").toLowerCase();
            if (typeof entry.command === "string" && entry.command.trim()) {
                out[name] = {
                    kind: "stdio",
                    command: entry.command,
                    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
                    env: entry.env && typeof entry.env === "object" ? entry.env : {},
                    cwd: typeof entry.cwd === "string" && entry.cwd ? entry.cwd : undefined
                };
            } else if (typeof entry.url === "string" && /^https?:\/\//i.test(entry.url)) {
                out[name] = {
                    kind: type === "sse" ? "sse" : (type === "http" || type === "streamable-http" || type === "streamablehttp") ? "http" : "auto",
                    url: entry.url,
                    headers: entry.headers && typeof entry.headers === "object" ? entry.headers : {}
                };
            } else {
                throw new HubError(`MCP server "${name}" needs a "command" (local process) or an http(s) "url".`);
            }
        }
        return out;
    }

    // Model-facing tool names are "<server>__<tool>", limited to what OpenAI-style
    // function calling accepts.
    function qualifiedToolName(server, tool) {
        return `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    }

    // sdk: { Client, StreamableHTTPClientTransport, SSEClientTransport,
    //        ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema }
    // makeStdioTransport(config, onStderrLine): only where processes can be started.
    // httpFetch / sseFetch: optional fetch replacements (the Android app routes
    // Streamable HTTP through the native HTTP client so CORS doesn't apply).
    function createMcpHub({ sdk, makeStdioTransport, httpFetch, sseFetch, platform, log }) {
        const say = log || (() => {});
        const servers = new Map(); // name -> state
        let configJson = "{}";

        function stateFor(name, config) {
            return { name, config, client: null, transport: null, transportKind: null, status: "idle", error: "",
                     failedAt: 0, connecting: null, info: null, tools: null, resources: null, templates: null, stderr: [] };
        }

        function configure(raw) {
            const next = normalizeConfig(raw);
            configJson = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            for (const [name, s] of servers) {
                if (!next[name] || JSON.stringify(next[name]) !== JSON.stringify(s.config)) {
                    disconnect(s);
                    servers.delete(name);
                }
            }
            for (const [name, config] of Object.entries(next)) if (!servers.has(name)) servers.set(name, stateFor(name, config));
            return status();
        }

        function disconnect(s) {
            const client = s.client;
            s.client = null;
            s.transport = null;
            s.connecting = null;
            s.tools = s.resources = s.templates = null;
            if (s.status === "connected") s.status = "idle";
            if (client) client.close().catch(() => {});
        }

        async function openTransport(s, kind) {
            const { config } = s;
            if (kind === "stdio") {
                if (!makeStdioTransport) {
                    throw new HubError(`"${s.name}" is a local-process (stdio) server. ${platform === "android" ? "Phones" : "Web pages"} can't start processes: use it from the Windows app or the local server (start-codev.bat), or give it a url.`);
                }
                return makeStdioTransport(config, line => {
                    s.stderr.push(line);
                    if (s.stderr.length > STDERR_LINES) s.stderr.shift();
                });
            }
            const url = new URL(config.url);
            if (kind === "http") {
                return new sdk.StreamableHTTPClientTransport(url, { requestInit: { headers: config.headers }, fetch: httpFetch });
            }
            return new sdk.SSEClientTransport(url, { requestInit: { headers: config.headers }, fetch: sseFetch });
        }

        // initialize -> InitializeResult (protocol version, server capabilities,
        // serverInfo, instructions) -> notifications/initialized. Client.connect does
        // all three and rejects servers on a protocol version it doesn't support.
        async function handshake(s, kind) {
            const client = new sdk.Client(CLIENT_INFO, { capabilities: {} });
            client.onclose = () => {
                if (s.client !== client) return;
                s.client = null;
                s.tools = s.resources = s.templates = null;
                if (s.status === "connected") { s.status = "idle"; say(`[MCP] ${s.name} disconnected.`); }
            };
            const transport = await openTransport(s, kind);
            // The Client hands the negotiated version to transports that send it as a
            // header; this keeps a copy for every transport, for the status line.
            const setVersion = transport.setProtocolVersion;
            transport.setProtocolVersion = version => {
                transport.negotiatedVersion = version;
                if (setVersion) setVersion.call(transport, version);
            };
            try {
                await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS[kind === "stdio" ? "stdio" : "http"] });
            } catch (err) {
                client.close().catch(() => {});
                throw err;
            }
            // Logged only once connected: a failed Streamable HTTP attempt before the
            // SSE fallback isn't worth a line.
            client.onerror = err => say(`[MCP] ${s.name}: ${err && err.message ? err.message : err}`);
            // Servers that declared listChanged tell us when to re-list.
            client.setNotificationHandler(sdk.ToolListChangedNotificationSchema, () => { s.tools = null; });
            client.setNotificationHandler(sdk.ResourceListChangedNotificationSchema, () => { s.resources = null; s.templates = null; });
            return { client, transport };
        }

        async function connect(s) {
            const kinds = s.config.kind === "auto" ? ["http", "sse"] : [s.config.kind];
            let lastError;
            for (const kind of kinds) {
                try {
                    const { client, transport } = await handshake(s, kind);
                    s.client = client;
                    s.transport = transport;
                    s.transportKind = kind;
                    s.status = "connected";
                    s.error = "";
                    s.info = {
                        serverInfo: client.getServerVersion() || null,
                        capabilities: client.getServerCapabilities() || {},
                        instructions: client.getInstructions() || "",
                        protocolVersion: transport.negotiatedVersion || null
                    };
                    say(`[MCP] Connected to ${s.name} (${s.info.serverInfo ? s.info.serverInfo.name : "server"}) over ${kind === "http" ? "Streamable HTTP" : kind === "sse" ? "HTTP+SSE" : "stdio"}.`);
                    return;
                } catch (err) {
                    lastError = err;
                    if (err instanceof HubError) break;
                }
            }
            // fetch's own message ("fetch failed", "Failed to fetch") doesn't say what it tried.
            if (s.config.url && /fetch/i.test(String(lastError && lastError.message))) {
                throw new HubError(`Couldn't reach ${s.config.url} (${lastError.message}). Is the server running${platform === "web" ? " and does it allow this page's origin (CORS)" : ""}?`);
            }
            throw lastError;
        }

        async function ensureConnected(name) {
            const s = servers.get(name);
            if (!s) throw new HubError(`No MCP server named "${name}".`);
            if (s.client) return s;
            if (s.status === "error" && Date.now() - s.failedAt < RETRY_AFTER_MS) throw new HubError(s.error);
            if (!s.connecting) {
                s.status = "connecting";
                s.connecting = connect(s).catch(err => {
                    s.status = "error";
                    s.failedAt = Date.now();
                    const tail = s.stderr.length ? ` (stderr: ${s.stderr.slice(-3).join(" | ")})` : "";
                    s.error = `${err && err.message ? err.message : err}${tail}`;
                    say(`[MCP] ${s.name} unavailable: ${s.error}`);
                    throw new HubError(s.error);
                }).finally(() => { s.connecting = null; });
            }
            await s.connecting;
            return s;
        }

        // A JSON-RPC error from the server has a numeric code; anything else
        // (process exited, network dropped) means the connection is gone.
        function dropIfBroken(s, err) {
            if (!(err && typeof err.code === "number")) disconnect(s);
        }

        async function listAll(s, method, key) {
            const items = [];
            let cursor;
            for (let page = 0; page < MAX_PAGES; page++) {
                const result = await s.client[method](cursor ? { cursor } : {}, { timeout: LIST_TIMEOUT_MS });
                items.push(...(result[key] || []));
                cursor = result.nextCursor;
                if (!cursor) break;
            }
            return items;
        }

        async function serverTools(s) {
            if (!s.info.capabilities.tools) return [];
            if (!s.tools) {
                try { s.tools = await listAll(s, "listTools", "tools"); } catch (err) { dropIfBroken(s, err); throw err; }
            }
            return s.tools;
        }

        async function serverResources(s) {
            if (!s.info.capabilities.resources) return { resources: [], templates: [] };
            try {
                if (!s.resources) s.resources = await listAll(s, "listResources", "resources");
                if (!s.templates) s.templates = await listAll(s, "listResourceTemplates", "resourceTemplates").catch(() => []);
            } catch (err) { dropIfBroken(s, err); throw err; }
            return { resources: s.resources, templates: s.templates };
        }

        // Runs fn on every server at once; a server that fails is skipped, not fatal.
        async function eachServer(fn) {
            const settled = await Promise.allSettled([...servers.keys()].map(async name => fn(await ensureConnected(name))));
            return settled.filter(r => r.status === "fulfilled").map(r => r.value);
        }

        async function listTools() {
            const perServer = await eachServer(async s => (await serverTools(s)).map(t => ({
                server: s.name,
                name: t.name,
                qualifiedName: qualifiedToolName(s.name, t.name),
                title: t.title || (t.annotations && t.annotations.title) || "",
                description: t.description || "",
                inputSchema: t.inputSchema,
                outputSchema: t.outputSchema,
                annotations: t.annotations || {}
            })));
            return [].concat(...perServer);
        }

        async function callTool({ server, name, arguments: args }) {
            const s = await ensureConnected(server);
            try {
                return await s.client.callTool({ name, arguments: args || {} }, undefined, { timeout: TOOL_TIMEOUT_MS, resetTimeoutOnProgress: true });
            } catch (err) { dropIfBroken(s, err); throw err; }
        }

        async function listResources() {
            const perServer = await eachServer(async s => {
                const { resources, templates } = await serverResources(s);
                return [
                    ...resources.map(r => ({ server: s.name, uri: r.uri, name: r.name, title: r.title || "", description: r.description || "", mimeType: r.mimeType || "", size: r.size })),
                    ...templates.map(t => ({ server: s.name, uriTemplate: t.uriTemplate, name: t.name, title: t.title || "", description: t.description || "", mimeType: t.mimeType || "" }))
                ];
            });
            return [].concat(...perServer);
        }

        async function readResource({ server, uri }) {
            const s = await ensureConnected(server);
            try {
                return await s.client.readResource({ uri }, { timeout: LIST_TIMEOUT_MS });
            } catch (err) { dropIfBroken(s, err); throw err; }
        }

        function status() {
            return [...servers.values()].map(s => ({
                name: s.name,
                kind: s.config.kind,
                transport: s.transportKind,
                target: s.config.kind === "stdio" ? [s.config.command, ...s.config.args].join(" ") : s.config.url,
                status: s.status,
                error: s.error,
                serverInfo: s.info && s.info.serverInfo,
                protocolVersion: s.info && s.info.protocolVersion,
                capabilities: s.info && s.info.capabilities,
                instructions: s.info && s.info.instructions,
                toolCount: s.tools ? s.tools.length : null,
                resourceCount: s.resources ? s.resources.length : null,
                stderr: s.stderr.slice(-5)
            }));
        }

        // Connects everything now (Settings' "Test" button) instead of on first use.
        async function refresh() {
            for (const s of servers.values()) { disconnect(s); s.status = "idle"; s.failedAt = 0; }
            await eachServer(async s => { await serverTools(s); await serverResources(s).catch(() => {}); });
            return status();
        }

        async function close() {
            for (const s of servers.values()) disconnect(s);
        }

        // One entry point with plain-data requests and replies, so the same hub can
        // sit behind Electron IPC, an HTTP endpoint, or a direct call in the page.
        async function handle(req) {
            try {
                const op = req && req.op;
                if (op === "configure") return { result: configure(req.config) };
                if (op === "getConfig") return { result: configJson };
                if (op === "status") return { result: status() };
                if (op === "refresh") return { result: await refresh() };
                if (op === "listTools") return { result: await listTools() };
                if (op === "callTool") return { result: await callTool(req) };
                if (op === "listResources") return { result: await listResources() };
                if (op === "readResource") return { result: await readResource(req) };
                return { error: `Unknown MCP hub request: ${op}` };
            } catch (err) {
                return { error: err && err.message ? err.message : String(err) };
            }
        }

        return { configure, status, refresh, listTools, callTool, listResources, readResource, close, handle, platform };
    }

    return { createMcpHub, normalizeConfig, qualifiedToolName, HubError };
});
