const shortlistGames = [
  {
    title: "Baldur's Gate 3",
    genre: "RPG",
    image: "https://cdn.cloudflare.steamstatic.com/steam/apps/1086940/header.jpg"
  },
  {
    title: "Hades",
    genre: "Roguelike",
    image: "https://cdn.cloudflare.steamstatic.com/steam/apps/1145360/header.jpg"
  },
  {
    title: "Disco Elysium",
    genre: "RPG",
    image: "https://cdn.cloudflare.steamstatic.com/steam/apps/632470/header.jpg"
  },
  {
    title: "Stardew Valley",
    genre: "Life Sim",
    image: "https://cdn.cloudflare.steamstatic.com/steam/apps/413150/header.jpg"
  },
  {
    title: "Portal 2",
    genre: "Puzzle",
    image: "https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg"
  }
];

const libraryRows = [
  ["Elden Ring", "290h", "https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg"],
  ["Baldur's Gate 3", "215h", "https://cdn.cloudflare.steamstatic.com/steam/apps/1086940/header.jpg"],
  ["Cyberpunk 2077", "80h", "https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/header.jpg"],
  ["Red Dead Redemption 2", "Adventure", "https://cdn.cloudflare.steamstatic.com/steam/apps/1174180/header.jpg"]
];

const wishlistRows = [
  ["Hollow Knight", "Must Play", "https://cdn.cloudflare.steamstatic.com/steam/apps/367520/header.jpg"],
  ["Persona 5 Royal", "High", "https://cdn.cloudflare.steamstatic.com/steam/apps/1687950/header.jpg"],
  ["Stardew Valley", "Medium", "https://cdn.cloudflare.steamstatic.com/steam/apps/413150/header.jpg"],
  ["Sekiro: Shadows Die Twice", "Medium", "https://cdn.cloudflare.steamstatic.com/steam/apps/814380/header.jpg"]
];

const collectionRows = [
  ["Backlog Essentials", "8 games", "https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg"],
  ["Co-op Nights", "12 games", "https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg"],
  ["Strategy Sessions", "9 games", "https://cdn.cloudflare.steamstatic.com/steam/apps/1142710/header.jpg"],
  ["Cozy & Chill", "7 games", "https://cdn.cloudflare.steamstatic.com/steam/apps/413150/header.jpg"]
];

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
    text: "Your data stays yours, always.",
    icon: "shield"
  }
];

const productCards = [
  {
    title: "Library",
    text: "All your games in one clean, powerful view.",
    bullets: ["Filter and sort", "Track playtime", "See what's next"],
    action: "Explore Library",
    rows: libraryRows,
    icon: "books"
  },
  {
    title: "Wishlist",
    text: "Turn endless wishlists into your next obsession.",
    bullets: ["Track discounts", "Prioritize picks", "Never lose a gem"],
    action: "Explore Wishlist",
    rows: wishlistRows,
    icon: "bookmark"
  },
  {
    title: "Collections",
    text: "Create custom collections for any mood.",
    bullets: ["Build your themes", "Tag what matters", "Shuffle your way"],
    action: "Explore Collections",
    rows: collectionRows,
    icon: "layers"
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
            <img src="/assets/landing/vaultshuffle-logo.png" alt="" />
            <span>Vault <strong>Shuffle</strong></span>
          </a>
          <div className="vs-nav-links">
            <a href="/about">About</a>
            <a className="vs-open-link" href="/app">
              Open Vault Shuffle <span aria-hidden="true">&rarr;</span>
            </a>
          </div>
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
                <LandingIcon name="players" />
                Try Guest Mode
              </a>
            </div>
            <div className="vs-trust-row" aria-label="Vault Shuffle promises">
              <span>No spam</span>
              <span>Private &amp; local</span>
              <span>You control your data</span>
            </div>
          </div>

          <div className="vs-hero-visual" aria-hidden="true">
            <img className="vs-stage-art" src="/assets/landing/landing-vault-stage.png" alt="" />
            <article className="vs-tonight-card">
              <span>Tonight&apos;s pick</span>
              <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg" alt="" />
              <h2>Elden Ring</h2>
              <div className="vs-pill-row">
                <small>RPG</small>
                <small>Open World</small>
                <small>Soul-like</small>
              </div>
              <p>Recommended based on your library &amp; playtime</p>
            </article>
            <aside className="vs-shortlist">
              <h2>Shortlist</h2>
              {shortlistGames.map((game) => (
                <div className="vs-shortlist-row" key={game.title}>
                  <img src={game.image} alt="" />
                  <div>
                    <strong>{game.title}</strong>
                    <span>{game.genre}</span>
                  </div>
                </div>
              ))}
              <a href="/app">See Full Shortlist <span aria-hidden="true">&rarr;</span></a>
            </aside>
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

        <section className="vs-product-grid" aria-label="Vault Shuffle areas">
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
                <a href="/app">{card.action} <span aria-hidden="true">&rarr;</span></a>
              </div>
              <div className="vs-mini-panel" aria-hidden="true">
                <h3>{card.title === "Library" ? "All Games" : card.title === "Wishlist" ? "Your Wishlist (32)" : "Your Collections"}</h3>
                {card.rows.map(([title, meta, image]) => (
                  <div className="vs-mini-row" key={title}>
                    <img src={image} alt="" />
                    <span>{title}</span>
                    <small>{meta}</small>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>

        <footer className="vs-footer">
          <span>Your library stays yours. Steam sign-in is only used to import your games.</span>
        </footer>
      </main>
    </>
  );
}
