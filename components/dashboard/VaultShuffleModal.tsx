"use client";

import type { Game } from "@/lib/types";
import { lengthBucket } from "@/lib/game-classification";
import { genreDisplayLabel } from "@/lib/genres";
import { HeroArtwork } from "@/components/dashboard/GameArtwork";

export type VaultMode = "draw" | "choose";

type VaultShuffleModalProps = {
  animationKey: number;
  cards: Game[];
  eligibleCount: number;
  filterLabel: string;
  message: string;
  mode: VaultMode;
  onClose: () => void;
  onModeChange: (mode: VaultMode) => void;
  onSelect: (game: Game) => void;
  onShuffle: () => void;
  spinning: boolean;
};

export function VaultShuffleModal({
  animationKey,
  cards,
  eligibleCount,
  filterLabel,
  message,
  mode,
  onClose,
  onModeChange,
  onSelect,
  onShuffle,
  spinning
}: VaultShuffleModalProps) {
  const hasCards = cards.length > 0 && !spinning;
  const resultCount = mode === "draw" ? 1 : 3;

  return (
    <div className="vault-backdrop" onMouseDown={onClose}>
      <section
        aria-label="Vault Shuffle"
        aria-modal="true"
        className={`vault-dialog vault-dialog-v2 mode-${mode} count-${hasCards ? cards.length : resultCount}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <button aria-label="Close Vault Shuffle" className="modal-close vault-close" onClick={onClose} type="button">
          ×
        </button>
        <header className="vault-dialog-header vault-centered-header">
          <span className="detail-kicker">Vault Shuffle</span>
          <h2>Crack open the vault.</h2>
          <p>
            <strong>{eligibleCount}</strong> unfinished games are eligible from your current view.
            <span>{filterLabel}</span>
          </p>
        </header>

        <div className="vault-body vault-body-v2">
          <div className="vault-stage vault-stage-v2">
            <div className="vault-controls-over vault-mode-controls">
              <button className={mode === "draw" ? "active" : ""} onClick={() => onModeChange("draw")} type="button">
                <strong>Vault Draw</strong>
                <span>One decisive pick</span>
              </button>
              <button className={mode === "choose" ? "active" : ""} onClick={() => onModeChange("choose")} type="button">
                <strong>Let Me Choose</strong>
                <span>Three options</span>
              </button>
              <button className="shuffle-button vault-primary" disabled={!eligibleCount || spinning} onClick={onShuffle} type="button">
                {spinning ? "Opening..." : mode === "draw" ? "Vault Draw" : "Draw 3 Options"}
              </button>
            </div>
            <VaultDoorGraphic open={hasCards} spinning={spinning} />
            <p className="vault-stage-note">Completed games stay locked away automatically.</p>
          </div>

          <div className={`vault-result-grid count-${hasCards ? cards.length : resultCount} ${spinning ? "is-spinning" : ""}`} key={animationKey}>
            {hasCards ? (
              cards.map((game, index) => <VaultResultCard game={game} index={index} key={game.id} mode={mode} onSelect={onSelect} />)
            ) : (
              <div className="vault-empty">
                <strong>{spinning ? "The vault is opening..." : "Ready when you are."}</strong>
                <span>{spinning ? "Spinning the lock before the cards are drawn." : message}</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function VaultDoorGraphic({ open, spinning }: { open: boolean; spinning: boolean }) {
  return (
    <div className={`vault-door ${spinning ? "is-spinning" : ""} ${open ? "is-open" : ""}`}>
      <img src="/assets/vault-door-hero.svg" alt="" />
      <span className="vault-door-glow" />
      <span className="vault-door-ring">
        <span />
        <span />
        <span />
      </span>
      <span className="vault-door-lock" />
    </div>
  );
}

function VaultResultCard({ game, index, mode, onSelect }: { game: Game; index: number; mode: VaultMode; onSelect: (game: Game) => void }) {
  const note = String(game.notes || "").trim();
  return (
    <button className={`vault-result-card delay-${index} ${mode === "draw" ? "hero-pick" : ""}`} onClick={() => onSelect(game)} type="button">
      <span className="vault-result-cover">
        <HeroArtwork game={game} />
      </span>
      <span className="vault-result-copy">
        <span>{mode === "draw" ? "The pick" : `Pick ${index + 1}`}</span>
        <strong>{game.title}</strong>
        <small>{genreDisplayLabel(game.genre, game.title)} · {lengthBucket(game)}</small>
        {note ? <em>{note}</em> : null}
      </span>
      <span className="vault-result-cta">View details</span>
    </button>
  );
}
