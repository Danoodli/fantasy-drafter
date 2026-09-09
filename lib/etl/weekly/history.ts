// Compact storage for the historical weekly fit set. Five seasons of
// projection-vs-reality is ~60,000 player-weeks; naive JSON with long keys
// runs well past what belongs in a git repo, so this uses short keys, drops
// zeros, and rounds to two decimals (the projections are not precise past
// that anyway).
import type { Position, StatLine } from "../../types";

export interface HistRow {
  id: string;
  pos: Position;
  team: string;
  wk: number;
  opp: string;
  /**
   * Sleeper's injury designation **AS OF WHEN THIS ROW WAS FETCHED**, not as of
   * the historical week. Sleeper serves historical projections with a LIVE
   * status field: refetching the same past week 2h45m apart changed 12 of 325
   * statuses (both directions) while changing 0 stat lines, and players marked
   * "Out" in the fit set have a 0% did-not-play rate — impossible for a
   * contemporaneous designation.
   *
   * DO NOT calibrate availability from this. See the availability note in
   * scripts/calibrate-weekly.ts.
   */
  stNow: string | null;
  proj: StatLine;
  /** null = did not appear in the box score. Distinct from an all-zero line. */
  act: StatLine | null;
  /** Game total. */
  tot: number;
  /** This team's own spread; negative = favored. */
  spr: number;
}

/**
 * StatLine keys → two-char codes.
 *
 * pack/unpack look up BY CODE NAME, not by position, so REORDERING this array
 * is harmless. The invariant that actually matters is narrower and more
 * dangerous: **never reuse or reassign a code.** Pointing `ry` at a different
 * StatLine key would silently reinterpret five committed seasons as a
 * different stat, with no error and no test failure anywhere else — which is
 * why tests/weeklyHistory.test.ts decodes a hand-written payload to pin the
 * mapping. To add a stat, add a new unused code.
 */
const CODES: [keyof StatLine, string][] = [
  ["passYds", "py"], ["passTD", "pt"], ["passInt", "pi"], ["pass2pt", "p2"],
  ["rushYds", "ry"], ["rushTD", "rt"], ["rush2pt", "r2"],
  ["receptions", "rc"], ["recYds", "cy"], ["recTD", "ct"], ["rec2pt", "c2"],
  ["fumblesLost", "fl"], ["rushFd", "rf"], ["recFd", "cf"], ["passFd", "pf"],
];

const r2 = (v: number) => Math.round(v * 100) / 100;

function packStats(s: StatLine): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, code] of CODES) {
    const v = s[key];
    if (typeof v === "number" && v !== 0) out[code] = r2(v);
  }
  return out;
}

function unpackStats(o: Record<string, number>): StatLine {
  const out: StatLine = {};
  for (const [key, code] of CODES) {
    const v = o[code];
    if (typeof v === "number" && v !== 0) out[key] = v;
  }
  return out;
}

export function encodeHistory(rows: HistRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      i: r.id, p: r.pos, t: r.team, w: r.wk, o: r.opp,
      s: r.stNow ?? undefined,
      j: packStats(r.proj),
      a: r.act === null ? null : packStats(r.act),
      v: r2(r.tot), d: r2(r.spr),
    }))
  );
}

interface Packed {
  i: string; p: Position; t: string; w: number; o: string;
  s?: string; j: Record<string, number>; a: Record<string, number> | null;
  v: number; d: number;
}

export function decodeHistory(json: string): HistRow[] {
  return (JSON.parse(json) as Packed[]).map((r) => ({
    id: r.i, pos: r.p, team: r.t, wk: r.w, opp: r.o,
    stNow: r.s ?? null,
    proj: unpackStats(r.j),
    act: r.a === null ? null : unpackStats(r.a),
    tot: r.v, spr: r.d,
  }));
}
