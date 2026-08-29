import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./SharedInformationShell.module.css";

/**
 * The shell for the public information pages.
 *
 * These used to render inside AppShell, which meant someone arriving from the
 * landing footer - not signed in, possibly never having been - read the privacy
 * policy inside the product's furniture: Dashboard, Vault, Library, Purge and
 * Collections across the top, an account chip, and a request for app data the
 * page has no use for.
 *
 * They are public documents, so they get the brand and a way back and nothing
 * else. The footer that carries the links between them comes from the layout,
 * which already renders its site variant on these routes.
 */
export function SharedInformationShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="VaultShuffle home">
          <Image
            className={styles.brandIcon}
            src="/assets/brand/vaultshuffle-icon.png"
            alt=""
            width={38}
            height={38}
            priority
          />
          <span className={styles.brandWordmark}>
            <span className={styles.brandWord}>Vault</span>
            <span className={styles.brandAccent}>Shuffle</span>
          </span>
        </Link>
      </header>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
