"use client";

import Image from "next/image";
import { useState } from "react";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import styles from "./landing-experience.module.css";

const ELDEN_RING_LIBRARY_ART = "https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg";

const REASONS = [
  { icon: "clock", text: "Ideal evening session length" },
  { icon: "intense", text: "Perfect Intense match" },
  { icon: "in-progress", text: "61% complete" }
];

/**
 * The worked example. Only Pin and Snooze need the client - they toggle a label
 * to show what the real card does - but they sit inside the card, so the card
 * comes with them.
 */
export function LandingResultDemo() {
  const [demoAction, setDemoAction] = useState<"pinned" | "snoozed" | null>(null);

  return (
    <article className={styles.resultDemo} aria-label="Example recommendation for Elden Ring">
      <div className={styles.resultArt}>
        <Image
          className={styles.resultArtBackdrop}
          src={ELDEN_RING_LIBRARY_ART}
          alt=""
          fill
          unoptimized
          sizes="(max-width: 760px) 90vw, 340px"
        />
        <Image
          className={styles.resultArtPoster}
          src={ELDEN_RING_LIBRARY_ART}
          alt="Elden Ring"
          fill
          unoptimized
          sizes="(max-width: 760px) 90vw, 340px"
        />
      </div>
      <div className={styles.resultBody}>
        <p className={styles.resultSetup}>Evening · Intense · Finish Something</p>
        <h3>Elden Ring</h3>
        <p className={styles.resultReason}>
          You&apos;re already well into it, it fits an evening session, and tonight you want something demanding.
        </p>
        <ul className={styles.reasonList}>
          {REASONS.map((reason) => (
            <li key={reason.text}><SiteGlyph name={reason.icon} size={19} /><span>{reason.text}</span></li>
          ))}
        </ul>
        <span className={styles.steamAction}>
          <SiteGlyph name="steam" size={22} />
          Open on Steam
          <SiteGlyph name="external-link" size={17} />
        </span>
        <div className={styles.resultActions} role="group" aria-label="Example recommendation actions">
          <button
            type="button"
            className={demoAction === "pinned" ? styles.resultActionSelected : undefined}
            aria-pressed={demoAction === "pinned"}
            onClick={() => {
              setDemoAction((current) => current === "pinned" ? null : "pinned");
              trackEvent(ANALYTICS_EVENTS.landingDemoUsed, { control: "pin" });
            }}
          >
            <SiteGlyph name="pin" size={18} />
            {demoAction === "pinned" ? "Pinned" : "Pin this pick"}
          </button>
          <button
            type="button"
            className={demoAction === "snoozed" ? styles.resultActionSelected : undefined}
            aria-pressed={demoAction === "snoozed"}
            onClick={() => {
              setDemoAction((current) => current === "snoozed" ? null : "snoozed");
              trackEvent(ANALYTICS_EVENTS.landingDemoUsed, { control: "snooze" });
            }}
          >
            <SiteGlyph name="snooze-not-now" size={18} />
            {demoAction === "snoozed" ? "Snoozed" : "Snooze"}
          </button>
        </div>
        <p className={styles.resultFoot}>Example pool · <strong>184</strong> owned games</p>
      </div>
    </article>
  );
}
