import { describe, it, expect } from "vitest";
import { winProbability, matchupWinProbability } from "../lib/engine/season/lineup";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import type { WeekSimPlayer } from "../lib/engine/weekSim";

const sp = (id: string, pos: WeekSimPlayer["pos"], mean: number, over: Partial<WeekSimPlayer> = {}): WeekSimPlayer => ({
  // Distinct team and game per player: independent draws, so the arithmetic below is checkable by hand.
  id, pos, team: id.toUpperCase(), gameId: `G-${id}`, opp: "OPP",
  meanIfPlays: mean, sigma: 0.6, pPlay: 1, stats: {}, ...over,
});

/** Eight fixed starters, one per dedicated slot of a standard lineup. */
const starters = (prefix: string, mean: number): WeekSimPlayer[] => [
  sp(`${prefix}qb`, "QB", mean), sp(`${prefix}r1`, "RB", mean), sp(`${prefix}r2`, "RB", mean),
  sp(`${prefix}w1`, "WR", mean), sp(`${prefix}w2`, "WR", mean), sp(`${prefix}te`, "TE", mean),
  sp(`${prefix}k`, "K", mean), sp(`${prefix}ds`, "DST", mean),
];

describe("winProbability over given draws", () => {
  it("counts wins, half-counts ties, by index", () => {
    const draws = [new Float64Array([10, 5]), new Float64Array([3, 8]), new Float64Array([6, 6])];
    // win, loss, tie -> (1 + 0.5) / 3
    expect(winProbability(draws, [0], [1])).toBeCloseTo(0.5, 10);
  });

  it("sums several indices per side", () => {
    const draws = [new Float64Array([4, 4, 7]), new Float64Array([1, 1, 3])];
    expect(winProbability(draws, [0, 1], [2])).toBe(0.5); // 8>7 then 2<3
  });

  it("is 0.5 with no draws rather than NaN", () => {
    expect(winProbability([], [0], [1])).toBe(0.5);
  });
});

describe("matchupWinProbability", () => {
  it("is near 0.5 between identical rosters", () => {
    // Pre-computed by the controller at seed 11: 0.506.
    const wp = matchupWinProbability(starters("a", 12), starters("b", 12), DEFAULT_WEEKLY_MODEL, 3000, 11);
    expect(wp).toBeGreaterThan(0.44);
    expect(wp).toBeLessThan(0.56);
  });

  it("rises with a stronger roster and falls with a weaker one", () => {
    // Pre-computed at seed 7: 0.894 and 0.110.
    const strong = matchupWinProbability(starters("a", 18), starters("b", 12), DEFAULT_WEEKLY_MODEL, 3000, 7);
    const weak = matchupWinProbability(starters("a", 8), starters("b", 12), DEFAULT_WEEKLY_MODEL, 3000, 7);
    expect(strong).toBeGreaterThan(0.8);
    expect(weak).toBeLessThan(0.2);
  });

  it("is monotone in my own strength", () => {
    // Pre-computed at seed 3: 0.098, 0.277, 0.491, 0.673, 0.802.
    const seq = [8, 10, 12, 14, 16].map((m) =>
      matchupWinProbability(starters("a", m), starters("b", 12), DEFAULT_WEEKLY_MODEL, 4000, 3)
    );
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1]);
  });

  it("is deterministic for a given seed", () => {
    const a = matchupWinProbability(starters("a", 12), starters("b", 13), DEFAULT_WEEKLY_MODEL, 1000, 99);
    const b = matchupWinProbability(starters("a", 12), starters("b", 13), DEFAULT_WEEKLY_MODEL, 1000, 99);
    expect(a).toBe(b);
  });

  it("counts a tie as half a win rather than a loss", () => {
    // sigma 0 makes every draw exactly the mean, so every week is an exact tie.
    const one = [sp("x", "QB", 10, { sigma: 0 })];
    const two = [sp("y", "QB", 10, { sigma: 0 })];
    expect(matchupWinProbability(one, two, DEFAULT_WEEKLY_MODEL, 200, 1)).toBeCloseTo(0.5, 6);
  });

  it("treats a lineup that cannot play as scoring nothing", () => {
    const crippled = starters("a", 12).map((x) => ({ ...x, pPlay: 0 }));
    expect(matchupWinProbability(crippled, starters("b", 12), DEFAULT_WEEKLY_MODEL, 500, 5)).toBe(0);
  });
});
