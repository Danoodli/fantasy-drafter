"use client";

// Sleeper tab of RosterImport: paste a league URL or id, pick which roster is
// yours, sync. Re-sync any time; Sleeper's locked starters and your opponent's
// come along. Ends in applyRoster via teamFromSleeper.

import { useState } from "react";
import type { LeagueConfig } from "../../lib/types";
import type { SavedTeam } from "../../lib/client/teams";
import {
  fetchLeague, fetchSchedule, parseLeagueId, teamNameFor, teamFromSleeper,
  type SleeperLeagueInfo, type SleeperRoster, type SleeperUser,
} from "../../lib/season/sleeperLeague";

export default function SleeperSync({
  team, week, base, onChange,
}: {
  team: SavedTeam;
  week: number;
  base: LeagueConfig;
  onChange: (t: SavedTeam) => void;
}) {
  const [input, setInput] = useState(team.sleeper?.leagueId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ league: SleeperLeagueInfo; rosters: SleeperRoster[]; users: SleeperUser[] } | null>(null);

  async function load() {
    setError(null);
    setBusy("Loading league…");
    try {
      setLoaded(await fetchLeague(parseLeagueId(input)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function sync(rosterId: number) {
    if (!loaded) return;
    setError(null);
    setBusy("Loading schedule…");
    try {
      const { schedule, failedWeeks } = await fetchSchedule(loaded.league.leagueId, week, loaded.league.playoffWeekStart - 1);
      onChange(teamFromSleeper({ ...loaded, myRosterId: rosterId, schedule, base, existing: team.sleeper ? team : undefined, now: new Date().toISOString() }));
      if (failedWeeks.length) setError(`Synced, but the schedule for week${failedWeeks.length === 1 ? "" : "s"} ${failedWeeks.join(", ")} could not be fetched — re-sync later; playoff odds treat those weeks as unknown pairings.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Sleeper league URL or id"
          className="flex-1 rounded border border-line bg-field px-2 py-1"
        />
        <button onClick={load} disabled={!input.trim() || busy !== null} className="rounded bg-panel px-3 py-1 font-semibold text-ink-dim hover:text-ink disabled:opacity-40">
          Load
        </button>
      </div>
      {busy && <p className="text-xs text-ink-faint">{busy}</p>}
      {error && <p className="text-xs text-warn">{error}</p>}
      {loaded && (
        <div>
          <p className="text-xs text-ink-dim">
            {loaded.league.name} · {loaded.league.teams} teams · {loaded.league.playoffTeams} make the playoffs from week {loaded.league.playoffWeekStart}. Which roster is yours?
          </p>
          <ul className="mt-1 grid grid-cols-2 gap-1">
            {loaded.rosters.map((r) => (
              <li key={r.rosterId}>
                <button
                  onClick={() => sync(r.rosterId)}
                  disabled={busy !== null}
                  className={`w-full rounded border px-2 py-1 text-left text-xs hover:bg-panel ${team.sleeper?.rosterId === r.rosterId ? "border-rb" : "border-line"}`}
                >
                  {teamNameFor(r, loaded.users)} <span className="text-ink-faint">{r.wins}-{r.losses}{r.ties ? `-${r.ties}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {team.sleeper && team.league && (
        <p className="text-xs text-ink-faint">
          Synced {new Date(team.league.syncedAt).toLocaleString()} · {team.record?.w}-{team.record?.l}
          {team.schedule?.[week]?.oppName ? ` · week ${week} vs ${team.schedule[week].oppName}` : ` · no week ${week} opponent published yet`}
        </p>
      )}
    </div>
  );
}
