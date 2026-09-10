// Live statuses (ESPN's injuries table) and hard headlines, graded onto this
// week's outlooks. Pure: no clock, no I/O. The reconciliation rule is the
// board's (lib/engine/injuryFeed.ts reconcileStatus): a structured table may
// escalate and clear day-to-day designations; a baked season-long designation
// yields only to an explicit Active or another season-long status; keyword
// news is escalate-only on top.
//
// Lives here rather than in injuryFeed.ts because the weekly availability
// (pPlay) imports SEASON_LONG from there — putting this beside gradeBoard
// would make an import cycle.
import type { WeekOutlook } from "./outlook";
import type { WeeklyModelParams } from "./model";
import { reconcileStatus, type FeedStatus } from "../injuryFeed";
import { classifyNews, liveInjuryStatus } from "../newsSignal";
import { pPlay } from "./availability";

export function gradeOutlooks(
  outlooks: Map<string, WeekOutlook>,
  liveStatus: ReadonlyMap<string, { status: FeedStatus }>,
  news: ReadonlyMap<string, { headline: string }>,
  params: WeeklyModelParams
): Map<string, WeekOutlook> {
  if (liveStatus.size === 0 && news.size === 0) return outlooks;
  let changed = 0;
  const out = new Map<string, WeekOutlook>();
  for (const [id, o] of outlooks) {
    const row = liveStatus.get(id);
    const tabled = row ? reconcileStatus(o.drivers.status, row.status) : o.drivers.status;
    const item = news.get(id);
    const merged = item ? liveInjuryStatus(tabled, classifyNews(item.headline)) : tabled;
    if (merged === o.drivers.status) {
      out.set(id, o);
      continue;
    }
    changed++;
    // meanIfPlays is the projection conditional on playing; only the
    // availability moves. A bye is a bye regardless of designation.
    const p = pPlay(merged, o.opp === null, params);
    out.set(id, { ...o, pPlay: p, mean: o.meanIfPlays * p, drivers: { ...o.drivers, status: merged } });
  }
  return changed ? out : outlooks;
}
