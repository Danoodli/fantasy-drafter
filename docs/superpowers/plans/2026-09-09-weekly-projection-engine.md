# Weekly Projection Engine (Leg A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat season-total-÷-17 assumption with a real per-week, per-matchup point distribution for every player, fitted and gated against five seasons of actual outcomes.

**Architecture:** A weekly ETL lane fetches free, keyless sources (Sleeper weekly projections, ESPN weekly projections, ESPN scoreboard odds, nflverse weekly actuals) into `public/data/week-{season}-{week}.json`. A set of small pure engine modules under `lib/engine/weekly/` turn that into a `WeekOutlook` per player: a market ensemble blended with our own usage model, multiplied by calibrated Vegas-environment and opponent-vs-position adjustments, with a volume-dependent lognormal spread. A separate hierarchical sampler (`lib/engine/weekSim.ts`) produces *correlated* joint draws, because both downstream legs need joint distributions rather than marginals. Every coefficient lives in `config/weekly-model.json`, is fitted by a script, and has an off state that reproduces raw re-scored Sleeper exactly.

**Tech Stack:** TypeScript, Node 20+, pnpm, vitest, tsx scripts. No new runtime dependencies. No new services.

**Spec:** `docs/superpowers/specs/2026-09-09-weekly-projection-engine-design.md` — read it before Task 1 and keep it open; this plan argues from it.

## Global Constraints

- **`lib/engine/**` is pure**: no I/O, no `Date.now()`, no `Math.random()`. Randomness comes only from a seeded `makeRng(seed)` (`lib/engine/montecarlo.ts`). This is unit-tested and replayed by the backtest harness — a violation breaks determinism, not just style.
- **All I/O lives in `lib/etl/` (Node-only, build time) or `lib/client/` (browser).** Never import `lib/etl/*` from a component.
- **No paid services, no API keys in the repo, nothing keyed in the browser.** Every source in this plan was verified free and keyless on 2026-09-09.
- **Strategies and levers are config, not code.** Never write `if (pos === "RB")` branching that encodes a tuned number; put the number in `config/weekly-model.json`.
- **Every lever ships with an off state that reproduces a documented baseline exactly.** For this plan the baseline is: raw Sleeper weekly projections, re-scored with the league's scoring settings.
- **`pnpm build:board` must keep working offline** from `data/raw/` fixtures, warning loudly about staleness. The new weekly fetchers follow the same contract via `fetchWithFixture` / `opts.fixtureOnly`.
- **The `fast` and `full` CI lanes are not modified.** This plan adds a third lane, `weekly`. **FantasyPros is never called from `fast` or `weekly`** — its free tier is ~10 requests/day.
- **`pnpm test` must pass before every commit.** The existing `<50 ms` draft recompute budget in `tests/perf.test.ts` is a hard requirement and nothing here may regress it.
- **Re-score raw stat lines, never a source's published point total.** That is the only way weekly numbers respect `scoringTweaks` (TE premium, 6-pt passing TDs, PPFD). Use `scoreStatLine(stats, settings, isTE)` from `lib/scoring.ts`.
- **`node_modules/next/dist/docs/`**: this repo runs a Next.js version with breaking changes from training data. Leg A adds no UI, but if a task leads you into `app/` or `components/`, read the relevant guide there first.
- Team codes are canonicalized with `canonicalTeam()` from `lib/etl/nflverse.ts` (nflverse writes `LA`/`JAC`/`LVR`; the board uses `LAR`/`JAX`/`LV`).

---

### Task 1: Weekly model config, types, and the off state

The foundation every later task imports. Establishes the parameter shape, the off state, and the correlation-nesting validation.

**Files:**
- Create: `lib/engine/weekly/model.ts`
- Create: `config/weekly-model.json`
- Test: `tests/weeklyModel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WeeklyModelParams`, `DEFAULT_WEEKLY_MODEL`, `loadWeeklyModel(raw: unknown): WeeklyModelParams`, `correlationAmplitudes(c: CorrelationParams): Amplitudes`, `type Amplitudes = { game: number; team: number; unit: number; player: number }`, `unitOf(pos: Position): "pass" | "run"`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyModel.test.ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEEKLY_MODEL,
  loadWeeklyModel,
  correlationAmplitudes,
  unitOf,
} from "../lib/engine/weekly/model";

describe("weekly model config", () => {
  it("ships in its off state: usage weight 0, no adjustments", () => {
    const m = DEFAULT_WEEKLY_MODEL;
    expect(m.modelWeights.usage).toBe(0);
    expect(m.modelWeights.market).toBe(1);
    expect(m.sourceWeights.sleeper).toBe(1);
    expect(m.sourceWeights.espn).toBe(0);
    expect(m.sourceWeights.dk).toBe(0);
    expect(Object.keys(m.environment.alpha)).toHaveLength(0);
    expect(Object.keys(m.environment.beta)).toHaveLength(0);
    expect(Object.keys(m.matchup.gamma)).toHaveLength(0);
    expect(m.sigma.delta).toBe(0);
  });

  it("derives amplitudes from nested correlations and they sum to one in square", () => {
    const a = correlationAmplitudes({ game: 0.1, team: 0.3, unit: 0.45, dstVsOppTeam: 0.2 });
    expect(a.game).toBeCloseTo(Math.sqrt(0.1), 10);
    expect(a.team).toBeCloseTo(Math.sqrt(0.2), 10);
    expect(a.unit).toBeCloseTo(Math.sqrt(0.15), 10);
    expect(a.player).toBeCloseTo(Math.sqrt(0.55), 10);
    const sumSq = a.game ** 2 + a.team ** 2 + a.unit ** 2 + a.player ** 2;
    expect(sumSq).toBeCloseTo(1, 10);
  });

  it("rejects out-of-order correlations instead of producing a NaN amplitude", () => {
    expect(() =>
      loadWeeklyModel({ ...DEFAULT_WEEKLY_MODEL, correlation: { game: 0.4, team: 0.2, unit: 0.5, dstVsOppTeam: 0 } })
    ).toThrow(/nesting/i);
    expect(() =>
      loadWeeklyModel({ ...DEFAULT_WEEKLY_MODEL, correlation: { game: 0.1, team: 0.2, unit: 1.4, dstVsOppTeam: 0 } })
    ).toThrow(/range/i);
  });

  it("validates the SHIPPED config on import, not just on demand", () => {
    // DEFAULT_WEEKLY_MODEL is loadWeeklyModel(json), not a bare cast. Before
    // this, every guard below was dead code in production: the correlation
    // nesting check never ran on the file the engine actually uses, and
    // calibrate-weekly.ts WRITES that file.
    expect(() => loadWeeklyModel(DEFAULT_WEEKLY_MODEL)).not.toThrow();
  });

  it("rejects out-of-range levers, naming the offending field", () => {
    const bad = (patch: Record<string, unknown>) => () =>
      loadWeeklyModel({ ...DEFAULT_WEEKLY_MODEL, ...patch });
    // A zero lambda collapses a recency weight sum; a zero denominator NaNs a blend.
    expect(bad({ usage: { ...DEFAULT_WEEKLY_MODEL.usage, lambda: 0 } })).toThrow(/usage\.lambda/);
    expect(bad({ usage: { ...DEFAULT_WEEKLY_MODEL.usage, priorGames: 0 } })).toThrow(/usage\.priorGames/);
    expect(bad({ matchup: { ...DEFAULT_WEEKLY_MODEL.matchup, dvpLambda: 0 } })).toThrow(/matchup\.dvpLambda/);
    expect(bad({ environment: { ...DEFAULT_WEEKLY_MODEL.environment, leagueAvgItp: 0 } })).toThrow(/leagueAvgItp/);
    expect(bad({ sigma: { ...DEFAULT_WEEKLY_MODEL.sigma, delta: -1 } })).toThrow(/sigma\.delta/);
    expect(bad({ sourceWeights: { sleeper: 0, espn: 0, dk: 0 } })).toThrow(/all zero/);
    expect(bad({ availability: { byStatus: { Questionable: 1.5 } } })).toThrow(/Questionable/);
  });

  it("maps positions to correlation units", () => {
    expect(unitOf("QB")).toBe("pass");
    expect(unitOf("WR")).toBe("pass");
    expect(unitOf("TE")).toBe("pass");
    expect(unitOf("RB")).toBe("run");
    expect(unitOf("K")).toBe("run");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyModel.test.ts`
Expected: FAIL — cannot resolve `../lib/engine/weekly/model`.

- [ ] **Step 3: Write the config off state**

```jsonc
// config/weekly-model.json
{
  "fittedOn": [],
  "sourceWeights": { "sleeper": 1, "espn": 0, "dk": 0 },
  "modelWeights": { "market": 1, "usage": 0 },
  "usage": { "lambda": 0.75, "priorGames": 4, "effReliability": 0.15 },
  "environment": { "alpha": {}, "beta": {}, "leagueAvgItp": 22.5 },
  "matchup": { "gamma": {}, "shrinkGames": 6, "priorSeasonWeight": 0.5, "dvpLambda": 0.85 },
  "sigma": {
    "sigma0": { "QB": 0.45, "RB": 0.7, "WR": 0.8, "TE": 0.85, "K": 0.55, "DST": 0.75 },
    "v0": { "QB": 32, "RB": 16, "WR": 7, "TE": 5, "K": 2, "DST": 1 },
    "delta": 0
  },
  "availability": { "byStatus": {} },
  "correlation": { "game": 0, "team": 0.28, "unit": 0.28, "dstVsOppTeam": 0 }
}
```

`fittedOn: []` is accurate, not a placeholder: nothing has been fitted yet. Task 14 fills it.

- [ ] **Step 4: Write the module**

```ts
// lib/engine/weekly/model.ts
// Parameters of the weekly projection model. Fitted by
// scripts/calibrate-weekly.ts, never hand-tuned. The engine imports the JSON
// as data; tests inject their own.
//
// Off state (as committed): sourceWeights sleeper-only, usage weight 0, empty
// alpha/beta/gamma, delta 0. That reproduces raw Sleeper weekly projections
// re-scored with the league's scoring settings — the baseline every gate
// measures against.
import type { Position } from "../../types";
import weeklyJson from "../../../config/weekly-model.json";

export interface CorrelationParams {
  /** Shared by BOTH teams in a game — shootout vs slog. */
  game: number;
  /** Shared by one team's offense. Must be >= game. */
  team: number;
  /** Shared by a team's pass unit or run unit. Must be >= team. */
  unit: number;
  /** How strongly a DST loads NEGATIVELY on its opponent's team shock. */
  dstVsOppTeam: number;
}

export interface WeeklyModelParams {
  fittedOn: number[];
  sourceWeights: { sleeper: number; espn: number; dk: number };
  modelWeights: { market: number; usage: number };
  usage: { lambda: number; priorGames: number; effReliability: number };
  environment: {
    /** Exponent on (impliedTeamPoints / leagueAvgItp), per position. */
    alpha: Partial<Record<Position, number>>;
    /** Coefficient on (ownSpread / 7), per position. */
    beta: Partial<Record<Position, number>>;
    leagueAvgItp: number;
  };
  matchup: {
    /** Exponent on (pointsAllowed / leagueAvg), per position. */
    gamma: Partial<Record<Position, number>>;
    shrinkGames: number;
    priorSeasonWeight: number;
    /**
     * Recency weight for the rolling defense-vs-position table: a week's
     * weight is dvpLambda^(weeksAgo). 1 is a flat mean. Must be in (0, 1] —
     * enforced by loadWeeklyModel. At exactly 0 the weight sum collapses to 0
     * for any team with no week at throughWeek-1 (0^0 is 1, so a team WITH one
     * would survive), which buildDvp then has to skip to avoid NaN.
     */
    dvpLambda: number;
  };
  sigma: {
    sigma0: Partial<Record<Position, number>>;
    v0: Partial<Record<Position, number>>;
    delta: number;
  };
  availability: { byStatus: Record<string, number> };
  correlation: CorrelationParams;
}

/**
  * The shipped config, VALIDATED at import time. Not a bare cast: every guard
  * in loadWeeklyModel exists because a bad value fails silently rather than
  * loudly — an out-of-nesting-order correlation set produces a negative
  * amplitude and NaNs every downstream draw, and a zero lambda makes a weight
  * sum zero. scripts/calibrate-weekly.ts WRITES this file, so validating on
  * import is what turns "the calibration emitted something impossible" from a
  * silent NaN into a startup error naming the field.
  */
export const DEFAULT_WEEKLY_MODEL = loadWeeklyModel(weeklyJson);

export interface Amplitudes {
  game: number;
  team: number;
  unit: number;
  player: number;
}

/**
 * The config stores CORRELATIONS, because that is what the calibration script
 * can measure from historical co-movement. The sampler needs AMPLITUDES.
 * Nesting must hold (game <= team <= unit <= 1) or an amplitude goes negative
 * and every downstream draw silently becomes NaN — so validate, don't clamp.
 */
export function correlationAmplitudes(c: CorrelationParams): Amplitudes {
  return {
    game: Math.sqrt(c.game),
    team: Math.sqrt(c.team - c.game),
    unit: Math.sqrt(c.unit - c.team),
    player: Math.sqrt(1 - c.unit),
  };
}

function assertCorrelation(c: CorrelationParams): void {
  for (const [k, v] of Object.entries(c)) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`weekly-model correlation.${k}=${v} out of range [0,1]`);
    }
  }
  if (!(c.game <= c.team && c.team <= c.unit)) {
    throw new Error(
      `weekly-model correlation nesting violated: expected game (${c.game}) <= team (${c.team}) <= unit (${c.unit})`
    );
  }
}

/** Range check with a message that names the field, so a bad config is diagnosable. */
function assertRange(path: string, v: unknown, lo: number, hi: number, loOpen = false): void {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`weekly-model ${path} must be a finite number, got ${String(v)}`);
  }
  const belowLo = loOpen ? v <= lo : v < lo;
  if (belowLo || v > hi) {
    throw new Error(
      `weekly-model ${path}=${v} out of range ${loOpen ? "(" : "["}${lo}, ${hi}]`
    );
  }
}

export function loadWeeklyModel(raw: unknown): WeeklyModelParams {
  const p = raw as WeeklyModelParams;
  if (!p || typeof p !== "object") throw new Error("weekly-model: not an object");

  assertCorrelation(p.correlation);

  const w = p.modelWeights;
  assertRange("modelWeights.market", w?.market, 0, 1);
  assertRange("modelWeights.usage", w?.usage, 0, 1);
  if (Math.abs(w.market + w.usage - 1) > 1e-9) {
    throw new Error(`weekly-model modelWeights must sum to 1, got ${w.market + w.usage}`);
  }

  // Source weights are renormalized over the sources present, so they need not
  // sum to 1 — but they must not all be zero, or the ensemble has no opinion.
  let sourceSum = 0;
  for (const key of ["sleeper", "espn", "dk"] as const) {
    assertRange(`sourceWeights.${key}`, p.sourceWeights?.[key], 0, 1);
    sourceSum += p.sourceWeights[key];
  }
  if (!(sourceSum > 0)) throw new Error("weekly-model sourceWeights are all zero");

  // Lambdas are exponent bases over "weeks ago": 1 is a flat mean, and 0 would
  // make a weight sum collapse. priorGames and shrinkGames are denominators.
  assertRange("usage.lambda", p.usage?.lambda, 0, 1, true);
  assertRange("usage.priorGames", p.usage?.priorGames, 0, 1e3, true);
  assertRange("usage.effReliability", p.usage?.effReliability, 0, 1);
  assertRange("environment.leagueAvgItp", p.environment?.leagueAvgItp, 0, 1e3, true);
  assertRange("matchup.shrinkGames", p.matchup?.shrinkGames, 0, 1e3, true);
  assertRange("matchup.priorSeasonWeight", p.matchup?.priorSeasonWeight, 0, 1);
  assertRange("matchup.dvpLambda", p.matchup?.dvpLambda, 0, 1, true);
  assertRange("sigma.delta", p.sigma?.delta, 0, 5);

  for (const [pos, v] of Object.entries(p.sigma?.sigma0 ?? {})) {
    assertRange(`sigma.sigma0.${pos}`, v, 0, 5, true);
  }
  for (const [pos, v] of Object.entries(p.sigma?.v0 ?? {})) {
    assertRange(`sigma.v0.${pos}`, v, 0, 1e3, true);
  }
  for (const [status, v] of Object.entries(p.availability?.byStatus ?? {})) {
    assertRange(`availability.byStatus.${status}`, v, 0, 1);
  }

  return p;
}

/**
 * Which correlated unit a position belongs to. K sits with the run unit as a
 * documented placeholder — kicker points track drives, not passing volume, and
 * the calibration script measures whether that mapping is right.
 */
export function unitOf(pos: Position): "pass" | "run" {
  return pos === "QB" || pos === "WR" || pos === "TE" ? "pass" : "run";
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyModel.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify tsconfig resolves the JSON import**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. `config/outcome-model.json` is already imported the same way by `lib/engine/season.ts`, so `resolveJsonModule` is on; if this errors, that is the fix.

- [ ] **Step 7: Commit**

```bash
git add config/weekly-model.json lib/engine/weekly/model.ts tests/weeklyModel.test.ts
git commit -m "Weekly model: parameter shape, off state, correlation-nesting validation"
```

---

### Task 2: Sleeper weekly projections fetcher

The primary source and the baseline the whole model is measured against. Verified 200 OK for 2021, 2024, 2025 and 2026.

**Files:**
- Create: `lib/etl/weekly/sleeperWeekly.ts`
- Test: `tests/sleeperWeekly.test.ts`
- Create: `tests/fixtures/sleeper-week-sample.json` (hand-trimmed, 3 players)

**Interfaces:**
- Consumes: `SourceResult<T>`, `FetchOpts` from `lib/etl/fetchers.ts`.
- Produces: `interface WeeklyProjection { stats: StatLine; points?: number; status: string | null; team: string; pos: Position }`, `parseSleeperWeekly(rows: unknown[]): Record<string, WeeklyProjection>`, `fetchSleeperWeekly(season: number, week: number, opts?: FetchOpts): Promise<SourceResult<Record<string, WeeklyProjection>>>`.

`points` exists for **K and DST only**. Sleeper reports kickers as `fgm`/`fga`/`fgm_40_49` and defenses as points-allowed buckets — none of which map to `StatLine` — so those two positions carry the source's published total instead of a re-scorable line. This mirrors the season board, where `BoardPlayer.stats` is documented "Absent for K/DST (their projPoints come from ESPN's applied total)". Offensive players with no stat line are still dropped.

- [ ] **Step 1: Write the fixture**

```json
[
  {
    "week": 2,
    "season": "2026",
    "player_id": "6813",
    "stats": { "pts_ppr": 23.92, "rush_yd": 99.63, "rush_td": 1.05, "rec": 3.95, "rec_yd": 26.15, "rec_td": 0.19, "rec_fd": 2.61, "rush_fd": 9.96, "fum_lost": 0.09 },
    "player": { "position": "RB", "team": "DET", "injury_status": null, "first_name": "Jahmyr", "last_name": "Gibbs" }
  },
  {
    "week": 2,
    "season": "2026",
    "player_id": "4034",
    "stats": { "pts_ppr": 14.1, "pass_yd": 268.0, "pass_td": 1.7, "pass_int": 0.6, "rush_yd": 12.0, "pass_fd": 11.2 },
    "player": { "position": "QB", "team": "KC", "injury_status": "Questionable", "first_name": "Patrick", "last_name": "Mahomes" }
  },
  {
    "week": 2,
    "season": "2026",
    "player_id": "99999",
    "stats": {},
    "player": { "position": "WR", "team": "FA", "injury_status": "Out", "first_name": "No", "last_name": "Stats" }
  }
]
```

Save as `tests/fixtures/sleeper-week-sample.json`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/sleeperWeekly.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSleeperWeekly } from "../lib/etl/weekly/sleeperWeekly";
import { scoreStatLine, SCORING_PRESETS } from "../lib/scoring";

const rows = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "sleeper-week-sample.json"), "utf8")
);

describe("parseSleeperWeekly", () => {
  it("keys by sleeper id and maps the raw stat line, first downs included", () => {
    const out = parseSleeperWeekly(rows);
    expect(out["6813"].stats.rushYds).toBeCloseTo(99.63);
    expect(out["6813"].stats.recFd).toBeCloseTo(2.61);
    expect(out["6813"].stats.rushFd).toBeCloseTo(9.96);
    expect(out["4034"].stats.passFd).toBeCloseTo(11.2);
    expect(out["6813"].pos).toBe("RB");
    expect(out["6813"].team).toBe("DET");
  });

  it("captures injury_status — the availability model is fitted from it", () => {
    expect(out0().status).toBeNull();
    expect(parseSleeperWeekly(rows)["4034"].status).toBe("Questionable");
    function out0() {
      return parseSleeperWeekly(rows)["6813"];
    }
  });

  it("drops an OFFENSIVE row with no usable stat line rather than emitting a zero player", () => {
    expect(parseSleeperWeekly(rows)["99999"]).toBeUndefined();
  });

  it("keeps kickers and defenses via a direct point total — they have no mappable stat line", () => {
    const kdst = [
      {
        week: 2, season: "2026", player_id: "K1",
        stats: { fga: 2.1, fgm: 1.8, fgm_40_49: 0.6, pts_half_ppr: 8.4 },
        player: { position: "K", team: "DAL", injury_status: null },
      },
      {
        week: 2, season: "2026", player_id: "DEN",
        stats: { pts_half_ppr: 7.2 },
        player: { position: "DEF", team: "DEN", injury_status: null },
      },
    ];
    const out = parseSleeperWeekly(kdst);
    // Without this the weekly board has no K and no DST, and a lineup needs both.
    expect(out["K1"].points).toBeCloseTo(8.4, 6);
    expect(out["K1"].stats).toEqual({});
    expect(out["DEN"].pos).toBe("DST");
    expect(out["DEN"].points).toBeCloseTo(7.2, 6);
  });

  it("still drops a K with neither a stat line nor any point total", () => {
    const bare = [{ week: 2, season: "2026", player_id: "K2", stats: { fga: 0 }, player: { position: "K", team: "DAL", injury_status: null } }];
    expect(parseSleeperWeekly(bare)["K2"]).toBeUndefined();
  });

  it("re-scoring the parsed line reproduces Sleeper's own pts_ppr within rounding", () => {
    const p = parseSleeperWeekly(rows)["6813"];
    // Sleeper's pts_ppr uses -2 for a lost fumble, same as our preset.
    const ours = scoreStatLine(p.stats, SCORING_PRESETS.ppr);
    expect(ours).toBeCloseTo(23.92, 1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/sleeperWeekly.test.ts`
Expected: FAIL — cannot resolve `../lib/etl/weekly/sleeperWeekly`.

- [ ] **Step 4: Write the fetcher**

```ts
// lib/etl/weekly/sleeperWeekly.ts
// Sleeper's WEEKLY projections (undocumented, free, no auth). Verified live
// on 2026-09-09 for 2021, 2024, 2025 and 2026 — five seasons of history is
// what makes the weekly model fittable rather than asserted.
//
// Keyed by sleeper_id, our canonical board id, so the join is exact.
// Node-only, build time. Reduced immediately; only the slim map is cached.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Position, StatLine } from "../../types";
import type { FetchOpts, SourceResult } from "../fetchers";
import { canonicalTeam } from "../nflverse";

const RAW_DIR = join(process.cwd(), "data", "raw", "weekly");

export interface WeeklyProjection {
  stats: StatLine;
  /**
   * K and DST ONLY: the source's published point total. Sleeper reports
   * kickers as fgm/fga/fgm_40_49 and defenses as points-allowed buckets, none
   * of which map to StatLine, so these two positions cannot be re-scored under
   * league settings. Same accepted limitation as the season board, where
   * BoardPlayer.stats is documented absent for K/DST.
   */
  points?: number;
  /** Sleeper's injury_status at the time of the projection: fits availability. */
  status: string | null;
  team: string;
  pos: Position;
}

const POSITIONS = new Set<string>(["QB", "RB", "WR", "TE", "K", "DST", "DEF"]);

interface RawRow {
  player_id?: string;
  stats?: Record<string, number | null>;
  player?: { position?: string; team?: string; injury_status?: string | null };
}

/** Pure: raw Sleeper rows → slim map. Exported so tests need no network. */
export function parseSleeperWeekly(rows: unknown[]): Record<string, WeeklyProjection> {
  const out: Record<string, WeeklyProjection> = {};
  for (const raw of rows as RawRow[]) {
    const id = raw?.player_id;
    const posRaw = raw?.player?.position;
    if (!id || !posRaw || !POSITIONS.has(posRaw)) continue;
    const s = raw.stats ?? {};
    const stats: StatLine = {};
    const set = (k: keyof StatLine, v: number | null | undefined) => {
      if (typeof v === "number" && v !== 0) stats[k] = v;
    };
    set("passYds", s.pass_yd);
    set("passTD", s.pass_td);
    set("passInt", s.pass_int);
    set("pass2pt", s.pass_2pt);
    set("rushYds", s.rush_yd);
    set("rushTD", s.rush_td);
    set("rush2pt", s.rush_2pt);
    set("receptions", s.rec);
    set("recYds", s.rec_yd);
    set("recTD", s.rec_td);
    set("rec2pt", s.rec_2pt);
    set("fumblesLost", s.fum_lost);
    set("rushFd", s.rush_fd);
    set("recFd", s.rec_fd);
    set("passFd", s.pass_fd);
    const pos = (posRaw === "DEF" ? "DST" : posRaw) as Position;
    let points: number | undefined;
    if (Object.keys(stats).length === 0) {
      // K and DST never have a mappable stat line, so they take the published
      // total instead — without this, a weekly board has no kicker and no
      // defense, and a lineup needs one of each.
      if (pos !== "K" && pos !== "DST") {
        // An offensive row with no stats is a rostered player Sleeper has no
        // opinion on. Emitting him as 0.0 would put a phantom in every
        // ranking, so drop him and let the board's player list decide.
        continue;
      }
      for (const key of ["pts_half_ppr", "pts_ppr", "pts_std"] as const) {
        const v = s[key];
        if (typeof v === "number" && v !== 0) {
          points = v;
          break;
        }
      }
      if (points === undefined) continue;
    }
    out[id] = {
      stats,
      points,
      status: raw.player?.injury_status ?? null,
      team: canonicalTeam(raw.player?.team),
      pos,
    };
  }
  return out;
}

export async function fetchSleeperWeekly(
  season: number,
  week: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, WeeklyProjection>>> {
  const key = `sleeper-week-${season}-${week}.json`;
  const fixturePath = join(RAW_DIR, key);
  const readFixture = () => JSON.parse(readFileSync(fixturePath, "utf8"));

  if (opts.fixtureOnly) {
    if (!existsSync(fixturePath)) throw new Error(`fixture ${key} missing — run the weekly lane live first`);
    return { data: readFixture(), fetchedAt: "fixture", fromFixture: true };
  }
  try {
    const url =
      `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular` +
      `&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF` +
      `&order_by=pts_ppr`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows) || rows.length < 200) throw new Error(`only ${(rows as unknown[])?.length} rows`);
    const slim = parseSleeperWeekly(rows);
    if (Object.keys(slim).length < 150) throw new Error(`only ${Object.keys(slim).length} usable rows`);
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(slim));
    return { data: slim, fetchedAt: new Date().toISOString(), fromFixture: false };
  } catch (err) {
    if (!existsSync(fixturePath)) {
      throw new Error(`sleeper week ${season}/${week} failed (${err}) and no fixture at ${fixturePath}`);
    }
    console.warn(`\n⚠️  ${key}: live fetch FAILED (${err}). Using committed fixture.\n`);
    return { data: readFixture(), fetchedAt: "fixture", fromFixture: true };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/sleeperWeekly.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Smoke-test the live endpoint once, by hand**

Run: `pnpm tsx -e "import('./lib/etl/weekly/sleeperWeekly').then(async m => { const r = await m.fetchSleeperWeekly(2025, 5); console.log(Object.keys(r.data).length, 'players', r.fromFixture); })"`
Expected: several hundred players, `fromFixture` false. This writes `data/raw/weekly/sleeper-week-2025-5.json`; leave it, it is a legitimate committed fixture.

- [ ] **Step 7: Commit**

```bash
git add lib/etl/weekly/sleeperWeekly.ts tests/sleeperWeekly.test.ts tests/fixtures/sleeper-week-sample.json data/raw/weekly/
git commit -m "Weekly ETL: Sleeper weekly projections, keyed by sleeper id, status captured"
```

---

### Task 3: Vegas lines — live and historical

Two shapes of the same fact: the live ESPN scoreboard for the upcoming week, and nflverse `games.csv` for every historical week. The historical path is what makes the environment coefficients fittable.

**Files:**
- Create: `lib/etl/weekly/vegas.ts`
- Test: `tests/vegas.test.ts`

**Interfaces:**
- Consumes: `parseCsv` from `lib/etl/csv.ts`, `canonicalTeam` from `lib/etl/nflverse.ts`, `SourceResult`/`FetchOpts` from `lib/etl/fetchers.ts`, and **`fetchSlim` from `lib/etl/weekly/cache.ts`** (created in Task 2 — it owns the fixture caching, the `meta.json` staleness bookkeeping and the fallback warning; do not re-implement that block here).
- Produces: `interface GameLine { week: number; home: string; away: string; total: number; homeSpread: number }`, `parseEspnScoreboard(json: unknown): GameLine[]`, `parseHistoricalLines(csv: string, season: number): GameLine[]`, `fetchVegasWeek(season: number, week: number, opts?: FetchOpts): Promise<SourceResult<GameLine[]>>`, `lineFor(lines: GameLine[], team: string): { total: number; ownSpread: number; opp: string } | null`.

`homeSpread` follows the betting convention: **negative means the home team is favored**. `ownSpread` from `lineFor` is that team's own spread, so negative means this team is favored.

- [ ] **Step 1: Write the failing test**

```ts
// tests/vegas.test.ts
import { describe, it, expect } from "vitest";
import { parseEspnScoreboard, parseHistoricalLines, lineFor, type GameLine } from "../lib/etl/weekly/vegas";

const scoreboard = {
  week: { number: 1 },
  season: { year: 2026, type: 2 },
  events: [
    {
      week: { number: 1 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { abbreviation: "SEA" } },
            { homeAway: "away", team: { abbreviation: "NE" } },
          ],
          odds: [{ provider: { priority: 1 }, spread: -3, overUnder: 44.5 }],
        },
      ],
    },
    {
      week: { number: 1 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { abbreviation: "LA" } },
            { homeAway: "away", team: { abbreviation: "SF" } },
          ],
          odds: [],
        },
      ],
    },
  ],
};

describe("vegas lines", () => {
  it("reads spread and total from the ESPN scoreboard, home-relative", () => {
    const lines = parseEspnScoreboard(scoreboard);
    expect(lines).toHaveLength(1); // the odds-less game is dropped, not defaulted
    expect(lines[0]).toEqual({ week: 1, home: "SEA", away: "NE", total: 44.5, homeSpread: -3 });
  });

  it("canonicalizes nflverse team codes when reading history", () => {
    const csv = [
      "season,week,game_type,home_team,away_team,spread_line,total_line",
      "2024,3,REG,LA,SF,2.5,47.5",
      "2024,3,POST,KC,BUF,-1,45",
      "2023,3,REG,JAC,IND,-3,44",
    ].join("\n");
    const lines = parseHistoricalLines(csv, 2024);
    expect(lines).toHaveLength(1);
    // nflverse spread_line is HOME-relative and POSITIVE when home is favored;
    // we store the betting convention (negative = home favored).
    expect(lines[0]).toEqual({ week: 3, home: "LAR", away: "SF", total: 47.5, homeSpread: -2.5 });
  });

  it("drops unlined games instead of fabricating a pick'em", () => {
    // Number("") is 0 and Number.isFinite(0) is true, so a blank field slips
    // past a naive isFinite guard and becomes total 0 / spread 0. The real
    // games.csv carries 160 such rows for the in-progress season.
    const csv = [
      "season,week,game_type,home_team,away_team,spread_line,total_line",
      "2026,5,REG,DAL,NYG,,",
      "2026,5,REG,KC,DEN,-6.5,",
      "2026,5,REG,SF,SEA, ,44",
      "2026,5,REG,BUF,MIA,-3,49.5",
    ].join("\n");
    const lines = parseHistoricalLines(csv, 2026);
    expect(lines).toHaveLength(1);
    expect(lines[0].home).toBe("BUF");
    expect(lines[0].total).toBe(49.5);
    expect(lines[0].homeSpread).toBe(3);
  });

  it("prefers the highest-priority provider that published both numbers", () => {
    const multi = {
      week: { number: 4 },
      events: [
        {
          week: { number: 4 },
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { abbreviation: "KC" } },
                { homeAway: "away", team: { abbreviation: "DEN" } },
              ],
              odds: [
                { provider: { priority: 3 }, spread: -9, overUnder: 41 },
                { provider: { priority: 1 }, spread: -7.5, overUnder: 43.5 },
                { provider: { priority: 2 }, spread: -8 },
              ],
            },
          ],
        },
      ],
    };
    const lines = parseEspnScoreboard(multi);
    expect(lines).toHaveLength(1);
    expect(lines[0].homeSpread).toBe(-7.5);
    expect(lines[0].total).toBe(43.5);
  });

  it("drops a game with no resolvable week rather than calling it week 0", () => {
    const noWeek = {
      events: [
        {
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { abbreviation: "KC" } },
                { homeAway: "away", team: { abbreviation: "DEN" } },
              ],
              odds: [{ provider: { priority: 1 }, spread: -7, overUnder: 44 }],
            },
          ],
        },
      ],
    };
    expect(parseEspnScoreboard(noWeek)).toHaveLength(0);
  });

  it("gives each team its own spread and opponent", () => {
    const lines: GameLine[] = [{ week: 1, home: "SEA", away: "NE", total: 44.5, homeSpread: -3 }];
    expect(lineFor(lines, "SEA")).toEqual({ total: 44.5, ownSpread: -3, opp: "NE" });
    expect(lineFor(lines, "NE")).toEqual({ total: 44.5, ownSpread: 3, opp: "SEA" });
    expect(lineFor(lines, "DAL")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vegas.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/etl/weekly/vegas.ts
// Game environment inputs: the closing-ish spread and total per game.
//
// Live: ESPN's scoreboard endpoint carries `competitions[].odds` keylessly
// (verified 2026-09-09). Historical: nflverse nfldata games.csv carries
// spread_line and total_line for every game back to 1999, which is what makes
// the environment coefficients fittable rather than guessed.
//
// Convention: `homeSpread` is negative when the home team is favored (betting
// convention). nflverse's spread_line is the OPPOSITE sign, so it is flipped
// on read — getting this backwards silently inverts every favorite in the fit.
import { parseCsv } from "../csv";
import { canonicalTeam } from "../nflverse";
import type { FetchOpts, SourceResult } from "../fetchers";
import { fetchSlim } from "./cache";

export interface GameLine {
  week: number;
  home: string;
  away: string;
  total: number;
  /** Negative = home favored. */
  homeSpread: number;
}

interface EspnCompetitor { homeAway?: string; team?: { abbreviation?: string } }
interface EspnOdds { provider?: { priority?: number }; spread?: number; overUnder?: number }
interface EspnEvent { week?: { number?: number }; competitions?: { competitors?: EspnCompetitor[]; odds?: EspnOdds[] }[] }

export function parseEspnScoreboard(json: unknown): GameLine[] {
  const doc = json as { week?: { number?: number }; events?: EspnEvent[] };
  const out: GameLine[] = [];
  for (const ev of doc?.events ?? []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const home = canonicalTeam(comp.competitors?.find((c) => c.homeAway === "home")?.team?.abbreviation);
    const away = canonicalTeam(comp.competitors?.find((c) => c.homeAway === "away")?.team?.abbreviation);
    if (!home || !away) continue;
    // Prefer the highest-priority provider that actually published both numbers.
    const odds = (comp.odds ?? [])
      .filter((o) => typeof o.spread === "number" && typeof o.overUnder === "number")
      .sort((a, b) => (a.provider?.priority ?? 99) - (b.provider?.priority ?? 99))[0];
    // No line means no line. Defaulting to a pick'em would feed the model a
    // fabricated environment for exactly the games it knows least about.
    if (!odds) continue;
    // A game with no resolvable week cannot be joined to anything; week 0
    // would silently corrupt every per-week lookup downstream.
    const week = ev.week?.number ?? doc.week?.number;
    if (!week) continue;
    out.push({
      week,
      home,
      away,
      total: odds.overUnder as number,
      homeSpread: odds.spread as number,
    });
  }
  return out;
}

export function parseHistoricalLines(csv: string, season: number): GameLine[] {
  const out: GameLine[] = [];
  for (const r of parseCsv(csv)) {
    if (r.season !== String(season) || r.game_type !== "REG") continue;
    // Blank fields must be rejected BEFORE coercion: Number("") is 0 and
    // Number.isFinite(0) is true, so a `Number.isFinite` guard alone turns an
    // unlined game into a fabricated pick'em (total 0, spread 0). The
    // committed games.csv carries 160 such rows for the in-progress season —
    // precisely the games the model knows least about.
    if ((r.total_line ?? "").trim() === "" || (r.spread_line ?? "").trim() === "") continue;
    const total = Number(r.total_line);
    const spread = Number(r.spread_line);
    if (!Number.isFinite(total) || !Number.isFinite(spread)) continue;
    out.push({
      week: Number(r.week),
      home: canonicalTeam(r.home_team),
      away: canonicalTeam(r.away_team),
      total,
      homeSpread: -spread, // nflverse: positive = home favored. We invert.
    });
  }
  return out;
}

/** One team's view of its own game. Null when the team is not playing (bye). */
export function lineFor(
  lines: GameLine[],
  team: string
): { total: number; ownSpread: number; opp: string } | null {
  for (const l of lines) {
    if (l.home === team) return { total: l.total, ownSpread: l.homeSpread, opp: l.away };
    if (l.away === team) return { total: l.total, ownSpread: -l.homeSpread, opp: l.home };
  }
  return null;
}

export function fetchVegasWeek(
  season: number,
  week: number,
  opts: FetchOpts = {}
): Promise<SourceResult<GameLine[]>> {
  return fetchSlim<GameLine[]>(
    `vegas-${season}-${week}.json`,
    async () => {
      const url =
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` +
        `?seasontype=2&week=${week}&dates=${season}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lines = parseEspnScoreboard(await res.json());
      // A bye-heavy week still has at least 8 games; fewer means the feed is
      // partial, which would feed the model a fabricated environment.
      if (lines.length < 8) throw new Error(`only ${lines.length} games with odds`);
      return lines;
    },
    opts,
    // The engine runs neutral without lines (envMult and scriptMult fall to 1),
    // so a missing fixture degrades rather than fails.
    () => []
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/vegas.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the live endpoint and the sign convention against reality**

Run: `pnpm tsx -e "import('./lib/etl/weekly/vegas').then(async m => { const r = await m.fetchVegasWeek(2026, 1); console.log(r.data.slice(0,3)); })"`
Expected: real games. **Sanity-check one game against a sportsbook**: if the home team is favored, `homeSpread` must be negative. A sign error here poisons every environment coefficient, so confirm it by eye now rather than debugging it in Task 14.

- [ ] **Step 6: Commit**

```bash
git add lib/etl/weekly/vegas.ts tests/vegas.test.ts data/raw/weekly/
git commit -m "Weekly ETL: Vegas spread and total, live from ESPN and historical from nflverse"
```

---

### Task 4: Game environment engine module

Pure. Turns a line into per-position multipliers, with the DST sign inversion asserted in a test.

**Files:**
- Create: `lib/engine/weekly/environment.ts`
- Test: `tests/weeklyEnvironment.test.ts`

**Interfaces:**
- Consumes: `WeeklyModelParams` from Task 1.
- Produces: `impliedTeamPoints(total: number, ownSpread: number): number`, `envMult(pos: Position, itpOwn: number, itpOpp: number, p: WeeklyModelParams): number`, `scriptMult(pos: Position, ownSpread: number, p: WeeklyModelParams): number`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyEnvironment.test.ts
import { describe, it, expect } from "vitest";
import { impliedTeamPoints, envMult, scriptMult } from "../lib/engine/weekly/environment";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = DEFAULT_WEEKLY_MODEL;
const ON: WeeklyModelParams = {
  ...OFF,
  environment: {
    leagueAvgItp: 22.5,
    alpha: { QB: 0.6, RB: 0.4, WR: 0.7, TE: 0.5, DST: -0.8 },
    beta: { QB: 0.05, RB: -0.12, WR: 0.08, TE: 0.04 },
  },
};

describe("implied team points", () => {
  it("splits the total by the spread: the favorite gets the bigger half", () => {
    // Total 44.5, favored by 3 → 23.75 / 20.75
    expect(impliedTeamPoints(44.5, -3)).toBeCloseTo(23.75, 6);
    expect(impliedTeamPoints(44.5, 3)).toBeCloseTo(20.75, 6);
    expect(impliedTeamPoints(44.5, 0)).toBeCloseTo(22.25, 6);
  });
});

describe("environment multipliers", () => {
  it("are exactly 1 in the off state, for every position", () => {
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
      expect(envMult(pos, 28, 17, OFF)).toBe(1);
      expect(scriptMult(pos, -7, OFF)).toBe(1);
    }
  });

  it("scale offensive positions up in high-implied-total spots", () => {
    expect(envMult("WR", 28, 17, ON)).toBeGreaterThan(1);
    expect(envMult("WR", 17, 28, ON)).toBeLessThan(1);
  });

  it("INVERTS for DST: a defense wants its OPPONENT held down", () => {
    // Own team implied 28 (irrelevant), opponent implied 17 → good DST spot.
    const goodSpot = envMult("DST", 28, 17, ON);
    const badSpot = envMult("DST", 28, 30, ON);
    expect(goodSpot).toBeGreaterThan(1);
    expect(badSpot).toBeLessThan(1);
    expect(goodSpot).toBeGreaterThan(badSpot);
  });

  it("script: favorites run more, underdogs throw more", () => {
    const favored = scriptMult("RB", -7, ON);
    const dog = scriptMult("RB", 7, ON);
    expect(favored).toBeGreaterThan(dog);
    expect(scriptMult("WR", 7, ON)).toBeGreaterThan(scriptMult("WR", -7, ON));
  });

  it("never returns a negative or zero multiplier, however extreme the spread", () => {
    for (const spread of [-30, -20, 0, 20, 30]) {
      expect(scriptMult("RB", spread, ON)).toBeGreaterThan(0);
    }
    // The loop above does NOT reach the clamp: with ON's beta.RB the unclamped
    // range is only ~0.49-1.51, so it would still pass with Math.max deleted.
    // A steep coefficient is what actually pins the floor.
    const steep: WeeklyModelParams = {
      ...OFF,
      environment: { ...ON.environment, beta: { RB: -0.5 } },
    };
    expect(scriptMult("RB", 30, steep)).toBe(0.4); // unclamped would be -1.14
    expect(scriptMult("RB", -30, steep)).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyEnvironment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekly/environment.ts
// Vegas game environment → per-position multipliers. Pure.
//
// The market's line is the single best free predictor of how many points a
// game will produce. Implied team points come straight out of it: half the
// total, shifted by half the spread.
//
// IMPORTANT: these coefficients are fitted on the RESIDUAL against the market
// projection (see scripts/calibrate-weekly.ts), never on actual points.
// Sleeper's projection already embeds some of this signal; fitting on actuals
// would count it twice and make the model worse than the number it is built on.
import type { Position } from "../../types";
import type { WeeklyModelParams } from "./model";

/** Half the total, shifted by half the spread. ownSpread negative = favored. */
export function impliedTeamPoints(total: number, ownSpread: number): number {
  return total / 2 - ownSpread / 2;
}

/**
 * Scale by how much scoring this team's game is expected to produce.
 *
 * DST inverts: a defense's fantasy points come from the OPPONENT failing, so
 * DST reads `itpOpp` and carries a negative alpha. Getting this backwards
 * would rank the worst defensive matchups as the best, so it is asserted in
 * tests/weeklyEnvironment.test.ts rather than left to the fit.
 */
export function envMult(
  pos: Position,
  itpOwn: number,
  itpOpp: number,
  p: WeeklyModelParams
): number {
  const alpha = p.environment.alpha[pos];
  if (!alpha) return 1;
  const avg = p.environment.leagueAvgItp;
  if (!(avg > 0)) return 1;
  const itp = pos === "DST" ? itpOpp : itpOwn;
  const ratio = Math.max(0.2, itp / avg); // a shut-out implied total is still not a zero
  return Math.pow(ratio, alpha);
}

/**
 * Game script. Favorites run out the clock; underdogs throw. Expressed per
 * seven points of spread on `ownSpread` itself, so the coefficient reads as
 * "per touchdown of spread" and carries the same sign the calibration fits.
 * Floored well above zero: a 30-point spread should not zero out a running back.
 */
export function scriptMult(pos: Position, ownSpread: number, p: WeeklyModelParams): number {
  const beta = p.environment.beta[pos];
  if (!beta) return 1;
  // Expressed on ownSpread DIRECTLY (negative = favored), matching the spec and
  // the calibration script. Do not rewrite this as `1 - beta * favoredness`:
  // that is algebraically identical but the double negative is what made an
  // earlier draft of this plan invert beta in three places at once.
  //
  // So with beta.RB < 0 a favorite's backs go UP (favorites run out the clock),
  // and with beta.WR > 0 an underdog's receivers go UP (underdogs throw).
  // Floor at 0.4: a 30-point spread should move a back's projection, not erase it.
  return Math.max(0.4, 1 + beta * (ownSpread / 7));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyEnvironment.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/weekly/environment.ts tests/weeklyEnvironment.test.ts
git commit -m "Weekly engine: Vegas environment and game-script multipliers, DST inverted"
```

---

### Task 5: Defense-vs-position table and the matchup multiplier

Splits into a Node-side table builder and a pure multiplier. The table is the existing `lib/etl/schedule.ts` idea moved from season-level to weekly-rolling with proper shrinkage.

**Files:**
- Create: `lib/etl/weekly/dvp.ts`
- Create: `lib/engine/weekly/matchup.ts`
- Test: `tests/weeklyMatchup.test.ts`

**Interfaces:**
- Consumes: `canonicalTeam`, `statLineFromNflverse`, `type Row` from `lib/etl/nflverse.ts`; `scoreStatLine`, `SCORING_PRESETS` from `lib/scoring.ts`; `WeeklyModelParams` from `lib/engine/weekly/model.ts`. (`buildDvp` takes already-parsed `Row[]`, so it needs neither `parseCsv` nor `num` — CSV reading belongs to its caller.)
- Produces:
  - `type DvpTable = Record<string, Partial<Record<Position, number>>>` (mean PPR points allowed per game)
  - `interface DvpResult { table: DvpTable; leagueAvg: Partial<Record<Position, number>>; gamesByTeam: Record<string, number> }`
  - `buildDvp(rows: Record<string,string>[], opts: { season: number; throughWeek: number; lambda: number }): DvpResult`
  - `matchMult(pos: Position, allowed: number | undefined, leagueAvg: number | undefined, gamesObserved: number, p: WeeklyModelParams): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyMatchup.test.ts
import { describe, it, expect } from "vitest";
import { buildDvp } from "../lib/etl/weekly/dvp";
import { matchMult } from "../lib/engine/weekly/matchup";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = DEFAULT_WEEKLY_MODEL;
const ON: WeeklyModelParams = {
  ...OFF,
  matchup: { gamma: { RB: 0.5, WR: 0.5 }, shrinkGames: 6, priorSeasonWeight: 0.5 },
};

function row(o: Partial<Record<string, string>>): Record<string, string> {
  return {
    season: "2025", week: "1", season_type: "REG", position: "RB",
    team: "DET", opponent_team: "CHI", receptions: "0", receiving_yards: "0",
    rushing_yards: "0", rushing_tds: "0", receiving_tds: "0",
    ...o,
  } as Record<string, string>;
}

describe("buildDvp", () => {
  it("sums points allowed by the DEFENSE, per position, per game", () => {
    const rows = [
      row({ week: "1", team: "DET", opponent_team: "CHI", rushing_yards: "100", rushing_tds: "1" }),
      row({ week: "1", team: "DET", opponent_team: "CHI", rushing_yards: "50" }),
      row({ week: "2", team: "GB", opponent_team: "CHI", rushing_yards: "60" }),
    ];
    const { table, gamesByTeam } = buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 1 });
    // CHI allowed 16 + 5 = 21 in week 1 and 6 in week 2 → mean 13.5 per game.
    expect(table.CHI?.RB).toBeCloseTo(13.5, 6);
    expect(gamesByTeam.CHI).toBe(2);
  });

  it("weights recent weeks more when lambda < 1", () => {
    const rows = [
      row({ week: "1", opponent_team: "CHI", rushing_yards: "200" }),
      row({ week: "2", opponent_team: "CHI", rushing_yards: "0", receptions: "0" }),
    ];
    const flat = buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 1 }).table.CHI?.RB ?? 0;
    const recent = buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 0.5 }).table.CHI?.RB ?? 0;
    expect(recent).toBeLessThan(flat); // the recent zero pulls it down harder
  });

  it("ignores postseason and other seasons", () => {
    const rows = [
      row({ week: "1", opponent_team: "CHI", rushing_yards: "100", season_type: "POST" }),
      row({ week: "1", opponent_team: "CHI", rushing_yards: "100", season: "2024" }),
    ];
    expect(buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 1 }).table.CHI).toBeUndefined();
  });

  it("ignores weeks at or after throughWeek — no leakage into the week being predicted", () => {
    const rows = [row({ week: "5", opponent_team: "CHI", rushing_yards: "100" })];
    expect(buildDvp(rows, { season: 2025, throughWeek: 5, lambda: 1 }).table.CHI).toBeUndefined();
  });
});

describe("matchMult", () => {
  it("is exactly 1 in the off state", () => {
    expect(matchMult("RB", 30, 15, 10, OFF)).toBe(1);
  });

  it("is 1 when the defense is average, above 1 when it is generous", () => {
    expect(matchMult("RB", 15, 15, 20, ON)).toBeCloseTo(1, 6);
    expect(matchMult("RB", 25, 15, 20, ON)).toBeGreaterThan(1);
    expect(matchMult("RB", 8, 15, 20, ON)).toBeLessThan(1);
  });

  it("shrinks hard toward neutral on small samples — one bad week is not a bad defense", () => {
    const oneGame = matchMult("RB", 30, 15, 1, ON);
    const manyGames = matchMult("RB", 30, 15, 20, ON);
    expect(oneGame).toBeLessThan(manyGames);
    expect(oneGame).toBeGreaterThan(1);
  });

  it("is neutral when the table has no entry rather than throwing", () => {
    expect(matchMult("RB", undefined, 15, 5, ON)).toBe(1);
    expect(matchMult("RB", 20, undefined, 5, ON)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyMatchup.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the table builder**

```ts
// lib/etl/weekly/dvp.ts
// Defense-vs-position: mean PPR points a defense has allowed to each position,
// exponentially weighted toward recent weeks. Node-only (reads nflverse CSV
// rows) but the aggregation itself is pure and unit-tested.
//
// This is lib/etl/schedule.ts's season-level idea made weekly-rolling. Scored
// in PPR deliberately: DvP is a property of the defense, not of your league's
// scoring, and the multiplier it feeds is a ratio, so the units cancel.
import type { Position } from "../../types";
import { canonicalTeam, statLineFromNflverse, type Row } from "../nflverse";
import { SCORING_PRESETS, scoreStatLine } from "../../scoring";

export type DvpTable = Record<string, Partial<Record<Position, number>>>;

export interface DvpResult {
  table: DvpTable;
  leagueAvg: Partial<Record<Position, number>>;
  /** Distinct weeks observed per defense — drives the shrinkage in matchMult. */
  gamesByTeam: Record<string, number>;
}

const DVP_POS: Position[] = ["QB", "RB", "WR", "TE"];

/**
 * @param throughWeek predict week N using weeks < N only. Passing the week
 *   being predicted is what keeps the backtest honest — a table built through
 *   week N inclusive leaks the answer.
 */
export function buildDvp(
  rows: Row[],
  opts: { season: number; throughWeek: number; lambda: number }
): DvpResult {
  const { season, throughWeek, lambda } = opts;
  // team → pos → { weightedPts, weight }
  const acc: Record<string, Partial<Record<Position, { pts: number }>>> = {};
  const weeks: Record<string, Set<number>> = {};

  for (const r of rows) {
    if (r.season !== String(season) || r.season_type !== "REG") continue;
    const week = Number(r.week);
    if (!Number.isFinite(week) || week >= throughWeek) continue;
    const pos = r.position as Position;
    if (!DVP_POS.includes(pos)) continue;
    const def = canonicalTeam(r.opponent_team);
    if (!def) continue;
    const pts = scoreStatLine(statLineFromNflverse(r), SCORING_PRESETS.ppr, pos === "TE");
    // Recency weight: lambda^(weeks ago). lambda = 1 is a flat mean.
    const w = Math.pow(lambda, throughWeek - 1 - week);
    const byPos = (acc[def] ??= {});
    const cell = (byPos[pos] ??= { pts: 0 });
    cell.pts += pts * w;
    (weeks[def] ??= new Set()).add(week);
  }

  const table: DvpTable = {};
  const gamesByTeam: Record<string, number> = {};
  for (const [team, byPos] of Object.entries(acc)) {
    const weekCount = weeks[team]?.size ?? 0;
    gamesByTeam[team] = weekCount;
    // Total weighted points allowed, spread over the weeks observed: this is
    // per-GAME points allowed to the position group, not per player.
    const totalW = Array.from(weeks[team] ?? []).reduce(
      (s, wk) => s + Math.pow(lambda, throughWeek - 1 - wk),
      0
    );
    // A zero weight sum would make every entry NaN and poison the table
    // silently. Reachable with lambda 0, or by underflow on a tiny lambda.
    if (!(totalW > 0)) continue;
    const out: Partial<Record<Position, number>> = {};
    for (const pos of DVP_POS) {
      const cell = byPos[pos];
      if (!cell) continue;
      out[pos] = cell.pts / totalW;
    }
    table[team] = out;
  }

  const leagueAvg: Partial<Record<Position, number>> = {};
  for (const pos of DVP_POS) {
    const vals = Object.values(table)
      .map((t) => t[pos])
      .filter((v): v is number => typeof v === "number");
    if (vals.length) leagueAvg[pos] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  return { table, leagueAvg, gamesByTeam };
}
```

- [ ] **Step 4: Write the pure multiplier**

```ts
// lib/engine/weekly/matchup.ts
// Opponent-vs-position → a multiplier on the projection. Pure.
//
// Shrunk toward neutral by sample size: three weeks of "this defense allows 30
// a game to running backs" is mostly schedule noise, and a model that takes it
// at face value chases mirages. Like environment.ts, gamma is fitted on the
// RESIDUAL against the market projection, never on actual points.
import type { Position } from "../../types";
import type { WeeklyModelParams } from "./model";

export function matchMult(
  pos: Position,
  allowed: number | undefined,
  leagueAvg: number | undefined,
  gamesObserved: number,
  p: WeeklyModelParams
): number {
  const gamma = p.matchup.gamma[pos];
  if (!gamma) return 1;
  if (typeof allowed !== "number" || typeof leagueAvg !== "number" || !(leagueAvg > 0)) return 1;
  const raw = allowed / leagueAvg;
  // Shrink the RATIO toward 1 by n/(n+k), then apply the exponent.
  const k = p.matchup.shrinkGames;
  const n = Math.max(0, gamesObserved);
  const shrunk = 1 + (n / (n + k)) * (raw - 1);
  return Math.pow(Math.max(0.2, shrunk), gamma);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyMatchup.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/etl/weekly/dvp.ts lib/engine/weekly/matchup.ts tests/weeklyMatchup.test.ts
git commit -m "Weekly engine: rolling defense-vs-position with sample-size shrinkage"
```

---

### Task 6: Usage model — our own second opinion

The differentiated half of the ensemble. Node side extracts shares from nflverse; the engine side turns shares into a projected stat line.

**Files:**
- Create: `lib/etl/weekly/usage.ts`
- Create: `lib/engine/weekly/usageModel.ts`
- Test: `tests/weeklyUsage.test.ts`

**Interfaces:**
- Consumes: `parseCsv`, `canonicalTeam`, `num`, `type Row` from `lib/etl/nflverse.ts`; `WeeklyModelParams`; `StatLine`.
- Produces:
  - `interface UsageWeek { week: number; team: string; targets: number; carries: number; attempts: number; recYds: number; rushYds: number; passYds: number; teamTargets: number; teamCarries: number; teamAttempts: number }`
  - `type UsageHistory = Record<string, UsageWeek[]>` — keyed by **gsis id**
  - `buildUsageHistory(rows: Row[], opts: { season: number; throughWeek: number }): UsageHistory`
  - `remapToSleeper(history: UsageHistory, gsisToSleeper: Record<string, string>): UsageHistory`
  - `interface Shares { targetShare: number; carryShare: number; attemptShare: number; games: number }`
  - `rollingShares(weeks: UsageWeek[], lambda: number): Shares`
  - `blendWithPrior(observed: Shares, prior: Shares, priorGames: number): Shares`
  - `projectUsageStatLine(input: UsageProjectionInput, p: WeeklyModelParams): StatLine`
  - `interface UsageProjectionInput { pos: Position; shares: Shares; teamVolume: { targets: number; carries: number; attempts: number }; efficiency: Efficiency; priorEfficiency: Efficiency }`
  - `interface Efficiency { ydsPerTarget: number; ydsPerCarry: number; ydsPerAttempt: number; tdPerTarget: number; tdPerCarry: number; tdPerAttempt: number; catchRate: number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyUsage.test.ts
import { describe, it, expect } from "vitest";
import { buildUsageHistory, remapToSleeper } from "../lib/etl/weekly/usage";
import {
  rollingShares,
  blendWithPrior,
  projectUsageStatLine,
  type Efficiency,
  type UsageWeek,
} from "../lib/engine/weekly/usageModel";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";

function nflRow(o: Record<string, string>): Record<string, string> {
  return {
    season: "2025", season_type: "REG", week: "1", player_id: "00-0001",
    position: "WR", team: "DET", opponent_team: "CHI",
    targets: "0", carries: "0", attempts: "0",
    receiving_yards: "0", rushing_yards: "0", passing_yards: "0",
    ...o,
  };
}

describe("buildUsageHistory", () => {
  it("records a player's own volume and his team's total in the same week", () => {
    const rows = [
      nflRow({ player_id: "00-0001", targets: "10", receiving_yards: "120" }),
      nflRow({ player_id: "00-0002", targets: "6" }),
      nflRow({ player_id: "00-0003", position: "RB", carries: "18", rushing_yards: "80" }),
      nflRow({ player_id: "00-0004", position: "QB", attempts: "30", passing_yards: "260" }),
    ];
    const h = buildUsageHistory(rows, { season: 2025, throughWeek: 2 });
    expect(h["00-0001"][0].targets).toBe(10);
    expect(h["00-0001"][0].teamTargets).toBe(16);
    expect(h["00-0003"][0].teamCarries).toBe(18);
    expect(h["00-0004"][0].teamAttempts).toBe(30);
  });

  it("excludes the week being predicted", () => {
    const rows = [nflRow({ week: "4", targets: "9" })];
    expect(buildUsageHistory(rows, { season: 2025, throughWeek: 4 })["00-0001"]).toBeUndefined();
  });

  it("remaps gsis keys to sleeper ids and drops players with no mapping", () => {
    const h = buildUsageHistory([nflRow({ targets: "5" }), nflRow({ player_id: "00-9999", targets: "5" })], {
      season: 2025, throughWeek: 2,
    });
    const mapped = remapToSleeper(h, { "00-0001": "4034" });
    expect(mapped["4034"]).toBeDefined();
    expect(Object.keys(mapped)).toHaveLength(1);
  });
});

const wk = (week: number, targets: number, teamTargets: number): UsageWeek => ({
  week, team: "DET", targets, carries: 0, attempts: 0,
  recYds: 0, rushYds: 0, passYds: 0,
  teamTargets, teamCarries: 0, teamAttempts: 0,
});

describe("rollingShares", () => {
  it("with lambda 1 is the plain mean share", () => {
    const s = rollingShares([wk(1, 10, 40), wk(2, 6, 30)], 1);
    expect(s.targetShare).toBeCloseTo((0.25 + 0.2) / 2, 6);
    expect(s.games).toBe(2);
  });

  it("with lambda < 1 leans on the most recent week", () => {
    const s = rollingShares([wk(1, 4, 40), wk(2, 12, 40)], 0.5);
    expect(s.targetShare).toBeGreaterThan(0.2); // flat mean would be 0.2
  });

  it("returns zero shares and zero games on an empty history rather than NaN", () => {
    const s = rollingShares([], 0.75);
    expect(s.targetShare).toBe(0);
    expect(s.games).toBe(0);
    expect(Number.isNaN(s.carryShare)).toBe(false);
  });
});

describe("blendWithPrior", () => {
  const prior = { targetShare: 0.2, carryShare: 0, attemptShare: 0, games: 0 };
  it("is the prior with zero games observed — week 1 must not read noise as signal", () => {
    const observed = { targetShare: 0.4, carryShare: 0, attemptShare: 0, games: 0 };
    expect(blendWithPrior(observed, prior, 4).targetShare).toBeCloseTo(0.2, 6);
  });

  it("moves toward the observation as games accumulate", () => {
    const observed = { targetShare: 0.4, carryShare: 0, attemptShare: 0, games: 12 };
    const blended = blendWithPrior(observed, prior, 4).targetShare;
    expect(blended).toBeGreaterThan(0.3);
    expect(blended).toBeLessThan(0.4);
  });
});

describe("projectUsageStatLine", () => {
  const eff: Efficiency = {
    ydsPerTarget: 12, ydsPerCarry: 5, ydsPerAttempt: 7.5,
    tdPerTarget: 0.12, tdPerCarry: 0.05, tdPerAttempt: 0.06, catchRate: 0.7,
  };
  const priorEff: Efficiency = {
    ydsPerTarget: 8, ydsPerCarry: 4.2, ydsPerAttempt: 7,
    tdPerTarget: 0.06, tdPerCarry: 0.03, tdPerAttempt: 0.045, catchRate: 0.65,
  };

  it("volume times efficiency, with efficiency shrunk hard toward the prior", () => {
    const stats = projectUsageStatLine(
      {
        pos: "WR",
        shares: { targetShare: 0.25, carryShare: 0, attemptShare: 0, games: 10 },
        teamVolume: { targets: 32, carries: 24, attempts: 32 },
        efficiency: eff,
        priorEfficiency: priorEff,
      },
      DEFAULT_WEEKLY_MODEL
    );
    // 0.25 * 32 = 8 targets. effReliability 0.15 → ydsPerTarget ≈ 8.6.
    expect(stats.receptions).toBeCloseTo(8 * (0.65 + 0.15 * (0.7 - 0.65)), 4);
    expect(stats.recYds).toBeCloseTo(8 * (8 + 0.15 * (12 - 8)), 4);
    expect(stats.rushYds ?? 0).toBe(0);
  });

  it("gives a QB passing volume and a back carries, not each other's", () => {
    const shares = { targetShare: 0.05, carryShare: 0.6, attemptShare: 0.95, games: 8 };
    const teamVolume = { targets: 32, carries: 24, attempts: 32 };
    const rb = projectUsageStatLine({ pos: "RB", shares, teamVolume, efficiency: eff, priorEfficiency: priorEff }, DEFAULT_WEEKLY_MODEL);
    const qb = projectUsageStatLine({ pos: "QB", shares, teamVolume, efficiency: eff, priorEfficiency: priorEff }, DEFAULT_WEEKLY_MODEL);
    expect(rb.rushYds).toBeGreaterThan(0);
    expect(rb.passYds ?? 0).toBe(0);
    expect(qb.passYds).toBeGreaterThan(0);
    // Carries are deliberately NOT position-gated: a QB's own carry share is
    // real scramble usage. Asserted so the asymmetry is documented, not implied.
    expect(qb.rushYds).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyUsage.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the Node-side extractor**

```ts
// lib/etl/weekly/usage.ts
// Player and team volume per week, from nflverse's weekly box scores.
// Keyed by gsis id (nflverse's player_id); remapped to sleeper ids via the
// DynastyProcess crosswalk, which carries both for all 12,492 of its rows.
//
// Node-only in the sense that it reads CSV rows, but the aggregation is pure
// and unit-tested — no fetch happens here.
import { canonicalTeam, num, type Row } from "../nflverse";
import type { UsageWeek, UsageHistory } from "../../engine/weekly/usageModel";

/**
 * @param throughWeek weeks strictly BEFORE this are included. Passing the week
 *   being predicted keeps the backtest free of leakage.
 */
export function buildUsageHistory(
  rows: Row[],
  opts: { season: number; throughWeek: number }
): UsageHistory {
  const { season, throughWeek } = opts;
  // First pass: team totals per week.
  const team: Record<string, { targets: number; carries: number; attempts: number }> = {};
  const keyOf = (t: string, w: number) => `${t}|${w}`;
  const inScope = (r: Row) => {
    if (r.season !== String(season) || r.season_type !== "REG") return false;
    const w = Number(r.week);
    return Number.isFinite(w) && w < throughWeek;
  };
  for (const r of rows) {
    if (!inScope(r)) continue;
    const t = canonicalTeam(r.team);
    if (!t) continue;
    const k = keyOf(t, Number(r.week));
    const cell = (team[k] ??= { targets: 0, carries: 0, attempts: 0 });
    cell.targets += num(r.targets);
    cell.carries += num(r.carries);
    cell.attempts += num(r.attempts);
  }
  // Second pass: per-player rows carrying their team's totals.
  const out: UsageHistory = {};
  for (const r of rows) {
    if (!inScope(r)) continue;
    const id = r.player_id;
    const t = canonicalTeam(r.team);
    if (!id || !t) continue;
    const week = Number(r.week);
    const tt = team[keyOf(t, week)] ?? { targets: 0, carries: 0, attempts: 0 };
    (out[id] ??= []).push({
      week,
      team: t,
      targets: num(r.targets),
      carries: num(r.carries),
      attempts: num(r.attempts),
      recYds: num(r.receiving_yards),
      rushYds: num(r.rushing_yards),
      passYds: num(r.passing_yards),
      teamTargets: tt.targets,
      teamCarries: tt.carries,
      teamAttempts: tt.attempts,
    });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.week - b.week);
  return out;
}

/** gsis-keyed history → sleeper-keyed. Unmapped players are dropped. */
export function remapToSleeper(
  history: UsageHistory,
  gsisToSleeper: Record<string, string>
): UsageHistory {
  const out: UsageHistory = {};
  for (const [gsis, weeks] of Object.entries(history)) {
    const sleeper = gsisToSleeper[gsis];
    if (sleeper) out[sleeper] = weeks;
  }
  return out;
}
```

- [ ] **Step 4: Write the pure usage model**

```ts
// lib/engine/weekly/usageModel.ts
// Our own second opinion, independent of any market projection: recent share
// of team volume × expected team volume × shrunk efficiency.
//
// The asymmetry here is deliberate and is the whole reason this module exists.
// Volume is signal — target share is stable and predictive. Efficiency is
// mostly noise — a three-game 22% touchdown rate is not a skill, and a model
// that treats it as one is confidently wrong. So shares carry through nearly
// intact while efficiency is shrunk hard toward a position prior by
// `usage.effReliability`.
import type { Position, StatLine } from "../../types";
import type { WeeklyModelParams } from "./model";

export interface UsageWeek {
  week: number;
  team: string;
  targets: number;
  carries: number;
  attempts: number;
  recYds: number;
  rushYds: number;
  passYds: number;
  teamTargets: number;
  teamCarries: number;
  teamAttempts: number;
}

export type UsageHistory = Record<string, UsageWeek[]>;

export interface Shares {
  targetShare: number;
  carryShare: number;
  attemptShare: number;
  /** Weeks of usage actually observed — drives the prior blend. */
  games: number;
}

export interface Efficiency {
  ydsPerTarget: number;
  ydsPerCarry: number;
  ydsPerAttempt: number;
  tdPerTarget: number;
  tdPerCarry: number;
  tdPerAttempt: number;
  catchRate: number;
}

/** Exponentially-weighted share of team volume. lambda = 1 is a flat mean. */
export function rollingShares(weeks: UsageWeek[], lambda: number): Shares {
  if (weeks.length === 0) {
    return { targetShare: 0, carryShare: 0, attemptShare: 0, games: 0 };
  }
  const latest = weeks[weeks.length - 1].week;
  let wSum = 0;
  let t = 0;
  let c = 0;
  let a = 0;
  for (const w of weeks) {
    const weight = Math.pow(lambda, latest - w.week);
    wSum += weight;
    t += weight * (w.teamTargets > 0 ? w.targets / w.teamTargets : 0);
    c += weight * (w.teamCarries > 0 ? w.carries / w.teamCarries : 0);
    a += weight * (w.teamAttempts > 0 ? w.attempts / w.teamAttempts : 0);
  }
  return {
    targetShare: t / wSum,
    carryShare: c / wSum,
    attemptShare: a / wSum,
    games: weeks.length,
  };
}

/**
 * Blend observed share toward a preseason prior by n/(n+k). With zero games
 * observed this is exactly the prior — which is what stops week 1 from reading
 * three snaps as a breakout.
 */
export function blendWithPrior(observed: Shares, prior: Shares, priorGames: number): Shares {
  const n = observed.games;
  const w = n / (n + priorGames);
  const mix = (o: number, p: number) => p + w * (o - p);
  return {
    targetShare: mix(observed.targetShare, prior.targetShare),
    carryShare: mix(observed.carryShare, prior.carryShare),
    attemptShare: mix(observed.attemptShare, prior.attemptShare),
    games: n,
  };
}

export interface UsageProjectionInput {
  pos: Position;
  shares: Shares;
  teamVolume: { targets: number; carries: number; attempts: number };
  efficiency: Efficiency;
  priorEfficiency: Efficiency;
}

export function projectUsageStatLine(
  input: UsageProjectionInput,
  p: WeeklyModelParams
): StatLine {
  const r = p.usage.effReliability;
  const shrink = (obs: number, prior: number) => prior + r * (obs - prior);
  const e = input.efficiency;
  const pe = input.priorEfficiency;

  const targets = input.shares.targetShare * input.teamVolume.targets;
  const carries = input.shares.carryShare * input.teamVolume.carries;
  const attempts = input.pos === "QB" ? input.shares.attemptShare * input.teamVolume.attempts : 0;

  const out: StatLine = {};
  const set = (k: keyof StatLine, v: number) => {
    if (v > 0) out[k] = v;
  };

  if (targets > 0) {
    set("receptions", targets * shrink(e.catchRate, pe.catchRate));
    set("recYds", targets * shrink(e.ydsPerTarget, pe.ydsPerTarget));
    set("recTD", targets * shrink(e.tdPerTarget, pe.tdPerTarget));
  }
  if (carries > 0) {
    set("rushYds", carries * shrink(e.ydsPerCarry, pe.ydsPerCarry));
    set("rushTD", carries * shrink(e.tdPerCarry, pe.tdPerCarry));
  }
  if (attempts > 0) {
    set("passYds", attempts * shrink(e.ydsPerAttempt, pe.ydsPerAttempt));
    set("passTD", attempts * shrink(e.tdPerAttempt, pe.tdPerAttempt));
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyUsage.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/etl/weekly/usage.ts lib/engine/weekly/usageModel.ts tests/weeklyUsage.test.ts
git commit -m "Weekly engine: own usage model — stable shares, hard-shrunk efficiency"
```

---

### Task 7: Volume-dependent spread

The number that makes floor and ceiling mean something.

**Files:**
- Create: `lib/engine/weekly/spread.ts`
- Test: `tests/weeklySpread.test.ts`

**Interfaces:**
- Consumes: `WeeklyModelParams`.
- Produces: `projectedVolume(pos: Position, stats: StatLine): number`, `weeklySigma(pos: Position, volume: number, p: WeeklyModelParams): number`, `lognormalQuantile(mean: number, sigma: number, q: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklySpread.test.ts
import { describe, it, expect } from "vitest";
import { projectedVolume, weeklySigma, lognormalQuantile } from "../lib/engine/weekly/spread";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = DEFAULT_WEEKLY_MODEL;
const ON: WeeklyModelParams = { ...OFF, sigma: { ...OFF.sigma, delta: 0.35 } };

describe("projectedVolume", () => {
  it("counts the touches that matter for the position", () => {
    expect(projectedVolume("RB", { rushYds: 80, receptions: 3 })).toBeGreaterThan(0);
    expect(projectedVolume("QB", { passYds: 250 })).toBeGreaterThan(0);
    expect(projectedVolume("WR", { receptions: 5, recYds: 70 })).toBeGreaterThan(0);
    expect(projectedVolume("DST", {})).toBeGreaterThan(0); // never zero — sigma must not divide by it
  });
});

describe("weeklySigma", () => {
  it("in the off state (delta 0) is the flat per-position sigma", () => {
    expect(weeklySigma("WR", 2, OFF)).toBeCloseTo(OFF.sigma.sigma0.WR!, 10);
    expect(weeklySigma("WR", 14, OFF)).toBeCloseTo(OFF.sigma.sigma0.WR!, 10);
  });

  it("with the lever on, high-volume players are less volatile than low-volume ones", () => {
    const bigBack = weeklySigma("RB", 22, ON);
    const flier = weeklySigma("RB", 4, ON);
    expect(bigBack).toBeLessThan(flier);
  });

  it("is finite and positive at zero volume rather than exploding", () => {
    const s = weeklySigma("WR", 0, ON);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(3);
  });

  it("falls back to a sane default for a position with no fitted sigma", () => {
    const bare: WeeklyModelParams = { ...OFF, sigma: { sigma0: {}, v0: {}, delta: 0 } };
    expect(weeklySigma("WR", 8, bare)).toBeGreaterThan(0);
  });
});

describe("lognormalQuantile", () => {
  it("the median of a lognormal sits below its mean", () => {
    const mean = 12;
    const sigma = 0.8;
    expect(lognormalQuantile(mean, sigma, 0.5)).toBeLessThan(mean);
  });

  it("quantiles are ordered and straddle the mean", () => {
    const p10 = lognormalQuantile(12, 0.8, 0.1);
    const p50 = lognormalQuantile(12, 0.8, 0.5);
    const p90 = lognormalQuantile(12, 0.8, 0.9);
    expect(p10).toBeLessThan(p50);
    expect(p50).toBeLessThan(p90);
    expect(p10).toBeGreaterThan(0);
    expect(p90).toBeGreaterThan(12);
  });

  it("a zero mean stays zero — a benched player has no ceiling", () => {
    expect(lognormalQuantile(0, 0.8, 0.9)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklySpread.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekly/spread.ts
// How wide a player's week is. Pure.
//
// Sigma depends on projected VOLUME, not only on position. An 18-touch back is
// genuinely less volatile than a 4-target flier, and giving them the same shape
// is what makes most tools' floor/ceiling numbers useless. Fitted per position
// by scripts/calibrate-weekly.ts; delta = 0 recovers a flat per-position sigma.
import type { Position, StatLine } from "../../types";
import type { WeeklyModelParams } from "./model";

/** Fallbacks for a position the calibration has not fitted yet. */
const SIGMA_FALLBACK = 0.8;
const V0_FALLBACK = 8;
/** Volume can never be 0 in the sigma formula — it is a denominator. */
const MIN_VOLUME = 0.5;

/** Touches (or attempts) the projection implies. */
export function projectedVolume(pos: Position, stats: StatLine): number {
  switch (pos) {
    case "QB":
      // Attempts are not in the projected stat line; passing yards / 7.5 is a
      // stable proxy and the ratio is all sigma needs.
      return Math.max(MIN_VOLUME, (stats.passYds ?? 0) / 7.5 + (stats.rushYds ?? 0) / 5);
    case "RB":
      return Math.max(MIN_VOLUME, (stats.rushYds ?? 0) / 4.3 + (stats.receptions ?? 0));
    case "WR":
    case "TE":
      // Receptions understate volume; targets are the real driver, and catch
      // rate is roughly 0.65 league-wide.
      return Math.max(MIN_VOLUME, (stats.receptions ?? 0) / 0.65);
    default:
      // K and DST have no touch count. Their sigma is flat by construction.
      return Math.max(MIN_VOLUME, 1);
  }
}

export function weeklySigma(pos: Position, volume: number, p: WeeklyModelParams): number {
  const sigma0 = p.sigma.sigma0[pos] ?? SIGMA_FALLBACK;
  if (!p.sigma.delta) return sigma0;
  const v0 = p.sigma.v0[pos] ?? V0_FALLBACK;
  const v = Math.max(MIN_VOLUME, volume);
  const scaled = sigma0 * Math.pow(v0 / v, p.sigma.delta);
  // Clamp: a 0.1-volume player must not get a sigma of 4 and dominate every
  // ceiling ranking on the strength of arithmetic.
  return Math.min(2.5, Math.max(0.15, scaled));
}

/** Inverse normal CDF, Acklam's rational approximation (|error| < 1.15e-9). */
function probit(q: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (q <= 0) return -Infinity;
  if (q >= 1) return Infinity;
  if (q < pLow) {
    const s = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * s + c[1]) * s + c[2]) * s + c[3]) * s + c[4]) * s + c[5]) / ((((d[0] * s + d[1]) * s + d[2]) * s + d[3]) * s + 1);
  }
  if (q <= 1 - pLow) {
    const s = q - 0.5;
    const r = s * s;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * s / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const s = Math.sqrt(-2 * Math.log(1 - q));
  return -(((((c[0] * s + c[1]) * s + c[2]) * s + c[3]) * s + c[4]) * s + c[5]) / ((((d[0] * s + d[1]) * s + d[2]) * s + d[3]) * s + 1);
}

/**
 * Quantile of a lognormal with the given ARITHMETIC mean and log-sigma.
 * mu = log(mean) − sigma²/2 so that E[X] = mean exactly, which is what keeps
 * the quantiles consistent with the projection they came from.
 */
export function lognormalQuantile(mean: number, sigma: number, q: number): number {
  if (!(mean > 0)) return 0;
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  return Math.exp(mu + sigma * probit(q));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklySpread.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/weekly/spread.ts tests/weeklySpread.test.ts
git commit -m "Weekly engine: volume-dependent sigma and lognormal quantiles"
```

---

### Task 8: Availability

**Files:**
- Create: `lib/engine/weekly/availability.ts`
- Test: `tests/weeklyAvailability.test.ts`

**Interfaces:**
- Consumes: `WeeklyModelParams`; `STATUS_MISS_PROB` from `lib/engine/outcomeModel.ts`.
- Produces: `pPlay(status: string | null | undefined, isBye: boolean, p: WeeklyModelParams): number`, `FALLBACK_PLAY_PROB: Record<string, number>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyAvailability.test.ts
import { describe, it, expect } from "vitest";
import { pPlay, FALLBACK_PLAY_PROB } from "../lib/engine/weekly/availability";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = DEFAULT_WEEKLY_MODEL;

describe("pPlay", () => {
  it("a bye is zero, unconditionally — no status can rescue it", () => {
    expect(pPlay(null, true, OFF)).toBe(0);
    expect(pPlay("Questionable", true, OFF)).toBe(0);
  });

  it("healthy players are near-certain but not certain", () => {
    const p = pPlay(null, false, OFF);
    expect(p).toBeGreaterThan(0.9);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("ranks statuses in the only order that makes sense", () => {
    expect(pPlay("Questionable", false, OFF)).toBeLessThan(pPlay(null, false, OFF));
    expect(pPlay("Doubtful", false, OFF)).toBeLessThan(pPlay("Questionable", false, OFF));
    expect(pPlay("Out", false, OFF)).toBeLessThan(pPlay("Doubtful", false, OFF));
    expect(pPlay("IR", false, OFF)).toBe(0);
  });

  it("prefers a fitted table over the fallback when one exists", () => {
    const fitted: WeeklyModelParams = {
      ...OFF,
      availability: { byStatus: { Questionable: 0.42 } },
    };
    expect(pPlay("Questionable", false, fitted)).toBeCloseTo(0.42, 10);
    // Unfitted statuses still fall back rather than becoming undefined.
    expect(pPlay("Doubtful", false, fitted)).toBeCloseTo(FALLBACK_PLAY_PROB.Doubtful, 10);
  });

  it("treats an unrecognized status as healthy rather than as out", () => {
    expect(pPlay("Probable", false, OFF)).toBe(pPlay(null, false, OFF));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyAvailability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekly/availability.ts
// P(this player is active this week). Pure.
//
// The fallback numbers below are the season model's STATUS_MISS_PROB read as
// weekly play probabilities. They are a stopgap: Sleeper's weekly projection
// payload carries `player.injury_status`, and nflverse says whether he actually
// played, so scripts/calibrate-weekly.ts measures the real
// status → P(played) table and writes it to availability.byStatus. Until it
// runs, these apply.
import type { WeeklyModelParams } from "./model";

/** Derived from lib/engine/outcomeModel.ts STATUS_MISS_PROB. */
export const FALLBACK_PLAY_PROB: Record<string, number> = {
  Questionable: 0.75,
  Doubtful: 0.25,
  Out: 0.02,
  IR: 0,
  PUP: 0,
  Sus: 0,
  NA: 0,
};

/** A player with no designation still misses the odd week. */
const HEALTHY_PLAY_PROB = 0.97;

export function pPlay(
  status: string | null | undefined,
  isBye: boolean,
  p: WeeklyModelParams
): number {
  if (isBye) return 0;
  if (!status) return HEALTHY_PLAY_PROB;
  const fitted = p.availability.byStatus[status];
  if (typeof fitted === "number") return Math.min(1, Math.max(0, fitted));
  const fallback = FALLBACK_PLAY_PROB[status];
  // An unknown designation is far more likely to be a label we do not parse
  // than a hidden injury. Treating it as Out would bench healthy starters.
  return typeof fallback === "number" ? fallback : HEALTHY_PLAY_PROB;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyAvailability.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/weekly/availability.ts tests/weeklyAvailability.test.ts
git commit -m "Weekly engine: availability from injury status, fitted table with fallback"
```

---

### Task 9: Ensemble blend and outlook assembly

The centerpiece. Everything so far becomes one `WeekOutlook` per player, and the off-state regression test is the contract that makes every later gate meaningful.

Note the deliberate decoupling: this module does **not** import the ETL's file shapes. It takes a per-team line record and a **lookup function** for defense-vs-position, so the engine stays independent of how the data got there and the tests need no fixtures.

**Files:**
- Create: `lib/engine/weekly/outlook.ts`
- Test: `tests/weeklyOutlook.test.ts`

**Interfaces:**
- Consumes: `WeeklyModelParams` (Task 1), `envMult`/`scriptMult`/`impliedTeamPoints` (Task 4), `matchMult` (Task 5), `projectedVolume`/`weeklySigma`/`lognormalQuantile` (Task 7), `pPlay` (Task 8), `scoreStatLine` from `lib/scoring.ts`.
- Produces:
  - `interface WeekLine { total: number; ownSpread: number; opp: string }`
  - `type DvpLookup = (defense: string, pos: Position) => { allowed?: number; leagueAvg?: number; games: number }`
  - `interface WeekPlayerInput { id: string; pos: Position; team: string; bye: number | null; status: string | null; sleeper?: StatLine; sleeperPoints?: number; espn?: StatLine; dk?: number; usage?: StatLine }` — `sleeperPoints` is the K/DST total-only fallback; see Task 2
  - `interface WeekOutlook { ... }` (as in the spec)
  - `blendMarket(input: WeekPlayerInput, scoring: ScoringSettings, p: WeeklyModelParams): number`
  - `buildWeekOutlooks(args: { week: number; players: WeekPlayerInput[]; linesByTeam: Record<string, WeekLine>; dvp: DvpLookup; scoring: ScoringSettings; params: WeeklyModelParams }): WeekOutlook[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyOutlook.test.ts
import { describe, it, expect } from "vitest";
import { buildWeekOutlooks, blendMarket, type WeekPlayerInput, type WeekLine } from "../lib/engine/weekly/outlook";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";

const scoring = SCORING_PRESETS.ppr;
const OFF = DEFAULT_WEEKLY_MODEL;

const gibbs: WeekPlayerInput = {
  id: "6813", pos: "RB", team: "DET", bye: 8, status: null,
  sleeper: { rushYds: 99.6, rushTD: 1.05, receptions: 3.95, recYds: 26.2 },
};
const lines: Record<string, WeekLine> = {
  DET: { total: 49.5, ownSpread: -6.5, opp: "CHI" },
  CHI: { total: 49.5, ownSpread: 6.5, opp: "DET" },
};
const noDvp = () => ({ games: 0 });

describe("off state — the contract every gate is measured against", () => {
  it("reproduces raw Sleeper, re-scored, exactly", () => {
    const [o] = buildWeekOutlooks({
      week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: OFF,
    });
    const expected = scoreStatLine(gibbs.sleeper!, scoring);
    expect(o.meanIfPlays).toBeCloseTo(expected, 10);
    expect(o.drivers.matchMult).toBe(1);
    expect(o.drivers.envMult).toBe(1);
    expect(o.drivers.scriptMult).toBe(1);
    expect(o.drivers.baseUsage).toBe(0);
  });

  it("respects league scoring rather than a source's published total", () => {
    const tePremium = { ...scoring, bonus_rec_te: 0.5 };
    const te: WeekPlayerInput = { id: "1", pos: "TE", team: "DET", bye: 8, status: null, sleeper: { receptions: 6, recYds: 60 } };
    const [o] = buildWeekOutlooks({ week: 2, players: [te], linesByTeam: lines, dvp: noDvp, scoring: tePremium, params: OFF });
    expect(o.meanIfPlays).toBeCloseTo(6 * 1.5 + 6, 10); // 6 rec at 1.5 + 60 yds at 0.1
  });
});

describe("blendMarket", () => {
  it("renormalizes when a weighted source is missing rather than silently deflating", () => {
    const p: WeeklyModelParams = { ...OFF, sourceWeights: { sleeper: 0.5, espn: 0.5, dk: 0 } };
    // ESPN absent → sleeper must carry the full weight, not half of it.
    const only = blendMarket(gibbs, scoring, p);
    expect(only).toBeCloseTo(scoreStatLine(gibbs.sleeper!, scoring), 10);
  });

  it("averages two sources when both are present", () => {
    const p: WeeklyModelParams = { ...OFF, sourceWeights: { sleeper: 0.5, espn: 0.5, dk: 0 } };
    const both: WeekPlayerInput = { ...gibbs, espn: { rushYds: 60, rushTD: 0.5 } };
    const s = scoreStatLine(both.sleeper!, scoring);
    const e = scoreStatLine(both.espn!, scoring);
    expect(blendMarket(both, scoring, p)).toBeCloseTo((s + e) / 2, 10);
  });

  it("uses DK's point total directly — DK publishes a projection, not a stat line", () => {
    const p: WeeklyModelParams = { ...OFF, sourceWeights: { sleeper: 0, espn: 0, dk: 1 } };
    expect(blendMarket({ ...gibbs, dk: 17.5 }, scoring, p)).toBeCloseTo(17.5, 10);
  });

  it("returns 0 when no source has an opinion", () => {
    expect(blendMarket({ id: "x", pos: "WR", team: "DET", bye: 8, status: null }, scoring, OFF)).toBe(0);
  });
});

describe("assembly", () => {
  const ON: WeeklyModelParams = {
    ...OFF,
    modelWeights: { market: 0.7, usage: 0.3 },
    environment: { leagueAvgItp: 22.5, alpha: { RB: 0.4 }, beta: { RB: -0.12 } },
    matchup: { gamma: { RB: 0.5 }, shrinkGames: 6, priorSeasonWeight: 0.5 },
    sigma: { ...OFF.sigma, delta: 0.35 },
  };

  it("a bye week is zero mean but keeps a non-zero conditional projection", () => {
    const [o] = buildWeekOutlooks({ week: 8, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(o.pPlay).toBe(0);
    expect(o.mean).toBe(0);
    expect(o.meanIfPlays).toBeGreaterThan(0);
    expect(o.opp).toBeNull();
  });

  it("a player whose team has no line this week is treated as a bye", () => {
    const orphan: WeekPlayerInput = { ...gibbs, team: "SEA" };
    const [o] = buildWeekOutlooks({ week: 2, players: [orphan], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(o.pPlay).toBe(0);
    expect(o.opp).toBeNull();
  });

  it("blends the usage model in at its configured weight", () => {
    const withUsage: WeekPlayerInput = { ...gibbs, usage: { rushYds: 60, receptions: 2, recYds: 15 } };
    const [o] = buildWeekOutlooks({ week: 2, players: [withUsage], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    const m = scoreStatLine(withUsage.sleeper!, scoring);
    const u = scoreStatLine(withUsage.usage!, scoring);
    expect(o.drivers.baseUsage).toBeCloseTo(u, 10);
    // 0.7m + 0.3u, then the environment and script multipliers.
    const base = 0.7 * m + 0.3 * u;
    expect(o.meanIfPlays).toBeCloseTo(base * o.drivers.envMult * o.drivers.scriptMult * o.drivers.matchMult, 8);
  });

  it("falls back to the market alone when usage has no opinion, without deflating", () => {
    const [o] = buildWeekOutlooks({ week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    const m = scoreStatLine(gibbs.sleeper!, scoring);
    expect(o.meanIfPlays).toBeCloseTo(m * o.drivers.envMult * o.drivers.scriptMult, 8);
  });

  it("orders the quantiles and reports the opponent", () => {
    const [o] = buildWeekOutlooks({ week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(o.opp).toBe("CHI");
    expect(o.p10).toBeLessThan(o.p50);
    expect(o.p50).toBeLessThan(o.p90);
    expect(o.sigma).toBeGreaterThan(0);
  });

  it("is deterministic: same input, identical output", () => {
    const args = { week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON };
    expect(JSON.stringify(buildWeekOutlooks(args))).toBe(JSON.stringify(buildWeekOutlooks(args)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyOutlook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekly/outlook.ts
// Assembles one WeekOutlook per player: the market ensemble blended with our
// usage model, scaled by environment / script / matchup, with a
// volume-dependent lognormal spread and an availability probability.
//
// Deliberately decoupled from the ETL: this takes a per-team line record and a
// DvP LOOKUP FUNCTION, never the ETL's file shapes. The engine does not know
// where the numbers came from, which is what keeps it pure and its tests
// fixture-free.
import type { Position, ScoringSettings, StatLine } from "../../types";
import { scoreStatLine } from "../../scoring";
import type { WeeklyModelParams } from "./model";
import { envMult, impliedTeamPoints, scriptMult } from "./environment";
import { matchMult } from "./matchup";
import { pPlay } from "./availability";
import { lognormalQuantile, projectedVolume, weeklySigma } from "./spread";

export interface WeekLine {
  total: number;
  /** Negative = this team is favored. */
  ownSpread: number;
  opp: string;
}

export type DvpLookup = (
  defense: string,
  pos: Position
) => { allowed?: number; leagueAvg?: number; games: number };

export interface WeekPlayerInput {
  id: string;
  pos: Position;
  team: string;
  bye: number | null;
  status: string | null;
  /** Projected stat lines per market source. DK publishes a total, not a line. */
  sleeper?: StatLine;
  /**
   * K and DST only: Sleeper's published total, used when there is no
   * re-scorable stat line (see lib/etl/weekly/sleeperWeekly.ts). Ignored
   * whenever `sleeper` is present.
   */
  sleeperPoints?: number;
  espn?: StatLine;
  dk?: number;
  /** Our own usage model's projected stat line, when we have usage for him. */
  usage?: StatLine;
}

export interface WeekOutlook {
  playerId: string;
  week: number;
  opp: string | null;
  meanIfPlays: number;
  mean: number;
  sigma: number;
  p10: number;
  p50: number;
  p90: number;
  pPlay: number;
  stats: StatLine;
  drivers: {
    baseMarket: number;
    baseUsage: number;
    matchMult: number;
    envMult: number;
    scriptMult: number;
    status: string | null;
  };
}

/**
 * Weighted mean of the market sources that actually have an opinion, with the
 * weights renormalized over those present. Without renormalization a player
 * ESPN has never heard of would be quietly projected 50% low.
 */
export function blendMarket(
  input: WeekPlayerInput,
  scoring: ScoringSettings,
  p: WeeklyModelParams
): number {
  const isTE = input.pos === "TE";
  const parts: { w: number; v: number }[] = [];
  if (p.sourceWeights.sleeper > 0) {
    // A stat line is preferred because it can be re-scored under league
    // settings; `sleeperPoints` is the K/DST fallback, which cannot.
    const v = input.sleeper
      ? scoreStatLine(input.sleeper, scoring, isTE)
      : input.sleeperPoints;
    if (typeof v === "number") parts.push({ w: p.sourceWeights.sleeper, v });
  }
  if (input.espn && p.sourceWeights.espn > 0) {
    parts.push({ w: p.sourceWeights.espn, v: scoreStatLine(input.espn, scoring, isTE) });
  }
  // DK gives a point total under DK scoring, not a stat line. Used as-is; the
  // calibration decides how much that mismatch is worth.
  if (typeof input.dk === "number" && p.sourceWeights.dk > 0) {
    parts.push({ w: p.sourceWeights.dk, v: input.dk });
  }
  const wSum = parts.reduce((s, x) => s + x.w, 0);
  if (wSum <= 0) return 0;
  return parts.reduce((s, x) => s + x.w * x.v, 0) / wSum;
}

export function buildWeekOutlooks(args: {
  week: number;
  players: WeekPlayerInput[];
  linesByTeam: Record<string, WeekLine>;
  dvp: DvpLookup;
  scoring: ScoringSettings;
  params: WeeklyModelParams;
}): WeekOutlook[] {
  const { week, players, linesByTeam, dvp, scoring, params: p } = args;
  const out: WeekOutlook[] = [];

  for (const player of players) {
    const isTE = player.pos === "TE";
    const baseMarket = blendMarket(player, scoring, p);
    const baseUsage = player.usage ? scoreStatLine(player.usage, scoring, isTE) : 0;

    // Renormalize when usage has no opinion, so a missing usage history does
    // not read as "we project him for 70% of the market number".
    let base: number;
    if (player.usage && p.modelWeights.usage > 0) {
      base = p.modelWeights.market * baseMarket + p.modelWeights.usage * baseUsage;
    } else {
      base = baseMarket;
    }

    const line = linesByTeam[player.team];
    // No line means no game: a bye, or a team the odds feed did not carry.
    // Either way he does not play, and inventing an environment for him would
    // be fabricating exactly the input we know least about.
    const isBye = player.bye === week || !line;

    let mMatch = 1;
    let mEnv = 1;
    let mScript = 1;
    if (line) {
      const itpOwn = impliedTeamPoints(line.total, line.ownSpread);
      const itpOpp = impliedTeamPoints(line.total, -line.ownSpread);
      mEnv = envMult(player.pos, itpOwn, itpOpp, p);
      mScript = scriptMult(player.pos, line.ownSpread, p);
      const d = dvp(line.opp, player.pos);
      mMatch = matchMult(player.pos, d.allowed, d.leagueAvg, d.games, p);
    }

    const meanIfPlays = base * mEnv * mScript * mMatch;
    const play = pPlay(player.status, isBye, p);
    const stats = player.sleeper ?? player.usage ?? player.espn ?? {};
    const sigma = weeklySigma(player.pos, projectedVolume(player.pos, stats), p);

    out.push({
      playerId: player.id,
      week,
      opp: isBye ? null : line!.opp,
      meanIfPlays,
      mean: meanIfPlays * play,
      sigma,
      p10: lognormalQuantile(meanIfPlays, sigma, 0.1),
      p50: lognormalQuantile(meanIfPlays, sigma, 0.5),
      p90: lognormalQuantile(meanIfPlays, sigma, 0.9),
      pPlay: play,
      stats,
      drivers: {
        baseMarket,
        baseUsage,
        matchMult: mMatch,
        envMult: mEnv,
        scriptMult: mScript,
        status: player.status,
      },
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyOutlook.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole suite — nothing may have regressed**

Run: `pnpm test`
Expected: all pass, including `tests/perf.test.ts`'s 50 ms draft budget.

- [ ] **Step 6: Commit**

```bash
git add lib/engine/weekly/outlook.ts tests/weeklyOutlook.test.ts
git commit -m "Weekly engine: ensemble blend and WeekOutlook assembly, off state reproduces Sleeper"
```

---

### Task 10: Stat-line scaling and DK threshold bonuses

Needed by the sampler in Task 11. DK pays +3 at 100 rushing yards, 100 receiving yards, and 300 passing yards, and the expected value of a threshold cannot be computed from a mean.

**Files:**
- Create: `lib/engine/weekly/bonuses.ts`
- Test: `tests/weeklyBonuses.test.ts`

**Interfaces:**
- Consumes: `StatLine`.
- Produces: `scaleStatLine(stats: StatLine, mult: number): StatLine`, `dkBonusPoints(stats: StatLine): number`, `DK_BONUS_THRESHOLDS`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyBonuses.test.ts
import { describe, it, expect } from "vitest";
import { scaleStatLine, dkBonusPoints } from "../lib/engine/weekly/bonuses";

describe("scaleStatLine", () => {
  it("scales every volume field by the multiplier", () => {
    const s = scaleStatLine({ rushYds: 80, rushTD: 0.5, receptions: 4, recFd: 3 }, 1.5);
    expect(s.rushYds).toBeCloseTo(120, 10);
    expect(s.rushTD).toBeCloseTo(0.75, 10);
    expect(s.receptions).toBeCloseTo(6, 10);
    expect(s.recFd).toBeCloseTo(4.5, 10);
  });

  it("a zero multiplier produces an empty line, not zero-valued keys", () => {
    expect(scaleStatLine({ rushYds: 80 }, 0)).toEqual({});
  });

  it("leaves the input untouched", () => {
    const input = { rushYds: 80 };
    scaleStatLine(input, 2);
    expect(input.rushYds).toBe(80);
  });
});

describe("dkBonusPoints", () => {
  it("pays 3 at each threshold, and nothing just below", () => {
    expect(dkBonusPoints({ rushYds: 100 })).toBe(3);
    expect(dkBonusPoints({ rushYds: 99.9 })).toBe(0);
    expect(dkBonusPoints({ recYds: 100 })).toBe(3);
    expect(dkBonusPoints({ passYds: 300 })).toBe(3);
    expect(dkBonusPoints({ passYds: 299 })).toBe(0);
  });

  it("stacks — a 100/100 game earns both", () => {
    expect(dkBonusPoints({ rushYds: 120, recYds: 105 })).toBe(6);
    expect(dkBonusPoints({ passYds: 320, rushYds: 100 })).toBe(6);
  });

  it("is zero on an empty line", () => {
    expect(dkBonusPoints({})).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyBonuses.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekly/bonuses.ts
// Stat-line scaling and DraftKings threshold bonuses. Pure.
//
// Why this exists: DK pays +3 for 100 rushing yards, 100 receiving yards and
// 300 passing yards. The expected value of a threshold bonus cannot be derived
// from a mean projection — a 92-yard mean with wide spread collects more bonus
// than a 98-yard mean with narrow spread. So the sampler draws a performance
// multiplier and applies it to the STAT LINE, then scores the scaled line.
//
// Approximation, stated plainly: yards and touchdowns are assumed to scale
// together with one multiplier. Real games decouple them. This is gated —
// simulated bonus frequency must match historical bonus frequency per
// position (see scripts/backtest-weekly.ts, gate 5).
import type { StatLine } from "../../types";

const VOLUME_FIELDS: (keyof StatLine)[] = [
  "passYds", "passTD", "passInt", "pass2pt",
  "rushYds", "rushTD", "rush2pt",
  "receptions", "recYds", "recTD", "rec2pt",
  "fumblesLost", "rushFd", "recFd", "passFd",
];

export function scaleStatLine(stats: StatLine, mult: number): StatLine {
  const out: StatLine = {};
  for (const f of VOLUME_FIELDS) {
    const v = stats[f];
    if (typeof v === "number" && v !== 0) {
      const scaled = v * mult;
      if (scaled !== 0) out[f] = scaled;
    }
  }
  return out;
}

export const DK_BONUS_THRESHOLDS = {
  passYds: 300,
  rushYds: 100,
  recYds: 100,
} as const;

/** DK's flat +3 per threshold cleared. They stack. */
export function dkBonusPoints(stats: StatLine): number {
  let bonus = 0;
  if ((stats.passYds ?? 0) >= DK_BONUS_THRESHOLDS.passYds) bonus += 3;
  if ((stats.rushYds ?? 0) >= DK_BONUS_THRESHOLDS.rushYds) bonus += 3;
  if ((stats.recYds ?? 0) >= DK_BONUS_THRESHOLDS.recYds) bonus += 3;
  return bonus;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyBonuses.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/weekly/bonuses.ts tests/weeklyBonuses.test.ts
git commit -m "Weekly engine: stat-line scaling and DK threshold bonuses"
```

---

### Task 11: Correlated weekly sampler

The other half of the foundation. Generalizes `makeTeamShocks` from one team-week shock to a nested game → team → unit → player hierarchy.

**Files:**
- Create: `lib/engine/weekSim.ts`
- Test: `tests/weekSim.test.ts`

**Interfaces:**
- Consumes: `makeRng` and `gaussian` (`gaussian` currently lives in `lib/engine/outcome.ts` and is already exported — import it from there, do not duplicate it), `correlationAmplitudes`/`unitOf`/`WeeklyModelParams` (Task 1), `scaleStatLine`/`dkBonusPoints` (Task 10), `scoreStatLine`.
- Produces:
  - `interface WeekSimPlayer { id: string; pos: Position; team: string; gameId: string; opp: string; meanIfPlays: number; sigma: number; pPlay: number; stats: StatLine }`
  - `sampleWeek(players: WeekSimPlayer[], p: WeeklyModelParams, rng: () => number, opts?: { dkBonuses?: boolean }): Float64Array`
  - `simulateWeek(players: WeekSimPlayer[], p: WeeklyModelParams, sims: number, seed: number, opts?): Float64Array[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/weekSim.test.ts
import { describe, it, expect } from "vitest";
import { sampleWeek, simulateWeek, type WeekSimPlayer } from "../lib/engine/weekSim";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";
import { makeRng } from "../lib/engine/montecarlo";

function p(id: string, pos: WeekSimPlayer["pos"], team: string, gameId: string, opp: string): WeekSimPlayer {
  return { id, pos, team, gameId, opp, meanIfPlays: 15, sigma: 0.6, pPlay: 1, stats: { recYds: 70, receptions: 5 } };
}

// DET vs CHI in one game; SEA vs NE in another.
const players = [
  p("qb-det", "QB", "DET", "DET-CHI", "CHI"),
  p("wr-det", "WR", "DET", "DET-CHI", "CHI"),
  p("rb-det", "RB", "DET", "DET-CHI", "CHI"),
  p("wr-chi", "WR", "CHI", "DET-CHI", "DET"),
  p("wr-sea", "WR", "SEA", "SEA-NE", "NE"),
  p("dst-det", "DST", "DET", "DET-CHI", "CHI"),
];

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function columns(draws: Float64Array[], k: number): number[] {
  return draws.map((d) => d[k]);
}

describe("weekSim correlation structure", () => {
  const CORR: WeeklyModelParams = {
    ...DEFAULT_WEEKLY_MODEL,
    correlation: { game: 0.15, team: 0.35, unit: 0.55, dstVsOppTeam: 0.3 },
  };

  it("same team, same unit is the most correlated pair", () => {
    const draws = simulateWeek(players, CORR, 8000, 42);
    const qbWr = corr(columns(draws, 0), columns(draws, 1)); // both pass unit, DET
    const wrRb = corr(columns(draws, 1), columns(draws, 2)); // same team, different unit
    const crossTeam = corr(columns(draws, 1), columns(draws, 3)); // same game, other team
    const crossGame = corr(columns(draws, 1), columns(draws, 4)); // different game
    expect(qbWr).toBeGreaterThan(wrRb);
    expect(wrRb).toBeGreaterThan(crossTeam);
    expect(crossTeam).toBeGreaterThan(crossGame);
    expect(Math.abs(crossGame)).toBeLessThan(0.05);
  });

  it("a DST is negatively correlated with the offense it faces", () => {
    const draws = simulateWeek(players, CORR, 8000, 7);
    expect(corr(columns(draws, 5), columns(draws, 3))).toBeLessThan(-0.05); // dst-det vs wr-chi
  });

  it("reproduces the season model's behaviour when game and unit are off", () => {
    const flat: WeeklyModelParams = {
      ...DEFAULT_WEEKLY_MODEL,
      correlation: { game: 0, team: 0.28, unit: 0.28, dstVsOppTeam: 0 },
    };
    const draws = simulateWeek(players, flat, 8000, 3);
    const qbWr = corr(columns(draws, 0), columns(draws, 1));
    const wrRb = corr(columns(draws, 1), columns(draws, 2));
    // With unit == team, a QB/WR pair and a WR/RB pair are equally correlated.
    expect(Math.abs(qbWr - wrRb)).toBeLessThan(0.06);
    expect(Math.abs(corr(columns(draws, 1), columns(draws, 4)))).toBeLessThan(0.05);
  });
});

describe("weekSim mechanics", () => {
  it("is deterministic for a given seed", () => {
    const a = sampleWeek(players, DEFAULT_WEEKLY_MODEL, makeRng(99));
    const b = sampleWeek(players, DEFAULT_WEEKLY_MODEL, makeRng(99));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("the sample mean recovers meanIfPlays for a certain starter", () => {
    const one = [p("solo", "WR", "DET", "DET-CHI", "CHI")];
    const draws = simulateWeek(one, DEFAULT_WEEKLY_MODEL, 20000, 5);
    const mean = draws.reduce((s, d) => s + d[0], 0) / draws.length;
    expect(mean).toBeGreaterThan(14);
    expect(mean).toBeLessThan(16);
  });

  it("a player who does not play scores exactly zero, not a small number", () => {
    const out = [{ ...p("hurt", "WR", "DET", "DET-CHI", "CHI"), pPlay: 0 }];
    const draws = simulateWeek(out, DEFAULT_WEEKLY_MODEL, 200, 1);
    expect(draws.every((d) => d[0] === 0)).toBe(true);
  });

  it("DK bonuses add points only in big statistical weeks", () => {
    const big = [{ ...p("bell", "WR", "DET", "DET-CHI", "CHI"), sigma: 0.9 }];
    const plain = simulateWeek(big, DEFAULT_WEEKLY_MODEL, 4000, 11);
    const bonused = simulateWeek(big, DEFAULT_WEEKLY_MODEL, 4000, 11, { dkBonuses: true });
    const mean = (d: Float64Array[]) => d.reduce((s, x) => s + x[0], 0) / d.length;
    expect(mean(bonused)).toBeGreaterThan(mean(plain));
    // Bonuses are rare-ish: they must not inflate the mean by more than ~3.
    expect(mean(bonused) - mean(plain)).toBeLessThan(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weekSim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekSim.ts
// Correlated weekly sampler. Pure and seeded.
//
// Marginal distributions are not enough for either downstream leg. A QB and
// two of his receivers is a mediocre expected-value lineup and a strong
// tournament lineup precisely BECAUSE their good weeks arrive together; and a
// start/sit floor is worse than it looks when three starters share one game.
//
// Hierarchy, one draw set per iteration:
//   z_p = a_g·z_game[g] + a_t·z_team[t] + a_u·z_unit[t,unit] + a_i·z_i
// with the amplitudes derived from nested correlations in weekly-model.json.
// Setting game = 0 and unit = team reproduces the season model's single
// team-shock behaviour (lib/engine/outcome.ts makeTeamShocks).
//
// A DST loads NEGATIVELY on its opponent's team shock: a defense scores when
// the offense it faces does not.
import type { Position, StatLine } from "../types";
import { gaussian } from "./outcome";
import { makeRng } from "./montecarlo";
import { correlationAmplitudes, unitOf, type WeeklyModelParams } from "./weekly/model";
import { dkBonusPoints, scaleStatLine } from "./weekly/bonuses";

export interface WeekSimPlayer {
  id: string;
  pos: Position;
  team: string;
  /** Stable per-game key, e.g. "DET-CHI". Both teams in a game share it. */
  gameId: string;
  opp: string;
  meanIfPlays: number;
  sigma: number;
  pPlay: number;
  stats: StatLine;
}

/** Lazily-drawn, cached shocks for one iteration. */
function makeShocks(rng: () => number) {
  const cache = new Map<string, number>();
  return (key: string): number => {
    let v = cache.get(key);
    if (v === undefined) {
      v = gaussian(rng);
      cache.set(key, v);
    }
    return v;
  };
}

export interface WeekSimOpts {
  /**
   * Add DK threshold bonuses (+3 at 300 pass / 100 rush / 100 rec yards) by
   * scaling the projected stat line with the same draw that scaled the points.
   * The bonuses are flat, so no scoring settings are needed here — whatever
   * scoring built `meanIfPlays` already applies. For DFS, build the outlooks
   * with DK scoring in the first place.
   */
  dkBonuses?: boolean;
}

/** One correlated week. Returns points per player, in input order. */
export function sampleWeek(
  players: WeekSimPlayer[],
  p: WeeklyModelParams,
  rng: () => number,
  opts: WeekSimOpts = {}
): Float64Array {
  const a = correlationAmplitudes(p.correlation);
  const aDst = Math.sqrt(p.correlation.dstVsOppTeam);
  // Residual amplitude for a DST, so its variance still sums to one.
  const aDstOwn = Math.sqrt(Math.max(0, 1 - p.correlation.game - p.correlation.dstVsOppTeam));
  const shock = makeShocks(rng);
  const out = new Float64Array(players.length);

  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (pl.pPlay <= 0 || pl.meanIfPlays <= 0) continue;
    if (rng() > pl.pPlay) continue; // inactive this iteration: exactly zero

    let z: number;
    if (pl.pos === "DST") {
      z =
        a.game * shock(`g:${pl.gameId}`) -
        aDst * shock(`t:${pl.opp}`) +
        aDstOwn * gaussian(rng);
    } else {
      z =
        a.game * shock(`g:${pl.gameId}`) +
        a.team * shock(`t:${pl.team}`) +
        a.unit * shock(`u:${pl.team}:${unitOf(pl.pos)}`) +
        a.player * gaussian(rng);
    }

    // Lognormal with mean exactly meanIfPlays.
    const mult = Math.exp(pl.sigma * z - (pl.sigma * pl.sigma) / 2);
    let pts = pl.meanIfPlays * mult;
    if (opts.dkBonuses) {
      pts += dkBonusPoints(scaleStatLine(pl.stats, mult));
    }
    out[i] = pts;
  }
  return out;
}

/** `sims` independent correlated weeks. Deterministic given the seed. */
export function simulateWeek(
  players: WeekSimPlayer[],
  p: WeeklyModelParams,
  sims: number,
  seed: number,
  opts: WeekSimOpts = {}
): Float64Array[] {
  const draws: Float64Array[] = new Array(sims);
  for (let s = 0; s < sims; s++) {
    // Same seeding construction as simulateSeasons in lib/engine/season.ts:
    // a distinct, reproducible stream per iteration.
    draws[s] = sampleWeek(players, p, makeRng((seed * 7919 + s * 104729) >>> 0), opts);
  }
  return draws;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weekSim.test.ts`
Expected: PASS, 7 tests. The correlation tests are statistical — they use 8,000 draws and generous margins, so a genuine failure means the structure is wrong, not that you were unlucky. If one fails, print the empirical correlations before touching the tolerances.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/weekSim.ts tests/weekSim.test.ts
git commit -m "Weekly engine: hierarchical correlated sampler (game > team > unit > player)"
```

---

### Task 12: Remaining ETL fetchers — ESPN weekly and nflverse weekly stats

The two sources the ensemble and the usage model still need. Both reduce their payload immediately, per the repo's fixture policy: nflverse's weekly CSV is 8.6 MB per season and only about twenty of its columns matter.

**Files:**
- Create: `lib/etl/weekly/espnWeekly.ts`
- Create: `lib/etl/weekly/nflverseWeekly.ts`
- Test: `tests/weeklyFetchers.test.ts`

**Interfaces:**
- Consumes: `ESPN_POS`, `ESPN_TEAM` from `lib/etl/espn.ts`; `statLineFromEspn` from `lib/scoring.ts`; `parseCsv`; `SourceResult`/`FetchOpts`; and **`fetchSlim` from `lib/etl/weekly/cache.ts`** (created in Task 2 — it owns fixture caching, `meta.json` staleness bookkeeping and the fallback warning; do not re-implement that block).
- Produces:
  - `parseEspnWeekly(json: unknown, week: number): Record<string, { stats: StatLine; name: string; pos: Position; team: string }>` — keyed by **ESPN id**
  - `fetchEspnWeekly(season: number, week: number, opts?: FetchOpts): Promise<SourceResult<...>>`
  - `NFLVERSE_WEEKLY_COLUMNS: string[]`
  - `slimNflverseWeekly(csv: string): Record<string, string>[]`
  - `fetchNflverseWeekly(season: number, opts?: FetchOpts): Promise<SourceResult<Record<string, string>[]>>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyFetchers.test.ts
import { describe, it, expect } from "vitest";
import { parseEspnWeekly } from "../lib/etl/weekly/espnWeekly";
import { slimNflverseWeekly, NFLVERSE_WEEKLY_COLUMNS } from "../lib/etl/weekly/nflverseWeekly";

describe("parseEspnWeekly", () => {
  const payload = {
    players: [
      {
        id: 3139477,
        player: {
          fullName: "Patrick Mahomes",
          defaultPositionId: 1,
          proTeamId: 12,
          stats: [
            // Projection (statSourceId 1) for scoringPeriodId 2 — the one we want.
            { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 2, stats: { "3": 268, "4": 1.7, "20": 0.6 } },
            // Actual (statSourceId 0) — must be ignored.
            { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, stats: { "3": 999 } },
            // Another week's projection — must be ignored.
            { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, stats: { "3": 111 } },
          ],
        },
      },
    ],
  };

  it("takes only the projection for the requested week", () => {
    const out = parseEspnWeekly(payload, 2);
    expect(out["3139477"].stats.passYds).toBe(268);
    expect(out["3139477"].stats.passTD).toBeCloseTo(1.7);
    expect(out["3139477"].pos).toBe("QB");
  });

  it("returns nothing for a week ESPN has no projection for", () => {
    expect(Object.keys(parseEspnWeekly(payload, 9))).toHaveLength(0);
  });
});

describe("slimNflverseWeekly", () => {
  it("keeps only the columns the model uses", () => {
    const header = ["player_id", "season", "week", "season_type", "position", "team", "opponent_team", "targets", "carries", "attempts", "receiving_yards", "rushing_yards", "passing_yards", "receptions", "rushing_tds", "receiving_tds", "passing_tds", "passing_interceptions", "headshot_url", "passing_epa"];
    const row = ["00-0001", "2025", "1", "REG", "WR", "DET", "CHI", "10", "0", "0", "120", "0", "0", "7", "0", "1", "0", "0", "http://x", "1.2"];
    const csv = header.join(",") + "\n" + row.join(",");
    const slim = slimNflverseWeekly(csv);
    expect(slim).toHaveLength(1);
    expect(slim[0].targets).toBe("10");
    expect(slim[0].receiving_yards).toBe("120");
    // Dropped: not used by any model, and 8.6 MB per season is worth trimming.
    expect(slim[0].headshot_url).toBeUndefined();
    expect(slim[0].passing_epa).toBeUndefined();
  });

  it("drops non-regular-season rows and rows with no position", () => {
    const header = NFLVERSE_WEEKLY_COLUMNS.join(",");
    const mk = (over: Record<string, string>) =>
      NFLVERSE_WEEKLY_COLUMNS.map((c) => over[c] ?? (c === "season_type" ? "REG" : c === "position" ? "WR" : "0")).join(",");
    const csv = [header, mk({ season_type: "POST" }), mk({ position: "" }), mk({})].join("\n");
    expect(slimNflverseWeekly(csv)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyFetchers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the ESPN weekly fetcher**

```ts
// lib/etl/weekly/espnWeekly.ts
// ESPN's weekly projections: the same kona endpoint the season board already
// uses (lib/etl/fetchers.ts fetchEspnProjections), with scoringPeriodId set to
// the week. Free, keyless. Second opinion in the market ensemble.
//
// Keyed by ESPN id, so the join to sleeper ids goes through the DynastyProcess
// crosswalk the same way the season board does it.
import type { Position, StatLine } from "../../types";
import { statLineFromEspn } from "../../scoring";
import { ESPN_POS, ESPN_TEAM } from "../espn";
import type { FetchOpts, SourceResult } from "../fetchers";
import { fetchSlim } from "./cache";

export interface EspnWeeklyPlayer {
  stats: StatLine;
  name: string;
  pos: Position;
  team: string;
}

interface RawStatEntry {
  statSourceId?: number;
  statSplitTypeId?: number;
  scoringPeriodId?: number;
  stats?: Record<string, number>;
}
interface RawEntry {
  id?: number;
  player?: {
    fullName?: string;
    defaultPositionId?: number;
    proTeamId?: number;
    stats?: RawStatEntry[];
  };
}

/**
 * statSourceId 1 = projection, 0 = actual. statSplitTypeId 1 = single week.
 * Taking the wrong source would silently train the model on results.
 */
export function parseEspnWeekly(json: unknown, week: number): Record<string, EspnWeeklyPlayer> {
  const doc = json as { players?: RawEntry[] };
  const out: Record<string, EspnWeeklyPlayer> = {};
  for (const entry of doc?.players ?? []) {
    const id = entry.id;
    const pl = entry.player;
    if (!id || !pl) continue;
    const pos = ESPN_POS[pl.defaultPositionId ?? -1] as Position | undefined;
    if (!pos) continue;
    const proj = (pl.stats ?? []).find(
      (s) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === week
    );
    if (!proj?.stats) continue;
    const stats = statLineFromEspn(proj.stats);
    if (Object.keys(stats).length === 0) continue;
    out[String(id)] = {
      stats,
      name: pl.fullName ?? "",
      pos,
      team: ESPN_TEAM[pl.proTeamId ?? -1] ?? "",
    };
  }
  return out;
}

export function fetchEspnWeekly(
  season: number,
  week: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, EspnWeeklyPlayer>>> {
  return fetchSlim<Record<string, EspnWeeklyPlayer>>(
    `espn-week-${season}-${week}.json`,
    async () => {
      const url =
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
        `/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=${week}`;
      const filter = {
        players: { limit: 1500, sortPercOwned: { sortAsc: false, sortPriority: 1 } },
      };
      const res = await fetch(url, { headers: { "x-fantasy-filter": JSON.stringify(filter) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseEspnWeekly(await res.json(), week);
      const n = Object.keys(parsed).length;
      if (n < 100) throw new Error(`only ${n} weekly projections`);
      return parsed;
    },
    opts,
    // ESPN is the SECOND ensemble source and ships at weight 0, so dropping it
    // degrades nothing today; blendMarket renormalizes over the sources present.
    () => ({})
  );
}
```

- [ ] **Step 4: Write the nflverse weekly fetcher**

```ts
// lib/etl/weekly/nflverseWeekly.ts
// nflverse weekly box scores: realized volume and production, per player per
// week. Feeds the usage model, the defense-vs-position table, and every
// backtest's actuals.
//
// The raw CSV is ~8.6 MB per season and carries 60+ columns. We keep about
// twenty and cache slim JSON — same policy as every other fixture here.
import { parseCsv } from "../csv";
import type { FetchOpts, SourceResult } from "../fetchers";
import { fetchSlim } from "./cache";

/** Every column any model in lib/engine/weekly/ reads. Verified against the 2025 file. */
export const NFLVERSE_WEEKLY_COLUMNS = [
  "player_id", "player_display_name", "position", "season", "week", "season_type",
  "team", "opponent_team",
  "attempts", "carries", "targets", "receptions",
  "passing_yards", "passing_tds", "passing_interceptions", "passing_2pt_conversions", "passing_first_downs",
  "rushing_yards", "rushing_tds", "rushing_2pt_conversions", "rushing_first_downs", "rushing_fumbles_lost",
  "receiving_yards", "receiving_tds", "receiving_2pt_conversions", "receiving_first_downs", "receiving_fumbles_lost",
  "sack_fumbles_lost",
];

export function slimNflverseWeekly(csv: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const r of parseCsv(csv)) {
    if (r.season_type !== "REG") continue;
    if (!r.position) continue;
    const slim: Record<string, string> = {};
    for (const c of NFLVERSE_WEEKLY_COLUMNS) {
      const v = r[c];
      if (v !== undefined && v !== "") slim[c] = v;
    }
    out.push(slim);
  }
  return out;
}

export function fetchNflverseWeekly(
  season: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, string>[]>> {
  return fetchSlim<Record<string, string>[]>(
    `nflverse-week-${season}.json`,
    async () => {
      const url =
        `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
      const res = await fetch(url); // node fetch follows the release redirect
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const slim = slimNflverseWeekly(await res.text());
      if (slim.length < 100) throw new Error(`only ${slim.length} rows`);
      return slim;
    },
    opts,
    // Without box scores the usage model and the DvP table both go neutral,
    // which the engine handles (matchMult falls to 1, usage weight is 0).
    () => []
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyFetchers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify both live, and check the slim size**

Run:
```bash
pnpm tsx -e "import('./lib/etl/weekly/nflverseWeekly').then(async m => { const r = await m.fetchNflverseWeekly(2025); console.log(r.data.length, 'rows'); })"
pnpm tsx -e "import('./lib/etl/weekly/espnWeekly').then(async m => { const r = await m.fetchEspnWeekly(2026, 1); console.log(Object.keys(r.data).length, 'espn weekly'); })"
ls -lh data/raw/weekly/
```
Expected: several thousand nflverse rows; a few hundred ESPN players. The slim nflverse JSON should be well under the 8.6 MB raw CSV — if it is not, a column in `NFLVERSE_WEEKLY_COLUMNS` does not belong there.

- [ ] **Step 7: Commit**

```bash
git add lib/etl/weekly/espnWeekly.ts lib/etl/weekly/nflverseWeekly.ts tests/weeklyFetchers.test.ts data/raw/weekly/
git commit -m "Weekly ETL: ESPN weekly projections and slimmed nflverse weekly box scores"
```

---

### Task 13: The `weekly` CI lane and `scripts/build-week.ts`

Wires every source into `public/data/week-{season}-{week}.json`. This is the first task whose output the browser can actually load.

**Files:**
- Modify: `lib/etl/lane.ts` (add `weekly`)
- Create: `scripts/build-week.ts`
- Modify: `package.json` (add `build:week`)
- Test: `tests/lane.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: every fetcher from Tasks 2, 3, 12; `buildDvp` (5); `buildUsageHistory`/`remapToSleeper` (6); `rollingShares`/`blendWithPrior`/`projectUsageStatLine` (6); `buildWeekOutlooks` (9).
- Produces: `interface WeekBoard { meta: { season: number; week: number; builtAt: string; lane: Lane; sources: { name: string; fetchedAt: string; fromFixture: boolean }[]; warnings: string[] }; outlooks: WeekOutlook[] }` exported from `lib/types.ts`.

- [ ] **Step 1: Extend the lane test**

Append to `tests/lane.test.ts`:

```ts
import { parseLane } from "../lib/etl/lane";

describe("weekly lane", () => {
  it("parses --lane=weekly", () => {
    expect(parseLane(["--lane=weekly"])).toBe("weekly");
  });

  it("still defaults to full and still rejects nonsense", () => {
    expect(parseLane([])).toBe("full");
    expect(() => parseLane(["--lane=hourly"])).toThrow(/expected fast\|full\|weekly/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/lane.test.ts`
Expected: FAIL — `parseLane` returns/throws on `weekly`.

- [ ] **Step 3: Extend the lane**

```ts
// lib/etl/lane.ts — replace the type and parser
/**
 * CI lanes. `fast` (every 30 min) refreshes only sources that tolerate it.
 * `full` (daily + local) is the original behaviour. `weekly` (Thu–Mon,
 * in-season) refreshes the weekly boards: Sleeper weekly projections, ESPN
 * weekly projections, Vegas lines, nflverse box scores.
 *
 * FantasyPros is called from `full` ONLY — its free tier is ~10 requests/day.
 */
export type Lane = "fast" | "full" | "weekly";

export function parseLane(argv: string[]): Lane {
  const arg = argv.find((a) => a.startsWith("--lane="));
  const v = arg?.slice("--lane=".length);
  if (!v || v === "full") return "full";
  if (v === "fast") return "fast";
  if (v === "weekly") return "weekly";
  throw new Error(`unknown --lane=${v} (expected fast|full|weekly)`);
}
```

- [ ] **Step 4: Run the lane test**

Run: `pnpm vitest run tests/lane.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `WeekBoard` type**

Append to `lib/types.ts`:

```ts
/** One week's outlooks, emitted by scripts/build-week.ts, read by the client. */
export interface WeekBoard {
  meta: {
    season: number;
    week: number;
    builtAt: string;
    lane: string;
    scoring: ScoringFormat;
    sources: { name: string; fetchedAt: string; fromFixture: boolean }[];
    warnings: string[];
  };
  outlooks: import("./engine/weekly/outlook").WeekOutlook[];
}
```

- [ ] **Step 6: Write the build script**

```ts
// scripts/build-week.ts
// Weekly ETL: fetch → join → project → emit public/data/week-{season}-{week}.json
//
// Run by the `weekly` CI lane Thursday through Monday in season, and manually
// via `pnpm build:week -- --week=3`. Falls back to committed fixtures loudly,
// exactly like build-board.ts.
//
// FantasyPros is deliberately absent: ~10 requests/day of free quota cannot
// survive a lane that runs several times a week.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { parseLane } from "../lib/etl/lane";
import { fetchSleeperWeekly } from "../lib/etl/weekly/sleeperWeekly";
import { fetchEspnWeekly } from "../lib/etl/weekly/espnWeekly";
import { fetchNflverseWeekly } from "../lib/etl/weekly/nflverseWeekly";
import { fetchVegasWeek, lineFor } from "../lib/etl/weekly/vegas";
import { fetchPlayerIds } from "../lib/etl/fetchers";
import { buildDvp } from "../lib/etl/weekly/dvp";
import { buildUsageHistory, remapToSleeper } from "../lib/etl/weekly/usage";
import {
  rollingShares,
  blendWithPrior,
  projectUsageStatLine,
  type Efficiency,
  type Shares,
} from "../lib/engine/weekly/usageModel";
import { buildWeekOutlooks, type WeekLine, type WeekPlayerInput } from "../lib/engine/weekly/outlook";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { SCORING_PRESETS } from "../lib/scoring";
import { canonicalTeam, num } from "../lib/etl/nflverse";
import type { Board, Position, ScoringFormat, WeekBoard } from "../lib/types";

const SEASON = 2026;
const OUT_DIR = join(process.cwd(), "public", "data");
const FORMATS: ScoringFormat[] = ["standard", "half-ppr", "ppr", "2qb"];

/** League-average per-position efficiency priors. Deliberately coarse: the
 *  usage model shrinks observed efficiency toward these, and the calibration
 *  measures whether that shrinkage is set right. */
const EFF_PRIOR: Record<string, Efficiency> = {
  QB: { ydsPerTarget: 0, ydsPerCarry: 4.4, ydsPerAttempt: 7.1, tdPerTarget: 0, tdPerCarry: 0.05, tdPerAttempt: 0.048, catchRate: 0 },
  RB: { ydsPerTarget: 6.3, ydsPerCarry: 4.3, ydsPerAttempt: 0, tdPerTarget: 0.04, tdPerCarry: 0.032, tdPerAttempt: 0, catchRate: 0.75 },
  WR: { ydsPerTarget: 8.3, ydsPerCarry: 5.5, ydsPerAttempt: 0, tdPerTarget: 0.055, tdPerCarry: 0.05, tdPerAttempt: 0, catchRate: 0.64 },
  TE: { ydsPerTarget: 7.6, ydsPerCarry: 0, ydsPerAttempt: 0, tdPerTarget: 0.062, tdPerCarry: 0, tdPerAttempt: 0, catchRate: 0.69 },
};

function weekArg(argv: string[]): number | null {
  const a = argv.find((x) => x.startsWith("--week="));
  const v = a ? Number(a.slice("--week=".length)) : NaN;
  return Number.isInteger(v) && v >= 1 && v <= 18 ? v : null;
}

async function main() {
  const lane = parseLane(process.argv);
  const fixtureOnly = false; // the weekly lane always tries live; fixtures are the fallback
  const week = weekArg(process.argv);
  if (week == null) {
    throw new Error("build-week needs --week=N (1-18). The current week is not inferred, so a rerun is reproducible.");
  }
  const warnings: string[] = [];
  const sources: WeekBoard["meta"]["sources"] = [];
  const track = (name: string, r: { fetchedAt: string; fromFixture: boolean }) => {
    sources.push({ name, fetchedAt: r.fetchedAt, fromFixture: r.fromFixture });
    if (r.fromFixture) warnings.push(`${name} came from a committed fixture (${r.fetchedAt})`);
    return r;
  };

  const [sleeper, espn, vegas, nfl, ids] = await Promise.all([
    fetchSleeperWeekly(SEASON, week).then((r) => track("sleeper-weekly", r)),
    fetchEspnWeekly(SEASON, week).then((r) => track("espn-weekly", r)),
    fetchVegasWeek(SEASON, week).then((r) => track("vegas", r)),
    fetchNflverseWeekly(SEASON).then((r) => track("nflverse-weekly", r)),
    fetchPlayerIds({ fixtureOnly: true }).then((r) => track("player-ids", r)),
  ]);

  // --- crosswalks -----------------------------------------------------------
  // fetchPlayerIds returns the raw CSV body (verified in lib/etl/fetchers.ts:135).
  const cross = parseCsv(ids.data);
  const gsisToSleeper: Record<string, string> = {};
  const espnToSleeper: Record<string, string> = {};
  for (const r of cross) {
    if (r.sleeper_id && r.gsis_id) gsisToSleeper[r.gsis_id] = r.sleeper_id;
    if (r.sleeper_id && r.espn_id) espnToSleeper[r.espn_id] = r.sleeper_id;
  }

  // --- defense vs position, through the week being predicted ---------------
  const dvpRes = buildDvp(nfl.data, {
    season: SEASON,
    throughWeek: week,
    lambda: DEFAULT_WEEKLY_MODEL.matchup.dvpLambda,
  });
  const dvpLookup = (defense: string, pos: Position) => ({
    allowed: dvpRes.table[defense]?.[pos],
    leagueAvg: dvpRes.leagueAvg[pos],
    games: dvpRes.gamesByTeam[defense] ?? 0,
  });

  // --- usage history --------------------------------------------------------
  const usageBySleeper = remapToSleeper(
    buildUsageHistory(nfl.data, { season: SEASON, throughWeek: week }),
    gsisToSleeper
  );

  // Team volume for the week: the team's own recent mean, a stable starting
  // point. The environment multiplier in the engine does the Vegas scaling, so
  // baking it in here too would double-count it.
  const teamVol = teamVolumes(nfl.data, SEASON, week);

  // --- one board per scoring format ----------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  for (const format of FORMATS) {
    const seasonBoard: Board = JSON.parse(
      readFileSync(join(OUT_DIR, `board-${format}.json`), "utf8")
    );
    const scoring = seasonBoard.meta.scoring ?? SCORING_PRESETS[format];
    const byeOf = new Map(seasonBoard.players.map((p) => [p.id, p.bye]));

    const espnBySleeper: Record<string, { stats: import("../lib/types").StatLine }> = {};
    for (const [espnId, v] of Object.entries(espn.data)) {
      const sid = espnToSleeper[espnId];
      if (sid) espnBySleeper[sid] = { stats: v.stats };
    }

    const linesByTeam: Record<string, WeekLine> = {};
    for (const p of seasonBoard.players) {
      if (linesByTeam[p.team]) continue;
      const l = lineFor(vegas.data, p.team);
      if (l) linesByTeam[p.team] = l;
    }

    const players: WeekPlayerInput[] = seasonBoard.players.map((p) => {
      const s = sleeper.data[p.id];
      const hist = usageBySleeper[p.id] ?? [];
      let usage: import("../lib/types").StatLine | undefined;
      if (hist.length > 0 && EFF_PRIOR[p.pos]) {
        const observed = rollingShares(hist, DEFAULT_WEEKLY_MODEL.usage.lambda);
        const prior = priorShares(p, seasonBoard, teamVol);
        const shares = blendWithPrior(observed, prior, DEFAULT_WEEKLY_MODEL.usage.priorGames);
        usage = projectUsageStatLine(
          {
            pos: p.pos,
            shares,
            teamVolume: teamVol[p.team] ?? { targets: 32, carries: 25, attempts: 32 },
            efficiency: observedEfficiency(hist, EFF_PRIOR[p.pos]),
            priorEfficiency: EFF_PRIOR[p.pos],
          },
          DEFAULT_WEEKLY_MODEL
        );
      }
      return {
        id: p.id,
        pos: p.pos,
        team: p.team,
        bye: byeOf.get(p.id) ?? p.bye,
        status: s?.status ?? p.injury,
        sleeper: s?.stats && Object.keys(s.stats).length > 0 ? s.stats : undefined,
        sleeperPoints: s?.points,
        espn: espnBySleeper[p.id]?.stats,
        usage,
      };
    });

    const outlooks = buildWeekOutlooks({
      week,
      players,
      linesByTeam,
      dvp: dvpLookup,
      scoring,
      params: DEFAULT_WEEKLY_MODEL,
    });

    const board: WeekBoard = {
      meta: { season: SEASON, week, builtAt: new Date().toISOString(), lane, scoring: format, sources, warnings },
      outlooks,
    };
    writeFileSync(join(OUT_DIR, `week-${SEASON}-${week}-${format}.json`), JSON.stringify(board));
    console.log(`week-${SEASON}-${week}-${format}.json — ${outlooks.length} outlooks`);
  }

  if (DEFAULT_WEEKLY_MODEL.fittedOn.length === 0) {
    console.warn(
      "\n⚠️  weekly-model.json is still in its OFF state (nothing fitted). " +
        "These outlooks are raw Sleeper projections re-scored — the baseline, not the model. " +
        "Run `pnpm calibrate:weekly` and `pnpm backtest:weekly`.\n"
    );
  }
  for (const w of warnings) console.warn(`⚠️  ${w}`);
}

/** Mean team volume per game so far this season, per team. */
function teamVolumes(
  rows: Record<string, string>[],
  season: number,
  throughWeek: number
): Record<string, { targets: number; carries: number; attempts: number }> {
  const acc: Record<string, { targets: number; carries: number; attempts: number; weeks: Set<number> }> = {};
  for (const r of rows) {
    if (r.season !== String(season) || r.season_type !== "REG") continue;
    const w = Number(r.week);
    if (!Number.isFinite(w) || w >= throughWeek) continue;
    const t = canonicalTeam(r.team);
    if (!t) continue;
    const cell = (acc[t] ??= { targets: 0, carries: 0, attempts: 0, weeks: new Set() });
    cell.targets += num(r.targets);
    cell.carries += num(r.carries);
    cell.attempts += num(r.attempts);
    cell.weeks.add(w);
  }
  const out: Record<string, { targets: number; carries: number; attempts: number }> = {};
  for (const [t, c] of Object.entries(acc)) {
    const n = Math.max(1, c.weeks.size);
    out[t] = { targets: c.targets / n, carries: c.carries / n, attempts: c.attempts / n };
  }
  return out;
}

/**
 * Preseason prior share: the player's season projection as a fraction of his
 * team's, converted into a share of team volume. Crude but the right shape —
 * it is what week 1 leans on, and it is shrunk out by week 8.
 */
function priorShares(
  p: Board["players"][number],
  board: Board,
  teamVol: Record<string, { targets: number; carries: number; attempts: number }>
): Shares {
  const mates = board.players.filter((x) => x.team === p.team && x.pos === p.pos);
  const posTotal = mates.reduce((s, x) => s + Math.max(0, x.projPoints), 0);
  const frac = posTotal > 0 ? Math.max(0, p.projPoints) / posTotal : 0;
  // Rough per-position slice of team volume that the whole position group owns.
  const groupShare: Record<string, { t: number; c: number; a: number }> = {
    QB: { t: 0, c: 0.08, a: 1 },
    RB: { t: 0.2, c: 0.9, a: 0 },
    WR: { t: 0.58, c: 0.04, a: 0 },
    TE: { t: 0.2, c: 0, a: 0 },
    K: { t: 0, c: 0, a: 0 },
    DST: { t: 0, c: 0, a: 0 },
  };
  const g = groupShare[p.pos] ?? { t: 0, c: 0, a: 0 };
  return { targetShare: frac * g.t, carryShare: frac * g.c, attemptShare: frac * g.a, games: 0 };
}

/** Observed per-touch efficiency over the history we have. */
function observedEfficiency(
  hist: import("../lib/engine/weekly/usageModel").UsageWeek[],
  prior: Efficiency
): Efficiency {
  let targets = 0, carries = 0, attempts = 0, recYds = 0, rushYds = 0, passYds = 0;
  for (const w of hist) {
    targets += w.targets;
    carries += w.carries;
    attempts += w.attempts;
    recYds += w.recYds;
    rushYds += w.rushYds;
    passYds += w.passYds;
  }
  // Touchdown rates are NOT estimated from a handful of games — that is the
  // single loudest source of false confidence in weekly projections. They stay
  // at the prior and the model's effReliability never touches them.
  return {
    ydsPerTarget: targets > 0 ? recYds / targets : prior.ydsPerTarget,
    ydsPerCarry: carries > 0 ? rushYds / carries : prior.ydsPerCarry,
    ydsPerAttempt: attempts > 0 ? passYds / attempts : prior.ydsPerAttempt,
    tdPerTarget: prior.tdPerTarget,
    tdPerCarry: prior.tdPerCarry,
    tdPerAttempt: prior.tdPerAttempt,
    catchRate: prior.catchRate,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Add the script to package.json**

```json
"build:week": "tsx scripts/build-week.ts",
```

- [ ] **Step 8: Run it and inspect the output**

Run: `pnpm build:week -- --week=1`
Expected: four `week-2026-1-*.json` files in `public/data/`, each with roughly as many outlooks as the season board has players, plus the loud "weekly-model.json is still in its OFF state" warning — which is correct at this point and is exactly what Task 15 removes.

Sanity-check by hand:
```bash
node -e "const b=require('./public/data/week-2026-1-ppr.json'); const top=b.outlooks.filter(o=>o.mean>0).sort((a,b)=>b.mean-a.mean).slice(0,10); console.log(top.map(o=>[o.playerId,o.opp,o.mean.toFixed(1),o.p10.toFixed(1),o.p90.toFixed(1)]));"
```
The top ten should be recognizable studs with sane numbers, quantiles ordered, and an opponent on each. Anyone on a bye must show `mean: 0`.

- [ ] **Step 9: Run the whole suite and commit**

```bash
pnpm test
git add lib/etl/lane.ts lib/types.ts scripts/build-week.ts package.json tests/lane.test.ts public/data/ data/raw/weekly/
git commit -m "Weekly lane: build-week emits per-format weekly boards, loud about the off state"
```

---

### Task 14: Historical weekly snapshots

Five seasons of projection-vs-reality, committed. Without this there is nothing to fit and nothing to gate, and the model is just assertions.

**Files:**
- Create: `scripts/build-weekly-history.ts`
- Create: `lib/etl/weekly/history.ts`
- Test: `tests/weeklyHistory.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `fetchSleeperWeekly`, `fetchNflverseWeekly`, `parseHistoricalLines`, `statLineFromNflverse`, `scoreStatLine`.
- Produces:
  - `interface HistRow { id: string; pos: Position; team: string; wk: number; opp: string; st: string | null; proj: StatLine; act: StatLine | null; tot: number; spr: number }`
  - `interface HistSeason { season: number; rows: HistRow[] }`
  - `encodeHistory(rows: HistRow[]): string` / `decodeHistory(json: string): HistRow[]` — round-tripping compact storage
  - `loadHistory(seasons: number[]): HistSeason[]`

`act` is `null` when the player did not appear in the box score, which is how the availability fit distinguishes "played and scored zero" from "did not play". Collapsing the two would make every fitted `pPlay` wrong.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyHistory.test.ts
import { describe, it, expect } from "vitest";
import { encodeHistory, decodeHistory, type HistRow } from "../lib/etl/weekly/history";

const rows: HistRow[] = [
  {
    id: "6813", pos: "RB", team: "DET", wk: 3, opp: "CHI", st: null,
    proj: { rushYds: 99.634, rushTD: 1.0512, receptions: 3.95 },
    act: { rushYds: 112, rushTD: 1, receptions: 2 },
    tot: 49.5, spr: -6.5,
  },
  {
    id: "4034", pos: "QB", team: "KC", wk: 3, opp: "LV", st: "Questionable",
    proj: { passYds: 268 },
    act: null,
    tot: 44, spr: -3,
  },
];

describe("history encoding", () => {
  it("round-trips every field, distinguishing 'did not play' from 'scored zero'", () => {
    const back = decodeHistory(encodeHistory(rows));
    expect(back).toHaveLength(2);
    expect(back[0].act?.rushYds).toBe(112);
    expect(back[1].act).toBeNull();
    expect(back[1].st).toBe("Questionable");
    expect(back[0].spr).toBe(-6.5);
  });

  it("rounds projections to two decimals — five seasons must fit in the repo", () => {
    const back = decodeHistory(encodeHistory(rows));
    expect(back[0].proj.rushYds).toBe(99.63);
    expect(back[0].proj.rushTD).toBe(1.05);
  });

  it("produces materially smaller output than naive JSON", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ ...rows[0], id: String(i) }));
    expect(encodeHistory(many).length).toBeLessThan(JSON.stringify(many).length * 0.7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyHistory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the encoder**

```ts
// lib/etl/weekly/history.ts
// Compact storage for the historical weekly fit set. Five seasons of
// projection-vs-reality is ~60,000 player-weeks; naive JSON with long keys
// runs well past what belongs in a git repo, so this uses short keys, drops
// zeros, and rounds to two decimals (the projections are not precise past
// that anyway).
import type { Position, StatLine } from "../../types";

export interface HistRow {
  id: string;
  pos: Position;
  team: string;
  wk: number;
  opp: string;
  /** Injury designation at projection time, for the availability fit. */
  st: string | null;
  proj: StatLine;
  /** null = did not appear in the box score. Distinct from an all-zero line. */
  act: StatLine | null;
  /** Game total. */
  tot: number;
  /** This team's own spread; negative = favored. */
  spr: number;
}

/** StatLine keys → one- or two-char codes. Order is frozen: changing it
 *  invalidates every committed snapshot, so append, never reorder. */
const CODES: [keyof StatLine, string][] = [
  ["passYds", "py"], ["passTD", "pt"], ["passInt", "pi"], ["pass2pt", "p2"],
  ["rushYds", "ry"], ["rushTD", "rt"], ["rush2pt", "r2"],
  ["receptions", "rc"], ["recYds", "cy"], ["recTD", "ct"], ["rec2pt", "c2"],
  ["fumblesLost", "fl"], ["rushFd", "rf"], ["recFd", "cf"], ["passFd", "pf"],
];

const r2 = (v: number) => Math.round(v * 100) / 100;

function packStats(s: StatLine): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, code] of CODES) {
    const v = s[key];
    if (typeof v === "number" && v !== 0) out[code] = r2(v);
  }
  return out;
}

function unpackStats(o: Record<string, number>): StatLine {
  const out: StatLine = {};
  for (const [key, code] of CODES) {
    const v = o[code];
    if (typeof v === "number" && v !== 0) out[key] = v;
  }
  return out;
}

export function encodeHistory(rows: HistRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      i: r.id, p: r.pos, t: r.team, w: r.wk, o: r.opp,
      s: r.st ?? undefined,
      j: packStats(r.proj),
      a: r.act === null ? null : packStats(r.act),
      v: r2(r.tot), d: r2(r.spr),
    }))
  );
}

interface Packed {
  i: string; p: Position; t: string; w: number; o: string;
  s?: string; j: Record<string, number>; a: Record<string, number> | null;
  v: number; d: number;
}

export function decodeHistory(json: string): HistRow[] {
  return (JSON.parse(json) as Packed[]).map((r) => ({
    id: r.i, pos: r.p, team: r.t, wk: r.w, opp: r.o,
    st: r.s ?? null,
    proj: unpackStats(r.j),
    act: r.a === null ? null : unpackStats(r.a),
    tot: r.v, spr: r.d,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyHistory.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the builder script**

```ts
// scripts/build-weekly-history.ts
// Builds the historical weekly fit set: Sleeper's weekly projections (they
// serve past seasons — verified for 2021, 2024 and 2025 on 2026-09-09) crossed
// with nflverse weekly actuals and the spread/total in nfldata games.csv.
//
// Output: data/historical-data/weekly/{season}.json (compact, committed).
// Run once per season, or after a season ends. Not part of any CI lane.
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchSleeperWeekly } from "../lib/etl/weekly/sleeperWeekly";
import { fetchNflverseWeekly } from "../lib/etl/weekly/nflverseWeekly";
import { parseHistoricalLines, lineFor } from "../lib/etl/weekly/vegas";
import { fetchPlayerIds } from "../lib/etl/fetchers";
import { parseCsv } from "../lib/etl/csv";
import { canonicalTeam, statLineFromNflverse } from "../lib/etl/nflverse";
import { encodeHistory, type HistRow } from "../lib/etl/weekly/history";
import type { Position } from "../lib/types";

const OUT_DIR = join(process.cwd(), "data", "historical-data", "weekly");
const SEASONS = [2021, 2022, 2023, 2024, 2025];
const WEEKS = 18;
/** Below this projection a player is roster filler: keeping him triples the
 *  file size and contributes nothing but noise to the fit. */
const MIN_PROJ_YDS = 10;

async function main() {
  const gamesCsv = await fetch("https://github.com/nflverse/nfldata/raw/master/data/games.csv").then((r) => r.text());
  const idsRes = await fetchPlayerIds({ fixtureOnly: true });
  const cross = parseCsv(idsRes.data); // raw CSV body, per lib/etl/fetchers.ts:135
  const gsisToSleeper: Record<string, string> = {};
  for (const r of cross) if (r.sleeper_id && r.gsis_id) gsisToSleeper[r.gsis_id] = r.sleeper_id;

  mkdirSync(OUT_DIR, { recursive: true });

  for (const season of SEASONS) {
    const lines = parseHistoricalLines(gamesCsv, season);
    if (lines.length < 200) throw new Error(`${season}: only ${lines.length} games with lines`);
    const nfl = await fetchNflverseWeekly(season);

    // actuals: sleeperId|week → stat line
    const actual = new Map<string, ReturnType<typeof statLineFromNflverse>>();
    for (const r of nfl.data) {
      if (r.season !== String(season) || r.season_type !== "REG") continue;
      const sid = gsisToSleeper[r.player_id ?? ""];
      if (!sid) continue;
      actual.set(`${sid}|${r.week}`, statLineFromNflverse(r));
    }

    const rows: HistRow[] = [];
    for (let wk = 1; wk <= WEEKS; wk++) {
      const proj = await fetchSleeperWeekly(season, wk);
      for (const [id, p] of Object.entries(proj.data)) {
        const yds = (p.stats.passYds ?? 0) + (p.stats.rushYds ?? 0) + (p.stats.recYds ?? 0);
        if (yds < MIN_PROJ_YDS) continue;
        const line = lineFor(lines.filter((l) => l.week === wk), p.team);
        if (!line) continue; // bye, or a team the schedule file does not carry
        rows.push({
          id, pos: p.pos as Position, team: p.team, wk, opp: line.opp,
          st: p.status,
          proj: p.stats,
          act: actual.get(`${id}|${wk}`) ?? null,
          tot: line.total, spr: line.ownSpread,
        });
      }
      process.stdout.write(`\r${season} week ${wk}: ${rows.length} rows`);
    }
    const path = join(OUT_DIR, `${season}.json`);
    writeFileSync(path, encodeHistory(rows));
    const mb = statSync(path).size / 1e6;
    console.log(`\n${season}: ${rows.length} player-weeks, ${mb.toFixed(1)} MB`);
    if (mb > 4) {
      throw new Error(
        `${season}.json is ${mb.toFixed(1)} MB — over budget. Raise MIN_PROJ_YDS or trim a field; ` +
          `five seasons must stay under ~10 MB total (see the spec).`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Add the script and run it**

```json
"build:weekly-history": "tsx scripts/build-weekly-history.ts",
```

Run: `pnpm build:weekly-history`
Expected: five files in `data/historical-data/weekly/`, roughly 40,000–70,000 player-weeks total, under 10 MB combined. This makes ~90 Sleeper calls; that API has no published quota and the repo already polls it, but run it once and not in a loop.

- [ ] **Step 7: Sanity-check the fit set before trusting it**

```bash
node -e "
const {decodeHistory}=require('./lib/etl/weekly/history.ts');
" 2>/dev/null || pnpm tsx -e "
import { readFileSync } from 'node:fs';
import { decodeHistory } from './lib/etl/weekly/history';
import { scoreStatLine, SCORING_PRESETS } from './lib/scoring';
const rows = decodeHistory(readFileSync('data/historical-data/weekly/2024.json','utf8'));
const played = rows.filter(r => r.act);
const proj = played.map(r => scoreStatLine(r.proj, SCORING_PRESETS.ppr));
const act = played.map(r => scoreStatLine(r.act!, SCORING_PRESETS.ppr));
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
console.log('rows', rows.length, 'played', played.length);
console.log('mean proj', mean(proj).toFixed(2), 'mean actual', mean(act).toFixed(2));
console.log('did-not-play rate', (1 - played.length/rows.length).toFixed(3));
"
```
Expected: mean projected and mean actual within roughly 15% of each other, and a did-not-play rate in the low tens of percent. **A large gap or a near-zero did-not-play rate means the id join failed** — investigate before Task 15, because every coefficient fitted on a broken join will be wrong in a way the gates cannot see.

- [ ] **Step 8: Commit**

```bash
git add lib/etl/weekly/history.ts scripts/build-weekly-history.ts tests/weeklyHistory.test.ts package.json data/historical-data/weekly/
git commit -m "Weekly history: five committed seasons of projection vs reality, compactly encoded"
```

---

### Task 15: Pure fitting math

The statistics, as pure tested functions, so the calibration script in Task 16 is only orchestration. Keeping the math here rather than in the script is what makes it testable at all.

**Files:**
- Create: `lib/engine/weekly/fit.ts`
- Test: `tests/weeklyFit.test.ts`

**Interfaces:**
- Consumes: nothing beyond `Position`.
- Produces: `olsSlope(xs: number[], ys: number[]): number`, `stdev(xs: number[]): number`, `pearson(xs: number[], ys: number[]): number`, `fitSigmaByVolume(points: { volume: number; logResidual: number }[], v0: number): { sigma0: number; delta: number }`, `empiricalPlayRate(rows: { status: string | null; played: boolean }[]): Record<string, number>`, `pitCoverage(pairs: { actual: number; mean: number; sigma: number }[]): { below10: number; above90: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyFit.test.ts
import { describe, it, expect } from "vitest";
import { olsSlope, stdev, pearson, fitSigmaByVolume, empiricalPlayRate, pitCoverage } from "../lib/engine/weekly/fit";

describe("olsSlope", () => {
  it("recovers a known slope", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 + 2 * x);
    expect(olsSlope(xs, ys)).toBeCloseTo(2, 10);
  });
  it("is zero when x has no variance, rather than NaN", () => {
    expect(olsSlope([2, 2, 2], [1, 5, 9])).toBe(0);
  });
  it("is zero on fewer than three points — a two-point 'fit' is a line, not evidence", () => {
    expect(olsSlope([1, 2], [1, 4])).toBe(0);
  });
});

describe("stdev and pearson", () => {
  it("stdev of a constant is zero", () => expect(stdev([4, 4, 4])).toBe(0));
  it("pearson of identical series is 1", () => expect(pearson([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10));
  it("pearson of opposed series is -1", () => expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10));
  it("pearson is 0 when a series is flat", () => expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0));
});

describe("fitSigmaByVolume", () => {
  it("recovers sigma0 and a positive delta from synthetic data where low volume is noisier", () => {
    const points: { volume: number; logResidual: number }[] = [];
    // sigma(v) = 0.8 * (8/v)^0.4 ; emit +/- sigma so the bucket sd equals it.
    for (const v of [2, 4, 8, 16, 32]) {
      const s = 0.8 * Math.pow(8 / v, 0.4);
      for (let i = 0; i < 200; i++) points.push({ volume: v, logResidual: i % 2 ? s : -s });
    }
    const { sigma0, delta } = fitSigmaByVolume(points, 8);
    expect(sigma0).toBeCloseTo(0.8, 1);
    expect(delta).toBeGreaterThan(0.25);
    expect(delta).toBeLessThan(0.55);
  });

  it("returns delta 0 when volume carries no information", () => {
    const points = Array.from({ length: 500 }, (_, i) => ({ volume: 1 + (i % 20), logResidual: i % 2 ? 0.5 : -0.5 }));
    expect(Math.abs(fitSigmaByVolume(points, 8).delta)).toBeLessThan(0.1);
  });
});

describe("empiricalPlayRate", () => {
  it("measures P(played | status) per designation", () => {
    const rows = [
      { status: "Questionable", played: true },
      { status: "Questionable", played: true },
      { status: "Questionable", played: false },
      { status: "Questionable", played: true },
      { status: "Out", played: false },
      { status: "Out", played: false },
      { status: null, played: true },
    ];
    const t = empiricalPlayRate(rows);
    expect(t.Questionable).toBeCloseTo(0.75, 10);
    expect(t.Out).toBe(0);
    // A null designation is not a status and must not appear in the table.
    expect(t.null).toBeUndefined();
  });

  it("ignores designations with too few observations to mean anything", () => {
    expect(empiricalPlayRate([{ status: "Sus", played: false }]).Sus).toBeUndefined();
  });
});

describe("pitCoverage", () => {
  it("reports ~10% below p10 and ~10% above p90 for a correctly-specified model", () => {
    // Lognormal with mean 10, sigma 0.6; sample its own quantiles evenly.
    const pairs = [];
    for (let i = 1; i < 1000; i++) {
      const q = i / 1000;
      const mu = Math.log(10) - 0.18;
      const actual = Math.exp(mu + 0.6 * Math.sqrt(2) * inverseErf(2 * q - 1));
      pairs.push({ actual, mean: 10, sigma: 0.6 });
    }
    const { below10, above90 } = pitCoverage(pairs);
    expect(below10).toBeGreaterThan(0.07);
    expect(below10).toBeLessThan(0.13);
    expect(above90).toBeGreaterThan(0.07);
    expect(above90).toBeLessThan(0.13);
  });
});

/** Tiny inverse error function, test-local — the module under test must not need it. */
function inverseErf(x: number): number {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyFit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekly/fit.ts
// Fitting primitives for scripts/calibrate-weekly.ts. Pure, so the statistics
// are unit-tested rather than trusted.
//
// Everything here is deliberately simple: ordinary least squares on log
// residuals, empirical rates, bucketed standard deviations. The signal in
// weekly fantasy football is small, and a fancier estimator on a residual this
// noisy buys precision the data cannot support.

/** Minimum points before a slope means anything. */
const MIN_FIT_N = 3;
/** Minimum observations before a status's play rate is trusted. */
const MIN_STATUS_N = 20;

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function olsSlope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < MIN_FIT_N) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/**
 * Fit sigma = sigma0 · (v0/v)^delta by bucketing on volume, taking each
 * bucket's residual standard deviation, and regressing log(sd) on log(v0/v).
 * sigma0 is read off at v = v0.
 */
export function fitSigmaByVolume(
  points: { volume: number; logResidual: number }[],
  v0: number
): { sigma0: number; delta: number } {
  const BUCKETS = 8;
  const sorted = [...points].sort((a, b) => a.volume - b.volume);
  if (sorted.length < BUCKETS * 5) {
    return { sigma0: stdev(points.map((p) => p.logResidual)), delta: 0 };
  }
  const per = Math.floor(sorted.length / BUCKETS);
  const xs: number[] = [];
  const ys: number[] = [];
  const sds: { v: number; sd: number }[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const slice = sorted.slice(b * per, b === BUCKETS - 1 ? sorted.length : (b + 1) * per);
    const sd = stdev(slice.map((p) => p.logResidual));
    const meanV = slice.reduce((s, p) => s + p.volume, 0) / slice.length;
    if (sd <= 0 || meanV <= 0) continue;
    sds.push({ v: meanV, sd });
    xs.push(Math.log(v0 / meanV));
    ys.push(Math.log(sd));
  }
  const delta = olsSlope(xs, ys);
  // sigma0 is the fitted sd at v = v0, i.e. where log(v0/v) = 0.
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const intercept = meanY - delta * meanX;
  return { sigma0: Math.exp(intercept), delta };
}

/** P(played | designation). Designations seen too rarely are omitted, so the
 *  caller falls back to FALLBACK_PLAY_PROB rather than to a rate of 1/1. */
export function empiricalPlayRate(
  rows: { status: string | null; played: boolean }[]
): Record<string, number> {
  const acc: Record<string, { n: number; played: number }> = {};
  for (const r of rows) {
    if (!r.status) continue;
    const cell = (acc[r.status] ??= { n: 0, played: 0 });
    cell.n++;
    if (r.played) cell.played++;
  }
  const out: Record<string, number> = {};
  for (const [status, c] of Object.entries(acc)) {
    if (c.n >= MIN_STATUS_N) out[status] = c.played / c.n;
  }
  return out;
}

/**
 * Distribution calibration. For a correctly-specified lognormal, 10% of
 * actuals fall below p10 and 10% above p90. This is the gate that matters most
 * for start/sit and GPP and the one almost nobody runs: a model can have
 * excellent MAE and still be badly wrong about how often the ceiling hits.
 */
export function pitCoverage(
  pairs: { actual: number; mean: number; sigma: number }[]
): { below10: number; above90: number } {
  const Z10 = -1.2815515655446004;
  const Z90 = 1.2815515655446004;
  let below = 0;
  let above = 0;
  let n = 0;
  for (const { actual, mean, sigma } of pairs) {
    if (!(mean > 0) || !(sigma > 0)) continue;
    const mu = Math.log(mean) - (sigma * sigma) / 2;
    const p10 = Math.exp(mu + sigma * Z10);
    const p90 = Math.exp(mu + sigma * Z90);
    n++;
    if (actual < p10) below++;
    if (actual > p90) above++;
  }
  return n > 0 ? { below10: below / n, above90: above / n } : { below10: 0, above90: 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyFit.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/weekly/fit.ts tests/weeklyFit.test.ts
git commit -m "Weekly fit: OLS, bucketed sigma, empirical play rates, PIT coverage"
```

---

### Task 16: Calibration script

Orchestration only — the math lives in Task 15. Fits every coefficient on the residual against the market and writes `config/weekly-model.json`.

**Files:**
- Create: `scripts/calibrate-weekly.ts`
- Modify: `package.json`
- Modify: `config/weekly-model.json` (written by the script — commit the result)

**Interfaces:**
- Consumes: `decodeHistory` (14); `olsSlope`/`stdev`/`pearson`/`fitSigmaByVolume`/`empiricalPlayRate` (15); `impliedTeamPoints` (4); `buildDvp`-equivalent rolling table computed from history; `projectedVolume` (7); `scoreStatLine`.
- Produces: a fitted `config/weekly-model.json` with a non-empty `fittedOn`.

- [ ] **Step 1: Write the script**

```ts
// scripts/calibrate-weekly.ts
// Fits config/weekly-model.json from the committed weekly history.
//
// THE CENTRAL DISCIPLINE: every adjustment coefficient is fitted on the
// RESIDUAL log(actual / baseMarket), never on actual points. Sleeper's
// projection already embeds part of the Vegas line and part of the matchup;
// fitting on actuals would count that signal twice and produce a model that
// loses to the single API call it is built on. Expect small coefficients.
// Small and real beats large and double-counted.
//
// Usage: pnpm calibrate:weekly [--holdout=2025]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeHistory, type HistRow } from "../lib/etl/weekly/history";
import { olsSlope, stdev, fitSigmaByVolume, empiricalPlayRate } from "../lib/engine/weekly/fit";
import { impliedTeamPoints } from "../lib/engine/weekly/environment";
import { projectedVolume } from "../lib/engine/weekly/spread";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";
import type { Position } from "../lib/types";

const HIST_DIR = join(process.cwd(), "data", "historical-data", "weekly");
const CONFIG = join(process.cwd(), "config", "weekly-model.json");
const ALL_SEASONS = [2021, 2022, 2023, 2024, 2025];
const POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];
const scoring = SCORING_PRESETS.ppr;

interface FitRow extends HistRow {
  season: number;
  base: number;      // market projection, PPR
  actual: number;    // realized points, PPR — only when he played
  played: boolean;
  itpOwn: number;
  itpOpp: number;
  volume: number;
}

function load(seasons: number[]): FitRow[] {
  const out: FitRow[] = [];
  for (const season of seasons) {
    const path = join(HIST_DIR, `${season}.json`);
    if (!existsSync(path)) throw new Error(`missing ${path} — run pnpm build:weekly-history first`);
    for (const r of decodeHistory(readFileSync(path, "utf8"))) {
      const base = scoreStatLine(r.proj, scoring, r.pos === "TE");
      if (!(base > 0)) continue;
      out.push({
        ...r,
        season,
        base,
        actual: r.act ? scoreStatLine(r.act, scoring, r.pos === "TE") : 0,
        played: r.act !== null,
        itpOwn: impliedTeamPoints(r.tot, r.spr),
        itpOpp: impliedTeamPoints(r.tot, -r.spr),
        volume: projectedVolume(r.pos, r.proj),
      });
    }
  }
  return out;
}

/**
 * Rolling points allowed per defense per position, computed strictly from
 * weeks BEFORE the row's week — the same leak-free construction buildDvp uses
 * at runtime. Fitting gamma against a table that includes the week being
 * predicted would produce a large, entirely fake coefficient.
 */
function dvpRatios(rows: FitRow[]): Map<FitRow, number> {
  const played = rows.filter((r) => r.played);
  // (season, defense, pos) → week → { pts, n }
  const acc = new Map<string, Map<number, { pts: number; n: number }>>();
  for (const r of played) {
    const k = `${r.season}|${r.opp}|${r.pos}`;
    const byWeek = acc.get(k) ?? new Map();
    const cell = byWeek.get(r.wk) ?? { pts: 0, n: 0 };
    cell.pts += r.actual;
    cell.n += 1;
    byWeek.set(r.wk, cell);
    acc.set(k, byWeek);
  }
  // League average allowed per position per season, for the ratio's denominator.
  const leagueAvg = new Map<string, number>();
  for (const pos of POSITIONS) {
    for (const season of ALL_SEASONS) {
      const vals: number[] = [];
      for (const [k, byWeek] of acc) {
        if (!k.startsWith(`${season}|`) || !k.endsWith(`|${pos}`)) continue;
        for (const c of byWeek.values()) vals.push(c.pts);
      }
      if (vals.length) leagueAvg.set(`${season}|${pos}`, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  const out = new Map<FitRow, number>();
  for (const r of rows) {
    const byWeek = acc.get(`${r.season}|${r.opp}|${r.pos}`);
    const avg = leagueAvg.get(`${r.season}|${r.pos}`);
    if (!byWeek || !avg || !(avg > 0)) continue;
    let pts = 0;
    let weeks = 0;
    for (const [wk, c] of byWeek) {
      if (wk >= r.wk) continue; // strictly prior weeks
      pts += c.pts;
      weeks++;
    }
    if (weeks < 2) continue;
    const allowed = pts / weeks;
    // Shrink exactly as matchMult will at runtime, so the fitted gamma is the
    // exponent on the SHRUNK ratio, not on the raw one.
    const k = DEFAULT_WEEKLY_MODEL.matchup.shrinkGames;
    const shrunk = 1 + (weeks / (weeks + k)) * (allowed / avg - 1);
    if (shrunk > 0) out.set(r, shrunk);
  }
  return out;
}

function main() {
  const holdoutArg = process.argv.find((a) => a.startsWith("--holdout="));
  const holdout = holdoutArg ? Number(holdoutArg.slice("--holdout=".length)) : null;
  const fitSeasons = holdout ? ALL_SEASONS.filter((s) => s !== holdout) : ALL_SEASONS;
  console.log(`fitting on ${fitSeasons.join(", ")}${holdout ? ` (holding out ${holdout})` : ""}`);

  const rows = load(fitSeasons);
  const active = rows.filter((r) => r.played && r.actual > 0);
  console.log(`${rows.length} player-weeks, ${active.length} with a realized score`);

  const params: WeeklyModelParams = JSON.parse(JSON.stringify(DEFAULT_WEEKLY_MODEL));
  params.fittedOn = fitSeasons;

  // --- availability ---------------------------------------------------------
  params.availability.byStatus = empiricalPlayRate(
    rows.map((r) => ({ status: r.st, played: r.played }))
  );
  console.log("availability:", params.availability.byStatus);

  // --- environment: alpha on log(itp / leagueAvgItp) ------------------------
  const avgItp = active.reduce((s, r) => s + r.itpOwn, 0) / active.length;
  params.environment.leagueAvgItp = Math.round(avgItp * 10) / 10;
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos);
    const xs = sub.map((r) => Math.log(Math.max(0.2, r.itpOwn / avgItp)));
    const ys = sub.map((r) => Math.log(r.actual / r.base));
    const a = olsSlope(xs, ys);
    if (Math.abs(a) > 0.01) params.environment.alpha[pos] = round3(a);
  }
  // DST reads the OPPONENT's implied total. No DST rows are in the history set
  // (Sleeper's DEF projections carry no yardage), so alpha.DST stays unfitted
  // and neutral until a DST history source exists. Stated, not silently zero.
  console.log("environment.alpha:", params.environment.alpha);

  // --- environment: beta on favoredness, AFTER removing alpha ---------------
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos);
    const a = params.environment.alpha[pos] ?? 0;
    // On ownSpread directly, matching scriptMult in lib/engine/weekly/environment.ts.
    // Regressing on -spr/7 here while the runtime applies +spr/7 would invert
    // every fitted game-script adjustment, silently and undetectably.
    const xs = sub.map((r) => r.spr / 7);
    const ys = sub.map(
      (r) => Math.log(r.actual / r.base) - a * Math.log(Math.max(0.2, r.itpOwn / avgItp))
    );
    const b = olsSlope(xs, ys);
    if (Math.abs(b) > 0.005) params.environment.beta[pos] = round3(b);
  }
  console.log("environment.beta:", params.environment.beta);

  // --- matchup: gamma on log(shrunk DvP ratio), after alpha and beta --------
  const ratios = dvpRatios(rows);
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos && ratios.has(r));
    const a = params.environment.alpha[pos] ?? 0;
    const b = params.environment.beta[pos] ?? 0;
    const xs = sub.map((r) => Math.log(ratios.get(r)!));
    const ys = sub.map(
      (r) =>
        Math.log(r.actual / r.base) -
        a * Math.log(Math.max(0.2, r.itpOwn / avgItp)) -
        Math.log(Math.max(0.4, 1 + b * (r.spr / 7)))
    );
    const g = olsSlope(xs, ys);
    if (Math.abs(g) > 0.01) params.matchup.gamma[pos] = round3(g);
    console.log(`  ${pos}: gamma ${g.toFixed(3)} over ${sub.length} rows`);
  }

  // --- sigma: fitted on the residual AFTER all adjustments -----------------
  for (const pos of POSITIONS) {
    const sub = active.filter((r) => r.pos === pos);
    const v0 = DEFAULT_WEEKLY_MODEL.sigma.v0[pos] ?? 8;
    const points = sub.map((r) => ({
      volume: r.volume,
      logResidual: Math.log(r.actual / adjustedMean(r, params, avgItp, ratios)),
    }));
    const { sigma0, delta } = fitSigmaByVolume(points, v0);
    params.sigma.sigma0[pos] = round3(sigma0);
    // delta is shared across positions: per-position deltas fitted on this much
    // noise flip sign between seasons. One number, fitted on the pooled set.
    console.log(`  ${pos}: sigma0 ${sigma0.toFixed(3)}, delta ${delta.toFixed(3)}`);
  }
  const pooled = active.map((r) => ({
    volume: r.volume / (DEFAULT_WEEKLY_MODEL.sigma.v0[r.pos] ?? 8),
    logResidual: Math.log(r.actual / adjustedMean(r, params, avgItp, ratios)),
  }));
  params.sigma.delta = round3(Math.max(0, fitSigmaByVolume(pooled, 1).delta));
  console.log("sigma.delta (pooled):", params.sigma.delta);

  // --- correlation: within-team and within-unit residual co-movement --------
  params.correlation = fitCorrelations(active, params, avgItp, ratios);
  console.log("correlation:", params.correlation);

  // NOTE: sourceWeights and modelWeights are NOT fitted here. They need
  // ESPN/DK weekly history and a usage backfill, neither of which the history
  // set carries yet. They stay at their off-state values (sleeper 1, usage 0)
  // and Task 17's gate 1 measures the model against exactly that baseline.
  // Fitting them is the first follow-up once weekly ESPN snapshots accumulate.

  writeFileSync(CONFIG, JSON.stringify(params, null, 2) + "\n");
  console.log(`\nwrote ${CONFIG}`);
}

function adjustedMean(
  r: FitRow,
  p: WeeklyModelParams,
  avgItp: number,
  ratios: Map<FitRow, number>
): number {
  const a = p.environment.alpha[r.pos] ?? 0;
  const b = p.environment.beta[r.pos] ?? 0;
  const g = p.matchup.gamma[r.pos] ?? 0;
  const ratio = ratios.get(r);
  const mEnv = a ? Math.pow(Math.max(0.2, r.itpOwn / avgItp), a) : 1;
  const mScript = b ? Math.max(0.4, 1 + b * (r.spr / 7)) : 1;
  const mMatch = g && ratio ? Math.pow(Math.max(0.2, ratio), g) : 1;
  return Math.max(0.1, r.base * mEnv * mScript * mMatch);
}

/**
 * Empirical correlation of log residuals for pairs sharing a game, a team, and
 * a unit. Nesting is enforced by construction (each level is at least the one
 * above it) so correlationAmplitudes never sees an invalid set.
 */
function fitCorrelations(
  active: FitRow[],
  p: WeeklyModelParams,
  avgItp: number,
  ratios: Map<FitRow, number>
): WeeklyModelParams["correlation"] {
  const resid = new Map<FitRow, number>();
  for (const r of active) resid.set(r, Math.log(r.actual / adjustedMean(r, p, avgItp, ratios)));

  const byKey = <K>(keyOf: (r: FitRow) => K) => {
    const groups = new Map<K, FitRow[]>();
    for (const r of active) {
      const k = keyOf(r);
      const list = groups.get(k) ?? [];
      list.push(r);
      groups.set(k, list);
    }
    // Mean pairwise correlation, estimated as the ratio of between-group
    // variance to total variance (an intraclass correlation).
    let within = 0, betweenN = 0, grand = 0, n = 0;
    for (const r of active) { grand += resid.get(r)!; n++; }
    grand /= n;
    let ssBetween = 0, ssTotal = 0;
    for (const r of active) ssTotal += (resid.get(r)! - grand) ** 2;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const m = list.reduce((s, r) => s + resid.get(r)!, 0) / list.length;
      ssBetween += list.length * (m - grand) ** 2;
      betweenN += list.length;
      within += list.length;
    }
    void within;
    void betweenN;
    return ssTotal > 0 ? Math.max(0, Math.min(0.9, ssBetween / ssTotal)) : 0;
  };

  const game = byKey((r) => `${r.season}|${r.wk}|${[r.team, r.opp].sort().join("-")}`);
  const teamRaw = byKey((r) => `${r.season}|${r.wk}|${r.team}`);
  const unitRaw = byKey((r) => `${r.season}|${r.wk}|${r.team}|${r.pos === "RB" ? "run" : "pass"}`);
  // Enforce nesting rather than shipping a set loadWeeklyModel would reject.
  const team = Math.max(game, teamRaw);
  const unit = Math.max(team, unitRaw);
  return {
    game: round3(game),
    team: round3(team),
    unit: round3(unit),
    // No DST rows in the history set, so this stays at its off value.
    dstVsOppTeam: DEFAULT_WEEKLY_MODEL.correlation.dstVsOppTeam,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

main();
```

- [ ] **Step 2: Add the script**

```json
"calibrate:weekly": "tsx scripts/calibrate-weekly.ts",
```

- [ ] **Step 3: Fit on four seasons, holding out one**

Run: `pnpm calibrate:weekly -- --holdout=2025`
Expected: it prints per-position alphas, betas, gammas, sigmas and correlations, and writes the config.

**Read the printed numbers before continuing.** Sanity expectations, from what the residual against a market projection can plausibly contain:
- `alpha` positive for offensive positions, roughly 0.1–0.6. A value above 1 means you are fitting against actuals rather than the residual — re-read the residual construction.
- `beta.RB` positive (favorites run), `beta.WR`/`beta.QB` negative or near zero. If every beta has the same sign, check the spread convention from Task 3 Step 5.
- `gamma` small, roughly 0.0–0.4. A large gamma almost always means the DvP table leaked the week being predicted.
- `correlation.unit` above `correlation.team` above `correlation.game`, all under ~0.5.

If a coefficient looks implausible, that is a finding, not a nuisance — fix the construction, do not clamp the output.

- [ ] **Step 4: Verify the config still loads**

Run: `pnpm vitest run tests/weeklyModel.test.ts`
Expected: **the off-state test now FAILS**, correctly — the config is no longer in its off state. Update that test to read the off state from an inline literal rather than from the shipped config, keeping the assertion that the *literal* off state produces neutral multipliers:

```ts
// tests/weeklyModel.test.ts — replace the first test
import { loadWeeklyModel } from "../lib/engine/weekly/model";

const OFF_STATE = {
  fittedOn: [], sourceWeights: { sleeper: 1, espn: 0, dk: 0 },
  modelWeights: { market: 1, usage: 0 },
  usage: { lambda: 0.75, priorGames: 4, effReliability: 0.15 },
  environment: { alpha: {}, beta: {}, leagueAvgItp: 22.5 },
  matchup: { gamma: {}, shrinkGames: 6, priorSeasonWeight: 0.5 },
  sigma: { sigma0: {}, v0: {}, delta: 0 },
  availability: { byStatus: {} },
  correlation: { game: 0, team: 0.28, unit: 0.28, dstVsOppTeam: 0 },
};

it("the documented off state is loadable and neutral", () => {
  const m = loadWeeklyModel(OFF_STATE);
  expect(m.modelWeights.usage).toBe(0);
  expect(Object.keys(m.environment.alpha)).toHaveLength(0);
  expect(m.sigma.delta).toBe(0);
});

it("the shipped config is valid and has been fitted", () => {
  const m = loadWeeklyModel(DEFAULT_WEEKLY_MODEL);
  expect(m.fittedOn.length).toBeGreaterThan(0);
});
```

Also export `OFF_STATE` from `lib/engine/weekly/model.ts` as `OFF_WEEKLY_MODEL` so `tests/weeklyOutlook.test.ts` (which asserts the off-state contract) uses it instead of `DEFAULT_WEEKLY_MODEL`, and update that test file's `const OFF = DEFAULT_WEEKLY_MODEL;` to `const OFF = OFF_WEEKLY_MODEL;`.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: all pass. Several weekly tests that used `DEFAULT_WEEKLY_MODEL` as a stand-in for "no adjustments" will need the same `OFF_WEEKLY_MODEL` swap — make it everywhere it appears rather than loosening an assertion.

- [ ] **Step 6: Commit**

```bash
git add scripts/calibrate-weekly.ts config/weekly-model.json lib/engine/weekly/model.ts tests/ package.json
git commit -m "Weekly calibration: fit environment, matchup, sigma, availability and correlation on the residual"
```

---

### Task 17: Backtest and acceptance gates

The scoreboard. Gates 1 and 4 are blocking: if either fails, the shipped config reverts to its off state and the model becomes opt-in, exactly how the unified decision model is handled today.

**Files:**
- Create: `scripts/backtest-weekly.ts`
- Modify: `docs/backtest-gates.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: `decodeHistory`; `buildWeekOutlooks`; `pitCoverage`/`pearson`; `simulateWeek`; `dkBonusPoints`; the fitted config.

- [ ] **Step 1: Write the script**

```ts
// scripts/backtest-weekly.ts
// Acceptance gates for the weekly projection model, measured on a HELD-OUT
// season the calibration never saw.
//
// Gate 1 (blocking): beat raw Sleeper on RMSE and MAE, per position.
// Gate 2: per-position rank correlation at least as good as the baseline's.
// Gate 3: distribution calibration — p10/p90 coverage near 10%.
// Gate 4 (blocking): decision accuracy — the model's lineup beats naive
//         "start the highest projection" in realized points AND in matchup
//         win rate over simulated head-to-heads.
// Gate 5: simulated DK bonus frequency matches historical frequency.
//
// Usage: pnpm backtest:weekly -- --holdout=2025
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeHistory } from "../lib/etl/weekly/history";
import { pitCoverage, pearson } from "../lib/engine/weekly/fit";
import { buildWeekOutlooks, type WeekLine, type WeekPlayerInput } from "../lib/engine/weekly/outlook";
import { DEFAULT_WEEKLY_MODEL, OFF_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { simulateWeek, type WeekSimPlayer } from "../lib/engine/weekSim";
import { dkBonusPoints } from "../lib/engine/weekly/bonuses";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";
import { makeRng } from "../lib/engine/montecarlo";
import type { Position } from "../lib/types";

const HIST_DIR = join(process.cwd(), "data", "historical-data", "weekly");
const GATES = join(process.cwd(), "docs", "backtest-gates.md");
const POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];
const scoring = SCORING_PRESETS.ppr;

const results: string[] = [];
let failures = 0;
function gate(pass: boolean, line: string) {
  results.push(`- ${pass ? "PASS" : "FAIL"} — ${line}`);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} — ${line}`);
}

const rmse = (errs: number[]) => Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
const mae = (errs: number[]) => errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function main() {
  const arg = process.argv.find((a) => a.startsWith("--holdout="));
  const season = arg ? Number(arg.slice("--holdout=".length)) : 2025;
  const path = join(HIST_DIR, `${season}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path} — run pnpm build:weekly-history`);
  const rows = decodeHistory(readFileSync(path, "utf8"));
  console.log(`holdout ${season}: ${rows.length} player-weeks\n`);

  // Rebuild outlooks week by week, under the fitted model and under the off
  // state, using only information available before each week.
  const byWeek = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byWeek.get(r.wk) ?? [];
    list.push(r);
    byWeek.set(r.wk, list);
  }

  interface Scored { pos: Position; actual: number; model: number; baseline: number; sigma: number; wk: number; id: string; stats: typeof rows[number]["proj"] }
  const scored: Scored[] = [];

  for (const [wk, weekRows] of [...byWeek].sort((a, b) => a[0] - b[0])) {
    const linesByTeam: Record<string, WeekLine> = {};
    for (const r of weekRows) linesByTeam[r.team] = { total: r.tot, ownSpread: r.spr, opp: r.opp };

    // Leak-free DvP from strictly prior weeks of this holdout season.
    const priorRows = rows.filter((r) => r.wk < wk && r.act);
    const allowed = new Map<string, { pts: number; weeks: Set<number> }>();
    for (const r of priorRows) {
      const k = `${r.opp}|${r.pos}`;
      const cell = allowed.get(k) ?? { pts: 0, weeks: new Set<number>() };
      cell.pts += scoreStatLine(r.act!, scoring, r.pos === "TE");
      cell.weeks.add(r.wk);
      allowed.set(k, cell);
    }
    const leagueAvg = new Map<Position, number>();
    for (const pos of POSITIONS) {
      const vals = [...allowed].filter(([k]) => k.endsWith(`|${pos}`)).map(([, c]) => c.pts / Math.max(1, c.weeks.size));
      if (vals.length) leagueAvg.set(pos, mean(vals));
    }
    const dvp = (defense: string, pos: Position) => {
      const c = allowed.get(`${defense}|${pos}`);
      return {
        allowed: c ? c.pts / Math.max(1, c.weeks.size) : undefined,
        leagueAvg: leagueAvg.get(pos),
        games: c?.weeks.size ?? 0,
      };
    };

    const players: WeekPlayerInput[] = weekRows.map((r) => ({
      id: r.id, pos: r.pos, team: r.team, bye: null, status: r.st, sleeper: r.proj,
    }));
    const fitted = buildWeekOutlooks({ week: wk, players, linesByTeam, dvp, scoring, params: DEFAULT_WEEKLY_MODEL });
    const off = buildWeekOutlooks({ week: wk, players, linesByTeam, dvp, scoring, params: OFF_WEEKLY_MODEL });

    for (let i = 0; i < weekRows.length; i++) {
      const r = weekRows[i];
      if (!r.act) continue; // did not play: handled by the availability fit, not by RMSE
      scored.push({
        pos: r.pos, wk, id: r.id, stats: r.act,
        actual: scoreStatLine(r.act, scoring, r.pos === "TE"),
        model: fitted[i].meanIfPlays,
        baseline: off[i].meanIfPlays,
        sigma: fitted[i].sigma,
      });
    }
  }

  // --- Gate 1: beat the baseline on RMSE and MAE, per position -------------
  for (const pos of POSITIONS) {
    const sub = scored.filter((s) => s.pos === pos);
    if (sub.length < 200) { gate(false, `${pos}: only ${sub.length} scored rows — cannot judge`); continue; }
    const mErr = sub.map((s) => s.model - s.actual);
    const bErr = sub.map((s) => s.baseline - s.actual);
    const dR = rmse(bErr) - rmse(mErr);
    const dM = mae(bErr) - mae(mErr);
    gate(
      dR >= 0 && dM >= 0,
      `${season} ${pos} beats raw Sleeper: RMSE ${rmse(mErr).toFixed(2)} vs ${rmse(bErr).toFixed(2)}, ` +
        `MAE ${mae(mErr).toFixed(2)} vs ${mae(bErr).toFixed(2)} (n=${sub.length})`
    );
  }

  // --- Gate 2: rank correlation ------------------------------------------
  for (const pos of POSITIONS) {
    const sub = scored.filter((s) => s.pos === pos);
    if (sub.length < 200) continue;
    const rM = pearson(sub.map((s) => s.model), sub.map((s) => s.actual));
    const rB = pearson(sub.map((s) => s.baseline), sub.map((s) => s.actual));
    gate(rM >= rB - 0.01, `${season} ${pos} correlation >= baseline: ${rM.toFixed(3)} vs ${rB.toFixed(3)}`);
  }

  // --- Gate 3: distribution calibration ----------------------------------
  const cov = pitCoverage(scored.map((s) => ({ actual: s.actual, mean: s.model, sigma: s.sigma })));
  gate(
    Math.abs(cov.below10 - 0.1) <= 0.04 && Math.abs(cov.above90 - 0.1) <= 0.04,
    `${season} distribution calibration: ${(cov.below10 * 100).toFixed(1)}% below p10, ` +
      `${(cov.above90 * 100).toFixed(1)}% above p90 (target 10% ± 4)`
  );

  // --- Gate 4: decision accuracy -----------------------------------------
  // Build 200 random 9-player rosters per week from the scored pool, start the
  // best lineup under each ranking, and compare realized points and
  // head-to-head wins. This is the only gate that measures the product.
  const rng = makeRng(20260909);
  const SLOTS = { QB: 1, RB: 2, WR: 3, TE: 1 } as Record<string, number>;
  let modelPts = 0, basePts = 0, modelWins = 0, baseWins = 0, ties = 0, matchups = 0;
  for (const [wk, weekRows] of byWeek) {
    void weekRows;
    const pool = scored.filter((s) => s.wk === wk);
    if (pool.length < 60) continue;
    for (let t = 0; t < 200; t++) {
      const roster: Scored[] = [];
      // 3 QB, 5 RB, 7 WR, 3 TE — a plausible bench, so there is a real choice.
      for (const [pos, n] of [["QB", 3], ["RB", 5], ["WR", 7], ["TE", 3]] as [Position, number][]) {
        const atPos = pool.filter((s) => s.pos === pos);
        for (let i = 0; i < n && atPos.length; i++) roster.push(atPos[Math.floor(rng() * atPos.length)]);
      }
      const start = (rank: (s: Scored) => number) => {
        let total = 0;
        for (const [pos, n] of Object.entries(SLOTS)) {
          const picks = roster.filter((s) => s.pos === pos).sort((a, b) => rank(b) - rank(a)).slice(0, n);
          total += picks.reduce((sum, s) => sum + s.actual, 0);
        }
        return total;
      };
      const m = start((s) => s.model);
      const b = start((s) => s.baseline);
      modelPts += m;
      basePts += b;
      matchups++;
      if (m > b) modelWins++;
      else if (b > m) baseWins++;
      else ties++;
    }
  }
  const winRate = matchups ? modelWins / matchups : 0;
  gate(
    modelPts >= basePts && modelWins >= baseWins,
    `${season} decision accuracy: model lineup ${(modelPts / matchups).toFixed(2)} pts/lineup vs ` +
      `baseline ${(basePts / matchups).toFixed(2)}; head-to-head ${modelWins}-${baseWins}-${ties} ` +
      `(${(winRate * 100).toFixed(1)}% win rate over ${matchups} lineups)`
  );

  // --- Gate 5: simulated DK bonus frequency matches history ---------------
  const historicalBonusRate = mean(scored.map((s) => (dkBonusPoints(s.stats) > 0 ? 1 : 0)));
  const simPlayers: WeekSimPlayer[] = scored.slice(0, 400).map((s, i) => ({
    id: `${i}`, pos: s.pos, team: `T${i % 32}`, gameId: `G${i % 16}`, opp: `T${(i + 1) % 32}`,
    meanIfPlays: s.model, sigma: s.sigma, pPlay: 1, stats: s.stats,
  }));
  const draws = simulateWeek(simPlayers, DEFAULT_WEEKLY_MODEL, 400, 5, { dkBonuses: true });
  const plain = simulateWeek(simPlayers, DEFAULT_WEEKLY_MODEL, 400, 5);
  let bonusHits = 0, n = 0;
  for (let s = 0; s < draws.length; s++) {
    for (let i = 0; i < simPlayers.length; i++) {
      n++;
      if (draws[s][i] - plain[s][i] > 0.5) bonusHits++;
    }
  }
  const simRate = n ? bonusHits / n : 0;
  gate(
    Math.abs(simRate - historicalBonusRate) <= 0.06,
    `${season} DK bonus frequency: simulated ${(simRate * 100).toFixed(1)}% vs ` +
      `historical ${(historicalBonusRate * 100).toFixed(1)}% (tolerance 6 pts)`
  );

  // --- write the report ---------------------------------------------------
  const header = `\n## Weekly projection model gates\n\nGenerated ${new Date().toISOString().slice(0, 10)}, holdout ${season}, fitted on ${DEFAULT_WEEKLY_MODEL.fittedOn.join(", ")}.\n\n`;
  const verdict = failures === 0
    ? "\n**RESULT: PASS — the fitted weekly model may ship as the default.**\n"
    : `\n**RESULT: FAIL (${failures} gate${failures === 1 ? "" : "s"}) — revert config/weekly-model.json to its off state and ship the model as opt-in.**\n`;
  writeFileSync(GATES, readFileSync(GATES, "utf8") + header + results.join("\n") + "\n" + verdict);
  console.log(verdict);
  process.exit(failures === 0 ? 0 : 1);
}

main();
```

- [ ] **Step 2: Add the script**

```json
"backtest:weekly": "tsx scripts/backtest-weekly.ts",
```

- [ ] **Step 3: Run the gates**

Run: `pnpm backtest:weekly -- --holdout=2025`
Expected: a PASS/FAIL line per gate appended to `docs/backtest-gates.md`, and a non-zero exit if anything failed.

- [ ] **Step 4: Act on the result — this is the decision point**

- **All gates pass**: keep the fitted `config/weekly-model.json`. Legs B and C build on a measured model.
- **Gate 1 or 4 fails**: revert `config/weekly-model.json` to its off state (`git checkout` the version from Task 1), commit it that way, and record in `docs/backtest-gates.md` what failed. The weekly boards then ship as re-scored Sleeper projections — still a real feature, since nothing in the app has weekly numbers today — and the model becomes an opt-in lever. **Do not loosen a gate to make it pass.** The unified decision model in this repo is already carried as FAIL rather than fudged; hold the same line.
- **Only gates 2, 3 or 5 fail**: these are diagnostic rather than blocking. Note them, and treat gate 3 in particular as the next thing to fix — a miscalibrated spread makes every start/sit and GPP decision downstream subtly wrong even when the means are good.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest-weekly.ts docs/backtest-gates.md config/weekly-model.json package.json
git commit -m "Weekly gates: RMSE vs Sleeper, rank correlation, PIT coverage, decision accuracy, DK bonus rate"
```

---

### Task 18: Performance budgets and documentation

**Files:**
- Create: `tests/perfWeekly.test.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the budget test**

```ts
// tests/perfWeekly.test.ts
// Latency budgets for the weekly engine, in their own file so vitest gives
// them a fresh worker — the same reason tests/perf.test.ts is separate.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildWeekOutlooks, type WeekLine, type WeekPlayerInput } from "../lib/engine/weekly/outlook";
import { simulateWeek, type WeekSimPlayer } from "../lib/engine/weekSim";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { SCORING_PRESETS } from "../lib/scoring";
import type { Board, Position } from "../lib/types";

const boardPath = join(process.cwd(), "public", "data", "board-ppr.json");
const board: Board = JSON.parse(readFileSync(boardPath, "utf8"));

const linesByTeam: Record<string, WeekLine> = {};
for (const p of board.players) {
  linesByTeam[p.team] ??= { total: 44.5, ownSpread: p.team.charCodeAt(0) % 2 ? -3 : 3, opp: "OPP" };
}
const players: WeekPlayerInput[] = board.players.map((p) => ({
  id: p.id, pos: p.pos, team: p.team, bye: p.bye, status: p.injury,
  sleeper: p.statsSleeper ?? p.stats ?? { recYds: 40, receptions: 3 },
}));
const dvp = () => ({ games: 0 });

const best = (n: number, fn: () => void) => {
  let ms = Infinity;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    ms = Math.min(ms, performance.now() - t);
  }
  return ms;
};

describe("weekly latency budgets", () => {
  it(`builds a full week of outlooks (${board.players.length} players) under 80ms`, () => {
    const ms = best(5, () =>
      buildWeekOutlooks({ week: 3, players, linesByTeam, dvp, scoring: SCORING_PRESETS.ppr, params: DEFAULT_WEEKLY_MODEL })
    );
    console.log(`outlooks: ${ms.toFixed(1)}ms for ${players.length} players`);
    expect(ms).toBeLessThan(80);
  });

  it("runs 2000 correlated sims over a 20-player set under 150ms — Leg B's budget", () => {
    const sim: WeekSimPlayer[] = players.slice(0, 20).map((p, i) => ({
      id: p.id, pos: p.pos as Position, team: p.team, gameId: `G${i % 10}`, opp: "OPP",
      meanIfPlays: 12, sigma: 0.7, pPlay: 0.97, stats: p.sleeper ?? {},
    }));
    const ms = best(3, () => simulateWeek(sim, DEFAULT_WEEKLY_MODEL, 2000, 1));
    console.log(`weekSim: ${ms.toFixed(1)}ms for 2000 sims x 20 players`);
    expect(ms).toBeLessThan(150);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/perfWeekly.test.ts`
Expected: PASS, with the timings logged. If the outlook build is over budget, the usual cause is rebuilding a lookup inside the player loop — profile before optimizing, and do not raise the budget to make it pass.

- [ ] **Step 3: Run the entire suite one final time**

Run: `pnpm test`
Expected: everything passes, including the original `tests/perf.test.ts` 50 ms draft budget. Leg A must not have cost the draft cockpit a millisecond.

- [ ] **Step 4: Document it in AGENTS.md**

Add to the project-notes list in `AGENTS.md`:

```markdown
- **Weekly engine is the in-season foundation**: `lib/engine/weekly/` turns a season projection into a per-week, per-matchup distribution (`WeekOutlook`), and `lib/engine/weekSim.ts` draws *correlated* weeks (game → team → unit → player). Both are pure and seeded. Levers live in `config/weekly-model.json`, whose committed off state reproduces raw Sleeper weekly projections re-scored with league scoring — every adjustment is measured against that, never asserted. Coefficients are fitted **on the residual against the market** (`scripts/calibrate-weekly.ts`); fitting on actual points double-counts signal Sleeper already carries. Gates live in `docs/backtest-gates.md` via `pnpm backtest:weekly`; gates 1 (beat raw Sleeper) and 4 (decision accuracy) are blocking. The `weekly` CI lane (`pnpm build:week -- --week=N`) emits `public/data/week-{season}-{week}-{format}.json`. **FantasyPros stays out of the fast and weekly lanes** — ~10 requests/day.
```

- [ ] **Step 5: Document it in README.md**

Add a section describing: what the weekly boards are, how to build one, what the gates currently say, and the explicit note that Legs B (in-season cockpit) and C (DFS) consume `WeekOutlook` and are specced at `docs/superpowers/specs/2026-09-09-in-season-cockpit-design.md` and `docs/superpowers/specs/2026-09-09-dfs-optimizer-design.md`.

- [ ] **Step 6: Commit**

```bash
git add tests/perfWeekly.test.ts AGENTS.md README.md
git commit -m "Weekly engine: latency budgets and docs"
```

---

## Self-Review

**Spec coverage** — every section of `2026-09-09-weekly-projection-engine-design.md` maps to a task:

| Spec section | Task |
|---|---|
| Core type `WeekOutlook` | 9 |
| Market ensemble | 9 (`blendMarket`), sources in 2 and 12 |
| Own usage model | 6 |
| Game environment | 4 |
| Matchup / DvP | 5 |
| Avoiding double-counting (residual fitting) | 16 |
| Availability | 8, fitted in 16 |
| Spread (volume-dependent sigma) | 7, fitted in 16 |
| Assembly | 9 |
| `config/weekly-model.json` + off state | 1, rewritten by 16 |
| Correlated sampler | 11 |
| DK threshold bonuses | 10, gated in 17 |
| ETL + `weekly` lane + fixtures | 2, 3, 12, 13 |
| Live availability via `gradeBoard` | **not covered — see below** |
| Historical snapshots | 14 |
| Calibration | 15, 16 |
| Gates 1–5 | 17 |
| Performance budgets | 18 |
| Testing (off-state, sampler, determinism, offline) | 1, 9, 11, 13 |

**One deliberate deferral.** The spec's line about live Sunday-inactive status flowing through `useLiveSignals` → `gradeBoard` onto outlooks is **not** in this plan. It belongs to Leg B: nothing in Leg A renders, so there is no consumer to grade for, and the pure grader would be written against a UI that does not exist yet. It is carried forward as the first task of the Leg B plan rather than dropped. Flagging it explicitly so it is not silently lost.

**Known gap, stated rather than hidden.** `sourceWeights` and `modelWeights` are not fitted in Task 16, because the history set carries only Sleeper projections — ESPN weekly and DK weekly snapshots only start accumulating once the `weekly` lane runs, and there is no usage backfill in the history rows. They stay at their off-state values (`sleeper: 1`, `usage: 0`), which means **the shipped model's ensemble is one source deep on day one** and the usage model built in Task 6 is wired but weighted at zero. Task 17's gate 1 measures exactly that. The first follow-up after Leg A is a second calibration pass once a few weeks of ESPN snapshots exist; that is a config change and a re-run of `calibrate:weekly`, not new code.

**Type consistency.** `WeeklyModelParams`, `WeekOutlook`, `WeekPlayerInput`, `WeekLine`, `DvpLookup`, `UsageWeek`, `UsageHistory`, `Shares`, `Efficiency`, `HistRow`, `WeekSimPlayer` and `GameLine` are each defined in exactly one task and imported by name thereafter. `unitOf` is defined in Task 1 and used in Task 11. `OFF_WEEKLY_MODEL` is introduced in Task 16 Step 4 and back-fills the earlier tests that used `DEFAULT_WEEKLY_MODEL` as a neutral stand-in — that swap is called out in Task 16 Step 5 because it touches Tasks 1, 4, 5, 7, 8 and 9's test files.

**No placeholders.** Every step carries runnable code or an exact command. The one spot where the plan asks the implementer to verify something against the codebase rather than assume it — the `resolveJsonModule` check in Task 1 Step 6 — is a check with a stated resolution, not deferred work. (`fetchPlayerIds` returns the raw CSV body; that was verified against `lib/etl/fetchers.ts:135` while writing this plan and is baked into Tasks 13 and 14.)
