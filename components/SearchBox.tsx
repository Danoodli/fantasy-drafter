"use client";

// Fast type-ahead for marking picks: "ceedee" → Enter → he's off the board.
// Sub-second, keyboard-first, undo always available.

import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import type { BoardPlayer } from "../lib/types";
import { searchPlayers } from "../lib/draft/fuzzy";
import { POS_COLOR } from "../lib/client/pos";

export interface SearchBoxHandle {
  focus: () => void;
}

interface Props {
  players: BoardPlayer[];
  draftedIds: Set<string>;
  onMark: (player: BoardPlayer) => void;
}

const SearchBox = forwardRef<SearchBoxHandle, Props>(function SearchBox(
  { players, draftedIds, onMark },
  ref
) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }));

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchPlayers(query, players, 6).filter((p) => !draftedIds.has(p.id));
  }, [query, players, draftedIds]);

  useEffect(() => setHighlight(0), [query]);

  function commit(player: BoardPlayer | undefined) {
    if (!player) return;
    onMark(player);
    setQuery("");
    inputRef.current?.focus();
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(results[highlight]);
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Escape") {
            setQuery("");
            inputRef.current?.blur();
          }
        }}
        placeholder="Mark a pick — type a name, Enter marks it  ( / )"
        aria-label="Mark a player drafted"
        className="w-full rounded border border-line bg-panel px-3 py-2.5 text-[15px] placeholder:text-ink-faint"
      />
      {results.length > 0 && (
        <ul className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded border border-line bg-panel-2 shadow-xl">
          {results.map((p, i) => (
            <li key={p.id}>
              <button
                onClick={() => commit(p)}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm ${
                  i === highlight ? "bg-panel" : ""
                }`}
              >
                <span
                  className="font-mono text-[11px] font-medium"
                  style={{ color: POS_COLOR[p.pos] }}
                >
                  {p.pos}
                </span>
                <span className="flex-1">{p.name}</span>
                <span className="font-mono text-[11px] text-ink-faint">
                  {p.team} · ADP {p.adp.toFixed(0)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

export default SearchBox;
