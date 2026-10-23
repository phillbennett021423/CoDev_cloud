#!/usr/bin/env python3
"""Scores Outlier props and builds 4- and 6-leg entries, and tunes its own
filters from the results of past entries. Standard library only.

    python analyze.py analyze --input scrape.json --weights weights.json --out result.json
    python analyze.py learn --history history.json --weights weights.json --out weights.json [--report learn.json]

`analyze` reads the props the scraper saved (agents/outlier/extract.js writes
them) and writes every prop with its metrics and the reasons it was dropped,
plus the best entries. `learn` reads settled legs (hit/miss) and moves the
filter thresholds, the market/history blend and per-market penalties toward
what actually hit, within the bounds in the weights file.

The probabilities are estimates from market prices and recent games. They are
not guarantees: a filter that hit 70% last month can miss next week.

A prop, as the scraper writes it (missing fields are fine):
    {"id", "player", "team", "opponent", "game", "league", "market",
     "line": 24.5, "side": "over" | "under",
     "odds": [{"book": "FanDuel", "price": -135}, ...],  # this side
     "oppositeOdds": [...],                                # the other side
     "consensus": -140,                                    # if the site shows one
     "hitRates": {"l5": 0.8, "l10": 0.7, "l20": 0.65, "season": 0.6},
     "recent": [27, 31, 22, ...]}                          # most recent game first
"""
import argparse
import itertools
import json
import math
import os
import statistics
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WEIGHTS = os.path.join(HERE, "weights.default.json")

# learn: fewer settled legs than this changes nothing (noise, not signal).
MIN_SAMPLE = 20
# learn: a threshold is only judged on at least this many legs that clear it.
MIN_SUBSET = 15
# learn: how far each change moves toward what the data says (0..1).
LEARNING_RATE = 0.5


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# ---- odds math -------------------------------------------------------------

def implied_prob(price):
    """American odds -> implied probability (with the book's vig)."""
    price = float(price)
    if price < 0:
        return -price / (-price + 100.0)
    return 100.0 / (price + 100.0)


def american(prob):
    """Probability -> American odds."""
    prob = min(max(prob, 1e-6), 1 - 1e-6)
    if prob >= 0.5:
        return -round(prob / (1 - prob) * 100)
    return round((1 - prob) / prob * 100)


def juice(price):
    """How juiced a price is: -135 -> 135, +110 -> -110. Higher is more juiced."""
    return -float(price)


def to_price(value):
    try:
        price = float(str(value).replace("−", "-").replace("+", ""))
    except (TypeError, ValueError):
        return None
    # American odds are never between -100 and +100.
    if -100 < price < 100:
        return None
    return price


def consensus_price(prices):
    """Median of the books' implied probabilities, back as American odds."""
    probs = [implied_prob(p) for p in prices if p is not None]
    if not probs:
        return None
    return american(statistics.median(probs))


def prices_of(entries):
    out = []
    for entry in entries or []:
        price = to_price(entry.get("price") if isinstance(entry, dict) else entry)
        if price is not None:
            out.append(price)
    return out


def percentile(values, q):
    ordered = sorted(values)
    if not ordered:
        return None
    pos = (len(ordered) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


# ---- one prop --------------------------------------------------------------

def leg_metrics(leg, weights):
    """Everything the filters and the slip builder need about one prop."""
    model = weights["model"]
    side = (leg.get("side") or "over").lower()
    line = leg.get("line")
    line = float(line) if isinstance(line, (int, float)) else None
    prices = prices_of(leg.get("odds"))
    opposite = prices_of(leg.get("oppositeOdds"))
    consensus = to_price(leg.get("consensus"))
    if consensus is None:
        consensus = consensus_price(prices)

    implied = implied_prob(consensus) if consensus is not None else None
    fair = None
    if implied is not None:
        opp = consensus_price(opposite)
        if opp is not None:
            fair = implied / (implied + implied_prob(opp))
        else:
            fair = implied / (1.0 + model["assumed_vig"])

    rates = leg.get("hitRates") or {}
    recent = [float(v) for v in (leg.get("recent") or []) if isinstance(v, (int, float))][:10]

    def hits(values):
        if line is None:
            return None
        if side == "under":
            return sum(1 for v in values if v < line)
        return sum(1 for v in values if v > line)

    l5 = rates.get("l5")
    if l5 is None and len(recent) >= 5:
        l5 = hits(recent[:5]) / 5.0
    l5 = normalize_rate(l5)

    # Hit-rate evidence for the probability: the longest window we have.
    if len(recent) >= 5 and line is not None:
        hit_count, games = hits(recent), len(recent)
    elif normalize_rate(rates.get("l10")) is not None:
        hit_count, games = normalize_rate(rates.get("l10")) * 10, 10
    elif l5 is not None:
        hit_count, games = l5 * 5, 5
    else:
        hit_count, games = None, 0

    floor_margin = volatility = None
    if len(recent) >= 3 and line is not None:
        scale = max(abs(line), 0.5)
        if side == "under":
            ceiling = percentile(recent, 0.8) if len(recent) >= 5 else max(recent)
            floor_margin = (line - ceiling) / scale
        else:
            floor = percentile(recent, 0.2) if len(recent) >= 5 else min(recent)
            floor_margin = (floor - line) / scale
        mean = statistics.fmean(recent)
        if mean > 0:
            volatility = statistics.pstdev(recent) / mean

    shrunk = None
    prob = None
    if fair is not None:
        prior = model["history_prior_games"]
        if hit_count is not None:
            shrunk = (hit_count + prior * fair) / (games + prior)
            prob = model["market_weight"] * fair + (1 - model["market_weight"]) * shrunk
        else:
            prob = fair
        prob *= 1 - weights.get("market_penalty", {}).get(market_key(leg), 0.0)

    return {
        "consensus": consensus,
        "juice": juice(consensus) if consensus is not None else None,
        "books": len(prices) or (1 if leg.get("consensus") is not None else 0),
        "impliedProb": rnd(implied),
        "fairProb": rnd(fair),
        "l5": rnd(l5),
        "historyRate": rnd(shrunk),
        "floorMargin": rnd(floor_margin),
        "volatility": rnd(volatility),
        "games": len(recent),
        "p": rnd(prob),
    }


def normalize_rate(value):
    """0.8, 80, "80%" or "4/5" -> 0.8."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip().rstrip("%")
        if "/" in text:
            num, _, den = text.partition("/")
            try:
                return float(num) / float(den) if float(den) else None
            except ValueError:
                return None
        try:
            value = float(text)
        except ValueError:
            return None
    value = float(value)
    return value / 100.0 if value > 1 else value


def rnd(value, places=4):
    return None if value is None else round(value, places)


def market_key(leg):
    return " ".join(str(leg.get("market") or "").lower().split())


def rejections(leg, metrics, weights):
    """Why a prop doesn't make the cut ([] = it does)."""
    f = weights["filters"]
    reasons = []
    if market_key(leg) in [m.lower() for m in weights.get("avoid_markets", [])]:
        reasons.append("market on the avoid list (it kept missing)")
    if metrics["consensus"] is None:
        reasons.append("no odds")
    elif metrics["juice"] < f["min_juice"]:
        reasons.append(f"juice {fmt_price(metrics['consensus'])} is lighter than -{f['min_juice']:g}")
    if metrics["books"] < f.get("min_books", 1):
        reasons.append(f"only {metrics['books']} book(s)")
    if metrics["l5"] is None:
        reasons.append("no L5 hit rate")
    elif metrics["l5"] < f["min_l5_hit_rate"] - 1e-9:
        reasons.append(f"L5 {metrics['l5']:.0%} is under {f['min_l5_hit_rate']:.0%}")
    if metrics["floorMargin"] is not None and metrics["floorMargin"] < f["min_floor_margin"] - 1e-9:
        reasons.append(f"low floor ({metrics['floorMargin']:+.0%} vs line)")
    if metrics["volatility"] is not None and metrics["volatility"] > f["max_volatility"] + 1e-9:
        reasons.append(f"boom-or-bust (volatility {metrics['volatility']:.2f})")
    if metrics["p"] is not None and metrics["p"] < f["min_leg_probability"] - 1e-9:
        reasons.append(f"estimated hit chance {metrics['p']:.0%} is under {f['min_leg_probability']:.0%}")
    return reasons


def fmt_price(price):
    return f"{int(price):+d}"


def leg_score(metrics):
    # Probability first; a small extra cost for swingy stat lines.
    vol = metrics["volatility"] or 0.0
    return (metrics["p"] or 0.0) - 0.05 * max(0.0, vol - 0.2)


# ---- entries ---------------------------------------------------------------

def hit_distribution(probs):
    """P(exactly k legs hit) for independent legs (Poisson binomial)."""
    dist = [1.0]
    for p in probs:
        nxt = [0.0] * (len(dist) + 1)
        for k, mass in enumerate(dist):
            nxt[k] += mass * (1 - p)
            nxt[k + 1] += mass * p
        dist = nxt
    return dist


def entry_value(probs, table):
    """Expected profit per 1 unit staked, chance of all legs, chance of profit."""
    dist = hit_distribution(probs)
    payout = {int(k): float(v) for k, v in table.items()}
    ev = sum(mass * payout.get(k, 0.0) for k, mass in enumerate(dist)) - 1.0
    profit = sum(mass for k, mass in enumerate(dist) if payout.get(k, 0.0) > 1.0)
    return ev, dist[-1], profit, dist


def fits(combo, slips_cfg):
    players, games, teams = set(), {}, {}
    for leg in combo:
        player = (leg.get("player") or leg["id"]).lower()
        if player in players:
            return False
        players.add(player)
        game = leg.get("game")
        if game:
            games[game] = games.get(game, 0) + 1
            if games[game] > slips_cfg["max_legs_per_game"]:
                return False
        team = leg.get("team")
        if team:
            teams[team] = teams.get(team, 0) + 1
            if teams[team] > slips_cfg["max_legs_per_team"]:
                return False
    return True


def build_slips(legs, weights):
    cfg = weights["slips"]
    pool = sorted(legs, key=lambda l: leg_score(l["metrics"]), reverse=True)[: cfg["candidate_pool"]]
    slips, notes = [], []
    for kind, tables in weights["payouts"].items():
        for size in cfg["sizes"]:
            table = tables.get(str(size))
            if not table:
                continue
            if len(pool) < size:
                notes.append(f"{size}-leg {kind}: only {len(pool)} prop(s) passed the filters.")
                continue
            ranked = []
            for combo in itertools.combinations(pool, size):
                if not fits(combo, cfg):
                    continue
                probs = [l["metrics"]["p"] for l in combo]
                ev, all_hit, profit, dist = entry_value(probs, table)
                ranked.append((ev, all_hit, profit, dist, combo))
            ranked.sort(key=lambda r: (r[0], r[1]), reverse=True)
            chosen = []
            for ev, all_hit, profit, dist, combo in ranked:
                ids = {l["id"] for l in combo}
                # Different entries, not the same one with a leg or two swapped.
                if any(len(ids & c) > size // 2 for c in chosen):
                    continue
                chosen.append(ids)
                slips.append({
                    "id": f"{kind}-{size}-{len(chosen)}",
                    "type": kind,
                    "size": size,
                    "legs": [l["id"] for l in combo],
                    "ev": rnd(ev),
                    "allHitProb": rnd(all_hit),
                    "profitProb": rnd(profit),
                    "distribution": [rnd(m) for m in dist],
                    "payouts": table,
                })
                if len(chosen) >= cfg["slips_per_type"]:
                    break
            if not ranked:
                notes.append(f"{size}-leg {kind}: no mix of legs fits the one-per-player and same-game limits.")
    # 4-leg before 6-leg, power before flex, best first within each.
    slips.sort(key=lambda s: (s["size"], s["type"] != "power", -s["ev"]))
    return slips, notes


def analyze(scrape, weights):
    props = scrape.get("props") or []
    legs = []
    for i, raw in enumerate(props):
        leg = dict(raw)
        leg.setdefault("id", f"leg-{i + 1}")
        leg["metrics"] = leg_metrics(leg, weights)
        leg["rejected"] = rejections(leg, leg["metrics"], weights)
        legs.append(leg)
    passed = [l for l in legs if not l["rejected"]]
    slips, notes = build_slips(passed, weights)
    if not props:
        notes.insert(0, "The scrape found no props. If the Outlier page shows some, save a page snapshot so the parser can be tuned to it.")
    legs.sort(key=lambda l: (bool(l["rejected"]), -leg_score(l["metrics"])))
    return {
        "generatedAt": now_iso(),
        "scrapedAt": scrape.get("scrapedAt"),
        "weightsVersion": weights.get("version", 1),
        "filters": weights["filters"],
        "counts": {"props": len(legs), "passed": len(passed), "slips": len(slips)},
        "legs": legs,
        "slips": slips,
        "notes": notes,
    }


# ---- learning from results -------------------------------------------------

# Filter -> (metric in a settled leg, True if higher values are stricter).
TUNABLE = {
    "min_juice": ("juice", True),
    "min_l5_hit_rate": ("l5", True),
    "min_floor_margin": ("floorMargin", True),
    "max_volatility": ("volatility", False),
    "min_leg_probability": ("p", True),
}


def wilson_lower(hits, n, z=1.28):
    """Lower edge of an ~80% confidence interval on a hit rate."""
    if n == 0:
        return 0.0
    phat = hits / n
    denom = 1 + z * z / n
    centre = phat + z * z / (2 * n)
    margin = z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))
    return (centre - margin) / denom


def settled_legs(history):
    out = []
    for entry in history.get("entries", []):
        for leg in entry.get("legs", []):
            if leg.get("result") in ("hit", "miss"):
                out.append(leg)
    return out


def log_loss(legs, market_weight):
    total, n = 0.0, 0
    for leg in legs:
        m = leg.get("metrics") or {}
        fair, hist = m.get("fairProb"), m.get("historyRate")
        if fair is None or hist is None:
            continue
        p = min(max(market_weight * fair + (1 - market_weight) * hist, 1e-4), 1 - 1e-4)
        y = 1.0 if leg["result"] == "hit" else 0.0
        total -= y * math.log(p) + (1 - y) * math.log(1 - p)
        n += 1
    return total / n if n else None


def threshold_grid(lo, hi, steps=20):
    return [lo + (hi - lo) * i / steps for i in range(steps + 1)]


def learn(history, weights):
    weights = json.loads(json.dumps(weights))
    legs = settled_legs(history)
    report = {"generatedAt": now_iso(), "settledLegs": len(legs), "changes": [], "notes": []}
    if len(legs) < MIN_SAMPLE:
        report["notes"].append(f"{len(legs)} settled leg(s) so far; the filters start adjusting at {MIN_SAMPLE}, so one bad night doesn't rewrite them.")
        return weights, report

    hit_total = sum(1 for l in legs if l["result"] == "hit")
    predicted = [l["metrics"]["p"] for l in legs if (l.get("metrics") or {}).get("p") is not None]
    report["hitRate"] = rnd(hit_total / len(legs))
    report["predictedRate"] = rnd(statistics.fmean(predicted)) if predicted else None

    # 1. How much to trust the market vs. recent games.
    current_mw = weights["model"]["market_weight"]
    losses = [(log_loss(legs, mw / 20), mw / 20) for mw in range(21)]
    losses = [(loss, mw) for loss, mw in losses if loss is not None]
    if len(losses) == 21 and len(legs) >= 30:
        best_loss, best_mw = min(losses)
        if abs(best_mw - current_mw) >= 0.05 and best_loss < log_loss(legs, current_mw) - 0.002:
            new_mw = round(current_mw + LEARNING_RATE * (best_mw - current_mw), 3)
            weights["model"]["market_weight"] = new_mw
            report["changes"].append({"setting": "market_weight", "from": current_mw, "to": new_mw,
                                      "why": f"results fit best with {best_mw:.0%} weight on market prices and {1 - best_mw:.0%} on recent games"})

    # 2. Tighten (or keep) each filter where the legs that missed cluster.
    for name, (metric, higher_is_stricter) in TUNABLE.items():
        lo, hi = weights["bounds"][name]
        current = weights["filters"][name]
        rows = [(l["metrics"][metric], l["result"] == "hit") for l in legs
                if (l.get("metrics") or {}).get(metric) is not None]
        if len(rows) < MIN_SAMPLE:
            continue
        need = max(MIN_SUBSET, int(0.4 * len(rows)))

        def score(t):
            kept = [hit for value, hit in rows if (value >= t if higher_is_stricter else value <= t)]
            if len(kept) < need:
                return None
            return wilson_lower(sum(kept), len(kept)), len(kept), sum(kept)

        base = score(current)
        best_t, best = current, base
        for t in threshold_grid(lo, hi):
            s = score(t)
            if s and (best is None or s[0] > best[0] + 0.01):
                best_t, best = t, s
        if best_t == current or best is None:
            continue
        new = current + LEARNING_RATE * (best_t - current)
        new = round(min(max(new, lo), hi), 3 if name != "min_juice" else 0)
        if new == current:
            continue
        misses_cut = sum(1 for value, hit in rows if not hit and not (value >= new if higher_is_stricter else value <= new))
        hits_cut = sum(1 for value, hit in rows if hit and not (value >= new if higher_is_stricter else value <= new))
        weights["filters"][name] = new
        report["changes"].append({"setting": name, "from": current, "to": new,
                                  "why": f"would have dropped {misses_cut} missed leg(s) and {hits_cut} winning one(s); legs past {best_t:.3g} hit {best[2]}/{best[1]}"})

    # 3. Markets that keep missing more than predicted.
    by_market = {}
    for leg in legs:
        by_market.setdefault(market_key(leg), []).append(leg)
    penalties = weights.setdefault("market_penalty", {})
    avoid = weights.setdefault("avoid_markets", [])
    for market, group in sorted(by_market.items()):
        if not market or len(group) < 8:
            continue
        actual = sum(1 for l in group if l["result"] == "hit") / len(group)
        preds = [l["metrics"]["p"] for l in group if (l.get("metrics") or {}).get("p") is not None]
        if not preds:
            continue
        pred = statistics.fmean(preds)
        old = penalties.get(market, 0.0)
        if actual < pred - 0.12:
            penalty = round(min(max((pred - actual) / 2, 0.0), 0.15), 3)
            if penalty > old:
                penalties[market] = penalty
                report["changes"].append({"setting": f"market_penalty[{market}]", "from": old, "to": penalty,
                                          "why": f"hit {actual:.0%} of {len(group)} vs {pred:.0%} predicted"})
            if actual < 0.4 and len(group) >= 12 and market not in avoid:
                avoid.append(market)
                report["changes"].append({"setting": "avoid_markets", "from": None, "to": market,
                                          "why": f"hit only {actual:.0%} of {len(group)}"})
        elif old and actual >= pred:
            penalties.pop(market)
            report["changes"].append({"setting": f"market_penalty[{market}]", "from": old, "to": 0,
                                      "why": f"back to hitting {actual:.0%} of {len(group)} vs {pred:.0%} predicted"})

    # What the misses had in common, for the dashboard.
    traits = []
    for metric, label in (("juice", "juice"), ("l5", "L5"), ("floorMargin", "floor margin"), ("volatility", "volatility")):
        hit_vals = [l["metrics"][metric] for l in legs if l["result"] == "hit" and (l.get("metrics") or {}).get(metric) is not None]
        miss_vals = [l["metrics"][metric] for l in legs if l["result"] == "miss" and (l.get("metrics") or {}).get(metric) is not None]
        if len(hit_vals) >= 5 and len(miss_vals) >= 5:
            traits.append({"metric": label, "hits": rnd(statistics.fmean(hit_vals), 3), "misses": rnd(statistics.fmean(miss_vals), 3)})
    report["missTraits"] = traits
    if report["changes"]:
        weights["version"] = int(weights.get("version", 1)) + 1
    else:
        report["notes"].append("No change: the current filters already fit the results.")
    return weights, report


# ---- command line ----------------------------------------------------------

def load_json(path, fallback=None):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    if fallback is not None:
        return fallback
    raise SystemExit(f"{path} not found")


def load_weights(path):
    defaults = load_json(DEFAULT_WEIGHTS)
    saved = load_json(path, {}) if path else {}
    # Saved weights win; new default settings fill in what an older file lacks.
    merged = json.loads(json.dumps(defaults))
    for key, value in saved.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return merged


def write_json(path, data):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--input", required=True)
    a.add_argument("--weights")
    a.add_argument("--out")
    l = sub.add_parser("learn")
    l.add_argument("--history", required=True)
    l.add_argument("--weights")
    l.add_argument("--out", required=True)
    l.add_argument("--report")
    args = parser.parse_args(argv)

    weights = load_weights(args.weights)
    if args.command == "analyze":
        result = analyze(load_json(args.input), weights)
        if args.out:
            write_json(args.out, result)
        else:
            json.dump(result, sys.stdout, indent=2)
        return 0
    new_weights, report = learn(load_json(args.history, {"entries": []}), weights)
    write_json(args.out, new_weights)
    if args.report:
        write_json(args.report, report)
    else:
        json.dump(report, sys.stdout, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
