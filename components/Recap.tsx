"use client";

// Post-draft recap: every roster in the room, ranked by projected draft
// value, with letter grades, steals/reaches, and an in-browser season
// simulation (win rates + ceiling percentiles — the tournament numbers).
// Opens automatically when the draft ends; available any time from the
// header to check mid-draft standings.

import { useMemo, useState } from "react";
import type { Board, DraftPick, LeagueConfig, TradedPick } from "../lib/types";
import { buildRecap, gradeFor, superlatives, type TeamRecap } from "../lib/engine/recap";
import { simulateRoom, type SeasonSimResult } from "../lib/engine/season";
import { POS_COLOR } from "../lib/client/pos";

interface Props {
  board: Board;
  config: LeagueConfig;
  picks: DraftPick[];
  tradedPicks: TradedPick[];
  mySlot: number;
  draftOver: boolean;
  onClose: () => void;
}

interface SimRow {
  winRate: number;
  result: SeasonSimResult;
}

const SIMS = 300;

export default function Recap({ board, config, picks, tradedPicks, mySlot, draftOver, onClose }: Props) {
  const byId = useMemo(() => new Map(board.players.map((p) => [p.id, p])), [board]);
  const teams = useMemo(
    () => buildRecap(picks, byId, config, tradedPicks),
    [picks, byId, config, tradedPicks]
  );
  const supers = useMemo(
    () => superlatives(picks, byId, config.teams, tradedPicks),
    [picks, byId, config, tradedPicks]
  );

  const [sim, setSim] = useState<Map<number, SimRow> | null>(null);
  const [simming, setSimming] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [sortBySim, setSortBySim] = useState(false);

  function runSim() {
    setSimming(true);
    // Let the spinner paint before the ~1s of math.
    setTimeout(() => {
      const ordered = [...teams].sort((a, b) => a.slot - b.slot);
      // Fresh seed per run: simulations should feel like simulations.
      // (The engine stays seeded — determinism lives in the tests.)
      const seed = Date.now() & 0x7fffffff;
      const { winRate, results } = simulateRoom(
        ordered.map((t) => t.roster),
        config,
        SIMS,
        seed
      );
      const map = new Map<number, SimRow>();
      ordered.forEach((t, i) => map.set(t.slot, { winRate: winRate[i], result: results[i] }));
      setSim(map);
      setSortBySim(true);
      setSimming(false);
    }, 30);
  }

  const rows: TeamRecap[] = useMemo(() => {
    if (!sortBySim || !sim) return teams;
    return [...teams].sort((a, b) => (sim.get(b.slot)?.winRate ?? 0) - (sim.get(a.slot)?.winRate ?? 0));
  }, [teams, sim, sortBySim]);

  const myRank = rows.findIndex((t) => t.slot === mySlot);

  return (
    <main className="mx-auto max-w-5xl px-4 pb-10 pt-4">
      <header className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight">
          {draftOver ? "Draft recap" : "Standings so far"}
        </h1>
        <p className="text-ink-dim">
          {picks.length} picks in · you {myRank >= 0 ? `rank ${myRank + 1} of ${config.teams}` : "—"}
        </p>
        <div className="ml-auto flex gap-2">
          <button
            onClick={runSim}
            disabled={simming}
            className="rounded bg-rb px-4 py-2 font-display text-lg font-bold uppercase text-field disabled:opacity-50"
          >
            {simming ? "Simulating…" : sim ? `Re-run ${SIMS} seasons` : `Simulate ${SIMS} seasons`}
          </button>
          <button
            onClick={onClose}
            className="rounded border border-line bg-panel px-4 py-2 text-sm text-ink-dim hover:text-ink"
          >
            {draftOver ? "View board" : "Back to draft"}
          </button>
        </div>
      </header>

      {supers.length > 0 && (
        <section className="mt-3 flex flex-wrap gap-2">
          {supers.map((s) => (
            <p key={s.label} className="rounded-lg bg-panel px-3 py-2 text-sm">
              <span className="font-mono text-xs uppercase tracking-wide text-ink-dim">{s.label}:</span>{" "}
              <span style={{ color: POS_COLOR[s.player.pos] }}>{s.player.name}</span>{" "}
              <span className="text-ink-dim">
                — pick {s.pickNo} by {s.slot === mySlot ? "you" : `slot ${s.slot}`}, {s.detail}
              </span>
            </p>
          ))}
        </section>
      )}

      {sim && (
        <p className="mt-3 text-sm text-ink-dim">
          Win% = share of {SIMS} simulated seasons that roster outscores the room (weekly optimal
          lineups, position-typical variance). In top-heavy tournaments, chase the fat p99, not the
          fat mean.
        </p>
      )}

      <ol className="mt-4 space-y-2">
        {rows.map((t, i) => {
          const mine = t.slot === mySlot;
          const s = sim?.get(t.slot);
          const grade = gradeFor(i, rows.length);
          const open = expanded === t.slot;
          return (
            <li key={t.slot}>
              <button
                onClick={() => setExpanded(open ? null : t.slot)}
                aria-expanded={open}
                className={`flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg px-4 py-3 text-left ${
                  mine ? "bg-panel-2 ring-1 ring-wr/60" : "bg-panel hover:bg-panel-2"
                }`}
              >
                <span className="w-6 font-mono text-lg text-ink-faint">{i + 1}</span>
                <span
                  className={`rounded px-1.5 font-mono text-sm font-bold ${
                    grade.startsWith("A") ? "text-rb" : grade.startsWith("D") ? "text-qb" : "text-ink"
                  }`}
                >
                  {grade}
                </span>
                <span className="min-w-24 font-display text-xl font-bold uppercase">
                  {mine ? "You" : `Slot ${t.slot}`}
                </span>
                <span className="font-mono text-sm text-ink-dim">
                  {t.starterProj} <span className="text-ink-faint">starters</span> · {t.benchProj}{" "}
                  <span className="text-ink-faint">bench</span> · {t.totalVorp}{" "}
                  <span className="text-ink-faint">VORP</span>
                </span>
                {s && (
                  <span className="ml-auto font-mono text-sm">
                    <span className="text-rb">{(s.winRate * 100).toFixed(1)}% win</span>
                    <span className="ml-3 text-ink-dim">
                      p50 {Math.round(s.result.p50)} · p99 {Math.round(s.result.p99)}
                    </span>
                  </span>
                )}
              </button>
              {open && (
                <ul className="mx-4 grid grid-cols-2 gap-x-6 gap-y-0.5 rounded-b-lg bg-field px-4 py-3 sm:grid-cols-3">
                  {t.roster.map((p) => (
                    <li key={p.id} className="flex items-baseline gap-2 text-sm">
                      <span className="w-8 shrink-0 font-mono text-[11px]" style={{ color: POS_COLOR[p.pos] }}>
                        {p.pos}
                      </span>
                      <span className="truncate">{p.name}</span>
                      <span className="ml-auto font-mono text-[11px] text-ink-faint">
                        {Math.round(p.projPoints)}
                      </span>
                    </li>
                  ))}
                  {t.roster.length === 0 && <li className="text-sm text-ink-faint">No matched picks yet.</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
