// Structured injury-table statuses (ESPN's league-wide table) → the board's
// vocabulary, plus the reconciliation rule between the build-time snapshot
// and the live table. Pure: no clock, no I/O. The impure fetch lives in
// lib/client/espnInjuries.ts and lib/etl/fetchers.ts.
//
// Rule: a structured table is a *status*, not a headline, so it may both
// escalate and clear day-to-day designations. Season-long designations the
// ETL baked (IR/PUP/Sus/NA/COV/DNR) are stickier: only an explicit "Active"
// (an activation) or another season-long status replaces them. Keyword news
// (classifyNews) stays escalate-only on top.

import type { Board } from "../types";
import { classifyNews, liveInjuryStatus } from "./newsSignal";

export type FeedStatus = "Questionable" | "Doubtful" | "Out" | "IR" | "Sus" | "Active";

const ESPN_STATUS: Record<string, FeedStatus> = {
  active: "Active",
  questionable: "Questionable",
  doubtful: "Doubtful",
  out: "Out",
  "injured reserve": "IR",
  suspension: "Sus",
};

/** ESPN's `status` string → board vocabulary; null when ESPN uses a word we don't grade. */
export function mapEspnStatus(status: string | null | undefined): FeedStatus | null {
  if (!status) return null;
  return ESPN_STATUS[status.trim().toLowerCase()] ?? null;
}

/** Baked statuses that mean "gone for weeks or the season" (recommend.ts excludes these). */
export const SEASON_LONG: ReadonlySet<string> = new Set(["IR", "PUP", "Sus", "NA", "COV", "DNR"]);

export function reconcileStatus(baked: string | null, live: FeedStatus | null): string | null {
  if (!live) return baked;
  if (live === "Active") return null;
  if (baked && SEASON_LONG.has(baked) && !SEASON_LONG.has(live)) return baked;
  return live;
}

/**
 * Apply the live table, then hard-signal headlines, to a board. Returns the
 * same object when nothing changed so memoised consumers stay stable.
 */
export function gradeBoard(
  board: Board,
  liveStatus: ReadonlyMap<string, { status: FeedStatus }>,
  news: ReadonlyMap<string, { headline: string }>
): Board {
  if (liveStatus.size === 0 && news.size === 0) return board;
  let changed = 0;
  const players = board.players.map((p) => {
    const row = liveStatus.get(p.id);
    const tabled = row ? reconcileStatus(p.injury, row.status) : p.injury;
    const item = news.get(p.id);
    const merged = item ? liveInjuryStatus(tabled, classifyNews(item.headline)) : tabled;
    if (merged === p.injury) return p;
    changed++;
    return { ...p, injury: merged, injuryLive: true };
  });
  return changed ? { ...board, players } : board;
}
