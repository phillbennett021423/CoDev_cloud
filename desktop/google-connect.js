// The user's Google account for CoDev's Google tools (YouTube, Maps, Gmail,
// Drive; see mobile/www/agent-ui/google-apps.js). Used by server.js (POST
// /google) and the Windows app (IPC codev:google), so the page never holds the
// sign-in's refresh token unless the user copies it to a phone.
//
// Sign-in is Google's flow for installed apps: the user's own "Desktop app"
// OAuth client, PKCE, and a one-time listener on 127.0.0.1 for the redirect.
// The account (client, refresh token, scopes, email) is kept in tokenFile.
//
// handle(req) takes the page's requests:
//   { op: "status" }                               -> { signedIn, email, scopes, apiKey, clientId }
//   { op: "signin", clientId?, clientSecret?, allowWrite? } -> { url } (open it; status shows when done)
//   { op: "signout" }                              -> { ok }
//   { op: "link" }                                 -> { code } for the phone (the user asked for it)
//   { op: "request", method, url, headers?, body?, auth: "user" | "key", apiKey? } -> { status, body }
// Requests only go to Google's API hosts, with the account's token or the API key added here.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const API_HOSTS = new Set([
    'www.googleapis.com', 'gmail.googleapis.com', 'youtube.googleapis.com',
    'places.googleapis.com', 'routes.googleapis.com', 'maps.googleapis.com'
]);
// Read-only unless the user turns on sending and saving; then Gmail send and
// Drive's per-file scope (only files CoDev creates) are added.
const READ_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly'];
const WRITE_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/drive.file'];
const PASS_HEADERS = new Set(['content-type', 'x-goog-fieldmask']);
const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function isGoogleApiUrl(address) {
    let url;
    try { url = new URL(address); } catch { return false; }
    return url.protocol === 'https:' && API_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port;
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// tokenFile: where the account is kept. protect/unprotect: optional encryption
// (the Windows app uses safeStorage). env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_API_KEY from config.js. openExternal: opens the sign-in page itself (Windows app).
function createGoogleConnect({ tokenFile, env = {}, protect = s => s, unprotect = s => s, openExternal = null, fetchImpl = fetch, log = () => {} }) {
    let account = null;
    let accessToken = null; // { token, expiresAt }
    let pending = null;     // the sign-in in progress: { server, timer }

    try { account = JSON.parse(unprotect(fs.readFileSync(tokenFile, 'utf8'))); } catch { account = null; }

    function saveAccount(next) {
        account = next;
        accessToken = null;
        if (!next) { fs.rmSync(tokenFile, { force: true }); return; }
        fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
        fs.writeFileSync(tokenFile, protect(JSON.stringify(next)), { mode: 0o600 });
    }

    function status() {
        return {
            signedIn: Boolean(account && account.refreshToken),
            email: account?.email || null,
            scopes: account?.scopes || [],
            apiKey: Boolean(env.apiKey),
            clientId: Boolean(env.clientId || account?.clientId),
            signingIn: Boolean(pending)
        };
    }

    async function postForm(url, fields) {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
            signal: AbortSignal.timeout(15000)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`Google said: ${data.error_description || data.error || `HTTP ${response.status}`}`);
        return data;
    }

    async function getAccessToken() {
        if (!account?.refreshToken) throw new Error('CoDev is not signed in to Google. Open Settings > Google apps and press "Sign in with Google".');
        if (accessToken && accessToken.expiresAt > Date.now() + 60000) return accessToken.token;
        let data;
        try {
            data = await postForm(TOKEN_URL, {
                client_id: account.clientId, client_secret: account.clientSecret || '',
                refresh_token: account.refreshToken, grant_type: 'refresh_token'
            });
        } catch (err) {
            // invalid_grant: revoked, or a "Testing" client's week-old sign-in.
            if (/invalid_grant|expired|revoked/i.test(err.message)) {
                saveAccount(null);
                throw new Error('The Google sign-in expired or was removed. Sign in again in Settings > Google apps.');
            }
            throw err;
        }
        accessToken = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
        return accessToken.token;
    }

    function stopPending() {
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.server.close();
        pending = null;
    }

    async function signIn({ clientId, clientSecret, allowWrite } = {}) {
        clientId = String(clientId || env.clientId || '').trim();
        clientSecret = String(clientSecret || env.clientSecret || '').trim();
        if (!clientId) throw new Error('Add your Google OAuth client ID first (Settings > Google apps). The setup guide shows how to make one.');
        stopPending();
        const verifier = b64url(crypto.randomBytes(48));
        const state = b64url(crypto.randomBytes(24));
        const scopes = allowWrite ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES;
        const server = http.createServer();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const page = (res, status, text) => {
            res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><title>CoDev</title><body style="font-family:sans-serif;padding:40px"><h2>${text}</h2><p>You can close this tab and go back to CoDev.</p></body>`);
        };
        server.on('request', async (req, res) => {
            const url = new URL(req.url, redirectUri);
            if (url.pathname !== '/') return page(res, 404, 'Not found');
            if (url.searchParams.get('state') !== state) return page(res, 400, 'This sign-in link is out of date. Start again from CoDev.');
            if (url.searchParams.get('error')) {
                stopPending();
                return page(res, 200, `Google sign-in was cancelled (${url.searchParams.get('error')}).`);
            }
            try {
                const tokens = await postForm(TOKEN_URL, {
                    code: url.searchParams.get('code') || '', client_id: clientId, client_secret: clientSecret,
                    redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier
                });
                if (!tokens.refresh_token) throw new Error('Google sent no refresh token. Remove CoDev at myaccount.google.com/permissions and sign in again.');
                let email = null;
                try {
                    const who = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) });
                    email = (await who.json()).email || null;
                } catch { /* the account still works without the address */ }
                saveAccount({ clientId, clientSecret, refreshToken: tokens.refresh_token, scopes: String(tokens.scope || scopes.join(' ')).split(' '), email });
                accessToken = { token: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
                log(`Signed in to Google${email ? ` as ${email}` : ''}.`);
                page(res, 200, `CoDev is connected to Google${email ? ` as ${email}` : ''}.`);
            } catch (err) {
                page(res, 500, `Sign-in didn't finish: ${err.message.replace(/[<>&]/g, '')}`);
            }
            stopPending();
        });
        pending = { server, timer: setTimeout(stopPending, SIGNIN_TIMEOUT_MS) };
        const url = `${AUTH_URL}?${new URLSearchParams({
            client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
            code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
            state, access_type: 'offline', prompt: 'consent'
        })}`;
        if (openExternal) await openExternal(url);
        return { url, opened: Boolean(openExternal) };
    }

    async function signOut() {
        stopPending();
        if (account?.refreshToken) {
            try { await postForm(REVOKE_URL, { token: account.refreshToken }); } catch (err) { log(`Revoking the Google sign-in: ${err.message}`); }
        }
        saveAccount(null);
        return { ok: true };
    }

    async function request({ method = 'GET', url, headers = {}, body, auth = 'user', apiKey } = {}) {
        if (!isGoogleApiUrl(url)) throw new Error('CoDev only sends Google requests to Google\'s API addresses.');
        method = String(method).toUpperCase();
        if (!['GET', 'POST', 'PATCH'].includes(method)) throw new Error(`${method} isn't allowed.`);
        const sendHeaders = {};
        for (const [name, value] of Object.entries(headers || {})) if (PASS_HEADERS.has(name.toLowerCase())) sendHeaders[name] = String(value);
        const target = new URL(url);
        if (auth === 'key') {
            const key = String(apiKey || env.apiKey || '').trim();
            if (!key) throw new Error('No Google API key. Add one in Settings > Google apps (the setup guide shows how).');
            target.searchParams.set('key', key);
        } else {
            sendHeaders.Authorization = `Bearer ${await getAccessToken()}`;
        }
        const payload = body === undefined || body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        if (payload !== undefined && !Object.keys(sendHeaders).some(h => h.toLowerCase() === 'content-type')) sendHeaders['Content-Type'] = 'application/json';
        const response = await fetchImpl(target, { method, headers: sendHeaders, body: payload, signal: AbortSignal.timeout(30000) });
        const type = response.headers.get('content-type') || '';
        const buffer = Buffer.from(await response.arrayBuffer());
        const text = buffer.subarray(0, MAX_BODY_BYTES).toString('utf8');
        let parsed = text;
        if (/json/i.test(type)) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
        return { status: response.status, contentType: type, body: parsed, truncated: buffer.length > MAX_BODY_BYTES };
    }

    async function handle(req = {}) {
        try {
            switch (req.op) {
                case 'status': return status();
                case 'signin': return await signIn(req);
                case 'signout': return await signOut();
                case 'link':
                    if (!account?.refreshToken) return { error: 'Sign in to Google on this computer first.' };
                    return { code: Buffer.from(JSON.stringify(account)).toString('base64') };
                case 'request': return await request(req);
                default: return { error: 'Unknown Google request.' };
            }
        } catch (err) {
            return { error: err.name === 'TimeoutError' ? 'Google took too long to answer.' : err.message };
        }
    }

    return { handle, status, close: stopPending };
}

module.exports = { createGoogleConnect, isGoogleApiUrl, READ_SCOPES, WRITE_SCOPES };
