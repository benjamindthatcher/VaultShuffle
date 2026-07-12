import type { DemoCollection } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
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
        <span className={styles.chevron} aria-hidden="true">›</span>
      </div>

      <div className={styles.chooser}>
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
    </section>
  );
}
