"use client";

import { displayStatus } from "@/lib/game-classification";
import { topLevelGenresFor } from "@/lib/genres";
import type { Game, GamePayload, StatsPayload } from "@/lib/types";
import { GameDetails } from "@/components/dashboard/GameDetails";
import type { VaultMode } from "@/components/dashboard/VaultShuffleModal";

export type SidebarTab = "overview" | "details" | "vault";
export type StatAction = "all" | "completed" | "progress" | "sampled" | "not_started" | "owned" | "wishlist";

export function ContextSidebar({
  activeRulesLabel,
  activeTab,
  games,
  onOpenNotes,
  onOpenVault,
  onPlay,
  onStatFilter,
  onTabChange,
  onUpdateGame,
  selected,
  setVaultMode,
  shuffleEligibleCount,
  stats,
  vaultMode
}: {
  activeRulesLabel: string;
  activeTab: SidebarTab;
  games: Game[];
  onOpenNotes: () => void;
  onOpenVault: () => void;
  onPlay: () => void;
  onStatFilter: (action: StatAction) => void;
  onTabChange: (tab: SidebarTab) => void;
  onUpdateGame: (payload: Partial<GamePayload>) => Promise<void>;
  selected: Game | null;
  setVaultMode: (mode: VaultMode) => void;
  shuffleEligibleCount: number;
  stats: StatsPayload;
  vaultMode: VaultMode;
}) {
  return (
    <aside className="context-sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar view">
        <SidebarTabButton active={activeTab === "overview"} label="Overview" onClick={() => onTabChange("overview")} />
        <SidebarTabButton active={activeTab === "details"} label="Game Details" onClick={() => onTabChange("details")} />
        <SidebarTabButton active={activeTab === "vault"} label="Vault" onClick={() => onTabChange("vault")} />
      </div>

      {activeTab === "overview" ? (
        <div className="context-panel">
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
          <CompactVaultLauncher count={shuffleEligibleCount} mode={vaultMode} onModeChange={setVaultMode} onOpen={onOpenVault} />
          <div className="side-summary">
            <h2>Current filter</h2>
            <p>{activeRulesLabel}</p>
          </div>
        </div>
      ) : null}

      {activeTab === "details" ? (
        <div className="context-panel game-details-context">
          <GameDetails game={selected} onOpenNotes={onOpenNotes} onPlay={onPlay} onUpdate={onUpdateGame} />
        </div>
      ) : null}

      {activeTab === "vault" ? (
        <div className="context-panel">
          <h2>Vault</h2>
          <section className="sidebar-vault-feature">
            <img src="/assets/vault-door-compact.svg" alt="" />
            <h3>Crack open the vault.</h3>
            <p>One game. Yours to play. Pull from the games currently visible in the library.</p>
            <div className="vault-mode-stack">
              <button className={vaultMode === "draw" ? "active" : ""} onClick={() => setVaultMode("draw")} type="button">
                <strong>Vault Draw</strong>
                <span>One decisive pick</span>
              </button>
              <button className={vaultMode === "choose" ? "active" : ""} onClick={() => setVaultMode("choose")} type="button">
                <strong>Let Me Choose</strong>
                <span>Three options</span>
              </button>
            </div>
            <div className="sidebar-shuffle-meta">
              <strong>{shuffleEligibleCount}</strong>
              <span>eligible games</span>
            </div>
            <button className="shuffle-button sidebar-shuffle-button" onClick={onOpenVault} type="button">Open Vault</button>
          </section>
          <p className="shuffle-info"><span aria-hidden="true">i</span>Completed games are skipped automatically.</p>
        </div>
      ) : null}
    </aside>
  );
}

function SidebarTabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button aria-selected={active} className={`sidebar-tab ${active ? "active" : ""}`} onClick={onClick} role="tab" type="button">
      {label}
    </button>
  );
}

function CompactVaultLauncher({
  count,
  mode,
  onModeChange,
  onOpen
}: {
  count: number;
  mode: VaultMode;
  onModeChange: (mode: VaultMode) => void;
  onOpen: () => void;
}) {
  return (
    <section className="sidebar-shuffle canonical-vault-card">
      <div>
        <p className="detail-kicker">Vault Shuffle</p>
        <h2>Crack open the vault</h2>
        <p>Play something new from your current view.</p>
      </div>
      <img src="/assets/vault-door-compact.svg" alt="" />
      <div className="vault-mode-row" aria-label="Vault mode">
        <button className={mode === "draw" ? "active" : ""} onClick={() => onModeChange("draw")} type="button">Vault Draw</button>
        <button className={mode === "choose" ? "active" : ""} onClick={() => onModeChange("choose")} type="button">Let Me Choose</button>
      </div>
      <div className="sidebar-shuffle-meta">
        <strong>{count}</strong>
        <span>eligible games</span>
      </div>
      <button className="shuffle-button sidebar-shuffle-button" onClick={onOpen} type="button">Open Vault</button>
      <p className="shuffle-info"><span aria-hidden="true">i</span>Completed games stay locked away.</p>
    </section>
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
    { icon: "□", label: "Not Started", value: `${notStarted} (${Math.round((notStarted / total) * 100)}%)`, action: "not_started" },
    { icon: "◐", label: "Sampled", value: `${sampled} (${Math.round((sampled / total) * 100)}%)`, action: "sampled" },
    { icon: "▶", label: "In Progress", value: `${inProgress} (${Math.round((inProgress / total) * 100)}%)`, action: "progress" },
    { icon: "✓", label: "Completed", value: `${completed} (${Math.round((completed / total) * 100)}%)`, action: "completed" },
    { icon: "◇", label: "Genres", value: genreCount || "—", action: null },
    { icon: "◴", label: "Hours Played", value: Number(stats.hours).toLocaleString(), action: null },
    { icon: "◎", label: "Average Progress", value: `${stats.avg_completion}%`, action: null }
  ];
}
