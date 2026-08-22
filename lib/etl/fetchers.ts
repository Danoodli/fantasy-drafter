// Build-time fetchers. Each source is fetched live, cached to data/raw/
// (committed to the repo), and falls back to the committed fixture with a
// loud warning if the live fetch fails. Node-only — never import from the client.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RAW_DIR = join(process.cwd(), "data", "raw");
const META_PATH = join(RAW_DIR, "meta.json");

type FixtureMeta = Record<string, { fetchedAt: string }>;

function readMeta(): FixtureMeta {
  try {
    return JSON.parse(readFileSync(META_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeMeta(meta: FixtureMeta) {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

export interface SourceResult<T> {
  data: T;
  fetchedAt: string;
  fromFixture: boolean;
}

/**
 * Fetch `url`, cache the body to data/raw/<key>, and fall back to the cached
 * fixture on failure. Fails hard only if there is no fixture either.
 */
export async function fetchWithFixture<T>(
  key: string,
  url: string,
  parse: (body: string) => T,
  init?: RequestInit
): Promise<SourceResult<T>> {
  const fixturePath = join(RAW_DIR, key);
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const data = parse(body); // parse before caching so we never cache garbage
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(fixturePath, body);
    const meta = readMeta();
    const fetchedAt = new Date().toISOString();
    meta[key] = { fetchedAt };
    writeMeta(meta);
    return { data, fetchedAt, fromFixture: false };
  } catch (err) {
    if (!existsSync(fixturePath)) {
      throw new Error(`Source ${key} failed (${err}) and no fixture exists at ${fixturePath}`);
    }
    const fetchedAt = readMeta()[key]?.fetchedAt ?? "unknown";
    const ageDays =
      fetchedAt === "unknown"
        ? "?"
        : ((Date.now() - Date.parse(fetchedAt)) / 86_400_000).toFixed(1);
    console.warn(
      `\n⚠️  ${key}: live fetch FAILED (${err}).\n` +
        `   Using committed fixture from ${fetchedAt} (${ageDays} days old).\n`
    );
    return { data: parse(readFileSync(fixturePath, "utf8")), fetchedAt, fromFixture: true };
  }
}

// ---------------------------------------------------------------------------
// Source-specific fetchers

export interface FfcPlayer {
  player_id: number;
  name: string;
  position: string; // QB RB WR TE PK DEF
  team: string;
  adp: number;
  adp_formatted: string;
  high: number;
  low: number;
  stdev: number;
  bye: number;
  times_drafted: number;
}

export function fetchFfcAdp(format: string, teams: number, year: number) {
  return fetchWithFixture<{ players: FfcPlayer[] }>(
    `ffc-${format}.json`,
    `https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=${teams}&year=${year}`,
    (body) => {
      const json = JSON.parse(body);
      if (json.status !== "Success" || !Array.isArray(json.players) || json.players.length < 100)
        throw new Error(`unexpected FFC payload (status=${json.status}, n=${json.players?.length})`);
      return json;
    }
  );
}

export function fetchEspnProjections(season: number) {
  return fetchWithFixture<{ players: unknown[] }>(
    "espn-kona.json",
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`,
    (body) => {
      const json = JSON.parse(body);
      if (!Array.isArray(json.players) || json.players.length < 200)
        throw new Error(`unexpected ESPN payload (n=${json.players?.length})`);
      return json;
    },
    {
      headers: {
        "x-fantasy-filter": JSON.stringify({
          players: { limit: 500, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "PPR" } },
        }),
      },
    }
  );
}

export function fetchPlayerIds() {
  return fetchWithFixture(
    "db_playerids.csv",
    "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv",
    (body) => {
      if (!body.startsWith("mfl_id,")) throw new Error("unexpected playerids header");
      return body;
    }
  );
}

export function fetchEcr() {
  return fetchWithFixture(
    "db_fpecr_latest.csv",
    "https://github.com/dynastyprocess/data/raw/master/files/db_fpecr_latest.csv",
    (body) => {
      if (!body.startsWith("fp_page,")) throw new Error("unexpected ecr header");
      return body;
    }
  );
}
