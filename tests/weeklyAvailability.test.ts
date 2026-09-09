import { describe, it, expect } from "vitest";
import { pPlay, FALLBACK_PLAY_PROB } from "../lib/engine/weekly/availability";
import { SEASON_LONG } from "../lib/engine/injuryFeed";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = DEFAULT_WEEKLY_MODEL;

describe("pPlay", () => {
  it("a bye is zero, unconditionally — no status can rescue it", () => {
    expect(pPlay(null, true, OFF)).toBe(0);
    expect(pPlay("Questionable", true, OFF)).toBe(0);
  });

  it("healthy players are near-certain but not certain", () => {
    const p = pPlay(null, false, OFF);
    expect(p).toBeGreaterThan(0.9);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("ranks statuses in the only order that makes sense", () => {
    expect(pPlay("Questionable", false, OFF)).toBeLessThan(pPlay(null, false, OFF));
    expect(pPlay("Doubtful", false, OFF)).toBeLessThan(pPlay("Questionable", false, OFF));
    expect(pPlay("Out", false, OFF)).toBeLessThan(pPlay("Doubtful", false, OFF));
  });

  it("zeroes EVERY season-long designation, from the codebase's shared set", () => {
    // Not a hand-copied list: SEASON_LONG is the same set recommend.ts excludes
    // on. An earlier draft copied a subset here and dropped COV and DNR, which
    // silently returned COVID-list and did-not-report players to full strength.
    for (const status of SEASON_LONG) {
      expect(pPlay(status, false, OFF)).toBe(0);
    }
    expect(SEASON_LONG.has("COV")).toBe(true);
    expect(SEASON_LONG.has("DNR")).toBe(true);
  });

  it("takes the healthy rate from config when fitted", () => {
    const fitted: WeeklyModelParams = {
      ...OFF,
      availability: { ...OFF.availability, healthy: 0.93 },
    };
    expect(pPlay(null, false, fitted)).toBeCloseTo(0.93, 10);
    expect(pPlay("Probable", false, fitted)).toBeCloseTo(0.93, 10);
  });

  it("prefers a fitted table over the fallback when one exists", () => {
    const fitted: WeeklyModelParams = {
      ...OFF,
      availability: { byStatus: { Questionable: 0.42 } },
    };
    expect(pPlay("Questionable", false, fitted)).toBeCloseTo(0.42, 10);
    // Unfitted statuses still fall back rather than becoming undefined.
    expect(pPlay("Doubtful", false, fitted)).toBeCloseTo(FALLBACK_PLAY_PROB.Doubtful, 10);
  });

  it("treats an unrecognized status as healthy rather than as out", () => {
    expect(pPlay("Probable", false, OFF)).toBe(pPlay(null, false, OFF));
  });
});
