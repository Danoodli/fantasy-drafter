// FantasyPros consensus rankings — the one keyed source we support, because
// the user supplied a personal API key. The key lives ONLY in .env.local
// (gitignored) and the GitHub Actions secret FANTASYPROS_API_KEY; it never
// touches the repo or the browser. When absent, the build skips this source
// silently and the weekly DynastyProcess ECR mirror remains the fallback.
//
// FantasyPros' terms are personal/non-commercial: their responses are NOT
// committed as fixtures (unlike the open sources) — no key, no data.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScoringFormat } from "../types";

/** Populate process.env from .env.local (KEY=VALUE lines) without a dep. */
export function loadEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

export interface FpRank {
  fpId: string;
  name: string;
  ecr: number;
  ecrStdev: number | null;
  bestRank: number | null;
  worstRank: number | null;
}

const FP_SCORING: Record<ScoringFormat, string> = {
  standard: "STD",
  "half-ppr": "HALF",
  ppr: "PPR",
  "2qb": "PPR", // FP has no 2QB draft scoring param; PPR is the closest base
};

/**
 * Draft consensus rankings for a format. Returns null when no key is set or
 * the request fails — callers fall back to the DynastyProcess mirror.
 */
export async function fetchFantasyProsEcr(
  season: number,
  format: ScoringFormat
): Promise<{ ranks: FpRank[]; experts: number } | null> {
  const key = process.env.FANTASYPROS_API_KEY;
  if (!key) return null;
  try {
    const url =
      `https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings` +
      `?type=draft&scoring=${FP_SCORING[format]}&position=ALL&week=0`;
    const res = await fetch(url, { headers: { "x-api-key": key } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      total_experts?: number;
      players?: {
        player_id: number;
        player_name: string;
        rank_ave?: string | number;
        rank_std?: string | number;
        rank_min?: string | number;
        rank_max?: string | number;
      }[];
    };
    const players = json.players ?? [];
    if (players.length < 100) throw new Error(`only ${players.length} ranked players`);
    const num = (v: string | number | undefined): number | null => {
      const n = typeof v === "string" ? parseFloat(v) : v;
      return n != null && Number.isFinite(n) ? n : null;
    };
    return {
      experts: json.total_experts ?? 0,
      ranks: players
        .map((p) => ({
          fpId: String(p.player_id),
          name: p.player_name,
          ecr: num(p.rank_ave) ?? 0,
          ecrStdev: num(p.rank_std),
          bestRank: num(p.rank_min),
          worstRank: num(p.rank_max),
        }))
        .filter((r) => r.ecr > 0),
    };
  } catch (err) {
    console.warn(`⚠️  fantasypros: fetch failed (${err}) — falling back to DynastyProcess ECR`);
    return null;
  }
}
