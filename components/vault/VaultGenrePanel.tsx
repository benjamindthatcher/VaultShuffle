import { VaultIcon } from "@/components/shared/VaultIcon";
import { VaultGenreIcon } from "@/components/vault/VaultGenreIcon";
import { VAULT_GENRES } from "@/lib/vault-genres";
import styles from "./VaultGenrePanel.module.css";

type VaultGenrePanelProps = {
  selectedGenres: string[];
  onToggleGenre: (genre: string) => void;
  onClear: () => void;
  embedded?: boolean;
  disabled?: boolean;
};

export function VaultGenrePanel({ selectedGenres, onToggleGenre, onClear, embedded = false, disabled = false }: VaultGenrePanelProps) {
  return (
    <section className={embedded ? `${styles.panel} ${styles.panelEmbedded}` : styles.panel} data-disabled={disabled || undefined} aria-disabled={disabled || undefined}>
      <div className={embedded ? `${styles.heading} ${styles.headingEmbedded}` : styles.heading}>
        {embedded ? null : <VaultIcon name="filter" size={24} />}
        <div>
          {embedded ? null : <h2>Genre Filters</h2>}
          <p>{disabled ? "Available for Vault Draws only." : embedded ? "Choose up to three genres." : "Optional. Refine your pool."} {!disabled ? <strong>{selectedGenres.length}/3</strong> : null}</p>
        </div>
        <button type="button" className={styles.clear} onClick={onClear} disabled={disabled || !selectedGenres.length}><VaultIcon name="clear-filters" size={16} />Clear filters</button>
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
              disabled={disabled}
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
