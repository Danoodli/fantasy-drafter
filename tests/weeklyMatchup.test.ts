import { describe, it, expect } from "vitest";
import { buildDvp } from "../lib/etl/weekly/dvp";
import { matchMult } from "../lib/engine/weekly/matchup";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = DEFAULT_WEEKLY_MODEL;
const ON: WeeklyModelParams = {
  ...OFF,
  matchup: { gamma: { RB: 0.5, WR: 0.5 }, shrinkGames: 6, priorSeasonWeight: 0.5 },
};

function row(o: Partial<Record<string, string>>): Record<string, string> {
  return {
    season: "2025", week: "1", season_type: "REG", position: "RB",
    team: "DET", opponent_team: "CHI", receptions: "0", receiving_yards: "0",
    rushing_yards: "0", rushing_tds: "0", receiving_tds: "0",
    ...o,
  } as Record<string, string>;
}

describe("buildDvp", () => {
  it("sums points allowed by the DEFENSE, per position, per game", () => {
    const rows = [
      row({ week: "1", team: "DET", opponent_team: "CHI", rushing_yards: "100", rushing_tds: "1" }),
      row({ week: "1", team: "DET", opponent_team: "CHI", rushing_yards: "50" }),
      row({ week: "2", team: "GB", opponent_team: "CHI", rushing_yards: "60" }),
    ];
    const { table, gamesByTeam } = buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 1 });
    // CHI allowed 16 + 5 = 21 in week 1 and 6 in week 2 → mean 13.5 per game.
    expect(table.CHI?.RB).toBeCloseTo(13.5, 6);
    expect(gamesByTeam.CHI).toBe(2);
  });

  it("weights recent weeks more when lambda < 1", () => {
    const rows = [
      row({ week: "1", opponent_team: "CHI", rushing_yards: "200" }),
      row({ week: "2", opponent_team: "CHI", rushing_yards: "0", receptions: "0" }),
    ];
    const flat = buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 1 }).table.CHI?.RB ?? 0;
    const recent = buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 0.5 }).table.CHI?.RB ?? 0;
    expect(recent).toBeLessThan(flat); // the recent zero pulls it down harder
  });

  it("ignores postseason and other seasons", () => {
    const rows = [
      row({ week: "1", opponent_team: "CHI", rushing_yards: "100", season_type: "POST" }),
      row({ week: "1", opponent_team: "CHI", rushing_yards: "100", season: "2024" }),
    ];
    expect(buildDvp(rows, { season: 2025, throughWeek: 3, lambda: 1 }).table.CHI).toBeUndefined();
  });

  it("ignores weeks at or after throughWeek — no leakage into the week being predicted", () => {
    const rows = [row({ week: "5", opponent_team: "CHI", rushing_yards: "100" })];
    expect(buildDvp(rows, { season: 2025, throughWeek: 5, lambda: 1 }).table.CHI).toBeUndefined();
  });
});

describe("matchMult", () => {
  it("is exactly 1 in the off state", () => {
    expect(matchMult("RB", 30, 15, 10, OFF)).toBe(1);
  });

  it("is 1 when the defense is average, above 1 when it is generous", () => {
    expect(matchMult("RB", 15, 15, 20, ON)).toBeCloseTo(1, 6);
    expect(matchMult("RB", 25, 15, 20, ON)).toBeGreaterThan(1);
    expect(matchMult("RB", 8, 15, 20, ON)).toBeLessThan(1);
  });

  it("shrinks hard toward neutral on small samples — one bad week is not a bad defense", () => {
    const oneGame = matchMult("RB", 30, 15, 1, ON);
    const manyGames = matchMult("RB", 30, 15, 20, ON);
    expect(oneGame).toBeLessThan(manyGames);
    expect(oneGame).toBeGreaterThan(1);
  });

  it("is neutral when the table has no entry rather than throwing", () => {
    expect(matchMult("RB", undefined, 15, 5, ON)).toBe(1);
    expect(matchMult("RB", 20, undefined, 5, ON)).toBe(1);
  });
});
