import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeBoard, parsePastedPicks } from "../lib/draft/pasteImport";
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

  it("with no labels at all, a board copy lays itself onto the room's board: screen order snakes after the 12th pick", () => {
    // Picks 1–8 are already marked; the user copies cells 1.9 through 2.1 (screen order: 9..12, then 18 down to 13).
    const known = ["Ja'Marr Chase", "Bijan Robinson", "Jahmyr Gibbs", "Saquon Barkley", "CeeDee Lamb", "Justin Jefferson", "Puka Nacua", "Malik Nabers"];
    const placed = new Map(known.map((n, i) => [byName(n).id, i + 1]));
    const cell = (name: string, tag: string) => `${name}\n${tag}`;
    const text = [
      cell("A. Jeanty", "RB LV (BYE 8)"), cell("N. Collins", "WR HOU (BYE 6)"), cell("D. Henry", "RB BAL (BYE 7)"), cell("B. Bowers", "TE LV (BYE 8)"),
      cell("T. McBride", "TE ARI (BYE 8)"), cell("D. London", "WR ATL (BYE 5)"), cell("J. Taylor", "RB IND (BYE 11)"), cell("A. Brown", "WR NE (BYE 14)"),
      cell("D. Achane", "RB MIA (BYE 12)"), cell("J. Cook", "RB BUF (BYE 7)"),
    ].join("\n");
    const r = parsePastedPicks(text, players, none, { teams: 12, room: { order: "snake", knownCount: 8, placed } });
    expect(r.layout?.best.shape).toBe("grid");
    expect(r.matches.map((m) => [m.line.pickNo, m.player?.name])).toEqual([
      [9, "Ashton Jeanty"],
      [10, "Nico Collins"],
      [11, "Derrick Henry"],
      [12, "Brock Bowers"],
      [13, "James Cook III"],
      [14, "De'Von Achane"],
      [15, "A.J. Brown"],
      [16, "Jonathan Taylor"],
      [17, "Drake London"],
      [18, "Trey McBride"],
    ]);
  });

  it("names already on the board anchor the reading, so any subsection of the grid works — and a plain list stays a list", () => {
    const known = ["Ja'Marr Chase", "Bijan Robinson", "Jahmyr Gibbs"];
    const placed = new Map(known.map((n, i) => [byName(n).id, i + 1]));
    // Board copy from 1.3 across into round 2 for a 3-team room: cells 1.3 | 2.3, 2.2, 2.1 → picks 3, 6, 5, 4.
    const grid = parsePastedPicks("J. Gibbs\nRB DET (BYE 6)\nP. Nacua\nWR LAR (BYE 11)\nC. Lamb\nWR DAL (BYE 14)\nS. Barkley\nRB PHI (BYE 10)", players, none, {
      teams: 3,
      room: { order: "snake", knownCount: 3, placed },
    });
    expect(grid.matches.map((m) => [m.line.pickNo, m.player?.name])).toEqual([
      [3, "Jahmyr Gibbs"],
      [4, "Saquon Barkley"],
      [5, "CeeDee Lamb"],
      [6, "Puka Nacua"],
    ]);
    // The same names as a plain list (no cell tags): chronological.
    const list = parsePastedPicks("Jahmyr Gibbs\nPuka Nacua\nCeeDee Lamb\nSaquon Barkley", players, none, { teams: 3, room: { order: "snake", knownCount: 3, placed } });
    expect(list.layout?.best.shape).toBe("list");
    expect(list.matches.map((m) => m.line.pickNo)).toEqual([3, 4, 5, 6]);
    // Labels, when present, always win.
    const labelled = parsePastedPicks([...round6, ...round7].join("\n"), players, none, { teams: 12, room: { order: "snake", knownCount: 0, placed: new Map() } });
    expect(labelled.matches.map((p) => p.line.pickNo)).toEqual([70, 71, 72, 73, 74, 75]);
  });
});

describe("parsePastedPicks: duplicates in a label-less board copy", () => {
  it("a tied abbreviation whose best guess is already in the paste falls to the other candidate", () => {
    // Round 1 is "A. St. Brown", round 2 (screen order 2.3, 2.2, 2.1) starts with
    // "A. Brown" — also read as Amon-Ra first, but he is taken: it is A.J. Brown.
    const text = ["A. St. Brown", "WR DET (BYE 6)", "J. Gibbs", "RB DET (BYE 6)", "C. Lamb", "WR DAL (BYE 14)", "A. Brown", "WR NE (BYE 14)", "J. Taylor", "RB IND (BYE 11)", "J. Chase", "WR CIN (BYE 6)"].join("\n");
    const r = parsePastedPicks(text, players, none, { teams: 3, room: { order: "snake", knownCount: 0, placed: new Map() } });
    expect(r.matches.map((m) => [m.line.pickNo, m.player?.name])).toEqual([
      [1, "Amon-Ra St. Brown"],
      [2, "Jahmyr Gibbs"],
      [3, "CeeDee Lamb"],
      [4, "Ja'Marr Chase"],
      [5, "Jonathan Taylor"],
      [6, "A.J. Brown"],
    ]);
  });

  it("a tie whose best guess is already gone from the room resolves to the candidate still available", () => {
    // Amon-Ra St. Brown was drafted earlier; a new cell reads "A. Brown · WR NE" — that is A.J. Brown, not a re-paste of Amon-Ra.
    const amon = byName("Amon-Ra St. Brown");
    // No position/team on the line, so the names alone are a tie.
    const r = parsePastedPicks("A. Brown", players, new Set([amon.id]), { teams: 12 });
    expect(r.matches.map((m) => m.player?.name)).toEqual(["A.J. Brown"]);
  });

  it("an exact duplicate line still holds its cell so later cells keep their numbers", () => {
    const text = ["J. Gibbs", "RB DET (BYE 6)", "C. Lamb", "WR DAL (BYE 14)", "J. Taylor", "RB IND (BYE 11)", "J. Gibbs", "RB DET (BYE 6)", "J. Chase", "WR CIN (BYE 6)", "P. Nacua", "WR LAR (BYE 11)"].join("\n");
    const r = parsePastedPicks(text, players, none, { teams: 3, room: { order: "snake", knownCount: 0, placed: new Map() } });
    expect(r.matches.map((m) => [m.line.pickNo, m.player?.name ?? null])).toEqual([
      [1, "Jahmyr Gibbs"],
      [2, "CeeDee Lamb"],
      [3, "Jonathan Taylor"],
      [4, "Puka Nacua"],
      [5, "Ja'Marr Chase"],
      [6, null],
    ]);
    // In a plain list a duplicate is simply dropped, as before.
    expect(names("J. Gibbs\nC. Lamb\nJ. Taylor\nJ. Gibbs\nJ. Chase\nP. Nacua", none, 3)).toEqual(["Jahmyr Gibbs", "CeeDee Lamb", "Jonathan Taylor", "Ja'Marr Chase", "Puka Nacua"]);
  });
});

describe("parsePastedPicks on a real board copy: empty cells and tag variants", () => {
  it("labels of empty cells before a name are ignored — the name takes the label right above it", () => {
    // Round 8 is filling from the right: the copy starts with the empty cells' labels (with or without overall numbers).
    const bare = "8.12\n8.11\n8.10\n8.9\n8.8\n8.7\n8.6\n8.5\n89\nT. Kraft\nTE GB (BYE 11)";
    expect(parsePastedPicks(bare, players, none, { teams: 12 }).matches.map((m) => [m.line.pickNo, m.player?.name])).toEqual([[89, "Tucker Kraft"]]);
    const withOverall = "8.12\n96\n8.11\n95\n8.5\n89\nT. Kraft\nTE GB (BYE 11)\n8.4\n88\nJ. Williams\nWR DET (BYE 8)";
    expect(parsePastedPicks(withOverall, players, none, { teams: 12 }).matches.map((m) => [m.line.pickNo, m.player?.name])).toEqual([
      [88, "Jameson Williams"],
      [89, "Tucker Kraft"],
    ]);
  });

  it("label and overall on one line, and a BYE tag without parentheses, still read", () => {
    const r = parsePastedPicks("6.12 72\nQ. Johnston\nWR LAC BYE 7\n7.1 73\nT. Kraft\nTE GB BYE 11", players, none, { teams: 12 });
    expect(r.matches.map((m) => [m.line.pickNo, m.player?.name])).toEqual([
      [72, "Quentin Johnston"],
      [73, "Tucker Kraft"],
    ]);
    expect(looksLikeBoard("Q. Johnston\nWR LAC BYE 7\nT. Kraft\nTE GB BYE 11", 2)).toBe(true);
    expect(looksLikeBoard("Q. Johnston\nWR LAC · Bye 7\nT. Kraft\nTE GB · Bye 11", 2)).toBe(true);
    expect(looksLikeBoard("Puka Nacua / LAR WR\nR1, P2 - Team 7", 1)).toBe(false);
  });
});
