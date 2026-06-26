import Link from "next/link";
import { SiteFooter, SiteNav } from "@/components/SiteNav";

const heroGames = [
  { title: "Portal 2", image: "https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg" },
  { title: "Stardew Valley", image: "https://cdn.cloudflare.steamstatic.com/steam/apps/413150/header.jpg" },
  { title: "Hades", image: "https://cdn.cloudflare.steamstatic.com/steam/apps/1145360/header.jpg" },
  { title: "No Man's Sky", image: "https://cdn.cloudflare.steamstatic.com/steam/apps/275850/header.jpg" },
  { title: "Balatro", image: "https://cdn.cloudflare.steamstatic.com/steam/apps/2379780/header.jpg" },
  { title: "Celeste", image: "https://cdn.cloudflare.steamstatic.com/steam/apps/504230/header.jpg" }
];

export default function HomePage() {
  return (
    <>
      <link rel="stylesheet" href="/landing.css" />
      <SiteNav />
      <main className="home-main">
        <section className="landing-hero">
          <div className="landing-copy">
            <h1>Pick your next game without staring at your backlog all night.</h1>
            <p>
              Vault Shuffle turns a messy Steam library into a focused shortlist. Filter out the noise, roll the
              backlog, and choose something that actually fits tonight.
            </p>
          </div>

          <div className="game-wall" aria-label="Steam game artwork preview">
            {heroGames.map((game, index) => (
              <figure className={`game-poster poster-${index + 1}`} key={game.title}>
                <img src={game.image} alt="" />
                <figcaption>{game.title}</figcaption>
              </figure>
            ))}
            <div className="shuffle-orb">
              <span>Shuffle</span>
              <strong>Tonight's pick</strong>
            </div>
          </div>
        </section>
        <section className="landing-bottom-cta" aria-label="Open Vault Shuffle">
          <p>Ready to see how it feels?</p>
          <Link className="primary-action" href="/app">Open Vault Shuffle</Link>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
