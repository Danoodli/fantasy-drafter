/**
 * Normalize a player name for cross-source joining, matching the convention
 * of DynastyProcess's merge_name column: lowercase, periods/apostrophes/commas
 * stripped, hyphens KEPT, diacritics transliterated (Piñeiro → pineiro),
 * generational suffixes removed.
 */
export function mergeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[.'’,]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Loose key for nickname-tolerant fallback matching: last token plus the
 * first three letters of the first token ("kenny gainwell" and
 * "kenneth gainwell" both → "gainwell|ken"). Only trust this key together
 * with a position check.
 */
export function looseName(name: string): string {
  const parts = mergeName(name).split(" ");
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts[parts.length - 1]}|${parts[0].slice(0, 3)}`;
}
