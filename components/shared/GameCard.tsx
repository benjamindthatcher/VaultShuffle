"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { steamLaunchUrl } from "@/lib/steam-images";
import { formatGameDuration } from "@/lib/game-duration";
import { VaultIcon } from "@/components/shared/VaultIcon";
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
  showProgress?: boolean;
};

export function GameCard({ game, layout = "grid", onClick, onComplete, onRestore, onSleep, onTogglePin, pinned = false, showProgress = false }: GameCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuShellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isList = layout === "list";
  const durationLabel = formatGameDuration(game.duration);

  useEffect(() => {
    if (!menuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!menuShellRef.current?.contains(target) && !menuRef.current?.contains(target)) setMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };

    function closeMenu() {
      setMenuOpen(false);
    }
  }, [menuOpen]);

  function toggleMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const trigger = menuShellRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const menuWidth = 196;
    const estimatedHeight = game.status === "Completed" || game.status === "Slept" ? 142 : 238;
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, trigger.right - menuWidth));
    const top = trigger.bottom + estimatedHeight + 8 <= window.innerHeight
      ? trigger.bottom + 6
      : Math.max(8, trigger.top - estimatedHeight - 6);
    setMenuPosition({ top, left });
    setMenuOpen(true);
  }
  const content = (
    <>
      <div className={isList ? `${styles.artwork} ${styles.artworkList}` : styles.artwork}>
        <Artwork src={game.bannerUrl} sizes={isList ? "260px" : "(max-width: 720px) 100vw, 33vw"} />
      </div>
      <div className={styles.body}>
        <div className={styles.topRow}>
          <h3 className={styles.title}>{game.title}</h3>
          {!isList ? <span className={styles.status}>{game.status}</span> : null}
        </div>
        <p className={styles.copy}>{game.description}</p>
        <div className={styles.metaRow}>
          <span>{game.hoursPlayed > 0 ? `${game.hoursPlayed}h played` : "Fresh pick"}{durationLabel ? ` · ${durationLabel}` : ""}</span>
          {isList ? (
            <span className={styles.listState}>
              <span className={styles.status}>{game.status}</span>
              <span className={styles.stateSeparator} aria-hidden="true">·</span>
              <span className={styles.progress}>{game.completionPercent}%</span>
            </span>
          ) : showProgress ? <span className={styles.progress}>{game.completionPercent}%</span> : null}
        </div>
      </div>
    </>
  );

  if (!onClick) {
    return <article className={isList ? `${styles.card} ${styles.cardList}` : styles.card}>{content}</article>;
  }

  return <article className={`${styles.cardShell}${menuOpen ? ` ${styles.cardShellMenuOpen}` : ""}`}>
    <button type="button" className={isList ? `${styles.card} ${styles.cardList}` : styles.card} onClick={onClick}>{content}</button>
    {(onComplete || onRestore || onSleep || onTogglePin) ? <div ref={menuShellRef} className={styles.menuShell}>
      <button type="button" className={styles.menuTrigger} aria-label={`Actions for ${game.title}`} aria-expanded={menuOpen} onClick={toggleMenu}><VaultIcon name="menu-dots" size={20} /></button>
      {menuOpen ? createPortal(<div ref={menuRef} className={styles.menu} style={menuPosition} role="menu">
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onClick?.(); }}><VaultIcon name="details" size={18} />View Details</button>
        {game.status === "Completed" || game.status === "Slept" ? <>
          {onRestore ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRestore(); }}><VaultIcon name="restore-active" size={18} />Restore to Active</button> : null}
          {game.status === "Completed" && onSleep ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onSleep(); }}><VaultIcon name="sleep" size={18} />Move to Slept</button> : null}
          {game.status === "Slept" && onComplete ? <button type="button" role="menuitem" className={styles.completeMenuItem} onClick={() => { setMenuOpen(false); onComplete(); }}><VaultIcon name="mark-completed" size={18} />Mark as Completed</button> : null}
        </> : <>
          {onTogglePin ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onTogglePin(); }}><VaultIcon name={pinned ? "unpin" : "pin"} size={18} />{pinned ? "Unpin game" : "Pin game"}</button> : null}
          {onSleep ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onSleep(); }}><VaultIcon name="sleep" size={18} />Sleep game</button> : null}
          {onComplete ? <button type="button" role="menuitem" className={styles.completeMenuItem} onClick={() => { setMenuOpen(false); onComplete(); }}><VaultIcon name="mark-completed" size={18} />Mark as Completed</button> : null}
          <a role="menuitem" href={steamLaunchUrl(game.steamAppId)} onClick={() => setMenuOpen(false)}><VaultIcon name="open-steam" size={18} />Open on Steam</a>
        </>}
      </div>, document.body) : null}
    </div> : null}
  </article>;
}
