"use client";

// In-season cockpit. Loads the season board (for names, positions, teams) and
// the weekly board (for projections), then hands off to SeasonCockpit.
// Both are static JSON — no server on the hot path, same as the draft route.

import { useEffect, useState } from "react";
import type { Board, LeagueConfig, ScoringFormat } from "../../lib/types";
import { loadConfig } from "../../lib/client/config";
import { fetchWeekBoard, indexOutlooks, currentNflWeek } from "../../lib/client/weekBoard";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import SeasonCockpit from "../../components/season/SeasonCockpit";

const SEASON = 2026;
/** Tuesday before week 1. Kept here rather than in config: it is a calendar fact. */
const SEASON_START = new Date("2026-09-08T00:00:00Z");

export default function SeasonPage() {
  const [config, setConfig] = useState<LeagueConfig | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [outlooks, setOutlooks] = useState<Map<string, WeekOutlook> | null>(null);
  const [week, setWeek] = useState(() => currentNflWeek(new Date(), SEASON_START));
  const [error, setError] = useState<string | null>(null);
  // The saved team's scoring format, reported up by SeasonCockpit — not
  // `config?.scoring`, which is only Setup's config and misses a team whose
  // own format differs (a synced Sleeper league, a second manual team).
  const [format, setFormat] = useState<ScoringFormat>(() => loadConfig()?.scoring ?? "ppr");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration
    setConfig(loadConfig() ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears a stale error before refetching on format/week change
    setError(null);
    Promise.all([
      fetch(`/data/board-${format}.json`, { cache: "no-cache" }).then((r) => r.json() as Promise<Board>),
      fetchWeekBoard(SEASON, week, format),
    ])
      .then(([b, wb]) => {
        if (cancelled) return;
        setBoard(b);
        setOutlooks(indexOutlooks(wb));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [format, week]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-6 text-sm">
        <h1 className="text-lg font-semibold">In-season cockpit</h1>
        <p className="mt-4 text-warn">Could not load week {week}: {error}</p>
        <p className="mt-2 text-ink-dim">
          Build it with <code className="rounded bg-panel px-1">pnpm build:week -- --week={week}</code>.
        </p>
      </main>
    );
  }

  if (!board || !outlooks) {
    return <main className="mx-auto max-w-3xl p-6 text-sm text-ink-dim">Loading week {week}…</main>;
  }

  return (
    <SeasonCockpit
      board={board}
      outlooks={outlooks}
      week={week}
      onWeekChange={setWeek}
      config={config ?? { ...defaultConfig, scoring: "ppr" }}
      onFormat={setFormat}
    />
  );
}

/** Used when the user has never run Setup — enough to render a lineup. */
const defaultConfig: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
