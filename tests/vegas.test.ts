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

  it("gives each team its own spread and opponent", () => {
    const lines: GameLine[] = [{ week: 1, home: "SEA", away: "NE", total: 44.5, homeSpread: -3 }];
    expect(lineFor(lines, "SEA")).toEqual({ total: 44.5, ownSpread: -3, opp: "NE" });
    expect(lineFor(lines, "NE")).toEqual({ total: 44.5, ownSpread: 3, opp: "SEA" });
    expect(lineFor(lines, "DAL")).toBeNull();
  });
});
