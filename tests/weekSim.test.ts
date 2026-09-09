import { describe, it, expect } from "vitest";
import { sampleWeek, simulateWeek, type WeekSimPlayer } from "../lib/engine/weekSim";
import { DEFAULT_WEEKLY_MODEL, type WeeklyModelParams } from "../lib/engine/weekly/model";
import { makeRng } from "../lib/engine/montecarlo";

function p(id: string, pos: WeekSimPlayer["pos"], team: string, gameId: string, opp: string): WeekSimPlayer {
  return { id, pos, team, gameId, opp, meanIfPlays: 15, sigma: 0.6, pPlay: 1, stats: { recYds: 70, receptions: 5 } };
}

// DET vs CHI in one game; SEA vs NE in another.
const players = [
  p("qb-det", "QB", "DET", "DET-CHI", "CHI"),
  p("wr-det", "WR", "DET", "DET-CHI", "CHI"),
  p("rb-det", "RB", "DET", "DET-CHI", "CHI"),
  p("wr-chi", "WR", "CHI", "DET-CHI", "DET"),
  p("wr-sea", "WR", "SEA", "SEA-NE", "NE"),
  p("dst-det", "DST", "DET", "DET-CHI", "CHI"),
];

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function columns(draws: Float64Array[], k: number): number[] {
  return draws.map((d) => d[k]);
}

describe("weekSim correlation structure", () => {
  const CORR: WeeklyModelParams = {
    ...DEFAULT_WEEKLY_MODEL,
    correlation: { game: 0.15, team: 0.35, unit: 0.55, dstVsOppTeam: 0.3 },
  };

  it("same team, same unit is the most correlated pair", () => {
    const draws = simulateWeek(players, CORR, 8000, 42);
    const qbWr = corr(columns(draws, 0), columns(draws, 1)); // both pass unit, DET
    const wrRb = corr(columns(draws, 1), columns(draws, 2)); // same team, different unit
    const crossTeam = corr(columns(draws, 1), columns(draws, 3)); // same game, other team
    const crossGame = corr(columns(draws, 1), columns(draws, 4)); // different game
    expect(qbWr).toBeGreaterThan(wrRb);
    expect(wrRb).toBeGreaterThan(crossTeam);
    expect(crossTeam).toBeGreaterThan(crossGame);
    expect(Math.abs(crossGame)).toBeLessThan(0.05);
  });

  it("a DST is negatively correlated with the offense it faces", () => {
    // Asserted as a VALUE, not a threshold. With CORR's amplitudes the
    // underlying normal correlation is a_game^2 - a_dst*a_team
    // = 0.15 - sqrt(0.30)*sqrt(0.20) = -0.0949, which for sigma 0.6 maps to a
    // points correlation of (exp(rho*s^2)-1)/(exp(s^2)-1) = -0.0775.
    //
    // 20k draws, not 8k: at 8k the standard error is 0.011, so a bare
    // "< -0.05" assertion sat only 2.5 SE from its own threshold — tight
    // enough that a subtly wrong structure could still satisfy it.
    const draws = simulateWeek(players, CORR, 20000, 7);
    const observed = corr(columns(draws, 5), columns(draws, 3)); // dst-det vs wr-chi
    expect(observed).toBeLessThan(0); // sign first: a DST must not track the offense it faces
    expect(observed).toBeCloseTo(-0.0775, 1); // +/- 0.05, about 7 SE at 20k draws
  });

  it("reproduces the season model's behaviour when game and unit are off", () => {
    const flat: WeeklyModelParams = {
      ...DEFAULT_WEEKLY_MODEL,
      correlation: { game: 0, team: 0.28, unit: 0.28, dstVsOppTeam: 0 },
    };
    const draws = simulateWeek(players, flat, 8000, 3);
    const qbWr = corr(columns(draws, 0), columns(draws, 1));
    const wrRb = corr(columns(draws, 1), columns(draws, 2));
    // With unit == team, a QB/WR pair and a WR/RB pair are equally correlated.
    expect(Math.abs(qbWr - wrRb)).toBeLessThan(0.06);
    expect(Math.abs(corr(columns(draws, 1), columns(draws, 4)))).toBeLessThan(0.05);
  });
});

describe("weekSim mechanics", () => {
  it("is deterministic for a given seed", () => {
    const a = sampleWeek(players, DEFAULT_WEEKLY_MODEL, makeRng(99));
    const b = sampleWeek(players, DEFAULT_WEEKLY_MODEL, makeRng(99));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("the sample mean recovers meanIfPlays for a certain starter", () => {
    const one = [p("solo", "WR", "DET", "DET-CHI", "CHI")];
    const draws = simulateWeek(one, DEFAULT_WEEKLY_MODEL, 20000, 5);
    const mean = draws.reduce((s, d) => s + d[0], 0) / draws.length;
    expect(mean).toBeGreaterThan(14);
    expect(mean).toBeLessThan(16);
  });

  it("a player who does not play scores exactly zero, not a small number", () => {
    const out = [{ ...p("hurt", "WR", "DET", "DET-CHI", "CHI"), pPlay: 0 }];
    const draws = simulateWeek(out, DEFAULT_WEEKLY_MODEL, 200, 1);
    expect(draws.every((d) => d[0] === 0)).toBe(true);
  });

  it("DK bonuses add points only in big statistical weeks", () => {
    const big = [{ ...p("bell", "WR", "DET", "DET-CHI", "CHI"), sigma: 0.9 }];
    const plain = simulateWeek(big, DEFAULT_WEEKLY_MODEL, 4000, 11);
    const bonused = simulateWeek(big, DEFAULT_WEEKLY_MODEL, 4000, 11, { dkBonuses: true });
    const mean = (d: Float64Array[]) => d.reduce((s, x) => s + x[0], 0) / d.length;
    expect(mean(bonused)).toBeGreaterThan(mean(plain));
    // Bonuses are rare-ish: they must not inflate the mean by more than ~3.
    expect(mean(bonused) - mean(plain)).toBeLessThan(3);
  });
});
