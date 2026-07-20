import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteExperience } from "@/components/site/SiteExperience";
import { siteConfig } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  applicationName: siteConfig.name,
  title: {
    default: "VaultShuffle | Decide What to Play Next",
    template: "%s | VaultShuffle"
  },
  description: siteConfig.description,
  keywords: [
    "Steam library manager",
    "Steam backlog",
    "game picker",
    "what game should I play",
    "Steam wishlist tracker",
    "game collections"
  ],
  authors: [{ name: siteConfig.name, url: siteConfig.url }],
  creator: siteConfig.name,
  publisher: siteConfig.name,
  category: "gaming",
  referrer: "origin-when-cross-origin",
  formatDetection: {
    email: false,
    address: false,
    telephone: false
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "VaultShuffle | Decide What to Play Next",
    description: siteConfig.socialDescription,
    siteName: siteConfig.name,
    type: "website",
    url: siteConfig.url,
    locale: siteConfig.locale,
    images: [{
      url: siteConfig.ogImage,
      width: 1672,
      height: 941,
      alt: "VaultShuffle game recommendation vault"
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: "VaultShuffle | Decide What to Play Next",
    description: siteConfig.socialDescription,
    images: [siteConfig.ogImage]
  },
  alternates: {
    canonical: "/"
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1
    }
  },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
    other: process.env.BING_SITE_VERIFICATION
      ? { "msvalidate.01": process.env.BING_SITE_VERIFICATION }
      : undefined
  }
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#07091a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <SiteExperience>{children}</SiteExperience>
      </body>
    </html>
  );
}
