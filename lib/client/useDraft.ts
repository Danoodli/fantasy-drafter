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
  DraftOrder,
  DraftPick,
  LeagueConfig,
  Position,
  TradedPick,
} from "../types";
import { fetchDraftInfo, fetchPicks, type SleeperDraftInfo } from "../draft/sleeper";
import { picksForSlot, pickOwner, slotOnClock } from "../draft/snake";
import { computeDrift, type DriftPrior } from "../engine/drift";
import { placeNumberedPicks, reconcileSequence, type ConflictPolicy } from "../draft/sequence";
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

/**
 * How many manual picks are saved for THIS config — what the setup screen's
 * resume card shows. Null when nothing is saved for it (or storage is
 * unavailable). Sleeper drafts also mirror from the API, so this undercounts
 * them; the card says "live" for those instead.
 */
export function persistedPickCount(config: LeagueConfig): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved: PersistedPicks = JSON.parse(raw);
    return saved.draftKey === draftKeyOf(config) ? saved.manualPicks.length : null;
  } catch {
    return null;
  }
}

/** Forget the saved draft entirely — "start a new draft" from the setup screen. */
export function clearPersistedPicks(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("draft-cockpit-session-v1");
  } catch {
    // nothing to clear
  }
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

export interface ImportItem {
  player: BoardPlayer;
  pickNo: number | null;
}

export interface ImportConflict {
  pickNo: number;
  player: BoardPlayer;
  /** Who the board has at that number (null if unknown to the board index). */
  existing: BoardPlayer | null;
}

export interface ImportOutcome {
  /** Numbered picks that named a different player than the one at that number — left alone unless the caller said "replace". */
  conflicts: ImportConflict[];
  /** Conflicts resolved by overwriting (onConflict "replace"). */
  replaced: number;
  /** Appended at the end (numbered picks past the board, or unnumbered names after the last known one). */
  added: number;
  /** Placeholders filled. */
  filled: number;
  /** Placeholders created to reach a pick number. */
  padded: number;
  /** Already on the board. */
  skipped: number;
  /** Placed in front of a pick we had wrong — a pick that had been missed. */
  inserted: number;
  /** Picks that moved down because of an insertion. */
  shifted: number;
  snapshot: DraftPick[];
}

/** A pick placed from a screen read. */
export interface PlacedPick {
  player: BoardPlayer;
  pickNo: number;
}

export interface SequenceOutcome {
  /** Picks placed this read (appended, inserted where one was missed, or filling a placeholder), by pick. */
  placed: PlacedPick[];
  /** Picks that moved down because a missed pick was inserted before them. */
  shifted: number;
  snapshot: DraftPick[];
}

function manualPickOf(player: BoardPlayer): DraftPick {
  return {
    playerId: player.id,
    playerName: player.name,
    pos: player.pos,
    pickNo: 0,
    round: 0,
    draftSlot: 0,
    isKeeper: false,
    byMe: false,
  };
}

const UNKNOWN_PICK: DraftPick = {
  playerId: "",
  playerName: "Unknown pick",
  pos: null,
  pickNo: 0,
  round: 0,
  draftSlot: 0,
  isKeeper: false,
  byMe: false,
};

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
  /**
   * Someone drafted a player we can't identify (or we missed a pick): advance
   * the pick counter with a placeholder so "you're on the clock" stays honest.
   */
  markUnknown: (count?: number) => void;
  /**
   * Resync to the real draft: forward pads with unknown picks, backward
   * removes the most recent manual marks. Returns how many marks were removed.
   */
  setCurrentPick: (pickNo: number) => number;
  /** Replace the unknown placeholder at a manual index with the real player. */
  fillUnknown: (index: number, player: BoardPlayer) => void;
  /**
   * Batch import (paste). Items with a pick number land at that pick: gaps
   * are padded with unknowns, an unknown already sitting there is filled in.
   * Items without one append in order. Returns what happened plus a snapshot
   * that `restoreManual` can roll back to.
   */
  applyImport: (items: ImportItem[], opts?: { onConflict?: ConflictPolicy }) => ImportOutcome;
  /**
   * Screen sync: reconcile the ORDERED list of names read off the room's pick
   * history with the picks we know (lib/draft/sequence.ts). New names append
   * or insert in order — mine included: I draft on the site, the app records.
   */
  applySequence: (playerIds: string[]) => SequenceOutcome;
  /** Fill the unknown placeholder at a pick, if that pick is still unknown. */
  fillAt: (pickNo: number, player: BoardPlayer) => boolean;
  /** The most recent of my picks that is still an unknown placeholder, if any. */
  myOpenPick: number | null;
  /** Roll the manual pick list back to a snapshot (undo a whole import). */
  restoreManual: (snapshot: DraftPick[]) => void;
  undo: () => void;
  /** Undo the last n manual marks at once (batch imports). */
  undoMany: (n: number) => void;
  canUndo: boolean;
  /** Number of manual (non-API) picks — the batch-undo horizon. */
  manualCount: number;
  /** True if this player left the board via a manual mark (so it can be undone). */
  isManuallyMarked: (playerId: string) => boolean;
  /** Put a specific manually-marked player back in the pool. */
  unmark: (playerId: string) => void;
  /** Remove one manual pick by its index (works for unknown placeholders too). */
  removeManualAt: (index: number) => void;
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
  /** Merged pick count as of the last render, for setCurrentPick. */
  const currentPickRef = useRef(1);
  /**
   * The authoritative manual pick list. Every mutation computes from this and
   * commits synchronously, so screen sync (several writes a second) and a
   * click in the app can never clobber each other by reading a stale render.
   */
  const manualRef = useRef<DraftPick[]>([]);
  /** The merged list as of the last render (API picks occupy its front). */
  const picksRef = useRef<DraftPick[]>([]);
  /** Room geometry for pick-ownership math. */
  const roomRef = useRef({ teams: 12, rounds: 15, mySlot: 1, tradedPicks: [] as TradedPick[], order: "snake" as DraftOrder });
  const boardRef = useRef<Map<string, BoardPlayer>>(new Map());

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
          manualRef.current = saved.manualPicks;
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
  const order = draftInfo?.draftOrder ?? config?.draftOrder ?? "snake";
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
    const merged = [...resolved];
    manualPicks.forEach((m, manualIndex) => {
      if (m.playerId && known.has(m.playerId)) return; // the API caught up with this mark
      const pickNo = merged.length + 1;
      const { round, slot } = slotOnClock(pickNo, teams, order);
      merged.push({ ...m, pickNo, round, draftSlot: slot, manualIndex });
    });
    return merged;
  }, [apiPicks, manualPicks, boardIndexes, teams, order]);

  const currentPick = picks.length + 1;
  useEffect(() => {
    currentPickRef.current = currentPick;
    picksRef.current = picks;
    roomRef.current = { teams, rounds, mySlot, tradedPicks, order };
    boardRef.current = boardIndexes.byId;
  }, [currentPick, picks, teams, rounds, mySlot, tradedPicks, boardIndexes, order]);
  const round = slotOnClock(Math.min(currentPick, teams * rounds), teams, order).round;
  const allMyPicks = useMemo(
    () => picksForSlot(mySlot, teams, rounds, tradedPicks, order),
    [mySlot, teams, rounds, tradedPicks, order]
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
      const owner = pickOwner(pick.pickNo, teams, tradedPicks, order);
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
  }, [picks, teams, tradedPicks, mySlot, boardIndexes, order]);

  const drift = useMemo(
    () => computeDrift(picks, boardIndexes.byId, driftPrior),
    [picks, boardIndexes, driftPrior]
  );

  // --- manual picks: one authoritative copy, committed synchronously ---------
  const commit = useCallback((next: DraftPick[]) => {
    manualRef.current = next;
    setManualPicks(next);
  }, []);

  const markDrafted = useCallback(
    (player: BoardPlayer) => {
      const cur = manualRef.current;
      if (cur.some((p) => p.playerId === player.id)) return;
      commit([...cur, manualPickOf(player)]);
    },
    [commit]
  );

  const markMany = useCallback(
    (players: BoardPlayer[]) => {
      const cur = manualRef.current;
      const have = new Set(cur.map((p) => p.playerId));
      const additions = players.filter((p) => !have.has(p.id)).map(manualPickOf);
      if (additions.length) commit([...cur, ...additions]);
    },
    [commit]
  );

  const markUnknown = useCallback(
    (count = 1) => {
      if (count <= 0) return;
      commit([...manualRef.current, ...Array.from({ length: count }, () => ({ ...UNKNOWN_PICK }))]);
    },
    [commit]
  );

  const fillUnknown = useCallback(
    (index: number, player: BoardPlayer) => {
      const cur = manualRef.current;
      const target = cur[index];
      if (!target || target.playerId !== "") return;
      if (cur.some((p) => p.playerId === player.id)) return;
      const next = [...cur];
      next[index] = { ...target, playerId: player.id, playerName: player.name, pos: player.pos };
      commit(next);
    },
    [commit]
  );

  const undo = useCallback(() => {
    commit(manualRef.current.slice(0, -1));
  }, [commit]);

  const undoMany = useCallback(
    (n: number) => {
      if (n <= 0) return;
      const cur = manualRef.current;
      commit(cur.slice(0, Math.max(0, cur.length - n)));
    },
    [commit]
  );

  // Resync needs the merged pick count, which lives in `picks` above — so
  // it reads through a ref set on each render.
  const setCurrentPick = useCallback(
    (pickNo: number): number => {
      const delta = pickNo - currentPickRef.current;
      if (delta > 0) {
        markUnknown(delta);
        return 0;
      }
      if (delta < 0) {
        const remove = -delta;
        const cur = manualRef.current;
        commit(cur.slice(0, Math.max(0, cur.length - remove)));
        return remove;
      }
      return 0;
    },
    [markUnknown, commit]
  );

  const isManuallyMarked = useCallback(
    (playerId: string) => manualPicks.some((p) => p.playerId === playerId),
    [manualPicks]
  );

  const unmark = useCallback(
    (playerId: string) => {
      if (!playerId) return; // unknown placeholders are removed by index
      commit(manualRef.current.filter((p) => p.playerId !== playerId));
    },
    [commit]
  );

  const removeManualAt = useCallback(
    (index: number) => {
      const cur = manualRef.current;
      if (index >= 0 && index < cur.length) commit(cur.filter((_, i) => i !== index));
    },
    [commit]
  );

  const reset = useCallback(() => {
    commit([]);
  }, [commit]);

  const applyImport = useCallback(
    (items: ImportItem[], opts: { onConflict?: ConflictPolicy } = {}): ImportOutcome => {
      const snapshot = manualRef.current;
      const apiIds = picksRef.current.filter((p) => p.manualIndex == null).map((p) => (p.playerId ? p.playerId : null));
      const apiCount = apiIds.length;
      const byId = boardRef.current;
      let known: (string | null)[] = [...apiIds, ...snapshot.map((m) => (m.playerId ? m.playerId : null))];
      // Numbered picks first: the number is trusted (fill / pad / insert in
      // front of a pick we had at that number). Then the unnumbered names as
      // an ordered list, aligned with what is now known — exactly how a screen
      // read is placed — so a paste can backfill a pick the screen missed.
      const numbered = placeNumberedPicks(
        known,
        items.filter((it) => it.pickNo != null).map((it) => ({ id: it.player.id, pickNo: it.pickNo! })),
        apiCount,
        { onConflict: opts.onConflict ?? "skip" }
      );
      known = numbered.next;
      const seq = reconcileSequence(
        known,
        items.filter((it) => it.pickNo == null).map((it) => it.player.id),
        { isMine: () => false, frozen: apiCount }
      );
      known = seq.next;
      const existing = new Map<string, DraftPick>();
      for (const m of snapshot) if (m.playerId) existing.set(m.playerId, m);
      const nextManual: DraftPick[] = known.slice(apiCount).map((id) => {
        if (!id) return { ...UNKNOWN_PICK };
        const kept = existing.get(id);
        if (kept) return kept;
        const player = byId.get(id) ?? items.find((it) => it.player.id === id)?.player;
        return player ? manualPickOf(player) : { ...UNKNOWN_PICK };
      });
      const unnumberedSkipped = items.filter((it) => it.pickNo == null).length - seq.inserted.length - seq.filled.length;
      const out: ImportOutcome = {
        conflicts: numbered.conflicts.map((c) => ({
          pickNo: c.pickNo,
          player: byId.get(c.id) ?? items.find((it) => it.player.id === c.id)!.player,
          existing: byId.get(c.existing) ?? null,
        })),
        replaced: numbered.replaced,
        added: numbered.added + seq.inserted.filter((p) => p.pickIndex >= numbered.next.length).length,
        filled: numbered.filled + seq.filled.length,
        padded: numbered.padded,
        skipped: numbered.skipped + Math.max(0, unnumberedSkipped),
        inserted: numbered.inserted + seq.inserted.filter((p) => p.pickIndex < numbered.next.length).length,
        shifted: numbered.shifted + seq.shifted,
        snapshot,
      };
      if (out.added + out.filled + out.padded + out.inserted + out.replaced > 0) commit(nextManual);
      return out;
    },
    [commit]
  );

  const applySequence = useCallback(
    (playerIds: string[]): SequenceOutcome => {
      const snapshot = manualRef.current;
      const apiIds = picksRef.current.filter((p) => p.manualIndex == null).map((p) => (p.playerId ? p.playerId : null));
      const apiCount = apiIds.length;
      const known: (string | null)[] = [...apiIds, ...snapshot.map((m) => (m.playerId ? m.playerId : null))];
      const byId = boardRef.current;
      // My own picks are placed like anyone else's: I draft on the site, the app records.
      const result = reconcileSequence(known, playerIds, { isMine: () => false, frozen: apiCount });
      const existing = new Map<string, DraftPick>();
      for (const m of snapshot) if (m.playerId) existing.set(m.playerId, m);
      const nextManual: DraftPick[] = result.next.slice(apiCount).map((id) => {
        if (!id) return { ...UNKNOWN_PICK };
        const kept = existing.get(id);
        if (kept) return kept;
        const player = byId.get(id);
        return player ? manualPickOf(player) : { ...UNKNOWN_PICK };
      });
      const placedRaw = [...result.inserted, ...result.filled];
      if (placedRaw.length > 0 || nextManual.length !== snapshot.length) commit(nextManual);
      const placed: PlacedPick[] = placedRaw
        .map((p) => ({ player: byId.get(p.id), pickNo: p.pickIndex + 1 }))
        .filter((p): p is PlacedPick => p.player != null)
        .sort((a, b) => a.pickNo - b.pickNo);
      return { placed, shifted: result.shifted, snapshot };
    },
    [commit]
  );

  const fillAt = useCallback(
    (pickNo: number, player: BoardPlayer): boolean => {
      const apiCount = picksRef.current.filter((p) => p.manualIndex == null).length;
      const idx = pickNo - 1 - apiCount;
      const cur = manualRef.current;
      if (idx < 0 || idx >= cur.length || cur[idx].playerId !== "") return false;
      if (cur.some((p) => p.playerId === player.id)) return false;
      const next = [...cur];
      next[idx] = manualPickOf(player);
      commit(next);
      return true;
    },
    [commit]
  );

  const restoreManual = useCallback(
    (snapshot: DraftPick[]) => {
      commit(snapshot);
    },
    [commit]
  );

  // My most recent pick that screen sync left as a placeholder for me.
  const myOpenPick = useMemo(() => {
    for (let i = picks.length - 1; i >= 0; i--) {
      const p = picks[i];
      if (p.playerId) continue;
      if (pickOwner(p.pickNo, teams, tradedPicks, order) === mySlot) return p.pickNo;
    }
    return null;
  }, [picks, teams, tradedPicks, mySlot, order]);

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
    onClockSlot: pickOwner(Math.min(currentPick, teams * rounds), teams, tradedPicks, order),
    markDrafted,
    markMany,
    markUnknown,
    setCurrentPick,
    fillUnknown,
    applyImport,
    applySequence,
    fillAt,
    myOpenPick,
    restoreManual,
    undo,
    undoMany,
    canUndo: manualPicks.length > 0,
    manualCount: manualPicks.length,
    isManuallyMarked,
    unmark,
    removeManualAt,
    reset,
    lastPickFlash,
  };
}
