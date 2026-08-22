import type { Position } from "../types";

/** Position → CSS color token. The palette is the information system. */
export const POS_COLOR: Record<Position, string> = {
  QB: "var(--color-qb)",
  RB: "var(--color-rb)",
  WR: "var(--color-wr)",
  TE: "var(--color-te)",
  K: "var(--color-k)",
  DST: "var(--color-dst)",
};

export const POS_ORDER: Position[] = ["RB", "WR", "QB", "TE", "K", "DST"];
