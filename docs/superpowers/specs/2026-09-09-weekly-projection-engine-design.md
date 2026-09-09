# Leg A — Weekly projection engine

Date: 2026-09-09. Status: design approved in chat. First of three specs
(A → B → C); B (in-season cockpit) and C (DFS) both read their numbers out
of this one.

## Goal

Today the app is worth using for about three hours a year. `projPoints` is a
season total, and `lib/engine/outcome.ts` spreads it flat across 17 weeks with
lognormal noise — every week is interchangeable and no week knows who the
opponent is. This spec builds the missing primitive: **a player's point
distribution for one specific week in one specific game context**, measured
against five seasons of real outcomes.

Nothing here is a UI feature. It is the load-bearing wall under start/sit
(Leg B) and DFS (Leg C).

## Non-negotiables carried forward

- `lib/engine/**` stays pure, I/O-free, deterministic (seeded RNG). No
  `Date.now()`, no `Math.random()`.
- No paid services at runtime, no API keys in the repo. Every source below was
  verified free and keyless on 2026-09-09.
- Every lever lives in `config/` with an off state that reproduces a documented
  baseline exactly.
- `pnpm build:board` keeps working offline from `data/raw/` fixtures. The new
  weekly ETL gets fixtures on the same terms.
- The existing `fast` and `full` CI lanes are not touched. FantasyPros never
  enters the weekly lane — its free tier is ~10 requests/day.

## Verified data sources (probed 2026-09-09)

| Source | Endpoint | What it gives | Verified |
|---|---|---|---|
| Sleeper weekly projections | `api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular` | ~1,360 players/week, full stat lines incl. `rec_fd`/`rush_fd`, plus `player.injury_status` | 200 OK for 2021, 2024, 2025, 2026 |
| ESPN weekly projections | `lm-api-reads.fantasy.espn.com/.../{season}/segments/0/leaguedefaults/3` with `scoringPeriodId={week}` | second opinion, stat-id map already parsed by `lib/etl/espn.ts` | existing code path |
| DK projections | rides along free with the Leg C salary pull (`draftStatAttributes` id 90) | third opinion + implied DK consensus | 703 players, week 1 Sun-Mon slate |
| Vegas lines (live) | `site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` → `competitions[].odds` | `spread`, `overUnder` per game | keyless, returned 2026 wk 1 |
| Vegas lines (history) | nflverse `nfldata/data/games.csv` → `spread_line`, `total_line` | backtestable environment inputs | already fetched by `lib/etl/schedule.ts` |
| Weekly actuals + usage | nflverse `stats_player_week_{season}.csv` | targets, carries, snaps, actual points | already fetched by `lib/etl/schedule.ts` |

The historical Sleeper weekly projections are the unlock. Five seasons ×
18 weeks × ~1,300 players of projection-vs-reality means this model can be
**fitted and gated**, not asserted.

## The core type

```ts
// lib/engine/weekly/outlook.ts
export interface WeekOutlook {
  playerId: string;
  week: number;
  /** Opponent defense team code, null on a bye. */
  opp: string | null;
  /** Expected points CONDITIONAL on playing. Leg B needs this separately. */
  meanIfPlays: number;
  /** meanIfPlays × pPlay — the number to rank by. */
  mean: number;
  /** Lognormal sigma of points around meanIfPlays. */
  sigma: number;
  p10: number; p50: number; p90: number;
  /** P(active this week). Bye = 0. */
  pPlay: number;
  /** Projected stat line, for DK threshold bonuses and for the "why" line. */
  stats: StatLine;
  drivers: {
    baseMarket: number;   // ensemble of Sleeper/ESPN/DK
    baseUsage: number;    // our own usage model
    matchMult: number;    // opponent vs position
    envMult: number;      // Vegas implied team points
    scriptMult: number;   // spread-driven pass/run script
    status: string | null;
  };
}
```

`drivers` is not decoration. It is how the UI explains a recommendation in one
line, and how a bad week gets debugged after the fact.

## Model

### 1. Market ensemble

`baseMarket = Σ_s ω_s · score(statLine_s, leagueScoring)` over the available
sources, weights renormalized when a source is missing. Each source's raw
**stat line** is re-scored with the league's own scoring, never its published
point total — that is already how the season board supports PPFD and TE
premium, and it is the only way weekly numbers respect `scoringTweaks`.

### 2. Own usage model (`usageModel.ts`)

- **Share**: exponentially-weighted recent share of team targets (WR/TE),
  carries (RB), and attempts (QB), over games the player actually played:
  `share = Σ λ^k · share_{w-1-k} / Σ λ^k`.
- **Early-season shrink**: blend toward a preseason prior share (the player's
  season projection ÷ his team's summed season projection) with weight
  `n / (n + k0)` where `n` = games of usage observed. Week 1 is pure prior;
  by week 8 it is mostly observed. This is what stops the model from reading
  three snaps of week-1 noise as a breakout.
- **Team volume**: plays × pass rate, from the team's recent pace and pass rate
  crossed with the Vegas environment below.
- **Efficiency**: yards per target / per carry and TD rate, shrunk hard toward
  position priors. Volume is signal; efficiency is mostly noise, and a model
  that treats a 3-game 22%-TD-rate stretch as skill will be confidently wrong.
- Output: a stat line → scored with league scoring → `baseUsage`.

### 3. Game environment (`environment.ts`)

Implied team points from the line: `ITP_dog = total/2 − |spread|/2`,
`ITP_fav = total/2 + |spread|/2`.

- `envMult = (ITP / leagueAvgITP) ^ α_pos`
- `scriptMult = 1 + β_pos · (ownSpread / 7)` — on ownSpread DIRECTLY (negative = favored); β_RB < 0 raises a favorite's backs, β_WR > 0 raises an underdog's receivers. The calibration must regress on the same quantity — favorites run out the clock
  (β_RB > 0), underdogs throw (β_WR, β_QB > 0 on the dog side). Signs come
  from the fit, not from folklore.
- **DST inverts both**: a defense wants its *opponent's* implied points to be
  low, so DST uses `ITP_opponent` and a negative `α`. Getting this sign
  backwards would rank the worst DST plays as the best, so it is asserted in a
  unit test rather than left to the fit.

### 4. Matchup (`matchup.ts`)

`dvp` = fantasy points allowed to a position per game, current-season EWMA
blended with prior season, then shrunk toward the league average by
`n / (n + k)`. `matchMult = (dvp_shrunk / leagueAvg) ^ γ_pos`. This is the
existing `lib/etl/schedule.ts` idea moved from season-level to weekly-rolling.

### 5. Avoiding double-counting — the detail that decides whether this works

Market projections **already partially embed** Vegas lines and matchup. Fitting
`α`, `β`, `γ` against actual points would therefore count those effects twice
and make the model worse than the raw Sleeper number it is built on.

So: **all adjustment coefficients are fitted on the residual**
`log(actual / baseMarket)`, never on `actual` directly. The fit estimates only
the environment and matchup signal the market has *left on the table*. Expect
small coefficients. Small and real beats large and double-counted.

### 6. Availability

`pPlay = 0` on a bye. Otherwise fitted from history: the Sleeper weekly
projection payload carries `player.injury_status`, and nflverse says whether he
actually played, so `status → P(played)` is a directly measurable table rather
than the hand-set constants in `STATUS_MISS_PROB`. Fit it; keep the current
constants as the documented fallback.

### 7. Spread

`sigma = σ0_pos · (V0_pos / max(V, Vmin)) ^ δ`, where `V` is projected volume.
An 18-touch back is genuinely less volatile than a 4-target flier, and every
tool that gives them the same shape produces floor/ceiling numbers that mean
nothing. Fitted per position. `p10/p50/p90` follow from the lognormal.

### 8. Assembly

```
meanIfPlays = (w_m · baseMarket + w_u · baseUsage) · matchMult · envMult · scriptMult
mean        = meanIfPlays · pPlay
```

## `config/weekly-model.json` and its off state

```jsonc
{
  "fittedOn": [2021, 2022, 2023, 2024, 2025],
  "sourceWeights": { "sleeper": 1, "espn": 0, "dk": 0 },
  "modelWeights":  { "market": 1, "usage": 0 },
  "usage":       { "lambda": 0.75, "priorGames": 4, "effReliability": 0.15 },
  "environment": { "alpha": {}, "beta": {}, "leagueAvgItp": 22.5 },
  "matchup":     { "gamma": {}, "shrinkGames": 6, "priorSeasonWeight": 0.5, "dvpLambda": 0.85 },
  "sigma":       { "sigma0": {}, "v0": {}, "delta": 0 },
  "availability":{ "byStatus": {} },
  "correlation": { "game": 0, "team": 0.28, "unit": 0, "dstVsOppTeam": 0 }
}
```

Off state (as written above: `usage: 0`, all of `alpha`/`beta`/`gamma` empty,
`delta: 0`, correlation matching today's `teamCorrelation`) reproduces
**raw Sleeper weekly projections re-scored with league scoring** exactly. Every
adjustment is then measurable against a baseline that costs one API call — the
right bar, since a model that cannot beat one free API call has not earned its
code.

## Correlated weekly sampler (`lib/engine/weekSim.ts`)

Marginals are not enough. A Josh Allen / Khalil Shakir stack wins tournaments
*because* their good weeks arrive together, and a start/sit floor is worse than
it looks when three starters share one game.

Nested shocks, one draw set per simulation iteration:

```
z_p = a_g·z_game[g] + a_t·z_team[t] + a_u·z_unit[t, unit(p)] + a_i·z_i
      with a_g² + a_t² + a_u² + a_i² = 1
```

`unit(p)`: QB/WR/TE → pass unit, RB → run unit. DST loads **negatively** on its
opponent's team shock. Setting `a_g = a_u = 0` reproduces today's
`makeTeamShocks` behavior exactly, which is the regression test.

Note on the config: `correlation` in `weekly-model.json` stores **correlations**
(ρ_game ≤ ρ_team ≤ ρ_unit), which are what the calibration script can measure
from historical co-movement. The sampler derives the amplitudes from them
(`a_g = √ρ_game`, `a_t = √(ρ_team − ρ_game)`, `a_u = √(ρ_unit − ρ_team)`,
`a_i = √(1 − ρ_unit)`) and **validates the nesting order on load**, since an
out-of-order set would silently produce a negative amplitude.

**DK threshold bonuses.** DK pays +3 for 100 rushing yards, 100 receiving
yards, 300 passing yards. The expected value of a threshold bonus cannot be
computed from a mean — a 92-yard mean with wide spread earns more bonus than a
98-yard mean with narrow spread. So the sampler draws one performance
multiplier per player-week and applies it to the projected **stat line**, then
scores the scaled line including bonuses. This is an approximation (yards and
TDs are assumed to scale together) and it is gated: simulated bonus frequency
must match historical bonus frequency per position within tolerance.

## ETL

New `lib/etl/weekly/`: `sleeperWeekly.ts`, `espnWeekly.ts`, `vegas.ts`,
`usage.ts`, `dvp.ts`. Emits `public/data/week-{season}-{week}.json`. Fixtures
under `data/raw/weekly/`, committed, same offline-fallback contract as
`data/raw/`.

New `--lane=weekly` in `scripts/build-board.ts`, on a Thu-through-Mon cadence.
`fast` and `full` are untouched.

Live availability at lineup lock (Sunday inactives) flows through the existing
`lib/client/useLiveSignals.ts` and is applied to outlooks **only** via a pure
grader in `lib/engine/injuryFeed.ts`, extending `gradeBoard` rather than adding
status logic to a component.

## Calibration and gates

- `scripts/build-weekly-history.ts` — Sleeper weekly projections 2021–2025 ×
  nflverse weekly actuals × `games.csv` lines → slim committed snapshots in
  `data/historical-data/weekly/`. Keep only id, week, opponent, projected and
  actual points, key stats, line, status. Raw is ~75 MB; the slim form must
  stay under ~10 MB.
- `scripts/calibrate-weekly.ts` — fits every coefficient above. Never
  hand-tuned, same rule as `outcome-model.json`.
- `scripts/backtest-weekly.ts` — appends to `docs/backtest-gates.md`:

| # | Gate | Why it is the right bar |
|---|---|---|
| 1 | RMSE and MAE beat raw Sleeper, per position, on held-out seasons | If it cannot beat one free API call it is not worth shipping |
| 2 | Per-position Spearman ρ of predicted vs actual weekly finish ≥ baseline | Start/sit is a ranking problem, not a point-estimate problem |
| 3 | **Distribution calibration**: p90 exceeded ~10% of the time, p10 undercut ~10%; PIT histogram near-uniform | Matters more than MAE for start/sit and GPP, and almost nobody checks it |
| 4 | **Decision accuracy**: replayed over historical weeks, the recommended lineup beats naive "start the highest projection" in realized points and in matchup wins | The only gate that measures the actual product |
| 5 | Simulated DK bonus frequency matches historical, per position | Validates the stat-line sampling approximation |

Fit on 2021–2024, hold out 2025, then refit on all five. Gate 1 and gate 4 are
blocking: if either fails, the config default stays in its off state and ships
as opt-in, exactly as the unified model is currently handled.

## Performance budgets

The `<50 ms` draft recompute is untouched — nothing in this spec runs during a
draft. New budgets, to be asserted in tests rather than hoped for:

- Building a full week of outlooks (~1,300 players): **< 80 ms**
- 2,000 correlated sims over a 20-player set (Leg B's need): **< 150 ms**
- Slate-wide sims (~700 players) are Leg C's problem and are explicitly an
  async job with progress, not a keystroke-latency path.

## Testing

- Unit tests per pure module, with hand-computed fixtures for `environment`,
  `matchup`, `usageModel`, `sigma`.
- Off-state regression: `weekly-model.json` in its off state reproduces
  re-scored raw Sleeper to within floating-point tolerance.
- Sampler regression: `a_g = a_u = 0` reproduces `makeTeamShocks` correlation
  structure; empirical correlation of 100k draws matches configured `a` values.
- Determinism: same seed → identical output, asserted across all sim entry
  points.
- Offline: weekly ETL builds from fixtures with no network, warning loudly
  about staleness.

## Out of scope

Roster ingestion, start/sit UI, waivers, trades, playoff odds (Leg B); DK
salaries, ownership, optimizer (Leg C). This spec ends at `WeekOutlook` and a
sampler that produces correlated draws from it.
