"use client";

// Draft-night state: merges live Sleeper picks with manual actions, mirrors
// to localStorage for crash recovery, exposes everything the engine needs.
//
// Manual picks are ALWAYS available — they're the escape hatch when the API
// hiccups or returns a player we can't match, even in Sleeper mode.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Board,
  BoardPlayer,
  DraftPick,
  LeagueConfig,
  Position,
  TradedPick,
} from "../types";
import { fetchDraftInfo, fetchPicks, type SleeperDraftInfo } from "../draft/sleeper";
import { picksForSlot, pickOwner, slotOnClock } from "../draft/snake";
import { computeDrift, type DriftPrior } from "../engine/drift";
import { mergeName } from "../etl/names";

const STORAGE_KEY = "draft-cockpit-picks-v1";
/**
 * Live-draft poll cadence. Sleeper allows ~1000 calls/min; one call per tick
 * means 30/min at rest and 60/min when our pick is close — 16x under the limit
 * even at peak, so there is no rate-limit exposure at either rate.
 *
 * The cache-busting in lib/draft/sleeper.ts is what actually removes the lag;
 * this just tightens the window when it matters most.
 */
const POLL_IDLE_MS = 2000;
const POLL_HOT_MS = 1000;
/** Within this many picks of our turn, poll at the faster rate. */
const HOT_WINDOW_PICKS = 3;

interface PersistedPicks {
  draftKey: string; // config fingerprint so stale state isn't restored into a different draft
  manualPicks: DraftPick[];
}

function draftKeyOf(config: LeagueConfig): string {
  return `${config.platform}:${config.draftId || "manual"}:${config.teams}x${config.rounds}`;
}

/** Match a Sleeper pick to a board player: by sleeper id, then by name+pos. */
function matchToBoard(
  pick: DraftPick,
  byId: Map<string, BoardPlayer>,
  byName: Map<string, BoardPlayer[]>
): string {
  if (byId.has(pick.playerId)) return pick.playerId;
  const candidates = byName.get(mergeName(pick.playerName)) ?? [];
  const hit = candidates.find((c) => !pick.pos || c.pos === pick.pos) ?? candidates[0];
  return hit?.id ?? "";
}

export interface DraftApi {
  picks: DraftPick[];
  currentPick: number;
  round: number;
  myPicks: number[]; // remaining, ascending
  myRoster: BoardPlayer[];
  draftedIds: Set<string>;
  opponentCounts: Record<number, Partial<Record<Position, number>>>;
  /** Every other team's roster by draft slot — the engine models them by need. */
  opponentRosters: Record<number, BoardPlayer[]>;
  drift: Partial<Record<Position, number>>;
  tradedPicks: TradedPick[];
  live: boolean;
  syncError: string | null;
  draftInfo: SleeperDraftInfo | null;
  onClockSlot: number;
  markDrafted: (player: BoardPlayer) => void;
  /** Append many manual picks at once, in order (auto-complete). */
  markMany: (players: BoardPlayer[]) => void;
  undo: () => void;
  canUndo: boolean;
  /** True if this player left the board via a manual mark (so it can be undone). */
  isManuallyMarked: (playerId: string) => boolean;
  /** Put a specific manually-marked player back in the pool. */
  unmark: (playerId: string) => void;
  /** Clear every manual pick — restart a manual/test draft. */
  reset: () => void;
  lastPickFlash: number; // bump counter for UI flash on new picks
}

export function useDraft(board: Board | null, config: LeagueConfig | null): DraftApi {
  const [manualPicks, setManualPicks] = useState<DraftPick[]>([]);
  const [apiPicks, setApiPicks] = useState<DraftPick[]>([]);
  const [draftInfo, setDraftInfo] = useState<SleeperDraftInfo | null>(null);
  const [live, setLive] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastPickFlash, setLastPickFlash] = useState(0);
  const [driftPrior, setDriftPrior] = useState<DriftPrior | undefined>(undefined);
  const lastCountRef = useRef(0);
  /** Signature of the last applied pick list, so a *corrected* pick still lands. */
  const lastSigRef = useRef("");
  /** Picks until our turn, mirrored into a ref so the poll loop can read it
   *  without re-subscribing (and restarting the timer) on every pick. */
  const untilMeRef = useRef<number | null>(null);
  const restoredRef = useRef(false);

  // History-fitted drift prior, if the ETL produced one for THIS league.
  useEffect(() => {
    if (!config?.leagueId) return;
    let cancelled = false;
    fetch("/data/drift-prior.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json || json.leagueId !== config.leagueId) return;
        setDriftPrior({ drift: json.drift ?? {}, weight: 20 });
      })
      .catch(() => {
        // no prior fitted — live drift alone
      });
    return () => {
      cancelled = true;
    };
  }, [config?.leagueId]);

  // --- crash recovery -------------------------------------------------------
  useEffect(() => {
    if (!config || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved: PersistedPicks = JSON.parse(raw);
        if (saved.draftKey === draftKeyOf(config)) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time crash recovery
          setManualPicks(saved.manualPicks);
        }
      }
    } catch {
      // corrupted storage — start clean
    }
  }, [config]);

  useEffect(() => {
    if (!config || !restoredRef.current) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ draftKey: draftKeyOf(config), manualPicks } satisfies PersistedPicks)
      );
    } catch {
      // storage full — recovery degraded, draft continues
    }
  }, [manualPicks, config]);

  // --- sleeper: draft info once, picks every 2s -----------------------------
  const isSleeper = config?.platform === "sleeper" && Boolean(config.draftId);

  useEffect(() => {
    if (!isSleeper || !config) return;
    let cancelled = false;
    fetchDraftInfo(config.draftId)
      .then((info) => {
        if (!cancelled) setDraftInfo(info);
      })
      .catch((err) => {
        if (!cancelled) setSyncError(`Draft info failed: ${err.message}. Manual entry still works.`);
      });
    return () => {
      cancelled = true;
    };
  }, [isSleeper, config?.draftId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isSleeper || !config) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const picks = await fetchPicks(config.draftId, config.myDraftSlot);
        if (cancelled) return;
        setLive(true);
        setSyncError(null);
        // Compare a signature, not just the count: Sleeper rooms do get picks
        // edited or reassigned, and a same-length change was silently dropped.
        const last = picks[picks.length - 1];
        const sig = `${picks.length}:${last?.pickNo ?? 0}:${last?.playerId ?? ""}`;
        if (sig !== lastSigRef.current) {
          lastSigRef.current = sig;
          const grew = picks.length !== lastCountRef.current;
          lastCountRef.current = picks.length;
          setApiPicks(picks);
          if (grew) setLastPickFlash((n) => n + 1);
        }
      } catch (err) {
        if (cancelled) return;
        setLive(false);
        setSyncError(`Sync lost (${(err as Error).message}). Retrying — manual entry still works.`);
      }
      const until = untilMeRef.current;
      const hot = until != null && until <= HOT_WINDOW_PICKS;
      timer = setTimeout(poll, hot ? POLL_HOT_MS : POLL_IDLE_MS);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isSleeper, config?.draftId, config?.myDraftSlot]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- derived state ---------------------------------------------------------
  const teams = draftInfo?.teams ?? config?.teams ?? 12;
  const rounds = draftInfo?.rounds ?? config?.rounds ?? 15;
  const mySlot = config?.myDraftSlot ?? 1;
  const tradedPicks = useMemo(() => draftInfo?.tradedPicks ?? [], [draftInfo]);

  const boardIndexes = useMemo(() => {
    const byId = new Map<string, BoardPlayer>();
    const byName = new Map<string, BoardPlayer[]>();
    for (const p of board?.players ?? []) {
      byId.set(p.id, p);
      const key = mergeName(p.name);
      const list = byName.get(key) ?? [];
      list.push(p);
      byName.set(key, list);
    }
    return { byId, byName };
  }, [board]);

  const picks = useMemo(() => {
    // Resolve API picks to board ids; append manual picks the API doesn't know.
    const resolved = apiPicks.map((p) => ({
      ...p,
      playerId: matchToBoard(p, boardIndexes.byId, boardIndexes.byName),
    }));
    const known = new Set(resolved.map((p) => p.playerId).filter(Boolean));
    const extras = manualPicks.filter((m) => !known.has(m.playerId));
    const merged = [...resolved];
    for (const extra of extras) {
      const pickNo = merged.length + 1;
      const { round } = slotOnClock(pickNo, teams);
      merged.push({ ...extra, pickNo, round, draftSlot: slotOnClock(pickNo, teams).slot });
    }
    return merged;
  }, [apiPicks, manualPicks, boardIndexes, teams]);

  const currentPick = picks.length + 1;
  const round = slotOnClock(Math.min(currentPick, teams * rounds), teams).round;
  const allMyPicks = useMemo(
    () => picksForSlot(mySlot, teams, rounds, tradedPicks),
    [mySlot, teams, rounds, tradedPicks]
  );
  const myPicks = useMemo(
    () => allMyPicks.filter((n) => n >= currentPick),
    [allMyPicks, currentPick]
  );
  // Mirror distance-to-our-pick so the poll loop can pick its cadence without
  // taking `currentPick` as a dependency (which would restart the timer on
  // every single pick in the room).
  const untilMe = myPicks.length > 0 ? myPicks[0] - currentPick : null;
  useEffect(() => {
    untilMeRef.current = untilMe;
  }, [untilMe]);

  const { myRoster, draftedIds, opponentCounts, opponentRosters } = useMemo(() => {
    const roster: BoardPlayer[] = [];
    const drafted = new Set<string>();
    const opp: Record<number, Partial<Record<Position, number>>> = {};
    const oppRosters: Record<number, BoardPlayer[]> = {};
    for (const pick of picks) {
      if (pick.playerId) drafted.add(pick.playerId);
      const owner = pickOwner(pick.pickNo, teams, tradedPicks);
      const player = boardIndexes.byId.get(pick.playerId);
      if (owner === mySlot) {
        if (player) roster.push(player);
      } else if (player) {
        const counts = (opp[owner] ??= {});
        counts[player.pos] = (counts[player.pos] ?? 0) + 1;
        (oppRosters[owner] ??= []).push(player);
      }
    }
    return { myRoster: roster, draftedIds: drafted, opponentCounts: opp, opponentRosters: oppRosters };
  }, [picks, teams, tradedPicks, mySlot, boardIndexes]);

  const drift = useMemo(
    () => computeDrift(picks, boardIndexes.byId, driftPrior),
    [picks, boardIndexes, driftPrior]
  );

  const markDrafted = useCallback(
    (player: BoardPlayer) => {
      setManualPicks((prev) => {
        if (prev.some((p) => p.playerId === player.id)) return prev;
        const pickNo = 0; // recomputed at merge time
        return [
          ...prev,
          {
            playerId: player.id,
            playerName: player.name,
            pos: player.pos,
            pickNo,
            round: 0,
            draftSlot: 0,
            isKeeper: false,
            byMe: false,
          },
        ];
      });
    },
    []
  );

  const markMany = useCallback((players: BoardPlayer[]) => {
    setManualPicks((prev) => {
      const have = new Set(prev.map((p) => p.playerId));
      const additions = players
        .filter((p) => !have.has(p.id))
        .map((player) => ({
          playerId: player.id,
          playerName: player.name,
          pos: player.pos,
          pickNo: 0, // recomputed at merge time
          round: 0,
          draftSlot: 0,
          isKeeper: false,
          byMe: false,
        }));
      return [...prev, ...additions];
    });
  }, []);

  const undo = useCallback(() => {
    setManualPicks((prev) => prev.slice(0, -1));
  }, []);

  const isManuallyMarked = useCallback(
    (playerId: string) => manualPicks.some((p) => p.playerId === playerId),
    [manualPicks]
  );

  const unmark = useCallback((playerId: string) => {
    setManualPicks((prev) => prev.filter((p) => p.playerId !== playerId));
  }, []);

  const reset = useCallback(() => {
    setManualPicks([]);
  }, []);

  return {
    picks,
    currentPick,
    round,
    myPicks,
    myRoster,
    draftedIds,
    opponentCounts,
    opponentRosters,
    drift,
    tradedPicks,
    live,
    syncError,
    draftInfo,
    onClockSlot: pickOwner(Math.min(currentPick, teams * rounds), teams, tradedPicks),
    markDrafted,
    markMany,
    undo,
    canUndo: manualPicks.length > 0,
    isManuallyMarked,
    unmark,
    reset,
    lastPickFlash,
  };
}
