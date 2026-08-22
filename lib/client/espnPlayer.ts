"use client";

// Per-player live extras from ESPN's public athlete-overview endpoint
// (CORS *, no auth): Rotowire note, recent headlines, last-season stat line.
// Fetched on demand when a player card opens, cached for the session.
// Everything is optional — the modal renders fine when this fails.

export interface PlayerExtras {
  rotowire: { headline: string; story: string } | null;
  news: { headline: string; published: string; href: string | null }[];
  lastSeason: { title: string; labels: string[]; values: string[] } | null;
}

const cache = new Map<string, PlayerExtras | null>();

export async function fetchPlayerExtras(espnId: string): Promise<PlayerExtras | null> {
  if (cache.has(espnId)) return cache.get(espnId)!;
  try {
    const res = await fetch(
      `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${espnId}/overview`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();

    const rw = j.rotowire;
    const rotowire =
      rw?.headline || rw?.story
        ? { headline: String(rw.headline ?? ""), story: String(rw.story ?? "") }
        : null;

    const newsItems: unknown[] = j.news?.items ?? (Array.isArray(j.news) ? j.news : []);
    const news = newsItems.slice(0, 4).map((raw) => {
      const n = raw as {
        headline?: string;
        published?: string;
        links?: { web?: { href?: string } };
      };
      return {
        headline: n.headline ?? "",
        published: n.published ?? "",
        href: n.links?.web?.href ?? null,
      };
    });

    const stats = j.statistics;
    const split = stats?.splits?.find(
      (s: { name?: string }) => s.name === "Regular Season"
    ) ?? stats?.splits?.[0];
    const lastSeason =
      stats?.labels && split?.stats
        ? {
            title: String(stats.displayName ?? "Last season"),
            labels: stats.labels as string[],
            values: split.stats as string[],
          }
        : null;

    const extras: PlayerExtras = { rotowire, news, lastSeason };
    cache.set(espnId, extras);
    return extras;
  } catch {
    cache.set(espnId, null);
    return null;
  }
}
