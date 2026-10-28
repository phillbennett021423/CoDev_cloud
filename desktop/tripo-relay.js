// Tripo 3D for the page served by server.js and for the Windows app. Tripo's API
// doesn't answer browser pages (CORS), so they pass each call through here. The
// page sends the user's own key with every call; nothing is kept on this side.
//   { op: "api", key, method, path, body }        -> { status, body }
//   { op: "upload", key, name, type, base64 }      -> { status, body }
//   { op: "download", url }                        -> { status, contentType, base64 }
// Only Tripo's API is called with the key. Downloads (the finished models, which
// sit on Tripo's CDN for a few minutes) go to public https addresses only.
const TRIPO_API = 'https://openapi.tripo3d.com/v3';
const API_PATH = /^\/(generation\/[a-z-]+|tasks\/[\w-]+|account\/balance|files)$/;
const TIMEOUT_MS = 60000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

// The same check as web-fetch.js: never this computer or the local network.
function isPublicHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host) || host.startsWith('::ffff:')) return false;
    return true;
}

async function readJson(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

async function callApi({ key, method, path, body }) {
    if (!API_PATH.test(String(path || ''))) return { error: 'That Tripo address is not allowed.' };
    const verb = method === 'POST' ? 'POST' : 'GET';
    const response = await fetch(TRIPO_API + path, {
        method: verb,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${key}`, ...(verb === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        body: verb === 'POST' ? JSON.stringify(body || {}) : undefined
    });
    return { status: response.status, body: await readJson(response) };
}

async function upload({ key, name, type, base64 }) {
    const bytes = Buffer.from(String(base64 || ''), 'base64');
    if (!bytes.length) return { error: 'No picture to upload.' };
    if (bytes.length > MAX_UPLOAD_BYTES) return { error: 'The picture is over Tripo\'s 20 MB limit.' };
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: /^image\/(png|jpeg)$/.test(type) ? type : 'image/png' }), String(name || 'picture.png').replace(/[^\w.-]+/g, '_'));
    const response = await fetch(`${TRIPO_API}/files`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${key}` },
        body: form
    });
    return { status: response.status, body: await readJson(response) };
}

async function download({ url }, redirects = 4) {
    let address;
    try { address = new URL(String(url || '')); } catch { return { error: 'Not a web address.' }; }
    if (address.protocol !== 'https:' || !isPublicHost(address.hostname)) return { error: 'Only public https addresses can be downloaded.' };
    const response = await fetch(address, { redirect: 'manual', signal: AbortSignal.timeout(3 * TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (!redirects) return { error: 'Too many redirects.' };
        return download({ url: new URL(response.headers.get('location'), address).href }, redirects - 1);
    }
    const size = Number(response.headers.get('content-length')) || 0;
    if (size > MAX_DOWNLOAD_BYTES) return { error: 'The model is over 200 MB.' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) return { error: 'The model is over 200 MB.' };
    return { status: response.status, contentType: response.headers.get('content-type') || '', base64: bytes.toString('base64') };
}

async function handleTripoRequest(message) {
    try {
        const op = message && message.op;
        if (op === 'download') return await download(message);
        const key = String(message && message.key || '').trim();
        if (!key || /\s/.test(key)) return { error: 'No Tripo API key.' };
        if (op === 'api') return await callApi({ ...message, key });
        if (op === 'upload') return await upload({ ...message, key });
        return { error: 'Unknown request.' };
    } catch (err) {
        return { error: err.name === 'TimeoutError' ? 'Tripo took too long to answer.' : `Couldn't reach Tripo (${err.message}).` };
    }
}

module.exports = { handleTripoRequest };
