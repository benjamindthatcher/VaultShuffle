import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/vault", "/library", "/purge", "/collections", "/wishlist", "/help", "/privacy", "/terms", "/steam-data", "/contact"];

  return routes.map((route) => ({
    url: `https://vaultshuffle.com${route}`,
    changeFrequency: ["/vault", "/library", "/purge", "/collections", "/wishlist"].includes(route) ? "weekly" : "monthly",
    priority: route === "" ? 1 : ["/vault", "/library", "/purge", "/collections", "/wishlist"].includes(route) ? 0.8 : 0.6
  }));
}
