"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import styles from "./ManualProfileAccessNotice.module.css";

const STORAGE_KEY_PREFIX = "vaultshuffle:manual-profile-access-notice:v1";
const STORAGE_EVENT = "vaultshuffle:manual-profile-access-notice-changed";

function subscribeToAcknowledgement(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(STORAGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(STORAGE_EVENT, onStoreChange);
  };
}

function readAcknowledgement(storageKey: string) {
  if (!storageKey) return true;
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

/**
 * A one-time explanation for profiles created from a public Steam URL.
 *
 * The account data is durable; access is not recoverable while its browser
 * cookie is the only credential. This notice makes that distinction without
 * turning it into an upgrade prompt. The optional action remains in the profile
 * menu after this explanation is dismissed.
 */
export function useManualProfileAccessNotice() {
  const { session, isLoading } = useAppData();
  const [dismissedForVisit, setDismissedForVisit] = useState<string | null>(null);
  const shownFor = useRef<string | null>(null);
  const isManualProfile = session.account_type === "manual" && Boolean(session.user_id);
  const storageKey = isManualProfile ? `${STORAGE_KEY_PREFIX}:${session.user_id}` : "";
  const getSnapshot = useCallback(() => readAcknowledgement(storageKey), [storageKey]);
  const storedAcknowledgement = useSyncExternalStore(subscribeToAcknowledgement, getSnapshot, () => true);
  const acknowledged = storedAcknowledgement || dismissedForVisit === storageKey;

  useEffect(() => {
    if (!isLoading && isManualProfile && !acknowledged && shownFor.current !== storageKey) {
      shownFor.current = storageKey;
      trackEvent(ANALYTICS_EVENTS.manualProfileAccessNoticeShown, {
        account_type: "manual",
        identity_verified: false,
      });
    }
  }, [acknowledged, isLoading, isManualProfile, storageKey]);

  if (isLoading || !isManualProfile || acknowledged) return null;

  function acknowledge() {
    try {
      window.localStorage.setItem(storageKey, "1");
      window.dispatchEvent(new Event(STORAGE_EVENT));
    } catch {
      // The in-memory state is enough to honour the action for this visit.
    }
    setDismissedForVisit(storageKey);
    trackEvent(ANALYTICS_EVENTS.manualProfileAccessNoticeAcknowledged, {
      account_type: "manual",
      identity_verified: false,
    });
  }

  return (
    <section className={styles.notice} aria-label="Browser-only profile access">
      <span className={styles.icon}><VaultIcon name="lock" size={20} /></span>
      <div className={styles.copy}>
        <strong>Keep your Vault wherever you play</strong>
        <p>
          Everything you do here is saved, but this is a browser-only profile—this browser is currently
          your only key. If its session is cleared or expires, you may not be able to get back to this Vault.
          When you’re ready, <q>Secure profile with Steam</q> will always be waiting in your profile menu.
        </p>
      </div>
      <button type="button" onClick={acknowledge}>Acknowledge</button>
    </section>
  );
}

export function ManualProfileAccessNotice() {
  return useManualProfileAccessNotice();
}
