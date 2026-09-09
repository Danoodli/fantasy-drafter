import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEEKLY_MODEL,
  loadWeeklyModel,
  correlationAmplitudes,
  unitOf,
} from "../lib/engine/weekly/model";

describe("weekly model config", () => {
  it("ships in its off state: usage weight 0, no adjustments", () => {
    const m = DEFAULT_WEEKLY_MODEL;
    expect(m.modelWeights.usage).toBe(0);
    expect(m.modelWeights.market).toBe(1);
    expect(m.sourceWeights.sleeper).toBe(1);
    expect(m.sourceWeights.espn).toBe(0);
    expect(m.sourceWeights.dk).toBe(0);
    expect(Object.keys(m.environment.alpha)).toHaveLength(0);
    expect(Object.keys(m.environment.beta)).toHaveLength(0);
    expect(Object.keys(m.matchup.gamma)).toHaveLength(0);
    expect(m.sigma.delta).toBe(0);
  });

  it("derives amplitudes from nested correlations and they sum to one in square", () => {
    const a = correlationAmplitudes({ game: 0.1, team: 0.3, unit: 0.45, dstVsOppTeam: 0.2 });
    expect(a.game).toBeCloseTo(Math.sqrt(0.1), 10);
    expect(a.team).toBeCloseTo(Math.sqrt(0.2), 10);
    expect(a.unit).toBeCloseTo(Math.sqrt(0.15), 10);
    expect(a.player).toBeCloseTo(Math.sqrt(0.55), 10);
    const sumSq = a.game ** 2 + a.team ** 2 + a.unit ** 2 + a.player ** 2;
    expect(sumSq).toBeCloseTo(1, 10);
  });

  it("rejects out-of-order correlations instead of producing a NaN amplitude", () => {
    expect(() =>
      loadWeeklyModel({ ...DEFAULT_WEEKLY_MODEL, correlation: { game: 0.4, team: 0.2, unit: 0.5, dstVsOppTeam: 0 } })
    ).toThrow(/nesting/i);
    expect(() =>
      loadWeeklyModel({ ...DEFAULT_WEEKLY_MODEL, correlation: { game: 0.1, team: 0.2, unit: 1.4, dstVsOppTeam: 0 } })
    ).toThrow(/range/i);
  });

  it("maps positions to correlation units", () => {
    expect(unitOf("QB")).toBe("pass");
    expect(unitOf("WR")).toBe("pass");
    expect(unitOf("TE")).toBe("pass");
    expect(unitOf("RB")).toBe("run");
    expect(unitOf("K")).toBe("run");
  });
});
