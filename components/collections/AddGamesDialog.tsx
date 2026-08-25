"use client";

import { useEffect, useMemo, useState } from "react";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { DemoGame } from "@/lib/demo-data";
import styles from "./AddGamesDialog.module.css";

/**
 * Filling a collection from the collection.
 *
 * Building a custom shelf used to mean leaving for the Library, opening a game,
 * ticking a box, closing it, finding the next one, and repeating - so a shelf of
 * ten games took ten round trips through a different page. That is why the
 * production database held no custom collections at all.
 */
export function AddGamesDialog({
  collectionName,
  games,
  alreadyIn,
  saving,
  onAdd,
  onClose
}: {
  collectionName: string;
  games: DemoGame[];
  alreadyIn: Set<string>;
  saving: boolean;
  onAdd: (gameIds: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const candidates = useMemo(() => {
    const text = query.trim().toLowerCase();
    return games
      .filter((game) => !alreadyIn.has(game.id))
      .filter((game) => !text
        || game.title.toLowerCase().includes(text)
        || game.genres.join(" ").toLowerCase().includes(text))
      .slice(0, 120);
  }, [alreadyIn, games, query]);

  function toggle(gameId: string) {
    setPicked((current) => current.includes(gameId)
      ? current.filter((id) => id !== gameId)
      : [...current, gameId]);
  }

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={`Add games to ${collectionName}`}>
      <div className={styles.dialog}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Add games</p>
            <h2 className={styles.title}>{collectionName}</h2>
          </div>
          <button type="button" className={styles.close} aria-label="Close" disabled={saving} onClick={onClose}>
            <VaultIcon name="close" size={16} />
          </button>
        </header>

        <label className={styles.search}>
          <VaultIcon name="search" size={16} />
          <span className="visually-hidden">Search your games</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your games…"
          />
        </label>

        <div className={styles.grid}>
          {candidates.length ? candidates.map((game) => {
            const on = picked.includes(game.id);
            return (
              <button
                key={game.id}
                type="button"
                className={on ? styles.cardOn : styles.card}
                aria-pressed={on}
                onClick={() => toggle(game.id)}
              >
                <span className={styles.art}><Artwork src={game.bannerUrl} sizes="200px" /></span>
                <span className={styles.name}>{game.title}</span>
                {on ? <span className={styles.tick} aria-hidden="true"><VaultIcon name="check" size={14} /></span> : null}
              </button>
            );
          }) : (
            <p className={styles.empty}>
              {query ? "Nothing in your library matches that." : "Every game you own is already on this shelf."}
            </p>
          )}
        </div>

        <footer className={styles.footer}>
          <span className={styles.count}>{picked.length ? `${picked.length} selected` : "Pick as many as you like"}</span>
          <div className={styles.footerActions}>
            <button type="button" className={styles.secondary} disabled={saving} onClick={onClose}>Cancel</button>
            <button
              type="button"
              className={styles.primary}
              disabled={!picked.length || saving}
              onClick={() => onAdd(picked)}
            >{saving ? "Adding…" : `Add ${picked.length || ""} game${picked.length === 1 ? "" : "s"}`.replace("  ", " ")}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
