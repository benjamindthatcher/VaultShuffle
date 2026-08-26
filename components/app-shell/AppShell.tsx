"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AppDataProvider, useAppData } from "@/components/app-shell/AppDataProvider";
import { AppHeader } from "@/components/app-shell/AppHeader";
import { SteamImportProgressCard } from "@/components/dashboard/SteamImportProgressCard";
import { VaultShuffleLoader } from "@/components/shared/VaultShuffleLoader";
import styles from "@/app/(product)/shell.module.css";

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
    isLoading,
    isSyncing,
    playHistoryMissing,
    refresh,
    syncSteamLibrary
  } = useAppData();

  // Explicitly false means Steam answered and withheld it. Null means we have not
  // checked yet, which must not trigger a warning.

  const [bootComplete, setBootComplete] = useState(false);

  useEffect(() => {
    if (!isLoading) setBootComplete(true);
  }, [isLoading]);

  // No navigation. Progress is reported wherever you are now, so being moved to
  // the Dashboard to watch it was taking the page away for no reason.
  function retrySteamImport() {
    void syncSteamLibrary().catch(() => undefined);
  }

  const holdInitialContent = waitForAppData && !bootComplete;

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

      {playHistoryMissing ? (
        <div className={styles.importNotice} role="status">
          <span>
            Your games imported, but Steam did not share any playtime. VaultShuffle uses playtime to
            judge progress and what you have not touched lately, so picks will be rough until it can see it.
            In Steam, open <strong>Profile &gt; Edit Profile &gt; Privacy Settings</strong> and set
            <strong> Game details</strong> to Public, then sync again.
          </span>
          <button type="button" disabled={isSyncing} onClick={retrySteamImport}>
            {isSyncing ? "Syncing…" : "Sync again"}
          </button>
        </div>
      ) : null}
      <main className={styles.appContent}>
        {/* Inside the content column so it keeps the width it had on the
            Dashboard, and on every page so a sync can be watched from wherever
            it was started. It renders nothing unless an import is running. */}
        {holdInitialContent ? null : <SteamImportProgressCard />}
        {holdInitialContent ? null : children}
      </main>
    </div>
  );
}
