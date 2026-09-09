import { describe, it, expect } from "vitest";
import { buildWeekOutlooks, blendMarket, type WeekPlayerInput, type WeekLine } from "../lib/engine/weekly/outlook";
import { OFF_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";

const scoring = SCORING_PRESETS.ppr;
const OFF = OFF_WEEKLY_MODEL;

const gibbs: WeekPlayerInput = {
  id: "6813", pos: "RB", team: "DET", bye: 8, status: null,
  sleeper: { rushYds: 99.6, rushTD: 1.05, receptions: 3.95, recYds: 26.2 },
};
const lines: Record<string, WeekLine> = {
  DET: { total: 49.5, ownSpread: -6.5, opp: "CHI" },
  CHI: { total: 49.5, ownSpread: 6.5, opp: "DET" },
};
const noDvp = () => ({ games: 0 });

describe("off state — the contract every gate is measured against", () => {
  it("reproduces raw Sleeper, re-scored, exactly", () => {
    const [o] = buildWeekOutlooks({
      week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: OFF,
    });
    const expected = scoreStatLine(gibbs.sleeper!, scoring);
    expect(o.meanIfPlays).toBeCloseTo(expected, 10);
    expect(o.drivers.matchMult).toBe(1);
    expect(o.drivers.envMult).toBe(1);
    expect(o.drivers.scriptMult).toBe(1);
    expect(o.drivers.baseUsage).toBe(0);
  });

  it("respects league scoring rather than a source's published total", () => {
    const tePremium = { ...scoring, bonus_rec_te: 0.5 };
    const te: WeekPlayerInput = { id: "1", pos: "TE", team: "DET", bye: 8, status: null, sleeper: { receptions: 6, recYds: 60 } };
    const [o] = buildWeekOutlooks({ week: 2, players: [te], linesByTeam: lines, dvp: noDvp, scoring: tePremium, params: OFF });
    expect(o.meanIfPlays).toBeCloseTo(6 * 1.5 + 6, 10); // 6 rec at 1.5 + 60 yds at 0.1
  });
});

describe("blendMarket", () => {
  it("renormalizes when a weighted source is missing rather than silently deflating", () => {
    const p: WeeklyModelParams = { ...OFF, sourceWeights: { sleeper: 0.5, espn: 0.5, dk: 0 } };
    // ESPN absent → sleeper must carry the full weight, not half of it.
    const only = blendMarket(gibbs, scoring, p);
    expect(only).toBeCloseTo(scoreStatLine(gibbs.sleeper!, scoring), 10);
  });

  it("averages two sources when both are present", () => {
    const p: WeeklyModelParams = { ...OFF, sourceWeights: { sleeper: 0.5, espn: 0.5, dk: 0 } };
    const both: WeekPlayerInput = { ...gibbs, espn: { rushYds: 60, rushTD: 0.5 } };
    const s = scoreStatLine(both.sleeper!, scoring);
    const e = scoreStatLine(both.espn!, scoring);
    expect(blendMarket(both, scoring, p)).toBeCloseTo((s + e) / 2, 10);
  });

  it("uses DK's point total directly — DK publishes a projection, not a stat line", () => {
    const p: WeeklyModelParams = { ...OFF, sourceWeights: { sleeper: 0, espn: 0, dk: 1 } };
    expect(blendMarket({ ...gibbs, dk: 17.5 }, scoring, p)).toBeCloseTo(17.5, 10);
  });

  it("returns 0 when no source has an opinion", () => {
    expect(blendMarket({ id: "x", pos: "WR", team: "DET", bye: 8, status: null }, scoring, OFF)).toBe(0);
  });

  it("falls back to a zero-weighted source rather than projecting a real player at 0", () => {
    // OFF ships espn at weight 0. Without this fallback, a player Sleeper's
    // weekly feed omits reads as 0.0 — which happened to 34% of the board,
    // including a top-35 ADP starter.
    const espnOnly: WeekPlayerInput = {
      id: "bowers", pos: "TE", team: "LV", bye: 8, status: null,
      espn: { receptions: 6, recYds: 62, recTD: 0.5 },
    };
    expect(OFF.sourceWeights.espn).toBe(0);
    expect(blendMarket(espnOnly, scoring, OFF)).toBeCloseTo(6 + 6.2 + 3, 6);
  });
});

describe("assembly", () => {
  const ON: WeeklyModelParams = {
    ...OFF,
    modelWeights: { market: 0.7, usage: 0.3 },
    environment: { leagueAvgItp: 22.5, alpha: { RB: 0.4 }, beta: { RB: -0.12 } },
    matchup: { gamma: { RB: 0.5 }, shrinkGames: 6, priorSeasonWeight: 0.5, dvpLambda: 0.85 },
    sigma: { ...OFF.sigma, delta: 0.35 },
  };

  it("a bye week is zero mean but keeps a non-zero conditional projection", () => {
    const [o] = buildWeekOutlooks({ week: 8, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(o.pPlay).toBe(0);
    expect(o.mean).toBe(0);
    expect(o.meanIfPlays).toBeGreaterThan(0);
    expect(o.opp).toBeNull();
  });

  it("a player whose team has no line this week is treated as a bye", () => {
    const orphan: WeekPlayerInput = { ...gibbs, team: "SEA" };
    const [o] = buildWeekOutlooks({ week: 2, players: [orphan], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(o.pPlay).toBe(0);
    expect(o.opp).toBeNull();
  });

  it("blends the usage model in at its configured weight", () => {
    const withUsage: WeekPlayerInput = { ...gibbs, usage: { rushYds: 60, receptions: 2, recYds: 15 } };
    const [o] = buildWeekOutlooks({ week: 2, players: [withUsage], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    const m = scoreStatLine(withUsage.sleeper!, scoring);
    const u = scoreStatLine(withUsage.usage!, scoring);
    expect(o.drivers.baseUsage).toBeCloseTo(u, 10);
    // 0.7m + 0.3u, then the environment and script multipliers.
    const base = 0.7 * m + 0.3 * u;
    expect(o.meanIfPlays).toBeCloseTo(base * o.drivers.envMult * o.drivers.scriptMult * o.drivers.matchMult, 8);
  });

  it("falls back to the market alone when usage has no opinion, without deflating", () => {
    const [o] = buildWeekOutlooks({ week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    const m = scoreStatLine(gibbs.sleeper!, scoring);
    expect(o.meanIfPlays).toBeCloseTo(m * o.drivers.envMult * o.drivers.scriptMult, 8);
  });

  it("flags a player no source has an opinion on, so 0 is not mistaken for a bye", () => {
    const ghost: WeekPlayerInput = { id: "ghost", pos: "WR", team: "DET", bye: 8, status: null };
    const [o] = buildWeekOutlooks({ week: 2, players: [ghost], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(o.projected).toBe(false);
    expect(o.mean).toBe(0);
    // A real projection must be flagged true even when its mean is 0 for
    // another reason — here a bye.
    const [g] = buildWeekOutlooks({ week: 8, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(g.projected).toBe(true);
    expect(g.mean).toBe(0);
  });

  it("orders the quantiles and reports the opponent", () => {
    const [o] = buildWeekOutlooks({ week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON });
    expect(o.opp).toBe("CHI");
    expect(o.p10).toBeLessThan(o.p50);
    expect(o.p50).toBeLessThan(o.p90);
    expect(o.sigma).toBeGreaterThan(0);
  });

  it("is deterministic: same input, identical output", () => {
    const args = { week: 2, players: [gibbs], linesByTeam: lines, dvp: noDvp, scoring, params: ON };
    expect(JSON.stringify(buildWeekOutlooks(args))).toBe(JSON.stringify(buildWeekOutlooks(args)));
  });
});
