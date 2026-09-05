import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRng } from "../lib/engine/montecarlo";
import { sampleSeason, expectedWeekly, availability, makeTeamShocks, healthyRate } from "../lib/engine/outcome";
import type { OutcomeParams } from "../lib/engine/outcomeModel";
import type { BoardPlayer } from "../lib/types";

const params: OutcomeParams = JSON.parse(readFileSync(join(process.cwd(), "config", "outcome-model.json"), "utf8"));
const player = (over: Partial<BoardPlayer> = {}): BoardPlayer =>
  ({ id: "x", name: "x", pos: "WR", team: "KC", bye: 6, projPoints: 200, projImputed: false, adp: 30, adpStdev: 5,
     adpHigh: 20, adpLow: 40, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1, injury: null, depthOrder: 1,
     sosSeason: null, sosPlayoff: null, ids: {}, ...over }) as BoardPlayer;
const corr = (x: number[], y: number[]) => {
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return n / Math.sqrt(dx * dy);
};

describe("sampleSeason", () => {
  it("scores zero in the bye week and totals its weeks", () => {
    const rng = makeRng(3);
    const shocks = makeTeamShocks(rng, params.weeks);
    for (let i = 0; i < 200; i++) {
      const d = sampleSeason(player(), params, rng, shocks);
      expect(d.weekly[5]).toBe(0); // week 6 bye
      expect(d.weekly.length).toBe(17);
      expect(d.total).toBeCloseTo(Array.from(d.weekly).reduce((a, b) => a + b, 0), 6);
    }
  });

  it("has the calibrated mean: E[total] ≈ expectedWeekly × 16 within Monte Carlo error", () => {
    const rng = makeRng(11);
    const p = player();
    let sum = 0;
    const N = 20000;
    // Team shocks are per season: redraw them every iteration or the shared
    // team-week factor never averages out.
    for (let i = 0; i < N; i++) sum += sampleSeason(p, params, rng, makeTeamShocks(rng, params.weeks)).total;
    const expected = expectedWeekly(p, params) * 16;
    expect(Math.abs(sum / N - expected) / expected).toBeLessThan(0.03);
  });

  it("reproduces the season-ending rate", () => {
    const rng = makeRng(5);
    let ended = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const d = sampleSeason(player({ pos: "RB" }), params, rng, makeTeamShocks(rng, params.weeks));
      if (Array.from(d.weekly).filter((w) => w > 0).length <= 8) ended++;
    }
    const rate = ended / N;
    expect(rate).toBeGreaterThan(params.byPos.RB.seasonEndingProb * 0.7);
    expect(rate).toBeLessThan(params.byPos.RB.seasonEndingProb * 1.3 + 0.03);
  });

  it("correlates a QB with his own receiver and not with another team's", () => {
    const rng = makeRng(7);
    const qb = player({ id: "qb", pos: "QB", team: "KC", projPoints: 350 });
    const wr = player({ id: "wr", pos: "WR", team: "KC" });
    const other = player({ id: "o", pos: "WR", team: "BUF" });
    const a: number[] = [], b: number[] = [], c: number[] = [];
    for (let i = 0; i < 3000; i++) {
      const shocks = makeTeamShocks(rng, params.weeks);
      const dq = sampleSeason(qb, params, rng, shocks), dw = sampleSeason(wr, params, rng, shocks), dother = sampleSeason(other, params, rng, shocks);
      for (let w = 0; w < 17; w++) if (dq.weekly[w] > 0 && dw.weekly[w] > 0 && dother.weekly[w] > 0) { a.push(dq.weekly[w]); b.push(dw.weekly[w]); c.push(dother.weekly[w]); }
    }
    expect(corr(a, b)).toBeGreaterThan(params.teamCorrelation * 0.5);
    expect(Math.abs(corr(a, c))).toBeLessThan(0.1);
  });

  it("a draft-day 'Out' or 'Questionable' lowers availability", () => {
    expect(availability(player({ injury: "Out" }), params)).toBeLessThan(availability(player(), params));
    expect(availability(player({ injury: "Questionable" }), params)).toBeLessThan(availability(player(), params));
  });

  it("healthyRate applies the position bias and a projection override", () => {
    const p = player({ pos: "TE", projPoints: 160 });
    const base = healthyRate(p, params);
    expect(healthyRate(p, params, 320)).toBeCloseTo(base * 2, 6);
  });

  it("is deterministic for a seed", () => {
    const a = sampleSeason(player(), params, makeRng(42), makeTeamShocks(makeRng(1), 17));
    const b = sampleSeason(player(), params, makeRng(42), makeTeamShocks(makeRng(1), 17));
    expect(Array.from(a.weekly)).toEqual(Array.from(b.weekly));
  });
});
