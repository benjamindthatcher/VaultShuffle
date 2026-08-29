"use client";

import { useIsMounted } from "@/components/shared/useIsMounted";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import styles from "./GuestSignInPrompt.module.css";

type GuestSignInPromptProps = {
  open: boolean;
  onClose: () => void;
  catalogueSize: number;
  reason?: string;
};

export function GuestSignInPrompt({ open, onClose, catalogueSize, reason = "personal_progress" }: GuestSignInPromptProps) {
  const mounted = useIsMounted();
  const shownTrackedRef = useRef(false);


  useEffect(() => {
    if (!mounted || !open) return;

    if (!shownTrackedRef.current) {
      shownTrackedRef.current = true;
      trackEvent(ANALYTICS_EVENTS.guestSignInNudgeShown, {
        reason,
        catalogue_size: catalogueSize,
      });
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        trackEvent(ANALYTICS_EVENTS.guestSignInNudgeDismissed, {
          reason,
          method: "escape",
        });
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [catalogueSize, mounted, onClose, open, reason]);

  useEffect(() => {
    if (!open) shownTrackedRef.current = false;
  }, [open]);

  function dismiss(method: "close" | "keep_previewing") {
    trackEvent(ANALYTICS_EVENTS.guestSignInNudgeDismissed, {
      reason,
      method,
    });
    onClose();
  }

  if (!mounted || !open) return null;

  return createPortal(
    <aside className={styles.prompt} aria-label="Optional library connection suggestion">
      <button type="button" className={styles.close} onClick={() => dismiss("close")} aria-label="Dismiss suggestion">
        <VaultIcon name="close" size={16} />
      </button>
      <span className={styles.icon} aria-hidden="true"><VaultIcon name="finish-something" size={22} /></span>
      <span className={styles.copy}>
        <strong>This one needs your playtime</strong>
        <small>Connect a public library so VaultShuffle can spot games you have actually started. You can keep using the {catalogueSize}-game preview without it.</small>
      </span>
      <span className={styles.actions}>
        <a
          href="/api/auth/steam"
          className={styles.primary}
          onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, {
            location: "guest_personal_progress_nudge",
            reason,
          })}
        >
          Sign in with Steam
        </a>
        <Link
          href="/setup/steam-profile?from=guest_personal_progress_nudge"
          className={styles.profile}
          onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.manualProfileSetupStarted, {
            location: "guest_personal_progress_nudge",
            reason,
          })}
        >
          Create profile
        </Link>
        <button type="button" className={styles.secondary} onClick={() => dismiss("keep_previewing")}>Keep previewing</button>
      </span>
    </aside>,
    document.body
  );
}
