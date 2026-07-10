import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/login", "/app/vault", "/app/library", "/app/collections", "/app/wishlist"];

  return routes.map((route) => ({
    url: `https://vaultshuffle.com${route}`,
    changeFrequency: route.startsWith("/app/") ? "weekly" : "monthly",
    priority: route === "" ? 1 : route.startsWith("/app/") ? 0.8 : 0.6
  }));
}
