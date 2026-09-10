"use client";

import { useMemo, useState } from "react";
import type { BoardPlayer } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { evaluateTrade, type TradeLeagueContext, type TradeVerdict } from "../../lib/engine/season/trade";
import type { RosContext } from "../../lib/engine/season/rosValue";
import { POS_COLOR } from "../../lib/client/pos";
import LowerThird from "../ui/LowerThird";
import Sticker from "../ui/Sticker";

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

  // The trade partner is derived, never assumed: the roster that holds EVERY
  // player being received. Zero or more than one such roster (no players
  // picked yet, or an ids-collision in a manual league) is "no partner
  // known", never a guess — this week's opponent is a different roster and
  // must not stand in for the other side of a trade.
  const partner = useMemo(() => {
    if (!league?.rosters || receive.length === 0) return null;
    const holders = league.rosters.filter((r) => receive.every((p) => r.players.includes(p.id)));
    return holders.length === 1 ? holders[0] : null;
  }, [league, receive]);

  function evaluate() {
    setVerdict(evaluateTrade({ ...ctx, roster, give: [...give], receive, league: league ? { ...league, partnerRosterId: partner?.rosterId } : undefined }));
  }

  return (
    <section className="space-y-3">
      <LowerThird headline="Trade" />
      <div className="grid gap-3 px-1 sm:grid-cols-2">
        <div>
          <p className="text-xs text-ink-faint">You give</p>
          <ul className="mt-1 space-y-1 text-sm">
            {roster.map((p) => (
              <li key={p.id}>
                <Sticker pos={p.pos} as="row">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={give.has(p.id)} onChange={(e) => setGive((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                    <span className="font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>{p.name}
                  </label>
                </Sticker>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs text-ink-faint">You receive</p>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a player" aria-label="Add a player" className="mt-1 w-full rounded bg-field px-2 py-1 text-sm" />
          {matches.length > 0 && (
            <ul className="mt-1 space-y-1 text-sm">
              {matches.map((p) => (
                <li key={p.id}>
                  <Sticker pos={p.pos} as="row" onClick={() => { setReceive((r) => [...r, p]); setQuery(""); }}>
                    {p.name} <span style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span> <span className="text-ink-faint">· {p.team}</span>
                  </Sticker>
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-1 flex flex-wrap gap-1">
            {receive.map((p) => (
              <li key={p.id}>
                <Sticker pos={p.pos} as="chip">
                  <span style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span> {p.name}
                  <button onClick={() => setReceive((r) => r.filter((x) => x.id !== p.id))} className="btn btn-quiet" aria-label={`Remove ${p.name}`}>×</button>
                </Sticker>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="px-1">
        <button onClick={evaluate} disabled={give.size === 0 && receive.length === 0} className="btn btn-accent">Evaluate</button>
      </div>
      {verdict && (
        <div className="px-1 text-sm">
          <p className="text-xs text-ink-faint">
            {partner ? `Trading with ${partner.name}` : "Free agents — the odds axis assumes no other roster changes."}
          </p>
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
