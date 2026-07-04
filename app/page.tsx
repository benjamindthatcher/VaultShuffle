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
    text: "Your data stays local and always private.",
    icon: "shield"
  }
];

const productCards = [
  {
    title: "Library",
    text: "All your games in one clean, powerful view.",
    bullets: ["Filter and sort", "Track playtime", "See what's next"],
    action: "Explore Library",
    icon: "books",
    preview: "library",
    rows: [
      ["Game Horizon", "120h"],
      ["Neon Frontiers", "85h"],
      ["Shattered Skies", "60h"],
      ["Echoes of Ruin", "45h"],
      ["Beyond the Gate", "30h"]
    ]
  },
  {
    title: "Wishlist",
    text: "Turn endless wishlists into your next obsession.",
    bullets: ["Track discounts", "Prioritise picks", "Never lose a gem"],
    action: "Explore Wishlist",
    icon: "bookmark",
    preview: "wishlist",
    rows: [
      ["Astral Divide", ""],
      ["Silent Vector", ""],
      ["Project Aurora", ""],
      ["Void Runner", ""],
      ["Crimson Tides", ""]
    ]
  },
  {
    title: "Collections",
    text: "Create custom collections for any mood.",
    bullets: ["Build your themes", "Tag what matters", "Shuffle your way"],
    action: "Explore Collections",
    icon: "layers",
    preview: "collections",
    rows: [
      ["Backlog Essentials", "12 games"],
      ["Co-op Nights", "8 games"],
      ["Story Rich", "15 games"],
      ["Quick Plays", "10 games"],
      ["Chill & Relax", "7 games"]
    ]
  }
];

function LandingIcon({ name }: { name: string }) {
  const shared = {
    width: 26,
    height: 26,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  if (name === "steam") {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="15.8" cy="8.2" r="2.5" />
        <circle cx="8.3" cy="15.6" r="2.2" />
        <path d="m10.1 14.4 3.7-4.3" />
        <path d="m6.2 14.7 2.2 1.1" />
      </svg>
    );
  }

  if (name === "guest") {
    return (
      <svg {...shared}>
        <path d="M8 18v-1.2A3.8 3.8 0 0 1 11.8 13h.4a3.8 3.8 0 0 1 3.8 3.8V18" />
        <circle cx="12" cy="8" r="3" />
        <path d="M4 7v5" />
        <path d="M2.5 9.5h3" />
        <path d="M20 7v5" />
        <path d="M18.5 9.5h3" />
      </svg>
    );
  }

  if (name === "clock") {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </svg>
    );
  }

  if (name === "players") {
    return (
      <svg {...shared}>
        <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-1A3.5 3.5 0 0 0 8 17.5V19" />
        <circle cx="12" cy="8" r="3" />
        <path d="M20 19v-1a3 3 0 0 0-2.2-2.9" />
        <path d="M16.8 5.2a3 3 0 0 1 0 5.6" />
      </svg>
    );
  }

  if (name === "shield") {
    return (
      <svg {...shared}>
        <path d="M12 3 5 6v5c0 4.3 2.8 8.2 7 10 4.2-1.8 7-5.7 7-10V6l-7-3Z" />
        <path d="m9 12 2 2 4-5" />
      </svg>
    );
  }

  if (name === "lock") {
    return (
      <svg {...shared}>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    );
  }

  if (name === "books") {
    return (
      <svg {...shared}>
        <path d="M5 4h4v16H5z" />
        <path d="M11 4h4v16h-4z" />
        <path d="m17 5 3 14" />
      </svg>
    );
  }

  if (name === "bookmark") {
    return (
      <svg {...shared}>
        <path d="M6 4h12v17l-6-4-6 4V4Z" />
      </svg>
    );
  }

  if (name === "layers") {
    return (
      <svg {...shared}>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 12 9 5 9-5" />
        <path d="m3 16 9 5 9-5" />
      </svg>
    );
  }

  if (name === "folder") {
    return (
      <svg {...shared}>
        <path d="M3 7.5h6l2 2h10v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
    );
  }

  return (
    <svg {...shared}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <>
      <link rel="stylesheet" href="/landing.css" />
      <main className="vs-landing">
        <nav className="vs-nav" aria-label="Vault Shuffle">
          <a className="vs-brand" href="/" aria-label="Vault Shuffle home">
            <img src="/assets/landing/vaultshuffle-logo-real.png" alt="" />
            <span>Vault <strong>Shuffle</strong></span>
          </a>
          <a className="vs-open-link" href="/app">
            Open Vault Shuffle <span aria-hidden="true">&rarr;</span>
          </a>
        </nav>

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
                <LandingIcon name="steam" />
                Continue with Steam
                <span aria-hidden="true">&rarr;</span>
              </a>
              <a className="vs-cta vs-cta-secondary" href="/app">
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
                Private &amp; local
              </span>
              <span>
                <LandingIcon name="players" />
                You control your data
              </span>
            </div>
          </div>

          <div className="vs-hero-visual" aria-hidden="true">
            <img className="vs-stage-art" src="/assets/landing/futuristic-vault-hero.png" alt="" />
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
                <a href="/app">
                  {card.action} <span aria-hidden="true">&rarr;</span>
                </a>
              </div>

              <div className={`vs-mini-panel vs-mini-${card.preview}`} aria-hidden="true">
                <h3>
                  {card.preview === "library"
                    ? "All Games"
                    : card.preview === "wishlist"
                      ? "Your Wishlist (5)"
                      : "Your Collections"}
                </h3>
                {card.preview === "library" && <div className="vs-mini-search">Filter library...</div>}
                {card.rows.map(([label, meta]) => (
                  <div className="vs-mini-row" key={label}>
                    <span className={card.preview === "collections" ? "vs-folder-mark" : "vs-thumb"} />
                    <strong>{label}</strong>
                    {meta && <small>{meta}</small>}
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
