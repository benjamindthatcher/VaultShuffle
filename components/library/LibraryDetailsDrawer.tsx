"use client";

import type { CSSProperties } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Artwork } from "@/components/shared/Artwork";
import { useIsMounted } from "@/components/shared/useIsMounted";
import { useSteamPlayLink } from "@/components/shared/useSteamLaunch";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import { buildPinnedRunSummary } from "@/lib/pinned-run";
import { progressLabel } from "@/lib/progress-display";
import type { VaultPin } from "@/lib/vault-state";
import styles from "./LibraryDetailsDrawer.module.css";

type LibraryDetailsDrawerProps = {
  game: DemoGame | null;
  collections: DemoCollection[];
  onSave: (patch: { notes: string }) => Promise<void>;
  onToggleCollection: (collectionId: string, assigned: boolean) => Promise<void>;
  saving: boolean;
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
  onSave,
  onToggleCollection,
  saving,
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
  const [notes, setNotes] = useState("");
  const [updatingCollectionId, setUpdatingCollectionId] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Adjusted during render rather than in an effect, so opening a second game
  // never paints the previous game's notes for a frame first.
  const [notesFor, setNotesFor] = useState(game?.id ?? null);
  if (game && game.id !== notesFor) {
    setNotesFor(game.id);
    setNotes(game.notes || "");
  }

  const openGameId = game?.id ?? null;
  useEffect(() => {
    if (!mounted || !openGameId) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

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
      previousFocus?.focus();
    };
  }, [mounted, openGameId]);

  if (!mounted || !game) return null;

  const isPinnedSpotlight = variant === "pinned";
  const relatedCollections = collections.filter((collection) => game.collectionIds.includes(collection.id));
  const durationLabel = formatGameDuration(game.duration);
  const pinLabel = pinSlot ? "Unpin game" : pinCount >= 3 ? "Manage pins" : "Pin game";
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
      onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.gameSteamOpened, {
        action: previewMode ? "view_store" : "launch_game",
        source: isPinnedSpotlight ? "pinned_details" : "game_details",
      })}
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
          <Artwork src={game.bannerUrl} sizes="(max-width: 520px) 100vw, 980px" priority />
          {isPinnedSpotlight ? (
            <>
              <span className={styles.heroShade} aria-hidden="true" />
              <button ref={closeButtonRef} type="button" className={styles.heroClose} onClick={onClose} aria-label="Close game details">
                <VaultIcon name="close" size={20} />
              </button>
            </>
          ) : null}
        </div>

        <div className={styles.body}>
          {isPinnedSpotlight && pinnedRun ? (
            <div className={styles.pinnedLayout}>
              <section className={styles.pinnedOverview} aria-labelledby={titleId}>
                <div className={styles.header}>
                  <div>
                    <p className={styles.eyebrow}>{`Playing next · ${pinSlot ?? 1} of 3`}</p>
                    <h2 className={styles.title} id={titleId}>{game.title}</h2>
                  </div>
                </div>

                <p className={styles.pinnedLead} id={descriptionId}>You chose this for next. Give it the session you saved it for.</p>

                <dl className={styles.spotlightStats}>
                  <div>
                    <VaultIcon name="play-now" size={18} />
                    <span><dt>Status</dt><dd>{game.status}</dd></span>
                  </div>
                  <div>
                    <VaultIcon name="playtime" size={18} />
                    <span><dt>Playtime (all time)</dt><dd>{`${game.hoursPlayed}h`}</dd></span>
                  </div>
                  <div>
                    <VaultIcon name="clock" size={18} />
                    <span><dt>Estimated length</dt><dd>{durationLabel ?? "Not available"}</dd></span>
                  </div>
                  <div>
                    <VaultIcon name="collections" size={18} />
                    <span>
                      <dt>Collections</dt>
                      <dd>{relatedCollections.length ? relatedCollections.map((collection) => collection.name).join(", ") : "None yet"}</dd>
                    </span>
                  </div>
                </dl>

                <label className={styles.spotlightNotes}>
                  <span><VaultIcon name="details" size={17} />Notes</span>
                  <textarea aria-label="Edit notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Add a note about this game..." />
                </label>

                <div className={styles.spotlightFooter}>
                  <div className={styles.metadataRow}>
                    {game.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
                  </div>
                  <button
                    type="button"
                    className={styles.saveButton}
                    onClick={async () => {
                      await onSave({ notes });
                      onClose();
                    }}
                    disabled={saving}
                  >
                    {saving ? "Saving..." : "Save note"}
                  </button>
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
                        ? `${pinnedRun.percent}% complete. Progress since pinning is not available yet.`
                        : `${pinnedRun.percent}% complete, including ${pinnedRun.earnedPercent}% since pinning.`}
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
                        <><span><i data-tone="before" />Before pin</span><span><i data-tone="since" />Since pin</span></>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className={styles.openEndedNote}>This one has no honest finish-line percentage, so your run is measured in playtime.</p>
                )}

                <ul className={styles.commitmentFacts}>
                  <li><VaultIcon name="clock" size={16} />{pinnedRun.pinnedLabel}</li>
                  {pinnedRun.trackedHoursLabel ? <li data-positive={pinnedRun.trackedHours && pinnedRun.trackedHours > 0.1 ? "true" : undefined}><VaultIcon name="play-now" size={16} />{pinnedRun.trackedHoursLabel}</li> : null}
                  {pinnedRun.remainingLabel ? <li><VaultIcon name="clock" size={16} />{pinnedRun.remainingLabel}</li> : null}
                  <li><VaultIcon name="playtime" size={16} />{pinnedRun.totalPlaytimeLabel}</li>
                </ul>

                <div className={styles.pinnedActions}>
                  {steamAction}
                  <div className={styles.pinnedUtilities} role="group" aria-label="Pinned game actions">
                    {game.status === "Completed" || game.status === "Slept" ? (
                      <button type="button" disabled={saving || !onRestore} onClick={() => void onRestore?.()}><VaultIcon name="restore-active" size={18} /><span>Restore</span></button>
                    ) : (
                      <button type="button" disabled={!onTogglePin} onClick={onTogglePin}><VaultIcon name="unpin" size={18} /><span>Unpin</span></button>
                    )}
                    {game.status === "Completed" ? (
                      <button type="button" disabled={saving || !onSleep} onClick={() => void onSleep?.()}><VaultIcon name="sleep" size={18} /><span>Sleep</span></button>
                    ) : game.status === "Slept" ? (
                      <button type="button" disabled={saving || !onComplete} onClick={() => void onComplete?.()}><VaultIcon name="mark-completed" size={18} /><span>Mark complete</span></button>
                    ) : (
                      <>
                        <button type="button" disabled={saving || !onSleep} onClick={() => void onSleep?.()}><VaultIcon name="sleep" size={18} /><span>Sleep</span></button>
                        <button type="button" disabled={saving || !onComplete} onClick={() => void onComplete?.()}><VaultIcon name="mark-completed" size={18} /><span>Mark complete</span></button>
                      </>
                    )}
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <>
              <div className={styles.header}>
                <div>
                  <p className={styles.eyebrow}>Game details</p>
                  <h2 className={styles.title} id={titleId}>{game.title}</h2>
                </div>
                <button ref={closeButtonRef} type="button" className={styles.closeButton} onClick={onClose}>
                  Close
                </button>
              </div>

              <p className={styles.copy} id={descriptionId}>{game.description}</p>
              {game.status === "Completed" || game.status === "Slept" ? (
                <div className={styles.quickActions} role="group" aria-label={`${game.status} game actions`}>
                  <button type="button" title="Restore to Active" aria-label="Restore to Active" disabled={saving || !onRestore} onClick={() => void onRestore?.()}><VaultIcon name="restore-active" size={30} /></button>
                  {game.status === "Completed"
                    ? <button type="button" title="Move to Slept" aria-label="Move to Slept" disabled={saving || !onSleep} onClick={() => void onSleep?.()}><VaultIcon name="sleep" size={30} /></button>
                    : <button type="button" title="Mark as Completed" aria-label="Mark as Completed" disabled={saving || !onComplete} onClick={() => void onComplete?.()}><VaultIcon name="mark-completed" size={30} /></button>}
                </div>
              ) : (
                <div className={styles.quickActions} role="group" aria-label="Game actions">
                  <button type="button" title={pinLabel} aria-label={pinLabel} disabled={!pinHandler} onClick={pinHandler}><VaultIcon name={pinSlot ? "unpin" : pinCount >= 3 ? "manage-pins" : "pin"} size={30} /></button>
                  <button type="button" title="Sleep game" aria-label="Sleep game" disabled={saving || !onSleep} onClick={() => void onSleep?.()}><VaultIcon name="sleep" size={30} /></button>
                  <button type="button" title="Mark as Completed" aria-label="Mark as Completed" disabled={saving || !onComplete} onClick={() => void onComplete?.()}><VaultIcon name="mark-completed" size={30} /></button>
                </div>
              )}

              <div className={styles.metadataRow}>
                {game.genres.map((genre) => <span key={genre}>{genre}</span>)}
                <span>{game.addedLabel}</span>
              </div>

              <dl className={styles.statGrid}>
                <div><dt>Status</dt><dd>{game.status}</dd></div>
                <div><dt>Progress</dt><dd>{progressLabel(game)}</dd></div>
                <div><dt>Playtime</dt><dd>{`${game.hoursPlayed}h`}</dd></div>
                <div><dt>How long to beat</dt><dd>{durationLabel ?? "Not available"}</dd></div>
              </dl>

              <fieldset className={styles.collectionSection}>
                <p className={styles.sectionLabel}>Collections</p>
                <div className={styles.collectionRow}>
                  {collections.filter((collection) => collection.kind === "custom").map((collection) => {
                    const assigned = game.collectionIds.includes(collection.id);
                    return (
                      <label key={collection.id} className={assigned ? `${styles.collectionPill} ${styles.collectionPillActive}` : styles.collectionPill}>
                        <input
                          type="checkbox"
                          checked={assigned}
                          disabled={updatingCollectionId === collection.id}
                          onChange={async (event) => {
                            setUpdatingCollectionId(collection.id);
                            try {
                              await onToggleCollection(collection.id, event.target.checked);
                            } finally {
                              setUpdatingCollectionId(null);
                            }
                          }}
                        />
                        {collection.name}
                      </label>
                    );
                  })}
                  {!relatedCollections.length ? <span className={styles.collectionHint}>Not assigned yet</span> : null}
                </div>
              </fieldset>

              <div className={styles.editorGrid}>
                <label className={`${styles.field} ${styles.fieldWide}`}>
                  <span>Notes</span>
                  <textarea aria-label="Edit notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} />
                </label>
              </div>

              <div className={styles.actionRow}>
                {steamAction}
                <button
                  type="button"
                  className={styles.saveButton}
                  onClick={async () => {
                    await onSave({ notes });
                    onClose();
                  }}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save changes"}
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </>,
    document.body
  );
}
