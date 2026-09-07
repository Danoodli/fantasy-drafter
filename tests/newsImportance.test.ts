import { describe, it, expect } from "vitest";
import {
  classifyKind, relevanceOf, recencyOf, importanceOf, sourceLabel, buildFeed, groupStories, KIND_SEVERITY,
} from "../lib/engine/newsImportance";
import type { Board, BoardPlayer } from "../lib/types";

const player = (id: string, name: string, adp: number, injury: string | null = null): BoardPlayer => ({
  id, name, pos: "RB", team: "SF", bye: 9, projPoints: 100, projImputed: false, adp, adpStdev: 3, adpHigh: 1, adpLow: 9,
  ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1, injury, depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: {},
});
const board = (...players: BoardPlayer[]): Board => ({
  meta: { format: "ppr", builtAt: "2026-09-07T00:00:00Z", sources: [], scoring: {} as never, warnings: [] },
  players,
});
const NOW = Date.parse("2026-09-07T20:00:00Z");

describe("classifyKind", () => {
  it.each([
    ["RB suffers torn ACL, out for the season", "season-ending"],
    ["Placed on injured reserve", "season-ending"],
    ["NFL suspends WR six games", "suspension"],
    ["Ruled out for Sunday", "out"],
    ["Doubtful to play Sunday", "doubtful"],
    ["Activated from injured reserve, will start", "cleared"],
    ["Back at practice Monday", "cleared"],
    ["Expected to play Week 1", "cleared"],
    ["Questionable with a hamstring strain", "questionable"],
    ["Limited in Wednesday practice", "questionable"],
    ["Not practicing Monday", "questionable"],
    ["Signs four-year extension", "transaction"],
    ["Traded to the Jets for a fourth-round pick", "transaction"],
    ["Named the starter for Week 1", "depth"],
    ["Listed with the first-team offense on the depth chart", "depth"],
    ["Posts 120 yards in preseason win", "mention"],
    ["Among six Dolphins captains for 2026", "depth"],
    ["Coach said Charbonnet (knee) looks awesome in his rehab from a torn ACL", "questionable"],
    ["Bears RBs D'Andre Swift and Kyle Monangai were at practice today. No sign of WR Rome Odunze.", "cleared"],
    ["Cardinals sign WR to a one-year deal", "transaction"],
    ["Recovering from ankle surgery, on track for Week 1", "questionable"],
  ])("%s → %s", (text, kind) => expect(classifyKind(text)).toBe(kind));
});

describe("weights", () => {
  it("relevance falls with ADP and floors at 0.2", () => {
    expect(relevanceOf(1)).toBeCloseTo(0.9973, 3);
    expect(relevanceOf(50)).toBeCloseTo(0.8667, 3);
    expect(relevanceOf(150)).toBeCloseTo(0.6, 3);
    expect(relevanceOf(300)).toBeCloseTo(0.2, 3);
    expect(relevanceOf(900)).toBeCloseTo(0.2, 3);
  });
  it("recency halves every 12 hours and never exceeds 1", () => {
    expect(recencyOf(0)).toBe(1);
    expect(recencyOf(12)).toBeCloseTo(0.5, 6);
    expect(recencyOf(24)).toBeCloseTo(0.25, 6);
    expect(recencyOf(-5)).toBe(1);
  });
  it("the owner's example: an ADP-50 season-ender outranks an ADP-1 nothing-burger", () => {
    const leg = importanceOf("season-ending", 50, 1);
    const nothing = importanceOf("mention", 1, 1);
    expect(leg).toBeGreaterThan(0.85);
    expect(nothing).toBeLessThan(0.11);
    expect(leg / nothing).toBeGreaterThan(8);
  });
  it("severities are ordered as designed", () => {
    const order = ["season-ending", "suspension", "out", "transaction", "doubtful", "cleared", "questionable", "depth", "mention"] as const;
    for (let i = 1; i < order.length; i++) expect(KIND_SEVERITY[order[i - 1]]).toBeGreaterThan(KIND_SEVERITY[order[i]]);
  });
});

describe("sourceLabel", () => {
  it.each([
    ["https://bsky.app/profile/rapsheet.bsky.social/post/3abc", "@rapsheet.bsky.social"],
    ["https://www.espn.com/nfl/story/_/id/1", "ESPN"],
    ["https://www.cbssports.com/nfl/news/x/", "CBS Sports"],
    ["https://www.rotowire.com/football/player/x", "RotoWire"],
    ["https://sports.yahoo.com/nfl/x", "Yahoo Sports"],
    ["https://profootballtalk.nbcsports.com/2026/x", "PFT"],
    [null, "ESPN injury note"],
    ["not a url", "link"],
  ])("%s → %s", (href, label) => expect(sourceLabel(href)).toBe(label));
});

describe("buildFeed", () => {
  const a = player("a", "Star Back", 3);
  const b = player("b", "Mid Back", 50, "Questionable");
  const c = player("c", "Quiet Guy", 120);
  const news = new Map([
    ["a", [{ headline: "Star Back posts 120 yards in preseason win", published: "2026-09-07T19:00:00Z", href: "https://www.espn.com/x" }]],
    ["b", [
      { headline: "Mid Back suffers torn ACL, out for the season", published: "2026-09-07T19:00:00Z", href: "https://bsky.app/profile/rapsheet.bsky.social/post/1" },
      { headline: "Mid Back was limited in practice", published: "2026-09-07T12:00:00Z", href: null, source: "CBS Sports" },
    ]],
  ]);
  const status = new Map([["b", { status: "IR" as const, date: "2026-09-07T19:30Z", note: "Placed on IR." }]]);
  const feed = buildFeed(board(a, b, c), news, status, NOW);

  it("emits every headline per player and a status-change item vs the baked board", () => {
    expect(feed.map((f) => f.playerId)).toEqual(["b", "b", "b", "a"]);
    expect(feed.find((f) => f.source === "CBS Sports")?.kind).toBe("questionable");
    const change = feed.find((f) => f.statusChange)!;
    expect(change.statusChange).toEqual({ from: "Questionable", to: "IR" });
    expect(change.headline).toMatch(/Status: Questionable → IR/);
    expect(change.source).toBe("ESPN injuries");
  });
  it("ranks the ADP-50 season-ender above the ADP-3 mention", () => {
    expect(feed[0].importance).toBeGreaterThan(feed[feed.length - 1].importance);
    expect(feed[0].kind).toBe("season-ending");
  });
  it("skips players with nothing new and gives stable ids", () => {
    expect(feed.some((f) => f.playerId === "c")).toBe(false);
    expect(new Set(feed.map((f) => f.id)).size).toBe(feed.length);
    expect(buildFeed(board(a, b, c), news, status, NOW).map((f) => f.id)).toEqual(feed.map((f) => f.id));
  });
  it("does not emit a status item when the table agrees with the board", () => {
    const same = buildFeed(board(b), new Map(), new Map([["b", { status: "Questionable" as const, date: "2026-09-07T19:30Z", note: null }]]), NOW);
    expect(same).toEqual([]);
  });
  it("groups into one story per player, led by the most important item, sorted by importance", () => {
    const stories = groupStories(feed);
    expect(stories.map((s) => s.playerId)).toEqual(["b", "a"]);
    expect(stories[0].items).toHaveLength(3);
    expect(stories[0].lead.kind).toBe("season-ending");
    expect(stories[0].items[0].published >= stories[0].items[1].published).toBe(true);
    expect(stories[0].sources).toEqual(expect.arrayContaining(["@rapsheet.bsky.social", "CBS Sports", "ESPN injuries"]));
  });
});
