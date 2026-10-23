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
    def test_builds_4_and_6_leg_entries_with_limits(self):
        props = [prop(i, price=-140 - 5 * i) for i in range(10)]
        props.append(prop(99, player="Player 0", price=-300))  # same player as p0
        result = A.analyze({"props": props}, A.load_weights(None))
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
