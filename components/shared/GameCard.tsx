"use client";

import { isEndlessProgress, progressLabel } from "@/lib/progress-display";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { useSteamPlayLink } from "@/components/shared/useSteamLaunch";
import { formatGameDuration } from "@/lib/game-duration";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { isFamilyAccess } from "@/lib/family-sharing";
import { FamilyMark } from "@/components/shared/FamilyMark";
import styles from "./GameCard.module.css";

type GameCardProps = {
  game: DemoGame;
  layout?: "grid" | "list";
  onClick?: () => void;
  onComplete?: () => void;
  onRestore?: () => void;
  onSleep?: () => void;
  onTogglePin?: () => void;
  /** Direct unpin, shown as an X on the card so a pin can be dropped from anywhere. */
  onUnpin?: () => void;
  pinned?: boolean;
  showProgress?: boolean;
  /**
   * Turns the card into a picker rather than a link. Used on the shelves where
   * every game has already been decided - slept and completed - so the useful
   * thing to do with them is act on several at once. Active games stay clickable
   * for their details, which is what that shelf is actually for.
   */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
};

export function GameCard({ game, layout = "grid", onClick, onComplete, onRestore, onSleep, onTogglePin, onUnpin, pinned = false, showProgress = false, selectable = false, selected = false, onToggleSelect }: GameCardProps) {
  const steamLink = useSteamPlayLink(game.steamAppId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuShellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isList = layout === "list";
  const isActiveGame = game.status !== "Completed" && game.status !== "Slept";
  const durationLabel = formatGameDuration(game.duration);
  // One icon, no label. A shared game should be recognisable at a glance without
  // turning the card into a disclaimer - the details panel explains it.
  const isFamily = isFamilyAccess(game.accessSource);

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
        {isFamily ? (
          <span className={styles.familyMarkSlot}>
            <FamilyMark title={game.familyOwnerName ? `Shared from ${game.familyOwnerName}'s library` : "Shared from a family library"} />
          </span>
        ) : null}
      </div>
      <div className={styles.body}>
        <div className={styles.topRow}>
          <h3 className={styles.title}>{game.title}</h3>
          {!isList ? <span className={styles.status}>{game.status}</span> : null}
        </div>
        <p className={styles.copy}>{game.description}</p>
        <div className={styles.metaRow}>
          {/* "Fresh pick" is a claim about the player, and on a family game the
              only hours that exist belong to whoever owns it. Saying nothing is
              better than "No playtime data" on every shared card - the row just
              carries the length instead. */}
          <span>{isFamily
            ? durationLabel || "Family library"
            : `${game.hoursPlayed > 0 ? `${game.hoursPlayed}h played` : "Fresh pick"}${durationLabel ? ` · ${durationLabel}` : ""}`}</span>
          {isList ? (
            <span className={styles.listState}>
              <span className={styles.status}>{game.status}</span>
              <span className={styles.stateSeparator} aria-hidden="true">·</span>
              <span className={styles.progress} data-endless={isEndlessProgress(game) || undefined}>{progressLabel(game)}</span>
            </span>
          ) : showProgress ? <span className={styles.progress} data-endless={isEndlessProgress(game) || undefined}>{progressLabel(game)}</span> : null}
        </div>
      </div>
    </>
  );

  if (!onClick) {
    return <article className={isList ? `${styles.card} ${styles.cardList}` : styles.card}>{content}</article>;
  }

  return <article className={`${styles.cardShell}${menuOpen ? ` ${styles.cardShellMenuOpen}` : ""}`}>
    {/* The whole card ticks the box. Hitting an 18px square exactly is a poor way
        to work down a grid of thirty, and on these shelves there is nothing else
        the card could mean. Details are still on the menu. */}
    <button
      type="button"
      className={isList ? `${styles.card} ${styles.cardList}` : styles.card}
      onClick={selectable ? onToggleSelect : onClick}
      aria-pressed={selectable ? selected : undefined}
      data-selected={selectable && selected ? "" : undefined}
    >
      {selectable ? (
        <span className={styles.selectMark} aria-hidden="true">
          {selected ? <VaultIcon name="check" size={14} /> : null}
        </span>
      ) : null}
      {content}
    </button>
    {onUnpin ? <button
      type="button"
      className={styles.unpinButton}
      aria-label={`Unpin ${game.title}`}
      title="Unpin"
      onClick={(event) => { event.stopPropagation(); onUnpin(); }}
    ><VaultIcon name="close" size={15} /></button> : null}
    {/* The two things you can say about a game you are not going to open
        tonight, side by side under its face.
        Completing is the most common act on this page - 543 opens of the details
        drawer produced 381 completions against 132 filters and searches - and
        sleeping is what Purge existed to collect. Both were behind a menu or
        another page; both are one tap now.
        Active games only: a finished or sleeping game has different work to do,
        and that stays in the menu. */}
    {isActiveGame && (onSleep || onComplete) ? (
      <div className={styles.quickActions}>
        {onSleep ? (
          <button
            type="button"
            className={styles.quickSleep}
            onClick={(event) => { event.stopPropagation(); onSleep(); }}
          >
            <VaultIcon name="sleep" size={16} />Sleep
          </button>
        ) : null}
        {onComplete ? (
          <button
            type="button"
            className={styles.quickComplete}
            onClick={(event) => { event.stopPropagation(); onComplete(); }}
          >
            <VaultIcon name="mark-completed" size={16} />Complete
          </button>
        ) : null}
      </div>
    ) : null}
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
          <a role="menuitem" href={steamLink.href} target={steamLink.target} rel={steamLink.rel} onClick={() => setMenuOpen(false)}><VaultIcon name="open-steam" size={18} />Open on Steam</a>
        </>}
      </div>, document.body) : null}
    </div> : null}
  </article>;
}
