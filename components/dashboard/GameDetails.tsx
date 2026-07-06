"use client";

import type { ReactNode } from "react";
import { displayStatus, gameProgress, lengthBucket } from "@/lib/game-classification";
import { displayGenres, formatLastPlayed, statusClass, statusIcon } from "@/lib/game-display";
import type { Game, GamePayload } from "@/lib/types";
import { HeroArtwork } from "@/components/dashboard/GameArtwork";

export function GameDetails({
  game,
  onOpenNotes,
  onPlay
}: {
  game: Game | null;
  onOpenNotes: () => void;
  onPlay: () => void;
  onUpdate: (payload: Partial<GamePayload>) => Promise<void>;
}) {
  if (!game) {
    return <div className="detail-content empty">Select a game from the library.</div>;
  }

  const progress = gameProgress(game);
  const status = displayStatus(game);
  const note = String(game.notes || "").trim();
  const ratingText = Number(game.rating) > 0 ? `${game.rating}/10` : game.steam_appid ? "Updating..." : "Unavailable";

  return (
    <div className="detail-content">
      <div className="hero-cover">
        <HeroArtwork game={game} />
      </div>

      <div className="detail-title">{game.title}</div>

      <div className="detail-pills">
        {displayGenres(game)
          .split("/")
          .map((genre) => genre.trim())
          .filter(Boolean)
          .slice(0, 2)
          .map((genre) => (
            <span className="detail-pill" key={genre}>
              {genre}
            </span>
          ))}

        <span className="detail-pill steam-pill">Steam</span>
      </div>

      <div className="detail-progress">
        <div>
          <span>Progress</span>
          <strong>{progress}%</strong>
        </div>

        <span className={`progress-track ${progress <= 0 ? "is-empty" : ""}`}>
          {progress > 0 ? <span className={`progress-fill ${statusClass(game)}`} style={{ width: `${progress}%` }} /> : null}
        </span>
      </div>

      <div className="detail-list">
        <DetailLine icon="◷" label="Playtime" value={`${Number(game.hours_played).toLocaleString()}h`} />
        <DetailLine icon="◇" label="Length" value={lengthBucket(game)} />
        <DetailLine icon="◴" label="Last played" value={formatLastPlayed(game.last_played_at)} />
        <DetailLine icon="☆" label="Steam rating" value={ratingText} />
        <DetailLine icon="▣" label="Library" value={game.ownership === "Owned" ? "Steam library" : "Wishlist"} />
        <DetailLine
          icon="↗"
          label="Store"
          value={
            game.steam_appid ? (
              <a href={`https://store.steampowered.com/app/${game.steam_appid}/`} target="_blank" rel="noreferrer">
                Open on Steam
              </a>
            ) : (
              game.store
            )
          }
        />
      </div>

      <section className={`notes-preview ${note ? "" : "is-empty"}`}>
        <div>
          <strong>Notes</strong>
          <p>{note || "Interesting pick from your library. Add notes for why it belongs in the backlog."}</p>
        </div>

        <button onClick={onOpenNotes} type="button">
          View all notes →
        </button>
      </section>

      <div className="detail-status-line">
        <span className={`chip ${statusClass(game)}`}>
          {statusIcon(game)} {status}
        </span>
      </div>

      <button className="play-now-button" disabled={!game.steam_appid} onClick={onPlay} type="button">
        ▷ Play Now
      </button>
    </div>
  );
}

function DetailLine({ icon, label, value }: { icon: string; label: string; value: ReactNode }) {
  return (
    <div className="detail-line">
      <span>
        <i aria-hidden="true">{icon}</i>
        {label}
      </span>

      <strong>{value}</strong>
    </div>
  );
}
