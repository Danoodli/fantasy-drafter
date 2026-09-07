"use client";

// The Newsroom: every player and every update, outside a draft. A pure
// consumer of the same plumbing the Cockpit uses — useLiveSignals for the
// feeds, gradeBoard for statuses, buildFeed for the ranking — so the two
// screens can never disagree about a player. View state (filters, sort,
// top-story selection) lives in lib/client/newsroomFilters.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Board, BoardPlayer, LeagueConfig } from "../lib/types";
import { DEFAULT_CONFIG, loadConfig } from "../lib/client/config";
import { useLiveSignals } from "../lib/client/useLiveSignals";
import { useNow } from "../lib/client/useNow";
import { formatAge } from "../lib/client/boardAge";
import { POS_COLOR, POS_ORDER } from "../lib/client/pos";
import { gradeBoard } from "../lib/engine/injuryFeed";
import { buildFeed, groupStories, type FeedItem } from "../lib/engine/newsImportance";
import {
  applyFilters, sortStories, pickTopStories, countBy, loadFilters, saveFilters, DEFAULT_FILTERS, SORT_LABEL,
  type NewsroomFilters, type FeedSort,
} from "../lib/client/newsroomFilters";
import InjuryBadge from "./InjuryBadge";
import PlayerModal from "./PlayerModal";
import TopStories from "./newsroom/TopStories";
import StoryCard from "./newsroom/StoryCard";
import FilterMenu from "./newsroom/FilterMenu";
import Headshot from "./newsroom/Headshot";
import { ago } from "./newsroom/feedUi";

const TABLE_PAGE = 100;
const TOP_STORIES = 5;

export default function Newsroom() {
  const [board, setBoard] = useState<Board | null>(null);
  const [config, setConfig] = useState<LeagueConfig>(DEFAULT_CONFIG);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadConfig();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration
    if (saved) setConfig(saved);
    let cancelled = false;
    fetch(`/data/board-${saved?.scoring ?? "ppr"}.json`, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Board>;
      })
      .then((b) => !cancelled && setBoard(b))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="mx-auto max-w-xl px-6 py-24">
        <h1 className="font-display text-3xl font-bold uppercase">No board</h1>
        <p className="mt-3 text-ink-dim">The board file could not be loaded ({error}). Run pnpm build:board, then reload.</p>
      </main>
    );
  }
  if (!board) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="font-mono text-sm text-ink-dim">Opening the wire…</p>
      </main>
    );
  }
  return <NewsroomInner board={board} config={config} />;
}

function NewsroomInner({ board, config }: { board: Board; config: LeagueConfig }) {
  const live = useLiveSignals(board);
  const now = useNow(60_000);
  const graded = useMemo(() => gradeBoard(board, live.liveStatus, live.boardNews), [board, live.liveStatus, live.boardNews]);
  const feed = useMemo(
    () => (now == null ? [] : buildFeed(board, live.allNews, live.liveStatus, now)),
    [board, live.allNews, live.liveStatus, now]
  );
  const byId = useMemo(() => new Map(graded.players.map((p) => [p.id, p])), [graded]);

  // View state, persisted on-device.
  const [filters, setFilters] = useState<NewsroomFilters>(DEFAULT_FILTERS);
  const [query, setQuery] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration
    setFilters(loadFilters());
  }, []);
  const updateFilters = (f: NewsroomFilters) => {
    setFilters(f);
    saveFilters(f);
  };

  // Never reorder under the cursor: once the user scrolls down, the list is
  // frozen and new items wait behind a pill until they come back up.
  const [frozen, setFrozen] = useState<FeedItem[] | null>(null);
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  });
  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > 320) setFrozen((f) => f ?? feedRef.current);
      else setFrozen(null);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const pending = useMemo(() => {
    if (!frozen) return 0;
    const known = new Set(frozen.map((f) => f.id));
    return feed.filter((f) => !known.has(f.id)).length;
  }, [frozen, feed]);

  const filtered = useMemo(() => applyFilters(frozen ?? feed, filters, query), [frozen, feed, filters, query]);
  const stories = useMemo(() => sortStories(groupStories(filtered), filters.sort), [filtered, filters.sort]);
  const topStories = useMemo(
    () => (now == null ? [] : pickTopStories(applyFilters(feed, { ...filters, pos: "ALL", kinds: [] }, ""), TOP_STORIES, now)),
    [feed, filters, now]
  );
  const counts = useMemo(
    () => ({ kinds: countBy(feed, (i) => i.kind), teams: countBy(feed, (i) => i.team), sources: countBy(feed, (i) => i.source) }),
    [feed]
  );
  const teams = useMemo(() => [...new Set(graded.players.map((p) => p.team).filter(Boolean))].sort(), [graded]);
  const sources = useMemo(() => Object.entries(counts.sources).sort((a, b) => b[1] - a[1]).map(([s]) => s), [counts]);

  // Player table.
  const [sortKey, setSortKey] = useState<"adp" | "proj" | "name">("adp");
  const [limit, setLimit] = useState(TABLE_PAGE);
  const [modal, setModal] = useState<BoardPlayer | null>(null);
  const q = query.trim().toLowerCase();
  const tableRows = useMemo(() => {
    const teamSet = new Set(filters.teams);
    const list = graded.players.filter(
      (p) => (filters.pos === "ALL" || p.pos === filters.pos) && (!teamSet.size || teamSet.has(p.team)) && (!q || p.name.toLowerCase().includes(q))
    );
    list.sort((a, b) => (sortKey === "adp" ? a.adp - b.adp : sortKey === "proj" ? b.projPoints - a.projPoints : a.name.localeCompare(b.name)));
    return list;
  }, [graded, filters.pos, filters.teams, q, sortKey]);

  // Live strip numbers.
  const hourAgo = (now ?? 0) - 3_600_000;
  const lastHour = feed.filter((f) => Date.parse(f.published) >= hourAgo).length;
  const statusChanges = feed.filter((f) => f.statusChange).length;
  const injuryCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of graded.players) if (p.injury && p.adp <= 200) c[p.injury] = (c[p.injury] ?? 0) + 1;
    return c;
  }, [graded]);
  const trending = [...live.trendingIds].map((id) => byId.get(id)).filter((p): p is BoardPlayer => !!p).slice(0, 8);
  const age = now != null ? formatAge(board.meta.builtAt, now) : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/" className="font-mono text-xs uppercase tracking-widest text-ink-dim hover:text-ink">
            ← Cockpit
          </Link>
          <h1 className="font-display text-6xl font-bold uppercase leading-none tracking-tight">
            News<span className="text-rb">room</span>
          </h1>
          <p className="mt-1 text-ink-dim">The wire desk: what changed, ranked by what it does to your draft.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-dim">
          <span className="flex items-center gap-1.5" title={live.connected ? "Jetstream connected — reporter posts arrive live" : "Live push disconnected — polling every 10 minutes"}>
            <span className={`inline-block h-2 w-2 rounded-full ${live.connected ? "live-dot bg-live" : "bg-warn"}`} />
            <span className={live.connected ? "text-live" : "text-warn"}>{live.connected ? "LIVE" : "POLLING"}</span>
          </span>
          <span title="Last successful poll">{live.lastRefresh && now != null ? `refreshed ${ago(now - live.lastRefresh)}` : "refreshing…"}</span>
          {age && (
            <span className={age.stale ? "text-warn" : undefined} title={new Date(board.meta.builtAt).toLocaleString()}>
              board {age.label}
            </span>
          )}
          <button onClick={live.refresh} className="rounded border border-line bg-panel px-2 py-1 text-ink-dim hover:text-ink">
            Refresh now
          </button>
        </div>
      </header>

      {/* Ticker line */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line/60 bg-panel/60 px-3 py-2 font-mono text-xs text-ink-dim" aria-label="Live summary">
        <span>
          <b className="font-display text-xl text-ink">{lastHour}</b> updates, last hour
        </span>
        <span>
          <b className={`font-display text-xl ${statusChanges ? "text-warn" : "text-ink"}`}>{statusChanges}</b> status changes vs board
        </span>
        <span title="Bluesky accounts polled directly, plus curated-list members on the live filter">
          <b className="font-display text-xl text-ink">{live.wire.handles}</b> accounts
          {live.wire.listMembers > 0 && <> + <b className="font-display text-xl text-ink">{live.wire.listMembers}</b> via lists</>}
        </span>
        <span className="flex gap-2" title="Injury designations among the top 200 by ADP">
          {["Questionable", "Doubtful", "Out", "IR", "Sus", "PUP"].map((s) => (
            <span key={s} className={injuryCounts[s] ? "text-warn" : "text-ink-faint"}>
              {s === "Questionable" ? "Q" : s === "Doubtful" ? "D" : s === "Out" ? "O" : s} {injuryCounts[s] ?? 0}
            </span>
          ))}
        </span>
        {trending.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="flame">🔥</span>
            {trending.map((p) => (
              <button key={p.id} onClick={() => setModal(p)} className="hover:underline" style={{ color: POS_COLOR[p.pos] }}>
                {p.name}
              </button>
            ))}
          </span>
        )}
      </p>

      <TopStories stories={topStories} byId={byId} now={now} onOpen={setModal} />

      {/* The wire */}
      <section aria-label="The wire">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-2xl font-bold uppercase tracking-tight">
            The wire <span className="font-mono text-xs font-normal normal-case tracking-normal text-ink-faint">{stories.length} players · {filtered.length} of {feed.length} updates</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded border border-line font-mono text-xs" role="radiogroup" aria-label="Sort">
              {(Object.keys(SORT_LABEL) as FeedSort[]).map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={filters.sort === s}
                  onClick={() => updateFilters({ ...filters, sort: s })}
                  className={`px-2.5 py-1.5 ${filters.sort === s ? "bg-panel-2 text-ink" : "text-ink-dim hover:text-ink"}`}
                >
                  {SORT_LABEL[s]}
                </button>
              ))}
            </div>
            <FilterMenu filters={filters} onChange={updateFilters} teams={teams} sources={sources} counts={counts} />
          </div>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {(["ALL", ...POS_ORDER] as const).map((p) => (
              <button
                key={p}
                onClick={() => updateFilters({ ...filters, pos: p })}
                className={`rounded px-2 py-1 font-mono text-xs ${filters.pos === p ? "bg-panel-2 text-ink" : "bg-panel text-ink-dim hover:text-ink"}`}
                style={p !== "ALL" && filters.pos === p ? { color: POS_COLOR[p], boxShadow: `inset 0 0 0 1px ${POS_COLOR[p]}` } : undefined}
              >
                {p}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players or headlines…"
            className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-1.5 text-sm"
            aria-label="Search players or headlines"
          />
        </div>

        {pending > 0 && (
          <button
            onClick={() => {
              setFrozen(null);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className="btn-shimmer sticky top-3 z-20 mx-auto mb-2 block rounded-full bg-rb px-4 py-1.5 font-display text-sm font-bold uppercase tracking-wide text-field shadow-lg"
          >
            {pending} new update{pending === 1 ? "" : "s"} ↑
          </button>
        )}
        {stories.length === 0 ? (
          <p className="rounded-xl bg-panel p-8 text-center text-sm text-ink-dim">
            {now == null || live.lastRefresh == null
              ? "Pulling the wire…"
              : feed.length === 0
                ? "Nothing fresh on the wire. Quiet is good news."
                : "Nothing matches these filters. Loosen them or reset from the Filters menu."}
          </p>
        ) : (
          <ol className="stagger flex flex-col gap-2">
            {stories.slice(0, 120).map((s) => (
              <StoryCard key={s.playerId} story={s} player={byId.get(s.playerId)} now={now} onOpen={setModal} />
            ))}
          </ol>
        )}
      </section>

      {/* Every player */}
      <section aria-label="All players">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-2xl font-bold uppercase tracking-tight">Every player</h2>
          <div className="flex items-center gap-2 font-mono text-xs text-ink-faint">
            <span>{tableRows.length} players · {board.meta.format}</span>
            <label>
              sort{" "}
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as typeof sortKey)} className="rounded border border-line bg-field px-1 py-0.5">
                <option value="adp">ADP</option>
                <option value="proj">Projection</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl bg-panel">
          <table className="w-full text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              <tr className="text-left">
                <th className="px-3 py-2">ADP</th>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2">Team</th>
                <th className="px-3 py-2">Bye</th>
                <th className="px-3 py-2 text-right">Proj</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Latest</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.slice(0, limit).map((p) => {
                const note = live.boardNews.get(p.id);
                return (
                  <tr key={p.id} className="border-t border-line/60 hover:bg-panel-2">
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-dim">{p.adp.toFixed(1)}</td>
                    <td className="px-3 py-1.5">
                      <button onClick={() => setModal(p)} className="flex items-center gap-2 text-left hover:underline">
                        <Headshot player={p} size={28} />
                        <span className="font-semibold" style={{ color: POS_COLOR[p.pos] }}>{p.name}</span>
                        <span className="font-mono text-[10px] text-ink-faint">{p.pos}</span>
                      </button>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-dim">{p.team}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-dim">{p.bye ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs">{p.projPoints.toFixed(0)}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-dim">{p.tier || "—"}</td>
                    <td className="max-w-[26rem] px-3 py-1.5 text-xs text-ink-dim">
                      <span className="inline-flex items-center gap-1.5">
                        <InjuryBadge injury={p.injury} />
                        {live.trendingIds.has(p.id) && <span className="flame" title="Trending — most-added on Sleeper (24h)">🔥</span>}
                        <span className="truncate" title={note?.headline}>{note?.headline ?? ""}</span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {tableRows.length > limit && (
            <button onClick={() => setLimit(tableRows.length)} className="block w-full border-t border-line px-3 py-2 text-center font-mono text-xs text-ink-dim hover:text-ink">
              Show all {tableRows.length}
            </button>
          )}
        </div>
      </section>

      {modal && (
        <PlayerModal
          player={modal}
          ctx={{
            currentPick: 1,
            nextPick: 1,
            drift: {},
            tierMatesLeft: graded.players.filter((a) => a.pos === modal.pos && a.tier === modal.tier && a.id !== modal.id).length,
          }}
          config={config}
          drafted={false}
          canUnmark={false}
          readonly
          trending={live.trendingIds.has(modal.id)}
          wireItem={live.boardNews.get(modal.id) ?? null}
          myTurn={false}
          onMark={() => {}}
          onUnmark={() => {}}
          onClose={() => setModal(null)}
        />
      )}

      <footer className="mt-4 font-mono text-[10px] text-ink-faint">
        Sources: ESPN injuries table + headlines · CBS Sports, RotoWire, The Athletic, Yahoo, PFT, Google News · Bluesky wire · photos ESPN ({board.meta.lane ?? "full"} lane board)
      </footer>
    </main>
  );
}
