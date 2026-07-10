import styles from "./LibraryToolbar.module.css";

type LibraryToolbarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  status: string;
  onStatusChange: (value: string) => void;
  viewMode: "grid" | "list";
  onViewModeChange: (value: "grid" | "list") => void;
};

export function LibraryToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  status,
  onStatusChange,
  viewMode,
  onViewModeChange
}: LibraryToolbarProps) {
  return (
    <section className={styles.toolbar}>
      <label className={styles.searchField}>
        <span className={styles.hiddenLabel}>Search games</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search games, genres, tags..."
        />
      </label>

      <div className={styles.controlRow}>
        <label className={styles.selectField}>
          <span>Sort</span>
          <select value={sort} onChange={(event) => onSortChange(event.target.value)}>
            <option value="recent">Recently played</option>
            <option value="title">Title A-Z</option>
            <option value="hours">Playtime high-low</option>
            <option value="progress">Progress high-low</option>
          </select>
        </label>

        <label className={styles.selectField}>
          <span>Filter</span>
          <select value={status} onChange={(event) => onStatusChange(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="not-started">Not Started</option>
            <option value="in-progress">In Progress</option>
            <option value="completed">Completed</option>
          </select>
        </label>

        <div className={styles.viewToggle} aria-label="View mode">
          <button
            type="button"
            className={viewMode === "grid" ? `${styles.toggleButton} ${styles.toggleButtonActive}` : styles.toggleButton}
            onClick={() => onViewModeChange("grid")}
          >
            Grid
          </button>
          <button
            type="button"
            className={viewMode === "list" ? `${styles.toggleButton} ${styles.toggleButtonActive}` : styles.toggleButton}
            onClick={() => onViewModeChange("list")}
          >
            List
          </button>
        </div>
      </div>
    </section>
  );
}
