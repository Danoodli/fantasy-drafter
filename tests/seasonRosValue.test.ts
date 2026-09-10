import { describe, it, expect } from "vitest";
import { weeklyMeans, meansFor, rosLineupValue, emptySlotWeeks, DEFAULT_OUTCOME } from "../lib/engine/season/rosValue";
import { expectedWeekly } from "../lib/engine/outcome";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 8, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
let n = 0;
const bp = (pos: Position, proj: number, over: Partial<BoardPlayer> = {}): BoardPlayer => ({
  id: `p${++n}`, name: `P${n}`, pos, team: `T${n}`, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {}, ...over,
});
const weeks = [10, 11, 12, 13, 14];
const ctx = { weeks, config: cfg };

describe("weeklyMeans", () => {
  it("is the season model's expected weekly points, flat across non-bye weeks", () => {
    const p = bp("WR", 200);
    const m = weeklyMeans(p, ctx);
    expect(m).toHaveLength(5);
    const e = expectedWeekly(p, DEFAULT_OUTCOME);
    for (const v of m) expect(v).toBeCloseTo(e, 10);
    expect(e).toBeGreaterThan(8); // 200 over 16 games, shrunk a little by availability
  });
  it("is zero in the bye week and nowhere else", () => {
    const m = weeklyMeans(bp("WR", 200, { bye: 12 }), ctx);
    expect(m[2]).toBe(0);
    expect(m[0]).toBeGreaterThan(0);
  });
  it("is zero every week for a season-long designation", () => {
    for (const injury of ["IR", "PUP", "Sus", "NA", "COV", "DNR"]) {
      expect(Array.from(weeklyMeans(bp("RB", 220, { injury }), ctx)).every((v) => v === 0)).toBe(true);
    }
  });
  it("uses this week's outlook mean for the current week only", () => {
    const p = bp("WR", 200);
    const outlook = { playerId: p.id, mean: 30, projected: true } as unknown as WeekOutlook;
    const m = weeklyMeans(p, { ...ctx, currentWeek: 10, outlooks: new Map([[p.id, outlook]]) });
    expect(m[0]).toBe(30);
    expect(m[1]).toBeCloseTo(expectedWeekly(p, DEFAULT_OUTCOME), 10);
  });
  it("ignores an outlook that projected nothing", () => {
    const p = bp("WR", 200);
    const outlook = { playerId: p.id, mean: 0, projected: false } as unknown as WeekOutlook;
    const m = weeklyMeans(p, { ...ctx, currentWeek: 10, outlooks: new Map([[p.id, outlook]]) });
    expect(m[0]).toBeCloseTo(expectedWeekly(p, DEFAULT_OUTCOME), 10);
  });
});

describe("rosLineupValue", () => {
  it("sums the optimal lineup's expected points over the weeks", () => {
    const roster = [bp("QB", 320), bp("RB", 250), bp("RB", 200), bp("WR", 240), bp("WR", 160), bp("TE", 120), bp("WR", 90)];
    const means = meansFor(roster, ctx);
    const v = rosLineupValue(roster, ctx, means);
    // Every player starts (7 players, 7 slots), so it is the plain sum.
    let sum = 0;
    for (const p of roster) for (const x of means.get(p.id)!) sum += x;
    expect(v).toBeCloseTo(sum, 8);
  });
  it("does not count a player who never cracks the lineup", () => {
    const roster = [bp("QB", 320), bp("RB", 250), bp("RB", 200), bp("WR", 240), bp("WR", 160), bp("TE", 120), bp("WR", 90)];
    const scrub = bp("WR", 40);
    const means = meansFor([...roster, scrub], ctx);
    expect(rosLineupValue([...roster, scrub], ctx, means)).toBeCloseTo(rosLineupValue(roster, ctx, means), 8);
  });
});

describe("emptySlotWeeks", () => {
  it("counts dedicated slot-weeks with no available body", () => {
    // Two RB slots; both RBs on a bye in week 12 -> 2 empty slot-weeks. One RB on IR -> 1 more per week.
    const roster = [bp("RB", 250, { bye: 12 }), bp("RB", 200, { bye: 12 }), bp("QB", 300), bp("WR", 200), bp("WR", 180), bp("TE", 100)];
    expect(emptySlotWeeks(roster, ctx)).toBe(2);
    expect(emptySlotWeeks([...roster.slice(1), bp("RB", 250, { injury: "IR" })], ctx)).toBe(2 + 4); // wk12: 2 empty; other 4 weeks: 1 empty
  });
  it("counts partial cover", () => {
    const roster = [bp("RB", 250, { bye: 12 }), bp("RB", 200, { bye: 12 }), bp("RB", 90, { bye: 9 }), bp("QB", 300), bp("WR", 200), bp("WR", 180), bp("TE", 100)];
    expect(emptySlotWeeks(roster, ctx)).toBe(1); // week 12 still has only one body for two slots
  });
});
