"use client";

// The Newsroom: every player and every update, outside a draft. A pure
// consumer of the same plumbing the Cockpit uses — useLiveSignals for the
// feeds, gradeBoard for statuses, buildFeed for the ranking — so the two
// screens can never disagree about a player.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Board, BoardPlayer, LeagueConfig, Position } from "../lib/types";
import { DEFAULT_CONFIG, loadConfig } from "../lib/client/config";
import { useLiveSignals } from "../lib/client/useLiveSignals";
import { useNow } from "../lib/client/useNow";
import { formatAge } from "../lib/client/boardAge";
import { POS_COLOR, POS_ORDER } from "../lib/client/pos";
import { gradeBoard } from "../lib/engine/injuryFeed";
import { buildFeed, KIND_LABEL, type FeedItem, type NewsKind } from "../lib/engine/newsImportance";
import InjuryBadge from "./InjuryBadge";
import PlayerModal from "./PlayerModal";

const SEVERITY_FLOORS = [
  { label: "Everything", min: 0 },
  { label: "Actionable", min: 0.3 },
  { label: "Serious", min: 0.6 },
];
const TABLE_PAGE = 100;

const KIND_TONE: Record<NewsKind, string> = {
  "season-ending": "bg-qb/20 text-qb",
  suspension: "bg-qb/20 text-qb",
  out: "bg-warn/20 text-warn",
  doubtful: "bg-warn/20 text-warn",
  questionable: "bg-warn/15 text-warn",
  transaction: "bg-wr/20 text-wr",
  depth: "bg-te/20 text-te",
  cleared: "bg-rb/20 text-rb",
  mention: "bg-panel-2 text-ink-dim",
};

function ago(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

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
        <p className="font-mono text-sm text-ink-dim">Loading board…</p>
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
    () => (now == null ? [] : buildFeed(board, live.boardNews, live.liveStatus, now)),
    [board, live.boardNews, live.liveStatus, now]
  );
  const byId = useMemo(() => new Map(graded.players.map((p) => [p.id, p])), [graded]);

  // Never reorder under the cursor: once the user scrolls down, the list is
  // frozen and new items wait behind a pill until they come back up.
  const [frozen, setFrozen] = useState<FeedItem[] | null>(null);
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  });
  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > 200) setFrozen((f) => f ?? feedRef.current);
      else setFrozen(null);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const visible = frozen ?? feed;
  const pending = useMemo(() => {
    if (!frozen) return 0;
    const known = new Set(frozen.map((f) => f.id));
    return feed.filter((f) => !known.has(f.id)).length;
  }, [frozen, feed]);

  // Filters shared by the feed and the table.
  const [pos, setPos] = useState<Position | "ALL">("ALL");
  const [team, setTeam] = useState("ALL");
  const [floor, setFloor] = useState(0);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<"adp" | "proj" | "name">("adp");
  const [limit, setLimit] = useState(TABLE_PAGE);
  const [modal, setModal] = useState<BoardPlayer | null>(null);

  const teams = useMemo(() => [...new Set(graded.players.map((p) => p.team).filter(Boolean))].sort(), [graded]);
  const q = query.trim().toLowerCase();
  const inScope = (p: { pos: Position; team: string }) => (pos === "ALL" || p.pos === pos) && (team === "ALL" || p.team === team);
  const feedRows = visible.filter(
    (f) =>
      inScope(f) &&
      f.severity >= SEVERITY_FLOORS[floor].min &&
      (!q || f.name.toLowerCase().includes(q) || f.headline.toLowerCase().includes(q))
  );
  const tableRows = useMemo(() => {
    const rows = graded.players.filter((p) => inScope(p) && (!q || p.name.toLowerCase().includes(q)));
    rows.sort((a, b) =>
      sortKey === "adp" ? a.adp - b.adp : sortKey === "proj" ? b.projPoints - a.projPoints : a.name.localeCompare(b.name)
    );
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inScope() closes over the filter state listed here
  }, [graded, pos, team, q, sortKey]);

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
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/" className="font-mono text-xs uppercase tracking-widest text-ink-dim hover:text-ink">
            ← Cockpit
          </Link>
          <h1 className="font-display text-5xl font-bold uppercase tracking-tight">Newsroom</h1>
          <p className="text-ink-dim">Every player, every update — ranked by what matters to your draft.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-ink-dim">
          <span className="flex items-center gap-1.5" title={live.connected ? "Jetstream connected — reporter posts arrive live" : "Live push disconnected — polling every 10 minutes"}>
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: live.connected ? "var(--color-live)" : "var(--color-warn)", boxShadow: live.connected ? "0 0 8px var(--color-live)" : undefined }}
            />
            {live.connected ? "LIVE" : "POLLING"}
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

      {/* Live strip */}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Live summary">
        <Stat label="updates, last hour" value={lastHour} />
        <Stat label="status changes vs board" value={statusChanges} tone={statusChanges ? "text-warn" : undefined} />
        <div className="rounded-lg bg-panel p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">injuries, top 200</p>
          <p className="mt-1 flex flex-wrap gap-2 font-mono text-sm">
            {["Questionable", "Doubtful", "Out", "IR", "Sus", "PUP"].map((s) => (
              <span key={s} className={injuryCounts[s] ? "text-warn" : "text-ink-faint"}>
                {s === "Questionable" ? "Q" : s === "Doubtful" ? "D" : s === "Out" ? "O" : s} {injuryCounts[s] ?? 0}
              </span>
            ))}
          </p>
        </div>
        <div className="rounded-lg bg-panel p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">🔥 most added (Sleeper, 24h)</p>
          <p className="mt-1 flex flex-wrap gap-x-2 text-sm">
            {trending.length === 0 && <span className="text-ink-faint">—</span>}
            {trending.map((p) => (
              <button key={p.id} onClick={() => setModal(p)} className="hover:underline" style={{ color: POS_COLOR[p.pos] }}>
                {p.name}
              </button>
            ))}
          </p>
        </div>
      </section>

      {/* Filters */}
      <section className="flex flex-wrap items-center gap-2" aria-label="Filters">
        <div className="flex gap-1">
          {(["ALL", ...POS_ORDER] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPos(p)}
              className={`rounded px-2 py-1 font-mono text-xs ${pos === p ? "bg-panel-2 text-ink" : "bg-panel text-ink-dim hover:text-ink"}`}
              style={p !== "ALL" && pos === p ? { color: POS_COLOR[p] } : undefined}
            >
              {p}
            </button>
          ))}
        </div>
        <select value={team} onChange={(e) => setTeam(e.target.value)} className="rounded border border-line bg-field px-2 py-1 font-mono text-xs" aria-label="Team">
          <option value="ALL">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <div className="flex gap-1" role="radiogroup" aria-label="Severity floor">
          {SEVERITY_FLOORS.map((f, i) => (
            <button
              key={f.label}
              onClick={() => setFloor(i)}
              className={`rounded px-2 py-1 font-mono text-xs ${floor === i ? "bg-panel-2 text-ink" : "bg-panel text-ink-dim hover:text-ink"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search players…"
          className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-1.5 text-sm"
          aria-label="Search players"
        />
      </section>

      {/* What matters */}
      <section aria-label="What matters" className="relative">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-bold uppercase tracking-tight">What matters</h2>
          <span className="font-mono text-xs text-ink-faint">{feedRows.length} updates · severity × ADP × recency</span>
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
        {feedRows.length === 0 ? (
          <p className="rounded-lg bg-panel p-6 text-center text-sm text-ink-dim">
            {now == null || live.lastRefresh == null ? "Pulling the wire…" : "Nothing fresh matches these filters. Quiet is good news."}
          </p>
        ) : (
          <ol className="stagger flex flex-col gap-1.5">
            {feedRows.slice(0, 120).map((f) => (
              <li key={f.id} className="lift grid grid-cols-[4px_1fr] gap-3 rounded-lg bg-panel p-3">
                <span
                  className="self-stretch rounded"
                  style={{ background: POS_COLOR[f.pos], opacity: 0.35 + 0.65 * Math.min(1, f.importance) }}
                  title={`importance ${f.importance.toFixed(2)}`}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button onClick={() => setModal(byId.get(f.playerId) ?? null)} className="font-display text-lg font-bold uppercase tracking-wide hover:underline" style={{ color: POS_COLOR[f.pos] }}>
                      {f.name}
                    </button>
                    <span className="font-mono text-xs text-ink-dim">
                      {f.pos} · {f.team} · ADP {f.adp.toFixed(1)}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${KIND_TONE[f.kind]}`}>
                      {KIND_LABEL[f.kind]}
                    </span>
                    {f.statusChange && <InjuryBadge injury={f.statusChange.to ?? "cleared"} />}
                  </div>
                  <p className="mt-1 text-sm leading-snug">{f.headline}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-xs text-ink-faint">
                    <span>{f.source}</span>
                    <span title={new Date(f.published).toLocaleString()}>{now != null ? ago(now - Date.parse(f.published)) : ""}</span>
                    {f.href && (
                      <a href={f.href} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                        open ↗
                      </a>
                    )}
                  </p>
                </div>
              </li>
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
        <div className="overflow-x-auto rounded-lg bg-panel">
          <table className="w-full text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              <tr className="text-left">
                <th className="px-3 py-2">ADP</th>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2">Pos</th>
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
                      <button onClick={() => setModal(p)} className="font-semibold hover:underline" style={{ color: POS_COLOR[p.pos] }}>
                        {p.name}
                      </button>{" "}
                      <span className="inline-flex items-center gap-1 align-middle">
                        <InjuryBadge injury={p.injury} />
                        {live.trendingIds.has(p.id) && <span className="flame text-xs" title="Trending — most-added on Sleeper (24h)">🔥</span>}
                        {note && <span className="news-flap text-xs" title={note.headline}>📰</span>}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-dim">{p.team}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-dim">{p.bye ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs">{p.projPoints.toFixed(0)}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-dim">{p.tier || "—"}</td>
                    <td className="max-w-[28rem] truncate px-3 py-1.5 text-xs text-ink-dim" title={note?.headline}>
                      {note?.headline ?? ""}
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
        Sources: ESPN injuries table + headlines · CBS Sports, RotoWire, Yahoo, PFT · Bluesky wire ({board.meta.lane ?? "full"} lane board)
      </footer>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg bg-panel p-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{label}</p>
      <p className={`mt-1 font-display text-3xl font-bold ${tone ?? ""}`}>{value}</p>
    </div>
  );
}
