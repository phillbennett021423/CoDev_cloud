'use strict';

// Forward-looking checks built only from what CoDev read on Outlier's cards: the
// game-by-game bars (value, minutes, date), the minutes/opportunity windows and the
// game's lines. Nothing here is looked up elsewhere or assumed: a check whose
// numbers the card didn't show returns null and is left out.

const isUnder = side => /^(u|under|less|lower)/i.test(String(side || ''));
const mean = xs => xs.reduce((a, v) => a + v, 0) / xs.length;
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// Expected stat = his rate per minute (median of his last 10 games on the chart)
// x the minutes he has played lately (the card's L5 minutes, else the chart's last 5).
function projectLeg(card, leg) {
    const games = ((card && card.games) || []).filter(g => Number.isFinite(g.value) && Number.isFinite(g.minutes) && g.minutes > 0);
    if (games.length < 5) return null;
    const recent = games.slice(-10);
    const perMin = median(recent.map(g => g.value / g.minutes));
    const windows = card.numbers && card.numbers.Minutes;
    const l5 = windows && windows.windows ? windows.values[windows.windows.findIndex(w => /^(L5|Last 5)$/i.test(w))] : undefined;
    const expMin = Number.isFinite(l5) ? l5 : mean(games.slice(-5).map(g => g.minutes));
    const projection = perMin * expMin;
    const line = Number(leg.line);
    return {
        projection: round(projection), perMin: round(perMin, 2), expMin: round(expMin), gamesUsed: recent.length,
        minutesFrom: Number.isFinite(l5) ? "the card's L5 minutes" : 'his last 5 games on the chart',
        diff: Number.isFinite(line) ? round(projection - line) : null
    };
}

// Hot or cold on the same volume. Recent output (last 5 games on the chart) against
// all the games shown, next to whether his minutes and chances held: steady volume
// with cold output points back up; hot output on falling volume points back down.
function regressionFlag(card, leg, trendOf) {
    const values = ((card && card.games) || []).map(g => g.value).filter(Number.isFinite);
    if (values.length < 8) return null;
    const recent = mean(values.slice(-5));
    const all = mean(values);
    if (!(all > 0)) return null;
    const change = (recent - all) / all;
    const volume = ['Minutes', 'FG attempts', '3PT attempts', 'Usage', 'Touches', 'Potential assists', 'Rebound chances', 'Targets', 'Rush attempts']
        .map(name => (card.numbers && card.numbers[name] ? trendOf(card.numbers[name]) : null)).filter(t => t != null);
    if (!volume.length) return null;
    const vol = mean(volume);
    const under = isUnder(leg.side);
    if (change <= -0.12 && vol >= -0.05) {
        return `cold lately (last 5 average ${round(recent)} vs ${round(all)} over ${values.length} games) on steady volume: ${under ? 'a risk for this Under' : 'output tends to come back up, a point for this Over'}`;
    }
    if (change >= 0.15 && vol <= 0) {
        return `hot lately (last 5 average ${round(recent)} vs ${round(all)}) without more volume: ${under ? 'output tends to come back down, a point for this Under' : 'a risk for this Over'}`;
    }
    return null;
}

// The game's total and spread when the card prints them ("O/U 231.5", "CHA -3.5").
function gameContext(text) {
    const t = String(text || '');
    const total = t.match(/(?:\bO\/U|\bOver\/Under|\bGame total|\bTotal points)\s*:?\s*(\d{1,3}(?:\.5)?)\b/i);
    // Only the teams of the card's own matchup ("WAS @ CHA"), so "FGA +2" is never a spread.
    const teams = new Set([...t.matchAll(/\b([A-Z]{2,4})\s*(?:@|vs\.?)\s*([A-Z]{2,4})\b/g)].flatMap(m => [m[1], m[2]]));
    const spread = [...t.matchAll(/\b([A-Z]{2,4})\s+([+-]\d{1,2}(?:\.5)?)\b(?!\s*%)/g)].find(m => teams.has(m[1]));
    if (!total && !spread) return null;
    return { total: total ? Number(total[1]) : null, spread: spread ? `${spread[1]} ${spread[2]}` : null };
}

// How two legs moved together: the correlation of their values in the games both
// played on the same date (at least 8 shared dates), else null.
function correlation(a, b) {
    const byDate = new Map(((a && a.games) || []).filter(g => g.date).map(g => [g.date, g.value]));
    const pairs = ((b && b.games) || []).filter(g => g.date && byDate.has(g.date)).map(g => [byDate.get(g.date), g.value]);
    if (pairs.length < 8) return null;
    const mx = mean(pairs.map(p => p[0]));
    const my = mean(pairs.map(p => p[1]));
    let sxy = 0; let sxx = 0; let syy = 0;
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    if (!sxx || !syy) return null;
    return { r: round(sxy / Math.sqrt(sxx * syy), 2), n: pairs.length };
}

// Inverse of the standard normal CDF (Acklam's approximation).
function normInv(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5; const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function cholesky(m) {
    const n = m.length;
    const L = m.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = m[i][j];
            for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
            if (i === j) { if (sum <= 1e-9) return null; L[i][i] = Math.sqrt(sum); } else L[i][j] = sum / L[j][j];
        }
    }
    return L;
}

// A small seeded generator, so the same ticket gives the same answer each time.
function mulberry32(seed) {
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Each leg's chance from its own games at the user's line, (hits + 1) / (games + 2)
// so 5 of 5 isn't read as certain; null with fewer than 5 games.
function legChance(card) {
    const a = card && card.atLine;
    if (!a || a.all[1] < 5) return null;
    return { p: (a.all[0] + 1) / (a.all[1] + 2), hits: a.all[0], games: a.all[1] };
}

// The ticket played many times: each leg hits with its own chance, and legs that
// moved together on the same dates move together here (a Gaussian copula). Returns
// the share of runs where every leg hit, next to the plain product of the chances.
function simulateTicket(cards, legs = [], { runs = 10000, seed = 7 } = {}) {
    const chances = cards.map(legChance);
    if (chances.some(c => !c)) return null;
    const n = cards.length;
    const corr = cards.map((a, i) => cards.map((b, j) => (i === j ? 1 : 0)));
    const used = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const c = correlation(cards[i], cards[j]);
            if (!c) continue;
            // An Under hits when his number is low: a shared rise works against it.
            const r = isUnder(legs[i] && legs[i].side) !== isUnder(legs[j] && legs[j].side) ? -c.r : c.r;
            corr[i][j] = corr[j][i] = Math.max(-0.9, Math.min(0.9, r));
            used.push({ i, j, r: c.r, n: c.n });
        }
    }
    let L = cholesky(corr);
    if (!L) { used.length = 0; L = cholesky(corr.map((row, i) => row.map((v, j) => (i === j ? 1 : 0)))); }
    const cut = chances.map(c => normInv(c.p));
    const rand = mulberry32(seed);
    const normal = () => { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
    let all = 0;
    for (let r = 0; r < runs; r++) {
        const z = Array.from({ length: n }, normal);
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
            let x = 0;
            for (let k = 0; k <= i; k++) x += L[i][k] * z[k];
            if (x >= cut[i]) ok = false;
        }
        if (ok) all++;
    }
    return { joint: all / runs, independent: chances.reduce((a, c) => a * c.p, 1), chances, correlations: used, runs };
}

module.exports = { projectLeg, regressionFlag, gameContext, correlation, simulateTicket, legChance, normInv };
