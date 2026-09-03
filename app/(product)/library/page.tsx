"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { CompletionCelebration } from "@/components/library/CompletionCelebration";
import { PinnedCommitments } from "@/components/shared/PinnedCommitments";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { trackCompletionClaim, trackCompletionUndone } from "@/lib/completion-tracking";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { LibraryGameGrid } from "@/components/library/LibraryGameGrid";
import { LibraryToolbar } from "@/components/library/LibraryToolbar";
import { SectionHeading } from "@/components/shared/SectionHeading";
import { EMPTY_LIBRARY_FILTERS, availableGenres, matchesLibraryFilters, type LibraryFilters } from "@/lib/library-filters";
import { PlaceholderSlots } from "@/components/shared/PlaceholderSlots";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { recencySortKey } from "@/lib/recency";
import type { DemoGame } from "@/lib/demo-data";
import { estimatedTimeToBeatMinutes } from "@/lib/game-duration";
import styles from "./library.module.css";

const STATUS_SORT_RANK: Record<DemoGame["status"], number> = {
  Completed: 4,
  "In Progress": 3,
  "Not Started": 2,
  Slept: 1
};

export default function LibraryPage() {
  const { games, allGames, collections, vaultState, isLive, updateGame, restoreGame, setGameCollection, recordVaultAction } = useAppData();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [sort, setSort] = useState("hours");
  const [sortReversed, setSortReversed] = useState(false);
  const [statusTab, setStatusTab] = useState<"active" | "slept" | "completed">("active");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<"recent" | "catalogue" | "pinned" | null>(null);
  const [savingGameId, setSavingGameId] = useState<string | null>(null);
  const [undoGameId, setUndoGameId] = useState<string | null>(null);
  const [celebratingId, setCelebratingId] = useState<string | null>(null);
  const [pinCandidate, setPinCandidate] = useState<DemoGame | null>(null);
  /**
   * Selection only exists on the decided shelves. Purge used to be where a
   * backlog got sorted in bulk; this is that, on the page that already holds the
   * games.
   */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const undoTimerRef = useRef<number | null>(null);

  // A different shelf is a different set of games, so whatever was ticked on the
  // last one must not carry over and be acted on here.
  useEffect(() => {
    setSelectedIds([]);
  }, [statusTab]);

  useEffect(() => {
    setSelectedIds([]);
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab === "slept" || requestedTab === "completed" || requestedTab === "active") setStatusTab(requestedTab);

    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  const libraryGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);
  const hasDurationSort = useMemo(
    () => libraryGames.some((game) => estimatedTimeToBeatMinutes(game.duration) !== null),
    [libraryGames]
  );

  const recentActivity = useMemo(
    () => [...libraryGames]
      // Games we actually know were played. This used to test the sort key for
      // being positive, back when it was a timestamp; the key is now a negated
      // day count, so that test excluded everything and the row went empty.
      .filter((game) => game.hoursPlayed > 0 && Boolean(game.recency?.known))
      .sort((left, right) => {
        const comparison = sortableLastPlayed(right) - sortableLastPlayed(left);
        return comparison || left.title.localeCompare(right.title);
      })
      .slice(0, 4),
    [libraryGames]
  );

  async function markCompleted(gameId: string) {
    const game = games.find((entry) => entry.id === gameId);
    await updateGame(gameId, { status: "Completed" });
    if (game) trackCompletionClaim(game, "library", isLive);
    setCelebratingId(gameId);
    setUndoGameId(gameId);
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => setUndoGameId(null), 5300);
  }

  async function restoreCompleted(gameId: string) {
    const game = games.find((entry) => entry.id === gameId);
    setCelebratingId(null);
    await restoreGame(gameId);
    if (game) trackCompletionUndone(game, "library", isLive);
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    setUndoGameId(null);
  }

  const statusCounts = useMemo(() => ({
    active: libraryGames.filter((game) => game.status !== "Slept" && game.status !== "Completed").length,
    slept: libraryGames.filter((game) => game.status === "Slept").length,
    completed: libraryGames.filter((game) => game.status === "Completed").length
  }), [libraryGames]);

  const filteredGames = useMemo(() => {
    const queryText = query.trim().toLowerCase();

    return [...libraryGames]
      .filter((game) => {
        const matchesQuery =
          !queryText ||
          game.title.toLowerCase().includes(queryText) ||
          game.genres.join(" ").toLowerCase().includes(queryText);

        const matchesStatus = statusTab === "active"
          ? game.status !== "Slept" && game.status !== "Completed"
          : statusTab === "slept" ? game.status === "Slept" : game.status === "Completed";

        return matchesQuery && matchesStatus && matchesLibraryFilters(game, filters);
      })
      .sort((left, right) => {
        let comparison: number;
        if (sort === "title") comparison = left.title.localeCompare(right.title);
        else if (sort === "hours") comparison = right.hoursPlayed - left.hoursPlayed;
        else if (sort === "progress") comparison = right.completionPercent - left.completionPercent;
        else if (sort === "added") comparison = sortableAddedDate(right) - sortableAddedDate(left);
        else if (sort === "duration") comparison = sortableDuration(left) - sortableDuration(right);
        else if (sort === "status") comparison = STATUS_SORT_RANK[right.status] - STATUS_SORT_RANK[left.status];
        else if (statusTab === "slept") comparison = Date.parse(right.sleptAt || "") - Date.parse(left.sleptAt || "");
        else if (statusTab === "completed") comparison = Date.parse(right.completedAt || "") - Date.parse(left.completedAt || "");
        else comparison = sortableLastPlayed(right) - sortableLastPlayed(left);

        if (!Number.isFinite(comparison) || comparison === 0) comparison = left.title.localeCompare(right.title);

        return sortReversed ? -comparison : comparison;
      });
  }, [filters, libraryGames, query, sort, sortReversed, statusTab]);

  // Offered from the whole library rather than the current tab, so the list of
  // genres does not shuffle every time the tab changes.
  const filterGenres = useMemo(() => availableGenres(libraryGames), [libraryGames]);

  const selectedGame = filteredGames.find((game) => game.id === selectedGameId)
    ?? libraryGames.find((game) => game.id === selectedGameId)
    ?? allGames.find((game) => game.id === selectedGameId)
    ?? null;
  const celebratingGame = celebratingId ? games.find((game) => game.id === celebratingId) ?? null : null;
  // Pins outrank the global filters. A pinned game the filters have ruled out is
  // still pinned, and has to stay reachable here - otherwise the manage dialog
  // offers two of three pins and the third can be neither replaced nor removed.
  const pinnedGames = vaultState.pinnedIds
    .map((id) => libraryGames.find((game) => game.id === id) ?? allGames.find((game) => game.id === id))
    .filter((game): game is DemoGame => Boolean(game))
    .filter((game) => game.status !== "Slept" && game.status !== "Completed");
  const visiblePinnedGames = statusTab === "active" ? pinnedGames.filter((game) => filteredGames.some((item) => item.id === game.id)) : [];
  const ordinaryGames = filteredGames.filter((game) => !visiblePinnedGames.some((pinned) => pinned.id === game.id));

  // Active is a shelf you browse; slept and completed are shelves you tidy.
  const selectionMode = statusTab !== "active";
  // Scoped to what is on screen, so "select all" and the count can never claim
  // more than the current search and filters are actually showing.
  const selected = new Set(selectedIds.filter((id) => ordinaryGames.some((game) => game.id === id)));
  const allShownSelected = ordinaryGames.length > 0 && ordinaryGames.every((game) => selected.has(game.id));

  function toggleSelected(gameId: string) {
    setSelectedIds((current) => current.includes(gameId)
      ? current.filter((id) => id !== gameId)
      : [...current, gameId]);
  }

  /**
   * Wake or restore everything ticked.
   *
   * Sequential rather than parallel: this is the same write budget the
   * completion sweep has to live inside, and thirty games fired at once is how
   * that gets spent in one go.
   */
  async function restoreSelected() {
    const ids = ordinaryGames.filter((game) => selected.has(game.id)).map((game) => game.id);
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      for (const id of ids) await restoreGame(id, { silent: true });
      trackEvent(ANALYTICS_EVENTS.gameStatusChanged, {
        status: "Active",
        restored: true,
        bulk: true,
        from: statusTab,
        count: ids.length
      });
      setSelectedIds([]);
    } finally {
      setBulkBusy(false);
    }
  }

  async function togglePin(game: DemoGame) {
    if (vaultState.pinnedIds.includes(game.id)) await recordVaultAction("unpinned", game.id);
    else if (vaultState.pinnedIds.length < 3) await recordVaultAction("pinned", game.id);
    else setPinCandidate(game);
  }

  async function toggleSelectedPin() {
    if (!selectedGame) return;
    const removingPinnedSpotlight = selectedSurface === "pinned" && vaultState.pinnedIds.includes(selectedGame.id);
    await togglePin(selectedGame);
    if (removingPinnedSpotlight) {
      setSelectedGameId(null);
      setSelectedSurface(null);
    }
  }

  function openGame(gameId: string, surface: "recent" | "catalogue" | "pinned") {
    setSelectedGameId(gameId);
    setSelectedSurface(surface);
  }

  function closeGameDetails() {
    setSelectedGameId(null);
    setSelectedSurface(null);
  }

  return (
    <section className={styles.libraryPage}>
      <h1 className="visually-hidden">Library</h1>

      {!isLive ? (
        <GuestPreviewNotice feature="Library" icon="all-games">
          Browse and filter the live guest catalogue. Any statuses, pins or notes you try are temporary until you connect a public Steam library.
        </GuestPreviewNotice>
      ) : null}




      {/* The same shelf the Vault and the Dashboard use. This page had its own,
          built from the full library card, which stretched to the height of the
          empty slots beside it and left a hole between the title and the stats
          line. */}
      <PinnedCommitments
        games={games}
        pins={vaultState.pins ?? []}
        pinnedIds={vaultState.pinnedIds}
        onSelect={(gameId) => openGame(gameId, "pinned")}
        onUnpin={(gameId) => {
          const game = allGames.find((entry) => entry.id === gameId);
          if (game) void togglePin(game);
        }}
        compact
      />

      {celebratingGame ? (
        <CompletionCelebration
          game={celebratingGame}
          games={games}
          pin={(vaultState.pins ?? []).find((entry) => entry.gameId === celebratingGame.id)}
          onDismiss={() => setCelebratingId(null)}
          onUndo={() => void restoreCompleted(celebratingGame.id)}
        />
      ) : null}

      <section className={styles.section}>
        <SectionHeading title={isLive ? "Recent activity" : "A few games in the preview"} />
        <div className={styles.recentRow}>
          {(isLive ? recentActivity : libraryGames.slice(0, 4)).map((game) => (
            <button key={game.id} type="button" className={styles.recentCard} onClick={() => openGame(game.id, "recent")}>
              <span className={styles.recentArtwork}>
                <Artwork src={game.bannerUrl} sizes="(max-width: 720px) 80vw, 260px" />
              </span>
              <div className={styles.recentBody}>
                <strong>{game.title}</strong>
                {(() => { const meta = isLive ? game.lastPlayedLabel : game.genres.slice(0, 2).join(" · ") || "Guest catalogue"; return meta ? <span>{meta}</span> : null; })()}
              </div>
            </button>
          ))}
        </div>
      </section>

      <div className={styles.statusTabs} role="tablist" aria-label={isLive ? "Library status" : "Preview status"}>
        {(["active", "slept", "completed"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={statusTab === tab} className={statusTab === tab ? styles.statusTabActive : styles.statusTab} onClick={() => setStatusTab(tab)}>
            <span>{tab[0].toUpperCase() + tab.slice(1)}</span><strong>{statusCounts[tab]}</strong>
          </button>
        ))}
      </div>

      <section className={`${styles.section} ${styles.gamesSection}`} role="tabpanel" aria-label={`${statusTab} games`}>
        {/* No heading: the status tabs directly above already name this panel and
            carry its count, so "Active games 208" underneath "Active 208" was the
            same fact twice. The label stays for screen readers via aria-label. */}
        <div className={styles.gamesToolbar}>
          <LibraryToolbar
            query={query}
            onQueryChange={setQuery}
            sort={sort}
            onSortChange={(value) => {
              setSort(value);
              setSortReversed(false);
            }}
            sortReversed={sortReversed}
            onToggleSortDirection={() => setSortReversed((current) => !current)}
            showDurationSort={hasDurationSort}
            filters={filters}
            filterGenres={filterGenres}
            onFiltersChange={setFilters}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        </div>
        {/* Sits directly above the grid it fills, rather than at the foot of it:
            ticking "select all 31" and then scrolling past all 31 to reach the
            button that acts on them was how the old page did this. */}
        {selectionMode && ordinaryGames.length ? (
          <div className={styles.bulkRow}>
            <label className={styles.bulkCheck}>
              <input
                type="checkbox"
                checked={allShownSelected}
                ref={(node) => {
                  if (!node) return;
                  node.indeterminate = selected.size > 0 && !allShownSelected;
                }}
                onChange={(event) => setSelectedIds(event.target.checked
                  ? ordinaryGames.map((game) => game.id)
                  : [])}
              />
              <span>Select all {ordinaryGames.length}</span>
            </label>

            {selected.size ? (
              <div className={styles.bulkActions}>
                <span className={styles.bulkCount}>{selected.size} selected</span>
                <button type="button" className={styles.bulkClear} onClick={() => setSelectedIds([])}>Clear</button>
                <button
                  type="button"
                  className={styles.bulkRestore}
                  disabled={bulkBusy}
                  onClick={() => void restoreSelected()}
                >
                  <VaultIcon name="restore-active" size={15} />
                  {bulkBusy
                    ? "Working…"
                    : statusTab === "slept"
                      ? `Wake ${selected.size} back up`
                      : `Move ${selected.size} back to active`}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={styles.gamesScroller} aria-label={`${filteredGames.length} games`}>
          {ordinaryGames.length ? <LibraryGameGrid games={ordinaryGames} viewMode={viewMode} onSelect={(id) => openGame(id, "catalogue")} onComplete={(id) => void markCompleted(id)} onRestore={(id) => void restoreCompleted(id)} onSleep={(id) => void updateGame(id, { status: "Slept" })} onTogglePin={(game) => void togglePin(game)} pinnedIds={vaultState.pinnedIds} selectable={selectionMode} selectedIds={selected} onToggleSelect={toggleSelected} /> : (
            <div className={styles.placeholderGrid}>
              <PlaceholderSlots
                count={4}
                label={statusTab === "slept"
                  ? "Games you put to sleep rest here, out of Vault draws."
                  : statusTab === "completed"
                    ? "Games you mark as finished collect here."
                    : "No games match this search."}
                action={statusTab !== "active"
                  ? <button type="button" className={styles.placeholderAction} onClick={() => setStatusTab("active")}>Browse active games</button>
                  : undefined}
              />
            </div>
          )}
        </div>
      </section>

      <LibraryDetailsDrawer
        game={selectedGame}
        previewMode={!isLive}
        variant={selectedSurface === "pinned" ? "pinned" : "library"}
        pin={(vaultState.pins ?? []).find((entry) => entry.gameId === selectedGame?.id)}
        collections={collections}
        saving={savingGameId === selectedGame?.id}
        onSave={async (patch) => {
          if (!selectedGame) return;
          setSavingGameId(selectedGame.id);
          try {
            await updateGame(selectedGame.id, patch);
          } finally {
            setSavingGameId(null);
          }
        }}
        onToggleCollection={async (collectionId, assigned) => {
          if (!selectedGame) return;
          await setGameCollection(selectedGame.id, collectionId, assigned);
        }}
        onClose={closeGameDetails}
        pinSlot={selectedGame ? vaultState.pinnedIds.indexOf(selectedGame.id) + 1 || null : null}
        pinCount={vaultState.pinnedIds.length}
        onTogglePin={() => void toggleSelectedPin()}
        onManagePins={() => { if (selectedGame) setPinCandidate(selectedGame); }}
        onComplete={() => selectedGame ? markCompleted(selectedGame.id) : Promise.resolve()}
        onRestore={() => selectedGame ? restoreCompleted(selectedGame.id) : Promise.resolve()}
        onSleep={() => selectedGame ? updateGame(selectedGame.id, { status: "Slept", sleptAt: new Date().toISOString(), completedAt: null }) : Promise.resolve()}
      />
      {undoGameId ? <div key={undoGameId} className={styles.undoToast} role="status">{libraryGames.find((game) => game.id === undoGameId)?.title ?? "Game"} marked as completed.<button type="button" onClick={() => void restoreCompleted(undoGameId)}>Undo</button></div> : null}
      {pinCandidate && !vaultState.pinnedIds.includes(pinCandidate.id) ? <ManagePinsDialog pinnedGames={pinnedGames} candidate={pinCandidate} onRemove={async (id) => { await recordVaultAction("unpinned", id); }} onReplace={async (replaceId) => { if (pinCandidate) await recordVaultAction("pinned", pinCandidate.id, { replace_game_id: replaceId }); }} onClose={() => setPinCandidate(null)} /> : null}
    </section>
  );
}

/**
 * Sorted from the recency model rather than by re-parsing a display string.
 * Games we know nothing about sort last, which is neither a claim that they are
 * ancient nor that they are fresh - just that we cannot place them.
 */
function sortableLastPlayed(game: DemoGame) {
  return -recencySortKey(game.recency);
}

function sortableAddedDate(game: DemoGame) {
  const timestamp = Date.parse(game.dateAdded || game.addedLabel.replace(/^Added\s+/i, ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortableDuration(game: DemoGame) {
  return estimatedTimeToBeatMinutes(game.duration) ?? Number.MAX_SAFE_INTEGER;
}
