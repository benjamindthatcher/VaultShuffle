type SteamArtworkSource = {
  steam_appid?: string | null;
  capsule_url?: string | null;
  header_url?: string | null;
};

const STEAM_IMAGE_HOSTS = ["https://cdn.cloudflare.steamstatic.com", "https://cdn.akamai.steamstatic.com"];

export function steamImageUrl(appId: string | null | undefined, type: "capsule" | "header", host = STEAM_IMAGE_HOSTS[0]) {
  const clean = String(appId ?? "").replace(/\D/g, "");
  if (!clean) return "";
  const file = type === "header" ? "header.jpg" : "capsule_184x69.jpg";
  return `${host}/steam/apps/${clean}/${file}`;
}

export function gameImageUrl(game: SteamArtworkSource | null | undefined, type: "capsule" | "header") {
  const cached = type === "header" ? game?.header_url : game?.capsule_url;
  return cached || steamImageUrl(game?.steam_appid, type);
}

export function steamImageCandidates(game: SteamArtworkSource | null | undefined, type: "capsule" | "header") {
  const clean = String(game?.steam_appid ?? "").replace(/\D/g, "");
  const cached = type === "header" ? game?.header_url : game?.capsule_url;
  const generated = clean ? STEAM_IMAGE_HOSTS.map((host) => steamImageUrl(clean, type, host)) : [];
  return [...new Set([cached, ...generated].filter(Boolean))] as string[];
}
