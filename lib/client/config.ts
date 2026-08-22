"use client";

import type { LeagueConfig } from "../types";

const KEY = "draft-cockpit-config-v1";
const STRATEGY_KEY = "draft-cockpit-custom-strategy-v1";

export const DEFAULT_CONFIG: LeagueConfig = {
  platform: "manual",
  leagueId: "",
  draftId: "",
  myDraftSlot: null,
  teams: 12,
  rounds: 15,
  scoring: "ppr",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"],
  strategy: "balanced",
};

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
  lambda: number;
  baselineBlend: number;
  adpDiscipline: number;
  earlyRb: number; // rounds 1-5 RB multiplier
  earlyWr: number; // rounds 1-5 WR multiplier
}

export const DEFAULT_CUSTOM: CustomStrategyParams = {
  lambda: 0.5,
  baselineBlend: 0.5,
  adpDiscipline: 0.5,
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
