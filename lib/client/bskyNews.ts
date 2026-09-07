"use client";

// The insider wire: Bluesky feeds from NFL reporters, polled free from the
// browser (public API, CORS *, no auth, no key). X/Twitter's API now costs
// $0.005 per tweet READ — but the same reporters (Rapoport, Field Yates) and
// news bots (Rotoworld, insider aggregators) post natively on Bluesky, so
// this is the free version of "follow all the best reporters".

import type { BoardPlayer } from "../types";
import { matchNewsToPlayers, type NewsItem, type PlayerNews } from "./espnNews";

/**
 * Default wire — every handle verified ACTIVE (≥3 posts in the last 7 days)
 * on 2026-09-07 by polling getAuthorFeed. Editable in Setup → Advanced → Data
 * sources. Confirmed dormant, deliberately excluded: Field Yates (last post
 * 2025-10), Jordan Schultz (2025-04), Matt Harmon (2026-08-11, quiet), the
 * official adamschefter.bsky.social (2024-11), FantasyPros (2026-02), Sleeper
 * (2025-03), Fantasy Footballers (2023), Sharp Football (2026-02), and the old
 * adamschefter-mirror.bluesky.bot (2025-02). Garafolo, Russini, Fowler, Breer,
 * Meirov and Dov Kleiman have no active Bluesky presence — the aggregators
 * below relay them. The name matcher only fires on board players, so beat
 * accounts add coverage without adding noise.
 */
export const DEFAULT_WIRE_HANDLES = [
  // National insiders
  "rapsheet.bsky.social", // Ian Rapoport — NFL Network / ESPN
  "tompelissero.bsky.social", // Tom Pelissero — NFL Network (low volume here)
  "profootballtalk.bsky.social", // ProFootballTalk — high-volume NFL news
  "mattlombardo.bsky.social", // Matt Lombardo — national NFL reporter
  // Aggregators (relay Schefter, Garafolo, Fowler, Breer… in real time)
  "nflnewsreposterbot.bsky.social",
  "insidenflnews.bsky.social", // NFL Daily News
  "nflnewsposter.bsky.social", // reposts beat reporters, tagged [Reporter]
  "adamscheftermirror.bsky.social", // the live Schefter mirror
  // Fantasy news bots
  "rotoworld-fb.bsky.social", // Rotoworld — per-player notes
  "rotowirenfl.bsky.social", // RotoWire NFL — per-player notes
  "matthewberry.bsky.social", // Matthew Berry
  // Beat reporters / team outlets (team in comment)
  "darrenurban.bsky.social", // ARI — Cardinals team site
  "thefalcoholic.bsky.social", // ATL — SB Nation Falcons
  "brianwacker1.bsky.social", // BAL — Baltimore Sun
  "ravensbot.bsky.social", // BAL — mirror of the team account
  "agetzenberg.bsky.social", // BUF — ESPN
  "joebuscaglia.bsky.social", // BUF — The Athletic
  "mikekayefootball.bsky.social", // CAR — ESPN
  "daringantt.bsky.social", // CAR — Panthers.com
  "kfishbain.bsky.social", // CHI — The Athletic
  "seanhammond.bsky.social", // CHI — Chicago Tribune
  "jamesrapien.bsky.social", // CIN — SI Bengals
  "spencito.bsky.social", // CLE — SI Browns
  "ceasterlingabj.bsky.social", // CLE — Akron Beacon Journal
  "kddrummondnfl.blacksky.app", // DAL — Cowboys Wire
  "codyroarknfl.bsky.social", // DEN — Mile High Sports
  "masedenver.bsky.social", // DEN — DenverSports.com
  "davebirkett.bsky.social", // DET — Detroit Free Press
  "detroitfootball.net", // DET — Detroit Football Network
  "wendellfp.bsky.social", // GB — A to Z Sports
  "byjbh.bsky.social", // GB — Jason B. Hirschhorn
  "aaronwilsonnfl.bsky.social", // HOU — KPRC 2
  "demetrius.bsky.social", // JAX — Florida Times-Union
  "mikesansone.bsky.social", // KC/CHI — The Athletic editor
  "levidamien.bsky.social", // LV — Raiders Wire
  "paulhgutierrez.bsky.social", // LV — Raiders.com
  "nateatkins.bsky.social", // LAR — The Athletic
  "stujrams.bsky.social", // LAR — Rams staff writer
  "alainpoupart.bsky.social", // MIA — SI Dolphins
  "emleiker.bsky.social", // MIN — Star Tribune
  "bengoessling.bsky.social", // MIN — Star Tribune
  "mikereiss.bsky.social", // NE — ESPN
  "andrewcallahan.bsky.social", // NE — Boston Herald
  "patriciatraina.bsky.social", // NYG — SI Giants
  "antwanstaley.bsky.social", // NYJ — NY Daily News
  "jimmykempski.bsky.social", // PHI — PhillyVoice
  "zberm.bsky.social", // PHI — The Athletic
  "mikedefabo.bsky.social", // PIT — The Athletic
  "cartercritiques.bsky.social", // PIT — Post-Gazette
  "mattmaiocco.bsky.social", // SF — NBC Sports Bay Area
  "mattbarrows.bsky.social", // SF — The Athletic
  "johnpboyle.bsky.social", // SEA — Seahawks.com
  "fieldgulls.bsky.social", // SEA — SB Nation Seahawks
  "teresamwalker.bsky.social", // TEN — AP
  // No active beat account found for IND, LAC, NO, TB, WAS (2026-09-07) — the aggregators and lists cover them.
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
  // Wire news is only interesting FRESH — 48h window.
  return matchNewsToPlayers(items, players, 48);
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

// Curated-list sources — implemented in Task 10 of the freshness plan; stubs keep the hook compiling.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function fetchListNews(_players: BoardPlayer[], _lists: string[], _blocked: Set<string>): Promise<Map<string, PlayerNews>> {
  return new Map();
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function resolveListMembers(_lists: string[], _blocked: Set<string>): Promise<Map<string, string>> {
  return new Map();
}
