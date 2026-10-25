# Outlier analytics

`analyze.py` scores the props CoDev reads from your Outlier pages and builds 4- and 6-leg entries. It needs Python 3 and nothing else. CoDev's server runs it for you from the **📈 Outlier** view; you can also run it yourself:

```
python analyze.py analyze --input latest-scrape.json --weights weights.json --out result.json
python analyze.py learn --history history.json --weights weights.json --out weights.json --report learn.json
python -m unittest discover tools/outlier-analytics
```

The files CoDev writes are in `%APPDATA%\codev-server\outlier` on Windows and `~/.config/codev-server/outlier` elsewhere.

## What each prop gets

| Metric | How |
| --- | --- |
| Consensus odds | The site's consensus if it shows one, else the median of the books' prices |
| Fair probability | Consensus with the vig removed (both sides when the other side's price is there, else an assumed 4.5% vig) |
| L5 | The site's L5 hit rate, else counted from the last five games |
| Floor | For an over, the 20th-percentile game of the last ten vs. the line (for an under, the 80th percentile); +10% means even a bad game clears the line by 10% |
| Volatility | Standard deviation / mean of the last ten games; high means boom-or-bust |
| Hit chance | Fair probability blended with the hit rate (shrunk toward the market when there are few games), minus any penalty for a market that keeps missing |

A prop makes the cut when its odds are at least as juiced as `-min_juice` (‑130 to start), L5 ≥ 70%, floor ≥ 0, volatility ≤ 0.35 and hit chance ≥ 56%. Entries are 4-leg Power and Flex by default (turn 6-leg on in the view): the best-scoring props, at most one per player and two per game or team, ranked by expected value from the payout tables in `weights.default.json`. **Check those payouts against your app**: they change, and EV depends on them.

The view also shows where each prop's odds opened (`market-log.json` keeps every price seen, with its time).

## Consistency strategy (-119)

Switch **Strategy** in the view to *Consistency* (or set `"strategy": "consistency"` in `weights.json`). Instead of the sharp filter's heavy juice and 70% L5, it looks for props priced near standard juice whose players hit at a steady clip:

| Check | Default (`weights.consistency`) |
| --- | --- |
| Price | -119 ± 12 (-107 to -131) |
| Hit rate | L10 (else L5) between 60% and 75% |
| Rolling baseline | the last 3, 4 and 5 games each average past the line and hit at least 60% |
| Minutes floor | the lowest of the last 5 games' minutes ≥ 24, when the page shows minutes |
| Edge | estimated hit chance at least 2 points above the price's implied chance |

A prop that passes but swings a lot (floor more than 15% past the line, or volatility over 0.30) is a **variance** leg instead of a **high-floor** one.

## Matchup, usage, pace and volume

When Outlier shows them, the parser reads defense rank vs the player's position ("DvP vs PG: 27th", "Opp Rank vs C 25/30"), usage ("USG% 27.4"), pace ("Pace 101.2"), potential volume ("Potential Assists 13.1", "Rebound Chances 18.2") and minutes ("Minutes: 36, 35, 34"). Each nudges the hit chance a little (`weights.insights`): a bottom-30% defense ±2 points, pace 1.5+ possessions off the league line ±1, usage of 25%+ on scoring and playmaking props +1, potential volume that projects 8%+ past the line ±1.5 (potential assists × 0.55, rebound chances × 0.58), and minutes up or down 3+ over the last three games ±1. Unders read each signal the other way. The total is capped at ±5 points. Rank 1 is taken to be the stingiest defense, so check that your page ranks the same way. These are rough priors, not fitted to results.

## Parlay tickets

Every analysis also builds 4-, 5- and 6-leg parlay tickets (`weights.tickets`) from the high-floor legs, with at most one variance leg each. They follow the one-per-player and same-game limits and use the same-game correlations. Each ticket shows its combined odds (American and decimal), the book's implied chance against the model's chance that all legs hit, EV at those odds, and a Kelly stake. Tracking a ticket pays the product of the hit legs' odds: a push drops that leg, and one miss loses the ticket.

## Orphaned lines (sharp book divergence)

When a prop has prices from a sharp book (`weights.divergence.sharp_books`: Pinnacle, Circa, BetOnline, Bookmaker and others), the best soft price is compared with the sharp one. A line is **orphaned** when all three of these hold:

- the soft price is -125 or lighter;
- the sharp books are at -130 or heavier;
- the sharp books' no-vig chance beats the soft price's implied chance by at least 1 point.

The no-vig chance uses both sides when the sharp book shows both; otherwise it uses `model.assumed_vig`. A -130/+110 sharp market is roughly a fair price at -119 and isn't flagged. -140/+120 or heavier is. Orphaned lines get a small ranking bonus (`score_bonus`) and their own list in the view.

## Game-script check on tickets

Every same-game pair on a ticket gets a correlation from the rules in `weights.correlation`. A ticket with any pair below `tickets.min_pair_rho` (default 0, so any negative link) is skipped. That keeps legs that need opposite game scripts off one ticket, such as an over and an under that work against each other, or two teammates splitting the same shots. Each ticket lists its same-game links and says whether its legs reinforce each other.

## Usage vacuum

Players ruled out come from the page's injury notes ("Joel Embiid (PHI) - Out", "Teammate out: Joel Embiid") and from the list under **Strategy** (player, team, usage %). Usage on the floor adds up to 100%, so when players holding a share *v* sit, each teammate's usage grows by about *v* / (1 − *v*). A usage figure comes from the injured player's own card when it's there; otherwise it is `starter_usage` (22%).

Only part of that growth turns into stats (`elasticity` 0.6). The hit chance of teammates' scoring, playmaking and rebounding props moves by `sensitivity` × that lift, capped at ±4 points (unders the other way). The player who is out is dropped. This is a rough model: real minutes and shots don't split evenly, so check the rotation news.

## Streak decay

Applies to both strategies:

- A player whose last two games averaged 10% or more fewer minutes than the three before is dropped.
- An over against a defense in the stingiest 10% (rank 1–3 of 30) is dropped.
- A player who missed the line in each of the last two games stays but loses 3 points of hit chance.

## Market odds (free)

`market_data.py` cross-references Outlier's numbers with the rest of the market, at no cost:

- **The Odds API, free tier** (`ODDS_API_KEY` in `.env`, free at the-odds-api.com, 500 credits a month): main lines (moneyline, spread, total) for the sports listed under **Market odds** in the view, and player props for the next couple of games when you list prop markets (`player_points`, `player_rebounds`, …). Each call costs credits per market per region, so it fetches at most every 30 minutes, keeps 50 credits in reserve, and shows how many are left.
- **ESPN's public scoreboard JSON** (no key): team names and abbreviations (so every source keys games like Outlier does, e.g. `DEN-LAL`), game totals for the pace rule, and the moneyline, spread and total it lists. It's an unofficial feed and can change shape; both shapes seen so far are read.
- **Public odds-comparison pages** you list: CoDev opens them in a fresh, signed-out browser (never the Outlier profile) and parses their tables like Outlier's. Check each site's terms before adding it.

Every quote goes into `market.db` (SQLite) with its source, book and time. For each line, the newest quote per book is grouped with the other side: each book's hold (juice), the no-vig fair chance (the average of the sharp books when one has the line, e.g. Pinnacle or Circa, else the median of all books with both sides), and the best price on each side with its edge over fair. Before scoring, each Outlier prop picks up every book's price for the same player, market and line, and its fair chance comes from that market instead of one site. `python market_data.py summary --db market.db --csv lines.csv` dumps every line by book (with pandas if installed).

## Same-game correlation

Two legs from the same game aren't independent. `weights.correlation` gives each pair a correlation on hit/miss from its market groups and whether the players are teammates or opponents: a point guard's assists and a teammate's points or threes (+0.12), a QB and his receiver (+0.2), two scorers on opposite teams (+0.05, a shootout), a pitcher's strikeouts against the hitters he faces (‑0.15), a game or team total with its scorers (+0.12), teammates competing for the same shots or rebounds (‑0.04/‑0.05). A game total above the league's pace line (NBA 230, NFL 47, …) adds +0.04 for overs. Rules are for two overs; an under flips the sign. Each same-game pair's joint chance is `p1·p2 + ρ·√(p1(1−p1)p2(1−p2))`, so positively linked legs raise the chance that all hit and get ranked higher, while the expected number of hits stays the same. Teammate rules only apply when the page names the player's team (a matchup like "LAL @ DEN" alone only says they share a game). The numbers are starting estimates, not fitted to data; edit them in your `weights.json`.

## Closing line value

Each scrape moves the closing price of every open leg you played to its latest price (props come off the board at the start, so the last price seen is the close). CLV is the close's fair chance minus the fair chance when you tracked the entry: positive means the market moved your way, which over many legs is the best evidence of a real edge, since results alone are mostly luck over small samples. The learning report shows the average and how often you beat the close.

## Stake sizing

Each entry gets a Kelly stake: the share of bankroll that maximizes long-run growth for its whole payout table (computed exactly, not the single-outcome formula), times your fraction (quarter Kelly to start, since the hit chances are estimates and full Kelly on overconfident estimates loses money), capped at 3% of bankroll per entry. The bankroll follows the stakes and results of the entries you track; once it is 20% below its peak, stakes halve until it recovers. No edge after the payouts means no stake.

## How it learns

Mark each leg of an entry you played as hit, miss or push in the Outlier view (or add your Outlier history page under **Pages** so the scrape reads them). After each save, `learn`:

1. does nothing until there are 20 settled legs, so one bad night doesn't rewrite the filters;
2. refits how much the hit chance trusts market prices vs. recent games;
3. for each filter, finds the threshold where the legs that cleared it hit most often (judged on the lower edge of a confidence interval, on at least 15 legs and 40% of the sample) and moves halfway there, within the bounds in `weights.default.json`;
4. penalizes a market that hits 12+ points below its predicted rate, and stops using one that hits under 40% over 12+ legs;
5. reports closing line value for the legs it has a close for.

**Reset filters to defaults** in the view undoes all of it.

These are estimates. Prices and recent games say something about a leg, not everything, the correlations are rough starting estimates, and a filter that worked last month can miss next week. No setting here guarantees wins.
