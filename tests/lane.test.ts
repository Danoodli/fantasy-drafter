import { describe, it, expect } from "vitest";
import { parseLane } from "../lib/etl/lane";
describe("parseLane", () => {
  it("defaults to full", () => expect(parseLane(["tsx", "build-board.ts"])).toBe("full"));
  it("reads --lane=fast", () => expect(parseLane(["x", "y", "--lane=fast"])).toBe("fast"));
  it("accepts --lane=full", () => expect(parseLane(["x", "--lane=full"])).toBe("full"));
  it("rejects nonsense", () => expect(() => parseLane(["x", "--lane=turbo"])).toThrow(/turbo/));
});
