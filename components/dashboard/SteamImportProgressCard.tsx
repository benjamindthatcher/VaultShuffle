"use client";

import { useEffect, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import Link from "next/link";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
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
    steamImportCooldownUntil,
    steamLibraryPrivate,
    session,
    syncSteamLibrary
  } = useAppData();

  // Their own settings page, by SteamID. /my/ only resolves if this browser
  // happens to be signed in to Steam, which on a phone it very often is not -
  // it lands on a login page instead of the setting they were sent to change.
  const privacyUrl = session.steam_id
    ? `https://steamcommunity.com/profiles/${session.steam_id}/edit/settings`
    : "https://steamcommunity.com/my/edit/settings";
  const [markerChecked, setMarkerChecked] = useState(false);
  // Whether the library was empty when this card started work. A first import is
  // the one moment the product has someone's full attention and a finished
  // library to point at, so it is the moment worth handing off from - and the
  // four-second auto-dismiss threw it away.
  const [wasFirstImport, setWasFirstImport] = useState(false);
  const [justFinished, setJustFinished] = useState(false);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const [engaged, setEngaged] = useState(false);
  // Re-renders once a second while a cooldown is running, so the wait counts
  // down and the button comes back on its own.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!steamImportCooldownUntil || steamImportCooldownUntil <= now) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [steamImportCooldownUntil, now]);
  const cooldownSecondsLeft = steamImportCooldownUntil
    ? Math.max(0, Math.ceil((steamImportCooldownUntil - now) / 1000))
    : 0;
  const coolingDown = cooldownSecondsLeft > 0;
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

  // A finished import is not news. It stays up for a few seconds if you watched
  // it finish, and does not appear at all on a later visit — the dashboard
  // underneath is the evidence that it worked.
  const runningRef = useRef(false);
  useEffect(() => {
    const running = isSyncing || steamImport.status === "importing" || steamImport.status === "fetching";
    if (running) {
      runningRef.current = true;
      if (games.length === 0) setWasFirstImport(true);
      return;
    }
    if (!runningRef.current || steamImport.status !== "complete") return;
    runningRef.current = false;
    setJustFinished(true);
    // A returning user has seen this before and the dashboard underneath is the
    // evidence it worked. A first-timer asked for a game recommendation and has
    // been shown a dashboard, so their card waits until they choose to move on.
    if (wasFirstImport) return;
    const timer = window.setTimeout(() => {
      setJustFinished(false);
      setEngaged(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [games.length, isSyncing, steamImport.status, wasFirstImport]);

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
  const running = isSyncing || checkingForFirstImport || steamImport.status === "importing" || steamImport.status === "fetching";
  const visible = running
    || justFinished
    || coolingDown
    || steamLibraryPrivate
    || (steamImport.status === "failed" && games.length === 0)
    || (engaged && steamImport.status === "failed");
  if (!visible) return null;

  const fetching = !coolingDown && !steamLibraryPrivate && (checkingForFirstImport || steamImport.status === "fetching");
  const failed = !coolingDown && !steamLibraryPrivate && steamImport.status === "failed";
  const complete = justFinished && !running;
  const waitLabel = cooldownSecondsLeft >= 60
    ? `${Math.ceil(cooldownSecondsLeft / 60)} minute${Math.ceil(cooldownSecondsLeft / 60) === 1 ? "" : "s"}`
    : `${cooldownSecondsLeft} second${cooldownSecondsLeft === 1 ? "" : "s"}`;
  const title = steamLibraryPrivate
    ? "Steam is not sharing your games yet"
    : coolingDown
    ? "Your library was refreshed a moment ago"
    : fetching
    ? "Reading your Steam library"
    : failed
      ? "Your import is paused"
      : complete
        ? wasFirstImport
          ? `${steamImport.total} games imported. Ready for your first pick?`
          : "Your Steam library is ready"
        : "Building your dashboard";
  const detail = steamLibraryPrivate
    ? "Your sign-in worked. Steam will not tell us what you own until Game details is public — it is the only setting we read, and it takes about twenty seconds."
    : coolingDown
    ? `Steam limits how often a library can be re-read. You can try again in ${waitLabel}.`
    : fetching
    ? "Steam sends the ownership list once, then we save it in small batches."
    : failed
      ? (steamImport.lastError || "The next batch was not saved. Everything shown in the bar is already safe.")
      : complete
        ? wasFirstImport
          ? "Tell the Vault how long you have and what you are in the mood for, and it will pick one."
          : `All ${steamImport.total} games saved. Artwork and length estimates continue below.`
        : `${steamImport.imported} of ${steamImport.total} games saved to VaultShuffle.`;

  function retry() {
    const canResume = steamImport.total > steamImport.imported;
    setEngaged(true);
    void syncSteamLibrary({ restart: !canResume }).catch(() => undefined);
  }

  return (
    <section className={`${styles.card}${failed ? ` ${styles.failed}` : ""}`} aria-live="polite">
      <span className={styles.icon}><VaultIcon name={complete ? "check" : "steam-data"} size={23} /></span>
      <div className={styles.copy}>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      {complete && wasFirstImport ? (
        <Link
          className={styles.handoff}
          href="/vault"
          onClick={() => {
            setJustFinished(false);
            trackEvent(ANALYTICS_EVENTS.onboardingHandoffTaken, { games: steamImport.total });
          }}
        >
          Choose what to play<VaultIcon name="chevron-right" size={16} />
        </Link>
      ) : null}

      {steamLibraryPrivate ? (
        <div className={styles.privateFix}>
          <ol>
            <li>Open your <a href={privacyUrl} target="_blank" rel="noreferrer">Steam privacy settings</a></li>
            <li>Set <strong>Game details</strong> to <strong>Public</strong> — the only setting we read</li>
            <li>Come back and try again</li>
          </ol>
          <button type="button" onClick={retry} disabled={isSyncing}>
            {isSyncing ? "Checking…" : "I've made it public — try again"}
          </button>
        </div>
      ) : null}

      <div className={styles.progressBlock} hidden={steamLibraryPrivate}>
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
        <p className={styles.progressMeta}>
          <strong>{fetching ? "Connecting…" : `${steamImport.percent}%`}</strong>
          {!fetching && steamImport.total ? <span>{steamImport.imported} / {steamImport.total}</span> : null}
        </p>
        {/* During a cooldown the button counts down and stays disabled, rather
            than inviting a press that the window will only refuse again. */}
        {coolingDown ? (
          <button type="button" disabled>
            {cooldownSecondsLeft >= 60
              ? `Try again in ${waitLabel}`
              : `Try again in ${cooldownSecondsLeft}s`}
          </button>
        ) : failed ? (
          <button type="button" onClick={retry} disabled={isSyncing}>
            {isSyncing ? "Resuming…" : steamImport.total > steamImport.imported ? "Resume import" : "Try Steam again"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
