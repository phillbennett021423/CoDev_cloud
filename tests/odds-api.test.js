// Line tracking with The Odds API (mobile/www/agent-ui/odds-api.js): the lookup list
// agents take to Outlier, snapshots and line movement, comparing books, and the
// credit limits (cache, reserve, daily pacing). The API itself is a stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const Odds = require('../mobile/www/agent-ui/odds-api.js');
const { handleWebFetch } = require('../web-fetch');

const START = Date.parse('2026-10-28T17:00:00Z');
const GAME = { id: 'ev1', sport_key: 'basketball_nba', commence_time: '2026-10-29T00:00:00Z', home_team: 'Boston Celtics', away_team: 'Los Angeles Lakers' };
const OTHER = { id: 'ev2', sport_key: 'basketball_nba', commence_time: '2026-10-29T02:30:00Z', home_team: 'Denver Nuggets', away_team: 'Phoenix Suns' };

function memoryStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

const prop = (player, point, over, under) => [
    { name: 'Over', description: player, point, price: over },
    { name: 'Under', description: player, point, price: under }
];
// Two books' points props; lines: { dk: [...], fd: [...] } per player.
function propsEvent(lines) {
    const book = (key, title, list) => ({ key, title, markets: [{ key: 'player_points', outcomes: list.flatMap(p => prop(...p)) }] });
    return { ...GAME, bookmakers: [book('draftkings', 'DraftKings', lines.dk), book('fanduel', 'FanDuel', lines.fd)] };
}

// A stand-in for api.the-odds-api.com that counts credits like the real one.
function fakeApi({ remaining = 480, props }) {
    const state = { remaining, calls: [], props };
    const http = async url => {
        const u = new URL(url);
        state.calls.push(u.pathname + u.search);
        if (u.searchParams.get('apiKey') !== 'good-key') return { status: 401, body: { message: 'bad key' }, headers: {} };
        if (u.pathname === '/v4/sports/basketball_nba/events') return { status: 200, body: [GAME, OTHER], headers: { 'x-requests-remaining': String(state.remaining), 'x-requests-last': '0' } };
        const cost = u.searchParams.get('markets').split(',').length * u.searchParams.get('regions').split(',').length;
        state.remaining -= cost;
        const headers = { 'x-requests-remaining': String(state.remaining), 'x-requests-used': String(500 - state.remaining), 'x-requests-last': String(cost) };
        if (u.pathname === '/v4/sports/basketball_nba/events/ev1/odds') return { status: 200, body: state.props, headers };
        if (u.pathname === '/v4/sports/basketball_nba/odds') return { status: 200, body: [], headers };
        return { status: 404, body: { message: 'unknown' }, headers };
    };
    return { state, http };
}

function setup({ remaining, props, key = 'good-key' } = {}) {
    const storage = memoryStorage();
    if (key) storage.setItem(Odds.STORE.apiKey, key);
    let t = START;
    const api = fakeApi({ remaining, props: props || propsEvent({ dk: [['Jayson Tatum', 27.5, -115, -105], ['LeBron James', 24.5, -110, -110]], fd: [['Jayson Tatum', 27.5, -120, 100], ['LeBron James', 25.5, -110, -110]] }) });
    const tracker = Odds.createOddsTracker({ storage, http: api.http, now: () => t });
    return { tracker, api, storage, advance: ms => { t += ms; } };
}

const paid = api => api.state.calls.filter(c => !c.includes('/events?'));

test('stat names map to Odds API markets and back to Outlier names', () => {
    assert.equal(Odds.sportKey('NBA'), 'basketball_nba');
    assert.equal(Odds.sportKey('americanfootball_nfl'), 'americanfootball_nfl');
    assert.equal(Odds.marketFor('PRA'), 'player_points_rebounds_assists');
    assert.equal(Odds.marketFor('Rebounds'), 'player_rebounds');
    assert.equal(Odds.marketFor('Receiving Yards'), 'player_reception_yds');
    assert.equal(Odds.marketFor('strikeouts', 'baseball_mlb'), 'pitcher_strikeouts');
    assert.equal(Odds.marketFor('spread'), 'spreads');
    assert.equal(Odds.marketLabel('player_threes'), '3-Pointers Made');
});

test('without a key only odds_status is offered, and it says where to get one', async () => {
    const { tracker } = setup({ key: '' });
    const tools = tracker.buildTools();
    assert.deepEqual(tools.map(t => t.name), ['odds_status']);
    assert.match(await tools[0].run({}), /free key at https:\/\/the-odds-api\.com/);
});

test('the lookup list gives players, stats, lines, sides and books for Outlier, and reuses the saved props', async () => {
    const { tracker, api } = setup();
    const names = tracker.buildTools().map(t => t.name);
    assert.ok(names.includes('odds_lookup_list') && names.includes('odds_player_props'));
    const text = await tracker.lookupList({ sport: 'NBA', game: 'Lakers', stats: 'Points' });
    assert.match(text, /Look these up on Outlier/);
    assert.match(text, /LeBron James \| Points \| 24\.5 \|/);
    assert.match(text, /books disagree: 24\.5 at DraftKings vs 25\.5 at FanDuel/);
    assert.match(text, /Jayson Tatum \| Points \| 27\.5 \| Over/);
    assert.match(text, /Only one snapshot so far/);
    const legs = JSON.parse(text.match(/Legs for outlier_research_list: (.*)/)[1]);
    assert.ok(legs.some(l => l.player === 'Jayson Tatum' && l.stat === 'Points' && l.line === 27.5 && l.side === 'Over'));
    assert.equal(paid(api).length, 1, 'one paid call for one game and one stat');
    assert.match(paid(api)[0], /markets=player_points&/);

    await tracker.lookupList({ sport: 'NBA', game: 'Lakers', stats: 'Points' });
    assert.equal(paid(api).length, 1, 'saved props are reused within the hour');
    assert.equal(tracker.usage().remaining, 479);
});

test('a second snapshot shows line movement, book by book', async () => {
    const { tracker, api, advance } = setup();
    await tracker.playerProps({ sport: 'NBA', game: 'Celtics', stats: 'Points' });
    advance(2 * 3600000);
    api.state.props = propsEvent({ dk: [['Jayson Tatum', 28.5, -110, -110], ['LeBron James', 24.5, -110, -110]], fd: [['Jayson Tatum', 28.5, -115, -105], ['LeBron James', 25.5, -110, -110]] });
    const list = await tracker.lookupList({ sport: 'NBA', game: 'Celtics', stats: 'points' });
    assert.equal(paid(api).length, 2);
    assert.match(list, /1\. Jayson Tatum \| Points \| 28\.5 \| Over/, 'the biggest mover comes first, and a line going up leans Over');
    assert.match(list, /line moved 27\.5 -> 28\.5/);
    const moves = await tracker.lineMovement({ player: 'Tatum', stats: 'Points' });
    assert.match(moves, /2 snapshots/);
    assert.match(moves, /DraftKings: .*27\.5 -115 -> .*28\.5 -110/);
    const props = await tracker.playerProps({ sport: 'NBA', game: 'Celtics', player: 'Tatum', stats: 'Points' });
    assert.match(props, /Best Over: 28\.5 -110 at DraftKings/);
    assert.equal(paid(api).length, 2, 'the props are still fresh');
});

test('credits: never past the reserve, and the month is spread over its days', async () => {
    const low = setup({ remaining: 27 });
    await low.tracker.lookupList({ sport: 'NBA', game: 'Lakers', stats: 'Points' });   // learns the real balance (27 -> 26)
    const blocked = await low.tracker.playerProps({ sport: 'NBA', game: 'Lakers', stats: 'Points, Rebounds', refresh: true });
    assert.match(blocked, /not fetched: only 26 Odds API credits are left this month and CoDev keeps 25 in reserve/);
    assert.equal(paid(low.api).length, 1);

    const paced = setup({ remaining: 120 });
    paced.tracker.saveSettings({ propsMinutes: 1 });
    let refused = '';
    for (let i = 0; i < 6 && !refused; i++) {
        const text = await paced.tracker.playerProps({ sport: 'NBA', game: 'Lakers', stats: 'Points, Rebounds, Assists, PRA', refresh: true });
        if (/today's share/.test(text)) refused = text;
        paced.advance(11 * 60000);
    }
    // (120 - 25) / 4 days left in October = 23 a day: 5 calls of 4 credits fit, the 6th doesn't.
    assert.match(refused, /today's share of the month's credits is used \(20 of 23\)/);
    assert.match(await paced.tracker.status(), /Today's share: 3 credits left of 23/);
});

test('a bad key is reported plainly', async () => {
    const { tracker } = setup({ key: 'wrong' });
    const [tool] = tracker.buildTools().filter(t => t.name === 'odds_lookup_list');
    assert.match(await tool.run({ sport: 'NBA', game: 'Lakers' }), /didn't accept the key/);
});

test('server.js fetches only The Odds API for the page', async () => {
    assert.match((await handleWebFetch({ kind: 'odds', url: 'https://example.com/v4/sports' })).error, /Only The Odds API/);
});
