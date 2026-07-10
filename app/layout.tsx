import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://vaultshuffle.com"),
  title: {
    default: "Vault Shuffle",
    template: "%s | Vault Shuffle"
  },
  description:
    "Vault Shuffle helps you organise your Steam library, build collections, manage your wishlist, and pick what to play next.",
  openGraph: {
    title: "Vault Shuffle",
    description:
      "Organise your Steam library, shape your collections, and unlock the right game for tonight.",
    siteName: "Vault Shuffle",
    type: "website",
    url: "https://vaultshuffle.com"
  },
  twitter: {
    card: "summary_large_image",
    title: "Vault Shuffle",
    description:
      "Organise your Steam library, shape your collections, and unlock the right game for tonight."
  },
  alternates: {
    canonical: "/"
  },
  robots: {
    index: true,
    follow: true
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
