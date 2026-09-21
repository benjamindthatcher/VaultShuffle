"use client";

import { useEffect, useRef, useState } from "react";
import type { DemoGame } from "@/lib/demo-data";
import { LibraryGameCard } from "./LibraryGameCard";
import styles from "./LibraryGameGrid.module.css";

type LibraryGameGridProps = {
  games: DemoGame[];
  viewMode: "grid" | "list";
  onSelect: (gameId: string) => void;
  onComplete: (gameId: string) => void;
  onRestore: (gameId: string) => void;
  onBlacklist: (gameId: string) => void;
  onTogglePin: (game: DemoGame) => void;
  pinnedIds: string[];
  /** Only browsing controls reset pagination; mutations preserve scroll depth. */
  resetKey: string;
  /** Selection is a separate checkbox; the card always opens details. */
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (gameId: string) => void;
};

/**
 * How many cards are mounted before scrolling asks for more.
 *
 * Steam is a platform where owning 1,500 games is unremarkable, and one account
 * here already has 1,748. Mapping the whole filtered set built that many React
 * components, each with state, refs and an image, in a single pass. Images were
 * already lazy, so this is about the component tree rather than bandwidth.
 *
 * Search, sort and filter still run over everything - only what is mounted is
 * limited, so nothing is hidden from the controls.
 */
const INITIAL_RENDER_COUNT = 60;
const RENDER_BATCH = 60;

export function LibraryGameGrid({ games, viewMode, onSelect, onComplete, onRestore, onBlacklist, onTogglePin, pinnedIds = [], resetKey, selectable = false, selectedIds, onToggleSelect }: LibraryGameGridProps) {
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setRenderCount(INITIAL_RENDER_COUNT);
  }

  const visible = games.length <= renderCount ? games : games.slice(0, renderCount);
  const hasMore = visible.length < games.length;

  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    // Fires before the sentinel is actually on screen, so the next batch is
    // mounted by the time the reader gets there.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRenderCount((current) => current + RENDER_BATCH);
        }
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, visible.length]);

  return (
    <>
      <div className={viewMode === "list" ? `${styles.grid} ${styles.gridList}` : styles.grid}>
        {visible.map((game) => (
          <LibraryGameCard
            key={game.id}
            game={game}
            layout={viewMode}
            onSelect={() => onSelect(game.id)}
            onComplete={() => onComplete(game.id)}
            onRestore={() => onRestore(game.id)}
            onBlacklist={() => onBlacklist(game.id)}
            onPlayingNext={() => onTogglePin(game)}
            pinned={pinnedIds.includes(game.id)}
            selectable={selectable}
            selected={selectedIds?.has(game.id) ?? false}
            onToggleSelect={() => onToggleSelect?.(game.id)}
          />
        ))}
      </div>

      {hasMore ? (
        <div ref={sentinelRef} className={styles.more} role="status">
          Showing {visible.length} of {games.length}
        </div>
      ) : null}
    </>
  );
}
