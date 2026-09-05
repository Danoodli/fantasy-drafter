"use client";

// When it is NOT my turn: who the seat on the clock is most likely to take,
// as one-click chips. The engine runs for THEIR roster and THEIR picks — the
// same objective it uses for me — so the list follows the room as it fills.
// Marking from here is the fast path in manual mode; the running hit rate
// says how often the real pick was on the list, so you can judge it.

import type { BoardPlayer, Position } from "../lib/types";
import { POS_COLOR } from "../lib/client/pos";

interface Props {
  slot: number;
  pickNo: number;
  players: BoardPlayer[];
  /** Position counts the seat already holds, for the caption. */
  counts: Partial<Record<Position, number>>;
  /** Picks marked from outside the shortlist that were / weren't on it. */
  hits: number;
  misses: number;
  onMark: (player: BoardPlayer) => void;
  onOpen: (player: BoardPlayer) => void;
}

const SHOW_POS: Position[] = ["QB", "RB", "WR", "TE"];

export default function Shortlist({ slot, pickNo, players, counts, hits, misses, onMark, onOpen }: Props) {
  if (players.length === 0) return null;
  const tries = hits + misses;
  return (
    <div data-tour="shortlist" className="lift rounded-lg bg-panel p-3">
      <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs uppercase tracking-widest text-ink-dim">
        <span>
          Likely for slot {slot} · pick {pickNo}
        </span>
        <span className="normal-case tracking-normal text-ink-faint">
          has{" "}
          {SHOW_POS.map((pos) => (
            <span key={pos} style={{ color: POS_COLOR[pos] }} className="mr-1">
              {pos[0]}{counts[pos] ?? 0}
            </span>
          ))}
        </span>
        {tries > 0 && (
          <span className="ml-auto normal-case tracking-normal text-ink-faint" title="How often the real pick was on this list">
            hit {hits}/{tries}
          </span>
        )}
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {players.map((p, i) => (
          <li key={p.id} className="flex items-stretch overflow-hidden rounded border border-line bg-panel-2">
            <button
              onClick={() => onOpen(p)}
              title={`${p.name} — card`}
              className="flex items-baseline gap-1.5 px-2 py-1 text-left text-sm hover:bg-panel"
            >
              <span className="font-mono text-[10px] text-ink-faint">{i + 1}</span>
              <span className="font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>
              <span>{p.name}</span>
              <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
            </button>
            <button
              onClick={() => onMark(p)}
              aria-label={`Mark ${p.name} drafted by slot ${slot}`}
              title="Mark him gone"
              className="border-l border-line px-2 font-mono text-xs text-ink-dim hover:bg-warn/15 hover:text-warn"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
