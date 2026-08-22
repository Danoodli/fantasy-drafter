// Named league presets + shareable config links. No auth, no server:
// presets live in localStorage; sharing encodes the entire config into the
// URL itself (?c=…), so a pasted link auto-applies on the other end.

import type { LeagueConfig } from "../types";
import { DEFAULT_CONFIG } from "./config";

export interface SavedPreset {
  id: string;
  name: string;
  config: LeagueConfig;
  savedAt: string; // ISO
}

const KEY = "draft-cockpit-presets-v1";

export function loadPresets(): SavedPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedPreset[]) : [];
  } catch {
    return [];
  }
}

export function savePreset(name: string, config: LeagueConfig): SavedPreset[] {
  const presets = loadPresets().filter((p) => p.name !== name); // overwrite by name
  presets.unshift({
    id: `${Date.now().toString(36)}-${presets.length}`,
    name,
    config,
    savedAt: new Date().toISOString(),
  });
  localStorage.setItem(KEY, JSON.stringify(presets.slice(0, 20)));
  return loadPresets();
}

export function deletePreset(id: string): SavedPreset[] {
  const presets = loadPresets().filter((p) => p.id !== id);
  localStorage.setItem(KEY, JSON.stringify(presets));
  return presets;
}

// ---------------------------------------------------------------------------
// Share links — pure functions (base64url over JSON), unit-testable in node.

export function encodeConfig(config: LeagueConfig): string {
  const json = JSON.stringify(config);
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(json)))
      : Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeConfig(encoded: string): LeagueConfig | null {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<LeagueConfig>;
    if (typeof parsed !== "object" || parsed == null) return null;
    // Merge over defaults so old links survive config-shape changes; clamp
    // the numeric fields so a mangled link can't wedge the app.
    const merged: LeagueConfig = { ...DEFAULT_CONFIG, ...parsed };
    merged.teams = Math.min(24, Math.max(2, Math.round(merged.teams || 12)));
    merged.rounds = Math.min(30, Math.max(4, Math.round(merged.rounds || 15)));
    for (const k of Object.keys(merged.rosterSlots)) {
      merged.rosterSlots[k] = Math.min(6, Math.max(0, Math.round(merged.rosterSlots[k] || 0)));
    }
    return merged;
  } catch {
    return null;
  }
}

export function shareUrl(config: LeagueConfig): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return `${base}/?c=${encodeConfig(config)}`;
}
