"use client";

import type { BoardPlayer } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import type { Lineup } from "../../lib/engine/season/lineup";
import { DEFAULT_SEASON_LEVERS } from "../../lib/engine/season/levers";

/**
 * A projection cell. Never shows 0.0 for "we have no number". The forced-play
 * threshold is the engine's lever (config/season.json), not a literal here, so
 * the Must-fix panel and this cell can never disagree about who is out.
 *
 * `·live` marks a status that came from the live table/headline rather than
 * the board's baked designation — a Sunday inactive should read as live, not
 * as if the ETL had known about it in advance. Compared against the week
 * board's UNGRADED status: comparing two already-graded statuses converges
 * on the same merged value and the marker never fires.
 */
function Points({ o, bakedInjury }: { o: WeekOutlook | undefined; bakedInjury: string | null | undefined }) {
  if (!o || !o.projected) return <span className="text-ink-faint" title="No source projected this player">—</span>;
  if (o.opp === null) return <span className="text-warn" title="On a bye">BYE</span>;
  const live = o.drivers.status !== (bakedInjury ?? null);
  const liveMark = live ? <span className="text-live">{" "}·live</span> : null;
  if (o.pPlay <= DEFAULT_SEASON_LEVERS.forcedPlayThreshold) {
    const label = o.drivers.status ?? "OUT";
    return <span className="text-warn" title={label}>{label}{liveMark}</span>;
  }
  return <span>{o.mean.toFixed(1)}{liveMark}</span>;
}

export default function LineupTable({
  lineup,
  players,
  outlooks,
  bakedStatus,
}: {
  lineup: Lineup;
  players: Map<string, BoardPlayer>;
  outlooks: Map<string, WeekOutlook>;
  bakedStatus: Map<string, string | null>;
}) {
  const row = (id: string, slot: string) => {
    const p = players.get(id);
    const o = outlooks.get(id);
    return (
      <tr key={`${slot}-${id}`} className="border-t border-line">
        <td className="py-1 pr-2 text-xs text-ink-faint">{slot}</td>
        <td className="py-1 pr-2">{p?.name ?? id}</td>
        <td className="py-1 pr-2 text-xs text-ink-faint">{p?.pos} · {p?.team}</td>
        <td className="py-1 pr-2 text-xs text-ink-faint">{o?.opp ?? "—"}</td>
        <td className="py-1 pr-2 text-right tabular-nums"><Points o={o} bakedInjury={bakedStatus.get(id)} /></td>
        <td className="py-1 text-right text-xs tabular-nums text-ink-faint">
          {o && o.projected && o.opp !== null ? `${o.p10.toFixed(0)}–${o.p90.toFixed(0)}` : ""}
        </td>
      </tr>
    );
  };

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-faint">
          <th className="pb-1 font-normal">Slot</th>
          <th className="pb-1 font-normal">Player</th>
          <th className="pb-1 font-normal">Pos</th>
          <th className="pb-1 font-normal">Opp</th>
          <th className="pb-1 text-right font-normal">Proj</th>
          <th className="pb-1 text-right font-normal">Floor–Ceil</th>
        </tr>
      </thead>
      <tbody>
        {lineup.starters.map((s) => row(s.player.id, s.slot))}
        {lineup.benched.length > 0 && (
          <tr className="border-t border-line">
            <td colSpan={6} className="pt-2 text-xs uppercase tracking-wide text-ink-faint">Bench</td>
          </tr>
        )}
        {lineup.benched.map((b) => row(b.id, "BN"))}
      </tbody>
    </table>
  );
}
