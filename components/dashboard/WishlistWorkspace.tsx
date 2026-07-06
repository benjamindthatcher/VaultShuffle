"use client";

import type { SteamSearchResult, Game, GamePayload } from "@/lib/types";
import { displayGenres } from "@/lib/game-display";
import { lengthBucket } from "@/lib/game-classification";
import { Cover } from "@/components/dashboard/GameArtwork";

const PRIORITIES: GamePayload["priority"][] = ["Must Play", "High", "Medium", "Low"];

export function WishlistWorkspace({
  addQuery,
  isLoggedIn,
  onAddSteamGame,
  onSearchSubmit,
  onSelectGame,
  onUpdateGame,
  setAddQuery,
  steamResults,
  wishlistGames
}: {
  addQuery: string;
  isLoggedIn: boolean;
  onAddSteamGame: (result: SteamSearchResult) => void;
  onSearchSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onSelectGame: (game: Game) => void;
  onUpdateGame: (game: Game, payload: Partial<GamePayload>) => void;
  setAddQuery: (value: string) => void;
  steamResults: SteamSearchResult[];
  wishlistGames: Game[];
}) {
  return (
    <div className="wishlist-workspace wishlist-redesign">
      <section className="wishlist-add-block">
        <div className="wishlist-page-heading">
          <h1>Add from Steam</h1>
          <p>Search Steam to discover and add games to your wishlist.</p>
        </div>

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
        <div className="wishlist-list-heading">
          <div>
            <h2>Your Wishlist <span>({wishlistGames.length})</span></h2>
            <p>{isLoggedIn ? "Keep track of what you want to play next." : "Preview games you add from Steam appear here."}</p>
          </div>

          <div className="wishlist-table-actions">
            <button type="button">⌁ Filters</button>
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
        </div>

        <div className="wishlist-table">
          <div className="wishlist-head">
            <span>Game</span>
            <span>Genre</span>
            <span>Est. Length</span>
            <span>Priority</span>
            <span>Notes</span>
            <span />
          </div>

          {wishlistGames.length ? wishlistGames.map((game) => (
            <button className="wishlist-row" key={game.id} onClick={() => onSelectGame(game)} type="button">
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

              <span className="wishlist-row-menu">⋮</span>
            </button>
          )) : (
            <div className="workspace-empty">No wishlist games yet. Add one from Steam above.</div>
          )}
        </div>
      </section>
    </div>
  );
}
