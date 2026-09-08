import { describe, it, expect } from "vitest";
import { abbreviateName, layoutBoard } from "../lib/draft/boardLayout";
import type { DraftPick } from "../lib/types";

const pick = (pickNo: number, playerId: string, teams = 12): DraftPick => ({
  playerId,
  playerName: playerId,
  pos: "RB",
  pickNo,
  round: Math.ceil(pickNo / teams),
  draftSlot: 0,
  isKeeper: false,
  byMe: false,
});

describe("layoutBoard", () => {
  it("lays a snake draft out like the room's board: round 1 left to right, round 2 right to left", () => {
    const rows = layoutBoard([pick(1, "a"), pick(2, "b"), pick(12, "l"), pick(13, "m"), pick(24, "x")], 12, 3, "snake");
    expect(rows.length).toBe(3);
    expect(rows[0].map((c) => c.pickNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(rows[1].map((c) => c.pickNo)).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13]);
    expect(rows[0][0].pick?.playerId).toBe("a");
    expect(rows[0][11].pick?.playerId).toBe("l");
    expect(rows[1][11].pick?.playerId).toBe("m"); // pick 13 sits under pick 12
    expect(rows[1][0].pick?.playerId).toBe("x"); // pick 24 sits under pick 1
    expect(rows[2].every((c) => c.pick === null)).toBe(true);
    expect(rows[1][3]).toMatchObject({ pickNo: 21, round: 2, slot: 4 });
  });

  it("third-round reversal keeps round 3 right to left; linear never turns", () => {
    const rr = layoutBoard([], 4, 4, "snake3rr");
    expect(rr.map((r) => r.map((c) => c.pickNo))).toEqual([
      [1, 2, 3, 4],
      [8, 7, 6, 5],
      [12, 11, 10, 9],
      [13, 14, 15, 16],
    ]);
    const lin = layoutBoard([], 4, 2, "linear");
    expect(lin.map((r) => r.map((c) => c.pickNo))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it("keeps unknown placeholders as cells with an empty player id", () => {
    const rows = layoutBoard([pick(1, "a"), pick(2, "")], 12, 1, "snake");
    expect(rows[0][1].pick).toMatchObject({ playerId: "" });
    expect(rows[0][2].pick).toBeNull();
  });
});

describe("abbreviateName", () => {
  it("writes first initial and surname like the board, keeping suffixes and defenses", () => {
    expect(abbreviateName("Marvin Harrison Jr.", "WR")).toBe("M. Harrison Jr.");
    expect(abbreviateName("Amon-Ra St. Brown", "WR")).toBe("A. St. Brown");
    expect(abbreviateName("Jaxon Smith-Njigba", "WR")).toBe("J. Smith-Njigba");
    expect(abbreviateName("A.J. Brown", "WR")).toBe("A. Brown");
    expect(abbreviateName("Ravens", "DST")).toBe("Ravens");
  });
});
