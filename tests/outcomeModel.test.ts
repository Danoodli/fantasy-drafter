import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutcomeParams } from "../lib/engine/outcomeModel";

const params: OutcomeParams = JSON.parse(
  readFileSync(join(process.cwd(), "config", "outcome-model.json"), "utf8")
);

describe("config/outcome-model.json", () => {
  it("was fitted on at least two seasons", () => {
    expect(params.fittedOn.length).toBeGreaterThanOrEqual(2);
    expect(params.weeks).toBe(17);
    expect(params.gamesPerSeason).toBe(16);
  });

  it("has sane per-position parameters", () => {
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
      const p = params.byPos[pos];
      expect(p.seasonEndingProb).toBeGreaterThanOrEqual(0);
      expect(p.seasonEndingProb).toBeLessThan(0.4);
      expect(p.healthyMissProb).toBeGreaterThanOrEqual(0);
      expect(p.healthyMissProb).toBeLessThan(0.3);
      expect(p.projLogSigma).toBeGreaterThan(0.05);
      expect(p.projLogSigma).toBeLessThan(1);
      expect(p.projMedianRatio).toBeGreaterThan(0.6);
      expect(p.projMedianRatio).toBeLessThan(1.4);
      expect(p.weeklyLogSigma).toBeGreaterThan(0.2);
      expect(p.weeklyLogSigma).toBeLessThan(1);
    }
  });

  it("encodes the measured facts the design depends on", () => {
    // RBs carry the most skill uncertainty; season-wrecking risk is ~15-20% at skill positions.
    expect(params.byPos.RB.projLogSigma).toBeGreaterThan(params.byPos.WR.projLogSigma);
    expect(params.byPos.RB.seasonEndingProb).toBeGreaterThan(0.1);
    expect(params.byPos.WR.seasonEndingProb).toBeGreaterThan(0.1);
    expect(params.teamCorrelation).toBeGreaterThan(0.15);
    expect(params.teamCorrelation).toBeLessThan(0.6);
    expect(params.marketWeight).toBeGreaterThanOrEqual(0);
    expect(params.marketWeight).toBeLessThanOrEqual(0.5);
  });
});
