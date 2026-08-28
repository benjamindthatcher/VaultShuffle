"use client";

import { useEffect, useRef } from "react";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./SignInLock.module.css";

type SignInLockProps = {
  /** Snake-case id for analytics, e.g. "purge_flag". */
  feature: string;
  /** What signing in would let them do, as a sentence without the call to action. */
  children: string;
};

/**
 * A quiet line saying a control needs a signed-in library.
 *
 * Most of the app works in guest mode because the preview keeps its own copy of
 * what you do - pins, sleeps, collections, Purge decisions all live in the
 * session and reset when you leave. A few things cannot work that way, and for
 * those the control stays on screen, disabled, with this underneath it. Seeing a
 * feature and being told what it needs is more use than not knowing it exists,
 * and a dialog over a preview is a heavier interruption than the situation
 * deserves.
 */
export function SignInLock({ feature, children }: SignInLockProps) {
  // Reported once per mount rather than per render, so the count is "how often
  // did a guest reach this wall" rather than how often React drew it.
  const reportedRef = useRef(false);
  useEffect(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    trackEvent(ANALYTICS_EVENTS.guestFeatureLocked, { feature });
  }, [feature]);

  return (
    <p className={styles.lock}>
      <VaultIcon name="lock" size={14} />
      <span>{children}</span>
      <a
        href="/api/auth/steam"
        onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, {
          location: `${feature}_lock`,
          feature
        })}
      >
        Sign in with Steam
      </a>
    </p>
  );
}
