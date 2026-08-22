// FantasyPros public API — the one keyed source we support (user-supplied
// personal key). The key lives ONLY in .env.local (gitignored) and the GitHub
// Actions secret FANTASYPROS_API_KEY; it never touches the repo or browser.
// FP responses are never committed as fixtures (their terms; unlike the open
// sources). When the key is absent, everything here returns null and the
// build falls back to the DynastyProcess weekly mirror.
//
// The free tier caps every response at 10 players, so full coverage means
// batching explicit player-id lists (players=id:id:…) in chunks of 10, with
// ~1.2s spacing for their rate limiter. What the key buys:
//   - Daily consensus ECR per scoring format (103+ experts), full board depth
//   - A THIRD projection source: FP consensus stat lines per player

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScoringFormat, StatLine } from "../types";

/** Populate process.env from .env.local (KEY=VALUE lines) without a dep. */
export function loadEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const BASE = "https://api.fantasypros.com/public/v2/json/nfl";
const CHUNK = 10; // free-tier response cap
const SPACING_MS = 2500; // free-tier rate limiter is aggressive
/** Board depth to pull per-format ECR for — rounds 1-8ish, where ECR moves matter. */
const ECR_DEPTH = 100;
/** Depth for the projections pass (format-independent, one pass total). */
const PROJ_DEPTH = 150;
/** Stop after this many consecutive failures — the daily quota is spent. */
const ABORT_AFTER = 3;

let lastCall = 0;
async function throttled(url: string, key: string): Promise<Response> {
  const wait = lastCall + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  let res = await fetch(url, { headers: { "x-api-key": key } });
  if (res.status === 403 || res.status === 429) {
    // one backoff retry — their limiter is bursty
    await new Promise((r) => setTimeout(r, 4000));
    lastCall = Date.now();
    res = await fetch(url, { headers: { "x-api-key": key } });
  }
  return res;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const num = (v: string | number | null | undefined): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return n != null && Number.isFinite(n) ? n : null;
};

export interface FpEcr {
  ecr: number;
  ecrStdev: number | null;
}

export interface FpData {
  experts: number;
  /** per format: fantasypros_id → consensus rank */
  ecr: Record<ScoringFormat, Map<string, FpEcr>>;
  /** fantasypros_id → consensus projected stat line */
  stats: Map<string, StatLine>;
}

const FP_SCORING: Record<ScoringFormat, string> = {
  standard: "STD",
  "half-ppr": "HALF",
  ppr: "PPR",
  "2qb": "PPR", // no 2QB scoring param; PPR is the closest base
};

/** Map FP projection stat keys onto our StatLine. Exported for tests. */
export function mapFpStats(s: Record<string, number | string | null>): StatLine {
  const g = (k: string) => num(s[k]) ?? undefined;
  const out: StatLine = {
    passYds: g("pass_yds"),
    passTD: g("pass_tds"),
    passInt: g("pass_ints"),
    rushYds: g("rush_yds"),
    rushTD: g("rush_tds"),
    receptions: g("rec_rec"),
    recYds: g("rec_yds"),
    recTD: g("rec_tds"),
    fumblesLost: g("fumbles") ?? g("fumbles_lost"),
  };
  for (const k of Object.keys(out) as (keyof StatLine)[]) {
    if (out[k] === undefined || out[k] === 0) delete out[k];
  }
  return out;
}

/**
 * Pull everything the free key allows, batched. `fpIds` should be draft-pool
 * FantasyPros ids in rough draft order (the ECR csv provides exactly that).
 * Returns null when no key is configured.
 */
export async function fetchFantasyProsData(
  season: number,
  fpIds: string[]
): Promise<FpData | null> {
  const key = process.env.FANTASYPROS_API_KEY;
  if (!key) return null;

  const data: FpData = {
    experts: 0,
    ecr: { standard: new Map(), "half-ppr": new Map(), ppr: new Map(), "2qb": new Map() },
    stats: new Map(),
  };
  let failures = 0;
  let consecutive = 0;
  const quotaSpent = () => consecutive >= ABORT_AFTER;

  try {
    // Projections: one pass, format-independent raw stats.
    for (const batch of chunks(fpIds.slice(0, PROJ_DEPTH), CHUNK)) {
      if (quotaSpent()) break;
      const res = await throttled(
        `${BASE}/${season}/projections?week=0&players=${batch.join(":")}`,
        key
      );
      if (!res.ok) {
        failures++;
        consecutive++;
        continue;
      }
      consecutive = 0;
      const json = (await res.json()) as {
        players?: { fpid: number; stats?: Record<string, number> }[];
      };
      for (const p of json.players ?? []) {
        if (p.fpid && p.stats) data.stats.set(String(p.fpid), mapFpStats(p.stats));
      }
    }

    // Consensus ECR per scoring format (2qb shares PPR — fetched once, reused).
    const fetched = new Map<string, Map<string, FpEcr>>();
    for (const format of ["standard", "half-ppr", "ppr", "2qb"] as ScoringFormat[]) {
      const scoring = FP_SCORING[format];
      if (fetched.has(scoring)) {
        data.ecr[format] = fetched.get(scoring)!;
        continue;
      }
      const map = new Map<string, FpEcr>();
      for (const batch of chunks(fpIds.slice(0, ECR_DEPTH), CHUNK)) {
        if (quotaSpent()) break;
        const res = await throttled(
          `${BASE}/${season}/consensus-rankings?type=DRAFT&scoring=${scoring}&position=ALL&players=${batch.join(":")}`,
          key
        );
        if (!res.ok) {
          failures++;
          consecutive++;
          continue;
        }
        consecutive = 0;
        const json = (await res.json()) as {
          total_experts?: number;
          players?: {
            player_id: number;
            rank_ave?: string | number;
            rank_std?: string | number;
          }[];
        };
        data.experts = Math.max(data.experts, json.total_experts ?? 0);
        for (const p of json.players ?? []) {
          const ecr = num(p.rank_ave);
          if (p.player_id && ecr != null) {
            map.set(String(p.player_id), { ecr, ecrStdev: num(p.rank_std) });
          }
        }
      }
      fetched.set(scoring, map);
      data.ecr[format] = map;
    }
  } catch (err) {
    console.warn(`⚠️  fantasypros: batch run aborted (${err}) — using what was fetched so far`);
  }

  const total = data.ecr.ppr.size;
  if (total === 0 && data.stats.size === 0) {
    console.warn("⚠️  fantasypros: no usable data returned — falling back to DynastyProcess ECR");
    return null;
  }
  if (quotaSpent())
    console.warn("⚠️  fantasypros: aborted early — free-tier quota appears spent; using partials + fallback");
  else if (failures > 0)
    console.warn(`⚠️  fantasypros: ${failures} batch requests failed (rate limits?)`);
  return data;
}
