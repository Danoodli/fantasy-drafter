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

  // Pass 1: what each line says — a pick number, players, or a defense.
  interface Read {
    raw: string;
    y: number;
    pickNo: number | null;
    players: { player: BoardPlayer; score: number }[];
  }
  const reads: Read[] = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const raw = line.text.trim();
    if (!raw) continue;
    const pickNo = extractPickNo(raw, opts.teams);
    if (pickNo != null) maxPickNo = Math.max(maxPickNo ?? 0, pickNo);
    const tokens = normalizeOcr(raw);
    if (tokens.length === 0) continue;
    const hints = lineHints(tokens, raw);
    const found = findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { minScore, onTie: "skip" });
    const players_: Read["players"] = found.map((f) => ({ player: f.player, score: f.score }));
    if (players_.length === 0) {
      const dst = findDefense(raw, hints.team, players);
      if (dst) players_.push({ player: dst, score: 0.9 });
    }
    reads.push({ raw, y: line.y, pickNo, players: players_ });
  }

  // Pass 2: a label-only line ("R1, P4 - Team 12", "1.04") numbers the name
  // line next to it — below the name on ESPN, above it on Sleeper. Prefer the
  // unnumbered name line just above; else the one just below.
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i];
    if (r.pickNo == null || r.players.length > 0) continue;
    const above = reads[i - 1];
    const below = reads[i + 1];
    if (above && above.players.length === 1 && above.pickNo == null) above.pickNo = r.pickNo;
    else if (below && below.players.length === 1 && below.pickNo == null) below.pickNo = r.pickNo;
  }

  for (const r of reads) {
    for (const { player, score } of r.players) {
      if (draftedIds.has(player.id)) continue;
      const existing = best.get(player.id);
      const m: OcrMatch = { player, line: r.raw, score, pickNo: r.players.length === 1 ? r.pickNo : null, y: r.y };
      if (!existing || existing.score < m.score) best.set(player.id, m);
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
