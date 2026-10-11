const http = require('http');
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', keyConfigured: !!OPENROUTER_API_KEY }));
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
});

server.listen(PORT, () => {
    console.log(`CoDev Cloud Server running at http://localhost:${PORT}`);
});
