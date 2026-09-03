"use client";

import { useIsMounted } from "@/components/shared/useIsMounted";
import Link from "next/link";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
import styles from "./GuestSignInPrompt.module.css";

type GuestSignInPromptProps = {
  open: boolean;
  onClose: () => void;
  catalogueSize: number;
  reason?: string;
};

export function GuestSignInPrompt({ open, onClose, catalogueSize, reason = "personal_progress" }: GuestSignInPromptProps) {
  const mounted = useIsMounted();
  useEffect(() => {
    if (!mounted || !open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mounted, onClose, open]);

  if (!mounted || !open) return null;

  return createPortal(
    <aside className={styles.prompt} aria-label="Optional library connection suggestion">
      <button type="button" className={styles.close} onClick={onClose} aria-label="Dismiss suggestion">
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
        >
          Create profile
        </Link>
        <button type="button" className={styles.secondary} onClick={onClose}>Keep previewing</button>
      </span>
    </aside>,
    document.body
  );
}
