"use client";

import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./SecureManualProfile.module.css";

type SecureManualProfileProps = {
  errorCode?: string;
  secured?: boolean;
};

export function SecureManualProfile({ errorCode, secured = false }: SecureManualProfileProps) {
  const { session, isLoading } = useAppData();
  if (isLoading) {
    return <section className={styles.loading} aria-label="Loading profile security" />;
  }

  if (session.account_type === "guest") {
    return (
      <section className={styles.statePage} aria-labelledby="secure-profile-title">
        <span className={styles.stateIcon}><VaultIcon name="lock" size={28} /></span>
        <h1 id="secure-profile-title">No browser-only profile found</h1>
        <p>
          This page secures the profile currently open in a browser. Create one from a public Steam
          profile, or sign in with Steam to open a permanent account.
        </p>
        <div className={styles.stateActions}>
          <Link className={styles.primaryButton} href="/setup/steam-profile?from=secure_profile">
            Create a profile<VaultIcon name="chevron-right" size={16} />
          </Link>
          <a className={styles.secondaryButton} href="/api/auth/steam">Sign in with Steam</a>
        </div>
      </section>
    );
  }

  if (session.account_type === "steam") {
    return (
      <section className={styles.statePage} aria-labelledby="secure-profile-title">
        <span className={`${styles.stateIcon} ${styles.completeIcon}`}><VaultIcon name="check" size={28} /></span>
        <p className={styles.stateLabel}>Steam-secured profile</p>
        <h1 id="secure-profile-title">{secured ? "Your Vault is secured" : "This Vault is already secured"}</h1>
        <p>
          Steam can bring you back to this Vault on another browser or device. Your library and
          VaultShuffle data stay together.
        </p>
        <Link className={styles.primaryButton} href="/dashboard">
          Back to Dashboard<VaultIcon name="chevron-right" size={16} />
        </Link>
      </section>
    );
  }

  const errorMessage = errorCode ? securityErrorMessage(errorCode) : null;
  const steamProfileName = session.steam_display_name || session.display_name;

  return (
    <section className={styles.page} aria-labelledby="secure-profile-title">
      <header className={styles.intro}>
        <span className={styles.heroIcon}><VaultIcon name="lock" size={25} /></span>
        <p className={styles.label}>Browser-only profile</p>
        <h1 id="secure-profile-title">Keep this Vault wherever you play.</h1>
        <p className={styles.lede}>
          Your profile keeps working exactly as it does now. Connecting the same Steam account simply
          gives you a reliable way back in from another browser or device.
        </p>
      </header>

      {errorMessage ? (
        <div className={styles.error} role="alert">
          <VaultIcon name="action" size={19} />
          <span><strong>Nothing changed.</strong>{errorMessage}</span>
        </div>
      ) : null}

      <div className={styles.accessPath}>
        <article className={styles.accessStep}>
          <span className={styles.stepIcon}><VaultIcon name="id" size={23} /></span>
          <div>
            <small>Right now</small>
            <h2>This browser is your key</h2>
            <p>Your saved session is currently the only way back to this profile.</p>
          </div>
        </article>

        <span className={styles.pathLine} aria-hidden="true"><VaultIcon name="chevron-right" size={17} /></span>

        <article className={`${styles.accessStep} ${styles.securedStep}`}>
          <span className={styles.stepIcon}><VaultIcon name="steam-data" size={23} /></span>
          <div>
            <small>Whenever you’re ready</small>
            <h2>Steam becomes your way back</h2>
            <p>Use Steam to return to this same Vault on another browser or device.</p>
          </div>
        </article>
      </div>

      <div className={styles.assurance}>
        <VaultIcon name="privacy" size={20} />
        <p>
          Sign in with the Steam account for <strong>{steamProfileName}</strong>. To protect this Vault,
          a different Steam account will not be accepted. Your library, pins, collections and progress stay with you.
        </p>
      </div>

      <div className={styles.actions}>
        <a
          className={styles.primaryButton}
          href="/api/auth/steam?flow=secure-profile"
        >
          <VaultIcon name="open-steam" size={20} />
          Secure profile with Steam
          <VaultIcon name="chevron-right" size={16} />
        </a>
        <Link className={styles.secondaryButton} href="/dashboard">Not now — back to Dashboard</Link>
      </div>

      <p className={styles.optional}>
        This is optional. You can keep using this browser-only profile for as long as its session remains available.
      </p>
    </section>
  );
}

function normaliseErrorReason(errorCode: string) {
  const code = errorCode.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80);
  return code || "unknown";
}

function securityErrorMessage(errorCode: string) {
  const code = normaliseErrorReason(errorCode);
  if (code.includes("mismatch") || code.includes("different_steam")) {
    return " That Steam sign-in belongs to a different profile. Please use the Steam account this Vault was created from.";
  }
  if (code.includes("expired")) {
    return " That security check expired before it finished. Try again whenever you’re ready.";
  }
  if (code.includes("cancel")) {
    return " Steam sign-in was cancelled. You can continue using this profile or try again whenever you’re ready.";
  }
  if (code.includes("not_configured") || code.includes("unavailable")) {
    return " Steam sign-in is temporarily unavailable. Your browser-only profile is still here and working.";
  }
  return " We couldn’t finish securing this profile. Your browser-only profile is still here and working; please try again when you’re ready.";
}
