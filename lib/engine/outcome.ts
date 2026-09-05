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

/** Smoothing half-window (players on either side in ADP order, same position). */
export const LOCAL_MEAN_WINDOW = 7;

/**
 * A player's prior: the mean projection of his ADP neighbors at his position.
 * The market's order tells you roughly what a player is; his own projection is
 * a noisy refinement of that. Shrinking toward a position-wide mean instead
 * would pull a barely-rostered QB projected for 97 points up to 210.
 */
export function localMeanProjection(players: BoardPlayer[], window = LOCAL_MEAN_WINDOW): Map<string, number> {
  const byPos = new Map<Position, BoardPlayer[]>();
  for (const p of players) {
    const list = byPos.get(p.pos) ?? [];
    list.push(p);
    byPos.set(p.pos, list);
  }
  const mu = new Map<string, number>();
  for (const list of byPos.values()) {
    const sorted = [...list].sort((a, b) => a.adp - b.adp);
    for (let i = 0; i < sorted.length; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - window); j <= Math.min(sorted.length - 1, i + window); j++) { s += sorted[j].projPoints; n++; }
      mu.set(sorted[i].id, s / n);
    }
  }
  return mu;
}

/**
 * Regression to the mean: a projection is shrunk toward its ADP-neighborhood
 * mean by (1 − reliability). Where projections carry no ordering skill (DST,
 * nearly K) every player collapses to his neighborhood; where they are strong
 * most of the spread survives. Same transform the calibration fitted its ratios on.
 */
export function reliabilityShrunkProjection(board: BoardPlayer[], params: OutcomeParams): (p: BoardPlayer) => number {
  const mu = localMeanProjection(board);
  return (p) => {
    const m = mu.get(p.id);
    if (m == null) return p.projPoints;
    const r = params.byPos[p.pos].projReliability;
    return m + r * (p.projPoints - m);
  };
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
