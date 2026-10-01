"use client";

import { useEffect, useMemo, useState } from "react";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { DemoGame } from "@/lib/demo-data";
import styles from "./AddGamesDialog.module.css";
import { useV2Library } from "@/components/library/useV2Library";
import { globalFilterParams } from "@/lib/v2/filter-query";
import { DEFAULT_GLOBAL_FILTERS, type GlobalFilters } from "@/lib/global-filters";
import { FamilyGameMark } from "@/components/shared/FamilyMark";

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
  onClose,
  v2, collectionId, globalFilters, revision
}: {
  collectionName: string;
  games: DemoGame[];
  alreadyIn: Set<string>;
  saving: boolean;
  onAdd: (gameIds: string[]) => void;
  onClose: () => void;
  v2?: boolean; collectionId?: string; globalFilters?: GlobalFilters; revision?: number;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const params=`${globalFilterParams(globalFilters??DEFAULT_GLOBAL_FILTERS)}&section=all&sort=title&direction=asc&limit=60&exclude_collection=${encodeURIComponent(collectionId??"")}&search=${encodeURIComponent(query)}`;
  const remote=useV2Library(Boolean(v2),params,String(revision??0));

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const candidates = useMemo(() => {
    if(v2)return remote.games;
    const text = query.trim().toLowerCase();
    return games
      .filter((game) => !alreadyIn.has(game.id))
      .filter((game) => !text
        || game.title.toLowerCase().includes(text)
        || game.genres.join(" ").toLowerCase().includes(text))
      .slice(0, 120);
  }, [alreadyIn, games, query, v2, remote.games]);

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
          <button type="button" data-vault-control="tertiary" data-control-size="icon" className={styles.close} aria-label="Close" disabled={saving} onClick={onClose}>
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
                data-vault-card="interactive" disabled={saving || (!picked.includes(game.id) && picked.length >= 1000)} key={game.id}
                type="button"
                className={on ? styles.cardOn : styles.card}
                aria-pressed={on}
                onClick={() => toggle(game.id)}
              >
                <span className={styles.art}><Artwork src={game.bannerUrl} sizes="200px" /><FamilyGameMark game={game} overlay /></span>
                <span className={styles.name}>{game.title}</span>
                {on ? <span className={styles.tick} aria-hidden="true"><VaultIcon name="check" size={14} /></span> : null}
              </button>
            );
          }) : (
            <p className={styles.empty}>
              {v2 && remote.pending ? "Loading your games…" : v2 && remote.error ? "Your games could not be loaded." : query ? "Nothing in your library matches that." : "Every available game is already on this shelf."}
            </p>
          )}
          {v2&&remote.error?<div className={styles.paging} role="alert">{remote.error} <button type="button" data-vault-control="secondary" onClick={remote.retry}>Retry</button></div>:null}
          {v2&&remote.page?.nextCursor?<div className={styles.paging}><button type="button" data-vault-control="secondary" disabled={remote.pending} aria-busy={remote.pending} onClick={()=>{void remote.loadMore();}}>{remote.pending?<><span data-control-spinner aria-hidden="true" />Loading…</>:"Load more games"}</button></div>:null}
        </div>
        <footer className={styles.footer}>
          <span className={styles.count}>{picked.length ? `${picked.length} selected` : "Pick as many as you like"}</span>
          <div className={styles.footerActions}>
            <button type="button" data-vault-control="tertiary" className={styles.secondary} disabled={saving} onClick={onClose}>Cancel</button>
            <button
              type="button"
              data-vault-control="primary" aria-busy={saving} className={styles.primary}
              disabled={!picked.length || saving}
              onClick={() => onAdd(picked)}
            >{saving ? <span data-control-spinner aria-hidden="true" /> : null}{saving ? "Adding…" : `Add ${picked.length || ""} game${picked.length === 1 ? "" : "s"}`.replace("  ", " ")}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
