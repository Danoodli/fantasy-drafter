import { describe, it, expect } from "vitest";
import { scaleStatLine, dkBonusPoints } from "../lib/engine/weekly/bonuses";

describe("scaleStatLine", () => {
  it("scales every volume field by the multiplier", () => {
    const s = scaleStatLine({ rushYds: 80, rushTD: 0.5, receptions: 4, recFd: 3 }, 1.5);
    expect(s.rushYds).toBeCloseTo(120, 10);
    expect(s.rushTD).toBeCloseTo(0.75, 10);
    expect(s.receptions).toBeCloseTo(6, 10);
    expect(s.recFd).toBeCloseTo(4.5, 10);
  });

  it("a zero multiplier produces an empty line, not zero-valued keys", () => {
    expect(scaleStatLine({ rushYds: 80 }, 0)).toEqual({});
  });

  it("leaves the input untouched", () => {
    const input = { rushYds: 80 };
    scaleStatLine(input, 2);
    expect(input.rushYds).toBe(80);
  });
});

describe("dkBonusPoints", () => {
  it("pays 3 at each threshold, and nothing just below", () => {
    expect(dkBonusPoints({ rushYds: 100 })).toBe(3);
    expect(dkBonusPoints({ rushYds: 99.9 })).toBe(0);
    expect(dkBonusPoints({ recYds: 100 })).toBe(3);
    expect(dkBonusPoints({ passYds: 300 })).toBe(3);
    expect(dkBonusPoints({ passYds: 299 })).toBe(0);
  });

  it("stacks — a 100/100 game earns both", () => {
    expect(dkBonusPoints({ rushYds: 120, recYds: 105 })).toBe(6);
    expect(dkBonusPoints({ passYds: 320, rushYds: 100 })).toBe(6);
  });

  it("is zero on an empty line", () => {
    expect(dkBonusPoints({})).toBe(0);
  });
});
