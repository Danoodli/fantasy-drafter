"use client";

// The tier board lives in peripheral vision. Tier breaks are the thing the
// eye should catch without reading — hard rules between bands, position
// color at the column head. Click any row to mark a player drafted.

import { memo } from "react";
import type { BoardPlayer, Position } from "../lib/types";
import { POS_COLOR, POS_ORDER } from "../lib/client/pos";

interface Props {
  players: BoardPlayer[];
  draftedIds: Set<string>;
  myIds: Set<string>;
  onMark: (player: BoardPlayer) => void;
}

const DEPTH: Record<Position, number> = { QB: 18, RB: 36, WR: 36, TE: 16, K: 8, DST: 8 };

function Column({ pos, players, draftedIds, myIds, onMark }: Props & { pos: Position }) {
  const group = players
    .filter((p) => p.pos === pos)
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
              <button
                onClick={() => !drafted && onMark(p)}
                disabled={drafted}
                title={drafted ? undefined : `Mark ${p.name} drafted`}
                className={`flex w-full items-baseline gap-1.5 px-2 py-0.5 text-left text-[13px] leading-5 ${
                  drafted
                    ? "text-ink-faint line-through"
                    : "text-ink hover:bg-panel"
                } ${mine ? "border-l-2 bg-panel" : "border-l-2 border-transparent"}`}
                style={mine ? { borderLeftColor: color } : undefined}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
                <span className="font-mono text-[11px] text-ink-dim">
                  {Math.round(p.projPoints)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TierBoard(props: Props) {
  return (
    <div className="tier-scroll flex h-full gap-2 overflow-x-auto overflow-y-auto pb-4">
      {POS_ORDER.map((pos) => (
        <Column key={pos} pos={pos} {...props} />
      ))}
    </div>
  );
}

export default memo(TierBoard);
