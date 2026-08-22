// Season simulation: port of the ffsimulator idea — run a roster through
// hundreds of simulated seasons and report a distribution, not a point total.
// Weekly scores are lognormal around each player's projected weekly mean with
// position-typical volatility; the optimal lineup is computed every week
// (which is literally how best ball scores). Pure and seeded — testable.

import type { BoardPlayer, LeagueConfig, Position } from "../types";
import { makeRng } from "./montecarlo";

/**
 * Weekly volatility (lognormal sigma) by position, tuned to public analyses
 * of weekly fantasy scoring spread. WR/TE spike hardest — that's why they
 * shine in best ball.
 */
export const WEEKLY_SIGMA: Record<Position, number> = {
  QB: 0.42,
  RB: 0.62,
  WR: 0.72,
  TE: 0.78,
  K: 0.45,
  DST: 0.6,
};

const WEEKS = 17;

function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** One player's sampled score for one week (0 on bye). */
function weeklyScore(p: BoardPlayer, week: number, rng: () => number): number {
  if (p.bye === week) return 0;
  const mean = p.projPoints / (WEEKS - 1);
  if (mean <= 0) return 0;
  const sigma = WEEKLY_SIGMA[p.pos];
  // lognormal with the target mean: E[exp(N(m, s))] = exp(m + s²/2)
  return Math.exp(Math.log(mean) - (sigma * sigma) / 2 + sigma * gaussian(rng));
}

/** Optimal lineup total for one week's scores — greedy is exact for one flex. */
export function optimalLineupTotal(
  players: { pos: Position; score: number }[],
  config: LeagueConfig
): number {
  const byPos = new Map<Position, number[]>();
  for (const p of players) {
    const list = byPos.get(p.pos) ?? [];
    list.push(p.score);
    byPos.set(p.pos, list);
  }
  for (const list of byPos.values()) list.sort((a, b) => b - a);

  let total = 0;
  const used = new Map<Position, number>();
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const n = config.rosterSlots[pos] ?? 0;
    const list = byPos.get(pos) ?? [];
    for (let i = 0; i < n && i < list.length; i++) total += list[i];
    used.set(pos, Math.min(n, list.length));
  }
  // Flex: best remaining among eligible
  const flexSlots = config.rosterSlots.FLEX ?? 0;
  const leftovers: number[] = [];
  for (const pos of config.flexEligible) {
    const list = byPos.get(pos) ?? [];
    for (let i = used.get(pos) ?? 0; i < list.length; i++) leftovers.push(list[i]);
  }
  leftovers.sort((a, b) => b - a);
  for (let i = 0; i < flexSlots && i < leftovers.length; i++) total += leftovers[i];
  return total;
}

export interface SeasonSimResult {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  p99: number;
  totals: number[];
}

/** Simulate one roster across `sims` seasons. */
export function simulateSeasons(
  roster: BoardPlayer[],
  config: LeagueConfig,
  sims: number,
  seed = 1
): SeasonSimResult {
  const rng = makeRng(seed);
  const totals: number[] = [];
  for (let s = 0; s < sims; s++) {
    let season = 0;
    for (let week = 1; week <= WEEKS; week++) {
      const scores = roster.map((p) => ({ pos: p.pos, score: weeklyScore(p, week, rng) }));
      season += optimalLineupTotal(scores, config);
    }
    totals.push(season);
  }
  // Quantiles from a sorted copy; `totals` stays in simulation order so
  // simulateRoom can compare independent season s across teams.
  const sorted = [...totals].sort((a, b) => a - b);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  return {
    mean: totals.reduce((a, b) => a + b, 0) / totals.length,
    p10: q(0.1),
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    totals,
  };
}

/**
 * Simulate a whole draft room: every roster through the same seasons.
 * Returns each roster's win rate (finished #1) — the number that matters
 * in winner-take-most tournaments.
 */
export function simulateRoom(
  rosters: BoardPlayer[][],
  config: LeagueConfig,
  sims: number,
  seed = 1
): { winRate: number[]; results: SeasonSimResult[] } {
  const results = rosters.map((r, i) => simulateSeasons(r, config, sims, seed + i * 7919));
  const wins = new Array(rosters.length).fill(0);
  for (let s = 0; s < sims; s++) {
    let best = -1;
    let bestTotal = -Infinity;
    for (let t = 0; t < rosters.length; t++) {
      // totals were sorted per roster; use the s-th sample via a stable
      // pairing (independent seasons across teams is fine for win-rate).
      const total = results[t].totals[s];
      if (total > bestTotal) {
        bestTotal = total;
        best = t;
      }
    }
    if (best >= 0) wins[best]++;
  }
  return { winRate: wins.map((w) => w / sims), results };
}
