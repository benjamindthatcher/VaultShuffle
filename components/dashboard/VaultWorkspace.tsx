"use client";

import type { Game } from "@/lib/types";
import { lengthBucket } from "@/lib/game-classification";
import { genreDisplayLabel } from "@/lib/genres";
import { HeroArtwork } from "@/components/dashboard/GameArtwork";
import type { VaultMode } from "@/components/dashboard/VaultShuffleModal";

type VaultWorkspaceProps = {
  animationKey: number;
  cards: Game[];
  eligibleCount: number;
  filterLabel: string;
  message: string;
  mode: VaultMode;
  onModeChange: (mode: VaultMode) => void;
  onSelect: (game: Game) => void;
  onShuffle: () => void;
  spinning: boolean;
};

export function VaultWorkspace({
  animationKey,
  cards,
  eligibleCount,
  filterLabel,
  message,
  mode,
  onModeChange,
  onSelect,
  onShuffle,
  spinning
}: VaultWorkspaceProps) {
  const hasCards = cards.length > 0 && !spinning;
  const resultCount = mode === "draw" ? 1 : 3;

  return (
    <section className="vault-workspace-page">
      <header className="vault-page-hero">
        <div>
          <span className="detail-kicker">Vault Shuffle</span>
          <h1>Crack open the vault.</h1>
          <p>Draw from your eligible library games. Completed games stay locked away automatically.</p>
        </div>

        <div className="vault-page-meta">
          <strong>{eligibleCount}</strong>
          <span>eligible games</span>
          <small>{filterLabel}</small>
        </div>
      </header>

      <div className="vault-page-controls">
        <button className={mode === "draw" ? "active" : ""} onClick={() => onModeChange("draw")} type="button">
          <strong>Vault Draw</strong>
          <span>One decisive pick</span>
        </button>

        <button className={mode === "choose" ? "active" : ""} onClick={() => onModeChange("choose")} type="button">
          <strong>Let Me Choose</strong>
          <span>Three options</span>
        </button>

        <button className="shuffle-button vault-page-primary" disabled={!eligibleCount || spinning} onClick={onShuffle} type="button">
          {spinning ? "Opening..." : mode === "draw" ? "Vault Draw" : "Draw 3 Options"}
        </button>
      </div>

      <div className="vault-page-stage">
        <div className={`vault-page-door ${spinning ? "is-spinning" : ""} ${hasCards ? "is-open" : ""}`}>
          <img src="/assets/vault-door-hero.svg" alt="" />
        </div>

        <div className={`vault-page-results count-${hasCards ? cards.length : resultCount} ${spinning ? "is-spinning" : ""}`} key={animationKey}>
          {hasCards ? (
            cards.map((game, index) => (
              <button className={`vault-page-card delay-${index}`} key={game.id} onClick={() => onSelect(game)} type="button">
                <span className="vault-page-card-art">
                  <HeroArtwork game={game} />
                </span>

                <span className="vault-page-card-copy">
                  <span>{mode === "draw" ? "The pick" : `Pick ${index + 1}`}</span>
                  <strong>{game.title}</strong>
                  <small>{genreDisplayLabel(game.genre, game.title)} · {lengthBucket(game)}</small>
                </span>

                <span className="vault-page-card-cta">View details</span>
              </button>
            ))
          ) : (
            <div className="vault-page-empty">
              <strong>{spinning ? "The vault is opening..." : "Ready when you are."}</strong>
              <span>{spinning ? "Spinning the lock before the cards are drawn." : message}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
