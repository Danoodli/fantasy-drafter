"use client";

// Every live signal the app polls, in one place: Sleeper trending, ESPN
// headlines, CORS-open RSS, the Bluesky wire (handles + curated lists), the
// ESPN injuries table, and the Jetstream push. Cockpit and Newsroom share it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "../types";
import { loadSources, fetchTrendingIds } from "./sources";
import { fetchBoardNews } from "./espnNews";
import type { PlayerNews } from "../etl/newsMatch";
import { fetchWireNews, fetchListNews, resolveListMembers, mergeNews, DEFAULT_WIRE_HANDLES } from "./bskyNews";
import { connectWireStream } from "./wireStream";
import { fetchEspnInjuries, type LiveStatus } from "./espnInjuries";
import { fetchRssNews } from "./rssNews";

export const LIVE_REFRESH_MS = 10 * 60 * 1000;
const BAKED_WINDOW_MS = 72 * 3_600_000;

export interface LiveSignals {
  boardNews: Map<string, PlayerNews>;
  trendingIds: Set<string>;
  liveStatus: Map<string, LiveStatus>;
  /** Last successful poll, ms epoch; null until the first completes. */
  lastRefresh: number | null;
  /** Jetstream currently connected. */
  connected: boolean;
  /** Force a poll now (draft start, manual refresh). */
  refresh: () => void;
}

type Injuries = { status: Map<string, LiveStatus>; news: Map<string, PlayerNews> };
const emptyNews = () => new Map<string, PlayerNews>();

export function useLiveSignals(board: Board, onWire?: (playerId: string, item: PlayerNews) => void): LiveSignals {
  const [boardNews, setBoardNews] = useState<Map<string, PlayerNews>>(new Map());
  const [trendingIds, setTrendingIds] = useState<Set<string>>(new Set());
  const [liveStatus, setLiveStatus] = useState<Map<string, LiveStatus>>(new Map());
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const onWireRef = useRef(onWire);
  useEffect(() => {
    onWireRef.current = onWire;
  });

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);

  useEffect(() => {
    const prefs = loadSources();
    const handles = prefs.wireHandles.length ? prefs.wireHandles : DEFAULT_WIRE_HANDLES;
    const blocked = new Set(prefs.wireBlock);
    let cancelled = false;

    const load = () => {
      if (prefs.trending)
        fetchTrendingIds()
          .then((ids) => !cancelled && setTrendingIds(ids))
          .catch(() => {
            // offline — badges just don't show
          });
      // Build-time news rides along (72h window).
      const baked = emptyNews();
      const cutoff = Date.now() - BAKED_WINDOW_MS;
      for (const p of board.players) {
        if (p.news && Date.parse(p.news.published) >= cutoff) baked.set(p.id, { ...p.news, href: null });
      }
      const safe = (p: Promise<Map<string, PlayerNews>>) => p.catch(emptyNews);
      const feeds: Promise<Map<string, PlayerNews>>[] = [
        safe(fetchBoardNews(board.players)),
        safe(fetchRssNews(board.players)),
        prefs.wire ? safe(fetchWireNews(board.players, handles)) : Promise.resolve(emptyNews()),
        prefs.wire && prefs.wireLists.length
          ? safe(fetchListNews(board.players, prefs.wireLists, blocked))
          : Promise.resolve(emptyNews()),
      ];
      const injuries: Promise<Injuries> = fetchEspnInjuries(board.players).catch(() => ({ status: new Map(), news: emptyNews() }));
      Promise.all([Promise.all(feeds), injuries]).then(([[espn, rss, wire, lists], inj]) => {
        if (cancelled) return;
        setBoardNews(mergeNews(baked, inj.news, espn, rss, wire, lists));
        if (inj.status.size) setLiveStatus(inj.status);
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
        disconnect = connectWireStream(
          board.players,
          handles,
          (matched) => {
            if (cancelled) return;
            setBoardNews((prev) => mergeNews(prev, matched));
            const [id, item] = [...matched.entries()][0];
            onWireRef.current?.(id, item);
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

  return { boardNews, trendingIds, liveStatus, lastRefresh, connected, refresh };
}
