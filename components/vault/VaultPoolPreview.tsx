"use client";

import { useEffect, useRef, useState } from "react";
import type { VaultPoolEntry } from "@/lib/vault";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { candidateFallback } from "@/lib/vaultshuffle-assets";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./VaultPoolPreview.module.css";

type VaultPoolPreviewProps = {
  entries: VaultPoolEntry[];
  drawState?: "idle" | "focusing" | "revealing" | "revealed" | "error";
  winner?: VaultPoolEntry["game"] | null;
  highlightedId?: string | null;
  onSelect?: (gameId: string) => void;
  sleepingId?: string | null;
  onSleep?: (gameId: string) => void;
  onUserScroll?: () => void;
};

export function VaultPoolPreview({ entries, drawState = "idle", winner = null, highlightedId = null, onSelect, sleepingId = null, onSleep, onUserScroll }: VaultPoolPreviewProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const [scrollState, setScrollState] = useState({ progress: 0, ratio: 1 });
  const isDrawing = drawState === "focusing" || drawState === "revealing";

  useEffect(() => {
    if (drawState !== "revealing" || !winner || !railRef.current) return;
    programmaticScrollRef.current = true;
    railRef.current.querySelector<HTMLElement>(`[data-game-id="${CSS.escape(winner.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    const timer = window.setTimeout(() => { programmaticScrollRef.current = false; }, 700);
    return () => window.clearTimeout(timer);
  }, [drawState, winner]);

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
    const onScroll = () => { update(); if (!programmaticScrollRef.current) onUserScroll?.(); };
    rail.addEventListener("scroll", onScroll, { passive: true });
    return () => { observer.disconnect(); rail.removeEventListener("scroll", onScroll); };
  }, [entries, onUserScroll]);

  function moveRail(direction: -1 | 1) {
    onUserScroll?.();
    railRef.current?.scrollBy({ left: direction * 520, behavior: "smooth" });
  }

  return (
    <div className={styles.railWrap} data-draw-state={drawState} aria-busy={isDrawing}>
      <div className={styles.lightSweep} aria-hidden="true" />
      <button type="button" className={`${styles.arrow} ${styles.arrowLeft}`} aria-label="Previous games" onClick={() => moveRail(-1)}><VaultIcon name="chevron-left" /></button>
      <div className={styles.grid} ref={railRef}>
      {entries.map(({ game, score }, index) => {
        const isHighlighted = highlightedId === game.id;
        const durationLabel = formatGameDuration(game.duration);
        return (
          <article
            key={game.id}
            className={isHighlighted ? `${styles.card} ${styles.cardHighlighted}` : styles.card}
            id={`vault-card-${game.id}`}
            data-game-id={game.id}
          >
            <button type="button" className={styles.cardAction} onClick={() => onSelect?.(game.id)} aria-label={`View details for ${game.title}`}>
              <div className={styles.cardArt}>
                <Artwork src={game.bannerUrl} fallbackSrc={candidateFallback(index)} sizes="(max-width: 720px) 44vw, 210px" />
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
                  {durationLabel ? <span>{durationLabel}</span> : null}
                </div>
              </div>
            </button>
            <button
              type="button"
              className={sleepingId === game.id ? `${styles.heart} ${styles.sleeping}` : styles.heart}
              aria-label="Snooze this game"
              title="Snooze this pick"
              disabled={sleepingId === game.id}
              onClick={() => onSleep?.(game.id)}
            ><VaultIcon name="snooze" size={18} /></button>
          </article>
        );
      })}
      </div>
      <button type="button" className={`${styles.arrow} ${styles.arrowRight}`} aria-label="Next games" onClick={() => moveRail(1)}><VaultIcon name="chevron-right" /></button>
      <div className={styles.progressTrack} aria-hidden="true"><span style={{ width: `${scrollState.ratio * 100}%`, left: `${scrollState.progress * (1 - scrollState.ratio) * 100}%` }} /></div>
    </div>
  );
}

function candidateLabel(index: number, count: number, score: number) {
  if (count <= 1 || index === 0) return "Excellent match";
  if (index < Math.max(2, Math.ceil(count * 0.35))) return "Strong match";
  return score > 0 ? "Good match" : "Eligible pick";
}
