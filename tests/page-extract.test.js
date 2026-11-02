// Structured scraping (mobile/www/agent-ui/page-extract.js): product cards drawn by a
// script, tables and ARIA grids, schema.org JSON-LD, Next pages, Load more and infinite
// scroll, a saved selector after a redesign, field mapping, and a bot-check page.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const PE = require('../mobile/www/agent-ui/page-extract.js');
const { launchBrowser } = require('./helpers/page-driver');

const FIXTURES = path.join(__dirname, 'fixtures', 'extract');

function serve() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const file = path.join(FIXTURES, path.basename(new URL(req.url, 'http://x').pathname));
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end('missing'); }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(fs.readFileSync(file));
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }));
    });
}

// The same adapter shape browser-tools.js gives runExtraction, over a Playwright page.
function adapterFor(page, base) {
    return {
        evaluate: (source, arg) => page.evaluate(`(${source})(${JSON.stringify(arg)})`),
        navigate: url => page.goto(new URL(url, base).href, { waitUntil: 'load' }),
        click: selector => page.locator(selector).first().click(),
        settle: () => page.waitForLoadState('domcontentloaded').catch(() => {}),
        sleep: ms => new Promise(r => setTimeout(r, ms))
    };
}

let launched, site;
test.before(async () => { launched = await launchBrowser(); site = await serve(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); if (site) site.server.close(); });

async function open(t, file) {
    if (launched.skip) { t.skip(launched.skip); return null; }
    const page = await launched.browser.newPage();
    t.after(() => page.close());
    await page.goto(site.base + file, { waitUntil: 'load' });
    return page;
}

test('script-drawn product cards become rows, fields map by name and by value, and Next pages are followed', async t => {
    const page = await open(t, 'shop-1.html');
    if (!page) return;
    const result = await PE.runExtraction(adapterFor(page, site.base), { fields: ['name', 'price', 'rating', 'reviews', 'url'], pages: 3 });
    assert.equal(result.kind, 'cards');
    assert.equal(result.pages, 2, 'page 2 has no Next link');
    assert.deepEqual(result.columns, ['name', 'price', 'rating', 'reviews', 'url']);
    assert.equal(result.rows.length, 8);
    assert.deepEqual(result.rows[0], ['Aero 14 Laptop', '$899.00', '4.5 out of 5 stars', '1,204 reviews', `${site.base}p/aero`]);
    assert.equal(result.rows[4][0], 'Echo 14');
    assert.ok(result.notes.some(n => /No "next page"/.test(n)));
    assert.ok(result.selector.includes('product-card'), 'the item selector is kept for later calls');
    const out = PE.toolResult(result, { name: 'Laptops' });
    assert.equal(out.isError, false);
    assert.equal(out.structuredContent.dataset.rows.length, 8);
    assert.match(out.content[0].text, /8 row\(s\) × 5 column\(s\) from 2 page\(s\)/);
});

test('a saved selector that no longer matches after a redesign falls back to finding the data again', async t => {
    const page = await open(t, 'redesign.html');
    if (!page) return;
    const result = await PE.runExtraction(adapterFor(page, site.base), { selector: '#results > div.product-card', fields: ['name', 'price'] });
    assert.ok(result.notes.some(n => /layout probably changed/.test(n)));
    assert.deepEqual(result.rows.map(r => r[0]), ['Aero 14 Laptop', 'Blade Pro 16', 'Cobalt Air 13']);
    assert.deepEqual(result.rows.map(r => r[1]), ['$899.00', '$1,499.99', '$649.50']);
});

test('tables, ARIA grids and JSON-LD are all candidates, and candidate picks another', async t => {
    const page = await open(t, 'table.html');
    if (!page) return;
    const adapter = adapterFor(page, site.base);
    const first = await PE.runExtraction(adapter, {});
    const kinds = [first.kind, ...first.others.map(o => o.kind)];
    assert.ok(kinds.includes('table') && kinds.includes('grid') && kinds.includes('jsonld'), kinds.join(','));
    const pickIndex = kind => (first.kind === kind ? 0 : first.others.find(o => o.kind === kind).index);
    const table = await PE.runExtraction(adapter, { candidate: pickIndex('table') });
    assert.deepEqual(table.columns, ['Team', 'W', 'L', 'Pct']);
    assert.deepEqual(table.rows[2], ['Rams', '5', '7', '.417']);
    const ld = await PE.runExtraction(adapter, { candidate: pickIndex('jsonld') });
    assert.ok(ld.columns.includes('name') && ld.columns.includes('location.name'));
    assert.deepEqual(ld.rows.map(r => r[ld.columns.indexOf('name')]), ['Final', 'Semi']);
});

test('infinite scroll and Load more buttons load more rows', async t => {
    const page = await open(t, 'feed.html');
    if (!page) return;
    await page.setViewportSize({ width: 800, height: 300 });
    const scrolled = await PE.runExtraction(adapterFor(page, site.base), { scroll: 5, fields: ['author', 'body', 'date'] });
    assert.equal(scrolled.rows.length, 15);
    assert.deepEqual(scrolled.rows[14], ['user15', 'Post number 15 says something long enough', '2026-10-15']);
    const page2 = await open(t, 'more.html');
    const more = await PE.runExtraction(adapterFor(page2, site.base), { pages: 3 });
    assert.equal(more.rows.length, 15, 'Load more clicked twice');
});

test('a bot-check page is reported for the user, not worked around', async t => {
    const page = await open(t, 'captcha.html');
    if (!page) return;
    const result = await PE.runExtraction(adapterFor(page, site.base), {});
    const out = PE.toolResult(result);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /bot check or CAPTCHA.*live view/);
});

test('mapFields matches by value shape when the page names columns oddly', () => {
    const m = PE.mapFields(['x1', 'x2', 'x3'], [['https://a.com/1', 'Widget A', '€12,50'], ['https://a.com/2', 'Widget B', '€9']], ['price', 'url', 'name', 'stock']);
    assert.deepEqual(m.rows[0], ['€12,50', 'https://a.com/1', 'Widget A', null]);
    assert.deepEqual(m.missing, ['stock']);
});
