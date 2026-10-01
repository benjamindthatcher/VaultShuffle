import { LibrarySortMenu } from "./LibrarySortMenu";
import styles from "./LibraryToolbar.module.css";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { LibraryFilterMenu } from "./LibraryFilterMenu";
import type { LibraryFilters } from "@/lib/library-filters";

type LibraryToolbarProps = {
  selectionMode: boolean;
  onToggleSelection: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  sortReversed: boolean;
  onToggleSortDirection: () => void;
  showDurationSort: boolean;
  viewMode: "grid" | "list";
  onViewModeChange: (value: "grid" | "list") => void;
  filters: LibraryFilters;
  filterGenres: string[];
  onFiltersChange: (filters: LibraryFilters) => void;
};

export function LibraryToolbar({
  selectionMode,
  onToggleSelection,
  query,
  onQueryChange,
  sort,
  onSortChange,
  sortReversed,
  onToggleSortDirection,
  showDurationSort,
  viewMode,
  onViewModeChange,
  filters,
  filterGenres,
  onFiltersChange
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
        <LibraryFilterMenu filters={filters} genres={filterGenres} onChange={onFiltersChange} />

        <div className={styles.selectField}>
          <label className={styles.controlLabel} id="library-sort-label" htmlFor="library-sort">Sort</label>
          <div className={styles.sortControl} role="group" aria-labelledby="library-sort-label">
            <button
              type="button"
              data-vault-control="secondary" data-control-size="icon"
              className={styles.sortDirection}
              aria-label={`${sortReversed ? "Restore" : "Reverse"} current sort order`}
              aria-pressed={sortReversed}
              title={`${sortReversed ? "Restore" : "Reverse"} current sort order`}
              onClick={onToggleSortDirection}
            >
              <VaultIcon name="sort" size={17} />
            </button>
            <LibrarySortMenu value={sort} onChange={onSortChange} showDuration={showDurationSort} />
          </div>
        </div>

        <button
          type="button"
          data-vault-control="secondary"
          className={styles.viewToggle}
          aria-label={`Switch to ${viewMode === "grid" ? "list" : "grid"} view`}
          title={`Switch to ${viewMode === "grid" ? "list" : "grid"} view`}
          onClick={() => onViewModeChange(viewMode === "grid" ? "list" : "grid")}
        >
          <VaultIcon name={viewMode === "grid" ? "list" : "grid"} size={16} />
          <span>{viewMode === "grid" ? "List" : "Grid"}</span>
        </button>
        <button type="button" data-vault-control="secondary" className={styles.selectionToggle} aria-pressed={selectionMode} onClick={onToggleSelection}><VaultIcon name="check" size={16} /><span>{selectionMode ? "Done" : "Select"}</span></button>
      </div>
    </section>
  );
}
