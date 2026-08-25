"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./AppHeader.module.css";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/vault", label: "Vault" },
  { href: "/library", label: "Library" },
  { href: "/purge", label: "Purge" },
  { href: "/collections", label: "Collections" }
];

type AppHeaderProps = {
  variant?: "product" | "utility";
};

export function AppHeader({ variant = "product" }: AppHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { session, isLive, isLoading, isSyncing, syncSteamLibrary, signOut, deviceMode, setDeviceMode } = useAppData();
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

  function handleSync() {
    if (profileMenuRef.current) profileMenuRef.current.open = false;
    router.push("/dashboard");
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
              <span>{isLive ? "Steam connected" : "Guest preview"}</span>
            </div>
            {/* Outside the signed-in branch: the guest catalogue carries the same
                platform and Deck data, so someone evaluating the product on a Mac
                or a Deck can see whether it would actually be any use to them. */}
            <div className={styles.menuGroup} role="group" aria-label="Device mode">
              <p className={styles.menuGroupLabel}>Device mode</p>
              <p className={styles.menuGroupHint}>Hide games that will not run on the machine you are playing on.</p>
              <div className={styles.deviceModes}>
                {([
                  { id: "all", label: "All games" },
                  { id: "mac", label: "Mac only" },
                  { id: "deck", label: "Steam Deck" }
                ] as const).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={deviceMode === mode.id ? styles.deviceModeOn : styles.deviceMode}
                    aria-pressed={deviceMode === mode.id}
                    onClick={() => setDeviceMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

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
                  Sign out
                </button>
              </>
            ) : (
              <a href="/api/auth/steam" className={styles.menuAction}>Sign in with Steam</a>
            )}
          </div>
        </details>
      </div>
    </header>
  );
}
