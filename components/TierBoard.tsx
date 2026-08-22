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

const DEPTH: Record<Position, number> = { QB: 18, RB: 36, WR: 36, TE: 16, K: 8, DST: 8 };
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
  onHoverStart,
  onHoverEnd,
}: Omit<Props, "positions" | "blurbFor"> & {
  pos: Position;
  onHoverStart: (p: BoardPlayer, el: HTMLElement) => void;
  onHoverEnd: () => void;
}) {
  const group = players
    .filter((p) => p.pos === pos && (!filterIds || filterIds.has(p.id)))
    .sort((a, b) => b.projPoints - a.projPoints)
    .slice(0, DEPTH[pos]);
  const color = POS_COLOR[pos];
  const rows = group.map((p, i) => ({
    p,
    tierBreak: i === 0 || p.tier !== group[i - 1].tier,
  }));

  return (
    <div className="w-44 shrink-0">
      <div
        className="sticky top-0 z-10 border-b-2 bg-field px-2 pb-1 pt-2 font-display text-lg font-bold uppercase"
        style={{ color, borderColor: color }}
      >
        {pos}
      </div>
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
                  className={`flex min-w-0 flex-1 items-baseline gap-1.5 px-2 py-0.5 text-left text-[13px] leading-5 ${
                    drafted ? "text-ink-faint line-through" : "text-ink hover:bg-panel"
                  } ${mine ? "border-l-2 bg-panel" : "border-l-2 border-transparent"}`}
                  style={mine ? { borderLeftColor: color } : undefined}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {p.name} <InjuryBadge injury={p.injury} />
                    {!drafted && trendingIds?.has(p.id) && (
                      <span title="Trending — most-added on Sleeper (24h)"> 🔥</span>
                    )}
                    {!drafted && newsIds?.has(p.id) && (
                      <span title={`News: ${newsIds.get(p.id)!.headline}`}> 📰</span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
                  <span className="font-mono text-[11px] text-ink-dim">
                    {Math.round(p.projPoints)}
                  </span>
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
    </div>
  );
}

function TierBoard(props: Props) {
  const positions = props.positions ?? POS_ORDER;
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
    <div
      ref={containerRef}
      className="tier-scroll relative flex h-full gap-2 overflow-x-auto overflow-y-auto pb-4"
    >
      {positions.map((pos) => (
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
          onHoverStart={onHoverStart}
          onHoverEnd={onHoverEnd}
        />
      ))}
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
