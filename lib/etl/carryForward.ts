import type { Board } from "../types";

const LIVE_FP = /^FantasyPros consensus \((\d+) experts, live\)$/;

function liveFpExperts(b: Board): number {
  for (const s of b.meta.sources) {
    const m = s.name.match(LIVE_FP);
    if (m) return Number(m[1]);
  }
  return 0;
}

/**
 * The fast lane never calls FantasyPros (free-tier quota), and FP data is
 * never committed as a fixture (their terms). Carry the daily lane's
 * FP-derived fields forward so ECR doesn't flip-flop between lanes.
 */
export function carryForwardFp(board: Board, previous: Board | null): Board {
  if (liveFpExperts(board) > 0 || !previous || liveFpExperts(previous) === 0) return board;
  const prev = new Map(previous.players.map((p) => [p.id, p]));
  const fetchedAt = previous.meta.sources.find((s) => LIVE_FP.test(s.name))!.fetchedAt;
  const players = board.players.map((p) => {
    const q = prev.get(p.id);
    return q ? { ...p, ecr: q.ecr, ecrStdev: q.ecrStdev, statsFp: q.statsFp } : p;
  });
  return {
    ...board,
    players,
    meta: {
      ...board.meta,
      sources: [
        ...board.meta.sources,
        { name: `FantasyPros consensus (carried from ${fetchedAt})`, fetchedAt, fromFixture: true },
      ],
    },
  };
}
