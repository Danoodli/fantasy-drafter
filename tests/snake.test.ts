import { describe, it, expect } from "vitest";
import { picksForSlot, pickOwner, slotOnClock, pickNumber } from "../lib/draft/snake";

describe("draft order", () => {
  it("snake: the wrap-around seat picks back to back", () => {
    expect(picksForSlot(12, 12, 4)).toEqual([12, 13, 36, 37]);
    expect(picksForSlot(1, 12, 4)).toEqual([1, 24, 25, 48]);
  });

  it("third-round reversal: round 3 repeats round 2's direction, then alternates", () => {
    expect(picksForSlot(12, 12, 5, [], "snake3rr")).toEqual([12, 13, 25, 48, 49]);
    expect(picksForSlot(1, 12, 5, [], "snake3rr")).toEqual([1, 24, 36, 37, 60]);
    expect(slotOnClock(25, 12, "snake3rr").slot).toBe(12);
    expect(pickNumber(3, 12, 12, "snake3rr")).toBe(25);
  });

  it("linear: the same order every round", () => {
    expect(picksForSlot(1, 12, 3, [], "linear")).toEqual([1, 13, 25]);
    expect(picksForSlot(12, 12, 3, [], "linear")).toEqual([12, 24, 36]);
  });

  it("traded picks apply on top of any order", () => {
    const traded = [{ round: 2, originalSlot: 1, newSlot: 7 }];
    expect(pickOwner(24, 12, traded)).toBe(7);
    expect(pickOwner(13, 12, traded, "linear")).toBe(7);
  });

  it("every pick in every order is owned by exactly one seat", () => {
    for (const order of ["snake", "snake3rr", "linear"] as const) {
      const seen = new Map<number, number>();
      for (let s = 1; s <= 10; s++) for (const n of picksForSlot(s, 10, 6, [], order)) seen.set(n, (seen.get(n) ?? 0) + 1);
      expect(seen.size).toBe(60);
      expect([...seen.values()].every((c) => c === 1)).toBe(true);
    }
  });
});
