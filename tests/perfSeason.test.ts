// Latency budgets for the in-season engine, in their own file so vitest gives
// them a fresh worker — the same reason tests/perf.test.ts is separate.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startSitAdvice } from "../lib/engine/season/advice";
import { waiverAdds } from "../lib/engine/season/waivers";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import type { Board, LeagueConfig, WeekBoard } from "../lib/types";

const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
const weekBoard: WeekBoard = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "week-2026-1-ppr.json"), "utf8"));
const outlooks = new Map(weekBoard.outlooks.map((o) => [o.playerId, o] as const));

const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

// A realistic 15-man roster and a 9-man opponent, dealt from the board by ADP.
const byAdp = [...board.players].filter((p) => outlooks.get(p.id)?.projected).sort((a, b) => a.adp - b.adp);
const take = (n: number, from: number) => byAdp.slice(from, from + n);
const mine = take(15, 0);
const theirs = take(9, 40);
const ap = (p: (typeof mine)[number]) => ({ id: p.id, pos: p.pos, team: p.team, name: p.name, outlook: outlooks.get(p.id)! });

const best = (n: number, fn: () => void) => {
  let ms = Infinity;
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); ms = Math.min(ms, performance.now() - t); }
  return ms;
};

describe("in-season latency budgets", () => {
  it("startSitAdvice for a 15-man roster at 2000 sims runs under 150ms — the spec's budget", () => {
    const input = { players: mine.map(ap), opponent: { kind: "roster" as const, players: theirs.map(ap) }, config, params: DEFAULT_WEEKLY_MODEL, sims: 2000, seed: 1 };
    startSitAdvice(input); // JIT warmup
    const ms = best(5, () => startSitAdvice(input));
    console.log(`startSitAdvice: ${ms.toFixed(1)}ms (15 vs 9, 2000 sims)`);
    expect(ms).toBeLessThan(150);
  });

  it("waiverAdds over the whole board for 8 remaining weeks runs under 500ms", () => {
    const available = board.players.filter((p) => !mine.some((m) => m.id === p.id));
    const weeks = [10, 11, 12, 13, 14, 15, 16, 17];
    const ms = best(3, () => waiverAdds({ roster: mine, available, weeks, config, outlooks, currentWeek: 10 }));
    console.log(`waiverAdds: ${ms.toFixed(1)}ms (${available.length} available, 8 weeks)`);
    expect(ms).toBeLessThan(500);
  });
});
