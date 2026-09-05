import { describe, it, expect } from "vitest";
import {
  spearman,
  pairwiseAccuracy,
  projectionReport,
  biggestMisses,
  realizedValue,
  type ProjRow,
} from "../lib/engine/evaluate";
import type { LeagueConfig } from "../lib/types";

const row = (id: string, pos: ProjRow["pos"], proj: number, actual: number): ProjRow => ({
  id, name: id, pos, proj, actual, adp: 0,
});

describe("spearman", () => {
  it("is 1 for identical ordering and -1 for reversed", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
  });
  it("ignores scale — only ranks matter", () => {
    expect(spearman([1, 2, 3], [100, 2000, 30000])).toBeCloseTo(1);
  });
});

describe("pairwiseAccuracy", () => {
  it("is 1 when every pair is ordered correctly", () => {
    expect(pairwiseAccuracy([{ proj: 1, actual: 1 }, { proj: 2, actual: 2 }, { proj: 3, actual: 3 }])).toBe(1);
  });
  it("counts one swapped pair out of three", () => {
    // proj order A<B<C, actual order A<C<B: pairs (A,B) ok, (A,C) ok, (B,C) wrong
    expect(
      pairwiseAccuracy([{ proj: 1, actual: 1 }, { proj: 2, actual: 3 }, { proj: 3, actual: 2 }])
    ).toBeCloseTo(2 / 3);
  });
  it("skips tied pairs rather than counting them as wrong", () => {
    expect(pairwiseAccuracy([{ proj: 1, actual: 1 }, { proj: 1, actual: 5 }, { proj: 2, actual: 9 }])).toBe(1);
  });
});

describe("projectionReport", () => {
  const rows = [
    row("a", "RB", 100, 120),
    row("b", "RB", 200, 180),
    row("c", "WR", 150, 150),
    row("d", "WR", 250, 210),
  ];
  it("computes MAE and signed bias (actual minus projected)", () => {
    const r = projectionReport(rows);
    expect(r.n).toBe(4);
    expect(r.mae).toBeCloseTo((20 + 20 + 0 + 40) / 4);
    expect(r.bias).toBeCloseTo((20 - 20 + 0 - 40) / 4); // -10: we over-projected
  });
  it("groups by position", () => {
    const r = projectionReport(rows);
    expect(r.byPos.RB?.n).toBe(2);
    expect(r.byPos.RB?.bias).toBeCloseTo(0);
    expect(r.byPos.WR?.bias).toBeCloseTo(-20);
    expect(r.byPos.QB).toBeUndefined();
  });
});

describe("biggestMisses", () => {
  it("returns the worst busts and best booms by actual - proj", () => {
    const rows = [row("bust", "RB", 300, 50), row("meh", "WR", 100, 105), row("boom", "WR", 100, 300)];
    const { busts, booms } = biggestMisses(rows, 1);
    expect(busts[0].id).toBe("bust");
    expect(booms[0].id).toBe("boom");
  });
});

describe("realizedValue", () => {
  const config: LeagueConfig = {
    platform: "manual", leagueId: "", draftId: "", myDraftSlot: 1, teams: 12, rounds: 15,
    scoring: "ppr", leagueType: "redraft",
    rosterSlots: { QB: 1, RB: 1, WR: 0, TE: 0, FLEX: 0, K: 0, DST: 0 },
    flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
  };
  it("sums the optimal lineup week by week, treating a missing week as zero", () => {
    const roster = [
      { pos: "QB" as const, weekly: [10, 20] },
      { pos: "RB" as const, weekly: [5, null] }, // bye in week 2
      { pos: "RB" as const, weekly: [7, 7] },
    ];
    const v = realizedValue(roster, config);
    expect(v.weeklyLineup).toBe(10 + 7 + (20 + 7)); // 44
    expect(v.seasonTotal).toBe(10 + 20 + 5 + 7 + 7); // 49
  });
  it("is zero for an empty roster", () => {
    expect(realizedValue([], config).weeklyLineup).toBe(0);
  });
});
