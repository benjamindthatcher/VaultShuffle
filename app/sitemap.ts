import type { MetadataRoute } from "next";
import { listPosts } from "@/lib/blog/posts";
import { siteConfig } from "@/lib/site";

<<<<<<< Updated upstream
export default function sitemap(): MetadataRoute.Sitemap {
  const routes: Array<{
    path: string;
    changeFrequency: "weekly" | "monthly" | "yearly";
    priority: number;
  }> = [
    { path: "", changeFrequency: "weekly", priority: 1 },
    { path: "/contact", changeFrequency: "monthly", priority: 0.6 },
    { path: "/privacy", changeFrequency: "yearly", priority: 0.4 },
    { path: "/terms", changeFrequency: "yearly", priority: 0.4 },
    { path: "/steam-data", changeFrequency: "yearly", priority: 0.5 }
  ];

  return routes.map((route) => ({
=======
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
  { path: "/blog", lastModified: "2026-09-17" },
  { path: "/releases", lastModified: "2026-09-04" },
  { path: "/faq", lastModified: "2026-09-04" },
  { path: "/steam-data", lastModified: "2026-09-04" },
  { path: "/privacy", lastModified: "2026-09-17" },
  { path: "/terms", lastModified: "2026-09-04" },
  { path: "/contact", lastModified: "2026-09-04" }
] as const;

/**
 * Posts carry their own dates, so they are generated rather than listed. A
 * scheduled post is absent until its date passes; this window is how it gets
 * in without a deploy, and it matches the blog index's.
 */
export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = routes.map((route) => ({
>>>>>>> Stashed changes
    url: `${siteConfig.url}${route.path}`,
    changeFrequency: route.changeFrequency,
    priority: route.priority
  }));

  const postRoutes = listPosts().map((post) => ({
    url: `${siteConfig.url}/blog/${post.slug}`,
    lastModified: new Date(`${post.updated ?? post.published}T00:00:00Z`)
  }));

  return [...staticRoutes, ...postRoutes];
}
