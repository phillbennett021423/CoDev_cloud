// What the user or an agent typed in an address bar -> the page to open, and a
// check that the page that loaded is the real site: not a DNS failure, an error
// page, or a parked "this domain is for sale" page (GoDaddy, Sedo, Afternic...),
// which is where a guessed or mistyped domain usually lands.

// Words that open a known site instead of a search.
const SHORTCUTS = {
    // Outlier's sign-in portal; signed in, it goes on to the app.
    outlier: 'https://app.outlier.bet/login',
    'outlier.bet': 'https://app.outlier.bet/login',
    'outlier login': 'https://app.outlier.bet/login',
    'outlierbet.com': 'https://app.outlier.bet/login',
    outlierbet: 'https://app.outlier.bet/login',
    espn: 'https://www.espn.com/',
    'the odds api': 'https://the-odds-api.com/',
    'odds api': 'https://the-odds-api.com/'
};
const SEARCH = 'https://duckduckgo.com/?q=';

// Wrong addresses for a known site, whatever the path: outlierbet.com (and
// outlier-bet, outlierbets...) is not Outlier, whose app is app.outlier.bet.
const REWRITES = [
    { host: /(^|\.)outlier-?bets?\.(com|net|io|co|app)$/i, url: 'https://app.outlier.bet/login' }
];

// url (a full address) -> the known site's real address when it's a wrong one, else as is.
function fixKnownAddress(url) {
    let host;
    try { host = new URL(url).hostname; } catch { return url; }
    const rewrite = REWRITES.find(r => r.host.test(host));
    return rewrite ? rewrite.url : url;
}

// "espn.com" -> https://espn.com/, "https://x.y/z" as is, anything else a search.
function resolveAddress(input, { shortcuts = SHORTCUTS } = {}) {
    const text = String(input || '').trim();
    if (!text) throw new Error('Type an address or something to search for.');
    const shortcut = shortcuts[text.toLowerCase()];
    if (shortcut) return { url: shortcut, how: 'shortcut' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s/:]+:\d+(\/|$)/.test(text)) {
        if (/^https?:\/\//i.test(text)) return { url: fixKnownAddress(new URL(text).href), how: 'address' };
        if (/^about:blank$/i.test(text)) return { url: 'about:blank', how: 'address' };
        throw new Error(`Only http:// and https:// pages open here, not ${text.split(':')[0]}:`);
    }
    // A host with a dot and no spaces (optionally a port and path) is an address.
    if (!/\s/.test(text) && /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})(:\d+)?([/?#].*)?$/i.test(text)) {
        return { url: fixKnownAddress(new URL(`https://${text}`).href), how: 'address' };
    }
    return { url: SEARCH + encodeURIComponent(text), how: 'search' };
}

const PARKED_HOSTS = /(^|\.)(sedoparking\.com|sedo\.com|parkingcrew\.net|bodis\.com|afternic\.com|dan\.com|hugedomains\.com|undeveloped\.com|above\.com|parklogic\.com|domainmarket\.com|buydomains\.com|brandbucket\.com|squadhelp\.com|atom\.com)$/i;
const PARKED_TEXT = [
    /this domain (name )?(is|may be) for sale/i,
    /\bbuy this domain\b/i,
    /\bdomain (is )?parked\b/i,
    /\bparked (free|domain|page)\b/i,
    /courtesy of godaddy|godaddy\.com\/forsale|get this domain/i,
    /this domain has expired/i,
    /\bmake an offer\b.{0,80}\bdomain\b/i,
    /\bthe domain .{1,60} (is|has been) registered\b/i
];

// page: a Playwright page after goto; response: what goto returned (may be null).
async function checkPage(page, response, { error } = {}) {
    if (error) {
        const msg = String(error.message || error);
        if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(msg)) return { ok: false, kind: 'dead', problem: "That address doesn't exist (no such domain)." };
        if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT/.test(msg)) return { ok: false, kind: 'dead', problem: "The site didn't answer." };
        if (/ERR_CERT|SSL/.test(msg)) return { ok: false, kind: 'dead', problem: 'The site has a broken security certificate.' };
        return { ok: false, kind: 'dead', problem: msg.split('\n')[0] };
    }
    let url;
    try { url = new URL(page.url()); } catch { url = null; }
    if (!url || url.protocol === 'chrome-error:') return { ok: false, kind: 'dead', problem: 'The page failed to load.' };
    if (PARKED_HOSTS.test(url.hostname)) return { ok: false, kind: 'parked', problem: `It redirected to ${url.hostname}, a domain-parking page.` };
    const status = response ? response.status() : 0;
    if (status === 404 || status === 410) return { ok: false, kind: 'dead', problem: `The page isn't there (HTTP ${status}).` };
    if (status >= 500) return { ok: false, kind: 'dead', problem: `The site returned an error (HTTP ${status}).` };
    const title = await page.title().catch(() => '');
    const body = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 4000)).catch(() => '');
    // Parked pages are short; a real site that mentions domains for sale isn't flagged.
    if (body.length < 3000 && PARKED_TEXT.some(re => re.test(`${title}\n${body}`))) {
        return { ok: false, kind: 'parked', problem: `${url.hostname} is a parked or for-sale domain, not a real site.` };
    }
    return { ok: true, status };
}

// One line for an agent or the user when a page is no good.
function advice(check, url) {
    if (check.ok) return '';
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    return `${check.problem} Don't use ${host}: search for the site's real address instead.`;
}

module.exports = { resolveAddress, fixKnownAddress, checkPage, advice, SHORTCUTS, SEARCH };
