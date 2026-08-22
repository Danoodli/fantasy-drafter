"use client";

// Post-draft recap: every roster in the room, ranked by projected draft
// value, with letter grades, steals/reaches, and an in-browser season
// simulation (win rates + ceiling percentiles — the tournament numbers).
// Opens automatically when the draft ends; available any time from the
// header to check mid-draft standings.

import { useMemo, useState } from "react";
import type { Board, BoardPlayer, DraftPick, LeagueConfig, TradedPick } from "../lib/types";
import PlayerModal from "./PlayerModal";
import { buildRecap, gradeFor, superlatives, type TeamRecap } from "../lib/engine/recap";
import { simulateRoom, type SeasonSimResult } from "../lib/engine/season";
import { POS_COLOR } from "../lib/client/pos";
import { stackPartners } from "../lib/client/stacks";
import { shareCard } from "../lib/client/shareCard";

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
  const [modalPlayer, setModalPlayer] = useState<BoardPlayer | null>(null);

  type SortKey = "value" | "starters" | "bench" | "vorp" | "win" | "p99";
  const SORTS: { key: SortKey; label: string; needsSim?: boolean }[] = [
    { key: "value", label: "Draft value" },
    { key: "starters", label: "Starters" },
    { key: "bench", label: "Bench" },
    { key: "vorp", label: "VORP" },
    { key: "win", label: "Win %", needsSim: true },
    { key: "p99", label: "p99 ceiling", needsSim: true },
  ];
  const [sortKey, setSortKey] = useState<SortKey>("value");

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
      setSortKey("win");
      setSimming(false);
    }, 30);
  }

  const rows: TeamRecap[] = useMemo(() => {
    const metric = (t: TeamRecap): number => {
      const s = sim?.get(t.slot);
      switch (sortKey) {
        case "starters": return t.starterProj;
        case "bench": return t.benchProj;
        case "vorp": return t.totalVorp;
        case "win": return s?.winRate ?? 0;
        case "p99": return s?.result.p99 ?? 0;
        default: return t.score;
      }
    };
    return [...teams].sort((a, b) => metric(b) - metric(a));
  }, [teams, sim, sortKey]);

  const myRank = rows.findIndex((t) => t.slot === mySlot);

  return (
    <main data-tour-screen="recap" className="mx-auto max-w-5xl px-4 pb-10 pt-4">
      <header className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight">
          {draftOver ? "Draft recap" : "Standings so far"}
        </h1>
        <p className="text-ink-dim">
          {picks.length} picks in · you {myRank >= 0 ? `rank ${myRank + 1} of ${config.teams}` : "—"}
        </p>
        <div className="ml-auto flex gap-2">
          <button
            onClick={async () => {
              try {
              const meIdx = rows.findIndex((t) => t.slot === mySlot);
              const me = rows[meIdx];
              if (!me) return;
              const steal = supers.find((s) => s.slot === mySlot);
              await shareCard({
                title: `slot ${mySlot} · ${config.teams}tm ${config.scoring}${config.leagueType === "bestball" ? " best ball" : ""}`,
                grade: gradeFor(meIdx, rows.length),
                rank: meIdx + 1,
                teams: rows.length,
                winPct: sim?.get(mySlot)?.winRate ?? null,
                roster: me.roster,
                note: steal ? `${steal.label}: ${steal.player.name} — ${steal.detail}` : null,
              });
              } catch (err) {
                console.error("share card failed:", err);
              }
            }}
            data-tour="recap-share"
            className="btn-shimmer rounded border border-line bg-panel px-4 py-2 text-sm text-ink hover:bg-panel-2"
            title="Render your recap as a PNG for the group chat"
          >
            Share card
          </button>
          <button
            data-tour="recap-sim"
            onClick={runSim}
            disabled={simming}
            className="rounded bg-rb px-4 py-2 font-display text-lg font-bold uppercase text-field disabled:opacity-50"
          >
            {simming ? "Simulating…" : sim ? `Re-run ${SIMS} seasons` : `Simulate ${SIMS} seasons`}
          </button>
          <button
            data-tour="recap-back"
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
              <button
                onClick={() => setModalPlayer(s.player)}
                className="hover:underline"
                style={{ color: POS_COLOR[s.player.pos] }}
              >
                {s.player.name}
              </button>{" "}
              <span className="text-ink-dim">
                — pick {s.pickNo} by {s.slot === mySlot ? "you" : `slot ${s.slot}`}, {s.detail}
              </span>
            </p>
          ))}
        </section>
      )}

      {/* Sort — grades follow whichever lens you pick */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Sort standings">
        <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">Rank by</span>
        {SORTS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSortKey(s.key)}
            disabled={s.needsSim && !sim}
            aria-pressed={sortKey === s.key}
            title={s.needsSim && !sim ? "Run the simulation first" : undefined}
            className={`rounded px-2 py-1 text-xs font-medium ${
              sortKey === s.key ? "bg-panel-2 text-ink" : "bg-panel text-ink-dim hover:text-ink"
            } disabled:opacity-35`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sim && (
        <p className="mt-3 text-sm text-ink-dim">
          Win% = share of {SIMS} simulated seasons that roster outscores the room (weekly optimal
          lineups, position-typical variance). In top-heavy tournaments, chase the fat p99, not the
          fat mean.
        </p>
      )}

      <ol data-tour="recap-standings" className="stagger mt-4 space-y-2">
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
                className={`lift flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg px-4 py-3 text-left ${
                  mine ? "bg-panel-2 ring-1 ring-wr/60" : "bg-panel hover:bg-panel-2"
                }`}
              >
                <span className="w-6 font-mono text-lg text-ink-faint">{i + 1}</span>
                <span
                  className={`badge-pop rounded px-1.5 font-mono text-sm font-bold ${
                    grade.startsWith("A") ? "text-rb" : grade.startsWith("D") ? "text-qb" : "text-ink"
                  }`}
                >
                  {grade}
                </span>
                <span className="min-w-24 font-display text-xl font-bold uppercase">
                  {mine ? "You" : `Slot ${t.slot}`}
                </span>
                <span className="flex gap-2.5 font-mono text-xs">
                  {(["QB", "RB", "WR", "TE", "K", "DST"] as const).map((pos) => {
                    const n = t.roster.filter((p) => p.pos === pos).length;
                    if (n === 0) return null;
                    return (
                      <span key={pos}>
                        <span style={{ color: POS_COLOR[pos] }}>{pos}</span>{" "}
                        <span className="text-ink">{n}</span>
                      </span>
                    );
                  })}
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
                  {t.roster.map((p) => {
                    const stacks = stackPartners(p, t.roster);
                    return (
                      <li key={p.id} className="flex items-baseline gap-2 text-sm">
                        <span className="w-8 shrink-0 font-mono text-[11px]" style={{ color: POS_COLOR[p.pos] }}>
                          {p.pos}
                        </span>
                        <button onClick={() => setModalPlayer(p)} className="truncate text-left hover:underline">
                          {p.name}
                        </button>
                        <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
                        {stacks.length > 0 && (
                          <span className="text-[11px] text-warn" title={`Stacked with ${stacks.map((s) => s.name).join(", ")}`}>
                            ⚡
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[11px] text-ink-faint">
                          {Math.round(p.projPoints)}
                        </span>
                      </li>
                    );
                  })}
                  {t.roster.length === 0 && <li className="text-sm text-ink-faint">No matched picks yet.</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      {modalPlayer && (
        <PlayerModal
          player={modalPlayer}
          ctx={{
            currentPick: config.teams * config.rounds,
            nextPick: config.teams * config.rounds,
            drift: {},
            tierMatesLeft: board.players.filter(
              (a) => a.pos === modalPlayer.pos && a.tier === modalPlayer.tier && a.id !== modalPlayer.id
            ).length,
          }}
          config={config}
          drafted
          canUnmark={false}
          readonly
          wireItem={modalPlayer.news ? { ...modalPlayer.news, href: null } : null}
          myTurn={false}
          onMark={() => {}}
          onUnmark={() => {}}
          onClose={() => setModalPlayer(null)}
        />
      )}
    </main>
  );
}
