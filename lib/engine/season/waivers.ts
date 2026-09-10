// Waiver adds ranked by points added to YOUR lineup over the rest of the
// season, with the drop that costs least. Pure. Streaming is the same
// function scoped to one week and one position.
import type { BoardPlayer, Position } from "../../types";
import { SEASON_LONG } from "../injuryFeed";
import { emptySlotWeeks, meansFor, rosLineupValue, type RosContext } from "./rosValue";

export interface WaiverInput extends RosContext {
  roster: BoardPlayer[];
  available: BoardPlayer[];
  /** Only consider adds at these positions. */
  positions?: Position[];
  /** Only consider drops at these positions (streaming: drop the incumbent). */
  dropPositions?: Position[];
  /** Roster cap; default config.rounds. Below the cap an add needs no drop. */
  rosterMax?: number;
  maxResults?: number;
}

export interface WaiverAdd {
  add: BoardPlayer;
  /** Null when there is room on the roster. */
  drop: BoardPlayer | null;
  /** Lineup points added over ctx.weeks. */
  deltaPoints: number;
  /** Dedicated slot-weeks that were empty and now are not (negative = cover lost). */
  deltaCoverWeeks: number;
  reason: string;
}

const DEFAULT_MAX_RESULTS = 10;
/** Below this many lineup points a candidate is noise, not a claim. */
const MIN_DELTA_POINTS = 0.5;

function reasonFor(delta: number, cover: number, weeks: number[]): string {
  const span = weeks.length === 1 ? `week ${weeks[0]}` : `weeks ${weeks[0]}–${weeks[weeks.length - 1]}`;
  let s = `+${delta.toFixed(1)} lineup points over ${span}`;
  if (cover >= 1) s += `; fills ${cover} slot-week${cover === 1 ? "" : "s"} you would otherwise start empty`;
  else if (cover <= -1) s += `; costs ${-cover} slot-week${cover === -1 ? "" : "s"} of cover`;
  return s;
}

export function waiverAdds(input: WaiverInput): WaiverAdd[] {
  const { roster, available, weeks } = input;
  const ctx: RosContext = { weeks, config: input.config, params: input.params, outlooks: input.outlooks, currentWeek: input.currentWeek };
  const rosterMax = input.rosterMax ?? input.config.rounds;
  const onRoster = new Set(roster.map((p) => p.id));
  const candidates = available.filter(
    (p) => !onRoster.has(p.id) && (!input.positions || input.positions.includes(p.pos)) && !(p.injury && SEASON_LONG.has(p.injury))
  );
  const means = meansFor([...roster, ...candidates], ctx);
  const base = rosLineupValue(roster, ctx, means);
  const baseEmpty = emptySlotWeeks(roster, ctx);
  const dropPool = input.dropPositions ? roster.filter((p) => input.dropPositions!.includes(p.pos)) : roster;

  const out: WaiverAdd[] = [];
  for (const add of candidates) {
    const options: Array<{ drop: BoardPlayer | null; value: number; after: BoardPlayer[] }> = [];
    const consider = (drop: BoardPlayer | null) => {
      const after = drop ? [...roster.filter((p) => p.id !== drop.id), add] : [...roster, add];
      const value = rosLineupValue(after, ctx, means) - base;
      options.push({ drop, value, after });
    };
    if (roster.length < rosterMax && !input.dropPositions) consider(null);
    for (const d of dropPool) consider(d);

    // Find best option: higher value, then by tie-break (lower projection drop)
    let best: typeof options[0] | null = null;
    for (const opt of options) {
      if (best === null || opt.value > best.value + 1e-9 || (Math.abs(opt.value - best.value) <= 1e-9 && opt.drop && best.drop && opt.drop.projPoints < best.drop.projPoints)) {
        best = opt;
      }
    }

    if (!best || best.value < MIN_DELTA_POINTS) continue;
    const cover = baseEmpty - emptySlotWeeks(best.after, ctx);
    out.push({ add, drop: best.drop, deltaPoints: best.value, deltaCoverWeeks: cover, reason: reasonFor(best.value, cover, weeks) });
  }
  out.sort((a, b) => b.deltaPoints - a.deltaPoints || a.add.id.localeCompare(b.add.id));
  return out.slice(0, input.maxResults ?? DEFAULT_MAX_RESULTS);
}

/** Streaming: one week, one position, and the drop is the incumbent at that position. */
export function streamingOptions(
  input: Omit<WaiverInput, "weeks" | "positions" | "dropPositions"> & { week: number; pos: Position }
): WaiverAdd[] {
  const { week, pos, ...rest } = input;
  return waiverAdds({ ...rest, weeks: [week], positions: [pos], dropPositions: [pos], currentWeek: rest.currentWeek ?? week });
}
