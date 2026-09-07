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

function cellWords(c: Cell, col: number, row: number, opts: { anchor?: boolean; overall?: boolean } = {}): OcrWord[] {
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
  if (opts.overall !== false) out.push(word(String((c.round - 1) * TEAMS + c.pick), 0, 16));
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
function gridWords(rows: Cell[][], skipAnchors: Set<string> = new Set()): OcrWord[] {
  const words: OcrWord[] = [];
  rows.forEach((cells, row) => {
    cells.forEach((c) => {
      const col = c.round % 2 === 1 ? c.pick - 1 : TEAMS - c.pick;
      words.push(...cellWords(c, col, row, { anchor: !skipAnchors.has(`${c.round}.${c.pick}`) }));
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
    // both cells, so only the cell width keeps J. Warren out of pick 73.
    const cells: Cell[] = [
      { round: 7, pick: 1, name: "Xyzzy Qwerty", tag: "RB PIT (BYE 9)" },
      { round: 7, pick: 2, name: "J. Warren", tag: "RB PIT (BYE 9)" },
      { round: 7, pick: 3, name: "D. Prescott", tag: "QB DAL (BYE 14)" },
      { round: 7, pick: 6, name: "M. Harrison Jr.", tag: "WR ARI (BYE 14)" },
    ];
    const r = readGrid(gridWords([cells], new Set(["7.2"])), players, { teams: TEAMS });
    expect(r.anchors).toBe(3);
    expect(byPick(r)).toEqual({ 75: "Dak Prescott", 78: "Marvin Harrison Jr." });
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
    const r = readGrid(gridWords([[{ round: 7, pick: 1, name: "T. Kraft", tag: "TE GB (BYE 11)" }]]), players, { teams: 10 });
    expect(byPick(r)).toEqual({ 61: "Tucker Kraft" });
    const bad = readGrid(gridWords([[{ round: 6, pick: 12, name: "Q. Johnston", tag: "WR LAC (BYE 7)" }]]), players, { teams: 10 });
    expect(bad.anchors).toBe(0);
  });
});
