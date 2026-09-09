// Shared fetch → reduce → cache → fallback for the weekly ETL sources.
//
// lib/etl/fetchers.ts's fetchWithFixture caches the RAW response body. The
// weekly sources are far too large for that (nflverse alone is 8.6 MB per
// season), so they reduce first and cache only the slim result. This helper is
// that contract, including the staleness bookkeeping AGENTS.md requires: the
// real fetch timestamp is persisted to data/raw/weekly/meta.json, so a
// fallback can say how old its fixture is.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FetchOpts, SourceResult } from "../fetchers";

export const WEEKLY_RAW_DIR = join(process.cwd(), "data", "raw", "weekly");

/** Human-readable fixture age. Pure, so it is unit-tested. */
export function fixtureAgeDays(fetchedAt: string, nowMs: number): string {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return "?";
  return ((nowMs - t) / 86_400_000).toFixed(1);
}

/**
 * @param key      fixture filename under data/raw/weekly/
 * @param load     live fetch + reduce; throw to trigger the fixture fallback
 * @param opts     FetchOpts with fixtureOnly and other fetch options
 * @param onMissing when given, a missing fixture yields this value with a
 *                  warning instead of throwing (for sources the engine can
 *                  run neutrally without)
 */
export async function fetchSlim<T>(
  key: string,
  load: () => Promise<T>,
  opts: FetchOpts = {},
  onMissing?: () => T
): Promise<SourceResult<T>> {
  const fixturePath = join(WEEKLY_RAW_DIR, key);
  const metaPath = join(WEEKLY_RAW_DIR, "meta.json");
  const readFixture = () => JSON.parse(readFileSync(fixturePath, "utf8"));
  const readMeta = () => {
    try {
      return JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      return {};
    }
  };

  if (opts.fixtureOnly) {
    if (!existsSync(fixturePath)) throw new Error(`fixture ${key} missing — run the weekly lane live first`);
    const meta = readMeta();
    const fetchedAt = meta[key] ?? "unknown";
    return { data: readFixture(), fetchedAt, fromFixture: true };
  }

  try {
    const data = await load();
    mkdirSync(WEEKLY_RAW_DIR, { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(data));
    const now = new Date().toISOString();
    const meta = readMeta();
    meta[key] = now;
    writeFileSync(metaPath, JSON.stringify(meta));
    return { data, fetchedAt: now, fromFixture: false };
  } catch (err) {
    if (!existsSync(fixturePath)) {
      if (onMissing) {
        console.warn(`\n⚠️  ${key}: live fetch FAILED (${err}). No fixture available. Using neutral fallback.\n`);
        return { data: onMissing(), fetchedAt: "unknown", fromFixture: true };
      }
      throw new Error(`${key} failed (${err}) and no fixture at ${fixturePath}`);
    }
    const meta = readMeta();
    const fetchedAt = meta[key] ?? "unknown";
    const age = fixtureAgeDays(fetchedAt, Date.now());
    console.warn(`\n⚠️  ${key}: live fetch FAILED (${err}). Fixture is ${age} days old.\n`);
    return { data: readFixture(), fetchedAt, fromFixture: true };
  }
}
