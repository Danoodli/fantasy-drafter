"use client";

// One row, every seat: what each team has built so far, who is on the clock,
// where I sit. This is the "board view" every real draft room has and the
// cockpit lacked — in manual mode it doubles as a sanity check that picks
// landed on the right teams. Click a seat to see its roster.

import { useState } from "react";
import type { BoardPlayer, Position } from "../lib/types";
import { POS_COLOR } from "../lib/client/pos";

interface Props {
  teams: number;
  mySlot: number;
  onClockSlot: number;
  draftOver: boolean;
  /** Every seat's roster by slot, mine included. */
  rosters: Record<number, BoardPlayer[]>;
  /** Slot → the next pick number that seat owns (for the tooltip). */
  nextPickBySlot: Record<number, number | undefined>;
  onOpen: (player: BoardPlayer) => void;
}

const SHOW_POS: Position[] = ["QB", "RB", "WR", "TE"];

export default function RoomStrip({ teams, mySlot, onClockSlot, draftOver, rosters, nextPickBySlot, onOpen }: Props) {
  const [openSlot, setOpenSlot] = useState<number | null>(null);

  return (
    <div data-tour="room" className="relative mt-2">
      <ol className="flex gap-1 overflow-x-auto pb-0.5" aria-label="Draft room">
        {Array.from({ length: teams }, (_, i) => i + 1).map((slot) => {
          const roster = rosters[slot] ?? [];
          const counts: Partial<Record<Position, number>> = {};
          for (const p of roster) counts[p.pos] = (counts[p.pos] ?? 0) + 1;
          const onClock = !draftOver && slot === onClockSlot;
          const mine = slot === mySlot;
          const open = openSlot === slot;
          return (
            <li key={slot} className="shrink-0">
              <button
                onClick={() => setOpenSlot(open ? null : slot)}
                aria-expanded={open}
                title={`Slot ${slot}${mine ? " (you)" : ""}${nextPickBySlot[slot] ? ` · next pick ${nextPickBySlot[slot]}` : ""}`}
                className={`flex min-w-[72px] flex-col items-start rounded border px-1.5 py-1 text-left ${
                  onClock
                    ? "on-the-clock border-transparent bg-panel-2"
                    : open
                      ? "border-line bg-panel-2"
                      : "border-transparent bg-panel hover:bg-panel-2"
                }`}
                style={onClock ? { ["--pulse-color" as string]: "var(--color-warn)" } : undefined}
              >
                <span className={`font-mono text-[10px] uppercase tracking-wide ${mine ? "text-rb" : onClock ? "text-warn" : "text-ink-faint"}`}>
                  {mine ? "you" : `s${slot}`}
                  {onClock && <span className="ml-1">●</span>}
                </span>
                <span className="mt-0.5 flex gap-1 font-mono text-[11px] leading-none">
                  {SHOW_POS.map((pos) => (
                    <span key={pos} style={{ color: POS_COLOR[pos] }} className={counts[pos] ? "" : "opacity-30"}>
                      {pos[0]}{counts[pos] ?? 0}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {openSlot != null && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-line bg-panel-2 p-3 shadow-xl">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
              Slot {openSlot}{openSlot === mySlot ? " · you" : ""}
            </p>
            <button onClick={() => setOpenSlot(null)} aria-label="Close" className="font-mono text-xs text-ink-faint hover:text-ink">
              ✕
            </button>
          </div>
          {(rosters[openSlot] ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-ink-faint">No picks yet.</p>
          ) : (
            <ul className="mt-2 space-y-0.5">
              {(rosters[openSlot] ?? []).map((p, i) => (
                <li key={`${p.id}-${i}`} className="flex items-baseline gap-2 text-sm">
                  <span className="w-6 shrink-0 font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>
                  <button onClick={() => onOpen(p)} className="truncate hover:underline">{p.name}</button>
                  <span className="ml-auto font-mono text-[10px] text-ink-faint">{p.team}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
