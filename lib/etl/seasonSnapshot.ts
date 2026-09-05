// Season snapshot: everything the backtest needs about one completed season,
// fetched once and committed under data/raw/seasons/<year>.json.
//
// Commit these. ESPN quietly purges old preseason projections — as of Sept
// 2026 the 2023 payload retains 22 of 264 — so every season we don't snapshot
// is a season of backtest history lost for good.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FfcPlayer } from "./fetchers";
import { parseSeasonPlayers, type SeasonPlayer } from "./espn";
import type { ScoringFormat } from "../types";

const SEASONS_DIR = join(process.cwd(), "data", "raw", "seasons");
const FORMATS: ScoringFormat[] = ["standard", "half-ppr", "ppr", "2qb"];
/**
 * ESPN sorts a historical season by CURRENT draft rank, not that season's — so
 * a 2024 second-rounder who has since fallen off (Pacheco, Rashee Rice) sits
 * past index 900 in the 2024 payload. 1500 reaches everyone who was rostered.
 */
const ESPN_LIMIT = 1500;

export interface FfcSnapshot {
  meta: { teams: number; rounds: number; total_drafts: number; start_date: string; end_date: string };
  players: FfcPlayer[];
}

export interface SeasonSnapshot {
  year: number;
  fetchedAt: string;
  espn: SeasonPlayer[];
  ffc: Partial<Record<ScoringFormat, FfcSnapshot>>;
}

export function snapshotPath(year: number): string {
  return join(SEASONS_DIR, `${year}.json`);
}

async function fetchEspnSeason(year: number): Promise<SeasonPlayer[]> {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const res = await fetch(url, {
    headers: {
      "x-fantasy-filter": JSON.stringify({
        players: { limit: ESPN_LIMIT, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "PPR" } },
      }),
    },
  });
  if (!res.ok) throw new Error(`ESPN ${year}: HTTP ${res.status}`);
  const json = (await res.json()) as { players?: unknown[] };
  if (!Array.isArray(json.players) || json.players.length < 200)
    throw new Error(`ESPN ${year}: unexpected payload (n=${json.players?.length})`);
  const players = parseSeasonPlayers({ players: json.players }, year);
  const usable = players.filter((p) => p.proj && p.projApplied > 0 && p.actual).length;
  if (usable < 100)
    throw new Error(
      `ESPN ${year}: only ${usable} players still carry a preseason projection — ESPN has purged this season. ` +
        `It cannot be backtested from live data.`
    );
  return players;
}

async function fetchFfcSeason(format: ScoringFormat, year: number): Promise<FfcSnapshot> {
  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=12&year=${year}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FFC ${format} ${year}: HTTP ${res.status}`);
  const json = (await res.json()) as { status?: string; meta?: FfcSnapshot["meta"]; players?: FfcPlayer[] };
  if (json.status !== "Success" || !Array.isArray(json.players) || json.players.length < 100)
    throw new Error(`FFC ${format} ${year}: unexpected payload (status=${json.status}, n=${json.players?.length})`);
  return { meta: json.meta!, players: json.players };
}

export interface LoadOptions {
  /** Re-fetch even when a fixture exists. */
  refresh?: boolean;
  log?: (line: string) => void;
}

/** Load a season snapshot from its fixture, fetching and writing it on first use. */
export async function loadSeasonSnapshot(
  year: number,
  opts: LoadOptions = {}
): Promise<{ snapshot: SeasonSnapshot; fromFixture: boolean }> {
  const log = opts.log ?? (() => {});
  const path = snapshotPath(year);
  if (!opts.refresh && existsSync(path)) {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as SeasonSnapshot;
    log(`season ${year}: loaded fixture (${snapshot.espn.length} ESPN players, fetched ${snapshot.fetchedAt.slice(0, 10)})`);
    return { snapshot, fromFixture: true };
  }

  log(`season ${year}: fetching ESPN projections + actuals…`);
  const espn = await fetchEspnSeason(year);
  const ffc: SeasonSnapshot["ffc"] = {};
  for (const format of FORMATS) {
    try {
      ffc[format] = await fetchFfcSeason(format, year);
      log(`  ffc ${format}: ${ffc[format]!.players.length} players (${ffc[format]!.meta.total_drafts} drafts)`);
    } catch (err) {
      log(`  ⚠ ffc ${format}: ${(err as Error).message} — format skipped`);
    }
  }
  if (Object.keys(ffc).length === 0) throw new Error(`FFC returned no ADP for ${year}`);

  const snapshot: SeasonSnapshot = { year, fetchedAt: new Date().toISOString(), espn, ffc };
  mkdirSync(SEASONS_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot));
  const kb = Math.round(readFileSync(path).length / 1024);
  log(`  wrote ${path} (${kb} KB) — commit this file`);
  return { snapshot, fromFixture: false };
}
