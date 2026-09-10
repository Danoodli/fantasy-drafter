import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRosterPaste, leadingSlot, headerSlot } from "../lib/season/rosterPaste";
import { tokenize } from "../lib/draft/nameMatch";
import type { Board } from "../lib/types";

const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
const players = board.players;
const rows = (text: string) => parseRosterPaste(text, players).entries.map((e) => [e.player?.name ?? null, e.slot]);

describe("slot words", () => {
  it("reads a leading slot label off the raw line and returns the rest", () => {
    expect(leadingSlot("QB Josh Allen")).toEqual({ slot: "starter", rest: "Josh Allen" });
    expect(leadingSlot("FLEX\tPuka Nacua\tLAR")).toEqual({ slot: "starter", rest: "Puka Nacua\tLAR" });
    expect(leadingSlot("W/R/T Puka Nacua").slot).toBe("starter");
    expect(leadingSlot("D/ST Seahawks D/ST").slot).toBe("starter");
    expect(leadingSlot("BN D. London ATL")).toEqual({ slot: "bench", rest: "D. London ATL" });
    expect(leadingSlot("BE Puka Nacua").slot).toBe("bench");
    expect(leadingSlot("Bench Brock Bowers").slot).toBe("bench");
    expect(leadingSlot("IR Josh Allen").slot).toBe("ir");
    expect(leadingSlot("K Jake Bates").slot).toBe("starter");
    expect(leadingSlot("RB1 Bijan Robinson")).toEqual({ slot: "starter", rest: "Bijan Robinson" });
    // A trailing position is not a slot, and an initial is a name, not a kicker slot.
    expect(leadingSlot("Josh Allen QB")).toEqual({ slot: null, rest: "Josh Allen QB" });
    expect(leadingSlot("K. Walker RB SEA")).toEqual({ slot: null, rest: "K. Walker RB SEA" });
  });
  it("recognises a section header and nothing else", () => {
    expect(headerSlot(tokenize("Bench"))).toBe("bench");
    expect(headerSlot(tokenize("Bench (5)"))).toBe("bench");
    expect(headerSlot(tokenize("Injured Reserve"))).toBe("ir");
    expect(headerSlot(tokenize("IR"))).toBe("ir");
    expect(headerSlot(tokenize("Starters"))).toBe("starter");
    expect(headerSlot(tokenize("Bench Brock Bowers"))).toBeNull();
    expect(headerSlot(tokenize("Josh Allen"))).toBeNull();
  });
});

describe("parseRosterPaste", () => {
  it("reads an ESPN-style roster with slot labels, opponents and points", () => {
    const text = `QB\tJosh Allen\tBuf\tvs MIA\t24.1
RB\tBijan Robinson\tAtl\t@ NO\t18.7
WR\tJa'Marr Chase\tCin\tvs CLE\t17.2
FLEX\tJahmyr Gibbs\tDet\tvs CHI\t16.9
K\tJake Bates\tDet\tvs CHI\t8.0
D/ST\tSeahawks D/ST\tSea\t@ SF\t7.5
Bench
BE\tPuka Nacua\tLAR\tvs ARI\t14.2
IR\tBrock Bowers\tLV\t--\t--`;
    expect(rows(text)).toEqual([
      ["Josh Allen", "starter"], ["Bijan Robinson", "starter"], ["Ja'Marr Chase", "starter"], ["Jahmyr Gibbs", "starter"],
      ["Jake Bates", "starter"], ["Seattle Defense", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "ir"],
    ]);
  });

  it("reads a Sleeper-style copy: slot, initial-surname, team, opponent", () => {
    const text = `QB J. Allen BUF vs MIA
RB J. Gibbs DET vs CHI
WR A. St. Brown DET vs CHI
TE S. LaPorta DET vs CHI
BN D. London ATL @ NO`;
    expect(rows(text)).toEqual([
      ["Josh Allen", "starter"], ["Jahmyr Gibbs", "starter"], ["Amon-Ra St. Brown", "starter"], ["Sam LaPorta", "starter"], ["Drake London", "bench"],
    ]);
  });

  it("uses section headers when lines carry no labels", () => {
    const text = `Starters
Josh Allen
Bijan Robinson
Bench
Puka Nacua
Injured Reserve
Brock Bowers`;
    expect(rows(text)).toEqual([["Josh Allen", "starter"], ["Bijan Robinson", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "ir"]]);
    expect(parseRosterPaste(text, players).hasSlots).toBe(true);
  });

  it("with no slot information at all, everyone is bench and hasSlots is false", () => {
    const r = parseRosterPaste(`Josh Allen\nBijan Robinson\nPuka Nacua`, players);
    expect(r.entries.map((e) => e.slot)).toEqual(["bench", "bench", "bench"]);
    expect(r.hasSlots).toBe(false);
  });

  it("ignores totals, headers and empty lines, and reports them", () => {
    const r = parseRosterPaste(`My Team · Week 3\n\nJosh Allen\nTotal 112.4\nProjected 118.0`, players);
    expect(r.entries.map((e) => e.player?.name)).toEqual(["Josh Allen"]);
    expect(r.ignored).toEqual(expect.arrayContaining(["Total 112.4", "Projected 118.0"]));
  });

  it("does not mistake a team code plus one stray word for a name", () => {
    // "atl" is a team code, so "Waivers atl" carries only one name-like word and is ignored, as in lib/draft/pasteImport.ts.
    const r = parseRosterPaste(`Josh Allen\nWaivers atl`, players);
    expect(r.entries.map((e) => e.player?.name)).toEqual(["Josh Allen"]);
    expect(r.ignored).toEqual(["Waivers atl"]);
  });

  it("marks a misspelled but recoverable name low-confidence with the match as a suggestion", () => {
    // Verified against the shared matcher: "Bijon Robinsen" scores 0.78 for Bijan Robinson.
    const r = parseRosterPaste(`Josh Allen\nBijon Robinsen`, players);
    const soft = r.entries[1];
    expect(soft.player?.name).toBe("Bijan Robinson");
    expect(soft.confidence).toBe("low");
    expect(soft.suggestions.map((p) => p.name)).toContain("Bijan Robinson");
  });

  it("keeps an unplaceable two-word name as a low-confidence row so the preview can ask", () => {
    const r = parseRosterPaste(`Josh Allen\nZebulon Quartermaine`, players);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[1].player).toBeNull();
    expect(r.entries[1].confidence).toBe("low");
  });

  it("de-duplicates a player pasted twice", () => {
    expect(rows(`Josh Allen\nJosh Allen`)).toEqual([["Josh Allen", "bench"]]);
  });
});
