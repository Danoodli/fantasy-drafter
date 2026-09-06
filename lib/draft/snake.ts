// Draft-order pick math — snake, snake with third-round reversal, linear —
// including traded picks. Pure functions. Every place that turns a pick
// number into a seat goes through here, so the room's configured order is
// honored everywhere: screen sync, the engine's opponent schedule, recaps.

import type { DraftOrder, TradedPick } from "../types";

/**
 * Does this round run slot 1 → N? Snake alternates; third-round reversal
 * repeats round 2's direction in round 3 and alternates from there (1 asc,
 * 2 desc, 3 desc, 4 asc, 5 desc…); linear never turns.
 */
export function roundAscends(round: number, order: DraftOrder = "snake"): boolean {
  if (order === "linear") return true;
  if (order === "snake3rr") return round === 1 || (round >= 3 && round % 2 === 0);
  return round % 2 === 1;
}

/** The draft-board slot that is on the clock for a given overall pick. */
export function slotOnClock(pickNo: number, teams: number, order: DraftOrder = "snake"): { round: number; slot: number } {
  const round = Math.ceil(pickNo / teams);
  const idx = (pickNo - 1) % teams; // 0-based within round
  const slot = roundAscends(round, order) ? idx + 1 : teams - idx;
  return { round, slot };
}

/** Overall pick number for a given round + board slot. */
export function pickNumber(round: number, slot: number, teams: number, order: DraftOrder = "snake"): number {
  const idx = roundAscends(round, order) ? slot - 1 : teams - slot;
  return (round - 1) * teams + idx + 1;
}

/**
 * The slot that OWNS a given pick, after applying traded picks.
 * Traded picks break naive snake math — don't skip them.
 */
export function pickOwner(pickNo: number, teams: number, traded: TradedPick[], order: DraftOrder = "snake"): number {
  const { round, slot } = slotOnClock(pickNo, teams, order);
  const trade = traded.find((t) => t.round === round && t.originalSlot === slot);
  return trade ? trade.newSlot : slot;
}

/** All pick numbers owned by a slot, ascending. */
export function picksForSlot(
  mySlot: number,
  teams: number,
  rounds: number,
  traded: TradedPick[] = [],
  order: DraftOrder = "snake"
): number[] {
  const picks: number[] = [];
  for (let pickNo = 1; pickNo <= teams * rounds; pickNo++) {
    if (pickOwner(pickNo, teams, traded, order) === mySlot) picks.push(pickNo);
  }
  return picks;
}

export const DRAFT_ORDER_LABEL: Record<DraftOrder, string> = {
  snake: "Snake",
  snake3rr: "Snake · 3rd-round reversal",
  linear: "Linear (same order every round)",
};
