import { describe, it, expect } from "vitest";
import { parseEspnInjuries, espnIdFromLinks } from "../lib/client/espnInjuries";
import type { BoardPlayer } from "../lib/types";

const p = (id: string, espn: string): BoardPlayer => ({
  id, name: id, pos: "RB", team: "ARI", bye: 8, projPoints: 0, projImputed: false, adp: 50, adpStdev: 5,
  adpHigh: 40, adpLow: 60, ecr: null, ecrStdev: null, vorp: 0, vols: 0, tier: 1, injury: null,
  depthOrder: 1, sosSeason: null, sosPlayoff: null, ids: { espn },
});
const link = (id: number) => [{ href: `https://www.espn.com/nfl/player/_/id/${id}/x` }];
const JSON_ = {
  injuries: [
    { id: "22", displayName: "Arizona Cardinals", injuries: [
      { status: "Questionable", date: "2026-09-06T17:49Z", shortComment: "Love (ankle) is progressing.", athlete: { displayName: "Jeremiyah Love", links: link(4870808) } },
      { status: "Active", date: "2026-09-04T21:36Z", shortComment: "Brissett listed with the first team.", athlete: { displayName: "Jacoby Brissett", links: link(1) } },
      { status: "Out", date: "2026-08-01T00:00Z", shortComment: "Old note.", athlete: { displayName: "Someone Else", links: link(999) } },
      { status: "Physically Unable", date: "2026-09-01T00:00Z", athlete: { displayName: "Unknown Word", links: link(2) } },
    ] },
  ],
};
const NOW = Date.parse("2026-09-07T20:00:00Z");

describe("espnIdFromLinks", () => {
  it("extracts the numeric id", () => expect(espnIdFromLinks(link(4870808))).toBe("4870808"));
  it("null without links", () => expect(espnIdFromLinks(undefined)).toBeNull());
});

describe("parseEspnInjuries", () => {
  const players = [p("love", "4870808"), p("brissett", "1"), p("old", "999"), p("unk", "2")];
  const { status, news } = parseEspnInjuries(JSON_, players, 72, NOW);
  it("maps statuses by ESPN id, including Active", () => {
    expect(status.get("love")).toMatchObject({ status: "Questionable", date: "2026-09-06T17:49Z" });
    expect(status.get("brissett")?.status).toBe("Active");
  });
  it("keeps stale statuses (an old Out is still a status)", () => expect(status.get("old")?.status).toBe("Out"));
  it("skips vocabulary it cannot map", () => expect(status.has("unk")).toBe(false));
  it("emits the dated note as news inside the window only", () => {
    expect(news.get("love")).toEqual({ headline: "Love (ankle) is progressing.", published: "2026-09-06T17:49Z", href: null });
    expect(news.has("old")).toBe(false);
  });
  it("ignores rows for players not on the board", () => {
    const r = parseEspnInjuries(JSON_, [p("love", "4870808")], 72, NOW);
    expect(r.status.size).toBe(1);
  });
});
