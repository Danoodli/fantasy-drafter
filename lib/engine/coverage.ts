// Insurance value: what a bench player is actually worth.
//
// A bench player scores for you only in weeks when a starting slot at his
// position would otherwise be EMPTY. Two things empty a slot: byes, which are
// certain and known at draft time, and missed games, which are probabilistic.
// So his value is the expected number of slot-weeks he fills that the current
// roster leaves open, times his own scoring rate. That is position-neutral by
// construction — no replacement-level baseline, so no steep-curve RB inflation
// — and it makes the third WR on a 2-WR roster worth ~5 slot-weeks while an
// eighth RB is worth ~0.02. The 7-RB / 2-WR roster falls out of the math
// rather than being banned by a rule.
//
// Pure: no clock, no I/O.

import type { BoardPlayer, LeagueConfig, Position } from "../types";

export const REG_SEASON_WEEKS = 17;

/**
 * Expected games a starter misses per season for reasons other than the bye
 * (injury, rest, suspension). Public per-position availability figures,
 * rounded; tunable, and the season backtest is how to tune them.
 */
export const EXPECTED_MISSED_GAMES: Record<Position, number> = {
  QB: 1.5,
  RB: 3.0,
  WR: 2.4,
  TE: 2.2,
  K: 0.5,
  DST: 0,
};

/** Expected empty starting slots: E[max(0, slots − X)], X ~ Binomial(bodies, avail). */
function expectedUnfilled(bodies: number, slots: number, avail: number): number {
  if (slots <= 0) return 0;
  if (bodies <= 0) return slots;
  let pmf = [1];
  for (let i = 0; i < bodies; i++) {
    const next = new Array<number>(pmf.length + 1).fill(0);
    for (let k = 0; k < pmf.length; k++) {
      next[k] += pmf[k] * (1 - avail);
      next[k + 1] += pmf[k] * avail;
    }
    pmf = next;
  }
  let expected = 0;
  for (let k = 0; k < pmf.length && k < slots; k++) expected += pmf[k] * (slots - k);
  return expected;
}

/**
 * Slot-weeks a marginal body at `pos` (with bye week `bye`) would fill that the
 * current roster leaves empty. Only the position's own starting slots count —
 * FLEX can be filled by three positions and is rarely the binding hole, and
 * counting it would let a 6th RB claim credit for a WR problem.
 */
export function coverageSlotWeeks(
  pos: Position,
  bye: number | null,
  roster: { pos: Position; bye: number | null }[],
  config: LeagueConfig
): number {
  const slots = config.rosterSlots[pos] ?? 0;
  if (slots <= 0) return 0;
  const avail = 1 - EXPECTED_MISSED_GAMES[pos] / (REG_SEASON_WEEKS - 1);
  const mates = roster.filter((r) => r.pos === pos);
  let total = 0;
  for (let week = 1; week <= REG_SEASON_WEEKS; week++) {
    if (bye === week) continue; // he can't cover a week he's off too
    const bodies = mates.filter((r) => r.bye !== week).length;
    total += expectedUnfilled(bodies, slots, avail) - expectedUnfilled(bodies + 1, slots, avail);
  }
  return total;
}

/**
 * Insurance value in projected points: slot-weeks covered × his weekly rate
 * ABOVE `replacementPerWeek`. In redraft the alternative to a rostered backup
 * is a waiver pickup, so pass the wire's expected weekly rate at his position;
 * a TE2 who barely beats the streaming option is worth little, while a WR3 on
 * a 2-WR roster still is. Best ball has no wire — pass 0 (the default).
 */
export function coverageValue(
  candidate: BoardPlayer,
  roster: BoardPlayer[],
  config: LeagueConfig,
  replacementPerWeek = 0
): number {
  const weeks = coverageSlotWeeks(candidate.pos, candidate.bye, roster, config);
  const perWeek = Math.max(0, candidate.projPoints) / (REG_SEASON_WEEKS - 1);
  return Math.max(0, weeks * Math.max(0, perWeek - replacementPerWeek));
}

/**
 * Expected empty starting slot-weeks over a season for a finished roster —
 * the number a manager actually feels: how many times will I start nobody?
 * Used by the season backtest to make a fragile roster visible instead of
 * averaged away in a points total.
 */
export function rosterFragility(roster: { pos: Position; bye: number | null }[], config: LeagueConfig): number {
  let total = 0;
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const slots = config.rosterSlots[pos] ?? 0;
    if (slots <= 0) continue;
    const avail = 1 - EXPECTED_MISSED_GAMES[pos] / (REG_SEASON_WEEKS - 1);
    const mates = roster.filter((r) => r.pos === pos);
    for (let week = 1; week <= REG_SEASON_WEEKS; week++) {
      const bodies = mates.filter((r) => r.bye !== week).length;
      total += expectedUnfilled(bodies, slots, avail);
    }
  }
  return total;
}
