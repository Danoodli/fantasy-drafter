# Unified model acceptance gates

Generated 2026-09-05, rooms=12, 12 seats each, waiver-aware redraft scoring.

- PASS — 2024 redraft delta: unified 99±13 vs lineup 110±16
- PASS — 2024 redraft legality: 0% of seats below 2 QB / 3 RB / 3 WR
- PASS — 2024 redraft fragility ≤ bot: 4.12 vs bot 6.50 empty slot-weeks
- PASS — 2024 redraft objective ρ ≥ shipped − 0.10: unified ρ = 0.33 vs lineup ρ = 0.35
- FAIL — 2024 best ball delta: unified 189±27 vs robust-rb 283±40
- FAIL — 2024 best ball 1st%: 28% vs 53%
- FAIL — 2024 best ball legality: 3% of seats below the minimum counts
- FAIL — 2025 redraft delta: unified 106±15 vs lineup 213±25
- PASS — 2025 redraft legality: 0% of seats below 2 QB / 3 RB / 3 WR
- PASS — 2025 redraft fragility ≤ bot: 4.13 vs bot 7.07 empty slot-weeks
- FAIL — 2025 redraft objective ρ ≥ shipped − 0.10: unified ρ = 0.39 vs lineup ρ = 0.60
- FAIL — 2025 best ball delta: unified 260±22 vs robust-rb 399±31
- FAIL — 2025 best ball 1st%: 41% vs 74%
- FAIL — 2025 best ball legality: 65% of seats below the minimum counts
- FAIL — hold-out 2025 (fit on 2024) within 1σ: 74 vs 106±15
- PASS — hold-out 2024 (fit on 2025) within 1σ: 93 vs 99±13

**RESULT: FAIL — do not flip the default.**

<!-- leg-b:start -->
# Leg B replay gates — holdout 2025, 4178 player-weeks, 18 weeks, 150 matchups/week, seed 1

## Gate L1 — start/sit replay (2700 matchups)
- naive highest-projection lineup: win rate 67.5%, 94.5 pts/wk
- delta P(win) lineup:             win rate 67.1%, 94.2 pts/wk
- lineups differed in 762 of 2700 (28.2%); on those, delta P(win) won 510.0 vs 521.0 (paired z = -1.25)
- FAIL — delta P(win) loses to naive on realized matchup win rate (difference not distinguishable from noise at 95%)

## Gate L2 — waiver replay (700 rosters, next 4 weeks, realized lineup points added; lineups set with hindsight on realized points, for both arms)
- value-over-my-lineup claim: +48.35 pts per roster
- generic ROS-rank claim:     +35.20 pts per roster
- same player chosen in 346 of 700
- PASS — lineup-aware claims add at least as much realized lineup value

## Gate L3 — playoff odds calibration
- NOT RUN — needs historical league standings and rosters, which do not exist yet. Every Sleeper sync stores a LeagueSnapshot (lib/client/teams.ts); after a season of them, bucket mid-season odds and check that teams given ~70% made it ~70% of the time.

<!-- leg-b:end -->
