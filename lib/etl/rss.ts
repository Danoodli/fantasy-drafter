// Minimal RSS 2.0 item parser. Regex on purpose: it runs in the browser (no
// DOMParser in tests) and in the ETL (no DOM at all), and feeds are small.
import type { NewsItem } from "./newsMatch";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** US zone abbreviations Date.parse handles inconsistently across engines. */
const ZONES: Record<string, number> = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, UTC: 0, GMT: 0 };

/** RFC-822 / "hh:mm:ss AM ZONE" → ISO; "" when unparseable. */
export function toIso(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const twelve = s.match(/^(?:\w{3},\s*)?(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s*([A-Z]{3,4})$/i);
  if (twelve) {
    const [, d, mon, y, hh, mm, ss, ap, zone] = twelve;
    let h = Number(hh) % 12;
    if (ap.toUpperCase() === "PM") h += 12;
    const off = ZONES[zone.toUpperCase()] ?? 0;
    const t = Date.parse(`${d} ${mon} ${y} ${String(h).padStart(2, "0")}:${mm}:${ss ?? "00"} GMT`);
    return Number.isFinite(t) ? new Date(t - off * 3_600_000).toISOString() : "";
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

export function parseRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const block of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const headline = stripTags(decodeEntities(tag(block, "title")));
    if (!headline) continue;
    out.push({
      headline,
      description: stripTags(decodeEntities(tag(block, "description"))),
      published: toIso(tag(block, "pubDate") || tag(block, "dc:date")),
      href: tag(block, "link") || null,
      athleteIds: [],
    });
  }
  return out;
}
