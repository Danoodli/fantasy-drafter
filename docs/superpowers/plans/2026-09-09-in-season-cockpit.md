# In-Season Cockpit (Leg B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly surface at `/season` that tells you who to start, who to swap in for a bye or an injury, who to claim off waivers, and whether a trade helps — ranked by the probability you win *this* matchup rather than by expected points.

**Architecture:** Pure engine modules under `lib/engine/season/` compute lineups, win probability, advice, waivers, playoff odds and trades from Leg A's `WeekOutlook` and correlated sampler. A localStorage teams registry (`lib/client/teams.ts`) holds any number of leagues, populated by four ingestion paths that all terminate in one `applyRoster`. The UI is a client component at `app/season/` reusing the cockpit's visual language.

**Tech Stack:** TypeScript, Next.js App Router (client components), React 19, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-in-season-cockpit-design.md` — read it before Task 1 and keep it open.

**Depends on:** Leg A (`docs/superpowers/plans/2026-09-09-weekly-projection-engine.md`). Tasks 1–14 of that plan are complete; `WeekOutlook`, `weekSim`, and `public/data/week-{season}-{week}-{format}.json` all exist and are tested.

## Global Constraints

- **`lib/engine/**` is PURE**: no I/O, no `Date.now()`, no `Math.random()`. Randomness only via `makeRng(seed)` from `lib/engine/montecarlo.ts`. Unit-tested and replayed, so a violation breaks determinism.
- **All I/O lives in `lib/client/` (browser) or `lib/etl/` (Node).** Never import `lib/etl/*` from a component.
- **This repo runs a Next.js version with breaking changes from training data.** Before writing anything under `app/`, read `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md` and `05-server-and-client-components.md`. Existing precedent: `app/page.tsx` and `app/newsroom/page.tsx` are both `"use client"` at the top because they need `localStorage` and interactivity. Follow that.
- **No paid services, no API keys.** Sleeper's league API is free and keyless.
- **Levers are config, not code.** Never hardcode a tuned number in a branch.
- **`WeekOutlook.projected === false` must never render as `0.0`.** It means no source had an opinion; a bye and an "Out" designation also produce `mean: 0` and are entirely different facts. Render "—" or "no projection".
- **Match the existing visual language.** Read `components/Cockpit.tsx` and `components/TierBoard.tsx` before writing UI. Tailwind v4, same spacing and type scale. Do not introduce a new design system.
- **`pnpm test`, `pnpm exec tsc --noEmit` and `pnpm lint` are all clean and must stay so.** Commit on the current branch; check `git branch --show-current` first.
- **Perf budget:** `startSitAdvice` for a 15-man roster at 2,000 sims must run under 150 ms. Playoff odds is a background compute with a spinner, not a keystroke path.
- Blank line before any `Co-Authored-By:` trailer.

## File Structure

| File | Responsibility |
|---|---|
| `lib/client/teams.ts` | localStorage registry of saved teams; `applyRoster` funnel |
| `lib/client/weekBoard.ts` | fetch + cache `week-{season}-{week}-{format}.json` |
| `lib/engine/season/lineup.ts` | exact `bestLineup`, `winProbability` |
| `lib/engine/season/advice.ts` | `startSitAdvice`, forced swaps |
| `lib/engine/season/waivers.ts` | `waiverAdds`, streaming |
| `lib/engine/season/playoffOdds.ts` | rest-of-season sim, risk dial |
| `lib/engine/season/trade.ts` | three-axis trade evaluation |
| `lib/season/sleeperLeague.ts` | Sleeper league/roster/matchup fetch (Node-free, browser-safe) |
| `lib/season/rosterPaste.ts` | paste parsing (pure) |
| `app/season/page.tsx` | route shell, loads config + week board + team |
| `components/season/SeasonCockpit.tsx` | top-level layout and section order |
| `components/season/LineupTable.tsx` | starters/bench with swap rows |
| `components/season/RosterImport.tsx` | the four ingestion paths |

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

### Task 2: Exact best lineup

The existing `optimalLineupTotal` in `lib/engine/season.ts:17` is greedy — exact for a single flex, silently wrong for superflex or two flex slots. Start/sit is precisely where that bites, so this replaces it.

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
    // Leftovers are rb3 8, wr3 13, so the flex takes wr3.
    expect(l.starters.find((s) => s.slot === "FLEX")?.player.id).toBe("wr3");
  });

  it("is EXACT with two flex slots, where a greedy fill is not", () => {
    // Greedy would fill FLEX twice from the same sorted leftover list, which
    // happens to be right here — the discriminating case is superflex below.
    const l = bestLineup(
      [p("qb1", "QB", 20), p("rb1", "RB", 12), p("rb2", "RB", 9), p("rb3", "RB", 10), p("wr1", "WR", 14), p("wr2", "WR", 11), p("wr3", "WR", 13), p("te1", "TE", 8), p("te2", "TE", 12), p("k1", "K", 7), p("d1", "DST", 6)],
      cfg({ rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1 } })
    );
    const flex = l.starters.filter((s) => s.slot === "FLEX").map((s) => s.player.id).sort();
    // Leftovers: rb3 10, wr3 13, te2 12 -> take wr3 and te2.
    expect(flex).toEqual(["te2", "wr3"]);
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

  it("is deterministic on ties", () => {
    const players = [p("a", "RB", 10), p("b", "RB", 10), p("c", "RB", 10)];
    const one = bestLineup(players, cfg());
    const two = bestLineup([...players].reverse(), cfg());
    expect(one.total).toBeCloseTo(two.total, 10);
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

  let bestFlex: LineupPlayer[] = [];
  let bestGain = -1;
  if (flexSlots > 0 && eligible.length > 0) {
    for (const alloc of allocations(eligible.length, flexSlots)) {
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
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the superflex case genuinely discriminates**

The superflex test is the one that a greedy implementation fails. Confirm by reasoning: a greedy that fills dedicated slots then sorts *all* leftovers would also pick `qb2` here, because `qb2` is the highest leftover. The allocation search matters when a position's *second* flex candidate beats another position's *first* — which the two-flex test covers. Note in your report which test you believe is the discriminating one and why; if you conclude none of them truly discriminates greedy from exact, say so rather than assuming the coverage is adequate.

- [ ] **Step 6: Commit**

```bash
git add lib/engine/season/lineup.ts tests/seasonLineup.test.ts
git commit -m "Season: exact best lineup by flex allocation search"
```

---

### Task 3: Win probability from correlated draws

**Files:**
- Modify: `lib/engine/season/lineup.ts` (append)
- Test: `tests/seasonWinProb.test.ts`

**Interfaces:**
- Consumes: `bestLineup` (Task 2); `simulateWeek`, `WeekSimPlayer` from `lib/engine/weekSim.ts`; `WeeklyModelParams` from `lib/engine/weekly/model.ts`.
- Produces: `winProbability(mine: WeekSimPlayer[], theirs: WeekSimPlayer[], config: LeagueConfig, p: WeeklyModelParams, sims: number, seed: number): number`

The whole reason this exists rather than comparing expected totals: both rosters are drawn from the **same** simulated week, so a shared game between one of your players and one of theirs is handled correctly instead of assumed independent. And the lineup is re-optimised inside each draw, which is what actually happens on Sunday.

- [ ] **Step 1: Write the failing test**

```ts
// tests/seasonWinProb.test.ts
import { describe, it, expect } from "vitest";
import { winProbability } from "../lib/engine/season/lineup";
import { DEFAULT_WEEKLY_MODEL } from "../lib/engine/weekly/model";
import type { WeekSimPlayer } from "../lib/engine/weekSim";
import type { LeagueConfig } from "../lib/types";

const cfg: LeagueConfig = {
  platform: "manual", leagueId: "", draftId: "", myDraftSlot: null,
  teams: 12, rounds: 15, scoring: "ppr", leagueType: "redraft",
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  flexEligible: ["RB", "WR", "TE"], strategy: "balanced",
};

const sp = (id: string, pos: WeekSimPlayer["pos"], mean: number, over: Partial<WeekSimPlayer> = {}): WeekSimPlayer => ({
  id, pos, team: id.slice(0, 3).toUpperCase(), gameId: `G-${id}`, opp: "OPP",
  meanIfPlays: mean, sigma: 0.6, pPlay: 1, stats: {}, ...over,
});

/** A legal-ish roster: one of each dedicated slot plus a flex candidate. */
const roster = (prefix: string, mean: number): WeekSimPlayer[] => [
  sp(`${prefix}qb`, "QB", mean), sp(`${prefix}r1`, "RB", mean), sp(`${prefix}r2`, "RB", mean),
  sp(`${prefix}w1`, "WR", mean), sp(`${prefix}w2`, "WR", mean), sp(`${prefix}te`, "TE", mean),
  sp(`${prefix}k`, "K", mean), sp(`${prefix}ds`, "DST", mean), sp(`${prefix}w3`, "WR", mean),
];

describe("winProbability", () => {
  it("is near 0.5 between identical rosters", () => {
    const wp = winProbability(roster("a", 12), roster("b", 12), cfg, DEFAULT_WEEKLY_MODEL, 3000, 11);
    expect(wp).toBeGreaterThan(0.42);
    expect(wp).toBeLessThan(0.58);
  });

  it("rises with a stronger roster and falls with a weaker one", () => {
    const strong = winProbability(roster("a", 18), roster("b", 12), cfg, DEFAULT_WEEKLY_MODEL, 3000, 7);
    const weak = winProbability(roster("a", 8), roster("b", 12), cfg, DEFAULT_WEEKLY_MODEL, 3000, 7);
    expect(strong).toBeGreaterThan(0.75);
    expect(weak).toBeLessThan(0.25);
  });

  it("is monotone in my own strength", () => {
    const seq = [8, 10, 12, 14, 16].map((m) =>
      winProbability(roster("a", m), roster("b", 12), cfg, DEFAULT_WEEKLY_MODEL, 4000, 3)
    );
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1] - 0.02);
  });

  it("is deterministic for a given seed", () => {
    const a = winProbability(roster("a", 12), roster("b", 13), cfg, DEFAULT_WEEKLY_MODEL, 1000, 99);
    const b = winProbability(roster("a", 12), roster("b", 13), cfg, DEFAULT_WEEKLY_MODEL, 1000, 99);
    expect(a).toBe(b);
  });

  it("counts a tie as half a win rather than a loss", () => {
    // Two rosters of a single deterministic player each: sigma 0 makes every
    // draw identical, so every simulated week is an exact tie.
    const one = [sp("x", "QB", 10, { sigma: 0 })];
    const two = [sp("y", "QB", 10, { sigma: 0 })];
    expect(winProbability(one, two, cfg, DEFAULT_WEEKLY_MODEL, 200, 1)).toBeCloseTo(0.5, 6);
  });

  it("treats a player who cannot play as contributing nothing", () => {
    const mine = roster("a", 12);
    const crippled = mine.map((x) => ({ ...x, pPlay: 0 }));
    expect(winProbability(crippled, roster("b", 12), cfg, DEFAULT_WEEKLY_MODEL, 500, 5)).toBeLessThan(0.02);
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
 * P(my optimal lineup outscores theirs this week).
 *
 * This is the objective the whole surface ranks by, and it is not the same as
 * comparing expected totals. Two properties matter:
 *
 * 1. Both rosters are drawn from the SAME simulated week, so if one of my
 *    players shares a game with one of theirs, that correlation is real rather
 *    than assumed away. A shootout lifts both sides at once.
 * 2. Each side's lineup is re-optimised WITHIN every draw, which is what
 *    actually happens — you are not locked into the lineup that looked best in
 *    expectation.
 *
 * A tie counts as half a win, which is how head-to-head leagues score it.
 */
export function winProbability(
  mine: WeekSimPlayer[],
  theirs: WeekSimPlayer[],
  config: LeagueConfig,
  p: WeeklyModelParams,
  sims: number,
  seed: number
): number {
  if (mine.length === 0 && theirs.length === 0) return 0.5;
  // One joint draw set over both rosters — this is what keeps shared games
  // correlated. Splitting into two calls would silently assume independence.
  const all = [...mine, ...theirs];
  const draws = simulateWeek(all, p, sims, seed);
  const mineCount = mine.length;

  let wins = 0;
  let ties = 0;
  for (const draw of draws) {
    const myLineup = bestLineup(
      mine.map((pl, i) => ({ id: pl.id, pos: pl.pos, points: draw[i] })),
      config
    ).total;
    const theirLineup = bestLineup(
      theirs.map((pl, i) => ({ id: pl.id, pos: pl.pos, points: draw[mineCount + i] })),
      config
    ).total;
    if (myLineup > theirLineup) wins++;
    else if (myLineup === theirLineup) ties++;
  }
  return (wins + ties / 2) / draws.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonWinProb.test.ts`
Expected: PASS, 6 tests. These are statistical with generous margins; a genuine failure means the structure is wrong, not bad luck. If one fails, print the computed probability before touching a tolerance.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/season/lineup.ts tests/seasonWinProb.test.ts
git commit -m "Season: win probability from one joint correlated draw"
```

---

### Task 4: Start/sit advice ranked by Δ P(win)

**This is the headline feature.** It will sometimes tell you to bench the higher projection, and the reason line has to make that legible rather than mysterious.

**Files:**
- Create: `lib/engine/season/advice.ts`
- Test: `tests/seasonAdvice.test.ts`

**Interfaces:**
- Consumes: `bestLineup`, `winProbability` (Tasks 2–3); `WeekOutlook` from `lib/engine/weekly/outlook.ts`; `WeekSimPlayer`; `WeeklyModelParams`; `SavedTeam` from `lib/client/teams.ts` (type only).
- Produces:
  - `interface AdviceInput { players: { id: string; pos: Position; team: string; name: string; outlook: WeekOutlook }[]; oppPlayers: { id: string; pos: Position; team: string; outlook: WeekOutlook }[]; config: LeagueConfig; params: WeeklyModelParams; sims?: number; seed?: number }`
  - `interface Swap { inId: string; outId: string; inName: string; outName: string; deltaWin: number; deltaPoints: number; reason: string }`
  - `interface ForcedSwap { outId: string; outName: string; why: "bye" | "out" | "no-projection"; bestReplacementId: string | null; bestReplacementName: string | null }`
  - `interface Advice { winProbability: number; forced: ForcedSwap[]; swaps: Swap[]; lineup: Lineup }`
  - `startSitAdvice(input: AdviceInput): Advice`
  - `toSimPlayer(p: { id: string; pos: Position; team: string; outlook: WeekOutlook }): WeekSimPlayer`

- [ ] **Step 1: Write the failing test**

```ts
// tests/seasonAdvice.test.ts
import { describe, it, expect } from "vitest";
import { startSitAdvice, toSimPlayer, type AdviceInput } from "../lib/engine/season/advice";
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

const me = (id: string, pos: Position, mean: number, over: Partial<WeekOutlook> = {}) =>
  ({ id, pos, team: "DET", name: id, outlook: ol(mean, { playerId: id, ...over }) });

const them = (id: string, pos: Position, mean: number) =>
  ({ id, pos, team: "CHI", outlook: ol(mean, { playerId: id }) });

const input = (over: Partial<AdviceInput> = {}): AdviceInput => ({
  players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wr", "WR", 11), me("bench", "WR", 10)],
  oppPlayers: [them("oqb", "QB", 18), them("orb", "RB", 12), them("owr", "WR", 11)],
  config: cfg, params: DEFAULT_WEEKLY_MODEL, sims: 2000, seed: 5, ...over,
});

describe("startSitAdvice", () => {
  it("reports a win probability and the current best lineup", () => {
    const a = startSitAdvice(input());
    expect(a.winProbability).toBeGreaterThan(0);
    expect(a.winProbability).toBeLessThan(1);
    expect(a.lineup.starters.map((s) => s.player.id)).toContain("qb");
  });

  it("flags a bye as a FORCED swap, not an optional one", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 0, { pPlay: 0, mean: 0, opp: null }), me("wr", "WR", 11), me("rb2", "RB", 9)],
    }));
    const forced = a.forced.find((f) => f.outId === "rb");
    expect(forced?.why).toBe("bye");
    expect(forced?.bestReplacementId).toBe("rb2");
  });

  it("flags an Out designation separately from a bye", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 1, { pPlay: 0.02, mean: 0.02, drivers: { ...ol(1).drivers, status: "Out" } }), me("wr", "WR", 11), me("rb2", "RB", 9)],
    }));
    expect(a.forced.find((f) => f.outId === "rb")?.why).toBe("out");
  });

  it("flags a player no source projected, never treating him as a zero", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("ghost", "RB", 0, { projected: false, mean: 0 }), me("wr", "WR", 11), me("rb2", "RB", 9)],
    }));
    expect(a.forced.find((f) => f.outId === "ghost")?.why).toBe("no-projection");
  });

  it("ranks swaps by delta win probability and reports delta points alongside", () => {
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 18), me("rb", "RB", 12), me("wrLow", "WR", 6), me("wrHigh", "WR", 15)],
    }));
    const top = a.swaps[0];
    expect(top.inId).toBe("wrHigh");
    expect(top.outId).toBe("wrLow");
    expect(top.deltaWin).toBeGreaterThan(0);
    expect(top.deltaPoints).toBeGreaterThan(0);
    expect(top.reason).toMatch(/\S/);
  });

  it("prefers the CEILING when I am a heavy underdog, even at lower projected points", () => {
    // Opponent is far stronger, so the only path is variance.
    const boring = me("boring", "WR", 11, { sigma: 0.2, p90: 14 });
    const swingy = me("swingy", "WR", 10, { sigma: 1.3, p90: 34 });
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 10), me("rb", "RB", 8), boring, swingy],
      oppPlayers: [them("oqb", "QB", 26), them("orb", "RB", 24), them("owr", "WR", 22)],
    }));
    const swap = a.swaps.find((s) => s.inId === "swingy" && s.outId === "boring");
    expect(swap).toBeDefined();
    expect(swap!.deltaWin).toBeGreaterThan(0);
    // The counter-intuitive part: it gains win probability while LOSING points.
    expect(swap!.deltaPoints).toBeLessThan(0);
  });

  it("prefers the FLOOR when I am a heavy favourite", () => {
    const boring = me("boring", "WR", 11, { sigma: 0.2, p90: 14 });
    const swingy = me("swingy", "WR", 12, { sigma: 1.3, p90: 40 });
    const a = startSitAdvice(input({
      players: [me("qb", "QB", 26), me("rb", "RB", 24), swingy, boring],
      oppPlayers: [them("oqb", "QB", 8), them("orb", "RB", 7), them("owr", "WR", 6)],
    }));
    const swap = a.swaps.find((s) => s.inId === "boring" && s.outId === "swingy");
    expect(swap).toBeDefined();
    expect(swap!.deltaWin).toBeGreaterThan(0);
  });

  it("is deterministic for a given seed", () => {
    expect(JSON.stringify(startSitAdvice(input()))).toBe(JSON.stringify(startSitAdvice(input())));
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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/seasonAdvice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

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
import type { LeagueConfig, Position } from "../../types";
import type { WeekOutlook } from "../weekly/outlook";
import type { WeeklyModelParams } from "../weekly/model";
import type { WeekSimPlayer } from "../weekSim";
import { bestLineup, winProbability, type Lineup } from "./lineup";

export interface AdvicePlayer {
  id: string;
  pos: Position;
  team: string;
  outlook: WeekOutlook;
}

export interface AdviceInput {
  players: (AdvicePlayer & { name: string })[];
  oppPlayers: AdvicePlayer[];
  config: LeagueConfig;
  params: WeeklyModelParams;
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

export interface Advice {
  winProbability: number;
  forced: ForcedSwap[];
  swaps: Swap[];
  lineup: Lineup;
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

/** Enough of a win-probability move to be worth showing. */
const MIN_DELTA_WIN = 0.002;

function reasonFor(swap: { deltaWin: number; deltaPoints: number }, wp: number, inO: WeekOutlook, outO: WeekOutlook): string {
  const pts = swap.deltaPoints;
  const pct = (swap.deltaWin * 100).toFixed(1);
  if (pts < -0.05) {
    // The counter-intuitive case, which is the whole point of the feature.
    return `+${pct}% to win despite ${pts.toFixed(1)} projected points — you are behind, and his ${inO.p90.toFixed(0)}-point ceiling is the path`;
  }
  if (wp > 0.7 && inO.sigma < outO.sigma) {
    return `+${pct}% to win: you are ahead, so the safer floor (${inO.p10.toFixed(0)} vs ${outO.p10.toFixed(0)}) protects the lead`;
  }
  return `+${pct}% to win and +${pts.toFixed(1)} projected points`;
}

export function startSitAdvice(input: AdviceInput): Advice {
  const { players, oppPlayers, config, params } = input;
  const sims = input.sims ?? DEFAULT_SIMS;
  const seed = input.seed ?? DEFAULT_SEED;
  const nameOf = new Map(players.map((p) => [p.id, p.name] as const));

  const mineSim = players.map(toSimPlayer);
  const theirsSim = oppPlayers.map(toSimPlayer);
  const baseWin = winProbability(mineSim, theirsSim, config, params, sims, seed);

  // Current best lineup on expected points — what the user is looking at.
  const lineup = bestLineup(
    players.map((p) => ({ id: p.id, pos: p.pos, points: p.outlook.mean })),
    config
  );
  const startingIds = new Set(lineup.starters.map((s) => s.player.id));

  // --- forced swaps: a starter who cannot or might not play at all ---------
  const forced: ForcedSwap[] = [];
  for (const s of lineup.starters) {
    const p = players.find((x) => x.id === s.player.id);
    if (!p) continue;
    const o = p.outlook;
    let why: ForcedSwap["why"] | null = null;
    if (!o.projected) why = "no-projection";
    else if (o.opp === null) why = "bye";
    else if (o.pPlay <= 0.1) why = "out";
    if (!why) continue;
    const replacement = lineup.benched.find(
      (b) => players.find((x) => x.id === b.id)?.pos === p.pos && (players.find((x) => x.id === b.id)?.outlook.pPlay ?? 0) > 0.1
    );
    forced.push({
      outId: p.id,
      outName: p.name,
      why,
      bestReplacementId: replacement?.id ?? null,
      bestReplacementName: replacement ? nameOf.get(replacement.id) ?? null : null,
    });
  }

  // --- optional swaps: every legal bench-for-starter exchange -------------
  const swaps: Swap[] = [];
  for (const benchPl of lineup.benched) {
    const inP = players.find((x) => x.id === benchPl.id);
    if (!inP || inP.outlook.pPlay <= 0) continue;
    for (const s of lineup.starters) {
      const outP = players.find((x) => x.id === s.player.id);
      if (!outP) continue;
      // Only a legal exchange: same position, or both flex-eligible.
      const sameSlot = inP.pos === outP.pos;
      const bothFlex = s.slot === "FLEX" && config.flexEligible.includes(inP.pos);
      if (!sameSlot && !bothFlex) continue;

      // Re-run the whole matchup with the two swapped, using the SAME seed so
      // the comparison is against an identical simulated week.
      const swapped = mineSim.map((x) =>
        x.id === outP.id ? toSimPlayer(inP) : x.id === inP.id ? toSimPlayer(outP) : x
      );
      const wp = winProbability(swapped, theirsSim, config, params, sims, seed);
      const deltaWin = wp - baseWin;
      if (deltaWin < MIN_DELTA_WIN) continue;
      const deltaPoints = inP.outlook.mean - outP.outlook.mean;
      const swap = {
        inId: inP.id, outId: outP.id,
        inName: inP.name, outName: outP.name,
        deltaWin, deltaPoints,
        reason: "",
      };
      swap.reason = reasonFor(swap, baseWin, inP.outlook, outP.outlook);
      swaps.push(swap);
    }
  }
  swaps.sort((a, b) => b.deltaWin - a.deltaWin || a.inId.localeCompare(b.inId));

  return { winProbability: baseWin, forced, swaps, lineup };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/seasonAdvice.test.ts`
Expected: PASS, 10 tests.

The two most important are `prefers the CEILING when I am a heavy underdog` and `prefers the FLOOR when I am a heavy favourite`. **If either fails, do not adjust its tolerance — report it.** They are the feature's entire justification, and if the win-probability objective does not actually produce that behaviour then the design is wrong, not the test.

- [ ] **Step 5: Commit**

```bash
git add lib/engine/season/advice.ts tests/seasonAdvice.test.ts
git commit -m "Season: start/sit ranked by delta win probability, forced swaps first"
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
Expected: PASS, 6 tests.

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
- Modify: `app/page.tsx` (add a link to `/season`)

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
        <p className="mt-4 text-red-400">Could not load week {week}: {error}</p>
        <p className="mt-2 text-neutral-400">
          Build it with <code className="rounded bg-neutral-800 px-1">pnpm build:week -- --week={week}</code>.
        </p>
      </main>
    );
  }

  if (!board || !outlooks) {
    return <main className="mx-auto max-w-3xl p-6 text-sm text-neutral-400">Loading week {week}…</main>;
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

Later tasks add Sleeper, paste and OCR beside it, so give it a tab strip with one live tab and the others visibly present but disabled, rather than a layout that has to be rebuilt.

```tsx
// components/season/RosterImport.tsx
"use client";

import { useMemo, useState } from "react";
import type { Board } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";

/**
 * The four ingestion paths live here and every one of them ends in
 * applyRoster, so undo, persistence and the engine all see one kind of roster
 * change — the same discipline as useDraft.applyImport for draft picks.
 */
export default function RosterImport({
  board,
  team,
  onChange,
}: {
  board: Board;
  team: SavedTeam;
  onChange: (t: SavedTeam) => void;
}) {
  const [query, setQuery] = useState("");
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
    <section className="rounded-lg border border-neutral-800 p-4">
      <h2 className="text-sm font-semibold">Your roster</h2>
      <div className="mt-2 flex gap-2 text-xs">
        <span className="rounded bg-neutral-800 px-2 py-1">Manual</span>
        <span className="rounded px-2 py-1 text-neutral-600" title="Coming in a later task">Sleeper</span>
        <span className="rounded px-2 py-1 text-neutral-600" title="Coming in a later task">Paste</span>
        <span className="rounded px-2 py-1 text-neutral-600" title="Coming in a later task">Screen sync</span>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Add a player by name…"
        className="mt-3 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      />
      {matches.length > 0 && (
        <ul className="mt-1 rounded border border-neutral-700 text-sm">
          {matches.map((p) => (
            <li key={p.id}>
              <button onClick={() => add(p.id)} className="w-full px-2 py-1 text-left hover:bg-neutral-800">
                {p.name} <span className="text-neutral-500">{p.pos} · {p.team}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-neutral-500">{team.roster.length} players</p>
      <ul className="mt-1 flex flex-wrap gap-1">
        {team.roster.map((r) => {
          const p = board.players.find((x) => x.id === r.playerId);
          return (
            <li key={r.playerId} className="rounded bg-neutral-800 px-2 py-0.5 text-xs">
              {p?.name ?? r.playerId}
              <button onClick={() => remove(r.playerId)} className="ml-1 text-neutral-500 hover:text-neutral-200" aria-label={`Remove ${p?.name ?? r.playerId}`}>
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

/** A projection cell. Never shows 0.0 for "we have no number". */
function Points({ o }: { o: WeekOutlook | undefined }) {
  if (!o || !o.projected) return <span className="text-neutral-600" title="No source projected this player">—</span>;
  if (o.opp === null) return <span className="text-amber-500" title="On a bye">BYE</span>;
  if (o.pPlay <= 0.1) return <span className="text-red-400" title={o.drivers.status ?? "Out"}>{o.drivers.status ?? "OUT"}</span>;
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
      <tr key={`${slot}-${id}`} className="border-t border-neutral-800">
        <td className="py-1 pr-2 text-xs text-neutral-500">{slot}</td>
        <td className="py-1 pr-2">{p?.name ?? id}</td>
        <td className="py-1 pr-2 text-xs text-neutral-500">{p?.pos} · {p?.team}</td>
        <td className="py-1 pr-2 text-xs text-neutral-500">{o?.opp ?? "—"}</td>
        <td className="py-1 pr-2 text-right tabular-nums"><Points o={o} /></td>
        <td className="py-1 text-right text-xs tabular-nums text-neutral-500">
          {o && o.projected && o.opp !== null ? `${o.p10.toFixed(0)}–${o.p90.toFixed(0)}` : ""}
        </td>
      </tr>
    );
  };

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-neutral-500">
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
          <tr className="border-t border-neutral-700">
            <td colSpan={6} className="pt-2 text-xs uppercase tracking-wide text-neutral-500">Bench</td>
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
import { loadTeams, saveTeam, applyRoster, type SavedTeam } from "../../lib/client/teams";
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
    // No opponent roster yet — Task 7 supplies one from Sleeper. Until then the
    // matchup is against a league-average score, and the UI says so rather
    // than pretending the win probability is precise.
    return startSitAdvice({ players, oppPlayers: [], config: team.config, params: DEFAULT_WEEKLY_MODEL });
  }, [team, byId, outlooks, config]);

  if (!team) return <main className="p-6 text-sm text-neutral-400">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">In-season cockpit</h1>
        <label className="text-xs text-neutral-400">
          Week{" "}
          <select
            value={week}
            onChange={(e) => onWeekChange(Number(e.target.value))}
            className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5"
          >
            {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </label>
      </header>

      <RosterImport board={board} team={team} onChange={update} />

      {advice && (
        <>
          {advice.forced.length > 0 && (
            <section className="rounded-lg border border-red-900 bg-red-950/30 p-4">
              <h2 className="text-sm font-semibold text-red-300">Must fix</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {advice.forced.map((f) => (
                  <li key={f.outId}>
                    <strong>{f.outName}</strong>{" "}
                    <span className="text-neutral-400">
                      {f.why === "bye" ? "is on a bye" : f.why === "out" ? "is not expected to play" : "has no projection from any source"}
                    </span>
                    {f.bestReplacementName && <> — start <strong>{f.bestReplacementName}</strong> instead</>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-sm font-semibold">Lineup</h2>
            <div className="mt-2">
              <LineupTable lineup={advice.lineup} players={byId} outlooks={outlooks} />
            </div>
          </section>

          <section className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-sm font-semibold">Swaps worth making</h2>
            {advice.swaps.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-400">Your lineup is already the best of what you have.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {advice.swaps.slice(0, 6).map((s) => (
                  <li key={`${s.inId}-${s.outId}`}>
                    Start <strong>{s.inName}</strong> over <strong>{s.outName}</strong>
                    <span className="text-neutral-400"> — {s.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-neutral-500">
              Ranked by how much each swap moves your chance of winning this matchup, not by projected points.
              No opponent roster is loaded yet, so this compares against your own lineup only.
            </p>
          </section>
        </>
      )}

      {!advice && (
        <p className="text-sm text-neutral-400">Add a few players above to see your lineup and swap advice.</p>
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
- swap suggestions appear with a readable reason;
- reloading the page keeps your roster (localStorage).

**Report what you see, including a screenshot description or the actual rendered numbers for two or three players.** If a projection looks wrong, say so — the engine's numbers have only ever been checked in JSON.

- [ ] **Step 7: Full checks and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm lint
git add app/season components/season app/page.tsx
git commit -m "Season: /season route with manual roster, lineup and swap advice"
```
