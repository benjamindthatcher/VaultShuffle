"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { COOLDOWN_EVENT, type CooldownNotice } from "@/lib/cooldown";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./CooldownProvider.module.css";

type ActiveCooldown = CooldownNotice & { expiresAt: number; hideAt: number };

/**
 * How long the notice stays up.
 *
 * The cooldown itself can run for minutes, and the toast used to sit there for
 * all of it. Once someone has read "wait a moment" there is nothing more to say,
 * and a permanent bar is worse than no bar. Each new attempt restarts this, so
 * someone genuinely hammering refresh keeps being told.
 */
const NOTICE_VISIBLE_MS = 10_000;

function formatRemaining(totalSeconds: number) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export function CooldownProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [cooldown, setCooldown] = useState<ActiveCooldown | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    function onCooldown(event: Event) {
      const detail = (event as CustomEvent<CooldownNotice>).detail;
      if (!detail || !Number.isFinite(detail.retryAfterSeconds)) return;
      const currentTime = Date.now();
      setNow(currentTime);
      setCooldown({
        message: detail.message,
        retryAfterSeconds: detail.retryAfterSeconds,
        expiresAt: currentTime + Math.max(1, detail.retryAfterSeconds) * 1000,
        hideAt: currentTime + NOTICE_VISIBLE_MS
      });
    }

    window.addEventListener(COOLDOWN_EVENT, onCooldown);
    return () => window.removeEventListener(COOLDOWN_EVENT, onCooldown);
  }, []);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      // Whichever comes first: the cooldown ending, or the reader having had
      // long enough to read it.
      if (currentTime >= cooldown.expiresAt || currentTime >= cooldown.hideAt) setCooldown(null);
    }, 250);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCooldown(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [cooldown]);

  const remaining = cooldown
    ? Math.max(0, Math.ceil((cooldown.expiresAt - now) / 1000))
    : 0;

  return (
    <>
      {children}
      {mounted && cooldown ? createPortal(
        <aside className={styles.toast} aria-label="Cooldown notice">
          <span className={styles.icon} aria-hidden="true"><VaultIcon name="clock" size={18} /></span>
          <div className={styles.content}>
            <p className={styles.title}>Please wait a moment</p>
            <p className={styles.message}>{cooldown.message}</p>
            <div className={styles.meta}>
              <span className={styles.timer} aria-label={`Available again in ${formatRemaining(remaining)}`}>
                Try again in <strong>{formatRemaining(remaining)}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>Nothing is loading in the background</span>
            </div>
            <span className={styles.screenReaderStatus} role="status">
              {cooldown.message} This request was stopped and is not loading in the background.
            </span>
          </div>
          <button className={styles.close} type="button" aria-label="Dismiss cooldown notice" onClick={() => setCooldown(null)}>
            <VaultIcon name="close" size={15} />
          </button>
        </aside>,
        document.body
      ) : null}
    </>
  );
}
