import { describe, it, expect } from "vitest";
import { buildUsageHistory, remapToSleeper } from "../lib/etl/weekly/usage";
import {
  rollingShares,
  blendWithPrior,
  projectUsageStatLine,
  type Efficiency,
  type UsageWeek,
} from "../lib/engine/weekly/usageModel";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";

function nflRow(o: Record<string, string>): Record<string, string> {
  return {
    season: "2025", season_type: "REG", week: "1", player_id: "00-0001",
    position: "WR", team: "DET", opponent_team: "CHI",
    targets: "0", carries: "0", attempts: "0",
    receiving_yards: "0", rushing_yards: "0", passing_yards: "0",
    ...o,
  };
}

describe("buildUsageHistory", () => {
  it("records a player's own volume and his team's total in the same week", () => {
    const rows = [
      nflRow({ player_id: "00-0001", targets: "10", receiving_yards: "120" }),
      nflRow({ player_id: "00-0002", targets: "6" }),
      nflRow({ player_id: "00-0003", position: "RB", carries: "18", rushing_yards: "80" }),
      nflRow({ player_id: "00-0004", position: "QB", attempts: "30", passing_yards: "260" }),
    ];
    const h = buildUsageHistory(rows, { season: 2025, throughWeek: 2 });
    expect(h["00-0001"][0].targets).toBe(10);
    expect(h["00-0001"][0].teamTargets).toBe(16);
    expect(h["00-0003"][0].teamCarries).toBe(18);
    expect(h["00-0004"][0].teamAttempts).toBe(30);
  });

  it("excludes the week being predicted", () => {
    const rows = [nflRow({ week: "4", targets: "9" })];
    expect(buildUsageHistory(rows, { season: 2025, throughWeek: 4 })["00-0001"]).toBeUndefined();
  });

  it("remaps gsis keys to sleeper ids and drops players with no mapping", () => {
    const h = buildUsageHistory([nflRow({ targets: "5" }), nflRow({ player_id: "00-9999", targets: "5" })], {
      season: 2025, throughWeek: 2,
    });
    const mapped = remapToSleeper(h, { "00-0001": "4034" });
    expect(mapped["4034"]).toBeDefined();
    expect(Object.keys(mapped)).toHaveLength(1);
  });
});

const wk = (week: number, targets: number, teamTargets: number): UsageWeek => ({
  week, team: "DET", targets, carries: 0, attempts: 0,
  recYds: 0, rushYds: 0, passYds: 0,
  teamTargets, teamCarries: 0, teamAttempts: 0,
});

describe("rollingShares", () => {
  it("with lambda 1 is the plain mean share", () => {
    const s = rollingShares([wk(1, 10, 40), wk(2, 6, 30)], 1);
    expect(s.targetShare).toBeCloseTo((0.25 + 0.2) / 2, 6);
    expect(s.games).toBe(2);
  });

  it("with lambda < 1 leans on the most recent week", () => {
    const s = rollingShares([wk(1, 4, 40), wk(2, 12, 40)], 0.5);
    expect(s.targetShare).toBeGreaterThan(0.2); // flat mean would be 0.2
  });

  it("returns zero shares and zero games on an empty history rather than NaN", () => {
    const s = rollingShares([], 0.75);
    expect(s.targetShare).toBe(0);
    expect(s.games).toBe(0);
    expect(Number.isNaN(s.carryShare)).toBe(false);
  });
});

describe("blendWithPrior", () => {
  const prior = { targetShare: 0.2, carryShare: 0, attemptShare: 0, games: 0 };
  it("is the prior with zero games observed — week 1 must not read noise as signal", () => {
    const observed = { targetShare: 0.4, carryShare: 0, attemptShare: 0, games: 0 };
    expect(blendWithPrior(observed, prior, 4).targetShare).toBeCloseTo(0.2, 6);
  });

  it("moves toward the observation as games accumulate", () => {
    const observed = { targetShare: 0.4, carryShare: 0, attemptShare: 0, games: 12 };
    const blended = blendWithPrior(observed, prior, 4).targetShare;
    expect(blended).toBeGreaterThan(0.3);
    expect(blended).toBeLessThan(0.4);
  });
});

describe("projectUsageStatLine", () => {
  const eff: Efficiency = {
    ydsPerTarget: 12, ydsPerCarry: 5, ydsPerAttempt: 7.5,
    tdPerTarget: 0.12, tdPerCarry: 0.05, tdPerAttempt: 0.06, catchRate: 0.7,
  };
  const priorEff: Efficiency = {
    ydsPerTarget: 8, ydsPerCarry: 4.2, ydsPerAttempt: 7,
    tdPerTarget: 0.06, tdPerCarry: 0.03, tdPerAttempt: 0.045, catchRate: 0.65,
  };

  it("volume times efficiency, with efficiency shrunk hard toward the prior", () => {
    const stats = projectUsageStatLine(
      {
        pos: "WR",
        shares: { targetShare: 0.25, carryShare: 0, attemptShare: 0, games: 10 },
        teamVolume: { targets: 32, carries: 24, attempts: 32 },
        efficiency: eff,
        priorEfficiency: priorEff,
      },
      DEFAULT_WEEKLY_MODEL
    );
    // 0.25 * 32 = 8 targets. effReliability 0.15 → ydsPerTarget ≈ 8.6.
    expect(stats.receptions).toBeCloseTo(8 * (0.65 + 0.15 * (0.7 - 0.65)), 4);
    expect(stats.recYds).toBeCloseTo(8 * (8 + 0.15 * (12 - 8)), 4);
    expect(stats.rushYds ?? 0).toBe(0);
  });

  it("gives a QB passing volume and a back carries, not each other's", () => {
    const shares = { targetShare: 0.05, carryShare: 0.6, attemptShare: 0.95, games: 8 };
    const teamVolume = { targets: 32, carries: 24, attempts: 32 };
    const rb = projectUsageStatLine({ pos: "RB", shares, teamVolume, efficiency: eff, priorEfficiency: priorEff }, DEFAULT_WEEKLY_MODEL);
    const qb = projectUsageStatLine({ pos: "QB", shares, teamVolume, efficiency: eff, priorEfficiency: priorEff }, DEFAULT_WEEKLY_MODEL);
    expect(rb.rushYds).toBeGreaterThan(0);
    expect(rb.passYds ?? 0).toBe(0);
    expect(qb.passYds).toBeGreaterThan(0);
  });
});
