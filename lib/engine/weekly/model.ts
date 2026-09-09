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
  availability: { byStatus: Record<string, number>; healthy?: number };
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
  if (p.availability?.healthy !== undefined) {
    assertRange("availability.healthy", p.availability.healthy, 0, 1);
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
