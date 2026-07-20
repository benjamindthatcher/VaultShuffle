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
  const [initialUrlChecked, setInitialUrlChecked] = useState(false);
  const [pendingSteamImport, setPendingSteamImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const automaticImportStartedRef = useRef(false);

  // Check the callback flag before allowing a product page to mount.
  useEffect(() => {
    const url = new URL(window.location.href);
    setPendingSteamImport(url.searchParams.get("steam_connected") === "1");
    setInitialUrlChecked(true);
  }, []);

  // This only marks the first account-data load as complete. Later refreshes do
  // not tear down the page.
  useEffect(() => {
    if (!isLoading) setBootComplete(true);
  }, [isLoading]);

  // A fresh Steam callback must finish its import before /vault is mounted.
  // This avoids rendering the guest Vault, replacing it with the live Vault,
  // and then immediately replacing it again after the import.
  useEffect(() => {
    if (!initialUrlChecked || !pendingSteamImport || isLoading) return;

    if (!isLive) {
      setImportError("Steam sign-in did not produce an active session.");
      setPendingSteamImport(false);
      return;
    }

    if (automaticImportStartedRef.current) return;
    automaticImportStartedRef.current = true;

    const url = new URL(window.location.href);
    url.searchParams.delete("steam_connected");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);

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
    initialUrlChecked,
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

  // Do not mount /vault (or another product page) underneath the initial
  // loader. It should mount once, after the session and any callback import
  // have finished.
  const holdInitialContent =
    !initialUrlChecked || !bootComplete || pendingSteamImport;

  return (
    <div className={styles.appShell}>
      <VaultShuffleLoader active={holdInitialContent} />
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
        {holdInitialContent ? null : children}
      </main>
    </div>
  );
}
