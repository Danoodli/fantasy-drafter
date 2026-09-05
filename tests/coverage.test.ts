// Insurance math: a bench player is worth the starting slots he fills that
// the roster would otherwise leave EMPTY. Bye weeks make some of those holes
// certain, not probabilistic — holding 2 WR for 2 WR slots guarantees a hole.
import { describe, it, expect } from "vitest";
import { coverageSlotWeeks, coverageValue, REG_SEASON_WEEKS } from "../lib/engine/coverage";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: 1, teams: 12, rounds: 15,
  scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

const p = (pos: Position, bye: number | null, projPoints = 170): BoardPlayer =>
  ({ id: `${pos}-${bye}-${projPoints}`, name: "x", pos, team: "T", bye, projPoints,
     projImputed: false, adp: 100, adpStdev: 10, adpHigh: 90, adpLow: 110, ecr: null,
     ecrStdev: null, vorp: 0, vols: 0, tier: 1, injury: null, depthOrder: 1,
     sosSeason: null, sosPlayoff: null, ids: {} }) as BoardPlayer;

describe("coverageSlotWeeks", () => {
  it("is large for a 3rd WR when two WRs fill two slots — their byes are guaranteed holes", () => {
    const roster = [p("WR", 5), p("WR", 10)];
    const weeks = coverageSlotWeeks("WR", 8, roster, config);
    // Weeks 5 and 10 leave a slot empty for certain, plus injury cover.
    expect(weeks).toBeGreaterThan(2);
  });

  it("is near zero for an 8th RB — the slots are already covered every week", () => {
    const roster = Array.from({ length: 7 }, (_, i) => p("RB", i + 4));
    const weeks = coverageSlotWeeks("RB", 12, roster, config);
    expect(weeks).toBeLessThan(0.5);
  });

  it("ranks the 3rd WR above the 8th RB — the bug that produced 7 RB / 2 WR", () => {
    const roster = [
      ...Array.from({ length: 7 }, (_, i) => p("RB", i + 4)),
      p("WR", 5), p("WR", 10),
    ];
    const wr3 = coverageSlotWeeks("WR", 8, roster, config);
    const rb8 = coverageSlotWeeks("RB", 8, roster, config);
    expect(wr3).toBeGreaterThan(rb8 * 5);
  });

  it("gives a candidate no credit in his own bye week", () => {
    const roster = [p("WR", 7), p("WR", 7)]; // both WRs out in week 7
    const sameBye = coverageSlotWeeks("WR", 7, roster, config);
    const otherBye = coverageSlotWeeks("WR", 3, roster, config);
    expect(otherBye).toBeGreaterThan(sameBye);
  });

  it("values the first backup far more than the second", () => {
    const two = [p("WR", 5), p("WR", 10)];
    const three = [...two, p("WR", 8)];
    expect(coverageSlotWeeks("WR", 3, two, config)).toBeGreaterThan(
      coverageSlotWeeks("WR", 3, three, config)
    );
  });

  it("covers a lone starter's bye even at an exempt position like TE", () => {
    const roster = [p("TE", 6)];
    expect(coverageSlotWeeks("TE", 9, roster, config)).toBeGreaterThan(1);
  });

  it("is zero for a position the league does not roster", () => {
    const bb: LeagueConfig = { ...config, rosterSlots: { ...config.rosterSlots, K: 0, DST: 0 } };
    expect(coverageSlotWeeks("K", 5, [], bb)).toBe(0);
  });

  it("never exceeds the number of weeks in a season", () => {
    expect(coverageSlotWeeks("WR", null, [], config)).toBeLessThanOrEqual(REG_SEASON_WEEKS);
  });

  it("is deterministic", () => {
    const roster = [p("WR", 5), p("WR", 10)];
    expect(coverageSlotWeeks("WR", 8, roster, config)).toBe(
      coverageSlotWeeks("WR", 8, roster, config)
    );
  });
});

describe("coverageValue", () => {
  it("has no structural position bias: same projection and same hole land within injury-rate noise", () => {
    // The old VORP bench math priced this 2-3x apart. RBs miss slightly more
    // games than WRs, so a small gap is real football; a large one is a bug.
    const wrRoster = [p("WR", 5), p("WR", 10)];
    const rbRoster = [p("RB", 5), p("RB", 10)];
    const wr = coverageValue(p("WR", 8, 180), wrRoster, config);
    const rb = coverageValue(p("RB", 8, 180), rbRoster, config);
    expect(Math.abs(wr - rb) / Math.max(wr, rb)).toBeLessThan(0.15);
  });

  it("scales with the player's own scoring rate", () => {
    const roster = [p("WR", 5), p("WR", 10)];
    const good = coverageValue(p("WR", 8, 220), roster, config);
    const weak = coverageValue(p("WR", 8, 90), roster, config);
    expect(good).toBeGreaterThan(weak);
  });

  it("nets out what the waiver wire offers, and floors at zero", () => {
    const roster = [p("TE", 6)];
    const full = coverageValue(p("TE", 9, 140), roster, config);          // best ball: no wire
    const streamed = coverageValue(p("TE", 9, 140), roster, config, 6.5); // redraft: wire pays ~6.5/wk
    expect(streamed).toBeLessThan(full);
    expect(streamed).toBeGreaterThan(0);
    // A backup no better than the wire is worth nothing.
    expect(coverageValue(p("TE", 9, 100), roster, config, 6.5)).toBe(0);
  });

  it("is never negative", () => {
    const roster = Array.from({ length: 8 }, (_, i) => p("RB", i + 4));
    expect(coverageValue(p("RB", 12, 40), roster, config)).toBeGreaterThanOrEqual(0);
  });
});
