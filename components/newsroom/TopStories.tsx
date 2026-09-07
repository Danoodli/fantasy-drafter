"use client";

// The flashes: the handful of updates that change a draft, as trading-card
// sized stories on position-colored fields with the player's cutout.

import type { BoardPlayer } from "../../lib/types";
import { POS_COLOR } from "../../lib/client/pos";
import { KIND_LABEL, type FeedItem } from "../../lib/engine/newsImportance";
import { headshotUrl, teamLogoUrl } from "./Headshot";
import { KIND_TONE, ago } from "./feedUi";

export default function TopStories({
  stories,
  byId,
  now,
  onOpen,
}: {
  stories: FeedItem[];
  byId: Map<string, BoardPlayer>;
  now: number | null;
  onOpen: (p: BoardPlayer) => void;
}) {
  if (stories.length === 0) return null;
  return (
    <section aria-label="Top stories">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight">Top stories</h2>
        <span className="font-mono text-xs text-ink-faint">the updates that move a draft · last 48 h</span>
      </div>
      <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {stories.map((s, i) => {
          const p = byId.get(s.playerId);
          const color = POS_COLOR[s.pos];
          const lead = i === 0;
          const shot = headshotUrl(p?.ids.espn);
          const ageMs = now != null ? now - Date.parse(s.published) : null;
          const justIn = ageMs != null && ageMs < 20 * 60_000;
          return (
            <article
              key={s.id}
              className={`story-card lift rounded-2xl p-4 ${lead ? "is-lead sm:col-span-2 lg:col-span-2 min-h-[260px]" : "min-h-[210px]"}`}
              style={{
                background: `radial-gradient(120% 120% at 100% 100%, color-mix(in srgb, ${color} 42%, var(--color-panel)) 0%, var(--color-panel) 58%)`,
                boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 40%, transparent)`,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- remote CDN */}
              <img className="story-logo" src={teamLogoUrl(s.team)} alt="" loading="lazy" />
              {shot && (
                /* eslint-disable-next-line @next/next/no-img-element -- remote CDN */
                <img
                  className="story-shot"
                  src={shot}
                  alt=""
                  loading={lead ? "eager" : "lazy"}
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                />
              )}
              <div className={`relative z-10 flex h-full flex-col ${lead ? "max-w-[64%]" : "max-w-[62%]"}`}>
                <p className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
                  <span className={`rounded px-1.5 py-0.5 ${KIND_TONE[s.kind]}`}>{KIND_LABEL[s.kind]}</span>
                  {justIn ? (
                    <span className="flex items-center gap-1 text-live">
                      <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-live" /> just in
                    </span>
                  ) : (
                    <span className="text-ink-faint">{ageMs != null ? ago(ageMs) : ""}</span>
                  )}
                </p>
                <button
                  onClick={() => p && onOpen(p)}
                  className={`mt-2 text-left font-display font-bold uppercase leading-[0.95] tracking-tight hover:underline ${lead ? "text-5xl" : "text-3xl"}`}
                  style={{ color }}
                >
                  {s.name}
                </button>
                <p className="mt-1 font-mono text-[11px] text-ink-dim">
                  {s.pos} · {s.team} · ADP {s.adp.toFixed(1)}
                </p>
                <p className={`mt-2 leading-snug ${lead ? "text-base" : "line-clamp-3 text-sm"}`}>{s.headline}</p>
                <p className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 font-mono text-xs">
                  <span className="text-ink-dim">{s.source}</span>
                  {s.href && (
                    <a
                      href={s.href}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border px-2 py-0.5 hover:bg-panel-2"
                      style={{ borderColor: color, color }}
                    >
                      Read the post ↗
                    </a>
                  )}
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
