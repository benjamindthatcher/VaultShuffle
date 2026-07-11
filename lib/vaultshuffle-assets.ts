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

export function collectionBanner(name: string) {
  const assetName = collectionBannerNames[name.trim().toLowerCase()];
  return assetName ? `${ASSET_ROOT}/collection-banners/${assetName}.png` : undefined;
}

export function candidateFallback(index: number) {
  const assetName = candidateFallbacks[index % candidateFallbacks.length];
  return `${ASSET_ROOT}/vault-candidates-wide/${assetName}.png`;
}
