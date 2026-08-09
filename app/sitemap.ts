import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const marketingUpdatedAt = new Date("2026-08-09");
  const routes: Array<{ path: string; lastModified?: Date }> = [
    { path: "", lastModified: marketingUpdatedAt },
    { path: "/steam-game-picker", lastModified: marketingUpdatedAt },
    { path: "/steam-backlog-manager", lastModified: marketingUpdatedAt },
    { path: "/steam-library-manager", lastModified: marketingUpdatedAt },
    { path: "/steam-wishlist-tracker", lastModified: marketingUpdatedAt },
    { path: "/how-it-works", lastModified: marketingUpdatedAt },
    { path: "/contact" },
    { path: "/privacy" },
    { path: "/terms" },
    { path: "/steam-data" }
  ];

  return routes.map((route) => ({
    url: `${siteConfig.url}${route.path}`,
    lastModified: route.lastModified
  }));
}
