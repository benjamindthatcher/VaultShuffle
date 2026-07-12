"use client";

import { useEffect, useRef } from "react";
import type { DemoGame } from "@/lib/demo-data";
import type { VaultPoolEntry } from "@/lib/vault";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { candidateFallback } from "@/lib/vaultshuffle-assets";
import styles from "./VaultPoolPreview.module.css";

type VaultPoolPreviewProps = {
  entries: VaultPoolEntry[];
  drawState?: "idle" | "preparing" | "shuffling" | "settling" | "revealing" | "revealed" | "error";
  winnerId?: string | null;
  highlightedId?: string | null;
  onSelect?: (gameId: string) => void;
  pinnedIds?: string[];
  onTogglePin?: (gameId: string) => void;
};

export function VaultPoolPreview({ entries, drawState = "idle", winnerId = null, highlightedId = null, onSelect, pinnedIds = [], onTogglePin }: VaultPoolPreviewProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const isDrawing = drawState === "preparing" || drawState === "shuffling" || drawState === "settling" || drawState === "revealing";

  useEffect(() => {
    if (drawState !== "settling" || !winnerId) return;
    railRef.current?.querySelector<HTMLElement>(`[data-game-id="${CSS.escape(winnerId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [drawState, winnerId]);

  function moveRail(direction: -1 | 1) {
    railRef.current?.scrollBy({ left: direction * 520, behavior: "smooth" });
  }

  return (
    <div className={`${styles.railWrap} ${isDrawing ? styles.railActive : ""} ${styles[drawState] ?? ""}`} aria-busy={isDrawing}>
      {isDrawing ? <><span className={styles.selectionFrame} aria-hidden="true" /><span className={styles.lightSweep} aria-hidden="true" /></> : null}
      <button type="button" className={`${styles.arrow} ${styles.arrowLeft}`} aria-label="Previous games" onClick={() => moveRail(-1)}><VaultIcon name="chevron-left" /></button>
      <div className={styles.grid} ref={railRef}>
      {entries.map(({ game, score }, index) => {
        const isHighlighted = highlightedId === game.id;
        const match = Math.min(99, Math.max(72, 78 + score));
        return (
          <button
            type="button"
            key={game.id}
            className={isHighlighted ? `${styles.card} ${styles.cardHighlighted}` : styles.card}
            id={`vault-card-${game.id}`}
            data-game-id={game.id}
            data-winner={winnerId === game.id ? "true" : undefined}
            onClick={() => onSelect?.(game.id)}
            aria-label={`View details for ${game.title}`}
          >
            <div className={styles.cardArt}>
              <Artwork src={game.bannerUrl} fallbackSrc={candidateFallback(index)} sizes="(max-width: 720px) 44vw, 210px" />
              <span
                role="button"
                tabIndex={0}
                className={pinnedIds.includes(game.id) ? `${styles.heart} ${styles.heartActive}` : styles.heart}
                aria-label={pinnedIds.includes(game.id) ? `Unpin ${game.title}` : `Pin ${game.title}`}
                onClick={(event) => { event.stopPropagation(); onTogglePin?.(game.id); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onTogglePin?.(game.id); } }}
              ><VaultIcon name="heart" size={21} /></span>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.cardTopRow}>
                <h3 className={styles.cardTitle}>{game.title}</h3>
                <span className={styles.cardStatus}>{game.status}</span>
              </div>
              <p className={styles.cardCopy}>{game.description}</p>
              <div className={styles.tagRow}>{game.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}</div>
              <div className={styles.cardMeta}>
                <strong>{match}% Match</strong>
              </div>
            </div>
          </button>
        );
      })}
      </div>
      <button type="button" className={`${styles.arrow} ${styles.arrowRight}`} aria-label="Next games" onClick={() => moveRail(1)}><VaultIcon name="chevron-right" /></button>
      <div className={styles.progressTrack}><span /></div>
    </div>
  );
}
