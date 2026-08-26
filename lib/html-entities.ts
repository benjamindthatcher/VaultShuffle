/**
 * Steam's short descriptions arrive with HTML entities in them, because the
 * store renders them as HTML. React escapes text, so "&quot;Pals&quot;" was
 * printed literally rather than as quotation marks.
 *
 * Decoded at display time rather than on the way into the catalogue: 1,490 rows
 * already carry entities and every future import brings more, so fixing the
 * stored copy would need a migration and then keep needing one.
 *
 * Deliberately not a general HTML parser. It decodes the entities Steam
 * actually uses and leaves anything else alone, so no tag can be smuggled in
 * through a description - the output is still rendered as text, never markup.
 */
const NAMED: Record<string, string> = {
  quot: "\"",
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  trade: "™",
  reg: "®",
  copy: "©",
  deg: "°",
  eacute: "é"
};

export function decodeHtmlEntities(value: string): string {
  if (!value || !value.includes("&")) return value;

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Ignore anything outside the range that can be a character, rather than
      // producing a replacement glyph.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    // Ampersand last, so "&amp;quot;" decodes to "&quot;" and stops there
    // rather than becoming a quotation mark.
    return NAMED[body.toLowerCase()] ?? whole;
  });
}
