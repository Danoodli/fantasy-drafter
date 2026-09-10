"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, BoardPlayer, LeagueConfig, Position, ScoringFormat } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { DEFAULT_WEEKLY_MODEL } from "../../lib/engine/weekly/model";
import { startSitAdvice, type AdvicePlayer, type Opponent } from "../../lib/engine/season/advice";
import { bestLineup } from "../../lib/engine/season/lineup";
import { playoffOdds, type PlayoffOdds, type LeagueTeamInput } from "../../lib/engine/season/playoffOdds";
import type { TradeLeagueContext } from "../../lib/engine/season/trade";
import { DEFAULT_SEASON_LEVERS } from "../../lib/engine/season/levers";
import { REG_SEASON_WEEKS } from "../../lib/engine/coverage";
import { gradeOutlooks } from "../../lib/engine/weekly/liveGrade";
import { gradeBoard } from "../../lib/engine/injuryFeed";
import { useLiveSignals } from "../../lib/client/useLiveSignals";
import { loadTeams, saveTeam, type SavedTeam } from "../../lib/client/teams";
import LowerThird from "../ui/LowerThird";
import LineupTable from "./LineupTable";
import RosterImport from "./RosterImport";
import MatchupPanel from "./MatchupPanel";
import WaiversPanel from "./WaiversPanel";
import PlayoffPanel from "./PlayoffPanel";
import TradePanel from "./TradePanel";
import PlayerModal from "../PlayerModal";

const DEFAULT_REGULAR_SEASON_END = 14;

export default function SeasonCockpit({
  board, outlooks, week, onWeekChange, config, onFormat,
}: {
  board: Board;
  outlooks: Map<string, WeekOutlook>;
  week: number;
  onWeekChange: (w: number) => void;
  config: LeagueConfig;
  /** Reports the active team's scoring format so the caller can refetch the week board in the right format. */
  onFormat?: (format: ScoringFormat) => void;
}) {
  const [team, setTeam] = useState<SavedTeam | null>(null);
  const [modalPlayer, setModalPlayer] = useState<BoardPlayer | null>(null);

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

  // The active team's scoring format drives which week board the page fetches
  // — a manual team, a Sleeper league in standard, etc. must not be stuck
  // showing PPR projections.
  const teamScoring = team?.config.scoring;
  useEffect(() => {
    if (teamScoring) onFormat?.(teamScoring);
  }, [teamScoring, onFormat]);

  const live = useLiveSignals(board);
  const headlines = useMemo(() => new Map([...live.boardNews].map(([id, n]) => [id, { headline: n.headline }] as const)), [live.boardNews]);
  const graded = useMemo(() => gradeOutlooks(outlooks, live.liveStatus, headlines, DEFAULT_WEEKLY_MODEL), [outlooks, live.liveStatus, headlines]);
  const gradedBoard = useMemo(() => gradeBoard(board, live.liveStatus, headlines), [board, live.liveStatus, headlines]);

  const byId = useMemo(() => new Map(gradedBoard.players.map((p) => [p.id, p] as const)), [gradedBoard.players]);
  // The `·live` marker compares against what the WEEK BOARD baked — the
  // ungraded `outlooks` prop's `drivers.status` — never the graded board's,
  // or graded-vs-graded converges on the same merged value and the marker
  // never fires.
  const bakedStatus = useMemo(() => new Map([...outlooks].map(([id, o]) => [id, o.drivers.status] as const)), [outlooks]);

  const rosterPlayers = useMemo(
    () => (team ? team.roster.map((r) => byId.get(r.playerId)).filter((p): p is BoardPlayer => !!p) : []),
    [team, byId]
  );
  const starterIds = useMemo(() => team?.roster.filter((r) => r.slot === "starter").map((r) => r.playerId) ?? [], [team]);
  const league = team?.league ?? null;
  const myRosterId = team?.sleeper?.rosterId ?? null;
  const oppRosterId = team?.schedule?.[week]?.oppRosterId ?? null;
  const oppSnapshot = league && oppRosterId !== null ? league.rosters.find((r) => r.rosterId === oppRosterId) ?? null : null;

  // Only players the week board has an outlook for can be advised on; the rest
  // still show in the roster list. flatMap keeps the types honest without a
  // hand-written predicate.
  const advicePlayers = useMemo<(AdvicePlayer & { name: string })[]>(
    () => rosterPlayers.flatMap((p) => {
      const o = graded.get(p.id);
      return o ? [{ id: p.id, pos: p.pos as Position, team: p.team, name: p.name, outlook: o }] : [];
    }),
    [rosterPlayers, graded]
  );
  const myProjected = useMemo(() => {
    const startable = advicePlayers.filter((p) => p.outlook.projected && p.outlook.pPlay > 0);
    return team ? bestLineup(startable.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), team.config).total : 0;
  }, [advicePlayers, team]);
  const oppTotal = team?.oppProjectedTotal ?? myProjected;

  const opponent = useMemo<Opponent>(() => {
    if (oppSnapshot) {
      const players: AdvicePlayer[] = oppSnapshot.starters.flatMap((id) => {
        const p = byId.get(id);
        const o = p ? graded.get(p.id) : undefined;
        return p && o ? [{ id: p.id, pos: p.pos, team: p.team, outlook: o }] : [];
      });
      if (players.length > 0) return { kind: "roster", players };
    }
    return { kind: "total", projectedTotal: oppTotal };
  }, [oppSnapshot, byId, graded, oppTotal]);

  // Playoff odds: background compute, Sleeper only.
  const [odds, setOdds] = useState<PlayoffOdds | null>(null);
  const [oddsRunning, setOddsRunning] = useState(false);
  const regularSeasonEnd = league ? league.playoffWeekStart - 1 : team?.regularSeasonEnd ?? DEFAULT_REGULAR_SEASON_END;
  const weeks = useMemo(() => Array.from({ length: Math.max(0, Math.min(REG_SEASON_WEEKS, regularSeasonEnd) - week + 1) }, (_, i) => week + i), [week, regularSeasonEnd]);
  const leagueTeams: LeagueTeamInput[] | null = useMemo(() => {
    if (!league) return null;
    return league.rosters.map((r) => ({
      rosterId: r.rosterId, name: r.name, wins: r.wins, losses: r.losses, ties: r.ties, pointsFor: r.pointsFor,
      players: r.players.map((id) => byId.get(id)).filter((p): p is BoardPlayer => !!p),
    }));
  }, [league, byId]);
  // The simulation is keyed on the LEAGUE, the week and the config — not on
  // `byId`, which changes identity on every ten-minute live-signals poll and
  // would re-run 500 season sims on a timer. The current board is read through
  // a ref so a genuine roster/league change still simulates with fresh players.
  const leagueTeamsRef = useRef(leagueTeams);
  // "Latest ref" write in its own effect (never at render time), so the
  // background sim below reads fresh players without re-running on every
  // live-signals poll.
  useEffect(() => {
    leagueTeamsRef.current = leagueTeams;
  }, [leagueTeams]);
  const teamConfig = team?.config;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale odds when the league/roster the sim depends on disappears, not a render-time computation
    if (!league || myRosterId === null || !teamConfig) { setOdds(null); return; }
    setOddsRunning(true);
    const handle = setTimeout(() => {
      const teams = leagueTeamsRef.current;
      if (!teams) return;
      setOdds(playoffOdds({ teams, schedule: league.schedule, currentWeek: week, playoffWeekStart: league.playoffWeekStart, playoffTeams: league.playoffTeams, config: teamConfig, myRosterId }));
      setOddsRunning(false);
    }, 0);
    return () => clearTimeout(handle);
  }, [league, myRosterId, week, teamConfig]);

  // Read only when the dial is actually on: with riskFromPlayoffOdds at its
  // shipped 0, `leverage` is always null regardless of `odds`, so using IT
  // (not `odds`) as the advice dependency below means the background sim
  // landing (setOdds) never re-triggers a 2000-sim start/sit recompute while
  // the dial is off.
  const leverage = DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds > 0 ? odds?.leverage ?? null : null;
  const advice = useMemo(() => {
    if (!team || advicePlayers.length === 0) return null;
    return startSitAdvice({ players: advicePlayers, opponent, config: team.config, params: DEFAULT_WEEKLY_MODEL, starterIds: starterIds.length ? starterIds : undefined, leverage });
  }, [team, advicePlayers, opponent, starterIds, leverage]);

  const rostered = useMemo(() => new Set(league ? league.rosters.flatMap((r) => r.players) : team?.roster.map((r) => r.playerId) ?? []), [league, team]);
  const available = useMemo(() => board.players.filter((p) => !rostered.has(p.id)), [board.players, rostered]);
  // No partnerRosterId here: the trade partner is whoever holds the players
  // you're receiving, not this week's opponent — TradePanel derives it from
  // `rosters` once `receive` is picked.
  const tradeLeague: TradeLeagueContext | null = league && leagueTeams && myRosterId !== null
    ? { teams: leagueTeams, schedule: league.schedule, currentWeek: week, playoffWeekStart: league.playoffWeekStart, playoffTeams: league.playoffTeams, myRosterId, rosters: league.rosters }
    : null;
  const changed = useMemo(() => {
    if (!advice) return new Set<string>();
    const cur = new Set(advice.lineup.starters.map((s) => s.player.id));
    const rec = new Set(advice.recommended.starters.map((s) => s.player.id));
    return new Set([...cur].filter((id) => !rec.has(id)).concat([...rec].filter((id) => !cur.has(id))));
  }, [advice]);

  if (!team) return <main className="p-6 text-sm text-ink-dim">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold">In-season cockpit</h1>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-xs text-ink-faint">
            {live.lastRefresh ? `live signals ${new Date(live.lastRefresh).toLocaleTimeString()}` : "loading live signals…"}
          </span>
          <label className="text-xs text-ink-dim">
            Week{" "}
            <select
              value={week}
              onChange={(e) => onWeekChange(Number(e.target.value))}
              className="rounded bg-field px-1 py-0.5"
            >
              {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <RosterImport board={board} team={team} week={week} config={config} onChange={update} />

      {advice && team && (
        <>
          {advice.forced.length > 0 && (
            <section className="space-y-3">
              <LowerThird headline="Must fix" number={String(advice.forced.length)} label="to fix" tone="bad" />
              <ul className="space-y-1 px-1 text-sm">
                {advice.forced.map((f) => (
                  <li key={f.outId}>
                    <strong>{f.outName}</strong>{" "}
                    <span className="text-ink-dim">{f.why === "bye" ? "is on a bye" : f.why === "out" ? "is not expected to play" : "has no projection from any source"}</span>
                    {f.bestReplacementName && <> — start <strong>{f.bestReplacementName}</strong> instead</>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3">
            <LowerThird
              headline={changed.size > 0 ? "Recommended lineup" : "Lineup"}
              number={`${(advice.winProbability * 100).toFixed(0)}%`}
              label="to win"
            />
            <div className="px-1">
              <LineupTable
                lineup={advice.recommended}
                players={byId}
                outlooks={graded}
                bakedStatus={bakedStatus}
                changed={changed}
                onSelect={(id) => setModalPlayer(byId.get(id) ?? null)}
              />
            </div>
            {advice.swaps.length === 0 ? (
              <p className="px-1 text-sm text-ink-dim">Your lineup is already the best of what you have.</p>
            ) : (
              <ul className="space-y-1 px-1 text-sm">
                {advice.swaps.slice(0, 6).map((s) => (
                  <li key={`${s.inId}-${s.outId}`}>Start <strong>{s.inName}</strong> over <strong>{s.outName}</strong><span className="text-ink-dim"> — {s.reason}</span></li>
                ))}
              </ul>
            )}
            <p className="px-1 text-xs text-ink-faint">Ranked by how much each swap moves your chance of winning this matchup, not by projected points.</p>
          </section>

          <MatchupPanel
            advice={advice}
            oppName={oppSnapshot?.name ?? team.schedule?.[week]?.oppName ?? null}
            oppIsTotal={opponent.kind === "total"}
            oppTotal={oppTotal}
            onOppTotal={(v) => update({ ...team, oppProjectedTotal: v })}
          />
          <WaiversPanel roster={rosterPlayers} available={available} weeks={weeks} config={team.config} outlooks={graded} week={week} assumesAllAvailable={!league} />
          <PlayoffPanel odds={odds} running={oddsRunning} myRosterId={myRosterId} regularSeasonEnd={regularSeasonEnd} onRegularSeasonEnd={(w) => update({ ...team, regularSeasonEnd: w })} hasLeague={!!league} />
          <TradePanel roster={rosterPlayers} board={board.players} ctx={{ weeks, config: team.config, outlooks: graded, currentWeek: week }} league={tradeLeague} />
        </>
      )}
      {!advice && <p className="text-sm text-ink-dim">Add a few players above to see your lineup and swap advice.</p>}

      {modalPlayer && (
        <PlayerModal
          player={modalPlayer}
          ctx={{ currentPick: 1, nextPick: 1, drift: {}, tierMatesLeft: 0 }}
          config={team.config}
          drafted={false}
          canUnmark={false}
          readonly
          week={{ week, outlook: graded.get(modalPlayer.id) }}
          wireItem={live.boardNews.get(modalPlayer.id) ?? null}
          myTurn={false}
          onMark={() => {}}
          onUnmark={() => {}}
          onClose={() => setModalPlayer(null)}
        />
      )}
    </main>
  );
}
