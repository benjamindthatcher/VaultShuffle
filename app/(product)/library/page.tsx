"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { LibraryGameGrid } from "@/components/library/LibraryGameGrid";
import { LibraryToolbar } from "@/components/library/LibraryToolbar";
import { StatCard } from "@/components/shared/StatCard";
import { Artwork } from "@/components/shared/Artwork";
import { GameCard } from "@/components/shared/GameCard";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { ScrollControls } from "@/components/shared/ScrollControls";
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
  const { games, collections, vaultState, updateGame, restoreGame, setGameCollection, recordVaultAction } = useAppData();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [sortReversed, setSortReversed] = useState(false);
  const [statusTab, setStatusTab] = useState<"active" | "slept" | "completed">("active");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [savingGameId, setSavingGameId] = useState<string | null>(null);
  const [undoGameId, setUndoGameId] = useState<string | null>(null);
  const [managePinsOpen, setManagePinsOpen] = useState(false);
  const [pinCandidate, setPinCandidate] = useState<DemoGame | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const gamesScrollerRef = useRef<HTMLDivElement>(null);
  const pinnedGridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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

  const stats = useMemo(
    () => ({
      total: libraryGames.length,
      played: libraryGames.filter((game) => game.hoursPlayed > 0).length,
      backlog: libraryGames.filter((game) => game.status === "Not Started").length,
      completed: libraryGames.filter((game) => game.status === "Completed").length,
      inProgress: libraryGames.filter((game) => game.status === "In Progress").length
    }),
    [libraryGames]
  );

  const recentActivity = useMemo(
    () => libraryGames.filter((game) => game.hoursPlayed > 0).slice(0, 5),
    [libraryGames]
  );

  async function markCompleted(gameId: string) {
    await updateGame(gameId, { status: "Completed" });
    setUndoGameId(gameId);
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => setUndoGameId(null), 5300);
  }

  async function restoreCompleted(gameId: string) {
    await restoreGame(gameId);
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

        return matchesQuery && matchesStatus;
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
  }, [libraryGames, query, sort, sortReversed, statusTab]);

  const selectedGame = filteredGames.find((game) => game.id === selectedGameId) ?? libraryGames.find((game) => game.id === selectedGameId) ?? null;
  const pinnedGames = vaultState.pinnedIds
    .map((id) => libraryGames.find((game) => game.id === id))
    .filter((game): game is DemoGame => Boolean(game))
    .filter((game) => game.status !== "Slept" && game.status !== "Completed");
  const visiblePinnedGames = statusTab === "active" ? pinnedGames.filter((game) => filteredGames.some((item) => item.id === game.id)) : [];
  const ordinaryGames = filteredGames.filter((game) => !visiblePinnedGames.some((pinned) => pinned.id === game.id));

  async function togglePin(game: DemoGame) {
    if (vaultState.pinnedIds.includes(game.id)) await recordVaultAction("unpinned", game.id);
    else if (vaultState.pinnedIds.length < 3) await recordVaultAction("pinned", game.id);
    else { setPinCandidate(game); setManagePinsOpen(true); }
  }

  async function toggleSelectedPin() {
    if (!selectedGame) return;
    await togglePin(selectedGame);
  }

  return (
    <section className={styles.libraryPage}>
      <header className={styles.header}>
        <h1 className="visually-hidden">Library</h1>
      </header>

      <div className={styles.statsGrid}>
        <StatCard density="compact" icon="all-games" label="All Games" value={stats.total} note="Everything currently in your library." />
        <StatCard density="compact" icon="played" label="Played" value={stats.played} note="Games with real playtime already logged." />
        <StatCard density="compact" icon="backlog" label="Backlog" value={stats.backlog} note="Untouched games waiting for their moment." />
        <StatCard density="compact" icon="completed" label="Completed" value={stats.completed} note="Wrapped up and archived with pride." />
        <StatCard density="compact" icon="in-progress" label="In Progress" value={stats.inProgress} note="Mid-journey picks ready to continue." />
      </div>

      <section className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Recent Activity</h2>
          </div>
        </div>
        <div className={styles.recentRow}>
          {recentActivity.map((game) => (
            <button key={game.id} type="button" className={styles.recentCard} onClick={() => setSelectedGameId(game.id)}>
              <span className={styles.recentArtwork}>
                <Artwork src={game.bannerUrl} sizes="(max-width: 720px) 80vw, 260px" />
              </span>
              <div className={styles.recentBody}>
                <strong>{game.title}</strong>
                <span>{game.lastPlayedLabel}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <div className={styles.statusTabs} role="tablist" aria-label="Library status">
        {(["active", "slept", "completed"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={statusTab === tab} className={statusTab === tab ? styles.statusTabActive : styles.statusTab} onClick={() => setStatusTab(tab)}>
            <span>{tab[0].toUpperCase() + tab.slice(1)}</span><strong>{statusCounts[tab]}</strong>
          </button>
        ))}
      </div>

      <section className={`${styles.sectionCard} ${styles.gamesSection}`} role="tabpanel" aria-label={`${statusTab} games`}>
        <div className={`${styles.sectionHeader} ${styles.gamesHeader}`}>
          <div>
            <h2 className={styles.sectionTitle}>{statusTab === "active" ? "Active" : statusTab === "slept" ? "Slept" : "Completed"} Games <span className={styles.sectionCount}>({filteredGames.length})</span></h2>
          </div>
        </div>
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
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        </div>
        {statusTab === "active" && (visiblePinnedGames.length || !query) ? <div className={styles.pinnedShelf}>
          <div className={styles.pinnedHeader}><h2>Pinned Games <span>{pinnedGames.length}/3</span></h2><div className={styles.slotDots} aria-label={`${pinnedGames.length} of 3 pins used`}>{[0,1,2].map((slot) => <span key={slot} data-filled={slot < pinnedGames.length} />)}</div><ScrollControls targetRef={pinnedGridRef} axis="horizontal" label="Browse pinned games" /><button type="button" onClick={() => setManagePinsOpen(true)}>Manage Pins</button></div>
          <div ref={pinnedGridRef} className={styles.pinnedGrid}>{visiblePinnedGames.map((game, index) => <div key={game.id} className={styles.pinnedCard}><GameCard game={game} onClick={() => setSelectedGameId(game.id)} onComplete={() => void markCompleted(game.id)} onSleep={() => void updateGame(game.id, { status: "Slept" })} onTogglePin={() => void togglePin(game)} pinned showProgress /><span className={styles.pinBadge}>⌖ {index + 1}</span></div>)}{!query ? Array.from({ length: Math.max(0, 3 - pinnedGames.length) }, (_, index) => <div key={`empty-${index}`} className={styles.emptyPin}>Empty slot</div>) : null}</div>
        </div> : null}
        <ScrollControls targetRef={gamesScrollerRef} axis="vertical" label="Browse games" className={styles.gamesScrollControls} />
        <div ref={gamesScrollerRef} className={styles.gamesScroller} tabIndex={0} aria-label={`${filteredGames.length} games`}>
          {ordinaryGames.length ? <LibraryGameGrid games={ordinaryGames} viewMode={viewMode} onSelect={setSelectedGameId} onComplete={(id) => void markCompleted(id)} onRestore={(id) => void restoreCompleted(id)} onSleep={(id) => void updateGame(id, { status: "Slept" })} onTogglePin={(game) => void togglePin(game)} pinnedIds={vaultState.pinnedIds} /> : (
            <div className={styles.emptyState}><h3>{statusTab === "slept" ? "No sleeping games" : statusTab === "completed" ? "Nothing completed yet" : "No active games match"}</h3><p>{statusTab === "slept" ? "Games you put to sleep will appear here and stay out of Vault draws." : statusTab === "completed" ? "Mark a finished game as completed and it will appear here." : "Try changing your search."}</p>{statusTab !== "active" ? <button type="button" onClick={() => setStatusTab("active")}>Browse Active Games</button> : null}</div>
          )}
        </div>
      </section>

      <LibraryDetailsDrawer
        game={selectedGame}
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
        onClose={() => setSelectedGameId(null)}
        pinSlot={selectedGame ? vaultState.pinnedIds.indexOf(selectedGame.id) + 1 || null : null}
        pinCount={vaultState.pinnedIds.length}
        onTogglePin={() => void toggleSelectedPin()}
        onManagePins={() => { if (selectedGame) setPinCandidate(selectedGame); setManagePinsOpen(true); }}
        onComplete={() => selectedGame ? markCompleted(selectedGame.id) : Promise.resolve()}
        onRestore={() => selectedGame ? restoreCompleted(selectedGame.id) : Promise.resolve()}
      />
      {undoGameId ? <div key={undoGameId} className={styles.undoToast} role="status">{libraryGames.find((game) => game.id === undoGameId)?.title ?? "Game"} marked as completed.<button type="button" onClick={() => void restoreCompleted(undoGameId)}>Undo</button></div> : null}
      {managePinsOpen ? <ManagePinsDialog pinnedGames={pinnedGames} candidate={pinCandidate && !vaultState.pinnedIds.includes(pinCandidate.id) ? pinCandidate : null} onRemove={async (id) => { await recordVaultAction("unpinned", id); }} onReplace={async (replaceId) => { if (pinCandidate) await recordVaultAction("pinned", pinCandidate.id, { replace_game_id: replaceId }); }} onClose={() => { setManagePinsOpen(false); setPinCandidate(null); }} /> : null}
    </section>
  );
}

function sortableLastPlayed(game: DemoGame) {
  const timestamp = Date.parse(game.lastPlayedAt || "");
  if (Number.isFinite(timestamp)) return timestamp;

  const relative = game.lastPlayedLabel.match(/^(\d+)\s*([hdw])\s+ago$/i);
  if (!relative) return 0;
  const amount = Number(relative[1]);
  const unit = relative[2].toLowerCase();
  const hours = unit === "h" ? amount : unit === "d" ? amount * 24 : amount * 24 * 7;
  return Date.now() - hours * 60 * 60 * 1000;
}

function sortableAddedDate(game: DemoGame) {
  const timestamp = Date.parse(game.dateAdded || game.addedLabel.replace(/^Added\s+/i, ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortableDuration(game: DemoGame) {
  return estimatedTimeToBeatMinutes(game.duration) ?? Number.MAX_SAFE_INTEGER;
}
