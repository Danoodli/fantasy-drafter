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

  it("recomputes in under 50ms", () => {
    const state = makeState();
    recommend(state); // warm up JIT
    const t0 = performance.now();
    recommend(state);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
  });
});
