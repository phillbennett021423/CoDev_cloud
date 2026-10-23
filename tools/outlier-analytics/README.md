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

A prop makes the cut when its odds are at least as juiced as `-min_juice` (‑130 to start), L5 ≥ 70%, floor ≥ 0, volatility ≤ 0.35 and hit chance ≥ 56%. Entries take the best-scoring props, at most one per player and two per game or team, and are ranked by expected value from the payout tables in `weights.default.json`, assuming legs are independent. **Check those payouts against your app**: they change, and EV depends on them.

## How it learns

Mark each leg of an entry you played as hit, miss or push in the Outlier view (or add your Outlier history page under **Pages** so the scrape reads them). After each save, `learn`:

1. does nothing until there are 20 settled legs, so one bad night doesn't rewrite the filters;
2. refits how much the hit chance trusts market prices vs. recent games;
3. for each filter, finds the threshold where the legs that cleared it hit most often (judged on the lower edge of a confidence interval, on at least 15 legs and 40% of the sample) and moves halfway there, within the bounds in `weights.default.json`;
4. penalizes a market that hits 12+ points below its predicted rate, and stops using one that hits under 40% over 12+ legs.

**Reset filters to defaults** in the view undoes all of it.

These are estimates. Prices and recent games say something about a leg, not everything, legs on the same team aren't really independent, and a filter that worked last month can miss next week. No setting here guarantees wins.
