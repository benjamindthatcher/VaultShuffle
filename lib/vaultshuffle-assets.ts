const ASSET_ROOT = "/assets/vaultshuffle";

const collectionBannerNames: Record<string, string> = {
  "backlog essentials": "backlog-essentials",
  "story rich": "story-rich",
  "short & sweet": "short-and-sweet",
  "short and sweet": "short-and-sweet",
  "co-op nights": "coop-nights",
  "coop nights": "coop-nights",
  "indie gems": "indie-gems",
  atmospherics: "atmospherics",
  "comfort games": "comfort-games",
  "100% club": "hundred-percent-club",
  "hundred percent club": "hundred-percent-club",
  "cosmic odyssey": "cosmic-odyssey",
  "retro vault": "retro-vault",
  "neon nights": "neon-nights",
  "mind benders": "mind-benders"
};

const candidateFallbacks = [
  "void-runner", "solar-frontier", "iron-titan", "moon-citadel", "forest-wanderer",
  "blue-warden", "cozy-embers", "neon-run", "mind-loop", "retro-circuit"
] as const;

/**
 * Every smart collection has a banner of its own, chosen for what the rule
 * means rather than for what the shelf happens to be called. A shelf named "hi"
 * running the Nearly Finished rule still looks like Nearly Finished.
 */
const smartCollectionBanners: Record<string, string> = {
  "nearly-finished": "hundred-percent-club",
  "quick-wins": "short-and-sweet",
  "recently-played": "neon-nights",
  "fallen-off": "atmospherics",
  "long-haul": "story-rich",
  "endless-rotation": "cosmic-odyssey",
  untouched: "backlog-essentials"
};

/** Banners kept back for hand-made shelves, so they never look like a rule. */
const customCollectionBanners = [
  "indie-gems", "mind-benders", "coop-nights", "retro-vault", "comfort-games"
] as const;

function bannerPath(assetName: string) {
  return `${ASSET_ROOT}/collection-banners/${assetName}.png`;
}

/** Stable per name, so a shelf keeps the same banner between visits. */
function hash(value: string) {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) total = (total * 31 + value.charCodeAt(index)) >>> 0;
  return total;
}

export function collectionBanner(name: string, smartPreset?: string | null) {
  const named = collectionBannerNames[name.trim().toLowerCase()];
  if (named) return bannerPath(named);

  const bySmartRule = smartPreset ? smartCollectionBanners[smartPreset] : undefined;
  if (bySmartRule) return bannerPath(bySmartRule);

  const index = hash(name.trim().toLowerCase() || "collection") % customCollectionBanners.length;
  return bannerPath(customCollectionBanners[index]);
}

export function candidateFallback(index: number) {
  const assetName = candidateFallbacks[index % candidateFallbacks.length];
  return `${ASSET_ROOT}/vault-candidates-wide/${assetName}.png`;
}

/**
 * What a game looks like when Steam has no artwork for it. Keyed off the title
 * so the same game always gets the same picture, and never the vault door,
 * which is the brand's own image and reads as "this is VaultShuffle", not as
 * "this is a game we could not find a picture of".
 */
export function gameArtworkFallback(key: string) {
  return candidateFallback(hash(key || "game"));
}
