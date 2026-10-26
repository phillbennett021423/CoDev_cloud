// Turns signed-in Outlier pages into the props JSON tools/outlier-analytics reads.
// Two halves: collectPage() runs inside the page and only gathers text (tables,
// grid rows, and the smallest blocks that hold both a stat line and odds), and
// parseCollected() here in Node turns that text into props, so the parsing can
// be tested without a browser. Outlier's markup isn't documented and changes, so
// nothing depends on its class names unless config.json names selectors.

// Runs in the page (page.evaluate), so it must not use anything from this file.
// selectors (optional): { row: 'css', fields: { player: 'css', odds: 'css', ... } }
function collectPage(selectors) {
    const text = el => (el.innerText || el.textContent || '').replace(/ /g, ' ').trim();
    // A cell that is only a sportsbook logo still says which book it is.
    const cellText = el => text(el) || [...el.querySelectorAll('img[alt], [aria-label], [title]')]
        .map(n => n.getAttribute('alt') || n.getAttribute('aria-label') || n.getAttribute('title')).filter(Boolean).join(' ');
    const out = { url: location.href, title: document.title, configured: [], tables: [], cards: [] };

    if (selectors && selectors.row) {
        for (const row of document.querySelectorAll(selectors.row)) {
            const item = { text: text(row) };
            for (const [field, css] of Object.entries(selectors.fields || {})) {
                const found = [...row.querySelectorAll(css)].map(cellText).filter(Boolean);
                item[field] = found.length > 1 ? found : found[0] || null;
            }
            out.configured.push(item);
        }
    }

    for (const table of document.querySelectorAll('table')) {
        const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (!headerRow) continue;
        const headers = [...headerRow.children].map(cellText);
        const rows = [...table.querySelectorAll('tbody tr, tr')].filter(tr => tr !== headerRow)
            .map(tr => [...tr.children].map(cellText)).filter(cells => cells.some(Boolean));
        if (rows.length) out.tables.push({ headers, rows });
    }
    // ARIA grids (virtualized data tables) instead of <table>.
    for (const grid of document.querySelectorAll('[role="grid"], [role="table"], [role="treegrid"]')) {
        if (grid.tagName === 'TABLE') continue;
        const headers = [...grid.querySelectorAll('[role="columnheader"]')].map(cellText);
        const rows = [...grid.querySelectorAll('[role="row"]')]
            .map(r => [...r.querySelectorAll('[role="cell"], [role="gridcell"]')].map(cellText)).filter(cells => cells.some(Boolean));
        if (headers.length && rows.length) out.tables.push({ headers, rows });
    }

    // A board laid out as a grid (Outlier's Props board): the hit-rate labels (L5,
    // L10, H2H, 2026...) are only in the header, each row has bare "90%" cells. Each
    // cell gets its column's label by lining up with the header across the page.
    const LABEL = /^(L5|L10|L15|L20|L25|L30|H2H|SZN|Season|20\d\d)$/i;
    const leaves = [...document.body.querySelectorAll('*')].filter(el => !el.children.length);
    const heads = leaves.map(el => ({ el, label: text(el).replace(/[^A-Za-z0-9]/g, ''), r: el.getBoundingClientRect() }))
        .filter(h => LABEL.test(h.label) && h.r.width > 0);
    const byRow = new Map();
    for (const h of heads) {
        const key = Math.round(h.r.top / 8);
        if (!byRow.has(key)) byRow.set(key, []);
        byRow.get(key).push(h);
    }
    const header = [...byRow.values()].sort((a, b) => b.length - a.length)[0] || [];
    const cellRates = new Map();
    if (header.length >= 3) {
        const mid = r => r.left + r.width / 2;
        for (const el of leaves) {
            if (!/^\d{1,3}(\.\d+)?\s?%$/.test(text(el))) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || r.top <= header[0].r.top) continue;
            const near = header.map(h => ({ h, d: Math.abs(mid(h.r) - mid(r)) })).sort((a, b) => a.d - b.d)[0];
            if (near && near.d <= Math.max(40, near.h.r.width)) cellRates.set(el, `${near.h.label}: ${text(el)}`);
        }
    }
    const withRates = el => {
        const rates = [...el.querySelectorAll('*')].filter(c => cellRates.has(c)).map(c => cellRates.get(c));
        return rates.length ? `${text(el)} | hit rates: ${rates.join(' · ')}` : text(el);
    };

    // The smallest elements holding both a stat line (o24.5, Over 24.5, More 24.5)
    // and an American price: each is one prop card or board row.
    const ODDS = /(^|[\s(])[+\-−]\d{3,4}(?=$|[\s)])/;
    const LINE = /\b(o|u|over|under|more|less|higher|lower)\s?\d+(\.\d+)?\b|\b\d+\.5\b/i;
    const qualifies = el => {
        const t = text(el);
        return t.length > 0 && t.length <= 800 && ODDS.test(t) && LINE.test(t);
    };
    const candidates = [...document.body.querySelectorAll('div, li, tr, article, section, a, [role="row"]')].filter(qualifies);
    const set = new Set(candidates);
    for (const el of candidates) {
        let inner = false;
        for (const other of el.querySelectorAll('*')) { if (set.has(other)) { inner = true; break; } }
        if (!inner) out.cards.push(withRates(el));
    }

    // Injury report lines ("Joel Embiid (PHI) - Out", "Out: Joel Embiid"): short blocks
    // with an injury status and no price.
    const STATUS = /\b(?:OUT|Out|Ruled Out|ruled out|Inactive|INACTIVE|Returning|RETURNING|Probable)\b/;
    out.injuries = [...document.body.querySelectorAll('div, li, tr, span, p')]
        .filter(el => { const t = text(el); return t.length > 0 && t.length <= 160 && STATUS.test(t) && !ODDS.test(t); })
        .filter((el, _, all) => !all.some(other => other !== el && el.contains(other)))
        .map(text);

    // Settled entries on a history page: blocks that say won/lost/hit/miss.
    const RESULT = /\b(won|lost|win|loss|hit|miss(ed)?|push|void|cashed)\b|[✓✔✗✘]/i;
    out.results = [...document.body.querySelectorAll('div, li, tr, article')]
        .filter(el => { const t = text(el); return t.length > 0 && t.length <= 400 && RESULT.test(t) && LINE.test(t); })
        .filter((el, _, all) => !all.some(other => other !== el && el.contains(other)))
        .map(text);
    return out;
}

const BOOKS = ['fanduel', 'draftkings', 'betmgm', 'caesars', 'pinnacle', 'bet365', 'espn bet', 'espnbet', 'fanatics', 'betrivers',
    'hard rock', 'hardrock', 'bovada', 'betonline', 'circa', 'pointsbet', 'unibet', 'novig', 'prophetx', 'sporttrade',
    'prizepicks', 'underdog', 'sleeper', 'betr', 'dabble', 'parlayplay', 'chalkboard', 'fliff', 'consensus'];
const MARKETS = ['team total', 'game total', 'total points', 'pts+reb+ast', 'pts + reb + ast', 'pra', 'pts+reb', 'pts+ast', 'reb+ast', 'points', 'rebounds', 'assists', 'threes', '3-pointers made',
    '3pt made', 'three pointers', 'steals', 'blocks', 'blks+stls', 'turnovers', 'fantasy score', 'fantasy points', 'double double',
    'passing yards', 'pass yards', 'passing tds', 'pass tds', 'rushing yards', 'rush yards', 'receiving yards', 'rec yards', 'receptions',
    'rush+rec yards', 'pass attempts', 'completions', 'interceptions', 'longest reception', 'tackles', 'sacks',
    'strikeouts', 'pitcher strikeouts', 'hits allowed', 'earned runs', 'outs recorded', 'total bases', 'hits+runs+rbis', 'hits',
    'runs', 'rbis', 'home runs', 'walks', 'stolen bases', 'singles',
    'shots on goal', 'shots', 'saves', 'goals', 'goalie saves', 'blocked shots', 'power play points', 'aces', 'games won', 'kills'];
const LEAGUES = ['NBA', 'WNBA', 'NFL', 'MLB', 'NHL', 'NCAAF', 'NCAAB', 'CFB', 'CBB', 'EPL', 'MLS', 'UFC', 'PGA', 'ATP', 'WTA', 'LOL', 'CS2', 'VAL'];

const PRICE_RE = /(?:^|[\s(|/])([+\-−]\d{3,4})(?=$|[\s)|/])/g;
const LINE_RE = /\b(over|under|more|less|higher|lower|o|u)\s?(\d+(?:\.\d+)?)\b/i;
const RATE_RE = /\b(L5|L10|L15|L20|H2H|SZN|Season|20\d\d)\b\s*(?:hit\s*rate)?[:\s]*(\d{1,3}(?:\.\d+)?)\s?%|(\d{1,3}(?:\.\d+)?)\s?%\s*(L5|L10|L15|L20|H2H|SZN|Season)\b/gi;
const FRACTION_RE = /\b(L5|L10|L15|L20|H2H)\b[:\s]*(\d{1,2})\s?\/\s?(\d{1,2})\b/gi;

function toPrice(s) {
    const n = Number(String(s).replace('−', '-').replace('+', ''));
    return Number.isFinite(n) && Math.abs(n) >= 100 && Math.abs(n) <= 10000 ? n : null;
}

function sideOf(word) {
    const w = String(word || '').toLowerCase();
    if (['over', 'o', 'more', 'higher'].includes(w)) return 'over';
    if (['under', 'u', 'less', 'lower'].includes(w)) return 'under';
    return null;
}

function rateKey(label) {
    const l = String(label).toLowerCase();
    // "2026" is this season, "2025" last season (boards show both side by side).
    if (/^20\d\d$/.test(l)) return Number(l) >= new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0) ? 'season' : 'last';
    if (l === 'szn') return 'season';
    return l;
}

function findMarket(text) {
    const lower = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
    let best = null;
    for (const m of MARKETS) {
        const at = lower.indexOf(m);
        if (at < 0) continue;
        const before = lower[at - 1], after = lower[at + m.length];
        if (/[a-z]/.test(before || '') || /[a-z]/.test(after || '')) continue;
        if (!best || m.length > best.length) best = m;
    }
    return best ? best.replace(/\s*\+\s*/g, '+').replace(/\b\w/g, c => c.toUpperCase()) : null;
}

function findBook(text) {
    const lower = text.toLowerCase();
    return BOOKS.find(b => lower.includes(b)) || null;
}

function isNameLine(line) {
    const t = line.trim();
    if (!t || t.length > 40 || /\d/.test(t) || findMarket(t) || findBook(t)) return false;
    if (LEAGUES.includes(t.toUpperCase()) || /^(over|under|more|less|higher|lower|o|u|vs\.?|@)$/i.test(t)) return false;
    const words = t.split(/\s+/);
    return words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Z][A-Za-z.'\-]*$/.test(w) || /^(Jr\.?|Sr\.?|II|III|IV)$/.test(w));
}

// A line that is only a name, else the capitalized words a line starts with
// ("Jayson Tatum Points U 27.5").
function findPlayer(lines) {
    const whole = lines.find(isNameLine);
    if (whole) return whole;
    for (const line of lines) {
        const m = line.match(/^((?:[A-Z][A-Za-z.'\-]*\s+){1,4})/);
        if (!m) continue;
        const words = m[1].trim().split(/\s+/);
        while (words.length && (findMarket(words[words.length - 1]) || /^(over|under|more|less|higher|lower|o|u)$/i.test(words[words.length - 1]))) words.pop();
        if (words.length >= 2 && isNameLine(words.join(' '))) return words.join(' ');
    }
    return null;
}

function hitRates(text) {
    const rates = {};
    for (const m of text.matchAll(RATE_RE)) {
        const label = m[1] || m[4], value = m[2] || m[3];
        rates[rateKey(label)] = Number(value) / 100;
    }
    for (const m of text.matchAll(FRACTION_RE)) {
        if (Number(m[3])) rates[rateKey(m[1])] = Number(m[2]) / Number(m[3]);
    }
    return rates;
}

// "LAL @ DEN" names the game, not the player's side. The player's team is a
// line of its own that names one of the two ("DEN", "DEN - C", "(DEN)").
function matchup(text, lines) {
    const m = text.match(/\b([A-Z]{2,4})\s*(?:@|vs\.?|v\.?)\s*([A-Z]{2,4})\b/);
    if (!m) return {};
    const teams = [m[1], m[2]];
    const out = { teams, game: [...teams].sort().join('-') };
    for (const line of lines) {
        if (/@|\bvs?\.?\b/.test(line)) continue;
        const named = teams.filter(t => new RegExp(`(^|[\\s(\u00b7|-])${t}($|[\\s)\u00b7|-])`).test(line));
        if (named.length === 1 && line.length <= 16) {
            out.team = named[0];
            out.opponent = teams.find(t => t !== named[0]);
            break;
        }
    }
    return out;
}

// The game's total ("O/U 232.5", "Total: 47.5"), for pace.
function gameTotal(text) {
    const m = text.match(/\b(?:o\/u|game total|total)\s*:?\s*(\d{1,3}(?:\.\d+)?)\b/i);
    return m ? Number(m[1]) : null;
}

// "Recent: 27, 31, 22" / "Last 5: 27 31 22 19 30" -> numbers, most recent first.
function recentGames(text) {
    const m = text.match(/\b(?:last\s*\d+|recent|game\s*log|l\d+\s*games?)\s*[:\-]\s*((?:\d+(?:\.\d+)?[\s,|/]+){2,}\d+(?:\.\d+)?)/i);
    return m ? m[1].split(/[\s,|/]+/).map(Number).filter(Number.isFinite) : [];
}

// Matchup, role and volume numbers shown around a prop: defense rank vs the
// player's position ("DvP 28th", "Opp rank vs PG: 28/30"), usage ("USG% 31.2"),
// pace ("Pace 101.3"), potential volume ("Potential Assists 12.4", "Reb Chances
// 18.2") and minutes ("MIN 35.2", "Minutes: 36, 34, 35"). Missing ones are left out.
const POTENTIAL_STATS = { assists: /assists?|ast/, rebounds: /rebounds?|reb(?:ound)? chances|reb/, points: /points?|pts/, receptions: /targets|receptions?/ };
function insights(text) {
    const out = {};
    const num = v => (v == null ? null : Number(v));
    const dvp = text.match(/\b(?:dvp|def(?:ense)?\s*(?:vs\.?|v\.?)\s*(?:pos(?:ition)?|[A-Z]{1,2})|opp(?:onent)?\s*rank(?:\s*(?:vs\.?)\s*[A-Z]{1,2})?|matchup rank)(?:\s*vs\.?\s*[A-Z]{1,2})?\s*(?:rank)?\s*[:#]?\s*(\d{1,3})(?:st|nd|rd|th)?(?:\s*\/\s*(\d{1,3}))?/i);
    if (dvp) {
        out.defenseRank = num(dvp[1]);
        if (dvp[2]) out.defenseTeams = num(dvp[2]);
        const pos = text.match(/\bvs\.?\s*(PG|SG|SF|PF|C|G|F|QB|RB|WR|TE|LW|RW|D)\b/);
        if (pos) out.position = pos[1];
    }
    const usg = text.match(/\busg%?\s*(?:rate)?\s*[:=]?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i) || text.match(/(\d{1,2}(?:\.\d+)?)\s*%\s*usg\b/i)
        || text.match(/\busage(?:\s*rate)?\s*[:=]?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i);
    if (usg) out.usage = Math.round(num(usg[1]) * 10) / 1000;
    const pace = text.match(/\bpace\s*[:=]?\s*(\d{2,3}(?:\.\d+)?)/i);
    if (pace) out.pace = num(pace[1]);
    const potential = {};
    for (const m of text.matchAll(/\b(?:potential|pot\.?)\s+([a-z]+(?:\s+chances)?)\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)/gi)) {
        const stat = Object.keys(POTENTIAL_STATS).find(k => POTENTIAL_STATS[k].test(m[1].toLowerCase()));
        if (stat) potential[stat] = num(m[2]);
    }
    const chances = text.match(/\breb(?:ound)?\s*chances\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)/i);
    if (chances && potential.rebounds == null) potential.rebounds = num(chances[1]);
    if (Object.keys(potential).length) out.potential = potential;
    const minutesList = text.match(/\b(?:minutes|mins)\s*[:\-]\s*((?:\d{1,2}(?:\.\d+)?[\s,|/]+){2,}\d{1,2}(?:\.\d+)?)/i);
    if (minutesList) out.minutes = minutesList[1].split(/[\s,|/]+/).map(Number).filter(Number.isFinite);
    const minutesAvg = text.match(/\b(?:min|mins|minutes|mpg)\s*[:=]?\s*(\d{1,2}(?:\.\d+)?)\b(?!\s*[,|/]\s*\d)/i);
    if (minutesAvg && !minutesList) out.minutesAvg = num(minutesAvg[1]);
    // Share of the public's bets on this side ("78% of bets", "Public 78%").
    const pub = text.match(/(\d{1,3})\s*%\s*(?:of\s+)?(?:the\s+)?(?:public|bets|tickets|handle)\b/i) || text.match(/\bpublic(?:\s*(?:bets?|money|%))?\s*[:=]?\s*(\d{1,3})\s*%/i);
    if (pub && num(pub[1]) <= 100) out.publicPct = num(pub[1]) / 100;
    return out;
}

// Players ruled out, from an injury report line or a prop card ("Teammate out:
// Joel Embiid"). team: the card's team, for a teammate named without one.
const NAME = "([A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){1,3})";
const INJURY_RES = [
    new RegExp(`${NAME}\\s*(?:\\(([A-Z]{2,4})\\))?\\s*[-–:|]?\\s*\\(?(OUT|Out|Ruled Out|ruled out|Inactive|INACTIVE|Doubtful|Questionable|GTD|Probable|Returning|RETURNING)\\b`, 'g'),
    new RegExp(`\\b(?:teammates?\\s+)?(?:OUT|Out|out|Ruled out|ruled out|Inactive)\\s*[:\\-]\\s*${NAME}(?:\\s*\\(([A-Z]{2,4})\\))?`, 'g')
];
function injuries(raw, team = null) {
    const text = String(raw || '');
    const found = [];
    const usage = text.match(/\busg%?\s*[:=]?\s*(\d{1,2}(?:\.\d+)?)\s*%?/i);
    for (const [i, re] of INJURY_RES.entries()) {
        for (const m of text.matchAll(re)) {
            const player = m[1].replace(/^(?:Teammates?|Out|Injury|Status)\s+/i, '').trim();
            const status = i === 0 ? m[3].toLowerCase() : 'out';
            if (!/\s/.test(player) || /^(over|under|more|less)\b/i.test(player)) continue;
            const entry = { player, team: m[2] || (/teammate/i.test(text) ? team : null), status: status === 'ruled out' ? 'out' : status };
            if (usage && found.length === 0 && i === 0 && !LINE_RE.test(text)) entry.usage = Number(usage[1]) / 100;
            found.push(entry);
        }
    }
    return found;
}

function propId(p) {
    return [p.player, p.market, p.line, p.side].map(v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9.]+/g, '')).join('|');
}

// One prop card or board row, as text.
function parseText(raw, page = {}, { requireOdds = true } = {}) {
    const text = String(raw || '').replace(/−/g, '-');
    // innerText separates table cells with tabs.
    const lines = text.split(/[\n\t]+/).map(l => l.trim()).filter(Boolean);
    // "O/U 231.5" is the game's total, not this prop's line.
    const lineMatch = text.replace(/\b(?:o\/u|game total|total)\s*:?\s*\d{1,3}(?:\.\d+)?\b/gi, ' ').match(LINE_RE);
    if (!lineMatch) return null;
    const prop = {
        player: findPlayer(lines),
        // "Potential Assists 12.4" on a points card doesn't make it an assists prop.
        market: findMarket(text.replace(/\b(?:potential|pot\.?)\s+[a-z]+(?:\s+chances)?|\breb(?:ound)?\s*chances/gi, ' ')),
        line: Number(lineMatch[2]),
        side: sideOf(lineMatch[1]),
        league: LEAGUES.find(l => new RegExp(`\\b${l}\\b`).test(text)) || null,
        ...matchup(text, lines),
        gameTotal: gameTotal(text),
        odds: [],
        hitRates: hitRates(text),
        recent: recentGames(text),
        source: page.url || null
    };
    const found = insights(text);
    if (Object.keys(found).length) prop.insights = found;
    const out = injuries(text, prop.team);
    // "Teammate out" on a card whose team isn't shown: the out player is this player's teammate.
    if (out.length) prop.injuries = out.map(o => (!o.team && /teammate/i.test(text) ? { ...o, teammateOf: prop.player } : o));
    // Prices: a line naming a book is that book's; "consensus"/"market" is the consensus.
    for (const l of lines) {
        const prices = [...l.matchAll(PRICE_RE)].map(m => toPrice(m[1])).filter(v => v !== null);
        if (!prices.length) continue;
        const book = findBook(l);
        if (book === 'consensus' || /\b(consensus|market|avg|average|fair)\b/i.test(l)) prop.consensus = prices[0];
        else prices.forEach(price => prop.odds.push({ book: book || null, price }));
    }
    // Without a player it can't go on an entry (one leg per player).
    if (!prop.player || (requireOdds && !prop.odds.length && prop.consensus == null)) return null;
    if (!prop.side) prop.side = 'over';
    prop.id = propId(prop);
    return prop;
}

const COLUMN_RULES = [
    ['player', /^(player|name|athlete)$/i],
    ['market', /^(prop|market|stat|type|category)$/i],
    ['line', /^(line|o\/u|total|projection|proj)$/i],
    ['side', /^(side|pick|direction|play)$/i],
    ['consensus', /^(odds|price|consensus|juice|market odds|avg odds|fair odds)$/i],
    ['l5', /^(l5|last 5)$/i], ['l10', /^(l10|last 10)$/i], ['l20', /^(l20|last 20)$/i],
    ['h2h', /^h2h$/i], ['season', /^(szn|season|20\d\d)$/i],
    ['team', /^team$/i], ['opponent', /^(opp|opponent|vs)$/i], ['game', /^(game|matchup|event)$/i],
    ['league', /^(league|sport)$/i],
    ['usage', /^(usg%?|usage( rate)?)$/i], ['pace', /^pace$/i],
    ['defenseRank', /^(dvp|def(ense)? vs\.? pos(ition)?|opp(onent)? rank|matchup rank|def rank)$/i],
    ['minutes', /^(min|mins|minutes|mpg)$/i], ['potential', /^(potential|pot\.?)\s+\w+/i]
];

function parseTable(table, page = {}) {
    const cols = table.headers.map(h => {
        const name = String(h || '').trim();
        const rule = COLUMN_RULES.find(([, re]) => re.test(name));
        if (rule) return { field: rule[0] };
        const book = findBook(name);
        return book ? { field: 'book', book } : { field: null };
    });
    if (!cols.some(c => c.field === 'player')) return [];
    const props = [];
    for (const cells of table.rows) {
        const prop = { odds: [], hitRates: {}, recent: [], source: page.url || null };
        let rowText = '';
        cells.forEach((cell, i) => {
            const col = cols[i] || {};
            const value = String(cell || '').replace(/−/g, '-').trim();
            rowText += ` ${value}`;
            if (!value) return;
            if (col.field === 'book') {
                const price = [...value.matchAll(PRICE_RE)].map(m => toPrice(m[1])).find(v => v !== null);
                if (price != null) prop.odds.push({ book: col.book, price });
            } else if (col.field === 'consensus') {
                prop.consensus = [...value.matchAll(PRICE_RE)].map(m => toPrice(m[1])).find(v => v !== null) ?? toPrice(value);
            } else if (['l5', 'l10', 'l20', 'h2h', 'season'].includes(col.field)) {
                const frac = value.match(/(\d+)\s*\/\s*(\d+)/);
                const pct = value.match(/(\d{1,3}(?:\.\d+)?)\s?%?/);
                const v = frac && Number(frac[2]) ? Number(frac[1]) / Number(frac[2]) : pct ? Number(pct[1]) / 100 : null;
                if (v != null) prop.hitRates[col.field] = v;
            } else if (col.field === 'line') {
                const m = value.match(LINE_RE) || value.match(/(\d+(?:\.\d+)?)/);
                if (m) {
                    prop.line = Number(m[2] || m[1]);
                    if (m[2]) prop.side = sideOf(m[1]);
                }
            } else if (['usage', 'pace', 'defenseRank', 'minutes', 'potential'].includes(col.field)) {
                const n = Number((value.match(/\d+(?:\.\d+)?/) || [])[0]);
                if (!Number.isFinite(n)) return;
                prop.insights = prop.insights || {};
                if (col.field === 'usage') prop.insights.usage = n > 1 ? Math.round(n * 10) / 1000 : n;
                else if (col.field === 'minutes') prop.insights.minutesAvg = n;
                else if (col.field === 'potential') {
                    const stat = Object.keys(POTENTIAL_STATS).find(k => POTENTIAL_STATS[k].test(String(table.headers[i]).toLowerCase().replace(/^(potential|pot\.?)\s+/, '')));
                    if (stat) prop.insights.potential = { ...(prop.insights.potential || {}), [stat]: n };
                } else prop.insights[col.field] = n;
            } else if (col.field === 'side') {
                prop.side = sideOf(value.split(/\s+/)[0]) || prop.side;
            } else if (col.field) {
                prop[col.field] = value;
            }
        });
        if (!prop.player || prop.line == null || (!prop.odds.length && prop.consensus == null)) continue;
        prop.market = findMarket(prop.market || rowText) || prop.market || null;
        prop.side = prop.side || 'over';
        if (prop.team && prop.opponent && !prop.game) prop.game = [prop.team, prop.opponent].sort().join('-');
        prop.id = propId(prop);
        props.push(prop);
    }
    return props;
}

function parseConfigured(item, page = {}) {
    const join = v => (Array.isArray(v) ? v.join('\n') : v || '');
    const prop = parseText([join(item.player), join(item.market), join(item.line), join(item.odds), join(item.hitRates), item.text].join('\n'), page);
    if (!prop) return null;
    if (item.player) prop.player = String(Array.isArray(item.player) ? item.player[0] : item.player).trim();
    if (item.market) prop.market = findMarket(join(item.market)) || join(item.market).trim();
    prop.id = propId(prop);
    return prop;
}

function parseResult(raw) {
    const text = String(raw || '');
    const prop = parseText(text, {}, { requireOdds: false }) || {};
    const m = text.match(/\b(won|win|hit|cashed|lost|loss|miss(?:ed)?|push|void)\b|([✓✔])|([✗✘])/i);
    if (!m || !prop.line) return null;
    const word = (m[1] || '').toLowerCase();
    const result = m[2] || ['won', 'win', 'hit', 'cashed'].includes(word) ? 'hit' : m[3] || ['lost', 'loss', 'miss', 'missed'].includes(word) ? 'miss' : 'push';
    return { player: prop.player, market: prop.market, line: prop.line, side: prop.side, result, text: text.slice(0, 200) };
}

// pages: [{ kind, url, collected }] -> { props, results, pages }
function parseCollected(pages) {
    const byId = new Map();
    const results = [];
    const add = prop => {
        if (!prop || !prop.id) return;
        const seen = byId.get(prop.id);
        if (!seen) return byId.set(prop.id, prop);
        // The same prop on two boards: keep every book's price once, fill gaps.
        // A price with no book is skipped when a named book already has it.
        for (const o of prop.odds) {
            if (seen.odds.some(s => s.price === o.price && (s.book === o.book || !o.book))) continue;
            seen.odds = seen.odds.filter(s => !(s.book == null && o.book && s.price === o.price));
            seen.odds.push(o);
        }
        for (const [k, v] of Object.entries(prop)) if (seen[k] == null || (Array.isArray(seen[k]) && !seen[k].length)) seen[k] = v;
        seen.hitRates = { ...prop.hitRates, ...seen.hitRates };
    };
    const summary = [];
    const ruledOut = new Map();
    const addInjury = entry => {
        const key = entry.player.toLowerCase();
        ruledOut.set(key, { ...ruledOut.get(key), ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null)) });
    };
    for (const page of pages) {
        const c = page.collected || {};
        const before = byId.size;
        (c.configured || []).forEach(item => add(parseConfigured(item, c)));
        (c.tables || []).forEach(table => parseTable(table, c).forEach(add));
        (c.cards || []).forEach(card => add(parseText(card, c)));
        (c.injuries || []).forEach(t => injuries(t).forEach(addInjury));
        if (page.kind === 'history' || page.kind === 'slips') (c.results || []).map(parseResult).filter(Boolean).forEach(r => results.push(r));
        summary.push({ kind: page.kind, url: c.url || page.url, title: c.title || '', props: byId.size - before,
            tables: (c.tables || []).length, cards: (c.cards || []).length });
    }
    for (const prop of byId.values()) {
        (prop.injuries || []).forEach(addInjury);
        delete prop.injuries;
    }
    // A player with a prop on the board is playing, unless a report says otherwise.
    return { props: [...byId.values()], results, pages: summary, injuries: [...ruledOut.values()] };
}

module.exports = { insights, injuries, collectPage, parseCollected, parseText, parseTable, parseResult, propId, findMarket };
