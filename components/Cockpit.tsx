"use client";

// The cockpit: one screen, readable in 20 seconds under pressure.
// The answer is huge, the reason is one line, the tier board sits in
// peripheral vision, and the Pick button confirms — it never computes.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, BoardPlayer, LeagueConfig, Position, Strategy } from "../lib/types";
import { recommend, BESTBALL_TARGETS } from "../lib/engine/recommend";
import { gradeBoard } from "../lib/engine/injuryFeed";
import { survivalProb } from "../lib/engine/survival";
import { useDraft } from "../lib/client/useDraft";
import { POS_COLOR } from "../lib/client/pos";
import {
  loadCustomStrategy,
  saveCustomStrategy,
  type CustomStrategyParams,
} from "../lib/client/config";
import TierBoard from "./TierBoard";
import SearchBox, { type SearchBoxHandle } from "./SearchBox";
import InjuryBadge from "./InjuryBadge";
import Confetti, { type Burst } from "./Confetti";
import Recap from "./Recap";
import PlayerModal from "./PlayerModal";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import RecentPicks from "./RecentPicks";
import RoomStrip from "./RoomStrip";
import PasteImport from "./PasteImport";
import Shortlist from "./Shortlist";
import ScreenSync from "./ScreenSync";
import { parsePastedPicks } from "../lib/draft/pasteImport";
import type { ImportItem } from "../lib/client/useDraft";
import { stackPartners } from "../lib/client/stacks";
import { upsertDraft } from "../lib/client/history";
import { searchPlayers } from "../lib/draft/fuzzy";
import { useLiveSignals } from "../lib/client/useLiveSignals";
import { playerBlurb, type BlurbContext } from "../lib/engine/reasons";
import { pickOwner, picksForSlot } from "../lib/draft/snake";
import { startWalkthrough } from "./Walkthrough";
import { simulateRoom } from "../lib/engine/season";

interface Props {
  board: Board;
  config: LeagueConfig;
  strategies: Strategy[];
  /** Back to the setup screen. The draft stays saved and resumable. */
  onHome: () => void;
}

function customStrategy(p: CustomStrategyParams, bestball: boolean): Strategy {
  return {
    id: "custom",
    label: "Custom",
    blurb: "Your dials.",
    lambda: p.lambda,
    baselineBlend: p.baselineBlend,
    adpDiscipline: p.adpDiscipline,
    stacking: p.stacking,
    positionMultipliers: { "1-5": { RB: p.earlyRb, WR: p.earlyWr } },
    positionCaps: bestball
      ? { QB: 3, TE: 3, K: 1, DST: 1 }
      : { QB: 2, TE: 2, K: 1, DST: 1 },
  };
}

const SLOT_ORDER: (keyof LeagueConfig["rosterSlots"])[] = ["QB", "RB", "WR", "TE", "FLEX", "K", "DST"];


export default function Cockpit({ board, config, strategies, onHome }: Props) {
  const draft = useDraft(board, config);
  const [strategyId, setStrategyId] = useState(config.strategy);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  /** An unknown pick being filled in by name via the search box. */
  const [fillTarget, setFillTarget] = useState<{ index: number; pickNo: number } | null>(null);
  const byId = useMemo(() => new Map(board.players.map((p) => [p.id, p])), [board]);
  const [custom, setCustom] = useState<CustomStrategyParams | null>(null);
  const [showDials, setShowDials] = useState(false);
  const [toast, setToast] = useState<{ text: string; undoable: boolean; onUndo?: () => void } | null>(null);
  /** Paste-import modal: null closed, "" opens with an empty textarea. */
  const [pasteText, setPasteText] = useState<string | null>(null);
  const [screenSync, setScreenSync] = useState(false);
  const [modalPlayer, setModalPlayer] = useState<BoardPlayer | null>(null);
  const [endedEarly, setEndedEarly] = useState(false);
  const [boardQuery, setBoardQuery] = useState("");
  const [winProb, setWinProb] = useState<{ pct: number; delta: number | null } | null>(null);
  const prevWinRef = useRef<number | null>(null);


  // Live win probability: after each of my picks, quietly re-simulate the
  // room (200 seasons, ~0.5s, async) and show how the number moved.
  useEffect(() => {
    if (draft.myRoster.length < 3) return;
    const rosterCount = draft.myRoster.length;
    const t = setTimeout(() => {
      const rosters: BoardPlayer[][] = Array.from({ length: config.teams }, () => []);
      for (const pick of draft.picks) {
        const pl = byId.get(pick.playerId);
        if (!pl) continue;
        const owner = pickOwner(pick.pickNo, config.teams, draft.tradedPicks, config.draftOrder);
        rosters[owner - 1]?.push(pl);
      }
      const { winRate } = simulateRoom(rosters, config, 200, Date.now() & 0x7fffffff);
      const mine = winRate[(config.myDraftSlot ?? 1) - 1] ?? 0;
      setWinProb({ pct: mine, delta: prevWinRef.current != null ? mine - prevWinRef.current : null });
      prevWinRef.current = mine;
      void rosterCount;
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sim only when MY roster grows
  }, [draft.myRoster.length]);

  // Every live signal — trending, ESPN headlines, RSS, the Bluesky wire and
  // lists, the ESPN injuries table, Jetstream push — through one shared hook.
  const live = useLiveSignals(board, (id, item) => {
    const player = board.players.find((p) => p.id === id);
    if (player) showToast(`📰 ${player.name}: ${item.headline.slice(0, 70)}`);
  });
  const { boardNews, trendingIds } = live;

  // Live news, graded. The ESPN table sets Questionable/Doubtful/Out (and can
  // clear); hard-signal headlines can only escalate. recommend() still sees a
  // plain board, just a truer one — engine purity intact.
  const gradedBoard = useMemo<Board>(
    () => gradeBoard(board, live.liveStatus, boardNews),
    [board, live.liveStatus, boardNews]
  );
  const searchRef = useRef<SearchBoxHandle>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration
  useEffect(() => setCustom(loadCustomStrategy()), []);

  const bestball = config.leagueType === "bestball";
  const strategy = useMemo(() => {
    if (strategyId === "custom" && custom) return customStrategy(custom, bestball);
    return strategies.find((s) => s.id === strategyId) ?? strategies[0];
  }, [strategyId, strategies, custom, bestball]);

  // The strategy the backtest says to use for THIS format, and the options
  // worth offering. A hidden preset stays in config for the backtest but is
  // kept out of the picker — nine near-identical choices was the problem.
  const recommendedId = useMemo(
    () =>
      strategies.find((s) => s.recommendedFor?.includes(config.leagueType))?.id ??
      strategies[0]?.id,
    [strategies, config.leagueType]
  );
  const pickable = useMemo(
    () => strategies.filter((s) => !s.hidden || s.id === strategyId),
    [strategies, strategyId]
  );

  const totalPicks = config.teams * config.rounds;
  const draftOver = draft.currentPick > totalPicks || endedEarly;
  // Recap opens itself when the draft ends; header button opens it any time.
  const [recapChoice, setRecapChoice] = useState<boolean | null>(null);
  const recapOpen = recapChoice ?? draftOver;

  // Draft history: one stable session id per draft, refresh-safe (persisted),
  // renewed on reset so back-to-back drafts of the same format don't collide.
  const sessionIdRef = useRef<string | null>(null);
  function currentSessionId(): string {
    if (sessionIdRef.current) return sessionIdRef.current;
    const fingerprint = `${config.platform}:${config.draftId || "manual"}:${config.teams}x${config.rounds}:${config.myDraftSlot}`;
    try {
      const raw = localStorage.getItem("draft-cockpit-session-v1");
      const saved = raw ? (JSON.parse(raw) as { fingerprint: string; id: string }) : null;
      if (saved && saved.fingerprint === fingerprint) {
        sessionIdRef.current = saved.id;
        return saved.id;
      }
      const id = `${fingerprint}:${Date.now().toString(36)}`;
      localStorage.setItem("draft-cockpit-session-v1", JSON.stringify({ fingerprint, id }));
      sessionIdRef.current = id;
      return id;
    } catch {
      const id = `${fingerprint}:mem`;
      sessionIdRef.current = id;
      return id;
    }
  }
  function renewSession() {
    sessionIdRef.current = null;
    try {
      localStorage.removeItem("draft-cockpit-session-v1");
    } catch {
      // ignore
    }
  }
  useEffect(() => {
    if (draft.picks.length < 3) return; // don't record empty fiddling
    upsertDraft(currentSessionId(), config, draft.picks, draft.tradedPicks, draftOver);
  }); // runs after each render; upsert is cheap and idempotent per state
  const myTurn = draft.myPicks[0] === draft.currentPick;
  const planningPick = draft.myPicks[0] ?? draft.currentPick;

  const output = useMemo(() => {
    if (draftOver || draft.myPicks.length === 0) return null;
    return recommend({
      board: gradedBoard.players,
      draftedIds: draft.draftedIds,
      myRoster: draft.myRoster,
      currentPick: planningPick,
      myPicks: draft.myPicks,
      config,
      strategy,
      drift: draft.drift,
      opponentCounts: draft.opponentCounts,
      opponentRosters: draft.opponentRosters,
    });
  }, [gradedBoard, draft.draftedIds, draft.myRoster, planningPick, draft.myPicks, config, strategy, draftOver, draft.drift, draft.opponentCounts, draft.opponentRosters]);

  // Every seat's build, mine included — the room strip and the shortlist read this.
  const mySlot = config.myDraftSlot ?? 1;
  const rostersBySlot = useMemo<Record<number, BoardPlayer[]>>(
    () => ({ ...draft.opponentRosters, [mySlot]: draft.myRoster }),
    [draft.opponentRosters, draft.myRoster, mySlot]
  );
  const nextPickBySlot = useMemo(() => {
    const out: Record<number, number | undefined> = {};
    for (let s = 1; s <= config.teams; s++) {
      out[s] = picksForSlot(s, config.teams, config.rounds, draft.tradedPicks, config.draftOrder).find((n) => n >= draft.currentPick);
    }
    return out;
  }, [config.teams, config.rounds, config.draftOrder, draft.tradedPicks, draft.currentPick]);

  // The seat on the clock, modeled with the engine from ITS roster and ITS
  // remaining picks (default strategy for the format — opponents don't share
  // my dials). Only when it isn't my turn and the room isn't syncing itself.
  const shortlistNeeded = !myTurn && !draftOver && !(config.platform === "sleeper" && draft.live);
  const shortlist = useMemo(() => {
    if (!shortlistNeeded) return null;
    const slot = draft.onClockSlot;
    const theirs = rostersBySlot[slot] ?? [];
    const theirPicks = picksForSlot(slot, config.teams, config.rounds, draft.tradedPicks, config.draftOrder).filter((n) => n >= draft.currentPick);
    if (theirPicks.length === 0) return null;
    const others: Record<number, BoardPlayer[]> = {};
    const counts: Record<number, Partial<Record<Position, number>>> = {};
    for (const [s, roster] of Object.entries(rostersBySlot)) {
      if (Number(s) === slot) continue;
      others[Number(s)] = roster;
      const c: Partial<Record<Position, number>> = {};
      for (const p of roster) c[p.pos] = (c[p.pos] ?? 0) + 1;
      counts[Number(s)] = c;
    }
    const base = strategies.find((s) => s.id === recommendedId) ?? strategies[0];
    const out = recommend({
      board: gradedBoard.players,
      draftedIds: draft.draftedIds,
      myRoster: theirs,
      currentPick: draft.currentPick,
      myPicks: theirPicks,
      config: { ...config, myDraftSlot: slot },
      strategy: base,
      drift: draft.drift,
      opponentCounts: counts,
      opponentRosters: others,
    });
    const ranked = (out.scored ?? out.recommendations).map((r) => r.player).slice(0, 10);
    const has: Partial<Record<Position, number>> = {};
    for (const p of theirs) has[p.pos] = (has[p.pos] ?? 0) + 1;
    return { slot, pickNo: draft.currentPick, players: ranked, counts: has, ids: new Set(ranked.map((p) => p.id)) };
  }, [shortlistNeeded, draft.onClockSlot, rostersBySlot, config, draft.tradedPicks, draft.currentPick, strategies, recommendedId, gradedBoard, draft.draftedIds, draft.drift]);

  // Shortlist hit rate: every pick marked from elsewhere (search, paste, board,
  // screen sync) is scored against the list that was showing at the time.
  const [shortlistHits, setShortlistHits] = useState({ hits: 0, misses: 0 });
  const shortlistIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    shortlistIdsRef.current = shortlist?.ids ?? null;
  }, [shortlist]);
  function scoreAgainstShortlist(player: BoardPlayer) {
    const ids = shortlistIdsRef.current;
    if (!ids) return;
    setShortlistHits((s) => (ids.has(player.id) ? { ...s, hits: s.hits + 1 } : { ...s, misses: s.misses + 1 }));
  }

  const top = output?.recommendations[0];
  const alternates = output?.recommendations.slice(1) ?? [];
  const picksUntilMe = draft.myPicks.length > 0 ? draft.myPicks[0] - draft.currentPick : null;

  // Browser tab is a second signal — glanceable from another window.
  useEffect(() => {
    document.title = draftOver
      ? "Draft over — Draft Cockpit"
      : myTurn
        ? "🟢 YOUR PICK — Draft Cockpit"
        : `Pick ${draft.currentPick}${picksUntilMe != null ? ` · you in ${picksUntilMe}` : ""} — Draft Cockpit`;
  }, [draftOver, myTurn, draft.currentPick, picksUntilMe]);

  // Snipe detection: the player we were planning to take got drafted by
  // someone else → say so, loudly, with the new answer already on screen.
  const myIds = useMemo(() => new Set(draft.myRoster.map((p) => p.id)), [draft.myRoster]);
  const prevTopRef = useRef<{ id: string; name: string } | null>(null);
  const [snipe, setSnipe] = useState<string | null>(null);
  useEffect(() => {
    const prev = prevTopRef.current;
    if (prev && draft.draftedIds.has(prev.id)) {
      if (!myIds.has(prev.id)) {
        setSnipe(prev.name); // reacting to the external pick feed
      }
      prevTopRef.current = null;
    }
    if (top && !draft.draftedIds.has(top.player.id)) {
      prevTopRef.current = { id: top.player.id, name: top.player.name };
    }
  }, [draft.draftedIds, top, myIds]);

  const [burst, setBurst] = useState<Burst | null>(null);

  function mark(player: BoardPlayer, mine = false, fromShortlist = false) {
    if (!mine && !fromShortlist) scoreAgainstShortlist(player);
    // Screen sync may already have moved the room past my pick, leaving my
    // slot as a placeholder: my pick fills THAT slot, never a later one.
    if (mine && draft.myOpenPick != null && draft.fillAt(draft.myOpenPick, player)) {
      setSnipe(null);
      setBurst({ key: Date.now(), color: POS_COLOR[player.pos] });
      showToast(`Drafted ${player.name} at pick ${draft.myOpenPick}.`, true);
      return;
    }
    draft.markDrafted(player);
    if (mine) {
      setSnipe(null);
      setBurst({ key: Date.now(), color: POS_COLOR[player.pos] });
    }
    showToast(mine ? `Drafted ${player.name}.` : `${player.name} is off the board.`, true);
  }

  function showToast(text: string, undoable = false, onUndo?: () => void) {
    setToast({ text, undoable, onUndo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), undoable ? (onUndo ? 8000 : 4500) : 2200);
  }

  /** Commit a batch of picks (paste) with one undo for the lot. */
  function commitImport(items: ImportItem[], source: string) {
    if (items.length === 0) return;
    const out = draft.applyImport(items);
    const changed = out.added + out.filled + out.padded + out.inserted;
    const parts = [
      out.added + out.filled + out.inserted > 0 ? `${out.added + out.filled + out.inserted} marked` : null,
      out.inserted > 0 ? `${out.inserted} backfilled, ${out.shifted} moved down` : null,
      out.padded > 0 ? `${out.padded} unknown` : null,
      out.skipped > 0 ? `${out.skipped} already gone` : null,
    ].filter(Boolean);
    showToast(`${source}: ${parts.join(" · ") || "nothing new"}.`, changed > 0, () => draft.restoreManual(out.snapshot));
  }

  /**
   * One ordered read of the room's pick history from screen sync. My own
   * picks are recorded like everyone else's — I draft on the site, the app
   * watches — and get the same celebration as the Draft button.
   */
  function applyScreenFrame(ids: string[]) {
    const out = draft.applySequence(ids);
    if (out.placed.length === 0) return out;
    const mine = out.placed.filter((p) => pickOwner(p.pickNo, config.teams, draft.tradedPicks, config.draftOrder) === mySlot);
    for (const p of out.placed) if (!mine.includes(p)) scoreAgainstShortlist(p.player);
    if (mine.length > 0) {
      setSnipe(null);
      setBurst({ key: Date.now(), color: POS_COLOR[mine[mine.length - 1].player.pos] });
    }
    const others = out.placed.length - mine.length;
    const parts = [
      mine.length > 0 ? `you drafted ${mine.map((p) => p.player.name).join(" and ")}` : null,
      others > 0 ? `${others} other pick${others === 1 ? "" : "s"}` : null,
      out.shifted > 0 ? `${out.shifted} re-ordered after a missed pick` : null,
    ].filter(Boolean);
    showToast(`Screen sync: ${parts.join(" · ")}.`, true, () => draft.restoreManual(out.snapshot));
    return out;
  }

  // Paste anywhere: a multi-line clipboard (or several names) opens the import
  // preview. A single name pasted into the search box stays a normal paste.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (pasteText != null || confirm || modalPlayer) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text.trim()) return;
      const target = e.target as HTMLElement | null;
      const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      const multiLine = /\n/.test(text.trim());
      if (inField && !multiLine) return;
      if (!multiLine) {
        const found = parsePastedPicks(text, gradedBoard.players, draft.draftedIds, { teams: config.teams }).matches.filter((m) => m.player).length;
        if (found < 2) return;
      }
      e.preventDefault();
      setPasteText(text);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }); // cheap, always-fresh closures (same pattern as the keyboard handler)

  /** Fill the rest of the draft: engine picks for me, ADP for the room. */
  function autoComplete() {
    const drafted = new Set(draft.draftedIds);
    const roster = [...draft.myRoster];
    const additions: BoardPlayer[] = [];
    const adpOrder = [...gradedBoard.players].sort((a, b) => a.adp - b.adp);
    for (let pickNo = draft.currentPick; pickNo <= totalPicks; pickNo++) {
      const owner = pickOwner(pickNo, config.teams, draft.tradedPicks, config.draftOrder);
      let choice: BoardPlayer | undefined;
      if (owner === (config.myDraftSlot ?? 1)) {
        const out = recommend({
          board: gradedBoard.players,
          draftedIds: drafted,
          myRoster: roster,
          currentPick: pickNo,
          myPicks: draft.myPicks.filter((n) => n >= pickNo),
          config,
          strategy,
          drift: draft.drift,
          opponentCounts: draft.opponentCounts,
          opponentRosters: draft.opponentRosters,
        });
        choice = out.recommendations[0]?.player;
        if (choice) roster.push(choice);
      } else {
        choice = adpOrder.find((p) => !drafted.has(p.id));
      }
      if (choice) {
        drafted.add(choice.id);
        additions.push(choice);
      }
    }
    draft.markMany(additions);
    showToast(`Auto-completed ${additions.length} picks.`);
  }

  const blurbCtx: BlurbContext & { for: (p: BoardPlayer) => ReturnType<typeof playerBlurb> } = {
    currentPick: draft.currentPick,
    nextPick: draft.myPicks.find((n) => n > draft.currentPick) ?? draft.currentPick + config.teams,
    drift: draft.drift,
    tierMatesLeft: 0,
    for(p: BoardPlayer) {
      return playerBlurb(p, {
        ...this,
        tierMatesLeft: gradedBoard.players.filter(
          (a) => a.pos === p.pos && a.tier === p.tier && a.id !== p.id && !draft.draftedIds.has(a.id)
        ).length,
      });
    },
  };

  // Keyboard: / focuses search, Enter drafts the pick, ⌘Z undoes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (confirm) return; // a question is on screen — no drafting, no undo
      const inField =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLSelectElement ||
        document.activeElement instanceof HTMLButtonElement;
      if (e.key === "/" && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Enter" && !inField && top) {
        mark(top.player, myTurn);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "z" && draft.canUndo) {
        e.preventDefault();
        draft.undo();
        showToast("Undone.");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // deliberately unmemoized: cheap, always-fresh closures

  const staleSources = board.meta.sources.filter((s) => s.fromFixture);
  const posColor = top ? POS_COLOR[top.player.pos] : "var(--color-ink)";

  // Look-ahead: what each position probably offers at my pick after this one.
  const planner = useMemo(() => {
    const n2 = draft.myPicks[1];
    if (!n2 || draftOver) return null;
    const rows = (["QB", "RB", "WR", "TE"] as Position[]).map((pos) => {
      const cands = gradedBoard.players
        .filter((p) => p.pos === pos && !draft.draftedIds.has(p.id))
        .sort((a, b) => b.projPoints - a.projPoints)
        .slice(0, 8)
        .map((p) => ({ p, s: survivalProb(p, n2, draft.drift) }));
      const best = cands[0];
      const likely = cands.find((x) => x.s >= 0.55) ?? cands[cands.length - 1];
      return { pos, best, likely };
    });
    return { n2, rows };
  }, [gradedBoard, draft.draftedIds, draft.myPicks, draft.drift, draftOver]);

  // Roster slot fill (starters first, then bench)
  const rosterView = useMemo(() => {
    const remaining = [...draft.myRoster];
    const view: { slot: string; player: BoardPlayer | null }[] = [];
    for (const slot of SLOT_ORDER) {
      const n = config.rosterSlots[slot] ?? 0;
      for (let i = 0; i < n; i++) {
        const idx =
          slot === "FLEX"
            ? remaining.findIndex((p) => config.flexEligible.includes(p.pos))
            : remaining.findIndex((p) => p.pos === slot);
        view.push({ slot: slot as string, player: idx >= 0 ? remaining.splice(idx, 1)[0] : null });
      }
    }
    for (const p of remaining) view.push({ slot: "BN", player: p });
    return view;
  }, [draft.myRoster, config]);

  if (recapOpen) {
    return (
      <Recap
        board={board}
        config={config}
        picks={draft.picks}
        tradedPicks={draft.tradedPicks}
        mySlot={config.myDraftSlot ?? 1}
        draftOver={draftOver}
        onClose={() => setRecapChoice(false)}
      />
    );
  }

  return (
    <main data-tour-screen="cockpit" className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-4 pb-4 pt-3 lg:h-dvh">
      {/* Status bar */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-2">
        <button
          onClick={() =>
            setConfirm({
              title: "Back to setup?",
              body:
                draft.picks.length > 0 && !draftOver
                  ? `${draft.picks.length} picks are on the board. The draft stays saved — resume it from the setup screen any time.`
                  : "The draft stays saved — you can come straight back to it.",
              confirmLabel: "Go to setup",
              onConfirm: onHome,
            })
          }
          title="Back to the setup screen (the draft is saved)"
          className="rounded border border-line bg-panel px-2.5 py-1.5 text-sm font-semibold text-ink-dim hover:text-ink"
        >
          ← Home
        </button>
        <div className="font-mono text-sm text-ink" key={draft.currentPick}>
          <span className={draft.lastPickFlash ? "pick-flash rounded px-1" : "px-1"}>
            {draftOver ? "DRAFT OVER" : `PICK ${draft.currentPick} · RND ${draft.round}`}
          </span>
          {!draftOver && myTurn && (
            <span className="ml-2 font-semibold uppercase" style={{ color: posColor }}>
              you&apos;re on the clock
            </span>
          )}
          {!draftOver && !myTurn && picksUntilMe != null && (
            <span className="ml-2 text-ink-dim">
              slot {draft.onClockSlot} up ·{" "}
              <span className="text-ink">
                {picksUntilMe === 1 ? "you're next" : `you in ${picksUntilMe}`}
              </span>{" "}
              (pick {draft.myPicks[0]}{draft.myPicks[1] ? `, then ${draft.myPicks[1]}` : ""})
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => { draft.undo(); showToast("Undone."); }}
            disabled={!draft.canUndo}
            className="rounded border border-line bg-panel px-2.5 py-1.5 text-sm font-semibold text-ink-dim hover:text-ink disabled:opacity-30"
            title="Undo last manual mark (⌘Z)"
          >
            Undo
          </button>
          <button
            data-tour="recap"
            onClick={() => setRecapChoice(true)}
            title="Room standings, grades, and season simulation"
            className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink-dim hover:text-ink"
          >
            Recap
          </button>
          <details data-tour="controls" className="relative">
            <summary
              className="cursor-pointer list-none rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink-dim hover:text-ink"
              title="Strategy, tour, and draft controls"
            >
              ⋯
            </summary>
            <div className="absolute right-0 z-30 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-panel-2 shadow-xl">
              {/* Strategy: auto-picked per format; here for the curious, out of the way for everyone else. */}
              <div className="border-b border-line px-3 py-2" data-tour="strategy">
                <label className="block text-xs text-ink-faint" htmlFor="strategy">
                  Strategy <span className="text-ink-faint">· auto-picked for {bestball ? "best ball" : "redraft"}</span>
                </label>
                <select
                  id="strategy"
                  value={strategyId}
                  onChange={(e) => setStrategyId(e.target.value)}
                  title={strategy.blurb}
                  className="mt-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm"
                >
                  {pickable.map((s) => (
                    <option key={s.id} value={s.id} title={s.blurb}>
                      {s.label}
                      {s.id === recommendedId ? " · recommended" : ""}
                    </option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
                {strategyId === "custom" && (
                  <button
                    onClick={() => setShowDials((v) => !v)}
                    className="mt-1.5 text-xs text-wr hover:underline"
                    aria-expanded={showDials}
                  >
                    {showDials ? "Hide dials" : "Show dials"}
                  </button>
                )}
              </div>
              <button
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                  startWalkthrough();
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-panel"
              >
                Feature tour
                <span className="block text-xs text-ink-faint">Replay the walkthrough</span>
              </button>
              <button
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                  setConfirm({
                    title: "Auto-complete the draft?",
                    body: "The engine drafts your remaining picks and ADP drafts the room. Reset clears it if you change your mind.",
                    confirmLabel: "Auto-complete",
                    onConfirm: autoComplete,
                  });
                }}
                data-tour="auto-complete"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-panel"
              >
                Auto-complete draft
                <span className="block text-xs text-ink-faint">Engine picks for you, ADP for the room</span>
              </button>
              <button
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                  setEndedEarly(true);
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-panel"
              >
                End draft now
                <span className="block text-xs text-ink-faint">Jump to the recap as-is</span>
              </button>
              {endedEarly && (
                <button
                  onClick={(e) => {
                    (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                    setEndedEarly(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-panel"
                >
                  Resume draft
                </button>
              )}
              <button
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                  setConfirm({
                    title: "Reset the draft?",
                    body: "Every manually marked pick is cleared and the board starts over.",
                    confirmLabel: "Reset",
                    danger: true,
                    onConfirm: () => {
                      draft.reset();
                      setEndedEarly(false);
                      renewSession(); // the next draft gets its own history entry
                      showToast("Draft reset.");
                    },
                  });
                }}
                className="block w-full px-3 py-2 text-left text-sm text-warn hover:bg-panel"
              >
                Reset draft
                <span className="block text-xs text-ink-faint">Clears all manual picks</span>
              </button>
            </div>
          </details>
          <span
            className="hidden rounded bg-panel px-2 py-1.5 font-mono text-xs text-ink-faint sm:inline"
            title="This draft's format — change it from the setup screen"
          >
            {config.teams}tm · {config.scoring} · {bestball ? "best ball" : "redraft"}
            {config.draftOrder === "snake3rr" ? " · 3RR" : config.draftOrder === "linear" ? " · linear" : ""}
          </span>
          {config.platform === "sleeper" && (
            <span
              className="flex items-center gap-1.5 font-mono text-xs uppercase"
              style={{ color: draft.live ? "var(--color-live)" : "var(--color-warn)" }}
            >
              <span
                className="ping-dot inline-block h-2 w-2 rounded-full"
                style={{ background: "currentColor" }}
                aria-hidden
              />
              {draft.live ? "live" : "offline"}
            </span>
          )}
        </div>
      </header>

      {/* Custom dials */}
      {strategyId === "custom" && showDials && custom && (
        <section className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-panel p-3 sm:grid-cols-6">
          {(
            [
              ["lambda", "Risk λ (neg = chase ceiling)", -0.5, 1.5],
              ["baselineBlend", "VORP ↔ VOLS", 0, 1],
              ["adpDiscipline", "ADP discipline", 0, 1],
              ["stacking", "Stacking", 0, 1.5],
              ["earlyRb", "Early RB ×", 0.4, 1.6],
              ["earlyWr", "Early WR ×", 0.4, 1.6],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key} className="text-xs text-ink-dim">
              {label}: <span className="font-mono text-ink">{custom[key].toFixed(2)}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={0.05}
                value={custom[key]}
                onChange={(e) => {
                  const next = { ...custom, [key]: Number(e.target.value) };
                  setCustom(next);
                  saveCustomStrategy(next);
                }}
                className="mt-1 w-full"
              />
            </label>
          ))}
        </section>
      )}

      <RoomStrip
        teams={config.teams}
        mySlot={mySlot}
        onClockSlot={draft.onClockSlot}
        draftOver={draftOver}
        rosters={rostersBySlot}
        nextPickBySlot={nextPickBySlot}
        onOpen={setModalPlayer}
      />

      <RecentPicks
        picks={draft.picks}
        currentPick={draft.currentPick}
        totalPicks={totalPicks}
        mySlot={config.myDraftSlot ?? 1}
        byId={byId}
        manual={config.platform !== "sleeper" || !draft.live}
        onOpen={setModalPlayer}
        onRemove={(i) => {
          draft.removeManualAt(i);
          showToast("Pick removed.");
        }}
        onFillUnknown={(index, pickNo) => {
          setFillTarget({ index, pickNo });
          searchRef.current?.focus();
        }}
        onUnknown={() => {
          draft.markUnknown();
          showToast("Unknown pick added — click it in Recent to fill in the name.", true);
        }}
        onSetPick={(n) => {
          const removed = draft.setCurrentPick(n);
          showToast(
            removed > 0
              ? `Back to pick ${n} — removed ${removed} mark${removed === 1 ? "" : "s"}.`
              : `Now at pick ${n}.`
          );
        }}
      />

      {/* Warnings */}
      {(output?.strategyWarning || draft.syncError || staleSources.length > 0) && (
        <div className="mt-2 space-y-1">
          {output?.strategyWarning && (
            <p className="rounded bg-panel px-3 py-2 text-sm text-warn">{output.strategyWarning}</p>
          )}
          {draft.syncError && (
            <p className="rounded bg-panel px-3 py-2 text-sm text-warn">{draft.syncError}</p>
          )}
          {staleSources.map((s) => (
            <p key={s.name} className="rounded bg-panel px-3 py-2 text-sm text-warn">
              {s.name} is stale — using cached data from {new Date(s.fetchedAt).toLocaleDateString()}.
              Run <code className="font-mono">pnpm build:board</code> before the draft.
            </p>
          ))}
        </div>
      )}

      {/* Main grid */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* The answer */}
        <section
          className="tier-scroll flex flex-col gap-3 lg:min-h-0 lg:w-[440px] lg:shrink-0 lg:overflow-y-auto lg:pr-1"
          aria-live="polite"
        >
          {draftOver ? (
            <div className="rounded-lg bg-panel p-6">
              <h2 className="font-display text-4xl font-bold uppercase">Draft over</h2>
              <p className="mt-2 text-ink-dim">Good luck this season.</p>
            </div>
          ) : draft.myPicks.length === 0 ? (
            <div className="rounded-lg bg-panel p-6">
              <h2 className="font-display text-4xl font-bold uppercase">Out of picks</h2>
              <p className="mt-2 text-ink-dim">Keep marking picks to track the room.</p>
            </div>
          ) : top ? (
            <div
              data-tour="answer"
              className={`rounded-lg border-l-4 bg-panel p-5 ${myTurn ? "on-the-clock" : ""}`}
              style={{ borderLeftColor: posColor, ["--pulse-color" as string]: posColor }}
            >
              {snipe && (
                <div className="shake-in mb-3 flex items-start justify-between gap-2 rounded bg-warn/15 px-3 py-2 text-sm text-warn">
                  <span>
                    Sniped — <strong>{snipe}</strong> is gone. New pick below.
                  </span>
                  <button
                    onClick={() => setSnipe(null)}
                    aria-label="Dismiss snipe alert"
                    className="font-mono text-xs text-warn/80 hover:text-warn"
                  >
                    ✕
                  </button>
                </div>
              )}
              {top.player.ids.espn && (
                /* eslint-disable-next-line @next/next/no-img-element -- remote CDN */
                <img
                  src={`https://a.espncdn.com/i/headshots/nfl/players/full/${top.player.ids.espn}.png`}
                  alt=""
                  width={110}
                  height={80}
                  className="rise-in float-right -mr-1 -mt-1 h-20 w-auto rounded-lg bg-field/60 object-cover"
                  key={`img-${top.player.id}`}
                  onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                />
              )}
              <p
                className={`font-mono text-xs uppercase tracking-widest ${myTurn ? "font-semibold" : "text-ink-dim"}`}
                style={myTurn ? { color: posColor } : undefined}
              >
                {myTurn
                  ? `You're on the clock — pick ${planningPick}`
                  : `Plan for your pick ${planningPick} · ${picksUntilMe === 1 ? "you're next" : `${picksUntilMe} picks away`}`}
              </p>
              <h2 className="mt-1 font-display text-6xl font-bold uppercase leading-[0.95] tracking-tight sm:text-7xl">
                <button
                  onClick={() => setModalPlayer(top.player)}
                  title={`${top.player.name} — stats, news, verdict`}
                  className="name-in text-left uppercase decoration-2 underline-offset-8 hover:underline"
                  key={top.player.id}
                  style={{ color: posColor }}
                >
                  {top.player.name}
                </button>
              </h2>
              <p className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-sm text-ink-dim">
                <span style={{ color: posColor }}>{top.player.pos}</span> · {top.player.team} · bye{" "}
                {top.player.bye ?? "—"} · {Math.round(top.player.projPoints)} proj
                <InjuryBadge injury={top.player.injury} />
                {stackPartners(top.player, draft.myRoster).map((s) => (
                  <span key={s.id} className="rounded bg-warn/15 px-1.5 font-mono text-[10px] text-warn" title={`Same-team stack with ${s.name}`}>
                    ⚡ stacks w/ {s.name.split(" ").slice(-1)[0]}
                  </span>
                ))}
              </p>
              <p className="mt-3 text-[15px] leading-snug text-ink">{top.reason}</p>
              <div className="relative">
                <button
                  onClick={() => mark(top.player, myTurn)}
                  className="btn-shimmer mt-4 w-full rounded-lg py-4 font-display text-3xl font-bold uppercase tracking-wide text-field"
                  style={{ background: posColor }}
                >
                  {myTurn ? `Draft ${top.player.name.split(" ").slice(-1)[0]}` : "Mark him gone"}
                </button>
                <Confetti burst={burst} />
              </div>
              {output && (
                <p className="mt-2 text-right font-mono text-[10px] text-ink-faint">
                  {output.computeMs.toFixed(0)}ms
                </p>
              )}
            </div>
          ) : null}

          {/* Alternates — disagree quickly */}
          {alternates.length > 0 && !draftOver && (
            <ol data-tour="alternates" className="stagger space-y-2">
              {alternates.map((r, i) => (
                <li key={r.player.id}>
                  <button
                    onClick={() => setModalPlayer(r.player)}
                    title={`${r.player.name} — stats, news, verdict`}
                    className="lift flex w-full items-baseline gap-3 rounded-lg border-l-4 bg-panel px-4 py-2.5 text-left hover:bg-panel-2"
                    style={{ borderLeftColor: POS_COLOR[r.player.pos] }}
                  >
                    <span className="font-mono text-xs text-ink-faint">{i + 2}</span>
                    <span className="min-w-0">
                      <span className="font-display text-xl font-bold uppercase">
                        {r.player.name}
                      </span>
                      <span className="ml-2 font-mono text-xs text-ink-dim">
                        {r.player.pos} · {r.player.team} <InjuryBadge injury={r.player.injury} />
                        {stackPartners(r.player, draft.myRoster).length > 0 && (
                          <span className="ml-1 text-warn" title={`Stacks with ${stackPartners(r.player, draft.myRoster).map((s) => s.name).join(", ")}`}>
                            ⚡
                          </span>
                        )}
                      </span>
                      <span className="block text-sm text-ink-dim">{r.reason}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {shortlist && (
            <Shortlist
              slot={shortlist.slot}
              pickNo={shortlist.pickNo}
              players={shortlist.players}
              counts={shortlist.counts}
              hits={shortlistHits.hits}
              misses={shortlistHits.misses}
              onMark={(p) => mark(p, false, true)}
              onOpen={setModalPlayer}
            />
          )}

          {/* Manual entry — always available, even in Sleeper mode */}
          <div data-tour="search">
          <SearchBox
            ref={searchRef}
            players={gradedBoard.players}
            draftedIds={draft.draftedIds}
            onMark={(p) => {
              if (fillTarget) {
                draft.fillUnknown(fillTarget.index, p);
                setFillTarget(null);
                showToast(`Pick ${fillTarget.pickNo}: ${p.name}.`);
              } else mark(p);
            }}
            onQueryChange={setBoardQuery}
            placeholder={fillTarget ? `Who was pick ${fillTarget.pickNo}? Type a name, Enter fills it in` : undefined}
          />
          <div className="-mt-1 flex items-center justify-between gap-2">
            {fillTarget ? (
              <button onClick={() => setFillTarget(null)} className="text-xs text-ink-faint hover:text-ink">
                cancel fill-in
              </button>
            ) : (
              <span className="text-[11px] text-ink-faint">⌘V anywhere pastes a whole picks list</span>
            )}
            <span className="flex gap-1.5">
              <button
                data-tour="paste"
                onClick={() => setPasteText("")}
                title="Paste the drafted-players list from any draft room — every name is matched and marked at once"
                className="rounded border border-line bg-panel px-2 py-1 text-xs text-ink-dim hover:text-ink"
              >
                Paste picks
              </button>
              {!(config.platform === "sleeper" && draft.live) && (
                <button
                  data-tour="screen-sync-open"
                  onClick={() => setScreenSync(true)}
                  title="Share your draft-room tab; the cockpit reads new picks off the screen automatically"
                  className={`rounded border px-2 py-1 text-xs ${screenSync ? "border-live text-live" : "border-line bg-panel text-ink-dim hover:text-ink"}`}
                >
                  Screen sync
                </button>
              )}
            </span>
          </div>
          </div>

          {/* Look-ahead: what's probably still there at my pick after this one */}
          {planner && (
            <div data-tour="planner" className="lift rounded-lg bg-panel p-3">
              <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
                At your pick {planner.n2}
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {planner.rows.map(({ pos, best, likely }) =>
                  best ? (
                    <li key={pos} className="flex items-baseline gap-2 text-[13px]">
                      <span className="w-7 shrink-0 font-mono text-[11px]" style={{ color: POS_COLOR[pos] }}>
                        {pos}
                      </span>
                      <button
                        onClick={() => setModalPlayer(best.p)}
                        className="truncate text-left hover:underline"
                      >
                        {best.p.name}{" "}
                        <span className="font-mono text-[10px] text-ink-faint">{best.p.team}</span>{" "}
                        <span className="font-mono text-[11px] text-ink-faint">
                          {Math.round(best.s * 100)}%
                        </span>
                      </button>
                      {likely && likely.p.id !== best.p.id && (
                        <button
                          onClick={() => setModalPlayer(likely.p)}
                          className="ml-auto truncate text-right text-ink-dim hover:underline"
                        >
                          likely: {likely.p.name}{" "}
                          <span className="font-mono text-[10px] text-ink-faint">{likely.p.team}</span>
                        </button>
                      )}
                    </li>
                  ) : null
                )}
              </ul>
            </div>
          )}

          {/* My roster */}
          <div data-tour="roster" className="rounded-lg bg-panel p-3">
            <p className="flex items-baseline gap-2 font-mono text-xs uppercase tracking-widest text-ink-dim">
              My roster{bestball ? " · best ball construction" : ""}
              {winProb && !draftOver && (
                <span className="ml-auto normal-case tracking-normal" title="Share of 200 simulated seasons your current roster outscores the room">
                  <span className="text-rb">win {(winProb.pct * 100).toFixed(1)}%</span>
                  {winProb.delta != null && Math.abs(winProb.delta) >= 0.0005 && (
                    <span className={winProb.delta > 0 ? "text-rb" : "text-qb"}>
                      {" "}{winProb.delta > 0 ? "▲" : "▼"}{Math.abs(winProb.delta * 100).toFixed(1)}
                    </span>
                  )}
                </span>
              )}
            </p>
            {bestball ? (
              <>
                <ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
                  {(["QB", "RB", "WR", "TE"] as Position[]).map((pos) => {
                    const have = draft.myRoster.filter((p) => p.pos === pos).length;
                    const [minF, maxF] = BESTBALL_TARGETS[pos] ?? [0, 0];
                    const minT = Math.round(minF * config.rounds);
                    const maxT = Math.round(maxF * config.rounds);
                    const done = have >= minT;
                    return (
                      <li key={pos} className="font-mono text-sm">
                        <span style={{ color: POS_COLOR[pos] }}>{pos}</span>{" "}
                        <span className={done ? "text-ink" : "text-warn"}>{have}</span>
                        <span className="text-ink-faint">
                          /{minT}–{maxT}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {draft.myRoster.map((player, i) => {
                    const stacks = stackPartners(player, draft.myRoster);
                    return (
                      <li key={i} className="flex items-baseline gap-1 truncate text-sm">
                        <button
                          onClick={() => setModalPlayer(player)}
                          className="truncate hover:underline"
                          style={{ color: POS_COLOR[player.pos] }}
                        >
                          {player.name}
                        </button>
                        <span className="font-mono text-[10px] text-ink-faint">{player.team}</span>
                        {stacks.length > 0 && (
                          <span className="text-[11px] text-warn" title={`Stacked with ${stacks.map((s) => s.name).join(", ")}`}>
                            ⚡
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <ul className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
                {rosterView.map(({ slot, player }, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-sm">
                    <span className="w-9 shrink-0 font-mono text-[11px] text-ink-faint">{slot}</span>
                    {player ? (
                      <>
                        <button
                          onClick={() => setModalPlayer(player)}
                          className="truncate text-left hover:underline"
                          style={{ color: POS_COLOR[player.pos] }}
                        >
                          {player.name}
                        </button>
                        <span className="font-mono text-[10px] text-ink-faint">{player.team}</span>
                        {stackPartners(player, draft.myRoster).length > 0 && (
                          <span
                            className="text-[11px] text-warn"
                            title={`Stacked with ${stackPartners(player, draft.myRoster).map((s) => s.name).join(", ")}`}
                          >
                            ⚡
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Tier board */}
        <section data-tour="board" className="min-h-0 min-w-0 flex-1" aria-label="Tier board">
          <TierBoard
            players={gradedBoard.players}
            draftedIds={draft.draftedIds}
            myIds={myIds}
            onMark={(p) => mark(p)}
            highlightId={myTurn && top ? top.player.id : null}
            onOpen={setModalPlayer}
            blurbFor={(p) => blurbCtx.for(p)}
            filterIds={
              boardQuery.trim()
                ? new Set(searchPlayers(boardQuery, gradedBoard.players, 40).map((p) => p.id))
                : null
            }
            trendingIds={trendingIds}
            newsIds={boardNews}
            positions={(["RB", "WR", "QB", "TE", "K", "DST"] as Position[]).filter(
              (pos) => (config.rosterSlots[pos] ?? 0) > 0 || !["K", "DST"].includes(pos)
            )}
          />
        </section>
      </div>

      {/* Toast — undo right where the mistake happened */}
      {toast && (
        <div
          role="status"
          className="toast-in fixed bottom-5 left-1/2 flex items-center gap-3 rounded-lg bg-panel-2 px-4 py-2 text-sm shadow-xl"
        >
          {toast.text}
          {toast.undoable && (toast.onUndo || draft.canUndo) && (
            <button
              onClick={() => {
                if (toast.onUndo) toast.onUndo();
                else draft.undo();
                showToast("Undone.");
              }}
              className="font-semibold text-wr hover:underline"
            >
              {toast.onUndo ? "Undo all" : "Undo"}
            </button>
          )}
        </div>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />

      {screenSync && (
        <ScreenSync
          players={gradedBoard.players}
          draftedIds={draft.draftedIds}
          onFrame={applyScreenFrame}
          onClose={() => setScreenSync(false)}
        />
      )}

      {pasteText != null && (
        <PasteImport
          initialText={pasteText}
          players={gradedBoard.players}
          draftedIds={draft.draftedIds}
          teams={config.teams}
          currentPick={draft.currentPick}
          onCommit={(items) => {
            setPasteText(null);
            for (const it of items) scoreAgainstShortlist(it.player);
            commitImport(items, "Pasted");
          }}
          onClose={() => setPasteText(null)}
        />
      )}

      {/* Player detail */}
      {modalPlayer && (
        <PlayerModal
          player={modalPlayer}
          ctx={{
            currentPick: blurbCtx.currentPick,
            nextPick: blurbCtx.nextPick,
            drift: blurbCtx.drift,
            tierMatesLeft: gradedBoard.players.filter(
              (a) =>
                a.pos === modalPlayer.pos &&
                a.tier === modalPlayer.tier &&
                a.id !== modalPlayer.id &&
                !draft.draftedIds.has(a.id)
            ).length,
          }}
          config={config}
          drafted={draft.draftedIds.has(modalPlayer.id)}
          canUnmark={draft.isManuallyMarked(modalPlayer.id)}
          trending={trendingIds.has(modalPlayer.id)}
          wireItem={boardNews.get(modalPlayer.id) ?? null}
          myTurn={myTurn}
          onMark={(p, mine) => mark(p, mine)}
          onUnmark={(p) => {
            draft.unmark(p.id);
            showToast(`${p.name} is back on the board.`);
          }}
          onClose={() => setModalPlayer(null)}
        />
      )}

      <footer className="mt-3 border-t border-line pt-2 text-[11px] text-ink-faint">
        ADP:{" "}
        <a className="underline" href="https://fantasyfootballcalculator.com" rel="noreferrer" target="_blank">
          Fantasy Football Calculator
        </a>{" "}
        · Player IDs &amp; rankings:{" "}
        <a className="underline" href="https://github.com/dynastyprocess/data" rel="noreferrer" target="_blank">
          DynastyProcess
        </a>{" "}
        · Draft &amp; league data:{" "}
        <a className="underline" href="https://sleeper.com" rel="noreferrer" target="_blank">
          Sleeper
        </a>{" "}
        · Projections: ESPN · Board built {new Date(board.meta.builtAt).toLocaleDateString()}
      </footer>
    </main>
  );
}
