"use client";

import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./ManualProfileAccessNotice.module.css";

/**
 * What a profile made from a public Steam URL needs to know, and the way out of
 * it, in one place at the foot of the dashboard.
 *
 * This used to be a dismissible notice at the top of the page pointing at a link
 * buried in the profile menu - so the explanation and the action it described
 * were two different places, and acknowledging the explanation removed the only
 * thing that mentioned the action at all. The account data is durable; access is
 * not recoverable while a browser cookie is the only credential, and that stays
 * true however many times it has been read.
 *
 * So it is permanent rather than dismissible, and it carries the link itself.
 * At the bottom of the dashboard because it is a standing fact about the
 * account rather than something to act on tonight - the page's own work comes
 * first.
 */
export function ManualProfileAccessNotice() {
  const { session, isLoading } = useAppData();
  const isManualProfile = session.account_type === "manual" && Boolean(session.user_id);
  if (isLoading || !isManualProfile) return null;

  return (
    <section className={styles.notice} aria-label="Browser-only profile access">
      <span className={styles.icon}><VaultIcon name="lock" size={20} /></span>
      <div className={styles.copy}>
        <strong>Keep your Vault wherever you play</strong>
        <p>
          Everything you do here is saved, but this is a browser-only profile—this browser is currently
          your only key. If its session is cleared or expires, you may not be able to get back to this Vault.
          Connecting Steam keeps it, and takes a moment.
        </p>
      </div>
      <Link
        href="/account/secure-profile"
        className={styles.action}
      >
        Secure profile with Steam
        <VaultIcon name="chevron-right" size={15} />
      </Link>
    </section>
  );
}
