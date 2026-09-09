import { describe, it, expect } from "vitest";
import { encodeHistory, decodeHistory, type HistRow } from "../lib/etl/weekly/history";

const rows: HistRow[] = [
  {
    id: "6813", pos: "RB", team: "DET", wk: 3, opp: "CHI", stNow: null,
    proj: { rushYds: 99.634, rushTD: 1.0512, receptions: 3.95 },
    act: { rushYds: 112, rushTD: 1, receptions: 2 },
    tot: 49.5, spr: -6.5,
  },
  {
    // PLAYED but recorded nothing. This row is the whole point of the encoding:
    // an empty stat line must survive as {} and never collapse to null, or
    // "appeared and did nothing" becomes "did not appear" and the availability
    // signal is destroyed. A test with only null and non-empty rows would pass
    // even if the encoder collapsed {} to null.
    id: "0000", pos: "WR", team: "NYJ", wk: 3, opp: "BUF", stNow: null,
    proj: { receptions: 2.1, recYds: 18.4 },
    act: {},
    tot: 38.5, spr: 2.5,
  },
  {
    id: "4034", pos: "QB", team: "KC", wk: 3, opp: "LV", stNow: "Questionable",
    proj: { passYds: 268 },
    act: null,
    tot: 44, spr: -3,
  },
];

describe("history encoding", () => {
  it("round-trips every field, distinguishing 'did not play' from 'played and scored zero'", () => {
    const back = decodeHistory(encodeHistory(rows));
    expect(back).toHaveLength(3);
    expect(back[0].act?.rushYds).toBe(112);
    // The three states must stay three states.
    expect(back[1].act).toEqual({}); // played, recorded nothing
    expect(back[1].act).not.toBeNull();
    expect(back[2].act).toBeNull(); // did not appear
    expect(back[2].stNow).toBe("Questionable");
    expect(back[0].stNow).toBeNull();
    expect(back[0].spr).toBe(-6.5);
  });

  it("pins the code-to-field mapping, so a code can never be reassigned", () => {
    // The committed snapshots are keyed by these two-letter codes. Reordering
    // CODES is harmless because pack/unpack look up BY NAME — but reusing or
    // reassigning a code would silently reinterpret five seasons of data as a
    // different stat. This decodes a hand-written payload to pin the mapping.
    const packed = JSON.stringify([
      { i: "x", p: "QB", t: "KC", w: 1, o: "LV", j: { py: 250, pt: 2, pi: 1 }, a: { ry: 30, rt: 1 }, v: 44, d: -3 },
    ]);
    const [row] = decodeHistory(packed);
    expect(row.proj.passYds).toBe(250);
    expect(row.proj.passTD).toBe(2);
    expect(row.proj.passInt).toBe(1);
    expect(row.act?.rushYds).toBe(30);
    expect(row.act?.rushTD).toBe(1);
  });

  it("rounds projections to two decimals — five seasons must fit in the repo", () => {
    const back = decodeHistory(encodeHistory(rows));
    expect(back[0].proj.rushYds).toBe(99.63);
    expect(back[0].proj.rushTD).toBe(1.05);
    expect(back[0].act?.rushYds).toBe(112); // actuals are rounded too
  });

  it("produces materially smaller output than naive JSON", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ ...rows[0], id: String(i) }));
    expect(encodeHistory(many).length).toBeLessThan(JSON.stringify(many).length * 0.7);
  });
});
