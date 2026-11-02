"""python -m unittest discover tools/outlier-analytics"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402
import market_data as M  # noqa: E402

NOW = datetime(2026, 10, 24, 18, 0, tzinfo=timezone.utc)

ESPN_BOARD = {"events": [{"id": "401", "date": "2026-10-24T23:30Z", "competitions": [{
    "competitors": [
        {"homeAway": "home", "team": {"abbreviation": "DEN", "displayName": "Denver Nuggets", "name": "Nuggets", "location": "Denver"}},
        {"homeAway": "away", "team": {"abbreviation": "LAL", "displayName": "Los Angeles Lakers", "name": "Lakers", "location": "Los Angeles"}}],
    "odds": [{"provider": {"name": "ESPN BET"}, "overUnder": 232.5, "overOdds": -112, "underOdds": -108, "spread": -4.5,
              "homeTeamOdds": {"moneyLine": -180, "spreadOdds": -110}, "awayTeamOdds": {"moneyLine": 150, "spreadOdds": -110}}]}]}]}


def book(title, markets):
    return {"key": title.lower(), "title": title, "markets": markets}


def prop_market(player, line, over, under, key="player_rebounds"):
    return {"key": key, "outcomes": [{"name": "Over", "description": player, "price": over, "point": line},
                                     {"name": "Under", "description": player, "price": under, "point": line}]}


ODDS_EVENTS = [{"id": "ev1", "commence_time": "2026-10-24T23:30:00Z", "home_team": "Denver Nuggets", "away_team": "Los Angeles Lakers",
                "bookmakers": [
                    book("Pinnacle", [{"key": "totals", "outcomes": [{"name": "Over", "price": -105, "point": 232.5}, {"name": "Under", "price": -105, "point": 232.5}]},
                                      {"key": "h2h", "outcomes": [{"name": "Denver Nuggets", "price": -170}, {"name": "Los Angeles Lakers", "price": 155}]}]),
                    book("DraftKings", [{"key": "totals", "outcomes": [{"name": "Over", "price": -115, "point": 232.5}, {"name": "Under", "price": -105, "point": 232.5}]}]),
                ]}]

PROP_EVENT = {"id": "ev1", "commence_time": "2026-10-24T23:30:00Z", "home_team": "Denver Nuggets", "away_team": "Los Angeles Lakers",
              "bookmakers": [book("Pinnacle", [prop_market("Nikola Jokić", 11.5, -140, 120)]),
                             book("FanDuel", [prop_market("Nikola Jokic", 11.5, -150, 118)]),
                             book("DraftKings", [prop_market("Nikola Jokic", 11.5, -145, 115)])]}


ESPN_NESTED = {"events": [{"id": "402", "date": "2026-10-25T00:00Z", "competitions": [{
    "competitors": [{"homeAway": "home", "team": {"abbreviation": "BOS", "displayName": "Boston Celtics"}},
                    {"homeAway": "away", "team": {"abbreviation": "NYK", "displayName": "New York Knicks"}}],
    "odds": [{"provider": {"name": "ESPN BET"},
              "moneyline": {"home": {"close": {"odds": "-200"}}, "away": {"close": {"odds": "+165"}}},
              "pointSpread": {"home": {"close": {"line": "-5.5", "odds": "-110"}}, "away": {"close": {"line": "+5.5", "odds": "-110"}}},
              "total": {"over": {"close": {"line": "o224.5", "odds": "-110"}}, "under": {"close": {"line": "u224.5", "odds": "-110"}}}}]}]}]}


class FakeApi:
    """Stands in for the network: answers by URL and counts credits like the real one."""
    def __init__(self, remaining=500):
        self.remaining = remaining
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        if "site.api.espn.com" in url:
            return ESPN_BOARD, {}
        if url.split("?")[0].endswith("/events"):
            return [{"id": "ev1", "commence_time": "2026-10-24T23:30:00Z"}], {"x-requests-remaining": str(self.remaining)}
        markets = dict(p.split("=") for p in url.split("?")[1].split("&"))["markets"].split("%2C")
        regions = dict(p.split("=") for p in url.split("?")[1].split("&"))["regions"].split("%2C")
        self.remaining -= len(markets) * len(regions)
        body = PROP_EVENT if "/events/" in url else ODDS_EVENTS
        return body, {"X-Requests-Remaining": str(self.remaining)}


def fresh_db():
    return M.connect(":memory:")


class Feeds(unittest.TestCase):
    def test_espn_teams_totals_and_lines(self):
        db = fresh_db()
        n = M.ingest_espn(db, ESPN_BOARD, "NBA", M.now_iso(NOW))
        self.assertEqual(n, 6)
        self.assertEqual(M.team_abbr(db, "Denver Nuggets"), "DEN")
        game = db.execute("SELECT * FROM games").fetchone()
        self.assertEqual((game["game"], game["total"]), ("DEN-LAL", 232.5))
        spreads = {r["subject"]: r["line"] for r in db.execute("SELECT * FROM quotes WHERE market = 'Spread'")}
        self.assertEqual(spreads, {"DEN": -4.5, "LAL": 4.5})

    def test_espn_nested_odds_shape(self):
        db = fresh_db()
        self.assertEqual(M.ingest_espn(db, ESPN_NESTED, "NBA", M.now_iso(NOW)), 6)
        rows = {(r["market"], r["subject"], r["side"]): (r["line"], r["price"]) for r in db.execute("SELECT * FROM quotes")}
        self.assertEqual(rows[("Total", "game", "over")], (224.5, -110))
        self.assertEqual(rows[("Spread", "NYK", "cover")], (5.5, -110))
        self.assertEqual(rows[("Moneyline", "NYK", "win")], (None, 165))

    def test_odds_api_uses_espn_abbreviations_and_tracks_credits(self):
        db = fresh_db()
        api = FakeApi()
        cfg = dict(M.DEFAULT_CONFIG["odds_api"], prop_markets=["player_rebounds"])
        M.fetch_espn(db, M.DEFAULT_CONFIG["espn"], NOW, get=api)
        report = M.fetch_odds_api(db, cfg, "free-key", NOW, get=api)
        self.assertEqual(report["calls"], 3)  # main lines, free event list, one event's props
        self.assertEqual(M.meta_get(db, "odds_api_remaining"), str(500 - 6 - 2))
        games = {r["game"] for r in db.execute("SELECT DISTINCT game FROM quotes WHERE source = 'odds_api'")}
        self.assertEqual(games, {"DEN-LAL"}, "Odds API games keyed like Outlier's")
        self.assertTrue(all("apiKey=free-key" in u for u in api.urls if "the-odds-api" in u))

    def test_odds_api_saves_credits(self):
        db = fresh_db()
        api = FakeApi()
        cfg = M.DEFAULT_CONFIG["odds_api"]
        self.assertIn("ODDS_API_KEY", M.fetch_odds_api(db, cfg, "", NOW, get=api)["skipped"])
        M.fetch_odds_api(db, cfg, "k", NOW, get=api)
        again = M.fetch_odds_api(db, cfg, "k", NOW + timedelta(minutes=5), get=api)
        self.assertIn("minutes ago", again["skipped"])
        M.meta_set(db, "odds_api_remaining", "52")
        later = M.fetch_odds_api(db, cfg, "k", NOW + timedelta(hours=2), get=api)
        self.assertEqual(later["calls"], 0, "never dips under the reserve")


class CrossReference(unittest.TestCase):
    def setUp(self):
        self.db = fresh_db()
        self.cfg = M.load_config(None)
        M.ingest_espn(self.db, ESPN_BOARD, "NBA", M.now_iso(NOW))
        M.ingest_odds_api(self.db, ODDS_EVENTS, "NBA", M.now_iso(NOW))
        M.ingest_odds_api(self.db, PROP_EVENT, "NBA", M.now_iso(NOW))
        M.ingest_boards(self.db, [{"source": "oddsboard.example", "props": [
            {"player": "Nikola Jokic", "market": "Rebounds", "line": 11.5, "side": "over", "odds": [{"book": "BetMGM", "price": -125}]}]}],
            M.now_iso(NOW))

    def line(self, market, subject=None):
        return next(l for l in M.cross_reference(self.db, self.cfg, NOW) if l["market"] == market and (subject is None or l["subject"] == subject))

    def test_no_vig_prefers_sharp_books(self):
        total = self.line("Total")
        self.assertEqual(total["fairFrom"], "sharp")
        self.assertAlmostEqual(total["fair"]["over"], 0.5)  # Pinnacle -105/-105
        dk = next(b for b in total["books"] if b["book"] == "draftkings")
        self.assertAlmostEqual(dk["hold"], round(M.implied(-115) + M.implied(-105) - 1, 4))
        self.assertEqual(total["books"][0]["book"], "pinnacle", "lowest hold first")

    def test_best_price_and_edge(self):
        reb = self.line("Rebounds", "nikola jokic")
        self.assertEqual(reb["best"]["over"]["price"], -125)
        self.assertEqual(reb["best"]["over"]["book"], "betmgm", "scraped board joins the API books")
        self.assertGreater(reb["best"]["over"]["edge"], 0)
        self.assertEqual(reb["sources"], ["board:oddsboard.example", "odds_api"])

    def test_moneyline_and_spread_pair_the_two_teams(self):
        ml = [l for l in M.cross_reference(self.db, self.cfg, NOW) if l["market"] == "Moneyline"]
        self.assertEqual(len(ml), 1)
        self.assertEqual(ml[0]["sides"], ["DEN", "LAL"])
        self.assertAlmostEqual(sum(ml[0]["fair"].values()), 1.0)
        spread = self.line("Spread")
        self.assertEqual(spread["line"], 4.5)

    def test_old_quotes_are_ignored(self):
        self.assertEqual(M.cross_reference(self.db, self.cfg, NOW + timedelta(hours=7)), [])

    def test_enrich_feeds_analyze(self):
        props = [{"id": "x", "player": "Nikola Jokic", "market": "Rebounds", "line": 11.5, "side": "over", "game": "DEN-LAL",
                  "odds": [{"book": "fanduel", "price": -148}], "hitRates": {"l5": 0.8}, "recent": [14, 13, 12, 15, 13]}]
        self.assertEqual(M.enrich(props, self.db, self.cfg, NOW), 1)
        p = props[0]
        self.assertEqual(p["gameTotal"], 232.5)
        self.assertEqual({o["book"] for o in p["odds"]}, {"fanduel", "pinnacle", "draftkings", "betmgm"})
        self.assertEqual([o["price"] for o in p["odds"] if o["book"] == "fanduel"], [-148], "site's own price kept")
        self.assertEqual(len(p["oppositeOdds"]), 3)
        self.assertEqual(p["marketFairFrom"], "sharp")
        self.assertAlmostEqual(p["marketFair"], round(M.implied(-140) / (M.implied(-140) + M.implied(120)), 4))
        metrics = A.leg_metrics(p, A.load_weights(None))
        self.assertEqual(metrics["fairProb"], p["marketFair"])
        self.assertEqual(metrics["fairSource"], "sharp")
        self.assertEqual(metrics["books"], 4)

    def test_summary_lists_edges_and_book_holds(self):
        s = M.summary(self.db, self.cfg, NOW)
        self.assertGreater(s["lines"], 3)
        self.assertEqual(s["bookHold"][0]["book"], "pinnacle")
        self.assertTrue(all(e["edge"] > 0 for e in s["bestEdges"]))


class Names(unittest.TestCase):
    def test_names_and_markets(self):
        self.assertEqual(M.norm_name("Nikola Jokić Jr."), "nikola jokic")
        self.assertEqual(M.canon_market("PRA"), "pts+reb+ast")
        self.assertEqual(M.canon_market("3-Pointers Made"), "threes")


class CommandLine(unittest.TestCase):
    def test_ingest_enrich_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "m.db")
            boards = os.path.join(tmp, "b.json")
            scrape = os.path.join(tmp, "s.json")
            with open(boards, "w") as fh:
                json.dump([{"source": "x", "props": [{"player": "A B", "market": "Points", "line": 20.5, "side": "over",
                                                      "odds": [{"book": "bk1", "price": -120}], "oppositeOdds": [{"book": "bk1", "price": 100}]}]}], fh)
            with open(scrape, "w") as fh:
                json.dump({"props": [{"player": "A B", "market": "Points", "line": 20.5, "side": "over", "odds": []}]}, fh)
            M.main(["ingest", "--db", db, "--input", boards, "--out", os.path.join(tmp, "o.json")])
            M.main(["enrich", "--db", db, "--input", scrape])
            with open(scrape) as fh:
                self.assertEqual(json.load(fh)["market"]["matched"], 1)
            M.main(["summary", "--db", db, "--out", os.path.join(tmp, "sum.json"), "--csv", os.path.join(tmp, "l.csv")])
            self.assertTrue(os.path.exists(os.path.join(tmp, "l.csv")))


if __name__ == "__main__":
    unittest.main()
