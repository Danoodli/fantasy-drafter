import { describe, it, expect } from "vitest";
import { playoffOdds, eliminationNumber, type LeagueTeamInput } from "../lib/engine/season/playoffOdds";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 4, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 0, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

let n = 0;
const bp = (pos: Position, proj: number, team = "T" + n): BoardPlayer => ({
  id: `p${++n}`, name: `P${n}`, pos, team, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {},
});
/** A roster projected for `strength` points per starter-season. */
const roster = (strength: number): BoardPlayer[] => [bp("QB", strength), bp("RB", strength), bp("WR", strength)];
const team = (rosterId: number, strength: number, w = 0, l = 0): LeagueTeamInput =>
  ({ rosterId, name: `Team ${rosterId}`, players: roster(strength), wins: w, losses: l, ties: 0, pointsFor: w * 100 });

describe("eliminationNumber", () => {
  it("is the wins the last-spot holder needs to lock me out", () => {
    // I am 4-6 with 4 left (max 8). The 2nd-best other team has 7: it needs 2 more to reach 9 > 8.
    expect(eliminationNumber(4, [9, 7, 5], 4, 2)).toBe(2);
  });
  it("is 0 when I am already eliminated", () => {
    expect(eliminationNumber(2, [9, 8], 2, 2)).toBe(0);
  });
  it("is null when I cannot be eliminated (fewer rivals than spots)", () => {
    expect(eliminationNumber(2, [9], 2, 2)).toBeNull();
  });
  it("counts ties as half a win, like the standings", () => {
    // 4-5-1 with 4 left: ceiling 8.5; the last-spot holder has 7 -> needs 2 (7 + 2 = 9 > 8.5).
    expect(eliminationNumber(4.5, [9, 7, 5], 4, 2)).toBe(2);
    // Rival at 7.5 (7-2-1) already above my ceiling of 6 -> eliminated.
    expect(eliminationNumber(4, [7.5, 5], 2, 1)).toBe(0);
  });
});

describe("playoffOdds", () => {
  it("gives equal teams equal odds and one week of full leverage", () => {
    const teams = [team(1, 240), team(2, 240), team(3, 240), team(4, 240)];
    const r = playoffOdds({
      teams, schedule: { 10: [[1, 2], [3, 4]] }, currentWeek: 10, playoffWeekStart: 11, playoffTeams: 2,
      config: cfg, myRosterId: 1, sims: 600, seed: 3,
    });
    expect(r.remainingWeeks).toBe(1);
    expect(r.scheduleKnownThrough).toBe(10);
    for (const t of r.teams) {
      expect(t.playoffOdds).toBeGreaterThan(0.35);
      expect(t.playoffOdds).toBeLessThan(0.65);
      expect(t.seedDist.reduce((a, b) => a + b, 0)).toBeCloseTo(t.playoffOdds, 10);
    }
    // One game decides everything: win and I am in, lose and I am out.
    expect(r.oddsIfWin).toBeCloseTo(1, 6);
    expect(r.oddsIfLose).toBeCloseTo(0, 6);
    expect(r.leverage).toBeCloseTo(1, 6);
  });

  it("reports ADDITIONAL expected wins and passes half-wins to the elimination number", () => {
    // I am 3-1-1 (3.5 win-equivalents), rivals 2-3 with one 3-2; one week left, two spots.
    const teams = [{ ...team(1, 240, 3, 1), ties: 1 }, team(2, 240, 3, 2), team(3, 240, 2, 3), team(4, 240, 2, 3)];
    const r = playoffOdds({ teams, schedule: { 10: [[1, 2], [3, 4]] }, currentWeek: 10, playoffWeekStart: 11, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 300, seed: 2 });
    // Additional wins over one week: between 0 and 1, never the 3.5 already banked.
    expect(r.mine.expectedWins).toBeGreaterThan(0.2);
    expect(r.mine.expectedWins).toBeLessThan(0.8);
    // Ceiling 4.5; the 2nd-best rival without me has 2 wins -> needs floor(4.5 - 2) + 1 = 3, unreachable in one week.
    expect(r.eliminationNumber).toBe(3);
  });

  it("a clinched team has odds 1 and no leverage", () => {
    const teams = [team(1, 240, 10, 0), team(2, 240, 5, 5), team(3, 240, 1, 9), team(4, 240, 1, 9)];
    const r = playoffOdds({ teams, schedule: { 11: [[1, 2], [3, 4]] }, currentWeek: 11, playoffWeekStart: 12, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 300, seed: 1 });
    expect(r.mine.playoffOdds).toBe(1);
    expect(r.leverage).toBe(0);
    // Ceiling 10 + 1 = 11. The rival who would hold the LAST spot without me is the 2nd-best (1 win),
    // so it needs 11 - 1 + 1 = 11 more wins — unreachable in one week. Verified by the controller.
    expect(r.eliminationNumber).toBe(11);
    expect(r.eliminationNumber!).toBeGreaterThan(r.remainingWeeks);
  });

  it("an eliminated team has odds 0 and elimination number 0", () => {
    const teams = [team(1, 240, 0, 10), team(2, 240, 8, 2), team(3, 240, 8, 2), team(4, 240, 5, 5)];
    const r = playoffOdds({ teams, schedule: { 11: [[1, 2], [3, 4]] }, currentWeek: 11, playoffWeekStart: 12, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 300, seed: 1 });
    expect(r.mine.playoffOdds).toBe(0);
    expect(r.eliminationNumber).toBe(0);
    expect(r.leverage).toBe(0);
  });

  it("a stronger roster has better odds over several weeks", () => {
    const teams = [team(1, 320), team(2, 200), team(3, 200), team(4, 200)];
    const r = playoffOdds({ teams, schedule: {}, currentWeek: 8, playoffWeekStart: 14, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 400, seed: 9 });
    expect(r.remainingWeeks).toBe(6);
    expect(r.scheduleKnownThrough).toBe(7); // nothing known: every week is a random opponent
    expect(r.mine.playoffOdds).toBeGreaterThan(0.8);
    expect(r.mine.expectedWins).toBeGreaterThan(3.5);
    // With no known pairing this week, the conditional odds are unknown.
    expect(r.oddsIfWin).toBeNull();
    expect(r.leverage).toBeNull();
  });

  it("is deterministic for a given seed", () => {
    const teams = [team(1, 240), team(2, 220), team(3, 260), team(4, 240)];
    const args = { teams, schedule: { 10: [[1, 2], [3, 4]] as [number, number][] }, currentWeek: 10, playoffWeekStart: 12, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 200, seed: 5 };
    expect(JSON.stringify(playoffOdds(args))).toBe(JSON.stringify(playoffOdds(args)));
  });
});
