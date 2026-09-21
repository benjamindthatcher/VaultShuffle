"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelLeft, setPanelLeft] = useState(0);
  const [panelHeight, setPanelHeight] = useState(600);
  const panelId = useId();
  const count = activeFilterCount(filters);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(520, window.innerWidth - 32);
      setPanelLeft(Math.max(16, Math.min(trigger.left - 180, window.innerWidth - width - 16)) - trigger.left);
      setPanelHeight(Math.max(180, window.innerHeight - trigger.bottom - 26));
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
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
    <div className={styles.container} ref={containerRef} onBlur={(event) => {
      // A label click blurs the current control before focusing its checkbox.
      // Only dismiss for a known focus destination outside; pointerdown handles
      // outside clicks, including non-focusable surfaces and touch input.
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
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
        <div ref={panelRef} className={styles.panel} style={{ left: panelLeft, "--notch-left": `${Math.min(480, Math.max(24, -panelLeft + 42))}px` } as React.CSSProperties} id={panelId} role="group" aria-label="Library filters">
          <div className={styles.panelScroll} style={{ maxHeight: panelHeight }}>
          <header className={styles.header}><div><h2>Filters</h2><p>{count} active {count === 1 ? "filter" : "filters"}</p></div><button type="button" className={styles.clear} disabled={!count} onClick={() => onChange(EMPTY_LIBRARY_FILTERS)}>Clear all</button></header>
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
              <legend className={styles.legend}>Genres <span>{filters.genres.length} selected</span></legend>
              <div className={styles.genres}>
                {genres.map((genre) => {
                  const on = filters.genres.some((item) => item.toLowerCase() === genre.toLowerCase());
                  return (
                    <label key={genre} className={styles.genre} data-selected={on || undefined}>
                      <input type="checkbox" checked={on} onChange={() => toggleGenre(genre)} />
                      <span className={styles.indicator} aria-hidden="true">{on ? <VaultIcon name="check" size={13} /> : null}</span>
                      <span>{genre}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          </div>
        </div>
      ) : null}
    </div>
  );
}
