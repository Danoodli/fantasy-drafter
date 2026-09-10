"use client";

// Paste tab of RosterImport: textarea, a preview of what was read (with
// did-you-mean chips for the uncertain rows), one Apply. Ends in applyRoster.

import { useMemo, useState } from "react";
import type { Board, BoardPlayer } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";
import { parseRosterPaste, type RosterSlot } from "../../lib/season/rosterPaste";
import { POS_COLOR } from "../../lib/client/pos";

const SLOT_LABEL: Record<RosterSlot, string> = { starter: "Start", bench: "Bench", ir: "IR" };

export default function RosterPaste({ board, team, onChange }: { board: Board; team: SavedTeam; onChange: (t: SavedTeam) => void }) {
  const [text, setText] = useState("");
  const [overrides, setOverrides] = useState<Record<number, BoardPlayer | null>>({});
  const result = useMemo(() => parseRosterPaste(text, board.players), [text, board.players]);

  const chosen = result.entries.map((e, i) => (i in overrides ? overrides[i] : e.player));
  const ready = chosen.filter((p): p is BoardPlayer => p !== null);

  function apply() {
    const slots: Record<string, RosterSlot> = {};
    result.entries.forEach((e, i) => {
      const p = chosen[i];
      if (p && result.hasSlots) slots[p.id] = e.slot;
    });
    onChange(applyRoster(team, ready.map((p) => p.id), "paste", result.hasSlots ? slots : undefined));
    setText("");
    setOverrides({});
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setOverrides({}); }}
        rows={6}
        placeholder={"Copy your roster page and paste it here.\nAny site works: \"QB  Josh Allen  Buf  vs MIA\", \"BN Puka Nacua\", or a Starters / Bench list."}
        className="w-full rounded bg-field px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-ink-faint"
      />
      {result.entries.length > 0 && (
        <>
          <ol className="divide-y divide-line rounded">
            {result.entries.map((e, i) => {
              const p = chosen[i];
              return (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
                  <span className="w-10 shrink-0 font-mono text-[10px] text-ink-faint">{result.hasSlots ? SLOT_LABEL[e.slot] : ""}</span>
                  {p ? (
                    <>
                      <span className="font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>
                      <span className={e.confidence === "low" ? "text-ink-dim" : ""}>{p.name}</span>
                      <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
                    </>
                  ) : (
                    <span className="text-warn">not recognized</span>
                  )}
                  <span className="ml-auto max-w-[45%] truncate font-mono text-[10px] text-ink-faint" title={e.raw}>{e.raw}</span>
                  {(e.confidence === "low" || !p) && e.suggestions.length > 0 && (
                    <span className="flex basis-full flex-wrap gap-1 pl-12">
                      <span className="font-mono text-[10px] text-ink-faint">did you mean</span>
                      {e.suggestions.map((s) => (
                        <button key={s.id} onClick={() => setOverrides((o) => ({ ...o, [i]: s }))} className={`btn text-[11px] ${p?.id === s.id ? "btn-accent" : "btn-quiet"}`}>
                          {s.name} <span style={{ color: POS_COLOR[s.pos] }}>{s.pos}</span>
                        </button>
                      ))}
                      {p && <button onClick={() => setOverrides((o) => ({ ...o, [i]: null }))} className="btn btn-quiet text-[11px] hover:text-warn">none of these</button>}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {result.ignored.length > 0 && <p className="font-mono text-[10px] text-ink-faint">ignored: {result.ignored.slice(0, 6).join(" · ")}{result.ignored.length > 6 ? " …" : ""}</p>}
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-faint">{result.hasSlots ? "Starters and bench read from the paste." : "No slot labels found — the engine will pick the lineup."}</p>
            <button onClick={apply} disabled={ready.length === 0} className="btn btn-accent">
              Replace roster with {ready.length} player{ready.length === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
