import { describe, it, expect } from "vitest";
import { fixtureAgeDays } from "../lib/etl/weekly/cache";

describe("fixtureAgeDays", () => {
  it("returns age in days for a valid ISO timestamp", () => {
    const now = Date.now();
    const oneDayAgo = new Date(now - 86_400_000).toISOString();
    const age = fixtureAgeDays(oneDayAgo, now);
    expect(age).toBe("1.0");
  });

  it("returns '?' for a garbage string", () => {
    const age = fixtureAgeDays("not-a-date", Date.now());
    expect(age).toBe("?");
  });

  it("returns '?' for an empty string", () => {
    const age = fixtureAgeDays("", Date.now());
    expect(age).toBe("?");
  });
});
