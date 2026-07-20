"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./ManagePinsDialog.module.css";

type Props = {
  pinnedGames: DemoGame[];
  candidate?: DemoGame | null;
  onRemove: (gameId: string) => Promise<void>;
  onReplace: (gameId: string) => Promise<void>;
  onClose: () => void;
};

export function ManagePinsDialog({ pinnedGames, candidate = null, onRemove, onReplace, onClose }: Props) {
  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
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
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [mounted, onClose]);

  const removePin = async (gameId: string) => {
    setSaving(true);
    setError("");
    try {
      await onRemove(gameId);
    } catch {
      setError("Could not update your pins. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const replacePin = async () => {
    if (!selectedId) return;
    setSaving(true);
    setError("");
    try {
      await onReplace(selectedId);
      onClose();
    } catch {
      setError("Could not update your pins. Try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(<div className={styles.layer}>
    <button type="button" className={styles.backdrop} onClick={onClose} aria-label="Close pinned games" />
    <div ref={panelRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="pins-title" tabIndex={-1}>
      <header><div><p>{candidate ? "Pins are full" : "Priority shelf"}</p><h2 id="pins-title">Manage pinned games <span>{pinnedGames.length}/3</span></h2></div><button type="button" onClick={onClose} aria-label="Close"><VaultIcon name="close" size={19} /></button></header>
      {candidate ? <p className={styles.copy}>Choose a game to replace with <strong>{candidate.title}</strong>.</p> : <p className={styles.copy}>Pinned Active games stay at the front of your Library.</p>}
      <div className={styles.slots}>
        {[0, 1, 2].map((index) => {
          const game = pinnedGames[index];
          if (!game) return <div key={index} className={styles.emptySlot}><span>{index + 1}</span>Empty slot</div>;
          const selected = selectedId === game.id;
          return <button key={game.id} type="button" disabled={saving} className={selected ? `${styles.slot} ${styles.slotSelected}` : styles.slot} onClick={() => candidate ? setSelectedId(game.id) : void removePin(game.id)} aria-label={candidate ? `Replace ${game.title}` : `Remove pin from ${game.title}`}>
            <span className={styles.art}><Artwork src={game.bannerUrl} sizes="74px" /></span><span><small>Slot {index + 1}</small><strong>{game.title}</strong></span>{candidate ? <span className={styles.selectMark}>{selected ? <VaultIcon name="check" size={18} /> : null}</span> : <span className={styles.remove}>Remove</span>}
          </button>;
        })}
      </div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button>{candidate ? <button type="button" disabled={!selectedId || saving} onClick={() => void replacePin()}>{saving ? "Updating pins…" : selectedId ? `Replace ${pinnedGames.find((game) => game.id === selectedId)?.title}` : "Select a pin"}</button> : null}</footer>
    </div>
  </div>, document.body);
}
