"use client";

// ESPN's league-wide injuries table: every player with a current designation
// or a fresh note, with a structured status. Free, keyless, CORS-open
// (verified 2026-09-07), 10-second cache upstream. This is the live source
// for Questionable/Doubtful/Out/IR/Suspension between board rebuilds.

import type { BoardPlayer } from "../types";
import { mapEspnStatus, type FeedStatus } from "../engine/injuryFeed";
import type { PlayerNews } from "../etl/newsMatch";

export const ESPN_INJURIES_URL =
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/injuries";

export interface EspnInjuryRow {
  status?: string;
  date?: string;
  shortComment?: string;
  athlete?: { displayName?: string; links?: { href?: string }[] };
}
export interface EspnInjuriesJson {
  injuries?: { id?: string; displayName?: string; injuries?: EspnInjuryRow[] }[];
}
export interface LiveStatus {
  status: FeedStatus;
  /** ESPN's row timestamp, e.g. "2026-09-04T21:36Z". */
  date: string;
  note: string | null;
}

export function espnIdFromLinks(links: { href?: string }[] | undefined): string | null {
  for (const l of links ?? []) {
    const m = l.href?.match(/\/id\/(\d+)(?:\/|$)/);
    if (m) return m[1];
  }
  return null;
}

/** Pure: table → playerId → newest status; notes inside the window become news. */
export function parseEspnInjuries(
  json: EspnInjuriesJson,
  players: BoardPlayer[],
  maxAgeHours = 72,
  now = Date.now()
): { status: Map<string, LiveStatus>; news: Map<string, PlayerNews> } {
  const byEspn = new Map<string, BoardPlayer>();
  for (const p of players) if (p.ids.espn) byEspn.set(p.ids.espn, p);
  const status = new Map<string, LiveStatus>();
  const news = new Map<string, PlayerNews>();
  const cutoff = now - maxAgeHours * 3_600_000;
  for (const team of json.injuries ?? []) {
    for (const row of team.injuries ?? []) {
      const id = espnIdFromLinks(row.athlete?.links);
      const p = id ? byEspn.get(id) : undefined;
      if (!p) continue;
      const s = mapEspnStatus(row.status);
      if (!s) continue;
      const date = row.date ?? "";
      const t = Date.parse(date);
      const prev = status.get(p.id);
      if (!prev || (Number.isFinite(t) && t > Date.parse(prev.date))) {
        status.set(p.id, { status: s, date, note: row.shortComment ?? null });
      }
      if (row.shortComment && Number.isFinite(t) && t >= cutoff) {
        const e = news.get(p.id);
        if (!e || t > Date.parse(e.published)) news.set(p.id, { headline: row.shortComment, published: date, href: null });
      }
    }
  }
  return { status, news };
}

export async function fetchEspnInjuries(players: BoardPlayer[]) {
  const res = await fetch(ESPN_INJURIES_URL);
  if (!res.ok) throw new Error(`espn injuries: HTTP ${res.status}`);
  return parseEspnInjuries((await res.json()) as EspnInjuriesJson, players);
}
