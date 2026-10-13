// Serves CoDev Studio on this computer: npm start, then open http://localhost:3000
// CoDev has no backend of its own. The page talks to Groq directly, and the
// optional search/commands helper lives in tools/ddgs-helper.
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

const server = http.createServer((req, res) => {
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
