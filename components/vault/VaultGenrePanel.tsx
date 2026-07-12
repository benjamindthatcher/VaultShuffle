import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import styles from "./VaultGenrePanel.module.css";

type VaultGenrePanelProps = {
  genres: string[];
  selectedGenres: string[];
  onToggleGenre: (genre: string) => void;
  onClear: () => void;
};

export function VaultGenrePanel({ genres, selectedGenres, onToggleGenre, onClear }: VaultGenrePanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.heading}>
        <VaultIcon name="filter" size={24} />
        <div>
          <h2>Genre Filters</h2>
          <p>Optional. Refine your pool.</p>
        </div>
      </div>
      <div className={styles.grid}>
        {genres.slice(0, 9).map((genre) => {
          const active = selectedGenres.includes(genre);
          return (
            <button
              key={genre}
              type="button"
              className={active ? `${styles.genre} ${styles.genreActive}` : styles.genre}
              aria-pressed={active}
              onClick={() => onToggleGenre(genre)}
            >
              <VaultIcon name={genreIconName(genre)} size={18} />
              <span>{genre}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.clear} onClick={onClear} disabled={!selectedGenres.length}><VaultIcon name="clear-filters" size={16} />Clear filters</button>
      </div>
    </section>
  );
}

function genreIconName(genre: string): VaultIconName {
  const key = genre.trim().toLowerCase();
  const iconByGenre: Record<string, VaultIconName> = {
    action: "action", adventure: "adventure", rpg: "rpg", "sci-fi": "sci-fi",
    fantasy: "fantasy", strategy: "strategy", survival: "survival", horror: "horror",
    indie: "indie", cozy: "cozy", narrative: "narrative", "open world": "open-world",
    roguelike: "roguelike", platformer: "platformer", puzzle: "puzzle",
    simulation: "sim", shooter: "shooter", exploration: "exploration"
  };
  return iconByGenre[key] ?? "genre";
}
