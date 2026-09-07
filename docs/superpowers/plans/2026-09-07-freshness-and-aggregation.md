# Data Freshness + Wider News Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the board and every player's status/news as current as free, rate-limit-safe sources allow: a 30-minute CI lane, a fresh board at draft start, live structured injury statuses, more headline feeds, and a much wider Bluesky wire (beat reporters + curated lists), plus a YouTube feasibility spike.

**Architecture:** Pure logic (status mapping, reconciliation, RSS parsing, news matching) lives in `lib/engine/` and `lib/etl/` with unit tests; browser I/O lives in `lib/client/`; the ETL gains a `--lane` switch so a fast CI lane refreshes only sources that tolerate it and reads the rest from fixtures. A shared `useLiveSignals` hook replaces the Cockpit's inline polling effect so the future Newsroom reuses it unchanged.

**Tech Stack:** Next.js (App Router, "use client" components), TypeScript, vitest, tsx scripts, GitHub Actions, Bluesky public AppView + Jetstream, ESPN public endpoints, RSS.

**Spec:** `docs/superpowers/specs/2026-09-07-freshness-and-newsroom-design.md` (Phases 1–3; Phase 4 Newsroom gets its own plan later).

## Global Constraints

- Engine (`lib/engine/`) stays I/O-free and deterministic: no `Date.now()`, no `fetch`, no `Math.random()`. Pass `now` in.
- No paid services at runtime. Keys only as GitHub Actions secrets used at build time; nothing keyed in the browser.
- Every new lever has an off state reproducing today's behaviour (`--lane=full` default; empty list arrays = today's wire).
- `pnpm build:board` must work offline from `data/raw/` fixtures, warning loudly about staleness.
- `pnpm test` green before every engine/ETL commit, including the `<50ms` recompute test.
- Run `pnpm exec tsc --noEmit` after multi-file edits; `set -o pipefail` when piping vitest.
- Commit after every task with a specific message; never commit `data/raw` changes from a local fast-lane run unless intended.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/engine/injuryFeed.ts` (new) | ESPN status vocabulary → board vocabulary; reconcile baked vs live; `gradeBoard` |
| `lib/etl/newsMatch.ts` (new) | `NewsItem`, `PlayerNews`, `matchNewsToPlayers` moved here (pure, shared by browser + ETL) |
| `lib/client/espnNews.ts` | Re-exports the moved types/function; keeps `fetchBoardNews` |
| `lib/etl/rss.ts` (new) | Pure RSS 2.0 parser → `NewsItem[]` |
| `lib/client/rssNews.ts` (new) | Browser fetch of the CORS-open feeds |
| `lib/client/espnInjuries.ts` (new) | Pure `parseEspnInjuries` + browser `fetchEspnInjuries` |
| `lib/client/wireStream.ts` | Adds `extraDids` + `onStatus` options |
| `lib/client/bskyNews.ts` | Handles list ×9; pure `feedToNews`; list feeds + list member resolution |
| `lib/client/sources.ts` | `wireLists`, `wireBlock` prefs |
| `lib/client/useLiveSignals.ts` (new) | One hook: trending, ESPN news, RSS, wire, lists, injuries, Jetstream |
| `lib/client/boardAge.ts` (new) | `formatAge` |
| `components/Cockpit.tsx` | Uses the hook and `gradeBoard`; relative board age in footer |
| `components/Setup.tsx` | List + blocklist textareas; board age on resume card |
| `app/page.tsx` | `cache: "no-cache"` board fetch keyed by an epoch bumped at Setup/draft start |
| `public/sw.js` | Network-first for `/data/*` |
| `lib/etl/lane.ts` (new) | `parseLane` |
| `lib/etl/fetchers.ts` | `fixtureOnly` option; `fetchEspnInjuriesTable`; `fetchRssFeeds` |
| `lib/etl/carryForward.ts` (new) | Carry FantasyPros-derived fields from the previous board in the fast lane |
| `scripts/build-board.ts` | Lane wiring, injuries + RSS baked in, carry-forward |
| `.github/workflows/build-board.yml` | Two cron lanes, concurrency, rebase-before-push |
| `.github/workflows/spike-youtube.yml` + `scripts/spike-youtube.ts` (new) | Phase 3 spike |
| `tests/injuryFeed.test.ts`, `tests/rss.test.ts`, `tests/espnInjuries.test.ts`, `tests/lane.test.ts`, `tests/carryForward.test.ts`, `tests/wireHandles.test.ts`, `tests/bskyFeed.test.ts`, `tests/boardAge.test.ts` (new) | Unit tests |

---

### Task 1: Pure injury-feed mapping and reconciliation

**Files:**
- Create: `lib/engine/injuryFeed.ts`
- Test: `tests/injuryFeed.test.ts`

**Interfaces:**
- Consumes: `classifyNews`, `liveInjuryStatus` from `lib/engine/newsSignal.ts`; `Board`, `BoardPlayer` from `lib/types.ts`.
- Produces: `type FeedStatus = "Questionable" | "Doubtful" | "Out" | "IR" | "Sus" | "Active"`; `mapEspnStatus(status: string | null | undefined): FeedStatus | null`; `reconcileStatus(baked: string | null, live: FeedStatus | null): string | null`; `SEASON_LONG: ReadonlySet<string>`; `gradeBoard(board: Board, liveStatus: ReadonlyMap<string, { status: FeedStatus }>, news: ReadonlyMap<string, { headline: string }>): Board`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/injuryFeed.test.ts
import { describe, it, expect } from "vitest";
import { mapEspnStatus, reconcileStatus, gradeBoard } from "../lib/engine/injuryFeed";
import type { Board, BoardPlayer } from "../lib/types";

function player(id: string, injury: string | null): BoardPlayer {
  return {
    id, name: `P ${id}`, pos: "RB", team: "SF", bye: 9, projPoints: 100, projImputed: false,
    adp: 10, adpStdev: 3, adpHigh: 5, adpLow: 15, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1,
    injury, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {},
  };
}
const board = (...players: BoardPlayer[]): Board => ({
  meta: { format: "ppr", builtAt: "2026-09-07T00:00:00Z", sources: [], scoring: {} as never, warnings: [] },
  players,
});

describe("mapEspnStatus", () => {
  it.each([
    ["Active", "Active"], ["Questionable", "Questionable"], ["Doubtful", "Doubtful"], ["Out", "Out"],
    ["Injured Reserve", "IR"], ["Suspension", "Sus"], ["  out ", "Out"],
  ])("%s → %s", (raw, expected) => expect(mapEspnStatus(raw)).toBe(expected));
  it("returns null for unknown or empty", () => {
    expect(mapEspnStatus("Physically Unable to Perform")).toBeNull();
    expect(mapEspnStatus("")).toBeNull();
    expect(mapEspnStatus(undefined)).toBeNull();
  });
});

describe("reconcileStatus — the live table replaces day-to-day statuses", () => {
  it("escalates Questionable → Out (Penix, 2026-09-07)", () => expect(reconcileStatus("Questionable", "Out")).toBe("Out"));
  it("clears Questionable when the table says Active (Swift back at practice)", () => expect(reconcileStatus("Questionable", "Active")).toBeNull());
  it("downgrades Out → Questionable (a Friday upgrade)", () => expect(reconcileStatus("Out", "Questionable")).toBe("Questionable"));
  it("adds a status to a healthy player", () => expect(reconcileStatus(null, "Doubtful")).toBe("Doubtful"));
  it("keeps season-long PUP over a day-to-day Out (Charbonnet)", () => expect(reconcileStatus("PUP", "Out")).toBe("PUP"));
  it("keeps NA over Out (Jacobs' legal status)", () => expect(reconcileStatus("NA", "Out")).toBe("NA"));
  it("lets an explicit Active clear even IR (activation)", () => expect(reconcileStatus("IR", "Active")).toBeNull());
  it("lets one season-long status replace another", () => expect(reconcileStatus("IR", "Sus")).toBe("Sus"));
  it("leaves the baked status alone when the table has no row", () => expect(reconcileStatus("Questionable", null)).toBe("Questionable"));
});

describe("gradeBoard", () => {
  it("returns the same board object when nothing changes", () => {
    const b = board(player("a", null));
    expect(gradeBoard(b, new Map(), new Map())).toBe(b);
  });
  it("applies the table, marks injuryLive, and leaves untouched players by reference", () => {
    const a = player("a", "Questionable"); const c = player("c", null);
    const out = gradeBoard(board(a, c), new Map([["a", { status: "Out" as const }]]), new Map());
    expect(out.players[0]).toMatchObject({ injury: "Out", injuryLive: true });
    expect(out.players[1]).toBe(c);
  });
  it("still escalates from a hard headline on top of the table", () => {
    const out = gradeBoard(
      board(player("a", null)),
      new Map([["a", { status: "Questionable" as const }]]),
      new Map([["a", { headline: "RB placed on injured reserve" }]])
    );
    expect(out.players[0].injury).toBe("IR");
  });
  it("a clearance from the table is not undone by an old soft headline", () => {
    const out = gradeBoard(board(player("a", "Questionable")), new Map([["a", { status: "Active" as const }]]), new Map([["a", { headline: "RB limited in practice" }]]));
    expect(out.players[0].injury).toBeNull();
    expect(out.players[0].injuryLive).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/injuryFeed.test.ts`
Expected: FAIL — cannot resolve `../lib/engine/injuryFeed`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/engine/injuryFeed.ts
// Structured injury-table statuses (ESPN's league-wide table) → the board's
// vocabulary, plus the reconciliation rule between the build-time snapshot
// and the live table. Pure: no clock, no I/O. The impure fetch lives in
// lib/client/espnInjuries.ts and lib/etl/fetchers.ts.
//
// Rule: a structured table is a *status*, not a headline, so it may both
// escalate and clear day-to-day designations. Season-long designations the
// ETL baked (IR/PUP/Sus/NA/COV/DNR) are stickier: only an explicit "Active"
// (an activation) or another season-long status replaces them. Keyword news
// (classifyNews) stays escalate-only on top.

import type { Board } from "../types";
import { classifyNews, liveInjuryStatus } from "./newsSignal";

export type FeedStatus = "Questionable" | "Doubtful" | "Out" | "IR" | "Sus" | "Active";

const ESPN_STATUS: Record<string, FeedStatus> = {
  active: "Active",
  questionable: "Questionable",
  doubtful: "Doubtful",
  out: "Out",
  "injured reserve": "IR",
  suspension: "Sus",
};

/** ESPN's `status` string → board vocabulary; null when ESPN uses a word we don't grade. */
export function mapEspnStatus(status: string | null | undefined): FeedStatus | null {
  if (!status) return null;
  return ESPN_STATUS[status.trim().toLowerCase()] ?? null;
}

/** Baked statuses that mean "gone for weeks or the season" (recommend.ts excludes these). */
export const SEASON_LONG: ReadonlySet<string> = new Set(["IR", "PUP", "Sus", "NA", "COV", "DNR"]);

export function reconcileStatus(baked: string | null, live: FeedStatus | null): string | null {
  if (!live) return baked;
  if (live === "Active") return null;
  if (baked && SEASON_LONG.has(baked) && !SEASON_LONG.has(live)) return baked;
  return live;
}

/**
 * Apply the live table, then hard-signal headlines, to a board. Returns the
 * same object when nothing changed so memoised consumers stay stable.
 */
export function gradeBoard(
  board: Board,
  liveStatus: ReadonlyMap<string, { status: FeedStatus }>,
  news: ReadonlyMap<string, { headline: string }>
): Board {
  if (liveStatus.size === 0 && news.size === 0) return board;
  let changed = 0;
  const players = board.players.map((p) => {
    const row = liveStatus.get(p.id);
    const tabled = row ? reconcileStatus(p.injury, row.status) : p.injury;
    const item = news.get(p.id);
    const merged = item ? liveInjuryStatus(tabled, classifyNews(item.headline)) : tabled;
    if (merged === p.injury) return p;
    changed++;
    return { ...p, injury: merged, injuryLive: true };
  });
  return changed ? { ...board, players } : board;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/injuryFeed.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/engine/injuryFeed.ts tests/injuryFeed.test.ts
git commit -m "Engine: structured injury-feed mapping and baked/live reconciliation (pure)"
```

---

### Task 2: Move news matching to a shared pure module

**Files:**
- Create: `lib/etl/newsMatch.ts`
- Modify: `lib/client/espnNews.ts` (remove the moved code, re-export)
- Test: existing tests must stay green (`pnpm test`)

**Interfaces:**
- Produces: `lib/etl/newsMatch.ts` exports `interface PlayerNews { headline: string; published: string; href: string | null }`, `interface NewsItem { headline: string; description: string; published: string; href: string | null; athleteIds: string[] }`, `matchNewsToPlayers(items, players, maxAgeHours = 72, now = Date.now()): Map<string, PlayerNews>` — identical behaviour to today's.
- `lib/client/espnNews.ts` keeps exporting the same names via `export { matchNewsToPlayers } from "../etl/newsMatch"; export type { NewsItem, PlayerNews } from "../etl/newsMatch";` so `bskyNews.ts`, `wireStream.ts`, `Cockpit.tsx` compile unchanged.

- [ ] **Step 1: Create `lib/etl/newsMatch.ts`** by moving `PlayerNews`, `NewsItem`, `MAX_TAGS_FOR_BADGE` and `matchNewsToPlayers` verbatim out of `lib/client/espnNews.ts` (lines 11–15, 25–33, 35–86). Header comment:

```ts
// Pure news → player matching, shared by the browser feeds and the ETL.
// No "use client", no DOM, no node: import from either side.
import type { BoardPlayer } from "../types";
import { mergeName } from "./names";
```

- [ ] **Step 2: Rewrite `lib/client/espnNews.ts`** to keep only `EspnNewsItem`, `fetchBoardNews`, and:

```ts
export { matchNewsToPlayers } from "../etl/newsMatch";
export type { NewsItem, PlayerNews } from "../etl/newsMatch";
import { matchNewsToPlayers as match, type NewsItem } from "../etl/newsMatch";
```
and use `match(items, players)` inside `fetchBoardNews`.

- [ ] **Step 3: Type-check and test**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: clean; all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/etl/newsMatch.ts lib/client/espnNews.ts
git commit -m "Refactor: news→player matcher moves to lib/etl/newsMatch (shared by browser and ETL)"
```

---

### Task 3: Pure RSS parser + browser feed fetcher

**Files:**
- Create: `lib/etl/rss.ts`, `lib/client/rssNews.ts`
- Test: `tests/rss.test.ts`

**Interfaces:**
- Produces: `parseRss(xml: string): NewsItem[]` (items with `athleteIds: []`, `published` as the raw pubDate string normalised to ISO when parseable, else `""`); `BROWSER_RSS_FEEDS: string[]`; `fetchRssNews(players: BoardPlayer[], feeds = BROWSER_RSS_FEEDS): Promise<Map<string, PlayerNews>>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/rss.test.ts
import { describe, it, expect } from "vitest";
import { parseRss } from "../lib/etl/rss";

const XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>NFL</title>
<item><title><![CDATA[Ja'Marr Chase &amp; Tee Higgins back at practice]]></title>
<link>https://example.com/a</link>
<description><![CDATA[Bengals WRs <b>returned</b> Monday.]]></description>
<pubDate>Mon, 07 Sep 2026 20:17:58 +0000</pubDate></item>
<item><title>Rome Odunze: Not practicing Monday</title><link>https://example.com/b</link>
<pubDate>Mon, 07 Sep 2026 12:50:00 PM PDT</pubDate></item>
<item><title></title><link>https://example.com/empty</link></item>
</channel></rss>`;

describe("parseRss", () => {
  const items = parseRss(XML);
  it("reads title, link, description with CDATA and entities decoded, tags stripped", () => {
    expect(items[0].headline).toBe("Ja'Marr Chase & Tee Higgins back at practice");
    expect(items[0].description).toBe("Bengals WRs returned Monday.");
    expect(items[0].href).toBe("https://example.com/a");
    expect(items[0].athleteIds).toEqual([]);
  });
  it("normalises RFC-822 dates to ISO", () => {
    expect(items[0].published).toBe("2026-09-07T20:17:58.000Z");
  });
  it("parses RotoWire's 12-hour Pacific format", () => {
    expect(items[1].published).toBe("2026-09-07T19:50:00.000Z");
  });
  it("drops items with no title and tolerates a missing description", () => {
    expect(items).toHaveLength(2);
    expect(items[1].description).toBe("");
  });
  it("returns [] for garbage", () => expect(parseRss("not xml")).toEqual([]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/rss.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the parser**

```ts
// lib/etl/rss.ts
// Minimal RSS 2.0 item parser. Regex on purpose: it runs in the browser (no
// DOMParser in tests) and in the ETL (no DOM at all), and feeds are small.
import type { NewsItem } from "./newsMatch";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** US zone abbreviations Date.parse handles inconsistently across engines. */
const ZONES: Record<string, number> = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, UTC: 0, GMT: 0 };

/** RFC-822 / "hh:mm:ss AM ZONE" → ISO; "" when unparseable. */
export function toIso(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const twelve = s.match(/^(?:\w{3},\s*)?(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s*([A-Z]{3,4})$/i);
  if (twelve) {
    const [, d, mon, y, hh, mm, ss, ap, zone] = twelve;
    let h = Number(hh) % 12;
    if (ap.toUpperCase() === "PM") h += 12;
    const off = ZONES[zone.toUpperCase()] ?? 0;
    const t = Date.parse(`${d} ${mon} ${y} ${String(h).padStart(2, "0")}:${mm}:${ss ?? "00"} GMT`);
    return Number.isFinite(t) ? new Date(t - off * 3_600_000).toISOString() : "";
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

export function parseRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const block of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const headline = stripTags(decodeEntities(tag(block, "title")));
    if (!headline) continue;
    out.push({
      headline,
      description: stripTags(decodeEntities(tag(block, "description"))),
      published: toIso(tag(block, "pubDate") || tag(block, "dc:date")),
      href: tag(block, "link") || null,
      athleteIds: [],
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test → PASS.** If the RotoWire case fails, print `toIso("Mon, 07 Sep 2026 12:50:00 PM PDT")` in a scratch test and fix the regex before moving on; do not loosen the assertion.

- [ ] **Step 5: Browser fetcher**

```ts
// lib/client/rssNews.ts
"use client";

// Headline feeds that answer browser requests with `Access-Control-Allow-Origin: *`
// (verified 2026-09-07). Yahoo and ProFootballTalk do not — they are baked in by the ETL.
import type { BoardPlayer } from "../types";
import { parseRss } from "../etl/rss";
import { matchNewsToPlayers, type NewsItem, type PlayerNews } from "../etl/newsMatch";

export const BROWSER_RSS_FEEDS = [
  "https://www.cbssports.com/rss/headlines/nfl/",
  "https://www.espn.com/espn/rss/nfl/news",
  "https://www.rotowire.com/rss/news.php?sport=NFL",
];

export async function fetchRssNews(players: BoardPlayer[], feeds = BROWSER_RSS_FEEDS): Promise<Map<string, PlayerNews>> {
  const items: NewsItem[] = [];
  await Promise.all(
    feeds.map(async (url) => {
      try {
        const res = await fetch(url);
        if (res.ok) items.push(...parseRss(await res.text()));
      } catch {
        // one dead feed shouldn't kill the rest
      }
    })
  );
  return matchNewsToPlayers(items, players, 72);
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/etl/rss.ts lib/client/rssNews.ts tests/rss.test.ts
git commit -m "News: RSS parser (pure) and browser fetch of the CORS-open CBS/ESPN/RotoWire feeds"
```

---

### Task 4: ESPN injuries table — parser and browser fetch

**Files:**
- Create: `lib/client/espnInjuries.ts`
- Test: `tests/espnInjuries.test.ts`

**Interfaces:**
- Produces: `interface LiveStatus { status: FeedStatus; date: string; note: string | null }`; `parseEspnInjuries(json: EspnInjuriesJson, players: BoardPlayer[], maxAgeHours = 72, now = Date.now()): { status: Map<string, LiveStatus>; news: Map<string, PlayerNews> }`; `fetchEspnInjuries(players): Promise<same>`; `ESPN_INJURIES_URL`; `espnIdFromLinks(links): string | null`.
- Note the status map is **not** windowed by age (a two-week-old IR is still IR); only the news map is windowed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/espnInjuries.test.ts
import { describe, it, expect } from "vitest";
import { parseEspnInjuries, espnIdFromLinks } from "../lib/client/espnInjuries";
import type { BoardPlayer } from "../lib/types";

const p = (id: string, espn: string): BoardPlayer => ({
  id, name: id, pos: "RB", team: "ARI", bye: 8, projPoints: 0, projImputed: false, adp: 50, adpStdev: 5,
  adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1, injury: null,
  depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: { espn },
});
const link = (id: number) => [{ href: `https://www.espn.com/nfl/player/_/id/${id}/x` }];
const JSON_ = {
  injuries: [
    { id: "22", displayName: "Arizona Cardinals", injuries: [
      { status: "Questionable", date: "2026-09-03T17:49Z", shortComment: "Love (ankle) is progressing.", athlete: { displayName: "Jeremiyah Love", links: link(4870808) } },
      { status: "Active", date: "2026-09-04T21:36Z", shortComment: "Brissett listed with the first team.", athlete: { displayName: "Jacoby Brissett", links: link(1) } },
      { status: "Out", date: "2026-08-01T00:00Z", shortComment: "Old note.", athlete: { displayName: "Someone Else", links: link(999) } },
      { status: "Physically Unable", date: "2026-09-01T00:00Z", athlete: { displayName: "Unknown Word", links: link(2) } },
    ] },
  ],
};
const NOW = Date.parse("2026-09-07T20:00:00Z");

describe("espnIdFromLinks", () => {
  it("extracts the numeric id", () => expect(espnIdFromLinks(link(4870808))).toBe("4870808"));
  it("null without links", () => expect(espnIdFromLinks(undefined)).toBeNull());
});

describe("parseEspnInjuries", () => {
  const players = [p("love", "4870808"), p("brissett", "1"), p("old", "999"), p("unk", "2")];
  const { status, news } = parseEspnInjuries(JSON_, players, 72, NOW);
  it("maps statuses by ESPN id, including Active", () => {
    expect(status.get("love")).toMatchObject({ status: "Questionable", date: "2026-09-03T17:49Z" });
    expect(status.get("brissett")?.status).toBe("Active");
  });
  it("keeps stale statuses (an old Out is still a status)", () => expect(status.get("old")?.status).toBe("Out"));
  it("skips vocabulary it cannot map", () => expect(status.has("unk")).toBe(false));
  it("emits the dated note as news inside the window only", () => {
    expect(news.get("love")).toEqual({ headline: "Love (ankle) is progressing.", published: "2026-09-03T17:49Z", href: null });
    expect(news.has("old")).toBe(false);
  });
  it("ignores rows for players not on the board", () => {
    const r = parseEspnInjuries(JSON_, [p("love", "4870808")], 72, NOW);
    expect(r.status.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL (module not found).**

- [ ] **Step 3: Implement**

```ts
// lib/client/espnInjuries.ts
"use client";

// ESPN's league-wide injuries table: every player with a current designation
// or a fresh note, with a structured status. Free, keyless, CORS-open
// (verified 2026-09-07), 10-second cache upstream. This is the live source
// for Questionable/Doubtful/Out/IR/Suspension between board rebuilds.

import type { BoardPlayer } from "../types";
import { mapEspnStatus, type FeedStatus } from "../engine/injuryFeed";
import type { PlayerNews } from "../etl/newsMatch";

export const ESPN_INJURIES_URL =
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/injuries";

export interface EspnInjuryRow {
  status?: string;
  date?: string;
  shortComment?: string;
  athlete?: { displayName?: string; links?: { href?: string }[] };
}
export interface EspnInjuriesJson {
  injuries?: { id?: string; displayName?: string; injuries?: EspnInjuryRow[] }[];
}
export interface LiveStatus {
  status: FeedStatus;
  /** ESPN's row timestamp, e.g. "2026-09-04T21:36Z". */
  date: string;
  note: string | null;
}

export function espnIdFromLinks(links: { href?: string }[] | undefined): string | null {
  for (const l of links ?? []) {
    const m = l.href?.match(/\/id\/(\d+)(?:\/|$)/);
    if (m) return m[1];
  }
  return null;
}

/** Pure: table → playerId → newest status; notes inside the window become news. */
export function parseEspnInjuries(
  json: EspnInjuriesJson,
  players: BoardPlayer[],
  maxAgeHours = 72,
  now = Date.now()
): { status: Map<string, LiveStatus>; news: Map<string, PlayerNews> } {
  const byEspn = new Map<string, BoardPlayer>();
  for (const p of players) if (p.ids.espn) byEspn.set(p.ids.espn, p);
  const status = new Map<string, LiveStatus>();
  const news = new Map<string, PlayerNews>();
  const cutoff = now - maxAgeHours * 3_600_000;
  for (const team of json.injuries ?? []) {
    for (const row of team.injuries ?? []) {
      const id = espnIdFromLinks(row.athlete?.links);
      const p = id ? byEspn.get(id) : undefined;
      if (!p) continue;
      const s = mapEspnStatus(row.status);
      if (!s) continue;
      const date = row.date ?? "";
      const t = Date.parse(date);
      const prev = status.get(p.id);
      if (!prev || (Number.isFinite(t) && t > Date.parse(prev.date))) {
        status.set(p.id, { status: s, date, note: row.shortComment ?? null });
      }
      if (row.shortComment && Number.isFinite(t) && t >= cutoff) {
        const e = news.get(p.id);
        if (!e || t > Date.parse(e.published)) news.set(p.id, { headline: row.shortComment, published: date, href: null });
      }
    }
  }
  return { status, news };
}

export async function fetchEspnInjuries(players: BoardPlayer[]) {
  const res = await fetch(ESPN_INJURIES_URL);
  if (!res.ok) throw new Error(`espn injuries: HTTP ${res.status}`);
  return parseEspnInjuries((await res.json()) as EspnInjuriesJson, players);
}
```

- [ ] **Step 4: Run → PASS.** (If `Date.parse("2026-09-03T17:49Z")` is NaN in your Node, extend `toIso` from Task 3 and use it here — verify in `node -e` first.)

- [ ] **Step 5: Commit**

```bash
git add lib/client/espnInjuries.ts tests/espnInjuries.test.ts
git commit -m "Live injuries: parse ESPN's league-wide table into board statuses and dated notes"
```

---

### Task 5: `useLiveSignals` hook; Cockpit uses it and `gradeBoard`

**Files:**
- Create: `lib/client/useLiveSignals.ts`
- Modify: `lib/client/wireStream.ts` (options), `components/Cockpit.tsx:88-190` (state + effect + gradedBoard), imports at `components/Cockpit.tsx:36-39`

**Interfaces:**
- `connectWireStream(players, handles, onNews, opts?: { extraDids?: Map<string, string>; onStatus?: (connected: boolean) => void }): () => void` — `extraDids` maps DID → handle for link building.
- `useLiveSignals(board: Board, onWire?: (playerId: string, item: PlayerNews) => void): LiveSignals` where `interface LiveSignals { boardNews: Map<string, PlayerNews>; trendingIds: Set<string>; liveStatus: Map<string, LiveStatus>; lastRefresh: number | null; connected: boolean; refresh: () => void }`.
- `LIVE_REFRESH_MS = 10 * 60 * 1000`.

- [ ] **Step 1: Extend `wireStream.ts`**

Change the signature and body:

```ts
export function connectWireStream(
  players: BoardPlayer[],
  handles: string[],
  onNews: (matched: Map<string, PlayerNews>) => void,
  opts: { extraDids?: Map<string, string>; onStatus?: (connected: boolean) => void } = {}
): () => void {
```
After `resolveDids(handles).then((didToHandle) => {` add `for (const [d, h] of opts.extraDids ?? []) didToHandle.set(d, h);` before the `size === 0` check. In `open()`: set `ws.onopen = () => opts.onStatus?.(true);` and in `ws.onclose` call `opts.onStatus?.(false)` before scheduling the reconnect. Everything else unchanged.

- [ ] **Step 2: Write the hook**

```ts
// lib/client/useLiveSignals.ts
"use client";

// Every live signal the app polls, in one place: Sleeper trending, ESPN
// headlines, CORS-open RSS, the Bluesky wire (handles + curated lists), the
// ESPN injuries table, and the Jetstream push. Cockpit and Newsroom share it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "../types";
import { loadSources, fetchTrendingIds } from "./sources";
import { fetchBoardNews } from "./espnNews";
import type { PlayerNews } from "../etl/newsMatch";
import { fetchWireNews, fetchListNews, resolveListMembers, mergeNews, DEFAULT_WIRE_HANDLES } from "./bskyNews";
import { connectWireStream } from "./wireStream";
import { fetchEspnInjuries, type LiveStatus } from "./espnInjuries";
import { fetchRssNews } from "./rssNews";

export const LIVE_REFRESH_MS = 10 * 60 * 1000;
const BAKED_WINDOW_MS = 72 * 3_600_000;

export interface LiveSignals {
  boardNews: Map<string, PlayerNews>;
  trendingIds: Set<string>;
  liveStatus: Map<string, LiveStatus>;
  lastRefresh: number | null;
  connected: boolean;
  refresh: () => void;
}

const EMPTY = <T,>() => new Map<string, T>();

export function useLiveSignals(board: Board, onWire?: (playerId: string, item: PlayerNews) => void): LiveSignals {
  const [boardNews, setBoardNews] = useState<Map<string, PlayerNews>>(new Map());
  const [trendingIds, setTrendingIds] = useState<Set<string>>(new Set());
  const [liveStatus, setLiveStatus] = useState<Map<string, LiveStatus>>(new Map());
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const onWireRef = useRef(onWire);
  onWireRef.current = onWire;

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);

  useEffect(() => {
    const prefs = loadSources();
    const handles = prefs.wireHandles.length ? prefs.wireHandles : DEFAULT_WIRE_HANDLES;
    const blocked = new Set(prefs.wireBlock);
    let cancelled = false;

    const load = () => {
      if (prefs.trending)
        fetchTrendingIds().then((ids) => !cancelled && setTrendingIds(ids)).catch(() => {});
      const baked = new Map<string, PlayerNews>();
      const cutoff = Date.now() - BAKED_WINDOW_MS;
      for (const p of board.players) {
        if (p.news && Date.parse(p.news.published) >= cutoff) baked.set(p.id, { ...p.news, href: null });
      }
      const safe = <T,>(p: Promise<Map<string, T>>) => p.catch(() => EMPTY<T>());
      const feeds = [
        safe(fetchBoardNews(board.players)),
        safe(fetchRssNews(board.players)),
        prefs.wire ? safe(fetchWireNews(board.players, handles)) : Promise.resolve(EMPTY<PlayerNews>()),
        prefs.wire && prefs.wireLists.length
          ? safe(fetchListNews(board.players, prefs.wireLists, blocked))
          : Promise.resolve(EMPTY<PlayerNews>()),
      ];
      const injuries = fetchEspnInjuries(board.players).catch(() => ({ status: EMPTY<LiveStatus>(), news: EMPTY<PlayerNews>() }));
      Promise.all([...feeds, injuries]).then(([espn, rss, wire, lists, inj]) => {
        if (cancelled) return;
        const i = inj as { status: Map<string, LiveStatus>; news: Map<string, PlayerNews> };
        setBoardNews(mergeNews(baked, i.news, espn as Map<string, PlayerNews>, rss as Map<string, PlayerNews>, wire as Map<string, PlayerNews>, lists as Map<string, PlayerNews>));
        if (i.status.size) setLiveStatus(i.status);
        setLastRefresh(Date.now());
      });
    };
    load();
    const timer = setInterval(load, LIVE_REFRESH_MS);

    let disconnect = () => {};
    if (prefs.wire) {
      const start = (extra: Map<string, string>) => {
        if (cancelled) return;
        disconnect = connectWireStream(
          board.players,
          handles,
          (matched) => {
            if (cancelled) return;
            setBoardNews((prev) => mergeNews(prev, matched));
            const [id, item] = [...matched.entries()][0];
            onWireRef.current?.(id, item);
          },
          { extraDids: extra, onStatus: (c) => !cancelled && setConnected(c) }
        );
      };
      if (prefs.wireLists.length) resolveListMembers(prefs.wireLists, blocked).then(start).catch(() => start(new Map()));
      else start(new Map());
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      disconnect();
    };
  }, [board, epoch]);

  return { boardNews, trendingIds, liveStatus, lastRefresh, connected, refresh };
}
```

`fetchListNews` and `resolveListMembers` are added in Task 10; until then export stubs from `bskyNews.ts` that return empty maps so this compiles:

```ts
export async function fetchListNews(_players: BoardPlayer[], _lists: string[], _blocked: Set<string>): Promise<Map<string, PlayerNews>> { return new Map(); }
export async function resolveListMembers(_lists: string[], _blocked: Set<string>): Promise<Map<string, string>> { return new Map(); }
```
and add `wireLists: []` and `wireBlock: []` to `SourcePrefs` + `DEFAULT_SOURCES` in `lib/client/sources.ts` now (typed `string[]`, documented in Task 10).

- [ ] **Step 3: Rewire the Cockpit**

Replace `components/Cockpit.tsx:88-89` (the two `useState` lines) and the whole effect at lines 117–168 and the `gradedBoard` memo at 171–190 with:

```ts
  const live = useLiveSignals(board, (id, item) => {
    const player = board.players.find((p) => p.id === id);
    if (player) showToast(`📰 ${player.name}: ${item.headline.slice(0, 70)}`);
  });
  const { boardNews, trendingIds } = live;

  // Live news, graded. The ESPN table sets Questionable/Doubtful/Out (and can
  // clear); hard-signal headlines can only escalate. recommend() still sees a
  // plain board, just a truer one — engine purity intact.
  const gradedBoard = useMemo<Board>(() => gradeBoard(board, live.liveStatus, boardNews), [board, live.liveStatus, boardNews]);
```
Update imports: remove `fetchWireNews, mergeNews, DEFAULT_WIRE_HANDLES`, `connectWireStream`, `fetchBoardNews`, `fetchTrendingIds`, `classifyNews, liveInjuryStatus` if now unused (keep `loadSources` only if still used elsewhere — grep); add `import { useLiveSignals } from "../lib/client/useLiveSignals";` and `import { gradeBoard } from "../lib/engine/injuryFeed";` and `import type { PlayerNews } from "../lib/etl/newsMatch";` if `PlayerNews` is still referenced.

- [ ] **Step 4: Type-check, lint, test**

Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm test`
Expected: clean. Then `pnpm dev`, open a draft, confirm 📰 badges and toasts still appear and the network tab shows `injuries`, the three RSS feeds, and `getAuthorFeed` calls once on mount.

- [ ] **Step 5: Commit**

```bash
git add lib/client/useLiveSignals.ts lib/client/wireStream.ts lib/client/bskyNews.ts lib/client/sources.ts components/Cockpit.tsx
git commit -m "Cockpit: one useLiveSignals hook (trending, ESPN news, RSS, wire, injuries table, Jetstream); gradeBoard applies structured statuses"
```

---

### Task 6: Fresh board at draft start + board age

**Files:**
- Modify: `public/sw.js`, `app/page.tsx:86-140`, `app/page.tsx:150-180`, `components/Setup.tsx` (resume card), `components/Cockpit.tsx:1302`
- Create: `lib/client/boardAge.ts`
- Test: `tests/boardAge.test.ts`

**Interfaces:**
- `formatAge(builtAt: string, now: number): { label: string; stale: boolean }` — labels "built just now" (<1 min), "built 12 min ago", "built 3 h ago", "built 2 d ago"; `stale` true when older than 12 h.
- `Setup` gains prop `boardBuiltAt?: string | null`.

- [ ] **Step 1: Failing test**

```ts
// tests/boardAge.test.ts
import { describe, it, expect } from "vitest";
import { formatAge } from "../lib/client/boardAge";
const T = Date.parse("2026-09-07T20:00:00Z");
describe("formatAge", () => {
  it.each([
    ["2026-09-07T19:59:40Z", "built just now", false],
    ["2026-09-07T19:48:00Z", "built 12 min ago", false],
    ["2026-09-07T17:00:00Z", "built 3 h ago", false],
    ["2026-09-07T07:59:00Z", "built 12 h ago", true],
    ["2026-09-05T20:00:00Z", "built 2 d ago", true],
  ])("%s → %s (stale=%s)", (iso, label, stale) => expect(formatAge(iso, T)).toEqual({ label, stale }));
  it("handles garbage", () => expect(formatAge("nope", T)).toEqual({ label: "build time unknown", stale: true }));
});
```

- [ ] **Step 2: Run → FAIL.** Then implement:

```ts
// lib/client/boardAge.ts
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
```

- [ ] **Step 3: Run → PASS.**

- [ ] **Step 4: Service worker: network-first for board data**

Replace the `fetch` listener in `public/sw.js` with:

```js
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // Board JSON is network-first: a new draft must see the newest CI build.
      // The cache is only the offline fallback. The app shell stays SWR.
      if (url.pathname.startsWith("/data/")) {
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch {
          return (await cache.match(event.request)) || Response.error();
        }
      }
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
```

- [ ] **Step 5: Page: refetch on Setup and on draft start**

In `app/page.tsx` add `const [boardEpoch, setBoardEpoch] = useState(0);` next to the `screen` state. Change the board fetch to `fetch(\`/data/board-${config.scoring}.json\`, { cache: "no-cache" })` and the effect deps to `[config, boardEpoch]`. Bump the epoch where a draft starts or resumes: in `onDone` (before `setScreen("cockpit")`) and in `onResume`, add `setBoardEpoch((e) => e + 1);`. Also bump it when entering Setup: find every `setScreen("setup")` call site (grep `setScreen("setup")` — it is passed as `onHome` to Cockpit) and wrap: `onHome={() => { setBoardEpoch((e) => e + 1); setScreen("setup"); }}`. Pass `boardBuiltAt={board?.meta.builtAt ?? null}` to `<Setup … />`.

- [ ] **Step 6: Show the age**

`components/Setup.tsx`: add `boardBuiltAt?: string | null;` to `Props` and destructure it. Inside the resume card (`{resume && (` block near line 177) add, under the existing text:

```tsx
{boardBuiltAt && (() => { const a = formatAge(boardBuiltAt, Date.now()); return (
  <p className={`mt-1 font-mono text-xs ${a.stale ? "text-warn" : "text-ink-faint"}`} title={new Date(boardBuiltAt).toLocaleString()}>
    Board {a.label}{a.stale ? " — refresh runs every 30 min; check your connection" : ""}
  </p>
); })()}
```
with `import { formatAge } from "../lib/client/boardAge";`.

`components/Cockpit.tsx:1302`: replace `Board built {new Date(board.meta.builtAt).toLocaleDateString()}` with
```tsx
<span title={new Date(board.meta.builtAt).toLocaleString()} className={formatAge(board.meta.builtAt, Date.now()).stale ? "text-warn" : undefined}>Board {formatAge(board.meta.builtAt, Date.now()).label}</span>
```
and import `formatAge`.

- [ ] **Step 7: Verify manually**

`pnpm build && pnpm start` (the SW registers only in production). Load the app, open DevTools → Application → Service Workers → Update. Reload, start a draft: the Network tab shows `/data/board-ppr.json` served from network (not "ServiceWorker"). Toggle Offline, reload: the board still loads from the SW cache. Confirm the footer reads "Board built N min ago".

- [ ] **Step 8: Commit**

```bash
git add public/sw.js app/page.tsx components/Setup.tsx components/Cockpit.tsx lib/client/boardAge.ts tests/boardAge.test.ts
git commit -m "Fresh board at draft start: network-first /data in the service worker, no-cache refetch on Setup/start, board age shown"
```

---

### Task 7: ETL lanes, ESPN injuries and RSS baked in, FantasyPros carry-forward

**Files:**
- Create: `lib/etl/lane.ts`, `lib/etl/carryForward.ts`
- Modify: `lib/etl/fetchers.ts` (`fixtureOnly`, two new fetchers), `lib/etl/schedule.ts` (`fetchSos` fixtureOnly), `lib/types.ts` (`BoardMeta.lane?`), `scripts/build-board.ts`
- Test: `tests/lane.test.ts`, `tests/carryForward.test.ts`

**Interfaces:**
- `type Lane = "fast" | "full"`; `parseLane(argv: string[]): Lane` (throws on unknown values).
- `fetchWithFixture<T>(key, url, parse, init?, opts?: { fixtureOnly?: boolean })` — with `fixtureOnly`, reads the fixture without a network call and **without** the staleness warning (returns `fromFixture: true`).
- `fetchSleeperPlayerInfo(opts?: { fixtureOnly?: boolean })`, `fetchSleeperProjections(season, opts?)`, `fetchSos(season, statsSeason, opts?)` gain the same option.
- `fetchEspnInjuriesTable(): Promise<SourceResult<EspnInjuriesJson>>` (fixture key `espn-injuries.json`, URL `https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries`, parse asserts `injuries.length >= 20`).
- `fetchRssFeeds(): Promise<SourceResult<NewsItem[]>[]>` over `ETL_RSS_FEEDS` (Yahoo `https://sports.yahoo.com/nfl/rss.xml`, PFT `https://profootballtalk.nbcsports.com/feed/`, plus the three browser feeds); fixture keys `rss-yahoo.xml`, `rss-pft.xml`, `rss-cbs.xml`, `rss-espn.xml`, `rss-rotowire.xml`; each failure falls back to its fixture and a missing fixture yields `[]` (RSS is nice-to-have, never fatal).
- `carryForwardFp(board: Board, previous: Board | null): Board` — when `board.meta.sources` has no live FantasyPros entry with experts > 0 and `previous` has one, copy `ecr`, `ecrStdev`, `statsFp` per player id and append `{ name: "FantasyPros consensus (carried from <prev fetchedAt>)", fetchedAt, fromFixture: true }`.

- [ ] **Step 1: Failing tests**

```ts
// tests/lane.test.ts
import { describe, it, expect } from "vitest";
import { parseLane } from "../lib/etl/lane";
describe("parseLane", () => {
  it("defaults to full", () => expect(parseLane(["tsx", "build-board.ts"])).toBe("full"));
  it("reads --lane=fast", () => expect(parseLane(["x", "y", "--lane=fast"])).toBe("fast"));
  it("accepts --lane=full", () => expect(parseLane(["x", "--lane=full"])).toBe("full"));
  it("rejects nonsense", () => expect(() => parseLane(["x", "--lane=turbo"])).toThrow(/turbo/));
});
```

```ts
// tests/carryForward.test.ts
import { describe, it, expect } from "vitest";
import { carryForwardFp } from "../lib/etl/carryForward";
import type { Board } from "../lib/types";

const mk = (fpName: string | null, ecr: number | null): Board => ({
  meta: {
    format: "ppr", builtAt: "2026-09-07T10:00:00Z", scoring: {} as never, warnings: [],
    sources: fpName ? [{ name: fpName, fetchedAt: "2026-09-07T09:20:00Z", fromFixture: false }] : [],
  },
  players: [{ id: "a", name: "A", pos: "RB", team: "SF", bye: 9, projPoints: 1, projImputed: false, adp: 1, adpStdev: 1, adpHigh: 1, adpLow: 1,
    ecr, ecrStdev: ecr ? 2 : null, vorp: 0, vols: 0, tier: 1, injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {},
    statsFp: ecr ? { rushYds: 900 } : undefined }],
});

describe("carryForwardFp", () => {
  it("copies FP-derived fields from the previous board when this build has none", () => {
    const out = carryForwardFp(mk(null, 12), mk("FantasyPros consensus (103 experts, live)", 5));
    expect(out.players[0]).toMatchObject({ ecr: 5, ecrStdev: 2, statsFp: { rushYds: 900 } });
    expect(out.meta.sources.at(-1)?.name).toMatch(/carried from 2026-09-07T09:20/);
  });
  it("leaves a build that has live FP data alone", () => {
    const b = mk("FantasyPros consensus (90 experts, live)", 12);
    expect(carryForwardFp(b, mk("FantasyPros consensus (103 experts, live)", 5))).toBe(b);
  });
  it("does nothing when the previous board had 0 experts or no FP", () => {
    const b = mk(null, 12);
    expect(carryForwardFp(b, mk("FantasyPros consensus (0 experts, live)", 5))).toBe(b);
    expect(carryForwardFp(b, null)).toBe(b);
  });
});
```

- [ ] **Step 2: Run both → FAIL.** Implement:

```ts
// lib/etl/lane.ts
/**
 * CI lanes. `fast` (every 30 min) refreshes only sources that tolerate it —
 * FFC ADP, ESPN projections, Sleeper projections, the ESPN injuries table,
 * RSS — and reads everything else from fixtures. `full` (daily + local) is
 * today's behaviour. See docs/superpowers/specs/2026-09-07-freshness-and-newsroom-design.md §1a.
 */
export type Lane = "fast" | "full";

export function parseLane(argv: string[]): Lane {
  const arg = argv.find((a) => a.startsWith("--lane="));
  const v = arg?.slice("--lane=".length);
  if (!v || v === "full") return "full";
  if (v === "fast") return "fast";
  throw new Error(`unknown --lane=${v} (expected fast|full)`);
}
```

```ts
// lib/etl/carryForward.ts
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
      sources: [...board.meta.sources, { name: `FantasyPros consensus (carried from ${fetchedAt})`, fetchedAt, fromFixture: true }],
    },
  };
}
```

- [ ] **Step 3: Run → PASS. Commit the pure parts.**

```bash
git add lib/etl/lane.ts lib/etl/carryForward.ts tests/lane.test.ts tests/carryForward.test.ts
git commit -m "ETL: --lane parser and FantasyPros carry-forward (pure, tested)"
```

- [ ] **Step 4: `fixtureOnly` in the fetchers**

In `lib/etl/fetchers.ts` change `fetchWithFixture`'s signature to `(key, url, parse, init?: RequestInit, opts: { fixtureOnly?: boolean } = {})` and add at the top of the body:

```ts
  if (opts.fixtureOnly) {
    if (!existsSync(fixturePath)) throw new Error(`fixture ${key} missing — run the full lane first`);
    return { data: parse(readFileSync(fixturePath, "utf8")), fetchedAt: readMeta()[key]?.fetchedAt ?? "unknown", fromFixture: true };
  }
```
Thread `opts` through `fetchPlayerIds(opts?)`, `fetchEcr(opts?)`. Add the same early return to `fetchSleeperPlayerInfo(opts = {})` and `fetchSleeperProjections(season, opts = {})` (they hand-roll the fixture path; return the parsed fixture with `fromFixture: true`). In `lib/etl/schedule.ts` give `fetchSos(season, statsSeason, opts = {})` the same early return using its existing fixture path.

Add the two new fetchers to `lib/etl/fetchers.ts`:

```ts
import { parseRss } from "./rss";
import type { NewsItem } from "./newsMatch";
import type { EspnInjuriesJson } from "../client/espnInjuries"; // type-only; no browser code is pulled in

export function fetchEspnInjuriesTable() {
  return fetchWithFixture<EspnInjuriesJson>(
    "espn-injuries.json",
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
    (body) => {
      const json = JSON.parse(body) as EspnInjuriesJson;
      if (!Array.isArray(json.injuries) || json.injuries.length < 20) throw new Error(`unexpected injuries payload (teams=${json.injuries?.length})`);
      return json;
    }
  );
}

export const ETL_RSS_FEEDS: { key: string; url: string }[] = [
  { key: "rss-yahoo.xml", url: "https://sports.yahoo.com/nfl/rss.xml" },
  { key: "rss-pft.xml", url: "https://profootballtalk.nbcsports.com/feed/" },
  { key: "rss-cbs.xml", url: "https://www.cbssports.com/rss/headlines/nfl/" },
  { key: "rss-espn.xml", url: "https://www.espn.com/espn/rss/nfl/news" },
  { key: "rss-rotowire.xml", url: "https://www.rotowire.com/rss/news.php?sport=NFL" },
];

/** Headline feeds for baked news. Never fatal: a feed with no fixture yields []. */
export async function fetchRssFeeds(): Promise<SourceResult<NewsItem[]>[]> {
  return Promise.all(
    ETL_RSS_FEEDS.map(async ({ key, url }) => {
      try {
        return await fetchWithFixture<NewsItem[]>(key, url, (body) => {
          const items = parseRss(body);
          if (items.length === 0) throw new Error("no <item> elements");
          return items;
        }, { headers: { "user-agent": "Mozilla/5.0 (compatible; DraftCockpit/1.0)" } });
      } catch (err) {
        console.warn(`⚠️  ${key}: ${err} — skipped`);
        return { data: [], fetchedAt: "unknown", fromFixture: true };
      }
    })
  );
}
```
Move `EspnInjuriesJson`/`EspnInjuryRow` type definitions into `lib/etl/newsMatch.ts`? No — keep them where they are; a type-only import is erased at compile time and `tsx` handles it.

- [ ] **Step 5: Wire the lanes into `scripts/build-board.ts`**

At the top: `import { parseLane } from "../lib/etl/lane"; import { carryForwardFp } from "../lib/etl/carryForward"; import { fetchEspnInjuriesTable, fetchRssFeeds } from "../lib/etl/fetchers"; import { parseEspnInjuries } from "../lib/client/espnInjuries"; import { reconcileStatus } from "../lib/engine/injuryFeed"; import { matchNewsToPlayers, type NewsItem } from "../lib/etl/newsMatch"; import { existsSync } from "node:fs";`

In `main()`:

```ts
  const LANE = parseLane(process.argv);
  const slowOnly = { fixtureOnly: LANE === "fast" };
  console.log(`lane: ${LANE}${LANE === "fast" ? " (Sleeper players, FantasyPros, DynastyProcess, nflverse from fixtures)" : ""}`);

  const [idsRes, ecrRes, espnRes, playersRes, sosRes, sleeperProjRes, injuriesRes, rssRes] = await Promise.all([
    fetchPlayerIds(slowOnly),
    fetchEcr(slowOnly),
    fetchEspnProjections(SEASON),
    fetchSleeperPlayerInfo(slowOnly),
    fetchSos(SEASON, SEASON - 1, slowOnly),
    fetchSleeperProjections(SEASON),
    fetchEspnInjuriesTable(),
    fetchRssFeeds(),
  ]);
  const rssItems: NewsItem[] = rssRes.flatMap((r) => r.data);
  console.log(`injuries table: ${injuriesRes.data.injuries?.length} teams${injuriesRes.fromFixture ? " (fixture)" : ""} · rss: ${rssItems.length} items`);
```
FantasyPros: `const fpData = LANE === "fast" ? null : await fetchFantasyProsData(SEASON, fpIds);` and `for (const n of LANE === "fast" ? [] : await fetchFantasyProsNews())`.

Pass `injuriesRes.data` and `rssItems` into `buildBoard` (two new trailing params `injuries: EspnInjuriesJson`, `rss: NewsItem[]`). Inside `buildBoard`, immediately after `appendDeepPool(...)`:

```ts
  // Live-table statuses over the Sleeper snapshot (same rule the browser uses),
  // plus baked news: FantasyPros → ESPN's dated note → RSS headline, newest wins.
  const table = parseEspnInjuries(injuries, players, 72, Date.now());
  const rssNews = matchNewsToPlayers(rss, players, 72);
  let tabled = 0;
  for (const p of players) {
    const row = table.status.get(p.id);
    if (row) {
      const merged = reconcileStatus(p.injury, row.status);
      if (merged !== p.injury) tabled++;
      p.injury = merged;
    }
    const candidates = [p.news, table.news.get(p.id), rssNews.get(p.id)].filter((n): n is { headline: string; published: string } => !!n);
    candidates.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
    p.news = candidates[0] ? { headline: candidates[0].headline, published: candidates[0].published } : null;
  }
  if (tabled) console.log(`  injuries: ${tabled} statuses updated from ESPN's table`);
```
Add to `meta.sources`: `{ name: "ESPN injuries table", fetchedAt: injuriesMeta.fetchedAt, fromFixture: injuriesMeta.fromFixture }` (pass `{ fetchedAt, fromFixture }` alongside). Add `lane: Lane` to the meta and `lane?: "fast" | "full"` to `BoardMeta` in `lib/types.ts`.

Carry-forward: right after `const board = buildBoard(...)`:

```ts
    const path = join(OUT_DIR, `board-${format}.json`);
    const previous: Board | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    const board = carryForwardFp(buildBoard(/* … */), previous);
```
(same for `board-custom.json`). Fast lane skips `fitDriftPrior()` if it fetches anything live — read it: if it does, guard with `if (LANE === "full")`.

- [ ] **Step 6: Verify both lanes locally**

Run: `pnpm build:board --lane=fast` → prints `lane: fast`, no FantasyPros calls, "injuries: N statuses updated", boards written. Then `pnpm build:board` → `lane: full`, previous behaviour. Then `pnpm test` and `pnpm exec tsc --noEmit`. Check `git status`: the fast lane changed `public/data/*.json` and wrote fixtures under `data/raw/` (fine locally; CI decides what to commit).

- [ ] **Step 7: Commit**

```bash
git add lib/etl lib/types.ts scripts/build-board.ts data/raw/espn-injuries.json data/raw/rss-*.xml data/raw/meta.json public/data
git commit -m "ETL: fast/full lanes; ESPN injuries table and RSS headlines baked in; FantasyPros carried forward on the fast lane"
```

---

### Task 8: Two-lane workflow

**Files:**
- Modify: `.github/workflows/build-board.yml`

- [ ] **Step 1: Replace the file**

```yaml
name: Board refresh

on:
  schedule:
    # FAST lane, every 30 minutes: FFC ADP (hourly upstream cache), ESPN and
    # Sleeper projections, ESPN's injuries table, RSS headlines. Commits only
    # public/data, only when it changed. Offset from :20 so it never shares a
    # minute with the full lane.
    - cron: "5,35 * * * *"
    # FULL lane, daily after FFC's ADP refresh: adds the Sleeper player dump
    # (Sleeper asks for at most daily), FantasyPros (fresh free-tier quota),
    # DynastyProcess, nflverse. Commits fixtures too.
    - cron: "20 9 * * *"
  workflow_dispatch:
    inputs:
      lane:
        description: "fast | full"
        default: "full"

permissions:
  contents: write

# Never let two refreshes race on the push.
concurrency:
  group: board-refresh
  cancel-in-progress: false

jobs:
  build-board:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Pick the lane
        id: lane
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then echo "lane=${{ inputs.lane }}" >> "$GITHUB_OUTPUT";
          elif [ "${{ github.event.schedule }}" = "20 9 * * *" ]; then echo "lane=full" >> "$GITHUB_OUTPUT";
          else echo "lane=fast" >> "$GITHUB_OUTPUT"; fi
      - run: pnpm build:board --lane=${{ steps.lane.outputs.lane }}
        env:
          FANTASYPROS_API_KEY: ${{ secrets.FANTASYPROS_API_KEY }}
      - name: Commit refreshed board (+ fixtures on the full lane)
        run: |
          git config user.name "board-bot"
          git config user.email "actions@users.noreply.github.com"
          if [ "${{ steps.lane.outputs.lane }}" = "full" ]; then git add public/data data/raw; else git add public/data; fi
          git diff --cached --quiet && { echo "no board changes"; exit 0; }
          git commit -m "chore: board refresh (${{ steps.lane.outputs.lane }} lane)"
          git pull --rebase --autostash origin main
          git push
```

- [ ] **Step 2: Validate the YAML** with `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build-board.yml'))"` (install pyyaml if missing) or `gh workflow view` after pushing.

- [ ] **Step 3: Commit; after the push, trigger `gh workflow run build-board.yml -f lane=fast` and confirm the run commits only `public/data`.**

```bash
git add .github/workflows/build-board.yml
git commit -m "CI: fast lane every 30 min (boards only) + daily full lane (fixtures, FantasyPros, Sleeper dump); serialized pushes"
```

---

### Task 9: Bluesky default handles ×9

**Files:**
- Modify: `lib/client/bskyNews.ts:19-26`
- Test: `tests/wireHandles.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/wireHandles.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_WIRE_HANDLES } from "../lib/client/bskyNews";
describe("DEFAULT_WIRE_HANDLES", () => {
  it("are unique, lowercase, and look like handles", () => {
    expect(new Set(DEFAULT_WIRE_HANDLES).size).toBe(DEFAULT_WIRE_HANDLES.length);
    for (const h of DEFAULT_WIRE_HANDLES) expect(h).toMatch(/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/);
  });
  it("covers national insiders, aggregators, fantasy bots and beat reporters", () => {
    expect(DEFAULT_WIRE_HANDLES.length).toBeGreaterThanOrEqual(50);
    expect(DEFAULT_WIRE_HANDLES).toContain("rotowirenfl.bsky.social");
    expect(DEFAULT_WIRE_HANDLES).toContain("mikereiss.bsky.social");
  });
});
```

- [ ] **Step 2: Replace the constant** (every handle verified active on 2026-09-07 via `getAuthorFeed`; posts/day and share of player-news posts measured over the latest 50 posts):

```ts
/**
 * Default wire — every handle verified ACTIVE (≥3 posts in the last 7 days)
 * on 2026-09-07 by polling getAuthorFeed. Editable in Setup → Advanced → Data
 * sources. Confirmed dormant, deliberately excluded: Field Yates (last post
 * 2025-10), Jordan Schultz (2025-04), Matt Harmon (2026-08-11, quiet), the
 * official adamschefter.bsky.social (2024-11), FantasyPros (2026-02), Sleeper
 * (2025-03), Fantasy Footballers (2023), Sharp Football (2026-02), and the old
 * adamschefter-mirror.bluesky.bot (2025-02). Garafolo, Russini, Fowler, Breer,
 * Meirov and Dov Kleiman have no active Bluesky presence — the aggregators
 * below relay them. The name matcher only fires on board players, so beat
 * accounts add coverage without adding noise.
 */
export const DEFAULT_WIRE_HANDLES = [
  // National insiders
  "rapsheet.bsky.social", // Ian Rapoport — NFL Network / ESPN
  "tompelissero.bsky.social", // Tom Pelissero — NFL Network (low volume here)
  "profootballtalk.bsky.social", // ProFootballTalk — high-volume NFL news
  "mattlombardo.bsky.social", // Matt Lombardo — national NFL reporter
  // Aggregators (relay Schefter, Garafolo, Fowler, Breer… in real time)
  "nflnewsreposterbot.bsky.social",
  "insidenflnews.bsky.social", // NFL Daily News
  "nflnewsposter.bsky.social", // reposts beat reporters, tagged [Reporter]
  "adamscheftermirror.bsky.social", // the live Schefter mirror
  // Fantasy news bots
  "rotoworld-fb.bsky.social", // Rotoworld — per-player notes
  "rotowirenfl.bsky.social", // RotoWire NFL — per-player notes
  "matthewberry.bsky.social", // Matthew Berry
  // Beat reporters / team outlets (team in comment)
  "darrenurban.bsky.social", // ARI — Cardinals team site
  "thefalcoholic.bsky.social", // ATL — SB Nation Falcons
  "brianwacker1.bsky.social", // BAL — Baltimore Sun
  "ravensbot.bsky.social", // BAL — mirror of the team account
  "agetzenberg.bsky.social", // BUF — ESPN
  "joebuscaglia.bsky.social", // BUF — The Athletic
  "mikekayefootball.bsky.social", // CAR — ESPN
  "daringantt.bsky.social", // CAR — Panthers.com
  "kfishbain.bsky.social", // CHI — The Athletic
  "seanhammond.bsky.social", // CHI — Chicago Tribune
  "jamesrapien.bsky.social", // CIN — SI Bengals
  "spencito.bsky.social", // CLE — SI Browns
  "ceasterlingabj.bsky.social", // CLE — Akron Beacon Journal
  "kddrummondnfl.blacksky.app", // DAL — Cowboys Wire
  "codyroarknfl.bsky.social", // DEN — Mile High Sports
  "masedenver.bsky.social", // DEN — DenverSports.com
  "davebirkett.bsky.social", // DET — Detroit Free Press
  "detroitfootball.net", // DET — Detroit Football Network
  "wendellfp.bsky.social", // GB — A to Z Sports
  "byjbh.bsky.social", // GB — Jason B. Hirschhorn
  "aaronwilsonnfl.bsky.social", // HOU — KPRC 2
  "demetrius.bsky.social", // JAX — Florida Times-Union
  "mikesansone.bsky.social", // KC/CHI — The Athletic editor
  "levidamien.bsky.social", // LV — Raiders Wire
  "paulhgutierrez.bsky.social", // LV — Raiders.com
  "nateatkins.bsky.social", // LAR — The Athletic
  "stujrams.bsky.social", // LAR — Rams staff writer
  "alainpoupart.bsky.social", // MIA — SI Dolphins
  "emleiker.bsky.social", // MIN — Star Tribune
  "bengoessling.bsky.social", // MIN — Star Tribune
  "mikereiss.bsky.social", // NE — ESPN
  "andrewcallahan.bsky.social", // NE — Boston Herald
  "patriciatraina.bsky.social", // NYG — SI Giants
  "antwanstaley.bsky.social", // NYJ — NY Daily News
  "jimmykempski.bsky.social", // PHI — PhillyVoice
  "zberm.bsky.social", // PHI — The Athletic
  "mikedefabo.bsky.social", // PIT — The Athletic
  "cartercritiques.bsky.social", // PIT — Post-Gazette
  "mattmaiocco.bsky.social", // SF — NBC Sports Bay Area
  "mattbarrows.bsky.social", // SF — The Athletic
  "johnpboyle.bsky.social", // SEA — Seahawks.com
  "fieldgulls.bsky.social", // SEA — SB Nation Seahawks
  "teresamwalker.bsky.social", // TEN — AP
  // No active beat account found for IND, LAC, NO, TB, WAS (2026-09-07) — the aggregators and lists cover them.
];
```

- [ ] **Step 3: Run `pnpm vitest run tests/wireHandles.test.ts` → PASS.** Sanity-check request volume: 55 handles × 1 `getAuthorFeed` per 10 min ≈ 28 requests / 5 min.

- [ ] **Step 4: Commit**

```bash
git add lib/client/bskyNews.ts tests/wireHandles.test.ts
git commit -m "Wire: 55 verified-active Bluesky handles — insiders, aggregators, RotoWire/Rotoworld bots, beat reporters for 27 teams"
```

---

### Task 10: Curated Bluesky lists as a source + blocklist

**Files:**
- Modify: `lib/client/bskyNews.ts` (pure `feedToNews`, `parseListRef`, real `fetchListNews`, `resolveListMembers`), `lib/client/sources.ts` (defaults + docs), `components/Setup.tsx` (two textareas)
- Test: `tests/bskyFeed.test.ts`

**Interfaces:**
- `feedToNews(feed: BskyFeedItem[], opts: { fallbackHandle?: string; blocked?: ReadonlySet<string>; skipReposts?: boolean; skipReplies?: boolean }): NewsItem[]`.
- `parseListRef(ref: string): { uri: string } | { handle: string; rkey: string } | null` — accepts `at://did:plc:…/app.bsky.graph.list/<rkey>` or `https://bsky.app/profile/<handle-or-did>/lists/<rkey>`.
- `listUri(ref): Promise<string | null>` resolves the handle form via `com.atproto.identity.resolveHandle`.
- `fetchListNews(players, lists: string[], blocked: Set<string>): Promise<Map<string, PlayerNews>>` — `app.bsky.feed.getListFeed?list=…&limit=100`, one page per list, 48 h window.
- `resolveListMembers(lists: string[], blocked: Set<string>): Promise<Map<string, string>>` — DID → handle via `app.bsky.graph.getList` (paginate `cursor`, `limit=100`).
- `DEFAULT_WIRE_LISTS = ["at://did:plc:pgxejfwpltr73b6amkirahwd/app.bsky.graph.list/3lasn45b4da2l", "at://did:plc:zlyvxtoj3bwk4gyhvfqd3jdn/app.bsky.graph.list/3laulwjvwky2r"]` ("NFL beat writers and reporters", 111 members; "NFL News and Analysts", 139 — both verified 2026-09-07).
- `SourcePrefs.wireLists: string[]` defaults to `DEFAULT_WIRE_LISTS`; `SourcePrefs.wireBlock: string[]` defaults to `[]`. Empty `wireLists` = no lists (today's behaviour).

- [ ] **Step 1: Failing test**

```ts
// tests/bskyFeed.test.ts
import { describe, it, expect } from "vitest";
import { feedToNews, parseListRef } from "../lib/client/bskyNews";

const post = (handle: string, text: string, extra: Record<string, unknown> = {}) => ({
  post: { uri: `at://did:plc:x/app.bsky.feed.post/${text.length}`, author: { handle }, record: { text, createdAt: "2026-09-07T12:00:00Z", ...extra } },
});

describe("feedToNews", () => {
  it("maps posts to news items with a bsky.app link", () => {
    const [n] = feedToNews([post("rapsheet.bsky.social", "Bijan Robinson ruled out")], {});
    expect(n).toMatchObject({ headline: "Bijan Robinson ruled out", published: "2026-09-07T12:00:00Z", athleteIds: [] });
    expect(n.href).toBe("https://bsky.app/profile/rapsheet.bsky.social/post/24");
  });
  it("skips reposts, replies and blocked handles when asked", () => {
    const feed = [
      { ...post("a.bsky.social", "repost"), reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
      post("b.bsky.social", "reply", { reply: { parent: {} } }),
      post("spam.bsky.social", "blocked"),
      post("ok.bsky.social", "kept"),
    ];
    const out = feedToNews(feed as never, { blocked: new Set(["spam.bsky.social"]), skipReposts: true, skipReplies: true });
    expect(out.map((n) => n.headline)).toEqual(["kept"]);
  });
  it("truncates long headlines to 140 chars + ellipsis but keeps the full text as description", () => {
    const text = "x".repeat(200);
    const [n] = feedToNews([post("a.bsky.social", text)], {});
    expect(n.headline).toHaveLength(141);
    expect(n.description).toBe(text);
  });
});

describe("parseListRef", () => {
  it("accepts AT-URIs", () => expect(parseListRef("at://did:plc:abc/app.bsky.graph.list/3lasn")).toEqual({ uri: "at://did:plc:abc/app.bsky.graph.list/3lasn" }));
  it("accepts bsky.app list URLs", () => expect(parseListRef("https://bsky.app/profile/bernzone.bsky.social/lists/3lasn45b4da2l")).toEqual({ handle: "bernzone.bsky.social", rkey: "3lasn45b4da2l" }));
  it("rejects junk", () => expect(parseListRef("hello")).toBeNull());
});
```

- [ ] **Step 2: Run → FAIL.** Implement in `lib/client/bskyNews.ts` (replace the stubs from Task 5):

```ts
export interface BskyFeedItem {
  post?: { uri?: string; author?: { handle?: string }; record?: { text?: string; createdAt?: string; reply?: unknown } };
  reason?: unknown;
}

export function feedToNews(
  feed: BskyFeedItem[],
  opts: { fallbackHandle?: string; blocked?: ReadonlySet<string>; skipReposts?: boolean; skipReplies?: boolean }
): NewsItem[] {
  const out: NewsItem[] = [];
  for (const f of feed) {
    if (opts.skipReposts && f.reason) continue;
    if (opts.skipReplies && f.post?.record?.reply) continue;
    const handle = f.post?.author?.handle ?? opts.fallbackHandle;
    if (handle && opts.blocked?.has(handle)) continue;
    const text = f.post?.record?.text ?? "";
    if (!text) continue;
    out.push({
      headline: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      description: text,
      published: f.post?.record?.createdAt ?? "",
      href: postUrl(f.post?.uri, handle),
      athleteIds: [],
    });
  }
  return out;
}
```
Refactor `fetchWireNews` to `items.push(...feedToNews(json.feed ?? [], { fallbackHandle: handle }))`.

```ts
export const DEFAULT_WIRE_LISTS = [
  "at://did:plc:pgxejfwpltr73b6amkirahwd/app.bsky.graph.list/3lasn45b4da2l", // "NFL beat writers and reporters" (111)
  "at://did:plc:zlyvxtoj3bwk4gyhvfqd3jdn/app.bsky.graph.list/3laulwjvwky2r", // "NFL News and Analysts" (139)
];

export function parseListRef(ref: string): { uri: string } | { handle: string; rkey: string } | null {
  const s = ref.trim();
  if (/^at:\/\/did:[a-z0-9:]+\/app\.bsky\.graph\.list\/[a-z0-9]+$/i.test(s)) return { uri: s };
  const m = s.match(/^https?:\/\/bsky\.app\/profile\/([^/]+)\/lists\/([a-z0-9]+)\/?$/i);
  return m ? { handle: m[1], rkey: m[2] } : null;
}

const API = "https://public.api.bsky.app/xrpc/";

async function listUri(ref: string): Promise<string | null> {
  const parsed = parseListRef(ref);
  if (!parsed) return null;
  if ("uri" in parsed) return parsed.uri;
  if (parsed.handle.startsWith("did:")) return `at://${parsed.handle}/app.bsky.graph.list/${parsed.rkey}`;
  const res = await fetch(`${API}com.atproto.identity.resolveHandle?handle=${encodeURIComponent(parsed.handle)}`);
  if (!res.ok) return null;
  const { did } = (await res.json()) as { did?: string };
  return did ? `at://${did}/app.bsky.graph.list/${parsed.rkey}` : null;
}

/** One request per list backfills every member's recent posts (48 h window). */
export async function fetchListNews(players: BoardPlayer[], lists: string[], blocked: Set<string>): Promise<Map<string, PlayerNews>> {
  const items: NewsItem[] = [];
  await Promise.all(
    lists.map(async (ref) => {
      try {
        const uri = await listUri(ref);
        if (!uri) return;
        const res = await fetch(`${API}app.bsky.feed.getListFeed?list=${encodeURIComponent(uri)}&limit=100`);
        if (!res.ok) return;
        const json = (await res.json()) as { feed?: BskyFeedItem[] };
        items.push(...feedToNews(json.feed ?? [], { blocked, skipReposts: true, skipReplies: true }));
      } catch {
        // a dead list shouldn't kill the wire
      }
    })
  );
  return matchNewsToPlayers(items, players, 48);
}

/** DID → handle for every list member, for the Jetstream filter (cap 10,000 DIDs). */
export async function resolveListMembers(lists: string[], blocked: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    lists.map(async (ref) => {
      try {
        const uri = await listUri(ref);
        if (!uri) return;
        let cursor: string | undefined;
        do {
          const res = await fetch(`${API}app.bsky.graph.getList?list=${encodeURIComponent(uri)}&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
          if (!res.ok) return;
          const json = (await res.json()) as { cursor?: string; items?: { subject?: { did?: string; handle?: string } }[] };
          for (const it of json.items ?? []) {
            const { did, handle } = it.subject ?? {};
            if (did && handle && !blocked.has(handle)) out.set(did, handle);
          }
          cursor = json.cursor;
        } while (cursor && out.size < 9_000);
      } catch {
        // skip
      }
    })
  );
  return out;
}
```

`lib/client/sources.ts`: `wireLists: DEFAULT_WIRE_LISTS` (import from `./bskyNews`; if this creates an import cycle, move `DEFAULT_WIRE_LISTS` into `sources.ts` and import it from `bskyNews.ts` instead) and `wireBlock: []`, with doc comments:

```ts
  /** Curated Bluesky lists (AT-URIs or bsky.app list URLs) whose members join the wire. Empty = none. */
  wireLists: string[];
  /** Handles to ignore everywhere on the wire (e.g. a noisy list member). */
  wireBlock: string[];
```

- [ ] **Step 3: Setup UI** — under the handles textarea in `components/Setup.tsx` (inside `{sources.wire && (…)}`), add two more labelled textareas following the exact styling of the handles one:

```tsx
<label className="mt-2 block text-xs text-ink-dim">
  Curated lists — one per line (bsky.app list URL or at:// URI). Every member joins the wire. Two NFL reporter lists are on by default; clear to follow handles only.
  <textarea rows={3} value={sources.wireLists.join("\n")}
    onChange={(e) => updateSources({ ...sources, wireLists: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
    className="mt-1 w-full rounded border border-line bg-field px-3 py-2 font-mono text-xs" />
</label>
<label className="mt-2 block text-xs text-ink-dim">
  Blocklist — handles to ignore, one per line.
  <textarea rows={2} value={sources.wireBlock.join("\n")}
    onChange={(e) => updateSources({ ...sources, wireBlock: e.target.value.split("\n").map((h) => h.trim().replace(/^@/, "")).filter(Boolean) })}
    className="mt-1 w-full rounded border border-line bg-field px-3 py-2 font-mono text-xs" />
</label>
```

- [ ] **Step 4: Run tests, type-check, lint; then `pnpm dev`** and confirm in the Network tab: two `getListFeed` calls and paginated `getList` calls on Cockpit mount, and the Jetstream URL contains >100 `wantedDids`. If the websocket refuses the long URL (HTTP 414 or immediate close), switch to sending an `options_update` frame after `onopen` per Jetstream v1: `ws.send(JSON.stringify({ type: "options_update", payload: { wantedCollections: ["app.bsky.feed.post"], wantedDids: [...] } }))` with `&requireHello=true` in the URL, and note it in the code.

- [ ] **Step 5: Commit**

```bash
git add lib/client/bskyNews.ts lib/client/sources.ts components/Setup.tsx tests/bskyFeed.test.ts
git commit -m "Wire: curated Bluesky lists (getListFeed backfill + Jetstream DIDs) and a blocklist; two NFL reporter lists on by default"
```

---

### Task 11: YouTube creators spike (Phase 3)

**Files:**
- Create: `scripts/spike-youtube.ts`, `.github/workflows/spike-youtube.yml`

- [ ] **Step 1: The script** (no tests — a spike; output is the answer)

```ts
// scripts/spike-youtube.ts
// Feasibility probe, run from a GitHub runner: can we (a) list a channel's
// uploads via its keyless RSS feed and (b) download the newest video's
// caption track via YouTube's player endpoint, without an API key? Prints one
// line per step so the Actions log is the verdict. Throwaway by design.
const CHANNELS: Record<string, string> = {
  "The Fantasy Footballers": "UCqGPgdY57NiYd-rHLGMaj8w",
  FantasyPros: "UCreYqBhq0uRvxiaXJU-gsGw",
};
const UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";

async function main() {
  for (const [name, channelId] of Object.entries(CHANNELS)) {
    const rss = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    const xml = rss.ok ? await rss.text() : "";
    const vid = xml.match(/<yt:videoId>([^<]+)</)?.[1];
    const title = xml.match(/<media:title>([^<]+)</)?.[1];
    console.log(`[${name}] rss=${rss.status} newest=${vid ?? "-"} "${title ?? ""}"`);
    if (!vid) continue;
    const player = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en" } }, videoId: vid, contentCheckOk: true, racyCheckOk: true }),
    });
    const json = (await player.json()) as { playabilityStatus?: { status?: string; reason?: string }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl: string; languageCode: string; kind?: string }[] } } };
    const tracks = json.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    console.log(`[${name}] player=${player.status} playability=${json.playabilityStatus?.status} ${json.playabilityStatus?.reason ?? ""} tracks=${tracks.map((t) => `${t.languageCode}/${t.kind ?? "manual"}`).join(",")}`);
    const en = tracks.find((t) => t.languageCode.startsWith("en"));
    if (!en) continue;
    const cap = await fetch(en.baseUrl, { headers: { "user-agent": UA } });
    const body = await cap.text();
    const words = body.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    console.log(`[${name}] captions=${cap.status} bytes=${body.length} words≈${words} ${words > 200 ? "✅ TRANSCRIPT OK" : "❌ BLOCKED OR EMPTY"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: The workflow**

```yaml
name: Spike — YouTube transcripts from a runner
on:
  workflow_dispatch: {}
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsx scripts/spike-youtube.ts
```

- [ ] **Step 3: Run locally once** (`pnpm exec tsx scripts/spike-youtube.ts`) to confirm the script itself works from a residential IP (expected: TRANSCRIPT OK for both). Commit, push, then `gh workflow run spike-youtube.yml` and read the log. Record the verdict in the spec's Phase 3 section.

```bash
git add scripts/spike-youtube.ts .github/workflows/spike-youtube.yml
git commit -m "Spike: can a GitHub runner fetch YouTube channel RSS and caption tracks keylessly?"
```

---

### Task 12: Docs

**Files:**
- Modify: `README.md` (line 130 cadence paragraph; line 126 sources), `AGENTS.md` (one bullet)

- [ ] **Step 1:** In `README.md` replace "rebuilds them **three times a day** … evening" with a sentence describing the two lanes (fast every 30 min, boards only; full daily with fixtures, FantasyPros, Sleeper dump), and add to the sources list: "Injury statuses: Sleeper at build time, **ESPN's league injuries table live in the browser** (every 10 min and at draft start); headlines: ESPN, CBS, RotoWire RSS (browser) + Yahoo, ProFootballTalk (baked); Bluesky wire: 55 reporters/aggregators plus two curated reporter lists via Jetstream."
- [ ] **Step 2:** In `AGENTS.md` add under project notes: "- **CI lanes**: `pnpm build:board --lane=fast` must never call FantasyPros or the Sleeper player dump; add a new source to the fast lane only if it tolerates 48 fetches/day. The browser refreshes the board with `cache: "no-cache"` at Setup and draft start; `public/sw.js` is network-first for `/data/*`."
- [ ] **Step 3: Commit**

```bash
git add README.md AGENTS.md
git commit -m "Docs: two-lane refresh, live injury table, feeds and wire coverage"
```

---

## Self-review

- **Spec coverage.** 1a → Tasks 7–8. 1b → Task 6. 1c → Tasks 1, 4, 5, 7 (ETL side). 1d → Tasks 3, 7. 1e → Task 5. 2a → Task 9. 2b → Task 10. Phase 3 → Task 11. Phase 4 → separate plan (by design). Testing section → tasks 1, 3, 4, 6, 7, 9, 10 carry unit tests; manual checks in 6, 8, 10.
- **Placeholders.** None: every code step shows the code; the only "find and replace" instructions point at exact line ranges read on 2026-09-07 (`Cockpit.tsx:88-89`, `117-168`, `171-190`, `1302`; `page.tsx:86-140`; `Setup.tsx` resume card ~177).
- **Type consistency.** `FeedStatus`, `LiveStatus`, `gradeBoard(board, liveStatus, news)` used identically in Tasks 1, 4, 5, 7. `NewsItem`/`PlayerNews` come from `lib/etl/newsMatch` everywhere after Task 2. `fetchListNews(players, lists, blocked)` and `resolveListMembers(lists, blocked)` match between Tasks 5 (stubs) and 10. `parseLane`, `carryForwardFp`, `fixtureOnly` naming consistent across Task 7 and 8.
- **Off states.** `--lane` absent = full; `wireLists: []` = no lists; blocklist empty; SW change only affects `/data/*`.
