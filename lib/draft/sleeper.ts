// Sleeper live-draft client. Read-only, no auth, free for personal use.
//
// Polled every 1-2s on draft night. Sleeper's limit is ~1000 calls/min and we
// peak at 60, so the constraint was never rate limiting — it was CACHING. The
// API sits behind Cloudflare and serves `cache-control: public, s-maxage=...,
// stale-while-revalidate=...` on these endpoints, so a bare fetch() polled
// every 2s can return the same stale body for minutes on end. Every request
// below is cache-busted and sent with `cache: "no-store"`, which is what
// actually makes the board feel live.

import type { DraftPick, Position, TradedPick } from "../types";

const BASE = "https://api.sleeper.app/v1";

/**
 * Fetch that defeats both the browser HTTP cache and Sleeper's CDN edge cache.
 * The `_` cache-buster is what gets past Cloudflare — `no-store` alone only
 * governs the local cache.
 */
async function fetchLive(url: string): Promise<Response> {
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}_=${Date.now()}`, {
    cache: "no-store",
    headers: { "cache-control": "no-cache" },
  });
}

export interface SleeperDraftInfo {
  draftId: string;
  leagueId: string | null;
  teams: number;
  rounds: number;
  /** draft slot (1-indexed) → roster_id */
  slotToRoster: Record<string, number>;
  scoringSettings: Record<string, number> | null;
  rosterPositions: string[] | null;
  /** True when the league is best ball (Sleeper settings.best_ball = 1). */
  bestBall: boolean;
  /** Mock drafts carry a scoring hint in draft metadata: "ppr" | "half_ppr" | "std" | "2qb". */
  scoringType: string | null;
  tradedPicks: TradedPick[];
  status: string;
}

export async function fetchDraftInfo(draftId: string): Promise<SleeperDraftInfo> {
  const draftRes = await fetchLive(`${BASE}/draft/${draftId}`);
  if (!draftRes.ok) throw new Error(`Sleeper draft ${draftId}: HTTP ${draftRes.status}`);
  const draft = await draftRes.json();
  const teams = draft.settings?.teams ?? 12;
  const rounds = draft.settings?.rounds ?? 15;
  const slotToRoster: Record<string, number> = draft.slot_to_roster_id ?? {};

  let scoringSettings: Record<string, number> | null = null;
  let rosterPositions: string[] | null = null;
  let bestBall = false;
  if (draft.league_id) {
    try {
      const leagueRes = await fetchLive(`${BASE}/league/${draft.league_id}`);
      if (leagueRes.ok) {
        const league = await leagueRes.json();
        scoringSettings = league.scoring_settings ?? null;
        rosterPositions = league.roster_positions ?? null;
        bestBall = league.settings?.best_ball === 1;
      }
    } catch {
      // mock drafts have no league — fine
    }
  }

  // Traded picks: Sleeper reports (round, roster_id of original owner,
  // owner_id of current owner). Convert roster ids → draft slots.
  const rosterToSlot: Record<number, number> = {};
  for (const [slot, rosterId] of Object.entries(slotToRoster)) {
    rosterToSlot[rosterId as number] = Number(slot);
  }
  let tradedPicks: TradedPick[] = [];
  try {
    const tpRes = await fetchLive(`${BASE}/draft/${draftId}/traded_picks`);
    if (tpRes.ok) {
      const raw: { round: number; roster_id: number; owner_id: number }[] = await tpRes.json();
      tradedPicks = raw
        .map((t) => ({
          round: t.round,
          originalSlot: rosterToSlot[t.roster_id],
          newSlot: rosterToSlot[t.owner_id],
        }))
        .filter((t) => t.originalSlot != null && t.newSlot != null);
    }
  } catch {
    // no traded picks endpoint data — standard snake
  }

  return {
    draftId,
    leagueId: draft.league_id ?? null,
    teams,
    rounds,
    slotToRoster,
    scoringSettings,
    rosterPositions,
    bestBall,
    scoringType: draft.metadata?.scoring_type ?? null,
    tradedPicks,
    status: draft.status ?? "unknown",
  };
}

const SLEEPER_POS: Record<string, Position> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  DEF: "DST",
};

interface SleeperPickRaw {
  player_id: string | null;
  pick_no: number;
  round: number;
  draft_slot: number;
  is_keeper: boolean | null;
  metadata: { first_name?: string; last_name?: string; position?: string } | null;
}

export async function fetchPicks(draftId: string, mySlot: number | null): Promise<DraftPick[]> {
  const res = await fetchLive(`${BASE}/draft/${draftId}/picks`);
  if (!res.ok) throw new Error(`Sleeper picks: HTTP ${res.status}`);
  const raw: SleeperPickRaw[] = await res.json();
  return raw
    .sort((a, b) => a.pick_no - b.pick_no)
    .map((p) => ({
      playerId: String(p.player_id ?? ""),
      playerName: p.metadata
        ? `${p.metadata.first_name ?? ""} ${p.metadata.last_name ?? ""}`.trim()
        : String(p.player_id ?? "?"),
      pos: SLEEPER_POS[p.metadata?.position ?? ""] ?? null,
      pickNo: p.pick_no,
      round: p.round,
      draftSlot: p.draft_slot,
      isKeeper: Boolean(p.is_keeper),
      byMe: mySlot != null && p.draft_slot === mySlot,
    }));
}

/** Resolve a Sleeper draft URL or bare id to a draft id. */
export function parseDraftId(input: string): string {
  const m = input.match(/draft\/nfl\/(\d+)/) ?? input.match(/(\d{10,})/);
  return m ? m[1] : input.trim();
}

/** Fetch a league's drafts (for using league id instead of draft id, and for backtests). */
export async function fetchLeagueDrafts(leagueId: string): Promise<{ draft_id: string; status: string; season: string }[]> {
  const res = await fetchLive(`${BASE}/league/${leagueId}/drafts`);
  if (!res.ok) throw new Error(`Sleeper league drafts: HTTP ${res.status}`);
  return res.json();
}
