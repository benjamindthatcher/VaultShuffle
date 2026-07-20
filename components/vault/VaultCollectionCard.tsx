"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DemoCollection } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./VaultCollectionCard.module.css";

type VaultCollectionCardProps = {
  selectedCollection: DemoCollection;
  collections: DemoCollection[];
  collectionCounts: Record<string, number>;
  onSelect: (id: string) => void;
};

export function VaultCollectionCard({ selectedCollection, collections, collectionCounts, onSelect }: VaultCollectionCardProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const visibleCollections = useMemo(() => {
    const term = query.trim().toLowerCase();
    const entireVault = collections.find((collection) => collection.id === "all");
    const others = collections.filter((collection) => collection.id !== "all" && (!term || collection.name.toLowerCase().includes(term)));
    return entireVault && (!term || entireVault.name.toLowerCase().includes(term)) ? [entireVault, ...others] : others;
  }, [collections, query]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button, a, input')].filter((item) => !item.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <section className={styles.wrap}>
      <button ref={triggerRef} type="button" className={styles.heroCard} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <div className={styles.artwork}><Artwork src={selectedCollection.artworkUrl} sizes="(max-width: 720px) 100vw, 360px" /></div>
        <div className={styles.content}>
          <p className={styles.eyebrow}>Selected collection</p>
          <h2 className={styles.title}>{selectedCollection.name}</h2>
          <p className={styles.description}>{selectedCollection.description}</p>
          <span className={styles.changeButton}><VaultIcon name="filter" size={16} />Change Collection</span>
        </div>
        <VaultIcon name="chevron-right" size={22} />
      </button>

      {open ? createPortal(<div className={styles.modalLayer}>
        <button type="button" className={styles.backdrop} onClick={close} aria-label="Close collection picker" />
        <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="collection-picker-title">
          <header className={styles.dialogHeader}><div><p className={styles.dialogEyebrow}>Vault pool</p><h2 id="collection-picker-title">Choose a collection</h2></div><button type="button" className={styles.closeButton} onClick={close} aria-label="Close"><VaultIcon name="close" size={19} /></button></header>
          <label className={styles.search}><VaultIcon name="search" size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search collections…" /></label>
          <div className={styles.collectionList}>
            {visibleCollections.map((collection) => {
              const selected = collection.id === selectedCollection.id;
              return <button key={collection.id} type="button" className={selected ? `${styles.collectionRow} ${styles.collectionRowSelected}` : styles.collectionRow} onClick={() => { onSelect(collection.id); close(); }}>
                <span className={styles.thumbnail}><Artwork src={collection.artworkUrl} sizes="72px" /></span>
                <span><strong>{collection.name}</strong><small>{collection.id === "all" ? "No collection restriction" : collection.description}</small></span>
                <span className={styles.rowCount}>{collectionCounts[collection.id] ?? 0} games</span>
                <span className={styles.check} aria-label={selected ? "Selected" : undefined}>{selected ? <VaultIcon name="check" size={18} /> : null}</span>
              </button>;
            })}
            {!visibleCollections.length ? <p className={styles.empty}>No collections match that search.</p> : null}
          </div>
          <Link className={styles.manageLink} href="/collections">Manage collections <VaultIcon name="chevron-right" size={17} /></Link>
        </div>
      </div>, document.body) : null}
    </section>
  );
}
