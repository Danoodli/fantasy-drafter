import { describe, it, expect } from "vitest";
import { mapEspnStatus, reconcileStatus, gradeBoard } from "../lib/engine/injuryFeed";
import type { Board, BoardPlayer } from "../lib/types";

function player(id: string, injury: string | null): BoardPlayer {
  return {
    id, name: `P ${id}`, pos: "RB", team: "SF", bye: 9, projPoints: 100, projImputed: false,
    adp: 10, adpStdev: 3, adpHigh: 5, adpLow: 15, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
    injury, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {},
  };
}
const board = (...players: BoardPlayer[]): Board => ({
  meta: { format: "ppr", builtAt: "2026-09-07T00:00:00Z", sources: [], scoring: {} as never, warnings: [] },
  players,
});

describe("mapEspnStatus", () => {
  it.each([
    ["Active", "Active"], ["Questionable", "Questionable"], ["Doubtful", "Doubtful"], ["Out", "Out"],
    ["Injured Reserve", "IR"], ["Suspension", "Sus"], ["  out ", "Out"],
  ])("%s → %s", (raw, expected) => expect(mapEspnStatus(raw)).toBe(expected));
  it("returns null for unknown or empty", () => {
    expect(mapEspnStatus("Physically Unable to Perform")).toBeNull();
    expect(mapEspnStatus("")).toBeNull();
    expect(mapEspnStatus(undefined)).toBeNull();
  });
});

describe("reconcileStatus — the live table replaces day-to-day statuses", () => {
  it("escalates Questionable → Out (Penix, 2026-09-07)", () => expect(reconcileStatus("Questionable", "Out")).toBe("Out"));
  it("clears Questionable when the table says Active (Swift back at practice)", () => expect(reconcileStatus("Questionable", "Active")).toBeNull());
  it("downgrades Out → Questionable (a Friday upgrade)", () => expect(reconcileStatus("Out", "Questionable")).toBe("Questionable"));
  it("adds a status to a healthy player", () => expect(reconcileStatus(null, "Doubtful")).toBe("Doubtful"));
  it("keeps season-long PUP over a day-to-day Out (Charbonnet)", () => expect(reconcileStatus("PUP", "Out")).toBe("PUP"));
  it("keeps NA over Out (Jacobs' legal status)", () => expect(reconcileStatus("NA", "Out")).toBe("NA"));
  it("lets an explicit Active clear even IR (activation)", () => expect(reconcileStatus("IR", "Active")).toBeNull());
  it("lets one season-long status replace another", () => expect(reconcileStatus("IR", "Sus")).toBe("Sus"));
  it("leaves the baked status alone when the table has no row", () => expect(reconcileStatus("Questionable", null)).toBe("Questionable"));
});

describe("gradeBoard", () => {
  it("returns the same board object when nothing changes", () => {
    const b = board(player("a", null));
    expect(gradeBoard(b, new Map(), new Map())).toBe(b);
  });
  it("applies the table, marks injuryLive, and leaves untouched players by reference", () => {
    const a = player("a", "Questionable"); const c = player("c", null);
    const out = gradeBoard(board(a, c), new Map([["a", { status: "Out" as const }]]), new Map());
    expect(out.players[0]).toMatchObject({ injury: "Out", injuryLive: true });
    expect(out.players[1]).toBe(c);
  });
  it("still escalates from a hard headline on top of the table", () => {
    const out = gradeBoard(
      board(player("a", null)),
      new Map([["a", { status: "Questionable" as const }]]),
      new Map([["a", { headline: "RB placed on injured reserve" }]])
    );
    expect(out.players[0].injury).toBe("IR");
  });
  it("a clearance from the table is not undone by an old soft headline", () => {
    const out = gradeBoard(board(player("a", "Questionable")), new Map([["a", { status: "Active" as const }]]), new Map([["a", { headline: "RB limited in practice" }]]));
    expect(out.players[0].injury).toBeNull();
    expect(out.players[0].injuryLive).toBe(true);
  });
});
