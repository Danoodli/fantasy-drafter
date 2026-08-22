import type { BoardPlayer } from "../types";

/**
 * Roster-mates this player stacks with: a QB and his own pass-catchers.
 * Correlated ceilings — the engine already pays a bonus for these; the UI
 * links them visually so the build is legible at a glance.
 */
export function stackPartners(p: BoardPlayer, roster: BoardPlayer[]): BoardPlayer[] {
  return roster.filter(
    (r) =>
      r.id !== p.id &&
      r.team === p.team &&
      ((p.pos === "QB" && (r.pos === "WR" || r.pos === "TE")) ||
        (r.pos === "QB" && (p.pos === "WR" || p.pos === "TE")))
  );
}
