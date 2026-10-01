import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { collectionBanner, gameArtworkFallback } from "@/lib/vaultshuffle-assets";
import styles from "./CollectionCard.module.css";
import { FamilyGameMark } from "@/components/shared/FamilyMark";

type CollectionCardProps = {
  collection: DemoCollection;
  previewGames: DemoGame[];
  selected?: boolean;
  onSelect: () => void;
};

export function CollectionCard({ collection, previewGames, selected = false, onSelect }: CollectionCardProps) {
  const previews = collection.preview ? collection.preview.map(item=>({id:String(item.gameId),title:item.title,
    bannerUrl:item.imageUrl??gameArtworkFallback(item.title),accessSource:item.access,familyOwnerName:null})) : previewGames;
  return (
    <button
      type="button"
      data-vault-card="interactive"
      className={`${styles.card} ${selected ? styles.cardSelected : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <div className={styles.banner}>
        <Artwork
          src={collection.artworkUrl}
          fallbackSrc={collectionBanner(collection.name, collection.smartPreset)}
          sizes="(max-width: 720px) 100vw, 33vw"
        />
        <span className={styles.kindLabel}>{collection.kind === "smart" ? "Smart collection" : "Custom collection"}</span>
        <h3 className={styles.title}>{collection.name}</h3>
        <p className={styles.copy}>{collection.description}</p>
      </div>

      <div className={styles.footer}>
        <div className={styles.thumbRow}>
          {previews.slice(0, 4).map((game) => (
            <span key={game.id} className={styles.thumb}>
              <Artwork src={game.bannerUrl} fallbackSrc={gameArtworkFallback(game.title)} sizes="52px" /><FamilyGameMark game={game} overlay />
            </span>
          ))}
        </div>
        <span className={styles.selectedLabel} aria-hidden="true">{selected ? "Selected" : ""}</span>
        <span className={styles.countLabel}>{collection.count ?? previewGames.length} games</span>
      </div>
    </button>
  );
}
