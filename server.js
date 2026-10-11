const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const workspaceRoot = __dirname; // Locks execution right to your CoDev folder

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const data = body ? JSON.parse(body) : {};
            const targetPath = path.join(workspaceRoot, data.filename || '');

            // Security check to ensure it stays within the workspace
            if (!targetPath.startsWith(workspaceRoot)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Access denied: Outside workspace bounds' }));
                return;
            }

            if (req.url === '/api/read') {
                if (fs.existsSync(targetPath)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, content: fs.readFileSync(targetPath, 'utf8') }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'File not found' }));
                }
            } else if (req.url === '/api/write') {
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.writeFileSync(targetPath, data.content || '', 'utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `Successfully wrote file: ${data.filename}` }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Endpoint not found' }));
            }
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
    });
});
} else if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(htmlPath, 'utf8'));
            return;
        }
    }

server.listen(PORT, () => {
    console.log(`CoDev Local MCP Bridge running at http://localhost:${PORT}`);
});
server.listen(PORT, () => {
    console.log(`🚀 CoDev Local MCP Bridge running at http://localhost:${PORT}`);
});
