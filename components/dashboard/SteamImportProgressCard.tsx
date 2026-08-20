"use client";

import { useEffect, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./SteamImportProgressCard.module.css";

const STEAM_IMPORT_COOKIE = "vault_steam_import";

export function SteamImportProgressCard() {
  const {
    games,
    isLive,
    isLoading,
    isSyncing,
    steamImport,
    steamImportChecked,
    syncSteamLibrary
  } = useAppData();
  const [markerChecked, setMarkerChecked] = useState(false);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const automaticStartRef = useRef(false);

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
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }

    setRefreshRequested(cookieMarker || legacyUrlMarker);
    setMarkerChecked(true);
  }, []);

  useEffect(() => {
    if (isSyncing) setEngaged(true);
  }, [isSyncing]);

  useEffect(() => {
    if (!markerChecked || !steamImportChecked || isLoading || !isLive || isSyncing) return;

    const hasNoLibrary = games.length === 0;
    const shouldResume = steamImport.status === "importing";
    const shouldStart = refreshRequested
      || shouldResume
      || (hasNoLibrary && (steamImport.status === "idle" || steamImport.status === "complete"));

    if (steamImport.status === "failed") setEngaged(true);
    if (!shouldStart || automaticStartRef.current) return;

    automaticStartRef.current = true;
    setEngaged(true);
    void syncSteamLibrary({ restart: refreshRequested || !shouldResume }).catch(() => undefined);
  }, [
    games.length,
    isLive,
    isLoading,
    isSyncing,
    markerChecked,
    refreshRequested,
    steamImport.status,
    steamImportChecked,
    syncSteamLibrary
  ]);

  const checkingForFirstImport = isLive && games.length === 0 && (!markerChecked || !steamImportChecked);
  const visible = engaged
    || isSyncing
    || checkingForFirstImport
    || steamImport.status === "importing"
    || (steamImport.status === "failed" && games.length === 0);
  if (!visible) return null;

  const fetching = checkingForFirstImport || steamImport.status === "fetching";
  const failed = steamImport.status === "failed";
  const complete = steamImport.status === "complete" && !isSyncing;
  const title = fetching
    ? "Reading your Steam library"
    : failed
      ? "Your import is paused"
      : complete
        ? "Your Steam library is ready"
        : "Building your dashboard";
  const detail = fetching
    ? "Steam sends the ownership list once. We will then save it to VaultShuffle in small, resumable batches."
    : failed
      ? (steamImport.lastError || "The next batch was not saved. Everything shown in the bar is already safe.")
      : complete
        ? `All ${steamImport.total} games are saved. Artwork, genres and length estimates continue separately below.`
        : `${steamImport.imported} of ${steamImport.total} games have been committed to your database.`;

  function retry() {
    const canResume = steamImport.total > steamImport.imported;
    setEngaged(true);
    void syncSteamLibrary({ restart: !canResume }).catch(() => undefined);
  }

  return (
    <section className={`${styles.card}${failed ? ` ${styles.failed}` : ""}`} aria-live="polite">
      <span className={styles.icon}><VaultIcon name={complete ? "check" : "steam-data"} size={23} /></span>
      <div className={styles.copy}>
        <p className={styles.kicker}>{complete ? "Import complete" : "Steam import"}</p>
        <h2>{title}</h2>
        <p>{detail}</p>
        {!complete && !failed ? (
          <small>You can leave this page. Saved batches stay safe, and the dashboard resumes the rest when you return.</small>
        ) : null}
      </div>
      <div className={styles.progressBlock}>
        <div
          className={`${styles.track}${fetching ? ` ${styles.indeterminate}` : ""}`}
          role="progressbar"
          aria-label={fetching ? "Reading Steam library" : "Steam games saved to VaultShuffle"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fetching ? undefined : steamImport.percent}
          aria-valuetext={fetching ? "Waiting for Steam" : `${steamImport.imported} of ${steamImport.total} games saved`}
        >
          <span className={styles.fill} style={fetching ? undefined : { width: `${steamImport.percent}%` }} />
        </div>
        <div className={styles.progressMeta}>
          <strong>{fetching ? "Connecting…" : `${steamImport.percent}%`}</strong>
          {!fetching && steamImport.total ? <span>{steamImport.imported} / {steamImport.total}</span> : null}
        </div>
        {failed ? (
          <button type="button" onClick={retry} disabled={isSyncing}>
            {isSyncing ? "Resuming…" : steamImport.total > steamImport.imported ? "Resume import" : "Try Steam again"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
