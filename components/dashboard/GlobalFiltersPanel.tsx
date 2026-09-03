"use client";

import { useMemo, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import {
  DEFAULT_GLOBAL_FILTERS,
  activeGlobalFilterCount,
  isDefaultGlobalFilters,
  type GlobalFilters
} from "@/lib/global-filters";
import { isFamilyAccess } from "@/lib/family-sharing";
import {
  EXCLUSION_CATEGORIES,
  EXCLUSION_GROUP_LABELS,
  availableExclusionCategories,
  type ExclusionGroup
} from "@/lib/exclusion-categories";
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
 *
 * It governs the page it sits on top of, so it has to stay small: five groups
 * laid out across two rows rather than five stacked full-width ones, and the
 * count it produces in the header beside the button that resets it.
 */

type GroupKey = "releaseAge" | "players" | "gameType" | "device" | "access";

type Choice<T extends string> = { id: T; label: string };

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
  { id: "linux", label: "Linux" },
  { id: "deck", label: "Steam Deck" }
];

const ACCESS: Choice<GlobalFilters["access"]>[] = [
  { id: "all", label: "All" },
  { id: "owned", label: "Only mine" },
  { id: "family", label: "Family only" }
];

export function GlobalFiltersPanel() {
  const { globalFilters, setGlobalFilters, games, allGames, unfilteredGameCount } = useAppData();
  // Collapsed by default. Twenty-two chips is the largest control on the page by
  // a distance, and the panel governs the page it sits on top of - it earns its
  // room only once someone has gone looking for it.
  const [showExclusions, setShowExclusions] = useState(false);

  // Only the categories this library actually contains. Offering "VR" to someone
  // who owns no VR game is a control whose every setting produces the same list.
  const availableExclusions = useMemo(
    () => availableExclusionCategories(allGames.map((game) => game.exclusions)),
    [allGames]
  );
  const offered = useMemo(
    () => EXCLUSION_CATEGORIES.filter((category) => availableExclusions.has(category.id)),
    [availableExclusions]
  );
  const excludedCount = globalFilters.excluded.length;

  function toggleExclusion(id: string) {
    const next = globalFilters.excluded.includes(id)
      ? globalFilters.excluded.filter((held) => held !== id)
      : [...globalFilters.excluded, id];
    setGlobalFilters({ ...globalFilters, excluded: next });
  }

  // Only offered once there is something to filter. A library with no shared
  // games would get a control whose every option produces the same list, which
  // is worse than no control - it implies a distinction that is not there.
  const hasFamilyGames = allGames.some((game) => isFamilyAccess(game.accessSource));

  const activeCount = activeGlobalFilterCount(globalFilters);
  const isDefault = isDefaultGlobalFilters(globalFilters);

  function choose<K extends keyof GlobalFilters>(key: K, value: GlobalFilters[K]) {
    setGlobalFilters({ ...globalFilters, [key]: value });
  }

  function renderGroup<K extends GroupKey>(
    key: K,
    label: string,
    choices: Choice<GlobalFilters[K]>[],
    width?: "wide" | "mid"
  ) {
    // "Any" is selected in every group by default, so selection alone says
    // nothing. What matters is whether a group is ruling anything out, and only
    // that gets the accent - here and on the dot beside the label.
    const narrowing = globalFilters[key] !== DEFAULT_GLOBAL_FILTERS[key];

    return (
      <div className={styles.group} data-width={width}>
        <span className={styles.groupLabel} id={`global-filter-${key}`}>
          {label}
          {narrowing ? <span className={styles.groupDot} aria-hidden="true" /> : null}
        </span>
        {/* Chips wrap inside their well rather than sharing fixed columns: five
            options never fit across a phone, and a wrapping row cannot overflow
            the page the way a grid with a minimum column width does. */}
        <div className={styles.choices} role="group" aria-labelledby={`global-filter-${key}`}>
          {choices.map((choice) => {
            const active = globalFilters[key] === choice.id;
            const neutral = choice.id === DEFAULT_GLOBAL_FILTERS[key];
            return (
              <button
                key={choice.id}
                type="button"
                className={!active ? styles.choice : neutral ? styles.choiceCurrent : styles.choiceOn}
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
            Applied everywhere — the Vault, the Library, every count below.
          </p>
        </div>

        {/* What the filters actually did, next to the control that undoes it.
            Without this the panel asks for trust: a chip is on, and somewhere a
            number changed. */}
        <div className={styles.status}>
          <p className={`${styles.count} ${isDefault ? "" : styles.countNarrowed}`} aria-live="polite">
            <span className={styles.countValue}>{games.length}</span>
            <span className={styles.countLabel}>
              {isDefault ? "games in play" : `of ${unfilteredGameCount} in play`}
            </span>
          </p>

          {isDefault ? null : (
            <button type="button" className={styles.clear} onClick={() => setGlobalFilters(DEFAULT_GLOBAL_FILTERS)}>
              <VaultIcon name="clear-filters" size={15} />
              Clear {activeCount}
            </button>
          )}
        </div>
      </div>

      <div className={styles.grid}>
        {renderGroup("releaseAge", "Release age", RELEASE_AGE, "wide")}
        {renderGroup("players", "How you play", PLAYERS, "mid")}
        {renderGroup("gameType", "Game type", GAME_TYPE)}
        {renderGroup("device", "Device", DEVICE)}
        {hasFamilyGames ? renderGroup("access", "Library", ACCESS) : null}

        <div className={styles.group}>
          <span className={styles.groupLabel} id="global-filter-reviews">
            Reviews
            {globalFilters.hidePoorlyReviewed ? <span className={styles.groupDot} aria-hidden="true" /> : null}
          </span>
          <div className={styles.choices}>
            {/* A switch, not a chip. There is no second option for it to be one
                of, and drawn as a chip it looked like a choice with the rest of
                its row missing. */}
            <button
              type="button"
              role="switch"
              aria-checked={globalFilters.hidePoorlyReviewed}
              aria-labelledby="global-filter-reviews-label"
              className={globalFilters.hidePoorlyReviewed ? `${styles.switch} ${styles.switchOn}` : styles.switch}
              onClick={() => choose("hidePoorlyReviewed", !globalFilters.hidePoorlyReviewed)}
            >
              <span className={styles.switchTrack} aria-hidden="true">
                <span className={styles.switchKnob} />
              </span>
              <span id="global-filter-reviews-label">Hide poorly reviewed</span>
            </button>
          </div>
        </div>
      </div>

      {offered.length ? (
        <div className={styles.exclusions}>
          <button
            type="button"
            className={styles.exclusionsToggle}
            aria-expanded={showExclusions}
            onClick={() => setShowExclusions((open) => !open)}
          >
            <span className={styles.groupLabel}>
              Never show me
              {excludedCount ? <span className={styles.groupDot} aria-hidden="true" /> : null}
            </span>
            <span className={styles.exclusionsSummary}>
              {excludedCount
                ? `${excludedCount} ${excludedCount === 1 ? "kind" : "kinds"} of game hidden`
                : "Rule out whole kinds of game"}
            </span>
            <VaultIcon name={showExclusions ? "chevron-up" : "chevron-down"} size={15} />
          </button>

          {showExclusions ? (
            <div className={styles.exclusionGroups}>
              {(Object.keys(EXCLUSION_GROUP_LABELS) as ExclusionGroup[]).map((group) => {
                const inGroup = offered.filter((category) => category.group === group);
                if (!inGroup.length) return null;
                return (
                  <div className={styles.group} key={group}>
                    <span className={styles.groupLabel} id={`exclusion-group-${group}`}>
                      {EXCLUSION_GROUP_LABELS[group]}
                    </span>
                    <div className={styles.choices} role="group" aria-labelledby={`exclusion-group-${group}`}>
                      {inGroup.map((category) => {
                        const on = globalFilters.excluded.includes(category.id);
                        return (
                          <button
                            key={category.id}
                            type="button"
                            className={on ? styles.choiceOn : styles.choice}
                            aria-pressed={on}
                            onClick={() => toggleExclusion(category.id)}
                          >
                            {category.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {excludedCount ? (
                <button
                  type="button"
                  className={styles.exclusionsReset}
                  onClick={() => setGlobalFilters({ ...globalFilters, excluded: [] })}
                >
                  Show everything again
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
