import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

/**
 * lastModified is the date the page's content actually changed, kept by hand.
 *
 * It is tempting to generate this from the build date, but a sitemap that
 * claims every page changed on every deploy is a sitemap Google learns to
 * ignore - the signal is only worth anything while it stays honest. Update the
 * date here when you change what a page says, not when you touch its styling.
 *
 * changeFrequency and priority are deliberately absent: Google has confirmed it
 * uses neither, and both are noise in the file.
 */
const routes = [
  { path: "", lastModified: "2026-09-04" },
  { path: "/releases", lastModified: "2026-09-04" },
  { path: "/faq", lastModified: "2026-09-04" },
  { path: "/steam-data", lastModified: "2026-09-04" },
  { path: "/privacy", lastModified: "2026-09-04" },
  { path: "/terms", lastModified: "2026-09-04" },
  { path: "/contact", lastModified: "2026-09-04" }
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: `${siteConfig.url}${route.path}`,
    lastModified: new Date(route.lastModified)
  }));
}
