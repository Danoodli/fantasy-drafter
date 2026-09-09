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
