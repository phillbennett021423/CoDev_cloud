// Serves CoDev Studio on this computer: npm start, then open http://localhost:3000
// CoDev has no backend of its own. The page talks to Groq directly, and the
// optional search/commands helper lives in tools/ddgs-helper.
// POST /mcp-hub lets the page use MCP servers on this computer, including stdio
// ones (npx, python, .exe) a browser can't start. It needs `npm install` once;
// the servers are kept in mcp-servers.json.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'mobile', 'www');
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8'
};

const MCP_CONFIG_FILE = path.join(__dirname, 'mcp-servers.json');
const OWN_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
let mcpHub = null;

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function handleMcpHub(req, res) {
    // This endpoint starts programs, so only CoDev's own page may call it: other
    // websites (Origin) and DNS-rebinding tricks (Host) are turned away, and the
    // JSON content type means a browser preflights, which is never allowed here.
    if (req.method !== 'POST' || !OWN_ORIGINS.includes(req.headers.origin) || !OWN_ORIGINS.includes(`http://${req.headers.host}`)
        || !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return sendJson(res, 403, { error: 'Forbidden' });
    }
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
    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
        let message;
        try { message = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad JSON' }); }
        sendJson(res, 200, await mcpHub.handle(message));
    });
}

const server = http.createServer((req, res) => {
    if (req.url === '/mcp-hub') return handleMcpHub(req, res);
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { urlPath = '/'; }
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
    console.log(`CoDev Studio is running at http://localhost:${PORT} (Ctrl+C to stop)`);
});

// Ctrl+C also stops the MCP servers the hub started.
process.on('SIGINT', async () => {
    if (mcpHub) await mcpHub.close();
    process.exit(0);
});
