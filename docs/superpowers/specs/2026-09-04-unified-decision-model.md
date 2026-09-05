# Unified draft decision model — design

**Status (2026-09-05): implemented behind `Strategy.valueModel = "unified"`; NOT the default.** The acceptance gates (`docs/backtest-gates.md`) failed: 2024 redraft is a statistical tie with the shipped lineup model (+99±13 vs +110±16) and passes every gate; 2025 redraft (+106±15 vs +213±25) and best ball in both years (+189 vs +283; +260 vs +399, with 61–67% of best-ball rosters below the minimum counts — 3.9 TE per roster) do not. A controlled experiment ruled out shrinkage, the risk term, opponent modeling, Monte Carlo noise and a calibrated dud-week mixture as the cause (plan review log). What shipped from this work: the calibrated outcome model (also powering the recap simulator), the honest backtest yardstick (ex-ante lineups, projection-based contested wire with friction, legality/fragility gates, hold-out calibration), and the engine path itself for continued work. Next: a projection-level-dependent per-game ratio (deep TEs/RBs are overstated by a ratio fit on starters), a third season, and the user-offered datasets. Implementation plan: `docs/superpowers/plans/2026-09-04-unified-decision-model.md`.

## The problem this replaces

The engine's value path is a stack of independent heuristics, each added to fix the last one's symptom: VORP/VOLS blend → VONA for starters → coverage math for bench → bench-weight decay → 2/3/3 floors → two-tier must-fill → FLEX_SHARE scaling. Plus static pacing rules in `hardFilter` (no QB in rounds 1–2, no QB2 before round 12, no TE2 before round 10, K/DST only in the last two rounds), an ADP-reach penalty, urgency multipliers, best-ball count targets, a best-ball market-curve blend, and a stacking bonus. They are denominated in different units, they fight (a bench-weight cut did nothing because the RB tilt lived in the baseline; a flex-weight fix did nothing because TE2 came from the bye math), and none of them knows what the others assume. The 7-RB/2-WR roster was not a tuning miss; it was the natural product of disconnected logic.

## The objective

At my pick, for every candidate `c`:

```
Score(c) = U( LineupPoints( FinalRoster(c) ) )
```

- **FinalRoster(c)** = my current roster + `c` + the players I will add at my remaining picks, simulated: opponents draft from the remaining pool by ADP with noise and roster need (live room drift applied), and my own future picks are filled greedily under the same value the objective uses.
- **LineupPoints(R)** = the season total of each week's optimal starting lineup for roster R under the league's slots, with the week's realized points drawn from a calibrated **outcome model** (below). Redraft: any starting slot the roster cannot fill in a week is filled from the waiver wire at that position's expected streamable rate. Best ball: no waivers, no lineup management — exactly how best ball scores.
- **U** = utility over the distribution of LineupPoints across simulations: `mean − λ·sd`. Redraft λ is a small risk aversion; large-field best-ball tournaments use negative λ (ceiling-seeking), because the payout is for finishing 1st, not for the mean.

Three refinements came out of building it, each forced by a measured failure (see the plan's review log):

- **Redraft lineups are set before kickoff.** Starters are chosen by expected weekly rate among players known to be active that week; realized points then accrue. Best ball keeps the realized-optimal lineup (the platform picks it). Without this, any two interchangeable high-variance players — a second DST — looked valuable purely through hindsight, in both the engine and the backtest.
- **The waiver wire is contested and costs something.** It is the 3rd-best undrafted player *by projection* at the position (a pickup is made on projections, not hindsight), it always exists (deepest-ADP fallback), and every streamed slot-week is charged `WAIVER_FRICTION` = 2.5 points — a roster move, waiver priority, a pickup a little worse than his projection. That single term is why a rostered QB2 for the bye beats a plan to stream one. Engine and harness apply it identically.
- **Projections are shrunk toward their ADP-neighborhood mean by (1 − reliability)**, with reliability fitted per position as Spearman(projection, per-game actual): QB .38, RB .69, WR .61, TE .52, K .07, DST .29. That is the regression to the mean the data demands — and it is what makes kickers and defenses last picks with no rule.

One unit (expected points my completed roster scores this season), one uncertainty model, one place where opponents live. Everything the old stack hard-coded becomes emergent:

| old heuristic | how the objective produces it |
|---|---|
| positional need / diminishing returns | a 6th RB adds ~0 lineup points; an open WR2 adds his full rate |
| bench insurance, bye cover | WR3 adds points in exactly the weeks WR1/WR2 are on bye or hurt — sampled |
| VONA / tier cliffs / position runs | if the room takes the RBs before my next pick, FinalRoster(WR-now) has a worse RB2 |
| ADP discipline / reach | a player who survives to my next pick can be taken then; taking him now costs the alternative — visible in the completed rosters |
| pacing rules (QB round, K/DST last) | K/DST margin over the wire ≈ 0 so they fall to the last picks; a QB in round 2 wins only when the completed roster says so |
| stacking bonus | same-team QB↔receiver weekly correlation (r≈0.33) is sampled, so stacked rosters have fatter ceilings and negative-λ utility rewards them |
| best-ball construction targets | with no waivers, depth IS the lineup; the sampled optimal lineups reward 5–6 RB / 7–9 WR / 2–3 QB / 2–3 TE on their own |
| RB vs WR "balance" | RB has 2× the projection error of WR (log-sd 0.5 vs 0.35) and the same ~18% season-wrecking rate; risk-aware utility prices that |
| K/DST | streamable → last, no rule |

**No static rules remain in the engine.** The only hard constraints are format legality: a player on IR/PUP/suspension is not draftable, positions the league does not roster are not draftable, and when remaining picks equal unfilled *starting* slots the engine fills them. Depth floors (2 QB / 3 RB / 3 WR) move out of the engine and into the backtest as an acceptance gate: if the emergent behavior ever violates them, that is a model bug to fix, not a rule to add.

## Live and league-aware

The recommendation is recomputed from scratch on every board change — there is no ranked queue that "falls to #3" when #1 and #2 go. Each recompute rebuilds the completion model from the live room: every opponent's actual roster (from the draft feed), the live ADP drift, and the remaining pool.

Opponents are modeled **with the same objective I use for myself**. An opponent fills open starting slots first — the position with the most holes first, the earliest player in market (effective-ADP) order who fills it — and once the starters are set drafts depth by expected lineup gain *for that opponent's roster*. A team holding 2 RB and 0 WR is predicted to take a WR; an empty roster wants RB/WR (three holes each, with FLEX) before a QB (one), which is why QBs go later than RB/WR in rounds 1–2 without any rule; a team with every starter filled takes the best player left. This replaces the fixed position caps, so "what will be left at my next pick" reflects how the league is panning out, pick by pick.

## The outcome model (calibrated, not guessed)

Fit from the committed 2024 and 2025 snapshots by `pnpm calibrate` into `config/outcome-model.json` (data the engine imports, re-fit each season). Measured 2026-09-04, drafted skill players (ADP ≤ 180) with a real projection:

| quantity | QB | RB | WR | TE | source |
|---|---|---|---|---|---|
| P(season-wrecking: ≤ 8 games) | .07–.23 | .18 | .18 | .15–.20 | games with a scored line |
| per-game miss prob, others | ~.10 | ~.14 | ~.15 | ~.15 | mean missed 2.7–4.3 of 16, net of the above |
| projection error log-sd (played ≥ 12) | .21–.25 | **.41–.65** | .30–.39 | .27–.30 | actual/projected |
| median actual/projected (healthy) | .98–1.13 | 1.00–1.17 | .86–1.00 | .92–.93 | bias by position |
| weekly CV (played ≥ 12) | .38–.41 | .51–.61 | .54–.57 | .57–.62 | replaces WEEKLY_SIGMA |
| QB↔same-team WR/TE weekly r | .32–.36 (pooled) | | | | stacking |
| market shrinkage w | 0–0.25 flat; use 0.2 | | | | pairwise accuracy |

A player-season is sampled as: draft-day projection × lognormal skill error (median ratio, log-sd) → per-game rate; with probability p_SE the season ends after U(0..8) games, else each non-bye game is missed with the per-game probability (plus a draft-day status adjustment: Questionable +.05, Doubtful +.15, Out +.30, and live news escalations flow through the same field); weekly points are lognormal around the rate with the position's weekly σ, sharing a team-week factor with weight √r for QB/WR/TE. Byes are exact.

Held-out check: fit on 2024 → evaluate 2025, and the reverse. The model must not be tuned per player or per season.

## Strategies collapse to one adaptive mode plus a risk dial

The presets that were "strategies" (Zero RB, Robust RB, Hero RB, Late-Round QB, BPA) are position tilts; under this objective a tilt can only lower expected points, so they go. What legitimately remains is preference over risk:

| picker | λ redraft | λ best ball | note |
|---|---|---|---|
| **Adaptive** (auto for both formats) | +0.25 | −0.30 | the model; recommended |
| Safe Floor | +0.60 | 0.00 | |
| Upside | 0.00 | −0.50 | |
| Tournament Ceiling | −0.20 | −0.60 | large fields |
| Custom | slider | slider | plus market-trust w |

`Strategy.id = "balanced"` is kept as the Adaptive id so saved configs, league.json and the backtest default keep working; only the label changes.

## Acceptance gates (defined before implementation)

Measured by `pnpm backtest:season` with the waiver-aware yardstick, 12 rooms × 12 seats, against the shipped `lineup` model:

1. **Redraft, both years:** Adaptive ≥ shipped (+48 ± 18 / +140 ± 18) − 1σ each, and better on the two-year mean. 0 of 288 seats below 2 QB / 3 RB / 3 WR — as an *emergent* property. Expected empty slot-weeks ≤ the ADP bot's.
2. **Best ball, both years:** Adaptive 1st-place rate and delta ≥ the shipped best-ball default (Robust RB) − 1σ. 0 seats below the best-ball minimum counts.
3. **Hold-out:** calibrate on 2024 → 2025 result within 1σ of calibrate-on-both; and the reverse.
4. **Objective calibration:** across seats (engine and bot rosters pooled), ρ(model's E[LineupPoints] for a finished roster, its realized lineup points) within 0.10 of the shipped model's ρ on the same data. *(Originally "≥ 0.5"; the first gate run showed the shipped model itself at 0.35 — realized totals are dominated by which players busted, which no draft-day model can order — so an absolute bar measured the statistic's noise ceiling, not the model. Amended before the definitive run.)*
5. **Performance:** full recompute on the 530-player board < 50 ms best-of-5 (target < 30).
6. **Tests:** suite green; every test that encoded a static rule is replaced by one that asserts the fluid behavior.
7. **Live:** one Sleeper mock by the user; roster has a bench at QB/RB/WR.

Ship = flip `valueModel` default to `unified`, delete the dead heuristics, update docs. Until then the model lives behind `valueModel: "unified"` and is compared A/B in the harness.

## Deferred: more data (user-funded, human in the loop)

The user is willing to spend up to ~$20 and to hand-export CSVs (especially historical datasets) if a *measured* hole in the model can be closed with data the free APIs don't expose — per-player injury history and age curves, multiple projection sources for past seasons, weekly snap/target shares, real draft-room pick logs. This phase starts only after the unified model ships and its gates pass; the backtest's residuals and the objective-calibration ρ are how a proposed dataset earns its place. The engine stays $0 at runtime regardless.

## Out of scope (named so they are not forgotten)

Per-player injury history (no data leg); news beyond status escalation; opponent modelling beyond ADP+drift (a WR-early human meta is real but has no calibration data); dynasty/keeper values; auction.
