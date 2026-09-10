"use client";

import { useMemo, useState } from "react";
import type { Board, LeagueConfig } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";
import SleeperSync from "./SleeperSync";
import RosterPaste from "./RosterPaste";
import RosterScreenSync from "./RosterScreenSync";

type Tab = "manual" | "sleeper" | "paste" | "ocr";
const TABS: { id: Tab; label: string }[] = [
  { id: "manual", label: "Manual" }, { id: "sleeper", label: "Sleeper" }, { id: "paste", label: "Paste" }, { id: "ocr", label: "Screen sync" },
];

/**
 * The four ingestion paths live here and every one of them ends in
 * applyRoster, so undo, persistence and the engine all see one kind of roster
 * change — the same discipline as useDraft.applyImport for draft picks.
 */
export default function RosterImport({
  board,
  team,
  week,
  config,
  onChange,
}: {
  board: Board;
  team: SavedTeam;
  week: number;
  config: LeagueConfig;
  onChange: (t: SavedTeam) => void;
}) {
  const [tab, setTab] = useState<Tab>(team.source === "sleeper" ? "sleeper" : "manual");
  const [query, setQuery] = useState("");
  const onRoster = useMemo(() => new Set(team.roster.map((r) => r.playerId)), [team.roster]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return board.players
      .filter((p) => p.name.toLowerCase().includes(q) && !onRoster.has(p.id))
      .slice(0, 8);
  }, [query, board.players, onRoster]);

  const add = (id: string) => {
    onChange(applyRoster(team, [...team.roster.map((r) => r.playerId), id], "manual"));
    setQuery("");
  };
  const remove = (id: string) =>
    onChange(applyRoster(team, team.roster.map((r) => r.playerId).filter((x) => x !== id), "manual"));

  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">Your roster</h2>
      <div className="mt-2 flex gap-1 text-xs">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`rounded px-2 py-1 ${tab === t.id ? "bg-panel text-ink" : "text-ink-faint hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "sleeper" && <SleeperSync team={team} week={week} base={config} onChange={onChange} />}
      {tab === "paste" && <RosterPaste board={board} team={team} onChange={onChange} />}
      {tab === "ocr" && <RosterScreenSync board={board} team={team} onChange={onChange} />}

      {tab === "manual" && (<>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Add a player by name…"
        aria-label="Add a player by name"
        className="mt-3 w-full rounded border border-line bg-field px-2 py-1 text-sm"
      />
      {matches.length > 0 && (
        <ul className="mt-1 rounded border border-line text-sm">
          {matches.map((p) => (
            <li key={p.id}>
              <button onClick={() => add(p.id)} className="w-full px-2 py-1 text-left hover:bg-panel">
                {p.name} <span className="text-ink-faint">{p.pos} · {p.team}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      </>)}

      <p className="mt-3 text-xs text-ink-faint">{team.roster.length} players</p>
      <ul className="mt-1 flex flex-wrap gap-1">
        {team.roster.map((r) => {
          const p = board.players.find((x) => x.id === r.playerId);
          return (
            <li key={r.playerId} className="rounded bg-panel px-2 py-0.5 text-xs">
              {p?.name ?? r.playerId}
              <button onClick={() => remove(r.playerId)} className="ml-1 text-ink-faint hover:text-ink" aria-label={`Remove ${p?.name ?? r.playerId}`}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
