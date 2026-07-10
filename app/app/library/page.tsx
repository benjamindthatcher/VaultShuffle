"use client";

import { useMemo, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { LibraryGameGrid } from "@/components/library/LibraryGameGrid";
import { LibraryToolbar } from "@/components/library/LibraryToolbar";
import { StatCard } from "@/components/shared/StatCard";
import { Artwork } from "@/components/shared/Artwork";
import styles from "./library.module.css";

export default function LibraryPage() {
  const { games, collections, updateGame, setGameCollection } = useAppData();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [status, setStatus] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [savingGameId, setSavingGameId] = useState<string | null>(null);

  const libraryGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);

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

  const filteredGames = useMemo(() => {
    const queryText = query.trim().toLowerCase();

    return [...libraryGames]
      .filter((game) => {
        const matchesQuery =
          !queryText ||
          game.title.toLowerCase().includes(queryText) ||
          game.genres.join(" ").toLowerCase().includes(queryText);

        const matchesStatus =
          status === "all" ||
          (status === "not-started" && game.status === "Not Started") ||
          (status === "in-progress" && game.status === "In Progress") ||
          (status === "completed" && game.status === "Completed");

        return matchesQuery && matchesStatus;
      })
      .sort((left, right) => {
        if (sort === "title") return left.title.localeCompare(right.title);
        if (sort === "hours") return right.hoursPlayed - left.hoursPlayed;
        if (sort === "progress") return right.completionPercent - left.completionPercent;
        return right.hoursPlayed - left.hoursPlayed;
      });
  }, [libraryGames, query, sort, status]);

  const selectedGame = filteredGames.find((game) => game.id === selectedGameId) ?? libraryGames.find((game) => game.id === selectedGameId) ?? null;

  return (
    <section className={styles.libraryPage}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Library</p>
          <h1 className={styles.title}>Library</h1>
          <p className={styles.description}>Your games. All in one place.</p>
        </div>
      </header>

      <div className={styles.statsGrid}>
        <StatCard label="All Games" value={stats.total} note="Everything currently in your library." />
        <StatCard label="Played" value={stats.played} note="Games with real playtime already logged." />
        <StatCard label="Backlog" value={stats.backlog} note="Untouched games waiting for their moment." />
        <StatCard label="Completed" value={stats.completed} note="Wrapped up and archived with pride." />
        <StatCard label="In Progress" value={stats.inProgress} note="Mid-journey picks ready to continue." />
      </div>

      <LibraryToolbar
        query={query}
        onQueryChange={setQuery}
        sort={sort}
        onSortChange={setSort}
        status={status}
        onStatusChange={setStatus}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

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

      <section className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>All Games</h2>
          </div>
        </div>
        <LibraryGameGrid games={filteredGames} viewMode={viewMode} onSelect={setSelectedGameId} />
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
      />
    </section>
  );
}
