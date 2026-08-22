"use client";

// Root: load config + board, then hand off to the cockpit.
// The board is one static JSON file — cached by the browser, works offline
// after first load. No server calls on the hot path.

import { useEffect, useState } from "react";
import type { Board, LeagueConfig, Strategy } from "../lib/types";
import { loadConfig, saveConfig, clearConfig } from "../lib/client/config";
import { SCORING_PRESETS, scoringFromSleeper } from "../lib/scoring";
import { rescoreBoard, scoringDiffers } from "../lib/client/rescore";
import { loadSources } from "../lib/client/sources";
import { decodeConfig } from "../lib/client/presets";
import type { SavedDraft } from "../lib/client/history";
import Setup from "../components/Setup";
import Cockpit from "../components/Cockpit";
import Recap from "../components/Recap";
import strategiesJson from "../config/strategies.json";

/** Recap of a saved draft: loads the board that config needs, then renders. */
function HistoryRecap({ draft, onClose }: { draft: SavedDraft; onClose: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/data/board-${draft.config.scoring}.json`)
      .then((r) => r.json())
      .then((b) => !cancelled && setBoard(b))
      .catch(() => !cancelled && setBoard(null));
    return () => {
      cancelled = true;
    };
  }, [draft.config.scoring]);
  if (!board) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="font-mono text-sm text-ink-dim">Loading board…</p>
      </main>
    );
  }
  return (
    <Recap
      board={board}
      config={draft.config}
      picks={draft.picks}
      tradedPicks={draft.tradedPicks ?? []}
      mySlot={draft.mySlot}
      draftOver
      onClose={onClose}
    />
  );
}

const strategies = strategiesJson as Strategy[];

export default function Page() {
  const [config, setConfig] = useState<LeagueConfig | null | "unset">("unset");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<LeagueConfig | null>(null);
  const [viewingDraft, setViewingDraft] = useState<SavedDraft | null>(null);

  useEffect(() => {
    // A shared link carries the whole config in the URL — decode it, show
    // setup prefilled, and clean the address bar. Otherwise hydrate the
    // saved config. (One-time localStorage/URL read after mount.)
    const param = new URLSearchParams(window.location.search).get("c");
    const decoded = param ? decodeConfig(param) : null;
    if (decoded) {
      window.history.replaceState(null, "", window.location.pathname);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShared(decoded);
      setConfig(null); // force setup, prefilled with the shared values
      return;
    }
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
        // Resolve the scoring settings this league actually uses…
        let settings = { ...SCORING_PRESETS[config.scoring] };
        const tweaks = config.scoringTweaks;
        if (config.platform === "manual" && tweaks) {
          if (tweaks.passTd != null) settings.pass_td = tweaks.passTd;
          if (tweaks.passInt != null) settings.pass_int = tweaks.passInt;
          if (tweaks.bonusRecTe) settings.bonus_rec_te = tweaks.bonusRecTe;
          if (tweaks.ppfd) {
            settings.rush_fd = tweaks.ppfd;
            settings.rec_fd = tweaks.ppfd;
          }
        }
        if (config.platform === "sleeper" && config.leagueId) {
          try {
            const lres = await fetch(`https://api.sleeper.app/v1/league/${config.leagueId}`);
            if (lres.ok) {
              const league = await lres.json();
              settings = scoringFromSleeper(league.scoring_settings ?? {}, settings);
            }
          } catch {
            // offline or mock draft — preset scoring stands
          }
        }
        // …then apply scoring + data-source preferences in one pass.
        const prefs = loadSources();
        if (
          scoringDiffers(settings, b.meta.scoring) ||
          prefs.projections !== "espn" ||
          prefs.adp !== "ffc"
        ) {
          b = rescoreBoard(b, settings, config, prefs);
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

  if (viewingDraft) {
    return <HistoryRecap draft={viewingDraft} onClose={() => setViewingDraft(null)} />;
  }

  if (config === "unset") return null;

  if (!config) {
    return (
      <Setup
        initialConfig={shared}
        onViewDraft={setViewingDraft}
        onDone={(c) => {
          saveConfig(c);
          setConfig(c);
          setShared(null);
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
