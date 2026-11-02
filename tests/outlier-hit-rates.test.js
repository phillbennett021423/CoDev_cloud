// The hit-rate finder: the ranking and tickets on their own, then a stand-in
// Outlier board (headless Chromium) whose filter panel CoDev has to set (Hit Rate
// L5 from 60%) for the legs to show, and the cooldown after Outlier says 429.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { hitRateLegs, buildTickets, hitRatesText, bothSides } = require('../agents/outlier/hit-rates');
const { createOutlierPipeline, createService } = require('../agents/outlier');
const { launchBrowser } = require('./helpers/page-driver');

const prop = (player, game, market, line, price, l5, l10, side = 'over') => ({
    player, game, market, line, side, odds: [{ book: 'fanduel', price }], hitRates: { l5, l10 }
});

test('legs at 60%+ in the last 5 are ranked, Overs and Unders, without players who have injury news', () => {
    const props = [
        prop('Jayson Tatum', 'BOS-NYK', 'Points', 26.5, -119, 0.8, 0.7),
        prop('Jalen Brunson', 'BOS-NYK', 'Points', 25.5, -120, 1, 0.9),
        prop('Tyrese Maxey', 'MIA-PHI', 'Assists', 6.5, -110, 0.2, 0.3),
        prop('Devin Booker', 'PHX-SAC', 'Points', 28.5, -105, 0.4, 0.5)
    ];
    const found = hitRateLegs(props, { min: 0.6, injuries: [{ player: 'Jalen Brunson', status: 'questionable' }] });
    assert.deepEqual(found.legs.map(l => `${l.player} ${l.side}`), ['Jayson Tatum over', 'Tyrese Maxey under', 'Devin Booker under']);
    assert.equal(found.legs[1].hitRates.l5, 0.8, 'the Under\'s rate is 100% minus the Over\'s at a .5 line');
    assert.deepEqual(found.counts.injured, ['Jalen Brunson (questionable)']);
    assert.equal(hitRateLegs(props, { min: 0.6, side: 'over' }).legs.length, 2);
    // A whole-number line can push, so its Under isn't worked out from the Over.
    assert.equal(bothSides([prop('A B', 'X-Y', 'Points', 20, -110, 0.2, 0.2)]).length, 1);
});

test('a 4-leg ticket takes regular lines near -119, one leg per game and per player', () => {
    const props = [
        prop('Shai Gilgeous-Alexander', 'MIN-OKC', 'Points', 30.5, -130, 1, 0.8),
        prop('Anthony Edwards', 'MIN-OKC', 'Points', 27.5, -115, 0.8, 0.8),
        prop('Domantas Sabonis', 'PHX-SAC', 'Rebounds', 12.5, -280, 1, 1),
        prop('Nikola Jokic', 'DEN-LAL', 'Rebounds', 11.5, -118, 0.8, 0.8),
        prop('Nikola Jokic', 'DEN-LAL', 'Assists', 9.5, -120, 0.8, 0.8),
        prop('Jayson Tatum', 'BOS-NYK', 'Points', 26.5, -119, 0.8, 0.7),
        prop('Tyrese Maxey', 'MIA-PHI', 'Assists', 6.5, -110, 0.8, 0.6)
    ];
    const found = hitRateLegs(props, { min: 0.6 });
    const [ticket] = buildTickets(found.legs, { size: 4 });
    assert.ok(ticket.allRegular);
    assert.deepEqual(ticket.legs.map(l => l.player), ['Shai Gilgeous-Alexander', 'Nikola Jokic', 'Jayson Tatum', 'Tyrese Maxey']);
    assert.equal(new Set(ticket.legs.map(l => l.gameKey)).size, 4);
    const text = hitRatesText(found, { tickets: [ticket], size: 4, payout: 10 });
    assert.match(text, /4-leg ticket, regular lines, pays 10x:\n1\) Shai Gilgeous-Alexander Over 30\.5 Points \(MIN vs OKC\): -130 fanduel · L5 100% · L10 80%/);
    assert.match(text, /Domantas Sabonis Over 12\.5 Rebounds/, 'a -280 leg is still on the list, just not on the ticket');
});

test('rows without hit rates say so instead of an empty answer', () => {
    const text = hitRatesText(hitRateLegs([{ player: 'A B', line: 1.5, side: 'over', odds: [{ price: -110 }], hitRates: {} }]), {});
    assert.match(text, /none came with hit rates/);
});

// Rows: player, matchup, market, side, line, odds, L5 %, L10 %.
const ROWS = [
    ['Jayson Tatum', 'BOS @ NYK', 'Points', 'Over', 26.5, -119, 80, 70],
    ['Jalen Brunson', 'BOS @ NYK', 'Points', 'Over', 25.5, -120, 100, 90],
    ['Nikola Jokic', 'DEN @ LAL', 'Rebounds', 'Over', 11.5, -118, 80, 80],
    ['LeBron James', 'DEN @ LAL', 'Points', 'Over', 24.5, -125, 60, 60],
    ['Anthony Edwards', 'MIN @ OKC', 'Points', 'Over', 27.5, -115, 60, 50],
    ['Shai Gilgeous-Alexander', 'MIN @ OKC', 'Points', 'Over', 30.5, -130, 100, 80],
    ['Tyrese Maxey', 'PHI @ MIA', 'Assists', 'Under', 6.5, -115, 80, 70],
    ['Devin Booker', 'PHX @ SAC', 'Points', 'Over', 28.5, -105, 40, 40]
];
// The board shows every row until the panel's Hit Rate filter is set; the
// finder's answer has to come from the filtered board, so a ticket that holds
// only 60%+ legs means the filter was set (Booker's 40% must be gone).
const board = ({ limitedApi = false } = {}) => `<!doctype html><body><button id="fb" aria-label="Filters">☰</button><main id="b"></main>
    <div class="inj">Jalen Brunson (NYK) - Questionable</div>
    <div id="panel" hidden><h3>Current filters</h3>
      <div><span>Players</span><input id="ps" placeholder="Search players"></div>
      <div><span>Games</span></div>
      <div><span>Hit Rate</span><div><button id="t5" aria-pressed="false">L5</button><button id="t10" aria-pressed="false">L10</button></div>
        <input id="hfrom" placeholder="From" value=""><input id="hto" placeholder="To" value="100"></div>
      <div><span>Odds</span><span>At least -300</span></div>
      <div><span>Over/Under</span><button id="so" role="checkbox" aria-checked="false">Over</button><button id="su" role="checkbox" aria-checked="false">Under</button></div>
      <div><span>Include alternative lines</span><button role="switch" id="alt" aria-checked="false"></button></div>
      <button id="save">SAVE FILTERS</button><button id="show">SHOW RESULTS</button>
    </div><script>
    ${limitedApi ? "fetch('/api/props'); fetch('/api/props');" : ''}
    const rows = ${JSON.stringify(ROWS)}; const state = { win: null, from: 0 };
    const b = document.getElementById('b'), panel = document.getElementById('panel');
    function draw() {
        b.innerHTML = rows.filter(r => !state.win || r[state.win === 'l5' ? 6 : 7] >= state.from).map(r => '<div><div>' + r[0] + '</div><div>' + r[1] + '</div><div>' + r[2] + '</div><div>' + r[3] + ' ' + r[4] + '</div><div>FanDuel ' + r[5] + '</div><div>L5 ' + r[6] + '% L10 ' + r[7] + '%</div></div>').join('');
    }
    draw();
    document.getElementById('fb').onclick = () => { panel.hidden = false; };
    for (const id of ['t5', 't10']) document.getElementById(id).onclick = e => { document.querySelectorAll('#t5,#t10').forEach(t => t.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); };
    document.getElementById('save').onclick = () => { b.innerHTML = ''; };
    document.getElementById('show').onclick = () => {
        state.win = document.getElementById('t5').getAttribute('aria-pressed') === 'true' ? 'l5' : document.getElementById('t10').getAttribute('aria-pressed') === 'true' ? 'l10' : null;
        state.from = Number(document.getElementById('hfrom').value) || 0;
        panel.hidden = true; draw();
    };
    </script></body>`;

async function finder(t, opts = {}) {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const html = board(opts);
    const hits = { board: 0, api: 0 };
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/api/')) { hits.api++; res.writeHead(429); return res.end('{}'); }
        hits.board++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/NBA/props`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false }));
    return { service: createService({}, { pipeline }), hits };
}

test('the finder sets Outlier\'s Hit Rate filter (L5 from 60%), ranks the legs and builds a 4-leg ticket from different games', async t => {
    const ctx = await finder(t);
    if (!ctx) return;
    const out = await ctx.service.callTool('outlier_find_hit_rates', { sport: 'NBA' });
    const text = out.content[0].text;
    assert.equal(out.isError, undefined, text);
    assert.match(text, /filters: hit rate L5 from 60%/, 'the steps say the filter was set');
    assert.doesNotMatch(text, /Devin Booker Over/, 'the filtered board never showed his 40% Over');
    assert.match(text, /Left out for injury news: Jalen Brunson \(questionable\)/);
    assert.match(text, /4-leg ticket, regular lines, pays 10x:\n1\) Shai Gilgeous-Alexander Over 30\.5 Points[^\n]*\n2\) Nikola Jokic Over 11\.5 Rebounds[^\n]*\n3\) (Jayson Tatum Over 26\.5 Points|Tyrese Maxey Under 6\.5 Assists)[^\n]*\n4\) (Jayson Tatum Over 26\.5 Points|Tyrese Maxey Under 6\.5 Assists)/);
    // Asked again a moment later: the same read, Outlier isn't opened again.
    const loads = ctx.hits.board;
    const again = await ctx.service.callTool('outlier_find_hit_rates', { sport: 'NBA' });
    assert.match(again.content[0].text, /\(reused\)/);
    assert.equal(ctx.hits.board, loads);
});

test('after Outlier says 429, CoDev stops opening Outlier for a while and answers from the last read', async t => {
    const ctx = await finder(t, { limitedApi: true });
    if (!ctx) return;
    const first = await ctx.service.callTool('outlier_find_hit_rates', { sport: 'NBA' });
    assert.equal(first.isError, undefined, first.content[0].text);
    assert.ok(ctx.hits.api >= 2);
    const loads = ctx.hits.board;
    const again = await ctx.service.callTool('outlier_find_hit_rates', { sport: 'NBA', fresh: true });
    assert.match(again.content[0].text, /reused: Outlier is rate-limiting/);
    assert.match(again.content[0].text, /4-leg ticket/);
    const other = await ctx.service.callTool('outlier_research', { sport: 'NBA', player: 'Jayson Tatum' });
    assert.equal(other.isError, true);
    assert.match(other.content[0].text, /Outlier rate-limited CoDev \(429\)[^\n]*Don't call Outlier tools again/);
    assert.equal(ctx.hits.board, loads, 'Outlier wasn\'t opened during the cooldown');
});
