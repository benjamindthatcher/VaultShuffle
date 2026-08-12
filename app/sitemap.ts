import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    "",
    "/contact",
    "/privacy",
    "/terms",
    "/steam-data"
  ];

  return routes.map((path) => ({
    url: `${siteConfig.url}${path}`
  }));
}
