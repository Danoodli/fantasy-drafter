// The best legal lineup, computed EXACTLY. Pure.
//
// lib/engine/season.ts's optimalLineupTotal is greedy: it fills dedicated
// slots then takes the top leftovers for flex. That is exact for a single flex
// and silently wrong otherwise, and start/sit is where it would bite.
//
// The exact solution is cheap because of one observation: within a position you
// always start your highest scorer, so an optimal lineup is fully determined by
// HOW MANY players each position contributes to the flex slots. There are only
// a handful of such allocations (3 for one flex over three eligible positions,
// 10 for three), so enumerating them is exhaustive over the optimum rather
// than a heuristic.
import type { LeagueConfig, Position } from "../../types";
import { simulateWeek, type WeekSimPlayer } from "../weekSim";
import type { WeeklyModelParams } from "../weekly/model";

export interface LineupPlayer {
  id: string;
  pos: Position;
  points: number;
}

export interface Lineup {
  starters: { slot: string; player: LineupPlayer }[];
  total: number;
  benched: LineupPlayer[];
}

const DEDICATED: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/** All ways to draw `n` items from `k` buckets. Compositions, not permutations. */
function allocations(k: number, n: number): number[][] {
  if (k === 0) return n === 0 ? [[]] : [];
  const out: number[][] = [];
  for (let take = 0; take <= n; take++) {
    for (const rest of allocations(k - 1, n - take)) out.push([take, ...rest]);
  }
  return out;
}

export function bestLineup(players: LineupPlayer[], config: LeagueConfig): Lineup {
  // Highest first, id as a tiebreak so the result is deterministic.
  const byPos = new Map<Position, LineupPlayer[]>();
  for (const pl of players) {
    const list = byPos.get(pl.pos) ?? [];
    list.push(pl);
    byPos.set(pl.pos, list);
  }
  for (const list of byPos.values()) {
    list.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  }

  const flexSlots = config.rosterSlots.FLEX ?? 0;
  const eligible = config.flexEligible;

  let bestStarters: { slot: string; player: LineupPlayer }[] = [];
  let bestTotal = -1;

  if (flexSlots > 0 && eligible.length > 0) {
    // Enumerate allocations: how many flex slots each eligible position contributes.
    for (const alloc of allocations(eligible.length, flexSlots)) {
      const starters: { slot: string; player: LineupPlayer }[] = [];
      let ok = true;
      let total = 0;

      // For each position, determine how many total players to use.
      const flexCandidates: LineupPlayer[] = [];
      for (const pos of DEDICATED) {
        const dedicatedSlots = config.rosterSlots[pos] ?? 0;
        const list = byPos.get(pos) ?? [];
        let flexAlloc = 0;
        if (eligible.includes(pos)) {
          flexAlloc = alloc[eligible.indexOf(pos)];
        }
        const needed = dedicatedSlots + flexAlloc;

        if (needed > list.length) {
          ok = false;
          break;
        }

        // Fill dedicated slots with best players.
        for (let i = 0; i < dedicatedSlots; i++) {
          starters.push({ slot: pos, player: list[i] });
          total += list[i].points;
        }

        // Collect flex candidates from this position.
        for (let i = dedicatedSlots; i < needed; i++) {
          flexCandidates.push(list[i]);
          total += list[i].points;
        }
      }

      if (!ok) continue;

      // Sort flex candidates and add to starters in the right order.
      flexCandidates.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
      for (let i = 0; i < Math.min(flexSlots, flexCandidates.length); i++) {
        starters.push({ slot: "FLEX", player: flexCandidates[i] });
      }

      if (total > bestTotal) {
        bestTotal = total;
        bestStarters = starters;
      }
    }
  }

  if (bestStarters.length === 0) {
    // Fallback: fill only dedicated slots.
    for (const pos of DEDICATED) {
      const n = config.rosterSlots[pos] ?? 0;
      const list = byPos.get(pos) ?? [];
      for (let i = 0; i < n && i < list.length; i++) {
        bestStarters.push({ slot: pos, player: list[i] });
      }
    }
  }

  const starters = bestStarters;

  const startedIds = new Set(starters.map((s) => s.player.id));
  const benched = players
    .filter((pl) => !startedIds.has(pl.id))
    .sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));

  return {
    starters,
    total: starters.reduce((s, x) => s + x.player.points, 0),
    benched,
  };
}

/**
 * P(the players at `mine` outscore the players at `theirs`) over `draws`,
 * where both are INDEX lists into each draw. The lineups are fixed — a lineup
 * is a decision locked before kickoff, and the question is how often that
 * locked set wins. A tie counts as half a win, as head-to-head leagues score it.
 *
 * Indices rather than players so a caller can score many candidate lineups
 * against the SAME draws (a paired comparison), which is what makes swap
 * deltas precise at a few thousand sims.
 */
export function winProbability(draws: Float64Array[], mine: number[], theirs: number[]): number {
  if (draws.length === 0) return 0.5;
  let wins = 0;
  let ties = 0;
  for (const d of draws) {
    let a = 0;
    for (const i of mine) a += d[i];
    let b = 0;
    for (const j of theirs) b += d[j];
    if (a > b) wins++;
    else if (a === b) ties++;
  }
  return (wins + ties / 2) / draws.length;
}

/**
 * Simulate one joint correlated week over BOTH lineups and compare them.
 * One draw set, not two: a shared game between one of my players and one of
 * theirs must move both at once. Splitting into two calls would silently
 * assume independence.
 */
export function matchupWinProbability(
  mine: WeekSimPlayer[],
  theirs: WeekSimPlayer[],
  p: WeeklyModelParams,
  sims: number,
  seed: number
): number {
  const draws = simulateWeek([...mine, ...theirs], p, sims, seed);
  return winProbability(
    draws,
    mine.map((_, i) => i),
    theirs.map((_, j) => mine.length + j)
  );
}
