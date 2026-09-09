# Leg C — DFS: slates, value, ownership, optimizer

Date: 2026-09-09. Status: design approved in chat. Third of three specs.
**Depends on Leg A** (`WeekOutlook` + `weekSim`). Independent of Leg B.

## Goal

A slate surface at `app/dfs/` that turns Leg A's weekly distributions into
DraftKings lineups, for all four formats: Classic GPP, cash games, Showdown
captain mode, and mass multi-entry portfolios. Separate page from the in-season
cockpit — different cadence, different objective, different data.

## Verified: DraftKings is free and keyless (probed 2026-09-09)

| Endpoint | Gives | Verified |
|---|---|---|
| `draftkings.com/lobby/getcontests?sport=NFL` | 29 draft groups with start times, game counts, `GameTypeId` | 200 OK |
| `api.draftkings.com/draftgroups/v1/draftgroups/{id}/draftables?format=json` | 703 unique players with `salary`, team, `competition` (the game), and DK's own projection in `draftStatAttributes` id 90 | 200 OK, week-1 Sun-Mon slate |
| `api.draftkings.com/lineups/v1/gametypes/{gameTypeId}/rules?format=json` | the authoritative roster template and constraints | 200 OK |

The rules endpoint matters more than it looks: the optimizer **fetches** its
constraints rather than hardcoding them, so it survives DK changing a rule.
Confirmed templates:

- **Classic** (`gameTypeId` 1): `QB, RB, RB, WR, WR, WR, TE, FLEX, DST`,
  $50,000 cap, min 2 games, min 2 teams, unique players, late swap allowed.
- **Showdown Captain Mode** (`gameTypeId` 96): `CPT, FLEX ×5`, $50,000 cap,
  one game, min 2 teams, **no late swap**. Captain scores 1.5× and costs 1.5×.

DK's own projection comes along free with the salary pull, so it doubles as the
third source in Leg A's market ensemble.

## ETL

`lib/etl/weekly/dkSlates.ts` — lobby → draft groups → draftables → per-slate
records. Emits `public/data/slates-{season}-{week}.json`: slate id, type, start
time, games, and per player salary, team, game, and DK projection. Joined to
board ids through the existing `lib/etl/names.ts` / `lib/draft/nameMatch.ts`
matchers; **unmatched players are reported, never silently dropped** — a
missing join in DFS is a missing player in every lineup.

Fixtures under `data/raw/weekly/dk/`. Part of the `weekly` lane.

## Value (`lib/engine/dfs/value.ts`)

- Points per $1,000, and salary-adjusted value versus the slate's own
  price-to-projection curve (fitted per slate, so "cheap" means cheap *for this
  slate* rather than against a fixed constant).
- Ceiling percentile from Leg A's sigma — the number that matters in GPPs.
- **Leverage** = ceiling percentile relative to projected ownership. Being right
  is not enough in a top-heavy field; being right and alone is.

## Ownership (`lib/engine/dfs/ownership.ts`)

Real projected ownership is paid data. This is a proxy built from signals we
already have free: points-per-dollar rank, salary tier, DK projection rank,
Sleeper trending adds, game total, and news volume.

It ships **explicitly labeled uncalibrated in the UI**, with a documented
`fitOwnership(rows)` seam that accepts hand-exported ownership CSVs and fits the
weights properly once error can be measured. Per `AGENTS.md`, that data spend is
the owner's to make and stays behind a measured hole. No fake precision in the
meantime: the UI shows a bucket (chalk / moderate / contrarian), not a
fabricated percentage.

## Optimizer (`lib/engine/dfs/optimize.ts`)

Seeded randomized-restart hill climb under the fetched DK constraints. Seeded
because the engine rule is determinism — same slate, same seed, same lineups,
which is also what makes it testable.

Objectives are pluggable, and this is where the formats diverge:

- **Cash** — maximize expected points with a variance penalty. High floor,
  no contrarian scoring. Beat half the field, do not try to win.
- **GPP** — maximize P(lineup score > payout threshold) estimated from Leg A's
  **correlated** sims, minus a duplication penalty from projected ownership.
  Correlation is the whole game here: a QB + two of his receivers is a bad
  expected-value lineup and a good tournament lineup, and only a correlated sim
  can tell you that.
- **Showdown** — same machinery, different template, plus a captain search
  (the 1.5× multiplier on both points and salary makes captain choice the
  dominant decision) and much stronger correlation, since all six slots come
  from one game.

## Portfolio (`lib/engine/dfs/portfolio.ts`)

20–150 lineups with per-player exposure caps, minimum pairwise difference, and
optional forced stacks or fades. Objective is portfolio-level: maximize
P(at least one lineup finishes top 1%) rather than the mean of independently
good lineups, which is how mass multi-entry is actually scored.

## Gates

- Replay the optimizer over held-out historical weeks using real salaries and
  real actuals: **cash lineups must beat the DK-projection-optimal lineup's
  win rate**, and **GPP lineups must beat it on P(top 1%)**.
- Ownership proxy is gated only for monotonicity and bucket sanity until real
  ownership data exists. It must not be presented as calibrated before it is.
- Sim-implied score distributions must reproduce historical winning-score
  distributions per slate size.

Historical DK salaries are the one gap: the lobby only serves current slates.
Mitigation — the weekly lane commits each week's slate file from here on, so the
backtest set accumulates. Until it has depth, gates run on the weeks we have and
say so.

## Budgets

Explicitly an async job with progress, not a keystroke path: 2,000 correlated
sims over ~700 players plus a 150-lineup portfolio search. Target under ~10 s
for a Classic portfolio on a laptop, cancellable, with partial results shown.

## Testing

Constraint tests are the priority — every generated lineup must be legal by
DK's own fetched rules (cap, slots, unique players, min games, min teams), which
is a property test over many seeded runs. Objective tests use hand-built tiny
slates with known answers. Showdown gets its own captain-multiplier tests.

## Out of scope

Non-DK sites (FanDuel, Yahoo). Live in-game late-swap automation. Actual
contest entry — this tool produces lineups, it never logs in anywhere.
