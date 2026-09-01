"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
import styles from "./AppHeader.module.css";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/vault", label: "Vault" },
  { href: "/library", label: "Library" },
  { href: "/collections", label: "Collections" }
];

type AppHeaderProps = {
  variant?: "product" | "utility";
};

export function AppHeader({ variant = "product" }: AppHeaderProps) {
  const pathname = usePathname();
  const { session, isLive, isLoading, isSyncing, syncSteamLibrary, signOut } = useAppData();
  const profileMenuRef = useRef<HTMLDetailsElement>(null);
  const profileName = session.display_name || (isLive ? "Steam user" : "Guest");
  const profileInitial = profileName.trim().charAt(0).toUpperCase() || "G";

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      const menu = profileMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && profileMenuRef.current?.open) {
        profileMenuRef.current.open = false;
        profileMenuRef.current.querySelector("summary")?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  // Stays on the page you asked from. The import card reports progress from the
  // shell now, so there is nothing on the Dashboard that you had to be taken to.
  function handleSync() {
    if (profileMenuRef.current) profileMenuRef.current.open = false;
    void syncSteamLibrary().catch(() => undefined);
  }

  return (
    <header className={styles.headerWrap}>
      <div className={styles.header}>
        <Link href="/vault" className={styles.brand} aria-label="Vault Shuffle home">
          <span className={styles.brandMark}>
            <Image
              src="/assets/brand/vaultshuffle-icon.png"
              alt=""
              width={42}
              height={42}
              priority
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

        <details ref={profileMenuRef} className={styles.profileMenu}>
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
              <span>{isLive ? (session.account_type === "manual" ? "Browser-only profile" : "Steam connected") : "Guest preview"}</span>
            </div>
            {session.account_type === "manual" ? (
              <Link
                href="/account/secure-profile"
                className={`${styles.menuAction} ${styles.secureProfileAction}`}
                onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.manualProfileSecurityLinkClicked, {
                  location: "profile_menu",
                })}
              >
                <span className={styles.secureProfileIcon}><VaultIcon name="lock" size={17} /></span>
                <span className={styles.secureProfileCopy}>
                  <strong>Secure profile with Steam</strong>
                  <small>Keep this Vault across devices</small>
                </span>
                <VaultIcon name="chevron-right" size={15} className={styles.secureProfileChevron} />
              </Link>
            ) : null}
            {isLive ? (
              <>
                <button
                  type="button"
                  className={styles.menuAction}
                  onClick={handleSync}
                  disabled={isSyncing || isLoading}
                  aria-busy={isSyncing}
                >
                  {isSyncing ? "Refreshing from Steam…" : "Refresh from Steam"}
                </button>
                <button type="button" className={`${styles.menuAction} ${styles.dangerAction}`} onClick={() => void signOut()}>
                  {session.account_type === "manual" ? "Sign out of this browser" : "Sign out"}
                </button>
              </>
            ) : (
              <>
                <a
                  href="/api/auth/steam"
                  className={styles.menuAction}
                  onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, {
                    location: "guest_profile_menu",
                  })}
                >
                  Sign in with Steam
                </a>
                <Link
                  href="/setup/steam-profile?from=guest_profile_menu"
                  className={`${styles.menuAction} ${styles.profileCreateAction}`}
                  onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.manualProfileSetupStarted, {
                    location: "guest_profile_menu",
                  })}
                >
                  Create profile from URL
                </Link>
              </>
            )}
          </div>
        </details>
      </div>
    </header>
  );
}
