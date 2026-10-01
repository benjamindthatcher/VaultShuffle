"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Artwork } from "./Artwork";
import { GameDetailsClose } from "./GameDetailsClose";
import { useIsMounted } from "./useIsMounted";
import { VaultIcon, type VaultIconName } from "./VaultIcon";
import styles from "@/components/library/LibraryDetailsDrawer.module.css";

export type GameDetailsStat = { icon: VaultIconName; label: string; value: ReactNode };

/** The standard Library popup. Other shelves supply data/actions, never a
 * separate layout, artwork treatment or modal implementation. */
export function GameDetailsDialog({ gameId, title, artwork, description, titleAccessory, notice, actions, stats, genres, onClose }: {
  gameId: string | null;
  title: string;
  artwork: string;
  description: string;
  titleAccessory?: ReactNode;
  notice?: ReactNode;
  actions: ReactNode;
  stats: GameDetailsStat[];
  genres: string[];
  onClose: () => void;
}) {
  const mounted = useIsMounted();
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const openGameId = gameId;
  useEffect(() => {
    if (!mounted || !openGameId) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));

    function handleDialogKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) {
        event.preventDefault();
        drawerRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeydown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKeydown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [mounted, openGameId]);

  if (!mounted || !gameId) return null;

  return createPortal(<>
    <button type="button" className={styles.overlay} onClick={onClose} aria-label="Close game details" />
    <aside ref={drawerRef} className={styles.drawer} data-variant="library" data-vault-controls="standard" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <GameDetailsClose buttonRef={closeButtonRef} onClose={onClose} />
      <div className={styles.hero}>
        <Artwork src={artwork} sizes="(max-width: 600px) 100vw, 560px" priority />
      </div>
      <div className={styles.body}>
        <div className={styles.header}><div><p className={styles.eyebrow}>Game details</p><h2 className={styles.title} id={titleId}>{title}{titleAccessory}</h2></div></div>
        <p className={styles.copy} id={descriptionId}>{description}</p>
        {notice}
        {actions}
        <dl className={styles.gameInfo}>{stats.map(stat => <div key={stat.label}><VaultIcon name={stat.icon} size={21} /><span><dt>{stat.label}</dt><dd>{stat.value}</dd></span></div>)}</dl>
        <div className={styles.metadataRow}>{genres.map(genre => <span key={genre}>{genre}</span>)}</div>
      </div>
    </aside>
  </>, document.body);
}
