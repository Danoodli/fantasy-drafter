import { describe, it, expect } from "vitest";
import { parseRss } from "../lib/etl/rss";

const XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>NFL</title>
<item><title><![CDATA[Ja'Marr Chase &amp; Tee Higgins back at practice]]></title>
<link>https://example.com/a</link>
<description><![CDATA[Bengals WRs <b>returned</b> Monday.]]></description>
<pubDate>Mon, 07 Sep 2026 20:17:58 +0000</pubDate></item>
<item><title>Rome Odunze: Not practicing Monday</title><link>https://example.com/b</link>
<pubDate>Mon, 07 Sep 2026 12:50:00 PM PDT</pubDate></item>
<item><title></title><link>https://example.com/empty</link></item>
</channel></rss>`;

describe("parseRss", () => {
  const items = parseRss(XML);
  it("reads title, link, description with CDATA and entities decoded, tags stripped", () => {
    expect(items[0].headline).toBe("Ja'Marr Chase & Tee Higgins back at practice");
    expect(items[0].description).toBe("Bengals WRs returned Monday.");
    expect(items[0].href).toBe("https://example.com/a");
    expect(items[0].athleteIds).toEqual([]);
  });
  it("normalises RFC-822 dates to ISO", () => {
    expect(items[0].published).toBe("2026-09-07T20:17:58.000Z");
  });
  it("parses RotoWire's 12-hour Pacific format", () => {
    expect(items[1].published).toBe("2026-09-07T19:50:00.000Z");
  });
  it("drops items with no title and tolerates a missing description", () => {
    expect(items).toHaveLength(2);
    expect(items[1].description).toBe("");
  });
  it("returns [] for garbage", () => expect(parseRss("not xml")).toEqual([]));
});
