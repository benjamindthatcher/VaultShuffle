import Link from "next/link";
import { SiteFooter, SiteNav } from "@/components/SiteNav";

export default function HomePage() {
  return (
    <>
      <link rel="stylesheet" href="/landing.css" />
      <SiteNav />
      <main>
        <section className="hero">
          <div className="hero-copy">
            <img className="hero-logo" src="/assets/vault-shuffle-icon.png" alt="" />
            <h1>Pick your next game without staring at your backlog all night.</h1>
            <p>
              Sign in with Steam, bring your library into a proper database, and let Vault Shuffle surface the game
              that actually fits tonight instead of another hour of staring at the list.
            </p>
            <div className="hero-actions">
              <Link className="primary-action" href="/login">
                Open Vault Shuffle
              </Link>
              <a className="secondary-action" href="#how-it-works">
                See how it works
              </a>
            </div>
            <div className="proof-strip" aria-label="Current product details">
              <span>Steam library import</span>
              <span>Private Supabase rows</span>
              <span>Mood and time shuffle</span>
            </div>
          </div>

          <div className="hero-product" aria-label="Vault Shuffle product preview">
            <div className="preview-glow" />
            <div className="preview-shell">
              <div className="preview-topbar">
                <span />
                <span />
                <span />
                <strong>Tonight&apos;s pick</strong>
              </div>
              <div className="preview-layout">
                <aside className="preview-side">
                  <b>Library</b>
                  <span>Steam games</span>
                  <span>Progress states</span>
                  <span>Playtime tracked</span>
                </aside>
                <section className="preview-main">
                  <div className="pick-card">
                    <div className="card-stack">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div>
                      <strong>Tonight&apos;s shortlist</strong>
                      <p>Owned, unfinished, under 3 hours, with Steam artwork.</p>
                    </div>
                    <button>Shuffle</button>
                  </div>
                  <div className="fake-table">
                    <span className="active" />
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                </section>
                <aside className="preview-detail">
                  <div className="art-card" />
                  <b>Selected game</b>
                  <span>Ready when you are.</span>
                </aside>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="section-band">
          <div className="section-heading">
            <h2>How It Works</h2>
            <p>Built around the actual decisions you make before playing, not a fake productivity dashboard.</p>
          </div>
          <div className="steps">
            <article>
              <span>01</span>
              <h3>Sign in with Steam</h3>
              <p>Steam confirms your SteamID64, then Vault Shuffle keeps your product session in Supabase.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Filter by the night</h3>
              <p>Hide completed games, search the library, sort by playtime, and keep the list inside the app.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Shuffle the vault</h3>
              <p>Get a focused pick from your actual backlog, with the Steam cover, progress, notes, and next actions.</p>
            </article>
          </div>
        </section>

        <section className="feature-grid">
          <article>
            <h2>Made for big libraries</h2>
            <p>The game list has its own scroll area, so a serious backlog stays contained inside a normal window.</p>
          </article>
          <article>
            <h2>Steam artwork included</h2>
            <p>Games with Steam AppIDs pull public artwork, and new games can be found through Steam store search.</p>
          </article>
          <article>
            <h2>Database backed</h2>
            <p>Users, sessions, games, settings, and recommendation history live in Supabase Postgres.</p>
          </article>
          <article>
            <h2>Built to choose</h2>
            <p>The whole point is the decision: less scrolling, less guilt, more actually launching something.</p>
          </article>
        </section>

        <section className="product-proof">
          <div>
            <h2>Built around the moment before you press Play.</h2>
            <p>
              Vault Shuffle is not trying to become another spreadsheet. It remembers your Steam library, keeps your
              finished games out of the way, and gives the shuffle enough context to make a useful pick.
            </p>
            <Link className="secondary-action" href="/features">
              Explore features
            </Link>
          </div>
          <div className="workflow-card" aria-label="Vault Shuffle workflow">
            <div className="workflow-head">
              <img src="/assets/vault-shuffle-icon.png" alt="" />
              <span>Tonight&apos;s vault</span>
            </div>
            <div className="workflow-steps">
              <span>Steam sign-in verified</span>
              <span>Owned games imported</span>
              <span>Completed games hidden</span>
              <span>Shuffle narrowed by vibe</span>
            </div>
            <div className="workflow-pick">
              <small>Suggested next</small>
              <strong>A game that fits a 90-minute evening</strong>
            </div>
          </div>
        </section>

        <section className="final-cta">
          <h2>Your next game is already in the vault.</h2>
          <p>Open the app, roll the backlog, and let one game step forward.</p>
          <Link className="primary-action" href="/login">
            Launch Vault Shuffle
          </Link>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
