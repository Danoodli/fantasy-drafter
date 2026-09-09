/**
 * CI lanes. `fast` (every 30 min) refreshes only sources that tolerate it —
 * FFC ADP, ESPN projections, Sleeper projections, the ESPN injuries table,
 * RSS — and reads everything else from fixtures. `full` (daily + local) is
 * today's behaviour. See docs/superpowers/specs/2026-09-07-freshness-and-newsroom-design.md §1a.
 *
 * `weekly` (Thu–Mon, in-season) refreshes the weekly boards: Sleeper weekly
 * projections, ESPN weekly projections, Vegas lines, nflverse box scores.
 *
 * FantasyPros is called from `full` ONLY — its free tier is ~10 requests/day.
 */
export type Lane = "fast" | "full" | "weekly";

export function parseLane(argv: string[]): Lane {
  const arg = argv.find((a) => a.startsWith("--lane="));
  const v = arg?.slice("--lane=".length);
  if (!v || v === "full") return "full";
  if (v === "fast") return "fast";
  if (v === "weekly") return "weekly";
  throw new Error(`unknown --lane=${v} (expected fast|full|weekly)`);
}
