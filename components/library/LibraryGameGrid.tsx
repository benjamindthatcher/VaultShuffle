"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DemoGame } from "@/lib/demo-data";
import { GameCard } from "@/components/shared/GameCard";
import styles from "./LibraryGameGrid.module.css";

type LibraryGameGridProps = {
  games: DemoGame[];
  viewMode: "grid" | "list";
  onSelect: (gameId: string) => void;
  onComplete: (gameId: string) => void;
  onRestore: (gameId: string) => void;
  onSleep: (gameId: string) => void;
  onTogglePin: (game: DemoGame) => void;
  pinnedIds: string[];
  /** Set on the decided shelves - slept and completed - where the card picks
   *  rather than opens. Absent on active, which stays a way into the details. */
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

export function LibraryGameGrid({ games, viewMode, onSelect, onComplete, onRestore, onSleep, onTogglePin, pinnedIds = [], selectable = false, selectedIds, onToggleSelect }: LibraryGameGridProps) {
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // A new filter or sort is a new list, so start from the top again rather than
  // keeping however far the previous one had been scrolled through.
  //
  // Adjusted during render rather than in an effect: React re-runs this pass
  // immediately with the new value, so the grid never paints the old count and
  // there is no flash of the previous list's length.
  const signature = useMemo(() => `${games.length}:${games[0]?.id ?? ""}:${viewMode}`, [games, viewMode]);
  const [lastSignature, setLastSignature] = useState(signature);
  if (signature !== lastSignature) {
    setLastSignature(signature);
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
          <GameCard
            key={game.id}
            game={game}
            layout={viewMode}
            onClick={() => onSelect(game.id)}
            onComplete={game.status !== "Completed" ? () => onComplete(game.id) : undefined}
            onRestore={game.status === "Completed" || game.status === "Slept" ? () => onRestore(game.id) : undefined}
            onSleep={game.status !== "Slept" ? () => onSleep(game.id) : undefined}
            onTogglePin={game.status !== "Completed" && game.status !== "Slept" ? () => onTogglePin(game) : undefined}
            pinned={pinnedIds.includes(game.id)}
            showProgress
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
