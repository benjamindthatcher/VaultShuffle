"use client";

import { useEffect, useState } from "react";
import { Artwork } from "@/components/shared/Artwork";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { steamStoreUrl } from "@/lib/steam-images";
import styles from "./LibraryDetailsDrawer.module.css";

type LibraryDetailsDrawerProps = {
  game: DemoGame | null;
  collections: DemoCollection[];
  onSave: (patch: { status: DemoGame["status"]; completionPercent: number; hoursPlayed: number; notes: string; priority: DemoGame["priority"] }) => Promise<void>;
  onToggleCollection: (collectionId: string, assigned: boolean) => Promise<void>;
  saving: boolean;
  onClose: () => void;
};

export function LibraryDetailsDrawer({ game, collections, onSave, onToggleCollection, saving, onClose }: LibraryDetailsDrawerProps) {
  const [status, setStatus] = useState<DemoGame["status"]>("Not Started");
  const [completion, setCompletion] = useState(0);
  const [hours, setHours] = useState(0);
  const [notes, setNotes] = useState("");
  const [priority, setPriority] = useState<DemoGame["priority"]>("Medium");
  const [updatingCollectionId, setUpdatingCollectionId] = useState<string | null>(null);

  useEffect(() => {
    if (!game) return;
    setStatus(game.status);
    setCompletion(game.completionPercent);
    setHours(game.hoursPlayed);
    setNotes(game.notes || "");
    setPriority(game.priority);
  }, [game]);

  useEffect(() => {
    if (!game) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [game, onClose]);

  if (!game) return null;

  const relatedCollections = collections.filter((collection) => game.collectionIds.includes(collection.id));

  return (
    <>
      <button type="button" className={styles.overlay} onClick={onClose} aria-label="Close game details" />
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label={`${game.title} details`}>
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
              <dt>Priority</dt>
              <dd>{game.priority}</dd>
            </div>
          </dl>

          <fieldset className={styles.collectionSection}>
            <p className={styles.sectionLabel}>Collections</p>
            <div className={styles.collectionRow}>
              {collections.filter((collection) => collection.kind !== "system").map((collection) => {
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
            <label className={styles.field}>
              <span>Status</span>
              <select aria-label="Edit status" value={status} onChange={(event) => setStatus(event.target.value as DemoGame["status"])}>
                <option value="Not Started">Not Started</option>
                <option value="In Progress">In Progress</option>
                <option value="Completed">Completed</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Completion %</span>
              <input aria-label="Edit completion percentage" type="number" min={0} max={100} value={completion} onChange={(event) => setCompletion(Number(event.target.value))} />
            </label>
            <label className={styles.field}>
              <span>Hours played</span>
              <input aria-label="Edit hours played" type="number" min={0} value={hours} onChange={(event) => setHours(Number(event.target.value))} />
            </label>
            <label className={styles.field}>
              <span>Priority</span>
              <select aria-label="Edit priority" value={priority} onChange={(event) => setPriority(event.target.value as DemoGame["priority"])}>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Must Play">Must Play</option>
              </select>
            </label>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span>Notes</span>
              <textarea aria-label="Edit notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} />
            </label>
          </div>

          <div className={styles.actionRow}>
            <a
              className={styles.steamButton}
              href={steamStoreUrl(game.steamAppId)}
              target="_blank"
              rel="noreferrer"
            >
              Open on Steam
            </a>
            <button
              type="button"
              className={styles.saveButton}
              onClick={() => onSave({ status, completionPercent: completion, hoursPlayed: hours, notes, priority })}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
