import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./WishlistRow.module.css";

type WishlistRowProps = {
  game: DemoGame;
  liked: boolean;
  onToggleLike: () => void;
  onRemove: () => Promise<void>;
  removing: boolean;
};

export function WishlistRow({ game, liked, onToggleLike, onRemove, removing }: WishlistRowProps) {
  const durationLabel = formatGameDuration(game.duration);
  return (
    <article className={styles.row}>
      <div className={styles.artwork}>
        <Artwork src={game.bannerUrl} sizes="(max-width: 720px) 100vw, 260px" />
      </div>
      <div className={styles.main}>
        <div className={styles.titleRow}>
          <h3 className={styles.title}>{game.title}</h3>
          <div className={styles.rowActions}>
            <button type="button" className={styles.likeButton} onClick={onToggleLike}>{liked ? "Saved" : "Save"}</button>
            <button type="button" className={styles.removeButton} disabled={removing} onClick={() => void onRemove()}>{removing ? "Removing…" : "Remove"}</button>
          </div>
        </div>
        <div className={styles.tagRow}>
          {game.genres.slice(0, 3).map((genre) => (
            <span key={genre} className={styles.tag}>
              {genre}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.meta}>
        {durationLabel ? <span>{durationLabel}</span> : null}
        <span>{game.addedLabel}</span>
        <div className={styles.priceRow}>
          {game.saleDiscount ? <span className={styles.discount}>{game.saleDiscount}</span> : null}
          {game.saleOriginalPrice ? <s>{game.saleOriginalPrice}</s> : null}
          <strong>{game.salePrice ?? "Price unavailable"}</strong>
        </div>
      </div>
    </article>
  );
}
