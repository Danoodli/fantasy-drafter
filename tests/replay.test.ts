import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayRoom } from "../lib/engine/replay";
import type { Board, LeagueConfig, Strategy } from "../lib/types";

const board: Board = JSON.parse(
  readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8")
);
const strategies: Strategy[] = JSON.parse(
  readFileSync(join(process.cwd(), "config", "strategies.json"), "utf8")
);
const balanced = strategies.find((s) => s.id === "balanced")!;

const redraft: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: 5, teams: 12, rounds: 15,
  scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
const bestball: LeagueConfig = {
  ...redraft, rounds: 20, leagueType: "bestball",
  rosterSlots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, K: 0, DST: 0 },
};

describe("replayRoom", () => {
  it("is deterministic for a given seed", () => {
    const a = replayRoom({ board: board.players, config: redraft, strategy: balanced, engineSlot: 5, seed: 7 });
    const b = replayRoom({ board: board.players, config: redraft, strategy: balanced, engineSlot: 5, seed: 7 });
    expect(a.picks.map((p) => p.playerId)).toEqual(b.picks.map((p) => p.playerId));
  });

  it("fills every roster with exactly `rounds` distinct players", () => {
    const { rosters, picks } = replayRoom({ board: board.players, config: redraft, strategy: balanced, engineSlot: 1, seed: 1 });
    expect(rosters).toHaveLength(12);
    for (const r of rosters) expect(r).toHaveLength(15);
    const ids = picks.map((p) => p.playerId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(picks).toHaveLength(12 * 15);
  });

  it("flags exactly the engine's picks and puts them on the engine's roster", () => {
    const { rosters, picks } = replayRoom({ board: board.players, config: redraft, strategy: balanced, engineSlot: 8, seed: 3 });
    const mine = picks.filter((p) => p.byEngine);
    expect(mine).toHaveLength(15);
    expect(mine.every((p) => p.slot === 8)).toBe(true);
    expect(rosters[7].map((p) => p.id)).toEqual(mine.map((p) => p.playerId));
  });

  it("bots never draft K/DST in a best-ball room", () => {
    const { picks } = replayRoom({ board: board.players, config: bestball, strategy: balanced, engineSlot: null, seed: 11 });
    const byId = new Map(board.players.map((p) => [p.id, p]));
    expect(picks.some((p) => ["K", "DST"].includes(byId.get(p.playerId)!.pos))).toBe(false);
    expect(picks).toHaveLength(12 * 20);
  });

  it("bots end a redraft with a legal starting lineup", () => {
    const { rosters } = replayRoom({ board: board.players, config: redraft, strategy: balanced, engineSlot: null, seed: 5 });
    for (const r of rosters) {
      const n = (pos: string) => r.filter((p) => p.pos === pos).length;
      expect(n("QB")).toBeGreaterThanOrEqual(1);
      expect(n("RB")).toBeGreaterThanOrEqual(2);
      expect(n("WR")).toBeGreaterThanOrEqual(2);
      expect(n("TE")).toBeGreaterThanOrEqual(1);
      expect(n("K")).toBeGreaterThanOrEqual(1);
      expect(n("DST")).toBeGreaterThanOrEqual(1);
    }
  });

  it("the all-bot baseline shares the room's picks until the engine first deviates", () => {
    const withEngine = replayRoom({ board: board.players, config: redraft, strategy: balanced, engineSlot: 6, seed: 9 });
    const baseline = replayRoom({ board: board.players, config: redraft, strategy: balanced, engineSlot: null, seed: 9 });
    // Picks 1-5 belong to bots in both rooms and must be identical — the
    // paired comparison is only fair if the room is the same room.
    for (let i = 0; i < 5; i++) expect(withEngine.picks[i].playerId).toBe(baseline.picks[i].playerId);
  });
});
