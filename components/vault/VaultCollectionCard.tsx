"use client";

import { useRef } from "react";
import type { DemoCollection } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./VaultCollectionCard.module.css";

type VaultCollectionCardProps = {
  selectedCollection: DemoCollection | null;
  collections: DemoCollection[];
  onSelect: (id: string) => void;
};

export function VaultCollectionCard({
  selectedCollection,
  collections,
  onSelect
}: VaultCollectionCardProps) {
  const chooserRef = useRef<HTMLDivElement>(null);

  function moveChooser(direction: -1 | 1) {
    chooserRef.current?.scrollBy({ left: direction * 240, behavior: "smooth" });
  }

  return (
    <section className={styles.wrap}>
      <div className={styles.heroCard}>
        {selectedCollection ? (
          <div className={styles.artwork}>
            <Artwork src={selectedCollection.artworkUrl} sizes="(max-width: 720px) 100vw, 220px" />
          </div>
        ) : <div className={styles.emptyArtwork} aria-hidden="true" />}
        <div className={styles.content}>
          <p className={styles.eyebrow}>{selectedCollection ? "Selected collection" : "Collection"}</p>
          <h2 className={styles.title}>{selectedCollection?.name ?? "Choose a collection"}</h2>
          <p className={styles.description}>{selectedCollection?.description ?? "Optional. Leave blank to search across your full library."}</p>
        </div>
      </div>

      <div className={styles.chooserShell}>
        <button type="button" className={styles.chooserArrow} onClick={() => moveChooser(-1)} aria-label="Previous collections"><VaultIcon name="chevron-left" size={18} /></button>
        <div className={styles.chooser} ref={chooserRef}>
          {collections.map((collection) => {
            const isActive = collection.id === selectedCollection?.id;
            return (
              <button
                key={collection.id}
                type="button"
                className={isActive ? `${styles.choiceButton} ${styles.choiceButtonActive}` : styles.choiceButton}
                onClick={() => onSelect(collection.id)}
              >
                {collection.name}
              </button>
            );
          })}
        </div>
        <button type="button" className={styles.chooserArrow} onClick={() => moveChooser(1)} aria-label="Next collections"><VaultIcon name="chevron-right" size={18} /></button>
      </div>
    </section>
  );
}
