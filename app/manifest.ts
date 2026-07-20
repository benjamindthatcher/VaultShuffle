import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.displayName,
    short_name: siteConfig.name,
    description: siteConfig.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#050713",
    theme_color: "#07091a",
    orientation: "any",
    categories: ["games", "entertainment", "utilities"],
    icons: [{
      src: "/icon.png",
      sizes: "1254x1254",
      type: "image/png",
      purpose: "any"
    }]
  };
}
