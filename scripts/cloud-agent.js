#!/usr/bin/env node
// Runs CoDev's queued cloud tasks on a GitHub Actions runner (.github/workflows/cloud-agent.yml).
//
//   node scripts/cloud-agent.js --check   says whether any task is due (due=true|false in GITHUB_OUTPUT)
//   node scripts/cloud-agent.js           runs every due task, one after another
//
// Each task runs in the real CoDev page: server.js serves it with the agent services
// (headless browser, sandboxes), Chromium opens it with the keys built in from the
// CODEV_SHARED_* secrets (scripts/write-shared-keys.js) and the settings the phone sent,
// and the task is typed into a new chat, exactly as on the phone. When the agents finish,
// their replies, the files they made and the files they wrote in the project folder go
// back to the queue, sealed with the cloud passphrase (mobile/www/agent-ui/cloud-queue.js).
//
// Limits: the phone's daily and per-task spending limits apply, counted in the cloud's own
// ledger (state/spend.json). A run stops after the task's time limit (2 hours by default),
// and the whole job stops starting tasks before GitHub's 6-hour cap, then starts a new run
// for whatever is still due. Approval questions (spending money, signing in) are declined,
// since nobody is there to answer them.
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, CODEV_CLOUD_PASSPHRASE; optional
// CODEV_CLOUD_BRANCH, CODEV_CLOUD_BUDGET_MIN (default 330), CODEV_CLOUD_PORT, CODEV_CHROMIUM.
//
// On the user's own PC (.github/workflows/cloud-agent-pc.yml on a self-hosted runner),
// CODEV_CLOUD_WHERE=pc runs only the tasks sent to "My PC", and CODEV_PC_PROJECT_DIR is the
// user's real project folder: the agents work in it (with Roblox Studio, Godot or Blender
// open on that PC), it is never emptied, and only the files a run changed come back.
// Nothing here prints a task's words or a key: the run's log is public.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Cloud = require('../mobile/www/agent-ui/cloud-queue.js');

const ROOT = path.join(__dirname, '..');
const started = Date.now();
const budgetMs = Number(process.env.CODEV_CLOUD_BUDGET_MIN || 330) * 60 * 1000;
const DEFAULT_TASK_MINUTES = 120;
const MAX_TASK_MINUTES = 300;
const PORT = Number(process.env.CODEV_CLOUD_PORT || 3311);
const WHERE = process.env.CODEV_CLOUD_WHERE === 'pc' ? 'pc' : 'cloud';
const log = (...args) => console.log(`[cloud ${new Date().toISOString().slice(11, 19)}]`, ...args);

function output(name, value) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    log(`${name}=${value}`);
}

function github() {
    const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are needed.');
    return Cloud.createGitHub({ repo, token, branch: process.env.CODEV_CLOUD_BRANCH || Cloud.BRANCH });
}

// The day the spending limit counts in, in the task's own time zone.
function spendDay(timeZone, at = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
    return parts.slice(0, 10);
}

async function check() {
    const gh = github();
    if (!(await gh.branchExists())) return output('due', 'false');
    const queue = Cloud.createQueue({ github: gh, passphrase: '' });
    const due = (await queue.listTasks()).filter(t => Cloud.isDue(t, Date.now(), WHERE));
    output('due', due.length ? 'true' : 'false');
    output('count', due.length);
}

function waitForServer(port, ms = 60000) {
    const until = Date.now() + ms;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get({ host: '127.0.0.1', port, path: '/' }, res => { res.resume(); resolve(); });
            req.on('error', () => (Date.now() > until ? reject(new Error('server.js did not start')) : setTimeout(attempt, 500)));
        };
        attempt();
    });
}

function emptyDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

// Files the agents wrote in the project folder, up to the size cap. since: only files
// changed after that time (the user's own folder on a PC, which holds much more).
function workspaceFiles(dir, budget, since = 0) {
    const files = [], skipped = [];
    const walk = rel => {
        for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git' || (since && entry.name === '.codev')) continue;
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(relPath);
            else if (entry.isFile()) {
                if (since && fs.statSync(path.join(dir, relPath)).mtimeMs < since) continue;
                const bytes = fs.readFileSync(path.join(dir, relPath));
                if (bytes.length > budget.left || files.length >= 200) { skipped.push(relPath); continue; }
                budget.left -= bytes.length;
                files.push({ name: `project/${relPath}`, mime: 'application/octet-stream', b64: bytes.toString('base64') });
            }
        }
    };
    if (fs.existsSync(dir)) walk('');
    return { files, skipped };
}

// Keys the page reads at start, from the settings snapshot the phone sent.
function seedScript(settings, extra) {
    const values = { ...(settings || {}), ...extra };
    return `(() => {
        if (sessionStorage.getItem("codev_cloud_seeded")) return;
        const values = ${JSON.stringify(values)};
        for (const [k, v] of Object.entries(values)) { try { localStorage.setItem(k, v); } catch (e) {} }
        sessionStorage.setItem("codev_cloud_seeded", "1");
        window.CODEV_CLOUD_RUN = true;
    })();`;
}

async function runTask({ queue, browser, task, workspace, keepWorkspace = false, deadline, port = PORT, beforeSend }) {
    const startedAt = Date.now();
    let body;
    try {
        body = await queue.openTask(task);
    } catch (err) {
        log(`task ${task.id}: can't open it (${err.message})`);
        await queue.saveRun(task.id, { started: startedAt, finished: Date.now(), status: 'failed', error: 'The cloud passphrase on GitHub (CODEV_CLOUD_PASSPHRASE) does not match the one this task was sealed with.', messages: [] });
        await queue.updateTask(task.id, t => ({ ...t, nextRun: null, paused: true }));
        return;
    }
    const tz = task.timeZone || 'UTC';
    const limits = body.limits || {};
    const day = spendDay(tz);
    const spend = await queue.getSpend(day);
    // Schedule the next run first, so a crash can't make a task run again and again.
    const following = Cloud.nextRun(task.repeat, startedAt, tz);
    if (limits.daily > 0 && spend.usd >= limits.daily) {
        log(`task ${task.id}: today's cloud limit is used up`);
        const tomorrow = Cloud.nextRun({ every: 'daily', at: '00:05' }, startedAt, tz);
        await queue.saveRun(task.id, { started: startedAt, finished: Date.now(), status: 'waiting', error: `Today's cloud spending limit ($${limits.daily}) is used up. It runs again after midnight.`, messages: [] });
        await queue.updateTask(task.id, t => ({ ...t, nextRun: following && following > tomorrow ? following : tomorrow }));
        return;
    }
    await queue.updateTask(task.id, t => ({ ...t, nextRun: following, lastRun: startedAt }));
    await queue.saveRun(task.id, { started: startedAt, status: 'running', messages: [] });
    log(`task ${task.id}: running (${Cloud.describeRepeat(task.repeat)})`);

    if (!keepWorkspace) emptyDir(workspace);
    const minutes = Math.min(MAX_TASK_MINUTES, Math.max(5, Number(body.maxMinutes) || DEFAULT_TASK_MINUTES));
    const stopAt = Math.min(deadline, startedAt + minutes * 60 * 1000);
    const context = await browser.newContext({ timezoneId: tz, viewport: { width: 1400, height: 900 }, acceptDownloads: false });
    await context.addInitScript(seedScript(body.settings, {
        codev_spend: JSON.stringify(spend),
        codev_daily_spend_limit: String(limits.daily ?? 1),
        codev_task_spend_limit: String(limits.task ?? 0.25),
        codev_tools_autorun: '1',
        codev_code_autopilot: '1'
    }));
    const page = await context.newPage();
    // Nobody is there to answer: confirm() is a no, prompt() is empty, alerts are closed.
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    let status = 'done', error = '';
    let capture = { messages: [], files: [], spend: null };
    try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof sendChatMessage === 'function' && typeof createNewChat === 'function', null, { timeout: 60000 });
        await page.waitForTimeout(2500);
        if (beforeSend) await beforeSend(page);
        await page.evaluate(({ prompt, agent }) => {
            const chosen = agent && agents.find(a => a.name.toLowerCase() === String(agent).toLowerCase());
            if (chosen) selectedAgentId = chosen.id;
            ["isGroupChatCheckbox", "isBackgroundWorkerCheckbox"].forEach(id => { const box = document.getElementById(id); if (box) box.checked = false; });
            createNewChat();
            document.getElementById("userInput").value = prompt;
            window.__cloudDone = null;
            sendChatMessage().then(() => { window.__cloudDone = { ok: true }; }, err => { window.__cloudDone = { ok: false, error: String(err && err.message || err) }; });
        }, { prompt: String(body.prompt || ''), agent: body.agent || '' });

        let lastCancelCheck = Date.now();
        for (;;) {
            const done = await page.evaluate(() => window.__cloudDone);
            if (done) { if (!done.ok) { status = 'failed'; error = done.error; } break; }
            if (Date.now() >= stopAt) { status = 'timeout'; error = `Stopped after ${Math.round((Date.now() - startedAt) / 60000)} minutes, the time limit for one cloud run. This is what the agents had so far.`; break; }
            if (Date.now() - lastCancelCheck > 60000) {
                lastCancelCheck = Date.now();
                if (!(await queue.getTask(task.id))) { status = 'cancelled'; error = 'Removed from CoDev while it was running.'; break; }
            }
            await page.waitForTimeout(5000);
        }
        capture = await page.evaluate(async maxBytes => {
            const session = chatSessions.find(s => s.id === activeChatId);
            const all = session ? session.messages : [];
            const from = all.findIndex(m => /You/.test(m.sender));
            const messages = [];
            const files = [];
            let left = maxBytes;
            for (const m of all.slice(from + 1)) {
                const attachments = [];
                for (const a of m.attachments || []) {
                    if (a.fileId) {
                        const saved = await madeFileStore("readonly", store => store.get(a.fileId));
                        const bytes = saved && saved.bytes ? new Uint8Array(saved.bytes) : null;
                        if (bytes && bytes.length <= left) {
                            left -= bytes.length;
                            files.push({ name: saved.name || a.name, mime: saved.mime || a.mime || "application/octet-stream", kind: saved.kind || a.format || "", b64: CodevCloud.toBase64(bytes) });
                            attachments.push({ name: a.name, kind: "file", cloudFile: files.length - 1 });
                        } else attachments.push({ name: a.name, kind: "note", note: "too big to bring back from the cloud" });
                    } else {
                        const { fullUrl, ...kept } = a;
                        attachments.push(kept);
                    }
                }
                messages.push({ sender: m.sender, text: String(m.text || "").slice(0, 200000), attachments, sources: m.sources || [] });
            }
            return { messages, files, left, spend: spendToday() };
        }, Cloud.MAX_RESULT_FILE_BYTES);
    } catch (err) {
        status = 'failed';
        error = `The cloud run stopped: ${String(err.message || err).split('\n')[0]}`;
    }
    await context.close().catch(() => {});

    // A second early, so a file written in the run's first moment still counts (coarse mtimes).
    const fromWorkspace = workspaceFiles(workspace, { left: capture.left ?? Cloud.MAX_RESULT_FILE_BYTES }, keepWorkspace ? startedAt - 2000 : 0);
    const after = capture.spend && capture.spend.day === day ? capture.spend : spend;
    await queue.setSpend(after);
    const run = {
        started: startedAt, finished: Date.now(), status, error,
        messages: capture.messages || [],
        files: (capture.files || []).concat(fromWorkspace.files),
        skippedFiles: fromWorkspace.skipped,
        spentUsd: Math.max(0, Math.round(((after.usd || 0) - (spend.usd || 0)) * 1e6) / 1e6)
    };
    // A task removed while it ran leaves no result behind.
    if (status === 'cancelled') await queue.removeTask(task.id);
    else await queue.saveRun(task.id, run);
    log(`task ${task.id}: ${status}, ${run.messages.length} message(s), ${run.files.length} file(s), about $${run.spentUsd.toFixed(4)}`);
}

// Runs every due task, one after another, until none is due or the time budget is near.
// The tests pass their own github (an in-memory stand-in), port and beforeSend.
async function runQueue({ github: gh, passphrase, port = PORT, budget = budgetMs, beforeSend, chromiumPath = process.env.CODEV_CHROMIUM, workspace, browser: givenBrowser, where = WHERE, projectDir = process.env.CODEV_PC_PROJECT_DIR }) {
    const queue = Cloud.createQueue({ github: gh, passphrase });
    await queue.ensureBranch();
    const deadline = Date.now() + budget;
    // On the PC with a project folder set, the agents work in the user's real folder.
    const keepWorkspace = where === 'pc' && Boolean(projectDir);
    if (keepWorkspace) {
        if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error(`CODEV_PC_PROJECT_DIR (${projectDir}) is not a folder on this PC.`);
        workspace = path.resolve(projectDir);
    } else {
        workspace = workspace || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'codev-cloud-workspace');
        emptyDir(workspace);
    }
    const env = { ...process.env, PORT: String(port), CODEV_WORKSPACE: workspace, GITHUB_TOKEN: '', CODEV_CLOUD_PASSPHRASE: '' };
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), workspace], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
    let browser = givenBrowser;
    let ran = 0;
    try {
        await waitForServer(port);
        if (!browser) {
            const { chromium } = require('playwright-core');
            browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
        }
        const tried = new Set();
        for (;;) {
            const due = (await queue.listTasks()).filter(t => Cloud.isDue(t, Date.now(), where) && !tried.has(`${t.id}:${t.nextRun}`)).sort((a, b) => a.nextRun - b.nextRun);
            if (!due.length) break;
            if (deadline - Date.now() < 10 * 60 * 1000) {
                log(`${due.length} task(s) still due; starting a new run for them`);
                await gh.dispatch(Cloud.workflowFor(where), process.env.GITHUB_REF_NAME || 'main').catch(err => log(`couldn't start the next run: ${err.message}`));
                break;
            }
            tried.add(`${due[0].id}:${due[0].nextRun}`);
            try {
                await runTask({ queue, browser, task: due[0], workspace, keepWorkspace, deadline, port, beforeSend });
            } catch (err) {
                log(`task ${due[0].id}: ${String(err.message || err).split('\n')[0]}`);
            }
            ran++;
        }
        log(`finished ${ran} task run(s)`);
    } finally {
        if (browser && !givenBrowser) await browser.close().catch(() => {});
        server.kill();
    }
    return ran;
}

async function main() {
    if (process.argv.includes('--check')) return check();
    const passphrase = process.env.CODEV_CLOUD_PASSPHRASE || '';
    if (passphrase.length < 12) throw new Error('Add a CODEV_CLOUD_PASSPHRASE secret (12 characters or more), the same passphrase as in CoDev\'s Settings.');
    await runQueue({ github: github(), passphrase, budget: budgetMs - (Date.now() - started) });
}

if (require.main === module) {
    main().catch(err => { console.error(`[cloud] ${err.message}`); process.exit(1); });
}

module.exports = { spendDay, seedScript, workspaceFiles, runQueue, runTask };
