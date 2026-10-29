#!/usr/bin/env python3
"""Free market odds for the Outlier pipeline: pulls lines from The Odds API's
free tier and ESPN's public scoreboard JSON, takes in what CoDev's browser read
off public odds-comparison pages, keeps every quote in one SQLite file, and
cross-references the books: no-vig fair price, each book's hold, the best price
per side. Standard library only (pandas is used for --csv only if installed).

    python market_data.py fetch   --db market.db [--config market.json]   # ODDS_API_KEY in the environment
    python market_data.py ingest  --db market.db --input boards.json      # props read off public pages
    python market_data.py enrich  --db market.db --input latest-scrape.json --out latest-scrape.json
    python market_data.py summary --db market.db [--out summary.json] [--csv lines.csv]

`enrich` adds every book's price for the same player, market and line to each
Outlier prop, plus `marketFair` (the no-vig chance, from sharp books when they
have the line) and the game total, so analyze.py works from the whole market
instead of one site's number.

The Odds API free tier is 500 credits a month. A main-lines call costs one
credit per market per region and a player-props call the same per event, so
fetch spends carefully: it waits `min_minutes_between` between fetches, never
dips under `reserve_credits`, and props are off until you list markets.
"""
import argparse
import json
import os
import sqlite3
import statistics
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ODDS_API = "https://api.the-odds-api.com/v4"
ESPN = "https://site.api.espn.com/apis/site/v2/sports"

DEFAULT_CONFIG = {
    "odds_api": {
        "enabled": True,
        "sports": ["basketball_nba"],
        "regions": "us,eu",
        "main_markets": ["h2h", "spreads", "totals"],
        # e.g. ["player_points", "player_rebounds", "player_assists"]; each costs credits per event.
        "prop_markets": [],
        "max_prop_events": 2,
        "min_minutes_between": 30,
        "reserve_credits": 50,
    },
    "espn": {"enabled": True, "leagues": ["basketball/nba"]},
    # Books whose no-vig price is trusted over the crowd when they have the line.
    "sharp_books": ["pinnacle", "circa", "betonline", "bookmaker", "lowvig", "novig", "prophetx", "sporttrade"],
    "max_age_hours": 6,
}

SPORT_LEAGUE = {
    "basketball_nba": "NBA", "basketball_wnba": "WNBA", "basketball_ncaab": "NCAAB", "americanfootball_nfl": "NFL",
    "americanfootball_ncaaf": "NCAAF", "baseball_mlb": "MLB", "icehockey_nhl": "NHL",
    "basketball/nba": "NBA", "basketball/wnba": "WNBA", "basketball/mens-college-basketball": "NCAAB",
    "football/nfl": "NFL", "football/college-football": "NCAAF", "baseball/mlb": "MLB", "hockey/nhl": "NHL",
}

# The Odds API's market keys -> the names Outlier uses (canon_market below).
API_MARKETS = {
    "h2h": "Moneyline", "spreads": "Spread", "totals": "Total",
    "player_points": "Points", "player_rebounds": "Rebounds", "player_assists": "Assists", "player_threes": "Threes",
    "player_points_rebounds_assists": "Pts+Reb+Ast", "player_points_rebounds": "Pts+Reb", "player_points_assists": "Pts+Ast",
    "player_rebounds_assists": "Reb+Ast", "player_steals": "Steals", "player_blocks": "Blocks", "player_turnovers": "Turnovers",
    "player_pass_yds": "Passing Yards", "player_pass_tds": "Passing Tds", "player_pass_completions": "Completions",
    "player_pass_attempts": "Pass Attempts", "player_rush_yds": "Rushing Yards", "player_reception_yds": "Receiving Yards",
    "player_receptions": "Receptions", "player_rush_reception_yds": "Rush+Rec Yards",
    "batter_hits": "Hits", "batter_total_bases": "Total Bases", "batter_home_runs": "Home Runs", "batter_rbis": "Rbis",
    "batter_hits_runs_rbis": "Hits+Runs+Rbis", "pitcher_strikeouts": "Strikeouts", "pitcher_outs": "Outs Recorded",
    "player_shots_on_goal": "Shots On Goal", "player_goals": "Goals", "player_total_saves": "Saves",
}

# Spellings seen across sites -> one name.
MARKET_ALIASES = {
    "pra": "pts+reb+ast", "pts + reb + ast": "pts+reb+ast", "points + rebounds + assists": "pts+reb+ast",
    "points rebounds assists": "pts+reb+ast", "3-pointers made": "threes", "3pt made": "threes", "three pointers": "threes",
    "3-pt made": "threes", "made threes": "threes", "pass yards": "passing yards", "pass tds": "passing tds",
    "rush yards": "rushing yards", "rec yards": "receiving yards", "pitcher strikeouts": "strikeouts",
    "player points": "points", "player rebounds": "rebounds", "player assists": "assists",
}

TWO_SIDED = ("over", "under")


def now_iso(now=None):
    return (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat()


def norm_name(name):
    """'Nikola Jokić Jr.' -> 'nikola jokic'."""
    text = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().lower()
    words = [w for w in "".join(c if c.isalnum() or c.isspace() else " " for c in text).split() if w not in ("jr", "sr", "ii", "iii", "iv")]
    return " ".join(words)


def canon_market(name):
    key = " ".join(str(name or "").lower().split())
    return MARKET_ALIASES.get(key, key)


def implied(price):
    price = float(price)
    return -price / (-price + 100.0) if price < 0 else 100.0 / (price + 100.0)


def to_american(prob):
    prob = min(max(prob, 1e-6), 1 - 1e-6)
    return -round(prob / (1 - prob) * 100) if prob >= 0.5 else round((1 - prob) / prob * 100)


def rnd(value, places=4):
    return None if value is None else round(value, places)


# ---- storage ---------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS quotes (
    source TEXT, fetched_at TEXT, league TEXT, game TEXT, event_id TEXT, commence TEXT,
    market TEXT, subject TEXT, side TEXT, line REAL, book TEXT, price REAL
);
CREATE INDEX IF NOT EXISTS quotes_line ON quotes (market, subject, line);
CREATE INDEX IF NOT EXISTS quotes_time ON quotes (fetched_at);
CREATE TABLE IF NOT EXISTS teams (name TEXT PRIMARY KEY, abbr TEXT, league TEXT);
CREATE TABLE IF NOT EXISTS games (game TEXT, league TEXT, commence TEXT, home TEXT, away TEXT, total REAL, source TEXT, fetched_at TEXT,
    PRIMARY KEY (game, source));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def connect(path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def meta_get(db, key, default=None):
    row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def meta_set(db, key, value):
    db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, str(value)))


def add_quote(db, **q):
    if q.get("price") is None:
        return
    db.execute("INSERT INTO quotes (source, fetched_at, league, game, event_id, commence, market, subject, side, line, book, price) "
               "VALUES (:source, :fetched_at, :league, :game, :event_id, :commence, :market, :subject, :side, :line, :book, :price)",
               {k: q.get(k) for k in ("source", "fetched_at", "league", "game", "event_id", "commence", "market", "subject", "side", "line", "book", "price")})


def prune(db, now, keep_days=3):
    db.execute("DELETE FROM quotes WHERE fetched_at < ?", (now_iso(now - timedelta(days=keep_days)),))


def team_abbr(db, name):
    if not name:
        return None
    row = db.execute("SELECT abbr FROM teams WHERE name = ?", (norm_name(name),)).fetchone()
    return row["abbr"] if row else norm_name(name).upper().replace(" ", "_")


def game_key(a, b):
    return "-".join(sorted([a, b])) if a and b else None


# ---- The Odds API ----------------------------------------------------------

def fetch_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "CoDev-Studio/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8")), dict(resp.headers)


def ingest_odds_api(db, events, league, fetched_at):
    """The Odds API's /odds or /events/{id}/odds JSON -> quotes."""
    count = 0
    for ev in events if isinstance(events, list) else [events]:
        home, away = team_abbr(db, ev.get("home_team")), team_abbr(db, ev.get("away_team"))
        game = game_key(home, away)
        for bm in ev.get("bookmakers", []):
            book = norm_name(bm.get("title") or bm.get("key"))
            for mk in bm.get("markets", []):
                market = API_MARKETS.get(mk.get("key"), mk.get("key"))
                for out in mk.get("outcomes", []):
                    name = out.get("name")
                    if mk.get("key") == "h2h":
                        subject, side, line = team_abbr(db, name), "win", None
                    elif mk.get("key") == "spreads":
                        subject, side, line = team_abbr(db, name), "cover", out.get("point")
                    elif mk.get("key") == "totals":
                        subject, side, line = "game", str(name).lower(), out.get("point")
                    else:
                        subject, side, line = norm_name(out.get("description")), str(name).lower(), out.get("point")
                    add_quote(db, source="odds_api", fetched_at=fetched_at, league=league, game=game, event_id=ev.get("id"),
                              commence=ev.get("commence_time"), market=market, subject=subject, side=side, line=line,
                              book=book, price=out.get("price"))
                    count += 1
    return count


def fetch_odds_api(db, cfg, key, now, get=fetch_json):
    report = {"source": "odds_api", "calls": 0, "quotes": 0, "skipped": None}
    if not cfg.get("enabled"):
        report["skipped"] = "off"
        return report
    if not key:
        report["skipped"] = "no ODDS_API_KEY (free at the-odds-api.com)"
        return report
    last = meta_get(db, "odds_api_last")
    if last and now - datetime.fromisoformat(last) < timedelta(minutes=cfg["min_minutes_between"]):
        report["skipped"] = f"fetched under {cfg['min_minutes_between']} minutes ago (saving free credits)"
        return report
    remaining = meta_get(db, "odds_api_remaining")
    regions = cfg["regions"]
    n_regions = len(regions.split(","))

    def can_spend(cost):
        return remaining is None or float(remaining) - cost >= cfg["reserve_credits"]

    def call(path, **params):
        nonlocal remaining
        params["apiKey"] = key
        data, headers = get(f"{ODDS_API}{path}?{urllib.parse.urlencode(params)}")
        report["calls"] += 1
        lower = {k.lower(): v for k, v in headers.items()}
        if "x-requests-remaining" in lower:
            remaining = lower["x-requests-remaining"]
            meta_set(db, "odds_api_remaining", remaining)
        return data

    fetched_at = now_iso(now)
    for sport in cfg["sports"]:
        league = SPORT_LEAGUE.get(sport, sport)
        cost = len(cfg["main_markets"]) * n_regions
        if cfg["main_markets"] and can_spend(cost):
            events = call(f"/sports/{sport}/odds", regions=regions, markets=",".join(cfg["main_markets"]), oddsFormat="american")
            report["quotes"] += ingest_odds_api(db, events, league, fetched_at)
        if cfg["prop_markets"]:
            # The event list is free; props cost per event, so only the soonest few.
            events = call(f"/sports/{sport}/events")
            upcoming = sorted((e for e in events if e.get("commence_time", "") > fetched_at), key=lambda e: e["commence_time"])
            for ev in upcoming[: cfg["max_prop_events"]]:
                if not can_spend(len(cfg["prop_markets"]) * n_regions):
                    report["skipped"] = f"props stopped to keep {cfg['reserve_credits']} credits in reserve"
                    break
                data = call(f"/sports/{sport}/events/{ev['id']}/odds", regions=regions, markets=",".join(cfg["prop_markets"]), oddsFormat="american")
                report["quotes"] += ingest_odds_api(db, data, league, fetched_at)
    meta_set(db, "odds_api_last", fetched_at)
    report["remaining"] = remaining
    return report


# ---- ESPN public scoreboard ------------------------------------------------

# ESPN has two shapes for odds: flat (overOdds, homeTeamOdds.moneyLine) and
# nested ({"moneyline": {"home": {"close": {"odds": "-180"}}}}); both are read.
def espn_close(odds, market, side, field):
    node = ((odds.get(market) or {}).get(side) or {})
    return (node.get("close") or node.get("open") or {}).get(field)


def espn_price(value):
    try:
        price = float(str(value).replace("+", ""))
    except ValueError:
        return None
    return None if -100 < price < 100 else price


def espn_line(value):
    """"o232.5" / "-4.5" / "+4.5" -> number."""
    if value is None:
        return None
    try:
        return float(str(value).lstrip("ou").replace("+", ""))
    except ValueError:
        return None


def ingest_espn(db, board, league, fetched_at):
    """ESPN scoreboard JSON -> team names, game totals, and the odds it lists."""
    count = 0
    for ev in board.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        sides = {}
        for c in comp.get("competitors", []):
            team = c.get("team", {})
            abbr = team.get("abbreviation")
            if not abbr:
                continue
            sides[c.get("homeAway")] = abbr
            for name in (team.get("displayName"), team.get("shortDisplayName"), team.get("name"), team.get("location"), abbr):
                if name:
                    db.execute("INSERT OR REPLACE INTO teams (name, abbr, league) VALUES (?, ?, ?)", (norm_name(name), abbr, league))
        home, away = sides.get("home"), sides.get("away")
        game = game_key(home, away)
        if not game:
            continue
        total = None
        for odds in comp.get("odds", []) or []:
            book = norm_name((odds.get("provider") or {}).get("name") or "espn bet")
            q = dict(source="espn", fetched_at=fetched_at, league=league, game=game, event_id=ev.get("id"), commence=ev.get("date"), book=book)
            if odds.get("overUnder") is not None:
                total = float(odds["overUnder"])
            for side in ("over", "under"):
                price = odds.get(f"{side}Odds", espn_close(odds, "total", side, "odds"))
                line = total if total is not None else espn_line(espn_close(odds, "total", side, "line"))
                if price is not None and line is not None:
                    add_quote(db, **q, market="Total", subject="game", side=side, line=line, price=espn_price(price))
                    count += 1
                if total is None and line is not None:
                    total = line
            for where, team in (("home", home), ("away", away)):
                o = odds.get(f"{where}TeamOdds") or {}
                ml = o.get("moneyLine", espn_close(odds, "moneyline", where, "odds"))
                if ml is not None:
                    add_quote(db, **q, market="Moneyline", subject=team, side="win", line=None, price=espn_price(ml))
                    count += 1
                spread_price = o.get("spreadOdds", espn_close(odds, "pointSpread", where, "odds"))
                if odds.get("spread") is not None:
                    line = float(odds["spread"]) if where == "home" else -float(odds["spread"])
                else:
                    line = espn_line(espn_close(odds, "pointSpread", where, "line"))
                if spread_price is not None and line is not None:
                    add_quote(db, **q, market="Spread", subject=team, side="cover", line=line, price=espn_price(spread_price))
                    count += 1
        db.execute("INSERT OR REPLACE INTO games (game, league, commence, home, away, total, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, 'espn', ?)",
                   (game, league, ev.get("date"), home, away, total, fetched_at))
    return count


def fetch_espn(db, cfg, now, get=fetch_json):
    report = {"source": "espn", "calls": 0, "quotes": 0, "skipped": None}
    if not cfg.get("enabled"):
        report["skipped"] = "off"
        return report
    for path in cfg["leagues"]:
        board, _ = get(f"{ESPN}/{path}/scoreboard")
        report["calls"] += 1
        report["quotes"] += ingest_espn(db, board, SPORT_LEAGUE.get(path, path), now_iso(now))
    return report


# ---- public odds boards (read by CoDev's browser) --------------------------

def ingest_boards(db, boards, fetched_at):
    """Props the Node scraper parsed off public pages: [{source, props: [...]}]."""
    count = 0
    for board in boards:
        source = f"board:{board.get('source') or 'page'}"
        for p in board.get("props", []):
            side = (p.get("side") or "over").lower()
            for o in p.get("odds", []):
                add_quote(db, source=source, fetched_at=fetched_at, league=p.get("league"), game=p.get("game"), event_id=None,
                          commence=None, market=canon_market(p.get("market")).title(), subject=norm_name(p.get("player")),
                          side=side, line=p.get("line"), book=norm_name(o.get("book") or board.get("source") or "board"), price=o.get("price"))
                count += 1
            for o in p.get("oppositeOdds", []) or []:
                add_quote(db, source=source, fetched_at=fetched_at, league=p.get("league"), game=p.get("game"), event_id=None,
                          commence=None, market=canon_market(p.get("market")).title(), subject=norm_name(p.get("player")),
                          side="under" if side == "over" else "over", line=p.get("line"),
                          book=norm_name(o.get("book") or board.get("source") or "board"), price=o.get("price"))
                count += 1
    return count


# ---- cross-referencing -----------------------------------------------------

def latest_quotes(db, since):
    """The newest quote per book for each market, subject, side and line."""
    rows = db.execute("""
        SELECT q.* FROM quotes q
        JOIN (SELECT market, subject, side, IFNULL(line, 'x') AS l, book, IFNULL(game, '') AS g, MAX(fetched_at) AS t
              FROM quotes WHERE fetched_at >= ? GROUP BY market, subject, side, l, book, g) newest
          ON q.market = newest.market AND q.subject = newest.subject AND q.side = newest.side
         AND IFNULL(q.line, 'x') = newest.l AND q.book = newest.book AND IFNULL(q.game, '') = newest.g AND q.fetched_at = newest.t
    """, (since,)).fetchall()
    return [dict(r) for r in rows]


def line_key(q):
    """Quotes with the same key are the two sides of one bet."""
    market = canon_market(q["market"])
    if q["side"] in TWO_SIDED:
        return (market, q["subject"], q["line"], q["game"] if q["subject"] == "game" else None)
    # Moneyline / spread: the two teams are the two sides; a spread's line flips sign.
    return (market, None, abs(q["line"]) if q["line"] is not None else None, q["game"])


def side_label(q):
    return q["side"] if q["side"] in TWO_SIDED else q["subject"]


def cross_reference(db, cfg, now):
    """Every line with its books: no-vig fair per side, each book's hold, best prices."""
    since = now_iso(now - timedelta(hours=cfg["max_age_hours"]))
    sharp = set(cfg["sharp_books"])
    groups = {}
    for q in latest_quotes(db, since):
        groups.setdefault(line_key(q), []).append(q)
    lines = []
    for key, quotes in groups.items():
        sides = sorted({side_label(q) for q in quotes})
        if len(sides) > 2:
            continue
        books = {}
        for q in quotes:
            books.setdefault(q["book"], {})[side_label(q)] = q["price"]
        per_book, fair_all, fair_sharp = [], [], []
        for book, prices in books.items():
            entry = {"book": book, "prices": prices, "sharp": book in sharp}
            if len(sides) == 2 and all(s in prices for s in sides):
                a, b = implied(prices[sides[0]]), implied(prices[sides[1]])
                entry["hold"] = rnd(a + b - 1)
                entry["fair"] = rnd(a / (a + b))
                fair_all.append(a / (a + b))
                if book in sharp:
                    fair_sharp.append(a / (a + b))
            per_book.append(entry)
        fair = statistics.fmean(fair_sharp) if fair_sharp else (statistics.median(fair_all) if fair_all else None)
        best = {}
        for side in sides:
            offers = [(p[side], b) for b, p in books.items() if side in p]
            # Best price = highest payout (decimal odds).
            price, book = max(offers, key=lambda o: 1 + o[0] / 100 if o[0] > 0 else 1 + 100 / -o[0])
            fair_side = None if fair is None else (fair if side == sides[0] else 1 - fair)
            best[side] = {"book": book, "price": price,
                          "edge": rnd(fair_side - implied(price)) if fair_side is not None else None}
        sample = quotes[0]
        lines.append({
            "market": sample["market"], "subject": key[1] or None, "line": sample["line"] if sample["side"] in TWO_SIDED else key[2],
            "game": sample["game"], "league": sample["league"], "sides": sides,
            "fair": {sides[0]: rnd(fair), sides[1]: rnd(1 - fair)} if fair is not None and len(sides) == 2 else None,
            "fairFrom": "sharp" if fair_sharp else "all books" if fair_all else None,
            "books": sorted(per_book, key=lambda e: e.get("hold") if e.get("hold") is not None else 9),
            "best": best,
            "sources": sorted({q["source"] for q in quotes}),
        })
    return lines


def enrich(props, db, cfg, now):
    """Add the market's books, no-vig fair and game total to Outlier props."""
    lines = cross_reference(db, cfg, now)
    by_prop = {}
    for line in lines:
        if line["subject"] and line["sides"] == ["over", "under"]:
            by_prop[(canon_market(line["market"]), line["subject"], float(line["line"]))] = line
    totals = {r["game"]: r["total"] for r in db.execute("SELECT game, total FROM games WHERE total IS NOT NULL")}
    matched = 0
    for p in props:
        if p.get("game") and not p.get("gameTotal") and totals.get(p["game"]):
            p["gameTotal"] = totals[p["game"]]
        if p.get("line") is None:
            continue
        line = by_prop.get((canon_market(p.get("market")), norm_name(p.get("player")), float(p["line"])))
        if not line:
            continue
        side = (p.get("side") or "over").lower()
        other = "under" if side == "over" else "over"
        # A book the site already quotes keeps the site's price.
        have = {norm_name(o.get("book")) for o in p.get("odds", []) if o.get("book")}
        p.setdefault("odds", [])
        p.setdefault("oppositeOdds", [])
        for b in line["books"]:
            if side in b["prices"] and b["book"] not in have:
                p["odds"].append({"book": b["book"], "price": b["prices"][side], "source": "market"})
            if other in b["prices"]:
                p["oppositeOdds"].append({"book": b["book"], "price": b["prices"][other], "source": "market"})
        if line["fair"]:
            p["marketFair"] = line["fair"][side]
            p["marketFairFrom"] = line["fairFrom"]
        p["bestPrice"] = line["best"].get(side)
        p["marketBooks"] = len(line["books"])
        matched += 1
    return matched


def summary(db, cfg, now, top=15):
    lines = cross_reference(db, cfg, now)
    rows = db.execute("SELECT source, COUNT(*) AS n, MAX(fetched_at) AS last, COUNT(DISTINCT book) AS books FROM quotes GROUP BY source").fetchall()
    edges = []
    for line in lines:
        for side, best in line["best"].items():
            if best.get("edge") is not None and best["edge"] > 0:
                edges.append({"market": line["market"], "subject": line["subject"], "game": line["game"], "line": line["line"],
                              "side": side, "book": best["book"], "price": best["price"], "edge": best["edge"],
                              "fairPrice": to_american(line["fair"][side]) if line["fair"] else None, "books": len(line["books"])})
    edges.sort(key=lambda e: e["edge"], reverse=True)
    holds = [b["hold"] for line in lines for b in line["books"] if b.get("hold") is not None]
    by_book = {}
    for line in lines:
        for b in line["books"]:
            if b.get("hold") is not None:
                by_book.setdefault(b["book"], []).append(b["hold"])
    return {
        "generatedAt": now_iso(now),
        "sources": [dict(r) for r in rows],
        "lines": len(lines),
        "oddsApiRemaining": meta_get(db, "odds_api_remaining"),
        "oddsApiLast": meta_get(db, "odds_api_last"),
        "averageHold": rnd(statistics.fmean(holds)) if holds else None,
        # Lower hold = sharper book for these lines.
        "bookHold": sorted(({"book": b, "hold": rnd(statistics.fmean(h)), "lines": len(h)} for b, h in by_book.items()), key=lambda r: r["hold"]),
        "bestEdges": edges[:top],
    }


# ---- command line ----------------------------------------------------------

def load_config(path):
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            saved = json.load(fh)
        for key, value in saved.items():
            if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                cfg[key].update(value)
            else:
                cfg[key] = value
    return cfg


def write_json(path, data):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=["fetch", "ingest", "enrich", "summary"])
    parser.add_argument("--db", required=True)
    parser.add_argument("--config")
    parser.add_argument("--input")
    parser.add_argument("--out")
    parser.add_argument("--csv")
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    now = datetime.now(timezone.utc)
    db = connect(args.db)
    try:
        if args.command == "fetch":
            reports = []
            # ESPN first: its team names let Odds API games use the same keys as Outlier.
            for fn in (lambda: fetch_espn(db, cfg["espn"], now), lambda: fetch_odds_api(db, cfg["odds_api"], os.environ.get("ODDS_API_KEY", "").strip(), now)):
                try:
                    reports.append(fn())
                except Exception as err:  # one feed down shouldn't stop the other
                    reports.append({"error": f"{type(err).__name__}: {err}"})
                db.commit()
            prune(db, now)
            db.commit()
            out = {"fetchedAt": now_iso(now), "feeds": reports}
        elif args.command == "ingest":
            with open(args.input, encoding="utf-8") as fh:
                boards = json.load(fh)
            out = {"quotes": ingest_boards(db, boards, now_iso(now))}
            db.commit()
        elif args.command == "enrich":
            with open(args.input, encoding="utf-8") as fh:
                scrape = json.load(fh)
            matched = enrich(scrape.get("props", []), db, cfg, now)
            scrape["market"] = {"matched": matched, "at": now_iso(now)}
            write_json(args.out or args.input, scrape)
            out = {"matched": matched}
            args.out = None
        else:
            out = summary(db, cfg, now)
            if args.csv:
                rows = [{"market": l["market"], "subject": l["subject"], "game": l["game"], "line": l["line"], "book": b["book"],
                         **{f"price_{s}": b["prices"].get(s) for s in l["sides"]}, "hold": b.get("hold"), "fair": b.get("fair")}
                        for l in cross_reference(db, cfg, now) for b in l["books"]]
                try:
                    import pandas as pd  # optional
                    pd.DataFrame(rows).to_csv(args.csv, index=False)
                except ImportError:
                    import csv
                    with open(args.csv, "w", newline="", encoding="utf-8") as fh:
                        keys = sorted({k for r in rows for k in r})
                        w = csv.DictWriter(fh, fieldnames=keys)
                        w.writeheader()
                        w.writerows(rows)
        if args.out:
            write_json(args.out, out)
        else:
            json.dump(out, sys.stdout, indent=2)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
