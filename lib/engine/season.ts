// Season simulation: run a roster through hundreds of simulated seasons and
// report a distribution, not a point total. Player-seasons come from the
// calibrated outcome model (lib/engine/outcome.ts); the optimal lineup is
// computed every week (which is literally how best ball scores). Pure and
// seeded — testable.

import type { BoardPlayer, LeagueConfig, Position } from "../types";
import { makeRng } from "./montecarlo";
import { sampleSeason, makeTeamShocks } from "./outcome";
import outcomeJson from "../../config/outcome-model.json";
import type { OutcomeParams } from "./outcomeModel";

const DEFAULT_OUTCOME = outcomeJson as OutcomeParams;


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

/**
 * Simulate one roster across `sims` seasons — with the same outcome model the
 * draft engine optimizes (skill error, availability incl. season-ending events,
 * weekly variance, team correlation, exact byes). One model, everywhere.
 */
export function simulateSeasons(
  roster: BoardPlayer[],
  config: LeagueConfig,
  sims: number,
  seed = 1,
  params: OutcomeParams = DEFAULT_OUTCOME
): SeasonSimResult {
  const totals: number[] = [];
  for (let s = 0; s < sims; s++) {
    const rng = makeRng((seed * 7919 + s * 104729) >>> 0);
    const shocks = makeTeamShocks(rng, params.weeks);
    const draws = roster.map((p) => sampleSeason(p, params, rng, shocks));
    let season = 0;
    for (let w = 0; w < params.weeks; w++) {
      season += optimalLineupTotal(roster.map((p, i) => ({ pos: p.pos, score: draws[i].weekly[w] })), config);
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
