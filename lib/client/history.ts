// Draft history — every draft you run, saved on-device (localStorage: bigger
// and cheaper than cookies, never sent over the wire). Each entry keeps the
// full pick list plus the exact config it was drafted under, so old drafts
// replay through the recap screen with the right scoring and format.

import type { DraftPick, LeagueConfig, TradedPick } from "../types";

export interface SavedDraft {
  id: string; // one entry per draft session (config fingerprint + start time)
  name: string;
  config: LeagueConfig;
  mySlot: number;
  picks: DraftPick[];
  tradedPicks: TradedPick[];
  completed: boolean;
  savedAt: string; // ISO — last update
}

const KEY = "draft-cockpit-history-v1";
const MAX_DRAFTS = 40;

export function loadHistory(): SavedDraft[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedDraft[]) : [];
  } catch {
    return [];
  }
}

function label(config: LeagueConfig): string {
  const type = config.leagueType === "bestball" ? "Best ball" : "Redraft";
  return `${type} · ${config.teams}tm ${config.scoring} · slot ${config.myDraftSlot ?? "?"}`;
}

/** Insert or update the entry for this draft session. */
export function upsertDraft(
  id: string,
  config: LeagueConfig,
  picks: DraftPick[],
  tradedPicks: TradedPick[],
  completed: boolean
): void {
  try {
    const history = loadHistory().filter((d) => d.id !== id);
    history.unshift({
      id,
      name: label(config),
      config,
      mySlot: config.myDraftSlot ?? 1,
      picks,
      tradedPicks,
      completed,
      savedAt: new Date().toISOString(),
    });
    localStorage.setItem(KEY, JSON.stringify(history.slice(0, MAX_DRAFTS)));
  } catch {
    // storage full — history degrades, drafting continues
  }
}

export function deleteDraft(id: string): SavedDraft[] {
  const history = loadHistory().filter((d) => d.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    // ignore
  }
  return history;
}
