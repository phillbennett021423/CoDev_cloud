// The Outlier pipeline: the text parser, the in-page collector against a
// stand-in board (headless Chromium), and a full scrape -> analyze -> track ->
// learn run through the pipeline with its own persistent profile. The parts that
// need Chromium or Python skip when they're missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseText, parseTable, parseResult, parseCollected, collectPage } = require('../agents/outlier/extract');
const { createOutlierPipeline, sameLeg } = require('../agents/outlier');
const { launchBrowser } = require('./helpers/page-driver');

const BOARD = fs.readFileSync(path.join(__dirname, 'fixtures', 'outlier-board.html'), 'utf8');
const hasPython = ['python3', 'python'].some(cmd => spawnSync(cmd, ['--version']).status === 0);

test('a prop card becomes a prop', () => {
    const prop = parseText('NBA\nLAL @ DEN\nNikola Jokic\nRebounds\nOver 11.5\nFanDuel −145\nDraftKings -150\nL5 80%  L10 70%\nLast 5: 14, 13, 12, 9, 15');
    assert.equal(prop.player, 'Nikola Jokic');
    assert.equal(prop.market, 'Rebounds');
    assert.equal(prop.line, 11.5);
    assert.equal(prop.side, 'over');
    assert.equal(prop.league, 'NBA');
    assert.equal(prop.game, 'DEN-LAL');
    assert.deepEqual(prop.odds, [{ book: 'fanduel', price: -145 }, { book: 'draftkings', price: -150 }]);
    assert.deepEqual(prop.hitRates, { l5: 0.8, l10: 0.7 });
    assert.deepEqual(prop.recent, [14, 13, 12, 9, 15]);
});

test('consensus, fractions and pick-em words', () => {
    const prop = parseText('Jayson Tatum\nPoints\nLess 27.5\nConsensus -132\nL5 4/5');
    assert.equal(prop.side, 'under');
    assert.equal(prop.consensus, -132);
    assert.equal(prop.hitRates.l5, 0.8);
    assert.equal(parseText('Jayson Tatum\nPoints 27.5'), null, 'no odds, no prop');
});

test('an odds table maps book columns and hit-rate columns', () => {
    const props = parseTable({ headers: ['Player', 'Prop', 'Line', 'FanDuel', 'DK DraftKings', 'L5', 'L10'],
        rows: [['Anthony Edwards', 'Points', 'o25.5', '-138', '-135', '80%', '7/10']] });
    assert.equal(props.length, 1);
    assert.deepEqual(props[0].odds.map(o => o.price), [-138, -135]);
    assert.deepEqual(props[0].hitRates, { l5: 0.8, l10: 0.7 });
    assert.equal(props[0].side, 'over');
    assert.deepEqual(parseTable({ headers: ['Team', 'Spread'], rows: [['LAL', '-3.5']] }), [], 'not a props table');
});

test('settled legs from a history page', () => {
    assert.deepEqual(parseResult('Nikola Jokic\nRebounds Over 11.5\nWon'), { player: 'Nikola Jokic', market: 'Rebounds', line: 11.5, side: 'over', result: 'hit', text: 'Nikola Jokic\nRebounds Over 11.5\nWon' });
    assert.equal(parseResult('Jayson Tatum Points U 27.5 ✗').result, 'miss');
    assert.ok(sameLeg({ player: 'Nikola Jokić', line: 11.5, side: 'over', market: 'Rebounds' }, { player: 'nikola jokić', line: '11.5', market: 'rebounds' }));
});

test('the collector finds cards and tables on a page it has never seen', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const page = await launched.browser.newPage();
    await page.setContent(BOARD);
    const collected = await page.evaluate(collectPage, null);
    const { props } = parseCollected([{ kind: 'props', collected }]);
    const byPlayer = Object.fromEntries(props.map(p => [p.player, p]));
    assert.deepEqual(Object.keys(byPlayer).sort(), ['Anthony Edwards', 'Jayson Tatum', 'Nikola Jokic', 'Rudy Gobert']);
    assert.equal(byPlayer['Rudy Gobert'].side, 'under');
    assert.deepEqual(byPlayer['Anthony Edwards'].odds.map(o => o.book), ['fanduel', 'draftkings'], 'logo alt text names the book');
    assert.equal(byPlayer['Nikola Jokic'].odds.length, 2);
});

test('scrape, analyze, track an entry and learn from it, with a profile that persists', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();

    // Four strong props (so a 4-leg entry exists) plus the stand-in board, behind a
    // pretend sign-in: the first visit sets a cookie, later ones need it.
    const extra = ['Shai Gilgeous-Alexander', 'Luka Doncic', 'Tyrese Haliburton', 'Domantas Sabonis'].map((name, i) => `
        <div><div>${name}</div><div>Points</div><div>Over ${20 + i}.5</div><div>FanDuel -160</div><div>DraftKings -165</div>
        <div>L5 100%</div><div>Last 10: ${Array(10).fill(26 + i).join(', ')}</div></div>`).join('');
    const board = BOARD.replace('</body>', `${extra}</body>`);
    const server = http.createServer((req, res) => {
        if (req.url === '/login') { res.writeHead(302, { 'Set-Cookie': 'session=ok; Path=/; Max-Age=3600', Location: '/board' }); return res.end(); }
        if (req.url === '/signin') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<form><input type="password"></form>'); }
        if (!/session=ok/.test(req.headers.cookie || '')) { res.writeHead(302, { Location: '/signin' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(board);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {} });
    // Written straight to the file: setConfig refuses this computer's own addresses.
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url: `${base}/board` }], settleMs: 50, scrolls: 1 }));

    await assert.rejects(pipeline.scrape(), /asked to sign in/);
    assert.equal(pipeline.state().signedIn, false);

    // "Signing in": visit /login with the pipeline's own profile, as the sign-in window would.
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url: `${base}/login` }], settleMs: 50, scrolls: 1 }));
    await pipeline.scrape();
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url: `${base}/board` }], settleMs: 50, scrolls: 1 }));
    // A fresh pipeline object on the same folder: the cookie came from disk.
    const again = createOutlierPipeline({ dataDir, log: () => {} });
    await again.scrape();
    const state = again.state();
    assert.equal(state.signedIn, true);
    assert.ok(state.profileSaved);
    assert.equal(state.result.counts.props, 8);
    const gobert = state.result.legs.find(l => l.player === 'Rudy Gobert');
    assert.ok(gobert.rejected.some(r => /juice|L5/.test(r)), 'light juice and a 40% L5 are filtered out');
    const power4 = state.result.slips.find(s => s.type === 'power' && s.size === 4);
    assert.ok(power4, 'a 4-leg power entry is recommended');

    const entry = again.track(power4.id);
    assert.equal(entry.legs.length, 4);
    const report = await again.recordOutcomes(entry.id, Object.fromEntries(entry.legs.map((l, i) => [l.id, i ? 'hit' : 'miss'])));
    assert.equal(report.settledLegs, 4);
    assert.match(report.notes[0], /start adjusting at 20/);
    // Results read off a history page settle open legs by player, line and side.
    const open = again.track(power4.id);
    assert.equal(again.settleFromResults([{ player: open.legs[0].player, line: open.legs[0].line, side: open.legs[0].side, result: 'hit' }]), 1);
});
