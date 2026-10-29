// The owner's agents. They work for the owner alone and only ever see usage
// numbers and sign-up emails, never anyone's chats (the server doesn't hold any).
//
//  - The API agent checks spending every hour, emails the owner once a day when
//    shared use passes 80% of the daily total, and sends a summary of each day.
//  - The Sign-up agent writes the owner's notice for each new sign-up, with a
//    suggestion to approve as a tester or skip, following the owner's instructions.
//
// Each has a name, instructions and a memory the owner edits on the Owner page.
// With the owner's Groq key stored, the agent writes its notes with Groq (a
// fraction of a cent each); without it, it sends the plain numbers.
import { EST_COST_PER_REQUEST } from './plans.js';

export const AGENT_DEFAULTS = {
    api: {
        name: 'API agent',
        instructions: 'Watch what the shared API keys cost. Warn me early, before the daily total runs out, and tell me in plain words which service costs the most and whether any one account is using far more than the rest.'
    },
    signups: {
        name: 'Sign-up agent',
        instructions: 'For each new sign-up, tell me who it is and whether to approve them as a tester or skip. Keep testers to people likely to give feedback, and flag throwaway or suspicious emails.'
    }
};
const MEMORY_LINES = 40;
const WARN_AT = 0.8;
const GROQ_MODEL = 'openai/gpt-oss-120b';

export async function getAgent(env, id) {
    const row = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first();
    return row || { id, ...AGENT_DEFAULTS[id], memory: '', last_run: 0, last_report: '', last_warned_day: '' };
}

export async function saveAgent(env, agent) {
    await env.DB.prepare(`INSERT INTO agents (id, name, instructions, memory, last_run, last_report, last_warned_day) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, instructions = excluded.instructions, memory = excluded.memory,
            last_run = excluded.last_run, last_report = excluded.last_report, last_warned_day = excluded.last_warned_day`)
        .bind(agent.id, agent.name, agent.instructions, agent.memory, agent.last_run, agent.last_report, agent.last_warned_day).run();
}

function remember(agent, line) {
    const lines = agent.memory ? agent.memory.split('\n') : [];
    lines.push(`${new Date().toISOString().slice(0, 10)}: ${line}`);
    agent.memory = lines.slice(-MEMORY_LINES).join('\n');
}

// Asks Groq to write the agent's note from the facts. Falls back to the facts alone.
async function write(deps, agent, task, facts) {
    const key = await deps.getSecret('groq').catch(() => '');
    if (!key) return facts;
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: GROQ_MODEL, temperature: 0.2, max_tokens: 600,
                messages: [
                    { role: 'system', content: `You are ${agent.name}, an assistant that works only for the owner of the CoDev app. Your standing instructions from the owner:\n${agent.instructions}\n\nYour memory (your earlier notes, newest last; the owner may have edited it):\n${agent.memory || '(empty)'}\n\nWrite in plain, short sentences for a non-technical owner. Use only the facts given. Under 150 words. No markdown headings.` },
                    { role: 'user', content: `${task}\n\nFacts:\n${facts}` }
                ]
            })
        });
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        return text ? `${text}\n\n---\nThe numbers:\n${facts}` : facts;
    } catch (err) {
        console.error(`${agent.id} agent couldn't reach Groq`, err);
        return facts;
    }
}

// ---------- The API agent ----------

export async function spendingFacts(env, day, deps) {
    const rows = (await env.DB.prepare(`SELECT usage.kind, SUM(usage.amount) AS amount, COUNT(DISTINCT usage.user_id) AS accounts
        FROM usage WHERE usage.day = ? AND usage.kind LIKE 'requests_%' GROUP BY usage.kind`).bind(day).all()).results || [];
    let cost = 0;
    const lines = [];
    for (const row of rows) {
        const provider = row.kind.slice('requests_'.length);
        const estimate = row.amount * (EST_COST_PER_REQUEST[provider] ?? 0.002);
        cost += estimate;
        lines.push(`${provider}: ${row.amount} requests from ${row.accounts} account(s), about $${estimate.toFixed(2)}`);
    }
    const shared = await deps.sharedChatTotal(day);
    const { daily_cap } = await deps.getSettings();
    const top = await env.DB.prepare(`SELECT users.email, usage.amount FROM usage JOIN users ON users.id = usage.user_id
        WHERE usage.day = ? AND usage.kind = 'chat' ORDER BY usage.amount DESC LIMIT 3`).bind(day).all();
    const heaviest = (top.results || []).map(r => `${r.email} (${r.amount})`).join(', ');
    const facts = [
        `Day (UTC): ${day}`,
        ...(lines.length ? lines : ['No AI requests through the shared keys.']),
        `Estimated cost: about $${cost.toFixed(2)} (a rough guess from typical prices, not a bill)`,
        `Shared messages, everyone but the owner: ${shared} of the daily total of ${daily_cap} (${daily_cap ? Math.round(100 * shared / daily_cap) : 0}%)`,
        heaviest ? `Heaviest accounts: ${heaviest}` : null
    ].filter(Boolean).join('\n');
    return { facts, shared, cap: daily_cap, cost };
}

// The hourly check. A warning goes out once a day; the summary of the day before
// goes out in the first hour after midnight UTC.
export async function runApiAgent(env, deps, { now = Date.now(), force = false } = {}) {
    const agent = await getAgent(env, 'api');
    const day = new Date(now).toISOString().slice(0, 10);
    const sent = [];

    const todayFacts = await spendingFacts(env, day, deps);
    if (todayFacts.cap && todayFacts.shared >= WARN_AT * todayFacts.cap && agent.last_warned_day !== day) {
        const report = await write(deps, agent, 'Shared use has passed 80% of the daily total. Warn the owner and say what they can do (raise the total on the Owner page, or let it pause until midnight UTC).', todayFacts.facts);
        await deps.emailOwner(`${agent.name}: 80% of today's shared AI used`, report);
        agent.last_warned_day = day;
        remember(agent, `Warned: ${todayFacts.shared}/${todayFacts.cap} shared messages, about $${todayFacts.cost.toFixed(2)}.`);
        sent.push('warning');
    }

    const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const summaryDue = new Date(now).getUTCHours() === 0 && new Date(agent.last_run).toISOString().slice(0, 10) !== day;
    if (force || summaryDue) {
        const { facts, cost } = await spendingFacts(env, force ? day : yesterday, deps);
        const report = await write(deps, agent, force ? 'The owner asked for a report on today so far.' : "Write the owner's daily summary of yesterday's spending.", facts);
        if (!force) await deps.emailOwner(`${agent.name}: yesterday's API spending`, report);
        agent.last_report = report;
        remember(agent, `${force ? 'Today so far' : 'Yesterday'}: about $${cost.toFixed(2)}.`);
        sent.push(force ? 'report' : 'summary');
    }
    agent.last_run = now;
    await saveAgent(env, agent);
    return { agent, sent };
}

// ---------- The Sign-up agent ----------

export async function signupNotice(env, deps, email) {
    const agent = await getAgent(env, 'signups');
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const { count: today } = await env.DB.prepare('SELECT COUNT(*) AS count FROM users WHERE created_at > ?').bind(since).first();
    const { count: testers } = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE plan = 'tester'").first();
    const { tester_cap } = await deps.getSettings();
    const facts = [
        `New sign-up: ${email}`,
        `Email domain: ${email.split('@')[1]}`,
        `Signed up (UTC): ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`,
        `Sign-ups in the last 24 hours: ${today}`,
        `Testers now: ${testers} of ${tester_cap}`,
        'They are on the trial (20 Groq messages). To make them a tester: CoDev > Settings > Owner page > Approve as tester.'
    ].join('\n');
    const report = await write(deps, agent, 'Tell the owner about this new sign-up and suggest: approve as a tester, or skip. Give one short reason.', facts);
    agent.last_run = Date.now();
    agent.last_report = report;
    remember(agent, `${email} signed up (${today} in 24h, testers ${testers}/${tester_cap}).`);
    await saveAgent(env, agent);
    return { subject: `${agent.name}: new sign-up, ${email}`, text: report };
}
