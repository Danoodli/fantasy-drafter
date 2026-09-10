// A roster page read off the screen -> board players with slots. Pure: OCR
// lines in, entries out, tested without a camera or a worker. The matching is
// lib/draft/ocrMatch.ts (glyph repair, ties skipped — marking the wrong player
// costs a correction, a missed one costs a re-read). Slot words are shared
// with the paste parser so the two paths never disagree.
import type { BoardPlayer } from "../types";
import { matchOcrLines, normalizeOcr, type OcrLine } from "../draft/ocrMatch";
import { headerSlot, leadingSlot, type RosterSlot } from "./rosterPaste";

export interface OcrRosterEntry {
  player: BoardPlayer;
  slot: RosterSlot;
  line: string;
  score: number;
  y: number;
}

export function readRosterLines(lines: OcrLine[], players: BoardPlayer[]): { entries: OcrRosterEntry[]; hasSlots: boolean } {
  const ordered = [...lines].sort((a, b) => a.y - b.y);
  // Section headers by vertical position: a name below a "Bench" header is a
  // bench player unless its own line says otherwise.
  const headers: { y: number; slot: RosterSlot }[] = [];
  // Tesseract often splits one roster ROW into several "lines" at the same y
  // (a Slot column, a Name column). A line that is ONLY a slot label lends its
  // slot to the name lines at that y. Keyed by y on purpose: label-only lines
  // carry no name, so they cannot collide with a name line here.
  const rowLabel = new Map<number, RosterSlot>();
  let anyLabel = false;
  for (const l of ordered) {
    const h = headerSlot(normalizeOcr(l.text));
    if (h) {
      headers.push({ y: l.y, slot: h });
      continue;
    }
    const { slot, rest } = leadingSlot(l.text);
    if (!slot) continue;
    anyLabel = true;
    if (normalizeOcr(rest).length === 0) rowLabel.set(l.y, slot);
  }
  const hasSlots = headers.length > 0 || anyLabel;
  const sectionAt = (y: number): RosterSlot => {
    let slot: RosterSlot = hasSlots ? "starter" : "bench";
    for (const h of headers) if (h.y <= y) slot = h.slot;
    return slot;
  };

  // Match line by line so each line's OWN label travels with its matches —
  // never keyed by y, where two lines of one row would collide. The label is
  // stripped BEFORE matching: "BN D. London" would otherwise tokenize as
  // ["bnd", "london"] (see leadingSlot). A player read on several lines keeps
  // his best-scoring read, as matchOcrLines does within a frame.
  const best = new Map<string, OcrRosterEntry>();
  for (const l of ordered) {
    if (headerSlot(normalizeOcr(l.text))) continue;
    const { slot: own, rest } = leadingSlot(l.text);
    const { matches } = matchOcrLines([{ ...l, text: rest }], players);
    for (const m of matches) {
      const entry: OcrRosterEntry = {
        player: m.player,
        slot: own ?? rowLabel.get(l.y) ?? sectionAt(l.y),
        line: m.line,
        score: m.score,
        y: l.y,
      };
      const prev = best.get(m.player.id);
      if (!prev || prev.score < entry.score) best.set(m.player.id, entry);
    }
  }
  const entries = [...best.values()].sort((a, b) => a.y - b.y);
  return { entries, hasSlots };
}
