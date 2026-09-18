<<<<<<< Updated upstream
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/AppShell";
import styles from "./SharedInformationShell.module.css";

=======
"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isSignedInAccount, useSiteSession } from "@/components/site/SiteExperience";
import styles from "./SharedInformationShell.module.css";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/vault", label: "Vault" },
  { href: "/library", label: "Library" },
  { href: "/collections", label: "Collections" }
] as const;

/**
 * The shell for the public information pages.
 *
 * These used to render inside AppShell, which meant someone arriving from the
 * landing footer - not signed in, possibly never having been - read the privacy
 * policy inside the product's furniture: Dashboard, Vault, Library, Purge and
 * Collections across the top, an account chip, and a request for app data the
 * page has no use for.
 *
 * So the default is still the brand and a way back and nothing else. What is
 * added is a way *forward* for the rare visitor who is signed in and has ended
 * up here: the same four destinations, in the header the page already has.
 *
 * Three things about how that is done, all for the same reason - these pages
 * are static, CDN-served, and nearly all of their traffic is anonymous:
 *
 * - The session comes from SiteFrame's context, not a fetch of its own and not
 *   a cookie read. A cookie read on the server would make every anonymous visit
 *   a function invocation to decide something only a signed-in visitor sees.
 * - The links are added into the existing header row beside the brand, so when
 *   the session resolves nothing above or below them moves.
 * - Guest mode gets nothing. It has no dashboard to go back to.
 */
>>>>>>> Stashed changes
export function SharedInformationShell({ children }: { children: ReactNode }) {
  const session = useSiteSession();
  const pathname = usePathname();
  const signedIn = isSignedInAccount(session);
  const name = session?.display_name?.trim();

  return (
<<<<<<< Updated upstream
    <AppShell headerVariant="utility">
=======
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
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

          {signedIn ? (
            <nav className={styles.nav} aria-label="Back to VaultShuffle">
              <ul>
                {NAV_ITEMS.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={pathname === item.href ? "page" : undefined}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
              {name ? <span className={styles.who}>{name}</span> : null}
            </nav>
          ) : null}
        </div>
      </header>
>>>>>>> Stashed changes
      <div className={styles.content}>{children}</div>
    </AppShell>
  );
}
