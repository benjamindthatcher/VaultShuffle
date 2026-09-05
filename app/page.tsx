import type { Metadata } from "next";
import { LandingExperience } from "@/components/site/LandingExperience";
import { LANDING_FAQ } from "@/components/site/landing-faq";
import { pageOpenGraph, pageTwitter, siteConfig } from "@/lib/site";

const SOCIAL_TITLE = "Stop scrolling. Pick the right Steam game tonight.";

export const metadata: Metadata = {
  title: { absolute: "Steam Game Picker for Your Backlog | VaultShuffle" },
  description:
    "Can't decide what to play? Connect Steam and let VaultShuffle pick a game for your time, mood, and goal—then organise your backlog.",
  alternates: { canonical: "/" },
  openGraph: pageOpenGraph({ url: "/", title: SOCIAL_TITLE }),
  twitter: pageTwitter({ title: SOCIAL_TITLE })
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${siteConfig.url}/#website`,
      url: siteConfig.url,
      name: siteConfig.name,
      alternateName: siteConfig.displayName,
      description: siteConfig.description,
      inLanguage: "en-GB"
    },
    {
      "@type": "Organization",
      "@id": `${siteConfig.url}/#organization`,
      name: siteConfig.name,
      url: siteConfig.url,
      logo: `${siteConfig.url}/icon.png`,
      email: siteConfig.supportEmail
    },
    {
      "@type": "WebApplication",
      "@id": `${siteConfig.url}/#application`,
      name: siteConfig.name,
      url: siteConfig.url,
      description: siteConfig.description,
      applicationCategory: "GameApplication",
      operatingSystem: "Any modern web browser",
      browserRequirements: "Requires JavaScript and a modern web browser",
      isAccessibleForFree: true,
      featureList: [
        "Steam game picker based on session, mood, and goal",
        "Steam library and backlog organisation",
        "Custom and automatic game collections",
        "Game progress, notes, and priority tracking"
      ],
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "GBP"
      },
      publisher: { "@id": `${siteConfig.url}/#organization` }
    },
    {
      "@type": "FAQPage",
      "@id": `${siteConfig.url}/#faq`,
      isPartOf: { "@id": `${siteConfig.url}/#website` },
      mainEntity: LANDING_FAQ.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer }
      }))
    }
  ]
};

/**
 * The landing page renders through a client component, because the part that
 * makes the page worth reading - pressing the three questions and watching the
 * Vault re-prime - only exists on the client. Everything a crawler needs is
 * still emitted from the server: this page's metadata, the JSON-LD graph below,
 * and the full markup of the experience via SSR.
 */
export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c")
        }}
      />
      <LandingExperience />
    </>
  );
}
