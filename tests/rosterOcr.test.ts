import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRosterLines } from "../lib/season/rosterOcr";
import type { OcrLine } from "../lib/draft/ocrMatch";
import type { Board } from "../lib/types";

const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
const players = board.players;
const lines = (...texts: string[]): OcrLine[] => texts.map((text, i) => ({ text, confidence: 80, y: i * 20 }));
const rows = (l: OcrLine[]) => readRosterLines(l, players).entries.map((e) => [e.player.name, e.slot]);

describe("readRosterLines", () => {
  it("reads names in panel order and splits starters from bench at the header", () => {
    const r = readRosterLines(lines("QB Josh Allen BUF", "RB Bijan Rob1nson ATL", "WR JaMarr Chasse CIN", "Bench", "Puka Nacua LAR", "Brock Bowers LV"), players);
    expect(r.hasSlots).toBe(true);
    expect(r.entries.map((e) => [e.player.name, e.slot])).toEqual([
      ["Josh Allen", "starter"], ["Bijan Robinson", "starter"], ["Ja'Marr Chase", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "bench"],
    ]);
  });

  it("honours per-line labels over the section", () => {
    expect(rows(lines("QB Josh Allen", "BN Puka Nacua", "IR Brock Bowers", "WR Ja'Marr Chase"))).toEqual([
      ["Josh Allen", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "ir"], ["Ja'Marr Chase", "starter"],
    ]);
  });

  it("with no slot information, everyone is bench", () => {
    const r = readRosterLines(lines("Josh Allen", "Puka Nacua"), players);
    expect(r.hasSlots).toBe(false);
    expect(r.entries.map((e) => e.slot)).toEqual(["bench", "bench"]);
  });

  it("reads a team defense by code and by nickname", () => {
    expect(rows(lines("SEA DEF", "Bench", "Seahawks D/ST"))).toEqual([["Seattle Defense", "starter"]]);
  });

  it("orders by vertical position, not by input order", () => {
    const shuffled: OcrLine[] = [
      { text: "Puka Nacua", confidence: 80, y: 60 },
      { text: "Bench", confidence: 80, y: 40 },
      { text: "Josh Allen", confidence: 80, y: 0 },
    ];
    expect(rows(shuffled)).toEqual([["Josh Allen", "starter"], ["Puka Nacua", "bench"]]);
  });

  it("applies a label-only line to the name line Tesseract split off at the same height", () => {
    // One roster row read as two lines: the Slot column and the Name column.
    const row = (texts: [string, string], y: number): OcrLine[] => texts.map((text) => ({ text, confidence: 80, y }));
    const r = readRosterLines([...row(["Bench", ""], 0).slice(0, 1), ...row(["QB", "Josh Allen"], 20), ...row(["BN", "Puka Nacua"], 40)], players);
    expect(r.entries.map((e) => [e.player.name, e.slot])).toEqual([["Josh Allen", "starter"], ["Puka Nacua", "bench"]]);
    // Input order within a row must not matter.
    const swapped = readRosterLines([...row(["Bench", ""], 0).slice(0, 1), ...row(["Josh Allen", "QB"], 20)], players);
    expect(swapped.entries.map((e) => [e.player.name, e.slot])).toEqual([["Josh Allen", "starter"]]);
  });

  it("skips a tie rather than guessing (the draft's OCR rule)", () => {
    // Two synthetic RBs named Robinson on different teams; a bare surname is ambiguous.
    const twin = (id: string, team: string) => ({ ...players.find((p) => p.pos === "RB")!, id, name: `Sam Robinson`, team });
    const r = readRosterLines(lines("Robinson"), [twin("syn-a", "ATL"), twin("syn-b", "DET")]);
    expect(r.entries).toEqual([]);
  });
});
