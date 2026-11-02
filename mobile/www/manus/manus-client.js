// CoDev's connector for Q tasks, which run on Manus (https://manus.ai) through
// its public API v2 (https://open.manus.ai/docs/v2/introduction). A Q task is an
// autonomous agent run on Manus's servers: it browses the web, works with files
// and keeps going after CoDev is closed. CoDev starts it, polls its events and
// shows what it reports back.
//
// The same file runs in three places:
//  - Windows app (Electron main process) and server.js on a computer, through
//    createProxyHandler(). There the key comes from MANUS_API_KEY, so it never
//    has to be typed into the page.
//  - Android app and the web page, through callManus() with the key from
//    Settings. On Android the request goes through the native HTTP client, so
//    Manus doesn't have to allow CORS.
//
// Only the operations in OPS can be called, and only their documented fields are
// passed on, so a page can't use the proxy to reach any other Manus endpoint.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevManus = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const API_BASE = "https://api.manus.ai/v2/";
    const REQUEST_TIMEOUT_MS = 30000;
    // Manus allows 100 task.listMessages calls a minute per user; every 6 s for a
    // handful of tasks stays well under that.
    const POLL_MS = 6000;
    const MAX_POLL_MS = 60000;
    const AGENT_PROFILES = ["standard", "lite", "max"];

    const OPS = {
        create: { method: "POST", path: "task.create", fields: ["message", "agent_profile", "interactive_mode", "locale", "title", "hide_in_task_list", "share_visibility", "project_id", "structured_output_schema"] },
        detail: { method: "GET", path: "task.detail", fields: ["task_id"] },
        messages: { method: "GET", path: "task.listMessages", fields: ["task_id", "limit", "cursor", "order", "verbose", "start_event_id"] },
        list: { method: "GET", path: "task.list", fields: ["limit", "cursor", "order"] },
        send: { method: "POST", path: "task.sendMessage", fields: ["task_id", "message", "agent_profile"] },
        stop: { method: "POST", path: "task.stop", fields: ["task_id"] },
        confirm: { method: "POST", path: "task.confirmAction", fields: ["task_id", "event_id", "input"] },
        browsers: { method: "GET", path: "browser.onlineList", fields: [] }
    };

    class ManusError extends Error {
        constructor(message, code, status) {
            super(message);
            this.code = code || "error";
            this.status = status || 0;
        }
    }

    function cleanKey(value) {
        return String(value || "").replace(/[\s​-‍﻿]+/g, "").replace(/^["'`]+|["'`]+$/g, "");
    }

    function buildRequest(op, params) {
        const spec = OPS[op];
        if (!spec) throw new ManusError(`Unknown Q task operation "${op}".`, "invalid_argument", 400);
        const picked = {};
        for (const field of spec.fields) {
            if (params && params[field] !== undefined && params[field] !== null && params[field] !== "") picked[field] = params[field];
        }
        if (spec.fields.includes("task_id") && typeof picked.task_id !== "string") {
            throw new ManusError(`${spec.path} needs a task_id.`, "invalid_argument", 400);
        }
        if (spec.method === "GET") {
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(picked)) query.set(key, String(value));
            const qs = query.toString();
            return { method: "GET", url: API_BASE + spec.path + (qs ? `?${qs}` : ""), body: undefined };
        }
        return { method: "POST", url: API_BASE + spec.path, body: JSON.stringify(picked) };
    }

    // Default transport: fetch(), with a timeout. Returns { status, text }.
    async function fetchTransport({ method, url, headers, body }) {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
        try {
            const response = await fetch(url, { method, headers, body, signal: controller ? controller.signal : undefined });
            return { status: response.status, text: await response.text() };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // Calls one operation. Resolves with Manus's JSON reply, or throws ManusError.
    async function callManus({ op, params, apiKey, transport }) {
        const key = cleanKey(apiKey);
        if (!key) {
            throw new ManusError("No Manus API key. Set MANUS_API_KEY on this computer, or add the key under Settings > Q tasks (Manus).", "no_key", 401);
        }
        const request = buildRequest(op, params);
        const headers = { "x-manus-api-key": key, "Accept": "application/json" };
        if (request.body !== undefined) headers["Content-Type"] = "application/json";
        let reply;
        try {
            reply = await (transport || fetchTransport)({ ...request, headers });
        } catch (err) {
            const reason = err && err.name === "AbortError" ? "timed out" : (err && err.message) || String(err);
            throw new ManusError(`Couldn't reach Manus at api.manus.ai (${reason}). Check that this device is online and nothing is blocking api.manus.ai.`, "unreachable", 0);
        }
        let data = null;
        try { data = typeof reply.text === "string" ? (reply.text ? JSON.parse(reply.text) : {}) : reply.text; } catch (err) { data = null; }
        if (reply.status >= 200 && reply.status < 300 && data && data.ok !== false) return data;
        const code = (data && data.error && data.error.code) || (reply.status === 429 ? "rate_limited" : `http_${reply.status}`);
        let message = (data && data.error && data.error.message) || `Manus returned HTTP ${reply.status}.`;
        if (reply.status === 401 || reply.status === 403) message = `Manus rejected the API key (${reply.status}: ${message}). Check the key in your Manus account's API settings.`;
        throw new ManusError(message, code, reply.status);
    }

    // For server.js and the Windows app: takes { op, params, apiKey? } from the
    // page and answers { result } or { error, code }. The computer's key wins;
    // the page's key is used only when MANUS_API_KEY isn't set.
    function createProxyHandler({ getKey, transport }) {
        return async req => {
            try {
                if (!req || typeof req !== "object") throw new ManusError("Bad request.", "invalid_argument", 400);
                if (req.op === "status") return { result: { keySource: cleanKey(getKey()) ? "computer" : "none" } };
                const apiKey = cleanKey(getKey()) || cleanKey(req.apiKey);
                return { result: await callManus({ op: req.op, params: req.params || {}, apiKey, transport }) };
            } catch (err) {
                return { error: err.message, code: err.code || "error", status: err.status || 0 };
            }
        };
    }

    // Builds the task.create (or task.sendMessage) message. Text over Manus's
    // ~5,000-token limit is cut, with a note, rather than refused. Files go along
    // as base64 data URIs ({ filename, dataUri }), which Manus takes up to 20 MB each.
    const MAX_PROMPT_CHARS = 18000;
    const MAX_FILES = 10;
    const MAX_FILE_DATA_CHARS = 26 * 1024 * 1024; // about 20 MB once decoded

    function buildMessage(prompt, files) {
        let text = String(prompt || "").trim();
        if (!text) throw new ManusError("A Q task needs a prompt.", "invalid_argument", 400);
        if (text.length > MAX_PROMPT_CHARS) text = text.slice(0, MAX_PROMPT_CHARS) + "\n[CoDev cut this prompt to fit Manus's limit.]";
        const parts = (files || [])
            .filter(f => f && typeof f.dataUri === "string" && /^data:[^;,]+;base64,/.test(f.dataUri) && f.dataUri.length <= MAX_FILE_DATA_CHARS)
            .slice(0, MAX_FILES)
            .map(f => ({ type: "file", file_data: f.dataUri, filename: String(f.filename || "file").slice(0, 200) }));
        return { content: parts.length ? [{ type: "text", text }, ...parts] : text };
    }

    function buildCreateParams({ prompt, files, agentProfile, interactive, title, locale }) {
        const params = { message: buildMessage(prompt, files) };
        if (AGENT_PROFILES.includes(agentProfile)) params.agent_profile = agentProfile;
        if (interactive) params.interactive_mode = true;
        if (title) params.title = String(title).slice(0, 120);
        if (locale) params.locale = locale;
        return params;
    }

    // Folds task.listMessages events into what CoDev shows for a task.
    function summarizeEvents(events) {
        const sorted = [...events].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const summary = { status: "running", statusAt: 0, lastEventAt: 0, statusText: "", waiting: null, replies: [], attachments: [], error: "", structured: null, lastEventId: "" };
        for (const event of sorted) {
            summary.lastEventId = event.id || summary.lastEventId;
            summary.lastEventAt = Math.max(summary.lastEventAt, event.timestamp || 0);
            if (event.type === "status_update" && event.status_update) {
                const update = event.status_update;
                summary.status = update.agent_status || summary.status;
                summary.statusAt = event.timestamp || 0;
                summary.statusText = update.brief || update.description || "";
                summary.waiting = update.agent_status === "waiting" ? (update.status_detail || {}) : null;
            } else if (event.type === "assistant_message" && event.assistant_message) {
                const msg = event.assistant_message;
                if (msg.content) summary.replies.push({ id: event.id, content: msg.content, kind: msg.delivery_kind || "", question: msg.question_expectation || null });
                for (const file of msg.attachments || []) {
                    if (file && file.url && !summary.attachments.some(a => a.url === file.url)) summary.attachments.push({ name: file.filename || "file", url: file.url, type: file.type || "file" });
                }
            } else if (event.type === "error_message" && event.error_message) {
                summary.error = event.error_message.content || event.error_message.error_type || "Error";
            } else if (event.type === "structured_output_result" && event.structured_output_result) {
                summary.structured = event.structured_output_result;
            }
        }
        if (summary.status === "error" && !summary.error) summary.error = summary.statusText || "The task failed.";
        return summary;
    }

    // Polls one task until it stops or fails. `call(op, params)` is the caller's
    // transport. onUpdate gets (summary, events, detail) whenever something new
    // arrives. Rate limits and network blips back off instead of giving up.
    // notBefore is a Manus event timestamp (ms): pass the newest event's
    // timestamp + 1 after sending the task something. A stopped, waiting or
    // failed status from before then is old news, so the task counts as running
    // until Manus reports a newer status. (Manus's clock, so a wrong clock on
    // this device doesn't matter.)
    function watchTask({ call, taskId, onUpdate, onError, intervalMs, notBefore }) {
        const events = new Map();
        let sentAt = notBefore || 0;
        let stopped = false;
        let delay = intervalMs || POLL_MS;
        let timer = null;
        let lastSeen = "";

        async function fetchNewEvents() {
            // Newest first, paging back until a page holds an event already seen.
            let cursor;
            for (let page = 0; page < 10; page++) {
                const reply = await call("messages", { task_id: taskId, order: "desc", limit: 50, cursor });
                let sawKnown = false;
                for (const event of reply.messages || []) {
                    if (events.has(event.id)) sawKnown = true;
                    else events.set(event.id, event);
                }
                if (sawKnown || !reply.has_more || !reply.next_cursor) return;
                cursor = reply.next_cursor;
            }
        }

        async function tick() {
            if (stopped) return;
            try {
                await fetchNewEvents();
                const list = [...events.values()];
                const summary = summarizeEvents(list);
                if (summary.status !== "running" && summary.statusAt < sentAt) {
                    summary.status = "running";
                    summary.waiting = null;
                    summary.error = "";
                }
                let detail = null;
                let finished = summary.status === "error";
                if (summary.status === "stopped") {
                    // "stopped" can be temporary while background jobs are still running.
                    detail = (await call("detail", { task_id: taskId })).task || null;
                    finished = !(detail && detail.has_running_background_jobs);
                }
                const seen = `${summary.lastEventId}|${summary.status}`;
                if (seen !== lastSeen || detail) {
                    lastSeen = seen;
                    onUpdate && onUpdate(summary, list, detail);
                }
                delay = intervalMs || POLL_MS;
                if (finished) { stopped = true; return; }
                // A task waiting on the user doesn't change by itself, so check less often.
                if (summary.status === "waiting") delay = Math.min(delay * 3, MAX_POLL_MS);
            } catch (err) {
                onError && onError(err);
                if (err.code === "no_key" || err.status === 401 || err.status === 403 || err.status === 404) { stopped = true; return; }
                delay = Math.min(delay * 2, MAX_POLL_MS) + Math.floor(Math.random() * 1000);
            }
            if (!stopped) timer = setTimeout(tick, delay);
        }

        timer = setTimeout(tick, 0);
        return {
            stop() { stopped = true; if (timer) clearTimeout(timer); },
            // Poll now, for example right after the user answered a question.
            poke(newNotBefore) {
                if (newNotBefore) sentAt = newNotBefore;
                if (stopped) return;
                if (timer) clearTimeout(timer);
                delay = intervalMs || POLL_MS;
                timer = setTimeout(tick, 0);
            },
            get running() { return !stopped; }
        };
    }

    return { API_BASE, OPS, AGENT_PROFILES, ManusError, buildRequest, callManus, createProxyHandler, buildMessage, buildCreateParams, summarizeEvents, watchTask, cleanKey };
});
