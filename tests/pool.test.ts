// Pool-depth guard. FFC's ADP feed only aggregates 12-team/15-round mocks
// (180 picks, deepest skill ADP ~186), so a board built from FFC alone runs
// dry in round 19 of a 20-round best ball draft. These tests fail if the
// deep-pool append in scripts/build-board.ts ever stops working.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recommend } from "../lib/engine/recommend";
import { picksForSlot } from "../lib/draft/snake";
import type { Board, BoardPlayer, EngineState, LeagueConfig, Strategy } from "../lib/types";

const FORMATS = ["ppr", "half-ppr", "standard", "2qb"] as const;
const load = (f: string): Board =>
  JSON.parse(readFileSync(join(process.cwd(), "public", "data", `board-${f}.json`), "utf8"));
const strategies: Strategy[] = JSON.parse(
  readFileSync(join(process.cwd(), "config", "strategies.json"), "utf8")
);

// DraftKings-style best ball: the deepest mainstream format, and the one that
// exposed the shortfall — 240 picks, no K/DST to pad the late rounds.
const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: 5,
  teams: 12, rounds: 20, scoring: "ppr", leagueType: "bestball",
  rosterSlots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
const INJURY_EXCLUDE = new Set(["IR", "PUP", "Sus", "NA", "COV", "DNR"]);
const draftable = (players: BoardPlayer[]) =>
  players.filter(
    (p) => p.pos !== "K" && p.pos !== "DST" && !(p.injury && INJURY_EXCLUDE.has(p.injury))
  );

describe("pool depth", () => {
  it.each(FORMATS)("%s has enough skill players for a 12x20 best ball", (fmt) => {
    expect(draftable(load(fmt).players).length).toBeGreaterThanOrEqual(config.teams * config.rounds);
  });

  it("recommends a player at every pick of a full 12x20 best ball", () => {
    const board = load("ppr");
    const myPicks = picksForSlot(5, config.teams, config.rounds);
    const drafted = new Set<string>();
    const pool = draftable(board.players).sort((a, b) => a.adp - b.adp);
    const myRoster: BoardPlayer[] = [];
    let cursor = 0;

    for (let pick = 1; pick <= config.teams * config.rounds; pick++) {
      if (myPicks.includes(pick)) {
        const state: EngineState = {
          board: board.players, draftedIds: drafted, myRoster,
          currentPick: pick, myPicks, config,
          strategy: strategies.find((s) => s.id === "balanced")!, drift: {},
        };
        const out = recommend(state);
        expect(out.recommendations.length, `no recommendation at pick ${pick}`).toBeGreaterThan(0);
        myRoster.push(out.recommendations[0].player);
        drafted.add(out.recommendations[0].player.id);
        continue;
      }
      while (cursor < pool.length && drafted.has(pool[cursor].id)) cursor++;
      if (cursor < pool.length) drafted.add(pool[cursor].id);
    }
    expect(myRoster.length).toBe(config.rounds);
  });

  it("leaves the FFC-sourced top of the board untouched", () => {
    for (const fmt of FORMATS) {
      const players = load(fmt).players;
      const deep = players.filter((p) => p.deepPool);
      const ffc = players.filter((p) => !p.deepPool);
      expect(deep.length).toBeGreaterThan(0);
      // Every appended player sits strictly past FFC's deepest skill ADP.
      const ffcTail = Math.max(
        ...ffc.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos)).map((p) => p.adp)
      );
      for (const p of deep) expect(p.adp).toBeGreaterThan(ffcTail);
      // Deep-pool players are Sleeper-sourced and never claim an FFC ADP.
      for (const p of deep) expect(p.adpSources?.ffc ?? null).toBeNull();
    }
  });
});
