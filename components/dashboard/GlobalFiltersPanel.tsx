"use client";

import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import {
  DEFAULT_GLOBAL_FILTERS,
  activeGlobalFilterCount,
  isDefaultGlobalFilters,
  type GlobalFilters
} from "@/lib/global-filters";
import styles from "./GlobalFiltersPanel.module.css";

/**
 * The layer above everything else.
 *
 * The average active library here runs to around five hundred games. Deciding
 * those one at a time is a thousand taps; saying "nothing older than five years,
 * single-player only" is four, and it holds. That is what this panel is for -
 * cutting the shelf down to what someone would ever actually play, so the Vault
 * and the Library are both working from a real pool.
 *
 * Release age leads because it cuts the most: about 40% of the average library
 * here is ten years or older, and only 8% is from the last two years.
 */

type Choice<T extends string> = { id: T; label: string; hint?: string };

const RELEASE_AGE: Choice<GlobalFilters["releaseAge"]>[] = [
  { id: "any", label: "Any" },
  { id: "recent", label: "Last 2 years" },
  { id: "modern", label: "Last 5 years" },
  { id: "established", label: "5 years+" },
  { id: "classic", label: "Classics" }
];

const PLAYERS: Choice<GlobalFilters["players"]>[] = [
  { id: "any", label: "Any" },
  { id: "single", label: "Single-player" },
  { id: "coop", label: "Co-op" },
  { id: "multi", label: "Multiplayer" }
];

const GAME_TYPE: Choice<GlobalFilters["gameType"]>[] = [
  { id: "all", label: "All" },
  { id: "finite", label: "Has an ending" },
  { id: "endless", label: "Endless" }
];

const DEVICE: Choice<GlobalFilters["device"]>[] = [
  { id: "all", label: "Any device" },
  { id: "mac", label: "Mac" },
  { id: "deck", label: "Steam Deck" }
];

export function GlobalFiltersPanel() {
  const { globalFilters, setGlobalFilters, games, unfilteredGameCount, guestCatalogueIsFallback } = useAppData();

  // The bundled preview has no release dates, categories or platform flags, so
  // every filter here could only answer "no" and would empty the page. Better to
  // not offer them than to offer them broken.
  if (guestCatalogueIsFallback) return null;

  const activeCount = activeGlobalFilterCount(globalFilters);
  const isDefault = isDefaultGlobalFilters(globalFilters);
  const hidden = Math.max(0, unfilteredGameCount - games.length);

  function choose<K extends keyof GlobalFilters>(key: K, value: GlobalFilters[K]) {
    setGlobalFilters({ ...globalFilters, [key]: value });
  }

  function renderRow<K extends "releaseAge" | "players" | "gameType" | "device">(
    key: K,
    label: string,
    choices: Choice<GlobalFilters[K]>[]
  ) {
    return (
      <div className={styles.row}>
        <span className={styles.rowLabel} id={`global-filter-${key}`}>{label}</span>
        {/* Chips wrap rather than sharing fixed columns: five options never fit
            across a phone, and a wrapping row cannot overflow the page the way a
            grid with a minimum column width does. */}
        <div className={styles.choices} role="group" aria-labelledby={`global-filter-${key}`}>
          {choices.map((choice) => {
            const active = globalFilters[key] === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                className={active ? styles.choiceOn : styles.choice}
                aria-pressed={active}
                onClick={() => choose(key, choice.id)}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="global-filters-heading">
      <div className={styles.header}>
        <div className={styles.headingGroup}>
          <h2 id="global-filters-heading" className={styles.heading}>
            <VaultIcon name="filter" size={18} />
            Global filters
          </h2>
          <p className={styles.subheading}>
            These apply everywhere — the Vault, the Library, every count. Set them once
            instead of ruling games out one at a time.
          </p>
        </div>

        {isDefault ? null : (
          <button type="button" className={styles.clear} onClick={() => setGlobalFilters(DEFAULT_GLOBAL_FILTERS)}>
            Clear {activeCount}
          </button>
        )}
      </div>

      {renderRow("releaseAge", "Release age", RELEASE_AGE)}
      {renderRow("players", "How you play", PLAYERS)}
      {renderRow("gameType", "Game type", GAME_TYPE)}
      {renderRow("device", "Device", DEVICE)}

      <div className={styles.row}>
        <span className={styles.rowLabel} id="global-filter-reviews">Reviews</span>
        <div className={styles.choices} role="group" aria-labelledby="global-filter-reviews">
          <button
            type="button"
            className={globalFilters.hidePoorlyReviewed ? styles.choiceOn : styles.choice}
            aria-pressed={globalFilters.hidePoorlyReviewed}
            onClick={() => choose("hidePoorlyReviewed", !globalFilters.hidePoorlyReviewed)}
          >
            Hide poorly reviewed
          </button>
        </div>
      </div>

      {/* What the filters actually did. Without this the panel asks for trust:
          a chip is on, and somewhere a number changed. */}
      <p className={styles.summary} aria-live="polite">
        {isDefault
          ? `All ${unfilteredGameCount} games are in play.`
          : `${games.length} of ${unfilteredGameCount} games in play${hidden ? ` · ${hidden} filtered out` : ""}.`}
      </p>
    </section>
  );
}
