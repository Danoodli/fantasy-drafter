// Which pick is each pasted name, when the paste carries no pick numbers?
//
// A room's board has one cell per pick. A browser copies a selection as a
// contiguous run of that board in screen order (row by row, left to right),
// while a pick-history list copies in pick order (or newest first). The
// cockpit already knows a lot: how many picks the room has made at least
// (knownCount), who sits at which pick (placed), which cells are unknown
// placeholders, the league size and the draft order. A draft fills picks
// 1..T in order, so under each reading the sequence of filled cells is fixed
// once T is; the paste must be a contiguous window of it in which every name
// we already have sits at its own pick and every new name lands on a cell we
// have no player for. Readings that fit are ranked: the fewest picks we have
// never seen (smallest T), then the window that ends at the newest pick.
//
// Names already on the board are the anchors — one anchor in each of two
// rounds tells a board apart from a list on its own. Without anchors both may
// fit; then ADP decides: under the right reading ADP rises with the pick
// across the whole paste, under the wrong one every even round runs
// backwards. With too few names for that, the caller's preference decides (a
// paste full of "(BYE 7)" cell tags is a board) and the other reading stays
// available as an alternative. Pure.

import type { DraftOrder } from "../types";
import { slotOnClock } from "./snake";

export type PasteShape = "grid" | "list" | "newest";

export interface RoomState {
  teams: number;
  order: DraftOrder;
  /** Highest pick number recorded so far (unknown placeholders included). */
  knownCount: number;
  /** playerId → pickNo for every player already on the board. */
  placed: Map<string, number>;
  /** Pick numbers ≤ knownCount recorded without a player. */
  placeholders?: Set<number>;
}

export interface LayoutFit {
  shape: PasteShape;
  /** Pick number of each pasted row, in paste order. */
  picks: number[];
  /** How many picks the room has made under this reading. */
  total: number;
  /** Pasted rows already on the board that pinned the reading. */
  anchors: number;
}

export interface LayoutInference {
  best: LayoutFit;
  /** Other readings that fit but place at least one row differently. */
  alternatives: LayoutFit[];
}

const SHAPES: PasteShape[] = ["grid", "list", "newest"];
/** With nothing else to go on, a paste is a chronological list (ESPN, Sleeper, Yahoo copy that way). */
const DEFAULT_ORDER: PasteShape[] = ["list", "grid", "newest"];

/** The filled cells of a board with `total` picks, in the order a copy would list them under `shape`. */
export function cellsInOrder(shape: PasteShape, total: number, teams: number, order: DraftOrder): number[] {
  if (shape === "list") return Array.from({ length: total }, (_, i) => i + 1);
  if (shape === "newest") return Array.from({ length: total }, (_, i) => total - i);
  // Board: row by row, left to right. Column c of round r holds whichever pick
  // the draft order puts there; only picks ≤ total are filled.
  const rounds = Math.ceil(total / teams);
  const out: number[] = [];
  for (let r = 1; r <= rounds; r++) {
    const row = new Array<number>(teams);
    for (let i = 1; i <= teams; i++) {
      const pickNo = (r - 1) * teams + i;
      row[slotOnClock(pickNo, teams, order).slot - 1] = pickNo;
    }
    for (const p of row) if (p <= total) out.push(p);
  }
  return out;
}

function fitShape(rows: (string | null)[], room: RoomState, shape: PasteShape): LayoutFit | null {
  const m = rows.length;
  if (m === 0) return null;
  const placeholders = room.placeholders ?? new Set<number>();
  let anchors = 0;
  let maxAnchor = 0;
  let fresh = 0;
  for (const id of rows) {
    const at = id ? room.placed.get(id) : undefined;
    if (at != null) {
      anchors++;
      maxAnchor = Math.max(maxAnchor, at);
    } else fresh++;
  }
  const free = (p: number) => p > room.knownCount || placeholders.has(p);
  // The room has made at least what we know and at least what the paste shows;
  // allow up to a round of picks the paste never showed us.
  const tMin = Math.max(m, room.knownCount, maxAnchor);
  const tMax = room.knownCount + fresh + room.teams;
  for (let total = tMin; total <= tMax; total++) {
    const seq = cellsInOrder(shape, total, room.teams, room.order);
    // Latest window first: a paste is usually the newest picks.
    for (let offset = seq.length - m; offset >= 0; offset--) {
      let ok = true;
      for (let i = 0; i < m && ok; i++) {
        const p = seq[offset + i];
        const id = rows[i];
        const at = id ? room.placed.get(id) : undefined;
        ok = at != null ? at === p : free(p);
      }
      if (ok) return { shape, picks: seq.slice(offset, offset + m), total, anchors };
    }
  }
  return null;
}

/** Spearman rank correlation of two equal-length series (0 when there is nothing to compare). */
function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const ranks = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(n);
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/** How draft-like a reading is: rank correlation between the picks it assigns and the players' ADP. */
function adpFit(fit: LayoutFit, rows: (string | null)[], adpOf: (id: string) => number | null | undefined): { rho: number; n: number } {
  const picks: number[] = [];
  const adps: number[] = [];
  rows.forEach((id, i) => {
    const adp = id ? adpOf(id) : null;
    if (adp != null && Number.isFinite(adp)) {
      picks.push(fit.picks[i]);
      adps.push(adp);
    }
  });
  return { rho: spearman(picks, adps), n: picks.length };
}

/** Fewer names than this and ADP order is too noisy to tell a board from a list. */
const ADP_MIN_NAMES = 6;
/** One reading must beat the other by this much rank correlation to win on ADP alone. */
const ADP_MARGIN = 0.1;

/**
 * The reading to apply for a label-less paste, or null when nothing fits
 * (the names contradict what is on the board — leave them to order-based
 * alignment). Readings that both fit are told apart by `prefer` when the
 * caller has structural evidence (cell tags → grid), else by ADP when the
 * paste is long enough, else a chronological list.
 */
export function inferPasteLayout(
  rows: (string | null)[],
  room: RoomState,
  prefer: PasteShape | null = null,
  adpOf?: (id: string) => number | null | undefined
): LayoutInference | null {
  const fits = SHAPES.map((s) => fitShape(rows, room, s)).filter((f): f is LayoutFit => f != null);
  if (fits.length === 0) return null;
  const same = (a: LayoutFit, b: LayoutFit) => a.picks.length === b.picks.length && a.picks.every((p, i) => p === b.picks[i]);
  const rho = new Map<LayoutFit, number>();
  if (adpOf) {
    const scored = fits.map((f) => ({ f, ...adpFit(f, rows, adpOf) }));
    if (scored.every((s) => s.n >= ADP_MIN_NAMES)) {
      const top = Math.max(...scored.map((s) => s.rho));
      // Only a clear winner counts; near-ties fall through to the preference.
      if (scored.filter((s) => top - s.rho < ADP_MARGIN).every((s) => same(s.f, scored.find((t) => t.rho === top)!.f)))
        for (const s of scored) rho.set(s.f, s.rho);
    }
  }
  // Structural evidence first, then ADP-likeness when decisive, then the fewest unseen picks, then list, grid, newest-first.
  const rank = (f: LayoutFit) => [prefer ? (f.shape === prefer ? 0 : 1) : 0, -(rho.get(f) ?? 0), f.total, DEFAULT_ORDER.indexOf(f.shape)];
  fits.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  const best = fits[0];
  const alternatives = fits.slice(1).filter((f) => !same(f, best));
  return { best, alternatives };
}
