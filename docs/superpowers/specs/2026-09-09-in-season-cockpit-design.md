# Leg B — In-season cockpit: start/sit, byes, waivers, trades

Date: 2026-09-09. Status: design approved in chat. Second of three specs.
**Depends on Leg A** (`WeekOutlook` + `weekSim`); do not start until A's
gates 1 and 4 have been run.

## Goal

A weekly surface at `app/season/` that answers, in order of how often you ask
it: who do I start, who do I swap in for a bye or an inactive, who do I claim
off waivers, and is this trade good. Separate page from DFS (Leg C) — this is a
ten-minute Thursday and Sunday check on one roster you own; DFS is a slate
optimizer. Sharing a surface would make both worse.

## The headline idea

**Rank lineup decisions by Δ P(win this matchup), not Δ expected points.**

Expected points is the wrong objective in a head-to-head league and it is what
every free tool optimizes. If you are a 19-point underdog, the correct play is
the volatile flier whose 34-point ceiling is your only path, even though he
projects three points lower. If you are a 25-point favorite, the correct play
is the boring floor. Same roster, same week, opposite advice — and it falls
directly out of Leg A's correlated sampler:

```
P(win) = P( Σ my sampled starters > Σ opponent's sampled starters )
```

with both sides drawn from the *same* correlated week, so a shared game between
your player and your opponent's player is handled correctly rather than assumed
independent.

Every recommendation carries the plain-language reason, built from
`WeekOutlook.drivers` — matching the existing `lib/engine/reasons.ts` pattern.

## Teams registry — four ingestion paths, one funnel

`lib/client/teams.ts`, localStorage key `teams-v1`, modeled directly on
`lib/client/history.ts`: on-device, never sent over the wire, no expiry (not a
cookie), survives restarts. Holds **many** leagues at once — redraft league,
best ball, your buddy's league — each with its own scoring, roster slots,
schedule and current roster, and each independently switchable.

```ts
export interface SavedTeam {
  id: string;
  name: string;
  config: LeagueConfig;          // reused as-is, incl. scoringTweaks
  source: "sleeper" | "manual" | "paste" | "ocr";
  sleeper?: { leagueId: string; rosterId: number };
  roster: { playerId: string; slot: "starter" | "bench" | "ir" }[];
  /** Opponent per week, when known. */
  schedule?: Record<number, { oppRosterId?: number; oppName?: string }>;
  record?: { w: number; l: number; t: number };
  savedAt: string;
}
```

All four paths — Sleeper league sync (free, keyless, `lib/draft/sleeper.ts`
already exists), manual entry, clipboard paste, and screen OCR — parse in pure
tested modules and terminate in a single `applyRoster`, exactly the way every
draft ingestion path terminates in `useDraft.applyImport`. One kind of roster
change, so undo, history and the engine all see the same thing.

Sleeper sync additionally gives the free-agent pool (needed for waivers), the
league's real scoring settings, your weekly opponent and their starters. Manual
and OCR paths degrade gracefully: no opponent roster means the opponent's total
is modeled from a league-average projected score, and the UI says so rather
than pretending.

## Engine modules (all pure)

### `lib/engine/lineup.ts`

- `bestLineup(outlooks, slots)` — a proper assignment solve, **not** greedy.
  The existing `optimalLineupTotal` in `lib/engine/season.ts:17` is exact for a
  single flex and silently wrong for superflex or two-flex leagues. Start/sit is
  exactly where that bites, so this replaces it and `season.ts` is migrated onto
  the correct version.
- `winProbability(mine, theirs, sims, seed)` — correlated joint sim per above.
- `startSitAdvice(team, week)` — for every legal swap, Δ P(win) with Δ expected
  points reported alongside so a counter-intuitive call is legible rather than
  mysterious. Ranked, with the reason line.
- **Forced swaps first**: any starter with `pPlay` below a config threshold
  (bye = 0, Out, or a late inactive arriving through `useLiveSignals`) is
  surfaced as a must-fix above the optional optimizations, with the best
  available replacement.

### `lib/engine/playoffOdds.ts`

Simulate the remaining schedule — every team's weekly totals from Leg A's
sampler, your league's real matchups — to get playoff odds, seed distribution
and elimination number. Then **let the odds set the risk dial**: week 13 needing
two wins is a different optimization from week 13 locked into the 2-seed. This
is the natural extension of "weigh the fantasy league matchup," and it reuses
`simulateRoom` almost directly.

The dial is a config lever with an off state (`riskFromPlayoffOdds: 0`) that
reproduces pure Δ P(win) for the current week only.

### `lib/engine/waivers.ts`

Rank available players by value added to **your** lineup for the rest of the
season, reusing the draft engine's VONA logic — value over what you already
have at that slot — rather than a generic rest-of-season ranking. A third WR
who would never crack your lineup scores near zero no matter how good he is in
the abstract; that is the whole point.

Streaming QB/TE/K/DST is this same function scoped to one position and one
week, so it costs almost nothing once waivers exist.

Output includes the drop candidate and the effect on bye/injury coverage.

### `lib/engine/trade.ts`

Score a proposed deal on three axes rather than one number: Δ rest-of-season
lineup points, Δ playoff odds, and Δ bye/injury coverage (reusing the
`byeCoverWeeks` idea already in `Recommendation`). A trade that raises points
while leaving you one injury from an empty flex is not a good trade, and a
single-number verdict cannot say that.

## Surface (`app/season/`)

Reuses the cockpit's visual language. Sections in the order you actually need
them: **Must fix** (byes, Out, inactives) → **Lineup** (current vs recommended,
with Δ P(win) and the reason per swap) → **Matchup** (your projected
distribution vs your opponent's, win probability) → **Waivers** →
**Playoff odds** → **Trades**.

Live signals (inactives, breaking news) flow through the existing
`useLiveSignals` hook and are graded on via the pure grader in
`lib/engine/injuryFeed.ts` — no status logic in components, per the standing
rule.

## Gates and budgets

- Replay gate (shared with Leg A gate 4): across held-out historical weeks, the
  Δ P(win) lineup must beat naive "start the highest projection" in **matchup
  win rate**, not merely in points. Points can lose to a better objective; win
  rate is the product.
- Waiver gate: recommended claims must beat generic rest-of-season rank in
  realized points added to the *lineup* over the following four weeks.
- Playoff odds calibration: bucket historical mid-season odds and check that
  teams given ~70% made it ~70% of the time.
- Budget: `startSitAdvice` for a 15-man roster at 2,000 sims **< 150 ms**;
  playoff odds is a background compute with a spinner, not a keystroke path.

## Testing

Unit tests for every pure module. `bestLineup` gets adversarial slot cases
(superflex, two flex, TE-eligible flex, more starters than players). Ingestion
paths get fixture-based parse tests with no browser APIs, mirroring
`lib/draft/pasteImport.ts`. A seeded end-to-end test asserts that the same team
and week produce identical advice.

## Out of scope

DFS (Leg C). Multi-year dynasty valuation. Auction budgets.
