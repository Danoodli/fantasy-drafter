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
import { computeDrift } from "../engine/drift";
import { mergeName } from "../etl/names";

const STORAGE_KEY = "draft-cockpit-picks-v1";
const POLL_MS = 2000;

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
  drift: Partial<Record<Position, number>>;
  tradedPicks: TradedPick[];
  live: boolean;
  syncError: string | null;
  draftInfo: SleeperDraftInfo | null;
  onClockSlot: number;
  markDrafted: (player: BoardPlayer) => void;
  undo: () => void;
  canUndo: boolean;
  lastPickFlash: number; // bump counter for UI flash on new picks
}

export function useDraft(board: Board | null, config: LeagueConfig | null): DraftApi {
  const [manualPicks, setManualPicks] = useState<DraftPick[]>([]);
  const [apiPicks, setApiPicks] = useState<DraftPick[]>([]);
  const [draftInfo, setDraftInfo] = useState<SleeperDraftInfo | null>(null);
  const [live, setLive] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastPickFlash, setLastPickFlash] = useState(0);
  const lastCountRef = useRef(0);
  const restoredRef = useRef(false);

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
        if (picks.length !== lastCountRef.current) {
          lastCountRef.current = picks.length;
          setApiPicks(picks);
          setLastPickFlash((n) => n + 1);
        }
      } catch (err) {
        if (cancelled) return;
        setLive(false);
        setSyncError(`Sync lost (${(err as Error).message}). Retrying — manual entry still works.`);
      }
      timer = setTimeout(poll, POLL_MS);
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

  const { myRoster, draftedIds, opponentCounts } = useMemo(() => {
    const roster: BoardPlayer[] = [];
    const drafted = new Set<string>();
    const opp: Record<number, Partial<Record<Position, number>>> = {};
    for (const pick of picks) {
      if (pick.playerId) drafted.add(pick.playerId);
      const owner = pickOwner(pick.pickNo, teams, tradedPicks);
      const player = boardIndexes.byId.get(pick.playerId);
      if (owner === mySlot) {
        if (player) roster.push(player);
      } else if (player) {
        const counts = (opp[owner] ??= {});
        counts[player.pos] = (counts[player.pos] ?? 0) + 1;
      }
    }
    return { myRoster: roster, draftedIds: drafted, opponentCounts: opp };
  }, [picks, teams, tradedPicks, mySlot, boardIndexes]);

  const drift = useMemo(() => computeDrift(picks, boardIndexes.byId), [picks, boardIndexes]);

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

  const undo = useCallback(() => {
    setManualPicks((prev) => prev.slice(0, -1));
  }, []);

  return {
    picks,
    currentPick,
    round,
    myPicks,
    myRoster,
    draftedIds,
    opponentCounts,
    drift,
    tradedPicks,
    live,
    syncError,
    draftInfo,
    onClockSlot: pickOwner(Math.min(currentPick, teams * rounds), teams, tradedPicks),
    markDrafted,
    undo,
    canUndo: manualPicks.length > 0,
    lastPickFlash,
  };
}
