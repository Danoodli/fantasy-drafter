// Snake-draft pick math, including traded picks. Pure functions.

import type { TradedPick } from "../types";

/** The draft-board slot that is on the clock for a given overall pick. */
export function slotOnClock(pickNo: number, teams: number): { round: number; slot: number } {
  const round = Math.ceil(pickNo / teams);
  const idx = (pickNo - 1) % teams; // 0-based within round
  const slot = round % 2 === 1 ? idx + 1 : teams - idx;
  return { round, slot };
}

/** Overall pick number for a given round + board slot. */
export function pickNumber(round: number, slot: number, teams: number): number {
  const idx = round % 2 === 1 ? slot - 1 : teams - slot;
  return (round - 1) * teams + idx + 1;
}

/**
 * The slot that OWNS a given pick, after applying traded picks.
 * Traded picks break naive snake math — don't skip them.
 */
export function pickOwner(pickNo: number, teams: number, traded: TradedPick[]): number {
  const { round, slot } = slotOnClock(pickNo, teams);
  const trade = traded.find((t) => t.round === round && t.originalSlot === slot);
  return trade ? trade.newSlot : slot;
}

/** All pick numbers owned by a slot, ascending. */
export function picksForSlot(
  mySlot: number,
  teams: number,
  rounds: number,
  traded: TradedPick[] = []
): number[] {
  const picks: number[] = [];
  for (let pickNo = 1; pickNo <= teams * rounds; pickNo++) {
    if (pickOwner(pickNo, teams, traded) === mySlot) picks.push(pickNo);
  }
  return picks;
}
