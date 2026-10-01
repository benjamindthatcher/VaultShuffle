const INIT_APP_TAG_MODAL = /InitAppTagModal\(\s*(\d+)\s*,\s*(\[[\s\S]*?\])\s*,/;
/** Furniture every product page carries and the storefront redirect carries none of. */
const PRODUCT_PAGE = /apphub_AppName|game_area_purchase/;

export type StoreTagState = "ok" | "no_tags" | "age_gated" | "unavailable" | "error";
export type StorePageVerdict =
  | { state: "ok"; tags: Record<string, number> }
  | { state: "no_tags" | "age_gated" | "unavailable" };

/** What a fetched store page says about a game, without deciding what to do about it. */
export function readStorePageTags(steamAppId: number, html: string): StorePageVerdict {
  const match = INIT_APP_TAG_MODAL.exec(html);
  if (!match) {
    if (/agecheck/i.test(html)) return { state: "age_gated" };
    // A delisted AppID redirects to the storefront, which carries none of a product
    // page's furniture. A real product page whose tag block could not be read is a
    // different thing and worth asking again in a month, rather than being written
    // off as gone for six.
    return { state: PRODUCT_PAGE.test(html) ? "no_tags" : "unavailable" };
  }
  // Steam answers some retired AppIDs with a replacement product's page. Tagging
  // the wrong game is worse than leaving this one untagged, so the page has to
  // admit to being the one that was asked for.
  if (Number(match[1]) !== steamAppId) return { state: "unavailable" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[2]);
  } catch {
    return { state: "no_tags" };
  }
  if (!Array.isArray(parsed)) return { state: "no_tags" };

  const tags = sanitizeStoreTags(parsed);
  return Object.keys(tags).length ? { state: "ok", tags } : { state: "no_tags" };
}

function sanitizeStoreTags(entries: unknown[]): Record<string, number> {
  const tags: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { name, count } = entry as { name?: unknown; count?: unknown };
    if (typeof name !== "string") continue;
    const tag = name.trim().replace(/\s+/g, " ");
    const weight = Math.max(0, Math.round(Number(count)));
    if (!tag || tag.length > 100 || !Number.isFinite(weight)) continue;
    tags[tag] = weight;
  }
  return tags;
}


export type TagWriteDecision = "write" | "keep-existing" | "keep-other-source";

/**
 * Whether SteamSpy's answer should replace what a game already has.
 *
 * SteamSpy is not the only source of tags and is the weaker one for anything
 * recent: it returns `tags: []` for newer games - Metro Exodus, ARC Raiders, PEAK
 * all came back empty - which sanitizeSteamTags turns into `{}`. Written straight
 * through, that marks a game tagged with nothing, and every filter that reads tags
 * goes blind on exactly the games people are most likely to be looking for.
 */
export function tagWriteDecision(
  current: { hasTags: boolean; source: string | null } | undefined,
  fetched: Record<string, number>
): TagWriteDecision {
  // Nothing to protect. Even an empty answer is worth recording: it is what
  // SteamSpy knows, and the row held nothing before.
  if (!current?.hasTags) return "write";
  // Store-page tags carry real vote weights for games SteamSpy has never heard of.
  // SteamSpy does not get to replace them, whatever it returns.
  if (current.source && current.source !== "steamspy") return "keep-other-source";
  // SteamSpy refreshing its own row, with nothing to say this time.
  if (!Object.keys(fetched).length) return "keep-existing";
  return "write";
}

export function sanitizeSteamTags(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([rawTag, rawWeight]) => {
    const tag = rawTag.trim().replace(/\s+/g, " ");
    const weight = Math.max(0, Math.round(Number(rawWeight)));
    return tag && tag.length <= 100 && Number.isFinite(weight) ? [[tag, weight] as const] : [];
  });
  return Object.fromEntries(entries);
}
