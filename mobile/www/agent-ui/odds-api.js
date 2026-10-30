// CoDev's line tracking with The Odds API (the-odds-api.com): game lines and player
// props from every sportsbook, saved as snapshots so agents can see how a line moved
// and where the books disagree, and a short "look these up on Outlier" list built
// from that. The user's own free key goes in Settings; the browser reading of odds
// on Outlier stays the fallback when there is no key or no credits left.
//
// The free plan has 500 credits a month. Listing sports and games is free; odds cost
// (markets x regions) per call. So everything here is careful with them:
//  - every answer is cached, and a call is repeated only after a set number of minutes;
//  - the month's credits are spread over its days (pacing), with a reserve kept back;
//  - the real balance comes back with every answer (x-requests-remaining) and is shown;
//  - nothing is fetched when a call would go past the reserve or today's share.
//
// Runs the same everywhere: Android calls the API natively (CapacitorHttp), the
// Windows app through its main process, a browser page directly or through server.js.
// The same file runs in the page and in Node (tests), like google-apps.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevOddsApi = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const API = "https://api.the-odds-api.com/v4";
    const KEY_URL = "https://the-odds-api.com/#get-access";
    const STORE = { apiKey: "codev_odds_api_key", settings: "codev_odds_settings", usage: "codev_odds_usage", data: "codev_odds_data" };
    const DEFAULTS = {
        regions: ["us"],          // each region multiplies the cost of a call
        monthlyCredits: 500,      // the free plan
        reserve: 25,              // never spent by CoDev
        pace: true,               // spread the month's credits over its days
        linesMinutes: 30,         // a sport's game lines are fetched again only after this
        propsMinutes: 60,         // a game's props are fetched again only after this
        autoTrack: true,          // re-snapshot what was looked at, while CoDev is open
        autoHours: 4
    };
    const REGIONS = { us: "US sportsbooks", us2: "More US sportsbooks", us_dfs: "DFS apps (PrizePicks, Underdog...)", eu: "Europe (Pinnacle and other sharp books)", uk: "UK", au: "Australia" };
    const MAX_STORE_CHARS = 2500000;
    const KEEP_AFTER_START_MS = 36 * 3600 * 1000;
    const ODDS_TOOL_NAMES = ["odds_status", "odds_lookup_list", "odds_player_props", "odds_game_lines", "odds_line_movement", "odds_show_chart"];

    const SPORTS = {
        nba: "basketball_nba", wnba: "basketball_wnba", ncaab: "basketball_ncaab", cbb: "basketball_ncaab",
        nfl: "americanfootball_nfl", ncaaf: "americanfootball_ncaaf", cfb: "americanfootball_ncaaf",
        mlb: "baseball_mlb", nhl: "icehockey_nhl", epl: "soccer_epl", mls: "soccer_usa_mls"
    };
    const DEFAULT_PROPS = {
        basketball: ["player_points", "player_rebounds", "player_assists"],
        americanfootball: ["player_pass_yds", "player_rush_yds", "player_reception_yds"],
        baseball: ["pitcher_strikeouts", "batter_total_bases", "batter_hits"],
        icehockey: ["player_points", "player_shots_on_goal", "player_assists"],
        soccer: ["player_goal_scorer_anytime", "player_shots_on_target", "player_shots"]
    };
    // Outlier's names for each market, which outlier_research_list takes as the stat.
    const MARKET_LABELS = {
        h2h: "Moneyline", spreads: "Spread", totals: "Total",
        player_points: "Points", player_rebounds: "Rebounds", player_assists: "Assists", player_threes: "3-Pointers Made",
        player_points_rebounds_assists: "Pts+Rebs+Asts", player_points_rebounds: "Pts+Rebs", player_points_assists: "Pts+Asts",
        player_rebounds_assists: "Rebs+Asts", player_steals: "Steals", player_blocks: "Blocks", player_turnovers: "Turnovers",
        player_blocks_steals: "Blks+Stls", player_double_double: "Double Double",
        player_pass_yds: "Passing Yards", player_pass_tds: "Passing TDs", player_pass_attempts: "Pass Attempts", player_pass_completions: "Pass Completions",
        player_pass_interceptions: "Interceptions", player_rush_yds: "Rushing Yards", player_rush_attempts: "Rush Attempts",
        player_reception_yds: "Receiving Yards", player_receptions: "Receptions", player_rush_reception_yds: "Rush+Rec Yards",
        player_anytime_td: "Anytime TD", player_kicking_points: "Kicking Points",
        pitcher_strikeouts: "Pitcher Strikeouts", pitcher_hits_allowed: "Hits Allowed", pitcher_earned_runs: "Earned Runs", pitcher_outs: "Pitching Outs",
        batter_hits: "Hits", batter_total_bases: "Total Bases", batter_home_runs: "Home Runs", batter_rbis: "RBIs", batter_runs_scored: "Runs",
        batter_hits_runs_rbis: "Hits+Runs+RBIs", batter_walks: "Walks", batter_strikeouts: "Batter Strikeouts", batter_stolen_bases: "Stolen Bases",
        player_shots_on_goal: "Shots on Goal", player_goals: "Goals", player_power_play_points: "Power Play Points", player_blocked_shots: "Blocked Shots",
        player_total_saves: "Saves", player_goal_scorer_anytime: "Anytime Goal", player_shots_on_target: "Shots on Target", player_shots: "Shots"
    };
    const STAT_WORDS = [
        [/^(pra|p\+?r\+?a|pts\s*\+\s*rebs?\s*\+\s*asts?|points\s*\+?\s*rebounds\s*\+?\s*assists)$/, "player_points_rebounds_assists"],
        [/^(pr|pts\s*\+\s*rebs?|points\s*\+\s*rebounds)$/, "player_points_rebounds"],
        [/^(pa|pts\s*\+\s*asts?|points\s*\+\s*assists)$/, "player_points_assists"],
        [/^(ra|rebs?\s*\+\s*asts?|rebounds\s*\+\s*assists)$/, "player_rebounds_assists"],
        [/^(threes|3pm|3-?pointers?( made)?|3pt|threes made)$/, "player_threes"],
        [/^(pass(ing)? ?(yds|yards))$/, "player_pass_yds"], [/^(pass(ing)? ?tds?|passing touchdowns)$/, "player_pass_tds"],
        [/^(rush(ing)? ?(yds|yards))$/, "player_rush_yds"], [/^(rec(eiving)? ?(yds|yards)|reception yards)$/, "player_reception_yds"],
        [/^(rec|receptions|catches)$/, "player_receptions"], [/^(anytime ?td|td scorer|touchdown)$/, "player_anytime_td"],
        [/^(rush ?\+ ?rec ?(yds|yards))$/, "player_rush_reception_yds"],
        [/^(ks|k|strikeouts|pitcher strikeouts|so)$/, "pitcher_strikeouts"], [/^(tb|total bases)$/, "batter_total_bases"],
        [/^(hits)$/, "batter_hits"], [/^(hr|home ?runs?)$/, "batter_home_runs"], [/^(rbis?)$/, "batter_rbis"],
        [/^(h\+r\+rbi|hits ?\+ ?runs ?\+ ?rbis?)$/, "batter_hits_runs_rbis"],
        [/^(sog|shots on goal)$/, "player_shots_on_goal"], [/^(goals)$/, "player_goals"],
        [/^(pts|points)$/, "player_points"], [/^(reb|rebs|rebounds|boards)$/, "player_rebounds"], [/^(ast|asts|assists)$/, "player_assists"],
        [/^(stl|steals)$/, "player_steals"], [/^(blk|blocks)$/, "player_blocks"], [/^(to|turnovers)$/, "player_turnovers"],
        [/^(saves)$/, "player_total_saves"], [/^(shots on target)$/, "player_shots_on_target"], [/^(shots)$/, "player_shots"]
    ];
    // Books whose prices lead the market; their line counts most in the fair price.
    const SHARP_BOOKS = ["pinnacle", "circasports", "lowvig", "betonlineag", "bookmaker"];

    // ---- Small helpers -------------------------------------------------------

    function sportKey(sport) {
        const s = String(sport || "").trim().toLowerCase();
        if (!s) return "";
        if (/^[a-z]+_[a-z0-9_]+$/.test(s)) return s;
        return SPORTS[s.replace(/[^a-z]/g, "")] || "";
    }

    function marketFor(stat, sport) {
        const s = String(stat || "").trim().toLowerCase().replace(/\s+/g, " ");
        if (!s) return "";
        if (/^[a-z]+_[a-z_]+$/.test(s) && (MARKET_LABELS[s] || /^(player|batter|pitcher)_/.test(s))) return s;
        if (["moneyline", "ml", "h2h"].includes(s)) return "h2h";
        if (["spread", "spreads", "line", "handicap"].includes(s)) return "spreads";
        if (["total", "totals", "over/under", "game total"].includes(s)) return "totals";
        if (/icehockey/.test(sport || "") && /^(pts|points)$/.test(s)) return "player_points";
        if (/baseball/.test(sport || "") && /^(strikeouts|ks|k)$/.test(s)) return "pitcher_strikeouts";
        for (const [re, key] of STAT_WORDS) if (re.test(s)) return key;
        const label = Object.entries(MARKET_LABELS).find(([, l]) => l.toLowerCase() === s);
        return label ? label[0] : "";
    }

    function marketLabel(key) {
        return MARKET_LABELS[key] || String(key || "").replace(/^(player|batter|pitcher)_/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }

    function defaultProps(sport) {
        return DEFAULT_PROPS[String(sport || "").split("_")[0]] || DEFAULT_PROPS.basketball;
    }

    const americanToProb = price => (price >= 100 ? 100 / (price + 100) : price <= -100 ? -price / (-price + 100) : NaN);
    const fmtPrice = p => (p == null || !Number.isFinite(p) ? "?" : p > 0 ? `+${p}` : String(p));
    const fmtPoint = p => (p == null ? "" : p > 0 ? `+${p}` : String(p));
    // The line most books post (on a tie, the middle one of those), so it's always a real line.
    const consensus = list => {
        const v = list.filter(Number.isFinite);
        if (!v.length) return null;
        const counts = new Map();
        v.forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
        const most = Math.max(...counts.values());
        const top = [...counts.keys()].filter(x => counts.get(x) === most).sort((a, b) => a - b);
        return top[Math.floor((top.length - 1) / 2)];
    };
    const pct = p => `${Math.round(p * 100)}%`;
    const monthKey = d => d.toISOString().slice(0, 7);
    const dayKey = d => d.toISOString().slice(0, 10);
    const daysLeftInMonth = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - d.getUTCDate() + 1;
    const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

    function timeLabel(ms, now) {
        const d = new Date(ms);
        const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return now && dayKey(new Date(now)) === dayKey(d) ? t : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${t}`;
    }

    function ago(ms, now) {
        const m = Math.round((now - ms) / 60000);
        if (m < 1) return "just now";
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 6) / 10;
        return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
    }

    // ---- HTTP: one answer shape on every device ------------------------------

    // Returns get(url) -> { status, body, headers } (headers lower-cased).
    function createHttp({ native, fetchImpl, serverFetch }) {
        const lower = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
        const parse = data => { if (typeof data !== "string") return data; try { return JSON.parse(data); } catch (err) { return data; } };
        return async function get(url) {
            if (native) {
                const reply = native.request
                    ? await native.request({ method: "GET", url, responseType: "text", connectTimeout: 20000, readTimeout: 30000 })
                    : await native.get({ url });
                return { status: reply.status, body: parse(reply.data), headers: lower(reply.headers) };
            }
            try {
                const response = await fetchImpl(url);
                const headers = {};
                for (const name of ["x-requests-remaining", "x-requests-used", "x-requests-last"]) {
                    const value = response.headers && response.headers.get(name);
                    if (value != null) headers[name] = value;
                }
                return { status: response.status, body: parse(await response.text()), headers };
            } catch (err) {
                // A page that can't call the API itself (blocked by the browser) asks server.js.
                const reply = serverFetch ? await serverFetch(url) : null;
                if (!reply) throw err;
                return { status: reply.status, body: parse(reply.text), headers: lower(reply.headers) };
            }
        };
    }

    function detectHttp(win) {
        const cap = win.Capacitor;
        const native = cap && cap.isNativePlatform && cap.isNativePlatform() ? (cap.Plugins && cap.Plugins.CapacitorHttp) || null : null;
        if (native) return createHttp({ native });
        if (win.codevDesktop && win.codevDesktop.http && win.codevDesktop.http.odds) return createHttp({ native: { get: ({ url }) => win.codevDesktop.http.odds({ url }) } });
        const local = win.location && win.location.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(win.location.hostname);
        const serverFetch = local ? async url => {
            const response = await win.fetch("/web/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "odds", url }) });
            if (!response.ok) return null;
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            return { status: data.status, text: data.html, headers: data.headers || {} };
        } : null;
        const direct = createHttp({ fetchImpl: win.fetch.bind(win), serverFetch });
        if (!serverFetch) return direct;
        // On CoDev's own server the server calls the API, so the credit balance always comes back.
        return async url => {
            const reply = await serverFetch(url).catch(() => null);
            return reply ? { status: reply.status, body: (() => { try { return JSON.parse(reply.text); } catch (err) { return reply.text; } })(), headers: reply.headers } : direct(url);
        };
    }

    // ---- The tracker ---------------------------------------------------------

    // storage: localStorage (or a stand-in); http: from createHttp; now: () => ms.
    function createOddsTracker({ storage, http, now = () => Date.now(), onChart = null, log = () => {} }) {
        const read = (key, fallback) => { try { const v = JSON.parse(storage.getItem(key) || "null"); return v == null ? fallback : v; } catch (err) { return fallback; } };
        const write = (key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch (err) { log(`[Odds] Couldn't save: ${err.message}`); } };
        const apiKey = () => { try { return String(storage.getItem(STORE.apiKey) || "").trim() || (globalThis.codevSharedKey?.("odds") ?? ""); } catch (err) { return ""; } };
        const settings = () => ({ ...DEFAULTS, ...read(STORE.settings, {}) });
        const saveSettings = patch => { const next = { ...settings(), ...patch }; write(STORE.settings, next); return next; };

        // data: { events: { id: { sport, home, away, start } }, series: { id: {...} }, seen: { "event|market": t },
        //         fetched: { requestKey: t }, games: { sport: { at, list } }, books: { key: title }, tracked: { sport: t } }
        let data = null;
        const load = () => {
            if (!data) data = read(STORE.data, null) || {};
            for (const k of ["events", "series", "seen", "fetched", "games", "books", "tracked"]) data[k] = data[k] || {};
            return data;
        };
        function save() {
            const d = load();
            const cutoff = now() - KEEP_AFTER_START_MS;
            const drop = id => {
                delete d.events[id];
                for (const k of Object.keys(d.series)) if (d.series[k].e === id) delete d.series[k];
                for (const k of Object.keys(d.seen)) if (k.startsWith(`${id}|`)) delete d.seen[k];
            };
            for (const [id, ev] of Object.entries(d.events)) if (Date.parse(ev.start) < cutoff) drop(id);
            let text = JSON.stringify(d);
            // Too big for the page's storage: the games that started first go first.
            const byStart = Object.entries(d.events).sort((a, b) => Date.parse(a[1].start) - Date.parse(b[1].start));
            while (text.length > MAX_STORE_CHARS && byStart.length) { drop(byStart.shift()[0]); text = JSON.stringify(d); }
            try { storage.setItem(STORE.data, text); } catch (err) { log(`[Odds] Couldn't save the lines: ${err.message}`); }
        }

        // ---- Credits ----

        function usage() {
            const u = read(STORE.usage, {});
            const d = new Date(now());
            const s = settings();
            // A new month: the plan starts over.
            if (u.month && u.month !== monthKey(d)) { u.remaining = null; u.used = 0; u.day = null; }
            const remaining = Number.isFinite(u.remaining) ? u.remaining : s.monthlyCredits;
            if (u.day !== dayKey(d)) { u.day = dayKey(d); u.dayStart = remaining; }
            u.month = monthKey(d);
            const share = Math.max(0, Math.floor((u.dayStart - s.reserve) / daysLeftInMonth(d)));
            const spentToday = Math.max(0, u.dayStart - remaining);
            return { ...u, remaining, known: Number.isFinite(u.remaining), share, spentToday, reserve: s.reserve, pace: s.pace, monthly: s.monthlyCredits };
        }

        function noteUsage(headers, estimate) {
            const u = usage();
            const remaining = Number(headers["x-requests-remaining"]);
            const used = Number(headers["x-requests-used"]);
            const last = Number(headers["x-requests-last"]);
            const next = { month: u.month, day: u.day, dayStart: u.dayStart, at: now() };
            if (headers["x-requests-remaining"] != null && Number.isFinite(remaining)) {
                next.remaining = remaining;
                next.used = Number.isFinite(used) ? used : u.used;
                next.last = Number.isFinite(last) ? last : estimate;
            } else {
                // No balance came back (some browsers hide it): count it here instead.
                next.remaining = Math.max(0, u.remaining - estimate);
                next.used = (u.used || 0) + estimate;
                next.last = estimate;
            }
            // The first real balance of the day is the day's starting point.
            if (!u.known && next.remaining !== u.remaining && u.dayStart === u.remaining) next.dayStart = next.remaining + next.last;
            write(STORE.usage, next);
        }

        // Whether a call that costs `cost` credits may go out now. auto: a background re-snapshot,
        // which gets only half of today's share so agents still have credits when asked.
        function canSpend(cost, { auto = false } = {}) {
            const u = usage();
            if (u.remaining - cost < u.reserve) return { ok: false, why: `only ${u.remaining} Odds API credits are left this month and CoDev keeps ${u.reserve} in reserve` };
            if (u.pace) {
                const share = auto ? Math.floor(u.share / 2) : u.share;
                if (u.spentToday + cost > share) return { ok: false, why: `today's share of the month's credits is used (${u.spentToday} of ${u.share}); more tomorrow, or turn off pacing in Settings > Odds API` };
            }
            return { ok: true };
        }

        async function call(path, params, estimate) {
            const key = apiKey();
            if (!key) throw new Error("No Odds API key yet. Add your free key in Settings > Odds API (line tracking).");
            const query = new URLSearchParams({ ...params, apiKey: key }).toString();
            const reply = await http(`${API}${path}?${query}`);
            if (reply.status === 401) throw new Error("The Odds API didn't accept the key. Check it in Settings > Odds API (line tracking).");
            if (reply.status === 429 || (reply.status === 401 && /quota/i.test(JSON.stringify(reply.body)))) {
                write(STORE.usage, { ...read(STORE.usage, {}), remaining: 0, at: now() });
                throw new Error("The Odds API says this month's free credits are used up.");
            }
            if (estimate) noteUsage(reply.headers || {}, estimate);
            if (reply.status === 422 && reply.body && /market/i.test(JSON.stringify(reply.body))) throw new Error(`The Odds API doesn't offer one of these markets for this sport (${JSON.stringify(reply.body).slice(0, 200)}).`);
            if (reply.status >= 400) throw new Error(`The Odds API answered HTTP ${reply.status}: ${JSON.stringify(reply.body).slice(0, 200)}`);
            return reply.body;
        }

        // ---- Snapshots ----

        function record(events, sport, markets, t) {
            const d = load();
            for (const ev of Array.isArray(events) ? events : [events]) {
                if (!ev || !ev.id) continue;
                d.events[ev.id] = { sport: ev.sport_key || sport, home: ev.home_team, away: ev.away_team, start: ev.commence_time };
                for (const m of markets) d.seen[`${ev.id}|${m}`] = t;
                for (const book of ev.bookmakers || []) {
                    d.books[book.key] = book.title || book.key;
                    for (const market of book.markets || []) {
                        if (!markets.includes(market.key)) d.seen[`${ev.id}|${market.key}`] = t;
                        for (const o of market.outcomes || []) {
                            const id = [ev.id, market.key, o.description || "", o.name, book.key].join("|");
                            const point = Number.isFinite(o.point) ? o.point : null;
                            const s = d.series[id] || (d.series[id] = { e: ev.id, m: market.key, d: o.description || "", n: o.name, b: book.key, p: [] });
                            const last = s.p[s.p.length - 1];
                            if (!last || last[1] !== point || last[2] !== o.price) s.p.push([t, point, o.price]);
                            s.s = t;
                        }
                    }
                }
            }
            d.tracked[sport] = t;
            save();
        }

        // Today's games for a sport (free), cached for 10 minutes.
        async function games(sport) {
            const d = load();
            const cached = d.games[sport];
            if (cached && now() - cached.at < 10 * 60000) return cached.list;
            const list = await call(`/sports/${sport}/events`, { dateFormat: "iso" }, 0);
            d.games[sport] = { at: now(), list: (list || []).map(e => ({ id: e.id, home: e.home_team, away: e.away_team, start: e.commence_time })) };
            save();
            return d.games[sport].list;
        }

        // Picks the games a request means: team names ("Lakers", "Celtics vs Knicks") or a
        // start time ("8pm"), within the next 36 hours.
        function matchGames(list, game) {
            const upcoming = list.filter(g => Date.parse(g.start) > now() - 4 * 3600000 && Date.parse(g.start) < now() + 36 * 3600000);
            const q = norm(game);
            if (!q) return upcoming;
            const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(String(game).toLowerCase());
            const byTeam = upcoming.filter(g => {
                const teams = [g.home, g.away].map(norm);
                return teams.some(team => team && (q.includes(team) || team.split(" ").some(w => w.length > 3 && q.split(" ").includes(w))));
            });
            if (byTeam.length) return byTeam;
            if (time) {
                let h = Number(time[1]) % 12 + (time[3] === "pm" ? 12 : 0);
                const m = Number(time[2] || 0);
                return upcoming.filter(g => { const d = new Date(g.start); return d.getHours() === h && d.getMinutes() === m; });
            }
            return [];
        }

        const gameName = g => `${g.away} @ ${g.home}, ${timeLabel(Date.parse(g.start), now())}`;
        const regionsOf = () => (settings().regions || ["us"]).filter(r => REGIONS[r]);

        // Fetches (or reuses) the game lines of a sport. Returns { fresh, at, note }.
        async function refreshLines(sport, markets, { force = false, auto = false } = {}) {
            const d = load();
            const regions = regionsOf();
            const key = `lines:${sport}:${markets.join(",")}:${regions.join(",")}`;
            const at = d.fetched[key] || 0;
            const minutes = force ? 10 : settings().linesMinutes * (auto ? settings().autoHours * 2 : 1);
            if (at && now() - at < minutes * 60000) return { fresh: false, at, note: `saved ${ago(at, now())}` };
            const cost = markets.length * regions.length;
            const allowed = canSpend(cost, { auto });
            if (!allowed.ok) return { fresh: false, at, note: at ? `saved ${ago(at, now())}; not refreshed: ${allowed.why}` : `not fetched: ${allowed.why}`, blocked: true };
            const t = now();
            const events = await call(`/sports/${sport}/odds`, { regions: regions.join(","), markets: markets.join(","), oddsFormat: "american", dateFormat: "iso" }, cost);
            record(events || [], sport, markets, t);
            d.fetched[key] = t;
            save();
            return { fresh: true, at: t, note: `fetched just now (${cost} credit${cost === 1 ? "" : "s"})` };
        }

        async function refreshProps(sport, eventId, markets, { force = false, auto = false } = {}) {
            const d = load();
            const regions = regionsOf();
            const key = `props:${eventId}:${markets.join(",")}:${regions.join(",")}`;
            const at = d.fetched[key] || 0;
            const minutes = force ? 10 : settings().propsMinutes;
            if (at && now() - at < minutes * 60000) return { fresh: false, at, note: `saved ${ago(at, now())}` };
            const cost = markets.length * regions.length;
            const allowed = canSpend(cost, { auto });
            if (!allowed.ok) return { fresh: false, at, note: at ? `saved ${ago(at, now())}; not refreshed: ${allowed.why}` : `not fetched: ${allowed.why}`, blocked: true };
            const t = now();
            const ev = await call(`/sports/${sport}/events/${encodeURIComponent(eventId)}/odds`, { regions: regions.join(","), markets: markets.join(","), oddsFormat: "american", dateFormat: "iso" }, cost);
            record(ev ? [ev] : [], sport, markets, t);
            d.fetched[key] = t;
            d.fetched[`propsEvent:${eventId}`] = t;
            save();
            return { fresh: true, at: t, note: `fetched just now (${cost} credit${cost === 1 ? "" : "s"})` };
        }

        // ---- Reading the saved lines ----

        // One row per (game, market, player or team or total): every book's current
        // line and both prices, its first line, and what that adds up to.
        function rows({ sport, eventIds, markets, player, team } = {}) {
            const d = load();
            const groups = new Map();
            for (const s of Object.values(d.series)) {
                const ev = d.events[s.e];
                if (!ev || (sport && ev.sport !== sport) || (eventIds && !eventIds.includes(s.e)) || (markets && !markets.includes(s.m))) continue;
                if (s.s !== d.seen[`${s.e}|${s.m}`]) continue;   // the book no longer offers it
                const subject = s.d || (s.m === "totals" ? "Game total" : s.n);
                if (player && !norm(s.d).includes(norm(player)) && !norm(player).includes(norm(s.d) || "\u0000")) continue;
                if (team && ![ev.home, ev.away].some(t => norm(t).includes(norm(team)) || norm(team).includes(norm(t)))) continue;
                const gid = [s.e, s.m, s.m === "spreads" || s.m === "h2h" ? "" : subject].join("|");
                const g = groups.get(gid) || { event: s.e, ev, market: s.m, subject: s.m === "spreads" || s.m === "h2h" ? `${ev.away} @ ${ev.home}` : subject, books: {} };
                groups.set(gid, g);
                const book = g.books[s.b] || (g.books[s.b] = { book: s.b, title: d.books[s.b] || s.b, sides: {} });
                book.sides[s.n] = { now: s.p[s.p.length - 1], first: s.p[0], history: s.p };
            }
            return [...groups.values()].map(summarize);
        }

        function summarize(g) {
            const books = Object.values(g.books);
            const twoWay = ["Over", "Under"];
            const isOU = books.some(b => b.sides.Over || b.sides.Under);
            const sideNames = isOU ? twoWay : [...new Set(books.flatMap(b => Object.keys(b.sides)))].sort((a, b) => (a === g.ev.away ? -1 : b === g.ev.away ? 1 : a.localeCompare(b)));
            const [a, b] = sideNames;
            const quote = (book, side, which = "now") => book.sides[side] && book.sides[side][which];
            // Fair chance of side a at each book, with the book's margin taken out.
            const fair = book => {
                const qa = quote(book, a), qb = quote(book, b);
                if (!qa || !qb) return null;
                const pa = americanToProb(qa[2]), pb = americanToProb(qb[2]);
                return Number.isFinite(pa) && Number.isFinite(pb) ? pa / (pa + pb) : null;
            };
            const fairFirst = book => {
                const qa = quote(book, a, "first"), qb = quote(book, b, "first");
                if (!qa || !qb) return null;
                const pa = americanToProb(qa[2]), pb = americanToProb(qb[2]);
                return Number.isFinite(pa) && Number.isFinite(pb) ? pa / (pa + pb) : null;
            };
            const pointNow = book => (quote(book, a) || quote(book, b) || [])[1];
            const pointFirst = book => (quote(book, a, "first") || quote(book, b, "first") || [])[1];
            const hasPoint = books.some(bk => Number.isFinite(pointNow(bk)));
            const lineNow = hasPoint ? consensus(books.map(pointNow)) : null;
            const lineOpen = hasPoint ? consensus(books.map(pointFirst)) : null;
            const points = books.map(pointNow).filter(Number.isFinite);
            const spread = points.length ? Math.max(...points) - Math.min(...points) : 0;
            // The fair price at the usual line: sharp books when they have it, otherwise every book there.
            const atLine = books.filter(bk => !hasPoint || pointNow(bk) === lineNow);
            const sharp = atLine.filter(bk => SHARP_BOOKS.includes(bk.book) && fair(bk) != null);
            const fairList = (sharp.length ? sharp : atLine).map(fair).filter(v => v != null);
            const fairA = fairList.length ? fairList.reduce((x, y) => x + y, 0) / fairList.length : null;
            const fairOpenList = atLine.map(fairFirst).filter(v => v != null);
            const fairAOpen = fairOpenList.length ? fairOpenList.reduce((x, y) => x + y, 0) / fairOpenList.length : null;
            const opened = Math.min(...books.flatMap(bk => Object.values(bk.sides).map(s => s.first[0])));
            const updated = Math.max(...books.flatMap(bk => Object.values(bk.sides).map(s => s.now[0])));
            const snapshots = new Set(books.flatMap(bk => Object.values(bk.sides).flatMap(s => s.history.map(h => h[0])))).size;
            // Best price for each side: the friendliest line first, then the best odds.
            const best = side => {
                let top = null;
                for (const bk of books) {
                    const q = quote(bk, side);
                    if (!q) continue;
                    const better = !top ? true
                        : !hasPoint || q[1] === top.point ? q[2] > top.price
                            : side === "Over" ? q[1] < top.point : side === "Under" ? q[1] > top.point : q[1] > top.point;
                    if (better) top = { book: bk.title, point: q[1], price: q[2] };
                }
                return top;
            };
            return {
                event: g.event, sport: g.ev.sport, game: `${g.ev.away} @ ${g.ev.home}`, start: g.ev.start, market: g.market, stat: marketLabel(g.market),
                subject: g.subject, player: isOU && g.subject !== "Game total" ? g.subject : null, sides: sideNames,
                lineNow, lineOpen, lineMove: lineNow != null && lineOpen != null ? lineNow - lineOpen : 0, lineSpread: spread,
                fairA, fairAOpen, fairMove: fairA != null && fairAOpen != null ? fairA - fairAOpen : 0,
                opened, updated, snapshots,
                bestA: best(a), bestB: b ? best(b) : null,
                books: books.map(bk => ({ book: bk.book, title: bk.title, point: pointNow(bk), firstPoint: pointFirst(bk),
                    a: quote(bk, a) ? quote(bk, a)[2] : null, b: b && quote(bk, b) ? quote(bk, b)[2] : null,
                    aFirst: quote(bk, a, "first") ? quote(bk, a, "first")[2] : null,
                    history: Object.fromEntries(Object.entries(bk.sides).map(([side, s]) => [side, s.history])) }))
                    .sort((x, y) => x.title.localeCompare(y.title))
            };
        }

        function bookLine(r, bk) {
            const [a, b] = r.sides;
            const pt = bk.point != null ? `${r.market === "spreads" ? fmtPoint(bk.point) : bk.point} ` : "";
            return `${bk.title} ${pt}${a[0]} ${fmtPrice(bk.a)}${b ? ` / ${b[0]} ${fmtPrice(bk.b)}` : ""}`;
        }

        function describeRow(r, { withBooks = true } = {}) {
            const [a, b] = r.sides;
            const lines = [];
            const head = r.player ? `${r.player} - ${r.stat}${r.lineNow != null ? ` ${r.lineNow}` : ""}`
                : r.market === "totals" ? `${r.game} - Total ${r.lineNow}`
                    : r.market === "spreads" ? `${r.game} - Spread ${a} ${fmtPoint(r.lineNow)}` : `${r.game} - Moneyline`;
            lines.push(head + (r.player ? ` (${r.game})` : ""));
            if (r.fairA != null) lines.push(`  Fair chance: ${a} ${pct(r.fairA)}${b ? ` / ${b} ${pct(1 - r.fairA)}` : ""} (book margin removed)`);
            if (r.snapshots > 1) {
                const parts = [];
                if (r.lineMove) parts.push(`line ${r.lineOpen} -> ${r.lineNow}`);
                if (Math.abs(r.fairMove) >= 0.01) parts.push(`${a} ${pct(r.fairAOpen)} -> ${pct(r.fairA)}`);
                lines.push(`  Since ${timeLabel(r.opened, now())}: ${parts.join(", ") || "no change"}`);
            }
            if (r.lineSpread) lines.push(`  Books disagree by ${r.lineSpread} on the line`);
            if (r.bestA) lines.push(`  Best ${a}: ${r.bestA.point != null ? `${r.bestA.point} ` : ""}${fmtPrice(r.bestA.price)} at ${r.bestA.book}${r.bestB ? `; best ${b}: ${r.bestB.point != null ? `${r.bestB.point} ` : ""}${fmtPrice(r.bestB.price)} at ${r.bestB.book}` : ""}`);
            if (withBooks) lines.push(`  Books: ${r.books.map(bk => bookLine(r, bk)).join(" | ")}`);
            return lines.join("\n");
        }

        // How worth a look a prop is, and why, from its move, the books' disagreement and the juice.
        function signal(r) {
            const [a, b] = r.sides;
            const why = [];
            let score = 0;
            let side = null;
            if (r.snapshots > 1 && Math.abs(r.lineMove) >= 0.5) {
                score += Math.abs(r.lineMove) * 3;
                side = r.lineMove > 0 ? "Over" : "Under";
                why.push(`line moved ${r.lineOpen} -> ${r.lineNow} since ${timeLabel(r.opened, now())}`);
            }
            if (r.snapshots > 1 && Math.abs(r.fairMove) >= 0.03) {
                score += Math.abs(r.fairMove) * 40;
                side = side || (r.fairMove > 0 ? a : b);
                why.push(`odds moved toward the ${r.fairMove > 0 ? a : b} (${a} ${pct(r.fairAOpen)} -> ${pct(r.fairA)})`);
            }
            if (r.lineSpread >= 1) {
                score += r.lineSpread * 1.5;
                const lo = r.books.reduce((x, y) => (y.point < x.point ? y : x)), hi = r.books.reduce((x, y) => (y.point > x.point ? y : x));
                why.push(`books disagree: ${lo.point} at ${lo.title} vs ${hi.point} at ${hi.title}`);
            }
            if (r.fairA != null && Math.abs(r.fairA - 0.5) >= 0.06) {
                score += Math.abs(r.fairA - 0.5) * 20;
                side = side || (r.fairA > 0.5 ? a : b);
                why.push(`juice leans ${r.fairA > 0.5 ? a : b} (fair ${pct(Math.max(r.fairA, 1 - r.fairA))})`);
            }
            if (!side && r.fairA != null) side = r.fairA >= 0.5 ? a : b;
            return { score, side, why };
        }

        // ---- What agents call ----

        async function resolveGames(sport, game) {
            const list = await games(sport);
            const picked = matchGames(list, game);
            return { list, picked };
        }

        function gamesList(list) {
            const upcoming = matchGames(list, "");
            return upcoming.length ? upcoming.slice(0, 20).map(g => `- ${gameName(g)}`).join("\n") : "(no games in the next 36 hours)";
        }

        async function status() {
            const u = usage();
            const d = load();
            const s = settings();
            const events = Object.values(d.events).filter(e => Date.parse(e.start) > now() - 4 * 3600000);
            return [
                apiKey() ? "Odds API key: set." : `Odds API key: not set. The user can get a free key at ${KEY_URL} and paste it in Settings > Odds API (line tracking). Until then, read odds on Outlier in the browser.`,
                `Credits this month: ${u.remaining} of ${u.monthly} left${u.known ? "" : " (estimated until the first call)"}, ${u.reserve} kept in reserve.`,
                s.pace ? `Today's share: ${Math.max(0, u.share - u.spentToday)} credits left of ${u.share} (the month is spread over its days).` : "Pacing is off: any credits above the reserve can be spent today.",
                `Sportsbook regions: ${regionsOf().map(r => REGIONS[r]).join(", ")} (each region multiplies a call's cost).`,
                `Costs: listing games is free; game lines cost 1 credit per market per region for a whole sport; props cost 1 credit per market per region per game. Lines are fetched again only after ${s.linesMinutes} minutes, props after ${s.propsMinutes}.`,
                `Saved: ${events.length} upcoming games, ${Object.keys(d.series).length} book prices${s.autoTrack ? `; re-snapshotted about every ${s.autoHours} hours while CoDev is open` : ""}.`
            ].join("\n");
        }

        async function gameLines({ sport, game, markets, refresh }) {
            const sk = sportKey(sport);
            if (!sk) return `Unknown sport "${sport}". Use NBA, NFL, MLB, NHL, WNBA, NCAAB, NCAAF, or a key like basketball_nba.`;
            const wanted = (Array.isArray(markets) ? markets : String(markets || "h2h,spreads,totals").split(/[,\s]+/)).map(m => marketFor(m, sk)).filter(m => ["h2h", "spreads", "totals"].includes(m));
            const mk = wanted.length ? [...new Set(wanted)] : ["h2h", "spreads", "totals"];
            const got = await refreshLines(sk, mk, { force: Boolean(refresh) });
            let ids = null;
            if (game) {
                const { list, picked } = await resolveGames(sk, game);
                if (!picked.length) return `No ${sport} game matches "${game}". Games:\n${gamesList(list)}`;
                ids = picked.map(g => g.id);
            }
            const list = rows({ sport: sk, eventIds: ids, markets: mk }).sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || mk.indexOf(x.market) - mk.indexOf(y.market));
            if (!list.length) return `No ${sport} game lines ${got.blocked ? `(${got.note})` : "are posted right now"}.`;
            return `[The Odds API, ${got.note}]\n` + list.map(r => describeRow(r)).join("\n\n");
        }

        async function playerProps({ sport, game, stats, player, refresh }) {
            const sk = sportKey(sport);
            if (!sk) return `Unknown sport "${sport}". Use NBA, NFL, MLB, NHL, WNBA, NCAAB, NCAAF, or a key like basketball_nba.`;
            const mk = pickMarkets(stats, sk);
            const { list, picked } = await resolveGames(sk, game || player || "");
            if (!game && !player) return `Name a game (team or start time) so only that game's props are fetched. ${sport} games:\n${gamesList(list)}`;
            let targets = picked;
            if (!targets.length && player) targets = savedGamesWith(sk, player, list);
            if (!targets.length) return `No ${sport} game matches "${game || player}". Games:\n${gamesList(list)}`;
            if (targets.length > 2) return `"${game}" matches ${targets.length} games; name one team or a start time:\n${targets.map(g => `- ${gameName(g)}`).join("\n")}`;
            const notes = [];
            for (const g of targets) notes.push(`${gameName(g)}: ${(await refreshProps(sk, g.id, mk, { force: Boolean(refresh) })).note}`);
            const found = rows({ sport: sk, eventIds: targets.map(g => g.id), markets: mk, player }).filter(r => r.player);
            if (!found.length) return `[The Odds API] ${notes.join("; ")}\nNo ${mk.map(marketLabel).join(", ")} props${player ? ` for ${player}` : ""} are posted for that game yet.`;
            found.sort((x, y) => x.subject.localeCompare(y.subject) || mk.indexOf(x.market) - mk.indexOf(y.market));
            const shown = found.slice(0, 60);
            return `[The Odds API] ${notes.join("; ")}\n` + shown.map(r => describeRow(r)).join("\n\n")
                + (found.length > shown.length ? `\n\n(${found.length - shown.length} more; pass player or stats to narrow it.)` : "");
        }

        function pickMarkets(stats, sk) {
            const asked = (Array.isArray(stats) ? stats : String(stats || "").split(/,/)).map(s => marketFor(s, sk)).filter(m => m && !["h2h", "spreads", "totals"].includes(m));
            return asked.length ? [...new Set(asked)].slice(0, 6) : defaultProps(sk);
        }

        // Games already saved that have this player's props.
        function savedGamesWith(sk, player, list) {
            const ids = new Set(rows({ sport: sk, player }).map(r => r.event));
            return list.filter(g => ids.has(g.id));
        }

        // Free: only what's saved.
        async function lineMovement({ sport, game, player, stat }) {
            const sk = sport ? sportKey(sport) : "";
            const mk = stat ? [marketFor(stat, sk)].filter(Boolean) : null;
            let list = rows({ sport: sk || undefined, markets: mk && mk.length ? mk : undefined, player: player || undefined, team: !player && game ? game : undefined });
            if (game && player) list = list.filter(r => norm(r.game).includes(norm(game)) || norm(game).split(" ").some(w => w.length > 3 && norm(r.game).includes(w)));
            if (!list.length) return "Nothing saved for that yet. Fetch it first with odds_player_props or odds_game_lines; movement shows from the second snapshot on.";
            list.sort((x, y) => Math.abs(y.lineMove) + Math.abs(y.fairMove) * 10 - (Math.abs(x.lineMove) + Math.abs(x.fairMove) * 10));
            return list.slice(0, 25).map(r => {
                const head = describeRow(r, { withBooks: false });
                const [a] = r.sides;
                const per = r.books.map(bk => {
                    const h = bk.history[a] || Object.values(bk.history)[0] || [];
                    return `${bk.title}: ${h.map(p => `${timeLabel(p[0], now())} ${p[1] != null ? `${p[1]} ` : ""}${fmtPrice(p[2])}`).join(" -> ")}`;
                });
                return `${head}\n  ${r.snapshots} snapshot${r.snapshots === 1 ? "" : "s"}, last ${ago(r.updated, now())}. ${a} by book:\n    ${per.join("\n    ")}`;
            }).join("\n\n");
        }

        // The main one: which players and props to look up on Outlier, and why.
        async function lookupList({ sport, game, stats, top }) {
            const sk = sportKey(sport);
            if (!sk) return `Unknown sport "${sport}". Use NBA, NFL, MLB, NHL, WNBA, NCAAB, NCAAF, or a key like basketball_nba.`;
            const mk = pickMarkets(stats, sk);
            const limit = Math.max(3, Math.min(30, Number(top) || 12));
            const { list, picked } = await resolveGames(sk, game || "");
            const notes = [];
            let targets = picked;
            if (game && !targets.length) return `No ${sport} game matches "${game}". Games:\n${gamesList(list)}`;
            if (!game) {
                // The whole slate: props only for games already fetched (no credits), plus one
                // cheap call for every game's lines to say which games are moving.
                const saved = new Set(rows({ sport: sk, markets: mk }).map(r => r.event));
                targets = picked.filter(g => saved.has(g.id));
                try { notes.push(`game lines ${(await refreshLines(sk, ["spreads", "totals"])).note}`); } catch (err) { notes.push(`game lines: ${err.message}`); }
            }
            if (targets.length > 3) targets = targets.slice(0, 3);
            for (const g of game ? targets : []) {
                try { notes.push(`${gameName(g)} props ${(await refreshProps(sk, g.id, mk)).note}`); } catch (err) { notes.push(`${gameName(g)}: ${err.message}`); }
            }
            const props = rows({ sport: sk, eventIds: targets.map(g => g.id), markets: mk }).filter(r => r.player);
            const ranked = props.map(r => ({ r, ...signal(r) })).filter(x => x.side).sort((x, y) => y.score - x.score);
            const out = [`[The Odds API] ${notes.join("; ") || "from saved lines"}`];
            if (!game && !props.length) {
                const lines = rows({ sport: sk, markets: ["spreads", "totals"] }).map(r => ({ r, ...signal(r) })).filter(x => x.why.length).sort((x, y) => y.score - x.score);
                out.push(`No props are saved for today's ${sport} games yet. Name a game (team or time) to fetch its props${lines.length ? ". Games whose lines are moving:" : ":"}`);
                out.push(lines.length ? lines.slice(0, 6).map(x => `- ${x.r.game}, ${x.r.stat} ${x.r.market === "spreads" ? fmtPoint(x.r.lineNow) : x.r.lineNow}: ${x.why.join("; ")}`).join("\n") : gamesList(list));
                return out.join("\n");
            }
            if (!ranked.length) return out.concat(`No ${mk.map(marketLabel).join(", ")} props are posted for ${targets.map(gameName).join(" / ") || "that game"} yet. Books usually post props the day of the game.`).join("\n");
            const notable = ranked.filter(x => x.why.length);
            const pickedRows = (notable.length >= 3 ? notable : ranked).slice(0, limit);
            const oneSnapshot = pickedRows.every(x => x.r.snapshots < 2);
            out.push(`Look these up on Outlier (${pickedRows.length} of ${props.length} props, most notable first):`);
            pickedRows.forEach((x, i) => {
                const r = x.r;
                out.push(`${i + 1}. ${r.player} | ${r.stat} | ${r.lineNow} | ${x.side} (${r.game})`
                    + `\n   Why: ${x.why.join("; ") || "no strong signal; the usual line and price"}`
                    + `\n   Books: ${r.books.map(bk => bookLine(r, bk)).join(" | ")}`);
            });
            if (oneSnapshot) out.push(`Only one snapshot so far, so there's no movement yet; CoDev compares against it on the next fetch (after ${settings().propsMinutes} minutes).`);
            const legs = pickedRows.map(x => ({ player: x.r.player, stat: x.r.stat, line: x.r.lineNow, side: x.side }));
            out.push(`Legs for outlier_research_list: ${JSON.stringify(legs)}`);
            out.push("These are what the sportsbooks show, not picks: check each on Outlier (hit rates, minutes, matchup, injuries) before using it.");
            return out.join("\n");
        }

        async function showChart(args) {
            if (!onChart) return "The chart opens in CoDev's window, which isn't available here.";
            const list = rows({ sport: sportKey(args.sport) || undefined, player: args.player || undefined, team: !args.player ? args.team || args.game : undefined,
                markets: args.stat ? [marketFor(args.stat, sportKey(args.sport))].filter(Boolean) : undefined });
            if (!list.length) return "Nothing saved for that yet. Fetch it first with odds_player_props or odds_game_lines.";
            onChart({ player: args.player || "", team: args.team || args.game || "", stat: args.stat || "" });
            return `Opened the line chart and book table for ${list[0].player || list[0].game}, ${list[0].stat} (${list.length} match${list.length === 1 ? "" : "es"}). The user can see it in CoDev now.`;
        }

        const sportParam = { type: "string", description: "The league: NBA, NFL, MLB, NHL, WNBA, NCAAB, NCAAF (or an Odds API key like basketball_nba)." };
        const gameParam = { type: "string", description: "Optional: the game, by a team (\"Lakers\", \"Celtics vs Knicks\") or start time in the user's local time (\"8pm\")." };
        const statsParam = { type: "string", description: "Optional: the stats, comma-separated, in Outlier's words (\"Points, Rebounds, PRA\", \"Passing Yards\", \"Strikeouts\"). Each stat costs a credit per game, so ask only for what you need; leave it out for the sport's 3 main ones." };
        const TOOLS = {
            odds_status: {
                description: "Whether The Odds API is set up, how many of the user's free monthly credits are left (and today's share), and what's saved. Call it when a line tool says it couldn't fetch, or when the user asks about the odds key or credits.",
                inputSchema: { type: "object", properties: {} }, run: status
            },
            odds_lookup_list: {
                description: "The players, props and lines to look up on Outlier, from every sportsbook's current prices (The Odds API): props whose line or odds moved, props where the books disagree, and props the juice leans on, each with the side the market leans, the reason, and every book's line and price. Ends with the list as legs ready for outlier_research_list. "
                    + "Call it first when the user wants props found, a ticket built or lines tracked, then research those legs on Outlier. With a game it fetches that game's props (a few credits, saved and reused for an hour); without one it ranks only props already saved and says which games' lines are moving.",
                inputSchema: { type: "object", properties: { sport: sportParam, game: gameParam, stats: statsParam,
                    top: { type: "integer", description: "Optional: how many props to list (default 12, up to 30)." } }, required: ["sport"] }, run: lookupList
            },
            odds_player_props: {
                description: "One game's player props at every sportsbook (The Odds API): each player's line and Over/Under price per book, the best price for each side, the fair chance with the margin removed, and how the line moved since CoDev first saw it. Costs 1 credit per stat per game; saved and reused for an hour.",
                inputSchema: { type: "object", properties: { sport: sportParam, game: gameParam, stats: statsParam,
                    player: { type: "string", description: "Optional: only this player." },
                    refresh: { type: "boolean", description: "Optional: fetch again even if saved in the last hour (still not within 10 minutes). Only when the user asks for the latest." } }, required: ["sport"] }, run: playerProps
            },
            odds_game_lines: {
                description: "Moneyline, spread and total for a sport's games at every sportsbook (The Odds API), with the best price, the fair chance and how each line moved since CoDev first saw it. One call covers the whole slate (about 3 credits); saved and reused for 30 minutes.",
                inputSchema: { type: "object", properties: { sport: sportParam, game: gameParam,
                    markets: { type: "string", description: "Optional: moneyline, spread, total (comma-separated). Default all three." },
                    refresh: { type: "boolean", description: "Optional: fetch again even if saved recently. Only when the user asks for the latest." } }, required: ["sport"] }, run: gameLines
            },
            odds_line_movement: {
                description: "How saved lines moved over time, book by book (every snapshot CoDev took: time, line, price). Free: it reads only what odds_player_props, odds_game_lines and odds_lookup_list saved.",
                inputSchema: { type: "object", properties: { sport: sportParam, game: gameParam,
                    player: { type: "string", description: "Optional: a player." }, stat: { type: "string", description: "Optional: the stat or market (\"Points\", \"Spread\")." } } }, run: lineMovement
            },
            odds_show_chart: {
                description: "Show the user a chart of a saved line's movement at each sportsbook, with a table comparing the books, in CoDev's window. Use it when the user wants to see a line's movement or the books side by side.",
                inputSchema: { type: "object", properties: { sport: sportParam, player: { type: "string", description: "A player, for a prop." },
                    team: { type: "string", description: "A team, for a game line." }, stat: { type: "string", description: "The stat or market." } } }, run: showChart
            }
        };

        // Without a key only odds_status is offered, so agents read odds on Outlier instead.
        function buildTools() {
            const names = apiKey() ? ODDS_TOOL_NAMES.filter(n => n !== "odds_show_chart" || onChart) : ["odds_status"];
            return names.map(name => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema,
                run: async args => { try { return await TOOLS[name].run(args || {}); } catch (err) { return `Error: ${err.message}`; } } }));
        }

        function describe(name, args) {
            args = args || {};
            const where = [args.sport, args.game].filter(Boolean).join(" ");
            switch (name) {
                case "odds_status": return "🎯 Checking the Odds API credits";
                case "odds_lookup_list": return `🎯 Finding props to look up${where ? ` (${where})` : ""}`;
                case "odds_player_props": return `🎯 Comparing props across sportsbooks${where ? ` (${where})` : ""}`;
                case "odds_game_lines": return `🎯 Comparing game lines${where ? ` (${where})` : ""}`;
                case "odds_line_movement": return `📉 Checking line movement${args.player ? `: ${args.player}` : where ? ` (${where})` : ""}`;
                case "odds_show_chart": return `📉 Showing the line chart${args.player ? ` for ${args.player}` : ""}`;
                default: return null;
            }
        }

        // Re-snapshots what was looked at in the last day, while CoDev is open, so movement
        // builds up on its own. Uses at most half of today's share.
        async function autoTrack() {
            const s = settings();
            if (!s.autoTrack || !apiKey()) return;
            const d = load();
            const every = s.autoHours * 3600000;
            for (const [sport, at] of Object.entries(d.tracked)) {
                if (now() - at > 24 * 3600000) continue;
                try { await refreshLines(sport, ["spreads", "totals"], { auto: true }); } catch (err) { log(`[Odds] ${err.message}`); return; }
            }
            for (const [key, at] of Object.entries(d.fetched)) {
                if (!key.startsWith("props:") || now() - at < every) continue;
                const [, eventId, markets] = key.split(":");
                const ev = d.events[eventId];
                if (!ev || Date.parse(ev.start) < now() || Date.parse(ev.start) > now() + 24 * 3600000) continue;
                try {
                    const got = await refreshProps(ev.sport, eventId, markets.split(","), { auto: true });
                    if (got.blocked) return;
                } catch (err) { log(`[Odds] ${err.message}`); return; }
            }
        }

        return { buildTools, describe, status, usage, settings, saveSettings, rows, canSpend, autoTrack, TOOLS,
            lookupList, playerProps, gameLines, lineMovement, books: () => load().books, hasKey: () => Boolean(apiKey()) };
    }

    // ---- Settings panel and the line viewer --------------------------------------

    const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

    // Fills Settings > Odds API. el: the <details> element; openViewer: shows the line viewer.
    function mountSettings(el, { tracker, storage, openViewer }) {
        el.innerHTML = `
            <summary>🎯 Odds API (line tracking)</summary>
            <div style="font-size: 0.8rem; color: var(--text-muted);">Lets agents compare every sportsbook's lines and props, track how they move, and pick which props to look up on Outlier. The free plan is enough: <a href="${KEY_URL}" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">get a free key</a> (just an email address), then paste it here.</div>
            <div class="form-group">
                <label>Odds API key</label>
                <input type="text" data-o="key" placeholder="Paste your key" autocomplete="off" spellcheck="false" style="font-family: monospace;">
            </div>
            <div data-o="usage" style="font-size: 0.85rem; white-space: pre-line;"></div>
            <label class="checkbox-group"><input type="checkbox" data-o="pace"> Spread the month's credits over its days</label>
            <label class="checkbox-group"><input type="checkbox" data-o="auto"> Re-check the lines agents looked at every few hours while CoDev is open, to track movement</label>
            <div class="form-group">
                <label>Sportsbooks to compare (each one adds to every call's cost)</label>
                <div data-o="regions" style="display: flex; flex-direction: column; gap: 4px;"></div>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px;">
                <button class="btn-secondary" type="button" data-o="viewer">📉 View tracked lines</button>
            </div>`;
        const $ = n => el.querySelector(`[data-o="${n}"]`);
        const s = tracker.settings();
        $("key").value = storage.getItem(STORE.apiKey) || "";
        $("key").addEventListener("input", () => { storage.setItem(STORE.apiKey, $("key").value.replace(/[\s"'`]+/g, "")); refresh(); });
        $("pace").checked = s.pace;
        $("pace").addEventListener("change", () => { tracker.saveSettings({ pace: $("pace").checked }); refresh(); });
        $("auto").checked = s.autoTrack;
        $("auto").addEventListener("change", () => tracker.saveSettings({ autoTrack: $("auto").checked }));
        $("regions").innerHTML = Object.entries(REGIONS).map(([k, label]) => `<label class="checkbox-group"><input type="checkbox" value="${k}"${s.regions.includes(k) ? " checked" : ""}> ${esc(label)}</label>`).join("");
        $("regions").addEventListener("change", () => {
            const picked = [...$("regions").querySelectorAll("input:checked")].map(i => i.value);
            tracker.saveSettings({ regions: picked.length ? picked : ["us"] });
            refresh();
        });
        $("viewer").addEventListener("click", () => openViewer({}));
        function refresh() {
            const u = tracker.usage();
            $("usage").textContent = tracker.hasKey()
                ? `✅ Key saved. ${u.remaining} of ${u.monthly} credits left this month${u.known ? "" : " (until the first call shows the real number)"}.`
                    + (u.pace ? `\nToday: ${Math.max(0, u.share - u.spentToday)} of ${u.share} credits left. ${u.reserve} are always kept back.` : `\n${u.reserve} credits are always kept back.`)
                    + `\nA call costs ${tracker.settings().regions.length} credit${tracker.settings().regions.length === 1 ? "" : "s"} per stat or market.`
                : "No key yet: agents read odds on Outlier in the browser instead.";
        }
        el.addEventListener("toggle", () => { if (el.open) refresh(); });
        refresh();
        return { refresh };
    }

    // Categorical series colors (fixed order; a book keeps its color across views).
    const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

    // A step chart of one side's line (or price, for a moneyline) at each book over time.
    function chartSvg(row, { width = 560, height = 220, now = Date.now() } = {}) {
        const side = row.sides[0];
        const usePoint = row.books.some(b => b.point != null);
        const series = row.books.slice(0, SERIES.length).map((bk, i) => {
            const h = (bk.history[side] || []).map(p => ({ t: p[0], v: usePoint ? p[1] : p[2], price: p[2], point: p[1] })).filter(p => Number.isFinite(p.v));
            if (h.length) h.push({ ...h[h.length - 1], t: Math.max(row.updated, h[h.length - 1].t), end: true });
            return { title: bk.title, color: SERIES[i], points: h };
        }).filter(s => s.points.length);
        const all = series.flatMap(s => s.points);
        if (!all.length) return "";
        const pad = { l: 44, r: 12, t: 12, b: 26 };
        let t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
        if (t1 - t0 < 60000) { t0 -= 1800000; t1 += 1800000; }
        let v0 = Math.min(...all.map(p => p.v)), v1 = Math.max(...all.map(p => p.v));
        if (v1 - v0 < (usePoint ? 1 : 10)) { const mid = (v0 + v1) / 2, half = usePoint ? 0.5 : 5; v0 = mid - half; v1 = mid + half; }
        const x = t => pad.l + (t - t0) / (t1 - t0) * (width - pad.l - pad.r);
        const y = v => pad.t + (v1 - v) / (v1 - v0) * (height - pad.t - pad.b);
        const ticks = [v0, (v0 + v1) / 2, v1];
        const fmtV = v => (usePoint ? (Math.round(v * 2) / 2).toString() : fmtPrice(Math.round(v)));
        const grid = ticks.map(v => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--odds-grid)" stroke-width="1"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--odds-muted)">${esc(fmtV(v))}</text>`).join("");
        const timeTicks = [t0, t1].map((t, i) => `<text x="${x(t)}" y="${height - 6}" text-anchor="${i ? "end" : "start"}" font-size="11" fill="var(--odds-muted)">${esc(timeLabel(t, now))}</text>`).join("");
        // Books on the same line would hide each other, so each is nudged a pixel or two apart.
        const lines = series.map((s, i) => {
            const off = (i - (series.length - 1) / 2) * 2.5;
            const yy = v => y(v) + off;
            let d = "";
            s.points.forEach((p, j) => { d += j ? ` H${x(p.t)} V${yy(p.v)}` : `M${x(p.t)} ${yy(p.v)}`; });
            const dots = s.points.filter(p => !p.end).map(p => `<circle cx="${x(p.t)}" cy="${yy(p.v)}" r="4" fill="${s.color}" stroke="var(--odds-surface)" stroke-width="2"><title>${esc(`${s.title}: ${p.point != null ? `${p.point} ` : ""}${fmtPrice(p.price)} at ${timeLabel(p.t, now)}`)}</title></circle>`).join("");
            return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots}`;
        }).join("");
        const legend = series.map(s => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;"><span style="width:10px;height:10px;border-radius:2px;background:${s.color};"></span>${esc(s.title)}</span>`).join("");
        return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(`${side} ${usePoint ? "line" : "price"} by sportsbook over time`)}">${grid}${timeTicks}${lines}</svg>`
            + `<div style="font-size:12px;color:var(--odds-muted);margin-top:4px;">${legend}</div>`;
    }

    function tableHtml(row) {
        const [a, b] = row.sides;
        const best = (bk, which) => (which === "a" ? row.bestA : row.bestB) && (which === "a" ? row.bestA : row.bestB).book === bk.title;
        return `<table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr style="text-align:left;color:var(--odds-muted);"><th style="padding:4px;">Book</th>${row.books.some(bk => bk.point != null) ? "<th style=\"padding:4px;\">Line</th><th style=\"padding:4px;\">Opened</th>" : ""}<th style="padding:4px;">${esc(a)}</th>${b ? `<th style="padding:4px;">${esc(b)}</th>` : ""}</tr></thead>
            <tbody>${row.books.map(bk => `<tr style="border-top:1px solid var(--odds-grid);"><td style="padding:4px;">${esc(bk.title)}</td>${row.books.some(x => x.point != null) ? `<td style="padding:4px;">${esc(bk.point ?? "")}</td><td style="padding:4px;color:var(--odds-muted);">${esc(bk.firstPoint ?? "")}</td>` : ""}<td style="padding:4px;${best(bk, "a") ? "font-weight:700;" : ""}">${esc(fmtPrice(bk.a))}${best(bk, "a") ? " ★" : ""}</td>${b ? `<td style="padding:4px;${best(bk, "b") ? "font-weight:700;" : ""}">${esc(fmtPrice(bk.b))}${best(bk, "b") ? " ★" : ""}</td>` : ""}</tr>`).join("")}</tbody>
        </table>`;
    }

    // The line viewer: pick a saved prop or game line, see its chart and the books side by side.
    function mountViewer(el, { tracker, now = () => Date.now() }) {
        el.innerHTML = `
            <style>
                .odds-viewer { --odds-surface: var(--bg-secondary, #fcfcfb); --odds-grid: rgba(127,127,127,0.25); --odds-muted: var(--text-muted, #52514e); display: flex; flex-direction: column; gap: 10px; }
                .odds-viewer select, .odds-viewer input { width: 100%; }
                .odds-viewer .odds-pick { max-height: 180px; overflow: auto; border: 1px solid var(--odds-grid); border-radius: 6px; }
                .odds-viewer .odds-pick button { display: block; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--odds-grid); padding: 6px 8px; color: inherit; cursor: pointer; font-size: 13px; }
                .odds-viewer .odds-pick button.active { background: rgba(42,120,214,0.15); }
            </style>
            <div class="odds-viewer">
                <input type="search" data-v="q" placeholder="Filter by player, team or stat">
                <div class="odds-pick" data-v="list"></div>
                <div data-v="detail" style="font-size: 13px;"></div>
            </div>`;
        const $ = n => el.querySelector(`[data-v="${n}"]`);
        let all = [], current = null;
        const label = r => (r.player ? `${r.player} - ${r.stat} ${r.lineNow ?? ""}` : `${r.game} - ${r.stat}${r.lineNow != null ? ` ${r.market === "spreads" ? fmtPoint(r.lineNow) : r.lineNow}` : ""}`);
        function renderList() {
            const q = norm($("q").value);
            const shown = all.filter(r => !q || q.split(" ").every(w => norm(`${label(r)} ${r.game}`).includes(w))).slice(0, 200);
            $("list").innerHTML = shown.length ? shown.map((r, i) => `<button type="button" data-i="${all.indexOf(r)}" class="${r === current ? "active" : ""}">${esc(label(r))}<span style="color:var(--odds-muted);"> · ${esc(r.game)}${r.snapshots > 1 && (r.lineMove || Math.abs(r.fairMove) >= 0.03) ? " · moved" : ""}</span></button>`).join("")
                : `<div style="padding:8px;color:var(--odds-muted);">${all.length ? "Nothing matches." : "No lines saved yet. Ask an agent for props or game lines, or add your key in Settings first."}</div>`;
            if (!current && shown.length) show(shown[0]);
        }
        function show(r) {
            current = r;
            [...$("list").querySelectorAll("button")].forEach(b => b.classList.toggle("active", all[Number(b.dataset.i)] === r));
            const [a, b] = r.sides;
            $("detail").innerHTML = `<div style="font-weight:600;margin-bottom:2px;">${esc(label(r))}</div>
                <div style="color:var(--odds-muted);margin-bottom:6px;">${esc(r.game)} · ${r.snapshots} snapshot${r.snapshots === 1 ? "" : "s"}, last ${esc(ago(r.updated, now()))}${r.fairA != null ? ` · fair ${esc(a)} ${pct(r.fairA)}${b ? ` / ${esc(b)} ${pct(1 - r.fairA)}` : ""}` : ""}</div>
                ${r.snapshots > 1 ? chartSvg(r, { now: now() }) : `<div style="color:var(--odds-muted);margin-bottom:6px;">One snapshot so far; the chart fills in as CoDev checks the line again.</div>`}
                <div style="margin-top:8px;">${tableHtml(r)}</div>
                <div style="color:var(--odds-muted);margin-top:4px;">★ best price for that side. ${esc(a)} line chart; hover a dot for the price.</div>`;
        }
        $("list").addEventListener("click", e => { const btn = e.target.closest("button[data-i]"); if (btn) show(all[Number(btn.dataset.i)]); });
        $("q").addEventListener("input", () => { current = null; renderList(); });
        function open(filter = {}) {
            all = tracker.rows().sort((x, y) => (Math.abs(y.lineMove) + Math.abs(y.fairMove) * 10) - (Math.abs(x.lineMove) + Math.abs(x.fairMove) * 10) || x.subject.localeCompare(y.subject));
            current = null;
            $("q").value = [filter.player || filter.team, filter.stat].filter(Boolean).join(" ");
            renderList();
        }
        return { open };
    }

    return {
        API, KEY_URL, STORE, DEFAULTS, REGIONS, ODDS_TOOL_NAMES, MARKET_LABELS,
        sportKey, marketFor, marketLabel, americanToProb, createHttp, detectHttp,
        createOddsTracker, mountSettings, mountViewer, chartSvg
    };
});
