"use client";

import { useEffect, useRef, useState } from "react";
import type { VaultPoolEntry } from "@/lib/vault";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { candidateFallback } from "@/lib/vaultshuffle-assets";
import styles from "./VaultPoolPreview.module.css";

type VaultPoolPreviewProps = {
  entries: VaultPoolEntry[];
  drawState?: "idle" | "focusing" | "revealing" | "revealed" | "error";
  winner?: VaultPoolEntry["game"] | null;
  highlightedId?: string | null;
  onSelect?: (gameId: string) => void;
  pinnedIds?: string[];
  onTogglePin?: (gameId: string) => void;
};

export function VaultPoolPreview({ entries, drawState = "idle", winner = null, highlightedId = null, onSelect, pinnedIds = [], onTogglePin }: VaultPoolPreviewProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ progress: 0, ratio: 1 });
  const isDrawing = drawState === "focusing" || drawState === "revealing";

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const update = () => {
      const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
      setScrollState({
        progress: maxScroll ? rail.scrollLeft / maxScroll : 0,
        ratio: Math.min(1, rail.clientWidth / Math.max(rail.scrollWidth, 1))
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    rail.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); rail.removeEventListener("scroll", update); };
  }, [entries]);

  function moveRail(direction: -1 | 1) {
    railRef.current?.scrollBy({ left: direction * 520, behavior: "smooth" });
  }

  return (
    <div className={styles.railWrap} data-draw-state={drawState} aria-busy={isDrawing}>
      <div className={styles.lightSweep} aria-hidden="true" />
      <button type="button" className={`${styles.arrow} ${styles.arrowLeft}`} aria-label="Previous games" onClick={() => moveRail(-1)}><VaultIcon name="chevron-left" /></button>
      <div className={styles.grid} ref={railRef} aria-hidden={isDrawing || undefined}>
      {entries.map(({ game, score }, index) => {
        const isHighlighted = highlightedId === game.id;
        return (
          <button
            type="button"
            key={game.id}
            className={isHighlighted ? `${styles.card} ${styles.cardHighlighted}` : styles.card}
            id={`vault-card-${game.id}`}
            data-game-id={game.id}
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
                <strong>{candidateLabel(index, entries.length, score)}</strong>
              </div>
            </div>
          </button>
        );
      })}
      </div>
      <button type="button" className={`${styles.arrow} ${styles.arrowRight}`} aria-label="Next games" onClick={() => moveRail(1)}><VaultIcon name="chevron-right" /></button>
      {drawState === "revealing" && winner ? (
        <div className={styles.winnerOverlay} role="status" aria-label={`${winner.title} selected`}>
          <article className={styles.winnerCard}>
            <p className={styles.winnerLabel}>Selected winner</p>
            <div className={styles.winnerArtwork}><Artwork src={winner.bannerUrl} fallbackSrc={candidateFallback(0)} sizes="(max-width: 720px) calc(100vw - 64px), 290px" /></div>
            <h3>{winner.title}</h3>
            <div className={styles.tagRow}>{winner.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}</div>
          </article>
        </div>
      ) : null}
      <div className={styles.progressTrack} aria-hidden="true"><span style={{ width: `${scrollState.ratio * 100}%`, left: `${scrollState.progress * (1 - scrollState.ratio) * 100}%` }} /></div>
    </div>
  );
}

function candidateLabel(index: number, count: number, score: number) {
  if (count <= 1 || index === 0) return "Excellent match";
  if (index < Math.max(2, Math.ceil(count * 0.35))) return "Strong match";
  return score > 0 ? "Good match" : "Eligible pick";
}
