"use client";

// A stand-in for DraftKings' draft BOARD view, so screen sync and paste import
// can be exercised without a live room: one column per team, one row per
// round, picks snaking left-to-right then right-to-left, each cell wearing its
// "round.pick" label, overall pick, headshot, abbreviated name and
// "POS TEAM (BYE n)". Open it in a second tab, share that tab with Screen sync
// in the cockpit, press Play, and watch the picks land. "Copy board" puts the
// grid on the clipboard the way a browser copies the real one (row by row).
//
// Test fixture, not product: it simulates a room with a seeded picker and
// never touches the engine or the draft state. URL options: teams, rounds,
// picks (already made), autoplay=1, speed (ms), seed, overall=0 (hide the gray
// overall pick under the label — some DraftKings boards do), zoom (1.7 shows
// ~7 columns like a zoomed-in room), header=0 (drop the position-count header).

import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, BoardPlayer, Position } from "../lib/types";

/** DraftKings' pastel position tints (light theme). */
const CELL_BG: Record<Position, string> = {
  QB: "#f6c7ce",
  RB: "#c6ebd1",
  WR: "#fbe9a3",
  TE: "#c3dbf7",
  K: "#e3d4f6",
  DST: "#dfe4e9",
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "Marvin Harrison Jr." → "M. Harrison Jr."; team defenses keep their name. */
export function abbreviateName(name: string, pos: Position): string {
  if (pos === "DST") return name;
  const parts = name.split(" ");
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

interface Cell {
  round: number;
  pick: number;
  overall: number;
  player: BoardPlayer;
}

/** Column on screen for a pick: odd rounds run left to right, even rounds right to left. */
function columnOf(round: number, pick: number, teams: number): number {
  return round % 2 === 1 ? pick - 1 : teams - pick;
}

/** Simulate the room: ADP order with a little seeded noise; K/DST only in the last rounds. */
function simulate(players: BoardPlayer[], count: number, teams: number, rounds: number, seed: number): Cell[] {
  const rng = mulberry32(seed);
  const pool = [...players].filter((p) => Number.isFinite(p.adp)).sort((a, b) => a.adp - b.adp);
  const taken = new Set<string>();
  const out: Cell[] = [];
  const total = Math.min(count, teams * rounds);
  for (let overall = 1; overall <= total; overall++) {
    const round = Math.ceil(overall / teams);
    const pick = ((overall - 1) % teams) + 1;
    const late = round >= rounds - 1;
    const window: BoardPlayer[] = [];
    for (const p of pool) {
      if (taken.has(p.id)) continue;
      if (!late && (p.pos === "K" || p.pos === "DST")) continue;
      window.push(p);
      if (window.length >= 6) break;
    }
    if (window.length === 0) break;
    // Weighted toward the top of the window.
    const r = rng();
    const idx = Math.min(window.length - 1, Math.floor(r * r * window.length));
    const player = window[idx];
    taken.add(player.id);
    out.push({ round, pick, overall, player });
  }
  return out;
}

export type CopyFormat = "lines" | "tabs" | "names";

/** What a browser puts on the clipboard when the board is selected and copied: cells in screen order. */
export function boardClipboard(cells: Cell[], teams: number, format: CopyFormat): string {
  const rows = new Map<number, (Cell | null)[]>();
  for (const c of cells) {
    if (!rows.has(c.round)) rows.set(c.round, Array.from({ length: teams }, () => null));
    rows.get(c.round)![columnOf(c.round, c.pick, teams)] = c;
  }
  const lines: string[] = [];
  for (const round of [...rows.keys()].sort((a, b) => a - b)) {
    const present = rows.get(round)!.filter((c): c is Cell => c != null);
    if (format === "tabs") {
      lines.push(present.map((c) => cellText(c).join("\t")).join("\t"));
    } else if (format === "names") {
      for (const c of present) lines.push(abbreviateName(c.player.name, c.player.pos));
    } else {
      for (const c of present) lines.push(...cellText(c));
    }
  }
  return lines.join("\n");
}

function cellText(c: Cell): string[] {
  const p = c.player;
  return [`${c.round}.${c.pick}`, String(c.overall), abbreviateName(p.name, p.pos), `${p.pos} ${p.team}${p.bye ? ` (BYE ${p.bye})` : ""}`];
}

interface Room {
  teams: number;
  rounds: number;
  seed: number;
  /** Show the gray overall pick number under each label. */
  overall: boolean;
  /** Per-team QB/RB/WR/TE counts above the grid, as DraftKings draws them. */
  header: boolean;
  /** CSS zoom of the grid (a zoomed-in room shows fewer, bigger columns). */
  zoom: number;
}

export default function MockBoard() {
  // URL options are read after mount so the server and first client render agree.
  const [room, setRoom] = useState<Room>({ teams: 12, rounds: 15, seed: 7, overall: true, header: true, zoom: 1 });
  const { teams, rounds, seed, overall: showOverall, header, zoom } = room;
  const [players, setPlayers] = useState<BoardPlayer[] | null>(null);
  const [count, setCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4000);
  const [format, setFormat] = useState<CopyFormat>("lines");
  const [copied, setCopied] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time URL hydration; server and first client render agree
    setRoom({
      teams: Math.max(2, Math.min(20, Number(q.get("teams")) || 12)),
      rounds: Math.max(1, Math.min(30, Number(q.get("rounds")) || 15)),
      seed: Number(q.get("seed")) || 7,
      overall: q.get("overall") !== "0",
      header: q.get("header") !== "0",
      zoom: Math.max(0.5, Math.min(3, Number(q.get("zoom")) || 1)),
    });
    setCount(Math.max(0, Number(q.get("picks")) || 0));
    setPlaying(q.get("autoplay") === "1");
    setSpeed(Number(q.get("speed")) || 4000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/data/board-ppr.json", { cache: "force-cache" })
      .then((r) => r.json())
      .then((b: Board) => !cancelled && setPlayers(b.players))
      .catch(() => !cancelled && setPlayers([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const total = teams * rounds;
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setCount((n) => (n >= total ? n : n + 1)), Math.max(300, speed));
    return () => clearInterval(t);
  }, [playing, speed, total]);

  const cells = useMemo(() => (players ? simulate(players, count, teams, rounds, seed) : []), [players, count, teams, rounds, seed]);
  const byRound = useMemo(() => {
    const rows: (Cell | null)[][] = Array.from({ length: rounds }, () => Array.from({ length: teams }, () => null));
    for (const c of cells) rows[c.round - 1][columnOf(c.round, c.pick, teams)] = c;
    return rows;
  }, [cells, rounds, teams]);

  // Keep the latest pick in view, like the real board does.
  useEffect(() => {
    const last = cells[cells.length - 1];
    if (!last || !gridRef.current) return;
    const el = gridRef.current.querySelector<HTMLElement>(`[data-overall="${last.overall}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cells]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(boardClipboard(cells, teams, format));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const truth = cells.map((c) => ({ pickNo: c.overall, round: c.round, pick: c.pick, id: c.player.id, name: c.player.name }));
  // Header: how many QB/RB/WR/TE each team has taken so far.
  const HEADER_POS: Position[] = ["QB", "RB", "WR", "TE"];
  const counts = Array.from({ length: teams }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 } as Record<Position, number>));
  for (const c of cells) counts[columnOf(c.round, c.pick, teams)][c.player.pos]++;
  const POS_TINT: Record<Position, string> = { QB: "#ff8a95", RB: "#7fe0a8", WR: "#ffe27a", TE: "#8fc1ff", K: "#d5b8ff", DST: "#c5ccd3" };

  return (
    <div style={{ background: "#f3f4f6", color: "#111", minHeight: "100dvh", fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif' }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#1b1f24", color: "#fff", fontSize: 13 }}>
        <strong style={{ fontSize: 14 }}>Mock draft board</strong>
        <span style={{ opacity: 0.7 }}>
          {teams} teams · {rounds} rounds · pick {Math.min(count + 1, total)} of {total}
        </span>
        <button onClick={() => setPlaying((v) => !v)} style={btn}>{playing ? "Pause" : "Play"}</button>
        <button onClick={() => setCount((n) => Math.min(total, n + 1))} style={btn}>Step</button>
        <button onClick={() => { setPlaying(false); setCount(0); }} style={btn}>Reset</button>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          every
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={sel}>
            <option value={1500}>1.5 s</option>
            <option value={4000}>4 s</option>
            <option value={8000}>8 s</option>
            <option value={20000}>20 s</option>
          </select>
        </label>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <select value={format} onChange={(e) => setFormat(e.target.value as CopyFormat)} style={sel} title="What the clipboard looks like">
            <option value="lines">copy: one field per line</option>
            <option value="tabs">copy: one row per line (tabs)</option>
            <option value="names">copy: names only (no labels)</option>
          </select>
          <button onClick={copy} style={btn}>{copied ? "Copied" : "Copy board"}</button>
        </span>
      </div>

      <div ref={gridRef} data-mock-grid style={{ overflow: "auto", height: "calc(100dvh - 42px)", padding: 4, background: "#141414" }}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${teams}, minmax(0, 1fr))`, gap: 3, minWidth: teams * 96, zoom }}>
          {header &&
            counts.map((n, i) => (
              <div key={`h${i}`} style={{ background: "#2a2a2e", borderRadius: 4, padding: "5px 6px", fontSize: 11, fontWeight: 700, textAlign: "center", color: "#ddd" }}>
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
            ))}
          {byRound.map((row, ri) =>
            row.map((c, ci) => {
              const round = ri + 1;
              const pick = round % 2 === 1 ? ci + 1 : teams - ci;
              const overall = (round - 1) * teams + pick;
              if (!c) {
                return (
                  <div key={`${ri}-${ci}`} style={{ ...cellBase, background: "#fff" }}>
                    <div style={labelRow}>
                      <span style={{ fontWeight: 700 }}>{round}.{pick}</span>
                    </div>
                    {showOverall && <div style={{ fontSize: 11, color: "#9aa3ad" }}>{overall}</div>}
                  </div>
                );
              }
              const p = c.player;
              return (
                <div key={`${ri}-${ci}`} data-overall={c.overall} style={{ ...cellBase, background: CELL_BG[p.pos] }}>
                  <div style={labelRow}>
                    <span style={{ fontWeight: 700 }}>{c.round}.{c.pick}</span>
                    <span style={{ color: "#5b6470" }}>{c.round % 2 === 1 ? "→" : "←"}</span>
                  </div>
                  {/* The photo zone: the gray overall pick sits at its left; the name always starts below it. */}
                  <div style={{ height: 24, fontSize: 11, color: "#6b7480", lineHeight: "12px" }}>{showOverall ? c.overall : ""}</div>
                  {p.ids?.espn ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- remote CDN, mirrors the real board */
                    <img
                      src={`https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${p.ids.espn}.png&w=96&h=70`}
                      alt=""
                      width={44}
                      height={32}
                      loading="lazy"
                      style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", width: 44, height: 32, objectFit: "cover", borderRadius: "50%", background: "#d9dde2" }}
                    />
                  ) : (
                    <span style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", width: 32, height: 32, borderRadius: "50%", background: "#d9dde2" }} />
                  )}
                  <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "16px" }}>
                    {abbreviateName(p.name, p.pos)}
                  </div>
                  <div style={{ fontSize: 10, color: "#3b4450", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "12px" }}>
                    {p.pos} {p.team}
                    {p.bye ? ` (BYE ${p.bye})` : ""}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {/* Ground truth for the OCR harness (scripts/ocr-grid-check.ts). */}
      <script id="mock-truth" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ teams, rounds, picks: truth }) }} />
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
};
const labelRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 11, lineHeight: "13px" };
const btn: React.CSSProperties = { background: "#2d333b", color: "#fff", border: "1px solid #444c56", borderRadius: 4, padding: "3px 9px", fontSize: 12, cursor: "pointer" };
const sel: React.CSSProperties = { background: "#2d333b", color: "#fff", border: "1px solid #444c56", borderRadius: 4, padding: "2px 4px", fontSize: 12 };
