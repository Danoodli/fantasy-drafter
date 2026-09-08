"use client";

// Preview for a pasted picks panel: what was recognized, what wasn't, and
// which order the picks will be marked in. One click marks them all; the
// toast that follows undoes them all. Opens from a global paste anywhere in
// the cockpit, or from the "Paste picks" button with a textarea.

import { useEffect, useMemo, useState } from "react";
import type { BoardPlayer } from "../lib/types";
import { parsePastedPicks, type PasteMatch } from "../lib/draft/pasteImport";
import type { ImportItem } from "../lib/client/useDraft";
import { POS_COLOR } from "../lib/client/pos";

interface Props {
  /** Pre-filled text from a global paste; empty opens the textarea. */
  initialText: string;
  players: BoardPlayer[];
  draftedIds: Set<string>;
  teams: number;
  currentPick: number;
  onCommit: (items: ImportItem[]) => void;
  onClose: () => void;
}

interface Row {
  match: PasteMatch;
  /** The player that will be marked (user may have swapped to a suggestion). */
  chosen: BoardPlayer | null;
  enabled: boolean;
}

export default function PasteImport({ initialText, players, draftedIds, teams, currentPick, onCommit, onClose }: Props) {
  const [text, setText] = useState(initialText);
  const [reverse, setReverse] = useState(false);
  const [snakeGrid, setSnakeGrid] = useState(false);
  const [firstRound, setFirstRound] = useState(1);
  const [overrides, setOverrides] = useState<Record<number, BoardPlayer | null>>({});
  const [disabled, setDisabled] = useState<Set<number>>(new Set());

  const result = useMemo(
    () => parsePastedPicks(text, players, draftedIds, { teams, snakeGrid: snakeGrid ? { firstRound } : undefined }),
    [text, players, draftedIds, teams, snakeGrid, firstRound]
  );

  /** New text means new rows: per-row edits no longer apply. */
  function updateText(next: string) {
    setText(next);
    setOverrides({});
    setDisabled(new Set());
  }

  const rows: Row[] = useMemo(() => {
    const base = result.matches.map((match, i) => ({
      match,
      chosen: i in overrides ? overrides[i] : match.player,
      enabled: !disabled.has(i),
    }));
    return result.hasPickNumbers || !reverse ? base : [...base].reverse();
  }, [result, overrides, disabled, reverse]);

  const ready = rows.filter((r) => r.enabled && r.chosen && !r.match.alreadyDrafted);
  const unmatched = rows.filter((r) => !r.chosen);
  const already = rows.filter((r) => r.chosen && r.match.alreadyDrafted).length;
  const lowConf = rows.filter((r) => r.chosen && r.match.confidence === "low" && !r.match.alreadyDrafted).length;
  // Picks with numbers below the current pick fill unknown placeholders (or are skipped).
  const behind = ready.filter((r) => r.match.line.pickNo != null && r.match.line.pickNo < currentPick).length;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function commit() {
    // Names already on the board go along too — not to be marked again, but as
    // the anchors that let a missed pick slot in between them by order.
    onCommit(
      rows
        .filter((r) => r.chosen && (r.match.alreadyDrafted || r.enabled))
        .map((r) => ({ player: r.chosen!, pickNo: r.match.line.pickNo }))
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-field/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-title"
        className="rise-in flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-lg border border-line bg-panel-2 shadow-2xl"
      >
        <div className="flex items-baseline justify-between border-b border-line px-5 py-3">
          <h2 id="paste-title" className="font-display text-2xl font-bold uppercase">Paste picks</h2>
          <button onClick={onClose} aria-label="Close" className="font-mono text-sm text-ink-faint hover:text-ink">✕</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <textarea
            value={text}
            onChange={(e) => updateText(e.target.value)}
            autoFocus={!initialText}
            rows={initialText ? 3 : 7}
            placeholder={"Copy the drafted-players list from your draft room and paste it here.\nAny format works: \"1.05 Bijan Robinson RB ATL\", \"Chase, Ja'Marr\", one name per line…"}
            className="w-full rounded border border-line bg-field px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-ink-faint"
          />

          {rows.length > 0 && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>
                  <span className="font-semibold text-rb">{ready.length}</span> to mark
                </span>
                {already > 0 && <span className="text-ink-dim">{already} already off the board</span>}
                {unmatched.length > 0 && <span className="text-warn">{unmatched.length} unrecognized</span>}
                {lowConf > 0 && <span className="text-ink-dim">{lowConf} best-guess</span>}
                {behind > 0 && <span className="text-ink-dim">{behind} backfill earlier picks</span>}
                {result.hasPickNumbers && !snakeGrid ? (
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">ordered by pick number</span>
                ) : (
                  <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
                    {!snakeGrid && (
                      <label className="flex items-center gap-1.5 text-xs text-ink-dim">
                        <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
                        list is newest-first (mark bottom to top)
                      </label>
                    )}
                    <label
                      className="flex items-center gap-1.5 text-xs text-ink-dim"
                      title="A draft board copied row by row with no pick labels (DraftKings): rows are rounds, even rounds run right to left."
                    >
                      <input type="checkbox" checked={snakeGrid} onChange={(e) => setSnakeGrid(e.target.checked)} />
                      board grid, snake rows
                    </label>
                    {snakeGrid && (
                      <label className="flex items-center gap-1 text-xs text-ink-dim">
                        first row is round
                        <input
                          type="number"
                          min={1}
                          max={40}
                          value={firstRound}
                          onChange={(e) => setFirstRound(Math.max(1, Number(e.target.value) || 1))}
                          className="w-12 rounded border border-line bg-field px-1 py-0.5 font-mono text-xs"
                        />
                      </label>
                    )}
                  </span>
                )}
              </div>

              <ol className="mt-2 divide-y divide-line rounded border border-line">
                {rows.map((row) => {
                  const idx = result.matches.indexOf(row.match);
                  const p = row.chosen;
                  const gone = row.match.alreadyDrafted;
                  return (
                    <li key={idx} className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-sm ${gone ? "opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={row.enabled && !!p && !gone}
                        disabled={!p || gone}
                        onChange={(e) =>
                          setDisabled((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.delete(idx);
                            else next.add(idx);
                            return next;
                          })
                        }
                        aria-label={p ? `Mark ${p.name}` : "Unrecognized line"}
                      />
                      <span className="w-9 shrink-0 font-mono text-[11px] text-ink-faint">
                        {row.match.line.pickNo != null ? `#${row.match.line.pickNo}` : ""}
                      </span>
                      {p ? (
                        <>
                          <span className="font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>
                          <span className={row.match.confidence === "low" ? "text-ink-dim" : ""}>{p.name}</span>
                          <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
                          {gone && <span className="font-mono text-[10px] text-ink-faint">already marked</span>}
                        </>
                      ) : (
                        <span className="text-warn">not recognized</span>
                      )}
                      <span className="ml-auto max-w-[45%] truncate font-mono text-[10px] text-ink-faint" title={row.match.line.raw}>
                        {row.match.line.raw}
                      </span>
                      {(row.match.confidence === "low" || !p) && row.match.suggestions.length > 0 && !gone && (
                        <span className="flex basis-full flex-wrap gap-1 pl-6">
                          <span className="font-mono text-[10px] text-ink-faint">did you mean</span>
                          {row.match.suggestions.map((s) => (
                            <button
                              key={s.id}
                              onClick={() => setOverrides((o) => ({ ...o, [idx]: s }))}
                              className={`rounded px-1.5 py-0.5 text-[11px] ${p?.id === s.id ? "bg-panel text-ink" : "bg-field text-ink-dim hover:text-ink"}`}
                            >
                              {s.name} <span style={{ color: POS_COLOR[s.pos] }}>{s.pos}</span>
                            </button>
                          ))}
                          {p && (
                            <button onClick={() => setOverrides((o) => ({ ...o, [idx]: null }))} className="px-1 text-[11px] text-ink-faint hover:text-warn">
                              none of these
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              {result.ignored.length > 0 && (
                <p className="mt-2 font-mono text-[10px] text-ink-faint">
                  ignored: {result.ignored.slice(0, 6).join(" · ")}{result.ignored.length > 6 ? " …" : ""}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <p className="text-xs text-ink-faint">
            {result.hasPickNumbers
              ? "Pick numbers found: each lands at its number — a pick we missed is inserted and later picks move down; gaps become unknown picks."
              : "No pick numbers: the list is aligned with the picks already on the board by order — a missed pick slots in where it belongs."}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded border border-line bg-panel px-3 py-2 text-sm font-semibold text-ink-dim hover:text-ink">
              Cancel
            </button>
            <button
              onClick={commit}
              disabled={ready.length === 0}
              className="rounded bg-rb px-4 py-2 text-sm font-semibold text-field disabled:opacity-40"
            >
              Mark {ready.length} pick{ready.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
