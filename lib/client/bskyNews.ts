"use client";

// The insider wire: Bluesky feeds from NFL reporters, polled free from the
// browser (public API, CORS *, no auth, no key). X/Twitter's API now costs
// $0.005 per tweet READ — but the same reporters (Rapoport, Field Yates) and
// news bots (Rotoworld, insider aggregators) post natively on Bluesky, so
// this is the free version of "follow all the best reporters".

import type { BoardPlayer } from "../types";
import { matchNewsToPlayers, type NewsItem, type PlayerNews } from "./espnNews";

/**
 * Default wire — every handle verified ACTIVE (posted within days) on
 * 2026-08-22. Editable in Setup → Advanced → Data sources: add handles or
 * delete lines to drop defaults. Notable dormant accounts deliberately
 * excluded: Field Yates (324d silent), Jordan Schultz (498d), the Schefter
 * mirror (dead) — Schefter/Garafolo news arrives via the aggregator bot.
 */
export const DEFAULT_WIRE_HANDLES = [
  "rapsheet.bsky.social", // Ian Rapoport — NFL Network national insider
  "tompelissero.bsky.social", // Tom Pelissero — NFL Network insider
  "profootballtalk.bsky.social", // ProFootballTalk — high-volume breaking NFL news
  "matthewberry.bsky.social", // Matthew Berry — fantasy news + analysis
  "rotoworld-fb.bsky.social", // Rotoworld — per-player fantasy news bot
  "nflnewsreposterbot.bsky.social", // aggregator reposting national insiders (Schefter et al.)
];

interface BskyFeedItem {
  post?: {
    uri?: string;
    author?: { handle?: string };
    record?: { text?: string; createdAt?: string };
  };
}

function postUrl(uri: string | undefined, handle: string | undefined): string | null {
  const rkey = uri?.split("/").pop();
  return rkey && handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
}

/** Pull each handle's recent posts and match player names against the board. */
export async function fetchWireNews(
  players: BoardPlayer[],
  handles: string[]
): Promise<Map<string, PlayerNews>> {
  const items: NewsItem[] = [];
  await Promise.all(
    handles.map(async (handle) => {
      try {
        const res = await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=25&filter=posts_no_replies`
        );
        if (!res.ok) return;
        const json = (await res.json()) as { feed?: BskyFeedItem[] };
        for (const f of json.feed ?? []) {
          const text = f.post?.record?.text ?? "";
          if (!text) continue;
          items.push({
            headline: text.length > 140 ? `${text.slice(0, 140)}…` : text,
            description: text,
            published: f.post?.record?.createdAt ?? "",
            href: postUrl(f.post?.uri, f.post?.author?.handle ?? handle),
            athleteIds: [], // bsky posts carry no tags — the name matcher handles it
          });
        }
      } catch {
        // one dead handle shouldn't kill the wire
      }
    })
  );
  // Wire news is only interesting FRESH — 36h window, tighter than articles.
  return matchNewsToPlayers(items, players, 36);
}

/** Newest-wins merge of news maps (wire beats articles on recency, not rank). */
export function mergeNews(
  ...maps: Map<string, PlayerNews>[]
): Map<string, PlayerNews> {
  const out = new Map<string, PlayerNews>();
  for (const map of maps) {
    for (const [id, item] of map) {
      const existing = out.get(id);
      if (!existing || Date.parse(item.published) > Date.parse(existing.published)) {
        out.set(id, item);
      }
    }
  }
  return out;
}
