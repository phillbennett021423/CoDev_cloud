// run_code (mobile/www/agent-ui/code-runner.js): Python and JavaScript in the browser's
// own workers. JavaScript runs in headless Chromium. Python needs Pyodide: these tests
// load it from CODEV_PYODIDE_DIR (a folder with pyodide.js, such as the unpacked
// "pyodide" npm package) and are skipped without it, since CI may have no internet.
// Run: node --test tests/code-runner.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Code = require('../mobile/www/agent-ui/code-runner.js');
const Guide = require('../mobile/www/agent-ui/tool-guide.js');
const { launchBrowser } = require('./helpers/page-driver');

const RUNNER = path.join(__dirname, '..', 'mobile', 'www', 'agent-ui', 'code-runner.js');
const PYODIDE_DIR = process.env.CODEV_PYODIDE_DIR || '';

let launched, server, base, page;

test.before(async () => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x').pathname;
        let file = null;
        if (url === '/code-runner.js') file = RUNNER;
        else if (url.startsWith('/pyodide/') && PYODIDE_DIR) file = path.join(PYODIDE_DIR, path.basename(url));
        if (url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><script src="/code-runner.js"></script>'); }
        if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
        const type = file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' });
        res.end(fs.readFileSync(file));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    launched = await launchBrowser();
    if (launched.skip) return;
    page = await launched.browser.newPage();
    await page.goto(`${base}/`);
    await page.evaluate(pyodideUrl => {
        window.runner = CodevCodeRunner.createCodeRunner({
            pyodideUrl,
            createWorker: source => new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
        });
        window.runIt = async job => {
            const r = await window.runner.run(job);
            return { ...r, files: (r.files || []).map(f => ({ name: f.name, text: new TextDecoder().decode(f.bytes) })) };
        };
    }, `${base}/pyodide/`);
});

test.after(async () => {
    if (launched && launched.browser) await launched.browser.close();
    if (server) server.close();
});

const skipBrowser = () => (launched && launched.skip) || false;

test('run_code is documented well enough to use', () => {
    const [tool] = Code.buildCodeTools({ runner: { run: async () => ({}) } });
    assert.equal(tool.name, 'run_code');
    assert.deepEqual(Guide.checkToolDocs(tool), []);
    assert.match(Guide.toolGuideNote([tool]), /run_code/);
});

test('attached files become files in /data', () => {
    const files = Code.attachmentFiles([
        { name: 'report.pdf', text: 'Page 1 text' },
        { name: 'stats.xlsx', sheets: [{ name: 'Sheet1', columns: ['Player', 'Points'], rows: [['Ann, "A"', 30], ['Bo', null]] }] },
        { name: 'book.xlsx', sheets: [{ name: 'A', columns: ['x'], rows: [[1]] }, { name: 'B', columns: ['y'], rows: [[2]] }] }
    ]);
    assert.deepEqual(files.map(f => f.path), ['/data/report.txt', '/data/stats.csv', '/data/book - A.csv', '/data/book - B.csv']);
    assert.equal(files[1].text, 'Player,Points\n"Ann, ""A""",30\nBo,');
});

test('the tool shows charts and keeps saved files as downloads', async () => {
    const kept = [], saved = [];
    const runner = { run: async () => ({ language: 'python', ms: 1200, stdout: 'mean 4.5\n', result: '4.5', images: ['iVBORw0KGgo='], files: [{ name: 'out.csv', bytes: new TextEncoder().encode('a,b\n1,2') }] }) };
    const [tool] = Code.buildCodeTools({
        runner,
        attachments: async () => [],
        keepImages: async (content, name) => { kept.push(...content); return content.length; },
        saveFile: async record => { saved.push(record); return { id: 'f1' }; }
    });
    const ctx = {};
    const text = await tool.run({ code: 'print(1)' }, ctx);
    assert.match(text, /Ran Python in 1\.2 s/);
    assert.match(text, /mean 4\.5/);
    assert.match(text, /1 chart\(s\) made/);
    assert.match(text, /out\.csv/);
    assert.equal(kept[0].mimeType, 'image/png');
    assert.equal(saved[0].mime, 'text/csv');
    assert.equal(ctx.generatedFiles[0].fileId, 'f1');
    assert.match(await tool.run({ code: '  ' }, {}), /^Not run/);
});

test('a Python that can\'t download says what to do', async () => {
    const [tool] = Code.buildCodeTools({ runner: { run: async () => ({ setup: true, error: "Python couldn't start: NetworkError" }) } });
    assert.match(await tool.run({ code: 'print(1)' }, {}), /cdn\.jsdelivr\.net.*JavaScript instead/);
});

test('JavaScript prints, returns the last value and reports errors', async t => {
    if (skipBrowser()) return t.skip(launched.skip);
    const r = await page.evaluate(() => runIt({ language: 'javascript', code: 'const xs = [1, 2, 3];\nconsole.log("sum", xs.reduce((a, b) => a + b));\nxs.map(x => x * 2)' }));
    assert.equal(r.stdout, 'sum 6\n');
    assert.equal(JSON.parse(r.result).join(','), '2,4,6');
    const bad = await page.evaluate(() => runIt({ language: 'javascript', code: 'null.x' }));
    assert.match(bad.error, /TypeError/);
    const oneLine = await page.evaluate(() => runIt({ language: 'javascript', code: 'console.log("hi"); 2 ** 10;' }));
    assert.equal(oneLine.stdout, "hi\n");
    assert.equal(oneLine.result, "1024");
    const awaited = await page.evaluate(() => runIt({ language: 'javascript', code: 'await new Promise(r => setTimeout(r, 10));\nfiles["a.txt"].length', files: [{ path: '/data/a.txt', text: 'hello' }] }));
    assert.equal(awaited.result, '5');
    // No page, cookies or storage inside the worker.
    const sandboxed = await page.evaluate(() => runIt({ language: 'javascript', code: 'typeof document + " " + typeof localStorage' }));
    assert.equal(sandboxed.result, 'undefined undefined');
});

test('code that runs too long is stopped and the next run still works', async t => {
    if (skipBrowser()) return t.skip(launched.skip);
    const r = await page.evaluate(() => runIt({ language: 'javascript', code: 'while (true) {}', timeout_seconds: 1 }));
    assert.equal(r.timedOut, true);
    assert.match(Code.formatResult(r), /stopped after 1 seconds/);
    const next = await page.evaluate(() => runIt({ language: 'javascript', code: '6 * 7' }));
    assert.equal(next.result, '42');
});

test('Python prints, reads /data, saves /out, keeps variables and shows tracebacks', { timeout: 180000 }, async t => {
    if (skipBrowser()) return t.skip(launched.skip);
    if (!PYODIDE_DIR) return t.skip('set CODEV_PYODIDE_DIR to a folder with pyodide.js to run the Python tests');
    const first = await page.evaluate(() => runIt({
        language: 'python',
        code: "import csv, os\nrows = list(csv.DictReader(open('/data/stats.csv')))\ntotal = sum(int(r['Points']) for r in rows)\nprint('players', len(rows))\nopen('/out/total.txt', 'w').write(str(total))\ntotal",
        files: [{ path: '/data/stats.csv', text: 'Player,Points\nAnn,30\nBo,12' }]
    }));
    assert.equal(first.error, null, first.error);
    assert.equal(first.stdout, 'players 2\n');
    assert.equal(first.result, '42');
    assert.deepEqual(first.files, [{ name: 'total.txt', text: '42' }]);
    const again = await page.evaluate(() => runIt({ language: 'python', code: 'total * 2' }));
    assert.equal(again.result, '84');
    assert.deepEqual(again.files, [], '/out is emptied before each run');
    const bad = await page.evaluate(() => runIt({ language: 'python', code: 'def f():\n    return 1 / 0\nf()' }));
    assert.match(bad.error, /ZeroDivisionError: division by zero/);
    assert.match(bad.error, /line 2, in f/);
    const slow = await page.evaluate(() => runIt({ language: 'python', code: 'while True: pass', timeout_seconds: 2 }));
    assert.equal(slow.timedOut, true);
    const fresh = await page.evaluate(() => runIt({ language: 'python', code: "'total' in globals()" }));
    assert.equal(fresh.result, 'False');
});
