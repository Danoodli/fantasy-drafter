import { describe, it, expect } from "vitest";
import { inferPasteLayout, type RoomState } from "../lib/draft/pasteLayout";

const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
/** A room where picks 1..k are on the board as players k1..kk (optionally some as unknown placeholders). */
function room(k: number, opts: Partial<RoomState> & { holes?: number[] } = {}): RoomState {
  const placed = new Map<string, number>();
  const holes = new Set(opts.holes ?? []);
  for (let p = 1; p <= k; p++) if (!holes.has(p)) placed.set(`k${p}`, p);
  return { teams: 12, order: "snake", knownCount: k, placed, placeholders: holes, ...opts };
}

describe("inferPasteLayout", () => {
  it("the 9th–18th picks copied from the board snake after the 12th, with no labels and no anchors", () => {
    // Screen order: row 1 cells 9–12, then row 2 left to right = picks 18 down to 13.
    const rows = ids("n", 1, 10);
    const r = inferPasteLayout(rows, room(8), "grid")!;
    expect(r.best.shape).toBe("grid");
    expect(r.best.picks).toEqual([9, 10, 11, 12, 18, 17, 16, 15, 14, 13]);
    expect(r.best.total).toBe(18);
    // Read as a list the same rows would be 9..18 — a different placement, so it is offered as the alternative.
    expect(r.alternatives.map((a) => a.shape)).toContain("list");
    const asList = inferPasteLayout(rows, room(8), "list")!;
    expect(asList.best.picks).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("anchors in two different rounds settle grid vs list whatever the preference", () => {
    // Known through pick 13. Paste = board cells from 1.12 to 2.1: [k12, five new, k13].
    const rows = ["k12", "n1", "n2", "n3", "n4", "n5", "k13"];
    const r = inferPasteLayout(rows, room(13), "list")!;
    expect(r.best.shape).toBe("grid");
    expect(r.best.picks).toEqual([12, 18, 17, 16, 15, 14, 13]);
    expect(r.best.anchors).toBe(2);
    expect(r.alternatives).toEqual([]);
  });

  it("a chronological list with anchors is read as a list even when a grid is preferred", () => {
    const r = inferPasteLayout(["k12", "k13", "n1", "n2", "n3"], room(13), "grid")!;
    expect(r.best.shape).toBe("list");
    expect(r.best.picks).toEqual([12, 13, 14, 15, 16]);
    expect(r.alternatives).toEqual([]);
  });

  it("a newest-first list is recognised from its anchors", () => {
    const r = inferPasteLayout(["n2", "n1", "k13", "k12"], room(13), "list")!;
    expect(r.best.shape).toBe("newest");
    expect(r.best.picks).toEqual([15, 14, 13, 12]);
  });

  it("new names land on unknown placeholders, and an unrecognised row still takes a cell", () => {
    const r = inferPasteLayout(["k11", "k12", "n1"], room(13, { holes: [13] }), "list")!;
    expect(r.best.picks).toEqual([11, 12, 13]);
    const g = inferPasteLayout(["n1", null, "n3"], room(0), "grid")!;
    expect(g.best.picks).toEqual([1, 2, 3]);
  });

  it("assumes the fewest picks it has not seen: 10 new names after 8 known means 18 picks, not more", () => {
    const r = inferPasteLayout(ids("n", 1, 10), room(8), "list")!;
    expect(r.best.total).toBe(18);
  });

  it("with no anchors and no cell tags, the reading under which ADP rises with the pick wins", () => {
    // 30 names copied from a board in screen order: round 2 is on screen right to left.
    const picks = [...ids("", 1, 12).map(Number), ...Array.from({ length: 12 }, (_, i) => 24 - i), 25, 26, 27, 28, 29, 30];
    const rows = picks.map((p) => `p${p}`);
    // ADP tracks the true pick with a little noise.
    const adpOf = (id: string) => Number(id.slice(1)) + ((Number(id.slice(1)) * 7) % 5) - 2;
    const r = inferPasteLayout(rows, room(0), null, adpOf)!;
    expect(r.best.shape).toBe("grid");
    expect(r.best.picks).toEqual(picks);
    // The same 30 names as a chronological list read as a list.
    const list = inferPasteLayout(ids("p", 1, 30), room(0), null, adpOf)!;
    expect(list.best.shape).toBe("list");
    // Too few names for ADP to say anything: a list, the common case.
    expect(inferPasteLayout(["p13", "p14", "p15"], room(12), null, adpOf)!.best.shape).toBe("list");
    // Structural evidence (cell tags → grid) outranks ADP.
    expect(inferPasteLayout(ids("p", 1, 30), room(0), "grid", adpOf)!.best.shape).toBe("grid");
  });

  it("returns null when no reading fits the anchors", () => {
    expect(inferPasteLayout(["k5", "k12"], room(12), "grid")).toBeNull();
  });

  it("follows the room's draft order: third-round reversal keeps round 3 right to left on the board", () => {
    const rows = ids("n", 1, 4);
    const r = inferPasteLayout(rows, room(24, { teams: 12, order: "snake3rr" }), "grid")!;
    // Round 3 under 3RR runs right to left, so screen order is picks 28, 27, 26, 25.
    expect(r.best.picks).toEqual([28, 27, 26, 25]);
  });
});
