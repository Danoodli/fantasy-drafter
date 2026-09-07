"use client";

// The insider wire: Bluesky feeds from NFL reporters, polled free from the
// browser (public API, CORS *, no auth, no key). X/Twitter's API now costs
// $0.005 per tweet READ — but the same reporters (Rapoport, Field Yates) and
// news bots (Rotoworld, insider aggregators) post natively on Bluesky, so
// this is the free version of "follow all the best reporters".

import type { BoardPlayer } from "../types";
import { matchNewsToPlayers, type NewsItem, type PlayerNews } from "../etl/newsMatch";

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

export interface BskyFeedItem {
  post?: {
    uri?: string;
    author?: { handle?: string };
    record?: { text?: string; createdAt?: string; reply?: unknown };
  };
  /** Present on reposts (app.bsky.feed.defs#reasonRepost). */
  reason?: unknown;
}

const API = "https://public.api.bsky.app/xrpc/";

function postUrl(uri: string | undefined, handle: string | undefined): string | null {
  const rkey = uri?.split("/").pop();
  return rkey && handle ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
}

/** Pure: a Bluesky feed page → news items (posts carry no tags; the name matcher does the rest). */
export function feedToNews(
  feed: BskyFeedItem[],
  opts: { fallbackHandle?: string; blocked?: ReadonlySet<string>; skipReposts?: boolean; skipReplies?: boolean }
): NewsItem[] {
  const out: NewsItem[] = [];
  for (const f of feed) {
    if (opts.skipReposts && f.reason) continue;
    if (opts.skipReplies && f.post?.record?.reply) continue;
    const handle = f.post?.author?.handle ?? opts.fallbackHandle;
    if (handle && opts.blocked?.has(handle)) continue;
    const text = f.post?.record?.text ?? "";
    if (!text) continue;
    out.push({
      headline: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      description: text,
      published: f.post?.record?.createdAt ?? "",
      href: postUrl(f.post?.uri, handle),
      athleteIds: [],
      source: handle ? `@${handle}` : "Bluesky",
    });
  }
  return out;
}

/** Wire posts are only interesting FRESH — 48 h window. */
export const WIRE_WINDOW_HOURS = 48;

/** Pull each handle's recent posts as raw items. */
export async function fetchWireItems(handles: string[], blocked: ReadonlySet<string> = new Set()): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  await Promise.all(
    handles.map(async (handle) => {
      if (blocked.has(handle)) return;
      try {
        const res = await fetch(
          `${API}app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=25&filter=posts_no_replies`
        );
        if (!res.ok) return;
        const json = (await res.json()) as { feed?: BskyFeedItem[] };
        items.push(...feedToNews(json.feed ?? [], { fallbackHandle: handle, blocked }));
      } catch {
        // one dead handle shouldn't kill the wire
      }
    })
  );
  return items;
}

/** Newest wire post per player (badge view). */
export async function fetchWireNews(
  players: BoardPlayer[],
  handles: string[],
  blocked: ReadonlySet<string> = new Set()
): Promise<Map<string, PlayerNews>> {
  return matchNewsToPlayers(await fetchWireItems(handles, blocked), players, WIRE_WINDOW_HOURS);
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

// ---------------------------------------------------------------------------
// Curated lists: one getListFeed request backfills a whole roster of reporters;
// the members' DIDs join the Jetstream filter (cap 10,000). Both verified on
// 2026-09-07 to answer without auth.

export const DEFAULT_WIRE_LISTS = [
  "at://did:plc:pgxejfwpltr73b6amkirahwd/app.bsky.graph.list/3lasn45b4da2l", // "NFL beat writers and reporters" (111 members)
  "at://did:plc:zlyvxtoj3bwk4gyhvfqd3jdn/app.bsky.graph.list/3laulwjvwky2r", // "NFL News and Analysts" (139 members)
];

/** Accepts an AT-URI or a bsky.app list URL. */
export function parseListRef(ref: string): { uri: string } | { handle: string; rkey: string } | null {
  const s = ref.trim();
  if (/^at:\/\/did:[a-z0-9:]+\/app\.bsky\.graph\.list\/[a-z0-9]+$/i.test(s)) return { uri: s };
  const m = s.match(/^https?:\/\/bsky\.app\/profile\/([^/]+)\/lists\/([a-z0-9]+)\/?$/i);
  return m ? { handle: m[1], rkey: m[2] } : null;
}

async function listUri(ref: string): Promise<string | null> {
  const parsed = parseListRef(ref);
  if (!parsed) return null;
  if ("uri" in parsed) return parsed.uri;
  if (parsed.handle.startsWith("did:")) return `at://${parsed.handle}/app.bsky.graph.list/${parsed.rkey}`;
  const res = await fetch(`${API}com.atproto.identity.resolveHandle?handle=${encodeURIComponent(parsed.handle)}`);
  if (!res.ok) return null;
  const { did } = (await res.json()) as { did?: string };
  return did ? `at://${did}/app.bsky.graph.list/${parsed.rkey}` : null;
}

/** One request per list backfills every member's recent posts, as raw items. */
export async function fetchListItems(lists: string[], blocked: ReadonlySet<string>): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  await Promise.all(
    lists.map(async (ref) => {
      try {
        const uri = await listUri(ref);
        if (!uri) return;
        const res = await fetch(`${API}app.bsky.feed.getListFeed?list=${encodeURIComponent(uri)}&limit=100`);
        if (!res.ok) return;
        const json = (await res.json()) as { feed?: BskyFeedItem[] };
        items.push(...feedToNews(json.feed ?? [], { blocked, skipReposts: true, skipReplies: true }));
      } catch {
        // a dead list shouldn't kill the wire
      }
    })
  );
  return items;
}

/** Newest list post per player (badge view). */
export async function fetchListNews(
  players: BoardPlayer[],
  lists: string[],
  blocked: ReadonlySet<string>
): Promise<Map<string, PlayerNews>> {
  return matchNewsToPlayers(await fetchListItems(lists, blocked), players, WIRE_WINDOW_HOURS);
}

/** DID → handle for every list member, for the Jetstream filter. */
export async function resolveListMembers(
  lists: string[],
  blocked: ReadonlySet<string>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    lists.map(async (ref) => {
      try {
        const uri = await listUri(ref);
        if (!uri) return;
        let cursor: string | undefined;
        do {
          const res = await fetch(
            `${API}app.bsky.graph.getList?list=${encodeURIComponent(uri)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
          );
          if (!res.ok) return;
          const json = (await res.json()) as {
            cursor?: string;
            items?: { subject?: { did?: string; handle?: string } }[];
          };
          for (const it of json.items ?? []) {
            const { did, handle } = it.subject ?? {};
            if (did && handle && !blocked.has(handle)) out.set(did, handle);
          }
          cursor = json.cursor;
        } while (cursor && out.size < 9_000);
      } catch {
        // skip
      }
    })
  );
  return out;
}
