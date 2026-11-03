// Cloud agents (mobile/www/agent-ui/cloud-queue.js, scripts/cloud-agent.js): sealing,
// schedules, the queue on a stand-in GitHub, and one whole trip: the page queues a task
// from the chat, the runner runs it in the real page on a "server" with a scripted model,
// and the page brings the reply and the file the agent made back into the same chat.
// No token, key or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Cloud = require('../mobile/www/agent-ui/cloud-queue.js');
const { createGitHubMock } = require('./helpers/github-mock');
const { launchBrowser } = require('./helpers/page-driver');

const ROOT = path.join(__dirname, '..');
const PASS = 'correct horse battery staple';

test('sealed tasks open with the passphrase and only with it', async () => {
    const sealed = await Cloud.seal({ prompt: 'find me props', n: 3 }, PASS);
    assert.equal(sealed.alg, 'AES-256-GCM/PBKDF2-SHA256');
    assert.ok(!JSON.stringify(sealed).includes('props'));
    assert.deepEqual(await Cloud.open(sealed, PASS), { prompt: 'find me props', n: 3 });
    await assert.rejects(Cloud.open(sealed, 'wrong passphrase here'), /doesn't match/);
    await assert.rejects(Cloud.seal({}, 'short'), /12 characters/);
    // Each seal is fresh (new salt and IV).
    assert.notEqual((await Cloud.seal('x', PASS)).data, (await Cloud.seal('x', PASS)).data);
});

test('schedules run at the local time, skip weekends for weekdays, and once means once', () => {
    const tz = 'America/New_York';
    const at = (iso) => Date.parse(iso);
    const local = ms => new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(ms));
    assert.equal(Cloud.nextRun({ every: 'once' }, at('2026-11-03T12:00:00Z'), tz), null);
    assert.equal(Cloud.nextRun({ every: 'hourly' }, 1000, tz), 1000 + 3600000);
    // 8am New York, on the day before and after the clocks change (Nov 1 2026).
    assert.equal(local(Cloud.nextRun({ every: 'daily', at: '08:00' }, at('2026-10-31T13:00:00Z'), tz)), '11/1/26, 08:00');
    assert.equal(Cloud.nextRun({ every: 'daily', at: '08:00' }, at('2026-10-31T13:00:00Z'), tz), at('2026-11-01T13:00:00Z'));
    assert.equal(Cloud.nextRun({ every: 'daily', at: '08:00' }, at('2026-10-30T11:00:00Z'), tz), at('2026-10-30T12:00:00Z'));
    // Friday evening -> Monday morning.
    assert.equal(local(Cloud.nextRun({ every: 'weekdays', at: '07:30' }, at('2026-11-06T23:00:00Z'), tz)), '11/9/26, 07:30');
    // Weekly on Wednesday (3).
    assert.equal(local(Cloud.nextRun({ every: 'weekly', at: '18:00', day: 3 }, at('2026-11-03T12:00:00Z'), tz)), '11/4/26, 18:00');
    assert.equal(Cloud.describeRepeat({ every: 'weekly', at: '18:00', day: 3 }), 'Every Wednesday at 18:00');
    assert.ok(Cloud.isDue({ nextRun: 5 }, 10));
    assert.ok(!Cloud.isDue({ nextRun: 5, paused: true }, 10));
    assert.ok(!Cloud.isDue({ nextRun: null }, 10));
});

test('the queue keeps tasks and their last runs on its own branch, sealed', async () => {
    const mock = createGitHubMock();
    const github = Cloud.createGitHub({ repo: 'owner/codev', token: 't', fetch: mock.fetch });
    const queue = Cloud.createQueue({ github, passphrase: PASS });
    assert.deepEqual(await queue.listTasks(), []);
    await queue.ensureBranch();
    assert.ok(mock.files.has('README.md'));
    const task = await queue.addTask({ body: { prompt: 'daily summary' }, repeat: { every: 'daily', at: '09:00' }, timeZone: 'UTC', runNow: false });
    const stored = mock.read(`tasks/${task.id}.json`);
    assert.ok(!JSON.stringify(stored).includes('daily summary'));
    assert.equal(stored.nextRun, Cloud.nextRun({ every: 'daily', at: '09:00' }, task.created, 'UTC'));
    assert.equal((await queue.openTask((await queue.listTasks())[0])).prompt, 'daily summary');

    for (let i = 1; i <= 7; i++) await queue.saveRun(task.id, { started: i, status: i === 7 ? 'running' : 'done', messages: [{ sender: 'A', text: `run ${i}` }] });
    await queue.saveRun(task.id, { started: 7, finished: 8, status: 'done', messages: [{ sender: 'A', text: 'run 7 done' }] });
    const result = await queue.getResult(task.id);
    assert.equal(result.status, 'done');
    const { runs } = await queue.openResult(result);
    assert.deepEqual(runs.map(r => r.started), [3, 4, 5, 6, 7]);
    assert.equal(runs[4].messages[0].text, 'run 7 done');

    // A file over 1 MB comes back through the raw form.
    const big = 'x'.repeat(1.5 * 1024 * 1024);
    await queue.saveRun(task.id, { started: 9, finished: 10, status: 'done', messages: [{ sender: 'A', text: big }] });
    assert.equal((await queue.openResult(await queue.getResult(task.id))).runs.pop().messages[0].text.length, big.length);

    await queue.runNow(task.id);
    assert.ok(Cloud.isDue(await queue.getTask(task.id)));
    await github.dispatch();
    assert.deepEqual(mock.dispatches, [{ workflow: 'cloud-agent.yml', ref: 'main' }]);
    await queue.removeTask(task.id);
    assert.equal(await queue.getTask(task.id), null);
    assert.equal(await queue.getResult(task.id), null);
    assert.throws(() => Cloud.createGitHub({ repo: 'not a repo', fetch: mock.fetch }), /owner\/name/);
});

function freePort() {
    return new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

function waitFor(port) {
    return new Promise((resolve, reject) => {
        const until = Date.now() + 30000;
        const attempt = () => http.get({ host: '127.0.0.1', port, path: '/' }, res => { res.resume(); resolve(); })
            .on('error', () => (Date.now() > until ? reject(new Error('server did not start')) : setTimeout(attempt, 300)));
        attempt();
    });
}

test('a task sent from the chat runs in the cloud copy of CoDev and its reply and file come back to the chat', { timeout: 240000 }, async t => {
    const { browser, skip } = await launchBrowser();
    if (skip) return t.skip(skip);
    t.after(() => browser.close());
    const mock = createGitHubMock({ repo: 'owner/codev' });

    // The phone: CoDev on its own server, with the cloud set up.
    const phonePort = await freePort();
    const phoneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-phone-'));
    const phone = spawn(process.execPath, [path.join(ROOT, 'server.js'), phoneDir], { cwd: ROOT, env: { ...process.env, PORT: String(phonePort) }, stdio: 'ignore' });
    t.after(() => phone.kill());
    await waitFor(phonePort);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('dialog', d => d.dismiss());
    await page.route('https://api.github.com/**', mock.route);
    await page.addInitScript(pass => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('codev_groq_key', 'gsk_phone_key_never_sent');
        localStorage.setItem('codev_backend', 'groq');
        localStorage.setItem('codev_auto_ground', '0');
        localStorage.setItem('codev_chime', '0');
        localStorage.setItem('codev_daily_spend_limit', '0.5');
        localStorage.setItem('codev_cloud_repo', 'owner/codev');
        localStorage.setItem('codev_cloud_token', 'github_pat_test');
        localStorage.setItem('codev_cloud_passphrase', pass);
    }, PASS);
    await page.goto(`http://127.0.0.1:${phonePort}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof sendChatMessage === 'function');
    await page.evaluate(() => {
        document.getElementById('settingsModal').style.display = 'none';
        document.getElementById('isCloudRunCheckbox').checked = true;
        document.getElementById('userInput').value = 'Make me a CSV of the three biggest planets';
    });
    const chatId = await page.evaluate(() => activeChatId);
    await page.evaluate(() => sendChatMessage());
    const queued = await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.at(-1));
    assert.equal(queued.sender, '☁️ Cloud');
    assert.match(queued.text, /Queued on GitHub/);
    assert.equal(mock.dispatches.length, 1);
    const taskFile = [...mock.files.keys()].find(k => k.startsWith('tasks/'));
    assert.ok(taskFile);
    const rawTask = mock.files.get(taskFile).bytes.toString('utf8');
    assert.ok(!rawTask.includes('planets') && !rawTask.includes('gsk_phone_key'), 'the task is sealed and carries no keys');
    const body = await Cloud.open(JSON.parse(rawTask).sealed, PASS);
    assert.equal(body.prompt, 'Make me a CSV of the three biggest planets');
    assert.equal(body.limits.daily, 0.5);
    assert.ok(!Object.keys(body.settings).some(k => /key|token|pass/i.test(k)), 'no keys or tokens in the settings snapshot');
    assert.equal(body.settings.codev_backend, 'groq');

    // The runner: a scripted model that makes a CSV, then answers.
    const { runQueue } = require('../scripts/cloud-agent.js');
    const github = Cloud.createGitHub({ repo: 'owner/codev', token: 't', fetch: mock.fetch });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-cloud-ws-'));
    let sawPrompt = '';
    const ran = await runQueue({
        github, passphrase: PASS, port: await freePort(), workspace, budget: 30 * 60 * 1000,
        browser,
        beforeSend: async cloudPage => {
            await cloudPage.exposeFunction('__sawPrompt', text => { sawPrompt = text; });
            await cloudPage.evaluate(() => {
                groqKey = 'gsk_cloud_secret_key';
                let calls = 0;
                window.groqChatMessage = async body => {
                    calls++;
                    if (calls === 1) {
                        window.__sawPrompt(body.messages.filter(m => m.role === 'user').map(m => String(m.content)).join('\n'));
                        recordSpend(0.01);
                        return { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_csv', arguments: JSON.stringify({ filename: 'planets', columns: ['Planet', 'Radius km'], rows: [['Jupiter', 69911], ['Saturn', 58232], ['Uranus', 25362]] }) } }] };
                    }
                    return { role: 'assistant', content: 'Here is planets.csv with Jupiter, Saturn and Uranus.' };
                };
            });
        }
    });
    assert.equal(ran, 1);
    assert.match(sawPrompt, /three biggest planets/);
    const task = JSON.parse(mock.files.get(taskFile).bytes.toString('utf8'));
    assert.equal(task.nextRun, null, 'a one-off task is not due again');
    const result = mock.read(taskFile.replace('tasks/', 'results/'));
    assert.equal(result.status, 'done');
    const resultText = mock.files.get(taskFile.replace('tasks/', 'results/')).bytes.toString('utf8');
    assert.ok(!resultText.includes('Jupiter') && !resultText.includes('gsk_cloud'), 'results are sealed');
    const { runs } = await Cloud.open(result.sealed, PASS);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].files.length, 1);
    assert.match(Buffer.from(runs[0].files[0].b64, 'base64').toString(), /Jupiter,69911/);
    assert.ok(runs[0].messages.some(m => /planets\.csv/.test(m.text)));
    assert.ok(Math.abs(runs[0].spentUsd - 0.01) < 1e-9);
    assert.ok(Math.abs(mock.read('state/spend.json').usd - 0.01) < 1e-9);

    // Back on the phone: the reply and the file land in the chat the task came from.
    await page.evaluate(() => refreshCloudTasks(true));
    const chat = await page.evaluate(id => chatSessions.find(s => s.id === id).messages.map(m => ({ sender: m.sender, text: m.text, files: (m.attachments || []).filter(a => a.fileId).map(a => a.name) })), chatId);
    const reply = chat.find(m => /planets\.csv with Jupiter/.test(m.text));
    assert.ok(reply, JSON.stringify(chat.slice(-4)));
    assert.match(reply.sender, /^☁️ /);
    assert.ok(chat.some(m => m.files.some(n => /planets\.csv/.test(n))), 'the CSV is attached in the chat');
    assert.ok(chat.some(m => /finished/.test(m.text) && m.sender === '☁️ Cloud'));
    // Not posted twice.
    const count = chat.length;
    await page.evaluate(() => refreshCloudTasks(true));
    assert.equal(await page.evaluate(id => chatSessions.find(s => s.id === id).messages.length, chatId), count);
    // The Cloud Agents view lists it as done.
    await page.evaluate(() => switchView('cloud'));
    await page.waitForFunction(() => document.querySelector('#cloudTaskList .cloud-status.done'));
    assert.deepEqual(errors, []);
});

test('the runner waits for tomorrow when the cloud spending limit is used up', { timeout: 120000 }, async t => {
    const { browser, skip } = await launchBrowser();
    if (skip) return t.skip(skip);
    t.after(() => browser.close());
    const mock = createGitHubMock({ repo: 'owner/codev' });
    const github = Cloud.createGitHub({ repo: 'owner/codev', token: 't', fetch: mock.fetch });
    const queue = Cloud.createQueue({ github, passphrase: PASS });
    await queue.ensureBranch();
    const task = await queue.addTask({ body: { prompt: 'hi', limits: { daily: 0.05, task: 0.25 } }, repeat: { every: 'once' }, timeZone: 'UTC' });
    const { spendDay, runQueue } = require('../scripts/cloud-agent.js');
    await queue.setSpend({ day: spendDay('UTC'), usd: 0.05, requests: 3 });
    const ran = await runQueue({ github, passphrase: PASS, port: await freePort(), workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'codev-cloud-ws-')), browser });
    assert.equal(ran, 1);
    const { runs } = await queue.openResult(await queue.getResult(task.id));
    assert.equal(runs[0].status, 'waiting');
    assert.match(runs[0].error, /spending limit/);
    assert.ok((await queue.getTask(task.id)).nextRun > Date.now());
});
