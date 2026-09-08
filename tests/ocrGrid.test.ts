import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readGrid, type OcrWord } from "../lib/draft/ocrGrid";
import type { Board } from "../lib/types";

const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
const players = board.players;

// A synthetic DraftKings-style board: 12 columns, cells 124 px wide and 94 px
// tall, each cell "R.P" top-left, the overall pick under it, then the name,
// then "POS TEAM (BYE n)". Even rounds run right to left (snake).
const CELL_W = 124;
const CELL_H = 94;
const TEAMS = 12;

interface Cell {
  round: number;
  pick: number;
  name: string;
  tag: string;
}

function cellWords(c: Cell, col: number, row: number, opts: { anchor?: boolean; overall?: boolean; teams?: number } = {}): OcrWord[] {
  const x = col * CELL_W + 8;
  const y = row * CELL_H + 6;
  const word = (text: string, dx: number, dy: number, w = text.length * 7): OcrWord => ({
    text,
    confidence: 85,
    x0: x + dx,
    y0: y + dy,
    x1: x + dx + w,
    y1: y + dy + 12,
  });
  const out: OcrWord[] = [];
  if (opts.anchor !== false) out.push(word(`${c.round}.${c.pick}`, 0, 0));
  if (opts.overall !== false) out.push(word(String((c.round - 1) * (opts.teams ?? TEAMS) + c.pick), 0, 16));
  let dx = 0;
  for (const t of c.name.split(" ")) {
    out.push(word(t, dx, 48));
    dx += t.length * 7 + 5;
  }
  dx = 0;
  for (const t of c.tag.split(" ")) {
    out.push(word(t, dx, 66));
    dx += t.length * 7 + 5;
  }
  return out;
}

/** Lay out rows of cells in snake order: even rounds are reversed on screen. */
function gridWords(rows: Cell[][], skipAnchors: Set<string> = new Set(), teams = TEAMS): OcrWord[] {
  const words: OcrWord[] = [];
  rows.forEach((cells, row) => {
    cells.forEach((c) => {
      const col = c.round % 2 === 1 ? c.pick - 1 : teams - c.pick;
      words.push(...cellWords(c, col, row, { anchor: !skipAnchors.has(`${c.round}.${c.pick}`), teams }));
    });
  });
  // Shuffle deterministically so order of input never matters.
  return words.sort((a, b) => (a.text.length * 31 + a.x0 * 7 + a.y0 * 3) % 97 - ((b.text.length * 31 + b.x0 * 7 + b.y0 * 3) % 97));
}

const round6: Cell[] = [
  { round: 6, pick: 12, name: "Q. Johnston", tag: "WR LAC (BYE 7)" },
  { round: 6, pick: 11, name: "C. Williams", tag: "QB CHI (BYE 10)" },
  { round: 6, pick: 10, name: "T. Henderson", tag: "RB NE (BYE 11)" },
  { round: 6, pick: 9, name: "M. Wilson", tag: "WR ARI (BYE 14)" },
  { round: 6, pick: 8, name: "C. Godwin Jr.", tag: "WR TB (BYE 10)" },
  { round: 6, pick: 6, name: "D. Maye", tag: "QB NE (BYE 11)" },
];
const round7: Cell[] = [
  { round: 7, pick: 1, name: "T. Kraft", tag: "TE GB (BYE 11)" },
  { round: 7, pick: 2, name: "J. Warren", tag: "RB PIT (BYE 9)" },
  { round: 7, pick: 3, name: "D. Prescott", tag: "QB DAL (BYE 14)" },
  { round: 7, pick: 6, name: "M. Harrison Jr.", tag: "WR ARI (BYE 14)" },
];

const byPick = (r: ReturnType<typeof readGrid>) => Object.fromEntries(r.picks.map((p) => [p.pickNo, p.player.name]));

describe("readGrid", () => {
  it("reads round.pick labels as trusted pick numbers, so snake direction does not matter", () => {
    const r = readGrid(gridWords([round6, round7]), players, { teams: TEAMS });
    expect(r.anchors).toBe(10);
    expect(byPick(r)).toEqual({
      72: "Quentin Johnston",
      71: "Caleb Williams",
      70: "TreVeyon Henderson",
      69: "Michael Wilson",
      68: "Chris Godwin Jr.",
      66: "Drake Maye",
      73: "Tucker Kraft",
      74: "Jaylen Warren",
      75: "Dak Prescott",
      78: "Marvin Harrison Jr.",
    });
    expect(r.picks.map((p) => p.pickNo)).toEqual([66, 68, 69, 70, 71, 72, 73, 74, 75, 78]);
  });

  it("uses the cell's position and team to pick among players sharing an initial and surname", () => {
    // "J. Williams" is Javonte (RB DAL) or Jameson (WR DET) — a tie the list
    // reader skips; the cell's "WR DET" settles it. "J. Warren" likewise.
    const cells: Cell[] = [
      { round: 7, pick: 2, name: "J. Williams", tag: "WR DET (BYE 8)" },
      { round: 7, pick: 4, name: "J. Warren", tag: "RB PIT (BYE 9)" },
    ];
    const r = readGrid(gridWords([cells]), players, { teams: TEAMS });
    expect(byPick(r)).toEqual({ 74: "Jameson Williams", 76: "Jaylen Warren" });
  });

  it("drops words that sit above the first anchored row (a cut-off round with no label)", () => {
    const orphan: OcrWord[] = [
      { text: "L.", confidence: 80, x0: 8, y0: -40, x1: 20, y1: -28 },
      { text: "Jackson", confidence: 80, x0: 24, y0: -40, x1: 70, y1: -28 },
      { text: "QB", confidence: 80, x0: 8, y0: -22, x1: 22, y1: -10 },
      { text: "BAL", confidence: 80, x0: 26, y0: -22, x1: 46, y1: -10 },
    ];
    const r = readGrid([...orphan, ...gridWords([round7])], players, { teams: TEAMS });
    expect(Object.values(byPick(r))).not.toContain("Lamar Jackson");
    expect(byPick(r)[73]).toBe("Tucker Kraft");
  });

  it("does not let a cell whose label was missed bleed its name into the neighbor to the left", () => {
    // 7.1 is unreadable junk; 7.2's label is unread. Same position and team in
    // both cells, so only the cell geometry keeps J. Warren out of pick 73.
    const cells: Cell[] = [
      { round: 7, pick: 1, name: "Xyzzy Qwerty", tag: "RB PIT (BYE 9)" },
      { round: 7, pick: 2, name: "J. Warren", tag: "RB PIT (BYE 9)" },
      { round: 7, pick: 3, name: "D. Prescott", tag: "QB DAL (BYE 14)" },
      { round: 7, pick: 6, name: "M. Harrison Jr.", tag: "WR ARI (BYE 14)" },
    ];
    const r = readGrid(gridWords([cells], new Set(["7.2"])), players, { teams: TEAMS });
    expect(r.anchors).toBe(3);
    // The three good labels calibrate the grid, so J. Warren is read at HIS cell, 7.2 — never at 7.1.
    expect(byPick(r)).toEqual({ 74: "Jaylen Warren", 75: "Dak Prescott", 78: "Marvin Harrison Jr." });
  });

  it("repairs a label whose dot OCR dropped ('11' → 1.1) from the overall pick number under it", () => {
    // Small bold "1.1" often comes back as "11"; the gray overall pick right
    // below it says which cell this is. 1.3 likewise ("13" over "3").
    const words = gridWords([[
      { round: 1, pick: 1, name: "J. Gibbs", tag: "RB DET (BYE 6)" },
      { round: 1, pick: 2, name: "C. Lamb", tag: "WR DAL (BYE 14)" },
      { round: 1, pick: 3, name: "J. Taylor", tag: "RB IND (BYE 13)" },
    ]]).map((w) => (w.text === "1.1" ? { ...w, text: "11" } : w.text === "1.3" ? { ...w, text: "13" } : w));
    const r = readGrid(words, players, { teams: TEAMS });
    expect(r.anchors).toBe(3);
    expect(byPick(r)).toEqual({ 1: "Jahmyr Gibbs", 2: "CeeDee Lamb", 3: "Jonathan Taylor" });
  });

  it("a dotless number with no overall pick under it is not a label ('71' is not 7.1, nor pick 71)", () => {
    const words = gridWords([[{ round: 7, pick: 1, name: "T. Kraft", tag: "TE GB (BYE 11)" }]])
      .map((w) => (w.text === "7.1" ? { ...w, text: "71" } : w))
      .filter((w) => w.text !== "73");
    const r = readGrid(words, players, { teams: TEAMS });
    expect(r.anchors).toBe(0);
    expect(r.picks).toEqual([]);
  });

  it("skips a cell whose label and overall pick disagree rather than guess", () => {
    // "7.1" read as "7.4" (a 1→4 glyph slip) over overall 73: 7.4 would be 76. Neither is trusted.
    const words = gridWords([[
      { round: 7, pick: 1, name: "T. Kraft", tag: "TE GB (BYE 11)" },
      { round: 7, pick: 2, name: "J. Williams", tag: "WR DET (BYE 8)" },
    ]]).map((w) => (w.text === "7.1" ? { ...w, text: "7.4" } : w));
    const r = readGrid(words, players, { teams: TEAMS });
    expect(byPick(r)).toEqual({ 74: "Jameson Williams" });
  });

  it("breaks an initial-and-surname tie by which candidate's ADP is near the cell's pick number", () => {
    // Bijan and Brian Robinson are both "B. Robinson · RB ATL" on this board.
    // At 1.2 only Bijan (ADP 2) is plausible against Brian (ADP 160+).
    const bijan = players.find((p) => p.name === "Bijan Robinson")!;
    const brian = players.find((p) => p.name === "Brian Robinson")!;
    expect(bijan.team).toBe(brian.team);
    const early = readGrid(gridWords([[{ round: 1, pick: 2, name: "B. Robinson", tag: "RB ATL (BYE 11)" }]]), players, { teams: TEAMS });
    expect(byPick(early)).toEqual({ 2: "Bijan Robinson" });
  });

  it("a tie candidate already placed at another pick is out; the cell that placed him still reads as him", () => {
    const bijan = players.find((p) => p.name === "Bijan Robinson")!;
    const late = gridWords([[{ round: 9, pick: 4, name: "B. Robinson", tag: "RB ATL (BYE 11)" }]]);
    // ADP alone is not decisive at pick 100 (Bijan 98 away, Brian ~64 away) — skipped…
    expect(readGrid(late, players, { teams: TEAMS }).picks).toEqual([]);
    // …until we know Bijan sits at pick 2, which leaves only Brian.
    expect(byPick(readGrid(late, players, { teams: TEAMS, placed: new Map([[bijan.id, 2]]) }))).toEqual({ 100: "Brian Robinson" });
    const own = gridWords([[{ round: 1, pick: 2, name: "B. Robinson", tag: "RB ATL (BYE 11)" }]]);
    expect(byPick(readGrid(own, players, { teams: TEAMS, placed: new Map([[bijan.id, 2]]) }))).toEqual({ 2: "Bijan Robinson" });
  });

  it("still skips a tie when both candidates' ADPs are equally plausible for the pick", () => {
    const twin = (name: string, adp: number) => ({ ...players.find((p) => p.pos === "RB")!, id: `syn-${name}`, name, team: "ATL", pos: "RB" as const, adp });
    const pool = [twin("Bo Rivers", 70), twin("Ben Rivers", 82)];
    const r = readGrid(gridWords([[{ round: 7, pick: 4, name: "B. Rivers", tag: "RB ATL (BYE 5)" }]]), pool, { teams: TEAMS });
    expect(r.picks).toEqual([]);
  });

  it("does not let headshot junk on the line above merge into the name's initial", () => {
    // OCR reads specks of the photo as "I", "he", "RA" on the overall-pick line;
    // joined naively, "I J." becomes the initials "ij" and the name is lost.
    const cells: Cell[] = [
      { round: 1, pick: 4, name: "J. Smith-Njigba", tag: "WR SEA (BYE 11)" },
      { round: 1, pick: 5, name: "T. McBride", tag: "TE ARI (BYE 14)" },
    ];
    const junk: OcrWord[] = [
      { text: "I", confidence: 50, x0: 3 * CELL_W + 8 + 55, y0: 6 + 17, x1: 3 * CELL_W + 8 + 60, y1: 6 + 35 },
      { text: "he", confidence: 16, x0: 4 * CELL_W + 8 + 52, y0: 6 + 15, x1: 4 * CELL_W + 8 + 66, y1: 6 + 27 },
    ];
    const r = readGrid([...gridWords([cells]), ...junk], players, { teams: TEAMS });
    expect(byPick(r)).toEqual({ 4: "Jaxon Smith-Njigba", 5: "Trey McBride" });
  });

  it("with a calibrated grid, a garbled label is recovered from the cell's position", () => {
    // A full row calibrates column pitch and origin. 1.11's label comes back
    // as "11" over "1" (which alone would say 1.1) and 1.6's as "1M" — both
    // cells still read, at their true picks, and 1.1 stays Gibbs.
    const row: Cell[] = [
      { round: 1, pick: 1, name: "J. Gibbs", tag: "RB DET (BYE 6)" },
      { round: 1, pick: 2, name: "C. Lamb", tag: "WR DAL (BYE 14)" },
      { round: 1, pick: 3, name: "J. Taylor", tag: "RB IND (BYE 13)" },
      { round: 1, pick: 4, name: "J. Smith-Njigba", tag: "WR SEA (BYE 11)" },
      { round: 1, pick: 5, name: "J. Chase", tag: "WR CIN (BYE 6)" },
      { round: 1, pick: 6, name: "P. Nacua", tag: "WR LAR (BYE 11)" },
      { round: 1, pick: 7, name: "A. St. Brown", tag: "WR DET (BYE 6)" },
      { round: 1, pick: 8, name: "C. McCaffrey", tag: "RB SF (BYE 8)" },
      { round: 1, pick: 9, name: "S. Barkley", tag: "RB PHI (BYE 10)" },
      { round: 1, pick: 10, name: "D. Henry", tag: "RB BAL (BYE 13)" },
      { round: 1, pick: 11, name: "D. Achane", tag: "RB MIA (BYE 6)" },
      { round: 1, pick: 12, name: "J. Cook", tag: "RB BUF (BYE 7)" },
    ];
    const words = gridWords([row]).map((w) => {
      if (w.text === "1.11") return { ...w, text: "11" };
      if (w.text === "11" && w.y0 > 12) return { ...w, text: "1" }; // its overall, misread
      if (w.text === "1.6") return { ...w, text: "1M" };
      return w;
    });
    const r = readGrid(words, players, { teams: TEAMS });
    expect(byPick(r)[1]).toBe("Jahmyr Gibbs");
    expect(byPick(r)[6]).toBe("Puka Nacua");
    expect(byPick(r)[11]).toBe("De'Von Achane");
    expect(r.picks.length).toBe(12);
  });

  it("with a calibrated grid, a misread overall pick does not veto a good label", () => {
    const row: Cell[] = [
      { round: 6, pick: 12, name: "Q. Johnston", tag: "WR LAC (BYE 7)" },
      { round: 6, pick: 11, name: "R. Dowdle", tag: "RB PIT (BYE 9)" },
      { round: 6, pick: 10, name: "T. Henderson", tag: "RB NE (BYE 11)" },
      { round: 6, pick: 9, name: "M. Wilson", tag: "WR ARI (BYE 14)" },
    ];
    const words = gridWords([row]).map((w) => (w.text === "71" ? { ...w, text: "7" } : w));
    expect(byPick(readGrid(words, players, { teams: TEAMS }))[71]).toBe("Rico Dowdle");
  });

  it("a spurious mid-cell number does not shrink the cell pitch", () => {
    const row: Cell[] = [
      { round: 7, pick: 1, name: "T. Kraft", tag: "TE GB (BYE 11)" },
      { round: 7, pick: 2, name: "J. Williams", tag: "WR DET (BYE 8)" },
      { round: 7, pick: 3, name: "D. Prescott", tag: "QB DAL (BYE 14)" },
      { round: 7, pick: 4, name: "T. Pollard", tag: "RB TEN (BYE 9)" },
    ];
    // A "7.3"-looking speck 60 px into cell 2, on the label line.
    const speck: OcrWord = { text: "7.3", confidence: 40, x0: CELL_W + 8 + 60, y0: 6, x1: CELL_W + 8 + 80, y1: 18 };
    const r = readGrid([...gridWords([row]), speck], players, { teams: TEAMS });
    expect(byPick(r)).toEqual({ 73: "Tucker Kraft", 74: "Jameson Williams", 75: "Dak Prescott", 76: "Tony Pollard" });
  });

  it("rows are consecutive rounds: a row whose labels mostly misread as another round is corrected by its neighbours", () => {
    // Black cell gaps make OCR read "1.2" as "11.2" for most of row 1 — the
    // column still fits, so only the rounds of rows 2 and 3 can expose it.
    const rows: Cell[][] = [
      [
        { round: 1, pick: 1, name: "J. Gibbs", tag: "RB DET (BYE 6)" },
        { round: 1, pick: 2, name: "C. Lamb", tag: "WR DAL (BYE 14)" },
        { round: 1, pick: 3, name: "J. Taylor", tag: "RB IND (BYE 13)" },
        { round: 1, pick: 4, name: "J. Smith-Njigba", tag: "WR SEA (BYE 11)" },
        { round: 1, pick: 5, name: "J. Chase", tag: "WR CIN (BYE 6)" },
      ],
      [
        { round: 2, pick: 12, name: "A. Jeanty", tag: "RB LV (BYE 8)" },
        { round: 2, pick: 11, name: "N. Collins", tag: "WR HOU (BYE 6)" },
        { round: 2, pick: 10, name: "M. Nabers", tag: "WR NYG (BYE 14)" },
        { round: 2, pick: 9, name: "G. Pickens", tag: "WR DAL (BYE 10)" },
      ],
      [
        { round: 3, pick: 1, name: "K. Walker", tag: "RB SEA (BYE 8)" },
        { round: 3, pick: 2, name: "O. Hampton", tag: "RB LAC (BYE 12)" },
        { round: 3, pick: 3, name: "T. McBride", tag: "TE ARI (BYE 8)" },
        { round: 3, pick: 4, name: "J. Allen", tag: "QB BUF (BYE 7)" },
      ],
    ];
    const words = gridWords(rows).map((w) => (/^1\.[2-5]$/.test(w.text) ? { ...w, text: `1${w.text}` } : w));
    const r = readGrid(words, players, { teams: TEAMS });
    expect(byPick(r)[1]).toBe("Jahmyr Gibbs");
    expect(byPick(r)[2]).toBe("CeeDee Lamb");
    expect(byPick(r)[5]).toBe("Ja'Marr Chase");
    expect(byPick(r)[24]).toBe("Ashton Jeanty");
    expect(byPick(r)[27]).toBe("Trey McBride");
    expect(r.picks.every((p) => p.round <= 3)).toBe(true);
  });

  it("reads a name the board truncated with an ellipsis ('D. Montgo...', 'J. Croskey-M...')", () => {
    const cells: Cell[] = [
      { round: 5, pick: 5, name: "D. Montgo...", tag: "RB HOU (BYE 8)" },
      { round: 5, pick: 6, name: "T. Hender...", tag: "RB NE (BYE 11)" },
      { round: 5, pick: 7, name: "J. Croskey-M...", tag: "RB WAS (BYE 7)" },
    ];
    const r = readGrid(gridWords([cells]), players, { teams: TEAMS });
    expect(byPick(r)).toEqual({ 53: "David Montgomery", 54: "TreVeyon Henderson", 55: "Jacory Croskey-Merritt" });
  });

  it("returns no picks and no anchors for a plain vertical list", () => {
    const list: OcrWord[] = [
      { text: "Bijan", confidence: 80, x0: 0, y0: 0, x1: 40, y1: 12 },
      { text: "Robinson", confidence: 80, x0: 44, y0: 0, x1: 100, y1: 12 },
      { text: "Ja'Marr", confidence: 80, x0: 0, y0: 20, x1: 40, y1: 32 },
      { text: "Chase", confidence: 80, x0: 44, y0: 20, x1: 100, y1: 32 },
    ];
    const r = readGrid(list, players, { teams: TEAMS });
    expect(r.anchors).toBe(0);
    expect(r.picks).toEqual([]);
  });

  it("ignores labels whose pick exceeds the league size", () => {
    const r = readGrid(gridWords([[{ round: 7, pick: 1, name: "T. Kraft", tag: "TE GB (BYE 11)" }]], new Set(), 10), players, { teams: 10 });
    expect(byPick(r)).toEqual({ 61: "Tucker Kraft" });
    const bad = readGrid(gridWords([[{ round: 6, pick: 12, name: "Q. Johnston", tag: "WR LAC (BYE 7)" }]], new Set(), 10), players, { teams: 10 });
    expect(bad.anchors).toBe(0);
  });
});
