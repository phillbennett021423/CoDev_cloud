// An in-memory stand-in for the bits of GitHub's REST API that cloud runs use
// (contents, refs, workflow dispatch), so the queue and the runner can be tested
// with no token or network. handle() answers one request; fetch is a drop-in
// for the global fetch; route() serves it to a Playwright page.
const crypto = require('crypto');

function createGitHubMock({ repo = 'owner/codev', branch = 'agent-queue' } = {}) {
    const files = new Map();   // path -> { sha, bytes }
    const dispatches = [];
    let hasBranch = false;
    const sha = bytes => crypto.createHash('sha1').update(bytes).update(String(Math.random())).digest('hex');
    const reply = (status, body) => ({ status, body: body === undefined ? '' : JSON.stringify(body) });

    function handle(method, url, bodyText, accept = '') {
        const u = new URL(url, 'https://api.github.com');
        const p = decodeURIComponent(u.pathname);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const base = `/repos/${repo}`;
        if (p === base && method === 'GET') return reply(200, { full_name: repo, permissions: { push: true } });
        if (p === `${base}/git/ref/heads/${branch}`) return hasBranch ? reply(200, { ref: `refs/heads/${branch}` }) : reply(404, { message: 'Not Found' });
        if (p === `${base}/git/trees` && method === 'POST') {
            for (const f of body.tree) files.set(f.path, { sha: sha(f.content), bytes: Buffer.from(f.content) });
            return reply(201, { sha: 'tree1' });
        }
        if (p === `${base}/git/commits` && method === 'POST') return reply(201, { sha: 'commit1' });
        if (p === `${base}/git/refs` && method === 'POST') { hasBranch = true; return reply(201, { ref: body.ref }); }
        const dispatch = p.match(new RegExp(`^${base}/actions/workflows/([^/]+)/dispatches$`));
        if (dispatch && method === 'POST') { dispatches.push({ workflow: dispatch[1], ref: body.ref }); return reply(204); }
        if (/\/actions\/workflows\/[^/]+\/runs$/.test(p)) return reply(200, { total_count: 0, workflow_runs: [] });
        const contents = p.match(new RegExp(`^${base}/contents/(.+)$`));
        if (contents) {
            const filePath = contents[1];
            if (method === 'GET') {
                if (!hasBranch) return reply(404, { message: 'No commit found for the ref' });
                const file = files.get(filePath);
                if (file) {
                    if (accept.includes('raw')) return { status: 200, body: file.bytes.toString('utf8') };
                    // Like GitHub: over 1 MB the JSON form has no content.
                    const big = file.bytes.length > 1024 * 1024;
                    return reply(200, { type: 'file', path: filePath, sha: file.sha, size: file.bytes.length, content: big ? '' : file.bytes.toString('base64'), encoding: big ? 'none' : 'base64' });
                }
                const inside = [...files.entries()].filter(([k]) => k.startsWith(`${filePath}/`) && !k.slice(filePath.length + 1).includes('/'));
                if (inside.length) return reply(200, inside.map(([k, f]) => ({ type: 'file', name: k.split('/').pop(), path: k, sha: f.sha, size: f.bytes.length })));
                return reply(404, { message: 'Not Found' });
            }
            if (method === 'PUT') {
                const existing = files.get(filePath);
                if (existing && body.sha !== existing.sha) return reply(existing && !body.sha ? 422 : 409, { message: 'sha mismatch' });
                if (!existing && body.sha) return reply(409, { message: 'gone' });
                const bytes = Buffer.from(body.content, 'base64');
                const entry = { sha: sha(bytes), bytes };
                files.set(filePath, entry);
                return reply(existing ? 200 : 201, { content: { sha: entry.sha, path: filePath } });
            }
            if (method === 'DELETE') {
                const existing = files.get(filePath);
                if (!existing) return reply(404, { message: 'Not Found' });
                if (body.sha !== existing.sha) return reply(409, { message: 'sha mismatch' });
                files.delete(filePath);
                return reply(200, {});
            }
        }
        return reply(404, { message: `mock: no ${method} ${p}` });
    }

    const fetch = async (url, init = {}) => {
        const r = handle(init.method || 'GET', url, init.body, (init.headers || {}).Accept || '');
        return { ok: r.status < 300, status: r.status, text: async () => r.body };
    };

    const route = async route => {
        const req = route.request();
        const r = handle(req.method(), req.url(), req.postData(), req.headers().accept || '');
        await route.fulfill({ status: r.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: r.body });
    };

    return { handle, fetch, route, files, dispatches, read: p => (files.has(p) ? JSON.parse(files.get(p).bytes.toString('utf8')) : null) };
}

module.exports = { createGitHubMock };
