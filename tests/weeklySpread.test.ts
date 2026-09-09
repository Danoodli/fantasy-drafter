import { describe, it, expect } from "vitest";
import { projectedVolume, weeklySigma, lognormalQuantile } from "../lib/engine/weekly/spread";
import { OFF_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = OFF_WEEKLY_MODEL;
const ON: WeeklyModelParams = { ...OFF, sigma: { ...OFF.sigma, delta: 0.35 } };

describe("projectedVolume", () => {
  it("counts the touches that matter for the position, on the right scale", () => {
    // Asserting VALUES, not just > 0: a version where every branch returned
    // MIN_VOLUME would satisfy a bare positivity check.
    expect(projectedVolume("RB", { rushYds: 86, receptions: 3 })).toBeCloseTo(86 / 4.3 + 3, 6);
    expect(projectedVolume("QB", { passYds: 250 })).toBeCloseTo(250 / 7.5, 6);
    expect(projectedVolume("WR", { receptions: 5, recYds: 70 })).toBeCloseTo(5 / 0.65, 6);
    expect(projectedVolume("TE", { receptions: 5, recYds: 70 })).toBeCloseTo(5 / 0.65, 6);
  });

  it("floors at MIN_VOLUME so it can never be a zero denominator", () => {
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
      expect(projectedVolume(pos, {})).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe("weeklySigma", () => {
  it("in the off state (delta 0) is the flat per-position sigma", () => {
    expect(weeklySigma("WR", 2, OFF)).toBeCloseTo(OFF.sigma.sigma0.WR!, 10);
    expect(weeklySigma("WR", 14, OFF)).toBeCloseTo(OFF.sigma.sigma0.WR!, 10);
  });

  it("with the lever on, high-volume players are less volatile than low-volume ones", () => {
    const bigBack = weeklySigma("RB", 22, ON);
    const flier = weeklySigma("RB", 4, ON);
    expect(bigBack).toBeLessThan(flier);
  });

  it("floors zero volume at MIN_VOLUME rather than letting the clamp absorb it", () => {
    // Exact value matters: without the MIN_VOLUME floor, v0/v is Infinity and
    // the clamp alone would return 2.5 — still finite, positive and < 3, so a
    // loose assertion could not tell the floor was gone.
    expect(weeklySigma("WR", 0, ON)).toBeCloseTo(2.0148, 3);
  });

  it("keeps K and DST flat whatever delta is — they have no touch count", () => {
    // K is the case that catches a v0-coincidence: v0.K is 2 while its volume
    // is a constant 1, so a v0-dependent path would give ~0.70, not 0.55.
    for (const delta of [0, 0.35, 1]) {
      const p: WeeklyModelParams = { ...ON, sigma: { ...ON.sigma, delta } };
      expect(weeklySigma("K", 1, p)).toBeCloseTo(OFF.sigma.sigma0.K!, 10);
      expect(weeklySigma("DST", 1, p)).toBeCloseTo(OFF.sigma.sigma0.DST!, 10);
    }
  });

  it("falls back for a position with neither a fitted sigma nor a fitted v0", () => {
    // delta must be NONZERO or the early return fires and V0_FALLBACK is never read.
    const bare: WeeklyModelParams = { ...OFF, sigma: { sigma0: {}, v0: {}, delta: 0.35 } };
    // SIGMA_FALLBACK 0.8, V0_FALLBACK 8, volume 8 => ratio 1 => exactly 0.8.
    expect(weeklySigma("WR", 8, bare)).toBeCloseTo(0.8, 10);
    // And it still varies with volume, proving V0_FALLBACK is in play.
    expect(weeklySigma("WR", 2, bare)).toBeGreaterThan(weeklySigma("WR", 32, bare));
  });
});

describe("lognormalQuantile", () => {
  it("the median of a lognormal sits below its mean", () => {
    const mean = 12;
    const sigma = 0.8;
    expect(lognormalQuantile(mean, sigma, 0.5)).toBeLessThan(mean);
  });

  it("quantiles are ordered and straddle the mean", () => {
    const p10 = lognormalQuantile(12, 0.8, 0.1);
    const p50 = lognormalQuantile(12, 0.8, 0.5);
    const p90 = lognormalQuantile(12, 0.8, 0.9);
    expect(p10).toBeLessThan(p50);
    expect(p50).toBeLessThan(p90);
    expect(p10).toBeGreaterThan(0);
    expect(p90).toBeGreaterThan(12);
  });

  it("a zero mean stays zero — a benched player has no ceiling", () => {
    expect(lognormalQuantile(0, 0.8, 0.9)).toBe(0);
  });
});
