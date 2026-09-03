"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { vaultMatchLabel, type VaultPoolEntry } from "@/lib/vault";
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
  sleepingId?: string | null;
  onSleep?: (gameId: string) => void;
  pinnedIds?: string[];
  onPin?: (gameId: string) => void;
  onComplete?: (gameId: string) => void;
  onUserScroll?: () => void;
  allowActions?: boolean;
};

export function VaultPoolPreview({ entries, drawState = "idle", winner = null, highlightedId = null, onSelect, sleepingId = null, onSleep, pinnedIds = [], onPin, onComplete, onUserScroll, allowActions = true }: VaultPoolPreviewProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const progressTrackRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLSpanElement>(null);
  const programmaticScrollRef = useRef(false);
  const onUserScrollRef = useRef(onUserScroll);
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
  const onPinRef = useRef(onPin);
  const onSleepRef = useRef(onSleep);
  const onCompleteRef = useRef(onComplete);

  // Assigned after the render rather than during it. Writing a ref while
  // rendering is a side effect: React may render a component without committing
  // it, which would leave these pointing at callbacks from a render that never
  // reached the screen. Every one of them is only ever called from an event
  // handler, so the commit is always in place first.
  useEffect(() => {
    onUserScrollRef.current = onUserScroll;
    onSelectRef.current = onSelect;
    onPinRef.current = onPin;
    onSleepRef.current = onSleep;
    onCompleteRef.current = onComplete;
  });

  const handleSelect = useCallback((gameId: string) => onSelectRef.current?.(gameId), []);
  const handlePin = useCallback((gameId: string) => onPinRef.current?.(gameId), []);
  const handleSleep = useCallback((gameId: string) => onSleepRef.current?.(gameId), []);
  const handleComplete = useCallback((gameId: string) => onCompleteRef.current?.(gameId), []);
  const handleToggleMenu = useCallback((gameId: string) => {
    setOpenMenuId((current) => current === gameId ? null : gameId);
  }, []);
  const handleCloseMenu = useCallback(() => setOpenMenuId(null), []);

  return (
    <div className={styles.railWrap} data-draw-state={drawState} aria-busy={isDrawing}>
      <div className={styles.lightSweep} aria-hidden="true" />
      <button type="button" className={`${styles.arrow} ${styles.arrowLeft}`} aria-label="Previous games" onClick={() => moveRail(-1)}><VaultIcon name="chevron-left" /></button>
      <div className={styles.grid} ref={railRef}>
      {entries.map(({ game, score }, index) => (
        <PoolCard
          key={game.id}
          game={game}
          score={score}
          index={index}
          highlighted={highlightedId === game.id}
          menuOpen={openMenuId === game.id}
          pinned={pinnedIds.includes(game.id)}
          sleeping={sleepingId === game.id}
          allowActions={allowActions}
          menuRef={menuRef}
          onSelect={handleSelect}
          onToggleMenu={handleToggleMenu}
          onCloseMenu={handleCloseMenu}
          onPin={handlePin}
          onSleep={handleSleep}
          onComplete={handleComplete}
        />
      ))}
      </div>
      <button type="button" className={`${styles.arrow} ${styles.arrowRight}`} aria-label="Next games" onClick={() => moveRail(1)}><VaultIcon name="chevron-right" /></button>
      <div ref={progressTrackRef} className={styles.progressTrack} aria-hidden="true"><span ref={progressThumbRef} /></div>
    </div>
  );
}

type PoolCardProps = {
  game: VaultPoolEntry["game"];
  score: VaultPoolEntry["score"];
  index: number;
  highlighted: boolean;
  menuOpen: boolean;
  pinned: boolean;
  sleeping: boolean;
  allowActions: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  onSelect: (gameId: string) => void;
  onToggleMenu: (gameId: string) => void;
  onCloseMenu: () => void;
  onPin: (gameId: string) => void;
  onSleep: (gameId: string) => void;
  onComplete: (gameId: string) => void;
};

const PoolCard = memo(function PoolCard({
  game, score, index, highlighted, menuOpen, pinned, sleeping, allowActions, menuRef,
  onSelect, onToggleMenu, onCloseMenu, onPin, onSleep, onComplete
}: PoolCardProps) {
  const durationLabel = formatGameDuration(game.duration);

  return (
    <article
      className={`${styles.card}${highlighted ? ` ${styles.cardHighlighted}` : ""}${menuOpen ? ` ${styles.cardMenuOpen}` : ""}`}
      id={`vault-card-${game.id}`}
      data-game-id={game.id}
    >
      <button type="button" className={styles.cardAction} onClick={() => onSelect(game.id)} aria-label={`View details for ${game.title}`}>
        <div className={styles.cardArt}>
          <Artwork src={game.bannerUrl} fallbackSrc={candidateFallback(index)} sizes="(max-width: 720px) 44vw, 210px" />
          <FamilyGameMark game={game} overlay />
        </div>
        <div className={styles.cardBody}>
          <div className={styles.cardTopRow}>
            <h3 className={styles.cardTitle}>{game.title}</h3>
            <span className={styles.cardStatus}>{game.status}</span>
          </div>
          <p className={styles.cardCopy}>{game.description}</p>
          <div className={styles.tagRow}>{game.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}</div>
          <div className={styles.cardMeta}>
            <strong>{vaultMatchLabel(score)}</strong>
            {durationLabel ? <span>{durationLabel}</span> : null}
          </div>
        </div>
      </button>
      {allowActions ? <div ref={menuOpen ? menuRef : undefined} className={styles.menuShell} onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={styles.menuTrigger}
          aria-label={`Actions for ${game.title}`}
          aria-expanded={menuOpen}
          onClick={() => onToggleMenu(game.id)}
        ><VaultIcon name="menu-dots" size={20} /></button>
        {menuOpen ? <div className={styles.menu} role="menu">
          <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onPin(game.id); }}><VaultIcon name={pinned ? "unpin" : "pin"} size={18} />{pinned ? "Unpin game" : "Pin game"}</button>
          <button type="button" role="menuitem" disabled={sleeping} onClick={() => { onCloseMenu(); onSleep(game.id); }}><VaultIcon name="sleep" size={18} />Sleep game</button>
          <button type="button" role="menuitem" className={styles.completeMenuItem} onClick={() => { onCloseMenu(); onComplete(game.id); }}><VaultIcon name="mark-completed" size={18} />Mark as Completed</button>
        </div> : null}
      </div> : null}
    </article>
  );
});
