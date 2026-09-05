"use client";

import type { LeagueConfig } from "../types";

// v2: leagueType added — the version bump routes existing users through
// setup once so they see the new format picker.
const KEY = "draft-cockpit-config-v2";
const STRATEGY_KEY = "draft-cockpit-custom-strategy-v1";

export const DEFAULT_CONFIG: LeagueConfig = {
  platform: "manual",
  leagueId: "",
  draftId: "",
  myDraftSlot: null,
  teams: 12,
  rounds: 15,
  scoring: "ppr",
  leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"],
  strategy: "balanced",
};

/**
 * Strategy the app selects on its own, per league type. Backed by
 * `pnpm backtest:season` across 2024 and 2025: two-year mean realized-points
 * delta vs an ADP bot in the same seat was Robust RB +321 in best ball (vs
 * Tournament Ceiling +169, the previous default) and Balanced +184 in redraft.
 */
export const BESTBALL_DEFAULT_STRATEGY = "robust-rb";
export const REDRAFT_DEFAULT_STRATEGY = "balanced";

/** The strategy id to auto-select for a league type. */
export function defaultStrategyFor(leagueType: LeagueConfig["leagueType"]): string {
  return leagueType === "bestball" ? BESTBALL_DEFAULT_STRATEGY : REDRAFT_DEFAULT_STRATEGY;
}

/** Common best-ball tournament formats, selectable in manual setup. */
export const BESTBALL_PRESETS: {
  id: string;
  label: string;
  config: Partial<LeagueConfig>;
}[] = [
  {
    id: "underdog",
    label: "Underdog (12tm · 18rd · half-PPR)",
    config: {
      leagueType: "bestball",
      teams: 12,
      rounds: 18,
      scoring: "half-ppr",
      rosterSlots: { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
      strategy: BESTBALL_DEFAULT_STRATEGY,
    },
  },
  {
    id: "draftkings",
    label: "DraftKings (12tm · 20rd · PPR)",
    config: {
      leagueType: "bestball",
      teams: 12,
      rounds: 20,
      scoring: "ppr",
      rosterSlots: { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
      strategy: BESTBALL_DEFAULT_STRATEGY,
    },
  },
];

export function loadConfig(): LeagueConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

export function saveConfig(config: LeagueConfig) {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function clearConfig() {
  localStorage.removeItem(KEY);
}

export interface CustomStrategyParams {
  lambda: number; // negative = pay for variance (tournaments)
  baselineBlend: number;
  adpDiscipline: number;
  stacking: number; // QB↔pass-catcher stack bonus, 0–1.5
  earlyRb: number; // rounds 1-5 RB multiplier
  earlyWr: number; // rounds 1-5 WR multiplier
}

export const DEFAULT_CUSTOM: CustomStrategyParams = {
  lambda: 0.5,
  baselineBlend: 0.5,
  adpDiscipline: 0.5,
  stacking: 0,
  earlyRb: 1,
  earlyWr: 1,
};

export function loadCustomStrategy(): CustomStrategyParams {
  try {
    const raw = localStorage.getItem(STRATEGY_KEY);
    return raw ? { ...DEFAULT_CUSTOM, ...JSON.parse(raw) } : DEFAULT_CUSTOM;
  } catch {
    return DEFAULT_CUSTOM;
  }
}

export function saveCustomStrategy(params: CustomStrategyParams) {
  localStorage.setItem(STRATEGY_KEY, JSON.stringify(params));
}
