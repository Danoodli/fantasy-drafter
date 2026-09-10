"use client";

import { useState } from "react";
import type { PlayoffOdds } from "../../lib/engine/season/playoffOdds";
import { DEFAULT_SEASON_LEVERS } from "../../lib/engine/season/levers";
import LowerThird from "../ui/LowerThird";

export default function PlayoffPanel({
  odds, running, myRosterId, regularSeasonEnd, onRegularSeasonEnd, hasLeague,
}: {
  odds: PlayoffOdds | null;
  running: boolean;
  myRosterId: number | null;
  regularSeasonEnd: number;
  onRegularSeasonEnd: (w: number) => void;
  hasLeague: boolean;
}) {
  // Same commit-on-blur/Enter pattern as MatchupPanel's opponent-total input:
  // a number input's onChange fires with "" mid-edit, and Number("") is 0.
  const [endText, setEndText] = useState(() => String(regularSeasonEnd));
  // Adjusting state when a prop changes, done during render per React's own
  // guidance — see MatchupPanel's identical pattern for why not an effect.
  const [syncedEnd, setSyncedEnd] = useState(regularSeasonEnd);
  if (regularSeasonEnd !== syncedEnd) {
    setSyncedEnd(regularSeasonEnd);
    setEndText(String(regularSeasonEnd));
  }
  const commitEnd = () => {
    const n = Number(endText);
    if (endText.trim() !== "" && Number.isFinite(n)) onRegularSeasonEnd(n);
    else setEndText(String(regularSeasonEnd));
  };
  const tone = !hasLeague || !odds ? "quiet" : odds.mine.playoffOdds >= 0.6 ? "good" : odds.mine.playoffOdds <= 0.4 ? "bad" : "accent";
  const number = hasLeague && odds ? `${(odds.mine.playoffOdds * 100).toFixed(0)}%` : undefined;
  return (
    <section className="space-y-3">
      <LowerThird headline="Playoff odds" number={number} label={number ? "to make it" : undefined} tone={tone} />
      {!hasLeague ? (
        <div className="px-1 text-sm text-ink-dim">
          <p>Playoff odds need every roster in the league. Sync a Sleeper league to see them.</p>
          <label className="mt-2 block text-xs">
            Regular season ends after week{" "}
            <input
              type="number" min={1} max={18} value={endText}
              onChange={(e) => setEndText(e.target.value)}
              onBlur={commitEnd}
              onKeyDown={(e) => { if (e.key === "Enter") { commitEnd(); e.currentTarget.blur(); } }}
              className="ml-1 w-14 rounded bg-field px-1 py-0.5 tabular-nums"
            />
            <span className="ml-2 text-ink-faint">(sets how many weeks waivers and trades count)</span>
          </label>
        </div>
      ) : running && !odds ? (
        <p className="px-1 text-sm text-ink-dim">Simulating the rest of the season…</p>
      ) : odds ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1">
            <span className="text-sm text-ink-dim">{odds.mine.expectedWins.toFixed(1)} more wins expected</span>
            {odds.leverage !== null && (
              <span className="text-xs text-ink-faint">
                this week: {odds.oddsIfWin !== null ? `${(odds.oddsIfWin * 100).toFixed(0)}% if you win` : "—"} / {odds.oddsIfLose !== null ? `${(odds.oddsIfLose * 100).toFixed(0)}% if you lose` : "—"}
              </span>
            )}
            {odds.eliminationNumber !== null && odds.mine.playoffOdds < 1 && (
              <span className="text-xs text-ink-faint">{odds.eliminationNumber === 0 ? "eliminated" : `elimination number ${odds.eliminationNumber}`}</span>
            )}
            {running && <span className="text-xs text-ink-faint">updating…</span>}
          </div>
          <table className="w-full px-1 text-sm">
            <thead><tr className="text-left text-xs text-ink-faint"><th className="font-normal">Team</th><th className="text-right font-normal">Odds</th><th className="text-right font-normal">Exp. wins</th><th className="text-right font-normal">Top seed</th></tr></thead>
            <tbody>
              {[...odds.teams].sort((a, b) => b.playoffOdds - a.playoffOdds).map((t) => (
                <tr key={t.rosterId} className={`hover:bg-panel ${t.rosterId === myRosterId ? "font-semibold" : ""}`}>
                  <td className="py-0.5">{t.name}</td>
                  <td className="py-0.5 text-right tabular-nums">{(t.playoffOdds * 100).toFixed(0)}%</td>
                  <td className="py-0.5 text-right tabular-nums">{t.expectedWins.toFixed(1)}</td>
                  <td className="py-0.5 text-right tabular-nums text-ink-dim">{((t.seedDist[0] ?? 0) * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-1 text-xs text-ink-faint">
            {odds.remainingWeeks} regular-season week{odds.remainingWeeks === 1 ? "" : "s"} left.
            {" "}Pairings known through week {odds.scheduleKnownThrough}; later weeks use a random opponent.
            {" "}Risk dial ({DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds === 0 ? "off" : `on, ${DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds}`}): {DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds === 0 ? "start/sit ranks by this week's win probability alone." : "start/sit blends toward projected points when this week cannot move your odds."}
          </p>
        </>
      ) : (
        <p className="px-1 text-sm text-ink-dim">Waiting for the league snapshot…</p>
      )}
    </section>
  );
}
