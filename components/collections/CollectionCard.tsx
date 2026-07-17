import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import styles from "./CollectionCard.module.css";

type CollectionCardProps = {
  collection: DemoCollection;
  previewGames: DemoGame[];
  selected?: boolean;
  onSelect: () => void;
};

export function CollectionCard({ collection, previewGames, selected = false, onSelect }: CollectionCardProps) {
  return (
    <button
      type="button"
      className={`${styles.card} ${selected ? styles.cardSelected : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <div className={styles.banner}>
        <Artwork src={collection.artworkUrl} sizes="(max-width: 720px) 100vw, 33vw" />
        <span className={styles.kindLabel}>{collection.kind === "smart" ? "Smart collection" : "Custom collection"}</span>
        <h3 className={styles.title}>{collection.name}</h3>
        <p className={styles.copy}>{collection.description}</p>
      </div>

      <div className={styles.footer}>
        <div className={styles.thumbRow}>
          {previewGames.slice(0, 4).map((game) => (
            <span key={game.id} className={styles.thumb}>
              <Artwork src={game.artworkUrl} sizes="52px" />
            </span>
          ))}
        </div>
        <span className={styles.countLabel}>{previewGames.length} games</span>
      </div>
    </button>
  );
}
