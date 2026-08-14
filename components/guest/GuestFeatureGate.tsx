"use client";

import { captureProductEvent } from "@/lib/posthog-client";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import styles from "./GuestFeatureGate.module.css";

type GuestFeatureGateProps = {
  feature: string;
  icon: VaultIconName;
  title: string;
  description: string;
  benefits: readonly string[];
};

export function GuestFeatureGate({ feature, icon, title, description, benefits }: GuestFeatureGateProps) {
  return (
    <section className={styles.page} aria-labelledby="guest-feature-title">
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.card}>
        <span className={styles.lockIcon}><VaultIcon name={icon} size={34} /></span>
        <p className={styles.eyebrow}><VaultIcon name="privacy" size={15} />{feature} · Steam account feature</p>
        <h1 id="guest-feature-title">{title}</h1>
        <p className={styles.copy}>{description}</p>

        <ul className={styles.benefits}>
          {benefits.map((benefit) => <li key={benefit}><VaultIcon name="check" size={17} />{benefit}</li>)}
        </ul>

        <div className={styles.actions}>
          <a
            href="/api/auth/steam"
            className={styles.primary}
            onClick={() => captureProductEvent("guest_sign_in_cta_clicked", { location: `${feature.toLowerCase()}_gate` })}
          >
            <VaultIcon name="open-steam" size={21} />
            Continue with Steam
            <VaultIcon name="chevron-right" size={17} />
          </a>
          <a href="/vault" className={styles.secondary}>Continue the guest Vault preview</a>
        </div>

        <p className={styles.trust}><VaultIcon name="privacy" size={16} />Steam handles sign-in. VaultShuffle never receives your password.</p>
      </div>
    </section>
  );
}
