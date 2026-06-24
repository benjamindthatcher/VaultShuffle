export function steamImageUrl(appId: string | null | undefined, type: "capsule" | "header") {
  const clean = String(appId ?? "").replace(/\D/g, "");
  if (!clean) return "";
  const file = type === "header" ? "header.jpg" : "capsule_184x69.jpg";
  return `https://cdn.akamai.steamstatic.com/steam/apps/${clean}/${file}`;
}
