import Image from "next/image";
import { Suspense } from "react";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { LandingFaq } from "@/components/site/LandingFaq";
import { LandingCtas } from "@/components/site/LandingCtas";
import { LandingQuestions } from "@/components/site/LandingQuestions";
import { LandingResultDemo } from "@/components/site/LandingResultDemo";
import { SignInNotice } from "@/components/site/SignInNotice";
import styles from "./landing-experience.module.css";

const PROOF_POINTS = [
  { icon: "sync", title: "Steam library imported for you", note: "No manual backlog entry" },
  { icon: "session", title: "Picks that fit the moment", note: "Not one you've completed or set aside" },
  { icon: "details", title: "Explains every pick", note: "See why a game made the cut" },
  { icon: "surprise", title: "Free forever", note: "No card · No subscription · No paid tier" }
];

const WHY_POINTS = [
  {
    icon: "clock",
    title: "Made for the time you have",
    text: "A quick session and a free weekend should lead to different games. The Vault starts with the kind of time you actually have."
  },
  {
    icon: "target",
    title: "Right game, right mood",
    text: "Brain-Off, Chill or Intense—your headspace and goal point the Vault toward a game that fits the night you want."
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

function HeroResultCard() {
  return (
    <article className={styles.heroResult} aria-label="Example VaultShuffle recommendation">
      <span className={styles.heroResultArt}>
        <Image
          src="https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg"
          alt="Elden Ring"
          fill
          priority
          unoptimized
          sizes="(max-width: 760px) 82vw, 380px"
        />
      </span>
      <div className={styles.heroResultBody}>
        <p>Evening · Intense · Finish Something</p>
        <h2>Elden Ring</h2>
        {/* What the Vault shows under a pick: how long the game takes and how far
            in you already are. 61h of 100h is the 61% the bar below reports. */}
        <p className={styles.heroResultMeta}>
          <SiteGlyph name="clock" size={14} />
          <span className={styles.heroResultMetaLead}>100h estimated</span>
          <span>· 61h played</span>
        </p>
        <div className={styles.heroProgress} aria-label="61% complete"><span /></div>
        <small><span><strong>61%</strong> complete</span><span>Example pool · 184 games</span></small>
      </div>
    </article>
  );
}

/**
 * The landing page.
 *
 * This component is deliberately not a client component. Three things on the
 * page respond to a click - the two CTA pairs, the question rail, and Pin/Snooze
 * on the example card - and each of those is its own island. Everything else is
 * text and artwork, so it ships as markup with no JavaScript attached to it.
 */
export function LandingExperience() {
  return (
    <main id="top" className={styles.page}>
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
          <p className={styles.securityNote}><SiteGlyph name="shield" size={18} />Sign in with Steam or use a public profile URL. VaultShuffle never sees your password.</p>
        </div>

        <div className={styles.heroVisual}>
          {/* The artwork and the card share one box, so the card can be placed
              in percentages of the scene it is meant to sit inside. */}
          <div className={styles.heroScenePlane}>
            <Image
              className={styles.heroScene}
              src="/assets/landing/futuristic-vault-hero.png"
              alt=""
              fill
              priority
              sizes="(max-width: 980px) 100vw, 58vw"
            />
            <HeroResultCard />
          </div>
        </div>
      </section>

      <section className={styles.proofRail} aria-label="Why VaultShuffle is easy to try">
        {PROOF_POINTS.map((point) => (
          <article key={point.title}>
            <span className={styles.proofIcon}><SiteGlyph name={point.icon} size={25} /></span>
            <span><strong>{point.title}</strong><small>{point.note}</small></span>
          </article>
        ))}
      </section>

      <section id="demo" className={styles.demoSection} aria-labelledby="demo-title">
        <div className={styles.demoCopy}>
          <h2 id="demo-title">One pick.<span>Here’s why.</span></h2>
          <p>
            A guided draw isn&apos;t a blind spin through your whole library. No scrolling through another list. The
            Vault scores the eligible games for your setup, then makes a weighted draw from the strongest matches.
          </p>
          <div className={styles.demoChoices} aria-label="Example choices">
            <span><SiteGlyph name="evening-session" size={21} />Evening Session</span>
            <span><SiteGlyph name="intense" size={21} />Intense</span>
            <span><SiteGlyph name="finish" size={21} />Finish Something</span>
          </div>
        </div>
        <div className={styles.demoStage}><LandingResultDemo /></div>
      </section>

      <section id="how" className={styles.howSection} aria-labelledby="how-title">
        <div className={styles.sectionIntro}>
          <h2 id="how-title">Three questions.<span>One game.</span></h2>
          <p>Set the moment. The Vault handles the shortlist.</p>
        </div>
        <LandingQuestions />
      </section>

      <section id="why" className={styles.whySection} aria-labelledby="why-title">
        <div className={styles.sectionIntro}>
          <h2 id="why-title">The draw is only<span>the last step.</span></h2>
          <p>Before a game is picked, your session, mood, goal and progress shape the deck.</p>
        </div>
        <div className={styles.logicFlow} aria-label="How a recommendation is selected">
          <article><span><SiteGlyph name="library" size={26} /></span><div><small>Example library</small><strong>184 owned games</strong></div></article>
          <article><span><SiteGlyph name="session" size={26} /></span><div><small>The moment</small><strong className={styles.momentValue}>Evening · Intense · Finish Something</strong></div></article>
          <article><span><SiteGlyph name="shuffle" size={26} /></span><div><small>Best-fit deck</small><strong>Up to 64 games</strong></div></article>
          <article><span><SiteGlyph name="play-now" size={26} /></span><div><small>Your pick</small><strong>Elden Ring</strong></div></article>
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
