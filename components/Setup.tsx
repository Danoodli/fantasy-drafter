"use client";

// First-run setup. Sleeper mode auto-derives everything it can from the API —
// typed values are the fallback, not the source of truth.

import { useState } from "react";
import type { LeagueConfig, ScoringFormat } from "../lib/types";
import { fetchDraftInfo, parseDraftId, fetchLeagueDrafts } from "../lib/draft/sleeper";
import { DEFAULT_CONFIG, BESTBALL_PRESETS } from "../lib/client/config";

const SCORING_OPTIONS: { value: ScoringFormat; label: string }[] = [
  { value: "ppr", label: "PPR" },
  { value: "half-ppr", label: "Half PPR" },
  { value: "standard", label: "Standard" },
  { value: "2qb", label: "2QB / Superflex" },
];

export default function Setup({ onDone }: { onDone: (config: LeagueConfig) => void }) {
  const [mode, setMode] = useState<"sleeper" | "manual">("sleeper");
  const [draftInput, setDraftInput] = useState("");
  const [config, setConfig] = useState<LeagueConfig>(DEFAULT_CONFIG);
  const [derived, setDerived] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadSleeper() {
    setLoading(true);
    setError(null);
    try {
      let draftId = parseDraftId(draftInput);
      // A league id also works — take its most recent draft.
      try {
        const info = await fetchDraftInfo(draftId);
        applyInfo(draftId, info);
      } catch {
        const drafts = await fetchLeagueDrafts(draftId);
        if (!drafts.length) throw new Error("no drafts found for that id");
        const leagueId = draftId;
        draftId = drafts[0].draft_id;
        const info = await fetchDraftInfo(draftId);
        applyInfo(draftId, info, leagueId);
      }
    } catch (err) {
      setError(
        `Couldn't load that draft (${(err as Error).message}). Check the id, or switch to manual mode.`
      );
    } finally {
      setLoading(false);
    }
  }

  function applyInfo(
    draftId: string,
    info: Awaited<ReturnType<typeof fetchDraftInfo>>,
    leagueId?: string
  ) {
    const slots: Record<string, number> = {};
    for (const rp of info.rosterPositions ?? []) slots[rp] = (slots[rp] ?? 0) + 1;
    const hasLeague = info.rosterPositions != null;
    const superflex = (slots.SUPER_FLEX ?? 0) > 0 || (slots.QB ?? 0) >= 2;
    const rec = info.scoringSettings?.rec;
    // Mock drafts have no league scoring — fall back to the draft's scoring_type hint.
    const hint: Record<string, ScoringFormat> = { ppr: "ppr", half_ppr: "half-ppr", std: "standard", "2qb": "2qb" };
    const scoring: ScoringFormat = superflex
      ? "2qb"
      : rec === 1
        ? "ppr"
        : rec === 0.5
          ? "half-ppr"
          : rec === 0
            ? "standard"
            : (info.scoringType && hint[info.scoringType]) || config.scoring;
    setConfig((c) => ({
      ...c,
      platform: "sleeper",
      draftId,
      leagueId: leagueId ?? info.leagueId ?? "",
      teams: info.teams,
      rounds: info.rounds,
      scoring,
      leagueType: info.bestBall ? "bestball" : c.leagueType,
      strategy: info.bestBall ? "tournament-ceiling" : c.strategy,
      rosterSlots: hasLeague
        ? {
            QB: slots.QB ?? 0,
            RB: slots.RB ?? 0,
            WR: slots.WR ?? 0,
            TE: slots.TE ?? 0,
            FLEX: (slots.FLEX ?? 0) + (slots.SUPER_FLEX ?? 0),
            K: slots.K ?? 0,
            DST: slots.DEF ?? 0,
          }
        : c.rosterSlots,
    }));
    setDerived(
      `${info.teams} teams · ${info.rounds} rounds · ${info.status}` +
        (info.bestBall ? " · BEST BALL detected" : "") +
        (hasLeague ? " · scoring + roster pulled from league" : " · mock draft (no league)")
    );
  }

  const ready = config.myDraftSlot != null && (mode === "manual" || config.draftId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <header>
        <h1 className="font-display text-5xl font-bold uppercase tracking-tight">
          Draft Cockpit
        </h1>
        <p className="mt-1 text-ink-dim">Who to take, right now. Set up once, then draft.</p>
      </header>

      <div className="flex gap-2" role="tablist" aria-label="Draft source">
        {(["sleeper", "manual"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setConfig((c) => ({ ...c, platform: m }));
            }}
            className={`rounded px-4 py-2 text-sm font-semibold uppercase tracking-wide ${
              mode === m ? "bg-panel-2 text-ink" : "bg-panel text-ink-dim hover:text-ink"
            }`}
          >
            {m === "sleeper" ? "Sleeper (live sync)" : "Manual entry"}
          </button>
        ))}
      </div>

      {mode === "sleeper" && (
        <section className="rounded-lg bg-panel p-4">
          <label className="block text-sm font-medium text-ink-dim" htmlFor="draft-id">
            Sleeper draft URL, draft id, or league id
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="draft-id"
              value={draftInput}
              onChange={(e) => setDraftInput(e.target.value)}
              placeholder="https://sleeper.com/draft/nfl/…"
              className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-2 font-mono text-sm"
            />
            <button
              onClick={loadSleeper}
              disabled={!draftInput || loading}
              className="rounded bg-panel-2 px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
          {derived && <p className="mt-2 text-sm text-live">{derived}</p>}
          {error && <p className="mt-2 text-sm text-warn">{error}</p>}
        </section>
      )}

      {mode === "manual" && (
        <section className="rounded-lg bg-panel p-4">
          <p className="text-sm font-medium text-ink-dim">League type</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => setConfig((c) => ({ ...c, ...DEFAULT_CONFIG, platform: "manual", myDraftSlot: c.myDraftSlot }))}
              aria-pressed={config.leagueType === "redraft"}
              className={`rounded px-3 py-2 text-sm font-semibold ${
                config.leagueType === "redraft" ? "bg-panel-2 text-ink" : "bg-field text-ink-dim hover:text-ink"
              }`}
            >
              Redraft (season-long)
            </button>
            {BESTBALL_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() =>
                  setConfig((c) => ({ ...c, platform: "manual", ...p.config }))
                }
                aria-pressed={config.leagueType === "bestball" && config.rounds === p.config.rounds}
                className={`rounded px-3 py-2 text-sm font-semibold ${
                  config.leagueType === "bestball" && config.rounds === p.config.rounds
                    ? "bg-panel-2 text-ink"
                    : "bg-field text-ink-dim hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {config.leagueType === "bestball" && (
            <p className="mt-2 text-sm text-ink-dim">
              Best ball: draft once, let it ride. The engine chases 2-3 QB / 5-6 RB / 7-9 WR / 2-3 TE,
              spaces them like a human (no QB hoarding), boosts QB-receiver stacks, and pays for
              ceiling — variance wins tournaments. Running a different size or scoring? Presets are
              starting points — adjust teams, rounds, and scoring below.
            </p>
          )}
        </section>
      )}

      {mode === "manual" && (
        <section className="grid grid-cols-2 gap-4 rounded-lg bg-panel p-4">
          <label className="text-sm text-ink-dim">
            Teams
            <input
              type="number"
              min={4}
              max={20}
              value={config.teams}
              onChange={(e) => setConfig((c) => ({ ...c, teams: Number(e.target.value) }))}
              className="mt-1 w-full rounded border border-line bg-field px-3 py-2 font-mono"
            />
          </label>
          <label className="text-sm text-ink-dim">
            Rounds
            <input
              type="number"
              min={8}
              max={20}
              value={config.rounds}
              onChange={(e) => setConfig((c) => ({ ...c, rounds: Number(e.target.value) }))}
              className="mt-1 w-full rounded border border-line bg-field px-3 py-2 font-mono"
            />
          </label>
          <label className="col-span-2 text-sm text-ink-dim">
            Scoring
            <select
              value={config.scoring}
              onChange={(e) =>
                setConfig((c) => ({ ...c, scoring: e.target.value as ScoringFormat }))
              }
              className="mt-1 w-full rounded border border-line bg-field px-3 py-2"
            >
              {SCORING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ["bonusRecTe", "TE premium", [["+0", 0], ["+0.5 / rec", 0.5], ["+1 / rec", 1]]],
              ["passTd", "Pass TD", [["4 pts", 4], ["6 pts", 6]]],
              ["passInt", "INT", [["−1", -1], ["−2", -2]]],
            ] as const
          ).map(([key, label, options]) => (
            <label key={key} className="text-sm text-ink-dim">
              {label}
              <select
                value={config.scoringTweaks?.[key] ?? options[0][1]}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    scoringTweaks: { ...c.scoringTweaks, [key]: Number(e.target.value) },
                  }))
                }
                className="mt-1 w-full rounded border border-line bg-field px-3 py-2"
              >
                {options.map(([lab, val]) => (
                  <option key={lab} value={val}>
                    {lab}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="col-span-2 -mt-1 text-xs text-ink-faint">
            Tweaks re-score every projection from raw stat lines. Points-per-first-down isn&apos;t
            supported — first-down projections aren&apos;t published anywhere free.
          </p>
        </section>
      )}

      <section className="rounded-lg bg-panel p-4">
        <p className="text-sm font-medium text-ink-dim">Your draft slot</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Array.from({ length: config.teams }, (_, i) => i + 1).map((slot) => (
            <button
              key={slot}
              onClick={() => setConfig((c) => ({ ...c, myDraftSlot: slot }))}
              aria-pressed={config.myDraftSlot === slot}
              className={`h-10 w-10 rounded font-mono text-sm font-medium ${
                config.myDraftSlot === slot
                  ? "bg-wr text-field"
                  : "bg-panel-2 text-ink-dim hover:text-ink"
              }`}
            >
              {slot}
            </button>
          ))}
        </div>
      </section>

      <button
        onClick={() => onDone(config)}
        disabled={!ready}
        className="rounded-lg bg-rb py-4 font-display text-2xl font-bold uppercase tracking-wide text-field disabled:opacity-30"
      >
        Open the cockpit
      </button>
      {!ready && (
        <p className="-mt-3 text-center text-sm text-ink-faint">
          {config.myDraftSlot == null
            ? "Pick your draft slot to continue."
            : "Load a Sleeper draft to continue."}
        </p>
      )}
    </main>
  );
}
