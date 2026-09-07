# Data freshness, wider news aggregation, and the Newsroom

Date: 2026-09-07. Status: approved in chat; Phase 4 is queued behind Phases 1–3.

## Goal

The owner wants the board and every player's news to be as current as is
possible under exactly two constraints: everything stays free, and nothing
hits a rate limit. Today's cadence and plumbing fall short in ways that were
measured, not guessed:

| Finding (verified 2026-09-07) | Consequence |
|---|---|
| The "3x/day" schedule is the CI board rebuild; Bluesky is browser-side (10-min poll + Jetstream push) | Breaking reporter posts already arrive live; the stale parts are ADP, projections and **injury status** |
| FantasyPros returns HTTP 429 in every recent build (`consensus (0 experts)`, news skipped) | The free-tier quota is exhausted by 3 builds/day of ~40 throttled requests each |
| `public/sw.js` is stale-while-revalidate for the board JSON | The browser shows the *previous* build at draft start regardless of CI cadence |
| FFC ADP is served from a 1-hour cache and is not CORS-open | Rebuilding faster than hourly returns identical ADP; the browser cannot refresh it |
| ESPN's league-wide injuries table is CORS-open, 10 s cache, structured statuses, joins by ESPN id (266 of top-293 board players) | Live Questionable/Doubtful/Out/IR/Sus for the whole board, keyless, from the browser |
| Bluesky public AppView limits are "generous" (unpublished); Jetstream accepts up to 10,000 DIDs; `getListFeed` works unauthenticated; `searchPosts` requires auth | Aggregation can widen by an order of magnitude at negligible request cost |
| YouTube channel RSS and caption tracks are fetchable without a key (13,371 words from a 72-min episode); datacenter IPs may be blocked | Feasible, but must be spiked from a GitHub runner before building on it |

## Non-negotiables carried forward

- Engine stays pure (`lib/engine/`): text/status in, score/status out. All I/O
  in `lib/client/` or the ETL.
- No paid services at runtime. Free API keys are acceptable **only** as GitHub
  Actions secrets used at build time (FantasyPros precedent). Nothing keyed
  runs in the browser.
- Every lever has an off state that reproduces today's behaviour.
- `pnpm build:board` keeps working offline from `data/raw/` fixtures.

## Phase 1 — freshness plumbing

### 1a. Two CI lanes

Split `.github/workflows/build-board.yml`:

- **Fast lane**, `*/30 * * * *`. Runs `pnpm build:board --lane=fast`: FFC ADP,
  ESPN projections, Sleeper projections, ESPN injuries, RSS news. Reads the
  slow-lane sources from fixtures. Commits **only** `public/data` and only when
  the boards changed. Rationale: each refresh commit today rewrites 15 MB of
  fixtures; the repo already carries 86 MB of loose objects from 48 bot commits.
- **Slow lane**, `20 9 * * *`. Full build: Sleeper player dump (Sleeper asks
  for at most daily), FantasyPros (fresh daily quota), DynastyProcess, nflverse.
  Commits fixtures + boards.
- `--lane` defaults to `full` so local `pnpm build:board` is unchanged.
- Board `meta.builtAt` already exists; add `meta.lane` and per-source
  `fetchedAt` is already there.

30 minutes is the honest ceiling: FFC is hourly-cached and projections move
daily. Faster only churns git. Live browser feeds cover the minutes.

### 1b. Fresh board at draft start

`app/page.tsx` fetches the board with `cache: "reload"` when Setup opens and
when a draft starts, falling back to the service-worker cache when the network
fails (offline PWA behaviour is preserved). Show the board age ("built 12 min
ago") in Setup and in the Cockpit ⋯ menu. `sw.js` unchanged.

### 1c. Live injury status (browser)

New `lib/client/espnInjuries.ts` (I/O) + pure `lib/engine/injuryFeed.ts`:

- `mapEspnStatus(status: string): InjuryStatus | "Active" | null` — ESPN
  vocabulary (`Injured Reserve`, `Suspension`, `Questionable`, `Doubtful`,
  `Out`, `Active`) → board vocabulary.
- `reconcileStatus(baked, live, bakedIsSeasonLong)`: the structured feed
  **replaces** Questionable/Doubtful/Out/Active (it may clear a player);
  season-long baked statuses (`IR`, `PUP`, `Sus`, `NA`, `COV`, `DNR`) stay
  unless the feed says `Active` — then cleared. Keyword news (`classifyNews`)
  stays escalate-only via `liveInjuryStatus`.
- Also emits `PlayerNews` from the row's dated comment so players with no
  reporter post still get a 📰 with the ESPN/Rotowire note.
- Polled at draft start and every 10 minutes with the other live signals.
- Same table is added to the ETL so the baked snapshot and the live overlay
  agree on vocabulary.

### 1d. More headline feeds

- Browser (CORS-open, verified): CBS Sports NFL headlines, ESPN NFL RSS,
  RotoWire NFL news RSS. Parsed with `DOMParser`, matched with
  `matchNewsToPlayers`.
- CI (no CORS): Yahoo Sports NFL RSS, ProFootballTalk feed → baked into
  `player.news` (72 h window), replacing the dead FantasyPros news path as the
  primary baked source.

### 1e. Shared live-signals hook

Extract the Cockpit's news/trending/wire effect into `lib/client/useLiveSignals.ts`
returning `{ boardNews, trendingIds, liveStatus, feed, connected, lastRefresh }`
so the Cockpit and the Newsroom run identical plumbing.

## Phase 2 — Bluesky expansion

### 2a. Default handles

`DEFAULT_WIRE_HANDLES` grows from 6 to ~50 accounts verified active on
2026-09-07: national insiders and the four aggregators (`rotowirenfl`,
`insidenflnews`, `nflnewsposter`, `adamscheftermirror`), plus one or two beat
reporters per team where an active one exists (28 of 32 teams today). Each
entry carries a comment with team/role. The dormant list in the comment is
updated (Field Yates, Schultz, Harmon, FantasyPros, Sleeper, Fantasy
Footballers, Sharp, official Schefter handle).

### 2b. Curated lists as a source

`SourcePrefs.wireLists: string[]` (AT-URIs). Default on with the two best
curated lists found ("NFL beat writers and reporters", 111 members; "NFL News
and Analysts", 139). Backfill: `app.bsky.feed.getListFeed` (one request per
page, ≤ 50 posts). Live: list members' DIDs are added to the Jetstream filter
(cap 10,000). Local blocklist `wireBlock: string[]` for handles the user
never wants. Editable in Setup → Advanced → Data sources. Off state = empty
array = today's behaviour.

Request budget after expansion: ~60 `getAuthorFeed` + ~6 `getListFeed` per
10 minutes ≈ 33 requests / 5 min. Reference ceiling on Bluesky's PDS is 3,000.

## Phase 3 — YouTube creators (spike, then decide)

Spike: one workflow_dispatch job that, for five fantasy channels, fetches the
channel RSS and the newest video's caption track via the innertube player
endpoint, and prints success/failure per step. Decision rule: if captions
download from a GitHub runner, build `lib/etl/creators.ts` (mention counts per
board player over 7 days, per video timestamps) baked as `player.buzz`; if
runners are blocked, ship it as a local script (`pnpm build:creators`) the
owner runs before draft week, committing fixtures. No LLM anywhere; the signal
is *who is being talked about*, surfaced as a badge and card links, never
graded into the engine.

## Phase 4 — Newsroom (build after Phases 1–3)

A standalone route `/newsroom` that needs no draft in progress.

**Data.** Loads the board for the user's saved scoring (PPR default) with
`cache: "reload"`, runs `useLiveSignals`, and applies the same
`gradedBoard` merge the Cockpit uses.

**Importance score** (pure, `lib/engine/newsImportance.ts`, unit-tested):

```
severity  ∈ [0,1]: season-ending/IR/torn 1.0 · suspension/arrest 0.9 ·
            Out/carted off 0.7 · trade/signed/released/waived 0.6 ·
            Doubtful 0.5 · returns/activated/cleared 0.4 ·
            Questionable/limited/DNP 0.35 · depth chart/starter named 0.3 ·
            generic mention 0.1
relevance ∈ [0,1]: 1 − 0.8·min(adp, 300)/300   (adp 1→1.0, 50→0.87, 150→0.6)
recency   = 0.5^(ageHours / 12)
importance = severity × (0.4 + 0.6·relevance) × recency
```

A structured status change from the ESPN table (e.g. Questionable → Out) is
emitted as its own feed item with the severity of the new status. Worked
example the owner gave: ADP-50 broken leg ≈ 0.92 vs ADP-1 generic mention 0.1.

**Layout.**

1. Top strip: live indicator (Jetstream connected, last refresh), counts for
   the last hour (posts, status changes), today's injury-table summary
   (Q/D/O/IR counts), and Sleeper "most added" movers.
2. "What matters" feed: items sorted by importance, each showing player,
   position/team, ADP, the headline, source and age, with a click-through to
   the post/article and to the player card. Filters: position, team, my
   watchlist (localStorage), severity floor.
3. Full player browser: every board player, sortable by ADP/position/team,
   search box, badges (injury, 📰, 🔥). Clicking opens `PlayerModal` with
   `readonly` (already supported for Recap).

Design follows the app's existing tokens (see `app/globals.css`). Live updates
must never reorder under the cursor: new items enter at the top with a
"N new" pill until the user scrolls to top.

## Testing

- Vitest: `injuryFeed` mapping/reconciliation table; RSS parser fixtures;
  `newsImportance` monotonicity and the worked example; `useLiveSignals` merge
  order (baked < ESPN < wire by recency).
- ETL: `--lane=fast` builds offline from fixtures; slow lane unchanged.
- Existing `<50 ms` recompute test unaffected (engine untouched).
- Manual: open Setup, confirm "built N min ago" reflects the newest CI commit;
  start a draft with the network throttled to offline and confirm the cached
  board still loads.
