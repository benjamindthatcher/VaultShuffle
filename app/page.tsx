import type { Metadata } from "next";
import Image from "next/image";
import { Suspense } from "react";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { SignInNotice } from "@/components/site/SignInNotice";
import { LandingCtaRow } from "@/components/site/LandingCtaRow";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Steam Game Picker for Your Backlog | VaultShuffle" },
  description:
    "Can't decide what to play? Connect Steam and let VaultShuffle pick a game for your time, mood, and goal—then organise your backlog.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Stop scrolling. Pick the right Steam game tonight.",
    description: siteConfig.socialDescription,
    url: "/",
    images: [{
      url: siteConfig.ogImage,
      width: 1200,
      height: 630,
      alt: "VaultShuffle — pick the right Steam game for tonight"
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Stop scrolling. Pick the right Steam game tonight.",
    description: siteConfig.socialDescription,
    images: [siteConfig.ogImage]
  }
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
    }
  ]
};

const valueProps = [
  {
    title: "1. How long have you got?",
    text: "A quick go, an evening, or a proper weekend session.",
    icon: "clock"
  },
  {
    title: "2. What headspace?",
    text: "Brain-off, chilled, or something that demands attention.",
    icon: "players"
  },
  {
    title: "3. What do you want from it?",
    text: "Start something new, finish something, or be surprised.",
    icon: "target"
  },
  {
    title: "Or skip all that",
    text: "Hit Just pick something and get a game immediately.",
    icon: "shuffle"
  }
];

function LandingIcon({ name }: { name: string }) {
  return <SiteGlyph name={name} size={26} />;
}

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c")
        }}
      />
      <link rel="stylesheet" href="/landing.css" precedence="high" />
      <main className="vs-landing">
        <section className="vs-hero" aria-labelledby="landing-title">
          <div className="vs-hero-copy">
            <p className="vs-kicker">Focused play. Better games.</p>

            <h1 id="landing-title">
              Tonight&apos;s pick.
              <span>Finally decide.</span>
            </h1>

            <p className="vs-hero-text">
              Tell Vault Shuffle how long you have, what headspace you&apos;re in, and what you want from tonight.
              It picks one game from the library you already own, and tells you why it chose it.
            </p>

            <LandingCtaRow location="hero" />

            <Suspense fallback={null}><SignInNotice /></Suspense>

            <p className="vs-cta-note">
              <LandingIcon name="lock" />
              <span>
                Steam handles the sign-in itself. VaultShuffle never sees your password — only your SteamID, so it can
                sync the games you own.
              </span>
            </p>

            <div className="vs-trust-row" role="group" aria-label="Vault Shuffle promises">
              <span>
                <LandingIcon name="shield" />
                Free forever
              </span>

              <span>
                <LandingIcon name="shield" />
                No spam
              </span>

              <span>
                <LandingIcon name="lock" />
                Private by design
              </span>

              <span>
                <LandingIcon name="players" />
                You control your data
              </span>
            </div>
          </div>

          <div className="vs-hero-visual" aria-hidden="true">
  <Image
    className="vs-stage-art"
    src="/assets/landing/futuristic-vault-hero.png"
    alt=""
    width={1672}
    height={941}
    priority
    sizes="(max-width: 1120px) 100vw, 53vw"
  />

  <article className="vs-featured-game-card">
    <Image
      className="vs-featured-game-art"
      src="https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg"
      alt=""
      width={460}
      height={215}
      unoptimized
      sizes="(max-width: 760px) 245px, 315px"
    />

    <div className="vs-featured-game-body">
      <p className="vs-featured-setup">Evening &middot; Intense &middot; Finish something</p>

      <h2>Elden Ring</h2>

      <div className="vs-featured-tags">
        <span>Ideal evening length</span>
        <span>Perfect Intense match</span>
        <span>61% complete</span>
      </div>

      <p>Picked from 184 games you already own</p>
    </div>
  </article>
</div>
        </section>

        <section className="vs-value-strip" aria-label="Why Vault Shuffle">
          {valueProps.map((item) => (
            <article className="vs-value-item" key={item.title}>
              <div className="vs-icon-box">
                <LandingIcon name={item.icon} />
              </div>

              <div>
                <h2>{item.title}</h2>
                <p>{item.text}</p>
              </div>
            </article>
          ))}
        </section>

        {/* The hero already makes the case for the Vault, so repeating it in three
            feature cards said the same thing twice at the bottom of the page. The
            closing section answers what is actually left: what it costs, whether
            you have to sign up to see it, and what happens to your Steam account. */}
        <section className="vs-closing" aria-label="What it costs and how signing in works">
          <h2 className="vs-closing-title">Free forever. No card, no trial, no upgrade.</h2>
          <p className="vs-closing-text">
            VaultShuffle does not charge for anything, and there is nothing to buy later. There is no paid tier
            waiting behind the good features, because there is no paid tier.
          </p>

          <div className="vs-closing-points">
            <article className="vs-closing-point">
              <SiteGlyph name="shield" size={26} />
              <h3>No payment, ever</h3>
              <p>Every feature is available to everyone. No card details are asked for at any point.</p>
            </article>

            <article className="vs-closing-point">
              <SiteGlyph name="guest" size={26} />
              <h3>Try it without an account</h3>
              <p>
                Guest mode runs the real thing on a catalogue of a thousand Steam games. Nothing to sign up for,
                and nothing to undo if you decide it is not for you.
              </p>
            </article>

            <article className="vs-closing-point">
              <SiteGlyph name="lock" size={26} />
              <h3>Steam handles the sign-in</h3>
              <p>
                You sign in on Steam&apos;s own page. VaultShuffle never sees your password &mdash; only your SteamID,
                so it can read the games you own.
              </p>
            </article>
          </div>

          <LandingCtaRow location="footer" layout="centred" />
        </section>
      </main>
    </>
  );
}
