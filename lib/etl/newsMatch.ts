// Pure news → player matching, shared by the browser feeds and the ETL.
// No "use client", no DOM, no node: import from either side.

import type { BoardPlayer } from "../types";
import { mergeName } from "./names";

export interface PlayerNews {
  headline: string;
  published: string;
  href: string | null;
  /** Outlet or account name when the feed states it (Google News <source>, "Board" for baked notes). */
  source?: string;
}

export interface NewsItem {
  headline: string;
  description: string;
  published: string;
  href: string | null;
  /** ESPN athlete ids tagged on the article — structured, beats name matching. */
  athleteIds: string[];
  /** Outlet name when the feed states it (aggregators like Google News do). */
  source?: string;
}

/** Roundups tag a dozen players; only focused articles make good badges. */
const MAX_TAGS_FOR_BADGE = 6;

/** Same note carried by two feeds (a bot re-posting RotoWire, an outlet syndicating AP): one item. */
const textKey = (i: { headline: string }) => i.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);

class Dedupe {
  private hrefs = new Set<string>();
  private texts = new Set<string>();
  /** True when the item is new; remembers it either way. */
  add(i: { href: string | null; headline: string }): boolean {
    const t = textKey(i);
    const dup = (i.href != null && this.hrefs.has(i.href)) || this.texts.has(t);
    if (i.href != null) this.hrefs.add(i.href);
    this.texts.add(t);
    return !dup;
  }
}

/**
 * Pure matcher: news items → playerId → EVERY matching item, newest first,
 * de-duplicated. Structured athlete tags win; untagged items fall back to a
 * full-name search in headline + description.
 */
export function matchAllNews(
  items: NewsItem[],
  players: BoardPlayer[],
  maxAgeHours = 72,
  now = Date.now()
): Map<string, PlayerNews[]> {
  const out = new Map<string, PlayerNews[]>();
  const cutoff = now - maxAgeHours * 3600_000;
  const fresh = items.filter((i) => {
    const t = Date.parse(i.published);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (fresh.length === 0) return out;

  const byEspnId = new Map<string, BoardPlayer>();
  for (const p of players) if (p.ids.espn) byEspnId.set(p.ids.espn, p);

  const seen = new Map<string, Dedupe>();
  const record = (p: BoardPlayer, item: NewsItem) => {
    const d = seen.get(p.id) ?? new Dedupe();
    seen.set(p.id, d);
    if (!d.add(item)) return;
    const list = out.get(p.id) ?? [];
    list.push({ headline: item.headline, published: item.published, href: item.href, source: item.source });
    out.set(p.id, list);
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

  for (const list of out.values()) list.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return out;
}

/** Newest matching item per player — the 📰 badge's view of the same data. */
export function matchNewsToPlayers(
  items: NewsItem[],
  players: BoardPlayer[],
  maxAgeHours = 72,
  now = Date.now()
): Map<string, PlayerNews> {
  const out = new Map<string, PlayerNews>();
  for (const [id, list] of matchAllNews(items, players, maxAgeHours, now)) out.set(id, list[0]);
  return out;
}

/** Concatenate per-player lists across sources: de-duplicated, newest first. */
export function mergeAllNews(...maps: ReadonlyMap<string, PlayerNews[]>[]): Map<string, PlayerNews[]> {
  const out = new Map<string, PlayerNews[]>();
  for (const map of maps) {
    for (const [id, list] of map) {
      const cur = out.get(id) ?? [];
      const d = new Dedupe();
      for (const item of cur) d.add(item);
      for (const item of list) if (d.add(item)) cur.push(item);
      out.set(id, cur);
    }
  }
  for (const list of out.values()) list.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return out;
}

/** Newest item per player from the full lists. */
export function newestPerPlayer(all: ReadonlyMap<string, PlayerNews[]>): Map<string, PlayerNews> {
  const out = new Map<string, PlayerNews>();
  for (const [id, list] of all) if (list[0]) out.set(id, list[0]);
  return out;
}
