"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import styles from "./GuestPreviewNotice.module.css";

type GuestPreviewNoticeProps = {
  feature: string;
  icon: VaultIconName;
  children: ReactNode;
};

export function GuestPreviewNotice({ feature, icon, children }: GuestPreviewNoticeProps) {
  const featureId = feature.toLowerCase().replaceAll(" ", "_");
  return (
    <aside className={styles.notice} aria-label={`${feature} guest preview`}>
      <span className={styles.icon} aria-hidden="true"><VaultIcon name={icon} size={22} /></span>
      <span className={styles.copy}>
        <strong>{feature} preview</strong>
        <small>{children}</small>
      </span>
      <span className={styles.actions}>
        <a
          href="/api/auth/steam"
          className={styles.steamAction}
          onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, {
            location: `${featureId}_preview`,
            feature: featureId,
          })}
        >
          <VaultIcon name="open-steam" size={17} />
          Sign in with Steam
        </a>
        <Link
          href={`/setup/steam-profile?from=guest_${featureId}_preview`}
          className={styles.profileAction}
        >
          <VaultIcon name="id" size={17} />
          Create profile
          <VaultIcon name="chevron-right" size={15} />
        </Link>
      </span>
    </aside>
  );
}
