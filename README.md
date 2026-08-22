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
- **Manual mode** — for ESPN/Yahoo/anything else. Type a name ("ceedee" works), hit Enter, the pick is marked. Undo with ⌘Z.

Your slot, config, and every manual action are mirrored to localStorage — a browser refresh mid-draft recovers everything.

## Draft night runbook

1. The night before: `pnpm build:board` (or let the nightly GitHub Action do it). Check the build log for warnings.
2. Open the app, load your draft, pick your slot and strategy.
3. When you're on the clock, the answer is already on screen: one name, one reason, two alternates. The button confirms — it never computes.
4. Keyboard: `Enter` drafts the recommendation, `/` focuses manual entry, `⌘Z` undoes.
5. If the wifi dies: everything keeps working offline except live sync — mark picks manually.

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
- **Strategies are config, not code** (`config/strategies.json`): λ, VORP/VOLS blend, ADP discipline, position multipliers by round. The Custom strategy exposes the dials as sliders.

## Scripts

| command | what |
|---|---|
| `pnpm dev` | run the app |
| `pnpm build:board` | rebuild boards from live sources (falls back to committed fixtures in `data/raw/` with a loud staleness warning) |
| `pnpm test` | engine math test suite (vitest) |
| `pnpm backtest <draft_id> <slot> [strategy] [scoring]` | replay a real Sleeper draft with the engine in your slot; compare rosters |

## Validating and tuning

Join a free Sleeper mock draft and run the app against it — that's the integration test. Then `pnpm backtest <that draft id> <your slot> zero-rb` to see what a different strategy would have produced from the same room.

## Data sources (all free)

- ADP + stdev: [Fantasy Football Calculator](https://fantasyfootballcalculator.com) (attribution required)
- Projections (raw stat lines): ESPN's undocumented `kona_player_info` endpoint — wrapped in a fixture fallback since it can vanish without notice
- Player ID crosswalk + expert consensus ranks: [DynastyProcess](https://github.com/dynastyprocess/data) (GPL-3.0; ECR mirror updates weekly)
- Live draft + league truth: [Sleeper](https://docs.sleeper.com) (free, read-only, non-commercial)

Raw responses are committed to `data/raw/` as the offline fallback; the nightly workflow (`.github/workflows/build-board.yml`) refreshes them.

## Deploying

Vercel hobby tier, zero config: `vercel deploy`. The board is static files in `/public`; there is no server-side code on the hot path.
