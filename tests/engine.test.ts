import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slotOnClock, pickNumber, pickOwner, picksForSlot } from "../lib/draft/snake";
import { normalCdf, survivalProb } from "../lib/engine/survival";
import { lastStarterRank, replacementRank } from "../lib/engine/baselines";
import { assignTiers } from "../lib/engine/tiers";
import { vona, expectedBestAtPick } from "../lib/engine/vona";
import { computeDrift } from "../lib/engine/drift";
import { searchPlayers } from "../lib/draft/fuzzy";
import { recommend } from "../lib/engine/recommend";
import { scoreStatLine, SCORING_PRESETS } from "../lib/scoring";
import { mergeName } from "../lib/etl/names";
import type { Board, BoardPlayer, EngineState, LeagueConfig, Strategy } from "../lib/types";

const board: Board = JSON.parse(
  readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8")
);
const strategies: Strategy[] = JSON.parse(
  readFileSync(join(process.cwd(), "config", "strategies.json"), "utf8")
);
const byId = (id: string) => strategies.find((s) => s.id === id)!;

const config: LeagueConfig = {
  platform: "manual",
  leagueId: "",
  draftId: "",
  myDraftSlot: 5,
  teams: 12,
  rounds: 15,
  scoring: "ppr",
  leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"],
  strategy: "balanced",
};

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    board: board.players,
    draftedIds: new Set(),
    myRoster: [],
    currentPick: 5,
    myPicks: [5, 20, 29, 44, 53, 68, 77, 92, 101, 116, 125, 140, 149, 164, 173],
    config,
    strategy: byId("balanced"),
    drift: {},
    ...overrides,
  };
}

describe("snake math", () => {
  it("computes slot on clock for odd and even rounds", () => {
    expect(slotOnClock(1, 12)).toEqual({ round: 1, slot: 1 });
    expect(slotOnClock(12, 12)).toEqual({ round: 1, slot: 12 });
    expect(slotOnClock(13, 12)).toEqual({ round: 2, slot: 12 });
    expect(slotOnClock(24, 12)).toEqual({ round: 2, slot: 1 });
    expect(slotOnClock(25, 12)).toEqual({ round: 3, slot: 1 });
  });

  it("pickNumber is the inverse of slotOnClock", () => {
    for (let n = 1; n <= 180; n++) {
      const { round, slot } = slotOnClock(n, 12);
      expect(pickNumber(round, slot, 12)).toBe(n);
    }
  });

  it("applies traded picks to ownership", () => {
    const traded = [{ round: 2, originalSlot: 12, newSlot: 3 }];
    expect(pickOwner(13, 12, traded)).toBe(3); // pick 13 = round 2, slot 12
    expect(pickOwner(13, 12, [])).toBe(12);
    const picks = picksForSlot(3, 12, 3, traded);
    expect(picks).toContain(13);
    expect(picksForSlot(12, 12, 3, traded)).not.toContain(13);
  });
});

describe("survival model", () => {
  const p = { adp: 30, adpStdev: 5, adpHigh: 18, adpLow: 45, pos: "RB" as const };
  it("is ~50% at ADP, near 1 early, near 0 late", () => {
    expect(survivalProb(p, 30)).toBeCloseTo(0.5, 1);
    expect(survivalProb(p, 10)).toBeGreaterThan(0.94);
    expect(survivalProb(p, 50)).toBeLessThan(0.06);
  });
  it("is monotonically non-increasing in pick number", () => {
    let last = 1;
    for (let n = 1; n <= 60; n++) {
      const s = survivalProb(p, n);
      expect(s).toBeLessThanOrEqual(last + 1e-9);
      last = s;
    }
  });
  it("shifts with room drift", () => {
    expect(survivalProb(p, 30, { RB: 6 })).toBeGreaterThan(survivalProb(p, 30));
    expect(survivalProb(p, 30, { RB: -6 })).toBeLessThan(survivalProb(p, 30));
  });
  it("normalCdf sanity", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2);
  });
});

describe("baselines", () => {
  it("derives ranks from league settings, not hardcoded", () => {
    expect(lastStarterRank("QB", config)).toBe(12);
    expect(lastStarterRank("RB", config)).toBe(Math.round(12 * (2 + 0.45)));
    expect(lastStarterRank("TE", config)).toBe(Math.round(12 * (1 + 0.1)));
    const twoQb = { ...config, rosterSlots: { ...config.rosterSlots, QB: 2 } };
    expect(lastStarterRank("QB", twoQb)).toBe(24);
  });
  it("replacement rank sits past the last starter", () => {
    for (const pos of ["QB", "RB", "WR", "TE"] as const) {
      expect(replacementRank(pos, config)).toBeGreaterThan(lastStarterRank(pos, config));
    }
  });
});

describe("tiers", () => {
  it("breaks at an obvious cliff", () => {
    const tiers = assignTiers([300, 298, 296, 250, 248, 246]);
    expect(tiers).toEqual([1, 1, 1, 2, 2, 2]);
  });
  it("keeps a flat run in one tier until the size cap", () => {
    const flat = Array.from({ length: 20 }, (_, i) => 200 - i);
    const tiers = assignTiers(flat);
    expect(tiers[0]).toBe(1);
    expect(tiers[7]).toBe(1); // maxTierSize 8
    expect(tiers[8]).toBe(2);
  });
  it("does not make singletons of every elite player when top gaps are similar", () => {
    // Top-heavy but evenly-spaced: no local outlier gaps → one tier (until cap)
    const pts = [360, 350, 341, 333, 326, 320, 315, 311, 308, 306, 305, 304];
    const tiers = assignTiers(pts);
    expect(new Set(tiers.slice(0, 5)).size).toBeLessThanOrEqual(2);
  });
});

describe("VONA", () => {
  it("rewards the last player before a positional cliff", () => {
    const mk = (id: string, pts: number, adp: number): BoardPlayer =>
      ({
        id, name: id, pos: "TE", team: "X", bye: 5, projPoints: pts, projImputed: false,
        adp, adpStdev: 4, adpHigh: adp - 8, adpLow: adp + 8, ecr: null, ecrStdev: null,
        vorp: 0, vols: 0, tier: 1, ids: {},
      }) as BoardPlayer;
    const eliteTe = mk("elite", 220, 20);
    const nextTe = mk("mid", 150, 70);
    const available = [eliteTe, nextTe];
    // My next pick is 40: elite TE won't be there, replacement is 70 pts worse.
    const v = vona(eliteTe, available, 40);
    expect(v).toBeGreaterThan(50);
    // Expected best at 40 without elite is ~the mid TE
    expect(expectedBestAtPick([nextTe], 40)).toBeCloseTo(150, 0);
  });
});

describe("room drift", () => {
  it("blends observation with a prior, ignores keepers", () => {
    const players = board.players;
    const rb = players.find((p) => p.pos === "RB" && p.adp > 20 && p.adp < 40)!;
    const picks = [
      { playerId: rb.id, playerName: rb.name, pos: rb.pos, pickNo: Math.round(rb.adp) - 10, round: 1, draftSlot: 1, isKeeper: false, byMe: false },
    ];
    const map = new Map(players.map((p) => [p.id, p]));
    const drift = computeDrift(picks, map);
    expect(drift.RB).toBeLessThan(0); // went earlier than ADP
    expect(Math.abs(drift.RB!)).toBeLessThan(10); // prior damps a single sample
    const keeperOnly = computeDrift(picks.map((p) => ({ ...p, isKeeper: true })), map);
    expect(keeperOnly.RB).toBeUndefined();
  });
});

describe("fuzzy matching", () => {
  const players = board.players;
  it('"ceedee" → CeeDee Lamb', () => {
    expect(searchPlayers("ceedee", players)[0]?.name).toMatch(/CeeDee Lamb/);
  });
  it('"b thomas" → Brian Thomas', () => {
    expect(searchPlayers("b thomas", players)[0]?.name).toMatch(/Brian Thomas/);
  });
  it('"B. Thomas" → Brian Thomas', () => {
    expect(searchPlayers("B. Thomas", players)[0]?.name).toMatch(/Brian Thomas/);
  });
  it('"k walker" → Kenneth Walker', () => {
    expect(searchPlayers("k walker", players)[0]?.name).toMatch(/Kenneth Walker/);
  });
  it("empty query returns nothing", () => {
    expect(searchPlayers("", players)).toEqual([]);
  });
});

describe("scoring", () => {
  it("PPR minus standard equals receptions", () => {
    const stats = { recYds: 1000, recTD: 8, receptions: 90 };
    const ppr = scoreStatLine(stats, SCORING_PRESETS.ppr);
    const std = scoreStatLine(stats, SCORING_PRESETS.standard);
    expect(ppr - std).toBeCloseTo(90, 5);
  });
  it("mergeName matches DynastyProcess conventions", () => {
    expect(mergeName("Amon-Ra St. Brown")).toBe("amon-ra st brown");
    expect(mergeName("Eddy Piñeiro")).toBe("eddy pineiro");
    expect(mergeName("Marvin Harrison Jr.")).toBe("marvin harrison");
  });
});

describe("recommendation engine (integration on real board)", () => {
  it("never recommends K/DST before the final two rounds", () => {
    const out = recommend(makeState());
    for (const r of out.recommendations) expect(["K", "DST"]).not.toContain(r.player.pos);
  });

  it("never recommends a second QB before round 12 in a 1-QB league", () => {
    const qb = board.players.find((p) => p.pos === "QB")!;
    const out = recommend(
      makeState({
        myRoster: [qb],
        draftedIds: new Set([qb.id]),
        currentPick: 53,
        myPicks: [53, 68, 77, 92, 101, 116, 125, 140, 149, 164, 173],
      })
    );
    for (const r of out.recommendations) expect(r.player.pos).not.toBe("QB");
  });

  it("Zero RB and Robust RB disagree from an identical early board state", () => {
    const state = makeState({ currentPick: 8, myPicks: [8, 17, 32, 41, 56, 65, 80, 89, 104, 113, 128, 137, 152, 161, 176] });
    const zero = recommend({ ...state, strategy: byId("zero-rb") });
    const robust = recommend({ ...state, strategy: byId("robust-rb") });
    expect(zero.recommendations[0].player.pos).toBe("WR");
    expect(robust.recommendations[0].player.pos).toBe("RB");
  });

  it("produces three ranked recommendations with reasons", () => {
    const out = recommend(makeState());
    expect(out.recommendations).toHaveLength(3);
    expect(out.recommendations[0].score).toBeGreaterThanOrEqual(out.recommendations[1].score);
    for (const r of out.recommendations) expect(r.reason.length).toBeGreaterThan(5);
  });

  it("is deterministic given the same seed", () => {
    const a = recommend(makeState(), 7);
    const b = recommend(makeState(), 7);
    expect(a.recommendations.map((r) => r.player.id)).toEqual(
      b.recommendations.map((r) => r.player.id)
    );
  });

  it("fills required starters when picks run out", () => {
    // 14 picks in, everything filled except K and DST, 2 picks left.
    const roster = [
      ...board.players.filter((p) => p.pos === "QB").slice(0, 1),
      ...board.players.filter((p) => p.pos === "RB").slice(0, 4),
      ...board.players.filter((p) => p.pos === "WR").slice(0, 5),
      ...board.players.filter((p) => p.pos === "TE").slice(0, 2),
    ];
    const out = recommend(
      makeState({
        myRoster: roster,
        draftedIds: new Set(roster.map((p) => p.id)),
        currentPick: 161,
        myPicks: [161, 176],
      })
    );
    expect(["K", "DST"]).toContain(out.recommendations[0].player.pos);
  });

});

// ---------------------------------------------------------------------------
// Best ball, stacking, injuries, drift priors

import { needWeight } from "../lib/engine/recommend";
import type { EngineOutput } from "../lib/types";

const bestballConfig: LeagueConfig = {
  ...config,
  leagueType: "bestball",
  rounds: 18,
  scoring: "ppr",
  rosterSlots: { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
  strategy: "tournament-ceiling",
};

describe("best ball roster construction", () => {
  it("needWeight chases position targets, not starter slots", () => {
    const st = { config: bestballConfig };
    expect(needWeight("QB", { QB: 0 }, st)).toBe(1);
    expect(needWeight("QB", { QB: 1 }, st)).toBe(1); // under min target of 2
    expect(needWeight("QB", { QB: 3 }, st)).toBeLessThan(0.2);
    expect(needWeight("WR", { WR: 5 }, st)).toBeGreaterThanOrEqual(0.7); // WR target ~7-9
    expect(needWeight("K", {}, st)).toBe(0); // no K slots in this format
    expect(needWeight("DST", {}, st)).toBe(0);
  });

  it("a full engine auto-draft builds a sane tournament roster", () => {
    const strategy = byId("tournament-ceiling");
    const teams = 12;
    const mySlot = 5;
    const myPickNos = Array.from({ length: 18 }, (_, r) => {
      const round = r + 1;
      return (round - 1) * teams + (round % 2 === 1 ? mySlot : teams - mySlot + 1);
    });
    const drafted = new Set<string>();
    const roster: BoardPlayer[] = [];
    const adpOrder = [...board.players].sort((a, b) => a.adp - b.adp);
    for (let pickNo = 1; pickNo <= teams * 18; pickNo++) {
      if (myPickNos.includes(pickNo)) {
        const out: EngineOutput = recommend({
          board: board.players,
          draftedIds: drafted,
          myRoster: roster,
          currentPick: pickNo,
          myPicks: myPickNos.filter((n) => n >= pickNo),
          config: bestballConfig,
          strategy,
          drift: {},
        });
        const pick = out.recommendations[0]?.player;
        expect(pick).toBeDefined();
        roster.push(pick!);
        drafted.add(pick!.id);
      } else {
        const next = adpOrder.find((p) => !drafted.has(p.id));
        if (next) drafted.add(next.id);
      }
    }
    const count = (pos: string) => roster.filter((p) => p.pos === pos).length;
    expect(roster).toHaveLength(18);
    expect(count("K")).toBe(0);
    expect(count("DST")).toBe(0);
    expect(count("QB")).toBeGreaterThanOrEqual(2);
    expect(count("QB")).toBeLessThanOrEqual(3);
    expect(count("RB")).toBeGreaterThanOrEqual(4);
    expect(count("WR")).toBeGreaterThanOrEqual(6);
    expect(count("TE")).toBeGreaterThanOrEqual(2);
  });
});

describe("stacking", () => {
  const mk = (id: string, pos: BoardPlayer["pos"], team: string, pts: number, adp: number): BoardPlayer => ({
    id, name: id, pos, team, bye: 7, projPoints: pts, projImputed: false,
    adp, adpStdev: 6, adpHigh: adp - 10, adpLow: adp + 10, ecr: null, ecrStdev: null,
    vorp: pts - 200, vols: pts - 250, tier: 1, injury: null, depthOrder: 1,
    sosSeason: null, sosPlayoff: null, ids: {},
  });
  const miniBoard = [
    mk("qb-stack", "QB", "LAR", 320, 60),
    mk("qb-other", "QB", "KC", 340, 60), // clearly better in a vacuum
    mk("my-wr", "WR", "LAR", 300, 5),
    ...Array.from({ length: 30 }, (_, i) => mk(`filler-${i}`, i % 2 ? "RB" : "WR", "X" + i, 250 - i * 3, 10 + i * 3)),
  ];
  const mkState = (stacking: number): EngineState => ({
    board: miniBoard,
    draftedIds: new Set(["my-wr"]),
    myRoster: [miniBoard[2]],
    currentPick: 60,
    // Full remaining schedule — plenty of slack, so construction urgency
    // stays out of the way and the test isolates stacking.
    myPicks: Array.from({ length: 16 }, (_, i) => 60 + i * 24),
    config: { ...bestballConfig },
    strategy: { ...byId("tournament-ceiling"), stacking, positionMultipliers: {} },
    drift: {},
  });
  it("stacking closes the gap on a vacuum-better QB", () => {
    const rankOf = (out: EngineOutput, id: string) =>
      out.recommendations.findIndex((r) => r.player.id === id);
    const noStack = recommend(mkState(0));
    // Without stacking the clearly-better QB outranks the stack partner.
    expect(rankOf(noStack, "qb-other")).toBeLessThan(rankOf(noStack, "qb-stack"));
    // Heavy stacking flips the order: correlation buys the LAR QB the spot.
    const withStack = recommend(mkState(1.5));
    expect(rankOf(withStack, "qb-stack")).toBeLessThan(rankOf(withStack, "qb-other"));
  });
});

describe("injuries", () => {
  it("never recommends players on season-long injured lists", () => {
    const hurt = board.players.map((p, i) => (i === 0 ? { ...p, injury: "IR" } : p));
    const out = recommend({ ...makeState(), board: hurt, currentPick: 1, myPicks: [1, 24] });
    expect(out.recommendations.map((r) => r.player.id)).not.toContain(board.players[0].id);
  });
});

describe("drift prior", () => {
  it("seeds drift before any picks are observed", () => {
    const map = new Map(board.players.map((p) => [p.id, p]));
    const drift = computeDrift([], map, { drift: { RB: -6 }, weight: 24 });
    expect(drift.RB).toBeLessThan(-3); // prior dominates with no observations
    const noPrior = computeDrift([], map);
    expect(noPrior.RB).toBeUndefined();
  });
});

describe("season simulation", () => {
  const roster = [
    ...board.players.filter((p) => p.pos === "QB").slice(0, 2),
    ...board.players.filter((p) => p.pos === "RB").slice(0, 5),
    ...board.players.filter((p) => p.pos === "WR").slice(0, 7),
    ...board.players.filter((p) => p.pos === "TE").slice(0, 2),
  ];
  it("produces a sane, seeded, reproducible distribution", async () => {
    const { simulateSeasons } = await import("../lib/engine/season");
    const a = simulateSeasons(roster, bestballConfig, 200, 9);
    const b = simulateSeasons(roster, bestballConfig, 200, 9);
    expect(a.mean).toBe(b.mean); // deterministic
    expect(a.p10).toBeLessThan(a.p50);
    expect(a.p50).toBeLessThan(a.p90);
    expect(a.p90).toBeLessThan(a.p99);
    // 17 weeks × ~6 lineup slots × ~12-25 pts/slot — sanity bounds
    expect(a.mean).toBeGreaterThan(1000);
    expect(a.mean).toBeLessThan(4000);
  });
  it("optimal lineup respects slots and flex", async () => {
    const { optimalLineupTotal } = await import("../lib/engine/season");
    const total = optimalLineupTotal(
      [
        { pos: "QB", score: 20 }, { pos: "QB", score: 15 },
        { pos: "RB", score: 10 }, { pos: "RB", score: 9 },
        { pos: "WR", score: 12 }, { pos: "WR", score: 11 }, { pos: "WR", score: 8 },
        { pos: "TE", score: 5 },
      ],
      bestballConfig // QB1 RB1 WR2 TE1 FLEX1
    );
    // QB20 + RB10 + WR12 + WR11 + TE5 + FLEX(best leftover = RB9) = 67
    expect(total).toBe(67);
  });
});

// ---------------------------------------------------------------------------
// Football-sense rules: pacing, bye congestion, verdicts, matchups

import { playerVerdict, playerBlurb } from "../lib/engine/reasons";

describe("pacing rules (human draft sense)", () => {
  it("never takes a QB in rounds 1-2, and spaces QBs/TEs in best ball", () => {
    const strategy = byId("tournament-ceiling");
    const teams = 12, mySlot = 7;
    const myPickNos = Array.from({ length: 18 }, (_, r) => {
      const round = r + 1;
      return (round - 1) * teams + (round % 2 === 1 ? mySlot : teams - mySlot + 1);
    });
    const drafted = new Set<string>();
    const roster: BoardPlayer[] = [];
    const picksByRound: [number, string][] = [];
    const adpOrder = [...board.players].sort((a, b) => a.adp - b.adp);
    for (let pickNo = 1; pickNo <= teams * 18; pickNo++) {
      if (myPickNos.includes(pickNo)) {
        const out = recommend({
          board: board.players, draftedIds: drafted, myRoster: roster,
          currentPick: pickNo, myPicks: myPickNos.filter((n) => n >= pickNo),
          config: bestballConfig, strategy, drift: {},
        });
        const pick = out.recommendations[0]!.player;
        roster.push(pick);
        drafted.add(pick.id);
        picksByRound.push([Math.ceil(pickNo / teams), pick.pos]);
      } else {
        const next = adpOrder.find((p) => !drafted.has(p.id));
        if (next) drafted.add(next.id);
      }
    }
    const roundsOf = (pos: string) => picksByRound.filter(([, p]) => p === pos).map(([r]) => r);
    const qbRounds = roundsOf("QB");
    const teRounds = roundsOf("TE");
    // No QB in rounds 1-2, ever, in a 1-QB lineup.
    expect(qbRounds.every((r) => r >= 3)).toBe(true);
    // Second QB/TE not before round 6, third not before round 10.
    expect(qbRounds[1] === undefined || qbRounds[1] >= 6).toBe(true);
    expect(qbRounds[2] === undefined || qbRounds[2] >= 10).toBe(true);
    expect(teRounds[1] === undefined || teRounds[1] >= 6).toBe(true);
  });

  it("redraft: no second TE before round 10", () => {
    const te = board.players.find((p) => p.pos === "TE")!;
    const out = recommend(
      makeState({
        myRoster: [te],
        draftedIds: new Set([te.id]),
        currentPick: 53,
        myPicks: [53, 68, 77, 92, 101, 116, 125, 140, 149, 164, 173],
      })
    );
    for (const r of out.recommendations) expect(r.player.pos).not.toBe("TE");
  });
});

describe("bye congestion", () => {
  it("prefers the equal player who does not pile onto a stacked bye week", () => {
    const mk = (id: string, bye: number, adp: number): BoardPlayer => ({
      id, name: id, pos: "WR", team: "T" + id, bye, projPoints: 200, projImputed: false,
      adp, adpStdev: 6, adpHigh: adp - 8, adpLow: adp + 8, ecr: null, ecrStdev: null,
      vorp: 60, vols: 30, tier: 3, injury: null, depthOrder: 1,
      sosSeason: null, sosPlayoff: null, ids: {},
    });
    const mkRoster = (bye: number, i: number): BoardPlayer =>
      ({ ...mk(`r${i}`, bye, 10 + i), pos: (["RB", "QB", "TE", "RB"] as const)[i % 4] }) as BoardPlayer;
    const roster = [0, 1, 2, 3].map((i) => mkRoster(7, i)); // four players on bye 7
    const sameBye = mk("same-bye", 7, 60);
    const freshBye = mk("fresh-bye", 9, 60);
    const filler = Array.from({ length: 20 }, (_, i) => mk(`f${i}`, 5, 80 + i * 4));
    const out = recommend({
      board: [...roster, sameBye, freshBye, ...filler],
      draftedIds: new Set(roster.map((r) => r.id)),
      myRoster: roster,
      currentPick: 60,
      myPicks: [60, 84],
      config,
      strategy: byId("balanced"),
      drift: {},
    });
    const ids = out.recommendations.map((r) => r.player.id);
    expect(ids.indexOf("fresh-bye")).toBeLessThan(ids.indexOf("same-bye") < 0 ? 99 : ids.indexOf("same-bye"));
  });
});

describe("verdicts (precanned, math-only)", () => {
  const base = board.players.find((p) => p.pos === "WR" && p.adp > 30 && p.adp < 40)!;
  const ctx = { currentPick: 36, nextPick: 48, drift: {}, tierMatesLeft: 4 };
  it("grades a fair-price healthy player as fair/good, a big reach as bad/horrible", () => {
    const fair = playerVerdict(base, ctx);
    expect(["fair", "good", "perfect"]).toContain(fair.verdict);
    const reach = playerVerdict({ ...base, adp: base.adp + 30 }, { ...ctx, currentPick: Math.round(base.adp) - 12 });
    expect(["bad", "horrible"]).toContain(reach.verdict);
    expect(playerVerdict({ ...base, injury: "IR" }, ctx).verdict).toBe("horrible");
  });
  it("flags risk from injury, ADP variance, and backup roles", () => {
    expect(playerVerdict({ ...base, injury: "Questionable" }, ctx).risk).toBe("high risk");
    expect(playerVerdict({ ...base, adpStdev: 14 }, ctx).risk).toBe("high risk");
  });
  it("blurb always includes market, tier, and survival lines", () => {
    const blurb = playerBlurb(base, ctx);
    expect(blurb.lines.length).toBeGreaterThanOrEqual(3);
    expect(blurb.lines.join(" ")).toMatch(/ADP/);
    expect(blurb.lines.join(" ")).toMatch(/survives/);
  });
});

describe("matchups (SOS)", () => {
  it("a softer playoff schedule outranks an identical player with a brutal one", () => {
    const mk = (id: string, sos: number): BoardPlayer => ({
      id, name: id, pos: "WR", team: id, bye: 7, projPoints: 210, projImputed: false,
      adp: 40, adpStdev: 6, adpHigh: 32, adpLow: 48, ecr: null, ecrStdev: null,
      vorp: 70, vols: 40, tier: 2, injury: null, depthOrder: 1,
      sosSeason: 0.5, sosPlayoff: sos, ids: {},
    });
    const filler = Array.from({ length: 20 }, (_, i) => ({
      ...mk(`f${i}`, 0.5), projPoints: 150 - i, vorp: 20 - i, vols: -10 - i, adp: 70 + i * 4,
    }));
    const out = recommend({
      board: [mk("soft", 0.9), mk("brutal", 0.1), ...filler],
      draftedIds: new Set(),
      myRoster: [],
      currentPick: 40,
      myPicks: [40, 64],
      config,
      strategy: byId("balanced"),
      drift: {},
    });
    const ids = out.recommendations.map((r) => r.player.id);
    expect(ids.indexOf("soft")).toBeLessThan(ids.indexOf("brutal"));
  });
});

describe("construction floors (the zero-TE bug)", () => {
  it("a 15-round best-ball auto-draft never ends below any floor (TE≥2, QB≥2, RB≥4, WR≥5)", () => {
    const cfg = { ...bestballConfig, rounds: 15 };
    const strategy = byId("tournament-ceiling");
    const teams = 12, mySlot = 4;
    const myPickNos = Array.from({ length: 15 }, (_, r) => {
      const round = r + 1;
      return (round - 1) * teams + (round % 2 === 1 ? mySlot : teams - mySlot + 1);
    });
    const drafted = new Set<string>();
    const roster: BoardPlayer[] = [];
    const adpOrder = [...board.players].sort((a, b) => a.adp - b.adp);
    for (let pickNo = 1; pickNo <= teams * 15; pickNo++) {
      if (myPickNos.includes(pickNo)) {
        const out = recommend({
          board: board.players, draftedIds: drafted, myRoster: roster,
          currentPick: pickNo, myPicks: myPickNos.filter((n) => n >= pickNo),
          config: cfg, strategy, drift: {},
        });
        const pick = out.recommendations[0]!.player;
        roster.push(pick);
        drafted.add(pick.id);
      } else {
        const next = adpOrder.find((p) => !drafted.has(p.id));
        if (next) drafted.add(next.id);
      }
    }
    const count = (pos: string) => roster.filter((p) => p.pos === pos).length;
    expect(count("TE")).toBeGreaterThanOrEqual(2);
    expect(count("QB")).toBeGreaterThanOrEqual(2);
    expect(count("RB")).toBeGreaterThanOrEqual(4);
    expect(count("WR")).toBeGreaterThanOrEqual(5);
  });

  it("requiredFloor scales with format", async () => {
    const { requiredFloor } = await import("../lib/engine/recommend");
    expect(requiredFloor("TE", bestballConfig)).toBe(2); // 18 rounds
    expect(requiredFloor("TE", config)).toBe(1); // redraft: lineup slots
    expect(requiredFloor("K", bestballConfig)).toBe(0); // no K in format
  });
});

describe("post-draft recap", () => {
  it("ranks rosters, grades them, and finds steals and reaches", async () => {
    const { buildRecap, gradeFor, superlatives } = await import("../lib/engine/recap");
    const byId = new Map(board.players.map((p) => [p.id, p]));
    // Draft the top of the board in ADP order, but let adpOrder[30] FALL:
    // everyone skips him until pick 61 — the steal of the draft.
    const adpOrder = [...board.players].sort((a, b) => a.adp - b.adp);
    const faller = adpOrder[30];
    const pool = adpOrder.filter((p) => p.id !== faller.id);
    const picks = pool.slice(0, 60).map((p, i) => ({
      playerId: p.id, playerName: p.name, pos: p.pos,
      pickNo: i + 1, round: Math.ceil((i + 1) / 12), draftSlot: 0,
      isKeeper: false, byMe: false,
    }));
    picks.push({ playerId: faller.id, playerName: faller.name, pos: faller.pos,
      pickNo: 61, round: 6, draftSlot: 0, isKeeper: false, byMe: false });
    const recap = buildRecap(picks, byId, config, []);
    expect(recap).toHaveLength(12);
    expect(recap[0].score).toBeGreaterThanOrEqual(recap[11].score);
    expect(recap.every((t) => t.roster.length >= 5)).toBe(true);
    expect(gradeFor(0, 12)).toBe("A+");
    expect(gradeFor(11, 12)).toBe("D");
    const sups = superlatives(picks, byId, 12, []);
    expect(sups.find((s) => s.label === "Steal of the draft")).toBeDefined();
  });
});

describe("share links", () => {
  it("config round-trips through the URL encoding and survives garbage", async () => {
    const { encodeConfig, decodeConfig } = await import("../lib/client/presets");
    const cfg: LeagueConfig = {
      ...config,
      leagueType: "bestball",
      rounds: 18,
      rosterSlots: { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
      scoringTweaks: { bonusRecTe: 0.5, passTd: 6 },
    };
    const decoded = decodeConfig(encodeConfig(cfg));
    expect(decoded).toEqual(cfg);
    expect(decodeConfig("not-base64!!!")).toBeNull();
    // Mangled numbers get clamped, not trusted
    const evil = decodeConfig(
      Buffer.from(JSON.stringify({ teams: 9999, rounds: -5, rosterSlots: { QB: 99 } }), "utf8")
        .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    );
    expect(evil!.teams).toBeLessThanOrEqual(24);
    expect(evil!.rounds).toBeGreaterThanOrEqual(4);
    expect(evil!.rosterSlots.QB).toBeLessThanOrEqual(6);
  });
});

describe("data-source preferences", () => {
  it("switching ADP and projection sources actually changes the board", async () => {
    const { rescoreBoard } = await import("../lib/client/rescore");
    const scoring = SCORING_PRESETS.ppr;
    const espnBoard = rescoreBoard(board, scoring, config, { projections: "espn", adp: "ffc", trending: true });
    const slpBoard = rescoreBoard(board, scoring, config, { projections: "sleeper", adp: "sleeper", trending: true });
    const pick = (b: Board, name: string) => b.players.find((p) => p.name === name)!;
    const g1 = pick(espnBoard, "Jahmyr Gibbs");
    const g2 = pick(slpBoard, "Jahmyr Gibbs");
    expect(g1.adp).toBe(g1.adpSources!.ffc);
    expect(g2.adp).toBe(g2.adpSources!.sleeper);
    // Different projection models disagree somewhere on the board
    const diffs = espnBoard.players.filter((p, i) => {
      const other = slpBoard.players.find((q) => q.id === p.id)!;
      return Math.abs(p.projPoints - other.projPoints) > 1 && i < 100;
    });
    expect(diffs.length).toBeGreaterThan(10);
    // Blend sits between the two for a player where both sources exist
    const blend = rescoreBoard(board, scoring, config, { projections: "blend", adp: "blend", trending: true });
    const gb = pick(blend, "Jahmyr Gibbs");
    const lo = Math.min(g1.projPoints, g2.projPoints) - 0.11;
    const hi = Math.max(g1.projPoints, g2.projPoints) + 0.11;
    expect(gb.projPoints).toBeGreaterThanOrEqual(lo);
    expect(gb.projPoints).toBeLessThanOrEqual(hi);
  });

  it("PPFD scoring counts Sleeper's projected first downs at full weight under blend", async () => {
    const { rescoreBoard } = await import("../lib/client/rescore");
    const base = SCORING_PRESETS.ppr;
    const ppfd = { ...base, rush_fd: 0.5, rec_fd: 0.5 };
    const prefs = { projections: "blend" as const, adp: "ffc" as const, trending: true };
    const without = rescoreBoard(board, base, config, prefs);
    const withFd = rescoreBoard(board, ppfd, config, prefs);
    const g0 = without.players.find((p) => p.name === "Jahmyr Gibbs")!;
    const g1 = withFd.players.find((p) => p.name === "Jahmyr Gibbs")!;
    const fd = (g1.statsSleeper!.rushFd ?? 0) + (g1.statsSleeper!.recFd ?? 0);
    expect(g1.projPoints - g0.projPoints).toBeCloseTo(fd * 0.5, 0);
  });
});

describe("news matching", () => {
  it("matches headlines to full player names only, respecting recency", async () => {
    const { matchNewsToPlayers } = await import("../lib/client/espnNews");
    const now = 1_800_000_000_000;
    const gibbs = board.players.find((p) => p.name === "Jahmyr Gibbs")!;
    const items = [
      { headline: "Jahmyr Gibbs suspended two games", description: "", published: new Date(now - 3600_000).toISOString(), href: "x", athleteIds: [] },
      { headline: "Old Jahmyr Gibbs note", description: "", published: new Date(now - 10 * 86400_000).toISOString(), href: "y", athleteIds: [] },
      { headline: "Gibbs family opens bakery", description: "", published: new Date(now).toISOString(), href: "z", athleteIds: [] },
      { headline: "Star RB questionable for opener", description: "", published: new Date(now).toISOString(), href: "w", athleteIds: [gibbs.ids.espn!] },
      { headline: "Roundup of nineteen players", description: "", published: new Date(now).toISOString(), href: "r", athleteIds: Array.from({ length: 19 }, () => gibbs.ids.espn!) },
    ];
    const matched = matchNewsToPlayers(items, board.players, 72, now);
    // Athlete-tagged article wins (newer); roundups with many tags are ignored
    expect(matched.get(gibbs.id)?.headline).toBe("Star RB questionable for opener");
    // last-name-only headline must NOT match
    expect([...matched.values()].some((n) => n.headline.includes("bakery"))).toBe(false);
  });

  it("fp stat mapping handles the projections shape", async () => {
    const { mapFpStats } = await import("../lib/etl/fantasypros");
    const line = mapFpStats({ rush_yds: "1381.2", rush_tds: 13.8, rec_rec: 71.3, rec_yds: 580.6, rec_tds: 4.1, fumbles: 1.5 });
    expect(line.rushYds).toBeCloseTo(1381.2);
    expect(line.receptions).toBeCloseTo(71.3);
    expect(line.fumblesLost).toBeCloseTo(1.5);
    expect(line.passYds).toBeUndefined();
  });
});
