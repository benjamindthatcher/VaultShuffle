"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./AppHeader.module.css";

const NAV_ITEMS = [
  { href: "/vault", label: "Vault" },
  { href: "/library", label: "Library" },
  { href: "/purge", label: "Purge" },
  { href: "/collections", label: "Collections" },
  { href: "/wishlist", label: "Wishlist" }
];

type AppHeaderProps = {
  variant?: "product" | "utility";
};

export function AppHeader({ variant = "product" }: AppHeaderProps) {
  const pathname = usePathname();
  const { session, isLive, isLoading, isSyncing, refresh, syncSteamLibrary, signOut } = useAppData();
  const [accountMessage, setAccountMessage] = useState("");
  const profileName = session.display_name || (isLive ? "Steam user" : "Guest");
  const profileInitial = profileName.trim().charAt(0).toUpperCase() || "G";

  async function handleSync() {
    setAccountMessage("");
    try {
      const imported = await syncSteamLibrary();
      setAccountMessage(`${imported} Steam games synced.`);
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "Steam sync failed.");
    }
  }

  async function handleRefresh() {
    setAccountMessage("");
    await refresh();
    setAccountMessage("VaultShuffle data refreshed.");
  }

  return (
    <header className={styles.headerWrap}>
      <div className={styles.header}>
        <Link href={variant === "utility" ? "/" : "/vault"} className={styles.brand} aria-label="Vault Shuffle home">
          <span className={styles.brandMark}>
            <Image
              src="/assets/brand/vaultshuffle-icon.png"
              alt=""
              width={42}
              height={42}
              className={styles.brandIcon}
            />
          </span>
          <span className={styles.brandWordmark} aria-label="Vault Shuffle">
            <span className={styles.brandWord}>Vault</span>
            <span className={styles.brandAccent}>Shuffle</span>
          </span>
        </Link>

        {variant === "product" ? (
          <nav className={styles.nav} aria-label="Primary">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        ) : (
          <span aria-hidden="true" />
        )}

        <details className={styles.profileMenu}>
          <summary className={styles.profilePill}>
            <span className={styles.profileAvatar}>
              {session.avatar_url ? (
                <img src={session.avatar_url} alt="" width={32} height={32} className={styles.profileImage} />
              ) : (
                profileInitial
              )}
            </span>
            <span className={styles.profileName}>{isLoading ? "Loading" : profileName}</span>
            <VaultIcon name="chevron-down" size={15} className={styles.profileChevron} />
          </summary>
          <div className={styles.profilePopover}>
            <div className={styles.accountSummary}>
              <strong>{profileName}</strong>
              <span>{isLive ? "Steam connected" : "Guest preview"}</span>
            </div>
            {isLive ? (
              <>
                <button type="button" className={styles.menuAction} onClick={() => void handleSync()} disabled={isSyncing}>
                  {isSyncing ? "Syncing Steam…" : "Sync Steam library"}
                </button>
                <button type="button" className={styles.menuAction} onClick={() => void handleRefresh()} disabled={isLoading}>
                  Refresh app data
                </button>
                <button type="button" className={`${styles.menuAction} ${styles.dangerAction}`} onClick={() => void signOut()}>
                  Sign out
                </button>
              </>
            ) : (
              <Link href="/login" className={styles.menuAction}>Sign in with Steam</Link>
            )}
            {accountMessage ? <p className={styles.accountMessage} role="status">{accountMessage}</p> : null}
          </div>
        </details>
      </div>
    </header>
  );
}
