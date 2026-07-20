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
  pinnedIds?: string[];
  onPin?: (gameId: string) => void;
  onComplete?: (gameId: string) => void;
  onUserScroll?: () => void;
};

export function VaultPoolPreview({ entries, drawState = "idle", winner = null, highlightedId = null, onSelect, sleepingId = null, onSleep, pinnedIds = [], onPin, onComplete, onUserScroll }: VaultPoolPreviewProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const progressTrackRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLSpanElement>(null);
  const programmaticScrollRef = useRef(false);
  const onUserScrollRef = useRef(onUserScroll);
  onUserScrollRef.current = onUserScroll;
  const isDrawing = drawState === "focusing" || drawState === "revealing";

  useEffect(() => {
    if (!openMenuId) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenuId(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenuId(null);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (drawState !== "revealing" || !winner || !railRef.current) return;
    programmaticScrollRef.current = true;
    railRef.current.querySelector<HTMLElement>(`[data-game-id="${CSS.escape(winner.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    const timer = window.setTimeout(() => { programmaticScrollRef.current = false; }, 700);
    return () => window.clearTimeout(timer);
  }, [drawState, winner]);

  useEffect(() => {
    const rail = railRef.current;
    const track = progressTrackRef.current;
    const thumb = progressThumbRef.current;
    if (!rail || !track || !thumb) return;
    let animationFrame = 0;

    const update = () => {
      animationFrame = 0;
      const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
      const ratio = Math.min(1, rail.clientWidth / Math.max(rail.scrollWidth, 1));
      const thumbWidth = track.clientWidth * ratio;
      const progress = maxScroll ? rail.scrollLeft / maxScroll : 0;

      thumb.style.width = `${ratio * 100}%`;
      thumb.style.transform = `translate3d(${progress * Math.max(0, track.clientWidth - thumbWidth)}px, 0, 0)`;
    };

    const scheduleUpdate = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(update);
    };

    update();
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(rail);
    observer.observe(track);
    const onScroll = () => {
      scheduleUpdate();
      if (!programmaticScrollRef.current) onUserScrollRef.current?.();
    };
    rail.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      rail.removeEventListener("scroll", onScroll);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [entries.length]);

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
        const menuOpen = openMenuId === game.id;
        const isPinned = pinnedIds.includes(game.id);
        const durationLabel = formatGameDuration(game.duration);
        return (
          <article
            key={game.id}
            className={`${styles.card}${isHighlighted ? ` ${styles.cardHighlighted}` : ""}${menuOpen ? ` ${styles.cardMenuOpen}` : ""}`}
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
            <div ref={menuOpen ? menuRef : undefined} className={styles.menuShell} onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className={styles.menuTrigger}
                aria-label={`Actions for ${game.title}`}
                aria-expanded={menuOpen}
                onClick={() => setOpenMenuId((current) => current === game.id ? null : game.id)}
              ><VaultIcon name="menu-dots" size={20} /></button>
              {menuOpen ? <div className={styles.menu} role="menu">
                <button type="button" role="menuitem" onClick={() => { setOpenMenuId(null); onPin?.(game.id); }}>{isPinned ? "Unpin game" : "Pin game"}</button>
                <button type="button" role="menuitem" disabled={sleepingId === game.id} onClick={() => { setOpenMenuId(null); onSleep?.(game.id); }}>Sleep game</button>
                <button type="button" role="menuitem" className={styles.completeMenuItem} onClick={() => { setOpenMenuId(null); onComplete?.(game.id); }}>Mark as Completed</button>
              </div> : null}
            </div>
          </article>
        );
      })}
      </div>
      <button type="button" className={`${styles.arrow} ${styles.arrowRight}`} aria-label="Next games" onClick={() => moveRail(1)}><VaultIcon name="chevron-right" /></button>
      <div ref={progressTrackRef} className={styles.progressTrack} aria-hidden="true"><span ref={progressThumbRef} /></div>
    </div>
  );
}

function candidateLabel(index: number, count: number, score: number) {
  if (count <= 1 || index === 0) return "Excellent match";
  if (index < Math.max(2, Math.ceil(count * 0.35))) return "Strong match";
  return score > 0 ? "Good match" : "Eligible pick";
}
