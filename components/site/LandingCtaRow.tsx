"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { SiteGlyph } from "@/components/shared/SiteGlyph";

/**
 * The two ways into the product, with the first two steps of the funnel
 * attached.
 *
 * Everything from guest mode onward was already tracked; the choice that decides
 * which of those two paths someone takes was not, so the funnel started at the
 * point they were already inside. `location` distinguishes the hero from the
 * closing section, which is the only way to tell whether reading the page makes
 * people more or less likely to commit.
 */
export function LandingCtaRow({ location, layout = "row" }: { location: "hero" | "footer"; layout?: "row" | "centred" }) {
  useEffect(() => {
    if (location !== "hero") return;
    trackEvent(ANALYTICS_EVENTS.landingViewed);
  }, [location]);

  return (
    <div className={layout === "centred" ? "vs-cta-row vs-cta-row-centred" : "vs-cta-row"} role="group" aria-label="Get started">
      <a
        className="vs-cta vs-cta-primary"
        href="/api/auth/steam"
        onClick={() => {
          trackNavigationEvent(ANALYTICS_EVENTS.landingChoiceMade, { choice: "steam", location });
          trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, { location: `landing_${location}` });
        }}
      >
        <span className="vs-cta-icon"><SiteGlyph name="steam" size={26} /></span>
        <span className="vs-cta-label">Continue with Steam</span>
        <span className="vs-cta-arrow" aria-hidden="true">&rarr;</span>
      </a>

      <Link
        className="vs-cta vs-cta-secondary"
        href="/vault"
        onClick={() => trackEvent(ANALYTICS_EVENTS.landingChoiceMade, { choice: "guest", location })}
      >
        <SiteGlyph name="guest" size={26} />
        Try Guest Mode
      </Link>
    </div>
  );
}
