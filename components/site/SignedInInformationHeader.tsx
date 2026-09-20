"use client";

import type { ReactNode } from "react";
import { AppDataProvider, useAppData } from "@/components/app-shell/AppDataProvider";
import { AppHeader } from "@/components/app-shell/AppHeader";
import { SteamImportProgressCard } from "@/components/dashboard/SteamImportProgressCard";
import styles from "./SharedInformationShell.module.css";

/** Loaded only for signed in readers. Reuses the real app header and its actions. */
export function SignedInInformationHeader({ fallback }: { fallback: ReactNode }) {
  return (
    <AppDataProvider>
      <HeaderContent fallback={fallback} />
    </AppDataProvider>
  );
}

function HeaderContent({ fallback }: { fallback: ReactNode }) {
  const { isLive, isLoading, isSyncing, loadError, refresh } = useAppData();

  return (
    <>
      {isLive ? <AppHeader /> : fallback}
      {loadError ? (
        <div className={styles.headerNotice} role="alert">
          <span>{loadError}</span>
          <button type="button" disabled={isLoading} onClick={() => void refresh()}>
            {isLoading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      {isSyncing ? <div className={styles.importProgress}><SteamImportProgressCard /></div> : null}
    </>
  );
}
