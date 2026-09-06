import { describe, it, expect } from "vitest";
import { reconcileSequence } from "../lib/draft/sequence";

const notMine = () => false;
const mineAt = (...idx: number[]) => (i: number) => idx.includes(i);

describe("reconcileSequence", () => {
  it("appends new names in frame order when nothing is known yet", () => {
    const r = reconcileSequence([], ["a", "b", "c"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c"]);
    expect(r.inserted.map((p) => p.pickIndex)).toEqual([0, 1, 2]);
  });

  it("appends only what follows the last known name", () => {
    const r = reconcileSequence(["a", "b", "c"], ["b", "c", "d", "e"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.inserted.map((p) => p.id)).toEqual(["d", "e"]);
  });

  it("inserts a missed pick between two known ones and shifts the rest down", () => {
    const r = reconcileSequence(["a", "b", "c", "e"], ["b", "c", "d", "e"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.inserted).toEqual([{ id: "d", pickIndex: 3 }]);
    expect(r.shifted).toBe(1);
  });

  it("fills an unknown placeholder in the gap instead of inserting", () => {
    const r = reconcileSequence(["a", "b", null, "d"], ["b", "c", "d"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c", "d"]);
    expect(r.filled).toEqual([{ id: "c", pickIndex: 2 }]);
    expect(r.inserted).toEqual([]);
  });

  it("leaves my pick as a placeholder and hands the name back, everyone after me still lands right", () => {
    const r = reconcileSequence(["a", "b", "c", "d"], ["c", "d", "x", "y", "z"], { isMine: mineAt(4) });
    expect(r.next).toEqual(["a", "b", "c", "d", null, "y", "z"]);
    expect(r.held).toEqual([{ id: "x", pickIndex: 4 }]);
    expect(r.inserted.map((p) => p.id)).toEqual(["y", "z"]);
  });

  it("keeps handing my name back while the placeholder is open, without duplicating anything", () => {
    const first = reconcileSequence(["a", "b", "c", "d"], ["c", "d", "x", "y"], { isMine: mineAt(4) });
    const second = reconcileSequence(first.next, ["c", "d", "x", "y", "z"], { isMine: mineAt(4) });
    expect(second.next).toEqual(["a", "b", "c", "d", null, "y", "z"]);
    expect(second.held).toEqual([{ id: "x", pickIndex: 4 }]);
    expect(second.inserted.map((p) => p.id)).toEqual(["z"]);
  });

  it("never places an ignored name, and the picks after it still land in order", () => {
    const r = reconcileSequence(["a"], ["a", "x", "b"], { isMine: notMine, ignored: new Set(["x"]) });
    expect(r.next).toEqual(["a", "b"]);
  });

  it("with no overlap, assumes the frame follows what is known", () => {
    const r = reconcileSequence(["a", "b"], ["c", "d"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes a name the panel shows twice and never re-places a known name read out of order", () => {
    const r = reconcileSequence(["a", "b", "c"], ["a", "c", "b", "d", "d"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c", "d"]);
  });

  it("never moves or fills frozen API picks", () => {
    const r = reconcileSequence(["a", null, "c"], ["x", "a", "y", "c"], { isMine: notMine, frozen: 3 });
    expect(r.next.slice(0, 3)).toEqual(["a", null, "c"]);
    expect(r.next.length).toBeGreaterThanOrEqual(3);
  });

  it("snake order: the wrap-around seat's back-to-back picks both stay mine when I am slot 12", () => {
    const teams = 12;
    // Same math the app uses: odd rounds ascend, even rounds descend.
    const owner = (pickNo: number) => {
      const round = Math.ceil(pickNo / teams);
      const idx = (pickNo - 1) % teams;
      return round % 2 === 1 ? idx + 1 : teams - idx;
    };
    const isMine = (i: number) => owner(i + 1) === 12;
    const known = Array.from({ length: 11 }, (_, i) => `p${i + 1}`); // picks 1–11 done
    const r = reconcileSequence(known, ["p10", "p11", "me1", "me2", "p14"], { isMine });
    expect(r.next.slice(11)).toEqual([null, null, "p14"]); // picks 12 and 13 are mine → placeholders
    expect(r.held).toEqual([{ id: "me1", pickIndex: 11 }, { id: "me2", pickIndex: 12 }]);
    expect(r.inserted).toEqual([{ id: "p14", pickIndex: 13 }]);
  });

  it("works both ways: a pick I made in the app first is recognised when the screen shows it, not duplicated or moved", () => {
    // I clicked Draft on X at pick 5 in the app; the screen then shows X at pick 5.
    const r = reconcileSequence(["a", "b", "c", "d", "x"], ["c", "d", "x", "y"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c", "d", "x", "y"]);
    expect(r.inserted).toEqual([{ id: "y", pickIndex: 5 }]);
  });

  it("works both ways: if I clicked Draft before the screen showed the pick ahead of me, that pick slides in front of mine", () => {
    // The OCR lagged: I drafted X in the app while pick 4 (d) was not yet read, so X sits at index 3.
    const r = reconcileSequence(["a", "b", "c", "x"], ["b", "c", "d", "x"], { isMine: notMine });
    expect(r.next).toEqual(["a", "b", "c", "d", "x"]);
    expect(r.inserted).toEqual([{ id: "d", pickIndex: 3 }]);
    expect(r.shifted).toBe(1);
  });

  it("screen first: my own pick is recorded like any other, back-to-back picks included", () => {
    // Slot 12 in a 12-team snake owns picks 12 and 13; nothing is held or skipped.
    const known = Array.from({ length: 11 }, (_, i) => `p${i + 1}`);
    const r = reconcileSequence(known, ["p10", "p11", "me1", "me2", "p14"], { isMine: notMine });
    expect(r.next.slice(11)).toEqual(["me1", "me2", "p14"]);
  });

  it("a whole burst of fast picks lands in order in one frame", () => {
    const r = reconcileSequence(["a"], ["a", "b", "c", "d", "e", "f"], { isMine: mineAt(3) });
    expect(r.next).toEqual(["a", "b", "c", null, "e", "f"]);
    expect(r.held).toEqual([{ id: "d", pickIndex: 3 }]);
  });
});
