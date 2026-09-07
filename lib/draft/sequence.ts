// Order is the signal. A draft room's pick history is a chronological list;
// whatever the OCR reads off it (a window of the most recent names, some
// lines garbled) is a subsequence of the true pick order. So screen sync
// never trusts pick NUMBERS from the screen — OCR junk like "8" or "h4" in
// front of a name is not a pick number — it reconciles SEQUENCES:
//
//   known  = our picks so far, by pick index (null = unknown placeholder)
//   frame  = the names read this time, in pick order
//
// Names in both are anchors. New names between two anchors fill unknown
// placeholders in that gap or are inserted there (a pick we missed — the
// picks after it shift down, which is what really happened). New names after
// the last anchor are appended in order. A name that would land on MY pick
// is never placed: the slot gets a placeholder so everyone after me still
// lands right, and the name is handed back for me to confirm or ignore.
// Pure and deterministic — unit-tested without a camera.

export interface ReconcileOptions {
  /** Pick index → is this one of my picks? */
  isMine: (pickIndex: number) => boolean;
  /** Leading picks that came from an API and must not move (Sleeper). */
  frozen?: number;
  /** Player ids the user told us to never place from the screen. */
  ignored?: Set<string>;
}

export interface Placement {
  id: string;
  pickIndex: number;
}

export interface ReconcileResult {
  next: (string | null)[];
  /** New picks appended or inserted. */
  inserted: Placement[];
  /** Unknown placeholders filled in. */
  filled: Placement[];
  /** Names that landed on my pick — left as placeholders for me. */
  held: Placement[];
  /** Picks that moved down because a missed pick was inserted before them. */
  shifted: number;
}

/** Longest common subsequence as index pairs [frameIdx, knownIdx], increasing in both. */
function lcs(frame: string[], known: (string | null)[]): [number, number][] {
  const n = frame.length;
  const m = known.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = frame[i] === known[j] && known[j] != null ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (frame[i] === known[j] && known[j] != null) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export function reconcileSequence(
  known: (string | null)[],
  frameIn: string[],
  opts: ReconcileOptions
): ReconcileResult {
  const frozen = opts.frozen ?? 0;
  const ignored = opts.ignored ?? new Set<string>();
  const inKnown = new Set(known.filter((x): x is string => x != null));
  // Dedupe (a panel can show a name twice), drop ignored names.
  const frame: string[] = [];
  const seen = new Set<string>();
  for (const id of frameIn) {
    if (!id || seen.has(id) || ignored.has(id)) continue;
    seen.add(id);
    frame.push(id);
  }

  const next = [...known];
  const inserted: Placement[] = [];
  const filled: Placement[] = [];
  const held: Placement[] = [];
  let shifted = 0;

  const anchors = lcs(frame, known);
  // Segment the frame by anchors: each run of unanchored frame names sits
  // between two known indices (or before the first / after the last).
  const anchorKnownIdx = new Map<number, number>(anchors); // frameIdx → knownIdx
  let cursor = 0; // where in `next` the current segment starts (exclusive of the previous anchor)
  let offset = 0; // how many insertions so far (known indices shift by this)
  let fi = 0;
  while (fi <= frame.length) {
    // Collect the run of new names until the next anchor (or the end).
    const run: string[] = [];
    while (fi < frame.length && !anchorKnownIdx.has(fi)) {
      const id = frame[fi];
      if (!inKnown.has(id)) run.push(id); // a known name out of place is never re-placed
      fi++;
    }
    // The next anchor's position in `next` (-1 = none: the run trails the list).
    // Every insertion before it pushes it down by one.
    let anchorPos = fi < frame.length ? anchorKnownIdx.get(fi)! + offset : -1;
    const bound = () => (anchorPos < 0 ? next.length : anchorPos);
    // Place the run in [cursor, anchor): fill placeholders first, then insert.
    let pos = Math.max(cursor, frozen);
    for (const id of run) {
      // Fill the first placeholder in the gap, if any.
      let placed = false;
      while (pos < bound()) {
        if (next[pos] == null) {
          if (opts.isMine(pos)) held.push({ id, pickIndex: pos });
          else {
            next[pos] = id;
            filled.push({ id, pickIndex: pos });
          }
          pos++;
          placed = true;
          break;
        }
        pos++;
      }
      if (placed) continue;
      // No placeholder left in the gap: insert right before the anchor (or append).
      const at = Math.max(bound(), frozen);
      if (at < next.length) shifted += next.length - at;
      if (opts.isMine(at)) {
        next.splice(at, 0, null);
        held.push({ id, pickIndex: at });
      } else {
        next.splice(at, 0, id);
        inserted.push({ id, pickIndex: at });
      }
      offset++;
      if (anchorPos >= 0) anchorPos++;
      pos = at + 1;
    }
    if (fi >= frame.length) break;
    // Step past the anchor.
    cursor = anchorPos + 1;
    fi++;
  }
  return { next, inserted, filled, held, shifted };
}

export interface NumberedPick {
  id: string;
  pickNo: number;
}

export interface NumberedResult {
  next: (string | null)[];
  /** Appended at the end (after any padding). */
  added: number;
  /** Placeholders filled. */
  filled: number;
  /** Placeholders created to reach a pick number. */
  padded: number;
  /** Inserted in front of a pick we had at that number — the rest shift down. */
  inserted: number;
  shifted: number;
  /** Already on the board (anywhere). */
  skipped: number;
}

/**
 * Place picks that carry their pick NUMBER (a paste with "1.05" / "R1, P2").
 * The number is trusted: a placeholder there is filled, a gap is padded, and
 * a DIFFERENT player sitting at that number means we missed this pick — it is
 * inserted in front and the later picks shift down (which is what really
 * happened in the room). A player already on the board is never moved.
 */
export function placeNumberedPicks(known: (string | null)[], picks: NumberedPick[], frozen = 0): NumberedResult {
  const next = [...known];
  const have = new Set(next.filter((x): x is string => x != null));
  let added = 0, filled = 0, padded = 0, inserted = 0, shifted = 0, skipped = 0;
  for (const { id, pickNo } of [...picks].sort((a, b) => a.pickNo - b.pickNo)) {
    if (!id || pickNo < 1 || have.has(id)) {
      skipped++;
      continue;
    }
    const idx = pickNo - 1;
    if (idx < frozen) {
      skipped++; // an API pick is the truth for that number
      continue;
    }
    if (idx >= next.length) {
      while (next.length < idx) {
        next.push(null);
        padded++;
      }
      next.push(id);
      added++;
    } else if (next[idx] == null) {
      next[idx] = id;
      filled++;
    } else {
      shifted += next.length - idx;
      next.splice(idx, 0, id);
      inserted++;
    }
    have.add(id);
  }
  return { next, added, filled, padded, inserted, shifted, skipped };
}
