import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePastedPicks } from "../lib/draft/pasteImport";
import type { Board } from "../lib/types";

const board: Board = JSON.parse(
  readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8")
);
const players = board.players;
const byName = (n: string) => players.find((p) => p.name === n)!;
const none = new Set<string>();

function names(text: string, drafted = none, teams = 12) {
  return parsePastedPicks(text, players, drafted, { teams }).matches.map((m) => m.player?.name ?? null);
}

describe("parsePastedPicks", () => {
  it("reads Sleeper-style round.pick lines and sorts by pick", () => {
    const r = parsePastedPicks(
      `1.03 Bijan Robinson RB - ATL\n1.01 Ja'Marr Chase WR - CIN\n1.02 Jahmyr Gibbs RB - DET`,
      players, none, { teams: 12 }
    );
    expect(r.hasPickNumbers).toBe(true);
    expect(r.matches.map((m) => m.line.pickNo)).toEqual([1, 2, 3]);
    expect(r.matches.map((m) => m.player?.name)).toEqual(["Ja'Marr Chase", "Jahmyr Gibbs", "Bijan Robinson"]);
    expect(r.matches.every((m) => m.confidence === "high")).toBe(true);
  });

  it("reads ESPN recap lines: '1 (1) Name, TEAM POS'", () => {
    expect(names(`1 (1) Ja'Marr Chase, CIN WR\n2 (2) Bijan Robinson, ATL RB`)).toEqual([
      "Ja'Marr Chase",
      "Bijan Robinson",
    ]);
  });

  it("reads Yahoo lines: '1. (1) Name (Cin - WR)'", () => {
    const r = parsePastedPicks(`1. (1) Ja'Marr Chase (Cin - WR)\n2. (2) Bijan Robinson (Atl - RB)`, players, none, { teams: 12 });
    expect(r.matches.map((m) => m.player?.name)).toEqual(["Ja'Marr Chase", "Bijan Robinson"]);
    expect(r.matches[0].line.team).toBe("CIN");
    expect(r.matches[0].line.pos).toBe("WR");
    expect(r.matches.map((m) => m.line.pickNo)).toEqual([1, 2]);
  });

  it("handles last-first, initials, and suffixes", () => {
    expect(names(`Chase, Ja'Marr\nJ. Gibbs\nBrian Thomas Jr.\nMarvin Harrison`)).toEqual([
      "Ja'Marr Chase",
      "Jahmyr Gibbs",
      "Brian Thomas Jr.",
      "Marvin Harrison Jr.",
    ]);
  });

  it("reads ESPN's live-draft copy: name / TEAM POS, then 'R1, P2 - Team 7' underneath, blank lines between", () => {
    const text = `Puka Nacua / LAR WR
R1, P2 - Team 7

Ja'Marr Chase / CIN WR
R1, P3 - Team 10

Jaxon Smith-Njigba / SEA WR
R1, P6 - Team 6

Amon-Ra St. Brown / DET WR
R1, P8 - Team 3

James Cook III / BUF RB
R1, P9 - Team 11

De'Von Achane / MIA RB
R1, P10 - Team 2

Chase Brown / CIN RB
R2, P1 - Team 8

A.J. Brown / NE WR
R2, P7 - Team 6

Trey McBride / ARI TE
R2, P6 - Team 9`;
    const r = parsePastedPicks(text, players, none, { teams: 12 });
    expect(r.matches.map((m) => m.player?.name)).toEqual([
      "Puka Nacua", "Ja'Marr Chase", "Jaxon Smith-Njigba", "Amon-Ra St. Brown", "James Cook III",
      "De'Von Achane", "Chase Brown", "Trey McBride", "A.J. Brown",
    ]);
    expect(r.matches.map((m) => m.line.pickNo)).toEqual([2, 3, 6, 8, 9, 10, 13, 18, 19]);
    expect(r.matches.every((m) => m.confidence === "high")).toBe(true);
    expect(r.matches.filter((m) => !m.player).length).toBe(0);
  });

  it("finds a name buried in junk, several names on one line, accents folded, suffixes ignored", () => {
    expect(names(`xx 12 Puka Nacua / LAR WR (bye 8) 214.5 pts`)).toEqual(["Puka Nacua"]);
    expect(names(`Bijan Robinson · Puka Nacua · Ja'Marr Chase`)).toEqual(["Bijan Robinson", "Puka Nacua", "Ja'Marr Chase"]);
    expect(names(`Ja'Marr Chasé\nPuká Nacua`)).toEqual(["Ja'Marr Chase", "Puka Nacua"]);
    expect(names(`James Cook\nMarvin Harrison Sr.\nBrian Thomas`)).toEqual(["James Cook III", "Marvin Harrison Jr.", "Brian Thomas Jr."]);
    expect(names(`AJ Brown\nA. J. Brown`)).toEqual(["A.J. Brown"]);
  });

  it("does not read 'K. Walker' as a kicker", () => {
    const r = parsePastedPicks(`K. Walker`, players, none, { teams: 12 });
    expect(r.matches[0].player?.name).toBe("Kenneth Walker");
    expect(r.matches[0].line.pos).toBeNull();
  });

  it("uses a trailing position token to disambiguate shared surnames; a true tie is a low-confidence best guess", () => {
    const r = parsePastedPicks(`Robinson WR\nRobinson RB ATL`, players, none, { teams: 12 });
    expect(r.matches[0].player?.name).toBe("Wan'Dale Robinson");
    // Two ATL RB Robinsons on this board: the earlier-ADP one is offered, flagged, with alternatives.
    expect(r.matches[1].player?.name).toBe("Bijan Robinson");
    expect(r.matches[1].confidence).toBe("low");
    expect(r.matches[1].suggestions.map((s) => s.name)).toContain("Brian Robinson");
  });

  it("maps team defenses by nickname, city, code, and D/ST", () => {
    expect(names(`Seahawks D/ST\nDenver Defense\nHOU DST\nLos Angeles Rams`)).toEqual([
      "Seattle Defense",
      "Denver Defense",
      "Houston Defense",
      "LA Rams Defense",
    ]);
  });

  it("stitches pick / name / meta split across lines", () => {
    const r = parsePastedPicks(`1.01\nJa'Marr Chase\nCIN WR\n1.02\nJahmyr Gibbs\nDET RB`, players, none, { teams: 12 });
    expect(r.matches.map((m) => m.player?.name)).toEqual(["Ja'Marr Chase", "Jahmyr Gibbs"]);
    expect(r.matches.map((m) => m.line.pickNo)).toEqual([1, 2]);
  });

  it("ignores headers and owner-only lines, flags already-drafted players", () => {
    const drafted = new Set([byName("Ja'Marr Chase").id]);
    const r = parsePastedPicks(`Round 1\nJa'Marr Chase WR CIN\nTeam Dan\nBijan Robinson RB ATL`, players, drafted, { teams: 12 });
    expect(r.ignored).toContain("Round 1");
    const chase = r.matches.find((m) => m.player?.name === "Ja'Marr Chase")!;
    expect(chase.alreadyDrafted).toBe(true);
    expect(r.matches.find((m) => m.player?.name === "Bijan Robinson")!.alreadyDrafted).toBe(false);
    const dan = r.matches.find((m) => m.line.raw === "Team Dan");
    expect(dan == null || dan.player == null || dan.confidence === "low").toBe(true);
  });

  it("treats a clean descending bare-number column as pick numbers and re-sorts ascending", () => {
    const r = parsePastedPicks(`3 Bijan Robinson\n2 Jahmyr Gibbs\n1 Ja'Marr Chase`, players, none, { teams: 12 });
    expect(r.hasPickNumbers).toBe(true);
    expect(r.matches.map((m) => m.player?.name)).toEqual(["Ja'Marr Chase", "Jahmyr Gibbs", "Bijan Robinson"]);
  });

  it("keeps pasted order when there are no pick numbers", () => {
    const r = parsePastedPicks(`Bijan Robinson\nJa'Marr Chase`, players, none, { teams: 12 });
    expect(r.hasPickNumbers).toBe(false);
    expect(r.matches.map((m) => m.player?.name)).toEqual(["Bijan Robinson", "Ja'Marr Chase"]);
  });

  it("marks a single surname with several candidates as low confidence with suggestions", () => {
    const r = parsePastedPicks(`Smith`, players, none, { teams: 12 });
    expect(r.matches[0].confidence).toBe("low");
    expect(r.matches[0].suggestions.length).toBeGreaterThan(1);
  });

  it("a different first name in front of a shared surname never matches the surname-mate", () => {
    // "Bijan" is not Brian: with Bijan already gone this line must not become Brian Robinson.
    const bijan = byName("Bijan Robinson");
    const r = parsePastedPicks(`Bijan Robinson / ATL RB`, players, new Set([bijan.id]), { teams: 12 });
    expect(r.matches.map((m) => [m.player?.name, m.alreadyDrafted])).toEqual([["Bijan Robinson", true]]);
  });

  it("drops a duplicate paste of the same player", () => {
    const r = parsePastedPicks(`Ja'Marr Chase\nJa'Marr Chase`, players, none, { teams: 12 });
    expect(r.matches.filter((m) => m.player).length).toBe(1);
  });
});

describe("parsePastedPicks on a draft BOARD grid (DraftKings)", () => {
  // Copying the board yields the cells in screen order — left to right, row
  // by row — but even rounds run right to left. Order is useless; the cell
  // labels are the truth, and picks 1–9 are written "7.1", not "7.01".
  const cell = (label: string, overall: number | null, name: string, tag: string) =>
    [label, overall == null ? null : String(overall), name, tag].filter((x) => x != null).join("\n");
  const round6 = [
    cell("6.12", 72, "Q. Johnston", "WR LAC (BYE 7)"),
    cell("6.11", 71, "C. Williams", "QB CHI (BYE 10)"),
    cell("6.10", 70, "T. Henderson", "RB NE (BYE 11)"),
  ];
  const round7 = [
    cell("7.1", 73, "T. Kraft", "TE GB (BYE 11)"),
    cell("7.2", 74, "J. Williams", "WR DET (BYE 8)"),
    cell("7.3", 75, "D. Prescott", "QB DAL (BYE 14)"),
  ];
  const picks = (r: ReturnType<typeof parsePastedPicks>) => r.matches.map((m) => [m.line.pickNo, m.player?.name]);

  it("reads one-field-per-line cells with single-digit picks and sorts by the label", () => {
    const r = parsePastedPicks([...round6, ...round7].join("\n"), players, none, { teams: 12 });
    expect(r.hasPickNumbers).toBe(true);
    expect(picks(r)).toEqual([
      [70, "TreVeyon Henderson"],
      [71, "Caleb Williams"],
      [72, "Quentin Johnston"],
      [73, "Tucker Kraft"],
      [74, "Jameson Williams"],
      [75, "Dak Prescott"],
    ]);
    expect(r.matches.every((m) => m.confidence === "high")).toBe(true);
  });

  it("reads cells without the overall pick number", () => {
    const text = [cell("6.12", null, "Q. Johnston", "WR LAC (BYE 7)"), cell("7.1", null, "T. Kraft", "TE GB (BYE 11)"), cell("7.2", null, "J. Williams", "WR DET (BYE 8)")].join("\n");
    expect(picks(parsePastedPicks(text, players, none, { teams: 12 }))).toEqual([
      [72, "Quentin Johnston"],
      [73, "Tucker Kraft"],
      [74, "Jameson Williams"],
    ]);
  });

  it("splits a row copied as one tab-separated line into its cells", () => {
    const row = round7.map((c) => c.replace(/\n/g, "\t")).join("\t");
    expect(picks(parsePastedPicks(row, players, none, { teams: 12 }))).toEqual([
      [73, "Tucker Kraft"],
      [74, "Jameson Williams"],
      [75, "Dak Prescott"],
    ]);
  });

  it("with no labels at all, the snake-grid option numbers rows as rounds, even rounds right to left", () => {
    const row1 = ["Ja'Marr Chase", "Bijan Robinson", "Jahmyr Gibbs"];
    const row2 = ["Puka Nacua", "Saquon Barkley", "CeeDee Lamb"]; // screen order; drafted 3.. wait: 2.3, 2.2, 2.1
    const row3 = ["Malik Nabers", "Ashton Jeanty"];
    const text = [...row1, ...row2, ...row3].join("\n");
    const plain = parsePastedPicks(text, players, none, { teams: 3 });
    expect(plain.hasPickNumbers).toBe(false);
    const grid = parsePastedPicks(text, players, none, { teams: 3, snakeGrid: { firstRound: 1 } });
    expect(picks(grid)).toEqual([
      [1, "Ja'Marr Chase"],
      [2, "Bijan Robinson"],
      [3, "Jahmyr Gibbs"],
      [4, "CeeDee Lamb"],
      [5, "Saquon Barkley"],
      [6, "Puka Nacua"],
      [7, "Malik Nabers"],
      [8, "Ashton Jeanty"],
    ]);
  });

  it("the snake-grid option can start at a later round, and never overrides labels that are present", () => {
    const text = ["Ja'Marr Chase", "Bijan Robinson", "Jahmyr Gibbs", "Puka Nacua"].join("\n");
    const r = parsePastedPicks(text, players, none, { teams: 3, snakeGrid: { firstRound: 6 } });
    // Round 6 is even: right to left on screen, so the first screen cell is pick 6.3 = 18.
    expect(picks(r)).toEqual([
      [16, "Jahmyr Gibbs"],
      [17, "Bijan Robinson"],
      [18, "Ja'Marr Chase"],
      [19, "Puka Nacua"],
    ]);
    const labelled = parsePastedPicks([...round6, ...round7].join("\n"), players, none, { teams: 12, snakeGrid: { firstRound: 1 } });
    expect(picks(labelled).map((p) => p[0])).toEqual([70, 71, 72, 73, 74, 75]);
  });
});
