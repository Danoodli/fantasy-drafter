"use client";

// Preview for a pasted picks panel: what was recognized, what wasn't, and
// which order the picks will be marked in. One click marks them all; the
// toast that follows undoes them all. Opens from a global paste anywhere in
// the cockpit, or from the "Paste picks" button with a textarea.

import { useEffect, useMemo, useState } from "react";
import type { BoardPlayer } from "../lib/types";
import { parsePastedPicks, type PasteMatch } from "../lib/draft/pasteImport";
import type { PasteShape, RoomState } from "../lib/draft/pasteLayout";
import type { ImportItem } from "../lib/client/useDraft";
import { POS_COLOR } from "../lib/client/pos";

interface Props {
  /** Pre-filled text from a global paste; empty opens the textarea. */
  initialText: string;
  players: BoardPlayer[];
  draftedIds: Set<string>;
  teams: number;
  currentPick: number;
  /** What the room already knows, so a paste without pick numbers lays itself onto the board. */
  room: Omit<RoomState, "teams">;
  onCommit: (items: ImportItem[]) => void;
  onClose: () => void;
}

interface Row {
  match: PasteMatch;
  /** The player that will be marked (user may have swapped to a suggestion). */
  chosen: BoardPlayer | null;
  enabled: boolean;
}

const SHAPE_LABEL: Record<PasteShape, string> = { grid: "a board grid, snake rows", list: "a pick list, oldest first", newest: "a pick list, newest first" };

export default function PasteImport({ initialText, players, draftedIds, teams, currentPick, room, onCommit, onClose }: Props) {
  const [text, setText] = useState(initialText);
  const [reverse, setReverse] = useState(false);
  /** The user picked another reading than the one inferred (rare; the alternatives chip). */
  const [prefer, setPrefer] = useState<PasteShape | null>(null);
  /** The pasted pick numbers looked misread and the user asked to lay the names out from the room instead. */
  const [ignoreNumbers, setIgnoreNumbers] = useState(false);
  const [copied, setCopied] = useState(false);
  const [overrides, setOverrides] = useState<Record<number, BoardPlayer | null>>({});
  const [disabled, setDisabled] = useState<Set<number>>(new Set());

  const result = useMemo(
    () => parsePastedPicks(text, players, draftedIds, { teams, room: { ...room, prefer: prefer ?? undefined }, ignoreNumbers }),
    [text, players, draftedIds, teams, room, prefer, ignoreNumbers]
  );

  // Impossible numbering: a draft fills picks in order, so the numbers on a
  // paste of N new names may leave at most a handful of picks unaccounted for
  // between what the room knows and the last pasted pick. Far more gaps than
  // names means the numbers were misread (a board copy whose labels came out
  // wrong) — say so and offer to lay the names out from the room instead.
  const numbered = result.matches.filter((m) => m.line.pickNo != null && m.player);
  const maxPick = numbered.reduce((n, m) => Math.max(n, m.line.pickNo!), 0);
  const covered = new Set<number>([...numbered.map((m) => m.line.pickNo!), ...room.placed.values()]);
  let gaps = 0;
  for (let p = room.knownCount + 1; p <= maxPick; p++) if (!covered.has(p) && !room.placeholders?.has(p)) gaps++;
  const implausible = !result.layout && result.hasPickNumbers && numbered.length > 0 && gaps > Math.max(2, numbered.length);

  async function copyDebug() {
    const report = {
      when: new Date().toISOString(),
      teams,
      room: { order: room.order, knownCount: room.knownCount, placed: [...room.placed.entries()], placeholders: [...(room.placeholders ?? [])] },
      hasPickNumbers: result.hasPickNumbers,
      layout: result.layout ? { best: result.layout.best, alternatives: result.layout.alternatives.map((a) => a.shape) } : null,
      matches: result.matches.map((m) => ({ raw: m.line.raw, pickNo: m.line.pickNo, player: m.player?.name ?? null, confidence: m.confidence, alreadyDrafted: m.alreadyDrafted })),
      ignored: result.ignored,
      text,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  /** New text means new rows: per-row edits no longer apply. */
  function updateText(next: string) {
    setText(next);
    setOverrides({});
    setDisabled(new Set());
    setPrefer(null);
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
          {text.trim() && (
            <div className="mt-1 flex justify-end">
              <button onClick={copyDebug} className="text-[11px] text-ink-faint hover:text-ink" title="Copies the pasted text and how it was read, to report a paste that came out wrong">
                {copied ? "copied" : "copy debug report"}
              </button>
            </div>
          )}
          {implausible && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-warn/15 px-3 py-2 text-xs text-warn">
              <span>
                These pick numbers can&apos;t be right: {numbered.length} names would leave {gaps} picks between them unaccounted for, and a draft fills picks in order.
              </span>
              <button onClick={() => setIgnoreNumbers(true)} className="rounded border border-warn/50 px-2 py-0.5 font-semibold hover:bg-warn/20">
                Ignore the numbers, lay them out from the board
              </button>
            </div>
          )}

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
                {result.layout ? (
                  <span className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-faint">
                    <span title={`Laid onto the board from what the room knows${result.layout.best.anchors ? ` — ${result.layout.best.anchors} pasted name${result.layout.best.anchors === 1 ? " is" : "s are"} already on it` : ""}`}>
                      read as {SHAPE_LABEL[result.layout.best.shape]}
                      {result.layout.best.anchors > 0 ? ` · anchored on ${result.layout.best.anchors} known pick${result.layout.best.anchors === 1 ? "" : "s"}` : ""}
                    </span>
                    {result.layout.alternatives.map((alt) => (
                      <button
                        key={alt.shape}
                        onClick={() => setPrefer(alt.shape)}
                        className="rounded border border-line bg-panel px-1.5 py-0.5 text-ink-dim hover:text-ink"
                        title="Also fits what the room knows — click if the picks below look wrong"
                      >
                        or {SHAPE_LABEL[alt.shape]}
                      </button>
                    ))}
                  </span>
                ) : result.hasPickNumbers ? (
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">ordered by pick number</span>
                ) : (
                  <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-dim">
                    <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
                    list is newest-first (mark bottom to top)
                  </label>
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
