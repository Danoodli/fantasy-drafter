"use client";

import { useEffect, useMemo, useState } from "react";
import type { Board, LeagueConfig } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { DEFAULT_WEEKLY_MODEL } from "../../lib/engine/weekly/model";
import { startSitAdvice } from "../../lib/engine/season/advice";
import { bestLineup } from "../../lib/engine/season/lineup";
import { gradeOutlooks } from "../../lib/engine/weekly/liveGrade";
import { gradeBoard } from "../../lib/engine/injuryFeed";
import { useLiveSignals } from "../../lib/client/useLiveSignals";
import { loadTeams, saveTeam, type SavedTeam } from "../../lib/client/teams";
import LineupTable from "./LineupTable";
import RosterImport from "./RosterImport";

export default function SeasonCockpit({
  board, outlooks, week, onWeekChange, config,
}: {
  board: Board;
  outlooks: Map<string, WeekOutlook>;
  week: number;
  onWeekChange: (w: number) => void;
  config: LeagueConfig;
}) {
  const [team, setTeam] = useState<SavedTeam | null>(null);

  // One-time hydration from localStorage; a team is created on first visit.
  useEffect(() => {
    const all = loadTeams();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration
    setTeam(
      all[0] ?? {
        id: `t-${Date.now()}`, name: "My team", config, source: "manual",
        roster: [], savedAt: new Date().toISOString(),
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time hydration
  }, []);

  const update = (t: SavedTeam) => {
    const stamped = { ...t, savedAt: new Date().toISOString() };
    setTeam(stamped);
    saveTeam(stamped);
  };

  const live = useLiveSignals(board);
  const headlines = useMemo(() => new Map([...live.boardNews].map(([id, n]) => [id, { headline: n.headline }] as const)), [live.boardNews]);
  const graded = useMemo(() => gradeOutlooks(outlooks, live.liveStatus, headlines, DEFAULT_WEEKLY_MODEL), [outlooks, live.liveStatus, headlines]);
  const gradedBoard = useMemo(() => gradeBoard(board, live.liveStatus, headlines), [board, live.liveStatus, headlines]);

  const byId = useMemo(() => new Map(gradedBoard.players.map((p) => [p.id, p] as const)), [gradedBoard.players]);
  // The `·live` marker compares against what the week board BAKED — the
  // ungraded board's status — never the graded board's, or graded-vs-graded
  // converges on the same merged value and the marker never fires.
  const bakedStatus = useMemo(() => new Map(board.players.map((p) => [p.id, p.injury] as const)), [board.players]);

  const advice = useMemo(() => {
    if (!team || team.roster.length === 0) return null;
    const players = team.roster
      .map((r) => {
        const p = byId.get(r.playerId);
        const o = graded.get(r.playerId);
        return p && o ? { id: p.id, pos: p.pos, team: p.team, name: p.name, outlook: o } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (players.length === 0) return null;
    // No opponent roster yet — Task 7 supplies one from Sleeper and Task 13
    // wires it. Until then the opponent is modelled as a projected total equal
    // to my own best lineup (an even matchup), and the UI says so rather than
    // pretending the win probability is precise.
    const startable = players.filter((p) => p.outlook.projected && p.outlook.pPlay > 0);
    const myProjected = bestLineup(startable.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), team.config).total;
    const starterIds = team.roster.filter((r) => r.slot === "starter").map((r) => r.playerId);
    return startSitAdvice({
      players,
      opponent: { kind: "total", projectedTotal: myProjected },
      config: team.config,
      params: DEFAULT_WEEKLY_MODEL,
      starterIds: starterIds.length ? starterIds : undefined,
    });
  }, [team, byId, graded]);

  if (!team) return <main className="p-6 text-sm text-ink-dim">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">In-season cockpit</h1>
        <div className="flex items-baseline gap-3">
          <span className="text-xs text-ink-faint">
            {live.lastRefresh ? `live signals ${new Date(live.lastRefresh).toLocaleTimeString()}` : "loading live signals…"}
          </span>
          <label className="text-xs text-ink-dim">
            Week{" "}
            <select
              value={week}
              onChange={(e) => onWeekChange(Number(e.target.value))}
              className="rounded border border-line bg-field px-1 py-0.5"
            >
              {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <RosterImport board={board} team={team} week={week} config={config} onChange={update} />

      {advice && (
        <>
          {advice.forced.length > 0 && (
            <section className="rounded-lg border border-qb/60 bg-qb/10 p-4">
              <h2 className="text-sm font-semibold text-qb">Must fix</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {advice.forced.map((f) => (
                  <li key={f.outId}>
                    <strong>{f.outName}</strong>{" "}
                    <span className="text-ink-dim">
                      {f.why === "bye" ? "is on a bye" : f.why === "out" ? "is not expected to play" : "has no projection from any source"}
                    </span>
                    {f.bestReplacementName && <> — start <strong>{f.bestReplacementName}</strong> instead</>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-lg border border-line p-4">
            <h2 className="text-sm font-semibold">Lineup</h2>
            <div className="mt-2">
              <LineupTable lineup={advice.lineup} players={byId} outlooks={graded} bakedStatus={bakedStatus} />
            </div>
          </section>

          <section className="rounded-lg border border-line p-4">
            <h2 className="text-sm font-semibold">Swaps worth making</h2>
            {advice.swaps.length === 0 ? (
              <p className="mt-2 text-sm text-ink-dim">Your lineup is already the best of what you have.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {advice.swaps.slice(0, 6).map((s) => (
                  <li key={`${s.inId}-${s.outId}`}>
                    Start <strong>{s.inName}</strong> over <strong>{s.outName}</strong>
                    <span className="text-ink-dim"> — {s.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-faint">
              Ranked by how much each swap moves your chance of winning this matchup, not by projected points.
              No opponent roster is loaded yet, so the opponent is modelled as a projected total equal to your own lineup — an even matchup. Win probability right now: {(advice.winProbability * 100).toFixed(0)}%.
            </p>
          </section>
        </>
      )}

      {!advice && (
        <p className="text-sm text-ink-dim">Add a few players above to see your lineup and swap advice.</p>
      )}
    </main>
  );
}
