"use client";

import Image from "next/image";
import { useState } from "react";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { ActionIcon } from "@/components/library/LibraryGameActions";
import styles from "./landing-experience.module.css";

const ELDEN_RING_HEADER_ART = "https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg";

const REASONS = [
  { icon: "clock", text: "About 2h estimated remaining" },
  { icon: "intense", text: "Perfect Intense match" },
  { icon: "in-progress", text: "One of your closest games to finishing" }
];

/**
 * The worked example. Save for later and Blacklist toggle a label
 * to show what the real card does - but they sit inside the card, so the card
 * comes with them.
 */
export function LandingResultDemo() {
  const [demoAction, setDemoAction] = useState<"play-later" | "blacklisted" | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);

  return (
    <article className={styles.resultDemo} aria-label="Example recommendation for Elden Ring">
      <div data-vault-card="surface" className={styles.resultArt}>
        <Image
          className={styles.resultArtPoster}
          src={ELDEN_RING_HEADER_ART}
          alt="Elden Ring"
          fill
          priority
          unoptimized
          sizes="(max-width: 540px) calc(100vw - 32px), (max-width: 920px) 500px, 35vw"
        />
      </div>
      <div className={styles.resultBody}>
        <p className={styles.resultSetup}>Evening · Intense · Finish Something</p>
        <h3>Elden Ring</h3>
        <p className={styles.resultReason}>
          You&apos;re close to the end. With about two hours estimated remaining, this could be the evening you finish it.
        </p>
        <ul className={styles.reasonList}>
          {REASONS.map((reason) => (
            <li key={reason.text}><SiteGlyph name={reason.icon} size={19} /><span>{reason.text}</span></li>
          ))}
        </ul>
        <button type="button" data-vault-control="steam" className={styles.steamAction} aria-busy={isLaunching} disabled={isLaunching} onClick={() => setIsLaunching(true)}>
          {isLaunching ? <span data-control-spinner aria-hidden="true" /> : <SiteGlyph name="steam" size={22} />}
          <span aria-live="polite">{isLaunching ? "Launching steam" : "Play now"}</span>
        </button>
        <div className={styles.resultActions} role="group" aria-label="Example recommendation actions">
          <button
            type="button"
            data-vault-control="play-later"
            className={demoAction === "play-later" ? styles.resultActionSelected : undefined}
            aria-pressed={demoAction === "play-later"}
            onClick={() => setDemoAction((current) => current === "play-later" ? null : "play-later")}
          >
            <ActionIcon kind="next" />
            {demoAction === "play-later" ? "Playing Next" : "Save for later"}
          </button>
          <button
            type="button"
            data-vault-control="blacklist"
            className={demoAction === "blacklisted" ? styles.resultActionSelected : undefined}
            aria-pressed={demoAction === "blacklisted"}
            onClick={() => setDemoAction((current) => current === "blacklisted" ? null : "blacklisted")}
          >
            <ActionIcon kind="blacklist" />
            {demoAction === "blacklisted" ? "Blacklisted" : "Blacklist"}
          </button>
        </div>
        <p className={styles.resultFoot}>Example pool · <strong>184</strong> owned games</p>
      </div>
    </article>
  );
}
