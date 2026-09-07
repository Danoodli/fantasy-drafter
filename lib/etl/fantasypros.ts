// FantasyPros public API — the one keyed source we support (user-supplied
// personal key). The key lives ONLY in .env.local (gitignored) and the GitHub
// Actions secret FANTASYPROS_API_KEY; it never touches the repo or browser.
// FP responses are never committed as fixtures (their terms; unlike the open
// sources). When the key is absent, everything here returns null and the
// build falls back to the DynastyProcess weekly mirror.
//
// The free tier caps every response at 10 players AND the key at roughly ten
// requests a day (measured 2026-08-23/25: nine or ten successes per fresh
// day, then "LimitExceededException" for everything, including a single
// request hours later). So the daily lane spends those calls deliberately —
// see planFpBudget: the news endpoint first (exact fpid matches), then PPR
// consensus for the top of the board; projections only when a bigger budget
// is configured (FANTASYPROS_DAILY_BUDGET, for a paid tier).

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
const SPACING_MS = 6000; // their throttle rejected 2.5 s spacing in bursts; one call per 6 s is clean
/** Requests the key may make per build. Free tier ≈ 10/day; a paid key can raise it via env. */
export const FP_DAILY_BUDGET = Math.max(0, Number(process.env.FANTASYPROS_DAILY_BUDGET ?? 9));
/** Stop after this many consecutive failures — the daily quota is spent. */
const ABORT_AFTER = 2;

export interface FpPlan {
  /** Fetch the news endpoint (1 request). */
  news: boolean;
  /** PPR consensus chunks of 10 players, top of the board first. */
  ecrChunks: number;
  /** Projection chunks of 10 players — only with a budget beyond the free tier. */
  projChunks: number;
}

/**
 * Spend a request budget by value: news (1) → PPR ECR up to 60 players (6)
 * → projections with whatever is left, but only when at least 5 chunks fit
 * (50 players; fewer would blend projections for a random sliver of the board).
 */
export function planFpBudget(budget: number): FpPlan {
  let left = Math.max(0, Math.floor(budget));
  const news = left >= 1;
  if (news) left--;
  const ecrChunks = Math.min(6, left);
  left -= ecrChunks;
  const projChunks = left >= 5 ? Math.min(15, left) : 0;
  return { news, ecrChunks, projChunks };
}

let lastCall = 0;
let spent = 0;
async function throttled(url: string, key: string): Promise<Response> {
  if (spent >= FP_DAILY_BUDGET) throw new Error(`FantasyPros budget of ${FP_DAILY_BUDGET} requests spent`);
  const wait = lastCall + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  spent++;
  return fetch(url, { headers: { "x-api-key": key } });
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
  const plan = planFpBudget(FP_DAILY_BUDGET - spent);
  console.log(
    `fantasypros: budget ${FP_DAILY_BUDGET}/build → PPR consensus for the top ${plan.ecrChunks * CHUNK}` +
      (plan.projChunks ? `, projections for ${plan.projChunks * CHUNK}` : ", no projections (free tier)")
  );

  try {
    // Consensus ECR: PPR only on the free tier (2qb shares it); other formats fall back to DynastyProcess per player.
    const pprMap = new Map<string, FpEcr>();
    for (const batch of chunks(fpIds.slice(0, plan.ecrChunks * CHUNK), CHUNK)) {
      if (quotaSpent()) break;
      const res = await throttled(
        `${BASE}/${season}/consensus-rankings?type=DRAFT&scoring=PPR&position=ALL&players=${batch.join(":")}`,
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
        players?: { player_id: number; rank_ave?: string | number; rank_std?: string | number }[];
      };
      data.experts = Math.max(data.experts, json.total_experts ?? 0);
      for (const p of json.players ?? []) {
        const ecr = num(p.rank_ave);
        if (p.player_id && ecr != null) pprMap.set(String(p.player_id), { ecr, ecrStdev: num(p.rank_std) });
      }
    }
    data.ecr.ppr = pprMap;
    data.ecr["2qb"] = pprMap;

    // Projections: one pass, format-independent raw stats — paid budgets only.
    for (const batch of chunks(fpIds.slice(0, plan.projChunks * CHUNK), CHUNK)) {
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

  } catch (err) {
    console.warn(`⚠️  fantasypros: batch run aborted (${err}) — using what was fetched so far`);
  }

  const total = data.ecr.ppr.size;
  if (total === 0 && data.stats.size === 0) {
    console.warn("⚠️  fantasypros: no usable data returned (daily quota already spent?) — falling back to DynastyProcess ECR");
    return null;
  }
  if (quotaSpent())
    console.warn("⚠️  fantasypros: aborted early — daily quota spent mid-run; using partials + fallback");
  else if (failures > 0) console.warn(`⚠️  fantasypros: ${failures} batch requests failed`);
  console.log(`fantasypros: ${spent} requests used this build`);
  return data;
}

export interface FpNewsItem {
  fpid: string | null;
  headline: string;
  published: string;
}

/**
 * FP player news (25-50 items). Response shape parsed defensively — the free
 * tier blocked schema inspection. Returns [] without a key or on failure.
 */
export async function fetchFantasyProsNews(): Promise<FpNewsItem[]> {
  const key = process.env.FANTASYPROS_API_KEY;
  if (!key) return [];
  try {
    const res = await throttled(`${BASE}/news?limit=50`, key);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const list = (json.news ?? json.items ?? json.articles ?? []) as Record<string, unknown>[];
    return list
      .map((n) => ({
        fpid: n.fpid != null ? String(n.fpid) : n.player_id != null ? String(n.player_id) : null,
        headline: String(n.headline ?? n.title ?? ""),
        published: String(n.published ?? n.date ?? n.updated ?? ""),
      }))
      .filter((n) => n.headline);
  } catch (err) {
    console.warn(`⚠️  fantasypros news: skipped (${err})`);
    return [];
  }
}
