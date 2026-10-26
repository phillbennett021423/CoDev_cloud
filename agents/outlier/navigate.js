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
    'passing yards': ['passing yards', 'pass yds'], 'rushing yards': ['rushing yards', 'rush yds'], 'receiving yards': ['receiving yards', 'rec yds'],
    receptions: ['receptions', 'rec'], strikeouts: ['strikeouts', 'ks', 'pitcher strikeouts'], 'total bases': ['total bases', 'tb'],
    hits: ['hits'], 'shots on goal': ['shots on goal', 'sog', 'shots']
};
const normWords = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// "Pts+Rebs+Asts" -> every way a board might write it.
function statWords(stat) {
    const key = normWords(stat);
    if (!key) return [];
    const entry = Object.entries(STATS).find(([name, words]) => name === key || words.includes(key));
    return entry ? [...new Set([entry[0], ...entry[1]])] : [key];
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
// screen. False when nothing moved (the end).
const scrollStep = () => {
    const before = window.scrollY;
    window.scrollBy(0, window.innerHeight * 0.9);
    let any = window.scrollY !== before;
    for (const el of document.querySelectorAll('*')) {
        if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
            const top = el.scrollTop;
            el.scrollTop += el.clientHeight * 0.9;
            if (el.scrollTop !== top) any = true;
        }
    }
    return any;
};

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
    if (section) await clickLabel([String(section).trim()], `a "${section}" tab`);
    else if ((sport || game || player) && await toProps()) {
        if (onProps) onProps(page.url());
    } else if (sport || game || player) {
        const origin = new URL(page.url()).origin;
        for (const where of PROPS_PATHS) {
            await page.goto(origin + where, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await settle();
            await page.evaluate(dismissOverlays).catch(() => 0);
            if (onTools(page)) continue;
            if (await toProps()) break;
            if (where !== '/' && /prop/i.test(new URL(page.url()).pathname)) { steps.push('Props'); break; }
        }
        if (!onTools(page) && onProps) onProps(page.url());
        if (onTools(page)) {
            throw new Error(`Outlier stays on its ${new URL(page.url()).pathname} tool (+EV) and shows no way to the regular Props board from there. `
                + 'Ask the user to open Props once in the Outlier window (📈 Outlier tab, live view), then ask again: Outlier reopens the last board used.');
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
function markPlayer({ name, stats = [], line = null }) {
    document.querySelectorAll('[data-codev-player]').forEach(el => el.removeAttribute('data-codev-player'));
    const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const full = norm(name);
    const parts = full.split(' ');
    const short = parts.length > 1 ? `${parts[0][0]} ${parts.slice(1).join(' ')}` : null;
    const NEVER = /\b(submit|place|enter|confirm|add|pick|slip|deposit|withdraw|remove|delete|more|less|over|under|higher|lower)\b/i;
    const ENTRY = /\b(submit|place|enter|confirm|add|pick|slip|deposit|withdraw|remove|delete)\b/i;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    let best = null;
    for (const el of document.querySelectorAll('body *')) {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 60 || !visible(el)) continue;
        const own = ` ${norm(text)} `;
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
        const stat = stats.some(w => cardText.includes(` ${w} `));
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

// Opens the player's Market Details / player card from the board on page,
// scrolling down to find the name. Returns the label clicked or throws.
// stat/line: open his card for that stat (a "Rebounds" leg opens the rebounds
// prop, not the points one) when the board shows it, else any card of his.
async function openPlayer(page, player, { settleMs = 1500, stat = null, line = null } = {}) {
    const hints = { stats: statWords(stat), line: line == null ? null : String(line) };
    const toTop = () => page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
    const open = async label => {
        await clickPast(page, '[data-codev-player="1"]');
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(settleMs);
        return label;
    };
    // From the top of the board: the last read may have left it scrolled down.
    await toTop().catch(() => {});
    let anyCard = false;
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
        await page.waitForTimeout(600);
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

// Keeps the board's props that are legs the user listed ({ player, stat }): his
// prop for that stat, or all of his when the stat isn't named or not found.
function keepLegs(props, legs) {
    if (!Array.isArray(legs) || !legs.length) return props;
    const kept = new Set();
    for (const leg of legs) {
        const name = normWords(leg.player);
        if (!name) continue;
        const his = props.filter(p => normWords(p.player) === name || normWords(p.player).endsWith(` ${name.split(' ').slice(-1)[0]}`) && normWords(p.player)[0] === name[0]);
        const words = statWords(leg.stat);
        const forStat = words.length ? his.filter(p => words.some(w => ` ${normWords(p.market)} `.includes(` ${w} `))) : [];
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

module.exports = { navigate, parseTime, pickGame, gameTeams, sportLabels, teamsNamed, onlyGame, markByLabel, listGames, listLabels, chooseOption, clock, PROPS_SECTIONS, markPlayer, openPlayer, readDetails, dismissOverlays, markPropsLink, statWords, dayLabels, legSummary, keepLegs, onTools, normWords };
