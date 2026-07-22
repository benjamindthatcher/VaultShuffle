"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Artwork } from "@/components/shared/Artwork";
import { BrandedIcon } from "@/components/shared/BrandedIcon";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ScrollControls } from "@/components/shared/ScrollControls";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { formatDurationEstimate, getPreferredDurationMinutes } from "@/lib/game-duration";
import { steamLaunchUrl } from "@/lib/steam-images";
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
};

export function LibraryDetailsDrawer({ game, collections, onSave, onToggleCollection, saving, onClose, pinSlot = null, pinCount = 0, onTogglePin, onManagePins, onComplete, onRestore }: LibraryDetailsDrawerProps) {
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
  const timeToBeatMinutes = getPreferredDurationMinutes(game.duration);

  return createPortal(
    <>
      <button type="button" className={styles.overlay} onClick={onClose} aria-label="Close game details" />
      <aside ref={drawerRef} className={styles.drawer} role="dialog" aria-modal="true" aria-label={`${game.title} details`}>
        <ScrollControls targetRef={drawerRef} axis="vertical" label="Scroll game details" />
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
          <div className={styles.pinControl}>
            <div><strong>{pinSlot ? `Pinned in slot ${pinSlot}` : pinCount >= 3 ? "Pins full · 3/3" : "Pin game"}</strong><span>{pinSlot ? "Kept at the front of your Active Library." : `Keep it at the front of your Library · ${pinCount}/3 used`}</span></div>
            <div className={styles.pinActions}>
              <button type="button" onClick={pinSlot || pinCount < 3 ? onTogglePin : onManagePins}>{pinSlot ? "Unpin" : pinCount >= 3 ? "Manage Pins" : "Pin game"}</button>
              {game.status === "Completed" ? <button type="button" className={styles.restoreButton} disabled={saving} onClick={() => void onRestore?.()}><BrandedIcon group="actions" name="restore-active" size={22} />Restore to Active</button> : <button type="button" disabled={saving} onClick={() => void onComplete?.()}>Mark as Completed</button>}
            </div>
          </div>

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
              <dd>{formatDurationEstimate(timeToBeatMinutes)}</dd>
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
              href={steamLaunchUrl(game.steamAppId)}
            >
              <VaultIcon name="play-now" size={20} />
              <span>Play on Steam</span>
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
