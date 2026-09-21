"use client";

import type { CSSProperties } from "react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Artwork } from "@/components/shared/Artwork";
import { useIsMounted } from "@/components/shared/useIsMounted";
import { useSteamPlayLink } from "@/components/shared/useSteamLaunch";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import { buildPinnedRunSummary } from "@/lib/pinned-run";
import type { VaultPin } from "@/lib/vault-state";
import { familyProvenance, isFamilyAccess } from "@/lib/family-sharing";
import { FamilyMark } from "@/components/shared/FamilyMark";
import { LibraryGameActions } from "./LibraryGameActions";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
import styles from "./LibraryDetailsDrawer.module.css";

type LibraryDetailsDrawerProps = {
  game: DemoGame | null;
  collections: DemoCollection[];
  onSave?: (patch: { notes: string }) => Promise<void>;
  onToggleCollection?: (collectionId: string, assigned: boolean) => Promise<void>;
  saving?: boolean;
  onClose: () => void;
  pinSlot?: number | null;
  pinCount?: number;
  pin?: VaultPin;
  variant?: "library" | "pinned";
  onTogglePin?: () => void;
  onManagePins?: () => void;
  onComplete?: () => Promise<void>;
  onRestore?: () => Promise<void>;
  onSleep?: () => Promise<void>;
  previewMode?: boolean;
};

export function LibraryDetailsDrawer({
  game,
  collections,
  onClose,
  pinSlot = null,
  pinCount = 0,
  pin,
  variant = "library",
  onTogglePin,
  onManagePins,
  onComplete,
  onRestore,
  onSleep,
  previewMode = false,
}: LibraryDetailsDrawerProps) {
  const steamLink = useSteamPlayLink(game?.steamAppId, { forceStore: previewMode });
  const mounted = useIsMounted();
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const openGameId = game?.id ?? null;
  useEffect(() => {
    if (!mounted || !openGameId) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));

    function handleDialogKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) {
        event.preventDefault();
        drawerRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeydown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKeydown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [mounted, openGameId]);

  if (!mounted || !game) return null;

  const isPinnedSpotlight = variant === "pinned";
  const relatedCollections = collections.filter((collection) => game.collectionIds.includes(collection.id));
  const durationLabel = formatGameDuration(game.duration);
  // The card carries an icon; this is the one place with room to say what it
  // means. One line, not a panel. See lib/family-sharing.ts.
  const familyLine = familyProvenance(game);
  const pinHandler = pinSlot || pinCount < 3 ? onTogglePin : onManagePins;
  const pinnedRun = isPinnedSpotlight ? buildPinnedRunSummary(game, pin) : null;
  const progressStyle = pinnedRun?.percent === null || pinnedRun?.percent === undefined ? undefined : {
    "--pinned-before": `${pinnedRun.beforePercent ?? pinnedRun.percent}%`,
    "--pinned-progress": `${pinnedRun.percent}%`,
  } as CSSProperties;

  const steamAction = (
    <a
      className={styles.steamButton}
      href={steamLink.href}
      target={steamLink.target}
      rel={steamLink.rel}
      onClick={() => {
        if (steamLink.launching && pinSlot) trackNavigationEvent(ANALYTICS_EVENTS.playingNextGameLaunched, {
          game_id: game.id, steam_app_id: game.steamAppId, source: `${window.location.pathname.split("/")[1] || "library"}_details`,
        });
      }}
    >
      <VaultIcon name={steamLink.launching ? "play-now" : "open-steam"} size={20} />
      <span>{steamLink.launching ? (isPinnedSpotlight ? "Play now on Steam" : "Play on Steam") : "View on Steam"}</span>
      <VaultIcon name="chevron-right" size={18} className={styles.steamArrow} />
    </a>
  );

  return createPortal(
    <>
      <button type="button" className={styles.overlay} onClick={onClose} aria-label="Close game details" />
      <aside
        ref={drawerRef}
        className={styles.drawer}
        data-variant={isPinnedSpotlight ? "pinned" : "library"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className={styles.hero}>
          {isPinnedSpotlight ? (
            <>
              <Artwork
                src={game.bannerUrl}
                className={styles.heroAmbient}
                sizes="(max-width: 520px) 100vw, 1080px"
              />
              <span className={styles.heroArtworkFrame}>
                <Artwork
                  src={game.bannerUrl}
                  className={styles.heroArtwork}
                  sizes="(max-width: 520px) 100vw, 1080px"
                  fit="contain"
                  priority
                />
              </span>
              <span className={styles.heroShade} aria-hidden="true" />
              <button ref={closeButtonRef} type="button" className={styles.heroClose} onClick={onClose} aria-label="Close game details">
                <VaultIcon name="close" size={20} />
              </button>
            </>
          ) : (
            <>
              <Artwork src={game.bannerUrl} sizes="(max-width: 600px) 100vw, 560px" priority />
              <button ref={closeButtonRef} type="button" className={styles.heroClose} onClick={onClose} aria-label="Close game details"><VaultIcon name="close" size={20} /></button>
            </>
          )}
        </div>

        <div className={styles.body}>
          {isPinnedSpotlight && pinnedRun ? (
            <div className={styles.pinnedLayout}>
              <section className={styles.pinnedOverview} aria-labelledby={titleId}>
                <div className={styles.header}>
                  <div>
                    <p className={styles.eyebrow}>{`Playing Next · ${pinSlot ?? 1} of 3`}</p>
                    <h2 className={styles.title} id={titleId}>
                      {game.title}
                      {familyLine ? <FamilyMark title={familyLine} /> : null}
                    </h2>
                  </div>
                </div>

                <p className={styles.pinnedLead} id={descriptionId}>You chose this for next. Give it the session you saved it for.</p>

                <dl className={styles.spotlightStats}>
                  <div>
                    <VaultIcon name="play-now" size={18} />
                    <span><dt>Status</dt><dd>{game.status === "Slept" ? "Blacklisted" : game.status}</dd></span>
                  </div>
                  <div>
                    <VaultIcon name="playtime" size={18} />
                    <span><dt>Playtime (all time)</dt><dd>{isFamilyAccess(game.accessSource) ? "Not available" : `${game.hoursPlayed}h`}</dd></span>
                  </div>
                  <div>
                    <VaultIcon name="clock" size={18} />
                    <span><dt>Estimated length</dt><dd>{durationLabel ?? "Not available"}</dd></span>
                  </div>
                  <div>
                    <VaultIcon name="collections" size={18} />
                    <span>
                      <dt>Collections</dt>
                      <dd>{`${relatedCollections.length} ${relatedCollections.length === 1 ? "collection" : "collections"}`}</dd>
                    </span>
                  </div>
                </dl>

                <div className={styles.metadataRow}>
                  {game.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
                </div>
              </section>

              <section className={styles.commitment} aria-labelledby={`${titleId}-commitment`}>
                <div className={styles.commitmentCopy}>
                  <p className={styles.sectionLabel}>Your commitment</p>
                  <h3 id={`${titleId}-commitment`}>{pinnedRun.headline}</h3>
                  <p>{pinnedRun.message}</p>
                </div>

                {pinnedRun.percent !== null ? (
                  <div className={styles.pinnedGauge} style={progressStyle} aria-hidden="true">
                    <span><strong>{pinnedRun.percent}<small>%</small></strong><em>complete</em></span>
                  </div>
                ) : (
                  <div className={`${styles.pinnedGauge} ${styles.pinnedGaugeOpen}`} aria-hidden="true">
                    <VaultIcon name="playtime" size={28} />
                  </div>
                )}

                {pinnedRun.percent !== null ? (
                  <div className={styles.pinnedProgress}>
                    <div
                      className={styles.pinnedTrack}
                      role="progressbar"
                      aria-label={pinnedRun.earnedPercent === null
                        ? `${pinnedRun.percent}% complete. Progress since adding to Playing Next is not available yet.`
                        : `${pinnedRun.percent}% complete, including ${pinnedRun.earnedPercent}% since adding to Playing Next.`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pinnedRun.percent}
                    >
                      <span className={styles.pinnedBefore} style={{ width: `${pinnedRun.beforePercent ?? pinnedRun.percent}%` }} />
                      {pinnedRun.beforePercent !== null ? (
                        <span className={styles.pinnedSince} style={{ left: `${pinnedRun.beforePercent}%`, width: `${pinnedRun.earnedPercent ?? 0}%` }} />
                      ) : null}
                      {pinnedRun.beforePercent !== null && (pinnedRun.earnedPercent ?? 0) > 0 ? (
                        <span className={styles.pinnedNotch} style={{ left: `${pinnedRun.beforePercent}%` }} />
                      ) : null}
                    </div>
                    <div className={styles.progressLegend}>
                      {pinnedRun.beforePercent === null ? (
                        <span>Current story progress</span>
                      ) : (
                        <><span><i data-tone="before" />Before adding</span><span><i data-tone="since" />Since adding</span></>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className={styles.openEndedNote}>
                    {pinnedRun.sharedFrom
                      ? `Shared from ${pinnedRun.sharedFrom}'s library, so Steam reports their hours rather than yours. Your choice still holds; the progress bar cannot.`
                      : "This one has no honest finish-line percentage, so your run is measured in playtime."}
                  </p>
                )}

                <ul className={styles.commitmentFacts}>
                  <li><VaultIcon name="clock" size={16} />{pinnedRun.pinnedLabel}</li>
                  {pinnedRun.trackedHoursLabel ? <li data-positive={pinnedRun.trackedHours && pinnedRun.trackedHours > 0.1 ? "true" : undefined}><VaultIcon name="play-now" size={16} />{pinnedRun.trackedHoursLabel}</li> : null}
                  {pinnedRun.remainingLabel ? <li><VaultIcon name="clock" size={16} />{pinnedRun.remainingLabel}</li> : null}
                  {pinnedRun.totalPlaytimeLabel
                    ? <li><VaultIcon name="playtime" size={16} />{pinnedRun.totalPlaytimeLabel}</li>
                    : durationLabel ? <li><VaultIcon name="clock" size={16} />{durationLabel} to beat</li> : null}
                  {pinnedRun.sharedFrom
                    ? <li><VaultIcon name="family" size={16} />From {pinnedRun.sharedFrom}&rsquo;s library</li>
                    : null}
                </ul>

                <div className={styles.pinnedActions}>
                  {steamAction}
                  <LibraryGameActions status={game.status} pinned={Boolean(pinSlot)} onBlacklist={onSleep ? () => void onSleep().catch(() => undefined) : undefined} onComplete={onComplete ? () => void onComplete().catch(() => undefined) : undefined} onRestore={onRestore ? () => void onRestore().catch(() => undefined) : undefined} onPlayingNext={pinHandler} />
                </div>
              </section>
            </div>
          ) : (
            <>
              <div className={styles.header}>
                <div>
                  <p className={styles.eyebrow}>Game details</p>
                  <h2 className={styles.title} id={titleId}>{game.title}{familyLine ? <FamilyMark title={familyLine} /> : null}</h2>
                </div>
              </div>
              <p className={styles.copy} id={descriptionId}>{game.description}</p>
              {familyLine ? <p className={styles.familyNotice}>{familyLine}</p> : null}
              <a className={styles.steamButton} href={`https://store.steampowered.com/app/${game.steamAppId}/`} target="_blank" rel="noopener noreferrer">
                <VaultIcon name="open-steam" size={20} /><span>View on Steam</span><VaultIcon name="chevron-right" size={18} className={styles.steamArrow} />
              </a>
              <LibraryGameActions status={game.status} pinned={Boolean(pinSlot)} onBlacklist={onSleep ? () => void onSleep().catch(() => undefined) : undefined} onComplete={onComplete ? () => void onComplete().catch(() => undefined) : undefined} onRestore={onRestore ? () => void onRestore().catch(() => undefined) : undefined} onPlayingNext={pinHandler} />
              <dl className={styles.gameInfo}>
                <div><VaultIcon name="play-now" size={21} /><span><dt>Status</dt><dd>{game.status === "Slept" ? "Blacklisted" : game.status}</dd></span></div>
                <div><VaultIcon name="playtime" size={21} /><span><dt>Playtime (all time)</dt><dd>{isFamilyAccess(game.accessSource) ? "Not available" : `${game.hoursPlayed}h`}</dd></span></div>
                <div><VaultIcon name="clock" size={21} /><span><dt>Estimated length</dt><dd>{durationLabel ?? "Not available"}</dd></span></div>
                <div><VaultIcon name="collections" size={21} /><span><dt>Collections</dt><dd>{`${relatedCollections.length} ${relatedCollections.length === 1 ? "collection" : "collections"}`}</dd></span></div>
              </dl>
              <div className={styles.metadataRow}>{game.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>
            </>
          )}
        </div>
      </aside>
    </>,
    document.body
  );
}
