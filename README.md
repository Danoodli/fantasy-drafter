# Draft Cockpit

A free, local-first fantasy football draft assistant. It sits on a second screen during a live draft and tells you **exactly who to take**, why, and what you're giving up — based on your league's real scoring, your roster, who's already gone, and a strategy you picked in advance.

Total recurring cost: **$0.00**. Static JSON board, no database, no LLM calls, free APIs only.

## Quickstart

```bash
pnpm install
pnpm build:board   # fetch live data, build public/data/board-*.json
pnpm dev           # open http://localhost:3000
```

First run walks you through setup:

- **Sleeper mode** — paste your draft URL (or draft/league id). Teams, rounds, scoring, and roster slots are auto-derived from the Sleeper API; picks mirror into the app every 2 seconds, hands-free. If your league id is configured, the board is re-scored client-side with your league's exact `scoring_settings`.
- **Manual mode** — for ESPN/Yahoo/Underdog/DraftKings/anything else. Three ways to get the room's picks in without typing every name: **Screen sync** (share the draft tab; the cockpit reads new picks off the screen), **Paste picks** (copy the drafted list, ⌘V anywhere), and the **on-the-clock shortlist** (one-click chips for what the seat picking now is likely to take). Typing a name ("ceedee" works) still works as the fallback. Undo with ⌘Z. See [Getting the room's picks in](#getting-the-rooms-picks-in).

Your slot, config, and every manual action are mirrored to localStorage — a browser refresh mid-draft recovers everything.

## Draft night runbook

1. The night before: `pnpm build:board` (or let the nightly GitHub Action do it). Check the build log for warnings.
2. Open the app, load your draft, pick your slot and strategy.
3. When you're on the clock, the answer is already on screen: one name, one reason, two alternates. The button confirms — it never computes.
4. Keyboard: `Enter` drafts the recommendation, `/` focuses manual entry, `⌘Z` undoes.
5. If the wifi dies: everything keeps working offline except live sync — mark picks manually.
6. **← Home** goes back to setup any time; the draft stays saved and the setup screen offers **Resume draft**. Every destructive action (leave, reset, auto-complete, start a new draft) asks first.

## How it works

```
COLD  (nightly)   scripts/build-board.ts: FFC ADP + ESPN raw projections +
                  DynastyProcess crosswalk/ECR → join → score with league
                  settings → VORP/VOLS/tiers → public/data/board-*.json
WARM  (page load) board JSON hydrates once; works offline afterwards
HOT   (every 2s)  poll Sleeper picks → diff → recompute client-side (<50ms)
```

The engine (`lib/engine/`) is pure functions, no I/O:

- **Survival**: P(player available at pick n) from FFC's per-player ADP mean + stdev via the normal CDF, shifted by observed **room drift** per position.
- **VONA**: each candidate vs. the expected best at his position at your next pick — tier-cliff urgency falls out of the math.
- **Monte Carlo**: simulates the room between your picks (ADP + noise + roster-need), scores candidates on `E[value] − λ·stdev`.
- **Strategies are config, not code** (`config/strategies.json`): λ, VORP/VOLS blend, ADP discipline, stacking, position multipliers by round. The Custom strategy exposes the dials as sliders — λ can go negative to *pay* for variance.
- **Value is roster-marginal, not league-wide** (redraft `valueModel: "lineup"`, the default): a player who would fill an open starting or FLEX slot is valued by what taking him now adds over the best you can expect at his position at your next pick (VONA, so position runs and tier cliffs matter) blended with his quality against the league's last starter; a bench player is valued as insurance — VORP scaled by the odds he ever starts. A bench player is valued as **insurance** (`lib/engine/coverage.ts`): the expected starting slot-weeks he fills that the roster would otherwise leave *empty* — byes counted exactly, missed games by per-position rate — times his weekly scoring rate. A 3rd WR on a 2-WR roster covers ~5 slot-weeks; an 8th RB ~0.02. Redraft floors of 2 QB / 3 RB / 3 WR (TE/K/DST exempt) are a backstop the math should rarely need; an empty starting slot always outranks a depth floor when picks run out. This is what makes "balanced" adapt to the board as it empties instead of stacking one position — and why 7 RB / 2 WR is now unreachable. The legacy `"blend"` model (pure VORP/VOLS scarcity) is still available per strategy; it priced two same-projection FLEX candidates 84 points apart because RB58 projects 80 and WR58 projects 161, and drafted exactly that roster.
- **The app picks the strategy for your format.** No preset wins both formats in the season backtest — Robust RB is far ahead in best ball (+321 vs the ADP bot over 2024–25) and mid-pack in redraft, Balanced the reverse — so best ball auto-selects Robust RB and redraft Balanced (`Strategy.recommendedFor`, marked "· recommended" in the picker). Presets that lose in both formats are `hidden` from the picker but stay in config so `--strategy=all` keeps measuring them.
- **Best ball mode** (Underdog/DraftKings-style draft-once tournaments, or any Sleeper best-ball league — auto-detected): value anchors to a market curve instead of season-total VORP, roster construction chases 2-3 QB / 5-6 RB / 7-9 WR / 2-3 TE targets, QB↔receiver stacks earn a bonus, and K/DST disappear when the format has none.
- **Injury + depth data** from Sleeper is baked into the board nightly: IR/PUP players are never recommended, Out/Doubtful are discounted, and late rounds get a handcuff bonus for your own RBs' direct backups.
- **History-fitted room drift**: with a `leagueId` in `config/league.json`, the nightly build fits per-position ADP bias from your league's previous draft and seeds draft-night drift with it.

## Scripts

| command | what |
|---|---|
| `pnpm dev` | run the app |
| `pnpm build:board` | rebuild boards from live sources (falls back to committed fixtures in `data/raw/` with a loud staleness warning) |
| `pnpm test` | engine math test suite (vitest) |
| `pnpm backtest <draft_id> <slot> [strategy] [scoring]` | replay a real Sleeper draft with the engine in your slot; compare rosters |
| `pnpm simulate <draft_id> [slot] [scoring] [--sims=500] [--bestball]` | run every roster in a drafted room through hundreds of simulated seasons; report win rates and ceiling percentiles |
| `pnpm backtest:season <year> [--format=ppr] [--strategy=balanced\|all] [--rooms=12] [--bestball]` | draft a **past** season with that year's draft-day ADP + projections, then score every roster with what really happened — see [Season backtest](#season-backtest) |
| `pnpm calibrate:survival <draft_id> [...] [--year=2025] [--write]` | score the survival model against real Sleeper drafts and fit the tail lever in `config/survival.json` — see [Survival tail lever](#survival-tail-lever) |

## Getting the room's picks in

The engine is only as good as its picture of the room, and on any site but Sleeper that picture used to cost one typed name per pick. Now:

- **Screen sync** (any site, fully automatic). Click **Screen sync**, share the browser tab your draft is in, drag a box around its **pick history** (drafted players only — not the available list), and **Watch**. The cockpit reads that region several times a second (two Tesseract.js workers in your browser, WASM — nothing leaves the machine, no login to the draft site) and finds board names in what it read (see *How names are matched* below). **What it trusts is order, never pick numbers**: OCR junk in front of a name is not a pick number, but the panel's top-to-bottom order is exactly the pick order. Each read is reconciled with the picks already known (`lib/draft/sequence.ts`): new names append in order, a pick that was missed is inserted where it belongs and the picks after it shift down, a burst of fast picks lands in one read, and ownership follows the room's snake (slot 12 owns picks 12 and 13). A name must appear in two consecutive reads before it counts. **Your own picks are recorded too**: draft on the site — back-to-back picks included — and the app records what you took, with the same celebration as the Draft button; it advises, it never chooses. If you'd rather click Draft in the app first, that works as well (the screen read then sees a known name and moves on). ESPN lists oldest at top; tick **newest pick at top** for rooms that don't. Dark-mode rooms are inverted and upscaled before OCR; "what the OCR read" shows the raw lines so you can tune the box. The OCR engine downloads on first use (a few MB, from Tesseract's free CDN) and is cached after.
- **Paste picks** (any site, one paste). Copy the drafted list from the draft room, press ⌘V anywhere in the cockpit (or click **Paste picks**), and the preview shows what was recognized, what wasn't (with did-you-mean chips) and what's already off the board. It understands Sleeper `1.05 Name RB - ATL`, ESPN's live room (`Puka Nacua / LAR WR` with `R1, P2 - Team 7` underneath), ESPN's recap `1 (1) Name, ATL RB`, Yahoo `1. (1) Name (Atl - RB)`, `Last, First`, initials, pick/name/meta on separate lines, several names on one line, and bare numbered lists. **Paste backfills what the screen missed.** With pick numbers, each name lands at its number: a placeholder is filled, a gap is padded with unknown picks, and a different player already sitting at that number means a pick was missed — the pasted one is inserted in front and the later picks move down to their real slots. Without pick numbers, the list is aligned by order with the picks already on the board (the same reconciliation screen sync uses), so a name between two known picks slots in between them. Names already on the board are never re-marked; they are the anchors. A toggle handles newest-first lists.
- **How names are matched** (`lib/draft/nameMatch.ts`, shared by both). Names are found *inside* lines, so junk around them doesn't matter: accents are folded (Peña → pena), Jr./Sr./III are ignored on both sides, hyphens and dots are separators, spaced initials merge (`A. J.` = `A.J.` = `AJ`). A surname within one edit plus any first-name evidence (token, prefix or initial) is a find; a lone surname counts only when it is unique on the board or pinned by a position/team token on the same line, and never when a different first name sits in front of it. Two players that fit the same tokens equally well ("B. Robinson" with two RB Robinsons) are a tie: screen sync skips it, paste offers the earlier-ADP one flagged with alternatives. Matching runs against every player and drops drafted ones afterward, so a drafted player's line can't re-read as his surname-mate.
- **On-the-clock shortlist.** When it isn't your turn (and the room isn't syncing itself), the engine runs for the seat picking now — its roster, its remaining picks, the format's default strategy — and shows the top ten as one-click ✕ chips. The panel keeps its own hit rate (how often the real pick was on the list) so you can judge whether it's earning its space.
- **Recent picks + resync.** The strip under the header lists the last six picks with slot and position; manual marks have a ✕, and an **unknown** placeholder can be filled in by name. **+ unknown pick** advances the counter when someone takes a player you can't find; **set pick #** jumps the counter to whatever the real room says (forward pads unknowns, backward removes recent marks).
- **Room strip.** Every seat's position counts in one row, the seat on the clock pulsing, you in green; click a seat for its roster. In manual mode this is the check that picks landed on the right teams.
- **Draft order.** Snake by default; manual setup also offers **snake with third-round reversal** and **linear**, and Sleeper drafts report theirs. Every pick-to-seat mapping — screen sync, paste, the engine's opponent schedule, the room strip, recaps — follows the configured order and any traded picks.

Sleeper drafts still sync from the API with none of this needed.

## Player cards and draft controls

Click any player name anywhere — tier board, alternates, planner, your roster, even the big answer — for the full decision card: verdict and math-derived reasons, the 2026 projected stat line, ADP/ECR/schedule data, a live Rotowire note, last-season stats, and recent headlines (ESPN's public endpoint, fetched in-browser). Mark players gone via search, the answer buttons, the row's hover ✕, or from the card — and undo anything: the toast has an Undo button, ⌘Z works, and any manually-marked player's card offers "Put him back." The ⋯ menu holds draft controls: auto-complete the rest of the draft (engine for you, ADP for the room), end early, resume, or reset.

## Post-draft recap

When the draft ends (or any time via the **Recap** header button), the recap screen shows every roster in the room ranked by projected value, letter-grades each team, calls out the steal and the biggest reach of the draft, and can simulate 300 full seasons in the browser — win rates and p50/p99 ceilings per roster, with your team highlighted.

## Validating and tuning

Join a free Sleeper mock draft and run the app against it — that's the integration test. Then `pnpm backtest <that draft id> <your slot> zero-rb` to see what a different strategy would have produced from the same room.

`pnpm backtest` grades both rosters with the *current* board's projections — useful for comparing strategies against the same room, but circular as a measure of quality (it asks the engine whether it likes its own picks). For the real answer, use the season backtest below.

## Season backtest

`pnpm backtest:season 2025` rebuilds the board as it looked on draft day of a completed season and scores every roster with realized points. It answers two separate questions:

- **A. Projection quality** — rank correlation, pairwise ordering accuracy (when we said A over B, how often were we right?), MAE, and signed bias per position and per draft range. Bias is the tunable: a position that comes in −30 points every year is a projection problem, not bad luck.
- **B. Decision quality** — the engine drafts from every seat of N simulated rooms against ADP-following bots, and its roster's realized points are compared with the bot that would have sat in the *same seat of the same room* (paired by seed, so the room is identical until the engine deviates). Rosters are scored as the sum of each week's optimal lineup — exactly how best ball scores, and the standard "perfect manager" yardstick for redraft. The roster-shape table usually explains the result: it shows how many players the engine took at each position versus the bot, and where the points came from.
- **Roster legality** — per strategy, the share of seats that finished below a construction floor and the expected *empty starting slot-weeks* per season (byes exact, injuries by rate), engine vs bot. Expected points alone hid a 7 RB / 2 WR roster; this makes it a loud failure with a non-zero exit code.
- **C.** — the players the engine kept drafting, with their projected vs realized position rank.

Read the error bars as clustered by room, and treat one season as one sample: the engine drafts the same core in every room, so a season's result is a bet on a handful of players. Run every snapshotted season (`--strategy=all` compares all strategies) before drawing conclusions.

This harness is what caught the RB tilt. Under the old blend model every strategy lost to a plain ADP bot in 2024 (−42 to −127 realized lineup points per seat) and beat it in 2025 (+125 to +278) — the same bet on RB depth paying off or not. Under the lineup model every strategy is positive in both years (2024: +59 to +118; 2025: +156 to +270 — no-waiver scoring), and balanced, upside and safe-floor tie at the top of the two-year average.

Redraft scoring uses the honest yardstick: lineups are set **before kickoff** (by expected rate, benching known absences — "optimal weekly lineup" on realized points is hindsight and made a second DST look valuable), any empty starting slot is streamed from a **contested wire** (the 3rd-best undrafted player *by projection*, minus 2.5 points of friction per streamed week — a pickup costs a roster move and is usually a bit worse than projected), and best ball keeps the platform's realized-optimal lineup with no wire. Under it the shipped model is **+110 ± 16 (2024) and +213 ± 25 (2025)** over a same-seat ADP drafter in redraft, and the best-ball default (Robust RB) is +283 ± 40 / +399 ± 31, with 0 of 288 redraft rosters below 2 QB / 3 RB / 3 WR versus 24–27% for the bot. `pnpm backtest:gate` runs the full acceptance matrix (both formats, both years, hold-out calibration) and writes `docs/backtest-gates.md`.

### Survival tail lever

The survival model (P(player available at pick n), the input to VONA and the planner) is a normal CDF on FFC's per-player ADP mean and stdev. The season backtest cannot test it — its ADP bots draw from that same distribution, so it is self-consistent by construction — and FFC's own extremes (each player's earliest/latest pick over ~700 mocks) are consistent with a normal (late-tail ratio 0.98, early 0.89 of the normal-expected maximum). What that data cannot say is how *real rooms* differ from mocks. `config/survival.json` is the lever: `tailScale` multiplies every stdev, `wideShare` mixes in a `wideFactor`× wider component (fat tails). The same sampler drives the simulated market in the Monte Carlo, the completion model and the replay bots, so opponents reach and let players fall exactly as often as the survival math assumes. **It ships off** (`tailScale 1`, `wideShare 0` — bit-for-bit the old model). To fit it: `pnpm calibrate:survival <sleeper draft ids>` scores a grid by Brier/log loss with a reliability table and reports how the humans in those rooms picked (top-ADP share, reach distribution); `--write` stores the best setting. Turn it back off by restoring the two defaults.

**Calibrated outcome model.** `pnpm calibrate` fits `config/outcome-model.json` from the season snapshots: per position, the probability a drafted player's season effectively ends (≈18% for RB/WR!), per-game miss rate, projection reliability (how well projections order per-game production: QB .38, RB .69, WR .61, TE .52, K .07, DST .29), skill error, weekly variance and QB↔receiver correlation. The recap screen's season simulator samples from it, so its win probabilities carry realistic injury and season-ending risk.

**An experimental unified decision model** lives behind `Strategy.valueModel: "unified"` (see `docs/superpowers/specs/2026-09-04-unified-decision-model.md`): one objective — risk-adjusted expected points of your *completed* roster, with opponents modeled by need from their real rosters and no pacing rules at all. It ties the shipped model in 2024 and builds more robust rosters, but lost 2025 and both best-ball years in the backtest, so it is not the default. Try it in the harness with `pnpm backtest:season 2025 --model=unified`.

**Data (free):** ESPN's historical `kona_player_info` payload carries both the preseason projection and the realized weekly actuals for a season; FFC serves that year's final pre-season ADP via `?year=`. The first run for a season writes `data/raw/seasons/<year>.json` (~1 MB). **Commit it** — ESPN purges old projections (2023 retains 22 of 264), so every season not snapshotted is lost for good. Currently snapshotted: 2024, 2025.

## Data sources (all free, all switchable)

- ADP + stdev: [Fantasy Football Calculator](https://fantasyfootballcalculator.com) (attribution required)
- Projections (raw stat lines): ESPN's undocumented `kona_player_info` endpoint — wrapped in a fixture fallback since it can vanish without notice — **and** Sleeper's projections endpoint (raw stat lines including projected first downs, which is what makes PPFD scoring possible)
- Second/third ADP opinions: ESPN's ownership block and Sleeper's per-format ADP
- Player ID crosswalk + expert consensus ranks: [DynastyProcess](https://github.com/dynastyprocess/data) (GPL-3.0; ECR mirror updates weekly)
- Live draft + league truth, trending adds, injuries, depth charts: [Sleeper](https://docs.sleeper.com) (free, read-only, non-commercial)
- Schedules + last-season weekly stats (matchup strength): [nflverse](https://github.com/nflverse)
- Player news, Rotowire notes, last-season stat lines: ESPN's public athlete endpoint, fetched in-browser
- Injury statuses: Sleeper at build time, plus **ESPN's league-wide injuries table live in the browser** (at draft start and every 10 minutes) — structured Questionable/Doubtful/Out/IR/Suspension for every board player, applied through the same penalty path the engine already uses
- Headlines: ESPN, CBS Sports and RotoWire RSS polled in-browser; Yahoo Sports and ProFootballTalk baked in by the ETL
- Bluesky wire: 54 verified-active reporters, aggregators and fantasy news bots (beat coverage for 27 teams) plus two curated NFL reporter lists, backfilled by the public API and pushed live over Jetstream

**Source toggles** (Setup → Advanced → Data sources): pick ESPN, Sleeper, or a blend for projections; FFC, Sleeper, ESPN, or a blend for ADP. Blended projections are the default — two independent models beat either alone. FFC stays the uncertainty model regardless: it's the only free source publishing per-player ADP spread, which powers the survival math. Everything else keyed/paid (FantasyPros, FantasyData, Fantasy Nerds) is deliberately excluded — no keys, no signups, ever.

Raw responses are committed to `data/raw/` as the offline fallback. The refresh workflow (`.github/workflows/build-board.yml`) runs two lanes: a **fast lane every 30 minutes** (`pnpm build:board --lane=fast` — FFC ADP, ESPN and Sleeper projections, ESPN's injuries table, RSS headlines; commits only the boards, and only when they changed) and a **full lane once a day** (the Sleeper player dump, FantasyPros with a fresh free-tier quota, DynastyProcess, nflverse; commits fixtures too). Vercel redeploys automatically on push, and the app refetches the board with `cache: "no-cache"` whenever Setup opens or a draft starts, so a new draft always sees the newest build. No API keys, no accounts, no signups anywhere: every source is anonymous and free. The only setup is pushing this repo to GitHub (activates the schedule) and connecting Vercel's free hobby tier (activates auto-deploy). Update cadence by source: ADP daily, injuries/depth intraday, expert ranks weekly (Fridays, upstream limitation), schedule/matchup strength static until the season starts.

## Deploying

Vercel hobby tier, zero config: `vercel deploy`. The board is static files in `/public`; there is no server-side code on the hot path.
