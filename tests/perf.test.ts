// Latency budget test, isolated in its own file so it gets a fresh vitest
// worker — the engine suite's GC pressure was adding 5x noise to timings.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recommend } from "../lib/engine/recommend";
import type { Board, EngineState, LeagueConfig, Strategy } from "../lib/types";

const board: Board = JSON.parse(
  readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8")
);
const strategies: Strategy[] = JSON.parse(
  readFileSync(join(process.cwd(), "config", "strategies.json"), "utf8")
);

const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: 5,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

describe("latency budget", () => {
  it("full recompute is under 50ms (best of 5)", () => {
    const state: EngineState = {
      board: board.players, draftedIds: new Set(), myRoster: [],
      currentPick: 5,
      myPicks: [5, 20, 29, 44, 53, 68, 77, 92, 101, 116, 125, 140, 149, 164, 173],
      config, strategy: strategies[0], drift: {},
    };
    for (let i = 0; i < 3; i++) recommend(state); // JIT warmup
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      recommend(state);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(50);
  });

  it("unified model full recompute is under 50ms (best of 5)", () => {
    const unified = { ...strategies[0], valueModel: "unified" as const };
    const state: EngineState = {
      board: board.players, draftedIds: new Set(), myRoster: [], currentPick: 5,
      myPicks: [5, 20, 29, 44, 53, 68, 77, 92, 101, 116, 125, 140, 149, 164, 173],
      config, strategy: unified, drift: {},
    };
    for (let i = 0; i < 3; i++) recommend(state);
    let best = Infinity;
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); recommend(state); best = Math.min(best, performance.now() - t0); }
    console.log(`unified recompute best-of-5: ${best.toFixed(1)}ms`);
    expect(best).toBeLessThan(50);
  });

  it("unified model stays under 50ms in round 12 too (best of 5)", () => {
    const unified = { ...strategies[0], valueModel: "unified" as const };
    const byAdp = [...board.players].sort((a, b) => a.adp - b.adp);
    const mine = byAdp.filter((p) => ["RB", "WR", "QB", "TE"].includes(p.pos)).filter((_, i) => i % 11 === 0).slice(0, 11);
    const drafted = new Set(byAdp.slice(0, 135).map((p) => p.id));
    for (const p of mine) drafted.add(p.id);
    const state: EngineState = {
      board: board.players, draftedIds: drafted, myRoster: mine, currentPick: 140,
      myPicks: [140, 149, 164, 173], config, strategy: unified, drift: {},
    };
    for (let i = 0; i < 3; i++) recommend(state);
    let best = Infinity;
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); recommend(state); best = Math.min(best, performance.now() - t0); }
    console.log(`unified round-12 recompute best-of-5: ${best.toFixed(1)}ms`);
    expect(best).toBeLessThan(50);
  });
});
