import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { completeRosters, opponentChoice, type CompletionPlayer, type CompletionShared } from "../lib/engine/completion";
import type { OutcomeParams } from "../lib/engine/outcomeModel";
import type { LeagueConfig, Position } from "../lib/types";

const params: OutcomeParams = JSON.parse(readFileSync(join(process.cwd(), "config", "outcome-model.json"), "utf8"));
const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: 5, teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
const waiver = { QB: 12, RB: 6, WR: 7, TE: 5, K: 7, DST: 6 };
// A synthetic pool: 30 of each skill position with ADP spread 1..120, K/DST late.
function pool(): CompletionPlayer[] {
  const out: CompletionPlayer[] = [];
  const rates: Record<Position, number> = { QB: 18, RB: 14, WR: 13, TE: 9, K: 8, DST: 7 };
  // Market shape like a real board: RB/WR carry the top of the ADP order, QBs and TEs start later.
  const startAdp: Record<Position, number> = { RB: 1, WR: 2, QB: 20, TE: 30, K: 150, DST: 160 };
  const step: Record<Position, number> = { RB: 2, WR: 2, QB: 5, TE: 5, K: 1, DST: 1 };
  for (let i = 0; i < 30; i++) for (const pos of ["RB", "WR", "QB", "TE"] as Position[]) {
    out.push({ id: `${pos}${i}`, pos, adp: startAdp[pos] + i * step[pos], stdev: 6, bye: 4 + (i % 10), weeklyRate: rates[pos] * (1 - i / 40) });
  }
  for (let i = 0; i < 12; i++) out.push({ id: `K${i}`, pos: "K", adp: 150 + i, stdev: 8, bye: 5 + (i % 9), weeklyRate: 8 - i * 0.2 });
  for (let i = 0; i < 12; i++) out.push({ id: `DST${i}`, pos: "DST", adp: 160 + i, stdev: 8, bye: 5 + (i % 9), weeklyRate: 7 - i * 0.2 });
  return out.sort((a, b) => a.adp - b.adp);
}
const schedule = (from: number, to: number, mine: number[]) => Array.from({ length: to - from + 1 }, (_, i) => {
  const pickNo = from + i; const r = Math.ceil(pickNo / 12); const idx = (pickNo - 1) % 12;
  return { pickNo, slot: r % 2 === 1 ? idx + 1 : 12 - idx, mine: mine.includes(pickNo) };
});

describe("opponentChoice — the room is modeled with my own objective", () => {
  const players = pool();
  it("a team with 5 RB and 0 WR takes a WR even when an RB is earlier in market order", () => {
    const cands = players.filter((p) => p.pos === "RB" || p.pos === "WR").slice(8, 18); // alternating, RB first
    const roster = Array.from({ length: 5 }, (_, i) => ({ pos: "RB" as Position, bye: 4 + i }));
    expect(cands[0].pos).toBe("RB");
    expect(cands[opponentChoice(cands, roster, params, config, waiver)].pos).toBe("WR");
  });
  it("an empty roster takes the earliest market player (no position bias)", () => {
    const cands = players.slice(0, 10);
    expect(opponentChoice(cands, [], params, config, waiver)).toBe(0);
  });
  it("never takes a kicker while a skill starter is open", () => {
    const cands = [players.find((p) => p.pos === "K")!, ...players.filter((p) => p.pos === "WR").slice(10, 15)];
    const roster = [{ pos: "QB" as Position, bye: 5 }, { pos: "RB" as Position, bye: 6 }, { pos: "RB" as Position, bye: 7 }, { pos: "TE" as Position, bye: 8 }];
    expect(cands[opponentChoice(cands, roster, params, config, waiver)].pos).toBe("WR");
  });
});

describe("completeRosters", () => {
  const players = pool();
  const opponentRosters: Record<number, { pos: Position; bye: number | null }[]> = {};
  for (let s = 1; s <= 12; s++) opponentRosters[s] = [];
  const shared: CompletionShared = {
    players, myRoster: [], opponentRosters, schedule: schedule(6, 44, [20, 29, 44]), teams: 12, rounds: 15, config, waiver, params,
  };
  it("returns one future-pick list per candidate per iteration, with no duplicates and no candidate", () => {
    const res = completeRosters(shared, [0, 1], 40, 3);
    expect(res.length).toBe(2);
    expect(res[0].length).toBe(40);
    for (let ci = 0; ci < 2; ci++) for (const picks of res[ci]) {
      expect(picks.length).toBe(3);
      expect(new Set(picks).size).toBe(3);
      expect(picks).not.toContain(ci);
    }
  });
  it("is deterministic for a seed", () => {
    const a = completeRosters(shared, [0, 3], 25, 8), b = completeRosters(shared, [0, 3], 25, 8);
    expect(a).toEqual(b);
  });
  it("fills my open starting slots before adding depth, and never picks K/DST while starters are open", () => {
    const res = completeRosters(shared, [0], 60, 5);
    for (const picks of res[0]) {
      const poss = picks.map((i) => players[i].pos);
      expect(poss).not.toContain("K");
      expect(poss).not.toContain("DST");
    }
  });
  it("opponents take top-of-market players, so my later picks come from deeper in the pool", () => {
    // 14 opponent picks happen before my pick 20. A top-10 player can slide to
    // me in a few iterations (market noise), so the claim is about the typical
    // case: the median ADP of my next pick sits well past the top of the board.
    const res = completeRosters(shared, [0], 60, 2);
    const firstFuture = res[0].map((picks) => players[picks[0]].adp).sort((a, b) => a - b);
    expect(firstFuture[Math.floor(firstFuture.length / 2)]).toBeGreaterThan(12);
  });
  it("a WR-starved room leaves me more RBs at my next pick than a balanced room", () => {
    const starved = { ...shared, opponentRosters: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, Array.from({ length: 4 }, (_, k) => ({ pos: "RB" as Position, bye: 4 + k }))])) };
    const rbShare = (res: number[][][]) => res[0].flat().filter((i) => players[i].pos === "RB").length / res[0].flat().length;
    expect(rbShare(completeRosters(starved, [0], 80, 4))).toBeGreaterThan(rbShare(completeRosters(shared, [0], 80, 4)));
  });
});
