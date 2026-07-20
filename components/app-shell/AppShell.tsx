"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { AppDataProvider, useAppData } from "@/components/app-shell/AppDataProvider";
import { AppHeader } from "@/components/app-shell/AppHeader";
import { VaultShuffleLoader } from "@/components/shared/VaultShuffleLoader";
import styles from "@/app/(product)/shell.module.css";

type AppShellProps = {
  children: ReactNode;
  headerVariant?: "product" | "utility";
};

export function AppShell({ children, headerVariant = "product" }: AppShellProps) {
  return (
    <AppDataProvider>
      <AppShellContent headerVariant={headerVariant}>{children}</AppShellContent>
    </AppDataProvider>
  );
}

function AppShellContent({ children, headerVariant }: Required<AppShellProps>) {
  const {
    loadError,
    isLive,
    isLoading,
    isSyncing,
    refresh,
    syncSteamLibrary
  } = useAppData();
  const [bootComplete, setBootComplete] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const automaticImportStartedRef = useRef(false);

  useEffect(() => {
    if (!isLoading) setBootComplete(true);
  }, [isLoading]);

  useEffect(() => {
    if (isLoading || !isLive || automaticImportStartedRef.current) return;

    const url = new URL(window.location.href);
    if (url.searchParams.get("steam_connected") !== "1") return;

    automaticImportStartedRef.current = true;
    url.searchParams.delete("steam_connected");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

    setImportError(null);
    void syncSteamLibrary().catch((error) => {
      console.error("Automatic Steam library import failed", error);
      setImportError(
        error instanceof Error
          ? error.message
          : "Steam sign-in worked, but the library import failed."
      );
    });
  }, [isLive, isLoading, syncSteamLibrary]);

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

  return (
    <div className={styles.appShell}>
      <VaultShuffleLoader active={!bootComplete && isLoading} />
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

      <main className={styles.appContent}>{children}</main>
    </div>
  );
}
