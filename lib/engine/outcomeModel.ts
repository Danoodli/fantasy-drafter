// Parameters of the player-season outcome model. Fitted from committed season
// snapshots by scripts/calibrate-outcomes.ts, never hand-tuned. The engine
// imports the JSON as data; tests inject their own.
import type { Position } from "../types";

export interface PosOutcome {
  /** P(a drafted player's season effectively ends: <= 8 games). */
  seasonEndingProb: number;
  /** Per-game miss probability for everyone else (injury, rest, suspension). */
  healthyMissProb: number;
  /** sd of log(actual / projected) for players who played >= 12 games. */
  projLogSigma: number;
  /** median actual / projected for those players (projection bias). */
  projMedianRatio: number;
  /** lognormal sigma of a player's weekly points around his rate. */
  weeklyLogSigma: number;
}

export interface OutcomeParams {
  fittedOn: number[];
  weeks: number; // 17
  gamesPerSeason: number; // 16
  byPos: Record<Position, PosOutcome>;
  /** Weekly correlation between a QB and his own WR/TE (stacking). */
  teamCorrelation: number;
  /** Weight of ADP-implied value when shrinking a projection toward the market. */
  marketWeight: number;
}

/** Draft-day status adds to the per-game miss probability. IR/PUP/Sus are excluded upstream. */
export const STATUS_MISS_PROB: Record<string, number> = { Questionable: 0.05, Doubtful: 0.15, Out: 0.3 };

/** K/DST have no skill projections worth fitting; conservative defaults. */
export const DEFAULT_KDST: PosOutcome = {
  seasonEndingProb: 0.05,
  healthyMissProb: 0.03,
  projLogSigma: 0.25,
  projMedianRatio: 1,
  weeklyLogSigma: 0.5,
};

/** Positions the model actually plays weekly points for. */
export const OUTCOME_POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];
