// Web search and page reads for the page served by server.js. A browser tab can't
// fetch DuckDuckGo or most websites itself (CORS), so server.js does it here and
// hands the HTML back; the page parses it as it does on Android. Only public
// http(s) addresses are fetched, never this computer or the local network.
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const TIMEOUT_MS = 10000;
const MAX_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function isPublicHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host === '::1' || host === '::' || /^(fc|fd|fe80)/.test(host) || host.startsWith('::ffff:')) return false;
    return true;
}

// Fetches one public address (following redirects, each checked) and returns its text.
async function fetchText(address, redirects = 4) {
    let url;
    try { url = new URL(address); } catch { throw new Error(`"${address}" is not a web address.`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https addresses can be read.');
    if (!isPublicHost(url.hostname)) throw new Error('CoDev only reads public websites, not this computer or the local network.');
    const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (!redirects) throw new Error('Too many redirects.');
        return fetchText(new URL(response.headers.get('location'), url).href, redirects - 1);
    }
    const type = response.headers.get('content-type') || '';
    if (type && !/text|html|xml|json/i.test(type)) throw new Error(`That address is a ${type.split(';')[0]} file, not a page CoDev can read.`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size > MAX_BYTES) { await reader.cancel(); break; }
    }
    return { status: response.status, url: url.href, contentType: type, text: Buffer.concat(chunks).toString('utf8') };
}

// { kind: "search", query } or { kind: "page", url } -> { status, url, contentType, html } or { error }.
async function handleWebFetch(message) {
    try {
        if (message?.kind === 'search') {
            const query = String(message.query || '').trim().slice(0, 300);
            if (!query) return { error: 'No search query.' };
            const page = await fetchText(`${DDG_HTML_URL}?q=${encodeURIComponent(query)}&kl=us-en`);
            return { status: page.status, url: page.url, contentType: page.contentType, html: page.text };
        }
        if (message?.kind === 'page') {
            const page = await fetchText(String(message.url || ''));
            return { status: page.status, url: page.url, contentType: page.contentType, html: page.text };
        }
        return { error: 'Unknown request.' };
    } catch (err) {
        return { error: err.name === 'TimeoutError' ? 'The site took too long to answer.' : err.message };
    }
}

module.exports = { handleWebFetch, isPublicHost };
