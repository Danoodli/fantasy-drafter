"use client";

import { useMemo, useState } from "react";
import type { BoardPlayer, LeagueConfig, Position } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { waiverAdds, streamingOptions } from "../../lib/engine/season/waivers";
import { POS_COLOR } from "../../lib/client/pos";

const STREAM_POS: Position[] = ["QB", "TE", "K", "DST"];

export default function WaiversPanel({
  roster, available, weeks, config, outlooks, week, assumesAllAvailable,
}: {
  roster: BoardPlayer[];
  available: BoardPlayer[];
  weeks: number[];
  config: LeagueConfig;
  outlooks: Map<string, WeekOutlook>;
  week: number;
  assumesAllAvailable: boolean;
}) {
  const [mode, setMode] = useState<"season" | Position>("season");
  const adds = useMemo(() => {
    if (roster.length === 0 || weeks.length === 0) return [];
    return mode === "season"
      ? waiverAdds({ roster, available, weeks, config, outlooks, currentWeek: week, maxResults: 8 })
      : streamingOptions({ roster, available, week, pos: mode, config, outlooks, maxResults: 5 });
  }, [roster, available, weeks, config, outlooks, week, mode]);

  return (
    <section className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Waivers</h2>
        <div className="flex gap-1 text-xs">
          <button onClick={() => setMode("season")} className={`rounded px-2 py-0.5 ${mode === "season" ? "bg-panel text-ink" : "text-ink-faint hover:text-ink"}`}>Rest of season</button>
          {STREAM_POS.filter((p) => (config.rosterSlots[p] ?? 0) > 0).map((p) => (
            <button key={p} onClick={() => setMode(p)} className={`rounded px-2 py-0.5 ${mode === p ? "bg-panel text-ink" : "text-ink-faint hover:text-ink"}`}>Stream {p}</button>
          ))}
        </div>
      </div>
      {adds.length === 0 ? (
        <p className="mt-2 text-sm text-ink-dim">Nobody available would add to your lineup{mode === "season" ? " over the rest of the season" : ` at ${mode} this week`}.</p>
      ) : (
        <ol className="mt-2 space-y-1 text-sm">
          {adds.map((a) => (
            <li key={a.add.id} className="flex flex-wrap items-baseline gap-x-2 hover:bg-panel">
              <span className="font-mono text-[10px]" style={{ color: POS_COLOR[a.add.pos] }}>{a.add.pos}</span>
              <strong>{a.add.name}</strong>
              <span className="text-xs text-ink-faint">{a.add.team}</span>
              {a.drop && (
                <span className="text-xs text-ink-dim">
                  — drop <span style={{ color: POS_COLOR[a.drop.pos] }}>{a.drop.pos}</span> {a.drop.name}
                </span>
              )}
              <span className="basis-full text-xs text-ink-dim">{a.reason}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        Ranked by points added to <em>your</em> lineup, not by a generic ranking — a third WR who never starts scores near zero.
        {assumesAllAvailable && " No league synced, so this assumes everyone not on your roster is available."}
      </p>
    </section>
  );
}
