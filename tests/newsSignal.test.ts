import { describe, it, expect } from "vitest";
import { classifyNews, liveInjuryStatus } from "../lib/engine/newsSignal";

describe("classifyNews — hard signals", () => {
  it.each([
    ["Chris Godwin placed on injured reserve", "IR"],
    ["Report: Player suffers season-ending torn ACL", "IR"],
    ["Sources: RB out for the season with Achilles tear", "IR"],
    ["NFL suspends WR six games for violating policy", "Sus"],
    ["Player arrested on domestic violence charge", "Sus"],
    ["Coach: QB has been ruled out for Sunday", "Out"],
    ["Star RB will not play against the Chiefs", "Out"],
    ["TE listed as inactive for Week 1", "Out"],
    ["WR is doubtful to play Sunday", "Doubtful"],
    ["Player carted off the field with knee injury", "Out"],
  ])("%s → %s", (headline, expected) => {
    expect(classifyNews(headline)).toBe(expected);
  });
});

describe("classifyNews — must NOT fire", () => {
  it.each([
    // Recoveries and clearances are the dangerous inverse case.
    "Player activated from injured reserve, will start Sunday",
    "WR returns from suspension, expected to play",
    "RB cleared to return after passing concussion protocol",
    "QB avoids suspension following league review",
    "TE is no longer doubtful, upgraded to probable",
    "Player will play Sunday despite ankle injury",
    "Coach says star RB is not expected to miss any time",
    "WR removed from injury report",
    // Soft signals are out of scope for hard-signals-only grading.
    "Player questionable with a hamstring strain",
    "RB limited in Wednesday practice",
    // Generic noise must never downgrade anyone.
    "Player signs four-year extension",
    "WR posts 120 yards in preseason win",
    "Fantasy football rankings: Week 3 sleepers",
    "Team suspends operations at facility for cleaning",
  ])("%s → null", (headline) => {
    expect(classifyNews(headline)).toBeNull();
  });
});

describe("liveInjuryStatus", () => {
  const board = "IR" as const;
  it("prefers the more severe of baked status and live news", () => {
    expect(liveInjuryStatus("Questionable", "Out")).toBe("Out");
    expect(liveInjuryStatus(null, "IR")).toBe("IR");
    expect(liveInjuryStatus(board, "Doubtful")).toBe("IR"); // never soften a baked IR
  });
  it("passes through when there is no live signal", () => {
    expect(liveInjuryStatus("Questionable", null)).toBe("Questionable");
    expect(liveInjuryStatus(null, null)).toBeNull();
  });
  it("is a pure function of its arguments", () => {
    expect(liveInjuryStatus("Out", null)).toBe(liveInjuryStatus("Out", null));
  });
});
