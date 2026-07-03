"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  displayStatus,
  gameProgress,
  inferredProgressFromHours,
  lengthBucket,
  statusFromCompletion
} from "@/lib/game-classification";
import { displayGenres, formatLastPlayed, statusClass, statusIcon } from "@/lib/game-display";
import type { Game, GamePayload } from "@/lib/types";
import { HeroArtwork } from "@/components/dashboard/GameArtwork";

export function GameDetails({
  game,
  onOpenNotes,
  onPlay,
  onUpdate
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
      <div className="hero-cover"><HeroArtwork game={game} /></div>
      <p className="detail-kicker">Selected game</p>
      <div className="detail-title">{game.title}</div>
      <div className="detail-subtitle">{displayGenres(game)} · {game.store || "Steam"}</div>
      <div className="detail-pills">
        <span className="detail-pill"><i>{statusIcon(game)}</i>{status}</span>
        <span className="detail-pill"><i>◴</i>{lengthBucket(game)}</span>
        <span className="detail-pill"><i>★</i>{ratingText}</span>
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
        <DetailLine label="Playtime" value={`${Number(game.hours_played).toLocaleString()}h`} />
        <DetailLine label="Length" value={lengthBucket(game)} />
        <DetailLine label="Last played" value={formatLastPlayed(game.last_played_at)} />
        <DetailLine label="Steam rating" value={ratingText} />
        <DetailLine label="Library" value={game.ownership === "Owned" ? "Steam library" : "Wishlist"} />
        <DetailLine
          label="Store"
          value={game.steam_appid ? <a href={`https://store.steampowered.com/app/${game.steam_appid}/`} target="_blank" rel="noreferrer">Open on Steam</a> : game.store}
        />
      </div>
      <InlineGameSettings game={game} onUpdate={onUpdate} />
      <section className={`notes-preview ${note ? "" : "is-empty"}`}>
        <div>
          <strong>Notes</strong>
          <p>{note || "No notes yet. Add why it is next, stuck, or worth saving for later."}</p>
        </div>
        <button onClick={onOpenNotes} type="button">View</button>
      </section>
      <button className="play-now-button" disabled={!game.steam_appid} onClick={onPlay} type="button">Play Now</button>
    </div>
  );
}

function InlineGameSettings({ game, onUpdate }: { game: Game; onUpdate: (payload: Partial<GamePayload>) => Promise<void> }) {
  const displayedProgress = gameProgress(game);
  const [hoursDraft, setHoursDraft] = useState(numberField(game.hours_played));
  const [completionDraft, setCompletionDraft] = useState(numberField(game.completion_percentage || displayedProgress));

  useEffect(() => {
    setHoursDraft(numberField(game.hours_played));
    setCompletionDraft(numberField(game.completion_percentage || displayedProgress));
  }, [game.id, game.hours_played, game.completion_percentage, displayedProgress]);

  function commitHours() {
    const hours = parseNumberInput(hoursDraft);
    const currentStoredCompletion = Number(game.completion_percentage || 0);
    const currentInferredCompletion = inferredProgressFromHours(game, Number(game.hours_played || 0));
    const hasManualCompletion = currentStoredCompletion > 0 && currentStoredCompletion !== currentInferredCompletion;
    const next: Partial<GamePayload> = { hours_played: hours };
    if (!hasManualCompletion) {
      const completion = inferredProgressFromHours(game, hours);
      next.completion_percentage = completion;
      next.status = statusFromCompletion(completion);
    }
    void onUpdate(next);
  }

  function commitCompletion() {
    const completion = parseNumberInput(completionDraft, 100);
    void onUpdate({
      completion_percentage: completion,
      status: statusFromCompletion(completion)
    });
  }

  return (
    <section className="inline-settings" aria-label="Your game settings">
      <h3>Your settings</h3>
      <div className="inline-settings-grid">
        <label>
          Hours
          <input
            inputMode="decimal"
            onBlur={commitHours}
            onChange={(event) => setHoursDraft(event.target.value)}
            placeholder="0"
            value={hoursDraft}
          />
        </label>
        <label>
          Completion
          <input
            inputMode="decimal"
            onBlur={commitCompletion}
            onChange={(event) => setCompletionDraft(event.target.value)}
            placeholder="0-100"
            value={completionDraft}
          />
        </label>
        <label>
          Library
          <select value={game.ownership} onChange={(event) => void onUpdate({ ownership: event.target.value as GamePayload["ownership"] })}>
            <option>Owned</option>
            <option>Wishlist</option>
          </select>
        </label>
      </div>
    </section>
  );
}

function DetailLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function numberField(value: number | null | undefined) {
  const numeric = Number(value || 0);
  return numeric === 0 ? "" : String(numeric);
}

function parseNumberInput(value: string, max?: number) {
  const cleaned = value.replace(/[^\d.]/g, "");
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return typeof max === "number" ? Math.min(parsed, max) : parsed;
}
