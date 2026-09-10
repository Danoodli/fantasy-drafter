// tests/seasonTrade.test.ts
import { describe, it, expect } from "vitest";
import { evaluateTrade } from "../lib/engine/season/trade";
import type { LeagueTeamInput } from "../lib/engine/season/playoffOdds";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 4, rounds: 8, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
let n = 0;
const bp = (id: string, pos: Position, proj: number, over: Partial<BoardPlayer> = {}): BoardPlayer => ({
  id, name: id, pos, team: `T${++n}`, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {}, ...over,
});
const roster = [
  bp("qb", "QB", 320), bp("rb1", "RB", 250, { bye: 12 }), bp("rb2", "RB", 200, { bye: 13 }), bp("wr1", "WR", 250), bp("wr2", "WR", 150),
  bp("te", "TE", 120), bp("wr3", "WR", 100), bp("rb3", "RB", 90, { bye: 11 }),
];
const weeks = [10, 11, 12, 13, 14];

describe("evaluateTrade", () => {
  it("a one-for-one upgrade is up on points, flat on cover, odds unknown without a league", () => {
    const v = evaluateTrade({ roster, give: ["wr2"], receive: [bp("wrStar", "WR", 260)], weeks, config: cfg });
    expect(v.points.verdict).toBe("up");
    expect(v.points.delta).toBeGreaterThan(0);
    expect(v.cover.verdict).toBe("flat");
    expect(v.playoffOdds).toBeNull();
    expect(v.rosterAfter.map((p) => p.id)).toContain("wrStar");
    expect(v.rosterAfter.map((p) => p.id)).not.toContain("wr2");
    expect(v.summary).toMatch(/lineup points/);
  });

  it("a two-for-one that thins a position is down on cover even when up on points", () => {
    // Give both backup RBs for one star whose bye matches rb1's: week 12 now has zero RBs.
    const v = evaluateTrade({ roster, give: ["rb2", "rb3"], receive: [bp("rbStar", "RB", 330, { bye: 12 })], weeks, config: cfg });
    expect(v.points.verdict).toBe("up");
    expect(v.cover.verdict).toBe("down");
    expect(v.cover.delta).toBeLessThanOrEqual(-2);
    expect(v.summary).toMatch(/cover/);
  });

  it("a downgrade is down on points", () => {
    const v = evaluateTrade({ roster, give: ["wr1"], receive: [bp("wrMeh", "WR", 120)], weeks, config: cfg });
    expect(v.points.verdict).toBe("down");
  });

  it("a swap of equals is flat", () => {
    const v = evaluateTrade({ roster, give: ["wr2"], receive: [bp("wrSame", "WR", 150)], weeks, config: cfg });
    expect(v.points.verdict).toBe("flat");
    expect(v.cover.verdict).toBe("flat");
  });

  it("with a league, a big upgrade raises playoff odds and the partner's roster changes too", () => {
    const mk = (rosterId: number, players: BoardPlayer[]): LeagueTeamInput => ({ rosterId, name: `T${rosterId}`, players, wins: 4, losses: 4, ties: 0, pointsFor: 800 });
    const other = (k: number) => [bp(`q${k}`, "QB", 300), bp(`r${k}a`, "RB", 220), bp(`r${k}b`, "RB", 200), bp(`w${k}a`, "WR", 220), bp(`w${k}b`, "WR", 180), bp(`t${k}`, "TE", 110)];
    const partner = [...other(2), bp("rbStar", "RB", 400)];
    const teams = [mk(1, roster), mk(2, partner), mk(3, other(3)), mk(4, other(4))];
    const rbStar = bp("rbStar", "RB", 400);
    const league = { teams, schedule: {}, currentWeek: 10, playoffWeekStart: 15, playoffTeams: 2, myRosterId: 1, sims: 300, seed: 7 };
    const v = evaluateTrade({ roster, give: ["rb3"], receive: [rbStar], weeks, config: cfg, league: { ...league, partnerRosterId: 2 } });
    expect(v.playoffOdds).not.toBeNull();
    expect(v.playoffOdds!.verdict).toBe("up");
    expect(v.playoffOdds!.delta).toBeGreaterThan(0.05);
    // The partner update is load-bearing: with the partner weakened (they lose
    // rbStar), my odds rise MORE than if their roster were left untouched.
    // Deleting the partner branch makes these two deltas identical.
    const noPartner = evaluateTrade({ roster, give: ["rb3"], receive: [rbStar], weeks, config: cfg, league });
    expect(v.playoffOdds!.delta).toBeGreaterThan(noPartner.playoffOdds!.delta);
  });

  it("is deterministic", () => {
    const x = bp("x", "WR", 260); // one object: the helper stamps a fresh team per call
    const a = evaluateTrade({ roster, give: ["wr2"], receive: [x], weeks, config: cfg });
    const b = evaluateTrade({ roster, give: ["wr2"], receive: [x], weeks, config: cfg });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
