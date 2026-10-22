// Serves CoDev Studio on this computer: npm start, then open http://localhost:3000
// CoDev has no backend of its own. The page talks to Groq directly, and the
// optional search/commands helper lives in tools/ddgs-helper.
// POST /mcp-hub lets the page use MCP servers on this computer, including stdio
// ones (npx, python, .exe) a browser can't start. It needs `npm install` once;
// the servers are kept in mcp-servers.json.
// Settings come from config.js (environment or .env; see .env.example), never
// from this file. With ANTHROPIC_API_KEY set, POST /anthropic/v1/messages
// relays the page's Anthropic requests and adds the key, so the page needs none.
// POST /agent-tools serves the agent services' tools (sandbox containers with
// diff review, headless browser) as MCP JSON-RPC; see agent-services.js. Pass a
// project folder (node server.js C:\path\to\project) or set CODEV_WORKSPACE
// to give them one. Run `npm run setup` first to check Docker and get Chromium.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadConfig, describeConfig, ensureDataDirs } = require('./config');
const { loadServices } = require('./agent-services');
const { checkDocker } = require('./scripts/checks');

const config = loadConfig();
const fatal = config.problems.filter(problem => problem.level === 'error');
if (fatal.length) {
    // A key is set but malformed, or PORT is wrong: stop now rather than fail later.
    fatal.forEach(problem => console.error(problem.message));
    process.exit(1);
}
config.problems.forEach(problem => console.warn(`Note: ${problem.message}`));
const anthropic = config.keys.anthropic ? { key: config.keys.anthropic } : {
    error: 'ANTHROPIC_API_KEY is not set. Put it in a .env file next to server.js '
        + '(copy .env.example) or set it in your environment, then restart.'
};
if (anthropic.error) console.warn(`Note: ${anthropic.error}`);

const PORT = config.port;
const ROOT = path.join(__dirname, 'mobile', 'www');
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8'
};

const MCP_CONFIG_FILE = path.join(__dirname, 'mcp-servers.json');
// Filled in once listening, since PORT=0 means "any free port".
let OWN_ORIGINS = [];
let mcpHub = null;

// The agent services need Docker's state and the data folder before they start.
// Requests that arrive first wait for this.
const agentServices = (async () => {
    config.docker = await checkDocker();
    const dirError = ensureDataDirs(config);
    if (dirError) console.warn(`Note: ${dirError}`);
    return loadServices(config);
})().catch(err => {
    console.error(`Agent tools are off: ${err.message}`);
    return null;
});

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function isOwnPageRequest(req) {
    return req.method === 'POST' && OWN_ORIGINS.includes(req.headers.origin) && OWN_ORIGINS.includes(`http://${req.headers.host}`)
        && String(req.headers['content-type'] || '').startsWith('application/json');
}

function readJsonBody(req, res, onMessage, { allowEmpty = false } = {}) {
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
        let message;
        if (allowEmpty && !body.trim()) message = {};
        else try { message = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad JSON' }); }
        try { await onMessage(message); } catch (err) {
            if (!res.headersSent) sendJson(res, 500, { error: err.message });
        }
    });
}

// Agents' tools run commands and drive a browser, so only CoDev's own page may
// call them, with the same checks as /mcp-hub. Notifications get 202, no body.
function handleAgentTools(req, res) {
    if (!isOwnPageRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    readJsonBody(req, res, async message => {
        const router = await agentServices;
        if (!router) return sendJson(res, 503, { error: 'Agent tools failed to start; see the server window.' });
        const reply = await router.handle(message);
        if (reply === null) { res.writeHead(202); return res.end(); }
        sendJson(res, 200, reply);
    });
}

// The page's own calls to the services: REST under /agent/ (the sandbox's
// review gate, where approve writes to the real disk) and exact routes such as
// the browser's login approvals. Agents never reach these. A GET carries no
// Origin from a same-origin fetch, so it is checked by Host and Sec-Fetch-Site;
// anything else needs CoDev's Origin, and a body must be JSON.
function isOwnPageCall(req) {
    if (!OWN_ORIGINS.includes(`http://${req.headers.host}`)) return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    if (req.method === 'GET' || req.method === 'HEAD') return !req.headers.origin || OWN_ORIGINS.includes(req.headers.origin);
    if (!OWN_ORIGINS.includes(req.headers.origin)) return false;
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    return !hasBody || String(req.headers['content-type'] || '').startsWith('application/json');
}

async function handleServiceRoute(req, res, url) {
    const router = await agentServices;
    if (!router) return false;
    const pathname = url.pathname;
    const route = router.routes.get(`${req.method} ${pathname}`);
    const isAgentPath = pathname.startsWith('/agent/');
    if (!route && !isAgentPath) return false;
    if (!isOwnPageCall(req)) { sendJson(res, 403, { error: 'Forbidden' }); return true; }
    const respond = async body => {
        if (route) {
            const reply = await route.handler(req, res, body);
            if (!res.headersSent && !res.writableEnded) sendJson(res, 200, reply === undefined ? {} : reply);
            return;
        }
        const reply = await router.handleRequest(req.method, pathname, Object.fromEntries(url.searchParams), body);
        if (reply) sendJson(res, reply.status || 200, reply.body === undefined ? {} : reply.body);
        else sendJson(res, 404, { error: `No agent service handles ${req.method} ${pathname}` });
    };
    if (req.method === 'GET' || req.method === 'HEAD') respond({});
    else readJsonBody(req, res, respond, { allowEmpty: true });
    return true;
}

// What is on, for the page and for anyone debugging: never key values.
async function agentStatus() {
    const router = await agentServices;
    const services = router ? router.status() : {};
    const browser = services.browser || { available: false, detail: 'not installed' };
    return {
        docker: { available: config.docker.available, version: config.docker.version, ...(config.docker.available ? {} : { error: config.docker.detail }) },
        browser: { available: Boolean(browser.available), ...(browser.available ? {} : { error: browser.detail }) },
        workspace: config.workspace.root,
        keys: config.keyStates,
        services
    };
}

function handleMcpHub(req, res) {
    // This endpoint starts programs, so only CoDev's own page may call it: other
    // websites (Origin) and DNS-rebinding tricks (Host) are turned away, and the
    // JSON content type means a browser preflights, which is never allowed here.
    if (!isOwnPageRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (!mcpHub) {
        try {
            const { createNodeMcpHub } = require('./desktop/mcp-hub');
            mcpHub = createNodeMcpHub({
                readConfig: () => { try { return fs.readFileSync(MCP_CONFIG_FILE, 'utf8'); } catch { return '{}'; } },
                writeConfig: config => fs.writeFileSync(MCP_CONFIG_FILE, config)
            });
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND') throw err;
            return sendJson(res, 501, { error: 'MCP servers need the MCP SDK: run "npm install" in the CoDev folder, then restart.' });
        }
    }
    readJsonBody(req, res, async message => sendJson(res, 200, await mcpHub.handle(message)));
}

// Only CoDev's own page may spend the key: same Origin/Host/content-type checks
// as /mcp-hub. The key is added here and never sent to the page.
function handleAnthropicRelay(req, res) {
    if (!isOwnPageRequest(req)) return sendJson(res, 403, { error: { message: 'Forbidden' } });
    if (!anthropic.key) return sendJson(res, 503, { error: { message: anthropic.error } });
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return req.destroy();
        chunks.push(chunk);
    });
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        const upstream = https.request('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json', 'content-length': body.length,
                'x-api-key': anthropic.key, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
            }
        }, reply => {
            res.writeHead(reply.statusCode, { 'Content-Type': reply.headers['content-type'] || 'application/json' });
            reply.pipe(res);
        });
        upstream.on('error', err => sendJson(res, 502, { error: { message: `Couldn't reach api.anthropic.com from this computer (${err.message}).` } }));
        upstream.end(body);
    });
}

const server = http.createServer(async (req, res) => {
    if (req.url === '/mcp-hub') return handleMcpHub(req, res);
    if (req.url === '/anthropic/status') return sendJson(res, 200, { available: Boolean(anthropic.key) });
    if (req.url === '/anthropic/v1/messages') return handleAnthropicRelay(req, res);
    if (req.url === '/agent-tools') return handleAgentTools(req, res);
    if (req.url === '/agent/status') {
        if (req.method !== 'GET' || !isOwnPageCall(req)) return sendJson(res, 403, { error: 'Forbidden' });
        return sendJson(res, 200, await agentStatus());
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { url = new URL('http://localhost/'); }
    if (await handleServiceRoute(req, res, url)) return;
    let urlPath;
    try { urlPath = decodeURIComponent(url.pathname); } catch { urlPath = '/'; }
    const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    // Never serve anything outside mobile/www.
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other program or run: set PORT=3001 && npm start`);
    else console.error(err.message);
    process.exit(1);
});

// 127.0.0.1 only: nothing outside this computer can open it.
server.listen(PORT, '127.0.0.1', () => {
    const port = server.address().port;
    OWN_ORIGINS = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
    console.log(`CoDev Studio is running at http://localhost:${port} (Ctrl+C to stop)`);
    describeConfig(config).forEach(line => console.log(`  ${line}`));
    agentServices.then(router => {
        if (!router) return;
        console.log(`  ${config.docker.detail}`);
        for (const [name, state] of Object.entries(router.status())) console.log(`  Agent ${name}: ${state.available ? 'on' : 'off'}${state.detail ? ` - ${state.detail}` : ''}`);
    });
});

// Ctrl+C also stops the MCP servers the hub started, and removes the agents'
// containers and browser profiles.
let stopping = false;
async function shutdown() {
    if (stopping) return process.exit(1); // second Ctrl+C: don't wait
    stopping = true;
    const router = await agentServices;
    await Promise.all([mcpHub && mcpHub.close(), router && router.close()]);
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// For tests that require() this file: the server and its agent services.
module.exports = { server, agentServices };
