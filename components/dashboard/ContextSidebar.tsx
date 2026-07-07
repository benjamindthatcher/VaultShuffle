"use client";

import { displayStatus } from "@/lib/game-classification";
import { topLevelGenresFor } from "@/lib/genres";
import type { Collection, Game, GamePayload, StatsPayload } from "@/lib/types";
import { GameDetails } from "@/components/dashboard/GameDetails";
import type { AppPage } from "@/components/dashboard/AppTopNav";

export type SidebarTab = "overview" | "details";
export type StatAction = "all" | "completed" | "progress" | "sampled" | "not_started" | "owned" | "wishlist";

export function ContextSidebar({
  activePage = "library",
  activeTab,
  collections = [],
  games,
  onOpenNotes,
  onPlay,
  onStatFilter,
  onTabChange,
  onUpdateGame,
  selected,
  selectedCollectionId,
  stats
}: {
  activePage?: AppPage;
  activeTab: SidebarTab;
  collections?: Collection[];
  games: Game[];
  onOpenNotes: () => void;
  onPlay: () => void;
  onStatFilter: (action: StatAction) => void;
  onTabChange: (tab: SidebarTab) => void;
  onUpdateGame: (payload: Partial<GamePayload>) => Promise<void>;
  selected: Game | null;
  selectedCollectionId?: string | null;
  stats: StatsPayload;
}) {
  if (activePage === "collections") {
    return (
      <CollectionsSidebar
        collections={collections}
        games={games}
        selectedCollectionId={selectedCollectionId}
      />
    );
  }

  return (
    <aside className="context-sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar view">
        <SidebarTabButton
          active={activeTab === "overview"}
          icon="⬡"
          label="Overview"
          onClick={() => onTabChange("overview")}
        />

        <SidebarTabButton
          active={activeTab === "details"}
          icon="▣"
          label="Game Details"
          onClick={() => onTabChange("details")}
        />
      </div>

      {activeTab === "overview" && activePage === "library" ? (
        <LibraryOverviewPanel
          games={games}
          onStatFilter={onStatFilter}
          stats={stats}
        />
      ) : null}

      {activeTab === "overview" && activePage === "wishlist" ? (
        <WishlistOverviewPanel games={games} />
      ) : null}

      {activeTab === "details" ? (
        <div className="context-panel game-details-context">
          <GameDetails game={selected} onOpenNotes={onOpenNotes} onPlay={onPlay} onUpdate={onUpdateGame} />
        </div>
      ) : null}
    </aside>
  );
}

function SidebarTabButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button aria-selected={active} className={`sidebar-tab ${active ? "active" : ""}`} onClick={onClick} role="tab" type="button">
      <span className="sidebar-tab-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function LibraryOverviewPanel({
  games,
  onStatFilter,
  stats
}: {
  games: Game[];
  onStatFilter: (action: StatAction) => void;
  stats: StatsPayload;
}) {
  return (
    <div className="context-panel overview-context">
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
            <span className="stat-icon">{icon}</span>
            <span>{label}</span>
            <strong>{value}</strong>
          </button>
        ))}
      </div>

    </div>
  );
}

function WishlistOverviewPanel({ games }: { games: Game[] }) {
  const wishlist = games.filter((game) => game.ownership === "Wishlist");
  const priorityCounts = {
    "Must Play": wishlist.filter((game) => game.priority === "Must Play").length,
    High: wishlist.filter((game) => game.priority === "High").length,
    Medium: wishlist.filter((game) => game.priority === "Medium").length,
    Low: wishlist.filter((game) => game.priority === "Low").length
  };
  const genres = new Set(wishlist.flatMap((game) => topLevelGenresFor(game.genre, game.title)));
  const notes = wishlist.filter((game) => String(game.notes || "").trim()).length;
  const totalHours = wishlist.reduce((sum, game) => sum + Number(game.hours_played || 0), 0);
  const averageLength = wishlist.length ? "Weekend" : "—";

  return (
    <div className="context-panel wishlist-context">
      <h2>Wishlist Overview</h2>

      <div className="overview-list">
        <div className="stat-row is-static"><span className="stat-icon">▦</span><span>Total Wishlisted</span><strong>{wishlist.length}</strong></div>
        <div className="stat-row is-static"><span className="stat-icon">♡</span><span>Unique Genres</span><strong>{genres.size || "—"}</strong></div>
        <div className="stat-row is-static"><span className="stat-icon">◷</span><span>Average Length</span><strong>{averageLength}</strong></div>
        <div className="stat-row is-static"><span className="stat-icon">◔</span><span>Total Experience</span><strong>{Math.round(totalHours).toLocaleString()}h+</strong></div>
      </div>

      <section className="sidebar-section-block">
        <h3>By Priority</h3>

        <div className="priority-breakdown">
          {(["Must Play", "High", "Medium", "Low"] as const).map((priority) => (
            <div className={`priority-breakdown-row priority-${priority.toLowerCase().replace(/\s+/g, "-")}`} key={priority}>
              <span />
              <p>{priority}</p>
              <strong>{priorityCounts[priority]}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="sidebar-section-block">
        <h3>View</h3>

        <div className="wishlist-view-list">
          <div className="wishlist-view-row active"><span>☆</span><p>All Wishlist</p><strong>{wishlist.length}</strong></div>
          <div className="wishlist-view-row"><span>◷</span><p>Recently Added</p><strong>{Math.min(6, wishlist.length)}</strong></div>
          <div className="wishlist-view-row"><span>☰</span><p>Notes</p><strong>{notes}</strong></div>
        </div>
      </section>

    </div>
  );
}

function CollectionsSidebar({
  collections,
  games,
  selectedCollectionId
}: {
  collections: Collection[];
  games: Game[];
  selectedCollectionId?: string | null;
}) {
  const totalGamesInCollections = collections.reduce((sum, collection) => sum + Number(collection.game_count || 0), 0);
  const selected = collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0] ?? null;
  const shortCount = Math.min(5, games.length);
  const longCount = Math.min(2, games.length);
  const coopCount = Math.min(4, games.length);

  function focusCreateForm() {
    document.querySelector<HTMLInputElement>(".create-collection-form input")?.focus();
  }

  return (
    <aside className="context-sidebar collections-context-sidebar">
      <div className="context-panel collections-sidebar-panel">
        <h2>Collections</h2>

        <div className="overview-list">
          <div className="stat-row is-static"><span className="stat-icon">♧</span><span>Total Collections</span><strong>{collections.length}</strong></div>
          <div className="stat-row is-static"><span className="stat-icon">✤</span><span>Total Games in Collections</span><strong>{totalGamesInCollections}</strong></div>
          <div className="stat-row is-static"><span className="stat-icon">⊗</span><span>Created by You</span><strong>{collections.length}</strong></div>
          <div className="stat-row is-static"><span className="stat-icon">♚</span><span>Selected</span><strong>{selected?.game_count ?? 0}</strong></div>
        </div>

        <section className="sidebar-section-block">
          <h3>Quick Collections</h3>

          <div className="wishlist-view-list">
            <div className="wishlist-view-row"><span>◷</span><p>Recently Updated</p><strong>{Math.min(4, collections.length)}</strong></div>
            <div className="wishlist-view-row"><span>◉</span><p>Most Played</p><strong>{Math.min(3, collections.length)}</strong></div>
            <div className="wishlist-view-row"><span>♙</span><p>Short & Sweet (≤10h)</p><strong>{shortCount}</strong></div>
            <div className="wishlist-view-row"><span>▣</span><p>Long Adventures (≥30h)</p><strong>{longCount}</strong></div>
            <div className="wishlist-view-row"><span>☊</span><p>Co-op Ready</p><strong>{coopCount}</strong></div>
          </div>
        </section>

        <button className="shuffle-button sidebar-shuffle-button new-collection-button" onClick={focusCreateForm} type="button">
          ＋ New Collection
        </button>

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
  const hours = Number(stats.hours || games.reduce((sum, game) => sum + Number(game.hours_played || 0), 0));

  return [
    { icon: "▦", label: "Total Games", value: games.length || stats.total, action: "all" },
    { icon: "✓", label: "Owned", value: owned, action: "owned" },
    { icon: "♡", label: "Wishlist", value: wishlist, action: "wishlist" },
    { icon: "□", label: "Not Started", value: `${notStarted} (${Math.round((notStarted / total) * 100)}%)`, action: "not_started" },
    { icon: "▷", label: "Sampled", value: `${sampled} (${Math.round((sampled / total) * 100)}%)`, action: "sampled" },
    { icon: "◉", label: "In Progress", value: `${inProgress} (${Math.round((inProgress / total) * 100)}%)`, action: "progress" },
    { icon: "◌", label: "Completed", value: `${completed} (${Math.round((completed / total) * 100)}%)`, action: "completed" },
    { icon: "◇", label: "Genres", value: genreCount || "—", action: null },
    { icon: "◷", label: "Hours Played", value: Math.round(hours).toLocaleString(), action: null },
    { icon: "◔", label: "Average Progress", value: `${Math.round(Number(stats.avg_completion || 0))}%`, action: null }
  ];
}
