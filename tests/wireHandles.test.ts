import { describe, it, expect } from "vitest";
import { DEFAULT_WIRE_HANDLES } from "../lib/client/bskyNews";
describe("DEFAULT_WIRE_HANDLES", () => {
  it("are unique, lowercase, and look like handles", () => {
    expect(new Set(DEFAULT_WIRE_HANDLES).size).toBe(DEFAULT_WIRE_HANDLES.length);
    for (const h of DEFAULT_WIRE_HANDLES) expect(h).toMatch(/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/);
  });
  it("covers national insiders, aggregators, fantasy bots and beat reporters", () => {
    expect(DEFAULT_WIRE_HANDLES.length).toBeGreaterThanOrEqual(50);
    expect(DEFAULT_WIRE_HANDLES).toContain("rotowirenfl.bsky.social");
    expect(DEFAULT_WIRE_HANDLES).toContain("mikereiss.bsky.social");
  });
});
