import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.displayName,
    short_name: siteConfig.name,
    description: siteConfig.description,
    start_url: "/",
    scope: "/",
    // "browser" deliberately fails Chrome's installability criteria, which require
    // standalone, fullscreen or minimal-ui. VaultShuffle is a site, not an app to
    // install, and the install prompt reads as suspicious to first-time visitors.
    // The manifest is kept for its icons and theme colour.
    display: "browser",
    background_color: "#050713",
    theme_color: "#07091a",
    categories: ["games", "entertainment", "utilities"],
    icons: [
      {
        src: "/icons/vaultshuffle-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/icons/vaultshuffle-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      }
    ]
  };
}
