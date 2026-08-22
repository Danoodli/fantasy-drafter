"use client";

// Root: load config + board, then hand off to the cockpit.
// The board is one static JSON file — cached by the browser, works offline
// after first load. No server calls on the hot path.

import { useEffect, useState } from "react";
import type { Board, LeagueConfig, Strategy } from "../lib/types";
import { loadConfig, saveConfig, clearConfig } from "../lib/client/config";
import { SCORING_PRESETS, scoringFromSleeper } from "../lib/scoring";
import { rescoreBoard, scoringDiffers } from "../lib/client/rescore";
import Setup from "../components/Setup";
import Cockpit from "../components/Cockpit";
import strategiesJson from "../config/strategies.json";

const strategies = strategiesJson as Strategy[];

export default function Page() {
  const [config, setConfig] = useState<LeagueConfig | null | "unset">("unset");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // localStorage is only readable after mount — the one-time hydration
    // setState here is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(loadConfig());
  }, []);

  useEffect(() => {
    if (!config || config === "unset") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/data/board-${config.scoring}.json`);
        if (!res.ok) throw new Error(`board fetch: HTTP ${res.status}`);
        let b: Board = await res.json();
        // Manual-mode scoring tweaks (TE premium, 6-pt pass TD, INT severity)
        // re-score the board from raw stat lines, client-side.
        const tweaks = config.scoringTweaks;
        if (config.platform === "manual" && tweaks) {
          const settings = {
            ...SCORING_PRESETS[config.scoring],
            ...(tweaks.passTd != null ? { pass_td: tweaks.passTd } : {}),
            ...(tweaks.passInt != null ? { pass_int: tweaks.passInt } : {}),
            ...(tweaks.bonusRecTe ? { bonus_rec_te: tweaks.bonusRecTe } : {}),
          };
          if (scoringDiffers(settings, b.meta.scoring)) b = rescoreBoard(b, settings, config);
        }
        // Real league scoring beats the preset the board was built with.
        if (config.platform === "sleeper" && config.leagueId) {
          try {
            const lres = await fetch(`https://api.sleeper.app/v1/league/${config.leagueId}`);
            if (lres.ok) {
              const league = await lres.json();
              const real = scoringFromSleeper(
                league.scoring_settings ?? {},
                SCORING_PRESETS[config.scoring]
              );
              if (scoringDiffers(real, b.meta.scoring)) {
                b = rescoreBoard(b, real, config);
              }
            }
          } catch {
            // offline or mock draft — preset scoring stands
          }
        }
        if (!cancelled) setBoard(b);
      } catch (err) {
        if (!cancelled)
          setError(
            `The board file is missing (${(err as Error).message}). Run pnpm build:board, then reload.`
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  if (config === "unset") return null;

  if (!config) {
    return (
      <Setup
        onDone={(c) => {
          saveConfig(c);
          setConfig(c);
        }}
      />
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-xl px-6 py-24">
        <h1 className="font-display text-3xl font-bold uppercase">No board</h1>
        <p className="mt-3 text-ink-dim">{error}</p>
      </main>
    );
  }

  if (!board) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="font-mono text-sm text-ink-dim">Loading board…</p>
      </main>
    );
  }

  return (
    <Cockpit
      board={board}
      config={config}
      strategies={strategies}
      onReconfigure={() => {
        clearConfig();
        setConfig(null);
        setBoard(null);
      }}
    />
  );
}
