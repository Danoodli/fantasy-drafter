"use client";

// League-wide breaking news, matched to board players. ESPN's public news
// feed is free, CORS-open, and current — trades, suspensions, injuries show
// up here as they break. Polled alongside trending; matched headlines put a
// 📰 badge on the player everywhere he appears.

import type { BoardPlayer } from "../types";
import { matchNewsToPlayers as match, type NewsItem, type PlayerNews } from "../etl/newsMatch";

export { matchNewsToPlayers } from "../etl/newsMatch";
export type { NewsItem, PlayerNews } from "../etl/newsMatch";

interface EspnNewsItem {
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
  categories?: { type?: string; athleteId?: number }[];
}

/** Fetch ESPN's league news feed as raw items (matching happens once, in the hook). */
export async function fetchEspnNewsItems(): Promise<NewsItem[]> {
  // site.web.api serves the same feed WITH CORS headers; plain site.api doesn't.
  const res = await fetch(
    "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50"
  );
  if (!res.ok) throw new Error(`espn news: HTTP ${res.status}`);
  const json = (await res.json()) as { articles?: EspnNewsItem[] };
  const items: NewsItem[] = (json.articles ?? []).map((a) => ({
    headline: a.headline ?? "",
    description: a.description ?? "",
    published: a.published ?? "",
    href: a.links?.web?.href ?? null,
    athleteIds: (a.categories ?? [])
      .filter((c) => c.type === "athlete" && c.athleteId != null)
      .map((c) => String(c.athleteId)),
    source: "ESPN",
  }));
  return items;
}

/** Newest ESPN headline per player (kept for callers that only want the badge view). */
export async function fetchBoardNews(players: BoardPlayer[]): Promise<Map<string, PlayerNews>> {
  return match(await fetchEspnNewsItems(), players);
}
