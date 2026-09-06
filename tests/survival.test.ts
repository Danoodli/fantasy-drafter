import { describe, it, expect } from "vitest";
import { survivalProb, sampleAdpNoise, normalCdf, DEFAULT_TAIL, type SurvivalTail } from "../lib/engine/survival";
import { makeRng } from "../lib/engine/montecarlo";

const player = { adp: 30, adpStdev: 6, adpHigh: 12, adpLow: 55, pos: "RB" as const };
const OFF: SurvivalTail = { tailScale: 1, wideShare: 0, wideFactor: 2.5 };

describe("survival tail lever", () => {
  it("ships off: config defaults are a plain normal", () => {
    expect(DEFAULT_TAIL.tailScale).toBe(1);
    expect(DEFAULT_TAIL.wideShare).toBe(0);
  });

  it("with the lever off, survival is the normal CDF on the published stdev", () => {
    const p = survivalProb(player, 36, {}, OFF);
    expect(p).toBeCloseTo(1 - normalCdf((36 - 30) / 6), 6);
  });

  it("a wide component fattens both tails: more survival far past ADP, less certainty just before it", () => {
    const fat: SurvivalTail = { tailScale: 1, wideShare: 0.3, wideFactor: 2.5 };
    // 20 picks after ADP (>3σ): the normal says ~0, the mixture keeps real mass.
    expect(survivalProb(player, 50, {}, fat)).toBeGreaterThan(survivalProb(player, 50, {}, OFF) + 0.02);
    // 6 picks before ADP: the normal is confident he's there; the mixture is less so.
    expect(survivalProb(player, 24, {}, fat)).toBeLessThan(survivalProb(player, 24, {}, OFF));
    // At ADP both say a coin flip.
    expect(survivalProb(player, 30, {}, fat)).toBeCloseTo(0.5, 2);
  });

  it("tailScale widens the whole distribution", () => {
    const wide: SurvivalTail = { tailScale: 1.5, wideShare: 0, wideFactor: 2.5 };
    expect(survivalProb(player, 40, {}, wide)).toBeGreaterThan(survivalProb(player, 40, {}, OFF));
    expect(survivalProb(player, 20, {}, wide)).toBeLessThan(survivalProb(player, 20, {}, OFF));
  });

  it("soft bounds still apply under any tail", () => {
    const fat: SurvivalTail = { tailScale: 2, wideShare: 0.3, wideFactor: 2.5 };
    expect(survivalProb(player, 10, {}, fat)).toBeGreaterThanOrEqual(0.95);
    expect(survivalProb(player, 60, {}, fat)).toBeLessThanOrEqual(0.05);
  });

  it("with the lever off, the sampler is exactly Box–Muller on the same rng stream", () => {
    const a = makeRng(7);
    const b = makeRng(7);
    const reference = () => {
      let u = 0;
      while (u === 0) u = b();
      return 6 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * b());
    };
    for (let i = 0; i < 50; i++) expect(sampleAdpNoise(a, 6, OFF)).toBeCloseTo(reference(), 12);
  });

  it("a wide component raises the sampled spread by the expected amount", () => {
    const fat: SurvivalTail = { tailScale: 1, wideShare: 0.3, wideFactor: 2.5 };
    const rng = makeRng(11);
    const n = 20000;
    let s2off = 0, s2fat = 0;
    for (let i = 0; i < n; i++) s2off += sampleAdpNoise(rng, 1, OFF) ** 2;
    for (let i = 0; i < n; i++) s2fat += sampleAdpNoise(rng, 1, fat) ** 2;
    const expected = 0.7 + 0.3 * 2.5 ** 2; // mixture variance
    expect(s2off / n).toBeCloseTo(1, 1);
    expect(s2fat / n).toBeCloseTo(expected, 0);
  });
});
