// Moves around Outlier from a prompt: picks the sport tab ("NBA"), a stat filter
// ("Points") and the game by its start time or teams ("the 3pm game", "Lakers"),
// so the scan reads that game's board. It only clicks tabs, filters and game
// cards: anything that looks like a pick (a prop card with a line and odds, a
// More/Less or Over/Under button) or an entry (Submit, Place, Add to slip) is
// never a click target.
const { teamsNamed, teamTokens } = require('./teams');

// Sport words -> the labels a sports app shows for them.
const SPORTS = {
    nba: ['NBA', 'Basketball'], wnba: ['WNBA'], nfl: ['NFL', 'Football'], mlb: ['MLB', 'Baseball'], nhl: ['NHL', 'Hockey'],
    ncaab: ['NCAAB', 'CBB', 'College Basketball', 'NCAAM'], cbb: ['CBB', 'NCAAB', 'College Basketball'],
    ncaaf: ['NCAAF', 'CFB', 'College Football'], cfb: ['CFB', 'NCAAF', 'College Football'],
    soccer: ['Soccer', 'MLS', 'EPL'], mls: ['MLS'], epl: ['EPL', 'Premier League'], tennis: ['Tennis'], golf: ['Golf', 'PGA'],
    pga: ['PGA', 'Golf'], mma: ['MMA', 'UFC'], ufc: ['UFC', 'MMA'], esports: ['Esports', 'eSports'], lol: ['LoL', 'League of Legends'],
    cs: ['CS2', 'CS', 'Counter-Strike'], cs2: ['CS2', 'CS', 'Counter-Strike'], nascar: ['NASCAR']
};
// Outlier opens on Insights/Trends, or on the last tool used (often +EV); its
// regular player props board is "Props" (the Prop Finder). The other names are
// fallbacks. Tried first whenever a sport or game is asked for.
const PROPS_SECTIONS = ['Props', 'Prop Finder', 'Player Props', 'Prop Search', 'Prop Research', 'All Props'];

const sportLabels = sport => {
    const text = String(sport || '').trim();
    if (!text) return [];
    const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    return [...new Set([text, ...(SPORTS[key] || [])])];
};

// Stat names a leg might use -> the words a board shows for them.
const STATS = {
    points: ['points', 'pts'], rebounds: ['rebounds', 'reb', 'rebs'], assists: ['assists', 'ast', 'asts'],
    pra: ['pts reb ast', 'pra', 'points rebounds assists', 'pts rebs asts'], 'pts reb': ['pts reb', 'points rebounds', 'pr'],
    'pts ast': ['pts ast', 'points assists', 'pa'], 'reb ast': ['reb ast', 'rebounds assists', 'ra'],
    threes: ['3 pointers made', 'threes', '3pm', '3pt made', 'three pointers made', '3 pt made', '3 pointers', 'made threes'],
    steals: ['steals', 'stl'], blocks: ['blocks', 'blk'], 'stl blk': ['stl blk', 'steals blocks', 'blocks steals', 'blk stl', 'blks stls', 'stocks'], turnovers: ['turnovers', 'to'],
    'fg attempted': ['fg attempted', 'fga', 'field goals attempted', 'fg attempts', 'field goal attempts', 'fg att'],
    'fg made': ['fg made', 'fgm', 'field goals made'], 'free throws made': ['free throws made', 'ftm'],
    '3pt attempted': ['3pt attempted', '3pa', '3 pointers attempted', 'three pointers attempted'],
    fantasy: ['fantasy points', 'fantasy score', 'fantasy'], 'double double': ['double double'],
    'passing yards': ['passing yards', 'pass yds', 'pass yards', 'passing yds'], 'rushing yards': ['rushing yards', 'rush yds', 'rush yards', 'rushing yds'],
    'receiving yards': ['receiving yards', 'rec yds', 'rec yards', 'receiving yds'],
    'rush rec yards': ['rush rec yards', 'rush rec yds', 'rushing receiving yards', 'rushing and receiving yards', 'rush and rec yds'],
    'pass rush yards': ['pass rush yards', 'pass rush yds', 'passing rushing yards', 'passing and rushing yards'],
    'rush attempts': ['rush attempts', 'rushing attempts', 'carries', 'rush att'], 'pass attempts': ['pass attempts', 'passing attempts', 'pass att'],
    completions: ['completions', 'pass completions', 'passing completions'], 'passing tds': ['passing tds', 'passing touchdowns', 'pass tds', 'pass td'],
    interceptions: ['interceptions', 'interceptions thrown', 'ints'], sacks: ['sacks'], 'tackles assists': ['tackles assists', 'tackles and assists', 'tackles ast'],
    'longest reception': ['longest reception', 'long reception'], 'longest rush': ['longest rush', 'long rush'],
    receptions: ['receptions', 'rec'], strikeouts: ['strikeouts', 'ks', 'pitcher strikeouts'], 'total bases': ['total bases', 'tb'],
    hits: ['hits'], 'shots on goal': ['shots on goal', 'sog', 'shots']
};
const normWords = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// A player's name as apps write it differently: "A.J. Brown" and "AJ Brown",
// "Marvin Harrison Jr." and "Marvin Harrison", "Luka Dončić" and "Luka Doncic".
const nameKey = t => normWords(t).replace(/\b([a-z]) (?=[a-z]\b)/g, '$1').replace(/ (jr|sr|ii|iii|iv|v)$/, '').trim();
const sameName = (a, b) => {
    const x = nameKey(a), y = nameKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    // "C. Lamb" for "CeeDee Lamb": a lone first initial and the same last name.
    const [xf, ...xl] = x.split(' '), [yf, ...yl] = y.split(' ');
    return xl.length > 0 && xl.join(' ') === yl.join(' ') && (xf.length === 1 || yf.length === 1) && xf[0] === yf[0];
};
// "Pts+Rebs+Asts" -> every way a board might write it.
// A quarter, half, period or first innings of a market ("1st Quarter Receiving
// Yards", "1H Rush Yds"), by its usual names; null for the full game.
const PERIODS = {
    q1: ['1st quarter', 'first quarter', '1q', 'q1', '1st qtr', '1qtr'], q2: ['2nd quarter', 'second quarter', '2q', 'q2', '2nd qtr', '2qtr'],
    q3: ['3rd quarter', 'third quarter', '3q', 'q3', '3rd qtr', '3qtr'], q4: ['4th quarter', 'fourth quarter', '4q', 'q4', '4th qtr', '4qtr'],
    h1: ['1st half', 'first half', '1h', 'h1', '1st 1 2'], h2: ['2nd half', 'second half', '2h', 'h2', '2nd 1 2'],
    p1: ['1st period', 'first period', 'p1'], p2: ['2nd period', 'second period', 'p2'], p3: ['3rd period', 'third period', 'p3'],
    f5: ['first 5 innings', '1st 5 innings', 'first five innings', 'f5'], f3: ['first 3 innings', '1st 3 innings', 'f3']
};
const PERIOD = /\b(1st|2nd|3rd|4th|first|second|third|fourth) (quarter|half|period|inning|innings|5|3 minutes)\b|\b(1q|2q|3q|4q|1h|2h|q1|q2|q3|q4|h1|h2|f5)\b|\bquarter\b|\bhalf\b/;
function periodOf(text) {
    const t = ` ${normWords(text)} `;
    const hit = Object.entries(PERIODS).find(([, names]) => names.some(n => t.includes(` ${n} `)));
    return hit ? hit[0] : PERIOD.test(t) ? 'other' : null;
}
// The market without its period: "1st Quarter Receiving Yards" -> "receiving yards".
function withoutPeriod(text) {
    let t = ` ${normWords(text)} `;
    for (const n of Object.values(PERIODS).flat().sort((a, b) => b.length - a.length)) t = t.split(` ${n} `).join(' ');
    return t.replace(/\b(quarter|half|period|qtr)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// A stat's words, without its period (the period is matched on its own).
function statWords(stat) {
    const key = withoutPeriod(stat);
    if (!key) return [];
    const entry = Object.entries(STATS).find(([name, words]) => name === key || words.includes(key));
    return entry ? [...new Set([entry[0], ...entry[1]])] : [key];
}

// The names of the stat's own period, which its card must show (none for the full game).
const periodWords = stat => PERIODS[periodOf(stat)] || [];

// The words of the markets that hold this stat's words but aren't it (other periods,
// combos, fantasy), for telling a card apart in the page.
function avoidWords(stat) {
    const words = statWords(stat);
    if (!words.length) return [];
    const mine = new Set(words.flatMap(w => w.split(' ')));
    const other = Object.values(STATS).flat().filter(o => o.length >= 3 && !words.includes(o) && o.split(' ').some(t => !mine.has(t)) && o.split(' ').some(t => mine.has(t)));
    const own = periodOf(stat);
    const period = Object.entries(PERIODS).filter(([k]) => k !== own).flatMap(([, names]) => names).concat(own ? [] : ['quarter', 'half']);
    return [...new Set([...other, ...period])];
}

// A board market is this leg's stat for the same part of the game: its words are
// there, its quarter or half is the leg's ("1st Quarter Receiving Yards" for a 1Q
// leg, none for a full-game one), and it isn't a combo or another stat that holds
// them ("Pts+Rebs+Asts", "Fantasy Points") unless the leg is that combo.
function sameMarket(market, stat) {
    const words = statWords(stat);
    if (!words.length) return true;
    if (periodOf(market) !== periodOf(stat)) return false;
    const m = ` ${withoutPeriod(market)} `;
    if (!words.some(w => m.includes(` ${w} `))) return false;
    const mine = new Set(words.flatMap(w => w.split(' ')));
    for (const [, others] of Object.entries(STATS)) {
        for (const o of others) {
            if (o.length < 3 || words.includes(o)) continue;
            if (m.includes(` ${o} `) && o.split(' ').some(t => !mine.has(t))) return false;
        }
    }
    return true;
}

// "tomorrow", "today", "Monday" -> the labels a date picker shows for that day.
function dayLabels(day, now = new Date()) {
    const text = String(day || '').toLowerCase();
    const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    let date = null;
    const extra = [];
    if (/\btomorrow\b/.test(text)) { date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); extra.push('Tomorrow'); }
    else if (/\b(today|tonight)\b/.test(text)) { date = new Date(now.getFullYear(), now.getMonth(), now.getDate()); extra.push('Today'); }
    else {
        const named = DAYS.findIndex(d => new RegExp(`\\b${d}\\b`).test(text));
        if (named >= 0) date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((named - now.getDay() + 7) % 7));
    }
    if (!date) return [];
    const weekday = DAYS[date.getDay()][0].toUpperCase() + DAYS[date.getDay()].slice(1);
    const month = MONTHS[date.getMonth()];
    const d = date.getDate();
    const md = `${date.getMonth() + 1}/${d}`;
    return [...extra, weekday, weekday.slice(0, 3), `${month.slice(0, 3)} ${d}`, `${month} ${d}`, md, `${weekday.slice(0, 3)} ${md}`,
        `${weekday.slice(0, 3)}, ${month.slice(0, 3)} ${d}`, `${weekday}, ${month} ${d}`, `${weekday.slice(0, 3)} ${month.slice(0, 3)} ${d}`];
}

// "3pm", "3 p.m.", "8:30 PM", "3 o'clock", "20:00", "7:30p" -> minutes after
// midnight, or null. Without am/pm, 1 to 11 o'clock means afternoon or evening,
// when games are on.
function parseTime(input) {
    const m = String(input || '').toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m?\.?|p\.?m?\.?|o'?\s?clock)?(?![\d:])/);
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = Number(m[2] || 0);
    if (hour > 23 || minute > 59) return null;
    const suffix = (m[3] || '').replace(/[.\s]/g, '');
    if (!m[2] && !suffix) return null;   // a bare number isn't a time
    if (suffix.startsWith('p') && hour < 12) hour += 12;
    else if (suffix.startsWith('a') && hour === 12) hour = 0;
    else if (!suffix.startsWith('a') && !suffix.startsWith('p') && hour >= 1 && hour <= 11) hour += 12;
    return hour * 60 + minute;
}

const clock = minutes => {
    const h = Math.floor(minutes / 60);
    return `${h % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// "LAL @ BOS", "LAL vs. BOS", "Lakers at Celtics" in a game card -> the two teams.
function gameTeams(text) {
    const m = String(text || '').match(/\b([A-Z]{2,4})\s*(?:@|vs\.?|v\.?|at)\s*([A-Z]{2,4})\b/);
    return m ? [m[1], m[2]] : null;
}

// Runs inside the page: scrolls the window and any scrolling panel down a
// screen. False when nothing moved (the end). The board's scrolling panel is
// found once and marked (data-codev-scroller), so a step doesn't check every
// element on a page of thousands; with a card open, its own panel is looked for.
const scrollStep = () => {
    const before = window.scrollY;
    window.scrollBy(0, window.innerHeight * 0.9);
    let any = window.scrollY !== before;
    const scrolls = el => el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    let panels = dialog ? [] : [...document.querySelectorAll('[data-codev-scroller]')].filter(scrolls);
    if (!panels.length) {
        panels = [...document.querySelectorAll('*')].filter(scrolls);
        if (!dialog) panels.forEach(el => el.setAttribute('data-codev-scroller', '1'));
    }
    for (const el of panels) {
        const top = el.scrollTop;
        el.scrollTop += el.clientHeight * 0.9;
        if (el.scrollTop !== top) any = true;
    }
    return any;
};

// Runs inside the page: where the board is scrolled to (the window and each marked
// panel), so a row seen there can be found again by jumping straight back.
const scrollPlace = () => ({ y: window.scrollY, tops: [...document.querySelectorAll('[data-codev-scroller]')].map(el => el.scrollTop) });

// Runs inside the page: back to a place scrollPlace noted, back screens above it.
const scrollToPlace = ([place, back]) => {
    window.scrollTo(0, Math.max(0, place.y - back * window.innerHeight * 0.9));
    [...document.querySelectorAll('[data-codev-scroller]')].forEach((el, i) => {
        if (place.tops[i] != null) el.scrollTop = Math.max(0, place.tops[i] - back * el.clientHeight * 0.9);
    });
};

// After a scroll: waits until the new rows have been drawn (the page stops changing
// for a moment), at most maxMs, instead of a fixed pause every step.
async function settleAfterScroll(page, maxMs = 600) {
    await page.evaluate(max => new Promise(resolve => {
        let quiet = null;
        const done = () => { observer.disconnect(); clearTimeout(quiet); resolve(); };
        const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 120); });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        quiet = setTimeout(done, 250);
        setTimeout(done, max);
    }), maxMs).catch(() => {});
}

// The board place (from a board read's places) where the player's row showed, or null.
function placeOf(places, player) {
    const name = normWords(player);
    if (!name) return null;
    const hit = (places || []).find(p => ` ${normWords(p.text)} `.includes(` ${name} `));
    return hit ? hit.place : null;
}

// Runs inside the page: marks the best clickable element whose own label is one of
// labels (a tab, chip or menu item, not a block of text that mentions it) with
// data-codev-nav and returns its label, or null.
function markByLabel(labels) {
    document.querySelectorAll('[data-codev-nav]').forEach(el => el.removeAttribute('data-codev-nav'));
    const wanted = labels.map(l => l.toLowerCase());
    const NEVER = /\b(submit|place|enter|confirm|deposit|withdraw|add to|remove|delete|more|less|over|under|higher|lower)\b/i;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const clickable = el => el.matches('a, button, [role="tab"], [role="button"], [role="link"], [role="menuitem"], [role="option"], label, [onclick]')
        || getComputedStyle(el).cursor === 'pointer';
    let best = null;
    for (const el of document.querySelectorAll('a, button, [role], li, span, div, label, p, [aria-label], [title]')) {
        // Icon-only tabs are named by aria-label or title.
        const text = ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 40 || !visible(el)) continue;
        // "NBA", "NBA 42" (a count of props) or "🏀 NBA".
        const whole = text.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
        const label = whole.replace(/\s*\(?\d+\)?$/, '').trim();
        // "Oct 27" is a date tab, not "Oct" with a count.
        const rank = wanted.includes(whole) ? wanted.indexOf(whole) : wanted.indexOf(label);
        if (rank < 0 || NEVER.test(text)) continue;
        let target = el;
        for (let up = el, i = 0; up && i < 4; up = up.parentElement, i++) if (clickable(up)) { target = up; break; }
        const score = rank * 10 + (clickable(target) ? 0 : 5) + (target.getAttribute('aria-selected') === 'true' ? -1 : 0);
        if (!best || score < best.score || (score === best.score && text.length < best.text.length)) best = { target, text, score };
    }
    if (!best) return null;
    best.target.setAttribute('data-codev-nav', '1');
    return best.text;
}

// Runs inside the page: every game card that shows a start time, marked with
// data-codev-game="i". A card is the largest box around the time that still holds
// only one time; prop cards (a line and odds) and pick buttons are left out, except
// on the Games tab (withOdds), where every game card shows its spread and odds.
function listGames(withOdds = false) {
    document.querySelectorAll('[data-codev-game]').forEach(el => el.removeAttribute('data-codev-game'));
    const TIME = /\b\d{1,2}(?::\d{2})\s*(?:[ap]\.?m?\.?)?(?![\d:])|\b\d{1,2}\s*[ap]\.?m\.?(?![a-z])/i;
    const ODDS = /(^|[\s(])[+\-−]\d{3,4}(?=$|[\s)])/;
    const LINE = /\b(o|u|over|under|more|less|higher|lower)\s?\d+(\.\d+)?\b|\b\d+\.5\b/i;
    const NEVER = /\b(submit|place entry|add to|deposit|withdraw)\b/i;
    const text = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clickable = el => el.matches('a, button, [role="button"], [role="link"], [role="tab"], [onclick]') || getComputedStyle(el).cursor === 'pointer';
    const times = t => (t.match(new RegExp(TIME.source, 'gi')) || []);
    const games = [];
    const seen = new Set();
    for (const leaf of document.querySelectorAll('body *')) {
        if (leaf.children.length || !visible(leaf)) continue;
        const own = text(leaf);
        if (own.length > 40 || !TIME.test(own)) continue;
        let card = leaf;
        for (let up = leaf.parentElement; up && up !== document.body; up = up.parentElement) {
            const t = text(up);
            if (t.length > 300 || new Set(times(t).map(s => s.toLowerCase())).size > 1) break;
            card = up;
        }
        const cardText = text(card);
        if (seen.has(card) || (!withOdds && ODDS.test(cardText) && LINE.test(cardText)) || NEVER.test(cardText)) continue;
        seen.add(card);
        let target = leaf;
        for (let up = leaf; up && up !== card.parentElement; up = up.parentElement) if (clickable(up)) { target = up; break; }
        target.setAttribute('data-codev-game', String(games.length));
        games.push({ index: games.length, time: times(own)[0] || own, text: cardText });
    }
    return games;
}

// game: "3pm", "8:30 PM", "Lakers", "LAL vs BOS", "Lakers 8pm". Picks the card
// with that start time and, when teams are named, those teams.
function pickGame(games, game, sport) {
    const want = parseTime(game);
    const words = String(game || '').toLowerCase()
        .replace(/\b\d{1,2}(:\d{2})?\s*(a\.?m?\.?|p\.?m?\.?|o'?\s?clock)?/g, ' ')
        .split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !['the', 'game', 'at', 'vs', 'and', 'tonight', 'today', 'tomorrow', 'props', 'pm', 'am', 'nba', 'nfl', 'mlb', 'nhl', 'wnba',
            'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'on', 'for'].includes(w));
    const scored = games.map(g => {
        const at = parseTime(g.time);
        const text = g.text.toLowerCase();
        const timeOk = want == null || at === want;
        const { league, teams: named } = teamsNamed(game, sport);
        const hits = words.filter(w => text.includes(w)).length
            + named.filter(abbr => teamTokens(abbr, league).some(t => new RegExp(`(^|[^a-z0-9])${t.toLowerCase()}($|[^a-z0-9])`).test(text))).length;
        return { ...g, at, ok: timeOk && (words.length === 0 || hits > 0), hits };
    }).filter(g => g.ok);
    scored.sort((a, b) => b.hits - a.hits);
    return scored[0] || null;
}

// Runs inside the page: the short labels of what can be clicked (tabs, links,
// buttons, dropdown options), so an error can say what Outlier does show.
function listLabels() {
    const out = new Set();
    for (const el of document.querySelectorAll('a, button, [role="tab"], [role="button"], [role="link"], [role="menuitem"], option')) {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text.length <= 30) out.add(text);
        if (out.size >= 60) break;
    }
    return [...out];
}

// Runs inside the page: picks the dropdown option named one of labels (a league
// or stat picker), or returns null.
function chooseOption(labels) {
    const wanted = labels.map(l => l.toLowerCase());
    for (const select of document.querySelectorAll('select')) {
        const option = [...select.options].find(o => wanted.includes(o.text.trim().toLowerCase()));
        if (!option) continue;
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return option.text.trim();
    }
    return null;
}

// Runs inside the page: closes popups and banners that cover the page (a promo,
// a tour, a cookie notice) by their close button. Only buttons that close: never
// one that accepts, continues or starts anything.
function dismissOverlays() {
    const CLOSE = /^(×|✕|✖|x|close|dismiss|not now|no thanks|maybe later|got it|skip|skip tour)$/i;
    // A dialog or a fixed banner, but never the bet slip or My Picks, where × removes a pick.
    const SLIP = /\b(slip|my picks|parlay|wager|stake|entry|entries|to win|payout)\b/i;
    const covering = el => {
        for (let up = el; up && up !== document.body; up = up.parentElement) {
            const style = getComputedStyle(up);
            if (up.matches('[role="dialog"], [aria-modal="true"], [role="alertdialog"]') || style.position === 'fixed' || style.position === 'sticky') {
                return !SLIP.test(up.innerText || '');
            }
        }
        return false;
    };
    let closed = 0;
    for (const el of document.querySelectorAll('button, [role="button"], a, [aria-label]')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const name = ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        if (!CLOSE.test(name) || !covering(el)) continue;
        el.click();
        closed++;
    }
    return closed;
}

// Runs inside the page: marks a link to the regular props board (an address with
// "prop" in it, never one of the /pro/ tools like +EV) with data-codev-nav.
function markPropsLink() {
    document.querySelectorAll('[data-codev-nav]').forEach(el => el.removeAttribute('data-codev-nav'));
    let best = null;
    for (const a of document.querySelectorAll('a[href]')) {
        let url;
        try { url = new URL(a.href, location.href); } catch { continue; }
        if (url.origin !== location.origin || !/prop/i.test(url.pathname) || /^\/pro(\/|$)/i.test(url.pathname)) continue;
        if (!best || url.pathname.length < best.path.length) best = { a, path: url.pathname };
    }
    if (!best) return null;
    best.a.setAttribute('data-codev-nav', '1');
    return best.path;
}

// Outlier's tools live under /pro/ (/pro/ev is Positive EV) and it reopens the last
// one used, where the regular menu isn't shown.
const onTools = page => { try { return /^\/pro(\/|$)/i.test(new URL(page.url()).pathname); } catch { return false; } };
// Addresses tried for the props board when no tab or link leads there.
const PROPS_PATHS = ['/props', '/prop-finder', '/player-props', '/'];
// Outlier's own address for a sport's Props board: app.outlier.bet/NBA/props.
const sportCode = sport => sportLabels(sport).find(l => /^[A-Z0-9]{2,6}$/.test(l)) || null;
const sportPropsPath = sport => (sportCode(sport) ? `/${sportCode(sport)}/props` : null);

// Clicks what's marked; when a popup is in the way, closes it and tries again,
// then clicks the element itself.
async function clickPast(page, selector) {
    try { return await page.click(selector, { timeout: 5000 }); } catch { /* covered: close what covers it */ }
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(dismissOverlays).catch(() => 0);
    await page.waitForTimeout(300);
    try { return await page.click(selector, { timeout: 3000 }); } catch { /* still covered */ }
    const clicked = await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.click(); return Boolean(el); }, selector);
    if (!clicked) throw new Error(`The element to click (${selector}) is gone.`);
}

// Clicks through Outlier on page: the props board, sport, then market, then game. Scrolls to find
// a game further down. Returns { steps, game, teams } or throws with what it saw.
// player: a player's card is opened next (openPlayer), so the props board is wanted.
// day: "tomorrow", "Monday": its date tab is clicked when the board has one.
// onProps(url): called with the props board's address once it's reached, so the
// next visit starts there instead of on +EV.
async function navigate(page, { section, sport, market, game, player, day } = {}, { settleMs = 1500, onProps = null } = {}) {
    const steps = [];
    const settle = async () => {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(settleMs);
    };
    // optional: carry on when it isn't there instead of failing.
    const clickLabel = async (labels, what, { optional = false } = {}) => {
        const found = await page.evaluate(markByLabel, labels);
        if (found) {
            await clickPast(page, '[data-codev-nav="1"]');
        } else {
            const chosen = await page.evaluate(chooseOption, labels);
            if (!chosen) {
                if (optional) return;
                const shown = await page.evaluate(listLabels).catch(() => []);
                throw new Error(`Couldn't find ${what} on Outlier (looked for ${labels.join(', ')}) on ${page.url()}. `
                    + (shown.length ? `Tabs, links and buttons on that page: ${shown.join(' | ')}. ` : '')
                    + 'Ask the user which of these is the one, then call outlier_scan_board again with it.');
            }
            steps.push(chosen);
            return settle();
        }
        steps.push(found);
        await settle();
    };
    // Popups first: they cover the tabs.
    await page.keyboard.press('Escape').catch(() => {});
    if (await page.evaluate(dismissOverlays).catch(() => 0)) await page.waitForTimeout(300);
    // Off the Positive EV tool and onto the regular props board: its tab, else a
    // link to it, else its address (from +EV, where the menu isn't shown).
    const toProps = async () => {
        // Already on it (the remembered board, /NBA/props): clicking Props would reload it.
        if (!onTools(page) && /prop/i.test(new URL(page.url()).pathname)) { steps.push('Props'); return true; }
        const before = steps.length;
        await clickLabel(PROPS_SECTIONS, 'the props board', { optional: true });
        if (steps.length > before) {
            if (!onTools(page)) return true;
            steps.pop();
        }
        if (await page.evaluate(markPropsLink)) {
            await clickPast(page, '[data-codev-nav="1"]');
            await settle();
            if (!onTools(page)) { steps.push('Props'); return true; }
        }
        return false;
    };
    // "Props", "Prop Finder", "Player Props" asked as a section is the props board.
    if (section && /\bprops?\b|prop finder/i.test(String(section))) section = null;
    // On +EV (/pro/ev) with a sport: straight to that sport's board by its address.
    const direct = sport && sportPropsPath(sport);
    if (!section && direct && onTools(page)) {
        await page.goto(new URL(page.url()).origin + direct, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await settle();
        await page.evaluate(dismissOverlays).catch(() => 0);
    }
    if (section) await clickLabel([String(section).trim()], `a "${section}" tab`);
    else if ((sport || game || player) && await toProps()) {
        if (onProps) onProps(page.url());
    } else if (sport || game || player) {
        const origin = new URL(page.url()).origin;
        for (const where of [...(direct ? [direct] : []), ...PROPS_PATHS]) {
            await page.goto(origin + where, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await settle();
            await page.evaluate(dismissOverlays).catch(() => 0);
            if (onTools(page)) continue;
            if (await toProps()) break;
            if (where !== '/' && /prop/i.test(new URL(page.url()).pathname)) { steps.push('Props'); break; }
        }
        if (!onTools(page) && onProps) onProps(page.url());
        if (onTools(page)) {
            throw new Error(`Outlier sent every address back to its ${new URL(page.url()).pathname} tool (+EV)${direct ? `, even ${direct}` : ''}. `
                + 'Ask the user to check the Outlier tab is signed in, then ask again with the sport (e.g. NBA).');
        }
    }
    // Already on that sport's board (/NBA/props): its tab may not be shown there.
    const inPath = sport && sportLabels(sport).some(l => new RegExp(`/${l.replace(/[^A-Za-z0-9]/g, '')}(/|$)`, 'i').test(new URL(page.url()).pathname));
    if (sport) await clickLabel(sportLabels(sport), `a "${sport}" tab`, { optional: inPath });
    if (day) await clickLabel(dayLabels(day), `the ${day} tab`, { optional: true });
    if (market) await clickLabel([String(market).trim()], `a "${market}" filter`);
    if (!game) return { steps, game: null, teams: null };
    const seen = new Map();
    for (let i = 0; i < 10; i++) {
        const games = await page.evaluate(listGames, /^games?$/i.test(String(section || '').trim()));
        games.forEach(g => seen.set(`${g.time}|${g.text.slice(0, 60)}`, g));
        const pick = pickGame(games, game, sport);
        if (pick) {
            const teams = gameTeams(pick.text);
            await clickPast(page, `[data-codev-game="${pick.index}"]`).catch(() => { /* a game header that isn't a link: the board is filtered by team instead */ });
            steps.push(`${pick.at != null ? clock(pick.at) : pick.time}${teams ? ` ${teams.join(' vs ')}` : ''}`);
            await settle();
            return { steps, game: pick.text, teams };
        }
        if (!await page.evaluate(scrollStep)) break;
        await page.waitForTimeout(500);
    }
    // No game card for it (a board of props without game cards): read the whole
    // board and keep that game's props by its teams.
    const named = teamsNamed(game, sport).teams;
    if (named.length === 2) {
        await page.evaluate(() => {
            window.scrollTo(0, 0);
            for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
        });
        steps.push(`${named.join(' vs ')} (from the whole board)`);
        return { steps, game: named.join(' vs '), teams: named };
    }
    const shown = [...seen.values()].map(g => `${parseTime(g.time) != null ? clock(parseTime(g.time)) : g.time}: ${g.text.slice(0, 80)}`);
    const want = parseTime(game);
    throw new Error(`Couldn't find the ${want != null ? clock(want) : `"${game}"`} game on Outlier${steps.length ? ` (${steps.join(' > ')})` : ''}. `
        + (shown.length ? `Games shown:\n${shown.slice(0, 20).join('\n')}` : 'No game times were shown on that page.'));
}

// Runs inside the page: marks the visible text naming the player ("LeBron James",
// "L. James") with data-codev-player and returns it, or null. The name itself is
// the click target (it opens Market Details / the player card), never a pick or
// add button around it.
// stats/line: the leg's stat words and line; with them, the name on that stat's
// prop card wins (best.stat true), else any card of his.
function markPlayer({ name, stats = [], line = null, avoid = [], need = [] }) {
    document.querySelectorAll('[data-codev-player]').forEach(el => el.removeAttribute('data-codev-player'));
    const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    // "A.J. Brown" and "AJ Brown", "Marvin Harrison Jr." and "Marvin Harrison" (as nameKey).
    const key = t => norm(t).replace(/\b([a-z]) (?=[a-z]\b)/g, '$1').replace(/ (jr|sr|ii|iii|iv|v)\b/g, '');
    const full = key(name);
    const parts = full.split(' ');
    const short = parts.length > 1 ? `${parts[0][0]} ${parts.slice(1).join(' ')}` : null;
    const NEVER = /\b(submit|place|enter|confirm|add|pick|slip|deposit|withdraw|remove|delete|more|less|over|under|higher|lower)\b/i;
    const ENTRY = /\b(submit|place|enter|confirm|add|pick|slip|deposit|withdraw|remove|delete)\b/i;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    let best = null;
    for (const el of document.querySelectorAll('body *')) {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 60 || !visible(el)) continue;
        const own = ` ${key(text)} `;
        if (!own.includes(` ${full} `) && !(short && own.includes(` ${short} `))) continue;
        if (NEVER.test(text)) continue;
        // A prop card that opens on click shows Over/Under itself; one that adds a pick doesn't open.
        const button = el.closest('button, [role="button"]');
        if (button && ENTRY.test(`${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`)) continue;
        // The prop card around the name: its stat and line.
        // Up to the box that still holds one prop (one Over/Under or odds), not the board.
        const props = t => (String(t).match(/\b(over|under|more|less|higher|lower)\b|(^|\s)[+\-−]\d{3,4}(?=\s|$)/gi) || []).length;
        let card = el;
        for (let up = el.parentElement; up && up !== document.body && (up.innerText || '').length <= 400 && props(up.innerText || '') <= 2; up = up.parentElement) card = up;
        const cardText = ` ${norm(card.innerText)} `;
        // A quarter, half or combo market ("1st Quarter Points", "Pts+Rebs+Asts") isn't the stat.
        // A quarter or half leg needs its period on the card ("1st Quarter").
        const stat = stats.some(w => cardText.includes(` ${w} `)) && !avoid.some(w => cardText.includes(` ${w} `)) && (!need.length || need.some(w => cardText.includes(` ${w} `)));
        const score = (stat ? 2 : 0) + (line != null && cardText.includes(` ${norm(String(line))} `) ? 1 : 0);
        if (!best || score > best.score || (score === best.score && text.length < best.text.length)) best = { el, text, score, stat };
    }
    if (!best) return null;
    best.el.setAttribute('data-codev-player', '1');
    return { text: best.text, stat: best.stat };
}

// Runs inside the page: the readable lines on screen (the page and any open
// panel or dialog), for reading a player card or game page.
function readLines() {
    const out = [];
    const roots = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    for (const root of roots.length ? roots : [document.body]) {
        for (const line of (root.innerText || '').split('\n')) {
            const text = line.replace(/\s+/g, ' ').trim();
            if (text) out.push(text);
        }
    }
    return out;
}

// Runs inside the page: marks Outlier's player search box (data-codev-search) and
// returns its label, or null. Only a field labelled for searching; never one in a
// pick slip, a login or a payment form.
function markSearchBox() {
    document.querySelectorAll('[data-codev-search]').forEach(el => el.removeAttribute('data-codev-search'));
    const NEVER = /\b(promo|code|amount|stake|wager|entry|email|password|card number|deposit|withdraw|pick|slip|bet)\b/i;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    for (const el of document.querySelectorAll('input, [role="searchbox"], [role="combobox"]')) {
        if (!visible(el) || el.disabled || el.readOnly || /^(password|email|number|tel|checkbox|radio|hidden|submit|button)$/i.test(el.type || '')) continue;
        const label = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.id].filter(Boolean).join(' ');
        if (!(el.type === 'search' || el.getAttribute('role') === 'searchbox' || /search|find|player/i.test(label))) continue;
        if (NEVER.test(label) || el.closest('[class*="slip" i], [id*="slip" i], [class*="checkout" i], [class*="login" i]')) continue;
        el.setAttribute('data-codev-search', '1');
        return label || 'search';
    }
    return null;
}

// Types the player's name into Outlier's search box (never presses Enter, never
// clicks a result) so the board shows only his props. Returns the box's label, or
// null when the page has no search box.
async function searchPlayer(page, player, { settleMs = 800 } = {}) {
    const box = await page.evaluate(markSearchBox).catch(() => null);
    if (!box) return null;
    const field = page.locator('[data-codev-search="1"]').first();
    await field.fill('');
    await field.fill(String(player));
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await settleAfterScroll(page, Math.max(600, settleMs));
    return box;
}

// Empties the search box again, so the whole board is back.
async function clearSearch(page) {
    const field = page.locator('[data-codev-search="1"]').first();
    if (!await field.count().catch(() => 0)) return;
    await field.fill('').catch(() => {});
    await settleAfterScroll(page);
}

// Opens the player's Market Details / player card from the board on page,
// scrolling down to find the name. Returns the label clicked or throws.
// stat/line: open his card for that stat (a "Rebounds" leg opens the rebounds
// prop, not the points one) when the board shows it, else any card of his.
async function openPlayer(page, player, { settleMs = 1500, stat = null, line = null, place = null } = {}) {
    const hints = { stats: statWords(stat), line: line == null ? null : String(line), avoid: avoidWords(stat), need: periodWords(stat) };
    const toTop = () => page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
    const open = async label => {
        await clickPast(page, '[data-codev-player="1"]');
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(settleMs);
        return label;
    };
    let anyCard = false;
    // Where the board read saw him: straight there (a screen above, in case rows
    // shifted), a few screens down, instead of scrolling from the top.
    if (place) {
        await page.evaluate(scrollToPlace, [place, 1]).catch(() => {});
        await settleAfterScroll(page);
        for (let i = 0; i < 4; i++) {
            const found = await page.evaluate(markPlayer, { name: String(player), ...hints });
            if (found && (found.stat || !hints.stats.length)) return open(found.text);
            if (found) anyCard = true;
            if (!await page.evaluate(scrollStep)) break;
            await settleAfterScroll(page, 400);
        }
    }
    // From the top of the board: the last read may have left it scrolled down.
    await toTop().catch(() => {});
    for (let i = 0; i < 40; i++) {
        const found = await page.evaluate(markPlayer, { name: String(player), ...hints });
        if (found && (found.stat || !hints.stats.length)) return open(found.text);
        if (found) anyCard = true;
        if (!await page.evaluate(scrollStep)) break;
        await page.waitForTimeout(400);
    }
    if (anyCard) {
        // His card for another stat only: that stat's filter tab, if there is one, then any card of his.
        await toTop();
        const tab = await page.evaluate(markByLabel, [String(stat), ...hints.stats.map(w => w.replace(/\b\w/g, c => c.toUpperCase()))]);
        if (tab && !/^(more|less|over|under)/i.test(tab)) {
            await clickPast(page, '[data-codev-nav="1"]');
            await page.waitForTimeout(settleMs);
        }
        for (let i = 0; i < 40; i++) {
            const found = await page.evaluate(markPlayer, { name: String(player), ...hints });
            if (found) return open(`${found.text}${found.stat ? '' : ' (his card for another stat: no ' + stat + ' prop shown)'}`);
            if (!await page.evaluate(scrollStep)) break;
            await page.waitForTimeout(400);
        }
    }
    throw new Error(`Couldn't find ${player} on that Outlier board (${page.url()}). Check the name's spelling, or give the sport, game and stat so the board shows his props.`);
}

// Reads every line of the open player card or game page, scrolling to its end.
async function readDetails(page, { scrolls = 12, maxChars = 12000 } = {}) {
    const lines = [];
    const seen = new Set();
    for (let i = 0; i <= scrolls; i++) {
        for (const line of await page.evaluate(readLines)) {
            if (seen.has(line)) continue;
            seen.add(line);
            lines.push(line);
        }
        if (i === scrolls || !await page.evaluate(scrollStep)) break;
        await settleAfterScroll(page);
    }
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cut)` : text;
}

// A player card's text -> one short line of what matters for the leg: hit rates,
// the matchup rank, injuries, minutes/usage and odds movement.
function legSummary(text, max = 420) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const parts = [];
    // "L5 80%", or the label and the value on lines of their own ("L5\n80%").
    const hit = String(text).match(/\b(L5|L10|L20|L15|H2H|Season|Szn|20\d\d(?:[-/]\d\d)?|Last \d+)\b(?:[^%\n\d]|\n){0,12}\d{1,3}(?:\.\d)?%/gi) || [];
    if (hit.length) parts.push(`Hit ${[...new Set(hit.map(h => h.replace(/\s+/g, ' ')))].slice(0, 6).join(', ')}`);
    const pick = (re, n, label) => {
        const found = [...new Set(lines.filter(l => re.test(l) && l.length <= 120))].slice(0, n);
        if (found.length) parts.push(`${label}${found.join('; ')}`);
    };
    pick(/\b(rank|ranks|allow(ed|s)?|vs\.? (pg|sg|sf|pf|c|position|guards?|forwards?|centers?)|def(ense)?)\b/i, 2, 'Matchup: ');
    pick(/\b(out|questionable|doubtful|probable|gtd|day-to-day|injur(y|ed|ies))\b/i, 3, 'Injuries: ');
    pick(/\b(min(utes)?|usage|target share|targets|shots|fga|attempts)\b/i, 2, 'Usage: ');
    pick(/\b(movement|moved|opened?|open|public|money|bets)\b/i, 2, 'Market: ');
    const out = parts.join(' | ') || lines.slice(0, 4).join(' · ');
    return out.length > max ? `${out.slice(0, max)}…` : out;
}

// The tabs inside an open player card (Supporting Stats, Game Log, Splits,
// Matchup, Injuries, Odds Movement...). Only real tabs (role=tab, a tab list) or
// buttons in the card's dialog, never one in a header, nav, slip or My Picks, and
// never a pick, bet or slip button. Marked data-codev-tab; returns their labels.
const CARD_TABS = /^(supporting stats|stats|player stats|game ?logs?|splits|home ?\/ ?away|matchup|defen[cs]e( vs\.? position)?|vs\.? (defense|position)|injur(y|ies)|injury report|odds movement|line movement|line history|public( betting)?|bet splits|betting splits|news|minutes|usage|shooting|advanced|opportunit(y|ies)|play ?types?|shot chart|lineups?|snaps|targets|routes|red ?zone|receiving|rushing|passing|pitching|batting|time on ice|efficiency|trends|vs\.? opponent|team stats|statistics|insights|[a-z0-9+ ]{2,20} vs\.? [a-z]{2,4}|key [a-z]{2,4} [a-z+ ]{2,30} defen[cs]e)$/i;
function markCardTabs(source) {
    const re = new RegExp(source, 'i');
    const bad = /pick|slip|add|bet ?now|place|remove|entry|parlay|follow|share/i;
    document.querySelectorAll('[data-codev-tab]').forEach(el => el.removeAttribute('data-codev-tab'));
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    const els = new Set([...document.querySelectorAll('[role="tab"], [role="tablist"] button, [role="tablist"] a'),
        ...(dialog ? dialog.querySelectorAll('button, [role="button"]') : [])]);
    const labels = [];
    for (const el of els) {
        const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length > 30 || !re.test(label) || bad.test(label) || labels.includes(label)) continue;
        if (el.closest('header, nav, aside, [class*="slip" i], [class*="mypick" i], [class*="my-pick" i]')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        el.setAttribute('data-codev-tab', label);
        labels.push(label);
    }
    return labels;
}

// Clicks each of the open card's tabs in turn and reads what it shows. Lines
// already in `known` (the card as it opened) are left out of each tab's text.
async function readCardTabs(page, { settleMs = 800, max = 6, maxChars = 4000, known = '', stop = () => false } = {}) {
    const seen = new Set(String(known).split('\n'));
    const labels = (await page.evaluate(markCardTabs, CARD_TABS.source).catch(() => [])).slice(0, max);
    const tabs = [];
    for (const label of labels) {
        if (stop()) break;
        // The card re-renders on each click: marked again, the tab found by its label.
        const marked = await page.evaluate(markCardTabs, CARD_TABS.source).catch(() => []);
        if (!marked.includes(label)) continue;
        const ok = await page.click(`[data-codev-tab="${label.replace(/"/g, '\\"')}"]`, { timeout: 3000 }).then(() => true).catch(() => false);
        if (!ok) continue;
        await page.waitForTimeout(settleMs);
        if (stop()) break;
        const fresh = (await readDetails(page, { scrolls: 3, maxChars })).split('\n').filter(l => !seen.has(l));
        fresh.forEach(l => seen.add(l));
        if (fresh.length) tabs.push({ tab: label, text: fresh.join('\n') });
    }
    return tabs;
}

// The small tabs and toggles inside the card's sections: the hit-rate windows
// (H2H, L5, L10, L20, seasons), Average/Median, the position tabs of "Points vs
// BOS" (All, PG...C) and of the opponent's defense (Overall, vs PG...), the shot
// chart's shot types and seasons, the supporting stats (Minutes, Fouls, Field
// Goals, 3pts...) and the two teams of Injuries. Never the stat tabs (1Q PTS,
// PTS+AST: other props), the over/under button, alt lines, filters, share or a
// pick. Runs inside the page: marks each data-codev-sub="n" and returns
// [{ n, label, section }] (section: the title of the box it sits in).
const SUB_TABS = '^(h2h|l5|l10|l15|l20|l25|l50|20\\d\\d(-\\d\\d)?|average|median|all|pg|sg|sf|pf|c|g|f|overall|vs\\.? (pg|sg|sf|pf|c|g|f|guards?|forwards?|centers?)|all fgs|3pt|2pt|ft|minutes|fouls|field goals|3pts|free throws|rebounds|assists|steals|blocks|turnovers|usage|touches|shots|targets|snaps|routes|carries|receptions|pitches|strikeouts|time on ice|shots on goal)$';
function markSubTabs(source) {
    const re = new RegExp(source, 'i');
    const bad = /pick|slip|\badd\b|\bbet|place|remove|entry|parlay|follow|share|alt lines|filter|save|template|\bev\b|\b(over|under)\b/i;
    document.querySelectorAll('[data-codev-sub]').forEach(el => el.removeAttribute('data-codev-sub'));
    const root = document.querySelector('[role="dialog"], [aria-modal="true"]') || document.body;
    // The box's title: the first line of the nearest box around it that isn't the
    // row of tabs itself (a row reads like "H2HL5L10" or "AverageMedian").
    const title = (el, label) => {
        for (let up = el.parentElement, n = 0; up && up !== root && n < 8; up = up.parentElement, n++) {
            const first = (up.innerText || '').split('\n').map(t => t.trim()).find(Boolean) || '';
            if (first && first.length <= 40 && !re.test(first) && !first.includes(label)) return first;
        }
        return '';
    };
    const out = [];
    let n = 0;
    for (const el of root.querySelectorAll('button, [role="tab"], [role="button"], [role="radio"], [role="option"], a, div, span, li')) {
        if (el.closest('header, nav, aside, [class*="slip" i], [class*="mypick" i]')) continue;
        const tag = el.tagName;
        const clickable = /^(BUTTON|A)$/.test(tag) || el.getAttribute('role') || (el.children.length <= 2 && getComputedStyle(el).cursor === 'pointer');
        if (!clickable) continue;
        const label = (el.innerText || '').split('\n').map(t => t.trim()).find(Boolean) || '';
        if (!label || label.length > 20 || bad.test(label)) continue;
        const section = title(el, label);
        const team = /^[A-Z]{2,4}$/.test(label) && /injur/i.test(section);
        if (!re.test(label) && !team) continue;
        // One element per control: skip a wrapper whose clickable child carries the same label.
        if ([...el.querySelectorAll('button, [role="tab"], [role="button"], [role="radio"]')].some(c => ((c.innerText || '').split('\n')[0] || '').trim() === label)) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (out.some(o => o.label === label && o.section === section)) continue;
        el.setAttribute('data-codev-sub', String(n));
        out.push({ n, label, section });
        n++;
    }
    return out;
}

// Clicks each of those, in turn, and reads what it shows ("Points vs BOS > PG: ...").
// The first window tab that was on when the card opened (L10 most often) is clicked
// again at the end, so the card is left as it opened.
async function readSubTabs(page, { settleMs = 800, max = 40, maxChars = 3000, known = '', stop = () => false } = {}) {
    const seen = new Set(String(known).split('\n'));
    const found = (await page.evaluate(markSubTabs, SUB_TABS).catch(() => [])).slice(0, max);
    const active = await page.evaluate(() => {
        const on = [...document.querySelectorAll('[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"], [data-state="active"]')]
            .map(el => (el.innerText || '').trim()).find(t => /^(H2H|L\d+|20\d\d)$/i.test(t));
        return on || null;
    }).catch(() => null);
    const tabs = [];
    const click = async ({ label, section }) => {
        const now = await page.evaluate(markSubTabs, SUB_TABS).catch(() => []);
        const hit = now.find(o => o.label === label && o.section === section);
        if (!hit) return false;
        return page.click(`[data-codev-sub="${hit.n}"]`, { timeout: 3000 }).then(() => true).catch(() => false);
    };
    for (const sub of found) {
        if (stop()) break;
        if (!await click(sub)) continue;
        await page.waitForTimeout(settleMs);
        if (stop()) break;
        const fresh = (await readDetails(page, { scrolls: 0, maxChars })).split('\n').filter(l => !seen.has(l));
        fresh.forEach(l => seen.add(l));
        if (fresh.length) tabs.push({ tab: `${sub.section ? `${sub.section} > ` : ''}${sub.label}`, text: fresh.join('\n') });
    }
    const back = active && found.find(o => o.label.toLowerCase() === active.toLowerCase());
    if (back && !stop()) { await page.waitForTimeout(settleMs); await click(back); }
    return tabs;
}

// ---- The card's game-by-game bars, alt lines and "without teammate" split ----

// Runs inside the page: the open card's bar chart (one bar per game, oldest on the
// left), marked data-codev-bar from 0. Returns each bar's own label (aria-label,
// title, an SVG <title>, a tooltip attribute or a number printed on it), '' when
// the value only shows on hover.
function markBars() {
    document.querySelectorAll('[data-codev-bar]').forEach(el => el.removeAttribute('data-codev-bar'));
    const root = document.querySelector('[role="dialog"], [aria-modal="true"]') || document.body;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width >= 3 && r.width <= 80 && r.height >= 2 && r.height <= 400; };
    const cands = [...root.querySelectorAll('svg rect, svg path, [class*="bar" i], [data-testid*="bar" i]')]
        .filter(el => visible(el) && !el.closest('header, nav, aside, [role="tablist"]'));
    // The chart: the largest group of like-sized marks that share a parent (or grandparent).
    const groups = new Map();
    for (const el of cands) {
        for (const key of [el.parentElement, el.parentElement && el.parentElement.parentElement]) {
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, new Set());
            groups.get(key).add(el);
        }
    }
    let best = [];
    for (const set of groups.values()) {
        const g = [...set];
        if (g.length < 5) continue;
        const widths = g.map(el => el.getBoundingClientRect().width).sort((a, b) => a - b);
        const mid = widths[Math.floor(widths.length / 2)];
        const alike = g.filter(el => Math.abs(el.getBoundingClientRect().width - mid) <= mid * 0.3 + 1);
        // One bar per game: a mark inside another mark of the group counts once.
        const bars = alike.filter(el => !alike.some(o => o !== el && o.contains(el)));
        if (bars.length > best.length) best = bars;
    }
    if (best.length < 5) return [];
    best.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return best.slice(-30).map((el, i) => {
        el.setAttribute('data-codev-bar', String(i));
        const title = el.querySelector && el.querySelector('title');
        const own = ['aria-label', 'title', 'data-tip', 'data-tooltip', 'data-tooltip-content', 'data-title'].map(a => el.getAttribute(a)).find(Boolean)
            || (title && title.textContent) || (/\d/.test(el.textContent || '') && (el.textContent || '').length < 60 ? el.textContent : '');
        return String(own || '').replace(/\s+/g, ' ').trim();
    });
}

// Runs inside the page: the text of a tooltip or popover on screen.
function readTooltip() {
    const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; };
    return [...document.querySelectorAll('[role="tooltip"], [class*="tooltip" i], [class*="popover" i], [data-radix-popper-content-wrapper]')]
        .filter(shown).map(el => el.innerText || '').join(' ').replace(/\s+/g, ' ').trim();
}

// One bar's text ("Oct 24 @ MIA · 28 PTS · 36 MIN") -> { value, opp, minutes, date, text }.
function parseBar(text) {
    let t = String(text || '');
    // A hit-rate box ("L10 70%") is not a game.
    if (!t || /%/.test(t)) return null;
    const date = (t.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/i) || [])[0] || null;
    const opp = (t.match(/(?:vs\.?|@)\s*([A-Z]{2,4})\b/) || [])[1] || null;
    const min = t.match(/(\d{1,2}(?:\.\d)?)\s*(?:min|mins|minutes)\b|\bmin(?:utes)?\s*:?\s*(\d{1,2}(?:\.\d)?)/i);
    const minutes = min ? Number(min[1] || min[2]) : null;
    t = t.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ').replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/gi, ' ')
        .replace(/(\d{1,2}(?:\.\d)?)\s*(?:min|mins|minutes)\b|\bmin(?:utes)?\s*:?\s*\d{1,2}(?:\.\d)?/gi, ' ').replace(/\b20\d\d\b/g, ' ').replace(/[+\-−]\d{3,4}\b/g, ' ');
    const num = t.match(/-?\d+(?:\.\d+)?/);
    if (!num) return null;
    return { value: Number(num[0]), opp, minutes, date, text: String(text).slice(0, 80) };
}

// Each game's value on the open card's chart: labels where the bars carry them,
// else the tooltip each bar shows on hover (hovering only, never a click).
async function readBars(page, { max = 20 } = {}) {
    const labels = await page.evaluate(markBars).catch(() => []);
    const games = [];
    const from = Math.max(0, labels.length - max);
    for (let i = from; i < labels.length; i++) {
        let text = labels[i];
        if (!text || !/\d/.test(text)) {
            const ok = await page.hover(`[data-codev-bar="${i}"]`, { force: true, timeout: 1500 }).then(() => true).catch(() => false);
            if (!ok) continue;
            await page.waitForTimeout(150);
            text = await page.evaluate(readTooltip).catch(() => '');
        }
        const bar = parseBar(text);
        if (bar) games.push(bar);
    }
    await page.mouse.move(0, 0).catch(() => {});
    return games;
}

// How often the games on the chart beat the user's line: { line, side, l5, l10, all }
// as [hits, games] pairs, most recent games last.
function hitsAtLine(games, line, side) {
    const at = Number(line);
    if (!Array.isArray(games) || !games.length || !Number.isFinite(at)) return null;
    const under = /^(u|under|less|lower)/i.test(String(side || ''));
    const hit = g => (under ? g.value < at : g.value > at);
    const count = list => [list.filter(hit).length, list.length];
    return { line: at, side: under ? 'Under' : 'Over', l5: count(games.slice(-5)), l10: count(games.slice(-10)), all: count(games) };
}

// Runs inside the page: marks the first visible control (button, switch, tab,
// checkbox, option, list item) whose label matches, never a pick, bet or slip one,
// never in a header, nav or the slip. Returns its label or null.
function markControl({ source, scope = 'card' }) {
    const re = new RegExp(source, 'i');
    const bad = /pick|slip|bet ?now|place|remove|entry|parlay|follow|share|submit|confirm|deposit/i;
    document.querySelectorAll('[data-codev-ctl]').forEach(el => el.removeAttribute('data-codev-ctl'));
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    const root = scope === 'card' && dialog ? dialog : document.body;
    const els = root.querySelectorAll('button, [role="button"], [role="switch"], [role="tab"], [role="checkbox"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="radio"], li, label, input[type="checkbox"]');
    for (const el of els) {
        const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length > 40 || !re.test(label) || bad.test(label)) continue;
        if (el.closest('header, nav, aside, [class*="slip" i], [class*="mypick" i], [class*="my-pick" i]')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        el.setAttribute('data-codev-ctl', '1');
        return label;
    }
    return null;
}

async function clickControl(page, source, settleMs, scope = 'card') {
    const label = await page.evaluate(markControl, { source, scope }).catch(() => null);
    if (!label) return null;
    const ok = await page.click('[data-codev-ctl="1"]', { timeout: 3000 }).then(() => true).catch(() => false);
    if (!ok) return null;
    await page.waitForTimeout(settleMs);
    return label;
}

// The card's alt lines: the switch turned on, its text read, the row for the
// user's line picked out ("24+ 60%" for an Over 23.5), and the switch turned back.
const ALT_SWITCH = '^(alt(ernate)?( lines?)?|show alt(ernate)? lines?|alt(ernate)? lines? toggle)$';
async function readAltLines(page, { line, side, settleMs = 1500, known = '' } = {}) {
    const label = await clickControl(page, ALT_SWITCH, settleMs);
    if (!label) return null;
    const seen = new Set(String(known).split('\n'));
    const text = await readDetails(page, { scrolls: 2, maxChars: 3000 });
    const fresh = text.split('\n').filter(l => !seen.has(l));
    await clickControl(page, ALT_SWITCH, Math.min(settleMs, 800));
    const at = Number(line);
    let row = null;
    if (Number.isFinite(at)) {
        const under = /^(u|under|less|lower)/i.test(String(side || ''));
        const keys = [String(at), `${under ? Math.floor(at) : Math.ceil(at)}+`, `${Math.ceil(at)}+`];
        row = text.split('\n').find(l => /%/.test(l) && keys.some(k => new RegExp(`(^|[^\\d.])${k.replace(/[.+]/g, m => `\\${m}`)}(?![\\d.])`).test(l))) || null;
    }
    return { row, text: fresh.join('\n').slice(0, 1500) };
}

// Teammates the card lists as out (or doubtful): "Mark Williams OUT".
function injuredTeammates(text, player) {
    const me = normWords(player);
    const out = [];
    for (const m of String(text || '').matchAll(/([A-Z][A-Za-z'.-]+(?: [A-Z][A-Za-z'.-]+){1,3})\s*[-–:(]?\s*(OUT|Out|Doubtful|DOUBTFUL)\b/g)) {
        const name = m[1].replace(/^(Injuries|Injury|Status)\s+/, '').trim();
        if (name.split(' ').length < 2 || normWords(name) === me || out.includes(name)) continue;
        out.push(name);
    }
    return out.slice(0, 3);
}

// The card's "without teammate" split for a teammate who is out: the With/Without
// control opened, his name picked, the card read again.
const WITHOUT_CONTROL = '^(with ?\\/ ?without|without|with or without|teammates?|on ?\\/ ?off|without teammate|player (on|off))$';
async function readWithout(page, { player, text, settleMs = 1500, known = '' } = {}) {
    const names = injuredTeammates(text, player);
    if (!names.length) return [];
    const splits = [];
    for (const name of names) {
        const opened = await clickControl(page, WITHOUT_CONTROL, Math.min(settleMs, 800));
        if (!opened) break;
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const picked = await clickControl(page, `\\b${esc}\\b(?!.*\\b(out|doubtful|questionable|probable)\\b)`, settleMs, 'page');
        if (!picked) { await page.keyboard.press('Escape').catch(() => {}); continue; }
        const seen = new Set(String(known).split('\n'));
        const fresh = (await readDetails(page, { scrolls: 2, maxChars: 3000 })).split('\n').filter(l => !seen.has(l));
        splits.push({ without: name, text: fresh.join('\n').slice(0, 1200) });
    }
    return splits;
}

// Minutes and opportunity (shot attempts, 3PT attempts, usage, touches, potential
// assists, rebound chances, targets...) from a card's text, by window when the card
// labels its columns: { Minutes: { values: [30.1, 32, 34.2], windows: ['L5', 'L10', '2026'] } }.
const OPPORTUNITY = [
    ['Minutes', /^(min|mins|minutes)( played| per game)?\b/i],
    ['Shots on goal', /^shots on goal\b/i],
    ['FG attempts', /^(fga|fg attempts?|fg attempted|field goals? attempted|field goal attempts|shot attempts|shots)\b/i],
    ['3PT attempts', /^(3pa|3pt attempts?|3pt attempted|3-?pt att(empts)?|three point attempts|3 pointers attempted|three pointers attempted)\b/i],
    ['FT attempts', /^(fta|ft attempts?|free throws? attempted|free throw attempts)\b/i],
    ['Usage', /^(usage|usg)( rate)?( ?%)?/i],
    ['Touches', /^touches\b/i],
    ['Potential assists', /^(potential assists|potential ast)\b/i],
    ['Rebound chances', /^(rebound chances|reb chances|rebounding chances)\b/i],
    ['Targets', /^targets\b/i],
    ['Target share', /^target share\b/i],
    ['Rush attempts', /^(rush attempts|rushing attempts|carries)\b/i],
    ['Snaps', /^(snaps|snap %|snap share)\b/i],
    ['Routes', /^(routes|routes run|route participation|route %|route share)\b/i],
    ['Air yards', /^(air yards|air yds|air yards share)\b/i],
    ['Red zone touches', /^(red ?zone (touches|targets|carries|opportunities|looks))\b/i],
    ['Pass attempts', /^(pass attempts|passing attempts|pass att)\b/i],
    ['Plate appearances', /^(plate appearances|pa)\b/i],
    ['At bats', /^(at bats|ab)\b/i],
    ['Batting order', /^(batting order|lineup spot|batting position)\b/i],
    ['Pitch count', /^(pitch count|pitches|pitches thrown)\b/i],
    ['Innings pitched', /^(innings pitched|ip)\b/i],
    ['Batters faced', /^(batters faced|bf)\b/i],
    ['Time on ice', /^(time on ice|toi)\b/i],
    ['Power play time', /^(power ?play time|pp toi|pp time)\b/i]
];
const WINDOW_RE = /\b(L\d{1,2}|Last \d{1,2}|H2H|Season|Szn|Avg|Average|20\d\d(?:[-/]\d\d)?)\b/gi;
function cardNumbers(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const nums = s => (s.replace(WINDOW_RE, ' ').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const onlyNumbers = l => /^[-\d.%\s·|]+$/.test(l) && /\d/.test(l);
    let header = null;
    const out = {};
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const windows = line.match(WINDOW_RE) || [];
        // A row of column labels ("L5 L10 L20 2026"): the windows for the rows under it.
        if (windows.length >= 2 && !line.replace(WINDOW_RE, '').replace(/[^A-Za-z0-9]/g, '').replace(/^(stat|stats|split|splits)$/i, '')) { header = windows; continue; }
        for (const [name, re] of OPPORTUNITY) {
            if (out[name] || !re.test(line)) continue;
            const rest = line.replace(re, '');
            // Inline pairs: "Minutes L5 30.1 L10 32.0 Season 34.2".
            const pairs = [...rest.matchAll(/\b(L\d{1,2}|Last \d{1,2}|H2H|Season|Szn|Avg|Average|20\d\d(?:[-/]\d\d)?)\b\s*:?\s*(-?\d+(?:\.\d+)?)/gi)];
            if (pairs.length) { out[name] = { values: pairs.map(m => Number(m[2])), windows: pairs.map(m => m[1]) }; break; }
            let values = nums(rest);
            // The label on a line of its own, its numbers on the lines below.
            for (let j = i + 1; !values.length || (header && values.length < header.length); j++) {
                if (j >= lines.length || j > i + 6 || !onlyNumbers(lines[j])) break;
                values = values.concat(nums(lines[j]));
            }
            if (!values.length || values.length > 8) continue;
            out[name] = { values, windows: header && header.length === values.length ? header : null };
            break;
        }
    }
    return out;
}

// Recent against the longer run, as a fraction (-0.12 = 12% lower lately), or null
// when the card doesn't say which number is which window.
function opportunityTrend({ values, windows } = {}) {
    if (!windows || values.length < 2) return null;
    const at = re => windows.findIndex(w => re.test(w));
    let recent = at(/^(L[35]|Last [35])$/i);
    if (recent < 0) recent = at(/^(L\d+|Last \d+)$/i);
    let base = at(/^(Season|Szn|Avg|Average)$/i);
    if (base < 0) {
        const years = windows.map((w, i) => ({ y: /^20\d\d/.test(w) ? Number(w.slice(0, 4)) : 0, i })).filter(x => x.y).sort((a, b) => b.y - a.y);
        base = years.length ? years[0].i : windows.length - 1;
    }
    if (recent < 0 || recent === base || !(values[base] > 0)) return null;
    return (values[recent] - values[base]) / values[base];
}

// The opportunity numbers as one line for the agent.
function opportunityLine(found) {
    return Object.entries(found || {}).map(([name, m]) => {
        const shown = m.windows ? m.windows.map((w, i) => `${w} ${m.values[i]}`).join(' · ') : m.values.join(' / ');
        const t = opportunityTrend(m);
        const trend = t == null || Math.abs(t) < 0.1 ? '' : ` (${Math.round(Math.abs(t) * 100)}% ${t < 0 ? 'lower' : 'higher'} lately)`;
        return `${name} ${shown}${trend}`;
    }).join('; ');
}

// Keeps the board's props that are legs the user listed ({ player, stat }): his
// prop for that stat, or all of his when the stat isn't named or not found.
function keepLegs(props, legs) {
    if (!Array.isArray(legs) || !legs.length) return props;
    const kept = new Set();
    for (const leg of legs) {
        const name = normWords(leg.player);
        if (!name) continue;
        const his = props.filter(p => sameName(p.player, name) || normWords(p.player).endsWith(` ${name.split(' ').slice(-1)[0]}`) && normWords(p.player)[0] === name[0]);
        const words = statWords(leg.stat);
        const forStat = words.length ? his.filter(p => sameMarket(p.market, leg.stat)) : [];
        (forStat.length ? forStat : his).forEach(p => kept.add(p));
    }
    return props.filter(p => kept.has(p));
}

// Keeps only props from the chosen game when the game names its teams; props
// that don't say which game they're in stay.
function onlyGame(props, teams) {
    if (!teams) return props;
    const key = [...teams].sort().join('-');
    return props.filter(p => !p.game || p.game === key);
}

// ---- Outlier's filter panel ----
// The panel (a sliders button on the board) holds: Only EV+, Players, Games, Hit
// Rate (L5/L10/L20/H2H/season, a From-To range), Odds ("At least -300" by
// default, which hides heavy favorites), Opponent Matchup, Over/Under, Include
// alternative lines, then Save filters and Show N results. CoDev turns alt lines
// on, opens the odds range all the way, ticks the game, and shows the results. It
// never touches Only EV+, Save filters, Templates or anything on a slip.

// Runs inside the page: marks one part of the filter panel with
// data-codev-filter="1" and says what it found. what: 'open' (the button that
// opens the panel), 'panel' (is it open), 'alt' (the alt-lines switch), 'odds'
// (the Odds row), 'oddsFrom' (the low end of the odds range), 'game' (the game's
// row, by its teams), 'show' (Show N results).
function markFilter({ what, teams = [] }) {
    document.querySelectorAll('[data-codev-filter]').forEach(el => el.removeAttribute('data-codev-filter'));
    const NEVER = /\b(save|template|only ev|my picks|add to|submit|place|enter|deposit|withdraw|delete|remove)\b/i;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const textOf = el => ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const mark = (el, out) => { el.setAttribute('data-codev-filter', '1'); return out; };
    // The smallest visible element whose own text is label.
    const labelEl = re => {
        let best = null;
        for (const el of document.querySelectorAll('body *')) {
            const t = textOf(el);
            if (!t || t.length > 60 || !re.test(t) || !visible(el)) continue;
            if (!best || best.contains(el)) best = el;
        }
        return best;
    };
    const SWITCH = '[role="switch"], input[type="checkbox"], [aria-checked], [aria-pressed], button';
    const isOn = el => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.checked === true || /^(checked|on)$/i.test(el.getAttribute('data-state') || '');
    // The switch or checkbox in the same row as a label.
    const switchBy = label => {
        for (let up = label, i = 0; up && i < 5; up = up.parentElement, i++) {
            const found = [...up.querySelectorAll(SWITCH)].find(el => el !== label && !NEVER.test(textOf(el)));
            if (found) return found;
        }
        return null;
    };
    if (what === 'panel') return Boolean(labelEl(/^include alt(ernative|ernate)? lines$/i));
    if (what === 'open') {
        for (const el of document.querySelectorAll('button, [role="button"], a, [aria-label], [title], [data-testid], [class*="filter" i]')) {
            if (!visible(el) || NEVER.test(textOf(el))) continue;
            const named = /^(filters?|filter props|current filters|open filters)$/i.test(textOf(el))
                || /filter/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''}`)
                || (/filter/i.test(String(el.className || '')) && textOf(el).length <= 20 && el.matches('button, [role="button"]'));
            if (named) return mark(el, textOf(el) || 'filters');
        }
        return null;
    }
    if (what === 'alt') {
        const label = labelEl(/^include alt(ernative|ernate)? lines$/i);
        const sw = label && switchBy(label);
        if (!sw) return null;
        return mark(sw.matches('input') && !visible(sw) ? (sw.closest('label') || label) : sw, { on: isOn(sw) });
    }
    if (what === 'odds') {
        const label = labelEl(/^odds$/i);
        return label ? mark(label, textOf(label.parentElement || label)) : null;
    }
    if (what === 'oddsFrom') {
        const label = labelEl(/^odds$/i);
        const stop = labelEl(/^opponent matchup$/i);
        if (!label) return null;
        const after = el => label.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
        const before = el => !stop || (el.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING);
        const slider = [...document.querySelectorAll('[role="slider"], input[type="range"]')].find(el => visible(el) && after(el) && before(el));
        if (!slider) return null;
        return mark(slider, { range: slider.matches('input'), min: slider.getAttribute('aria-valuemin') || slider.min || null, now: slider.getAttribute('aria-valuenow') || slider.value || null });
    }
    if (what === 'game') {
        // teams: each team's names (["DAL", "cowboys", "dallas"]); a row names both.
        const names = teams.map(t => [].concat(t).map(w => String(w).toLowerCase()));
        if (!names.length) return null;
        const has = (text, w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[^a-z0-9 ]/g, '')}($|[^a-z0-9])`).test(text);
        for (const box of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
            for (let up = box.parentElement, i = 0; up && i < 4; up = up.parentElement, i++) {
                const t = textOf(up).toLowerCase();
                if (t.length > 120) break;
                if (names.every(alts => alts.some(w => has(t, w)))) return mark(visible(box) ? box : up, { on: isOn(box), text: textOf(up) });
            }
        }
        return null;
    }
    if (what === 'show') {
        for (const el of document.querySelectorAll('button, [role="button"], a')) {
            if (visible(el) && /^(show|see|view|apply)\b.*\b(results?|props?)$|^apply( filters)?$|^done$/i.test(textOf(el)) && !NEVER.test(textOf(el))) return mark(el, textOf(el));
        }
        return null;
    }
    return null;
}

// Opens Outlier's filter panel and sets it for researching a list: alternative
// lines on (the user's line is often an alt line), the odds range opened to its
// lowest end (the default "At least -300" hides heavy favorites), the game ticked
// when one was asked for, then Show results. Returns what it set, as steps; a
// board without the panel returns [] and the board is read as it is.
async function setFilters(page, { altLines = true, widenOdds = true, teams = null, sport = null } = {}, { settleMs = 800 } = {}) {
    const did = [];
    if (teams) teams = teams.map(t => [t, ...teamTokens(t, String(sport || '').toLowerCase())]);
    const find = (what, extra = {}) => page.evaluate(markFilter, { what, ...extra }).catch(() => null);
    const click = () => clickPast(page, '[data-codev-filter="1"]').then(() => page.waitForTimeout(Math.min(settleMs, 600)), () => {});
    if (!await find('panel')) {
        if (!await find('open')) return did;
        await click();
        if (!await find('panel')) { await page.keyboard.press('Escape').catch(() => {}); return did; }
    }
    if (altLines) {
        const alt = await find('alt');
        if (alt && !alt.on) {
            await click();
            const now = await find('alt');
            did.push(now && now.on ? 'alt lines on' : 'alt lines (switch didn\'t turn on)');
        } else if (alt) did.push('alt lines on');
    }
    if (widenOdds) {
        let from = await find('oddsFrom');
        if (!from && await find('odds')) { await click(); from = await find('oddsFrom'); }
        if (from) {
            const handle = page.locator('[data-codev-filter="1"]').first();
            if (from.range) {
                await handle.evaluate(el => {
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, el.min);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }).catch(() => {});
            } else {
                await handle.focus().catch(() => {});
                await page.keyboard.press('Home').catch(() => {});
            }
            let after = await find('oddsFrom');
            // A slider that ignores the Home key: drag its handle to the far left.
            if (after && after.min != null && after.now !== after.min) {
                const box = await page.locator('[data-codev-filter="1"]').first().boundingBox().catch(() => null);
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await page.mouse.down();
                    await page.mouse.move(1, box.y + box.height / 2, { steps: 8 });
                    await page.mouse.up();
                    after = await find('oddsFrom');
                }
            }
            did.push(after && (after.min == null || after.now === after.min) ? `odds from ${after && after.now != null ? after.now : 'the lowest'}` : 'odds range (couldn\'t move it)');
        }
    }
    if (teams && teams.length) {
        let game = await find('game', { teams });
        if (!game) {
            await page.evaluate(() => {
                const el = [...document.querySelectorAll('body *')].find(e => /^games$/i.test((e.innerText || '').trim()) && e.getBoundingClientRect().height > 0);
                if (el) el.setAttribute('data-codev-filter', '1');
            }).catch(() => {});
            await click();
            game = await find('game', { teams });
        }
        if (game && !game.on) { await click(); did.push(`game ${game.text.slice(0, 60)}`); } else if (game) did.push(`game ${game.text.slice(0, 60)}`);
    }
    if (await find('show')) await click();
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await settleAfterScroll(page, Math.max(600, settleMs));
    return did;
}

module.exports = { SUB_TABS, markSubTabs, readSubTabs, sameName, nameKey, setFilters, markFilter, navigate, parseTime, pickGame, gameTeams, sportLabels, teamsNamed, onlyGame, markByLabel, listGames, listLabels, chooseOption, clock, PROPS_SECTIONS, sportPropsPath, markPlayer, openPlayer, readDetails, readCardTabs, markCardTabs, readBars, parseBar, hitsAtLine, readAltLines, readWithout, injuredTeammates, cardNumbers, opportunityTrend, opportunityLine, OPPORTUNITY, dismissOverlays, markPropsLink, statWords, sameMarket, dayLabels, legSummary, keepLegs, onTools, normWords, periodOf, withoutPeriod, scrollStep, scrollPlace, scrollToPlace, settleAfterScroll, placeOf, markSearchBox, searchPlayer, clearSearch };
