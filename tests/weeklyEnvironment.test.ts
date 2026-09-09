import { describe, it, expect } from "vitest";
import { impliedTeamPoints, envMult, scriptMult } from "../lib/engine/weekly/environment";
import { OFF_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";

const OFF = OFF_WEEKLY_MODEL;
const ON: WeeklyModelParams = {
  ...OFF,
  environment: {
    leagueAvgItp: 22.5,
    alpha: { QB: 0.6, RB: 0.4, WR: 0.7, TE: 0.5, DST: -0.8 },
    beta: { QB: 0.05, RB: -0.12, WR: 0.08, TE: 0.04 },
  },
};

describe("implied team points", () => {
  it("splits the total by the spread: the favorite gets the bigger half", () => {
    // Total 44.5, favored by 3 → 23.75 / 20.75
    expect(impliedTeamPoints(44.5, -3)).toBeCloseTo(23.75, 6);
    expect(impliedTeamPoints(44.5, 3)).toBeCloseTo(20.75, 6);
    expect(impliedTeamPoints(44.5, 0)).toBeCloseTo(22.25, 6);
  });
});

describe("environment multipliers", () => {
  it("are exactly 1 in the off state, for every position", () => {
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
      expect(envMult(pos, 28, 17, OFF)).toBe(1);
      expect(scriptMult(pos, -7, OFF)).toBe(1);
    }
  });

  it("scale offensive positions up in high-implied-total spots", () => {
    expect(envMult("WR", 28, 17, ON)).toBeGreaterThan(1);
    expect(envMult("WR", 17, 28, ON)).toBeLessThan(1);
  });

  it("INVERTS for DST: a defense wants its OPPONENT held down", () => {
    // Own team implied 28 (irrelevant), opponent implied 17 → good DST spot.
    const goodSpot = envMult("DST", 28, 17, ON);
    const badSpot = envMult("DST", 28, 30, ON);
    expect(goodSpot).toBeGreaterThan(1);
    expect(badSpot).toBeLessThan(1);
    expect(goodSpot).toBeGreaterThan(badSpot);
  });

  it("script: favorites run more, underdogs throw more", () => {
    const favored = scriptMult("RB", -7, ON);
    const dog = scriptMult("RB", 7, ON);
    expect(favored).toBeGreaterThan(dog);
    expect(scriptMult("WR", 7, ON)).toBeGreaterThan(scriptMult("WR", -7, ON));
  });

  it("never returns a negative or zero multiplier, however extreme the spread", () => {
    const steep: WeeklyModelParams = {
      ...OFF,
      environment: { ...ON.environment, beta: { RB: -0.5 } },
    };
    expect(scriptMult("RB", 30, steep)).toBe(0.4); // unclamped would be -1.14
    expect(scriptMult("RB", -30, steep)).toBeGreaterThan(1);
  });
});
