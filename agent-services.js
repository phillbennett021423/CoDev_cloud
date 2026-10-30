// Loads the agent services (sandbox containers + diff review, headless browser,
// the Outlier pipeline, the Godot and Blender tools)
// and routes the page's tool calls to them. server.js serves the result at
// POST /agent-tools as MCP JSON-RPC (initialize, tools/list, tools/call), the
// same messages the Windows app's built-in tools take over IPC.
//
// A service module exports createService(config, { log, services }) returning
// (services: the ones started before it, by name)
//   { name, tools: [{ name, description, inputSchema }] (or async listTools()),
//     callTool(name, args, ctx) -> MCP CallToolResult,
//     handleRequest?(method, pathname, query, body) -> { status, body } | null,
//     routes?: { 'POST /path': async (req, res, body) => reply },
//     status() -> { available, detail } (or a promise of it), close() }
// handleRequest gets the page's REST calls under /agent/ (null = not mine);
// routes are exact paths. Both are for the page only, never for agents.
// with ctx = { agentId, agentName, workspace, meta } from the call's _meta
// (codev/agentId or codev/agent, codev/agentName, codev/workspace). Results,
// _meta included, go back to the page untouched. A module that isn't there is skipped, and
// one that fails to start is reported and skipped, so the page always loads.
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';
const SERVICES = [
    { name: 'sandbox', module: path.join(__dirname, 'desktop', 'sandbox') },
    { name: 'browser', module: path.join(__dirname, 'agents', 'browser') },
    { name: 'outlier', module: path.join(__dirname, 'agents', 'outlier') },
    { name: 'gamedev', module: path.join(__dirname, 'agents', 'gamedev') }
];

function isMissingModule(err, modulePath) {
    // Only "this service isn't installed", not a missing dependency inside it.
    return err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(modulePath);
}

async function loadServices(config, { log = console.log, specs = SERVICES } = {}) {
    const services = [];
    const skipped = [];
    for (const spec of specs) {
        let mod;
        try { mod = require(spec.module); } catch (err) {
            if (isMissingModule(err, spec.module)) { skipped.push({ name: spec.name, detail: 'not installed' }); continue; }
            skipped.push({ name: spec.name, detail: `failed to load: ${err.message}` });
            continue;
        }
        try {
            // services: the ones already started, by name (outlier uses browser's).
            const started = Object.fromEntries(services.map(s => [s.name, s]));
            const service = await mod.createService(config, { log: line => log(`[${spec.name}] ${line}`), services: started });
            services.push(service);
        } catch (err) {
            skipped.push({ name: spec.name, detail: `failed to start: ${err.message}` });
        }
    }
    return createRouter(services, skipped, log);
}

function createRouter(services, skipped, log) {
    // Each tool name goes to one service; the first one listed keeps a duplicate.
    async function toolIndex() {
        const index = new Map();
        for (const service of services) {
            let tools = [];
            try { tools = service.listTools ? await service.listTools() : await service.tools; } catch (err) {
                log(`Listing ${service.name} tools: ${err.message}`);
            }
            for (const tool of tools || []) {
                if (index.has(tool.name)) log(`Tool ${tool.name} from ${service.name} is hidden by ${index.get(tool.name).service.name}.`);
                else index.set(tool.name, { service, tool });
            }
        }
        return index;
    }

    const routes = new Map();
    for (const service of services) {
        for (const [key, handler] of Object.entries(service.routes || {})) {
            const [method, route] = key.split(/\s+/);
            if (routes.has(`${method.toUpperCase()} ${route}`)) log(`Route ${key} from ${service.name} is already taken; ignored.`);
            else routes.set(`${method.toUpperCase()} ${route}`, { service, handler });
        }
    }

    async function callTool(params) {
        const entry = (await toolIndex()).get(params && params.name);
        if (!entry) return { content: [{ type: 'text', text: `Unknown tool: ${params && params.name}` }], isError: true };
        const meta = (params && params._meta) || {};
        const ctx = {
            agentId: String(meta['codev/agentId'] || meta['codev/agent'] || 'default'),
            agentName: meta['codev/agentName'] ? String(meta['codev/agentName']) : null,
            workspace: String(meta['codev/workspace'] || 'default'),
            meta
        };
        try {
            return await entry.service.callTool(params.name, params.arguments || {}, ctx);
        } catch (err) {
            // A tool failure is a result the agent can read, not a protocol error.
            return { content: [{ type: 'text', text: err.message || String(err) }], isError: true };
        }
    }

    // One JSON-RPC message in, the reply out (null for notifications).
    async function handle(message) {
        if (Array.isArray(message)) {
            const replies = (await Promise.all(message.map(handle))).filter(Boolean);
            return replies.length ? replies : null;
        }
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
        }
        const { id, method, params } = message;
        if (id === undefined) return null; // notifications/initialized and friends
        const reply = result => ({ jsonrpc: '2.0', id, result });
        switch (method) {
            case 'initialize':
                return reply({
                    protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'codev-agent-tools', version: '1.0.0' }
                });
            case 'ping': return reply({});
            case 'tools/list': return reply({ tools: [...(await toolIndex()).values()].map(entry => entry.tool) });
            case 'tools/call': return reply(await callTool(params));
            default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
        }
    }

    // The first service that answers a REST call under /agent/ handles it.
    async function handleRequest(method, pathname, query, body) {
        for (const service of services) {
            if (!service.handleRequest) continue;
            const reply = await service.handleRequest(method, pathname, query, body);
            if (reply) return reply;
        }
        return null;
    }

    // status() may be async (the sandbox re-checks Docker each time).
    async function status() {
        const report = {};
        for (const service of services) {
            try { report[service.name] = service.status ? await service.status() : { available: true, detail: '' }; } catch (err) {
                report[service.name] = { available: false, detail: err.message };
            }
        }
        for (const { name, detail } of skipped) report[name] = { available: false, detail };
        return report;
    }

    async function close() {
        await Promise.all(services.map(async service => {
            try { if (service.close) await service.close(); } catch (err) { log(`Closing ${service.name}: ${err.message}`); }
        }));
    }

    return { handle, handleRequest, status, close, routes, services, skipped };
}

module.exports = { loadServices, createRouter, SERVICES };
