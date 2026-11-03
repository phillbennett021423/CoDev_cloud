// CoDev's prop model (mobile/www/agent-ui/prop-model.js): ESPN game logs, the model's
// chance against the market, steam and the trap check, and the slate archive and
// backtest. ESPN and The Odds API are stand-ins shaped like their JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../mobile/www/agent-ui/prop-model.js');
const Odds = require('../mobile/www/agent-ui/odds-api.js');
const { handleWebFetch } = require('../web-fetch');

function memoryStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

// An ESPN NBA gamelog: points per game, oldest first, one game a day from `first`.
function gamelog(points, { first = '2026-10-01T23:00Z', minutes = 34, season = 2027 } = {}) {
    const names = ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'totalRebounds', 'assists', 'points'];
    const labels = ['MIN', 'FG', '3PT', 'REB', 'AST', 'PTS'];
    const events = {}, rows = [];
    points.forEach((p, i) => {
        const id = `g${i}`;
        const date = new Date(Date.parse(first) + i * 86400000).toISOString();
        events[id] = { id, gameDate: date, atVs: i % 2 ? '@' : 'vs', opponent: { abbreviation: i % 3 ? 'LAL' : 'BOS', displayName: i % 3 ? 'Los Angeles Lakers' : 'Boston Celtics' }, gameResult: 'W' };
        rows.unshift({ eventId: id, stats: [String(minutes), '9-18', '2-6', '7', String(5 + (i % 3)), String(p)] });
    });
    return { names, labels, events, filters: [{ name: 'season', value: String(season) }],
        seasonTypes: [{ displayName: '2026-27 Regular Season', categories: [{ type: 'event', events: rows }, { type: 'total', totals: ['x'] }] }] };
}

function fakeEspn(logs) {
    const calls = [];
    const http = async url => {
        calls.push(url);
        const u = new URL(url);
        if (u.pathname.endsWith('/search')) return { status: 200, body: { items: [
            { id: '999', uid: 's:40~l:46~a:999', displayName: 'Nikola Jovic', type: 'player', league: 'nba' },
            { id: '3112335', uid: 's:40~l:46~a:3112335', displayName: 'Nikola Jokic', type: 'player', league: 'nba', subtitle: 'Denver Nuggets' }
        ] } };
        const m = /athletes\/(\d+)\/gamelog/.exec(u.pathname);
        if (m) {
            const season = u.searchParams.get('season');
            const body = logs[`${m[1]}${season ? `:${season}` : ''}`];
            return body ? { status: 200, body } : { status: 404, body: {} };
        }
        return { status: 404, body: {} };
    };
    return { http, calls };
}

test('reads an ESPN gamelog into games and a stat series, combos included', () => {
    const log = Model.parseGameLog(gamelog([20, 25, 30]));
    assert.equal(log.games.length, 3);
    assert.equal(log.season, 2027);
    assert.equal(log.games[0].opp, 'BOS');
    const pts = Model.seriesFor(log.games, 'player_points', 'basketball_nba');
    assert.deepEqual(pts.map(g => g.value), [20, 25, 30]);
    assert.equal(pts[0].minutes, 34);
    const pra = Model.seriesFor(log.games, 'player_points_rebounds_assists', 'basketball_nba');
    assert.deepEqual(pra.map(g => g.value), [32, 38, 44]);
    assert.deepEqual(Model.seriesFor(log.games, 'player_threes', 'basketball_nba').map(g => g.value), [2, 2, 2]);
});

test('search results pick the right player', () => {
    const found = Model.parseSearch({ items: [{ id: '1', uid: 's:40~l:46~a:1', displayName: 'A B', type: 'player' }, { id: '2', displayName: 'Team', type: 'team' }] });
    assert.deepEqual(found, [{ id: '1', name: 'A B', sport: 'basketball_nba', team: '' }]);
});

test('the game-log chance follows the hit rate and is shrunk on a short log', () => {
    const always = Model.statProb([30, 31, 29, 33, 30, 32, 35, 30, 31, 34], 24.5, 'Over');
    assert.ok(always.p > 0.75 && always.p < 0.97, `strong over: ${always.p}`);
    const under = Model.statProb([30, 31, 29, 33, 30, 32, 35, 30, 31, 34], 24.5, 'Under');
    assert.ok(under.p < 0.25);
    const short = Model.statProb([30, 31], 24.5, 'Over');
    assert.ok(short.p < always.p, 'two games say less than ten');
    // A whole-number line: pushes are left out.
    assert.equal(Model.outcome(25, 25, 'Over'), 'push');
});

test('EV, breakeven and Kelly at a price', () => {
    const v = Model.value(0.6, { price: -110 });
    assert.ok(Math.abs(v.breakeven - 0.5238) < 0.001);
    assert.ok(v.ev > 0.14 && v.ev < 0.15);
    assert.ok(v.kelly > 0 && v.kelly <= 0.05);
    assert.equal(Model.value(0.5, { price: -110 }).kelly, 0);
    assert.ok(Math.abs(Model.value(0.6, { breakeven: 0.542 }).edge - 0.058) < 1e-9);
});

test('market check: agrees, moving against, and a trap', () => {
    const none = { moves: [], stale: [] };
    assert.equal(Model.marketCheck({ side: 'Over', pStat: 0.6, pMarket: 0.56, steam: none }).verdict, 'agrees');
    assert.equal(Model.marketCheck({ side: 'Over', pStat: 0.75, pMarket: 0.42, steam: none }).verdict, 'trap');
    const sharpUnder = { moves: [{ side: 'Under', books: ['A', 'B', 'C'], of: 3, steam: true, sharpLed: true, sharp: ['Pinnacle'] }], stale: [] };
    assert.equal(Model.marketCheck({ side: 'Over', pStat: 0.6, pMarket: 0.55, steam: sharpUnder }).verdict, 'trap');
    const softUnder = { moves: [{ side: 'Under', books: ['A', 'B'], of: 3, steam: false, sharpLed: false, sharp: [] }], stale: [] };
    assert.equal(Model.marketCheck({ side: 'Over', pStat: 0.6, pMarket: 0.55, steam: softUnder }).verdict, 'against');
    assert.equal(Model.marketCheck({ side: 'Over', pStat: 0.6, pMarket: null, steam: none }).verdict, 'no market');
});

// ---- With the odds tracker ----

const START = Date.parse('2026-11-01T17:00:00Z');
const GAME = { id: 'ev1', sport_key: 'basketball_nba', commence_time: '2026-11-02T00:00:00Z', home_team: 'Denver Nuggets', away_team: 'Los Angeles Lakers' };
const book = (key, title, point, over, under) => ({ key, title, markets: [{ key: 'player_points', outcomes: [
    { name: 'Over', description: 'Nikola Jokic', point, price: over }, { name: 'Under', description: 'Nikola Jokic', point, price: under }] }] });

function setup({ points, books }) {
    let t = START;
    const storage = memoryStorage();
    storage.setItem(Odds.STORE.apiKey, 'good-key');
    let current = books;
    const oddsHttp = async url => {
        const u = new URL(url);
        if (u.pathname.endsWith('/events')) return { status: 200, body: [GAME], headers: { 'x-requests-remaining': '400' } };
        return { status: 200, body: { ...GAME, bookmakers: current }, headers: { 'x-requests-remaining': '399', 'x-requests-last': '1' } };
    };
    const tracker = Odds.createOddsTracker({ storage, http: oddsHttp, now: () => t });
    const espn = fakeEspn({ 3112335: gamelog(points, { first: '2026-10-05T01:00Z' }) });
    const model = Model.createPropModel({ storage, http: espn.http, tracker, odds: Odds, now: () => t });
    return { tracker, model, storage, espn, advance: ms => { t += ms; }, setBooks: b => { current = b; }, setLog: l => { espn.logs = l; } };
}

const strong = [28, 31, 27, 33, 30, 29, 35, 26, 32, 30, 31, 28, 34, 29, 30, 33];

test('stats_player_log pulls the log from ESPN and gives hit rates at the line', async () => {
    const { model } = setup({ points: strong, books: [] });
    const tools = Object.fromEntries(model.buildTools().map(t => [t.name, t]));
    const text = await tools.stats_player_log.run({ sport: 'NBA', player: 'Nikola Jokic', stat: 'Points', line: 27.5, opponent: 'Lakers' });
    assert.match(text, /Nikola Jokic \(Denver Nuggets\): Points from ESPN's game log, 16 games/);
    assert.match(text, /L5 5\/5 · L10 9\/10/);
    assert.match(text, /Vs Lakers: .*at the line/);
    assert.match(text, /Game-log chance of the Over 27.5: \d+/);
});

test('model_prop_edge: stats, market, EV, steam and the market check, and the pick is saved', async () => {
    const s = setup({ points: strong, books: [book('draftkings', 'DraftKings', 27.5, -115, -105), book('fanduel', 'FanDuel', 27.5, -110, -110), book('pinnacle', 'Pinnacle', 27.5, -112, -108)] });
    await s.tracker.playerProps({ sport: 'NBA', game: 'Nuggets', stats: 'Points' });
    // An hour later every book moved to 28.5, Pinnacle first.
    s.advance(40 * 60000);
    s.setBooks([book('draftkings', 'DraftKings', 27.5, -115, -105), book('fanduel', 'FanDuel', 27.5, -110, -110), book('pinnacle', 'Pinnacle', 28.5, -110, -110)]);
    await s.tracker.playerProps({ sport: 'NBA', game: 'Nuggets', stats: 'Points', refresh: true });
    s.advance(40 * 60000);
    s.setBooks([book('draftkings', 'DraftKings', 28.5, -115, -105), book('fanduel', 'FanDuel', 28.5, -110, -110), book('pinnacle', 'Pinnacle', 28.5, -110, -110)]);
    await s.tracker.playerProps({ sport: 'NBA', game: 'Nuggets', stats: 'Points', refresh: true });
    const tools = Object.fromEntries(s.model.buildTools().map(t => [t.name, t]));
    const text = await tools.model_prop_edge.run({ sport: 'NBA', legs: [{ player: 'Nikola Jokic', stat: 'Points', line: 27.5, side: 'Over' }] });
    assert.match(text, /Nikola Jokic \| Points \| Over 27.5 \(Los Angeles Lakers @ Denver Nuggets\)/);
    assert.match(text, /Game-log chance \d+(\.\d)?% · market no-vig \d+(\.\d)?% \(books at 28.5, moved to your line\)/);
    assert.match(text, /Your line is 1 easier than the books' 28.5/);
    assert.match(text, /Market check: Market agrees, and money is moving your way/);
    assert.match(text, /sharp-led/);
    const saved = s.model.archive().records.filter(r => r.source === 'pick');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].side, 'Over');

    // Steam shows in the odds tool too.
    const steam = await Odds.createOddsTracker({ storage: s.storage, http: async () => ({ status: 500, body: {}, headers: {} }), now: () => START + 80 * 60000 }).steamList({ sport: 'NBA' });
    assert.match(steam, /Steam toward the Over: DraftKings, FanDuel \(2 of 3\)/);
    assert.match(steam, /not a live feed/);
});

test('findSteam: a sharp move the soft books have not followed is a stale price', () => {
    const t0 = 1000, t1 = 1000 + 30 * 60000;
    const r = { sides: ['Over', 'Under'], market: 'player_points', books: [
        { book: 'pinnacle', title: 'Pinnacle', history: { Over: [[t0, 24.5, -110], [t1, 25.5, -110]], Under: [[t0, 24.5, -110], [t1, 25.5, -110]] } },
        { book: 'draftkings', title: 'DraftKings', history: { Over: [[t0, 24.5, -110]], Under: [[t0, 24.5, -110]] } },
        { book: 'fanduel', title: 'FanDuel', history: { Over: [[t0, 24.5, -112]], Under: [[t0, 24.5, -108]] } }
    ] };
    const st = Odds.findSteam(r);
    assert.equal(st.moves.length, 0, 'one book is not steam');
    assert.deepEqual(st.stale.map(s => [s.sharp, s.side, s.behind]), [['Pinnacle', 'Over', ['DraftKings', 'FanDuel']]]);
});

test('archive and backtest: closing lines are kept, settled from ESPN, and the model re-run ex ante', async () => {
    // 16 games before this one; the game itself (index 16) scores 35.
    const s = setup({ points: strong, books: [book('draftkings', 'DraftKings', 27.5, -115, -105), book('fanduel', 'FanDuel', 27.5, -110, -110)] });
    await s.tracker.playerProps({ sport: 'NBA', game: 'Nuggets', stats: 'Points' });
    const tools = Object.fromEntries(s.model.buildTools().map(t => [t.name, t]));
    await tools.model_prop_edge.run({ sport: 'NBA', player: 'Nikola Jokic', stat: 'Points', line: 27.5, side: 'Over', price: -115 });
    // The game starts: the close goes into the archive.
    s.advance(8 * 3600000);
    assert.equal(s.model.archiveSlate(), 1);
    // After the game ESPN has it (game 16 is on Nov 2 01:00Z, an hour after the start).
    s.advance(5 * 3600000);
    const espn = fakeEspn({ 3112335: gamelog([...strong, 35], { first: '2026-10-17T01:00Z' }) });
    const model = Model.createPropModel({ storage: s.storage, http: espn.http, tracker: s.tracker, odds: Odds, now: () => START + 13 * 3600000 });
    const text = await Object.fromEntries(model.buildTools().map(t => [t.name, t])).model_backtest.run({ min_edge: 0 });
    assert.match(text, /Settled 2 props from ESPN box scores/);
    assert.match(text, /Backtest over 1 settled props from 1 slate/);
    assert.match(text, /Bets: 1 \(1-0\)/);
    assert.match(text, /Only 1 props: too few to trust/);
    assert.match(text, /Your evaluated picks: 1 saved, 1 settled \(1-0\)/);
    const market = model.archive().records.find(r => r.source === 'market');
    assert.equal(market.actual, 35);
    assert.equal(market.result, 'hit');
    assert.equal(market.exGames, 16, 'only the games before it');
});

test('backtest with nothing settled says how the archive fills', async () => {
    const { model } = setup({ points: strong, books: [] });
    const text = await Object.fromEntries(model.buildTools().map(t => [t.name, t])).model_backtest.run({});
    assert.match(text, /No settled props to test yet/);
});

test('server.js fetches only ESPN\'s API for the model', async () => {
    const refused = await handleWebFetch({ kind: 'espn', url: 'https://example.com/apis/x' });
    assert.match(refused.error, /Only ESPN/);
    assert.ok(Model.ESPN_URL.test('https://site.web.api.espn.com/apis/common/v3/search?query=x'));
    assert.ok(Model.ESPN_URL.test('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'));
    assert.ok(!Model.ESPN_URL.test('https://evil.com/?https://site.api.espn.com/apis/'));
});

// ---- Schedule, injuries and batch hit rates (ESPN's site API, no key) ----

const SCOREBOARD = { events: [
    { id: '1', date: '2026-11-03T00:30Z', name: 'Chicago Bulls at Philadelphia 76ers', status: { type: { state: 'pre', shortDetail: '11/2 - 7:30 PM EST' } },
        competitions: [{ competitors: [
            { homeAway: 'home', team: { displayName: 'Philadelphia 76ers', abbreviation: 'PHI', shortDisplayName: '76ers' }, records: [{ type: 'total', summary: '4-2' }] },
            { homeAway: 'away', team: { displayName: 'Chicago Bulls', abbreviation: 'CHI', shortDisplayName: 'Bulls' }, records: [{ type: 'total', summary: '3-3' }] }],
        odds: [{ details: 'PHI -4.5', overUnder: 221.5 }] }] },
    { id: '2', date: '2026-11-03T00:00Z', name: 'Oklahoma City Thunder at Cleveland Cavaliers', status: { type: { state: 'in', shortDetail: 'Q2 5:10' } },
        competitions: [{ competitors: [
            { homeAway: 'home', score: '50', team: { displayName: 'Cleveland Cavaliers', abbreviation: 'CLE', shortDisplayName: 'Cavaliers' } },
            { homeAway: 'away', score: '48', team: { displayName: 'Oklahoma City Thunder', abbreviation: 'OKC', shortDisplayName: 'Thunder' } }] }] }
] };
const INJURIES = { injuries: [
    { displayName: 'Philadelphia 76ers', injuries: [
        { status: 'Questionable', athlete: { displayName: 'Joel Embiid', position: { abbreviation: 'C' } }, details: { type: 'Foot' } },
        { status: 'Out', athlete: { displayName: 'Dominick Barlow', position: { abbreviation: 'F' } }, shortComment: 'Barlow (knee) is out.' }] },
    { displayName: 'Chicago Bulls', injuries: [] }
] };

function sportsSetup(points = strong) {
    const storage = memoryStorage();
    const espn = fakeEspn({ 3112335: gamelog(points, { first: '2026-10-05T01:00Z' }) });
    const http = async url => {
        if (/\/scoreboard\?/.test(url)) return { status: 200, body: SCOREBOARD };
        if (/\/injuries$/.test(url)) return { status: 200, body: INJURIES };
        return espn.http(url);
    };
    const model = Model.createPropModel({ storage, http, odds: Odds, now: () => Date.parse('2026-11-02T20:00:00Z') });
    return Object.fromEntries(model.buildTools().map(t => [t.name, t]));
}

test('parses ESPN scoreboards and injury feeds, times and team names', () => {
    const games = Model.parseScoreboard(SCOREBOARD);
    assert.deepEqual(games.map(g => g.id), ['2', '1'], 'sorted by start');
    assert.equal(games[1].spread, 'PHI -4.5');
    assert.equal(games[1].total, 221.5);
    assert.equal(games[1].away.record, '3-3');
    const inj = Model.parseInjuries(INJURIES);
    assert.equal(inj[0].players[0].note, 'Foot');
    assert.ok(Model.teamMatches(games[1].home, '76ers') && Model.teamMatches(games[1].home, 'PHI') && Model.teamMatches(games[1].away, 'chicago'));
    assert.ok(!Model.teamMatches(games[1].home, 'Bulls'));
    assert.deepEqual(Model.parseClock('6:30pm CT'), { h: 18, m: 30, zone: 'America/Chicago' });
    assert.deepEqual(Model.parseClock('7:30'), { h: 19, m: 30, zone: null }, 'a bare game time is the evening');
    assert.equal(Model.parseClock('Bulls'), null);
    assert.deepEqual(Model.clockOf(Date.parse('2026-11-03T00:30Z'), 'America/Chicago'), { h: 18, m: 30 });
    assert.equal(Model.espnDate('2026-11-02', 0), '20261102');
    assert.equal(Model.sideOf('Lower'), 'Under');
    assert.equal(Model.sideOf('Higher'), 'Over');
    assert.equal(Model.sideOf('Under'), 'Under');
});

test('sports_schedule finds the games at a time in another time zone', async () => {
    const tools = sportsSetup();
    const text = await tools.sports_schedule.run({ sport: 'NBA', time: '6:30pm CT' });
    assert.match(text, /6:30 PM CST .*Chicago Bulls \(3-3\) @ Philadelphia 76ers \(4-2\) · PHI -4.5, O\/U 221.5/);
    assert.doesNotMatch(text, /Thunder/);
    const all = await tools.sports_schedule.run({ sport: 'NBA' });
    assert.match(all, /live: Q2 5:10 48-50/);
    assert.match(await tools.sports_schedule.run({ sport: 'NBA', time: '9pm ET' }), /No NBA game .* at 9pm ET\. Start times that day:/);
});

test('sports_injuries lists Out first, by team or by the games at a time', async () => {
    const tools = sportsSetup();
    const text = await tools.sports_injuries.run({ sport: 'NBA', time: '6:30pm CT' });
    assert.match(text, /for CHI @ PHI/);
    assert.match(text, /Philadelphia 76ers: Dominick Barlow \(F\) Out, Barlow \(knee\) is out\.; Joel Embiid \(C\) Questionable, Foot/);
    assert.match(text, /Chicago Bulls: nobody listed/);
    assert.match(await tools.sports_injuries.run({ sport: 'NBA', teams: 'PHI' }), /Philadelphia 76ers: Dominick Barlow/);
});

test('props_hit_rates gives L5/L10/L20 for every leg in one call, Higher/Lower included', async () => {
    const tools = sportsSetup();
    const text = await tools.props_hit_rates.run({ sport: 'NBA', legs: [
        { player: 'Nikola Jokic', stat: 'Points', line: 27.5, side: 'Higher' },
        { player: 'Nikola Jokic', stat: 'Points', line: 30.5, side: 'Lower' }] });
    assert.match(text, /Nikola Jokic · Points · Higher 27.5: L5 5\/5 · L10 9\/10 · L20 14\/16 · season avg 30.4 in 16 games · last 5: 28, 34, 29, 30, 33/);
    assert.match(text, /Nikola Jokic · Points · Lower 30.5: L5 3\/5/);
    assert.ok(text.indexOf('Higher 27.5') < text.indexOf('Lower 30.5'), 'best L10 first');
    assert.match(await tools.props_hit_rates.run({ sport: 'NBA' }), /Give the legs/);
});
