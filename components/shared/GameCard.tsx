"use client";

import { useEffect, useRef, useState } from "react";
import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { steamStoreUrl } from "@/lib/steam-images";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./GameCard.module.css";

type GameCardProps = {
  game: DemoGame;
  layout?: "grid" | "list";
  onClick?: () => void;
  onComplete?: () => void;
  onRestore?: () => void;
  onSleep?: () => void;
  onTogglePin?: () => void;
  pinned?: boolean;
};

export function GameCard({ game, layout = "grid", onClick, onComplete, onRestore, onSleep, onTogglePin, pinned = false }: GameCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuShellRef = useRef<HTMLDivElement>(null);
  const isList = layout === "list";
  const durationLabel = formatGameDuration(game.duration);

  useEffect(() => {
    if (!menuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuShellRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  const content = (
    <>
      <div className={isList ? `${styles.artwork} ${styles.artworkList}` : styles.artwork}>
        <Artwork src={game.artworkUrl} sizes={isList ? "260px" : "(max-width: 720px) 100vw, 33vw"} />
      </div>
      <div className={styles.body}>
        <div className={styles.topRow}>
          <h3 className={styles.title}>{game.title}</h3>
          <span className={styles.status}>{game.status}</span>
        </div>
        <p className={styles.copy}>{game.description}</p>
        <div className={styles.metaRow}>
          <span>{game.hoursPlayed > 0 ? `${game.hoursPlayed}h played` : "Fresh pick"}{durationLabel ? ` · ${durationLabel}` : ""}</span>
          <span>{game.completionPercent}%</span>
        </div>
      </div>
    </>
  );

  if (!onClick) {
    return <article className={isList ? `${styles.card} ${styles.cardList}` : styles.card}>{content}</article>;
  }

  return <article className={styles.cardShell}>
    <button type="button" className={isList ? `${styles.card} ${styles.cardList}` : styles.card} onClick={onClick}>{content}</button>
    {(onComplete || onRestore || onSleep || onTogglePin) ? <div ref={menuShellRef} className={styles.menuShell}>
      <button type="button" className={styles.menuTrigger} aria-label={`Actions for ${game.title}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>•••</button>
      {menuOpen ? <div className={styles.menu} role="menu">
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onClick?.(); }}>View Details</button>
        <a role="menuitem" href={steamStoreUrl(game.steamAppId)} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>Open on Steam</a>
        {onTogglePin ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onTogglePin(); }}>{pinned ? "Unpin game" : "Pin game"}</button> : null}
        {onSleep ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onSleep(); }}>Sleep game</button> : null}
        {onRestore ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRestore(); }}>Restore to Active</button> : null}
        {onComplete ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onComplete(); }}>✓ Mark as Completed</button> : null}
      </div> : null}
    </div> : null}
  </article>;
}
