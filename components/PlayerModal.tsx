"use client";

// Click into a player: the full picture. Verdict + math-derived reasons,
// 2026 projected stat line, market data, schedule, plus live extras from
// ESPN (Rotowire note, recent headlines, last-season stats). The engine
// context stays front and center — this is a decision card, not a wiki.

import { useEffect, useState } from "react";
import type { BoardPlayer, LeagueConfig } from "../lib/types";
import { playerBlurb, type BlurbContext } from "../lib/engine/reasons";
import { fetchPlayerExtras, type PlayerExtras } from "../lib/client/espnPlayer";
import { POS_COLOR } from "../lib/client/pos";
import InjuryBadge from "./InjuryBadge";

interface Props {
  player: BoardPlayer;
  ctx: BlurbContext;
  config: LeagueConfig;
  drafted: boolean;
  /** True when this player was marked manually — a mistype can be undone. */
  canUnmark: boolean;
  myTurn: boolean;
  onMark: (player: BoardPlayer, mine: boolean) => void;
  onUnmark: (player: BoardPlayer) => void;
  onClose: () => void;
}

const VERDICT_COLOR: Record<string, string> = {
  perfect: "var(--color-rb)",
  good: "var(--color-rb)",
  fair: "var(--color-ink-dim)",
  bad: "var(--color-warn)",
  horrible: "var(--color-qb)",
};

function StatCell({ label, value }: { label: string; value: number | string | undefined }) {
  if (value == null) return null;
  return (
    <div className="rounded bg-field px-2 py-1.5 text-center">
      <p className="font-mono text-base text-ink">{typeof value === "number" ? Math.round(value) : value}</p>
      <p className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">{label}</p>
    </div>
  );
}

export default function PlayerModal({ player: p, ctx, config, drafted, canUnmark, myTurn, onMark, onUnmark, onClose }: Props) {
  const [extras, setExtras] = useState<PlayerExtras | null | "loading">("loading");
  const blurb = playerBlurb(p, ctx);
  const color = POS_COLOR[p.pos];

  useEffect(() => {
    let cancelled = false;
    // Even the no-espn-id branch resolves asynchronously so the effect only
    // ever sets state from a callback (external-data sync, not render logic).
    const load = p.ids.espn ? fetchPlayerExtras(p.ids.espn) : Promise.resolve(null);
    load.then((e) => !cancelled && setExtras(e));
    return () => {
      cancelled = true;
    };
  }, [p.ids.espn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const s = p.stats;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-field/80 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${p.name} details`}
    >
      <div
        className="w-full max-w-lg rounded-xl border-l-4 border border-line bg-panel p-5 shadow-2xl"
        style={{ borderLeftColor: color }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-4xl font-bold uppercase leading-none" style={{ color }}>
              {p.name}
            </h2>
            <p className="mt-1.5 flex items-center gap-1.5 font-mono text-sm text-ink-dim">
              <span style={{ color }}>{p.pos}</span> · {p.team} · bye {p.bye ?? "—"} · tier {p.tier}
              <InjuryBadge injury={p.injury} />
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="font-mono text-lg text-ink-faint hover:text-ink">
            ✕
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span
            className="rounded px-2 py-0.5 font-mono text-xs font-semibold uppercase tracking-wide text-field"
            style={{ background: VERDICT_COLOR[blurb.verdict] }}
          >
            {blurb.verdict} at pick {ctx.currentPick}
          </span>
          <span className="font-mono text-xs uppercase text-ink-dim">{blurb.risk}</span>
        </div>
        <ul className="mt-2 space-y-1 text-sm text-ink">
          {blurb.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>

        {/* 2026 projection */}
        <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
          2026 projection · {Math.round(p.projPoints)} pts · VORP {Math.round(p.vorp)}
        </p>
        <div className="mt-1.5 grid grid-cols-4 gap-1.5 sm:grid-cols-5">
          <StatCell label="Pass yds" value={s?.passYds} />
          <StatCell label="Pass TD" value={s?.passTD} />
          <StatCell label="INT" value={s?.passInt} />
          <StatCell label="Rush yds" value={s?.rushYds} />
          <StatCell label="Rush TD" value={s?.rushTD} />
          <StatCell label="Rec" value={s?.receptions} />
          <StatCell label="Rec yds" value={s?.recYds} />
          <StatCell label="Rec TD" value={s?.recTD} />
          <StatCell label="ADP" value={p.adp.toFixed(1)} />
          <StatCell label="ADP range" value={`${p.adpHigh}–${p.adpLow}`} />
          <StatCell label="ECR" value={p.ecr != null ? p.ecr.toFixed(0) : undefined} />
          {p.sosPlayoff != null && (
            <StatCell label="Playoff SOS" value={`${Math.round(p.sosPlayoff * 100)}%`} />
          )}
        </div>

        {/* Live extras */}
        {extras === "loading" && (
          <p className="mt-4 font-mono text-xs text-ink-faint">Loading news…</p>
        )}
        {extras && extras !== "loading" && (
          <>
            {extras.rotowire && (
              <div className="mt-4 rounded bg-field p-3">
                <p className="text-sm font-semibold">{extras.rotowire.headline}</p>
                <p className="mt-1 line-clamp-4 text-[13px] leading-snug text-ink-dim">
                  {extras.rotowire.story}
                </p>
              </div>
            )}
            {extras.lastSeason && (
              <div className="mt-3">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-dim">
                  {extras.lastSeason.title}
                </p>
                <div className="tier-scroll mt-1 flex gap-1.5 overflow-x-auto">
                  {extras.lastSeason.labels.map((label, i) => (
                    <StatCell key={i} label={label} value={extras.lastSeason!.values[i]} />
                  ))}
                </div>
              </div>
            )}
            {extras.news.length > 0 && (
              <ul className="mt-3 space-y-1">
                {extras.news.map((n, i) => (
                  <li key={i} className="text-[13px] leading-snug">
                    {n.href ? (
                      <a href={n.href} target="_blank" rel="noreferrer" className="text-wr hover:underline">
                        {n.headline}
                      </a>
                    ) : (
                      n.headline
                    )}
                    {n.published && (
                      <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                        {new Date(n.published).toLocaleDateString()}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {extras === null && (
          <p className="mt-4 text-[13px] text-ink-faint">
            No live news available.{" "}
            <a
              className="text-wr hover:underline"
              href={`https://www.google.com/search?q=${encodeURIComponent(p.name + " fantasy news")}`}
              target="_blank"
              rel="noreferrer"
            >
              Search news ↗
            </a>
          </p>
        )}

        <div className="mt-5 flex gap-2">
          {!drafted && (
            <button
              onClick={() => {
                onMark(p, myTurn);
                onClose();
              }}
              className="flex-1 rounded-lg py-3 font-display text-xl font-bold uppercase text-field"
              style={{ background: color }}
            >
              {myTurn ? `Draft ${p.name.split(" ").slice(-1)[0]}` : "Mark him gone"}
            </button>
          )}
          {drafted && canUnmark && (
            <button
              onClick={() => {
                onUnmark(p);
                onClose();
              }}
              className="flex-1 rounded-lg border border-warn py-3 font-display text-xl font-bold uppercase text-warn"
            >
              Put him back
            </button>
          )}
          {drafted && !canUnmark && (
            <p className="flex-1 self-center text-sm text-ink-faint">
              Drafted via live sync — can&apos;t be undone here.
            </p>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-3 text-sm text-ink-dim hover:text-ink"
          >
            Close
          </button>
        </div>
        <p className="mt-2 text-right font-mono text-[9px] text-ink-faint">
          news &amp; last-season stats: ESPN · {config.scoring} scoring
        </p>
      </div>
    </div>
  );
}
