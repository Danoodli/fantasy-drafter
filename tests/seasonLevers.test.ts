import { describe, it, expect } from "vitest";
import { loadSeasonLevers, DEFAULT_SEASON_LEVERS } from "../lib/engine/season/levers";

const good = { forcedPlayThreshold: 0.1, minDeltaWin: 0.002, riskFromPlayoffOdds: 0, pointsScale: 100, fallbackTotalCv: 0.35, minWaiverPoints: 0.5 };

describe("loadSeasonLevers", () => {
  it("loads the shipped config, which ships with the risk dial OFF", () => {
    expect(DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds).toBe(0);
    expect(DEFAULT_SEASON_LEVERS.forcedPlayThreshold).toBeGreaterThan(0);
  });

  it("names the field when a lever is out of range", () => {
    expect(() => loadSeasonLevers({ ...good, forcedPlayThreshold: 1 })).toThrow(/forcedPlayThreshold/);
    expect(() => loadSeasonLevers({ ...good, minDeltaWin: -0.1 })).toThrow(/minDeltaWin/);
    expect(() => loadSeasonLevers({ ...good, riskFromPlayoffOdds: 1.5 })).toThrow(/riskFromPlayoffOdds/);
    expect(() => loadSeasonLevers({ ...good, pointsScale: 0 })).toThrow(/pointsScale/);
    expect(() => loadSeasonLevers({ ...good, pointsScale: "100" })).toThrow(/pointsScale/);
    expect(() => loadSeasonLevers({ ...good, fallbackTotalCv: 0 })).toThrow(/fallbackTotalCv/);
    expect(() => loadSeasonLevers({ ...good, fallbackTotalCv: 2.1 })).toThrow(/fallbackTotalCv/);
    expect(() => loadSeasonLevers({ ...good, minWaiverPoints: -0.1 })).toThrow(/minWaiverPoints/);
    expect(() => loadSeasonLevers({ ...good, minWaiverPoints: 10.1 })).toThrow(/minWaiverPoints/);
  });

  it("rejects a missing object rather than throwing an opaque TypeError", () => {
    expect(() => loadSeasonLevers(null)).toThrow(/season\.json/);
  });
});
