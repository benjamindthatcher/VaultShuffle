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
  ogImage: "/opengraph-image"
} as const;

export const privateProductRobots: Metadata["robots"] = {
  index: false,
  follow: true,
  googleBot: {
    index: false,
    follow: true,
    noimageindex: true
  }
};
