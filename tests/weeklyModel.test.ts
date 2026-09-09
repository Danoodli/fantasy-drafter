import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEEKLY_MODEL,
  loadWeeklyModel,
  correlationAmplitudes,
  unitOf,
} from "../lib/engine/weekly/model";

// The documented off state, hand-written to match the comment at the top of
// lib/engine/weekly/model.ts — independent of OFF_WEEKLY_MODEL, so a drift
// between the doc comment and the exported literal is caught here rather than
// by a test that imports the very thing it is meant to pin.
const OFF_STATE = {
  fittedOn: [], sourceWeights: { sleeper: 1, espn: 0, dk: 0 },
  modelWeights: { market: 1, usage: 0 },
  usage: { lambda: 0.75, priorGames: 4, effReliability: 0.15 },
  environment: { alpha: {}, beta: {}, leagueAvgItp: 22.5 },
  matchup: { gamma: {}, shrinkGames: 6, priorSeasonWeight: 0.5, dvpLambda: 0.85 },
  sigma: { sigma0: {}, v0: {}, delta: 0 },
  availability: { byStatus: {} },
  correlation: { game: 0, team: 0.28, unit: 0.28, dstVsOppTeam: 0 },
};

describe("weekly model config", () => {
  it("the documented off state is loadable and neutral", () => {
    const m = loadWeeklyModel(OFF_STATE);
    expect(m.modelWeights.usage).toBe(0);
    expect(Object.keys(m.environment.alpha)).toHaveLength(0);
    expect(m.sigma.delta).toBe(0);
  });

  it("the shipped config is valid and has been fitted", () => {
    const m = loadWeeklyModel(DEFAULT_WEEKLY_MODEL);
    expect(m.fittedOn.length).toBeGreaterThan(0);
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

  it("rejects a game/DST pair that leaves a defense no residual variance", () => {
    // Each value is individually legal and the nesting chain holds; only their
    // SUM is impossible. Without this check the DST residual amplitude clamps
    // to 0 and every defense silently carries a total variance of 1.2.
    expect(() =>
      loadWeeklyModel({
        ...DEFAULT_WEEKLY_MODEL,
        correlation: { game: 0.6, team: 0.7, unit: 0.8, dstVsOppTeam: 0.6 },
      })
    ).toThrow(/residual variance/i);
  });

  it("validates the SHIPPED config on import, not just on demand", () => {
    // DEFAULT_WEEKLY_MODEL is loadWeeklyModel(json), not a bare cast. Before
    // this, every guard below was dead code in production: the correlation
    // nesting check never ran on the file the engine actually uses, and
    // calibrate-weekly.ts WRITES that file.
    expect(() => loadWeeklyModel(DEFAULT_WEEKLY_MODEL)).not.toThrow();
  });

  it("rejects out-of-range levers, naming the offending field", () => {
    const bad = (patch: Record<string, unknown>) => () =>
      loadWeeklyModel({ ...DEFAULT_WEEKLY_MODEL, ...patch });
    // A zero lambda collapses a recency weight sum; a zero denominator NaNs a blend.
    expect(bad({ usage: { ...DEFAULT_WEEKLY_MODEL.usage, lambda: 0 } })).toThrow(/usage\.lambda/);
    expect(bad({ usage: { ...DEFAULT_WEEKLY_MODEL.usage, priorGames: 0 } })).toThrow(/usage\.priorGames/);
    expect(bad({ matchup: { ...DEFAULT_WEEKLY_MODEL.matchup, dvpLambda: 0 } })).toThrow(/matchup\.dvpLambda/);
    expect(bad({ environment: { ...DEFAULT_WEEKLY_MODEL.environment, leagueAvgItp: 0 } })).toThrow(/leagueAvgItp/);
    expect(bad({ sigma: { ...DEFAULT_WEEKLY_MODEL.sigma, delta: -1 } })).toThrow(/sigma\.delta/);
    expect(bad({ sourceWeights: { sleeper: 0, espn: 0, dk: 0 } })).toThrow(/all zero/);
    expect(bad({ availability: { byStatus: { Questionable: 1.5 } } })).toThrow(/Questionable/);
  });

  it("maps positions to correlation units", () => {
    expect(unitOf("QB")).toBe("pass");
    expect(unitOf("WR")).toBe("pass");
    expect(unitOf("TE")).toBe("pass");
    expect(unitOf("RB")).toBe("run");
    expect(unitOf("K")).toBe("run");
  });
});
