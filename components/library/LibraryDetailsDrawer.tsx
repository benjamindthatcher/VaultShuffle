"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import { steamLaunchUrl, steamStoreUrl } from "@/lib/steam-images";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
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
  onTogglePin?: () => void;
  onManagePins?: () => void;
  onComplete?: () => Promise<void>;
  onRestore?: () => Promise<void>;
  onSleep?: () => Promise<void>;
  previewMode?: boolean;
};

export function LibraryDetailsDrawer({ game, collections, onSave, onToggleCollection, saving, onClose, pinSlot = null, pinCount = 0, onTogglePin, onManagePins, onComplete, onRestore, onSleep, previewMode = false }: LibraryDetailsDrawerProps) {
  const [mounted, setMounted] = useState(false);
  const [notes, setNotes] = useState("");
  const [updatingCollectionId, setUpdatingCollectionId] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!game) return;
    setNotes(game.notes || "");
  }, [game]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!game) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [game, onClose]);

  if (!mounted || !game) return null;

  const relatedCollections = collections.filter((collection) => game.collectionIds.includes(collection.id));
  const durationLabel = formatGameDuration(game.duration);
  const pinLabel = pinSlot ? "Unpin game" : pinCount >= 3 ? "Manage pins" : "Pin game";
  const pinHandler = pinSlot || pinCount < 3 ? onTogglePin : onManagePins;

  return createPortal(
    <>
      <button type="button" className={styles.overlay} onClick={onClose} aria-label="Close game details" />
      <aside ref={drawerRef} className={styles.drawer} role="dialog" aria-modal="true" aria-label={`${game.title} details`}>
        <div className={styles.hero}>
          <Artwork src={game.bannerUrl} sizes="(max-width: 520px) 100vw, 520px" priority />
        </div>
        <div className={styles.body}>
          <div className={styles.header}>
            <div>
              <p className={styles.eyebrow}>Game details</p>
              <h2 className={styles.title}>{game.title}</h2>
            </div>
            <button type="button" className={styles.closeButton} onClick={onClose}>
              Close
            </button>
          </div>

          <p className={styles.copy}>{game.description}</p>
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
            <div>
              <dt>Status</dt>
              <dd>{game.status}</dd>
            </div>
            <div>
              <dt>Progress</dt>
              <dd>{game.completionPercent}%</dd>
            </div>
            <div>
              <dt>Playtime</dt>
              <dd>{game.hoursPlayed}h</dd>
            </div>
            <div>
              <dt>How long to beat</dt>
              <dd>{durationLabel ?? "Not available"}</dd>
            </div>
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
            <a
              className={styles.steamButton}
              href={previewMode ? steamStoreUrl(game.steamAppId) : steamLaunchUrl(game.steamAppId)}
              target={previewMode ? "_blank" : undefined}
              rel={previewMode ? "noreferrer" : undefined}
              onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.gameSteamOpened, {
                action: previewMode ? "view_store" : "launch_game",
                preview_mode: previewMode,
              })}
            >
              <VaultIcon name="open-steam" size={20} />
              <span>{previewMode ? "View on Steam" : "Play on Steam"}</span>
              <VaultIcon name="chevron-right" size={18} className={styles.steamArrow} />
            </a>
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
        </div>
      </aside>
    </>,
    document.body
  );
}
