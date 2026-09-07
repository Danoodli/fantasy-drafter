import { describe, it, expect } from "vitest";
import { formatAge } from "../lib/client/boardAge";
const T = Date.parse("2026-09-07T20:00:00Z");
describe("formatAge", () => {
  it.each([
    ["2026-09-07T19:59:40Z", "built just now", false],
    ["2026-09-07T19:48:00Z", "built 12 min ago", false],
    ["2026-09-07T17:00:00Z", "built 3 h ago", false],
    ["2026-09-07T07:59:00Z", "built 12 h ago", true],
    ["2026-09-05T20:00:00Z", "built 2 d ago", true],
  ])("%s → %s (stale=%s)", (iso, label, stale) => expect(formatAge(iso, T)).toEqual({ label, stale }));
  it("handles garbage", () => expect(formatAge("nope", T)).toEqual({ label: "build time unknown", stale: true }));
});
