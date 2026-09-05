# Projections vs. reality — 2024 and 2025

## The short version

We took the exact projections and ADP the engine would have had on draft day in 2024 and 2025, let it draft against a room of bots that simply follow ADP, and then scored every roster with what those players *actually* did that season.

**Do we beat the crowd?** Yes, in both years — after fixing a bug this test exposed. Against a drafter who just takes the next player by ADP, the engine's roster finished about **4th of 12 on average in 2024 and 2nd of 12 in 2025**, and out-scored the ADP drafter sitting in the same seat about 70% of the time in 2024 and 90% in 2025. Before the fix, it *lost* to the ADP drafter in 2024 (finished ~9th of 12), because it was drafting 7 running backs and 2 wide receivers — which you saw yourself in your Sleeper mock. That was a math artifact, not a football opinion, and it's gone.

**How good are the projections themselves?** When they say player A will outscore player B, they're right **about 80% of the time**. That number was identical in both years and is basically the noise floor of the sport — one time in five, the "worse" player scores more, and no engine changes that. Where they're weakest is exactly where it hurts most: **among the first seven rounds, telling the elite players apart is barely better than a coin flip (~60%).** Everyone up there is projected to score a lot; the differences between them are smaller than the randomness. The projections earn their 80% deeper in the draft, where a WR20 vs. a WR60 is a real, predictable gap.

**Are they biased toward a position?** A little, and in a defensible direction. Running backs were the most *reliable* position both years — a projected top-24 RB finished top-24 about 70–80% of the time, versus ~55% for wide receivers. Tight ends are the most accurately projected position overall. **Quarterbacks are the blind spot: neither the projections nor the crowd could predict which top QBs would finish where** (Jayden Daniels was the consensus QB1 in 2025 and finished nowhere; Lamar Jackson went in round 4 in 2024 and finished QB1). That's a strong argument for never paying up for a QB in a 1-QB league. The old engine's RB obsession was *not* the projections' fault — it liked RBs for a broken reason and to an extreme; the fixed engine still leans RB-ish, which the reliability numbers support.

**How do outliers factor in?** They dominate, and they're lopsided. **Busts are two to three times bigger than booms.** The worst miss each year was a star who lost his whole season (McCaffrey −288 in 2024, Nabers −244 in 2025); the best boom each year was about +120. A projection assumes 17 healthy games — it has a hard ceiling and a floor of zero — so the downside of any premium pick is always much bigger than its upside. This is also why projections run "hot" on average: they don't price in the games players will miss. That tax was small in 2024 (players scored ~4 points below projection on average) and brutal in 2025 (~10 points overall, and 55–60 points per player in rounds 1–7, when Nabers, Daniels, Burrow, Conner, Hill and Kamara all went down). Nobody drafting off projections *or* ADP could have dodged 2025. The lesson isn't to predict injuries — nobody can — it's that a deep, balanced roster survives them and a top-heavy one doesn't, which is what the engine now builds.

**Why it works**
- Projections genuinely beat the ADP crowd at RB, WR and TE in both years — a small but consistent edge, which is the whole reason to draft off projections rather than follow the room.
- The engine now values a player by what he adds to *your* lineup versus what you could get at his position later, so it adapts to runs and tier cliffs instead of stacking one position.
- Late-round projections are the most accurate and slightly conservative, so the engine's deep-pool picks are drawn from the most trustworthy part of the data.

**Where it falls short**
- It can't see injuries, and injuries are the biggest source of misses. Treat every projection as an "if healthy" number.
- It can't reliably separate the top ~80 players from each other. Don't reach several picks early for a specific elite name — the certainty isn't there.
- Quarterbacks are unpredictable for everyone. Kickers and defenses are pure noise.
- Two seasons of evidence. 2025's big win was partly luck — an RB-leaning engine in the one year the top of the WR and QB board collapsed. 2024's modest win is the more honest expectation.

---

## The detail

Everything below is the evidence behind the summary. What this document is: the draft-day projections and ADP the engine would have drafted from in 2024 and 2025, compared against what those players actually scored. Every number comes from `pnpm backtest:season <year>` on the committed snapshots in `data/raw/seasons/`, scored PPR, 12-team. Regenerate any table with that command; the report at the bottom explains how to read it.

Two seasons is two samples. Treat anything that shows up in **both** years as a property of projections; treat anything that shows up in one as that year's story.

## How to read the metrics

| metric | what it measures | how to read it |
|---|---|---|
| **rank correlation (ρ)** | how well the projected *order* of players matched the realized order (Spearman) | 1.0 = perfect ordering, 0 = no relationship. 0.8 is very good for anything involving humans and injuries. |
| **pairwise accuracy** | for every pair of players, how often the higher-projected one actually outscored the other | The metric a draft tool should care about: *"when we said A over B, how often were we right?"* 50% is a coin flip. |
| **MAE** | mean absolute error, in fantasy points, between projected and actual season total | Size of a typical miss, regardless of direction. |
| **bias** | mean of (actual − projected) | **Negative = projections were too high.** This is the tunable: a position that comes in −30 every year is a projection problem, not bad luck. |

Season totals are ESPN's realized stat lines scored with the same PPR settings as the projections, so the comparison is apples to apples. A player who missed the whole year scores what he scored — near zero — because that is what your roster got.

## 1. Overall accuracy by position

**2024** — 418 skill players with a real preseason projection

| position | n | rank corr (ρ) | pairwise accuracy | MAE (pts) | bias (pts) |
|---|---|---|---|---|---|
| **All skill** | 418 | 0.80 | 80% | 42.8 | −4.0 |
| QB | 62 | 0.76 | 77% | 53.7 | −4.3 |
| RB | 106 | 0.78 | 80% | 46.9 | −4.2 |
| WR | 161 | 0.78 | 79% | 43.9 | −7.0 |
| TE | 89 | 0.80 | 80% | 28.2 | +1.7 |

**2025** — 444 skill players

| position | n | rank corr (ρ) | pairwise accuracy | MAE (pts) | bias (pts) |
|---|---|---|---|---|---|
| **All skill** | 444 | 0.78 | 80% | 44.2 | −10.5 |
| QB | 66 | 0.73 | 76% | 58.1 | −11.0 |
| RB | 112 | 0.75 | 79% | 45.3 | −12.4 |
| WR | 170 | 0.76 | 78% | 46.2 | −15.5 |
| TE | 96 | 0.81 | 81% | 29.6 | +0.9 |

**What it means.** The *shape* of accuracy is stable: about 80% pairwise, ρ ≈ 0.78–0.80, a typical miss of ~43 points, in both years. What changed between years is the **bias**: 2024 was nearly calibrated (−4), 2025 ran systematically hot (−10.5, and much worse at the top — see §2). TE is the best-behaved position both years and the only one with zero or positive bias. QB has the largest raw misses (MAE 54–58) because QB point totals are the largest.

The stable 80% is the honest ceiling to keep in mind: **one time in five, the player we rank higher scores fewer points.** No amount of engine tuning changes that; it is the noise floor of the sport.

## 2. Accuracy by draft range

Where in the draft do projections earn their keep?

**2024**

| rounds (12-team) | n | pairwise accuracy | MAE | bias |
|---|---|---|---|---|
| 1–3 | 38 | 61% | 62.6 | −9.8 |
| 4–7 | 48 | 63% | 62.3 | −27.0 |
| 8–12 | 61 | 72% | 56.7 | −16.3 |
| 13+ | 271 | 73% | 33.4 | +3.6 |

**2025**

| rounds (12-team) | n | pairwise accuracy | MAE | bias |
|---|---|---|---|---|
| 1–3 | 36 | 60% | 87.6 | **−55.0** |
| 4–7 | 50 | 62% | 67.8 | **−59.5** |
| 8–12 | 63 | 70% | 58.7 | −33.8 |
| 13+ | 295 | 72% | 31.7 | +8.2 |

**What it means.**

- **Ordering within the top seven rounds is barely better than a coin flip (60–63%) in both years.** Everyone there is projected 220–340 points; the differences between them are smaller than the noise. The 80% headline number is earned deeper in the draft, where a WR20 vs. WR60 projection gap is large and real. Practical consequence: precision about *which* first-rounder is "the" pick is mostly illusory, and reaching several picks early for a specific elite player buys almost nothing. This is the argument for the engine's VONA logic — take the player only when the drop-off to your next pick is real.
- **Late-round projections are the most accurate and slightly conservative** (+3.6 / +8.2 bias, 72–73% pairwise). The tail is where projections add the most information relative to the crowd.
- **The 2025 top of the draft was a disaster:** rounds 1–7 came in **55–60 points per player** below projection. That is not noise; it is a run of season-ending or season-wrecking injuries to premium players (Nabers, Daniels, Burrow, Conner, Ekeler, Hill, Kamara — see §6). 2024's −10 to −27 in the same range is the more typical "injury tax."

The bias pattern is the single most actionable thing in this document: **projections are "if healthy" numbers.** They assume a full season. Realized points always carry the expected cost of missed games, and that cost is concentrated at the top of the draft where the projected totals are biggest. A position-aware games-missed haircut is the obvious tuning candidate, and the backtest is how to test it.

## 3. Projections vs. the crowd — who predicts better?

Same players (ADP ≤ 180), two competing orderings: ESPN's projection, and the market's ADP. Compared within position, because ADP mixes positions (a QB drafted in round 8 scores more raw points than a WR drafted in round 3, which says nothing about who was the better pick).

**2024**

| position | n | ρ(projection → actual) | ρ(ADP order → actual) | better predictor |
|---|---|---|---|---|
| QB | 27 | 0.28 | 0.27 | tie |
| RB | 60 | 0.62 | 0.56 | projection |
| WR | 73 | 0.53 | 0.48 | projection |
| TE | 20 | 0.58 | 0.51 | projection |

**2025**

| position | n | ρ(projection → actual) | ρ(ADP order → actual) | better predictor |
|---|---|---|---|---|
| QB | 31 | 0.08 | 0.16 | ADP (both ~useless) |
| RB | 65 | 0.67 | 0.59 | projection |
| WR | 87 | 0.55 | 0.51 | projection |
| TE | 27 | 0.49 | 0.40 | projection |

**What it means.**

- **Projections beat the crowd at RB, WR and TE in both years**, by a consistent 0.04–0.09 in rank correlation. That is the justification for an engine that drafts off projections and is willing to deviate from ADP, rather than one that just follows the room. The edge is real but modest — the crowd is not dumb.
- **Nobody can predict quarterbacks.** ρ of 0.08–0.28 for both projections and ADP means the *order* of the top ~30 QBs going into the season had almost no relationship to how they finished. (Jayden Daniels was QB1 by ADP and projection in 2025 and finished QB-nowhere; Lamar Jackson was a 4th-round pick in 2024 and finished QB1.) This is strong evidence against paying up for a QB in a 1-QB league: you are paying a premium for an ordering that does not hold. Waiting on QB is not a "strategy," it is the default the data supports.

## 4. Tier hit rates

Of the players projected to finish in a position's top tier, how many did?

**2024**

| position | projected top | finished in same tier | within 2× tier | outside 3× tier (bust) |
|---|---|---|---|---|
| QB | 12 | 7 (58%) | 10 (83%) | 0 (0%) |
| RB | 24 | 16 (67%) | 21 (88%) | 1 (4%) |
| WR | 24 | 13 (54%) | 21 (88%) | 2 (8%) |
| TE | 12 | 7 (58%) | 8 (67%) | 0 (0%) |

**2025**

| position | projected top | finished in same tier | within 2× tier | outside 3× tier (bust) |
|---|---|---|---|---|
| QB | 12 | 6 (50%) | 8 (67%) | 1 (8%) |
| RB | 24 | 19 (79%) | 23 (96%) | 1 (4%) |
| WR | 24 | 13 (54%) | 17 (71%) | 3 (13%) |
| TE | 12 | 5 (42%) | 8 (67%) | 0 (0%) |

**What it means.** Roughly **half to two-thirds of a projected top tier actually finishes in that tier**, and outright busts (falling outside three times the tier) are rare — 0–13%. RBs were the most reliable tier both years (67%, 79%), WRs the least (54% both years). That is worth holding next to the engine's historical RB lean: the projections' preference for RB depth was not baseless — a projected top-24 RB was more likely to deliver than a projected top-24 WR in both seasons. The problem was never *that* the engine liked RBs; it was that the old value model liked them for the wrong reason (a replacement-level artifact, see §7) and to an extreme degree.

## 5. Calibration — do big projections come true?

Players grouped by the size of their projection.

**2024**

| projected | n | mean projected | mean actual | bias | share that beat projection |
|---|---|---|---|---|---|
| 275+ | 17 | 300.1 | 282.6 | −17.5 | 47% |
| 225–275 | 38 | 244.4 | 225.3 | −19.1 | 39% |
| 175–225 | 55 | 199.0 | 191.9 | −7.2 | 47% |
| 125–175 | 59 | 151.3 | 121.2 | −30.1 | 25% |
| 75–125 | 51 | 95.5 | 95.2 | −0.3 | 49% |

**2025**

| projected | n | mean projected | mean actual | bias | share that beat projection |
|---|---|---|---|---|---|
| 275+ | 42 | 309.9 | 260.0 | −49.9 | 36% |
| 225–275 | 37 | 248.8 | 180.6 | **−68.2** | **16%** |
| 175–225 | 38 | 202.3 | 156.6 | −45.7 | 26% |
| 125–175 | 48 | 148.6 | 129.6 | −19.1 | 33% |
| 75–125 | 51 | 101.1 | 77.9 | −23.2 | 27% |

**What it means.** In a calibrated year (2024) roughly half of players beat their projection in most buckets — that is what "unbiased" looks like. In 2025 **only 16% of players projected 225–275 reached their number**, and the average miss in that bucket was 68 points. The second tier of the 2025 draft — the round 3–6 "safe" veterans — was a graveyard, and no one drafting off projections (or ADP) could have avoided it. This is why a single season, however dramatic, should not drive re-tuning: 2025's bias is roughly three times 2024's at every level.

## 6. The biggest misses

Projected vs. actual, ADP ≤ 120 (roughly the first ten rounds).

**2024 busts**

| player | pos | ADP | projected | actual | miss |
|---|---|---|---|---|---|
| Christian McCaffrey | RB | 1.4 | 335.4 | 47.8 | −287.6 |
| Isiah Pacheco | RB | 19.8 | 232.5 | 56.9 | −175.6 |
| Chris Olave | WR | 26.2 | 245.7 | 76.7 | −169.0 |
| Dak Prescott | QB | 69.8 | 288.8 | 124.5 | −164.3 |
| Brandon Aiyuk | WR | 48.1 | 222.4 | 62.4 | −160.0 |
| Zamir White | RB | 67.8 | 182.5 | 29.3 | −153.2 |
| Rashee Rice | WR | 64.2 | 209.2 | 64.9 | −144.3 |
| Christian Kirk | WR | 55.6 | 205.4 | 70.9 | −134.5 |
| Jonathon Brooks | RB | 85.4 | 139.9 | 7.5 | −132.4 |
| Hollywood Brown | WR | 82.2 | 140.3 | 18.1 | −122.2 |

**2024 booms**

| player | pos | ADP | projected | actual | miss |
|---|---|---|---|---|---|
| Jahmyr Gibbs | RB | 9.4 | 238.4 | 362.9 | +124.5 |
| Lamar Jackson | QB | 44.2 | 314.7 | 434.4 | +119.7 |
| Ja'Marr Chase | WR | 7.2 | 289.4 | 403.0 | +113.6 |
| Brian Thomas Jr. | WR | 114.2 | 171.6 | 284.0 | +112.4 |
| Derrick Henry | RB | 15.9 | 225.0 | 336.4 | +111.4 |
| Chuba Hubbard | RB | 108.8 | 136.2 | 241.6 | +105.4 |
| Saquon Barkley | RB | 11.3 | 252.4 | 355.3 | +102.9 |
| Jayden Daniels | QB | 99.2 | 269.2 | 364.8 | +95.6 |
| Joe Burrow | QB | 59.7 | 289.9 | 381.8 | +91.9 |
| Jared Goff | QB | 94.3 | 244.8 | 336.5 | +91.7 |

**2025 busts**

| player | pos | ADP | projected | actual | miss |
|---|---|---|---|---|---|
| Jayden Daniels | QB | 31.4 | 383.0 | 117.3 | −265.7 |
| Malik Nabers | WR | 7.5 | 301.3 | 57.1 | −244.2 |
| Kyler Murray | QB | 86.0 | 318.8 | 80.8 | −238.0 |
| James Conner | RB | 42.3 | 250.1 | 33.3 | −216.8 |
| Tyreek Hill | WR | 26.4 | 263.6 | 53.5 | −210.1 |
| Joe Burrow | QB | 30.3 | 342.0 | 139.5 | −202.5 |
| Austin Ekeler | RB | 84.3 | 206.7 | 13.1 | −193.6 |
| Calvin Ridley | WR | 57.1 | 229.2 | 47.3 | −181.9 |
| Justin Fields | QB | 110.4 | 311.2 | 143.7 | −167.5 |
| Alvin Kamara | RB | 29.7 | 266.7 | 100.7 | −166.0 |

**2025 booms**

| player | pos | ADP | projected | actual | miss |
|---|---|---|---|---|---|
| Jaxon Smith-Njigba | WR | 33.0 | 240.9 | 359.9 | +119.0 |
| Christian McCaffrey | RB | 8.0 | 318.3 | 416.6 | +98.3 |
| Puka Nacua | WR | 9.7 | 298.6 | 375.0 | +76.4 |
| Jonathan Taylor | RB | 18.5 | 288.7 | 362.3 | +73.6 |
| George Pickens | WR | 59.6 | 221.3 | 291.9 | +70.6 |
| Travis Etienne Jr. | RB | 101.2 | 188.1 | 253.9 | +65.8 |
| Drake Maye | QB | 110.4 | 297.6 | 360.0 | +62.4 |
| Chris Olave | WR | 72.0 | 209.8 | 269.0 | +59.2 |
| Trey McBride | TE | 32.6 | 259.2 | 315.9 | +56.7 |
| Jahmyr Gibbs | RB | 5.1 | 317.2 | 366.9 | +49.7 |

**What it means.** Look at the *shape* of the two lists, not the names. **Busts are far bigger than booms.** The worst miss each year is −266 to −288; the best boom is +119 to +125. A season-long projection has a hard ceiling (17 games of production) and a floor of zero, so the downside of a premium pick is always two to three times its upside. That asymmetry is exactly why the engine's risk term (λ · stdev) exists and why a "safe floor" strategy tests as well as it does — and it is why a deep, balanced roster beats a top-heavy one over many seasons even when the top-heavy one wins the year the stars stay healthy. Note also how many 2024 booms (Daniels, Burrow, McCaffrey) reappear as 2025 busts or vice versa: last year's outcome is not this year's projection.

## 7. The first round, pick by pick

**2024**

| ADP | player | pos | projected | actual | projected rank | actual rank |
|---|---|---|---|---|---|---|
| 1.4 | Christian McCaffrey | RB | 335.4 | 47.8 | RB1 | RB68 |
| 2.2 | Breece Hall | RB | 289.4 | 240.9 | RB3 | RB16 |
| 2.6 | Tyreek Hill | WR | 298.8 | 218.2 | WR2 | WR18 |
| 3.7 | CeeDee Lamb | WR | 316.7 | 263.4 | WR1 | WR8 |
| 4.9 | Bijan Robinson | RB | 292.7 | 341.7 | RB2 | RB3 |
| 6.2 | Amon-Ra St. Brown | WR | 283.9 | 316.2 | WR4 | WR3 |
| 7.2 | Ja'Marr Chase | WR | 289.4 | 403.0 | WR3 | WR1 |
| 8.0 | Justin Jefferson | WR | 282.2 | 317.5 | WR5 | WR2 |
| 9.4 | Jahmyr Gibbs | RB | 238.4 | 362.9 | RB6 | RB1 |
| 9.8 | Jonathan Taylor | RB | 256.8 | 244.7 | RB4 | RB12 |
| 10.9 | A.J. Brown | WR | 259.7 | 216.9 | WR6 | WR20 |
| 11.3 | Saquon Barkley | RB | 252.4 | 355.3 | RB5 | RB2 |
| 12.1 | Garrett Wilson | WR | 251.6 | 251.9 | WR8 | WR10 |

**2025**

| ADP | player | pos | projected | actual | projected rank | actual rank |
|---|---|---|---|---|---|---|
| 1.5 | Ja'Marr Chase | WR | 340.0 | 313.6 | WR1 | WR4 |
| 2.1 | Bijan Robinson | RB | 339.3 | 370.8 | RB1 | RB2 |
| 2.5 | Saquon Barkley | RB | 325.9 | 232.3 | RB2 | RB14 |
| 4.4 | Justin Jefferson | WR | 315.8 | 201.5 | WR3 | WR21 |
| 4.9 | CeeDee Lamb | WR | 317.5 | 200.9 | WR2 | WR22 |
| 5.1 | Jahmyr Gibbs | RB | 317.2 | 366.9 | RB4 | RB3 |
| 7.5 | Malik Nabers | WR | 301.3 | 57.1 | WR4 | WR100 |
| 8.0 | Christian McCaffrey | RB | 318.3 | 416.6 | RB3 | RB1 |
| 9.7 | Puka Nacua | WR | 298.6 | 375.0 | WR5 | WR1 |
| 10.0 | Nico Collins | WR | 289.1 | 226.2 | WR7 | WR8 |
| 10.7 | Amon-Ra St. Brown | WR | 290.5 | 324.0 | WR6 | WR3 |
| 11.1 | Derrick Henry | RB | 281.7 | 279.5 | RB11 | RB8 |
| 11.3 | Ashton Jeanty | RB | 301.9 | 245.1 | RB6 | RB11 |

**What it means.** In each year, about half of the first round finished at or above its projected rank and half disappointed; one pick per year was a near-total loss (McCaffrey 2024, Nabers 2025). Every first-round RB who stayed healthy hit (Bijan, Gibbs, Barkley, Henry, McCaffrey), which is the RB tier-reliability from §4 showing up at the top. The three highest-projected WRs of 2025 (Chase, Lamb, Jefferson) finished WR4, WR22 and WR21 — and the consensus WR1 of 2024 (Lamb) finished WR8. Elite WR projections were the least reliable elite projections in both years.

## 8. What this did to the engine

The decision half of the backtest puts the engine in every seat of 12 simulated rooms against ADP-following bots and compares its roster's realized weekly-lineup points with the bot that would have sat in the same seat. Positive = the engine out-drafted the crowd.

| `balanced`, redraft PPR, 12×15 | 2024 | 2025 |
|---|---|---|
| **old value model** (league-wide VORP/VOLS) | **−111** ± 27 · avg finish 8.6 of 12 · 1% first | +305 ± 31 · avg finish 2.2 · 52% first |
| **new value model** (lineup-marginal) | **+90 to +113** ± 25 · avg finish 4.0–4.7 · 15–21% first | **+255 to +312** ± 25 · avg finish 2.0–2.5 · 46–62% first |

The old model lost to a plain ADP bot in 2024 because it drafted **6.8 RBs and 2.2 WRs** into a 2-RB/2-WR/FLEX lineup (your own Sleeper mock came out 7/2). Root cause: it valued every player against league-wide replacement level, and RB58 projects ~80 points while WR58 projects ~161, so two players with identical projections headed for the same FLEX slot differed by ~84 value points purely by position. That is a baseline artifact, not a football insight. The new model values a *starter* by what he adds to your lineup over the best you can expect at that position at your next pick, and a *bench* player as insurance. Every one of the nine strategies flipped from negative to positive in 2024 under it, and 2025 held.

The 2025 result (+300, ~50% first-place finishes) should be read with §2 and §5 in hand: the engine's RB-forward picks landed in the one year when the top of the WR/QB board collapsed. The 2024 result — modestly positive, avg finish ~4th of 12 — is the more representative one. Both years positive is the bar; neither year's magnitude is a forecast.

## Caveats

- **Two seasons.** Everything here is n=2 at the season level. The per-position and per-range patterns that repeat in both years are the trustworthy ones.
- **One projection source.** These are ESPN's preseason projections. The live board also blends Sleeper and (when keyed) FantasyPros; those were not available historically.
- **Skill positions only.** K and DST projections are close to noise in both years (rank correlation −0.5 to +0.5) and are excluded from the skill tables. Draft them last; do not think about it.
- **Injuries are inside the numbers.** A player who tore an ACL in Week 2 "missed" by his whole projection. That is deliberate — it is what your roster experienced — but it means bias measures the injury tax as much as projection skill.
- **PPR, 12-team, 15 rounds.** Different scoring changes the WR/RB balance; run `--format=half-ppr` or `--bestball` to see your format.
- **ESPN purges history.** 2023 retains 22 of 264 projections and cannot be added. Snapshot each season before the following summer or lose it.

## Regenerating

```
pnpm backtest:season 2024              # projection quality + decision quality, balanced
pnpm backtest:season 2025 --strategy=all --rooms=6
pnpm backtest:season 2025 --bestball   # 20-round, no K/DST roster shape
```

Snapshots live in `data/raw/seasons/<year>.json`; the first run for a new season fetches and writes one. Commit it.
