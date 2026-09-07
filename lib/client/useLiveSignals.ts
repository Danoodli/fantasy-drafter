"use client";

// Every live signal the app polls, in one place: Sleeper trending, ESPN
// headlines, RSS outlets, the Bluesky wire (handles + curated lists), the
// ESPN injuries table, and the Jetstream push. Items are matched to players
// ONCE here; `allNews` keeps every item per player (the Newsroom), `boardNews`
// is the newest per player (badges and cards). Cockpit and Newsroom share it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board } from "../types";
import { loadSources, fetchTrendingIds } from "./sources";
import { fetchEspnNewsItems } from "./espnNews";
import { matchAllNews, mergeAllNews, newestPerPlayer, type NewsItem, type PlayerNews } from "../etl/newsMatch";
import { fetchWireItems, fetchListItems, resolveListMembers, DEFAULT_WIRE_HANDLES, WIRE_WINDOW_HOURS } from "./bskyNews";
import { connectWireStream } from "./wireStream";
import { fetchEspnInjuries, type LiveStatus } from "./espnInjuries";
import { fetchRssItems } from "./rssNews";

export const LIVE_REFRESH_MS = 10 * 60 * 1000;
const ARTICLE_WINDOW_HOURS = 72;

export interface LiveSignals {
  /** Every matched item per player, newest first. */
  allNews: Map<string, PlayerNews[]>;
  /** Newest item per player — the 📰 badge's view. */
  boardNews: Map<string, PlayerNews>;
  trendingIds: Set<string>;
  liveStatus: Map<string, LiveStatus>;
  /** Last successful poll, ms epoch; null until the first completes. */
  lastRefresh: number | null;
  /** Jetstream currently connected. */
  connected: boolean;
  /** How wide the wire is: polled handles and list members on the live filter. */
  wire: { handles: number; listMembers: number };
  /** Force a poll now (draft start, manual refresh). */
  refresh: () => void;
}

type Injuries = { status: Map<string, LiveStatus>; news: Map<string, PlayerNews> };
const noItems = () => [] as NewsItem[];

export function useLiveSignals(board: Board, onWire?: (playerId: string, item: PlayerNews) => void): LiveSignals {
  const [allNews, setAllNews] = useState<Map<string, PlayerNews[]>>(new Map());
  const [trendingIds, setTrendingIds] = useState<Set<string>>(new Set());
  const [liveStatus, setLiveStatus] = useState<Map<string, LiveStatus>>(new Map());
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [wire, setWire] = useState({ handles: 0, listMembers: 0 });
  const [epoch, setEpoch] = useState(0);
  const onWireRef = useRef(onWire);
  useEffect(() => {
    onWireRef.current = onWire;
  });

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);

  useEffect(() => {
    const prefs = loadSources();
    const blocked = new Set(prefs.wireBlock);
    const handles = (prefs.wireHandles.length ? prefs.wireHandles : DEFAULT_WIRE_HANDLES).filter((h) => !blocked.has(h));
    let cancelled = false;
    let listMembers = 0; // filled once the curated lists resolve; reported with the next poll

    const load = () => {
      if (prefs.trending)
        fetchTrendingIds()
          .then((ids) => !cancelled && setTrendingIds(ids))
          .catch(() => {
            // offline — badges just don't show
          });
      // Build-time notes ride along (72h window).
      const baked = new Map<string, PlayerNews[]>();
      const cutoff = Date.now() - ARTICLE_WINDOW_HOURS * 3_600_000;
      for (const p of board.players) {
        if (p.news && Date.parse(p.news.published) >= cutoff)
          baked.set(p.id, [{ headline: p.news.headline, published: p.news.published, href: p.news.href ?? null, source: p.news.source ?? "Board" }]);
      }
      const safe = (p: Promise<NewsItem[]>) => p.catch(noItems);
      const injuries: Promise<Injuries> = fetchEspnInjuries(board.players).catch(() => ({ status: new Map(), news: new Map() }));
      Promise.all([
        safe(fetchEspnNewsItems()),
        safe(fetchRssItems()),
        prefs.wire ? safe(fetchWireItems(handles, blocked)) : Promise.resolve(noItems()),
        prefs.wire && prefs.wireLists.length ? safe(fetchListItems(prefs.wireLists, blocked)) : Promise.resolve(noItems()),
        injuries,
      ]).then(([espn, rss, posts, listPosts, inj]) => {
        if (cancelled) return;
        const articles = matchAllNews([...espn, ...rss], board.players, ARTICLE_WINDOW_HOURS);
        const wirePosts = matchAllNews([...posts, ...listPosts], board.players, WIRE_WINDOW_HOURS);
        const notes = new Map<string, PlayerNews[]>();
        for (const [id, n] of inj.news) notes.set(id, [{ ...n, source: "ESPN injury note" }]);
        setAllNews(mergeAllNews(baked, notes, articles, wirePosts));
        if (inj.status.size) setLiveStatus(inj.status);
        setWire({ handles: prefs.wire ? handles.length : 0, listMembers });
        setLastRefresh(Date.now());
      });
    };
    load();
    const timer = setInterval(load, LIVE_REFRESH_MS);

    // LIVE push on top of the poll: Jetstream delivers reporter posts the
    // second they publish — no gap right before your pick.
    let disconnect = () => {};
    if (prefs.wire) {
      const start = (extra: Map<string, string>) => {
        if (cancelled) return;
        listMembers = extra.size;
        // Async by construction (resolves after the effect ran), so the ticker updates without waiting for the next poll.
        Promise.resolve().then(() => !cancelled && setWire({ handles: handles.length, listMembers }));
        disconnect = connectWireStream(
          handles,
          (item) => {
            if (cancelled) return;
            const matched = matchAllNews([item], board.players, WIRE_WINDOW_HOURS);
            if (matched.size === 0) return;
            setAllNews((prev) => mergeAllNews(prev, matched));
            const [id, list] = [...matched.entries()][0];
            onWireRef.current?.(id, list[0]);
          },
          { extraDids: extra, onStatus: (c) => !cancelled && setConnected(c) }
        );
      };
      if (prefs.wireLists.length) {
        resolveListMembers(prefs.wireLists, blocked).then(start).catch(() => start(new Map()));
      } else {
        start(new Map());
      }
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      disconnect();
    };
  }, [board, epoch]);

  const boardNews = useMemo(() => newestPerPlayer(allNews), [allNews]);
  return { allNews, boardNews, trendingIds, liveStatus, lastRefresh, connected, wire, refresh };
}
