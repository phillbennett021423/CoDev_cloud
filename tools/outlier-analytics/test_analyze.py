"""python -m unittest discover tools/outlier-analytics"""
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402


def prop(i, player=None, price=-150, l5=0.8, recent=None, line=20.5, side="over", game=None, market="Points", **extra):
    leg = {
        "id": f"p{i}", "player": player or f"Player {i}", "team": f"T{i}", "game": game or f"G{i}",
        "market": market, "line": line, "side": side,
        "odds": [{"book": "A", "price": price}, {"book": "B", "price": price - 5}],
        "hitRates": {"l5": l5},
        "recent": recent if recent is not None else [24, 23, 25, 22, 26, 24, 23, 25, 22, 24],
    }
    leg.update(extra)
    return leg


class OddsMath(unittest.TestCase):
    def test_implied_and_back(self):
        self.assertAlmostEqual(A.implied_prob(-130), 130 / 230)
        self.assertAlmostEqual(A.implied_prob(150), 0.4)
        self.assertEqual(A.american(A.implied_prob(-130)), -130)
        self.assertEqual(A.american(0.4), 150)

    def test_prices_parse_unicode_minus_and_reject_junk(self):
        self.assertEqual(A.to_price("−135"), -135)
        self.assertEqual(A.to_price("+120"), 120)
        self.assertIsNone(A.to_price("24.5"))
        self.assertIsNone(A.to_price("n/a"))

    def test_rates(self):
        self.assertEqual(A.normalize_rate("80%"), 0.8)
        self.assertEqual(A.normalize_rate("4/5"), 0.8)
        self.assertEqual(A.normalize_rate(60), 0.6)

    def test_distribution_sums_to_one(self):
        dist = A.hit_distribution([0.6, 0.7, 0.55, 0.65])
        self.assertAlmostEqual(sum(dist), 1.0)
        self.assertAlmostEqual(dist[-1], 0.6 * 0.7 * 0.55 * 0.65)

    def test_power_ev(self):
        ev, all_hit, profit, _ = A.entry_value([0.6] * 4, {"4": 10})
        self.assertAlmostEqual(all_hit, 0.6 ** 4)
        self.assertAlmostEqual(ev, 10 * 0.6 ** 4 - 1)
        self.assertAlmostEqual(profit, all_hit)


class Filters(unittest.TestCase):
    def setUp(self):
        self.w = A.load_weights(None)

    def run_one(self, leg):
        m = A.leg_metrics(leg, self.w)
        return m, A.rejections(leg, m, self.w)

    def test_strong_leg_passes(self):
        m, why = self.run_one(prop(1))
        self.assertEqual(why, [])
        self.assertGreater(m["p"], 0.56)
        self.assertGreater(m["floorMargin"], 0)

    def test_light_juice_rejected(self):
        _, why = self.run_one(prop(1, price=-115))
        self.assertTrue(any("juice" in r for r in why))

    def test_low_l5_rejected(self):
        _, why = self.run_one(prop(1, l5=0.6))
        self.assertTrue(any("L5" in r for r in why))

    def test_boom_or_bust_rejected(self):
        _, why = self.run_one(prop(1, recent=[45, 8, 40, 6, 38, 10, 35, 5, 42, 9]))
        self.assertTrue(any("boom-or-bust" in r for r in why))
        self.assertTrue(any("floor" in r for r in why))

    def test_under_floor_uses_ceiling(self):
        m, _ = self.run_one(prop(1, side="under", line=30.5, recent=[22, 24, 25, 23, 26]))
        self.assertGreater(m["floorMargin"], 0)

    def test_l5_from_game_log_when_site_has_none(self):
        leg = prop(1, recent=[25, 25, 25, 18, 25])
        leg["hitRates"] = {}
        m, _ = self.run_one(leg)
        self.assertEqual(m["l5"], 0.8)

    def test_devig_with_both_sides(self):
        leg = prop(1, price=-150)
        leg["odds"] = [{"price": -150}]
        leg["oppositeOdds"] = [{"price": 120}]
        m, _ = self.run_one(leg)
        expected = A.implied_prob(-150) / (A.implied_prob(-150) + A.implied_prob(120))
        self.assertAlmostEqual(m["fairProb"], round(expected, 4))


class Slips(unittest.TestCase):
    def test_only_4_leg_entries_by_default(self):
        result = A.analyze({"props": [prop(i, price=-140 - 5 * i) for i in range(10)]}, A.load_weights(None))
        self.assertEqual({(s["type"], s["size"]) for s in result["slips"]}, {("power", 4), ("flex", 4)})

    def test_builds_4_and_6_leg_entries_with_limits(self):
        props = [prop(i, price=-140 - 5 * i) for i in range(10)]
        props.append(prop(99, player="Player 0", price=-300))  # same player as p0
        w = A.load_weights(None)
        w["slips"]["sizes"] = [4, 6]
        result = A.analyze({"props": props}, w)
        sizes = {(s["type"], s["size"]) for s in result["slips"]}
        self.assertIn(("power", 4), sizes)
        self.assertIn(("flex", 6), sizes)
        for slip in result["slips"]:
            players = [next(l for l in result["legs"] if l["id"] == i)["player"] for i in slip["legs"]]
            self.assertEqual(len(players), len(set(players)), "one leg per player")
        self.assertEqual(result["slips"][0]["size"], 4)
        power4 = [s for s in result["slips"] if s["type"] == "power" and s["size"] == 4]
        self.assertEqual(power4, sorted(power4, key=lambda s: s["ev"], reverse=True))
        for a in power4:
            for b in power4:
                if a is not b:
                    self.assertLessEqual(len(set(a["legs"]) & set(b["legs"])), 2, "entries differ by more than a swap")

    def test_too_few_legs_says_so(self):
        result = A.analyze({"props": [prop(1), prop(2)]}, A.load_weights(None))
        self.assertEqual(result["slips"], [])
        self.assertTrue(any("only 2" in n for n in result["notes"]))

    def test_empty_scrape_explains(self):
        result = A.analyze({"props": []}, A.load_weights(None))
        self.assertIn("snapshot", result["notes"][0])


class Correlation(unittest.TestCase):
    def setUp(self):
        self.w = A.load_weights(None)

    def leg(self, i, market, team, side="over", **extra):
        leg = prop(i, market=market, side=side, game="BOS-MIA", league="NBA", team=team, **extra)
        leg["metrics"] = A.leg_metrics(leg, self.w)
        return leg

    def test_assists_and_teammate_threes_reinforce(self):
        rho, why = A.pair_correlation(self.leg(1, "Assists", "BOS"), self.leg(2, "Threes", "BOS"), self.w)
        self.assertGreater(rho, 0)
        self.assertIn("assists", why)

    def test_one_under_flips_the_sign(self):
        rho, _ = A.pair_correlation(self.leg(1, "Assists", "BOS"), self.leg(2, "Points", "BOS", side="under"), self.w)
        self.assertLess(rho, 0)

    def test_fast_game_adds_pace(self):
        slow, _ = A.pair_correlation(self.leg(1, "Points", "BOS", gameTotal=212), self.leg(2, "Points", "MIA"), self.w)
        fast, why = A.pair_correlation(self.leg(1, "Points", "BOS", gameTotal=238), self.leg(2, "Points", "MIA"), self.w)
        self.assertGreater(fast, slow)
        self.assertIn("fast game", why)

    def test_different_games_are_independent(self):
        a, b = self.leg(1, "Assists", "BOS"), self.leg(2, "Points", "BOS")
        b["game"] = "LAL-DEN"
        self.assertEqual(A.pair_correlation(a, b, self.w), (0.0, None))

    def test_positive_correlation_raises_all_hit_chance(self):
        legs = [self.leg(1, "Assists", "BOS"), self.leg(2, "Threes", "BOS")] + [
            dict(prop(i), metrics=A.leg_metrics(prop(i), self.w)) for i in (3, 4)]
        dist, links = A.correlated_distribution(legs, self.w)
        indep = A.hit_distribution([l["metrics"]["p"] for l in legs])
        self.assertAlmostEqual(sum(dist), 1.0)
        self.assertGreater(dist[-1], indep[-1])
        self.assertEqual(len(links), 1)
        # Same mean number of hits: correlation moves variance, not expectation.
        self.assertAlmostEqual(sum(k * m for k, m in enumerate(dist)), sum(k * m for k, m in enumerate(indep)))

    def test_joint_probability_stays_valid(self):
        self.assertLessEqual(A.joint_both(0.9, 0.2, 0.99), 0.2)
        self.assertGreaterEqual(A.joint_both(0.6, 0.6, -0.99), 0.2 - 1e-9)


class Staking(unittest.TestCase):
    def setUp(self):
        self.w = A.load_weights(None)

    def test_kelly_zero_without_edge(self):
        self.assertEqual(A.kelly_fraction(A.hit_distribution([0.5] * 4), {"4": 10}), 0.0)

    def test_kelly_matches_closed_form_for_a_single_payout(self):
        # One outcome paying b-to-1 with chance p: f* = p - (1 - p) / b.
        p = 0.65 ** 4
        f = A.kelly_fraction(A.hit_distribution([0.65] * 4), {"4": 10})
        self.assertAlmostEqual(f, p - (1 - p) / 9, places=4)

    def test_stake_is_fractional_and_capped(self):
        bank = A.bankroll_state({}, self.w)
        stake = A.stake_for(A.hit_distribution([0.7] * 4), {"4": 10}, self.w, bank)
        self.assertLessEqual(stake["stakePct"], self.w["bankroll"]["max_stake_pct"])
        self.assertAlmostEqual(stake["stakeUnits"], 100 * stake["stakePct"], places=2)

    def test_drawdown_halves_stakes(self):
        w = self.w
        w["bankroll"]["max_stake_pct"] = 1.0
        losses = {"entries": [{"recordedAt": f"2026-10-0{i}", "type": "power", "size": 4, "stake": 10,
                               "legs": [{"result": "miss"}] + [{"result": "hit"}] * 3} for i in range(1, 4)]}
        bank = A.bankroll_state(losses, w)
        self.assertEqual(bank["current"], 70)
        self.assertAlmostEqual(bank["drawdown"], 0.3)
        dist = A.hit_distribution([0.7] * 4)
        fresh = A.stake_for(dist, {"4": 10}, w, A.bankroll_state({}, w))
        hurt = A.stake_for(dist, {"4": 10}, w, bank)
        self.assertAlmostEqual(hurt["stakePct"], fresh["stakePct"] / 2, places=3)

    def test_push_pays_as_smaller_entry(self):
        entry = {"type": "flex", "legs": [{"result": "push"}] + [{"result": "hit"}] * 3}
        self.assertEqual(A.entry_payout(entry, self.w), 1.0)  # no 3-leg flex table: refund
        entry = {"type": "flex", "legs": [{"result": "hit"}] * 3 + [{"result": "miss"}]}
        self.assertEqual(A.entry_payout(entry, self.w), 1.5)
        self.assertIsNone(A.entry_payout({"type": "flex", "legs": [{"result": None}]}, self.w))


class ClosingLine(unittest.TestCase):
    def test_clv_summary(self):
        legs = [{"metrics": {"fairProb": 0.58}, "closeFair": 0.61}, {"metrics": {"fairProb": 0.6}, "closeFair": 0.59},
                {"metrics": {"fairProb": 0.6}}]
        summary = A.clv_summary({"entries": [{"legs": legs}]})
        self.assertEqual(summary["legs"], 2)
        self.assertAlmostEqual(summary["average"], 0.01)
        self.assertEqual(summary["beatClose"], 0.5)

    def test_line_movement_from_market_log(self):
        leg = prop(1, price=-160)
        result = A.analyze({"props": [leg]}, A.load_weights(None), market_log={"p1": {"openPrice": -130, "firstSeen": "t0"}})
        metrics = result["legs"][0]["metrics"]
        self.assertEqual(metrics["openPrice"], -130)
        self.assertGreater(metrics["move"], 0, "steam toward this side")


def settled(n, rng, l5_split=0.8):
    """Legs where L5 >= l5_split hit 75% and the rest 35%."""
    legs = []
    for i in range(n):
        l5 = rng.choice([0.7, 0.8, 1.0])
        good = l5 >= l5_split
        hit = rng.random() < (0.75 if good else 0.35)
        legs.append({"id": f"s{i}", "market": rng.choice(["Points", "Rebounds"]), "result": "hit" if hit else "miss",
                     "metrics": {"juice": 140, "l5": l5, "floorMargin": 0.05, "volatility": 0.2,
                                 "p": 0.6, "fairProb": 0.57, "historyRate": 0.65}})
    return {"entries": [{"slipId": "x", "legs": legs}]}


class Learning(unittest.TestCase):
    def test_small_sample_changes_nothing(self):
        w = A.load_weights(None)
        new, report = A.learn(settled(10, random.Random(1)), w)
        self.assertEqual(new["filters"], w["filters"])
        self.assertEqual(report["changes"], [])

    def test_tightens_l5_when_low_l5_legs_miss(self):
        w = A.load_weights(None)
        new, report = A.learn(settled(200, random.Random(2)), w)
        self.assertGreater(new["filters"]["min_l5_hit_rate"], w["filters"]["min_l5_hit_rate"])
        self.assertLessEqual(new["filters"]["min_l5_hit_rate"], w["bounds"]["min_l5_hit_rate"][1])
        self.assertTrue(any(c["setting"] == "min_l5_hit_rate" for c in report["changes"]))
        self.assertEqual(new["version"], w["version"] + 1)

    def test_penalizes_market_that_keeps_missing(self):
        history = settled(60, random.Random(3), l5_split=0.0)
        for leg in history["entries"][0]["legs"]:
            if leg["market"] == "Rebounds":
                leg["result"] = "miss"
        new, _ = A.learn(history, A.load_weights(None))
        self.assertGreater(new["market_penalty"].get("rebounds", 0), 0)
        self.assertIn("rebounds", new["avoid_markets"])


class CommandLine(unittest.TestCase):
    def test_analyze_and_learn_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            scrape = os.path.join(tmp, "scrape.json")
            out = os.path.join(tmp, "result.json")
            with open(scrape, "w") as fh:
                json.dump({"props": [prop(i) for i in range(8)]}, fh)
            script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze.py")
            subprocess.run([sys.executable, script, "analyze", "--input", scrape, "--out", out], check=True)
            with open(out) as fh:
                self.assertEqual(json.load(fh)["counts"]["props"], 8)
            hist = os.path.join(tmp, "history.json")
            with open(hist, "w") as fh:
                json.dump({"entries": []}, fh)
            weights = os.path.join(tmp, "weights.json")
            subprocess.run([sys.executable, script, "learn", "--history", hist, "--out", weights,
                            "--report", os.path.join(tmp, "r.json")], check=True)
            self.assertTrue(os.path.exists(weights))


if __name__ == "__main__":
    unittest.main()


# A 7-for-10 hitter over 20.5 whose last 3, 4 and 5 games all average above the line.
STEADY = [24, 22, 19, 25, 23, 18, 26, 22, 17, 24]
SOFT = {"defenseRank": 28, "position": "PG", "minutes": [35, 34, 36, 33, 35]}


def steady(i, price=-119, recent=None, insights=SOFT, **extra):
    return prop(i, price=price, l5=0.8, recent=recent or STEADY, insights=insights, hitRates={"l5": 0.8, "l10": 0.7}, league="NBA", **extra)


class Consistency(unittest.TestCase):
    def setUp(self):
        self.w = A.load_weights(None)
        self.w["strategy"] = "consistency"

    def leg(self, raw):
        leg = dict(raw)
        leg["metrics"] = A.leg_metrics(leg, self.w)
        leg["rejected"], leg["variance"] = A.consistency_check(leg, leg["metrics"], self.w)
        return leg

    def test_rolling_windows_and_baseline(self):
        m = self.leg(steady(1))["metrics"]
        self.assertEqual([w["games"] for w in m["rolling"]], [3, 4, 5])
        self.assertAlmostEqual(m["rolling"][0]["avg"], 21.67, places=2)
        self.assertTrue(m["baselineVerified"])
        self.assertEqual(m["minutesFloor"], 33)
        # Last three under the line: the 3-game window fails.
        cold = self.leg(steady(2, recent=[18, 19, 20] + STEADY[3:]))
        self.assertFalse(cold["metrics"]["baselineVerified"])
        self.assertTrue(any("baseline" in r for r in cold["rejected"]))

    def test_standard_juice_band_and_hit_rate_band(self):
        self.assertEqual(self.leg(steady(1))["rejected"], [])
        self.assertTrue(any("outside -107 to -131" in r for r in self.leg(steady(2, price=-150))["rejected"]))
        hot = steady(3)
        hot["hitRates"] = {"l5": 1.0, "l10": 0.9}
        self.assertTrue(any("consistency band" in r for r in self.leg(hot)["rejected"]))
        short = steady(4, insights={**SOFT, "minutes": [20, 22, 21, 19, 22]})
        self.assertTrue(any("minutes floor" in r for r in self.leg(short)["rejected"]))

    def test_signals_move_the_hit_chance(self):
        base = self.leg(steady(1, insights=None))["metrics"]
        soft = self.leg(steady(1))["metrics"]
        tough = self.leg(steady(1, insights={"defenseRank": 2}))["metrics"]
        self.assertAlmostEqual(soft["p"] - base["p"], 0.02, places=3)
        self.assertAlmostEqual(tough["p"] - base["p"], -0.02, places=3)
        self.assertTrue(any("soft matchup" in s for s in soft["signals"]))
        # An under reads the same matchup the other way.
        under = self.leg(steady(1, side="under", line=26.5))["metrics"]
        self.assertLess(under["insightAdjust"], 0)
        full = self.leg(steady(1, insights={**SOFT, "pace": 103, "usage": 0.31, "potential": {"points": 30}}))["metrics"]
        self.assertLessEqual(full["insightAdjust"], self.w["insights"]["max_adjust"] + 1e-9)

    def test_boom_or_bust_leg_is_variance_not_anchor(self):
        swing = self.leg(steady(1, recent=[40, 30, 21, 35, 28, 8, 45, 22, 6, 38]))
        self.assertTrue(swing["variance"])

    def test_tickets_mix_anchors_with_at_most_one_variance_leg(self):
        props = [steady(i) for i in range(1, 7)]
        props.append(steady(7, recent=[40, 30, 21, 35, 28, 8, 45, 22, 6, 38]))
        result = A.analyze({"props": props}, self.w)
        self.assertEqual(result["strategy"], "consistency")
        tiers = {l["id"]: l["tier"] for l in result["legs"]}
        self.assertEqual(tiers["p7"], "variance")
        self.assertEqual(sum(1 for t in tiers.values() if t == "anchor"), 6)
        sizes = sorted({t["size"] for t in result["tickets"]})
        self.assertEqual(sizes, [4, 5, 6])
        for t in result["tickets"]:
            self.assertLessEqual(t["varianceLegs"], 1)
            by_id = {l["id"]: l for l in result["legs"]}
            dec = 1.0
            for leg_id in t["legs"]:
                dec *= A.decimal_odds(by_id[leg_id]["metrics"]["consensus"])
            self.assertAlmostEqual(t["decimal"], round(dec, 3), places=2)
            self.assertAlmostEqual(t["impliedProb"], 1 / dec, places=3)
            self.assertEqual(t["american"], A.american_from_decimal(dec))
            self.assertAlmostEqual(t["ev"], t["modelProb"] * dec - 1, places=2)

    def test_parlay_payout_for_the_bankroll(self):
        legs = [{"result": "hit", "takenPrice": -119}] * 3 + [{"result": "push", "takenPrice": -119}]
        self.assertAlmostEqual(A.entry_payout({"type": "parlay", "legs": legs}, self.w), A.decimal_odds(-119) ** 3)
        legs[0] = {"result": "miss", "takenPrice": -119}
        self.assertEqual(A.entry_payout({"type": "parlay", "legs": legs}, self.w), 0.0)
