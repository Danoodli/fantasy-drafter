// Screen sync's brain: which board players a noisy OCR read of the draft
// room's "drafted" panel names. Pure — lines in, matches out — so it is
// unit-tested without a camera or a worker. The matching itself is shared
// with paste import (nameMatch.ts); this file adds what is OCR-specific:
// glyph repair, the two-frame agreement, and a guard that ignores unnumbered
// reads when the panel clearly numbers its picks (those reads come from a
// different list caught in the box — usually the AVAILABLE players).
//
// A missed read costs nothing (the next frame retries); marking the wrong
// player costs a correction on the clock — so ties are skipped, never guessed.

import type { BoardPlayer } from "../types";
import { extractPickNo, findDefense } from "./pasteImport";
import { buildVocab, findPlayers, lineHints, surnameCounts, tokenize } from "./nameMatch";
export { editDistance } from "./nameMatch";

export interface OcrLine {
  text: string;
  /** 0–100 from the OCR engine; low-confidence lines still get a chance. */
  confidence: number;
  /** Vertical position in the frame — the panel's order. */
  y: number;
}

export interface OcrMatch {
  player: BoardPlayer;
  line: string;
  /** 0–1: how sure the read is. */
  score: number;
  pickNo: number | null;
  y: number;
}

/** Tokenize an OCR line with glyph repair (exported for tests). */
export function normalizeOcr(text: string): string[] {
  return tokenize(text, { ocr: true });
}

export interface OcrMatchOptions {
  teams: number;
  /** Minimum score to report a match. */
  minScore?: number;
}

/**
 * Match every OCR line to the undrafted players it names. Lines the panel
 * shows twice, headers, owner names and available-player noise fall out.
 */
export function matchOcrLines(
  lines: OcrLine[],
  players: BoardPlayer[],
  draftedIds: Set<string>,
  opts: OcrMatchOptions
): { matches: OcrMatch[]; maxPickNo: number | null } {
  // Match against EVERYONE, then drop drafted players: a drafted player must
  // still own his own line, or "Bijan Robinson" would re-read as the next
  // Robinson once Bijan is gone.
  const vocab = buildVocab(players);
  const counts = surnameCounts(players);
  const minScore = opts.minScore ?? 0.7;
  const best = new Map<string, OcrMatch>();
  let maxPickNo: number | null = null;

  for (const line of lines) {
    const raw = line.text.trim();
    if (!raw) continue;
    const pickNo = extractPickNo(raw, opts.teams);
    if (pickNo != null) maxPickNo = Math.max(maxPickNo ?? 0, pickNo);
    const tokens = normalizeOcr(raw);
    if (tokens.length === 0) continue;
    const hints = lineHints(tokens, raw);

    const found = findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { minScore, onTie: "skip" });
    if (found.length === 0) {
      const dst = findDefense(raw, hints.team, players);
      if (dst && !draftedIds.has(dst.id)) {
        const existing = best.get(dst.id);
        if (!existing || existing.score < 0.9) best.set(dst.id, { player: dst, line: raw, score: 0.9, pickNo, y: line.y });
      }
      continue;
    }
    for (const f of found) {
      if (draftedIds.has(f.player.id)) continue;
      const existing = best.get(f.player.id);
      const m: OcrMatch = { player: f.player, line: raw, score: f.score, pickNo: found.length === 1 ? pickNo : null, y: line.y };
      if (!existing || existing.score < m.score) best.set(f.player.id, m);
    }
  }

  let matches = [...best.values()];
  // Numbered panel guard: when most reads carry pick numbers, an unnumbered
  // name came from somewhere else in the box (the available list, a queue).
  const numbered = matches.filter((m) => m.pickNo != null).length;
  if (numbered >= 3 && numbered * 2 >= matches.length) matches = matches.filter((m) => m.pickNo != null);

  matches.sort((a, b) => (a.pickNo != null && b.pickNo != null ? a.pickNo - b.pickNo : a.y - b.y));
  return { matches, maxPickNo };
}

/**
 * Frame-to-frame agreement: a player is confirmed once two consecutive reads
 * agree, and reported exactly once. Pure state machine, no timers.
 */
export class FrameAgreement {
  private seenLast = new Set<string>();
  private confirmed = new Set<string>();

  constructor(alreadyDrafted: Iterable<string> = []) {
    for (const id of alreadyDrafted) this.confirmed.add(id);
  }

  /** Feed one frame's matches; get back the ones that just became confirmed. */
  observe(matches: OcrMatch[]): OcrMatch[] {
    const now = new Set(matches.map((m) => m.player.id));
    const fresh: OcrMatch[] = [];
    for (const m of matches) {
      if (this.confirmed.has(m.player.id)) continue;
      if (this.seenLast.has(m.player.id)) {
        this.confirmed.add(m.player.id);
        fresh.push(m);
      }
    }
    this.seenLast = now;
    return fresh;
  }

  /** The user undid a mark — let the read confirm again if it persists. */
  forget(playerId: string): void {
    this.confirmed.delete(playerId);
    this.seenLast.delete(playerId);
  }

  markConfirmed(playerId: string): void {
    this.confirmed.add(playerId);
  }
}
