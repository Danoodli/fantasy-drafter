// Draft Cockpit ETL: fetch → normalize → join on player IDs → score → tier.
// Emits public/data/board-{scoring}.json (+ board-custom.json when a Sleeper
// league is configured). Run nightly by GitHub Actions and manually via
// `pnpm build:board`. Fails loudly, falls back to committed fixtures.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/etl/csv";
import { mergeName, looseName } from "../lib/etl/names";
import {
  fetchFfcAdp,
  fetchEspnProjections,
  fetchPlayerIds,
  fetchEcr,
  type FfcPlayer,
  type SourceResult,
} from "../lib/etl/fetchers";
import {
  SCORING_PRESETS,
  scoreStatLine,
  scoringFromSleeper,
  statLineFromEspn,
} from "../lib/scoring";
import { baselines } from "../lib/engine/baselines";
import { assignTiers } from "../lib/engine/tiers";
import type {
  Board,
  BoardPlayer,
  LeagueConfig,
  Position,
  ScoringFormat,
  ScoringSettings,
  StatLine,
} from "../lib/types";

const SEASON = 2026;
const FORMATS: ScoringFormat[] = ["standard", "half-ppr", "ppr", "2qb"];
const OUT_DIR = join(process.cwd(), "public", "data");

const ESPN_POS: Record<number, Position> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const ESPN_TEAM: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
  9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
  17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
  25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
};

interface CrossRow {
  sleeper_id: string;
  espn_id: string;
  fantasypros_id: string;
  yahoo_id: string;
  merge_name: string;
  position: string;
  team: string;
}

interface EspnProj {
  espnId: string;
  name: string;
  merge: string;
  pos: Position | undefined;
  team: string;
  stats: StatLine;
  appliedTotal: number;
}

function defaultConfigFor(format: ScoringFormat): LeagueConfig {
  return {
    platform: "manual",
    leagueId: "",
    draftId: "",
    myDraftSlot: null,
    teams: 12,
    rounds: 15,
    scoring: format,
    rosterSlots:
      format === "2qb"
        ? { QB: 2, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }
        : { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
    flexEligible: ["RB", "WR", "TE"],
    strategy: "balanced",
  };
}

// ---------------------------------------------------------------------------

interface EspnStatEntry {
  statSourceId: number;
  statSplitTypeId: number;
  seasonId: number;
  stats: Record<string, number>;
  appliedTotal?: number;
}
interface EspnPlayerEntry {
  player?: {
    id: number;
    fullName: string;
    defaultPositionId: number;
    proTeamId: number;
    stats?: EspnStatEntry[];
  };
}

function parseEspn(raw: { players: unknown[] }): EspnProj[] {
  const out: EspnProj[] = [];
  for (const entry of raw.players as EspnPlayerEntry[]) {
    const p = entry?.player;
    if (!p) continue;
    const projEntry = (p.stats ?? []).find(
      (s) => s.statSourceId === 1 && s.statSplitTypeId === 0 && s.seasonId === SEASON
    );
    if (!projEntry) continue;
    out.push({
      espnId: String(p.id),
      name: p.fullName,
      merge: mergeName(p.fullName),
      pos: ESPN_POS[p.defaultPositionId],
      team: ESPN_TEAM[p.proTeamId] ?? "",
      stats: statLineFromEspn(projEntry.stats ?? {}),
      appliedTotal: projEntry.appliedTotal ?? 0,
    });
  }
  return out;
}

/** Impute missing projections by interpolating ADP-neighbors at the position. */
function imputeProjections(players: BoardPlayer[], warnings: string[]) {
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const group = players.filter((p) => p.pos === pos).sort((a, b) => a.adp - b.adp);
    for (let i = 0; i < group.length; i++) {
      const p = group[i];
      if (p.projPoints > 0) continue;
      const prev = group.slice(0, i).reverse().find((g) => g.projPoints > 0);
      const next = group.slice(i + 1).find((g) => g.projPoints > 0);
      if (prev && next) p.projPoints = (prev.projPoints + next.projPoints) / 2;
      else if (prev) p.projPoints = prev.projPoints * 0.95;
      else if (next) p.projPoints = next.projPoints * 1.05;
      p.projImputed = true;
      if (p.adp <= 250) warnings.push(`imputed projection for ${p.name} (${pos}, ADP ${p.adp})`);
    }
  }
}

function buildBoard(
  format: ScoringFormat,
  scoring: ScoringSettings,
  config: LeagueConfig,
  ffc: SourceResult<{ players: FfcPlayer[] }>,
  espn: EspnProj[],
  espnFromFixture: boolean,
  espnFetchedAt: string,
  cross: CrossRow[],
  ecrRows: Record<string, string>[],
  ecrMeta: { fetchedAt: string; fromFixture: boolean }
): Board {
  const warnings: string[] = [];

  // Indexes
  const crossByMerge = new Map<string, CrossRow[]>();
  const crossByLoose = new Map<string, CrossRow[]>();
  for (const r of cross) {
    const list = crossByMerge.get(r.merge_name) ?? [];
    list.push(r);
    crossByMerge.set(r.merge_name, list);
    const lk = looseName(r.merge_name);
    const ll = crossByLoose.get(lk) ?? [];
    ll.push(r);
    crossByLoose.set(lk, ll);
  }
  const espnById = new Map(espn.map((e) => [e.espnId, e]));
  const espnByMerge = new Map<string, EspnProj[]>();
  for (const e of espn) {
    const list = espnByMerge.get(e.merge) ?? [];
    list.push(e);
    espnByMerge.set(e.merge, list);
  }
  const espnDstByTeam = new Map(espn.filter((e) => e.pos === "DST").map((e) => [e.team, e]));

  const ecrByFp = new Map<string, Record<string, string>>();
  const ecrByMerge = new Map<string, Record<string, string>>();
  for (const r of ecrRows) {
    if (r.page_type !== "redraft-overall") continue;
    if (r.id && r.id !== "NA") ecrByFp.set(r.id, r);
    ecrByMerge.set(mergeName(r.player), r);
  }

  const players: BoardPlayer[] = [];
  for (const f of ffc.data.players) {
    const pos = (f.position === "PK" ? "K" : f.position === "DEF" ? "DST" : f.position) as Position;
    if (!["QB", "RB", "WR", "TE", "K", "DST"].includes(pos)) continue;

    let id = "";
    let ids: BoardPlayer["ids"] = { ffc: String(f.player_id) };
    let proj: EspnProj | undefined;

    if (pos === "DST") {
      id = f.team; // canonical DST id = team abbrev (matches Sleeper)
      proj = espnDstByTeam.get(f.team);
    } else {
      const merge = mergeName(f.name);
      const posMatch = (c: CrossRow) =>
        !c.position || c.position === pos || (pos === "K" && c.position === "PK");
      let candidates = (crossByMerge.get(merge) ?? []).filter(posMatch);
      if (candidates.length === 0) {
        // Nickname-tolerant fallback: Kenny/Kenneth Gainwell, Chig/Chigoziem Okonkwo.
        candidates = (crossByLoose.get(looseName(merge)) ?? []).filter(posMatch);
      }
      // Disambiguate same-name players by team when needed.
      const row =
        candidates.length > 1 ? candidates.find((c) => c.team === f.team) ?? candidates[0] : candidates[0];
      if (row) {
        id = row.sleeper_id !== "NA" && row.sleeper_id ? row.sleeper_id : `ffc-${f.player_id}`;
        ids = {
          ffc: String(f.player_id),
          espn: row.espn_id !== "NA" ? row.espn_id : undefined,
          fantasypros: row.fantasypros_id !== "NA" ? row.fantasypros_id : undefined,
          yahoo: row.yahoo_id !== "NA" ? row.yahoo_id : undefined,
        };
      } else {
        id = `ffc-${f.player_id}`;
        if (f.adp <= 250) warnings.push(`JOIN FAILURE: ${f.name} (${pos}, ADP ${f.adp}) not in crosswalk`);
      }
      proj = (ids.espn && espnById.get(ids.espn)) || (espnByMerge.get(merge) ?? []).find((e) => e.pos === pos);
      if (!proj && f.adp <= 250 && pos !== "K")
        warnings.push(`no ESPN projection: ${f.name} (${pos}, ADP ${f.adp})`);
    }

    // Score: raw stat lines for skill positions, ESPN applied total for K/DST.
    let projPoints = 0;
    let stats: StatLine | undefined;
    if (proj) {
      if (pos === "K" || pos === "DST") {
        projPoints = proj.appliedTotal;
      } else {
        stats = proj.stats;
        projPoints = scoreStatLine(stats, scoring, pos === "TE");
      }
    }

    const ecrRow = (ids.fantasypros && ecrByFp.get(ids.fantasypros)) || ecrByMerge.get(mergeName(f.name));

    players.push({
      id,
      name: f.name,
      pos,
      team: f.team,
      bye: f.bye ?? null,
      projPoints: Math.round(projPoints * 10) / 10,
      projImputed: false,
      stats,
      adp: f.adp,
      adpStdev: f.stdev,
      adpHigh: f.high,
      adpLow: f.low,
      ecr: ecrRow ? Number(ecrRow.ecr) : null,
      ecrStdev: ecrRow ? Number(ecrRow.sd) : null,
      vorp: 0,
      vols: 0,
      tier: 0,
      ids,
    });
  }

  imputeProjections(players, warnings);

  // VORP / VOLS
  const byPos = new Map<Position, number[]>();
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    byPos.set(
      pos,
      players.filter((p) => p.pos === pos).map((p) => p.projPoints).sort((a, b) => b - a)
    );
  }
  const base = baselines(byPos, config);
  for (const p of players) {
    const b = base.get(p.pos)!;
    p.vorp = Math.round((p.projPoints - b.vorp) * 10) / 10;
    p.vols = Math.round((p.projPoints - b.vols) * 10) / 10;
  }

  // Tiers within position
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"] as Position[]) {
    const group = players.filter((p) => p.pos === pos).sort((a, b) => b.projPoints - a.projPoints);
    const tiers = assignTiers(group.map((p) => p.projPoints));
    group.forEach((p, i) => (p.tier = tiers[i]));
  }

  players.sort((a, b) => a.adp - b.adp);

  return {
    meta: {
      format,
      builtAt: new Date().toISOString(),
      sources: [
        { name: "Fantasy Football Calculator ADP", fetchedAt: ffc.fetchedAt, fromFixture: ffc.fromFixture },
        { name: "ESPN projections", fetchedAt: espnFetchedAt, fromFixture: espnFromFixture },
        { name: "DynastyProcess ECR + IDs", fetchedAt: ecrMeta.fetchedAt, fromFixture: ecrMeta.fromFixture },
      ],
      scoring,
      warnings,
    },
    players,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const [idsRes, ecrRes, espnRes] = await Promise.all([
    fetchPlayerIds(),
    fetchEcr(),
    fetchEspnProjections(SEASON),
  ]);
  const cross = parseCsv(idsRes.data as string) as unknown as CrossRow[];
  const ecrRows = parseCsv(ecrRes.data as string);
  const espn = parseEspn(espnRes.data as { players: unknown[] });
  console.log(`crosswalk: ${cross.length} rows · ecr: ${ecrRows.length} rows · espn: ${espn.length} projections`);

  // Optional: real league scoring from Sleeper for board-custom.json
  let customScoring: ScoringSettings | null = null;
  let customConfig: LeagueConfig | null = null;
  try {
    const league: LeagueConfig = JSON.parse(readFileSync(join(process.cwd(), "config", "league.json"), "utf8"));
    if (league.platform === "sleeper" && league.leagueId) {
      const res = await fetch(`https://api.sleeper.app/v1/league/${league.leagueId}`);
      if (res.ok) {
        const data = await res.json();
        customScoring = scoringFromSleeper(data.scoring_settings ?? {}, SCORING_PRESETS[league.scoring]);
        const slots: Record<string, number> = {};
        for (const rp of data.roster_positions ?? []) slots[rp] = (slots[rp] ?? 0) + 1;
        customConfig = {
          ...league,
          teams: data.total_rosters ?? league.teams,
          rosterSlots: {
            QB: slots.QB ?? 0, RB: slots.RB ?? 0, WR: slots.WR ?? 0, TE: slots.TE ?? 0,
            FLEX: (slots.FLEX ?? 0) + (slots.SUPER_FLEX ?? 0), K: slots.K ?? 0, DST: slots.DEF ?? 0,
          },
        };
        console.log(`custom board: using real scoring from Sleeper league ${league.leagueId}`);
      }
    }
  } catch {
    // no league configured — presets only
  }

  let totalWarnings = 0;
  for (const format of FORMATS) {
    const ffc = await fetchFfcAdp(format, 12, SEASON);
    const board = buildBoard(
      format, SCORING_PRESETS[format], defaultConfigFor(format),
      ffc, espn, espnRes.fromFixture, espnRes.fetchedAt, cross, ecrRows,
      { fetchedAt: ecrRes.fetchedAt, fromFixture: ecrRes.fromFixture }
    );
    const path = join(OUT_DIR, `board-${format}.json`);
    writeFileSync(path, JSON.stringify(board));
    const kb = (JSON.stringify(board).length / 1024).toFixed(0);
    console.log(`✓ board-${format}.json — ${board.players.length} players, ${kb} KB, ${board.meta.warnings.length} warnings`);
    totalWarnings += board.meta.warnings.length;
    for (const w of board.meta.warnings) console.log(`   ⚠ ${w}`);

    if (customScoring && customConfig && customConfig.scoring === format) {
      const custom = buildBoard(
        format, customScoring, customConfig,
        ffc, espn, espnRes.fromFixture, espnRes.fetchedAt, cross, ecrRows,
        { fetchedAt: ecrRes.fetchedAt, fromFixture: ecrRes.fromFixture }
      );
      writeFileSync(join(OUT_DIR, "board-custom.json"), JSON.stringify(custom));
      console.log(`✓ board-custom.json — real league scoring applied`);
    }
  }

  const stale = [idsRes, ecrRes, espnRes].some((r) => r.fromFixture);
  if (stale) console.warn("\n⚠️  ONE OR MORE SOURCES USED FIXTURES — board may be stale. See warnings above.");
  console.log(`\nDone. ${totalWarnings} total warnings.`);
}

main().catch((err) => {
  console.error("BUILD FAILED:", err);
  process.exit(1);
});
