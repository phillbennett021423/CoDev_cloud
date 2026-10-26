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

test("the matchup names the game; the player's team and the game total are read apart", () => {
    const prop = parseText('NBA\nLAL @ DEN\nO/U 231.5\nNikola Jokic\nDEN - C\nRebounds\nOver 11.5\nFanDuel -145');
    assert.equal(prop.line, 11.5, 'the total is not the line');
    assert.equal(prop.side, 'over');
    assert.equal(prop.gameTotal, 231.5);
    assert.equal(prop.team, 'DEN');
    assert.equal(prop.opponent, 'LAL');
    assert.equal(parseText('LAL @ DEN\nNikola Jokic\nRebounds\nOver 11.5\nFanDuel -145').team, undefined, 'unknown, not guessed');
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
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url: `${base}/board` }], settleMs: 50, scrolls: 1, market: false }));

    await assert.rejects(pipeline.scrape(), /asked to sign in/);
    assert.equal(pipeline.state().signedIn, false);

    // "Signing in": visit /login with the pipeline's own profile, as the sign-in window would.
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url: `${base}/login` }], settleMs: 50, scrolls: 1, market: false }));
    await pipeline.scrape();
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url: `${base}/board` }], settleMs: 50, scrolls: 1, market: false }));
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
    // Each scrape logs prices with times and moves open legs' closing price.
    const firstLeg = state.result.legs.find(l => l.id === entry.legs[1].id);
    again.recordPrices({ legs: [{ ...firstLeg, metrics: { ...firstLeg.metrics, consensus: -200, fairProb: 0.64 } }] }, '2026-10-24T01:00:00.000Z');
    const closed = again.state().history.entries[0].legs[1];
    assert.equal(closed.result, 'hit', 'settled legs keep their close');
    assert.equal(closed.closePrice, undefined);
    const log = JSON.parse(fs.readFileSync(again.files.marketLog, 'utf8'));
    assert.equal(log[firstLeg.id].openPrice, firstLeg.metrics.consensus);
    assert.equal(log[firstLeg.id].points.at(-1).price, -200);
    // Stakes: the tracked entry carries the Kelly stake; bankroll settings re-score.
    assert.equal(entry.stake, power4.stakeUnits);
    const after = await again.setStrategy({ bankroll: { units: 500, kelly_fraction: 0.5 }, sizes: [4, 6] });
    assert.equal(after.result.bankroll.units, 500);
    assert.ok(after.result.slips.some(s => s.size === 6) || after.result.notes.some(n => /6-leg/.test(n)));
    await assert.rejects(again.setStrategy({ bankroll: { kelly_fraction: 3 } }), /between/);

    // Results read off a history page settle open legs by player, line and side.
    const open = again.track(power4.id);
    assert.equal(again.settleFromResults([{ player: open.legs[0].player, line: open.legs[0].line, side: open.legs[0].side, result: 'hit' }]), 1);
    again.recordPrices({ legs: [{ ...firstLeg, id: open.legs[2].id, metrics: { ...firstLeg.metrics, consensus: -210, fairProb: 0.66 } }] });
    const openLeg = again.state().history.entries.at(-1).legs[2];
    assert.equal(openLeg.closePrice, -210);
    assert.equal(openLeg.closeFair, 0.66);
});

test('public odds boards are read with a fresh browser and cross-referenced into the scrape', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();

    // A public odds-comparison table (no sign-in) quoting both sides at three books.
    const comparison = `<table><thead><tr><th>Player</th><th>Prop</th><th>Line</th><th>Pinnacle</th><th>BetMGM</th><th>Caesars</th></tr></thead><tbody>
        <tr><td>Nikola Jokic</td><td>Rebounds</td><td>o11.5</td><td>-140</td><td>-150</td><td>-145</td></tr>
        <tr><td>Nikola Jokic</td><td>Rebounds</td><td>u11.5</td><td>+120</td><td>+115</td><td>+110</td></tr></tbody></table>`;
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, cookie: req.headers.cookie || '' });
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'session=ok; Path=/; Max-Age=3600' });
        res.end(req.url === '/compare' ? comparison : BOARD);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-market-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, oddsApiKey: '', log: () => {} });
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url: `${base}/board` }], settleMs: 50, scrolls: 1,
        publicBoards: [`${base}/compare`] }));
    // No network feeds in tests.
    pipeline.setMarketConfig({ odds_api: { enabled: false }, espn: { enabled: false } });

    await pipeline.scrape();
    const state = pipeline.state();
    const board = seen.find(r => r.url === '/compare');
    assert.ok(board, 'the public board was read');
    assert.equal(board.cookie, '', 'with a fresh browser, not the Outlier profile');
    assert.deepEqual(state.market.last.boards, [{ source: '127.0.0.1', props: 2, error: undefined }]);
    assert.ok(state.market.summary.lines >= 1);
    assert.equal(state.market.summary.bookHold.length, 3);

    const jokic = state.result.legs.find(l => l.player === 'Nikola Jokic');
    assert.deepEqual(jokic.odds.map(o => o.book).sort(), ['betmgm', 'caesars', 'draftkings', 'fanduel', 'pinnacle']);
    assert.equal(jokic.metrics.fairSource, 'sharp', 'Pinnacle sets the no-vig price');
    assert.equal(jokic.metrics.marketBooks, 3);

    // Market settings only take known keys and clean lists.
    const cfg = pipeline.setMarketConfig({ odds_api: { sports: 'basketball_nba, americanfootball_nfl', prop_markets: ['player_points', 'bad key!'], apiKey: 'nope' } });
    assert.deepEqual(cfg.odds_api.sports, ['basketball_nba', 'americanfootball_nfl']);
    assert.deepEqual(cfg.odds_api.prop_markets, ['player_points']);
    assert.equal(cfg.odds_api.apiKey, undefined, 'the key never goes in the settings file');
    assert.throws(() => pipeline.setConfig({ publicBoards: ['file:///etc/passwd'] }), /Only http/);
});

test('matchup, usage, pace, potential and minutes are read from cards and tables', () => {
    const { insights } = require('../agents/outlier/extract');
    const card = parseText('NBA\nLAL @ DEN\nJamal Murray\nPoints\nOver 21.5\nFanDuel -119\nL10 70%\nPotential Assists 13.1\nUSG% 27.4\nPace 101.2\nDvP vs PG: 27th\nMinutes: 36, 35, 34, 33, 35');
    assert.equal(card.market, 'Points', '"Potential Assists" does not make it an assists prop');
    assert.deepEqual(card.insights, { defenseRank: 27, position: 'PG', usage: 0.274, pace: 101.2, potential: { assists: 13.1 }, minutes: [36, 35, 34, 33, 35] });
    const [row] = parseTable({ headers: ['Player', 'Prop', 'Line', 'Odds', 'L5', 'USG%', 'Pace', 'DvP', 'Potential AST', 'MIN'],
        rows: [['Jamal Murray', 'Assists', 'o6.5', '-119', '60%', '27.4%', '101.2', '27', '13.1', '34.8']] });
    assert.deepEqual(row.insights, { usage: 0.274, pace: 101.2, defenseRank: 27, potential: { assists: 13.1 }, minutesAvg: 34.8 });
    assert.deepEqual(insights('Rebound Chances 18.2 MIN 31.5 Opp Rank vs C 25/30'), { defenseRank: 25, defenseTeams: 30, position: 'C', potential: { rebounds: 18.2 }, minutesAvg: 31.5 });
});

test('the -119 consistency strategy builds parlay tickets the dashboard shows and tracks', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {} });
    const steady = [24, 22, 19, 25, 23, 18, 26, 22, 17, 24];
    const props = ['A Guard', 'B Wing', 'C Big', 'D Forward', 'E Shooter', 'F Center'].map((player, i) => ({
        id: `p${i}`, player, market: 'Points', line: 20.5, side: 'over', league: 'NBA', team: `T${i}`, game: `G${i}`,
        odds: [{ book: 'fanduel', price: -119 }], hitRates: { l5: 0.8, l10: 0.7 }, recent: steady,
        insights: { defenseRank: 28, minutes: [35, 34, 36, 33, 35] }
    }));
    fs.writeFileSync(pipeline.files.scrape, JSON.stringify({ scrapedAt: new Date().toISOString(), props }));
    const state = await pipeline.setStrategy({ strategy: 'consistency', ticketSizes: [4, 5, 6] });
    assert.equal(state.result.strategy, 'consistency');
    assert.deepEqual([...new Set(state.result.tickets.map(x => x.size))], [4, 5, 6]);
    await assert.rejects(pipeline.setStrategy({ strategy: 'yolo' }), /sharp or consistency/);
    const ticket = state.result.tickets[0];
    const entry = pipeline.track(ticket.id, 1);
    assert.equal(entry.type, 'parlay');
    assert.equal(entry.american, ticket.american);

    // The dashboard draws the tickets with the page's dark theme.
    const page = await launched.browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.setContent('<style>:root{--bg-dark:#090d16;--bg-panel:#111827;--bg-card:#1f2937;--border-color:#374151;--accent:#0ea5e9;--accent-glow:rgba(14,165,233,.2);--text-main:#f3f4f6;--text-muted:#9ca3af;--success:#10b981;--danger:#ef4444;--warning:#f59e0b}</style><div id="v"></div>');
    await page.addScriptTag({ path: path.join(__dirname, '..', 'mobile', 'www', 'agent-ui', 'outlier-view.js') });
    await page.evaluate(s => window.CodevOutlierView.mount(document.getElementById('v'), { getJson: async () => s, postJson: async () => s }), pipeline.state());
    await page.waitForSelector('.ov-ticket');
    const shown = await page.evaluate(() => ({
        tickets: document.querySelectorAll('.ov-ticket').length,
        odds: document.querySelector('.ov-ticket .ov-odds').textContent,
        accent: getComputedStyle(document.querySelector('.ov-ticket .ov-odds')).color,
        text: document.getElementById('v').innerText
    }));
    assert.equal(shown.tickets, state.result.tickets.length);
    assert.equal(shown.odds, `+${ticket.american}`);
    assert.equal(shown.accent, 'rgb(14, 165, 233)');
    assert.match(shown.text, /Consistency \(-119\)/);
    assert.match(shown.text, /soft matchup/);
    assert.match(shown.text, /parlay \+\d+/, 'the tracked ticket shows its odds');
    assert.deepEqual(errors, []);
});

test('injury reports are read from report lines and prop cards', () => {
    const { injuries, parseCollected } = require('../agents/outlier/extract');
    assert.deepEqual(injuries('Joel Embiid (PHI) - Out'), [{ player: 'Joel Embiid', team: 'PHI', status: 'out' }]);
    assert.deepEqual(injuries('Out: Joel Embiid'), [{ player: 'Joel Embiid', team: null, status: 'out' }]);
    assert.deepEqual(injuries('Over 24.5 Out'), []);
    const parsed = parseCollected([{ kind: 'props', collected: {
        injuries: ['Jaylen Brown (BOS) Questionable'],
        cards: ['Tyrese Maxey\nPHI @ BOS\nPoints\nOver 24.5\nFanDuel -119\nTeammate out: Joel Embiid']
    } }]);
    assert.equal(parsed.props.length, 1);
    assert.equal(parsed.props[0].injuries, undefined, 'the list moves to the scrape, off the prop');
    assert.deepEqual(parsed.injuries, [
        { player: 'Jaylen Brown', team: 'BOS', status: 'questionable' },
        { player: 'Joel Embiid', status: 'out', teammateOf: 'Tyrese Maxey' }
    ]);
});

test('orphaned lines, the usage vacuum and the game-script check reach the dashboard', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {} });
    const steady = [24, 22, 19, 25, 23, 18, 26, 22, 17, 24];
    const props = ['A Guard', 'B Wing', 'C Big', 'D Forward', 'E Shooter'].map((player, i) => ({
        id: `p${i}`, player, market: 'Points', line: 20.5, side: 'over', league: 'NBA', team: `T${i}`, game: `G${i}`,
        odds: [{ book: 'fanduel', price: -119 }, ...(i === 0 ? [{ book: 'pinnacle', price: -145 }] : [])],
        oppositeOdds: i === 0 ? [{ book: 'pinnacle', price: 125 }] : [],
        hitRates: { l5: 0.8, l10: 0.7 }, recent: steady, insights: { defenseRank: 28, minutes: [35, 34, 36, 33, 35], usage: 0.24 }
    }));
    // An over that keeps missing in a slow game against a lockdown defense: an under value leg.
    props.push({ id: 'p5', player: 'F Cold', market: 'Points', line: 20.5, side: 'over', league: 'NBA', team: 'T5', game: 'G5',
        odds: [{ book: 'fanduel', price: -119 }], oppositeOdds: [{ book: 'fanduel', price: -105 }], hitRates: { l5: 0.2, l10: 0.3 },
        recent: [17, 18, 22, 16, 19, 17, 23, 18, 16, 19], insights: { pace: 95, defenseRank: 3, position: 'C', minutes: [33, 34, 33, 34, 33] } });
    fs.writeFileSync(pipeline.files.scrape, JSON.stringify({ scrapedAt: new Date().toISOString(), props }));
    await assert.rejects(pipeline.setStrategy({ under: { min_signals: 9 } }), /under min_signals/);
    const state = await pipeline.setStrategy({ strategy: 'consistency', under: { enabled: true, min_signals: 2 }, ruledOut: [{ player: 'Star Guy', team: 'T1', usage: '30' }, { player: '' }] });
    assert.deepEqual(state.weights.vacuum.manual_out, [{ player: 'Star Guy', team: 'T1', usage: 30 }]);
    const legs = new Map(state.result.legs.map(l => [l.id, l]));
    assert.equal(legs.get('p0').metrics.divergence.orphaned, true);
    assert.deepEqual(legs.get('p1').metrics.vacuum.out, ['Star Guy']);
    assert.ok(state.result.tickets.every(x => Array.isArray(x.matrix) && x.script));
    assert.deepEqual(state.result.underLegs.map(l => l.id), ['p5|under']);
    assert.equal(legs.get('p5').route, 'under');

    const page = await launched.browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.setContent('<style>:root{--bg-dark:#090d16;--bg-panel:#111827;--bg-card:#1f2937;--border-color:#374151;--accent:#0ea5e9;--accent-glow:rgba(14,165,233,.2);--text-main:#f3f4f6;--text-muted:#9ca3af;--success:#10b981;--danger:#ef4444;--warning:#f59e0b}</style><div id="v"></div>');
    await page.addScriptTag({ path: path.join(__dirname, '..', 'mobile', 'www', 'agent-ui', 'outlier-view.js') });
    await page.evaluate(s => window.CodevOutlierView.mount(document.getElementById('v'), { getJson: async () => s, postJson: async () => s }), pipeline.state());
    await page.waitForSelector('.ov-pill.sharp');
    const shown = await page.evaluate(() => ({
        text: document.getElementById('v').innerText,
        sharpBg: getComputedStyle(document.querySelector('.ov-pill.sharp')).backgroundColor,
        outs: document.querySelector('textarea[aria-label="Players ruled out"]').value
    }));
    assert.match(shown.text, /Orphaned lines \(1\)/);
    assert.match(shown.text, /Under value legs \(1\)/);
    assert.match(shown.text, /Under Value Leg/);
    assert.match(shown.text, /lockdown defense/);
    assert.match(shown.text, /-145 vs -119 \(fanduel\)/);
    assert.match(shown.text, /vacuum \+/);
    assert.match(shown.text, /game script:/);
    assert.equal(shown.sharpBg, 'rgb(14, 165, 233)');
    assert.equal(shown.outs, 'Star Guy, T1, 30');
    assert.deepEqual(errors, []);
});

test('passive capture collects cards a virtualized board adds and removes, without touching the scroll', async t => {
    const { createCapture } = require('../agents/outlier/capture');
    const { parseText } = require('../agents/outlier/extract');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const context = await launched.browser.newContext();
    const page = await context.newPage();
    // A board that shows 3 rows at a time and swaps them as "you scroll".
    await page.setContent(`<div id="board" style="height:200px;overflow:auto"><div style="height:2000px"><ul id="rows"></ul></div></div>
        <script>
            const players = ['Nikola Jokic','Jamal Murray','Aaron Gordon','Michael Porter','Russell Westbrook','Christian Braun','Peyton Watson','Julian Strawson','DeAndre Jordan'];
            window.show = start => { document.getElementById('rows').innerHTML = players.slice(start, start + 3)
                .map((p, i) => '<li><div>' + p + '</div><div>DEN @ LAL</div><div>Points</div><div>Over ' + (20.5 + i) + '</div><div>FanDuel -119</div></li>').join(''); };
            show(0);
            document.getElementById('board').scrollTop = 120;
        </script>`);
    const fresh = [];
    const capture = createCapture({ getSession: () => ({ context }), parse: (text, url) => parseText(text, { url }), onProps: props => fresh.push(...props), intervalMs: 60000 });
    await capture.start();
    for (const start of [3, 6]) {
        await page.evaluate(s => show(s), start);
        await page.waitForTimeout(150);
    }
    // A price that changes inside a row still on screen is picked up too.
    await page.evaluate(() => { document.querySelector('#rows li:last-child div:last-child').textContent = 'FanDuel -125'; });
    await page.waitForTimeout(1000);
    await capture.drain();
    const status = capture.status();
    assert.equal(status.on, true);
    assert.equal(status.props, 9, 'every row that passed through, including the ones scrolled away');
    assert.deepEqual(new Set(capture.props().map(p => p.player)).size, 9);
    assert.ok(fresh.some(p => p.player === 'DeAndre Jordan' && p.odds[0].price === -125), 'the changed price');
    assert.equal(await page.evaluate(() => document.getElementById('board').scrollTop), 120, 'scroll position untouched');
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    // A page opened later gets the observer before its own scripts run.
    const later = await context.newPage();
    await later.goto(`data:text/html,${encodeURIComponent('<section><div>Bones Hyland</div><div>DEN @ LAL</div><div>Assists</div><div>Over 3.5</div><div>FanDuel -119</div></section>')}`);
    await later.waitForTimeout(1000);
    await capture.drain();
    assert.ok(capture.props().some(p => p.player === 'Bones Hyland'));
    capture.stop();
    assert.equal(capture.status().on, false);
    await assert.rejects(createCapture({ getSession: () => null, parse: () => null }).start(), /Open the Outlier browser/);
});

test('board JSON saved in the project folder is imported and audited, and every analysis writes the board dump', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const { createService } = require('../agents/outlier');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-board-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir: path.join(root, 'data'), getWorkspace: () => path.join(root, 'project'), log: () => {} });
    t.after(() => pipeline.close());
    const service = createService({}, { pipeline });
    const steady = [24, 22, 19, 25, 23, 18, 26, 22, 17, 24];
    const props = ['A Guard', 'B Wing', 'C Big', 'D Forward', 'E Shooter', 'F Center'].map((player, i) => ({
        player, market: 'Points', line: 20.5, side: 'over', league: 'NBA', team: `T${i}`, game: `G${i}`,
        odds: [{ book: 'fanduel', price: -119 }], hitRates: { l5: 0.8, l10: 0.7 }, recent: steady,
        insights: { defenseRank: 28, minutes: [35, 34, 36, 33, 35] }
    }));
    const folder = path.join(root, 'project', 'downloads', 'new folder');
    const dump = path.join(folder, 'outlier_live_board_dump.json');
    assert.ok(fs.existsSync(folder), 'the import folder is ready to drop files into');
    await pipeline.setStrategy({ strategy: 'consistency' });

    // Saved into the folder: picked up, audited, and the dump written next to it.
    fs.writeFileSync(path.join(folder, 'tonight.json'), JSON.stringify({ props }));
    const deadline = Date.now() + 15000;
    while (!(pipeline.state().board.lastImport) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
    const state = pipeline.state();
    assert.deepEqual([state.board.lastImport.file, state.board.lastImport.props], ['tonight.json', 6]);
    assert.equal(state.result.counts.props, 6);
    const written = JSON.parse(fs.readFileSync(dump, 'utf8'));
    assert.equal(written.props.length, 6);
    assert.ok(written.tickets.length > 0 && written.tickets.every(x => x.american && x.legs.length >= 4));
    assert.equal(written.strategy, 'consistency');
    // The dump itself isn't re-imported (no loop).
    const runs = state.board.dump.at;
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(pipeline.state().board.dump.at, runs);

    // Agents run the same audit with a tool; paths outside the project are refused.
    fs.writeFileSync(path.join(root, 'project', 'list.json'), JSON.stringify(props.slice(0, 5)));
    const reply = await service.callTool('outlier_import_board', { path: 'list.json' });
    assert.equal(reply.isError, undefined, reply.content[0].text);
    assert.match(reply.content[0].text, /4-leg ticket [+-]\d+/);
    assert.match(reply.content[0].text, /Estimates, not guarantees/);
    const escape = await service.callTool('outlier_import_board', { path: '../secrets.json' });
    assert.equal(escape.isError, true);
    assert.match(escape.content[0].text, /inside the project folder/);
    fs.writeFileSync(path.join(root, 'project', 'junk.json'), JSON.stringify({ hello: 1 }));
    assert.match((await service.callTool('outlier_import_board', { path: 'junk.json' })).content[0].text, /no props/);
    assert.throws(() => pipeline.setConfig({ boardDump: '/etc/passwd' }), /inside the project folder/);
});

test('the scrape scrolls a board that scrolls inside a panel and drops rows, reading every line, and agents can run it', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    // 30 rows, 4 on screen at a time, in a scrolling panel (the window itself never
    // scrolls), and rows off screen are removed, like a virtualized board.
    const first = ['Nikola', 'Jamal', 'Aaron', 'Michael', 'Russell', 'Christian'], last = ['Jokic', 'Murray', 'Gordon', 'Porter', 'Westbrook'];
    const names = first.flatMap(f => last.map(l => `${f} ${l}`));   // 30 different players
    const page = `<!doctype html><body style="margin:0;overflow:hidden"><div id="panel" style="height:240px;overflow-y:auto"><div id="spacer" style="position:relative;height:${30 * 60}px"></div></div>
        <script>
            const names = ${JSON.stringify(names)};
            const panel = document.getElementById('panel'), spacer = document.getElementById('spacer');
            const draw = () => {
                const first = Math.floor(panel.scrollTop / 60);
                spacer.innerHTML = names.slice(first, first + 4).map((n, k) => '<div style="position:absolute;top:' + (first + k) * 60 + 'px;height:60px"><div>' + n + '</div><div>DEN @ LAL</div><div>Points</div><div>Over ' + (20.5 + ((first + k) % 5)) + '</div><div>FanDuel -119</div></div>').join('');
            };
            panel.addEventListener('scroll', draw); draw();
        </script></body>`;
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/board`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    // Written straight to the file: setConfig refuses this computer's own addresses.
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false }));

    const service = createService({}, { pipeline });
    const refused = await service.callTool('outlier_scan_board', { url: 'https://example.com/' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /only opens Outlier/);

    const reply = await service.callTool('outlier_scan_board', {});
    assert.equal(reply.isError, undefined, reply.content[0].text);
    assert.match(reply.content[0].text, /^30 props/);
    assert.match(reply.content[0].text, /Estimates, not guarantees/);
    const scraped = JSON.parse(fs.readFileSync(pipeline.files.scrape, 'utf8'));
    assert.deepEqual(scraped.props.map(p => p.player).sort(), [...names].sort(), 'every row, including the ones removed as it scrolled');
});

test('a game asked for by time or team is found among Outlier\'s game cards', () => {
    const { parseTime, pickGame, gameTeams, sportLabels, onlyGame } = require('../agents/outlier/navigate');
    assert.equal(parseTime('3pm'), 15 * 60);
    assert.equal(parseTime('the 8 p.m. game'), 20 * 60);
    assert.equal(parseTime('7:30 PM'), 19 * 60 + 30);
    assert.equal(parseTime("3 o'clock"), 15 * 60);
    assert.equal(parseTime('20:00'), 20 * 60);
    assert.equal(parseTime('12:00 AM'), 0);
    assert.equal(parseTime('Lakers'), null);
    assert.equal(parseTime('LeBron 25.5'), null);
    const games = [{ index: 0, time: '3:00 PM', text: '3:00 PM DEN @ LAL' }, { index: 1, time: '8:00 PM', text: '8:00 PM BOS @ NYK' }];
    assert.equal(pickGame(games, '8pm').index, 1);
    assert.equal(pickGame(games, 'the 3 o\'clock game').index, 0);
    assert.equal(pickGame(games, 'nyk').index, 1);
    assert.equal(pickGame(games, 'LAL 8pm'), null, 'the time and the team must both match');
    assert.equal(pickGame(games, '11am'), null);
    assert.equal(pickGame(games, 'Celtics vs Knicks').index, 1, 'team names match the abbreviations on the card');
    assert.deepEqual(require('../agents/outlier/navigate').teamsNamed('Wizards vs Hornets tomorrow'), ['CHA', 'WAS']);
    assert.deepEqual(gameTeams('8:00 PM BOS @ NYK'), ['BOS', 'NYK']);
    assert.deepEqual(sportLabels('nba'), ['nba', 'NBA', 'Basketball']);
    assert.deepEqual(onlyGame([{ game: 'BOS-NYK' }, { game: 'DEN-LAL' }, {}], ['NYK', 'BOS']), [{ game: 'BOS-NYK' }, {}]);
});

test('an agent asks for NBA props for the 8pm game: the scan clicks the NBA tab and that game, never a pick, and audits only that game', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    const card = (name, game, line) => `<div><div>${name}</div><div>${game}</div><div>Points</div><div>Over ${line}</div><div>FanDuel -119</div></div>`;
    const boards = {
        early: ['Nikola Jokic', 'Jamal Murray', 'LeBron James', 'Austin Reaves'].map((n, i) => card(n, 'DEN @ LAL', 20.5 + i)).join(''),
        late: ['Jayson Tatum', 'Jaylen Brown', 'Jalen Brunson', 'Josh Hart'].map((n, i) => card(n, 'BOS @ NYK', 20.5 + i)).join('')
            + card('Aaron Gordon', 'DEN @ LAL', 14.5),   // another game's prop left on the board
        // A board with no game cards: every game's props in one list.
        all: ['Bilal Coulibaly', 'Kyshawn George', 'LaMelo Ball', 'Brandon Miller'].map((n, i) => card(n, i < 2 ? 'WAS @ CHA' : 'CHA vs WAS', 18.5 + i)).join('')
            + card('Paolo Banchero', 'ORL @ MIA', 24.5)
    };
    // A stand-in app that opens on its Positive EV tool like Outlier: the sport tabs
    // are on the Props board, then game cards, then the chosen game's board. The
    // pick button reports to the server if it is ever clicked.
    let picked = 0;
    const page = `<!doctype html><body>
        <button onclick="fetch('/picked')">More</button>
        <header><a href="#" id="ev">Positive EV</a> <a href="#" id="props">Props</a></header>
        <nav id="sports" hidden><button id="nba">NBA</button><button id="nfl">NFL</button><button id="wnba">WNBA</button></nav><main id="main">Positive EV: the best +EV bets right now</main>
        <script>
            const boards = ${JSON.stringify(boards)};
            const main = document.getElementById('main');
            document.getElementById('props').onclick = () => { document.getElementById('sports').hidden = false; main.innerHTML = 'Pick a sport'; };
            document.getElementById('nfl').onclick = () => { main.innerHTML = 'No NFL games'; };
            document.getElementById('wnba').onclick = () => { main.innerHTML = boards.all; };
            document.getElementById('nba').onclick = () => {
                main.innerHTML = '<div id="games"><div class="g" data-b="early" style="cursor:pointer"><span>3:00 PM</span> <span>DEN @ LAL</span></div>'
                    + '<div class="g" data-b="late" style="cursor:pointer"><span>8:00 PM</span> <span>BOS @ NYK</span></div></div>';
                document.querySelectorAll('.g').forEach(g => { g.onclick = () => { main.innerHTML = boards[g.dataset.b]; }; });
            };
        </script></body>`;
    const server = http.createServer((req, res) => {
        if (req.url === '/picked') picked++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false }));
    const service = createService({}, { pipeline });

    const reply = await service.callTool('outlier_scan_board', { sport: 'NBA', game: '8pm' });
    assert.equal(reply.isError, undefined, reply.content[0].text);
    assert.match(reply.content[0].text, /^Outlier > Props > NBA > 8:00 PM BOS vs NYK\n4 props/);
    const scraped = JSON.parse(fs.readFileSync(pipeline.files.scrape, 'utf8'));
    assert.deepEqual(scraped.props.map(p => p.player).sort(), ['Jalen Brunson', 'Jaylen Brown', 'Jayson Tatum', 'Josh Hart']);
    assert.equal(picked, 0, 'the pick button was never clicked');

    const missing = await service.callTool('outlier_scan_board', { sport: 'NBA', game: '11am' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Couldn't find the 11:00 AM game on Outlier \(Props > NBA\)\. Games shown:\n3:00 PM: 3:00 PM DEN @ LAL\n8:00 PM: 8:00 PM BOS @ NYK/);
    const noTab = await service.callTool('outlier_scan_board', { sport: 'NHL', game: '8pm' });
    assert.equal(noTab.isError, true);
    assert.match(noTab.content[0].text, /Couldn't find a "NHL" tab/);
    assert.match(noTab.content[0].text, /Tabs, links and buttons on that page: .*Positive EV \| Props \| NBA \| NFL/, 'the error says what the page does show');

    // Both teams named and no game cards: the whole board, kept to that game.
    const teams = await service.callTool('outlier_scan_board', { sport: 'WNBA', game: 'Wizards vs Hornets' });
    assert.equal(teams.isError, undefined, teams.content[0].text);
    assert.match(teams.content[0].text, /^Outlier > Props > WNBA > CHA vs WAS \(from the whole board\)\n4 props/);
    const kept = JSON.parse(fs.readFileSync(pipeline.files.scrape, 'utf8'));
    assert.deepEqual(kept.props.map(p => p.player).sort(), ['Bilal Coulibaly', 'Brandon Miller', 'Kyshawn George', 'LaMelo Ball']);
    assert.equal(picked, 0);
});
