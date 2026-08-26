"use client";

import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
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
  return (
    <p className={styles.lock}>
      <VaultIcon name="lock" size={14} />
      <span>{children}</span>
      <a
        href="/api/auth/steam"
        onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, {
          location: `${feature}_lock`,
          feature,
          preview_mode: true
        })}
      >
        Sign in with Steam
      </a>
    </p>
  );
}
