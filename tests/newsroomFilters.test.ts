import { describe, it, expect } from "vitest";
import { applyFilters, sortFeed, sortStories, pickTopStories, countBy, DEFAULT_FILTERS, parseFilters, sourcesForChannel, isSocial, type NewsroomFilters } from "../lib/client/newsroomFilters";
import { groupStories } from "../lib/engine/newsImportance";
import type { FeedItem } from "../lib/engine/newsImportance";

const NOW = Date.parse("2026-09-07T20:00:00Z");
const item = (o: Partial<FeedItem> & { id: string }): FeedItem => ({
  playerId: o.id, name: `Player ${o.id}`, pos: "RB", team: "SF", adp: 50, headline: `h ${o.id}`, href: null,
  published: "2026-09-07T19:00:00Z", source: "ESPN", kind: "mention", severity: 0.1, importance: 0.1, ...o,
});
const items: FeedItem[] = [
  item({ id: "a", kind: "season-ending", severity: 1, importance: 0.9, source: "@rapsheet.bsky.social", published: "2026-09-07T19:50:00Z", team: "SEA" }),
  item({ id: "b", kind: "questionable", severity: 0.35, importance: 0.3, source: "RotoWire", published: "2026-09-07T18:00:00Z", pos: "WR" }),
  item({ id: "c", kind: "mention", severity: 0.1, importance: 0.05, source: "ESPN", published: "2026-09-07T10:00:00Z", adp: 3 }),
  item({ id: "a2", playerId: "a", kind: "out", severity: 0.7, importance: 0.6, source: "ESPN injuries", published: "2026-09-07T19:55:00Z", team: "SEA" }),
  item({ id: "d", kind: "cleared", severity: 0.4, importance: 0.35, source: "@rapsheet.bsky.social", published: "2026-09-05T10:00:00Z" }),
];

describe("applyFilters", () => {
  it("passes everything through defaults", () => expect(applyFilters(items, DEFAULT_FILTERS, "")).toHaveLength(5));
  it("filters by position, team and kind", () => {
    expect(applyFilters(items, { ...DEFAULT_FILTERS, pos: "WR" }, "").map((i) => i.id)).toEqual(["b"]);
    expect(applyFilters(items, { ...DEFAULT_FILTERS, teams: ["SEA"] }, "").map((i) => i.id)).toEqual(["a", "a2"]);
    expect(applyFilters(items, { ...DEFAULT_FILTERS, kinds: ["mention", "cleared"] }, "").map((i) => i.id)).toEqual(["c", "d"]);
  });
  it("source filter: only / hide", () => {
    const only: NewsroomFilters = { ...DEFAULT_FILTERS, sourceMode: "only", sources: ["@rapsheet.bsky.social"] };
    expect(applyFilters(items, only, "").map((i) => i.id)).toEqual(["a", "d"]);
    const hide: NewsroomFilters = { ...DEFAULT_FILTERS, sourceMode: "hide", sources: ["@rapsheet.bsky.social", "ESPN"] };
    expect(applyFilters(items, hide, "").map((i) => i.id)).toEqual(["b", "a2"]);
  });
  it("search matches name or headline, case-insensitively", () => {
    expect(applyFilters(items, DEFAULT_FILTERS, "player B").map((i) => i.id)).toEqual(["b"]);
    expect(applyFilters(items, DEFAULT_FILTERS, "H A2").map((i) => i.id)).toEqual(["a2"]);
  });
});

describe("sortFeed", () => {
  it("relevance = importance desc", () => expect(sortFeed(items, "relevance").map((i) => i.id)).toEqual(["a", "a2", "d", "b", "c"]));
  it("newest / oldest by published", () => {
    expect(sortFeed(items, "newest").map((i) => i.id)).toEqual(["a2", "a", "b", "c", "d"]);
    expect(sortFeed(items, "oldest").map((i) => i.id)).toEqual(["d", "c", "b", "a", "a2"]);
  });
  it("adp puts the top of the board first", () => expect(sortFeed(items, "adp")[0].id).toBe("c"));
  it("does not mutate", () => {
    const copy = [...items];
    sortFeed(items, "newest");
    expect(items).toEqual(copy);
  });
});

describe("pickTopStories", () => {
  it("takes the most important recent items, one per player, severity ≥ 0.35", () => {
    const top = pickTopStories(items, 6, NOW);
    expect(top.map((i) => i.id)).toEqual(["a", "b"]); // a2 is the same player; c is a mention; d is 58h old
  });
  it("falls back to the best available when nothing serious is fresh", () => {
    const quiet = [item({ id: "x", importance: 0.05 }), item({ id: "y", importance: 0.08 })];
    expect(pickTopStories(quiet, 3, NOW).map((i) => i.id)).toEqual(["y", "x"]);
  });
});

describe("countBy + parseFilters", () => {
  it("counts sources", () => expect(countBy(items, (i) => i.source)).toEqual({ "@rapsheet.bsky.social": 2, RotoWire: 1, ESPN: 1, "ESPN injuries": 1 }));
  it("parses saved filters defensively", () => {
    expect(parseFilters(null)).toEqual(DEFAULT_FILTERS);
    expect(parseFilters("{bad json")).toEqual(DEFAULT_FILTERS);
    expect(parseFilters(JSON.stringify({ sourceMode: "hide", sources: ["X"], sort: "newest", junk: 1 }))).toEqual({ ...DEFAULT_FILTERS, sourceMode: "hide", sources: ["X"], sort: "newest" });
    expect(parseFilters(JSON.stringify({ sort: "sideways" })).sort).toBe("relevance");
  });
});

describe("sortStories", () => {
  const stories = groupStories(items);
  it("relevance leads with the highest-importance player and folds a's two items together", () => {
    expect(sortStories(stories, "relevance").map((s) => s.playerId)).toEqual(["a", "d", "b", "c"]);
    expect(stories.find((s) => s.playerId === "a")?.items).toHaveLength(2);
  });
  it("newest uses the player's most recent update; oldest the earliest", () => {
    expect(sortStories(stories, "newest")[0].playerId).toBe("a");
    expect(sortStories(stories, "oldest")[0].playerId).toBe("d");
  });
});

describe("channels", () => {
  it("tells Bluesky handles from outlets", () => {
    expect(isSocial("@rapsheet.bsky.social")).toBe(true);
    expect(isSocial("ESPN injury note")).toBe(false);
    expect(isSocial("CBS Sports")).toBe(false);
  });
  it("social shows only @handles; outlets hides them; both shows everything", () => {
    expect(applyFilters(items, { ...DEFAULT_FILTERS, channel: "social" }, "").map((i) => i.id)).toEqual(["a", "d"]);
    expect(applyFilters(items, { ...DEFAULT_FILTERS, channel: "outlets" }, "").map((i) => i.id)).toEqual(["b", "c", "a2"]);
    expect(applyFilters(items, DEFAULT_FILTERS, "")).toHaveLength(5);
  });
  it("narrows the source menu to the channel and parses a saved channel", () => {
    const all = ["ESPN", "@rapsheet.bsky.social", "RotoWire"];
    expect(sourcesForChannel(all, "outlets")).toEqual(["ESPN", "RotoWire"]);
    expect(sourcesForChannel(all, "social")).toEqual(["@rapsheet.bsky.social"]);
    expect(parseFilters(JSON.stringify({ channel: "social" })).channel).toBe("social");
    expect(parseFilters(JSON.stringify({ channel: "nope" })).channel).toBe("all");
  });
});
