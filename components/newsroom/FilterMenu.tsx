"use client";

// One dropdown to hone in: kinds, teams, and sources (show-only or hide),
// each with a live count of matching updates. Selections persist on-device.

import type { NewsKind } from "../../lib/engine/newsImportance";
import { KIND_LABEL } from "../../lib/engine/newsImportance";
import { DEFAULT_FILTERS, activeFilterCount, type NewsroomFilters } from "../../lib/client/newsroomFilters";
import { KIND_TONE } from "./feedUi";

const KINDS: NewsKind[] = ["season-ending", "suspension", "out", "doubtful", "questionable", "cleared", "transaction", "depth", "mention"];

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export default function FilterMenu({
  filters,
  onChange,
  teams,
  sources,
  counts,
}: {
  filters: NewsroomFilters;
  onChange: (f: NewsroomFilters) => void;
  teams: string[];
  sources: string[];
  counts: { kinds: Record<string, number>; teams: Record<string, number>; sources: Record<string, number> };
}) {
  const active = activeFilterCount(filters);
  return (
    <details className="relative">
      <summary
        className={`cursor-pointer list-none rounded border px-3 py-1.5 font-mono text-xs ${active ? "border-wr text-ink" : "border-line bg-panel text-ink-dim hover:text-ink"}`}
        title="Kinds, teams and sources"
      >
        Filters{active ? ` · ${active}` : ""} ▾
      </summary>
      <div className="absolute right-0 z-30 mt-1 w-[min(92vw,40rem)] max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-panel-2 p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <p className="font-display text-lg font-bold uppercase tracking-tight">Hone in</p>
          <button onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })} className="font-mono text-xs text-ink-dim hover:text-ink">
            Reset all
          </button>
        </div>

        <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-ink-faint">Kind of update</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {KINDS.map((k) => {
            const on = filters.kinds.length === 0 || filters.kinds.includes(k);
            return (
              <button
                key={k}
                aria-pressed={filters.kinds.includes(k)}
                onClick={() => onChange({ ...filters, kinds: toggle(filters.kinds, k) })}
                className={`rounded px-2 py-1 font-mono text-[11px] ${filters.kinds.includes(k) ? KIND_TONE[k] + " ring-1 ring-current" : on ? KIND_TONE[k] : "bg-panel text-ink-faint"}`}
              >
                {KIND_LABEL[k]} <span className="opacity-70">{counts.kinds[k] ?? 0}</span>
              </button>
            );
          })}
        </div>

        <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-ink-faint">Teams {filters.teams.length ? `· ${filters.teams.length} picked` : "· all"}</p>
        <div className="mt-1 grid grid-cols-8 gap-1">
          {teams.map((t) => (
            <button
              key={t}
              aria-pressed={filters.teams.includes(t)}
              onClick={() => onChange({ ...filters, teams: toggle(filters.teams, t) })}
              className={`rounded px-1 py-1 font-mono text-[11px] ${filters.teams.includes(t) ? "bg-wr/25 text-wr" : "bg-panel text-ink-dim hover:text-ink"}`}
              title={`${counts.teams[t] ?? 0} updates`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">Sources {filters.sources.length ? `· ${filters.sources.length} ${filters.sourceMode === "only" ? "shown" : "hidden"}` : "· all"}</p>
          <div className="flex rounded border border-line font-mono text-[11px]" role="radiogroup" aria-label="Source mode">
            {(["hide", "only"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={filters.sourceMode === m}
                onClick={() => onChange({ ...filters, sourceMode: m })}
                className={`px-2 py-1 ${filters.sourceMode === m ? "bg-panel text-ink" : "text-ink-faint hover:text-ink"}`}
              >
                {m === "hide" ? "Hide checked" : "Show only checked"}
              </button>
            ))}
          </div>
        </div>
        <ul className="mt-1 grid gap-x-4 sm:grid-cols-2">
          {sources.map((s) => (
            <li key={s}>
              <label className="flex cursor-pointer items-center gap-2 py-0.5 text-sm">
                <input type="checkbox" checked={filters.sources.includes(s)} onChange={() => onChange({ ...filters, sources: toggle(filters.sources, s) })} />
                <span className="truncate">{s}</span>
                <span className="ml-auto font-mono text-[11px] text-ink-faint">{counts.sources[s] ?? 0}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-faint">
          Bluesky accounts appear as @handles. To drop one everywhere, add it to the blocklist in Setup → Data sources.
        </p>
      </div>
    </details>
  );
}
