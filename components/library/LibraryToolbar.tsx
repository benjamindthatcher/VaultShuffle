import styles from "./LibraryToolbar.module.css";
import { VaultIcon } from "@/components/shared/VaultIcon";

type LibraryToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  sortReversed: boolean;
  onToggleSortDirection: () => void;
  showDurationSort: boolean;
  viewMode: "grid" | "list";
  onViewModeChange: (value: "grid" | "list") => void;
};

export function LibraryToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  sortReversed,
  onToggleSortDirection,
  showDurationSort,
  viewMode,
  onViewModeChange
}: LibraryToolbarProps) {
  return (
    <section className={styles.toolbar}>
      <label className={styles.searchField}>
        <span className={styles.hiddenLabel}>Search games</span>
        <VaultIcon name="search" size={17} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search games, genres, tags..."
        />
      </label>

      <div className={styles.controlRow}>
        <div className={styles.selectField}>
          <span className={styles.controlLabel}>
            <button
              type="button"
              className={styles.sortDirection}
              aria-label={`${sortReversed ? "Restore" : "Reverse"} current sort order`}
              aria-pressed={sortReversed}
              title={`${sortReversed ? "Restore" : "Reverse"} current sort order`}
              onClick={onToggleSortDirection}
            >
              <VaultIcon name="sort" size={15} />
            </button>
            <label htmlFor="library-sort">Sort</label>
          </span>
          <select id="library-sort" value={sort} onChange={(event) => onSortChange(event.target.value)}>
            <option value="recent">Recently played</option>
            <option value="title">Title</option>
            <option value="hours">Playtime</option>
            <option value="progress">Progress</option>
            <option value="added">Date added</option>
            {showDurationSort ? <option value="duration">Estimated length</option> : null}
            <option value="status">Status</option>
          </select>
        </div>

        <div className={styles.viewToggle} aria-label="View mode">
          <button
            type="button"
            className={viewMode === "grid" ? `${styles.toggleButton} ${styles.toggleButtonActive}` : styles.toggleButton}
            onClick={() => onViewModeChange("grid")}
            aria-pressed={viewMode === "grid"}
          >
            <VaultIcon name="grid" size={16} /> <span>Grid</span>
          </button>
          <button
            type="button"
            className={viewMode === "list" ? `${styles.toggleButton} ${styles.toggleButtonActive}` : styles.toggleButton}
            onClick={() => onViewModeChange("list")}
            aria-pressed={viewMode === "list"}
          >
            <VaultIcon name="list" size={16} /> <span>List</span>
          </button>
        </div>
      </div>
    </section>
  );
}
