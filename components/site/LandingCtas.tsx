"use client";

import Link from "next/link";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import styles from "./landing-experience.module.css";

/**
 * The three ways into the product, and the first two steps of the acquisition
 * funnel. Without these events the funnel begins at the point someone is already
 * inside the app, and the choice that decides which path they take goes
 * unrecorded. `location` separates the hero from the closing section, which is
 * what tells you whether reading the page helps or hurts.
 *
 * A client island rather than part of the page: these links are the only
 * thing in the hero and the closing section that has to run any JavaScript.
 */
export function LandingCtas({ location, compact = false }: { location: "hero" | "footer"; compact?: boolean }) {
  return (
    <div className={compact ? `${styles.ctas} ${styles.ctasCompact}` : styles.ctas} role="group" aria-label="Try VaultShuffle">
      {/* Steam sign-in leaves the app, so both events go out through
          trackNavigationEvent - a plain trackEvent can lose the request to the
          navigation that follows it. */}
      <a
        className={styles.primaryCta}
        href="/api/auth/steam"
        onClick={() => {
          trackNavigationEvent(ANALYTICS_EVENTS.landingChoiceMade, { choice: "steam", location });
          trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, { location: `landing_${location}` });
        }}
      >
        <span className={styles.ctaIcon}><SiteGlyph name="steam" size={24} /></span>
        <span>Continue with Steam</span>
        <SiteGlyph name="chevron-right" size={18} />
      </a>
      <Link
        className={styles.manualCta}
        href="/setup/steam-profile"
        onClick={() => trackEvent(ANALYTICS_EVENTS.landingChoiceMade, { choice: "manual_profile", location })}
      >
        <SiteGlyph name="id" size={22} />
        <span>Use profile URL</span>
        <SiteGlyph name="chevron-right" size={16} />
      </Link>
      <Link
        className={styles.secondaryCta}
        href="/vault"
        onClick={() => trackEvent(ANALYTICS_EVENTS.landingChoiceMade, { choice: "guest", location })}
      >
        <SiteGlyph name="guest" size={22} />
        <span>Try guest mode</span>
      </Link>
    </div>
  );
}
