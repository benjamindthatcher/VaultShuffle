import { Suspense } from "react";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { LandingFaq } from "@/components/site/LandingFaq";
import { LandingCtas } from "@/components/site/LandingCtas";
import { LandingResultDemo } from "@/components/site/LandingResultDemo";
import { LandingVaultDraw } from "@/components/site/LandingVaultDraw";
import { SignInNotice } from "@/components/site/SignInNotice";
import styles from "./landing-experience.module.css";

const WHY_POINTS = [
  {
    icon: "clock",
    title: "Made for the time you have",
    text: "A quick session and a free weekend should lead to different games. The Vault starts with the kind of time you actually have."
  },
  {
    icon: "target",
    title: "Right game, right mood",
    text: "Brain Off, Chill or Intense. Your headspace and goal point the Vault toward a game that fits the night you want."
  },
  {
    icon: "in-progress",
    title: "Your progress has a purpose",
    text: "Starting fresh and finishing strong call for different games. Your progress helps the Vault know which kind fits tonight."
  },
  {
    icon: "smart-collections",
    title: "Learns without boxing you in",
    text: "As you use it, the Vault can get a better sense of what lands for you—without trapping you in more of the same."
  }
];

/**
 * The landing page.
 *
 * This component is deliberately not a client component. Three things on the
 * page respond to a click - the two CTA pairs, the question rail, and the example
 * card actions - and each of those is its own island. Everything else is
 * text and artwork, so it ships as markup with no JavaScript attached to it.
 */
export function LandingExperience() {
  return (
    <main data-vault-controls="standard" id="top" className={styles.page}>
      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>Focused play. Better games.</p>
          <h1 id="landing-title">Tonight&apos;s pick.<span>Finally decide.</span></h1>
          <p className={styles.heroText}>
            Your next game is probably already in your Steam library. Choose a session, mood and goal.
            The Vault scores the eligible games, picks from the best fits and explains every pick.
          </p>
          <LandingCtas location="hero" />
          {/* A failed Steam callback redirects back here with ?signin=...; with
              nothing rendering it the sign-in silently appears to do nothing.
              Suspense keeps useSearchParams from making the whole page dynamic. */}
          <Suspense fallback={null}><SignInNotice className={styles.signInNotice} /></Suspense>
        </div>

        <div className={styles.heroExample}><LandingResultDemo /></div>
      </section>

      <section id="how" className={styles.howSection} aria-labelledby="how-title">
        <div className={styles.sectionIntro}>
          <h2 id="how-title">Three questions.<span>One game.</span></h2>
          <p>Set the moment. The Vault handles the shortlist.</p>
        </div>
        {/* The Vault itself, not an illustration of it. Same accordion, same
            scoring, same weighted draw - on a sample library, because there is
            no account here to draw from. */}
        <LandingVaultDraw />
      </section>

      <section id="why" className={styles.whySection} aria-labelledby="why-title">
        <div className={styles.sectionIntro}>
          <h2 id="why-title">The draw is only<span>the last step.</span></h2>
          <p>Before a game is picked, your session, mood, goal and progress shape the deck.</p>
        </div>
        <div className={styles.logicFlow} aria-label="How a recommendation is selected">
          <article data-vault-card="surface"><span><SiteGlyph name="library" size={26} /></span><div><small>Example library</small><strong>184 owned games</strong></div></article>
          <article data-vault-card="surface"><span><SiteGlyph name="session" size={26} /></span><div><small>The moment</small><strong className={styles.momentValue}>Evening · Intense · Finish Something</strong></div></article>
          <article data-vault-card="surface"><span><SiteGlyph name="shuffle" size={26} /></span><div><small>Best-fit deck</small><strong>Up to 64 games</strong></div></article>
          <article data-vault-card="surface"><span><SiteGlyph name="play-now" size={26} /></span><div><small>Your pick</small><strong>Elden Ring</strong></div></article>
        </div>
        <div className={styles.whyGrid}>
          {WHY_POINTS.map((point) => (
            <article key={point.title}>
              <span><SiteGlyph name={point.icon} size={24} /></span>
              <div><h3>{point.title}</h3><p>{point.text}</p></div>
            </article>
          ))}
        </div>
        <blockquote><SiteGlyph name="new" size={24} />More personal over time—without losing the surprise.</blockquote>
      </section>

      <LandingFaq />

      <section id="start" className={styles.closing} aria-labelledby="closing-title">
        <div>
          <h2 id="closing-title">Free forever.<span>No card, no trial, no paid tier.</span></h2>
          <p>Explore as a guest, sign in with Steam, or bring a public library by profile URL. VaultShuffle never sees your password.</p>
        </div>
        <LandingCtas location="footer" compact />
      </section>
    </main>
  );
}
