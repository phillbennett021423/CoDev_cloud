// What agents know about Outlier (outlier.bet), from its public site, help center
// (help.outlier.bet) and reviews: every section and tool, what its numbers mean,
// and when to look at each one while building a ticket. OUTLIER_PRIMER is the
// short version that goes in the scan tool's description; OUTLIER_GUIDE is what
// the outlier_guide tool returns.

const OUTLIER_PRIMER = 'About Outlier (outlier.bet, web app app.outlier.bet): a sports betting research app that compares player props and lines across sportsbooks and DFS apps (FanDuel, DraftKings, BetMGM, Caesars, bet365, PrizePicks, Underdog...). It shows data; it doesn\'t make picks. '
    + 'Its sections: Insights/Trends (where it opens: trending picks with strong hit rates), Props (the Prop Finder: every player prop with its line, best odds and book, implied chance and hit rates), Games (each matchup\'s spread, total and moneyline with injuries, line movement and public bet splits), Popular (Most Researched, Most Added to My Picks), My Picks (the user\'s saved slip), and the Pro tools +EV (Positive EV), Arbitrage, Middle Bets and Boosts. '
    + 'Clicking a prop opens its Market Details / player card: the hit rate chart, Supporting Stats, usage (target share, minutes), the opponent\'s rank against that position, injuries, Odds Movement and public splits. '
    + 'Sports: NBA, WNBA, NFL, NCAAF, MLB, NHL, NCAAB, soccer. '
    + 'Reading a prop: player, stat (Points, Rebounds, Assists, PRA, Threes, Passing Yards, Strikeouts, Shots on Goal...), line (e.g. 22.5), side (Over/More/Higher or Under/Less/Lower), American odds (-119 means risk 119 to win 100, about 54% implied; +150 means win 150 on 100, 40%) and hit rates: how often he cleared this line in the last 5, 10 and 20 games (L5, L10, L20), head to head against this opponent (H2H), this season and last season. '
    + 'Colors: green is always good for the side being looked at, red bad (light green 80-100%, green 66-80%, dark green 51-65%, black 50%, dark red 30-49%, red 15-29%, light red under 15%). '
    + 'The scan opens Props (never +EV), picks the sport, finds the game and reads every line; outlier_research opens one player\'s or game\'s details. Call outlier_guide for the full guide: every tool, what its numbers mean and the research checklist by sport. '
    + 'They only read and click tabs, filters, game cards and player names: never adding picks to My Picks or a slip, never entering anything on Outlier, Underdog or Dabble.';

const OUTLIER_GUIDE = `# Outlier: what it is and how to use it for picks

Outlier (outlier.bet; the web app is app.outlier.bet, also on iOS and Android) is a sports betting research app. It gathers player props and game lines from the sportsbooks and DFS apps (FanDuel, DraftKings, BetMGM, Caesars, bet365, ESPN Bet, Fanatics, Underdog, PrizePicks, Kalshi...), and puts each one next to the data that decides it: hit rates, matchups, injuries, usage, line movement and public money. It doesn't make picks: it shows the evidence, and the bettor decides. Plans: Premium (research, injuries, line tracking), Premium+ (adds live odds movement charts and EV+ badges), Pro (adds the Positive EV feed, Arbitrage, Middles, Boosts).

Sports: NBA, WNBA, NFL, NCAAF (CFB), MLB, NHL, NCAAB (CBB), soccer.

## The sections

- **Insights / Trends** (the home feed; "Trending Insights"): a curated stream of props and lines with strong recent trends, line moves and sharp action. A starting list of ideas, not a full board.
- **Props** (the Prop Finder; reached from "Find Your Next Bet"): every player prop for the chosen league. Each row: player, prop, line, the book with the best odds, implied probability, and hit-rate boxes for L5, L10, L20, H2H, current season and last season.
  - **Filters**: League, Game, Player, Prop (Points, Rebounds, Rushing Yards, Strikeouts...), Over/Under, Hit rate (window plus minimum, e.g. over 80% in L10), Minimum Odds, Sportsbook, and an "Only EV+" toggle (Premium+).
  - **Sort**: Last 5, Last 10, Last 20, Head-2-Head, Current Season, Previous Season, Opposition Rank (how the opponent ranks at allowing that stat), Implied Probability.
- **Games**: each matchup with spread, total and moneyline across books. A game's page has its market details, injuries, line movement and the "Line Movement and Public Bet splits" section (Public Bet % and Public Money %, with timestamped line changes).
- **Market Details / player card** (click a prop or a player): the deep dive for one prop.
  - **Hit Rate chart**: game-by-game results against the line, with the window (L5/L10/L20/H2H/season) and splits such as home/away, opponent, after a loss, against a defense rank or with a teammate out. A median/average toggle; the median is less swayed by one huge game.
  - **Supporting Stats**: the inputs behind the stat. NBA: minutes, shot attempts, FG%, 3PT attempts and %, free throws, fouls, rebounds split offensive/defensive, assists. NFL: targets, receptions, yards per reception, target share, team pass/run split, pass plays per game, snaps, carries. MLB: innings pitched, pitches thrown, team batting average against the pitcher, pitch arsenal, strike zone heatmaps, batter vs pitcher, splits vs RHP/LHP. NHL: shots on goal, time on ice, power play time.
  - **Matchup / opposition rank**: how the opponent ranks at allowing this stat overall and to this position (defense vs position). It flips with the side: for an Over, a defense near the bottom of the league is green; for an Under, a top defense is green.
  - **Injuries**: the player's status and history and the injuries around him (a returning teammate takes usage; a missing star gives it; a missing defender softens the matchup). Outlier also flags in-game injuries and status changes before official reports.
  - **Odds Movement** (Premium+): a chart of each book's price for this outcome over the last 24 hours (or since the market opened), with Pinnacle as the sharp reference. Opened from the icon next to the line selector, or "Odds Movement" on +EV.
  - **Public splits**: share of bets and of money on each side.
  - **EV box** (when the price is +EV): the vig, devig method, market width and the books used.
- **Popular** ("Popular Bets"): "Most Researched" and "Most Added to My Picks": what Outlier users are looking at, with each card's matchup, time, market, line, price and user counts. It shows crowd interest, not Outlier's picks, and not every prop.
- **My Picks**: the user's own saved slip, sent to a sportsbook in two clicks. CoDev never adds to it.
- **+EV / Positive EV feed** (Pro; badges on Premium+): prices that beat the no-vig fair price from sharp books (Pinnacle by default). Good for price, but it's a separate tool from the props board: CoDev's scan never uses it as the board.
- **Arbitrage, Middle Bets, Boosts** (Pro): both-sides bets that lock a small profit, two lines that can both win, and the books' daily boosts. Not part of building a prop ticket.
- **React Live**: Outlier's separate live-betting app. Not used by CoDev.

## Reading the numbers

- **Line and side**: "Over 22.5 Points" wins on 23 or more. DFS apps say More/Less or Higher/Lower.
- **American odds**: -119 risks 119 to win 100 (implied 119/219 = 54.3%); +150 wins 150 on 100 (implied 100/250 = 40%). Implied probability is the break-even chance; a leg is worth it only when the real chance is higher.
- **Hit rate**: how often the player cleared this exact line in the window. L5 and L10 show form, L20 and the season show the base rate, H2H is against this opponent (small samples: a few games).
- **Colors**: green is always favorable to the side being analysed, red unfavorable. Hit-rate boxes: light green 80-100%, green 66-80%, dark green 51-65%, black 50%, dark red 30-49%, red 15-29%, light red 0-14%. MLB splits: green means better than his season average in that split, red worse.
- **Line movement**: a price getting shorter (+105 to -110) means the market moved toward that side, often sharp money; a price drifting longer (+148 to +162) means it moved away. A move against heavy public betting (most bets on one side, line moving the other way) points to sharp action. Pinnacle and Circa are the sharp books.
- **Public Bet % vs Public Money %**: share of tickets vs share of dollars. More money than tickets on a side means bigger (often sharper) bets there.

## When to use each one while building a ticket

1. **Pick the game** (Props filtered to the game, or Games). Fewer games, studied well, beat many games skimmed.
2. **Shortlist from the board**: sort by L10 or season hit rate, then by Opposition Rank. Keep legs that are green across several windows, not one hot L5.
3. **Check each leg's Market Details**: hit rate chart (median, not one outlier game), Supporting Stats (minutes and shots or targets steady or rising), matchup rank for that position, injuries on both teams, Odds Movement (moving toward the side is a plus; moving away, find out why) and public splits.
4. **Game context from the Games page**: the spread and total shape the script (a big favorite's starters may sit late; a high total means more possessions), plus injuries and public money.
5. **Correlation**: legs from one game move together (a QB's passing yards with his top receiver; a big Over on a game total with players' Overs). Pair them on purpose, and avoid legs that work against each other.
6. **Price**: compare books (Outlier shows the best odds) and the EV+ badge if shown. Never pay a worse price than the board's best.
7. **Before the reply**: re-check injuries close to game time.

## Research checklist by stat

- **NBA points / PRA / assists / rebounds**: point trend, FG% and 3PT splits, free throws, expected minutes, fouls, defensive rank overall and against his position, game script (spread and total), load management and rest, teammates in or out (usage).
- **NFL passing / receiving / rushing / TDs**: targets and target share, receptions, yards per reception, team pass/run split and plays per game, matchup against the position (slot vs outside for receivers), injuries on both sides, line movement and public splits. Interceptions: the QB's pressure and the defense's takeaways. Tackles and sacks: snaps and the opponent's pass rate.
- **MLB strikeouts / walks / total bases**: innings pitched, pitches thrown, the opposing team's batting average and strikeout rate against him, splits by handedness (vs RHP/LHP, vs RHB/LHB), batter vs pitcher, bullpen, weather and the ballpark.
- **NHL points / shots on goal**: shots and time on ice, power play role, the opponent's shots allowed, back-to-backs and the goalie.

## Limits

Hit rates and trends describe the past; no filter guarantees a win. Small samples (H2H, L5) swing hard. CoDev only reads Outlier: it clicks tabs, filters, game cards and player names, never adds anything to My Picks or a bet slip, and never enters anything on Outlier, Underdog or Dabble. Tickets go to the user in the chat.
`;

module.exports = { OUTLIER_PRIMER, OUTLIER_GUIDE };
