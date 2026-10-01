"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { type VaultPoolEntry } from "@/lib/vault";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { candidateFallback } from "@/lib/vaultshuffle-assets";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./VaultPoolPreview.module.css";
import { FamilyGameMark } from "@/components/shared/FamilyMark";

type VaultPoolPreviewProps = {
  entries: VaultPoolEntry[];
  drawState?: "idle" | "focusing" | "revealing" | "revealed" | "error";
  winner?: VaultPoolEntry["game"] | null;
  highlightedId?: string | null;
  onSelect?: (gameId: string) => void;
  onUserScroll?: () => void;
};

export function VaultPoolPreview({ entries, drawState = "idle", winner = null, highlightedId = null, onSelect, onUserScroll }: VaultPoolPreviewProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const progressTrackRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLSpanElement>(null);
  const programmaticScrollRef = useRef(false);
  const onUserScrollRef = useRef(onUserScroll);
  const isDrawing = drawState === "focusing" || drawState === "revealing";

  // Keyed on the winner's id, not the winner object: the parent found that object
  // fresh on every render, so this effect re-ran through the whole draw and
  // restarted the smooth scroll each time, which is what made the rail stutter.
  const winnerId = winner?.id ?? null;
  useEffect(() => {
    if (drawState !== "revealing" || !winnerId || !railRef.current) return;
    const rail = railRef.current;
    const winnerCard = rail.querySelector<HTMLElement>(`[data-game-id="${CSS.escape(winnerId)}"]`);
    if (!winnerCard) return;

    // Already in view is already right. Scrolling a card that the player can see
    // to the exact centre is motion for its own sake, and it competes with the
    // page scroll that follows the reveal.
    const cardLeft = winnerCard.offsetLeft - rail.scrollLeft;
    const margin = Math.min(64, rail.clientWidth * 0.1);
    if (cardLeft >= margin && cardLeft + winnerCard.offsetWidth <= rail.clientWidth - margin) return;

    programmaticScrollRef.current = true;
    const centeredLeft = winnerCard.offsetLeft - (rail.clientWidth - winnerCard.offsetWidth) / 2;
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    rail.scrollTo({ left: Math.min(maxScroll, Math.max(0, centeredLeft)), behavior: "smooth" });
    const timer = window.setTimeout(() => { programmaticScrollRef.current = false; }, 700);
    return () => window.clearTimeout(timer);
  }, [drawState, winnerId]);

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

  // The deck can run to a couple of hundred cards, and every one of them used to
  // re-render on each state change of the draw — four times over an 850ms
  // animation, which is where the dropped frames came from. The card is memoised
  // and takes only primitives and these stable callbacks, so a phase change now
  // re-renders the one or two cards whose own state actually changed.
  const onSelectRef = useRef(onSelect);
  // Assigned after the render rather than during it. Writing a ref while
  // rendering is a side effect: React may render a component without committing
  // it, which would leave these pointing at callbacks from a render that never
  // reached the screen. Every one of them is only ever called from an event
  // handler, so the commit is always in place first.
  useEffect(() => {
    onUserScrollRef.current = onUserScroll;
    onSelectRef.current = onSelect;
  });

  const handleSelect = useCallback((gameId: string) => onSelectRef.current?.(gameId), []);
  return (
    <div className={styles.railWrap} data-draw-state={drawState} aria-busy={isDrawing}>
      <div className={styles.lightSweep} aria-hidden="true" />
      <button type="button" data-vault-control="secondary" data-control-size="icon" data-control-position="floating" className={`${styles.arrow} ${styles.arrowLeft}`} aria-label="Previous games" onClick={() => moveRail(-1)}><VaultIcon name="chevron-left" /></button>
      <div className={styles.grid} ref={railRef}>
      {entries.map(({ game, score }, index) => (
        <PoolCard
          key={game.id}
          game={game}
          score={score}
          index={index}
          highlighted={highlightedId === game.id}
          onSelect={handleSelect}
        />
      ))}
      </div>
      <button type="button" data-vault-control="secondary" data-control-size="icon" data-control-position="floating" className={`${styles.arrow} ${styles.arrowRight}`} aria-label="Next games" onClick={() => moveRail(1)}><VaultIcon name="chevron-right" /></button>
      <div ref={progressTrackRef} className={styles.progressTrack} aria-hidden="true"><span ref={progressThumbRef} /></div>
    </div>
  );
}

type PoolCardProps = {
  game: VaultPoolEntry["game"];
  score: VaultPoolEntry["score"];
  index: number;
  highlighted: boolean;
  onSelect: (gameId: string) => void;
};

const PoolCard = memo(function PoolCard({ game, score, index, highlighted, onSelect }: PoolCardProps) {
  const durationLabel = formatGameDuration(game.duration)?.replace(/ estimated$/, " est");
  // The existing deck order decides the leading candidate. Lower scores keep
  // an honest eligibility label; unscored pools do not imply a measured fit.
  const fit = score <= 0 ? "eligible" : index === 0 ? "top" : score >= 82 ? "strong" : score >= 50 ? "good" : "eligible";
  const fitLabel = { top: "Top candidate", strong: "Strong fit", good: "Good fit", eligible: "Eligible pick" }[fit];

  return (
    <article
      className={`${styles.card}${highlighted ? ` ${styles.cardHighlighted}` : ""}`}
      id={`vault-card-${game.id}`}
      data-game-id={game.id}
    >
      <button type="button" data-vault-card="interactive" className={styles.cardAction} onClick={() => onSelect(game.id)} aria-label={`View details for ${game.title}`}>
        <div className={styles.cardArt}>
          <Artwork src={game.bannerUrl} fallbackSrc={candidateFallback(index)} sizes="(max-width: 719px) 78vw, (max-width: 1099px) 32vw, 25vw" />
          <FamilyGameMark game={game} overlay />
        </div>
        <div className={styles.cardBody}>
          <h3 className={styles.cardTitle}>{game.title}</h3>
          <div className={styles.tagRow}>{game.genres.slice(0, 2).map((genre) => <span key={genre}>{genre}</span>)}</div>
          <div className={styles.cardMeta}>
            <strong className={styles.fitLabel} data-fit={fit}><span aria-hidden="true">★</span>{fitLabel}</strong>
            {durationLabel ? <span className={styles.duration}>
              {game.duration?.endless ? <span className={styles.endlessIcon} aria-hidden="true">∞</span> : <VaultIcon name="clock" size={15} />}
              {durationLabel}
            </span> : null}
          </div>
        </div>
      </button>
    </article>
  );
});
