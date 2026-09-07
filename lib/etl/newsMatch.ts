// Pure news → player matching, shared by the browser feeds and the ETL.
// No "use client", no DOM, no node: import from either side.

import type { BoardPlayer } from "../types";
import { mergeName } from "./names";

export interface PlayerNews {
  headline: string;
  published: string;
  href: string | null;
}

export interface NewsItem {
  headline: string;
  description: string;
  published: string;
  href: string | null;
  /** ESPN athlete ids tagged on the article — structured, beats name matching. */
  athleteIds: string[];
}

/** Roundups tag a dozen players; only focused articles make good badges. */
const MAX_TAGS_FOR_BADGE = 6;

/** Pure matcher, unit-testable: news items → playerId → most recent item. */
export function matchNewsToPlayers(
  items: NewsItem[],
  players: BoardPlayer[],
  maxAgeHours = 72,
  now = Date.now()
): Map<string, PlayerNews> {
  const out = new Map<string, PlayerNews>();
  const cutoff = now - maxAgeHours * 3600_000;
  const fresh = items.filter((i) => {
    const t = Date.parse(i.published);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (fresh.length === 0) return out;

  const byEspnId = new Map<string, BoardPlayer>();
  for (const p of players) if (p.ids.espn) byEspnId.set(p.ids.espn, p);

  const record = (p: BoardPlayer, item: NewsItem) => {
    const existing = out.get(p.id);
    if (!existing || Date.parse(item.published) > Date.parse(existing.published)) {
      out.set(p.id, { headline: item.headline, published: item.published, href: item.href });
    }
  };

  // 1. Structured athlete tags (focused articles only)
  for (const item of fresh) {
    if (item.athleteIds.length === 0 || item.athleteIds.length > MAX_TAGS_FOR_BADGE) continue;
    for (const aid of item.athleteIds) {
      const p = byEspnId.get(aid);
      if (p) record(p, item);
    }
  }

  // 2. Full-name fallback for untagged articles
  const untagged = fresh.filter((i) => i.athleteIds.length === 0);
  if (untagged.length > 0) {
    const haystacks = untagged.map((i) => ({
      item: i,
      text: ` ${mergeName(i.headline)} ${mergeName(i.description)} `,
    }));
    for (const p of players) {
      const needle = ` ${mergeName(p.name)} `;
      if (needle.trim().split(" ").length < 2) continue; // never match single-token names
      for (const h of haystacks) {
        if (h.text.includes(needle)) record(p, h.item);
      }
    }
  }
  return out;
}
