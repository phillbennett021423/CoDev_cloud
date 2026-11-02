// Outlier's board rows ranked by their own hit rates: every leg at or over a
// minimum (60% in the last 5 by default) on either side, best first, and 4-leg
// tickets built from them at regular lines (odds near -119), one leg per game and
// per player, never a player with injury news. Plain JavaScript over the props
// extract.js reads, so it needs no Python and no second visit to Outlier.

const { sameName } = require('./navigate');

const WINDOWS = ['l5', 'l10', 'l20', 'h2h', 'season'];
const LABELS = { l5: 'L5', l10: 'L10', l20: 'L20', h2h: 'H2H', season: 'Season' };

const isUnder = side => /^(u|under|less|lower)/i.test(String(side || ''));

// A row's price for its side: the consensus when Outlier shows one, else the best book's.
function priceOf(prop) {
    if (Number.isFinite(prop.consensus)) return { price: prop.consensus, book: null };
    const odds = (prop.odds || []).filter(o => Number.isFinite(o.price));
    if (!odds.length) return { price: null, book: null };
    const best = odds.reduce((a, b) => (b.price > a.price ? b : a));
    return { price: best.price, book: best.book || null };
}

// "LAL-DEN", or the two teams, or the player's team against his opponent.
function gameOf(prop) {
    if (prop.game) return String(prop.game).toUpperCase();
    if (Array.isArray(prop.teams) && prop.teams.length === 2) return [...prop.teams].sort().join('-').toUpperCase();
    if (prop.team && prop.opponent) return [prop.team, prop.opponent].sort().join('-').toUpperCase();
    return null;
}

// Every row, plus its Under when Outlier only listed the Over: at a .5 line he
// either cleared it or didn't, so the Under's hit rate is 100% minus the Over's.
function bothSides(props) {
    const key = p => `${String(p.player).toLowerCase()}|${String(p.market || '').toLowerCase()}|${p.line}`;
    const unders = new Set(props.filter(p => isUnder(p.side)).map(key));
    const out = props.map(p => ({ ...p, side: isUnder(p.side) ? 'under' : 'over' }));
    for (const p of props) {
        if (isUnder(p.side) || unders.has(key(p)) || !Number.isFinite(Number(p.line)) || Number(p.line) % 1 === 0) continue;
        const rates = Object.fromEntries(Object.entries(p.hitRates || {}).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.round((1 - v) * 1000) / 1000]));
        if (!Object.keys(rates).length) continue;
        out.push({ ...p, side: 'under', hitRates: rates, odds: p.oppositeOdds || [], consensus: undefined, derived: true });
    }
    return out;
}

// Who has injury news: anyone the page listed with a status (out, doubtful,
// questionable, GTD, probable, returning...).
function injuryNews(player, injuries = []) {
    const hit = injuries.find(i => i && i.player && sameName(i.player, player));
    return hit ? (hit.status || 'injury news') : null;
}

// The legs at or over min in the window, on the sides asked for, best first.
// Score: the window counts most, then L10, then L20/season, so a 100% L5 that is
// also strong over 10 games beats a 100% L5 that isn't.
function hitRateLegs(props, { window = 'l5', min = 0.6, side = 'both', injuries = [], market = null } = {}) {
    const win = WINDOWS.includes(window) ? window : 'l5';
    const floor = min > 1 ? min / 100 : min;
    const all = bothSides(props || []);
    const counts = { rows: (props || []).length, withRates: (props || []).filter(p => p.hitRates && Object.keys(p.hitRates).length).length, injured: [] };
    const legs = [];
    for (const p of all) {
        if (side === 'over' && p.side !== 'over') continue;
        if (side === 'under' && p.side !== 'under') continue;
        if (market && !String(p.market || '').toLowerCase().includes(String(market).toLowerCase())) continue;
        const rates = p.hitRates || {};
        const rate = rates[win];
        if (!Number.isFinite(rate) || rate < floor - 1e-9) continue;
        const injury = injuryNews(p.player, injuries);
        if (injury) { counts.injured.push(`${p.player} (${injury})`); continue; }
        const second = win === 'l10' ? rates.l5 : rates.l10;
        const base = [rates.l20, rates.season].find(Number.isFinite);
        const score = rate * 0.5 + (Number.isFinite(second) ? second : rate) * 0.3 + (Number.isFinite(base) ? base : rate) * 0.2;
        legs.push({ ...p, rate, score, ...priceOf(p), gameKey: gameOf(p) });
    }
    counts.injured = [...new Set(counts.injured)];
    // Equal records: the one priced nearest -119 first, a row with no odds last.
    const gap = l => (Number.isFinite(l.price) ? Math.abs(l.price + 119) : Infinity);
    legs.sort((a, b) => b.score - a.score || b.rate - a.rate || (gap(a) === gap(b) ? 0 : gap(a) < gap(b) ? -1 : 1));
    return { legs, counts, window: win, min: floor };
}

// A regular line: priced near -119 (a -120 at another book counts the same).
const regular = (leg, band) => Number.isFinite(leg.price) && leg.price <= band[1] && leg.price >= band[0];

// Tickets of size legs from the ranked list: regular lines first, one leg per
// player and per game. A leg whose game isn't shown is kept off a ticket that has
// one from his team. Each ticket after the first uses legs no earlier one did.
function buildTickets(legs, { size = 4, count = 2, band = [-140, -100] } = {}) {
    const used = new Set();
    const tickets = [];
    for (let n = 0; n < count; n++) {
        const pick = [];
        const take = ok => {
            for (const leg of legs) {
                if (pick.length >= size) break;
                if (used.has(leg) || !ok(leg)) continue;
                if (pick.some(p => sameName(p.player, leg.player))) continue;
                if (leg.gameKey && pick.some(p => p.gameKey === leg.gameKey)) continue;
                if (leg.team && pick.some(p => p.team && (p.team === leg.team || p.opponent === leg.team))) continue;
                pick.push(leg);
            }
        };
        take(leg => regular(leg, band));
        const regularCount = pick.length;
        if (pick.length < size) take(leg => !regular(leg, band));
        if (pick.length < size) break;
        pick.forEach(l => used.add(l));
        tickets.push({ legs: pick, allRegular: regularCount === size });
    }
    return tickets;
}

const pct = v => `${Math.round(v * 100)}%`;
const fmtPrice = p => (Number.isFinite(p) ? (p > 0 ? `+${p}` : String(p)) : 'no odds shown');

function legText(leg) {
    const rates = WINDOWS.filter(w => Number.isFinite((leg.hitRates || {})[w])).map(w => `${LABELS[w]} ${pct(leg.hitRates[w])}`).join(' · ');
    const where = leg.gameKey ? ` (${leg.gameKey.replace('-', ' vs ')})` : leg.team ? ` (${leg.team})` : '';
    return `${leg.player} ${leg.side === 'under' ? 'Under' : 'Over'} ${leg.line} ${leg.market || ''}${where}: ${fmtPrice(leg.price)}${leg.book ? ` ${leg.book}` : ''} · ${rates}${leg.derived ? ' (Under rates from the Over row)' : ''}`.replace(/\s+/g, ' ');
}

// The finder's answer: what was read, the ranked legs, then the tickets.
function hitRatesText({ legs, counts, window, min }, { steps = [], tickets = [], band = [-140, -100], max = 30, size = 4, payout = 10 } = {}) {
    const label = LABELS[window];
    const head = steps.length ? `Outlier > ${steps.join(' > ')}\n` : '';
    if (!counts.rows) return `${head}Outlier's board came back with no props. Check that the Outlier browser is signed in and on the Props board, then try again; don't keep retrying.`;
    if (!counts.withRates) return `${head}Read ${counts.rows} props, but none came with hit rates, so CoDev couldn't read Outlier's ${label} boxes on this board. Tell the user, and ask them to save an Outlier page snapshot from the Outlier tab so the reader can be fixed. Don't retry the same read.`;
    const overs = legs.filter(l => l.side === 'over').length;
    const lines = [`${head}Read ${counts.rows} props (${counts.withRates} with hit rates). ${legs.length} legs hit ${pct(min)}+ in the ${label}: ${overs} Overs, ${legs.length - overs} Unders.`];
    if (counts.injured.length) lines.push(`Left out for injury news: ${counts.injured.slice(0, 15).join(', ')}${counts.injured.length > 15 ? '…' : ''}.`);
    if (!legs.length) return `${lines.join('\n')}\nNo leg reached ${pct(min)} in the ${label}.`;
    lines.push(`\nBest first (${label} counts most, then L10/L5, then L20/season):`);
    legs.slice(0, max).forEach((l, i) => lines.push(`${i + 1}. ${legText(l)}`));
    if (legs.length > max) lines.push(`…and ${legs.length - max} more.`);
    if (!tickets.length) {
        lines.push(`\nNot enough legs from different games for a ${size}-leg ticket.`);
    } else {
        tickets.forEach((t, n) => {
            lines.push(`\n${n ? 'Another ' : ''}${size}-leg ticket${n ? ' (no legs from the first)' : ''}, regular lines${payout ? `, pays ${payout}x` : ''}${t.allRegular ? '' : ` (not every leg is between ${band[0]} and ${band[1]}: marked)`}:`);
            t.legs.forEach((l, i) => lines.push(`${i + 1}) ${legText(l)}${regular(l, band) ? '' : ' [odds outside the regular range]'}`));
        });
        const unknown = tickets.some(t => t.legs.some(l => !l.gameKey && !l.team));
        lines.push(`\nOne leg per game and per player${unknown ? ' (some rows didn\'t show their game: check those are from different games)' : ''}; nobody with injury news. Hit rates are the past, not a promise: re-check injuries before the games.`);
    }
    return lines.join('\n');
}

module.exports = { hitRateLegs, buildTickets, hitRatesText, bothSides, priceOf, gameOf, injuryNews };
