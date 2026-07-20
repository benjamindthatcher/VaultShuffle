import styles from "./VaultGenreDrawer.module.css";

type VaultGenreDrawerProps = {
  open: boolean;
  genres: string[];
  selectedGenres: string[];
  onToggleGenre: (genre: string) => void;
  onClose: () => void;
  onClear: () => void;
};

export function VaultGenreDrawer({
  open,
  genres,
  selectedGenres,
  onToggleGenre,
  onClose,
  onClear
}: VaultGenreDrawerProps) {
  return (
    <>
      <div
        className={open ? `${styles.overlay} ${styles.overlayOpen}` : styles.overlay}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={open ? `${styles.drawer} ${styles.drawerOpen}` : styles.drawer} aria-hidden={!open}>
        <div className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Optional</p>
            <h2 className={styles.title}>Genre filters</h2>
          </div>
          <button type="button" className={styles.ghostButton} onClick={onClose}>
            Close
          </button>
        </div>

        <p className={styles.copy}>
          Refine your pool with genre preferences. Matching gets stricter as you add more chips.
        </p>

        <div className={styles.genreGrid}>
          {genres.map((genre) => {
            const isActive = selectedGenres.includes(genre);
            return (
              <button
                key={genre}
                type="button"
                className={isActive ? `${styles.genreChip} ${styles.genreChipActive}` : styles.genreChip}
                onClick={() => onToggleGenre(genre)}
              >
                {genre}
              </button>
            );
          })}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.ghostButton} onClick={onClear}>
            Clear all
          </button>
          <button type="button" className={styles.applyButton} onClick={onClose}>
            Apply filters
          </button>
        </div>
      </aside>
    </>
  );
}
