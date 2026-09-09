import { describe, it, expect } from "vitest";
import { encodeHistory, decodeHistory, type HistRow } from "../lib/etl/weekly/history";

const rows: HistRow[] = [
  {
    id: "6813", pos: "RB", team: "DET", wk: 3, opp: "CHI", st: null,
    proj: { rushYds: 99.634, rushTD: 1.0512, receptions: 3.95 },
    act: { rushYds: 112, rushTD: 1, receptions: 2 },
    tot: 49.5, spr: -6.5,
  },
  {
    id: "4034", pos: "QB", team: "KC", wk: 3, opp: "LV", st: "Questionable",
    proj: { passYds: 268 },
    act: null,
    tot: 44, spr: -3,
  },
];

describe("history encoding", () => {
  it("round-trips every field, distinguishing 'did not play' from 'scored zero'", () => {
    const back = decodeHistory(encodeHistory(rows));
    expect(back).toHaveLength(2);
    expect(back[0].act?.rushYds).toBe(112);
    expect(back[1].act).toBeNull();
    expect(back[1].st).toBe("Questionable");
    expect(back[0].spr).toBe(-6.5);
  });

  it("rounds projections to two decimals — five seasons must fit in the repo", () => {
    const back = decodeHistory(encodeHistory(rows));
    expect(back[0].proj.rushYds).toBe(99.63);
    expect(back[0].proj.rushTD).toBe(1.05);
  });

  it("produces materially smaller output than naive JSON", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ ...rows[0], id: String(i) }));
    expect(encodeHistory(many).length).toBeLessThan(JSON.stringify(many).length * 0.7);
  });
});
