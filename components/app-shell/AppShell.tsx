"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
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

  // Check the Steam callback flag before allowing a product page to mount.
  useEffect(() => {
    const url = new URL(window.location.href);
    setPendingSteamImport(url.searchParams.get("steam_connected") === "1");
    setInitialUrlChecked(true);
  }, []);

  // Only hold back the first product-page mount. Later data refreshes do not
  // tear down the currently visible page.
  useEffect(() => {
    if (!isLoading) setBootComplete(true);
  }, [isLoading]);

  // A fresh Steam callback finishes its import before /vault is mounted.
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

    // Update Next's router state as well as the visible address. Using
    // window.history.replaceState(null, ...) left Next holding the old URL,
    // so client-side navigation could restore ?steam_connected=1.
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });

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
    router,
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
