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

  // Dedicated slots first: they can only be filled by their own position.
  const used = new Map<Position, number>();
  const starters: { slot: string; player: LineupPlayer }[] = [];
  for (const pos of DEDICATED) {
    const n = config.rosterSlots[pos] ?? 0;
    const list = byPos.get(pos) ?? [];
    let taken = 0;
    for (let i = 0; i < n && i < list.length; i++) {
      starters.push({ slot: pos, player: list[i] });
      taken++;
    }
    used.set(pos, taken);
  }

  const flexSlots = config.rosterSlots.FLEX ?? 0;
  const eligible = config.flexEligible.filter((pos) => (byPos.get(pos) ?? []).length > (used.get(pos) ?? 0));

  let bestFlex: LineupPlayer[] = [];
  let bestGain = -1;
  if (flexSlots > 0 && eligible.length > 0) {
    for (const alloc of allocations(eligible.length, flexSlots)) {
      const picked: LineupPlayer[] = [];
      let ok = true;
      for (let i = 0; i < eligible.length; i++) {
        const pos = eligible[i];
        const list = byPos.get(pos) ?? [];
        const from = used.get(pos) ?? 0;
        // Cannot take more than remain at that position.
        if (from + alloc[i] > list.length) { ok = false; break; }
        for (let j = 0; j < alloc[i]; j++) picked.push(list[from + j]);
      }
      if (!ok) continue;
      const gain = picked.reduce((s, x) => s + x.points, 0);
      if (gain > bestGain) { bestGain = gain; bestFlex = picked; }
    }
  }
  for (const pl of bestFlex) starters.push({ slot: "FLEX", player: pl });

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
