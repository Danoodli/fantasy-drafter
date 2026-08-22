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
   * Raw projected stat line. Lets the client re-score the board with the
   * real Sleeper league scoring at runtime without an ETL rebuild.
   * Absent for K/DST (their projPoints come from ESPN's applied total).
   */
  stats?: StatLine;
  adp: number;
  adpStdev: number;
  adpHigh: number;
  adpLow: number;
  ecr: number | null;
  ecrStdev: number | null;
  vorp: number;
  vols: number;
  tier: number; // within position, 1 = best
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

export interface LeagueConfig {
  platform: "sleeper" | "manual";
  leagueId: string;
  draftId: string;
  myDraftSlot: number | null; // 1-indexed
  teams: number;
  rounds: number;
  scoring: ScoringFormat;
  rosterSlots: RosterSlots;
  flexEligible: Position[];
  strategy: string; // strategy id from config/strategies.json
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
  /** 0 = pure VOLS, 1 = pure VORP. */
  baselineBlend: number;
  /** 0 = pure value, 1 = never reach past ADP. */
  adpDiscipline: number;
  /** Multipliers by round range, e.g. "1-5": { RB: 0.55, ... } */
  positionMultipliers: Record<string, Partial<Record<Position, number>>>;
  /** Max players the engine will ever recommend at a position. */
  positionCaps: Partial<Record<Position, number>>;
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
}

export interface Recommendation {
  player: BoardPlayer;
  reason: string; // one plain-language line
  score: number;
  vona: number;
  survivalToNextPick: number; // P(available at my next pick)
  simMean: number;
  simStdev: number;
}

export interface EngineOutput {
  recommendations: Recommendation[]; // ranked, [0] is the pick
  strategyWarning: string | null; // "Your strategy is no longer optimal…"
  computeMs: number;
}
