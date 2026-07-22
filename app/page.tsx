import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { getCurrentSession } from "@/lib/auth";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "VaultShuffle | Decide What to Play Next" },
  description: siteConfig.description,
  alternates: { canonical: "/" },
  openGraph: {
    title: "VaultShuffle | Decide What to Play Next",
    description: siteConfig.socialDescription,
    url: "/"
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
    title: "Curated surprises",
    text: "Smart picks from your library, made just for you.",
    icon: "target"
  },
  {
    title: "Save time",
    text: "Find the right game without endless searching.",
    icon: "clock"
  },
  {
    title: "Built for players",
    text: "Designed by gamers who value your time.",
    icon: "players"
  },
  {
    title: "100% in your control",
    text: "Your data stays under your control.",
    icon: "shield"
  }
];

const productCards = [
  {
    title: "Library",
    text: "All your games in one clean, powerful view.",
    bullets: ["Filter and sort", "Track playtime", "See what's next"],
    action: "Explore Library",
    href: "/library",
    icon: "books",
    preview: "library",
    rows: [
      {
        name: "Elden Ring",
        meta: "292h",
        appid: 1245620
      },
      {
        name: "Baldur's Gate 3",
        meta: "215h",
        appid: 1086940
      },
      {
        name: "Cyberpunk 2077",
        meta: "80h",
        appid: 1091500
      },
      {
        name: "Red Dead Redemption 2",
        meta: "43h",
        appid: 1174180
      }
    ]
  },
  {
    title: "Wishlist",
    text: "Turn endless wishlists into your next obsession.",
    bullets: ["Track discounts", "Prioritise picks", "Never lose a gem"],
    action: "Explore Wishlist",
    href: "/wishlist",
    icon: "bookmark",
    preview: "wishlist",
    rows: [
      {
        name: "Hollow Knight",
        meta: "-25%",
        appid: 367520
      },
      {
        name: "Persona 5 Royal",
        meta: "-40%",
        appid: 1687950
      },
      {
        name: "Stardew Valley",
        meta: "-30%",
        appid: 413150
      },
      {
        name: "Sekiro™: Shadows Die Twice",
        meta: "-20%",
        appid: 814380
      }
    ]
  },
  {
    title: "Collections",
    text: "Create custom collections for any mood.",
    bullets: ["Build your themes", "Tag what matters", "Shuffle your way"],
    action: "Explore Collections",
    href: "/collections",
    icon: "layers",
    preview: "collections",
    rows: [
      {
        name: "Backlog Essentials",
        meta: "8 games",
        appids: [1245620, 1086940, 632470]
      },
      {
        name: "Co-op Nights",
        meta: "12 games",
        appids: [1172470, 239140, 548430]
      },
      {
        name: "Strategy Sessions",
        meta: "9 games",
        appids: [1142710, 289070, 1158310]
      },
      {
        name: "Cozy & Chill",
        meta: "7 games",
        appids: [413150, 1158160, 1472660]
      }
    ]
  }
];

function steamCapsule(appid: number) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg`;
}

function LandingIcon({ name }: { name: string }) {
  return <SiteGlyph name={name} size={26} />;
}

export default async function HomePage() {
  const session = await getCurrentSession();
  if (session) redirect("/vault");

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
              Vault Shuffle cuts through the noise and helps you find the one game that fits your mood, time, and
              energy.
            </p>

            <div className="vs-cta-row" aria-label="Get started">
              <a className="vs-cta vs-cta-primary" href="/login">
                <span className="vs-cta-icon"><LandingIcon name="steam" /></span>
                <span className="vs-cta-label">Continue with Steam</span>
                <span className="vs-cta-arrow" aria-hidden="true">&rarr;</span>
              </a>

              <a className="vs-cta vs-cta-secondary" href="/vault">
                <LandingIcon name="guest" />
                Try Guest Mode
              </a>
            </div>

            <div className="vs-trust-row" aria-label="Vault Shuffle promises">
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
  <img className="vs-stage-art" src="/assets/landing/futuristic-vault-hero.png" alt="" />

  <article className="vs-featured-game-card">
    <img
      className="vs-featured-game-art"
      src="https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg"
      alt=""
    />

    <div className="vs-featured-game-body">
      <h2>Elden Ring</h2>

      <div className="vs-featured-tags">
        <span>RPG</span>
        <span>Open World</span>
        <span>Soulslike</span>
      </div>

      <p>Recommended based on your library &amp; playtime</p>
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

                <a href={card.href}>
                  {card.action} <span aria-hidden="true">&rarr;</span>
                </a>
              </div>

              <div className={`vs-mini-panel vs-mini-${card.preview}`} aria-hidden="true">
                <h3>
                  {card.preview === "library"
                    ? "All Games"
                    : card.preview === "wishlist"
                      ? "Your Wishlist (32)"
                      : "Your Collections"}
                </h3>

                {card.preview === "library" && <div className="vs-mini-search">Filter library...</div>}

                {card.rows.map((row) => (
                  <div className="vs-mini-row" key={row.name}>
                    {"appids" in row ? (
                      <span className="vs-collection-stack">
                        {row.appids.map((appid) => (
                          <img key={appid} src={steamCapsule(appid)} alt="" />
                        ))}
                      </span>
                    ) : (
                      <img src={steamCapsule(row.appid)} alt="" />
                    )}

                    <strong>{row.name}</strong>

                    {row.meta && <small>{row.meta}</small>}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
	<div className="vs-data-note">
	<LandingIcon name="lock" />
	<span>Steam handles sign-in securely. Vault Shuffle never sees your Steam password or login details.</span>
        </div>
      </main>
    </>
  );
}
