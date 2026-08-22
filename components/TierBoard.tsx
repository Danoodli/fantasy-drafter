"use client";

// The tier board lives in peripheral vision. Tier breaks are the thing the
// eye should catch without reading — hard rules between bands, position
// color at the column head. Click any row to mark a player drafted.
// Hovering a row for half a second opens the verdict card: good / bad /
// horrible / perfect, risk level, and the math-derived why.

import { memo, useEffect, useRef, useState } from "react";
import type { BoardPlayer, Position } from "../lib/types";
import type { PlayerBlurb } from "../lib/engine/reasons";
import { POS_COLOR, POS_ORDER } from "../lib/client/pos";
import InjuryBadge from "./InjuryBadge";

interface Props {
  players: BoardPlayer[];
  draftedIds: Set<string>;
  myIds: Set<string>;
  /** Quick-mark via the row's hover ✕ — the fast path during a pick run. */
  onMark: (player: BoardPlayer) => void;
  /** Open the full player card (stats, news, verdict) — the row click. */
  onOpen: (player: BoardPlayer) => void;
  /** Columns to show — best-ball formats drop K/DST. Defaults to all. */
  positions?: Position[];
  /** Verdict card content for a player, computed by the cockpit. */
  blurbFor?: (p: BoardPlayer) => PlayerBlurb;
  /** The recommended player when it's my turn — glows so I find him fast. */
  highlightId?: string | null;
  /** Live search filter: only these ids render (null = everyone). */
  filterIds?: Set<string> | null;
  /** Most-added players on Sleeper (24h) — the 🔥 badge. */
  trendingIds?: Set<string>;
  /** Players with breaking headlines (72h) — the 📰 badge, title = headline. */
  newsIds?: Map<string, { headline: string }>;
}

const HOVER_DELAY_MS = 500;

const VERDICT_COLOR: Record<string, string> = {
  perfect: "var(--color-rb)",
  good: "var(--color-rb)",
  fair: "var(--color-ink-dim)",
  bad: "var(--color-warn)",
  horrible: "var(--color-qb)",
};

interface HoverState {
  player: BoardPlayer;
  blurb: PlayerBlurb;
  top: number;
  left: number;
}

function Column({
  pos,
  players,
  draftedIds,
  myIds,
  onMark,
  onOpen,
  highlightId,
  filterIds,
  trendingIds,
  newsIds,
  collapsed,
  onToggleCollapse,
  onHoverStart,
  onHoverEnd,
}: Omit<Props, "positions" | "blurbFor"> & {
  pos: Position;
  collapsed: boolean;
  onToggleCollapse: (pos: Position) => void;
  onHoverStart: (p: BoardPlayer, el: HTMLElement) => void;
  onHoverEnd: () => void;
}) {
  // Every board player at the position — the column scrolls, nothing hides.
  const group = players
    .filter((p) => p.pos === pos && (!filterIds || filterIds.has(p.id)))
    .sort((a, b) => b.projPoints - a.projPoints);
  const color = POS_COLOR[pos];
  const rows = group.map((p, i) => ({
    p,
    tierBreak: i === 0 || p.tier !== group[i - 1].tier,
  }));

  return (
    // Mobile: full-width stacked. Desktop: fixed peripheral columns.
    <div className="w-full sm:w-44 sm:shrink-0">
      <button
        onClick={() => onToggleCollapse(pos)}
        aria-expanded={!collapsed}
        title={collapsed ? `Show ${pos}s` : `Collapse ${pos}s`}
        className="sticky top-0 z-10 flex w-full items-baseline gap-2 border-b-2 bg-field px-2 pb-1 pt-2 text-left font-display text-lg font-bold uppercase"
        style={{ color, borderColor: color }}
      >
        {pos}
        <span className="font-mono text-[10px] font-normal text-ink-faint">
          {collapsed ? `${group.length} hidden ▸` : "▾"}
        </span>
      </button>
      {!collapsed && (
      <ul>
        {rows.map(({ p, tierBreak }) => {
          const drafted = draftedIds.has(p.id);
          const mine = myIds.has(p.id);
          const isRec = highlightId === p.id && !drafted;
          return (
            <li key={p.id}>
              {tierBreak && (
                <div className="mt-1 flex items-center gap-1.5 px-2 pt-1">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                    T{p.tier}
                  </span>
                  <span className="h-px flex-1 bg-line" aria-hidden />
                </div>
              )}
              <div
                className={`group flex items-stretch ${isRec ? "rec-glow" : ""}`}
                style={isRec ? { ["--pulse-color" as string]: color } : undefined}
              >
                <button
                  onClick={() => onOpen(p)}
                  data-rec={isRec || undefined}
                  onMouseEnter={(e) => !drafted && onHoverStart(p, e.currentTarget)}
                  onMouseLeave={onHoverEnd}
                  title={`${p.name} — stats, news, verdict`}
                  className={`row-nudge min-w-0 flex-1 px-2 py-0.5 text-left text-[13px] leading-5 ${
                    drafted ? "text-ink-faint line-through" : "text-ink hover:bg-panel"
                  } ${mine ? "border-l-2 bg-panel" : "border-l-2 border-transparent"}`}
                  style={mine ? { borderLeftColor: color } : undefined}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
                    <span className="font-mono text-[11px] text-ink-dim">
                      {Math.round(p.projPoints)}
                    </span>
                  </span>
                  {/* Badges live on their own row — a long name never hides them */}
                  {(p.injury || p.adpTrend != null || (!drafted && (trendingIds?.has(p.id) || newsIds?.has(p.id)))) && (
                    <span className="flex items-center gap-1 pb-0.5 text-[11px] leading-4 no-underline [text-decoration:none]">
                      <InjuryBadge injury={p.injury} />
                      {p.adpTrend != null && (
                        <span
                          className={`font-mono text-[10px] ${p.adpTrend > 0 ? "text-rb" : "text-qb"}`}
                          title={`ADP ${p.adpTrend > 0 ? "riser" : "faller"}: drafted ${Math.abs(p.adpTrend).toFixed(0)} picks ${p.adpTrend > 0 ? "earlier" : "later"} than a few days ago`}
                        >
                          {p.adpTrend > 0 ? "▲" : "▼"}{Math.abs(p.adpTrend).toFixed(0)}
                        </span>
                      )}
                      {!drafted && trendingIds?.has(p.id) && (
                        <span className="flame" title="Trending — most-added on Sleeper (24h)">🔥</span>
                      )}
                      {!drafted && newsIds?.has(p.id) && (
                        <span className="news-flap badge-pop" title={`News: ${newsIds.get(p.id)!.headline}`}>📰</span>
                      )}
                    </span>
                  )}
                </button>
                {!drafted && (
                  <button
                    onClick={() => onMark(p)}
                    title={`Mark ${p.name} drafted`}
                    aria-label={`Mark ${p.name} drafted`}
                    className="px-1 font-mono text-[11px] text-ink-faint opacity-0 hover:text-warn focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    ✕
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      )}
    </div>
  );
}

function TierBoard(props: Props) {
  const positions = props.positions ?? POS_ORDER;
  // Position filter chips: null = all. Click selects; click again removes;
  // empty selection snaps back to all.
  const [selected, setSelected] = useState<Set<Position> | null>(null);
  const shown = positions.filter((pos) => !selected || selected.has(pos));
  const toggle = (pos: Position) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (prev?.has(pos)) next.delete(pos);
      else next.add(pos);
      return next.size === 0 || next.size === positions.length ? null : next;
    });
  };
  // Collapsed sections: tap a position header to fold it away (gold on
  // mobile, where columns stack).
  const [collapsedSet, setCollapsedSet] = useState<Set<Position>>(new Set());
  const toggleCollapse = (pos: Position) =>
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(pos)) next.delete(pos);
      else next.add(pos);
      return next;
    });
  const [hover, setHover] = useState<HoverState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const onHoverStart = (p: BoardPlayer, el: HTMLElement) => {
    if (!props.blurbFor) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      const cardW = 260;
      const left =
        rect.right + cardW + 12 < window.innerWidth ? rect.right + 8 : rect.left - cardW - 8;
      const top = Math.min(rect.top, window.innerHeight - 240);
      setHover({ player: p, blurb: props.blurbFor!(p), top, left: Math.max(4, left) });
    }, HOVER_DELAY_MS);
  };
  const onHoverEnd = () => {
    clearTimeout(timer.current);
    setHover(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // When the recommendation changes on my turn, bring him into view.
  useEffect(() => {
    if (!props.highlightId) return;
    const el = containerRef.current?.querySelector("[data-rec]");
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.highlightId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Position filter chips — like every good draft room */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter positions">
        <button
          onClick={() => setSelected(null)}
          aria-pressed={selected === null}
          className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-semibold ${
            selected === null ? "bg-ink text-field" : "bg-panel text-ink-dim hover:text-ink"
          }`}
        >
          All
        </button>
        {positions.map((pos) => {
          const active = selected?.has(pos) ?? false;
          return (
            <button
              key={pos}
              onClick={() => toggle(pos)}
              aria-pressed={active}
              className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-semibold ${
                active ? "text-field" : "bg-panel hover:brightness-125"
              }`}
              style={active ? { background: POS_COLOR[pos] } : { color: POS_COLOR[pos] }}
            >
              {pos}
            </button>
          );
        })}
        {selected !== null && (
          <button onClick={() => setSelected(null)} className="text-xs text-ink-faint hover:text-ink">
            reset
          </button>
        )}
      </div>

      <div
        ref={containerRef}
        className="tier-scroll relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4 sm:flex-row sm:gap-2 sm:overflow-x-auto"
      >
        {shown.map((pos) => (
          <Column
            key={pos}
            pos={pos}
            players={props.players}
            draftedIds={props.draftedIds}
            myIds={props.myIds}
            onMark={props.onMark}
            onOpen={props.onOpen}
            highlightId={props.highlightId}
            filterIds={props.filterIds}
            trendingIds={props.trendingIds}
            newsIds={props.newsIds}
            collapsed={collapsedSet.has(pos)}
            onToggleCollapse={toggleCollapse}
            onHoverStart={onHoverStart}
            onHoverEnd={onHoverEnd}
          />
        ))}
      </div>
      {hover && (
        <div
          role="tooltip"
          className="fixed z-50 w-[260px] rounded-lg border border-line bg-panel-2 p-3 shadow-2xl"
          style={{ top: hover.top, left: hover.left }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-display text-lg font-bold uppercase">
              {hover.player.name}
            </span>
            <span className="font-mono text-[10px] text-ink-faint">
              {hover.player.pos} · {hover.player.team}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-field"
              style={{ background: VERDICT_COLOR[hover.blurb.verdict] }}
            >
              {hover.blurb.verdict}
            </span>
            <span className="font-mono text-[11px] uppercase text-ink-dim">{hover.blurb.risk}</span>
          </div>
          <ul className="mt-2 space-y-1 text-[12.5px] leading-snug text-ink">
            {hover.blurb.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 font-mono text-[10px] text-ink-faint">
            {Math.round(hover.player.projPoints)} proj · VORP {Math.round(hover.player.vorp)} · bye{" "}
            {hover.player.bye ?? "—"}
          </p>
        </div>
      )}
    </div>
  );
}

export default memo(TierBoard);
// (tooltip renders inside the scroll container; chips row sits above it)
