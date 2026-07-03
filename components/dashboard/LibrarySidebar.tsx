"use client";

import { displayStatus } from "@/lib/game-classification";
import { topLevelGenresFor } from "@/lib/genres";
import type { Game, StatsPayload } from "@/lib/types";

export type StatAction = "all" | "completed" | "progress" | "sampled" | "not_started" | "owned" | "wishlist";

export function LibrarySidebar({
  activeRulesLabel,
  games,
  onOpenVault,
  onShuffleCountChange,
  onStatFilter,
  shuffleCount,
  shuffleEligibleCount,
  stats
}: {
  activeRulesLabel: string;
  games: Game[];
  onOpenVault: () => void;
  onShuffleCountChange: (count: 1 | 2 | 3) => void;
  onStatFilter: (action: StatAction) => void;
  shuffleCount: 1 | 2 | 3;
  shuffleEligibleCount: number;
  stats: StatsPayload;
}) {
  return (
    <aside className="library-panel">
      <h2>Library Overview</h2>
      <div className="overview-list">
        {statRows(stats, games).map(({ icon, label, value, action }) => (
          <button
            className={`stat-row ${action ? "" : "is-static"}`}
            disabled={!action}
            key={label}
            onClick={() => action && onStatFilter(action)}
            type="button"
          >
            <span>{icon}</span>
            <span>{label}</span>
            <strong>{value}</strong>
          </button>
        ))}
      </div>
      <section className="sidebar-shuffle">
        <div>
          <h2>Vault Shuffle</h2>
          <p>Open the vault and draw from the games currently visible in your list.</p>
        </div>
        <div className="sidebar-shuffle-meta">
          <strong>{shuffleEligibleCount}</strong>
          <span>eligible games</span>
        </div>
        <div className="sidebar-shuffle-count" aria-label="Number of games to shuffle">
          {[1, 2, 3].map((count) => (
            <button
              className={shuffleCount === count ? "active" : ""}
              key={count}
              onClick={() => onShuffleCountChange(count as 1 | 2 | 3)}
              type="button"
            >
              {count}
            </button>
          ))}
        </div>
        <button className="shuffle-button sidebar-shuffle-button" onClick={onOpenVault} type="button">
          Open Vault
        </button>
      </section>
      <p className="shuffle-info"><span aria-hidden="true">i</span>Completed games are skipped automatically.</p>
      <div className="side-summary">
        <h2>Current filter</h2>
        <p>{activeRulesLabel}</p>
      </div>
    </aside>
  );
}

function statRows(stats: StatsPayload, games: Game[]): Array<{ icon: string; label: string; value: string | number; action: StatAction | null }> {
  const total = games.length || stats.total || 1;
  const completed = games.filter((game) => displayStatus(game) === "Completed").length;
  const sampled = games.filter((game) => displayStatus(game) === "Sampled").length;
  const inProgress = games.filter((game) => displayStatus(game) === "In Progress").length;
  const notStarted = games.filter((game) => displayStatus(game) === "Not Started").length;
  const owned = games.filter((game) => game.ownership === "Owned").length;
  const wishlist = games.filter((game) => game.ownership === "Wishlist").length;
  const genreCount = new Set(games.flatMap((game) => topLevelGenresFor(game.genre, game.title))).size;
  return [
    { icon: "▦", label: "Total Games", value: stats.total, action: "all" },
    { icon: "●", label: "Owned", value: owned, action: "owned" },
    { icon: "♡", label: "Wishlist", value: wishlist, action: "wishlist" },
    {
      icon: "□",
      label: "Not Started",
      value: `${notStarted} (${Math.round((notStarted / total) * 100)}%)`,
      action: "not_started"
    },
    { icon: "◐", label: "Sampled", value: `${sampled} (${Math.round((sampled / total) * 100)}%)`, action: "sampled" },
    { icon: "▶", label: "In Progress", value: `${inProgress} (${Math.round((inProgress / total) * 100)}%)`, action: "progress" },
    { icon: "✓", label: "Completed", value: `${completed} (${Math.round((completed / total) * 100)}%)`, action: "completed" },
    { icon: "◇", label: "Genres", value: genreCount || "—", action: null },
    { icon: "◴", label: "Hours Played", value: Number(stats.hours).toLocaleString(), action: null },
    { icon: "◎", label: "Average Progress", value: `${stats.avg_completion}%`, action: null }
  ];
}
