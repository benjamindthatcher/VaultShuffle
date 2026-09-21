"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { CompletionCelebration } from "@/components/library/CompletionCelebration";
import { PinnedCommitments } from "@/components/shared/PinnedCommitments";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { trackLibraryInteraction } from "@/lib/library-analytics";
import { trackCompletionClaim, trackCompletionUndone } from "@/lib/completion-tracking";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { LibraryGameGrid } from "@/components/library/LibraryGameGrid";
import { ActionIcon } from "@/components/library/LibraryGameActions";
import { LibraryToolbar } from "@/components/library/LibraryToolbar";
import { EMPTY_LIBRARY_FILTERS, availableGenres, matchesLibraryFilters, type LibraryFilters } from "@/lib/library-filters";
import { PlaceholderSlots } from "@/components/shared/PlaceholderSlots";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { recencySortKey } from "@/lib/recency";
import type { DemoGame } from "@/lib/demo-data";
import { estimatedTimeToBeatMinutes } from "@/lib/game-duration";
import styles from "./library.module.css";

type UndoAction = {
  game: DemoGame;
  action: "blacklist" | "complete" | "reactivate" | "playing_next_add" | "playing_next_remove" | "playing_next_replace";
  message: string;
  wasPinned: boolean;
  replacedGame?: DemoGame;
  batchGames?: DemoGame[];
};

const STATUS_SORT_RANK: Record<DemoGame["status"], number> = {
  Completed: 4,
  "In Progress": 3,
  "Not Started": 2,
  Slept: 1
};

export default function LibraryPage() {
  const { games, allGames, collections, vaultState, isLive, updateGame, restoreGame, recordVaultAction } = useAppData();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [sort, setSort] = useState("hours");
  const [sortReversed, setSortReversed] = useState(false);
  const [statusTab, setStatusTab] = useState<"active" | "blacklisted" | "completed">("active");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<"catalogue" | "pinned" | null>(null);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const undoRef = useRef<UndoAction | null>(null);
  const [celebratingId, setCelebratingId] = useState<string | null>(null);
  const [pinCandidate, setPinCandidate] = useState<DemoGame | null>(null);
  // Selection is explicitly enabled; normal card clicks open game details.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const pinScrollRef = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!pinScrollRef.current) return;
    window.scrollTo({ left: pinScrollRef.current.x, top: pinScrollRef.current.y, behavior: "instant" });
    pinScrollRef.current = null;
  }, [vaultState.pinnedIds]);

  const undoTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab === "slept" || requestedTab === "blacklisted") setStatusTab("blacklisted");
    else if (requestedTab === "completed" || requestedTab === "active") setStatusTab(requestedTab);

    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  const libraryGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);
  const hasDurationSort = useMemo(
    () => libraryGames.some((game) => estimatedTimeToBeatMinutes(game.duration) !== null),
    [libraryGames]
  );

  function clearUndo() {
    undoRef.current = null;
    setUndoAction(null);
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
  }

  function offerUndo(game: DemoGame, action: UndoAction["action"], message: string, replacedGame?: DemoGame, batchGames?: DemoGame[]) {
    clearUndo();
    setCelebratingId(null);
    const next = { game, action, message, replacedGame, batchGames, wasPinned: vaultState.pinnedIds.includes(game.id) };
    undoRef.current = next;
    setUndoAction(next);
    undoTimerRef.current = window.setTimeout(() => {
      // Leave feedback readable while its Undo control has keyboard focus.
      if (!document.activeElement?.closest('[data-library-undo]')) clearUndo();
    }, 9000);
    return next;
  }

  function actionContext(action: string, surface = selectedGameId ? "details" : "catalogue") {
    return { source: "library", surface, view_mode: viewMode, action };
  }

  async function changeStatus(gameId: string, action: "blacklist" | "complete" | "reactivate") {
    const game = allGames.find((entry) => entry.id === gameId);
    if (!game) return;
    const context = actionContext(action);
    closeGameDetails();
    const undo = offerUndo(game, action, action === "blacklist" ? `${game.title} blacklisted` : action === "complete" ? `${game.title} marked complete` : `${game.title} reactivated`);
    if (action === "complete") setCelebratingId(gameId);
    try {
      if (action === "reactivate") await restoreGame(gameId, { context });
      else await updateGame(gameId, { status: action === "blacklist" ? "Slept" : "Completed" }, context);
      if (action === "complete") trackCompletionClaim(game, "library", isLive);
      if (action === "reactivate" && game.status === "Completed") trackCompletionUndone(game, "library", isLive);
    } catch {
      if (undoRef.current === undo) { clearUndo(); setCelebratingId(null); }
      // The provider displays the failure and reconciles the queued writes.
    }
  }

  async function undoLastAction() {
    const undo = undoRef.current;
    if (!undo) return;
    clearUndo();
    setCelebratingId(null);
    const { game, action, replacedGame } = undo;
    const context = { ...actionContext("undo"), ...(undo.batchGames ? { bulk: true, batch_size: undo.batchGames.length } : {}) };
    trackLibraryInteraction("undo", { ...context, game_id: game.id, original_action: action });
    try {
      if (undo.batchGames) {
        await Promise.allSettled(undo.batchGames.map(async (previous) => {
          await updateGame(previous.id, {
            status: previous.status, completionPercent: previous.completionPercent,
            completedAt: previous.completedAt ?? null, sleptAt: previous.sleptAt ?? null,
          }, context);
          if (action === "complete") trackCompletionUndone(previous, "library", isLive);
        }));
      } else if (action === "playing_next_add") await recordVaultAction("unpinned", game.id, context);
      else if (action === "playing_next_replace" && replacedGame) {
        await recordVaultAction("pinned", replacedGame.id, { ...context, replace_game_id: game.id });
      } else if (action === "playing_next_remove") {
        await recordVaultAction("pinned", game.id, context);
      } else {
        // Restore the actual prior decision, including inferred progress; don't
        // turn a previously Blacklisted game into Active when undoing Complete.
        const statusWrite = updateGame(game.id, {
          status: game.status, completionPercent: game.completionPercent,
          completedAt: game.completedAt ?? null, sleptAt: game.sleptAt ?? null,
        }, context);
        const pinWrite = undo.wasPinned && !vaultState.pinnedIds.includes(game.id) && vaultState.pinnedIds.length < 3
          ? recordVaultAction("pinned", game.id, context) : Promise.resolve();
        await Promise.all([statusWrite, pinWrite]);
        if (action === "complete") trackCompletionUndone(game, "library", isLive);
      }
    } catch { /* Provider owns recovery and the error announcement. */ }
  }

  const statusCounts = useMemo(() => ({
    active: libraryGames.filter((game) => game.status !== "Slept" && game.status !== "Completed" && !vaultState.pinnedIds.includes(game.id)).length,
    blacklisted: libraryGames.filter((game) => game.status === "Slept").length,
    completed: libraryGames.filter((game) => game.status === "Completed").length
  }), [libraryGames, vaultState.pinnedIds]);

  const filteredGames = useMemo(() => {
    const queryText = query.trim().toLowerCase();

    return [...libraryGames]
      .filter((game) => {
        const matchesQuery =
          !queryText ||
          game.title.toLowerCase().includes(queryText) ||
          game.genres.join(" ").toLowerCase().includes(queryText);

        const matchesStatus = statusTab === "active"
          ? game.status !== "Slept" && game.status !== "Completed" && !vaultState.pinnedIds.includes(game.id)
          : statusTab === "blacklisted" ? game.status === "Slept" : game.status === "Completed";

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
        else if (statusTab === "blacklisted") comparison = Date.parse(right.sleptAt || "") - Date.parse(left.sleptAt || "");
        else if (statusTab === "completed") comparison = Date.parse(right.completedAt || "") - Date.parse(left.completedAt || "");
        else comparison = sortableLastPlayed(right) - sortableLastPlayed(left);

        if (!Number.isFinite(comparison) || comparison === 0) comparison = left.title.localeCompare(right.title);

        return sortReversed ? -comparison : comparison;
      });
  }, [filters, libraryGames, query, sort, sortReversed, statusTab, vaultState.pinnedIds]);

  // Offered from the whole library rather than the current tab, so the list of
  // genres does not shuffle every time the tab changes.
  const filterGenres = useMemo(() => availableGenres(libraryGames), [libraryGames]);

  const selectedGame = filteredGames.find((game) => game.id === selectedGameId)
    ?? libraryGames.find((game) => game.id === selectedGameId)
    ?? allGames.find((game) => game.id === selectedGameId)
    ?? null;
  const celebratingGame = celebratingId && undoAction?.action === "complete" && undoAction.game.id === celebratingId ? games.find((game) => game.id === celebratingId) ?? null : null;
  // Pins outrank the global filters. A pinned game the filters have ruled out is
  // still pinned, and has to stay reachable here - otherwise the manage dialog
  // offers two of three pins and the third can be neither replaced nor removed.
  const pinnedGames = vaultState.pinnedIds
    .map((id) => libraryGames.find((game) => game.id === id) ?? allGames.find((game) => game.id === id))
    .filter((game): game is DemoGame => Boolean(game))
    .filter((game) => game.status !== "Slept" && game.status !== "Completed");
  const ordinaryGames = filteredGames;

  // Every shelf offers explicit selection alongside details.
  const [selectionMode, setSelectionMode] = useState(false);
  // Scoped to what is on screen, so "select all" and the count can never claim
  // more than the current search and filters are actually showing.
  const selected = new Set(selectedIds.filter((id) => ordinaryGames.some((game) => game.id === id)));
  const allShownSelected = ordinaryGames.length > 0 && ordinaryGames.every((game) => selected.has(game.id));

  function toggleSelected(gameId: string) {
    setSelectedIds((current) => current.includes(gameId)
      ? current.filter((id) => id !== gameId)
      : [...current, gameId]);
  }

  async function changeSelectedStatus(action: "blacklist" | "complete") {
    const targets = ordinaryGames.filter((game) => selected.has(game.id));
    if (!targets.length) return;
    const context = { ...actionContext(`bulk_${action}`, "selection"), bulk: true, batch_size: targets.length };
    const message = (count: number) => `${count} ${count === 1 ? "game" : "games"} ${action === "blacklist" ? "blacklisted" : "marked complete"}`;
    const undo = offerUndo(targets[0], action, message(targets.length), undefined, targets);
    setSelectedIds((current) => current.filter((id) => !selected.has(id)));
    // Start every optimistic update together; the provider queues the writes.
    const results = await Promise.allSettled(targets.map(async (game) => {
      await updateGame(game.id, { status: action === "blacklist" ? "Slept" : "Completed" }, context);
      if (action === "complete") trackCompletionClaim(game, "library", isLive);
    }));
    if (undoRef.current !== undo) return;
    const saved = targets.filter((_, index) => results[index].status === "fulfilled");
    if (!saved.length) clearUndo();
    else if (saved.length !== targets.length) {
      // Keep Undo for successful writes when only part of the batch saved.
      const partial = { ...undo, batchGames: saved, message: message(saved.length) };
      undoRef.current = partial;
      setUndoAction(partial);
    }
  }

  // Apply the whole selection locally; the provider serializes persistence.
  async function restoreSelected() {
    const ids = ordinaryGames.filter((game) => selected.has(game.id)).map((game) => game.id);
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      clearUndo();
      await Promise.all(ids.map((id) => restoreGame(id, { silent: true, context: actionContext("bulk_reactivate") })));
      trackEvent(ANALYTICS_EVENTS.gameStatusChanged, {
        status: "Active",
        restored: true,
        bulk: true,
        from: statusTab,
        count: ids.length
      });
      setSelectedIds([]);
    } catch {
      // The shared queue reconciles failed writes and reports the error.
    } finally {
      setBulkBusy(false);
    }
  }

  async function togglePin(game: DemoGame, replaceId?: string) {
    const removing = vaultState.pinnedIds.includes(game.id);
    const context = actionContext(removing ? "remove" : "add");
    closeGameDetails();
    if (!removing && !replaceId && vaultState.pinnedIds.length >= 3) {
      setPinCandidate(game);
      trackLibraryInteraction("replacement_opened", { ...actionContext("playing_next"), game_id: game.id });
      return;
    }
    const replacedGame = replaceId ? allGames.find((entry) => entry.id === replaceId) : undefined;
    pinScrollRef.current = { x: window.scrollX, y: window.scrollY };
    const undo = offerUndo(game, removing ? "playing_next_remove" : replaceId ? "playing_next_replace" : "playing_next_add", `${game.title} ${removing ? "removed from" : "added to"} Playing Next`, replacedGame);
    setPinCandidate(null);
    try {
      await recordVaultAction(removing ? "unpinned" : "pinned", game.id, {
        ...context, ...(replaceId ? { replace_game_id: replaceId } : {}),
      });
    } catch { if (undoRef.current === undo) clearUndo(); }
  }

  async function toggleSelectedPin() {
    if (selectedGame) await togglePin(selectedGame);
  }

  function openGame(gameId: string, surface: "catalogue" | "pinned") {
    trackLibraryInteraction("details_opened", { source: "library", surface, view_mode: viewMode, game_id: gameId, shelf: statusTab });
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
          Browse and filter the live guest catalogue. Any statuses, Playing Next choices you try are temporary until you connect a public Steam library.
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
          onUndo={() => void undoLastAction()}
        />
      ) : null}

      <div className={styles.statusTabs} role="tablist" aria-label={isLive ? "Library status" : "Preview status"}>
        {(["active", "blacklisted", "completed"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={statusTab === tab} className={statusTab === tab ? styles.statusTabActive : styles.statusTab} onClick={() => { setSelectedIds([]); setStatusTab(tab); }}>
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
            selectionMode={selectionMode}
            onToggleSelection={() => {
              setSelectionMode((current) => !current);
              setSelectedIds([]);
              trackLibraryInteraction("selection_toggled", { source: "library", enabled: !selectionMode, view_mode: viewMode });
            }}
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
                {statusTab === "active" ? <>
                  <button type="button" className={styles.bulkBlacklist} onClick={() => void changeSelectedStatus("blacklist")}>
                    <ActionIcon kind="blacklist" />Blacklist {selected.size}
                  </button>
                  <button type="button" className={styles.bulkComplete} onClick={() => void changeSelectedStatus("complete")}>
                    <ActionIcon kind="complete" />Complete {selected.size}
                  </button>
                </> : null}
                {statusTab !== "active" ? <button
                  type="button"
                  className={styles.bulkRestore}
                  disabled={bulkBusy}
                  onClick={() => void restoreSelected()}
                >
                  <VaultIcon name="restore-active" size={15} />
                  {bulkBusy
                    ? "Working…"
                    : statusTab === "blacklisted"
                      ? `Reactivate ${selected.size}`
                      : `Move ${selected.size} back to active`}
                </button> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={styles.gamesScroller} aria-label={`${filteredGames.length} games`}>
          {ordinaryGames.length ? <LibraryGameGrid games={ordinaryGames} viewMode={viewMode} onSelect={(id) => openGame(id, "catalogue")} resetKey={JSON.stringify([query, filters, sort, sortReversed, statusTab, viewMode])} onComplete={(id) => void changeStatus(id, "complete")} onRestore={(id) => void changeStatus(id, "reactivate")} onBlacklist={(id) => void changeStatus(id, "blacklist")} onTogglePin={(game) => void togglePin(game)} pinnedIds={vaultState.pinnedIds} selectable={selectionMode} selectedIds={selected} onToggleSelect={toggleSelected} /> : (
            <div className={styles.placeholderGrid}>
              <PlaceholderSlots
                count={4}
                label={statusTab === "blacklisted"
                  ? "Blacklisted games stay out of Vault draws until you reactivate them."
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
        onClose={closeGameDetails}
        pinSlot={selectedGame ? vaultState.pinnedIds.indexOf(selectedGame.id) + 1 || null : null}
        pinCount={vaultState.pinnedIds.length}
        onTogglePin={() => void toggleSelectedPin()}
        onManagePins={() => { if (selectedGame) void togglePin(selectedGame); }}
        onComplete={() => selectedGame ? changeStatus(selectedGame.id, "complete") : Promise.resolve()}
        onRestore={() => selectedGame ? changeStatus(selectedGame.id, "reactivate") : Promise.resolve()}
        onSleep={() => selectedGame ? changeStatus(selectedGame.id, "blacklist") : Promise.resolve()}
      />
      {undoAction && !celebratingGame ? <div key={`${undoAction.game.id}-${undoAction.action}`} className={styles.undoToast} role="status" data-library-undo>{undoAction.message}<button type="button" onClick={() => void undoLastAction()}>Undo</button><button type="button" aria-label="Dismiss action feedback" onClick={clearUndo}>×</button></div> : null}
      {pinCandidate && !vaultState.pinnedIds.includes(pinCandidate.id) ? <ManagePinsDialog pinnedGames={pinnedGames} candidate={pinCandidate} onRemove={async (id) => { const game = allGames.find((entry) => entry.id === id); if (game) await togglePin(game); }} onReplace={async (replaceId) => { if (pinCandidate) await togglePin(pinCandidate, replaceId); }} onClose={() => setPinCandidate(null)} /> : null}
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
