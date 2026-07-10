import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import styles from "./GameCard.module.css";

type GameCardProps = {
  game: DemoGame;
  layout?: "grid" | "list";
  onClick?: () => void;
};

export function GameCard({ game, layout = "grid", onClick }: GameCardProps) {
  const isList = layout === "list";
  return (
    <button
      type="button"
      className={isList ? `${styles.card} ${styles.cardList}` : styles.card}
      onClick={onClick}
    >
      <div className={isList ? `${styles.artwork} ${styles.artworkList}` : styles.artwork}>
        <Artwork src={game.artworkUrl} sizes={isList ? "260px" : "(max-width: 720px) 100vw, 33vw"} />
      </div>
      <div className={styles.body}>
        <div className={styles.topRow}>
          <h3 className={styles.title}>{game.title}</h3>
          <span className={styles.status}>{game.status}</span>
        </div>
        <p className={styles.copy}>{game.description}</p>
        <div className={styles.metaRow}>
          <span>{game.hoursPlayed > 0 ? `${game.hoursPlayed}h played` : "Fresh pick"}</span>
          <span>{game.completionPercent}% complete</span>
        </div>
      </div>
    </button>
  );
}
