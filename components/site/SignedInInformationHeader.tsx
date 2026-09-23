"use client";

import { AppDataProvider, useAppData } from "@/components/app-shell/AppDataProvider";
import { AppHeader } from "@/components/app-shell/AppHeader";
import { SteamImportProgressCard } from "@/components/dashboard/SteamImportProgressCard";
import type { SessionPayload } from "@/lib/types";
import styles from "./SharedInformationShell.module.css";

/** Loaded only for signed in readers. Reuses the real app header and its actions. */
export function SignedInInformationHeader({ session }: { session: SessionPayload }) {
  return (
    <AppDataProvider initialSession={session}>
      <HeaderContent />
    </AppDataProvider>
  );
}

function HeaderContent() {
  const { isLoading, isSyncing, loadError, refresh } = useAppData();

  return (
    <>
      <AppHeader />
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
