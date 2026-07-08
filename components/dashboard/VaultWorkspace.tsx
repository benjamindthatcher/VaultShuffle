"use client";

import { cloneElement, isValidElement } from "react";
import type { CSSProperties, Dispatch, ReactElement, ReactNode, SetStateAction } from "react";
import type { Game } from "@/lib/types";
import { displayStatus, lengthBucket } from "@/lib/game-classification";
import { genreDisplayLabel } from "@/lib/genres";
import { HeroArtwork } from "@/components/dashboard/GameArtwork";
import type { VaultMode } from "@/components/dashboard/VaultShuffleModal";

type FilterPopoverElementProps = {
  className?: string;
  style?: CSSProperties;
};

type VaultWorkspaceProps = {
  activeFilterCount: number;
  animationKey: number;
  cards: Game[];
  eligibleCount: number;
  filterControls: ReactNode;
  filterLabel: string;
  filtersOpen: boolean;
  message: string;
  mode: VaultMode;
  onModeChange: (mode: VaultMode) => void;
  onSelect: (game: Game) => void;
  onShuffle: () => void;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  spinning: boolean;
};

export function VaultWorkspace({
  activeFilterCount,
  animationKey,
  cards,
  eligibleCount,
  filterControls,
  filterLabel,
  filtersOpen,
  message,
  mode,
  onModeChange,
  onSelect,
  onShuffle,
  setFiltersOpen,
  spinning
}: VaultWorkspaceProps) {
  const hasCards = cards.length > 0 && !spinning;
  const primaryCard = hasCards ? cards[0] : null;
  const stageState = spinning ? "is-opening" : hasCards ? "is-open" : "is-closed";
  const resultCount = mode === "draw" ? 1 : 3;
  const vaultFilterControls = isValidElement(filterControls)
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

          <button
            className={filtersOpen ? "active" : ""}
            onClick={() => setFiltersOpen((open) => !open)}
            type="button"
          >
            <span aria-hidden="true">▽</span>
            <strong>Filters</strong>
            {activeFilterCount ? <em style={{ justifySelf: "end", fontStyle: "normal" }}>{activeFilterCount}</em> : null}
          </button>
        </div>

        {filtersOpen ? (
          <div
            className="filter-popover-wrap"
            style={{
              position: "absolute",
              left: "calc(100% - 18px)",
              top: 126,
              zIndex: 80
            }}
          >
            {vaultFilterControls}
          </div>
        ) : null}
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
          <button
            aria-expanded={filtersOpen}
            className="vault-filter-pill"
            onClick={() => setFiltersOpen((open) => !open)}
            type="button"
          >
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
              Let Me Choose
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
