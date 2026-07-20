"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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
  const { loadError, isLoading, refresh } = useAppData();
  const [bootComplete, setBootComplete] = useState(false);

  useEffect(() => {
    if (!isLoading) setBootComplete(true);
  }, [isLoading]);

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
      <main className={styles.appContent}>{children}</main>
    </div>
  );
}
