// CoDev's own prop engine: the half of an Outlier-style setup that code can do for free.
//
//  - Stats: player game logs pulled automatically from ESPN's free public JSON (no key),
//    cached on the device, so a prop can be checked without opening Outlier at all.
//  - Model: a hit chance from the game log (recency-weighted hit rate plus a fitted
//    distribution at the line), blended with the market's no-vig chance from The Odds
//    API lines CoDev saved (agent-ui/odds-api.js), then EV and a Kelly stake at a price.
//  - Market check: does the market agree, is money moving with or against the pick
//    (steam, sharp books first), or does the game log like something the books price
//    well below it (a likely trap: news the log can't see)?
//  - Slate archive and backtest: every prop line CoDev saw is kept at its close after the
//    game starts, settled from the box score later, and the model is re-run on each one
//    with only the games before it, so rules and the market weight can be tested across
//    past slates. The user's own evaluated picks are kept too, with closing line value.
//
// What free data can't do: ESPN's JSON is unofficial and can change shape; The Odds API's
// free plan gives snapshots every 30+ minutes, not a live feed; there is no free source of
// public betting splits or bet counts. Estimates, never guarantees.
//
// Runs in the page (window.CodevPropModel) and in Node (tests), like odds-api.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevPropModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3";
    const ESPN_URL = /^https:\/\/site\.(web\.)?api\.espn\.com\/apis\//;
    const STORE = { players: "codev_stats_players", logs: "codev_stats_logs", archive: "codev_model_archive", settings: "codev_model_settings" };
    const DEFAULTS = {
        marketWeight: 0.6,      // how much the blended chance trusts the market over the game log
        halfLife: 10,           // games: the weight of a game halves every this many games back
        prior: 8,               // games' worth of shrinkage toward 50% for the hit rate
        breakeven: 0.542,       // a leg's breakeven when no price is given (a 6-pick flex)
        kellyFraction: 0.25,
        logHours: 3             // a game log is fetched again after this many hours
    };
    const MODEL_TOOL_NAMES = ["stats_player_log", "model_prop_edge", "model_backtest"];
    const MAX_ARCHIVE = 6000;
    const GAME_HOURS = 3.5;     // after the start, when a game is taken to be over
    const LEAGUES = {
        basketball_nba: ["basketball", "nba"], basketball_wnba: ["basketball", "wnba"], basketball_ncaab: ["basketball", "mens-college-basketball"],
        americanfootball_nfl: ["football", "nfl"], americanfootball_ncaaf: ["football", "college-football"],
        baseball_mlb: ["baseball", "mlb"], icehockey_nhl: ["hockey", "nhl"]
    };
    // ESPN uid league numbers, for search results that only carry a uid.
    const UID_LEAGUES = { 46: "basketball_nba", 59: "basketball_wnba", 41: "basketball_ncaab", 28: "americanfootball_nfl", 23: "americanfootball_ncaaf", 10: "baseball_mlb", 90: "icehockey_nhl" };

    // Each Odds API market as a sum of ESPN game-log columns: [coefficient, names or "L:label"].
    const F = (...c) => [1, c];
    const FIELDS = {
        player_points: [F("points", "L:PTS")], player_rebounds: [F("totalRebounds", "rebounds", "L:REB")], player_assists: [F("assists", "L:AST")],
        player_threes: [F("threePointFieldGoalsMade-threePointFieldGoalsAttempted", "threePointFieldGoalsMade", "L:3PT", "L:3PM")],
        player_steals: [F("steals", "L:STL")], player_blocks: [F("blocks", "L:BLK")], player_turnovers: [F("turnovers", "L:TO")],
        player_points_rebounds_assists: [F("points", "L:PTS"), F("totalRebounds", "rebounds", "L:REB"), F("assists", "L:AST")],
        player_points_rebounds: [F("points", "L:PTS"), F("totalRebounds", "rebounds", "L:REB")],
        player_points_assists: [F("points", "L:PTS"), F("assists", "L:AST")],
        player_rebounds_assists: [F("totalRebounds", "rebounds", "L:REB"), F("assists", "L:AST")],
        player_blocks_steals: [F("blocks", "L:BLK"), F("steals", "L:STL")],
        player_pass_yds: [F("passingYards")], player_pass_tds: [F("passingTouchdowns")], player_pass_attempts: [F("passingAttempts")],
        player_pass_completions: [F("completions")], player_pass_interceptions: [F("interceptions")],
        player_rush_yds: [F("rushingYards")], player_rush_attempts: [F("rushingAttempts")],
        player_reception_yds: [F("receivingYards")], player_receptions: [F("receptions")],
        player_rush_reception_yds: [F("rushingYards"), F("receivingYards")],
        pitcher_strikeouts: [F("strikeouts", "L:K", "L:SO")], pitcher_hits_allowed: [F("hits", "L:H")], pitcher_earned_runs: [F("earnedRuns", "L:ER")],
        batter_hits: [F("hits", "L:H")], batter_home_runs: [F("homeRuns", "L:HR")], batter_rbis: [F("RBIs", "rbis", "L:RBI")], batter_runs_scored: [F("runs", "L:R")],
        batter_walks: [F("walks", "L:BB")], batter_strikeouts: [F("strikeouts", "L:K", "L:SO")], batter_stolen_bases: [F("stolenBases", "L:SB")],
        batter_total_bases: [F("hits", "L:H"), F("doubles", "L:2B"), [2, ["triples", "L:3B"]], [3, ["homeRuns", "L:HR"]]],
        batter_hits_runs_rbis: [F("hits", "L:H"), F("runs", "L:R"), F("RBIs", "rbis", "L:RBI")],
        player_goals: [F("goals", "L:G")], player_shots_on_goal: [F("shotsTotal", "shots", "L:S", "L:SOG")], player_power_play_points: [F("powerPlayGoals", "L:PPG"), F("powerPlayAssists", "L:PPA")],
        player_blocked_shots: [F("blockedShots", "L:BS")], player_total_saves: [F("saves", "L:SV")]
    };
    // Hockey "points" is goals + assists, not basketball points.
    const HOCKEY_POINTS = [F("points", "L:PTS")];

    // ---- Small helpers -------------------------------------------------------

    const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const pct = p => (p == null || !Number.isFinite(p) ? "?" : `${Math.round(p * 1000) / 10}%`);
    const pts = d => `${d >= 0 ? "+" : ""}${Math.round(d * 1000) / 10} pts`;
    const americanToProb = price => (price >= 100 ? 100 / (price + 100) : price <= -100 ? -price / (-price + 100) : NaN);
    const decimalOf = price => (price >= 100 ? 1 + price / 100 : price <= -100 ? 1 + 100 / -price : NaN);
    const probToAmerican = p => (p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));
    const fmtPrice = p => (p == null || !Number.isFinite(p) ? "?" : p > 0 ? `+${p}` : String(p));
    const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
    const median = v => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const sd = v => { const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)); };
    const round1 = x => Math.round(x * 10) / 10;
    // Standard normal CDF (Abramowitz-Stegun 7.1.26).
    function phi(x) {
        const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
        const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
        return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
    }
    const sideOf = s => (/^u/i.test(String(s || "")) ? "Under" : "Over");

    function fieldsFor(market, sport) {
        if (/icehockey/.test(sport || "") && market === "player_points") return HOCKEY_POINTS;
        return FIELDS[market] || null;
    }

    // ---- ESPN parsing (pure, tested with fixtures) ----------------------------

    // Search results -> [{ id, name, sport, team }]. Reads the v3 "items" shape and the v2 "results" one.
    function parseSearch(body) {
        const out = [];
        const add = (it, sport) => {
            if (!it) return;
            const uid = String(it.uid || "");
            const id = String(it.id || (/~a:(\d+)/.exec(uid) || [])[1] || "");
            const name = it.displayName || it.name || it.displayText || "";
            if (!id || !name) return;
            const lg = /~l:(\d+)/.exec(uid);
            const league = String(it.league || it.defaultLeagueSlug || "").toLowerCase();
            const sk = sport || Object.entries(LEAGUES).find(([, v]) => v[1] === league)?.[0] || (lg && UID_LEAGUES[lg[1]]) || "";
            out.push({ id, name, sport: sk, team: it.subtitle || it.description || (it.team && it.team.displayName) || "" });
        };
        if (body && Array.isArray(body.items)) body.items.filter(it => !it.type || it.type === "player").forEach(it => add(it));
        if (body && Array.isArray(body.results)) for (const r of body.results) if (!r.type || r.type === "player") (r.contents || []).forEach(c => add(c));
        return out;
    }

    // A gamelog -> { games: [{ id, date, home, opp, result, stats: { name: raw } }], season }.
    function parseGameLog(body) {
        const names = Array.isArray(body && body.names) ? body.names : [];
        const labels = Array.isArray(body && body.labels) ? body.labels : [];
        const meta = (body && body.events) || {};
        const games = new Map();
        for (const st of (body && body.seasonTypes) || []) {
            if (/preseason|spring/i.test(st.displayName || "")) continue;
            for (const cat of st.categories || []) {
                for (const e of cat.events || []) {
                    const id = String(e.eventId || e.id || "");
                    if (!id || !Array.isArray(e.stats) || games.has(id)) continue;
                    const m = meta[id] || {};
                    const stats = {};
                    e.stats.forEach((v, i) => {
                        if (names[i]) stats[names[i].toLowerCase()] = v;
                        if (labels[i] && stats[`l:${labels[i].toLowerCase()}`] === undefined) stats[`l:${labels[i].toLowerCase()}`] = v;
                    });
                    games.set(id, {
                        id, date: m.gameDate || m.date || null,
                        home: m.atVs ? m.atVs !== "@" : (m.homeAway ? m.homeAway === "home" : null),
                        opp: m.opponent ? (m.opponent.abbreviation || m.opponent.displayName || "") : "",
                        oppName: m.opponent ? (m.opponent.displayName || m.opponent.name || "") : "",
                        team: m.team ? (m.team.abbreviation || "") : "",
                        result: m.gameResult || "", season: st.displayName || "", stats
                    });
                }
            }
        }
        const list = [...games.values()].filter(g => g.date).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
        const seasonFilter = ((body && body.filters) || []).find(f => f.name === "season");
        const season = seasonFilter ? Number(seasonFilter.value) : (body && body.requestedSeason && Number(body.requestedSeason.year)) || null;
        return { games: list, season: Number.isFinite(season) ? season : null };
    }

    // One raw cell ("10-20", "36", "18:23") as a number.
    function cell(raw, { minutes = false } = {}) {
        if (raw == null || raw === "" || raw === "--") return null;
        const s = String(raw);
        if (minutes && /^\d+:\d{2}$/.test(s)) { const [m, sec] = s.split(":").map(Number); return m + sec / 60; }
        const n = parseFloat(s.split("-")[0].split("/")[0]);
        return Number.isFinite(n) ? n : null;
    }

    function statValue(game, fields) {
        let total = 0;
        for (const [coef, cands] of fields) {
            let v = null;
            for (const c of cands) {
                const raw = game.stats[c.toLowerCase()];
                if (raw !== undefined) { v = cell(raw); break; }
            }
            if (v == null) return null;
            total += coef * v;
        }
        return total;
    }

    // [{ date, value, minutes, home, opp }] for one market, oldest first; games without the stat dropped.
    function seriesFor(games, market, sport) {
        const fields = fieldsFor(market, sport);
        if (!fields) return [];
        return games.map(g => ({
            id: g.id, date: g.date, home: g.home, opp: g.opp, oppName: g.oppName, season: g.season,
            value: statValue(g, fields),
            minutes: cell(g.stats.minutes ?? g.stats.timeonice ?? g.stats["l:min"] ?? g.stats["l:toi"], { minutes: true })
        })).filter(g => g.value != null && !(g.minutes === 0));
    }

    // ---- The model (pure) ------------------------------------------------------

    // Hit/miss/push of one value at a line for a side.
    const outcome = (value, line, side) => (value === line ? "push" : (value > line) === (side === "Over") ? "hit" : "miss");

    function windowRate(values, line, side, n) {
        const v = n ? values.slice(-n) : values;
        const res = v.map(x => outcome(x, line, side)).filter(r => r !== "push");
        return { hits: res.filter(r => r === "hit").length, of: res.length };
    }

    // The chance of the side from the game log: a recency-weighted hit rate shrunk toward
    // 50%, averaged with a normal fit (continuity-corrected for whole-number stats). Pushes
    // are left out of both, so it's the chance of a hit given the leg doesn't push.
    function statProb(values, line, side, opts = {}) {
        const o = { ...DEFAULTS, ...opts };
        if (!values.length) return null;
        const decay = Math.pow(0.5, 1 / o.halfLife);
        let wHit = 0, wAll = 0;
        values.forEach((x, i) => {
            const w = Math.pow(decay, values.length - 1 - i);
            const r = outcome(x, line, side);
            if (r === "push") return;
            wAll += w;
            if (r === "hit") wHit += w;
        });
        const empirical = (wHit + 0.5 * o.prior) / (wAll + o.prior);
        // A weighted mean and spread for the fit.
        let sw = 0, sx = 0;
        values.forEach((x, i) => { const w = Math.pow(decay, values.length - 1 - i); sw += w; sx += w * x; });
        const mu = sx / sw;
        let sv = 0;
        values.forEach((x, i) => { const w = Math.pow(decay, values.length - 1 - i); sv += w * (x - mu) ** 2; });
        const sigma = Math.max(Math.sqrt(sv / sw), Math.sqrt(Math.max(mu, 0)) * 0.8, 0.5);
        const whole = values.every(Number.isInteger);
        let pOver, pUnder;
        if (whole) {
            pOver = 1 - phi((Math.floor(line) + 0.5 - mu) / sigma);
            pUnder = phi((Math.ceil(line) - 0.5 - mu) / sigma);
        } else {
            pOver = 1 - phi((line - mu) / sigma);
            pUnder = 1 - pOver;
        }
        const fit = side === "Over" ? pOver / (pOver + pUnder) : pUnder / (pOver + pUnder);
        // The fit gets less say on a short log, where one outlier sets the spread.
        const fitWeight = Math.min(0.5, values.length / 20);
        const p = (1 - fitWeight) * empirical + fitWeight * fit;
        return { p: Math.min(0.97, Math.max(0.03, p)), empirical, fit, mean: mu, sigma };
    }

    function blend(pStat, pMarket, weight) {
        if (pMarket == null) return pStat;
        if (pStat == null) return pMarket;
        return weight * pMarket + (1 - weight) * pStat;
    }

    // EV per unit staked and a fractional Kelly stake at an American price (or a breakeven chance).
    function value(p, { price, breakeven, kellyFraction = DEFAULTS.kellyFraction } = {}) {
        if (p == null) return null;
        const be = Number.isFinite(price) ? americanToProb(price) : breakeven;
        const dec = Number.isFinite(price) ? decimalOf(price) : 1 / be;
        const ev = p * dec - 1;
        const kelly = ev > 0 ? Math.min(0.03, kellyFraction * ev / (dec - 1)) : 0;
        return { breakeven: be, edge: p - be, ev, kelly };
    }

    // Does the market back the pick? pStat: the game log's chance; pMarket: the no-vig market chance
    // of the same side at the same line; steam: findSteam() of the market row.
    function marketCheck({ side, pStat, pMarket, steam }) {
        const notes = [];
        const lastMove = steam && steam.moves.length ? steam.moves[steam.moves.length - 1] : null;
        const stale = steam && steam.stale.length ? steam.stale[0] : null;
        const moveWith = lastMove && lastMove.side === side, moveAgainst = lastMove && lastMove.side !== side;
        if (lastMove) notes.push(`${lastMove.steam ? "steam" : "books moved together"} ${moveWith ? "toward" : "against"} the pick (${lastMove.books.length} of ${lastMove.of} books${lastMove.sharpLed ? ", sharp-led" : ""})`);
        if (stale) notes.push(`${stale.sharp} moved ${stale.side === side ? "toward" : "against"} the pick and ${stale.behind.join(", ")} haven't followed`);
        if (pMarket == null) return { verdict: "no market", label: "No market price saved for this line", notes };
        const gap = pStat == null ? 0 : pStat - pMarket;
        const sharpAgainst = (moveAgainst && lastMove.sharpLed) || (stale && stale.side !== side);
        if (sharpAgainst || (gap >= 0.12 && pMarket < 0.5)) {
            notes.push(gap >= 0.12 ? `the game log says ${pct(pStat)} but the market says ${pct(pMarket)}: a gap that big usually means news the log can't see (injury, role, rest, weather)` : "sharp money is on the other side");
            return { verdict: "trap", label: "Possible trap: the market disagrees", notes };
        }
        if (pMarket >= 0.5 && !moveAgainst) return { verdict: "agrees", label: moveWith ? "Market agrees, and money is moving your way" : "Market agrees", notes };
        if (moveAgainst) return { verdict: "against", label: "The market is moving against it", notes };
        return { verdict: "lean against", label: "The market leans the other side", notes };
    }

    // ---- Storage-backed parts --------------------------------------------------

    function detectStatsHttp(win) {
        const parse = data => { if (typeof data !== "string") return data; try { return JSON.parse(data); } catch (err) { return data; } };
        const cap = win.Capacitor;
        const native = cap && cap.isNativePlatform && cap.isNativePlatform() ? (cap.Plugins && cap.Plugins.CapacitorHttp) || null : null;
        if (native) return async url => { const r = await native.request({ method: "GET", url, responseType: "text", connectTimeout: 20000, readTimeout: 30000 }); return { status: r.status, body: parse(r.data) }; };
        if (win.codevDesktop && win.codevDesktop.http && win.codevDesktop.http.espn) return async url => { const r = await win.codevDesktop.http.espn({ url }); return { status: r.status, body: parse(r.data) }; };
        const local = win.location && win.location.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(win.location.hostname);
        return async url => {
            if (local) {
                const response = await win.fetch("/web/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "espn", url }) });
                const data = await response.json();
                if (data.error) throw new Error(data.error);
                return { status: data.status, body: parse(data.html) };
            }
            const response = await win.fetch(url);
            return { status: response.status, body: parse(await response.text()) };
        };
    }

    // tracker: the odds tracker from odds-api.js (or null); odds: the CodevOddsApi module.
    function createPropModel({ storage, http, tracker = null, odds = null, now = () => Date.now(), log = () => {} }) {
        const read = (key, fallback) => { try { const v = JSON.parse(storage.getItem(key) || "null"); return v == null ? fallback : v; } catch (err) { return fallback; } };
        const write = (key, v) => { try { storage.setItem(key, JSON.stringify(v)); } catch (err) { log(`[Model] Couldn't save: ${err.message}`); } };
        const settings = () => ({ ...DEFAULTS, ...read(STORE.settings, {}) });
        const saveSettings = patch => { const next = { ...settings(), ...patch }; write(STORE.settings, next); return next; };
        const sportKey = s => (odds ? odds.sportKey(s) : String(s || "")) || "";
        const marketFor = (stat, sk) => (odds ? odds.marketFor(stat, sk) : stat);
        const marketLabel = m => (odds ? odds.marketLabel(m) : m);
        const findSteam = r => (odds && odds.findSteam ? odds.findSteam(r) : { moves: [], stale: [], side: null });

        async function getJson(url) {
            const reply = await http(url);
            if (reply.status === 404) return null;
            if (reply.status >= 400) throw new Error(`ESPN answered HTTP ${reply.status}`);
            if (typeof reply.body !== "object") throw new Error("ESPN sent something that isn't JSON (its free feed may have changed).");
            return reply.body;
        }

        // ---- Players and game logs ----

        async function findPlayer(name, sk, espnId) {
            const cache = read(STORE.players, {});
            const key = `${sk}|${norm(name)}`;
            if (espnId) { cache[key] = { id: String(espnId), name, sport: sk, team: "" }; write(STORE.players, cache); return cache[key]; }
            if (cache[key]) return cache[key];
            const body = await getJson(`${ESPN_WEB}/search?query=${encodeURIComponent(name)}&type=player&limit=10`);
            const found = parseSearch(body || {});
            const want = norm(name);
            const ranked = found.filter(p => !sk || !p.sport || p.sport === sk)
                .map(p => ({ p, score: (norm(p.name) === want ? 3 : 0) + (p.sport === sk ? 2 : 0) + (norm(p.name).includes(want) || want.includes(norm(p.name)) ? 1 : 0) + (want.split(" ").pop() === norm(p.name).split(" ").pop() ? 1 : 0) }))
                .filter(x => x.score >= 2).sort((a, b) => b.score - a.score);
            if (!ranked.length) return null;
            cache[key] = { ...ranked[0].p, sport: ranked[0].p.sport || sk };
            write(STORE.players, cache);
            return cache[key];
        }

        // This season's log, with last season's in front when this one is short (early season).
        async function gameLog(player, sk, { fresh = false } = {}) {
            const league = LEAGUES[sk];
            if (!league) throw new Error(`Game logs are available for ${Object.keys(LEAGUES).join(", ")}.`);
            const logs = read(STORE.logs, {});
            const key = `${sk}|${player.id}`;
            const cached = logs[key];
            if (cached && !fresh && now() - cached.at < settings().logHours * 3600000) return cached.games;
            const base = `${ESPN_WEB}/sports/${league[0]}/${league[1]}/athletes/${encodeURIComponent(player.id)}/gamelog`;
            const cur = parseGameLog((await getJson(base)) || {});
            let games = cur.games;
            if (games.length < 15 && cur.season) {
                try { games = parseGameLog((await getJson(`${base}?season=${cur.season - 1}`)) || {}).games.concat(games); } catch (err) { log(`[Stats] last season: ${err.message}`); }
            }
            // Keep the newest 120 games per player, and at most 150 players.
            logs[key] = { at: now(), games: games.slice(-120) };
            const keys = Object.keys(logs).sort((a, b) => logs[a].at - logs[b].at);
            while (keys.length > 150) delete logs[keys.shift()];
            write(STORE.logs, logs);
            return logs[key].games;
        }

        async function playerSeries({ player, sport, stat, espn_id: espnId, fresh }) {
            const sk = sportKey(sport);
            if (!sk || !LEAGUES[sk]) return { error: `Unknown or unsupported sport "${sport}". Game logs cover NBA, WNBA, NCAAB, NFL, NCAAF, MLB and NHL.` };
            const market = marketFor(stat, sk);
            if (!fieldsFor(market, sk)) return { error: `CoDev can't count "${stat}" from a game log yet.` };
            const who = await findPlayer(player, sk, espnId);
            if (!who) return { error: `ESPN's search didn't find ${player} in ${sport}. Check the spelling, or pass espn_id (the number in the player's espn.com address).` };
            const games = await gameLog(who, sk, { fresh });
            return { sk, market, who, games, series: seriesFor(games, market, sk) };
        }

        function summary(series, line, side, opponent) {
            const values = series.map(g => g.value);
            const w = n => windowRate(values, line, side, n);
            const fr = r => `${r.hits}/${r.of}`;
            const mins = series.map(g => g.minutes).filter(Number.isFinite);
            const last5m = mins.slice(-5), prev5m = mins.slice(-10, -5);
            const home = series.filter(g => g.home === true).map(g => g.value), away = series.filter(g => g.home === false).map(g => g.value);
            const vsOpp = opponent ? series.filter(g => norm(g.opp) === norm(opponent) || (g.oppName && norm(g.oppName).includes(norm(opponent))) || (g.oppName && norm(opponent).includes(norm(g.oppName).split(" ").pop()))).map(g => g.value) : [];
            const l10 = w(10);
            return {
                l5: w(5), l10, l20: w(20), all: w(0), avg: mean(values), med: median(values), sd: values.length > 1 ? sd(values) : 0,
                last: values.slice(-10), minutes: last5m.length ? { last5: mean(last5m), prev5: prev5m.length ? mean(prev5m) : null } : null,
                home: home.length ? { avg: mean(home), ...windowRate(home, line, side, 0) } : null,
                away: away.length ? { avg: mean(away), ...windowRate(away, line, side, 0) } : null,
                vsOpp: vsOpp.length ? { avg: mean(vsOpp), ...windowRate(vsOpp, line, side, 0) } : null,
                text: [
                    `Hit rate at ${side} ${line}: L5 ${fr(w(5))} · L10 ${fr(l10)} · L20 ${fr(w(20))} · ${fr(w(0))} in all ${values.length} games`,
                    `Average ${round1(mean(values))}, median ${round1(median(values))}${values.length > 1 ? `, spread ±${round1(sd(values))}` : ""}; last 10 (oldest first): ${values.slice(-10).join(", ")}`
                ]
            };
        }

        // ---- The market for a prop, from lines the odds tracker saved ----

        function marketRow(sk, player, market) {
            if (!tracker) return null;
            const list = tracker.rows({ sport: sk, player, markets: [market] }).filter(r => r.player);
            if (!list.length) return null;
            const upcoming = list.filter(r => Date.parse(r.start) > now() - GAME_HOURS * 3600000).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
            return upcoming[0] || null;
        }

        // The market's no-vig chance of a side at the user's line: the consensus at the books'
        // line, moved by the fitted distribution's difference between the two lines.
        function marketAt(row, line, side, series) {
            if (!row || row.fairA == null) return null;
            const atBook = side === "Over" ? row.fairA : 1 - row.fairA;
            if (row.lineNow == null || row.lineNow === line || !series || series.length < 5) return row.lineNow === line || row.lineNow == null ? atBook : null;
            const v = series.map(g => g.value);
            const a = statProb(v, line, side), b = statProb(v, row.lineNow, side);
            return a && b ? Math.min(0.97, Math.max(0.03, atBook + (a.fit - b.fit))) : null;
        }

        // ---- Archive ----

        const archive = () => { const a = read(STORE.archive, null) || {}; a.records = a.records || []; return a; };
        function saveArchive(a) {
            if (a.records.length > MAX_ARCHIVE) a.records = a.records.sort((x, y) => Date.parse(x.start) - Date.parse(y.start)).slice(-MAX_ARCHIVE);
            write(STORE.archive, a);
        }

        // Every saved prop whose game has started goes into the archive at its close. Free.
        function archiveSlate() {
            if (!tracker) return 0;
            const a = archive();
            const byKey = new Map(a.records.filter(r => r.source === "market").map(r => [r.key, r]));
            let added = 0;
            for (const r of tracker.rows()) {
                if (!r.player || Date.parse(r.start) > now() || r.lineNow == null || r.fairA == null) continue;
                const key = [r.event, r.market, norm(r.player)].join("|");
                const best = { over: r.bestA ? r.bestA.price : null, under: r.bestB ? r.bestB.price : null };
                const rec = byKey.get(key);
                if (rec && rec.result) continue;
                const fields = { key, source: "market", sport: r.sport, player: r.player, market: r.market, stat: r.stat, game: r.game, event: r.event, start: r.start,
                    line: r.lineNow, closeFairOver: r.fairA, openFairOver: r.fairAOpen, closePrices: best, books: r.books.length };
                if (rec) Object.assign(rec, fields); else { a.records.push({ ...fields, at: now(), result: null }); added++; }
            }
            // Picks get their closing fair chance for CLV.
            for (const p of a.records.filter(x => x.source === "pick" && x.closeFair == null && Date.parse(x.start) <= now())) {
                const m = a.records.find(x => x.source === "market" && x.event === p.event && x.market === p.market && norm(x.player) === norm(p.player));
                if (m && m.line === p.line) p.closeFair = p.side === "Over" ? m.closeFairOver : 1 - m.closeFairOver;
            }
            saveArchive(a);
            return added;
        }

        // Settles archived props whose games are over, from ESPN game logs, and works out
        // the model's ex-ante numbers for each (only games before it count).
        async function settle({ maxPlayers = 25 } = {}) {
            archiveSlate();
            const a = archive();
            const due = a.records.filter(r => !r.result && r.start && Date.parse(r.start) + GAME_HOURS * 3600000 < now() && LEAGUES[r.sport]);
            const players = [...new Set(due.map(r => `${r.sport}|${norm(r.player)}`))];
            let checked = 0, settled = 0, failed = 0;
            for (const pk of players.slice(0, maxPlayers)) {
                const recs = due.filter(r => `${r.sport}|${norm(r.player)}` === pk);
                const { sport, player } = recs[0];
                let games;
                try {
                    const who = await findPlayer(player, sport);
                    if (!who) { recs.forEach(r => { if (now() - Date.parse(r.start) > 3 * 86400000) r.result = "void"; }); failed++; continue; }
                    const latest = Math.max(...recs.map(r => Date.parse(r.start)));
                    const logs = read(STORE.logs, {});
                    const cached = logs[`${sport}|${who.id}`];
                    games = await gameLog(who, sport, { fresh: !cached || cached.at < latest + GAME_HOURS * 3600000 });
                    checked++;
                } catch (err) { log(`[Model] settle ${player}: ${err.message}`); failed++; continue; }
                for (const r of recs) {
                    const series = seriesFor(games, r.market, sport);
                    const t = Date.parse(r.start);
                    const game = series.filter(g => Math.abs(Date.parse(g.date) - t) < 20 * 3600000).sort((x, y) => Math.abs(Date.parse(x.date) - t) - Math.abs(Date.parse(y.date) - t))[0];
                    if (!game) { if (now() - t > 3 * 86400000) r.result = "void"; continue; }   // didn't play, or ESPN hasn't posted it
                    const prior = series.filter(g => Date.parse(g.date) < t - 6 * 3600000).map(g => g.value);
                    r.actual = game.value;
                    r.result = outcome(game.value, r.line, r.side || "Over");
                    if (prior.length >= 5) {
                        const s = statProb(prior, r.line, "Over", settings());
                        r.exOver = s ? s.p : null;
                        r.exL10Over = windowRate(prior, r.line, "Over", 10);
                        r.exGames = prior.length;
                    }
                    settled++;
                }
            }
            saveArchive(a);
            return { checked, settled, failed, waiting: Math.max(0, players.length - maxPlayers) };
        }

        // ---- Backtest (pure over the archive) ----

        // For each settled market record: the model picks the side it likes, and bets when the
        // edge over the best closing price clears min_edge (and the L10 hit rate min_hit).
        function backtest({ sport, minEdge = 0.02, minHit = 0, side = "", weight, market } = {}) {
            const a = archive();
            const sk = sport ? sportKey(sport) : "";
            const mk = market ? marketFor(market, sk) : "";
            const recs = a.records.filter(r => r.source === "market" && (r.result === "hit" || r.result === "miss" || r.result === "push") && r.exOver != null
                && (!sk || r.sport === sk) && (!mk || r.market === mk));
            const w = weight == null ? settings().marketWeight : weight;
            const runRule = wt => {
                const bets = [];
                for (const r of recs) {
                    const pOver = blend(r.exOver, r.closeFairOver, wt);
                    const s = pOver >= 0.5 ? "Over" : "Under";
                    if (side && sideOf(side) !== s) continue;
                    const price = s === "Over" ? r.closePrices.over : r.closePrices.under;
                    if (!Number.isFinite(price)) continue;
                    const p = s === "Over" ? pOver : 1 - pOver;
                    const edge = p - americanToProb(price);
                    const l10 = r.exL10Over ? (s === "Over" ? r.exL10Over.hits : r.exL10Over.of - r.exL10Over.hits) / Math.max(1, r.exL10Over.of) : 0;
                    if (edge < minEdge || l10 < minHit) continue;
                    const res = r.result === "push" ? "push" : (r.result === "hit") === (s === "Over") ? "hit" : "miss";
                    bets.push({ p, price, res, edge, r, side: s });
                }
                return bets;
            };
            const tally = bets => {
                const decided = bets.filter(b => b.res !== "push");
                const won = decided.filter(b => b.res === "hit");
                const profit = bets.reduce((n, b) => n + (b.res === "hit" ? decimalOf(b.price) - 1 : b.res === "miss" ? -1 : 0), 0);
                return { n: bets.length, w: won.length, l: decided.length - won.length, pu: bets.length - decided.length,
                    hit: decided.length ? won.length / decided.length : null, roi: bets.length ? profit / bets.length : null,
                    predicted: decided.length ? mean(decided.map(b => b.p)) : null };
            };
            // Brier score of each way of pricing the Over, on every settled record.
            const decided = recs.filter(r => r.result !== "push");
            const brier = f => decided.length ? mean(decided.map(r => (f(r) - (r.result === "hit" ? 1 : 0)) ** 2)) : null;
            const weights = [0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 1];
            const byWeight = weights.map(wt => ({ wt, brier: brier(r => blend(r.exOver, r.closeFairOver, wt)) }));
            const bestW = byWeight.reduce((x, y) => (y.brier != null && (x.brier == null || y.brier < x.brier) ? y : x), byWeight[0]);
            const bets = runRule(w);
            const buckets = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 1.01]].map(([lo, hi]) => {
                const b = bets.filter(x => x.res !== "push" && x.p >= lo && x.p < hi);
                return { lo, hi, n: b.length, hit: b.length ? b.filter(x => x.res === "hit").length / b.length : null, predicted: b.length ? mean(b.map(x => x.p)) : null };
            });
            const picks = a.records.filter(r => r.source === "pick" && (!sk || r.sport === sk) && (!mk || r.market === mk));
            const pickDone = picks.filter(r => ["hit", "miss", "push"].includes(r.result));
            const clv = picks.filter(r => r.closeFair != null && r.pMarket != null).map(r => r.closeFair - r.pMarket);
            const pickProfit = pickDone.reduce((n, r) => n + (r.result === "hit" ? (Number.isFinite(r.price) ? decimalOf(r.price) - 1 : 1 / r.breakeven - 1) : r.result === "miss" ? -1 : 0), 0);
            return {
                records: recs.length, slates: new Set(recs.map(r => String(r.start).slice(0, 10))).size, weight: w, rule: { minEdge, minHit, side: side ? sideOf(side) : "either" },
                result: tally(bets), buckets, byWeight, bestWeight: bestW, brierMarket: brier(r => r.closeFairOver), brierStats: brier(r => r.exOver),
                picks: { n: picks.length, settled: pickDone.length, w: pickDone.filter(r => r.result === "hit").length, l: pickDone.filter(r => r.result === "miss").length,
                    roi: pickDone.length ? pickProfit / pickDone.length : null, clv: clv.length ? mean(clv) : null, beatClose: clv.length ? clv.filter(x => x > 0).length / clv.length : null, clvN: clv.length }
            };
        }

        // ---- Tools ----

        async function playerLogTool(args) {
            const side = sideOf(args.side);
            const got = await playerSeries(args);
            if (got.error) return got.error;
            const { sk, market, who, series } = got;
            if (!series.length) return `ESPN has no ${marketLabel(market)} games for ${who.name} yet.`;
            const line = Number.isFinite(Number(args.line)) && args.line !== "" && args.line != null ? Number(args.line) : Math.round(median(series.map(g => g.value))) - 0.5;
            const s = summary(series, line, side, args.opponent);
            const m = statProb(series.map(g => g.value), line, side, settings());
            const row = marketRow(sk, who.name, market) || marketRow(sk, args.player, market);
            const out = [`${who.name}${who.team ? ` (${who.team})` : ""}: ${marketLabel(market)} from ESPN's game log, ${series.length} games (${[...new Set(series.map(g => g.season))].filter(Boolean).join(", ") || "this season"})`];
            out.push(...s.text);
            if (s.minutes) out.push(`Minutes: last 5 ${round1(s.minutes.last5)}${s.minutes.prev5 != null ? ` vs ${round1(s.minutes.prev5)} the 5 before` : ""}`);
            if (s.home && s.away) out.push(`Home ${round1(s.home.avg)} (${s.home.hits}/${s.home.of} at the line) · Away ${round1(s.away.avg)} (${s.away.hits}/${s.away.of})`);
            if (args.opponent) out.push(s.vsOpp ? `Vs ${args.opponent}: ${round1(s.vsOpp.avg)} average, ${s.vsOpp.hits}/${s.vsOpp.of} at the line` : `No games vs ${args.opponent} in this log.`);
            if (m) out.push(`Game-log chance of the ${side} ${line}: ${pct(m.p)} (recency-weighted hit rate ${pct(m.empirical)}, fitted distribution ${pct(m.fit)}). An estimate from past games only.`);
            if (row) out.push(`Books now: ${row.lineNow} (fair Over ${pct(row.fairA)}). Use model_prop_edge for the market check.`);
            if (args.line == null || args.line === "") out.push(`(No line given, so ${line} was used: just under his median.)`);
            return out.join("\n");
        }

        async function evaluateLeg(leg, opts) {
            const side = sideOf(leg.side);
            const got = await playerSeries({ ...leg, sport: leg.sport || opts.sport });
            if (got.error) return { text: `${leg.player} ${leg.stat || ""}: ${got.error}` };
            const { sk, market, who, series } = got;
            const row = marketRow(sk, who.name, market) || marketRow(sk, leg.player, market);
            const line = Number.isFinite(Number(leg.line)) && leg.line !== "" && leg.line != null ? Number(leg.line) : row ? row.lineNow : null;
            if (line == null) return { text: `${who.name} ${marketLabel(market)}: no line given and none saved from the books. Give the line.` };
            if (series.length < 5) return { text: `${who.name} ${marketLabel(market)} ${line}: only ${series.length} games in ESPN's log, too few to model.` };
            const st = settings();
            const values = series.map(g => g.value);
            const s = summary(series, line, side, leg.opponent);
            const stat = statProb(values, line, side, st);
            const pMarket = marketAt(row, line, side, series);
            const p = blend(stat.p, pMarket, st.marketWeight);
            const bestPrice = row ? (side === "Over" ? row.bestA : row.bestB) : null;
            const price = Number.isFinite(Number(leg.price)) && leg.price !== "" && leg.price != null ? Number(leg.price)
                : bestPrice && bestPrice.point === line ? bestPrice.price : null;
            const breakeven = Number(opts.breakeven) > 0 ? Number(opts.breakeven) / (Number(opts.breakeven) > 1 ? 100 : 1) : st.breakeven;
            const v = value(p, { price: Number.isFinite(price) ? price : undefined, breakeven, kellyFraction: st.kellyFraction });
            const steam = row ? findSteam(row) : null;
            const check = marketCheck({ side, pStat: stat.p, pMarket, steam });
            const lines = [`${who.name} | ${marketLabel(market)} | ${side} ${line}${row ? ` (${row.game})` : ""}`];
            lines.push(`  Stats (ESPN, ${series.length} games): ${s.text[0].replace(/^Hit rate at [^:]+: /, "")}; avg ${round1(s.avg)}, median ${round1(s.med)}${s.minutes ? `; minutes ${round1(s.minutes.last5)}${s.minutes.prev5 != null ? ` (was ${round1(s.minutes.prev5)})` : ""}` : ""}`);
            lines.push(`  Game-log chance ${pct(stat.p)} · market no-vig ${pct(pMarket)}${row && row.lineNow !== line && pMarket != null ? ` (books at ${row.lineNow}, moved to your line)` : ""} · blended ${pct(p)} (${Math.round(st.marketWeight * 100)}% market)`);
            if (row && row.lineNow != null && row.lineNow !== line) {
                const better = side === "Over" ? line < row.lineNow : line > row.lineNow;
                lines.push(`  Your line is ${Math.abs(line - row.lineNow)} ${better ? "easier" : "harder"} than the books' ${row.lineNow}`);
            }
            lines.push(`  ${Number.isFinite(price) ? `At ${fmtPrice(price)}${bestPrice && price === bestPrice.price && !leg.price ? ` (best, ${bestPrice.book})` : ""}` : `Against a ${pct(breakeven)} breakeven`}: edge ${pts(v.edge)}, EV ${pts(v.ev)} per unit${!Number.isFinite(price) ? " (a pick'em leg: size the whole entry, not the leg)" : v.kelly > 0 ? `, stake ${round1(v.kelly * 100)}% of bankroll (${Math.round(st.kellyFraction * 100)}% Kelly, capped at 3%)` : ", no stake"}`);
            lines.push(`  Market check: ${check.label}${check.notes.length ? `. ${check.notes.join("; ")}` : ""}`);
            if (row && row.snapshots > 1 && (row.lineMove || Math.abs(row.fairMove) >= 0.01)) lines.push(`  Since ${new Date(row.opened).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: line ${row.lineOpen} -> ${row.lineNow}, Over ${pct(row.fairAOpen)} -> ${pct(row.fairA)}`);
            const record = { key: `pick|${row ? row.event : sk}|${market}|${norm(who.name)}|${line}|${side}`, source: "pick", at: now(), sport: sk, player: who.name, market, stat: marketLabel(market),
                line, side, price: Number.isFinite(price) ? price : null, breakeven: v.breakeven, pStat: stat.p, pMarket, p, verdict: check.verdict,
                event: row ? row.event : null, game: row ? row.game : null, start: row ? row.start : null, result: null };
            return { text: lines.join("\n"), record, p, edge: v.edge, verdict: check.verdict, who, market, line, side };
        }

        async function propEdgeTool(args) {
            const legs = Array.isArray(args.legs) && args.legs.length ? args.legs : [args];
            if (legs.length > 8) return "Up to 8 legs at a time.";
            if (!legs.every(l => l.player && l.stat)) return "Each leg needs a player and a stat (and ideally the line and side).";
            const results = [];
            for (const leg of legs) {
                try { results.push(await evaluateLeg(leg, args)); } catch (err) { results.push({ text: `${leg.player}: ${err.message}` }); }
            }
            // Keep each pick (the newest evaluation of the same pick replaces the older one).
            const a = archive();
            for (const r of results.filter(x => x.record && x.record.start)) {
                const i = a.records.findIndex(x => x.key === r.record.key && !x.result);
                if (i >= 0) a.records[i] = r.record; else a.records.push(r.record);
            }
            saveArchive(a);
            const noMarket = results.some(r => r.record && r.record.pMarket == null);
            const ok = results.filter(r => r.record);
            const head = ok.length > 1 ? `Ranked by edge: ${[...ok].sort((x, y) => y.edge - x.edge).map(r => `${r.who.name} ${r.side} ${r.line} (${pts(r.edge)}, ${r.verdict})`).join(" · ")}\n\n` : "";
            return head + results.map(r => r.text).join("\n\n")
                + (noMarket ? `\n\n${tracker && tracker.hasKey() ? "No book prices saved for some legs: fetch them with odds_player_props for that game first, then run this again." : "No Odds API key, so there is no market check: the user can add a free key in Settings > Odds API."}` : "")
                + "\n\nModel numbers are estimates from past games and the books' prices, not guarantees. Picks with a game time are saved for the backtest.";
        }

        async function backtestTool(args) {
            let note = "";
            if (args.settle !== false) {
                try {
                    const s = await settle({ maxPlayers: 25 });
                    note = `Settled ${s.settled} prop${s.settled === 1 ? "" : "s"} from ESPN box scores (${s.checked} player${s.checked === 1 ? "" : "s"} checked${s.failed ? `, ${s.failed} couldn't be read` : ""}${s.waiting ? `, ${s.waiting} more players next time` : ""}).`;
                } catch (err) { note = `Couldn't settle new results: ${err.message}.`; }
            }
            const minEdge = args.min_edge != null ? Number(args.min_edge) / (Number(args.min_edge) >= 1 ? 100 : 1) : 0.02;
            const minHit = args.min_hit_l10 != null ? Number(args.min_hit_l10) / (Number(args.min_hit_l10) > 1 ? 100 : 1) : 0;
            const r = backtest({ sport: args.sport, market: args.stat, side: args.side, minEdge, minHit, weight: args.market_weight != null ? Number(args.market_weight) : undefined });
            const out = [note];
            if (!r.records) {
                out.push("No settled props to test yet. Every prop line CoDev saves from The Odds API goes into the archive when its game starts, and is settled from ESPN after the game; the backtest grows with each slate tracked (odds_player_props or odds_lookup_list for a game, then wait for it to finish).");
            } else {
                const t = r.result;
                out.push(`Backtest over ${r.records} settled props from ${r.slates} slate${r.slates === 1 ? "" : "s"}: model ${Math.round(r.weight * 100)}% market / ${Math.round((1 - r.weight) * 100)}% game log (log counted only up to each game), side ${r.rule.side}, edge ≥ ${pct(r.rule.minEdge)} over the best closing price${r.rule.minHit ? `, L10 ≥ ${pct(r.rule.minHit)}` : ""}.`);
                out.push(t.n ? `Bets: ${t.n} (${t.w}-${t.l}${t.pu ? `-${t.pu}` : ""}), hit ${pct(t.hit)} vs ${pct(t.predicted)} predicted, ROI ${pts(t.roi)} per unit at closing prices.` : "No bets pass that rule; loosen min_edge or min_hit_l10.");
                const cal = r.buckets.filter(b => b.n);
                if (cal.length) out.push(`Calibration (predicted -> actual): ${cal.map(b => `${Math.round(b.lo * 100)}-${Math.min(100, Math.round(b.hi * 100))}%: ${pct(b.predicted)} -> ${pct(b.hit)} (${b.n})`).join(" · ")}`);
                out.push(`Accuracy (Brier, lower is better): market alone ${r.brierMarket != null ? r.brierMarket.toFixed(4) : "?"}, game log alone ${r.brierStats != null ? r.brierStats.toFixed(4) : "?"}, best blend ${Math.round(r.bestWeight.wt * 100)}% market (${r.bestWeight.brier != null ? r.bestWeight.brier.toFixed(4) : "?"}).`);
                if (r.records < 200) out.push(`Only ${r.records} props: too few to trust these numbers yet (a few hundred settled legs before changing anything).`);
                if (args.apply && r.records >= 100 && r.bestWeight.brier != null) { saveSettings({ marketWeight: r.bestWeight.wt }); out.push(`Saved: the model now uses ${Math.round(r.bestWeight.wt * 100)}% market.`); }
                else if (args.apply) out.push("Not applied: needs at least 100 settled props.");
            }
            const p = r.picks;
            if (p.n) out.push(`Your evaluated picks: ${p.n} saved, ${p.settled} settled (${p.w}-${p.l})${p.roi != null ? `, ROI ${pts(p.roi)}` : ""}${p.clvN ? `; closing line value ${pts(p.clv)} on average, beat the close ${pct(p.beatClose)} of the time (${p.clvN} picks). CLV is the steadier sign of a real edge` : ""}.`);
            return out.filter(Boolean).join("\n");
        }

        const sportParam = { type: "string", description: "The league: NBA, WNBA, NCAAB, NFL, NCAAF, MLB or NHL." };
        const legProps = {
            player: { type: "string", description: "The player's name." },
            stat: { type: "string", description: "The stat in Outlier's or the app's words (\"Points\", \"PRA\", \"Receiving Yards\", \"Strikeouts\")." },
            line: { type: "number", description: "The line (e.g. 24.5). Optional when the books' line is saved." },
            side: { type: "string", description: "Over or Under (default Over)." },
            price: { type: "number", description: "Optional: the American price the user can get (e.g. -115). Leave out for a DFS pick'em leg." },
            opponent: { type: "string", description: "Optional: the opponent, for the head-to-head split." },
            espn_id: { type: "string", description: "Optional: the ESPN athlete id, if the name search picks the wrong player." }
        };
        const TOOLS = {
            stats_player_log: {
                description: "A player's game log pulled automatically from ESPN's free stats (no Outlier, no key): hit rate at a line over L5, L10, L20 and the whole log, average, median, spread, the last 10 games, minutes trend, home/away and vs an opponent, and the game-log chance of the side. Early in a season last season's games are added. Free.",
                inputSchema: { type: "object", properties: { sport: sportParam, ...legProps }, required: ["sport", "player", "stat"] }, run: playerLogTool
            },
            model_prop_edge: {
                description: "CoDev's own model on 1-8 props: the game-log chance (ESPN stats), the market's no-vig chance from the sportsbook lines saved by the odds tools, the blended chance, edge and EV at the price (or the DFS breakeven), a Kelly stake, and a market check: does the market agree, is there steam or a sharp move with or against the pick, or does the log like something the books price well below it (a possible trap). Saves each pick for the backtest and closing line value. Use it after odds_player_props or odds_lookup_list, and before building a slip.",
                inputSchema: { type: "object", properties: {
                    sport: sportParam, ...legProps,
                    legs: { type: "array", description: "Several legs at once (each with player, stat, line, side, optional price, opponent, sport).", items: { type: "object", properties: legProps } },
                    breakeven: { type: "number", description: "Optional: a leg's breakeven chance for DFS (e.g. 54.2 for a 6-pick flex, 57.7 for a 2-pick power); used when there's no price." }
                }, required: ["sport"] }, run: propEdgeTool
            },
            model_backtest: {
                description: "Backtests CoDev's model across past slates: every prop line CoDev saved is archived at its close, settled from ESPN box scores after the game, and the model is re-run with only the games before it. Reports bets, hit rate and ROI for a rule (min edge, L10 floor, side, stat), calibration, how the market, the game log and the blend compare (Brier), the best market weight, and the user's own picks' results and closing line value. Settles new results first (free).",
                inputSchema: { type: "object", properties: {
                    sport: { type: "string", description: "Optional: one league." }, stat: { type: "string", description: "Optional: one stat." },
                    side: { type: "string", description: "Optional: only Overs or only Unders." },
                    min_edge: { type: "number", description: "Optional: the edge over the closing price to bet, in points (default 2)." },
                    min_hit_l10: { type: "number", description: "Optional: the L10 hit rate floor on the side, in percent (e.g. 60)." },
                    market_weight: { type: "number", description: "Optional: 0-1, the market's share of the blend to test (default the saved one, 0.6 to start)." },
                    apply: { type: "boolean", description: "Optional: save the best market weight found (needs 100+ settled props). Only when the user asks." },
                    settle: { type: "boolean", description: "Optional: false to skip settling new results." }
                } }, run: backtestTool
            }
        };

        function buildTools() {
            return MODEL_TOOL_NAMES.map(name => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema,
                run: async args => { try { return await TOOLS[name].run(args || {}); } catch (err) { return `Error: ${err.message}`; } } }));
        }

        function describe(name, args) {
            args = args || {};
            switch (name) {
                case "stats_player_log": return `📊 Pulling ${args.player || "the player"}'s game log${args.stat ? ` (${args.stat})` : ""}`;
                case "model_prop_edge": { const n = Array.isArray(args.legs) ? args.legs.length : 1; return `🧮 Modeling ${n > 1 ? `${n} props` : `${args.player || "the prop"}${args.stat ? ` ${args.stat}` : ""}`} against the market`; }
                case "model_backtest": return "🧪 Backtesting the model on past slates";
                default: return null;
            }
        }

        return { buildTools, describe, settings, saveSettings, archiveSlate, settle, backtest, findPlayer, gameLog, evaluateLeg, TOOLS, archive };
    }

    return {
        STORE, DEFAULTS, LEAGUES, FIELDS, MODEL_TOOL_NAMES, ESPN_URL,
        parseSearch, parseGameLog, seriesFor, statProb, windowRate, blend, value, marketCheck, outcome,
        americanToProb, probToAmerican, detectStatsHttp, createPropModel
    };
});
