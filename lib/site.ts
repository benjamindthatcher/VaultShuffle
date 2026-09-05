import type { Metadata } from "next";

export const siteConfig = {
  name: "VaultShuffle",
  displayName: "Vault Shuffle",
  url: "https://vaultshuffle.com",
  description:
    "A free Steam game picker and backlog manager that helps you choose what to play based on your time, mood, goal, genres, and collections.",
  socialDescription:
    "Stop scrolling through your Steam backlog. Pick the right game for your time, mood, and energy.",
  supportEmail: "support@vaultshuffle.com",
  locale: "en_GB",
  ogImage: "/opengraph-image",
  ogImageAlt: "VaultShuffle — pick the right Steam game for tonight"
} as const;

/**
 * Next merges metadata field by field, not deeply. A page that declares
 * `openGraph` replaces the root layout's object outright instead of adding to
 * it, so every page that set only `openGraph.url` was shipping without
 * og:type, og:site_name, og:locale and - on the legal and contact pages - any
 * og:image at all, which is why those pages shared as bare text links. Build
 * page-level Open Graph through this helper so the shared fields survive.
 */
export function pageOpenGraph(input: {
  url: string;
  title?: string;
  description?: string;
  imageAlt?: string;
}): Metadata["openGraph"] {
  return {
    type: "website",
    siteName: siteConfig.name,
    locale: siteConfig.locale,
    url: input.url,
    ...(input.title ? { title: input.title } : {}),
    description: input.description ?? siteConfig.socialDescription,
    images: [{
      url: siteConfig.ogImage,
      width: 1200,
      height: 630,
      alt: input.imageAlt ?? siteConfig.ogImageAlt
    }]
  };
}

/**
 * Twitter has the same replace-not-merge behaviour. Pages that never set it
 * inherit the root card, which carries the landing page's title regardless of
 * which page is being shared.
 */
export function pageTwitter(input: {
  title?: string;
  description?: string;
}): Metadata["twitter"] {
  return {
    card: "summary_large_image",
    ...(input.title ? { title: input.title } : {}),
    description: input.description ?? siteConfig.socialDescription,
    images: [siteConfig.ogImage]
  };
}

export const privateProductRobots: Metadata["robots"] = {
  index: false,
  follow: true,
  googleBot: {
    index: false,
    follow: true,
    noimageindex: true
  }
};
