import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import styles from "./VaultPoolPreview.module.css";

type VaultPoolPreviewProps = {
  games: DemoGame[];
  highlightedId?: string | null;
  onSelect?: (gameId: string) => void;
};

export function VaultPoolPreview({ games, highlightedId = null, onSelect }: VaultPoolPreviewProps) {
  return (
    <div className={styles.grid}>
      {games.map((game) => {
        const isHighlighted = highlightedId === game.id;
        return (
          <button
            type="button"
            key={game.id}
            className={isHighlighted ? `${styles.card} ${styles.cardHighlighted}` : styles.card}
            id={`vault-card-${game.id}`}
            onClick={() => onSelect?.(game.id)}
            aria-label={`View details for ${game.title}`}
          >
            <div className={styles.cardArt}>
              <Artwork src={game.bannerUrl} sizes="(max-width: 720px) 44vw, 210px" />
            </div>
            <div className={styles.cardBody}>
              <div className={styles.cardTopRow}>
                <h3 className={styles.cardTitle}>{game.title}</h3>
                <span className={styles.cardStatus}>{game.status}</span>
              </div>
              <p className={styles.cardCopy}>{game.description}</p>
              <div className={styles.cardMeta}>
                <span>{game.hoursPlayed > 0 ? `${game.hoursPlayed}h played` : "Fresh pick"}</span>
                <span>{game.genres.slice(0, 2).join(" · ")}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
