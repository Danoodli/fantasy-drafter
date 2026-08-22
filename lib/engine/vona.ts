// VONA: value over next available. For each candidate, how much better is he
// than what I can expect at his position at my NEXT pick? This is where
// tier-cliff urgency comes from.

import type { BoardPlayer, Position } from "../types";
import { survivalProb } from "./survival";

/**
 * Expected points of the best available player at a position at a future
 * pick: weight each remaining player (sorted by points desc) by
 * P(he survived) × P(everyone better was taken).
 */
export function expectedBestAtPick(
  remainingAtPos: BoardPlayer[], // available players at one position
  pickNo: number,
  drift: Partial<Record<Position, number>> = {}
): number {
  const sorted = [...remainingAtPos].sort((a, b) => b.projPoints - a.projPoints);
  let probAllBetterGone = 1;
  let expected = 0;
  let covered = 0;
  for (const p of sorted) {
    const s = survivalProb(p, pickNo, drift);
    const probBest = s * probAllBetterGone;
    expected += probBest * p.projPoints;
    covered += probBest;
    probAllBetterGone *= 1 - s;
    if (probAllBetterGone < 1e-4) break;
  }
  // Tail mass: if there's leftover probability (everyone gone), the best
  // available is roughly the worst listed player.
  if (covered < 1 && sorted.length > 0) {
    expected += (1 - covered) * sorted[sorted.length - 1].projPoints;
  }
  return expected;
}

/** VONA for one candidate: his points minus expected best at his position at my next pick. */
export function vona(
  candidate: BoardPlayer,
  available: BoardPlayer[],
  nextPick: number,
  drift: Partial<Record<Position, number>> = {}
): number {
  const peers = available.filter((p) => p.pos === candidate.pos && p.id !== candidate.id);
  if (peers.length === 0) return candidate.projPoints * 0.25; // last one standing
  return candidate.projPoints - expectedBestAtPick(peers, nextPick, drift);
}
