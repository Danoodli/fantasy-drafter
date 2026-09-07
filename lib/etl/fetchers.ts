// Build-time fetchers. Each source is fetched live, cached to data/raw/
// (committed to the repo), and falls back to the committed fixture with a
// loud warning if the live fetch fails. Node-only — never import from the client.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseRss } from "./rss";
import type { NewsItem } from "./newsMatch";
import type { EspnInjuriesJson } from "../client/espnInjuries";

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
export interface FetchOpts {
  /** Fast CI lane: read the committed fixture, no network, no staleness warning. */
  fixtureOnly?: boolean;
}

export async function fetchWithFixture<T>(
  key: string,
  url: string,
  parse: (body: string) => T,
  init?: RequestInit,
  opts: FetchOpts = {}
): Promise<SourceResult<T>> {
  const fixturePath = join(RAW_DIR, key);
  if (opts.fixtureOnly) {
    if (!existsSync(fixturePath)) throw new Error(`fixture ${key} missing — run the full lane first`);
    return { data: parse(readFileSync(fixturePath, "utf8")), fetchedAt: readMeta()[key]?.fetchedAt ?? "unknown", fromFixture: true };
  }
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

export function fetchPlayerIds(opts: FetchOpts = {}) {
  return fetchWithFixture(
    "db_playerids.csv",
    "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv",
    (body) => {
      if (!body.startsWith("mfl_id,")) throw new Error("unexpected playerids header");
      return body;
    },
    undefined,
    opts
  );
}

export interface SlimPlayerInfo {
  injury: string | null;
  depthOrder: number | null;
  team: string | null;
}

/**
 * Injury status + depth-chart order for every player, keyed by sleeper_id.
 * The raw players dump is 14.6 MB (Sleeper says fetch at most daily), so we
 * reduce it immediately and cache only the ~100 KB slim map as the fixture.
 */
export async function fetchSleeperPlayerInfo(opts: FetchOpts = {}): Promise<SourceResult<Record<string, SlimPlayerInfo>>> {
  const key = "sleeper-players-slim.json";
  const fixturePath = join(RAW_DIR, key);
  if (opts.fixtureOnly) {
    if (!existsSync(fixturePath)) throw new Error(`fixture ${key} missing — run the full lane first`);
    return { data: JSON.parse(readFileSync(fixturePath, "utf8")), fetchedAt: readMeta()[key]?.fetchedAt ?? "unknown", fromFixture: true };
  }
  try {
    const res = await fetch("https://api.sleeper.app/v1/players/nfl");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const full = (await res.json()) as Record<
      string,
      {
        active?: boolean;
        injury_status?: string | null;
        depth_chart_order?: number | null;
        team?: string | null;
        position?: string | null;
      }
    >;
    const slim: Record<string, SlimPlayerInfo> = {};
    for (const [id, p] of Object.entries(full)) {
      if (!p.active) continue;
      if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position ?? "")) continue;
      slim[id] = {
        injury: p.injury_status ?? null,
        depthOrder: p.depth_chart_order ?? null,
        team: p.team ?? null,
      };
    }
    if (Object.keys(slim).length < 500) throw new Error("suspiciously small players payload");
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(slim));
    const meta = readMeta();
    const fetchedAt = new Date().toISOString();
    meta[key] = { fetchedAt };
    writeMeta(meta);
    return { data: slim, fetchedAt, fromFixture: false };
  } catch (err) {
    if (!existsSync(fixturePath)) {
      console.warn(`⚠️  sleeper players: fetch failed (${err}) and no fixture — injury/depth data skipped`);
      return { data: {}, fetchedAt: "unknown", fromFixture: true };
    }
    const fetchedAt = readMeta()[key]?.fetchedAt ?? "unknown";
    console.warn(`⚠️  sleeper players: live fetch FAILED (${err}). Using fixture from ${fetchedAt}.`);
    return { data: JSON.parse(readFileSync(fixturePath, "utf8")), fetchedAt, fromFixture: true };
  }
}

export interface SleeperProjection {
  stats: {
    passYds?: number;
    passTD?: number;
    passInt?: number;
    rushYds?: number;
    rushTD?: number;
    receptions?: number;
    recYds?: number;
    recTD?: number;
    fumblesLost?: number;
    rushFd?: number;
    recFd?: number;
    passFd?: number;
  };
  adp: { standard: number | null; "half-ppr": number | null; ppr: number | null; "2qb": number | null };
}

/**
 * Sleeper's season projections (undocumented, free, no auth): full raw stat
 * lines INCLUDING projected first downs, plus their own ADP per format.
 * Keyed by sleeper_id — our canonical id, so the join is exact. Reduced
 * immediately; only the slim map is cached as the fixture.
 */
export async function fetchSleeperProjections(
  season: number,
  opts: FetchOpts = {}
): Promise<SourceResult<Record<string, SleeperProjection>>> {
  const key = "sleeper-projections.json";
  const fixturePath = join(RAW_DIR, key);
  if (opts.fixtureOnly) {
    if (!existsSync(fixturePath)) throw new Error(`fixture ${key} missing — run the full lane first`);
    return { data: JSON.parse(readFileSync(fixturePath, "utf8")), fetchedAt: readMeta()[key]?.fetchedAt ?? "unknown", fromFixture: true };
  }
  try {
    const url =
      `https://api.sleeper.app/projections/nfl/${season}?season_type=regular` +
      `&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=adp_half_ppr`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as {
      player_id: string;
      stats: Record<string, number | null>;
    }[];
    if (!Array.isArray(rows) || rows.length < 300) throw new Error(`only ${rows?.length} rows`);
    const slim: Record<string, SleeperProjection> = {};
    const adpOf = (v: number | null | undefined) => (v && v > 0 && v < 999 ? v : null);
    for (const row of rows) {
      const s = row.stats ?? {};
      if (!row.player_id) continue;
      slim[row.player_id] = {
        stats: {
          passYds: s.pass_yd ?? undefined,
          passTD: s.pass_td ?? undefined,
          passInt: s.pass_int ?? undefined,
          rushYds: s.rush_yd ?? undefined,
          rushTD: s.rush_td ?? undefined,
          receptions: s.rec ?? undefined,
          recYds: s.rec_yd ?? undefined,
          recTD: s.rec_td ?? undefined,
          fumblesLost: s.fum_lost ?? undefined,
          rushFd: s.rush_fd ?? undefined,
          recFd: s.rec_fd ?? undefined,
          passFd: s.pass_fd ?? undefined,
        },
        adp: {
          standard: adpOf(s.adp_std),
          "half-ppr": adpOf(s.adp_half_ppr),
          ppr: adpOf(s.adp_ppr),
          "2qb": adpOf(s.adp_2qb),
        },
      };
    }
    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(slim));
    const meta = readMeta();
    const fetchedAt = new Date().toISOString();
    meta[key] = { fetchedAt };
    writeMeta(meta);
    return { data: slim, fetchedAt, fromFixture: false };
  } catch (err) {
    if (!existsSync(fixturePath)) {
      console.warn(`⚠️  sleeper projections: fetch failed (${err}) and no fixture — source skipped`);
      return { data: {}, fetchedAt: "unknown", fromFixture: true };
    }
    const fetchedAt = readMeta()[key]?.fetchedAt ?? "unknown";
    console.warn(`⚠️  sleeper projections: live fetch FAILED (${err}). Using fixture from ${fetchedAt}.`);
    return { data: JSON.parse(readFileSync(fixturePath, "utf8")), fetchedAt, fromFixture: true };
  }
}

export function fetchEcr(opts: FetchOpts = {}) {
  return fetchWithFixture(
    "db_fpecr_latest.csv",
    "https://github.com/dynastyprocess/data/raw/master/files/db_fpecr_latest.csv",
    (body) => {
      if (!body.startsWith("fp_page,")) throw new Error("unexpected ecr header");
      return body;
    },
    undefined,
    opts
  );
}

// ---------------------------------------------------------------------------
// Live-status and headline sources (fast-lane safe: one small request each)

/** ESPN's league-wide injuries table — structured Q/D/O/IR/Sus for every player with a designation. */
export function fetchEspnInjuriesTable() {
  return fetchWithFixture<EspnInjuriesJson>(
    "espn-injuries.json",
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
    (body) => {
      const json = JSON.parse(body) as EspnInjuriesJson;
      if (!Array.isArray(json.injuries) || json.injuries.length < 20)
        throw new Error(`unexpected injuries payload (teams=${json.injuries?.length})`);
      return json;
    }
  );
}

const GN = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

export const ETL_RSS_FEEDS: { key: string; url: string; source?: string }[] = [
  { key: "rss-yahoo.xml", url: "https://sports.yahoo.com/nfl/rss.xml", source: "Yahoo Sports" },
  { key: "rss-pft.xml", url: "https://profootballtalk.nbcsports.com/feed/", source: "PFT" },
  { key: "rss-cbs.xml", url: "https://www.cbssports.com/rss/headlines/nfl/", source: "CBS Sports" },
  { key: "rss-espn.xml", url: "https://www.espn.com/espn/rss/nfl/news", source: "ESPN" },
  { key: "rss-rotowire.xml", url: "https://www.rotowire.com/rss/news.php?sport=NFL", source: "RotoWire" },
  { key: "rss-athletic.xml", url: "https://www.nytimes.com/athletic/rss/nfl/", source: "The Athletic" },
  // Google News aggregates hundreds of outlets, keyless; each item names its outlet in <source>.
  { key: "rss-gnews-injuries.xml", url: GN('NFL injury OR "ruled out" OR questionable OR "injured reserve" when:2d') },
  { key: "rss-gnews-fantasy.xml", url: GN("fantasy football NFL when:2d") },
  { key: "rss-gnews-moves.xml", url: GN('NFL (signed OR released OR traded OR waived OR "depth chart" OR starter) when:2d') },
];

/** Headline feeds for baked news. Never fatal: a feed with no fixture yields []. */
export async function fetchRssFeeds(): Promise<SourceResult<NewsItem[]>[]> {
  return Promise.all(
    ETL_RSS_FEEDS.map(async ({ key, url, source }) => {
      try {
        return await fetchWithFixture<NewsItem[]>(
          key,
          url,
          (body) => {
            const items = parseRss(body).map((i) => ({ ...i, source: i.source ?? source }));
            if (items.length === 0) throw new Error("no <item> elements");
            return items;
          },
          { headers: { "user-agent": "Mozilla/5.0 (compatible; DraftCockpit/1.0)" } }
        );
      } catch (err) {
        console.warn(`⚠️  ${key}: ${err} — skipped`);
        return { data: [], fetchedAt: "unknown", fromFixture: true };
      }
    })
  );
}
