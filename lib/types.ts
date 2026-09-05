// Core shared types for Draft Cockpit.
// The board is built at ETL time (scripts/build-board.ts) and consumed
// read-only by the client. The engine (lib/engine/*) is pure functions
// over these types with zero I/O.

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST";

export const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

export type ScoringFormat = "standard" | "half-ppr" | "ppr" | "2qb";

/** Sleeper-style scoring settings. Only the keys the projection math uses. */
export interface ScoringSettings {
  pass_yd: number; // points per passing yard (e.g. 0.04)
  pass_td: number;
  pass_int: number;
  pass_2pt: number;
  rush_yd: number;
  rush_td: number;
  rush_2pt: number;
  rec: number; // points per reception — the PPR dial
  rec_yd: number;
  rec_td: number;
  rec_2pt: number;
  fum_lost: number;
  bonus_rec_te?: number; // TE premium, if the league uses it
  /** Points per first down (PPFD leagues). Sleeper leagues carry these natively. */
  rush_fd?: number;
  rec_fd?: number;
  pass_fd?: number;
}

/** A raw projected stat line, normalized from ESPN's stat-id map. */
export interface StatLine {
  passYds?: number;
  passTD?: number;
  passInt?: number;
  pass2pt?: number;
  rushYds?: number;
  rushTD?: number;
  rush2pt?: number;
  receptions?: number;
  recYds?: number;
  recTD?: number;
  rec2pt?: number;
  fumblesLost?: number;
  /** Projected first downs (Sleeper provides these; ESPN doesn't) — enables PPFD scoring. */
  rushFd?: number;
  recFd?: number;
  passFd?: number;
}

export interface BoardPlayer {
  id: string; // canonical = sleeper_id (team abbrev for DST)
  name: string;
  pos: Position;
  team: string;
  bye: number | null;
  projPoints: number; // scored with the league's settings
  projImputed: boolean; // true when ESPN had no projection and we interpolated
  /**
   * Raw projected stat line (ESPN). Lets the client re-score the board with
   * the real league scoring at runtime without an ETL rebuild.
   * Absent for K/DST (their projPoints come from ESPN's applied total).
   */
  stats?: StatLine;
  /** Second projection source: Sleeper's raw stat line (includes first downs). */
  statsSleeper?: StatLine;
  /** Third projection source: FantasyPros consensus stat line (keyed builds only). */
  statsFp?: StatLine;
  /** Build-time news blurb (FantasyPros, keyed builds) — merged with live feeds client-side. */
  news?: { headline: string; published: string } | null;
  /** ADP movement vs ~3 days ago, in picks. POSITIVE = rising (drafted earlier). */
  adpTrend?: number | null;
  /** Every ADP opinion we have; `adp` above holds the ACTIVE one. */
  adpSources?: { ffc: number | null; espn: number | null; sleeper: number | null };
  /**
   * True for players appended from the Sleeper ADP tail rather than FFC.
   * FFC only aggregates 12-team/15-round mocks (180 picks), so without these
   * the board runs dry around round 19 of a 20-round best ball draft.
   */
  deepPool?: boolean;
  adp: number;
  adpStdev: number;
  adpHigh: number;
  adpLow: number;
  ecr: number | null;
  ecrStdev: number | null;
  vorp: number;
  vols: number;
  tier: number; // within position, 1 = best
  /** Sleeper injury status at build time: "Questionable" | "Doubtful" | "Out" | "IR" | "PUP" | "Sus" | null */
  injury: string | null;
  /** True when `injury` was escalated from live news rather than the build-time snapshot. */
  injuryLive?: boolean;
  /** Depth-chart order at the position (1 = starter), from Sleeper. */
  depthOrder: number | null;
  /** Schedule easiness percentile 0-1 (1 = softest), full season. Null for K/DST. */
  sosSeason: number | null;
  /** Schedule easiness percentile 0-1 over fantasy playoff weeks 15-17. */
  sosPlayoff: number | null;
  ids: { espn?: string; fantasypros?: string; yahoo?: string; ffc?: string };
}

export interface BoardMeta {
  format: ScoringFormat;
  builtAt: string; // ISO timestamp
  sources: {
    name: string;
    fetchedAt: string; // ISO timestamp of the data actually used
    fromFixture: boolean; // true = live fetch failed, used committed cache
  }[];
  scoring: ScoringSettings;
  warnings: string[];
}

export interface Board {
  meta: BoardMeta;
  players: BoardPlayer[];
}

// ---------------------------------------------------------------------------
// League + draft state

export interface RosterSlots {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  K: number;
  DST: number;
  [slot: string]: number;
}

/**
 * Redraft: classic season-long league — starters + bench, waivers exist.
 * Best ball: draft once and let it ride — optimal lineup auto-scores weekly,
 * no waivers, so depth and ceiling matter far more and roster construction
 * follows position-count targets instead of starter slots.
 */
export type LeagueType = "redraft" | "bestball";

export interface LeagueConfig {
  platform: "sleeper" | "manual";
  leagueId: string;
  draftId: string;
  myDraftSlot: number | null; // 1-indexed
  teams: number;
  rounds: number;
  scoring: ScoringFormat;
  leagueType: LeagueType;
  rosterSlots: RosterSlots;
  flexEligible: Position[];
  strategy: string; // strategy id from config/strategies.json
  /**
   * Manual-mode scoring tweaks layered over the base format's presets and
   * re-scored client-side from raw stat lines: TE premium, 6-pt passing TDs,
   * INT severity. Sleeper leagues don't need this — their exact settings win.
   */
  scoringTweaks?: {
    bonusRecTe?: number; // extra points per TE reception (TE premium)
    passTd?: number; // 4 or 6
    passInt?: number; // -1 or -2
    /** Points per rushing/receiving first down (PPFD). Uses Sleeper's projected first downs. */
    ppfd?: number;
  };
}

/** A pick that has happened. */
export interface DraftPick {
  playerId: string; // canonical board id; "" if unmatched
  playerName: string; // for display + unmatched fallback
  pos: Position | null;
  pickNo: number; // 1-indexed overall
  round: number;
  draftSlot: number; // 1-indexed column on the board
  isKeeper: boolean;
  byMe: boolean;
}

/** A traded pick, Sleeper shape: (season, round, original roster) now owned by owner_id. */
export interface TradedPick {
  round: number;
  originalSlot: number; // draft slot whose pick it was
  newSlot: number; // draft slot that now owns it
}

export interface DraftSource {
  getPicks(): Promise<DraftPick[]>;
  isLive(): boolean;
}

// ---------------------------------------------------------------------------
// Strategy

export interface Strategy {
  id: string;
  label: string;
  blurb: string;
  /** Risk aversion λ: score = E[value] − λ·stdev. Lower tolerates variance. */
  lambda: number;
  /** Risk term for best ball; negative = chase ceiling (tournaments pay for 1st, not for the mean). */
  lambdaBestBall?: number;
  /** 0 = pure VOLS, 1 = pure VORP. */
  baselineBlend: number;
  /** 0 = pure value, 1 = never reach past ADP. */
  adpDiscipline: number;
  /** Multipliers by round range, e.g. "1-5": { RB: 0.55, ... } */
  positionMultipliers: Record<string, Partial<Record<Position, number>>>;
  /** Max players the engine will ever recommend at a position. */
  positionCaps: Partial<Record<Position, number>>;
  /**
   * Stacking appetite, 0–1.5. Bonus for pairing a QB with his own
   * pass-catchers (and vice versa) — correlated ceilings win tournaments.
   */
  stacking?: number;
  /**
   * How a player's draft value is measured in redraft (best ball has its own
   * market-curve model either way).
   * - "lineup" (default): starters by what they add to MY lineup versus
   *   waiting for my next pick (VONA + VOLS); bench by insurance
   *   (VORP × P(he starts)). Adapts to the board as it empties — position
   *   runs and tier cliffs raise VONA where they happen.
   * - "blend": legacy. baselineBlend·VORP + (1−baselineBlend)·VOLS for every
   *   player, starter or bench. League-wide scarcity, so steep RB curves
   *   dominate; kept as an explicit opt-in for comparison.
   */
  valueModel?: "unified" | "lineup" | "blend";
  /**
   * League types this strategy is the evidence-backed default for. The season
   * backtest ranks strategies very differently by format — Robust RB is the
   * best best-ball build in both 2024 and 2025 (+321 avg vs the ADP bot) and
   * one of the weakest in redraft (+134), while Balanced/Safe Floor invert
   * that — so the app picks per format instead of asking you to.
   */
  recommendedFor?: LeagueType[];
  /**
   * Keep out of the strategy picker. Still available to the backtest via
   * `--strategy=all`, so a hidden preset can be re-measured each season
   * rather than lost.
   */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// Engine input/output

export interface EngineState {
  board: BoardPlayer[]; // full board, including drafted players
  draftedIds: Set<string>; // players off the board
  myRoster: BoardPlayer[]; // players I have drafted
  currentPick: number; // 1-indexed overall pick about to be made
  myPicks: number[]; // all my remaining pick numbers, ascending
  config: LeagueConfig;
  strategy: Strategy;
  /** Per-position ADP shift observed in this room (+ = going later than ADP). */
  drift: Partial<Record<Position, number>>;
  /** Opponent position counts by draft slot (1-indexed), for the sim's roster-need model. */
  opponentCounts?: Record<number, Partial<Record<Position, number>>>;
  /** What every other team holds, by draft slot — so opponents are modeled by need, not by ADP alone. */
  opponentRosters?: Record<number, { pos: Position; bye: number | null }[]>;
  /** Outcome-model parameters; defaults to config/outcome-model.json. Tests and the backtest inject alternatives. */
  outcome?: import("./engine/outcomeModel").OutcomeParams;
}

export interface Recommendation {
  player: BoardPlayer;
  reason: string; // one plain-language line
  score: number;
  vona: number;
  survivalToNextPick: number; // P(available at my next pick)
  simMean: number;
  simStdev: number;
  /** Unified model: expected season lineup points of the completed roster if I take him now. */
  expectedPoints?: number;
  pointsSd?: number;
  /** expectedPoints minus the runner-up's. */
  gainOverNext?: number;
  /** Slot-weeks of bye/injury cover he adds to the current roster (≈0 for a starter). */
  byeCoverWeeks?: number;
}

export interface EngineOutput {
  recommendations: Recommendation[]; // ranked, [0] is the pick
  /** Unified model: every scored candidate, ranked — the full comparison behind the top 3. */
  scored?: Recommendation[];
  strategyWarning: string | null; // "Your strategy is no longer optimal…"
  computeMs: number;
}
