"use client";

// The last few picks in the room, newest first — the sync check for manual
// mode ("did I miss one?") and the play-by-play in Sleeper mode. Manual marks
// carry a ✕ to remove them; an unknown placeholder can be filled in by name.
// Manual-mode tools live here too: add an unknown pick, or jump the counter
// to the pick the real draft room says it is on.

import { useState } from "react";
import type { BoardPlayer, DraftPick } from "../lib/types";
import { POS_COLOR } from "../lib/client/pos";

interface Props {
  picks: DraftPick[];
  currentPick: number;
  totalPicks: number;
  mySlot: number;
  byId: Map<string, BoardPlayer>;
  /** Manual-mode tools show when the room is not syncing itself. */
  manual: boolean;
  onOpen: (player: BoardPlayer) => void;
  onRemove: (manualIndex: number) => void;
  onFillUnknown: (manualIndex: number, pickNo: number) => void;
  onUnknown: () => void;
  onSetPick: (pickNo: number) => void;
}

const SHOW = 6;

export default function RecentPicks({
  picks,
  currentPick,
  totalPicks,
  mySlot,
  byId,
  manual,
  onOpen,
  onRemove,
  onFillUnknown,
  onUnknown,
  onSetPick,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const recent = picks.slice(-SHOW).reverse();

  return (
    <div
      data-tour="recent"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-panel px-3 py-1.5"
      aria-label="Recent picks"
    >
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Recent</span>
      {recent.length === 0 && (
        <span className="text-xs text-ink-faint">No picks yet.</span>
      )}
      <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {recent.map((pick) => {
          const player = pick.playerId ? byId.get(pick.playerId) : undefined;
          const mine = pick.draftSlot === mySlot;
          const unknown = !pick.playerId;
          return (
            <li key={`${pick.pickNo}-${pick.playerId}`} className="flex items-baseline gap-1.5 text-sm">
              <span className={`font-mono text-[11px] ${mine ? "text-rb" : "text-ink-faint"}`}>
                {pick.pickNo}
                <span className="text-ink-faint">·s{pick.draftSlot}</span>
              </span>
              {unknown ? (
                <button
                  onClick={() => pick.manualIndex != null && onFillUnknown(pick.manualIndex, pick.pickNo)}
                  className="italic text-ink-dim underline decoration-dotted underline-offset-2 hover:text-ink"
                  title="Unknown pick — click to fill in who it was"
                >
                  unknown
                </button>
              ) : (
                <>
                  <span className="font-mono text-[10px]" style={{ color: POS_COLOR[pick.pos ?? "DST"] }}>
                    {pick.pos ?? ""}
                  </span>
                  {player ? (
                    <button onClick={() => onOpen(player)} className="truncate hover:underline">
                      {player.name}
                    </button>
                  ) : (
                    <span className="truncate text-ink-dim">{pick.playerName}</span>
                  )}
                </>
              )}
              {pick.manualIndex != null && (
                <button
                  onClick={() => onRemove(pick.manualIndex!)}
                  aria-label={`Remove pick ${pick.pickNo}`}
                  title="Remove this mark"
                  className="font-mono text-[11px] text-ink-faint hover:text-warn"
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {manual && currentPick <= totalPicks && (
        <div className="flex items-center gap-2">
          <button
            onClick={onUnknown}
            title="Someone took a player you can't find — advance the counter without naming him"
            className="rounded border border-line bg-panel-2 px-2 py-0.5 text-xs text-ink-dim hover:text-ink"
          >
            + unknown pick
          </button>
          {editing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(value);
                if (Number.isInteger(n) && n >= 1 && n <= totalPicks + 1) onSetPick(n);
                setEditing(false);
                setValue("");
              }}
            >
              <label className="sr-only" htmlFor="set-pick">Current pick number</label>
              <input
                id="set-pick"
                autoFocus
                inputMode="numeric"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
                placeholder={String(currentPick)}
                className="w-14 rounded border border-line bg-field px-1.5 py-0.5 font-mono text-xs"
              />
              <button type="submit" className="rounded bg-panel-2 px-2 py-0.5 text-xs font-semibold">
                Set
              </button>
            </form>
          ) : (
            <button
              onClick={() => setEditing(true)}
              title="The draft room says it's a different pick — jump the counter there"
              className="rounded border border-line bg-panel-2 px-2 py-0.5 text-xs text-ink-dim hover:text-ink"
            >
              set pick #
            </button>
          )}
        </div>
      )}
    </div>
  );
}
