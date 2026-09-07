import { describe, it, expect } from "vitest";
import { migrateSources, LEGACY_WIRE_DEFAULTS, DEFAULT_SOURCES } from "../lib/client/sources";
import { DEFAULT_WIRE_HANDLES } from "../lib/client/bskyNews";

describe("migrateSources — stale handle snapshots", () => {
  it("a saved copy of the old six defaults means 'use defaults'", () => {
    expect(migrateSources({ wireHandles: [...LEGACY_WIRE_DEFAULTS] }).wireHandles).toEqual([]);
  });
  it("a saved copy of the current defaults also means 'use defaults'", () => {
    expect(migrateSources({ wireHandles: [...DEFAULT_WIRE_HANDLES] }).wireHandles).toEqual([]);
  });
  it("old defaults plus a custom handle → current defaults plus that handle", () => {
    const out = migrateSources({ wireHandles: [...LEGACY_WIRE_DEFAULTS, "mybeat.bsky.social"] }).wireHandles;
    expect(out).toEqual([...DEFAULT_WIRE_HANDLES, "mybeat.bsky.social"]);
  });
  it("a deliberate post-expansion list is left alone", () => {
    const list = ["rotowirenfl.bsky.social", "mybeat.bsky.social"];
    expect(migrateSources({ wireHandles: list }).wireHandles).toEqual(list);
  });
  it("fills missing keys from defaults", () => {
    expect(migrateSources({})).toEqual(DEFAULT_SOURCES);
    expect(migrateSources({ wire: false }).wireLists).toEqual(DEFAULT_SOURCES.wireLists);
  });
});
