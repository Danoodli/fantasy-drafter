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
  let anyLabel = false;
  for (const l of ordered) {
    const h = headerSlot(normalizeOcr(l.text));
    if (h) headers.push({ y: l.y, slot: h });
    else {
      const { slot, rest } = leadingSlot(l.text);
      if (slot && normalizeOcr(rest).length > 0) anyLabel = true;
    }
  }
  const hasSlots = headers.length > 0 || anyLabel;
  const sectionAt = (y: number): RosterSlot => {
    let slot: RosterSlot = hasSlots ? "starter" : "bench";
    for (const h of headers) if (h.y <= y) slot = h.slot;
    return slot;
  };
  // Strip slot labels BEFORE matching: "BN D. London" would otherwise
  // tokenize as ["bnd", "london"] (see leadingSlot). The stripped line keeps
  // its y so sections still apply.
  const stripped: OcrLine[] = ordered.map((l) => ({ ...l, text: leadingSlot(l.text).rest }));
  const labelAt = new Map<number, RosterSlot | null>(ordered.map((l) => [l.y, leadingSlot(l.text).slot] as const));

  const { matches } = matchOcrLines(stripped, players);
  const entries: OcrRosterEntry[] = matches.map((m) => ({
    player: m.player, slot: labelAt.get(m.y) ?? sectionAt(m.y), line: m.line, score: m.score, y: m.y,
  }));
  entries.sort((a, b) => a.y - b.y);
  return { entries, hasSlots };
}
