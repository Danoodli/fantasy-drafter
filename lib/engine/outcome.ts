// Player-season outcome model. Pure and seeded.
//
// A season is: a skill draw (how good was the projection, per game played), an
// availability draw (season-wrecking event, or per-game misses), then weekly
// points that are lognormal around the per-game rate and share a team-week
// factor with the player's QB/receivers. Byes are exact. Parameters come from
// config/outcome-model.json, fitted by scripts/calibrate-outcomes.ts.

import type { BoardPlayer, Position } from "../types";
import { STATUS_MISS_PROB, type OutcomeParams } from "./outcomeModel";

/** Box–Muller, one value per call. */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Positions whose weekly points move with their team's passing game. */
const CORRELATED: ReadonlySet<Position> = new Set(["QB", "WR", "TE"]);

/** Games a season-ended player gets in: U{0..8}, mean 4. */
const ENDED_GAMES_MEAN = 4;

/**
 * One N(0,1) shock per team-week, drawn lazily and cached, so a QB and his
 * receivers sampled in the same iteration share it. Create one per iteration.
 */
export function makeTeamShocks(rng: () => number, weeks: number): (team: string, week: number) => number {
  const cache = new Map<string, Float64Array>();
  return (team, week) => {
    let arr = cache.get(team);
    if (!arr) {
      arr = new Float64Array(weeks + 1);
      for (let w = 1; w <= weeks; w++) arr[w] = gaussian(rng);
      cache.set(team, arr);
    }
    return arr[week];
  };
}

/** Expected points per PLAYED game: projection × per-game position bias × lognormal mean correction. */
export function healthyRate(p: BoardPlayer, params: OutcomeParams, projOverride?: number): number {
  const pp = params.byPos[p.pos];
  const proj = Math.max(0, projOverride ?? p.projPoints);
  return (proj * pp.projMedianRatio * Math.exp((pp.projLogSigma * pp.projLogSigma) / 2)) / params.gamesPerSeason;
}

/** P(plays a given non-bye week): season-wrecking mixture + per-game misses + draft-day status. */
export function availability(p: BoardPlayer, params: OutcomeParams): number {
  const pp = params.byPos[p.pos];
  const miss = Math.min(0.95, pp.healthyMissProb + (p.injury ? STATUS_MISS_PROB[p.injury] ?? 0 : 0));
  return (1 - pp.seasonEndingProb) * (1 - miss) + pp.seasonEndingProb * (ENDED_GAMES_MEAN / params.gamesPerSeason);
}

/** Expected points in a given non-bye week. */
export function expectedWeekly(p: BoardPlayer, params: OutcomeParams, projOverride?: number): number {
  return healthyRate(p, params, projOverride) * availability(p, params);
}

export interface SeasonDraw {
  /** index 0 = week 1 */
  weekly: Float64Array;
  total: number;
}

export function sampleSeason(
  p: BoardPlayer,
  params: OutcomeParams,
  rng: () => number,
  shocks: (team: string, week: number) => number,
  projOverride?: number
): SeasonDraw {
  const pp = params.byPos[p.pos];
  const weekly = new Float64Array(params.weeks);
  // Skill: how good the projection was for this player-season, per game.
  const ratio = pp.projMedianRatio * Math.exp(pp.projLogSigma * gaussian(rng));
  const rate = (Math.max(0, projOverride ?? p.projPoints) * ratio) / params.gamesPerSeason;
  if (rate <= 0) return { weekly, total: 0 };
  // Availability.
  const ended = rng() < pp.seasonEndingProb;
  const gamesBeforeEnd = Math.floor(rng() * 9); // 0..8
  const miss = Math.min(0.95, pp.healthyMissProb + (p.injury ? STATUS_MISS_PROB[p.injury] ?? 0 : 0));
  const rho = CORRELATED.has(p.pos) ? params.teamCorrelation : 0;
  const wOwn = Math.sqrt(1 - rho);
  const wTeam = Math.sqrt(rho);
  const sigma = pp.weeklyLogSigma;
  const logMean = Math.log(rate) - (sigma * sigma) / 2;
  let played = 0;
  let total = 0;
  for (let week = 1; week <= params.weeks; week++) {
    if (p.bye === week) continue;
    if (ended && played >= gamesBeforeEnd) break;
    if (!ended && rng() < miss) continue;
    const z = wOwn * gaussian(rng) + (wTeam ? wTeam * shocks(p.team, week) : 0);
    const pts = Math.exp(logMean + sigma * z);
    weekly[week - 1] = pts;
    total += pts;
    played++;
  }
  return { weekly, total };
}
