// The room's draft BOARD as a grid: one column per draft slot, one row per
// round, picks snaking the way the room's order says (lib/draft/snake.ts).
// Pure — picks in, rows of cells out — shared by the cockpit's Board view and
// the mock board fixture, so both draw exactly what DraftKings draws.

import type { DraftOrder, DraftPick, Position } from "../types";
import { slotOnClock } from "./snake";

export interface BoardCell {
  /** Overall pick number this cell is. */
  pickNo: number;
  round: number;
  /** 1-based column: the draft slot that sits under this pick on the board. */
  slot: number;
  /** The pick made here; null until it happens. An unknown placeholder has playerId "". */
  pick: DraftPick | null;
}

/** rows[round − 1][slot − 1] — every cell of the board, filled or not. */
export function layoutBoard(picks: DraftPick[], teams: number, rounds: number, order: DraftOrder): BoardCell[][] {
  const byPick = new Map<number, DraftPick>();
  for (const p of picks) if (p.pickNo >= 1) byPick.set(p.pickNo, p);
  const rows: BoardCell[][] = Array.from({ length: rounds }, (_, r) =>
    Array.from({ length: teams }, (_, c) => ({ pickNo: 0, round: r + 1, slot: c + 1, pick: null }))
  );
  for (let pickNo = 1; pickNo <= teams * rounds; pickNo++) {
    const { round, slot } = slotOnClock(pickNo, teams, order);
    const cell = rows[round - 1][slot - 1];
    cell.pickNo = pickNo;
    cell.pick = byPick.get(pickNo) ?? null;
  }
  return rows;
}

/** "Marvin Harrison Jr." → "M. Harrison Jr."; "A.J. Brown" → "A. Brown"; team defenses keep their name. */
export function abbreviateName(name: string, pos: Position | null): string {
  if (pos === "DST") return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}
