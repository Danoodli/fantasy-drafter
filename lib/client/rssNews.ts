"use client";

// Headline feeds that answer browser requests with `Access-Control-Allow-Origin: *`
// (verified 2026-09-07). Yahoo and ProFootballTalk do not — they are baked in by the ETL.
import type { BoardPlayer } from "../types";
import { parseRss } from "../etl/rss";
import { matchNewsToPlayers, type NewsItem, type PlayerNews } from "../etl/newsMatch";

export const BROWSER_RSS_FEEDS: { url: string; source: string }[] = [
  { url: "https://www.cbssports.com/rss/headlines/nfl/", source: "CBS Sports" },
  { url: "https://www.espn.com/espn/rss/nfl/news", source: "ESPN" },
  { url: "https://www.rotowire.com/rss/news.php?sport=NFL", source: "RotoWire" },
  { url: "https://www.nytimes.com/athletic/rss/nfl/", source: "The Athletic" },
];

export async function fetchRssItems(feeds = BROWSER_RSS_FEEDS): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  await Promise.all(
    feeds.map(async ({ url, source }) => {
      try {
        const res = await fetch(url);
        if (res.ok) items.push(...parseRss(await res.text()).map((i) => ({ ...i, source: i.source ?? source })));
      } catch {
        // one dead feed shouldn't kill the rest
      }
    })
  );
  return items;
}

export async function fetchRssNews(players: BoardPlayer[], feeds = BROWSER_RSS_FEEDS): Promise<Map<string, PlayerNews>> {
  return matchNewsToPlayers(await fetchRssItems(feeds), players, 72);
}
