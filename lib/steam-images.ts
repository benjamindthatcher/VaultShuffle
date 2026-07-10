export function steamHeaderImage(appId: number | string) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${String(appId)}/header.jpg`;
}

export function steamCapsuleLargeImage(appId: number | string) {
  // The redesign uses landscape cards; Steam headers are more consistently available than large capsules.
  return steamHeaderImage(appId);
}

export function steamStoreUrl(appId: number | string) {
  return `https://store.steampowered.com/app/${String(appId)}/`;
}
