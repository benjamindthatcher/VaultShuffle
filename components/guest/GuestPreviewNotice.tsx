"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import styles from "./GuestPreviewNotice.module.css";

type GuestPreviewNoticeProps = {
  feature: string;
  icon: VaultIconName;
  children: ReactNode;
  actionLabel?: string;
  catalogueSize?: number;
};

export function GuestPreviewNotice({
  feature,
  icon,
  children,
  actionLabel = "Use my Steam library",
  catalogueSize,
}: GuestPreviewNoticeProps) {
  const featureId = feature.toLowerCase().replaceAll(" ", "_");
  const viewTrackedRef = useRef(false);

  useEffect(() => {
    if (viewTrackedRef.current) return;
    viewTrackedRef.current = true;
    trackEvent(ANALYTICS_EVENTS.guestPreviewViewed, {
      feature: featureId,
      catalogue_size: catalogueSize,
      preview_mode: true,
    });
  }, [catalogueSize, featureId]);

  return (
    <aside className={styles.notice} aria-label={`${feature} guest preview`}>
      <span className={styles.icon} aria-hidden="true"><VaultIcon name={icon} size={22} /></span>
      <span className={styles.copy}>
        <strong>{feature} preview</strong>
        <small>{children}</small>
      </span>
      <a
        href="/api/auth/steam"
        onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, {
          location: `${featureId}_preview`,
          feature: featureId,
          preview_mode: true,
        })}
      >
        <VaultIcon name="open-steam" size={17} />
        {actionLabel}
        <VaultIcon name="chevron-right" size={15} />
      </a>
    </aside>
  );
}
