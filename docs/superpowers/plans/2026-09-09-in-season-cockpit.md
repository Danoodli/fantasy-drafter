# In-Season Cockpit (Leg B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly surface at `/season` that tells you who to start, who to swap in for a bye or an injury, who to claim off waivers, and whether a trade helps — ranked by the probability you win *this* matchup rather than by expected points.

**Architecture:** Pure engine modules under `lib/engine/season/` compute lineups, win probability, advice, waivers, playoff odds and trades from Leg A's `WeekOutlook` and correlated sampler. A localStorage teams registry (`lib/client/teams.ts`) holds any number of leagues, populated by four ingestion paths that all terminate in one `applyRoster`. The UI is a client component at `app/season/` reusing the cockpit's visual language.

**Tech Stack:** TypeScript, Next.js App Router (client components), React 19, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-in-season-cockpit-design.md` — read it before Task 1 and keep it open.

**Depends on:** Leg A (`docs/superpowers/plans/2026-09-09-weekly-projection-engine.md`). Tasks 1–16 of that plan are complete; `WeekOutlook`, `weekSim`, `config/weekly-model.json` (fitted), the historical fit set under `data/historical-data/weekly/` and `public/data/week-{season}-{week}-{format}.json` all exist and are tested.

## Global Constraints

- **`lib/engine/**` is PURE**: no I/O, no `Date.now()`, no `Math.random()`. Randomness only via `makeRng(seed)` from `lib/engine/montecarlo.ts`. Unit-tested and replayed, so a violation breaks determinism.
- **All I/O lives in `lib/client/` (browser) or `lib/etl/` (Node).** Never import `lib/etl/*` from a component.
- **This repo runs a Next.js version with breaking changes from training data.** Before writing anything under `app/`, read `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` and `05-server-and-client-components.md`. Existing precedent: `app/page.tsx` and `app/newsroom/page.tsx` are both `"use client"` at the top because they need `localStorage` and interactivity. Follow that.
- **No paid services, no API keys.** Sleeper's league API is free and keyless.
- **Levers are config, not code.** Never hardcode a tuned number in a branch.
- **`WeekOutlook.projected === false` must never render as `0.0`.** It means no source had an opinion; a bye and an "Out" designation also produce `mean: 0` and are entirely different facts. Render "—" or "no projection".
- **Match the existing visual language.** Read `components/Cockpit.tsx` and `components/TierBoard.tsx` before writing UI. Tailwind v4, same spacing and type scale, and the repo's colour tokens from `app/globals.css` (`bg-field`, `bg-panel`, `border-line`, `text-ink`, `text-ink-dim`, `text-ink-faint`, `text-warn`, `text-rb`, `text-qb`, …) — never Tailwind's `neutral-*` greys. Do not introduce a new design system.
- **`pnpm test`, `pnpm exec tsc --noEmit` and `pnpm lint` are all clean and must stay so.** Commit on the current branch; check `git branch --show-current` first.
- **Perf budget:** `startSitAdvice` for a 15-man roster at 2,000 sims must run under 150 ms. Playoff odds is a background compute with a spinner, not a keystroke path.
- Blank line before any `Co-Authored-By:` trailer.

## File Structure

| File | Responsibility |
|---|---|
| `lib/client/teams.ts` | localStorage registry of saved teams; `applyRoster` funnel |
| `lib/client/weekBoard.ts` | fetch + cache `week-{season}-{week}-{format}.json` |
| `lib/engine/season/lineup.ts` | `bestLineup` (assignment), `winProbability` / `matchupWinProbability` (fixed lineups, one joint draw) |
| `lib/engine/season/levers.ts` + `config/season.json` | validated in-season levers; risk dial ships OFF |
| `lib/engine/season/advice.ts` | `startSitAdvice`: forced swaps, ranked swaps, recommended lineup, manual-opponent model |
| `lib/engine/season/playoffOdds.ts` | rest-of-season sim on the season outcome model; `leverage` for the risk dial |
| `lib/engine/season/rosValue.ts` | weekly means and rest-of-season lineup value shared by waivers and trades |
| `lib/engine/season/waivers.ts` | `waiverAdds` (value over MY lineup), `streamingOptions` |
| `lib/engine/season/trade.ts` | three-axis trade evaluation |
| `lib/engine/season/replay.ts` | adapters from the historical fit set for the replay gates |
| `lib/engine/weekly/liveGrade.ts` | `gradeOutlooks`: live statuses/headlines onto outlooks (pure) |
| `lib/season/sleeperLeague.ts` | Sleeper league/roster/matchup/users parsers (fixture-tested) + fetchers |
| `lib/season/rosterPaste.ts` | paste parsing with slot labels and section headers (pure) |
| `lib/season/rosterOcr.ts` | OCR lines → roster with slots (pure) |
| `scripts/backtest-lineup.ts` | replay gates L1/L2 on synthetic leagues over real player-weeks |
| `app/season/page.tsx` | route shell, loads config + week board + team |
| `components/season/SeasonCockpit.tsx` | top-level layout and section order |
| `components/season/LineupTable.tsx` | starters/bench, never renders "no projection" as 0.0 |
| `components/season/RosterImport.tsx` | tab strip for the four ingestion paths |
| `components/season/SleeperSync.tsx`, `RosterPaste.tsx`, `RosterScreenSync.tsx` | the Sleeper, paste and screen-sync tabs |
| `components/season/MatchupPanel.tsx`, `WaiversPanel.tsx`, `PlayoffPanel.tsx`, `TradePanel.tsx` | the analysis sections |

---

### Task 1: Teams registry and the `applyRoster` funnel

**Files:**
- Create: `lib/client/teams.ts`
- Test: `tests/teams.test.ts`

**Interfaces:**
- Consumes: `LeagueConfig`, `Position` from `lib/types.ts`.
- Produces:
  - `interface RosterEntry { playerId: string; slot: "starter" | "bench" | "ir" }`
  - `interface SavedTeam { id: string; name: string; config: LeagueConfig; source: "sleeper" | "manual" | "paste" | "ocr"; sleeper?: { leagueId: string; rosterId: number }; roster: RosterEntry[]; schedule?: Record<number, { oppRosterId?: number; oppName?: string }>; record?: { w: number; l: number; t: number }; savedAt: string }`
  - `loadTeams(): SavedTeam[]`, `saveTeam(team: SavedTeam): SavedTeam[]`, `deleteTeam(id: string): SavedTeam[]`, `applyRoster(team: SavedTeam, ids: string[], source: SavedTeam["source"]): SavedTeam`
  - Later tasks extend this file rather than replace it: Task 7 adds an optional fourth `slots` argument to `applyRoster` and the `LeagueSnapshot` type; Task 13 adds two optional `SavedTeam` fields. Implement Task 1 exactly as written here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/teams.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadTeams, saveTeam, deleteTeam, applyRoster, type SavedTeam } from "../lib/client/teams";
import type { LeagueConfig } from "../lib/types";

const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

const team = (over: Partial<SavedTeam> = {}): SavedTeam => ({
  id: "t1", name: "Main league", config, source: "manual",
  roster: [], savedAt: "2026-09-09T00:00:00.000Z", ...over,
});

// jsdom is not configured for this suite; stub localStorage directly.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("teams registry", () => {
  it("starts empty and survives a round trip", () => {
    expect(loadTeams()).toEqual([]);
    saveTeam(team());
    expect(loadTeams()).toHaveLength(1);
    expect(loadTeams()[0].name).toBe("Main league");
  });

  it("holds several leagues at once, newest first", () => {
    saveTeam(team({ id: "a", name: "A", savedAt: "2026-09-01T00:00:00.000Z" }));
    saveTeam(team({ id: "b", name: "B", savedAt: "2026-09-08T00:00:00.000Z" }));
    expect(loadTeams().map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("upserts by id rather than duplicating", () => {
    saveTeam(team({ id: "a", name: "First" }));
    saveTeam(team({ id: "a", name: "Renamed" }));
    const all = loadTeams();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Renamed");
  });

  it("deletes by id", () => {
    saveTeam(team({ id: "a" }));
    saveTeam(team({ id: "b" }));
    expect(deleteTeam("a").map((t) => t.id)).toEqual(["b"]);
  });

  it("survives corrupt storage rather than throwing", () => {
    localStorage.setItem("draft-cockpit-teams-v1", "{not json");
    expect(loadTeams()).toEqual([]);
  });

  it("applyRoster is the single funnel: it replaces the roster and stamps the source", () => {
    const t = applyRoster(team({ source: "manual" }), ["1", "2", "3"], "paste");
    expect(t.roster.map((r) => r.playerId)).toEqual(["1", "2", "3"]);
    expect(t.source).toBe("paste");
    // Every ingestion path lands here, so slots default consistently.
    expect(new Set(t.roster.map((r) => r.slot))).toEqual(new Set(["bench"]));
  });

  it("applyRoster drops duplicate ids, keeping the first", () => {
    const t = applyRoster(team(), ["1", "2", "1", "3"], "manual");
    expect(t.roster.map((r) => r.playerId)).toEqual(["1", "2", "3"]);
  });

  it("applyRoster preserves the slot of a player already on the roster", () => {
    const base = team({ roster: [{ playerId: "1", slot: "starter" }, { playerId: "9", slot: "ir" }] });
    const t = applyRoster(base, ["1", "2"], "sleeper");
    expect(t.roster.find((r) => r.playerId === "1")?.slot).toBe("starter");
    expect(t.roster.find((r) => r.playerId === "2")?.slot).toBe("bench");
    // 9 is no longer on the roster, so it is gone.
    expect(t.roster.find((r) => r.playerId === "9")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/teams.test.ts`
Expected: FAIL — cannot resolve `../lib/client/teams`.

- [ ] **Step 3: Write the module**

```ts
// lib/client/teams.ts
// Saved teams — every league you track, on-device (localStorage: bigger and
// cheaper than cookies, never sent over the wire, no expiry). Modelled on
// lib/client/history.ts, which does the same for drafts.
//
// Holds MANY leagues at once: a redraft league, a best ball, a friend's
// league. Each carries its own scoring and roster slots, so the engine reads
// the right settings per team without you re-entering anything.
import type { LeagueConfig } from "../types";

export interface RosterEntry {
  playerId: string;
  slot: "starter" | "bench" | "ir";
}

export interface SavedTeam {
  id: string;
  name: string;
  config: LeagueConfig;
  /** Which ingestion path last populated this roster. */
  source: "sleeper" | "manual" | "paste" | "ocr";
  sleeper?: { leagueId: string; rosterId: number };
  roster: RosterEntry[];
  /** Opponent per week, when the platform tells us. */
  schedule?: Record<number, { oppRosterId?: number; oppName?: string }>;
  record?: { w: number; l: number; t: number };
  savedAt: string; // ISO
}

const KEY = "draft-cockpit-teams-v1";
const MAX_TEAMS = 20;

export function loadTeams(): SavedTeam[] {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? (JSON.parse(raw) as SavedTeam[]) : [];
    return Array.isArray(all) ? all : [];
  } catch {
    // Corrupt or unavailable storage must not take the page down.
    return [];
  }
}

function write(teams: SavedTeam[]): SavedTeam[] {
  const sorted = [...teams].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, MAX_TEAMS);
  try {
    localStorage.setItem(KEY, JSON.stringify(sorted));
  } catch {
    // Quota or private-mode failure: the in-memory result is still correct.
  }
  return sorted;
}

/** Insert or replace by id. Newest first. */
export function saveTeam(team: SavedTeam): SavedTeam[] {
  return write([...loadTeams().filter((t) => t.id !== team.id), team]);
}

export function deleteTeam(id: string): SavedTeam[] {
  return write(loadTeams().filter((t) => t.id !== id));
}

/**
 * THE funnel. Sleeper sync, manual entry, paste and OCR all end here, so
 * there is exactly one kind of roster change and every consumer sees the same
 * shape — the same discipline as useDraft.applyImport for draft picks.
 *
 * Slots of players already on the roster are preserved, so re-syncing does not
 * silently un-start your lineup. Players no longer present are dropped.
 */
export function applyRoster(
  team: SavedTeam,
  ids: string[],
  source: SavedTeam["source"]
): SavedTeam {
  const previous = new Map(team.roster.map((r) => [r.playerId, r.slot] as const));
  const seen = new Set<string>();
  const roster: RosterEntry[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    roster.push({ playerId: id, slot: previous.get(id) ?? "bench" });
  }
  return { ...team, roster, source };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/teams.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/client/teams.ts tests/teams.test.ts
git commit -m "Season: saved-teams registry with one applyRoster funnel"
```

---

### Task 2: Best lineup with the assignment

The existing `optimalLineupTotal` in `lib/engine/season.ts:17` is greedy and returns only a total. **Correction to the spec, recorded here:** with one kind of FLEX and one eligibility set — all `RosterSlots` can express — the greedy fill is already exact (any k eligible leftovers can fill k identical flex slots, so the top k is optimal). The spec's claim that it is "silently wrong for superflex or two-flex leagues" was mistaken, and `season.ts` is therefore not migrated (Task 15 records why in its doc comment). What start/sit needs and `optimalLineupTotal` cannot give is the **assignment** — which player sits in which slot, and who is benched — so this module returns that, computed by an allocation search that is exact by construction and would stay exact if a second flex kind were ever added.

**Files:**
- Create: `lib/engine/season/lineup.ts`
- Test: `tests/seasonLineup.test.ts`

**Interfaces:**
- Consumes: `LeagueConfig`, `Position` from `lib/types.ts`.
- Produces:
  - `interface LineupPlayer { id: string; pos: Position; points: number }`
  - `interface Lineup { starters: { slot: string; player: LineupPlayer }[]; total: number; benched: LineupPlayer[] }`
  - `bestLineup(players: LineupPlayer[], config: LeagueConfig): Lineup`

- [ ] **Step 1: Write the failing test**

```ts
// tests/seasonLineup.test.ts
import { describe, it, expect } from "vitest";
import { bestLineup, type LineupPlayer } from "../lib/engine/season/lineup";
import type { LeagueConfig } from "../lib/types";

const cfg = (over: Partial<LeagueConfig> = {}): LeagueConfig => ({
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced", ...over,
});

const p = (id: string, pos: LineupPlayer["pos"], points: number): LineupPlayer => ({ id, pos, points });

describe("bestLineup", () => {
  it("fills dedicated slots with the best at each position", () => {
    const l = bestLineup([p("qb1", "QB", 20), p("qb2", "QB", 15), p("rb1", "RB", 12), p("rb2", "RB", 9), p("wr1", "WR", 14), p("wr2", "WR", 11), p("te1", "TE", 8), p("k1", "K", 7), p("d1", "DST", 6)], cfg());
    expect(l.starters.find((s) => s.slot === "QB")?.player.id).toBe("qb1");
    // 1 flex among the leftovers: nobody is left, so it stays unfilled.
    expect(l.total).toBeCloseTo(20 + 12 + 9 + 14 + 11 + 8 + 7 + 6, 6);
    expect(l.benched.map((b) => b.id)).toEqual(["qb2"]);
  });

  it("puts the best leftover in the flex, whatever its position", () => {
    const l = bestLineup([p("qb1", "QB", 20), p("rb1", "RB", 12), p("rb2", "RB", 9), p("rb3", "RB", 8), p("wr1", "WR", 14), p("wr2", "WR", 11), p("wr3", "WR", 13), p("te1", "TE", 8), p("k1", "K", 7), p("d1", "DST", 6)], cfg());
    // The two WR slots take the two best WRs (wr1 14, wr3 13) regardless of
    // input order, so the leftovers are rb3 8 and wr2 11: the flex takes wr2.
    expect(l.starters.filter((s) => s.slot === "WR").map((s) => s.player.id).sort()).toEqual(["wr1", "wr3"]);
    expect(l.starters.find((s) => s.slot === "FLEX")?.player.id).toBe("wr2");
    expect(l.total).toBeCloseTo(20 + 12 + 9 + 14 + 13 + 11 + 8 + 7 + 6, 6);
    expect(l.benched.map((b) => b.id)).toEqual(["rb3"]);
  });

  it("fills two flex slots with the two best eligible leftovers", () => {
    // A greedy top-k fill gives the same answer (see the task note): this pins
    // the allocation search to it.
    const l = bestLineup(
      [p("qb1", "QB", 20), p("rb1", "RB", 12), p("rb2", "RB", 9), p("rb3", "RB", 10), p("wr1", "WR", 14), p("wr2", "WR", 11), p("wr3", "WR", 13), p("te1", "TE", 8), p("te2", "TE", 12), p("k1", "K", 7), p("d1", "DST", 6)],
      cfg({ rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1 } })
    );
    const flex = l.starters.filter((s) => s.slot === "FLEX").map((s) => s.player.id).sort();
    // Dedicated slots take the best at each position first: RB rb1 12 + rb3 10,
    // WR wr1 14 + wr3 13, TE te2 12. Leftovers are rb2 9, wr2 11, te1 8 -> the
    // two flex slots take wr2 and rb2, and te1 is the only bench player.
    expect(l.starters.find((s) => s.slot === "TE")?.player.id).toBe("te2");
    expect(flex).toEqual(["rb2", "wr2"]);
    expect(l.benched.map((b) => b.id)).toEqual(["te1"]);
    expect(l.total).toBeCloseTo(20 + 12 + 9 + 10 + 14 + 13 + 11 + 12 + 7 + 6, 6);
  });

  it("handles superflex, where the second-best QB can beat every flex option", () => {
    const l = bestLineup(
      [p("qb1", "QB", 22), p("qb2", "QB", 19), p("rb1", "RB", 12), p("rb2", "RB", 9), p("wr1", "WR", 14), p("wr2", "WR", 11), p("wr3", "WR", 6), p("te1", "TE", 8), p("k1", "K", 7), p("d1", "DST", 6)],
      cfg({ rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, flexEligible: ["QB", "RB", "WR", "TE"] })
    );
    // qb2 at 19 must win the superflex over wr3 at 6.
    expect(l.starters.find((s) => s.slot === "FLEX")?.player.id).toBe("qb2");
    expect(l.benched.map((b) => b.id)).toEqual(["wr3"]);
  });

  it("leaves a slot unfilled rather than inventing a player", () => {
    const l = bestLineup([p("qb1", "QB", 20)], cfg());
    expect(l.starters).toHaveLength(1);
    expect(l.total).toBeCloseTo(20, 6);
  });

  it("never starts the same player twice", () => {
    const l = bestLineup([p("rb1", "RB", 12), p("wr1", "WR", 14)], cfg());
    const ids = l.starters.map((s) => s.player.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic on ties: the same players start whatever the input order", () => {
    const players = [p("a", "RB", 10), p("b", "RB", 10), p("c", "RB", 10)];
    const one = bestLineup(players, cfg());
    const two = bestLineup([...players].reverse(), cfg());
    // Two RB slots, three equal RBs: the id tiebreak must pick the same two
    // both times. A first-encountered rule would start a,b then c,b.
    expect(one.starters.map((s) => s.player.id)).toEqual(two.starters.map((s) => s.player.id));
    expect(one.benched.map((b) => b.id)).toEqual(two.benched.map((b) => b.id));
  });

  it("fills as many flex slots as there are eligible leftovers, not none", () => {
    // Two flex slots, one leftover (rb2): a search over compositions summing
    // to exactly 2 finds nothing feasible and would leave both empty.
    const l = bestLineup(
      [p("rb1", "RB", 10), p("rb2", "RB", 5), p("wr1", "WR", 8)],
      cfg({ rosterSlots: { QB: 0, RB: 1, WR: 1, TE: 0, FLEX: 2, K: 0, DST: 0 } })
    );
    expect(l.starters.filter((s) => s.slot === "FLEX").map((s) => s.player.id)).toEqual(["rb2"]);
    expect(l.total).toBeCloseTo(23, 6);
    expect(l.benched).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonLineup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/season/lineup.ts
// The best legal lineup, computed EXACTLY. Pure.
//
// lib/engine/season.ts's optimalLineupTotal is greedy: it fills dedicated
// slots then takes the top leftovers for flex. That is exact for a single flex
// and silently wrong otherwise, and start/sit is where it would bite.
//
// The exact solution is cheap because of one observation: within a position you
// always start your highest scorer, so an optimal lineup is fully determined by
// HOW MANY players each position contributes to the flex slots. There are only
// a handful of such allocations (3 for one flex over three eligible positions,
// 10 for three), so enumerating them is exhaustive over the optimum rather
// than a heuristic.
import type { LeagueConfig, Position } from "../../types";

export interface LineupPlayer {
  id: string;
  pos: Position;
  points: number;
}

export interface Lineup {
  starters: { slot: string; player: LineupPlayer }[];
  total: number;
  benched: LineupPlayer[];
}

const DEDICATED: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/** All ways to draw `n` items from `k` buckets. Compositions, not permutations. */
function allocations(k: number, n: number): number[][] {
  if (k === 0) return n === 0 ? [[]] : [];
  const out: number[][] = [];
  for (let take = 0; take <= n; take++) {
    for (const rest of allocations(k - 1, n - take)) out.push([take, ...rest]);
  }
  return out;
}

export function bestLineup(players: LineupPlayer[], config: LeagueConfig): Lineup {
  // Highest first, id as a tiebreak so the result is deterministic.
  const byPos = new Map<Position, LineupPlayer[]>();
  for (const pl of players) {
    const list = byPos.get(pl.pos) ?? [];
    list.push(pl);
    byPos.set(pl.pos, list);
  }
  for (const list of byPos.values()) {
    list.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  }

  // Dedicated slots first: they can only be filled by their own position.
  const used = new Map<Position, number>();
  const starters: { slot: string; player: LineupPlayer }[] = [];
  for (const pos of DEDICATED) {
    const n = config.rosterSlots[pos] ?? 0;
    const list = byPos.get(pos) ?? [];
    let taken = 0;
    for (let i = 0; i < n && i < list.length; i++) {
      starters.push({ slot: pos, player: list[i] });
      taken++;
    }
    used.set(pos, taken);
  }

  const flexSlots = config.rosterSlots.FLEX ?? 0;
  const eligible = config.flexEligible.filter((pos) => (byPos.get(pos) ?? []).length > (used.get(pos) ?? 0));
  // Fill as many flex slots as there are eligible leftovers: with fewer
  // leftovers than slots, a composition summing to flexSlots is infeasible and
  // an exact-sum search would leave EVERY flex slot empty.
  const leftover = eligible.reduce((s, pos) => s + (byPos.get(pos) ?? []).length - (used.get(pos) ?? 0), 0);
  const toFill = Math.min(flexSlots, leftover);

  let bestFlex: LineupPlayer[] = [];
  let bestGain = -1;
  if (toFill > 0) {
    for (const alloc of allocations(eligible.length, toFill)) {
      const picked: LineupPlayer[] = [];
      let ok = true;
      for (let i = 0; i < eligible.length; i++) {
        const pos = eligible[i];
        const list = byPos.get(pos) ?? [];
        const from = used.get(pos) ?? 0;
        // Cannot take more than remain at that position.
        if (from + alloc[i] > list.length) { ok = false; break; }
        for (let j = 0; j < alloc[i]; j++) picked.push(list[from + j]);
      }
      if (!ok) continue;
      const gain = picked.reduce((s, x) => s + x.points, 0);
      if (gain > bestGain) { bestGain = gain; bestFlex = picked; }
    }
  }
  for (const pl of bestFlex) starters.push({ slot: "FLEX", player: pl });

  const startedIds = new Set(starters.map((s) => s.player.id));
  const benched = players
    .filter((pl) => !startedIds.has(pl.id))
    .sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));

  return {
    starters,
    total: starters.reduce((s, x) => s + x.player.points, 0),
    benched,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonLineup.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Confirm the equivalence claim**

Confirm by reasoning (and note it in your report) that for every test above a greedy top-k flex fill would return the same total as the allocation search — that is the expected outcome, per the task note. If you find a `RosterSlots`-expressible config where they differ, report it: it would mean the note is wrong and `season.ts` needs migrating after all.

- [ ] **Step 6: Commit**

```bash
git add lib/engine/season/lineup.ts tests/seasonLineup.test.ts
git commit -m "Season: exact best lineup by flex allocation search"
```

---

### Task 3: Win probability over correlated draws

**Files:**
- Modify: `lib/engine/season/lineup.ts` (append)
- Test: `tests/seasonWinProb.test.ts`

**Interfaces:**
- Consumes: `simulateWeek`, `WeekSimPlayer` from `lib/engine/weekSim.ts`; `WeeklyModelParams` from `lib/engine/weekly/model.ts`.
- Produces:
  - `winProbability(draws: Float64Array[], mine: number[], theirs: number[]): number` — indices into each draw; lineups are FIXED.
  - `matchupWinProbability(mine: WeekSimPlayer[], theirs: WeekSimPlayer[], p: WeeklyModelParams, sims: number, seed: number): number` — simulate once, compare two fixed lineups.

**Design, and why it is not "re-optimise the lineup inside each draw".** A lineup is a decision you lock before kickoff; the sampler then tells you how often that locked set outscores theirs. Re-optimising per draw would be hindsight, and worse, it makes every swap a no-op: swapping a bench player for a starter changes which players are *in the set the optimiser sees*, not the set itself, so the win probability could only move by RNG-stream noise. (An earlier draft of this plan had exactly that defect; the controller caught it by pre-computing the test fixtures.) So:

```
P(win | lineup L) = P( Σ_{i∈L} X_i  >  Σ_{j∈their starters} X_j )
```

with every X drawn from ONE joint correlated week, so a shared game between one of your players and one of theirs is correlated rather than assumed independent. Taking indices rather than players is what lets Task 4 evaluate every candidate swap against the *same* draws — a paired comparison whose noise is a small fraction of an unpaired one, and the reason 2,000 sims is enough.

- [ ] **Step 1: Write the failing test**

```ts
// tests/seasonWinProb.test.ts
import { describe, it, expect } from "vitest";
import { winProbability, matchupWinProbability } from "../lib/engine/season/lineup";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import type { WeekSimPlayer } from "../lib/engine/weekSim";

const sp = (id: string, pos: WeekSimPlayer["pos"], mean: number, over: Partial<WeekSimPlayer> = {}): WeekSimPlayer => ({
  // Distinct team and game per player: independent draws, so the arithmetic below is checkable by hand.
  id, pos, team: id.toUpperCase(), gameId: `G-${id}`, opp: "OPP",
  meanIfPlays: mean, sigma: 0.6, pPlay: 1, stats: {}, ...over,
});

/** Eight fixed starters, one per dedicated slot of a standard lineup. */
const starters = (prefix: string, mean: number): WeekSimPlayer[] => [
  sp(`${prefix}qb`, "QB", mean), sp(`${prefix}r1`, "RB", mean), sp(`${prefix}r2`, "RB", mean),
  sp(`${prefix}w1`, "WR", mean), sp(`${prefix}w2`, "WR", mean), sp(`${prefix}te`, "TE", mean),
  sp(`${prefix}k`, "K", mean), sp(`${prefix}ds`, "DST", mean),
];

describe("winProbability over given draws", () => {
  it("counts wins, half-counts ties, by index", () => {
    const draws = [new Float64Array([10, 5]), new Float64Array([3, 8]), new Float64Array([6, 6])];
    // win, loss, tie -> (1 + 0.5) / 3
    expect(winProbability(draws, [0], [1])).toBeCloseTo(0.5, 10);
  });

  it("sums several indices per side", () => {
    const draws = [new Float64Array([4, 4, 7]), new Float64Array([1, 1, 3])];
    expect(winProbability(draws, [0, 1], [2])).toBe(0.5); // 8>7 then 2<3
  });

  it("is 0.5 with no draws rather than NaN", () => {
    expect(winProbability([], [0], [1])).toBe(0.5);
  });
});

describe("matchupWinProbability", () => {
  it("is near 0.5 between identical rosters", () => {
    // Pre-computed by the controller at seed 11: 0.506.
    const wp = matchupWinProbability(starters("a", 12), starters("b", 12), DEFAULT_WEEKLY_MODEL, 3000, 11);
    expect(wp).toBeGreaterThan(0.44);
    expect(wp).toBeLessThan(0.56);
  });

  it("rises with a stronger roster and falls with a weaker one", () => {
    // Pre-computed at seed 7: 0.894 and 0.110.
    const strong = matchupWinProbability(starters("a", 18), starters("b", 12), DEFAULT_WEEKLY_MODEL, 3000, 7);
    const weak = matchupWinProbability(starters("a", 8), starters("b", 12), DEFAULT_WEEKLY_MODEL, 3000, 7);
    expect(strong).toBeGreaterThan(0.8);
    expect(weak).toBeLessThan(0.2);
  });

  it("is monotone in my own strength", () => {
    // Pre-computed at seed 3: 0.098, 0.277, 0.491, 0.673, 0.802.
    const seq = [8, 10, 12, 14, 16].map((m) =>
      matchupWinProbability(starters("a", m), starters("b", 12), DEFAULT_WEEKLY_MODEL, 4000, 3)
    );
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1]);
  });

  it("is deterministic for a given seed", () => {
    const a = matchupWinProbability(starters("a", 12), starters("b", 13), DEFAULT_WEEKLY_MODEL, 1000, 99);
    const b = matchupWinProbability(starters("a", 12), starters("b", 13), DEFAULT_WEEKLY_MODEL, 1000, 99);
    expect(a).toBe(b);
  });

  it("counts a tie as half a win rather than a loss", () => {
    // sigma 0 makes every draw exactly the mean, so every week is an exact tie.
    const one = [sp("x", "QB", 10, { sigma: 0 })];
    const two = [sp("y", "QB", 10, { sigma: 0 })];
    expect(matchupWinProbability(one, two, DEFAULT_WEEKLY_MODEL, 200, 1)).toBeCloseTo(0.5, 6);
  });

  it("treats a lineup that cannot play as scoring nothing", () => {
    const crippled = starters("a", 12).map((x) => ({ ...x, pPlay: 0 }));
    expect(matchupWinProbability(crippled, starters("b", 12), DEFAULT_WEEKLY_MODEL, 500, 5)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonWinProb.test.ts`
Expected: FAIL — `winProbability` is not exported.

- [ ] **Step 3: Append the implementation to `lib/engine/season/lineup.ts`**

```ts
import { simulateWeek, type WeekSimPlayer } from "../weekSim";
import type { WeeklyModelParams } from "../weekly/model";

/**
 * P(the players at `mine` outscore the players at `theirs`) over `draws`,
 * where both are INDEX lists into each draw. The lineups are fixed — a lineup
 * is a decision locked before kickoff, and the question is how often that
 * locked set wins. A tie counts as half a win, as head-to-head leagues score it.
 *
 * Indices rather than players so a caller can score many candidate lineups
 * against the SAME draws (a paired comparison), which is what makes swap
 * deltas precise at a few thousand sims.
 */
export function winProbability(draws: Float64Array[], mine: number[], theirs: number[]): number {
  if (draws.length === 0) return 0.5;
  let wins = 0;
  let ties = 0;
  for (const d of draws) {
    let a = 0;
    for (const i of mine) a += d[i];
    let b = 0;
    for (const j of theirs) b += d[j];
    if (a > b) wins++;
    else if (a === b) ties++;
  }
  return (wins + ties / 2) / draws.length;
}

/**
 * Simulate one joint correlated week over BOTH lineups and compare them.
 * One draw set, not two: a shared game between one of my players and one of
 * theirs must move both at once. Splitting into two calls would silently
 * assume independence.
 */
export function matchupWinProbability(
  mine: WeekSimPlayer[],
  theirs: WeekSimPlayer[],
  p: WeeklyModelParams,
  sims: number,
  seed: number
): number {
  const draws = simulateWeek([...mine, ...theirs], p, sims, seed);
  return winProbability(
    draws,
    mine.map((_, i) => i),
    theirs.map((_, j) => mine.length + j)
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonWinProb.test.ts`
Expected: PASS, 9 tests. The statistical ones carry the controller's pre-computed values in comments; if one fails, print the computed probability and report it rather than widening a tolerance.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/season/lineup.ts tests/seasonWinProb.test.ts
git commit -m "Season: win probability of fixed lineups over one joint correlated draw"
```

---

### Task 4: Start/sit advice ranked by Δ P(win)

**This is the headline feature.** It will sometimes tell you to bench the higher projection, and the reason line has to make that legible rather than mysterious.

**Files:**
- Create: `config/season.json`
- Create: `lib/engine/season/levers.ts`
- Create: `lib/engine/season/advice.ts`
- Test: `tests/seasonLevers.test.ts`
- Test: `tests/seasonAdvice.test.ts`

**Interfaces:**
- Consumes: `bestLineup`, `winProbability`, `Lineup`, `LineupPlayer` (Tasks 2–3); `simulateWeek`, `WeekSimPlayer` from `lib/engine/weekSim.ts`; `gaussian` from `lib/engine/outcome.ts`; `makeRng` from `lib/engine/montecarlo.ts`; `WeekOutlook`; `WeeklyModelParams`.
- Produces:
  - `interface SeasonLevers { forcedPlayThreshold: number; minDeltaWin: number; riskFromPlayoffOdds: number; pointsScale: number }`, `loadSeasonLevers(raw: unknown): SeasonLevers`, `DEFAULT_SEASON_LEVERS`
  - `interface AdvicePlayer { id: string; pos: Position; team: string; outlook: WeekOutlook }`
  - `type Opponent = { kind: "roster"; players: AdvicePlayer[] } | { kind: "total"; projectedTotal: number }`
  - `interface AdviceInput { players: (AdvicePlayer & { name: string })[]; opponent: Opponent; config: LeagueConfig; params: WeeklyModelParams; starterIds?: string[]; leverage?: number | null; levers?: SeasonLevers; sims?: number; seed?: number }`
  - `interface Swap { inId: string; outId: string; inName: string; outName: string; deltaWin: number; deltaPoints: number; reason: string }`
  - `interface ForcedSwap { outId: string; outName: string; why: "bye" | "out" | "no-projection"; bestReplacementId: string | null; bestReplacementName: string | null }`
  - `interface TotalSummary { mean: number; p10: number; p50: number; p90: number }`
  - `interface Advice { winProbability: number; forced: ForcedSwap[]; swaps: Swap[]; lineup: Lineup; recommended: Lineup; recommendedWinProbability: number; myTotal: TotalSummary; oppTotal: TotalSummary }`
  - `startSitAdvice(input: AdviceInput): Advice`
  - `toSimPlayer(p: AdvicePlayer): WeekSimPlayer`

**How it works.** One joint `simulateWeek` over my whole roster plus the opponent's starters. The current lineup is your locked starters when known (Sleeper), else the best lineup on projected points. Every legal single swap (bench in, starter out) is scored against the *same* draws by index, so `deltaWin` is a paired difference. A swap is legal when the new starter set still fills every slot — checked by running `bestLineup` over the set, which is exact and needs no slot-by-slot casework. `recommended` applies the best swap repeatedly while one still clears `minDeltaWin`. When the opponent is only a projected total (manual leagues), their week is drawn as a lognormal with that mean and the same relative spread as my own lineup total, from a separate seeded stream — stated in the UI, never pretended to be a roster.

**Levers.** Three numbers in Task 4 are tuned judgement, not derived, so they live in `config/season.json` with a validated loader, per the standing rule. `riskFromPlayoffOdds` is Task 10's dial and ships OFF (0): the objective is exactly Δ P(win). When it is on and `leverage` (P(playoffs | win) − P(playoffs | lose), from Task 10) is low — clinched or eliminated — the objective blends toward projected points, because a week whose result cannot move your season should be played for points and seeding, not for a coin-flip you no longer need.

- [ ] **Step 1: Write the levers config and its failing test**

```json
// config/season.json
{
  "_doc": "In-season cockpit levers (lib/engine/season/levers.ts validates on load). forcedPlayThreshold: a starter whose P(plays) is at or below this is a must-fix, not a suggestion. minDeltaWin: the smallest move in the objective worth showing as a swap. riskFromPlayoffOdds: 0 = OFF, swaps rank purely by this week's delta P(win); 1 = when this week's result cannot move your playoff odds (leverage 0) rank purely by projected points, blending in between by (1 - leverage). pointsScale: projected points that count as much as a 100% swing in P(win) when blending.",
  "forcedPlayThreshold": 0.1,
  "minDeltaWin": 0.002,
  "riskFromPlayoffOdds": 0,
  "pointsScale": 100
}
```

```ts
// tests/seasonLevers.test.ts
import { describe, it, expect } from "vitest";
import { loadSeasonLevers, DEFAULT_SEASON_LEVERS } from "../lib/engine/season/levers";

const good = { forcedPlayThreshold: 0.1, minDeltaWin: 0.002, riskFromPlayoffOdds: 0, pointsScale: 100 };

describe("loadSeasonLevers", () => {
  it("loads the shipped config, which ships with the risk dial OFF", () => {
    expect(DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds).toBe(0);
    expect(DEFAULT_SEASON_LEVERS.forcedPlayThreshold).toBeGreaterThan(0);
  });

  it("names the field when a lever is out of range", () => {
    expect(() => loadSeasonLevers({ ...good, forcedPlayThreshold: 1 })).toThrow(/forcedPlayThreshold/);
    expect(() => loadSeasonLevers({ ...good, minDeltaWin: -0.1 })).toThrow(/minDeltaWin/);
    expect(() => loadSeasonLevers({ ...good, riskFromPlayoffOdds: 1.5 })).toThrow(/riskFromPlayoffOdds/);
    expect(() => loadSeasonLevers({ ...good, pointsScale: 0 })).toThrow(/pointsScale/);
    expect(() => loadSeasonLevers({ ...good, pointsScale: "100" })).toThrow(/pointsScale/);
  });

  it("rejects a missing object rather than throwing an opaque TypeError", () => {
    expect(() => loadSeasonLevers(null)).toThrow(/season\.json/);
  });
});
```

- [ ] **Step 2: Write the levers loader**

```ts
// lib/engine/season/levers.ts
// Tuned numbers for the in-season cockpit, read from config/season.json and
// validated at import — a bad value fails here, with its name, not as a NaN
// three modules downstream. Same discipline as lib/engine/weekly/model.ts.
import seasonJson from "../../../config/season.json";

export interface SeasonLevers {
  /** A starter with pPlay at or below this is a forced swap. */
  forcedPlayThreshold: number;
  /** Smallest objective move worth listing as a swap. */
  minDeltaWin: number;
  /** 0 = rank by this week's delta P(win) only. See config/season.json. */
  riskFromPlayoffOdds: number;
  /** Projected points equivalent to a 100% swing in P(win) when blending. */
  pointsScale: number;
}

function num(raw: Record<string, unknown>, key: string, lo: number, hi: number, opts: { openLo?: boolean; openHi?: boolean } = {}): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`season.json: ${key} must be a finite number`);
  const aboveLo = opts.openLo ? v > lo : v >= lo;
  const belowHi = opts.openHi ? v < hi : v <= hi;
  if (!aboveLo || !belowHi) {
    throw new Error(`season.json: ${key} must be in ${opts.openLo ? "(" : "["}${lo}, ${hi}${opts.openHi ? ")" : "]"}, got ${v}`);
  }
  return v;
}

export function loadSeasonLevers(raw: unknown): SeasonLevers {
  if (!raw || typeof raw !== "object") throw new Error("season.json: expected an object");
  const r = raw as Record<string, unknown>;
  return {
    forcedPlayThreshold: num(r, "forcedPlayThreshold", 0, 1, { openHi: true }),
    minDeltaWin: num(r, "minDeltaWin", 0, 1, { openHi: true }),
    riskFromPlayoffOdds: num(r, "riskFromPlayoffOdds", 0, 1),
    pointsScale: num(r, "pointsScale", 0, Infinity, { openLo: true }),
  };
}

export const DEFAULT_SEASON_LEVERS: SeasonLevers = loadSeasonLevers(seasonJson);
```

- [ ] **Step 3: Run the levers test**

Run: `pnpm vitest run tests/seasonLevers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 4: Write the failing advice test**

Every statistical expectation below was pre-computed by the controller at the stated seed with this exact algorithm (underdog swap Δwin +0.031; favourite swap +0.024; the wrHigh swap +0.178; the hopeless matchup 0.0005 → 0.003 which is why its opponent is set to 100 a player, not 60).

```ts
// tests/seasonAdvice.test.ts
import { describe, it, expect } from "vitest";
import { startSitAdvice, toSimPlayer, type AdviceInput } from "../lib/engine/season/advice";
import { DEFAULT_SEASON_LEVERS } from "../lib/engine/season/levers";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";
import type { LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 0, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

const ol = (mean: number, over: Partial<WeekOutlook> = {}): WeekOutlook => ({
  playerId: "x", week: 3, opp: "CHI", meanIfPlays: mean, mean, sigma: 0.6,
  p10: mean * 0.4, p50: mean * 0.85, p90: mean * 1.8, pPlay: 1, projected: true,
  stats: {}, drivers: { baseMarket: mean, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: null },
  ...over,
});

// Distinct team per player so draws are independent and the fixtures are checkable.
const me = (id: string, pos: Position, mean: number, over: Partial<WeekOutlook> = {}) =>
  ({ id, pos, team: id.toUpperCase(), name: id, outlook: ol(mean, { playerId: id, opp: "OPP", ...over }) });

const them = (id: string, pos: Position, mean: number) =>
  ({ id, pos, team: id.toUpperCase(), outlook: ol(mean, { playerId: id, opp: "OPP" }) });

const input = (over: Partial<AdviceInput> = {}): AdviceInput => ({
  players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wr", "WR", 11), me("bench", "WR", 10)],
  opponent: { kind: "roster", players: [them("oqb", "QB", 18), them("orb", "RB", 12), them("owr", "WR", 11)] },
  config: cfg, params: DEFAULT_WEEKLY_MODEL, sims: 2000, seed: 5, ...over,
});

describe("startSitAdvice", () => {
  it("reports a win probability, the current lineup and a total summary", () => {
    const a = startSitAdvice(input());
    expect(a.winProbability).toBeGreaterThan(0);
    expect(a.winProbability).toBeLessThan(1);
    expect(a.lineup.starters.map((s) => s.player.id).sort()).toEqual(["qb", "rb", "wr"]);
    expect(a.myTotal.p10).toBeLessThan(a.myTotal.p50);
    expect(a.myTotal.p50).toBeLessThan(a.myTotal.p90);
    expect(a.myTotal.mean).toBeGreaterThan(30); // 41 projected, sampled with mean preserved
    expect(a.oppTotal.mean).toBeGreaterThan(30);
  });

  it("uses my locked starters when given, even if they are not the best on points", () => {
    const a = startSitAdvice(input({ starterIds: ["qb", "rb", "bench"] }));
    expect(a.lineup.starters.map((s) => s.player.id).sort()).toEqual(["bench", "qb", "rb"]);
    expect(a.lineup.benched.map((b) => b.id)).toEqual(["wr"]);
    // And the swap back to the better WR is offered.
    expect(a.swaps[0]).toMatchObject({ inId: "wr", outId: "bench" });
  });

  it("flags a bye as a FORCED swap, not an optional one", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 0, { pPlay: 0, mean: 0, meanIfPlays: 12, opp: null }), me("wr", "WR", 11), me("rb2", "RB", 9)],
      starterIds: ["qb", "rb", "wr"],
    }));
    const forced = a.forced.find((f) => f.outId === "rb");
    expect(forced?.why).toBe("bye");
    expect(forced?.bestReplacementId).toBe("rb2");
  });

  it("flags an Out designation separately from a bye", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 0.24, { pPlay: 0.02, meanIfPlays: 12, drivers: { ...ol(1).drivers, status: "Out" } }), me("wr", "WR", 11), me("rb2", "RB", 9)],
      starterIds: ["qb", "rb", "wr"],
    }));
    expect(a.forced.find((f) => f.outId === "rb")?.why).toBe("out");
  });

  it("flags a player no source projected, never treating him as a zero", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("ghost", "RB", 0, { projected: false, mean: 0, meanIfPlays: 0 }), me("wr", "WR", 11), me("rb2", "RB", 9)],
      starterIds: ["qb", "ghost", "wr"],
    }));
    expect(a.forced.find((f) => f.outId === "ghost")?.why).toBe("no-projection");
  });

  it("does not flag a healthy starter", () => {
    expect(startSitAdvice(input()).forced).toEqual([]);
  });

  it("ranks swaps by delta win probability and reports delta points alongside", () => {
    // Pre-computed: P(win) 0.396 with wrLow, 0.574 with wrHigh.
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wrLow", "WR", 6), me("wrHigh", "WR", 15)],
      starterIds: ["qb", "rb", "wrLow"],
    }));
    const top = a.swaps[0];
    expect(top).toMatchObject({ inId: "wrHigh", outId: "wrLow" });
    expect(top.deltaWin).toBeGreaterThan(0.1);
    expect(top.deltaPoints).toBeCloseTo(9, 6);
    expect(top.reason).toMatch(/\S/);
    // The recommended lineup applies it.
    expect(a.recommended.starters.map((s) => s.player.id)).toContain("wrHigh");
    expect(a.recommendedWinProbability).toBeGreaterThan(a.winProbability);
  });

  it("never offers an illegal swap (a QB into an RB slot)", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wr", "WR", 11), me("qb2", "QB", 30)],
    }));
    expect(a.swaps.find((s) => s.inId === "qb2" && s.outId !== "qb")).toBeUndefined();
  });

  it("on a FLEX config, a bench RB may replace the flexed WR but a bench QB may not", () => {
    // QB1 RB1 WR1 FLEX1 (RB/WR/TE). The LOCKED lineup is qb, rb, wr1 + flex wr2;
    // rb2 (30) and qb2 (40) sit on the bench, so both swaps are on offer.
    const flexCfg: LeagueConfig = { ...cfg, rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 1, K: 0, DST: 0 } };
    const a = startSitAdvice(input({
      config: flexCfg,
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wr1", "WR", 14), me("wr2", "WR", 11), me("rb2", "RB", 30), me("qb2", "QB", 40)],
      starterIds: ["qb", "rb", "wr1", "wr2"],
      opponent: { kind: "roster", players: [them("oqb", "QB", 18), them("orb", "RB", 12), them("owr", "WR", 14), them("owr2", "WR", 11)] },
    }));
    expect(a.lineup.starters).toHaveLength(4);
    expect(a.lineup.starters.map((s) => s.player.id).sort()).toEqual(["qb", "rb", "wr1", "wr2"]);
    // rb2 (30) is legal in place of ANY of rb, wr1 or wr2 (the set still fills 4 slots); qb2 only in place of qb.
    expect(a.swaps.some((s) => s.inId === "rb2" && s.outId === "wr2")).toBe(true);
    expect(a.swaps.find((s) => s.inId === "qb2" && s.outId !== "qb")).toBeUndefined();
    expect(a.recommended.starters.map((s) => s.player.id)).toContain("rb2");
    expect(a.recommended.starters.map((s) => s.player.id)).toContain("qb2");
  });

  it("prefers the CEILING when I am a heavy underdog, even at lower projected points", () => {
    // Pre-computed at seed 5: P(win) 0.0295 with boring, 0.0605 with swingy.
    const boring = me("boring", "WR", 11, { sigma: 0.2, p90: 14 });
    const swingy = me("swingy", "WR", 10, { sigma: 1.3, p90: 34 });
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 10), me("rb", "RB", 8), boring, swingy],
      opponent: { kind: "roster", players: [them("oqb", "QB", 26), them("orb", "RB", 24), them("owr", "WR", 22)] },
    }));
    const swap = a.swaps.find((s) => s.inId === "swingy" && s.outId === "boring");
    expect(swap).toBeDefined();
    expect(swap!.deltaWin).toBeGreaterThan(0.01);
    // The counter-intuitive part: it gains win probability while LOSING points.
    expect(swap!.deltaPoints).toBeLessThan(0);
    expect(swap!.reason).toMatch(/despite/);
  });

  it("prefers the FLOOR when I am a heavy favourite", () => {
    // Pre-computed at seed 5: P(win) 0.962 with swingy, 0.9855 with boring.
    const boring = me("boring", "WR", 11, { sigma: 0.2, p90: 14, p10: 9 });
    const swingy = me("swingy", "WR", 12, { sigma: 1.3, p90: 40, p10: 2 });
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 26), me("rb", "RB", 24), swingy, boring],
      opponent: { kind: "roster", players: [them("oqb", "QB", 8), them("orb", "RB", 7), them("owr", "WR", 6)] },
    }));
    const swap = a.swaps.find((s) => s.inId === "boring" && s.outId === "swingy");
    expect(swap).toBeDefined();
    expect(swap!.deltaWin).toBeGreaterThan(0.01);
    expect(swap!.reason).toMatch(/floor/);
  });

  it("models a manual opponent as a projected total and lands near 0.5 when evenly matched", () => {
    // Pre-computed: my lineup mean 41.3, P(win vs a 41-point total) 0.505.
    const a = startSitAdvice(input({ opponent: { kind: "total", projectedTotal: 41 } }));
    expect(a.winProbability).toBeGreaterThan(0.45);
    expect(a.winProbability).toBeLessThan(0.55);
    // Sample mean of 2000 lognormal draws: SE about 0.36, so a 3-point band.
    expect(a.oppTotal.mean).toBeGreaterThan(38);
    expect(a.oppTotal.mean).toBeLessThan(44);
    expect(a.oppTotal.p10).toBeLessThan(a.oppTotal.p90);
  });

  it("is deterministic for a given seed", () => {
    expect(JSON.stringify(startSitAdvice(input()))).toBe(JSON.stringify(startSitAdvice(input())));
  });

  describe("risk dial (riskFromPlayoffOdds)", () => {
    // A matchup nobody could win: three 100-point opponents. Every swap has
    // delta P(win) of exactly 0, so under the OFF state there is nothing to say.
    const hopeless = (over: Partial<AdviceInput> = {}) => input({
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wrLow", "WR", 6), me("wrHigh", "WR", 15)],
      starterIds: ["qb", "rb", "wrLow"],
      opponent: { kind: "roster", players: [them("oqb", "QB", 100), them("orb", "RB", 100), them("owr", "WR", 100)] },
      ...over,
    });

    it("OFF state: ranks purely by delta P(win), so a hopeless week yields no swaps", () => {
      const a = startSitAdvice(hopeless());
      expect(a.winProbability).toBe(0);
      expect(a.swaps).toEqual([]);
    });

    it("OFF state ignores leverage entirely", () => {
      const off = startSitAdvice(hopeless({ leverage: 0 }));
      expect(JSON.stringify(off)).toBe(JSON.stringify(startSitAdvice(hopeless())));
    });

    it("ON with zero leverage (this week cannot change my season): plays for points", () => {
      const a = startSitAdvice(hopeless({ levers: { ...DEFAULT_SEASON_LEVERS, riskFromPlayoffOdds: 1 }, leverage: 0 }));
      expect(a.swaps[0]).toMatchObject({ inId: "wrHigh", outId: "wrLow", deltaWin: 0 });
      expect(a.swaps[0].deltaPoints).toBeCloseTo(9, 6);
      expect(a.swaps[0].reason).toMatch(/playoff/);
    });

    it("ON with full leverage is identical to OFF", () => {
      const on = startSitAdvice(hopeless({ levers: { ...DEFAULT_SEASON_LEVERS, riskFromPlayoffOdds: 1 }, leverage: 1 }));
      expect(JSON.stringify(on)).toBe(JSON.stringify(startSitAdvice(hopeless())));
    });
  });
});

describe("toSimPlayer", () => {
  it("builds a stable game key shared by both teams in a game", () => {
    const a = toSimPlayer({ id: "1", pos: "WR", team: "DET", outlook: ol(12, { opp: "CHI" }) });
    const b = toSimPlayer({ id: "2", pos: "WR", team: "CHI", outlook: ol(12, { opp: "DET" }) });
    expect(a.gameId).toBe(b.gameId);
  });

  it("carries a bye through as unplayable rather than as a missing game", () => {
    const s = toSimPlayer({ id: "1", pos: "WR", team: "DET", outlook: ol(0, { opp: null, pPlay: 0 }) });
    expect(s.pPlay).toBe(0);
    expect(s.gameId).toBe("DET-BYE");
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonAdvice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Write the module**

```ts
// lib/engine/season/advice.ts
// Start/sit advice ranked by the probability you win THIS matchup. Pure.
//
// Expected points is the wrong objective in a head-to-head league, and it is
// what every free tool optimises. If you are a 19-point underdog the correct
// play is the volatile flier whose ceiling is your only path, even though he
// projects lower; if you are a 25-point favourite the correct play is the
// boring floor. Same roster, same week, opposite advice — and it falls
// directly out of the correlated sampler.
//
// Mechanics: ONE joint simulateWeek over my roster and the opponent's
// starters, then every candidate lineup is scored against those same draws by
// index. Paired comparisons, so 2,000 sims resolve swap deltas of a fraction
// of a percent.
import type { LeagueConfig, Position } from "../../types";
import type { WeekOutlook } from "../weekly/outlook";
import type { WeeklyModelParams } from "../weekly/model";
import { simulateWeek, type WeekSimPlayer } from "../weekSim";
import { gaussian } from "../outcome";
import { makeRng } from "../montecarlo";
import { bestLineup, winProbability, type Lineup, type LineupPlayer } from "./lineup";
import { DEFAULT_SEASON_LEVERS, type SeasonLevers } from "./levers";

export interface AdvicePlayer {
  id: string;
  pos: Position;
  team: string;
  outlook: WeekOutlook;
}

/**
 * Who you are playing. Sleeper gives their starters; a manual league gives a
 * projected total, which is modelled as a lognormal with that mean and the
 * same relative spread as your own lineup total. The UI must say which one it
 * is showing.
 */
export type Opponent =
  | { kind: "roster"; players: AdvicePlayer[] }
  | { kind: "total"; projectedTotal: number };

export interface AdviceInput {
  players: (AdvicePlayer & { name: string })[];
  opponent: Opponent;
  config: LeagueConfig;
  params: WeeklyModelParams;
  /** Your locked starters when the platform knows them. Default: best lineup on projected points. */
  starterIds?: string[];
  /**
   * P(playoffs | win this week) - P(playoffs | lose), from playoffOdds. Only
   * read when levers.riskFromPlayoffOdds > 0. null/undefined = unknown, which
   * is treated as full leverage (this week matters).
   */
  leverage?: number | null;
  levers?: SeasonLevers;
  sims?: number;
  seed?: number;
}

export interface Swap {
  inId: string;
  outId: string;
  inName: string;
  outName: string;
  deltaWin: number;
  deltaPoints: number;
  reason: string;
}

export interface ForcedSwap {
  outId: string;
  outName: string;
  why: "bye" | "out" | "no-projection";
  bestReplacementId: string | null;
  bestReplacementName: string | null;
}

export interface TotalSummary {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface Advice {
  /** With the CURRENT lineup. */
  winProbability: number;
  forced: ForcedSwap[];
  /** Ranked; each is measured against the current lineup. */
  swaps: Swap[];
  lineup: Lineup;
  /** The current lineup with swaps applied greedily while each still clears minDeltaWin. */
  recommended: Lineup;
  recommendedWinProbability: number;
  myTotal: TotalSummary;
  oppTotal: TotalSummary;
}

/**
 * A game key both teams in a matchup share, so the sampler correlates them.
 * Sorted so DET-CHI and CHI-DET are the same game.
 */
export function toSimPlayer(p: AdvicePlayer): WeekSimPlayer {
  const gameId = p.outlook.opp ? [p.team, p.outlook.opp].sort().join("-") : `${p.team}-BYE`;
  return {
    id: p.id,
    pos: p.pos,
    team: p.team,
    gameId,
    opp: p.outlook.opp ?? "",
    meanIfPlays: p.outlook.meanIfPlays,
    sigma: p.outlook.sigma,
    pPlay: p.outlook.pPlay,
    stats: p.outlook.stats,
  };
}

const DEFAULT_SIMS = 2000;
const DEFAULT_SEED = 20260909;
/** Offset for the manual-opponent stream so it never overlaps the player draws. */
const OPP_STREAM_SALT = 424243;
/**
 * Relative spread assumed for a manual opponent's total when my own lineup
 * has none to borrow (every starter out). A lineup total's coefficient of
 * variation is typically 0.3-0.45; this only matters in that degenerate case.
 */
const FALLBACK_TOTAL_CV = 0.35;

function summary(values: Float64Array): TotalSummary {
  const sorted = Float64Array.from(values).sort();
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] ?? 0;
  let s = 0;
  for (const v of values) s += v;
  return { mean: values.length ? s / values.length : 0, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

function reasonFor(swap: { deltaWin: number; deltaPoints: number }, wp: number, inO: WeekOutlook, outO: WeekOutlook): string {
  const pts = swap.deltaPoints;
  const pct = (swap.deltaWin * 100).toFixed(1);
  if (swap.deltaWin <= 0) {
    // Only reachable with the risk dial on: this week cannot move the season.
    return `+${pts.toFixed(1)} projected points — this week's result cannot change your playoff odds, so points and seeding decide`;
  }
  // Order matters: the favourite's floor case usually ALSO costs points (the
  // safe player projects lower), so it must be recognised before the generic
  // "despite the points" branch or a 96% favourite gets told he is behind.
  if (wp > 0.7 && inO.sigma < outO.sigma) {
    const cost = pts < -0.05 ? ` even at ${pts.toFixed(1)} projected points` : "";
    return `+${pct}% to win: you are ahead, so the safer floor (${inO.p10.toFixed(0)} vs ${outO.p10.toFixed(0)}) protects the lead${cost}`;
  }
  if (pts < -0.05) {
    // The counter-intuitive case, which is the whole point of the feature.
    return wp < 0.5
      ? `+${pct}% to win despite ${pts.toFixed(1)} projected points — you are behind, and his ${inO.p90.toFixed(0)}-point ceiling is the path`
      : `+${pct}% to win despite ${pts.toFixed(1)} projected points — his range fits this matchup better than the points cost`;
  }
  return `+${pct}% to win and +${pts.toFixed(1)} projected points`;
}

export function startSitAdvice(input: AdviceInput): Advice {
  const { players, config, params } = input;
  const levers = input.levers ?? DEFAULT_SEASON_LEVERS;
  const sims = input.sims ?? DEFAULT_SIMS;
  const seed = input.seed ?? DEFAULT_SEED;
  const byId = new Map(players.map((p) => [p.id, p] as const));
  const asLineupPlayer = (id: string): LineupPlayer => {
    const p = byId.get(id)!;
    return { id, pos: p.pos, points: p.outlook.mean };
  };

  // --- one joint draw over everyone involved ---------------------------------
  const oppPlayers = input.opponent.kind === "roster" ? input.opponent.players : [];
  const all: WeekSimPlayer[] = [...players.map(toSimPlayer), ...oppPlayers.map(toSimPlayer)];
  const draws = simulateWeek(all, params, sims, seed);
  const index = new Map(players.map((p, i) => [p.id, i] as const));
  const n = all.length;

  // --- current lineup ---------------------------------------------------------
  /** The best assignment over `ids`, with EVERY other roster player on the bench (not just the startable ones). */
  const toLineup = (ids: string[]): Lineup => {
    const l = bestLineup(ids.map(asLineupPlayer), config);
    const started = new Set(l.starters.map((s) => s.player.id));
    return {
      ...l,
      benched: players.filter((p) => !started.has(p.id)).map((p) => asLineupPlayer(p.id))
        .sort((a, b) => b.points - a.points || a.id.localeCompare(b.id)),
    };
  };
  const startable = players.filter((p) => p.outlook.projected && p.outlook.pPlay > 0);
  const lineup = input.starterIds && input.starterIds.length > 0
    ? toLineup(input.starterIds.filter((id) => byId.has(id)))
    // Only players who can score are candidates; the rest are benched.
    : toLineup(startable.map((p) => p.id));
  const currentSet = lineup.starters.map((s) => s.player.id);

  // --- my total per draw for the current lineup, and the opponent's ---------
  const myTotals = new Float64Array(sims);
  for (let s = 0; s < sims; s++) {
    let t = 0;
    for (const id of currentSet) t += draws[s][index.get(id)!];
    myTotals[s] = t;
  }
  const oppTotals = new Float64Array(sims);
  if (input.opponent.kind === "roster") {
    for (let s = 0; s < sims; s++) {
      let t = 0;
      for (let j = players.length; j < n; j++) t += draws[s][j];
      oppTotals[s] = t;
    }
  } else {
    // Lognormal with the requested mean and my lineup's relative spread, from
    // its own seeded stream. Mean-preserving: E[exp(sL z - sL^2/2)] = 1.
    const mine = summary(myTotals);
    let cv = FALLBACK_TOTAL_CV;
    if (mine.mean > 0) {
      let ss = 0;
      for (const v of myTotals) ss += (v - mine.mean) ** 2;
      const sd = Math.sqrt(ss / sims);
      if (sd > 0) cv = sd / mine.mean;
    }
    const sL = Math.sqrt(Math.log(1 + cv * cv));
    const rng = makeRng((seed * 7919 + OPP_STREAM_SALT) >>> 0);
    const total = Math.max(0, input.opponent.projectedTotal);
    for (let s = 0; s < sims; s++) oppTotals[s] = total * Math.exp(sL * gaussian(rng) - (sL * sL) / 2);
  }

  // Append the opponent total as one extra column so every lineup is scored
  // with the same winProbability(draws, mine, theirs) — one code path.
  const rows = draws.map((d, s) => {
    const e = new Float64Array(n + 1);
    e.set(d);
    e[n] = oppTotals[s];
    return e;
  });
  const OPP = [n];
  const wpOf = (ids: string[]) => winProbability(rows, ids.map((id) => index.get(id)!), OPP);
  const meanOf = (ids: string[]) => ids.reduce((s, id) => s + byId.get(id)!.outlook.mean, 0);
  const baseWin = wpOf(currentSet);

  // --- objective: delta P(win), blended toward points only when the dial is on
  const r = levers.riskFromPlayoffOdds;
  const leverage = input.leverage == null ? 1 : Math.min(1, Math.max(0, input.leverage));
  const wPts = r > 0 ? r * (1 - leverage) : 0;
  const objective = (deltaWin: number, deltaPoints: number) =>
    (1 - wPts) * deltaWin + wPts * (deltaPoints / levers.pointsScale);

  /** Every legal single swap out of `set`, scored against the same draws. */
  const swapsFrom = (set: string[], setWin: number) => {
    const out: Swap[] = [];
    const inSet = new Set(set);
    for (const inP of players) {
      if (inSet.has(inP.id) || !inP.outlook.projected || inP.outlook.pPlay <= 0) continue;
      for (const outId of set) {
        const next = set.map((id) => (id === outId ? inP.id : id));
        // Legal iff every player in the new set still gets a slot.
        if (bestLineup(next.map(asLineupPlayer), config).starters.length !== next.length) continue;
        const wp = wpOf(next);
        const deltaWin = wp - setWin;
        const deltaPoints = inP.outlook.mean - byId.get(outId)!.outlook.mean;
        if (objective(deltaWin, deltaPoints) < levers.minDeltaWin) continue;
        const outP = byId.get(outId)!;
        const swap: Swap = { inId: inP.id, outId, inName: inP.name, outName: outP.name, deltaWin, deltaPoints, reason: "" };
        swap.reason = reasonFor(swap, setWin, inP.outlook, outP.outlook);
        out.push(swap);
      }
    }
    out.sort((a, b) => objective(b.deltaWin, b.deltaPoints) - objective(a.deltaWin, a.deltaPoints) || a.inId.localeCompare(b.inId));
    return out;
  };

  const swaps = swapsFrom(currentSet, baseWin);

  // --- recommended: apply the best swap while one still clears the bar ------
  let set = currentSet;
  let setWin = baseWin;
  for (let iter = 0; iter < players.length; iter++) {
    const best = swapsFrom(set, setWin)[0];
    if (!best) break;
    set = set.map((id) => (id === best.outId ? best.inId : id));
    setWin = wpOf(set);
  }
  const recommended = toLineup(set);

  // --- forced swaps: a starter who cannot or is not expected to play ---------
  const forced: ForcedSwap[] = [];
  for (const s of lineup.starters) {
    const p = byId.get(s.player.id);
    if (!p) continue;
    const o = p.outlook;
    let why: ForcedSwap["why"] | null = null;
    if (!o.projected) why = "no-projection";
    else if (o.opp === null) why = "bye";
    else if (o.pPlay <= levers.forcedPlayThreshold) why = "out";
    if (!why) continue;
    // Best available replacement: highest projection among bench players who
    // can play and keep the lineup legal in his place.
    const replacement = lineup.benched
      .map((b) => byId.get(b.id)!)
      .filter((b) => b.outlook.projected && b.outlook.pPlay > levers.forcedPlayThreshold)
      .filter((b) => {
        const next = currentSet.map((id) => (id === p.id ? b.id : id));
        return bestLineup(next.map(asLineupPlayer), config).starters.length === next.length;
      })
      .sort((a, b) => b.outlook.mean - a.outlook.mean || a.id.localeCompare(b.id))[0];
    forced.push({
      outId: p.id,
      outName: p.name,
      why,
      bestReplacementId: replacement?.id ?? null,
      bestReplacementName: replacement?.name ?? null,
    });
  }

  void meanOf;
  return {
    winProbability: baseWin,
    forced,
    swaps,
    lineup,
    recommended,
    recommendedWinProbability: setWin,
    myTotal: summary(myTotals),
    oppTotal: summary(oppTotals),
  };
}
```

**Implementer note:** the `meanOf` helper and its `void` are drafting cruft — delete both rather than transcribing them. If you find anything else unused, delete it and say so in your report.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonAdvice.test.ts tests/seasonLevers.test.ts`
Expected: PASS, 22 tests.

The two most important are `prefers the CEILING when I am a heavy underdog` and `prefers the FLOOR when I am a heavy favourite`. **If either fails, do not adjust its tolerance — report it with the computed numbers.** They are the feature's entire justification, and the controller pre-computed both with this algorithm (deltas +0.031 and +0.024 at seed 5, well above the 0.01 asserted).

- [ ] **Step 8: Commit**

```bash
git add config/season.json lib/engine/season/levers.ts lib/engine/season/advice.ts tests/seasonLevers.test.ts tests/seasonAdvice.test.ts
git commit -m "Season: start/sit ranked by delta win probability against one joint draw, forced swaps first"
```

---

### Task 5: Weekly board loader

**Files:**
- Create: `lib/client/weekBoard.ts`
- Test: `tests/weekBoardClient.test.ts`

**Interfaces:**
- Consumes: `WeekBoard` from `lib/types.ts`.
- Produces: `weekBoardUrl(season: number, week: number, format: ScoringFormat): string`, `fetchWeekBoard(season, week, format): Promise<WeekBoard>`, `indexOutlooks(board: WeekBoard): Map<string, WeekOutlook>`, `currentNflWeek(now: Date, seasonStart: Date): number`

Note the board is a static JSON file, so this mirrors how `app/page.tsx` loads `board-{format}.json`: `cache: "no-cache"` so a mid-week rebuild is picked up, and `public/sw.js` is already network-first for `/data/*`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/weekBoardClient.test.ts
import { describe, it, expect } from "vitest";
import { weekBoardUrl, indexOutlooks, currentNflWeek } from "../lib/client/weekBoard";
import type { WeekBoard } from "../lib/types";

describe("weekBoardUrl", () => {
  it("points at the static per-format file", () => {
    expect(weekBoardUrl(2026, 3, "ppr")).toBe("/data/week-2026-3-ppr.json");
    expect(weekBoardUrl(2026, 12, "half-ppr")).toBe("/data/week-2026-12-half-ppr.json");
  });
});

describe("indexOutlooks", () => {
  it("indexes by player id", () => {
    const board = {
      meta: { season: 2026, week: 3, builtAt: "", lane: "weekly", scoring: "ppr", sources: [], warnings: [] },
      outlooks: [{ playerId: "a" }, { playerId: "b" }],
    } as unknown as WeekBoard;
    const idx = indexOutlooks(board);
    expect(idx.size).toBe(2);
    expect(idx.get("b")?.playerId).toBe("b");
  });
});

describe("currentNflWeek", () => {
  const start = new Date("2026-09-08T00:00:00Z"); // Tuesday before week 1

  it("is week 1 on opening day and mid-week-1", () => {
    expect(currentNflWeek(new Date("2026-09-10T18:00:00Z"), start)).toBe(1);
    expect(currentNflWeek(new Date("2026-09-14T18:00:00Z"), start)).toBe(1);
  });

  it("rolls to week 2 after seven days", () => {
    expect(currentNflWeek(new Date("2026-09-15T18:00:00Z"), start)).toBe(2);
  });

  it("clamps below 1 before the season and at 18 after it", () => {
    expect(currentNflWeek(new Date("2026-08-01T00:00:00Z"), start)).toBe(1);
    expect(currentNflWeek(new Date("2027-03-01T00:00:00Z"), start)).toBe(18);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weekBoardClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/client/weekBoard.ts
// Loads one week's outlooks. The board is a static JSON file per scoring
// format, so this is a plain fetch with no server on the hot path — the same
// shape app/page.tsx uses for board-{format}.json.
import type { ScoringFormat, WeekBoard } from "../types";
import type { WeekOutlook } from "../engine/weekly/outlook";

export function weekBoardUrl(season: number, week: number, format: ScoringFormat): string {
  return `/data/week-${season}-${week}-${format}.json`;
}

export async function fetchWeekBoard(
  season: number,
  week: number,
  format: ScoringFormat
): Promise<WeekBoard> {
  // no-cache, not no-store: the weekly lane rebuilds mid-week and the browser
  // must not serve a stale copy. public/sw.js is already network-first here.
  const res = await fetch(weekBoardUrl(season, week, format), { cache: "no-cache" });
  if (!res.ok) throw new Error(`week board ${season}/${week}/${format}: HTTP ${res.status}`);
  return (await res.json()) as WeekBoard;
}

export function indexOutlooks(board: WeekBoard): Map<string, WeekOutlook> {
  return new Map(board.outlooks.map((o) => [o.playerId, o] as const));
}

/** Weeks are Tuesday-to-Tuesday, so a Tuesday season start makes this a divide. */
export function currentNflWeek(now: Date, seasonStart: Date): number {
  const days = (now.getTime() - seasonStart.getTime()) / 86_400_000;
  return Math.min(18, Math.max(1, Math.floor(days / 7) + 1));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weekBoardClient.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/client/weekBoard.ts tests/weekBoardClient.test.ts
git commit -m "Season: weekly board loader, network-first per format"
```

---

### Task 6: The `/season` route — first usable screen

**This is the task that makes the whole leg visible.** After it, `pnpm dev` and `/season` gives a working start/sit tool with manual roster entry. Everything after adds depth.

**Files:**
- Create: `app/season/page.tsx`
- Create: `components/season/SeasonCockpit.tsx`
- Create: `components/season/LineupTable.tsx`
- Create: `components/season/RosterImport.tsx`
- Modify: `components/Setup.tsx` (add a link to `/season` in the Setup header, beside the existing "Newsroom →" link; `app/page.tsx` renders no header of its own)

**Interfaces:**
- Consumes: `loadTeams`/`saveTeam`/`deleteTeam`/`applyRoster`/`SavedTeam` (Task 1); `fetchWeekBoard`/`indexOutlooks`/`currentNflWeek` (Task 5); `startSitAdvice` (Task 4); `loadConfig` from `lib/client/config.ts`; `Board`, `BoardPlayer` from `lib/types.ts`.
- Produces: the route. No exports other tasks depend on.

**Before writing any of this, read:**
- `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` — this repo's Next version has breaking changes from your training data.
- `components/Cockpit.tsx` and `components/TierBoard.tsx` — match their Tailwind classes, spacing and type scale. Do not invent a new look.
- `app/newsroom/page.tsx` — the closest existing precedent for a secondary route that loads a static JSON board client-side.

- [ ] **Step 1: Write the route shell**

```tsx
// app/season/page.tsx
"use client";

// In-season cockpit. Loads the season board (for names, positions, teams) and
// the weekly board (for projections), then hands off to SeasonCockpit.
// Both are static JSON — no server on the hot path, same as the draft route.

import { useEffect, useState } from "react";
import type { Board, LeagueConfig } from "../../lib/types";
import { loadConfig } from "../../lib/client/config";
import { SCORING_PRESETS } from "../../lib/scoring";
import { fetchWeekBoard, indexOutlooks, currentNflWeek } from "../../lib/client/weekBoard";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import SeasonCockpit from "../../components/season/SeasonCockpit";

const SEASON = 2026;
/** Tuesday before week 1. Kept here rather than in config: it is a calendar fact. */
const SEASON_START = new Date("2026-09-08T00:00:00Z");

export default function SeasonPage() {
  const [config, setConfig] = useState<LeagueConfig | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [outlooks, setOutlooks] = useState<Map<string, WeekOutlook> | null>(null);
  const [week, setWeek] = useState(() => currentNflWeek(new Date(), SEASON_START));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfig(loadConfig() ?? null);
  }, []);

  useEffect(() => {
    const format = config?.scoring ?? "ppr";
    let cancelled = false;
    setError(null);
    Promise.all([
      fetch(`/data/board-${format}.json`, { cache: "no-cache" }).then((r) => r.json() as Promise<Board>),
      fetchWeekBoard(SEASON, week, format),
    ])
      .then(([b, wb]) => {
        if (cancelled) return;
        setBoard(b);
        setOutlooks(indexOutlooks(wb));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [config?.scoring, week]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-6 text-sm">
        <h1 className="text-lg font-semibold">In-season cockpit</h1>
        <p className="mt-4 text-warn">Could not load week {week}: {error}</p>
        <p className="mt-2 text-ink-dim">
          Build it with <code className="rounded bg-panel px-1">pnpm build:week -- --week={week}</code>.
        </p>
      </main>
    );
  }

  if (!board || !outlooks) {
    return <main className="mx-auto max-w-3xl p-6 text-sm text-ink-dim">Loading week {week}…</main>;
  }

  return (
    <SeasonCockpit
      board={board}
      outlooks={outlooks}
      week={week}
      onWeekChange={setWeek}
      config={config ?? { ...defaultConfig, scoring: "ppr" }}
    />
  );
}

/** Used when the user has never run Setup — enough to render a lineup. */
const defaultConfig: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
```

- [ ] **Step 2: Write `RosterImport` — manual entry only for now**

Tasks 7, 8 and 9 each replace one placeholder below with their component, so the tab state lives here from the start rather than being retrofitted. `week` and `config` are passed through for the Sleeper tab.

```tsx
// components/season/RosterImport.tsx
"use client";

import { useMemo, useState } from "react";
import type { Board, LeagueConfig } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";

type Tab = "manual" | "sleeper" | "paste" | "ocr";
const TABS: { id: Tab; label: string }[] = [
  { id: "manual", label: "Manual" }, { id: "sleeper", label: "Sleeper" }, { id: "paste", label: "Paste" }, { id: "ocr", label: "Screen sync" },
];

/**
 * The four ingestion paths live here and every one of them ends in
 * applyRoster, so undo, persistence and the engine all see one kind of roster
 * change — the same discipline as useDraft.applyImport for draft picks.
 */
export default function RosterImport({
  board,
  team,
  week,
  config,
  onChange,
}: {
  board: Board;
  team: SavedTeam;
  week: number;
  config: LeagueConfig;
  onChange: (t: SavedTeam) => void;
}) {
  const [tab, setTab] = useState<Tab>(team.source === "sleeper" ? "sleeper" : "manual");
  const [query, setQuery] = useState("");
  void week; void config; // used by the Sleeper tab from Task 7 on
  const onRoster = useMemo(() => new Set(team.roster.map((r) => r.playerId)), [team.roster]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return board.players
      .filter((p) => p.name.toLowerCase().includes(q) && !onRoster.has(p.id))
      .slice(0, 8);
  }, [query, board.players, onRoster]);

  const add = (id: string) => {
    onChange(applyRoster(team, [...team.roster.map((r) => r.playerId), id], "manual"));
    setQuery("");
  };
  const remove = (id: string) =>
    onChange(applyRoster(team, team.roster.map((r) => r.playerId).filter((x) => x !== id), "manual"));

  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">Your roster</h2>
      <div className="mt-2 flex gap-1 text-xs">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`rounded px-2 py-1 ${tab === t.id ? "bg-panel text-ink" : "text-ink-faint hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "sleeper" && <p className="mt-3 text-xs text-ink-faint">Sleeper sync arrives in Task 7.</p>}
      {tab === "paste" && <p className="mt-3 text-xs text-ink-faint">Paste arrives in Task 8.</p>}
      {tab === "ocr" && <p className="mt-3 text-xs text-ink-faint">Screen sync arrives in Task 9.</p>}

      {tab === "manual" && (<>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Add a player by name…"
        aria-label="Add a player by name"
        className="mt-3 w-full rounded border border-line bg-field px-2 py-1 text-sm"
      />
      {matches.length > 0 && (
        <ul className="mt-1 rounded border border-line text-sm">
          {matches.map((p) => (
            <li key={p.id}>
              <button onClick={() => add(p.id)} className="w-full px-2 py-1 text-left hover:bg-panel">
                {p.name} <span className="text-ink-faint">{p.pos} · {p.team}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      </>)}

      <p className="mt-3 text-xs text-ink-faint">{team.roster.length} players</p>
      <ul className="mt-1 flex flex-wrap gap-1">
        {team.roster.map((r) => {
          const p = board.players.find((x) => x.id === r.playerId);
          return (
            <li key={r.playerId} className="rounded bg-panel px-2 py-0.5 text-xs">
              {p?.name ?? r.playerId}
              <button onClick={() => remove(r.playerId)} className="ml-1 text-ink-faint hover:text-ink" aria-label={`Remove ${p?.name ?? r.playerId}`}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Write `LineupTable`**

The one rule that is not cosmetic: **`projected === false` renders as `—`, never `0.0`.** A player nobody projected, a player on a bye, and a player ruled out all have `mean: 0` and are completely different facts.

```tsx
// components/season/LineupTable.tsx
"use client";

import type { BoardPlayer } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import type { Lineup } from "../../lib/engine/season/lineup";
import { DEFAULT_SEASON_LEVERS } from "../../lib/engine/season/levers";

/**
 * A projection cell. Never shows 0.0 for "we have no number". The forced-play
 * threshold is the engine's lever (config/season.json), not a literal here, so
 * the Must-fix panel and this cell can never disagree about who is out.
 */
function Points({ o }: { o: WeekOutlook | undefined }) {
  if (!o || !o.projected) return <span className="text-ink-faint" title="No source projected this player">—</span>;
  if (o.opp === null) return <span className="text-warn" title="On a bye">BYE</span>;
  if (o.pPlay <= DEFAULT_SEASON_LEVERS.forcedPlayThreshold) {
    const label = o.drivers.status ?? "OUT";
    return <span className="text-warn" title={label}>{label}</span>;
  }
  return <span>{o.mean.toFixed(1)}</span>;
}

export default function LineupTable({
  lineup,
  players,
  outlooks,
}: {
  lineup: Lineup;
  players: Map<string, BoardPlayer>;
  outlooks: Map<string, WeekOutlook>;
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
        <td className="py-1 pr-2 text-right tabular-nums"><Points o={o} /></td>
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
```

- [ ] **Step 4: Write `SeasonCockpit`**

```tsx
// components/season/SeasonCockpit.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import type { Board, BoardPlayer, LeagueConfig } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { DEFAULT_WEEKLY_MODEL } from "../../lib/engine/weekly/model";
import { startSitAdvice } from "../../lib/engine/season/advice";
import { bestLineup } from "../../lib/engine/season/lineup";
import { loadTeams, saveTeam, type SavedTeam } from "../../lib/client/teams";
import LineupTable from "./LineupTable";
import RosterImport from "./RosterImport";

export default function SeasonCockpit({
  board, outlooks, week, onWeekChange, config,
}: {
  board: Board;
  outlooks: Map<string, WeekOutlook>;
  week: number;
  onWeekChange: (w: number) => void;
  config: LeagueConfig;
}) {
  const [team, setTeam] = useState<SavedTeam | null>(null);

  // One-time hydration from localStorage; a team is created on first visit.
  useEffect(() => {
    const all = loadTeams();
    setTeam(
      all[0] ?? {
        id: `t-${Date.now()}`, name: "My team", config, source: "manual",
        roster: [], savedAt: new Date().toISOString(),
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time hydration
  }, []);

  const update = (t: SavedTeam) => {
    const stamped = { ...t, savedAt: new Date().toISOString() };
    setTeam(stamped);
    saveTeam(stamped);
  };

  const byId = useMemo(() => new Map(board.players.map((p) => [p.id, p] as const)), [board.players]);

  const advice = useMemo(() => {
    if (!team || team.roster.length === 0) return null;
    const players = team.roster
      .map((r) => {
        const p = byId.get(r.playerId);
        const o = outlooks.get(r.playerId);
        return p && o ? { id: p.id, pos: p.pos, team: p.team, name: p.name, outlook: o } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (players.length === 0) return null;
    // No opponent roster yet — Task 7 supplies one from Sleeper and Task 13
    // wires it. Until then the opponent is modelled as a projected total equal
    // to my own best lineup (an even matchup), and the UI says so rather than
    // pretending the win probability is precise.
    const startable = players.filter((p) => p.outlook.projected && p.outlook.pPlay > 0);
    const myProjected = bestLineup(startable.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), team.config).total;
    const starterIds = team.roster.filter((r) => r.slot === "starter").map((r) => r.playerId);
    return startSitAdvice({
      players,
      opponent: { kind: "total", projectedTotal: myProjected },
      config: team.config,
      params: DEFAULT_WEEKLY_MODEL,
      starterIds: starterIds.length ? starterIds : undefined,
    });
  }, [team, byId, outlooks]);

  if (!team) return <main className="p-6 text-sm text-ink-dim">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">In-season cockpit</h1>
        <label className="text-xs text-ink-dim">
          Week{" "}
          <select
            value={week}
            onChange={(e) => onWeekChange(Number(e.target.value))}
            className="rounded border border-line bg-field px-1 py-0.5"
          >
            {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </label>
      </header>

      <RosterImport board={board} team={team} week={week} config={config} onChange={update} />

      {advice && (
        <>
          {advice.forced.length > 0 && (
            <section className="rounded-lg border border-qb/60 bg-qb/10 p-4">
              <h2 className="text-sm font-semibold text-qb">Must fix</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {advice.forced.map((f) => (
                  <li key={f.outId}>
                    <strong>{f.outName}</strong>{" "}
                    <span className="text-ink-dim">
                      {f.why === "bye" ? "is on a bye" : f.why === "out" ? "is not expected to play" : "has no projection from any source"}
                    </span>
                    {f.bestReplacementName && <> — start <strong>{f.bestReplacementName}</strong> instead</>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-lg border border-line p-4">
            <h2 className="text-sm font-semibold">Lineup</h2>
            <div className="mt-2">
              <LineupTable lineup={advice.lineup} players={byId} outlooks={outlooks} />
            </div>
          </section>

          <section className="rounded-lg border border-line p-4">
            <h2 className="text-sm font-semibold">Swaps worth making</h2>
            {advice.swaps.length === 0 ? (
              <p className="mt-2 text-sm text-ink-dim">Your lineup is already the best of what you have.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {advice.swaps.slice(0, 6).map((s) => (
                  <li key={`${s.inId}-${s.outId}`}>
                    Start <strong>{s.inName}</strong> over <strong>{s.outName}</strong>
                    <span className="text-ink-dim"> — {s.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-faint">
              Ranked by how much each swap moves your chance of winning this matchup, not by projected points.
              No opponent roster is loaded yet, so the opponent is modelled as a projected total equal to your own lineup — an even matchup. Win probability right now: {(advice.winProbability * 100).toFixed(0)}%.
            </p>
          </section>
        </>
      )}

      {!advice && (
        <p className="text-sm text-ink-dim">Add a few players above to see your lineup and swap advice.</p>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Link it from the draft route**

In `app/page.tsx`, add a link to `/season` in whatever header or nav the Setup screen renders. Read the file first and match its existing markup rather than bolting on a new bar. Use `next/link`.

- [ ] **Step 6: Verify it actually runs**

```bash
pnpm build:week -- --week=1   # if week-2026-1-*.json is missing
pnpm dev
```

Open `/season`. Add six or seven real players by name. Confirm:
- the lineup fills dedicated slots and the flex sensibly;
- a player on a bye shows `BYE`, not `0.0`;
- a player with no projection shows `—`, not `0.0`;
- swap suggestions appear with a readable reason and the win probability reads close to 50% (the opponent defaults to your own projection);
- reloading the page keeps your roster (localStorage).

**Report what you see, including a screenshot description or the actual rendered numbers for two or three players.** If a projection looks wrong, say so — the engine's numbers have only ever been checked in JSON.

- [ ] **Step 7: Full checks and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add app/season components/season app/page.tsx
git commit -m "Season: /season route with manual roster, lineup and swap advice"
```

---

### Task 7: Sleeper league sync

Sleeper's league API is free and keyless and gives everything the manual paths cannot: your roster with locked starters, your weekly opponent and *their* starters, every other roster (the free-agent pool is the board minus all of them), real records and the playoff format. This task is the parsers (pure, fixture-tested against a real public league), the fetchers, and the Sleeper tab in `RosterImport`.

**The user's own league is `platform: "manual"` with no league id**, so this cannot be smoke-tested against their league. Sleeper's own docs cite league `289646328504385536` (a completed 2018 league) and it is publicly readable; the controller verified every shape below against it on 2026-09-09. Its JSON becomes the fixture.

**Files:**
- Create: `lib/season/sleeperLeague.ts`
- Create: `components/season/SleeperSync.tsx`
- Create: `tests/fixtures/sleeper-league/league.json`, `rosters.json`, `matchups-1.json`, `users.json`
- Modify: `components/season/RosterImport.tsx` (the Sleeper tab)
- Modify: `lib/client/teams.ts` (add `LeagueSnapshot`; see Interfaces)
- Test: `tests/sleeperLeague.test.ts`

**Interfaces:**
- Consumes: `SavedTeam`, `RosterEntry`, `applyRoster` (Task 1); `LeagueConfig`, `RosterSlots`, `Position`, `ScoringFormat` from `lib/types.ts`.
- Produces:
  - In `lib/client/teams.ts`: `interface LeagueRosterSnapshot { rosterId: number; name: string; players: string[]; starters: string[]; wins: number; losses: number; ties: number; pointsFor: number }` and `interface LeagueSnapshot { rosters: LeagueRosterSnapshot[]; playoffTeams: number; playoffWeekStart: number; schedule: Record<number, [number, number][]>; syncedAt: string }`; `SavedTeam.league?: LeagueSnapshot`.
  - `interface SleeperLeagueInfo { leagueId: string; name: string; season: number; status: string; teams: number; playoffTeams: number; playoffWeekStart: number; rosterPositions: string[]; scoringSettings: Record<string, number> }`
  - `interface SleeperRoster { rosterId: number; ownerId: string | null; players: string[]; starters: string[]; reserve: string[]; wins: number; losses: number; ties: number; pointsFor: number }`
  - `interface SleeperMatchup { rosterId: number; matchupId: number | null; points: number; starters: string[] }`
  - `interface SleeperUser { userId: string; displayName: string; teamName: string | null }`
  - `parseLeague(raw: unknown): SleeperLeagueInfo`, `parseRosters(raw: unknown): SleeperRoster[]`, `parseMatchups(raw: unknown): SleeperMatchup[]`, `parseUsers(raw: unknown): SleeperUser[]`
  - `rosterSlotsFromPositions(positions: string[]): { rosterSlots: RosterSlots; flexEligible: Position[] }`
  - `formatFromScoring(scoring: Record<string, number>, positions: string[]): ScoringFormat`
  - `opponentOf(matchups: SleeperMatchup[], rosterId: number): SleeperMatchup | null`
  - `pairings(matchups: SleeperMatchup[]): [number, number][]`
  - `teamNameFor(roster: SleeperRoster, users: SleeperUser[]): string`
  - `parseLeagueId(input: string): string`
  - `teamFromSleeper(args: { league: SleeperLeagueInfo; rosters: SleeperRoster[]; users: SleeperUser[]; myRosterId: number; schedule: Record<number, [number, number][]>; base: LeagueConfig; existing?: SavedTeam; now: string }): SavedTeam`
  - `fetchLeague(leagueId: string): Promise<{ league: SleeperLeagueInfo; rosters: SleeperRoster[]; users: SleeperUser[] }>`, `fetchMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]>`, `fetchSchedule(leagueId: string, fromWeek: number, toWeek: number): Promise<{ schedule: Record<number, [number, number][]>; failedWeeks: number[] }>` (a week Sleeper answered with no pairings is simply absent; a week whose request FAILED is listed in `failedWeeks` so the UI can say so — the two are different facts), `fetchNflState(): Promise<{ season: number; week: number; seasonType: string }>`

Shapes verified live on 2026-09-09 (league `289646328504385536`): `settings.playoff_teams` 6, `settings.playoff_week_start` 14, `settings.num_teams` 12, `roster_positions` `["QB","RB","RB","WR","WR","TE","FLEX","FLEX","DEF","BN",…]`; a roster has `roster_id`, `owner_id`, `players` (15 ids), `starters` (9, the last being `"CLE"` — **Sleeper's DEF id is the team code, exactly this board's DST id**), `reserve` (null when empty), `settings.{wins,losses,ties,fpts,fpts_decimal}` (7/6/0, 1776 + 6/100); a matchup has `roster_id`, `matchup_id` (null for teams idle in a playoff week), `points`, `starters`, `players`; a user has `user_id`, `display_name`, `metadata.team_name` (may be absent). `GET /v1/state/nfl` returned `{"week":1,"season":"2026","season_type":"regular","display_week":1,…}`.

- [ ] **Step 1: Fetch the fixtures**

```bash
mkdir -p tests/fixtures/sleeper-league
L=289646328504385536
curl -s "https://api.sleeper.app/v1/league/$L" > tests/fixtures/sleeper-league/league.json
curl -s "https://api.sleeper.app/v1/league/$L/rosters" > tests/fixtures/sleeper-league/rosters.json
curl -s "https://api.sleeper.app/v1/league/$L/matchups/1" > tests/fixtures/sleeper-league/matchups-1.json
curl -s "https://api.sleeper.app/v1/league/$L/users" > tests/fixtures/sleeper-league/users.json
ls -la tests/fixtures/sleeper-league
```

Expected: four files, each well under 100 KB. If a fetch fails, stop and report — do not hand-write a fixture.

- [ ] **Step 2: Add `LeagueSnapshot` to `lib/client/teams.ts`**

Add these exports next to `SavedTeam`, and the optional field on it:

```ts
/** One roster in the league, as of the last sync. Player ids are board ids. */
export interface LeagueRosterSnapshot {
  rosterId: number;
  name: string;
  players: string[];
  starters: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

/**
 * The whole league as of the last Sleeper sync: every roster (so the
 * free-agent pool is the board minus all of them, and playoff odds can
 * simulate everyone), the playoff format, and the known pairings per
 * remaining week. Absent for manual/paste/OCR teams.
 */
export interface LeagueSnapshot {
  rosters: LeagueRosterSnapshot[];
  playoffTeams: number;
  playoffWeekStart: number;
  /** week -> [rosterId, rosterId] pairs. A week absent here is unknown. */
  schedule: Record<number, [number, number][]>;
  syncedAt: string; // ISO
}
```

and in `SavedTeam`: `league?: LeagueSnapshot;` after `schedule`.

- [ ] **Step 3: Write the failing test**

```ts
// tests/sleeperLeague.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLeague, parseRosters, parseMatchups, parseUsers, rosterSlotsFromPositions, formatFromScoring,
  opponentOf, pairings, teamNameFor, parseLeagueId, teamFromSleeper, type SleeperMatchup,
} from "../lib/season/sleeperLeague";
import type { LeagueConfig } from "../lib/types";

const fx = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "sleeper-league", name), "utf8"));
const league = parseLeague(fx("league.json"));
const rosters = parseRosters(fx("rosters.json"));
const matchups = parseMatchups(fx("matchups-1.json"));
const users = parseUsers(fx("users.json"));

const base: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

describe("parseLeague", () => {
  it("reads the league's name, size and playoff format", () => {
    expect(league.name).toBe("Sleeper Friends League");
    expect(league.season).toBe(2018);
    expect(league.teams).toBe(12);
    expect(league.playoffTeams).toBe(6);
    expect(league.playoffWeekStart).toBe(14);
    expect(league.rosterPositions[0]).toBe("QB");
  });
  it("rejects a payload that is not a league rather than returning zeros", () => {
    expect(() => parseLeague({})).toThrow(/league/i);
    expect(() => parseLeague(null)).toThrow(/league/i);
  });
});

describe("rosterSlotsFromPositions", () => {
  it("counts starting slots and ignores bench, IR and taxi", () => {
    const { rosterSlots, flexEligible } = rosterSlotsFromPositions(league.rosterPositions);
    expect(rosterSlots).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 0, DST: 1 });
    expect(flexEligible).toEqual(["RB", "WR", "TE"]);
  });
  it("makes a SUPER_FLEX a QB-eligible flex", () => {
    const { rosterSlots, flexEligible } = rosterSlotsFromPositions(["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF", "BN"]);
    expect(rosterSlots.FLEX).toBe(2);
    expect(flexEligible).toEqual(["QB", "RB", "WR", "TE"]);
  });
  it("treats REC_FLEX as a WR/TE flex", () => {
    const { rosterSlots, flexEligible } = rosterSlotsFromPositions(["QB", "RB", "WR", "TE", "REC_FLEX", "BN"]);
    expect(rosterSlots.FLEX).toBe(1);
    expect(flexEligible).toEqual(["WR", "TE"]);
  });
});

describe("formatFromScoring", () => {
  it("maps rec 1 / 0.5 / 0 to the board formats", () => {
    expect(formatFromScoring({ rec: 1 }, ["QB"])).toBe("ppr");
    expect(formatFromScoring({ rec: 0.5 }, ["QB"])).toBe("half-ppr");
    expect(formatFromScoring({ rec: 0 }, ["QB"])).toBe("standard");
  });
  it("calls a two-QB or superflex league 2qb", () => {
    expect(formatFromScoring({ rec: 1 }, ["QB", "QB", "RB"])).toBe("2qb");
    expect(formatFromScoring({ rec: 1 }, ["QB", "SUPER_FLEX"])).toBe("2qb");
  });
  it("defaults to ppr when rec is missing", () => {
    expect(formatFromScoring({}, ["QB"])).toBe("ppr");
  });
});

describe("parseRosters", () => {
  it("reads every roster with its record and points to two decimals", () => {
    expect(rosters).toHaveLength(12);
    const r1 = rosters.find((r) => r.rosterId === 1)!;
    expect(r1.players).toHaveLength(15);
    expect(r1.starters).toHaveLength(9);
    expect(r1.starters[8]).toBe("CLE"); // DEF ids are team codes, same as the board's DST ids
    expect(r1.reserve).toEqual([]); // null in the payload
    expect(r1).toMatchObject({ wins: 7, losses: 6, ties: 0 });
    expect(r1.pointsFor).toBeCloseTo(1776.06, 6);
  });
  it("drops empty-slot markers from starters", () => {
    const [r] = parseRosters([{ roster_id: 3, owner_id: null, players: ["1"], starters: ["1", "0", ""], reserve: null, settings: {} }]);
    expect(r.starters).toEqual(["1"]);
    expect(r).toMatchObject({ wins: 0, losses: 0, ties: 0, pointsFor: 0 });
  });
});

describe("parseMatchups / opponentOf / pairings", () => {
  it("reads week 1", () => {
    expect(matchups).toHaveLength(12);
    const m1 = matchups.find((m) => m.rosterId === 1)!;
    expect(m1.matchupId).toBe(2);
    expect(m1.points).toBeCloseTo(148.04, 6);
    expect(m1.starters).toHaveLength(9);
  });
  it("finds the opponent as the other roster sharing the matchup id", () => {
    const opp = opponentOf(matchups, 1)!;
    expect(opp.rosterId).not.toBe(1);
    expect(opp.matchupId).toBe(2);
    expect(opponentOf(matchups, 99)).toBeNull();
  });
  it("returns null when the roster is idle (null matchup id)", () => {
    expect(opponentOf([{ rosterId: 1, matchupId: null, points: 0, starters: [] }], 1)).toBeNull();
  });
  it("pairs every matchup id exactly once, lower roster id first", () => {
    const p = pairings(matchups);
    expect(p).toHaveLength(6);
    for (const [a, b] of p) expect(a).toBeLessThan(b);
    expect(new Set(p.flat()).size).toBe(12);
  });
  it("drops a malformed group (one or three rosters on a matchup id) rather than guessing", () => {
    const m = (rosterId: number, matchupId: number | null): SleeperMatchup => ({ rosterId, matchupId, points: 0, starters: [] });
    expect(pairings([m(1, 7)])).toEqual([]);
    expect(pairings([m(1, 7), m(2, 7), m(3, 7), m(4, 8), m(5, 8)])).toEqual([[4, 5]]);
    expect(pairings([m(9, null), m(2, 3), m(1, 3)])).toEqual([[1, 2]]);
  });
});

describe("parseUsers / teamNameFor", () => {
  it("reads users with their team name when set", () => {
    expect(users.length).toBeGreaterThanOrEqual(12);
    const u = users.find((x) => x.userId === "457511950237696")!;
    expect(u.displayName).toBe("2KSports");
    expect(u.teamName).toBe("Giant Dolphins");
  });
  it("names a roster by team name, then display name, then roster id", () => {
    const owned = rosters.find((r) => r.ownerId)!;
    expect(teamNameFor(owned, users)).toMatch(/\S/);
    expect(teamNameFor({ ...owned, ownerId: "nobody" }, users)).toBe(`Roster ${owned.rosterId}`);
    expect(teamNameFor({ ...owned, ownerId: "u" }, [{ userId: "u", displayName: "dan", teamName: null }])).toBe("dan");
  });
});

describe("parseLeagueId", () => {
  it("accepts a bare id or any sleeper URL carrying one", () => {
    expect(parseLeagueId("289646328504385536")).toBe("289646328504385536");
    expect(parseLeagueId("https://sleeper.com/leagues/289646328504385536/team")).toBe("289646328504385536");
    expect(parseLeagueId("  https://sleeper.app/leagues/289646328504385536 ")).toBe("289646328504385536");
  });
});

describe("teamFromSleeper", () => {
  const schedule = { 1: pairings(matchups) };
  const team = teamFromSleeper({ league, rosters, users, myRosterId: 1, schedule, base, now: "2026-09-09T00:00:00.000Z" });

  it("builds a SavedTeam through applyRoster with Sleeper's slots", () => {
    expect(team.source).toBe("sleeper");
    expect(team.sleeper).toEqual({ leagueId: league.leagueId, rosterId: 1 });
    expect(team.roster).toHaveLength(15);
    expect(team.roster.filter((r) => r.slot === "starter")).toHaveLength(9);
    expect(team.roster.find((r) => r.playerId === "CLE")?.slot).toBe("starter");
  });
  it("carries the league's real format, slots and size into the config", () => {
    expect(team.config.platform).toBe("sleeper");
    expect(team.config.leagueId).toBe(league.leagueId);
    expect(team.config.teams).toBe(12);
    expect(team.config.rosterSlots).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 0, DST: 1 });
    expect(team.config.rounds).toBe(15); // roster size, from roster_positions
  });
  it("snapshots every roster, the record, the schedule and the opponent", () => {
    expect(team.record).toEqual({ w: 7, l: 6, t: 0 });
    expect(team.league?.rosters).toHaveLength(12);
    expect(team.league?.playoffTeams).toBe(6);
    expect(team.league?.schedule[1]).toHaveLength(6);
    const opp = opponentOf(matchups, 1)!;
    expect(team.schedule?.[1]?.oppRosterId).toBe(opp.rosterId);
    expect(team.schedule?.[1]?.oppName).toMatch(/\S/);
  });
  it("keeps the existing team's id and name on re-sync", () => {
    const again = teamFromSleeper({ league, rosters, users, myRosterId: 1, schedule, base, now: "2026-09-10T00:00:00.000Z", existing: { ...team, id: "keep", name: "My name" } });
    expect(again.id).toBe("keep");
    expect(again.name).toBe("My name");
    expect(again.savedAt).toBe("2026-09-10T00:00:00.000Z");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run tests/sleeperLeague.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the module**

```ts
// lib/season/sleeperLeague.ts
// Sleeper league sync for the in-season cockpit. Read-only, keyless, free.
//
// Everything that parses is pure and fixture-tested (tests/fixtures/
// sleeper-league/*, a real public league). The fetchers are thin and live at
// the bottom. Browser-safe: no Node imports.
//
// Player ids are Sleeper ids, which are this board's canonical ids; Sleeper's
// DEF ids are team codes ("CLE"), which are this board's DST ids. No crosswalk.
import type { LeagueConfig, Position, RosterSlots, ScoringFormat } from "../types";
import { applyRoster, type LeagueSnapshot, type SavedTeam } from "../client/teams";

const BASE = "https://api.sleeper.app/v1";

export interface SleeperLeagueInfo {
  leagueId: string;
  name: string;
  season: number;
  status: string;
  teams: number;
  playoffTeams: number;
  /** First playoff week; the regular season ends the week before. */
  playoffWeekStart: number;
  rosterPositions: string[];
  scoringSettings: Record<string, number>;
}

export interface SleeperRoster {
  rosterId: number;
  ownerId: string | null;
  players: string[];
  starters: string[];
  reserve: string[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

export interface SleeperMatchup {
  rosterId: number;
  /** Null when this roster has no game that week (idle in the playoffs). */
  matchupId: number | null;
  points: number;
  starters: string[];
}

export interface SleeperUser {
  userId: string;
  displayName: string;
  teamName: string | null;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const num = (v: unknown, def = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : def);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** Sleeper marks an empty lineup slot as "0" or ""; neither is a player. */
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((s) => s && s !== "0") : []);

export function parseLeague(raw: unknown): SleeperLeagueInfo {
  const r = obj(raw);
  const leagueId = r && str(r.league_id);
  if (!r || !leagueId) throw new Error("Sleeper league: payload has no league_id");
  const settings = obj(r.settings) ?? {};
  const positions = Array.isArray(r.roster_positions) ? r.roster_positions.map(String) : [];
  return {
    leagueId,
    name: str(r.name) ?? `League ${leagueId}`,
    season: Number(r.season) || 0,
    status: str(r.status) ?? "unknown",
    teams: num(settings.num_teams, num(r.total_rosters, 12)),
    playoffTeams: num(settings.playoff_teams, 6),
    playoffWeekStart: num(settings.playoff_week_start, 15),
    rosterPositions: positions,
    scoringSettings: (obj(r.scoring_settings) as Record<string, number> | null) ?? {},
  };
}

/** Sleeper's slot names -> our RosterSlots. Bench/IR/taxi are not starting slots. */
export function rosterSlotsFromPositions(positions: string[]): { rosterSlots: RosterSlots; flexEligible: Position[] } {
  const rosterSlots: RosterSlots = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, K: 0, DST: 0 };
  const eligible = new Set<Position>();
  for (const slot of positions) {
    switch (slot) {
      case "QB": case "RB": case "WR": case "TE": case "K":
        rosterSlots[slot]++;
        break;
      case "DEF":
        rosterSlots.DST++;
        break;
      case "FLEX":
        rosterSlots.FLEX++;
        for (const p of ["RB", "WR", "TE"] as Position[]) eligible.add(p);
        break;
      case "SUPER_FLEX":
        rosterSlots.FLEX++;
        for (const p of ["QB", "RB", "WR", "TE"] as Position[]) eligible.add(p);
        break;
      case "REC_FLEX":
        rosterSlots.FLEX++;
        for (const p of ["WR", "TE"] as Position[]) eligible.add(p);
        break;
      case "WRRB_FLEX":
        rosterSlots.FLEX++;
        for (const p of ["RB", "WR"] as Position[]) eligible.add(p);
        break;
      default:
        // BN, IR, TAXI, IDP slots: not a lineup slot this engine models.
        break;
    }
  }
  // The engine has ONE flex kind with one eligibility set, so several flex
  // kinds are unioned. Exact for the common leagues; a league mixing FLEX and
  // REC_FLEX is modelled slightly loose (an RB could fill the REC_FLEX).
  const order: Position[] = ["QB", "RB", "WR", "TE"];
  return { rosterSlots, flexEligible: order.filter((p) => eligible.has(p)) };
}

/** Which of the four board formats this league's scoring is closest to. */
export function formatFromScoring(scoring: Record<string, number>, positions: string[]): ScoringFormat {
  const qbSlots = positions.filter((p) => p === "QB").length + (positions.includes("SUPER_FLEX") ? 1 : 0);
  if (qbSlots >= 2) return "2qb";
  const rec = typeof scoring.rec === "number" ? scoring.rec : 1;
  if (rec >= 0.75) return "ppr";
  if (rec >= 0.25) return "half-ppr";
  return "standard";
}

export function parseRosters(raw: unknown): SleeperRoster[] {
  if (!Array.isArray(raw)) throw new Error("Sleeper rosters: expected an array");
  return raw.map((x) => {
    const r = obj(x) ?? {};
    const s = obj(r.settings) ?? {};
    return {
      rosterId: num(r.roster_id),
      ownerId: str(r.owner_id),
      players: ids(r.players),
      starters: ids(r.starters),
      reserve: ids(r.reserve),
      wins: num(s.wins),
      losses: num(s.losses),
      ties: num(s.ties),
      // Sleeper splits points into an integer and hundredths.
      pointsFor: num(s.fpts) + num(s.fpts_decimal) / 100,
    };
  });
}

export function parseMatchups(raw: unknown): SleeperMatchup[] {
  if (!Array.isArray(raw)) throw new Error("Sleeper matchups: expected an array");
  return raw.map((x) => {
    const m = obj(x) ?? {};
    return {
      rosterId: num(m.roster_id),
      matchupId: typeof m.matchup_id === "number" ? m.matchup_id : null,
      points: num(m.points),
      starters: ids(m.starters),
    };
  });
}

export function parseUsers(raw: unknown): SleeperUser[] {
  if (!Array.isArray(raw)) throw new Error("Sleeper users: expected an array");
  return raw.map((x) => {
    const u = obj(x) ?? {};
    const meta = obj(u.metadata) ?? {};
    return { userId: str(u.user_id) ?? "", displayName: str(u.display_name) ?? "", teamName: str(meta.team_name) };
  });
}

export function opponentOf(matchups: SleeperMatchup[], rosterId: number): SleeperMatchup | null {
  const mine = matchups.find((m) => m.rosterId === rosterId);
  if (!mine || mine.matchupId === null) return null;
  return matchups.find((m) => m.matchupId === mine.matchupId && m.rosterId !== rosterId) ?? null;
}

/** [rosterId, rosterId] per matchup id, lower id first, sorted. Idle rosters are omitted. */
export function pairings(matchups: SleeperMatchup[]): [number, number][] {
  const byId = new Map<number, number[]>();
  for (const m of matchups) {
    if (m.matchupId === null) continue;
    const list = byId.get(m.matchupId) ?? [];
    list.push(m.rosterId);
    byId.set(m.matchupId, list);
  }
  const out: [number, number][] = [];
  for (const list of byId.values()) {
    if (list.length !== 2) continue; // a malformed pairing is dropped, not guessed
    const [a, b] = list.sort((x, y) => x - y);
    out.push([a, b]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

export function teamNameFor(roster: SleeperRoster, users: SleeperUser[]): string {
  const u = roster.ownerId ? users.find((x) => x.userId === roster.ownerId) : undefined;
  return u?.teamName ?? (u?.displayName || `Roster ${roster.rosterId}`);
}

/** A league id from a pasted URL or a bare id. */
export function parseLeagueId(input: string): string {
  const m = input.match(/leagues?\/(\d{6,})/) ?? input.match(/(\d{6,})/);
  return m ? m[1] : input.trim();
}

/**
 * Build (or re-sync) a SavedTeam from a league. Ends in applyRoster, like
 * every other ingestion path, with Sleeper's own starter/IR slots applied.
 */
export function teamFromSleeper(args: {
  league: SleeperLeagueInfo;
  rosters: SleeperRoster[];
  users: SleeperUser[];
  myRosterId: number;
  schedule: Record<number, [number, number][]>;
  base: LeagueConfig;
  existing?: SavedTeam;
  now: string;
}): SavedTeam {
  const { league, rosters, users, myRosterId, schedule, base, existing, now } = args;
  const mine = rosters.find((r) => r.rosterId === myRosterId);
  if (!mine) throw new Error(`Sleeper league ${league.leagueId}: no roster ${myRosterId}`);
  const { rosterSlots, flexEligible } = rosterSlotsFromPositions(league.rosterPositions);
  const config: LeagueConfig = {
    ...base,
    platform: "sleeper",
    leagueId: league.leagueId,
    teams: league.teams,
    // Roster size = every slot including bench; the waiver engine uses it as the cap.
    rounds: league.rosterPositions.filter((p) => p !== "IR" && p !== "TAXI").length || base.rounds,
    scoring: formatFromScoring(league.scoringSettings, league.rosterPositions),
    rosterSlots,
    flexEligible,
  };
  const names = new Map(rosters.map((r) => [r.rosterId, teamNameFor(r, users)] as const));
  const weekly: SavedTeam["schedule"] = {};
  for (const [week, pairs] of Object.entries(schedule)) {
    const pair = pairs.find(([a, b]) => a === myRosterId || b === myRosterId);
    if (!pair) continue;
    const opp = pair[0] === myRosterId ? pair[1] : pair[0];
    weekly[Number(week)] = { oppRosterId: opp, oppName: names.get(opp) };
  }
  const snapshot: LeagueSnapshot = {
    rosters: rosters.map((r) => ({
      rosterId: r.rosterId, name: names.get(r.rosterId) ?? `Roster ${r.rosterId}`,
      players: r.players, starters: r.starters, wins: r.wins, losses: r.losses, ties: r.ties, pointsFor: r.pointsFor,
    })),
    playoffTeams: league.playoffTeams,
    playoffWeekStart: league.playoffWeekStart,
    schedule,
    syncedAt: now,
  };
  const shell: SavedTeam = {
    id: existing?.id ?? `sleeper-${league.leagueId}-${myRosterId}`,
    name: existing?.name ?? `${names.get(myRosterId)} · ${league.name}`,
    config,
    source: "sleeper",
    sleeper: { leagueId: league.leagueId, rosterId: myRosterId },
    roster: existing?.roster ?? [],
    schedule: weekly,
    record: { w: mine.wins, l: mine.losses, t: mine.ties },
    league: snapshot,
    savedAt: now,
  };
  const slots: Record<string, "starter" | "bench" | "ir"> = {};
  for (const id of mine.players) slots[id] = "bench";
  for (const id of mine.starters) slots[id] = "starter";
  for (const id of mine.reserve) slots[id] = "ir";
  return applyRoster(shell, [...mine.players, ...mine.reserve], "sleeper", slots);
}

// ---------------------------------------------------------------------------
// Fetchers. Sleeper sits behind a CDN that happily serves a stale body; the
// cache-buster and no-store are what make a re-sync actually re-sync (same
// lesson as lib/draft/sleeper.ts).
async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}?_=${Date.now()}`, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`Sleeper ${path}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchLeague(leagueId: string): Promise<{ league: SleeperLeagueInfo; rosters: SleeperRoster[]; users: SleeperUser[] }> {
  const [league, rosters, users] = await Promise.all([
    get(`/league/${leagueId}`).then(parseLeague),
    get(`/league/${leagueId}/rosters`).then(parseRosters),
    get(`/league/${leagueId}/users`).then(parseUsers),
  ]);
  return { league, rosters, users };
}

export async function fetchMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]> {
  return parseMatchups(await get(`/league/${leagueId}/matchups/${week}`));
}

/**
 * Pairings for weeks fromWeek..toWeek. Two different absences, kept apart:
 * a week Sleeper answered with no pairings (not published yet) is simply
 * omitted from `schedule`; a week whose REQUEST failed (network, 5xx) is
 * listed in `failedWeeks` so the UI can say the schedule is incomplete
 * rather than quietly treating a transient error as "unpublished".
 */
export async function fetchSchedule(
  leagueId: string,
  fromWeek: number,
  toWeek: number
): Promise<{ schedule: Record<number, [number, number][]>; failedWeeks: number[] }> {
  const weeks: number[] = [];
  for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  const results = await Promise.allSettled(weeks.map((w) => fetchMatchups(leagueId, w)));
  const schedule: Record<number, [number, number][]> = {};
  const failedWeeks: number[] = [];
  weeks.forEach((w, i) => {
    const r = results[i];
    if (r.status === "rejected") {
      failedWeeks.push(w);
      return;
    }
    const p = pairings(r.value);
    if (p.length > 0) schedule[w] = p;
  });
  return { schedule, failedWeeks };
}

export async function fetchNflState(): Promise<{ season: number; week: number; seasonType: string }> {
  const s = obj(await get(`/state/nfl`)) ?? {};
  return { season: Number(s.season) || new Date().getFullYear(), week: num(s.week, 1), seasonType: str(s.season_type) ?? "regular" };
}
```

**`applyRoster` gains a fourth argument** in this task: `slots?: Record<string, RosterEntry["slot"]>`, an override applied after the "preserve existing slot" rule. Edit `lib/client/teams.ts` accordingly:

```ts
export function applyRoster(
  team: SavedTeam,
  ids: string[],
  source: SavedTeam["source"],
  slots?: Record<string, RosterEntry["slot"]>
): SavedTeam {
  const previous = new Map(team.roster.map((r) => [r.playerId, r.slot] as const));
  const seen = new Set<string>();
  const roster: RosterEntry[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    roster.push({ playerId: id, slot: slots?.[id] ?? previous.get(id) ?? "bench" });
  }
  return { ...team, roster, source };
}
```

and add to `tests/teams.test.ts`:

```ts
  it("applyRoster takes explicit slots from a platform that knows them", () => {
    const base = team({ roster: [{ playerId: "1", slot: "bench" }] });
    const t = applyRoster(base, ["1", "2", "3"], "sleeper", { "1": "starter", "3": "ir" });
    expect(t.roster.map((r) => r.slot)).toEqual(["starter", "bench", "ir"]);
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/sleeperLeague.test.ts tests/teams.test.ts`
Expected: PASS — 22 in sleeperLeague, 9 in teams.

- [ ] **Step 7: Write the Sleeper tab**

```tsx
// components/season/SleeperSync.tsx
"use client";

// Sleeper tab of RosterImport: paste a league URL or id, pick which roster is
// yours, sync. Re-sync any time; Sleeper's locked starters and your opponent's
// come along. Ends in applyRoster via teamFromSleeper.

import { useState } from "react";
import type { LeagueConfig } from "../../lib/types";
import type { SavedTeam } from "../../lib/client/teams";
import {
  fetchLeague, fetchSchedule, parseLeagueId, teamNameFor, teamFromSleeper,
  type SleeperLeagueInfo, type SleeperRoster, type SleeperUser,
} from "../../lib/season/sleeperLeague";

export default function SleeperSync({
  team, week, base, onChange,
}: {
  team: SavedTeam;
  week: number;
  base: LeagueConfig;
  onChange: (t: SavedTeam) => void;
}) {
  const [input, setInput] = useState(team.sleeper?.leagueId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ league: SleeperLeagueInfo; rosters: SleeperRoster[]; users: SleeperUser[] } | null>(null);

  async function load() {
    setError(null);
    setBusy("Loading league…");
    try {
      setLoaded(await fetchLeague(parseLeagueId(input)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function sync(rosterId: number) {
    if (!loaded) return;
    setError(null);
    setBusy("Loading schedule…");
    try {
      const { schedule, failedWeeks } = await fetchSchedule(loaded.league.leagueId, week, loaded.league.playoffWeekStart - 1);
      onChange(teamFromSleeper({ ...loaded, myRosterId: rosterId, schedule, base, existing: team.sleeper ? team : undefined, now: new Date().toISOString() }));
      if (failedWeeks.length) setError(`Synced, but the schedule for week${failedWeeks.length === 1 ? "" : "s"} ${failedWeeks.join(", ")} could not be fetched — re-sync later; playoff odds treat those weeks as unknown pairings.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Sleeper league URL or id"
          className="flex-1 rounded border border-line bg-field px-2 py-1"
        />
        <button onClick={load} disabled={!input.trim() || busy !== null} className="rounded bg-panel px-3 py-1 font-semibold text-ink-dim hover:text-ink disabled:opacity-40">
          Load
        </button>
      </div>
      {busy && <p className="text-xs text-ink-faint">{busy}</p>}
      {error && <p className="text-xs text-warn">{error}</p>}
      {loaded && (
        <div>
          <p className="text-xs text-ink-dim">
            {loaded.league.name} · {loaded.league.teams} teams · {loaded.league.playoffTeams} make the playoffs from week {loaded.league.playoffWeekStart}. Which roster is yours?
          </p>
          <ul className="mt-1 grid grid-cols-2 gap-1">
            {loaded.rosters.map((r) => (
              <li key={r.rosterId}>
                <button
                  onClick={() => sync(r.rosterId)}
                  disabled={busy !== null}
                  className={`w-full rounded border px-2 py-1 text-left text-xs hover:bg-panel ${team.sleeper?.rosterId === r.rosterId ? "border-rb" : "border-line"}`}
                >
                  {teamNameFor(r, loaded.users)} <span className="text-ink-faint">{r.wins}-{r.losses}{r.ties ? `-${r.ties}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {team.sleeper && team.league && (
        <p className="text-xs text-ink-faint">
          Synced {new Date(team.league.syncedAt).toLocaleString()} · {team.record?.w}-{team.record?.l}
          {team.schedule?.[week]?.oppName ? ` · week ${week} vs ${team.schedule[week].oppName}` : ` · no week ${week} opponent published yet`}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Wire the tab into `RosterImport`**

In `components/season/RosterImport.tsx` the tab strip from Task 6 already holds a `tab` state. Replace the Sleeper placeholder with `<SleeperSync team={team} week={week} base={config} onChange={onChange} />`, importing it; `RosterImport` already receives `week` and `config` props from Task 6. Nothing else changes.

- [ ] **Step 9: Verify in the browser**

`pnpm dev`, open `/season`, Sleeper tab, paste `289646328504385536`, Load, pick roster 1, sync. The roster (15 players from 2018 — most will show `—`, no projection, since they are not on the 2026 board; that is correct behaviour, not a bug) appears with `CLE` as a starter. Confirm the "Synced … 7-6" line renders. Report what you saw.

- [ ] **Step 10: Full checks and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add lib/season/sleeperLeague.ts components/season/SleeperSync.tsx components/season/RosterImport.tsx lib/client/teams.ts tests/teams.test.ts tests/sleeperLeague.test.ts tests/fixtures/sleeper-league
git commit -m "Season: Sleeper league sync with real-league fixtures"
```

---

### Task 8: Roster paste

Copy your roster page from any site — ESPN, Yahoo, Sleeper, NFL.com — and paste it. Pure parser reusing `lib/draft/nameMatch.ts` (the closed-vocabulary name finder that already handles initials, last-first, accents, suffixes and OCR glyphs) and `findDefense` from `lib/draft/pasteImport.ts`. What is new here is *slots*: a roster page says who is starting, who is on the bench and who is on IR, and the parser reads that from per-line slot labels (`QB`, `BN`, `IR`) or from section headers (`Bench`, `Injured Reserve`).

**Files:**
- Create: `lib/season/rosterPaste.ts`
- Create: `components/season/RosterPaste.tsx`
- Modify: `components/season/RosterImport.tsx` (the Paste tab)
- Test: `tests/rosterPaste.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `buildVocab`, `surnameCounts`, `findPlayers`, `lineHints` from `lib/draft/nameMatch.ts`; `findDefense` from `lib/draft/pasteImport.ts`; `scorePlayers` from `lib/draft/fuzzy.ts`; `RosterEntry` from `lib/client/teams.ts`; `BoardPlayer`.
- Produces:
  - `type RosterSlot = RosterEntry["slot"]`
  - `leadingSlot(line: string): { slot: RosterSlot | null; rest: string }` — a slot label at the start of the RAW line (`QB`, `W/R/T`, `BN`, `IR`), stripped off before tokenizing. Raw, not tokens: `tokenize("BN D. London")` merges `bn`+`d` into `bnd` (its spaced-initials rule), so the label must come off first.
  - `headerSlot(tokens: string[]): RosterSlot | null` — a line that is ONLY a section header.
  - `interface RosterPasteEntry { raw: string; player: BoardPlayer | null; slot: RosterSlot; confidence: "high" | "low"; suggestions: BoardPlayer[] }`
  - `interface RosterPasteResult { entries: RosterPasteEntry[]; ignored: string[]; hasSlots: boolean }`
  - `parseRosterPaste(text: string, players: BoardPlayer[]): RosterPasteResult`

Slot semantics: if the paste carries any slot information (a header or a leading label), lines before the first bench/IR header are starters; if it carries none, every player is `bench` — the engine picks the lineup on projections anyway, and `applyRoster` preserves any slots the user already had. Task 9's OCR reader imports `leadingSlot` and `headerSlot` so the two paths agree.

- [ ] **Step 1: Write the failing test**

All names below exist on the committed `public/data/board-ppr.json` (verified 2026-09-09: Josh Allen BUF, Bijan Robinson ATL, Ja'Marr Chase CIN, Jahmyr Gibbs DET, Puka Nacua LAR, Brock Bowers LV, Jake Bates DET K, Amon-Ra St. Brown DET, Sam LaPorta DET, Drake London ATL, Seattle Defense = id `SEA`).

```ts
// tests/rosterPaste.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRosterPaste, leadingSlot, headerSlot } from "../lib/season/rosterPaste";
import { tokenize } from "../lib/draft/nameMatch";
import type { Board } from "../lib/types";

const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
const players = board.players;
const rows = (text: string) => parseRosterPaste(text, players).entries.map((e) => [e.player?.name ?? null, e.slot]);

describe("slot words", () => {
  it("reads a leading slot label off the raw line and returns the rest", () => {
    expect(leadingSlot("QB Josh Allen")).toEqual({ slot: "starter", rest: "Josh Allen" });
    expect(leadingSlot("FLEX\tPuka Nacua\tLAR")).toEqual({ slot: "starter", rest: "Puka Nacua\tLAR" });
    expect(leadingSlot("W/R/T Puka Nacua").slot).toBe("starter");
    expect(leadingSlot("D/ST Seahawks D/ST").slot).toBe("starter");
    expect(leadingSlot("BN D. London ATL")).toEqual({ slot: "bench", rest: "D. London ATL" });
    expect(leadingSlot("BE Puka Nacua").slot).toBe("bench");
    expect(leadingSlot("Bench Brock Bowers").slot).toBe("bench");
    expect(leadingSlot("IR Josh Allen").slot).toBe("ir");
    expect(leadingSlot("K Jake Bates").slot).toBe("starter");
    expect(leadingSlot("RB1 Bijan Robinson")).toEqual({ slot: "starter", rest: "Bijan Robinson" });
    // A trailing position is not a slot, and an initial is a name, not a kicker slot.
    expect(leadingSlot("Josh Allen QB")).toEqual({ slot: null, rest: "Josh Allen QB" });
    expect(leadingSlot("K. Walker RB SEA")).toEqual({ slot: null, rest: "K. Walker RB SEA" });
  });
  it("recognises a section header and nothing else", () => {
    expect(headerSlot(tokenize("Bench"))).toBe("bench");
    expect(headerSlot(tokenize("Bench (5)"))).toBe("bench");
    expect(headerSlot(tokenize("Injured Reserve"))).toBe("ir");
    expect(headerSlot(tokenize("IR"))).toBe("ir");
    expect(headerSlot(tokenize("Starters"))).toBe("starter");
    expect(headerSlot(tokenize("Bench Brock Bowers"))).toBeNull();
    expect(headerSlot(tokenize("Josh Allen"))).toBeNull();
  });
});

describe("parseRosterPaste", () => {
  it("reads an ESPN-style roster with slot labels, opponents and points", () => {
    const text = `QB\tJosh Allen\tBuf\tvs MIA\t24.1
RB\tBijan Robinson\tAtl\t@ NO\t18.7
WR\tJa'Marr Chase\tCin\tvs CLE\t17.2
FLEX\tJahmyr Gibbs\tDet\tvs CHI\t16.9
K\tJake Bates\tDet\tvs CHI\t8.0
D/ST\tSeahawks D/ST\tSea\t@ SF\t7.5
Bench
BE\tPuka Nacua\tLAR\tvs ARI\t14.2
IR\tBrock Bowers\tLV\t--\t--`;
    expect(rows(text)).toEqual([
      ["Josh Allen", "starter"], ["Bijan Robinson", "starter"], ["Ja'Marr Chase", "starter"], ["Jahmyr Gibbs", "starter"],
      ["Jake Bates", "starter"], ["Seattle Defense", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "ir"],
    ]);
  });

  it("reads a Sleeper-style copy: slot, initial-surname, team, opponent", () => {
    const text = `QB J. Allen BUF vs MIA
RB J. Gibbs DET vs CHI
WR A. St. Brown DET vs CHI
TE S. LaPorta DET vs CHI
BN D. London ATL @ NO`;
    expect(rows(text)).toEqual([
      ["Josh Allen", "starter"], ["Jahmyr Gibbs", "starter"], ["Amon-Ra St. Brown", "starter"], ["Sam LaPorta", "starter"], ["Drake London", "bench"],
    ]);
  });

  it("uses section headers when lines carry no labels", () => {
    const text = `Starters
Josh Allen
Bijan Robinson
Bench
Puka Nacua
Injured Reserve
Brock Bowers`;
    expect(rows(text)).toEqual([["Josh Allen", "starter"], ["Bijan Robinson", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "ir"]]);
    expect(parseRosterPaste(text, players).hasSlots).toBe(true);
  });

  it("with no slot information at all, everyone is bench and hasSlots is false", () => {
    const r = parseRosterPaste(`Josh Allen\nBijan Robinson\nPuka Nacua`, players);
    expect(r.entries.map((e) => e.slot)).toEqual(["bench", "bench", "bench"]);
    expect(r.hasSlots).toBe(false);
  });

  it("ignores totals, headers and empty lines, and reports them", () => {
    const r = parseRosterPaste(`My Team · Week 3\n\nJosh Allen\nTotal 112.4\nProjected 118.0`, players);
    expect(r.entries.map((e) => e.player?.name)).toEqual(["Josh Allen"]);
    expect(r.ignored).toEqual(expect.arrayContaining(["Total 112.4", "Projected 118.0"]));
  });

  it("does not mistake a team code plus one stray word for a name", () => {
    // "atl" is a team code, so "Waivers atl" carries only one name-like word and is ignored, as in lib/draft/pasteImport.ts.
    const r = parseRosterPaste(`Josh Allen\nWaivers atl`, players);
    expect(r.entries.map((e) => e.player?.name)).toEqual(["Josh Allen"]);
    expect(r.ignored).toEqual(["Waivers atl"]);
  });

  it("marks a misspelled but recoverable name low-confidence with the match as a suggestion", () => {
    // Verified against the shared matcher: "Bijon Robinsen" scores 0.78 for Bijan Robinson.
    const r = parseRosterPaste(`Josh Allen\nBijon Robinsen`, players);
    const soft = r.entries[1];
    expect(soft.player?.name).toBe("Bijan Robinson");
    expect(soft.confidence).toBe("low");
    expect(soft.suggestions.map((p) => p.name)).toContain("Bijan Robinson");
  });

  it("keeps an unplaceable two-word name as a low-confidence row so the preview can ask", () => {
    const r = parseRosterPaste(`Josh Allen\nZebulon Quartermaine`, players);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[1].player).toBeNull();
    expect(r.entries[1].confidence).toBe("low");
  });

  it("de-duplicates a player pasted twice", () => {
    expect(rows(`Josh Allen\nJosh Allen`)).toEqual([["Josh Allen", "bench"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/rosterPaste.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/season/rosterPaste.ts
// A pasted roster page -> board players with slots. Pure: text and players
// in, entries out, so the parsing is unit-tested and the component only
// renders a preview. Name matching is lib/draft/nameMatch.ts, shared with the
// draft's paste import and screen sync, so tolerance is identical everywhere.
//
// Formats seen in the wild (all handled):
//   QB  Josh Allen  Buf  vs MIA  24.1        ESPN / Yahoo, slot label first
//   QB J. Allen BUF vs MIA                   Sleeper, initial + surname
//   Starters / Bench / Injured Reserve       section headers, names beneath
//   Seahawks D/ST · SEA DEF                  team defenses
import type { BoardPlayer } from "../types";
import type { RosterEntry } from "../client/teams";
import { buildVocab, findPlayers, lineHints, surnameCounts, teamCodeOf, tokenize, type Vocab } from "../draft/nameMatch";
import { findDefense } from "../draft/pasteImport";
import { scorePlayers } from "../draft/fuzzy";

export type RosterSlot = RosterEntry["slot"];

/** Leading labels that mean "this line is a starter": positions, flex spellings ("W/R/T" -> "wrt"), DST spellings. */
const STARTER_WORDS = new Set(["qb", "rb", "wr", "te", "k", "pk", "dst", "def", "d", "flex", "wrt", "wrtq", "rbwr", "rbwrte", "wrte", "superflex", "sflex", "sf", "op"]);
const BENCH_WORDS = new Set(["bn", "be", "bench", "reserves", "reserve"]);
const IR_WORDS = new Set(["ir"]);
/** Words that sit on roster pages but are never part of a name. */
const NOISE = new Set(["my", "team", "week", "wk", "total", "totals", "projected", "proj", "pts", "points", "opp", "opponent", "status", "owner", "manager", "vs", "at", "bye", "score", "rank", "roster", "lineup", "starters", "bench", "reserve", "reserves", "the", "and"]);

/**
 * A slot label at the start of the RAW line, and the line without it.
 * Raw rather than tokenized on purpose: tokenize()'s spaced-initials rule
 * turns "BN D. London" into ["bnd", "london"], so the label must come off
 * before the tokenizer sees the line. A single letter followed by a period
 * ("K. Walker") is an initial, not the kicker slot.
 */
export function leadingSlot(line: string): { slot: RosterSlot | null; rest: string } {
  // An optional trailing digit accepts numbered labels ("RB1", "WR2").
  const m = line.match(/^\s*([A-Za-z]+(?:\/[A-Za-z]+)*)\d?(\.?)(?=\s|$)\s*/);
  if (!m) return { slot: null, rest: line };
  const word = m[1].replace(/\//g, "").toLowerCase();
  if (m[2] === "." && m[1].length === 1) return { slot: null, rest: line };
  let slot: RosterSlot | null = null;
  if (IR_WORDS.has(word)) slot = "ir";
  else if (BENCH_WORDS.has(word)) slot = "bench";
  else if (STARTER_WORDS.has(word)) slot = "starter";
  if (!slot) return { slot: null, rest: line };
  return { slot, rest: line.slice(m[0].length) };
}

/** A line that is ONLY a section header, e.g. "Bench", "Bench (5)", "Injured Reserve", "Starters". */
export function headerSlot(tokens: string[]): RosterSlot | null {
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  if (words.length === 0 || words.length > 2) return null;
  const joined = words.join(" ");
  if (joined === "bench" || joined === "reserves") return "bench";
  if (joined === "ir" || joined === "injured reserve") return "ir";
  if (joined === "starters" || joined === "starter" || joined === "lineup" || joined === "starting lineup") return "starter";
  return null;
}

export interface RosterPasteEntry {
  raw: string;
  player: BoardPlayer | null;
  slot: RosterSlot;
  /** "high": unambiguous. "low": best guess or unmatched — the preview shows alternatives. */
  confidence: "high" | "low";
  suggestions: BoardPlayer[];
}

export interface RosterPasteResult {
  entries: RosterPasteEntry[];
  /** Lines that named nobody (totals, headers, owner tags). */
  ignored: string[];
  /** True when the paste said anything about slots; false means every entry defaulted to bench. */
  hasSlots: boolean;
}

/** Name-like words on a line: letters, not a slot/team/position code, not page noise, not a number. */
function nameWords(tokens: string[]): string[] {
  return tokens.filter(
    (t) => t.length >= 3 && /[a-z]/.test(t) && !STARTER_WORDS.has(t) && !BENCH_WORDS.has(t) && !NOISE.has(t) && teamCodeOf(t) === null
  );
}

export function parseRosterPaste(text: string, players: BoardPlayer[]): RosterPasteResult {
  const vocab: Vocab[] = buildVocab(players);
  const counts = surnameCounts(players);
  const lines = text.replace(/\r/g, "").replace(/\t/g, "  ").split("\n").map((l) => l.trim()).filter(Boolean);

  const anyHeader = lines.some((l) => headerSlot(tokenize(l)) !== null);
  const anyLabel = lines.some((l) => {
    const { slot, rest } = leadingSlot(l);
    return slot !== null && nameWords(tokenize(rest)).length > 0;
  });
  const hasSlots = anyHeader || anyLabel;
  // With headers, everything above the first bench/IR header is a starter.
  let mode: RosterSlot = hasSlots ? "starter" : "bench";

  const entries: RosterPasteEntry[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const header = headerSlot(tokenize(raw));
    if (header) {
      mode = header;
      continue;
    }
    const lead = leadingSlot(raw);
    const slot = lead.slot ?? mode;
    const body = lead.rest;
    const tokens = tokenize(body);
    const hints = lineHints(tokens, body);
    const found = findPlayers(tokens, vocab, counts, { pos: hints.pos, team: hints.team }, { onTie: "best" });
    const dst = found.length === 0 ? findDefense(body, hints.team, players) : null;

    if (dst) {
      if (!seen.has(dst.id)) {
        seen.add(dst.id);
        entries.push({ raw, player: dst, slot, confidence: "high", suggestions: [] });
      }
      continue;
    }
    if (found.length === 0) {
      const words = nameWords(tokens);
      if (words.length >= 2) {
        entries.push({ raw, player: null, slot, confidence: "low", suggestions: scorePlayers(words.join(" "), players).slice(0, 4).map((s) => s.player) });
      } else {
        ignored.push(raw);
      }
      continue;
    }
    for (const f of found) {
      if (seen.has(f.player.id)) continue;
      seen.add(f.player.id);
      const high = !f.surnameOnly && !f.tie && f.score >= 0.85;
      entries.push({
        raw,
        player: f.player,
        slot,
        confidence: high ? "high" : "low",
        suggestions: high ? [] : [f.player, ...(f.alternatives ?? [])].slice(0, 4),
      });
    }
  }
  return { entries, ignored, hasSlots };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/rosterPaste.test.ts`
Expected: PASS, 11 tests. Every fixture line above was run through the shared matcher on 2026-09-09 (scores 0.96–1.16, no ties). If the Sleeper-style initials case fails on "A. St. Brown" or "S. LaPorta", print `tokenize(line)` and the `findPlayers` result and report — the shared matcher may need a case, and that belongs in `nameMatch.ts` with its own test, not a special case here.

- [ ] **Step 5: Write the Paste tab**

```tsx
// components/season/RosterPaste.tsx
"use client";

// Paste tab of RosterImport: textarea, a preview of what was read (with
// did-you-mean chips for the uncertain rows), one Apply. Ends in applyRoster.

import { useMemo, useState } from "react";
import type { Board, BoardPlayer } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";
import { parseRosterPaste, type RosterSlot } from "../../lib/season/rosterPaste";
import { POS_COLOR } from "../../lib/client/pos";

const SLOT_LABEL: Record<RosterSlot, string> = { starter: "Start", bench: "Bench", ir: "IR" };

export default function RosterPaste({ board, team, onChange }: { board: Board; team: SavedTeam; onChange: (t: SavedTeam) => void }) {
  const [text, setText] = useState("");
  const [overrides, setOverrides] = useState<Record<number, BoardPlayer | null>>({});
  const result = useMemo(() => parseRosterPaste(text, board.players), [text, board.players]);

  const chosen = result.entries.map((e, i) => (i in overrides ? overrides[i] : e.player));
  const ready = chosen.filter((p): p is BoardPlayer => p !== null);

  function apply() {
    const slots: Record<string, RosterSlot> = {};
    result.entries.forEach((e, i) => {
      const p = chosen[i];
      if (p && result.hasSlots) slots[p.id] = e.slot;
    });
    onChange(applyRoster(team, ready.map((p) => p.id), "paste", result.hasSlots ? slots : undefined));
    setText("");
    setOverrides({});
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setOverrides({}); }}
        rows={6}
        placeholder={"Copy your roster page and paste it here.\nAny site works: \"QB  Josh Allen  Buf  vs MIA\", \"BN Puka Nacua\", or a Starters / Bench list."}
        className="w-full rounded border border-line bg-field px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-ink-faint"
      />
      {result.entries.length > 0 && (
        <>
          <ol className="divide-y divide-line rounded border border-line">
            {result.entries.map((e, i) => {
              const p = chosen[i];
              return (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
                  <span className="w-10 shrink-0 font-mono text-[10px] text-ink-faint">{result.hasSlots ? SLOT_LABEL[e.slot] : ""}</span>
                  {p ? (
                    <>
                      <span className="font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>
                      <span className={e.confidence === "low" ? "text-ink-dim" : ""}>{p.name}</span>
                      <span className="font-mono text-[10px] text-ink-faint">{p.team}</span>
                    </>
                  ) : (
                    <span className="text-warn">not recognized</span>
                  )}
                  <span className="ml-auto max-w-[45%] truncate font-mono text-[10px] text-ink-faint" title={e.raw}>{e.raw}</span>
                  {(e.confidence === "low" || !p) && e.suggestions.length > 0 && (
                    <span className="flex basis-full flex-wrap gap-1 pl-12">
                      <span className="font-mono text-[10px] text-ink-faint">did you mean</span>
                      {e.suggestions.map((s) => (
                        <button key={s.id} onClick={() => setOverrides((o) => ({ ...o, [i]: s }))} className={`rounded px-1.5 py-0.5 text-[11px] ${p?.id === s.id ? "bg-panel text-ink" : "bg-field text-ink-dim hover:text-ink"}`}>
                          {s.name} <span style={{ color: POS_COLOR[s.pos] }}>{s.pos}</span>
                        </button>
                      ))}
                      {p && <button onClick={() => setOverrides((o) => ({ ...o, [i]: null }))} className="px-1 text-[11px] text-ink-faint hover:text-warn">none of these</button>}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {result.ignored.length > 0 && <p className="font-mono text-[10px] text-ink-faint">ignored: {result.ignored.slice(0, 6).join(" · ")}{result.ignored.length > 6 ? " …" : ""}</p>}
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-faint">{result.hasSlots ? "Starters and bench read from the paste." : "No slot labels found — the engine will pick the lineup."}</p>
            <button onClick={apply} disabled={ready.length === 0} className="rounded bg-rb px-4 py-2 text-sm font-semibold text-field disabled:opacity-40">
              Replace roster with {ready.length} player{ready.length === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire the tab into `RosterImport`**

Replace the Paste placeholder in `components/season/RosterImport.tsx` with `<RosterPaste board={board} team={team} onChange={onChange} />`, importing it.

- [ ] **Step 7: Verify in the browser**

`pnpm dev`, `/season`, Paste tab, paste the ESPN-style block from the test. Confirm eight rows with the right slots, then Apply; the lineup table should show the six starters in slots and Nacua on the bench. Report the rendered rows.

- [ ] **Step 8: Full checks and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add lib/season/rosterPaste.ts components/season/RosterPaste.tsx components/season/RosterImport.tsx tests/rosterPaste.test.ts
git commit -m "Season: roster paste with slot labels and section headers"
```

---

### Task 9: Roster screen sync (OCR)

Share the tab with your roster page and read it off the screen — for sites whose roster page cannot be copied cleanly. Reuses the draft's OCR machinery wholesale: `matchOcrLines` (glyph repair, closed-vocabulary name finding, ties skipped) from `lib/draft/ocrMatch.ts`, and `startCapture`/`grabFrame`/`getOcrScheduler`/`recognizeLines` from `lib/client/screenCapture.ts`. What is new is small: a roster page is read ONCE (it is static, unlike a draft), and slots come from the same labels and headers Task 8 reads, applied by vertical position.

**Files:**
- Create: `lib/season/rosterOcr.ts`
- Create: `components/season/RosterScreenSync.tsx`
- Modify: `components/season/RosterImport.tsx` (the Screen sync tab)
- Test: `tests/rosterOcr.test.ts`

**Interfaces:**
- Consumes: `matchOcrLines`, `normalizeOcr`, `OcrLine` from `lib/draft/ocrMatch.ts`; `leadingSlot`, `headerSlot`, `RosterSlot` from `lib/season/rosterPaste.ts` (Task 8); `BoardPlayer`; from `lib/client/screenCapture.ts`: `captureSupported`, `startCapture`, `stopCapture`, `grabFrame`, `getOcrScheduler`, `recognizeLines`, `FULL_FRAME`.
- Produces:
  - `interface OcrRosterEntry { player: BoardPlayer; slot: RosterSlot; line: string; score: number; y: number }`
  - `readRosterLines(lines: OcrLine[], players: BoardPlayer[]): { entries: OcrRosterEntry[]; hasSlots: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/rosterOcr.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRosterLines } from "../lib/season/rosterOcr";
import type { OcrLine } from "../lib/draft/ocrMatch";
import type { Board } from "../lib/types";

const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
const players = board.players;
const lines = (...texts: string[]): OcrLine[] => texts.map((text, i) => ({ text, confidence: 80, y: i * 20 }));
const rows = (l: OcrLine[]) => readRosterLines(l, players).entries.map((e) => [e.player.name, e.slot]);

describe("readRosterLines", () => {
  it("reads names in panel order and splits starters from bench at the header", () => {
    const r = readRosterLines(lines("QB Josh Allen BUF", "RB Bijan Rob1nson ATL", "WR JaMarr Chasse CIN", "Bench", "Puka Nacua LAR", "Brock Bowers LV"), players);
    expect(r.hasSlots).toBe(true);
    expect(r.entries.map((e) => [e.player.name, e.slot])).toEqual([
      ["Josh Allen", "starter"], ["Bijan Robinson", "starter"], ["Ja'Marr Chase", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "bench"],
    ]);
  });

  it("honours per-line labels over the section", () => {
    expect(rows(lines("QB Josh Allen", "BN Puka Nacua", "IR Brock Bowers", "WR Ja'Marr Chase"))).toEqual([
      ["Josh Allen", "starter"], ["Puka Nacua", "bench"], ["Brock Bowers", "ir"], ["Ja'Marr Chase", "starter"],
    ]);
  });

  it("with no slot information, everyone is bench", () => {
    const r = readRosterLines(lines("Josh Allen", "Puka Nacua"), players);
    expect(r.hasSlots).toBe(false);
    expect(r.entries.map((e) => e.slot)).toEqual(["bench", "bench"]);
  });

  it("reads a team defense by code and by nickname", () => {
    expect(rows(lines("SEA DEF", "Bench", "Seahawks D/ST"))).toEqual([["Seattle Defense", "starter"]]);
  });

  it("orders by vertical position, not by input order", () => {
    const shuffled: OcrLine[] = [
      { text: "Puka Nacua", confidence: 80, y: 60 },
      { text: "Bench", confidence: 80, y: 40 },
      { text: "Josh Allen", confidence: 80, y: 0 },
    ];
    expect(rows(shuffled)).toEqual([["Josh Allen", "starter"], ["Puka Nacua", "bench"]]);
  });

  it("applies a label-only line to the name line Tesseract split off at the same height", () => {
    // One roster row read as two lines: the Slot column and the Name column.
    const row = (texts: [string, string], y: number): OcrLine[] => texts.map((text) => ({ text, confidence: 80, y }));
    const r = readRosterLines([...row(["Bench", ""], 0).slice(0, 1), ...row(["QB", "Josh Allen"], 20), ...row(["BN", "Puka Nacua"], 40)], players);
    expect(r.entries.map((e) => [e.player.name, e.slot])).toEqual([["Josh Allen", "starter"], ["Puka Nacua", "bench"]]);
    // Input order within a row must not matter.
    const swapped = readRosterLines([...row(["Bench", ""], 0).slice(0, 1), ...row(["Josh Allen", "QB"], 20)], players);
    expect(swapped.entries.map((e) => [e.player.name, e.slot])).toEqual([["Josh Allen", "starter"]]);
  });

  it("skips a tie rather than guessing (the draft's OCR rule)", () => {
    // Two synthetic RBs named Robinson on different teams; a bare surname is ambiguous.
    const twin = (id: string, team: string) => ({ ...players.find((p) => p.pos === "RB")!, id, name: `Sam Robinson`, team });
    const r = readRosterLines(lines("Robinson"), [twin("syn-a", "ATL"), twin("syn-b", "DET")]);
    expect(r.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/rosterOcr.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/season/rosterOcr.ts
// A roster page read off the screen -> board players with slots. Pure: OCR
// lines in, entries out, tested without a camera or a worker. The matching is
// lib/draft/ocrMatch.ts (glyph repair, ties skipped — marking the wrong player
// costs a correction, a missed one costs a re-read). Slot words are shared
// with the paste parser so the two paths never disagree.
import type { BoardPlayer } from "../types";
import { matchOcrLines, normalizeOcr, type OcrLine } from "../draft/ocrMatch";
import { headerSlot, leadingSlot, type RosterSlot } from "./rosterPaste";

export interface OcrRosterEntry {
  player: BoardPlayer;
  slot: RosterSlot;
  line: string;
  score: number;
  y: number;
}

export function readRosterLines(lines: OcrLine[], players: BoardPlayer[]): { entries: OcrRosterEntry[]; hasSlots: boolean } {
  const ordered = [...lines].sort((a, b) => a.y - b.y);
  // Section headers by vertical position: a name below a "Bench" header is a
  // bench player unless its own line says otherwise.
  const headers: { y: number; slot: RosterSlot }[] = [];
  // Tesseract often splits one roster ROW into several "lines" at the same y
  // (a Slot column, a Name column). A line that is ONLY a slot label lends its
  // slot to the name lines at that y. Keyed by y on purpose: label-only lines
  // carry no name, so they cannot collide with a name line here.
  const rowLabel = new Map<number, RosterSlot>();
  let anyLabel = false;
  for (const l of ordered) {
    const h = headerSlot(normalizeOcr(l.text));
    if (h) {
      headers.push({ y: l.y, slot: h });
      continue;
    }
    const { slot, rest } = leadingSlot(l.text);
    if (!slot) continue;
    anyLabel = true;
    if (normalizeOcr(rest).length === 0) rowLabel.set(l.y, slot);
  }
  const hasSlots = headers.length > 0 || anyLabel;
  const sectionAt = (y: number): RosterSlot => {
    let slot: RosterSlot = hasSlots ? "starter" : "bench";
    for (const h of headers) if (h.y <= y) slot = h.slot;
    return slot;
  };

  // Match line by line so each line's OWN label travels with its matches —
  // never keyed by y, where two lines of one row would collide. The label is
  // stripped BEFORE matching: "BN D. London" would otherwise tokenize as
  // ["bnd", "london"] (see leadingSlot). A player read on several lines keeps
  // his best-scoring read, as matchOcrLines does within a frame.
  const best = new Map<string, OcrRosterEntry>();
  for (const l of ordered) {
    if (headerSlot(normalizeOcr(l.text))) continue;
    const { slot: own, rest } = leadingSlot(l.text);
    const { matches } = matchOcrLines([{ ...l, text: rest }], players);
    for (const m of matches) {
      const entry: OcrRosterEntry = {
        player: m.player,
        slot: own ?? rowLabel.get(l.y) ?? sectionAt(l.y),
        line: m.line,
        score: m.score,
        y: l.y,
      };
      const prev = best.get(m.player.id);
      if (!prev || prev.score < entry.score) best.set(m.player.id, entry);
    }
  }
  const entries = [...best.values()].sort((a, b) => a.y - b.y);
  return { entries, hasSlots };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/rosterOcr.test.ts`
Expected: PASS, 7 tests. Each player is kept once at his best-scoring read and the result is sorted by `y`, so "orders by vertical position" is exercised end to end.

- [ ] **Step 5: Write the Screen sync tab**

Read `components/ScreenSync.tsx` first for the capture lifecycle (share → video element → grab → OCR → stop) and copy its status/error handling style. This component is deliberately simpler: one read per click, no region drag, no continuous loop.

```tsx
// components/season/RosterScreenSync.tsx
"use client";

// Screen sync tab of RosterImport: share the tab showing your roster, click
// Read, review, Apply. One frame per click — a roster page is static, so the
// draft's continuous loop and two-frame agreement are unnecessary here. The
// OCR engine (Tesseract.js, browser-only, lazily loaded from its CDN) and the
// frame pipeline are the draft's, unchanged.

import { useEffect, useRef, useState } from "react";
import type { Board } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";
import { readRosterLines, type OcrRosterEntry } from "../../lib/season/rosterOcr";
import { POS_COLOR } from "../../lib/client/pos";
import {
  FULL_FRAME, captureSupported, getOcrScheduler, grabFrame, recognizeLines, startCapture, stopCapture,
} from "../../lib/client/screenCapture";

export default function RosterScreenSync({ board, team, onChange }: { board: Board; team: SavedTeam; onChange: (t: SavedTeam) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<{ entries: OcrRosterEntry[]; hasSlots: boolean; lines: string[] } | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());

  useEffect(() => () => stopCapture(streamRef.current, videoRef.current), []);

  async function share() {
    setError(null);
    if (!captureSupported()) {
      setError("This browser can't share a screen. Chrome, Edge or Safari 17+ on desktop can.");
      return;
    }
    try {
      const stream = await startCapture(videoRef.current!);
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { stopCapture(streamRef.current, videoRef.current); streamRef.current = null; setSharing(false); });
      setSharing(true);
      setStatus("Make the roster fill the shared window, then Read.");
      getOcrScheduler((s, p) => setStatus(`Loading OCR engine… ${s} ${Math.round(p * 100)}%`)).then(
        () => setStatus((cur) => (cur.startsWith("Loading OCR") ? "OCR engine ready. Make the roster fill the shared window, then Read." : cur)),
        (err) => setError(`OCR engine failed to load: ${(err as Error).message}`)
      );
    } catch (err) {
      setError(`Couldn't start sharing: ${(err as Error).message}`);
    }
  }

  async function readOnce() {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    setStatus("Reading…");
    const frame = grabFrame(video, FULL_FRAME);
    if (!frame) { setError("No video frame yet — try again in a second."); return; }
    try {
      const lines = await recognizeLines(await getOcrScheduler(), frame);
      const r = readRosterLines(lines, board.players);
      setRead({ ...r, lines: lines.map((l) => l.text) });
      setDisabled(new Set());
      setStatus(`Read ${r.entries.length} player${r.entries.length === 1 ? "" : "s"} from ${lines.length} lines.`);
    } catch (err) {
      setError(`Read failed: ${(err as Error).message}`);
    }
  }

  function apply() {
    if (!read) return;
    const kept = read.entries.filter((e) => !disabled.has(e.player.id));
    const slots: Record<string, OcrRosterEntry["slot"]> = {};
    if (read.hasSlots) for (const e of kept) slots[e.player.id] = e.slot;
    onChange(applyRoster(team, kept.map((e) => e.player.id), "ocr", read.hasSlots ? slots : undefined));
    setRead(null);
  }

  function stop() {
    stopCapture(streamRef.current, videoRef.current);
    streamRef.current = null;
    setSharing(false);
    setStatus("");
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <video ref={videoRef} className="hidden" playsInline />
      <div className="flex gap-2">
        {!sharing ? (
          <button onClick={share} className="rounded bg-panel px-3 py-1 font-semibold text-ink-dim hover:text-ink">Share screen</button>
        ) : (
          <>
            <button onClick={readOnce} className="rounded bg-rb px-3 py-1 font-semibold text-field">Read</button>
            <button onClick={stop} className="rounded border border-line px-3 py-1 text-ink-dim hover:text-ink">Stop</button>
          </>
        )}
      </div>
      {status && <p className="text-xs text-ink-faint">{status}</p>}
      {error && <p className="text-xs text-warn">{error}</p>}
      {read && (
        <>
          {read.entries.length === 0 ? (
            <p className="text-xs text-ink-dim">No player names recognised. Zoom the page so names are at least 12px tall and read again.</p>
          ) : (
            <ol className="divide-y divide-line rounded border border-line">
              {read.entries.map((e) => (
                <li key={e.player.id} className="flex items-center gap-2 px-2.5 py-1.5">
                  <input
                    type="checkbox"
                    checked={!disabled.has(e.player.id)}
                    onChange={(ev) => setDisabled((prev) => { const n = new Set(prev); if (ev.target.checked) n.delete(e.player.id); else n.add(e.player.id); return n; })}
                    aria-label={`Keep ${e.player.name}`}
                  />
                  <span className="w-10 shrink-0 font-mono text-[10px] text-ink-faint">{read.hasSlots ? e.slot : ""}</span>
                  <span className="font-mono text-[10px]" style={{ color: POS_COLOR[e.player.pos] }}>{e.player.pos}</span>
                  <span>{e.player.name}</span>
                  <span className="ml-auto max-w-[45%] truncate font-mono text-[10px] text-ink-faint" title={e.line}>{e.line}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-faint">{read.hasSlots ? "Starters and bench read from the page." : "No slot labels seen — the engine will pick the lineup."}</p>
            <button onClick={apply} disabled={read.entries.length === 0} className="rounded bg-rb px-4 py-2 text-sm font-semibold text-field disabled:opacity-40">
              Replace roster with {read.entries.filter((e) => !disabled.has(e.player.id)).length} players
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire the tab into `RosterImport`**

Replace the Screen sync placeholder with `<RosterScreenSync board={board} team={team} onChange={onChange} />`. Tesseract is a lazy `import()` inside `getOcrScheduler`, so importing this component costs the page nothing until Share is clicked; do not add a static import of `tesseract.js` anywhere.

- [ ] **Step 7: Verify in the browser**

`pnpm dev`, open `/mock-board` in a second tab is NOT a roster page; instead open `/season`, paste a roster via the Paste tab so the lineup table shows names, then in the Screen sync tab share *that same tab* (Chrome will offer it) and click Read. The reader should recover most of the lineup table's names with their slots from the table's Slot column. Report which names were read, which missed, and the raw lines for any miss.

- [ ] **Step 8: Full checks and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add lib/season/rosterOcr.ts components/season/RosterScreenSync.tsx components/season/RosterImport.tsx tests/rosterOcr.test.ts
git commit -m "Season: roster screen sync, one OCR read with slot sections"
```

---

### Task 10: Playoff odds and the risk dial

Simulate the rest of the regular season for every roster in the league — the league's real pairings where Sleeper publishes them — and report playoff odds, seed distribution, elimination number, and the two conditional numbers the risk dial needs: P(playoffs | I win this week) and P(playoffs | I lose). Their difference is `leverage`, which Task 4's `startSitAdvice` already accepts.

**Which sampler.** Future weeks have no `WeekOutlook` (Leg A builds one week at a time), so remaining weeks are drawn from the season outcome model — `sampleSeason` in `lib/engine/outcome.ts`, the same fitted model the draft engine and `simulateRoom` use. It knows byes, injury status and team correlation. The current week's start/sit stays on Leg A's weekly sampler; the two meet through `leverage`. This is a stated modelling choice, not an oversight, and it is what makes this a background compute rather than a keystroke path.

**Unknown pairings.** Sleeper publishes matchups for future weeks in most leagues; when a week has none, that week is simulated against a uniformly random other team and `scheduleKnownThrough` says so. That is a stated assumption, not fabricated data — the UI shows it.

**Files:**
- Create: `lib/engine/season/playoffOdds.ts`
- Test: `tests/seasonPlayoffOdds.test.ts`

**Interfaces:**
- Consumes: `sampleSeason`, `makeTeamShocks` from `lib/engine/outcome.ts`; `OutcomeParams` from `lib/engine/outcomeModel.ts`; `optimalLineupTotal` from `lib/engine/season.ts` (exact for one flex kind, see Task 2); `makeRng`; `BoardPlayer`, `LeagueConfig`.
- Produces:
  - `interface LeagueTeamInput { rosterId: number; name: string; players: BoardPlayer[]; wins: number; losses: number; ties: number; pointsFor: number }`
  - `interface PlayoffInput { teams: LeagueTeamInput[]; schedule: Record<number, [number, number][]>; currentWeek: number; playoffWeekStart: number; playoffTeams: number; config: LeagueConfig; myRosterId: number; sims?: number; seed?: number; params?: OutcomeParams }`
  - `interface TeamOdds { rosterId: number; name: string; playoffOdds: number; seedDist: number[]; expectedWins: number }`
  - `interface PlayoffOdds { teams: TeamOdds[]; mine: TeamOdds; oddsIfWin: number | null; oddsIfLose: number | null; leverage: number | null; eliminationNumber: number | null; scheduleKnownThrough: number; remainingWeeks: number }`
  - `playoffOdds(input: PlayoffInput): PlayoffOdds`
  - `eliminationNumber(myWins: number, othersWins: number[], remainingWeeks: number, playoffTeams: number): number | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/seasonPlayoffOdds.test.ts
import { describe, it, expect } from "vitest";
import { playoffOdds, eliminationNumber, type LeagueTeamInput } from "../lib/engine/season/playoffOdds";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 4, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 0, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

let n = 0;
const bp = (pos: Position, proj: number, team = "T" + n): BoardPlayer => ({
  id: `p${++n}`, name: `P${n}`, pos, team, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {},
});
/** A roster projected for `strength` points per starter-season. */
const roster = (strength: number): BoardPlayer[] => [bp("QB", strength), bp("RB", strength), bp("WR", strength)];
const team = (rosterId: number, strength: number, w = 0, l = 0): LeagueTeamInput =>
  ({ rosterId, name: `Team ${rosterId}`, players: roster(strength), wins: w, losses: l, ties: 0, pointsFor: w * 100 });

describe("eliminationNumber", () => {
  it("is the wins the last-spot holder needs to lock me out", () => {
    // I am 4-6 with 4 left (max 8). The 2nd-best other team has 7: it needs 2 more to reach 9 > 8.
    expect(eliminationNumber(4, [9, 7, 5], 4, 2)).toBe(2);
  });
  it("is 0 when I am already eliminated", () => {
    expect(eliminationNumber(2, [9, 8], 2, 2)).toBe(0);
  });
  it("is null when I cannot be eliminated (fewer rivals than spots)", () => {
    expect(eliminationNumber(2, [9], 2, 2)).toBeNull();
  });
  it("counts ties as half a win, like the standings", () => {
    // 4-5-1 with 4 left: ceiling 8.5; the last-spot holder has 7 -> needs 2 (7 + 2 = 9 > 8.5).
    expect(eliminationNumber(4.5, [9, 7, 5], 4, 2)).toBe(2);
    // Rival at 7.5 (7-2-1) already above my ceiling of 6 -> eliminated.
    expect(eliminationNumber(4, [7.5, 5], 2, 1)).toBe(0);
  });
});

describe("playoffOdds", () => {
  it("gives equal teams equal odds and one week of full leverage", () => {
    const teams = [team(1, 240), team(2, 240), team(3, 240), team(4, 240)];
    const r = playoffOdds({
      teams, schedule: { 10: [[1, 2], [3, 4]] }, currentWeek: 10, playoffWeekStart: 11, playoffTeams: 2,
      config: cfg, myRosterId: 1, sims: 600, seed: 3,
    });
    expect(r.remainingWeeks).toBe(1);
    expect(r.scheduleKnownThrough).toBe(10);
    for (const t of r.teams) {
      expect(t.playoffOdds).toBeGreaterThan(0.35);
      expect(t.playoffOdds).toBeLessThan(0.65);
      expect(t.seedDist.reduce((a, b) => a + b, 0)).toBeCloseTo(t.playoffOdds, 10);
    }
    // One game decides everything: win and I am in, lose and I am out.
    expect(r.oddsIfWin).toBeCloseTo(1, 6);
    expect(r.oddsIfLose).toBeCloseTo(0, 6);
    expect(r.leverage).toBeCloseTo(1, 6);
  });

  it("reports ADDITIONAL expected wins and passes half-wins to the elimination number", () => {
    // I am 3-1-1 (3.5 win-equivalents), rivals 2-3 with one 3-2; one week left, two spots.
    const teams = [{ ...team(1, 240, 3, 1), ties: 1 }, team(2, 240, 3, 2), team(3, 240, 2, 3), team(4, 240, 2, 3)];
    const r = playoffOdds({ teams, schedule: { 10: [[1, 2], [3, 4]] }, currentWeek: 10, playoffWeekStart: 11, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 300, seed: 2 });
    // Additional wins over one week: between 0 and 1, never the 3.5 already banked.
    expect(r.mine.expectedWins).toBeGreaterThan(0.2);
    expect(r.mine.expectedWins).toBeLessThan(0.8);
    // Ceiling 4.5; the 2nd-best rival without me has 2 wins -> needs floor(4.5 - 2) + 1 = 3, unreachable in one week.
    expect(r.eliminationNumber).toBe(3);
  });

  it("a clinched team has odds 1 and no leverage", () => {
    const teams = [team(1, 240, 10, 0), team(2, 240, 5, 5), team(3, 240, 1, 9), team(4, 240, 1, 9)];
    const r = playoffOdds({ teams, schedule: { 11: [[1, 2], [3, 4]] }, currentWeek: 11, playoffWeekStart: 12, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 300, seed: 1 });
    expect(r.mine.playoffOdds).toBe(1);
    expect(r.leverage).toBe(0);
    // Ceiling 10 + 1 = 11. The rival who would hold the LAST spot without me is the 2nd-best (1 win),
    // so it needs 11 - 1 + 1 = 11 more wins — unreachable in one week. Verified by the controller.
    expect(r.eliminationNumber).toBe(11);
    expect(r.eliminationNumber!).toBeGreaterThan(r.remainingWeeks);
  });

  it("an eliminated team has odds 0 and elimination number 0", () => {
    const teams = [team(1, 240, 0, 10), team(2, 240, 8, 2), team(3, 240, 8, 2), team(4, 240, 5, 5)];
    const r = playoffOdds({ teams, schedule: { 11: [[1, 2], [3, 4]] }, currentWeek: 11, playoffWeekStart: 12, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 300, seed: 1 });
    expect(r.mine.playoffOdds).toBe(0);
    expect(r.eliminationNumber).toBe(0);
    expect(r.leverage).toBe(0);
  });

  it("a stronger roster has better odds over several weeks", () => {
    const teams = [team(1, 320), team(2, 200), team(3, 200), team(4, 200)];
    const r = playoffOdds({ teams, schedule: {}, currentWeek: 8, playoffWeekStart: 14, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 400, seed: 9 });
    expect(r.remainingWeeks).toBe(6);
    expect(r.scheduleKnownThrough).toBe(7); // nothing known: every week is a random opponent
    expect(r.mine.playoffOdds).toBeGreaterThan(0.8);
    expect(r.mine.expectedWins).toBeGreaterThan(3.5);
    // With no known pairing this week, the conditional odds are unknown.
    expect(r.oddsIfWin).toBeNull();
    expect(r.leverage).toBeNull();
  });

  it("is deterministic for a given seed", () => {
    const teams = [team(1, 240), team(2, 220), team(3, 260), team(4, 240)];
    const args = { teams, schedule: { 10: [[1, 2], [3, 4]] as [number, number][] }, currentWeek: 10, playoffWeekStart: 12, playoffTeams: 2, config: cfg, myRosterId: 1, sims: 200, seed: 5 };
    expect(JSON.stringify(playoffOdds(args))).toBe(JSON.stringify(playoffOdds(args)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonPlayoffOdds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/season/playoffOdds.ts
// Rest-of-season simulation for a whole league. Pure and seeded.
//
// Every roster's remaining weeks are drawn from the season outcome model
// (lib/engine/outcome.ts — byes, injury status, skill error, team correlation),
// each week's lineup is the optimal one on that week's draw, and the league's
// real pairings decide who beat whom. Standings are wins, then points for.
//
// Why the season model and not Leg A's weekly sampler: there is no WeekOutlook
// for week W+3. The two meet through `leverage`, which the current week's
// start/sit reads when the risk dial is on.
import type { BoardPlayer, LeagueConfig } from "../../types";
import { makeRng } from "../montecarlo";
import { makeTeamShocks, sampleSeason } from "../outcome";
import { optimalLineupTotal } from "../season";
import type { OutcomeParams } from "../outcomeModel";
import outcomeJson from "../../../config/outcome-model.json";

const DEFAULT_OUTCOME = outcomeJson as OutcomeParams;
const DEFAULT_SIMS = 500;

export interface LeagueTeamInput {
  rosterId: number;
  name: string;
  players: BoardPlayer[];
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

export interface PlayoffInput {
  teams: LeagueTeamInput[];
  /** week -> [rosterId, rosterId] pairs. A week absent here is simulated against a random opponent. */
  schedule: Record<number, [number, number][]>;
  /** First week not yet played. */
  currentWeek: number;
  /** The regular season ends the week before this. */
  playoffWeekStart: number;
  playoffTeams: number;
  config: LeagueConfig;
  myRosterId: number;
  sims?: number;
  seed?: number;
  params?: OutcomeParams;
}

export interface TeamOdds {
  rosterId: number;
  name: string;
  playoffOdds: number;
  /** P(finishing seed k), index 0 = first seed. Sums to playoffOdds. */
  seedDist: number[];
  expectedWins: number;
}

export interface PlayoffOdds {
  teams: TeamOdds[];
  mine: TeamOdds;
  /** P(playoffs | I win this week) / lose. Null when this week's pairing is unknown or a branch never occurred. */
  oddsIfWin: number | null;
  oddsIfLose: number | null;
  /** oddsIfWin - oddsIfLose in [0, 1]; null when unknown. Feeds the start/sit risk dial. */
  leverage: number | null;
  /** Wins the team holding the last spot needs to lock me out; 0 = already out; null = cannot be eliminated. */
  eliminationNumber: number | null;
  /** Last week whose pairings are known; weeks after it used random opponents. currentWeek - 1 when none are. */
  scheduleKnownThrough: number;
  remainingWeeks: number;
}

/**
 * Classic elimination number. My ceiling is myWins + remaining; the team that
 * would hold the LAST playoff spot without me (the playoffTeams-th best rival)
 * eliminates me once its wins exceed that ceiling. Null when there are fewer
 * rivals than spots, because then I am in regardless.
 *
 * Wins are counted as the standings count them — a tie is half a win — so the
 * caller passes `wins + ties / 2`. The rival needs the smallest whole number
 * of wins n with cut + n > ceiling, i.e. floor(ceiling - cut) + 1.
 */
export function eliminationNumber(myWins: number, othersWins: number[], remainingWeeks: number, playoffTeams: number): number | null {
  const sorted = [...othersWins].sort((a, b) => b - a);
  const cut = sorted[playoffTeams - 1];
  if (cut === undefined) return null;
  return Math.max(0, Math.floor(myWins + remainingWeeks - cut) + 1);
}

/** Fisher-Yates on a copy, from the seeded stream. */
function shuffle<T>(xs: T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function playoffOdds(input: PlayoffInput): PlayoffOdds {
  const { teams, schedule, currentWeek, playoffWeekStart, playoffTeams, config, myRosterId } = input;
  const params = input.params ?? DEFAULT_OUTCOME;
  const sims = input.sims ?? DEFAULT_SIMS;
  const seed = input.seed ?? 1;
  const lastWeek = Math.min(playoffWeekStart - 1, params.weeks);
  const weeks: number[] = [];
  for (let w = currentWeek; w <= lastWeek; w++) weeks.push(w);
  const T = teams.length;
  const idxOf = new Map(teams.map((t, i) => [t.rosterId, i] as const));
  const me = idxOf.get(myRosterId);
  if (me === undefined) throw new Error(`playoffOdds: roster ${myRosterId} is not in the league`);

  let knownThrough = currentWeek - 1;
  for (const w of weeks) if (schedule[w]?.length) knownThrough = w; else break;
  const thisWeekKnown = (schedule[currentWeek]?.length ?? 0) > 0 && weeks.length > 0;

  const madeIt = new Array<number>(T).fill(0);
  const seeds = teams.map(() => new Array<number>(playoffTeams).fill(0));
  const winsSum = new Array<number>(T).fill(0);
  let winWeekIn = 0, winWeekN = 0, loseWeekIn = 0, loseWeekN = 0;

  for (let s = 0; s < sims; s++) {
    const rng = makeRng((seed * 7919 + s * 104729) >>> 0);
    const shocks = makeTeamShocks(rng, params.weeks);
    // Every player's remaining weeks, in a shared correlated season.
    const weekly = teams.map((t) => t.players.map((p) => sampleSeason(p, params, rng, shocks).weekly));
    const wins = teams.map((t) => t.wins + t.ties / 2);
    const pts = teams.map((t) => t.pointsFor);
    let myWeekResult: "win" | "lose" | null = null;

    for (const w of weeks) {
      const totals = teams.map((t, i) => optimalLineupTotal(t.players.map((p, k) => ({ pos: p.pos, score: weekly[i][k][w - 1] })), config));
      for (let i = 0; i < T; i++) pts[i] += totals[i];
      let pairs: [number, number][];
      if (schedule[w]?.length) {
        // A pairing naming a roster that is not in `teams` is dropped: nothing
        // honest can be simulated for it, and the caller's snapshot is the
        // source of truth for who is in the league.
        pairs = [];
        for (const [a, b] of schedule[w]) {
          const ia = idxOf.get(a);
          const ib = idxOf.get(b);
          if (ia !== undefined && ib !== undefined) pairs.push([ia, ib]);
        }
      } else {
        // Unknown pairings: a random opponent this week. Stated in scheduleKnownThrough.
        const order = shuffle(teams.map((_, i) => i), rng);
        pairs = [];
        for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
      }
      for (const [a, b] of pairs) {
        if (totals[a] > totals[b]) wins[a] += 1;
        else if (totals[b] > totals[a]) wins[b] += 1;
        else { wins[a] += 0.5; wins[b] += 0.5; }
        if (w === currentWeek && thisWeekKnown && (a === me || b === me)) {
          const mine = a === me ? totals[a] : totals[b];
          const theirs = a === me ? totals[b] : totals[a];
          myWeekResult = mine > theirs ? "win" : mine < theirs ? "lose" : null;
        }
      }
    }

    // Standings: wins, then points for. Deterministic index tiebreak last.
    const order = teams.map((_, i) => i).sort((i, j) => wins[j] - wins[i] || pts[j] - pts[i] || i - j);
    for (let rank = 0; rank < Math.min(playoffTeams, T); rank++) {
      const i = order[rank];
      madeIt[i]++;
      seeds[i][rank]++;
    }
    for (let i = 0; i < T; i++) winsSum[i] += wins[i] - teams[i].wins - teams[i].ties / 2;
    const iAmIn = order.indexOf(me) < playoffTeams ? 1 : 0;
    if (myWeekResult === "win") { winWeekN++; winWeekIn += iAmIn; }
    else if (myWeekResult === "lose") { loseWeekN++; loseWeekIn += iAmIn; }
  }

  const out: TeamOdds[] = teams.map((t, i) => ({
    rosterId: t.rosterId,
    name: t.name,
    playoffOdds: madeIt[i] / sims,
    seedDist: seeds[i].map((c) => c / sims),
    expectedWins: winsSum[i] / sims,
  }));
  const mine = out[me];
  const oddsIfWin = winWeekN > 0 ? winWeekIn / winWeekN : null;
  const oddsIfLose = loseWeekN > 0 ? loseWeekIn / loseWeekN : null;
  let leverage: number | null = null;
  if (mine.playoffOdds === 1 || mine.playoffOdds === 0) leverage = 0; // clinched or eliminated: this week cannot move it
  else if (oddsIfWin !== null && oddsIfLose !== null) leverage = Math.min(1, Math.max(0, oddsIfWin - oddsIfLose));

  return {
    teams: out,
    mine,
    oddsIfWin,
    oddsIfLose,
    leverage,
    eliminationNumber: eliminationNumber(
      teams[me].wins + teams[me].ties / 2,
      teams.filter((_, i) => i !== me).map((t) => t.wins + t.ties / 2),
      weeks.length,
      playoffTeams
    ),
    scheduleKnownThrough: knownThrough,
    remainingWeeks: weeks.length,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonPlayoffOdds.test.ts`
Expected: PASS, 10 tests. The "equal teams" case expects the conditional odds to be exactly 1 and 0: with one week left and two spots for four teams paired 1–2 and 3–4, winning the week guarantees a spot and losing guarantees missing it (a 1-0 record beats every 0-1 record; ties in points are broken by index but a same-record tie cannot occur across the two games since each has exactly one winner). If a value is close but not exact, the standings sort is wrong, not the test.

- [ ] **Step 5: Plausibility check, reported not asserted**

Write a short throwaway script (do not commit it) that builds a 12-team league from the real board — `public/data/board-ppr.json` sorted by ADP, snake-dealt into 12 rosters of 15 — with every record 4-4 at week 9, playoff week 15, 6 spots, no schedule, 500 sims. Report: the spread of playoff odds across teams (should be roughly 0.25–0.75, nobody at 0 or 1), that `seedDist` sums match, and the wall time (this is a background compute; note it if it exceeds ~1.5 s so Task 13 can size its spinner). Ask yourself whether the numbers look like football.

- [ ] **Step 6: Commit**

```bash
git add lib/engine/season/playoffOdds.ts tests/seasonPlayoffOdds.test.ts
git commit -m "Season: playoff odds by rest-of-season simulation, leverage for the risk dial"
```

---

### Task 11: Rest-of-season lineup value, waivers and streaming

Rank available players by the points they add to **your** lineup over the rest of the season — value over what you already have at that slot, the same idea as the draft engine's VONA — rather than by a generic rest-of-season ranking. A third WR who would never crack your lineup scores near zero however good he is in the abstract. Streaming a QB/TE/K/DST is the same function scoped to one position and one week.

**Files:**
- Create: `lib/engine/season/rosValue.ts`
- Create: `lib/engine/season/waivers.ts`
- Test: `tests/seasonRosValue.test.ts`
- Test: `tests/seasonWaivers.test.ts`

**Interfaces:**
- Consumes: `expectedWeekly` from `lib/engine/outcome.ts`; `optimalLineupTotal` from `lib/engine/season.ts`; `SEASON_LONG` from `lib/engine/injuryFeed.ts`; `OutcomeParams`; `WeekOutlook`; `BoardPlayer`, `LeagueConfig`, `Position`.
- Produces (`rosValue.ts`):
  - `DEFAULT_OUTCOME: OutcomeParams` (the shipped `config/outcome-model.json`)
  - `interface RosContext { weeks: number[]; config: LeagueConfig; params?: OutcomeParams; outlooks?: Map<string, WeekOutlook>; currentWeek?: number }`
  - `weeklyMeans(p: BoardPlayer, ctx: RosContext): Float64Array` — one entry per `ctx.weeks`
  - `meansFor(players: BoardPlayer[], ctx: RosContext): Map<string, Float64Array>`
  - `rosLineupValue(roster: BoardPlayer[], ctx: RosContext, means: Map<string, Float64Array>): number`
  - `emptySlotWeeks(roster: BoardPlayer[], ctx: RosContext): number`
- Produces (`waivers.ts`):
  - `interface WaiverInput extends RosContext { roster: BoardPlayer[]; available: BoardPlayer[]; positions?: Position[]; dropPositions?: Position[]; rosterMax?: number; maxResults?: number }`
  - `interface WaiverAdd { add: BoardPlayer; drop: BoardPlayer | null; deltaPoints: number; deltaCoverWeeks: number; reason: string }`
  - `waiverAdds(input: WaiverInput): WaiverAdd[]`
  - `streamingOptions(input: Omit<WaiverInput, "weeks" | "positions" | "dropPositions"> & { week: number; pos: Position }): WaiverAdd[]`

**Where the weekly numbers come from.** For the current week, the `WeekOutlook.mean` when the board has one (it already folds in availability and the matchup). For every other remaining week, `expectedWeekly` from the season outcome model — the same fitted rate and availability the draft engine uses — with the bye week zero and season-long designations (IR/PUP/Sus/NA/COV/DNR, the shared `SEASON_LONG` set) zero for every week. Weeks after the regular season are not counted; the caller passes the list.

- [ ] **Step 1: Write the failing rosValue test**

```ts
// tests/seasonRosValue.test.ts
import { describe, it, expect } from "vitest";
import { weeklyMeans, meansFor, rosLineupValue, emptySlotWeeks, DEFAULT_OUTCOME } from "../lib/engine/season/rosValue";
import { expectedWeekly } from "../lib/engine/outcome";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 8, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
let n = 0;
const bp = (pos: Position, proj: number, over: Partial<BoardPlayer> = {}): BoardPlayer => ({
  id: `p${++n}`, name: `P${n}`, pos, team: `T${n}`, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {}, ...over,
});
const weeks = [10, 11, 12, 13, 14];
const ctx = { weeks, config: cfg };

describe("weeklyMeans", () => {
  it("is the season model's expected weekly points, flat across non-bye weeks", () => {
    const p = bp("WR", 200);
    const m = weeklyMeans(p, ctx);
    expect(m).toHaveLength(5);
    const e = expectedWeekly(p, DEFAULT_OUTCOME);
    for (const v of m) expect(v).toBeCloseTo(e, 10);
    expect(e).toBeGreaterThan(8); // 200 over 16 games, shrunk a little by availability
  });
  it("is zero in the bye week and nowhere else", () => {
    const m = weeklyMeans(bp("WR", 200, { bye: 12 }), ctx);
    expect(m[2]).toBe(0);
    expect(m[0]).toBeGreaterThan(0);
  });
  it("is zero every week for a season-long designation", () => {
    for (const injury of ["IR", "PUP", "Sus", "NA", "COV", "DNR"]) {
      expect(Array.from(weeklyMeans(bp("RB", 220, { injury }), ctx)).every((v) => v === 0)).toBe(true);
    }
  });
  it("uses this week's outlook mean for the current week only", () => {
    const p = bp("WR", 200);
    const outlook = { playerId: p.id, mean: 30, projected: true } as unknown as WeekOutlook;
    const m = weeklyMeans(p, { ...ctx, currentWeek: 10, outlooks: new Map([[p.id, outlook]]) });
    expect(m[0]).toBe(30);
    expect(m[1]).toBeCloseTo(expectedWeekly(p, DEFAULT_OUTCOME), 10);
  });
  it("ignores an outlook that projected nothing", () => {
    const p = bp("WR", 200);
    const outlook = { playerId: p.id, mean: 0, projected: false } as unknown as WeekOutlook;
    const m = weeklyMeans(p, { ...ctx, currentWeek: 10, outlooks: new Map([[p.id, outlook]]) });
    expect(m[0]).toBeCloseTo(expectedWeekly(p, DEFAULT_OUTCOME), 10);
  });
});

describe("rosLineupValue", () => {
  it("sums the optimal lineup's expected points over the weeks", () => {
    const roster = [bp("QB", 320), bp("RB", 250), bp("RB", 200), bp("WR", 240), bp("WR", 160), bp("TE", 120), bp("WR", 90)];
    const means = meansFor(roster, ctx);
    const v = rosLineupValue(roster, ctx, means);
    // Every player starts (7 players, 7 slots), so it is the plain sum.
    let sum = 0;
    for (const p of roster) for (const x of means.get(p.id)!) sum += x;
    expect(v).toBeCloseTo(sum, 8);
  });
  it("does not count a player who never cracks the lineup", () => {
    const roster = [bp("QB", 320), bp("RB", 250), bp("RB", 200), bp("WR", 240), bp("WR", 160), bp("TE", 120), bp("WR", 90)];
    const scrub = bp("WR", 40);
    const means = meansFor([...roster, scrub], ctx);
    expect(rosLineupValue([...roster, scrub], ctx, means)).toBeCloseTo(rosLineupValue(roster, ctx, means), 8);
  });
});

describe("emptySlotWeeks", () => {
  it("counts dedicated slot-weeks with no available body", () => {
    // Two RB slots; both RBs on a bye in week 12 -> 2 empty slot-weeks. One RB on IR -> 1 more per week.
    const roster = [bp("RB", 250, { bye: 12 }), bp("RB", 200, { bye: 12 }), bp("QB", 300), bp("WR", 200), bp("WR", 180), bp("TE", 100)];
    expect(emptySlotWeeks(roster, ctx)).toBe(2);
    expect(emptySlotWeeks([...roster.slice(1), bp("RB", 250, { injury: "IR" })], ctx)).toBe(2 + 4); // wk12: 2 empty; other 4 weeks: 1 empty
  });
  it("counts partial cover", () => {
    const roster = [bp("RB", 250, { bye: 12 }), bp("RB", 200, { bye: 12 }), bp("RB", 90, { bye: 9 }), bp("QB", 300), bp("WR", 200), bp("WR", 180), bp("TE", 100)];
    expect(emptySlotWeeks(roster, ctx)).toBe(1); // week 12 still has only one body for two slots
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonRosValue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `rosValue.ts`**

```ts
// lib/engine/season/rosValue.ts
// Rest-of-season value of a roster: the expected points its optimal lineup
// scores over the remaining weeks. Pure. Shared by waivers and trades so the
// two agree on what a player is worth TO THIS ROSTER.
//
// This week comes from the weekly board (availability and matchup already
// folded in); later weeks from the season outcome model, the same fitted rate
// the draft engine uses. A bye is zero; a season-long designation is zero
// everywhere — the shared SEASON_LONG set, never a local copy.
import type { BoardPlayer, LeagueConfig, Position } from "../../types";
import type { WeekOutlook } from "../weekly/outlook";
import type { OutcomeParams } from "../outcomeModel";
import { expectedWeekly } from "../outcome";
import { optimalLineupTotal } from "../season";
import { SEASON_LONG } from "../injuryFeed";
import outcomeJson from "../../../config/outcome-model.json";

export const DEFAULT_OUTCOME = outcomeJson as OutcomeParams;

export interface RosContext {
  /** Remaining regular-season weeks, ascending. */
  weeks: number[];
  config: LeagueConfig;
  params?: OutcomeParams;
  /** This week's outlooks, used for `currentWeek` when present and projected. */
  outlooks?: Map<string, WeekOutlook>;
  currentWeek?: number;
}

export function weeklyMeans(p: BoardPlayer, ctx: RosContext): Float64Array {
  const out = new Float64Array(ctx.weeks.length);
  if (p.injury && SEASON_LONG.has(p.injury)) return out;
  const params = ctx.params ?? DEFAULT_OUTCOME;
  const rate = expectedWeekly(p, params);
  ctx.weeks.forEach((w, i) => {
    if (p.bye === w) return;
    const o = w === ctx.currentWeek ? ctx.outlooks?.get(p.id) : undefined;
    out[i] = o && o.projected ? o.mean : rate;
  });
  return out;
}

export function meansFor(players: BoardPlayer[], ctx: RosContext): Map<string, Float64Array> {
  return new Map(players.map((p) => [p.id, weeklyMeans(p, ctx)] as const));
}

/** Sum over weeks of the optimal lineup's expected points. `means` must cover every roster player. */
export function rosLineupValue(roster: BoardPlayer[], ctx: RosContext, means: Map<string, Float64Array>): number {
  let total = 0;
  for (let i = 0; i < ctx.weeks.length; i++) {
    total += optimalLineupTotal(
      roster.map((p) => ({ pos: p.pos, score: means.get(p.id)?.[i] ?? 0 })),
      ctx.config
    );
  }
  return total;
}

const DEDICATED: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * Dedicated slot-weeks the roster cannot fill: for each week and position,
 * max(0, slots - bodies), where a body is a player at that position who is
 * neither on his bye nor on a season-long designation. FLEX is ignored, as
 * in lib/engine/coverage.ts: it is filled by three positions and would let a
 * sixth RB claim credit for a WR hole.
 */
export function emptySlotWeeks(roster: BoardPlayer[], ctx: RosContext): number {
  let empty = 0;
  for (const w of ctx.weeks) {
    for (const pos of DEDICATED) {
      const slots = ctx.config.rosterSlots[pos] ?? 0;
      if (slots <= 0) continue;
      const bodies = roster.filter((p) => p.pos === pos && p.bye !== w && !(p.injury && SEASON_LONG.has(p.injury))).length;
      empty += Math.max(0, slots - bodies);
    }
  }
  return empty;
}
```

- [ ] **Step 4: Run rosValue tests**

Run: `pnpm vitest run tests/seasonRosValue.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing waivers test**

```ts
// tests/seasonWaivers.test.ts
import { describe, it, expect } from "vitest";
import { waiverAdds, streamingOptions } from "../lib/engine/season/waivers";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 8, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
let n = 0;
const bp = (id: string, pos: Position, proj: number, over: Partial<BoardPlayer> = {}): BoardPlayer => ({
  id, name: id, pos, team: `T${++n}`, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {}, ...over,
});
// 9 players on an 8-round roster? No: rounds 8 is the roster cap, and this roster has 8, so every add needs a drop.
const roster = [
  bp("qb", "QB", 320), bp("rb1", "RB", 250), bp("rb2", "RB", 200), bp("wr1", "WR", 250), bp("wr2", "WR", 150),
  bp("te", "TE", 120), bp("wr3", "WR", 100), bp("rb3", "RB", 90),
];
const weeks = [10, 11, 12, 13, 14];

describe("waiverAdds", () => {
  it("values a WR who cracks my lineup, and drops the player who never did", () => {
    const wr = bp("wrNew", "WR", 220);
    const [top] = waiverAdds({ roster, available: [wr], weeks, config: cfg });
    expect(top.add.id).toBe("wrNew");
    expect(top.deltaPoints).toBeGreaterThan(0);
    // rb3 (90) never starts: dropping him costs nothing. wr3 would, a little (he was the flex).
    expect(top.drop?.id).toBe("rb3");
    expect(top.reason).toMatch(/\+\d/);
  });

  it("gives a good-in-the-abstract WR nothing when he would never crack my lineup", () => {
    const wr = bp("wrDeep", "WR", 95);
    expect(waiverAdds({ roster, available: [wr], weeks, config: cfg })).toEqual([]);
  });

  it("ranks several candidates by points added to MY lineup", () => {
    // c (95) beats neither te (120) nor the flex (wr3, 100); at 110 he WOULD take the flex — the controller checked.
    const adds = waiverAdds({ roster, available: [bp("a", "WR", 180), bp("b", "RB", 260), bp("c", "TE", 95)], weeks, config: cfg });
    expect(adds.map((x) => x.add.id)).toEqual(["b", "a"]);
    expect(adds[0].deltaPoints).toBeGreaterThan(adds[1].deltaPoints);
  });

  it("credits bye cover", () => {
    const thin = [bp("qb", "QB", 320), bp("rb1", "RB", 250, { bye: 12 }), bp("rb2", "RB", 200, { bye: 12 }), bp("wr1", "WR", 250), bp("wr2", "WR", 150), bp("te", "TE", 120), bp("k", "K", 130)];
    const [top] = waiverAdds({ roster: thin, available: [bp("rbCover", "RB", 80, { bye: 9 })], weeks, config: cfg, rosterMax: 8 });
    expect(top.add.id).toBe("rbCover");
    expect(top.drop).toBeNull(); // room on the roster
    expect(top.deltaCoverWeeks).toBe(1); // week 12: two empty RB slots become one
    expect(top.reason).toMatch(/slot-week/);
  });

  it("scales with the weeks considered", () => {
    const wr = bp("wrNew", "WR", 220);
    const five = waiverAdds({ roster, available: [wr], weeks, config: cfg })[0].deltaPoints;
    const one = waiverAdds({ roster, available: [wr], weeks: [10], config: cfg })[0].deltaPoints;
    expect(five / one).toBeCloseTo(5, 6);
  });

  it("uses this week's outlook for the current week", () => {
    const wr = bp("wrNew", "WR", 220);
    const outlook = { playerId: "wrNew", mean: 40, projected: true } as unknown as WeekOutlook;
    const plain = waiverAdds({ roster, available: [wr], weeks: [10], config: cfg })[0].deltaPoints;
    const hot = waiverAdds({ roster, available: [wr], weeks: [10], config: cfg, currentWeek: 10, outlooks: new Map([["wrNew", outlook]]) })[0].deltaPoints;
    expect(hot).toBeGreaterThan(plain);
  });

  it("respects maxResults and positions", () => {
    const pool = Array.from({ length: 12 }, (_, i) => bp(`w${i}`, "WR", 300 - i));
    expect(waiverAdds({ roster, available: pool, weeks, config: cfg, maxResults: 3 })).toHaveLength(3);
    expect(waiverAdds({ roster, available: [...pool, bp("r", "RB", 400)], weeks, config: cfg, positions: ["RB"] }).map((x) => x.add.id)).toEqual(["r"]);
  });

  it("skips a player on a season-long designation", () => {
    expect(waiverAdds({ roster, available: [bp("ir", "WR", 300, { injury: "IR" })], weeks, config: cfg })).toEqual([]);
  });
});

describe("streamingOptions", () => {
  it("is one position, one week, dropping the same position", () => {
    const withK = [...roster.slice(0, 7), bp("k", "K", 120)];
    const opts = streamingOptions({ roster: withK, available: [bp("kHot", "K", 150), bp("wrX", "WR", 400)], week: 10, pos: "K", config: cfg });
    expect(opts).toHaveLength(1);
    expect(opts[0].add.id).toBe("kHot");
    expect(opts[0].drop?.id).toBe("k");
    expect(opts[0].deltaPoints).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonWaivers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write `waivers.ts`**

```ts
// lib/engine/season/waivers.ts
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
    let best: { drop: BoardPlayer | null; value: number; after: BoardPlayer[] } | null = null;
    const consider = (drop: BoardPlayer | null) => {
      const after = drop ? [...roster.filter((p) => p.id !== drop.id), add] : [...roster, add];
      const value = rosLineupValue(after, ctx, means) - base;
      // Prefer the higher value; on a tie, prefer dropping the lower projection.
      if (!best || value > best.value + 1e-9 || (Math.abs(value - best.value) <= 1e-9 && drop && best.drop && drop.projPoints < best.drop.projPoints)) {
        best = { drop, value, after };
      }
    };
    if (roster.length < rosterMax && !input.dropPositions) consider(null);
    for (const d of dropPool) consider(d);
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
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonWaivers.test.ts tests/seasonRosValue.test.ts`
Expected: PASS, 9 + 9 tests. In the first waivers test, verify by hand before trusting it: before the add the flex is wr3 (100 > rb3 90); after adding wrNew (220) the starters are wr1, wrNew and flex wr2, so wr3 leaves the lineup and rb3 was never in it — dropping rb3 costs 0 and dropping wr3 costs 0 too now, so the tie-break (lower projection) picks rb3. If the code picks wr3, the tie-break is inverted.

- [ ] **Step 9: Commit**

```bash
git add lib/engine/season/rosValue.ts lib/engine/season/waivers.ts tests/seasonRosValue.test.ts tests/seasonWaivers.test.ts
git commit -m "Season: rest-of-season lineup value, waiver adds and streaming"
```

---

### Task 12: Trade evaluation on three axes

A trade is scored on three axes, not one number: Δ rest-of-season lineup points, Δ playoff odds, and Δ bye/injury cover. A trade that raises points while leaving you one injury from an empty flex is not a good trade, and a single number cannot say that.

**Files:**
- Create: `lib/engine/season/trade.ts`
- Test: `tests/seasonTrade.test.ts`

**Interfaces:**
- Consumes: `RosContext`, `meansFor`, `rosLineupValue`, `emptySlotWeeks` (Task 11); `playoffOdds`, `LeagueTeamInput` (Task 10); `BoardPlayer`.
- Produces:
  - `interface TradeAxis { delta: number; verdict: "up" | "down" | "flat" }`
  - `interface TradeLeagueContext { teams: LeagueTeamInput[]; schedule: Record<number, [number, number][]>; currentWeek: number; playoffWeekStart: number; playoffTeams: number; myRosterId: number; partnerRosterId?: number; sims?: number; seed?: number }`
  - `interface TradeInput extends RosContext { roster: BoardPlayer[]; give: string[]; receive: BoardPlayer[]; league?: TradeLeagueContext }`
  - `interface TradeVerdict { points: TradeAxis; playoffOdds: TradeAxis | null; cover: TradeAxis; rosterAfter: BoardPlayer[]; summary: string }`
  - `evaluateTrade(input: TradeInput): TradeVerdict`

- [ ] **Step 1: Write the failing test**

```ts
// tests/seasonTrade.test.ts
import { describe, it, expect } from "vitest";
import { evaluateTrade } from "../lib/engine/season/trade";
import type { LeagueTeamInput } from "../lib/engine/season/playoffOdds";
import type { BoardPlayer, LeagueConfig, Position } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 4, rounds: 8, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
let n = 0;
const bp = (id: string, pos: Position, proj: number, over: Partial<BoardPlayer> = {}): BoardPlayer => ({
  id, name: id, pos, team: `T${++n}`, bye: null, projPoints: proj, projImputed: false,
  adp: 50, adpStdev: 10, adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
  injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {}, ...over,
});
const roster = [
  bp("qb", "QB", 320), bp("rb1", "RB", 250, { bye: 12 }), bp("rb2", "RB", 200, { bye: 13 }), bp("wr1", "WR", 250), bp("wr2", "WR", 150),
  bp("te", "TE", 120), bp("wr3", "WR", 100), bp("rb3", "RB", 90, { bye: 11 }),
];
const weeks = [10, 11, 12, 13, 14];

describe("evaluateTrade", () => {
  it("a one-for-one upgrade is up on points, flat on cover, odds unknown without a league", () => {
    const v = evaluateTrade({ roster, give: ["wr2"], receive: [bp("wrStar", "WR", 260)], weeks, config: cfg });
    expect(v.points.verdict).toBe("up");
    expect(v.points.delta).toBeGreaterThan(0);
    expect(v.cover.verdict).toBe("flat");
    expect(v.playoffOdds).toBeNull();
    expect(v.rosterAfter.map((p) => p.id)).toContain("wrStar");
    expect(v.rosterAfter.map((p) => p.id)).not.toContain("wr2");
    expect(v.summary).toMatch(/lineup points/);
  });

  it("a two-for-one that thins a position is down on cover even when up on points", () => {
    // Give both backup RBs for one star whose bye matches rb1's: week 12 now has zero RBs.
    const v = evaluateTrade({ roster, give: ["rb2", "rb3"], receive: [bp("rbStar", "RB", 330, { bye: 12 })], weeks, config: cfg });
    expect(v.points.verdict).toBe("up");
    expect(v.cover.verdict).toBe("down");
    expect(v.cover.delta).toBeLessThanOrEqual(-2);
    expect(v.summary).toMatch(/cover/);
  });

  it("a downgrade is down on points", () => {
    const v = evaluateTrade({ roster, give: ["wr1"], receive: [bp("wrMeh", "WR", 120)], weeks, config: cfg });
    expect(v.points.verdict).toBe("down");
  });

  it("a swap of equals is flat", () => {
    const v = evaluateTrade({ roster, give: ["wr2"], receive: [bp("wrSame", "WR", 150)], weeks, config: cfg });
    expect(v.points.verdict).toBe("flat");
    expect(v.cover.verdict).toBe("flat");
  });

  it("with a league, a big upgrade raises playoff odds and the partner's roster changes too", () => {
    const mk = (rosterId: number, players: BoardPlayer[]): LeagueTeamInput => ({ rosterId, name: `T${rosterId}`, players, wins: 4, losses: 4, ties: 0, pointsFor: 800 });
    const other = (k: number) => [bp(`q${k}`, "QB", 300), bp(`r${k}a`, "RB", 220), bp(`r${k}b`, "RB", 200), bp(`w${k}a`, "WR", 220), bp(`w${k}b`, "WR", 180), bp(`t${k}`, "TE", 110)];
    const partner = [...other(2), bp("rbStar", "RB", 400)];
    const teams = [mk(1, roster), mk(2, partner), mk(3, other(3)), mk(4, other(4))];
    const v = evaluateTrade({
      roster, give: ["rb3"], receive: [bp("rbStar", "RB", 400)], weeks, config: cfg,
      league: { teams, schedule: {}, currentWeek: 10, playoffWeekStart: 15, playoffTeams: 2, myRosterId: 1, partnerRosterId: 2, sims: 300, seed: 7 },
    });
    expect(v.playoffOdds).not.toBeNull();
    expect(v.playoffOdds!.verdict).toBe("up");
    expect(v.playoffOdds!.delta).toBeGreaterThan(0.05);
  });

  it("is deterministic", () => {
    const x = bp("x", "WR", 260); // one object: the helper stamps a fresh team per call
    const a = evaluateTrade({ roster, give: ["wr2"], receive: [x], weeks, config: cfg });
    const b = evaluateTrade({ roster, give: ["wr2"], receive: [x], weeks, config: cfg });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonTrade.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/season/trade.ts
// Three-axis trade evaluation. Pure.
//
//   points  — delta rest-of-season lineup points (rosValue.ts)
//   odds    — delta playoff odds, when the league is known (playoffOdds.ts),
//             with the partner's roster changed too so the league they play
//             in is the league after the trade
//   cover   — delta empty slot-weeks (byes and season-long designations)
//
// The verdict is three words and a sentence, never one number.
import type { BoardPlayer } from "../../types";
import { emptySlotWeeks, meansFor, rosLineupValue, type RosContext } from "./rosValue";
import { playoffOdds, type LeagueTeamInput } from "./playoffOdds";

export interface TradeAxis {
  delta: number;
  verdict: "up" | "down" | "flat";
}

export interface TradeLeagueContext {
  teams: LeagueTeamInput[];
  schedule: Record<number, [number, number][]>;
  currentWeek: number;
  playoffWeekStart: number;
  playoffTeams: number;
  myRosterId: number;
  /** The other side of the deal, when known; their roster is updated too. */
  partnerRosterId?: number;
  sims?: number;
  seed?: number;
}

export interface TradeInput extends RosContext {
  roster: BoardPlayer[];
  /** Ids leaving my roster. */
  give: string[];
  /** Players arriving. */
  receive: BoardPlayer[];
  league?: TradeLeagueContext;
}

export interface TradeVerdict {
  points: TradeAxis;
  playoffOdds: TradeAxis | null;
  cover: TradeAxis;
  rosterAfter: BoardPlayer[];
  summary: string;
}

// Presentation thresholds — below these a change reads as "flat". They are
// not model levers (nothing is fitted against them), so they stay here.
const FLAT_POINTS = 2;
const FLAT_ODDS = 0.01;
const FLAT_COVER = 0.5;
const TRADE_SIMS = 200;

function axis(delta: number, flat: number): TradeAxis {
  return { delta, verdict: delta > flat ? "up" : delta < -flat ? "down" : "flat" };
}

function summarize(points: TradeAxis, odds: TradeAxis | null, cover: TradeAxis, weeks: number): string {
  const parts: string[] = [];
  const span = `over the remaining ${weeks} week${weeks === 1 ? "" : "s"}`;
  if (points.verdict === "up") parts.push(`adds ${points.delta.toFixed(0)} lineup points ${span}`);
  else if (points.verdict === "down") parts.push(`costs ${(-points.delta).toFixed(0)} lineup points ${span}`);
  else parts.push(`leaves lineup points about even ${span}`);
  if (odds) {
    const pp = (odds.delta * 100).toFixed(0);
    if (odds.verdict === "up") parts.push(`raises playoff odds ${pp} points`);
    else if (odds.verdict === "down") parts.push(`lowers playoff odds ${-Number(pp)} points`);
    else parts.push(`barely moves playoff odds`);
  }
  if (cover.verdict === "down") parts.push(`costs ${(-cover.delta).toFixed(0)} slot-week${cover.delta <= -1.5 ? "s" : ""} of bye/injury cover`);
  else if (cover.verdict === "up") parts.push(`adds ${cover.delta.toFixed(0)} slot-week${cover.delta >= 1.5 ? "s" : ""} of cover`);
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

export function evaluateTrade(input: TradeInput): TradeVerdict {
  const { roster, give, receive } = input;
  const ctx: RosContext = { weeks: input.weeks, config: input.config, params: input.params, outlooks: input.outlooks, currentWeek: input.currentWeek };
  const giving = new Set(give);
  const rosterAfter = [...roster.filter((p) => !giving.has(p.id)), ...receive];
  const means = meansFor([...roster, ...receive], ctx);

  const points = axis(rosLineupValue(rosterAfter, ctx, means) - rosLineupValue(roster, ctx, means), FLAT_POINTS);
  // Cover: fewer empty slot-weeks is better, so the delta is before minus after.
  const cover = axis(emptySlotWeeks(roster, ctx) - emptySlotWeeks(rosterAfter, ctx), FLAT_COVER);

  let odds: TradeAxis | null = null;
  if (input.league) {
    const L = input.league;
    const given = roster.filter((p) => giving.has(p.id));
    const receivedIds = new Set(receive.map((p) => p.id));
    const before = L.teams;
    const after = L.teams.map((t) => {
      if (t.rosterId === L.myRosterId) return { ...t, players: rosterAfter };
      if (L.partnerRosterId !== undefined && t.rosterId === L.partnerRosterId) {
        return { ...t, players: [...t.players.filter((p) => !receivedIds.has(p.id)), ...given] };
      }
      return t;
    });
    const common = { schedule: L.schedule, currentWeek: L.currentWeek, playoffWeekStart: L.playoffWeekStart, playoffTeams: L.playoffTeams, config: input.config, myRosterId: L.myRosterId, sims: L.sims ?? TRADE_SIMS, seed: L.seed ?? 1, params: input.params };
    const a = playoffOdds({ ...common, teams: before }).mine.playoffOdds;
    const b = playoffOdds({ ...common, teams: after }).mine.playoffOdds;
    odds = axis(b - a, FLAT_ODDS);
  }

  return { points, playoffOdds: odds, cover, rosterAfter, summary: summarize(points, odds, cover, input.weeks.length) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonTrade.test.ts`
Expected: PASS, 6 tests. For the two-for-one case, check by hand: before, week 12 has rb2 and rb3 available (2 bodies, 0 empty) and week 11 has rb1 and rb2 (0 empty), week 13 has rb1 and rb3 (0 empty); after, RBs are rb1 (bye 12) and rbStar (bye 12): week 12 has 0 bodies for 2 slots → 2 empty. So cover delta is −2 and the verdict is down.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/season/trade.ts tests/seasonTrade.test.ts
git commit -m "Season: three-axis trade evaluation"
```

---

### Task 13: Matchup, waivers, playoff odds and trade sections

Everything computed in Tasks 10–12 gets a home on `/season`, in the spec's order: **Must fix → Lineup → Matchup → Waivers → Playoff odds → Trades**. Read `components/season/SeasonCockpit.tsx` as it stands after Task 6 (and Tasks 7–9's `RosterImport` tabs) before editing; this task replaces its body below the header and adds four panel components.

**Files:**
- Create: `components/season/MatchupPanel.tsx`
- Create: `components/season/WaiversPanel.tsx`
- Create: `components/season/PlayoffPanel.tsx`
- Create: `components/season/TradePanel.tsx`
- Modify: `components/season/SeasonCockpit.tsx`
- Modify: `components/season/LineupTable.tsx` (highlight recommended changes, coloured positions, clickable names)
- Uses: `components/PlayerModal.tsx` (existing, readonly mode), `lib/client/pos.ts` (`POS_COLOR`)
- Modify: `lib/client/teams.ts` (`SavedTeam.regularSeasonEnd?: number`, `SavedTeam.oppProjectedTotal?: number`)

**Interfaces:**
- Consumes: `startSitAdvice`, `Advice`, `Opponent` (Task 4); `playoffOdds`, `PlayoffOdds`, `LeagueTeamInput` (Task 10); `waiverAdds`, `streamingOptions` (Task 11); `evaluateTrade` (Task 12); `SavedTeam`, `LeagueSnapshot` (Tasks 1, 7); `DEFAULT_SEASON_LEVERS` (Task 4); `REG_SEASON_WEEKS` from `lib/engine/coverage.ts`.
- Produces: components only. `SeasonCockpit` exports nothing new; Task 14 adds live signals to it at the marked hook point.

**Behaviour to get right:**
- **Opponent.** With a Sleeper snapshot and a known pairing for this week, the opponent is `{ kind: "roster", players: their starters }` and the Matchup panel names them. Otherwise it is `{ kind: "total", projectedTotal }`, defaulting to my own current lineup's projected total (an even matchup) and editable; the panel says "modelled as a projected total, not a roster".
- **Starters.** If the saved roster has any `starter` slots (Sleeper, or a paste/OCR with labels), pass them as `starterIds`; otherwise let the engine pick.
- **Remaining weeks.** Sleeper: `week … playoffWeekStart − 1`. Manual: `week … regularSeasonEnd`, with `regularSeasonEnd` editable in the Playoff panel, default 14, saved on the team.
- **Free agents.** Sleeper: the board minus every rostered player in the snapshot. Manual: the board minus my roster, with a visible note that it assumes everyone else is available.
- **Playoff odds** run only with a Sleeper snapshot (it needs every roster). Background: `useEffect` → `setTimeout(…, 0)` → `playoffOdds` → state, with a "Simulating…" line while it runs. Its `leverage` feeds `startSitAdvice`; with the shipped `riskFromPlayoffOdds: 0` that changes nothing, and the panel says so.
- **Never render `projected: false` as 0.0.** `LineupTable` already handles this; the new panels only show players through it or by name.
- **Owner feedback folded in (2026-09-09, after seeing Task 6 live):** the page had no way back, no colour, nothing looked clickable, and player names did nothing. So, in this task: (1) the header gets a `next/link` back link `← Draft cockpit` to `/`, styled like Setup's "Newsroom →" link; (2) every position tag in `LineupTable`, the swap list, the waiver list and the trade panel is coloured with `POS_COLOR[pos]` (the `style={{ color: POS_COLOR[p.pos] }}` pattern from components/PasteImport.tsx); (3) player names in `LineupTable` are `<button>`s (`onSelect(id)`) that open the existing `components/PlayerModal.tsx` in `readonly` mode — `SeasonCockpit` holds `modalPlayer` state and renders `<PlayerModal player ctx={{ currentPick: 1, nextPick: 1, drift: {}, tierMatesLeft: 0 }} config={team.config} drafted={false} canUnmark={false} readonly wireItem={live.boardNews.get(id) ?? null} myTurn={false} onMark={() => {}} onUnmark={() => {}} onClose={() => setModalPlayer(null)} />` (Task 14 already provides `live`); (3b) the Points cell shows a small status tag beside the number for a day-to-day designation (`Q`/`D` from `drivers.status`, in `text-warn`) so a Doubtful player who still projects 3.8 reads as "3.8 D", not as a healthy 3.8; (4) every clickable element has a visible hover state (`hover:bg-panel` on rows and list items, `hover:text-ink` on links) and a focus ring (`focus-visible:outline outline-2 outline-wr`). A broader design pass (light mode, themes, a non-template look) is a separate leg after this plan; do not start it here.

- [ ] **Step 1: Extend `SavedTeam`**

In `lib/client/teams.ts` add to `SavedTeam`:

```ts
  /** Manual leagues: last regular-season week. Sleeper teams read league.playoffWeekStart instead. */
  regularSeasonEnd?: number;
  /** Manual leagues: the opponent's projected total the user typed for this week, if any. */
  oppProjectedTotal?: number;
```

- [ ] **Step 2: Let `LineupTable` mark changes, colour positions, and make names clickable**

Add optional props `changed?: Set<string>` and `onSelect?: (id: string) => void` to `LineupTable`. A row whose id is in `changed` gets `bg-panel` on the `<tr>` and a small `↑` (in the starters) or `↓` (on the bench) in the Slot cell. The Pos cell renders the position in `POS_COLOR[p.pos]`. When `onSelect` is given, the name cell is `<button onClick={() => onSelect(id)} className="text-left hover:text-wr focus-visible:outline outline-2 outline-wr">` — otherwise plain text. Rows get `hover:bg-panel`.

- [ ] **Step 3: Write `MatchupPanel`**

```tsx
// components/season/MatchupPanel.tsx
"use client";

import type { Advice } from "../../lib/engine/season/advice";

export default function MatchupPanel({
  advice, oppName, oppIsTotal, oppTotal, onOppTotal,
}: {
  advice: Advice;
  oppName: string | null;
  oppIsTotal: boolean;
  oppTotal: number;
  onOppTotal: (v: number) => void;
}) {
  const pct = (advice.winProbability * 100).toFixed(0);
  const band = (t: { p10: number; p50: number; p90: number }) => `${t.p10.toFixed(0)} · ${t.p50.toFixed(0)} · ${t.p90.toFixed(0)}`;
  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">Matchup{oppName ? ` vs ${oppName}` : ""}</h2>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="font-display text-4xl font-bold tabular-nums">{pct}%</span>
        <span className="text-sm text-ink-dim">to win with your current lineup</span>
      </div>
      <table className="mt-3 text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-faint"><th className="pr-4 font-normal"></th><th className="pr-4 font-normal">Mean</th><th className="font-normal">Floor · Median · Ceiling</th></tr>
        </thead>
        <tbody>
          <tr><td className="pr-4">You</td><td className="pr-4 tabular-nums">{advice.myTotal.mean.toFixed(1)}</td><td className="tabular-nums text-ink-dim">{band(advice.myTotal)}</td></tr>
          <tr><td className="pr-4">{oppName ?? "Opponent"}</td><td className="pr-4 tabular-nums">{advice.oppTotal.mean.toFixed(1)}</td><td className="tabular-nums text-ink-dim">{band(advice.oppTotal)}</td></tr>
        </tbody>
      </table>
      {oppIsTotal ? (
        <label className="mt-3 block text-xs text-ink-dim">
          No opponent roster is loaded, so the opponent is modelled as a projected total with the same spread as your lineup — not a roster.
          Opponent projected total{" "}
          <input
            type="number" step="1" value={Math.round(oppTotal)}
            onChange={(e) => onOppTotal(Number(e.target.value))}
            className="ml-1 w-20 rounded border border-line bg-field px-1 py-0.5 text-sm tabular-nums"
          />
        </label>
      ) : (
        <p className="mt-3 text-xs text-ink-faint">Both lineups are drawn from the same simulated week, so a shared game is correlated rather than assumed independent.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Write `WaiversPanel`**

```tsx
// components/season/WaiversPanel.tsx
"use client";

import { useMemo, useState } from "react";
import type { BoardPlayer, LeagueConfig, Position } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { waiverAdds, streamingOptions } from "../../lib/engine/season/waivers";
import { POS_COLOR } from "../../lib/client/pos";

const STREAM_POS: Position[] = ["QB", "TE", "K", "DST"];

export default function WaiversPanel({
  roster, available, weeks, config, outlooks, week, assumesAllAvailable,
}: {
  roster: BoardPlayer[];
  available: BoardPlayer[];
  weeks: number[];
  config: LeagueConfig;
  outlooks: Map<string, WeekOutlook>;
  week: number;
  assumesAllAvailable: boolean;
}) {
  const [mode, setMode] = useState<"season" | Position>("season");
  const adds = useMemo(() => {
    if (roster.length === 0 || weeks.length === 0) return [];
    return mode === "season"
      ? waiverAdds({ roster, available, weeks, config, outlooks, currentWeek: week, maxResults: 8 })
      : streamingOptions({ roster, available, week, pos: mode, config, outlooks, maxResults: 5 });
  }, [roster, available, weeks, config, outlooks, week, mode]);

  return (
    <section className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Waivers</h2>
        <div className="flex gap-1 text-xs">
          <button onClick={() => setMode("season")} className={`rounded px-2 py-0.5 ${mode === "season" ? "bg-panel text-ink" : "text-ink-faint hover:text-ink"}`}>Rest of season</button>
          {STREAM_POS.filter((p) => (config.rosterSlots[p] ?? 0) > 0).map((p) => (
            <button key={p} onClick={() => setMode(p)} className={`rounded px-2 py-0.5 ${mode === p ? "bg-panel text-ink" : "text-ink-faint hover:text-ink"}`}>Stream {p}</button>
          ))}
        </div>
      </div>
      {adds.length === 0 ? (
        <p className="mt-2 text-sm text-ink-dim">Nobody available would add to your lineup{mode === "season" ? " over the rest of the season" : ` at ${mode} this week`}.</p>
      ) : (
        <ol className="mt-2 space-y-1 text-sm">
          {adds.map((a) => (
            <li key={a.add.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[10px]" style={{ color: POS_COLOR[a.add.pos] }}>{a.add.pos}</span>
              <strong>{a.add.name}</strong>
              <span className="text-xs text-ink-faint">{a.add.team}</span>
              {a.drop && <span className="text-xs text-ink-dim">— drop {a.drop.name}</span>}
              <span className="basis-full text-xs text-ink-dim">{a.reason}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        Ranked by points added to <em>your</em> lineup, not by a generic ranking — a third WR who never starts scores near zero.
        {assumesAllAvailable && " No league synced, so this assumes everyone not on your roster is available."}
      </p>
    </section>
  );
}
```

- [ ] **Step 5: Write `PlayoffPanel`**

```tsx
// components/season/PlayoffPanel.tsx
"use client";

import type { PlayoffOdds } from "../../lib/engine/season/playoffOdds";
import { DEFAULT_SEASON_LEVERS } from "../../lib/engine/season/levers";

export default function PlayoffPanel({
  odds, running, myRosterId, regularSeasonEnd, onRegularSeasonEnd, hasLeague,
}: {
  odds: PlayoffOdds | null;
  running: boolean;
  myRosterId: number | null;
  regularSeasonEnd: number;
  onRegularSeasonEnd: (w: number) => void;
  hasLeague: boolean;
}) {
  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">Playoff odds</h2>
      {!hasLeague ? (
        <div className="mt-2 text-sm text-ink-dim">
          <p>Playoff odds need every roster in the league — sync a Sleeper league to see them.</p>
          <label className="mt-2 block text-xs">
            Regular season ends after week{" "}
            <input type="number" min={1} max={18} value={regularSeasonEnd} onChange={(e) => onRegularSeasonEnd(Number(e.target.value))} className="ml-1 w-14 rounded border border-line bg-field px-1 py-0.5 tabular-nums" />
            <span className="ml-2 text-ink-faint">(sets how many weeks waivers and trades count)</span>
          </label>
        </div>
      ) : running && !odds ? (
        <p className="mt-2 text-sm text-ink-dim">Simulating the rest of the season…</p>
      ) : odds ? (
        <>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-display text-3xl font-bold tabular-nums">{(odds.mine.playoffOdds * 100).toFixed(0)}%</span>
            <span className="text-sm text-ink-dim">to make the playoffs · {odds.mine.expectedWins.toFixed(1)} more wins expected</span>
            {odds.leverage !== null && (
              <span className="text-xs text-ink-faint">
                this week: {odds.oddsIfWin !== null ? `${(odds.oddsIfWin * 100).toFixed(0)}% if you win` : "—"} / {odds.oddsIfLose !== null ? `${(odds.oddsIfLose * 100).toFixed(0)}% if you lose` : "—"}
              </span>
            )}
            {odds.eliminationNumber !== null && odds.mine.playoffOdds < 1 && (
              <span className="text-xs text-ink-faint">{odds.eliminationNumber === 0 ? "eliminated" : `elimination number ${odds.eliminationNumber}`}</span>
            )}
            {running && <span className="text-xs text-ink-faint">updating…</span>}
          </div>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-faint"><th className="font-normal">Team</th><th className="text-right font-normal">Odds</th><th className="text-right font-normal">Exp. wins</th><th className="text-right font-normal">Top seed</th></tr></thead>
            <tbody>
              {[...odds.teams].sort((a, b) => b.playoffOdds - a.playoffOdds).map((t) => (
                <tr key={t.rosterId} className={`border-t border-line ${t.rosterId === myRosterId ? "font-semibold" : ""}`}>
                  <td className="py-0.5">{t.name}</td>
                  <td className="py-0.5 text-right tabular-nums">{(t.playoffOdds * 100).toFixed(0)}%</td>
                  <td className="py-0.5 text-right tabular-nums">{t.expectedWins.toFixed(1)}</td>
                  <td className="py-0.5 text-right tabular-nums text-ink-dim">{((t.seedDist[0] ?? 0) * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-ink-faint">
            {odds.remainingWeeks} regular-season week{odds.remainingWeeks === 1 ? "" : "s"} left.
            {" "}Pairings known through week {odds.scheduleKnownThrough}; later weeks use a random opponent.
            {" "}Risk dial ({DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds === 0 ? "off" : `on, ${DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds}`}): {DEFAULT_SEASON_LEVERS.riskFromPlayoffOdds === 0 ? "start/sit ranks by this week's win probability alone." : "start/sit blends toward projected points when this week cannot move your odds."}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-dim">Waiting for the league snapshot…</p>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Write `TradePanel`**

```tsx
// components/season/TradePanel.tsx
"use client";

import { useMemo, useState } from "react";
import type { BoardPlayer } from "../../lib/types";
import type { WeekOutlook } from "../../lib/engine/weekly/outlook";
import { evaluateTrade, type TradeLeagueContext, type TradeVerdict } from "../../lib/engine/season/trade";
import type { RosContext } from "../../lib/engine/season/rosValue";
import { POS_COLOR } from "../../lib/client/pos";

const VERDICT_CLASS = { up: "text-rb", down: "text-qb", flat: "text-ink-dim" } as const;

export default function TradePanel({
  roster, board, ctx, league,
}: {
  roster: BoardPlayer[];
  board: BoardPlayer[];
  ctx: Omit<RosContext, "outlooks"> & { outlooks: Map<string, WeekOutlook> };
  league: TradeLeagueContext | null;
}) {
  const [give, setGive] = useState<Set<string>>(new Set());
  const [receive, setReceive] = useState<BoardPlayer[]>([]);
  const [query, setQuery] = useState("");
  const [verdict, setVerdict] = useState<TradeVerdict | null>(null);

  const onRoster = useMemo(() => new Set(roster.map((p) => p.id)), [roster]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return board.filter((p) => p.name.toLowerCase().includes(q) && !onRoster.has(p.id) && !receive.some((r) => r.id === p.id)).slice(0, 6);
  }, [query, board, onRoster, receive]);

  function evaluate() {
    setVerdict(evaluateTrade({ ...ctx, roster, give: [...give], receive, league: league ?? undefined }));
  }

  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">Trade</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-ink-faint">You give</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {roster.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={give.has(p.id)} onChange={(e) => setGive((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                  <span className="font-mono text-[10px]" style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>{p.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs text-ink-faint">You receive</p>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a player by name…" className="mt-1 w-full rounded border border-line bg-field px-2 py-1 text-sm" />
          {matches.length > 0 && (
            <ul className="mt-1 rounded border border-line text-sm">
              {matches.map((p) => (
                <li key={p.id}><button onClick={() => { setReceive((r) => [...r, p]); setQuery(""); }} className="w-full px-2 py-1 text-left hover:bg-panel">{p.name} <span className="text-ink-faint">{p.pos} · {p.team}</span></button></li>
              ))}
            </ul>
          )}
          <ul className="mt-1 flex flex-wrap gap-1">
            {receive.map((p) => (
              <li key={p.id} className="rounded bg-panel px-2 py-0.5 text-xs">{p.name}<button onClick={() => setReceive((r) => r.filter((x) => x.id !== p.id))} className="ml-1 text-ink-faint hover:text-ink" aria-label={`Remove ${p.name}`}>×</button></li>
            ))}
          </ul>
        </div>
      </div>
      <button onClick={evaluate} disabled={give.size === 0 && receive.length === 0} className="mt-3 rounded bg-rb px-4 py-2 text-sm font-semibold text-field disabled:opacity-40">Evaluate</button>
      {verdict && (
        <div className="mt-3 text-sm">
          <p>{verdict.summary}</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 text-xs">
            <li className={VERDICT_CLASS[verdict.points.verdict]}>Points {verdict.points.delta >= 0 ? "+" : ""}{verdict.points.delta.toFixed(0)}</li>
            <li className={verdict.playoffOdds ? VERDICT_CLASS[verdict.playoffOdds.verdict] : "text-ink-faint"}>Playoff odds {verdict.playoffOdds ? `${verdict.playoffOdds.delta >= 0 ? "+" : ""}${(verdict.playoffOdds.delta * 100).toFixed(0)} pts` : "— (no league synced)"}</li>
            <li className={VERDICT_CLASS[verdict.cover.verdict]}>Cover {verdict.cover.delta >= 0 ? "+" : ""}{verdict.cover.delta.toFixed(0)} slot-weeks</li>
          </ul>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Rewrite `SeasonCockpit`'s body**

Keep Task 6's header (title, week selector) and `RosterImport`; replace everything below with this. Every derived value is a `useMemo`; the playoff sim is a background effect.

```tsx
// components/season/SeasonCockpit.tsx — imports at top
import { useEffect, useMemo, useState } from "react";
import type { Board, BoardPlayer, LeagueConfig, Position } from "../../lib/types";
import { DEFAULT_WEEKLY_MODEL } from "../../lib/engine/weekly/model";
import { startSitAdvice, type AdvicePlayer, type Opponent } from "../../lib/engine/season/advice";
import { bestLineup } from "../../lib/engine/season/lineup";
import { playoffOdds, type PlayoffOdds, type LeagueTeamInput } from "../../lib/engine/season/playoffOdds";
import type { TradeLeagueContext } from "../../lib/engine/season/trade";
import { REG_SEASON_WEEKS } from "../../lib/engine/coverage";
import { loadTeams, saveTeam, type SavedTeam } from "../../lib/client/teams";
import LineupTable from "./LineupTable";
import RosterImport from "./RosterImport";
import MatchupPanel from "./MatchupPanel";
import WaiversPanel from "./WaiversPanel";
import PlayoffPanel from "./PlayoffPanel";
import TradePanel from "./TradePanel";

const DEFAULT_REGULAR_SEASON_END = 14;
```

Inside the component, after `team`/`update`/`byId` from Task 6:

```tsx
  // Task 14 grades live signals onto `outlooks` here; until then it is the board's.
  const graded = outlooks;

  const rosterPlayers = useMemo(
    () => (team ? team.roster.map((r) => byId.get(r.playerId)).filter((p): p is BoardPlayer => !!p) : []),
    [team, byId]
  );
  const starterIds = useMemo(() => team?.roster.filter((r) => r.slot === "starter").map((r) => r.playerId) ?? [], [team]);
  const league = team?.league ?? null;
  const myRosterId = team?.sleeper?.rosterId ?? null;
  const oppRosterId = team?.schedule?.[week]?.oppRosterId ?? null;
  const oppSnapshot = league && oppRosterId !== null ? league.rosters.find((r) => r.rosterId === oppRosterId) ?? null : null;

  // Only players the week board has an outlook for can be advised on; the rest
  // still show in the roster list. flatMap keeps the types honest without a
  // hand-written predicate.
  const advicePlayers = useMemo<(AdvicePlayer & { name: string })[]>(
    () => rosterPlayers.flatMap((p) => {
      const o = graded.get(p.id);
      return o ? [{ id: p.id, pos: p.pos as Position, team: p.team, name: p.name, outlook: o }] : [];
    }),
    [rosterPlayers, graded]
  );
  const myProjected = useMemo(() => {
    const startable = advicePlayers.filter((p) => p.outlook.projected && p.outlook.pPlay > 0);
    return team ? bestLineup(startable.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), team.config).total : 0;
  }, [advicePlayers, team]);
  const oppTotal = team?.oppProjectedTotal ?? myProjected;

  const opponent = useMemo<Opponent>(() => {
    if (oppSnapshot) {
      const players: AdvicePlayer[] = oppSnapshot.starters.flatMap((id) => {
        const p = byId.get(id);
        const o = p ? graded.get(p.id) : undefined;
        return p && o ? [{ id: p.id, pos: p.pos, team: p.team, outlook: o }] : [];
      });
      if (players.length > 0) return { kind: "roster", players };
    }
    return { kind: "total", projectedTotal: oppTotal };
  }, [oppSnapshot, byId, graded, oppTotal]);

  // Playoff odds: background compute, Sleeper only.
  const [odds, setOdds] = useState<PlayoffOdds | null>(null);
  const [oddsRunning, setOddsRunning] = useState(false);
  const regularSeasonEnd = league ? league.playoffWeekStart - 1 : team?.regularSeasonEnd ?? DEFAULT_REGULAR_SEASON_END;
  const weeks = useMemo(() => Array.from({ length: Math.max(0, Math.min(REG_SEASON_WEEKS, regularSeasonEnd) - week + 1) }, (_, i) => week + i), [week, regularSeasonEnd]);
  const leagueTeams: LeagueTeamInput[] | null = useMemo(() => {
    if (!league) return null;
    return league.rosters.map((r) => ({
      rosterId: r.rosterId, name: r.name, wins: r.wins, losses: r.losses, ties: r.ties, pointsFor: r.pointsFor,
      players: r.players.map((id) => byId.get(id)).filter((p): p is BoardPlayer => !!p),
    }));
  }, [league, byId]);
  useEffect(() => {
    if (!league || !leagueTeams || myRosterId === null || !team) { setOdds(null); return; }
    setOddsRunning(true);
    const cfg = team.config;
    const handle = setTimeout(() => {
      setOdds(playoffOdds({ teams: leagueTeams, schedule: league.schedule, currentWeek: week, playoffWeekStart: league.playoffWeekStart, playoffTeams: league.playoffTeams, config: cfg, myRosterId }));
      setOddsRunning(false);
    }, 0);
    return () => clearTimeout(handle);
  }, [league, leagueTeams, myRosterId, week, team]);

  const advice = useMemo(() => {
    if (!team || advicePlayers.length === 0) return null;
    return startSitAdvice({ players: advicePlayers, opponent, config: team.config, params: DEFAULT_WEEKLY_MODEL, starterIds: starterIds.length ? starterIds : undefined, leverage: odds?.leverage ?? null });
  }, [team, advicePlayers, opponent, starterIds, odds]);

  const rostered = useMemo(() => new Set(league ? league.rosters.flatMap((r) => r.players) : team?.roster.map((r) => r.playerId) ?? []), [league, team]);
  const available = useMemo(() => board.players.filter((p) => !rostered.has(p.id)), [board.players, rostered]);
  const tradeLeague: TradeLeagueContext | null = league && leagueTeams && myRosterId !== null
    ? { teams: leagueTeams, schedule: league.schedule, currentWeek: week, playoffWeekStart: league.playoffWeekStart, playoffTeams: league.playoffTeams, myRosterId, partnerRosterId: oppRosterId ?? undefined }
    : null;
  const changed = useMemo(() => {
    if (!advice) return new Set<string>();
    const cur = new Set(advice.lineup.starters.map((s) => s.player.id));
    const rec = new Set(advice.recommended.starters.map((s) => s.player.id));
    return new Set([...cur].filter((id) => !rec.has(id)).concat([...rec].filter((id) => !cur.has(id))));
  }, [advice]);
```

and the JSX below the header and `RosterImport`:

```tsx
      {advice && team && (
        <>
          {advice.forced.length > 0 && (
            <section className="rounded-lg border border-qb/60 bg-qb/10 p-4">
              <h2 className="text-sm font-semibold text-qb">Must fix</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {advice.forced.map((f) => (
                  <li key={f.outId}>
                    <strong>{f.outName}</strong>{" "}
                    <span className="text-ink-dim">{f.why === "bye" ? "is on a bye" : f.why === "out" ? "is not expected to play" : "has no projection from any source"}</span>
                    {f.bestReplacementName && <> — start <strong>{f.bestReplacementName}</strong> instead</>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-lg border border-line p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Lineup</h2>
              <span className="text-xs text-ink-faint">
                {(advice.winProbability * 100).toFixed(0)}% now → {(advice.recommendedWinProbability * 100).toFixed(0)}% with the swaps below
              </span>
            </div>
            <div className="mt-2"><LineupTable lineup={advice.recommended} players={byId} outlooks={graded} changed={changed} /></div>
            {advice.swaps.length === 0 ? (
              <p className="mt-3 text-sm text-ink-dim">Your lineup is already the best of what you have.</p>
            ) : (
              <ul className="mt-3 space-y-1 text-sm">
                {advice.swaps.slice(0, 6).map((s) => (
                  <li key={`${s.inId}-${s.outId}`}>Start <strong>{s.inName}</strong> over <strong>{s.outName}</strong><span className="text-ink-dim"> — {s.reason}</span></li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-faint">Ranked by how much each swap moves your chance of winning this matchup, not by projected points.</p>
          </section>

          <MatchupPanel
            advice={advice}
            oppName={oppSnapshot?.name ?? team.schedule?.[week]?.oppName ?? null}
            oppIsTotal={opponent.kind === "total"}
            oppTotal={oppTotal}
            onOppTotal={(v) => update({ ...team, oppProjectedTotal: v })}
          />
          <WaiversPanel roster={rosterPlayers} available={available} weeks={weeks} config={team.config} outlooks={graded} week={week} assumesAllAvailable={!league} />
          <PlayoffPanel odds={odds} running={oddsRunning} myRosterId={myRosterId} regularSeasonEnd={regularSeasonEnd} onRegularSeasonEnd={(w) => update({ ...team, regularSeasonEnd: w })} hasLeague={!!league} />
          <TradePanel roster={rosterPlayers} board={board.players} ctx={{ weeks, config: team.config, outlooks: graded, currentWeek: week }} league={tradeLeague} />
        </>
      )}
      {!advice && <p className="text-sm text-ink-dim">Add a few players above to see your lineup and swap advice.</p>}
```

- [ ] **Step 8: Verify in the browser**

`pnpm dev`, `/season`. With a manual roster of eight or nine real players:
- Matchup shows a win probability near 50% by default (opponent total defaults to your own projection) and moves when you edit the total;
- Waivers lists adds with a drop and a reason; "Stream K" lists kickers;
- Playoff odds explains it needs a Sleeper league and lets you set the regular-season end;
- Trade: give one starter, receive a better one, Evaluate → three axes with the odds axis marked unavailable.
Then sync the public Sleeper league `289646328504385536` as roster 1 and confirm the playoff panel simulates (2018 players have no 2026 projections, so odds will be flat and near equal — that is correct; the point is that the panel runs, shows the table, and reports pairings known through the last week). Report what rendered, including the exact win probability and the top waiver line.

- [ ] **Step 9: Full checks and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add components/season lib/client/teams.ts
git commit -m "Season: matchup, waivers, playoff odds and trade panels"
```

---

### Task 14: Live signals graded onto outlooks

Carried forward from Leg A on purpose: Sunday-morning inactives, a Friday downgrade, an activation — they arrive through the existing `useLiveSignals` hook (ESPN's injuries table, headlines, the Bluesky wire) and must change the advice without anyone editing a projection. The grading is pure and lives in the engine; the component only wires the hook to it, per the standing rule ("grade onto the board only via the pure grader — never status logic in components").

**Why a sibling grader and not `gradeBoard`.** `gradeBoard` grades a `Board` (season players, `injury` field). Outlooks carry their status in `drivers.status` and their availability in `pPlay`/`mean`, and the right weekly availability for a status is `pPlay` from `lib/engine/weekly/availability.ts` — which imports `SEASON_LONG` from `injuryFeed.ts`. Putting the new grader in `injuryFeed.ts` would make a cycle, so it lives beside the weekly model and reuses `reconcileStatus`, `classifyNews`, `liveInjuryStatus` and `pPlay` by import.

**Files:**
- Create: `lib/engine/weekly/liveGrade.ts`
- Modify: `components/season/SeasonCockpit.tsx` (the hook point marked in Task 13)
- Modify: `AGENTS.md` (one clause; see Step 6)
- Test: `tests/weeklyLiveGrade.test.ts`

**Interfaces:**
- Consumes: `reconcileStatus`, `FeedStatus` from `lib/engine/injuryFeed.ts`; `classifyNews`, `liveInjuryStatus` from `lib/engine/newsSignal.ts`; `pPlay` from `lib/engine/weekly/availability.ts`; `WeekOutlook`; `WeeklyModelParams`; `useLiveSignals`, `gradeBoard` (existing).
- Produces: `gradeOutlooks(outlooks: Map<string, WeekOutlook>, liveStatus: ReadonlyMap<string, { status: FeedStatus }>, news: ReadonlyMap<string, { headline: string }>, params: WeeklyModelParams): Map<string, WeekOutlook>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/weeklyLiveGrade.test.ts
import { describe, it, expect } from "vitest";
import { gradeOutlooks } from "../lib/engine/weekly/liveGrade";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { FALLBACK_PLAY_PROB, HEALTHY_PLAY_PROB } from "../lib/engine/weekly/availability";
import type { WeekOutlook } from "../lib/engine/weekly/outlook";

const ol = (id: string, over: Partial<WeekOutlook> = {}): WeekOutlook => {
  const p = over.pPlay ?? 0.97;
  return {
    playerId: id, week: 3, opp: "CHI", meanIfPlays: 12, mean: 12 * p, sigma: 0.6, p10: 5, p50: 10, p90: 22, pPlay: p, projected: true,
    stats: {}, drivers: { baseMarket: 12, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: null }, ...over,
  };
};
const map = (...os: WeekOutlook[]) => new Map(os.map((o) => [o.playerId, o] as const));
const healthy = DEFAULT_WEEKLY_MODEL.availability.healthy ?? HEALTHY_PLAY_PROB;

describe("gradeOutlooks", () => {
  it("returns the same Map when nothing changes", () => {
    const m = map(ol("a"));
    expect(gradeOutlooks(m, new Map(), new Map(), DEFAULT_WEEKLY_MODEL)).toBe(m);
  });

  it("an Out from the table drops pPlay and mean, and records the status", () => {
    const out = gradeOutlooks(map(ol("a")), new Map([["a", { status: "Out" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    const a = out.get("a")!;
    expect(a.drivers.status).toBe("Out");
    expect(a.pPlay).toBeCloseTo(DEFAULT_WEEKLY_MODEL.availability.byStatus.Out ?? FALLBACK_PLAY_PROB.Out, 10);
    expect(a.mean).toBeCloseTo(a.meanIfPlays * a.pPlay, 10);
    expect(a.meanIfPlays).toBe(12); // the conditional projection is untouched
  });

  it("an Active clears a Questionable and restores the healthy rate", () => {
    const q = ol("a", { pPlay: 0.75, drivers: { baseMarket: 12, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: "Questionable" } });
    const out = gradeOutlooks(map(q), new Map([["a", { status: "Active" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    expect(out.get("a")!.drivers.status).toBeNull();
    expect(out.get("a")!.pPlay).toBeCloseTo(healthy, 10);
  });

  it("a baked season-long designation is not overridden by a day-to-day Out", () => {
    const ir = ol("a", { pPlay: 0, mean: 0, drivers: { baseMarket: 12, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: "IR" } });
    const m = map(ir);
    expect(gradeOutlooks(m, new Map([["a", { status: "Out" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL)).toBe(m);
  });

  it("a hard headline escalates on top of the table", () => {
    const out = gradeOutlooks(map(ol("a")), new Map([["a", { status: "Questionable" as const }]]), new Map([["a", { headline: "RB placed on injured reserve" }]]), DEFAULT_WEEKLY_MODEL);
    expect(out.get("a")!.drivers.status).toBe("IR");
    expect(out.get("a")!.pPlay).toBe(0);
    expect(out.get("a")!.mean).toBe(0);
  });

  it("a bye stays a bye whatever the table says", () => {
    // The status genuinely changes (Questionable -> cleared), so the recompute
    // branch runs — and pPlay must still be 0 because opp is null.
    const bye = ol("a", { opp: null, pPlay: 0, mean: 0, drivers: { baseMarket: 12, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: "Questionable" } });
    const out = gradeOutlooks(map(bye), new Map([["a", { status: "Active" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    expect(out.get("a")!.drivers.status).toBeNull();
    expect(out.get("a")!.pPlay).toBe(0);
    expect(out.get("a")!.mean).toBe(0);
  });

  it("leaves untouched outlooks by reference and never mutates the input", () => {
    const a = ol("a"); const b = ol("b");
    const m = map(a, b);
    const out = gradeOutlooks(m, new Map([["a", { status: "Doubtful" as const }]]), new Map(), DEFAULT_WEEKLY_MODEL);
    expect(out).not.toBe(m);
    expect(out.get("b")).toBe(b);
    expect(a.drivers.status).toBeNull(); // input untouched
    expect(m.get("a")!.pPlay).toBe(0.97);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/weeklyLiveGrade.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// lib/engine/weekly/liveGrade.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/weeklyLiveGrade.test.ts`
Expected: PASS, 7 tests. Then `pnpm vitest run tests/injuryFeed.test.ts tests/weeklyAvailability.test.ts` to confirm nothing upstream moved.

- [ ] **Step 5: Wire it into `SeasonCockpit`**

This task was pulled forward to run before Tasks 11–13 (the owner saw a live Doubtful ignored by the swap list). If Task 13 has not run yet, `SeasonCockpit` still reads `outlooks` directly: introduce `graded` right after `byId` and use it wherever `outlooks` fed the advice call and `LineupTable`. If Task 13 has run, replace its hook point (`const graded = outlooks;`). Either way:

```tsx
  const live = useLiveSignals(board);
  const headlines = useMemo(() => new Map([...live.boardNews].map(([id, n]) => [id, { headline: n.headline }] as const)), [live.boardNews]);
  const graded = useMemo(() => gradeOutlooks(outlooks, live.liveStatus, headlines, DEFAULT_WEEKLY_MODEL), [outlooks, live.liveStatus, headlines]);
```

importing `useLiveSignals` from `../../lib/client/useLiveSignals` and `gradeOutlooks` from `../../lib/engine/weekly/liveGrade`. Also grade the board for the badges the lineup shows: `const gradedBoard = useMemo(() => gradeBoard(board, live.liveStatus, headlines), [board, live.liveStatus, headlines]);` and pass `gradedBoard.players` wherever `board.players` fed `byId`. Add to the header a small line: `{live.lastRefresh ? `live signals ${new Date(live.lastRefresh).toLocaleTimeString()}` : "loading live signals…"}` in `text-xs text-ink-faint`.

The `·live` marker compares against what the WEEK BOARD BAKED, which is the UNGRADED board's status — never the graded board's, or graded-vs-graded converges and the marker never fires. So: `const bakedStatus = useMemo(() => new Map(board.players.map((p) => [p.id, p.injury] as const)), [board.players]);` from the raw `board` prop, passed to `LineupTable` as `bakedStatus`; in `LineupTable`, when `o.drivers.status !== (bakedStatus.get(id) ?? null)`, append a `·live` marker in the status cell (`text-live` token) so a Sunday inactive is visibly live rather than baked.

- [ ] **Step 6: Record the rule in AGENTS.md**

In the "Live signals … flow through `lib/client/useLiveSignals.ts`" bullet, extend the final clause to: "grade them onto the board only via the pure `gradeBoard` in `lib/engine/injuryFeed.ts`, and onto weekly outlooks only via the pure `gradeOutlooks` in `lib/engine/weekly/liveGrade.ts`."

- [ ] **Step 7: Verify in the browser**

`pnpm dev`, `/season`, a manual roster. Confirm the header shows a live-signals timestamp after the first poll and that a player ESPN currently lists as Out or Doubtful (check `/newsroom` for one) shows the status in the lineup table with the `·live` marker and a reduced projection, and lands in Must fix if he was a starter. Report the player and the before/after numbers.

- [ ] **Step 8: Full checks and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add lib/engine/weekly/liveGrade.ts tests/weeklyLiveGrade.test.ts components/season/SeasonCockpit.tsx components/season/LineupTable.tsx AGENTS.md
git commit -m "Season: live statuses and headlines graded onto weekly outlooks"
```

---

### Task 15: Performance budgets and documentation

**Files:**
- Create: `tests/perfSeason.test.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `lib/engine/season.ts` (doc comment only)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the budget test**

```ts
// tests/perfSeason.test.ts
// Latency budgets for the in-season engine, in their own file so vitest gives
// them a fresh worker — the same reason tests/perf.test.ts is separate.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startSitAdvice } from "../lib/engine/season/advice";
import { waiverAdds } from "../lib/engine/season/waivers";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import type { Board, LeagueConfig, WeekBoard } from "../lib/types";

const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
const weekBoard: WeekBoard = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "week-2026-1-ppr.json"), "utf8"));
const outlooks = new Map(weekBoard.outlooks.map((o) => [o.playerId, o] as const));

const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

// A realistic 15-man roster and a 9-man opponent, dealt from the board by ADP.
const byAdp = [...board.players].filter((p) => outlooks.get(p.id)?.projected).sort((a, b) => a.adp - b.adp);
const take = (n: number, from: number) => byAdp.slice(from, from + n);
const mine = take(15, 0);
const theirs = take(9, 40);
const ap = (p: (typeof mine)[number]) => ({ id: p.id, pos: p.pos, team: p.team, name: p.name, outlook: outlooks.get(p.id)! });

const best = (n: number, fn: () => void) => {
  let ms = Infinity;
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); ms = Math.min(ms, performance.now() - t); }
  return ms;
};

describe("in-season latency budgets", () => {
  it("startSitAdvice for a 15-man roster at 2000 sims runs under 150ms — the spec's budget", () => {
    const input = { players: mine.map(ap), opponent: { kind: "roster" as const, players: theirs.map(ap) }, config, params: DEFAULT_WEEKLY_MODEL, sims: 2000, seed: 1 };
    startSitAdvice(input); // JIT warmup
    const ms = best(5, () => startSitAdvice(input));
    console.log(`startSitAdvice: ${ms.toFixed(1)}ms (15 vs 9, 2000 sims)`);
    expect(ms).toBeLessThan(150);
  });

  it("waiverAdds over the whole board for 8 remaining weeks runs under 500ms", () => {
    const available = board.players.filter((p) => !mine.some((m) => m.id === p.id));
    const weeks = [10, 11, 12, 13, 14, 15, 16, 17];
    const ms = best(3, () => waiverAdds({ roster: mine, available, weeks, config, outlooks, currentWeek: 10 }));
    console.log(`waiverAdds: ${ms.toFixed(1)}ms (${available.length} available, 8 weeks)`);
    expect(ms).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/perfSeason.test.ts`
Expected: PASS with the timings logged. The controller measured the advice path's two costs at 15 ms (one `simulateWeek`, 24 players, 2000 sims) plus 4 ms per hundred lineup evaluations, so the 150 ms budget has a wide margin; if it is exceeded, the cause is almost certainly re-simulating per swap — profile before optimising, and do not raise the budget to pass. If `week-2026-1-ppr.json` is missing, run `pnpm build:week -- --week=1` first; do not commit a rebuilt board unless it changed for a reason you can state.

- [ ] **Step 3: Run the entire suite one final time**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`
Expected: everything passes, including `tests/perf.test.ts`'s 50 ms draft budget and `tests/perfWeekly.test.ts`. Leg B must not have cost the draft cockpit a millisecond.

- [ ] **Step 4: Record the lineup-optimiser finding in `lib/engine/season.ts`**

Above `optimalLineupTotal`, replace the one-line comment with:

```ts
/**
 * Optimal lineup total for one week's scores. Greedy — fill dedicated slots
 * with the best at each position, then the best remaining eligible players
 * into the FLEX slots — and EXACT for this app's roster model, which has one
 * kind of FLEX with one eligibility set: any k eligible leftovers can fill k
 * identical flex slots, so taking the top k is optimal. (The earlier claim
 * that it was wrong for superflex or two-flex leagues was mistaken; a config
 * with two DIFFERENT flex kinds would need lib/engine/season/lineup.ts's
 * allocation search, and RosterSlots cannot express one.) The in-season
 * engine uses bestLineup from lib/engine/season/lineup.ts when it needs the
 * assignment (who sits in which slot) rather than just the total.
 */
```

- [ ] **Step 5: Document it in AGENTS.md**

Add to the project-notes list:

```markdown
- **In-season cockpit (`/season`)**: pure engine under `lib/engine/season/` — `bestLineup` (assignment), `winProbability` (fixed lineups over ONE joint correlated draw), `startSitAdvice` (ranked by Δ P(win this matchup), forced swaps first), `playoffOdds` (rest-of-season sim on the season outcome model), `rosValue`/`waivers` (value over YOUR lineup), `trade` (three axes). Levers live in `config/season.json` with the risk dial `riskFromPlayoffOdds` shipping OFF (0 reproduces pure Δ P(win)). Rosters live in the localStorage registry `lib/client/teams.ts`; all four ingestion paths (Sleeper sync `lib/season/sleeperLeague.ts`, paste `lib/season/rosterPaste.ts`, OCR `lib/season/rosterOcr.ts`, manual) end in `applyRoster`. `WeekOutlook.projected === false` is "no projection", never 0.0. Budget: `startSitAdvice` < 150 ms at 2,000 sims (`tests/perfSeason.test.ts`). Replay gates: `pnpm backtest:lineup` (synthetic-league replays over the historical player-weeks; see `docs/backtest-gates.md`).
```

- [ ] **Step 6: Document it in README.md**

Add a section "In-season cockpit" after the draft-night material describing: the `/season` route; the four ways to load a roster (Sleeper league URL, paste, screen sync, manual) and that Sleeper sync also brings your opponent, the free-agent pool and playoff odds; that start/sit is ranked by the probability of winning *this* matchup rather than by points, with the underdog-ceiling / favourite-floor behaviour stated in one sentence each; waivers as value over your own lineup and streaming; playoff odds and the risk dial (off by default, `config/season.json`); trades on three axes; the manual-league caveats (opponent modelled as a projected total; waivers assume everyone is available; playoff odds need a synced league); and the gates (`pnpm backtest:lineup`, Task 16) with a pointer to `docs/backtest-gates.md`. Add `backtest:lineup` to the Scripts section.

- [ ] **Step 7: Commit**

```bash
git add tests/perfSeason.test.ts AGENTS.md README.md lib/engine/season.ts
git commit -m "Season: latency budgets and docs"
```

---

### Task 16: Replay gates — does Δ P(win) actually win more?

The spec's gates, run honestly on what exists. There is **no historical league data** (no rosters, no matchups, no standings), so the two gates that can run use **synthetic leagues replayed over the real historical player-weeks** (`data/historical-data/weekly/{season}.json`, 2021–2025: Sleeper's projection and nflverse's actual for ~15,000 player-weeks). The third gate cannot run yet; it is reported as NOT RUN with the forward path, not skipped silently.

- **Gate L1 — start/sit replay.** Random rosters vs random opponents each historical week; lineup A = highest projections, lineup B = `startSitAdvice(...).recommended`. Scored on **realized** points. Pass = B's matchup win rate ≥ A's. Points are reported alongside but do not gate: points can lose to a better objective, win rate is the product.
- **Gate L2 — waiver replay.** Random roster each week; claim A = `waiverAdds` top pick (value over my lineup), claim B = highest generic rest-of-season projection. Realized points the claim adds to the **lineup** over the following four weeks. Pass = A ≥ B.
- **Gate L3 — playoff odds calibration.** NOT RUN: needs historical league standings and rosters. Forward path: every Sleeper sync now stores a `LeagueSnapshot`; after a season of them, bucket mid-season odds and check teams given ~70% made it ~70% of the time.

**Do not reword a gate after seeing the data.** Report the verdict as-is. Leg A's finding that no mean signal survives the market applies here too: if L1 ties, that is a finding about the noise floor, not a bug to tune away.

**Files:**
- Create: `lib/engine/season/replay.ts`
- Create: `scripts/backtest-lineup.ts`
- Modify: `docs/backtest-gates.md` (create if Leg A's Task 17 has not yet)
- Modify: `package.json` (`"backtest:lineup": "tsx scripts/backtest-lineup.ts"`)
- Test: `tests/seasonReplay.test.ts`

**Interfaces:**
- Consumes: `HistRow`, `decodeHistory` from `lib/etl/weekly/history.ts`; `scoreStatLine`, `SCORING_PRESETS`; `projectedVolume`, `weeklySigma`, `lognormalQuantile` from `lib/engine/weekly/spread.ts`; `startSitAdvice`; `bestLineup`; `waiverAdds`; `makeRng`.
- Produces (`replay.ts`):
  - `histRowToOutlook(row: HistRow, params: WeeklyModelParams, scoring: ScoringSettings): WeekOutlook` — mean = re-scored projection, sigma from the fitted spread, `pPlay: 1` (statuses in the set are not contemporaneous; see `HistRow.stNow`), `projected: true`.
  - `realizedPoints(row: HistRow, scoring: ScoringSettings): number` — 0 when `act` is null (did not play).
  - `sampleRoster(rows: HistRow[], counts: Partial<Record<Position, number>>, rng: () => number, exclude?: Set<string>): HistRow[]` — seeded draw without replacement per position.
  - `histRowToBoardPlayer(row: HistRow, scoring: ScoringSettings): BoardPlayer` — a season-rate proxy (`projPoints = weekly projection × 16`, bye null, injury null) so `rosValue` can price him.

- [ ] **Step 1: Write the failing test**

```ts
// tests/seasonReplay.test.ts
import { describe, it, expect } from "vitest";
import { histRowToOutlook, realizedPoints, sampleRoster, histRowToBoardPlayer } from "../lib/engine/season/replay";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { SCORING_PRESETS, scoreStatLine } from "../lib/scoring";
import { makeRng } from "../lib/engine/montecarlo";
import type { HistRow } from "../lib/etl/weekly/history";

const row = (over: Partial<HistRow> = {}): HistRow => ({
  id: "1", pos: "WR", team: "DET", wk: 5, opp: "CHI", stNow: "Out",
  proj: { receptions: 6, recYds: 80, recTD: 0.5 }, act: { receptions: 8, recYds: 110, recTD: 1 }, tot: 47.5, spr: -3, ...over,
});
const ppr = SCORING_PRESETS.ppr;

describe("histRowToOutlook", () => {
  it("re-scores the projection, spreads it with the fitted sigma, and ignores the non-contemporaneous status", () => {
    const o = histRowToOutlook(row(), DEFAULT_WEEKLY_MODEL, ppr);
    expect(o.meanIfPlays).toBeCloseTo(scoreStatLine(row().proj, ppr), 10); // 6 + 8 + 3 = 17
    expect(o.mean).toBe(o.meanIfPlays);
    expect(o.pPlay).toBe(1); // stNow is fetch-time, never the week's — deliberately unused
    expect(o.projected).toBe(true);
    expect(o.opp).toBe("CHI");
    expect(o.sigma).toBeGreaterThan(0.3);
    expect(o.p10).toBeLessThan(o.p50);
    expect(o.p50).toBeLessThan(o.p90);
    expect(o.drivers.status).toBeNull();
  });
});

describe("realizedPoints", () => {
  it("scores the actual line and treats a DNP as zero", () => {
    expect(realizedPoints(row(), ppr)).toBeCloseTo(8 + 11 + 6, 10);
    expect(realizedPoints(row({ act: null }), ppr)).toBe(0);
    expect(realizedPoints(row({ act: {} }), ppr)).toBe(0);
  });
});

describe("sampleRoster", () => {
  const pool: HistRow[] = [
    ...Array.from({ length: 6 }, (_, i) => row({ id: `q${i}`, pos: "QB" })),
    ...Array.from({ length: 10 }, (_, i) => row({ id: `r${i}`, pos: "RB" })),
    ...Array.from({ length: 10 }, (_, i) => row({ id: `w${i}`, pos: "WR" })),
    ...Array.from({ length: 4 }, (_, i) => row({ id: `t${i}`, pos: "TE" })),
  ];
  it("draws the requested counts without replacement", () => {
    const r = sampleRoster(pool, { QB: 2, RB: 4, WR: 4, TE: 2 }, makeRng(1));
    expect(r).toHaveLength(12);
    expect(new Set(r.map((x) => x.id)).size).toBe(12);
    expect(r.filter((x) => x.pos === "RB")).toHaveLength(4);
  });
  it("is seeded and respects exclusions", () => {
    const a = sampleRoster(pool, { QB: 1, RB: 2 }, makeRng(7)).map((x) => x.id);
    const b = sampleRoster(pool, { QB: 1, RB: 2 }, makeRng(7)).map((x) => x.id);
    expect(a).toEqual(b);
    const c = sampleRoster(pool, { QB: 1 }, makeRng(7), new Set(pool.filter((x) => x.pos === "QB").slice(0, 5).map((x) => x.id)));
    expect(c.map((x) => x.id)).toEqual(["q5"]);
  });
  it("takes what is there when a position runs short", () => {
    expect(sampleRoster(pool, { TE: 9 }, makeRng(1))).toHaveLength(4);
  });
});

describe("histRowToBoardPlayer", () => {
  it("is a season-rate proxy the rest-of-season value can price", () => {
    const p = histRowToBoardPlayer(row(), ppr);
    expect(p.id).toBe("1");
    expect(p.pos).toBe("WR");
    expect(p.projPoints).toBeCloseTo(17 * 16, 6);
    expect(p.bye).toBeNull();
    expect(p.injury).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonReplay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `replay.ts`**

```ts
// lib/engine/season/replay.ts
// Adapters from the historical fit set (lib/etl/weekly/history.ts HistRow) to
// the in-season engine's inputs, so scripts/backtest-lineup.ts can replay
// start/sit and waiver decisions against realized points. Pure.
import type { BoardPlayer, Position, ScoringSettings } from "../../types";
import type { HistRow } from "../../etl/weekly/history";
import type { WeekOutlook } from "../weekly/outlook";
import type { WeeklyModelParams } from "../weekly/model";
import { scoreStatLine } from "../../scoring";
import { lognormalQuantile, projectedVolume, weeklySigma } from "../weekly/spread";

/**
 * pPlay is 1 on purpose: HistRow.stNow is the status at FETCH time, not the
 * week's (see its docstring), so it carries no information about that week.
 * A player who did not play realizes 0 through `realizedPoints`, which is the
 * honest way to let DNPs cost both strategies equally.
 */
export function histRowToOutlook(row: HistRow, params: WeeklyModelParams, scoring: ScoringSettings): WeekOutlook {
  const mean = Math.max(0, scoreStatLine(row.proj, scoring, row.pos === "TE"));
  const sigma = weeklySigma(row.pos, projectedVolume(row.pos, row.proj), params);
  const q = (p: number) => (mean > 0 ? lognormalQuantile(mean, sigma, p) : 0);
  return {
    playerId: row.id,
    week: row.wk,
    opp: row.opp,
    meanIfPlays: mean,
    mean,
    sigma,
    p10: q(0.1),
    p50: q(0.5),
    p90: q(0.9),
    pPlay: 1,
    projected: true,
    stats: row.proj,
    drivers: { baseMarket: mean, baseUsage: 0, matchMult: 1, envMult: 1, scriptMult: 1, status: null },
  };
}

export function realizedPoints(row: HistRow, scoring: ScoringSettings): number {
  return row.act ? scoreStatLine(row.act, scoring, row.pos === "TE") : 0;
}

/** Seeded draw without replacement, per position. Takes what is there when short. */
export function sampleRoster(
  rows: HistRow[],
  counts: Partial<Record<Position, number>>,
  rng: () => number,
  exclude: Set<string> = new Set()
): HistRow[] {
  const out: HistRow[] = [];
  for (const [pos, n] of Object.entries(counts) as [Position, number][]) {
    const pool = rows.filter((r) => r.pos === pos && !exclude.has(r.id) && !out.some((o) => o.id === r.id));
    for (let k = 0; k < n && pool.length > 0; k++) {
      const i = Math.floor(rng() * pool.length);
      out.push(pool[i]);
      pool.splice(i, 1);
    }
  }
  return out;
}

const GAMES = 16;

/** Season-rate proxy so rosValue (which prices BoardPlayers) can value a historical player. */
export function histRowToBoardPlayer(row: HistRow, scoring: ScoringSettings): BoardPlayer {
  const weekly = Math.max(0, scoreStatLine(row.proj, scoring, row.pos === "TE"));
  return {
    id: row.id, name: row.id, pos: row.pos, team: row.team, bye: null, projPoints: weekly * GAMES, projImputed: false,
    adp: 999, adpStdev: 0, adpHigh: 999, adpLow: 999, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
    injury: null, depthOrder: null, sosSeason: null, sosPlayoff: null, ids: {},
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonReplay.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the script**

```ts
// scripts/backtest-lineup.ts
// Leg B replay gates on synthetic leagues over the real historical
// player-weeks. There is no historical league data, so rosters and matchups
// are drawn at random (seeded) and both strategies face the SAME draws.
//
// Gate L1: start/sit by delta P(win) vs highest projection — realized matchup win rate.
// Gate L2: waiver claim by value-over-my-lineup vs generic ROS rank — realized lineup points added over the next 4 weeks.
// Gate L3: playoff odds calibration — NOT RUN (no league history yet).
//
// Usage: pnpm backtest:lineup -- --holdout=2025 --matchups=150 --seed=1
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeHistory, type HistRow } from "../lib/etl/weekly/history";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import { SCORING_PRESETS } from "../lib/scoring";
import { makeRng } from "../lib/engine/montecarlo";
import { bestLineup } from "../lib/engine/season/lineup";
import { startSitAdvice } from "../lib/engine/season/advice";
import { waiverAdds } from "../lib/engine/season/waivers";
import { histRowToBoardPlayer, histRowToOutlook, realizedPoints, sampleRoster } from "../lib/engine/season/replay";
import type { LeagueConfig, Position } from "../lib/types";

const HIST_DIR = join(process.cwd(), "data", "historical-data", "weekly");
const GATES = join(process.cwd(), "docs", "backtest-gates.md");
const scoring = SCORING_PRESETS.ppr;
const config: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 12, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 0, DST: 0 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};
const ROSTER: Partial<Record<Position, number>> = { QB: 2, RB: 4, WR: 4, TE: 2 };
const OPP: Partial<Record<Position, number>> = { QB: 1, RB: 2, WR: 3, TE: 1 };
/** Only players Sleeper thought would matter: a floor on projected points keeps the pool realistic. */
const MIN_PROJ = 5;
const SIMS = 1000;

function arg(name: string, def: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : def;
}

const lines: string[] = [];
function log(s: string) { lines.push(s); console.log(s); }

function main() {
  const season = arg("holdout", 2025);
  const matchups = arg("matchups", 150);
  const seed = arg("seed", 1);
  const path = join(HIST_DIR, `${season}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path} — run pnpm build:weekly-history`);
  const rows = decodeHistory(readFileSync(path, "utf8"));
  const byWeek = new Map<number, HistRow[]>();
  for (const r of rows) {
    if (realizedPoints({ ...r, act: r.proj }, scoring) < MIN_PROJ) continue; // projection floor
    const list = byWeek.get(r.wk) ?? [];
    list.push(r);
    byWeek.set(r.wk, list);
  }
  const actual = new Map<string, number>(); // `${id}:${wk}` -> realized
  for (const r of rows) actual.set(`${r.id}:${r.wk}`, realizedPoints(r, scoring));
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  log(`# Leg B replay gates — holdout ${season}, ${rows.length} player-weeks, ${weeks.length} weeks, ${matchups} matchups/week, seed ${seed}\n`);

  // ---------------------------------------------------------------- Gate L1
  let winsA = 0, winsB = 0, differ = 0, bWinsWhenDiffer = 0, aWinsWhenDiffer = 0, ptsA = 0, ptsB = 0, n = 0;
  for (const wk of weeks) {
    const pool = byWeek.get(wk)!;
    const rng = makeRng((seed * 7919 + wk * 104729) >>> 0);
    for (let m = 0; m < matchups; m++) {
      const mine = sampleRoster(pool, ROSTER, rng);
      const theirs = sampleRoster(pool, OPP, rng, new Set(mine.map((r) => r.id)));
      if (mine.length < 8 || theirs.length < 7) continue;
      const toAdvice = (r: HistRow) => ({ id: r.id, pos: r.pos, team: r.team, name: r.id, outlook: histRowToOutlook(r, DEFAULT_WEEKLY_MODEL, scoring) });
      const players = mine.map(toAdvice);
      const opp = theirs.map(toAdvice);
      // Their lineup: highest projections (the naive rule, applied to the opponent for both arms).
      const theirLineup = bestLineup(opp.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), config);
      const theirReal = theirLineup.starters.reduce((s, x) => s + (actual.get(`${x.player.id}:${wk}`) ?? 0), 0);
      // Arm A: highest projections. Arm B: delta P(win).
      const a = bestLineup(players.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })), config);
      const b = startSitAdvice({ players, opponent: { kind: "roster", players: opp }, config, params: DEFAULT_WEEKLY_MODEL, sims: SIMS, seed: seed + m }).recommended;
      const realA = a.starters.reduce((s, x) => s + (actual.get(`${x.player.id}:${wk}`) ?? 0), 0);
      const realB = b.starters.reduce((s, x) => s + (actual.get(`${x.player.id}:${wk}`) ?? 0), 0);
      const wA = realA > theirReal ? 1 : realA === theirReal ? 0.5 : 0;
      const wB = realB > theirReal ? 1 : realB === theirReal ? 0.5 : 0;
      winsA += wA; winsB += wB; ptsA += realA; ptsB += realB; n++;
      const sameSet = a.starters.map((s) => s.player.id).sort().join() === b.starters.map((s) => s.player.id).sort().join();
      if (!sameSet) { differ++; bWinsWhenDiffer += wB; aWinsWhenDiffer += wA; }
    }
  }
  const rateA = winsA / n, rateB = winsB / n;
  // Paired sign test on the matchups where the lineups differed: under H0 each arm wins the disagreement half the time.
  const z = differ > 0 ? (bWinsWhenDiffer - aWinsWhenDiffer) / Math.sqrt(differ) : 0;
  log(`## Gate L1 — start/sit replay (${n} matchups)`);
  log(`- naive highest-projection lineup: win rate ${(rateA * 100).toFixed(1)}%, ${(ptsA / n).toFixed(1)} pts/wk`);
  log(`- delta P(win) lineup:             win rate ${(rateB * 100).toFixed(1)}%, ${(ptsB / n).toFixed(1)} pts/wk`);
  log(`- lineups differed in ${differ} of ${n} (${((differ / n) * 100).toFixed(1)}%); on those, delta P(win) won ${bWinsWhenDiffer.toFixed(1)} vs ${aWinsWhenDiffer.toFixed(1)} (paired z = ${z.toFixed(2)})`);
  log(`- ${rateB >= rateA ? "PASS" : "FAIL"} — delta P(win) ${rateB >= rateA ? "matches or beats" : "loses to"} naive on realized matchup win rate${Math.abs(z) < 1.96 ? " (difference not distinguishable from noise at 95%)" : ""}\n`);

  // ---------------------------------------------------------------- Gate L2
  const HORIZON = 4;
  let addA = 0, addB = 0, m2 = 0, same = 0;
  for (const wk of weeks) {
    if (!byWeek.has(wk + HORIZON)) continue;
    const pool = byWeek.get(wk)!;
    const rng = makeRng((seed * 7919 + wk * 104729 + 17) >>> 0);
    const future = Array.from({ length: HORIZON }, (_, i) => wk + 1 + i);
    for (let m = 0; m < Math.ceil(matchups / 3); m++) {
      const mine = sampleRoster(pool, ROSTER, rng);
      if (mine.length < 12) continue;
      const roster = mine.map((r) => histRowToBoardPlayer(r, scoring));
      const rostered = new Set(roster.map((p) => p.id));
      const available = pool.filter((r) => !rostered.has(r.id)).map((r) => histRowToBoardPlayer(r, scoring));
      const ctx = { weeks: future, config };
      const a = waiverAdds({ roster, available, ...ctx, maxResults: 1 })[0];
      const bAdd = [...available].sort((x, y) => y.projPoints - x.projPoints)[0];
      if (!a || !bAdd) continue;
      const bDrop = [...roster].sort((x, y) => x.projPoints - y.projPoints)[0];
      const realized = (players: { id: string; pos: Position }[]) => {
        let total = 0;
        for (const w of future) total += bestLineup(players.map((p) => ({ id: p.id, pos: p.pos, points: actual.get(`${p.id}:${w}`) ?? 0 })), config).total;
        return total;
      };
      const base = realized(roster);
      const withA = realized([...roster.filter((p) => p.id !== a.drop?.id), a.add]);
      const withB = realized([...roster.filter((p) => p.id !== bDrop.id), bAdd]);
      addA += withA - base; addB += withB - base; m2++;
      if (a.add.id === bAdd.id) same++;
    }
  }
  log(`## Gate L2 — waiver replay (${m2} rosters, next ${HORIZON} weeks, realized lineup points added)`);
  log(`- value-over-my-lineup claim: +${(addA / m2).toFixed(2)} pts per roster`);
  log(`- generic ROS-rank claim:     +${(addB / m2).toFixed(2)} pts per roster`);
  log(`- same player chosen in ${same} of ${m2}`);
  log(`- ${addA >= addB ? "PASS" : "FAIL"} — lineup-aware claims ${addA >= addB ? "add at least as much" : "add less"} realized lineup value\n`);

  // ---------------------------------------------------------------- Gate L3
  log(`## Gate L3 — playoff odds calibration`);
  log(`- NOT RUN — needs historical league standings and rosters, which do not exist yet. Every Sleeper sync stores a LeagueSnapshot (lib/client/teams.ts); after a season of them, bucket mid-season odds and check that teams given ~70% made it ~70% of the time.\n`);

  // ---------------------------------------------------------------- write
  const start = "<!-- leg-b:start -->", end = "<!-- leg-b:end -->";
  const block = `${start}\n${lines.join("\n")}\n${end}`;
  let doc = existsSync(GATES) ? readFileSync(GATES, "utf8") : "# Backtest gates\n\n";
  doc = doc.includes(start) ? doc.replace(new RegExp(`${start}[\\s\\S]*${end}`), block) : `${doc.trimEnd()}\n\n${block}\n`;
  writeFileSync(GATES, doc);
  console.log(`\nwrote ${GATES}`);
}

main();
```

- [ ] **Step 6: Add the script and run it**

Add `"backtest:lineup": "tsx scripts/backtest-lineup.ts"` to `package.json` scripts, then:

```bash
pnpm backtest:lineup -- --holdout=2025 --matchups=150
```

Expected: it runs in well under a few minutes and prints both gate verdicts plus the L3 NOT RUN line, and writes the block into `docs/backtest-gates.md`. **Report the verdicts exactly as printed.** Then run it once more with `--holdout=2024` and report whether the verdicts agree across the two seasons. If L1 is a statistical tie (|z| < 1.96), say so — that is the expected outcome given Leg A's finding that Sleeper's mean already carries the signal and only the spread and correlation are fitted; a tie means the objective does no harm, and a win means the distribution is worth something. Either is a result. Do not change SIMS, MIN_PROJ, the roster shape, or the gate definition after seeing numbers.

- [ ] **Step 7: Sanity-check the harness itself**

Before trusting L1, run one deliberately broken variant locally (do not commit): make arm B start the LOWEST projections instead of `recommended`. Its win rate must collapse well below arm A's. If it does not, the realized scoring or the pairing is wrong and the gate is measuring nothing. Note the broken-arm win rate in your report and revert.

- [ ] **Step 8: Commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add lib/engine/season/replay.ts scripts/backtest-lineup.ts tests/seasonReplay.test.ts docs/backtest-gates.md package.json
git commit -m "Season: replay gates for start/sit and waivers on synthetic leagues over historical player-weeks"
```

---

## Self-Review

**Amendments to Tasks 1–6 made while writing 7–16** (before any Leg B task was implemented, so no code moved):

- **Task 3 and Task 4 were redesigned.** The first draft re-optimised the lineup inside every simulated draw and then "swapped" two players by reordering the same player array — the win probability could only move by RNG-stream noise, so every swap delta would have been noise and the two headline tests (ceiling when underdog, floor when favourite) would have failed or passed by accident. Lineups are now fixed sets scored by index against ONE joint draw, swaps are paired comparisons on the same draws, and every statistical expectation in both test files was pre-computed by the controller with the final algorithm (values in the comments). The perf budget is met with a wide margin (15 ms for the draw, 4 ms per hundred lineup evaluations).
- **Task 4 gained `config/season.json` + `levers.ts`.** Three tuned numbers (forced-play threshold, minimum delta, and the risk dial) were hardcoded; the standing rule puts them in config with a validated loader and an exact off state. The risk dial ships at 0.
- **Task 4 gained a manual-opponent model** (`Opponent.kind === "total"`): the spec says a manual league models the opponent from a projected total and the UI says so. The first draft passed an empty opponent, which makes every win probability 1 and every swap worthless.
- **Task 2's exactness claim was corrected.** With one FLEX kind and one eligibility set (all `RosterSlots` can express), the greedy `optimalLineupTotal` is exact — any k eligible leftovers fill k identical flex slots. `bestLineup`'s value is the *assignment* (who sits where) and the bench list, which advice and the UI need. `season.ts` is therefore NOT migrated (Task 15 records why in its doc comment), and the spec's sentence is amended. The Task 2 test named "is EXACT with two flex slots, where a greedy fill is not" is renamed to describe what it checks.
- **Task 1's `applyRoster` takes an optional slots override** (a platform that knows starters says so), and `SavedTeam` gains `league?: LeagueSnapshot` (Task 7), `regularSeasonEnd?`, `oppProjectedTotal?` (Task 13).
- **Task 6's markup now uses the repo's design tokens** (`border-line`, `bg-panel`, `text-ink-dim`, `text-warn`, …) instead of Tailwind `neutral-*` greys, per the "match the existing visual language" constraint, and its `RosterImport` carries the tab state Tasks 7–9 fill in. It passes `starterIds` from the saved slots and the opponent as a projected total.

**Spec coverage** — every section of `2026-09-09-in-season-cockpit-design.md` maps to a task:

| Spec section | Task |
|---|---|
| Teams registry, `SavedTeam`, localStorage, many leagues | 1 (+7 `LeagueSnapshot`, +13 fields) |
| Four ingestion paths → one `applyRoster` | 1 (funnel), 6 (manual), 7 (Sleeper), 8 (paste), 9 (OCR) |
| Sleeper sync: free-agent pool, real scoring, opponent + their starters | 7, consumed in 13 |
| Manual/OCR degrade gracefully: opponent from a projected total, UI says so | 4 (`Opponent.kind: "total"`), 6, 13 |
| `bestLineup` exact assignment; `season.ts` migration | 2; migration NOT done — greedy is exact for the app's roster model (see amendments, Task 15 Step 4) |
| `winProbability` from one correlated joint sim | 3 |
| `startSitAdvice` ranked by Δ P(win), Δ points alongside, reason line | 4 |
| Forced swaps first (bye / Out / late inactive via live signals), config threshold | 4 (`forcedPlayThreshold`), 14 (live) |
| Playoff odds: remaining schedule, seed distribution, elimination number | 10 |
| Odds set the risk dial; `riskFromPlayoffOdds: 0` reproduces pure Δ P(win) | 4 (objective blend), 10 (`leverage`), 13 (wiring); off state tested exactly |
| Waivers: value over MY lineup, drop candidate, bye/injury cover effect | 11 |
| Streaming = same function, one position, one week | 11 |
| Trade on three axes | 12 |
| Surface order: Must fix → Lineup → Matchup → Waivers → Playoff odds → Trades | 6, 13 |
| Live signals via `useLiveSignals` + pure grader | 14 (`gradeOutlooks`, sibling of `gradeBoard` to avoid an import cycle) |
| Replay gate (win rate, not points) | 16 (L1, synthetic leagues over real player-weeks) |
| Waiver gate | 16 (L2) |
| Playoff odds calibration | 16 (L3 — **NOT RUN**, no league history; forward path recorded) |
| Budget: `startSitAdvice` < 150 ms @ 2,000 sims; playoff odds background | 15, 13 |
| Testing: adversarial slot cases, fixture-based ingestion parsing, seeded end-to-end determinism | 2, 7–9, 4 (`is deterministic`) |

**Known limitations, stated rather than hidden:**
- The remaining-weeks simulation (playoff odds, waivers beyond this week, trades) prices future weeks with the season outcome model, not Leg A's weekly sampler, because no `WeekOutlook` exists for future weeks. The current week uses the weekly board wherever the engine reads points.
- Unknown future pairings are simulated against a random opponent and the UI says through which week pairings are known.
- Sleeper's exact scoring is mapped to the nearest board format (`formatFromScoring`); custom bonuses are not re-scored (same as the draft side today).
- `leadingSlot` treats a bare single-letter `K` at the start of a line as the kicker slot but `K.` (with a period) as an initial; a roster page that writes initials without periods would mis-slot that one line (slot only, never the player).
- Gate L3 cannot run until league snapshots have accumulated; every Sleeper sync now stores one.

**Type consistency.** `SavedTeam`, `RosterEntry`, `LeagueSnapshot` (Tasks 1, 7); `LineupPlayer`, `Lineup`, `bestLineup`, `winProbability`, `matchupWinProbability` (2–3); `AdvicePlayer`, `Opponent`, `AdviceInput`, `Swap`, `ForcedSwap`, `TotalSummary`, `Advice`, `startSitAdvice`, `toSimPlayer`, `SeasonLevers`, `DEFAULT_SEASON_LEVERS` (4); `SleeperLeagueInfo`, `SleeperRoster`, `SleeperMatchup`, `SleeperUser`, `teamFromSleeper` (7); `RosterSlot`, `leadingSlot`, `headerSlot`, `parseRosterPaste` (8, consumed by 9); `readRosterLines` (9); `LeagueTeamInput`, `PlayoffInput`, `PlayoffOdds`, `playoffOdds`, `eliminationNumber` (10, consumed by 12, 13); `RosContext`, `weeklyMeans`, `meansFor`, `rosLineupValue`, `emptySlotWeeks`, `DEFAULT_OUTCOME`, `WaiverInput`, `WaiverAdd`, `waiverAdds`, `streamingOptions` (11, consumed by 12, 13, 15, 16); `TradeLeagueContext`, `TradeInput`, `TradeVerdict`, `evaluateTrade` (12); `gradeOutlooks` (14); `histRowToOutlook`, `realizedPoints`, `sampleRoster`, `histRowToBoardPlayer` (16). Each is defined in exactly one task and imported by name thereafter. `Opponent` is a discriminated union on `kind`; every consumer switches on it.

**Pre-verification done while writing.** Tasks 10, 11 and 12's module code and tests were extracted verbatim and run against the real engine: 32/32 pass after three fixture corrections (a clinched team's elimination number is finite, a test helper minted distinct teams per call, a 110-point TE really does take the flex). Task 8's and 9's fixture lines were run through the real `nameMatch`/`ocrMatch` (all resolve, the tie case resolves to nothing). Task 3's and 4's statistical expectations were computed with the final algorithm at the stated seeds. Task 7's shapes were read live from Sleeper on 2026-09-09.

**No placeholders.** Every step carries runnable code or an exact command. Where a step asks the implementer to judge rather than transcribe (Task 6 Step 6, Task 10 Step 5, Task 16 Step 7), it says what to look at and what to report.
