# Projections vs. reality — 2018 to 2025, eight seasons

## The short version

We now have eight completed seasons, not two. For each one we rebuilt the board as it stood on draft day — FantasyFootballAnalytics (FFA) consensus projections and ADP — let the engine draft in every seat of 12 simulated rooms against bots that follow ADP, and scored every roster with what those players really did (nflverse box scores, PPR). Same harness, same yardstick as the 2024/2025 study; only the data source changed.

**How accurate are preseason projections?** Remarkably stable: they order players correctly about **79–80% of the time in every one of the eight seasons** (rank correlation 0.75–0.79). That number did not move in eight years and it is the noise floor of the sport. Inside the first three rounds it drops to **~62%** every year — telling elite players apart is barely better than a coin flip, and it always has been.

**The one systematic error, and it is not what it looks like.** Projections came in too high at every position in 8 of 8 seasons (QB 7 of 8): about **−14 points per player**, and about **−40 per player in rounds 1–7, every single year**. But per game played, projections are essentially unbiased — players who suited up for at least half the season scored **+2 to +4% more per game than projected**. The entire miss is games not played. A drafted player (ADP ≤ 120) plays about **80% of the schedule**, and availability falls the deeper you draft (89% in rounds 1–3, 68% in round 13+). Projections are "if healthy" numbers; reality charges roughly three missed games a season, more for RB and TE than QB.

**Does the engine beat the crowd?** In redraft, **yes in all eight seasons** — 7 of 8 beyond two standard errors, mean **+145 points** per season against the ADP drafter in the same seat, finishing 4th of 12 on average (29% first place; chance is 8%). In best ball (20-round, no waivers) it is positive in 6 of 8 (mean **+148**) but lost narrowly twice (2018 −38, 2023 −5).

**What the trends say we should change** (evidence that repeats across seasons, not single-year stories):

1. **Best ball: the engine drafts exactly 2 QB and 2 TE every seat, every year, while the room drafts ~3 of each — and loses ~180 points at QB and ~130 at TE per seat in 8 of 8 seasons.** It makes that back and more with 10.5 WRs (+351, 8 of 8), so the net is positive, but the QB/TE deficit is the most consistent loss in the whole study. The cause is a static `positionCaps: { QB: 2, TE: 2 }` on every strategy. Tested: raising the cap to 3 for the best ball preset improves the same-seat result in **8 of 8 seasons** (paired rooms, mean +6 points; the engine settles at 2.3–2.9 QB and 2.1–2.9 TE and gives up ~0.7 WR). The gain is small — the WR windfall shrinks as the QB/TE hole closes — but it is the only change tested that helped every single season, and it removes a static rule. **Applied** as `positionCapsBestBall` QB 3 / TE 3 on the best ball preset (see §11). A cap of 4 adds nothing (7 of 8, +5).
2. **The engine's missed-games constants are too low at QB/WR/TE and flat across the draft.** Measured over eight seasons, starters (ADP ≤ 84) miss QB 2.3 / RB 3.2 / WR 2.9 / TE 3.2 games; the engine assumes 1.5 / 3.0 / 2.4 / 2.2. Bench-tier players (ADP 85–180) miss 3.2–5.2. Correcting the constants was tested across all eight seasons and **changed nothing** (paired delta +0.3 points) — the bench-insurance term is too small a lever to move picks. **Applied** for honesty of the fragility readout, not for points (§11).
3. **Projections are spread too wide, running backs most.** The regression slope of realized on projected points is below 1 in 7 of 8 seasons at RB (mean 0.76; QB 0.86, TE 0.83, WR 0.91). The best prediction of a player's season is a shrunk projection, and RB needs the most shrinkage. The calibrated outcome model (`config/outcome-model.json`) was fitted on two seasons; **refitted on eight** (§11).
4. **Quarterbacks were predictable for five of the eight years.** The 2024/2025 study concluded "nobody can predict QBs". Over 2018–2022 the projection ordering of drafted QBs correlated 0.53–0.79 with reality and beat ADP in every one of those years; only 2023–2025 were bad (0.32–0.57). Treat QB as a normal position in the engine, not a special case. **Applied** through the refit: QB projection reliability rose from 0.38 to 0.54 (§11).
5. **Strategy presets are close to cosmetic in redraft.** Across eight seasons the eight visible presets land within +122 to +137 points of each other and draft nearly the same roster (4.2–4.9 RB / 4.0–4.3 WR). The lineup value model decides the picks; the multipliers barely bend them. `robust-rb` is the weakest redraft preset (+118, lost in 2018 and 2022) and `zero-rb` has the best worst season (+48). The hidden `late-qb` posts the top mean (+143) but leaves 18% of seats below a construction floor — an illegal roster is not a strategy. Nothing here argues for offering a strategy choice; it argues for one adaptive mode, which is what the app does.
6. **Redraft roster shape has one persistent lean:** 4.3 WR vs the room's 4.9, costing WR points in 6 of 8 seasons (−77 per seat), offset by RB (+141, positive 7 of 8) and a second TE (+113, positive 8 of 8). The second QB is a wash (+26, negative 4 of 8). Net positive; the trade-off is worth watching, not fixing.

**What not to change.** The 80% ordering ceiling and the coin-flip first three rounds are structural. Busts remain two to three times bigger than booms every year (a season has a ceiling of 17 games and a floor of zero). The engine's redraft edge is real and consistent; the 2019 season (+478) is an outlier in size, not in sign — FFA's consensus had Lamar Jackson as QB3 at ADP 112 and the market did not.

---

## The detail

Everything below comes from `pnpm backtest:history` (Part A recomputed from the committed snapshots in `data/raw/seasons/ffa/`, Part B from `pnpm backtest:season <year> --source=ffa --json=…`). PPR, 12-team, 15-round redraft with the waiver-aware yardstick; 20-round best ball with realized-optimal lineups. Eight seasons is eight samples: read across rows for what repeats.

## 0. What changed versus the 2024/2025 study, and why the numbers differ

- **Projection source.** ESPN has purged its 2023 and earlier preseason projections, so 2018–2023 use FantasyFootballAnalytics' aggregated preseason projections, hand-exported. To keep one source across all eight seasons, 2024 and 2025 use FFA too. For the same players (FFA ADP ≤ 120) the two sources order players almost identically (correlation 0.97–0.99). FFA ran +16 points per player hotter than ESPN in 2024 and −6 in 2025 — the bias in this document is a property of preseason projections in general, not of one publisher.
- **Realized stats** are nflverse's per-week box scores, scored with our PPR preset (the mapping reproduces nflverse's own PPR total on every 2024 row). K points from field-goal distance and PAT columns; D/ST from team defensive stats plus points allowed (Spearman 0.95 against ESPN's 2024 D/ST actuals).
- **ADP** is FFA's single blended ADP, used under every scoring format. FFC's format-specific ADP starts in 2023.
- **Pool depth.** FFA projects ~72 RB / 72 WR / 36 TE / 37 QB with ADP, plus 300–600 deeper players with projected stat lines but no ADP; those form the deep pool, so best ball rooms finish. Late-round bench options are a little thinner than on the live board.
- **Two data-quality notes that mattered.** FFA's `points` column is scored differently by year (standard in 2018/19/20/21/25, half-PPR in 2022/23/24), so every projection is rebuilt from FFA's raw projected stat components and scored under our presets. Three exports (2018, 2022, 2023) omit projected receptions; 2022 and 2023 recover them exactly from FFA's half-PPR points, 2018 estimates them from receiving yards at the position's yards-per-reception (≈3 PPR points of error per player). The folder labelled "FFA actuals" is preseason projections, not outcomes, and is used only as projection components.

## 1. Overall accuracy by season

Skill positions (QB/RB/WR/TE) with a genuine projection and a realized line.

| season | n | rank corr (ρ) | pairwise | MAE | bias | drafted (ADP ≤ 120) with 0 games | with < half a season |
|---|---|---|---|---|---|---|---|
| 2018 | 480 | 0.789 | 80% | 40.5 | −9.1 | 1% | 12% |
| 2019 | 480 | 0.769 | 79% | 37.3 | −11.7 | 3% | 14% |
| 2020 | 465 | 0.767 | 79% | 43.9 | −9.0 | 0% | 16% |
| 2021 | 480 | 0.746 | 78% | 46.6 | −19.2 | 2% | 13% |
| 2022 | 480 | 0.793 | 80% | 42.0 | −19.6 | 0% | 8% |
| 2023 | 480 | 0.780 | 79% | 43.1 | −15.5 | 1% | 9% |
| 2024 | 480 | 0.776 | 79% | 42.3 | −13.2 | 0% | 12% |
| 2025 | 480 | 0.783 | 79% | 42.7 | −15.7 | 1% | 13% |

**What it means.** The accuracy of preseason projections has not changed in eight years: ρ 0.75–0.79, 78–80% pairwise, a typical miss of ~42 points. What varies is only the bias — the size of that year's injury tax. 2021 and 2022 were the worst years for it; 2018 and 2020 the mildest. Roughly one drafted player in eight plays less than half a season, every year.

## 2. Bias by position — the tunable

Mean of (actual − projected) per player; negative = projected too high. Right half: rank correlation by position.

| season | QB | RB | WR | TE | ρ QB | ρ RB | ρ WR | ρ TE |
|---|---|---|---|---|---|---|---|---|
| 2018 | −4.6 | −10.2 | −7.8 | −11.9 | 0.82 | 0.73 | 0.80 | 0.73 |
| 2019 | −13.1 | −9.3 | −13.6 | −10.9 | 0.76 | 0.82 | 0.76 | 0.66 |
| 2020 | +3.7 | −14.5 | −10.6 | −8.1 | 0.85 | 0.68 | 0.75 | 0.74 |
| 2021 | −22.8 | −20.3 | −20.4 | −13.5 | 0.82 | 0.68 | 0.71 | 0.80 |
| 2022 | −28.2 | −19.2 | −20.5 | −13.2 | 0.83 | 0.82 | 0.77 | 0.72 |
| 2023 | −27.2 | −15.7 | −14.7 | −9.7 | 0.73 | 0.76 | 0.78 | 0.75 |
| 2024 | −7.1 | −10.0 | −20.1 | −9.0 | 0.81 | 0.78 | 0.77 | 0.71 |
| 2025 | −16.0 | −12.1 | −22.6 | −8.5 | 0.80 | 0.76 | 0.76 | 0.78 |
| **mean** | **−14.4** | **−13.9** | **−16.3** | **−10.6** | 0.80 | 0.75 | 0.76 | 0.74 |
| seasons < 0 | 7/8 | 8/8 | 8/8 | 8/8 | | | | |

**What it means.** Every position is over-projected in essentially every season. TE is the mildest and the most consistent (−8 to −14 every year). QB swings the most (+4 to −28) because QB totals are the largest and a lost QB season is a 300-point hole. There is no position that projections systematically *under*-rate — nothing here says "the engine should like X more".

## 3. Where in the draft the bias lives, and where the ordering is trustworthy

| season | bias rd 1–3 | rd 4–7 | rd 8–12 | rd 13+ | pairwise rd 1–3 | rd 4–7 | rd 8–12 | rd 13+ |
|---|---|---|---|---|---|---|---|---|
| 2018 | −21.3 | −35.9 | −15.9 | −3.3 | 60% | 74% | 64% | 73% |
| 2019 | −44.4 | −19.1 | −25.9 | −4.2 | 67% | 80% | 74% | 72% |
| 2020 | −63.4 | −25.4 | −18.4 | +2.0 | 56% | 67% | 75% | 72% |
| 2021 | −67.0 | −45.7 | −29.7 | −8.8 | 61% | 72% | 62% | 70% |
| 2022 | −32.8 | −48.0 | −34.4 | −10.9 | 72% | 69% | 60% | 71% |
| 2023 | −29.9 | −33.4 | −28.4 | −8.7 | 69% | 57% | 63% | 73% |
| 2024 | −31.0 | −40.2 | −26.6 | −5.1 | 62% | 58% | 69% | 70% |
| 2025 | −43.9 | −59.2 | −35.5 | −3.2 | 53% | 58% | 71% | 73% |
| **mean** | **−41.7** | **−38.4** | **−26.9** | **−5.3** | **62%** | **67%** | **67%** | **72%** |

**What it means.** The bias is a top-of-draft phenomenon in all eight seasons: −40 per player in rounds 1–7, −27 in 8–12, near zero in 13+. Ordering is the reverse: the first three rounds are 53–72% (mean 62%) and the tail is a steady 70–73%. Both facts held in 2024/2025 and they hold in every earlier year.

## 4. Is the bias missed games or wrong per-game numbers?

Drafted players (ADP ≤ 120). "proj/G" = projection divided by scheduled games (16 through 2020, 17 after); "act/G" = realized points per game actually played, for players with ≥ 8 games.

| | QB | RB | WR | TE |
|---|---|---|---|---|
| share of scheduled games played (8-season mean) | 84% | 79% | 82% | 79% |
| per-game actual vs per-game projection, players with ≥ 8 games | **+2%** | **+4%** | **+3%** | **+3%** |
| per-game sign by season | 5 of 8 ≥ 0 | 7 of 8 ≥ 0 | 6 of 8 ≥ 0 | 6 of 8 ≥ 0 |

Availability by draft range (share of scheduled games played, 8-season mean):

| | rd 1–3 | rd 4–7 | rd 8–12 | rd 13–15 |
|---|---|---|---|---|
| QB | 89% | 85% | 81% | 68% |
| RB | 83% | 79% | 73% | 68% |
| WR | 85% | 81% | 78% | 72% |
| TE | 85% | 79% | 76% | 71% |

Missed games per season, and the engine's assumption (`EXPECTED_MISSED_GAMES` in `lib/engine/coverage.ts`):

| | QB | RB | WR | TE |
|---|---|---|---|---|
| measured, starters (ADP ≤ 84) | 2.3 | 3.2 | 2.9 | 3.2 |
| measured, whole drafted pool (ADP ≤ 180) | 3.5 | 4.0 | 3.5 | 4.0 |
| engine assumes | 1.5 | 3.0 | 2.4 | 2.2 |
| starters who played < half the season | 9% | 11% | 9% | 5% |

**What it means.** This is the most useful table in the document. **Per game, projections are right** — slightly conservative, even. The whole negative bias is availability: players miss about a fifth of their games, more as the draft goes on, and projections assume they miss none. Two consequences for the engine:

- A position-aware availability haircut on season totals is *justified* (RB and TE lose ~21% of games, QB ~16%), but it is small and mostly uniform, so it barely changes who is picked over whom. Tested: setting the engine's missed-game constants to the measured starter values moved the eight-season result by +0.3 points (3 of 8 seasons up, 5 down — noise); setting them to the pool-wide values moved it by −2.5. The constants should be corrected for the honesty of the fragility readout, but they are not a lever for points.
- Availability *does* differ by draft slot (89% → 68%), and that is what makes a deep, balanced roster pay: late picks are exactly the ones most likely to be unavailable, so bench depth is worth less than its projections say, and a starter is worth more. The engine's lineup model already prices starters above bench; this is the reason it should keep doing so.

## 5. Projections vs. the crowd

Same players (ADP ≤ 180), two orderings, compared within position: FFA's projection and the market's ADP. Higher ρ = better predictor of the realized order.

| season | QB proj | QB adp | RB proj | RB adp | WR proj | WR adp | TE proj | TE adp |
|---|---|---|---|---|---|---|---|---|
| 2018 | 0.62 | 0.52 | 0.38 | 0.35 | 0.56 | 0.61 | 0.48 | 0.33 |
| 2019 | 0.63 | 0.45 | 0.83 | 0.73 | 0.51 | 0.40 | 0.44 | 0.32 |
| 2020 | 0.53 | 0.50 | 0.51 | 0.43 | 0.48 | 0.54 | 0.56 | 0.51 |
| 2021 | 0.79 | 0.72 | 0.60 | 0.62 | 0.43 | 0.48 | 0.40 | 0.49 |
| 2022 | 0.60 | 0.51 | 0.60 | 0.61 | 0.65 | 0.64 | 0.43 | 0.29 |
| 2023 | 0.34 | 0.38 | 0.47 | 0.44 | 0.70 | 0.68 | 0.42 | 0.47 |
| 2024 | 0.57 | 0.57 | 0.62 | 0.59 | 0.51 | 0.48 | 0.43 | 0.27 |
| 2025 | 0.32 | 0.36 | 0.63 | 0.59 | 0.48 | 0.45 | 0.52 | 0.42 |
| **projection beats ADP** | **6/8** | | **6/8** | | **5/8** | | **6/8** | |

**What it means.** Projections beat the crowd more often than not at every position, by a small margin — the justification for drafting off projections and deviating from ADP is real but modest, exactly as the two-year study said. The QB row is the correction to that study: 2018–2022 QBs were *the most predictable position* (ρ 0.53–0.79, ahead of ADP every year); 2023–2025 were poor for both projections and the market. "Nobody can predict QBs" was three bad years, not a law.

## 6. Tier hit rates

Of the players projected in a position's top tier (QB12 / RB24 / WR24 / TE12), the share that finished in that tier.

| season | QB | RB | WR | TE |
|---|---|---|---|---|
| 2018 | 75% | 58% | 67% | 58% |
| 2019 | 75% | 83% | 71% | 67% |
| 2020 | 75% | 63% | 54% | 42% |
| 2021 | 83% | 63% | 54% | 58% |
| 2022 | 50% | 71% | 71% | 58% |
| 2023 | 42% | 58% | 58% | 50% |
| 2024 | 50% | 71% | 50% | 58% |
| 2025 | 50% | 75% | 58% | 42% |
| **mean** | **63%** | **68%** | **60%** | **54%** |

**What it means.** About two-thirds of a projected top tier delivers. RB is the most reliable tier over eight seasons (68%), consistent with 2024/2025; TE the least (54%). QB's fall from 75–83% (2018–2021) to 42–50% (2022–2025) is the same story as §5.

## 7. Calibration by projection size

Mean (actual − projected) and, in parentheses, the share of players who beat their projection. Calibrated ≈ 0 (50%).

| season | 275+ | 225–275 | 175–225 | 125–175 | 75–125 |
|---|---|---|---|---|---|
| 2018 | −25 (48%) | −19 (45%) | −39 (33%) | −25 (29%) | −9 (37%) |
| 2019 | −47 (28%) | −23 (36%) | −20 (43%) | −23 (31%) | −12 (42%) |
| 2020 | −42 (48%) | −39 (36%) | −28 (32%) | −34 (27%) | −10 (40%) |
| 2021 | −67 (16%) | −50 (19%) | −58 (28%) | −18 (35%) | −18 (34%) |
| 2022 | −54 (34%) | −41 (29%) | −48 (23%) | −32 (26%) | −20 (30%) |
| 2023 | −66 (25%) | −39 (26%) | −20 (42%) | −33 (25%) | +2 (49%) |
| 2024 | −37 (39%) | −33 (31%) | −30 (35%) | −25 (29%) | −14 (39%) |
| 2025 | −53 (38%) | −52 (23%) | −42 (27%) | −22 (40%) | −22 (30%) |

**What it means.** No bucket is calibrated in any season: only about a third of players reach their projection, and the biggest projections miss by the most in raw points. Read with §4, this is the availability tax scaled by the size of the projection — not evidence that stars are over-rated relative to each other.

Regression slope of realized on projected points (a slope of 1 means the spread of projections is right; below 1 means projections are too spread out and the best forecast shrinks them toward the position mean):

| season | QB | RB | WR | TE |
|---|---|---|---|---|
| 2018 | 0.73 | 0.71 | 1.19 | 0.87 |
| 2019 | 0.76 | 1.00 | 0.70 | 0.86 |
| 2020 | 1.13 | 0.57 | 0.79 | 1.05 |
| 2021 | 1.50 | 0.62 | 0.84 | 0.69 |
| 2022 | 0.87 | 0.76 | 1.10 | 0.84 |
| 2023 | 0.60 | 0.65 | 1.24 | 0.65 |
| 2024 | 0.82 | 0.83 | 0.79 | 0.73 |
| 2025 | 0.47 | 0.92 | 0.68 | 0.92 |
| **mean** | 0.86 | **0.76** | 0.91 | 0.83 |

RB is below 1 in seven of eight seasons and never above; the other positions are noisy around 0.85–0.9. This is the eight-season version of the "shrinkage lesson" from the unified-model work (RB 0.86 / WR 0.76 on two seasons of per-game data): RB projections need the most shrinkage, and any calibration fitted on two seasons is fitting noise.

## 8. Decision quality — redraft

`balanced` (the shipped redraft default), 12 rooms × 12 seats, 15 rounds, PPR. Delta = engine roster's realized weekly-lineup points minus the ADP bot that sat in the same seat of the same room; ±se clustered by room. "frag" = expected empty starting slot-weeks (lower is better); "bot frag" the same for the ADP drafter.

| season | engine | bot | delta | ±se | beats bot | 1st | top 3 | avg rank | floor viol. | frag | bot frag | per-room range |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2018 | 1971 | 1949 | **+22** | 17 | 53% | 9% | 34% | 5.7 | 0% | 4.4 | 6.8 | −62 … +115 |
| 2019 | 2464 | 1986 | **+478** | 17 | 100% | 97% | 100% | 1.0 | 0% | 4.3 | 6.4 | +367 … +556 |
| 2020 | 2047 | 1961 | **+86** | 13 | 70% | 17% | 36% | 4.5 | 0% | 4.2 | 6.9 | −12 … +156 |
| 2021 | 2097 | 2009 | **+88** | 18 | 70% | 18% | 46% | 4.4 | 0% | 4.3 | 6.9 | +8 … +217 |
| 2022 | 2048 | 1974 | **+74** | 19 | 65% | 17% | 43% | 5.0 | 0% | 4.3 | 6.7 | −40 … +171 |
| 2023 | 2060 | 1980 | **+80** | 17 | 67% | 12% | 41% | 4.7 | 0% | 4.1 | 6.4 | −33 … +141 |
| 2024 | 2146 | 2001 | **+145** | 16 | 83% | 29% | 59% | 3.7 | 0% | 4.7 | 7.4 | +67 … +222 |
| 2025 | 2147 | 1959 | **+188** | 24 | 83% | 34% | 67% | 3.1 | 0% | 4.1 | 6.8 | +97 … +321 |
| **mean** | 2123 | 1977 | **+145** | | 74% | 29% | 53% | 4.0 | 0% | | | |

Positive in 8 of 8 seasons; 7 of 8 beyond 2·se (2018 is +22 ± 17). Chance levels: 1st 8%, top 3 25%, avg rank 6.5. The ESPN-source runs for 2024/2025 (+110 ± 16, +213 ± 25) reproduce the earlier study exactly, so the pipeline is consistent; the FFA-source numbers for the same years (+145, +188) differ only through the projection source.

Roster shape — players per seat, engine / bot, and (engine − bot) realized points from that position:

| season | QB | RB | WR | TE | K | DST |
|---|---|---|---|---|---|---|
| 2018 | 2.0 / 1.8 (−0) | 4.9 / 4.7 (+127) | 4.1 / 4.9 (−191) | 2.0 / 1.6 (+158) | +23 | −9 |
| 2019 | 2.0 / 1.9 (+221) | 4.3 / 4.7 (+174) | 4.7 / 4.7 (+237) | 2.0 / 1.7 (+208) | +38 | +73 |
| 2020 | 2.0 / 1.8 (+35) | 4.5 / 4.8 (+79) | 4.5 / 4.8 (−156) | 2.0 / 1.6 (+107) | +16 | +23 |
| 2021 | 2.0 / 1.8 (−2) | 4.2 / 4.5 (+67) | 4.8 / 5.0 (−145) | 2.0 / 1.6 (+38) | +28 | +17 |
| 2022 | 2.0 / 1.9 (+81) | 4.4 / 4.6 (−76) | 4.6 / 4.9 (+19) | 2.0 / 1.7 (+99) | +17 | −10 |
| 2023 | 2.0 / 1.9 (−1) | 5.0 / 4.5 (+212) | 4.0 / 4.9 (−103) | 2.0 / 1.7 (+80) | −2 | −12 |
| 2024 | 2.0 / 1.9 (−50) | 5.4 / 4.4 (+296) | 3.6 / 5.0 (−176) | 2.0 / 1.6 (+34) | +17 | −9 |
| 2025 | 2.0 / 1.9 (−75) | 4.8 / 4.4 (+246) | 4.2 / 5.0 (−99) | 2.0 / 1.7 (+181) | +23 | +21 |
| **mean** | 2.0 / 1.9 (**+26**) | 4.7 / 4.6 (**+141**) | 4.3 / 4.9 (**−77**) | 2.0 / 1.6 (**+113**) | +20 | +12 |

**What it means.**

- The edge is broad-based and repeatable: the engine wins in years the top of the board collapsed (2021, 2022) and in years it did not (2018, 2020). 2019's +478 is the size outlier: FFA's consensus had Lamar Jackson QB3 at ADP 112, Josh Allen QB12 at ADP 146 and the Patriots D/ST at 151; all three finished first at their position, and the engine took them in most seats. That is the projection edge of §5 at its most extreme, not a bug — but do not expect it.
- **Shape is rigid in two places: exactly 2.0 QB and 2.0 TE in every seat of every season.** Both are the `positionCaps` on the strategy. The second TE pays in all eight seasons (+113 per seat vs the bot's 1.6 TEs) — largely because the bot's lone TE busts and it has no cover. The second QB is a wash (+26 mean, negative in four seasons).
- **The one persistent cost is WR:** 4.3 per seat vs the room's 4.9, and the engine's WR group scores less than the bot's in six of eight seasons (−77 mean). The RB group more than pays for it (+141, positive in seven). This is the RB-over-WR reliability of §5–§6 expressed as picks; it is a real trade-off, and the net is clearly positive, so it is a thing to keep measuring rather than to fix by hand.
- Zero floor violations in 1,152 seats; the engine's rosters are more robust than the crowd's every year (≈4.3 vs ≈6.8 expected empty slot-weeks).

## 9. Decision quality — best ball

`robust-rb` (the shipped best ball default), 20 rounds, no K/DST, realized-optimal weekly lineups, no waivers.

| season | engine | bot | delta | ±se | beats bot | 1st | top 3 | avg rank | per-room range |
|---|---|---|---|---|---|---|---|---|---|
| 2018 | 2326 | 2364 | **−38** | 23 | 42% | 2% | 15% | 7.5 | −154 … +114 |
| 2019 | 2836 | 2369 | **+467** | 27 | 99% | 88% | 100% | 1.2 | +324 … +621 |
| 2020 | 2423 | 2336 | **+87** | 22 | 67% | 1% | 42% | 4.9 | −53 … +214 |
| 2021 | 2423 | 2397 | **+26** | 31 | 54% | 10% | 28% | 6.2 | −209 … +168 |
| 2022 | 2475 | 2373 | **+101** | 40 | 67% | 27% | 49% | 4.4 | −92 … +340 |
| 2023 | 2375 | 2379 | **−5** | 22 | 48% | 1% | 16% | 6.7 | −133 … +105 |
| 2024 | 2751 | 2437 | **+313** | 20 | 97% | 60% | 91% | 1.8 | +181 … +439 |
| 2025 | 2570 | 2339 | **+232** | 49 | 79% | 46% | 68% | 3.2 | −143 … +525 |
| **mean** | 2522 | 2374 | **+148** | | 69% | 29% | 51% | 4.5 | |

Positive in 6 of 8, beyond 2·se in 5 of 8, two narrow losses. (ESPN-source 2024/2025: +283, +399 — again consistent in sign, larger in size.)

Roster shape — engine / bot and realized points delta by position:

| season | QB | RB | WR | TE |
|---|---|---|---|---|
| 2018 | 2.0 / 2.9 (−176) | 5.8 / 6.4 (+76) | 10.2 / 7.7 (+102) | 2.0 / 3.0 (−121) |
| 2019 | 2.0 / 3.0 (−91) | 5.4 / 6.4 (+270) | 10.6 / 7.7 (+643) | 2.0 / 3.0 (−78) |
| 2020 | 2.0 / 2.8 (−219) | 5.4 / 6.3 (+95) | 10.6 / 7.9 (+342) | 2.0 / 3.0 (−163) |
| 2021 | 2.0 / 2.9 (−289) | 6.1 / 6.2 (+139) | 9.9 / 8.0 (+176) | 2.0 / 3.0 (−145) |
| 2022 | 2.0 / 3.0 (−184) | 5.1 / 6.1 (+112) | 10.9 / 8.0 (+430) | 2.0 / 2.9 (−147) |
| 2023 | 2.0 / 2.9 (−162) | 5.1 / 6.2 (+11) | 10.9 / 7.9 (+238) | 2.0 / 3.0 (−153) |
| 2024 | 2.0 / 3.0 (−155) | 5.1 / 6.2 (+254) | 10.9 / 7.9 (+432) | 2.0 / 3.0 (−109) |
| 2025 | 2.0 / 3.0 (−187) | 5.5 / 6.1 (+189) | 10.5 / 7.9 (+444) | 2.0 / 3.0 (−122) |
| **mean** | 2.0 / 2.9 (**−183**) | 5.5 / 6.2 (**+143**) | 10.5 / 7.9 (**+351**) | 2.0 / 3.0 (**−130**) |

**What it means.** This is the clearest systematic pattern in the study. In every season the engine carries two QBs and two TEs against a room carrying three of each, and in every season that costs it roughly 180 points at QB and 130 at TE per seat — best ball scores the best weekly line-up, so a third QB and third TE are worth their spike weeks and their bye/injury cover. The engine makes it back with 10–11 WRs (+351, positive 8 of 8), and the "Robust RB" preset in practice drafts *fewer* RBs than the room (5.5 vs 6.2) — the label no longer describes the roster. Net positive, but the two losing seasons (2018, 2023) are exactly the seasons the WR windfall was smallest, and the QB/TE deficit was there as usual.

**Experiment: lift the QB/TE cap.** Same eight seasons, same room seeds, best ball preset with `positionCaps` QB/TE raised from 2 to 3 (and, separately, to 4). Realized points delta vs the ADP bot, and roster shape:

| season | shipped (cap 2) | cap 3 | cap 4 | shape cap 2 (QB/TE/WR/RB) | shape cap 3 | QB pts vs bot (cap 2 → 3) | TE pts (2 → 3) | WR pts (2 → 3) |
|---|---|---|---|---|---|---|---|---|
| 2018 | −38 | −34 | −39 | 2.0 / 2.0 / 10.2 / 5.8 | 2.9 / 2.1 / 9.5 / 5.5 | −176 → −19 | −121 → −119 | +102 → +50 |
| 2019 | +467 | +470 | +470 | 2.0 / 2.0 / 10.6 / 5.4 | 2.4 / 2.1 / 10.1 / 5.3 | −91 → +14 | −78 → −65 | +643 → +582 |
| 2020 | +87 | +88 | +88 | 2.0 / 2.0 / 10.6 / 5.4 | 2.3 / 2.5 / 10.1 / 5.1 | −219 → −181 | −163 → −134 | +342 → +303 |
| 2021 | +26 | +36 | +37 | 2.0 / 2.0 / 9.9 / 6.1 | 2.7 / 2.7 / 9.1 / 5.5 | −289 → −152 | −145 → −89 | +176 → +105 |
| 2022 | +101 | +103 | +103 | 2.0 / 2.0 / 10.9 / 5.1 | 2.4 / 2.3 / 10.2 / 5.1 | −184 → −117 | −147 → −125 | +430 → +360 |
| 2023 | −5 | +8 | +7 | 2.0 / 2.0 / 10.9 / 5.1 | 2.0 / 2.6 / 10.2 / 5.1 | −162 → −158 | −153 → −89 | +238 → +180 |
| 2024 | +313 | +322 | +319 | 2.0 / 2.0 / 10.9 / 5.1 | 2.7 / 2.5 / 9.8 / 5.0 | −155 → −3 | −109 → −55 | +432 → +309 |
| 2025 | +232 | +241 | +242 | 2.0 / 2.0 / 10.5 / 5.5 | 2.4 / 2.8 / 9.5 / 5.3 | −187 → −106 | −122 → −34 | +444 → +334 |
| **paired change** | | **+6.2, 8 of 8 up** | **+5.4, 7 of 8 up** | | | | | |

**What it means.** Freed from the cap, the value model takes a third QB in most seats and a third TE in some — never more, even with a cap of 4 — and pays for them with about 0.7 fewer WRs. The QB deficit roughly halves and the TE deficit shrinks, the WR windfall shrinks with them, and the net is a small, consistent gain: +6 points per seat, up in every one of eight seasons under paired rooms, with zero floor violations. The effect is inside a single season's error bar (±20–49), so it will never show up in one year; it shows up as a sign that never flips. That is exactly the kind of evidence this study is for: the cap is a static rule that costs a little every year, and the model underneath it makes a reasonable call when it is removed. **Applied: `positionCapsBestBall` QB 3 / TE 3 on the best ball preset** (config, not code; see §11). The redraft caps are a separate question — the redraft roster is 15 rounds with a waiver wire, and §8 shows the second QB there is already a wash.

## 10. Every strategy, every season (redraft)

Every strategy in `config/strategies.json`, 4 rooms × 12 seats per season (fewer rooms than §8, so each cell is noisier — `balanced` reads +129 here vs +145 with 12 rooms in 2024). Delta vs the same-seat ADP bot; "min" = worst season; "<0" = seasons lost; "viol" = share of seats below a construction floor.

| strategy | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | mean | min | lost | viol | RB / WR per seat |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| late-qb (hidden) | +96 | +422 | +89 | +76 | +10 | +129 | +166 | +159 | +143 | +10 | 0/8 | **18%** | 4.9 / 4.3 |
| safe-floor | +12 | +480 | +93 | +87 | +35 | +105 | +133 | +150 | +137 | +12 | 0/8 | 0% | 4.8 / 4.2 |
| tournament-ceiling | +31 | +436 | +85 | +88 | +48 | +107 | +137 | +159 | +136 | +31 | 0/8 | 0% | 4.2 / 4.2 |
| hero-rb | +51 | +432 | +91 | +100 | +20 | +76 | +97 | +218 | +136 | +20 | 0/8 | 0% | 4.8 / 4.2 |
| bpa | +17 | +459 | +87 | +85 | +38 | +116 | +130 | +150 | +135 | +17 | 0/8 | 0% | 4.3 / 4.0 |
| **balanced** (shipped) | +14 | +462 | +94 | +73 | +36 | +108 | +129 | +150 | +133 | +14 | 0/8 | 0% | 4.8 / 4.2 |
| upside | +14 | +454 | +92 | +84 | +31 | +110 | +131 | +149 | +133 | +14 | 0/8 | 0% | 4.7 / 4.3 |
| zero-rb | +72 | +361 | +107 | +76 | +48 | +122 | +74 | +118 | +122 | **+48** | 0/8 | 0% | 4.7 / 4.3 |
| robust-rb | **−28** | +478 | +91 | +61 | **−1** | +1 | +168 | +175 | +118 | −28 | **2/8** | 0% | 4.8 / 4.2 |

**What it means.**

- **The presets are nearly interchangeable in redraft.** Eight of nine land between +118 and +143 on the eight-season mean, and the season-to-season pattern is the same for all of them (everyone's best year is 2019, everyone's weak years are 2018 and 2022). Roster shape is almost identical across presets — the lineup value model, not the multipliers, is making the picks. That is the intended design (strategies are a risk dial, not a different brain) and it is confirmed.
- **`robust-rb` is the wrong tool for redraft** — the only preset to lose seasons — and §9 shows its best ball roster is no longer "robust RB" either. Its labels and blurb should be revisited.
- **`zero-rb` is the most robust** (worst season +48, best of any preset) but has the lowest mean; **`late-qb`** buys its top mean by leaving 18% of rosters illegal, which is why it stays hidden.
- With one adaptive mode being the user's stated goal, the evidence supports it: there is no preset that reliably beats `balanced`, and the differences between them are inside a season's noise.

## 11. What was applied, and the retest (2026-09-07)

All five changes were made and every sweep in this document was re-run on the final code and config, paired against the saved baselines (same room seeds).

| change | where | eight-season retest |
|---|---|---|
| Best ball QB/TE cap 2 → 3 | `positionCapsBestBall` on the best ball preset (`config/strategies.json`, read by `recommend.ts` only when the league is best ball) | +6.2 per seat, **up in 8 of 8 seasons**, mean +148 → **+154**, 2023 flips from −5 to +8 → positive in **7 of 8**; 0 floor violations |
| Missed-game rates → measured | `EXPECTED_MISSED_GAMES` in `lib/engine/coverage.ts`: QB 2.3 / RB 3.2 / WR 2.9 / TE 3.2 | redraft +0.3 per seat (3 of 8 up, 5 down — noise), 8 of 8 still positive |
| Outcome model refit on eight seasons | `pnpm calibrate --source=ffa` → `config/outcome-model.json` (1,976 player-seasons) | QB reliability 0.38 → 0.54, WR season-ending 0.18 → 0.13, per-game miss 0.11–0.15 (was 0.13–0.19), K reliability 0.07 → 0.33; shipped picks unchanged (redraft identical), objective ρ up (2024 0.35 → 0.37, 2025 0.65 → 0.69) |
| QB treated as a normal position | via the refit (reliability), plus the correction notes in `projection-vs-reality-2024-2025.md` | — |
| Strategy labels | `robust-rb` relabelled "Best Ball" with a blurb that describes the roster it builds; `balanced` blurb cites the eight-season record; stale two-year numbers in code comments replaced | — |

Retest on the final tree (FFA snapshots, 12 rooms; ESPN 2024/2025 for continuity with the earlier study):

| | before | after |
|---|---|---|
| redraft `balanced`, FFA 2018–2025 mean | +145 (8 of 8 positive) | **+145** (8 of 8) |
| best ball, FFA 2018–2025 mean | +148 (6 of 8 positive) | **+154** (7 of 8) |
| ESPN 2024 redraft / best ball | +110 ± 16 / +283 ± 40 | **+117 ± 16 / +299 ± 43** |
| ESPN 2025 redraft / best ball | +213 ± 25 / +399 ± 31 | **+213 ± 25 / +435 ± 33** |
| floor violations, all sweeps | 0 | 0 |

Best ball roster shape after the change: 2.0–2.9 QB, 2.1–2.8 TE, 9.1–10.2 WR, 5.0–5.5 RB per seat (was exactly 2.0 / 2.0 / ~10.5 / ~5.4). The unified-model round-12 latency test remains marginally over its 50 ms budget (50.9 ms), as it was before this work; the shipped lineup model is well inside it.

## Caveats

- **One projection source per season.** FFA's consensus is the only preseason projection retrievable for 2018–2023. The live board blends ESPN, Sleeper and (keyed) FantasyPros; for 2024/2025 FFA and ESPN agree at ρ 0.97–0.99, so the conclusions should carry, but the exact magnitudes are FFA's.
- **Receptions in three exports are recovered, not exported** (see §0). This adds ~3 PPR points of noise per player in 2018 only.
- **Bots are naive.** They follow ADP with noise and fill starters first. A real room contains better drafters, so every delta here is an upper bound on the edge over a typical human league.
- **Pool depth.** Late-round options are slightly thinner than the live board's ~480 skill players, so best ball tails are a little easier for everyone.
- **Same core every room.** The engine drafts the same players in every room of a season, so within-season error bars understate the real uncertainty; that is why every claim above is stated as a count of seasons.
- **K/DST projections are noise** (rank correlation with reality −0.5 to +0.5 in every season) and are excluded from every table above except roster shape.

## Regenerating

```
pnpm build:ffa-snapshot all                 # FFA CSVs + nflverse weekly → data/raw/seasons/ffa/<year>.json
pnpm backtest:season 2021 --source=ffa      # one season, full report
pnpm backtest:history                        # Part A + redraft/best ball sweeps (runs missing seasons into /tmp/bt)
pnpm backtest:history --strategy=all --type=redraft --rooms=4
```
