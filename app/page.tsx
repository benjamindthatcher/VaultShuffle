import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { SignInNotice } from "@/components/site/SignInNotice";
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

const productCards = [
  {
    title: "Vault",
    text: "Tell it how long you have, what headspace you're in and what you want from the session. It picks one game and shows its reasoning.",
    bullets: ["Matched to your session", "Told why it picked", "Reroll, or just pick something"],
    action: "Open the Vault",
    href: "/vault",
    icon: "open-vault",
    preview: "vault",
    panelTitle: "Tonight's Deck",
    rows: [
      { name: "Elden Ring", meta: "94% match", appid: 1245620 },
      { name: "Hades", meta: "88% match", appid: 1145360 },
      { name: "Hollow Knight", meta: "81% match", appid: 367520 },
      { name: "Stardew Valley", meta: "76% match", appid: 413150 }
    ]
  },
  {
    title: "Purge",
    text: "Work out what you have actually finished, what you quietly abandoned, and what deserves another look.",
    bullets: ["Likely completed", "Abandoned", "Still worth reviewing"],
    action: "Review your backlog",
    href: "/purge",
    icon: "ready-to-review",
    preview: "purge",
    panelTitle: "Ready to Review",
    rows: [
      { name: "Cyberpunk 2077", meta: "Likely Completed", appid: 1091500 },
      { name: "Far Cry 5", meta: "Abandoned", appid: 552520 },
      { name: "Prey", meta: "Abandoned", appid: 480490 },
      { name: "Dishonored 2", meta: "The Rest", appid: 403640 }
    ]
  },
  {
    title: "Library",
    text: "All your games in one clean, powerful view.",
    bullets: ["Filter and sort", "Track playtime", "See what's next"],
    action: "Explore Library",
    href: "/library",
    icon: "books",
    preview: "library",
    panelTitle: "All Games",
    rows: [
      { name: "Elden Ring", meta: "292h", appid: 1245620 },
      { name: "Baldur's Gate 3", meta: "215h", appid: 1086940 },
      { name: "Cyberpunk 2077", meta: "80h", appid: 1091500 },
      { name: "Red Dead Redemption 2", meta: "43h", appid: 1174180 }
    ]
  }
];

function steamCapsule(appid: number) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`;
}

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

            <div className="vs-cta-row" role="group" aria-label="Get started">
              <a className="vs-cta vs-cta-primary" href="/api/auth/steam">
                <span className="vs-cta-icon"><LandingIcon name="steam" /></span>
                <span className="vs-cta-label">Continue with Steam</span>
                <span className="vs-cta-arrow" aria-hidden="true">&rarr;</span>
              </a>

              <Link className="vs-cta vs-cta-secondary" href="/vault">
                <LandingIcon name="guest" />
                Try Guest Mode
              </Link>
            </div>

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

        <section className="vs-product-grid" aria-label="Vault Shuffle features">
          {productCards.map((card) => (
            <article className="vs-product-card" key={card.title}>
              <div className="vs-product-copy">
                <div className="vs-product-title">
                  <LandingIcon name={card.icon} />
                  <h2>{card.title}</h2>
                </div>

                <p>{card.text}</p>

                <ul>
                  {card.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>

                <Link href={card.href}>
                  {card.action} <span aria-hidden="true">&rarr;</span>
                </Link>
              </div>

              <div className={`vs-mini-panel vs-mini-${card.preview}`} aria-hidden="true">
                <h3>{card.panelTitle}</h3>

                {card.preview === "library" && <div className="vs-mini-search">Filter library...</div>}

                {card.rows.map((row) => (
                  <div className="vs-mini-row" key={row.name}>
                    <Image
                      src={steamCapsule(row.appid)}
                      alt=""
                      unoptimized
                      width={231}
                      height={87}
                      sizes="46px"
                    />

                    <strong>{row.name}</strong>

                    {row.meta && <small>{row.meta}</small>}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
