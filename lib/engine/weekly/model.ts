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
     * weight is dvpLambda^(weeksAgo). 1 is a flat mean. Must be > 0 — a
     * lambda of exactly 0 makes the weight sum 0 and every entry NaN.
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

export const DEFAULT_WEEKLY_MODEL = weeklyJson as WeeklyModelParams;

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

export function loadWeeklyModel(raw: unknown): WeeklyModelParams {
  const p = raw as WeeklyModelParams;
  if (!p || typeof p !== "object") throw new Error("weekly-model: not an object");
  assertCorrelation(p.correlation);
  const w = p.modelWeights;
  if (Math.abs(w.market + w.usage - 1) > 1e-9) {
    throw new Error(`weekly-model modelWeights must sum to 1, got ${w.market + w.usage}`);
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
