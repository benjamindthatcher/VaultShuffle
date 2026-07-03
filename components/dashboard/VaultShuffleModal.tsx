"use client";

import type { Game } from "@/lib/types";
import { lengthBucket } from "@/lib/game-classification";
import { genreDisplayLabel } from "@/lib/genres";
import { HeroArtwork } from "@/components/dashboard/GameArtwork";

type VaultShuffleModalProps = {
  animationKey: number;
  cards: Game[];
  count: 1 | 2 | 3;
  eligibleCount: number;
  message: string;
  onClose: () => void;
  onCountChange: (count: 1 | 2 | 3) => void;
  onSelect: (game: Game) => void;
  onShuffle: () => void;
  spinning: boolean;
};

export function VaultShuffleModal({
  animationKey,
  cards,
  count,
  eligibleCount,
  message,
  onClose,
  onCountChange,
  onSelect,
  onShuffle,
  spinning
}: VaultShuffleModalProps) {
  const hasCards = cards.length > 0;
  const resultCount = hasCards ? cards.length : count;

  return (
    <div className="vault-backdrop" onMouseDown={onClose}>
      <section
        aria-label="Vault Shuffle"
        aria-modal="true"
        className={`vault-dialog count-${resultCount}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="vault-dialog-header">
          <div>
            <span className="detail-kicker">Vault Shuffle</span>
            <h2>Crack open the vault.</h2>
            <p>{eligibleCount ? `${eligibleCount} unfinished games are eligible from your current view.` : message}</p>
          </div>
          <button aria-label="Close Vault Shuffle" className="modal-close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div className="vault-body">
          <div className="vault-stage">
            <div className="vault-controls-over">
              <span className="vault-control-label">Draw size</span>
              <div className="vault-count-row" aria-label="Number of games to draw">
                {[1, 2, 3].map((option) => (
                  <button
                    className={count === option ? "active" : ""}
                    key={option}
                    onClick={() => onCountChange(option as 1 | 2 | 3)}
                    type="button"
                  >
                    {option}
                  </button>
                ))}
              </div>
              <button className="shuffle-button vault-primary" disabled={!eligibleCount || spinning} onClick={onShuffle} type="button">
                {spinning ? "Drawing..." : `Shuffle ${count}`}
              </button>
            </div>
            <VaultDoorGraphic hasCards={hasCards} spinning={spinning} />
            <p className="vault-stage-note">Completed games stay locked away automatically.</p>
          </div>
        </div>

        <div className={`vault-result-grid count-${resultCount} ${spinning ? "is-spinning" : ""}`} key={animationKey}>
          {hasCards ? (
            cards.map((game, index) => <VaultResultCard game={game} index={index} key={game.id} onSelect={onSelect} />)
          ) : (
            <div className="vault-empty">
              <strong>No draw yet.</strong>
              <span>{message}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function VaultDoorGraphic({ hasCards, spinning }: { hasCards: boolean; spinning: boolean }) {
  return (
    <div className={`vault-door ${spinning ? "is-spinning" : ""} ${hasCards ? "is-open" : ""}`}>
      <span className="vault-door-glow" />
      <span className="vault-door-slit" />
      <span className="vault-door-ring">
        <span />
        <span />
        <span />
      </span>
      <span className="vault-door-lock" />
    </div>
  );
}

function VaultResultCard({ game, index, onSelect }: { game: Game; index: number; onSelect: (game: Game) => void }) {
  const note = String(game.notes || "").trim();
  return (
    <button className={`vault-result-card delay-${index}`} onClick={() => onSelect(game)} type="button">
      <span className="vault-result-cover">
        <HeroArtwork game={game} />
      </span>
      <span className="vault-result-copy">
        <span>Pick {index + 1}</span>
        <strong>{game.title}</strong>
        <small>{genreDisplayLabel(game.genre, game.title)} · {lengthBucket(game)}</small>
        {note ? <em>{note}</em> : null}
      </span>
      <span className="vault-result-cta">View details</span>
    </button>
  );
}
