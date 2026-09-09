import { describe, it, expect } from "vitest";
import { parseEspnScoreboard, parseHistoricalLines, lineFor, type GameLine } from "../lib/etl/weekly/vegas";

const scoreboard = {
  week: { number: 1 },
  season: { year: 2026, type: 2 },
  events: [
    {
      week: { number: 1 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { abbreviation: "SEA" } },
            { homeAway: "away", team: { abbreviation: "NE" } },
          ],
          odds: [{ provider: { priority: 1 }, spread: -3, overUnder: 44.5 }],
        },
      ],
    },
    {
      week: { number: 1 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { abbreviation: "LA" } },
            { homeAway: "away", team: { abbreviation: "SF" } },
          ],
          odds: [],
        },
      ],
    },
  ],
};

describe("vegas lines", () => {
  it("reads spread and total from the ESPN scoreboard, home-relative", () => {
    const lines = parseEspnScoreboard(scoreboard);
    expect(lines).toHaveLength(1); // the odds-less game is dropped, not defaulted
    expect(lines[0]).toEqual({ week: 1, home: "SEA", away: "NE", total: 44.5, homeSpread: -3 });
  });

  it("canonicalizes nflverse team codes when reading history", () => {
    const csv = [
      "season,week,game_type,home_team,away_team,spread_line,total_line",
      "2024,3,REG,LA,SF,2.5,47.5",
      "2024,3,POST,KC,BUF,-1,45",
      "2023,3,REG,JAC,IND,-3,44",
    ].join("\n");
    const lines = parseHistoricalLines(csv, 2024);
    expect(lines).toHaveLength(1);
    // nflverse spread_line is HOME-relative and POSITIVE when home is favored;
    // we store the betting convention (negative = home favored).
    expect(lines[0]).toEqual({ week: 3, home: "LAR", away: "SF", total: 47.5, homeSpread: -2.5 });
  });

  it("drops unlined games instead of fabricating a pick'em", () => {
    // Number("") is 0 and Number.isFinite(0) is true, so a blank field slips
    // past a naive isFinite guard and becomes total 0 / spread 0. The real
    // games.csv carries 160 such rows for the in-progress season.
    const csv = [
      "season,week,game_type,home_team,away_team,spread_line,total_line",
      "2026,5,REG,DAL,NYG,,",
      "2026,5,REG,KC,DEN,-6.5,",
      "2026,5,REG,SF,SEA, ,44",
      "2026,5,REG,BUF,MIA,-3,49.5",
    ].join("\n");
    const lines = parseHistoricalLines(csv, 2026);
    expect(lines).toHaveLength(1);
    expect(lines[0].home).toBe("BUF");
    expect(lines[0].total).toBe(49.5);
    expect(lines[0].homeSpread).toBe(3);
  });

  it("prefers the highest-priority provider that published both numbers", () => {
    const multi = {
      week: { number: 4 },
      events: [
        {
          week: { number: 4 },
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { abbreviation: "KC" } },
                { homeAway: "away", team: { abbreviation: "DEN" } },
              ],
              odds: [
                { provider: { priority: 3 }, spread: -9, overUnder: 41 },
                { provider: { priority: 1 }, spread: -7.5, overUnder: 43.5 },
                { provider: { priority: 2 }, spread: -8 },
              ],
            },
          ],
        },
      ],
    };
    const lines = parseEspnScoreboard(multi);
    expect(lines).toHaveLength(1);
    expect(lines[0].homeSpread).toBe(-7.5);
    expect(lines[0].total).toBe(43.5);
  });

  it("drops a game with no resolvable week rather than calling it week 0", () => {
    const noWeek = {
      events: [
        {
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { abbreviation: "KC" } },
                { homeAway: "away", team: { abbreviation: "DEN" } },
              ],
              odds: [{ provider: { priority: 1 }, spread: -7, overUnder: 44 }],
            },
          ],
        },
      ],
    };
    expect(parseEspnScoreboard(noWeek)).toHaveLength(0);
  });

  it("gives each team its own spread and opponent", () => {
    const lines: GameLine[] = [{ week: 1, home: "SEA", away: "NE", total: 44.5, homeSpread: -3 }];
    expect(lineFor(lines, "SEA")).toEqual({ total: 44.5, ownSpread: -3, opp: "NE" });
    expect(lineFor(lines, "NE")).toEqual({ total: 44.5, ownSpread: 3, opp: "SEA" });
    expect(lineFor(lines, "DAL")).toBeNull();
  });
});
