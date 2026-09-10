"use client";

import type { BoardPlayer } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import type { Lineup } from "../../lib/engine/season/lineup";
import { DEFAULT_SEASON_LEVERS } from "../../lib/engine/season/levers";
import { POS_COLOR } from "../../lib/client/pos";

/** Day-to-day designations that still project a number — the ones that need a tag beside it. */
const STATUS_TAG: Record<string, string> = { Questionable: "Q", Doubtful: "D" };

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
 *
 * A Questionable/Doubtful player who still clears the forced-play threshold
 * gets a small "Q"/"D" tag next to his number — otherwise 3.8 reads as a
 * healthy 3.8, not as a game-time decision.
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
  const tag = o.drivers.status ? STATUS_TAG[o.drivers.status] : undefined;
  return (
    <span>
      {o.mean.toFixed(1)}
      {tag && <span className="text-warn" title={o.drivers.status ?? undefined}>{" "}{tag}</span>}
      {liveMark}
    </span>
  );
}

export default function LineupTable({
  lineup,
  players,
  outlooks,
  bakedStatus,
  changed,
  onSelect,
}: {
  lineup: Lineup;
  players: Map<string, BoardPlayer>;
  outlooks: Map<string, WeekOutlook>;
  bakedStatus: Map<string, string | null>;
  /** Ids whose starter/bench slot differs between the current and recommended lineup. */
  changed?: Set<string>;
  /** When given, player names become buttons that open the player card. */
  onSelect?: (id: string) => void;
}) {
  const row = (id: string, slot: string, isStarter: boolean) => {
    const p = players.get(id);
    const o = outlooks.get(id);
    const isChanged = changed?.has(id) ?? false;
    return (
      <tr key={`${slot}-${id}`} className={`border-t border-line hover:bg-panel ${isChanged ? "bg-panel" : ""}`}>
        <td className="py-1 pr-2 text-xs text-ink-faint">
          {slot}
          {isChanged && <span className="ml-1 text-live" title="Changes with the recommended swaps">{isStarter ? "↑" : "↓"}</span>}
        </td>
        <td className="py-1 pr-2">
          {onSelect ? (
            <button
              onClick={() => onSelect(id)}
              className="text-left hover:text-wr"
            >
              {p?.name ?? id}
            </button>
          ) : (
            p?.name ?? id
          )}
        </td>
        <td className="py-1 pr-2 text-xs">
          {p && <span style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>} <span className="text-ink-faint">· {p?.team}</span>
        </td>
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
        {lineup.starters.map((s) => row(s.player.id, s.slot, true))}
        {lineup.benched.length > 0 && (
          <tr className="border-t border-line">
            <td colSpan={6} className="pt-2 text-xs uppercase tracking-wide text-ink-faint">Bench</td>
          </tr>
        )}
        {lineup.benched.map((b) => row(b.id, "BN", false))}
      </tbody>
    </table>
  );
}
