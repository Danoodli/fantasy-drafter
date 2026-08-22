// Replacement baselines, VORP and VOLS — derived from league settings,
// never hardcoded. Pure functions.

import type { LeagueConfig, Position } from "../types";

/**
 * How flex slots distribute across eligible positions, by historical flex
 * usage. Tunable — not a magic number buried in a function.
 */
export const FLEX_SHARE: Partial<Record<Position, number>> = {
  RB: 0.45,
  WR: 0.45,
  TE: 0.1,
};

/**
 * How bench slots distribute across positions in a typical draft.
 * Used to push the VORP baseline past the last starter.
 */
export const BENCH_SHARE: Partial<Record<Position, number>> = {
  QB: 0.15,
  RB: 0.35,
  WR: 0.35,
  TE: 0.15,
};

/** Rank of the last starter at a position, league-wide (VOLS baseline). */
export function lastStarterRank(pos: Position, config: LeagueConfig): number {
  const starters = config.rosterSlots[pos] ?? 0;
  const flexEligible = config.flexEligible.includes(pos);
  const flexShare = flexEligible ? FLEX_SHARE[pos] ?? 0 : 0;
  const flexSlots = config.rosterSlots.FLEX ?? 0;
  return Math.max(1, Math.round(config.teams * (starters + flexSlots * flexShare)));
}

/** Rank of the replacement-level player (VORP baseline: starters + bench depth). */
export function replacementRank(pos: Position, config: LeagueConfig): number {
  const totalStarters = Object.entries(config.rosterSlots).reduce((a, [, n]) => a + n, 0);
  const benchSlots = Math.max(0, config.rounds - totalStarters);
  const benchDepth = config.teams * benchSlots * (BENCH_SHARE[pos] ?? 0);
  return Math.max(1, Math.round(lastStarterRank(pos, config) + benchDepth));
}

/**
 * Compute VORP and VOLS for every player from their projected points.
 * Input: map of position → points sorted DESC. Returns baseline points.
 */
export function baselines(
  byPos: Map<Position, number[]>,
  config: LeagueConfig
): Map<Position, { vols: number; vorp: number }> {
  const out = new Map<Position, { vols: number; vorp: number }>();
  for (const [pos, points] of byPos) {
    const at = (rank: number) => points[Math.min(points.length - 1, rank - 1)] ?? 0;
    out.set(pos, {
      vols: at(lastStarterRank(pos, config)),
      vorp: at(replacementRank(pos, config)),
    });
  }
  return out;
}
