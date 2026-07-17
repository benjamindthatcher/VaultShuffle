import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteExperience } from "@/components/site/SiteExperience";
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
    url: "https://vaultshuffle.com",
    images: [{
      url: "/assets/vault/vault-stage-closed.png",
      width: 1536,
      height: 864,
      alt: "The Vault Shuffle game vault"
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Vault Shuffle",
    description:
      "Organise your Steam library, shape your collections, and unlock the right game for tonight.",
    images: ["/assets/vault/vault-stage-closed.png"]
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
        <SiteExperience>{children}</SiteExperience>
      </body>
    </html>
  );
}
