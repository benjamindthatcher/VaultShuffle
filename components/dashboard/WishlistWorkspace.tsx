"use client";

import { cloneElement, isValidElement } from "react";
import type { CSSProperties, Dispatch, ReactElement, ReactNode, SetStateAction } from "react";
import type { SteamSearchResult, Game, GamePayload } from "@/lib/types";
import { displayGenres } from "@/lib/game-display";
import { lengthBucket } from "@/lib/game-classification";
import { Cover } from "@/components/dashboard/GameArtwork";

const PRIORITIES: GamePayload["priority"][] = ["Must Play", "High", "Medium", "Low"];

type FilterPopoverElementProps = {
  className?: string;
  style?: CSSProperties;
};

export function WishlistWorkspace({
  activeFilterCount,
  addQuery,
  filterControls,
  filtersOpen,
  isLoggedIn,
  onAddSteamGame,
  onCompleted,
  onDelete,
  onSearchSubmit,
  onSelectGame,
  onToggleMenu,
  onUpdateGame,
  rowMenuId,
  setAddQuery,
  setFiltersOpen,
  steamResults,
  wishlistGames
}: {
  activeFilterCount: number;
  addQuery: string;
  filterControls: ReactNode;
  filtersOpen: boolean;
  isLoggedIn: boolean;
  onAddSteamGame: (result: SteamSearchResult) => void;
  onCompleted: (game: Game) => void;
  onDelete: (game: Game) => void;
  onSearchSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onSelectGame: (game: Game) => void;
  onToggleMenu: (game: Game) => void;
  onUpdateGame: (game: Game, payload: Partial<GamePayload>) => void;
  rowMenuId: string | null;
  setAddQuery: (value: string) => void;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  steamResults: SteamSearchResult[];
  wishlistGames: Game[];
}) {
  const wishlistFilterControls = isValidElement(filterControls)
    ? cloneElement(filterControls as ReactElement<FilterPopoverElementProps>, {
        className: "filter-popover",
        style: {
          top: 0,
          left: 0,
          right: "auto",
          width: 384,
          maxWidth: "min(384px, calc(100vw - 48px))"
        }
      })
    : filterControls;

  return (
    <div className="wishlist-workspace wishlist-redesign">
      <section className="wishlist-add-block">
        <div className="add-steam-shell">
          <form className="wishlist-search" onSubmit={onSearchSubmit}>
            <span className="steam-search-badge" aria-hidden="true">◉</span>
            <label>
              <span>⌕</span>
              <input
                value={addQuery}
                onChange={(event) => setAddQuery(event.target.value)}
                type="search"
                placeholder="Search Steam to add a game..."
              />
            </label>
            <button className="shuffle-button" type="submit">Search</button>
          </form>

          <div className="steam-result-title">Search Results</div>

          <div className="steam-result-strip">
            {steamResults.length ? steamResults.slice(0, 4).map((result) => (
              <article className="steam-result-card" key={result.appid}>
                <span className="steam-result-art">{result.image ? <img src={result.image} alt="" /> : null}</span>

                <div className="steam-result-copy">
                  <strong>{result.name}</strong>
                  <div className="steam-result-tags">
                    {result.genre ? <small>{result.genre}</small> : <small>Steam</small>}
                    <small>Wishlist</small>
                  </div>
                </div>

                <button onClick={() => onAddSteamGame(result)} type="button">
                  ＋ Add
                </button>
              </article>
            )) : (
              <p className="steam-result-empty">
                {addQuery.trim().length >= 2 ? "No Steam games found yet." : "Type a game name above to search Steam."}
              </p>
            )}
          </div>

          <a className="steam-more-link" href="https://store.steampowered.com/search/" target="_blank" rel="noreferrer">
            View more results on Steam ↗
          </a>
        </div>
      </section>

      <section className="wishlist-list-block">
        <div className="wishlist-list-heading" style={{ position: "relative", overflow: "visible" }}>
          <div>
            <h2>Your Wishlist <span>({wishlistGames.length})</span></h2>
            <p>{isLoggedIn ? "Keep track of what you want to play next." : "Preview games you add from Steam appear here."}</p>
          </div>

          <div className="wishlist-table-actions">
            <button
              className={`filter-button ${filtersOpen ? "active" : ""}`}
              onClick={() => setFiltersOpen((open) => !open)}
              type="button"
            >
              Filters
              {activeFilterCount ? <span>{activeFilterCount}</span> : null}
            </button>

            <label>
              Sort by
              <select defaultValue="Priority" aria-label="Sort wishlist">
                <option>Priority</option>
                <option>Recently Added</option>
                <option>Estimated Length</option>
              </select>
            </label>
            <button type="button" aria-label="Grid view">▦</button>
          </div>

          {filtersOpen ? (
            <div
              className="filter-popover-wrap"
              style={{
                position: "absolute",
                right: 760,
                top: -218,
                zIndex: 80
              }}
            >
              {wishlistFilterControls}
            </div>
          ) : null}
        </div>

        <div className="wishlist-table">
          <div className="wishlist-head">
            <span>Game</span>
            <span>Genre</span>
            <span>Est. Length</span>
            <span>Priority</span>
            <span>Notes</span>
            <span className="actions-head">⋮</span>
          </div>

          {wishlistGames.length ? wishlistGames.map((game) => (
            <div
              className="wishlist-row"
              key={game.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectGame(game)}
              onKeyDown={(event) => {
                if (event.currentTarget !== event.target) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectGame(game);
                }
              }}
            >
              <span className="game-cell">
                <Cover game={game} />
                <strong>{game.title}</strong>
              </span>

              <span className="wishlist-genre-cell">
                {displayGenres(game)
                  .split("/")
                  .map((genre) => genre.trim())
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((genre) => <small key={genre}>{genre}</small>)}
              </span>

              <span>{lengthBucket(game)}</span>

              <span onClick={(event) => event.stopPropagation()}>
                <select
                  className={`priority-select priority-${String(game.priority).toLowerCase().replace(/\s+/g, "-")}`}
                  value={game.priority}
                  onChange={(event) => onUpdateGame(game, { priority: event.target.value as GamePayload["priority"] })}
                  aria-label={`${game.title} priority`}
                >
                  {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
                </select>
              </span>

              <span>{game.notes || "—"}</span>

              <span className="row-menu-cell">
                <button
                  aria-label={`Actions for ${game.title}`}
                  className="row-menu-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleMenu(game);
                  }}
                  type="button"
                >
                  ⋮
                </button>
                {rowMenuId === game.id ? (
                  <span className="row-menu" onClick={(event) => event.stopPropagation()}>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        onCompleted(game);
                      }}
                      type="button"
                    >
                      Completed
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(game);
                      }}
                      type="button"
                    >
                      Delete
                    </button>
                  </span>
                ) : null}
              </span>
            </div>
          )) : (
            <div className="workspace-empty">No wishlist games match the current filters.</div>
          )}
        </div>
      </section>
    </div>
  );
}
