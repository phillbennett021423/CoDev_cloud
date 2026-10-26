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
    for (const el of document.querySelectorAll('a, button, [role], li, span, div, label, p')) {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 40 || !visible(el)) continue;
        // "NBA", "NBA 42" (a count of props) or "🏀 NBA".
        const label = text.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s*\(?\d+\)?$/, '').trim().toLowerCase();
        const rank = wanted.indexOf(label);
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
// only one time; prop cards (a line and odds) and pick buttons are left out.
function listGames() {
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
        if (seen.has(card) || (ODDS.test(cardText) && LINE.test(cardText)) || NEVER.test(cardText)) continue;
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
        .split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !['the', 'game', 'at', 'vs', 'and', 'tonight', 'today', 'props', 'pm', 'am'].includes(w));
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

// Clicks through Outlier on page: the props board, sport, then market, then game. Scrolls to find
// a game further down. Returns { steps, game, teams } or throws with what it saw.
async function navigate(page, { section, sport, market, game } = {}, { settleMs = 1500 } = {}) {
    const steps = [];
    const settle = async () => {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(settleMs);
    };
    // optional: carry on when it isn't there instead of failing.
    const clickLabel = async (labels, what, { optional = false } = {}) => {
        const found = await page.evaluate(markByLabel, labels);
        if (found) {
            await page.click('[data-codev-nav="1"]', { timeout: 5000 });
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
    // Off the Positive EV tool and onto the regular props board.
    if (section) await clickLabel([String(section).trim()], `a "${section}" tab`);
    else if (sport || game) await clickLabel(PROPS_SECTIONS, 'the props board', { optional: true });
    if (sport) await clickLabel(sportLabels(sport), `a "${sport}" tab`);
    if (market) await clickLabel([String(market).trim()], `a "${market}" filter`);
    if (!game) return { steps, game: null, teams: null };
    const seen = new Map();
    for (let i = 0; i < 10; i++) {
        const games = await page.evaluate(listGames);
        games.forEach(g => seen.set(`${g.time}|${g.text.slice(0, 60)}`, g));
        const pick = pickGame(games, game, sport);
        if (pick) {
            const teams = gameTeams(pick.text);
            await page.click(`[data-codev-game="${pick.index}"]`, { timeout: 5000 }).catch(() => { /* a game header that isn't a link: the board is filtered by team instead */ });
            steps.push(`${pick.at != null ? clock(pick.at) : pick.time}${teams ? ` ${teams.join(' vs ')}` : ''}`);
            await settle();
            return { steps, game: pick.text, teams };
        }
        const moved = await page.evaluate(() => {
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
        });
        if (!moved) break;
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

// Keeps only props from the chosen game when the game names its teams; props
// that don't say which game they're in stay.
function onlyGame(props, teams) {
    if (!teams) return props;
    const key = [...teams].sort().join('-');
    return props.filter(p => !p.game || p.game === key);
}

module.exports = { navigate, parseTime, pickGame, gameTeams, sportLabels, teamsNamed, onlyGame, markByLabel, listGames, listLabels, chooseOption, clock, PROPS_SECTIONS };
