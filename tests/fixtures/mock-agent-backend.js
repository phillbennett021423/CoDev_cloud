// A stand-in for server.js's agent services, for testing the page without Docker:
// serves mobile/www and the same /agent/* review routes and /agent-tools MCP
// endpoint as desktop/sandbox, backed by an in-memory staging copy of a real
// folder. Approve writes to that folder, so a test can check what reached disk.
// Syntax checks: .js through vm.Script, .json through JSON.parse. hubTools stands
// in for MCP servers from Settings (POST /mcp-hub), such as the Python helper.
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const WWW = path.join(__dirname, '..', '..', 'mobile', 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

function walk(root, dir = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(root, rel));
        else out.push(rel);
    }
    return out;
}

function lines(text) {
    if (!text) return [];
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
}

// One hunk replacing the whole file: valid unified diff, good enough for a mock.
function unifiedDiff(rel, oldText, newText) {
    const a = oldText === null ? [] : lines(oldText);
    const b = newText === null ? [] : lines(newText);
    const head = [`diff --git a/${rel} b/${rel}`];
    if (oldText === null) head.push('new file mode 100644');
    if (newText === null) head.push('deleted file mode 100644');
    head.push(`--- ${oldText === null ? '/dev/null' : `a/${rel}`}`, `+++ ${newText === null ? '/dev/null' : `b/${rel}`}`);
    head.push(`@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`);
    return [...head, ...a.map(l => `-${l}`), ...b.map(l => `+${l}`)].join('\n') + '\n';
}

function syntaxCheck(rel, text) {
    if (text === null) return { name: 'syntax', ok: true, skipped: true, message: 'Deleted.' };
    try {
        if (rel.endsWith('.js')) new vm.Script(text, { filename: rel });
        else if (rel.endsWith('.json')) JSON.parse(text);
        else return { name: 'syntax', ok: true, skipped: true, message: 'No checker for this file type.' };
        return { name: 'syntax', ok: true, message: 'Passed.' };
    } catch (err) {
        return { name: 'syntax', ok: false, message: err.message };
    }
}

// agentTools: more /agent-tools tools, name -> (box, args, agentId) => text (e.g. an Outlier stand-in).
// google: optional handler for POST /google (a desktop/google-connect.js handle()).
function createMockBackend({ workspace, docker = false, hubTools = [], agentTools = {}, google = null } = {}) {
    const sandboxes = new Map(); // id -> { id, agents:Set, files: Map(rel -> text|null), base: Map }
    const changesets = new Map();
    const log = [];
    const hubCalls = [];

    function handleHub(req) {
        if (req.op === 'listTools') return { result: hubTools };
        if (req.op === 'callTool') {
            hubCalls.push({ server: req.server, name: req.name, arguments: req.arguments });
            return { result: { content: [{ type: 'text', text: `ran ${req.name}` }] } };
        }
        if (req.op === 'status') return { result: [] };
        return { result: req.op === 'listResources' ? [] : null };
    }

    function boxFor(id) {
        const box = sandboxes.get(id);
        if (!box) throw Object.assign(new Error(`No sandbox "${id}"`), { status: 404 });
        return box;
    }

    function openBox(id, agentId) {
        let box = sandboxes.get(id);
        if (!box) {
            const base = new Map(walk(workspace).map(rel => [rel, fs.readFileSync(path.join(workspace, rel), 'utf8')]));
            box = { id, agents: new Set(), files: new Map(base), base, deleted: false };
            sandboxes.set(id, box);
        }
        box.agents.add(agentId);
        return box;
    }

    function safeRel(rel) {
        const clean = path.posix.normalize(String(rel || '').replace(/\\/g, '/')).replace(/^\/+/, '');
        if (!clean || clean.startsWith('..')) throw Object.assign(new Error(`'${rel}' is outside the project`), { status: 400 });
        return clean;
    }

    function changes(box) {
        const out = [];
        const all = new Set([...box.base.keys(), ...box.files.keys()]);
        for (const rel of [...all].sort()) {
            const before = box.base.has(rel) ? box.base.get(rel) : null;
            const after = box.files.has(rel) ? box.files.get(rel) : null;
            if (before === after) continue;
            out.push({ rel, before, after, status: before === null ? 'added' : after === null ? 'deleted' : 'modified' });
        }
        return out;
    }

    function stage(box) {
        const files = changes(box).map(c => {
            const diff = unifiedDiff(c.rel, c.before, c.after);
            return { path: c.rel, status: c.status, additions: lines(c.after || '').length, deletions: lines(c.before || '').length, diff, checks: [syntaxCheck(c.rel, c.after)] };
        });
        for (const [id, set] of changesets) if (set.sandboxId === box.id && set.status === 'pending') changesets.delete(id);
        const set = { id: crypto.randomBytes(6).toString('hex'), sandboxId: box.id, agentId: [...box.agents][0], status: 'pending', createdAt: Date.now(), submission: box.submission || null, diff: files.map(f => f.diff).join(''), files };
        if (files.length) changesets.set(set.id, set);
        return set;
    }

    const TOOLS = {
        list_files: (box) => [...box.files.keys()].filter(k => box.files.get(k) !== null).sort().join('\n') || 'The folder is empty.',
        read_file: (box, { path: rel }) => {
            const text = box.files.get(safeRel(rel));
            if (typeof text !== 'string') throw new Error(`No file at '${rel}'`);
            return text;
        },
        search_files: (box, { query }) => {
            const hits = [];
            for (const [rel, text] of box.files) if (typeof text === 'string') text.split('\n').forEach((l, i) => { if (l.toLowerCase().includes(String(query).toLowerCase())) hits.push(`${rel}:${i + 1}: ${l.trim()}`); });
            return hits.join('\n') || `No matches for "${query}".`;
        },
        write_file: (box, { path: rel, content }) => { box.files.set(safeRel(rel), String(content)); return `Staged ${rel}.`; },
        edit_file: (box, { path: rel, old_text: oldText, new_text: newText }) => {
            const key = safeRel(rel);
            const text = box.files.get(key);
            if (typeof text !== 'string' || text.split(oldText).length !== 2) throw new Error('old_text must appear exactly once');
            box.files.set(key, text.replace(oldText, () => newText));
            return `Edited ${rel}.`;
        },
        delete_file: (box, { path: rel }) => { box.files.set(safeRel(rel), null); return `Deleted ${rel}.`; },
        sandbox_diff: (box) => stage(box).diff || 'No changes staged yet.',
        submit_changes: (box, { summary }, agentId) => { box.submission = { agent: agentId, summary: String(summary || '') }; return 'Submitted for review.'; },
        ...agentTools
    };

    function handleMcp(msg) {
        const ok = result => ({ jsonrpc: '2.0', id: msg.id, result });
        if (msg.method === 'initialize') return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-agent-tools', version: '1' } });
        if (msg.method === 'tools/list') return ok({ tools: Object.keys(TOOLS).map(name => ({ name, description: `mock ${name}`, inputSchema: { type: 'object', properties: {} } })) });
        if (msg.method === 'tools/call') {
            const meta = msg.params._meta || {};
            const agentId = meta['codev/agentId'] || meta['codev/agent'];
            log.push({ tool: msg.params.name, args: msg.params.arguments, agentId, workspace: meta['codev/workspace'] });
            try {
                const box = openBox(meta['codev/workspace'], agentId);
                return ok({ content: [{ type: 'text', text: TOOLS[msg.params.name](box, msg.params.arguments || {}, agentId) }], isError: false });
            } catch (err) {
                return ok({ content: [{ type: 'text', text: err.message }], isError: true });
            }
        }
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
    }

    function handleRequest(method, pathname, query, body) {
        const [, area, id, action] = pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (area === 'status') return [200, { docker: { available: docker, version: docker ? 'mock' : undefined, error: docker ? undefined : 'mock: no Docker' }, browser: { available: false }, workspace, services: { sandbox: { available: true, detail: 'mock' } } }];
        if (area === 'sandboxes' && !id && method === 'POST') {
            const box = openBox(body.workspace || `${body.agentId}-${crypto.randomBytes(2).toString('hex')}`, String(body.agentId));
            return [201, { id: box.id, agentId: body.agentId, image: 'mock', scratchpad: '/workspace', container: { running: docker } }];
        }
        if (area === 'sandboxes') {
            const box = boxFor(id);
            if (!action && method === 'DELETE') {
                box.deleted = true;
                if (![...changesets.values()].some(s => s.sandboxId === id && s.status === 'pending')) sandboxes.delete(id);
                return [200, { ok: true }];
            }
            if (action === 'stage' && method === 'POST') return [200, stage(box)];
            if (action === 'files' && method === 'POST') { TOOLS.write_file(box, body); return [200, { ok: true }]; }
            if (action === 'files' && method === 'GET') return [200, { path: query.path, content: TOOLS.read_file(box, query) }];
        }
        if (area === 'changes' && !id && method === 'GET') return [200, [...changesets.values()].filter(s => s.status === 'pending')];
        if (area === 'changes') {
            const set = changesets.get(id);
            if (!set) return [404, { error: 'No such change set.' }];
            if (!action && method === 'GET') return [200, set];
            if (set.status !== 'pending') return [409, { error: `This change set was already ${set.status}.` }];
            const box = sandboxes.get(set.sandboxId);
            if (action === 'approve') {
                const passed = set.files.filter(f => f.checks.every(c => c.ok));
                const wanted = Array.isArray(body.paths) ? body.paths : passed.map(f => f.path);
                const written = [];
                const skipped = [];
                for (const rel of wanted) {
                    const file = set.files.find(f => f.path === rel);
                    if (!file) { skipped.push({ path: rel, reason: 'not part of this change set' }); continue; }
                    if (!file.checks.every(c => c.ok)) { skipped.push({ path: rel, reason: 'checks failed' }); continue; }
                    const target = path.join(workspace, safeRel(rel));
                    const text = box.files.get(rel);
                    if (text === null) fs.rmSync(target, { force: true });
                    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
                    box.base.set(rel, text);
                    written.push(rel);
                }
                set.status = 'approved';
                set.result = { written, skipped };
                if (!changes(box).length || box.deleted) sandboxes.delete(box.id);
                return [200, set.result];
            }
            if (action === 'reject') {
                set.status = 'rejected';
                for (const f of set.files) box.files.set(f.path, box.base.has(f.path) ? box.base.get(f.path) : null);
                sandboxes.delete(box.id);
                return [200, { ok: true }];
            }
        }
        return [404, { error: `Mock has no ${method} ${pathname}` }];
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'Bad JSON' }); }
            if (url.pathname === '/anthropic/status') return send(200, { available: false });
            if (url.pathname === '/agent-tools') return send(200, handleMcp(body));
            if (url.pathname === '/mcp-hub') return send(200, handleHub(body));
            if (url.pathname === '/google' && google) return Promise.resolve(google(body)).then(reply => send(200, reply), err => send(500, { error: err.message }));
            if (url.pathname.startsWith('/agent/')) {
                try {
                    const [status, payload] = handleRequest(req.method, url.pathname, Object.fromEntries(url.searchParams), body);
                    return send(status, payload);
                } catch (err) {
                    return send(err.status || 500, { error: err.message });
                }
            }
            const file = path.join(WWW, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
            if (!file.startsWith(WWW)) return send(403, { error: 'Forbidden' });
            fs.readFile(file, (err, data) => {
                if (err) { res.writeHead(404); return res.end('Not found'); }
                res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
                res.end(data);
            });
        });
    });

    return {
        server, log, hubCalls, sandboxes, changesets,
        listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://localhost:${server.address().port}`))),
        // Pages left open keep connections alive, so those are cut instead of waited for.
        close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
    };
}

module.exports = { createMockBackend };
