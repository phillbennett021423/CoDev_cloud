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
    const { teamsNamed } = require('../agents/outlier/teams');
    assert.deepEqual(teamsNamed('Wizards vs Hornets tomorrow'), { league: 'nba', teams: ['CHA', 'WAS'] });
    assert.deepEqual(teamsNamed('Chiefs at Bills'), { league: 'nfl', teams: ['BUF', 'KC'] });
    assert.deepEqual(teamsNamed('Yankees vs Red Sox'), { league: 'mlb', teams: ['BOS', 'NYY'] });
    assert.deepEqual(teamsNamed('Maple Leafs vs Canadiens'), { league: 'nhl', teams: ['MTL', 'TOR'] });
    assert.deepEqual(teamsNamed('Liberty vs Aces'), { league: 'wnba', teams: ['LV', 'NY'] });
    // The sport decides a name two leagues share: Panthers and Jets are NFL or NHL teams.
    assert.deepEqual(teamsNamed('Panthers vs Jets', 'NFL'), { league: 'nfl', teams: ['CAR', 'NYJ'] });
    assert.deepEqual(teamsNamed('Panthers vs Jets', 'NHL'), { league: 'nhl', teams: ['FLA', 'WPG'] });
    assert.deepEqual(teamsNamed('the game that was on at MIN', 'NBA').teams, ['MIN'], 'abbreviations count only in capitals');
    assert.equal(pickGame([{ index: 0, time: '7:00 PM', text: '7:00 PM KC @ BUF' }], 'Chiefs vs Bills', 'NFL').index, 0);
    assert.match(require('../agents/outlier').OUTLIER_PRIMER, /Props \(the Prop Finder.*L5, L10, L20.*never \+EV/);
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
    const card = (name, game, line) => `<div><div class="pn" style="cursor:pointer">${name}</div><div>${game}</div><div>Points</div><div>Over ${line}</div><div>FanDuel -119</div></div>`;
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
        <nav id="sports" hidden><button id="nba">NBA</button><button id="nfl">NFL</button><button id="bball">Basketball</button></nav><a href="#" id="games">Games</a><main id="main">Positive EV: the best +EV bets right now</main>
        <script>
            const boards = ${JSON.stringify(boards)};
            const main = document.getElementById('main');
            let tab = 'props';
            document.getElementById('props').onclick = () => { tab = 'props'; document.getElementById('sports').hidden = false; main.innerHTML = 'Pick a sport'; };
            document.getElementById('games').onclick = () => { tab = 'games'; document.getElementById('sports').hidden = false; main.innerHTML = 'Pick a sport'; };
            document.getElementById('nfl').onclick = () => { main.innerHTML = 'No NFL games'; };
            document.getElementById('bball').onclick = () => { main.innerHTML = boards.all; };
            // A player's name opens his Market Details with its own add-to-picks button.
            main.addEventListener('click', e => {
                if (!e.target.classList.contains('pn')) return;
                main.innerHTML = '<div role="dialog"><h2>' + e.target.textContent + ' Points Over 22.5</h2><h3>Hit Rate</h3><p>L5 80% L10 70% H2H 67%</p>'
                    + '<h3>Supporting Stats</h3><p>Minutes 36.1 FGA 19.4</p><h3>Matchup</h3><p>NYK rank vs SF: 27th</p><h3>Injuries</h3><p>Kristaps Porzingis OUT</p>'
                    + '<h3>Odds Movement</h3><p>FanDuel -105 to -119</p><button onclick="fetch(\\'/picked\\')">Add to My Picks</button></div>';
            });
            document.getElementById('nba').onclick = () => {
                if (tab === 'games') {
                    main.innerHTML = '<div class="gg" style="cursor:pointer"><span>8:00 PM</span> <span>BOS @ NYK</span> <span>BOS -3.5 -110</span></div>';
                    main.querySelector('.gg').onclick = () => { main.innerHTML = '<h2>BOS @ NYK</h2><p>Spread BOS -3.5 -110 Total 221.5</p><h3>Injuries</h3><p>Mitchell Robinson OUT</p><h3>Line Movement and Public Bet splits</h3><p>Public Bet 62% BOS Public Money 71% BOS</p>'; };
                    return;
                }
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
    const teams = await service.callTool('outlier_scan_board', { sport: 'Basketball', game: 'Wizards vs Hornets' });
    assert.equal(teams.isError, undefined, teams.content[0].text);
    assert.match(teams.content[0].text, /^Outlier > Props > Basketball > CHA vs WAS \(from the whole board\)\n4 props/);
    const kept = JSON.parse(fs.readFileSync(pipeline.files.scrape, 'utf8'));
    assert.deepEqual(kept.props.map(p => p.player).sort(), ['Bilal Coulibaly', 'Brandon Miller', 'Kyshawn George', 'LaMelo Ball']);
    assert.equal(picked, 0);

    // One leg's Market Details: board, game, then the player's name.
    const details = await service.callTool('outlier_research', { sport: 'NBA', game: '8pm', player: 'Jayson Tatum' });
    assert.equal(details.isError, undefined, details.content[0].text);
    assert.match(details.content[0].text, /^Outlier > Props > NBA > 8:00 PM BOS vs NYK > Jayson Tatum\n/);
    assert.match(details.content[0].text, /Hit Rate\nL5 80% L10 70% H2H 67%\nSupporting Stats\nMinutes 36\.1.*\nMatchup\nNYK rank vs SF: 27th\nInjuries\nKristaps Porzingis OUT\nOdds Movement/s);
    // A game's own page, from the Games tab, where the cards show their odds.
    const gamePage = await service.callTool('outlier_research', { sport: 'NBA', game: 'Celtics vs Knicks' });
    assert.equal(gamePage.isError, undefined, gamePage.content[0].text);
    assert.match(gamePage.content[0].text, /^Outlier > Games > NBA > 8:00 PM BOS vs NYK\n/);
    assert.match(gamePage.content[0].text, /Public Bet 62% BOS Public Money 71% BOS/);
    const nobody = await service.callTool('outlier_research', { sport: 'NBA', game: '8pm', player: 'Michael Jordan' });
    assert.equal(nobody.isError, true);
    assert.match(nobody.content[0].text, /Couldn't find Michael Jordan/);
    assert.equal(picked, 0, 'nothing was added to My Picks');
    assert.match((await service.callTool('outlier_guide', {})).content[0].text, /Market Details.*Odds Movement.*When to use each one/s);
});

test('Outlier reopens on +EV behind a popup: the scan closes the popup, leaves +EV for the Props board and never touches the slip', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    const card = (name, line) => `<div><div>${name}</div><div>BOS @ NYK</div><div>Points</div><div>Over ${line}</div><div>FanDuel -119</div></div>`;
    const board = ['Jayson Tatum', 'Jaylen Brown', 'Jalen Brunson', 'Josh Hart'].map((n, i) => card(n, 20.5 + i)).join('');
    // A popup covering the page, and a fixed slip whose × would remove a pick.
    const popup = `<div style="position:fixed;inset:0;background:#0008;z-index:9"><div role="dialog">Try Pro free <button onclick="fetch('/accepted')">Start trial</button> <button onclick="this.closest('div[style]').remove()">Not now</button></div></div>`;
    const slip = `<aside style="position:fixed;right:0;bottom:0;width:120px">My Picks: Tatum Over 20.5 <button onclick="fetch('/removed')">×</button></aside>`;
    const pages = {
        // +EV: its own tabs, no Props tab or link.
        '/pro/ev': `<!doctype html><body>${popup}${slip}<nav><button>NBA Player Props</button><button>NFL Player Props</button><button>Pinnacle</button></nav><main>Positive EV</main></body>`,
        '/props': `<!doctype html><body>${popup}${slip}<nav><button id="nba">NBA</button></nav><main id="main">Pick a sport</main><script>
            document.getElementById('nba').onclick = () => {
                const main = document.getElementById('main');
                main.innerHTML = '<div class="g" style="cursor:pointer"><span>8:00 PM</span> <span>BOS @ NYK</span></div>';
                main.querySelector('.g').onclick = () => { main.innerHTML = ${JSON.stringify(board)}; };
            };</script></body>`
    };
    const hits = { accepted: 0, removed: 0 };
    const server = http.createServer((req, res) => {
        const at = req.url.split('?')[0];
        if (at === '/accepted' || at === '/removed') { hits[at.slice(1)]++; return res.end(); }
        // Outlier reopens the last tool used.
        if (!pages[at]) { res.writeHead(302, { Location: '/pro/ev' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(pages[at]);
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
    assert.deepEqual(hits, { accepted: 0, removed: 0 }, 'the popup was closed, not accepted, and the slip was left alone');
});

test('Outlier sends /, /props and every other address back to +EV: the scan goes to the sport\'s own board address (/NBA/props) and remembers it', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    const card = (name, line) => `<div><div>${name}</div><div>BOS @ NYK</div><div>Points</div><div>Over ${line}</div><div>FanDuel -119</div></div>`;
    const board = ['Jayson Tatum', 'Jaylen Brown', 'Jalen Brunson', 'Josh Hart'].map((n, i) => card(n, 20.5 + i)).join('');
    // The sport's board has no NBA tab and no Props link: it is reached by its address only.
    const nbaProps = `<!doctype html><body><main id="main"><div class="g" style="cursor:pointer"><span>8:00 PM</span> <span>BOS @ NYK</span></div></main><script>
        document.querySelector('.g').onclick = () => { document.getElementById('main').innerHTML = ${JSON.stringify(board)}; };</script></body>`;
    const seen = [];
    const server = http.createServer((req, res) => {
        const at = req.url.split('?')[0];
        seen.push(at);
        res.writeHead(...(at === '/NBA/props' || at === '/pro/ev' ? [200, { 'Content-Type': 'text/html' }] : [302, { Location: '/pro/ev' }]));
        if (at === '/NBA/props') return res.end(nbaProps);
        if (at === '/pro/ev') return res.end('<!doctype html><body><nav><button>NBA Player Props</button><button>Pinnacle</button><button>Sharp Gamelines</button></nav><main>Positive EV</main></body>');
        res.end();
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
    assert.match(reply.content[0].text, /8:00 PM BOS vs NYK\n4 props/);
    assert.ok(seen.includes('/NBA/props'));
    assert.ok(!seen.includes('/prop-finder'), 'the sport\'s own address is tried before the guesses');
    // Asked for the "Props" section by name: the same board, not a strict tab click.
    const named = await service.callTool('outlier_scan_board', { section: 'Props', sport: 'NBA', game: '8pm' });
    assert.equal(named.isError, undefined, named.content[0].text);
    assert.match(named.content[0].text, /8:00 PM BOS vs NYK\n4 props/);
    // Kept on disk: a restart (a new install) starts on the board, not on +EV.
    assert.equal(fs.readFileSync(pipeline.files.propsUrl, 'utf8'), url + 'NBA/props');
    const again = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => again.close());
    assert.equal(again.boardStart('NBA'), url + 'NBA/props');
});

test('a list of legs for tomorrow is researched in one visit: each player\'s card for that stat, Outlier\'s line against the user\'s, no trip back to +EV', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    const players = ['Bilal Coulibaly', 'Kyshawn George', 'LaMelo Ball', 'Brandon Miller'];
    const card = (name, stat, line) => `<div class="c"><div class="pn" data-stat="${stat}" style="cursor:pointer">${name}</div><div>WAS @ CHA</div><div>${stat}</div><div>Over ${line}</div><div>FanDuel -119</div></div>`;
    const board = players.map((n, i) => card(n, 'Points', 14.5 + i)).join('') + players.map((n, i) => card(n, 'Rebounds', 4.5 + i)).join('');
    const props = `<!doctype html><body><header><a href="/props">Props</a> <a href="/insights">Insights</a> <a href="/popular">Popular</a></header>
        <nav><button id="nba">NBA</button></nav><div id="days" hidden><button id="today">Today</button><button id="tmrw">Tomorrow</button></div><main id="main">Pick a sport</main>
        <script>
            const main = document.getElementById('main');
            document.getElementById('nba').onclick = () => { document.getElementById('days').hidden = false; main.innerHTML = '<div class="g" style="cursor:pointer"><span>8:00 PM</span> <span>BOS @ NYK</span></div>'; bind(); };
            document.getElementById('today').onclick = () => { main.innerHTML = '<div class="g" style="cursor:pointer"><span>8:00 PM</span> <span>BOS @ NYK</span></div>'; bind(); };
            document.getElementById('tmrw').onclick = () => { main.innerHTML = '<div class="g" style="cursor:pointer"><span>7:00 PM</span> <span>WAS @ CHA</span></div>'; bind(); };
            function bind() { main.querySelectorAll('.g').forEach(g => { g.onclick = () => { main.innerHTML = g.textContent.includes('WAS') ? ${JSON.stringify(board)} : 'BOS board'; }; }); }
            // A card replaces the board, like a page of its own.
            main.addEventListener('click', e => {
                if (!e.target.classList.contains('pn')) return;
                const stat = e.target.dataset.stat;
                main.innerHTML = '<div role="dialog"><h2>' + e.target.textContent + ' ' + stat + '</h2><p>L5 ' + (stat === 'Rebounds' ? '90%' : '40%') + ' L10 70%</p>'
                    + '<p>CHA rank vs SF: 28th</p><p>Mark Williams OUT</p><p>Minutes 31.2</p><button onclick="fetch(\\'/picked\\')">Add to My Picks</button></div>';
            });
        </script></body>`;
    const hits = { start: 0, ev: 0, picked: 0 };
    const server = http.createServer((req, res) => {
        const at = req.url.split('?')[0];
        if (at === '/picked') { hits.picked++; return res.end(); }
        if (at === '/') { hits.start++; res.writeHead(302, { Location: '/pro/ev' }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (at === '/pro/ev') { hits.ev++; return res.end('<!doctype html><body><button>NBA Player Props</button><button>Pinnacle</button><main>Positive EV</main></body>'); }
        if (at === '/popular') return res.end('<!doctype html><body><h2>Most Researched</h2><p>LaMelo Ball Over 22.5 Points: 1,204 researching</p></body>');
        res.end(props);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false, cardPaceMs: 50 }));
    const service = createService({}, { pipeline });

    const reply = await service.callTool('outlier_research_list', { sport: 'NBA', game: 'Wizards vs Hornets', day: 'tomorrow', legs: [
        { player: 'Bilal Coulibaly', stat: 'Rebounds', line: 3.5, side: 'Over' },
        { player: 'LaMelo Ball', stat: 'Points', line: 16.5, side: 'Higher' },
        { player: 'Michael Jordan', stat: 'Points', line: 30.5 },
        { player: 'LaMelo Ball', stat: 'Pts+Rebs+Asts', line: 30.5, side: 'Under' }
    ] });
    assert.equal(reply.isError, undefined, reply.content[0].text);
    const text = reply.content[0].text;
    assert.match(text, /^Outlier > Props > NBA > Tomorrow > 7:00 PM WAS vs CHA\nFound 3 of 4 legs on Outlier\./);
    assert.match(text, /1\. Bilal Coulibaly Over 3\.5 Rebounds\n {3}Outlier 4\.5 Rebounds \(over -119\): no hit rates shown \(for Outlier's 4\.5 \(the line moved; your 3\.5 is 1 easier\)\)\n {3}Card: Hit L5 90%, L10 70% \| Matchup: CHA rank vs SF: 28th \| Injuries: Mark Williams OUT \| Usage: Minutes 31\.2/, 'his rebounds card, not his points one');
    assert.match(text, /Best on Outlier's hit rates.*\n1\. Bilal Coulibaly Over 3\.5 Rebounds: 80% \([^)]*\)\n2\. LaMelo Ball Higher 16\.5 Points: 55% \([^)]*\)/, 'legs are ranked, on the card\'s hit rates when the board row shows none');
    assert.match(text, /For reference only, CoDev's sportsbook audit/);
    assert.match(text, /2\. LaMelo Ball Higher 16\.5 Points\n {3}Outlier 16\.5 Points \(over -119\): no hit rates shown \(on your line\)\n {3}Card: Hit L5 40%/);
    assert.match(text, /3\. Michael Jordan Over 30\.5 Points: no Points prop at this part of the game for him on Outlier for this game \(read the whole board; Outlier lists no props for him\)\. Can't be checked on Outlier\./);
    assert.match(text, /4\. LaMelo Ball Under 30\.5 Pts\+Rebs\+Asts \(no prop for this stat at this part of the game on Outlier/);
    assert.match(text, /Checks:\n- LaMelo Ball is on legs 2, 4: an Over and an Under on him work against each other/);
    assert.match(text, /a DFS leg doesn't need to pass it\):\n\d+ props/);
    const audited = JSON.parse(fs.readFileSync(pipeline.files.scrape, 'utf8'));
    assert.deepEqual([...new Set(audited.props.map(p => p.player))].sort(), ['Bilal Coulibaly', 'LaMelo Ball'], 'only the listed players are audited');
    assert.equal(hits.ev, 1, 'Outlier\'s +EV start page was opened once, then the Props board was remembered');
    assert.equal(hits.picked, 0, 'nothing was added to My Picks');

    const popular = await service.callTool('outlier_read_section', { section: 'Popular' });
    assert.equal(popular.isError, undefined, popular.content[0].text);
    assert.match(popular.content[0].text, /^Outlier > Popular\n.*\n\nMost Researched\nLaMelo Ball Over 22\.5 Points: 1,204 researching/);
    assert.equal(hits.ev, 1);
    const ev = await service.callTool('outlier_read_section', { section: '+EV' });
    assert.equal(ev.isError, true);
    assert.match(ev.content[0].text, /Pro tools/);
});

test('NFL quarter and half legs: each player is looked up by name, matched to the same quarter or half, and a missing one says what Outlier lists for him', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    // The board shows each player's main props; his quarter and half props show when
    // his name is searched. A pick slip's amount field sits next to it and must stay empty.
    const rows = [
        ['CeeDee Lamb', 'Receiving Yards', 64.5, true], ['CeeDee Lamb', '1st Quarter Receiving Yards', 14.5, false], ['CeeDee Lamb', '2nd Quarter Receiving Yards', 18.5, false],
        ['Saquon Barkley', 'Rushing Yards', 80.5, true], ['Saquon Barkley', 'Receptions', 3.5, false], ['Jalen Hurts', 'Passing Yards', 220.5, true]
    ];
    const page = `<!doctype html><body><div class="betslip"><input id="amt" placeholder="Entry amount"></div><input id="q" placeholder="Search players"><main id="b"></main><script>
        const rows = ${JSON.stringify(rows)};
        const b = document.getElementById('b'); const q = document.getElementById('q');
        function draw() { const f = q.value.toLowerCase(); b.innerHTML = rows.filter(r => f ? r[0].toLowerCase().includes(f) : r[3]).map(r => '<div><div class="pn" style="cursor:pointer">' + r[0] + '</div><div>DAL @ PHI</div><div>' + r[1] + '</div><div>Over ' + r[2] + '</div><div>FanDuel -115</div><div>L5 60% L10 70%</div></div>').join(''); }
        q.addEventListener('input', draw); draw();
        b.addEventListener('click', e => {
            if (!e.target.classList.contains('pn')) return;
            const market = e.target.parentElement.children[2].textContent;
            history.pushState({}, '', location.pathname + '?market=' + encodeURIComponent(market));
            const p = document.createElement('div'); p.setAttribute('role', 'dialog');
            p.innerHTML = '<h2>' + e.target.textContent + ' ' + market + '</h2><p>L5 80% L10 60%</p><p>Targets 9.7</p>';
            document.body.appendChild(p);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('[role=dialog]').forEach(d => d.remove()); history.pushState({}, '', location.pathname); } });
    </script></body>`;
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/NFL/props`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false, cardPaceMs: 50, clickPaceMs: 300, backoffMs: [100, 100] }));
    const service = createService({}, { pipeline });
    const legs = [
        { player: 'CeeDee Lamb', stat: '1st Quarter Receiving Yards', line: 14.5, side: 'Over' },
        { player: 'Saquon Barkley', stat: 'First Half Receptions', line: 1.5, side: 'Over' },
        { player: 'CeeDee Lamb', stat: 'Receiving Yards', line: 64.5, side: 'Over' }
    ];
    const out = await service.callTool('outlier_research_list', { sport: 'NFL', legs });
    const text = out.content[0].text;
    assert.equal(out.isError, undefined, text);
    assert.match(text, /1\. CeeDee Lamb Over 14\.5 1st Quarter Receiving Yards\n {3}Outlier 14\.5 1st Quarter Receiving Yards \(over -115\)[^\n]*\n {3}Card: [^\n]*/, 'the 1st-quarter leg matched the 1st-quarter row found by searching his name');
    assert.match(text, /CeeDee Lamb 1st Quarter Receiving Yards · L5 80%/, 'his 1st-quarter card was the one opened');
    assert.match(text, /2\. Saquon Barkley Over 1\.5 First Half Receptions \(no prop for this stat at this part of the game on Outlier after searching his name; Outlier lists for him: Rushing Yards 80\.5, Receptions 3\.5; his card for another stat was read\)/);
    assert.doesNotMatch(text, /Saquon Barkley[^\n]*\n {3}Outlier /, 'his full-game receptions row is not his first-half one');
    assert.match(text, /3\. CeeDee Lamb Over 64\.5 Receiving Yards\n {3}Outlier 64\.5 Receiving Yards \(over -115\)/, 'the full-game leg matched the full-game row, not a quarter');
    assert.match(text, /looked up by name in Outlier's search/);
});

test('Outlier\'s filter panel: alt lines on, the odds range opened past -300, the game ticked, never Only EV+ or Save filters', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    // Rows: player, market, line, odds, alt line?, game. The board hides odds under
    // the odds floor (-300 by default) and alt lines until they're switched on.
    const rows = [
        ['Jalen Hurts', 'Passing Yards', 220.5, -115, false, 'DAL @ PHI'], ['Jalen Hurts', 'Passing Yards', 180.5, -450, true, 'DAL @ PHI'],
        ['CeeDee Lamb', 'Receptions', 3.5, -520, false, 'DAL @ PHI'], ['Jordan Love', 'Passing Yards', 240.5, -110, false, 'CAR @ GB']
    ];
    const page = `<!doctype html><body><button id="fb" aria-label="Filters">☰</button><div class="betslip"><input placeholder="Entry amount"></div><main id="b"></main>
        <div id="panel" hidden><h3>Current filters</h3>
          <div class="row"><span>Only EV+</span><button role="switch" id="ev" aria-checked="false"></button></div>
          <div class="row"><span>Games</span></div>
          <label><input type="checkbox" id="g1"><span>Today 7:15 PM</span> <span>Cowboys @ Eagles</span></label>
          <label><input type="checkbox" id="g2"><span>Thursday 7:15 PM</span> <span>Panthers @ Packers</span></label>
          <div class="row" id="oddsrow"><span>Odds</span><span id="oddsat">At least -300</span></div>
          <div id="oddsbox" hidden><div role="slider" tabindex="0" id="from" aria-valuemin="-16500" aria-valuemax="16000" aria-valuenow="-300" style="width:20px;height:20px">||</div></div>
          <div class="row"><span>Opponent Matchup</span></div>
          <div class="row"><span>Include alternative lines</span><button role="switch" id="alt" aria-checked="false"></button></div>
          <button id="save">SAVE FILTERS</button><button id="show">SHOW 3109 RESULTS</button>
        </div><script>
        const rows = ${JSON.stringify(rows)}; const state = { alt: false, floor: -300, game: null };
        const b = document.getElementById('b'), panel = document.getElementById('panel');
        function draw() { b.innerHTML = rows.filter(r => (state.alt || !r[4]) && r[3] >= state.floor && (!state.game || r[5] === state.game)).map(r => '<div><div class="pn" style="cursor:pointer">' + r[0] + '</div><div>' + r[5] + '</div><div>' + r[1] + '</div><div>Over ' + r[2] + '</div><div>FanDuel ' + r[3] + '</div><div>L5 80% L10 70%</div></div>').join(''); }
        draw();
        document.getElementById('fb').onclick = () => { panel.hidden = false; };
        document.getElementById('alt').onclick = e => { e.target.setAttribute('aria-checked', String(e.target.getAttribute('aria-checked') !== 'true')); };
        document.getElementById('ev').onclick = () => { state.floor = 1e9; draw(); };
        document.getElementById('save').onclick = () => { state.floor = 1e9; draw(); };
        document.getElementById('oddsrow').onclick = () => { document.getElementById('oddsbox').hidden = false; };
        document.getElementById('from').addEventListener('keydown', e => { if (e.key === 'Home') { e.target.setAttribute('aria-valuenow', '-16500'); document.getElementById('oddsat').textContent = 'At least -16500'; } });
        document.getElementById('show').onclick = () => {
            state.alt = document.getElementById('alt').getAttribute('aria-checked') === 'true';
            state.floor = Number(document.getElementById('from').getAttribute('aria-valuenow'));
            state.game = document.getElementById('g1').checked ? 'DAL @ PHI' : null;
            panel.hidden = true; draw();
        };
        b.addEventListener('click', e => {
            if (!e.target.classList.contains('pn')) return;
            const p = document.createElement('div'); p.setAttribute('role', 'dialog');
            p.innerHTML = '<h2>' + e.target.textContent + ' ' + e.target.parentElement.children[2].textContent + '</h2><p>L5 80% L10 70%</p>';
            document.body.appendChild(p);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('[role=dialog]').forEach(d => d.remove()); panel.hidden = true; } });
    </script></body>`;
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/NFL/props`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false, cardPaceMs: 50, clickPaceMs: 300, backoffMs: [100, 100] }));
    const service = createService({}, { pipeline });
    const legs = [
        { player: 'Jalen Hurts', stat: 'Passing Yards', line: 180.5, side: 'Over' },
        { player: 'CeeDee Lamb', stat: 'Receptions', line: 3.5, side: 'Over' }
    ];
    const out = await service.callTool('outlier_research_list', { sport: 'NFL', game: 'Cowboys Eagles', legs });
    const text = out.content[0].text;
    assert.equal(out.isError, undefined, text);
    assert.match(text, /filters: alt lines on, odds from -16500, game Today 7:15 PM Cowboys @ Eagles/, 'the steps say what was set');
    assert.match(text, /1\. Jalen Hurts Over 180\.5 Passing Yards\n {3}Outlier 180\.5 Passing Yards/, 'his alt line shows once alt lines are on');
    assert.match(text, /2\. CeeDee Lamb Over 3\.5 Receptions\n {3}Outlier 3\.5 Receptions \(over -520\)/, 'a -520 line shows once the odds range is opened');
    assert.doesNotMatch(text, /Jordan Love/, 'the other game is filtered out');
});

test('a long board that only draws the rows on screen: each card opens by jumping back to where the board read saw the player', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    // 900 rows in a scrolling panel, 20 drawn at a time, like Outlier's virtualized board:
    // a player near the end is past the 40 screens a search from the top would scroll.
    const word = i => `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + (Math.floor(i / 676) % 26))}son`;
    const rows = Array.from({ length: 900 }, (_, i) => ({ n: `Kai ${word(i)}`, l: 10.5 + (i % 9) }));
    const page = `<!doctype html><body><div id="sc" style="height:700px;overflow:auto"><div id="in" style="position:relative;height:${900 * 60}px"></div></div><script>
        const rows = ${JSON.stringify(rows)};
        const sc = document.getElementById('sc'); const inn = document.getElementById('in');
        function draw() { const a = Math.floor(sc.scrollTop / 60); let h = ''; for (let i = a; i < Math.min(rows.length, a + 14); i++) h += '<div style="position:absolute;top:' + (i * 60) + 'px"><div class="pn" style="cursor:pointer">' + rows[i].n + '</div><div>BOS @ NYK</div><div>Points</div><div>Over ' + rows[i].l + '</div><div>FanDuel -119</div><div>L5 60% L10 70%</div></div>'; inn.innerHTML = h; }
        sc.addEventListener('scroll', draw); draw();
        inn.addEventListener('click', e => {
            if (!e.target.classList.contains('pn')) return;
            history.pushState({}, '', location.pathname + '?market=points');
            const p = document.createElement('div'); p.setAttribute('role', 'dialog');
            p.innerHTML = '<h2>' + e.target.textContent + '</h2><p>L5 60% L10 70%</p><p>Minutes 31.0</p>';
            document.body.appendChild(p);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('[role=dialog]').forEach(d => d.remove()); history.pushState({}, '', location.pathname); } });
    </script></body>`;
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/NBA/props`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false, cardPaceMs: 50, clickPaceMs: 300, backoffMs: [100, 100] }));
    const service = createService({}, { pipeline });
    const legs = [5, 880].map(i => ({ player: rows[i].n, stat: 'Points', line: rows[i].l, side: 'Over' }));
    const progress = [];
    const timer = setInterval(() => { const p = pipeline.progress().progress; if (p && progress.at(-1) !== p) progress.push(p); }, 100);
    const out = await service.callTool('outlier_research_list', { sport: 'NBA', legs });
    clearInterval(timer);
    const text = out.content[0].text;
    assert.equal(out.isError, undefined, text);
    assert.match(text, /2\. Kai Whbson Over 17\.5 Points\n {3}Outlier 17\.5 Points[^\n]*\n {3}Card: [^\n]*Minutes 31\.0/, 'the player near the end of the board had his card read');
    assert.match(text, /What CoDev did on Outlier:\n- Board: read \d+ screen\(s\), [\d,]+ rows, in \d+s; 2 of 2 legs seen on it\.\n- Player cards: 2 opened \(2 by jumping to the row the board read saw, 0 from a search of his name, 0 by scrolling the board\)/);
    assert.ok(progress.some(p => /^Reading the NBA board: screen \d+, [\d,]+ rows, \d of 2 legs seen$/.test(p)), progress.join(' | '));
    assert.ok(progress.some(p => /^Card \d of 2: Kai Whbson Points, (jumping to his row on the board|reading the card|every tab of the card)/.test(p)), progress.join(' | '));
});

test('a list keeps the board loaded: cards open over it and close with Escape, a 429 backs off, and cards read lately are reused', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    const players = ['Jayson Tatum', 'Jaylen Brown', 'Jalen Brunson', 'Josh Hart', 'Mikal Bridges'];
    const board = players.map((n, i) => `<div><div class="pn" style="cursor:pointer">${n}</div><div>BOS @ NYK</div><div>Points</div><div>Over ${20.5 + i}</div><div>FanDuel -119</div><div>L5 ${80 - i * 10}% L10 70%</div></div>`).join('');
    // Like Outlier: the card is a panel over the board (the address gains ?market=), its data
    // comes from /api/card, and Escape closes it.
    const page = `<!doctype html><body><a href="/NBA/props">Props</a><nav><button id="nba">NBA</button></nav><main id="main">Pick a sport</main><script>
        const main = document.getElementById('main');
        document.getElementById('nba').onclick = () => { main.innerHTML = ${JSON.stringify(board)}; };
        main.addEventListener('click', async e => {
            if (!e.target.classList.contains('pn')) return;
            history.pushState({}, '', location.pathname + '?market=' + encodeURIComponent(e.target.textContent));
            const r = await fetch('/api/card');
            const panel = document.createElement('div');
            panel.setAttribute('role', 'dialog');
            panel.innerHTML = r.status === 429 ? 'Too many requests' : '<h2>' + e.target.textContent + '</h2><p>L5 60% L10 70% H2H 50%</p><p>Minutes 34.0</p>';
            document.body.appendChild(panel);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('[role=dialog]').forEach(d => d.remove()); history.pushState({}, '', location.pathname); } });
    </script></body>`;
    const hits = { board: 0, card: 0 };
    let limit = false;
    let once = 0;
    const server = http.createServer((req, res) => {
        const at = req.url.split('?')[0];
        if (at === '/api/card') { hits.card++; res.writeHead(limit || once-- > 0 ? 429 : 200); return res.end('{}'); }
        hits.board++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/NBA/props`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false, cardPaceMs: 50, clickPaceMs: 300, backoffMs: [100, 100] }));
    const service = createService({}, { pipeline });
    const legs = players.slice(0, 3).map((player, i) => ({ player, stat: 'Points', line: 20.5 + i, side: 'Over' }));

    const first = await service.callTool('outlier_research_list', { sport: 'NBA', legs });
    assert.equal(first.isError, undefined, first.content[0].text);
    assert.match(first.content[0].text, /1\. Jayson Tatum Over 20\.5 Points\n {3}Outlier 20\.5 Points \(over -119\): L5 80% · L10 70% on your line\n {3}Card: Hit L5 60%, L10 70%, H2H 50% \| Usage: Minutes 34\.0/);
    assert.match(first.content[0].text, /Best on Outlier's hit rates.*\n1\. Jayson Tatum Over 20\.5 Points: 7[56]% \([^)]*\)\n2\. Jaylen Brown Over 21\.5 Points: 70% \([^)]*\)/);
    assert.equal(hits.board, 1, 'the board was loaded once for all three legs');
    assert.equal(hits.card, 3);

    // Asked again: the cards read a minute ago are reused, nothing new is fetched.
    const again = await service.callTool('outlier_research_list', { sport: 'NBA', legs });
    assert.match(again.content[0].text, /Minutes 34\.0 \(read earlier today at [^;]+; the line and odds above are from this run\)/);
    assert.equal(hits.card, 3);
    assert.equal(hits.board, 1, 'every leg read a minute ago: Outlier isn\'t opened again');
    // After a crash or restart (a new pipeline on the same folder), the cards are still there.
    const restarted = createService({}, { pipeline: createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] }) });
    const resumed = await restarted.callTool('outlier_research_list', { sport: 'NBA', legs });
    assert.match(resumed.content[0].text, /Minutes 34\.0 \(read earlier today at [^;]+; the line and odds above are from this run\)/);
    assert.equal(hits.card, 3, 'no card opened again after the restart');

    // Outlier says 429 to every card: CoDev backs off, then stops opening cards.
    limit = true;
    const more = players.slice(3).map((player, i) => ({ player, stat: 'Points', line: 23.5 + i, side: 'Over' }));
    const slowed = await service.callTool('outlier_research_list', { sport: 'NBA', legs: [...more, { player: 'Jayson Tatum', stat: 'Points', line: 20.5 }] });
    assert.equal(slowed.isError, undefined, slowed.content[0].text);
    assert.match(slowed.content[0].text, /Outlier asked CoDev to slow down \(429\)/);
    assert.match(slowed.content[0].text, /1\. Josh Hart Over 23\.5 Points\n {3}Outlier 23\.5 Points \(over -119\): L5 50% · L10 70% on your line\n {3}\(card not read: Outlier said too many requests\)/, 'the board row still gives every leg its hit rates');
    assert.doesNotMatch(slowed.content[0].text, /Too many requests/, 'an empty card is not passed on as research');
    assert.ok(hits.card <= 3 + 3, 'no more than one card per strike before stopping');
    // Cut short, the run still ends with a slip, its unread legs marked unverified.
    assert.match(slowed.content[0].text, /Slip from what was read \(\d+ leg\(s\) verified on their card; the run was cut short[^\n]*\n1\) /);
    assert.match(slowed.content[0].text, /\(board only, card not read: unverified\)/);

    // One 429, then Outlier answers again: CoDev waits it out and still reads every
    // card whole (every tab), only with slower clicks.
    limit = false;
    once = 1;
    const after = await service.callTool('outlier_research_list', { sport: 'NBA', legs: more });
    assert.match(after.content[0].text, /Outlier asked CoDev to slow down \(429\)/);
    assert.doesNotMatch(after.content[0].text, /Read light/);
    assert.match(after.content[0].text, /\n {3}Card: /, 'the cards after the 429 were read');
});

test('each card is read whole: every tab on it, minutes and opportunity by window, and falling minutes move a leg down', async t => {
    if (!hasPython) return t.skip('Python 3 is not installed');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const { createService } = require('../agents/outlier');
    const players = ['Jayson Tatum', 'Jaylen Brown'];
    const board = players.map((n, i) => `<div><div class="pn" style="cursor:pointer">${n}</div><div>BOS @ NYK</div><div>Points</div><div>Over ${20.5 + i}</div><div>FanDuel -119</div><div>L5 ${74 - i * 4}% L10 ${74 - i * 4}%</div></div>`).join('');
    // Tatum's minutes and shots are falling; Brown's are steady. Each tab fills the card's body.
    const stats = {
        'Jayson Tatum': 'Stat L5 L10 2026\nMinutes 30.1 32.0 34.2\nFGA 15.2 16.0 17.8',
        'Jaylen Brown': 'Stat L5 L10 2026\nMinutes 33.9 34.0 34.1\nFGA 17.0 17.1 17.2'
    };
    const page = `<!doctype html><body><header><div role="tablist"><button role="tab" onclick="fetch('/nav')">Injuries</button></div></header><nav><button id="nba">NBA</button></nav><main id="main">Pick a sport</main><script>
        const main = document.getElementById('main');
        const stats = ${JSON.stringify(stats)};
        document.getElementById('nba').onclick = () => { main.innerHTML = ${JSON.stringify(board)}; };
        main.addEventListener('click', e => {
            if (!e.target.classList.contains('pn')) return;
            const name = e.target.textContent;
            const panel = document.createElement('div');
            panel.setAttribute('role', 'dialog');
            // One bar per game: Tatum's carry a title, Brown's show a tooltip on hover.
            const values = name === 'Jayson Tatum' ? [18, 25, 30, 22, 19, 27, 24, 31, 17, 26] : [20, 23, 25, 22, 19, 24, 26, 18, 27, 23];
            const bars = values.map((v, i) => name === 'Jayson Tatum'
                ? '<div class="bar" style="display:inline-block;width:12px;height:' + v * 2 + 'px;background:#0a0;margin:1px" title="Oct ' + (i + 1) + ' vs MIA ' + v + ' PTS 3' + (i % 4) + ' MIN"></div>'
                : '<div class="bar" data-v="' + v + '" style="display:inline-block;width:12px;height:' + v * 2 + 'px;background:#0a0;margin:1px"></div>').join('');
            panel.innerHTML = '<h2>' + name + '</h2><p>L5 60% L10 70%</p><div class="chart">' + bars + '</div><div role="tooltip" id="tip" style="display:none"></div>'
                + '<p>Injuries: Al Horford OUT</p><button id="alt">Alt Lines</button><div id="alts" hidden>18+ 95% | 21+ 75% | 22+ 70% | 25+ 40%</div>'
                + '<button id="ww">With/Without</button><div role="tablist"><button role="tab">Supporting Stats</button><button role="tab">Game Log</button><button role="tab">Odds Movement</button></div>'
                + '<button onclick="fetch(\\'/picked\\')">Add to My Picks</button><section id="body">Overview</section>';
            panel.querySelectorAll('.bar[data-v]').forEach(b => { b.onmouseenter = () => { const tip = panel.querySelector('#tip'); tip.textContent = 'vs PHI ' + b.dataset.v + ' PTS 34 MIN'; tip.style.display = 'block'; }; });
            panel.querySelector('#alt').onclick = () => { const a = panel.querySelector('#alts'); a.hidden = !a.hidden; };
            panel.querySelector('#ww').onclick = () => {
                const menu = document.createElement('ul');
                menu.innerHTML = '<li role="option">Al Horford</li><li role="option">Derrick White</li>';
                menu.querySelector('li').onclick = () => { menu.remove(); panel.querySelector('#body').innerHTML = 'Without Al Horford: L10 90% (9 games)'; };
                document.body.appendChild(menu);
            };
            const tabs = { 'Supporting Stats': stats[name].replace(/\\n/g, '<br>'), 'Game Log': '@ MIA 31 pts<br>vs PHI 18 pts', 'Odds Movement': 'Opened 20.5, now 21.5' };
            panel.querySelectorAll('[role=tab]').forEach(b => { b.onclick = () => { panel.querySelector('#body').innerHTML = tabs[b.textContent]; }; });
            document.body.appendChild(panel);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('[role=dialog]').forEach(d => d.remove()); });
    </script></body>`;
    const hits = { nav: 0, picked: 0 };
    const server = http.createServer((req, res) => {
        const at = req.url.split('?')[0];
        if (at === '/nav' || at === '/picked') { hits[at.slice(1)]++; return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/NBA/props`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-outlier-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const pipeline = createOutlierPipeline({ dataDir, log: () => {}, blockedPorts: [] });
    t.after(() => pipeline.close());
    fs.writeFileSync(pipeline.files.config, JSON.stringify({ pages: [{ kind: 'props', url }], settleMs: 50, market: false, cardPaceMs: 50 }));
    const service = createService({}, { pipeline });
    const legs = players.map((player, i) => ({ player, stat: 'Points', line: 20.5 + i, side: 'Over' }));

    const reply = await service.callTool('outlier_research_list', { sport: 'NBA', legs });
    assert.equal(reply.isError, undefined, reply.content[0].text);
    const text = reply.content[0].text;
    assert.match(text, /1\. Jayson Tatum Over 20\.5 Points\n.*\n {3}Card: .*\n(?: {3}.*\n)*? {3}Minutes & opportunity: Minutes L5 30\.1 · L10 32 · 2026 34\.2 \(12% lower lately\); FG attempts L5 15\.2 · L10 16 · 2026 17\.8 \(15% lower lately\)/);
    assert.match(text, /On the card: Jayson Tatum · L5 60% L10 70%/);
    // Game log from the bars at the user's line: Tatum Over 20.5 from titles, Brown Over 21.5 from hover tooltips.
    assert.match(text, /Game log at your line \(Over 20\.5\): L5 4\/5 · L10 7\/10 · 7 of 10 games; last games 18 MIA, 25 MIA, 30 MIA, 22 MIA, 19 MIA, 27 MIA, 24 MIA, 31 MIA, 17 MIA, 26 MIA; minutes 30, 31, 32, 33, 30, 31, 32, 33, 30, 31/);
    assert.match(text, /Game log at your line \(Over 21\.5\): L5 4\/5 · L10 7\/10 · 7 of 10 games; last games 20 PHI/);
    assert.match(text, /Alt lines: at your line 18\+ 95% \| 21\+ 75% \| 22\+ 70% \| 25\+ 40%/);
    assert.match(text, /Without Al Horford: Without Al Horford: L10 90% \(9 games\)/);
    // Forward-looking lines from the card's own numbers, labelled as estimates.
    assert.match(text, /Projection \(estimate\): [\d.]+ = [\d.]+ per minute \(median of his last 10 games\) x 30\.1 minutes \(the card's L5 minutes\); [+-][\d.]+ against your 20\.5/);
    assert.match(text, /For the 2 verified leg\(s\) of that slip: Ticket simulation \(estimate, 10,000 runs from each leg's own games at the user's line\): all 2 hit in [\d.]+% of runs; 44\.4% if the legs were unrelated\. Leg chances: Jaylen Brown 66\.7% \(7 of 10 games\), Jayson Tatum 66\.7% \(7 of 10 games\)\. No shared game dates/);
    const sim = await service.callTool('outlier_simulate_ticket', { legs: [legs[0], legs[1]] });
    assert.equal(sim.isError, undefined, sim.content[0].text);
    assert.match(sim.content[0].text, /all 2 hit in [\d.]+% of runs; 44\.4% if the legs were unrelated/);
    const unread = await service.callTool('outlier_simulate_ticket', { legs: [legs[0], { player: 'Josh Hart', stat: 'Points', line: 10.5 }] });
    assert.match(unread.content[0].text, /Ticket simulation not run: no game log at the line from Outlier's chart for Josh Hart/);
    assert.match(text, /Tab Game Log: @ MIA 31 pts · vs PHI 18 pts/);
    assert.match(text, /Tab Odds Movement: Opened 20\.5, now 21\.5/);
    // Tatum's 74% drops 8 points for his falling minutes and shots: Brown's steady 70% leads.
    assert.match(text, /Best on Outlier's hit rates.*\n2\. Jaylen Brown Over 21\.5 Points: 70% \(card read\)\n1\. Jayson Tatum Over 20\.5 Points: 66% \(card read\)/);
    assert.deepEqual(hits, { nav: 0, picked: 0 }, 'only the card\'s own tabs were clicked: no header tab, no pick');
});

test('a grid board\'s bare hit-rate cells get their column labels, and a leg is matched at its own line, not an alt line', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const { collectPage, parseCollected } = require('../agents/outlier/extract');
    const year = new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0);
    const page = await launched.browser.newPage();
    // Like Outlier's Props board: labels only in the header, rows of bare percentages lined up under them.
    const cell = 'width:70px;flex:none';
    const row = (name, stat, line, odds, rates) => `<div style="display:flex"><span style="${cell};width:160px">${name}</span><span style="${cell}">${stat}</span><span style="${cell}">Over ${line}</span><span style="${cell}">${odds}</span>${rates.map(r => `<span style="${cell}">${r}%</span>`).join('')}</div>`;
    await page.setContent(`<div style="display:flex"><span style="${cell};width:160px">Player</span><span style="${cell}">Prop</span><span style="${cell}">Line</span><span style="${cell}">Odds</span>`
        + ['L5', 'L10', 'L20', 'H2H', String(year), String(year - 1)].map(l => `<span style="${cell}">${l} ↑↓</span>`).join('') + '</div>'
        + row('Trae Young', 'Assists', 0.5, '-2000', [100, 100, 100, 100, 100, 100])
        + row('Trae Young', 'Assists', 9.5, '-119', [80, 70, 65, 50, 60, 55])
        + row('Trae Young', 'Assists', 10.5, '+120', [40, 50, 45, 50, 48, 44]));
    const collected = await page.evaluate(collectPage, null);
    const { props } = parseCollected([{ kind: 'props', url: 'https://app.outlier.bet/NBA/props', collected }]);
    const main = props.find(p => p.line === 9.5);
    assert.deepEqual(main.hitRates, { l5: 0.8, l10: 0.7, l20: 0.65, h2h: 0.5, season: 0.6, last: 0.55 });
    const { matchLeg } = require('../agents/outlier');
    const match = matchLeg({ player: 'Trae Young', stat: 'Assists', line: 9.5, side: 'Over' }, props);
    assert.equal(match.row.line, 9.5, 'the 9.5 row, not the 0.5 alt line at -2000');
    assert.equal(match.sameLine, true);
    const under = matchLeg({ player: 'Trae Young', stat: 'Assists', line: 9.5, side: 'Under' }, props);
    assert.equal(Math.round(under.rates.l5 * 100), 20, 'an Under reads the Over row\'s rate turned around');
    const between = matchLeg({ player: 'Trae Young', stat: 'Assists', line: 10, side: 'Over' }, props);
    assert.ok([9.5, 10.5].includes(between.row.line));
});

test('a player named differently by the DFS app and Outlier still matches: initials, Jr., III, accents, EVEN odds', () => {
    const { sameName } = require('../agents/outlier/navigate');
    assert.ok(sameName('AJ Brown', 'A.J. Brown'));
    assert.ok(sameName('Marvin Harrison', 'Marvin Harrison Jr.'));
    assert.ok(sameName('Kenneth Walker', 'Kenneth Walker III'));
    assert.ok(sameName('Luka Doncic', 'Luka Dončić'));
    assert.ok(sameName('C. Lamb', 'CeeDee Lamb'));
    assert.ok(!sameName('Josh Allen', 'Josh Jacobs'));
    assert.ok(!sameName('A Brown', 'J Brown'));
    const { parseText } = require('../agents/outlier/extract');
    assert.deepEqual(parseText('A.J. Brown\nReceiving Yards\nOver 62.5\nFanDuel EVEN').odds, [{ book: 'fanduel', price: 100 }]);
});

test('early in a season this season counts more than last season, per sport', () => {
    const { seasonStage, rateWeights } = require('../agents/outlier');
    assert.deepEqual(seasonStage('NBA', new Date(2026, 9, 27)), { sport: 'NBA', day: 7, early: true });
    assert.equal(seasonStage('NFL', new Date(2026, 9, 27)).early, false, 'Week 8 of the NFL is not early');
    assert.equal(seasonStage('NFL', new Date(2026, 8, 20)).early, true);
    assert.equal(seasonStage('NBA', new Date(2026, 2, 1)).early, false, 'March is late in the season that started last October');
    assert.equal(seasonStage('Tennis'), null);
    assert.ok(rateWeights({ early: true }).season > rateWeights({ early: true }).last);
    assert.equal(rateWeights(null).l10, 1);
});

test('a leg matches its full-game stat, not a quarter, combo or far-off alt line, and a moved line still matches', () => {
    const { matchLeg } = require('../agents/outlier');
    const row = (player, market, line, l10) => ({ player, market, line, side: 'Over', hitRates: { l10 }, odds: [] });
    const props = [
        row('Trae Young', '1st Quarter Assists', 0.5, 0.9), row('Trae Young', 'Assists', 10.5, 0.5),
        row('Brandon Miller', 'Pts+Rebs+Asts', 33.5, 0.6), row('Brandon Miller', 'Points', 24, 0.55),
        row('Anthony Davis', 'Rebounds', 0.5, 1), row('Naz Reid', 'Blocks + Steals', 1.5, 0.4), row('Naz Reid', 'Blocks', 0.5, 0.7)
    ];
    const trae = matchLeg({ player: 'Trae Young', stat: 'Assists', line: 9.5, side: 'Over' }, props);
    assert.equal(trae.row.market, 'Assists', 'not the 1st quarter line');
    const miller = matchLeg({ player: 'Brandon Miller', stat: 'Points', line: 23.5, side: 'Over' }, props);
    assert.equal(miller.row.market, 'Points', 'not Pts+Rebs+Asts');
    assert.equal(miller.sameLine, false);
    assert.equal(miller.easier, true, 'the line moved to 24: the user\'s 23.5 is easier');
    assert.equal(matchLeg({ player: 'Anthony Davis', stat: 'Rebounds', line: 11.5 }, props), null, 'a 0.5 line is another market, not his 11.5');
    assert.equal(matchLeg({ player: 'Naz Reid', stat: 'Blocks + Steals', line: 1.5 }, props).row.market, 'Blocks + Steals');
});

test('forecasts come only from the card\'s numbers: projection, regression, game lines, and a seeded ticket simulation with correlation', () => {
    const f = require('../agents/outlier/forecast');
    const card = (vals, line, side = 'Over', dated = true) => ({
        games: vals.map((v, i) => ({ value: v, minutes: 30 + (i % 3), date: dated ? `d${i}` : null })),
        atLine: { all: [vals.filter(v => (side === 'Under' ? v < line : v > line)).length, vals.length] },
        numbers: { Minutes: { values: [31, 31, 32], windows: ['L5', 'L10', '2026'] } }
    });
    assert.equal(f.projectLeg({ games: [{ value: 20, minutes: 30 }] }, { line: 20 }), null, 'too few games: no projection');
    const a = card([20, 25, 22, 28, 30, 18, 26, 24, 29, 31], 22.5);
    assert.deepEqual(f.projectLeg(a, { line: 22.5 }), { projection: 25.9, perMin: 0.84, expMin: 31, gamesUsed: 10, minutesFrom: "the card's L5 minutes", diff: 3.4 });
    const b = card([8, 10, 9, 12, 13, 7, 11, 10, 12, 14], 9.5);
    const together = f.simulateTicket([a, b], [{ side: 'Over' }, { side: 'Over' }]);
    assert.ok(together.joint > together.independent + 0.1, 'two Overs that rise together hit together more often');
    assert.deepEqual(f.simulateTicket([a, b], [{ side: 'Over' }, { side: 'Over' }]), together, 'seeded: the same answer every time');
    const apart = f.simulateTicket([a, card([8, 10, 9, 12, 13, 7, 11, 10, 12, 14], 9.5, 'Under')], [{ side: 'Over' }, { side: 'Under' }]);
    assert.ok(apart.joint < apart.independent, 'an Over and an Under on numbers that rise together rarely both hit');
    assert.equal(f.simulateTicket([a, { games: [], atLine: { all: [2, 3] } }], []), null, 'a leg with under 5 games: no simulation');
    assert.match(f.regressionFlag(card([30, 31, 29, 32, 30, 22, 21, 20, 23, 22], 25), { side: 'Over' }, () => 0), /cold lately .* steady volume/);
    assert.equal(f.regressionFlag({ games: a.games, numbers: {} }, { side: 'Over' }, () => 0), null, 'no volume numbers: no flag');
    assert.deepEqual(f.gameContext('WAS @ CHA\nO/U 231.5 · CHA -3.5'), { total: 231.5, spread: 'CHA -3.5' });
    assert.equal(f.gameContext('FGA +2 · Total 18'), null, 'not a spread or a game total');
});
