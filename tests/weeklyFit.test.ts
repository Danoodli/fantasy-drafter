import { describe, it, expect } from "vitest";
import {
  olsSlope,
  olsFit,
  MIN_ABS_T,
  stdev,
  pearson,
  fitSigmaByVolume,
  empiricalPlayRate,
  pitCoverage,
} from "../lib/engine/weekly/fit";

describe("olsSlope", () => {
  it("recovers a known slope", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 + 2 * x);
    expect(olsSlope(xs, ys)).toBeCloseTo(2, 10);
  });
  it("is zero when x has no variance, rather than NaN", () => {
    expect(olsSlope([2, 2, 2], [1, 5, 9])).toBe(0);
  });
  it("is zero on fewer than three points — a two-point 'fit' is a line, not evidence", () => {
    expect(olsSlope([1, 2], [1, 4])).toBe(0);
  });
});

describe("olsFit significance", () => {
  it("reports a large t for a clean relationship and a small one for noise", () => {
    const xs = Array.from({ length: 400 }, (_, i) => i / 400);
    const clean = olsFit(xs, xs.map((x) => 2 * x));
    expect(clean.slope).toBeCloseTo(2, 6);
    expect(Math.abs(clean.t)).toBeGreaterThan(MIN_ABS_T);
    // Deterministic alternating noise, uncorrelated with x by construction.
    const noise = olsFit(xs, xs.map((_, i) => (i % 2 ? 1 : -1)));
    expect(Math.abs(noise.t)).toBeLessThan(MIN_ABS_T);
  });

  it("is not estimable without variance or enough points", () => {
    expect(olsFit([2, 2, 2], [1, 5, 9])).toEqual({ slope: 0, se: 0, t: 0, n: 3 });
    expect(olsFit([1, 2], [1, 4]).t).toBe(0);
  });

  it("agrees with olsSlope, which now delegates to it", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 + 2 * x);
    expect(olsSlope(xs, ys)).toBeCloseTo(olsFit(xs, ys).slope, 12);
  });
});

describe("fitSigmaByVolume degenerate input", () => {
  it("degrades to a flat sd when there are too few points to bucket", () => {
    const points = Array.from({ length: 12 }, (_, i) => ({ volume: 8, logResidual: i % 2 ? 0.5 : -0.5 }));
    const { sigma0, delta } = fitSigmaByVolume(points, 8);
    expect(delta).toBe(0);
    expect(sigma0).toBeCloseTo(stdev(points.map((p) => p.logResidual)), 10);
  });

  it("never returns NaN when every bucket is unusable", () => {
    // All-identical volumes AND zero spread: every bucket has sd 0 and is
    // filtered, which previously left the means as 0/0.
    const points = Array.from({ length: 80 }, () => ({ volume: 8, logResidual: 0 }));
    const { sigma0, delta } = fitSigmaByVolume(points, 8);
    expect(Number.isFinite(sigma0)).toBe(true);
    expect(Number.isFinite(delta)).toBe(true);
  });
});

describe("stdev and pearson", () => {
  it("stdev of a constant is zero", () => expect(stdev([4, 4, 4])).toBe(0));
  it("pearson of identical series is 1", () => expect(pearson([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10));
  it("pearson of opposed series is -1", () => expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10));
  it("pearson is 0 when a series is flat", () => expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0));
});

describe("fitSigmaByVolume", () => {
  it("recovers sigma0 and a positive delta from synthetic data where low volume is noisier", () => {
    const points: { volume: number; logResidual: number }[] = [];
    // sigma(v) = 0.8 * (8/v)^0.4 ; emit +/- sigma so the bucket sd equals it.
    for (const v of [2, 4, 8, 16, 32]) {
      const s = 0.8 * Math.pow(8 / v, 0.4);
      for (let i = 0; i < 200; i++) points.push({ volume: v, logResidual: i % 2 ? s : -s });
    }
    const { sigma0, delta } = fitSigmaByVolume(points, 8);
    expect(sigma0).toBeCloseTo(0.8, 1);
    expect(delta).toBeGreaterThan(0.25);
    expect(delta).toBeLessThan(0.55);
  });

  it("returns delta 0 when volume carries no information", () => {
    const points = Array.from({ length: 500 }, (_, i) => ({ volume: 1 + (i % 20), logResidual: i % 2 ? 0.5 : -0.5 }));
    expect(Math.abs(fitSigmaByVolume(points, 8).delta)).toBeLessThan(0.1);
  });
});

describe("empiricalPlayRate", () => {
  /** n rows of one status, `played` true for the first `k`. */
  const rows = (status: string | null, n: number, k: number) =>
    Array.from({ length: n }, (_, i) => ({ status, played: i < k }));

  it("measures P(played | status) per designation", () => {
    // Each status needs at least MIN_STATUS_N (20) observations to be reported
    // at all, so the fixture supplies 40 Questionable at a 0.75 rate and 20 Out
    // at 0. Do NOT lower the threshold to fit a smaller fixture: at n=2 a
    // proportion's 95% interval spans essentially [0,1], which is precisely the
    // case the guard exists to reject.
    const t = empiricalPlayRate([
      ...rows("Questionable", 40, 30),
      ...rows("Out", 20, 0),
      ...rows(null, 30, 30),
    ]);
    expect(t.Questionable).toBeCloseTo(0.75, 10);
    expect(t.Out).toBe(0);
    // A null designation is not a status and must not appear in the table.
    expect(t.null).toBeUndefined();
  });

  it("ignores designations with too few observations to mean anything", () => {
    // 19 is one short of the threshold, so it is omitted even though it has far
    // more evidence than the single-row case. 20 is reported.
    expect(empiricalPlayRate(rows("Sus", 19, 10)).Sus).toBeUndefined();
    expect(empiricalPlayRate(rows("Sus", 20, 10)).Sus).toBeCloseTo(0.5, 10);
    expect(empiricalPlayRate([{ status: "Sus", played: false }]).Sus).toBeUndefined();
  });
});

describe("pitCoverage", () => {
  it("reports ~10% below p10 and ~10% above p90 for a correctly-specified model", () => {
    // Lognormal with mean 10, sigma 0.6; sample its own quantiles evenly.
    const pairs = [];
    for (let i = 1; i < 1000; i++) {
      const q = i / 1000;
      const mu = Math.log(10) - 0.18;
      const actual = Math.exp(mu + 0.6 * Math.sqrt(2) * inverseErf(2 * q - 1));
      pairs.push({ actual, mean: 10, sigma: 0.6 });
    }
    const { below10, above90 } = pitCoverage(pairs);
    expect(below10).toBeGreaterThan(0.07);
    expect(below10).toBeLessThan(0.13);
    expect(above90).toBeGreaterThan(0.07);
    expect(above90).toBeLessThan(0.13);
  });
});

/** Tiny inverse error function, test-local — the module under test must not need it. */
function inverseErf(x: number): number {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
}
