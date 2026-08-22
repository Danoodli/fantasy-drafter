"use client";

// The cockpit: one screen, readable in 20 seconds under pressure.
// The answer is huge, the reason is one line, the tier board sits in
// peripheral vision, and the Pick button confirms — it never computes.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, BoardPlayer, LeagueConfig, Position, Strategy } from "../lib/types";
import { recommend, BESTBALL_TARGETS } from "../lib/engine/recommend";
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
import { playerBlurb } from "../lib/engine/reasons";

interface Props {
  board: Board;
  config: LeagueConfig;
  strategies: Strategy[];
  onReconfigure: () => void;
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

export default function Cockpit({ board, config, strategies, onReconfigure }: Props) {
  const draft = useDraft(board, config);
  const [strategyId, setStrategyId] = useState(config.strategy);
  const [custom, setCustom] = useState<CustomStrategyParams | null>(null);
  const [showDials, setShowDials] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<SearchBoxHandle>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration
  useEffect(() => setCustom(loadCustomStrategy()), []);

  const bestball = config.leagueType === "bestball";
  const strategy = useMemo(() => {
    if (strategyId === "custom" && custom) return customStrategy(custom, bestball);
    return strategies.find((s) => s.id === strategyId) ?? strategies[0];
  }, [strategyId, strategies, custom, bestball]);

  const totalPicks = config.teams * config.rounds;
  const draftOver = draft.currentPick > totalPicks;
  const myTurn = draft.myPicks[0] === draft.currentPick;
  const planningPick = draft.myPicks[0] ?? draft.currentPick;

  const output = useMemo(() => {
    if (draftOver || draft.myPicks.length === 0) return null;
    return recommend({
      board: board.players,
      draftedIds: draft.draftedIds,
      myRoster: draft.myRoster,
      currentPick: planningPick,
      myPicks: draft.myPicks,
      config,
      strategy,
      drift: draft.drift,
      opponentCounts: draft.opponentCounts,
    });
  }, [board, draft.draftedIds, draft.myRoster, planningPick, draft.myPicks, config, strategy, draftOver, draft.drift, draft.opponentCounts]);

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

  function mark(player: BoardPlayer, mine = false) {
    draft.markDrafted(player);
    if (mine) {
      setSnipe(null);
      setBurst({ key: Date.now(), color: POS_COLOR[player.pos] });
    }
    showToast(mine ? `Drafted ${player.name}.` : `${player.name} is off the board.`);
  }

  function showToast(text: string) {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  // Keyboard: / focuses search, Enter drafts the pick, ⌘Z undoes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
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
      const cands = board.players
        .filter((p) => p.pos === pos && !draft.draftedIds.has(p.id))
        .sort((a, b) => b.projPoints - a.projPoints)
        .slice(0, 8)
        .map((p) => ({ p, s: survivalProb(p, n2, draft.drift) }));
      const best = cands[0];
      const likely = cands.find((x) => x.s >= 0.55) ?? cands[cands.length - 1];
      return { pos, best, likely };
    });
    return { n2, rows };
  }, [board, draft.draftedIds, draft.myPicks, draft.drift, draftOver]);

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

  return (
    <main className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-4 pb-4 pt-3 lg:h-dvh">
      {/* Status bar */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-2">
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
          <label className="sr-only" htmlFor="strategy">Strategy</label>
          <select
            id="strategy"
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            className="rounded border border-line bg-panel px-2 py-1.5 text-sm"
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
            <option value="custom">Custom</option>
          </select>
          {strategyId === "custom" && (
            <button
              onClick={() => setShowDials((v) => !v)}
              className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink-dim hover:text-ink"
              aria-expanded={showDials}
            >
              Dials
            </button>
          )}
          <button
            onClick={() => { draft.undo(); showToast("Undone."); }}
            disabled={!draft.canUndo}
            className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink-dim hover:text-ink disabled:opacity-30"
            title="Undo last manual mark (⌘Z)"
          >
            Undo
          </button>
          <button
            onClick={onReconfigure}
            title="Change league or tournament format"
            className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink-dim hover:text-ink"
          >
            {config.teams}tm · {config.scoring} · {bestball ? "best ball" : "redraft"} ⚙
          </button>
          {config.platform === "sleeper" && (
            <span
              className="flex items-center gap-1.5 font-mono text-xs uppercase"
              style={{ color: draft.live ? "var(--color-live)" : "var(--color-warn)" }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
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
              className={`rounded-lg border-l-4 bg-panel p-5 ${myTurn ? "on-the-clock" : ""}`}
              style={{ borderLeftColor: posColor, ["--pulse-color" as string]: posColor }}
            >
              {snipe && (
                <div className="mb-3 flex items-start justify-between gap-2 rounded bg-warn/15 px-3 py-2 text-sm text-warn">
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
              <p
                className={`font-mono text-xs uppercase tracking-widest ${myTurn ? "font-semibold" : "text-ink-dim"}`}
                style={myTurn ? { color: posColor } : undefined}
              >
                {myTurn
                  ? `You're on the clock — pick ${planningPick}`
                  : `Plan for your pick ${planningPick} · ${picksUntilMe === 1 ? "you're next" : `${picksUntilMe} picks away`}`}
              </p>
              <h2
                className="mt-1 font-display text-6xl font-bold uppercase leading-[0.95] tracking-tight sm:text-7xl"
                style={{ color: posColor }}
              >
                {top.player.name}
              </h2>
              <p className="mt-2 flex items-center gap-1.5 font-mono text-sm text-ink-dim">
                <span style={{ color: posColor }}>{top.player.pos}</span> · {top.player.team} · bye{" "}
                {top.player.bye ?? "—"} · {Math.round(top.player.projPoints)} proj
                <InjuryBadge injury={top.player.injury} />
              </p>
              <p className="mt-3 text-[15px] leading-snug text-ink">{top.reason}</p>
              <div className="relative">
                <button
                  onClick={() => mark(top.player, myTurn)}
                  className="mt-4 w-full rounded-lg py-4 font-display text-3xl font-bold uppercase tracking-wide text-field transition-transform active:scale-[0.98]"
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
            <ol className="space-y-2">
              {alternates.map((r, i) => (
                <li key={r.player.id}>
                  <button
                    onClick={() => mark(r.player, myTurn)}
                    className="flex w-full items-baseline gap-3 rounded-lg border-l-4 bg-panel px-4 py-2.5 text-left hover:bg-panel-2"
                    style={{ borderLeftColor: POS_COLOR[r.player.pos] }}
                  >
                    <span className="font-mono text-xs text-ink-faint">{i + 2}</span>
                    <span className="min-w-0">
                      <span className="font-display text-xl font-bold uppercase">
                        {r.player.name}
                      </span>
                      <span className="ml-2 font-mono text-xs text-ink-dim">
                        {r.player.pos} · {r.player.team} <InjuryBadge injury={r.player.injury} />
                      </span>
                      <span className="block text-sm text-ink-dim">{r.reason}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          {/* Manual entry — always available, even in Sleeper mode */}
          <SearchBox
            ref={searchRef}
            players={board.players}
            draftedIds={draft.draftedIds}
            onMark={(p) => mark(p)}
          />

          {/* Look-ahead: what's probably still there at my pick after this one */}
          {planner && (
            <div className="rounded-lg bg-panel p-3">
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
                      <span className="truncate">
                        {best.p.name}{" "}
                        <span className="font-mono text-[11px] text-ink-faint">
                          {Math.round(best.s * 100)}%
                        </span>
                      </span>
                      {likely && likely.p.id !== best.p.id && (
                        <span className="ml-auto truncate text-right text-ink-dim">
                          likely: {likely.p.name}
                        </span>
                      )}
                    </li>
                  ) : null
                )}
              </ul>
            </div>
          )}

          {/* My roster */}
          <div className="rounded-lg bg-panel p-3">
            <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
              My roster{bestball ? " · best ball construction" : ""}
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
                  {draft.myRoster.map((player, i) => (
                    <li key={i} className="truncate text-sm" style={{ color: POS_COLOR[player.pos] }}>
                      {player.name}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <ul className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
                {rosterView.map(({ slot, player }, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-sm">
                    <span className="w-9 shrink-0 font-mono text-[11px] text-ink-faint">{slot}</span>
                    {player ? (
                      <span className="truncate" style={{ color: POS_COLOR[player.pos] }}>
                        {player.name}
                      </span>
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
        <section className="min-h-0 min-w-0 flex-1" aria-label="Tier board">
          <TierBoard
            players={board.players}
            draftedIds={draft.draftedIds}
            myIds={myIds}
            onMark={(p) => mark(p)}
            highlightId={myTurn && top ? top.player.id : null}
            blurbFor={(p) =>
              playerBlurb(p, {
                currentPick: draft.currentPick,
                nextPick: draft.myPicks.find((n) => n > draft.currentPick) ?? draft.currentPick + config.teams,
                drift: draft.drift,
                tierMatesLeft: board.players.filter(
                  (a) =>
                    a.pos === p.pos && a.tier === p.tier && a.id !== p.id && !draft.draftedIds.has(a.id)
                ).length,
              })
            }
            positions={(["RB", "WR", "QB", "TE", "K", "DST"] as Position[]).filter(
              (pos) => (config.rosterSlots[pos] ?? 0) > 0 || !["K", "DST"].includes(pos)
            )}
          />
        </section>
      </div>

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-panel-2 px-4 py-2 text-sm shadow-xl"
        >
          {toast}
        </div>
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
