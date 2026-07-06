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
    <div className="wishlist-workspace">
      <section className="workspace-panel add-steam-panel">
        <div className="workspace-heading">
          <div>
            <p className="detail-kicker">Wishlist</p>
            <h1>Add from Steam</h1>
            <p>Search Steam to discover and add games to your wishlist.</p>
          </div>
        </div>
        <form className="wishlist-search" onSubmit={onSearchSubmit}>
          <span>⌕</span>
          <input
            value={addQuery}
            onChange={(event) => setAddQuery(event.target.value)}
            type="search"
            placeholder="Search Steam to add a game..."
          />
          <button className="shuffle-button" type="submit">Search</button>
        </form>
        <div className="steam-result-strip">
          {steamResults.length ? steamResults.slice(0, 8).map((result) => (
            <button className="steam-result-card" key={result.appid} onClick={() => onAddSteamGame(result)} type="button">
              <span>{result.image ? <img src={result.image} alt="" /> : null}</span>
              <strong>{result.name}</strong>
              <small>+ Add</small>
            </button>
          )) : (
            <p>{addQuery.trim().length >= 2 ? "No Steam games found yet." : "Type a game name above to search Steam."}</p>
          )}
        </div>
      </section>

      <section className="workspace-panel">
        <div className="workspace-heading">
          <div>
            <h2>Your Wishlist <span>({wishlistGames.length})</span></h2>
            <p>{isLoggedIn ? "Keep track of what you want to play next." : "Preview games you add from Steam appear here."}</p>
          </div>
        </div>
        <div className="wishlist-table">
          <div className="wishlist-head">
            <span>Game</span>
            <span>Genre</span>
            <span>Length</span>
            <span>Priority</span>
            <span>Notes</span>
          </div>
          {wishlistGames.length ? wishlistGames.map((game) => (
            <button className="wishlist-row" key={game.id} onClick={() => onSelectGame(game)} type="button">
              <span className="game-cell"><Cover game={game} /><strong>{game.title}</strong></span>
              <span>{displayGenres(game)}</span>
              <span>{lengthBucket(game)}</span>
              <span onClick={(event) => event.stopPropagation()}>
                <select value={game.priority} onChange={(event) => onUpdateGame(game, { priority: event.target.value as GamePayload["priority"] })}>
                  {PRIORITIES.map((priority) => <option key={priority}>{priority}</option>)}
                </select>
              </span>
              <span>{game.notes || "—"}</span>
            </button>
          )) : (
            <div className="workspace-empty">No wishlist games yet. Add one from Steam above.</div>
          )}
        </div>
      </section>
    </div>
  );
}
