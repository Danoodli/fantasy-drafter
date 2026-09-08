"use client";

// A stand-in for DraftKings' draft BOARD view, so screen sync and paste import
// can be exercised without a live room. It draws the same DraftBoardGrid the
// cockpit's Board view draws, fed by a seeded simulated room, and its "Copy
// board" button puts the grid on the clipboard the way a browser copies the
// real one (row by row). Open it in a second tab, share that tab with Screen
// sync in the cockpit, press Play, and watch the picks land.
//
// Test fixture, not product: it never touches the engine or the draft state.
// URL options: teams, rounds, picks (already made), autoplay=1, speed (ms),
// seed, overall=0 (hide the gray overall pick under the label — some
// DraftKings boards do), zoom (1.7 shows ~7 columns like a zoomed-in room),
// header=0 (drop the position-count header).

import { useEffect, useMemo, useState } from "react";
import type { Board, BoardPlayer, DraftPick } from "../lib/types";
import { abbreviateName } from "../lib/draft/boardLayout";
import { slotOnClock } from "../lib/draft/snake";
import DraftBoardGrid from "./DraftBoardGrid";

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

/** Simulate the room: ADP order with a little seeded noise; K/DST only in the last rounds. */
function simulate(players: BoardPlayer[], count: number, teams: number, rounds: number, seed: number): DraftPick[] {
  const rng = mulberry32(seed);
  const pool = [...players].filter((p) => Number.isFinite(p.adp)).sort((a, b) => a.adp - b.adp);
  const taken = new Set<string>();
  const out: DraftPick[] = [];
  const total = Math.min(count, teams * rounds);
  for (let pickNo = 1; pickNo <= total; pickNo++) {
    const { round, slot } = slotOnClock(pickNo, teams, "snake");
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
    const player = window[Math.min(window.length - 1, Math.floor(r * r * window.length))];
    taken.add(player.id);
    out.push({ playerId: player.id, playerName: player.name, pos: player.pos, pickNo, round, draftSlot: slot, isKeeper: false, byMe: false });
  }
  return out;
}

export type CopyFormat = "lines" | "tabs" | "names";

/** What a browser puts on the clipboard when the board is selected and copied: cells in screen order. */
export function boardClipboard(picks: DraftPick[], byId: Map<string, BoardPlayer>, teams: number, format: CopyFormat): string {
  const rows = new Map<number, (DraftPick | null)[]>();
  for (const p of picks) {
    if (!rows.has(p.round)) rows.set(p.round, Array.from({ length: teams }, () => null));
    rows.get(p.round)![p.draftSlot - 1] = p;
  }
  const text = (p: DraftPick): string[] => {
    const pl = byId.get(p.playerId);
    const pickInRound = p.pickNo - (p.round - 1) * teams;
    return [`${p.round}.${pickInRound}`, String(p.pickNo), abbreviateName(p.playerName, p.pos), `${p.pos ?? ""} ${pl?.team ?? ""}${pl?.bye ? ` (BYE ${pl.bye})` : ""}`.trim()];
  };
  const lines: string[] = [];
  for (const round of [...rows.keys()].sort((a, b) => a - b)) {
    const present = rows.get(round)!.filter((c): c is DraftPick => c != null);
    if (format === "tabs") lines.push(present.map((c) => text(c).join("\t")).join("\t"));
    else if (format === "names") for (const c of present) lines.push(abbreviateName(c.playerName, c.pos));
    else for (const c of present) lines.push(...text(c));
  }
  return lines.join("\n");
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

  const byId = useMemo(() => new Map((players ?? []).map((p) => [p.id, p])), [players]);
  const picks = useMemo(() => (players ? simulate(players, count, teams, rounds, seed) : []), [players, count, teams, rounds, seed]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(boardClipboard(picks, byId, teams, format));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const truth = picks.map((p) => ({ pickNo: p.pickNo, round: p.round, pick: p.pickNo - (p.round - 1) * teams, id: p.playerId, name: p.playerName }));

  return (
    <div style={{ background: "#141414", color: "#111", minHeight: "100dvh", fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif' }}>
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

      <DraftBoardGrid
        teams={teams}
        rounds={rounds}
        order="snake"
        picks={picks}
        byId={byId}
        currentPick={Math.min(count + 1, total)}
        showOverall={showOverall}
        showHeader={header}
        headerLabel={null}
        zoom={zoom}
        style={{ height: "calc(100dvh - 42px)" }}
        containerProps={{ "data-mock-grid": "" }}
      />
      {/* Ground truth for the OCR harness (scripts/ocr-grid-check.ts). */}
      <script id="mock-truth" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ teams, rounds, picks: truth }) }} />
    </div>
  );
}

const btn: React.CSSProperties = { background: "#2d333b", color: "#fff", border: "1px solid #444c56", borderRadius: 4, padding: "3px 9px", fontSize: 12, cursor: "pointer" };
const sel: React.CSSProperties = { background: "#2d333b", color: "#fff", border: "1px solid #444c56", borderRadius: 4, padding: "2px 4px", fontSize: 12 };
