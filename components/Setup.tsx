"use client";

// First-run setup. Sleeper mode auto-derives everything it can from the API —
// typed values are the fallback, not the source of truth.

import { useEffect, useState } from "react";
import type { LeagueConfig, Position, ScoringFormat } from "../lib/types";
import { fetchDraftInfo, parseDraftId, fetchLeagueDrafts } from "../lib/draft/sleeper";
import { DEFAULT_CONFIG, BESTBALL_PRESETS } from "../lib/client/config";
import { loadPresets, savePreset, deletePreset, shareUrl, type SavedPreset } from "../lib/client/presets";
import { loadHistory, deleteDraft, type SavedDraft } from "../lib/client/history";
import { loadSources, saveSources, DEFAULT_SOURCES, type SourcePrefs } from "../lib/client/sources";

const SCORING_OPTIONS: { value: ScoringFormat; label: string }[] = [
  { value: "ppr", label: "PPR" },
  { value: "half-ppr", label: "Half PPR" },
  { value: "standard", label: "Standard" },
  { value: "2qb", label: "2QB / Superflex" },
];

export default function Setup({
  onDone,
  initialConfig,
  onViewDraft,
}: {
  onDone: (config: LeagueConfig) => void;
  /** A config decoded from a shared link — prefills everything. */
  initialConfig?: LeagueConfig | null;
  onViewDraft: (draft: SavedDraft) => void;
}) {
  const [mode, setMode] = useState<"sleeper" | "manual">(initialConfig?.platform ?? "sleeper");
  const [draftInput, setDraftInput] = useState("");
  const [config, setConfig] = useState<LeagueConfig>(initialConfig ?? DEFAULT_CONFIG);
  const [derived, setDerived] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [presets, setPresets] = useState<SavedPreset[]>([]);
  const [history, setHistory] = useState<SavedDraft[]>([]);
  const [presetName, setPresetName] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const [sources, setSources] = useState<SourcePrefs>(DEFAULT_SOURCES);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration
    setPresets(loadPresets());
    setHistory(loadHistory());
    setSources(loadSources());
  }, []);

  function updateSources(next: SourcePrefs) {
    setSources(next);
    saveSources(next);
  }

  function copyShare(cfg: LeagueConfig, id: string) {
    navigator.clipboard
      .writeText(shareUrl(cfg))
      .then(() => {
        setCopied(id);
        setTimeout(() => setCopied(null), 1800);
      })
      .catch(() => setError("Couldn't copy — your browser blocked clipboard access."));
  }

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

      {initialConfig && (
        <p className="rounded-lg bg-panel px-3 py-2 text-sm text-live">
          Shared setup loaded — everything below is prefilled. Check your draft slot and go.
        </p>
      )}

      {presets.length > 0 && (
        <section className="rounded-lg bg-panel p-4">
          <p className="text-sm font-medium text-ink-dim">Your presets</p>
          <ul className="mt-2 space-y-1.5">
            {presets.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setConfig(p.config);
                    setMode(p.config.platform);
                  }}
                  className="rounded bg-panel-2 px-3 py-1.5 text-sm font-semibold hover:bg-field"
                  title="Apply this preset"
                >
                  {p.name}
                </button>
                <span className="font-mono text-[11px] text-ink-faint">
                  {p.config.teams}tm · {p.config.scoring} ·{" "}
                  {p.config.leagueType === "bestball" ? "best ball" : "redraft"}
                </span>
                <button
                  onClick={() => copyShare(p.config, p.id)}
                  className="ml-auto text-xs text-wr hover:underline"
                  title="Copy a link that applies this setup for anyone"
                >
                  {copied === p.id ? "Copied!" : "Share link"}
                </button>
                <button
                  onClick={() => setPresets(deletePreset(p.id))}
                  aria-label={`Delete preset ${p.name}`}
                  className="font-mono text-xs text-ink-faint hover:text-warn"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
              ["ppfd", "Per first down", [["+0", 0], ["+0.5", 0.5], ["+1", 1]]],
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
            Tweaks re-score every projection from raw stat lines. First-down scoring (PPFD) uses
            Sleeper&apos;s projected first downs — keep the projection source on Sleeper or Blend
            for it to count.
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

      {/* Advanced: every dial. Defaults are sane — open only when your league is weird. */}
      <details className="rounded-lg bg-panel p-4">
        <summary className="cursor-pointer text-sm font-medium text-ink-dim">
          Advanced — roster slots &amp; format dials
        </summary>
        <p className="mt-2 text-xs text-ink-faint">
          Set a position to 0 to remove it from the league entirely (many best-ball formats have no
          K or DST — the engine and board drop them completely).
        </p>
        <div className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-7">
          {(["QB", "RB", "WR", "TE", "FLEX", "K", "DST"] as (Position | "FLEX")[]).map((slot) => (
            <label key={slot} className="text-center font-mono text-xs text-ink-dim">
              {slot}
              <input
                type="number"
                min={0}
                max={6}
                value={config.rosterSlots[slot] ?? 0}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    rosterSlots: {
                      ...c.rosterSlots,
                      [slot]: Math.min(6, Math.max(0, Number(e.target.value))),
                    },
                  }))
                }
                className="mt-1 w-full rounded border border-line bg-field px-1 py-1.5 text-center"
              />
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          These are the weekly lineup slots. Bench size is rounds minus starters, automatically.
        </p>

        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium text-ink-dim">Data sources</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-dim">
              Projections
              <select
                value={sources.projections}
                onChange={(e) =>
                  updateSources({ ...sources, projections: e.target.value as SourcePrefs["projections"] })
                }
                className="mt-1 w-full rounded border border-line bg-field px-3 py-2 text-sm"
              >
                <option value="blend">Blend all available (recommended)</option>
                <option value="espn">ESPN only</option>
                <option value="sleeper">Sleeper only</option>
                <option value="fp">FantasyPros consensus (keyed builds)</option>
              </select>
            </label>
            <label className="text-xs text-ink-dim">
              ADP (market prices)
              <select
                value={sources.adp}
                onChange={(e) => updateSources({ ...sources, adp: e.target.value as SourcePrefs["adp"] })}
                className="mt-1 w-full rounded border border-line bg-field px-3 py-2 text-sm"
              >
                <option value="ffc">Fantasy Football Calculator (recommended)</option>
                <option value="sleeper">Sleeper</option>
                <option value="espn">ESPN</option>
                <option value="blend">Blend all three</option>
              </select>
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm text-ink-dim">
            <input
              type="checkbox"
              checked={sources.trending}
              onChange={(e) => updateSources({ ...sources, trending: e.target.checked })}
            />
            Show 🔥 on trending players (most-added on Sleeper, last 24h)
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm text-ink-dim">
            <input
              type="checkbox"
              checked={sources.wire}
              onChange={(e) => updateSources({ ...sources, wire: e.target.checked })}
            />
            Insider wire — poll NFL reporters on Bluesky for breaking posts (free)
          </label>
          {sources.wire && (
            <label className="mt-1 block text-xs text-ink-dim">
              Wire handles (one per line; blank = the default insiders)
              <textarea
                rows={3}
                value={sources.wireHandles.join("\n")}
                onChange={(e) =>
                  updateSources({
                    ...sources,
                    wireHandles: e.target.value
                      .split("\n")
                      .map((h) => h.trim().replace(/^@/, ""))
                      .filter(Boolean),
                  })
                }
                placeholder={"rapsheet.bsky.social\nfieldyates.bsky.social\nrotoworld-fb.bsky.social"}
                className="mt-1 w-full rounded border border-line bg-field px-3 py-2 font-mono text-xs"
              />
            </label>
          )}
          <p className="mt-1 text-xs text-ink-faint">
            FFC stays the uncertainty model either way — it&apos;s the only source that publishes
            per-player ADP spread, which powers the survival math. These apply everywhere, not per
            league.
          </p>
        </div>
      </details>

      {/* Save & share this exact setup — no accounts, the link IS the config. */}
      <section className="flex flex-wrap items-center gap-2 rounded-lg bg-panel p-3">
        <input
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          placeholder="Preset name (e.g. Work league)"
          className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-2 text-sm"
          aria-label="Preset name"
        />
        <button
          onClick={() => {
            if (!presetName.trim()) return;
            setPresets(savePreset(presetName.trim(), config));
            setPresetName("");
          }}
          disabled={!presetName.trim()}
          className="rounded bg-panel-2 px-3 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Save preset
        </button>
        <button
          onClick={() => copyShare(config, "current")}
          className="rounded bg-panel-2 px-3 py-2 text-sm font-semibold text-wr"
          title="Copy a link that applies this exact setup for anyone"
        >
          {copied === "current" ? "Copied!" : "Share this setup"}
        </button>
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

      {history.length > 0 && (
        <section className="rounded-lg bg-panel p-4">
          <p className="text-sm font-medium text-ink-dim">Previous drafts</p>
          <ul className="mt-2 space-y-1.5">
            {history.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => onViewDraft(d)}
                  className="truncate text-left hover:underline"
                  title="Open this draft's recap"
                >
                  {d.name}
                </button>
                <span className="font-mono text-[11px] text-ink-faint">
                  {d.picks.length} picks{d.completed ? "" : " · unfinished"} ·{" "}
                  {new Date(d.savedAt).toLocaleDateString()}
                </span>
                <button
                  onClick={() => onViewDraft(d)}
                  className="ml-auto text-xs text-wr hover:underline"
                >
                  Recap
                </button>
                <button
                  onClick={() => setHistory(deleteDraft(d.id))}
                  aria-label={`Delete draft ${d.name}`}
                  className="font-mono text-xs text-ink-faint hover:text-warn"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
