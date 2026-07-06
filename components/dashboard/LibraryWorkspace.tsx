"use client";

import type { Dispatch, SetStateAction } from "react";
import { LENGTH_HELP_TEXT } from "@/lib/game-classification";
import type { Game } from "@/lib/types";
import { GameCard, GameRow, GuestLibraryState } from "@/components/dashboard/GameListItems";

type SortOption = { value: string; label: string };

export function LibraryWorkspace({
  activeFilterCount,
  filterControls,
  filteredGames,
  filtersOpen,
  isLoggedIn,
  onAdd,
  onCompleted,
  onDelete,
  onSelect,
  onSignIn,
  onToggleMenu,
  query,
  rowMenuId,
  selectedId,
  setFiltersOpen,
  setQuery,
  setSort,
  setViewMode,
  sort,
  sortOptions,
  toggleSort,
  viewMode
}: {
  activeFilterCount: number;
  filterControls: React.ReactNode;
  filteredGames: Game[];
  filtersOpen: boolean;
  isLoggedIn: boolean;
  onAdd: () => void;
  onCompleted: (game: Game) => void;
  onDelete: (game: Game) => void;
  onSelect: (game: Game) => void;
  onSignIn: () => void;
  onToggleMenu: (game: Game) => void;
  query: string;
  rowMenuId: string | null;
  selectedId: string | null;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setQuery: (value: string) => void;
  setSort: (value: string) => void;
  setViewMode: (mode: "list" | "grid") => void;
  sort: string;
  sortOptions: SortOption[];
  toggleSort: (descSort: string, ascSort: string) => void;
  viewMode: "list" | "grid";
}) {
  return (
    <section className={`library-table library-workspace ${viewMode === "grid" ? "grid-mode" : ""}`}>
      <div className="table-toolbar">
        <strong>All Games <span>({filteredGames.length} {filteredGames.length === 1 ? "game" : "games"})</span></strong>
        <div className="toolbar-controls">
          <label className="table-filter-search">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Filter library..." />
          </label>
          <div className="filter-popover-wrap">
            <button className={`filter-button ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen((open) => !open)} type="button">
              Filters
              {activeFilterCount ? <span>{activeFilterCount}</span> : null}
            </button>
            {filtersOpen ? filterControls : null}
          </div>
          <label>Sort by</label>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button className={`view-button ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")} type="button" aria-label="List view">☷</button>
          <button className={`view-button ${viewMode === "grid" ? "active" : ""}`} onClick={() => setViewMode("grid")} type="button" aria-label="Cover view">▦</button>
        </div>
      </div>

      <div className={`table-head ${viewMode === "grid" ? "hidden" : ""}`}>
        <button onClick={() => toggleSort("title_asc", "title_desc")} type="button">Game</button>
        <button onClick={() => toggleSort("hours_desc", "hours_asc")} type="button">Playtime</button>
        <button onClick={() => toggleSort("progress_desc", "progress_asc")} type="button">Progress</button>
        <span className="table-label">Status</span>
        <span className="table-label">Genre</span>
        <span className="table-label label-with-help">
          Length
          <button className="length-help" type="button" aria-label={LENGTH_HELP_TEXT} aria-describedby="length-tooltip">
            i
            <span className="length-tooltip" id="length-tooltip" role="tooltip">
              <strong>Length guide</strong>
              <span>Bitesize: under 5h</span>
              <span>Short: 5-10h</span>
              <span>Weekend: 10-20h</span>
              <span>Campaign: 20-40h</span>
              <span>Meaty: 40-80h</span>
              <span>Marathon: 80-120h</span>
              <span>Odyssey: 120h+</span>
              <span>Endless: replayable/live-service/sandbox</span>
            </span>
          </button>
        </span>
        <button onClick={() => toggleSort("rating_desc", "rating_asc")} type="button">Rating</button>
        <span className="actions-head">⋮</span>
      </div>
      <div className={`table-body ${viewMode === "grid" ? "grid-view" : ""}`}>
        {filteredGames.length ? (
          filteredGames.map((game) =>
            viewMode === "grid" ? (
              <GameCard game={game} key={game.id} selected={game.id === selectedId} onSelect={() => onSelect(game)} />
            ) : (
              <GameRow
                game={game}
                key={game.id}
                menuOpen={rowMenuId === game.id}
                selected={game.id === selectedId}
                onCompleted={() => onCompleted(game)}
                onDelete={() => onDelete(game)}
                onSelect={() => onSelect(game)}
                onToggleMenu={() => onToggleMenu(game)}
              />
            )
          )
        ) : (
          <GuestLibraryState loggedIn={isLoggedIn} onAdd={onAdd} onSignIn={onSignIn} />
        )}
      </div>
    </section>
  );
}
