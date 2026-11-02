// The Outlier pipeline (agents/outlier) inside the Windows app: its agent tools
// join the browser's over the codev:browser-mcp IPC, and the 📈 Outlier tab's
// requests (the routes server.js serves under /outlier/) come over
// codev:outlier-request. It uses the app's own browser manager, so the signed-in
// "@outlier" browser shows in the live view like everywhere else.
const fs = require('fs');
const path = require('path');

// The repo's copy when the app runs from source, else the one copy-bundle.js put
// next to this file (the installer has only that one).
function findPipeline() {
    for (const dir of [path.join(__dirname, '..', 'agents', 'outlier'), path.join(__dirname, 'bundle', 'agents', 'outlier')]) {
        if (fs.existsSync(path.join(dir, 'index.js'))) return dir;
    }
    return null;
}

// browser: the app's browser service ({ manager, live }). service: a ready
// agents/outlier service instead of loading one (tests). Returns null when the
// pipeline isn't there or fails to start, and the app runs without it.
function createOutlierBridge({ browser, getProjectDir = () => '', service = null, log = console.log } = {}) {
    if (!service) {
        const dir = findPipeline();
        if (!dir) { log('[outlier] Not included in this build.'); return null; }
        try {
            const workspace = { get root() { return getProjectDir(); } };
            service = require(dir).createService({ workspace }, {
                log: line => log(`[outlier] ${line}`),
                services: { browser: { shared: { manager: browser.manager, live: browser.live } } }
            });
        } catch (err) {
            log(`[outlier] Failed to start: ${err.message}`);
            return null;
        }
    }
    const isOutlierTool = name => typeof name === 'string' && service.tools.some(t => t.name === name);

    // One JSON-RPC message for the agents' tools: Outlier's own calls here, the rest
    // to next (the browser's handler), with Outlier's tools added to its list.
    async function handleMcp(message, next) {
        if (message && message.method === 'tools/call' && isOutlierTool(message.params && message.params.name)) {
            const meta = message.params._meta || {};
            const ctx = { agentId: String(meta['codev/agentId'] || meta['codev/agent'] || 'default'), agentName: meta['codev/agentName'] ? String(meta['codev/agentName']) : null, meta };
            let result;
            try { result = await service.callTool(message.params.name, message.params.arguments || {}, ctx); } catch (err) {
                result = { content: [{ type: 'text', text: err.message || String(err) }], isError: true };
            }
            return { jsonrpc: '2.0', id: message.id, result };
        }
        const reply = await next(message);
        if (message && message.method === 'tools/list' && reply && reply.result) {
            reply.result = { ...reply.result, tools: [...(reply.result.tools || []), ...service.tools] };
        }
        return reply;
    }

    // { method, path, body } -> { status, body }, through the same route handlers
    // server.js uses, with a stand-in response that keeps what they send.
    async function request({ method = 'GET', path: urlPath = '/', body } = {}) {
        const pathname = new URL(String(urlPath), 'app://codev').pathname;
        const handler = (service.routes || {})[`${String(method).toUpperCase()} ${pathname}`];
        if (!handler) return { status: 404, body: { error: 'Not found' } };
        return new Promise(resolve => {
            let status = 200;
            let text = '';
            const res = {
                writeHead(code) { status = code; return res; },
                write(chunk) { text += chunk; return true; },
                end(chunk) {
                    if (chunk) text += chunk;
                    let parsed;
                    try { parsed = JSON.parse(text); } catch { parsed = { text }; }
                    resolve({ status, body: parsed });
                }
            };
            Promise.resolve(handler({ method, url: urlPath, headers: {} }, res, body || {}))
                .catch(err => resolve({ status: 500, body: { error: err.message } }));
        });
    }

    return { tools: service.tools, handleMcp, request, close: () => (service.close ? service.close() : undefined) };
}

module.exports = { createOutlierBridge, findPipeline };
