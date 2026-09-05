# Draft Cockpit

A free, local-first fantasy football draft assistant. It sits on a second screen during a live draft and tells you **exactly who to take**, why, and what you're giving up — based on your league's real scoring, your roster, who's already gone, and a strategy you picked in advance.

Total recurring cost: **$0.00**. Static JSON board, no database, no LLM calls, free APIs only.

## Quickstart

```bash
pnpm install
pnpm build:board   # fetch live data, build public/data/board-*.json
pnpm dev           # open http://localhost:3000
```

First run walks you through setup:

- **Sleeper mode** — paste your draft URL (or draft/league id). Teams, rounds, scoring, and roster slots are auto-derived from the Sleeper API; picks mirror into the app every 2 seconds, hands-free. If your league id is configured, the board is re-scored client-side with your league's exact `scoring_settings`.
- **Manual mode** — for ESPN/Yahoo/anything else. Type a name ("ceedee" works), hit Enter, the pick is marked. Undo with ⌘Z.

Your slot, config, and every manual action are mirrored to localStorage — a browser refresh mid-draft recovers everything.

## Draft night runbook

1. The night before: `pnpm build:board` (or let the nightly GitHub Action do it). Check the build log for warnings.
2. Open the app, load your draft, pick your slot and strategy.
3. When you're on the clock, the answer is already on screen: one name, one reason, two alternates. The button confirms — it never computes.
4. Keyboard: `Enter` drafts the recommendation, `/` focuses manual entry, `⌘Z` undoes.
5. If the wifi dies: everything keeps working offline except live sync — mark picks manually.

## How it works

```
COLD  (nightly)   scripts/build-board.ts: FFC ADP + ESPN raw projections +
                  DynastyProcess crosswalk/ECR → join → score with league
                  settings → VORP/VOLS/tiers → public/data/board-*.json
WARM  (page load) board JSON hydrates once; works offline afterwards
HOT   (every 2s)  poll Sleeper picks → diff → recompute client-side (<50ms)
```

The engine (`lib/engine/`) is pure functions, no I/O:

- **Survival**: P(player available at pick n) from FFC's per-player ADP mean + stdev via the normal CDF, shifted by observed **room drift** per position.
- **VONA**: each candidate vs. the expected best at his position at your next pick — tier-cliff urgency falls out of the math.
- **Monte Carlo**: simulates the room between your picks (ADP + noise + roster-need), scores candidates on `E[value] − λ·stdev`.
- **Strategies are config, not code** (`config/strategies.json`): λ, VORP/VOLS blend, ADP discipline, stacking, position multipliers by round. The Custom strategy exposes the dials as sliders — λ can go negative to *pay* for variance.
- **Value is roster-marginal, not league-wide** (redraft `valueModel: "lineup"`, the default): a player who would fill an open starting or FLEX slot is valued by what taking him now adds over the best you can expect at his position at your next pick (VONA, so position runs and tier cliffs matter) blended with his quality against the league's last starter; a bench player is valued as insurance — VORP scaled by the odds he ever starts. This is what makes "balanced" adapt to the board as it empties instead of stacking one position. The legacy `"blend"` model (pure VORP/VOLS scarcity) is still available per strategy; it priced two same-projection FLEX candidates 84 points apart because RB58 projects 80 and WR58 projects 161, and drafted 7 RBs and 2 WRs into a 2-RB/2-WR lineup.
- **Best ball mode** (Underdog/DraftKings-style draft-once tournaments, or any Sleeper best-ball league — auto-detected): value anchors to a market curve instead of season-total VORP, roster construction chases 2-3 QB / 5-6 RB / 7-9 WR / 2-3 TE targets, QB↔receiver stacks earn a bonus, and K/DST disappear when the format has none.
- **Injury + depth data** from Sleeper is baked into the board nightly: IR/PUP players are never recommended, Out/Doubtful are discounted, and late rounds get a handcuff bonus for your own RBs' direct backups.
- **History-fitted room drift**: with a `leagueId` in `config/league.json`, the nightly build fits per-position ADP bias from your league's previous draft and seeds draft-night drift with it.

## Scripts

| command | what |
|---|---|
| `pnpm dev` | run the app |
| `pnpm build:board` | rebuild boards from live sources (falls back to committed fixtures in `data/raw/` with a loud staleness warning) |
| `pnpm test` | engine math test suite (vitest) |
| `pnpm backtest <draft_id> <slot> [strategy] [scoring]` | replay a real Sleeper draft with the engine in your slot; compare rosters |
| `pnpm simulate <draft_id> [slot] [scoring] [--sims=500] [--bestball]` | run every roster in a drafted room through hundreds of simulated seasons; report win rates and ceiling percentiles |
| `pnpm backtest:season <year> [--format=ppr] [--strategy=balanced\|all] [--rooms=12] [--bestball]` | draft a **past** season with that year's draft-day ADP + projections, then score every roster with what really happened — see [Season backtest](#season-backtest) |

## Player cards and draft controls

Click any player name anywhere — tier board, alternates, planner, your roster, even the big answer — for the full decision card: verdict and math-derived reasons, the 2026 projected stat line, ADP/ECR/schedule data, a live Rotowire note, last-season stats, and recent headlines (ESPN's public endpoint, fetched in-browser). Mark players gone via search, the answer buttons, the row's hover ✕, or from the card — and undo anything: the toast has an Undo button, ⌘Z works, and any manually-marked player's card offers "Put him back." The ⋯ menu holds draft controls: auto-complete the rest of the draft (engine for you, ADP for the room), end early, resume, or reset.

## Post-draft recap

When the draft ends (or any time via the **Recap** header button), the recap screen shows every roster in the room ranked by projected value, letter-grades each team, calls out the steal and the biggest reach of the draft, and can simulate 300 full seasons in the browser — win rates and p50/p99 ceilings per roster, with your team highlighted.

## Validating and tuning

Join a free Sleeper mock draft and run the app against it — that's the integration test. Then `pnpm backtest <that draft id> <your slot> zero-rb` to see what a different strategy would have produced from the same room.

`pnpm backtest` grades both rosters with the *current* board's projections — useful for comparing strategies against the same room, but circular as a measure of quality (it asks the engine whether it likes its own picks). For the real answer, use the season backtest below.

## Season backtest

`pnpm backtest:season 2025` rebuilds the board as it looked on draft day of a completed season and scores every roster with realized points. It answers two separate questions:

- **A. Projection quality** — rank correlation, pairwise ordering accuracy (when we said A over B, how often were we right?), MAE, and signed bias per position and per draft range. Bias is the tunable: a position that comes in −30 points every year is a projection problem, not bad luck.
- **B. Decision quality** — the engine drafts from every seat of N simulated rooms against ADP-following bots, and its roster's realized points are compared with the bot that would have sat in the *same seat of the same room* (paired by seed, so the room is identical until the engine deviates). Rosters are scored as the sum of each week's optimal lineup — exactly how best ball scores, and the standard "perfect manager" yardstick for redraft. The roster-shape table usually explains the result: it shows how many players the engine took at each position versus the bot, and where the points came from.
- **C.** — the players the engine kept drafting, with their projected vs realized position rank.

Read the error bars as clustered by room, and treat one season as one sample: the engine drafts the same core in every room, so a season's result is a bet on a handful of players. Run every snapshotted season (`--strategy=all` compares all strategies) before drawing conclusions.

This harness is what caught the RB tilt. Under the old blend model every strategy lost to a plain ADP bot in 2024 (−42 to −127 realized lineup points per seat) and beat it in 2025 (+125 to +278) — the same bet on RB depth paying off or not. Under the lineup model every strategy is positive in both years (2024: +59 to +118; 2025: +156 to +270), and balanced, upside and safe-floor tie at the top of the two-year average.

**Data (free):** ESPN's historical `kona_player_info` payload carries both the preseason projection and the realized weekly actuals for a season; FFC serves that year's final pre-season ADP via `?year=`. The first run for a season writes `data/raw/seasons/<year>.json` (~1 MB). **Commit it** — ESPN purges old projections (2023 retains 22 of 264), so every season not snapshotted is lost for good. Currently snapshotted: 2024, 2025.

## Data sources (all free, all switchable)

- ADP + stdev: [Fantasy Football Calculator](https://fantasyfootballcalculator.com) (attribution required)
- Projections (raw stat lines): ESPN's undocumented `kona_player_info` endpoint — wrapped in a fixture fallback since it can vanish without notice — **and** Sleeper's projections endpoint (raw stat lines including projected first downs, which is what makes PPFD scoring possible)
- Second/third ADP opinions: ESPN's ownership block and Sleeper's per-format ADP
- Player ID crosswalk + expert consensus ranks: [DynastyProcess](https://github.com/dynastyprocess/data) (GPL-3.0; ECR mirror updates weekly)
- Live draft + league truth, trending adds, injuries, depth charts: [Sleeper](https://docs.sleeper.com) (free, read-only, non-commercial)
- Schedules + last-season weekly stats (matchup strength): [nflverse](https://github.com/nflverse)
- Player news, Rotowire notes, last-season stat lines: ESPN's public athlete endpoint, fetched in-browser

**Source toggles** (Setup → Advanced → Data sources): pick ESPN, Sleeper, or a blend for projections; FFC, Sleeper, ESPN, or a blend for ADP. Blended projections are the default — two independent models beat either alone. FFC stays the uncertainty model regardless: it's the only free source publishing per-player ADP spread, which powers the survival math. Everything else keyed/paid (FantasyPros, FantasyData, Fantasy Nerds) is deliberately excluded — no keys, no signups, ever.

Raw responses are committed to `data/raw/` as the offline fallback; the refresh workflow (`.github/workflows/build-board.yml`) rebuilds them **three times a day** (morning after FFC's ADP refresh, midday, and pre-draft-time evening) and commits the result — Vercel redeploys automatically on push. No API keys, no accounts, no signups anywhere: every source is anonymous and free. The only setup is pushing this repo to GitHub (activates the schedule) and connecting Vercel's free hobby tier (activates auto-deploy). Update cadence by source: ADP daily, injuries/depth intraday, expert ranks weekly (Fridays, upstream limitation), schedule/matchup strength static until the season starts.

## Deploying

Vercel hobby tier, zero config: `vercel deploy`. The board is static files in `/public`; there is no server-side code on the hot path.
