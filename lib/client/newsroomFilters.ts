"use client";

// Newsroom view state: filtering, sorting and Top Stories selection over the
// ranked feed. Pure functions (unit-tested) plus a thin localStorage shim so
// a hidden source stays hidden across visits.

import type { Position } from "../types";
import type { FeedItem, NewsKind } from "../engine/newsImportance";

export type FeedSort = "relevance" | "newest" | "oldest" | "adp";
export const SORT_LABEL: Record<FeedSort, string> = {
  relevance: "Relevance",
  newest: "Newest",
  oldest: "Oldest",
  adp: "ADP",
};

export interface NewsroomFilters {
  pos: Position | "ALL";
  /** Empty = every team. */
  teams: string[];
  /** Empty = every kind. */
  kinds: NewsKind[];
  /** `only`: show just these sources; `hide`: everything but these. */
  sourceMode: "only" | "hide";
  sources: string[];
  sort: FeedSort;
}

export const DEFAULT_FILTERS: NewsroomFilters = {
  pos: "ALL",
  teams: [],
  kinds: [],
  sourceMode: "hide",
  sources: [],
  sort: "relevance",
};

export function applyFilters(items: FeedItem[], f: NewsroomFilters, query: string): FeedItem[] {
  const q = query.trim().toLowerCase();
  const teams = new Set(f.teams);
  const kinds = new Set(f.kinds);
  const sources = new Set(f.sources);
  return items.filter((i) => {
    if (f.pos !== "ALL" && i.pos !== f.pos) return false;
    if (teams.size && !teams.has(i.team)) return false;
    if (kinds.size && !kinds.has(i.kind)) return false;
    if (sources.size || f.sourceMode === "only") {
      const listed = sources.has(i.source);
      if (f.sourceMode === "only" ? !listed : listed) return false;
    }
    if (q && !i.name.toLowerCase().includes(q) && !i.headline.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function sortFeed(items: FeedItem[], sort: FeedSort): FeedItem[] {
  const t = (i: FeedItem) => Date.parse(i.published);
  const out = [...items];
  switch (sort) {
    case "newest":
      return out.sort((a, b) => t(b) - t(a));
    case "oldest":
      return out.sort((a, b) => t(a) - t(b));
    case "adp":
      return out.sort((a, b) => a.adp - b.adp || b.importance - a.importance);
    default:
      return out.sort((a, b) => b.importance - a.importance || t(b) - t(a));
  }
}

/** The flashes: most important items from the last 48 h, one per player, at least Questionable-grade. Falls back to the best of what's there. */
export function pickTopStories(items: FeedItem[], n: number, now: number, maxAgeHours = 48): FeedItem[] {
  const cutoff = now - maxAgeHours * 3_600_000;
  const ranked = sortFeed(items, "relevance");
  const pick = (pred: (i: FeedItem) => boolean) => {
    const seen = new Set<string>();
    const out: FeedItem[] = [];
    for (const i of ranked) {
      if (!pred(i) || seen.has(i.playerId)) continue;
      seen.add(i.playerId);
      out.push(i);
      if (out.length === n) break;
    }
    return out;
  };
  const serious = pick((i) => i.severity >= 0.35 && Date.parse(i.published) >= cutoff);
  return serious.length ? serious : pick(() => true);
}

export function countBy(items: FeedItem[], key: (i: FeedItem) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

const KEY = "draft-cockpit-newsroom-v1";
const SORTS = new Set<string>(["relevance", "newest", "oldest", "adp"]);

export function parseFilters(raw: string | null): NewsroomFilters {
  if (!raw) return DEFAULT_FILTERS;
  try {
    const j = JSON.parse(raw) as Partial<NewsroomFilters>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
      pos: typeof j.pos === "string" ? (j.pos as NewsroomFilters["pos"]) : "ALL",
      teams: strs(j.teams),
      kinds: strs(j.kinds) as NewsKind[],
      sourceMode: j.sourceMode === "only" ? "only" : "hide",
      sources: strs(j.sources),
      sort: typeof j.sort === "string" && SORTS.has(j.sort) ? (j.sort as FeedSort) : "relevance",
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function loadFilters(): NewsroomFilters {
  try {
    return parseFilters(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(f: NewsroomFilters) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    // private mode — filters just don't persist
  }
}

export function activeFilterCount(f: NewsroomFilters): number {
  return (f.pos !== "ALL" ? 1 : 0) + (f.teams.length ? 1 : 0) + (f.kinds.length ? 1 : 0) + (f.sources.length ? 1 : 0);
}
