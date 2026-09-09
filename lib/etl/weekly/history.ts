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
  /** Injury designation at projection time, for the availability fit. */
  st: string | null;
  proj: StatLine;
  /** null = did not appear in the box score. Distinct from an all-zero line. */
  act: StatLine | null;
  /** Game total. */
  tot: number;
  /** This team's own spread; negative = favored. */
  spr: number;
}

/** StatLine keys → one- or two-char codes. Order is frozen: changing it
 *  invalidates every committed snapshot, so append, never reorder. */
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
      s: r.st ?? undefined,
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
    st: r.s ?? null,
    proj: unpackStats(r.j),
    act: r.a === null ? null : unpackStats(r.a),
    tot: r.v, spr: r.d,
  }));
}
