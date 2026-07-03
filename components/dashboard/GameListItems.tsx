"use client";

import { displayStatus, gameProgress, lengthBucket } from "@/lib/game-classification";
import { displayGenres, primaryGenre, statusClass, statusIcon } from "@/lib/game-display";
import type { Game } from "@/lib/types";
import { Cover } from "@/components/dashboard/GameArtwork";

export function GameRow({
  game,
  selected,
  menuOpen,
  onSelect,
  onToggleMenu,
  onCompleted,
  onDelete
}: {
  game: Game;
  selected: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onCompleted: () => void;
  onDelete: () => void;
}) {
  const progress = gameProgress(game);
  const status = displayStatus(game);
  return (
    <div
      className={`game-row ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="game-cell">
        <Cover game={game} />
        <span className="game-title">
          <strong>{game.title}</strong>
          <small>{displayGenres(game)}</small>
        </span>
      </span>
      <span>{Number(game.hours_played).toLocaleString()}h</span>
      <span className="progress-cell">
        <span className={`progress-track ${progress <= 0 ? "is-empty" : ""}`} aria-label={`${progress}% progress`}>
          {progress > 0 ? <span className={`progress-fill ${statusClass(game)}`} style={{ width: `${progress}%` }} /> : null}
        </span>
      </span>
      <span className={`chip ${statusClass(game)}`}>{statusIcon(game)} {status}</span>
      <span className="pill genre-pill">{primaryGenre(game)}</span>
      <span className="pill">{lengthBucket(game)}</span>
      <span>{Number(game.rating) > 0 ? `${game.rating}/10` : game.steam_appid ? "Updating" : "—"}</span>
      <span className="row-menu-cell">
        <button
          aria-label={`Actions for ${game.title}`}
          className="row-menu-button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleMenu();
          }}
          type="button"
        >
          ⋮
        </button>
        {menuOpen ? (
          <span className="row-menu" onClick={(event) => event.stopPropagation()}>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onCompleted();
              }}
              type="button"
            >
              Completed
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              type="button"
            >
              Delete
            </button>
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function GameCard({ game, selected, onSelect }: { game: Game; selected: boolean; onSelect: () => void }) {
  const progress = gameProgress(game);
  const status = displayStatus(game);
  return (
    <button className={`game-card ${selected ? "selected" : ""}`} onClick={onSelect} type="button">
      <span className="game-card-art"><Cover game={game} /></span>
      <span className="game-card-body">
        <strong>{game.title}</strong>
        <small>{displayGenres(game)} · {Number(game.hours_played || 0).toLocaleString()}h</small>
        <span className="game-card-meta">
          <span className={`progress-track ${progress <= 0 ? "is-empty" : ""}`}>
            <span className={`progress-fill ${statusClass(game)}`} style={{ width: `${progress}%` }} />
          </span>
          <span className={`chip ${statusClass(game)}`}>{status}</span>
        </span>
      </span>
    </button>
  );
}

export function GuestLibraryState({ loggedIn, onAdd, onSignIn }: { loggedIn: boolean; onAdd: () => void; onSignIn: () => void }) {
  return (
    <div className="guest-empty">
      <div className="guest-empty-art">
        <span />
        <span />
        <span />
      </div>
      <p className="detail-kicker">{loggedIn ? "Nothing matches those filters" : "Preview mode"}</p>
      <h3>{loggedIn ? "No games found." : "Your library will appear here."}</h3>
      <p>
        {loggedIn
          ? "Try clearing a filter or importing your Steam library again."
          : "You can explore the app layout for now. Sign in with Steam when you want Vault Shuffle to import your games and playtime."}
      </p>
      {!loggedIn ? (
        <div className="guest-empty-actions">
          <button className="shuffle-button" onClick={onAdd}>Add a demo game</button>
          <button className="ghost" onClick={onSignIn}>Sign in with Steam</button>
        </div>
      ) : null}
    </div>
  );
}
