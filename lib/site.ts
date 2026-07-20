import type { Metadata } from "next";

export const siteConfig = {
  name: "VaultShuffle",
  displayName: "Vault Shuffle",
  url: "https://vaultshuffle.com",
  description:
    "VaultShuffle organises your Steam library, tracks your wishlist, builds collections, and helps you decide what to play next.",
  socialDescription:
    "Cut through your Steam backlog and find the right game for your time, mood, and energy.",
  supportEmail: "support@vaultshuffle.com",
  locale: "en_GB",
  ogImage: "/assets/landing/futuristic-vault-hero.png"
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
