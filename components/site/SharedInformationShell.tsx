"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { isSignedInAccount, useSiteSession } from "@/components/site/SiteExperience";
import styles from "./SharedInformationShell.module.css";

// Public pages remain static. Guests never mount the app data provider.
const SignedInInformationHeader = dynamic(
  () => import("./SignedInInformationHeader").then((module) => module.SignedInInformationHeader),
  { ssr: false, loading: () => <PublicHeader /> }
);

function PublicHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.headerRow}>
        <Link href="/" className={styles.brand} aria-label="VaultShuffle home">
          <Image className={styles.brandIcon} src="/assets/brand/vaultshuffle-icon.png" alt="" width={38} height={38} priority />
          <span className={styles.brandWordmark}>
            <span className={styles.brandWord}>Vault</span>
            <span className={styles.brandAccent}>Shuffle</span>
          </span>
        </Link>
      </div>
    </header>
  );
}

/** The same signed in navigation on every public information and blog page. */
export function SharedInformationShell({ children }: { children: ReactNode }) {
  const session = useSiteSession();
  const signedIn = isSignedInAccount(session);

  return (
    <div className={styles.shell}>
      {signedIn && session ? <SignedInInformationHeader session={session} /> : <PublicHeader />}
      <div className={styles.content}>{children}</div>
    </div>
  );
}
