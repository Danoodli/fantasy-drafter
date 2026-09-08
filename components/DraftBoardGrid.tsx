"use client";

// The room's draft board, drawn the way DraftKings draws it: one column per
// draft slot, one row per round, picks snaking with the room's order, each
// cell tinted by position with its "round.pick" label, overall pick, headshot,
// first-initial name and "POS TEAM (BYE n)". Purely presentational — the
// cockpit's Board view and the /mock-board fixture both render this, so the
// screen-sync grid reader is tested against the exact pixels the product shows.

import { useEffect, useMemo, useRef } from "react";
import type { BoardPlayer, DraftOrder, DraftPick, Position } from "../lib/types";
import { abbreviateName, layoutBoard } from "../lib/draft/boardLayout";
import { headshotUrl } from "./newsroom/Headshot";

/** DraftKings' pastel position tints (light theme). */
export const CELL_BG: Record<Position, string> = {
  QB: "#f6c7ce",
  RB: "#c6ebd1",
  WR: "#fbe9a3",
  TE: "#c3dbf7",
  K: "#e3d4f6",
  DST: "#dfe4e9",
};
const POS_TINT: Record<Position, string> = { QB: "#ff8a95", RB: "#7fe0a8", WR: "#ffe27a", TE: "#8fc1ff", K: "#d5b8ff", DST: "#c5ccd3" };
const HEADER_POS: Position[] = ["QB", "RB", "WR", "TE"];

export interface DraftBoardGridProps {
  teams: number;
  rounds: number;
  order?: DraftOrder;
  picks: DraftPick[];
  /** Resolves a pick's player for headshot, team and bye (a pick only carries name and position). */
  byId: Map<string, BoardPlayer>;
  /** The pick on the clock — its cell is outlined. */
  currentPick?: number;
  /** My draft slot — its column reads "You". */
  mySlot?: number | null;
  /** Show the gray overall pick under the label (some DraftKings boards do). */
  showOverall?: boolean;
  /** Per-slot QB/RB/WR/TE counts above the grid, as the room draws them. */
  showHeader?: boolean;
  /** Column titles ("Team 3", "You"); null for counts only like DraftKings. */
  headerLabel?: ((slot: number) => string) | null;
  /** Scroll the newest pick into view when picks change. */
  followLatest?: boolean;
  /** CSS zoom of the grid (a zoomed-in room shows fewer, bigger columns). */
  zoom?: number;
  onOpen?: (player: BoardPlayer) => void;
  /** Manual mode: an unknown placeholder cell is clickable to fill in who it was. */
  onFillUnknown?: (manualIndex: number, pickNo: number) => void;
  /** Scroll container styling; the mock also tags it for the OCR harness. */
  className?: string;
  style?: React.CSSProperties;
  containerProps?: Record<string, string>;
}

export default function DraftBoardGrid({
  teams,
  rounds,
  order = "snake",
  picks,
  byId,
  currentPick = 0,
  mySlot = null,
  showOverall = true,
  showHeader = true,
  headerLabel = (slot) => (slot === mySlot ? "You" : `Team ${slot}`),
  followLatest = true,
  zoom = 1,
  onOpen,
  onFillUnknown,
  className,
  style,
  containerProps,
}: DraftBoardGridProps) {
  const rows = useMemo(() => layoutBoard(picks, teams, rounds, order), [picks, teams, rounds, order]);
  const counts = useMemo(() => {
    const out = Array.from({ length: teams }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 } as Record<Position, number>));
    for (const p of picks) if (p.pos && p.draftSlot >= 1 && p.draftSlot <= teams) out[p.draftSlot - 1][p.pos]++;
    return out;
  }, [picks, teams]);
  const ref = useRef<HTMLDivElement>(null);
  const filled = picks.filter((p) => p.pickNo >= 1).length;

  // Keep the latest pick in view, like the real board does.
  useEffect(() => {
    if (!followLatest || !ref.current) return;
    const target = Math.max(1, Math.min(teams * rounds, filled || currentPick));
    const el = ref.current.querySelector<HTMLElement>(`[data-pick="${target}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [filled, currentPick, followLatest, teams, rounds]);

  return (
    <div ref={ref} className={className} style={{ overflow: "auto", padding: 4, background: "#141414", ...style }} {...containerProps}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${teams}, minmax(0, 1fr))`, gap: 3, minWidth: teams * 96, zoom }}>
        {showHeader &&
          counts.map((n, i) => {
            const slot = i + 1;
            const mine = slot === mySlot;
            const title = headerLabel ? headerLabel(slot) : null;
            return (
              <div
                key={`h${slot}`}
                style={{
                  background: mine ? "#1f3a2e" : "#2a2a2e",
                  borderRadius: 4,
                  padding: "5px 6px",
                  fontSize: 11,
                  fontWeight: 700,
                  textAlign: "center",
                  color: mine ? "#a8f0cd" : "#ddd",
                  outline: mine ? "1px solid #3cc9a7" : undefined,
                }}
              >
                {title && <div style={{ marginBottom: 2, letterSpacing: 0.3 }}>{title}</div>}
                <div style={{ display: "flex", justifyContent: "space-around" }}>
                  {HEADER_POS.map((p) => (
                    <span key={p} style={{ color: POS_TINT[p] }}>{p}</span>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-around" }}>
                  {HEADER_POS.map((p) => (
                    <span key={p}>{n[p]}</span>
                  ))}
                </div>
              </div>
            );
          })}
        {rows.map((row) =>
          row.map((cell) => {
            const key = `${cell.round}-${cell.slot}`;
            const pickInRound = cell.pickNo - (cell.round - 1) * teams;
            const label = `${cell.round}.${pickInRound}`;
            const arrow = row[0].pickNo < row[row.length - 1].pickNo ? "→" : "←";
            const onClock = cell.pickNo === currentPick;
            const pick = cell.pick;
            if (!pick) {
              return (
                <div
                  key={key}
                  data-pick={cell.pickNo}
                  title={onClock ? `Pick ${cell.pickNo} — on the clock` : `Pick ${cell.pickNo}`}
                  style={{ ...cellBase, background: onClock ? "#fff8dc" : "#fff", outline: onClock ? "3px solid #f5a623" : undefined, outlineOffset: -3 }}
                >
                  <div style={labelRow}>
                    <span style={{ fontWeight: 700 }}>{label}</span>
                  </div>
                  <div style={{ height: 24, fontSize: 11, color: "#9aa3ad", lineHeight: "12px" }}>{showOverall ? cell.pickNo : ""}</div>
                  {onClock && <div style={{ fontSize: 12, fontWeight: 700, color: "#b4700a", lineHeight: "16px" }}>On the clock</div>}
                </div>
              );
            }
            const player = pick.playerId ? byId.get(pick.playerId) : undefined;
            if (!pick.playerId) {
              const clickable = onFillUnknown && pick.manualIndex != null;
              return (
                <div
                  key={key}
                  data-pick={cell.pickNo}
                  data-overall={cell.pickNo}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onFillUnknown(pick.manualIndex!, cell.pickNo) : undefined}
                  onKeyDown={clickable ? (e) => e.key === "Enter" && onFillUnknown(pick.manualIndex!, cell.pickNo) : undefined}
                  title={clickable ? "Unknown pick — click to fill in who it was" : "Unknown pick"}
                  style={{ ...cellBase, background: "#e9ecef", cursor: clickable ? "pointer" : undefined }}
                >
                  <div style={labelRow}>
                    <span style={{ fontWeight: 700 }}>{label}</span>
                    <span style={{ color: "#5b6470" }}>{arrow}</span>
                  </div>
                  <div style={{ height: 24, fontSize: 11, color: "#6b7480", lineHeight: "12px" }}>{showOverall ? cell.pickNo : ""}</div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontStyle: "italic", color: "#5b6470", lineHeight: "16px" }}>Unknown pick</div>
                  <div style={{ fontSize: 10, color: "#6b7480", lineHeight: "12px" }}>{clickable ? "click to fill in" : ""}</div>
                </div>
              );
            }
            const pos = pick.pos ?? player?.pos ?? "DST";
            const name = player?.name ?? pick.playerName;
            const team = player?.team ?? "";
            const bye = player?.bye;
            const photo = headshotUrl(player?.ids.espn, 96);
            const open = player && onOpen ? () => onOpen(player) : undefined;
            return (
              <div
                key={key}
                data-pick={cell.pickNo}
                data-overall={cell.pickNo}
                role={open ? "button" : undefined}
                tabIndex={open ? 0 : undefined}
                onClick={open}
                onKeyDown={open ? (e) => e.key === "Enter" && open() : undefined}
                title={`${label} · pick ${cell.pickNo} · ${name}`}
                style={{ ...cellBase, background: CELL_BG[pos], cursor: open ? "pointer" : undefined, outline: onClock ? "3px solid #f5a623" : undefined, outlineOffset: -3 }}
              >
                <div style={labelRow}>
                  <span style={{ fontWeight: 700 }}>{label}</span>
                  <span style={{ color: "#5b6470" }}>{arrow}</span>
                </div>
                {/* The photo zone: the gray overall pick sits at its left; the name always starts below it. */}
                <div style={{ height: 24, fontSize: 11, color: "#6b7480", lineHeight: "12px" }}>{showOverall ? cell.pickNo : ""}</div>
                {photo ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- remote CDN, mirrors the real board */
                  <img
                    src={photo}
                    alt=""
                    width={44}
                    height={32}
                    loading="lazy"
                    decoding="async"
                    style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", width: 44, height: 32, objectFit: "cover", borderRadius: "50%", background: "#d9dde2" }}
                  />
                ) : (
                  <span style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", width: 32, height: 32, borderRadius: "50%", background: "#d9dde2" }} />
                )}
                <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "16px" }}>
                  {abbreviateName(name, pos)}
                </div>
                <div style={{ fontSize: 10, color: "#3b4450", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "12px" }}>
                  {pos} {team}
                  {bye ? ` (BYE ${bye})` : ""}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const cellBase: React.CSSProperties = {
  position: "relative",
  borderRadius: 4,
  padding: "5px 6px 5px",
  height: 94,
  boxSizing: "border-box",
  fontSize: 11,
  color: "#111",
  fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
};
const labelRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 11, lineHeight: "13px" };
