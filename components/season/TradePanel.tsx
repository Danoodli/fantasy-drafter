"use client";

import { useMemo, useState } from "react";
import type { BoardPlayer } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { evaluateTrade, type TradeLeagueContext, type TradeVerdict } from "../../lib/engine/season/trade";
import type { RosContext } from "../../lib/engine/season/rosValue";
import { POS_COLOR } from "../../lib/client/pos";

const VERDICT_CLASS = { up: "text-rb", down: "text-qb", flat: "text-ink-dim" } as const;

export default function TradePanel({
  roster, board, ctx, league,
}: {
  roster: BoardPlayer[];
  board: BoardPlayer[];
  ctx: Omit<RosContext, "outlooks"> & { outlooks: Map<string, WeekOutlook> };
  league: TradeLeagueContext | null;
}) {
  const [give, setGive] = useState<Set<string>>(new Set());
  const [receive, setReceive] = useState<BoardPlayer[]>([]);
  const [query, setQuery] = useState("");
  const [verdict, setVerdict] = useState<TradeVerdict | null>(null);

  const onRoster = useMemo(() => new Set(roster.map((p) => p.id)), [roster]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return board.filter((p) => p.name.toLowerCase().includes(q) && !onRoster.has(p.id) && !receive.some((r) => r.id === p.id)).slice(0, 6);
  }, [query, board, onRoster, receive]);

  function evaluate() {
    setVerdict(evaluateTrade({ ...ctx, roster, give: [...give], receive, league: league ?? undefined }));
  }

  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">Trade</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-ink-faint">You give</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {roster.map((p) => (
              <li key={p.id} className="hover:bg-panel">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={give.has(p.id)} onChange={(e) => setGive((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                  <span className="font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>{p.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs text-ink-faint">You receive</p>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a player by name…" className="mt-1 w-full rounded border border-line bg-field px-2 py-1 text-sm" />
          {matches.length > 0 && (
            <ul className="mt-1 rounded border border-line text-sm">
              {matches.map((p) => (
                <li key={p.id}><button onClick={() => { setReceive((r) => [...r, p]); setQuery(""); }} className="w-full px-2 py-1 text-left hover:bg-panel">{p.name} <span style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span> <span className="text-ink-faint">· {p.team}</span></button></li>
              ))}
            </ul>
          )}
          <ul className="mt-1 flex flex-wrap gap-1">
            {receive.map((p) => (
              <li key={p.id} className="rounded bg-panel px-2 py-0.5 text-xs">
                <span style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span> {p.name}
                <button onClick={() => setReceive((r) => r.filter((x) => x.id !== p.id))} className="ml-1 text-ink-faint hover:text-ink" aria-label={`Remove ${p.name}`}>×</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {/* Accent CTAs keep their colour on hover (PasteImport/Setup precedent); a bg-panel hover would read as disabled. */}
      <button onClick={evaluate} disabled={give.size === 0 && receive.length === 0} className="mt-3 rounded bg-rb px-4 py-2 text-sm font-semibold text-field hover:brightness-110 disabled:opacity-40">Evaluate</button>
      {verdict && (
        <div className="mt-3 text-sm">
          <p>{verdict.summary}</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 text-xs">
            <li className={VERDICT_CLASS[verdict.points.verdict]}>Points {verdict.points.delta >= 0 ? "+" : ""}{verdict.points.delta.toFixed(0)}</li>
            <li className={verdict.playoffOdds ? VERDICT_CLASS[verdict.playoffOdds.verdict] : "text-ink-faint"}>Playoff odds {verdict.playoffOdds ? `${verdict.playoffOdds.delta >= 0 ? "+" : ""}${(verdict.playoffOdds.delta * 100).toFixed(0)} pts` : "— (no league synced)"}</li>
            <li className={VERDICT_CLASS[verdict.cover.verdict]}>Cover {verdict.cover.delta >= 0 ? "+" : ""}{verdict.cover.delta.toFixed(0)} slot-weeks</li>
          </ul>
        </div>
      )}
    </section>
  );
}
