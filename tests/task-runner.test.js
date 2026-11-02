// Parallel work (mobile/www/agent-ui/task-runner.js): the worker pool, the planner's task
// graph (dependencies, verify-and-retry, skipped dependents), wide research with its
// second search for missing fields, and the tools' reports. Stand-ins replace the model
// and the web, so no key or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../mobile/www/agent-ui/task-runner.js');
const F = require('../mobile/www/agent-ui/file-builder.js');
const PE = require('../mobile/www/agent-ui/page-extract.js');

const tick = ms => new Promise(r => setTimeout(r, ms));

test('runPool keeps order, runs in parallel up to the limit, and reports errors per item', async () => {
    let live = 0, peak = 0;
    const out = await T.runPool([1, 2, 3, 4, 5, 6], async n => {
        live++; peak = Math.max(peak, live);
        await tick(20);
        live--;
        if (n === 4) throw new Error('boom');
        return n * 10;
    }, { concurrency: 3 });
    assert.equal(peak, 3);
    assert.deepEqual(out.map(r => (r.ok ? r.value : r.error)), [10, 20, 30, 'boom', 50, 60]);
});

test('the task graph runs independent tasks together, passes results along, and retries with the problem', async () => {
    const started = [];
    const calls = [];
    const { tasks, notes } = await T.runTaskGraph([
        { id: 'a', task: 'find A prices', expect: 'a price' },
        { id: 'b', task: 'find B prices' },
        { id: 'c', task: 'compare', depends_on: ['a', 'b', 'nope'] },
        { id: 'd', task: 'broken', expect: 'anything' },
        { id: 'e', task: 'after broken', depends_on: ['d'] }
    ], {
        concurrency: 2,
        runTask: async (task, inputs, attempt, feedback) => {
            started.push(task.id);
            calls.push({ id: task.id, attempt, feedback, inputs: inputs.map(i => i.result) });
            await tick(10);
            if (task.id === 'a') return attempt === 1 ? 'I looked around.' : 'A costs $5 (https://a.example)';
            if (task.id === 'd') return 'Error: site down';
            if (task.id === 'c') return `compared: ${inputs.map(i => i.result).join(' / ')}`;
            return 'B costs $7';
        },
        verify: async (task, text) => (/\$\d/.test(text) ? { ok: true } : { ok: false, problem: 'no price in the result' })
    });
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    assert.deepEqual(started.slice(0, 2).sort(), ['a', 'b'], 'a and b start together');
    assert.equal(byId.a.status, 'done');
    assert.equal(byId.a.attempts, 2);
    assert.match(calls.find(c => c.id === 'a' && c.attempt === 2).feedback, /no price in the result/);
    assert.equal(byId.c.status, 'done');
    assert.match(byId.c.result, /A costs \$5.*B costs \$7/);
    assert.equal(byId.d.status, 'failed');
    assert.equal(byId.e.status, 'skipped');
    assert.match(byId.e.problem, /needs d/);
    assert.ok(notes.some(n => /unknown dependency nope/.test(n)));
});

test('a dependency cycle is broken instead of waiting forever', async () => {
    const { tasks, notes } = await T.runTaskGraph([{ id: 'x', task: 'x', depends_on: ['y'] }, { id: 'y', task: 'y', depends_on: ['x'] }], { runTask: async t => `did ${t.id}` });
    assert.ok(tasks.every(t => t.status === 'done'));
    assert.ok(notes.some(n => /cycle/.test(n)));
});

// A tiny web: search results and pages per query, and a model that reads the notes.
function fakeWeb() {
    const pages = {
        'https://acme.example/about': 'Acme was founded in 1999. Headquarters: Denver.',
        'https://bolt.example/about': 'Bolt, headquarters Austin.',
        'https://bolt.example/history': 'Bolt was founded in 2011.',
        'https://list.example/top': 'Top firms: Acme, Bolt, Cyan.'
    };
    const searches = [];
    return {
        searches,
        search: async q => {
            searches.push(q);
            if (/top firms/.test(q)) return { results: [{ title: 'List', href: 'https://list.example/top', body: 'Acme, Bolt, Cyan' }] };
            if (/^Acme/.test(q)) return { results: [{ title: 'Acme', href: 'https://acme.example/about', body: '' }] };
            if (/^Bolt founded$/.test(q)) return { results: [{ title: 'Bolt history', href: 'https://bolt.example/history', body: '' }] };
            if (/^Bolt/.test(q)) return { results: [{ title: 'Bolt', href: 'https://bolt.example/about', body: '' }] };
            if (/^Cyan/.test(q)) throw new Error('search failed');
            return { results: [] };
        },
        read: async url => pages[url] || '',
        ask: async (system, user) => {
            if (/JSON array/.test(system)) return '["Acme", "Bolt", "Cyan"]';
            const wanted = [...system.matchAll(/"([^"_]+)"/g)].map(m => m[1]);
            const out = { _sources: [1] };
            for (const f of wanted) {
                if (f === 'founded') { const m = /founded in (\d{4})/.exec(user); out.founded = m ? m[1] : null; }
                if (f === 'headquarters') { const m = /[Hh]eadquarters:? (\w+)/.exec(user); out.headquarters = m ? m[1] : null; }
            }
            return JSON.stringify(out);
        }
    };
}

test('wide research builds the list, researches every item in parallel and searches again for what is missing', async () => {
    const web = fakeWeb();
    const out = await T.wideResearch({ ...web, concurrency: 3, pagesPerItem: 1, maxItems: 10 }, { discover: 'top firms', fields: ['founded', 'headquarters'] });
    assert.deepEqual(out.items, ['Acme', 'Bolt', 'Cyan']);
    assert.deepEqual(out.columns, ['item', 'founded', 'headquarters', 'sources']);
    assert.deepEqual(out.rows[0].slice(0, 3), ['Acme', '1999', 'Denver']);
    assert.deepEqual(out.rows[1].slice(0, 3), ['Bolt', '2011', 'Austin'], 'the second search found the founding year');
    assert.ok(web.searches.includes('Bolt founded'));
    assert.match(out.rows[1][3], /bolt\.example\/about/);
    assert.deepEqual(out.rows[2].slice(1, 3), [null, null], 'nothing found is left empty, not guessed');
    assert.equal(out.stats.complete, 2);
});

test('the tools: wide_research saves a dataset that create_spreadsheet fills a sheet from', async () => {
    const web = fakeWeb();
    const datasets = F.createDatasetStore();
    const [delegate, wide] = T.buildTaskTools({
        limits: () => T.LIMITS.openrouter,
        shouldStop: () => false,
        datasets, previewTable: PE.previewTable,
        wideDeps: () => ({ ...web, concurrency: 2, pagesPerItem: 1, maxItems: 10 }),
        runWorker: async task => `done: ${task.task}`
    });
    const ctx = { sources: [] };
    const report = await wide.run({ items: ['Acme', 'Bolt'], fields: ['founded', 'headquarters'] }, ctx);
    assert.match(report, /Researched 2 item\(s\) in parallel: 2 complete/);
    assert.match(report, /dataset ds1/);
    assert.ok(ctx.sources.some(s => s.href === 'https://acme.example/about'));
    const saved = [];
    const [sheetTool] = F.buildFileTools({ datasets, saveFile: async rec => { saved.push(rec); return { id: 'f1' }; } });
    const made = await sheetTool.run({ filename: 'firms', sheets: [{ name: 'Firms', dataset: 'ds1' }] }, ctx);
    assert.match(made, /Made firms\.xlsx/);
    assert.equal(saved[0].preview.sheets[0].rows, 3);
    const steps = [];
    const delegated = await delegate.run({ tasks: [{ id: 'one', task: 'first part' }, { id: 'two', task: 'second part', depends_on: ['one'] }] }, { onStep: s => steps.push(s) });
    assert.match(delegated, /2 of 2 worker task\(s\) finished/);
    assert.match(delegated, /## two — done/);
    assert.ok(steps.some(s => /✓ one/.test(s)));
});
