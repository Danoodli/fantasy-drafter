import { describe, it, expect } from "vitest";
import { feedToNews, parseListRef } from "../lib/client/bskyNews";

const post = (handle: string, text: string, extra: Record<string, unknown> = {}) => ({
  post: { uri: `at://did:plc:x/app.bsky.feed.post/${text.length}`, author: { handle }, record: { text, createdAt: "2026-09-07T12:00:00Z", ...extra } },
});

describe("feedToNews", () => {
  it("maps posts to news items with a bsky.app link", () => {
    const [n] = feedToNews([post("rapsheet.bsky.social", "Bijan Robinson ruled out")], {});
    expect(n).toMatchObject({ headline: "Bijan Robinson ruled out", published: "2026-09-07T12:00:00Z", athleteIds: [] });
    expect(n.href).toBe("https://bsky.app/profile/rapsheet.bsky.social/post/24");
  });
  it("skips reposts, replies and blocked handles when asked", () => {
    const feed = [
      { ...post("a.bsky.social", "repost"), reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
      post("b.bsky.social", "reply", { reply: { parent: {} } }),
      post("spam.bsky.social", "blocked"),
      post("ok.bsky.social", "kept"),
    ];
    const out = feedToNews(feed as never, { blocked: new Set(["spam.bsky.social"]), skipReposts: true, skipReplies: true });
    expect(out.map((n) => n.headline)).toEqual(["kept"]);
  });
  it("truncates long headlines to 140 chars + ellipsis but keeps the full text as description", () => {
    const text = "x".repeat(200);
    const [n] = feedToNews([post("a.bsky.social", text)], {});
    expect(n.headline).toHaveLength(141);
    expect(n.description).toBe(text);
  });
});

describe("parseListRef", () => {
  it("accepts AT-URIs", () => expect(parseListRef("at://did:plc:abc/app.bsky.graph.list/3lasn")).toEqual({ uri: "at://did:plc:abc/app.bsky.graph.list/3lasn" }));
  it("accepts bsky.app list URLs", () => expect(parseListRef("https://bsky.app/profile/bernzone.bsky.social/lists/3lasn45b4da2l")).toEqual({ handle: "bernzone.bsky.social", rkey: "3lasn45b4da2l" }));
  it("rejects junk", () => expect(parseListRef("hello")).toBeNull());
});
