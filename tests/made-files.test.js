// The real page with a scripted model: an agent makes a workbook and a web app, they
// show under its reply and open in the file viewer (the web app in a sandboxed preview),
// and delegate_tasks runs worker agents whose results come back to the planner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

async function start(t, steps) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-files-'));
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Demo\n');
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const opened = await openPage(launched.browser, url, { steps });
    // These tests aren't about the sandbox review.
    await opened.page.evaluate(() => { const box = document.getElementById('isSandboxCheckbox'); if (box.checked) box.click(); });
    return opened;
}

test('a spreadsheet and a web app are attached to the reply and open in the viewer', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await start(t, [
        [{ name: 'create_spreadsheet', arguments: { filename: 'Budget', sheets: [{ name: 'Costs', columns: ['Item', { header: 'Cost', format: 'currency' }], rows: [['Rent', 1200], ['Food', 450]], total_row: true }] } },
         { name: 'create_web_app', arguments: { name: 'Counter', files: { 'index.html': '<!doctype html><link rel="stylesheet" href="s.css"><button id="b">0</button><script src="app.js"></script>', 's.css': 'button{font-size:40px}', 'app.js': 'const b=document.getElementById("b");b.onclick=()=>b.textContent=+b.textContent+1;' } } }],
        'Made Budget.xlsx and a counter app.'
    ]);
    await sendPrompt(page, 'Make me a budget spreadsheet and a counter web app');
    await waitForChat(page, /Made Budget\.xlsx and a counter app/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.match(calls[1].messages.find(m => m.role === 'tool').content, /Costs!B4 =SUM\(B2:B3\) → 1,650/);
    assert.match(calls[1].messages.filter(m => m.role === 'tool')[1].content, /Syntax check: passed/);
    assert.match(calls[0].system, /\[Files\]/);
    const pills = await page.$$eval('.made-file', els => els.map(e => e.textContent));
    assert.equal(pills.length, 2);
    assert.match(pills[0], /Budget\.xlsx/);
    await page.click('.made-file >> nth=1');
    const frame = await page.waitForSelector('.made-file-frame');
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-modals allow-popups');
    const inner = await (await frame.contentFrame());
    await inner.click('#b');
    assert.equal(await inner.textContent('#b'), '1', 'the app runs in the preview');
    assert.equal(await inner.evaluate(() => { localStorage.setItem('k', 'v'); return localStorage.getItem('k'); }), 'v', 'apps that save get in-memory storage');
    // The test driver's own setup script also runs in the sandboxed frame and can't reach storage there.
    assert.deepEqual(errors.filter(e => !/sandboxed and lacks the 'allow-same-origin'/.test(e)), []);
});

test('delegate_tasks runs workers in parallel and gives the planner their results', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await start(t, [
        [{ name: 'delegate_tasks', arguments: { tasks: [{ id: 'alpha', task: 'Report on alpha' }, { id: 'beta', task: 'Report on beta' }] } }],
        'worker report one',
        'worker report two',
        'Both parts are done.'
    ]);
    await sendPrompt(page, 'Research alpha and beta in parallel');
    await waitForChat(page, /Both parts are done/);
    const calls = await page.evaluate(() => window.__modelCalls);
    const workerCalls = calls.filter(c => /\[Worker\]/.test(c.system));
    assert.equal(workerCalls.length, 2);
    assert.ok(workerCalls.every(c => !c.tools.includes('delegate_tasks')), 'workers cannot delegate again');
    assert.ok(workerCalls.some(c => /Sub-task alpha/.test(c.messages[0].content)));
    const report = calls[calls.length - 1].messages.find(m => m.role === 'tool').content;
    assert.match(report, /2 of 2 worker task\(s\) finished/);
    assert.match(report, /worker report (one|two)/);
    assert.deepEqual(errors, []);
});
