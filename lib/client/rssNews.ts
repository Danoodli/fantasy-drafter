"use client";

// Headline feeds that answer browser requests with `Access-Control-Allow-Origin: *`
// (verified 2026-09-07). Yahoo and ProFootballTalk do not — they are baked in by the ETL.
import type { BoardPlayer } from "../types";
import { parseRss } from "../etl/rss";
import { matchNewsToPlayers, type NewsItem, type PlayerNews } from "../etl/newsMatch";

export const BROWSER_RSS_FEEDS = [
  "https://www.cbssports.com/rss/headlines/nfl/",
  "https://www.espn.com/espn/rss/nfl/news",
  "https://www.rotowire.com/rss/news.php?sport=NFL",
];

export async function fetchRssNews(players: BoardPlayer[], feeds = BROWSER_RSS_FEEDS): Promise<Map<string, PlayerNews>> {
  const items: NewsItem[] = [];
  await Promise.all(
    feeds.map(async (url) => {
      try {
        const res = await fetch(url);
        if (res.ok) items.push(...parseRss(await res.text()));
      } catch {
        // one dead feed shouldn't kill the rest
      }
    })
  );
  return matchNewsToPlayers(items, players, 72);
}
