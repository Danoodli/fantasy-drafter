"use client";

import { useMemo, useState } from "react";
import type { Board, LeagueConfig } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";
import SleeperSync from "./SleeperSync";
import RosterPaste from "./RosterPaste";
import RosterScreenSync from "./RosterScreenSync";
import LowerThird from "../ui/LowerThird";
import Sticker from "../ui/Sticker";

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
    <section className="space-y-3">
      <LowerThird headline="Your roster" />
      <div className="flex gap-1 px-1 text-xs">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`btn ${tab === t.id ? "btn-accent" : "btn-quiet"}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-1">
        {tab === "sleeper" && <SleeperSync team={team} week={week} base={config} onChange={onChange} />}
        {tab === "paste" && <RosterPaste board={board} team={team} onChange={onChange} />}
        {tab === "ocr" && <RosterScreenSync board={board} team={team} onChange={onChange} />}

        {tab === "manual" && (<>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add a player"
          aria-label="Add a player"
          className="mt-3 w-full rounded bg-field px-2 py-1 text-sm"
        />
        {matches.length > 0 && (
          <ul className="mt-1 space-y-1 text-sm">
            {matches.map((p) => (
              <li key={p.id}>
                <Sticker pos={p.pos} as="row" onClick={() => add(p.id)}>
                  {p.name} <span className="text-ink-faint">{p.pos} · {p.team}</span>
                </Sticker>
              </li>
            ))}
          </ul>
        )}
        </>)}

        {team.roster.length === 0 ? (
          <p className="mt-3 text-sm text-ink-dim">Your roster is empty. Sync a Sleeper league, paste a roster page, or add players by name.</p>
        ) : (
          <>
            <p className="mt-3 text-xs text-ink-faint">{team.roster.length} players</p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {team.roster.map((r) => {
                const p = board.players.find((x) => x.id === r.playerId);
                return (
                  <li key={r.playerId}>
                    <Sticker pos={p?.pos ?? null} as="chip">
                      {p?.name ?? r.playerId}
                      <button onClick={() => remove(r.playerId)} className="btn btn-quiet" aria-label={`Remove ${p?.name ?? r.playerId}`}>
                        ×
                      </button>
                    </Sticker>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
