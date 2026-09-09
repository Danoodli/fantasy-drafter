// Loads one week's outlooks. The board is a static JSON file per scoring
// format, so this is a plain fetch with no server on the hot path — the same
// shape app/page.tsx uses for board-{format}.json.
import type { ScoringFormat, WeekBoard } from "../types";
import type { WeekOutlook } from "../engine/weekly/outlook";

export function weekBoardUrl(season: number, week: number, format: ScoringFormat): string {
  return `/data/week-${season}-${week}-${format}.json`;
}

export async function fetchWeekBoard(
  season: number,
  week: number,
  format: ScoringFormat
): Promise<WeekBoard> {
  // no-cache, not no-store: the weekly lane rebuilds mid-week and the browser
  // must not serve a stale copy. public/sw.js is already network-first here.
  const res = await fetch(weekBoardUrl(season, week, format), { cache: "no-cache" });
  if (!res.ok) throw new Error(`week board ${season}/${week}/${format}: HTTP ${res.status}`);
  return (await res.json()) as WeekBoard;
}

export function indexOutlooks(board: WeekBoard): Map<string, WeekOutlook> {
  return new Map(board.outlooks.map((o) => [o.playerId, o] as const));
}

/** Weeks are Tuesday-to-Tuesday, so a Tuesday season start makes this a divide. */
export function currentNflWeek(now: Date, seasonStart: Date): number {
  const days = (now.getTime() - seasonStart.getTime()) / 86_400_000;
  return Math.min(18, Math.max(1, Math.floor(days / 7) + 1));
}
