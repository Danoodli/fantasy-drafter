import { describe, it, expect } from "vitest";
import { startSitAdvice, toSimPlayer, type AdviceInput } from "../lib/engine/season/advice";
import { DEFAULT_SEASON_LEVERS } from "../lib/engine/season/levers";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";
import type { LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 0, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

const ol = (mean: number, over: Partial<WeekOutlook> = {}): WeekOutlook => ({
  playerId: "x", week: 3, opp: "CHI", meanIfPlays: mean, mean, sigma: 0.6,
  p10: mean * 0.4, p50: mean * 0.85, p90: mean * 1.8, pPlay: 1, projected: true,
  stats: {}, drivers: { baseMarket: mean, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: null },
  ...over,
});

// Distinct team per player so draws are independent and the fixtures are checkable.
const me = (id: string, pos: Position, mean: number, over: Partial<WeekOutlook> = {}) =>
  ({ id, pos, team: id.toUpperCase(), name: id, outlook: ol(mean, { playerId: id, opp: "OPP", ...over }) });

const them = (id: string, pos: Position, mean: number) =>
  ({ id, pos, team: id.toUpperCase(), outlook: ol(mean, { playerId: id, opp: "OPP" }) });

const input = (over: Partial<AdviceInput> = {}): AdviceInput => ({
  players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wr", "WR", 11), me("bench", "WR", 10)],
  opponent: { kind: "roster", players: [them("oqb", "QB", 18), them("orb", "RB", 12), them("owr", "WR", 11)] },
  config: cfg, params: DEFAULT_WEEKLY_MODEL, sims: 2000, seed: 5, ...over,
});

describe("startSitAdvice", () => {
  it("reports a win probability, the current lineup and a total summary", () => {
    const a = startSitAdvice(input());
    expect(a.winProbability).toBeGreaterThan(0);
    expect(a.winProbability).toBeLessThan(1);
    expect(a.lineup.starters.map((s) => s.player.id).sort()).toEqual(["qb", "rb", "wr"]);
    expect(a.myTotal.p10).toBeLessThan(a.myTotal.p50);
    expect(a.myTotal.p50).toBeLessThan(a.myTotal.p90);
    expect(a.myTotal.mean).toBeGreaterThan(30); // 41 projected, sampled with mean preserved
    expect(a.oppTotal.mean).toBeGreaterThan(30);
  });

  it("uses my locked starters when given, even if they are not the best on points", () => {
    const a = startSitAdvice(input({ starterIds: ["qb", "rb", "bench"] }));
    expect(a.lineup.starters.map((s) => s.player.id).sort()).toEqual(["bench", "qb", "rb"]);
    expect(a.lineup.benched.map((b) => b.id)).toEqual(["wr"]);
    // And the swap back to the better WR is offered.
    expect(a.swaps[0]).toMatchObject({ inId: "wr", outId: "bench" });
  });

  it("flags a bye as a FORCED swap, not an optional one", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 0, { pPlay: 0, mean: 0, meanIfPlays: 12, opp: null }), me("wr", "WR", 11), me("rb2", "RB", 9)],
      starterIds: ["qb", "rb", "wr"],
    }));
    const forced = a.forced.find((f) => f.outId === "rb");
    expect(forced?.why).toBe("bye");
    expect(forced?.bestReplacementId).toBe("rb2");
  });

  it("flags an Out designation separately from a bye", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 0.24, { pPlay: 0.02, meanIfPlays: 12, drivers: { ...ol(1).drivers, status: "Out" } }), me("wr", "WR", 11), me("rb2", "RB", 9)],
      starterIds: ["qb", "rb", "wr"],
    }));
    expect(a.forced.find((f) => f.outId === "rb")?.why).toBe("out");
  });

  it("flags a player no source projected, never treating him as a zero", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("ghost", "RB", 0, { projected: false, mean: 0, meanIfPlays: 0 }), me("wr", "WR", 11), me("rb2", "RB", 9)],
      starterIds: ["qb", "ghost", "wr"],
    }));
    expect(a.forced.find((f) => f.outId === "ghost")?.why).toBe("no-projection");
  });

  it("does not flag a healthy starter", () => {
    expect(startSitAdvice(input()).forced).toEqual([]);
  });

  it("ranks swaps by delta win probability and reports delta points alongside", () => {
    // Pre-computed: P(win) 0.396 with wrLow, 0.574 with wrHigh.
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wrLow", "WR", 6), me("wrHigh", "WR", 15)],
      starterIds: ["qb", "rb", "wrLow"],
    }));
    const top = a.swaps[0];
    expect(top).toMatchObject({ inId: "wrHigh", outId: "wrLow" });
    expect(top.deltaWin).toBeGreaterThan(0.1);
    expect(top.deltaPoints).toBeCloseTo(9, 6);
    expect(top.reason).toMatch(/\S/);
    // The recommended lineup applies it.
    expect(a.recommended.starters.map((s) => s.player.id)).toContain("wrHigh");
    expect(a.recommendedWinProbability).toBeGreaterThan(a.winProbability);
  });

  it("never offers an illegal swap (a QB into an RB slot)", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wr", "WR", 11), me("qb2", "QB", 30)],
    }));
    expect(a.swaps.find((s) => s.inId === "qb2" && s.outId !== "qb")).toBeUndefined();
  });

  it("on a FLEX config, a bench RB may replace the flexed WR but a bench QB may not", () => {
    // QB1 RB1 WR1 FLEX1 (RB/WR/TE). The LOCKED lineup is qb, rb, wr1 + flex wr2;
    // rb2 (30) and qb2 (40) sit on the bench, so both swaps are on offer.
    const flexCfg: LeagueConfig = { ...cfg, rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 1, K: 0, DST: 0 } };
    const a = startSitAdvice(input({
      config: flexCfg,
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wr1", "WR", 14), me("wr2", "WR", 11), me("rb2", "RB", 30), me("qb2", "QB", 40)],
      starterIds: ["qb", "rb", "wr1", "wr2"],
      opponent: { kind: "roster", players: [them("oqb", "QB", 18), them("orb", "RB", 12), them("owr", "WR", 14), them("owr2", "WR", 11)] },
    }));
    expect(a.lineup.starters).toHaveLength(4);
    expect(a.lineup.starters.map((s) => s.player.id).sort()).toEqual(["qb", "rb", "wr1", "wr2"]);
    // rb2 (30) is legal in place of ANY of rb, wr1 or wr2 (the set still fills 4 slots); qb2 only in place of qb.
    expect(a.swaps.some((s) => s.inId === "rb2" && s.outId === "wr2")).toBe(true);
    expect(a.swaps.find((s) => s.inId === "qb2" && s.outId !== "qb")).toBeUndefined();
    expect(a.recommended.starters.map((s) => s.player.id)).toContain("rb2");
    expect(a.recommended.starters.map((s) => s.player.id)).toContain("qb2");
  });

  it("prefers the CEILING when I am a heavy underdog, even at lower projected points", () => {
    // Pre-computed at seed 5: P(win) 0.0295 with boring, 0.0605 with swingy.
    const boring = me("boring", "WR", 11, { sigma: 0.2, p90: 14 });
    const swingy = me("swingy", "WR", 10, { sigma: 1.3, p90: 34 });
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 10), me("rb", "RB", 8), boring, swingy],
      opponent: { kind: "roster", players: [them("oqb", "QB", 26), them("orb", "RB", 24), them("owr", "WR", 22)] },
    }));
    const swap = a.swaps.find((s) => s.inId === "swingy" && s.outId === "boring");
    expect(swap).toBeDefined();
    expect(swap!.deltaWin).toBeGreaterThan(0.01);
    // The counter-intuitive part: it gains win probability while LOSING points.
    expect(swap!.deltaPoints).toBeLessThan(0);
    expect(swap!.reason).toMatch(/despite/);
  });

  it("prefers the FLOOR when I am a heavy favourite", () => {
    // Pre-computed at seed 5: P(win) 0.962 with swingy, 0.9855 with boring.
    const boring = me("boring", "WR", 11, { sigma: 0.2, p90: 14, p10: 9 });
    const swingy = me("swingy", "WR", 12, { sigma: 1.3, p90: 40, p10: 2 });
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 26), me("rb", "RB", 24), swingy, boring],
      opponent: { kind: "roster", players: [them("oqb", "QB", 8), them("orb", "RB", 7), them("owr", "WR", 6)] },
    }));
    const swap = a.swaps.find((s) => s.inId === "boring" && s.outId === "swingy");
    expect(swap).toBeDefined();
    expect(swap!.deltaWin).toBeGreaterThan(0.01);
    expect(swap!.reason).toMatch(/floor/);
  });

  it("models a manual opponent as a projected total and lands near 0.5 when evenly matched", () => {
    // Pre-computed: my lineup mean 41.3, P(win vs a 41-point total) 0.505.
    const a = startSitAdvice(input({ opponent: { kind: "total", projectedTotal: 41 } }));
    expect(a.winProbability).toBeGreaterThan(0.45);
    expect(a.winProbability).toBeLessThan(0.55);
    // Sample mean of 2000 lognormal draws: SE about 0.36, so a 3-point band.
    expect(a.oppTotal.mean).toBeGreaterThan(38);
    expect(a.oppTotal.mean).toBeLessThan(44);
    expect(a.oppTotal.p10).toBeLessThan(a.oppTotal.p90);
  });

  it("is deterministic for a given seed", () => {
    expect(JSON.stringify(startSitAdvice(input()))).toBe(JSON.stringify(startSitAdvice(input())));
  });

  describe("risk dial (riskFromPlayoffOdds)", () => {
    // A matchup nobody could win: three 100-point opponents. Every swap has
    // delta P(win) of exactly 0, so under the OFF state there is nothing to say.
    const hopeless = (over: Partial<AdviceInput> = {}) => input({
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wrLow", "WR", 6), me("wrHigh", "WR", 15)],
      starterIds: ["qb", "rb", "wrLow"],
      opponent: { kind: "roster", players: [them("oqb", "QB", 100), them("orb", "RB", 100), them("owr", "WR", 100)] },
      ...over,
    });

    it("OFF state: ranks purely by delta P(win), so a hopeless week yields no swaps", () => {
      const a = startSitAdvice(hopeless());
      expect(a.winProbability).toBe(0);
      expect(a.swaps).toEqual([]);
    });

    it("OFF state ignores leverage entirely", () => {
      const off = startSitAdvice(hopeless({ leverage: 0 }));
      expect(JSON.stringify(off)).toBe(JSON.stringify(startSitAdvice(hopeless())));
    });

    it("ON with zero leverage (this week cannot change my season): plays for points", () => {
      const a = startSitAdvice(hopeless({ levers: { ...DEFAULT_SEASON_LEVERS, riskFromPlayoffOdds: 1 }, leverage: 0 }));
      expect(a.swaps[0]).toMatchObject({ inId: "wrHigh", outId: "wrLow", deltaWin: 0 });
      expect(a.swaps[0].deltaPoints).toBeCloseTo(9, 6);
      expect(a.swaps[0].reason).toMatch(/playoff/);
    });

    it("ON with full leverage is identical to OFF", () => {
      const on = startSitAdvice(hopeless({ levers: { ...DEFAULT_SEASON_LEVERS, riskFromPlayoffOdds: 1 }, leverage: 1 }));
      expect(JSON.stringify(on)).toBe(JSON.stringify(startSitAdvice(hopeless())));
    });
  });
});

describe("toSimPlayer", () => {
  it("builds a stable game key shared by both teams in a game", () => {
    const a = toSimPlayer({ id: "1", pos: "WR", team: "DET", outlook: ol(12, { opp: "CHI" }) });
    const b = toSimPlayer({ id: "2", pos: "WR", team: "CHI", outlook: ol(12, { opp: "DET" }) });
    expect(a.gameId).toBe(b.gameId);
  });

  it("carries a bye through as unplayable rather than as a missing game", () => {
    const s = toSimPlayer({ id: "1", pos: "WR", team: "DET", outlook: ol(0, { opp: null, pPlay: 0 }) });
    expect(s.pPlay).toBe(0);
    expect(s.gameId).toBe("DET-BYE");
  });
});
