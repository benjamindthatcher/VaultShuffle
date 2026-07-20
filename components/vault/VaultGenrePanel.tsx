import { VaultIcon } from "@/components/shared/VaultIcon";
import { VaultGenreIcon } from "@/components/vault/VaultGenreIcon";
import { VAULT_GENRES } from "@/lib/vault-genres";
import styles from "./VaultGenrePanel.module.css";

type VaultGenrePanelProps = {
  selectedGenres: string[];
  onToggleGenre: (genre: string) => void;
  onClear: () => void;
};

export function VaultGenrePanel({ selectedGenres, onToggleGenre, onClear }: VaultGenrePanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.heading}>
        <VaultIcon name="filter" size={24} />
        <div>
          <h2>Genre Filters</h2>
          <p>Optional. Refine your pool. <strong>{selectedGenres.length}/3</strong></p>
        </div>
        <button type="button" className={styles.clear} onClick={onClear} disabled={!selectedGenres.length}><VaultIcon name="clear-filters" size={16} />Clear filters</button>
      </div>
      <div className={styles.grid}>
        {VAULT_GENRES.map((genre) => {
          const active = selectedGenres.includes(genre.label);
          return (
            <button
              key={genre.id}
              type="button"
              className={active ? `${styles.genre} ${styles.genreActive}` : styles.genre}
              aria-pressed={active}
              onClick={() => onToggleGenre(genre.label)}
            >
              <VaultGenreIcon genre={genre} />
              <span>{genre.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
