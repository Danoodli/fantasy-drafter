"use client";

import type { BoardPlayer } from "../../lib/types";
import { POS_COLOR } from "../../lib/client/pos";
import { KIND_LABEL, type FeedItem } from "../../lib/engine/newsImportance";
import InjuryBadge from "../InjuryBadge";
import Headshot from "./Headshot";
import { KIND_TONE, ago } from "./feedUi";

export default function FeedCard({
  item,
  player,
  now,
  onOpen,
}: {
  item: FeedItem;
  player: BoardPlayer | undefined;
  now: number | null;
  onOpen: (p: BoardPlayer) => void;
}) {
  const color = POS_COLOR[item.pos];
  return (
    <li
      className="lift grid grid-cols-[3px_auto_1fr] gap-3 rounded-xl bg-panel p-3"
      style={{ boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} ${Math.round(12 + 30 * Math.min(1, item.importance))}%, transparent)` }}
    >
      <span className="self-stretch rounded-full" style={{ background: color, opacity: 0.3 + 0.7 * Math.min(1, item.importance) }} title={`importance ${item.importance.toFixed(2)}`} />
      {player ? (
        <button onClick={() => onOpen(player)} className="self-start rounded-full" aria-label={`Open ${item.name}'s card`}>
          <Headshot player={player} size={46} />
        </button>
      ) : (
        <span className="w-[46px]" />
      )}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button onClick={() => player && onOpen(player)} className="font-display text-xl font-bold uppercase leading-none tracking-wide hover:underline" style={{ color }}>
            {item.name}
          </button>
          <span className="font-mono text-[11px] text-ink-dim">
            {item.pos} · {item.team} · ADP {item.adp.toFixed(1)}
          </span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${KIND_TONE[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
          {item.statusChange && <InjuryBadge injury={item.statusChange.to ?? "cleared"} />}
        </div>
        <p className="mt-1.5 text-sm leading-snug">{item.headline}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-faint">
          <span className="text-ink-dim">{item.source}</span>
          <span title={new Date(item.published).toLocaleString()}>{now != null ? ago(now - Date.parse(item.published)) : ""}</span>
          {item.href && (
            <a href={item.href} target="_blank" rel="noreferrer" className="rounded border border-line px-2 py-0.5 text-ink-dim hover:border-ink hover:text-ink">
              Read the post ↗
            </a>
          )}
          {player && (
            <button onClick={() => onOpen(player)} className="rounded border border-line px-2 py-0.5 text-ink-dim hover:border-ink hover:text-ink">
              Player card
            </button>
          )}
        </p>
      </div>
    </li>
  );
}
