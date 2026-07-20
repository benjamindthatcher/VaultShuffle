"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./VaultShuffleLoader.module.css";

const SHOW_DELAY_MS = 150;
const MIN_VISIBLE_MS = 400;
const FADE_OUT_MS = 200;

export function VaultShuffleLoader({ active }: { active: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const mountedRef = useRef(false);
  const shownAtRef = useRef(0);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function clearTimer(ref: typeof showTimerRef) {
      if (ref.current) clearTimeout(ref.current);
      ref.current = null;
    }

    if (active) {
      clearTimer(hideTimerRef);
      clearTimer(unmountTimerRef);

      if (mountedRef.current) {
        setVisible(true);
      } else {
        showTimerRef.current = setTimeout(() => {
          mountedRef.current = true;
          shownAtRef.current = performance.now();
          setMounted(true);
          requestAnimationFrame(() => setVisible(true));
        }, SHOW_DELAY_MS);
      }
    } else {
      clearTimer(showTimerRef);
      if (mountedRef.current) {
        const elapsed = performance.now() - shownAtRef.current;
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
          unmountTimerRef.current = setTimeout(() => {
            mountedRef.current = false;
            setMounted(false);
          }, FADE_OUT_MS);
        }, Math.max(0, MIN_VISIBLE_MS - elapsed));
      }
    }

    return () => {
      clearTimer(showTimerRef);
      clearTimer(hideTimerRef);
      clearTimer(unmountTimerRef);
    };
  }, [active]);

  if (!mounted) return null;

  return (
    <div
      className={`${styles.loader} ${visible ? styles.visible : ""}`}
      role="status"
      aria-label="Loading"
    >
      <video className={styles.animation} autoPlay muted loop playsInline preload="auto" aria-hidden="true">
        <source src="/assets/loading/vaultshuffle-loader-transparent.webm" type="video/webm" />
        <source src="/assets/loading/vaultshuffle-loader.mp4" type="video/mp4" />
      </video>
      <span className={styles.staticIcon} aria-hidden="true" />
    </div>
  );
}
