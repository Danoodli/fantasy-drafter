// Screen sync for a draft BOARD (DraftKings, Yahoo, most grid rooms): one cell
// per pick, one column per team, rounds snaking left-to-right then right-to-
// left. There is no chronological list to read top to bottom, so order is
// useless here — but every cell carries its own "round.pick" label, which the
// numbered-pick path (sequence.ts placeNumberedPicks) already trusts. So:
//
//   1. the labels ("6.12", "7.1") are the anchors — one per cell, top-left;
//   2. every other word belongs to the nearest anchor above-left of it, bounded
//      by the cell size inferred from the anchor spacing;
//   3. a cell's words ("72 Q. Johnston WR LAC (BYE 7)") go through the shared
//      name matcher with the cell's position/team as hints, which is what makes
//      an initial + a common surname readable ("J. Williams · WR DET").
//
// Pure — words with boxes in, numbered picks out — so it is unit-tested with a
// synthetic board and no camera. Words above the first anchored row (a cut-off
// round) are dropped: without a label we do not know their pick number, and a
// guess costs a correction on the clock.

import type { BoardPlayer } from "../types";
import { findDefense } from "./pasteImport";
import { buildVocab, findPlayers, lineHints, surnameCounts, tokenize } from "./nameMatch";

export interface OcrWord {
  text: string;
  /** 0–100 from the OCR engine. */
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface GridPick {
  /** Overall pick number: (round − 1) × teams + pick. */
  pickNo: number;
  round: number;
  pick: number;
  player: BoardPlayer;
  /** 0–1: how sure the read is. */
  score: number;
  /** The cell's words, joined. */
  text: string;
}

export interface GridReadOptions {
  teams: number;
  /** Minimum name-match score to report a cell. */
  minScore?: number;
}

export interface GridRead {
  /** Cell labels found. 0 means this is not a grid (fall back to list reading). */
  anchors: number;
  picks: GridPick[];
}

const LABEL_RE = /^(\d{1,2})[.,:](\d{1,2})$/;

/** "6.12" → { round: 6, pick: 12 } when the pick fits the league; anything else → null. */
export function parseCellLabel(text: string, teams: number): { round: number; pick: number } | null {
  const m = text.trim().match(LABEL_RE);
  if (!m) return null;
  const round = Number(m[1]);
  const pick = Number(m[2]);
  if (round < 1 || round > 40 || pick < 1 || pick > teams) return null;
  return { round, pick };
}

interface Anchor {
  word: OcrWord;
  round: number;
  pick: number;
  words: OcrWord[];
}

interface Row {
  y: number;
  anchors: Anchor[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}

/**
 * Cells are equal-sized, so the true cell pitch is the smallest gap between
 * neighbouring anchors that every other gap is a whole multiple of. A missed
 * label makes a gap of two or three cells, never a fraction of one.
 */
function pitch(gaps: number[]): number {
  if (gaps.length === 0) return Infinity;
  const min = Math.min(...gaps);
  for (let div = 1; div <= 4; div++) {
    const g = min / div;
    if (gaps.every((x) => Math.abs(x / g - Math.round(x / g)) < 0.15)) return g;
  }
  return min;
}

/** Group the anchors into screen rows (same y, within a label's height) and sort each row by x. */
function rowsOf(anchors: Anchor[]): Row[] {
  const tol = Math.max(4, median(anchors.map((a) => a.word.y1 - a.word.y0)) * 1.5);
  const rows: Row[] = [];
  for (const a of [...anchors].sort((p, q) => p.word.y0 - q.word.y0)) {
    const row = rows[rows.length - 1];
    if (row && a.word.y0 - row.y <= tol) row.anchors.push(a);
    else rows.push({ y: a.word.y0, anchors: [a] });
  }
  for (const r of rows) r.anchors.sort((p, q) => p.word.x0 - q.word.x0);
  return rows;
}

/** Join a cell's words in reading order: line by line, left to right. */
function cellText(words: OcrWord[]): string {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lineTol = Math.max(3, median(sorted.map((w) => w.y1 - w.y0)) * 0.6);
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(w.y0 - line[0].y0) <= lineTol) line.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(" ")).join(" ");
}

export function readGrid(words: OcrWord[], players: BoardPlayer[], opts: GridReadOptions): GridRead {
  const teams = Math.max(2, opts.teams);
  const minScore = opts.minScore ?? 0.7;
  const anchors: Anchor[] = [];
  const rest: OcrWord[] = [];
  for (const w of words) {
    const label = parseCellLabel(w.text, teams);
    if (label) anchors.push({ word: w, ...label, words: [] });
    else rest.push(w);
  }
  if (anchors.length === 0) return { anchors: 0, picks: [] };

  const rows = rowsOf(anchors);
  const xGaps: number[] = [];
  for (const r of rows) for (let i = 1; i < r.anchors.length; i++) xGaps.push(r.anchors[i].word.x0 - r.anchors[i - 1].word.x0);
  const yGaps: number[] = [];
  for (let i = 1; i < rows.length; i++) yGaps.push(rows[i].y - rows[i - 1].y);
  const cellW = pitch(xGaps);
  const cellH = pitch(yGaps);

  // Each word joins the cell whose label is the nearest top-left corner: the
  // last row starting at or above the word, then the last label in that row
  // starting at or left of it — as long as the word starts inside that cell.
  for (const w of rest) {
    let row: Row | null = null;
    for (const r of rows) {
      if (r.y <= w.y0 + 2) row = r;
      else break;
    }
    if (!row) continue;
    let anchor: Anchor | null = null;
    for (const a of row.anchors) {
      if (a.word.x0 <= w.x0 + 2) anchor = a;
      else break;
    }
    if (!anchor) continue;
    if (w.x0 - anchor.word.x0 >= cellW * 0.95) continue;
    if (w.y0 - anchor.word.y0 >= cellH * 0.95) continue;
    anchor.words.push(w);
  }

  const vocab = buildVocab(players);
  const counts = surnameCounts(players);
  const best = new Map<string, GridPick>();
  for (const a of anchors) {
    if (a.words.length === 0) continue;
    const raw = cellText(a.words);
    const tokens = tokenize(raw, { ocr: true });
    if (tokens.length === 0) continue;
    const hints = lineHints(tokens, raw);
    const found = findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { minScore, onTie: "skip" })
      .map((f) => ({ player: f.player, score: f.score }))
      .sort((p, q) => q.score - p.score);
    if (found.length === 0) {
      const dst = findDefense(raw, hints.team, players);
      if (dst) found.push({ player: dst, score: 0.9 });
    }
    if (found.length === 0) continue;
    // One cell names one player; two that read about as well means the cell
    // caught a neighbour's words — skip rather than guess.
    if (found.length > 1 && found[0].score - found[1].score <= 0.05) continue;
    const { player, score } = found[0];
    const pick: GridPick = { pickNo: (a.round - 1) * teams + a.pick, round: a.round, pick: a.pick, player, score, text: raw };
    const existing = best.get(player.id);
    if (!existing || existing.score < score) best.set(player.id, pick);
  }
  const picks = [...best.values()].sort((p, q) => p.pickNo - q.pickNo);
  return { anchors: anchors.length, picks };
}
