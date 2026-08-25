"use client";

import { useEffect, useId, useRef, useState } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import {
  EMPTY_LIBRARY_FILTERS,
  LENGTH_OPTIONS,
  PROGRESS_OPTIONS,
  activeFilterCount,
  type LibraryFilters
} from "@/lib/library-filters";
import styles from "./LibraryFilterMenu.module.css";

/**
 * Filtering, in a popover rather than another permanent row of controls.
 *
 * The toolbar could search and sort but not narrow, which is the other half of
 * what a 208-game library needs. Keeping it behind one button means adding the
 * capability without adding a second row of chrome above every page of games.
 */
export function LibraryFilterMenu({
  filters,
  genres,
  onChange
}: {
  filters: LibraryFilters;
  genres: string[];
  onChange: (filters: LibraryFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const count = activeFilterCount(filters);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggleGenre(genre: string) {
    const has = filters.genres.some((item) => item.toLowerCase() === genre.toLowerCase());
    onChange({
      ...filters,
      genres: has
        ? filters.genres.filter((item) => item.toLowerCase() !== genre.toLowerCase())
        : [...filters.genres, genre]
    });
  }

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={count ? styles.triggerActive : styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <VaultIcon name="filter" size={16} />
        <span>Filters</span>
        {/* The count is what makes a closed menu honest: without it, a library
            narrowed to four games looks like a library with four games in it. */}
        {count ? <span className={styles.badge}>{count}</span> : null}
      </button>

      {open ? (
        <div className={styles.panel} id={panelId} role="group" aria-label="Library filters">
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Progress</legend>
            <div className={styles.options}>
              {PROGRESS_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={filters.progress === option.id ? styles.optionOn : styles.option}
                  aria-pressed={filters.progress === option.id}
                  onClick={() => onChange({ ...filters, progress: option.id })}
                >{option.label}</button>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.group}>
            <legend className={styles.legend}>Length</legend>
            <div className={styles.options}>
              {LENGTH_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={filters.length === option.id ? styles.optionOn : styles.option}
                  aria-pressed={filters.length === option.id}
                  onClick={() => onChange({ ...filters, length: option.id })}
                >{option.label}</button>
              ))}
            </div>
          </fieldset>

          {genres.length ? (
            <fieldset className={styles.group}>
              <legend className={styles.legend}>Genres</legend>
              <div className={styles.options}>
                {genres.map((genre) => {
                  const on = filters.genres.some((item) => item.toLowerCase() === genre.toLowerCase());
                  return (
                    <button
                      key={genre}
                      type="button"
                      className={on ? styles.optionOn : styles.option}
                      aria-pressed={on}
                      onClick={() => toggleGenre(genre)}
                    >{genre}</button>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.clear}
              disabled={!count}
              onClick={() => onChange(EMPTY_LIBRARY_FILTERS)}
            >Clear all</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
