import type { DemoCollection } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import styles from "./VaultCollectionCard.module.css";

type VaultCollectionCardProps = {
  selectedCollection: DemoCollection;
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
        <div className={styles.artwork}>
          <Artwork src={selectedCollection.artworkUrl} sizes="(max-width: 720px) 100vw, 220px" />
        </div>
        <div className={styles.content}>
          <p className={styles.eyebrow}>Selected collection</p>
          <h2 className={styles.title}>{selectedCollection.name}</h2>
          <p className={styles.description}>{selectedCollection.description}</p>
        </div>
      </div>

      <div className={styles.chooser}>
        {collections.map((collection) => {
          const isActive = collection.id === selectedCollection.id;
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
