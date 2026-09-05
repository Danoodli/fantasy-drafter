// Full-room draft replay for backtesting: ADP-following bots in every seat,
// with the engine optionally sitting in one of them.
//
// Pure and seeded. The bots sample each player's "effective draft position"
// ONCE per room (adp + stdev·gaussian — the same room model the Monte Carlo
// uses) and always take the lowest available. Because that sample depends only
// on the seed, a room with the engine in slot s and the same room with a bot in
// slot s are identical until the engine's first pick — which is what makes the
// engine-vs-bot comparison a fair paired test rather than two random drafts.

import type { BoardPlayer, LeagueConfig, Position, Strategy } from "../types";
import { makeRng } from "./montecarlo";
import { recommend } from "./recommend";
import { pickOwner, picksForSlot } from "../draft/snake";

export interface ReplayOptions {
  board: BoardPlayer[];
  config: LeagueConfig;
  strategy: Strategy;
  /** 1-indexed slot the engine drafts from; null = every seat is a bot. */
  engineSlot: number | null;
  seed: number;
}

export interface ReplayPick {
  pickNo: number;
  slot: number;
  playerId: string;
  byEngine: boolean;
}

export interface ReplayResult {
  /** rosters[slot - 1] */
  rosters: BoardPlayer[][];
  picks: ReplayPick[];
}

const STARTERS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Roster-count ceilings a sane human drafter respects, scaled to draft length. */
function botCaps(config: LeagueConfig): Record<Position, number> {
  const bestball = config.leagueType === "bestball";
  const heavy = Math.ceil(config.rounds * 0.45);
  return {
    QB: bestball ? 3 : Math.max(2, config.rosterSlots.QB),
    RB: heavy,
    WR: heavy,
    TE: bestball ? 3 : 2,
    K: config.rosterSlots.K ?? 0,
    DST: config.rosterSlots.DST ?? 0,
  };
}

export function replayRoom(opts: ReplayOptions): ReplayResult {
  const { board, config, strategy, engineSlot, seed } = opts;
  const { teams, rounds } = config;
  const rng = makeRng(seed);

  // One effective-position sample per player per room — shared by every seat.
  const ordered = board
    .map((p) => ({ p, eff: p.adp + p.adpStdev * gaussian(rng) }))
    .sort((a, b) => a.eff - b.eff)
    .map((x) => x.p);

  const caps = botCaps(config);
  const drafted = new Set<string>();
  const rosters: BoardPlayer[][] = Array.from({ length: teams }, () => []);
  const counts: Partial<Record<Position, number>>[] = Array.from({ length: teams }, () => ({}));
  const picks: ReplayPick[] = [];
  const enginePicks = engineSlot ? picksForSlot(engineSlot, teams, rounds, []) : [];

  const take = (slot: number, player: BoardPlayer, pickNo: number, byEngine: boolean) => {
    drafted.add(player.id);
    rosters[slot - 1].push(player);
    counts[slot - 1][player.pos] = (counts[slot - 1][player.pos] ?? 0) + 1;
    picks.push({ pickNo, slot, playerId: player.id, byEngine });
  };

  /** Unfilled required starter slots for a seat. */
  const unmet = (slot: number): Position[] => {
    const need: Position[] = [];
    for (const pos of STARTERS) {
      const short = (config.rosterSlots[pos] ?? 0) - (counts[slot - 1][pos] ?? 0);
      for (let i = 0; i < short; i++) need.push(pos);
    }
    return need;
  };

  const botPick = (slot: number, pickNo: number, round: number): BoardPlayer | undefined => {
    const picksLeft = rounds - round + 1;
    const need = unmet(slot);
    const mustFill = need.length >= picksLeft;
    const lateRounds = round > rounds - 2;
    const c = counts[slot - 1];
    return ordered.find((p) => {
      if (drafted.has(p.id)) return false;
      if ((c[p.pos] ?? 0) >= caps[p.pos]) return false;
      if (mustFill) return need.includes(p.pos);
      // Nobody takes a kicker in round 4 — K/DST wait for the final two rounds.
      if ((p.pos === "K" || p.pos === "DST") && !lateRounds) return false;
      return true;
    });
  };

  const total = teams * rounds;
  for (let pickNo = 1; pickNo <= total; pickNo++) {
    const slot = pickOwner(pickNo, teams, []);
    const round = Math.ceil(pickNo / teams);

    if (engineSlot && slot === engineSlot) {
      const opponentCounts: Record<number, Partial<Record<Position, number>>> = {};
      counts.forEach((c, i) => {
        if (i + 1 !== engineSlot) opponentCounts[i + 1] = c;
      });
      const out = recommend(
        {
          board,
          draftedIds: drafted,
          myRoster: rosters[slot - 1],
          currentPick: pickNo,
          myPicks: enginePicks.filter((n) => n >= pickNo),
          config: { ...config, myDraftSlot: engineSlot },
          strategy,
          drift: {},
          opponentCounts,
        },
        seed + pickNo
      );
      // If the engine has nothing to say (pool exhausted) it drafts like a bot
      // rather than forfeiting the pick — that gap is a pool bug, not a strategy.
      const choice = out.recommendations[0]?.player ?? botPick(slot, pickNo, round);
      if (choice) take(slot, choice, pickNo, true);
      continue;
    }

    const choice = botPick(slot, pickNo, round) ?? ordered.find((p) => !drafted.has(p.id));
    if (choice) take(slot, choice, pickNo, false);
  }

  return { rosters, picks };
}
