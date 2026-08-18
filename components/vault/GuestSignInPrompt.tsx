"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
import styles from "./GuestSignInPrompt.module.css";

type GuestSignInPromptProps = {
  open: boolean;
  onClose: () => void;
  catalogueSize: number;
};

export function GuestSignInPrompt({ open, onClose, catalogueSize }: GuestSignInPromptProps) {
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted || !open) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ));
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [mounted, onClose, open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className={styles.layer}>
      <button type="button" className={styles.backdrop} onClick={onClose} aria-label="Close sign-in prompt" />
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="guest-sign-in-title" tabIndex={-1}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close sign-in prompt">
          <VaultIcon name="close" size={18} />
        </button>

        <span className={styles.icon}><VaultIcon name="current-pick" size={30} /></span>
        <p className={styles.eyebrow}>Nice pick</p>
        <h2 id="guest-sign-in-title">Ready to shuffle your own games?</h2>
        <p className={styles.copy}>This preview draws from {catalogueSize} popular games. Sign in with Steam to replace it with the games you actually own and make every recommendation personal.</p>

        <div className={styles.benefits} aria-label="Benefits of signing in">
          <span><VaultIcon name="all-games" size={18} />Your Steam library</span>
          <span><VaultIcon name="clock" size={18} />Saved draw history</span>
          <span><VaultIcon name="collections" size={18} />Collections and progress</span>
        </div>

        <div className={styles.actions}>
          <a href="/api/auth/steam" className={styles.primary} onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, { location: "first_draw_prompt" })}><VaultIcon name="open-steam" size={20} />Continue with Steam<VaultIcon name="chevron-right" size={17} /></a>
          <button type="button" className={styles.secondary} onClick={onClose}>Keep exploring as guest</button>
        </div>

        <p className={styles.trust}><VaultIcon name="privacy" size={16} />Steam handles sign-in securely. VaultShuffle never sees your password.</p>
      </div>
    </div>,
    document.body
  );
}
