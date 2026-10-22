// CoDev's client for the agent infrastructure on this computer: sandboxed
// workspaces with a diff review gate (desktop/sandbox) and the agent tools served
// over MCP JSON-RPC (sandbox file/command tools, headless browser tools).
//
// Where the page reaches them:
//  - Windows app: window.codevDesktop.agentRequest({method, path, body}) for the
//    /agent/* routes and window.codevDesktop.sandboxMcp(message) for the tools.
//  - A browser on the computer running server.js: the same routes over HTTP,
//    /agent/* and POST /agent-tools.
//  - Android and the web: neither exists, so sandbox mode is unavailable.
//
// Routes (all JSON):
//   GET    /agent/status                    -> { docker, browser, workspace }
//   POST   /agent/sandboxes                 {agentId, task?, workspace?} -> sandbox
//   POST   /agent/sandboxes/:id/exec        {command, timeoutMs?} -> { exitCode, stdout, stderr, timedOut }
//   GET    /agent/sandboxes/:id/files?path= -> { path, content }
//   POST   /agent/sandboxes/:id/files       {path, content} -> { ok }
//   POST   /agent/sandboxes/:id/stage       -> changeset
//   DELETE /agent/sandboxes/:id             -> { ok }
//   GET    /agent/changes                   -> [changeset] (pending only)
//   GET    /agent/changes/:id               -> changeset
//   POST   /agent/changes/:id/approve       {paths?} -> { written, skipped }
//   POST   /agent/changes/:id/reject        {reason?} -> { ok }
// changeset = { id, sandboxId, agentId, status, createdAt, diff, submission?,
//   files: [{ path, status, additions, deletions, diff, checks: [{name, ok, skipped?, message}] }] }
//
// The same file runs in the page and in Node (tests), like mcp/mcp-hub-core.js.
// It lives in agent-ui/, not agent/, because server.js sends every /agent/ path to
// the agent services.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevAgentClient = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const enc = encodeURIComponent;
    // Every path the page uses, in one place, so a renamed route is a one-line change.
    const ROUTES = {
        status: () => "/agent/status",
        sandboxes: () => "/agent/sandboxes",
        sandbox: id => `/agent/sandboxes/${enc(id)}`,
        exec: id => `/agent/sandboxes/${enc(id)}/exec`,
        files: (id, path) => `/agent/sandboxes/${enc(id)}/files` + (path === undefined ? "" : `?path=${enc(path)}`),
        stage: id => `/agent/sandboxes/${enc(id)}/stage`,
        changes: () => "/agent/changes",
        change: id => `/agent/changes/${enc(id)}`,
        approve: id => `/agent/changes/${enc(id)}/approve`,
        reject: id => `/agent/changes/${enc(id)}/reject`,
        tools: () => "/agent-tools"
    };
    // Tools that only touch the sandbox's staging copy: nothing reaches the real
    // project until the user approves the diff, so they never need a confirm.
    const SANDBOX_TOOLS = ["list_files", "read_file", "search_files", "write_file", "edit_file", "delete_file", "run_command", "sandbox_diff", "submit_changes"];
    const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

    class AgentApiError extends Error {
        constructor(message, status, body) {
            super(message);
            this.name = "AgentApiError";
            this.status = status;
            this.body = body;
        }
    }

    function errorMessage(body, status) {
        if (body && typeof body === "object") {
            const err = body.error;
            if (typeof err === "string") return err;
            if (err && typeof err.message === "string") return err.message;
            if (typeof body.message === "string") return body.message;
        }
        if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
        if (status === 404) return "This CoDev server has no agent sandbox routes yet. Update CoDev and restart it.";
        return `HTTP ${status}`;
    }

    // server.js on this computer. The JSON content type is sent on every request:
    // the server turns away anything else, and same-origin requests need no preflight.
    function httpTransport({ baseUrl = "", fetch: fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        if (typeof fetchImpl !== "function") throw new Error("httpTransport needs a fetch function");
        const base = String(baseUrl).replace(/\/+$/, "");
        async function send(method, path, body) {
            const controller = typeof AbortController === "function" ? new AbortController() : null;
            const timer = controller && setTimeout(() => controller.abort(), timeoutMs);
            let response;
            try {
                response = await fetchImpl(base + path, {
                    method,
                    headers: { "Content-Type": "application/json", "Accept": "application/json" },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: controller ? controller.signal : undefined
                });
            } catch (err) {
                throw new AgentApiError(`Couldn't reach CoDev's server (${err.message}). Is "npm start" still running?`, 0, null);
            } finally {
                if (timer) clearTimeout(timer);
            }
            const text = await response.text();
            let data = text;
            try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
            return { status: response.status, body: data };
        }
        return {
            kind: "http",
            request: send,
            rpc: async message => {
                const reply = await send("POST", ROUTES.tools(), message);
                if (reply.status >= 400) throw new AgentApiError(errorMessage(reply.body, reply.status), reply.status, reply.body);
                return reply.body;
            }
        };
    }

    // The Windows app's preload bridge: same routes and payloads, over IPC.
    function desktopTransport(bridge) {
        return {
            kind: "desktop",
            request: async (method, path, body) => {
                const reply = await bridge.agentRequest({ method, path, body });
                return { status: reply?.status ?? 500, body: reply?.body ?? null };
            },
            rpc: message => bridge.sandboxMcp(message)
        };
    }

    // Which way this page can reach the agent infrastructure, or null (Android, the web).
    function detectTransport(win) {
        if (!win) return null;
        const bridge = win.codevDesktop;
        if (bridge && typeof bridge.agentRequest === "function" && typeof bridge.sandboxMcp === "function") return desktopTransport(bridge);
        if (win.Capacitor && typeof win.Capacitor.isNativePlatform === "function" && win.Capacitor.isNativePlatform()) return null;
        const loc = win.location;
        if (loc && /^https?:$/.test(loc.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname) && typeof win.fetch === "function") {
            return httpTransport({ baseUrl: loc.origin, fetch: win.fetch.bind(win) });
        }
        return null;
    }

    function createAgentClient({ transport, routes = ROUTES } = {}) {
        if (!transport) throw new Error("createAgentClient needs a transport");
        let rpcId = 0;
        let initialized = null;

        async function call(method, path, body) {
            const reply = await transport.request(method, path, body);
            if (reply.status >= 400 || reply.status === 0) throw new AgentApiError(errorMessage(reply.body, reply.status), reply.status, reply.body);
            return reply.body;
        }

        async function rpc(method, params) {
            const reply = await transport.rpc({ jsonrpc: "2.0", id: ++rpcId, method, params });
            if (reply && reply.error) throw new AgentApiError(reply.error.message || "Agent tool error", 500, reply);
            return reply ? reply.result : undefined;
        }

        // Done once per client; a server that doesn't need it may refuse it harmlessly.
        function initialize() {
            if (!initialized) {
                initialized = rpc("initialize", {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "codev-studio", title: "CoDev Studio", version: "1.0.0" }
                }).catch(() => null);
            }
            return initialized;
        }

        return {
            transport,
            status: () => call("GET", routes.status()),
            createSandbox: ({ agentId, task, workspace } = {}) => call("POST", routes.sandboxes(), { agentId, task, workspace }),
            exec: (id, command, timeoutMs) => call("POST", routes.exec(id), { command, timeoutMs }),
            readFile: (id, path) => call("GET", routes.files(id, path)),
            writeFile: (id, path, content) => call("POST", routes.files(id), { path, content }),
            stage: id => call("POST", routes.stage(id), {}),
            destroySandbox: id => call("DELETE", routes.sandbox(id)),
            listChanges: async () => {
                const list = await call("GET", routes.changes());
                return Array.isArray(list) ? list : (list && Array.isArray(list.changes) ? list.changes : []);
            },
            getChange: id => call("GET", routes.change(id)),
            approve: (id, paths) => call("POST", routes.approve(id), paths ? { paths } : {}),
            reject: (id, reason) => call("POST", routes.reject(id), reason ? { reason } : {}),
            listTools: async () => {
                await initialize();
                const result = await rpc("tools/list", {});
                return (result && result.tools) || [];
            },
            // MCP tools/call. The agent and sandbox go in _meta, under both names the
            // sandbox and browser services read.
            callTool: async (name, args, { agentId, sandboxId } = {}) => {
                await initialize();
                const meta = {};
                if (agentId) { meta["codev/agent"] = agentId; meta["codev/agentId"] = agentId; }
                if (sandboxId) meta["codev/workspace"] = sandboxId;
                return rpc("tools/call", { name, arguments: args || {}, _meta: meta });
            }
        };
    }

    // One prompt submission in sandbox mode. Each agent gets its own container, and
    // all of them share one staging copy (the workspace key), so a Group Swarm and
    // the Self-Healing pass see the earlier agents' edits. finish() stages the
    // combined change for review; dispose() always removes the containers.
    function createSandboxDispatch(client, { task = "", workspaceKey } = {}) {
        const key = workspaceKey || `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const sandboxes = new Map();
        let lastUsed = null;
        return {
            workspaceKey: key,
            get sandboxes() { return [...sandboxes.values()]; },
            async sandboxFor(agent) {
                const agentId = String(agent && agent.id != null ? agent.id : agent);
                if (!sandboxes.has(agentId)) {
                    // Stored as a promise, so two parallel calls share one container.
                    sandboxes.set(agentId, client.createSandbox({ agentId, task, workspace: key }));
                }
                try {
                    lastUsed = await sandboxes.get(agentId);
                } catch (err) {
                    sandboxes.delete(agentId);
                    throw err;
                }
                return lastUsed;
            },
            async stage() {
                if (!lastUsed) return null;
                return client.stage(lastUsed.id);
            },
            // The agents share one sandbox id, and the server already removes a sandbox
            // once its review is decided, so a 404 here means it's gone: fine.
            async dispose() {
                const all = await Promise.allSettled([...sandboxes.values()]);
                sandboxes.clear();
                const ids = [...new Set(all.filter(r => r.status === "fulfilled" && r.value && r.value.id).map(r => r.value.id))];
                const results = await Promise.allSettled(ids.map(id => client.destroySandbox(id)));
                return results.filter(r => r.status === "rejected" && r.reason && r.reason.status !== 404).map(r => r.reason);
            }
        };
    }

    // ---------- Diff parsing and review model ----------

    function stripPrefix(p) {
        if (!p || p === "/dev/null") return null;
        const unquoted = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
        return unquoted.replace(/^[ab]\//, "");
    }

    // Parses a unified (git) diff into files, hunks and numbered lines.
    function parseUnifiedDiff(text) {
        const files = [];
        if (typeof text !== "string" || !text) return files;
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        let file = null;
        let hunk = null;
        let oldNo = 0;
        let newNo = 0;

        function startFile(oldPath, newPath) {
            file = { oldPath, newPath, path: newPath || oldPath, status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 };
            files.push(file);
            hunk = null;
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let m;
            if ((m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line))) {
                startFile(m[1], m[2]);
                continue;
            }
            if (line.startsWith("--- ") && !(hunk && hunk.oldLeft > 0) && lines[i + 1] && lines[i + 1].startsWith("+++ ")) {
                const oldPath = stripPrefix(line.slice(4).split("\t")[0]);
                const newPath = stripPrefix(lines[i + 1].slice(4).split("\t")[0]);
                if (!file || file.hunks.length) startFile(oldPath, newPath);
                file.oldPath = oldPath;
                file.newPath = newPath;
                file.path = newPath || oldPath;
                if (!oldPath) file.status = "added";
                if (!newPath) file.status = "deleted";
                hunk = null;
                i++;
                continue;
            }
            if (!file) continue;
            if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line))) {
                oldNo = Number(m[1]);
                newNo = Number(m[3]);
                hunk = {
                    header: line, context: m[5] || "",
                    oldStart: oldNo, oldLines: m[2] === undefined ? 1 : Number(m[2]),
                    newStart: newNo, newLines: m[4] === undefined ? 1 : Number(m[4]),
                    lines: []
                };
                hunk.oldLeft = hunk.oldLines;
                hunk.newLeft = hunk.newLines;
                file.hunks.push(hunk);
                continue;
            }
            if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
                const mark = line[0];
                if (mark === "+") {
                    hunk.lines.push({ type: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
                    hunk.newLeft--;
                    file.additions++;
                    continue;
                }
                if (mark === "-") {
                    hunk.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
                    hunk.oldLeft--;
                    file.deletions++;
                    continue;
                }
                if (mark === " " || line === "") {
                    // A blank line inside a hunk is a context line whose space was trimmed.
                    if (line === "" && i === lines.length - 1) continue;
                    hunk.lines.push({ type: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
                    hunk.oldLeft--;
                    hunk.newLeft--;
                    continue;
                }
            }
            if (line.startsWith("\\ ")) {
                if (hunk) hunk.lines.push({ type: "meta", text: line.slice(2), oldNo: null, newNo: null });
                continue;
            }
            if (/^new file mode/.test(line)) file.status = "added";
            else if (/^deleted file mode/.test(line)) file.status = "deleted";
            else if ((m = /^rename from (.+)$/.exec(line))) { file.oldPath = m[1]; file.status = "renamed"; }
            else if ((m = /^rename to (.+)$/.exec(line))) { file.newPath = m[1]; file.path = m[1]; file.status = "renamed"; }
            else if (/^Binary files .* differ$/.test(line) || line === "GIT binary patch") file.binary = true;
        }
        files.forEach(f => f.hunks.forEach(h => { delete h.oldLeft; delete h.newLeft; }));
        return files;
    }

    function checkFailed(check) {
        return !!check && check.ok === false && !check.skipped;
    }

    // Turns a changeset into what the review screen shows: each file's parsed diff,
    // whether it can be approved, and the totals.
    function buildReviewModel(changeset) {
        const cs = changeset || {};
        const whole = parseUnifiedDiff(cs.diff || "");
        const files = (Array.isArray(cs.files) ? cs.files : []).map(f => {
            const parsed = f.diff ? parseUnifiedDiff(f.diff) : whole.filter(p => p.path === f.path || p.oldPath === f.path);
            const hunks = parsed.flatMap(p => p.hunks);
            const additions = Number.isFinite(f.additions) ? f.additions : parsed.reduce((n, p) => n + p.additions, 0);
            const deletions = Number.isFinite(f.deletions) ? f.deletions : parsed.reduce((n, p) => n + p.deletions, 0);
            const checks = Array.isArray(f.checks) ? f.checks : [];
            const failed = checks.filter(checkFailed);
            return {
                path: String(f.path || (parsed[0] && parsed[0].path) || "(unknown)"),
                status: f.status || (parsed[0] && parsed[0].status) || "modified",
                binary: parsed.some(p => p.binary),
                additions, deletions, hunks, checks,
                blocked: failed.length > 0,
                blockedReason: failed.map(c => `${c.name}: ${c.message || "failed"}`).join("; ")
            };
        });
        // A changeset that only carries the whole diff still gets one entry per file.
        if (!files.length) {
            whole.forEach(p => files.push({
                path: p.path || "(unknown)", status: p.status, binary: p.binary,
                additions: p.additions, deletions: p.deletions, hunks: p.hunks, checks: [], blocked: false, blockedReason: ""
            }));
        }
        return {
            id: cs.id,
            agentId: cs.agentId,
            status: cs.status || "pending",
            summary: (cs.submission && cs.submission.summary) || "",
            submittedBy: (cs.submission && cs.submission.agent) || "",
            files,
            approvable: files.filter(f => !f.blocked).map(f => f.path),
            totals: {
                files: files.length,
                additions: files.reduce((n, f) => n + f.additions, 0),
                deletions: files.reduce((n, f) => n + f.deletions, 0),
                blocked: files.filter(f => f.blocked).length
            }
        };
    }

    // One chat line for what the review ended in.
    function describeReviewOutcome(outcome) {
        if (!outcome) return "";
        if (outcome.decision === "rejected") return "❌ You rejected these changes. Nothing was written to your project.";
        if (outcome.decision === "deferred") return "⏸️ Changes kept for review later (📝 in the header). Nothing was written to your project yet.";
        if (outcome.decision === "empty") return "The agents made no file changes.";
        const result = outcome.result || {};
        const written = Array.isArray(result.written) ? result.written : [];
        const skipped = Array.isArray(result.skipped) ? result.skipped : [];
        const parts = [];
        parts.push(written.length ? `✅ Saved ${written.length} file${written.length === 1 ? "" : "s"} to your project: ${written.join(", ")}.` : "No files were written.");
        if (skipped.length) parts.push(`Skipped: ${skipped.map(s => typeof s === "string" ? s : `${s.path} (${s.reason})`).join("; ")}.`);
        const left = Array.isArray(outcome.left) ? outcome.left : [];
        if (left.length) parts.push(`${left.length} file${left.length === 1 ? " is" : "s are"} still waiting for review under 📝: ${left.join(", ")}.`);
        return parts.join(" ");
    }

    return {
        ROUTES, SANDBOX_TOOLS, AgentApiError,
        httpTransport, desktopTransport, detectTransport, createAgentClient, createSandboxDispatch,
        parseUnifiedDiff, buildReviewModel, describeReviewOutcome
    };
});
