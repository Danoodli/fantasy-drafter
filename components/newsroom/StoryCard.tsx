"use client";

// One card per player: the update that matters most leads; every other
// report (other outlets, the bot re-posts, the injury-table note) folds
// underneath so five near-identical posts read as one story, not five cards.

import { useState } from "react";
import type { BoardPlayer } from "../../lib/types";
import { POS_COLOR } from "../../lib/client/pos";
import { KIND_LABEL, type FeedItem, type PlayerStory } from "../../lib/engine/newsImportance";
import InjuryBadge from "../InjuryBadge";
import Headshot from "./Headshot";
import { KIND_TONE, ago } from "./feedUi";

function Meta({ item, now, color }: { item: FeedItem; now: number | null; color: string }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-faint">
      <span className="text-ink-dim">{item.source}</span>
      <span title={new Date(item.published).toLocaleString()}>{now != null ? ago(now - Date.parse(item.published)) : ""}</span>
      {item.href && (
        <a href={item.href} target="_blank" rel="noreferrer" className="rounded border px-2 py-0.5 hover:bg-panel-2" style={{ borderColor: color, color }}>
          Read the post ↗
        </a>
      )}
    </span>
  );
}

export default function StoryCard({
  story,
  player,
  now,
  onOpen,
}: {
  story: PlayerStory;
  player: BoardPlayer | undefined;
  now: number | null;
  onOpen: (p: BoardPlayer) => void;
}) {
  const [open, setOpen] = useState(false);
  const color = POS_COLOR[story.pos];
  const { lead } = story;
  const rest = story.items.filter((f) => f.id !== lead.id);
  const otherSources = story.sources.filter((s) => s !== lead.source);
  return (
    <li
      className="lift grid grid-cols-[3px_auto_1fr] gap-3 rounded-xl bg-panel p-3"
      style={{ boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} ${Math.round(12 + 30 * Math.min(1, story.importance))}%, transparent)` }}
    >
      <span className="self-stretch rounded-full" style={{ background: color, opacity: 0.3 + 0.7 * Math.min(1, story.importance) }} title={`importance ${story.importance.toFixed(2)}`} />
      {player ? (
        <button onClick={() => onOpen(player)} className="self-start rounded-full" aria-label={`Open ${story.name}'s card`}>
          <Headshot player={player} size={52} />
        </button>
      ) : (
        <span className="w-[52px]" />
      )}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button onClick={() => player && onOpen(player)} className="font-display text-xl font-bold uppercase leading-none tracking-wide hover:underline" style={{ color }}>
            {story.name}
          </button>
          <span className="font-mono text-[11px] text-ink-dim">
            {story.pos} · {story.team} · ADP {story.adp.toFixed(1)}
          </span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${KIND_TONE[lead.kind]}`}>{KIND_LABEL[lead.kind]}</span>
          {lead.statusChange && <InjuryBadge injury={lead.statusChange.to ?? "cleared"} />}
        </div>
        <p className="mt-1.5 text-sm leading-snug">{lead.headline}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Meta item={lead} now={now} color={color} />
          {player && (
            <button onClick={() => onOpen(player)} className="rounded border border-line px-2 py-0.5 font-mono text-xs text-ink-dim hover:border-ink hover:text-ink">
              Player card
            </button>
          )}
          {rest.length > 0 && (
            <button
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="rounded bg-panel-2 px-2 py-0.5 font-mono text-xs text-ink-dim hover:text-ink"
            >
              {open ? "Hide" : `${rest.length} more`} {rest.length === 1 ? "report" : "reports"}
              {!open && otherSources.length > 0 && <span className="text-ink-faint"> · {otherSources.slice(0, 3).join(", ")}{otherSources.length > 3 ? "…" : ""}</span>}
            </button>
          )}
        </div>
        {open && rest.length > 0 && (
          <ol className="mt-3 flex flex-col gap-2 border-l border-line/70 pl-3">
            {rest.map((f) => (
              <li key={f.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${KIND_TONE[f.kind]}`}>{KIND_LABEL[f.kind]}</span>
                  {f.statusChange && <InjuryBadge injury={f.statusChange.to ?? "cleared"} />}
                </div>
                <p className="mt-1 leading-snug">{f.headline}</p>
                <div className="mt-1">
                  <Meta item={f} now={now} color={color} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}
