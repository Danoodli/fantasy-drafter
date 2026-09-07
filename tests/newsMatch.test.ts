import { describe, it, expect } from "vitest";
import { matchAllNews, matchNewsToPlayers, mergeAllNews, newestPerPlayer, type NewsItem, type PlayerNews } from "../lib/etl/newsMatch";
import type { BoardPlayer } from "../lib/types";

const p = (id: string, name: string, espn?: string): BoardPlayer => ({
  id, name, pos: "RB", team: "SF", bye: 9, projPoints: 0, projImputed: false, adp: 10, adpStdev: 1, adpHigh: 1, adpLow: 1,
  ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1, injury: null, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: { espn },
});
const NOW = Date.parse("2026-09-07T20:00:00Z");
const item = (headline: string, published: string, href: string | null = null, extra: Partial<NewsItem> = {}): NewsItem => ({
  headline, description: "", published, href, athleteIds: [], ...extra,
});
const players = [p("gibbs", "Jahmyr Gibbs", "4429795"), p("chase", "Ja'Marr Chase")];

describe("matchAllNews", () => {
  const items = [
    item("Jahmyr Gibbs limited in practice", "2026-09-07T18:00:00Z", "https://a/1", { source: "CBS Sports" }),
    item("Gibbs poised for a career year", "2026-09-07T19:00:00Z", "https://a/2", { athleteIds: ["4429795"] }),
    item("Jahmyr Gibbs limited in practice", "2026-09-07T18:30:00Z", "https://a/1"), // same href → duplicate
    item("Ja'Marr Chase back at practice", "2026-09-07T17:00:00Z", "https://bsky.app/x"),
    item("Ja'Marr Chase back at practice", "2026-09-07T17:05:00Z", null), // same headline, no href → duplicate
    item("Old Gibbs note", "2026-09-03T00:00:00Z", "https://a/old"),
  ];
  const all = matchAllNews(items, players, 72, NOW);
  it("keeps every distinct item per player, newest first", () => {
    expect(all.get("gibbs")?.map((n) => n.href)).toEqual(["https://a/2", "https://a/1"]);
    expect(all.get("chase")).toHaveLength(1);
  });
  it("carries the source through", () => expect(all.get("gibbs")?.[1].source).toBe("CBS Sports"));
  it("newest-per-player view agrees with the old matcher", () => {
    expect(matchNewsToPlayers(items, players, 72, NOW).get("gibbs")?.href).toBe("https://a/2");
    expect(newestPerPlayer(all).get("chase")?.published).toBe("2026-09-07T17:00:00Z");
  });
});

describe("mergeAllNews", () => {
  it("concatenates sources, drops duplicates, sorts newest first", () => {
    const a = new Map<string, PlayerNews[]>([["x", [{ headline: "one", published: "2026-09-07T10:00:00Z", href: "h1" }]]]);
    const b = new Map<string, PlayerNews[]>([["x", [{ headline: "two", published: "2026-09-07T12:00:00Z", href: "h2" }, { headline: "one again", published: "2026-09-07T10:00:00Z", href: "h1" }]]]);
    expect(mergeAllNews(a, b).get("x")?.map((n) => n.href)).toEqual(["h2", "h1"]);
  });
});
