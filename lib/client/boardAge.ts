/** "built 12 min ago" + a staleness flag (older than 12 h) for the board's builtAt. */
export function formatAge(builtAt: string, now: number): { label: string; stale: boolean } {
  const t = Date.parse(builtAt);
  if (!Number.isFinite(t)) return { label: "build time unknown", stale: true };
  const mins = Math.floor((now - t) / 60_000);
  const stale = mins >= 12 * 60;
  if (mins < 1) return { label: "built just now", stale };
  if (mins < 60) return { label: `built ${mins} min ago`, stale };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { label: `built ${hours} h ago`, stale };
  return { label: `built ${Math.floor(hours / 24)} d ago`, stale };
}
