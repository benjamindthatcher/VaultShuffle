"use client";

import type { Game } from "@/lib/types";
import { displayStatus, lengthBucket } from "@/lib/game-classification";
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
  const primaryCard = hasCards ? cards[0] : null;
  const stageState = spinning ? "is-opening" : hasCards ? "is-open" : "is-closed";
  const resultCount = mode === "draw" ? 1 : 3;

  return (
    <section className={`vault-cinematic-page ${stageState} mode-${mode} result-count-${hasCards ? cards.length : resultCount}`}>
      <aside className="vault-cinematic-sidebar">
        <div className="vault-cinematic-sidebar-copy">
          <span className="detail-kicker">Vault</span>
          <h2>
            Crack the <strong>Vault</strong>
          </h2>
          <p>One game. Yours to play.</p>
        </div>

        <div className="vault-cinematic-mini-door" aria-hidden="true" />

        <div className="vault-cinematic-eligible">
          <strong>{eligibleCount}</strong>
          <span>Eligible Games</span>
          <small title={filterLabel}>ⓘ</small>
        </div>

        <div className="vault-cinematic-mode-stack" aria-label="Vault draw mode">
          <button
            className={mode === "draw" ? "active" : ""}
            onClick={() => onModeChange("draw")}
            type="button"
          >
            <span aria-hidden="true">⌘</span>
            <strong>Vault Draw</strong>
          </button>

          <button
            className={mode === "choose" ? "active" : ""}
            onClick={() => onModeChange("choose")}
            type="button"
          >
            <span aria-hidden="true">☷</span>
            <strong>Let Me Choose</strong>
          </button>
        </div>

        <div className="vault-cinematic-filter-strip">
          <span aria-hidden="true">▽</span>
          <p>{filterLabel}</p>
          <b>View</b>
        </div>
      </aside>

      <main className="vault-cinematic-stage" aria-label="Vault Shuffle">
          <div className="vault-cinematic-bg" aria-hidden="true">
          <div className="vault-frame vault-frame-closed" />
          <div className="vault-frame vault-frame-open" />
          <div className="vault-matte" />
          <div className="vault-vignette" />
          <div className="vault-fx">
            <span className="vault-sweep" />
            <span className="vault-flash" />
            <span className="vault-beam" />
            <span className="vault-bloom" />
            <span className="vault-floor-glow" />
            <span className="vault-spotlight" />
          </div>
        </div>

        <header className="vault-cinematic-header">
          <button className="vault-filter-pill" type="button">
            <span aria-hidden="true">▽</span>
            {filterLabel === "Filter: all games" ? "All games eligible" : "Filters active"}
          </button>

          <h1>
            Crack Open <span>the Vault</span>
          </h1>
          <p>{mode === "draw" ? "One game. Yours to play." : "Three options. You choose."}</p>
          <i aria-hidden="true" />
        </header>

        <div className="vault-result-layer" key={animationKey}>
          {hasCards ? (
            <div className={`vault-result-set count-${cards.length}`}>
              {cards.map((game, index) => (
                <VaultResultCard
                  game={game}
                  index={index}
                  key={game.id}
                  mode={mode}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ) : (
            <div className="vault-ready-copy">
              <strong>{spinning ? "The vault is opening..." : "Ready when you are."}</strong>
              <span>{spinning ? "Spinning the lock before the card is drawn." : message}</span>
            </div>
          )}
        </div>

        <div className="vault-cinematic-actions">
          <button className="vault-primary-action" disabled={!eligibleCount || spinning} onClick={onShuffle} type="button">
            {spinning ? "Opening..." : mode === "draw" ? "Vault Draw" : "Draw 3 Options"}
          </button>

          {primaryCard && mode === "draw" ? (
            <button className="vault-secondary-action" onClick={() => onModeChange("choose")} type="button">
              Show 3 more options
            </button>
          ) : null}
        </div>
      </main>
    </section>
  );
}

function VaultResultCard({
  game,
  index,
  mode,
  onSelect
}: {
  game: Game;
  index: number;
  mode: VaultMode;
  onSelect: (game: Game) => void;
}) {
  const rating = Number(game.rating || 0);
  const status = displayStatus(game);
  const length = lengthBucket(game);

  return (
    <button
      className={`vault-cinematic-card delay-${index} ${mode === "draw" ? "hero-pick" : ""}`}
      onClick={() => onSelect(game)}
      type="button"
    >
      <span className="vault-card-cover">
        <HeroArtwork game={game} />
        {rating > 0 ? (
          <span className="vault-card-rating">
            <span aria-hidden="true">★</span>
            {rating}/10
          </span>
        ) : null}
      </span>

      <span className="vault-card-body">
        <strong>{game.title}</strong>
        <small>{genreDisplayLabel(game.genre, game.title)} / {game.store || "Steam"}</small>

        <span className="vault-card-pills">
          <em>{status}</em>
          <em>{length}</em>
          {rating > 0 ? <em>★ {rating}/10</em> : null}
        </span>
      </span>
    </button>
  );
}

