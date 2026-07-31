"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { AppDataProvider, useAppData } from "@/components/app-shell/AppDataProvider";
import { AppHeader } from "@/components/app-shell/AppHeader";
import { VaultShuffleLoader } from "@/components/shared/VaultShuffleLoader";
import styles from "@/app/(product)/shell.module.css";

const STEAM_IMPORT_COOKIE = "vault_steam_import";

type AppShellProps = {
  children: ReactNode;
  headerVariant?: "product" | "utility";
  waitForAppData?: boolean;
};

export function AppShell({
  children,
  headerVariant = "product",
  waitForAppData = true
}: AppShellProps) {
  return (
    <AppDataProvider>
      <AppShellContent
        headerVariant={headerVariant}
        waitForAppData={waitForAppData}
      >
        {children}
      </AppShellContent>
    </AppDataProvider>
  );
}

function AppShellContent({
  children,
  headerVariant,
  waitForAppData
}: Required<AppShellProps>) {
  const {
    loadError,
    isLive,
    isLoading,
    isSyncing,
    refresh,
    syncSteamLibrary
  } = useAppData();

  const [bootComplete, setBootComplete] = useState(false);
  const [initialMarkerChecked, setInitialMarkerChecked] = useState(false);
  const [pendingSteamImport, setPendingSteamImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const automaticImportStartedRef = useRef(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const legacyUrlMarker = url.searchParams.get("steam_connected") === "1";
    const cookieMarker = document.cookie
      .split(";")
      .map((part) => part.trim())
      .some((part) => part === `${STEAM_IMPORT_COOKIE}=1`);

    if (cookieMarker) {
      document.cookie = `${STEAM_IMPORT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    }

    if (legacyUrlMarker) {
      url.searchParams.delete("steam_connected");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`
      );
    }

    setPendingSteamImport(cookieMarker || legacyUrlMarker);
    setInitialMarkerChecked(true);
  }, []);

  useEffect(() => {
    if (!isLoading) setBootComplete(true);
  }, [isLoading]);

  useEffect(() => {
    if (!initialMarkerChecked || !pendingSteamImport || isLoading) return;

    if (!isLive) {
      setImportError("Steam sign-in did not produce an active session.");
      setPendingSteamImport(false);
      return;
    }

    if (automaticImportStartedRef.current) return;
    automaticImportStartedRef.current = true;
    setImportError(null);

    void syncSteamLibrary()
      .catch((error) => {
        console.error("Automatic Steam library import failed", error);
        setImportError(
          error instanceof Error
            ? error.message
            : "Steam sign-in worked, but the library import failed."
        );
      })
      .finally(() => {
        setPendingSteamImport(false);
      });
  }, [
    initialMarkerChecked,
    pendingSteamImport,
    isLive,
    isLoading,
    syncSteamLibrary
  ]);

  function retrySteamImport() {
    setImportError(null);

    void syncSteamLibrary().catch((error) => {
      console.error("Steam library import retry failed", error);
      setImportError(
        error instanceof Error
          ? error.message
          : "The Steam library import failed again."
      );
    });
  }

  const holdInitialContent =
    waitForAppData &&
    (!initialMarkerChecked || !bootComplete || pendingSteamImport);

  return (
    <div className={styles.appShell}>
      <VaultShuffleLoader active={waitForAppData && pendingSteamImport} />
      <AppHeader variant={headerVariant} />

      {loadError ? (
        <div className={styles.loadNotice} role="alert">
          <span>{loadError}</span>
          <button type="button" disabled={isLoading} onClick={() => void refresh()}>
            {isLoading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      {importError ? (
        <div className={styles.loadNotice} role="alert">
          <span>{importError}</span>
          <button type="button" disabled={isSyncing} onClick={retrySteamImport}>
            {isSyncing ? "Importing…" : "Retry Steam import"}
          </button>
        </div>
      ) : null}

      <main className={styles.appContent}>
        {holdInitialContent ? <ProductBootSkeleton /> : children}
      </main>
    </div>
  );
}

function ProductBootSkeleton() {
  return (
    <div className={styles.bootPage} aria-busy="true" aria-label="Loading your library">
      <section className={styles.bootHero}>
        <Image
          src="/assets/vault/vault-header.webp"
          alt=""
          fill
          preload
          sizes="100vw"
          className={styles.bootHeroImage}
        />
        <span className={styles.bootHeroShade} aria-hidden="true" />
      </section>
      <section className={styles.bootStats} aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} className={styles.bootStat} />
        ))}
      </section>
      <section className={styles.bootPanel} aria-hidden="true">
        <span className={styles.bootLine} />
        <span className={`${styles.bootLine} ${styles.bootLineShort}`} />
      </section>
    </div>
  );
}
