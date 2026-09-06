import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchOcrLines, FrameAgreement, editDistance, normalizeOcr, type OcrLine } from "../lib/draft/ocrMatch";
import type { Board } from "../lib/types";

const board: Board = JSON.parse(
  readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8")
);
const players = board.players;
const none = new Set<string>();
const lines = (...texts: string[]): OcrLine[] => texts.map((text, i) => ({ text, confidence: 80, y: i * 20 }));
const names = (r: ReturnType<typeof matchOcrLines>) => r.matches.map((m) => m.player.name);

describe("editDistance", () => {
  it("bounds correctly", () => {
    expect(editDistance("robinson", "robinson")).toBe(0);
    expect(editDistance("roblnson", "robinson")).toBe(1);
    expect(editDistance("chase", "chasse", 2)).toBe(1);
    expect(editDistance("smith", "robinson", 2)).toBeGreaterThan(2);
  });
});

describe("normalizeOcr", () => {
  it("fixes digit-for-letter glyphs only inside words", () => {
    expect(normalizeOcr("Rob1nson 1.05")).toEqual(["roblnson", "1", "05"]);
  });
});

describe("matchOcrLines", () => {
  it("reads clean full names with position and team noise", () => {
    const r = matchOcrLines(lines("1.01 Ja'Marr Chase WR CIN", "1.02 Bijan Robinson RB ATL"), players, none);
    expect(names(r)).toEqual(["Ja'Marr Chase", "Bijan Robinson"]);
  });

  it("survives one-edit OCR noise in the surname and a garbled first name", () => {
    const r = matchOcrLines(lines("Bijan Rob1nson", "JaMarr Chasse", "Jahmyr Glbbs"), players, none);
    expect(names(r)).toEqual(["Bijan Robinson", "Ja'Marr Chase", "Jahmyr Gibbs"]);
  });

  it("accepts initial + surname when the surname is unique on the board", () => {
    const r = matchOcrLines(lines("J. Gibbs"), players, none);
    expect(names(r)).toEqual(["Jahmyr Gibbs"]);
  });

  // Synthetic pair so the ambiguity tests don't depend on this year's rosters.
  const twin = (name: string, team: string) => ({
    ...players.find((p) => p.pos === "RB")!,
    id: `syn-${name}-${team}`,
    name,
    team,
    pos: "RB" as const,
  });
  const twins = [twin("Bo Rivers", "ATL"), twin("Ben Rivers", "WAS")];

  it("skips an initial + shared surname that two same-position players share", () => {
    const r = matchOcrLines(lines("B. Rivers RB"), twins, none);
    expect(r.matches.length).toBe(0);
  });

  it("uses the team to pin a shared surname", () => {
    const r = matchOcrLines(lines("B. Rivers RB WAS"), twins, none);
    expect(names(r)).toEqual(["Ben Rivers"]);
  });

  it("ignores headers and owners; drafted players are still returned (they anchor the sequence)", () => {
    const chase = players.find((p) => p.name === "Ja'Marr Chase")!;
    const r = matchOcrLines(lines("Round 2", "Team Dan", "Ja'Marr Chase", "Puka Nacua"), players, new Set([chase.id]));
    expect(names(r)).toEqual(["Ja'Marr Chase", "Puka Nacua"]);
  });

  it("reads team defenses", () => {
    const r = matchOcrLines(lines("Seahawks D/ST", "DEN DEF"), players, none);
    expect(names(r)).toEqual(["Seattle Defense", "Denver Defense"]);
  });

  it("reports each player once, keeping the best read, in panel order", () => {
    const r = matchOcrLines(lines("Puka Nacua", "Puka Nacua WR LAR", "Ja'Marr Chase"), players, none);
    expect(names(r)).toEqual(["Puka Nacua", "Ja'Marr Chase"]);
  });



  it("reads ESPN-style 'Name / TEAM POS' lines with OCR junk in front, in panel order", () => {
    const r = matchOcrLines(
      lines("NI", "g    Ja'Marr Chase / CIN WR", "Jonathan Taylor / IND RB", "g   James Cook Ill / BUF RB", "/", "8    Bijan Robinson / ATL RB",
        "PB.   Justin Jefferson / MIN WR", "Vv 3", "g   Amon-Ra St. Brown / DET WR", "h4  Puka Nacua / LAR WR", "4      A", "AR  CeeDee Lamb / DAL WR", "fa Omarion Hampton / LAC RB"),
      players, none
    );
    expect(names(r)).toEqual([
      "Ja'Marr Chase", "Jonathan Taylor", "James Cook III", "Bijan Robinson", "Justin Jefferson",
      "Amon-Ra St. Brown", "Puka Nacua", "CeeDee Lamb", "Omarion Hampton",
    ]);
  });

  it("a drafted player's line does not re-read as his surname-mate", () => {
    const bijan = players.find((p) => p.name === "Bijan Robinson")!;
    const r = matchOcrLines(lines("Bijan Robinson / ATL RB", "R1, P4 - Team 12"), players, new Set([bijan.id]));
    expect(names(r)).toEqual(["Bijan Robinson"]);
  });

  it("does not match a lone common surname", () => {
    const r = matchOcrLines(lines("Smith", "Williams"), players, none);
    expect(r.matches.length).toBe(0);
  });
});

describe("FrameAgreement", () => {
  it("confirms on the second consecutive sighting and reports once", () => {
    const fa = new FrameAgreement();
    const chase = matchOcrLines(lines("Ja'Marr Chase"), players, none).matches;
    expect(fa.observe(chase)).toEqual([]);
    expect(fa.observe(chase).map((m) => m.player.name)).toEqual(["Ja'Marr Chase"]);
    expect(fa.observe(chase)).toEqual([]);
  });

  it("resets when a frame misses the player, and forgets on undo", () => {
    const fa = new FrameAgreement();
    const chase = matchOcrLines(lines("Ja'Marr Chase"), players, none).matches;
    fa.observe(chase);
    fa.observe([]); // dropped frame
    expect(fa.observe(chase)).toEqual([]); // needs two in a row again
    expect(fa.observe(chase).length).toBe(1);
    fa.forget(chase[0].player.id);
    fa.observe(chase);
    expect(fa.observe(chase).length).toBe(1);
  });
});
