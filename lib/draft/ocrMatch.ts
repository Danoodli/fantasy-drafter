// Screen sync's brain: which board players a noisy OCR read of the draft
// room's "drafted" panel names. Pure — lines in, matches out — so it is
// unit-tested without a camera or a worker. The matching itself is shared
// with paste import (nameMatch.ts); this file adds what is OCR-specific:
// glyph repair and the two-frame agreement. Pick ORDER, not pick numbers, is
// what screen sync trusts — see sequence.ts.
//
// A missed read costs nothing (the next frame retries); marking the wrong
// player costs a correction on the clock — so ties are skipped, never guessed.

import type { BoardPlayer } from "../types";
import { findDefense } from "./pasteImport";
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
  /** Vertical position in the frame — the panel's order. */
  y: number;
}

/** Tokenize an OCR line with glyph repair (exported for tests). */
export function normalizeOcr(text: string): string[] {
  return tokenize(text, { ocr: true });
}

export interface OcrMatchOptions {
  /** Minimum score to report a match. */
  minScore?: number;
}

/**
 * Match every OCR line to the players it names, in panel order (top to
 * bottom). Drafted players are returned too — they are the anchors the
 * sequence reconciler aligns on, and a drafted player must keep owning his
 * own line or "Bijan Robinson" would re-read as the next Robinson once Bijan
 * is gone. No pick numbers are read here on purpose: OCR junk in front of a
 * name ("8", "h4", "4 A") is not a pick number, and the panel's ORDER already
 * says who went when (see sequence.ts).
 */
export function matchOcrLines(
  lines: OcrLine[],
  players: BoardPlayer[],
  _draftedIds: Set<string> = new Set(),
  opts: OcrMatchOptions = {}
): { matches: OcrMatch[] } {
  void _draftedIds;
  const vocab = buildVocab(players);
  const counts = surnameCounts(players);
  const minScore = opts.minScore ?? 0.7;
  const best = new Map<string, OcrMatch>();

  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const raw = line.text.trim();
    if (!raw) continue;
    const tokens = normalizeOcr(raw);
    if (tokens.length === 0) continue;
    const hints = lineHints(tokens, raw);
    const found = findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { minScore, onTie: "skip" });
    const players_: { player: BoardPlayer; score: number }[] = found.map((f) => ({ player: f.player, score: f.score }));
    if (players_.length === 0) {
      const dst = findDefense(raw, hints.team, players);
      if (dst) players_.push({ player: dst, score: 0.9 });
    }
    for (const { player, score } of players_) {
      const existing = best.get(player.id);
      const m: OcrMatch = { player, line: raw, score, y: line.y };
      if (!existing || existing.score < m.score) best.set(player.id, m);
    }
  }

  const matches = [...best.values()].sort((a, b) => a.y - b.y);
  return { matches };
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

  /** Confirmed at some point (two consecutive reads), whether or not it has been placed. */
  isConfirmed(playerId: string): boolean {
    return this.confirmed.has(playerId);
  }
}
