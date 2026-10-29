// CoDev's online server (a Cloudflare Worker with a D1 database).
//
// It holds the owner's API keys and forwards AI requests for signed-in accounts,
// so nobody else needs keys and the keys never reach their devices. Each account
// has a plan with limits (PLANS below); the owner's account has none.
//
//   POST /auth/start          {email}        emails a 6-digit sign-in code
//   POST /auth/verify         {email, code}  returns {token} for the Authorization header
//   POST /auth/signout
//   GET  /me                                 the account's plan, limits and usage today
//   POST /v1/groq/chat/completions           forwarded to Groq with the owner's key
//   POST /v1/openrouter/chat/completions     forwarded to OpenRouter
//   POST /v1/anthropic/messages              forwarded to Anthropic
//   /owner/...                               the Owner page (owner's account only)
//
// Every hour (the cron in wrangler.toml) the owner's API agent checks spending.
//
// Testers are a hidden plan: to everyone but the owner they look exactly like
// the Pro plan (same label, same limits), and nothing a user can reach names them.

import { COST_WEIGHTS, DEFAULT_SETTINGS, KEY_NAMES, planFor, publicPlan } from './plans.js';
import { AGENT_DEFAULTS, getAgent, saveAgent, runApiAgent, signupNotice } from './agents.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_DAYS = 90;
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const UPSTREAMS = {
    groq: { url: 'https://api.groq.com/openai/v1/chat/completions', key: 'groq' },
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: 'openrouter' },
    anthropic: { url: 'https://api.anthropic.com/v1/messages', key: 'anthropic' }
};
// Non-owner accounts are held to the cheap models: OpenRouter's free router costs
// nothing and Haiku is Anthropic's cheapest. The owner can use any model.
const FORCED_MODELS = { openrouter: 'openrouter/free', anthropic: 'claude-haiku-5-5' };
const MAX_ANTHROPIC_TOKENS = 16000;

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        try {
            return withCors(await route(request, env, ctx || { waitUntil() {} }));
        } catch (err) {
            if (err instanceof HttpError) return withCors(json(err.status, { error: { message: err.message, code: err.code } }));
            console.error(err);
            return withCors(json(500, { error: { message: "CoDev's server hit an error. Try again in a moment." } }));
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(runApiAgent(env, agentDeps(env), { now: event.scheduledTime || Date.now() }).catch(err => console.error('API agent failed', err)));
    }
};

// What the owner's agents (agents.js) may use: numbers and the owner's email, nothing else.
function agentDeps(env) {
    return {
        getSecret: name => getSecret(env, name),
        getSettings: () => getSettings(env),
        sharedChatTotal: day => sharedChatTotal(env, day),
        emailOwner: async (subject, text) => {
            const to = ownerEmails(env)[0];
            if (to) await sendEmail(env, to, subject, text);
        }
    };
}

// Sign-in is a bearer token, never a cookie, so any origin may call (the Android
// app, the Windows app and the local page all have different ones).
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, anthropic-version',
    'Access-Control-Max-Age': '86400'
};

class HttpError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function withCors(response) {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
}

function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function route(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if (path === '/' || path === '/health') return json(200, { ok: true, service: 'codev-cloud' });
    if (method === 'POST' && path === '/auth/start') return authStart(request, env);
    if (method === 'POST' && path === '/auth/verify') return authVerify(request, env, ctx);
    if (method === 'POST' && path === '/auth/signout') return authSignout(request, env);

    const user = await requireUser(request, env);
    if (method === 'GET' && path === '/me') return json(200, await describeAccount(env, user));

    const relay = /^\/v1\/(groq|openrouter|anthropic)\/(chat\/completions|messages)$/.exec(path);
    if (method === 'POST' && relay) {
        const expected = relay[1] === 'anthropic' ? 'messages' : 'chat/completions';
        if (relay[2] !== expected) throw new HttpError(404, 'Not found.');
        return relayChat(request, env, user, relay[1]);
    }

    if (path.startsWith('/owner/')) {
        if (!isOwner(env, user.email)) throw new HttpError(404, 'Not found.');
        return ownerRoute(request, env, user, method, path);
    }
    throw new HttpError(404, 'Not found.');
}

// ---------- Sign-in ----------

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    return email;
}

function ownerEmails(env) {
    return String(env.OWNER_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

function isOwner(env, email) {
    return ownerEmails(env).includes(String(email).toLowerCase());
}

async function readJson(request, limit = 64 * 1024) {
    const text = await request.text();
    if (text.length > limit) throw new HttpError(413, 'That request is too large.');
    try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'The request was not valid JSON.'); }
}

async function authStart(request, env) {
    const { email: raw } = await readJson(request);
    const email = normalizeEmail(raw);
    const now = Date.now();
    const row = await env.DB.prepare('SELECT sent_count, window_start FROM login_codes WHERE email = ?').bind(email).first();
    const fresh = !row || now - row.window_start > 60 * 60 * 1000;
    const sent = fresh ? 0 : row.sent_count;
    if (sent >= CODES_PER_HOUR) throw new HttpError(429, 'Too many codes asked for. Wait an hour and try again.');

    const code = String(randomInt(1000000)).padStart(6, '0');
    await env.DB.prepare(`INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_count, window_start)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
            attempts = 0, sent_count = excluded.sent_count, window_start = excluded.window_start`)
        .bind(email, await sha256(`${email}:${code}`), now + CODE_MINUTES * 60 * 1000, sent + 1, fresh ? now : row.window_start).run();

    await sendEmail(env, email, `Your CoDev sign-in code: ${code}`,
        `Your CoDev sign-in code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`);
    return json(200, { sent: true });
}

async function authVerify(request, env, ctx) {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const code = String(body.code || '').replace(/\D/g, '');
    const now = Date.now();
    const row = await env.DB.prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?').bind(email).first();
    if (!row || row.expires_at < now || row.attempts >= CODE_ATTEMPTS) throw new HttpError(400, 'That code has expired. Ask for a new one.');
    if (!timingSafeEqual(row.code_hash, await sha256(`${email}:${code}`))) {
        await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
        throw new HttpError(400, "That code isn't right. Check the email and try again.");
    }
    await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();

    let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!user) {
        const owner = isOwner(env, email);
        await env.DB.prepare('INSERT INTO users (email, plan, reviewed, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
            .bind(email, owner ? 'owner' : 'trial', owner ? 1 : 0, now, now).run();
        user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        if (!owner) ctx.waitUntil(notifyOwner(env, email).catch(err => console.error('owner notice failed', err)));
    }

    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(await sha256(token), user.id, now, now + SESSION_DAYS * DAY_MS).run();
    return json(200, { token, account: await describeAccount(env, user) });
}

async function authSignout(request, env) {
    const token = bearer(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json(200, { signedOut: true });
}

function bearer(request) {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
    return match ? match[1].trim() : '';
}

async function requireUser(request, env) {
    const token = bearer(request);
    if (!token) throw new HttpError(401, 'Sign in to your CoDev account first.', 'signed_out');
    const now = Date.now();
    const user = await env.DB.prepare(`SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).bind(await sha256(token), now).first();
    if (!user) throw new HttpError(401, 'Your sign-in has expired. Sign in again.', 'signed_out');
    if (now - user.last_seen > 60 * 60 * 1000) {
        await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, user.id).run();
    }
    return user;
}

// The Sign-up agent writes the notice.
async function notifyOwner(env, email) {
    const to = ownerEmails(env)[0];
    if (!to) return;
    const notice = await signupNotice(env, agentDeps(env), email);
    await sendEmail(env, to, notice.subject, notice.text);
}

// Resend (resend.com) sends the codes and the owner's sign-up notices. Without
// RESEND_API_KEY the code is only written to the server log, for setting up.
async function sendEmail(env, to, subject, text) {
    if (!env.RESEND_API_KEY) {
        console.log(`[email not sent: no RESEND_API_KEY] to ${to}: ${subject}`);
        return;
    }
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM || 'CoDev <onboarding@resend.dev>', to: [to], subject, text })
    });
    if (!response.ok) {
        console.error('Resend refused the email', response.status, await response.text().catch(() => ''));
        throw new HttpError(502, "CoDev couldn't send the email. Try again in a few minutes.");
    }
}

// ---------- Plans and usage ----------

function today(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
}

async function getSettings(env) {
    const rows = (await env.DB.prepare('SELECT name, value FROM settings').all()).results || [];
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of rows) if (row.name in settings) settings[row.name] = Number(row.value);
    return settings;
}

async function usageToday(env, userId) {
    const rows = (await env.DB.prepare('SELECT kind, amount FROM usage WHERE user_id = ? AND day = ?').bind(userId, today()).all()).results || [];
    return Object.fromEntries(rows.map(r => [r.kind, r.amount]));
}

async function describeAccount(env, user) {
    const owner = isOwner(env, user.email);
    const plan = planFor(user, owner);
    const usage = await usageToday(env, user.id);
    const account = { email: user.email, plan: publicPlan(plan), usage: { chatToday: usage.chat || 0 } };
    if (plan.chatTotal != null) account.usage.trialUsed = user.trial_used;
    if (owner) account.owner = true;
    return account;
}

async function addUsage(env, userId, kind, amount) {
    await env.DB.prepare(`INSERT INTO usage (user_id, day, kind, amount) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, day, kind) DO UPDATE SET amount = amount + excluded.amount`)
        .bind(userId, today(), kind, amount).run();
}

// Throws when this request would take the account (or everyone together) past a limit.
async function checkLimits(env, user, plan, provider, owner) {
    if (!plan.providers.includes(provider)) {
        throw new HttpError(403, plan.chatTotal != null
            ? 'The trial uses Groq. Switch to Groq in Settings, or get the Pro plan for the other AI services.'
            : `${provider} isn't included in your plan.`, 'plan_limit');
    }
    if (owner) return;
    const weight = COST_WEIGHTS[provider] || 1;
    if (plan.chatTotal != null && user.trial_used + weight > plan.chatTotal) {
        throw new HttpError(402, `You've used the ${plan.chatTotal} trial messages. Get the Pro plan to keep going, or add your own API key in Settings.`, 'trial_over');
    }
    const usage = await usageToday(env, user.id);
    if (plan.chatPerDay != null && (usage.chat || 0) + weight > plan.chatPerDay) {
        throw new HttpError(429, `You've reached today's limit of ${plan.chatPerDay} messages. It resets at midnight (UTC), or add your own API key in Settings.`, 'daily_limit');
    }
    const settings = await getSettings(env);
    if (!plan.priority && await sharedChatTotal(env, today()) + weight > settings.daily_cap) {
        throw new HttpError(503, "CoDev is very busy today and has paused shared AI until midnight (UTC). Your own API key in Settings still works.", 'global_cap');
    }
}

// Messages that day by everyone but the owner, together.
async function sharedChatTotal(env, day) {
    const owners = ownerEmails(env);
    const placeholders = owners.map(() => '?').join(',') || "''";
    const row = await env.DB.prepare(`SELECT COALESCE(SUM(usage.amount), 0) AS total FROM usage JOIN users ON users.id = usage.user_id
        WHERE usage.day = ? AND usage.kind = 'chat' AND users.email NOT IN (${placeholders})`).bind(day, ...owners).first();
    return row.total;
}

async function relayChat(request, env, user, provider) {
    const owner = isOwner(env, user.email);
    const plan = planFor(user, owner);
    await checkLimits(env, user, plan, provider, owner);

    const key = await getSecret(env, UPSTREAMS[provider].key);
    if (!key) throw new HttpError(503, `CoDev's server has no ${provider} key yet. The owner adds it on the Owner page.`, 'no_key');

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'That request is too large.');
    let body;
    try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'The request was not valid JSON.'); }
    if (!owner && FORCED_MODELS[provider]) body.model = FORCED_MODELS[provider];
    if (provider === 'anthropic' && !owner) body.max_tokens = Math.min(Number(body.max_tokens) || MAX_ANTHROPIC_TOKENS, MAX_ANTHROPIC_TOKENS);
    delete body.stream;

    const headers = { 'Content-Type': 'application/json' };
    if (provider === 'anthropic') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = request.headers.get('anthropic-version') || '2023-06-01';
    } else {
        headers['Authorization'] = `Bearer ${key}`;
        if (provider === 'openrouter') Object.assign(headers, { 'HTTP-Referer': 'https://github.com/phillbennett021423/CoDev_cloud', 'X-Title': 'CoDev Studio' });
    }
    let upstream;
    try {
        upstream = await fetch(UPSTREAMS[provider].url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
        throw new HttpError(502, `CoDev's server couldn't reach ${provider} (${err.message}).`);
    }
    const text = await upstream.text();
    if (upstream.ok) {
        const weight = COST_WEIGHTS[provider] || 1;
        await addUsage(env, user.id, 'chat', weight);
        await addUsage(env, user.id, `requests_${provider}`, 1);
        if (plan.chatTotal != null) await env.DB.prepare('UPDATE users SET trial_used = trial_used + ? WHERE id = ?').bind(weight, user.id).run();
    } else if (upstream.status === 401 || upstream.status === 403) {
        // The owner's key was refused; say so without passing on the provider's wording.
        console.error(`${provider} refused the owner's key`, upstream.status, text.slice(0, 500));
        throw new HttpError(502, `CoDev's server key for ${provider} isn't working. The owner needs to check it on the Owner page.`, 'bad_key');
    }
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' } });
}

// ---------- The owner's keys (encrypted at rest) ----------

async function secretKey(env) {
    if (!env.KEYS_SECRET) throw new HttpError(503, "CoDev's server is missing KEYS_SECRET. Run the deploy workflow again.");
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.KEYS_SECRET));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function getSecret(env, name) {
    const row = await env.DB.prepare('SELECT iv, value FROM secrets WHERE name = ?').bind(name).first();
    if (!row) return '';
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(row.iv) }, await secretKey(env), unbase64url(row.value));
    return new TextDecoder().decode(plain);
}

async function setSecret(env, name, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(env), new TextEncoder().encode(value));
    await env.DB.prepare(`INSERT INTO secrets (name, iv, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET iv = excluded.iv, value = excluded.value, updated_at = excluded.updated_at`)
        .bind(name, base64url(iv), base64url(new Uint8Array(sealed)), Date.now()).run();
}

function maskKey(value) {
    if (!value) return '';
    return value.length <= 10 ? '••••' : `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

// ---------- Owner page ----------

async function ownerRoute(request, env, user, method, path) {
    if (method === 'GET' && path === '/owner/keys') {
        const keys = {};
        for (const name of KEY_NAMES) keys[name] = maskKey(await getSecret(env, name));
        return json(200, { keys });
    }
    const keyMatch = /^\/owner\/keys\/([a-z_]+)(\/reveal)?$/.exec(path);
    if (keyMatch && KEY_NAMES.includes(keyMatch[1])) {
        const name = keyMatch[1];
        if (method === 'GET' && keyMatch[2]) return json(200, { name, value: await getSecret(env, name) });
        if (method === 'PUT' && !keyMatch[2]) {
            const value = String((await readJson(request)).value || '').replace(/[\s"'`]+/g, '');
            if (!value) throw new HttpError(400, 'Paste the key first.');
            await setSecret(env, name, value);
            return json(200, { name, masked: maskKey(value) });
        }
        if (method === 'DELETE' && !keyMatch[2]) {
            await env.DB.prepare('DELETE FROM secrets WHERE name = ?').bind(name).run();
            return json(200, { name, removed: true });
        }
    }

    if (method === 'GET' && path === '/owner/users') {
        const rows = (await env.DB.prepare(`SELECT users.id, users.email, users.plan, users.reviewed, users.trial_used, users.created_at, users.last_seen,
                COALESCE((SELECT amount FROM usage WHERE usage.user_id = users.id AND usage.day = ? AND usage.kind = 'chat'), 0) AS chat_today
            FROM users ORDER BY users.created_at DESC LIMIT 500`).bind(today()).all()).results || [];
        const users = rows.map(r => ({ ...r, owner: isOwner(env, r.email), reviewed: Boolean(r.reviewed) }));
        return json(200, { users, pending: users.filter(u => !u.reviewed && !u.owner && u.plan === 'trial').length, settings: await getSettings(env) });
    }
    const userMatch = /^\/owner\/users\/(\d+)$/.exec(path);
    if (method === 'POST' && userMatch) {
        const { action } = await readJson(request);
        const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(userMatch[1])).first();
        if (!target || isOwner(env, target.email)) throw new HttpError(404, 'No such account.');
        if (action === 'approve') {
            if (target.plan === 'pro' || target.plan === 'max') throw new HttpError(409, 'That account already pays for a plan.');
            if (target.plan !== 'tester') {
                const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE plan = 'tester'").first();
                const { tester_cap } = await getSettings(env);
                if (count >= tester_cap) throw new HttpError(409, `You already have ${count} testers, the most allowed. Remove one or raise the limit first.`);
            }
            await env.DB.prepare("UPDATE users SET plan = 'tester', reviewed = 1 WHERE id = ?").bind(target.id).run();
        } else if (action === 'ignore') {
            await env.DB.prepare('UPDATE users SET reviewed = 1 WHERE id = ?').bind(target.id).run();
        } else if (action === 'remove') {
            if (target.plan !== 'tester') throw new HttpError(409, "That account isn't a tester.");
            await env.DB.prepare("UPDATE users SET plan = 'trial', reviewed = 1 WHERE id = ?").bind(target.id).run();
        } else {
            throw new HttpError(400, 'Unknown action.');
        }
        return json(200, { user: await env.DB.prepare('SELECT id, email, plan, reviewed FROM users WHERE id = ?').bind(target.id).first() });
    }

    if (method === 'GET' && path === '/owner/agents') {
        const agents = [];
        for (const id of Object.keys(AGENT_DEFAULTS)) agents.push(await getAgent(env, id));
        return json(200, { agents });
    }
    const agentMatch = /^\/owner\/agents\/([a-z]+)(\/run)?$/.exec(path);
    if (agentMatch && AGENT_DEFAULTS[agentMatch[1]]) {
        const id = agentMatch[1];
        if (method === 'PUT' && !agentMatch[2]) {
            const update = await readJson(request);
            const agent = await getAgent(env, id);
            for (const [field, max] of [['name', 60], ['instructions', 4000], ['memory', 20000]]) {
                if (update[field] == null) continue;
                const value = String(update[field]).slice(0, max);
                agent[field] = field === 'name' ? (value.trim() || AGENT_DEFAULTS[id].name) : value;
            }
            await saveAgent(env, agent);
            return json(200, { agent });
        }
        if (method === 'POST' && agentMatch[2]) {
            // Run now: the API agent reports on today so far; the Sign-up agent writes up the newest sign-up.
            if (id === 'api') return json(200, { agent: (await runApiAgent(env, agentDeps(env), { force: true })).agent });
            const newest = await env.DB.prepare("SELECT email FROM users WHERE plan = 'trial' ORDER BY created_at DESC LIMIT 1").first();
            if (!newest) throw new HttpError(409, 'There are no sign-ups on the trial to write up yet.');
            await signupNotice(env, agentDeps(env), newest.email);
            return json(200, { agent: await getAgent(env, id) });
        }
    }

    if (method === 'PUT' && path === '/owner/settings') {
        const update = await readJson(request);
        for (const name of Object.keys(DEFAULT_SETTINGS)) {
            if (update[name] == null) continue;
            const value = Math.floor(Number(update[name]));
            if (!Number.isFinite(value) || value < 0 || value > 1e7) throw new HttpError(400, `${name} must be a whole number.`);
            await env.DB.prepare('INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value')
                .bind(name, String(value)).run();
        }
        return json(200, { settings: await getSettings(env) });
    }
    throw new HttpError(404, 'Not found.');
}

// ---------- Helpers ----------

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return base64url(new Uint8Array(digest));
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function randomInt(max) {
    // Rejection sampling keeps every code equally likely.
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % max;
}

function base64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text) {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
}
