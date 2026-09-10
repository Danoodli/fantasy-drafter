import { describe, it, expect } from "vitest";
import { waiverAdds, streamingOptions } from "../lib/engine/season/waivers";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 8, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
let n = 0;
const bp = (id: string, pos: Position, proj: number, over: Partial<BoardPlayer> = {}): BoardPlayer => ({
  id, name: id, pos, team: `T${++n}`, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {}, ...over,
});
// 9 players on an 8-round roster? No: rounds 8 is the roster cap, and this roster has 8, so every add needs a drop.
const roster = [
  bp("qb", "QB", 320), bp("rb1", "RB", 250), bp("rb2", "RB", 200), bp("wr1", "WR", 250), bp("wr2", "WR", 150),
  bp("te", "TE", 120), bp("wr3", "WR", 100), bp("rb3", "RB", 90),
];
const weeks = [10, 11, 12, 13, 14];

describe("waiverAdds", () => {
  it("values a WR who cracks my lineup, and drops the player who never did", () => {
    const wr = bp("wrNew", "WR", 220);
    const [top] = waiverAdds({ roster, available: [wr], weeks, config: cfg });
    expect(top.add.id).toBe("wrNew");
    expect(top.deltaPoints).toBeGreaterThan(0);
    // rb3 (90) never starts: dropping him costs nothing. wr3 would, a little (he was the flex).
    expect(top.drop?.id).toBe("rb3");
    expect(top.reason).toMatch(/\+\d/);
  });

  it("gives a good-in-the-abstract WR nothing when he would never crack my lineup", () => {
    const wr = bp("wrDeep", "WR", 95);
    expect(waiverAdds({ roster, available: [wr], weeks, config: cfg })).toEqual([]);
  });

  it("ranks several candidates by points added to MY lineup", () => {
    // c (95) beats neither te (120) nor the flex (wr3, 100); at 110 he WOULD take the flex — the controller checked.
    const adds = waiverAdds({ roster, available: [bp("a", "WR", 180), bp("b", "RB", 260), bp("c", "TE", 95)], weeks, config: cfg });
    expect(adds.map((x) => x.add.id)).toEqual(["b", "a"]);
    expect(adds[0].deltaPoints).toBeGreaterThan(adds[1].deltaPoints);
  });

  it("credits bye cover", () => {
    const thin = [bp("qb", "QB", 320), bp("rb1", "RB", 250, { bye: 12 }), bp("rb2", "RB", 200, { bye: 12 }), bp("wr1", "WR", 250), bp("wr2", "WR", 150), bp("te", "TE", 120), bp("k", "K", 130)];
    const [top] = waiverAdds({ roster: thin, available: [bp("rbCover", "RB", 80, { bye: 9 })], weeks, config: cfg, rosterMax: 8 });
    expect(top.add.id).toBe("rbCover");
    expect(top.drop).toBeNull(); // room on the roster
    expect(top.deltaCoverWeeks).toBe(1); // week 12: two empty RB slots become one
    expect(top.reason).toMatch(/slot-week/);
  });

  it("scales with the weeks considered", () => {
    const wr = bp("wrNew", "WR", 220);
    const five = waiverAdds({ roster, available: [wr], weeks, config: cfg })[0].deltaPoints;
    const one = waiverAdds({ roster, available: [wr], weeks: [10], config: cfg })[0].deltaPoints;
    expect(five / one).toBeCloseTo(5, 6);
  });

  it("uses this week's outlook for the current week", () => {
    const wr = bp("wrNew", "WR", 220);
    const outlook = { playerId: "wrNew", mean: 40, projected: true } as unknown as WeekOutlook;
    const plain = waiverAdds({ roster, available: [wr], weeks: [10], config: cfg })[0].deltaPoints;
    const hot = waiverAdds({ roster, available: [wr], weeks: [10], config: cfg, currentWeek: 10, outlooks: new Map([["wrNew", outlook]]) })[0].deltaPoints;
    expect(hot).toBeGreaterThan(plain);
  });

  it("respects maxResults and positions", () => {
    const pool = Array.from({ length: 12 }, (_, i) => bp(`w${i}`, "WR", 300 - i));
    expect(waiverAdds({ roster, available: pool, weeks, config: cfg, maxResults: 3 })).toHaveLength(3);
    expect(waiverAdds({ roster, available: [...pool, bp("r", "RB", 400)], weeks, config: cfg, positions: ["RB"] }).map((x) => x.add.id)).toEqual(["r"]);
  });

  it("skips a player on a season-long designation", () => {
    expect(waiverAdds({ roster, available: [bp("ir", "WR", 300, { injury: "IR" })], weeks, config: cfg })).toEqual([]);
  });
});

describe("streamingOptions", () => {
  it("is one position, one week, dropping the same position", () => {
    const withK = [...roster.slice(0, 7), bp("k", "K", 120)];
    const opts = streamingOptions({ roster: withK, available: [bp("kHot", "K", 150), bp("wrX", "WR", 400)], week: 10, pos: "K", config: cfg });
    expect(opts).toHaveLength(1);
    expect(opts[0].add.id).toBe("kHot");
    expect(opts[0].drop?.id).toBe("k");
    expect(opts[0].deltaPoints).toBeGreaterThan(0);
  });
});
