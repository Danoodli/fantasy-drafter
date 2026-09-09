import { describe, it, expect } from "vitest";
import { projectedVolume, weeklySigma, lognormalQuantile } from "../lib/engine/weekly/spread";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = DEFAULT_WEEKLY_MODEL;
const ON: WeeklyModelParams = { ...OFF, sigma: { ...OFF.sigma, delta: 0.35 } };

describe("projectedVolume", () => {
  it("counts the touches that matter for the position", () => {
    expect(projectedVolume("RB", { rushYds: 80, receptions: 3 })).toBeGreaterThan(0);
    expect(projectedVolume("QB", { passYds: 250 })).toBeGreaterThan(0);
    expect(projectedVolume("WR", { receptions: 5, recYds: 70 })).toBeGreaterThan(0);
    expect(projectedVolume("DST", {})).toBeGreaterThan(0); // never zero — sigma must not divide by it
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

  it("is finite and positive at zero volume rather than exploding", () => {
    const s = weeklySigma("WR", 0, ON);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(3);
  });

  it("falls back to a sane default for a position with no fitted sigma", () => {
    const bare: WeeklyModelParams = { ...OFF, sigma: { sigma0: {}, v0: {}, delta: 0 } };
    expect(weeklySigma("WR", 8, bare)).toBeGreaterThan(0);
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
