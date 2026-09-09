import { describe, it, expect } from "vitest";
import { weekBoardUrl, indexOutlooks, currentNflWeek } from "../lib/client/weekBoard";
import type { WeekBoard } from "../lib/types";

describe("weekBoardUrl", () => {
  it("points at the static per-format file", () => {
    expect(weekBoardUrl(2026, 3, "ppr")).toBe("/data/week-2026-3-ppr.json");
    expect(weekBoardUrl(2026, 12, "half-ppr")).toBe("/data/week-2026-12-half-ppr.json");
  });
});

describe("indexOutlooks", () => {
  it("indexes by player id", () => {
    const board = {
      meta: { season: 2026, week: 3, builtAt: "", lane: "weekly", scoring: "ppr", sources: [], warnings: [] },
      outlooks: [{ playerId: "a" }, { playerId: "b" }],
    } as unknown as WeekBoard;
    const idx = indexOutlooks(board);
    expect(idx.size).toBe(2);
    expect(idx.get("b")?.playerId).toBe("b");
  });
});

describe("currentNflWeek", () => {
  const start = new Date("2026-09-08T00:00:00Z"); // Tuesday before week 1

  it("is week 1 on opening day and mid-week-1", () => {
    expect(currentNflWeek(new Date("2026-09-10T18:00:00Z"), start)).toBe(1);
    expect(currentNflWeek(new Date("2026-09-14T18:00:00Z"), start)).toBe(1);
  });

  it("rolls to week 2 after seven days", () => {
    expect(currentNflWeek(new Date("2026-09-15T18:00:00Z"), start)).toBe(2);
  });

  it("clamps below 1 before the season and at 18 after it", () => {
    expect(currentNflWeek(new Date("2026-08-01T00:00:00Z"), start)).toBe(1);
    expect(currentNflWeek(new Date("2027-03-01T00:00:00Z"), start)).toBe(18);
  });
});
